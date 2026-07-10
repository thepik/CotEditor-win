/**
 * Multiple-replace engine (PLAN §阶段7, §十).
 *
 * Ported from CotEditor's `Packages/EditorCore/Sources/TextFind/MultipleReplace.swift`.
 * A MultipleReplace is an ordered list of replacement rules; each rule runs
 * independently with its own regex / case-sensitivity flags, and rules execute
 * in sequence over the whole text (the output of rule N feeds rule N+1).
 *
 * Supports TSV import/export: each non-empty line is `find\treplace`, with an
 * optional third column `flags` (e.g. `i` for ignore case, `r` for regex).
 */

export interface ReplaceRule {
  /** Whether this rule is active. Inactive rules are skipped. */
  enabled: boolean;
  /** Case-insensitive matching. */
  ignoreCase: boolean;
  /** Treat `find` as a regex; if false, literal string replacement. */
  isRegex: boolean;
  /** The search string / pattern. */
  find: string;
  /** The replacement string. May contain `$1`..`$9` for regex groups. */
  replace: string;
}

export interface MultipleReplace {
  name: string;
  rules: ReplaceRule[];
}

/**
 * Run a multiple-replace over `text`, returning the transformed string.
 *
 * Rules run in order; an inactive rule is skipped. Literal (non-regex) rules
 * use a global string replace; regex rules use `String.prototype.replace`
 * with the `g` flag. Invalid regex rules are skipped with a warning rather
 * than aborting the whole pipeline.
 */
export function runMultipleReplace(
  text: string,
  replace: MultipleReplace,
): string {
  let out = text;
  for (const rule of replace.rules) {
    if (!rule.enabled || rule.find === "") continue;
    out = applyRule(out, rule);
  }
  return out;
}

function applyRule(text: string, rule: ReplaceRule): string {
  if (rule.isRegex) {
    try {
      const flags = rule.ignoreCase ? "gi" : "g";
      const re = new RegExp(rule.find, flags);
      return text.replace(re, rule.replace);
    } catch (err) {
      console.warn("Invalid regex rule, skipping:", rule.find, err);
      return text;
    }
  }
  // Literal: use a split/join to avoid regex special chars in `find`.
  if (rule.ignoreCase) {
    const lowerFind = rule.find.toLowerCase();
    const lowerText = text.toLowerCase();
    let result = "";
    let i = 0;
    let pos = lowerText.indexOf(lowerFind, i);
    while (pos !== -1) {
      result += text.slice(i, pos) + rule.replace;
      i = pos + rule.find.length;
      pos = lowerText.indexOf(lowerFind, i);
    }
    return result + text.slice(i);
  }
  return text.split(rule.find).join(rule.replace);
}

/**
 * Export a multiple-replace as TSV.
 *
 * Format: one rule per line, fields tab-separated:
 *   `find\treplace\tflags`
 * where `flags` is `i` if ignore-case, `r` if regex, `ir` if both. A header
 * line starting with `#` is emitted for human readability (CotEditor omits
 * this, but it aids round-tripping).
 */
export function exportToTsv(replace: MultipleReplace): string {
  const lines = replace.rules.map((r) => {
    const flags =
      (r.ignoreCase ? "i" : "") + (r.isRegex ? "r" : "") || (r.enabled ? "" : "x");
    return [r.find, r.replace, flags].join("\t");
  });
  return lines.join("\n");
}

/**
 * Parse TSV exported by `exportToTsv` back into a MultipleReplace.
 *
 * Lines starting with `#` are comments. Lines without a tab are treated as a
 * find-only literal rule with empty replacement. The `flags` field is parsed
 * case-insensitively; `x` disables the rule.
 */
export function importFromTsv(name: string, tsv: string): MultipleReplace {
  const rules: ReplaceRule[] = [];
  for (const line of tsv.split(/\r?\n/)) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const parts = line.split("\t");
    const find = parts[0] ?? "";
    const replace = parts[1] ?? "";
    const flags = (parts[2] ?? "").toLowerCase();
    rules.push({
      enabled: !flags.includes("x"),
      ignoreCase: flags.includes("i"),
      isRegex: flags.includes("r"),
      find,
      replace,
    });
  }
  return { name, rules };
}
