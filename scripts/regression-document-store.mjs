// Multi-document store regressions. Runs against the Vite dev server:
//   node scripts/regression-document-store.mjs http://127.0.0.1:1420/
//
// The suite loads a blank fixture page (main.ts is never evaluated), imports
// monaco-setup + document-store through Vite, and drives a real Monaco editor.
// It verifies per-model undo stacks, per-document dirty state, view-state
// round-trips, removal/disposal, and CRLF / format-protection metadata.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1420/";
const origin = new URL(url).origin;
const fixturePath = "/document-store-regression.html";

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(12000);

const failures = [];
const runtimeErrors = [];
page.on("pageerror", (error) => {
  // Monaco's Delayer.dispose() rejects its pending promise with a "Canceled"
  // CancellationError when a model is disposed. It is internal Monaco teardown
  // noise (no caller can observe it), not a store failure.
  if (error.message === "Canceled") return;
  runtimeErrors.push(error.message);
});
// Vite's HMR client and Monaco's worker requests are irrelevant to this suite:
// the fixture page is fulfilled locally, so the HMR socket is blocked and
// pending resource fetches are reported as "Canceled" on teardown.
const ignoredConsole = [
  /WebSocket connection to .* failed/,
  /ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS/,
  /\[vite\] failed to connect to websocket/,
];
page.on("console", (message) => {
  const text = message.text();
  if (message.type() !== "error") return;
  if (ignoredConsole.some((pattern) => pattern.test(text))) return;
  runtimeErrors.push(text);
});

// Serve a blank same-origin page so dynamic imports resolve against Vite while
// the application entry point (and its single-document state) stays out of the
// picture. The route is fulfilled locally; nothing is added to the repo.
await page.route(`**${fixturePath}`, (route) =>
  route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html>
<html><head><meta charset="utf-8"><title>document-store regression</title>
<style>html,body{margin:0;padding:0}#editor{width:900px;height:600px}</style>
</head><body><div id="editor"></div></body></html>`,
  }),
);

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

async function boot() {
  await page.goto(`${origin}${fixturePath}`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    const setup = await import("/src/editor/monaco-setup.ts");
    await setup.setupMonaco();
    const syntaxMap = await import("/src/lib/syntax-map.ts");
    await syntaxMap.initSyntaxMap();
    const storeModule = await import("/src/lib/document-store.ts");

    const editor = setup.getEditor();
    editor.updateOptions({
      autoClosingBrackets: "never",
      autoClosingQuotes: "never",
      quickSuggestions: false,
      // Model swaps cancel Monaco's caret/scroll delayers; with animations on,
      // those cancellations surface as unhandled "Canceled" rejections.
      cursorSmoothCaretAnimation: "off",
      cursorBlinking: "solid",
      smoothScrolling: false,
    });

    window.__m = setup.monaco;
    window.__editor = editor;
    window.__DocumentStore = storeModule.DocumentStore;
    window.__refs = {};
    window.__snap = (doc) => {
      if (doc.model.isDisposed()) return { id: doc.id, disposed: true };
      const position = window.__editor.getPosition();
      const selection = window.__editor.getSelection();
      return {
        id: doc.id,
        disposed: false,
        path: doc.path,
        value: doc.model.getValue(),
        eol: doc.model.getEOL(),
        language: doc.model.getLanguageId(),
        encoding: doc.encoding,
        lineEnding: doc.lineEnding,
        mixed: doc.mixed,
        hasBOM: doc.hasBOM,
        protectedOriginal: doc.protectedOriginal,
        formatProtection: doc.formatProtection,
        savedAlternativeVersion: doc.savedAlternativeVersion,
        savedFormatVersion: doc.savedFormatVersion,
        formatVersion: doc.formatVersion,
        dirty: doc.dirty,
        saveState: doc.saveState,
        conflict: doc.conflict,
        recoveryId: doc.recoveryId,
        viewState: doc.viewState === null ? "null" : "saved",
        alternativeVersion: doc.model.getAlternativeVersionId(),
        active: window.__store.getActive() === doc,
        isEditorModel: window.__editor.getModel() === doc.model,
        lineCount: doc.model.getLineCount(),
        position,
        selection,
      };
    };
    window.__store = new storeModule.DocumentStore(editor);
  });
  await page.waitForFunction(() => !!window.__store);
}

async function fresh() {
  await page.evaluate(() => {
    window.__store.dispose();
    window.__store = new window.__DocumentStore(window.__editor);
    window.__refs = {};
  });
}

const seed = (overrides = {}) => ({
  path: null,
  content: "",
  encoding: "UTF-8",
  lineEnding: "LF",
  mixed: false,
  hasBOM: false,
  protectedOriginal: null,
  formatProtection: null,
  ...overrides,
});

async function create(name, overrides = {}) {
  return page.evaluate(({ name, seed }) => {
    const doc = window.__store.create(seed);
    window.__refs[name] = doc;
    return window.__snap(doc);
  }, { name, seed: seed(overrides) });
}

const snap = (name) =>
  page.evaluate((name) => window.__snap(window.__refs[name]), name);

const activate = (name) =>
  page.evaluate((name) => window.__store.activate(window.__refs[name].id), name);

async function edit(name, text) {
  await page.evaluate(({ name, text }) => {
    const doc = window.__refs[name];
    window.__store.activate(doc.id);
    const model = doc.model;
    const line = model.getLineCount();
    const column = model.getLineMaxColumn(line);
    window.__editor.executeEdits("regression", [{
      range: new window.__m.Range(line, column, line, column),
      text,
      forceMoveMarkers: true,
    }]);
    window.__editor.pushUndoStop();
    window.__store.reconcileDirty(doc.id);
  }, { name, text });
}

async function undo(name) {
  await page.evaluate((name) => {
    const doc = window.__refs[name];
    window.__store.activate(doc.id);
    window.__editor.trigger("regression", "undo", null);
    window.__store.reconcileDirty(doc.id);
  }, name);
}

try {
  await boot();

  await test("create builds a model, applies path language and a clean baseline", async () => {
    const a = await create("a", { path: "C:\\work\\main.ts", content: "const a = 1;\n" });
    assert.equal(a.language, "typescript");
    assert.equal(a.isEditorModel, true, "first document becomes the editor model");
    assert.equal(a.active, true);
    assert.equal(a.viewState, "saved", "initial view state is captured");
    assert.equal(a.dirty, false);
    assert.equal(a.saveState, "saved");
    assert.equal(a.savedAlternativeVersion, a.alternativeVersion);
    assert.equal(a.savedFormatVersion, 0);
    assert.equal(a.formatVersion, 0);
    assert.equal(a.encoding, "UTF-8");
    assert.equal(a.conflict, false);
    assert.equal(a.recoveryId, "");

    const b = await create("b", { path: "notes.md", content: "# B\n" });
    assert.equal(b.language, "markdown");
    assert.equal(b.active, false, "background documents are not activated");
    assert.equal(b.viewState, "null");
    assert.equal((await snap("a")).isEditorModel, true);

    const untitled = await create("untitled");
    assert.equal(untitled.language, "plaintext");
    assert.equal(untitled.saveState, "idle");

    assert.deepEqual(
      await page.evaluate(() => window.__store.list().map((doc) => doc.id)),
      [a.id, b.id, untitled.id],
    );
    // list() is a snapshot; mutating it must not corrupt the store.
    assert.equal(await page.evaluate(() => {
      const list = window.__store.list();
      list.length = 0;
      return window.__store.list().length;
    }), 3);
    assert.equal(await page.evaluate(() => window.__store.get("missing")), null);
  });

  await test("activate swaps models and re-applies the path language", async () => {
    const a = await create("a", { path: "a.ts", content: "a\n" });
    const b = await create("b", { path: "b.md", content: "b\n" });
    assert.equal(await page.evaluate(() =>
      window.__editor.getModel().getLanguageId()), "typescript");

    assert.equal(await activate("b"), true);
    let current = await page.evaluate(() => ({
      language: window.__editor.getModel().getLanguageId(),
      value: window.__editor.getModel().getValue(),
      activeId: window.__store.getActive().id,
    }));
    assert.deepEqual(current.language, "markdown");
    assert.equal(current.value, "b\n");
    assert.equal(current.activeId, b.id);

    assert.equal(await activate("a"), true);
    current = await page.evaluate(() => ({
      language: window.__editor.getModel().getLanguageId(),
      value: window.__editor.getModel().getValue(),
      activeId: window.__store.getActive().id,
    }));
    assert.equal(current.language, "typescript");
    assert.equal(current.value, "a\n");
    assert.equal(current.activeId, a.id);
    assert.equal(await page.evaluate(() =>
      window.__store.activate("missing")), false);
  });

  await test("per-model undo history survives switching", async () => {
    await create("a", { content: "one" });
    await create("b", { content: "two" });

    await edit("a", "A1");
    await edit("a", "A2");
    await edit("b", "B1");

    await undo("a");
    let a = await snap("a");
    let b = await snap("b");
    assert.equal(a.value, "oneA1", "undo applies one group at a time on a");
    assert.equal(b.value, "twoB1", "editing a must not touch b");

    await undo("b");
    a = await snap("a");
    b = await snap("b");
    assert.equal(b.value, "two", "b has its own undo stack");
    assert.equal(a.value, "oneA1", "undoing b must not touch a");

    await undo("a");
    assert.equal((await snap("a")).value, "one");
    assert.equal((await snap("b")).value, "two");
  });

  await test("switching preserves cursor, selection and scroll", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    await create("a", { content: lines });
    await create("b", { content: "short\n" });

    const before = await page.evaluate(() => {
      const doc = window.__refs.a;
      window.__store.activate(doc.id);
      window.__editor.setSelection(new window.__m.Selection(50, 2, 60, 4));
      window.__editor.setScrollPosition({ scrollTop: 420 });
      return {
        position: window.__editor.getPosition(),
        selection: window.__editor.getSelection(),
        scrollTop: window.__editor.getScrollTop(),
      };
    });
    assert.ok(before.scrollTop > 0);

    await activate("b");
    await page.waitForTimeout(50);
    await activate("a");
    await page.waitForTimeout(50);
    const after = await page.evaluate(() => ({
      position: window.__editor.getPosition(),
      selection: window.__editor.getSelection(),
      scrollTop: window.__editor.getScrollTop(),
    }));

    assert.deepEqual(after.position, before.position, "cursor must be restored");
    assert.deepEqual(after.selection, before.selection, "selection must be restored");
    assert.ok(Math.abs(after.scrollTop - before.scrollTop) <= 5,
      `scroll must be restored (before ${before.scrollTop}, after ${after.scrollTop})`);
  });

  await test("dirty is tracked per document from alternative and format versions", async () => {
    await create("a");
    await create("b");

    await edit("a", "x");
    let a = await snap("a");
    let b = await snap("b");
    assert.equal(a.dirty, true);
    assert.equal(b.dirty, false, "editing a leaves b clean");

    await edit("b", "y");
    assert.equal((await snap("b")).dirty, true);

    await undo("a");
    a = await snap("a");
    b = await snap("b");
    assert.equal(a.dirty, false, "undo back to the baseline clears dirty");
    assert.equal(a.value, "");
    assert.equal(b.dirty, true, "b stays dirty after a is reconciled");

    await undo("b");
    assert.equal((await snap("b")).dirty, false);

    // A format-version bump is dirty even when the text did not change.
    await page.evaluate(() => {
      const doc = window.__refs.a;
      window.__store.updateMeta(doc.id, { formatVersion: 1 });
    });
    assert.equal((await snap("a")).dirty, false, "updateMeta must not recompute dirty itself");
    assert.equal(await page.evaluate(() =>
      window.__store.reconcileDirty(window.__refs.a.id)), true);
    await page.evaluate(() => {
      const doc = window.__refs.a;
      window.__store.updateMeta(doc.id, { formatVersion: 0 });
      window.__store.reconcileDirty(doc.id);
    });
    assert.equal((await snap("a")).dirty, false);
  });

  await test("CRLF / CR / mixed / BOM metadata is preserved without dirtying", async () => {
    const crlf = await create("crlf", {
      path: "crlf.txt",
      content: "a\r\nb\r\n",
      lineEnding: "CRLF",
    });
    assert.equal(crlf.eol, "\r\n");
    assert.equal(crlf.value, "a\r\nb\r\n");
    assert.equal(crlf.lineEnding, "CRLF");
    assert.equal(crlf.dirty, false);
    assert.equal(crlf.savedAlternativeVersion, crlf.alternativeVersion);

    const cr = await create("cr", {
      path: "cr.txt",
      content: "a\rb",
      lineEnding: "CR",
    });
    assert.equal(cr.lineEnding, "CR");
    assert.equal(cr.eol, "\n", "Monaco buffers cannot hold lone CR");
    assert.equal(cr.value, "a\nb");
    assert.equal(cr.dirty, false);

    const mixedText = "a\r\nb\nc";
    const mixed = await create("mixed", {
      path: "mixed.txt",
      content: mixedText,
      lineEnding: "LF",
      mixed: true,
      protectedOriginal: mixedText,
      formatProtection: "mixed",
    });
    assert.equal(mixed.value, "a\nb\nc", "model content is normalized");
    assert.equal(mixed.mixed, true);
    assert.equal(mixed.formatProtection, "mixed");
    assert.equal(mixed.protectedOriginal, mixedText);
    assert.equal(mixed.dirty, false, "protection alone does not make a document dirty");
    assert.equal(mixed.saveState, "saved");

    const bom = await create("bom", {
      path: "bom.txt",
      content: "\uFEFFhéllo",
      encoding: "UTF-16 LE",
      hasBOM: false,
      protectedOriginal: "\uFEFFhéllo",
      formatProtection: "encoding",
    });
    assert.equal(bom.value, "héllo", "BOM is stripped before Monaco sees the buffer");
    assert.equal(bom.hasBOM, true, "a leading BOM is detected even when the seed omits it");
    assert.equal(bom.encoding, "UTF-16 LE");
    assert.equal(bom.formatProtection, "encoding");
    assert.equal(bom.dirty, false);
  });

  await test("updateMeta changes encoding, BOM, EOL, conflict and recovery slots", async () => {
    const a = await create("a", { path: "a.txt", content: "x\ny\n" });
    assert.equal(await page.evaluate(() => window.__store.updateMeta(
      window.__refs.a.id,
      {
        encoding: "GB18030",
        hasBOM: true,
        lineEnding: "CRLF",
        conflict: true,
        recoveryId: "draft-7",
      },
    )), true);

    const updated = await snap("a");
    assert.equal(updated.encoding, "GB18030");
    assert.equal(updated.hasBOM, true);
    assert.equal(updated.lineEnding, "CRLF");
    assert.equal(updated.eol, "\r\n");
    assert.equal(updated.value, "x\r\ny\r\n");
    assert.equal(updated.conflict, true);
    assert.equal(updated.recoveryId, "draft-7");
    assert.equal(updated.dirty, false, "metadata updates do not recompute dirty on their own");

    assert.equal(await page.evaluate(() =>
      window.__store.reconcileDirty(window.__refs.a.id)), true,
      "the EOL change bumps the alternative version");
    assert.equal(await page.evaluate(() =>
      window.__store.updateMeta("missing", { encoding: "x" })), false);
    assert.equal(await page.evaluate(() => window.__store.get("missing")), null);
  });

  await test("remove disposes the model and leaves the next document to the caller", async () => {
    await create("a", { path: "a.txt", content: "a" });
    const b = await create("b", { path: "b.txt", content: "b" });
    await activate("a");

    assert.equal(await page.evaluate(() =>
      window.__store.remove(window.__refs.a.id)), true);
    const afterRemove = await page.evaluate(() => ({
      disposed: window.__refs.a.model.isDisposed(),
      get: window.__store.get(window.__refs.a.id),
      active: window.__store.getActive(),
      editorModel: window.__editor.getModel(),
      list: window.__store.list().length,
      activateRemoved: window.__store.activate(window.__refs.a.id),
      removeAgain: window.__store.remove(window.__refs.a.id),
    }));
    assert.equal(afterRemove.disposed, true);
    assert.equal(afterRemove.get, null);
    assert.equal(afterRemove.active, null);
    assert.equal(afterRemove.editorModel, null);
    assert.equal(afterRemove.list, 1);
    assert.equal(afterRemove.activateRemoved, false);
    assert.equal(afterRemove.removeAgain, false);

    // Removing a background document keeps the active one attached.
    assert.equal(await activate("b"), true);
    await create("c", { content: "c" });
    await page.evaluate(() => window.__store.remove(window.__refs.c.id));
    assert.equal((await snap("b")).isEditorModel, true);
    assert.equal((await snap("b")).id, b.id);
  });

  await test("dispose releases every model and makes the store unusable", async () => {
    await create("a", { content: "a" });
    await create("b", { content: "b" });
    const result = await page.evaluate(() => {
      const store = window.__store;
      store.dispose();
      let createError = null;
      try {
        store.create({ path: null, content: "", encoding: "UTF-8", lineEnding: "LF",
          mixed: false, hasBOM: false, protectedOriginal: null, formatProtection: null });
      } catch (error) {
        createError = String(error.message || error);
      }
      return {
        list: store.list().length,
        active: store.getActive(),
        disposed: [
          window.__refs.a.model.isDisposed(),
          window.__refs.b.model.isDisposed(),
        ],
        editorModel: window.__editor.getModel(),
        activate: store.activate(window.__refs.a.id),
        updateMeta: store.updateMeta(window.__refs.a.id, { encoding: "x" }),
        reconcileDirty: store.reconcileDirty(window.__refs.a.id),
        setViewState: store.setViewState(window.__refs.a.id, null),
        createError,
      };
    });
    assert.equal(result.list, 0);
    assert.equal(result.active, null);
    assert.deepEqual(result.disposed, [true, true]);
    assert.equal(result.editorModel, null);
    assert.equal(result.activate, false);
    assert.equal(result.updateMeta, false);
    assert.equal(result.reconcileDirty, false);
    assert.equal(result.setViewState, false);
    assert.match(result.createError, /disposed/);
    assert.equal(await page.evaluate(() => window.__store.dispose()), undefined,
      "dispose is idempotent");
  });

  await test("setViewState applies a stored state to the active document", async () => {
    const long = Array.from({ length: 80 }, (_, i) => `l${i}`).join("\n");
    await create("a", { content: long });
    await create("b", { content: long });
    const applied = await page.evaluate(() => {
      const viewState = window.__editor.saveViewState?.();
      window.__store.activate(window.__refs.a.id);
      window.__editor.setPosition({ lineNumber: 40, column: 3 });
      const stored = window.__editor.saveViewState();
      window.__store.setViewState(window.__refs.b.id, stored);
      window.__store.activate(window.__refs.b.id);
      return {
        applied: window.__store.setViewState(window.__refs.b.id, stored),
        position: window.__editor.getPosition(),
        activeId: window.__store.getActive().id,
        hasInitial: viewState !== null,
        missing: window.__store.setViewState("missing", null),
      };
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.position.lineNumber, 40);
    assert.equal(applied.activeId, (await snap("b")).id);
    assert.equal(applied.hasInitial, true);
    assert.equal(applied.missing, false);
  });

  await test("no unhandled runtime errors", async () => {
    assert.deepEqual(runtimeErrors, []);
  });
} finally {
  await browser.close();
}

console.log(failures.length
  ? `FAIL (${failures.length}): ${failures.join("; ")}`
  : "ALL DOCUMENT STORE REGRESSIONS PASS");
process.exitCode = failures.length ? 1 : 0;
