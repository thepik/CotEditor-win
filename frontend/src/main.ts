/**
 * CotEditor-win frontend entry point.
 *
 * Wires together the three concerns of the app:
 *  1. The Monaco editor (mounted into #editor by `monaco-setup`).
 *  2. A tabbed, multi-document session (`DocumentManager` + `DocumentStore` +
 *     `ui/tabs`) with encoding-aware manual saves.
 *  3. UI chrome (toolbar, statusbar, menus) that always reflects the active tab.
 *
 * This file stays thin: document policy lives in `lib/document-manager`, file IO
 * in `lib/file-bridge`, and the panels under src/ui.
 */

import "./styles.css";
import { setupMonaco, getEditor, monaco } from "./editor/monaco-setup";
import { loadAllThemes, applyTheme, getCurrentTheme, getPreferredTheme, listThemes } from "./editor/theme-loader";
import { initSyntaxMap, listSyntaxes } from "./lib/syntax-map";
import { attachLanguage } from "./editor/language-config";
import { registerHighlightProviders, attachModelChangeTracking } from "./editor/highlight-tree-sitter";
import { registerRegexHighlight, refreshRegexTokens } from "./editor/highlight-regex";
import { registerAllGrammars } from "./editor/grammar-registry";
import { wireToolbar, renderToolbar, type ViewMode } from "./ui/toolbar";
import { updateStatusbar, updateStatusbarCursor } from "./ui/statusbar";
import { renderPreview, schedulePreviewRender, showPreview, showPreviewSplit, hidePreview, setPreviewResourceResolver, setPreviewLinkHandler } from "./ui/preview";
import { createOutline, type OutlineController } from "./ui/outline";
import { registerLineCommands } from "./editor/line-commands";
import { openSnippetManager, registerSnippetShortcuts } from "./ui/snippet-manager";
import { openFind, openReplace } from "./ui/find-panel";
import { createFindResults, type FindResultsController } from "./ui/find-results";
import { openMultipleReplacePanel } from "./ui/multiple-replace-ui";
import { showToast } from "./ui/notifications";
import { renderMenuBar, closeMenu, type MenuBar, type MenuItem } from "./ui/menubar";
import { t, onLangChange, getLang, setLang, langName, type Lang } from "./lib/i18n";
import { confirmNormalizeLineEndings, confirmCloseSession, confirmUnsavedChanges } from "./ui/confirm-dialog";
import { createTabs, type TabsApi } from "./ui/tabs";
import { DocumentManager, contentForDisk } from "./lib/document-manager";
import {
  loadSettings,
  saveSettings,
  applyEditorSettings,
  subscribeSettings,
  SETTINGS_LIMITS,
  SETTINGS_STORAGE_KEY,
  type Settings,
} from "./lib/settings";
import { listRecentFiles, removeRecentFile } from "./lib/recent-files";
import {
  isWails,
  isFileStampAvailable,
  openFileWithEncoding,
  setSessionDirty,
  startupFile,
} from "./lib/file-bridge";
import { RecoveryService, ensureRecoveryId } from "./lib/recovery-service";
import { openRecoveryDialog } from "./ui/recovery-dialog";
import { openConflictDialog, type ConflictDecision } from "./ui/conflict-dialog";
import type { EncodingChoice } from "./ui/encoding-menu";
import { AutoSaver } from "./lib/auto-save";
import * as WailsRuntime from "./wailsjs/runtime/runtime";
import * as WailsApp from "./wailsjs/go/main/App";

let manager: DocumentManager;
let tabs: TabsApi;
let recovery: RecoveryService;
let currentSettings: Settings;
const autoSaver = new AutoSaver();

/** External-change poll cadence; the active tab is always checked first. */
const EXTERNAL_POLL_MS = 2000;
let pollInFlight = false;
/** Documents whose conflict dialog is already open (never stack dialogs). */
const conflictDialogs = new Set<string>();

/** Stable handlers so the statusbar rebuilds its encoding menu only once. */
const reopenEncodingHandler = (encoding: string): void => {
  void reopenActiveWithEncoding(encoding as EncodingChoice);
};
const saveEncodingHandler = (encoding: string): void => {
  void saveActiveWithEncoding(encoding as EncodingChoice);
};

/** Active tab's view mode; reset to edit when the active document isn't Markdown. */
let viewMode: ViewMode = "edit";
let outline: OutlineController | null = null;
let outlineHost: HTMLElement | null = null;
let outlineSyncFrame: number | null = null;
let lastRenderedSyntax: string | null | undefined = undefined;
let lastRenderedMode: ViewMode | undefined = undefined;
let composing = false;
let closingForQuit = false;

/** Independent find-results list mounted into #find-results (Ctrl+Shift+F). */
let findResults: FindResultsController | null = null;
/** Last query used by "find all", reused as the prompt default. */
let findAllQuery = "";
/** Native/DOM file-drop wiring is bound exactly once per window. */
let fileDropBound = false;
/** Paths currently being opened, so duplicate drop/event deliveries collapse. */
const openingPaths = new Set<string>();

/** Preview assets are capped by the Go bridge; mirror the limit defensively. */
const PREVIEW_MAX_ASSET_BYTES = 10 * 1024 * 1024;
const DEFAULT_OUTLINE_WIDTH = 240;

const STATISTICS_DELAY_MS = 150;
let statisticsTimer: number | null = null;
interface StatisticsEntry {
  key: string;
  characterCount: number;
  byteSize: number;
}
const statisticsCache = new Map<string, StatisticsEntry>();
const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

async function bootstrap(): Promise<void> {
  // 1. Editor core.
  await setupMonaco();
  const editor = getEditor();
  if (!editor) throw new Error("Monaco failed to initialise");

  // 2. Themes, syntax engines and persisted editor settings.
  await initSyntaxMap();
  await loadAllThemes();
  applyTheme(getPreferredTheme());
  const settings = loadSettings();
  currentSettings = settings;
  applyEditorSettings(editor, settings);
  // The language menu predates the settings module and has its own storage.
  // Only let settings override it when a settings payload actually exists.
  if (hasStoredSettings() && settings.language !== getLang()) setLang(settings.language);

  await attachLanguage();
  registerAllGrammars();
  registerHighlightProviders();
  await registerRegexHighlight();
  attachModelChangeTracking();
  registerLineCommands();

  // 3. Tabs + document session. The tab strip is created before the manager so
  // its callbacks and the manager's structural notifications can reference it.
  recovery = new RecoveryService();
  autoSaver.configure({
    enabled: settings.autoSave,
    delayMs: settings.autoSaveDelayMs,
  });
  const tabsHost = document.getElementById("tabs");
  if (!tabsHost) throw new Error("#tabs host element not found");
  tabs = createTabs(tabsHost, {
    onActivate: (id) => {
      if (manager.activate(id)) getEditor()?.focus();
    },
    onClose: (id) => { void closeDocument(id); },
    onReorder: (ids) => manager.reorder(ids),
    onNew: () => onNew(),
  });

  manager = new DocumentManager(editor, {
    onStructureChange: () => {
      syncTabs();
      refreshChrome();
      scheduleStatistics();
    },
    onActiveChange: () => {
      // Results belong to the previous document's text; never keep them
      // pointing at a buffer that is no longer active.
      findResults?.clear();
      tabs.setActive(manager.activeId ?? "");
      reconcilePreviewForActive();
      syncOutline();
      refreshChrome();
      scheduleStatistics();
    },
    onDocumentChange: (id) => {
      updateTab(id);
      const changed = manager.get(id);
      if (changed) {
        scheduleRecovery(changed);
        scheduleAutoSave(changed);
      }
      if (manager.activeId !== id) return;
      // The offsets recorded by the last search are stale after any edit.
      findResults?.clear();
      refreshChrome();
      scheduleStatistics();
      scheduleOutlineSync();
      if (
        (viewMode === "preview" || viewMode === "split")
        && manager.activeSyntax() === "Markdown"
      ) {
        const document = manager.active;
        if (document) schedulePreviewRender(document.model.getValue());
      }
    },
    onSessionDirty: (dirty) => {
      void setSessionDirty(dirty).catch((error) => {
        console.warn("failed to sync session dirty state:", error);
      });
    },
    onSaveConflict: (id) => {
      void resolveFileConflict(id);
    },
    onDocumentSaved: (id, path) => {
      const document = manager.get(id);
      if (!document) return;
      // If newer edits arrived while the write was in flight, the buffer is
      // still dirty and the newest draft was just scheduled; clearing it here
      // would lose the only copy of that text. Re-arm auto-save once the save
      // transaction has cleared its in-flight marker.
      if (document.dirty) {
        window.setTimeout(() => {
          const current = manager.get(id);
          if (current) scheduleAutoSave(current);
        }, 0);
        return;
      }
      autoSaver.cancel(id);
      const recoveryId = document.recoveryId;
      if (recoveryId) {
        void recovery.completeSave(recoveryId, path).then(() => {
          // Edits that arrived while the draft discard was in flight still
          // need a crash-safe copy.
          const current = manager.get(id);
          if (current?.dirty) scheduleRecovery(current);
        });
      }
    },
    onDocumentClosed: (id, recoveryId, savedOnClose) => {
      autoSaver.cancel(id);
      conflictDialogs.delete(id);
      if (!savedOnClose && recoveryId) void recovery.discard(recoveryId);
    },
  });

  // The fresh launch starts with one reusable untitled placeholder tab.
  manager.createBlank(true);

  // Preview resources/links are resolved against the active document's path.
  installPreviewHandlers();
  initOutline();
  initFindResults();
  applyChromeLabels();

  // Expose read-only state for headless regressions. No command surface.
  const debug = {
    themeCount: 0,
    currentTheme: getCurrentTheme(),
    syntaxCount: 0,
    document: () => {
      const document = manager.active;
      return {
        documentId: document?.id ?? null,
        activeId: manager.activeId,
        path: document?.path ?? null,
        dirty: document?.dirty ?? false,
        conflict: document?.conflict ?? false,
        encoding: document?.encoding ?? null,
        saveState: document?.saveState ?? "idle",
        documentOperationActive: manager.busy,
        saveInFlight: manager.isSaving(),
        formatProtection: document?.formatProtection ?? null,
        anyDirty: manager.anyDirty(),
      };
    },
    tabs: () => manager.tabItems(),
    snapshot: (id?: string) =>
      manager.snapshot(id ?? manager.activeId ?? ""),
    activeValue: () => manager.active?.model.getValue() ?? "",
    readOnly: () => getEditor()?.getOption(monaco.editor.EditorOption.readOnly) ?? false,
    findResults: () => ({
      open: findResults?.isOpen() ?? false,
      count: findResults?.matchCount() ?? 0,
    }),
  };
  // @ts-expect-error debug-only global
  window.__coteditor = debug;
  queueMicrotask(() => {
    debug.themeCount = listThemes().length;
    debug.syntaxCount = listSyntaxes().length;
  });

  // 4. Chrome.
  renderMenuBar(buildMenuBar());
  wireToolbar({
    onNew,
    onOpen,
    onSave,
    onSaveAs,
    onSyntaxChange,
    currentSyntax: () => manager.activeSyntax(),
    onModeChange: setViewMode,
    currentMode: () => viewMode,
    isPreviewAvailable: () => manager.activeSyntax() === "Markdown",
  });
  refreshChrome();

  subscribeSettings((next) => {
    const previous = currentSettings;
    currentSettings = next;
    const currentEditor = getEditor();
    if (currentEditor) applyEditorSettings(currentEditor, next);
    if (next.language !== getLang()) setLang(next.language);
    autoSaver.configure({ enabled: next.autoSave, delayMs: next.autoSaveDelayMs });
    if (next.autoSave
      && (!previous.autoSave || previous.autoSaveDelayMs !== next.autoSaveDelayMs)) {
      // Enabling or retuning auto-save applies to the buffer already being edited.
      const document = manager.active;
      if (document) scheduleAutoSave(document);
    }
    if (
      previous.showOutline !== next.showOutline
      || previous.outlineWidth !== next.outlineWidth
    ) {
      applyOutlineWidth();
      syncOutline();
      relayoutEditor();
    }
  });

  onLangChange(() => {
    closeMenu();
    renderMenuBar(buildMenuBar());
    applyChromeLabels();
    // The results module resolves its labels at creation time; rebuild the
    // controller so its region/list/status labels follow the new language.
    findResults?.destroy();
    findResults = null;
    initFindResults();
    syncTabs();
    refreshChrome();
    rerenderPreview();
  });

  editor.onDidChangeCursorPosition((e: { position: { lineNumber: number; column: number } }) => {
    const model = editor.getModel();
    if (!model) return;
    updateStatusbarCursor(
      e.position.lineNumber,
      e.position.column,
      model.getOffsetAt(e.position),
    );
    if (outline && outlineHost && !outlineHost.hidden) {
      outline.setActiveLine(e.position.lineNumber);
    }
  });

  registerShortcuts();
  registerSnippetShortcuts();
  // Split mode changes the editor's box; a window resize must relayout Monaco
  // even when the preview stylesheet (not Monaco's observer) drove the change.
  window.addEventListener("resize", relayoutEditor);
  scheduleStatistics();

  if (!isWails()) {
    window.addEventListener("beforeunload", (event) => {
      if (!manager.anyDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }
  registerNativeEvents();
  registerFileDrop();

  // 5. Recovery drafts first (one modal), then the command-line file.
  await maybeRestoreRecoveryDrafts();
  startExternalChangeMonitor();

  // 6. Command-line file at launch and second-instance forwards.
  void loadStartupFile();
}

function hasStoredSettings(): boolean {
  try {
    return localStorage.getItem(SETTINGS_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

async function loadStartupFile(): Promise<void> {
  let path: string | null;
  try {
    path = await startupFile();
  } catch (error) {
    console.error("startupFile failed:", error);
    return;
  }
  if (!path) return;
  if (await manager.openPath(path)) getEditor()?.focus();
}

/* ------------------------- recovery drafts / auto-save -------------------- */

/** Queue the newest draft for a dirty document; empty content is ignored. */
function scheduleRecovery(document: ReturnType<DocumentManager["get"]>): void {
  if (!document || !document.dirty || !recovery?.available) return;
  const id = ensureRecoveryId(document);
  recovery.schedule({
    id,
    path: document.path,
    content: contentForDisk(document),
    encoding: document.encoding,
    lineEnding: document.lineEnding,
  });
}

/**
 * Auto-save is opt-in. It is gated on a real path, a dirty buffer and the
 * absence of an unresolved conflict, so "cancel" in the conflict dialog also
 * pauses automatic writes until the user decides.
 */
function scheduleAutoSave(document: ReturnType<DocumentManager["get"]>): void {
  if (!document) return;
  const eligible = currentSettings.autoSave
    && !!document.path
    && document.dirty
    && !document.conflict
    && !manager.isSaving(document.id);
  if (!eligible) {
    autoSaver.cancel(document.id);
    return;
  }
  autoSaver.schedule(document.id, () => {
    const current = manager.get(document.id);
    if (!current || !current.path || !current.dirty || current.conflict) return;
    void manager.saveDocument(document.id, "save");
  });
}

async function maybeRestoreRecoveryDrafts(): Promise<void> {
  if (!recovery.available) return;
  const drafts = await recovery.list();
  if (drafts.length === 0) return;
  const result = await openRecoveryDialog({ entries: drafts });
  if (result.action === "cancel") return;
  if (result.action === "discard") {
    if (result.entry?.id) await recovery.discard(result.entry.id);
    else await recovery.discardAll();
    return;
  }
  await manager.restoreRecovery({
    id: result.entry.id,
    path: result.entry.path ?? "",
    content: result.entry.content ?? "",
    encoding: result.entry.encoding ?? "UTF-8",
    lineEnding: result.entry.lineEnding ?? "LF",
    exists: result.entry.exists !== false,
  });
  // The draft stays on disk until a successful save; it is the crash-safe copy.
  refreshChrome();
  getEditor()?.focus();
}

/* --------------------------- external modification ------------------------ */

function startExternalChangeMonitor(): void {
  if (!isFileStampAvailable()) return;
  const tick = (): void => {
    void pollExternalChanges().finally(() => {
      if (closingForQuit) return;
      window.setTimeout(tick, EXTERNAL_POLL_MS);
    });
  };
  window.setTimeout(tick, EXTERNAL_POLL_MS);
}

async function pollExternalChanges(): Promise<void> {
  if (pollInFlight || closingForQuit || !manager) return;
  pollInFlight = true;
  try {
    const changes = await manager.detectExternalChanges();
    for (const change of changes) {
      if (!manager.get(change.id)) continue;
      if (change.dirty) {
        await resolveFileConflict(change.id);
      } else {
        const staleDraft = manager.get(change.id)?.recoveryId ?? "";
        const reloaded = await manager.reloadFromDisk(change.id);
        if (reloaded && staleDraft) void recovery.discard(staleDraft);
        refreshChrome();
      }
    }
  } catch (error) {
    console.warn("external-change poll failed:", error);
  } finally {
    pollInFlight = false;
  }
}

async function resolveFileConflict(id: string): Promise<void> {
  if (conflictDialogs.has(id) || !manager.get(id)) return;
  conflictDialogs.add(id);
  try {
    const document = manager.get(id);
    if (!document) return;
    const decision: ConflictDecision = await openConflictDialog({
      fileName: document.path ? baseName(document.path) : t("status.untitled"),
      path: document.path,
      dirty: document.dirty,
    });
    const current = manager.get(id);
    if (!current) return;
    switch (decision) {
      case "keepLocal":
        // The current disk version becomes the baseline, so the next save is
        // allowed to replace it.
        await manager.keepLocal(id);
        scheduleAutoSave(manager.get(id));
        scheduleRecovery(manager.get(id));
        break;
      case "reload": {
        const staleDraft = current.recoveryId;
        const reloaded = await manager.reloadFromDisk(id);
        if (reloaded && staleDraft) void recovery.discard(staleDraft);
        break;
      }
      case "saveAs":
        await manager.saveDocument(id, "saveAs");
        break;
      case "cancel":
        manager.cancelConflict(id);
        autoSaver.cancel(id);
        break;
    }
  } catch (error) {
    console.warn("conflict resolution failed:", error);
  } finally {
    conflictDialogs.delete(id);
    refreshChrome();
  }
}

/* ----------------------------- encoding actions --------------------------- */

async function reopenActiveWithEncoding(encoding: EncodingChoice): Promise<void> {
  const document = manager.active;
  if (!document || !document.path) return;
  if (document.dirty) {
    const decision = await confirmUnsavedChanges(
      document.path ? baseName(document.path) : t("status.untitled"),
    );
    if (decision === "cancel") return;
    if (decision === "save" && !(await manager.saveDocument(document.id, "save"))) return;
  }
  const staleDraft = document.recoveryId;
  if (await manager.reopenWithEncoding(document.id, encoding)) {
    if (staleDraft) void recovery.discard(staleDraft);
    refreshChrome();
    getEditor()?.focus();
  }
}

async function saveActiveWithEncoding(encoding: EncodingChoice): Promise<void> {
  const document = manager.active;
  if (!document) return;
  await manager.saveWithEncoding(document.id, encoding);
  refreshChrome();
}

/** File ▸ Open with Encoding… choices (labels match the Go canonical names). */
const OPEN_WITH_ENCODINGS = [
  "UTF-8",
  "UTF-8 BOM",
  "UTF-16LE",
  "UTF-16BE",
  "GB18030",
] as const;

async function openWithEncoding(encoding: string): Promise<void> {
  try {
    const content = await openFileWithEncoding(encoding);
    manager.openContent(content);
    refreshChrome();
    getEditor()?.focus();
  } catch (error) {
    if ((error as DOMException | undefined)?.name === "AbortError") return;
    console.error("open with encoding failed:", error);
    showToast(
      t("error.openFailed") + (error instanceof Error ? error.message : String(error)),
      "error",
    );
  }
}

/* ----------------------------- file operations ---------------------------- */

function onNew(): void {
  manager.createBlank(true);
  getEditor()?.focus();
}

async function onOpen(): Promise<void> {
  if (await manager.openFromPicker()) getEditor()?.focus();
}

async function onSave(): Promise<boolean> {
  return manager.saveActive("save");
}

async function onSaveAs(): Promise<boolean> {
  return manager.saveActive("saveAs");
}

async function closeActiveTab(): Promise<void> {
  await manager.closeActive();
  getEditor()?.focus();
}

async function closeDocument(id: string): Promise<void> {
  const closed = await manager.closeDocument(id);
  if (closed) getEditor()?.focus();
}

async function openRecent(path: string): Promise<void> {
  const opened = await manager.openPath(path);
  if (opened) {
    getEditor()?.focus();
    return;
  }
  // A recent entry that no longer opens (deleted/moved/permission) is pruned.
  removeRecentFile(path);
}

function onSyntaxChange(syntax: string | null): void {
  const document = manager.active;
  if (!document) return;
  manager.setSyntax(document.id, syntax);
  if (syntax !== "Markdown" && viewMode !== "edit") setViewMode("edit");
  syncOutline();
  refreshChrome();
}

function previewModeActive(): boolean {
  return viewMode === "preview" || viewMode === "split";
}

/**
 * Switch the editor/preview panel for the active document. Preview is only
 * valid for Markdown; every document switch re-checks that invariant.
 *
 * `preview` is the original full-screen Reading View, `split` keeps the editor
 * visible; both share the same renderer and handlers.
 */
function setViewMode(mode: ViewMode): void {
  const document = manager.active;
  if (!document || mode === viewMode) return;
  if (mode !== "edit" && manager.syntaxFor(document.id) !== "Markdown") return;
  viewMode = mode;
  if (mode === "preview") {
    renderPreview(document.model.getValue());
    showPreview();
  } else if (mode === "split") {
    renderPreview(document.model.getValue());
    showPreviewSplit();
  } else {
    hidePreview();
    queueMicrotask(() => getEditor()?.focus());
  }
  relayoutEditor();
  refreshChrome();
}

function reconcilePreviewForActive(): void {
  const document = manager.active;
  if (!document || manager.syntaxFor(document.id) !== "Markdown") {
    if (viewMode !== "edit") {
      viewMode = "edit";
      hidePreview();
      relayoutEditor();
    }
    return;
  }
  if (previewModeActive()) {
    renderPreview(document.model.getValue());
    if (viewMode === "split") showPreviewSplit();
    else showPreview();
    relayoutEditor();
  }
}

/** Re-render the preview after a theme/language change. */
function rerenderPreview(): void {
  const document = manager?.active;
  if (!document || !previewModeActive()) return;
  if (manager.syntaxFor(document.id) !== "Markdown") return;
  renderPreview(document.model.getValue());
}

/** Monaco observes its container; an explicit pass covers flex relayouts. */
function relayoutEditor(): void {
  window.requestAnimationFrame(() => {
    try {
      getEditor()?.layout();
    } catch (error) {
      console.warn("editor layout failed:", error);
    }
  });
}

/* ------------------------------ preview wiring ---------------------------- */

/**
 * Install the native handlers the preview calls for document-relative content.
 *
 * Images are read through the Go asset bridge and returned as `data:` URLs;
 * anything that cannot be read (no path, missing/oversized file, non-image
 * MIME) resolves to `null`, which leaves the preview's visible "blocked" notice
 * in place. Only relative references are resolved: URL schemes such as
 * http(s), data and file are rejected here even if a caller bypasses the
 * preview's own router.
 *
 * Relative `.md`/`.txt` links open in a tab through the document manager,
 * which reuses an existing tab for the same path. `#anchors` and external URLs
 * never reach this handler: `preview.ts` handles them first.
 */
function installPreviewHandlers(): void {
  setPreviewResourceResolver((href, kind) => {
    if (kind !== "image") return null;
    const document = manager?.active;
    if (!document?.path) return null;
    const absolute = resolveDocumentReference(document.path, href);
    if (!absolute) return null;
    return readAssetDataUrl(absolute);
  });

  setPreviewLinkHandler((href) => {
    const document = manager?.active;
    if (!document?.path) return false;
    const target = stripReferenceSuffix(href);
    if (!target || !/\.(?:md|txt)$/i.test(target)) return false;
    const absolute = resolveDocumentReference(document.path, target);
    if (!absolute) return false;
    // manager.openPath activates an existing tab for the same path, otherwise
    // it opens a new one. Failures surface as the normal open-file toast.
    void manager.openPath(absolute).catch((error) => {
      console.warn("preview: could not open linked document:", absolute, error);
    });
    return true;
  });
}

/**
 * Read one preview asset through the Go bridge. Returns `null` (never throws)
 * for unavailable bindings, read failures, non-image payloads and assets over
 * the bridge limit; preview.ts then blocks the image with a notice.
 */
async function readAssetDataUrl(absolutePath: string): Promise<string | null> {
  if (!isWails()) return null;
  try {
    const asset = await WailsApp.ReadAssetBase64(absolutePath);
    const mime = typeof asset?.mime === "string" ? asset.mime.trim().toLowerCase() : "";
    const data = typeof asset?.data === "string" ? asset.data : "";
    const size = Number(asset?.size);
    if (!/^image\/[a-z0-9.+-]+$/.test(mime)) return null;
    if (Number.isFinite(size) && size > PREVIEW_MAX_ASSET_BYTES) return null;
    if (!data || !/^[A-Za-z0-9+/=\r\n]+$/.test(data)) return null;
    return `data:${mime};base64,${data.replace(/[\r\n]/g, "")}`;
  } catch (error) {
    console.warn("preview: asset could not be read:", absolutePath, error);
    return null;
  }
}

/** Drop a `?query`/`#fragment` suffix from a document reference. */
function stripReferenceSuffix(href: string): string {
  return (href ?? "").trim().replace(/[?#].*$/, "");
}

/**
 * Resolve a relative reference written in a Markdown buffer against the
 * document's own directory. Returns an absolute local path or `null` for
 * empty input, URL schemes and malformed bases. Windows drive paths and POSIX
 * paths are both understood; `.`/`..` segments are collapsed.
 */
function resolveDocumentReference(documentPath: string, rawHref: string): string | null {
  const href = (rawHref ?? "").trim();
  if (href === "" || href.startsWith("#") || href.startsWith("//")) return null;
  // A URL scheme is never a local path; a drive letter (`C:\`) is.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return null;

  let decoded = stripReferenceSuffix(href);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // A malformed escape stays literal, matching typical shell behaviour.
  }
  decoded = decoded.trim();
  if (decoded === "") return null;

  const windows = /^[a-zA-Z]:[\\/]/.test(documentPath) || documentPath.startsWith("\\\\");
  if (windows) {
    if (documentPath.startsWith("\\\\")) return null; // UNC bases are out of scope.
    const base = documentPath.replace(/\//g, "\\");
    const target = decoded.replace(/\//g, "\\");
    let combined: string;
    if (/^[a-zA-Z]:[\\/]/.test(target)) {
      combined = target;
    } else if (target.startsWith("\\")) {
      const drive = /^[a-zA-Z]:/.exec(base)?.[0];
      if (!drive) return null;
      combined = drive + target;
    } else {
      const index = base.lastIndexOf("\\");
      if (index < 0) return null;
      combined = `${base.slice(0, index)}\\${target}`;
    }
    return normalizeLocalPath(combined, true);
  }

  if (!documentPath.startsWith("/")) return null;
  const target = decoded.replace(/\\/g, "/");
  const combined = target.startsWith("/")
    ? target
    : `${documentPath.slice(0, documentPath.lastIndexOf("/"))}/${target}`;
  return normalizeLocalPath(combined, false);
}

function normalizeLocalPath(path: string, windows: boolean): string | null {
  const parts: string[] = [];
  let prefix: string;
  let rest: string;
  if (windows) {
    const drive = /^([a-zA-Z]:)/.exec(path);
    if (!drive) return null;
    prefix = drive[1].toUpperCase();
    rest = path.slice(2);
  } else {
    if (!path.startsWith("/")) return null;
    prefix = "/";
    rest = path;
  }
  for (const part of rest.split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return windows
    ? `${prefix}\\${parts.join("\\")}`
    : `${prefix}${parts.join("/")}`;
}

/* --------------------------------- outline -------------------------------- */

function initOutline(): void {
  const host = document.getElementById("outline");
  if (!host) return;
  outlineHost = host;
  outline = createOutline(host);
  outline.onNavigate((line) => {
    const editor = getEditor();
    const model = editor?.getModel();
    if (!editor || !model) return;
    const target = Math.min(Math.max(1, line), model.getLineCount());
    editor.setPosition({ lineNumber: target, column: 1 });
    editor.revealLineInCenter(target);
    editor.focus();
  });
  applyOutlineWidth();
  syncOutline();
}

function outlineShown(): boolean {
  return !!manager?.active
    && manager.activeSyntax() === "Markdown"
    && currentSettings?.showOutline === true;
}

function applyOutlineWidth(): void {
  if (!outlineHost) return;
  const configured = currentSettings?.outlineWidth;
  const width = typeof configured === "number" ? configured : DEFAULT_OUTLINE_WIDTH;
  outlineHost.style.setProperty("--ce-outline-width", `${width}px`);
}

/** Show/hide and repopulate the outline for the active document. */
function syncOutline(): void {
  if (!outline || !outlineHost) return;
  const show = outlineShown();
  outlineHost.hidden = !show;
  if (!show) return;
  const document = manager.active;
  if (!document) {
    outlineHost.hidden = true;
    return;
  }
  outline.update(document.model);
  outline.setActiveLine(getEditor()?.getPosition()?.lineNumber ?? 1);
}

/** Coalesce keystroke-driven outline parses to one per frame. */
function scheduleOutlineSync(): void {
  if (outlineSyncFrame !== null) return;
  outlineSyncFrame = window.requestAnimationFrame(() => {
    outlineSyncFrame = null;
    syncOutline();
  });
}

/**
 * Toggle the outline. The choice is persisted through settings; the
 * subscription applies visibility and width. Non-Markdown documents keep the
 * preference but hide the panel until a Markdown tab is active again.
 */
function toggleOutline(force?: boolean): void {
  const next = typeof force === "boolean" ? force : currentSettings?.showOutline !== true;
  if (next === (currentSettings?.showOutline === true)) {
    syncOutline();
    return;
  }
  saveSettings({ showOutline: next });
  syncOutline();
  relayoutEditor();
}

/* ------------------------------ find results ------------------------------ */

/**
 * Mount the standalone results list. Navigation moves the caret and selects the
 * match; replacement is deliberately a preview-only callback (the document is
 * never edited from this module).
 */
function initFindResults(): void {
  const host = document.getElementById("find-results");
  if (!host || findResults) return;
  findResults = createFindResults(host, {
    onNavigate: (range) => {
      const editor = getEditor();
      if (!editor) return;
      editor.setSelection(range);
      editor.revealRangeInCenterIfOutsideViewport(
        range,
        monaco.editor.ScrollType.Smooth,
      );
    },
    // Preview seam only: the caller counts callback invocations, no edit is
    // applied. See previewReplaceAll().
    onReplace: () => undefined,
  });
}

function selectedEditorText(): string {
  const editor = getEditor();
  const model = editor?.getModel();
  const selection = editor?.getSelection();
  if (!editor || !model || !selection || selection.isEmpty()) return "";
  return model.getValueInRange(selection);
}

/**
 * Find every occurrence of the selected text (or a prompted query) in the
 * active document. Monaco's own Ctrl+F widget is left untouched.
 */
function findInDocumentAll(): void {
  const document = manager?.active;
  if (!document || !findResults) return;
  setViewMode("edit");
  let query = selectedEditorText();
  if (!query || /[\r\n]/.test(query)) {
    const answer = window.prompt(t("find.queryPrompt"), findAllQuery);
    if (answer === null) return;
    query = answer;
  }
  query = query.trim();
  if (!query) {
    findResults.clear();
    return;
  }
  findAllQuery = query;
  findResults.search(document.model, query, {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  getEditor()?.focus();
}

/**
 * Non-destructive replacement preview: asks for the replacement text, invokes
 * the module's per-match callback and reports the count. Nothing is written to
 * the model, so undo/history and the save transaction are unaffected.
 */
function previewReplaceAll(): void {
  if (!findResults || findResults.matchCount() === 0) return;
  const replacement = window.prompt(t("find.replacePrompt"), "");
  if (replacement === null) return;
  const count = findResults.replaceAll(replacement);
  showToast(t("find.replacePreview").replace("{count}", String(count)));
}

/**
 * Persisted font-size step for View ▸ Zoom In/Out and Ctrl+= / Ctrl+-. The
 * settings subscription applies the new value through applyEditorSettings.
 */
function adjustFontSize(delta: number): void {
  const editor = getEditor();
  if (!editor) return;
  const current = currentSettings?.fontSize
    ?? editor.getOption(monaco.editor.EditorOption.fontSize);
  const next = Math.min(
    SETTINGS_LIMITS.fontSize.max,
    Math.max(SETTINGS_LIMITS.fontSize.min, current + delta),
  );
  if (next === current) return;
  saveSettings({ fontSize: next });
}

/* ------------------------------ chrome labels ----------------------------- */

function applyChromeLabels(): void {
  document.documentElement.lang = getLang() === "zh" ? "zh-CN" : "en";
  const set = (id: string, label: string): void => {
    document.getElementById(id)?.setAttribute("aria-label", label);
  };
  set("toolbar", t("a11y.toolbar"));
  set("workspace", t("a11y.workspace"));
  set("editor", t("a11y.editor"));
  set("find-results", t("a11y.findResults"));
  set("statusbar", t("a11y.statusbar"));
  outlineHost?.setAttribute("aria-label", t("a11y.outline"));
}

async function normalizeActiveLineEndings(): Promise<void> {
  const document = manager.active;
  if (!document || document.formatProtection !== "mixed") return;
  if (!(await confirmNormalizeLineEndings())) return;
  manager.normalizeLineEndings(document.id);
  refreshChrome();
  scheduleStatistics();
  getEditor()?.focus();
}

/* -------------------------------- shortcuts ------------------------------- */

function modalIsOpen(): boolean {
  return !!document.querySelector('.ce-modal, [aria-modal="true"]');
}

function findInEditor(replace = false): void {
  setViewMode("edit");
  // setViewMode queues editor focus; run Find after that so its input keeps focus.
  queueMicrotask(() => { if (replace) openReplace(); else openFind(); });
}

function registerShortcuts(): void {
  window.addEventListener("compositionstart", () => { composing = true; }, true);
  window.addEventListener("compositionend", () => { composing = false; }, true);
  // Escape dismisses the find-results list from anywhere in the window. Leave
  // Escape to Monaco while its own find widget is open, and to open modals.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.isComposing || composing || modalIsOpen()) return;
    if (!findResults?.isOpen()) return;
    if (document.querySelector(".find-widget.visible")) return;
    e.preventDefault();
    e.stopPropagation();
    findResults.clear();
  }, true);
  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const key = e.key.toLowerCase();
    if (e.isComposing || composing || e.keyCode === 229) {
      e.stopImmediatePropagation();
      return;
    }
    if (modalIsOpen()) {
      // Dialog inputs retain normal text shortcuts; file/tab/background
      // commands must not escape their context.
      const blocked = ["n", "o", "s", "e", "p", "f", "h", "w"].includes(key)
        || key === "tab"
        || /^[1-9]$/.test(key)
        || (e.altKey && /^[1-9]$/.test(key));
      if (blocked) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (e.ctrlKey === e.metaKey || e.defaultPrevented) return;

    if (!e.altKey && key === "tab") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) {
        manager.cycle(e.shiftKey ? -1 : 1);
        getEditor()?.focus();
      }
      return;
    }
    if (!e.altKey && !e.shiftKey && /^[1-9]$/.test(key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) {
        manager.activateIndex(Number(key) - 1);
        getEditor()?.focus();
      }
      return;
    }

    let command: (() => void) | undefined;
    if (!e.altKey) {
      if (key === "=" || key === "+") command = () => adjustFontSize(1);
      else if (key === "-") command = () => adjustFontSize(-1);
      else if (!e.shiftKey && key === "w") command = () => { void closeActiveTab(); };
      else if (key === "s") command = () => { void (e.shiftKey ? onSaveAs() : onSave()); };
      else if (!e.shiftKey && key === "n") command = onNew;
      else if (!e.shiftKey && key === "o") command = () => { void onOpen(); };
      else if (!e.shiftKey && key === "e" && manager.activeSyntax() === "Markdown") {
        command = () => setViewMode(viewMode === "preview" ? "edit" : "preview");
      } else if (e.shiftKey && key === "e" && manager.activeSyntax() === "Markdown") {
        command = () => setViewMode(viewMode === "split" ? "edit" : "split");
      } else if (e.shiftKey && key === "o" && manager.activeSyntax() === "Markdown") {
        command = () => toggleOutline();
      } else if (e.shiftKey && key === "f") {
        command = findInDocumentAll;
      } else if (key === "h" && e.shiftKey) {
        command = () => { setViewMode("edit"); openMultipleReplacePanel(); };
      } else if (!e.shiftKey && (key === "f" || key === "h") && viewMode === "preview") {
        command = () => findInEditor(key === "h");
      }
    } else if (!e.shiftKey && key === "p") command = openSnippetManager;
    if (!command) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) command();
  }, true);
}

/* --------------------------------- chrome --------------------------------- */

function syncTabs(): void {
  if (!tabs) return;
  tabs.setTabs(manager.tabItems(), manager.activeId);
}

function updateTab(id: string): void {
  if (!tabs) return;
  const item = manager.tabItem(id);
  if (item) tabs.updateTab(item);
}

function refreshChrome(): void {
  updateTitle();
  refreshStatusbar();
  const syntax = manager?.activeSyntax() ?? null;
  if (lastRenderedSyntax !== syntax || lastRenderedMode !== viewMode) {
    lastRenderedSyntax = syntax;
    lastRenderedMode = viewMode;
    renderToolbar();
  }
}

function statisticsKeyFor(id: string): string {
  const document = manager.get(id);
  if (!document) return "";
  return `${id}:${document.model.getVersionId()}:${document.formatVersion}`;
}

/** Throttled, version-cached full-text work; never called from cursor movement. */
function scheduleStatistics(): void {
  if (statisticsTimer !== null) return;
  statisticsTimer = window.setTimeout(() => {
    statisticsTimer = null;
    const document = manager.active;
    if (!document) return;
    const key = statisticsKeyFor(document.id);
    const cached = statisticsCache.get(document.id);
    if (cached?.key === key) {
      refreshStatusbar();
      return;
    }
    const value = document.model.getValue();
    let characterCount = 0;
    if (/^[\x00-\x7F]*$/.test(value)) {
      characterCount = value.length - (value.match(/\r\n/g)?.length ?? 0);
    } else if (segmenter) {
      for (const _segment of segmenter.segment(value)) characterCount++;
    } else {
      for (const _point of value) characterCount++;
    }
    statisticsCache.set(document.id, {
      key,
      characterCount,
      byteSize: new TextEncoder().encode(
        document.protectedOriginal ?? contentForDisk(document),
      ).byteLength,
    });
    refreshStatusbar();
  }, STATISTICS_DELAY_MS);
}

function refreshStatusbar(): void {
  const document = manager?.active;
  const model = document?.model ?? null;
  const pos = getEditor()?.getPosition() ?? { lineNumber: 1, column: 1 };
  const key = document ? statisticsKeyFor(document.id) : "";
  const cached = document ? statisticsCache.get(document.id) : undefined;
  const pending = !cached || cached.key !== key;
  updateStatusbar({
    path: document?.path ?? null,
    dirty: document?.dirty ?? false,
    line: pos.lineNumber,
    column: pos.column,
    syntax: document ? manager.syntaxFor(document.id) : null,
    encoding: document?.encoding ?? "UTF-8",
    lineEnding: document?.formatProtection === "mixed"
      ? "MIXED"
      : document?.lineEnding ?? "LF",
    saveState: document?.saveState ?? "idle",
    lineCount: model?.getLineCount() ?? 1,
    characterCount: pending ? null : cached!.characterCount,
    characterKind: segmenter ? "graphemes" : "codePoints",
    cursorOffset: model?.getOffsetAt(pos) ?? 0,
    byteSize: pending ? null : cached!.byteSize,
    readOnlyReason: document?.formatProtection
      ? t(document.formatProtection === "mixed"
        ? "format.mixedReadOnly" : "format.unsupportedReadOnly")
      : null,
    onNormalize: document?.formatProtection === "mixed"
      ? () => { void normalizeActiveLineEndings(); }
      : undefined,
    onEncodingReopen: reopenEncodingHandler,
    onEncodingSave: saveEncodingHandler,
    encodingEnabled: !!document,
  });
}

function updateTitle(): void {
  const active = manager?.active;
  const name = active?.path ? baseName(active.path) : t("status.untitled");
  const marker = active?.dirty ? " ·" : "";
  const title = `${name}${marker} - ${t("title.app")}`;
  if (document.title === title) return;
  document.title = title;
  if (isWails()) WailsRuntime.WindowSetTitle(title);
}

function baseName(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/* --------------------------------- menus ---------------------------------- */

function buildFileItems(): MenuItem[] {
  const items: MenuItem[] = [
    { id: "new", label: t("file.new"), shortcut: "Ctrl+N", run: onNew },
    { id: "open", label: t("file.open"), shortcut: "Ctrl+O", run: () => { void onOpen(); } },
    {
      id: "openWithEncoding",
      label: t("file.openWithEncoding"),
      submenu: OPEN_WITH_ENCODINGS.map((encoding) => ({
        id: `openEncoding-${encoding}`,
        label: encoding,
        run: () => { void openWithEncoding(encoding); },
      })),
    },
    { id: "save", label: t("file.save"), shortcut: "Ctrl+S", run: () => { void onSave(); } },
    { id: "saveAs", label: t("file.saveAs"), shortcut: "Ctrl+Shift+S", run: () => { void onSaveAs(); } },
    { id: "closeTab", label: t("file.closeTab"), shortcut: "Ctrl+W", run: () => { void closeActiveTab(); } },
    { sep: true },
    {
      id: "autoSave",
      label: t("file.autoSave"),
      checked: currentSettings?.autoSave === true,
      run: () => {
        // saveSettings persists immediately and notifies the live gate.
        saveSettings({ autoSave: !loadSettings().autoSave });
      },
    },
    { sep: true },
    { label: t("file.openRecent"), disabled: true },
  ];
  const recent = listRecentFiles();
  if (recent.length === 0) {
    items.push({ label: t("file.noRecent"), disabled: true });
  } else {
    recent.forEach((path, index) => {
      items.push({
        id: `recent-${index}`,
        label: path,
        run: () => openRecent(path),
      });
    });
  }
  return items;
}

/**
 * Build the Edit menu. It is rebuilt on open so "Preview Replace All" can
 * reflect whether the results list currently holds matches.
 */
function buildEditItems(): MenuItem[] {
  return [
    { label: t("edit.undo"), run: () => getEditor()?.trigger("menu", "undo", null), shortcut: "Ctrl+Z" },
    { label: t("edit.redo"), run: () => getEditor()?.trigger("menu", "redo", null), shortcut: "Ctrl+Y" },
    { sep: true },
    { label: t("edit.cut"), monacoAction: "editor.action.clipboardCutAction", shortcut: "Ctrl+X" },
    { label: t("edit.copy"), monacoAction: "editor.action.clipboardCopyAction", shortcut: "Ctrl+C" },
    { label: t("edit.paste"), monacoAction: "editor.action.clipboardPasteAction", shortcut: "Ctrl+V" },
    { sep: true },
    { label: t("edit.selectAll"), monacoAction: "editor.action.selectAll", shortcut: "Ctrl+A" },
    { label: t("edit.find"), run: () => findInEditor(), shortcut: "Ctrl+F" },
    { label: t("edit.findAll"), run: findInDocumentAll, shortcut: "Ctrl+Shift+F" },
    { label: t("edit.replace"), run: () => findInEditor(true), shortcut: "Ctrl+H" },
    {
      id: "findReplacePreview",
      label: t("edit.replaceAllPreview"),
      disabled: (findResults?.matchCount() ?? 0) === 0,
      run: previewReplaceAll,
    },
    { label: t("edit.multipleReplace"), run: openMultipleReplacePanel, shortcut: "Ctrl+Shift+H" },
  ];
}

/**
 * Build the top-level menu bar. File is rebuilt on every open so the recent
 * list always reflects the current MRU entries.
 */
function buildMenuBar(): MenuBar {
  return [
    {
      label: t("menu.file"),
      items: [],
      buildItems: buildFileItems,
    },
    {
      label: t("menu.edit"),
      items: [],
      buildItems: buildEditItems,
    },
    {
      label: t("menu.view"),
      items: [],
      buildItems: (): MenuItem[] => [
        {
          label: t("view.lineNumbers"),
          checked: getEditor()?.getOption(monaco.editor.EditorOption.lineNumbers).renderType !== monaco.editor.RenderLineNumbersType.Off,
          run: () => {
            const ed = getEditor();
            if (!ed) return;
            const off = ed.getOption(monaco.editor.EditorOption.lineNumbers).renderType === monaco.editor.RenderLineNumbersType.Off;
            // Persisted through settings; the subscription applies it back to
            // every editor instance through applyEditorSettings.
            saveSettings({ lineNumbers: off });
          },
        },
        {
          label: t("view.renderWhitespace"),
          checked: getEditor()?.getOption(monaco.editor.EditorOption.renderWhitespace) === "all",
          run: () => {
            const ed = getEditor();
            if (!ed) return;
            const raw = ed.getOption(monaco.editor.EditorOption.renderWhitespace);
            saveSettings({ renderWhitespace: raw === "all" ? "selection" : "all" });
          },
        },
        {
          label: t("view.wordWrap"),
          checked: getEditor()?.getOption(monaco.editor.EditorOption.wordWrap) !== "off",
          run: () => {
            const ed = getEditor();
            if (!ed) return;
            const wrapped = ed.getOption(monaco.editor.EditorOption.wordWrap) !== "off";
            saveSettings({ wordWrap: wrapped ? "off" : "on" });
          },
        },
        { sep: true },
        {
          label: t("view.togglePreview"),
          shortcut: "Ctrl+E",
          disabled: manager?.activeSyntax() !== "Markdown",
          checked: manager?.activeSyntax() === "Markdown" && viewMode === "preview",
          run: () => setViewMode(viewMode === "preview" ? "edit" : "preview"),
        },
        {
          label: t("view.toggleSplit"),
          shortcut: "Ctrl+Shift+E",
          disabled: manager?.activeSyntax() !== "Markdown",
          checked: manager?.activeSyntax() === "Markdown" && viewMode === "split",
          run: () => setViewMode(viewMode === "split" ? "edit" : "split"),
        },
        {
          label: t("view.toggleOutline"),
          shortcut: "Ctrl+Shift+O",
          disabled: manager?.activeSyntax() !== "Markdown",
          checked: currentSettings?.showOutline === true,
          run: () => toggleOutline(),
        },
        { sep: true },
        {
          id: "viewAutoSave",
          label: t("file.autoSave"),
          checked: currentSettings?.autoSave === true,
          run: () => {
            saveSettings({ autoSave: !loadSettings().autoSave });
          },
        },
        { label: t("view.zoomIn"), shortcut: "Ctrl++", run: () => adjustFontSize(1) },
        { label: t("view.zoomOut"), shortcut: "Ctrl+-", run: () => adjustFontSize(-1) },
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
        { label: t("snippet.insert") + " 1", run: () => insertSnippetByIndex(0), shortcut: "Ctrl+Alt+1" },
        { label: t("snippet.insert") + " 2", run: () => insertSnippetByIndex(1), shortcut: "Ctrl+Alt+2" },
        { label: t("snippet.insert") + " 3", run: () => insertSnippetByIndex(2), shortcut: "Ctrl+Alt+3" },
      ],
    },
    {
      label: t("menu.theme"),
      items: [],
      buildItems: () =>
        listThemes().map((name) => ({
          id: `theme-${name}`,
          label: name,
          checked: name === getCurrentTheme(),
          run: () => {
            applyTheme(name);
            rerenderPreview();
          },
        })),
    },
    {
      label: t("menu.language"),
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
        { label: t("help.about"), run: () => alert(t("about.body")) },
        { label: t("help.shortcuts"), run: showShortcuts },
      ],
    },
  ];
}

function insertSnippetByIndex(i: number): void {
  import("./ui/snippet-manager").then(({ getSnippets, insertSnippetById }) => {
    const list = getSnippets();
    if (i < list.length) insertSnippetById(list[i].id);
  });
}

function showShortcuts(): void {
  alert(
    [
      t("sc.title"),
      "",
      t("sc.file"),
      t("sc.edit"),
      t("sc.multi"),
      t("sc.tabs"),
      t("sc.preview"),
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

/* ---------------------------- native window events ------------------------- */

function registerNativeEvents(): void {
  if (!isWails()) return;
  WailsRuntime.EventsOn("app:open-path", (path: unknown) => {
    if (typeof path !== "string" || path === "") return;
    void manager.openPath(path).then((opened) => { if (opened) getEditor()?.focus(); });
  });
  WailsRuntime.EventsOn("app:open-paths", (paths: unknown) => {
    if (!Array.isArray(paths)) return;
    void openExternalPaths(paths.filter((path): path is string => typeof path === "string"));
  });
  WailsRuntime.EventsOn("app:request-close", () => { void handleRequestClose(); });
}

/**
 * Native file drop (Wails only, bound once).
 *
 * The Go side already forwards drops as `app:open-paths`; the runtime callback
 * is registered as well because Wails builds may deliver either path. Both
 * funnel into openExternalPaths(), which collapses duplicate deliveries of the
 * same path. The DOM listeners only add the drop-target affordance and a
 * best-effort fallback for hosts that expose File.path; ordinary HTML5 drags
 * (tabs use pointer events) are never intercepted.
 */
function registerFileDrop(): void {
  if (fileDropBound || !isWails()) return;
  fileDropBound = true;

  const runtime = WailsRuntime as unknown as {
    OnFileDrop?: (
      callback: (x: number, y: number, paths: string[]) => void,
      useDropTarget?: boolean,
    ) => void;
  };
  if (typeof runtime.OnFileDrop === "function") {
    try {
      runtime.OnFileDrop((_x, _y, paths) => {
        if (!Array.isArray(paths)) return;
        const files = paths.filter(
          (path): path is string => typeof path === "string" && path !== "",
        );
        if (files.length > 0) void openExternalPaths(files);
      }, false);
    } catch (error) {
      console.warn("native file drop is unavailable:", error);
    }
  }

  const app = document.getElementById("app");
  if (!app) return;
  let depth = 0;
  const hasFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const clear = (): void => {
    depth = 0;
    app.classList.remove("ce-file-drop-target");
  };

  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    depth += 1;
    app.classList.add("ce-file-drop-target");
  });
  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    // Only file drags are claimed; internal pointer-based drags are untouched.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) clear();
  });
  window.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    clear();
    const paths: string[] = [];
    for (const file of Array.from(event.dataTransfer?.files ?? [])) {
      const path = (file as File & { path?: string }).path;
      if (typeof path === "string" && path !== "") paths.push(path);
    }
    if (paths.length > 0) void openExternalPaths(paths);
  });
}

async function openExternalPaths(paths: string[]): Promise<void> {
  for (const path of paths) {
    if (path === "" || openingPaths.has(path)) continue;
    openingPaths.add(path);
    try {
      await manager.openPath(path);
    } finally {
      openingPaths.delete(path);
    }
  }
  getEditor()?.focus();
}

/**
 * beforeClose cancels the native close while the session is dirty and emits
 * app:request-close. Resolve every dirty tab here, then quit explicitly.
 */
async function handleRequestClose(): Promise<void> {
  if (closingForQuit) return;
  closingForQuit = true;
  autoSaver.cancelAll();
  try {
    // Persist the newest drafts before asking about saves: a crash during the
    // close flow must still leave a recoverable copy of every dirty buffer.
    await recovery.flush();
    const names = manager.dirtyNames();
    if (names.length > 0) {
      const decision = await confirmCloseSession(names);
      if (decision === "cancel") return;
      if (decision === "save") {
        await recovery.flush();
        if (!(await manager.saveAllDirty())) return;
        if (manager.anyDirty()) return;
      } else {
        await recovery.discardAll();
      }
    } else {
      await recovery.discardAll();
    }
    // runtime.Quit runs OnBeforeClose again. Clear the guard first so a
    // discard path is not vetoed by the sessionDirty flag it just resolved.
    await setSessionDirty(false);
    WailsRuntime.Quit();
  } finally {
    closingForQuit = false;
  }
}

// Keep the scaffold's highlighting seam referenced (theme refresh is a no-op
// until a theme switch asks for it).
void refreshRegexTokens;

bootstrap().catch((err) => {
  console.error("Failed to bootstrap CotEditor-win:", err);
});
