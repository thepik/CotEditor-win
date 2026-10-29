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
 * Navigation is deliberately intercepted: the preview lives inside the
 * editor's own WebView, so letting a link navigate the document would replace
 * the whole application. Instead:
 *
 *  - `#fragment` links scroll the preview container itself.
 *  - http(s)/mailto/tel links are handed to the OS browser
 *    (`window.runtime.BrowserOpenURL` in Wails, `window.open` in a browser).
 *  - Document-relative links and images go through injectable handlers
 *    (`setPreviewLinkHandler`, `setPreviewResourceResolver`). Without a
 *    handler they are blocked and a visible notice is shown. Resolvers may
 *    return a promise (the native asset bridge is asynchronous); a slow result
 *    from an older render is discarded.
 *
 * Besides the full-screen Reading View, `showPreviewSplit()` keeps the editor
 * visible and lays the preview out beside it. Styling (including the
 * narrow-window single-column fallback) lives in styles.css; this module only
 * sets the layout state on the host.
 *
 * Re-renders are coalesced with `requestAnimationFrame` so a burst of edits
 * (e.g. typing) only repaints once per frame. The container's scroll offset is
 * carried across re-renders, so live preview does not jump to the top on every
 * keystroke.
 */

import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { getLang, t } from "../lib/i18n";

/** Shared parser; configured once for GFM + linkify + strikethrough. */
const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
});

// markdown-it enables GFM tables and strikethrough by default when the
// `markdown` preset is used; `linkify` is the only extra we opt into.

/**
 * Above this size we stop parsing Markdown and render escaped plain text.
 * A full parse + DOMPurify pass of multi-hundred-kilobyte documents is the
 * expensive part of preview, and a formatted render of such a document is not
 * useful enough to block the UI for it.
 */
export const PREVIEW_MAX_MARKDOWN_CHARS = 300_000;

/** Hard cap for the degraded plain-text view; keeps the DOM bounded. */
const PREVIEW_MAX_PLAIN_CHARS = 2_000_000;

/** Distance (px) left above an anchor target when scrolling the preview. */
const ANCHOR_OFFSET = 12;

let pendingFrame: number | null = null;
let visible = false;
let layout: PreviewLayout = "off";
let renderGeneration = 0;
let resourceResolver: PreviewResourceResolver | null = null;
let linkHandler: PreviewLinkHandler | null = null;

/** Layout state applied to `#editor` via `data-ce-preview-mode`. */
export type PreviewLayout = "off" | "full" | "split";

/** Bodies whose delegated click listener has already been installed. */
const wiredBodies = new WeakSet<HTMLElement>();

/* ---------------------------------- types --------------------------------- */

export type PreviewResourceKind = "image" | "link";

/**
 * Maps a document-relative resource reference (as written in the Markdown
 * buffer) to a URL the WebView can load. Return `null` to leave the resource
 * blocked. The host integration reads the file through the Go bridge and hands
 * back a `data:` URL; that call is asynchronous, so a promise is accepted as
 * well as a direct string.
 */
export type PreviewResourceResolver = (
  href: string,
  kind: PreviewResourceKind,
) => string | null | Promise<string | null>;

/**
 * Handles a document-relative link (e.g. `./notes/other.md`, `images/a.png`).
 * Return `false` to decline; anything else (including `void`) counts as
 * handled, so a simple `(href) => { openDocument(href); }` works.
 * Mutually exclusive with the resolver fallback: the link handler runs first.
 */
export type PreviewLinkHandler = (href: string, event: MouseEvent) => boolean | void;

export type PreviewHrefRoute =
  | { kind: "anchor"; id: string }
  | { kind: "external"; url: string }
  | { kind: "relative"; href: string }
  | { kind: "blocked"; href: string; reason: "empty" | "unsafe-scheme" };

export type PreviewSlugger = (text: string) => string;

/* ------------------------------ registration ------------------------------ */

/**
 * Install (or clear, with `null`) the resolver used for document-relative
 * images and, as a fallback, relative links.
 */
export function setPreviewResourceResolver(handler: PreviewResourceResolver | null): void {
  resourceResolver = handler;
}

/**
 * Install (or clear, with `null`) the handler for document-relative links.
 * The handler runs before the resource resolver.
 */
export function setPreviewLinkHandler(handler: PreviewLinkHandler | null): void {
  linkHandler = handler;
}

/* -------------------------------- slugging -------------------------------- */

/**
 * GitHub-flavoured slug for a heading's visible text. Unicode letters and
 * numbers are preserved (so Chinese headings get useful ids); punctuation and
 * emphasis markers are dropped, whitespace becomes a hyphen.
 */
export function slugifyHeading(text: string): string {
  const slug = text
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
  return slug || "section";
}

/**
 * Create a stateful slugger. The first occurrence of a heading keeps its base
 * slug; duplicates get `-1`, `-2`, ... appended. The `used` set also prevents
 * collisions with an explicitly numbered heading later in the document.
 */
export function createPreviewSlugger(): PreviewSlugger {
  const used = new Set<string>();
  return (text: string): string => {
    const base = slugifyHeading(text);
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    let suffix = 1;
    while (used.has(`${base}-${suffix}`)) suffix++;
    const slug = `${base}-${suffix}`;
    used.add(slug);
    return slug;
  };
}

/* -------------------------------- routing --------------------------------- */

/**
 * Classify a raw `href`/`src` from rendered Markdown. Pure and exported so the
 * behaviour can be regression-tested without a DOM.
 *
 * Only http(s), mailto and tel are routed outside the WebView; explicit
 * executable/data/file schemes are blocked. A Windows drive path (`C:\...`)
 * is treated as a document-relative reference rather than a URL scheme.
 */
export function routePreviewHref(rawHref: string): PreviewHrefRoute {
  const href = (rawHref ?? "").trim();
  if (href === "") return { kind: "blocked", href, reason: "empty" };

  if (href.startsWith("#")) {
    const id = href.slice(1);
    return id === ""
      ? { kind: "blocked", href, reason: "empty" }
      : { kind: "anchor", id };
  }

  if (href.startsWith("//")) {
    return { kind: "external", url: `https:${href}` };
  }
  if (/^https?:\/\//i.test(href)) {
    return { kind: "external", url: href };
  }
  if (/^(?:mailto|tel):/i.test(href)) {
    return { kind: "external", url: href };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) {
    return { kind: "blocked", href, reason: "unsafe-scheme" };
  }
  return { kind: "relative", href };
}

/**
 * Open an external URL outside the editor WebView. Wails exposes
 * `window.runtime.BrowserOpenURL`; in a plain browser we open a new tab with
 * `noopener`. Returns false when the URL is not an external destination.
 */
export function openExternalPreviewUrl(rawUrl: string): boolean {
  const route = routePreviewHref(rawUrl);
  if (route.kind !== "external") return false;

  const runtime = (window as unknown as {
    runtime?: { BrowserOpenURL?: (url: string) => void };
  }).runtime;
  if (runtime && typeof runtime.BrowserOpenURL === "function") {
    try {
      runtime.BrowserOpenURL(route.url);
      return true;
    } catch (err) {
      console.warn("preview: BrowserOpenURL failed", err);
    }
  }

  try {
    window.open(route.url, "_blank", "noopener");
    return true;
  } catch (err) {
    console.warn("preview: window.open failed", err);
    return false;
  }
}

/**
 * Scroll the preview container so the element with `rawId` sits near its top.
 * Only the container scrolls; the document (and therefore the app shell) never
 * moves. Returns false when no such anchor exists.
 */
export function scrollPreviewToAnchor(host: HTMLElement, rawId: string): boolean {
  let id = rawId;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    // A malformed escape sequence is still a valid literal id lookup.
  }

  let target: HTMLElement | null = null;
  try {
    target = host.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  } catch {
    target = null;
  }
  if (!target) {
    for (const element of Array.from(host.querySelectorAll<HTMLElement>("[id]"))) {
      if (element.id === id) {
        target = element;
        break;
      }
    }
  }
  if (!target) return false;

  const hostRect = host.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const delta = targetRect.top - hostRect.top;
  host.scrollTop = Math.max(0, host.scrollTop + delta - ANCHOR_OFFSET);
  return true;
}

/* ------------------------------ panel state ------------------------------- */

function getHost(): HTMLElement | null {
  return document.getElementById("preview");
}

function getBody(): HTMLElement | null {
  const host = getHost();
  if (!host) return null;
  let body = host.querySelector<HTMLElement>(".preview-body");
  if (!body) {
    // Tolerate a host supplied by an embedding/test harness without the
    // index.html scaffold; renderPreview only needs this one child.
    body = document.createElement("div");
    body.className = "preview-body";
    host.appendChild(body);
  }
  return body;
}

/** True when the preview panel is currently shown (full screen or split). */
export function isPreviewVisible(): boolean {
  return visible;
}

/** Active layout: `off`, full-screen preview or side-by-side split. */
export function getPreviewLayout(): PreviewLayout {
  return layout;
}

/**
 * Apply a layout state. In full-screen mode Monaco is hidden with
 * `display: none` so its model and layout state survive the switch; in split
 * mode both the editor and the preview stay visible and CSS divides the host.
 */
function applyLayout(next: PreviewLayout): void {
  const host = getHost();
  if (!host) return;
  const editorHost = document.getElementById("editor");
  const editor = document.querySelector("#editor > .monaco-editor");
  if (editor instanceof HTMLElement) {
    editor.style.display = next === "full" ? "none" : "";
  }
  editorHost?.setAttribute("data-ce-preview-mode", next);
  layout = next;
  visible = next !== "off";
  host.hidden = next === "off";
  if (next === "off" && pendingFrame !== null) {
    cancelAnimationFrame(pendingFrame);
    pendingFrame = null;
  }
}

/** Show the preview full screen (editor hidden). Idempotent. */
export function showPreview(): void {
  applyLayout("full");
}

/** Show the editor and the preview side by side. Idempotent. */
export function showPreviewSplit(): void {
  applyLayout("split");
}

/** Hide the preview panel, show the editor. Idempotent. */
export function hidePreview(): void {
  applyLayout("off");
}

/* -------------------------------- rendering ------------------------------- */

/**
 * Render `content` into the preview panel immediately.
 *
 * Call directly for a one-shot render (e.g. on entering preview mode). For
 * keystroke-driven updates prefer `schedulePreviewRender` which coalesces.
 * The preview's scroll offset survives the re-render.
 */
export function renderPreview(content: string): void {
  const host = getHost();
  const body = getBody();
  if (!host || !body) return;

  const previousTop = host.scrollTop;
  const previousLeft = host.scrollLeft;
  clearPreviewNotices(host);
  renderGeneration += 1;
  const generation = renderGeneration;

  if (content.trim() === "") {
    body.innerHTML = `<p class="preview-empty">${escapeHtml(t("preview.empty"))}</p>`;
    host.scrollTop = 0;
    host.scrollLeft = 0;
    return;
  }

  if (content.length > PREVIEW_MAX_MARKDOWN_CHARS) {
    renderPlainText(body, host, content);
  } else {
    const rawHtml = md.render(content);
    const safeHtml = DOMPurify.sanitize(rawHtml, {
      ADD_ATTR: ["target", "rel"],
    });
    body.innerHTML = safeHtml;
    assignHeadingIds(body);
    installBodyInteractions(body, host, generation);
  }

  host.scrollTop = previousTop;
  host.scrollLeft = previousLeft;
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

/**
 * Degraded path for very large buffers: escaped plain text, no Markdown
 * parsing, no heading ids and no link/image rewriting. The visible notice
 * tells the reader why the formatting disappeared.
 */
function renderPlainText(body: HTMLElement, host: HTMLElement, content: string): void {
  const clipped = content.length > PREVIEW_MAX_PLAIN_CHARS
    ? content.slice(0, PREVIEW_MAX_PLAIN_CHARS)
    : content;
  body.textContent = "";
  const pre = document.createElement("pre");
  pre.className = "preview-plain";
  pre.textContent = clipped;
  body.appendChild(pre);

  const truncated = clipped.length !== content.length;
  showPreviewNotice(
    host,
    localized(
      `文档较大（${content.length} 字符），已降级为纯文本预览${truncated ? "，超出部分已截断" : ""}。`,
      `Large document (${content.length} characters); showing a plain-text preview${truncated ? " (truncated)" : ""}.`,
    ),
  );
}

/**
 * Assign stable, duplicate-safe ids to every rendered heading. Doing this
 * after sanitisation avoids DOMPurify's DOM-clobbering protections stripping a
 * heading id such as "title" or "location".
 */
function assignHeadingIds(body: HTMLElement): void {
  const slug = createPreviewSlugger();
  const headings = body.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6");
  for (const heading of Array.from(headings)) {
    heading.id = slug(heading.textContent ?? "");
  }
}

/**
 * Install the delegated link handler (once per body) and resolve images for
 * this render. The body element is reused across renders, so the listener
 * survives innerHTML replacement and must be registered only once.
 */
function installBodyInteractions(
  body: HTMLElement,
  host: HTMLElement,
  generation: number,
): void {
  if (!wiredBodies.has(body)) {
    wiredBodies.add(body);
    body.addEventListener("click", (event) => handlePreviewClick(event, body, host));
  }
  resolveImages(body, host, generation);
}

function handlePreviewClick(event: MouseEvent, body: HTMLElement, host: HTMLElement): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement) || !body.contains(anchor)) return;

  // Never let the editor WebView navigate, even for cases we cannot resolve.
  event.preventDefault();

  const href = anchor.getAttribute("href") ?? "";
  const route = routePreviewHref(href);
  switch (route.kind) {
    case "anchor":
      if (!scrollPreviewToAnchor(host, route.id)) {
        showPreviewNotice(host, localized(`未找到锚点：#${route.id}`, `Anchor not found: #${route.id}`));
      }
      return;
    case "external":
      openExternalPreviewUrl(route.url);
      return;
    case "blocked":
      showPreviewNotice(
        host,
        localized(`已阻止不安全的链接：${href}`, `Blocked unsafe link: ${href}`),
      );
      return;
    case "relative": {
      if (linkHandler) {
        let handled = false;
        try {
          handled = linkHandler(route.href, event) !== false;
        } catch (err) {
          console.error("preview: link handler failed", err);
        }
        if (handled) return;
      }
      // Optional fallback: a resolver may map a relative link to an absolute
      // URL or an in-page anchor (image resolution is handled per-render).
      if (resourceResolver) {
        let resolved: string | null | Promise<string | null> = null;
        try {
          resolved = resourceResolver(route.href, "link");
        } catch (err) {
          console.error("preview: resource resolver failed for link", err);
        }
        // A click must be handled synchronously; an async resolver result is
        // not useful here (the host installs a link handler instead).
        if (typeof resolved === "string" && resolved) {
          const resolvedRoute = routePreviewHref(resolved);
          if (resolvedRoute.kind === "external") {
            openExternalPreviewUrl(resolvedRoute.url);
            return;
          }
          if (resolvedRoute.kind === "anchor") {
            if (scrollPreviewToAnchor(host, resolvedRoute.id)) return;
          }
        }
      }
      showPreviewNotice(
        host,
        localized(
          `已阻止相对链接：${route.href}（未配置链接处理器）`,
          `Blocked relative link: ${route.href} (no link handler configured)`,
        ),
      );
      return;
    }
  }
}

/**
 * Rewrite or block image sources. Remote images are left alone (they are
 * explicit URLs in the document); relative sources require a resolver,
 * otherwise the image is removed and a notice is shown.
 *
 * Resolvers may be asynchronous. Each image is updated as soon as its own
 * result arrives; results that belong to an older render (or an image that has
 * since been detached) are ignored. Sync resolvers still paint in the same
 * task, which keeps the simple `data:`-from-memory harness deterministic.
 */
function resolveImages(body: HTMLElement, host: HTMLElement, generation: number): void {
  let blocked = 0;
  let firstBlocked = "";
  let asyncPending = 0;

  const block = (image: HTMLImageElement, src: string): void => {
    image.removeAttribute("src");
    image.setAttribute("data-preview-blocked", "true");
    if (!image.alt) image.alt = src;
    blocked += 1;
    if (!firstBlocked) firstBlocked = src;
  };

  for (const image of Array.from(body.querySelectorAll<HTMLImageElement>("img"))) {
    const src = (image.getAttribute("src") ?? "").trim();
    if (!src) continue;
    if (/^(?:data:image\/|blob:)/i.test(src)) continue;

    const route = routePreviewHref(src);
    if (route.kind === "external") continue;

    if (route.kind === "relative") {
      let resolved: string | null | Promise<string | null> = null;
      if (resourceResolver) {
        try {
          resolved = resourceResolver(src, "image");
        } catch (err) {
          console.error("preview: resource resolver failed for image", err);
        }
      }
      if (resolved && typeof (resolved as Promise<string | null>).then === "function") {
        asyncPending += 1;
        void (resolved as Promise<string | null>)
          .then((url) => {
            if (generation !== renderGeneration || !image.isConnected) return;
            if (url && isSafeImageUrl(url)) {
              image.setAttribute("src", url);
              return;
            }
            block(image, src);
          })
          .catch((err) => {
            console.error("preview: resource resolver failed for image", err);
            if (generation !== renderGeneration || !image.isConnected) return;
            block(image, src);
          })
          .finally(() => {
            asyncPending -= 1;
            if (
              asyncPending === 0
              && generation === renderGeneration
              && blocked > 0
            ) {
              showBlockedImagesNotice(host, blocked, firstBlocked);
            }
          });
        continue;
      }
      const syncResolved = resolved as string | null;
      if (syncResolved && isSafeImageUrl(syncResolved)) {
        image.setAttribute("src", syncResolved);
        continue;
      }
    }

    block(image, src);
  }

  if (asyncPending === 0 && blocked > 0) {
    showBlockedImagesNotice(host, blocked, firstBlocked);
  }
}

function showBlockedImagesNotice(
  host: HTMLElement,
  blocked: number,
  firstBlocked: string,
): void {
  showPreviewNotice(
    host,
    localized(
      `已阻止 ${blocked} 个无法解析的相对图片（例如 ${firstBlocked}）。`,
      `Blocked ${blocked} unresolved relative image${blocked === 1 ? "" : "s"} (e.g. ${firstBlocked}).`,
    ),
  );
}

/** Guard resolver output: allow URLs a WebView can safely load as an image. */
function isSafeImageUrl(url: string): boolean {
  const value = url.trim();
  if (value === "") return false;
  if (/^(?:https?:\/\/|data:image\/|blob:|\/|\.{1,2}\/)/i.test(value)) return true;
  // Bare relative paths (and Windows drive paths) are fine; explicit schemes
  // such as javascript:, data:text/html or file: are not.
  return !/^[a-z][a-z0-9+.-]*:/i.test(value) || /^[a-z]:[\\/]/i.test(value);
}

/* --------------------------------- notices -------------------------------- */

function clearPreviewNotices(host: HTMLElement): void {
  for (const notice of Array.from(host.querySelectorAll<HTMLElement>(":scope > .preview-notice"))) {
    notice.remove();
  }
}

/**
 * Show a small, persistent status banner at the top of the preview container.
 * Inline styles keep preview.ts self-contained (styles.css is owned by the
 * app shell) and themed via the same `--ce-*` custom properties.
 */
function showPreviewNotice(host: HTMLElement, message: string): void {
  let notice = host.querySelector<HTMLElement>(":scope > .preview-notice");
  if (!notice) {
    notice = document.createElement("div");
    notice.className = "preview-notice";
    notice.setAttribute("role", "status");
    notice.style.cssText = [
      "position:sticky",
      "top:8px",
      "z-index:5",
      "margin:0 0 12px",
      "padding:8px 12px",
      "border:1px solid var(--ce-border, #d9dde3)",
      "border-radius:6px",
      "background:var(--ce-surface-raised, #ffffff)",
      "color:var(--ce-fg, #202124)",
      "font:12px/1.45 system-ui, sans-serif",
      "box-shadow:0 2px 8px rgba(20, 28, 40, 0.14)",
      "pointer-events:none",
    ].join(";");
    host.insertBefore(notice, host.firstChild);
  }
  notice.textContent = message;
  notice.hidden = false;
}

/* --------------------------------- helpers -------------------------------- */

function localized(zh: string, en: string): string {
  return getLang() === "zh" ? zh : en;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
