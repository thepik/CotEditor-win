/**
 * CotEditor-win frontend entry point.
 *
 * Wires together the three concerns of the app:
 *  1. The Monaco editor (mounted into #editor by `monaco-setup`).
 *  2. File IO, abstracted by `lib/file-bridge` so the same code runs in the
 *     Wails native window (Go methods) and in a plain browser dev server
 *     (File System Access API).
 *  3. UI panels (toolbar, statusbar, later: find panel, snippet manager).
 *
 * This file stays thin: it bootstraps the editor and delegates the heavy lifting
 * to the modules under src/editor, src/lib and src/ui.
 */

import "./styles.css";
import { setupMonaco, getEditor, getModel } from "./editor/monaco-setup";
import { loadAllThemes, applyTheme, getCurrentTheme, listThemes } from "./editor/theme-loader";
import { detectSyntaxByPath, initSyntaxMap, listSyntaxes } from "./lib/syntax-map";
import { attachLanguage, setModelLanguageByPath } from "./editor/language-config";
import { registerHighlightProviders, attachModelChangeTracking } from "./editor/highlight-tree-sitter";
import { registerRegexHighlight, refreshRegexTokens } from "./editor/highlight-regex";
import { registerAllGrammars } from "./editor/grammar-registry";
import { wireToolbar } from "./ui/toolbar";
import { updateStatusbar } from "./ui/statusbar";
import { registerLineCommands } from "./editor/line-commands";
import { openSnippetManager, registerSnippetShortcuts } from "./ui/snippet-manager";
import { registerFindShortcuts, openFind, openReplace } from "./ui/find-panel";
import { openMultipleReplacePanel } from "./ui/multiple-replace-ui";
import { renderMenuBar, closeMenu, type MenuBar, type MenuItem } from "./ui/menubar";
import { t, onLangChange, getLang, setLang, langName, type Lang } from "./lib/i18n";
import {
  openFile,
  saveFile,
  saveAsFile,
  resetFileHandle,
  isWails,
} from "./lib/file-bridge";

/** Tracks the on-disk path/name of the current buffer, or null if untitled. */
let currentPath: string | null = null;
/** True when the buffer has unsaved changes; drives the title `·` marker. */
let dirty = false;

async function bootstrap(): Promise<void> {
  // 1. Editor core.
  await setupMonaco();
  const editor = getEditor();
  const model = getModel();
  if (!editor || !model) throw new Error("Monaco failed to initialise");

  // 2. Themes + syntax engines.
  await initSyntaxMap();
  await loadAllThemes();
  applyTheme("Classic");

  // Register Monaco language configs derived from .cotsyntax/Edit.json, and
  // the two highlight engines (tree-sitter + regex). These are no-ops until a
  // language is attached to a model.
  await attachLanguage();
  registerAllGrammars();
  registerHighlightProviders();
  await registerRegexHighlight();
  attachModelChangeTracking();
  registerLineCommands();

  // Expose a small debug handle so the headless smoke test can read the live
  // app state without re-importing modules (Vite HMR can hand a dynamic
  // import a fresh, uninitialised module instance separate from the one the
  // app bootstrap populated).
  const debug = {
    themeCount: 0,
    currentTheme: getCurrentTheme(),
    syntaxCount: 0,
  };
  // @ts-expect-error debug-only global
  window.__coteditor = debug;
  // Defer the count reads until after the modules above are populated.
  queueMicrotask(() => {
    debug.themeCount = listThemes().length;
    debug.syntaxCount = listSyntaxes().length;
  });

  // 3. UI.
  renderMenuBar(buildMenuBar());
  wireToolbar({ onNew, onOpen, onSave, onSaveAs });
  updateStatusbar({ path: currentPath, dirty, line: 1, column: 1 });

  // Re-render the menu bar and document title when the UI language changes, so
  // a mid-session switch (View > Language) updates chrome live. The toolbar
  // and statusbar subscribe internally; the menu bar is rebuilt here because
  // it owns the largest surface of translatable strings.
  onLangChange(() => {
    closeMenu();
    renderMenuBar(buildMenuBar());
    updateTitle();
    // Repaint the statusbar with the new language (its last state is captured
    // by the cursor/content listeners; re-derive from the editor).
    const ed = getEditor();
    const pos = ed?.getPosition();
    updateStatusbar({
      path: currentPath,
      dirty,
      line: pos?.lineNumber ?? 1,
      column: pos?.column ?? 1,
    });
  });

  // Reflect buffer changes in the statusbar and dirty flag.
  model.onDidChangeContent(() => {
    if (!dirty) {
      dirty = true;
      updateTitle();
    }
    const pos = editor.getPosition();
    updateStatusbar({
      path: currentPath,
      dirty,
      line: pos?.lineNumber ?? 1,
      column: pos?.column ?? 1,
    });
  });
  editor.onDidChangeCursorPosition((e) => {
    updateStatusbar({
      path: currentPath,
      dirty,
      line: e.position.lineNumber,
      column: e.position.column,
    });
  });

  // 4. File operations + shortcuts.
  registerShortcuts();
  registerFindShortcuts();
  registerSnippetShortcuts();
  updateTitle();
}

/* ----------------------------- file operations ---------------------------- */

async function onNew(): Promise<void> {
  resetFileHandle();
  getModel()?.setValue("");
  currentPath = null;
  dirty = false;
  setModelLanguageByPath(null);
  updateTitle();
  updateStatusbar({ path: currentPath, dirty, line: 1, column: 1 });
}

async function onOpen(): Promise<void> {
  try {
    const result = await openFile();
    getModel()?.setValue(result.content);
    currentPath = result.path;
    dirty = false;
    if (result.path) {
      const syntax = detectSyntaxByPath(result.path);
      setModelLanguageByPath(result.path, syntax ?? undefined);
    }
    updateTitle();
    updateStatusbar({
      path: currentPath,
      dirty,
      line: 1,
      column: 1,
    });
  } catch (err) {
    // "cancelled" is the Tauri signal when the user dismisses the dialog; in
    // browser mode an AbortError is thrown instead. Both are expected.
    if (!isCancel(err)) console.error("open failed:", err);
  }
}

async function onSave(): Promise<void> {
  const model = getModel();
  if (!model) return;
  try {
    const savedTo = await saveFile(currentPath, model.getValue());
    currentPath = savedTo;
    dirty = false;
    if (savedTo) {
      const syntax = detectSyntaxByPath(savedTo);
      setModelLanguageByPath(savedTo, syntax ?? undefined);
    }
    updateTitle();
  } catch (err) {
    if (!isCancel(err)) console.error("save failed:", err);
  }
}

async function onSaveAs(): Promise<void> {
  const model = getModel();
  if (!model) return;
  try {
    const savedTo = await saveAsFile(model.getValue());
    currentPath = savedTo;
    dirty = false;
    if (savedTo) {
      const syntax = detectSyntaxByPath(savedTo);
      setModelLanguageByPath(savedTo, syntax ?? undefined);
    }
    updateTitle();
  } catch (err) {
    if (!isCancel(err)) console.error("save as failed:", err);
  }
}

/** Heuristic: was the error just the user cancelling a picker? */
function isCancel(err: unknown): boolean {
  if (err === "cancelled") return true;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  return false;
}

/* -------------------------------- shortcuts ------------------------------- */

function registerShortcuts(): void {
  // Window-level keydown for the Ctrl-based file shortcuts. Monaco handles
  // its own editor shortcuts (find, multi-cursor, etc.) separately.
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    switch (e.key.toLowerCase()) {
      case "o":
        e.preventDefault();
        void onOpen();
        break;
      case "s":
        e.preventDefault();
        if (e.shiftKey) void onSaveAs();
        else void onSave();
        break;
      case "n":
        e.preventDefault();
        void onNew();
        break;
      case "p":
        if (e.altKey) {
          e.preventDefault();
          openSnippetManager();
        }
        break;
    }
  });
}

function updateTitle(): void {
  const name = currentPath ? baseName(currentPath) : t("status.untitled");
  const marker = dirty ? " ·" : "";
  document.title = `${name}${marker} - ${t("title.app")}`;
}

function baseName(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/* --------------------------------- menus ---------------------------------- */

/**
 * Build the top-level menu bar.
 *
 * Groups every command surface into File / Edit / View / Format / Find /
 * Snippet / Theme / Language / Help. Format and Find items dispatch to the
 * Monaco actions registered by `line-commands.ts`; Theme items rebuild on each
 * open so the checkmark tracks the active selection. All labels are i18n-driven
 * via `t()`, so the whole bar is rebuilt on a language switch (see `bootstrap`).
 */
function buildMenuBar(): MenuBar {
  return [
    {
      label: t("menu.file"),
      items: [
        { id: "new", label: t("file.new"), shortcut: "Ctrl+N", run: () => void onNew() },
        { id: "open", label: t("file.open"), shortcut: "Ctrl+O", run: () => void onOpen() },
        { id: "save", label: t("file.save"), shortcut: "Ctrl+S", run: () => void onSave() },
        { id: "saveAs", label: t("file.saveAs"), shortcut: "Ctrl+Shift+S", run: () => void onSaveAs() },
      ],
    },
    {
      label: t("menu.edit"),
      items: [
        { label: t("edit.undo"), monacoAction: "undo", shortcut: "Ctrl+Z" },
        { label: t("edit.redo"), monacoAction: "redo", shortcut: "Ctrl+Y" },
        { sep: true },
        { label: t("edit.cut"), monacoAction: "editor.action.clipboardCutAction", shortcut: "Ctrl+X" },
        { label: t("edit.copy"), monacoAction: "editor.action.clipboardCopyAction", shortcut: "Ctrl+C" },
        { label: t("edit.paste"), monacoAction: "editor.action.clipboardPasteAction", shortcut: "Ctrl+V" },
        { sep: true },
        { label: t("edit.selectAll"), monacoAction: "editor.action.selectAll", shortcut: "Ctrl+A" },
        { label: t("edit.find"), run: openFind, shortcut: "Ctrl+F" },
        { label: t("edit.replace"), run: openReplace, shortcut: "Ctrl+H" },
        { label: t("edit.multipleReplace"), run: openMultipleReplacePanel, shortcut: "Ctrl+Shift+H" },
      ],
    },
    {
      label: t("menu.view"),
      items: [
        {
          label: t("view.lineNumbers"),
          monacoAction: "editor.action.toggleLineNumbers",
        },
        {
          label: t("view.renderWhitespace"),
          run: () => {
            const ed = getEditor();
            if (!ed) return;
            // Read the current renderWhitespace setting and flip between
            // "selection" (the default) and "all".
            const raw = (ed.getOption as unknown as (id: number) => unknown)(85);
            ed.updateOptions({
              renderWhitespace: raw === "all" ? "selection" : "all",
            });
          },
        },
        {
          label: t("view.wordWrap"),
          monacoAction: "editor.action.toggleWordWrap",
        },
        { sep: true },
        { label: t("view.zoomIn"), monacoAction: "editor.action.fontZoomIn", shortcut: "Ctrl++" },
        { label: t("view.zoomOut"), monacoAction: "editor.action.fontZoomOut", shortcut: "Ctrl+-" },
      ],
    },
    {
      label: t("menu.format"),
      items: [
        { label: t("format.sortLines"), monacoAction: "coteditor.sortLinesAscending", shortcut: "Ctrl+F5" },
        { label: t("format.sortLinesDesc"), monacoAction: "coteditor.sortLinesDescending" },
        { label: t("format.reverseLines"), monacoAction: "coteditor.reverseLines", shortcut: "Ctrl+Shift+F5" },
        { label: t("format.shuffleLines"), monacoAction: "coteditor.shuffleLines" },
        { label: t("format.deleteDuplicateLines"), monacoAction: "coteditor.deleteDuplicateLines" },
        { sep: true },
        { label: t("format.moveLineUp"), monacoAction: "coteditor.moveLineUp", shortcut: "Ctrl+Shift+Up" },
        { label: t("format.moveLineDown"), monacoAction: "coteditor.moveLineDown", shortcut: "Ctrl+Shift+Down" },
        { label: t("format.duplicateLine"), monacoAction: "coteditor.duplicateLine", shortcut: "Ctrl+Shift+D" },
        { label: t("format.deleteLine"), monacoAction: "coteditor.deleteLine", shortcut: "Ctrl+Shift+K" },
        { label: t("format.joinLines"), monacoAction: "coteditor.joinLines", shortcut: "Ctrl+J" },
        { sep: true },
        { label: t("format.indentLines"), monacoAction: "coteditor.indentLines", shortcut: "Ctrl+]" },
        { label: t("format.outdentLines"), monacoAction: "coteditor.outdentLines", shortcut: "Ctrl+[" },
        { label: t("format.removeEmptyLines"), monacoAction: "coteditor.removeEmptyLines" },
        { label: t("format.trimTrailingWhitespace"), monacoAction: "coteditor.trimTrailingWhitespace" },
      ],
    },
    {
      label: t("menu.snippet"),
      items: [
        { label: t("snippet.manage"), run: openSnippetManager, shortcut: "Ctrl+Alt+P" },
        {
          label: t("snippet.insert") + " 1",
          run: () => insertSnippetByIndex(0),
          shortcut: "Ctrl+Alt+1",
        },
        {
          label: t("snippet.insert") + " 2",
          run: () => insertSnippetByIndex(1),
          shortcut: "Ctrl+Alt+2",
        },
        {
          label: t("snippet.insert") + " 3",
          run: () => insertSnippetByIndex(2),
          shortcut: "Ctrl+Alt+3",
        },
      ],
    },
    {
      label: t("menu.theme"),
      // Built fresh on each open so the active theme's checkmark tracks the
      // current selection even after a switch.
      items: [],
      buildItems: () =>
        listThemes().map((name) => ({
          id: `theme-${name}`,
          label: name,
          checked: name === getCurrentTheme(),
          run: () => {
            applyTheme(name);
          },
        })),
    },
    {
      label: t("menu.language"),
      // The two supported UI languages; checkmark tracks the active one. Built
      // fresh on each open so the mark stays correct after a switch.
      items: [],
      buildItems: (): MenuItem[] =>
        (["zh", "en"] as Lang[]).map((lang) => ({
          id: `lang-${lang}`,
          label: langName(lang),
          checked: lang === getLang(),
          run: () => setLang(lang),
        })),
    },
    {
      label: t("menu.help"),
      items: [
        {
          label: t("help.about"),
          run: () => alert(t("about.body")),
        },
        {
          label: t("help.shortcuts"),
          run: showShortcuts,
        },
      ],
    },
  ];
}

/** Insert a snippet from the stored list by 0-based index (menu helper). */
function insertSnippetByIndex(i: number): void {
  import("./ui/snippet-manager").then(({ getSnippets, insertSnippetById }) => {
    const list = getSnippets();
    if (i < list.length) insertSnippetById(list[i].id);
  });
}

/** Show a static shortcuts reference dialog. */
function showShortcuts(): void {
  alert(
    [
      t("sc.title"),
      "",
      t("sc.file"),
      t("sc.edit"),
      t("sc.multi"),
      "",
      t("sc.format"),
      t("sc.sortLines"),
      t("sc.reverseLines"),
      t("sc.moveUp"),
      t("sc.moveDown"),
      t("sc.dupLine"),
      t("sc.delLine"),
      t("sc.joinLines"),
      t("sc.indent"),
      "",
      t("sc.snippets"),
      t("sc.multicursor"),
    ].join("\n"),
  );
}

// refreshRegexTokens is re-exported by highlight-regex for engines that need
// to re-tint on theme switch; keep the import referenced so the scaffold stays
// type-clean.
void isWails;
void refreshRegexTokens;

bootstrap().catch((err) => {
  console.error("Failed to bootstrap CotEditor-win:", err);
});
