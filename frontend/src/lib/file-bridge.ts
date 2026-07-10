/**
 * File IO bridge.
 *
 * Abstracts file open/save so the rest of the app doesn't care whether it's
 * running inside the Wails native window or in a plain browser (dev server).
 *
 * - Wails mode: calls the Go methods bound in app.go (OpenFile / SaveFile /
 *   SaveAs / NewFile) via the generated `wailsjs/go/main/App.js` wrappers.
 * - Browser mode (dev fallback): uses the File System Access API
 *   (`showOpenFilePicker` / `showSaveFilePicker`), available in Chromium-based
 *   browsers.
 *
 * Wails mode is active whenever the generated Wails runtime is present
 * (`window.go` is injected by Wails). Otherwise we assume a browser.
 */

import type { main } from "../wailsjs/go/models";
import * as WailsApp from "../wailsjs/go/main/App";

/** Result of opening a file - mirrors the Go `FileContent` struct. */
export interface FileContent {
  /** Absolute path, or a synthetic handle name in browser mode. */
  path: string | null;
  content: string;
  encoding: string;
  line_ending: "lf" | "crlf" | "cr";
}

/** Detect whether we're running inside Wails (the native window). */
export function isWails(): boolean {
  return typeof window !== "undefined" && "go" in window;
}

/* -------------------------------- Wails path ------------------------------ */

function fromWails(r: main.FileContent): FileContent {
  return {
    path: r.path ?? null,
    content: r.content,
    encoding: r.encoding,
    line_ending: normalizeLe(r.line_ending),
  };
}

async function wailsOpen(): Promise<FileContent> {
  return fromWails(await WailsApp.OpenFile());
}

async function wailsSave(path: string, content: string): Promise<string> {
  return WailsApp.SaveFile(path, content);
}

async function wailsSaveAs(content: string): Promise<string> {
  return WailsApp.SaveAs(content);
}

/* ------------------------------ Browser path ------------------------------ */

// The File System Access API keeps a FileSystemFileHandle that we cache per
// opened file so a subsequent "Save" (not "Save As") writes back to the same
// file without re-prompting.
let currentHandle: FileSystemFileHandle | null = null;

function normalizeLe(s: string): "lf" | "crlf" | "cr" {
  return s === "crlf" || s === "cr" ? s : "lf";
}

function detectLineEnding(text: string): "lf" | "crlf" | "cr" {
  if (text.includes("\r\n")) return "crlf";
  if (text.includes("\r")) return "cr";
  return "lf";
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
  currentHandle = handle;
  const file = await handle.getFile();
  const content = await file.text();
  return {
    path: file.name,
    content,
    encoding: "UTF-8",
    line_ending: detectLineEnding(content),
  };
}

async function browserSave(content: string): Promise<string> {
  if (currentHandle) {
    // Write back to the known handle without re-prompting.
    const writable = await currentHandle.createWritable();
    await writable.write(content);
    await writable.close();
    return currentHandle.name;
  }
  return browserSaveAs(content);
}

async function browserSaveAs(content: string): Promise<string> {
  const picker = (window as unknown as {
    showSaveFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle>;
  }).showSaveFilePicker;
  if (!picker) {
    throw new Error(
      "File System Access API unavailable. Run inside Wails or use a Chromium browser.",
    );
  }
  const handle = await picker();
  currentHandle = handle;
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
  return handle.name;
}

/** Reset the cached handle when a new/untitled buffer is created. */
export function resetFileHandle(): void {
  currentHandle = null;
}

/* ----------------------------- public API -------------------------------- */

export async function openFile(): Promise<FileContent> {
  return isWails() ? wailsOpen() : browserOpen();
}

export async function saveFile(
  path: string | null,
  content: string,
): Promise<string> {
  if (isWails()) return wailsSave(path ?? "", content);
  return browserSave(content);
}

export async function saveAsFile(content: string): Promise<string> {
  if (isWails()) return wailsSaveAs(content);
  return browserSaveAs(content);
}
