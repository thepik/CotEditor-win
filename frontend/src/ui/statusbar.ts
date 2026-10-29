/** Stable statusbar nodes: cursor movement updates only position fields. */
import { t } from "../lib/i18n";
import { createEncodingMenu, type EncodingMenuApi } from "./encoding-menu";

export type SaveState = "idle" | "unsaved" | "saving" | "saved" | "error";

export interface StatusbarState {
  path: string | null;
  dirty: boolean;
  line: number;
  column: number;
  syntax: string | null;
  encoding: string;
  lineEnding: "LF" | "CRLF" | "CR" | "MIXED";
  saveState: SaveState;
  lineCount: number;
  /** User-perceived graphemes, or explicitly labelled code points on old engines. */
  characterCount: number | null;
  characterKind: "graphemes" | "codePoints";
  cursorOffset: number;
  /** Null means a throttled calculation is pending, not zero bytes. */
  byteSize: number | null;
  readOnlyReason: string | null;
  onNormalize?: () => void;
  /** Statusbar encoding menu handlers (stable references from main.ts). */
  onEncodingReopen?: (encoding: string) => void;
  onEncodingSave?: (encoding: string) => void;
  /** False disables the encoding trigger (e.g. no active document). */
  encodingEnabled?: boolean;
}

let renderedHost: HTMLElement | null = null;
const fields = new Map<string, HTMLElement>();
const formatter = new Intl.NumberFormat();
let normalize: (() => void) | undefined;
let encodingMenu: EncodingMenuApi | null = null;
let lastEncodingReopen: ((encoding: string) => void) | undefined;
let lastEncodingSave: ((encoding: string) => void) | undefined;

function setText(field: string, value: string): void {
  const node = fields.get(field);
  if (node && node.textContent !== value) node.textContent = value;
}

function ensureNodes(): boolean {
  const host = document.getElementById("statusbar");
  if (!host) return false;
  if (host === renderedHost) return true;
  if (encodingMenu) {
    encodingMenu.destroy();
    encodingMenu = null;
  }
  lastEncodingReopen = undefined;
  lastEncodingSave = undefined;
  renderedHost = host;
  host.setAttribute("role", "contentinfo");
  host.setAttribute("aria-label", t("a11y.statusbar"));
  host.innerHTML =
    '<span class="sb-item sb-stat" data-stat="lines"></span>' +
    '<span class="sb-item sb-stat" data-stat="characters"></span>' +
    '<span class="sb-item sb-stat" data-stat="position"></span>' +
    '<span class="sb-item sb-stat" data-stat="cursor"></span>' +
    '<span class="sb-item sb-path"><span class="sb-file-dot" aria-hidden="true"></span><span data-stat="name"></span></span>' +
    '<span class="sb-item sb-save" role="status" aria-live="polite" aria-atomic="true"><span class="sb-save-dot" aria-hidden="true"></span><span data-stat="save"></span></span>' +
    '<span class="sb-item sb-syntax" data-stat="syntax"></span>' +
    '<span class="sb-item sb-meta sb-size" data-stat="bytes"></span>' +
    '<span class="sb-item sb-meta" data-stat="encoding"></span>' +
    '<span class="sb-item sb-meta" data-stat="eol"></span>' +
    '<span class="sb-item sb-meta" data-stat="readonly" role="status" aria-live="polite"></span>' +
    '<button type="button" class="sb-item sb-meta" data-stat="normalize"></button>';
  fields.clear();
  for (const node of host.querySelectorAll<HTMLElement>("[data-stat]")) {
    fields.set(node.dataset.stat!, node);
  }
  const normalizeButton = fields.get("normalize")!;
  // Keep the action visually part of the bar until styles.css owns a rule.
  normalizeButton.style.cssText =
    "font:inherit;color:var(--ce-accent);background:none;border:0;padding:0;cursor:pointer;";
  normalizeButton.addEventListener("click", () => normalize?.());

  // The encoding menu replaces the passive label. The original span stays in
  // the DOM (hidden) so diagnostics and older regressions can still read the
  // documented `data-stat="encoding"` field without parsing menu labels.
  const legacyEncoding = fields.get("encoding")!;
  const menuHost = document.createElement("span");
  menuHost.className = "sb-item sb-meta sb-encoding";
  menuHost.dataset.encodingHost = "true";
  legacyEncoding.hidden = true;
  legacyEncoding.setAttribute("aria-hidden", "true");
  legacyEncoding.before(menuHost);
  encodingMenu = createEncodingMenu({ host: menuHost, current: "UTF-8", disabled: true });
  return true;
}

export function updateStatusbarCursor(line: number, column: number, offset: number): void {
  setText("position", `${t("status.position")}: ${formatter.format(offset)}`);
  setText("cursor", `${t("status.line")} ${formatter.format(line)}, ${t("status.column")} ${formatter.format(column)}`);
}

export function updateStatusbar(state: StatusbarState): void {
  if (!ensureNodes()) return;
  const host = renderedHost!;
  host.setAttribute("aria-label", t("a11y.statusbar"));
  const name = state.path ? baseName(state.path) : t("status.untitled");
  setText("lines", `${t("status.totalLines")}: ${formatter.format(state.lineCount)}`);
  setText("characters", `${t(state.characterKind === "graphemes" ? "status.characters" : "status.codePoints")}: ${state.characterCount === null ? "…" : formatter.format(state.characterCount)}`);
  updateStatusbarCursor(state.line, state.column, state.cursorOffset);
  fields.get("position")!.title = t("status.utf16Position");
  setText("name", name);
  const path = host.querySelector<HTMLElement>(".sb-path")!;
  path.title = state.path ?? name;
  path.querySelector(".sb-file-dot")!.classList.toggle("is-dirty", state.dirty);

  const save = host.querySelector<HTMLElement>(".sb-save")!;
  save.dataset.state = state.saveState;
  save.style.display = state.saveState === "idle" ? "none" : "";
  setText("save", state.saveState === "idle" ? "" : t({
    unsaved: "status.unsaved", saving: "status.saving", saved: "status.saved", error: "status.saveError",
  }[state.saveState]));
  setText("syntax", state.syntax ?? t("syntax.plainText"));
  fields.get("syntax")!.title = t("menu.syntax");
  setText("bytes", state.byteSize === null ? "…" : formatBytes(state.byteSize));
  setText("encoding", state.encoding.toUpperCase() === "UTF-8" ? "Unicode (UTF-8)" : state.encoding);
  if (encodingMenu) {
    encodingMenu.setEncoding(state.encoding);
    if (state.onEncodingReopen !== lastEncodingReopen || state.onEncodingSave !== lastEncodingSave) {
      lastEncodingReopen = state.onEncodingReopen;
      lastEncodingSave = state.onEncodingSave;
      encodingMenu.setHandlers({
        reopen: state.onEncodingReopen,
        save: state.onEncodingSave,
      });
    }
    encodingMenu.setEnabled(state.encodingEnabled !== false && Boolean(lastEncodingReopen || lastEncodingSave));
  }
  setText("eol", state.lineEnding === "MIXED" ? t("format.mixed") : state.lineEnding);
  setText("readonly", state.readOnlyReason ? t("status.readOnly") : "");
  fields.get("readonly")!.title = state.readOnlyReason ?? "";
  fields.get("readonly")!.setAttribute(
    "aria-label",
    state.readOnlyReason ? `${t("status.readOnly")}: ${state.readOnlyReason}` : "",
  );
  fields.get("readonly")!.hidden = !state.readOnlyReason;
  normalize = state.onNormalize;
  fields.get("normalize")!.hidden = !normalize;
  fields.get("normalize")!.title = state.readOnlyReason ?? "";
  setText("normalize", t("format.normalizeLF"));
  fields.get("normalize")!.setAttribute("aria-label", t("format.normalizeLF"));
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} kB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
