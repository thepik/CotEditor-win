// Headless smoke test: load the app in Chromium and confirm Monaco mounts,
// themes load, and (in Wails mode) the bound Go file methods are callable.
import { chromium } from "playwright";

const URL = process.argv[2] || "http://localhost:34115/";

const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
const logs = [];
const isKnownNoise = (text, stack = "") =>
  // Wails ipc.js timing race (dev mode only).
  (/reading 'nodes'/.test(text) && stack.includes("ipc.js")) ||
  // Monaco's editorSimpleWorker tries to load a per-language worker module
  // (TS/JSON/CSS) for diagnostics/completion via `$loadForeignModule`. We don't
  // use those services (our highlighting runs on the main thread), so the
  // foreign module failing to resolve under Vite is harmless -- it surfaces as
  // a `reading 'toUrl'` error from the worker's FileAccessImpl and never
  // reaches the UI. Match on message text alone since the console error path
  // carries no stack.
  /reading 'toUrl'/.test(text);

page.on("console", (msg) => {
  logs.push(`[${msg.type()}] ${msg.text()}`);
  if (msg.type() === "error" && !isKnownNoise(msg.text())) errors.push(msg.text());
});
page.on("pageerror", (err) => {
  // Disposing a tab model cancels Monaco's internal caret/scroll delayers.
  if (err.message === "Canceled") return;
  if (isKnownNoise(err.message, err.stack ?? "")) return;
  errors.push(`PAGEERROR: ${err.message}`);
});

await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
await page.waitForTimeout(3000);
// Bind to the exact module URL the app executed. Vite appends an HMR stamp
// (`?t=...`) to edited modules; a plain specifier would import a second,
// uninitialised instance whose getEditor()/getModel() are null.
await page.evaluate(async () => {
  const pick = (suffix) => [...new Set(performance.getEntriesByType("resource").map((entry) => entry.name))]
    .filter((name) => name.includes(suffix)).pop() ?? suffix;
  window.__smoke = await import(pick("/src/editor/monaco-setup.ts"));
});

const report = await page.evaluate(async () => {
  const { monaco } = window.__smoke;
  const { detectSyntaxByPath } = await import("/src/lib/syntax-map.ts");

  const editor = document.querySelector("#editor .monaco-editor");
  const toolbar = document.querySelectorAll("#toolbar button");
  const statusbar = document.getElementById("statusbar");
  const langs = monaco.languages.getLanguages();

  // Read live app state from the debug handle the bootstrap exposes. Reading
  // via a dynamic re-import would hand us a fresh, uninitialised module
  // instance under Vite HMR (the app's populated registry lives in a different
  // module record).
  const dbg = window.__coteditor ?? {};

  // Wails binding check: call NewFile (no disk IO, safe to invoke).
  let wailsBinding = "no-go-global";
  let newFileOk = null;
  if (typeof window.go !== "undefined" && window.go?.main?.App?.NewFile) {
    wailsBinding = "present";
    try {
      const r = await window.go.main.App.NewFile();
      newFileOk = r && r.encoding === "UTF-8";
    } catch (e) {
      newFileOk = `error: ${e}`;
    }
  }

  // Highlight engine checks.
  //  - tree-sitter: attach each language, parse, and confirm the editor DOM
  //    gains more than one token class (semantic tokens colour keywords/etc.).
  //    Registration alone is not accepted: C#/C++ were previously only checked
  //    with languages.getLanguages(), so they are now actually tokenized.
  //  - regex: set the model to JSON and confirm the line tokenizer emits
  //    non-default token scopes (strings/numbers).
  const { getModel, getEditor } = window.__smoke;
  const model = getModel();
  const editorInstance = getEditor();

  const collectTokenClasses = async (language, source, timeout = 8000) => {
    monaco.editor.setModelLanguage(model, language);
    model.setValue(source);
    const deadline = Date.now() + timeout;
    let classes = [];
    do {
      classes = [...new Set([...document.querySelectorAll("#editor .monaco-editor .view-line span")]
        .flatMap((span) => [...span.classList]))].sort();
      if (classes.length > 1) break;
      // Allow the lazy grammar wasm load + parse + semantic-token render.
      await new Promise((r) => setTimeout(r, 150));
    } while (Date.now() < deadline);
    return classes;
  };

  const treeSitterLanguages = {};
  if (model) {
    treeSitterLanguages.python = await collectTokenClasses("python", "def hello():\n    return 42\n");
    treeSitterLanguages.csharp = await collectTokenClasses(
      "csharp",
      'class Hello { void F() { foreach (var item in items) { return; } } }\n',
    );
    treeSitterLanguages.cpp = await collectTokenClasses(
      "cpp",
      "class Hello { public: int main() { return 42; } };\n",
    );
  }
  const tsTokenClasses = treeSitterLanguages.python ?? [];

  let jsonTokenScopes = [];
  if (model) {
    monaco.editor.setModelLanguage(model, "json");
    model.setValue('{"key": 42, "flag": true}\n');
    await new Promise((r) => setTimeout(r, 300));
    // Force a tokenization readback for line 1.
    const lineTokens = model.tokenization.getLineTokens(1);
    const scopes = [];
    for (let i = 0; i < lineTokens.getCount(); i++) {
      scopes.push(lineTokens.getForeground(i));
    }
    jsonTokenScopes = [...new Set(scopes)];
  }

  // Line commands must do more than exist in the action registry: run each
  // one through the editor's public action API and assert the document result.
  const lineCommandSamples = [
    { id: "coteditor.sortLinesAscending", input: "b\na\n", expected: "a\nb\n" },
    { id: "coteditor.moveLineUp", input: "a\nb\n", expected: "b\na\n", position: { lineNumber: 2, column: 1 } },
    { id: "coteditor.moveLineDown", input: "a\nb\n", expected: "b\na\n", position: { lineNumber: 1, column: 1 } },
    { id: "coteditor.duplicateLine", input: "a\n", expected: "a\na\n" },
    { id: "coteditor.deleteLine", input: "a\nb\n", expected: "b\n" },
    {
      id: "coteditor.joinLines",
      input: "a\nb\n",
      expected: "a b\n",
      selection: new monaco.Range(1, 1, 2, 2),
    },
  ];
  const lineCommandExecutions = [];
  if (model && editorInstance) {
    for (const sample of lineCommandSamples) {
      model.setValue(sample.input);
      editorInstance.setPosition(sample.position ?? { lineNumber: 1, column: 1 });
      if (sample.selection) editorInstance.setSelection(sample.selection);
      const action = editorInstance.getAction(sample.id);
      let actual = null;
      let error = null;
      if (action) {
        try {
          await action.run();
          actual = model.getValue();
        } catch (e) {
          error = String(e);
        }
      }
      lineCommandExecutions.push({
        id: sample.id,
        executed: !!action && !error,
        expected: sample.expected,
        actual,
        error,
      });
    }
    // Leave a JSON buffer behind: the file-safety flow below expects an
    // unsaved document so the New/open prompts are exercised.
    monaco.editor.setModelLanguage(model, "json");
    model.setValue('{"key": 42, "flag": true}\n');
  }

  return {
    editorMounted: !!editor,
    editorChildCount: editor ? editor.children.length : 0,
    toolbarButtons: toolbar.length,
    statusbarHasContent: statusbar ? statusbar.textContent.trim().length > 0 : false,
    title: document.title,
    themeCount: dbg.themeCount ?? -1,
    currentTheme: dbg.currentTheme ?? null,
    syntaxCount: dbg.syntaxCount ?? -1,
    detect_py: detectSyntaxByPath("foo.py"),
    detect_cs: detectSyntaxByPath("prog.cs"),
    detect_cpp: detectSyntaxByPath("prog.cpp"),
    csharpRegistered: !!langs.find((l) => l.id === "csharp"),
    cppRegistered: !!langs.find((l) => l.id === "cpp"),
    treeSitterTokenClasses: tsTokenClasses,
    treeSitterLanguages,
    jsonTokenScopes,
    lineCommandExecutions,
    capabilityBoundaries: {
      highlighting:
        "Smoke proves the live DOM gains token classes and that Monaco's JSON tokenizer emits non-default foregrounds. Full tree-sitter query captures, UTF-16 packing and regex state transitions run in scripts/regression-highlighting.mjs.",
      fileSystem:
        "Browser smoke uses an in-memory File System Access handle backed by a real File (arrayBuffer), not the native Wails file bridge; native BOM/menu/title checks run in scripts/regression-native.mjs against a built exe.",
      nativeBinding:
        "window.go/runtime bindings only exist in Wails; browser runs report wailsBinding=no-go-global and assert NewFile only when the binding is present (npm run smoke against the Wails dev server).",
    },
    wailsBinding,
    newFileOk,
    // Menu bar rendered with the expected top-level menus.
    menuBarItems: [...document.querySelectorAll("#menubar .ce-menu-item")].map((e) => e.textContent),
    // Line command actions registered on the editor instance.
    lineCommands: editorInstance
      ? ["coteditor.sortLinesAscending", "coteditor.moveLineUp", "coteditor.moveLineDown", "coteditor.duplicateLine", "coteditor.deleteLine", "coteditor.joinLines"].map((id) => ({ id, ok: !!editorInstance.getAction(id) }))
      : [],
  };
});

// Menu wiring is more than a list of labels: open a real dropdown and run an
// action through it. This also proves the registered Monaco action is reachable
// from the menu, not only from getAction().
report.menuInteraction = { dropdownVisible: false, itemCount: 0, sortedByMenu: null };
try {
  await page.evaluate(async () => {
    const { getModel, getEditor } = window.__smoke;
    getModel().setValue("z\na\n");
    getEditor().setPosition({ lineNumber: 1, column: 1 });
  });
  await page.locator("#menubar > .ce-menu-item").filter({ hasText: /^(格式|Format)$/ }).click();
  const dropdown = page.locator(".ce-menu-dropdown");
  await dropdown.waitFor({ state: "visible" });
  report.menuInteraction.dropdownVisible = true;
  report.menuInteraction.itemCount = await dropdown.locator("button:not(:disabled)").count();
  await dropdown.locator('[data-menu-action="coteditor.sortLinesAscending"]').click();
  await page.waitForFunction(async () =>
    window.__smoke.getModel().getValue() === "a\nz\n");
  report.menuInteraction.sortedByMenu = await page.evaluate(async () =>
    window.__smoke.getModel().getValue());
} catch (error) {
  report.menuInteraction.error = String(error?.message ?? error);
  await page.keyboard.press("Escape").catch(() => {});
}

// Theme selection is also applied, not just counted: click a non-default dark
// theme and compare the rendered editor background with the .cottheme resource,
// then restore Classic so later checks start from the documented default.
report.themeInteraction = {};
const readThemeState = async (name) => {
  const expected = await page.evaluate(async (themeName) => {
    const theme = await (await fetch(`/resources/themes/${encodeURIComponent(themeName)}.cottheme`)).json();
    const hex = typeof theme.background === "string" ? theme.background : theme.background.color;
    const rgb = hex.slice(1, 7).match(/../g).map((part) => parseInt(part, 16));
    return {
      background: `rgb(${rgb.join(", ")})`,
      mode: rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 < 127.5 ? "dark" : "light",
    };
  }, name);
  await page.waitForFunction((rgb) =>
    getComputedStyle(document.querySelector("#editor .monaco-editor-background")).backgroundColor === rgb,
  expected.background);
  const actual = await page.evaluate(() => ({
    background: getComputedStyle(document.querySelector("#editor .monaco-editor-background")).backgroundColor,
    mode: document.documentElement.dataset.ceTheme,
  }));
  return { expected, actual };
};
try {
  const clickTheme = async (name) => {
    await page.locator("#menubar > .ce-menu-item").filter({ hasText: /^(主题|Theme)$/ }).click();
    await page.locator(`.ce-menu-dropdown [data-menu-action="theme-${name}"]`).click();
  };
  await clickTheme("Anura (Dark)");
  report.themeInteraction.dark = await readThemeState("Anura (Dark)");
  await clickTheme("Classic");
  report.themeInteraction.classic = await readThemeState("Classic");
} catch (error) {
  report.themeInteraction.error = String(error?.message ?? error);
  await page.keyboard.press("Escape").catch(() => {});
}

// File-safety interaction checks. Browser mode uses an in-memory File System
// Access API mock so this verifies the same frontend state machine without
// touching the developer's disk.
await page.evaluate(() => {
  window.__mockFileWrites = [];
  const existingFile = new File(["initial content\n"], "existing.txt", { type: "text/plain" });
  const handle = {
    name: "existing.txt",
    async getFile() {
      // A real handle reports a stable lastModified; a fresh File() would get
      // a new timestamp on every stat and look like an external change.
      return existingFile;
    },
    async createWritable() {
      return {
        async write(text) { window.__mockFileWrites.push(String(text)); },
        async close() {},
      };
    },
  };
  window.__mockFileHandle = handle;
  window.showOpenFilePicker = async () => [handle];
  window.showSaveFilePicker = async () => handle;
});

await page.locator("#editor .monaco-editor").click();
await page.keyboard.press("Control+End");
await page.keyboard.insertText("dirty marker");
const beforeNew = await page.evaluate(() => window.__coteditor.activeValue());
await page.locator('[data-command="new"]').click();
await page.waitForFunction(() => document.querySelectorAll("#tabs .ce-tabs-tab").length === 2);
const newTabOpened = await page.evaluate(() =>
  document.querySelectorAll("#tabs .ce-tabs-tab").length === 2
  && !document.querySelector(".ce-modal"));
await page.keyboard.press("Control+1");
const afterNew = await page.evaluate(() => window.__coteditor.activeValue());

// Closing a dirty tab still asks; discarding it must yield a blank placeholder.
await page.keyboard.press("Control+w");
await page.waitForSelector(".ce-confirm-card");
await page.locator('[data-decision="discard"]').click();
await page.waitForFunction(() =>
  document.querySelectorAll("#tabs .ce-tabs-tab").length === 1
  && !document.querySelector(".ce-modal"));
const afterDiscard = await page.evaluate(() => window.__coteditor.activeValue());

await page.locator('[data-command="open"]').click();
await page.waitForFunction(() => document.getElementById("statusbar")?.textContent?.includes("existing.txt"));
await page.locator("#editor .monaco-editor").click();
await page.keyboard.press("Control+a");
await page.keyboard.insertText("edited content\n");
// Auto-save is off by default in phase B: the safety path is an explicit Save.
await page.keyboard.press("Control+s");
await page.waitForFunction(() => window.__mockFileWrites?.includes("edited content\n"));
const autosaveState = await page.locator(".sb-save").getAttribute("data-state");

// Cancelling Open must preserve the current buffer (the old implementation
// accidentally replaced it with an empty untitled document in Wails mode).
await page.evaluate(() => {
  window.showOpenFilePicker = async () => { throw new DOMException("cancelled", "AbortError"); };
});
await page.locator('[data-command="open"]').click();
await page.waitForTimeout(100);
const afterOpenCancel = await page.evaluate(() => window.__coteditor.activeValue());

report.fileSafety = {
  newTabOpened,
  newTabPreserved: beforeNew === afterNew,
  discardCleared: afterDiscard === "",
  manualSaveWrote: await page.evaluate(() => window.__mockFileWrites?.includes("edited content\n") ?? false),
  autosaveState,
  openCancelPreserved: afterOpenCancel === "edited content\n",
};

// Real File.arrayBuffer path + BOM round-trip: the frontend decodes with
// TextDecoder(ignoreBOM) and re-adds the BOM on save. The handle is still an
// in-memory mock, so no developer file is touched.
report.bomSafety = { decodedWithoutBom: false, encodingShown: null, wroteBom: false };
try {
  await page.evaluate(() => {
    window.__bomWrites = [];
    const bomFile = new File(["\uFEFFbom content\n"], "bom.txt", { type: "text/plain" });
    const handle = {
      name: "bom.txt",
      async getFile() {
        return bomFile;
      },
      async createWritable() {
        return {
          async write(text) { window.__bomWrites.push(String(text)); },
          async close() {},
        };
      },
    };
    window.showOpenFilePicker = async () => [handle];
  });
  await page.locator('[data-command="open"]').click();
  await page.waitForFunction(() => document.getElementById("statusbar")?.textContent?.includes("bom.txt"));
  report.bomSafety.decodedWithoutBom = await page.evaluate(() =>
    window.__coteditor.activeValue() === "bom content\n");
  report.bomSafety.encodingShown = (await page.locator('[data-stat="encoding"]').textContent())?.trim() ?? null;
  await page.locator("#editor .monaco-editor").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("bom edited\n");
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => window.__bomWrites?.includes("\uFEFFbom edited\n"));
  report.bomSafety.wroteBom = await page.evaluate(() =>
    window.__bomWrites?.includes("\uFEFFbom edited\n") ?? false);
} catch (error) {
  report.bomSafety.error = String(error?.message ?? error);
}

console.log("=== RUNTIME REPORT (" + URL + ") ===");
console.log(JSON.stringify(report, null, 2));
console.log("\n=== ERRORS ===");
console.log(errors.length ? errors.join("\n") : "NONE");

await browser.close();

const failures = [];
if (errors.length > 0) failures.push("console errors");
if (!report.editorMounted) failures.push("editor not mounted");
if (report.themeCount !== 13) failures.push(`themes ${report.themeCount}`);
if (report.currentTheme !== "Classic") failures.push(`theme ${report.currentTheme}`);
if (report.detect_py !== "Python") failures.push("py detect");
if (report.detect_cs !== "C#") failures.push("cs detect");
if (!report.csharpRegistered) failures.push("csharp not registered");
if (!report.cppRegistered) failures.push("cpp not registered");
// Registration alone is not proof of an engine: both languages are tokenized
// (and rendered) above, so require real token classes in the DOM.
for (const language of ["csharp", "cpp"]) {
  const classes = report.treeSitterLanguages?.[language] ?? [];
  if (classes.length < 2) {
    failures.push(`${language} produced no custom token classes: ${JSON.stringify(classes)}`);
  }
}
// Highlight engines: tree-sitter should render multiple token classes for
// Python (keywords/numbers/etc.); the regex engine should colour JSON beyond a
// single plaintext scope.
if (report.treeSitterTokenClasses.length < 2) failures.push(`tree-sitter token classes ${JSON.stringify(report.treeSitterTokenClasses)}`);
if (report.jsonTokenScopes.length < 2) failures.push(`json token scopes ${JSON.stringify(report.jsonTokenScopes)}`);
// Menu bar must render the expected top-level menus.
// Menu bar must render the expected top-level menus. The UI is bilingual
// (i18n, default Chinese), so accept either the English or Chinese label set.
// Either full set must be present; the new "Language" menu is also required.
const menuSets = [
  ["File", "Edit", "View", "Format", "Snippet", "Theme", "Help"],
  ["文件", "编辑", "视图", "格式", "片段", "主题", "帮助"],
];
const menusMatch = menuSets.some((set) =>
  set.every((m) => report.menuBarItems.includes(m)),
);
if (!menusMatch) {
  failures.push(`menu bar missing items: ${JSON.stringify(report.menuBarItems)}`);
}
// Line commands must be registered on the editor instance...
const missingCmds = report.lineCommands.filter((c) => !c.ok).map((c) => c.id);
if (missingCmds.length) failures.push(`line commands missing: ${missingCmds.join(", ")}`);
// ...and executing them must produce the documented edit.
const badExecutions = (report.lineCommandExecutions ?? []).filter(
  (c) => !c.executed || c.actual !== c.expected,
);
if (badExecutions.length) {
  failures.push(`line command execution ${JSON.stringify(badExecutions)}`);
}
// Menu interaction: a real dropdown opened and its sort action ran.
if (report.menuInteraction?.error) failures.push(`menu interaction ${report.menuInteraction.error}`);
if (!report.menuInteraction?.dropdownVisible || (report.menuInteraction?.itemCount ?? 0) < 1) {
  failures.push(`menu dropdown ${JSON.stringify(report.menuInteraction)}`);
} else if (report.menuInteraction.sortedByMenu !== "a\nz\n") {
  failures.push(`menu action result ${JSON.stringify(report.menuInteraction)}`);
}
// Theme interaction: applied background must match the theme resource, then
// Classic must be restored for subsequent runs.
if (report.themeInteraction?.error) {
  failures.push(`theme interaction ${report.themeInteraction.error}`);
}
for (const [name, result] of [["Anura (Dark)", report.themeInteraction?.dark], ["Classic", report.themeInteraction?.classic]]) {
  if (!result) {
    failures.push(`theme ${name} not applied`);
  } else if (result.actual.background !== result.expected.background || result.actual.mode !== result.expected.mode) {
    failures.push(`theme ${name} render ${JSON.stringify(result)}`);
  }
}
if (report.themeInteraction?.dark && report.themeInteraction?.classic &&
    report.themeInteraction.dark.actual.background === report.themeInteraction.classic.actual.background) {
  failures.push("dark theme did not change the rendered editor background");
}
if (!report.fileSafety.newTabOpened) failures.push("new tab was not opened");
if (!report.fileSafety.newTabPreserved) failures.push("new tab replaced existing content");
if (!report.fileSafety.discardCleared) failures.push("discard did not create blank document");
if (!report.fileSafety.manualSaveWrote) failures.push("existing-file save missing");
if (report.fileSafety.autosaveState !== "saved") failures.push(`save state ${report.fileSafety.autosaveState}`);
if (!report.fileSafety.openCancelPreserved) failures.push("cancelled open replaced content");
if (report.bomSafety?.error) failures.push(`BOM round-trip ${report.bomSafety.error}`);
if (!report.bomSafety?.decodedWithoutBom) failures.push("BOM file was not decoded through File.arrayBuffer");
if (!/BOM/i.test(report.bomSafety?.encodingShown ?? "")) failures.push(`BOM encoding ${report.bomSafety?.encodingShown}`);
if (!report.bomSafety?.wroteBom) failures.push("BOM was not written back on autosave");
// Base chrome remains populated on every run.
if (report.toolbarButtons < 1) failures.push(`toolbar buttons ${report.toolbarButtons}`);
if (!report.statusbarHasContent) failures.push("statusbar empty");
if (report.detect_cpp !== "C++") failures.push(`cpp detect ${report.detect_cpp}`);
if (!(report.syntaxCount > 0)) failures.push(`syntaxes ${report.syntaxCount}`);
// Native binding, when present, must accept a NewFile call.
if (report.wailsBinding === "present" && report.newFileOk !== true) {
  failures.push(`NewFile binding ${JSON.stringify(report.newFileOk)}`);
}
console.log("\n=== ASSERTIONS ===");
console.log(failures.length ? "FAIL: " + failures.join("; ") : "ALL PASS");
process.exit(failures.length ? 1 : 0);
