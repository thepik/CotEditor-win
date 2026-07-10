/**
 * Line-level text operations (PLAN §阶段4, §十).
 *
 * Ported from CotEditor's `Packages/EditorCore/Sources/TextEditing/String+LineProcessing.swift`.
 * These operate on plain strings and are exposed as Monaco commands so they
 * can be bound to menu items / shortcuts.
 *
 * All functions take a string and return a transformed string; the command
 * wrappers in `ui/` apply them to the current selection (or the whole document
 * when nothing is selected) and push the edit onto Monaco's undo stack.
 */

/** Split `text` into lines, preserving the trailing newline's presence. */
export function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === "") return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith("\n") || text.endsWith("\r");
  const lines = text.split(/\r\n|\r|\n/);
  // split() produces a trailing "" after a final newline; drop it.
  if (lines.length > 0 && lines[lines.length - 1] === "" && trailingNewline) {
    lines.pop();
  }
  return { lines, trailingNewline };
}

export function joinLines(lines: string[], trailingNewline: boolean): string {
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/** Sort lines ascending (case-sensitive, locale-unaware - byte order). */
export function sortLines(text: string, ascending: boolean = true): string {
  const { lines, trailingNewline } = splitLines(text);
  lines.sort();
  if (!ascending) lines.reverse();
  return joinLines(lines, trailingNewline);
}

/** Reverse the order of lines. */
export function reverseLines(text: string): string {
  const { lines, trailingNewline } = splitLines(text);
  lines.reverse();
  return joinLines(lines, trailingNewline);
}

/** Remove duplicate lines, preserving first occurrence order. */
export function removeDuplicateLines(text: string): string {
  const { lines, trailingNewline } = splitLines(text);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (!seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  }
  return joinLines(out, trailingNewline);
}

/** Remove lines that are empty or whitespace-only. */
export function removeEmptyLines(text: string): string {
  const { lines, trailingNewline } = splitLines(text);
  return joinLines(
    lines.filter((l) => l.trim() !== ""),
    trailingNewline,
  );
}

/** Remove trailing whitespace from every line. */
export function trimTrailingWhitespace(text: string): string {
  const { lines, trailingNewline } = splitLines(text);
  return joinLines(
    lines.map((l) => l.replace(/\s+$/, "")),
    trailingNewline,
  );
}

/** Remove leading whitespace common to all selected lines (left-dedent). */
export function dedentLines(text: string): string {
  const { lines, trailingNewline } = splitLines(text);
  if (lines.length === 0) return text;
  const minIndent = lines
    .filter((l) => l.trim() !== "")
    .reduce((min, l) => {
      const indent = l.match(/^[ \t]*/)?.[0] ?? "";
      return indent.length < min.length ? indent : min;
    }, lines.find((l) => l.trim() !== "")?.match(/^[ \t]*/)?.[0] ?? "");
  return joinLines(
    lines.map((l) => l.slice(minIndent.length)),
    trailingNewline,
  );
}

/** Indent every line by one tab (or `unit` if supplied). */
export function indentLines(text: string, unit: string = "\t"): string {
  const { lines, trailingNewline } = splitLines(text);
  return joinLines(lines.map((l) => unit + l), trailingNewline);
}

/** Outdent every line by one tab/space level (best effort). */
export function outdentLines(text: string, unit: string = "\t"): string {
  const { lines, trailingNewline } = splitLines(text);
  return joinLines(
    lines.map((l) => (l.startsWith(unit) ? l.slice(unit.length) : l.replace(/^[ \t]/, ""))),
    trailingNewline,
  );
}

/**
 * Move the line(s) spanning `range` up by one line.
 *
 * Returns the new text and the shifted selection range, or null when the line
 * is already at the top of the document.
 *
 * Ported from CotEditor's `moveLineUp(in:)`. The MVP operates on a single
 * selection (no multi-range); the surrounding line is swapped with the one
 * above it. Line endings are preserved per-line.
 */
export function moveLineUp(
  text: string,
  startLine: number,
  endLine: number,
): { text: string; selStart: number; selEnd: number } | null {
  if (startLine <= 1) return null;
  const { lines, trailingNewline } = splitLines(text);
  // `lines` is 0-indexed; startLine/endLine are 1-based.
  const s = startLine - 1;
  const e = endLine - 1;
  if (e >= lines.length) return null;

  // The block of lines to move.
  const block = lines.slice(s, e + 1);
  // The single line above to swap with.
  const above = lines[s - 1];

  // Swap positions: above moves below the block.
  const moved = lines.slice(0, s - 1);
  moved.push(...block, above);
  moved.push(...lines.slice(e + 1));

  const newText = joinLines(moved, trailingNewline);

  // Selection shifts up by the length of the above line + its newline.
  // Compute absolute offsets in the new text.
  const selStart = offsetOfLine(moved, s - 1);
  const selEnd = offsetOfLine(moved, e) + block[block.length - 1].length;
  return { text: newText, selStart, selEnd };
}

/**
 * Move the line(s) spanning `range` down by one line.
 *
 * Returns the new text and the shifted selection range, or null when the line
 * is already at the bottom of the document.
 */
export function moveLineDown(
  text: string,
  startLine: number,
  endLine: number,
): { text: string; selStart: number; selEnd: number } | null {
  const { lines, trailingNewline } = splitLines(text);
  const s = startLine - 1;
  const e = endLine - 1;
  if (e >= lines.length - 1) return null;

  const block = lines.slice(s, e + 1);
  const below = lines[e + 1];

  const moved = lines.slice(0, s);
  moved.push(below, ...block);
  moved.push(...lines.slice(e + 2));

  const newText = joinLines(moved, trailingNewline);
  const selStart = offsetOfLine(moved, s + 1);
  const selEnd = offsetOfLine(moved, e + 1) + block[block.length - 1].length;
  return { text: newText, selStart, selEnd };
}

/** Return the character offset where `lineIndex` (0-based) begins in `lines`. */
function offsetOfLine(lines: string[], lineIndex: number): number {
  if (lineIndex <= 0) return 0;
  let offset = 0;
  for (let i = 0; i < lineIndex && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for the newline
  }
  return offset;
}

/** Shuffle the lines of `text` randomly. */
export function shuffleLines(text: string): string {
  const { lines, trailingNewline } = splitLines(text);
  // Fisher-Yates shuffle.
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }
  return joinLines(lines, trailingNewline);
}

/** Duplicate the line(s) spanning the given 1-based line range, inserting below. */
export function duplicateLines(
  text: string,
  startLine: number,
  endLine: number,
): { text: string; selStart: number; selEnd: number } | null {
  const { lines, trailingNewline } = splitLines(text);
  const s = startLine - 1;
  const e = endLine - 1;
  if (s < 0 || e >= lines.length) return null;

  const block = lines.slice(s, e + 1);
  const inserted = lines.slice(0, e + 1).concat(block, lines.slice(e + 1));
  const newText = joinLines(inserted, trailingNewline);

  // Selection lands on the duplicated block.
  const selStart = offsetOfLine(inserted, e + 1);
  const selEnd = selStart + block.join("\n").length + (block.length > 1 ? block.length - 1 : 0);
  return { text: newText, selStart, selEnd };
}

/** Delete the line(s) spanning the given 1-based line range. Returns null if out of range. */
export function deleteLines(
  text: string,
  startLine: number,
  endLine: number,
): { text: string; selStart: number; selEnd: number } | null {
  const { lines, trailingNewline } = splitLines(text);
  const s = startLine - 1;
  const e = endLine - 1;
  if (s < 0 || e >= lines.length) return null;

  const kept = lines.slice(0, s).concat(lines.slice(e + 1));
  const newText = joinLines(kept, trailingNewline);

  // Cursor lands at the start of where the deleted block was (now the next line, or end).
  const newLines = splitLines(newText).lines;
  const selLine = Math.min(s, newLines.length === 0 ? 0 : newLines.length - 1);
  const selStart = offsetOfLine(newLines, selLine);
  return { text: newText, selStart, selEnd: selStart };
}

/**
 * Join the lines within the given 1-based line range, collapsing inter-line
 * whitespace to a single space.
 */
export function joinLinesRange(
  text: string,
  startLine: number,
  endLine: number,
): { text: string; selStart: number; selEnd: number } | null {
  const { lines, trailingNewline } = splitLines(text);
  const s = startLine - 1;
  const e = endLine - 1;
  if (s < 0 || e >= lines.length || e <= s) return null;

  const block = lines.slice(s, e + 1);
  const joined = block.join(" ");
  const replaced = lines.slice(0, s).concat([joined], lines.slice(e + 1));
  const newText = joinLines(replaced, trailingNewline);

  const selStart = offsetOfLine(replaced, s);
  const selEnd = selStart + joined.length;
  return { text: newText, selStart, selEnd };
}
