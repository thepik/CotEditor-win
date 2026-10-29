/**
 * External-change conflict dialog (phase B).
 *
 * Shown when the file on disk changed after the editor opened it. The dialog
 * only reports the user's decision; the owner performs the reload/save:
 *
 *   "keepLocal"  keep the editor buffer (the next save overwrites the disk file)
 *   "reload"     discard local state and load the disk version
 *   "saveAs"     write the editor buffer to a new file
 *   "cancel"     keep everything as it is
 *
 * `dirty` selects the wording: dirty documents warn that reload discards
 * edits and that keeping local will overwrite the disk version on the next
 * save; clean documents make reload the default, but still explain the
 * overwrite consequence of keeping the editor copy.
 *
 * Wiring notes for `main.ts` (phase F2):
 *  - call it from the external-change handler with the document's current
 *    dirty flag, then map the decision to `manager.saveDocument(id, "saveAs")`,
 *    `manager.openPath(path)` after `store.remove(id)`, or no-op for cancel.
 */

import "./conflict-dialog.css";
import { getLang, type Lang } from "../lib/i18n";

export type ConflictDecision = "keepLocal" | "reload" | "saveAs" | "cancel";

export interface ConflictDialogOptions {
  fileName: string;
  path?: string | null;
  /** Local buffer has unsaved changes. */
  dirty: boolean;
  lang?: Lang;
  title?: string;
}

interface Labels {
  title: string;
  changed: string;
  dirtyHint: string;
  cleanHint: string;
  warning: string;
  keepLocal: string;
  reload: string;
  saveAs: string;
  cancel: string;
}

let activeDialog = false;

function labelsFor(lang: Lang, fileName: string): Labels {
  if (lang === "zh") {
    return {
      title: "文件已在磁盘上更改",
      changed: `“${fileName}”在打开后被其他程序修改。`,
      dirtyHint: "重新载入会丢弃当前未保存的编辑。另存为会把编辑器内容写入新文件。",
      cleanHint: "当前没有未保存的编辑。重新载入可获取磁盘上的最新版本。",
      warning: "保留本地只会保留编辑器中的内容；下次保存会覆盖磁盘上的新版本。",
      keepLocal: "保留本地",
      reload: "重新载入",
      saveAs: "另存为…",
      cancel: "取消",
    };
  }
  return {
    title: "File changed on disk",
    changed: `“${fileName}” was modified by another program after it was opened.`,
    dirtyHint: "Reload discards the edits that are not saved yet. Save As writes the editor copy to a new file.",
    cleanHint: "The editor has no unsaved changes. Reload loads the latest version from disk.",
    warning: "Keep Local only keeps the editor copy; the next save will overwrite the newer disk version.",
    keepLocal: "Keep Local",
    reload: "Reload",
    saveAs: "Save As…",
    cancel: "Cancel",
  };
}

/**
 * Open the conflict dialog. Concurrent calls resolve to "cancel" so two
 * conflicts cannot stack modals.
 */
export function openConflictDialog(
  options: ConflictDialogOptions,
): Promise<ConflictDecision> {
  if (activeDialog) return Promise.resolve("cancel");
  activeDialog = true;

  const lang = options.lang ?? getLang();
  const labels = labelsFor(lang, options.fileName);
  const previousFocus = document.activeElement as HTMLElement | null;

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ce-modal ce-conflict";
    overlay.setAttribute("role", "presentation");

    const card = document.createElement("div");
    card.className = "ce-modal-card ce-conflict-card";
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "ce-conflict-title");
    card.setAttribute("aria-describedby", "ce-conflict-message ce-conflict-warning");

    const body = document.createElement("div");
    body.className = "ce-conflict-body";
    const icon = document.createElement("div");
    icon.className = "ce-conflict-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "!";

    const copy = document.createElement("div");
    copy.className = "ce-conflict-copy";
    const title = document.createElement("h2");
    title.id = "ce-conflict-title";
    title.textContent = options.title ?? labels.title;
    const message = document.createElement("p");
    message.id = "ce-conflict-message";
    message.textContent = labels.changed;
    const hint = document.createElement("p");
    hint.className = "ce-conflict-hint";
    hint.textContent = options.dirty ? labels.dirtyHint : labels.cleanHint;
    const warning = document.createElement("p");
    warning.id = "ce-conflict-warning";
    warning.className = "ce-conflict-warning";
    warning.textContent = labels.warning;
    copy.append(title, message, hint, warning);

    const path = options.path && options.path !== options.fileName
      ? options.path
      : null;
    if (path) {
      const pathLine = document.createElement("p");
      pathLine.className = "ce-conflict-path";
      pathLine.textContent = path;
      pathLine.title = path;
      copy.append(pathLine);
    }
    body.append(icon, copy);

    const foot = document.createElement("div");
    foot.className = "ce-modal-foot ce-conflict-actions";
    const keepLocal = makeButton(labels.keepLocal, "ce-conflict-keep");
    keepLocal.dataset.decision = "keepLocal";
    const reload = makeButton(labels.reload, "ce-conflict-reload");
    reload.dataset.decision = "reload";
    const saveAs = makeButton(labels.saveAs);
    saveAs.dataset.decision = "saveAs";
    const spacer = document.createElement("div");
    spacer.className = "ce-spacer";
    const cancel = makeButton(labels.cancel);
    cancel.dataset.decision = "cancel";
    foot.append(keepLocal, reload, saveAs, spacer, cancel);

    card.append(body, foot);
    overlay.appendChild(card);

    const background = [...document.body.children]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .map((element) => ({ element, inert: element.inert }));
    for (const { element } of background) element.inert = true;
    document.body.appendChild(overlay);

    let finished = false;
    const finish = (decision: ConflictDecision): void => {
      if (finished) return;
      finished = true;
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", keepFocus, true);
      overlay.remove();
      for (const { element, inert } of background) element.inert = inert;
      activeDialog = false;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(decision);
    };

    const focusable = (): HTMLElement[] => [
      ...card.querySelectorAll<HTMLElement>("button:not([disabled])"),
    ];

    const onKeyDown = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        finish("cancel");
        return;
      }
      if (event.key !== "Tab") return;
      const buttons = focusable();
      if (buttons.length === 0) return;
      const current = buttons.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (current <= 0 ? buttons.length - 1 : current - 1)
        : (current + 1) % buttons.length;
      event.preventDefault();
      buttons[next].focus({ preventScroll: true });
    };

    const keepFocus = (event: FocusEvent): void => {
      if (!card.contains(event.target as Node)) cancel.focus({ preventScroll: true });
    };

    keepLocal.addEventListener("click", () => finish("keepLocal"));
    reload.addEventListener("click", () => finish("reload"));
    saveAs.addEventListener("click", () => finish("saveAs"));
    cancel.addEventListener("click", () => finish("cancel"));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish("cancel");
    });

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", keepFocus, true);
    // Never default to an action that overwrites the disk version. A clean
    // document's reload is safe, so it is the one deliberate exception.
    (options.dirty ? cancel : reload).focus({ preventScroll: true });
  });
}

function makeButton(label: string, className = ""): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}
