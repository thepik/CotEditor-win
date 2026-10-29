/**
 * Bounded full-document tree-sitter highlighting, parsed in a dedicated worker.
 *
 * Main thread: grammar registration, model/session bookkeeping, cheap limit
 * checks and result acceptance. Worker: WASM runtime, grammar/query
 * compilation, parsing, capture resolution and token packing.
 *
 * A request carries the model key + document version + language generation it
 * was produced for. Results for superseded requests are dropped; language
 * switches, model close, oversized documents and parse/query failures cancel
 * in-flight work and release the worker's parser/query (trees are always
 * per-request temporaries).
 *
 * Grammars themselves (WASM has no unload API) stay cached in the worker for
 * the lifetime of the worker; a worker crash/teardown terminates it and the
 * next request starts a fresh one.
 */
import type * as monaco from "monaco-editor";
import { monaco as monacoNs, getModel } from "./monaco-setup";
import {
  HIGHLIGHT_LIMITS,
  SCOPE_TOKEN_INDEX,
  warnHighlightOnce,
  type HighlightCapture,
} from "./highlight-common";
import {
  type HighlightFallbackReason,
  type HighlightWorkerRequest,
  type HighlightWorkerResponse,
  type HighlightWorkerStats,
} from "./highlight-worker-protocol";

const TOKEN_TYPES = ["keyword", "type", "attribute", "variable", "literal", "number", "string", "comment"];
const LEGEND: monaco.languages.SemanticTokensLegend = { tokenTypes: TOKEN_TYPES, tokenModifiers: [] };
const CAPTURE_TO_INDEX = SCOPE_TOKEN_INDEX;
const WORKER_REQUEST_TIMEOUT_MS = 15_000;
const WORKER_STATS_TIMEOUT_MS = 2_000;

interface GrammarSource { wasm: string | ArrayBuffer; query: string }
interface GrammarEntry {
  loadWasm: () => Promise<string | ArrayBuffer>;
  loadQuery: () => Promise<string>;
  source?: Promise<GrammarSource>;
  init?: Promise<boolean>;
  failure?: unknown;
}
const grammars = new Map<string, GrammarEntry>();

/** Idempotent registration; loaders are resolved lazily on first use. */
export function registerGrammar(
  languageId: string,
  loadWasm: () => Promise<string | ArrayBuffer>,
  loadQuery: () => Promise<string>,
): void {
  if (grammars.has(languageId)) return;
  grammars.set(languageId, { loadWasm, loadQuery });
  if (started) registerProviderFor(languageId);
}

interface LanguageSession {
  users: Set<monaco.editor.ITextModel>;
  /** Mirrors "a parser/query exists in the worker" for synchronous diagnostics. */
  resources?: boolean;
}
interface ModelTracking {
  languageId: string;
  generation: number;
  session?: LanguageSession;
  listeners: monaco.IDisposable[];
}
export interface TreeHighlightStatus {
  engine: "pending" | "tree-sitter" | "fallback";
  languageId: string;
  version: number;
  reason?: string;
  fallback?: "builtin-or-plaintext";
}
const sessions = new Map<string, LanguageSession>();
const tracked = new Map<monaco.editor.ITextModel, ModelTracking>();
const statuses = new WeakMap<monaco.editor.ITextModel, TreeHighlightStatus>();
const providers = new Map<string, monaco.IDisposable>();
const listeners: monaco.IDisposable[] = [];
let started = false;

// --- Worker client -------------------------------------------------------

type TokenOutcome =
  | { kind: "tokens"; data: Uint32Array }
  | { kind: "fallback"; reason: HighlightFallbackReason; message?: string; released?: boolean }
  | { kind: "cancelled" }
  | { kind: "error"; message?: string };

interface PendingRequest {
  requestId: number;
  modelKey: number;
  languageId: string;
  isStale: () => boolean;
  settle: (outcome: TokenOutcome) => void;
}

let worker: Worker | undefined;
let requestSequence = 0;
let modelKeySequence = 0;
const modelKeys = new WeakMap<monaco.editor.ITextModel, number>();
const pendingRequests = new Map<number, PendingRequest>();
const pendingInits = new Map<number, (result: { ok: boolean; message?: string; permanent: boolean }) => void>();
const pendingStats = new Map<number, (stats: HighlightWorkerStats | null) => void>();
let inFlightTrees = 0;
let workerRequests = 0;
let cancelledRequests = 0;
let discardedResults = 0;
let orphanedResponses = 0;

export interface TreeSitterWorkerClientStats {
  worker: boolean;
  pending: number;
  trees: number;
  requests: number;
  cancelled: number;
  discarded: number;
  orphaned: number;
}
export function getTreeSitterClientStats(): TreeSitterWorkerClientStats {
  return {
    worker: !!worker,
    pending: pendingRequests.size,
    trees: inFlightTrees,
    requests: workerRequests,
    cancelled: cancelledRequests,
    discarded: discardedResults,
    orphaned: orphanedResponses,
  };
}
export function isTreeSitterWorkerRunning(): boolean { return !!worker; }

export function getTreeHighlightStatus(model: monaco.editor.ITextModel): TreeHighlightStatus | undefined {
  const status = statuses.get(model);
  return status ? { ...status } : undefined;
}
/** Synchronous main-thread mirror; live worker counters use the async stats. */
export function getTreeHighlightResources(): { models: number; sessions: number; parsers: number; queries: number; trees: number } {
  const live = [...sessions.values()].filter(s => s.resources).length;
  return { models: tracked.size, sessions: sessions.size, parsers: live, queries: live, trees: inFlightTrees };
}
/** Actual worker-owned resource counts; resolves null when no worker exists. */
export function getTreeSitterWorkerStats(): Promise<HighlightWorkerStats | null> {
  if (!worker) return Promise.resolve(null);
  const requestId = ++requestSequence;
  return new Promise<HighlightWorkerStats | null>(resolve => {
    const timer = setTimeout(() => {
      if (!pendingStats.delete(requestId)) return;
      resolve(null);
    }, WORKER_STATS_TIMEOUT_MS);
    pendingStats.set(requestId, stats => {
      clearTimeout(timer);
      resolve(stats);
    });
    if (!postToWorker({ type: "stats", requestId })) {
      pendingStats.delete(requestId);
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function modelKeyOf(model: monaco.editor.ITextModel): number {
  let key = modelKeys.get(model);
  if (key == null) {
    key = ++modelKeySequence;
    modelKeys.set(model, key);
  }
  return key;
}

function spawnWorker(): Worker | undefined {
  if (worker) return worker;
  if (typeof Worker === "undefined") {
    warnHighlightOnce("tree-sitter:worker:unavailable", "Web Workers are unavailable; tree-sitter highlighting is disabled.");
    return undefined;
  }
  try {
    const created = new Worker(new URL("./highlight-worker.ts", import.meta.url), {
      type: "module",
      name: "cotedsyntax-tree-sitter",
    });
    created.onmessage = (event: MessageEvent<HighlightWorkerResponse>) => handleWorkerMessage(event.data);
    created.onerror = (event: ErrorEvent) => {
      event.preventDefault?.();
      failWorker(event.message || "highlight worker crashed");
    };
    created.onmessageerror = () => failWorker("highlight worker response could not be deserialized");
    worker = created;
    return created;
  } catch (error) {
    warnHighlightOnce("tree-sitter:worker:spawn", error);
    return undefined;
  }
}

function postToWorker(request: HighlightWorkerRequest): boolean {
  if (!worker) return false;
  try {
    worker.postMessage(request);
    return true;
  } catch (error) {
    warnHighlightOnce("tree-sitter:worker:post", error);
    return false;
  }
}

/** Terminates the worker and resolves every waiter, keeping grammars retryable. */
function resetWorker(message: string): void {
  const current = worker;
  worker = undefined;
  if (current) {
    current.onmessage = null;
    current.onerror = null;
    current.onmessageerror = null;
    current.terminate();
  }
  const pending = [...pendingRequests.values()];
  pendingRequests.clear();
  inFlightTrees = 0;
  pending.forEach(entry => entry.settle({ kind: "error", message }));
  const inits = [...pendingInits.values()];
  pendingInits.clear();
  inits.forEach(settle => settle({ ok: false, message, permanent: false }));
  const stats = [...pendingStats.values()];
  pendingStats.clear();
  stats.forEach(settle => settle(null));
  for (const session of sessions.values()) session.resources = undefined;
  for (const entry of grammars.values()) {
    if (!entry.failure) entry.init = undefined;
  }
}
function failWorker(message: string): void { resetWorker(message); }

function handleWorkerMessage(message: HighlightWorkerResponse): void {
  switch (message.type) {
    case "tokens": {
      const pending = pendingRequests.get(message.requestId);
      if (!pending) { orphanedResponses++; return; }
      pendingRequests.delete(message.requestId);
      inFlightTrees = Math.max(0, inFlightTrees - 1);
      if (pending.isStale()) {
        discardedResults++;
        pending.settle({ kind: "cancelled" });
        return;
      }
      const session = sessions.get(pending.languageId);
      if (session) session.resources = true;
      pending.settle({ kind: "tokens", data: message.data });
      return;
    }
    case "fallback": {
      const pending = pendingRequests.get(message.requestId);
      if (!pending) { orphanedResponses++; return; }
      pendingRequests.delete(message.requestId);
      inFlightTrees = Math.max(0, inFlightTrees - 1);
      if (pending.isStale()) {
        discardedResults++;
        pending.settle({ kind: "cancelled" });
        return;
      }
      const session = sessions.get(pending.languageId);
      if (message.released && session) session.resources = undefined;
      pending.settle({
        kind: "fallback",
        reason: message.reason,
        ...(message.message == null ? {} : { message: message.message }),
        ...(message.released ? { released: true } : {}),
      });
      return;
    }
    case "cancelled": {
      const pending = pendingRequests.get(message.requestId);
      if (!pending) return;
      pendingRequests.delete(message.requestId);
      inFlightTrees = Math.max(0, inFlightTrees - 1);
      pending.settle({ kind: "cancelled" });
      return;
    }
    case "initialized":
    case "init-failed": {
      const settle = pendingInits.get(message.requestId);
      if (!settle) return;
      pendingInits.delete(message.requestId);
      settle({
        ok: message.type === "initialized",
        permanent: message.type === "init-failed",
        ...(message.message == null ? {} : { message: message.message }),
      });
      return;
    }
    case "stats": {
      const settle = pendingStats.get(message.requestId);
      if (!settle) return;
      pendingStats.delete(message.requestId);
      settle(message.stats);
      return;
    }
    case "internal-error": {
      const init = pendingInits.get(message.requestId);
      if (init) {
        pendingInits.delete(message.requestId);
        init({ ok: false, permanent: false, message: message.message });
        return;
      }
      const stats = pendingStats.get(message.requestId);
      if (stats) {
        pendingStats.delete(message.requestId);
        stats(null);
        return;
      }
      const pending = pendingRequests.get(message.requestId);
      if (!pending) return;
      pendingRequests.delete(message.requestId);
      inFlightTrees = Math.max(0, inFlightTrees - 1);
      pending.settle({ kind: "error", message: message.message });
      return;
    }
  }
}

function cancelRequestsForModel(modelKey: number): void {
  for (const pending of [...pendingRequests.values()]) {
    if (pending.modelKey !== modelKey) continue;
    pendingRequests.delete(pending.requestId);
    inFlightTrees = Math.max(0, inFlightTrees - 1);
    cancelledRequests++;
    pending.settle({ kind: "cancelled" });
    postToWorker({ type: "cancel", requestId: pending.requestId });
  }
}

function releaseLanguageInWorker(languageId: string): void {
  postToWorker({ type: "release", languageId });
}

function initLanguageInWorker(
  languageId: string,
  source: GrammarSource,
): Promise<{ ok: boolean; message?: string; permanent: boolean }> {
  const active = spawnWorker();
  if (!active) {
    return Promise.resolve({ ok: false, permanent: false, message: "highlight worker unavailable" });
  }
  const requestId = ++requestSequence;
  const wasm = source.wasm instanceof ArrayBuffer ? source.wasm.slice(0) : source.wasm;
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: { ok: boolean; message?: string; permanent: boolean }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingInits.delete(requestId);
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, permanent: false, message: "highlight worker initialization timed out" }),
      WORKER_REQUEST_TIMEOUT_MS,
    );
    pendingInits.set(requestId, finish);
    try {
      active.postMessage(
        { type: "init", requestId, languageId, wasm, query: source.query },
        wasm instanceof ArrayBuffer ? [wasm] : [],
      );
    } catch (error) {
      finish({ ok: false, permanent: false, message: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** Resolves grammar sources once, then initializes the language in the worker. */
function ensureLanguage(languageId: string): Promise<boolean> {
  const entry = grammars.get(languageId);
  if (!entry || entry.failure) return Promise.resolve(false);
  if (entry.init) return entry.init;
  const attempt = (async (): Promise<boolean> => {
    try {
      const source = await (entry.source ??= (async () => {
        const [wasm, query] = await Promise.all([entry.loadWasm(), entry.loadQuery()]);
        return { wasm, query };
      })());
      const result = await initLanguageInWorker(languageId, source);
      if (result.ok) return true;
      const error = new Error(result.message ?? "highlight worker initialization failed");
      if (result.permanent) {
        entry.failure = error;
        warnHighlightOnce(`tree-sitter:${languageId}:initialization`, error);
      } else {
        entry.init = undefined; // transient (crash/timeout): retry on next use
      }
      return false;
    } catch (error) {
      entry.failure = error;
      warnHighlightOnce(`tree-sitter:${languageId}:initialization`, error);
      return false;
    }
  })();
  entry.init = attempt;
  return attempt;
}

function requestTokens(
  languageId: string,
  modelKey: number,
  lines: string[],
  version: number,
  generation: number,
  isStale: () => boolean,
): Promise<TokenOutcome> {
  if (!spawnWorker()) {
    return Promise.resolve({ kind: "error", message: "highlight worker unavailable" });
  }
  const requestId = ++requestSequence;
  workerRequests++;
  inFlightTrees++;
  return new Promise<TokenOutcome>(resolve => {
    let settled = false;
    const finish = (outcome: TokenOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      inFlightTrees = Math.max(0, inFlightTrees - 1);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      if (!pendingRequests.has(requestId)) return;
      postToWorker({ type: "cancel", requestId });
      finish({ kind: "error", message: "highlight worker request timed out" });
    }, WORKER_REQUEST_TIMEOUT_MS);
    pendingRequests.set(requestId, { requestId, modelKey, languageId, isStale, settle: finish });
    if (!postToWorker({ type: "parse", requestId, modelKey, languageId, version, generation, lines })) {
      finish({ kind: "error", message: "highlight worker unavailable" });
    }
  });
}

// --- Model/session bookkeeping ------------------------------------------

function releaseSession(model: monaco.editor.ITextModel, tracking: ModelTracking): void {
  const session = tracking.session;
  tracking.session = undefined;
  if (!session) return;
  session.users.delete(model);
  if (session.users.size) return;
  const languageId = tracking.languageId;
  sessions.delete(languageId);
  session.resources = undefined;
  // Also frees an initialisation that was still queued in the worker.
  releaseLanguageInWorker(languageId);
}
function trackModel(model: monaco.editor.ITextModel): ModelTracking {
  let tracking = tracked.get(model);
  if (tracking) return tracking;
  tracking = { languageId: model.getLanguageId(), generation: 0, listeners: [] };
  const current = tracking;
  current.listeners.push(model.onDidChangeLanguage(() => {
    current.generation++;
    cancelRequestsForModel(modelKeyOf(model));
    releaseSession(model, current);
    current.languageId = model.getLanguageId();
    statuses.delete(model);
  }), model.onWillDispose(() => {
    current.generation++;
    cancelRequestsForModel(modelKeyOf(model));
    releaseSession(model, current);
    current.listeners.forEach(d => d.dispose());
    tracked.delete(model);
    modelKeys.delete(model);
    statuses.delete(model);
  }));
  tracked.set(model, current);
  return current;
}

function retainSession(model: monaco.editor.ITextModel, tracking: ModelTracking): LanguageSession {
  let session = sessions.get(tracking.languageId);
  if (!session) {
    session = { users: new Set() };
    sessions.set(tracking.languageId, session);
  }
  tracking.session = session;
  session.users.add(model);
  return session;
}

export function registerHighlightProviders(): void {
  if (started) return;
  started = true;
  for (const id of grammars.keys()) registerProviderFor(id);
  monacoNs.editor.getModels().forEach(trackModel);
  listeners.push(monacoNs.editor.onDidCreateModel(trackModel));
}

/** Kept for the bootstrap API. Monaco itself invalidates tokens on content edits. */
export function attachModelChangeTracking(): void { registerHighlightProviders(); }

function registerProviderFor(languageId: string): void {
  if (providers.has(languageId)) return;
  providers.set(languageId, monacoNs.languages.registerDocumentSemanticTokensProvider(languageId, {
    getLegend: () => LEGEND,
    provideDocumentSemanticTokens: (model, _previous, cancellation) => buildTokens(model, cancellation),
    releaseDocumentSemanticTokens: () => {},
  }));
}

type CancellationLike = Pick<monaco.CancellationToken, "isCancellationRequested"> &
  Partial<Pick<monaco.CancellationToken, "onCancellationRequested">>;

/** Public engine seam for component regression: no builtin tokenizer involved. */
export async function buildTokens(
  model: monaco.editor.ITextModel,
  cancellation?: CancellationLike,
): Promise<monaco.languages.SemanticTokens | null> {
  if (model.isDisposed() || cancellation?.isCancellationRequested) return null;
  const tracking = trackModel(model);
  const generation = ++tracking.generation;
  const languageId = model.getLanguageId();
  const version = model.getVersionId();
  const modelKey = modelKeyOf(model);
  const stale = (): boolean => model.isDisposed() || !!cancellation?.isCancellationRequested ||
    tracking.generation !== generation || model.getLanguageId() !== languageId || model.getVersionId() !== version;
  const fallback = (reason: HighlightFallbackReason): monaco.languages.SemanticTokens | null => {
    if (stale()) return null;
    statuses.set(model, { engine: "fallback", languageId, version, reason, fallback: "builtin-or-plaintext" });
    warnHighlightOnce(`tree-sitter:${languageId}:${reason}`, `Using builtin/plaintext highlighting (${reason}).`);
    return { data: new Uint32Array() };
  };
  const previous = statuses.get(model);
  if (previous?.engine === "fallback" && previous.version === version && previous.languageId === languageId) {
    return { data: new Uint32Array() };
  }
  statuses.set(model, { engine: "pending", languageId, version });
  if (!grammars.has(languageId)) return fallback("no-grammar");
  // Check cheap model metrics before serializing text or waking the worker.
  if (model.getValueLength() > HIGHLIGHT_LIMITS.codeUnits || model.getLineCount() > HIGHLIGHT_LIMITS.lines) {
    cancelRequestsForModel(modelKey);
    releaseSession(model, tracking);
    return fallback("large-document");
  }
  for (let line = 1; line <= model.getLineCount(); line++) {
    if (model.getLineLength(line) > HIGHLIGHT_LIMITS.lineLength) {
      cancelRequestsForModel(modelKey);
      releaseSession(model, tracking);
      return fallback("long-line");
    }
  }
  cancelRequestsForModel(modelKey);
  const ready = await ensureLanguage(languageId);
  if (stale()) {
    // The model was closed or switched while the grammar loaded. Drop the
    // freshly initialised worker parser/query when nobody else uses it; a
    // later parse recreates them lazily.
    if (!sessions.has(languageId)) releaseLanguageInWorker(languageId);
    return null;
  }
  if (!ready) return fallback("initialization-failed");
  const session = retainSession(model, tracking);
  session.resources = true;
  const lines = model.getLinesContent();
  const cancellationListener = cancellation?.onCancellationRequested?.(() => {
    cancelRequestsForModel(modelKey);
  });
  try {
    const outcome = await requestTokens(languageId, modelKey, lines, version, generation, stale);
    if (stale()) return null;
    if (outcome.kind === "tokens") {
      statuses.set(model, { engine: "tree-sitter", languageId, version });
      return { data: outcome.data };
    }
    if (outcome.kind === "cancelled") return null;
    if (outcome.kind === "error") {
      const current = sessions.get(languageId);
      if (current) current.resources = undefined;
      warnHighlightOnce(`tree-sitter:${languageId}:runtime`, new Error(outcome.message ?? "highlight worker failure"));
      return fallback("runtime-failed");
    }
    if (outcome.released) {
      const current = sessions.get(languageId);
      if (current) current.resources = undefined;
    }
    if (outcome.reason === "runtime-failed" && outcome.message) {
      warnHighlightOnce(`tree-sitter:${languageId}:runtime`, new Error(outcome.message));
    }
    return fallback(outcome.reason);
  } finally {
    cancellationListener?.dispose();
  }
}

/** web-tree-sitter's JS binding uses UTF-16 offsets, as does Monaco (not UTF-8).
 * Split on model line ends, excluding CR/LF and empty segments. Input ranges
 * have already had parent/child overlap resolved by resolveCaptureRanges.
 * Kept as the main-thread reference encoding for the component regression.
 */
export function packTokens(captures: HighlightCapture[], model: monaco.editor.ITextModel): Uint32Array {
  const data: number[] = [];
  let previousLine = 0, previousColumn = 0;
  const length = model.getValueLength();
  for (const capture of captures) {
    const type = CAPTURE_TO_INDEX[capture.scope];
    if (type == null || capture.startIndex < 0 || capture.endIndex > length) continue;
    const start = model.getPositionAt(capture.startIndex);
    const end = model.getPositionAt(capture.endIndex);
    for (let line = start.lineNumber; line <= end.lineNumber; line++) {
      const column = line === start.lineNumber ? start.column - 1 : 0;
      const lastColumn = line === end.lineNumber ? end.column - 1 : model.getLineLength(line);
      if (lastColumn <= column) continue;
      const deltaLine = line - 1 - previousLine;
      data.push(deltaLine, deltaLine ? column : column - previousColumn, lastColumn - column, type, 0);
      previousLine = line - 1;
      previousColumn = column;
    }
  }
  return Uint32Array.from(data);
}

export function refreshSemanticTokens(): void {
  const model = getModel();
  if (model && !model.isDisposed()) monacoNs.editor.setModelLanguage(model, model.getLanguageId());
}

/** Application/HMR teardown; also terminates the worker and drops its state. */
export function disposeHighlightProviders(): void {
  for (const [model, tracking] of tracked) {
    tracking.generation++;
    cancelRequestsForModel(modelKeyOf(model));
    releaseSession(model, tracking);
    tracking.listeners.forEach(d => d.dispose());
    statuses.delete(model);
  }
  tracked.clear();
  listeners.splice(0).forEach(d => d.dispose());
  providers.forEach(d => d.dispose());
  providers.clear();
  resetWorker("highlight providers disposed");
  started = false;
}
if (import.meta.hot) import.meta.hot.dispose(disposeHighlightProviders);
export { LEGEND as TREE_SITTER_TOKEN_LEGEND };
