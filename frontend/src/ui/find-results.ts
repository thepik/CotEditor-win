/**
 * Independent find-results list (PLAN §阶段D).
 *
 * Monaco ships a find *widget* but no result overview. This module owns a
 * standalone list of matches for a Monaco text model:
 *
 *  - batched, cancellable line-by-line search (never edits the model),
 *  - line number + line context + highlighted match,
 *  - match count, no-result / regex-error / truncation notices,
 *  - click / Enter navigation, Up/Down keyboard movement, Escape to clear,
 *  - every result carries the model version it was computed from, so a search
 *    whose document changed (or whose handle was cancelled) never renders.
 *
 * The caller stays in charge of the actual editor navigation (`onNavigate`) and
 * of replacement (`onReplace`): this module only invokes those callbacks, it
 * never mutates the document.
 *
 * Usage:
 *   const results = createFindResults(document.getElementById("find-results")!, {
 *     onNavigate: (range) => {
 *       editor.setSelection(range);
 *       editor.revealRangeInCenterIfOutsideViewport(range);
 *       editor.focus();
 *     },
 *     onReplace: (range, text) => applyEdit(range, text),
 *   });
 *   const handle = results.search(model, query, {
 *     caseSensitive: false, wholeWord: true, regex: false,
 *   });
 *   handle.cancel();          // safe at any time
 *   await handle.done;        // summary: matches / truncated / cancelled / stale / error
 */

import type {
  editor as MonacoEditor,
  IDisposable,
  Range as MonacoRange,
} from "monaco-editor/esm/vs/editor/editor.api";
import { getEditor, monaco } from "../editor/monaco-setup";
import { getLang } from "../lib/i18n";
import "./find-results.css";

/** Hard cap so a pathological query cannot build an unbounded DOM list. */
export const MAX_FIND_RESULTS = 2000;

/** Line work per main-thread slice. Keeps long documents responsive. */
const BATCH_BUDGET_MS = 6;
const CONTEXT_BEFORE = 48;
const CONTEXT_AFTER = 120;

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /**
   * Restrict the search to the editor's current selection when the editor is
   * showing `model`. No selection (or no matching editor) means whole model.
   */
  includeSelection?: boolean;
}

export interface FindResultMatch {
  /** 1-based line number. */
  line: number;
  /** 1-based column of the first character. */
  column: number;
  /** Monaco range for the match (end column is exclusive). */
  range: MonacoRange;
  /** Full text of the line the match is on. */
  lineText: string;
  /** Matched text (empty only for zero-width regex matches). */
  matchText: string;
}

export interface SearchSummary {
  matches: FindResultMatch[];
  truncated: boolean;
  cancelled: boolean;
  stale: boolean;
  error: string | null;
  /** `model.getVersionId()` at the moment the search started. */
  versionId: number;
}

export interface SearchHandle {
  /** Stop the search. Results found so far are discarded. */
  cancel(): void;
  /** Resolves once the search has stopped and the list has settled. */
  readonly done: Promise<SearchSummary>;
}

export interface FindResultsOptions {
  /** Called on click / Enter. This module never moves the editor itself. */
  onNavigate(range: MonacoRange): void;
  /**
   * Optional replacement hook. `replaceAll` invokes it once per match in
   * reverse document order and never edits the model itself; the caller owns
   * atomic application and undo grouping.
   */
  onReplace?(range: MonacoRange, replacement: string): void;
}

export interface FindResultsController {
  search(model: MonacoEditor.ITextModel, query: string, options: SearchOptions): SearchHandle;
  /** Cancel any running search, discard results, hide the list. */
  clear(): void;
  /** Clear and remove the list from the host. */
  destroy(): void;
  /**
   * Ask the caller to replace every current match. Returns the number of
   * callbacks invoked. Does nothing when `onReplace` was not supplied.
   */
  replaceAll(replacement: string): number;
  /** True while the list is visible (searching or showing results). */
  isOpen(): boolean;
  /** Number of matches currently rendered. */
  matchCount(): number;
}

interface SearchScope {
  startLineNumber: number;
  /** 0-based offset into the first line. */
  startOffset: number;
  endLineNumber: number;
  /** 0-based exclusive offset into the last line. */
  endOffset: number;
}

interface SearchToken {
  model: MonacoEditor.ITextModel;
  versionId: number;
  cancelled: boolean;
  stale: boolean;
  finished: boolean;
  changeListener: IDisposable | null;
  disposeListener: IDisposable | null;
}

function tr(en: string, zh: string): string {
  return getLang() === "zh" ? zh : en;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

function isWholeWord(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  return !isWordChar(before) && !isWordChar(after);
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function emptySummary(versionId: number): SearchSummary {
  return {
    matches: [],
    truncated: false,
    cancelled: false,
    stale: false,
    error: null,
    versionId,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveScope(
  model: MonacoEditor.ITextModel,
  includeSelection: boolean,
): SearchScope {
  const lastLine = model.getLineCount();
  const full: SearchScope = {
    startLineNumber: 1,
    startOffset: 0,
    endLineNumber: lastLine,
    endOffset: model.getLineContent(lastLine).length,
  };
  if (!includeSelection) return full;

  const editor = getEditor();
  if (!editor || editor.getModel() !== model) return full;
  const selection = editor.getSelection();
  if (!selection || selection.isEmpty()) return full;

  const start = selection.getStartPosition();
  const end = selection.getEndPosition();
  return {
    startLineNumber: start.lineNumber,
    startOffset: Math.max(0, start.column - 1),
    endLineNumber: end.lineNumber,
    endOffset: Math.max(0, end.column - 1),
  };
}

/**
 * Build a results list inside `host`.
 *
 * The host is only a container: the module appends its own root, never touches
 * sibling content, and `destroy` removes exactly what it added.
 */
export function createFindResults(
  host: HTMLElement,
  options: FindResultsOptions,
): FindResultsController {
  let matches: FindResultMatch[] = [];
  let resultsModel: MonacoEditor.ITextModel | null = null;
  let resultsVersion = -1;
  let active: SearchToken | null = null;
  let destroyed = false;

  const root = document.createElement("div");
  root.className = "ce-find-results";
  root.hidden = true;
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", tr("Find results", "查找结果"));

  const head = document.createElement("div");
  head.className = "ce-find-results-head";

  const countEl = document.createElement("span");
  countEl.className = "ce-find-results-count";
  countEl.setAttribute("role", "status");
  countEl.setAttribute("aria-live", "polite");
  countEl.setAttribute("aria-atomic", "true");

  const closeEl = document.createElement("button");
  closeEl.type = "button";
  closeEl.className = "ce-find-results-close";
  closeEl.textContent = "×";
  closeEl.title = tr("Close", "关闭");
  closeEl.setAttribute("aria-label", tr("Close find results", "关闭查找结果"));

  const statusEl = document.createElement("div");
  statusEl.className = "ce-find-results-status";
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");
  statusEl.hidden = true;

  const list = document.createElement("div");
  list.className = "ce-find-results-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", tr("Find matches", "匹配项"));

  head.append(countEl, closeEl);
  root.append(head, statusEl, list);
  host.appendChild(root);

  function isActive(token: SearchToken): boolean {
    return !destroyed && active === token;
  }

  function cancelActive(): void {
    if (active) {
      active.cancelled = true;
      active = null;
    }
  }

  function isAborted(token: SearchToken): boolean {
    if (token.cancelled || token.stale) return true;
    try {
      if (token.model.isDisposed() || token.model.getVersionId() !== token.versionId) {
        token.stale = true;
        return true;
      }
    } catch {
      token.stale = true;
      return true;
    }
    return false;
  }

  function setStatus(kind: string, text: string): void {
    statusEl.dataset.kind = kind;
    statusEl.textContent = text;
    statusEl.hidden = false;
  }

  function resetForSearch(): void {
    matches = [];
    resultsModel = null;
    resultsVersion = -1;
    list.replaceChildren();
    list.scrollTop = 0;
    statusEl.hidden = true;
    statusEl.textContent = "";
    delete statusEl.dataset.kind;
    countEl.textContent = tr("Searching…", "搜索中…");
    root.hidden = false;
    root.setAttribute("aria-busy", "true");
  }

  function updateSearchingCount(found: number): void {
    countEl.textContent = tr(`Searching… ${found}`, `搜索中… ${found}`);
  }

  function applyCount(total: number, truncated: boolean): void {
    countEl.textContent = truncated
      ? tr(`${MAX_FIND_RESULTS}+ results`, `${MAX_FIND_RESULTS}+ 个结果`)
      : tr(
          `${total} result${total === 1 ? "" : "s"}`,
          `${total} 个结果`,
        );
  }

  function setSelected(index: number): void {
    const items = list.querySelectorAll<HTMLElement>(".ce-find-results-item");
    items.forEach((item, itemIndex) => {
      item.setAttribute("aria-selected", itemIndex === index ? "true" : "false");
    });
  }

  function navigate(index: number): void {
    const match = matches[index];
    if (!match) return;
    setSelected(index);
    try {
      options.onNavigate(match.range);
    } catch (error) {
      console.error("find-results: onNavigate failed", error);
    }
    // Best-effort selection when the editor is showing the searched model.
    // The callback above remains the authoritative navigation hook.
    try {
      const editor = getEditor();
      if (
        editor &&
        resultsModel &&
        editor.getModel() === resultsModel &&
        resultsModel.getVersionId() === resultsVersion
      ) {
        editor.setSelection(match.range);
        editor.revealRangeInCenterIfOutsideViewport(
          match.range,
          monaco.editor.ScrollType.Smooth,
        );
      }
    } catch {
      // The editor may be gone (window closing); the callback already ran.
    }
  }

  function appendContext(container: HTMLElement, match: FindResultMatch): void {
    const start = Math.max(0, match.column - 1);
    const end = Math.min(match.lineText.length, start + match.matchText.length);
    const from = Math.max(0, start - CONTEXT_BEFORE);
    const to = Math.min(match.lineText.length, end + CONTEXT_AFTER);
    if (from > 0) container.append("…");
    container.append(match.lineText.slice(from, start));
    if (match.matchText.length > 0) {
      const mark = document.createElement("mark");
      mark.className = "ce-find-results-match";
      mark.textContent = match.matchText;
      container.append(mark);
    }
    container.append(match.lineText.slice(end, to));
    if (to < match.lineText.length) container.append("…");
  }

  function createItem(match: FindResultMatch, index: number): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "ce-find-results-item";
    item.dataset.index = String(index);
    item.dataset.line = String(match.line);
    item.dataset.column = String(match.column);
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    const location = tr(
      `Line ${match.line}, column ${match.column}`,
      `第 ${match.line} 行，第 ${match.column} 列`,
    );
    item.title = location;
    item.setAttribute("aria-label", `${location}: ${match.matchText}`);

    const lineEl = document.createElement("span");
    lineEl.className = "ce-find-results-line";
    lineEl.textContent = String(match.line);

    const contextEl = document.createElement("span");
    contextEl.className = "ce-find-results-context";
    appendContext(contextEl, match);

    item.append(lineEl, contextEl);
    return item;
  }

  function applyAbort(token: SearchToken, summary: SearchSummary): void {
    if (token.cancelled) {
      summary.cancelled = true;
    } else {
      summary.stale = true;
    }
    if (!isActive(token)) return;
    matches = [];
    resultsModel = null;
    resultsVersion = -1;
    list.replaceChildren();
    countEl.textContent = "";
    if (token.cancelled) {
      setStatus("cancelled", tr("Search cancelled.", "已取消搜索。"));
    } else {
      setStatus(
        "stale",
        tr("Document changed; results discarded.", "文档已更改，结果已丢弃。"),
      );
    }
    root.setAttribute("aria-busy", "false");
  }

  function showError(message: string): void {
    matches = [];
    resultsModel = null;
    resultsVersion = -1;
    list.replaceChildren();
    countEl.textContent = tr("0 results", "0 个结果");
    setStatus("error", tr("Invalid regular expression: ", "正则表达式无效：") + message);
    root.setAttribute("aria-busy", "false");
  }

  function renderMatches(found: FindResultMatch[], truncated: boolean): void {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < found.length; index++) {
      fragment.appendChild(createItem(found[index], index));
    }
    list.replaceChildren(fragment);
    list.scrollTop = 0;
    applyCount(found.length, truncated);
    root.setAttribute("aria-busy", "false");
    if (truncated) {
      setStatus(
        "truncated",
        tr(
          `Showing the first ${MAX_FIND_RESULTS} matches only.`,
          `仅显示前 ${MAX_FIND_RESULTS} 条匹配。`,
        ),
      );
    } else if (found.length === 0) {
      setStatus("empty", tr("No results.", "无结果。"));
    } else {
      statusEl.hidden = true;
      statusEl.textContent = "";
      delete statusEl.dataset.kind;
    }
  }

  async function runSearch(
    token: SearchToken,
    model: MonacoEditor.ITextModel,
    query: string,
    searchOptions: SearchOptions,
  ): Promise<SearchSummary> {
    const summary = emptySummary(token.versionId);
    try {
      // Always yield once: callers get a handle they can cancel immediately,
      // even for tiny documents.
      await yieldToMain();
      if (isAborted(token)) {
        applyAbort(token, summary);
        return summary;
      }
      if (query.length === 0) {
        if (isActive(token)) {
          matches = [];
          resultsModel = null;
          resultsVersion = -1;
          list.replaceChildren();
          countEl.textContent = "";
          statusEl.hidden = true;
          root.hidden = true;
          root.setAttribute("aria-busy", "false");
        }
        return summary;
      }

      let matcher: RegExp;
      try {
        matcher = searchOptions.regex
          ? new RegExp(query, searchOptions.caseSensitive ? "gu" : "giu")
          : new RegExp(
              escapeRegExp(query),
              searchOptions.caseSensitive ? "g" : "gi",
            );
      } catch (error) {
        summary.error = errorMessage(error);
        if (isActive(token)) showError(summary.error);
        return summary;
      }

      const scope = resolveScope(model, searchOptions.includeSelection === true);
      const found: FindResultMatch[] = [];
      let truncated = false;
      let lineNumber = scope.startLineNumber;
      const endLine = Math.min(scope.endLineNumber, model.getLineCount());

      while (lineNumber <= endLine) {
        if (isAborted(token)) break;
        const batchStart = performance.now();
        while (lineNumber <= endLine) {
          if (isAborted(token)) break;

          let lineText: string;
          try {
            lineText = model.getLineContent(lineNumber);
          } catch {
            token.stale = true;
            break;
          }

          const from =
            lineNumber === scope.startLineNumber
              ? Math.min(Math.max(scope.startOffset, 0), lineText.length)
              : 0;
          const to =
            lineNumber === scope.endLineNumber
              ? Math.min(Math.max(scope.endOffset, 0), lineText.length)
              : lineText.length;

          matcher.lastIndex = from;
          let match: RegExpExecArray | null;
          while ((match = matcher.exec(lineText)) !== null) {
            const start = match.index;
            const end = start + match[0].length;
            if (end > to) break;
            if (!searchOptions.wholeWord || isWholeWord(lineText, start, end)) {
              if (found.length >= MAX_FIND_RESULTS) {
                truncated = true;
                break;
              }
              found.push({
                line: lineNumber,
                column: start + 1,
                lineText,
                matchText: match[0],
                range: new monaco.Range(lineNumber, start + 1, lineNumber, end + 1),
              });
            }
            // A zero-width match would otherwise leave lastIndex untouched.
            if (match[0].length === 0) matcher.lastIndex = start + 1;
          }

          lineNumber++;
          if (truncated) break;
          if (
            performance.now() - batchStart >= BATCH_BUDGET_MS &&
            lineNumber <= endLine
          ) {
            if (isActive(token)) updateSearchingCount(found.length);
            break;
          }
        }
        if (truncated) break;
        if (isAborted(token)) break;
        if (lineNumber <= endLine) await yieldToMain();
      }

      if (isAborted(token)) {
        applyAbort(token, summary);
        return summary;
      }

      summary.matches = found;
      summary.truncated = truncated;
      if (isActive(token)) {
        matches = found;
        resultsModel = model;
        resultsVersion = token.versionId;
        renderMatches(found, truncated);
      }
      return summary;
    } catch (error) {
      summary.error = errorMessage(error);
      if (isActive(token)) {
        showError(summary.error);
      }
      return summary;
    } finally {
      token.finished = true;
      token.changeListener?.dispose();
      token.disposeListener?.dispose();
      token.changeListener = null;
      token.disposeListener = null;
      if (active === token) active = null;
    }
  }

  function search(
    model: MonacoEditor.ITextModel,
    query: string,
    searchOptions: SearchOptions,
  ): SearchHandle {
    if (destroyed) {
      let versionId = 0;
      try {
        versionId = model.getVersionId();
      } catch {
        // model already disposed
      }
      return { cancel: () => undefined, done: Promise.resolve(emptySummary(versionId)) };
    }

    cancelActive();
    let versionId: number;
    try {
      versionId = model.getVersionId();
    } catch {
      // A disposed model cannot be searched; leave the previous UI untouched.
      return { cancel: () => undefined, done: Promise.resolve(emptySummary(0)) };
    }
    resetForSearch();

    const token: SearchToken = {
      model,
      versionId,
      cancelled: false,
      stale: false,
      finished: false,
      changeListener: null,
      disposeListener: null,
    };
    active = token;

    try {
      token.changeListener = model.onDidChangeContent(() => {
        if (model.getVersionId() !== token.versionId) token.stale = true;
      });
      token.disposeListener = model.onWillDispose(() => {
        token.stale = true;
      });
    } catch {
      token.stale = true;
    }

    const done = runSearch(token, model, query, searchOptions);
    return {
      cancel: () => {
        if (!token.finished) token.cancelled = true;
      },
      done,
    };
  }

  function clear(): void {
    cancelActive();
    matches = [];
    resultsModel = null;
    resultsVersion = -1;
    list.replaceChildren();
    countEl.textContent = "";
    statusEl.hidden = true;
    statusEl.textContent = "";
    delete statusEl.dataset.kind;
    root.hidden = true;
    root.setAttribute("aria-busy", "false");
  }

  function destroy(): void {
    if (destroyed) return;
    clear();
    destroyed = true;
    root.remove();
  }

  function isOpen(): boolean {
    return !destroyed && !root.hidden;
  }

  function matchCount(): number {
    return matches.length;
  }

  function replaceAll(replacement: string): number {
    if (!options.onReplace || matches.length === 0) return 0;
    // Reverse order keeps earlier ranges valid if the caller applies each edit
    // immediately; callers that build one edit list can ignore the order.
    for (let index = matches.length - 1; index >= 0; index--) {
      options.onReplace(matches[index].range, replacement);
    }
    return matches.length;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      clear();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      list.querySelectorAll<HTMLButtonElement>(".ce-find-results-item"),
    );
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next =
      current < 0
        ? event.key === "ArrowDown"
          ? 0
          : items.length - 1
        : Math.min(items.length - 1, Math.max(0, current + delta));
    items[next].focus();
    items[next].scrollIntoView({ block: "nearest" });
    setSelected(next);
  }

  root.addEventListener("keydown", onKeyDown);
  closeEl.addEventListener("click", clear);
  list.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const item = target?.closest<HTMLElement>(".ce-find-results-item");
    if (!item) return;
    const index = Number(item.dataset.index);
    if (Number.isInteger(index)) navigate(index);
  });

  return { search, clear, destroy, replaceAll, isOpen, matchCount };
}
