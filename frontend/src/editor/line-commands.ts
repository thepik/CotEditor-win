/**
 * Line-processing Monaco commands (PLAN §阶段4).
 *
 * Wires the pure functions in `lib/text-operations` to Monaco editor actions so
 * they can be invoked via menu items or keyboard shortcuts.
 *
 * Each command:
 *  - operates on the whole document when there is no selection (mirrors
 *    CotEditor's `sortLinesAscending` / `reverseLines` behaviour);
 *  - otherwise operates on the lines spanned by the first selection;
 *  - pushes the edit onto Monaco's undo stack via `executeEdits` and restores a
 *    sensible selection (collapsed caret for transforms, shifted range for
 *    moves).
 *
 * Shortcuts follow CotEditor's Main.storyboard conventions, translated to
 * Windows (Ctrl instead of Cmd):
 *  - Move Up    : Ctrl+Shift+Up      (CotEditor: ⌃⌘↑)
 *  - Move Down  : Ctrl+Shift+Down    (CotEditor: ⌃⌘↓)
 *  - Duplicate  : Ctrl+Shift+D       (CotEditor: ⌘D)
 *  - Delete Line: Ctrl+Shift+K       (CotEditor: ⌘⇧⌫)
 *  - Join Lines : Ctrl+J             (CotEditor: ⌘J)
 *  - Sort       : F5                 (VS Code convention, no default clash)
 *  - Reverse    : Shift+F5
 *  - Dedupe     : Ctrl+Shift+F5
 */

import type * as monaco from "monaco-editor";
import { monaco as monacoNs, getEditor, getModel } from "./monaco-setup";
import {
  sortLines,
  reverseLines,
  removeDuplicateLines,
  removeEmptyLines,
  trimTrailingWhitespace,
  dedentLines,
  indentLines,
  outdentLines,
  moveLineUp,
  moveLineDown,
  shuffleLines,
  duplicateLines,
  deleteLines,
  joinLinesRange,
} from "../lib/text-operations";

/** Context object describing the line span a command should act on. */
interface LineSpan {
  text: string;
  startLine: number;
  endLine: number;
  /** Monaco range covering exactly the spanned lines (for executeEdits). */
  range: monaco.IRange;
  /** Whether the selection was empty (whole-doc fallback applies). */
  wholeDoc: boolean;
}

/**
 * Resolve the span of text a line command should transform.
 *
 * If the selection is empty, the whole document is used; otherwise the lines
 * touched by the primary selection. The returned `text` is the substring to
 * transform, and `range` is the Monaco range to replace with the result.
 */
function resolveSpan(): LineSpan | null {
  const editor = getEditor();
  const model = getModel();
  if (!editor || !model) return null;

  const sel = editor.getSelection();
  if (!sel) return null;

  if (sel.isEmpty()) {
    const lineCount = model.getLineCount();
    const fullRange = model.getFullModelRange();
    return {
      text: model.getValue(),
      startLine: 1,
      endLine: lineCount,
      range: fullRange,
      wholeDoc: true,
    };
  }

  return {
    text: model.getValueInRange(sel),
    startLine: sel.startLineNumber,
    endLine: sel.endLineNumber,
    range: {
      startLineNumber: sel.startLineNumber,
      startColumn: 1,
      endLineNumber: sel.endLineNumber,
      endColumn: model.getLineMaxColumn(sel.endLineNumber),
    },
    wholeDoc: false,
  };
}

/**
 * Apply a pure string transform to the current span and push it as a single
 * undoable edit, then restore the selection to the span.
 *
 * Used for sort/reverse/dedupe/trim where the output length may differ from the
 * input and we want the whole transformed region selected afterwards.
 */
function applyTransform(
  fn: (text: string) => string,
  actionId: string,
): void {
  const editor = getEditor();
  const model = getModel();
  const span = resolveSpan();
  if (!editor || !model || !span) return;

  const result = fn(span.text);
  if (result === span.text) return; // no-op

  editor.executeEdits(actionId, [{ range: span.range, text: result }]);
  // Select the replaced region.
  const newEndLine = span.range.startLineNumber + result.split(/\r\n|\r|\n/).length - 1;
  editor.setSelection({
    startLineNumber: span.range.startLineNumber,
    startColumn: 1,
    endLineNumber: newEndLine,
    endColumn: model.getLineMaxColumn(newEndLine),
  });
  editor.focus();
}

/**
 * Apply a move/duplicate/delete that returns a whole-text replacement plus a
 * shifted selection (absolute character offsets within the new text).
 */
function applyWholeReplace(
  fn: (text: string, s: number, e: number) =>
    { text: string; selStart: number; selEnd: number } | null,
  actionId: string,
): void {
  const editor = getEditor();
  const model = getModel();
  if (!editor || !model) return;

  const sel = editor.getSelection();
  if (!sel) return;
  const startLine = sel.isEmpty() ? sel.startLineNumber : sel.startLineNumber;
  const endLine = sel.isEmpty() ? sel.startLineNumber : sel.endLineNumber;
  const fullText = model.getValue();
  const res = fn(fullText, startLine, endLine);
  if (!res) return;

  const fullRange = model.getFullModelRange();
  editor.executeEdits(actionId, [{ range: fullRange, text: res.text }]);

  // Convert absolute offsets to Monaco positions.
  const startPos = model.getPositionAt(res.selStart);
  const endPos = model.getPositionAt(res.selEnd);
  editor.setSelection({
    startLineNumber: startPos.lineNumber,
    startColumn: startPos.column,
    endLineNumber: endPos.lineNumber,
    endColumn: endPos.column,
  });
  editor.focus();
}

/** Register every line command and its keybinding on the editor instance. */
export function registerLineCommands(): void {
  const editor = getEditor();
  if (!editor) return;

  const commands: Array<{
    id: string;
    run: () => void;
    keybindings?: number[];
    label: string;
  }> = [
    {
      id: "coteditor.sortLinesAscending",
      label: "Sort Lines",
      run: () => applyTransform((t) => sortLines(t, true), "sortLines"),
      keybindings: [monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.F5],
    },
    {
      id: "coteditor.sortLinesDescending",
      label: "Sort Lines Descending",
      run: () => applyTransform((t) => sortLines(t, false), "sortLinesDesc"),
    },
    {
      id: "coteditor.reverseLines",
      label: "Reverse Lines",
      run: () => applyTransform(reverseLines, "reverseLines"),
      keybindings: [monacoNs.KeyMod.CtrlCmd | monacoNs.KeyMod.Shift | monacoNs.KeyCode.F5],
    },
    {
      id: "coteditor.shuffleLines",
      label: "Shuffle Lines",
      run: () => applyTransform(shuffleLines, "shuffleLines"),
    },
    {
      id: "coteditor.deleteDuplicateLines",
      label: "Delete Duplicate Lines",
      run: () => applyTransform(removeDuplicateLines, "deleteDuplicateLines"),
      keybindings: [monacoNs.KeyMod.CtrlCmd | monacoNs.KeyMod.Shift | monacoNs.KeyMod.Alt | monacoNs.KeyCode.F5],
    },
    {
      id: "coteditor.removeEmptyLines",
      label: "Remove Empty Lines",
      run: () => applyTransform(removeEmptyLines, "removeEmptyLines"),
    },
    {
      id: "coteditor.trimTrailingWhitespace",
      label: "Trim Trailing Whitespace",
      run: () => applyTransform(trimTrailingWhitespace, "trimTrailingWhitespace"),
    },
    {
      id: "coteditor.moveLineUp",
      label: "Move Line Up",
      run: () => applyWholeReplace(moveLineUp, "moveLineUp"),
      keybindings: [
        monacoNs.KeyMod.CtrlCmd | monacoNs.KeyMod.Shift | monacoNs.KeyCode.UpArrow,
      ],
    },
    {
      id: "coteditor.moveLineDown",
      label: "Move Line Down",
      run: () => applyWholeReplace(moveLineDown, "moveLineDown"),
      keybindings: [
        monacoNs.KeyMod.CtrlCmd | monacoNs.KeyMod.Shift | monacoNs.KeyCode.DownArrow,
      ],
    },
    {
      id: "coteditor.duplicateLine",
      label: "Duplicate Line",
      run: () => applyWholeReplace(duplicateLines, "duplicateLine"),
      keybindings: [monacoNs.KeyMod.CtrlCmd | monacoNs.KeyMod.Shift | monacoNs.KeyCode.KeyD],
    },
    {
      id: "coteditor.deleteLine",
      label: "Delete Line",
      run: () => applyWholeReplace(deleteLines, "deleteLine"),
      keybindings: [monacoNs.KeyMod.CtrlCmd | monacoNs.KeyMod.Shift | monacoNs.KeyCode.KeyK],
    },
    {
      id: "coteditor.joinLines",
      label: "Join Lines",
      run: () => applyWholeReplace(joinLinesRange, "joinLines"),
      keybindings: [monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.KeyJ],
    },
    {
      id: "coteditor.indentLines",
      label: "Indent Lines",
      run: () => applyTransform((t) => indentLines(t), "indentLines"),
      keybindings: [monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.BracketRight],
    },
    {
      id: "coteditor.outdentLines",
      label: "Outdent Lines",
      run: () => applyTransform((t) => outdentLines(t), "outdentLines"),
      keybindings: [monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.BracketLeft],
    },
    {
      id: "coteditor.dedentLines",
      label: "Dedent Lines",
      run: () => applyTransform(dedentLines, "dedentLines"),
    },
  ];

  for (const c of commands) {
    editor.addAction({
      id: c.id,
      label: c.label,
      keybindings: c.keybindings,
      run: c.run,
    });
  }
}
