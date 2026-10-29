// Multi-tab application regressions (phase C).
//
// Runs against the Vite dev server:
//   node scripts/regression-tabs.mjs http://127.0.0.1:1420/
//
// The suite boots the real app with a Wails-compatible in-memory mock: file
// dialogs, encoding-aware saves, session-dirty calls and Quit are captured in
// JS, never touching the real filesystem. This is a Chromium regression; it is
// NOT native WebView2/IME acceptance.
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
  // Monaco cancels internal caret/scroll delayers when a tab model is disposed.
  if (error.message === "Canceled") return;
  runtimeErrors.push(error.message);
});
page.on("console", (message) => {
  if (message.type() !== "error") return;
  // Stale recent entries and cancelled save-all flows are deliberate below.
  if (/open failed:|save failed:/.test(message.text())) return;
  runtimeErrors.push(message.text());
});

await context.addInitScript(() => {
  try {
    localStorage.setItem("coteditor.lang.v1", "en");
    localStorage.removeItem("coteditor.recent.v1");
    localStorage.removeItem("coteditor.settings.v1");
  } catch { /* opaque origin */ }

  const state = {
    files: new Map(),
    openQueue: [],
    saveAsQueue: [],
    writes: [],
    session: [],
    quits: 0,
    startupPath: null,
    handlers: {},
    modSerial: 0,
    recovery: [],
  };
  window.__mock = state;

  const key = (path) => path.replace(/\//g, "\\").toLowerCase();
  const mixed = (text) => new Set(text.match(/\r\n|\r|\n/g) ?? []).size > 1;
  const makeFile = (path, content, encoding = "UTF-8", mixedFlag = null) => ({
    path,
    content,
    encoding,
    line_ending: content.includes("\r\n") ? "crlf" : content.includes("\r") ? "cr" : "lf",
    mixed_line_ending: mixedFlag === null ? mixed(content) : mixedFlag,
    mod_time: ++state.modSerial,
  });
  const stamp = (file) => ({
    exists: !!file,
    size: file ? new TextEncoder().encode(file.content).byteLength : 0,
    mod_time: file ? file.mod_time : 0,
  });

  const startup = localStorage.getItem("coteditor.test.startup");
  if (startup) {
    const content = localStorage.getItem("coteditor.test.startup.content") ?? "";
    const encoding = localStorage.getItem("coteditor.test.startup.encoding") ?? "UTF-8";
    state.startupPath = startup;
    state.files.set(key(startup), makeFile(startup, content, encoding));
  }
  localStorage.removeItem("coteditor.test.startup");
  localStorage.removeItem("coteditor.test.startup.content");
  localStorage.removeItem("coteditor.test.startup.encoding");

  window.__test = {
    addFile(path, content, encoding = "UTF-8", mixedFlag = null) {
      state.files.set(key(path), makeFile(path, content, encoding, mixedFlag));
    },
    queueOpen(path, content, encoding = "UTF-8", mixedFlag = null) {
      state.openQueue.push(makeFile(path, content, encoding, mixedFlag));
    },
    queueSaveAs(path) {
      state.saveAsQueue.push(path);
    },
    emit(name, ...args) {
      for (const handler of state.handlers[name] ?? []) handler(...args);
    },
  };

  const app = {
    OpenFile() {
      const next = state.openQueue.shift();
      if (!next) {
        return { path: null, content: "", encoding: "UTF-8", line_ending: "lf", mixed_line_ending: false };
      }
      return { ...next };
    },
    OpenPath(path) {
      const found = state.files.get(key(path));
      if (!found) throw new Error(`ENOENT: no such file: ${path}`);
      return { ...found };
    },
    OpenFileWithEncoding() { return app.OpenFile(); },
    OpenPathWithEncoding(path) { return app.OpenPath(path); },
    SaveFileWithEncoding(path, content, encoding) {
      state.writes.push({ path, content, encoding });
      state.files.set(key(path), makeFile(path, content, encoding, false));
      return path;
    },
    SaveFileChecked(path, content, encoding, expectedSize, expectedModTime) {
      const current = stamp(state.files.get(key(path)));
      if (expectedSize >= 0) {
        const sizeOk = expectedSize === (current.exists ? current.size : 0);
        const timeOk = expectedModTime < 0 || expectedModTime === current.mod_time;
        if (!current.exists && (expectedSize !== 0 || expectedModTime !== 0)) {
          throw new Error(`FILE_CONFLICT: ${path} no longer exists`);
        }
        if (current.exists && (!sizeOk || !timeOk)) {
          throw new Error(`FILE_CONFLICT: ${path} changed on disk`);
        }
      }
      state.writes.push({ path, content, encoding });
      state.files.set(key(path), makeFile(path, content, encoding, false));
      return path;
    },
    SaveAsWithEncoding(content, encoding) {
      const path = state.saveAsQueue.shift();
      if (!path) return "";
      state.writes.push({ path, content, encoding });
      state.files.set(key(path), makeFile(path, content, encoding, false));
      return path;
    },
    SaveAsChecked(content, encoding) {
      return app.SaveAsWithEncoding(content, encoding);
    },
    FileStamp(path) { return stamp(state.files.get(key(path))); },
    SetDocumentState() { return null; },
    SetSessionDirty(dirty) { state.session.push(dirty); return null; },
    StartupFile() { return state.startupPath; },
    NewFile() {
      return { path: null, content: "", encoding: "UTF-8", line_ending: "lf", mixed_line_ending: false };
    },
    SaveRecovery() { return null; },
    ListRecovery() { return state.recovery; },
    LoadRecovery() { return null; },
    DiscardRecovery() { return null; },
    ClearRecoveryPath() { return null; },
  };

  window.go = { main: { App: app } };
  window.runtime = {
    EventsOnMultiple(name, callback) {
      (state.handlers[name] ??= []).push(callback);
      return () => {};
    },
    EventsOn(name, callback) { return window.runtime.EventsOnMultiple(name, callback); },
    EventsOnce(name, callback) { return window.runtime.EventsOnMultiple(name, callback); },
    EventsOff() {},
    WindowSetTitle() {},
    WindowSetLightTheme() {},
    WindowSetDarkTheme() {},
    Quit() { state.quits += 1; },
  };
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
  await page.waitForFunction(() =>
    !!window.__coteditor
    && document.querySelectorAll("#menubar > .ce-menu-item").length > 0
    && document.querySelectorAll("#tabs .ce-tabs-tab").length === 1);
}

const text = () => page.evaluate(() => window.__coteditor.activeValue());
const title = () => page.evaluate(() => document.title);
const dirty = () => page.evaluate(() => document.title.includes("·"));
const tabs = () => page.evaluate(() => window.__coteditor.tabs());
const tabElements = () => page.evaluate(() =>
  [...document.querySelectorAll("#tabs .ce-tabs-tab")].map((tab) => ({
    title: tab.querySelector(".ce-tabs-title")?.textContent ?? "",
    dirty: tab.dataset.dirty,
    active: tab.dataset.active,
  })));
const writes = () => page.evaluate(() => window.__mock.writes);
const recent = () => page.evaluate(() =>
  JSON.parse(localStorage.getItem("coteditor.recent.v1") ?? "[]"));
const stat = (field) => page.evaluate((name) => {
  const node = document.querySelector(`#statusbar [data-stat="${name}"]`);
  return node ? node.textContent : "";
}, field);

async function type(value) {
  await page.locator("#editor .monaco-editor").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(value);
}

async function openFixture(path, content, encoding = "UTF-8") {
  await page.evaluate(({ path, content, encoding }) =>
    window.__test.queueOpen(path, content, encoding), { path, content, encoding });
  await page.keyboard.press("Control+o");
  const name = path.replace(/\\/g, "/").split("/").pop();
  await page.waitForFunction((expected) => document.title.includes(expected), name);
  await page.waitForFunction(() => !window.__coteditor.document().documentOperationActive);
}

async function openMenu() {
  await page.locator("#menubar > .ce-menu-item").filter({ hasText: /^File$/ }).click();
  return page.locator(".ce-menu-dropdown");
}

async function setStartup(path, content, encoding = "UTF-8") {
  await page.evaluate(({ path, content, encoding }) => {
    localStorage.setItem("coteditor.test.startup", path);
    localStorage.setItem("coteditor.test.startup.content", content);
    localStorage.setItem("coteditor.test.startup.encoding", encoding);
  }, { path, content, encoding });
}

try {
  await test("startup file reuses the initial blank tab instead of stacking another", async () => {
    await setStartup("C:\\docs\\start.md", "# start\n");
    await fresh();
    await page.waitForFunction(() => document.title.startsWith("start.md"));
    assert.equal((await tabs()).length, 1);
    assert.equal(await tabElements().then((items) => items.length), 1);
    assert.equal(await text(), "# start\n");
    assert.equal(await dirty(), false);
  });

  await test("tabs keep independent undo/dirty state; Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+1 switch", async () => {
    await openFixture("C:\\docs\\a.txt", "alpha");
    assert.equal((await tabs()).length, 1);
    await type("A");
    await page.waitForFunction(() => document.title.includes("·"));

    await page.keyboard.press("Control+n");
    await page.waitForFunction(() => document.querySelectorAll("#tabs .ce-tabs-tab").length === 2);
    await page.waitForFunction(() => document.title === "Untitled - CotEditor");
    await type("B");
    await page.waitForFunction(() => document.title.includes("·"));

    assert.deepEqual((await tabElements()).map((tab) => tab.dirty), ["true", "true"]);

    await page.keyboard.press("Control+Tab");
    await page.waitForFunction(() => document.title.startsWith("a.txt"));
    assert.equal(await text(), "alphaA");
    await page.keyboard.press("Control+z");
    await page.waitForFunction(() => !document.title.includes("·"));
    assert.equal(await text(), "alpha", "undo is scoped to the active document");
    assert.deepEqual((await tabElements()).map((tab) => tab.dirty), ["false", "true"]);

    await page.keyboard.press("Control+Tab");
    await page.waitForFunction(() => document.title.startsWith("Untitled"));
    assert.equal(await text(), "B", "the other tab never saw the undo");
    await page.keyboard.press("Control+z");
    await page.waitForFunction(() => !document.title.includes("·"));
    assert.equal(await text(), "");
    assert.deepEqual((await tabElements()).map((tab) => tab.dirty), ["false", "false"]);

    await page.keyboard.press("Control+Shift+Tab");
    await page.waitForFunction(() => document.title.startsWith("a.txt"));
    await page.keyboard.press("Control+2");
    await page.waitForFunction(() => document.title.startsWith("Untitled"));
    await page.keyboard.press("Control+1");
    await page.waitForFunction(() => document.title.startsWith("a.txt"));
  });

  await test("closing a dirty tab can be cancelled, and discarding the last tab yields a blank placeholder", async () => {
    await openFixture("C:\\docs\\close.txt", "body");
    await type("!");
    await page.waitForFunction(() => document.title.includes("·"));

    await page.locator("#tabs .ce-tabs-close").click();
    await page.locator(".ce-confirm-card").waitFor();
    assert.equal((await tabs()).length, 1);
    await page.locator('[data-decision="cancel"]').click();
    await page.waitForFunction(() => !document.querySelector(".ce-modal"));
    assert.equal((await tabs()).length, 1);
    assert.equal(await text(), "body!");
    assert.equal(await dirty(), true);

    await page.locator("#tabs .ce-tabs-close").click();
    await page.locator(".ce-confirm-card").waitFor();
    await page.locator('[data-decision="discard"]').click();
    await page.waitForFunction(() =>
      document.querySelectorAll("#tabs .ce-tabs-tab").length === 1
      && document.title === "Untitled - CotEditor");
    assert.equal(await text(), "");
    assert.equal(await dirty(), false);
    const remaining = await tabs();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].title, "Untitled");
    assert.equal(remaining[0].dirty, false);
    assert.equal(remaining[0].path, null);
  });

  await test("Save uses each tab's encoding and path; BOM stays an encoding label", async () => {
    await openFixture("C:\\docs\\bom.txt", "hi\n", "UTF-8 BOM");
    assert.equal(await stat("encoding"), "UTF-8 BOM");
    await type("!");
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => window.__mock.writes.length === 1);
    await page.waitForFunction(() => !document.title.includes("·"));
    assert.deepEqual((await writes())[0], {
      path: "C:\\docs\\bom.txt",
      content: "hi\n!",
      encoding: "UTF-8 BOM",
    }, "content is BOM-free; the encoding label owns the BOM");
    assert.equal(await stat("save"), "Saved");
    assert.ok((await recent()).includes("C:\\docs\\bom.txt"));

    // A second, untitled tab saves through Save As without touching the first.
    await page.keyboard.press("Control+n");
    await page.waitForFunction(() => document.querySelectorAll("#tabs .ce-tabs-tab").length === 2);
    await type("?");
    await page.evaluate(() => window.__test.queueSaveAs("C:\\docs\\untitled.txt"));
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => window.__mock.writes.length === 2);
    await page.waitForFunction(() => document.title === "untitled.txt - CotEditor");
    assert.deepEqual((await writes())[1], {
      path: "C:\\docs\\untitled.txt",
      content: "?",
      encoding: "UTF-8",
    });
    assert.deepEqual((await tabElements()).map((tab) => tab.dirty), ["false", "false"]);

    await page.keyboard.press("Control+Tab");
    await page.waitForFunction(() => document.title.startsWith("bom.txt"));
    await type("?");
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => window.__mock.writes.length === 3);
    assert.deepEqual((await writes())[2], {
      path: "C:\\docs\\bom.txt",
      content: "hi\n!?",
      encoding: "UTF-8 BOM",
    }, "saving the active tab writes its own path, not the last saved one");
    assert.deepEqual((await tabElements()).map((tab) => tab.dirty), ["false", "false"]);
  });

  await test("Open Recent activates open paths, opens new ones, and prunes missing entries", async () => {
    await openFixture("C:\\docs\\a.txt", "alpha");
    await openFixture("C:\\docs\\b.txt", "beta");
    assert.equal((await tabs()).length, 2);
    await page.evaluate(() => {
      window.__test.addFile("C:\\docs\\c.txt", "gamma");
      const list = JSON.parse(localStorage.getItem("coteditor.recent.v1") ?? "[]");
      localStorage.setItem("coteditor.recent.v1",
        JSON.stringify(["C:\\docs\\c.txt", ...list]));
    });

    let menu = await openMenu();
    for (const path of ["C:\\docs\\a.txt", "C:\\docs\\b.txt", "C:\\docs\\c.txt"]) {
      assert.equal(await menu.locator("button").filter({ hasText: path }).count(), 1, path);
    }
    await menu.locator("button").filter({ hasText: "C:\\docs\\c.txt" }).click();
    await page.waitForFunction(() => document.title.startsWith("c.txt"));
    assert.equal((await tabs()).length, 3);
    assert.equal(await text(), "gamma");

    // Clicking an already-open path activates it instead of duplicating it.
    menu = await openMenu();
    await menu.locator("button").filter({ hasText: "C:\\docs\\a.txt" }).click();
    await page.waitForFunction(() => document.title.startsWith("a.txt"));
    assert.equal((await tabs()).length, 3);

    await page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem("coteditor.recent.v1") ?? "[]");
      localStorage.setItem("coteditor.recent.v1",
        JSON.stringify(["C:\\docs\\gone.txt", ...list]));
    });
    menu = await openMenu();
    await menu.locator("button").filter({ hasText: "C:\\docs\\gone.txt" }).click();
    await page.locator(".ce-toast-error").filter({ hasText: "Could not open the file" }).waitFor();
    await page.waitForFunction(() =>
      !JSON.parse(localStorage.getItem("coteditor.recent.v1") ?? "[]")
        .includes("C:\\docs\\gone.txt"));
    assert.equal((await tabs()).length, 3);
    menu = await openMenu();
    assert.equal(await menu.locator("button").filter({ hasText: "C:\\docs\\gone.txt" }).count(), 0);
    await page.keyboard.press("Escape");
  });

  await test("app:open-path and app:open-paths add tabs and dedupe existing paths", async () => {
    await openFixture("C:\\docs\\a.txt", "alpha");
    await page.evaluate(() => {
      window.__test.addFile("C:\\docs\\second.txt", "two");
      window.__test.emit("app:open-path", "C:\\docs\\second.txt");
    });
    await page.waitForFunction(() => document.title.startsWith("second.txt"));
    assert.equal((await tabs()).length, 2);

    await page.evaluate(() => {
      window.__test.addFile("C:\\docs\\third.txt", "three");
      window.__test.addFile("C:\\docs\\fourth.txt", "four");
      window.__test.emit("app:open-paths", [
        "C:\\docs\\a.txt",
        "C:\\docs\\third.txt",
        "C:\\docs\\fourth.txt",
      ]);
    });
    await page.waitForFunction(() => document.title.startsWith("fourth.txt"));
    assert.equal((await tabs()).length, 4, "an already-open path is activated, not duplicated");
    assert.deepEqual((await tabs()).map((tab) => tab.title),
      ["a.txt", "second.txt", "third.txt", "fourth.txt"]);
  });

  await test("mixed-EOL read-only state follows the active tab and blocks saving", async () => {
    await openFixture("C:\\docs\\mixed.txt", "a\r\nb\n", "UTF-8");
    await page.waitForFunction(() => {
      const node = document.querySelector('#statusbar [data-stat="readonly"]');
      return node && !node.hidden;
    });
    assert.equal(await stat("eol"), "Mixed EOL");
    assert.equal(await stat("readonly"), "Read-only");
    assert.equal(await page.evaluate(() => window.__coteditor.readOnly()), true);

    await type("X");
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(150);
    assert.equal((await writes()).length, 0, "protected documents must never be written");
    assert.equal(await dirty(), false);

    await page.keyboard.press("Control+n");
    await page.waitForFunction(() => document.title === "Untitled - CotEditor");
    assert.equal(await page.evaluate(() => window.__coteditor.readOnly()),
      false, "a blank tab is writable");
    await page.keyboard.press("Control+Tab");
    await page.waitForFunction(() => document.title.startsWith("mixed.txt"));
    assert.equal(await page.evaluate(() => window.__coteditor.readOnly()),
      true, "the protected tab restores its read-only state");
  });

  await test("typing never autosaves; writes happen only on an explicit Save", async () => {
    await openFixture("C:\\docs\\manual.txt", "base");
    await type("!");
    await page.waitForTimeout(500);
    assert.equal((await writes()).length, 0);
    assert.equal(await dirty(), true);
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => window.__mock.writes.length === 1);
    assert.equal(await dirty(), false);
  });

  await test("session dirty tracks all tabs and app:request-close saves all before quitting", async () => {
    await openFixture("C:\\docs\\quit.txt", "base");
    await type("!");
    await page.waitForFunction(() => window.__mock.session.at(-1) === true);

    // Cancel keeps the window open and the document dirty.
    await page.evaluate(() => window.__test.emit("app:request-close"));
    await page.locator(".ce-confirm-card").waitFor();
    await page.locator('[data-decision="cancel"]').click();
    await page.waitForFunction(() => !document.querySelector(".ce-modal"));
    assert.equal(await page.evaluate(() => window.__mock.quits), 0);
    assert.equal(await dirty(), true);

    await page.evaluate(() => window.__test.emit("app:request-close"));
    await page.locator(".ce-confirm-card").waitFor();
    await page.locator('[data-decision="save"]').click();
    await page.waitForFunction(() => window.__mock.quits === 1);
    assert.deepEqual((await writes())[0], {
      path: "C:\\docs\\quit.txt",
      content: "base!",
      encoding: "UTF-8",
    });
    assert.equal(await page.evaluate(() => window.__mock.session.at(-1)), false);
  });

  await test("discarding on app:request-close clears the guard and quits without writing", async () => {
    await openFixture("C:\\docs\\discard.txt", "base");
    await type("!");
    await page.waitForFunction(() => window.__mock.session.at(-1) === true);
    await page.evaluate(() => window.__test.emit("app:request-close"));
    await page.locator(".ce-confirm-card").waitFor();
    await page.locator('[data-decision="discard"]').click();
    await page.waitForFunction(() => window.__mock.quits === 1);
    assert.equal((await writes()).length, 0);
    assert.equal(await page.evaluate(() => window.__mock.session.at(-1)), false,
      "the close guard must be cleared before Quit re-enters beforeClose");
  });

  await test("a cancelled Save All does not quit the app", async () => {
    await type("draft");
    await page.waitForFunction(() => window.__mock.session.at(-1) === true);
    await page.evaluate(() => window.__test.emit("app:request-close"));
    await page.locator(".ce-confirm-card").waitFor();
    await page.locator('[data-decision="save"]').click(); // no Save As queue: cancelled
    await page.waitForFunction(() => !document.querySelector(".ce-modal"));
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.__mock.quits), 0);
    assert.equal(await dirty(), true);
    assert.equal((await tabs()).length, 1);
    assert.equal((await writes()).length, 0);
  });

  await test("no unhandled runtime errors", async () => {
    assert.deepEqual(runtimeErrors, []);
  });
} finally {
  await browser.close();
}

console.log(failures.length
  ? `FAIL (${failures.length}): ${failures.join("; ")}`
  : "ALL TAB REGRESSIONS PASS");
process.exitCode = failures.length ? 1 : 0;
