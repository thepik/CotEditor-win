/**
 * Line-processing Monaco commands. All ranges are whole, touched lines; an
 * endpoint at column 1 of the next line does not include that line. Overlapping
 * spans are edited once, while selection order/direction is retained.
 */

import type * as monaco from "monaco-editor";
import { monaco as monacoNs, getEditor } from "./monaco-setup";
import {
  sortLines,
  reverseLines,
  removeDuplicateLines,
  removeEmptyLines,
  trimTrailingWhitespace,
  dedentLines,
  indentLines,
  outdentLines,
  shuffleLines,
  splitLines,
  joinLinesRange,
} from "../lib/text-operations";

interface LineSpan {
  startLine: number;
  endLine: number;
  selectionIndexes: number[];
}

interface PlannedEdit {
  range: monaco.Range;
  text: string;
  start: number;
  end: number;
}

/** Offsets relative to an edit's replacement, or original absolute offsets. */
interface SelectionTarget {
  edit?: PlannedEdit;
  anchor: number;
  active: number;
}

function resolveSpans(
  model: monaco.editor.ITextModel,
  selections: monaco.Selection[],
  wholeDoc: boolean,
  mergeAdjacent = false,
): LineSpan[] {
  if (wholeDoc && selections.length === 1 && selections[0].isEmpty()) {
    return [{ startLine: 1, endLine: model.getLineCount(), selectionIndexes: [0] }];
  }
  const spans = selections.map((sel, index) => ({
    startLine: sel.startLineNumber,
    endLine: sel.endLineNumber - (
      sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? 1 : 0
    ),
    selectionIndexes: [index],
  })).sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const merged: LineSpan[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && span.startLine <= previous.endLine + (mergeAdjacent ? 1 : 0)) {
      previous.endLine = Math.max(previous.endLine, span.endLine);
      previous.selectionIndexes.push(...span.selectionIndexes);
    } else {
      merged.push(span);
    }
  }
  return merged;
}

function lineRange(model: monaco.editor.ITextModel, start: number, end: number): monaco.Range {
  return new monacoNs.Range(start, 1, end, model.getLineMaxColumn(end));
}

function planEdit(model: monaco.editor.ITextModel, range: monaco.Range, text: string): PlannedEdit {
  return {
    range, text,
    start: model.getOffsetAt(range.getStartPosition()),
    end: model.getOffsetAt(range.getEndPosition()),
  };
}

function selectionTargets(model: monaco.editor.ITextModel, selections: monaco.Selection[]): SelectionTarget[] {
  return selections.map((sel) => ({
    anchor: model.getOffsetAt(sel.getSelectionStart()),
    active: model.getOffsetAt(sel.getPosition()),
  }));
}

/** Store cursor state IN the edit, not with setSelections afterwards (redo). */
function executePlan(
  editor: monaco.editor.IStandaloneCodeEditor,
  model: monaco.editor.ITextModel,
  actionId: string,
  edits: PlannedEdit[],
  targets: SelectionTarget[],
): void {
  // Return before pushing a stop: a no-op (blocked move, already-sorted text)
  // must not split the user's running typing group into two undo entries.
  if (edits.length === 0) return;
  editor.pushUndoStop();
  edits.sort((a, b) => a.start - b.start);
  const newStarts = new Map<PlannedEdit, number>();
  let delta = 0;
  for (const edit of edits) {
    newStarts.set(edit, edit.start + delta);
    delta += edit.text.length - (edit.end - edit.start);
  }
  const mapUnchanged = (offset: number): number => {
    let shift = 0;
    for (const edit of edits) {
      if (offset <= edit.start) break;
      if (offset < edit.end) return edit.start + shift + Math.min(offset - edit.start, edit.text.length);
      shift += edit.text.length - (edit.end - edit.start);
    }
    return offset + shift;
  };
  editor.executeEdits(actionId, edits.map(({ range, text }) => ({ range, text })), () =>
    targets.map((target) => {
      const start = target.edit ? newStarts.get(target.edit)! : 0;
      const anchor = model.getPositionAt(target.edit ? start + target.anchor : mapUnchanged(target.anchor));
      const active = model.getPositionAt(target.edit ? start + target.active : mapUnchanged(target.active));
      return monacoNs.Selection.fromPositions(anchor, active);
    }),
  );
  editor.pushUndoStop();
  editor.focus();
}

/** Sort/reverse/etc. retain the legacy single-caret whole-document fallback. */
function applyTransform(
  fn: (text: string, model: monaco.editor.ITextModel) => string,
  actionId: string,
  wholeDoc = true,
): void {
  const editor = getEditor();
  const model = editor?.getModel();
  const selections = editor?.getSelections();
  if (!editor || !model || !selections) return;
  const targets = selectionTargets(model, selections);
  const edits: PlannedEdit[] = [];
  for (const span of resolveSpans(model, selections, wholeDoc)) {
    // Include a following delimiter: a selected empty last content line must
    // not be mistaken by the pure transform for the document's terminal EOL.
    const hasFollowingLine = span.endLine < model.getLineCount();
    const range = hasFollowingLine
      ? new monacoNs.Range(span.startLine, 1, span.endLine + 1, 1)
      : lineRange(model, span.startLine, span.endLine);
    const text = model.getValueInRange(range);
    const result = fn(text, model);
    if (result === text) continue;
    const edit = planEdit(model, range, result);
    edits.push(edit);
    const selectedLength = hasFollowingLine && result.endsWith(model.getEOL())
      ? result.length - model.getEOL().length : result.length;
    for (const index of span.selectionIndexes) {
      const reversed = selections[index].getDirection() === monacoNs.SelectionDirection.RTL;
      targets[index] = {
        edit,
        anchor: reversed ? selectedLength : 0,
        active: reversed ? 0 : selectedLength,
      };
    }
  }
  executePlan(editor, model, actionId, edits, targets);
}

type LineEdit = "up" | "down" | "duplicate" | "delete";

/** Swap only a block and its neighbour, insert copies, or remove local lines. */
function applyLineEdit(operation: LineEdit, actionId: string): void {
  const editor = getEditor();
  const model = editor?.getModel();
  const selections = editor?.getSelections();
  if (!editor || !model || !selections) return;
  const targets = selectionTargets(model, selections);
  const edits: PlannedEdit[] = [];
  const eol = model.getEOL();
  const lineCount = model.getLineCount();
  const moving = operation === "up" || operation === "down";
  // A terminal EOL is not a blank content line to swap into the document.
  const lastContentLine = lineCount > 1 && model.getLineContent(lineCount) === "" ? lineCount - 1 : lineCount;
  for (const span of resolveSpans(model, selections, false, moving || operation === "delete")) {
    const start = span.startLine;
    const end = moving ? Math.min(span.endLine, lastContentLine) : span.endLine;
    if (end < start || (operation === "up" && start === 1) ||
        (operation === "down" && end === lastContentLine)) continue;
    const range = lineRange(model, start, end);
    const blockStart = model.getOffsetAt(range.getStartPosition());
    let edit: PlannedEdit;
    let selectionOffset = 0;
    if (operation === "delete") {
      // Consume the following EOL, except at EOF where the preceding EOL must
      // be consumed instead. Deleting every line leaves Monaco's empty line.
      const deleteRange = end < lineCount
        ? new monacoNs.Range(start, 1, end + 1, 1)
        : start > 1
          ? new monacoNs.Range(start - 1, model.getLineMaxColumn(start - 1), end, model.getLineMaxColumn(end))
          : range;
      edit = planEdit(model, deleteRange, "");
      if (edit.start === edit.end) continue;
    } else {
      const block = model.getValueInRange(range);
      if (operation === "duplicate") {
        edit = planEdit(model, monacoNs.Range.fromPositions(range.getEndPosition()), eol + block);
        selectionOffset = eol.length;
      } else if (operation === "up") {
        edit = planEdit(model, lineRange(model, start - 1, end), block + eol + model.getLineContent(start - 1));
      } else {
        const prefix = model.getLineContent(end + 1) + eol;
        edit = planEdit(model, lineRange(model, start, end + 1), prefix + block);
        selectionOffset = prefix.length;
      }
    }
    edits.push(edit);
    for (const index of span.selectionIndexes) {
      const original = targets[index];
      targets[index] = operation === "delete"
        ? { edit, anchor: 0, active: 0 }
        : {
          edit,
          anchor: selectionOffset + original.anchor - blockStart,
          active: selectionOffset + original.active - blockStart,
        };
    }
  }
  executePlan(editor, model, actionId, edits, targets);
}

function indentationUnit(model: monaco.editor.ITextModel): string {
  const { insertSpaces, tabSize } = model.getOptions();
  return insertSpaces ? " ".repeat(tabSize) : "\t";
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
      run: () => applyLineEdit("up", "moveLineUp"),
      keybindings: [
        monacoNs.KeyMod.CtrlCmd | monacoNs.KeyMod.Shift | monacoNs.KeyCode.UpArrow,
      ],
    },
    {
      id: "coteditor.moveLineDown",
      label: "Move Line Down",
      run: () => applyLineEdit("down", "moveLineDown"),
      keybindings: [
        monacoNs.KeyMod.CtrlCmd | monacoNs.KeyMod.Shift | monacoNs.KeyCode.DownArrow,
      ],
    },
    {
      id: "coteditor.duplicateLine",
      label: "Duplicate Line",
      run: () => applyLineEdit("duplicate", "duplicateLine"),
      keybindings: [monacoNs.KeyMod.CtrlCmd | monacoNs.KeyMod.Shift | monacoNs.KeyCode.KeyD],
    },
    {
      id: "coteditor.deleteLine",
      label: "Delete Line",
      run: () => applyLineEdit("delete", "deleteLine"),
      keybindings: [monacoNs.KeyMod.CtrlCmd | monacoNs.KeyMod.Shift | monacoNs.KeyCode.KeyK],
    },
    {
      id: "coteditor.joinLines",
      label: "Join Lines",
      run: () => applyTransform((text) =>
        joinLinesRange(text, 1, splitLines(text).lines.length)?.text ?? text,
      "joinLines", false),
      keybindings: [monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.KeyJ],
    },
    {
      id: "coteditor.indentLines",
      label: "Indent Lines",
      run: () => applyTransform((t, model) => indentLines(t, indentationUnit(model)), "indentLines"),
      keybindings: [monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.BracketRight],
    },
    {
      id: "coteditor.outdentLines",
      label: "Outdent Lines",
      run: () => applyTransform((t, model) => outdentLines(t, indentationUnit(model), model.getOptions().tabSize), "outdentLines"),
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
