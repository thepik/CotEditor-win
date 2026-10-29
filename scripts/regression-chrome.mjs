// Real-menu browser regressions. Run against a Vite dev server (module imports
// are used only for setup/observations; commands and theme changes are clicked).
// node scripts/regression-chrome.mjs http://127.0.0.1:1420/
import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1420/";
const names = ["Anura", "Anura (Dark)", "Classic", "Dendrobates", "Dendrobates (Dark)",
  "Kawazu", "Lakritz", "Mono", "Note", "Printen", "Pulse", "Resinifictrix", "Resinifictrix (Dark)"];
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(10000);
const failures = [];
const errors = [];
page.on("pageerror", (error) => {
  // Disposing a tab/model cancels Monaco's internal caret/scroll delayers.
  if (error.message === "Canceled") return;
  errors.push(error.message);
});
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
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

async function bindModules() {
  await page.waitForFunction(() => document.querySelectorAll("#menubar > .ce-menu-item").length > 0);
  // Vite may append an HMR stamp (`?t=...`) to the specifier main.ts loaded.
  // Bind to the exact URL the page executed, otherwise the dynamic import gets
  // a second module instance with an empty theme registry / no editor.
  await page.evaluate(async () => {
    const pick = (suffix) => [...new Set(performance.getEntriesByType("resource").map((entry) => entry.name))]
      .filter((name) => name.includes(suffix)).pop() ?? suffix;
    window.__chrome = {
      ...(await import(pick("/src/editor/monaco-setup.ts"))),
      ...(await import(pick("/src/editor/theme-loader.ts"))),
    };
  });
  await page.waitForFunction(() => window.__chrome.listThemes().length === 13);
}

const top = (label) => page.locator("#menubar > .ce-menu-item").filter({ hasText: label });
async function openMenu(label) {
  if (await page.locator(".ce-menu-dropdown").count()) await page.keyboard.press("Escape");
  await top(label).click();
  return page.locator(".ce-menu-dropdown");
}
async function clickItem(menu, label) {
  const dropdown = await openMenu(menu);
  await dropdown.locator("button").filter({ hasText: label }).click();
}
async function setText(text) {
  await page.evaluate((value) => {
    const { getModel, getEditor } = window.__chrome;
    getModel().setValue(value);
    getEditor().setPosition({ lineNumber: 1, column: 1 });
    getEditor().focus();
  }, text);
}
/** One undo group, so a single menu Undo restores the empty document. */
async function setUndoableText(text) {
  await page.evaluate((value) => {
    const { getModel, getEditor } = window.__chrome;
    const model = getModel();
    model.setValue("");
    model.pushStackElement();
    getEditor().executeEdits("regression", [{ range: model.getFullModelRange(), text: value }]);
    model.pushStackElement();
    getEditor().setPosition({ lineNumber: 1, column: 1 });
    getEditor().focus();
  }, text);
}
async function expectText(text) {
  await page.waitForFunction((expected) => window.__chrome.getModel().getValue() === expected, text);
}
async function expectEditorFocus() {
  await page.waitForFunction(() => window.__chrome.getEditor().hasTextFocus());
}
async function expectSingleTabStop() {
  assert.equal(await page.locator('#menubar [tabindex="0"]').count(), 1);
}
async function chooseTheme(name) {
  await openMenu(/^(主题|Theme)/);
  await page.locator(`[data-menu-action="theme-${name}"]`).click();
  assert.equal(await page.evaluate(() => window.__chrome.getCurrentTheme()), name);
}

try {
  // Complete real network requests in reverse order. Menu order and theme ids
  // must not depend on which resource wins the loading race.
  const pending = [];
  const responseOrder = [];
  await page.route("**/resources/themes/*.cottheme", async (route) => {
    const response = await route.fetch();
    pending.push({ route, response });
    if (pending.length === names.length) {
      for (const entry of [...pending].reverse()) {
        responseOrder.push(decodeURIComponent(new URL(entry.route.request().url()).pathname));
        await entry.route.fulfill({ response: entry.response });
      }
    }
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  // These calls overlap bootstrap's own loadAllThemes call. Both must return
  // the same in-flight promise; a second module instance would issue another
  // 13 requests and the route gate below would never release.
  await page.evaluate(async () => {
    const pick = (suffix) => [...new Set(performance.getEntriesByType("resource").map((entry) => entry.name))]
      .filter((name) => name.includes(suffix)).pop() ?? suffix;
    const { loadAllThemes } = await import(pick("/src/editor/theme-loader.ts"));
    const first = loadAllThemes();
    const second = loadAllThemes();
    window.__themePreload = {
      same: first === second,
      done: Promise.race([
        Promise.all([first, second]).then(() => "loaded"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 15000)),
      ]),
    };
  });
  await bindModules();
  await page.unroute("**/resources/themes/*.cottheme");

  await test("13 unique theme ids, deterministic order, one concurrent load", async () => {
    const result = await page.evaluate(() => {
      const { listThemes, monacoThemeId, getCurrentTheme, getPreferredTheme } = window.__chrome;
      return { names: listThemes(), ids: listThemes().map(monacoThemeId), current: getCurrentTheme(), preferred: getPreferredTheme() };
    });
    const preload = await page.evaluate(async () => ({
      same: window.__themePreload.same,
      result: await window.__themePreload.done,
    }));
    assert.equal(preload.same, true, "loadAllThemes must share one in-flight promise");
    assert.equal(preload.result, "loaded");
    assert.deepEqual(result.names, names);
    assert.equal(new Set(result.ids).size, 13);
    assert(result.ids.every((id) => /^[a-z0-9-]+$/.test(id)));
    assert.equal(result.ids[1], "anura-dark");
    assert.equal(pending.length, 13);
    assert.equal(responseOrder.length, 13);
    assert.equal(result.current, "Classic");
    assert.equal(result.preferred, "Classic");
  });

  await test("actual clicks undo/redo the typed edit and restore editor focus", async () => {
    await setUndoableText("menu undo and redo");
    await expectText("menu undo and redo");
    await clickItem(/^(编辑|Edit)/, /撤销|Undo/);
    await expectText("");
    await expectEditorFocus();
    await clickItem(/^(编辑|Edit)/, /重做|Redo/);
    await expectText("menu undo and redo");
    await expectEditorFocus();
  });

  await test("registered Monaco action still executes from a menu", async () => {
    await setText("z\na");
    await openMenu(/^(格式|Format)/);
    await page.locator('[data-menu-action="coteditor.sortLinesAscending"]').click();
    await expectText("a\nz");
    await expectEditorFocus();
  });

  for (const [option, label] of [
    ["lineNumbers", /切换行号显示|Toggle Line Numbers/],
    ["wordWrap", /切换自动换行|Toggle Word Wrap/],
    ["renderWhitespace", /切换空白字符显示|Toggle Render Whitespace/],
  ]) {
    await test(`${option}: two real clicks update option and checked state (main integration)`, async () => {
      const read = () => page.evaluate((name) => {
        const { getEditor, monaco } = window.__chrome;
        const value = getEditor().getOption(monaco.editor.EditorOption[name]);
        return name === "lineNumbers" ? value.renderType !== 0 : name === "wordWrap" ? value !== "off" : value === "all";
      }, option);
      const initial = await read();
      for (const expected of [!initial, initial]) {
        await openMenu(/^(视图|View)/);
        const item = page.getByRole("menuitemcheckbox", { name: label });
        assert.equal(await item.getAttribute("aria-checked"), String(!expected));
        await item.click();
        assert.equal(await read(), expected);
        await openMenu(/^(视图|View)/);
        assert.equal(await page.getByRole("menuitemcheckbox", { name: label }).getAttribute("aria-checked"), String(expected));
        await page.keyboard.press("Escape");
      }
    });
  }

  await test("F10, arrows, Home/End, menu switching and Escape focus restoration", async () => {
    await setText("keyboard focus");
    await page.keyboard.press("F10");
    await expectSingleTabStop();
    await page.keyboard.press("Home");
    assert(await top(/^(文件|File)/).evaluate((element) => element === document.activeElement));
    await page.keyboard.press("ArrowRight");
    assert(await top(/^(编辑|Edit)/).evaluate((element) => element === document.activeElement));
    await page.keyboard.press("ArrowDown");
    const items = () => page.locator(".ce-menu-dropdown button:not(:disabled)");
    assert(await items().first().evaluate((element) => element === document.activeElement));
    await expectSingleTabStop();
    await page.keyboard.press("ArrowDown");
    assert(await items().nth(1).evaluate((element) => element === document.activeElement));
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("End");
    assert(await items().last().evaluate((element) => element === document.activeElement));
    await page.keyboard.press("ArrowDown");
    assert(await items().first().evaluate((element) => element === document.activeElement));
    await page.keyboard.press("ArrowUp");
    assert(await items().last().evaluate((element) => element === document.activeElement));
    await page.keyboard.press("Home");
    assert(await items().first().evaluate((element) => element === document.activeElement));
    await page.keyboard.press("ArrowLeft");
    assert.equal(await top(/^(文件|File)/).getAttribute("aria-expanded"), "true");
    assert(await items().first().evaluate((element) => element === document.activeElement));
    await page.keyboard.press("ArrowRight");
    assert.equal(await top(/^(编辑|Edit)/).getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".ce-menu-dropdown").count(), 0);
    await expectSingleTabStop();
    await expectEditorFocus();
  });

  await test("bare Alt enters/exits; Tab leaves menus; source control regains focus", async () => {
    await page.keyboard.press("Alt");
    assert(await page.evaluate(() => document.activeElement?.matches("#menubar > .ce-menu-item")));
    await page.keyboard.press("Alt");
    await expectEditorFocus();
    await page.keyboard.press("F10");
    await page.keyboard.press("ArrowUp");
    assert(await page.locator(".ce-menu-dropdown button:not(:disabled)").last().evaluate((element) => element === document.activeElement));
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(".ce-menu-dropdown").count(), 0);
    assert(await page.evaluate(() => !document.getElementById("menubar").contains(document.activeElement)));
    const source = page.locator("#toolbar select").first();
    await source.focus();
    await openMenu(/^(编辑|Edit)/);
    await page.keyboard.press("Escape");
    assert(await source.evaluate((element) => element === document.activeElement));
    await page.keyboard.press("Alt+ArrowLeft");
    assert.equal(await page.locator(".ce-menu-dropdown").count(), 0);
    assert(await source.evaluate((element) => element === document.activeElement));
  });

  await test("disabled items are skipped and modal blocks background menu activation", async () => {
    await setText("unsaved modal test");
    await openMenu(/^(视图|View)/);
    const disabled = page.locator(".ce-menu-dropdown button:disabled");
    assert((await disabled.count()) > 0, "plaintext preview should be disabled");
    await page.keyboard.press("Home");
    const enabledCount = await page.locator(".ce-menu-dropdown button:not(:disabled)").count();
    for (let index = 0; index < enabledCount; index++) {
      assert(await page.evaluate(() => document.activeElement?.matches(".ce-menu-dropdown button:not(:disabled)")));
      await page.keyboard.press("ArrowDown");
    }
    await openMenu(/^(编辑|Edit)/);
    // main.ts builds Undo with a callback rather than a Monaco action id, so
    // locate it by label instead of data-menu-action.
    await page.evaluate(() => {
      window.__backgroundMenuButton = [...document.querySelectorAll(".ce-menu-dropdown button")]
        .find((button) => /^(撤销|Undo)/.test(button.textContent ?? ""));
    });
    assert.equal(await page.evaluate(() => !!window.__backgroundMenuButton), true);

    // New always opens another tab now; it must not prompt or replace the
    // dirty buffer.
    await openMenu(/^(文件|File)/);
    await page.locator('[data-menu-action="new"]').click();
    await page.waitForFunction(() => document.querySelectorAll("#tabs .ce-tabs-tab").length === 2);
    assert.equal(await page.locator(".ce-modal").count(), 0, "New must not prompt");
    await page.keyboard.press("Control+1");
    await expectText("unsaved modal test");

    // Closing the dirty tab is the modal path used to prove that background
    // menu activation stays inert while a dialog owns focus.
    await page.keyboard.press("Control+w");
    await page.locator('[role="alertdialog"]').waitFor();
    assert.equal(await page.locator(".ce-menu-dropdown").count(), 0);
    assert(await page.evaluate(() => !!document.activeElement?.closest('[role="alertdialog"]')));
    await page.keyboard.press("F10");
    await page.keyboard.press("Alt");
    await page.evaluate(() => {
      document.querySelector("#menubar > .ce-menu-item").click();
      window.__backgroundMenuButton.click();
      delete window.__backgroundMenuButton;
    });
    assert.equal(await page.locator(".ce-menu-dropdown").count(), 0);
    assert(await page.evaluate(() => !!document.activeElement?.closest('[role="alertdialog"]')));
    await expectText("unsaved modal test");
    await page.locator('[data-decision="cancel"]').click();
    await expectEditorFocus();
  });

  await test("all 13 theme clicks match original editor backgrounds and chrome luminance", async () => {
    for (const name of names) {
      await chooseTheme(name);
      const result = await page.evaluate(async (name) => {
        const theme = await (await fetch(`/resources/themes/${encodeURIComponent(name)}.cottheme`)).json();
        const hex = typeof theme.background === "string" ? theme.background : theme.background.color;
        const rgb = hex.slice(1, 7).match(/../g).map((part) => parseInt(part, 16));
        const dark = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 < 127.5;
        const canvas = document.querySelector("#editor .monaco-editor-background");
        const toolbar = getComputedStyle(document.getElementById("toolbar")).backgroundColor;
        const chromeRgb = toolbar.match(/[\d.]+/g).slice(0, 3).map(Number);
        return {
          expected: `rgb(${rgb.join(", ")})`, actual: getComputedStyle(canvas).backgroundColor,
          expectedMode: dark ? "dark" : "light", actualMode: document.documentElement.dataset.ceTheme,
          chromeMode: chromeRgb[0] * .2126 + chromeRgb[1] * .7152 + chromeRgb[2] * .0722 < 127.5 ? "dark" : "light",
        };
      }, name);
      assert.equal(result.actual, result.expected, `${name} editor background`);
      assert.equal(result.actualMode, result.expectedMode, `${name} chrome dataset`);
      assert.equal(result.chromeMode, result.expectedMode, `${name} toolbar luminance`);
      await openMenu(/^(主题|Theme)/);
      assert.equal(await page.locator('.ce-menu-dropdown [aria-checked="true"]').count(), 1);
      assert.equal(await page.locator(`[data-menu-action="theme-${name}"]`).getAttribute("role"), "menuitemcheckbox");
      assert.equal(await page.locator(`[data-menu-action="theme-${name}"]`).getAttribute("aria-checked"), "true");
      await page.keyboard.press("Escape");
    }
  });

  await test("independent keyword/command and string/character theme scope colours", async () => {
    await chooseTheme("Anura");
    const result = await page.evaluate(async () => {
      const { monaco } = window.__chrome;
      const scopes = ["keyword", "keyword.commands", "string", "string.characters", "keywords", "commands", "strings", "characters"];
      const sourceScopes = ["keywords", "commands", "strings", "characters", "keywords", "commands", "strings", "characters"];
      const theme = await (await fetch("/resources/themes/Anura.cottheme")).json();
      monaco.languages.register({ id: "ce-theme-probe" });
      const state = { clone() { return this; }, equals(other) { return this === other; } };
      const provider = monaco.languages.setTokensProvider("ce-theme-probe", {
        getInitialState: () => state,
        tokenize: (line, endState) => ({ endState, tokens: [...line.matchAll(/\S+/g)].map((match) => ({ startIndex: match.index, scopes: match[0] })) }),
      });
      const element = document.createElement("div");
      element.innerHTML = await monaco.editor.colorize(scopes.join(" "), "ce-theme-probe", {});
      document.body.appendChild(element);
      // colorize wraps the whole line in an outer span; only leaf spans are tokens.
      const actual = [...element.querySelectorAll("span")]
        .filter((span) => !span.querySelector("span") && span.textContent.trim())
        .map((span) => getComputedStyle(span).color);
      element.remove();
      provider.dispose();
      const expected = sourceScopes.map((scope) => `rgb(${theme[scope].color.slice(1).match(/../g).map((part) => parseInt(part, 16)).join(", ")})`);
      return { actual, expected };
    });
    assert.deepEqual(result.actual, result.expected);
  });

  await test("Wails theme API receives light/dark and unsupported runtime is caught (mock)", async () => {
    assert.equal(await page.evaluate(() => "runtime" in window), false, "run this suite on the browser dev server");
    await page.evaluate(() => {
      window.__nativeThemeCalls = [];
      window.runtime = {
        WindowSetLightTheme: () => window.__nativeThemeCalls.push("light"),
        WindowSetDarkTheme: () => window.__nativeThemeCalls.push("dark"),
      };
    });
    try {
      await chooseTheme("Anura");
      await chooseTheme("Anura (Dark)");
      assert.deepEqual(await page.evaluate(() => window.__nativeThemeCalls), ["light", "dark"]);
      await page.evaluate(() => { window.runtime.WindowSetDarkTheme = () => { throw new Error("Unsupported runtime fixture"); }; });
      await chooseTheme("Dendrobates (Dark)");
      assert.equal(await page.evaluate(() => window.__chrome.getPreferredTheme()), "Dendrobates (Dark)");
    } finally {
      await page.evaluate(() => { delete window.runtime; delete window.__nativeThemeCalls; });
    }
  });

  await test("theme selection survives full reload (main getPreferredTheme integration)", async () => {
    await chooseTheme("Anura (Dark)");
    assert.equal(await page.evaluate(() => localStorage.getItem("coteditor.theme.v1")), "Anura (Dark)");
    await setText("");
    await page.reload({ waitUntil: "domcontentloaded" });
    await bindModules();
    assert.equal(await page.evaluate(() => window.__chrome.getCurrentTheme()), "Anura (Dark)");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.ceTheme), "dark");
  });

  await test("invalid stored theme falls back to Classic", async () => {
    await page.evaluate(() => localStorage.setItem("coteditor.theme.v1", "not-a-theme"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await bindModules();
    assert.equal(await page.evaluate(() => window.__chrome.getCurrentTheme()), "Classic");
  });

  await test("unsupported menu actions and rejected callbacks surface an error", async () => {
    await page.evaluate(async () => {
      const { renderMenuBar } = await import("/src/ui/menubar.ts");
      renderMenuBar([{ label: "Regression", items: [
        { label: "Missing action", monacoAction: "regression.nonexistent" },
        { label: "Rejected callback", run: async () => { throw new Error("Expected callback rejection"); } },
      ] }]);
      window.__chrome.getEditor().focus();
    });
    await clickItem(/^Regression/, /Missing action/);
    await page.locator('.ce-toast-error').filter({ hasText: /Missing action/ }).waitFor();
    await expectEditorFocus();
    await clickItem(/^Regression/, /Rejected callback/);
    await page.locator('.ce-toast-error').filter({ hasText: /Rejected callback/ }).waitFor();
    await expectEditorFocus();
  });

  await test("no unhandled runtime errors", async () => assert.deepEqual(errors, []));
} catch (error) {
  failures.push("suite setup");
  console.error(error.stack || error);
  if (errors.length) console.error("Runtime errors:", errors);
} finally {
  await browser.close();
}
console.log(failures.length ? `FAIL (${failures.length}): ${failures.join("; ")}` : "ALL CHROME REGRESSIONS PASS");
process.exitCode = failures.length ? 1 : 0;
