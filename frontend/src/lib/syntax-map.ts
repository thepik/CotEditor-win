/**
 * File-type detection from `SyntaxMap.json`.
 *
 * SyntaxMap.json is `{ "<SyntaxName>": { extensions, filenames, interpreters } }`.
 * Given a path we match in priority: exact filename -> extension -> shebang
 * interpreter (the latter only available post-open, so callers pass content
 * separately if they want interpreter detection).
 *
 * The map is fetched from the Vite `public/` dir at init time (it lives next to
 * the vendored themes/syntaxes). Call `initSyntaxMap()` once during bootstrap
 * before any detection call.
 */

interface SyntaxMapEntry {
  extensions?: string[];
  filenames?: string[];
  interpreters?: string[];
}
type SyntaxMap = Record<string, SyntaxMapEntry>;

let syntaxMap: SyntaxMap = {};

/** Reverse indices, rebuilt whenever the map is (re)loaded. */
const byFilename = new Map<string, string>();
const byExtension = new Map<string, string>();
const interpreterIndex = new Map<string, string>();
let initialised = false;

/** Fetch and index SyntaxMap.json. Safe to call once; idempotent. */
export async function initSyntaxMap(): Promise<void> {
  if (initialised) return;
  try {
    const res = await fetch("resources/SyntaxMap.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    syntaxMap = (await res.json()) as SyntaxMap;
  } catch (err) {
    console.warn("Failed to load SyntaxMap.json:", err);
    syntaxMap = {};
  }
  rebuildIndices();
  initialised = true;
}

function rebuildIndices(): void {
  byFilename.clear();
  byExtension.clear();
  interpreterIndex.clear();
  for (const [syntax, entry] of Object.entries(syntaxMap)) {
    for (const f of entry.filenames ?? []) byFilename.set(f.toLowerCase(), syntax);
    for (const e of entry.extensions ?? []) {
      const key = e.toLowerCase();
      // First-write-wins so a syntax declared earlier wins on conflicts.
      if (!byExtension.has(key)) byExtension.set(key, syntax);
    }
    for (const i of entry.interpreters ?? []) {
      interpreterIndex.set(i.toLowerCase(), syntax);
    }
  }
}

/**
 * Detect the CotEditor syntax name for a file path.
 *
 * Returns `null` if nothing matches (caller falls back to plaintext). The
 * returned name is the CotEditor bundle name (e.g. `"Shell Script"`,
 * `"C++"`); convert to a Monaco language id via `monacoIdForSyntax`.
 */
export function detectSyntaxByPath(path: string): string | null {
  const norm = path.replace(/\\/g, "/");
  const filename = norm.slice(norm.lastIndexOf("/") + 1).toLowerCase();

  // 1. exact filename match
  if (byFilename.has(filename)) return byFilename.get(filename)!;

  // 2. extension match (last dot; handles `tar.gz`? no - CotEditor uses single
  //    extensions, so we take the last segment after the final dot)
  const dot = filename.lastIndexOf(".");
  if (dot >= 0) {
    const ext = filename.slice(dot); // includes the dot, matching the map
    if (byExtension.has(ext)) return byExtension.get(ext)!;
    // Some maps store extension without leading dot; try that too.
    const extNoDot = filename.slice(dot + 1);
    if (byExtension.has(`.${extNoDot}`)) return byExtension.get(`.${extNoDot}`)!;
    if (byExtension.has(extNoDot)) return byExtension.get(extNoDot)!;
  }

  return null;
}

/**
 * Detect syntax from a shebang line (`#!/usr/bin/env python3`).
 *
 * Called after a file is opened with its content. Returns the syntax name or
 * `null`. Matches against the `interpreters` list in SyntaxMap.json, indexed at
 * init time.
 */
export function detectSyntaxByShebang(content: string): string | null {
  const firstLine = content.split(/\r?\n/, 1)[0];
  const match = /^#!\s*(?:\S+\/)?(env\s+)?(\S+)/.exec(firstLine);
  if (!match) return null;
  const interp = match[2].toLowerCase();
  return interpreterIndex.get(interp) ?? null;
}

/** All syntax names known to the map (for menus / registration). */
export function listSyntaxes(): string[] {
  return Object.keys(syntaxMap);
}
