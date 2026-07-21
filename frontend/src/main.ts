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
import { setupMonaco, getEditor, getModel, monaco } from "./editor/monaco-setup";
import { loadAllThemes, applyTheme, getCurrentTheme, listThemes } from "./editor/theme-loader";
import { detectSyntaxByPath, initSyntaxMap, listSyntaxes } from "./lib/syntax-map";
import { attachLanguage, setModelLanguageByPath, setModelLanguageBySyntax } from "./editor/language-config";
import { registerHighlightProviders, attachModelChangeTracking } from "./editor/highlight-tree-sitter";
import { registerRegexHighlight, refreshRegexTokens } from "./editor/highlight-regex";
import { registerAllGrammars } from "./editor/grammar-registry";
import { wireToolbar, renderToolbar, type ViewMode } from "./ui/toolbar";
import { updateStatusbar, type SaveState } from "./ui/statusbar";
import { renderPreview, schedulePreviewRender, showPreview, hidePreview } from "./ui/preview";
import { registerLineCommands } from "./editor/line-commands";
import { openSnippetManager, registerSnippetShortcuts } from "./ui/snippet-manager";
import { registerFindShortcuts, openFind, openReplace } from "./ui/find-panel";
import { openMultipleReplacePanel } from "./ui/multiple-replace-ui";
import { renderMenuBar, closeMenu, type MenuBar, type MenuItem } from "./ui/menubar";
import { t, onLangChange, getLang, setLang, langName, type Lang } from "./lib/i18n";
import { confirmUnsavedChanges } from "./ui/confirm-dialog";
import { showToast } from "./ui/notifications";
import {
  openFile,
  saveFile,
  saveAsFile,
  resetFileHandle,
  setDocumentState,
  isWails,
  startupFile,
  openPath,
  type FileContent,
} from "./lib/file-bridge";
import * as WailsRuntime from "./wailsjs/runtime/runtime";

/** Tracks the on-disk path/name of the current buffer, or null if untitled. */
let currentPath: string | null = null;
/** True when the buffer has unsaved changes; drives the title `·` marker. */
let dirty = false;
/**
 * The active CotEditor syntax name, or null for plaintext. Set by file
 * detection on open/save and by manual selection in the toolbar switcher.
 * Drives the toolbar select echo and the statusbar syntax label.
 */
let currentSyntax: string | null = null;
/**
 * Snapshot of `currentSyntax` at the last time the toolbar was rendered. Used
 * by `refreshChrome` to avoid rebuilding the toolbar (and disrupting the
 * language <select>) unless the syntax has actually changed.
 */
let lastRenderedSyntax: string | null | undefined = undefined;
/**
 * Snapshot of `viewMode` at the last toolbar render, so `refreshChrome` only
 * rebuilds the toolbar when the mode (or syntax) actually changes.
 */
let lastRenderedMode: ViewMode | undefined = undefined;
/**
 * Active view mode: `"edit"` shows the Monaco editor, `"preview"` shows the
 * rendered markdown panel. Only meaningful when `currentSyntax === "Markdown"`;
 * switching to a non-markdown file resets this to `"edit"`.
 */
let viewMode: ViewMode = "edit";
let currentEncoding = "UTF-8";
let currentLineEnding: "LF" | "CRLF" | "CR" = "LF";
let saveState: SaveState = "idle";
let programmaticModelChange = false;
let autosaveTimer: number | null = null;
let saveInFlight: Promise<boolean> | null = null;

const AUTOSAVE_DELAY_MS = 250;

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
  wireToolbar({
    onNew,
    onOpen,
    onSave,
    onSaveAs,
    onSyntaxChange,
    currentSyntax: () => currentSyntax,
    onModeChange: setViewMode,
    currentMode: () => viewMode,
    isPreviewAvailable: () => currentSyntax === "Markdown",
  });
  refreshChrome();

  // Re-render the menu bar and document title when the UI language changes, so
  // a mid-session switch (View > Language) updates chrome live. The toolbar
  // and statusbar subscribe internally; the menu bar is rebuilt here because
  // it owns the largest surface of translatable strings.
  onLangChange(() => {
    closeMenu();
    renderMenuBar(buildMenuBar());
    refreshChrome();
    syncNativeDocumentState();
  });

  // Reflect buffer changes in the statusbar and dirty flag.
  model.onDidChangeContent(() => {
    if (programmaticModelChange) return;
    dirty = true;
    saveState = currentPath ? "saving" : "unsaved";
    refreshChrome();
    syncNativeDocumentState();
    if (currentPath) scheduleAutosave();
    // Live-update the preview pane while it is visible. Coalesced via rAF
    // inside schedulePreviewRender so a burst of keystrokes repaints once.
    if (viewMode === "preview" && currentSyntax === "Markdown") {
      schedulePreviewRender(model.getValue());
    }
  });
  editor.onDidChangeCursorPosition((e: { position: { lineNumber: number; column: number } }) => {
    refreshStatusbar(e.position.lineNumber, e.position.column);
  });

  // 4. File operations + shortcuts.
  registerShortcuts();
  registerFindShortcuts();
  registerSnippetShortcuts();
  // Browsers provide their own generic unload confirmation. The native Wails
  // window uses App.beforeClose instead, avoiding two stacked prompts.
  if (!isWails()) {
    window.addEventListener("beforeunload", (event) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }
  window.addEventListener("blur", () => {
    if (currentPath && dirty) void flushAutosave();
  });
  syncNativeDocumentState();
  refreshChrome();

  // 5. Initial document from a command-line file (e.g. double-clicking a
  // file in Explorer launches the app with the path as argv[1]). On a fresh
  // start with no args, startupFile() resolves null and we keep the empty
  // untitled buffer shown above.
  void loadStartupFile();

  // When the app is already running and a second instance is launched with a
  // file path, the Go SingleInstanceLock forwards the path here. We load it
  // into the existing window, honouring the same dirty-guard as a manual open.
  if (isWails()) {
    WailsRuntime.EventsOn("app:open-path", (path: unknown) => {
      if (typeof path !== "string" || path === "") return;
      void openExternalPath(path);
    });
  }
}

/** Loads the file passed on the command line at launch, if any. */
async function loadStartupFile(): Promise<void> {
  let path: string | null;
  try {
    path = await startupFile();
  } catch (err) {
    console.error("startupFile failed:", err);
    return;
  }
  if (!path) return;
  // On first launch the buffer is empty and clean, so we skip the dirty guard.
  await openExternalPath(path, { skipDirtyGuard: true });
}

/** Opens a file by absolute path (startup arg or second-instance forward). */
async function openExternalPath(
  path: string,
  opts: { skipDirtyGuard?: boolean } = {},
): Promise<void> {
  if (!opts.skipDirtyGuard && !(await prepareToReplaceDocument())) return;
  try {
    const result = await openPath(path);
    cancelAutosave();
    applyDocument(result);
  } catch (err) {
    console.error("open path failed:", err);
    showToast(t("error.openFailed") + errorMessage(err), "error");
  }
}

/* ----------------------------- file operations ---------------------------- */

async function onNew(): Promise<void> {
  if (!(await prepareToReplaceDocument())) return;
  cancelAutosave();
  resetFileHandle();
  applyDocument({
    path: null,
    content: "",
    encoding: "UTF-8",
    line_ending: "lf",
  });
}

async function onOpen(): Promise<void> {
  if (!(await prepareToReplaceDocument())) return;
  try {
    const result = await openFile();
    cancelAutosave();
    applyDocument(result);
  } catch (err) {
    // "cancelled" is the Tauri signal when the user dismisses the dialog; in
    // browser mode an AbortError is thrown instead. Both are expected.
    if (!isCancel(err)) {
      console.error("open failed:", err);
      showToast(t("error.openFailed") + errorMessage(err), "error");
    }
  }
}

async function onSave(): Promise<boolean> {
  const model = getModel();
  if (!model) return false;
  if (currentPath) return flushAutosave();

  try {
    const savedTo = await saveFile(currentPath, contentForDisk(model.getValue()));
    applySavedPath(savedTo);
    dirty = false;
    saveState = "saved";
    syncNativeDocumentState();
    refreshChrome();
    return true;
  } catch (err) {
    if (!isCancel(err)) {
      console.error("save failed:", err);
      saveState = "error";
      refreshChrome();
      showToast(t("error.saveFailed") + errorMessage(err), "error");
    }
    return false;
  }
}

async function onSaveAs(): Promise<boolean> {
  const model = getModel();
  if (!model) return false;
  cancelAutosave();
  if (saveInFlight) await saveInFlight;
  try {
    const savedTo = await saveAsFile(contentForDisk(model.getValue()));
    applySavedPath(savedTo);
    dirty = false;
    saveState = "saved";
    syncNativeDocumentState();
    refreshChrome();
    return true;
  } catch (err) {
    if (!isCancel(err)) {
      console.error("save as failed:", err);
      saveState = "error";
      refreshChrome();
      showToast(t("error.saveFailed") + errorMessage(err), "error");
    }
    return false;
  }
}

function applyDocument(result: FileContent): void {
  const model = getModel();
  const editor = getEditor();
  if (!model) return;

  programmaticModelChange = true;
  currentPath = result.path;
  currentEncoding = result.encoding || "UTF-8";
  currentLineEnding = result.line_ending.toUpperCase() as "LF" | "CRLF" | "CR";
  dirty = false;
  saveState = currentPath ? "saved" : "idle";
  currentSyntax = currentPath ? detectSyntaxByPath(currentPath) : null;
  model.setValue(result.content);
  model.setEOL(
    result.line_ending === "crlf"
      ? monaco.editor.EndOfLineSequence.CRLF
      : monaco.editor.EndOfLineSequence.LF,
  );
  setModelLanguageByPath(currentPath, currentSyntax ?? undefined);
  editor?.setPosition({ lineNumber: 1, column: 1 });
  editor?.revealLine(1);
  programmaticModelChange = false;

  // Preview mode is only valid for Markdown. When the new document is not
  // markdown, drop out of preview so we never show a stale render; when it
  // is markdown, refresh the preview pane if it happens to be open.
  if (currentSyntax !== "Markdown") {
    if (viewMode === "preview") {
      viewMode = "edit";
      hidePreview();
    }
  } else if (viewMode === "preview") {
    renderPreview(result.content);
  }

  syncNativeDocumentState();
  refreshChrome();
  editor?.focus();
}

function applySavedPath(savedTo: string): void {
  currentPath = savedTo;
  currentSyntax = detectSyntaxByPath(savedTo);
  setModelLanguageByPath(savedTo, currentSyntax ?? undefined);
}

async function prepareToReplaceDocument(): Promise<boolean> {
  if (!dirty) return true;

  // Existing files should normally never interrupt the user: finish the live
  // save immediately before switching documents. Only fall back to the dialog
  // when the write failed.
  if (currentPath && (await flushAutosave())) return true;

  const name = currentPath ? baseName(currentPath) : t("status.untitled");
  const decision = await confirmUnsavedChanges(name);
  if (decision === "cancel") return false;
  if (decision === "discard") return true;
  return onSave();
}

function scheduleAutosave(): void {
  cancelAutosave();
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = null;
    void persistCurrentFile();
  }, AUTOSAVE_DELAY_MS);
}

function cancelAutosave(): void {
  if (autosaveTimer === null) return;
  window.clearTimeout(autosaveTimer);
  autosaveTimer = null;
}

async function flushAutosave(): Promise<boolean> {
  cancelAutosave();
  if (!currentPath || !dirty) return true;
  return persistCurrentFile();
}

async function persistCurrentFile(): Promise<boolean> {
  const model = getModel();
  if (!model || !currentPath) return false;
  if (!dirty) return true;

  if (saveInFlight) {
    await saveInFlight;
    if (!dirty) return true;
    return persistCurrentFile();
  }

  const path = currentPath;
  const content = contentForDisk(model.getValue());
  const version = model.getVersionId();
  let failed = false;
  saveState = "saving";
  refreshChrome();

  const operation = (async (): Promise<boolean> => {
    try {
      await saveFile(path, content);
      if (currentPath !== path) return false;
      if (model.getVersionId() === version) {
        dirty = false;
        saveState = "saved";
        syncNativeDocumentState();
        refreshChrome();
        return true;
      }
      // More edits landed during the write. Keep the dirty state and let the
      // caller schedule one coalesced follow-up write with the latest content.
      return false;
    } catch (err) {
      failed = true;
      dirty = true;
      saveState = "error";
      syncNativeDocumentState();
      refreshChrome();
      console.error("autosave failed:", err);
      showToast(t("error.autosaveFailed") + errorMessage(err), "error");
      return false;
    }
  })();

  saveInFlight = operation;
  const saved = await operation;
  saveInFlight = null;

  if (currentPath === path && dirty && !failed) scheduleAutosave();
  return saved;
}

/** Heuristic: was the error just the user cancelling a picker? */
function isCancel(err: unknown): boolean {
  if (err === "cancelled") return true;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  return false;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function contentForDisk(content: string): string {
  const lf = content.replace(/\r\n|\r/g, "\n");
  if (currentLineEnding === "CRLF") return lf.replace(/\n/g, "\r\n");
  if (currentLineEnding === "CR") return lf.replace(/\n/g, "\r");
  return lf;
}

function syncNativeDocumentState(): void {
  void setDocumentState(currentPath, dirty, getLang()).catch((err) => {
    console.warn("failed to sync document state:", err);
  });
}

function refreshChrome(): void {
  updateTitle();
  refreshStatusbar();
  // The toolbar language <select> and the Edit/Preview toggle mirror
  // `currentSyntax` and `viewMode`. Only re-render when either actually
  // changes; this avoids rebuilding the toolbar (and dropping the open
  // <select> dropdown / focus) on every keystroke that flows through
  // refreshChrome via onDidChangeContent.
  if (lastRenderedSyntax !== currentSyntax || lastRenderedMode !== viewMode) {
    lastRenderedSyntax = currentSyntax;
    lastRenderedMode = viewMode;
    renderToolbar();
  }
}

function refreshStatusbar(line?: number, column?: number): void {
  const model = getModel();
  const pos = getEditor()?.getPosition();
  const cursorLine = line ?? pos?.lineNumber ?? 1;
  const cursorColumn = column ?? pos?.column ?? 1;
  const value = model?.getValue() ?? "";
  const cursorOffset = model
    ? model.getOffsetAt({ lineNumber: cursorLine, column: cursorColumn })
    : 0;

  updateStatusbar({
    path: currentPath,
    dirty,
    line: cursorLine,
    column: cursorColumn,
    syntax: currentSyntax,
    encoding: currentEncoding,
    lineEnding: currentLineEnding,
    saveState,
    lineCount: model?.getLineCount() ?? 1,
    characterCount: model?.getValueLength() ?? 0,
    cursorOffset,
    byteSize: new TextEncoder().encode(contentForDisk(value)).byteLength,
  });
}

/**
 * Apply a manual language override chosen from the toolbar switcher.
 *
 * Unlike file detection, this does not look at the path - it sets whatever the
 * user picked, so e.g. a `.txt` can be highlighted as Python. The model's
 * `onDidChangeLanguage` hook re-seeds the tree-sitter / regex highlighters
 * automatically. `null` resets to plaintext.
 *
 * Preview mode is only valid for Markdown; switching away from Markdown
 * forces the view back to edit so a stale preview pane is never shown.
 */
function onSyntaxChange(syntax: string | null): void {
  currentSyntax = syntax;
  setModelLanguageBySyntax(syntax);
  if (syntax !== "Markdown" && viewMode === "preview") {
    setViewMode("edit");
  }
  refreshStatusbar();
  refreshChrome();
}

/**
 * Switch between the Monaco editor and the markdown preview panel.
 *
 * Entering preview renders the current buffer once and hides the editor;
 * leaving preview refocuses the editor. The toolbar is refreshed so the
 * segmented toggle reflects the new mode. No-op when the requested mode
 * equals the current one, or when preview is requested for a non-markdown
 * buffer (the toggle UI hides that case, but this guards menu/shortcut
 * entry points too).
 */
function setViewMode(mode: ViewMode): void {
  if (mode === viewMode) return;
  if (mode === "preview" && currentSyntax !== "Markdown") return;
  viewMode = mode;
  if (mode === "preview") {
    const model = getModel();
    renderPreview(model?.getValue() ?? "");
    showPreview();
  } else {
    hidePreview();
    queueMicrotask(() => getEditor()?.focus());
  }
  refreshChrome();
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
      case "e":
        // Toggle Edit/Preview for markdown buffers (mirrors the View menu
        // item and the toolbar segmented control).
        if (currentSyntax === "Markdown") {
          e.preventDefault();
          setViewMode(viewMode === "edit" ? "preview" : "edit");
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
        // Built fresh on each open so `disabled` and `checked` track the
        // live syntax / mode - the static `items` array would freeze them at
        // menu-bar build time (language switch) and drift out of sync.
      ],
      buildItems: (): MenuItem[] => [
        {
          label: t("view.lineNumbers"),
          monacoAction: "editor.action.toggleLineNumbers",
        },
        {
          label: t("view.renderWhitespace"),
          run: () => {
            const ed = getEditor();
            if (!ed) return;
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
        {
          label: t("view.togglePreview"),
          shortcut: "Ctrl+E",
          // Only meaningful for markdown buffers; disabled otherwise so the
          // menu item stays visible (discoverable) but non-interactive.
          disabled: currentSyntax !== "Markdown",
          checked: currentSyntax === "Markdown" && viewMode === "preview",
          run: () =>
            setViewMode(viewMode === "edit" ? "preview" : "edit"),
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
