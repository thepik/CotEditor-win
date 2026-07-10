/**
 * Snippet template engine (PLAN §阶段6, §十).
 *
 * Ported from CotEditor's `CotEditor/Sources/Models/Snippet/Snippet.swift`
 * and `Tokenizer.swift`. Two template variables are supported:
 *
 *  - `<<<SELECTION>>>` - replaced by the currently-selected text (or empty)
 *  - `<<<CURSOR>>>`    - marks a final caret position. After insertion all
 *                        cursors are placed at these positions (multi-cursor).
 *
 * Indentation is preserved: every line of the inserted text after the first is
 * indented to match the indentation of the line where insertion begins.
 *
 * The tokenizer splits the template into literal text segments and token
 * segments; `insertSnippet` applies it against an editor instance.
 */

import type * as monaco from "monaco-editor";
import { monaco as monacoNs } from "../editor/monaco-setup";

export type TokenType = "text" | "selection" | "cursor";

interface Token {
  type: TokenType;
  value: string; // literal text for "text", empty for tokens
}

// Template marker literals documented here for reference; the tokenizer
// matches them via the regex below.
//   <<<SELECTION>>>  -> replaced by the currently-selected text
//   <<<CURSOR>>>     -> marks a final caret position

/**
 * Tokenize a snippet template string.
 *
 * Ported from Tokenizer.swift: scan for `<<<...>>>` markers, emit either a
 * literal text run or a typed token. Unknown markers are emitted as literal
 * text (so a stray `<<<FOO>>>` is inserted verbatim rather than dropped).
 */
export function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  const re = /<<<(SELECTION|CURSOR)>>>/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(template)) !== null) {
    if (m.index > last) {
      tokens.push({ type: "text", value: template.slice(last, m.index) });
    }
    tokens.push({ type: m[1] === "SELECTION" ? "selection" : "cursor", value: "" });
    last = m.index + m[0].length;
  }
  if (last < template.length) {
    tokens.push({ type: "text", value: template.slice(last) });
  }
  return tokens;
}

/**
 * Expand a tokenized snippet for insertion at a given indentation.
 *
 * `selection` is substituted for `<<<SELECTION>>>`; the positions of every
 * `<<<CURSOR>>>` (in source-string order) are returned so the caller can place
 * multi-cursors. When there are no cursor tokens, a single caret is placed at
 * the end of the inserted text.
 *
 * `indent` is the leading whitespace to apply to each wrapped line.
 */
export function expandSnippet(
  tokens: Token[],
  selection: string,
  indent: string,
): { text: string; cursorOffsets: number[] } {
  let text = "";
  const cursorOffsets: number[] = [];

  for (const tok of tokens) {
    if (tok.type === "text") {
      // Re-indent continuation lines: split on newlines and prefix each
      // non-first line with `indent`.
      const lines = tok.value.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) text += "\n" + indent;
        text += lines[i];
      }
    } else if (tok.type === "selection") {
      // The selection may itself be multiline; re-indent it too.
      const lines = selection.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) text += "\n" + indent;
        text += lines[i];
      }
    } else {
      // cursor: record position, emit nothing.
      cursorOffsets.push(text.length);
    }
  }

  if (cursorOffsets.length === 0) {
    cursorOffsets.push(text.length);
  }
  return { text, cursorOffsets };
}

/**
 * Insert a snippet into a Monaco editor at the current selection(s).
 *
 * For the MVP we handle a single primary selection; multi-cursor support means
 * the same expansion is applied at each selection (each gets its own indent).
 */
export function insertSnippet(
  editor: monaco.editor.ICodeEditor,
  template: string,
): void {
  const selections = editor.getSelections();
  if (!selections || selections.length === 0) return;

  const model = editor.getModel();
  if (!model) return;

  const tokens = tokenize(template);
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  const cursorPositions: monaco.Position[] = [];

  for (const sel of selections) {
    const selectionText = model.getValueInRange(sel);
    const line = sel.startLineNumber;
    const lineContent = model.getLineContent(line);
    const indent = lineContent.match(/^[ \t]*/)?.[0] ?? "";

    const { text, cursorOffsets } = expandSnippet(tokens, selectionText, indent);

    edits.push({
      range: sel,
      text,
      forceMoveMarkers: true,
    });

    // Map each cursor offset (relative to inserted text start) back to a
    // Monaco position. We compute column = startColumn + offset chars, but
    // only approximately handle embedded newlines (good enough for MVP).
    let row = 0;
    let col = 0;
    let consumed = 0;
    for (const off of cursorOffsets) {
      while (consumed < off) {
        const ch = text[consumed];
        if (ch === "\n") {
          row++;
          col = 0;
        } else {
          col++;
        }
        consumed++;
      }
      cursorPositions.push(
        new monacoNs.Position(
          sel.startLineNumber + row,
          sel.startColumn + col,
        ),
      );
    }
  }

  const resultingSelections: monaco.Selection[] = cursorPositions.map(
    (p) =>
      new monacoNs.Selection(
        p.lineNumber,
        p.column,
        p.lineNumber,
        p.column,
      ),
  );

  model.pushEditOperations(
    editor.getSelections() ?? [],
    edits,
    () => resultingSelections,
  );

  editor.setSelections(resultingSelections);
  editor.focus();
}
