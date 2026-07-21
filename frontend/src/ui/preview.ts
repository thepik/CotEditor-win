/**
 * Markdown preview panel.
 *
 * Renders the current Monaco buffer as HTML inside `#preview`, mirroring
 * Obsidian's Reading View: a single centered column of readable width with
 * theme-aware typography. The panel sits inside `.editor-host` as a sibling
 * of the Monaco editor; `showPreview()` / `hidePreview()` toggle which one is
 * visible (the editor is hidden via `display: none` so it keeps its layout
 * state ready for the switch back).
 *
 * Markdown is parsed by a cached `markdown-it` instance (GFM tables,
 * strikethrough, linkify) and sanitised through DOMPurify before injection,
 * so arbitrary `<script>`/event-handler payloads in a buffer cannot run.
 *
 * Re-renders are coalesced with `requestAnimationFrame` so a burst of edits
 * (e.g. typing) only repaints once per frame.
 */

import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { t } from "../lib/i18n";

/** Shared parser; configured once for GFM + linkify + strikethrough. */
const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
});

// markdown-it enables GFM tables and strikethrough by default when the
// `markdown` preset is used; `linkify` is the only extra we opt into.

let pendingFrame: number | null = null;
let visible = false;

function getHost(): HTMLElement | null {
  return document.getElementById("preview");
}

function getBody(): HTMLElement | null {
  return getHost()?.querySelector<HTMLElement>(".preview-body") ?? null;
}

/** True when the preview panel is currently shown (editor hidden). */
export function isPreviewVisible(): boolean {
  return visible;
}

/** Hide the editor, show the preview panel. Idempotent. */
export function showPreview(): void {
  const host = getHost();
  if (!host) return;
  host.hidden = false;
  // Monaco is mounted as `.monaco-editor` directly inside `#editor`; toggling
  // `display: none` keeps the model/layout alive but out of view.
  const editor = document.querySelector("#editor > .monaco-editor");
  if (editor instanceof HTMLElement) editor.style.display = "none";
  visible = true;
}

/** Hide the preview panel, show the editor. Idempotent. */
export function hidePreview(): void {
  const host = getHost();
  if (!host) return;
  host.hidden = true;
  const editor = document.querySelector("#editor > .monaco-editor");
  if (editor instanceof HTMLElement) editor.style.display = "";
  if (pendingFrame !== null) {
    cancelAnimationFrame(pendingFrame);
    pendingFrame = null;
  }
  visible = false;
}

/**
 * Render `content` into the preview panel immediately.
 *
 * Call directly for a one-shot render (e.g. on entering preview mode). For
 * keystroke-driven updates prefer `schedulePreviewRender` which coalesces.
 */
export function renderPreview(content: string): void {
  const body = getBody();
  if (!body) return;
  const trimmed = content.trim();
  if (trimmed === "") {
    body.innerHTML = `<p class="preview-empty">${escapeHtml(t("preview.empty"))}</p>`;
    return;
  }
  const rawHtml = md.render(content);
  const safeHtml = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ["target", "rel"],
  });
  body.innerHTML = safeHtml;
}

/**
 * Coalesced render: at most one repaint per animation frame. Safe to call
 * on every `onDidChangeContent` while in preview mode.
 */
export function schedulePreviewRender(content: string): void {
  if (!visible) return;
  if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null;
    renderPreview(content);
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
