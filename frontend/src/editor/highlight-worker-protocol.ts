/**
 * Structured-clone protocol between the main thread and the tree-sitter worker.
 *
 * Requests carry the document version the caller expects; responses echo the
 * request id only, so the client can drop results for superseded versions,
 * languages or generations. Token payloads are transferred, never copied.
 */
export type HighlightFallbackReason =
  | "no-grammar"
  | "large-document"
  | "long-line"
  | "initialization-failed"
  | "parse-budget"
  | "query-budget"
  | "capture-limit"
  | "token-budget"
  | "runtime-failed";

/** Load a grammar + query into the worker. Sent once per language per worker. */
export interface WorkerInitRequest {
  type: "init";
  requestId: number;
  languageId: string;
  /** Bundler URL (built-in grammars) or raw bytes (custom registrations). */
  wasm: string | ArrayBuffer;
  query: string;
}

export interface WorkerParseRequest {
  type: "parse";
  requestId: number;
  /** Stable per-model id; identifies in-flight work to cancel. */
  modelKey: number;
  languageId: string;
  /** Monaco model version id at submission time. */
  version: number;
  /** Provider generation at submission time (stale results are dropped). */
  generation: number;
  /** Full line contents without EOL characters, joined with "\n" in-worker. */
  lines: string[];
}

export interface WorkerCancelRequest {
  /** Cancels (and drops the result of) `requestId`. */
  type: "cancel";
  requestId: number;
}

export interface WorkerReleaseRequest {
  type: "release";
  languageId: string;
}

export interface WorkerStatsRequest {
  type: "stats";
  requestId: number;
}

export type HighlightWorkerRequest =
  | WorkerInitRequest
  | WorkerParseRequest
  | WorkerCancelRequest
  | WorkerReleaseRequest
  | WorkerStatsRequest;

export interface WorkerTokensResponse {
  type: "tokens";
  requestId: number;
  languageId: string;
  /** Packed Monaco semantic token data, transferred as an ArrayBuffer. */
  data: Uint32Array;
}

export interface WorkerFallbackResponse {
  type: "fallback";
  requestId: number;
  reason: HighlightFallbackReason;
  message?: string;
  /** True when the worker already deleted its parser/query after the failure. */
  released?: boolean;
}

export interface WorkerInitResponse {
  type: "initialized" | "init-failed";
  requestId: number;
  languageId: string;
  message?: string;
}

export interface WorkerCancelledResponse {
  type: "cancelled";
  requestId: number;
}

export interface WorkerStatsResponse {
  type: "stats";
  requestId: number;
  stats: HighlightWorkerStats;
}

export interface WorkerInternalErrorResponse {
  type: "internal-error";
  requestId: number;
  message: string;
}

export type HighlightWorkerResponse =
  | WorkerTokensResponse
  | WorkerFallbackResponse
  | WorkerInitResponse
  | WorkerCancelledResponse
  | WorkerStatsResponse
  | WorkerInternalErrorResponse;

/** Live worker-owned resources; deliberately contains no document contents. */
export interface HighlightWorkerStats {
  /** `true` only when the snapshot was produced inside the worker thread. */
  inWorker: boolean;
  languages: number;
  parsers: number;
  queries: number;
  trees: number;
  parses: number;
  failures: number;
  releases: number;
  cancelled: number;
}
