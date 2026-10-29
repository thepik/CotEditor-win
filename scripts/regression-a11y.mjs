// Accessibility + DPI/zoom layout regressions.
// Run against the Vite dev server:
//   node scripts/regression-a11y.mjs http://127.0.0.1:1420/
//
// Covers landmark/region roles and labels, screen-reader live regions for
// save/read-only/find-result counts, visible keyboard focus, the File ▸ Open
// with Encoding submenu, and a 640 CSS-pixel viewport (the layout equivalent of
// 200% zoom on a 1280px window) with deviceScaleFactor 2. Native WebView2 IME
// and real Windows DPI changes still need manual acceptance.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1420/";
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 820 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
page.setDefaultTimeout(15000);

const failures = [];
const errors = [];
page.on("pageerror", (error) => {
  if (error.message === "Canceled") return;
  errors.push(error.message);
});
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

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

async function bindEditor() {
  await page.waitForFunction(() =>
    document.querySelectorAll("#menubar > .ce-menu-item").length > 0
    && !!document.querySelector("#editor .monaco-editor"));
  await page.evaluate(async () => {
    const pick = (suffix) =>
      [
        ...new Set(performance.getEntriesByType("resource").map((entry) => entry.name)),
      ]
        .filter((name) => name.includes(suffix))
        .pop() ?? suffix;
    window.__a11y = await import(pick("/src/editor/monaco-setup.ts"));
  });
}

async function setDocument(text) {
  await page.evaluate((value) => {
    const { getEditor, monaco } = window.__a11y;
    const editor = getEditor();
    editor.getModel().setValue(value);
    editor.setSelection(new monaco.Selection(1, 1, 1, 1));
    editor.focus();
  }, text);
}

async function selectWord(line, column, length) {
  await page.evaluate(({ line, column, length }) => {
    const { getEditor, monaco } = window.__a11y;
    const editor = getEditor();
    editor.setSelection(new monaco.Selection(line, column, line, column + length));
    editor.focus();
  }, { line, column, length });
}

async function overflowReport() {
  return page.evaluate(() => {
    const app = document.getElementById("app");
    const toolbar = document.getElementById("toolbar");
    const statusbar = document.getElementById("statusbar");
    const rect = (node) => node.getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      bodyOverflow: document.body.scrollWidth - window.innerWidth,
      appOverflow: app.scrollWidth - app.clientWidth,
      toolbarRight: rect(toolbar).right,
      statusbarRight: rect(statusbar).right,
    };
  });
}

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await bindEditor();

  await test("landmarks and regions expose localized names", async () => {
    const roles = await page.evaluate(() => {
      const read = (selector) => {
        const node = document.querySelector(selector);
        return node
          ? { role: node.getAttribute("role"), label: node.getAttribute("aria-label") }
          : null;
      };
      return {
        lang: document.documentElement.lang,
        menubar: read("#menubar"),
        toolbar: read("#toolbar"),
        workspace: read("#workspace"),
        editor: read("#editor"),
        findResults: read("#find-results"),
        statusbar: read("#statusbar"),
        outline: read("#outline"),
      };
    });
    assert.match(roles.lang, /^(zh-CN|en)$/);
    assert.equal(roles.menubar.role, "menubar");
    assert.ok(roles.menubar.label);
    assert.equal(roles.toolbar.role, "toolbar");
    assert.ok(roles.toolbar.label);
    assert.equal(roles.workspace.role, "main");
    assert.ok(roles.workspace.label);
    assert.equal(roles.editor.role, "region");
    assert.ok(roles.editor.label);
    assert.ok(roles.findResults.label);
    assert.ok(roles.statusbar.label);
    assert.ok(roles.outline.label);
  });

  await test("toolbar controls have accessible names and pressed state", async () => {
    const buttons = await page.$$eval("#toolbar .toolbar-button", (nodes) =>
      nodes.map((node) => ({
        label: node.getAttribute("aria-label"),
        title: node.getAttribute("title"),
      })));
    assert.ok(buttons.length >= 4);
    for (const button of buttons) {
      assert.ok(button.label && button.label.length > 0, `missing aria-label: ${button.title}`);
    }
    assert.ok(await page.locator("#toolbar select[aria-label]").count() >= 1);
  });

  await test("keyboard focus is visible on the menu bar", async () => {
    await page.keyboard.press("F10");
    await page.waitForFunction(() =>
      document.activeElement?.matches("#menubar > .ce-menu-item"));
    const style = await page.evaluate(() => {
      const node = document.activeElement;
      const computed = getComputedStyle(node);
      return {
        outlineStyle: computed.outlineStyle,
        outlineWidth: parseFloat(computed.outlineWidth),
      };
    });
    assert.notEqual(style.outlineStyle, "none");
    assert.ok(style.outlineWidth >= 1, `focus outline width ${style.outlineWidth}`);
    await page.keyboard.press("Escape");
  });

  await test("File ▸ Open with Encoding submenu is keyboard reachable", async () => {
    await page.locator("#menubar > .ce-menu-item").filter({ hasText: /^(文件|File)$/ }).click();
    const parent = page.locator(".ce-menu-dropdown button[aria-haspopup='menu']");
    assert.equal(await parent.count(), 1);
    assert.match(await parent.textContent(), /以编码打开|Open with Encoding/);
    await parent.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForSelector(".ce-submenu");
    assert.equal(
      await page.evaluate(() => !!document.activeElement?.closest(".ce-submenu")),
      true,
      "focus moved into the submenu",
    );
    const labels = await page.$$eval(".ce-submenu button", (nodes) =>
      nodes.map((node) => node.textContent.trim()));
    assert.deepEqual(labels, ["UTF-8", "UTF-8 BOM", "UTF-16LE", "UTF-16BE", "GB18030"]);
    await page.keyboard.press("ArrowDown");
    assert.match(
      await page.evaluate(() => document.activeElement?.textContent ?? ""),
      /UTF-8 BOM/,
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".ce-submenu").count(), 0);
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-haspopup")),
      "menu",
      "Escape returns focus to the parent item",
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".ce-menu-dropdown").count(), 0);
  });

  await test("save, read-only and result-count state are live regions", async () => {
    const live = await page.evaluate(() => {
      const save = document.querySelector(".sb-save");
      const readonly = document.querySelector('[data-stat="readonly"]');
      return {
        saveRole: save?.getAttribute("role"),
        saveLive: save?.getAttribute("aria-live"),
        readOnlyRole: readonly?.getAttribute("role"),
        readOnlyLive: readonly?.getAttribute("aria-live"),
      };
    });
    assert.equal(live.saveRole, "status");
    assert.equal(live.saveLive, "polite");
    assert.equal(live.readOnlyRole, "status");
    assert.equal(live.readOnlyLive, "polite");

    await setDocument("needle one\nneedle two");
    await selectWord(1, 1, 6);
    await page.keyboard.press("Control+Shift+F");
    await page.waitForFunction(() =>
      document.querySelectorAll("#find-results .ce-find-results-item").length === 2);
    const count = await page.evaluate(() => {
      const node = document.querySelector("#find-results .ce-find-results-count");
      return {
        text: node?.textContent ?? "",
        role: node?.getAttribute("role"),
        live: node?.getAttribute("aria-live"),
        busy: node?.closest(".ce-find-results")?.getAttribute("aria-busy"),
      };
    });
    assert.match(count.text, /2/);
    assert.equal(count.role, "status");
    assert.equal(count.live, "polite");
    assert.equal(count.busy, "false");
    await page.keyboard.press("Escape");
  });

  await test("640px viewport / 200% zoom proxy: no horizontal overflow", async () => {
    await page.setViewportSize({ width: 640, height: 820 });
    await page.waitForFunction(() => window.innerWidth === 640);
    // Monaco relayouts asynchronously; wait until the overflow guards settle
    // rather than sampling a transient pre-layout frame.
    await page.waitForFunction(() => {
      const app = document.getElementById("app");
      return document.documentElement.scrollWidth <= window.innerWidth + 1
        && document.body.scrollWidth <= window.innerWidth + 1
        && app.scrollWidth <= app.clientWidth + 1;
    });
    const report = await overflowReport();
    assert.ok(report.documentOverflow <= 1, `document overflow ${report.documentOverflow}`);
    assert.ok(report.bodyOverflow <= 1, `body overflow ${report.bodyOverflow}`);
    assert.ok(report.appOverflow <= 1, `app overflow ${report.appOverflow}`);
    assert.ok(report.toolbarRight <= report.viewport + 1, `toolbar ${report.toolbarRight}`);
    assert.ok(report.statusbarRight <= report.viewport + 1, `statusbar ${report.statusbarRight}`);

    // The results overlay stays inside the window at this width.
    await setDocument("needle one needle two\nneedle three");
    await selectWord(1, 1, 6);
    await page.keyboard.press("Control+Shift+F");
    await page.waitForFunction(() =>
      document.querySelectorAll("#find-results .ce-find-results-item").length === 3);
    const box = await page.evaluate(() => {
      const node = document.querySelector("#find-results .ce-find-results");
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    assert.ok(box.left >= 0 && box.right <= 640 + 1, `results box ${JSON.stringify(box)}`);
    assert.ok(box.top >= 0 && box.bottom <= 820 + 1, `results vertical ${JSON.stringify(box)}`);
    await page.keyboard.press("Escape");
  });

  await test("split preview + outline stay inside 640px without overflow", async () => {
    await setDocument("# Heading\n\nsome markdown body that wraps\n\n## Second\n");
    await page.locator("#toolbar select").first().selectOption("Markdown");
    await page.keyboard.press("Control+Shift+E");
    await page.waitForFunction(() =>
      document.getElementById("editor")?.getAttribute("data-ce-preview-mode") === "split");
    await page.keyboard.press("Control+Shift+O");
    await page.waitForFunction(() => document.getElementById("outline")?.hidden === false);
    await page.waitForFunction(() => {
      const app = document.getElementById("app");
      return app.scrollWidth <= app.clientWidth + 1;
    });
    const report = await overflowReport();
    assert.ok(report.appOverflow <= 1, `app overflow ${report.appOverflow}`);
    assert.ok(report.documentOverflow <= 1, `document overflow ${report.documentOverflow}`);
    const panes = await page.evaluate(() => {
      const editor = document.querySelector("#editor > .monaco-editor").getBoundingClientRect();
      const preview = document.getElementById("preview").getBoundingClientRect();
      const outline = document.getElementById("outline").getBoundingClientRect();
      return {
        editor: { left: editor.left, right: editor.right, width: editor.width },
        preview: { left: preview.left, right: preview.right, width: preview.width },
        outline: { left: outline.left, right: outline.right, width: outline.width },
      };
    });
    assert.ok(panes.editor.width > 200 && panes.preview.width > 200,
      `panes ${JSON.stringify(panes)}`);
    assert.ok(panes.outline.width >= 150, `outline ${JSON.stringify(panes.outline)}`);
    assert.ok(panes.preview.right <= 640 + 1 && panes.outline.right <= 640 + 1,
      `right edges ${JSON.stringify(panes)}`);

    await page.keyboard.press("Control+Shift+O");
    await page.waitForFunction(() => document.getElementById("outline")?.hidden === true);
    await page.keyboard.press("Control+Shift+E");
    await page.waitForFunction(() =>
      (document.getElementById("editor")?.getAttribute("data-ce-preview-mode") ?? "off") === "off");
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
    : "ALL A11Y/DPI REGRESSIONS PASS",
);
process.exitCode = failures.length ? 1 : 0;
