/**
 * Recent-files list (PLAN phase C).
 *
 * A small, storage-backed MRU list stored under `coteditor.recent.v1`.
 *
 * Contract:
 *  - at most {@link RECENT_FILES_LIMIT} entries, newest first;
 *  - duplicate paths are collapsed using Windows semantics: case-insensitive
 *    and separator-insensitive (`C:\Foo\a.txt` == `c:/foo/A.TXT`);
 *  - corrupted/foreign payloads degrade to an empty list;
 *  - existence filtering is intentionally NOT done here - paths may point to
 *    disconnected drives and checking them is the caller's responsibility.
 *
 * The path spelling of the newest add is preserved in the list; the normalized
 * form is used only as a comparison key.
 */

export const RECENT_FILES_STORAGE_KEY = "coteditor.recent.v1";

export const RECENT_FILES_LIMIT = 15;

/**
 * Comparison key for a Windows path.
 *
 * Slashes are unified to `\`, repeated separators are collapsed (except the
 * leading UNC `\\`), a trailing separator is dropped, and the result is
 * Unicode-normalized and lower-cased. The original spelling is never replaced.
 */
export function normalizeRecentPath(path: string): string {
  let normalized = path.trim().replace(/\//g, "\\");
  normalized = normalized.replace(/\\{2,}/g, (_match, offset) =>
    offset === 0 ? "\\\\" : "\\",
  );
  // Keep drive roots ("C:\") and UNC prefixes usable; trim other trailing
  // separators so a path and its directory-style spelling dedupe together.
  if (normalized.length > 3 && normalized.endsWith("\\")) {
    normalized = normalized.replace(/\\+$/, "");
  }
  if (normalized === "") return "";
  return normalized.normalize("NFC").toLowerCase();
}

function sanitizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const path = item.trim();
    if (path === "") continue;
    const key = normalizeRecentPath(path);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    result.push(path);
    if (result.length >= RECENT_FILES_LIMIT) break;
  }
  return result;
}

function readStored(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_FILES_STORAGE_KEY);
    if (raw === null) return [];
    return sanitizeList(JSON.parse(raw) as unknown);
  } catch {
    // Corrupt JSON or unavailable storage: both mean "no recent files".
    return [];
  }
}

function persist(files: string[]): void {
  try {
    localStorage.setItem(RECENT_FILES_STORAGE_KEY, JSON.stringify(files));
  } catch {
    // Best-effort; the returned list is still usable for this session.
  }
}

/** Current MRU list (newest first), as a copy. */
export function listRecentFiles(): string[] {
  return readStored();
}

/**
 * Add or promote a path. Re-adding an existing path moves it to the front and
 * updates its spelling; the list is capped at {@link RECENT_FILES_LIMIT}.
 * Empty/whitespace-only input is ignored.
 */
export function addRecentFile(path: string): string[] {
  if (typeof path !== "string") return listRecentFiles();
  const trimmed = path.trim();
  if (trimmed === "") return listRecentFiles();
  const key = normalizeRecentPath(trimmed);
  if (key === "") return listRecentFiles();
  const next = [
    trimmed,
    ...readStored().filter((entry) => normalizeRecentPath(entry) !== key),
  ].slice(0, RECENT_FILES_LIMIT);
  persist(next);
  return [...next];
}

/** Remove every entry matching `path` (case/separator-insensitive). */
export function removeRecentFile(path: string): string[] {
  const key = normalizeRecentPath(path);
  const next = key === ""
    ? readStored()
    : readStored().filter((entry) => normalizeRecentPath(entry) !== key);
  persist(next);
  return [...next];
}

/** Remove the list entirely (also drops the storage key). */
export function clearRecentFiles(): void {
  try {
    localStorage.removeItem(RECENT_FILES_STORAGE_KEY);
  } catch {
    // Unavailable storage: there is nothing to clear.
  }
}
