/** Shared safety limits, capture resolution, token packing and diagnostics.
 * Used by the main-thread regex engine and by the tree-sitter worker alike.
 * Incremental parsing and embedded-language injections remain deferred.
 */
export const HIGHLIGHT_LIMITS = {
  codeUnits: 512 * 1024,
  lines: 20_000,
  lineLength: 10_000,
  captures: 100_000,
  milliseconds: 60,
} as const;

const warnings = new Map<string, string>();
export function warnHighlightOnce(key: string, error: unknown): void {
  if (warnings.has(key)) return;
  const message = error instanceof Error ? error.message : String(error);
  warnings.set(key, message);
  console.warn(`[highlight:${key}] ${message}`);
}

/** Read-only diagnostic snapshot; never stores document contents or model IDs. */
export function getHighlightWarnings(): ReadonlyArray<{ key: string; message: string }> {
  return Array.from(warnings, ([key, message]) => ({ key, message }));
}

export interface HighlightCapture {
  startIndex: number;
  endIndex: number;
  patternIndex: number;
  scope: string;
}

/** Capture scope -> Monaco semantic token type index (legend order). */
export const SCOPE_TOKEN_INDEX: Record<string, number> = {
  keywords: 0, commands: 0, types: 1, attributes: 2, variables: 3,
  values: 4, numbers: 5, strings: 6, characters: 6, comments: 7,
};

/** Pack resolved captures against already-split lines (worker side).
 * Line contents exclude their EOL, so CR/LF never enter token lengths. The
 * offset space is the lines joined with "\n", which is exactly what the worker
 * parses. Output matches the main-thread `packTokens` encoding: delta line /
 * delta column / length / type / modifiers.
 */
export function packTokensFromLines(captures: HighlightCapture[], lines: readonly string[]): Uint32Array {
  if (!lines.length) return new Uint32Array();
  const starts: number[] = new Array(lines.length);
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = total;
    total += lines[i].length;
    if (i + 1 < lines.length) total += 1; // the "\n" joiner
  }
  const lineAt = (offset: number): number => {
    let low = 0, high = lines.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const data: number[] = [];
  let previousLine = 0, previousColumn = 0;
  for (const capture of captures) {
    const type = SCOPE_TOKEN_INDEX[capture.scope];
    if (type == null || capture.startIndex < 0 || capture.endIndex > total) continue;
    const startLine = lineAt(capture.startIndex);
    const endLine = lineAt(capture.endIndex);
    for (let line = startLine; line <= endLine; line++) {
      const column = line === startLine ? capture.startIndex - starts[line] : 0;
      const lastColumn = line === endLine ? capture.endIndex - starts[line] : lines[line].length;
      if (lastColumn <= column) continue;
      const deltaLine = line - previousLine;
      data.push(deltaLine, deltaLine ? column : column - previousColumn, lastColumn - column, type, 0);
      previousLine = line;
      previousColumn = column;
    }
  }
  return Uint32Array.from(data);
}

/** Sweep ranges in O(n log n), not per-character/per-capture subtraction.
 * A more specific (shorter) range wins over its parent. For identical ranges,
 * the last query pattern wins, then the last capture. Crossing ranges follow
 * the same deterministic priority. The result is sorted and non-overlapping.
 */
export function resolveCaptureRanges(captures: HighlightCapture[]): HighlightCapture[] {
  const valid = captures.filter(c => Number.isInteger(c.startIndex) &&
    Number.isInteger(c.endIndex) && c.startIndex >= 0 && c.endIndex > c.startIndex);
  const events = valid.flatMap((c, id) => [
    { offset: c.startIndex, id, start: true },
    { offset: c.endIndex, id, start: false },
  ]).sort((a, b) => a.offset - b.offset);
  const active = new Uint8Array(valid.length);
  const heap: number[] = [];
  const better = (a: number, b: number): boolean => {
    const x = valid[a], y = valid[b];
    const lengthDifference = (x.endIndex - x.startIndex) - (y.endIndex - y.startIndex);
    return lengthDifference !== 0 ? lengthDifference < 0 :
      x.patternIndex !== y.patternIndex ? x.patternIndex > y.patternIndex : a > b;
  };
  const push = (id: number): void => {
    let i = heap.length;
    heap.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!better(heap[i], heap[parent])) break;
      [heap[i], heap[parent]] = [heap[parent], heap[i]];
      i = parent;
    }
  };
  const pop = (): void => {
    const last = heap.pop()!;
    if (!heap.length) return;
    heap[0] = last;
    let i = 0;
    while (i * 2 + 1 < heap.length) {
      let child = i * 2 + 1;
      if (child + 1 < heap.length && better(heap[child + 1], heap[child])) child++;
      if (!better(heap[child], heap[i])) break;
      [heap[i], heap[child]] = [heap[child], heap[i]];
      i = child;
    }
  };
  const result: HighlightCapture[] = [];
  for (let i = 0; i < events.length;) {
    const start = events[i].offset;
    while (i < events.length && events[i].offset === start) {
      const e = events[i++];
      active[e.id] = e.start ? 1 : 0;
      if (e.start) push(e.id);
    }
    while (heap.length && !active[heap[0]]) pop();
    if (!heap.length || i === events.length) continue;
    const end = events[i].offset;
    const winner = valid[heap[0]];
    const previous = result[result.length - 1];
    if (previous?.endIndex === start && previous.scope === winner.scope) {
      previous.endIndex = end;
    } else {
      result.push({ ...winner, startIndex: start, endIndex: end });
    }
  }
  return result;
}
