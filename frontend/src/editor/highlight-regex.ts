/** Stateful, bounded line tokenizer for the supported CotEditor regex subset.
 * Nestable literals can span lines. Arbitrary whole-document ICU expressions
 * cannot: unsupported rules are reported once, not silently approximated.
 */
import type * as monaco from "monaco-editor";
import { monaco as monacoNs, getModel } from "./monaco-setup";
import { monacoIdForSyntax, type CotEditJson } from "./language-config";
import { HIGHLIGHT_LIMITS, warnHighlightOnce } from "./highlight-common";

export interface RegexRule {
  scope?: string;
  begin?: string;
  end?: string;
  regularExpression?: boolean;
  isMultiline?: boolean;
  ignoreCase?: boolean;
  description?: string;
}
export interface RegexHighlights { [scope: string]: RegexRule[] }
const SCOPE_PRECEDENCE = ["comments", "characters", "strings", "numbers", "values", "variables", "attributes", "types", "commands", "keywords"];
const SCOPE_TO_MONACO_TOKEN: Record<string, string> = {
  keywords: "keyword", commands: "keyword", types: "type", attributes: "attribute",
  variables: "variable", values: "literal", numbers: "number", strings: "string",
  characters: "string", comments: "comment",
};
interface CompiledRule { scope: number; begin: RegExp; end?: RegExp }
interface NestableRule { scope: number; begin: string; end: string; multiline: boolean; escape?: string; nested?: boolean }
interface Ruleset { rules: CompiledRule[]; nestables: NestableRule[]; inlines: string[]; limitations: string[] }
export interface RegexHighlightStatus { engine: "regex" | "fallback"; limitations: string[]; reason?: string }
const registrations = new Map<string, Promise<void>>();
const statuses = new Map<string, RegexHighlightStatus>();
const providers = new Map<string, monaco.IDisposable>();
export function getRegexHighlightStatus(languageId: string): RegexHighlightStatus | undefined {
  const s = statuses.get(languageId);
  return s ? { ...s, limitations: [...s.limitations] } : undefined;
}

/** Always settles safely, even when the caller is a fire-and-forget bootstrap. */
export function registerRegexLanguage(languageId: string, syntaxName: string): Promise<void> {
  const existing = registrations.get(languageId);
  if (existing) return existing;
  const pending = (async () => {
    try {
      const aliases: Record<string, string> = { "C#": "Csharp", "C++": "Cpp" };
      const base = `resources/syntaxes/${encodeURIComponent(aliases[syntaxName] ?? syntaxName)}.cotsyntax/`;
      const load = async (file: string): Promise<unknown> => {
        const response = await fetch(base + file);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${base}${file}`);
        return response.json();
      };
      const [highlights, edit] = await Promise.all([load("Regex/Highlights.json"), load("Edit.json")]);
      const tokenizer = createRegexTokenizer(highlights as RegexHighlights, edit as CotEditJson);
      const status: RegexHighlightStatus = { engine: "regex", limitations: tokenizer.limitations };
      if (status.limitations.length) warnHighlightOnce(`regex:${languageId}:unsupported-rules`, status.limitations.join("; "));
      const initial = tokenizer.getInitialState();
      providers.set(languageId, monacoNs.languages.setTokensProvider(languageId, {
        getInitialState: () => initial,
        tokenize: (line, state) => {
          try {
            if (line.length > HIGHLIGHT_LIMITS.lineLength) {
              warnHighlightOnce(`regex:${languageId}:long-line`, "Using default scope for an oversized line.");
            }
            return tokenizer.tokenize(line, state);
          } catch (error) {
            status.engine = "fallback";
            status.reason = "runtime-failed";
            warnHighlightOnce(`regex:${languageId}:runtime`, error);
            return { tokens: [{ startIndex: 0, scopes: "" }], endState: initial };
          }
        },
      }));
      statuses.set(languageId, status);
    } catch (error) {
      // Leave the existing builtin tokenizer intact; JSON has a default scope.
      statuses.set(languageId, { engine: "fallback", reason: "initialization-failed", limitations: [] });
      warnHighlightOnce(`regex:${languageId}:initialization`, error);
    }
  })();
  registrations.set(languageId, pending);
  return pending;
}
export async function registerRegexHighlight(): Promise<void> {
  await Promise.all([registerRegexLanguage("json", "JSON"), registerRegexLanguage("markdown", "Markdown")]);
}

function escapeRegex(source: string): string { return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Explicit ICU conversions. Absolute anchors remain absolute, never literal
 * A/z/Z or multiline ^/$. The line engine rejects document-boundary rules below.
 * Possessive quantifiers are NOT generally equivalent to greedy quantifiers:
 * only the two delimiter-disjoint JSON patterns are safely lowered.
 */
export function compilePattern(source: string, flags = "gmu"): RegExp {
  const classes: Record<string, string> = {
    alpha: "\\p{L}", alnum: "\\p{L}\\p{N}", digit: "\\p{Nd}",
    upper: "\\p{Lu}", lower: "\\p{Ll}", space: "\\s", punct: "\\p{P}", blank: "\\p{Zs}\\t",
  };
  let translated = source.replace(/\[\[:\^([a-z]+):\]\]/g, (_, name: string) => {
    if (!classes[name]) throw new Error(`Unsupported POSIX class: ${name}`);
    return `[^${classes[name]}]`;
  }).replace(/\[:([a-z]+):\]/g, (_, name: string) => {
    if (!classes[name]) throw new Error(`Unsupported POSIX class: ${name}`);
    // Already inside a bracket expression: do not introduce a second [].
    return classes[name];
  });
  if (/\[:\^/.test(translated)) throw new Error("Negated POSIX class inside a union is unsupported");
  let output = "", inClass = false;
  for (let i = 0; i < translated.length; i++) {
    const c = translated[i];
    if (c === "\\" && i + 1 < translated.length) {
      const next = translated[++i];
      if ("RAzZ".includes(next)) {
        if (inClass) throw new Error(`Unsupported \\${next} in character class`);
        output += next === "R" ? "(?:\\r\\n|[\\n\\r\\v\\f\\u0085\\u2028\\u2029])" :
          next === "A" ? "(?<![\\s\\S])" : next === "z" ? "(?![\\s\\S])" :
          "(?=(?:\\r\\n|[\\n\\r\\u0085\\u2028\\u2029])?(?![\\s\\S]))";
      } else if ((next === "p" || next === "P") && translated[i + 1] === "{") {
        // Unicode property escapes (\p{L}) must keep their braces intact.
        const close = translated.indexOf("}", i + 2);
        if (close < 0) throw new Error(`Unterminated \\${next}{...} property escape`);
        output += translated.slice(i - 1, close + 1);
        i = close;
      } else if (next === "_" || next === "=" || next === "'" || next === "!" || next === "@" || (!inClass && next === "-")) {
        output += next; // ICU identity escapes that JS Unicode mode rejects.
      } else {
        output += "\\" + next;
      }
    } else if (inClass) {
      if (c === "]") inClass = false;
      output += c;
    } else if (c === "[") {
      inClass = true;
      output += c;
    } else if (c === "]") {
      // ICU tolerates a bare ] (e.g. `(?<=])`), JS Unicode mode does not.
      output += "\\]";
    } else if (c === "{" && /^\{\d+(?:,\d*)?\}/.test(translated.slice(i))) {
      // A real quantifier; keep it verbatim.
      const quantifier = /^\{\d+(?:,\d*)?\}/.exec(translated.slice(i))![0];
      output += quantifier;
      i += quantifier.length - 1;
    } else if (c === "{" || c === "}") {
      // Stray braces are literals in ICU; JS Unicode mode requires escaping.
      output += "\\" + c;
    } else {
      output += c;
    }
  }
  output = output.replaceAll('[^\\r\\n"]++"', '[^\\r\\n"]+"').replaceAll('\\s*+(?=:)', '\\s*(?=:)');
  if (/(?:[*+?]|\{\d+(?:,\d*)?\})\+/.test(output)) throw new Error("Unsupported possessive quantifier");
  return new RegExp(output, flags.includes("u") ? flags : flags + "u");
}

function compileRules(highlights: RegexHighlights, edit: CotEditJson): Ruleset {
  const rules: CompiledRule[] = [], nestables: NestableRule[] = [], limitations: string[] = [];
  for (const d of edit.stringDelimiters ?? []) {
    if (d.begin && d.end) nestables.push({ scope: 2, begin: d.begin, end: d.end, multiline: !!d.isMultiline, escape: d.escapeCharacter });
  }
  for (const b of edit.comment?.blocks ?? []) {
    if (b.begin && b.end) nestables.push({ scope: 0, begin: b.begin, end: b.end, multiline: true, nested: b.isNestable });
  }
  const inlines = (edit.comment?.inlines ?? []).map(c => c.begin).filter((begin): begin is string => !!begin);
  for (const [scopeName, group] of Object.entries(highlights)) {
    const scope = SCOPE_PRECEDENCE.indexOf(scopeName);
    if (scope < 0) continue;
    for (const rule of group) {
      if (rule.begin == null) continue;
      const label = `${scopeName}/${rule.description ?? rule.begin}`;
      // A line provider cannot look ahead to another line or know document EOF.
      // Keep these limitations visible instead of converting anchors to letters,
      // dropping possessiveness, or pretending single-line results are complete.
      if (rule.regularExpression && /\\[AZz]/.test(rule.begin + (rule.end ?? ""))) {
        limitations.push(`${label}: whole-document anchor unavailable in line tokenizer`);
        continue;
      }
      if (rule.regularExpression && /\\R/.test(rule.begin)) {
        limitations.push(`${label}: only same-line matches supported`);
      }
      if (rule.end && rule.isMultiline) {
        limitations.push(`${label}: multiline regex pair unsupported (literal delimiters are supported)`);
        continue;
      }
      try {
        const flags = `gmu${rule.ignoreCase ? "i" : ""}`;
        const compile = (text: string): RegExp => rule.regularExpression ? compilePattern(text, flags) : new RegExp(escapeRegex(text), flags);
        rules.push({ scope, begin: compile(rule.begin), end: rule.end == null ? undefined : compile(rule.end) });
      } catch (error) {
        limitations.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  rules.sort((a, b) => a.scope - b.scope);
  nestables.sort((a, b) => b.begin.length - a.begin.length);
  return { rules, nestables, inlines, limitations };
}

/** Component seam used by regression tests; this is the installed engine. */
export function createRegexTokenizer(highlights: RegexHighlights, edit: CotEditJson): monaco.languages.TokensProvider & { limitations: string[] } {
  const ruleset = compileRules(highlights, edit);
  return {
    limitations: ruleset.limitations,
    getInitialState: () => new RegexState(ruleset),
    tokenize: (line, state) => (state as RegexState).tokenize(line),
  };
}

interface OpenNestable { rule: NestableRule; depth: number }
class RegexState implements monaco.languages.IState {
  constructor(private readonly ruleset: Ruleset, private readonly open: OpenNestable | null = null) {}
  clone(): monaco.languages.IState { return new RegexState(this.ruleset, this.open ? { ...this.open } : null); }
  equals(other: monaco.languages.IState): boolean {
    return other instanceof RegexState && other.ruleset === this.ruleset && other.open?.rule === this.open?.rule && other.open?.depth === this.open?.depth;
  }
  tokenize(line: string): monaco.languages.ILineTokens {
    if (line.length > HIGHLIGHT_LIMITS.lineLength) {
      // Do not lose an open multiline literal just because this line is huge.
      return { tokens: [{ startIndex: 0, scopes: "" }], endState: new RegexState(this.ruleset, this.open ? { ...this.open } : null) };
    }
    const occupied = new Int16Array(line.length).fill(-1);
    const locked = new Uint8Array(line.length);
    let nextOpen: OpenNestable | null = null;
    const consume = (start: number, rule: NestableRule, depth = 1, continuation = false): number => {
      let pos = continuation ? start : start + rule.begin.length;
      let closed = false;
      while (pos < line.length) {
        if (rule.escape && line.startsWith(rule.escape, pos)) {
          pos = Math.min(line.length, pos + rule.escape.length + 1);
        } else if (line.startsWith(rule.end, pos)) {
          pos += rule.end.length;
          if (--depth === 0) { closed = true; break; }
        } else if (rule.nested && rule.begin !== rule.end && line.startsWith(rule.begin, pos)) {
          depth++;
          pos += rule.begin.length;
        } else pos++;
      }
      occupied.fill(rule.scope, start, pos);
      locked.fill(1, start, pos);
      if (!closed && rule.multiline) nextOpen = { rule, depth };
      return pos;
    };
    let pos = this.open ? consume(0, this.open.rule, this.open.depth, true) : 0;
    while (pos < line.length) {
      // Inline comments lock their entire tail before strings inside can open.
      const inline = this.ruleset.inlines.some(begin => line.startsWith(begin, pos));
      if (inline) { occupied.fill(0, pos); locked.fill(1, pos); break; }
      const rule = this.ruleset.nestables.find(n => line.startsWith(n.begin, pos));
      pos = rule ? consume(pos, rule) : pos + 1;
    }
    const mark = (start: number, end: number, scope: number): void => {
      for (let i = start; i < end; i++) if (!locked[i] && (occupied[i] === -1 || scope < occupied[i])) occupied[i] = scope;
    };
    for (const rule of this.ruleset.rules) {
      rule.begin.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.begin.exec(line))) {
        const start = match.index;
        let end = start + match[0].length;
        if (!match[0].length) { rule.begin.lastIndex = advanceCodePoint(line, end); continue; }
        if (rule.end) {
          if (locked[start]) { rule.begin.lastIndex = advanceCodePoint(line, start); continue; }
          rule.end.lastIndex = end;
          const closer = rule.end.exec(line); // Zero-width $ is a valid closer.
          end = closer ? closer.index + closer[0].length : line.length;
        }
        mark(start, end, rule.scope);
        rule.begin.lastIndex = Math.max(end, advanceCodePoint(line, start));
      }
    }
    const tokens: monaco.languages.IToken[] = [];
    for (let i = 0; i < line.length; i++) {
      if (i === 0 || occupied[i] !== occupied[i - 1]) {
        tokens.push({ startIndex: i, scopes: occupied[i] < 0 ? "" : SCOPE_TO_MONACO_TOKEN[SCOPE_PRECEDENCE[occupied[i]]] ?? "" });
      }
    }
    if (!tokens.length) tokens.push({ startIndex: 0, scopes: "" });
    return { tokens, endState: new RegexState(this.ruleset, nextOpen) };
  }
}
function advanceCodePoint(line: string, index: number): number {
  return index + ((line.codePointAt(index) ?? 0) > 0xffff ? 2 : 1);
}

export function refreshRegexTokens(): void {
  const model = getModel();
  if (model && !model.isDisposed()) monacoNs.editor.setModelLanguage(model, model.getLanguageId());
}
if (import.meta.hot) import.meta.hot.dispose(() => {
  providers.forEach(d => d.dispose());
  providers.clear();
});
export { monacoIdForSyntax };
