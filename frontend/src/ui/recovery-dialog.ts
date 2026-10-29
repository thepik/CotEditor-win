/**
 * Recovery draft picker (phase B).
 *
 * Displays the drafts returned by `RecoveryService.list()` and returns the
 * user's intent without touching storage:
 *
 *   { action: "restore", entry }  restore this draft
 *   { action: "discard", entry }  discard the selected draft
 *   { action: "discard" }         discard every draft
 *   { action: "cancel" }          keep everything for later
 *
 * The dialog is a focus-trapped modal: Arrow keys move the selection, Enter
 * restores, Delete discards, Escape cancels, and Tab cycles the row plus the
 * footer buttons. Background chrome is made inert while it is open.
 *
 * Wiring notes for `main.ts` (phase F2):
 *  - `const drafts = await recovery.list(); if (drafts.length)
 *      const result = await openRecoveryDialog({ entries: drafts });`
 *  - `restore`: `openPath(entry.path)` or seed an untitled document with
 *    `entry.content`, then `recovery.discard(entry.id)`.
 *  - `discard` with `entry`: `recovery.discard(entry.id)`.
 *  - `discard` without `entry`: `recovery.discardAll()`.
 */

import "./recovery-dialog.css";
import { getLang, type Lang } from "../lib/i18n";
import { recoveryTimeToMillis } from "../lib/recovery-service";

export interface RecoveryDialogEntry {
  id: string;
  path?: string | null;
  content?: string;
  encoding?: string;
  lineEnding?: string;
  /** Milliseconds (or backend nanoseconds; normalized here). */
  updatedAt?: number;
  exists?: boolean;
  /** Optional display override; otherwise derived from `path`. */
  fileName?: string;
}

export type RecoveryDialogResult =
  | { action: "restore"; entry: RecoveryDialogEntry }
  | { action: "discard"; entry?: RecoveryDialogEntry }
  | { action: "cancel" };

export interface RecoveryDialogOptions {
  entries: readonly RecoveryDialogEntry[];
  lang?: Lang;
  title?: string;
}

interface Labels {
  title: string;
  intro: string;
  empty: string;
  restore: string;
  discard: string;
  discardAll: string;
  cancel: string;
  untitled: string;
  missing: string;
  encoding: string;
}

let activeDialog = false;

function labelsFor(lang: Lang): Labels {
  if (lang === "zh") {
    return {
      title: "恢复未保存的草稿",
      intro: "以下草稿在上次异常退出或关闭前自动保存。恢复后请及时保存或另存为。",
      empty: "没有可恢复的草稿。",
      restore: "恢复选中",
      discard: "丢弃选中",
      discardAll: "全部丢弃",
      cancel: "取消",
      untitled: "未命名",
      missing: "原文件已不存在",
      encoding: "编码",
    };
  }
  return {
    title: "Recover unsaved drafts",
    intro: "These drafts were saved automatically before the last abnormal exit or close. Restore one, then save it.",
    empty: "No drafts to recover.",
    restore: "Restore Selected",
    discard: "Discard Selected",
    discardAll: "Discard All",
    cancel: "Cancel",
    untitled: "Untitled",
    missing: "Original file no longer exists",
    encoding: "Encoding",
  };
}

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function formatTimestamp(value: number | undefined, lang: Lang): string {
  const millis = recoveryTimeToMillis(value ?? 0);
  if (millis <= 0) return "—";
  try {
    return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(millis));
  } catch {
    return new Date(millis).toLocaleString();
  }
}

/**
 * Open the recovery picker. Concurrent calls resolve to `cancel` so two
 * recovery modals can never own focus at once.
 */
export function openRecoveryDialog(
  options: RecoveryDialogOptions,
): Promise<RecoveryDialogResult> {
  if (activeDialog) return Promise.resolve({ action: "cancel" });
  activeDialog = true;

  const lang = options.lang ?? getLang();
  const labels = labelsFor(lang);
  const entries = [...options.entries];
  const previousFocus = document.activeElement as HTMLElement | null;
  let selected = entries.length > 0 ? 0 : -1;

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ce-modal ce-recovery";
    overlay.setAttribute("role", "presentation");

    const card = document.createElement("div");
    card.className = "ce-modal-card ce-recovery-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "ce-recovery-title");
    card.setAttribute("aria-describedby", "ce-recovery-intro");

    const head = document.createElement("div");
    head.className = "ce-modal-head";
    const heading = document.createElement("h2");
    heading.id = "ce-recovery-title";
    heading.textContent = options.title ?? labels.title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ce-modal-close ce-recovery-close";
    close.dataset.action = "cancel";
    close.setAttribute("aria-label", labels.cancel);
    close.textContent = "\u00d7";
    head.append(heading, close);

    const body = document.createElement("div");
    body.className = "ce-modal-body ce-recovery-body";
    const intro = document.createElement("p");
    intro.id = "ce-recovery-intro";
    intro.className = "ce-recovery-intro";
    intro.textContent = labels.intro;

    const list = document.createElement("div");
    list.className = "ce-recovery-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-labelledby", "ce-recovery-title");
    list.setAttribute("aria-describedby", "ce-recovery-intro");

    const rows: HTMLElement[] = [];
    const applySelection = (index: number, focus: boolean): void => {
      selected = index;
      rows.forEach((row, rowIndex) => {
        const isSelected = rowIndex === index;
        row.setAttribute("aria-selected", String(isSelected));
        row.tabIndex = isSelected ? 0 : -1;
        row.classList.toggle("ce-recovery-item-selected", isSelected);
      });
      if (focus && index >= 0) rows[index].focus({ preventScroll: true });
    };

    entries.forEach((entry, index) => {
      const row = document.createElement("div");
      row.className = "ce-recovery-item";
      row.dataset.entryIndex = String(index);
      row.dataset.entryId = entry.id;
      row.setAttribute("role", "option");
      row.id = `ce-recovery-entry-${index}`;
      row.setAttribute("aria-selected", String(index === selected));
      row.tabIndex = index === selected ? 0 : -1;

      const name = document.createElement("span");
      name.className = "ce-recovery-name";
      const path = typeof entry.path === "string" ? entry.path : "";
      name.textContent = entry.fileName
        ?? (path ? baseName(path) : labels.untitled);
      name.title = path || name.textContent;

      const pathLine = document.createElement("span");
      pathLine.className = "ce-recovery-path";
      pathLine.textContent = path || labels.untitled;
      pathLine.title = path || labels.untitled;

      const meta = document.createElement("span");
      meta.className = "ce-recovery-meta";
      const time = document.createElement("span");
      time.className = "ce-recovery-time";
      time.textContent = formatTimestamp(entry.updatedAt, lang);
      const encoding = document.createElement("span");
      encoding.className = "ce-recovery-encoding";
      encoding.textContent = `${labels.encoding}: ${entry.encoding ?? "UTF-8"}`;
      meta.append(time, encoding);

      row.append(name, pathLine, meta);

      if (entry.exists === false && path !== "") {
        const missing = document.createElement("span");
        missing.className = "ce-recovery-badge";
        missing.textContent = labels.missing;
        row.append(missing);
      }

      row.addEventListener("click", () => applySelection(index, true));
      row.addEventListener("dblclick", () => {
        applySelection(index, false);
        finish({ action: "restore", entry });
      });
      rows.push(row);
      list.append(row);
    });

    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "ce-recovery-empty";
      empty.textContent = labels.empty;
      list.append(empty);
    }

    body.append(intro, list);

    const foot = document.createElement("div");
    foot.className = "ce-modal-foot ce-recovery-actions";
    const restore = makeButton(labels.restore, "ce-primary");
    restore.dataset.action = "restore";
    restore.disabled = entries.length === 0;
    const discard = makeButton(labels.discard, "ce-danger-text");
    discard.dataset.action = "discard";
    discard.disabled = entries.length === 0;
    const discardAll = makeButton(labels.discardAll, "ce-danger-text");
    discardAll.dataset.action = "discard-all";
    discardAll.disabled = entries.length === 0;
    const spacer = document.createElement("div");
    spacer.className = "ce-spacer";
    const cancel = makeButton(labels.cancel);
    cancel.dataset.action = "cancel";
    foot.append(restore, discard, discardAll, spacer, cancel);

    card.append(head, body, foot);
    overlay.appendChild(card);

    const background = [...document.body.children]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .map((element) => ({ element, inert: element.inert }));
    for (const { element } of background) element.inert = true;
    document.body.appendChild(overlay);

    let finished = false;
    const finish = (result: RecoveryDialogResult): void => {
      if (finished) return;
      finished = true;
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", keepFocus, true);
      overlay.remove();
      for (const { element, inert } of background) element.inert = inert;
      activeDialog = false;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(result);
    };

    const selectedEntry = (): RecoveryDialogEntry | undefined =>
      selected >= 0 ? entries[selected] : undefined;

    const focusableElements = (): HTMLElement[] => {
      const nodes = card.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex="0"]',
      );
      return [...nodes].filter((element) => !element.hidden);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      // Background editor/file shortcuts must not observe dialog keys.
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        finish({ action: "cancel" });
        return;
      }
      if (event.key === "Tab") {
        const focusable = focusableElements();
        if (focusable.length === 0) return;
        const current = focusable.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey
          ? (current <= 0 ? focusable.length - 1 : current - 1)
          : (current + 1) % focusable.length;
        event.preventDefault();
        focusable[next].focus({ preventScroll: true });
        return;
      }

      const target = event.target as HTMLElement | null;
      const onRow = target?.dataset.entryIndex !== undefined;
      if (entries.length > 0) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp"
          || event.key === "Home" || event.key === "End") {
          event.preventDefault();
          const next = event.key === "Home"
            ? 0
            : event.key === "End"
              ? entries.length - 1
              : event.key === "ArrowDown"
                ? Math.min(entries.length - 1, selected + 1)
                : Math.max(0, selected - 1);
          applySelection(next, true);
          return;
        }
        if (onRow && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          const entry = selectedEntry();
          if (entry) finish({ action: "restore", entry });
          return;
        }
        if (onRow && event.key === "Delete") {
          event.preventDefault();
          const entry = selectedEntry();
          if (entry) finish({ action: "discard", entry });
        }
      }
    };

    const keepFocus = (event: FocusEvent): void => {
      if (card.contains(event.target as Node)) return;
      const fallback = rows[selected] ?? cancel;
      fallback.focus({ preventScroll: true });
    };

    restore.addEventListener("click", () => {
      const entry = selectedEntry();
      if (entry) finish({ action: "restore", entry });
    });
    discard.addEventListener("click", () => {
      const entry = selectedEntry();
      if (entry) finish({ action: "discard", entry });
    });
    discardAll.addEventListener("click", () => finish({ action: "discard" }));
    cancel.addEventListener("click", () => finish({ action: "cancel" }));
    close.addEventListener("click", () => finish({ action: "cancel" }));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish({ action: "cancel" });
    });

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", keepFocus, true);
    if (rows.length > 0) rows[selected].focus({ preventScroll: true });
    else cancel.focus({ preventScroll: true });
  });
}

function makeButton(label: string, className = ""): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}
