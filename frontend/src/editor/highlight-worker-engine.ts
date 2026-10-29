/**
 * Tree-sitter engine that runs inside the dedicated highlight worker.
 *
 * Owns the WASM runtime, one Language per registered grammar (tree-sitter has
 * no unload API), and at most one parser + query per language. Parsers and
 * queries are deleted on release (language switch, last model close, failure)
 * and recreated lazily from the cached grammar/query source. Every temporary
 * tree is deleted in `finally`, including parse/query failures.
 *
 * This module is deliberately free of Monaco/DOM access: it only sees line
 * contents, offsets and limits, so it can also be exercised directly in the
 * regression harness with injected runtime faults.
 */
import type * as TreeSitter from "web-tree-sitter";
import treeSitterWasmUrl from "web-tree-sitter/tree-sitter.wasm?url";
import {
  HIGHLIGHT_LIMITS,
  SCOPE_TOKEN_INDEX,
  packTokensFromLines,
  resolveCaptureRanges,
  type HighlightCapture,
} from "./highlight-common";
import type {
  HighlightFallbackReason,
  HighlightWorkerRequest,
  HighlightWorkerResponse,
  HighlightWorkerStats,
  WorkerFallbackResponse,
  WorkerInitResponse,
  WorkerParseRequest,
} from "./highlight-worker-protocol";

let runtimePromise: Promise<typeof TreeSitter> | undefined;

/** Shared, single WASM runtime instance per worker (and per test context). */
export function getTreeSitterRuntime(): Promise<typeof TreeSitter> {
  return runtimePromise ??= (async () => {
    const mod = await import("web-tree-sitter");
    await mod.Parser.init({
      locateFile: (path: string) => path.endsWith("tree-sitter.wasm") ? treeSitterWasmUrl : path,
    });
    return mod;
  })();
}

interface LanguageState {
  wasm: string | ArrayBuffer;
  querySource: string;
  language?: TreeSitter.Language;
  query?: TreeSitter.Query;
  parser?: TreeSitter.Parser;
  /** Permanent per-language failure (grammar load or query compilation). */
  failure?: string;
  loading?: Promise<void>;
}

const MAX_MESSAGE_LENGTH = 500;
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) : message;
}

export class HighlightWorkerEngine {
  private readonly languages = new Map<string, LanguageState>();
  private readonly inFlight = new Set<number>();
  private readonly cancelled = new Set<number>();
  private treeCount = 0;
  private parseCount = 0;
  private failureCount = 0;
  private releaseCount = 0;
  private cancelCount = 0;

  /** Processes one request at a time (the worker shell serializes calls). */
  async handle(request: HighlightWorkerRequest): Promise<HighlightWorkerResponse | null> {
    switch (request.type) {
      case "init":
        return this.initialize(request.requestId, request.languageId, request.wasm, request.query);
      case "parse":
        return this.parse(request);
      case "cancel":
        if (this.inFlight.has(request.requestId)) {
          this.cancelled.add(request.requestId);
          this.cancelCount++;
        }
        return null;
      case "release":
        this.release(request.languageId);
        return null;
      case "stats":
        return { type: "stats", requestId: request.requestId, stats: this.stats() };
      default:
        return null;
    }
  }

  stats(): HighlightWorkerStats {
    let parsers = 0, queries = 0, trees = this.treeCount;
    for (const state of this.languages.values()) {
      if (state.parser) parsers++;
      if (state.query) queries++;
    }
    if (trees < 0) trees = 0;
    return {
      inWorker: typeof (globalThis as { document?: unknown }).document === "undefined",
      languages: this.languages.size,
      parsers,
      queries,
      trees,
      parses: this.parseCount,
      failures: this.failureCount,
      releases: this.releaseCount,
      cancelled: this.cancelCount,
    };
  }

  /** Deletes every parser/query owned by the engine (worker teardown/tests). */
  dispose(): void {
    for (const state of this.languages.values()) this.releaseState(state);
    this.languages.clear();
    this.inFlight.clear();
    this.cancelled.clear();
  }

  private async initialize(
    requestId: number,
    languageId: string,
    wasm: string | ArrayBuffer,
    querySource: string,
  ): Promise<WorkerInitResponse> {
    let state = this.languages.get(languageId);
    if (!state) {
      state = { wasm, querySource };
      this.languages.set(languageId, state);
    } else {
      state.wasm = wasm;
      state.querySource = querySource;
    }
    if (state.failure) {
      return { type: "init-failed", requestId, languageId, message: state.failure };
    }
    if (!state.loading) state.loading = this.loadLanguage(state);
    await state.loading;
    if (state.failure) {
      return { type: "init-failed", requestId, languageId, message: state.failure };
    }
    try {
      await this.ensureResources(state);
    } catch (error) {
      state.failure = describe(error);
      this.failureCount++;
      return { type: "init-failed", requestId, languageId, message: state.failure };
    }
    return { type: "initialized", requestId, languageId };
  }

  private async loadLanguage(state: LanguageState): Promise<void> {
    try {
      const runtime = await getTreeSitterRuntime();
      state.language = await runtime.Language.load(
        typeof state.wasm === "string" ? state.wasm : new Uint8Array(state.wasm),
      );
    } catch (error) {
      state.failure = describe(error);
      this.failureCount++;
    }
  }

  /** Lazily (re)creates the parser/query pair after a release. */
  private async ensureResources(state: LanguageState): Promise<void> {
    if (state.parser && state.query) return;
    if (!state.language) throw new Error(state.failure ?? "grammar language unavailable");
    const runtime = await getTreeSitterRuntime();
    let query = state.query;
    let parser = state.parser;
    try {
      query ??= new runtime.Query(state.language, state.querySource);
      if (!parser) {
        parser = new runtime.Parser();
        parser.setLanguage(state.language);
      }
    } catch (error) {
      query?.delete();
      parser?.delete();
      throw error;
    }
    state.query = query;
    state.parser = parser;
  }

  private async parse(request: WorkerParseRequest): Promise<HighlightWorkerResponse> {
    const state = this.languages.get(request.languageId);
    if (!state || !state.language || state.failure) {
      return this.fallback(request, "initialization-failed");
    }
    try {
      await this.ensureResources(state);
    } catch (error) {
      state.failure = describe(error);
      this.failureCount++;
      return this.fallback(request, "initialization-failed", describe(error), true);
    }

    const lines = request.lines.length ? request.lines : [""];
    let textLength = 0;
    for (const line of lines) textLength += line.length;
    if (lines.length > HIGHLIGHT_LIMITS.lines || textLength > HIGHLIGHT_LIMITS.codeUnits) {
      this.releaseState(state);
      return this.fallback(request, "large-document", undefined, true);
    }
    if (lines.some(line => line.length > HIGHLIGHT_LIMITS.lineLength)) {
      this.releaseState(state);
      return this.fallback(request, "long-line", undefined, true);
    }

    this.inFlight.add(request.requestId);
    const deadline = performance.now() + HIGHLIGHT_LIMITS.milliseconds;
    const stop = (): boolean =>
      this.cancelled.has(request.requestId) || performance.now() > deadline;
    const text = lines.join("\n");
    let tree: TreeSitter.Tree | null = null;
    let failed = false;
    try {
      this.parseCount++;
      state.parser!.reset();
      tree = state.parser!.parse(text, null, { progressCallback: stop });
      if (tree) this.treeCount++;
      if (!tree || stop()) {
        failed = true;
        this.failureCount++;
        return this.fallback(request, "parse-budget", undefined, true);
      }
      const captures = collectCaptures(state.query!, tree, stop);
      if (stop() || state.query!.didExceedMatchLimit()) {
        failed = true;
        this.failureCount++;
        return this.fallback(request, "query-budget", undefined, true);
      }
      if (captures.length > HIGHLIGHT_LIMITS.captures) {
        failed = true;
        this.failureCount++;
        return this.fallback(request, "capture-limit", undefined, true);
      }
      const data = packTokensFromLines(resolveCaptureRanges(captures), lines);
      if (stop()) {
        failed = true;
        this.failureCount++;
        return this.fallback(request, "token-budget", undefined, true);
      }
      return { type: "tokens", requestId: request.requestId, languageId: request.languageId, data };
    } catch (error) {
      const message = describe(error);
      failed = true;
      this.failureCount++;
      const reason: HighlightFallbackReason = /match limit/i.test(message)
        ? "query-budget" : "runtime-failed";
      return this.fallback(request, reason, message, true);
    } finally {
      if (tree) {
        try { tree.delete(); } finally { this.treeCount--; }
      }
      // A cancelled parse must never be resumed with text from another model.
      state.parser?.reset();
      if (failed) this.releaseState(state);
      this.inFlight.delete(request.requestId);
      this.cancelled.delete(request.requestId);
    }
  }

  private release(languageId: string): void {
    const state = this.languages.get(languageId);
    if (!state) return;
    this.releaseState(state);
  }

  /** Deletes parser/query but keeps the (unloadable) Language + sources. */
  private releaseState(state: LanguageState): void {
    const hadResources = !!(state.query || state.parser);
    try {
      state.query?.delete();
    } finally {
      state.query = undefined;
      try {
        state.parser?.delete();
      } finally {
        state.parser = undefined;
      }
    }
    if (hadResources) this.releaseCount++;
  }

  private fallback(
    request: WorkerParseRequest,
    reason: HighlightFallbackReason,
    message?: string,
    released = false,
  ): WorkerFallbackResponse {
    return {
      type: "fallback",
      requestId: request.requestId,
      reason,
      ...(message == null ? {} : { message }),
      ...(released ? { released: true } : {}),
    };
  }
}

function collectCaptures(
  query: TreeSitter.Query,
  tree: TreeSitter.Tree,
  stop: () => boolean,
): HighlightCapture[] {
  const result: HighlightCapture[] = [];
  const matches = query.matches(tree.rootNode, { matchLimit: 4096, progressCallback: stop });
  for (const match of matches) {
    for (const capture of match.captures) {
      const scope = capture.name.split(".", 1)[0];
      if (!(scope in SCOPE_TOKEN_INDEX)) continue;
      result.push({
        startIndex: capture.node.startIndex,
        endIndex: capture.node.endIndex,
        patternIndex: match.patternIndex,
        scope,
      });
      if (result.length > HIGHLIGHT_LIMITS.captures) return result;
    }
  }
  return result;
}
