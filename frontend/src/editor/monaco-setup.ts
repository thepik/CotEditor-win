/**
 * Monaco setup: mount the editor, configure core options, expose accessors.
 *
 * Owned state:
 *  - a single Monaco editor instance (single-document model for the MVP)
 *  - the backing text model
 *
 * Other modules access the editor/model through `getEditor` / `getModel` rather
 * than importing Monaco directly, so that the worker setup and ESM imports stay
 * in one place.
 *
 * Bundle size: we import the editor core from `edcore.main` (which pulls in
 * `editor.all` - every editor contribution: find, multi-cursor, folding, etc. -
 * plus the standalone API) rather than the default `monaco-editor` entry. The
 * default entry (`editor.main.js`) additionally bundles all 81 built-in
 * basic-languages and the CSS/HTML/JSON/TS language services, which CotEditor-
 * win never uses: highlighting is driven by our own tree-sitter + regex
 * engines, and the only built-in languages we rely on are the ~19 whose ids we
 * set on the model. We import just those language contributions below, cutting
 * roughly 60 unused languages and 4 language services from the bundle.
 */

import * as monaco from "monaco-editor/esm/vs/editor/edcore.main.js";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// Register only the built-in languages CotEditor-win actually targets (the
// ids in `language-config.ts`'s SYNTAX_TO_MONACO map). Each contribution file
// calls `registerLanguage` with the id, aliases, extensions, and a lazy loader
// for its tokenizer - we only need the registration so the language id is
// known and `setLanguageConfiguration` / `setModelLanguage` apply; we don't
// rely on the built-in tokenizers (semantic tokens override them), but the
// language must be registered for auto-closing/comment config to attach.
//
// Notes:
//  - `cpp.contribution.js` registers BOTH `c` and `cpp`.
//  - `json` has no lightweight basic-language entry (it lives in the heavy
//    `language/json` language-service bundle, which we exclude). We register it
//    manually below since CotEditor-win highlights JSON with its own regex
//    engine - we only need the id to exist.
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";

// Monaco needs its web worker registered with the bundler's worker URL. We do
// this once at module load.
//
// CotEditor-win does its own highlighting via tree-sitter semantic tokens and a
// regex tokenizer, both on the main thread -- it does not use Monaco's language
// services (TS/JSON/CSS diagnostics, completion, etc.) that ship in per-language
// workers. The base `editor.worker` is all we need (it hosts basic
// tokenization). Routing every worker request to it avoids wiring up -- and
// failing to resolve -- a dozen language-worker modules under Vite.
self.MonacoEnvironment = {
  getWorker(): Worker {
    return new editorWorker();
  },
};

// Re-export the namespace so other modules don't need their own import wiring.
export { monaco };

let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let model: monaco.editor.ITextModel | null = null;

/**
 * Create the editor inside `#editor` and a backing model.
 *
 * Options chosen to mirror CotEditor's defaults: visible whitespace (subtle),
 * line numbers, current-line highlight, bracket pair colourisation off (CotEditor
 * uses its own bracketing). Indentation defaults to 4 spaces; the language
 * config layer may override per-language.
 */
export async function setupMonaco(): Promise<void> {
  const host = document.getElementById("editor");
  if (!host) throw new Error("#editor host element not found");

  // Register the `json` language id ourselves. CotEditor-win highlights JSON
  // with its own regex engine, so we don't import Monaco's heavy JSON language
  // service (~380KB) - we only need the id to exist so the model can be tagged
  // `json` and `setLanguageConfiguration` attaches auto-closing/comment config.
  // `plaintext` is registered for completeness (the default model id).
  monaco.languages.register({ id: "json" });
  monaco.languages.register({ id: "plaintext" });

  model = monaco.editor.createModel("", "plaintext");

  editor = monaco.editor.create(host, {
    model,
    theme: "vs",
    automaticLayout: true,
    fontFamily:
      '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
    fontLigatures: true,
    fontSize: 14,
    lineHeight: 21,
    letterSpacing: 0.1,
    lineNumbers: "on",
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: true,
    showFoldingControls: "mouseover",
    renderWhitespace: "selection",
    renderControlCharacters: true,
    renderLineHighlight: "line",
    roundedSelection: false,
    scrollBeyondLastLine: false,
    padding: { top: 8, bottom: 8 },
    minimap: { enabled: false },
    guides: {
      indentation: true,
      bracketPairs: false,
    },
    tabSize: 4,
    insertSpaces: true,
    wordWrap: "off",
    smoothScrolling: true,
    cursorBlinking: "smooth",
    cursorSmoothCaretAnimation: "on",
    cursorWidth: 2,
    scrollbar: {
      verticalScrollbarSize: 11,
      horizontalScrollbarSize: 11,
      useShadows: false,
    },
    multiCursorModifier: "ctrlCmd",
    stickyScroll: { enabled: false },
    // Enable tree-sitter semantic tokens to override the builtin tokenizer's
    // colours for languages with a registered grammar (highlight-tree-sitter).
    "semanticHighlighting.enabled": true,
  });
}

export function getEditor(): monaco.editor.IStandaloneCodeEditor | null {
  return editor;
}

export function getModel(): monaco.editor.ITextModel | null {
  return model;
}

/**
 * Define a Monaco theme by name from already-parsed theme data.
 *
 * Thin wrapper around `monaco.editor.defineTheme` so theme-loader stays
 * decoupled from the monaco import here.
 */
export function defineMonacoTheme(
  name: string,
  data: monaco.editor.IStandaloneThemeData,
): void {
  monaco.editor.defineTheme(name, data);
}

export function setMonacoTheme(name: string): void {
  monaco.editor.setTheme(name);
}
