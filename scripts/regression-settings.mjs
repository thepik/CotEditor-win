// Settings + recent-files regression (PLAN phase C).
//
// Run against the Vite dev server without changing app sources:
//   node scripts/regression-settings.mjs http://127.0.0.1:1420/
//
// Loads the real TypeScript modules through Vite's dynamic import and verifies
// them against the live Monaco editor. This is a Chromium regression; it does
// not cover the native WebView2 shell.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1420/";
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const runtimeErrors = [];
page.on("pageerror", (error) => runtimeErrors.push(error.message));

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  // Bind to the exact module URLs the app executed (same approach as
  // smoke-test.mjs). Vite appends an HMR stamp (`?t=...`) to edited modules;
  // importing the bare specifier would create a second, uninitialised module
  // instance whose getEditor() returns null while the live editor lives in the
  // instance the page loaded.
  await page.evaluate(async () => {
    const pick = (suffix) => [...new Set(performance.getEntriesByType("resource").map((entry) => entry.name))]
      .filter((name) => name.includes(suffix)).pop() ?? suffix;
    const [monacoSetup, settings, recentFiles] = await Promise.all([
      import(pick("/src/editor/monaco-setup.ts")),
      import(pick("/src/lib/settings.ts")),
      import(pick("/src/lib/recent-files.ts")),
    ]);
    window.__settingsRegression = { monacoSetup, settings, recentFiles };
  });
  await page.waitForFunction(() => {
    const editor = window.__settingsRegression?.monacoSetup?.getEditor?.();
    return !!editor?.getModel();
  }, null, { timeout: 30000 });

  const report = await page.evaluate(async () => {
    const { monacoSetup, settings: settingsModule, recentFiles: recentModule } = window.__settingsRegression;
    const { monaco, getEditor } = monacoSetup;
    // HMR can replace the setup module between the readiness wait and this
    // evaluate; retry briefly so we still assert against the live editor
    // instead of a transient null.
    const getLiveEditor = async (attempts = 20, delayMs = 100) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const candidate = getEditor();
        if (candidate?.getModel()) return candidate;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return getEditor();
    };

    const results = [];
    const check = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const equal = (actual, expected, message) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

    const settingsKey = settingsModule.SETTINGS_STORAGE_KEY;
    const recentKey = recentModule.RECENT_FILES_STORAGE_KEY;
    const resetSettings = () => localStorage.removeItem(settingsKey);
    const resetRecent = () => localStorage.removeItem(recentKey);
    resetSettings();
    resetRecent();

    /* ------------------------------- settings ------------------------------- */

    await record("settings: defaults match the documented schema", () => {
      const defaults = settingsModule.getDefaultSettings();
      equal(defaults.language, "zh", "language");
      equal(defaults.autoSave, false, "autoSave");
      equal(defaults.autoSaveDelayMs, 5000, "autoSaveDelayMs");
      equal(defaults.fontSize, 14, "fontSize");
      equal(defaults.fontFamily, settingsModule.DEFAULT_FONT_FAMILY, "fontFamily");
      equal(defaults.lineNumbers, true, "lineNumbers");
      equal(defaults.wordWrap, "on", "wordWrap");
      equal(defaults.renderWhitespace, "selection", "renderWhitespace");
      equal(defaults.tabSize, 4, "tabSize");
      equal(defaults.insertSpaces, true, "insertSpaces");
      equal(defaults.showOutline, false, "showOutline");
      check(defaults.theme === undefined, "theme should be unset");
      check(defaults.outlineWidth === undefined, "outlineWidth should be unset");
      check(settingsModule.getDefaultSettings() !== defaults, "defaults must be a fresh copy");
    });

    await record("settings: missing storage loads defaults", () => {
      resetSettings();
      equal(settingsModule.loadSettings(), settingsModule.getDefaultSettings(), "loaded defaults");
    });

    await record("settings: corrupt JSON loads defaults", () => {
      localStorage.setItem(settingsKey, "{ definitely not json");
      equal(settingsModule.loadSettings(), settingsModule.getDefaultSettings(), "fallback");
    });

    await record("settings: foreign payload shapes load defaults", () => {
      for (const payload of ["null", "[]", '"text"', "42", "true"]) {
        localStorage.setItem(settingsKey, payload);
        equal(settingsModule.loadSettings(), settingsModule.getDefaultSettings(), `payload ${payload}`);
      }
    });

    await record("settings: invalid fields fall back individually", () => {
      localStorage.setItem(settingsKey, JSON.stringify({
        theme: 42,
        language: "fr",
        autoSave: "yes",
        autoSaveDelayMs: 999,
        fontSize: 99,
        fontFamily: "   ",
        lineNumbers: "false",
        wordWrap: "wrap",
        renderWhitespace: "sometimes",
        tabSize: 0,
        insertSpaces: 1,
        showOutline: "yes",
        outlineWidth: -20,
      }));
      const loaded = settingsModule.loadSettings();
      const defaults = settingsModule.getDefaultSettings();
      equal(loaded.language, defaults.language, "language");
      equal(loaded.autoSave, defaults.autoSave, "autoSave");
      equal(loaded.autoSaveDelayMs, defaults.autoSaveDelayMs, "autoSaveDelayMs");
      equal(loaded.fontSize, defaults.fontSize, "fontSize");
      equal(loaded.fontFamily, defaults.fontFamily, "fontFamily");
      equal(loaded.lineNumbers, defaults.lineNumbers, "lineNumbers");
      equal(loaded.wordWrap, defaults.wordWrap, "wordWrap");
      equal(loaded.renderWhitespace, defaults.renderWhitespace, "renderWhitespace");
      equal(loaded.tabSize, defaults.tabSize, "tabSize");
      equal(loaded.insertSpaces, defaults.insertSpaces, "insertSpaces");
      equal(loaded.showOutline, defaults.showOutline, "showOutline");
      check(loaded.theme === undefined, "invalid theme must be unset");
      check(loaded.outlineWidth === undefined, "invalid outlineWidth must be unset");
    });

    await record("settings: boundary values and valid fields survive", () => {
      localStorage.setItem(settingsKey, JSON.stringify({
        theme: "  Nord  ",
        language: "en",
        autoSave: true,
        autoSaveDelayMs: 1000,
        fontSize: 32,
        fontFamily: "Consolas",
        lineNumbers: false,
        wordWrap: "off",
        renderWhitespace: "all",
        tabSize: 8,
        insertSpaces: false,
        showOutline: true,
        outlineWidth: 160,
      }));
      const loaded = settingsModule.loadSettings();
      equal(loaded.theme, "Nord", "theme trimmed");
      equal(loaded.language, "en", "language");
      equal(loaded.autoSave, true, "autoSave");
      equal(loaded.autoSaveDelayMs, 1000, "autoSaveDelayMs lower bound");
      equal(loaded.fontSize, 32, "fontSize upper bound");
      equal(loaded.fontFamily, "Consolas", "fontFamily");
      equal(loaded.lineNumbers, false, "lineNumbers");
      equal(loaded.wordWrap, "off", "wordWrap");
      equal(loaded.renderWhitespace, "all", "renderWhitespace");
      equal(loaded.tabSize, 8, "tabSize upper bound");
      equal(loaded.insertSpaces, false, "insertSpaces");
      equal(loaded.showOutline, true, "showOutline");
      equal(loaded.outlineWidth, 160, "outlineWidth lower bound");
    });

    await record("settings: partial save merges, persists and returns", () => {
      resetSettings();
      const saved = settingsModule.saveSettings({
        fontSize: 18,
        autoSave: true,
        autoSaveDelayMs: 7000,
        theme: "Solarized Light",
        language: "en",
      });
      equal(saved.fontSize, 18, "returned fontSize");
      equal(saved.autoSave, true, "returned autoSave");
      equal(saved.lineNumbers, true, "untouched lineNumbers");
      equal(saved.tabSize, 4, "untouched tabSize");
      const loaded = settingsModule.loadSettings();
      equal(loaded, saved, "persisted settings");
      const raw = JSON.parse(localStorage.getItem(settingsKey));
      equal(raw.fontSize, 18, "stored fontSize");
      equal(raw.autoSaveDelayMs, 7000, "stored autoSaveDelayMs");
      equal(raw.theme, "Solarized Light", "stored theme");
    });

    await record("settings: invalid partial save falls back to defaults", () => {
      settingsModule.saveSettings({
        fontSize: 1,
        autoSaveDelayMs: 60001,
        tabSize: 9,
        language: "de",
        wordWrap: "soft",
        renderWhitespace: "trailing",
        lineNumbers: "on",
        insertSpaces: 0,
        showOutline: null,
        outlineWidth: 10,
      });
      const loaded = settingsModule.loadSettings();
      const defaults = settingsModule.getDefaultSettings();
      equal(loaded.fontSize, defaults.fontSize, "fontSize");
      equal(loaded.autoSaveDelayMs, defaults.autoSaveDelayMs, "autoSaveDelayMs");
      equal(loaded.tabSize, defaults.tabSize, "tabSize");
      equal(loaded.language, defaults.language, "language");
      equal(loaded.wordWrap, defaults.wordWrap, "wordWrap");
      equal(loaded.renderWhitespace, defaults.renderWhitespace, "renderWhitespace");
      equal(loaded.lineNumbers, defaults.lineNumbers, "lineNumbers");
      equal(loaded.insertSpaces, defaults.insertSpaces, "insertSpaces");
      equal(loaded.showOutline, defaults.showOutline, "showOutline");
      check(loaded.outlineWidth === undefined, "outlineWidth");
    });

    await record("settings: subscription notifies a copy and unsubscribes", () => {
      resetSettings();
      const seen = [];
      const unsubscribe = settingsModule.subscribeSettings((value) => seen.push(value));
      try {
        settingsModule.saveSettings({ fontSize: 20 });
        equal(seen.length, 1, "one notification");
        equal(seen[0].fontSize, 20, "notified value");
        seen[0].fontSize = 99;
        equal(settingsModule.loadSettings().fontSize, 20, "listener copy is isolated");
        settingsModule.saveSettings({ fontSize: 20 });
        equal(seen.length, 1, "no notification for an unchanged value");
      } finally {
        unsubscribe();
      }
      settingsModule.saveSettings({ fontSize: 21 });
      equal(seen.length, 1, "unsubscribed listener stays silent");
    });

    await record("settings: applyEditorSettings updates the live Monaco editor", async () => {
      const editor = await getLiveEditor();
      check(editor, "editor missing");
      const model = editor.getModel();
      check(model, "model missing");
      const defaults = settingsModule.getDefaultSettings();
      const option = (name) => editor.getOption(monaco.editor.EditorOption[name]);
      const original = {
        fontFamily: option("fontFamily"),
        fontSize: option("fontSize"),
        lineNumbers: option("lineNumbers").renderType,
        wordWrap: option("wordWrap"),
        renderWhitespace: option("renderWhitespace"),
        tabSize: model.getOptions().tabSize,
        insertSpaces: model.getOptions().insertSpaces,
      };
      try {
        settingsModule.applyEditorSettings(editor, {
          ...defaults,
          fontFamily: '"Courier New", monospace',
          fontSize: 22,
          lineNumbers: false,
          wordWrap: "off",
          renderWhitespace: "all",
          tabSize: 2,
          insertSpaces: false,
        });
        equal(option("fontFamily"), '"Courier New", monospace', "fontFamily");
        equal(option("fontSize"), 22, "fontSize");
        equal(option("lineNumbers").renderType, monaco.editor.RenderLineNumbersType.Off, "lineNumbers off");
        equal(option("wordWrap"), "off", "wordWrap");
        equal(option("renderWhitespace"), "all", "renderWhitespace");
        equal(model.getOptions().tabSize, 2, "tabSize");
        equal(model.getOptions().insertSpaces, false, "insertSpaces");

        settingsModule.applyEditorSettings(editor, {
          ...defaults,
          lineNumbers: true,
          wordWrap: "on",
          renderWhitespace: "none",
        });
        check(option("lineNumbers").renderType !== monaco.editor.RenderLineNumbersType.Off, "lineNumbers back on");
        equal(option("wordWrap"), "on", "wordWrap on");
        equal(option("renderWhitespace"), "none", "renderWhitespace none");
      } finally {
        editor.updateOptions({
          fontFamily: original.fontFamily,
          fontSize: original.fontSize,
          lineNumbers: original.lineNumbers === monaco.editor.RenderLineNumbersType.Off ? "off" : "on",
          wordWrap: original.wordWrap,
          renderWhitespace: original.renderWhitespace,
          tabSize: original.tabSize,
          insertSpaces: original.insertSpaces,
        });
      }
    });

    /* ----------------------------- recent files ----------------------------- */

    await record("recent: missing/corrupt data lists nothing", () => {
      resetRecent();
      equal(recentModule.listRecentFiles(), [], "missing");
      localStorage.setItem(recentKey, "{ broken");
      equal(recentModule.listRecentFiles(), [], "corrupt JSON");
      localStorage.setItem(recentKey, JSON.stringify({ path: "C:\\a.txt" }));
      equal(recentModule.listRecentFiles(), [], "non-array");
    });

    await record("recent: bad entries are filtered and deduplicated", () => {
      localStorage.setItem(recentKey, JSON.stringify([
        "C:\\Work\\One.txt",
        42,
        null,
        "",
        "   ",
        { path: "nope" },
        "c:/work/one.TXT",
        "C:\\Work\\Two.txt",
      ]));
      equal(recentModule.listRecentFiles(), ["C:\\Work\\One.txt", "C:\\Work\\Two.txt"], "sanitized list");
    });

    await record("recent: newest first, duplicate promotes and updates spelling", () => {
      resetRecent();
      recentModule.addRecentFile("C:\\Work\\one.txt");
      recentModule.addRecentFile("C:\\Work\\two.txt");
      recentModule.addRecentFile("C:\\Work\\three.txt");
      equal(recentModule.listRecentFiles(), [
        "C:\\Work\\three.txt",
        "C:\\Work\\two.txt",
        "C:\\Work\\one.txt",
      ], "MRU order");
      const promoted = recentModule.addRecentFile("c:/work/ONE.TXT");
      equal(promoted, [
        "c:/work/ONE.TXT",
        "C:\\Work\\three.txt",
        "C:\\Work\\two.txt",
      ], "case/separator dedupe");
      equal(recentModule.listRecentFiles(), promoted, "persisted promotion");
    });

    await record("recent: at most 15 entries, oldest dropped", () => {
      resetRecent();
      for (let i = 0; i < 20; i++) recentModule.addRecentFile(`C:\\tmp\\file${i}.txt`);
      const list = recentModule.listRecentFiles();
      equal(list.length, recentModule.RECENT_FILES_LIMIT, "limit");
      equal(list[0], "C:\\tmp\\file19.txt", "newest first");
      equal(list[14], "C:\\tmp\\file5.txt", "oldest retained");
      recentModule.addRecentFile("c:/TMP/FILE10.txt");
      const after = recentModule.listRecentFiles();
      equal(after.length, 15, "duplicate promote keeps the cap");
      equal(after[0], "c:/TMP/FILE10.txt", "promoted spelling");
      equal(new Set(after.map(recentModule.normalizeRecentPath)).size, 15, "no duplicate keys");
    });

    await record("recent: remove is case/separator-insensitive and clear empties", () => {
      resetRecent();
      recentModule.addRecentFile("C:\\Work\\one.txt");
      recentModule.addRecentFile("C:\\Work\\two.txt");
      const removed = recentModule.removeRecentFile("c:/work/ONE.TXT");
      equal(removed, ["C:\\Work\\two.txt"], "case-insensitive removal");
      recentModule.removeRecentFile("C:\\Work\\two.txt");
      equal(recentModule.listRecentFiles(), [], "empty after removals");
      recentModule.addRecentFile("C:\\Work\\three.txt");
      recentModule.clearRecentFiles();
      equal(recentModule.listRecentFiles(), [], "after clear");
      check(localStorage.getItem(recentKey) === null, "clear removes the key");
    });

    await record("recent: normalization handles drives, separators and UNC", () => {
      equal(
        recentModule.normalizeRecentPath("C:\\Work\\\\Deep\\File.TXT"),
        "c:\\work\\deep\\file.txt",
        "collapsed separators and lower case",
      );
      equal(recentModule.normalizeRecentPath("C:\\"), "c:\\", "drive root kept");
      equal(recentModule.normalizeRecentPath("c:/work/"), "c:\\work", "trailing separator trimmed");
      equal(
        recentModule.normalizeRecentPath("\\\\Server\\Share\\File.txt"),
        "\\\\server\\share\\file.txt",
        "UNC prefix preserved",
      );
    });

    return { results };
  });

  for (const result of report.results) {
    console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}${result.error ? `\n${result.error}` : ""}`);
  }
  const failed = report.results.filter((result) => !result.pass);
  console.log(JSON.stringify({
    url,
    passed: report.results.length - failed.length,
    failed: failed.length,
    runtimeErrors,
  }, null, 2));

  /* ----------------------- main menu persistence wiring -------------------- */

  const menuFailures = [];
  const menuTest = async (name, run) => {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      menuFailures.push(name);
      console.error(`FAIL ${name}: ${error.stack || error}`);
      await page.keyboard.press("Escape").catch(() => {});
    }
  };

  const readOption = (name) => page.evaluate((optionName) => {
    const { monaco, getEditor } = window.__settingsRegression.monacoSetup;
    const value = getEditor().getOption(monaco.editor.EditorOption[optionName]);
    if (optionName === "lineNumbers") {
      return value.renderType !== monaco.editor.RenderLineNumbersType.Off;
    }
    if (optionName === "wordWrap") return value !== "off";
    if (optionName === "renderWhitespace") return value === "all";
    return value;
  }, name);
  const stored = () => page.evaluate(() =>
    JSON.parse(localStorage.getItem("coteditor.settings.v1") ?? "{}"));
  const openMenu = (name) =>
    page.locator("#menubar > .ce-menu-item").filter({ hasText: name }).click();

  await menuTest("View menu: line numbers toggle persists and applies", async () => {
    const before = await readOption("lineNumbers");
    await openMenu(/^(视图|View)$/);
    await page.getByRole("menuitemcheckbox", { name: /切换行号显示|Toggle Line Numbers/ }).click();
    await page.waitForFunction((expected) => {
      const { monaco, getEditor } = window.__settingsRegression.monacoSetup;
      const value = getEditor().getOption(monaco.editor.EditorOption.lineNumbers);
      return (value.renderType !== monaco.editor.RenderLineNumbersType.Off) === expected;
    }, !before);
    assert.equal((await stored()).lineNumbers, !before);

    await openMenu(/^(视图|View)$/);
    await page.getByRole("menuitemcheckbox", { name: /切换行号显示|Toggle Line Numbers/ }).click();
    await page.waitForFunction((expected) => {
      const { monaco, getEditor } = window.__settingsRegression.monacoSetup;
      const value = getEditor().getOption(monaco.editor.EditorOption.lineNumbers);
      return (value.renderType !== monaco.editor.RenderLineNumbersType.Off) === expected;
    }, before);
    assert.equal((await stored()).lineNumbers, before);
  });

  await menuTest("View menu: word wrap toggle persists", async () => {
    const before = await readOption("wordWrap");
    await openMenu(/^(视图|View)$/);
    await page.getByRole("menuitemcheckbox", { name: /切换自动换行|Toggle Word Wrap/ }).click();
    await page.waitForFunction((expected) => {
      const { getEditor } = window.__settingsRegression.monacoSetup;
      return (getEditor().getOption(window.__settingsRegression.monacoSetup.monaco.editor.EditorOption.wordWrap) !== "off") === expected;
    }, !before);
    assert.equal((await stored()).wordWrap, before ? "off" : "on");
    await openMenu(/^(视图|View)$/);
    await page.getByRole("menuitemcheckbox", { name: /切换自动换行|Toggle Word Wrap/ }).click();
    await page.waitForFunction((expected) => {
      const { getEditor } = window.__settingsRegression.monacoSetup;
      return (getEditor().getOption(window.__settingsRegression.monacoSetup.monaco.editor.EditorOption.wordWrap) !== "off") === expected;
    }, before);
  });

  await menuTest("View menu: zoom in/out persists fontSize and applies it", async () => {
    const before = (await stored()).fontSize;
    assert.equal(typeof before, "number");
    await openMenu(/^(视图|View)$/);
    await page.locator(".ce-menu-dropdown button").filter({ hasText: /放大|Zoom In/ }).click();
    await page.waitForFunction((expected) => {
      const { monaco, getEditor } = window.__settingsRegression.monacoSetup;
      return getEditor().getOption(monaco.editor.EditorOption.fontSize) === expected;
    }, before + 1);
    assert.equal((await stored()).fontSize, before + 1);

    await openMenu(/^(视图|View)$/);
    await page.locator(".ce-menu-dropdown button").filter({ hasText: /缩小|Zoom Out/ }).click();
    await page.waitForFunction((expected) => {
      const { monaco, getEditor } = window.__settingsRegression.monacoSetup;
      return getEditor().getOption(monaco.editor.EditorOption.fontSize) === expected;
    }, before);
    assert.equal((await stored()).fontSize, before);
  });

  await menuTest("File menu: auto-save checkbox persists", async () => {
    const before = Boolean((await stored()).autoSave);
    await openMenu(/^(文件|File)$/);
    await page.getByRole("menuitemcheckbox", { name: /自动保存|Auto Save/ }).click();
    await page.waitForFunction((expected) =>
      Boolean(JSON.parse(localStorage.getItem("coteditor.settings.v1") ?? "{}").autoSave) === expected,
    !before);
    await openMenu(/^(文件|File)$/);
    await page.getByRole("menuitemcheckbox", { name: /自动保存|Auto Save/ }).click();
    await page.waitForFunction((expected) =>
      Boolean(JSON.parse(localStorage.getItem("coteditor.settings.v1") ?? "{}").autoSave) === expected,
    before);
  });

  console.log("Scope: Chromium + Vite modules + public Monaco APIs; native WebView2 is not covered.");
  process.exitCode = failed.length || runtimeErrors.length || menuFailures.length ? 1 : 0;
} catch (error) {
  console.error(error);
  if (runtimeErrors.length) console.error("Runtime errors:", runtimeErrors);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
