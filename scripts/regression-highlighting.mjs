// Component regression against Vite, in an isolated context without main.ts.
// Run: node scripts/regression-highlighting.mjs http://127.0.0.1:1420/
// Engine behaviour is asserted through token output, status, worker counters and
// the worker engine core (fault injection); no token-color/DOM-class substitute.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:1420/";
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors = [], warnings = [];
// The custom HTML does not bootstrap main.ts, so Vite's HMR client cannot finish
// its handshake in this Playwright context. That transport noise is unrelated to
// highlighting; everything else (including page errors) still fails the run.
const isHmrTransportNoise = text =>
  text.includes("[vite] failed to connect to websocket") ||
  (text.includes("WebSocket connection to 'ws://") && text.includes("ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS"));
page.on("pageerror", e => errors.push(e.message));
page.on("console", message => {
  if (message.type() === "error" && !isHmrTransportNoise(message.text())) errors.push(message.text());
  if (message.type() === "warning") warnings.push(message.text());
});
// Keep module/WASM requests real, but do not bootstrap document IO or other agents' UI.
await context.route(base, route => route.fulfill({ contentType: "text/html", body:
  '<div id="editor" style="width:800px;height:600px"></div><div id="preview"><div class="preview-body"></div></div>' }));
try {
  await page.goto(base);
  const report = await page.evaluate(async () => {
    const checks = [];
    const check = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
    // Vite rewrites imports to HMR-timestamped URLs (?t=...) once files change
    // while the dev server is running. Importing the plain paths would then
    // create a second module graph (empty grammar map, separate Monaco). Crawl
    // the transformed sources and import the exact URLs the app would use.
    const discovered = new Map();
    const visited = new Set();
    const queue = [
      "/src/editor/monaco-setup.ts", "/src/editor/highlight-tree-sitter.ts",
      "/src/editor/grammar-registry.ts", "/src/editor/highlight-common.ts",
      "/src/editor/highlight-regex.ts", "/src/editor/language-config.ts",
      "/src/editor/highlight-worker-engine.ts", "/src/ui/preview.ts",
    ];
    while (queue.length) {
      const path = queue.pop();
      if (visited.has(path)) continue;
      visited.add(path);
      if (!discovered.has(path)) discovered.set(path, path);
      const source = await (await fetch(path)).text();
      for (const match of source.matchAll(/["'](\/src\/[^"'\s]+\.(?:ts|js)(?:\?[^"']*)?)["']/g)) {
        const url = match[1], key = url.split("?")[0];
        const current = discovered.get(key);
        if (!current || (!current.includes("?") && url.includes("?"))) discovered.set(key, url);
        if (!visited.has(key)) queue.push(key);
      }
    }
    const load = path => import(discovered.get(path) ?? path);
    const { monaco, setupMonaco, getModel, getEditor } = await load("/src/editor/monaco-setup.ts");
    const ts = await load("/src/editor/highlight-tree-sitter.ts");
    const registry = await load("/src/editor/grammar-registry.ts");
    const common = await load("/src/editor/highlight-common.ts");
    const regex = await load("/src/editor/highlight-regex.ts");
    const language = await load("/src/editor/language-config.ts");
    await setupMonaco();
    registry.registerAllGrammars();
    registry.registerAllGrammars();
    ts.registerHighlightProviders();
    await language.attachLanguage();
    await regex.registerRegexHighlight();

    function decode(data, model) {
      check(data.length % 5 === 0, "semantic token encoding / 5");
      const result = [];
      let line = 0, column = 0;
      for (let i = 0; i < data.length; i += 5) {
        line += data[i]; column = data[i] === 0 ? column + data[i + 1] : data[i + 1];
        const length = data[i + 2], type = data[i + 3];
        check(length > 0 && line < model.getLineCount() && column + length <= model.getLineLength(line + 1), "token within a single line");
        const previous = result.at(-1);
        check(!previous || previous.line < line || previous.column + previous.length <= column, "tokens sorted without overlaps");
        result.push({ line, column, length, type, text: model.getLineContent(line + 1).slice(column, column + length) });
      }
      return result;
    }
    const samples = {
      javascript: 'const greeting = "中文😀";\nfunction hi() { return 42; }',
      typescript: 'const greeting: string = "中文😀";\nfunction hi(): number { return 42; }',
      python: 'def hi():\n    message = """中文😀\nsecond\\nline\nend"""\n    return 42',
      html: '<div title="中文😀">hello</div><!-- comment -->',
      css: '@scope (.card) { a { color: red; width: 42px; } }',
      shell: 'echo "中文😀"\nvalue=42 # comment',
      c: 'int main() { /* 中文😀 */ return 42; }',
      cpp: 'class Hello {}; int main() { return 42; }',
      java: 'class Hello { int value = 42; String s = "中文😀"; }',
      go: 'package main\nfunc main() { s := "中文😀"; println(s, 42) }',
      rust: 'fn main() { let s = "中文😀"; println!("{}", 42); }',
      ruby: 'def hi\n  puts "中文😀"\n  42\nend',
      php: '<?php use function A\\b as c; use A\\B as C; function hi() { yield from $xs; return "中文😀"; } ?>text',
      swift: 'macro hi() = #externalMacro(module: "A", type: "B")\nlet s = "中文😀"',
      kotlin: 'fun main() { val s = "中文😀"; println(42) }',
      csharp: 'class Hello { void F() { foreach (var item in items) { var s = "中文😀"; } } }',
    };
    const grammars = [], grammarFailures = [];
    for (const grammar of registry.GRAMMARS) {
      const model = monaco.editor.createModel(samples[grammar.languageId], grammar.languageId);
      try {
        const result = await ts.buildTokens(model);
        const status = ts.getTreeHighlightStatus(model);
        check(status?.engine === "tree-sitter", `${grammar.languageId}: CUSTOM engine, not builtin fallback (${JSON.stringify(status)})`);
        check(result?.data.length > 0, `${grammar.languageId}: custom query captures`);
        const tokens = decode(result.data, model);
        if (grammar.languageId === "css") check(tokens.some(t => t.text === "@scope" && t.type === 0), "CSS generic @scope command");
        if (grammar.languageId === "php") {
          check(tokens.some(t => t.text === "from" && t.type === 0), "PHP yield from keyword split");
          const cOffset = samples.php.indexOf("as c") + 3;
          check(tokens.some(t => t.column === cOffset && t.type === 0), "PHP function import alias command");
          const typeOffset = samples.php.indexOf("as C") + 3;
          check(tokens.some(t => t.column === typeOffset && t.type === 1), "PHP class import alias type");
        }
        if (grammar.languageId === "csharp") check(tokens.some(t => t.text === "item" && t.type === 3), "Csharp foreach variable field");
        if (grammar.languageId === "swift") check(tokens.some(t => t.text === "hi" && t.type === 0), "Swift supported macro declaration command");
        if (grammar.languageId === "python") check(tokens.some(t => t.line === 2 && t.type === 6), "Python multiline string split");
        if (grammar.languageId === "javascript") check(tokens.some(t => t.text.includes("中文😀") && t.length === '"中文😀"'.length), "WASM offsets are UTF-16 including Chinese and emoji");
        grammars.push({ language: grammar.languageId, engine: status.engine, tokens: tokens.length });
      } catch (error) {
        grammarFailures.push(`${grammar.languageId}: ${error.message}`);
      } finally { model.dispose(); }
      check(ts.getTreeHighlightResources().trees === 0, "temporary tree deleted after parse");
    }
    check(grammarFailures.length === 0, `all 16 grammar loads/queries succeed: ${grammarFailures.join("; ")}`);
    check(grammars.length === 16, "all 16 grammar loads and query compilations covered");
    check(!common.getHighlightWarnings().some(w => /^tree-sitter:(?!test-).+:initialization$/.test(w.key)), "no production grammar/query initialization warnings");

    // The parse/query work must actually live in the dedicated worker: the
    // snapshot below is produced inside it (inWorker) and counts its parses.
    const grammarWorkerStats = await ts.getTreeSitterWorkerStats();
    check(grammarWorkerStats?.inWorker === true, "tree-sitter parses inside a dedicated worker thread");
    check((grammarWorkerStats?.parses ?? 0) >= 16, "worker executed every grammar parse");
    check(grammarWorkerStats.parsers === 0 && grammarWorkerStats.queries === 0 && grammarWorkerStats.trees === 0,
      "worker released parser/query/tree after the last 16-language model closed");
    check(ts.isTreeSitterWorkerRunning(), "worker stays alive for reuse");
    check(ts.getTreeSitterClientStats().requests >= 16, "main thread submitted parse requests to the worker");

    const model = monaco.editor.createModel('中文😀abc\r\ndef\r\nghi', "plaintext");
    const captures = [
      { startIndex: 0, endIndex: model.getValueLength(), patternIndex: 99, scope: "strings" },
      { startIndex: 4, endIndex: 6, patternIndex: 1, scope: "variables" },
      { startIndex: 4, endIndex: 6, patternIndex: 2, scope: "numbers" },
    ];
    const ranges = common.resolveCaptureRanges(captures);
    check(ranges.find(c => c.startIndex === 4)?.scope === "numbers", "child wins parent, last pattern wins equal range");
    const packed = decode(ts.packTokens(ranges, model), model);
    check(packed.some(t => t.line === 0 && t.column === 4 && t.length === 2 && t.type === 5), "UTF-16 child range after emoji");
    check(packed.some(t => t.line === 2 && t.length === 3), "CRLF excluded from multiline tokens");
    model.dispose();

    // Deterministic randomized range oracle, including crossing ranges.
    let seed = 12345;
    const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    for (let round = 0; round < 80; round++) {
      const input = Array.from({ length: 25 }, (_, id) => {
        const startIndex = random(40);
        return { startIndex, endIndex: startIndex + 1 + random(40 - startIndex), patternIndex: random(5), scope: String(id) };
      });
      const output = common.resolveCaptureRanges(input);
      for (let pos = 0; pos < 40; pos++) {
        const expected = input.map((c, id) => ({ ...c, id })).filter(c => c.startIndex <= pos && pos < c.endIndex)
          .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex) || b.patternIndex - a.patternIndex || b.id - a.id)[0]?.scope;
        check(output.find(c => c.startIndex <= pos && pos < c.endIndex)?.scope === expected, "range sweep matches reference oracle");
      }
    }

    const jsonHighlights = await (await fetch("/resources/syntaxes/JSON.cotsyntax/Regex/Highlights.json")).json();
    const jsonEdit = await (await fetch("/resources/syntaxes/JSON.cotsyntax/Edit.json")).json();
    const json = regex.createRegexTokenizer(jsonHighlights, jsonEdit);
    check(json.limitations.length === 0, "JSON rules fully supported");
    const scopeAt = (tokens, offset) => tokens.filter(t => t.startIndex <= offset).at(-1)?.scopes;
    const source = '{"中文😀": "a\\\"//b", "n": 42, "ok": true} // note';
    const initial = json.getInitialState();
    const result = json.tokenize(source, initial);
    check(scopeAt(result.tokens, 0) === "", "JSON leading default scope");
    check(scopeAt(result.tokens, source.indexOf(":")) === "", "JSON punctuation resets default scope");
    check(scopeAt(result.tokens, source.indexOf(",")) === "", "JSON string end does not extend color");
    check(scopeAt(result.tokens, source.indexOf("42")) === "number", "JSON number scope");
    check(scopeAt(result.tokens, source.indexOf("}")) === "", "JSON value end does not extend color");
    check(scopeAt(result.tokens, source.indexOf("//b")) === "string", "escaped quote and comment inside string stay string");
    check(scopeAt(result.tokens, source.indexOf("// note")) === "comment", "resource inline comment begin");
    const open = json.tokenize("/* a", initial);
    check(!open.endState.equals(initial), "block comment state carried");
    check(initial.equals(json.getInitialState()), "tokenization does not mutate input state");
    const close = json.tokenize("中文😀 */ 42", open.endState);
    check(scopeAt(close.tokens, close.tokens.at(-1).startIndex) !== "comment", "block comment closes and resets color");
    const empty = json.tokenize("", open.endState);
    check(empty.endState.equals(open.endState), "empty line preserves open multiline state");
    const literal = regex.createRegexTokenizer({ values: [{ begin: "a+b" }] }, {});
    check(scopeAt(literal.tokenize("a+b aaab", literal.getInitialState()).tokens, 0) === "literal", "omitted regex flag means literal");
    check(regex.compilePattern("[[:alpha:]]+").test("中文Ab"), "POSIX class not double bracketed and handles Unicode");
    check(regex.compilePattern("[x[:digit:]]+").test("x12"), "POSIX class union");
    check(regex.compilePattern("[[:^digit:]]+").test("abc"), "negated POSIX class");
    const matches = (source, text) => new RegExp(regex.compilePattern(source).source, "mu").test(text);
    check(matches("\\Aabc\\z", "abc") && !matches("\\Aabc\\z", "x\nabc") && !matches("\\Aabc\\z", "abc\n"), "absolute anchors not multiline or identity escapes");
    check(matches("abc\\Z", "abc\n"), "ICU Z permits final newline");
    check(matches("\\\\A", "\\A"), "escaped backslash is not translated as anchor");
    let rejected = false;
    try { regex.compilePattern("a++a"); } catch { rejected = true; }
    check(rejected, "non-equivalent possessive lowering rejected");
    const mdHighlights = await (await fetch("/resources/syntaxes/Markdown.cotsyntax/Regex/Highlights.json")).json();
    const mdEdit = await (await fetch("/resources/syntaxes/Markdown.cotsyntax/Edit.json")).json();
    const md = regex.createRegexTokenizer(mdHighlights, mdEdit);
    check(md.limitations.length > 0, "Markdown whole-document limitations explicit");
    check(scopeAt(md.tokenize("*hello* plain", md.getInitialState()).tokens, 1) === "attribute", "Markdown single-line emphasis retained");
    const fence = md.tokenize("```", md.getInitialState());
    const inside = md.tokenize("中文😀", fence.endState);
    check(scopeAt(inside.tokens, 0) === "string", "Markdown literal fence carries state");
    check(md.tokenize("``` normal", inside.endState).endState.equals(md.getInitialState()), "Markdown fence closes");
    check(!md.limitations.some(l => l.includes("Invalid regular expression")), "Markdown rule patterns compile after ICU conversion");
    check(scopeAt(md.tokenize("[](x)", md.getInitialState()).tokens, 2) === "string", "Markdown lookbehind link target rule remains active");
    const oversized = md.tokenize("x".repeat(common.HIGHLIGHT_LIMITS.lineLength + 1), fence.endState);
    check(oversized.tokens.length === 1 && oversized.tokens[0].scopes === "", "oversized line falls back to the default scope");
    check(oversized.endState.equals(fence.endState), "oversized line preserves the open multiline literal");
    check(regex.compilePattern("(?<=])\\(x\\)").test("](x)"), "bare ICU ] inside lookbehind is escaped for JS Unicode mode");
    check(regex.compilePattern("a{2,3}b").test("aaab"), "numeric quantifier braces stay intact");

    // Verify actual Monaco line tokenizer, not just the component's status.
    check(regex.getRegexHighlightStatus("json")?.engine === "regex", "registered JSON custom engine");
    const actual = monaco.editor.tokenize('{"a": 42}', "json")[0];
    check(actual.some(t => t.offset === 4 && t.type === ""), "Monaco installed JSON tokenizer resets punctuation");
    const installedComment = monaco.editor.tokenize('{} // note', "json")[0];
    check(installedComment.some(t => t.offset === 3 && t.type === "comment"), "Monaco uses the custom JSON tokenizer (builtin JSON has no // comments)");
    const active = getModel();
    monaco.editor.setModelLanguage(active, "javascript");
    active.setValue("const x = 1;");
    getEditor().setPosition({ lineNumber: 1, column: 1 });
    await getEditor().getAction("editor.action.commentLine").run();
    check(active.getValue().startsWith("//"), "language config reads Edit.json begin for comments");
    monaco.editor.setModelLanguage(active, "plaintext");

    // Mock only loading timing, never successful tokens, in independent models.
    const pythonWasm = "/node_modules/tree-sitter-wasms/out/tree-sitter-python.wasm";
    const makeDeferred = (id, query = '(integer) @numbers') => {
      monaco.languages.register({ id });
      let resolve;
      const gate = new Promise(r => { resolve = r; });
      const calls = { wasm: 0, query: 0 };
      ts.registerGrammar(id, async () => { calls.wasm++; await gate; return pythonWasm; }, async () => { calls.query++; return query; });
      return { calls, resolve };
    };
    const concurrent = makeDeferred("test-concurrent");
    const a = monaco.editor.createModel("42", "test-concurrent"), b = monaco.editor.createModel("43", "test-concurrent");
    const pa = ts.buildTokens(a), pb = ts.buildTokens(b);
    concurrent.resolve();
    const values = await Promise.all([pa, pb]);
    check(values.every(r => r?.data.length === 5), "concurrent models receive custom tokens");
    check(concurrent.calls.wasm === 1 && concurrent.calls.query === 1, "language initialization promise deduplicated");
    check(ts.getTreeHighlightResources().parsers === 1, "one parser shared by same-language live models");
    a.dispose();
    check(ts.getTreeHighlightResources().parsers === 1, "first model close retains shared parser");
    b.dispose();
    check(ts.getTreeHighlightResources().parsers === 0, "last model close deletes parser/query");
    check((await ts.getTreeSitterWorkerStats())?.parsers === 0, "worker deleted parser/query on last model close");
    const switcher = monaco.editor.createModel("x = 1", "python");
    await ts.buildTokens(switcher);
    check(ts.getTreeHighlightResources().parsers === 1, "language switch fixture loaded");
    monaco.editor.setModelLanguage(switcher, "plaintext");
    check(ts.getTreeHighlightResources().parsers === 0 && ts.getTreeHighlightResources().sessions === 0, "switching away releases parser/query");
    const switchedStats = await ts.getTreeSitterWorkerStats();
    check(switchedStats?.parsers === 0 && switchedStats?.queries === 0, "worker released parser/query on language switch");
    monaco.editor.setModelLanguage(switcher, "python");
    check((await ts.buildTokens(switcher))?.data.length > 0, "switching back reloads the grammar");
    check(ts.getTreeHighlightResources().parsers === 1, "switching back recreates shared parser/query");
    switcher.dispose();
    check(ts.getTreeHighlightResources().parsers === 0 && ts.getTreeHighlightResources().trees === 0, "switched model close cleans up again");

    // A superseded request must be dropped from the main thread.
    const superseded = monaco.editor.createModel("x = 1", "python");
    const firstPass = ts.buildTokens(superseded);
    const secondPass = ts.buildTokens(superseded);
    const [stalePass, latestPass] = await Promise.all([firstPass, secondPass]);
    check(stalePass === null, "superseded result discarded from the main thread");
    check(latestPass?.data.length > 0, "latest request still receives worker tokens");
    superseded.dispose();

    // Cancellation must settle the caller without waiting for the worker, and
    // must not poison the language for the next request.
    const cancelTarget = monaco.editor.createModel("x = 1", "python");
    const cancellation = new monaco.CancellationTokenSource();
    const cancelled = ts.buildTokens(cancelTarget, cancellation.token);
    await Promise.resolve(); // the parse request has now been posted
    const cancelledBefore = ts.getTreeSitterClientStats().cancelled;
    cancellation.cancel();
    check(await cancelled === null, "cancelled request resolves null");
    check(ts.getTreeSitterClientStats().cancelled > cancelledBefore, "in-flight worker request cancelled");
    await new Promise(resolve => setTimeout(resolve, 50));
    check(ts.getTreeSitterClientStats().orphaned > 0, "late worker response for a cancelled request is dropped");
    check((await ts.buildTokens(cancelTarget))?.data.length > 0, "cancellation leaves the engine usable");
    cancelTarget.dispose();
    for (const mode of ["switch", "version", "dispose", "cancel"]) {
      const id = `test-${mode}`, delayed = makeDeferred(id);
      const m = monaco.editor.createModel("42", id);
      const cancel = { isCancellationRequested: false };
      const pending = ts.buildTokens(m, cancel);
      if (mode === "switch") { monaco.editor.setModelLanguage(m, "plaintext"); monaco.editor.setModelLanguage(m, id); }
      if (mode === "version") m.setValue("43");
      if (mode === "dispose") m.dispose();
      if (mode === "cancel") cancel.isCancellationRequested = true;
      delayed.resolve();
      check(await pending === null, `stale ${mode} result discarded`);
      if (!m.isDisposed()) m.dispose();
    }
    const failed = makeDeferred("test-invalid-query", "(nonexistent_node) @keywords");
    const bad = monaco.editor.createModel("42", "test-invalid-query");
    failed.resolve();
    check((await ts.buildTokens(bad))?.data.length === 0, "invalid query safely returns empty semantic tokens");
    check(ts.getTreeHighlightStatus(bad)?.engine === "fallback", "invalid query explicitly reported as fallback");
    await ts.buildTokens(bad);
    check(common.getHighlightWarnings().filter(w => w.key === "tree-sitter:test-invalid-query:initialization").length === 1, "initialization warning once");
    bad.dispose();
    monaco.languages.register({ id: "test-network-failure" });
    ts.registerGrammar("test-network-failure", async () => { throw new Error("simulated network failure"); }, async () => "");
    const network = monaco.editor.createModel("42", "test-network-failure");
    await ts.buildTokens(network);
    check(ts.getTreeHighlightStatus(network)?.engine === "fallback", "WASM/network failure caught");
    network.dispose();
    for (const [text, reason] of [["x".repeat(common.HIGHLIGHT_LIMITS.codeUnits + 1), "large-document"], ["x".repeat(common.HIGHLIGHT_LIMITS.lineLength + 1), "long-line"], ["x\n".repeat(common.HIGHLIGHT_LIMITS.lines), "large-document"]]) {
      const large = monaco.editor.createModel(text, "python");
      await ts.buildTokens(large);
      check(ts.getTreeHighlightStatus(large)?.reason === reason, `large input fallback: ${reason}`);
      large.dispose();
    }
    for (let i = 0; i < 20; i++) {
      const m = monaco.editor.createModel("x = 42", "python");
      await ts.buildTokens(m);
      m.dispose();
    }
    check(ts.getTreeHighlightResources().sessions === 0 && ts.getTreeHighlightResources().trees === 0, "20 open/parse/close cycles leave no trees, parsers or queries");
    const idleStats = await ts.getTreeSitterWorkerStats();
    check(idleStats?.parsers === 0 && idleStats?.queries === 0 && idleStats?.trees === 0, `worker idles with no parser, query or tree (${JSON.stringify(idleStats)})`);
    check(idleStats?.releases > 0, "worker recorded parser/query releases");

    // Worker engine core, exercised in-page so runtime faults can be injected.
    // The sandbox engine shares the page's web-tree-sitter module; the live
    // worker has its own isolated WASM instance, so these patches never affect
    // the worker-backed assertions above.
    const engineModule = await load("/src/editor/highlight-worker-engine.ts");
    const runtime = await engineModule.getTreeSitterRuntime();
    const engine = new engineModule.HighlightWorkerEngine();
    let engineRequest = 1;
    const engineParse = () => engine.handle({
      type: "parse", requestId: ++engineRequest, modelKey: 1, languageId: "edge", version: 1, lines: ["x = 42"],
    });
    const engineInit = await engine.handle({
      type: "init", requestId: engineRequest, languageId: "edge", wasm: pythonWasm, query: "(integer) @numbers",
    });
    check(engineInit.type === "initialized", "worker engine compiles grammar and query");
    const healthy = await engineParse();
    check(healthy.type === "tokens" && healthy.data.length === 5, "worker engine packs capture tokens");
    check(engine.stats().parsers === 1 && engine.stats().queries === 1, "worker engine owns exactly one parser/query");
    for (const phase of ["query-throw", "parse-null"]) {
      const isQuery = phase === "query-throw";
      const prototype = isQuery ? runtime.Query.prototype : runtime.Parser.prototype;
      const method = isQuery ? "matches" : "parse";
      const original = prototype[method];
      prototype[method] = isQuery
        ? () => { throw new Error("simulated query failure"); }
        : () => null;
      try {
        const failed = await engineParse();
        check(failed.type === "fallback" && failed.reason === (isQuery ? "runtime-failed" : "parse-budget"), `${phase} reports fallback`);
        check(failed.released === true, `${phase} releases worker parser/query`);
        const after = engine.stats();
        check(after.trees === 0 && after.parsers === 0 && after.queries === 0, `${phase} leaves no tree/parser/query`);
      } finally { prototype[method] = original; }
    }
    const recovered = await engineParse();
    check(recovered.type === "tokens" && recovered.data.length === 5, "engine lazily recreates parser/query after failure");
    await engine.handle({ type: "release", languageId: "edge" });
    const released = engine.stats();
    check(released.parsers === 0 && released.queries === 0 && released.trees === 0, "engine release frees parser/query");
    engine.dispose();
    check(engine.stats().parsers === 0 && engine.stats().queries === 0, "engine dispose frees every parser/query");
    const preview = await load("/src/ui/preview.ts");
    preview.renderPreview('# Heading\n\n**safe** [bad](javascript:alert(1)) <img src=x onerror="alert(1)">');
    check(document.querySelector(".preview-body strong")?.textContent === "safe", "patched markdown-it renders normal Markdown");
    check(!document.querySelector(".preview-body script, .preview-body [onerror], .preview-body [href^='javascript:']"), "preview sanitization remains safe");
    const diagnostics = common.getHighlightWarnings();
    const resources = ts.getTreeHighlightResources();
    const workerDiagnostics = await ts.getTreeSitterWorkerStats();
    const clientDiagnostics = ts.getTreeSitterClientStats();
    check(workerDiagnostics?.inWorker === true, "resource snapshot came from the worker thread");
    ts.disposeHighlightProviders();
    check(ts.getTreeHighlightResources().models === 0, "provider teardown removes model listeners");
    check(!ts.isTreeSitterWorkerRunning(), "provider teardown terminates the worker");
    check(await ts.getTreeSitterWorkerStats() === null, "terminated worker exposes no resources");

    // A re-registered provider must spawn a fresh worker and reload grammars.
    ts.registerHighlightProviders();
    const revived = monaco.editor.createModel("const again = 1;", "javascript");
    const revivedTokens = await ts.buildTokens(revived);
    check(revivedTokens?.data.length > 0 && ts.isTreeSitterWorkerRunning(), "respawned worker serves requests after teardown");
    const revivedStats = await ts.getTreeSitterWorkerStats();
    check(revivedStats?.inWorker === true && revivedStats.parses >= 1, "respawned worker parses in its own thread");
    revived.dispose();
    ts.disposeHighlightProviders();
    check(!ts.isTreeSitterWorkerRunning(), "second teardown terminates the respawned worker");
    getEditor().dispose();
    active.dispose();
    return {
      assertions: checks.length,
      grammars,
      resources,
      workerDiagnostics,
      clientDiagnostics,
      markdownLimitations: md.limitations,
      diagnostics,
    };
  });
  assert.deepEqual(errors, [], "No uncaught exceptions or console errors");
  console.log(JSON.stringify({ ...report, warnings }, null, 2));
  console.log("PASS: worker-backed tree-sitter, compatibility, ranges, Unicode, fallback, cancellation, lifecycle and dependency preview.");
} finally {
  await context.close();
  await browser.close();
}
