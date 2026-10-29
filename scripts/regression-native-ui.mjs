// Native Windows UI acceptance for an ALREADY BUILT CotEditor executable.
//
// Usage:
//   node scripts/regression-native-ui.mjs ["E:/path/to/coteditor-win.exe"]
//   npm run regression:native-ui
//
// This suite deliberately avoids CDP/Playwright: Wails clears
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS for production binaries, so the older
// CDP-based regression-native.mjs can only SKIP. Everything below drives the
// real window instead: user32 focuses/clicks the editor, WScript.Shell sends
// real keystrokes, and the suite observes on-disk bytes and the native title.
//
// Safety: only the PIDs spawned by this script are ever focused, clicked,
// closed or (after a failed graceful close) killed. It never uses taskkill, a
// process-name kill, forwarding into a pre-existing user instance, or any file
// outside the unique os.tmpdir() fixture directory.
//
// Exit codes: 0 = PASS, 1 = FAIL, 2 = SKIP (focus cannot be established or a
// pre-existing CotEditor instance makes safe interaction impossible).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_EXE = "build/bin/coteditor-win.exe";
const READY_TIMEOUT = 45000;
const TITLE_TIMEOUT = 20000;
const FOCUS_TIMEOUT = 15000;
const AUTOSAVE_TIMEOUT = 25000;
const CLOSE_TIMEOUT = 10000;
const INSTANCE_ID = "coteditor-win-thepik-v1";
const POWERSHELL = path.join(
  process.env.SystemRoot || "C:/Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);

const report = {
  status: "FAIL",
  checks: [],
  cleanup: [],
  launched: [],
  directory: null,
  executable: null,
};
const logs = [];
const children = [];
let directory;
let executable;
let primary;
let second;
let cleaning = false;
let interrupted = false;

class Skip extends Error {}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = true;
  });
}

function checkInterrupted() {
  if (interrupted && !cleaning) throw new Error("Interrupted; cleaning up test-owned PIDs only");
}

function alive(child) {
  return !!child?.pid && child.exitCode === null && child.signalCode === null && !child.spawnError;
}

async function powershell(source, timeout = 15000) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    source,
  ].join("\n");
  const { stdout, stderr } = await execFileAsync(
    POWERSHELL,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")],
    {
      windowsHide: true,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: directory
        ? { ...process.env, TEMP: directory, TMP: directory }
        : process.env,
    },
  );
  if (stderr?.trim()) logs.push(`powershell stderr: ${stderr.trim()}`);
  const text = stdout.replace(/^\uFEFF/, "").trim();
  if (!text) return null;
  return JSON.parse(text);
}

function recentAppLogs(count = 6) {
  return logs.slice(-count).join(" | ");
}

async function until(label, probe, timeout) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    checkInterrupted();
    if (primary && !alive(primary) && !cleaning) {
      const detail = recentAppLogs();
      throw new Error(`${label}: own primary process exited early (${primary.exitCode ?? primary.signalCode})${detail ? `: ${detail}` : ""}`);
    }
    try {
      const value = await probe();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error.message;
    }
    await delay(200);
  }
  const error = new Error(`${label}: timed out after ${timeout}ms (last: ${String(last)})`);
  error.code = "ETIMEOUT";
  throw error;
}

function appEnvironment() {
  const env = {
    ...process.env,
    APPDATA: path.join(directory, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(directory, "AppData", "Local"),
    WEBVIEW2_USER_DATA_FOLDER: path.join(directory, "webview-profile"),
    TEMP: directory,
    TMP: directory,
  };
  // Production Wails builds clear this variable anyway; omit it explicitly so
  // this suite can never depend on a debug port from the caller's environment.
  delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  return env;
}

function launch(args, label) {
  checkInterrupted();
  const child = spawn(executable, args, {
    cwd: directory,
    shell: false,
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: appEnvironment(),
  });
  child.label = label;
  child.startedAt = Date.now();
  child.on("error", (error) => {
    child.spawnError = error;
    logs.push(`${label}: ${error.stack}`);
  });
  child.stdout.on("data", (data) => logs.push(`${label} stdout: ${data}`));
  child.stderr.on("data", (data) => logs.push(`${label} stderr: ${data}`));
  children.push(child);
  return child;
}

async function preflight() {
  // OpenExisting only observes the Wails single-instance mutex. A pre-existing
  // user instance would receive our fixture path through forwarding, so this
  // suite refuses to launch in that case.
  const result = await powershell(`
$exists = $false
$errorText = ''
try {
  $mutex = [System.Threading.Mutex]::OpenExisting('${INSTANCE_ID}sim')
  $exists = $true
  $mutex.Dispose()
} catch [System.Threading.WaitHandleCannotBeOpenedException] {
} catch {
  $errorText = $_.Exception.Message
}
$sameExe = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
  try { $_.Path -and ($_.Path -ieq '${executable.replace(/'/g, "''")}') } catch { $false }
} | ForEach-Object { [int]$_.Id })
[pscustomobject]@{ lockExists = $exists; error = $errorText; sameExe = $sameExe } | ConvertTo-Json -Compress
`);
  if (result.error) {
    throw new Skip(`Cannot safely inspect the single-instance lock: ${result.error}`);
  }
  if (result.lockExists || (result.sameExe?.length ?? 0) > 0) {
    throw new Skip(`An existing CotEditor instance is running (lock=${result.lockExists}, pids=${JSON.stringify(result.sameExe)}); refusing to launch or forward`);
  }
}

async function windowState(pid) {
  return powershell(`
$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue
if ($null -eq $p) {
  $value = [pscustomobject]@{ exists = $false; handle = [int64]0; title = ''; responding = $false }
} else {
  $value = [pscustomobject]@{
    exists = $true
    handle = [int64]$p.MainWindowHandle
    title = [string]$p.MainWindowTitle
    responding = [bool]$p.Responding
  }
}
$value | ConvertTo-Json -Compress
`);
}

const USER32 = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CotEditorNativeUi {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
}
'@
`;

async function clickEditor(pid, handle) {
  return powershell(`
${USER32}
$pidValue = ${Number(pid)}
$handleValue = [IntPtr]::new([int64]${Number(handle)})
if (-not [CotEditorNativeUi]::IsWindow($handleValue)) {
  [pscustomobject]@{ focused = $false; reason = 'window handle is no longer valid' } | ConvertTo-Json -Compress
  return
}
[uint32]$windowOwner = 0
[void][CotEditorNativeUi]::GetWindowThreadProcessId($handleValue, [ref]$windowOwner)
if ($windowOwner -ne $pidValue) {
  [pscustomobject]@{ focused = $false; reason = "window no longer belongs to PID $pidValue (owner $windowOwner)" } | ConvertTo-Json -Compress
  return
}
[void][CotEditorNativeUi]::ShowWindow($handleValue, 9)
[void][CotEditorNativeUi]::SetForegroundWindow($handleValue)
try {
  $shell = New-Object -ComObject WScript.Shell
  [void]$shell.AppActivate($pidValue)
} catch { }
Start-Sleep -Milliseconds 250
[uint32]$owner = 0
[void][CotEditorNativeUi]::GetWindowThreadProcessId([CotEditorNativeUi]::GetForegroundWindow(), [ref]$owner)
if ($owner -ne $pidValue) {
  [pscustomobject]@{ focused = $false; reason = "foreground owner $owner"; foregroundPid = [int]$owner } | ConvertTo-Json -Compress
  return
}
$rect = New-Object CotEditorNativeUi+RECT
if (-not [CotEditorNativeUi]::GetWindowRect($handleValue, [ref]$rect)) {
  [pscustomobject]@{ focused = $false; reason = 'GetWindowRect failed' } | ConvertTo-Json -Compress
  return
}
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 200 -or $height -lt 200) {
  [pscustomobject]@{ focused = $false; reason = "window too small ($width x $height)" } | ConvertTo-Json -Compress
  return
}
$x = [int]($rect.Left + $width * 0.5)
$y = [int]($rect.Top + $height * 0.55)
[void][CotEditorNativeUi]::SetCursorPos($x, $y)
[CotEditorNativeUi]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[CotEditorNativeUi]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 250
[uint32]$after = 0
[void][CotEditorNativeUi]::GetWindowThreadProcessId([CotEditorNativeUi]::GetForegroundWindow(), [ref]$after)
[pscustomobject]@{
  focused = [bool]($after -eq $pidValue)
  foregroundPid = [int]$after
  x = $x
  y = $y
  width = $width
  height = $height
} | ConvertTo-Json -Compress
`, FOCUS_TIMEOUT);
}

async function sendKeys(keys, intervalMs = 120) {
  const payload = Buffer.from(JSON.stringify(keys), "utf8").toString("base64");
  await powershell(`
$keys = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$shell = New-Object -ComObject WScript.Shell
foreach ($key in @($keys)) {
  $shell.SendKeys([string]$key)
  Start-Sleep -Milliseconds ${Number(intervalMs)}
}
'{"sent":true}' | ConvertTo-Json -Compress
`, 20000);
}

async function focusEditor(pid, handle, label) {
  const deadline = Date.now() + FOCUS_TIMEOUT;
  let last;
  while (Date.now() < deadline) {
    checkInterrupted();
    if (!alive(primary)) {
      const detail = recentAppLogs();
      throw new Error(`${label}: own primary PID exited early (${primary.exitCode ?? primary.signalCode})${detail ? `: ${detail}` : ""}`);
    }
    last = await clickEditor(pid, handle);
    if (last?.focused) {
      report.checks.push(`${label}: foreground PID ${pid}, clicked editor at (${last.x},${last.y}) inside ${last.width}x${last.height}`);
      return last;
    }
    await delay(300);
  }
  // A locked workstation, secure desktop or another foreground app makes real
  // keyboard/mouse input impossible. That is a SKIP, never a pass: no editing
  // or file assertions were performed.
  throw new Skip(`${label}: could not establish foreground/focus for PID ${pid} (${last?.reason ?? "unknown"}; foreground PID ${last?.foregroundPid ?? "?"})`);
}

async function enableAutoSave(pid, handle) {
  // Real menu interaction: F10 opens the custom menubar, Home selects the first
  // top-level menu (File), Enter opens it, five Down moves reach Auto Save
  // (after New/Open/Save/Save As/Close Tab), and Enter toggles the checkable
  // item. The dropdown closes and refocuses the editor. This is genuine UI
  // input, not a settings write.
  await focusEditor(pid, handle, "Focus before opening the native menu");
  await sendKeys(["{F10}"], 300);
  await sendKeys(["{HOME}"], 200);
  await sendKeys(["{ENTER}"], 300);
  await sendKeys(["{DOWN}", "{DOWN}", "{DOWN}", "{DOWN}", "{DOWN}"], 220);
  await sendKeys(["{ENTER}"], 350);
  await delay(700);
  await focusEditor(pid, handle, "Focus after enabling Auto Save");
  report.checks.push("Auto Save toggled through real menubar keystrokes");
}

function cleanTitle(title, file) {
  return title.includes(path.basename(file)) && !title.includes("·");
}

async function waitForTitle(pid, file, { clean = true, timeout = TITLE_TIMEOUT, label = "native title" } = {}) {
  const title = await until(label, async () => {
    const state = await windowState(pid);
    if (!state.exists) return false;
    const value = state.title ?? "";
    const matches = value.includes(path.basename(file));
    if (!matches || (clean && value.includes("·"))) return false;
    return value;
  }, timeout);
  report.checks.push(`${label}: ${title}`);
  return title;
}

async function waitForFile(file, expected, label, timeout = AUTOSAVE_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    checkInterrupted();
    try {
      last = await readFile(file);
      if (last.equals(expected)) {
        report.checks.push(label);
        return;
      }
    } catch (error) {
      last = error.message;
    }
    await delay(200);
  }
  const actual = Buffer.isBuffer(last) ? last.toString("hex") : String(last);
  throw new Error(`${label}: timed out (actual hex: ${actual})`);
}

function assertBomCrlf(bytes, label) {
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${label}: UTF-8 BOM prefix`);
  assert(bytes.includes(Buffer.from("\r\n", "latin1")), `${label}: CRLF terminator`);
  report.checks.push(`${label}: BOM + CRLF byte layout verified`);
}

async function waitForExit(child, timeout, label) {
  if (!child) return null;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`${label}: did not exit within ${timeout}ms`));
    }, timeout);
    function onExit(code, signal) {
      clearTimeout(timer);
      resolve({ code, signal });
    }
    child.once("exit", onExit);
  });
}

async function closeGracefully(child) {
  if (!child?.pid || !alive(child)) return true;
  const closed = await powershell(`
$p = Get-Process -Id ${Number(child.pid)} -ErrorAction SilentlyContinue
if ($null -eq $p) { $result = $false } else { $result = [bool]$p.CloseMainWindow() }
[pscustomobject]@{ requested = $result } | ConvertTo-Json -Compress
`);
  if (!closed?.requested) {
    report.cleanup.push(`${child.label} PID ${child.pid}: CloseMainWindow returned false`);
    return false;
  }
  try {
    await waitForExit(child, CLOSE_TIMEOUT, `${child.label} graceful close`);
    report.cleanup.push(`${child.label} PID ${child.pid}: closed via CloseMainWindow`);
    return true;
  } catch (error) {
    report.cleanup.push(`${child.label} PID ${child.pid}: ${error.message}`);
    return false;
  }
}

async function run() {
  const argument = process.argv[2] ?? DEFAULT_EXE;
  if (process.argv.length > 3) {
    throw new Error('Usage: node scripts/regression-native-ui.mjs ["E:/path/to/coteditor-win.exe"]');
  }
  if (process.platform !== "win32") throw new Skip("Native UI acceptance requires Windows");
  executable = path.resolve(argument);
  assert(/\.exe$/i.test(executable) && (await stat(executable)).isFile(),
    `Not an existing built .exe: ${executable}`);
  report.executable = executable;

  directory = await mkdtemp(path.join(os.tmpdir(), "coteditor-native-ui-"));
  report.directory = directory;
  await mkdir(path.join(directory, "AppData", "Roaming"), { recursive: true });
  await mkdir(path.join(directory, "AppData", "Local"), { recursive: true });
  await mkdir(path.join(directory, "webview-profile"), { recursive: true });
  console.log(`Native UI acceptance artifacts (retained): ${directory}`);
  console.log(`Executable: ${executable}`);

  await preflight();

  const bomFile = path.join(directory, "native-ui-bom-crlf.txt");
  const plainFile = path.join(directory, "native-ui-plain-lf.txt");
  const original = Buffer.from("\uFEFFnative ui 中文\r\nsecond line stays", "utf8");
  const suffix = "Qz7";
  const edited = Buffer.concat([original, Buffer.from(suffix, "utf8")]);
  const plain = Buffer.from("forwarded native 中文\nsecond line stays", "utf8");
  await writeFile(bomFile, original, { flag: "wx" });
  await writeFile(plainFile, plain, { flag: "wx" });
  assertBomCrlf(original, "Fixture is UTF-8 BOM + CRLF");

  primary = launch([bomFile], "primary");
  const initial = await until("primary native window", async () => {
    const state = await windowState(primary.pid);
    return state.exists && state.handle ? state : false;
  }, READY_TIMEOUT);
  report.launched.push({ label: "primary", pid: primary.pid });
  report.checks.push(`Primary window appeared (HWND ${initial.handle})`);
  const handle = initial.handle;

  await waitForTitle(primary.pid, bomFile, { clean: true, label: "Startup title shows fixture and no dirty marker" });

  await enableAutoSave(primary.pid, handle);

  // Click the editor and type through WScript.Shell. Ctrl+End first makes the
  // suffix deterministic even though the focus click placed a caret.
  await focusEditor(primary.pid, handle, "Focus before keyboard edit");
  await sendKeys(["^{END}"], 150);
  await sendKeys(["Q", "z", "7"], 120);
  report.checks.push("Typed Qz7 with WScript.Shell SendKeys at 120ms per character");

  // Either the dirty title or the saved bytes proves the keystrokes reached
  // the editor. If neither happens, focus/input was not actually established.
  const observed = await until("keystrokes reached the editor", async () => {
    try {
      if ((await readFile(bomFile)).equals(edited)) return "saved";
    } catch { /* keep polling */ }
    const state = await windowState(primary.pid);
    return state.exists && (state.title ?? "").includes("·") ? "dirty" : false;
  }, 8000).catch((error) => {
    if (error.code === "ETIMEOUT") return false;
    throw error;
  });
  if (!observed) {
    throw new Skip("Editor did not receive the real keystrokes (dirty title and file bytes unchanged); cannot verify native editing");
  }
  if (observed === "dirty") {
    report.checks.push("Dirty title marker appeared after real typing");
  }

  await waitForFile(bomFile, edited, "Auto-save wrote exact edited bytes (BOM + CRLF + Qz7 suffix)");
  const editedOnDisk = await readFile(bomFile);
  assertBomCrlf(editedOnDisk, "Edited file");
  assert(editedOnDisk.subarray(3).toString("utf8").endsWith(suffix), "Edited file ends with Qz7");
  await waitForTitle(primary.pid, bomFile, { clean: true, label: "Saved title shows fixture and no dirty marker" });

  await sendKeys(["^{z}"], 200);
  await waitForFile(bomFile, original, "Ctrl+Z auto-saved the original bytes");
  assertBomCrlf(await readFile(bomFile), "Undone file");
  await waitForTitle(primary.pid, bomFile, { clean: true, label: "Undo title shows fixture and no dirty marker" });

  const bomBeforeSecond = await readFile(bomFile);
  assert.deepEqual(bomBeforeSecond, original, "Original BOM file is restored before second instance");

  // The second instance forwards its fixture into the verified primary window
  // and must exit 0 by itself. Only its own PID is observed.
  second = launch([plainFile], "forwarder");
  report.launched.push({ label: "forwarder", pid: second.pid });
  const forwardExit = await waitForExit(second, TITLE_TIMEOUT, "second instance exit");
  assert.equal(forwardExit.code, 0, `Second instance must exit 0, got ${forwardExit.code}/${forwardExit.signal}`);
  report.checks.push("Second instance exited 0 after forwarding");

  await waitForTitle(primary.pid, plainFile, { clean: true, label: "Main window switched to the plain fixture" });

  assert.deepEqual(await readFile(plainFile), plain, "Forwarded LF/no-BOM fixture was not modified");
  assert.deepEqual(await readFile(bomFile), bomBeforeSecond, "Opening the second file did not overwrite the BOM fixture");
  assertBomCrlf(await readFile(bomFile), "Previous BOM fixture after forwarding");
  report.checks.push("Previous BOM file and forwarded LF file are byte-identical to expectations");

  // Leave no dirty buffers behind before the graceful close.
  await waitForTitle(primary.pid, plainFile, { clean: true, label: "Primary is clean before CloseMainWindow" });
  report.status = "PASS";
}

async function cleanup() {
  cleaning = true;
  if (second && alive(second)) {
    try {
      const closed = await closeGracefully(second);
      if (!closed) {
        second.kill("SIGKILL");
        report.cleanup.push(`forwarder PID ${second.pid}: killed own PID after failed close`);
        if (report.status === "PASS") report.status = "FAIL";
      }
    } catch (error) {
      report.cleanup.push(`forwarder cleanup: ${error.stack}`);
      report.status = "FAIL";
    }
  }
  if (primary && alive(primary)) {
    try {
      const closed = await closeGracefully(primary);
      if (!closed) {
        primary.kill("SIGKILL");
        report.cleanup.push(`primary PID ${primary.pid}: killed own PID after failed close`);
        if (report.status === "PASS") report.status = "FAIL";
      }
    } catch (error) {
      report.cleanup.push(`primary cleanup: ${error.stack}`);
      report.status = "FAIL";
    }
  }
  for (const child of children) {
    if (alive(child)) {
      child.kill("SIGKILL");
      report.cleanup.push(`${child.label} PID ${child.pid}: final own-PID kill`);
      if (report.status === "PASS") report.status = "FAIL";
    }
  }
  if (primary && primary.exitCode !== null) {
    report.cleanup.push(`primary exit code ${primary.exitCode}`);
  }
  if (second && second.exitCode !== null) {
    report.cleanup.push(`forwarder exit code ${second.exitCode}`);
  }
}

try {
  await run();
} catch (error) {
  const skipped = error instanceof Skip;
  report.status = skipped ? "SKIP" : "FAIL";
  report.reason = skipped ? error.message : error.stack || String(error);
} finally {
  try {
    await cleanup();
  } catch (error) {
    report.status = "FAIL";
    report.cleanup.push(`CLEANUP FAILED: ${error.stack}`);
  }
  if (interrupted) {
    report.status = "FAIL";
    report.reason ??= "Interrupted";
  }
  report.launched = children.map((child) => ({
    label: child.label,
    pid: child.pid,
    exitCode: child.exitCode,
    signal: child.signalCode,
  }));
  if (directory) {
    try {
      await writeFile(path.join(directory, "native-ui.log"), logs.join("\n"));
      await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
    } catch (error) {
      report.status = "FAIL";
      report.reason = `Could not preserve diagnostics: ${error.message}`;
    }
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "PASS" ? 0 : report.status === "SKIP" ? 2 : 1;
}
