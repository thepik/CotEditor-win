/**
 * Persistent user settings (PLAN phase C) - schema, validation, storage and
 * Monaco option application.
 *
 * This module is deliberately standalone: it does not import the app's UI,
 * i18n, theme loader or state libraries, so it can be imported by a settings
 * panel, a headless regression, or the bootstrap without pulling in chrome.
 * The only Monaco reference is a type-only import (erased at build time).
 *
 * Storage contract: one JSON object under `coteditor.settings.v1`. A missing,
 * corrupt, non-object or partially-invalid payload is repaired field by field:
 * valid fields survive, invalid/out-of-range fields fall back to their default.
 *
 * `applyEditorSettings` only calls the public `editor.updateOptions`. Theme is
 * not an editor option, so applying `settings.theme` is the caller's job (see
 * `setMonacoTheme` in editor/monaco-setup). The `language` field likewise needs
 * an explicit `setLang` call from the wiring layer.
 */

import type * as monaco from "monaco-editor/esm/vs/editor/edcore.main.js";

export type SettingsLanguage = "zh" | "en";
export type SettingsWordWrap = "on" | "off";
export type SettingsRenderWhitespace = "none" | "selection" | "all";

/** The complete, normalized settings object persisted by this module. */
export interface Settings {
  /** Theme name from the theme loader; absent means "use the preferred theme". */
  theme?: string;
  language: SettingsLanguage;
  autoSave: boolean;
  autoSaveDelayMs: number;
  fontSize: number;
  fontFamily: string;
  lineNumbers: boolean;
  /** Defaults to "on", matching CotEditor's plain-text/Markdown behaviour. */
  wordWrap: SettingsWordWrap;
  renderWhitespace: SettingsRenderWhitespace;
  tabSize: number;
  insertSpaces: boolean;
  showOutline: boolean;
  /** Outline pane width in CSS pixels; only meaningful when showOutline is true. */
  outlineWidth?: number;
}

export type SettingsPatch = Partial<Settings>;

export const SETTINGS_STORAGE_KEY = "coteditor.settings.v1";

export const DEFAULT_FONT_FAMILY =
  '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace';

/** Inclusive bounds shared by validation, the settings UI and tests. */
export const SETTINGS_LIMITS = {
  autoSaveDelayMs: { min: 1000, max: 60000 },
  fontSize: { min: 9, max: 32 },
  tabSize: { min: 1, max: 8 },
  outlineWidth: { min: 160, max: 800 },
} as const;

const DEFAULT_SETTINGS: Settings = {
  theme: undefined,
  language: "zh",
  autoSave: false,
  autoSaveDelayMs: 5000,
  fontSize: 14,
  fontFamily: DEFAULT_FONT_FAMILY,
  lineNumbers: true,
  wordWrap: "on",
  renderWhitespace: "selection",
  tabSize: 4,
  insertSpaces: true,
  showOutline: false,
  outlineWidth: undefined,
};

type SettingsListener = (settings: Settings) => void;

const listeners = new Set<SettingsListener>();

/** Fresh copy of the defaults; callers may mutate it freely. */
export function getDefaultSettings(): Settings {
  return { ...DEFAULT_SETTINGS };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function readNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

function readOptionalString(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

/**
 * Validate an arbitrary value against the schema.
 *
 * Valid fields are kept; anything else is replaced by its default. Never
 * throws, so it is safe to feed it the result of `JSON.parse` or a partial
 * object from a form.
 */
export function normalizeSettings(value: unknown): Settings {
  const source = isRecord(value) ? value : {};
  const defaults = DEFAULT_SETTINGS;

  const language: SettingsLanguage =
    source.language === "zh" || source.language === "en"
      ? source.language
      : defaults.language;

  const wordWrap: SettingsWordWrap =
    source.wordWrap === "on" || source.wordWrap === "off"
      ? source.wordWrap
      : defaults.wordWrap;

  const renderWhitespace: SettingsRenderWhitespace =
    source.renderWhitespace === "none" ||
    source.renderWhitespace === "selection" ||
    source.renderWhitespace === "all"
      ? source.renderWhitespace
      : defaults.renderWhitespace;

  const fontFamily =
    readOptionalString(source.fontFamily, 512) ?? defaults.fontFamily;

  const settings: Settings = {
    language,
    autoSave: readBoolean(source.autoSave, defaults.autoSave),
    autoSaveDelayMs: readInteger(
      source.autoSaveDelayMs,
      SETTINGS_LIMITS.autoSaveDelayMs.min,
      SETTINGS_LIMITS.autoSaveDelayMs.max,
      defaults.autoSaveDelayMs,
    ),
    fontSize: readNumber(
      source.fontSize,
      SETTINGS_LIMITS.fontSize.min,
      SETTINGS_LIMITS.fontSize.max,
      defaults.fontSize,
    ),
    fontFamily,
    lineNumbers: readBoolean(source.lineNumbers, defaults.lineNumbers),
    wordWrap,
    renderWhitespace,
    tabSize: readInteger(
      source.tabSize,
      SETTINGS_LIMITS.tabSize.min,
      SETTINGS_LIMITS.tabSize.max,
      defaults.tabSize,
    ),
    insertSpaces: readBoolean(source.insertSpaces, defaults.insertSpaces),
    showOutline: readBoolean(source.showOutline, defaults.showOutline),
  };

  const theme = readOptionalString(source.theme, 200);
  if (theme !== undefined) settings.theme = theme;

  const outlineWidth = source.outlineWidth;
  if (
    typeof outlineWidth === "number" &&
    Number.isInteger(outlineWidth) &&
    outlineWidth >= SETTINGS_LIMITS.outlineWidth.min &&
    outlineWidth <= SETTINGS_LIMITS.outlineWidth.max
  ) {
    settings.outlineWidth = outlineWidth;
  }

  return settings;
}

function readRawStorage(): unknown {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    // Corrupt JSON or unavailable storage: both degrade to defaults.
    return null;
  }
}

/** Read and validate the persisted settings. Never throws. */
export function loadSettings(): Settings {
  return normalizeSettings(readRawStorage());
}

function persist(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be full/unavailable; the in-memory return value is still
    // valid for this call. Settings are best-effort across sessions.
  }
}

/**
 * Merge a partial patch into the stored settings, validate the result, persist
 * it and notify subscribers (only when the effective settings changed).
 *
 * Returning the normalized object lets a settings form echo clamped/fallback
 * values immediately. Invalid fields in the patch fall back to their defaults,
 * matching the load-path policy.
 */
export function saveSettings(partial: SettingsPatch): Settings {
  const previous = loadSettings();
  const patch = isRecord(partial) ? partial : {};
  const next = normalizeSettings({ ...previous, ...patch });
  persist(next);
  if (JSON.stringify(previous) !== JSON.stringify(next)) {
    for (const listener of [...listeners]) {
      try {
        listener({ ...next });
      } catch (error) {
        console.error("settings listener failed:", error);
      }
    }
  }
  return { ...next };
}

/**
 * Subscribe to effective settings changes. Returns an unsubscribe function.
 * Listeners receive a copy, so mutating it cannot corrupt shared state.
 */
export function subscribeSettings(listener: SettingsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Apply the editor-affecting subset to a live Monaco editor.
 *
 * Uses only the public `updateOptions` API. It intentionally does not touch
 * the theme (`settings.theme`) or the UI language (`settings.language`); both
 * live outside Monaco's editor options. Auto-save and outline values are also
 * consumed by their owning modules, not here.
 */
export function applyEditorSettings(
  editor: monaco.editor.IStandaloneCodeEditor,
  settings: Settings,
): void {
  const normalized = normalizeSettings(settings);
  editor.updateOptions({
    fontFamily: normalized.fontFamily,
    fontSize: normalized.fontSize,
    lineNumbers: normalized.lineNumbers ? "on" : "off",
    wordWrap: normalized.wordWrap,
    renderWhitespace: normalized.renderWhitespace,
    tabSize: normalized.tabSize,
    insertSpaces: normalized.insertSpaces,
  });
}
