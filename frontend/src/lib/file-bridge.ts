/**
 * File IO bridge.
 *
 * Abstracts file open/save so the rest of the app doesn't care whether it's
 * running inside the Wails native window or in a plain browser (dev server).
 *
 * - Wails mode: calls the Go methods bound in app.go through the generated
 *   `wailsjs/go/main/App.js` wrappers. Saves are encoding-aware: content is a
 *   BOM-free JS string and the encoding label (e.g. "UTF-8 BOM", "UTF-16LE")
 *   tells Go which BOM/byte representation to write.
 * - Browser mode (dev fallback): uses the File System Access API. Handles are
 *   cached per path so Save targets the tab's own file instead of whichever
 *   file was opened last. Only UTF-8/UTF-8-BOM are writable here; the native
 *   window is the encoding-aware path.
 */

import type { main } from "../wailsjs/go/models";
import * as WailsApp from "../wailsjs/go/main/App";

/** Disk baseline used for external-change detection (mirrors Go `FileStamp`). */
export interface FileStamp {
  exists: boolean;
  size: number;
  mod_time: number;
}

/** Stable error prefix shared with the Go save transaction. */
export const FILE_CONFLICT_CODE = "FILE_CONFLICT";

/** True when a rejected checked save means "the disk changed underneath us". */
export function isFileConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(FILE_CONFLICT_CODE);
}

function conflictError(path: string): Error {
  return new Error(`${FILE_CONFLICT_CODE}: "${path}" changed on disk; refusing to overwrite it`);
}

/** Result of opening a file - mirrors the Go `FileContent` struct. */
export interface FileContent {
  /** Absolute path, or a synthetic handle name in browser mode. */
  path: string | null;
  /** Decoded text without a BOM (the encoding label carries BOM membership). */
  content: string;
  encoding: string;
  line_ending: "lf" | "crlf" | "cr";
  /** True when the file mixes line-ending styles. */
  mixed_line_ending: boolean;
}

/** Detect whether we're running inside Wails (the native window). */
export function isWails(): boolean {
  return typeof window !== "undefined" && "go" in window;
}

/**
 * External-change polling needs trustworthy stat information. The browser
 * fallback only knows files it holds a picker handle for, so monitoring is
 * native-only; browser regressions keep their previous save behaviour.
 */
export function isFileStampAvailable(): boolean {
  return isWails();
}

function cancelledError(): DOMException {
  return new DOMException("File picker cancelled", "AbortError");
}

/* -------------------------------- Wails path ------------------------------ */

function fromWails(r: main.FileContent): FileContent {
  return {
    path: r.path ?? null,
    content: r.content,
    encoding: r.encoding,
    line_ending: normalizeLe(r.line_ending),
    mixed_line_ending: r.mixed_line_ending === true,
  };
}

function stampFromWails(r: main.FileStamp): FileStamp {
  return {
    exists: r.exists === true,
    size: Number(r.size) || 0,
    mod_time: Number(r.mod_time) || 0,
  };
}

async function wailsOpen(): Promise<FileContent> {
  const result = fromWails(await WailsApp.OpenFile());
  // The Go bridge represents a cancelled native picker with a nil path. Do
  // not let that sentinel replace the current buffer with an empty document.
  if (!result.path) throw cancelledError();
  return result;
}

/**
 * Returns the file path passed on the command line when the app was launched
 * (e.g. double-clicking a file in Explorer), or null if none. Wails-only;
 * the browser dev path never has a startup file.
 */
export async function startupFile(): Promise<string | null> {
  if (!isWails()) return null;
  const path = await WailsApp.StartupFile();
  return path ?? null;
}

/**
 * Loads a file at the given absolute path without prompting. Used by the
 * "app:open-path"/"app:open-paths" handlers and the Open Recent menu.
 */
export async function openPath(path: string): Promise<FileContent> {
  if (!isWails()) {
    throw new Error("openPath is only available inside the Wails native window.");
  }
  return fromWails(await WailsApp.OpenPath(path));
}

/**
 * Re-read a file with an explicit encoding label. Used by the encoding menu and
 * by external-change reloads, where auto-detection could reinterpret the bytes.
 */
export async function openPathWithEncoding(
  path: string,
  encoding: string,
): Promise<FileContent> {
  if (isWails()) {
    return fromWails(await WailsApp.OpenPathWithEncoding(path, encoding));
  }
  const handle = handlesByPath.get(handleKey(path));
  if (!handle) throw new Error("reopen is only available for files opened in this tab.");
  const file = await handle.getFile();
  let content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    .decode(await file.arrayBuffer());
  let detected = "UTF-8";
  if (encoding.toUpperCase() === "UTF-8 BOM" && content.startsWith("\uFEFF")) {
    content = content.slice(1);
    detected = "UTF-8 BOM";
  }
  if (encoding !== "UTF-8" && encoding !== "UTF-8 BOM") {
    throw new Error(`Encoding ${encoding} is only readable in the native window.`);
  }
  return {
    path: file.name,
    content,
    encoding: detected,
    line_ending: detectLineEnding(content),
    mixed_line_ending: detectMixedLineEnding(content),
  };
}

/**
 * Current disk baseline. Browser mode reads the retained handle; a path without
 * a handle reports "absent" and is captured again on the next open/save.
 */
export async function fileStamp(path: string): Promise<FileStamp> {
  if (isWails()) return stampFromWails(await WailsApp.FileStamp(path));
  const handle = handlesByPath.get(handleKey(path));
  if (!handle) return { exists: false, size: 0, mod_time: 0 };
  const file = await handle.getFile();
  return {
    exists: true,
    size: Number(file.size) || 0,
    mod_time: Number(file.lastModified) || 0,
  };
}

/* ------------------------------ Browser path ------------------------------ */

// One handle per opened/saved file so each tab's Save writes to its own target.
const handlesByPath = new Map<string, FileSystemFileHandle>();

function handleKey(path: string): string {
  return path.trim().replace(/\//g, "\\").toLowerCase();
}

function normalizeLe(s: string): "lf" | "crlf" | "cr" {
  return s === "crlf" || s === "cr" ? s : "lf";
}

function detectLineEnding(text: string): "lf" | "crlf" | "cr" {
  if (text.includes("\r\n")) return "crlf";
  if (text.includes("\r")) return "cr";
  return "lf";
}

function detectMixedLineEnding(text: string): boolean {
  return new Set(text.match(/\r\n|\r|\n/g) ?? []).size > 1;
}

async function browserOpen(): Promise<FileContent> {
  const picker = (window as unknown as {
    showOpenFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle[]>;
  }).showOpenFilePicker;
  if (!picker) {
    throw new Error(
      "File System Access API unavailable. Run inside Wails or use a Chromium browser.",
    );
  }
  const [handle] = await picker();
  if (!handle) throw cancelledError();
  const file = await handle.getFile();
  // ignoreBOM=true means keep U+FEFF in the decoded string so this bridge can
  // fold it into the encoding label exactly like the Go decoder does.
  let content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    .decode(await file.arrayBuffer());
  if (content.includes("\0")) throw new Error("NUL/binary files are not supported.");
  let encoding = "UTF-8";
  if (content.startsWith("\uFEFF")) {
    content = content.slice(1);
    encoding = "UTF-8 BOM";
  }
  const result: FileContent = {
    path: file.name,
    content,
    encoding,
    line_ending: detectLineEnding(content),
    mixed_line_ending: detectMixedLineEnding(content),
  };
  handlesByPath.set(handleKey(file.name), handle);
  return result;
}

async function writeHandle(
  handle: FileSystemFileHandle,
  content: string,
  encoding: string,
): Promise<string> {
  if (encoding !== "UTF-8" && encoding !== "UTF-8 BOM") {
    throw new Error(
      `Encoding ${encoding} is only writable in the native window.`,
    );
  }
  // The app string is BOM-free; the browser fallback re-adds the BOM the Go
  // backend would add for the same encoding label.
  const text = encoding === "UTF-8 BOM" ? `\uFEFF${content}` : content;
  const writable = await handle.createWritable();
  try {
    await writable.write(text);
    await writable.close();
    return handle.name;
  } catch (error) {
    // Abort the staged write where supported; never acknowledge a failed close.
    try { await writable.abort(); } catch { /* retain the original failure */ }
    throw error;
  }
}

async function browserSaveAsWithEncoding(
  content: string,
  encoding: string,
): Promise<string> {
  const picker = (window as unknown as {
    showSaveFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle>;
  }).showSaveFilePicker;
  if (!picker) {
    throw new Error(
      "File System Access API unavailable. Run inside Wails or use a Chromium browser.",
    );
  }
  const handle = await picker();
  if (!handle) throw cancelledError();
  const savedTo = await writeHandle(handle, content, encoding);
  // Commit the destination only after BOTH write and close succeeded.
  handlesByPath.set(handleKey(savedTo), handle);
  return savedTo;
}

async function browserSaveWithEncoding(
  path: string | null,
  content: string,
  encoding: string,
): Promise<string> {
  const handle = path ? handlesByPath.get(handleKey(path)) : undefined;
  if (handle) return writeHandle(handle, content, encoding);
  // A path without a retained handle (or an untitled buffer) must prompt.
  return browserSaveAsWithEncoding(content, encoding);
}

/** Drop cached browser handles (used by headless tests/reset paths). */
export function resetFileHandle(): void {
  handlesByPath.clear();
}

/* ----------------------------- public API -------------------------------- */

export async function openFile(): Promise<FileContent> {
  return isWails() ? wailsOpen() : browserOpen();
}

/**
 * Prompt for a file and decode it with an explicit encoding label instead of
 * auto-detection. Native only: the browser fallback has no encoding picker and
 * would silently ignore the requested label, so it fails loudly instead.
 */
export async function openFileWithEncoding(encoding: string): Promise<FileContent> {
  if (!isWails()) {
    throw new Error("Open with encoding is only available inside the Wails native window.");
  }
  const result = fromWails(await WailsApp.OpenFileWithEncoding(encoding));
  // A cancelled native picker returns a nil path; never replace the buffer
  // with an empty document.
  if (!result.path) throw cancelledError();
  return result;
}

export async function saveFileWithEncoding(
  path: string | null,
  content: string,
  encoding: string,
): Promise<string> {
  if (isWails()) {
    const savedTo = await WailsApp.SaveFileWithEncoding(path ?? "", content, encoding);
    if (!savedTo) throw cancelledError();
    return savedTo;
  }
  return browserSaveWithEncoding(path, content, encoding);
}

export async function saveAsWithEncoding(
  content: string,
  encoding: string,
): Promise<string> {
  if (isWails()) {
    const savedTo = await WailsApp.SaveAsWithEncoding(content, encoding);
    if (!savedTo) throw cancelledError();
    return savedTo;
  }
  return browserSaveAsWithEncoding(content, encoding);
}

/**
 * Stamp-checked save for an existing path. `baseline === null` disables the
 * check (the caller has no trustworthy baseline yet); a baseline with
 * `exists: false` means the file is expected to be absent.
 */
export async function saveFileChecked(
  path: string,
  content: string,
  encoding: string,
  baseline: FileStamp | null,
): Promise<string> {
  if (isWails()) {
    const expectedSize = baseline === null ? -1 : baseline.exists ? baseline.size : 0;
    const expectedModTime = baseline === null ? -1 : baseline.exists ? baseline.mod_time : 0;
    const savedTo = await WailsApp.SaveFileChecked(
      path,
      content,
      encoding,
      expectedSize,
      expectedModTime,
    );
    if (!savedTo) throw cancelledError();
    return savedTo;
  }

  const handle = handlesByPath.get(handleKey(path));
  if (!handle) return browserSaveAsWithEncoding(content, encoding);
  if (baseline && baseline.exists) {
    const current = await fileStamp(path);
    if (!current.exists || current.size !== baseline.size || current.mod_time !== baseline.mod_time) {
      throw conflictError(path);
    }
  }
  if (baseline && !baseline.exists) {
    const current = await fileStamp(path);
    if (current.exists) throw conflictError(path);
  }
  return writeHandle(handle, content, encoding);
}

/**
 * Save As through the native picker. The destination is chosen explicitly in
 * that dialog, so the checked variant deliberately skips the stamp comparison:
 * the native overwrite confirmation already owns that decision.
 */
export async function saveAsChecked(
  content: string,
  encoding: string,
): Promise<string> {
  if (isWails()) {
    const savedTo = await WailsApp.SaveAsChecked(content, encoding, -1, -1);
    if (!savedTo) throw cancelledError();
    return savedTo;
  }
  return browserSaveAsWithEncoding(content, encoding);
}

/** Backwards-compatible UTF-8 helpers (existing callers/tests). */
export async function saveFile(
  path: string | null,
  content: string,
): Promise<string> {
  return saveFileWithEncoding(path, content, "UTF-8");
}

export async function saveAsFile(content: string): Promise<string> {
  return saveAsWithEncoding(content, "UTF-8");
}

/** Keep the native close guard in sync with the whole tab session. */
export async function setSessionDirty(dirty: boolean): Promise<void> {
  if (!isWails()) return;
  await WailsApp.SetSessionDirty(dirty);
}

/** Legacy per-active-document state (kept for compatibility). */
export async function setDocumentState(
  path: string | null,
  dirty: boolean,
  language: "en" | "zh",
): Promise<void> {
  if (!isWails()) return;
  await WailsApp.SetDocumentState(path ?? "", dirty, language);
}
