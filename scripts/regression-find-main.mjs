// Find-all (Ctrl+Shift+F) main-pipeline regressions.
// Run against the Vite dev server:
//   node scripts/regression-find-main.mjs http://127.0.0.1:1420/
//
// Exercises the wiring in main.ts: the Edit ▸ Find All in Document menu item,
// the Ctrl+Shift+F shortcut, the #find-results overlay, click/Enter navigation,
// Escape dismissal, clearing on document/content switches, the preview-only
// replace callback and the untouched Monaco Ctrl+F widget.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1420/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);

const failures = [];
const errors = [];
page.on("pageerror", (error) => {
  // Match the preview suite: Monaco reports a benign "Canceled" rejection when
  // a widget/editor operation is superseded.
  if (error.message === "Canceled") return;
  errors.push(error.message);
});
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

const HOST = "#find-results";
const ROOT = `${HOST} .ce-find-results`;
const ITEM = `${HOST} .ce-find-results-item`;
const COUNT = `${HOST} .ce-find-results-count`;

async function test(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.stack || error}`);
    await page.keyboard.press("Escape").catch(() => {});
  }
}

async function bindEditor() {
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#menubar > .ce-menu-item").length > 0 &&
      !!document.querySelector("#editor .monaco-editor"),
  );
  await page.evaluate(async () => {
    // Bind to the exact URL main.ts loaded, otherwise the dynamic import gets a
    // second monaco-setup instance with no editor.
    const pick = (suffix) =>
      [
        ...new Set(performance.getEntriesByType("resource").map((entry) => entry.name)),
      ]
        .filter((name) => name.includes(suffix))
        .pop() ?? suffix;
    window.__findMain = await import(pick("/src/editor/monaco-setup.ts"));
  });
}

async function setDocument(text) {
  await page.evaluate((value) => {
    const { getEditor, monaco } = window.__findMain;
    const editor = getEditor();
    editor.getModel().setValue(value);
    editor.setSelection(new monaco.Selection(1, 1, 1, 1));
    editor.focus();
  }, text);
}

async function selectRange(startLine, startColumn, endLine, endColumn) {
  await page.evaluate(({ startLine, startColumn, endLine, endColumn }) => {
    const { getEditor, monaco } = window.__findMain;
    const editor = getEditor();
    editor.setSelection(new monaco.Selection(startLine, startColumn, endLine, endColumn));
    editor.focus();
  }, { startLine, startColumn, endLine, endColumn });
}

async function selectWord(line, column, length) {
  await selectRange(line, column, line, column + length);
}

async function modelValue() {
  return page.evaluate(() => window.__findMain.getEditor().getModel().getValue());
}

async function selection() {
  return page.evaluate(() => {
    const value = window.__findMain.getEditor().getSelection();
    return {
      startLineNumber: value.startLineNumber,
      startColumn: value.startColumn,
      endLineNumber: value.endLineNumber,
      endColumn: value.endColumn,
    };
  });
}

async function waitMatches(count) {
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelectorAll(selector).length === expected,
    { selector: ITEM, expected: count },
  );
}

async function waitHidden() {
  await page.waitForFunction((selector) => {
    const root = document.querySelector(selector);
    return !root || root.hidden;
  }, ROOT);
}

async function openEditMenu() {
  await page.locator("#menubar > .ce-menu-item").filter({ hasText: /^(编辑|Edit)$/ }).click();
  await page.waitForSelector(".ce-menu-dropdown");
}

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await bindEditor();

  await test("Ctrl+Shift+F searches the selection and shows line/context results", async () => {
    await setDocument("alpha foo beta\nsecond line\nfoo again foo");
    await selectWord(1, 7, 3);
    await page.keyboard.press("Control+Shift+F");
    await waitMatches(3);

    assert.equal(await page.locator(ROOT).isVisible(), true);
    assert.match(await page.locator(COUNT).textContent(), /3/);
    assert.equal(await page.locator(`${HOST} .ce-find-results-match`).count(), 3);
    assert.deepEqual(
      await page.locator(`${HOST} .ce-find-results-line`).allTextContents(),
      ["1", "3", "3"],
    );
    const contexts = await page.locator(`${HOST} .ce-find-results-context`).allTextContents();
    assert.match(contexts[0], /alpha foo beta/);
    assert.match(contexts[2], /foo again foo/);
    assert.equal(
      await page.evaluate(() => window.__coteditor.findResults().count),
      3,
      "debug surface reports the rendered match count",
    );
  });

  await test("click and Enter jump to the match and select it", async () => {
    await page.locator(ITEM).nth(1).click();
    assert.deepEqual(await selection(), {
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 4,
    });

    await page.locator(ITEM).nth(2).focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await selection(), {
      startLineNumber: 3,
      startColumn: 11,
      endLineNumber: 3,
      endColumn: 14,
    });
  });

  await test("Edit menu item runs the same find-all command", async () => {
    await page.keyboard.press("Escape");
    await waitHidden();
    await setDocument("one foo\ntwo foo\nthree foo");
    await selectWord(3, 7, 3);
    await openEditMenu();
    await page.locator(".ce-menu-dropdown button")
      .filter({ hasText: /在文档中查找全部|Find All in Document/ })
      .click();
    await waitMatches(3);
    assert.deepEqual(
      await page.locator(`${HOST} .ce-find-results-line`).allTextContents(),
      ["1", "2", "3"],
    );
  });

  await test("Escape closes the list from the editor", async () => {
    await page.evaluate(() => window.__findMain.getEditor().focus());
    await page.keyboard.press("Escape");
    await waitHidden();
    assert.equal(await page.locator(ITEM).count(), 0);
  });

  await test("switching the active document clears results", async () => {
    await setDocument("foo one\nfoo two");
    await selectWord(1, 1, 3);
    await page.keyboard.press("Control+Shift+F");
    await waitMatches(2);

    await page.keyboard.press("Control+n");
    await page.waitForFunction(() => document.querySelectorAll("#tabs .ce-tabs-tab").length === 2);
    await waitHidden();
    assert.equal(await page.locator(ITEM).count(), 0);

    await page.keyboard.press("Control+1");
    await page.waitForFunction(() =>
      window.__findMain.getEditor().getModel().getValue().startsWith("foo one"));
    await waitHidden();
  });

  await test("editing the buffer clears stale result offsets", async () => {
    await selectWord(1, 1, 3);
    await page.keyboard.press("Control+Shift+F");
    await waitMatches(2);
    await page.evaluate(() => {
      const model = window.__findMain.getEditor().getModel();
      model.setValue(`${model.getValue()}\nfoo three`);
    });
    await waitHidden();
    assert.equal(await page.locator(ITEM).count(), 0);
  });

  await test("replace-all is a preview callback only", async () => {
    await setDocument("x x\nx");
    await selectWord(1, 1, 1);
    await page.keyboard.press("Control+Shift+F");
    await waitMatches(3);
    const before = await modelValue();

    page.once("dialog", (dialog) => void dialog.accept("y"));
    await openEditMenu();
    await page.locator(".ce-menu-dropdown button")
      .filter({ hasText: /替换全部预览|Preview Replace All/ })
      .click();
    await page.waitForSelector(".ce-toast-copy");
    const toast = await page.locator(".ce-toast-copy").first().textContent();
    assert.match(toast, /3/);
    assert.equal(await modelValue(), before, "preview must never edit the document");
  });

  await test("Monaco's own Ctrl+F widget still opens independently", async () => {
    await page.evaluate(() => window.__findMain.getEditor().focus());
    await page.keyboard.press("Escape");
    await waitHidden();
    await page.keyboard.press("Control+f");
    await page.waitForFunction(() => !!document.querySelector(".find-widget.visible"));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".find-widget.visible"));
    // Ctrl+F did not create find-all results.
    await waitHidden();
  });

  await test("native bridge: Open with Encoding and runtime file drop open documents", async () => {
    const nativeContext = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    const nativePage = await nativeContext.newPage();
    nativePage.setDefaultTimeout(15000);
    try {
      await nativePage.addInitScript(() => {
        window.__encCalls = [];
        window.__openCalls = [];
        window.__dropUseTarget = null;
        window.__dropCallback = null;
        const content = (path, body) => ({
          path,
          content: body,
          encoding: "UTF-8",
          line_ending: "lf",
          mixed_line_ending: false,
        });
        window.go = {
          main: {
            App: {
              StartupFile: async () => "",
              NewFile: async () => content("", ""),
              OpenPath: async (path) => {
                window.__openCalls.push(path);
                return content(path, `dropped ${path}`);
              },
              OpenPathWithEncoding: async (path) => content(path, "reopened"),
              OpenFileWithEncoding: async (encoding) => {
                window.__encCalls.push(encoding);
                return content("C:\\work\\gb.txt", "gb body");
              },
              FileStamp: async () => ({ exists: true, size: 1, mod_time: 1 }),
              SetSessionDirty: async () => {},
              SetDocumentState: async () => {},
              ReadAssetBase64: async () => ({ path: "", mime: "", data: "", size: 0 }),
              SaveFileChecked: async (path) => path,
              SaveAsChecked: async () => "C:\\work\\saved.txt",
              SaveFileWithEncoding: async (path) => path,
              SaveAsWithEncoding: async () => "C:\\work\\saved.txt",
            },
          },
        };
        window.runtime = {
          EventsOn: () => () => {},
          EventsOnMultiple: () => () => {},
          EventsOff: () => {},
          EventsOffAll: () => {},
          WindowSetTitle: () => {},
          WindowSetLightTheme: () => {},
          WindowSetDarkTheme: () => {},
          BrowserOpenURL: () => {},
          Quit: () => {},
          OnFileDrop: (callback, useDropTarget) => {
            window.__dropCallback = callback;
            window.__dropUseTarget = useDropTarget;
          },
          OnFileDropOff: () => {},
        };
      });
      await nativePage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await nativePage.waitForFunction(() =>
        document.querySelectorAll("#menubar > .ce-menu-item").length > 0
        && !!document.querySelector("#editor .monaco-editor"));

      // File ▸ Open with Encoding ▸ GB18030
      await nativePage.locator("#menubar > .ce-menu-item")
        .filter({ hasText: /^(文件|File)$/ }).click();
      await nativePage.locator('.ce-menu-dropdown button[aria-haspopup="menu"]').click();
      await nativePage.waitForSelector(".ce-submenu");
      await nativePage.locator('.ce-submenu [data-menu-action="openEncoding-GB18030"]').click();
      await nativePage.waitForFunction(() =>
        window.__encCalls.includes("GB18030")
        && document.getElementById("statusbar")?.textContent?.includes("gb.txt"));
      assert.deepEqual(await nativePage.evaluate(() => window.__encCalls), ["GB18030"]);
      assert.equal(await nativePage.evaluate(() =>
        document.querySelectorAll("#tabs .ce-tabs-tab").length), 1);

      // Wails runtime drop: the callback is registered once with no DOM drop
      // target restriction and paths go through openExternalPaths.
      assert.equal(await nativePage.evaluate(() => window.__dropUseTarget), false);
      await nativePage.evaluate(() =>
        window.__dropCallback(10, 10, ["C:\\work\\a.txt", "C:\\work\\b.txt"]));
      await nativePage.waitForFunction(() =>
        window.__openCalls.length === 2
        && document.querySelectorAll("#tabs .ce-tabs-tab").length === 3);
      assert.deepEqual(
        await nativePage.evaluate(() => window.__openCalls),
        ["C:\\work\\a.txt", "C:\\work\\b.txt"],
      );

      // Drag affordance appears only while a file drag is active.
      await nativePage.evaluate(() => {
        const data = new DataTransfer();
        data.items.add(new File(["x"], "x.txt", { type: "text/plain" }));
        window.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: data }));
      });
      assert.equal(await nativePage.evaluate(() =>
        document.getElementById("app").classList.contains("ce-file-drop-target")), true);
      await nativePage.evaluate(() => {
        const data = new DataTransfer();
        data.items.add(new File(["x"], "x.txt", { type: "text/plain" }));
        window.dispatchEvent(new DragEvent("dragleave", { bubbles: true, dataTransfer: data }));
      });
      assert.equal(await nativePage.evaluate(() =>
        document.getElementById("app").classList.contains("ce-file-drop-target")), false);
    } finally {
      await nativeContext.close();
    }
  });

  await test("no unhandled runtime errors", async () => {
    assert.deepEqual(errors, []);
  });
} catch (error) {
  failures.push("suite setup");
  console.error(error.stack || error);
  if (errors.length) console.error("Runtime errors:", errors);
} finally {
  await browser.close();
}

console.log(
  failures.length
    ? `FAIL (${failures.length}): ${failures.join("; ")}`
    : "ALL FIND-MAIN REGRESSIONS PASS",
);
process.exitCode = failures.length ? 1 : 0;
