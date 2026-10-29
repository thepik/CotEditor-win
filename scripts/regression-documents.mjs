// Document save/open transaction regressions. Runs against the Vite dev server:
//   node scripts/regression-documents.mjs http://127.0.0.1:1420/
//
// File System Access pickers are replaced with in-memory fixtures so the suite
// never touches real files. This is a Chromium/Monaco regression, NOT native
// Windows IME or Wails acceptance.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1420/";
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(12000);

const failures = [];
const runtimeErrors = [];
page.on("pageerror", (error) => {
  // Disposing a tab/model cancels Monaco's caret/scroll delayers internally;
  // the rejection is teardown noise no caller can observe (see the store suite).
  if (error.message === "Canceled") return;
  runtimeErrors.push(error.message);
});
page.on("console", (message) => {
  // Save/open failures below are deliberate; their app-side console.error is
  // expected. Anything else is a real runtime error.
  if (message.type() === "error" && !/save failed:|open failed:/.test(message.text())) {
    runtimeErrors.push(message.text());
  }
});

// In-memory File System Access fixtures. Every navigation gets a fresh state.
await context.addInitScript(() => {
  try { localStorage.setItem("coteditor.lang.v1", "en"); } catch { /* opaque origin */ }
  const fs = {
    opens: [], openCalls: 0, openCancel: false,
    saveHandles: [], saveCancel: false, failNext: false,
    slow: false, pendingClose: false, release: null,
    writes: [], segmentCalls: 0,
  };
  window.__fs = fs;

  const encode = (text, bom) => {
    let bytes = new TextEncoder().encode(text);
    if (!bom) return bytes;
    const withBom = new Uint8Array(bytes.length + 3);
    withBom.set([0xef, 0xbb, 0xbf]);
    withBom.set(bytes, 3);
    return withBom;
  };
  fs.queueOpen = (name, text, bom = false) => {
    fs.opens.push({ name, bytes: encode(text, bom) });
  };
  fs.queueRaw = (name, bytes) => {
    fs.opens.push({ name, bytes: Uint8Array.from(bytes) });
  };
  fs.queueSave = (name) => fs.saveHandles.push({ name });

  const handle = (name, bytes) => ({
    name,
    async getFile() {
      return {
        name,
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    },
    async createWritable() {
      let content = "";
      let closed = false;
      return {
        async write(chunk) { content += String(chunk); },
        async close() {
          if (fs.slow) {
            fs.pendingClose = true;
            await new Promise((resolve) => { fs.release = resolve; });
            fs.pendingClose = false;
          }
          if (fs.failNext) {
            fs.failNext = false;
            throw new Error("fixture write failure");
          }
          if (closed) return;
          closed = true;
          fs.writes.push({ name, content });
        },
        async abort() { closed = true; },
      };
    },
  });

  window.showOpenFilePicker = async () => {
    fs.openCalls += 1;
    if (fs.openCancel) {
      fs.openCancel = false;
      throw new DOMException("cancelled", "AbortError");
    }
    const spec = fs.opens.shift();
    if (!spec) throw new DOMException("cancelled", "AbortError");
    return [handle(spec.name, spec.bytes)];
  };
  window.showSaveFilePicker = async () => {
    if (fs.saveCancel) {
      fs.saveCancel = false;
      throw new DOMException("cancelled", "AbortError");
    }
    const spec = fs.saveHandles.shift();
    if (!spec) throw new DOMException("cancelled", "AbortError");
    return handle(spec.name, new Uint8Array());
  };

  // Count grapheme segmenter use so cursor movement can be proven cache-only.
  if (typeof Intl.Segmenter === "function") {
    const original = Intl.Segmenter.prototype.segment;
    Intl.Segmenter.prototype.segment = function (...args) {
      fs.segmentCalls += 1;
      return original.apply(this, args);
    };
  }
});

async function test(name, run) {
  try {
    await fresh();
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.stack || error}`);
  }
}

async function fresh() {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => !!window.__coteditor
    && document.querySelectorAll("#menubar > .ce-menu-item").length > 0);
  await page.evaluate(async () => {
    // Bind to the exact module URL main.ts executed. Vite appends an HMR
    // timestamp after edits; a plain specifier can hand back a second,
    // uninitialised monaco-setup instance with no editor.
    const pick = (suffix) => [...new Set(performance.getEntriesByType("resource").map((entry) => entry.name))]
      .filter((name) => name.includes(suffix)).pop() ?? suffix;
    window.__t = await import(pick("/src/editor/monaco-setup.ts"));
  });
  await page.waitForFunction(() => !!window.__t?.getEditor()?.getModel()?.getValue);
  await page.evaluate(() => {
    window.__t.getEditor().updateOptions({
      autoClosingBrackets: "never", autoClosingQuotes: "never", quickSuggestions: false,
    });
  });
}

const normalize = (text) => text.replace(/\r\n?/g, "\n");
const text = () => page.evaluate(() => window.__t.getEditor().getModel().getValue());
const dirty = () => page.evaluate(() => document.title.includes("·"));
const title = () => page.evaluate(() => document.title);
const tabCount = () => page.evaluate(() =>
  document.querySelectorAll("#tabs .ce-tabs-tab").length);
const stat = (name) => page.evaluate((field) => {
  const node = document.querySelector(`#statusbar [data-stat="${field}"]`);
  return node ? node.textContent : "";
}, name);
const readOnly = () => page.evaluate(() =>
  window.__t.getEditor().getOption(window.__t.monaco.editor.EditorOption.readOnly));
const writes = () => page.evaluate(() => window.__fs.writes);
const pendingClose = () => page.evaluate(() => window.__fs.pendingClose === true);

async function focusEditor() {
  await page.evaluate(() => window.__t.getEditor().focus());
}
async function positionEnd() {
  await page.evaluate(() => {
    const editor = window.__t.getEditor();
    const model = editor.getModel();
    const line = model.getLineCount();
    editor.setPosition({ lineNumber: line, column: model.getLineMaxColumn(line) });
    editor.focus();
  });
}
async function type(value) {
  await focusEditor();
  await page.keyboard.insertText(value);
}
async function compositionStart() {
  await page.evaluate(() => window.dispatchEvent(new CompositionEvent("compositionstart")));
}
async function compositionEnd() {
  await page.evaluate(() => window.dispatchEvent(new CompositionEvent("compositionend")));
}
async function waitWrites(count) {
  await page.waitForFunction((n) => window.__fs.writes.length >= n, count);
}
async function settled() {
  await page.waitForFunction(() => {
    const state = window.__coteditor?.document?.();
    return !!state && !state.documentOperationActive && !state.saveInFlight;
  });
}
async function openFixture(name, content, bom = false) {
  await page.evaluate(({ n, c, b }) => window.__fs.queueOpen(n, c, b), { n: name, c: content, b: bom });
  await page.keyboard.press("Control+o");
  await page.waitForFunction((expected) => document.title.includes(expected), name);
  await settled();
}

try {
  // A slow first Save must not acknowledge newer edits: the snapshot is
  // written, but the buffer stays dirty until the newer text is saved too.
  await test("slow first Save keeps edits typed while the write is pending", async () => {
    await type("first");
    await page.evaluate(() => {
      window.__fs.slow = true;
      window.__fs.queueSave("first.txt");
    });
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => window.__fs.pendingClose === true);
    await compositionStart(); // suppress autosave while we inspect the race
    await type(" second");
    assert.equal(await dirty(), true);

    await page.evaluate(() => {
      window.__fs.slow = false;
      window.__fs.release();
    });
    await waitWrites(1);
    await page.waitForFunction(() => document.querySelector(".sb-save")?.dataset.state !== "saving");
    await settled();
    assert.equal((await writes())[0].content, "first");
    assert.equal(await dirty(), true, "stale save receipt must not clear dirty");
    assert.equal(await title(), "first.txt · - CotEditor");
    assert.equal(await stat("save"), "Not saved");

    await compositionEnd();
    await page.keyboard.press("Control+s");
    await waitWrites(2);
    await settled();
    assert.equal((await writes())[1].content, "first second");
    assert.equal(await dirty(), false);
    assert.equal(await stat("save"), "Saved");
  });

  // Save As cancels leave path/handle/dirty alone; a slow Save As commits the
  // new destination only after close, and later edits stay dirty.
  await test("Save As cancel and slow Save As preserve or commit the right target", async () => {
    await openFixture("a.txt", "alpha");
    await positionEnd();
    await compositionStart();
    await type("!");
    assert.equal(await dirty(), true);
    await compositionEnd();

    await page.evaluate(() => { window.__fs.saveCancel = true; });
    await page.keyboard.press("Control+Shift+S");
    await page.waitForFunction(() => document.querySelector(".sb-save")?.dataset.state === "unsaved");
    await settled();
    assert.equal(await title(), "a.txt · - CotEditor");
    assert.equal((await writes()).length, 0);
    assert.equal(await dirty(), true);

    await page.evaluate(() => {
      window.__fs.slow = true;
      window.__fs.queueSave("b.txt");
    });
    await page.keyboard.press("Control+Shift+S");
    await page.waitForFunction(() => window.__fs.pendingClose === true);
    await compositionStart();
    await type("?");
    await page.evaluate(() => {
      window.__fs.slow = false;
      window.__fs.release();
    });
    await waitWrites(1);
    await settled();
    assert.deepEqual((await writes())[0], { name: "b.txt", content: "alpha!" });
    assert.equal(await title(), "b.txt · - CotEditor");
    assert.equal(await dirty(), true);

    await compositionEnd();
    await page.keyboard.press("Control+s");
    await waitWrites(2);
    await settled();
    assert.deepEqual((await writes())[1], { name: "b.txt", content: "alpha!?" });
    assert.equal(await dirty(), false);
  });

  await test("failed write keeps path, handle and dirty; retry succeeds", async () => {
    await openFixture("fail.txt", "base");
    await positionEnd();
    await compositionStart();
    await type("+");
    await page.evaluate(() => { window.__fs.failNext = true; });
    await compositionEnd();
    await page.keyboard.press("Control+s");
    await page.locator(".ce-toast-error").filter({ hasText: "Could not save the file" }).waitFor();
    await page.waitForFunction(() => document.querySelector(".sb-save")?.dataset.state === "error");
    await settled();
    assert.equal((await writes()).length, 0);
    assert.equal(await title(), "fail.txt · - CotEditor");
    assert.equal(await dirty(), true);

    await page.keyboard.press("Control+s");
    await waitWrites(1);
    await settled();
    assert.deepEqual((await writes())[0], { name: "fail.txt", content: "base+" });
    assert.equal(await dirty(), false);
    assert.equal(await stat("save"), "Saved");
  });

  await test("cancelled Open preserves content, path and dirty state", async () => {
    await openFixture("keep.txt", "alpha");
    await positionEnd();
    await compositionStart();
    await type("beta");
    assert.equal(await dirty(), true);
    await compositionEnd();

    await page.evaluate(() => { window.__fs.openCancel = true; });
    await page.keyboard.press("Control+o");
    await page.waitForFunction(() => window.__fs.openCalls === 2);
    await page.waitForFunction(() => !document.querySelector(".ce-modal"));
    await settled();
    assert.equal(normalize(await text()), "alphabeta");
    assert.equal(await title(), "keep.txt · - CotEditor");
    assert.equal(await dirty(), true);
  });

  await test("Ctrl+N opens a new tab and preserves the dirty draft", async () => {
    await type("draft");
    assert.equal(await dirty(), true);
    await page.keyboard.press("Control+n");
    await page.waitForFunction(() =>
      document.querySelectorAll("#tabs .ce-tabs-tab").length === 2);
    await page.waitForFunction(() => document.title === "Untitled - CotEditor");
    assert.equal(await page.locator(".ce-modal").count(), 0, "new tab must not prompt");
    const tabState = await page.evaluate(() =>
      [...document.querySelectorAll("#tabs .ce-tabs-tab")].map((tab) => ({
        dirty: tab.dataset.dirty,
        active: tab.dataset.active,
      })));
    assert.deepEqual(tabState.map((tab) => tab.dirty), ["true", "false"]);
    assert.deepEqual(tabState.map((tab) => tab.active), ["false", "true"]);

    // Closing the clean new tab returns to the dirty draft without a prompt.
    await page.keyboard.press("Control+w");
    await page.waitForFunction(() =>
      document.querySelectorAll("#tabs .ce-tabs-tab").length === 1);
    await page.waitForFunction(() => document.title === "Untitled · - CotEditor");
    assert.equal(normalize(await text()), "draft");
    assert.equal(await dirty(), true);
    assert.equal(await page.locator(".ce-modal").count(), 0);
  });

  await test("file shortcuts need exact modifiers, ignore composition and modals", async () => {
    await type("draft");
    await page.keyboard.press("Control+Shift+N");
    await page.waitForTimeout(150);
    assert.equal(await page.locator(".ce-modal").count(), 0);
    assert.equal(await tabCount(), 1, "Ctrl+Shift+N must not create a tab");
    await page.keyboard.press("Control+Alt+s");
    await page.waitForTimeout(150);
    assert.equal((await writes()).length, 0);
    assert.equal(await dirty(), true);

    await compositionStart();
    await page.keyboard.press("Control+n");
    await page.waitForTimeout(150);
    assert.equal(await tabCount(), 1, "composition must not open tabs");
    assert.equal(await page.locator(".ce-modal").count(), 0);
    await compositionEnd();

    await page.keyboard.press("Control+n");
    await page.waitForFunction(() =>
      document.querySelectorAll("#tabs .ce-tabs-tab").length === 2);
    assert.equal(await page.locator(".ce-modal").count(), 0);
    await page.keyboard.press("Control+w");
    await page.waitForFunction(() =>
      document.querySelectorAll("#tabs .ce-tabs-tab").length === 1);

    await page.keyboard.press("Control+w");
    await page.locator(".ce-confirm-card").waitFor();
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(150);
    assert.equal(await page.locator(".ce-modal").count(), 1, "background shortcut must stay inert");
    assert.equal((await writes()).length, 0);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".ce-modal"));
    assert.equal(await tabCount(), 1);
    assert.equal(await dirty(), true);
  });

  await test("confirmation guard rejects a second dialog", async () => {
    await page.evaluate(async () => {
      const { confirmUnsavedChanges } = await import("/src/ui/confirm-dialog.ts");
      window.__confirmDecisions = [];
      void confirmUnsavedChanges("one.txt").then((d) => window.__confirmDecisions.push(d));
      void confirmUnsavedChanges("two.txt").then((d) => window.__confirmDecisions.push(d));
    });
    await page.waitForFunction(() => window.__confirmDecisions.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__confirmDecisions), ["cancel"]);
    assert.equal(await page.locator(".ce-modal").count(), 1);
    await page.locator('[data-decision="cancel"]').click();
    await page.waitForFunction(() => window.__confirmDecisions.length === 2);
    assert.deepEqual(await page.evaluate(() => window.__confirmDecisions), ["cancel", "cancel"]);
  });

  await test("Ctrl+F/H in preview return to the editor and open find", async () => {
    await openFixture("note.md", "# Title\n\nbody\n");
    await page.keyboard.press("Control+e");
    await page.waitForFunction(() =>
      document.querySelector("#editor > .monaco-editor")?.style.display === "none");
    await page.keyboard.press("Control+f");
    await page.waitForFunction(() =>
      document.querySelector("#editor > .monaco-editor")?.style.display === "");
    await page.waitForFunction(() => {
      const widget = document.querySelector(".find-widget");
      return !!widget && getComputedStyle(widget).display !== "none";
    });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+e");
    await page.waitForFunction(() =>
      document.querySelector("#editor > .monaco-editor")?.style.display === "none");
    await page.keyboard.press("Control+h");
    await page.waitForFunction(() =>
      document.querySelector("#editor > .monaco-editor")?.style.display === "");
    await page.waitForFunction(() => !!document.querySelector(".find-widget.replaceToggled"));
  });

  await test("UTF-8 BOM survives open and save; invalid UTF-8 is rejected", async () => {
    await openFixture("bom.txt", "héllo\r\nworld\r\n", true);
    assert.equal(normalize(await text()), "héllo\nworld\n");
    assert.equal(await stat("encoding"), "UTF-8 BOM");
    await positionEnd();
    await compositionStart();
    await type("!");
    await compositionEnd();
    await page.keyboard.press("Control+s");
    await waitWrites(1);
    await settled();
    const saved = (await writes())[0];
    assert.equal(saved.name, "bom.txt");
    assert.equal(saved.content, "\uFEFFhéllo\r\nworld\r\n!");

    await fresh();
    await page.evaluate(() => window.__fs.queueRaw("bad.txt", [0x66, 0x80, 0x6f]));
    await page.keyboard.press("Control+o");
    await page.locator(".ce-toast-error").filter({ hasText: "Could not open the file" }).waitFor();
    await settled();
    assert.equal(await page.evaluate(() =>
      window.__t.getEditor().getModel().getValue()), "");
    assert.equal(await title(), "Untitled - CotEditor");
  });

  await test("mixed EOL is read-only until explicit normalization", async () => {
    await openFixture("mixed.txt", "a\r\nb\nc\r\n");
    assert.equal(await readOnly(), true);
    assert.equal(await stat("eol"), "Mixed EOL");
    assert.equal(await stat("readonly"), "Read-only");

    await type("X");
    assert.equal(normalize(await text()), "a\nb\nc\n");
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(100);
    assert.equal((await writes()).length, 0, "protected format must not be written");
    assert.equal(await dirty(), false);

    await page.locator('[data-stat="normalize"]').click();
    await page.locator(".ce-confirm-card").waitFor();
    assert.equal(await page.locator('[data-decision="discard"]').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.decision), "cancel");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".ce-modal"));
    assert.equal(await readOnly(), true);

    await page.locator('[data-stat="normalize"]').click();
    await page.locator(".ce-confirm-card").waitFor();
    await page.locator('[data-decision="save"]').click();
    await page.waitForFunction(() => !window.__t.getEditor().getOption(
      window.__t.monaco.editor.EditorOption.readOnly));
    await settled();
    assert.equal(await stat("eol"), "LF");
    await positionEnd();
    await type("!");
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => window.__fs.writes.some((w) => w.content.includes("!")));
    const saved = (await writes()).at(-1);
    assert.equal(saved.content.includes("\r"), false);
    assert.equal(saved.content, "a\nb\nc\n!");
  });

  await test("undo back to the save point clears dirty and redo restores it", async () => {
    await type("abc");
    await page.evaluate(() => window.__fs.queueSave("undo.txt"));
    await page.keyboard.press("Control+s");
    await waitWrites(1);
    await settled();
    assert.equal(await dirty(), false);
    assert.equal(await title(), "undo.txt - CotEditor");

    await positionEnd();
    await compositionStart();
    await type("d");
    assert.equal(await dirty(), true);
    await compositionEnd();
    await page.keyboard.press("Control+z");
    await page.waitForFunction(() => !document.title.includes("·"));
    assert.equal(normalize(await text()), "abc");
    assert.equal(await stat("save"), "Saved");

    await page.keyboard.press("Control+y");
    await page.waitForFunction(() => document.title.includes("·"));
    assert.equal(normalize(await text()), "abcd");
    assert.equal(await dirty(), true);
    await compositionEnd();
  });

  await test("cursor movement reuses cached grapheme/byte statistics", async () => {
    await page.evaluate(() => {
      window.__t.getEditor().getModel().setValue("😀a\né");
      window.__t.getEditor().setPosition({ lineNumber: 1, column: 1 });
    });
    await page.waitForFunction(() => /Graphemes: \d+/.test(
      document.querySelector('[data-stat="characters"]')?.textContent ?? ""));
    assert.equal(await stat("characters"), "Graphemes: 4");
    assert.equal(await stat("bytes"), "8 B");
    const baseline = await page.evaluate(() => window.__fs.segmentCalls);
    assert.ok(baseline > 0, "non-ASCII stats must use the segmenter");

    await page.evaluate(() => {
      const { getEditor } = window.__t;
      for (let i = 0; i < 25; i++) {
        getEditor().setPosition(i % 2 ? { lineNumber: 1, column: 2 } : { lineNumber: 2, column: 2 });
      }
      getEditor().setPosition({ lineNumber: 2, column: 2 });
    });
    assert.equal(await stat("characters"), "Graphemes: 4");
    assert.equal(await stat("bytes"), "8 B");
    assert.equal(await page.evaluate(() => window.__fs.segmentCalls), baseline,
      "cursor movement must not re-run statistics");
    assert.equal(await stat("lines"), "Total lines: 2");
    assert.equal(await stat("cursor"), "Ln 2, Col 2");

    await positionEnd();
    await type("z");
    await page.waitForFunction(() => document.querySelector('[data-stat="characters"]')?.textContent === "Graphemes: 5");
    assert.equal(await stat("bytes"), "9 B");
    assert.ok(await page.evaluate(() => window.__fs.segmentCalls) > baseline);
    assert.equal(await page.locator(".sb-select-like").count(), 0);
  });

  await test("no unhandled runtime errors", async () => {
    assert.deepEqual(runtimeErrors, []);
  });
} finally {
  await browser.close();
}
console.log(failures.length
  ? `FAIL (${failures.length}): ${failures.join("; ")}`
  : "ALL DOCUMENT REGRESSIONS PASS");
process.exitCode = failures.length ? 1 : 0;
