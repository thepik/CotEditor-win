/**
 * `.cottheme` parser -> Monaco `IStandaloneThemeData`.
 *
 * A `.cottheme` file is a JSON object. Each top-level key (except `metadata`)
 * names a syntax scope and maps to either a string hex colour or an object
 * `{ "color": "#RRGGBB[AA]", "usesSystemSetting"?: boolean }`. The 15 scope
 * keys are defined in PLAN §四 and match the theme schema documented in
 * `src/resources/`.
 *
 * This module:
 *  - loads every `.cottheme` under `src/resources/themes/`
 *  - parses hex colours (6 or 8 digit, with optional alpha)
 *  - builds the Monaco `rules` + `colors` for each, and defines it
 *  - tracks the active theme so highlighting engines can re-tint on switch.
 */

import { defineMonacoTheme, setMonacoTheme } from "./monaco-setup";
import type * as monaco from "monaco-editor";

/** The 15 scope keys a .cottheme may define, mapped to a CSS colour string. */
export interface CotTheme {
  metadata?: ThemeMetadata;
  [scope: string]: ThemeScopeEntry | ThemeMetadata | undefined;
}

interface ThemeMetadata {
  author?: string;
  description?: string;
  distributionURL?: string;
  license?: string;
  name?: string;
}

/** A scope entry is either a bare hex string or an object with a colour. */
type ThemeScopeEntry = string | { color?: string; usesSystemSetting?: boolean };

/** Map of theme file basename (without extension) -> internal name. */
const themeRegistry = new Map<string, CotTheme>();
let currentTheme: string | null = null;

/**
 * Mapping from CotEditor scope names -> Monaco token CSS scope names.
 *
 * tree-sitter captures and regex rule scopes use the CotEditor names (e.g.
 * `@keywords`), so highlight engines emit tokens whose `type` is one of these
 * left-hand names. Monaco then looks up the colour in the theme's `rules`.
 */
const SCOPE_TO_MONACO_TOKEN: Record<string, string> = {
  text: "",
  background: "",
  keywords: "keyword",
  commands: "keyword",
  types: "type",
  attributes: "attribute",
  variables: "variable",
  values: "literal",
  numbers: "number",
  strings: "string",
  characters: "string",
  comments: "comment",
  invisibles: "",
  lineHighlight: "",
  selection: "",
  highlight: "",
  insertionPoint: "",
};

/** Parse a hex colour string (`#RRGGBB` or `#RRGGBBAA`) into an `#rrggbb`/`#rrggbbaa` value Monaco accepts. */
export function parseHexColor(hex: string): string | null {
  const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex.trim());
  if (!m) return null;
  const rgb = m[1].toLowerCase();
  const alpha = m[2]?.toLowerCase();
  return alpha ? `#${rgb}${alpha}` : `#${rgb}`;
}

function scopeColor(theme: CotTheme, scope: string): string | null {
  const v = theme[scope];
  if (v == null) return null;
  if (typeof v === "string") return parseHexColor(v);
  // Distinguish the colour object from a ThemeMetadata object by the presence
  // of a `color` field; metadata objects never carry `color`.
  if (typeof v === "object" && "color" in v && typeof v.color === "string")
    return parseHexColor(v.color);
  return null;
}

/**
 * The 13 theme names vendored from CotEditor (file basename without extension).
 * Hard-coded because the theme set is fixed by the PLAN, and listing them
 * avoids a build-time glob over public/ (which Vite doesn't import-scan) and
 * sidesteps special characters in names like `Anura (Dark)`.
 */
const THEME_NAMES = [
  "Anura",
  "Anura (Dark)",
  "Classic",
  "Dendrobates",
  "Dendrobates (Dark)",
  "Kawazu",
  "Lakritz",
  "Mono",
  "Note",
  "Printen",
  "Pulse",
  "Resinifictrix",
  "Resinifictrix (Dark)",
] as const;

/**
 * Convert a CotEditor theme display name into a Monaco-legal theme id.
 *
 * Monaco requires theme ids to match `/^[a-z0-9-]+$/`, so `Anura (Dark)`
 * becomes `anura-dark`. We keep the display name around (in `themeRegistry`
 * and for menus) and only slugify for the Monaco `defineTheme`/`setTheme` calls.
 */
function monacoThemeId(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, "") // drop "(Dark)" etc.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Build a fetch URL for a vendored resource, keeping `#`/`+`/spaces encoded. */
function resourceUrl(...segments: string[]): string {
  const url = new URL(window.location.origin);
  url.pathname =
    "/resources/" + segments.map((s) => encodeURIComponent(s)).join("/");
  return url.toString();
}

/**
 * Load every theme and define it with Monaco. Themes live under the Vite
 * `public/resources/themes/` dir and are fetched at runtime; fetching (rather
 * than importing) lets names with spaces / parentheses resolve cleanly.
 */
export async function loadAllThemes(): Promise<void> {
  await Promise.all(
    THEME_NAMES.map(async (name) => {
      try {
        const res = await fetch(resourceUrl("themes", `${name}.cottheme`));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const theme = (await res.json()) as CotTheme;
        themeRegistry.set(name, theme);
        defineMonacoTheme(monacoThemeId(name), buildMonacoTheme(theme));
      } catch (err) {
        console.warn(`Failed to load theme ${name}:`, err);
      }
    }),
  );
}

/** Convert a parsed `.cottheme` into Monaco standalone theme data. */
function buildMonacoTheme(
  theme: CotTheme,
): monaco.editor.IStandaloneThemeData {
  const base = themeIsDark(theme) ? "vs-dark" : "vs";
  const bg = scopeColor(theme, "background") ?? (base === "vs-dark" ? "#1e1e1e" : "#ffffff");
  const fg = scopeColor(theme, "text") ?? (base === "vs-dark" ? "#d4d4d4" : "#000000");

  const colors: Record<string, string> = {
    "editor.background": bg,
    "editor.foreground": fg,
  };

  // Editor chrome scopes.
  const lineHighlight = scopeColor(theme, "lineHighlight");
  if (lineHighlight) colors["editor.lineHighlightBackground"] = lineHighlight;
  const selection = scopeColor(theme, "selection");
  if (selection) colors["editor.selectionBackground"] = selection;
  const invisibles = scopeColor(theme, "invisibles");
  if (invisibles) {
    colors["editorWhitespace.foreground"] = invisibles;
    colors["editorLineNumber.foreground"] = invisibles;
  }

  // Token colours. A scope may map to a Monaco token type via the table above;
  // scopes that have no Monaco token equivalent (background, selection, ...)
  // are only used for editor chrome and skipped here.
  const rules: monaco.editor.ITokenThemeRule[] = [];
  for (const [scope, token] of Object.entries(SCOPE_TO_MONACO_TOKEN)) {
    if (!token) continue;
    const color = scopeColor(theme, scope);
    if (color) rules.push({ token, foreground: color.slice(1) });
  }

  return { base: base as "vs" | "vs-dark" | "hc-black", inherit: true, rules, colors };
}

function themeIsDark(theme: CotTheme): boolean {
  const bg = scopeColor(theme, "background");
  if (!bg) return false;
  // luminance of #rrggbb
  const r = parseInt(bg.slice(1, 3), 16);
  const g = parseInt(bg.slice(3, 5), 16);
  const b = parseInt(bg.slice(5, 7), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum < 0.5;
}

/** Switch the active Monaco theme by display name. */
export function applyTheme(name: string): void {
  if (!themeRegistry.has(name)) {
    console.warn(`Unknown theme: ${name}`);
    return;
  }
  setMonacoTheme(monacoThemeId(name));
  currentTheme = name;
}

export function getCurrentTheme(): string | null {
  return currentTheme;
}

/** List available theme display names (suitable for a theme-switch menu). */
export function listThemes(): string[] {
  return [...themeRegistry.keys()];
}
