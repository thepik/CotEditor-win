// Run manually against an ALREADY BUILT Windows executable; never builds it.
// Usage: npm run regression:native -- "E:/absolute/path/CotEditor.exe"
// Exit codes: 0 = PASS, 1 = FAIL (including cleanup failure), 2 = SKIP.
// All fixtures, the isolated WebView2 profile, screenshots and diagnostics stay
// in the printed os.tmpdir() directory, including after a failure. No /src APIs.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const READY_TIMEOUT = 40000;
const STEP_TIMEOUT = 12000;
// main.go SingleInstanceLock.UniqueId and Wails v2's Windows naming contract.
const INSTANCE_ID = "wails-app-coteditor-win-thepik-v1";
const report = { status: "FAIL", checks: [], screenshots: [], ownedProcesses: [], cleanup: [] };
const launched = [];
const owned = new Map();
const logs = [];
let directory;
let executable;
let browser;
let page;
let primary;
let reservation;
let expectedDocument;
let interrupted = false;
let cleaning = false;
let pageOwned = false;
const pageErrors = [];

class Skip extends Error {}
function checkInterrupted() {
  if (interrupted && !cleaning) throw new Error("Interrupted; cleaning up only test-owned processes");
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { interrupted = true; });
}
function alive(child) {
  return child?.pid && child.exitCode === null && child.signalCode === null && !child.spawnError;
}
async function bounded(promise, timeout, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timed out after ${timeout}ms`)), timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(label, probe, timeout = STEP_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    checkInterrupted();
    if (primary && !alive(primary) && !cleaning) throw new Error(`${label}: own primary process exited (${primary.exitCode ?? primary.signalCode})`);
    const value = await bounded(probe(), Math.max(1, deadline - Date.now()), label);
    if (value) return value;
    last = value;
    await delay(Math.min(150, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`${label}: timed out after ${timeout}ms (last result: ${String(last)})`);
}
async function powershell(source) {
  const binary = path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const script = `$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n${source}`;
  const { stdout } = await execFileAsync(binary, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, timeout: STEP_TIMEOUT, maxBuffer: 4 * 1024 * 1024,
    // Add-Type's compiler scratch files also belong to this test directory.
    env: directory ? { ...process.env, TEMP: directory, TMP: directory } : process.env,
  });
  return JSON.parse(stdout.trim().replace(/^\uFEFF/, ""));
}
async function snapshot(port = 0) {
  assert(Number.isInteger(port) && port >= 0 && port <= 65535);
  // OpenExisting only observes the mutex; it never creates/acquires the lock.
  // The message-only window identifies its actual owner, including renamed EXEs.
  return powershell(`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CotEditorRegressionProbe {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string name);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
}
'@
$lockExists = $false
try {
  $mutex = [System.Threading.Mutex]::OpenExisting('${INSTANCE_ID}sim')
  $lockExists = $true
  $mutex.Dispose()
} catch [System.Threading.WaitHandleCannotBeOpenedException] { }
$window = [CotEditorRegressionProbe]::FindWindowEx([IntPtr]::new(-3), [IntPtr]::Zero, '${INSTANCE_ID}-sic', '${INSTANCE_ID}-siw')
[uint32]$owner = 0
if ($window -ne [IntPtr]::Zero) { [void][CotEditorRegressionProbe]::GetWindowThreadProcessId($window, [ref]$owner) }
$processes = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; name = $_.Name
    executable = $_.ExecutablePath
    created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
  }
})
$listeners = @()
if (${port} -gt 0) {
  $listeners = @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq ${port} } | ForEach-Object {
    [pscustomobject]@{ pid = [int]$_.OwningProcess; address = $_.LocalAddress }
  })
}
[pscustomobject]@{ lockExists = $lockExists; lockOwner = [int]$owner; processes = $processes; listeners = $listeners } | ConvertTo-Json -Depth 5 -Compress
`);
}
function conflicts(state) {
  const name = path.basename(executable).toLowerCase();
  return state.processes.filter((entry) => !owned.has(entry.pid) && (
    entry.name?.toLowerCase() === name || /coteditor/i.test(entry.name ?? "") ||
    entry.executable?.toLowerCase() === executable.toLowerCase()
  ));
}
function rememberOwned(state) {
  // Only descendants of a directly spawned, still-live process are candidates.
  // Creation timestamps prevent an older process with a recycled parent PID
  // from accidentally becoming eligible for cleanup.
  for (const child of launched.filter(alive)) {
    const entry = state.processes.find((item) => item.pid === child.pid);
    if (entry && Date.parse(entry.created) >= child.startedAt - 2000 &&
        entry.executable?.toLowerCase() === executable.toLowerCase()) owned.set(entry.pid, entry);
  }
  let changed;
  do {
    changed = false;
    for (const entry of state.processes) {
      const parent = owned.get(entry.parent);
      const liveParent = state.processes.find((item) => item.pid === entry.parent && item.created === parent?.created);
      if (!owned.has(entry.pid) && parent && liveParent && entry.created &&
          Date.parse(entry.created) >= Date.parse(parent.created)) {
        owned.set(entry.pid, entry);
        changed = true;
      }
    }
  } while (changed);
  report.ownedProcesses = [...owned.values()];
}
function requireOwnInstance(state) {
  const others = conflicts(state);
  if (others.length) throw new Skip(`Another CotEditor process appeared; do not forward or interact: ${JSON.stringify(others)}`);
  if (!alive(primary) || !owned.has(primary.pid) || !state.lockExists || state.lockOwner !== primary.pid) {
    throw new Skip(`Cannot establish ownership of the Wails single-instance window (owner PID ${state.lockOwner}); no interaction/forwarding allowed`);
  }
}
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  reservation = server;
  return server.address().port;
}
async function releasePort() {
  if (!reservation) return;
  const server = reservation;
  reservation = undefined;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
function launch(args, port, label) {
  checkInterrupted();
  const child = spawn(executable, args, {
    shell: false, cwd: directory, stdio: ["ignore", "pipe", "pipe"],
    // Wails derives the WebView2 data path from %AppData%, and go-webview2
    // passes that path explicitly (the WEBVIEW2_USER_DATA_FOLDER fallback is
    // not consulted then). Redirect APPDATA/LOCALAPPDATA into the test
    // directory so this run cannot touch or contend with the user's profile.
    // Never mutate process.env, the registry, or the user's normal App profile.
    env: { ...process.env,
      APPDATA: path.join(directory, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(directory, "AppData", "Local"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, "webview-profile"),
    },
  });
  child.startedAt = Date.now();
  child.label = label;
  child.on("error", (error) => { child.spawnError = error; logs.push(`${label}: ${error.stack}`); });
  child.stdout.on("data", (data) => logs.push(`${label} stdout: ${data}`));
  child.stderr.on("data", (data) => logs.push(`${label} stderr: ${data}`));
  launched.push(child);
  return child;
}
async function waitForCDP(port) {
  try {
    return await until("WebView2 CDP readiness", async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000), redirect: "error" });
        if (!response.ok) return false;
        const metadata = await response.json();
        if (!metadata.webSocketDebuggerUrl) return false;
        const websocket = new URL(metadata.webSocketDebuggerUrl);
        assert(["127.0.0.1", "localhost", "[::1]"].includes(websocket.hostname) && websocket.protocol === "ws:" && Number(websocket.port) === port,
          "CDP endpoint must stay on the allocated loopback port");
        return metadata;
      } catch (error) {
        if (error.code === "ERR_ASSERTION") throw error;
        return false;
      }
    }, READY_TIMEOUT);
  } catch (error) {
    if (primary?.spawnError) throw primary.spawnError;
    if (interrupted) throw error;
    throw new Skip(`Native CDP unavailable or primary exited (possible single-instance conflict): ${error.message}`);
  }
}
function normalize(file) { return file.replace(/\\/g, "/").toLowerCase(); }
async function waitDocument(file) {
  await page.waitForFunction((name) => {
    const visiblePath = document.querySelector(".sb-path")?.getAttribute("title") ?? "";
    return visiblePath.replace(/\\/g, "/").toLowerCase() === name &&
      document.querySelector('.sb-save[data-state="saved"]') && !document.querySelector(".sb-file-dot.is-dirty");
  }, normalize(file), { timeout: STEP_TIMEOUT });
}
async function waitSaved(file, expected, label) {
  await until(label, async () => {
    let bytes;
    try { bytes = await readFile(file); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    if (!bytes.equals(expected)) return false;
    return page.evaluate((name) => {
      const current = document.querySelector(".sb-path")?.getAttribute("title") ?? "";
      return current.replace(/\\/g, "/").toLowerCase() === name &&
        document.querySelector(".sb-save")?.getAttribute("data-state") === "saved" &&
        !document.querySelector(".sb-file-dot.is-dirty");
    }, normalize(file));
  });
  assert.deepEqual(await readFile(file), expected, label);
  report.checks.push(label);
}
async function checkTitle(file) {
  const name = path.basename(file);
  await page.waitForFunction((name) => document.title.startsWith(`${name} - `) && !document.title.includes(" ·"), name, { timeout: STEP_TIMEOUT });
  const nativeTitle = await until(`native title: ${name}`, async () => {
    const title = await powershell(`$p = Get-Process -Id ${primary.pid}\n$p.MainWindowTitle | ConvertTo-Json -Compress`);
    return title.startsWith(`${name} - `) && !title.includes(" ·") ? title : false;
  });
  report.checks.push(`DOM and native window title: ${nativeTitle}`);
}
async function screenshot(name) {
  const target = path.join(directory, name);
  await page.screenshot({ path: target, timeout: STEP_TIMEOUT });
  report.screenshots.push(target);
}
async function typeSuffix(text) {
  checkInterrupted();
  await waitDocument(expectedDocument.file);
  await page.locator("#editor .monaco-editor .view-lines").click({ position: { x: 50, y: 10 } });
  await page.keyboard.press("Control+End");
  // Real keyboard events; no model.setValue(), synthetic app state or direct saves.
  await page.keyboard.type(text, { delay: 5 });
}
async function menuAction(action) {
  checkInterrupted();
  await waitDocument(expectedDocument.file);
  await page.locator("#menubar > .ce-menu-item").filter({ hasText: /^(Edit|编辑)$/ }).click();
  const dropdown = page.locator(".ce-menu-dropdown");
  const byAction = dropdown.locator(`[data-menu-action="${action}"]`);
  // Edit > Undo/Redo are callback-only menu items in the UI model and therefore
  // carry no data-menu-action; fall back to the bilingual visible label.
  const labels = { undo: /^(撤销|Undo)/, redo: /^(重做|Redo)/ };
  if (await byAction.count()) await byAction.click();
  else await dropdown.locator("button:not(:disabled)").filter({ hasText: labels[action] }).click();
}
async function run() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/regression-native.mjs "E:/absolute/path/CotEditor.exe"');
  if (process.platform !== "win32") throw new Skip("Native acceptance requires Windows/WebView2");
  executable = path.resolve(process.argv[2]);
  assert(/\.exe$/i.test(executable) && (await stat(executable)).isFile(), "Supply an existing built .exe file");
  report.executable = executable;
  directory = await mkdtemp(path.join(os.tmpdir(), "coteditor-native-regression-"));
  report.directory = directory;
  // Pre-create the redirected profile roots so WebView2 does not fall back to
  // any user-visible location when it creates its data directory.
  await mkdir(path.join(directory, "AppData", "Roaming"), { recursive: true });
  await mkdir(path.join(directory, "AppData", "Local"), { recursive: true });
  console.log(`Native regression artifacts (retained): ${directory}`);
  let before;
  try { before = await snapshot(); } catch (error) { throw new Skip(`Cannot safely inspect processes/single-instance lock: ${error.message}`); }
  const existing = conflicts(before);
  if (existing.length || before.lockExists || before.lockOwner) {
    throw new Skip(`Existing CotEditor/single-instance conflict; nothing launched or forwarded. Processes: ${JSON.stringify(existing)}; lock owner: ${before.lockOwner}`);
  }
  const bomFile = path.join(directory, "startup-bom.txt");
  const plainFile = path.join(directory, "forwarded-plain.txt");
  const bom = Buffer.from("\uFEFFnative startup 中文\r\nkeep this line", "utf8");
  const plain = Buffer.from("native forwarded 中文\nplain second line", "utf8");
  const suffix = "XnativeEdit42";
  const plainSuffix = "YforwardEdit42";
  const editedBom = Buffer.concat([bom, Buffer.from(suffix)]);
  const editedPlain = Buffer.concat([plain, Buffer.from(plainSuffix)]);
  await writeFile(bomFile, bom, { flag: "wx" });
  await writeFile(plainFile, plain, { flag: "wx" });
  const port = await reservePort();
  report.port = port;
  // Repeat preflight immediately before launch. Never open a fixture in an
  // already running user instance; port ownership is also verified after bind.
  const finalPreflight = await snapshot();
  if (conflicts(finalPreflight).length || finalPreflight.lockExists || finalPreflight.lockOwner) throw new Skip("CotEditor appeared during preflight; nothing launched");
  await releasePort();
  primary = launch([bomFile], port, "primary");
  expectedDocument = { file: bomFile, bytes: bom };
  const metadata = await waitForCDP(port);
  const state = await snapshot(port);
  rememberOwned(state);
  requireOwnInstance(state);
  assert(state.listeners.length > 0 && state.listeners.every((listener) =>
    owned.has(listener.pid) && ["127.0.0.1", "::1"].includes(listener.address)),
  "CDP listener is not exclusively loopback and owned by the test process tree");
  try {
    browser = await chromium.connectOverCDP(metadata.webSocketDebuggerUrl, { timeout: STEP_TIMEOUT });
  } catch (error) { throw new Skip(`WebView2 refused connectOverCDP: ${error.message}`); }
  page = await until("Wails page availability", async () => {
    for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
      if (await bounded(candidate.evaluate(() => typeof window.go?.main?.App?.StartupFile === "function" && typeof window.runtime?.Quit === "function"), 3000, "probe Wails page")) return candidate;
    }
    return false;
  });
  page.setDefaultTimeout(STEP_TIMEOUT);
  // Reading the public startup binding proves the selected page is the test's
  // startup document, not a browser tab discovered by a generic CDP connection.
  const startup = await bounded(page.evaluate(() => window.go.main.App.StartupFile()), STEP_TIMEOUT, "StartupFile binding");
  assert.equal(typeof startup, "string");
  assert.equal(normalize(startup), normalize(bomFile), "CDP page does not own our startup fixture");
  pageOwned = true;
  page.on("pageerror", (error) => { pageErrors.push(error.message); logs.push(`pageerror: ${error.stack}`); });
  page.on("console", (message) => {
    logs.push(`console ${message.type()}: ${message.text()}`);
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await page.locator("#editor .monaco-editor").waitFor({ state: "visible" });
  await waitDocument(bomFile);
  assert((await page.locator("#editor .view-lines").innerText()).includes("native startup"), "Startup text not rendered");
  await waitSaved(bomFile, bom, "Startup bytes and UTF-8 BOM unchanged before editing");
  await checkTitle(bomFile);
  await screenshot("01-startup.png");
  // Observe real title transitions without replacing any business/runtime API.
  await page.evaluate(() => {
    window.__nativeRegressionTitles = [document.title];
    new MutationObserver(() => window.__nativeRegressionTitles.push(document.title))
      .observe(document.querySelector("title"), { childList: true, subtree: true, characterData: true });
  });
  expectedDocument = { file: bomFile, bytes: editedBom };
  await typeSuffix(suffix);
  await waitSaved(bomFile, editedBom, "Keyboard edit autosaved exact UTF-8 BOM/CRLF bytes");
  expectedDocument = { file: bomFile, bytes: bom };
  await menuAction("undo");
  await waitSaved(bomFile, bom, "Menu Undo autosaved original bytes with BOM");
  expectedDocument = { file: bomFile, bytes: editedBom };
  await menuAction("redo");
  await waitSaved(bomFile, editedBom, "Menu Redo autosaved edited bytes with BOM");
  report.titleTransitions = await page.evaluate(() => window.__nativeRegressionTitles);
  assert(report.titleTransitions.some((title) => title.includes(" ·")), "Dirty title transition missing after real keyboard edit");
  await checkTitle(bomFile);
  await screenshot("02-redo.png");
  const beforeForward = await snapshot();
  rememberOwned(beforeForward);
  requireOwnInstance(beforeForward);
  // Forward only our own fixture, and only to the verified, clean own instance.
  await waitSaved(bomFile, editedBom, "Primary is clean before second-instance forwarding");
  const second = launch([plainFile], port, "forwarder");
  await until("Second instance exits after forwarding", () => !alive(second));
  if (second.spawnError) throw second.spawnError;
  assert.equal(second.exitCode, 0, "Second instance must exit successfully");
  expectedDocument = { file: plainFile, bytes: plain };
  await waitDocument(plainFile);
  assert((await page.locator("#editor .view-lines").innerText()).includes("native forwarded"), "Forwarded text not rendered in original window");
  await waitSaved(plainFile, plain, "Second instance forwarded the plain fixture to the original window");
  await checkTitle(plainFile);
  expectedDocument = { file: plainFile, bytes: editedPlain };
  await typeSuffix(plainSuffix);
  await waitSaved(plainFile, editedPlain, "Forwarded plain UTF-8/LF file autosaved without adding a BOM");
  assert.deepEqual(await readFile(bomFile), editedBom, "Forwarded edit must not overwrite the previous file");
  await screenshot("03-forwarded.png");
  assert.deepEqual(pageErrors, [], "Unexpected native page errors (no noise filtering)");
  const finalState = await snapshot();
  rememberOwned(finalState);
  requireOwnInstance(finalState);
  report.status = "PASS";
}
async function cleanup() {
  cleaning = true;
  await releasePort();
  if (!launched.length) return;
  try { rememberOwned(await snapshot()); } catch (error) { report.cleanup.push(`Process snapshot unavailable: ${error.message}`); }
  if (page && pageOwned && alive(primary)) {
    try {
      const { file, bytes } = expectedDocument;
      await until("Clean document before Quit", async () => {
        if (!(await readFile(file)).equals(bytes)) return false;
        return page.evaluate((name) => {
          const current = document.querySelector(".sb-path")?.getAttribute("title") ?? "";
          return current.replace(/\\/g, "/").toLowerCase() === name &&
            document.querySelector(".sb-save")?.getAttribute("data-state") === "saved" &&
            !document.querySelector(".sb-file-dot.is-dirty");
        }, normalize(file));
      }, 4000);
      try { await bounded(page.evaluate(() => window.runtime.Quit()), 3000, "runtime.Quit"); }
      catch (error) { report.cleanup.push(`Quit response: ${error.message}`); }
      await until("Own primary exits after runtime.Quit", () => !alive(primary), 5000);
      report.cleanup.push("Primary exited through runtime.Quit with verified clean fixture");
    } catch (error) { report.cleanup.push(`Graceful Quit unavailable: ${error.message}`); }
  }
  // Never kill by image name or use /T. Direct children have recorded process
  // handles; descendants additionally require a matching creation timestamp.
  for (const child of launched.filter(alive)) {
    if (!child.kill("SIGKILL")) throw new Error(`Could not terminate own ${child.label} PID ${child.pid}`);
    report.cleanup.push(`Forced termination of directly spawned ${child.label} PID ${child.pid}`);
    await until(`Own PID ${child.pid} exits`, () => !alive(child), 5000);
    if (report.status === "PASS") report.status = "FAIL";
  }
  const identities = [...owned.values()].map(({ pid, created }) => ({ pid, created }));
  if (identities.length) {
    const payload = Buffer.from(JSON.stringify(identities)).toString("base64");
    const killed = await powershell(`
$records = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$killed = @()
foreach ($record in $records) {
  $current = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$record.pid)
  if ($current -and $current.CreationDate.ToUniversalTime().ToString('o') -eq $record.created) {
    Stop-Process -Id ([int]$record.pid) -Force
    $killed += [int]$record.pid
  }
}
ConvertTo-Json -InputObject @($killed) -Compress
`);
    if (killed.length) report.cleanup.push(`Terminated remaining recorded descendants: ${killed.join(", ")}`);
  }
  // For a CDP-connected Browser, close disconnects Playwright. Do this only
  // AFTER own process cleanup, never close pages to dismiss an unknown App.
  // A successful runtime.Quit already tore down the target, so a disconnect
  // error here must not turn an otherwise passing run into a failure.
  if (browser) {
    try { await bounded(browser.close(), 5000, "Disconnect CDP"); }
    catch (error) { report.cleanup.push(`CDP disconnect after Quit: ${error.message}`); }
  }
}
try {
  await run();
} catch (error) {
  report.status = error instanceof Skip ? "SKIP" : "FAIL";
  report.reason = error.stack || String(error);
  if (page && pageOwned && alive(primary)) {
    try { await screenshot("failure.png"); } catch (captureError) { logs.push(`Screenshot failed: ${captureError.message}`); }
  }
} finally {
  try { await cleanup(); } catch (error) {
    report.status = "FAIL";
    report.cleanup.push(`CLEANUP FAILED: ${error.stack}`);
  }
  if (interrupted) { report.status = "FAIL"; report.reason ??= "Interrupted"; }
  report.launched = launched.map((child) => ({ label: child.label, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode }));
  if (directory) {
    try {
      await writeFile(path.join(directory, "process-and-browser.log"), logs.join("\n"));
      await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
    } catch (error) { report.status = "FAIL"; report.reason = `Could not preserve diagnostics: ${error.message}`; }
  }
  console.log(JSON.stringify(report, null, 2));
  // No PASS for an unavailable CDP connection or an unperformed native test.
  process.exitCode = report.status === "PASS" ? 0 : report.status === "SKIP" ? 2 : 1;
}
