// Independent find-results list regressions (PLAN §阶段D).
// Run against the Vite dev server:
//   node scripts/regression-find-results.mjs http://127.0.0.1:1420/
//
// Uses a temporary host element plus the real Monaco model/editor created by
// main.ts, so the module is exercised through the same wiring the app uses.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1420/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const failures = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

const HOST = "#find-results-test-host";
const ROOT = `${HOST} .ce-find-results`;
const ITEM = `${HOST} .ce-find-results-item`;
const COUNT = `${HOST} .ce-find-results-count`;
const STATUS = `${HOST} .ce-find-results-status`;
const LINE = `${HOST} .ce-find-results-line`;
const CONTEXT = `${HOST} .ce-find-results-context`;

async function test(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.stack || error}`);
    await page.keyboard.press("Escape").catch(() => {});
  }
}

async function bindModules() {
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#menubar > .ce-menu-item").length > 0 &&
      !!document.querySelector("#editor .monaco-editor"),
  );
  await page.evaluate(async () => {
    // Bind to the exact URL main.ts loaded, otherwise the dynamic import gets a
    // second monaco-setup instance with no editor.
    const pick = (suffix) =>
      [
        ...new Set(performance.getEntriesByType("resource").map((entry) => entry.name)),
      ]
        .filter((name) => name.includes(suffix))
        .pop() ?? suffix;
    const setup = await import(pick("/src/editor/monaco-setup.ts"));
    const results = await import("/src/ui/find-results.ts");
    window.__frTest = { setup, results };
  });
}

async function installHarness() {
  await page.evaluate(() => {
    const { setup, results } = window.__frTest;
    document.getElementById("find-results-test-host")?.remove();
    const host = document.createElement("div");
    host.id = "find-results-test-host";
    host.style.cssText =
      "position:fixed;right:16px;top:56px;width:430px;max-height:72vh;z-index:10000;";
    document.body.appendChild(host);

    const state = { nav: [], replaces: [] };
    const controller = results.createFindResults(host, {
      onNavigate: (range) => {
        state.nav.push({
          startLineNumber: range.startLineNumber,
          startColumn: range.startColumn,
          endLineNumber: range.endLineNumber,
          endColumn: range.endColumn,
        });
        const editor = setup.getEditor();
        if (editor) {
          const range2 = new setup.monaco.Range(
            range.startLineNumber,
            range.startColumn,
            range.endLineNumber,
            range.endColumn,
          );
          editor.setSelection(range2);
          editor.revealRangeInCenterIfOutsideViewport(range2);
        }
      },
      onReplace: (range, replacement) => {
        state.replaces.push({ line: range.startLineNumber, replacement });
      },
    });

    window.__frHarness = {
      host,
      controller,
      state,
      model: setup.getModel(),
      editor: setup.getEditor(),
      monaco: setup.monaco,
      max: results.MAX_FIND_RESULTS,
    };
  });
}

async function reset(text) {
  await page.evaluate((value) => {
    const harness = window.__frHarness;
    harness.controller.clear();
    harness.state.nav.length = 0;
    harness.state.replaces.length = 0;
    harness.model.setValue(value);
    harness.editor.setSelection(new harness.monaco.Selection(1, 1, 1, 1));
  }, text);
}

async function search(query, overrides = {}) {
  const options = {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    ...overrides,
  };
  return page.evaluate(
    async ({ query, options }) => {
      const harness = window.__frHarness;
      const summary = await harness.controller.search(harness.model, query, options).done;
      return {
        cancelled: summary.cancelled,
        stale: summary.stale,
        error: summary.error,
        truncated: summary.truncated,
        versionId: summary.versionId,
        matches: summary.matches.map((match) => ({
          line: match.line,
          column: match.column,
          endColumn: match.range.endColumn,
          text: match.matchText,
          lineText: match.lineText,
        })),
      };
    },
    { query, options },
  );
}

const items = () => page.locator(ITEM);
const lines = () => page.locator(LINE);
const contexts = () => page.locator(CONTEXT);
const status = () => page.locator(STATUS);

async function modelValue() {
  return page.evaluate(() => window.__frHarness.model.getValue());
}

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await bindModules();
  await installHarness();

  await test("main wiring: Ctrl+Shift+F renders into the real #find-results host", async () => {
    await page.evaluate(() => {
      const { setup } = window.__frTest;
      const editor = setup.getEditor();
      editor.getModel().setValue("one foo\ntwo foo");
      editor.setSelection(new setup.monaco.Selection(1, 5, 1, 8));
      editor.focus();
    });
    await page.keyboard.press("Control+Shift+F");
    await page.waitForFunction(() =>
      document.querySelectorAll("#find-results .ce-find-results-item").length === 2);
    assert.deepEqual(
      await page.locator("#find-results .ce-find-results-line").allTextContents(),
      ["1", "2"],
    );
    assert.deepEqual(
      await page.evaluate(() => window.__coteditor.findResults()),
      { open: true, count: 2 },
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() =>
      document.querySelector("#find-results .ce-find-results")?.hidden === true);
  });

  await test("literal search: matches, 1-based line/column, context, count", async () => {
    await reset("alpha foo beta\nsecond line\nfoo again foo");
    const summary = await search("foo");
    assert.equal(summary.error, null);
    assert.equal(summary.cancelled, false);
    assert.equal(summary.stale, false);
    assert.equal(summary.truncated, false);
    assert.equal(summary.matches.length, 3);
    assert.deepEqual(summary.matches.map((match) => match.line), [1, 3, 3]);
    assert.deepEqual(summary.matches.map((match) => match.column), [7, 1, 11]);
    assert.deepEqual(summary.matches.map((match) => match.text), ["foo", "foo", "foo"]);
    assert.deepEqual(summary.matches.map((match) => match.lineText), [
      "alpha foo beta",
      "foo again foo",
      "foo again foo",
    ]);

    assert.equal(await items().count(), 3);
    assert.deepEqual(await lines().allTextContents(), ["1", "3", "3"]);
    const contextTexts = await contexts().allTextContents();
    assert.match(contextTexts[0], /alpha foo beta/);
    assert.match(contextTexts[1], /foo again foo/);
    assert.equal(await status().isHidden(), true);
    assert.match(await page.locator(COUNT).textContent(), /3/);
    assert.equal(await page.locator(`${ROOT} mark`).count(), 3);

    const styles = await page.evaluate(() => {
      const root = document.querySelector("#find-results-test-host .ce-find-results");
      const mark = document.querySelector("#find-results-test-host .ce-find-results-match");
      return {
        display: getComputedStyle(root).display,
        markBackground: getComputedStyle(mark).backgroundColor,
      };
    });
    assert.equal(styles.display, "flex", "find-results.css is imported by the module");
    assert.notEqual(styles.markBackground, "rgba(0, 0, 0, 0)");
  });

  await test("no-results state is visible and list is empty", async () => {
    const summary = await search("absent");
    assert.equal(summary.error, null);
    assert.equal(summary.matches.length, 0);
    assert.equal(await items().count(), 0);
    assert.equal(await status().getAttribute("data-kind"), "empty");
    assert.equal(await status().isVisible(), true);
    assert.match(await status().textContent(), /No results|无结果/);
  });

  await test("case sensitivity option changes the match set", async () => {
    await reset("Foo foo FOO");
    const sensitive = await search("Foo", { caseSensitive: true });
    assert.equal(sensitive.matches.length, 1);
    assert.equal(sensitive.matches[0].column, 1);
    assert.equal(await items().count(), 1);

    const insensitive = await search("Foo", { caseSensitive: false });
    assert.equal(insensitive.matches.length, 3);
    assert.deepEqual(insensitive.matches.map((match) => match.column), [1, 5, 9]);
  });

  await test("whole-word option ignores substrings", async () => {
    await reset("cat concatenate cat\nscatter");
    const whole = await search("cat", { wholeWord: true });
    assert.equal(whole.matches.length, 2);
    assert.deepEqual(whole.matches.map((match) => match.line), [1, 1]);
    assert.deepEqual(whole.matches.map((match) => match.column), [1, 17]);

    const partial = await search("cat", { wholeWord: false });
    assert.equal(partial.matches.length, 4);
    assert.deepEqual(partial.matches.map((match) => match.column), [1, 8, 17, 2]);
  });

  await test("regex option matches groups; invalid regex reports an error", async () => {
    await reset("id=1 id=22\nid=abc");
    const regex = await search("id=(\\d+)", { regex: true, caseSensitive: true });
    assert.equal(regex.error, null);
    assert.equal(regex.matches.length, 2);
    assert.deepEqual(regex.matches.map((match) => match.text), ["id=1", "id=22"]);
    assert.deepEqual(regex.matches.map((match) => match.column), [1, 6]);

    const before = await modelValue();
    const invalid = await search("(", { regex: true });
    assert.equal(typeof invalid.error, "string");
    assert.ok(invalid.error.length > 0);
    assert.equal(invalid.matches.length, 0);
    assert.equal(await items().count(), 0);
    assert.equal(await status().getAttribute("data-kind"), "error");
    assert.equal(await status().isVisible(), true);
    assert.match(await status().textContent(), /Invalid regular expression|正则表达式无效/);
    assert.equal(await modelValue(), before, "invalid search must not touch the document");

    const recovered = await search("id=abc", { regex: true });
    assert.equal(recovered.error, null);
    assert.equal(recovered.matches.length, 1);
    assert.equal(await items().count(), 1);
  });

  await test("click and Enter navigate, arrows move focus, Escape clears", async () => {
    await reset("one foo\ntwo foo\nthree foo");
    const summary = await search("foo");
    assert.equal(summary.matches.length, 3);

    await items().nth(1).click();
    let nav = await page.evaluate(() => window.__frHarness.state.nav);
    assert.equal(nav.length, 1);
    assert.equal(nav[0].startLineNumber, 2);
    assert.deepEqual(nav[0], {
      startLineNumber: 2,
      startColumn: 5,
      endLineNumber: 2,
      endColumn: 8,
    });
    assert.equal(
      await page.evaluate(
        () => window.__frHarness.editor.getSelection().startLineNumber,
      ),
      2,
      "onNavigate applied the editor selection",
    );

    await items().first().focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.index), "1");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.index), "2");
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.index), "1");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    nav = await page.evaluate(() => window.__frHarness.state.nav);
    assert.equal(nav.length, 2);
    assert.equal(nav[1].startLineNumber, 3);
    assert.equal(
      await page.evaluate(
        () => window.__frHarness.editor.getSelection().startLineNumber,
      ),
      3,
    );

    const before = await modelValue();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(ROOT).isHidden(), true);
    assert.equal(await items().count(), 0);
    assert.equal(await modelValue(), before, "navigation and Escape never edit text");
  });

  await test("cancel discards partial results and a newer search wins", async () => {
    const big = Array.from({ length: 20000 }, (_, index) => `line ${index} foo bar`).join("\n");
    await reset(big);
    const before = await modelValue();
    const cancelled = await page.evaluate(async () => {
      const harness = window.__frHarness;
      const handle = harness.controller.search(harness.model, "foo", {
        caseSensitive: false,
        wholeWord: false,
        regex: false,
      });
      handle.cancel();
      const summary = await handle.done;
      return {
        cancelled: summary.cancelled,
        stale: summary.stale,
        count: summary.matches.length,
      };
    });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.stale, false);
    assert.equal(cancelled.count, 0);
    assert.equal(await items().count(), 0);
    assert.equal(await modelValue(), before);

    await reset("foo bar\nfoo bar");
    const overlap = await page.evaluate(async () => {
      const harness = window.__frHarness;
      const options = { caseSensitive: false, wholeWord: false, regex: false };
      const first = harness.controller.search(harness.model, "foo", options);
      const second = harness.controller.search(harness.model, "bar", options);
      const [firstSummary, secondSummary] = await Promise.all([first.done, second.done]);
      return {
        firstCancelled: firstSummary.cancelled,
        secondCount: secondSummary.matches.length,
        rendered: [...document.querySelectorAll("#find-results-test-host .ce-find-results-context")]
          .map((element) => element.textContent),
        marks: [...document.querySelectorAll("#find-results-test-host .ce-find-results-match")]
          .map((element) => element.textContent),
      };
    });
    assert.equal(overlap.firstCancelled, true);
    assert.equal(overlap.secondCount, 2);
    assert.equal(overlap.rendered.length, 2, "only the winning search renders");
    assert.deepEqual(overlap.rendered, ["foo bar", "foo bar"]);
    assert.deepEqual(overlap.marks, ["bar", "bar"], "stale foo results were discarded");
  });

  await test("document change discards in-flight results (version guard)", async () => {
    await reset("foo\nfoo\nbar");
    const result = await page.evaluate(async () => {
      const harness = window.__frHarness;
      const before = harness.model.getValue();
      const handle = harness.controller.search(harness.model, "foo", {
        caseSensitive: false,
        wholeWord: false,
        regex: false,
      });
      harness.model.setValue(before + "\nfoo");
      const summary = await handle.done;
      return {
        cancelled: summary.cancelled,
        stale: summary.stale,
        count: summary.matches.length,
        error: summary.error,
        value: harness.model.getValue(),
      };
    });
    assert.equal(result.cancelled, false);
    assert.equal(result.stale, true);
    assert.equal(result.count, 0);
    assert.equal(result.error, null);
    assert.equal(await items().count(), 0);
    assert.equal(await status().getAttribute("data-kind"), "stale");
    assert.equal(result.value, "foo\nfoo\nbar\nfoo");
  });

  await test("large result sets truncate at 2000 and say so", async () => {
    const max = await page.evaluate(() => window.__frHarness.max);
    assert.equal(max, 2000);
    const many = Array.from({ length: 2200 }, (_, index) => `needle ${index}`).join("\n");
    await reset(many);
    const summary = await search("needle");
    assert.equal(summary.truncated, true);
    assert.equal(summary.matches.length, max);
    assert.equal(await items().count(), max);
    assert.equal(await status().getAttribute("data-kind"), "truncated");
    assert.match(await status().textContent(), /2000|first/);
    assert.match(await page.locator(COUNT).textContent(), /2000\+/);
    assert.equal(await modelValue(), many);
  });

  await test("includeSelection restricts matches to the editor selection", async () => {
    await reset("foo\nfoo\nfoo");
    await page.evaluate(() => {
      const harness = window.__frHarness;
      harness.editor.setSelection(new harness.monaco.Selection(2, 1, 2, 4));
    });
    const summary = await search("foo", { includeSelection: true });
    assert.equal(summary.matches.length, 1);
    assert.equal(summary.matches[0].line, 2);
    assert.equal(await items().count(), 1);
  });

  await test("replaceAll only calls back; the model text is untouched", async () => {
    await reset("x x\nx");
    const summary = await search("x");
    assert.equal(summary.matches.length, 3);
    const before = await modelValue();
    const replaced = await page.evaluate(() =>
      window.__frHarness.controller.replaceAll("y"),
    );
    assert.equal(replaced, 3);
    assert.equal(await modelValue(), before);
    const calls = await page.evaluate(() => window.__frHarness.state.replaces);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.replacement === "y"));
    assert.deepEqual(calls.map((call) => call.line).sort(), [1, 1, 2]);
  });

  await test("destroy removes only the list root", async () => {
    await reset("foo");
    await search("foo");
    assert.equal(await page.locator(ROOT).count(), 1);
    const hostStillThere = await page.evaluate(() => {
      const harness = window.__frHarness;
      harness.controller.destroy();
      return {
        roots: harness.host.querySelectorAll(".ce-find-results").length,
        hostInDocument: document.body.contains(harness.host),
      };
    });
    assert.equal(hostStillThere.roots, 0);
    assert.equal(hostStillThere.hostInDocument, true);
  });

  await test("no unhandled runtime errors", async () => {
    assert.deepEqual(errors, []);
  });
} catch (error) {
  failures.push("suite setup");
  console.error(error.stack || error);
  if (errors.length) console.error("Runtime errors:", errors);
} finally {
  await browser.close();
}

console.log(
  failures.length
    ? `FAIL (${failures.length}): ${failures.join("; ")}`
    : "ALL FIND-RESULTS REGRESSIONS PASS",
);
process.exitCode = failures.length ? 1 : 0;
