/**
 * Bottom statusbar: file path, dirty marker, cursor position.
 *
 * Pure DOM render. `updateStatusbar` is called from main.ts on cursor move and
 * content change; it does a cheap full re-render since the bar has ~3 fields.
 * Strings go through the i18n module so the bar follows the live language.
 */

import { t } from "../lib/i18n";

export interface StatusbarState {
  path: string | null;
  dirty: boolean;
  line: number;
  column: number;
}

export function updateStatusbar(state: StatusbarState): void {
  const host = document.getElementById("statusbar");
  if (!host) return;

  const name = state.path ? baseName(state.path) : t("status.untitled");
  const dirtyMark = state.dirty ? " ●" : "";
  const full = state.path ?? t("status.untitled");

  host.innerHTML =
    `<span class="sb-item sb-path" title="${escapeHtml(full)}">${escapeHtml(name)}${dirtyMark}</span>` +
    `<span class="sb-item">${t("status.line")} ${state.line}, ${t("status.column")} ${state.column}</span>` +
    `<span class="sb-item">UTF-8</span>` +
    `<span class="sb-item">LF</span>`;
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
