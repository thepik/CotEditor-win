/**
 * Multi-document session manager for the phase-C tabbed shell.
 *
 * `DocumentStore` owns Monaco models and view states; this module owns the
 * application-level document list on top of it:
 *
 *  - per-document syntax overrides (the store only derives language from path);
 *  - open/reuse/new/close policy, including the pristine untitled placeholder;
 *  - per-document save transactions (encoding-aware, manual only this phase);
 *  - dirty confirmation before closing one tab or the whole window;
 *  - session-dirty aggregation for the native close guard.
 *
 * File IO is delegated to `lib/file-bridge`; the live chrome is notified through
 * the callbacks supplied by `main.ts`, which keeps this module headless-testable.
 */

import { monaco } from "../editor/monaco-setup";
import { monacoIdForSyntax } from "../editor/language-config";
import { detectSyntaxByPath } from "./syntax-map";
import {
  DocumentStore,
  type DocumentLineEnding,
  type DocumentSeed,
  type DocumentState,
  type DocumentSaveState,
  type FormatProtection,
} from "./document-store";
import { addRecentFile, normalizeRecentPath } from "./recent-files";
import { t } from "./i18n";
import { confirmUnsavedChanges } from "../ui/confirm-dialog";
import { showToast } from "../ui/notifications";
import {
  fileStamp,
  isFileConflict,
  openPath as openPathFromDisk,
  openPathWithEncoding,
  saveAsChecked,
  saveFileChecked,
  openFile,
  type FileContent,
  type FileStamp,
} from "./file-bridge";

export type SaveKind = "save" | "saveAs";

export interface DocumentManagerCallbacks {
  /** Documents were added, removed or reordered. */
  onStructureChange(): void;
  /** A different document became active. */
  onActiveChange(): void;
  /** One document's title/dirty/save state/metadata changed. */
  onDocumentChange(id: string): void;
  /** Any-document dirty flag changed (native close guard). */
  onSessionDirty(dirty: boolean): void;
  /** A checked save was refused because the disk changed externally. */
  onSaveConflict?(id: string): void;
  /** A write completed successfully; drafts for the document/path are stale. */
  onDocumentSaved?(id: string, path: string): void;
  /**
   * A tab was closed. `savedOnClose` is true when the close guard saved it
   * first (the save callback already cleared the draft); otherwise the caller
   * owns discarding the recovery draft.
   */
  onDocumentClosed?(id: string, recoveryId: string, savedOnClose: boolean): void;
}

/** One disk change that still has to be reloaded or resolved by the user. */
export interface ExternalChange {
  id: string;
  path: string;
  dirty: boolean;
  /** True when the file disappeared rather than changed. */
  deleted: boolean;
}

/** Payload needed to restore one recovery draft (subset of RecoveryEntry). */
export interface RecoveryRestoreInput {
  id: string;
  path: string;
  content: string;
  encoding: string;
  lineEnding: string;
  exists: boolean;
}

export interface DocumentTabItem {
  id: string;
  title: string;
  dirty: boolean;
  path: string | null;
}

export interface DocumentSnapshot {
  id: string;
  path: string | null;
  title: string;
  dirty: boolean;
  saveState: DocumentSaveState;
  encoding: string;
  lineEnding: DocumentLineEnding;
  mixed: boolean;
  formatProtection: FormatProtection;
  syntax: string | null;
  value: string;
  lineCount: number;
}

/** Encodings the phase-B backend can write losslessly. */
export const SUPPORTED_ENCODINGS = new Set([
  "UTF-8",
  "UTF-8 BOM",
  "UTF-16LE",
  "UTF-16BE",
  "GB18030",
]);

const EMPTY_SEED: DocumentSeed = {
  path: null,
  content: "",
  encoding: "UTF-8",
  lineEnding: "LF",
  mixed: false,
  hasBOM: false,
  protectedOriginal: null,
  formatProtection: null,
};

function canonicalEncoding(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (/^utf-?8$/i.test(value)) return "UTF-8";
  if (/^utf-?8\s*bom$/i.test(value)) return "UTF-8 BOM";
  if (/^utf-?16\s*le$/i.test(value)) return "UTF-16LE";
  if (/^utf-?16\s*be$/i.test(value)) return "UTF-16BE";
  if (/^gb18030$/i.test(value)) return "GB18030";
  return value || "UTF-8";
}

function normalizeLineEnding(raw: string | null | undefined): DocumentLineEnding {
  const value = (raw ?? "").toLowerCase();
  return value === "crlf" ? "CRLF" : value === "cr" ? "CR" : "LF";
}

function modelEolFor(lineEnding: DocumentLineEnding): monaco.editor.EndOfLineSequence {
  return lineEnding === "CRLF"
    ? monaco.editor.EndOfLineSequence.CRLF
    : monaco.editor.EndOfLineSequence.LF;
}

function hasEncodingBom(encoding: string): boolean {
  // BOM membership is an encoding label, never re-derived from buffer text.
  return encoding === "UTF-8 BOM" || encoding === "UTF-16LE" || encoding === "UTF-16BE";
}

/** Detect mixed endings from text; the backend flag wins when present. */
function hasMixedEndings(content: string): boolean {
  const endings = new Set(content.match(/\r\n|\r|\n/g) ?? []);
  return endings.size > 1;
}

/** Convert backend/browser file data into a DocumentStore seed. */
export function seedFromFileContent(result: FileContent): DocumentSeed {
  let content = result.content ?? "";
  let encoding = canonicalEncoding(result.encoding);
  if (content.startsWith("\uFEFF")) {
    content = content.slice(1);
    if (encoding === "UTF-8") encoding = "UTF-8 BOM";
  }

  const mixed = result.mixed_line_ending === true || hasMixedEndings(content);
  const unsupported = !SUPPORTED_ENCODINGS.has(encoding) || content.includes("\0");
  const formatProtection: FormatProtection = unsupported
    ? "encoding"
    : mixed ? "mixed" : null;

  return {
    path: result.path,
    content,
    encoding,
    lineEnding: normalizeLineEnding(result.line_ending),
    mixed,
    hasBOM: hasEncodingBom(encoding),
    protectedOriginal: formatProtection ? content : null,
    formatProtection,
  };
}

/** Model text converted to the document's on-disk line endings. BOM is added by Go. */
export function contentForDisk(document: DocumentState): string {
  const lf = document.model.getValue().replace(/\r\n|\r/g, "\n");
  if (document.lineEnding === "CRLF") return lf.replace(/\n/g, "\r\n");
  if (document.lineEnding === "CR") return lf.replace(/\n/g, "\r");
  return lf;
}

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function isCancel(error: unknown): boolean {
  if (error === "cancelled") return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return false;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export class DocumentManager {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private readonly store: DocumentStore;
  private readonly callbacks: DocumentManagerCallbacks;
  private order: string[] = [];
  private readonly syntaxOverrides = new Map<string, string | null>();
  private readonly saveInFlight = new Map<string, Promise<boolean>>();
  /** Last disk stamp captured after an open/save for each document. */
  private readonly baselines = new Map<string, FileStamp>();
  private suppressContentEvents = 0;
  private lastSessionDirty: boolean | null = null;

  constructor(
    editor: monaco.editor.IStandaloneCodeEditor,
    callbacks: DocumentManagerCallbacks,
  ) {
    this.editor = editor;
    this.callbacks = callbacks;
    this.store = new DocumentStore(editor);
    this.editor.onDidChangeModelContent(() => {
      if (this.suppressContentEvents > 0) return;
      const document = this.active;
      if (!document) return;
      this.store.reconcileDirty(document.id);
      if (document.saveState !== "saving") {
        document.saveState = document.dirty
          ? "unsaved"
          : document.path ? "saved" : "idle";
      }
      this.callbacks.onDocumentChange(document.id);
      this.syncSessionDirty();
    });
  }

  get active(): DocumentState | null {
    return this.store.getActive();
  }

  get activeId(): string | null {
    return this.store.getActive()?.id ?? null;
  }

  get busy(): boolean {
    return this.saveInFlight.size > 0;
  }

  isSaving(id?: string): boolean {
    return id ? this.saveInFlight.has(id) : this.saveInFlight.size > 0;
  }

  list(): readonly DocumentState[] {
    return this.order
      .map((id) => this.store.get(id))
      .filter((document): document is DocumentState => document !== null);
  }

  get(id: string): DocumentState | null {
    return this.store.get(id);
  }

  tabItems(): DocumentTabItem[] {
    return this.list().map((document) => this.tabItem(document.id)!);
  }

  tabItem(id: string): DocumentTabItem | null {
    const document = this.store.get(id);
    if (!document) return null;
    return {
      id,
      title: document.path ? baseName(document.path) : t("status.untitled"),
      dirty: document.dirty,
      path: document.path,
    };
  }

  snapshot(id: string): DocumentSnapshot | null {
    const document = this.store.get(id);
    if (!document) return null;
    return {
      id,
      path: document.path,
      title: document.path ? baseName(document.path) : t("status.untitled"),
      dirty: document.dirty,
      saveState: document.saveState,
      encoding: document.encoding,
      lineEnding: document.lineEnding,
      mixed: document.mixed,
      formatProtection: document.formatProtection,
      syntax: this.syntaxFor(id),
      value: document.model.getValue(),
      lineCount: document.model.getLineCount(),
    };
  }

  /** Effective CotEditor syntax name for a document (manual override wins). */
  syntaxFor(id: string): string | null {
    if (this.syntaxOverrides.has(id)) return this.syntaxOverrides.get(id) ?? null;
    const document = this.store.get(id);
    return document?.path ? detectSyntaxByPath(document.path) : null;
  }

  activeSyntax(): string | null {
    return this.active ? this.syntaxFor(this.active.id) : null;
  }

  setSyntax(id: string, syntax: string | null): boolean {
    const document = this.store.get(id);
    if (!document) return false;
    // Explicit null means "plain text", not "fall back to the path".
    this.syntaxOverrides.set(id, syntax);
    this.applyLanguage(document);
    this.callbacks.onDocumentChange(id);
    return true;
  }

  /**
   * Create a blank tab. A pristine untitled placeholder is reused instead of
   * stacking identical empty tabs.
   */
  createBlank(activate = true): DocumentState {
    const reusable = this.findReusableBlank();
    if (reusable) {
      if (activate) this.activate(reusable.id);
      return reusable;
    }
    const document = this.addDocument({ ...EMPTY_SEED }, activate, true);
    this.callbacks.onStructureChange();
    if (activate) this.callbacks.onActiveChange();
    this.syncSessionDirty();
    return document;
  }

  openContent(result: FileContent): DocumentState {
    const document = this.installSeed(seedFromFileContent(result));
    void this.captureBaseline(document.id);
    return document;
  }

  /** Shared open path for decoded files and restored drafts. */
  private installSeed(seed: DocumentSeed): DocumentState {
    if (seed.path) {
      const existing = this.findByPath(seed.path);
      if (existing) {
        addRecentFile(seed.path);
        this.activate(existing.id);
        return existing;
      }
    }

    const reusable = this.findReusableBlank();
    if (reusable) {
      this.resetDocument(reusable, seed);
      if (seed.path) addRecentFile(seed.path);
      this.activate(reusable.id);
      return reusable;
    }

    const document = this.addDocument(seed, true, false);
    this.callbacks.onStructureChange();
    this.callbacks.onActiveChange();
    this.syncSessionDirty();
    if (seed.path) addRecentFile(seed.path);
    return document;
  }

  async openFromPicker(): Promise<DocumentState | null> {
    try {
      const document = this.openContent(await openFile());
      await this.captureBaseline(document.id);
      return document;
    } catch (error) {
      if (!isCancel(error)) {
        console.error("open failed:", error);
        showToast(t("error.openFailed") + errorMessage(error), "error");
      }
      return null;
    }
  }

  /** Open an absolute path, or activate the already-open tab for it. */
  async openPath(path: string): Promise<DocumentState | null> {
    const existing = this.findByPath(path);
    if (existing) {
      addRecentFile(path);
      this.activate(existing.id);
      return existing;
    }
    try {
      const document = this.openContent(await openPathFromDisk(path));
      await this.captureBaseline(document.id);
      return document;
    } catch (error) {
      if (!isCancel(error)) {
        console.error("open failed:", error);
        showToast(t("error.openFailed") + errorMessage(error), "error");
      }
      return null;
    }
  }

  activate(id: string): boolean {
    if (!this.store.activate(id)) return false;
    const document = this.store.get(id);
    if (!document) return false;
    this.applyLanguage(document);
    this.editor.updateOptions({ readOnly: document.formatProtection !== null });
    this.callbacks.onActiveChange();
    return true;
  }

  activateIndex(index: number): boolean {
    if (index < 0 || index >= this.order.length) return false;
    this.activate(this.order[index]);
    return true;
  }

  cycle(delta: number): boolean {
    if (this.order.length < 2) return false;
    const current = this.activeId;
    const index = current ? this.order.indexOf(current) : -1;
    if (index < 0) return this.activate(this.order[0]);
    const next = (index + delta + this.order.length) % this.order.length;
    return this.activate(this.order[next]);
  }

  reorder(ids: string[]): void {
    const seen = new Set<string>();
    const next: string[] = [];
    for (const id of ids) {
      if (seen.has(id) || !this.store.get(id)) continue;
      seen.add(id);
      next.push(id);
    }
    for (const id of this.order) {
      if (!seen.has(id)) next.push(id);
    }
    this.order = next;
    this.callbacks.onStructureChange();
  }

  /**
   * Save one document. Content is snapshotted synchronously; edits typed while
   * the write is pending stay dirty and are never acknowledged by this save.
   */
  saveDocument(
    id: string,
    kind: SaveKind,
    options: { force?: boolean } = {},
  ): Promise<boolean> {
    const pending = this.saveInFlight.get(id);
    if (pending) return pending;

    const document = this.store.get(id);
    if (!document) return Promise.resolve(false);
    if (document.formatProtection) {
      showToast(t(document.formatProtection === "mixed"
        ? "format.mixedReadOnly" : "format.unsupportedReadOnly"), "error");
      return Promise.resolve(false);
    }
    if (kind === "save" && document.path && !document.dirty && !options.force) {
      return Promise.resolve(true);
    }

    document.model.pushStackElement();
    const snapshot = {
      id,
      path: document.path,
      alternativeVersion: document.model.getAlternativeVersionId(),
      formatVersion: document.formatVersion,
      content: contentForDisk(document),
      encoding: document.encoding,
      baseline: this.baselines.get(id) ?? null,
    };
    document.saveState = "saving";
    this.callbacks.onDocumentChange(id);
    this.syncSessionDirty();

    const operation = this.performSave(document, kind, snapshot);
    this.saveInFlight.set(id, operation);
    void operation.finally(() => {
      if (this.saveInFlight.get(id) === operation) this.saveInFlight.delete(id);
    });
    return operation;
  }

  saveActive(kind: SaveKind): Promise<boolean> {
    return this.active ? this.saveDocument(this.active.id, kind) : Promise.resolve(false);
  }

  async saveAllDirty(): Promise<boolean> {
    for (const id of [...this.order]) {
      const document = this.store.get(id);
      if (!document || !document.dirty) continue;
      const saved = await this.saveDocument(id, "save");
      if (!saved) return false;
      if (document.dirty) return false;
    }
    return !this.list().some((document) => document.dirty);
  }

  /** Last disk baseline captured for a document (null until captured). */
  baselineFor(id: string): FileStamp | null {
    return this.baselines.get(id) ?? null;
  }

  isConflict(id: string): boolean {
    return this.store.get(id)?.conflict === true;
  }

  /**
   * Save with a newly chosen encoding. The encoding label (not the buffer)
   * owns BOM membership, and a clean document is rewritten because the byte
   * representation itself changed.
   */
  saveWithEncoding(id: string, encoding: string): Promise<boolean> {
    const document = this.store.get(id);
    if (!document) return Promise.resolve(false);
    const canonical = canonicalEncoding(encoding);
    if (document.encoding !== canonical) {
      document.encoding = canonical;
      document.hasBOM = hasEncodingBom(canonical);
      this.store.updateMeta(id, { encoding: canonical, hasBOM: document.hasBOM });
      this.callbacks.onDocumentChange(id);
    }
    return this.saveDocument(id, document.path ? "save" : "saveAs", { force: true });
  }

  /**
   * Reinterpret the file on disk with `encoding`, replacing the buffer. The
   * caller is responsible for confirming that unsaved edits may be discarded.
   */
  reopenWithEncoding(id: string, encoding: string): Promise<boolean> {
    const document = this.store.get(id);
    if (!document || !document.path || this.saveInFlight.has(id)) {
      return Promise.resolve(false);
    }
    return this.reloadFromDisk(id, canonicalEncoding(encoding));
  }

  /**
   * Reload the document from disk and reset dirty/conflict state. Used for
   * clean external changes, a user's explicit reload, and encoding reopen.
   */
  async reloadFromDisk(id: string, encoding?: string): Promise<boolean> {
    const document = this.store.get(id);
    if (!document || !document.path || this.saveInFlight.has(id)) return false;
    const path = document.path;
    try {
      const result = await openPathWithEncoding(path, encoding ?? document.encoding);
      if (this.store.get(id) !== document || document.model.isDisposed()) return false;
      this.resetDocument(document, seedFromFileContent(result));
      document.conflict = false;
      await this.captureBaseline(id);
      this.callbacks.onDocumentChange(id);
      this.syncSessionDirty();
      return true;
    } catch (error) {
      if (!isCancel(error)) {
        console.error("reload failed:", error);
        showToast(t("error.openFailed") + errorMessage(error), "error");
      }
      return false;
    }
  }

  /**
   * Rebuild a document from a recovery draft. The draft is deliberately not
   * discarded here: until a successful save, it remains the only crash-safe
   * copy of the user's text.
   */
  async restoreRecovery(input: RecoveryRestoreInput): Promise<DocumentState | null> {
    const encoding = canonicalEncoding(input.encoding);
    const lineEnding = normalizeLineEnding(input.lineEnding);
    let seed: DocumentSeed;
    if (input.path && input.exists) {
      try {
        const result = await openPathWithEncoding(input.path, encoding);
        seed = seedFromFileContent(result);
        seed.content = input.content;
        seed.encoding = encoding;
        seed.lineEnding = lineEnding;
        seed.mixed = false;
        seed.hasBOM = hasEncodingBom(encoding);
        seed.formatProtection = null;
        seed.protectedOriginal = null;
      } catch (error) {
        console.warn("recovery: original file could not be reopened", input.path, error);
        seed = this.recoverySeed(input, encoding, lineEnding);
      }
    } else {
      seed = this.recoverySeed(input, encoding, lineEnding);
    }

    const document = this.installSeed(seed);
    document.recoveryId = input.id;
    // The on-disk text is the save baseline; the draft content is unsaved.
    // -1 can never equal a real alternative version, so dirty stays true even
    // after undoing back to the restored text's own edit point.
    document.savedAlternativeVersion = -1;
    document.savedFormatVersion = 0;
    document.formatVersion = 0;
    document.dirty = true;
    document.saveState = "unsaved";
    document.conflict = false;
    await this.captureBaseline(document.id);
    this.callbacks.onDocumentChange(document.id);
    this.syncSessionDirty();
    return document;
  }

  private recoverySeed(
    input: RecoveryRestoreInput,
    encoding: string,
    lineEnding: DocumentLineEnding,
  ): DocumentSeed {
    return {
      path: input.path || null,
      content: input.content,
      encoding,
      lineEnding,
      mixed: false,
      hasBOM: hasEncodingBom(encoding),
      protectedOriginal: null,
      formatProtection: null,
    };
  }

  /**
   * Compare every path-backed document against its baseline. The active
   * document is checked first so the visible tab reacts first. A document that
   * already has an unresolved conflict is skipped until the dialog resolves it.
   */
  async detectExternalChanges(): Promise<ExternalChange[]> {
    const active = this.activeId;
    const ordered = [...this.order].sort((left, right) => {
      if (left === active) return -1;
      if (right === active) return 1;
      return 0;
    });
    const changes: ExternalChange[] = [];
    for (const id of ordered) {
      const document = this.store.get(id);
      if (!document?.path || document.conflict || this.saveInFlight.has(id)) continue;
      const baseline = this.baselines.get(id);
      if (!baseline) {
        await this.captureBaseline(id);
        continue;
      }
      let current: FileStamp;
      try {
        current = await fileStamp(document.path);
      } catch (error) {
        console.warn("file stamp failed:", document.path, error);
        continue;
      }
      if (
        current.exists === baseline.exists
        && current.size === baseline.size
        && current.mod_time === baseline.mod_time
      ) {
        continue;
      }
      document.conflict = true;
      this.store.updateMeta(id, { conflict: true });
      this.callbacks.onDocumentChange(id);
      changes.push({
        id,
        path: document.path,
        dirty: document.dirty,
        deleted: baseline.exists && !current.exists,
      });
    }
    return changes;
  }

  /** Keep the editor text and accept the current disk version as new baseline. */
  async keepLocal(id: string): Promise<boolean> {
    const document = this.store.get(id);
    if (!document?.path) return false;
    try {
      this.baselines.set(id, await fileStamp(document.path));
    } catch (error) {
      console.warn("file stamp failed while keeping local changes:", error);
      this.baselines.delete(id);
    }
    document.conflict = false;
    this.store.updateMeta(id, { conflict: false });
    document.saveState = document.dirty ? "unsaved" : "saved";
    this.callbacks.onDocumentChange(id);
    this.syncSessionDirty();
    return true;
  }

  /**
   * Leave the conflict marker in place so polling stops and auto-save skips
   * the document until the user makes an explicit choice.
   */
  cancelConflict(id: string): void {
    const document = this.store.get(id);
    if (!document) return;
    document.conflict = true;
    this.store.updateMeta(id, { conflict: true });
    document.saveState = document.dirty ? "unsaved" : "saved";
    this.callbacks.onDocumentChange(id);
  }

  /**
   * Close one tab after the dirty guard. The last remaining tab is replaced by
   * a fresh blank placeholder instead of leaving the window model-less.
   */
  async closeDocument(id: string): Promise<boolean> {
    const pending = this.saveInFlight.get(id);
    if (pending) await pending;

    const document = this.store.get(id);
    if (!document) return false;

    let savedOnClose = false;
    if (document.dirty) {
      const decision = await confirmUnsavedChanges(this.displayName(document));
      if (decision === "cancel") return false;
      if (decision === "save") {
        const saved = await this.saveDocument(id, "save");
        if (!saved || document.dirty) return false;
        savedOnClose = true;
      }
    }

    const recoveryId = document.recoveryId;
    this.removeDocument(id);
    this.callbacks.onDocumentClosed?.(id, recoveryId, savedOnClose);
    return true;
  }

  closeActive(): Promise<boolean> {
    return this.active ? this.closeDocument(this.active.id) : Promise.resolve(false);
  }

  /** Names of documents with unsaved changes, in tab order. */
  dirtyNames(): string[] {
    return this.list()
      .filter((document) => document.dirty)
      .map((document) => this.displayName(document));
  }

  anyDirty(): boolean {
    return this.list().some(
      (document) => document.dirty || document.saveState === "saving",
    );
  }

  /**
   * Explicitly allow editing after the user accepts mixed-EOL conversion.
   * F2's encoding picker will reuse the same metadata transition.
   */
  normalizeLineEndings(id: string): boolean {
    const document = this.store.get(id);
    if (!document || document.formatProtection !== "mixed") return false;
    document.lineEnding = "LF";
    document.formatProtection = null;
    document.protectedOriginal = null;
    document.formatVersion += 1;
    this.store.updateMeta(id, {
      lineEnding: "LF",
      formatVersion: document.formatVersion,
    });
    this.store.reconcileDirty(id);
    document.saveState = "unsaved";
    if (this.activeId === id) this.editor.updateOptions({ readOnly: false });
    this.callbacks.onDocumentChange(id);
    this.syncSessionDirty();
    return true;
  }

  dispose(): void {
    this.order = [];
    this.syntaxOverrides.clear();
    this.saveInFlight.clear();
    this.baselines.clear();
    this.store.dispose();
  }

  private addDocument(
    seed: DocumentSeed,
    activate: boolean,
    volatile: boolean,
  ): DocumentState {
    const document = this.store.create(seed);
    document.volatile = volatile;
    this.order.push(document.id);
    if (activate) {
      this.store.activate(document.id);
      this.applyLanguage(document);
      this.editor.updateOptions({ readOnly: document.formatProtection !== null });
    }
    return document;
  }

  private removeDocument(id: string): void {
    const wasActive = this.activeId === id;
    const index = this.order.indexOf(id);
    if (index >= 0) this.order.splice(index, 1);
    this.syntaxOverrides.delete(id);
    this.baselines.delete(id);
    this.store.remove(id);

    if (this.order.length === 0) {
      this.addDocument({ ...EMPTY_SEED }, true, true);
      this.callbacks.onStructureChange();
      this.callbacks.onActiveChange();
    } else {
      this.callbacks.onStructureChange();
      if (wasActive) {
        this.activate(this.order[Math.min(index, this.order.length - 1)]);
      }
    }
    this.syncSessionDirty();
  }

  private resetDocument(document: DocumentState, seed: DocumentSeed): void {
    this.suppressContentEvents += 1;
    try {
      document.path = seed.path;
      document.encoding = seed.encoding;
      document.lineEnding = seed.lineEnding;
      document.mixed = seed.mixed;
      document.hasBOM = seed.hasBOM;
      document.protectedOriginal = seed.protectedOriginal;
      document.formatProtection = seed.formatProtection;
      document.formatVersion = 0;
      document.savedFormatVersion = 0;
      document.conflict = false;
      document.recoveryId = "";
      document.volatile = false;
      this.syntaxOverrides.delete(document.id);

      document.model.setValue(seed.content);
      const eol = modelEolFor(seed.lineEnding);
      const target = eol === monaco.editor.EndOfLineSequence.CRLF ? "\r\n" : "\n";
      if (document.model.getEOL() !== target) document.model.setEOL(eol);

      this.applyLanguage(document);
      document.savedAlternativeVersion = document.model.getAlternativeVersionId();
      document.dirty = false;
      document.saveState = seed.path ? "saved" : "idle";
    } finally {
      this.suppressContentEvents -= 1;
    }

    if (this.activeId === document.id) {
      this.editor.updateOptions({ readOnly: document.formatProtection !== null });
      this.editor.setPosition({ lineNumber: 1, column: 1 });
      this.editor.revealLine(1);
    }
    this.callbacks.onDocumentChange(document.id);
    this.syncSessionDirty();
  }

  private async performSave(
    document: DocumentState,
    kind: SaveKind,
    snapshot: {
      id: string;
      path: string | null;
      alternativeVersion: number;
      formatVersion: number;
      content: string;
      encoding: string;
      baseline: FileStamp | null;
    },
  ): Promise<boolean> {
    try {
      const savedTo = kind === "saveAs" || !snapshot.path
        ? await saveAsChecked(snapshot.content, snapshot.encoding)
        : await saveFileChecked(
          snapshot.path,
          snapshot.content,
          snapshot.encoding,
          snapshot.baseline,
        );

      if (this.store.get(snapshot.id) !== document || document.model.isDisposed()) {
        return false;
      }
      document.path = savedTo;
      document.conflict = false;
      document.hasBOM = hasEncodingBom(document.encoding);
      this.applyLanguage(document);
      document.savedAlternativeVersion = snapshot.alternativeVersion;
      document.savedFormatVersion = snapshot.formatVersion;
      this.store.updateMeta(snapshot.id, { conflict: false, hasBOM: document.hasBOM });
      this.store.reconcileDirty(snapshot.id);
      document.saveState = document.dirty ? "unsaved" : "saved";
      // Capture the new disk stamp before callbacks run: a poll triggered by
      // the callback must not mistake our own write for an external change.
      await this.captureBaseline(snapshot.id);
      addRecentFile(savedTo);
      this.callbacks.onDocumentChange(snapshot.id);
      this.syncSessionDirty();
      this.callbacks.onDocumentSaved?.(snapshot.id, savedTo);
      return true;
    } catch (error) {
      if (this.store.get(snapshot.id) !== document) return false;
      this.store.reconcileDirty(snapshot.id);
      if (isFileConflict(error)) {
        // Never overwrite the external version. Keep the local text and let the
        // conflict dialog decide between keep/reload/save-as/cancel.
        document.conflict = true;
        this.store.updateMeta(snapshot.id, { conflict: true });
        document.saveState = document.dirty ? "unsaved" : "saved";
        this.callbacks.onDocumentChange(snapshot.id);
        this.syncSessionDirty();
        this.callbacks.onSaveConflict?.(snapshot.id);
        return false;
      }
      document.saveState = isCancel(error)
        ? document.dirty ? "unsaved" : document.path ? "saved" : "idle"
        : "error";
      this.callbacks.onDocumentChange(snapshot.id);
      this.syncSessionDirty();
      if (!isCancel(error)) {
        console.error("save failed:", error);
        showToast(t("error.saveFailed") + errorMessage(error), "error");
      }
      return false;
    }
  }

  private async captureBaseline(id: string): Promise<FileStamp | null> {
    const document = this.store.get(id);
    if (!document?.path) {
      this.baselines.delete(id);
      return null;
    }
    try {
      const stamp = await fileStamp(document.path);
      this.baselines.set(id, stamp);
      return stamp;
    } catch (error) {
      this.baselines.delete(id);
      console.warn("file stamp failed:", document.path, error);
      return null;
    }
  }

  private applyLanguage(document: DocumentState): void {
    const syntax = this.syntaxFor(document.id);
    const languageId = syntax ? monacoIdForSyntax(syntax) ?? "plaintext" : "plaintext";
    monaco.editor.setModelLanguage(document.model, languageId);
  }

  private findReusableBlank(): DocumentState | null {
    const candidates = [
      this.active,
      ...this.list(),
    ].filter((document): document is DocumentState => document !== null);
    const seen = new Set<string>();
    for (const document of candidates) {
      if (seen.has(document.id)) continue;
      seen.add(document.id);
      if (
        document.path === null
        && !document.dirty
        && document.formatVersion === 0
        && !document.formatProtection
        && !this.syntaxOverrides.has(document.id)
        && document.model.getValue() === ""
      ) {
        return document;
      }
    }
    return null;
  }

  private findByPath(path: string): DocumentState | null {
    const key = normalizeRecentPath(path);
    if (!key) return null;
    return this.list().find(
      (document) =>
        document.path !== null && normalizeRecentPath(document.path) === key,
    ) ?? null;
  }

  private displayName(document: DocumentState): string {
    return document.path ? baseName(document.path) : t("status.untitled");
  }

  private syncSessionDirty(): void {
    const dirty = this.anyDirty();
    if (dirty === this.lastSessionDirty) return;
    this.lastSessionDirty = dirty;
    this.callbacks.onSessionDirty(dirty);
  }
}
