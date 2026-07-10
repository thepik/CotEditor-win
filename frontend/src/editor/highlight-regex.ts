/**
 * Regex highlight engine.
 *
 * CotEditor highlights JSON and Markdown with regex rules defined in
 * `.cotsyntax/Regex/Highlights.json` (PLAN §三, §九-3). Each rule group maps to
 * a theme scope; rules may be single-pattern (`regularExpression`/`begin`) or
 * begin/end pairs, may be multiline, and may ignore case.
 *
 * The engine also honours "nestable" tokens from `Edit.json` -- string
 * delimiters and block comments -- which take the highest precedence and can
 * span content that the plain regex rules must not recolour (e.g. a `"//"` inside
 * a JSON string must not start a line comment). This mirrors the original's
 * `Nestable` + `RegexHighlightParser` split (`Packages/Syntax/Sources/
 * SyntaxParsers/RegexParser/`).
 *
 * Scope precedence follows `Highlight+Sorting.swift`: scopes are applied in
 * reverse `SyntaxType` order (comments > characters > strings > numbers >
 * values > variables > attributes > types > commands > keywords), with each
 * later scope subtracting already-occupied character positions.
 *
 * ICU-isms (`\R`, POSIX classes) are preprocessed to JS-compatible equivalents
 * before being handed to `RegExp`. Lookbehind is supported natively by V8.
 *
 * Registers a Monaco `TokensProvider` (stateful line tokenizer) per regex-based
 * language. The tokenizer re-emits tokens on every line change; for the file
 * sizes JSON/Markdown reach this is cheaper than a full-document semantic
 * re-pull on each keystroke.
 */

import type * as monaco from "monaco-editor";
import { monaco as monacoNs, getModel } from "./monaco-setup";
import { monacoIdForSyntax, type CotEditJson } from "./language-config";

/** A single highlight rule from Highlights.json. */
export interface RegexRule {
  /** Theme scope the matched text should be coloured with (e.g. `"keywords"`). */
  scope?: string;
  /** Single-pattern rule. Field name in Highlights.json is `begin`. */
  begin?: string;
  /** End pattern for a begin/end pair rule. */
  end?: string;
  /** Whether this rule is a JS regular expression (vs a literal string). */
  regularExpression?: boolean;
  /** Whether the rule can span multiple lines. */
  isMultiline?: boolean;
  /** Case-insensitive matching. */
  ignoreCase?: boolean;
  /** Description (documentation only). */
  description?: string;
}

/** Parsed Highlights.json: groups of rules, each group colouring one scope. */
export interface RegexHighlights {
  [scope: string]: RegexRule[];
}

/**
 * The precedence order of scopes when two rules' matches overlap.
 *
 * Matches `SyntaxType.allCases.reversed()` in `Highlight+Sorting.swift`: the
 * first entry here wins. Comments take precedence over everything; keywords
 * lose to all other scopes.
 */
const SCOPE_PRECEDENCE = [
  "comments",
  "characters",
  "strings",
  "numbers",
  "values",
  "variables",
  "attributes",
  "types",
  "commands",
  "keywords",
] as const;

/** Map a scope name to the Monaco token type the theme colours. */
const SCOPE_TO_MONACO_TOKEN: Record<string, string> = {
  keywords: "keyword",
  commands: "keyword",
  types: "type",
  attributes: "attribute",
  variables: "variable",
  values: "literal",
  numbers: "number",
  strings: "string",
  characters: "string",
  comments: "comment",
};

const registered = new Set<string>();

/**
 * Register a regex-based highlighter for `languageId`.
 *
 * Fetches the language's `Highlights.json` and `Edit.json`, compiles the rules,
 * and installs a Monaco `TokensProvider` that colours each line. Re-registration
 * for the same language is a no-op.
 */
export async function registerRegexLanguage(
  languageId: string,
  syntaxName: string,
): Promise<void> {
  if (registered.has(languageId)) return;
  registered.add(languageId);

  const highlights = await loadHighlightsJson(syntaxName);
  const edit = await loadEditJson(syntaxName);
  const compiled = compileRules(highlights, edit);
  const initialState = new RegexState(compiled);

  monacoNs.languages.setTokensProvider(languageId, {
    getInitialState: () => initialState,
    tokenize(line: string, state: monaco.languages.IState): monaco.languages.ILineTokens {
      const st = state as RegexState;
      return st.tokenize(line);
    },
  });
}

/**
 * Entry point called from main.ts; registers JSON and Markdown.
 *
 * Both languages are known to use the regex engine (PLAN §三); we register them
 * here so the wiring is centralised.
 */
export async function registerRegexHighlight(): Promise<void> {
  const targets: Array<{ languageId: string; syntaxName: string }> = [
    { languageId: "json", syntaxName: "JSON" },
    { languageId: "markdown", syntaxName: "Markdown" },
  ];
  await Promise.all(
    targets.map((t) =>
      registerRegexLanguage(t.languageId, t.syntaxName).catch((err) =>
        console.warn(`Failed to register regex highlight for ${t.syntaxName}:`, err),
      ),
    ),
  );
}

/* ------------------------------ rule loading ------------------------------ */

/** Directory-name alias for syntax bundles whose name contains URL-unsafe chars. */
const BUNDLE_DIR_ALIAS: Record<string, string> = {
  "C#": "Csharp",
  "C++": "Cpp",
};
function bundleDir(syntax: string): string {
  return BUNDLE_DIR_ALIAS[syntax] ?? syntax;
}

async function loadHighlightsJson(syntax: string): Promise<RegexHighlights> {
  const res = await fetch(
    `resources/syntaxes/${bundleDir(syntax)}.cotsyntax/Regex/Highlights.json`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as RegexHighlights;
}

async function loadEditJson(syntax: string): Promise<CotEditJson> {
  const res = await fetch(
    `resources/syntaxes/${bundleDir(syntax)}.cotsyntax/Edit.json`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as CotEditJson;
}

/* --------------------------- compiled rule set --------------------------- */

interface CompiledRule {
  scope: string;
  /** A single-pattern matcher (regex or literal). */
  single?: { regex: RegExp; isMultiline: boolean };
  /** A begin/end pair matcher. */
  pair?: {
    beginRegex: RegExp;
    endRegex: RegExp;
    isMultiline: boolean;
  };
}

interface NestableRule {
  scope: string;
  begin: string;
  end: string;
  /** Literal-string matchers (not regex). */
  isRegex: false;
  isMultiline: boolean;
  /** Escape char that may precede a delimiter to disable it (e.g. `\`). */
  escapeCharacter?: string;
  /** Whether the pair can nest (delimiter repeats open a deeper level). */
  isNestable: boolean;
}

interface CompiledRuleset {
  rules: CompiledRule[];
  nestables: NestableRule[];
}

/**
 * Compile the Highlights.json + Edit.json into matcher objects.
 *
 * - Begin/end rules whose `regularExpression` flag is set compile to regexes;
 *   otherwise their `begin`/`end` are treated as literal strings.
 * - String delimiters from `Edit.json.stringDelimiters` become nestable
 *   `strings` rules; block comments from `Edit.json.comment.blocks` become
 *   nestable `comments` rules. These run before and at higher precedence than
 *   the Highlights.json regex rules.
 */
function compileRules(
  highlights: RegexHighlights,
  edit: CotEditJson,
): CompiledRuleset {
  const rules: CompiledRule[] = [];
  const nestables: NestableRule[] = [];

  // Nestable string delimiters -> "strings" scope.
  for (const d of edit.stringDelimiters ?? []) {
    if (!d.begin || !d.end) continue;
    nestables.push({
      scope: "strings",
      begin: d.begin,
      end: d.end,
      isRegex: false,
      isMultiline: !!d.isMultiline,
      escapeCharacter: d.escapeCharacter,
      isNestable: d.begin === d.end, // symmetric delimiters nest (e.g. `"`)
    });
  }

  // Block comments -> "comments" scope (nestable, multiline).
  for (const b of edit.comment?.blocks ?? []) {
    if (!b.begin || !b.end) continue;
    nestables.push({
      scope: "comments",
      begin: b.begin,
      end: b.end,
      isRegex: false,
      isMultiline: true,
      isNestable: true,
    });
  }

  // Highlights.json rule groups. Each group's key is the scope name.
  for (const [scope, group] of Object.entries(highlights)) {
    for (const rule of group ?? []) {
      const isRegex = rule.regularExpression !== false && rule.begin != null;
      // Most Highlights.json rules omit regularExpression but contain regex
      // metachars; CotEditor treats `begin` as a regex unless it's a bare
      // word. We follow the original's convention: if `regularExpression` is
      // explicitly false it's literal, otherwise regex.
      if (rule.end) {
        const flags = buildFlags(rule.ignoreCase, rule.isMultiline ?? false);
        rules.push({
          scope,
          pair: {
            beginRegex: compilePattern(rule.begin ?? "", flags),
            endRegex: compilePattern(rule.end, flags),
            isMultiline: rule.isMultiline ?? false,
          },
        });
      } else if (rule.begin != null) {
        const flags = buildFlags(rule.ignoreCase, rule.isMultiline ?? false);
        rules.push({
          scope,
          single: {
            regex: compilePattern(rule.begin, flags),
            isMultiline: rule.isMultiline ?? false,
          },
        });
      }
      void isRegex;
    }
  }

  return { rules, nestables };
}

function buildFlags(ignoreCase: boolean | undefined, isMultiline: boolean): string {
  let flags = "g"; // global so exec() honours lastIndex (avoids infinite loops)
  if (ignoreCase) flags += "i";
  // `m` makes ^/$ match line boundaries; the original uses
  // `.anchorsMatchLines`. `s` (dotAll) corresponds to `.dotMatchesLineSeparators`
  // but only applies when isMultiline is true (matching the original).
  flags += "m";
  if (isMultiline) flags += "s";
  return flags;
}

/**
 * Convert an ICU-flavoured regex string to a JS `RegExp`.
 *
 * Handles the two constructs the original rules use that JS doesn't:
 *  - `\R` -> `(?:\r\n|\r|\n)` (any line break)
 *  - POSIX classes `[:alpha:]` etc. -> JS character class equivalents
 *
 * Throws a descriptive error if the result still can't compile, so a bad rule
 * fails loudly rather than silently disabling highlighting.
 */
function compilePattern(source: string, flags: string): RegExp {
  let translated = source;
  // \R  (any line break) -- must run before other backslash handling.
  translated = translated.replace(/\\R/g, "(?:\\r\\n|\\r|\\n)");

  // POSIX character classes inside bracket expressions.
  const posixMap: Record<string, string> = {
    alpha: "a-zA-Z",
    alnum: "a-zA-Z0-9",
    digit: "0-9",
    upper: "A-Z",
    lower: "a-z",
    space: "\\s",
    punct: "!-/:-@\\[-`{-~",
    blank: " \\t",
  };
  translated = translated.replace(/\[:\^?([a-z]+):\]/g, (match, name: string) => {
    const cls = posixMap[name];
    if (!cls) return match;
    const negated = match.startsWith("[:^");
    return negated ? `[^${cls}]` : `[${cls}]`;
  });

  // ICU possessive quantifiers (*+ ++ ?+ and {n,m}+) are not supported by JS.
  // Convert them to the plain greedy form. This loses the backtracking-lock
  // optimisation but is semantically equivalent for matching. Must run after
  // \R substitution (which introduces no quantifiers) and before the `++` in
  // `[...]` would be misread -- but `++` only appears as a quantifier in the
  // CotEditor rules, never inside a character class, so a naive replace is safe.
  translated = translated.replace(/(\*|\+|\?|\{[^}]*\})\+/g, "$1");

  return new RegExp(translated, flags);
}

/* --------------------------- stateful tokenizer --------------------------- */

/**
 * Monaco `IState` implementation for the regex tokenizer.
 *
 * State is needed so multi-line begin/end pairs (e.g. a ``` code fence or a
 * block comment opened on line N and closed on line N+k) carry across lines:
 * when a nestable is left open at end of line, `inNestable` records it and the
 * next line continues colouring until the closing delimiter is found.
 */
class RegexState implements monaco.languages.IState {
  private readonly ruleset: CompiledRuleset;
  /** Active open nestable at end of the last tokenized line, if any. */
  private openNestable: NestableRule | null;

  constructor(ruleset: CompiledRuleset, openNestable: NestableRule | null = null) {
    this.ruleset = ruleset;
    this.openNestable = openNestable;
  }

  equals(other: monaco.languages.IState): boolean {
    if (!(other instanceof RegexState)) return false;
    return this.openNestable === other.openNestable;
  }

  clone(): monaco.languages.IState {
    return new RegexState(this.ruleset, this.openNestable);
  }

  tokenize(line: string): monaco.languages.ILineTokens {
    const tokens: monaco.languages.ILineTokens["tokens"] = [];
    // occupied[i] = scope index that owns character i of `line` (or -1).
    const occupied = new Int16Array(line.length).fill(-1);
    // scopeAt[i] = the SCOPE_PRECEDENCE index of the owning scope, for tie-breaks.
    const scopeOwnerPrio = new Int16Array(line.length).fill(-1);

    // 1. Resolve any nestable opened on a previous line first.
    if (this.openNestable) {
      const n = this.openNestable;
      this.openNestable = null;
      this.consumeNestable(line, 0, n, occupied, scopeOwnerPrio, /*continuation=*/ true);
    }

    // 2. Walk the line, opening nestables and running single/pair rules in
    //    precedence order. Nestables are applied per-position as we advance;
    //    plain rules run afterwards against the free regions.
    let i = 0;
    while (i < line.length) {
      // Try to open a nestable at position i (if the char isn't already owned).
      if (occupied[i] === -1) {
        const opened = this.tryOpenNestable(line, i, occupied, scopeOwnerPrio);
        if (opened != null) {
          i = opened;
          continue;
        }
      }
      i++;
    }

    // 3. Run the plain (Highlights.json) rules across the whole line, skipping
    //    positions already claimed by a nestable.
    this.applyPlainRules(line, occupied, scopeOwnerPrio);

    // 4. Emit tokens from the occupied map, merging contiguous same-scope runs.
    let lastScope = -1;
    for (let pos = 0; pos < line.length; pos++) {
      const s = occupied[pos];
      if (s === -1) {
        lastScope = -1;
        continue;
      }
      if (s !== lastScope) {
        tokens.push({ startIndex: pos, scopes: SCOPE_TO_MONACO_TOKEN[SCOPE_PRECEDENCE[s]] ?? "" });
        lastScope = s;
      }
    }

    return { tokens, endState: new RegexState(this.ruleset, this.openNestable) };
  }

  /**
   * Scan from `start` for the closing delimiter of `n`, marking the span.
   *
   * `continuation=true` means we're resuming an open nestable from the previous
   * line (so the opening delimiter was on an earlier line and isn't in `line`);
   * otherwise the opening delimiter at `start` is consumed too.
   *
   * Returns the index after the consumed span (or, if the closer wasn't found
   * on this line, `line.length` and `this.openNestable` is set for next line).
   */
  private consumeNestable(
    line: string,
    start: number,
    n: NestableRule,
    occupied: Int16Array,
    scopeOwnerPrio: Int16Array,
    continuation: boolean,
  ): number {
    const scopeIdx = SCOPE_PRECEDENCE.indexOf(n.scope as (typeof SCOPE_PRECEDENCE)[number]);
    if (scopeIdx === -1) return start;

    let pos = continuation ? start : start + n.begin.length;
    if (!continuation) {
      this.markSpan(occupied, scopeOwnerPrio, start, pos, scopeIdx, line);
    }

    while (pos < line.length) {
      // Honour the escape character: a backslash before the delimiter hides it.
      if (
        n.escapeCharacter &&
        line[pos] === n.escapeCharacter &&
        pos + 1 < line.length
      ) {
        // Mark the escaped char as part of this scope and skip past it.
        this.markSpan(occupied, scopeOwnerPrio, pos, pos + 1, scopeIdx, line);
        pos += 2;
        continue;
      }
      if (line.startsWith(n.end, pos)) {
        const end = pos + n.end.length;
        this.markSpan(occupied, scopeOwnerPrio, pos, end, scopeIdx, line);
        return end;
      }
      this.markSpan(occupied, scopeOwnerPrio, pos, pos + 1, scopeIdx, line);
      pos++;
    }

    // Reached end of line without a closer: keep the nestable open.
    if (!n.isMultiline) {
      // Non-multiline nestables don't carry across lines; drop them.
      return pos;
    }
    this.openNestable = n;
    return pos;
  }

  /**
   * Try to open any nestable at `start`. If one opens, consume its span and
   * return the index after it; otherwise return null.
   */
  private tryOpenNestable(
    line: string,
    start: number,
    occupied: Int16Array,
    scopeOwnerPrio: Int16Array,
  ): number | null {
    // Longest-delimiter-first so ```` wins over ``.
    const sorted = [...this.ruleset.nestables].sort(
      (a, b) => b.begin.length - a.begin.length,
    );
    for (const n of sorted) {
      if (line.startsWith(n.begin, start)) {
        return this.consumeNestable(line, start, n, occupied, scopeOwnerPrio, false);
      }
    }
    return null;
  }

  /** Run begin/end and single-pattern rules over the free regions of `line`. */
  private applyPlainRules(
    line: string,
    occupied: Int16Array,
    scopeOwnerPrio: Int16Array,
  ): void {
    for (const rule of this.ruleset.rules) {
      const scopeIdx = SCOPE_PRECEDENCE.indexOf(rule.scope as (typeof SCOPE_PRECEDENCE)[number]);
      if (scopeIdx === -1) continue;

      if (rule.pair) {
        let pos = 0;
        while (pos < line.length) {
          const begin = this.findFreeMatch(rule.pair.beginRegex, line, pos, occupied);
          if (begin == null) break;
          // Search for the end after the begin match.
          const searchFrom = begin.index + begin.match.length;
          const end = this.findFreeMatch(rule.pair.endRegex, line, searchFrom, occupied, /*allowOwned=*/ false);
          let endIdx: number;
          if (end == null) {
            // No closer on this line: span runs to end of line. (We don't carry
            // plain pairs across lines for the MVP; nestables handle that.)
            endIdx = line.length;
          } else {
            endIdx = end.index + end.match.length;
          }
          this.markSpan(occupied, scopeOwnerPrio, begin.index, endIdx, scopeIdx, line);
          pos = Math.max(endIdx, begin.index + 1);
        }
      } else if (rule.single) {
        rule.single.regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.single.regex.exec(line)) != null) {
          const idx = m.index;
          const len = m[0].length;
          if (len === 0) {
            rule.single.regex.lastIndex++;
            continue;
          }
          this.markSpan(occupied, scopeOwnerPrio, idx, idx + len, scopeIdx, line);
          rule.single.regex.lastIndex = idx + len;
        }
      }
    }
  }

  /**
   * Find the first match of `re` in `line` at or after `from`, whose start
   * position is free (not already owned). Returns `{index, match}` or null.
   */
  private findFreeMatch(
    re: RegExp,
    line: string,
    from: number,
    occupied: Int16Array,
    allowOwned = false,
  ): { index: number; match: string } | null {
    re.lastIndex = from;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) != null) {
      const idx = m.index;
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (allowOwned || occupied[idx] === -1) {
        return { index: idx, match: m[0] };
      }
      // Skip past the owned region and retry.
      re.lastIndex = idx + 1;
    }
    return null;
  }

  /**
   * Mark `occupied[start..end)` as owned by `scopeIdx`, but only over positions
   * that aren't already claimed by a higher-precedence scope.
   *
   * Precedence is `SCOPE_PRECEDENCE` order: a lower index (e.g. comments) wins
   * over a higher index (e.g. keywords). `scopeOwnerPrio` records the winning
   * scope's precedence index so a later, lower-precedence rule can't overwrite.
   */
  private markSpan(
    occupied: Int16Array,
    scopeOwnerPrio: Int16Array,
    start: number,
    end: number,
    scopeIdx: number,
    line: string,
  ): void {
    const lo = Math.max(0, start);
    const hi = Math.min(line.length, end);
    for (let p = lo; p < hi; p++) {
      const existing = scopeOwnerPrio[p];
      if (existing === -1 || scopeIdx < existing) {
        occupied[p] = scopeIdx;
        scopeOwnerPrio[p] = scopeIdx;
      }
    }
  }
}

/* ----------------------------- exports for UI ----------------------------- */

/** Re-tokenize the current model. Called after a theme switch. */
export function refreshRegexTokens(): void {
  const model = getModel();
  if (!model) return;
  // Re-setting the language to itself flushes Monaco's token cache.
  monacoNs.editor.setModelLanguage(model, model.getLanguageId());
}

/** Exposed for the tree-sitter module's grammar registration symmetry. */
export { monacoIdForSyntax };
