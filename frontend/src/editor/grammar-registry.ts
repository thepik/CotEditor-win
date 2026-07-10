/**
 * tree-sitter grammar registration.
 *
 * Maps each supported Monaco language id to:
 *  - a grammar `.wasm` URL bundled from the `tree-sitter-wasms` package, and
 *  - the `highlights.scm` query URL under `public/resources/queries/<Folder>/`.
 *
 * The mapping mirrors the original CotEditor `TreeSitterSyntax` enum
 * (`Packages/Syntax/Sources/SyntaxParsers/TreeSitter/TreeSitterSyntax.swift`):
 * the query folder is the tree-sitter language name (e.g. `Bash` for Shell
 * Script), and the wasm filename uses the `providerName` convention
 * (`c_sharp` for C#, `bash` for Shell Script).
 *
 * C#/C++ query folders have safe on-disk aliases (`Csharp`/`Cpp`) because the
 * literal `#`/`+` break URL path resolution; the alias copies are kept next to
 * the originals under `queries/`.
 */

import { registerGrammar } from "./highlight-tree-sitter";
import bashWasmUrl from "tree-sitter-wasms/out/tree-sitter-bash.wasm?url";
import cWasmUrl from "tree-sitter-wasms/out/tree-sitter-c.wasm?url";
import cppWasmUrl from "tree-sitter-wasms/out/tree-sitter-cpp.wasm?url";
import csharpWasmUrl from "tree-sitter-wasms/out/tree-sitter-c_sharp.wasm?url";
import cssWasmUrl from "tree-sitter-wasms/out/tree-sitter-css.wasm?url";
import goWasmUrl from "tree-sitter-wasms/out/tree-sitter-go.wasm?url";
import htmlWasmUrl from "tree-sitter-wasms/out/tree-sitter-html.wasm?url";
import javaWasmUrl from "tree-sitter-wasms/out/tree-sitter-java.wasm?url";
import javascriptWasmUrl from "tree-sitter-wasms/out/tree-sitter-javascript.wasm?url";
import kotlinWasmUrl from "tree-sitter-wasms/out/tree-sitter-kotlin.wasm?url";
import phpWasmUrl from "tree-sitter-wasms/out/tree-sitter-php.wasm?url";
import pythonWasmUrl from "tree-sitter-wasms/out/tree-sitter-python.wasm?url";
import rubyWasmUrl from "tree-sitter-wasms/out/tree-sitter-ruby.wasm?url";
import rustWasmUrl from "tree-sitter-wasms/out/tree-sitter-rust.wasm?url";
import swiftWasmUrl from "tree-sitter-wasms/out/tree-sitter-swift.wasm?url";
import typescriptWasmUrl from "tree-sitter-wasms/out/tree-sitter-typescript.wasm?url";

const GRAMMAR_WASM_URLS: Record<string, string> = {
  bash: bashWasmUrl,
  c: cWasmUrl,
  cpp: cppWasmUrl,
  c_sharp: csharpWasmUrl,
  css: cssWasmUrl,
  go: goWasmUrl,
  html: htmlWasmUrl,
  java: javaWasmUrl,
  javascript: javascriptWasmUrl,
  kotlin: kotlinWasmUrl,
  php: phpWasmUrl,
  python: pythonWasmUrl,
  ruby: rubyWasmUrl,
  rust: rustWasmUrl,
  swift: swiftWasmUrl,
  typescript: typescriptWasmUrl,
};

interface GrammarMapping {
  /** Monaco language id this grammar highlights. */
  languageId: string;
  /** Grammar wasm filename (without the `tree-sitter-` prefix / `.wasm` suffix). */
  wasmName: string;
  /** Query folder under `public/resources/queries/`. */
  queryFolder: string;
}

/**
 * The 16 languages with both a vendored wasm and a highlights.scm query.
 *
 * SQL is omitted: its grammar wasm isn't shipped in `tree-sitter-wasms` and the
 * bundle has no highlights query at the time of writing. Markdown uses the
 * regex engine (see highlight-regex.ts), so it isn't here either.
 */
const GRAMMARS: GrammarMapping[] = [
  { languageId: "javascript", wasmName: "javascript", queryFolder: "JavaScript" },
  { languageId: "typescript", wasmName: "typescript", queryFolder: "TypeScript" },
  { languageId: "python", wasmName: "python", queryFolder: "Python" },
  { languageId: "html", wasmName: "html", queryFolder: "HTML" },
  { languageId: "css", wasmName: "css", queryFolder: "CSS" },
  { languageId: "shell", wasmName: "bash", queryFolder: "Bash" },
  { languageId: "c", wasmName: "c", queryFolder: "C" },
  { languageId: "cpp", wasmName: "cpp", queryFolder: "Cpp" },
  { languageId: "java", wasmName: "java", queryFolder: "Java" },
  { languageId: "go", wasmName: "go", queryFolder: "Go" },
  { languageId: "rust", wasmName: "rust", queryFolder: "Rust" },
  { languageId: "ruby", wasmName: "ruby", queryFolder: "Ruby" },
  { languageId: "php", wasmName: "php", queryFolder: "PHP" },
  { languageId: "swift", wasmName: "swift", queryFolder: "Swift" },
  { languageId: "kotlin", wasmName: "kotlin", queryFolder: "Kotlin" },
  { languageId: "csharp", wasmName: "c_sharp", queryFolder: "Csharp" },
];

/**
 * Register every vendored tree-sitter grammar with the highlight engine.
 *
 * Registration is lazy: each grammar's wasm + query are only fetched the first
 * time a model using that language is highlighted. Safe to call once at boot.
 */
export function registerAllGrammars(): void {
  for (const g of GRAMMARS) {
    registerGrammar(
      g.languageId,
      () => Promise.resolve(grammarWasmUrl(g.wasmName)),
      () => fetchQuery(g.queryFolder),
    );
  }
}

function grammarWasmUrl(wasmName: string): string {
  const url = GRAMMAR_WASM_URLS[wasmName];
  if (!url) throw new Error(`Missing bundled grammar WASM: ${wasmName}`);
  return url;
}

async function fetchQuery(folder: string): Promise<string> {
  const res = await fetch(
    new URL(
      `resources/queries/${folder}/highlights.scm`,
      window.location.href,
    ).toString(),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} for queries/${folder}/highlights.scm`);
  return res.text();
}
