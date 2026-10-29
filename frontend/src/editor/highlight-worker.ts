/**
 * Dedicated tree-sitter worker shell.
 *
 * Messages are serialized through a promise chain so a long WASM parse never
 * interleaves with release/init bookkeeping. Token buffers are transferred back
 * zero-copy. Nothing here touches the DOM or Monaco.
 */
import { HighlightWorkerEngine } from "./highlight-worker-engine";
import type { HighlightWorkerRequest, HighlightWorkerResponse } from "./highlight-worker-protocol";

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<HighlightWorkerRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;
const engine = new HighlightWorkerEngine();
let queue: Promise<void> = Promise.resolve();

function send(response: HighlightWorkerResponse | null): void {
  if (!response) return;
  const transfer = response.type === "tokens" ? [response.data.buffer] : [];
  scope.postMessage(response, transfer);
}

scope.addEventListener("message", event => {
  const request = event.data;
  queue = queue
    .then(async () => send(await engine.handle(request)))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const requestId = "requestId" in request ? request.requestId : -1;
      scope.postMessage({ type: "internal-error", requestId, message });
    });
});
