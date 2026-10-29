// Standalone browser regression for the phase-C tab strip component.
//
// It never boots main.ts: the page is a temporary HTML shell fulfilled by
// Playwright, and the component is loaded with a dynamic import directly from
// the Vite dev server. Run:
//   node scripts/regression-tabs-ui.mjs http://127.0.0.1:1420/
// When no dev server is listening the suite reports SKIP and exits 0, matching
// the "1420 if available" rule for the other browser regressions.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1420/";
const failures = [];
const pageErrors = [];

function checkCssPrefix() {
  const raw = readFileSync(new URL("../frontend/src/ui/tabs.css", import.meta.url), "utf8");
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const classes = [...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]);
  assert.ok(classes.length > 0, "tabs.css must contain scoped rules");
  const unscoped = [...new Set(classes.filter((name) => !name.startsWith("ce-tabs")))];
  assert.deepEqual(unscoped, [], `tabs.css has unprefixed classes: ${unscoped.join(", ")}`);
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(10000);
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const text = message.text();
  // Importing the component's CSS makes Vite load its HMR client. The test
  // shell is not served by Vite, so in sandboxed browsers the client's
  // websocket can be blocked; that noise is unrelated to the tab strip.
  if (/\[vite\]|WebSocket connection to|ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS/.test(text)) return;
  pageErrors.push(text);
});

// Probe the dev server before navigating. Playwright can fulfill the fake page
// even when Vite is down, so a connection error alone would be misleading.
let serverReady = false;
try {
  const response = await context.request.get(url, { timeout: 4000 });
  serverReady = response.ok();
} catch {
  serverReady = false;
}
if (!serverReady) {
  console.log(`SKIP regression-tabs-ui: dev server not available at ${url}`);
  await browser.close();
  process.exit(0);
}

async function test(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.stack || error}`);
  }
}

const items = [
  { id: "a", title: "alpha", dirty: false, path: "C:\\docs\\alpha.txt" },
  { id: "b", title: "beta", dirty: true, path: null },
  { id: "c", title: "gamma", dirty: false, path: "C:\\docs\\gamma.txt" },
];

const setTabs = (next, activeId) => page.evaluate(
  ([tabs, active]) => window.__tabs.setTabs(tabs, active),
  [next, activeId],
);

const resetCalls = () => page.evaluate(() => {
  const calls = window.__tabsCalls;
  calls.activate.length = 0;
  calls.close.length = 0;
  calls.reorder.length = 0;
  calls.newTab = 0;
});

const getCalls = () => page.evaluate(() => ({
  activate: [...window.__tabsCalls.activate],
  close: [...window.__tabsCalls.close],
  reorder: window.__tabsCalls.reorder.map((order) => [...order]),
  newTab: window.__tabsCalls.newTab,
}));

const getOrder = () => page.evaluate(() => window.__tabs.getOrder());

const tabState = () => page.evaluate(() => (
  [...document.querySelectorAll("#tabs-host [data-tab-id]")].map((element) => ({
    id: element.dataset.tabId,
    role: element.getAttribute("role"),
    selected: element.getAttribute("aria-selected"),
    tabIndex: element.tabIndex,
    active: element.dataset.active,
    dirty: element.dataset.dirty,
    ariaLabel: element.getAttribute("aria-label"),
    title: element.querySelector(".ce-tabs-title")?.textContent ?? null,
    closeLabel: element.querySelector(".ce-tabs-close")?.getAttribute("aria-label") ?? null,
  }))
));

try {
  await page.route("**/__tabs_regression__.html", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>tabs regression</title></head>"
      + "<body><div id=\"tabs-host\"></div></body></html>",
  }));
  const testUrl = new URL("__tabs_regression__.html", url).href;
  await page.goto(testUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  await page.evaluate(async () => {
    const module = await import("/src/ui/tabs.ts");
    const calls = { activate: [], close: [], reorder: [], newTab: 0 };
    window.__tabsCalls = calls;
    const host = document.createElement("div");
    host.id = "tabs-host";
    host.style.cssText = "width:420px;max-width:420px;margin:20px;";
    document.body.replaceChildren(host);
    window.__tabs = module.createTabs(host, {
      onActivate: (id) => calls.activate.push(id),
      onClose: (id) => calls.close.push(id),
      onReorder: (ids) => calls.reorder.push(ids),
      onNew: () => { calls.newTab += 1; },
    });
  });

  await test("tabs.css only uses the ce-tabs- prefix", checkCssPrefix);

  await test("renders tabs with tablist roles, active state, dirty dot and roving tabindex", async () => {
    await setTabs(items, "b");
    const state = await tabState();
    assert.equal(state.length, 3);
    assert.deepEqual(state.map((tab) => tab.id), ["a", "b", "c"]);
    assert.deepEqual(state.map((tab) => tab.role), ["tab", "tab", "tab"]);
    assert.deepEqual(state.map((tab) => tab.selected), ["false", "true", "false"]);
    assert.deepEqual(state.map((tab) => tab.active), ["false", "true", "false"]);
    assert.deepEqual(state.map((tab) => tab.tabIndex), [-1, 0, -1]);
    assert.equal(state[1].title, "beta");
    assert.equal(state[0].ariaLabel, "alpha");
    assert.equal(state[0].dirty, "false");
    assert.equal(state[1].dirty, "true");
    assert.match(state[1].closeLabel, /beta/);

    const list = page.locator("#tabs-host [role=tablist]");
    assert.equal(await list.count(), 1);
    assert.equal(await list.getAttribute("aria-orientation"), "horizontal");
    assert.equal(await page.locator("#tabs-host .ce-tabs").isVisible(), true);
    assert.equal(await page.locator("#tabs-host .ce-tabs-tab--active").count(), 1);
    assert.equal(await page.locator("#tabs-host [data-tab-id=\"a\"] .ce-tabs-dirty").isVisible(), false);
    assert.equal(await page.locator("#tabs-host [data-tab-id=\"b\"] .ce-tabs-dirty").isVisible(), true);
  });

  await test("click activates a tab and updates aria-selected plus roving tabindex", async () => {
    await setTabs(items, "b");
    await resetCalls();
    await page.locator("#tabs-host [data-tab-id=\"c\"]").click();
    const calls = await getCalls();
    assert.deepEqual(calls.activate, ["c"]);
    const state = await tabState();
    assert.deepEqual(state.map((tab) => tab.selected), ["false", "false", "true"]);
    assert.deepEqual(state.map((tab) => tab.tabIndex), [-1, -1, 0]);
  });

  await test("close button reports intent without removing the tab", async () => {
    await setTabs(items, "b");
    await resetCalls();
    await page.locator("#tabs-host [data-tab-id=\"b\"] .ce-tabs-close").click();
    const calls = await getCalls();
    assert.deepEqual(calls.close, ["b"]);
    assert.deepEqual(calls.activate, []);
    assert.equal((await tabState()).length, 3, "component must wait for the owner's setTabs");
  });

  await test("middle click on a tab closes it once", async () => {
    await setTabs(items, "b");
    await resetCalls();
    await page.locator("#tabs-host [data-tab-id=\"a\"]").click({ button: "middle" });
    await page.waitForFunction(() => window.__tabsCalls.close.length === 1);
    const calls = await getCalls();
    assert.deepEqual(calls.close, ["a"]);
    assert.equal((await tabState()).length, 3);
  });

  await test("keyboard Left/Right/Home/End switches, Delete closes, Enter activates", async () => {
    await setTabs(items, "a");
    await resetCalls();
    await page.locator("#tabs-host [data-tab-id=\"a\"]").focus();

    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.activeElement?.dataset.tabId === "b");
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.activeElement?.dataset.tabId === "c");
    await page.keyboard.press("Home");
    await page.waitForFunction(() => document.activeElement?.dataset.tabId === "a");
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => document.activeElement?.dataset.tabId === "c");

    let state = await tabState();
    assert.deepEqual(state.map((tab) => tab.selected), ["false", "false", "true"]);
    assert.deepEqual(state.filter((tab) => tab.tabIndex === 0).map((tab) => tab.id), ["c"]);
    let calls = await getCalls();
    assert.deepEqual(calls.activate, ["b", "c", "a", "c"]);

    await resetCalls();
    await page.keyboard.press("Delete");
    calls = await getCalls();
    assert.deepEqual(calls.close, ["c"]);
    assert.equal((await tabState()).length, 3);

    await setTabs(items, "a");
    await resetCalls();
    await page.evaluate(() => document.querySelector("#tabs-host [data-tab-id=\"b\"]").focus());
    await page.keyboard.press("Enter");
    calls = await getCalls();
    assert.deepEqual(calls.activate, ["b"]);
    state = await tabState();
    assert.deepEqual(state.map((tab) => tab.selected), ["false", "true", "false"]);
  });

  await test("drag reorders the strip and reports the complete new order", async () => {
    await setTabs(items, "a");
    await resetCalls();
    const from = await page.locator("#tabs-host [data-tab-id=\"a\"]").boundingBox();
    const to = await page.locator("#tabs-host [data-tab-id=\"c\"]").boundingBox();
    assert.ok(from && to);

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width - 6, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(() => window.__tabsCalls.reorder.length === 1);

    const calls = await getCalls();
    assert.deepEqual(calls.reorder[0], ["b", "c", "a"]);
    assert.deepEqual(calls.activate, [], "finishing a drag must not also activate the tab");
    assert.deepEqual(await getOrder(), ["b", "c", "a"]);
    const state = await tabState();
    assert.deepEqual(state.map((tab) => tab.id), ["b", "c", "a"]);
    assert.deepEqual(state.map((tab) => tab.selected), ["false", "false", "true"]);
  });

  await test("long titles truncate with an ellipsis instead of widening the strip", async () => {
    const longTitle = "A very long document title that must be truncated ".repeat(8);
    await setTabs([{ id: "long", title: longTitle, dirty: false, path: null }], "long");
    const metrics = await page.evaluate(() => {
      const title = document.querySelector("#tabs-host .ce-tabs-title");
      const style = getComputedStyle(title);
      return {
        clientWidth: title.clientWidth,
        scrollWidth: title.scrollWidth,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
        hostWidth: document.getElementById("tabs-host").getBoundingClientRect().width,
      };
    });
    assert.ok(metrics.scrollWidth > metrics.clientWidth, "title should overflow its clipped box");
    assert.equal(metrics.textOverflow, "ellipsis");
    assert.equal(metrics.whiteSpace, "nowrap");
    assert.ok(metrics.hostWidth <= 421);
  });

  await test("many tabs scroll horizontally without squeezing the host width", async () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      id: `t${index}`,
      title: `Document ${index} ${"with a long descriptive name ".repeat(3)}`,
      dirty: index % 2 === 0,
      path: `C:\\docs\\doc-${index}.txt`,
    }));
    await setTabs(many, "t0");
    const metrics = await page.evaluate(() => {
      const host = document.getElementById("tabs-host");
      const root = host.querySelector(".ce-tabs");
      const scroller = host.querySelector(".ce-tabs-scroller");
      return {
        hostWidth: host.getBoundingClientRect().width,
        rootWidth: root.getBoundingClientRect().width,
        clientWidth: scroller.clientWidth,
        scrollWidth: scroller.scrollWidth,
        overflowX: getComputedStyle(scroller).overflowX,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    assert.ok(metrics.scrollWidth > metrics.clientWidth + 200, "tabs must overflow the scroller");
    assert.equal(metrics.overflowX, "auto");
    assert.ok(metrics.rootWidth <= metrics.hostWidth + 0.5, "strip must not grow past its host");
    assert.ok(metrics.hostWidth <= 421, "host width must stay constrained");
    assert.ok(metrics.documentWidth <= metrics.viewportWidth, "page must not scroll horizontally");

    await page.evaluate(() => window.__tabs.setActive("t19"));
    await page.waitForFunction(() => document.querySelector("#tabs-host .ce-tabs-scroller").scrollLeft > 0);
    const visible = await page.evaluate(() => {
      const tab = document.querySelector("#tabs-host [data-tab-id=\"t19\"]");
      const bar = document.querySelector("#tabs-host .ce-tabs-scroller");
      const tabRect = tab.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      return {
        scrollLeft: bar.scrollLeft,
        tabIndex: tab.tabIndex,
        selected: tab.getAttribute("aria-selected"),
        inside: tabRect.left >= barRect.left - 1 && tabRect.right <= barRect.right + 1,
      };
    });
    assert.ok(visible.scrollLeft > 0, "active tab should be scrolled into view");
    assert.equal(visible.tabIndex, 0);
    assert.equal(visible.selected, "true");
    assert.equal(visible.inside, true);
  });

  await test("empty list hides the strip; a later setTabs restores it", async () => {
    await setTabs([], null);
    assert.equal((await tabState()).length, 0);
    assert.deepEqual(await getOrder(), []);
    assert.equal(await page.locator("#tabs-host .ce-tabs").isVisible(), false);
    assert.equal(await page.evaluate(() => document.querySelector("#tabs-host .ce-tabs").hidden), true);

    await setTabs([items[0]], "a");
    assert.equal((await tabState()).length, 1);
    assert.equal(await page.locator("#tabs-host .ce-tabs").isVisible(), true);
  });

  await test("updateTab patches title and dirty state without rebuilding or reordering", async () => {
    await setTabs([items[0], items[1]], "a");
    await resetCalls();
    await page.evaluate(() => {
      window.__tabs.updateTab({ id: "b", title: "beta renamed", dirty: false, path: "C:\\docs\\beta.txt" });
    });
    const state = await tabState();
    assert.deepEqual(state.map((tab) => tab.id), ["a", "b"]);
    assert.deepEqual(state.map((tab) => tab.selected), ["true", "false"]);
    assert.equal(state[1].title, "beta renamed");
    assert.equal(state[1].dirty, "false");
    assert.equal(state[1].ariaLabel, "beta renamed");
    assert.ok(state[1].closeLabel.includes("beta renamed"));
    assert.equal(await page.locator("#tabs-host [data-tab-id=\"b\"]").getAttribute("title").then((value) => value.includes("beta.txt")), true);
    assert.deepEqual(await getCalls(), { activate: [], close: [], reorder: [], newTab: 0 });
  });

  await test("optional new-tab button invokes onNew", async () => {
    await setTabs([items[0]], "a");
    await resetCalls();
    await page.locator("#tabs-host .ce-tabs-new").click();
    assert.equal((await getCalls()).newTab, 1);
  });

  await test("destroy removes the strip and all listeners", async () => {
    await setTabs(items, "a");
    await page.evaluate(() => window.__tabs.destroy());
    assert.equal(await page.locator("#tabs-host .ce-tabs").count(), 0);
    assert.deepEqual(await getOrder(), []);
    assert.equal(await page.evaluate(() => document.getElementById("tabs-host").childElementCount), 0);
  });

  await test("no unexpected page errors", () => {
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
  });
} catch (error) {
  failures.push("suite crashed");
  console.error(`FAIL suite crashed: ${error.stack || error}`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\nregression-tabs-ui: ${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nregression-tabs-ui: all checks passed");
