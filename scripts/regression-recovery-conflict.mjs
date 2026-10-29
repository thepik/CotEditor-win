// Phase-B integration regressions: recovery drafts, external modification and
// encoding actions, exercised through the real app bootstrap with an in-memory
// Wails-compatible fake API.
//
//   node scripts/regression-recovery-conflict.mjs http://127.0.0.1:1420/
//
// Nothing touches the real recovery directory or filesystem: every binding is
// backed by Maps in the init script. The app still runs its real timers,
// DocumentManager save transactions and dialogs.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1420/";
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(15000);

const failures = [];
const runtimeErrors = [];
page.on("pageerror", (error) => {
  if (error.message === "Canceled") return;
  runtimeErrors.push(error.message);
});
page.on("console", (message) => {
  if (message.type() !== "error") return;
  if (/open failed:|save failed:|reload failed:/.test(message.text())) return;
  runtimeErrors.push(message.text());
});

await context.addInitScript(() => {
  try {
    localStorage.setItem("coteditor.lang.v1", "en");
    localStorage.removeItem("coteditor.recent.v1");
    localStorage.removeItem("coteditor.settings.v1");
    const settings = localStorage.getItem("coteditor.test.settings");
    if (settings) localStorage.setItem("coteditor.settings.v1", settings);
    localStorage.removeItem("coteditor.test.settings");
  } catch { /* opaque origin */ }

  const state = {
    files: new Map(),
    openQueue: [],
    saveAsQueue: [],
    writes: [],
    stamps: [],
    openEncodings: [],
    recoverySaves: [],
    recoveryDiscards: [],
    recoveryClears: [],
    recovery: [],
    session: [],
    quits: 0,
    modSerial: 0,
    forceConflict: false,
    handlers: {},
  };
  window.__mock = state;

  const key = (path) => path.replace(/\//g, "\\").toLowerCase();
  const mixed = (text) => new Set(text.match(/\r\n|\r|\n/g) ?? []).size > 1;
  const byteSize = (text) => new TextEncoder().encode(text).byteLength;
  const makeFile = (path, content, encoding = "UTF-8") => ({
    path,
    content,
    encoding,
    line_ending: content.includes("\r\n") ? "crlf" : content.includes("\r") ? "cr" : "lf",
    mixed_line_ending: mixed(content),
    mod_time: ++state.modSerial,
  });
  const stamp = (file) => ({
    exists: !!file,
    size: file ? byteSize(file.content) : 0,
    mod_time: file ? file.mod_time : 0,
  });
  const find = (path) => state.files.get(key(path));

  try {
    const files = JSON.parse(localStorage.getItem("coteditor.test.files") ?? "[]");
    for (const [path, content, encoding] of files) {
      state.files.set(key(path), makeFile(path, content, encoding ?? "UTF-8"));
    }
    localStorage.removeItem("coteditor.test.files");
    const recovery = JSON.parse(localStorage.getItem("coteditor.test.recovery") ?? "[]");
    state.recovery.push(...recovery);
    localStorage.removeItem("coteditor.test.recovery");
  } catch { /* malformed seed: start empty */ }

  window.__test = {
    addFile(path, content, encoding = "UTF-8") {
      state.files.set(key(path), makeFile(path, content, encoding));
    },
    externalEdit(path, content, encoding = "UTF-8") {
      state.files.set(key(path), makeFile(path, content, encoding));
    },
    queueOpen(path, content, encoding = "UTF-8") {
      state.openQueue.push(makeFile(path, content, encoding));
    },
    queueSaveAs(path) {
      state.saveAsQueue.push(path);
    },
    emit(name, ...args) {
      for (const handler of state.handlers[name] ?? []) handler(...args);
    },
    file(path) {
      const file = find(path);
      return file ? { ...file } : null;
    },
    currentStamp(path) {
      return stamp(find(path));
    },
  };

  const app = {
    OpenFile() {
      const next = state.openQueue.shift();
      if (!next) {
        return { path: null, content: "", encoding: "UTF-8", line_ending: "lf", mixed_line_ending: false };
      }
      if (next.path) state.files.set(key(next.path), next);
      return { ...next };
    },
    OpenPath(path) {
      const found = find(path);
      if (!found) throw new Error(`ENOENT: no such file: ${path}`);
      return { ...found };
    },
    OpenPathWithEncoding(path, encoding) {
      state.openEncodings.push({ path, encoding });
      const found = find(path);
      if (!found) throw new Error(`ENOENT: no such file: ${path}`);
      return { ...found, encoding };
    },
    SaveFileWithEncoding(path, content, encoding) {
      state.writes.push({ path, content, encoding });
      state.files.set(key(path), makeFile(path, content, encoding));
      return path;
    },
    SaveAsWithEncoding(content, encoding) {
      const path = state.saveAsQueue.shift();
      if (!path) return "";
      state.writes.push({ path, content, encoding });
      state.files.set(key(path), makeFile(path, content, encoding));
      return path;
    },
    SaveFileChecked(path, content, encoding, expectedSize, expectedModTime) {
      const current = stamp(find(path));
      state.stamps.push({ path, expectedSize, expectedModTime, current });
      if (state.forceConflict) {
        throw new Error(`FILE_CONFLICT: ${path} changed on disk (fixture)`);
      }
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
      state.files.set(key(path), makeFile(path, content, encoding));
      return path;
    },
    SaveAsChecked(content, encoding) {
      return app.SaveAsWithEncoding(content, encoding);
    },
    FileStamp(path) { return stamp(find(path)); },
    SetDocumentState() { return null; },
    SetSessionDirty(dirty) { state.session.push(dirty); return null; },
    StartupFile() { return null; },
    NewFile() {
      return { path: null, content: "", encoding: "UTF-8", line_ending: "lf", mixed_line_ending: false };
    },
    SaveRecovery(id, path, content, encoding, lineEnding) {
      state.recoverySaves.push({ id, path, content, encoding, lineEnding });
      const existing = state.recovery.find((entry) => entry.id === id);
      const entry = {
        id,
        path,
        content,
        encoding,
        line_ending: lineEnding,
        updated_at: Date.now() * 1e6,
        exists: !!find(path),
      };
      if (existing) Object.assign(existing, entry);
      else state.recovery.push(entry);
      return null;
    },
    ListRecovery() { return state.recovery; },
    LoadRecovery(id) { return state.recovery.find((entry) => entry.id === id) ?? null; },
    DiscardRecovery(id) {
      state.recoveryDiscards.push(id);
      state.recovery = state.recovery.filter((entry) => entry.id !== id);
      return null;
    },
    ClearRecoveryPath(path) {
      state.recoveryClears.push(path);
      const keyPath = key(path);
      state.recovery = state.recovery.filter((entry) => key(entry.path ?? "") !== keyPath);
      return null;
    },
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
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.stack || error}`);
    await page.keyboard.press("Escape").catch(() => {});
  }
}

async function fresh(seed = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate((value) => {
    const settings = {
      language: "en",
      autoSave: false,
      autoSaveDelayMs: 1000,
      ...(value.settings ?? {}),
    };
    localStorage.setItem("coteditor.test.settings", JSON.stringify(settings));
    localStorage.setItem("coteditor.test.files", JSON.stringify(value.files ?? []));
    localStorage.setItem("coteditor.test.recovery", JSON.stringify(value.recovery ?? []));
  }, seed);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() =>
    !!window.__coteditor
    && document.querySelectorAll("#menubar > .ce-menu-item").length > 0
    && document.querySelectorAll("#tabs .ce-tabs-tab").length === 1);
}

const text = () => page.evaluate(() => window.__coteditor.activeValue());
const dirty = () => page.evaluate(() => window.__coteditor.document().dirty);
const conflict = () => page.evaluate(() => window.__coteditor.document().conflict);
const writes = () => page.evaluate(() => window.__mock.writes);
const recoverySaves = () => page.evaluate(() => window.__mock.recoverySaves);
const recoveryDiscards = () => page.evaluate(() => window.__mock.recoveryDiscards);
const recoveryClears = () => page.evaluate(() => window.__mock.recoveryClears);

async function settled() {
  await page.waitForFunction(() => {
    const state = window.__coteditor?.document?.();
    return !!state && !state.documentOperationActive && !state.saveInFlight;
  });
}

async function openFixture(path, content, encoding = "UTF-8") {
  await page.evaluate(({ path, content, encoding }) =>
    window.__test.queueOpen(path, content, encoding), { path, content, encoding });
  await page.keyboard.press("Control+o");
  const name = path.replace(/\\/g, "/").split("/").pop();
  await page.waitForFunction((expected) => document.title.includes(expected), name);
  await settled();
}

async function type(value) {
  await page.locator("#editor .monaco-editor").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(value);
}

async function waitText(expected) {
  await page.waitForFunction((value) => window.__coteditor.activeValue() === value, expected);
}

async function waitConflictDialog() {
  await page.locator(".ce-conflict-card").waitFor();
}

const recoveryEntry = (id, path, content, options = {}) => ({
  id,
  path,
  content,
  encoding: options.encoding ?? "UTF-8",
  line_ending: options.lineEnding ?? "lf",
  updated_at: Date.now() * 1e6,
  exists: options.exists !== false,
});

try {
  await test("module-level fake recovery API: debounce, completeSave and discard", async () => {
    await fresh();
    const result = await page.evaluate(async () => {
      const { RecoveryService } = await import("/src/lib/recovery-service.ts");
      let now = 0;
      let serial = 0;
      const timers = new Map();
      const clock = {
        setTimeout(callback, delay) {
          serial += 1;
          timers.set(serial, { callback, at: now + delay });
          return serial;
        },
        clearTimeout(id) { timers.delete(id); },
        advance(ms) {
          now += ms;
          for (const [id, timer] of [...timers]) {
            if (timer.at <= now) { timers.delete(id); timer.callback(); }
          }
        },
      };
      const calls = { saves: [], discards: [], clears: [] };
      const api = {
        saveRecovery: (...args) => { calls.saves.push(args); return Promise.resolve(); },
        listRecovery: () => Promise.resolve([]),
        loadRecovery: () => Promise.resolve(null),
        discardRecovery: (id) => { calls.discards.push(id); return Promise.resolve(); },
        clearRecoveryPath: (path) => { calls.clears.push(path); return Promise.resolve(); },
      };
      const service = new RecoveryService({ delayMs: 1000, api, timers: clock });
      service.schedule({ id: "rec-1", path: "C:\\docs\\a.txt", content: "one", encoding: "UTF-8", lineEnding: "lf" });
      service.schedule({ id: "rec-1", path: "C:\\docs\\a.txt", content: "two", encoding: "UTF-8", lineEnding: "crlf" });
      clock.advance(999);
      await Promise.resolve();
      const before = calls.saves.length;
      clock.advance(1);
      await service.flush("rec-1");
      await service.completeSave("rec-1", "C:\\docs\\a.txt");
      await service.discard("rec-2");
      service.dispose();
      return { before, calls };
    });
    assert.equal(result.before, 0, "nothing is written before the debounce");
    assert.equal(result.calls.saves.length, 1, "debounce keeps only the newest snapshot");
    assert.deepEqual(result.calls.saves[0],
      ["rec-1", "C:\\docs\\a.txt", "two", "UTF-8", "CRLF"]);
    assert.deepEqual(result.calls.discards, ["rec-1", "rec-2"]);
    assert.deepEqual(result.calls.clears, ["C:\\docs\\a.txt"]);
  });

  await test("startup recovery restores a draft, keeps it while editing and clears it after save", async () => {
    await fresh({
      files: [["C:\\docs\\draft.txt", "disk body\n", "UTF-8"]],
      recovery: [recoveryEntry("rec-restore", "C:\\docs\\draft.txt", "draft body\n")],
    });
    await page.locator(".ce-recovery-card").waitFor();
    await page.locator('.ce-recovery-actions [data-action="restore"]').click();
    await page.waitForFunction(() => document.title.startsWith("draft.txt"));
    assert.equal(await text(), "draft body\n");
    assert.equal(await dirty(), true);
    assert.equal((await recoveryDiscards()).includes("rec-restore"), false,
      "restoring must not delete the crash-safe copy");

    await type("!");
    await page.waitForFunction(() => window.__mock.recoverySaves.some((entry) =>
      entry.id === "rec-restore" && entry.content === "draft body\n!"));

    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => window.__mock.writes.length === 1);
    await settled();
    assert.deepEqual((await writes())[0], {
      path: "C:\\docs\\draft.txt",
      content: "draft body\n!",
      encoding: "UTF-8",
    });
    await page.waitForFunction(() => window.__mock.recoveryDiscards.includes("rec-restore"));
    assert.equal(await dirty(), false);
  });

  await test("startup Discard All removes every draft and does not restore a tab", async () => {
    await fresh({
      recovery: [
        recoveryEntry("rec-a", "C:\\docs\\a.txt", "alpha"),
        recoveryEntry("rec-b", "", "untitled draft", { exists: false }),
      ],
    });
    await page.locator(".ce-recovery-card").waitFor();
    await page.locator('.ce-recovery-actions [data-action="discard-all"]').click();
    await page.waitForFunction(() =>
      window.__mock.recoveryDiscards.includes("rec-a")
      && window.__mock.recoveryDiscards.includes("rec-b"));
    assert.equal(await page.evaluate(() =>
      document.querySelectorAll("#tabs .ce-tabs-tab").length), 1);
    assert.equal(await text(), "");
  });

  await test("clean external change reloads automatically and clears dirty", async () => {
    await fresh();
    await openFixture("C:\\docs\\clean.txt", "alpha");
    await page.evaluate(() => window.__test.externalEdit("C:\\docs\\clean.txt", "external beta"));
    await waitText("external beta");
    assert.equal(await dirty(), false);
    assert.equal(await page.locator(".ce-conflict-card").count(), 0);
    // The new disk state is the baseline: a subsequent save must be accepted.
    await type("!");
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => window.__mock.writes.length === 1);
    await settled();
    assert.equal((await writes())[0].content, "external beta!");
  });

  await test("dirty external change reload decision drops local edits and the draft", async () => {
    await fresh();
    await openFixture("C:\\docs\\dirty.txt", "base");
    await type(" local");
    await page.evaluate(() => window.__test.externalEdit("C:\\docs\\dirty.txt", "disk wins"));
    await waitConflictDialog();
    assert.equal(await conflict(), true);
    await page.locator('[data-decision="reload"]').click();
    await waitText("disk wins");
    await page.waitForFunction(() => !window.__coteditor.document().conflict);
    assert.equal(await dirty(), false);
    await page.waitForFunction(() => window.__mock.recoveryDiscards.length > 0,
      null, { timeout: 5000 });
  });

  await test("keepLocal updates the baseline so the next checked save may overwrite", async () => {
    await fresh();
    await openFixture("C:\\docs\\keep.txt", "base");
    await type(" local");
    await page.evaluate(() => window.__test.externalEdit("C:\\docs\\keep.txt", "external version"));
    await waitConflictDialog();
    await page.locator('[data-decision="keepLocal"]').click();
    await page.waitForFunction(() => window.__coteditor.document().conflict === false);
    assert.equal(await dirty(), true);

    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => window.__mock.writes.length === 1);
    await settled();
    const saved = (await writes())[0];
    assert.equal(saved.path, "C:\\docs\\keep.txt");
    assert.equal(saved.content, "base local");
    const stampCall = await page.evaluate(() =>
      window.__mock.stamps.at(-1));
    assert.equal(stampCall.expectedSize,
      await page.evaluate(() => new TextEncoder().encode("external version").byteLength));
    assert.equal(await page.evaluate(() =>
      window.__test.file("C:\\docs\\keep.txt").content), "base local");
  });

  await test("checked save conflict opens the dialog, does not overwrite, and pauses auto-save", async () => {
    await fresh({ settings: { autoSave: true, autoSaveDelayMs: 1000 } });
    await openFixture("C:\\docs\\conflict.txt", "base");
    await type(" local");
    await page.evaluate(() => {
      window.__test.externalEdit("C:\\docs\\conflict.txt", "external");
      window.__mock.forceConflict = true;
    });
    await page.keyboard.press("Control+s");
    await waitConflictDialog();
    assert.equal(await conflict(), true);
    assert.equal((await writes()).length, 0, "a conflicted save never overwrites");
    assert.equal(await page.evaluate(() =>
      window.__test.file("C:\\docs\\conflict.txt").content), "external");

    await page.locator('[data-decision="cancel"]').click();
    await page.waitForFunction(() => !document.querySelector(".ce-conflict-card"));
    await page.waitForTimeout(1600);
    assert.equal((await writes()).length, 0, "cancel pauses auto-save");
    assert.equal(await conflict(), true, "cancel keeps the conflict marker");
    await page.waitForTimeout(2200);
    assert.equal(await page.locator(".ce-conflict-card").count(), 0,
      "polling must not reopen the dialog while conflict is unresolved");
  });

  await test("encoding menu reopens with the chosen label and saves BOM-free content", async () => {
    await fresh();
    await openFixture("C:\\docs\\enc.txt", "hello");
    await page.locator(".ce-encoding-trigger").click();
    await page.locator('.ce-encoding-item[data-action="reopen"][data-encoding="UTF-16LE"]').click();
    await page.waitForFunction(() => window.__coteditor.document().encoding === "UTF-16LE");
    assert.deepEqual(await page.evaluate(() => window.__mock.openEncodings.at(-1)), {
      path: "C:\\docs\\enc.txt",
      encoding: "UTF-16LE",
    });

    await page.locator(".ce-encoding-trigger").click();
    await page.locator('.ce-encoding-item[data-action="save"][data-encoding="UTF-8 BOM"]').click();
    await page.waitForFunction(() => window.__mock.writes.length === 1);
    await settled();
    const saved = (await writes())[0];
    assert.equal(saved.encoding, "UTF-8 BOM");
    assert.equal(saved.content.startsWith("\uFEFF"), false,
      "the encoding label owns the BOM, never the buffer text");
    assert.equal(await page.evaluate(() => window.__coteditor.document().encoding), "UTF-8 BOM");
    assert.equal(await page.locator('[data-stat="encoding"]').textContent(), "UTF-8 BOM");
  });

  await test("auto-save is off by default and the File menu toggle gates checked saves live", async () => {
    await fresh();
    await openFixture("C:\\docs\\auto.txt", "base");
    await type("!");
    await page.waitForTimeout(1400);
    assert.equal((await writes()).length, 0, "default auto-save is off");

    await page.locator("#menubar > .ce-menu-item").filter({ hasText: /^File$/ }).click();
    await page.locator('[data-menu-action="autoSave"]').click();
    await page.waitForFunction(() =>
      JSON.parse(localStorage.getItem("coteditor.settings.v1") ?? "{}").autoSave === true);
    await page.waitForFunction(() => window.__mock.writes.length === 1);
    assert.equal((await writes())[0].content, "base!");
    await settled();

    await page.locator("#menubar > .ce-menu-item").filter({ hasText: /^File$/ }).click();
    await page.locator('[data-menu-action="autoSave"]').click();
    await page.waitForFunction(() =>
      JSON.parse(localStorage.getItem("coteditor.settings.v1") ?? "{}").autoSave === false);
    await type("?");
    await page.waitForTimeout(1400);
    assert.equal((await writes()).length, 1, "turning auto-save off stops later writes");
  });

  await test("closing a discarded draft calls DiscardRecovery", async () => {
    await fresh();
    await openFixture("C:\\docs\\close.txt", "base");
    await type("!");
    await page.waitForFunction(() => window.__mock.recoverySaves.length > 0);
    const draftId = (await recoverySaves()).at(-1).id;
    await page.locator("#tabs .ce-tabs-close").click();
    await page.locator(".ce-confirm-card").waitFor();
    await page.locator('[data-decision="discard"]').click();
    await page.waitForFunction((id) => window.__mock.recoveryDiscards.includes(id), draftId);
  });

  await test("window close saves pending drafts before writing and discards on demand", async () => {
    await fresh();
    await openFixture("C:\\docs\\quit.txt", "base");
    await type("!");
    await page.waitForFunction(() => window.__mock.session.at(-1) === true);
    await page.evaluate(() => window.__test.emit("app:request-close"));
    await page.locator(".ce-confirm-card").waitFor();
    await page.locator('[data-decision="discard"]').click();
    await page.waitForFunction(() => window.__mock.quits === 1);
    assert.equal((await writes()).length, 0);
    assert.ok((await recoveryDiscards()).length > 0, "discard-all runs before quitting");
    assert.equal(await page.evaluate(() => window.__mock.session.at(-1)), false);
  });

  await test("no unhandled runtime errors", async () => {
    assert.deepEqual(runtimeErrors, []);
  });
} finally {
  await browser.close();
}

console.log(failures.length
  ? `FAIL (${failures.length}): ${failures.join("; ")}`
  : "ALL RECOVERY/CONFLICT REGRESSIONS PASS");
process.exitCode = failures.length ? 1 : 0;
