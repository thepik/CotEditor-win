/**
 * Derive Monaco `LanguageConfiguration` from `.cotsyntax/Edit.json`.
 *
 * Edit.json drives three Monaco features (PLAN §阶段4):
 *  - `comment.inlines` / `comment.blocks` -> Monaco `CommentsConfiguration`
 *  - `stringDelimiters` -> `autoClosingPairs` + `surroundingPairs`
 *  - `indentation.blockDelimiters` -> `onEnterRules` (smart indent)
 *
 * This module reads the vendored Edit.json files and registers a language
 * configuration for each Monaco language id, plus sets the active model's
 * language when a file is opened.
 */

import type * as monaco from "monaco-editor";
import { monaco as monacoNs, getModel } from "./monaco-setup";
import { detectSyntaxByPath } from "../lib/syntax-map";

/** Edit.json structure (subset relevant to language config). */
export interface CotEditJson {
  comment?: {
    inlines?: { delimiter?: string }[];
    blocks?: { begin?: string; end?: string }[];
  };
  stringDelimiters?: {
    begin?: string;
    end?: string;
    escapeCharacter?: string;
    prefixes?: string[];
    isMultiline?: boolean;
  }[];
  indentation?: {
    blockDelimiters?: { begin?: string; end?: string; indent?: "increase" | "decrease" | "neutral" }[];
  };
}

/** Map syntax name (CotEditor bundle name) -> Monaco language id. */
const SYNTAX_TO_MONACO: Record<string, string> = {
  JavaScript: "javascript",
  TypeScript: "typescript",
  Python: "python",
  HTML: "html",
  CSS: "css",
  JSON: "json",
  Markdown: "markdown",
  "Shell Script": "shell",
  C: "c",
  "C++": "cpp",
  Java: "java",
  Go: "go",
  Rust: "rust",
  SQL: "sql",
  Ruby: "ruby",
  PHP: "php",
  Swift: "swift",
  Kotlin: "kotlin",
  "C#": "csharp",
};

/**
 * Map a CotEditor bundle name to a filesystem-safe directory name for fetching
 * its `.cotsyntax` files over HTTP.
 *
 * `C#` and `C++` contain `#` / `+` that break URL path resolution under Vite's
 * dev server (`#` becomes a fragment). We keep vendored copies of those two
 * bundles under safe names (`Csharp`, `Cpp`) in `public/resources/syntaxes/`
 * and translate here. All other names map to themselves.
 */
const BUNDLE_DIR_ALIAS: Record<string, string> = {
  "C#": "Csharp",
  "C++": "Cpp",
};

function bundleDir(syntax: string): string {
  return BUNDLE_DIR_ALIAS[syntax] ?? syntax;
}

export function monacoIdForSyntax(syntax: string): string | undefined {
  return SYNTAX_TO_MONACO[syntax];
}

/**
 * Load every in-scope language's Edit.json and register its Monaco config.
 *
 * We fetch at runtime (rather than `import.meta.glob` eager imports) because the
 * vendored directories `C#.cotsyntax` and `C++.cotsyntax` contain `#` / `+`,
 * which Vite's resolver mishandles when those paths appear as import keys.
 * Fetching via HTTP lets us URL-encode the special characters ourselves.
 *
 * Called once at boot from main.ts. Safe to await there before the editor is
 * interacted with.
 */
export async function attachLanguage(): Promise<void> {
  await Promise.all(
    Object.entries(SYNTAX_TO_MONACO).map(async ([syntax, monacoId]) => {
      try {
        const edit = await loadEditJson(syntax);
        registerLanguageConfig(monacoId, edit);
      } catch (err) {
        console.warn(`Failed to load Edit.json for ${syntax}:`, err);
      }
    }),
  );
}

/** Fetch and parse a `.cotsyntax/Edit.json`.
 *
 * The bundle directory is translated via `bundleDir()` so names with `#`/`+`
 * (which break URL path resolution) use safe on-disk aliases (`Csharp`/`Cpp`).
 * Because every remaining name is URL-safe, we can build the path as a plain
 * string without manual percent-encoding.
 */
async function loadEditJson(syntax: string): Promise<CotEditJson> {
  const res = await fetch(`resources/syntaxes/${bundleDir(syntax)}.cotsyntax/Edit.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as CotEditJson;
}

/** Build and register the Monaco LanguageConfiguration for one language. */
function registerLanguageConfig(
  languageId: string,
  edit: CotEditJson,
): void {
  const config: monaco.languages.LanguageConfiguration = {};

  // Comments.
  const inlineDelim = edit.comment?.inlines?.[0]?.delimiter;
  if (inlineDelim) {
    config.comments = {
      lineComment: inlineDelim,
      blockComment: edit.comment?.blocks?.[0]
        ? [edit.comment.blocks[0].begin ?? "", edit.comment.blocks[0].end ?? ""]
        : undefined,
    };
  } else if (edit.comment?.blocks?.[0]) {
    config.comments = {
      blockComment: [
        edit.comment.blocks[0].begin ?? "",
        edit.comment.blocks[0].end ?? "",
      ],
    };
  }

  // Auto-closing / surrounding pairs from string delimiters + bracket pairs.
  const pairs: monaco.languages.IAutoClosingPair[] = [];
  for (const d of edit.stringDelimiters ?? []) {
    if (d.begin && d.end && d.begin.length === 1 && d.end.length === 1) {
      pairs.push({ open: d.begin, close: d.end });
    }
  }
  // Always include the universal bracket pairs.
  for (const p of [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
  ]) {
    if (!pairs.some((x) => x.open === p.open)) pairs.push(p);
  }
  config.autoClosingPairs = pairs;
  config.surroundingPairs = pairs;

  // Smart indent from block delimiters.
  if (edit.indentation?.blockDelimiters?.length) {
    config.onEnterRules = edit.indentation.blockDelimiters
      .filter((b) => b.begin && b.indent !== "decrease")
      .map((b) => ({
        beforeText: new RegExp(escapeForRegex(b.begin!) + "\\s*$"),
        action: { indentAction: monacoNs.languages.IndentAction.Indent },
      }));
  }

  monacoNs.languages.setLanguageConfiguration(languageId, config);
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Set the language of the active model, optionally auto-detected from a path.
 *
 * `path` null means an untitled buffer -> plaintext.
 */
export function setModelLanguageByPath(
  path: string | null,
  detectedSyntax?: string,
): void {
  const model = getModel();
  if (!model) return;

  let monacoId = "plaintext";
  if (detectedSyntax) {
    monacoId = SYNTAX_TO_MONACO[detectedSyntax] ?? "plaintext";
  } else if (path) {
    const syn = detectSyntaxByPath(path);
    if (syn) monacoId = SYNTAX_TO_MONACO[syn] ?? "plaintext";
  }
  monacoNs.editor.setModelLanguage(model, monacoId);
}
