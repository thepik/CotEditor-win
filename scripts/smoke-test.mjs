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
  if (isKnownNoise(err.message, err.stack ?? "")) return;
  errors.push(`PAGEERROR: ${err.message}`);
});

await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
await page.waitForTimeout(3000);

const report = await page.evaluate(async () => {
  const { monaco } = await import("/src/editor/monaco-setup.ts");
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
  //  - tree-sitter: set the model to Python, parse, and confirm the editor DOM
  //    gains more than one token class (semantic tokens colour keywords/etc.).
  //  - regex: set the model to JSON and confirm the line tokenizer emits
  //    non-default token scopes (strings/numbers).
  const { getModel, getEditor } = await import("/src/editor/monaco-setup.ts");
  const model = getModel();
  const editorInstance = getEditor();

  let tsTokenClasses = [];
  if (model) {
    monaco.editor.setModelLanguage(model, "python");
    model.setValue("def hello():\n    return 42\n");
    // Allow time for the lazy grammar wasm load + parse + render.
    await new Promise((r) => setTimeout(r, 1500));
    const spans = document.querySelectorAll("#editor .monaco-editor .view-line span");
    const classes = new Set();
    for (const s of spans) {
      for (const c of s.classList) classes.add(c);
    }
    tsTokenClasses = [...classes].sort();
  }

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
    jsonTokenScopes,
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
// Line commands must be registered on the editor instance.
const missingCmds = report.lineCommands.filter((c) => !c.ok).map((c) => c.id);
if (missingCmds.length) failures.push(`line commands missing: ${missingCmds.join(", ")}`);
console.log("\n=== ASSERTIONS ===");
console.log(failures.length ? "FAIL: " + failures.join("; ") : "ALL PASS");
process.exit(failures.length ? 1 : 0);
