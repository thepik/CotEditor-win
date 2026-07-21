/**
 * Bottom statusbar: document statistics, file state, and cursor position.
 *
 * Pure DOM render. `updateStatusbar` is called from main.ts on cursor move and
 * content change; it does a cheap full re-render since the bar has ~3 fields.
 * Strings go through the i18n module so the bar follows the live language.
 */

import { t } from "../lib/i18n";

export type SaveState = "idle" | "unsaved" | "saving" | "saved" | "error";

export interface StatusbarState {
  path: string | null;
  dirty: boolean;
  line: number;
  column: number;
  /** Active CotEditor syntax name, or null for plaintext. */
  syntax: string | null;
  encoding: string;
  lineEnding: "LF" | "CRLF" | "CR";
  saveState: SaveState;
  /** Total number of lines in the buffer. */
  lineCount: number;
  /** Total number of UTF-16 code units in the buffer. */
  characterCount: number;
  /** UTF-16 offset of the cursor from the beginning of the buffer. */
  cursorOffset: number;
  /** Size of the document as it will be written to disk, in bytes. */
  byteSize: number;
}

export function updateStatusbar(state: StatusbarState): void {
  const host = document.getElementById("statusbar");
  if (!host) return;

  const name = state.path ? baseName(state.path) : t("status.untitled");
  const full = state.path ?? t("status.untitled");
  const syntaxLabel = state.syntax ?? t("syntax.plainText");
  const encodingLabel = state.encoding.toUpperCase() === "UTF-8" ? "Unicode (UTF-8)" : state.encoding;
  const saveLabel =
    state.saveState === "unsaved"
      ? t("status.unsaved")
      : state.saveState === "saving"
        ? t("status.saving")
        : state.saveState === "error"
          ? t("status.saveError")
          : state.saveState === "saved"
            ? t("status.saved")
            : "";

  host.innerHTML =
    `<span class="sb-item sb-stat">${escapeHtml(t("status.totalLines"))}: ${formatNumber(state.lineCount)}</span>` +
    `<span class="sb-item sb-stat">${escapeHtml(t("status.characters"))}: ${formatNumber(state.characterCount)}</span>` +
    `<span class="sb-item sb-stat">${escapeHtml(t("status.position"))}: ${formatNumber(state.cursorOffset)}</span>` +
    `<span class="sb-item sb-stat">${escapeHtml(t("status.currentLine"))}: ${formatNumber(state.line)}</span>` +
    `<span class="sb-item sb-path" title="${escapeHtml(full)}"><span class="sb-file-dot${state.dirty ? " is-dirty" : ""}"></span>${escapeHtml(name)}</span>` +
    (saveLabel
      ? `<span class="sb-item sb-save" data-state="${state.saveState}"><span class="sb-save-dot"></span>${escapeHtml(saveLabel)}</span>`
      : "") +
    `<span class="sb-item sb-syntax" title="${escapeHtml(t("menu.syntax"))}">${escapeHtml(syntaxLabel)}</span>` +
    `<span class="sb-item sb-meta sb-size">${formatBytes(state.byteSize)}</span>` +
    `<span class="sb-item sb-meta sb-select-like">${escapeHtml(encodingLabel)}</span>` +
    `<span class="sb-item sb-meta sb-select-like">${state.lineEnding}</span>`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} kB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

function baseName(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
