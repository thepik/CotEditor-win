/**
 * Automatic recovery drafts (phase B).
 *
 * The Go side stores one JSON snapshot per document under the user's config
 * directory (`SaveRecovery` / `ListRecovery` / `LoadRecovery` /
 * `DiscardRecovery` / `ClearRecoveryPath`). This module owns the frontend
 * policy:
 *
 *  - assign one stable, filename-safe `recoveryId` per document;
 *  - debounce draft writes (default 1000 ms) and flush them on demand;
 *  - cancel pending writes when a document is closed without saving;
 *  - discard the draft after a successful save or an explicit close;
 *  - filter empty/corrupt entries returned at startup.
 *
 * Everything except the thin Wails adapter is dependency-free, so the
 * debounce scheduler can be driven by a fake clock in headless tests (see
 * `scripts/regression-b-dialogs.mjs`).
 *
 * Wiring notes for `main.ts` (phase F2):
 *  - `const recovery = new RecoveryService();`
 *  - on model content change: `ensureRecoveryId(document);
 *      recovery.schedule({ id: document.recoveryId, path: document.path,
 *        content: contentForDisk(document), encoding: document.encoding,
 *        lineEnding: document.lineEnding });`
 *  - after a successful save: `await recovery.completeSave(id, document.path);`
 *  - before closing a clean/discarded tab: `await recovery.discard(id);`
 *  - at startup: `const drafts = await recovery.list();` then show
 *    `openRecoveryDialog({ entries: drafts })` when non-empty.
 */

import * as WailsApp from "../wailsjs/go/main/App";

/** Same alphabet the backend accepts as a recovery file name. */
export const RECOVERY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Default debounce for draft writes: long enough to batch typing, short
 * enough that a crash loses little. */
export const DEFAULT_RECOVERY_DELAY_MS = 1000;

export type RecoveryLineEnding = "LF" | "CRLF" | "CR";

/** One draft snapshot to persist. `path` is empty for untitled buffers. */
export interface RecoveryDraft {
  id: string;
  path: string | null;
  content: string;
  encoding: string;
  lineEnding: string;
}

/** Normalized entry returned by `list()` / `load()`. */
export interface RecoveryEntry {
  id: string;
  /** Empty string for untitled drafts (matches the backend JSON shape). */
  path: string;
  content: string;
  encoding: string;
  lineEnding: RecoveryLineEnding;
  /** Milliseconds since the Unix epoch (backend nanoseconds converted). */
  updatedAt: number;
  /** Whether the original file still exists on disk. */
  exists: boolean;
}

/** Injectable native surface, so tests never touch the real recovery folder. */
export interface RecoveryApi {
  saveRecovery(
    id: string,
    path: string,
    content: string,
    encoding: string,
    lineEnding: string,
  ): Promise<void>;
  listRecovery(): Promise<unknown>;
  loadRecovery(id: string): Promise<unknown>;
  discardRecovery(id: string): Promise<void>;
  clearRecoveryPath(path: string): Promise<void>;
}

export interface RecoveryTimers {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const browserRecoveryTimers: RecoveryTimers = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const wailsRecoveryApi: RecoveryApi = {
  saveRecovery: (id, path, content, encoding, lineEnding) =>
    WailsApp.SaveRecovery(id, path, content, encoding, lineEnding),
  listRecovery: () => WailsApp.ListRecovery(),
  loadRecovery: (id) => WailsApp.LoadRecovery(id),
  discardRecovery: (id) => WailsApp.DiscardRecovery(id),
  clearRecoveryPath: (path) => WailsApp.ClearRecoveryPath(path),
};

/** True only inside the native window with all five bindings present. */
export function isRecoveryAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const go = (window as unknown as {
    go?: { main?: { App?: Record<string, unknown> } };
  }).go;
  const app = go?.main?.App;
  if (!app) return false;
  return (
    typeof app.SaveRecovery === "function"
    && typeof app.ListRecovery === "function"
    && typeof app.LoadRecovery === "function"
    && typeof app.DiscardRecovery === "function"
    && typeof app.ClearRecoveryPath === "function"
  );
}

export function isValidRecoveryId(value: unknown): value is string {
  return typeof value === "string" && RECOVERY_ID_PATTERN.test(value);
}

/**
 * Generate a recovery id that is safe as a file name. `crypto.randomUUID()` is
 * preferred; the fallback uses `getRandomValues`, then `Math.random`, and is
 * prefixed so it can never collide with a UUID-shaped id.
 */
export function createRecoveryId(): string {
  const cryptoObject = typeof crypto !== "undefined" ? crypto : undefined;
  if (cryptoObject?.randomUUID) {
    const uuid = cryptoObject.randomUUID();
    if (RECOVERY_ID_PATTERN.test(uuid)) return uuid;
    const cleaned = uuid.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    if (cleaned.length > 0) return cleaned;
  }
  const bytes = new Uint8Array(16);
  if (cryptoObject?.getRandomValues) {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  let suffix = "";
  for (const byte of bytes) suffix += byte.toString(16).padStart(2, "0");
  return `rec-${suffix}`;
}

/**
 * Reuse a document's existing id or assign a fresh one. Returns the id so
 * callers can pass it to `schedule()` without re-reading the document.
 */
export function ensureRecoveryId(target: { recoveryId: string }): string {
  if (isValidRecoveryId(target.recoveryId)) return target.recoveryId;
  const id = createRecoveryId();
  target.recoveryId = id;
  return id;
}

/** Normalize the backend's lower-case labels; unknown values become LF. */
export function normalizeRecoveryLineEnding(value: unknown): RecoveryLineEnding {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "crlf") return "CRLF";
  if (text === "cr") return "CR";
  return "LF";
}

/**
 * Backend timestamps are UnixNano. Older/hand-written fixtures may use
 * milliseconds; detect by magnitude so both round-trip sensibly.
 */
export function recoveryTimeToMillis(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  if (numeric >= 1e17) return Math.round(numeric / 1e6);
  if (numeric >= 1e14) return Math.round(numeric / 1e3);
  return Math.round(numeric);
}

function normalizePath(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hasControlContent(text: string): boolean {
  return text.includes("\u0000");
}

/**
 * Validate one backend entry. Corrupt JSON is already skipped by Go, but a
 * mocked or future backend can still return malformed objects; the UI must
 * never render those as restorable drafts.
 */
export function normalizeRecoveryEntry(raw: unknown): RecoveryEntry | null {
  let source = raw;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source) as unknown;
    } catch {
      return null;
    }
  }
  if (!source || typeof source !== "object") return null;
  const record = source as Record<string, unknown>;

  const id = record.id ?? record.ID;
  if (!isValidRecoveryId(id)) return null;
  const content = record.content ?? record.Content;
  if (typeof content !== "string") return null;
  if (content.trim().length === 0) return null;
  if (hasControlContent(content)) return null;

  const updatedAt = recoveryTimeToMillis(record.updated_at ?? record.updatedAt);
  if (updatedAt <= 0) return null;

  const encodingRaw = record.encoding ?? record.Encoding;
  const encoding = typeof encodingRaw === "string" && encodingRaw.trim().length > 0
    ? encodingRaw.trim()
    : "UTF-8";
  const lineEnding = normalizeRecoveryLineEnding(
    record.line_ending ?? record.lineEnding,
  );
  const exists = (record.exists ?? record.Exists) === true;

  return {
    id,
    path: normalizePath(record.path ?? record.Path),
    content,
    encoding,
    lineEnding,
    updatedAt,
    exists,
  };
}

/** Newest first, then id for a deterministic order. Corrupt entries dropped. */
export function normalizeRecoveryEntries(raw: unknown): RecoveryEntry[] {
  const source = Array.isArray(raw) ? raw : [];
  const entries: RecoveryEntry[] = [];
  for (const item of source) {
    const entry = normalizeRecoveryEntry(item);
    if (entry) entries.push(entry);
  }
  entries.sort((left, right) =>
    right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
  );
  return entries;
}

/** Windows-style path equality, matching the backend's comparison. */
export function sameRecoveryPath(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = (left ?? "").trim();
  const b = (right ?? "").trim();
  if (a === "" || b === "") return a === b;
  return a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
}

/**
 * Pure debounce state machine. It owns only timing and ordering; the payload
 * lives with the caller. `flush()` writes immediately, `cancel()` drops the
 * pending write. Errors from `onFlush` never wedge later writes.
 */
export class RecoveryScheduler {
  private readonly delayMs: number;
  private readonly onFlush: () => void | Promise<void>;
  private readonly timers: RecoveryTimers;
  private handle: unknown = null;
  private pendingFlag = false;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    delayMs: number,
    onFlush: () => void | Promise<void>,
    timers: RecoveryTimers = browserRecoveryTimers,
  ) {
    this.delayMs = Math.max(0, delayMs);
    this.onFlush = onFlush;
    this.timers = timers;
  }

  get pending(): boolean {
    return this.pendingFlag;
  }

  /** Start (or restart) the debounce window. */
  schedule(): void {
    if (this.disposed) return;
    this.pendingFlag = true;
    this.disarm();
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      this.runPending();
    }, this.delayMs);
  }

  /** Drop a pending write without flushing it. */
  cancel(): void {
    this.pendingFlag = false;
    this.disarm();
  }

  /** Write now and wait for the write started by this call. */
  async flush(): Promise<void> {
    this.disarm();
    while (this.pendingFlag) {
      this.pendingFlag = false;
      const run = this.chain.then(() => this.onFlush());
      this.chain = run.then(() => undefined, () => undefined);
      await run;
    }
    await this.chain;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  private runPending(): void {
    if (!this.pendingFlag) return;
    this.pendingFlag = false;
    const run = this.chain.then(() => this.onFlush());
    this.chain = run.then(() => undefined, () => undefined);
  }

  private disarm(): void {
    if (this.handle === null) return;
    this.timers.clearTimeout(this.handle);
    this.handle = null;
  }
}

export interface RecoveryServiceOptions {
  delayMs?: number;
  /** Native adapter override (tests / alternate hosts). */
  api?: RecoveryApi;
  timers?: RecoveryTimers;
}

/**
 * Per-document debounced draft writer. Writes for one id are serialized so a
 * slow save never lets an older snapshot overwrite a newer one.
 */
export class RecoveryService {
  readonly delayMs: number;
  readonly available: boolean;
  private readonly api: RecoveryApi;
  private readonly timers: RecoveryTimers;
  private readonly schedulers = new Map<string, RecoveryScheduler>();
  private readonly pending = new Map<string, RecoveryDraft>();
  private readonly queues = new Map<string, Promise<void>>();
  private disposed = false;
  private lastFailure: unknown = null;

  constructor(options: RecoveryServiceOptions = {}) {
    this.delayMs = Math.max(0, options.delayMs ?? DEFAULT_RECOVERY_DELAY_MS);
    this.api = options.api ?? wailsRecoveryApi;
    this.available = options.api !== undefined || isRecoveryAvailable();
    this.timers = options.timers ?? browserRecoveryTimers;
  }

  /** Last native failure (for diagnostics); operations never throw. */
  get lastError(): unknown {
    return this.lastFailure;
  }

  /**
   * Queue the newest snapshot for `draft.id`. Repeated calls within the delay
   * replace the previous snapshot (debounce). Empty content cancels instead of
   * writing an unusable draft.
   */
  schedule(draft: RecoveryDraft): void {
    if (this.disposed || !this.available) return;
    const id = isValidRecoveryId(draft.id) ? draft.id : createRecoveryId();
    if (draft.id !== id) draft.id = id;
    if (draft.content.length === 0) {
      this.cancel(id);
      return;
    }
    this.pending.set(id, {
      id,
      path: draft.path,
      content: draft.content,
      encoding: draft.encoding || "UTF-8",
      lineEnding: normalizeRecoveryLineEnding(draft.lineEnding),
    });
    this.schedulerFor(id).schedule();
  }

  /** Convenience: queue and write immediately. */
  async saveNow(draft: RecoveryDraft): Promise<void> {
    this.schedule(draft);
    await this.flush(draft.id);
  }

  /** Drop one pending write (e.g. the tab is being closed without saving). */
  cancel(id: string): void {
    this.pending.delete(id);
    const scheduler = this.schedulers.get(id);
    if (scheduler) {
      scheduler.cancel();
      scheduler.dispose();
      this.schedulers.delete(id);
    }
  }

  cancelAll(): void {
    for (const id of [...this.schedulers.keys()]) this.cancel(id);
    this.pending.clear();
  }

  /**
   * Write pending drafts now. With an id, waits for that document's write
   * queue; without, drains every scheduled document.
   */
  async flush(id?: string): Promise<void> {
    if (this.disposed) return;
    if (id !== undefined) {
      await this.flushOne(id);
      return;
    }
    const ids = new Set<string>([
      ...this.schedulers.keys(),
      ...this.pending.keys(),
      ...this.queues.keys(),
    ]);
    await Promise.all([...ids].map((key) => this.flushOne(key)));
    await Promise.all([...this.queues.values()]);
  }

  /** Startup restore list: malformed and empty drafts are hidden. */
  async list(): Promise<RecoveryEntry[]> {
    if (!this.available || this.disposed) return [];
    try {
      return normalizeRecoveryEntries(await this.api.listRecovery());
    } catch (error) {
      this.lastFailure = error;
      console.warn("recovery: failed to list drafts", error);
      return [];
    }
  }

  /** Load one draft; returns null when it is gone, expired or corrupt. */
  async load(id: string): Promise<RecoveryEntry | null> {
    if (!this.available || this.disposed || !isValidRecoveryId(id)) return null;
    try {
      return normalizeRecoveryEntry(await this.api.loadRecovery(id));
    } catch (error) {
      this.lastFailure = error;
      console.warn("recovery: failed to load draft", id, error);
      return null;
    }
  }

  /** Discard one draft after it was restored or abandoned. */
  async discard(id: string): Promise<boolean> {
    if (!this.available || this.disposed || !isValidRecoveryId(id)) return false;
    this.cancel(id);
    await this.queues.get(id);
    try {
      await this.api.discardRecovery(id);
      return true;
    } catch (error) {
      this.lastFailure = error;
      console.warn("recovery: failed to discard draft", id, error);
      return false;
    }
  }

  /** Remove every draft that belongs to a path (untitled uses ""). */
  async discardPath(path: string | null): Promise<boolean> {
    if (!this.available || this.disposed) return false;
    for (const [id, draft] of [...this.pending]) {
      if (sameRecoveryPath(draft.path, path)) this.cancel(id);
    }
    try {
      await this.api.clearRecoveryPath(path ?? "");
      return true;
    } catch (error) {
      this.lastFailure = error;
      console.warn("recovery: failed to clear drafts for path", path, error);
      return false;
    }
  }

  /** Discard every visible draft (the dialog's "Discard All"). */
  async discardAll(): Promise<number> {
    if (!this.available || this.disposed) return 0;
    const entries = await this.list();
    let discarded = 0;
    for (const entry of entries) {
      if (await this.discard(entry.id)) discarded += 1;
    }
    this.cancelAll();
    return discarded;
  }

  /**
   * The document was written to disk successfully: drop its draft and any
   * stale drafts recorded for the same path. Pending debounce writes are
   * cancelled first so they cannot resurrect the entry.
   */
  async completeSave(id: string, path?: string | null): Promise<void> {
    if (!this.available || this.disposed) return;
    this.cancel(id);
    await this.queues.get(id);
    try {
      await this.api.discardRecovery(id);
    } catch (error) {
      this.lastFailure = error;
      console.warn("recovery: failed to discard draft after save", id, error);
    }
    if (path) {
      try {
        await this.api.clearRecoveryPath(path);
      } catch (error) {
        this.lastFailure = error;
        console.warn("recovery: failed to clear drafts for saved path", path, error);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
    this.schedulers.clear();
    this.queues.clear();
  }

  private schedulerFor(id: string): RecoveryScheduler {
    let scheduler = this.schedulers.get(id);
    if (!scheduler) {
      scheduler = new RecoveryScheduler(
        this.delayMs,
        () => this.persist(id),
        this.timers,
      );
      this.schedulers.set(id, scheduler);
    }
    return scheduler;
  }

  private async flushOne(id: string): Promise<void> {
    const scheduler = this.schedulers.get(id);
    if (scheduler) await scheduler.flush();
    const queue = this.queues.get(id);
    if (queue) await queue;
  }

  /** Write the latest snapshot for an id through that id's serial queue. */
  private persist(id: string): Promise<void> {
    const draft = this.pending.get(id);
    if (!draft) return Promise.resolve();
    this.pending.delete(id);
    return this.enqueue(id, async () => {
      try {
        await this.api.saveRecovery(
          draft.id,
          draft.path ?? "",
          draft.content,
          draft.encoding,
          draft.lineEnding,
        );
      } catch (error) {
        this.lastFailure = error;
        console.warn("recovery: failed to save draft", id, error);
      }
    });
  }

  private enqueue(id: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const operation = previous.then(task, task);
    const settled = operation.then(() => undefined, () => undefined);
    this.queues.set(id, settled);
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id);
    });
    return operation;
  }
}
