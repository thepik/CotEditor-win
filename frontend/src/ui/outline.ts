/**
 * Markdown outline panel.
 *
 * A self-contained controller that owns everything inside a host element:
 * parsing ATX headings from the buffer, the filter field, the list, cursor
 * synchronisation and keyboard navigation. It deliberately knows nothing
 * about `main.ts`, the toolbar or the menubar, so it can be mounted later
 * without touching those files:
 *
 *   const outline = createOutline(host);
 *   outline.update(getModel());                   // on content changes
 *   outline.setActiveLine(cursor.lineNumber);     // on cursor moves
 *   outline.onNavigate((line) => { ... });        // optional; defaults to focus
 *   outline.toggle();                             // show/hide
 *
 * The default navigation path focuses Monaco's textarea (via a DOM lookup);
 * `onNavigate` listeners run first so the host can position the cursor with
 * the editor API. Tests can mark a focus fixture with
 * `[data-ce-outline-editor-focus]` to exercise that hand-off in isolation.
 *
 * Styles live in `outline.css` and are all `ce-outline-` prefixed to avoid
 * leaking into the application chrome.
 */

import "./outline.css";
import { getLang } from "../lib/i18n";

/** One ATX heading; `line` is 1-based to match Monaco. */
export interface OutlineHeading {
  level: number;
  text: string;
  line: number;
}

/** Structural subset of Monaco's `ITextModel` needed by `update`. */
export interface OutlineDocument {
  getValue(): string;
}

export interface OutlineController {
  /** Re-parse from a model (or raw text) and repaint the list. */
  update(model: OutlineDocument | string): void;
  /** Highlight the heading whose section contains `line` (1-based). */
  setActiveLine(line: number): void;
  /** Toggle the host's `hidden` state; `force` true shows, false hides. */
  toggle(force?: boolean): void;
  /** Remove listeners, listeners registered via `onNavigate`, and owned DOM. */
  dispose(): void;
  /** Subscribe to navigation; returns an unsubscribe function. */
  onNavigate(handler: (line: number) => void): () => void;
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Parse ATX headings (`#`..`######`) from Markdown, skipping fenced code
 * blocks. Setext headings and blockquote-nested headings are intentionally
 * not part of this first outline (ATX is what the plan scoped).
 */
export function parseOutlineHeadings(markdown: string): OutlineHeading[] {
  const lines = markdown.split(/\r\n|\r|\n/);
  const headings: OutlineHeading[] = [];
  let fence: { char: string; length: number } | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }

    const open = FENCE.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }

    const match = ATX_HEADING.exec(line);
    if (!match) continue;
    const text = (match[2] ?? "")
      .replace(/[ \t]+#+[ \t]*$/, "")
      .trim();
    if (text === "") continue;
    headings.push({ level: match[1].length, text, line: index + 1 });
  }

  return headings;
}

function localized(zh: string, en: string): string {
  return getLang() === "zh" ? zh : en;
}

/**
 * Create an outline panel inside `host`. The host's existing children are
 * replaced; `host.hidden` is left untouched so the caller controls layout.
 */
export function createOutline(host: HTMLElement): OutlineController {
  const doc = host.ownerDocument;
  const abort = new AbortController();
  const signal = abort.signal;
  const listeners = new Set<(line: number) => void>();

  let disposed = false;
  let headings: OutlineHeading[] = [];
  let visibleLines: number[] = [];
  let activeLine = 0;
  let activeIndex = -1;
  let signature = "";

  host.classList.add("ce-outline-host");
  host.replaceChildren();

  const panel = doc.createElement("div");
  panel.className = "ce-outline-panel";

  const header = doc.createElement("div");
  header.className = "ce-outline-header";
  const title = doc.createElement("span");
  title.className = "ce-outline-title";
  title.textContent = localized("大纲", "Outline");
  const count = doc.createElement("span");
  count.className = "ce-outline-count";
  count.setAttribute("aria-hidden", "true");
  header.append(title, count);

  const filter = doc.createElement("input");
  filter.type = "search";
  filter.className = "ce-outline-filter";
  filter.autocomplete = "off";
  filter.spellcheck = false;
  const filterLabel = localized("筛选标题", "Filter headings");
  filter.placeholder = `${filterLabel}…`;
  filter.setAttribute("aria-label", filterLabel);

  const list = doc.createElement("ul");
  list.className = "ce-outline-list";

  const empty = doc.createElement("p");
  empty.className = "ce-outline-empty";
  empty.hidden = true;

  panel.append(header, filter, list, empty);
  host.appendChild(panel);

  function activeHeadingLine(): number | null {
    let found: number | null = null;
    for (const heading of headings) {
      if (heading.line <= activeLine) found = heading.line;
      else break;
    }
    return found;
  }

  function applyActiveState(): void {
    const active = activeHeadingLine();
    for (const item of Array.from(list.querySelectorAll<HTMLElement>(".ce-outline-item"))) {
      const isActive = active !== null && Number(item.dataset.line) === active;
      item.dataset.active = isActive ? "true" : "false";
      if (isActive) item.setAttribute("aria-current", "true");
      else item.removeAttribute("aria-current");
    }
  }

  function clearKeyboardFocus(): void {
    for (const item of Array.from(list.querySelectorAll<HTMLElement>(".ce-outline-item"))) {
      delete item.dataset.focus;
    }
  }

  function applyKeyboardFocus(): void {
    const line = activeIndex >= 0 && activeIndex < visibleLines.length
      ? visibleLines[activeIndex]
      : null;
    for (const item of Array.from(list.querySelectorAll<HTMLElement>(".ce-outline-item"))) {
      if (line !== null && Number(item.dataset.line) === line) item.dataset.focus = "true";
      else delete item.dataset.focus;
    }
    if (line !== null) {
      list
        .querySelector<HTMLElement>(`.ce-outline-item[data-line="${line}"] .ce-outline-button`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }

  function renderList(): void {
    const query = filter.value.trim().toLowerCase();
    const matching = query === ""
      ? headings
      : headings.filter((heading) => heading.text.toLowerCase().includes(query));

    visibleLines = matching.map((heading) => heading.line);
    activeIndex = -1;
    list.replaceChildren();

    for (const heading of matching) {
      const item = doc.createElement("li");
      item.className = "ce-outline-item";
      item.dataset.line = String(heading.line);
      item.dataset.level = String(heading.level);
      item.style.setProperty("--ce-outline-level", String(heading.level));

      const button = doc.createElement("button");
      button.type = "button";
      button.className = "ce-outline-button";
      button.textContent = heading.text;
      button.title = `${heading.text} · ${localized(`第 ${heading.line} 行`, `line ${heading.line}`)}`;

      item.appendChild(button);
      list.appendChild(item);
    }

    count.textContent = query === ""
      ? String(headings.length)
      : `${matching.length}/${headings.length}`;
    empty.hidden = matching.length > 0;
    empty.textContent = headings.length === 0
      ? localized("没有标题", "No headings")
      : localized("没有匹配的标题", "No matching headings");

    applyActiveState();
  }

  function navigate(line: number): void {
    if (disposed || !Number.isFinite(line)) return;
    activeLine = line;
    applyActiveState();

    for (const handler of Array.from(listeners)) {
      try {
        handler(line);
      } catch (err) {
        console.error("outline: navigation handler failed", err);
      }
    }

    // Hand focus back to the editor. An explicit hook (used by hosts/tests
    // that do not mount Monaco) wins over the Monaco textarea lookup.
    const explicit = doc.querySelector<HTMLElement>("[data-ce-outline-editor-focus]");
    const editor = explicit
      ?? doc.querySelector<HTMLElement>("#editor .monaco-editor textarea, #editor textarea");
    editor?.focus();
  }

  function update(model: OutlineDocument | string): void {
    if (disposed) return;
    let text = "";
    if (typeof model === "string") {
      text = model;
    } else if (model && typeof model.getValue === "function") {
      text = model.getValue();
    }

    const next = parseOutlineHeadings(text);
    const nextSignature = next
      .map((heading) => `${heading.line}:${heading.level}:${heading.text}`)
      .join("\n");
    headings = next;

    if (nextSignature !== signature) {
      signature = nextSignature;
      renderList();
    } else {
      applyActiveState();
    }
  }

  function setActiveLine(line: number): void {
    if (disposed) return;
    activeLine = Number.isFinite(line) ? Math.max(0, Math.trunc(line)) : 0;
    applyActiveState();
  }

  function toggle(force?: boolean): void {
    if (disposed) return;
    const show = typeof force === "boolean" ? force : host.hidden;
    host.hidden = !show;
    if (show) applyActiveState();
  }

  function onNavigate(handler: (line: number) => void): () => void {
    if (disposed) return () => {};
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    abort.abort();
    listeners.clear();
    panel.remove();
    host.classList.remove("ce-outline-host");
    headings = [];
    visibleLines = [];
  }

  filter.addEventListener("input", () => {
    activeIndex = -1;
    clearKeyboardFocus();
    renderList();
  }, { signal });

  panel.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (visibleLines.length === 0) return;
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      activeIndex = activeIndex < 0
        ? (direction > 0 ? 0 : visibleLines.length - 1)
        : (activeIndex + direction + visibleLines.length) % visibleLines.length;
      applyKeyboardFocus();
      return;
    }

    if (event.key === "Enter" && event.target === filter) {
      if (visibleLines.length === 0) return;
      event.preventDefault();
      const line = activeIndex >= 0 && activeIndex < visibleLines.length
        ? visibleLines[activeIndex]
        : visibleLines[0];
      navigate(line);
      return;
    }

    if (event.key === "Escape" && event.target === filter && filter.value !== "") {
      event.preventDefault();
      filter.value = "";
      renderList();
    }
  }, { signal });

  list.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const item = target.closest<HTMLElement>(".ce-outline-item");
    if (!item || !list.contains(item)) return;
    const line = Number(item.dataset.line);
    if (Number.isFinite(line)) navigate(line);
  }, { signal });

  renderList();

  return { update, setActiveLine, toggle, dispose, onNavigate };
}
