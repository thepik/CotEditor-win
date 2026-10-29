// Run against the Vite dev server, without changing app sources or dependencies:
// node scripts/regression-editing.mjs http://127.0.0.1:1420/
// This is a Chromium/Monaco regression, NOT native Windows IME acceptance.
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1420/";
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const runtimeErrors = [];
page.on("pageerror", (error) => runtimeErrors.push(error.message));

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  // Use the exact module URL the app executed: Vite's HMR stamp would make a
  // plain specifier import a second, uninitialised monaco-setup instance.
  await page.evaluate(async () => {
    const pick = (suffix) => [...new Set(performance.getEntriesByType("resource").map((entry) => entry.name))]
      .filter((name) => name.includes(suffix)).pop() ?? suffix;
    window.__smoke = await import(pick("/src/editor/monaco-setup.ts"));
  });
  await page.waitForFunction(() =>
    !!window.__smoke.getEditor()?.getAction("coteditor.reverseLines"),
  null, { timeout: 30000 });

  const report = await page.evaluate(async () => {
    const { monaco, getEditor } = window.__smoke;
    const editor = getEditor();
    const model = editor.getModel();
    // Keep tests isolated from suggestions, bracket insertion, and cursor merge
    // policy changes in user settings. Only public Monaco APIs are used.
    editor.updateOptions({ autoClosingBrackets: "never", autoClosingQuotes: "never", quickSuggestions: false });
    const results = [];
    const equal = (actual, expected, message) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    };
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const selections = () => editor.getSelections().map((s) => [
      s.selectionStartLineNumber, s.selectionStartColumn, s.positionLineNumber, s.positionColumn,
    ]);
    const snapshot = () => ({ text: model.getValue(), eol: model.getEOL(), selections: selections() });
    const reset = (text, ranges, options = {}, eol = text.includes("\r\n") ? "\r\n" : "\n") => {
      model.setValue(text);
      model.setEOL(eol === "\r\n" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      model.updateOptions({ tabSize: 4, insertSpaces: true, ...options });
      editor.setSelections(ranges.map((s) => new monaco.Selection(...s)));
      editor.focus();
    };
    const run = async (command, random) => {
      const action = editor.getAction(`coteditor.${command}`);
      check(action, `missing action ${command}`);
      const originalRandom = Math.random;
      try {
        if (random !== undefined) Math.random = () => random;
        await action.run();
      } finally {
        Math.random = originalRandom;
      }
    };
    const record = async (name, test) => {
      try {
        await test();
        results.push({ name, pass: true });
      } catch (error) {
        results.push({ name, pass: false, error: String(error.stack || error) });
      }
    };
    // Selection tuples are [anchor line, anchor column, active line, active column].
    const cases = [
      { name: "partial reverse keeps both unselected line fragments", text: "abc\nxyz", ranges: [[1, 2, 2, 2]], command: "reverseLines", expected: "xyz\nabc", after: [[1, 1, 2, 4]] },
      { name: "backward partial reverse retains direction", text: "abc\nxyz", ranges: [[2, 2, 1, 2]], command: "reverseLines", expected: "xyz\nabc", after: [[2, 4, 1, 1]] },
      { name: "endAtNextLineCol1 excludes next line", text: "b\na\nKEEP", ranges: [[1, 2, 3, 1]], command: "sortLinesAscending", expected: "a\nb\nKEEP", after: [[1, 1, 2, 2]], local: true },
      { name: "backward endAtNextLineCol1", text: "b\na\nKEEP", ranges: [[3, 1, 1, 2]], command: "sortLinesAscending", expected: "a\nb\nKEEP", after: [[2, 2, 1, 1]] },
      { name: "partial descending is whole-line and local", text: "HEAD\na\nb\nTAIL", ranges: [[2, 2, 3, 2]], command: "sortLinesDescending", expected: "HEAD\nb\na\nTAIL", local: true },
      { name: "selected final empty content line participates in reverse", text: "b\n\nKEEP", ranges: [[1, 1, 3, 1]], command: "reverseLines", expected: "\nb\nKEEP", after: [[1, 1, 2, 2]] },
      { name: "whole-document fallback keeps trailing newline", text: "b\na\n", ranges: [[2, 2, 2, 2]], command: "sortLinesAscending", expected: "a\nb\n", after: [[1, 1, 3, 1]] },
      { name: "CRLF reverse keeps ending and terminal newline", text: "b\na\n".replaceAll("\n", "\r\n"), ranges: [[1, 1, 1, 1]], command: "reverseLines", expected: "a\r\nb\r\n", after: [[1, 1, 3, 1]] },
      { name: "shuffle executes deterministically", text: "a\nb\nc\n", ranges: [[1, 1, 1, 1]], command: "shuffleLines", random: 0, expected: "b\nc\na\n" },
      { name: "multi-range transform retains primary and backward secondary", text: "b\na\nKEEP\nd\nc\nTAIL", ranges: [[4, 2, 5, 2], [2, 2, 1, 2]], command: "sortLinesAscending", expected: "a\nb\nKEEP\nc\nd\nTAIL", after: [[4, 1, 5, 2], [2, 2, 1, 1]], local: true },
      { name: "multi-caret transform does not expand to whole document", text: "b \nKEEP \na \nTAIL ", ranges: [[1, 2, 1, 2], [3, 2, 3, 2]], command: "trimTrailingWhitespace", expected: "b\nKEEP \na\nTAIL ", after: [[1, 1, 1, 2], [3, 1, 3, 2]], local: true },
      { name: "overlapping line spans transform only once", text: "abc\nxyz\nTAIL", ranges: [[1, 2, 2, 2], [2, 3, 2, 4]], command: "reverseLines", expected: "xyz\nabc\nTAIL" },
      { name: "dedupe reads whole partial lines", text: "HEAD\nabc\nabc\nTAIL", ranges: [[2, 2, 3, 2]], command: "deleteDuplicateLines", expected: "HEAD\nabc\nTAIL", after: [[2, 1, 2, 4]], local: true },
      { name: "multi-range shrink maps later selection", text: "x\nx\nKEEP\ny\ny\nTAIL", ranges: [[4, 2, 5, 2], [1, 2, 2, 2]], command: "deleteDuplicateLines", expected: "x\nKEEP\ny\nTAIL", after: [[3, 1, 3, 2], [1, 1, 1, 2]] },
      { name: "removeEmptyLines consumes selected blank delimiters only", text: "HEAD\n \n\nTAIL", ranges: [[2, 1, 4, 1]], command: "removeEmptyLines", expected: "HEAD\nTAIL", after: [[2, 1, 2, 1]], local: true },
      { name: "remove all whitespace lines leaves empty model", text: " \r\n\r\n", ranges: [[1, 1, 1, 1]], command: "removeEmptyLines", expected: "" },
      { name: "move up preserves partial columns", text: "top\nabc\nxyz\nbottom", ranges: [[3, 2, 3, 3]], command: "moveLineUp", expected: "top\nxyz\nabc\nbottom", after: [[2, 2, 2, 3]], local: true },
      { name: "move down preserves backward columns", text: "top\nabc\nxyz\nbottom", ranges: [[2, 3, 2, 2]], command: "moveLineDown", expected: "top\nxyz\nabc\nbottom", after: [[3, 3, 3, 2]], local: true },
      { name: "move endAtNextLineCol1 maps exclusive endpoint", text: "top\nabc\nxyz\nbottom\ntail", ranges: [[2, 2, 4, 1]], command: "moveLineDown", expected: "top\nbottom\nabc\nxyz\ntail", after: [[3, 2, 5, 1]], local: true },
      { name: "move exclusive endpoint to EOF clamps correctly", text: "a\nb", ranges: [[1, 1, 2, 1]], command: "moveLineDown", expected: "b\na", after: [[2, 1, 2, 2]] },
      { name: "CRLF move offsets and terminal newline", text: "top\r\nabc\r\nxyz\r\n", ranges: [[3, 3, 2, 2]], command: "moveLineUp", expected: "abc\r\nxyz\r\ntop\r\n", after: [[2, 3, 1, 2]], local: true },
      { name: "move last content down does not remove terminal EOL", text: "a\nb\n", ranges: [[2, 2, 2, 2]], command: "moveLineDown", expected: "a\nb\n", unchanged: true },
      { name: "terminal sentinel is not moved into content", text: "a\nb\n", ranges: [[3, 1, 3, 1]], command: "moveLineUp", expected: "a\nb\n", unchanged: true },
      { name: "move blank content line", text: "a\n\nb\n", ranges: [[2, 1, 2, 1]], command: "moveLineUp", expected: "\na\nb\n", after: [[1, 1, 1, 1]], local: true },
      { name: "multiCursor move preserves primary order", text: "a\nbb\nc\nd\nee\nf", ranges: [[5, 3, 5, 2], [2, 2, 2, 2]], command: "moveLineUp", expected: "bb\na\nc\nee\nd\nf", after: [[4, 3, 4, 2], [1, 2, 1, 2]], local: true },
      { name: "adjacent cursors move as one block", text: "a\nbb\nccc\nd", ranges: [[2, 2, 2, 2], [3, 3, 3, 3]], command: "moveLineUp", expected: "bb\nccc\na\nd", after: [[1, 2, 1, 2], [2, 3, 2, 3]], local: true },
      { name: "overlapping spans move only once", text: "abc\nxyz\np", ranges: [[1, 2, 2, 2], [2, 3, 2, 4]], command: "moveLineDown", expected: "p\nabc\nxyz", after: [[2, 2, 3, 2], [3, 3, 3, 4]] },
      { name: "blocked primary and movable secondary", text: "a\nbb\nccc\nd", ranges: [[1, 2, 1, 2], [3, 3, 3, 3]], command: "moveLineUp", expected: "a\nccc\nbb\nd", after: [[1, 2, 1, 2], [2, 3, 2, 3]], local: true },
      { name: "duplicate backward partial block", text: "left\nabc\nxyz\nright", ranges: [[3, 2, 2, 2]], command: "duplicateLine", expected: "left\nabc\nxyz\nabc\nxyz\nright", after: [[5, 2, 4, 2]], local: true },
      { name: "duplicate exclusive endpoint", text: "left\nabc\nxyz\nright", ranges: [[2, 2, 4, 1]], command: "duplicateLine", expected: "left\nabc\nxyz\nabc\nxyz\nright", after: [[4, 2, 6, 1]], local: true },
      { name: "CRLF duplicate has correct offsets", text: "a\r\nbb\r\nccc\r\nd", ranges: [[2, 2, 3, 3]], command: "duplicateLine", expected: "a\r\nbb\r\nccc\r\nbb\r\nccc\r\nd", after: [[4, 2, 5, 3]], local: true },
      { name: "multiCursor duplicates same line once", text: "top\nabc\nend", ranges: [[2, 1, 2, 2], [2, 3, 2, 4]], command: "duplicateLine", expected: "top\nabc\nabc\nend", after: [[3, 1, 3, 2], [3, 3, 3, 4]], local: true },
      { name: "multiCursor separate duplicate offsets", text: "a\nbb\nc\ndd\ne", ranges: [[4, 3, 4, 2], [2, 2, 2, 2]], command: "duplicateLine", expected: "a\nbb\nbb\nc\ndd\ndd\ne", after: [[6, 3, 6, 2], [3, 2, 3, 2]], local: true },
      { name: "duplicate EOF without inventing terminal EOL", text: "a\nb", ranges: [[2, 2, 2, 2]], command: "duplicateLine", expected: "a\nb\nb", after: [[3, 2, 3, 2]], local: true },
      { name: "duplicate preserves terminal newline", text: "a\nb\n", ranges: [[2, 2, 2, 2]], command: "duplicateLine", expected: "a\nb\nb\n", after: [[3, 2, 3, 2]], local: true },
      { name: "duplicate terminal blank line", text: "a\nb\n", ranges: [[3, 1, 3, 1]], command: "duplicateLine", expected: "a\nb\n\n", after: [[4, 1, 4, 1]], local: true },
      { name: "duplicate empty CRLF buffer", text: "", eol: "\r\n", ranges: [[1, 1, 1, 1]], command: "duplicateLine", expected: "\r\n", after: [[2, 1, 2, 1]] },
      { name: "delete partial block keeps surrounding lines", text: "head\nabc\nxyz\ntail", ranges: [[2, 2, 3, 2]], command: "deleteLine", expected: "head\ntail", after: [[2, 1, 2, 1]], local: true },
      { name: "delete endAtNextLineCol1 excludes next line", text: "head\nabc\nxyz\ntail", ranges: [[3, 1, 2, 2]], command: "deleteLine", expected: "head\nxyz\ntail", after: [[2, 1, 2, 1]], local: true },
      { name: "delete last unterminated line consumes preceding EOL", text: "head\nabc", ranges: [[2, 2, 2, 2]], command: "deleteLine", expected: "head", after: [[1, 5, 1, 5]], local: true },
      { name: "delete preserves CRLF terminal newline", text: "head\r\nabc\r\n", ranges: [[2, 2, 2, 2]], command: "deleteLine", expected: "head\r\n", after: [[2, 1, 2, 1]], local: true },
      { name: "explicitly delete terminal empty line", text: "a\n", ranges: [[2, 1, 2, 1]], command: "deleteLine", expected: "a", after: [[1, 2, 1, 2]], local: true },
      { name: "delete all lines leaves empty buffer", text: "abc\nxyz", ranges: [[2, 4, 1, 1]], command: "deleteLine", expected: "", after: [[1, 1, 1, 1]] },
      { name: "multiCursor delete offsets preserve primary", text: "a\nb\nc\nd\ne", ranges: [[4, 1, 4, 2], [2, 2, 2, 1]], command: "deleteLine", expected: "a\nc\ne", after: [[3, 1, 3, 1], [2, 1, 2, 1]], local: true },
      { name: "overlapping spans delete once and undo restores both", text: "head\nabc\nxyz\ntail", ranges: [[2, 1, 2, 2], [2, 3, 3, 2]], command: "deleteLine", expected: "head\ntail", after: [[2, 1, 2, 1]], local: true },
      { name: "join partial selection includes whole touched lines", text: "HEAD\n  abc  \n  xyz  \nTAIL", ranges: [[3, 4, 2, 4]], command: "joinLines", expected: "HEAD\n  abc xyz  \nTAIL", after: [[2, 12, 2, 1]], local: true },
      { name: "join caret is no-op, does not trim", text: "a  \nb", ranges: [[1, 2, 1, 2]], command: "joinLines", expected: "a  \nb", unchanged: true },
      { name: "CRLF join preserves outer terminal EOL", text: "a\r\nb\r\n", ranges: [[1, 1, 3, 1]], command: "joinLines", expected: "a b\r\n", after: [[1, 1, 1, 4]] },
      { name: "indent uses two spaces and preserves CRLF", text: "a\r\nb\r\n", ranges: [[1, 2, 3, 1]], command: "indentLines", options: { tabSize: 2, insertSpaces: true }, expected: "  a\r\n  b\r\n", after: [[1, 1, 2, 4]] },
      { name: "indent respects tab mode", text: "a\nb", ranges: [[1, 1, 1, 1]], command: "indentLines", options: { tabSize: 8, insertSpaces: false }, expected: "\ta\n\tb" },
      { name: "indent empty buffer", text: "", ranges: [[1, 1, 1, 1]], command: "indentLines", options: { tabSize: 2 }, expected: "  ", after: [[1, 1, 1, 3]] },
      { name: "outdent partial levels and mixed tabs", text: "   a\n  \tb\n      c\n", ranges: [[1, 1, 1, 1]], command: "outdentLines", expected: "a\nb\n  c\n" },
      { name: "outdent tab mode honors tab size for spaces", text: "      a\n\tb", ranges: [[1, 1, 1, 1]], command: "outdentLines", options: { tabSize: 2, insertSpaces: false }, expected: "    a\nb" },
      { name: "dedent keeps whitespace-only lines safe", text: "  a\n    b\n \n", ranges: [[1, 1, 1, 1]], command: "dedentLines", expected: "a\n  b\n\n" },
      { name: "CRLF sort endAtNextLineCol1 excludes next line", text: "b\r\na\r\nKEEP", ranges: [[1, 2, 3, 1]], command: "sortLinesAscending", expected: "a\r\nb\r\nKEEP", after: [[1, 1, 2, 2]], local: true },
      { name: "CRLF delete first line", text: "a\r\nb\r\nc", ranges: [[1, 2, 1, 2]], command: "deleteLine", expected: "b\r\nc", after: [[1, 1, 1, 1]], local: true },
      { name: "CRLF delete terminal sentinel", text: "a\r\n", ranges: [[2, 1, 2, 1]], command: "deleteLine", expected: "a", after: [[1, 2, 1, 2]], local: true },
      { name: "CRLF duplicate at EOF", text: "a\r\nb", ranges: [[2, 2, 2, 2]], command: "duplicateLine", expected: "a\r\nb\r\nb", after: [[3, 2, 3, 2]], local: true },
      { name: "CRLF multiCursor move up keeps order and direction", text: "top\r\nabc\r\nxyz\r\nbottom", ranges: [[3, 2, 3, 2], [2, 3, 2, 3]], command: "moveLineUp", expected: "abc\r\nxyz\r\ntop\r\nbottom", after: [[2, 2, 2, 2], [1, 3, 1, 3]], local: true },
      { name: "duplicate overlapping spans edit the line once", text: "a\r\nbb\r\nc", ranges: [[2, 1, 2, 2], [2, 3, 2, 3]], command: "duplicateLine", expected: "a\r\nbb\r\nbb\r\nc", after: [[3, 1, 3, 2], [3, 3, 3, 3]], local: true },
      { name: "adjacent cursors delete as one block", text: "a\nb\nc\nd", ranges: [[2, 1, 2, 1], [3, 1, 3, 1]], command: "deleteLine", expected: "a\nd", after: [[2, 1, 2, 1]], local: true },
      { name: "indent eight spaces honors tabSize", text: "a\nb", ranges: [[1, 1, 1, 1]], command: "indentLines", options: { tabSize: 8, insertSpaces: true }, expected: "        a\n        b", after: [[1, 1, 2, 10]] },
      { name: "outdent removes at most one tab stop", text: "        a\n    b", ranges: [[1, 1, 1, 1]], command: "outdentLines", expected: "    a\nb", after: [[1, 1, 2, 2]] },
      { name: "trim whole document keeps terminal newline", text: "a  \nb  \n", ranges: [[1, 1, 1, 1]], command: "trimTrailingWhitespace", expected: "a\nb\n", after: [[1, 1, 3, 1]] },
      { name: "unchanged span leaves later caret mapped", text: "a \nKEEP\nb", ranges: [[1, 1, 2, 1], [3, 2, 3, 2]], command: "trimTrailingWhitespace", expected: "a\nKEEP\nb", after: [[1, 1, 1, 2], [3, 2, 3, 2]], local: true },
      ...["reverseLines", "sortLinesAscending", "deleteLine", "moveLineUp", "moveLineDown", "joinLines", "removeEmptyLines", "outdentLines", "dedentLines"].map((command) => ({ name: `empty ${command} is safe no-op`, text: "", ranges: [[1, 1, 1, 1]], command, expected: "", unchanged: true })),
    ];

    for (const test of cases) {
      await record(test.name, async () => {
        reset(test.text, test.ranges, test.options, test.eol);
        const before = snapshot();
        equal(before.text, test.text, "fixture text");
        equal(before.selections, test.ranges, "fixture selections (not pre-merged)");
        const changes = [];
        const listener = model.onDidChangeContent((event) => changes.push(...event.changes));
        try {
          await run(test.command, test.random);
        } finally {
          listener.dispose();
        }
        equal(model.getValue(), test.expected, "command text");
        equal(model.getEOL(), before.eol, "command EOL");
        if (test.after) equal(selections(), test.after, "command selection");
        const after = snapshot();
        if (test.unchanged) {
          equal(after, before, "no-op state");
          check(!model.canUndo(), "no-op must not add an undo entry");
          return;
        }
        check(changes.length > 0, "command did not actually edit");
        if (test.local) check(changes.every((change) => change.rangeLength < test.text.length), "unexpected whole-document replacement");
        await model.undo();
        equal(snapshot(), before, "undo restores text, EOL, primary/secondary and direction");
        check(!model.canUndo(), "command must be exactly one undo entry");
        await model.redo();
        equal(snapshot(), after, "redo restores text AND post-command selections");
        check(!model.canRedo(), "command must be exactly one redo entry");
      });
    }

    const groupingCommands = [
      "reverseLines", "sortLinesAscending", "moveLineUp", "moveLineDown",
      "duplicateLine", "deleteLine", "indentLines",
    ];
    for (const command of groupingCommands) {
      await record(`typing / ${command} / typing have three undo groups`, async () => {
        reset("b\r\na\r\nc", [[2, 2, 2, 2]]);
        const initial = snapshot();
        editor.trigger("editing-regression", "type", { text: "x" });
        const typedBefore = snapshot();
        equal(typedBefore.text, "b\r\nax\r\nc", "real Monaco typing before command");
        await run(command);
        const operated = snapshot();
        check(operated.text !== typedBefore.text, "grouping command must mutate text");
        editor.trigger("editing-regression", "type", { text: "!" });
        const typedAfter = snapshot();
        await model.undo();
        equal(snapshot(), operated, "undo trailing typing only");
        await model.undo();
        equal(snapshot(), typedBefore, "undo operation only, keep earlier typing");
        await model.undo();
        equal(snapshot(), initial, "undo initial typing only");
        check(!model.canUndo(), "expected exactly three undo groups");
        await model.redo();
        equal(snapshot(), typedBefore, "redo initial typing");
        await model.redo();
        equal(snapshot(), operated, "redo operation and selection");
        await model.redo();
        equal(snapshot(), typedAfter, "redo trailing typing");
      });
    }

    // A blocked command must not push an undo stop of its own: that would split
    // one continuous typing session into two undo entries.
    await record("no-op command does not split a typing undo group", async () => {
      reset("abc", [[1, 2, 1, 2]]);
      editor.trigger("editing-regression", "type", { text: "x" });
      await run("moveLineUp");
      editor.trigger("editing-regression", "type", { text: "y" });
      equal(model.getValue(), "axybc", "blocked command keeps the typed text");
      await model.undo();
      equal(model.getValue(), "abc", "one undo removes the whole typing burst");
      check(!model.canUndo(), "no-op command must not add an undo stop");
      await model.redo();
      equal(model.getValue(), "axybc", "redo restores the typing burst");
    });

    const pure = await import("/src/lib/text-operations.ts");
    const crlf = "a\r\nbb\r\nccc\r\n";
    const pureCases = [
      ["pure move up CRLF offsets", () => pure.moveLineUp(crlf, 2, 3), { text: "bb\r\nccc\r\na\r\n", selStart: 0, selEnd: 7 }],
      ["pure move down CRLF offsets", () => pure.moveLineDown(crlf, 1, 2), { text: "ccc\r\na\r\nbb\r\n", selStart: 5, selEnd: 10 }],
      ["pure duplicate does not double-count delimiters", () => pure.duplicateLines(crlf, 1, 2), { text: "a\r\nbb\r\na\r\nbb\r\nccc\r\n", selStart: 7, selEnd: 12 }],
      ["pure delete CRLF offsets", () => pure.deleteLines(crlf, 2, 2), { text: "a\r\nccc\r\n", selStart: 3, selEnd: 3 }],
      ["pure join CRLF offsets", () => pure.joinLinesRange(crlf, 2, 3), { text: "a\r\nbb ccc\r\n", selStart: 3, selEnd: 9 }],
      ["pure delete every content line", () => pure.deleteLines(crlf, 1, 3), { text: "", selStart: 0, selEnd: 0 }],
      ["pure empty duplication", () => pure.duplicateLines("", 1, 1), { text: "\n", selStart: 1, selEnd: 1 }],
      ["pure rejects invalid range", () => pure.moveLineDown(crlf, 0, 1), null],
      ["pure CR-only ending remains CR", () => pure.reverseLines("b\ra\r"), "a\rb\r"],
      ["pure UTF-16 offsets include surrogate pair", () => pure.duplicateLines("\u{1F600}\r\nx", 1, 1), { text: "\u{1F600}\r\n\u{1F600}\r\nx", selStart: 4, selEnd: 6 }],
      ["pure outdent stops at content", () => pure.outdentLines("        a\n    b", "    ", 4), "    a\nb"],
      ["pure outdent never slices non-whitespace", () => pure.outdentLines("  a", "    ", 4), "a"],
      ["pure indent CRLF with two spaces", () => pure.indentLines("a\r\nb\r\n", "  "), "  a\r\n  b\r\n"],
      ["pure join single line is a no-op", () => pure.joinLinesRange(crlf, 2, 2), null],
    ];
    for (const [name, compute, expected] of pureCases) {
      await record(name, () => equal(compute(), expected, name));
    }
    return {
      results, commandCases: cases.length,
      undoGroupingCases: groupingCommands.length + 1, helperCases: pureCases.length,
    };
  });

  for (const result of report.results) {
    console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}${result.error ? `\n${result.error}` : ""}`);
  }
  const failed = report.results.filter((result) => !result.pass);
  console.log(JSON.stringify({ url, passed: report.results.length - failed.length, failed: failed.length, commandCases: report.commandCases, undoGroupingCases: report.undoGroupingCases, helperCases: report.helperCases, runtimeErrors }, null, 2));
  console.log("Scope: Chromium + public Monaco APIs; native WebView2/IME is not covered.");
  process.exitCode = failed.length || runtimeErrors.length ? 1 : 0;
} catch (error) {
  console.error(error);
  if (runtimeErrors.length) console.error("Runtime errors:", runtimeErrors);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
