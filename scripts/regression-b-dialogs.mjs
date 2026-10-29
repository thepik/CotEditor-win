// Phase-B recovery / conflict / encoding regressions.
//
// Loads the modules through the Vite dev server with dynamic imports while
// `main.ts` is never evaluated. Wails bindings are mocked on `window.go`, so
// nothing reads or writes the real recovery directory.
//
//   node scripts/regression-b-dialogs.mjs http://127.0.0.1:1420/
//
// Reports SKIP (exit 0) when no dev server is listening, matching the other
// browser regressions.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1420/";
const failures = [];
const pageErrors = [];
const fixturePath = "/__b_dialogs_regression__.html";

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(10000);

page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const text = message.text();
  // Vite's HMR client and blocked websockets are unrelated to the modules.
  if (/\[vite\]|WebSocket connection to|ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS/.test(text)) {
    return;
  }
  pageErrors.push(text);
});

let serverReady = false;
try {
  const response = await context.request.get(url, { timeout: 4000 });
  serverReady = response.ok();
} catch {
  serverReady = false;
}
if (!serverReady) {
  console.log(`SKIP regression-b-dialogs: dev server not available at ${url}`);
  await browser.close();
  process.exit(0);
}

async function test(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.stack || error}`);
  }
}

function checkCssPrefix(relativePath, prefix) {
  const raw = readFileSync(new URL(`../frontend/src/${relativePath}`, import.meta.url), "utf8");
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const classes = [...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]);
  assert.ok(classes.length > 0, `${relativePath} must contain scoped rules`);
  const unscoped = [...new Set(classes.filter((name) => !name.startsWith(prefix)))];
  assert.deepEqual(unscoped, [], `${relativePath} has unprefixed classes: ${unscoped.join(", ")}`);
}

const SETUP = () => {
  window.__native = {
    saves: [],
    discards: [],
    clears: [],
    listData: [],
    loadData: {},
  };
  window.go = {
    main: {
      App: {
        SaveRecovery: (...args) => {
          window.__native.saves.push(args);
          return Promise.resolve();
        },
        ListRecovery: () => Promise.resolve(window.__native.listData),
        LoadRecovery: (id) => Promise.resolve(window.__native.loadData[id] ?? {}),
        DiscardRecovery: (id) => {
          window.__native.discards.push(id);
          return Promise.resolve();
        },
        ClearRecoveryPath: (path) => {
          window.__native.clears.push(path);
          return Promise.resolve();
        },
      },
    },
  };

  window.__clock = () => {
    let now = 0;
    let serial = 0;
    const timers = new Map();
    return {
      now: () => now,
      timers: {
        setTimeout(callback, delay) {
          serial += 1;
          timers.set(serial, { callback, at: now + Math.max(0, delay) });
          return serial;
        },
        clearTimeout(id) {
          timers.delete(id);
        },
      },
      advance(ms) {
        now += ms;
        let ran = true;
        while (ran) {
          ran = false;
          for (const [id, timer] of [...timers]) {
            if (timer.at <= now) {
              timers.delete(id);
              timer.callback();
              ran = true;
            }
          }
        }
      },
      pending: () => timers.size,
    };
  };

  window.__makeApi = (calls) => ({
    saveRecovery: (...args) => {
      calls.saves.push(args);
      return calls.failSave ? Promise.reject(new Error("save failed")) : Promise.resolve();
    },
    listRecovery: () => (
      calls.failList ? Promise.reject(new Error("list failed")) : Promise.resolve(calls.listData ?? [])
    ),
    loadRecovery: (id) => Promise.resolve(calls.loadData?.[id] ?? {}),
    discardRecovery: (id) => {
      calls.discards.push(id);
      return Promise.resolve();
    },
    clearRecoveryPath: (path) => {
      calls.clears.push(path);
      return Promise.resolve();
    },
  });

  window.__openRecovery = (entries, options = {}) => {
    window.__dialogResult = null;
    const opener = document.getElementById("opener");
    if (opener) opener.focus();
    window.__b.recoveryDialog.openRecoveryDialog({ entries, ...options })
      .then((result) => { window.__dialogResult = result; });
  };

  window.__openConflict = (options) => {
    window.__conflictResult = null;
    const opener = document.getElementById("opener");
    if (opener) opener.focus();
    window.__b.conflict.openConflictDialog(options)
      .then((result) => { window.__conflictResult = result; });
  };
};

try {
  await page.route(`**${fixturePath}`, (route) => route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
      + "<title>b dialogs regression</title>"
      + "<style>html,body{margin:0;padding:0;font-family:system-ui,sans-serif}</style>"
      + "</head><body>"
      + "<button id=\"opener\" type=\"button\">opener</button>"
      + "<div id=\"menu-host\"></div>"
      + "<div id=\"menu-host-2\"></div>"
      + "<div id=\"menu-host-3\"></div>"
      + "</body></html>",
  }));

  const testUrl = new URL(fixturePath, url).href;
  await page.goto(testUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  await page.evaluate(SETUP);
  await page.evaluate(async () => {
    const recovery = await import("/src/lib/recovery-service.ts");
    const recoveryDialog = await import("/src/ui/recovery-dialog.ts");
    const conflict = await import("/src/ui/conflict-dialog.ts");
    const encoding = await import("/src/ui/encoding-menu.ts");
    window.__b = { recovery, recoveryDialog, conflict, encoding };
  });

  await test("stylesheet scopes stay under their component prefixes", () => {
    checkCssPrefix("ui/recovery-dialog.css", "ce-recovery");
    checkCssPrefix("ui/conflict-dialog.css", "ce-conflict");
    checkCssPrefix("ui/encoding-menu.css", "ce-encoding");
  });

  await test("recovery ids are generated once and reused per document", async () => {
    const result = await page.evaluate(() => {
      const { createRecoveryId, ensureRecoveryId, isValidRecoveryId } = window.__b.recovery;
      const document = { recoveryId: "" };
      const first = ensureRecoveryId(document);
      const second = ensureRecoveryId(document);
      const a = createRecoveryId();
      const b = createRecoveryId();
      return {
        first,
        second,
        assigned: document.recoveryId,
        a,
        b,
        valid: [first, a, b].every((id) => isValidRecoveryId(id)),
      };
    });
    assert.equal(result.first, result.second, "an assigned id must be stable");
    assert.equal(result.assigned, result.first, "ensureRecoveryId must write the document");
    assert.notEqual(result.a, result.b, "fresh ids must differ");
    assert.equal(result.valid, true);
    assert.match(result.first, /^[A-Za-z0-9_-]{1,64}$/);
  });

  await test("recovery debounce writes only the latest snapshot", async () => {
    const result = await page.evaluate(async () => {
      const clock = window.__clock();
      const calls = { saves: [], listData: [], loadData: {} };
      const api = window.__makeApi(calls);
      const service = new window.__b.recovery.RecoveryService({
        delayMs: 1000,
        api,
        timers: clock.timers,
      });
      const draft = (content) => ({
        id: "debounce-1",
        path: "C:\\docs\\a.txt",
        content,
        encoding: "UTF-8",
        lineEnding: "crlf",
      });
      service.schedule(draft("one"));
      service.schedule(draft("two"));
      const timerCount = clock.pending();
      clock.advance(999);
      await Promise.resolve();
      const before = calls.saves.length;
      clock.advance(1);
      await service.flush("debounce-1");
      service.dispose();
      return { timerCount, before, saves: calls.saves };
    });
    assert.equal(result.timerCount, 1, "debounce must keep one timer per document");
    assert.equal(result.before, 0, "nothing may be written before the delay");
    assert.equal(result.saves.length, 1, "two edits inside the window are one write");
    assert.deepEqual(result.saves[0], ["debounce-1", "C:\\docs\\a.txt", "two", "UTF-8", "CRLF"]);
  });

  await test("recovery flush writes immediately and cancels the timer", async () => {
    const result = await page.evaluate(async () => {
      const clock = window.__clock();
      const calls = { saves: [], listData: [], loadData: {} };
      const api = window.__makeApi(calls);
      const service = new window.__b.recovery.RecoveryService({
        delayMs: 5000,
        api,
        timers: clock.timers,
      });
      service.schedule({
        id: "flush-1",
        path: null,
        content: "flush me",
        encoding: "UTF-16LE",
        lineEnding: "lf",
      });
      await service.flush("flush-1");
      const timersAfter = clock.pending();
      service.dispose();
      return { saves: calls.saves, timersAfter };
    });
    assert.equal(result.timersAfter, 0, "flush must disarm the pending timer");
    assert.deepEqual(result.saves[0], ["flush-1", "", "flush me", "UTF-16LE", "LF"]);
  });

  await test("recovery cancel and empty drafts never reach the backend", async () => {
    const result = await page.evaluate(async () => {
      const clock = window.__clock();
      const calls = { saves: [], listData: [], loadData: {} };
      const api = window.__makeApi(calls);
      const service = new window.__b.recovery.RecoveryService({
        delayMs: 100,
        api,
        timers: clock.timers,
      });
      service.schedule({
        id: "cancel-1", path: "C:\\x.txt", content: "secret", encoding: "UTF-8", lineEnding: "LF",
      });
      service.cancel("cancel-1");
      clock.advance(1000);
      await service.flush("cancel-1");
      service.schedule({
        id: "empty-1", path: "C:\\x.txt", content: "", encoding: "UTF-8", lineEnding: "LF",
      });
      await service.flush("empty-1");
      service.dispose();
      return calls.saves;
    });
    assert.deepEqual(result, []);
  });

  await test("recovery completeSave drops the pending draft and clears the path", async () => {
    const result = await page.evaluate(async () => {
      const clock = window.__clock();
      const calls = { saves: [], discards: [], clears: [], listData: [], loadData: {} };
      const api = window.__makeApi(calls);
      const service = new window.__b.recovery.RecoveryService({
        delayMs: 1000,
        api,
        timers: clock.timers,
      });
      service.schedule({
        id: "saved-1", path: "C:\\docs\\saved.txt", content: "draft", encoding: "UTF-8", lineEnding: "LF",
      });
      await service.completeSave("saved-1", "C:\\docs\\saved.txt");
      clock.advance(5000);
      await service.flush("saved-1");
      service.dispose();
      return calls;
    });
    assert.deepEqual(result.saves, [], "a saved document must not write a stale draft");
    assert.deepEqual(result.discards, ["saved-1"]);
    assert.deepEqual(result.clears, ["C:\\docs\\saved.txt"]);
  });

  await test("recovery list filters empty/corrupt drafts and sorts newest first", async () => {
    const result = await page.evaluate(async () => {
      const calls = {
        saves: [],
        discards: [],
        clears: [],
        listData: [
          {
            id: "keep-b", path: "C:\\b.txt", content: "B", encoding: "GB18030",
            line_ending: "crlf", updated_at: 1700000002000000000, exists: true,
          },
          {
            id: "keep-a", path: "", content: "A", encoding: "UTF-8",
            line_ending: "lf", updated_at: 1700000001000000000, exists: false,
          },
          {
            id: "empty", path: "C:\\e.txt", content: "   ", encoding: "UTF-8",
            line_ending: "lf", updated_at: 1800000000000000000, exists: true,
          },
          { id: "../bad", content: "bad id", updated_at: 1800000000000000000 },
          { id: "nul", content: "a\u0000b", updated_at: 1800000000000000000 },
          { id: "no-time", content: "no timestamp", updated_at: 0 },
          { id: "missing-fields", content: "x" },
          null,
          "not json",
          {
            id: "keep-c", path: "C:\\c.txt", content: "C", encoding: "UTF-16BE",
            line_ending: "cr", updated_at: 1700000003000000000, exists: true,
          },
        ],
      };
      const service = new window.__b.recovery.RecoveryService({
        api: window.__makeApi(calls),
        timers: window.__clock().timers,
      });
      const entries = await service.list();
      service.dispose();
      return entries;
    });
    assert.deepEqual(result.map((entry) => entry.id), ["keep-c", "keep-b", "keep-a"]);
    assert.equal(result[0].lineEnding, "CR");
    assert.equal(result[1].lineEnding, "CRLF");
    assert.equal(result[1].updatedAt, 1700000002000, "nanoseconds become milliseconds");
    assert.equal(result[2].path, "");
    assert.equal(result[2].exists, false);
  });

  await test("recovery load and discardAll ignore corrupt entries", async () => {
    const result = await page.evaluate(async () => {
      const calls = {
        saves: [],
        discards: [],
        clears: [],
        listData: [
          { id: "d1", content: "one", updated_at: 1700000001000000000 },
          { id: "d2", content: "two", updated_at: 1700000002000000000 },
          { id: "bad", content: "", updated_at: 1700000003000000000 },
        ],
        loadData: {
          d1: { id: "d1", content: "one", updated_at: 1700000001000000000 },
          bad: { id: "bad", content: "", updated_at: 1700000003000000000 },
        },
      };
      const service = new window.__b.recovery.RecoveryService({
        api: window.__makeApi(calls),
        timers: window.__clock().timers,
      });
      const loaded = await service.load("d1");
      const empty = await service.load("bad");
      const count = await service.discardAll();
      service.dispose();
      return { loaded, empty, count, discards: calls.discards };
    });
    assert.equal(result.loaded?.id, "d1");
    assert.equal(result.empty, null);
    assert.equal(result.count, 2);
    assert.deepEqual(result.discards, ["d2", "d1"]);
  });

  await test("recovery uses the mocked Wails bindings end to end", async () => {
    const args = await page.evaluate(async () => {
      const service = new window.__b.recovery.RecoveryService({ delayMs: 20 });
      window.__nativeService = service;
      service.schedule({
        id: "native-1", path: null, content: "hello", encoding: "UTF-8", lineEnding: "lf",
      });
      return null;
    });
    assert.equal(args, null);
    await page.waitForFunction(() => window.__native.saves.length === 1);
    const saved = await page.evaluate(() => window.__native.saves[0]);
    assert.deepEqual(saved, ["native-1", "", "hello", "UTF-8", "LF"]);

    await page.evaluate(async () => {
      await window.__nativeService.completeSave("native-1", "C:\\native.txt");
      window.__nativeService.dispose();
    });
    const native = await page.evaluate(() => ({
      discards: window.__native.discards,
      clears: window.__native.clears,
    }));
    assert.deepEqual(native.discards, ["native-1"]);
    assert.deepEqual(native.clears, ["C:\\native.txt"]);
  });

  const entries = [
    {
      id: "a",
      path: "C:\\docs\\alpha.txt",
      content: "alpha",
      encoding: "UTF-8",
      lineEnding: "LF",
      updatedAt: 1700000001000000000,
      exists: true,
    },
    {
      id: "b",
      path: "C:\\docs\\beta.txt",
      content: "beta",
      encoding: "GB18030",
      lineEnding: "CRLF",
      updatedAt: 1700000002000000000,
      exists: false,
    },
  ];

  const waitForRecoveryResult = async () => {
    await page.waitForFunction(() => window.__dialogResult !== null);
    return page.evaluate(() => window.__dialogResult);
  };

  const openRecovery = async (list, options = {}) => {
    await page.evaluate(
      ([items, opts]) => window.__openRecovery(items, opts),
      [list, options],
    );
    await page.locator(".ce-recovery").waitFor({ state: "visible" });
  };

  await test("recovery dialog lists drafts with path, time, encoding and aria", async () => {
    await openRecovery(entries, { lang: "en" });
    const state = await page.evaluate(() => {
      const card = document.querySelector(".ce-recovery-card");
      const list = document.querySelector(".ce-recovery-list");
      return {
        role: card?.getAttribute("role"),
        modal: card?.getAttribute("aria-modal"),
        labelledby: card?.getAttribute("aria-labelledby"),
        titleId: document.getElementById(card?.getAttribute("aria-labelledby"))?.textContent,
        listRole: list?.getAttribute("role"),
        options: [...document.querySelectorAll(".ce-recovery-item")].map((row) => ({
          id: row.dataset.entryId,
          role: row.getAttribute("role"),
          selected: row.getAttribute("aria-selected"),
          tabIndex: row.tabIndex,
          name: row.querySelector(".ce-recovery-name")?.textContent,
          path: row.querySelector(".ce-recovery-path")?.textContent,
          time: row.querySelector(".ce-recovery-time")?.textContent,
          encoding: row.querySelector(".ce-recovery-encoding")?.textContent,
          missing: row.querySelector(".ce-recovery-badge")?.textContent ?? null,
        })),
        openerInert: document.getElementById("opener").inert,
        focused: document.activeElement?.dataset.entryId ?? null,
      };
    });
    assert.equal(state.role, "dialog");
    assert.equal(state.modal, "true");
    assert.match(state.titleId, /Recover/);
    assert.equal(state.listRole, "listbox");
    assert.equal(state.options.length, 2);
    assert.deepEqual(state.options.map((option) => option.id), ["a", "b"]);
    assert.deepEqual(state.options.map((option) => option.role), ["option", "option"]);
    assert.deepEqual(state.options.map((option) => option.selected), ["true", "false"]);
    assert.deepEqual(state.options.map((option) => option.tabIndex), [0, -1]);
    assert.equal(state.options[0].name, "alpha.txt");
    assert.equal(state.options[0].path, "C:\\docs\\alpha.txt");
    assert.match(state.options[0].time, /\d/);
    assert.match(state.options[0].encoding, /UTF-8/);
    assert.equal(state.options[1].missing, "Original file no longer exists");
    assert.equal(state.openerInert, true);
    assert.equal(state.focused, "a");

    await page.keyboard.press("Escape");
    const result = await waitForRecoveryResult();
    assert.deepEqual(result, { action: "cancel" });
    assert.equal(await page.locator(".ce-recovery").count(), 0);
    const restored = await page.evaluate(() => ({
      inert: document.getElementById("opener").inert,
      focused: document.activeElement?.id,
    }));
    assert.equal(restored.inert, false);
    assert.equal(restored.focused, "opener");
  });

  await test("recovery dialog keyboard restores the selected draft", async () => {
    await openRecovery(entries, { lang: "en" });
    await page.keyboard.press("ArrowDown");
    let focused = await page.evaluate(() => document.activeElement?.dataset.entryId);
    assert.equal(focused, "b");
    await page.keyboard.press("Enter");
    const result = await waitForRecoveryResult();
    assert.equal(result.action, "restore");
    assert.equal(result.entry.id, "b");
    assert.equal(await page.locator(".ce-recovery").count(), 0);
  });

  await test("recovery dialog Delete discards only the selected draft", async () => {
    await openRecovery(entries, { lang: "en" });
    await page.keyboard.press("End");
    await page.keyboard.press("Delete");
    const result = await waitForRecoveryResult();
    assert.equal(result.action, "discard");
    assert.equal(result.entry.id, "b");
    assert.equal(await page.locator(".ce-recovery").count(), 0);
  });

  await test("recovery dialog discard-all and empty state", async () => {
    await openRecovery(entries, { lang: "en" });
    await page.locator('.ce-recovery [data-action="discard-all"]').click();
    const result = await waitForRecoveryResult();
    assert.deepEqual(result, { action: "discard" });
    assert.equal(result.entry, undefined);

    await openRecovery([], { lang: "en" });
    const empty = await page.evaluate(() => ({
      text: document.querySelector(".ce-recovery-empty")?.textContent,
      restoreDisabled: document.querySelector('[data-action="restore"]')?.disabled,
      discardDisabled: document.querySelector('[data-action="discard"]')?.disabled,
      allDisabled: document.querySelector('[data-action="discard-all"]')?.disabled,
      focused: document.activeElement?.dataset.action,
    }));
    assert.match(empty.text, /No drafts/);
    assert.equal(empty.restoreDisabled, true);
    assert.equal(empty.discardDisabled, true);
    assert.equal(empty.allDisabled, true);
    assert.equal(empty.focused, "cancel");
    await page.keyboard.press("Escape");
    await waitForRecoveryResult();
  });

  await test("recovery dialog labels untitled drafts without a missing-file badge", async () => {
    await openRecovery([{
      id: "untitled-1",
      path: "",
      content: "scratch",
      encoding: "UTF-8",
      lineEnding: "LF",
      updatedAt: 1700000000000000000,
      exists: false,
    }], { lang: "en" });
    const state = await page.evaluate(() => ({
      name: document.querySelector(".ce-recovery-name")?.textContent,
      path: document.querySelector(".ce-recovery-path")?.textContent,
      badges: document.querySelectorAll(".ce-recovery-badge").length,
    }));
    assert.equal(state.name, "Untitled");
    assert.equal(state.path, "Untitled");
    assert.equal(state.badges, 0);
    await page.keyboard.press("Escape");
    await waitForRecoveryResult();
  });

  await test("recovery dialog traps Tab inside the modal", async () => {
    await openRecovery(entries, { lang: "en" });
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => (
        document.querySelector(".ce-recovery-card")?.contains(document.activeElement) ?? false
      ));
      assert.equal(inside, true, `focus escaped after Tab #${index + 1}`);
    }
    await page.keyboard.press("Escape");
    await waitForRecoveryResult();
  });

  const waitForConflict = async () => {
    await page.waitForFunction(() => window.__conflictResult !== null);
    return page.evaluate(() => window.__conflictResult);
  };

  const openConflict = async (options) => {
    await page.evaluate((opts) => window.__openConflict(opts), options);
    await page.locator(".ce-conflict").waitFor({ state: "visible" });
  };

  await test("conflict dialog warns about overwrite and defaults to Cancel when dirty", async () => {
    await openConflict({
      fileName: "notes.txt",
      path: "C:\\docs\\notes.txt",
      dirty: true,
      lang: "en",
    });
    const state = await page.evaluate(() => {
      const card = document.querySelector(".ce-conflict-card");
      return {
        role: card?.getAttribute("role"),
        modal: card?.getAttribute("aria-modal"),
        warning: document.getElementById("ce-conflict-warning")?.textContent,
        hint: document.querySelector(".ce-conflict-hint")?.textContent,
        focused: document.activeElement?.dataset.decision,
        decisions: [...document.querySelectorAll("[data-decision]")].map((node) => node.dataset.decision),
        path: document.querySelector(".ce-conflict-path")?.textContent,
      };
    });
    assert.equal(state.role, "alertdialog");
    assert.equal(state.modal, "true");
    assert.match(state.warning, /next save will overwrite/i);
    assert.match(state.hint, /Reload discards/i);
    assert.equal(state.focused, "cancel", "dirty conflicts must not default to overwriting");
    assert.deepEqual(state.decisions, ["keepLocal", "reload", "saveAs", "cancel"]);
    assert.equal(state.path, "C:\\docs\\notes.txt");

    await page.keyboard.press("Enter");
    assert.equal(await waitForConflict(), "cancel");
    assert.equal(await page.locator(".ce-conflict").count(), 0);
  });

  await test("conflict dialog returns keepLocal, reload and saveAs decisions", async () => {
    await openConflict({ fileName: "notes.txt", dirty: true, lang: "en" });
    await page.locator('[data-decision="keepLocal"]').click();
    assert.equal(await waitForConflict(), "keepLocal");

    await openConflict({ fileName: "notes.txt", dirty: true, lang: "en" });
    await page.locator('[data-decision="reload"]').click();
    assert.equal(await waitForConflict(), "reload");

    await openConflict({ fileName: "notes.txt", dirty: false, lang: "en" });
    await page.locator('[data-decision="saveAs"]').click();
    assert.equal(await waitForConflict(), "saveAs");

    await openConflict({ fileName: "notes.txt", dirty: true, lang: "en" });
    await page.evaluate(() => document.querySelector(".ce-conflict").click());
    assert.equal(await waitForConflict(), "cancel");
  });

  await test("conflict dialog uses clean wording and defaults to Reload", async () => {
    await openConflict({ fileName: "clean.txt", dirty: false, lang: "en" });
    const state = await page.evaluate(() => ({
      hint: document.querySelector(".ce-conflict-hint")?.textContent,
      warning: document.getElementById("ce-conflict-warning")?.textContent,
      focused: document.activeElement?.dataset.decision,
    }));
    assert.match(state.hint, /no unsaved changes/i);
    assert.match(state.warning, /overwrite/i);
    assert.equal(state.focused, "reload");

    await page.keyboard.press("Escape");
    assert.equal(await waitForConflict(), "cancel");
  });

  await test("encoding menu exposes aria state, current encoding and both actions", async () => {
    const state = await page.evaluate(() => {
      const host = document.getElementById("menu-host");
      host.replaceChildren();
      window.__encCalls = [];
      window.__menu = window.__b.encoding.createEncodingMenu({
        host,
        current: "UTF-8 BOM",
        lang: "en",
        reopen: (encoding) => window.__encCalls.push({ action: "reopen", encoding }),
        save: (encoding) => window.__encCalls.push({ action: "save", encoding }),
      });
      const trigger = host.querySelector(".ce-encoding-trigger");
      return {
        text: trigger?.textContent,
        haspopup: trigger?.getAttribute("aria-haspopup"),
        expanded: trigger?.getAttribute("aria-expanded"),
        controls: trigger?.getAttribute("aria-controls"),
        label: trigger?.getAttribute("aria-label"),
        disabled: trigger?.disabled,
      };
    });
    assert.equal(state.text, "UTF-8 BOM");
    assert.equal(state.haspopup, "menu");
    assert.equal(state.expanded, "false");
    assert.match(state.label, /Encoding: UTF-8 BOM/);
    assert.equal(state.disabled, false);

    await page.locator("#menu-host .ce-encoding-trigger").click();
    const openState = await page.evaluate(() => ({
      expanded: document.querySelector("#menu-host .ce-encoding-trigger")?.getAttribute("aria-expanded"),
      visible: !document.querySelector("#menu-host .ce-encoding-menu")?.hidden,
      menuRole: document.querySelector("#menu-host .ce-encoding-menu")?.getAttribute("role"),
      groups: document.querySelectorAll("#menu-host .ce-encoding-group").length,
      items: document.querySelectorAll("#menu-host .ce-encoding-item").length,
      roles: [...document.querySelectorAll("#menu-host .ce-encoding-item")].map((node) => node.getAttribute("role")),
      current: document.querySelector('#menu-host .ce-encoding-group[data-current="true"] .ce-encoding-group-label')?.textContent,
      focused: document.activeElement?.getAttribute("aria-label"),
    }));
    assert.equal(openState.expanded, "true");
    assert.equal(openState.visible, true);
    assert.equal(openState.menuRole, "menu");
    assert.equal(openState.groups, 5);
    assert.equal(openState.items, 10);
    assert.deepEqual(new Set(openState.roles), new Set(["menuitem"]));
    assert.equal(openState.current, "UTF-8 BOM");
    assert.match(openState.focused, /UTF-8: Reopen/);
  });

  await test("encoding menu keyboard activates an action and closes", async () => {
    await page.keyboard.press("ArrowDown");
    let focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    assert.match(focused, /UTF-8: Save/);
    await page.keyboard.press("Enter");
    const state = await page.evaluate(() => ({
      calls: window.__encCalls,
      expanded: document.querySelector("#menu-host .ce-encoding-trigger")?.getAttribute("aria-expanded"),
      hidden: document.querySelector("#menu-host .ce-encoding-menu")?.hidden,
      focused: document.activeElement?.className,
    }));
    assert.deepEqual(state.calls, [{ action: "save", encoding: "UTF-8" }]);
    assert.equal(state.expanded, "false");
    assert.equal(state.hidden, true);
    assert.match(state.focused, /ce-encoding-trigger/);
  });

  await test("encoding menu End/Escape navigation and focus restoration", async () => {
    await page.locator("#menu-host .ce-encoding-trigger").click();
    await page.keyboard.press("End");
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    assert.match(focused, /GB18030: Save/);
    await page.keyboard.press("Escape");
    const state = await page.evaluate(() => ({
      expanded: document.querySelector("#menu-host .ce-encoding-trigger")?.getAttribute("aria-expanded"),
      focused: document.activeElement?.className,
    }));
    assert.equal(state.expanded, "false");
    assert.match(state.focused, /ce-encoding-trigger/);

    await page.locator("#menu-host .ce-encoding-trigger").click();
    await page.keyboard.press("Tab");
    const tabState = await page.evaluate(() => ({
      hidden: document.querySelector("#menu-host .ce-encoding-menu")?.hidden,
      focused: document.activeElement?.className,
    }));
    assert.equal(tabState.hidden, true);
    assert.match(tabState.focused, /ce-encoding-trigger/);
  });

  await test("encoding menu disables missing implementations", async () => {
    const state = await page.evaluate(() => {
      const host = document.getElementById("menu-host-2");
      host.replaceChildren();
      window.__menu2 = window.__b.encoding.createEncodingMenu({
        host,
        current: "GB18030",
        lang: "en",
        reopen: () => {},
      });
      const trigger = host.querySelector(".ce-encoding-trigger");
      return {
        triggerDisabled: trigger?.disabled,
        saveDisabled: [...host.querySelectorAll('[data-action="save"]')].map((node) => node.disabled),
        reopenDisabled: [...host.querySelectorAll('[data-action="reopen"]')].map((node) => node.disabled),
      };
    });
    assert.equal(state.triggerDisabled, false);
    assert.deepEqual(state.saveDisabled, [true, true, true, true, true]);
    assert.deepEqual(state.reopenDisabled, [false, false, false, false, false]);

    await page.locator("#menu-host-2 .ce-encoding-trigger").click();
    assert.equal(
      await page.locator('#menu-host-2 [data-action="save"]').first().getAttribute("aria-disabled"),
      "true",
    );
    await page.evaluate(() => {
      window.__menu2.setHandlers({});
    });
    const disabled = await page.evaluate(() => {
      const trigger = document.querySelector("#menu-host-2 .ce-encoding-trigger");
      return {
        disabled: trigger?.disabled,
        ariaDisabled: trigger?.getAttribute("aria-disabled"),
        hidden: document.querySelector("#menu-host-2 .ce-encoding-menu")?.hidden,
      };
    });
    assert.equal(disabled.disabled, true);
    assert.equal(disabled.ariaDisabled, "true");
    assert.equal(disabled.hidden, true);

    const noHandlers = await page.evaluate(() => {
      const host = document.getElementById("menu-host-3");
      host.replaceChildren();
      const menu = window.__b.encoding.createEncodingMenu({ host, lang: "en" });
      const trigger = host.querySelector(".ce-encoding-trigger");
      menu.open();
      const result = {
        disabled: trigger?.disabled,
        ariaDisabled: trigger?.getAttribute("aria-disabled"),
        expanded: trigger?.getAttribute("aria-expanded"),
        hidden: host.querySelector(".ce-encoding-menu")?.hidden,
      };
      menu.destroy();
      return { ...result, removed: host.childElementCount };
    });
    assert.equal(noHandlers.disabled, true);
    assert.equal(noHandlers.ariaDisabled, "true");
    assert.equal(noHandlers.expanded, "false");
    assert.equal(noHandlers.hidden, true);
    assert.equal(noHandlers.removed, 0);

    await page.evaluate(() => window.__menu.destroy());
    assert.equal(await page.locator("#menu-host .ce-encoding-root").count(), 0);
  });

  await test("no unexpected page errors", () => {
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
  });
} catch (error) {
  failures.push("suite crashed");
  console.error(`FAIL suite crashed: ${error.stack || error}`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\nregression-b-dialogs: ${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nregression-b-dialogs: all checks passed");
