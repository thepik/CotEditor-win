/**
 * Find panel wrapper.
 *
 * Monaco ships a built-in find widget (Ctrl+F / Ctrl+H) that covers regex,
 * case-sensitivity, whole-word, and cyclic search (PLAN §阶段7). This module
 * is a thin facade so callers don't reach into Monaco directly, and binds
 * Ctrl+Shift+H to open the multiple-replace panel.
 */

import { getEditor } from "../editor/monaco-setup";
import { openMultipleReplacePanel } from "./multiple-replace-ui";

/** Open Monaco's built-in find widget. */
export function openFind(): void {
  getEditor()?.getAction("actions.find")?.run();
}

/** Open the replace variant of the find widget. */
export function openReplace(): void {
  getEditor()?.getAction("editor.action.startFindReplaceAction")?.run();
}

/** Register Ctrl+Shift+H to open the multiple-replace panel. */
export function registerFindShortcuts(): void {
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "h") {
      e.preventDefault();
      openMultipleReplacePanel();
    }
  });
}
