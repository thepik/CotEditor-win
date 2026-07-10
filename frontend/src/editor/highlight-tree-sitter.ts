/**
 * tree-sitter highlight engine.
 *
 * Pipeline (PLAN §阶段3):
 *  1. On first highlight request for a language, load the matching grammar
 *     `.wasm` via `web-tree-sitter` and compile the `highlights.scm` query
 *     vendored under `public/resources/queries/<Grammar>/highlights.scm`.
 *  2. Parse the Monaco model's text, walk captures, and map each capture name
 *     (e.g. `@keywords`) to a Monaco semantic token type via the scope table
 *     shared with theme-loader.
 *  3. Register a `DocumentSemanticTokensProvider` so Monaco re-tints on edit.
 *  4. On edit, Monaco re-requests tokens; `buildTokens` re-parses the full
 *     model text. (An incremental `tree.edit()` path is deferred -- see
 *     `attachModelChangeTracking`.)
 *
 * Capture-name -> scope mapping follows the original CotEditor `SyntaxType`
 * enum (`Packages/Syntax/Sources/SyntaxFormat/SyntaxType.swift`): the nine
 * highlight scopes keywords/commands/types/attributes/variables/values/numbers/
 * strings/characters/comments. Captures whose base name isn't one of these
 * (e.g. `@name`, `@_skip`, `@pkg`) are dropped. The "last pattern wins"
 * conflict rule from `TreeSitterClient.swift` is implemented in
 * `resolveConflicts`.
 */

import type * as monaco from "monaco-editor";
import { monaco as monacoNs, getModel, getEditor } from "./monaco-setup";

/** web-tree-sitter is loaded lazily; the WASM core ships in the npm package. */
import type * as TreeSitter from "web-tree-sitter";
let ParserModule: typeof TreeSitter | null = null;
let parserInitPromise: Promise<void> | null = null;

/**
 * Initialise the web-tree-sitter core.
 *
 * The runtime `tree-sitter.wasm` is served from the vendored grammar dir so we
 * don't depend on the bundler resolving the `.wasm` import inside node_modules.
 * `Parser.init` accepts an Emscripten module options object whose `locateFile`
 * callback remaps the core wasm path.
 */
async function ensureParser(): Promise<typeof TreeSitter> {
  if (!ParserModule) {
    ParserModule = (await import("web-tree-sitter")) as typeof TreeSitter;
  }
  if (!parserInitPromise) {
    parserInitPromise = ParserModule.Parser.init({
      locateFile: (path: string) => {
        // web-tree-sitter asks for `tree-sitter.wasm` relative to the document;
        // serve our copy from /resources/grammars.
        if (path.endsWith("tree-sitter.wasm")) {
          return new URL(
            "resources/grammars/tree-sitter.wasm",
            window.location.href,
          ).toString();
        }
        return path;
      },
    } as Record<string, unknown>);
  }
  await parserInitPromise;
  return ParserModule;
}

/**
 * Map of language id -> grammar loader.
 *
 * Keyed by Monaco language id (the value attached to the model). The loader
 * returns a `{ language, query }` pair ready to highlight text. Populated by
 * `registerGrammar` as each language is wired up.
 */
interface GrammarEntry {
  load: () => Promise<LoadedGrammar>;
}
interface LoadedGrammar {
  language: TreeSitter.Language;
  query: TreeSitter.Query;
}
const grammars = new Map<string, GrammarEntry>();

/**
 * Monaco semantic-token legend: the token types this provider can emit.
 *
 * The ordering is stable because indices into this array are what the provider
 * returns. Names mirror the CotEditor scope names so theme rules (defined in
 * theme-loader against the same scope names) colour them directly.
 */
const TOKEN_TYPES = [
  "keyword", // keywords, commands
  "type",
  "attribute",
  "variable",
  "literal", // values
  "number",
  "string", // strings, characters
  "comment",
] as const;

const LEGEND: monaco.languages.SemanticTokensLegend = {
  tokenTypes: [...TOKEN_TYPES],
  tokenModifiers: [],
};

/** CotEditor capture base name -> legend token index. */
const CAPTURE_TO_INDEX: Record<string, number> = {
  keywords: 0,
  commands: 0,
  types: 1,
  attributes: 2,
  variables: 3,
  values: 4,
  numbers: 5,
  strings: 6,
  characters: 6,
  comments: 7,
};

/**
 * Register a tree-sitter grammar for a Monaco language id.
 *
 * `loadWasm` returns a URL/ArrayBuffer for the grammar `.wasm`; `loadQuery`
 * returns the `highlights.scm` source. Both are deferred to first use so we
 * don't pay the cost for languages the user never opens.
 */
export function registerGrammar(
  languageId: string,
  loadWasm: () => Promise<string | ArrayBuffer>,
  loadQuery: () => Promise<string>,
): void {
  let cached: LoadedGrammar | null = null;
  grammars.set(languageId, {
    async load(): Promise<LoadedGrammar> {
      if (cached) return cached;
      const mod = await ensureParser();
      const wasmInput = await loadWasm();
      // Language.load accepts a string (URL) or a Uint8Array. Convert ArrayBuffer.
      const input: string | Uint8Array =
        typeof wasmInput === "string" ? wasmInput : new Uint8Array(wasmInput);
      const language = await mod.Language.load(input);
      const query = language.query(await loadQuery());
      cached = { language, query };
      return cached;
    },
  });
}

/* --------------------------- per-language state -------------------------- */

/**
 * Per-language tree-sitter state, keyed by Monaco language id.
 *
 * Each entry owns a Parser. The tree is recomputed from the model's current
 * text on every token request (full re-parse), which is simple and correct;
 * incremental `tree.edit()` was found to corrupt the tree when a language
 * switch races an in-flight parse, hanging `Query.matches`. The full-reparse
 * path is fast enough for the file sizes the MVP targets.
 */
interface LanguageState {
  parser: TreeSitter.Parser;
}

const states = new Map<string, LanguageState>();

/** Per-languageId provider registration guard (Monaco rejects duplicates). */
const registeredLanguages = new Set<string>();

/**
 * Register the semantic-token provider with Monaco for every language that has
 * a grammar registered.
 *
 * Called once at boot from main.ts.
 */
export function registerHighlightProviders(): void {
  const editor = getEditor();
  if (!editor) return;

  const model = getModel();
  if (model) {
    // Whenever the model's language changes (open file / detect), make sure a
    // provider exists and the parser is seeded.
    model.onDidChangeLanguage(() => {
      void ensureLanguageState(model.getLanguageId());
    });
  }
}

/**
 * Hook model content changes so the editor repaints after edits.
 *
 * We don't run incremental `tree.edit()` here: an earlier incremental
 * implementation corrupted the tree when a language switch raced an in-flight
 * parse, hanging `Query.matches`. Instead `buildTokens` re-parses the full
 * model text on every request, which Monaco triggers on content change. This
 * stub is kept so the bootstrap wiring stays stable; a correct incremental path
 * can land later behind a flag.
 */
export function attachModelChangeTracking(): void {
  // No-op: Monaco re-requests semantic tokens after content changes, and
  // buildTokens always re-parses from the current model text.
}

/**
 * Make sure the provider for `languageId` is registered and a parser exists.
 *
 * Called when a model switches to `languageId`. If the language has no grammar
 * registered (plaintext, or SQL whose wasm isn't vendored), this is a no-op.
 */
async function ensureLanguageState(
  languageId: string,
): Promise<LanguageState | null> {
  registerProviderFor(languageId);

  const entry = grammars.get(languageId);
  if (!entry) return null;

  let st = states.get(languageId);
  if (st) return st;

  // Loading the grammar (wasm + query) is the expensive part; cache it once.
  await entry.load();
  const mod = await ensureParser();
  const { language } = await entry.load();
  const parser = new mod.Parser();
  parser.setLanguage(language);

  st = { parser };
  states.set(languageId, st);
  return st;
}

/**
 * Register the Monaco semantic-token provider for one language id.
 *
 * Idempotent. The provider delegates to `buildTokens`, which looks up the
 * per-language state; if none exists yet it triggers lazy creation.
 */
function registerProviderFor(languageId: string): void {
  if (registeredLanguages.has(languageId)) return;
  const entry = grammars.get(languageId);
  if (!entry) return;
  registeredLanguages.add(languageId);

  const provider: monaco.languages.DocumentSemanticTokensProvider = {
    getLegend(): monaco.languages.SemanticTokensLegend {
      return LEGEND;
    },
    async provideDocumentSemanticTokens(
      model: monaco.editor.ITextModel,
      _lastResultId: string | null,
    ): Promise<monaco.languages.SemanticTokens | null> {
      return buildTokens(model);
    },
    releaseDocumentSemanticTokens(): void {
      /* tokens are computed on demand, nothing to free */
    },
  };
  monacoNs.languages.registerDocumentSemanticTokensProvider(languageId, provider);
}

/**
 * Compute the semantic tokens for a model.
 *
 * Re-parses the model's current text in full, walks every capture of the
 * compiled query, resolves "last pattern wins" conflicts, then packs surviving
 * captures into Monaco's delta-encoded token array.
 */
async function buildTokens(
  model: monaco.editor.ITextModel,
): Promise<monaco.languages.SemanticTokens | null> {
  const languageId = model.getLanguageId();
  const st = await ensureLanguageState(languageId);
  if (!st) return null;

  const source = model.getValue();
  const tree = st.parser.parse(source);
  if (!tree) return null;

  const grammarEntry = grammars.get(languageId)!;
  const loaded = await grammarEntry.load();

  const captures = collectCaptures(loaded.query, tree);
  const resolved = resolveConflicts(captures);
  const data = packTokens(resolved, model);

  return { data };
}

interface Capture {
  startIndex: number;
  endIndex: number;
  /** Pattern index of the rule that produced this capture (for precedence). */
  patternIndex: number;
  /** Stable tree-sitter node id (used to detect overlapping captures). */
  nodeId: number;
  /** CotEditor scope base name, e.g. "keywords". */
  scope: string;
}

/**
 * Run the highlights query and gather all captures.
 *
 * We use `Query.matches` (not `Query.captures`) so we can read each match's
 * `patternIndex`, which is needed for the "last pattern wins" rule.
 */
function collectCaptures(
  query: TreeSitter.Query,
  tree: TreeSitter.Tree,
): Capture[] {
  const out: Capture[] = [];
  const matches = query.matches(tree.rootNode);
  for (const match of matches) {
    for (const cap of match.captures) {
      const base = cap.name.split(".", 1)[0];
      if (!(base in CAPTURE_TO_INDEX)) continue; // unknown capture, e.g. @name
      out.push({
        startIndex: cap.node.startIndex,
        endIndex: cap.node.endIndex,
        patternIndex: match.patternIndex,
        nodeId: cap.node.id,
        scope: base,
      });
    }
  }
  return out;
}

/**
 * Resolve captures that overlap on the same node.
 *
 * tree-sitter's standard precedence is "last pattern wins": when several
 * captures target the same node (identified by its stable node id), the one
 * from the query pattern with the highest patternIndex survives. This mirrors
 * `resolvingCaptureConflicts` in `TreeSitterClient.swift`.
 */
function resolveConflicts(captures: Capture[]): Capture[] {
  interface Best {
    arrayIndex: number;
    patternIndex: number;
  }
  const bestForNode = new Map<number, Best>();
  for (let i = 0; i < captures.length; i++) {
    const c = captures[i];
    const existing = bestForNode.get(c.nodeId);
    if (!existing || c.patternIndex > existing.patternIndex) {
      bestForNode.set(c.nodeId, { arrayIndex: i, patternIndex: c.patternIndex });
    }
  }
  const winners = new Set<number>();
  for (const b of bestForNode.values()) winners.add(b.arrayIndex);
  return captures.filter((_, i) => winners.has(i));
}

/**
 * Pack captures into Monaco's delta-encoded semantic-token array.
 *
 * Format: for each token (sorted by start offset), emit five numbers:
 *   deltaLine, deltaStart, length, tokenType(legend index), 0(modifiers).
 * Offsets are UTF-16 based to match Monaco's model positions.
 */
function packTokens(captures: Capture[], model: monaco.editor.ITextModel): Uint32Array {
  const sorted = [...captures].sort((a, b) => a.startIndex - b.startIndex);
  const data: number[] = [];
  let prevLine = 0;
  let prevChar = 0;

  for (const cap of sorted) {
    const typeIndex = CAPTURE_TO_INDEX[cap.scope];
    if (typeIndex == null) continue;
    if (cap.endIndex <= cap.startIndex) continue; // skip empty captures

    const pos = model.getPositionAt(cap.startIndex);
    const line = pos.lineNumber - 1; // 0-based
    const char = pos.column - 1; // 0-based
    const length = cap.endIndex - cap.startIndex;

    const deltaLine = line - prevLine;
    const deltaChar = deltaLine === 0 ? char - prevChar : char;

    data.push(deltaLine, deltaChar, length, typeIndex, 0);

    prevLine = line;
    prevChar = char;
  }
  return Uint32Array.from(data);
}

/**
 * Force Monaco to re-pull semantic tokens for the current model.
 *
 * Toggling the model's language to itself invalidates the cached tokens so the
 * provider runs again. Used after a theme switch (theme-loader) and when we
 * want a manual refresh.
 */
export function refreshSemanticTokens(): void {
  const model = getModel();
  if (!model) return;
  const languageId = model.getLanguageId();
  if (!grammars.has(languageId)) return;
  // Re-set the language to itself: Monaco drops its cached semantic-token
  // result and requests fresh tokens on the next frame.
  monacoNs.editor.setModelLanguage(model, languageId);
}

export { LEGEND as TREE_SITTER_TOKEN_LEGEND };
