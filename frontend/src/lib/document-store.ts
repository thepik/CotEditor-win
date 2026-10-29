/**
 * Document storage for a single Monaco editor hosting multiple models.
 *
 * One `DocumentStore` owns the editor's documents: each `create(seed)` builds a
 * dedicated `ITextModel` (hence its own undo stack, decorations and folded
 * ranges), and `activate(id)` swaps it into the editor while saving/restoring
 * the per-document view state (cursor, selection, scroll). Switching never
 * recreates text models, so undo history and scroll position survive.
 *
 * Out of scope by design:
 *  - no file IO (open/save/stat/watch) and no autosave policy;
 *  - no UI updates, dialogs, toasts or cross-window notifications;
 *  - no dirty/format inference from Monaco events. Callers drive
 *    `reconcileDirty(id)` from their own model-content listener (the same
 *    listener that updates chrome), and update `savedAlternativeVersion` /
 *    `savedFormatVersion` on the live state object after a confirmed write.
 *
 * The store also does not decide what happens after the active document is
 * removed: `remove(id)` detaches it from the editor and disposes the model, and
 * the caller chooses the next document to `activate`.
 *
 * Language selection reuses the existing path -> CotEditor syntax map, but not
 * `language-config.ts`'s `setModelLanguageByPath()`: that helper writes to the
 * module-level single model owned by `monaco-setup` (`getModel()`), which is by
 * definition not every model in the store. The store applies the same mapping
 * to its own model via the public `monaco.editor.setModelLanguage`. Wiring
 * note for main.ts: once documents live in the store, either let the store own
 * path language entirely, or extend `setModelLanguageByPath` to take a model.
 */

import { monaco } from "../editor/monaco-setup";
import { monacoIdForSyntax } from "../editor/language-config";
import { detectSyntaxByPath } from "./syntax-map";

export type DocumentLineEnding = "LF" | "CRLF" | "CR";
export type DocumentSaveState = "idle" | "unsaved" | "saving" | "saved" | "error";
export type FormatProtection = "mixed" | "encoding" | null;

/** Everything needed to build a document model from already-decoded file data. */
export interface DocumentSeed {
  /** On-disk path, or null for an untitled buffer. Drives the Monaco language. */
  path: string | null;
  /**
   * Decoded file text. A leading U+FEFF is stripped before it reaches Monaco
   * (Monaco must never hold a BOM in the buffer) and is folded into `hasBOM`.
   */
  content: string;
  encoding: string;
  lineEnding: DocumentLineEnding;
  mixed: boolean;
  hasBOM: boolean;
  protectedOriginal: string | null;
  formatProtection: FormatProtection;
}

/**
 * Mutable record for one document. `get()` / `getActive()` return the live
 * record, not a copy: after a successful save the caller updates
 * `savedAlternativeVersion` / `savedFormatVersion` and calls `reconcileDirty`.
 */
export interface DocumentState {
  readonly id: string;
  path: string | null;
  readonly model: monaco.editor.ITextModel;
  encoding: string;
  lineEnding: DocumentLineEnding;
  mixed: boolean;
  hasBOM: boolean;
  protectedOriginal: string | null;
  formatProtection: FormatProtection;
  /** Model alternative version captured at the last save/open baseline. */
  savedAlternativeVersion: number;
  /** `formatVersion` captured at the last save/open baseline. */
  savedFormatVersion: number;
  /** Bumped by explicit formatting changes (e.g. EOL normalization). */
  formatVersion: number;
  dirty: boolean;
  saveState: DocumentSaveState;
  /** External-write conflict flag; owned by the conflict-detection layer. */
  conflict: boolean;
  /** Draft-recovery slot identifier once the recovery layer assigns one. */
  recoveryId: string;
  /** Last known editor view state for this document (cursor/selection/scroll). */
  viewState: monaco.editor.ICodeEditorViewState | null;
  /** Untitled/scratch buffer that may be discarded without prompting. */
  volatile?: boolean;
}

/** Metadata that `updateMeta` may change after creation. */
export type DocumentMetaPatch = Partial<
  Pick<
    DocumentState,
    "encoding" | "hasBOM" | "lineEnding" | "formatVersion" | "conflict" | "recoveryId"
  >
>;

const BOM = "\uFEFF";

/** Unique model URIs across every store instance in the page. */
let modelSerial = 0;

/**
 * Resolve the Monaco language id for a path, reusing the existing syntax map.
 * `null` (untitled) and unknown paths fall back to plaintext.
 */
function languageIdForPath(path: string | null): string {
  if (!path) return "plaintext";
  const syntax = detectSyntaxByPath(path);
  return (syntax && monacoIdForSyntax(syntax)) || "plaintext";
}

/** Monaco model EOL for a file-level line ending. Lone CR is stored as LF. */
function modelEolFor(lineEnding: DocumentLineEnding): monaco.editor.EndOfLineSequence {
  return lineEnding === "CRLF"
    ? monaco.editor.EndOfLineSequence.CRLF
    : monaco.editor.EndOfLineSequence.LF;
}

export class DocumentStore {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private readonly documents = new Map<string, DocumentState>();
  private activeId: string | null = null;
  private nextId = 1;
  private disposed = false;

  constructor(editor: monaco.editor.IStandaloneCodeEditor) {
    this.editor = editor;
  }

  /**
   * Build a model + record. The first document in the store is activated
   * immediately so it captures an initial view state; later documents stay in
   * the background until `activate(id)` is called.
   */
  create(seed: DocumentSeed): DocumentState {
    this.assertUsable("create");
    const id = `doc-${this.nextId++}`;
    const hasBOM = seed.hasBOM || seed.content.startsWith(BOM);
    const text = seed.content.startsWith(BOM) ? seed.content.slice(1) : seed.content;
    const uri = monaco.Uri.parse(`inmemory://document-store/${++modelSerial}`);
    const model = monaco.editor.createModel(text, languageIdForPath(seed.path), uri);

    // Set the buffer EOL before capturing the baseline: `setEOL` bumps the
    // alternative version, so capturing first would make a fresh document
    // look dirty. Lone CR cannot be represented by Monaco's buffer; it stays
    // file metadata and is re-applied by the writer on save.
    const eol = modelEolFor(seed.lineEnding);
    if (model.getEOL() !== (eol === monaco.editor.EndOfLineSequence.CRLF ? "\r\n" : "\n")) {
      model.setEOL(eol);
    }

    const document: DocumentState = {
      id,
      path: seed.path,
      model,
      encoding: seed.encoding,
      lineEnding: seed.lineEnding,
      mixed: seed.mixed,
      hasBOM,
      protectedOriginal: seed.protectedOriginal,
      formatProtection: seed.formatProtection,
      savedAlternativeVersion: model.getAlternativeVersionId(),
      savedFormatVersion: 0,
      formatVersion: 0,
      dirty: false,
      saveState: seed.path ? "saved" : "idle",
      conflict: false,
      recoveryId: "",
      viewState: null,
      volatile: false,
    };
    this.documents.set(id, document);

    if (this.activeId === null) this.activate(id);
    return document;
  }

  /**
   * Make `id` the editor's model. Saves the outgoing document's view state,
   * restores the incoming one, and re-applies its path-derived language.
   */
  activate(id: string): boolean {
    if (this.disposed) return false;
    const document = this.documents.get(id);
    if (!document || document.model.isDisposed()) return false;

    if (this.activeId === id) {
      // Keep the saved view state fresh if the caller asks for the active doc.
      document.viewState = this.editor.saveViewState();
      return true;
    }

    if (this.activeId !== null) {
      const current = this.documents.get(this.activeId);
      if (current && !current.model.isDisposed()) {
        current.viewState = this.editor.saveViewState();
      }
    }

    this.editor.setModel(document.model);
    monaco.editor.setModelLanguage(document.model, languageIdForPath(document.path));
    if (document.viewState) this.editor.restoreViewState(document.viewState);
    this.activeId = id;
    // Capture the state even for a first activation (no prior view state), so
    // every active document has a restorable cursor/scroll snapshot.
    document.viewState = this.editor.saveViewState();
    return true;
  }

  /**
   * Detach and dispose a document. When it was active the editor is left with
   * no model (`getActive()` becomes null); the caller decides what to open next.
   */
  remove(id: string): boolean {
    if (this.disposed) return false;
    const document = this.documents.get(id);
    if (!document) return false;

    this.documents.delete(id);
    if (this.activeId === id) {
      this.activeId = null;
      if (this.editor.getModel() === document.model) this.editor.setModel(null);
    }
    document.viewState = null;
    if (!document.model.isDisposed()) document.model.dispose();
    return true;
  }

  /** Snapshot of the documents in creation order. */
  list(): readonly DocumentState[] {
    return Array.from(this.documents.values());
  }

  get(id: string): DocumentState | null {
    return this.documents.get(id) ?? null;
  }

  getActive(): DocumentState | null {
    if (this.activeId === null) return null;
    return this.documents.get(this.activeId) ?? null;
  }

  /**
   * Update post-open metadata. Changing `lineEnding` also updates the model's
   * EOL sequence (lone CR -> LF); this bumps the alternative version, so the
   * caller is expected to `reconcileDirty` afterwards.
   */
  updateMeta(id: string, patch: DocumentMetaPatch): boolean {
    if (this.disposed) return false;
    const document = this.documents.get(id);
    if (!document || document.model.isDisposed()) return false;

    if (patch.encoding !== undefined) document.encoding = patch.encoding;
    if (patch.hasBOM !== undefined) document.hasBOM = patch.hasBOM;
    if (patch.conflict !== undefined) document.conflict = patch.conflict;
    if (patch.recoveryId !== undefined) document.recoveryId = patch.recoveryId;
    if (patch.formatVersion !== undefined) document.formatVersion = patch.formatVersion;

    if (patch.lineEnding !== undefined) {
      document.lineEnding = patch.lineEnding;
      const eol = modelEolFor(patch.lineEnding);
      const current = document.model.getEOL();
      const target = eol === monaco.editor.EndOfLineSequence.CRLF ? "\r\n" : "\n";
      if (current !== target) document.model.setEOL(eol);
    }
    return true;
  }

  /**
   * Recompute `dirty` from the model's alternative version and the format
   * version. Returns the resulting dirty flag, or false for an unknown document.
   */
  reconcileDirty(id: string): boolean {
    const document = this.documents.get(id);
    if (!document || document.model.isDisposed()) return false;
    document.dirty =
      document.model.getAlternativeVersionId() !== document.savedAlternativeVersion ||
      document.formatVersion !== document.savedFormatVersion;
    return document.dirty;
  }

  /**
   * Store a per-document view state. If the document is active, it is applied
   * immediately (used after external state changes, e.g. restoring a session).
   */
  setViewState(
    id: string,
    viewState: monaco.editor.ICodeEditorViewState | null,
  ): boolean {
    if (this.disposed) return false;
    const document = this.documents.get(id);
    if (!document || document.model.isDisposed()) return false;
    document.viewState = viewState;
    if (this.activeId === id && viewState) this.editor.restoreViewState(viewState);
    return true;
  }

  /** Detach the active model and dispose every model owned by this store. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const document of this.documents.values()) {
      if (this.activeId === document.id && this.editor.getModel() === document.model) {
        this.editor.setModel(null);
      }
      document.viewState = null;
      if (!document.model.isDisposed()) document.model.dispose();
    }
    this.documents.clear();
    this.activeId = null;
  }

  private assertUsable(operation: string): void {
    if (this.disposed) {
      throw new Error(`DocumentStore is disposed; cannot ${operation}()`);
    }
  }
}
