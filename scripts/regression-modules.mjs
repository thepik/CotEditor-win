// Module-level browser regressions, run in one pass against the Vite dev server:
//   npm run regression:modules
//   node scripts/regression-modules.mjs http://127.0.0.1:1420/
//   node scripts/regression-modules.mjs 1420
//
// Unlike `npm run regression` (smoke + documents + editing + chrome +
// highlighting), this suite covers the tab strip, document store, settings,
// preview/outline, find results, phase-B dialogs, recovery/conflict and
// multi-tab integration.
//
// Missing suite scripts and an unreachable dev server are hard failures: a
// suite is never silently skipped. The `regression` script follows the same
// fail-fast rule for its own steps.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const DEFAULT_PORT = 1420;
const rawTarget = process.argv[2];
const base = (() => {
  if (!rawTarget) return `http://127.0.0.1:${DEFAULT_PORT}/`;
  if (/^\d+$/.test(rawTarget)) return `http://127.0.0.1:${rawTarget}/`;
  return rawTarget;
})();

// Execution order is intentional: component-level suites first, then the
// integration suites that boot the real app and mutate its state.
const suites = [
  "tabs-ui",
  "document-store",
  "settings",
  "preview-outline",
  "find-results",
  "b-dialogs",
  "recovery-conflict",
  "tabs",
].map((name) => ({
  name,
  file: `scripts/regression-${name}.mjs`,
  command: `node scripts/regression-${name}.mjs ${base}`,
}));

const missing = suites.filter((suite) => !existsSync(suite.file));
if (missing.length > 0) {
  console.error(`regression:modules: missing required suite script(s): ${missing.map((suite) => suite.file).join(", ")}`);
  console.error("regression:modules: nothing was run; create the missing suite(s) instead of skipping them.");
  process.exit(1);
}

// Preflight the dev server. suites such as regression-tabs-ui report SKIP and
// exit 0 when the server is down; that would read as a pass here, so treat an
// unreachable server as a hard failure.
let serverReady = false;
let serverError = "";
try {
  const response = await fetch(base, { signal: AbortSignal.timeout(5000) });
  serverReady = response.ok;
  if (!response.ok) serverError = `HTTP ${response.status}`;
} catch (error) {
  serverError = error?.message ?? String(error);
}
if (!serverReady) {
  console.error(`regression:modules: dev server not reachable at ${base} (${serverError || "no response"}).`);
  console.error("regression:modules: start the Vite dev server (port 1420 by default) and re-run.");
  process.exit(1);
}

for (const suite of suites) {
  console.log("");
  console.log(`[regression:modules] ${suite.name}: ${suite.command}`);
  const result = spawnSync(suite.command, { stdio: "inherit", shell: true });
  if (result.error) {
    console.error(`[regression:modules] ${suite.name} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[regression:modules] ${suite.name} failed with exit code ${result.status}`);
    process.exit(result.status || 1);
  }
}

console.log("");
console.log(`[regression:modules] all ${suites.length} suites passed`);
