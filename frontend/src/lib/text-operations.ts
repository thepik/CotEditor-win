/**
 * Pure line-level text operations. Uniform LF/CRLF/CR endings and the terminal
 * newline are retained. Monaco commands apply these to whole-line ranges.
 */

/** Split content lines, keeping the terminal newline separate from content. */
export function splitLines(text: string): { lines: string[]; trailingNewline: boolean; eol: string } {
  const eol = text.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  if (text === "") return { lines: [], trailingNewline: false, eol };
  const trailingNewline = text.endsWith("\n") || text.endsWith("\r");
  const lines = text.split(/\r\n|\r|\n/);
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline, eol };
}

export function joinLines(lines: string[], trailingNewline: boolean, eol = "\n"): string {
  return lines.length === 0 ? "" : lines.join(eol) + (trailingNewline ? eol : "");
}

/** Sort lines ascending (case-sensitive, locale-unaware). */
export function sortLines(text: string, ascending = true): string {
  const { lines, trailingNewline, eol } = splitLines(text);
  lines.sort();
  if (!ascending) lines.reverse();
  return joinLines(lines, trailingNewline, eol);
}

export function reverseLines(text: string): string {
  const { lines, trailingNewline, eol } = splitLines(text);
  return joinLines(lines.reverse(), trailingNewline, eol);
}

/** Remove duplicate lines, preserving first occurrence order. */
export function removeDuplicateLines(text: string): string {
  const { lines, trailingNewline, eol } = splitLines(text);
  return joinLines([...new Set(lines)], trailingNewline, eol);
}

export function removeEmptyLines(text: string): string {
  const { lines, trailingNewline, eol } = splitLines(text);
  return joinLines(lines.filter((line) => line.trim() !== ""), trailingNewline, eol);
}

export function trimTrailingWhitespace(text: string): string {
  const { lines, trailingNewline, eol } = splitLines(text);
  return joinLines(lines.map((line) => line.replace(/\s+$/, "")), trailingNewline, eol);
}

/** Remove the minimum leading indentation without slicing non-whitespace. */
export function dedentLines(text: string): string {
  const { lines, trailingNewline, eol } = splitLines(text);
  const indents = lines.filter((line) => line.trim() !== "")
    .map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0);
  const length = indents.reduce((min, indent) => Math.min(min, indent), indents[0] ?? 0);
  return joinLines(lines.map((line) => line.replace(/^[ \t]*/, (indent) => indent.slice(length))), trailingNewline, eol);
}

/** Indent content lines, including a completely empty buffer. */
export function indentLines(text: string, unit = "\t"): string {
  const { lines, trailingNewline, eol } = splitLines(text);
  return joinLines((text === "" ? [""] : lines).map((line) => unit + line), trailingNewline, eol);
}

/** Remove up to one visual indentation level (tabs advance to tab stops). */
export function outdentLines(text: string, unit = "\t", tabSize = unit === "\t" ? 4 : unit.length): string {
  const { lines, trailingNewline, eol } = splitLines(text);
  const size = Math.max(1, tabSize);
  return joinLines(lines.map((line) => {
    let column = 0;
    let index = 0;
    while (index < line.length && column < size && (line[index] === " " || line[index] === "\t")) {
      column += line[index] === "\t" ? size - column % size : 1;
      index++;
    }
    return line.slice(index);
  }), trailingNewline, eol);
}

interface LineResult {
  text: string;
  selStart: number;
  selEnd: number;
}

function validRange(lines: string[], startLine: number, endLine: number): boolean {
  return Number.isInteger(startLine) && Number.isInteger(endLine) &&
    startLine >= 1 && endLine >= startLine && endLine <= lines.length;
}

/** Offset of a zero-based content line, measured in UTF-16 including the EOL. */
function offsetOfLine(lines: string[], lineIndex: number, eol: string): number {
  let offset = 0;
  for (let index = 0; index < lineIndex && index < lines.length; index++) {
    offset += lines[index].length + eol.length;
  }
  return offset;
}

/** Move a whole 1-based line block up; the terminal EOL stays at EOF. */
export function moveLineUp(text: string, startLine: number, endLine: number): LineResult | null {
  const { lines, trailingNewline, eol } = splitLines(text);
  if (!validRange(lines, startLine, endLine) || startLine === 1) return null;
  const start = startLine - 1;
  const block = lines.slice(start, endLine);
  const moved = lines.slice(0, start - 1).concat(block, [lines[start - 1]], lines.slice(endLine));
  const selStart = offsetOfLine(moved, start - 1, eol);
  return {
    text: joinLines(moved, trailingNewline, eol),
    selStart,
    selEnd: selStart + block.join(eol).length,
  };
}

export function moveLineDown(text: string, startLine: number, endLine: number): LineResult | null {
  const { lines, trailingNewline, eol } = splitLines(text);
  if (!validRange(lines, startLine, endLine) || endLine === lines.length) return null;
  const start = startLine - 1;
  const block = lines.slice(start, endLine);
  const moved = lines.slice(0, start).concat([lines[endLine]], block, lines.slice(endLine + 1));
  const selStart = offsetOfLine(moved, start + 1, eol);
  return {
    text: joinLines(moved, trailingNewline, eol),
    selStart,
    selEnd: selStart + block.join(eol).length,
  };
}

/** Shuffle using Fisher-Yates. */
export function shuffleLines(text: string): string {
  const { lines, trailingNewline, eol } = splitLines(text);
  for (let index = lines.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [lines[index], lines[other]] = [lines[other], lines[index]];
  }
  return joinLines(lines, trailingNewline, eol);
}

/** Duplicate a 1-based content block below itself. */
export function duplicateLines(text: string, startLine: number, endLine: number): LineResult | null {
  const { lines, trailingNewline, eol } = splitLines(text);
  if (text === "") lines.push("");
  if (!validRange(lines, startLine, endLine)) return null;
  const block = lines.slice(startLine - 1, endLine);
  const inserted = lines.slice(0, endLine).concat(block, lines.slice(endLine));
  const selStart = offsetOfLine(inserted, endLine, eol);
  return {
    text: joinLines(inserted, trailingNewline, eol),
    selStart,
    // block.join already includes all inter-line delimiters exactly once.
    selEnd: selStart + block.join(eol).length,
  };
}

export function deleteLines(text: string, startLine: number, endLine: number): LineResult | null {
  const { lines, trailingNewline, eol } = splitLines(text);
  if (!validRange(lines, startLine, endLine)) return null;
  const kept = lines.slice(0, startLine - 1).concat(lines.slice(endLine));
  const selStart = offsetOfLine(kept, Math.max(0, Math.min(startLine - 1, kept.length - 1)), eol);
  return { text: joinLines(kept, trailingNewline, eol), selStart, selEnd: selStart };
}

/** Join inter-line whitespace to one space, retaining outer whitespace. */
export function joinLinesRange(text: string, startLine: number, endLine: number): LineResult | null {
  const { lines, trailingNewline, eol } = splitLines(text);
  if (!validRange(lines, startLine, endLine) || endLine === startLine) return null;
  const block = lines.slice(startLine - 1, endLine);
  const joined = block.map((line, index) => {
    if (index > 0) line = line.trimStart();
    if (index < block.length - 1) line = line.trimEnd();
    return line;
  }).join(" ");
  const replaced = lines.slice(0, startLine - 1).concat([joined], lines.slice(endLine));
  const selStart = offsetOfLine(replaced, startLine - 1, eol);
  return {
    text: joinLines(replaced, trailingNewline, eol),
    selStart,
    selEnd: selStart + joined.length,
  };
}
