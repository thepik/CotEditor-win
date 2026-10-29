// Main-pipeline regressions for preview resources/links, split layout and the
// outline wired by main.ts. Run against the Vite dev server:
//   node scripts/regression-preview-main.mjs http://127.0.0.1:1420/
//
// The Wails bindings are mocked before any module evaluates, so main.ts takes
// its native path: startup file -> OpenPath, preview images -> ReadAssetBase64,
// relative links -> OpenPath. No real disk file is read or written.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1420/";
const NOTE_PATH = "C:\\work\\note.md";
const OTHER_MD_PATH = "C:\\work\\notes\\other.md";
const OTHER_TXT_PATH = "C:\\work\\notes\\other.txt";
const PIXEL = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const PIXEL_URI = `data:image/gif;base64,${PIXEL}`;
const ASSET_LIMIT = 10 * 1024 * 1024;

// Paragraphs need blank separator lines, otherwise Markdown collapses them
// into one block and the anchor target never scrolls.
const filler = Array.from({ length: 30 }, (_, index) => [`filler line ${index}`, ""]).flat();
const NOTE_MARKDOWN = [
  "# Alpha",
  "",
  "![pic](images/pic.png)",
  "![big](images/big.png)",
  "![remote](https://example.com/remote.png)",
  "",
  "[other](notes/other.md)",
  "[text](notes/other.txt)",
  "[jump](#target)",
  "[ext](https://example.com/page)",
  "",
  "## Beta",
  "",
  ...filler,
  "",
  "## Target",
  "",
].join("\n");
const OTHER_MD = "# Other\n\nother body\n";
const OTHER_TXT = "plain text body\n";

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);

const failures = [];
const pageErrors = [];
const consoleErrors = [];
const ignoreConsole = (text) =>
  /reading 'toUrl'/.test(text) || /reading 'nodes'/.test(text);
page.on("pageerror", (error) => {
  if (error.message === "Canceled") return;
  pageErrors.push(error.message);
});
page.on("console", (message) => {
  if (message.type() === "error" && !ignoreConsole(message.text())) {
    consoleErrors.push(message.text());
  }
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

async function bootstrapMock() {
  await page.addInitScript(({ paths, markdowns }) => {
    window.__assetCalls = [];
    window.__openPathCalls = [];
    window.__externalCalls = [];
    window.__themeCalls = [];

    const contentFor = (path) => {
      const body = markdowns[path];
      return {
        path,
        content: body,
        encoding: "UTF-8",
        line_ending: "lf",
        mixed_line_ending: false,
      };
    };

    window.go = {
      main: {
        App: {
          StartupFile: async () => paths.note,
          NewFile: async () => ({
            path: "",
            content: "",
            encoding: "UTF-8",
            line_ending: "lf",
            mixed_line_ending: false,
          }),
          OpenPath: async (path) => {
            window.__openPathCalls.push(path);
            if (!(path in markdowns)) throw new Error(`ENOENT: ${path}`);
            return contentFor(path);
          },
          OpenPathWithEncoding: async (path) => {
            if (!(path in markdowns)) throw new Error(`ENOENT: ${path}`);
            return contentFor(path);
          },
          FileStamp: async () => ({ exists: true, size: 1, mod_time: 1 }),
          SetSessionDirty: async () => {},
          SetDocumentState: async () => {},
          ReadAssetBase64: async (path) => {
            window.__assetCalls.push(path);
            if (path.endsWith("big.png")) {
              return { path, mime: "image/png", data: "AAAA", size: 10 * 1024 * 1024 + 1 };
            }
            if (path.endsWith("pic.png")) {
              return { path, mime: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", size: 68 };
            }
            throw new Error(`ASSET_READ_FAILED: ${path}`);
          },
          SaveFileChecked: async (path) => path,
          SaveAsChecked: async () => "C:\\work\\saved.md",
          SaveFileWithEncoding: async (path) => path,
          SaveAsWithEncoding: async () => "C:\\work\\saved.md",
        },
      },
    };
    window.runtime = {
      EventsOn: () => () => {},
      EventsOnMultiple: () => () => {},
      EventsOff: () => {},
      EventsOffAll: () => {},
      WindowSetTitle: (title) => window.__themeCalls.push(`title:${title}`),
      WindowSetLightTheme: () => window.__themeCalls.push("light"),
      WindowSetDarkTheme: () => window.__themeCalls.push("dark"),
      BrowserOpenURL: (href) => window.__externalCalls.push(href),
      Quit: () => {},
    };
  }, {
    paths: { note: NOTE_PATH, otherMd: OTHER_MD_PATH, otherTxt: OTHER_TXT_PATH },
    markdowns: {
      [NOTE_PATH]: NOTE_MARKDOWN,
      [OTHER_MD_PATH]: OTHER_MD,
      [OTHER_TXT_PATH]: OTHER_TXT,
    },
  });
}

async function waitForApp() {
  await page.waitForFunction(() =>
    document.querySelectorAll("#menubar > .ce-menu-item").length > 0);
  await page.waitForFunction(() =>
    document.getElementById("statusbar")?.textContent?.includes("note.md"));
  await page.waitForFunction(() => !!window.__coteditor?.snapshot);
  await page.evaluate(async () => {
    const pick = (suffix) => [...new Set(performance.getEntriesByType("resource")
      .map((entry) => entry.name))]
      .filter((name) => name.includes(suffix)).pop() ?? suffix;
    window.__mainTest = await import(pick("/src/editor/monaco-setup.ts"));
  });
}

const mode = () => page.evaluate(() =>
  document.getElementById("editor")?.getAttribute("data-ce-preview-mode") ?? "off");

async function ensureNoteEditor() {
  await page.keyboard.press("Control+1");
  await page.waitForFunction(() =>
    document.getElementById("statusbar")?.textContent?.includes("note.md"));
  const current = await mode();
  if (current === "split") {
    await page.keyboard.press("Control+Shift+E");
  } else if (current === "preview") {
    await page.keyboard.press("Control+e");
  }
  if (current !== "off") {
    await page.waitForFunction(() =>
      (document.getElementById("editor")?.getAttribute("data-ce-preview-mode") ?? "off") === "off");
  }
}

async function clickPreviewLink(label) {
  return page.evaluate((text) => {
    const link = [...document.querySelectorAll(".preview-body a")]
      .find((anchor) => anchor.textContent === text);
    if (!link) throw new Error(`preview link not found: ${text}`);
    link.click();
  }, label);
}

async function tabCount() {
  return page.locator("#tabs .ce-tabs-tab").count();
}

async function enterFullPreview() {
  await page.keyboard.press("Control+e");
  await page.waitForFunction(() =>
    document.getElementById("editor")?.getAttribute("data-ce-preview-mode") === "full");
}

try {
  await bootstrapMock();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForApp();

  await test("main resolves relative images through ReadAssetBase64 as data URLs", async () => {
    await ensureNoteEditor();
    await enterFullPreview();
    await page.waitForFunction((uri) => {
      const image = document.querySelector(".preview-body img[alt='pic']");
      return image?.getAttribute("src") === uri;
    }, PIXEL_URI);
    await page.waitForFunction(() =>
      document.querySelector(".preview-body img[alt='big']")?.getAttribute("data-preview-blocked") === "true");

    const result = await page.evaluate(() => ({
      pic: document.querySelector(".preview-body img[alt='pic']")?.getAttribute("src") ?? null,
      bigSrc: document.querySelector(".preview-body img[alt='big']")?.getAttribute("src") ?? null,
      remote: document.querySelector(".preview-body img[alt='remote']")?.getAttribute("src") ?? null,
      notice: document.querySelector("#preview > .preview-notice")?.textContent ?? "",
      assets: window.__assetCalls,
    }));
    assert.equal(result.pic, PIXEL_URI);
    assert.equal(result.bigSrc, null, "oversized asset must stay blocked");
    assert.equal(result.remote, "https://example.com/remote.png", "remote images are left alone");
    assert(result.notice.includes("big.png"), `notice should name the blocked asset: ${result.notice}`);
    assert.deepEqual(result.assets, [
      "C:\\work\\images\\pic.png",
      "C:\\work\\images\\big.png",
    ], "only relative local images reach the bridge");
    assert(result.assets.every((path) => !/^https?:/i.test(path)));

    await page.keyboard.press("Control+e");
    await page.waitForFunction(() =>
      (document.getElementById("editor")?.getAttribute("data-ce-preview-mode") ?? "off") === "off");
  });

  await test("main opens relative .md/.txt links, dedupes tabs, keeps anchors/external local", async () => {
    await ensureNoteEditor();
    await enterFullPreview();
    await page.waitForFunction(() => document.querySelectorAll(".preview-body a").length >= 4);

    await clickPreviewLink("other");
    await page.waitForFunction(() =>
      document.getElementById("statusbar")?.textContent?.includes("other.md"));
    assert.equal(await tabCount(), 2);
    assert.deepEqual(await page.evaluate(() => window.__openPathCalls), [NOTE_PATH, OTHER_MD_PATH]);
    await page.waitForFunction(() =>
      document.querySelector(".preview-body h1")?.textContent === "Other");

    // Returning to the source tab and clicking the same link activates the
    // existing tab instead of invoking the bridge again.
    await page.keyboard.press("Control+1");
    await page.waitForFunction(() =>
      document.getElementById("statusbar")?.textContent?.includes("note.md"));
    await page.waitForFunction(() =>
      document.querySelector(".preview-body h1")?.textContent === "Alpha");
    await clickPreviewLink("other");
    await page.waitForFunction(() =>
      document.getElementById("statusbar")?.textContent?.includes("other.md"));
    assert.equal(await tabCount(), 2, "same path must reuse its tab");
    assert.equal((await page.evaluate(() => window.__openPathCalls)).length, 2,
      "reused tab must not re-read the file");

    await page.keyboard.press("Control+1");
    await page.waitForFunction(() =>
      document.querySelector(".preview-body h1")?.textContent === "Alpha");
    const openCallsBeforeAnchor = (await page.evaluate(() => window.__openPathCalls)).length;
    await clickPreviewLink("jump");
    await page.waitForFunction(() => (document.getElementById("preview")?.scrollTop ?? 0) > 100);
    assert.equal((await page.evaluate(() => window.__openPathCalls)).length, openCallsBeforeAnchor,
      "in-page anchors must not open a document");
    const anchorNotice = await page.evaluate(() =>
      document.querySelector("#preview > .preview-notice")?.textContent ?? "");
    assert(!anchorNotice.includes("jump") && !anchorNotice.includes("锚点"),
      `resolved anchor must not report a blocked link: ${anchorNotice}`);

    await clickPreviewLink("ext");
    assert.deepEqual(await page.evaluate(() => window.__externalCalls), ["https://example.com/page"]);
    assert.equal((await page.evaluate(() => window.__openPathCalls)).length, openCallsBeforeAnchor,
      "external links must not be treated as local documents");

    await clickPreviewLink("text");
    await page.waitForFunction(() =>
      document.getElementById("statusbar")?.textContent?.includes("other.txt"));
    assert.equal(await tabCount(), 3);
    assert.equal((await page.evaluate(() => window.__openPathCalls)).at(-1), OTHER_TXT_PATH);
    // A non-Markdown target leaves preview and returns to the editor.
    await page.waitForFunction(() =>
      (document.getElementById("editor")?.getAttribute("data-ce-preview-mode") ?? "off") === "off");
  });

  await test("split preview lays out side by side, stacks on a narrow window and restores focus", async () => {
    await ensureNoteEditor();
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.keyboard.press("Control+Shift+E");
    await page.waitForFunction(() =>
      document.getElementById("editor")?.getAttribute("data-ce-preview-mode") === "split");
    assert.equal(await page.evaluate(() =>
      document.getElementById("preview")?.hidden), false);
    assert.equal(await page.evaluate(() =>
      document.querySelector("#editor > .monaco-editor")?.style.display), "");
    assert.equal(await page.locator('.toolbar-mode-btn[data-mode="split"]')
      .getAttribute("aria-pressed"), "true");
    assert(await page.evaluate(() => window.__mainTest.getEditor().hasTextFocus()),
      "entering split must not steal editor focus");

    const wide = await page.evaluate(() => {
      const monaco = document.querySelector("#editor > .monaco-editor").getBoundingClientRect();
      const preview = document.getElementById("preview").getBoundingClientRect();
      return {
        monaco: { left: monaco.left, right: monaco.right, width: monaco.width, height: monaco.height },
        preview: { left: preview.left, right: preview.right, width: preview.width, height: preview.height },
      };
    });
    assert(wide.monaco.width > 200 && wide.preview.width > 200,
      `both panes need width: ${JSON.stringify(wide)}`);
    assert(wide.preview.left >= wide.monaco.right - 2,
      `panes must be side by side: ${JSON.stringify(wide)}`);
    assert(wide.monaco.height > 200 && wide.preview.height > 200,
      `both panes need height: ${JSON.stringify(wide)}`);

    await page.setViewportSize({ width: 640, height: 900 });
    // Keep the outline beside the split panes while narrow: neither the
    // workspace nor Monaco may force a horizontal scrollbar.
    await page.keyboard.press("Control+Shift+O");
    await page.waitForFunction(() => document.getElementById("outline")?.hidden === false);
    await page.waitForFunction(() => {
      const monaco = document.querySelector("#editor > .monaco-editor");
      const preview = document.getElementById("preview");
      const app = document.getElementById("app");
      if (!monaco || !preview || !app) return false;
      const a = monaco.getBoundingClientRect();
      const b = preview.getBoundingClientRect();
      // Wait for both the CSS stacking and Monaco's relayout of its overflow
      // guard, which is what would otherwise force a horizontal scrollbar.
      return b.top >= a.bottom - 2
        && a.width > 200 && b.width > 200
        && app.scrollWidth <= app.clientWidth + 1;
    });
    const narrow = await page.evaluate(() => ({
      appOverflow: document.getElementById("app").scrollWidth
        - document.getElementById("app").clientWidth,
      bodyOverflow: document.body.scrollWidth - window.innerWidth,
      editorWidth: document.getElementById("editor").getBoundingClientRect().width,
      outlineWidth: document.getElementById("outline").getBoundingClientRect().width,
    }));
    assert(narrow.appOverflow <= 1, `app overflow ${narrow.appOverflow}`);
    assert(narrow.bodyOverflow <= 1, `body overflow ${narrow.bodyOverflow}`);
    assert(narrow.editorWidth <= 640, `editor width ${narrow.editorWidth}`);
    assert(narrow.outlineWidth >= 150, `outline width ${narrow.outlineWidth}`);

    await page.keyboard.press("Control+Shift+O");
    await page.waitForFunction(() => document.getElementById("outline")?.hidden === true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.keyboard.press("Control+Shift+E");
    await page.waitForFunction(() =>
      (document.getElementById("editor")?.getAttribute("data-ce-preview-mode") ?? "off") === "off");
    assert(await page.evaluate(() => window.__mainTest.getEditor().hasTextFocus()),
      "leaving split restores editor focus");

    // The original full-screen Edit/Preview toggle is unchanged.
    await enterFullPreview();
    assert.equal(await page.evaluate(() =>
      document.querySelector("#editor > .monaco-editor")?.style.display), "none");
    await page.keyboard.press("Control+e");
    await page.waitForFunction(() =>
      (document.getElementById("editor")?.getAttribute("data-ce-preview-mode") ?? "off") === "off");
    assert(await page.evaluate(() => window.__mainTest.getEditor().hasTextFocus()));

    // Toolbar toggle.
    await page.locator('.toolbar-mode-btn[data-mode="split"]').click();
    await page.waitForFunction(() =>
      document.getElementById("editor")?.getAttribute("data-ce-preview-mode") === "split");
    await page.locator('.toolbar-mode-btn[data-mode="edit"]').click();
    await page.waitForFunction(() =>
      (document.getElementById("editor")?.getAttribute("data-ce-preview-mode") ?? "off") === "off");

    // View menu toggle and checked state.
    await page.locator("#menubar > .ce-menu-item").filter({ hasText: /^(视图|View)$/ }).click();
    await page.locator(".ce-menu-dropdown button")
      .filter({ hasText: /分屏预览|Split Preview/ }).click();
    await page.waitForFunction(() =>
      document.getElementById("editor")?.getAttribute("data-ce-preview-mode") === "split");
    await page.locator("#menubar > .ce-menu-item").filter({ hasText: /^(视图|View)$/ }).click();
    assert.equal(
      await page.locator(".ce-menu-dropdown button")
        .filter({ hasText: /分屏预览|Split Preview/ }).getAttribute("aria-checked"),
      "true",
    );
    await page.locator(".ce-menu-dropdown button")
      .filter({ hasText: /分屏预览|Split Preview/ }).click();
    await page.waitForFunction(() =>
      (document.getElementById("editor")?.getAttribute("data-ce-preview-mode") ?? "off") === "off");
  });

  await test("outline follows the active Markdown document, filters, navigates and hides for non-Markdown", async () => {
    await ensureNoteEditor();
    await page.keyboard.press("Control+Shift+O");
    await page.waitForFunction(() => !document.getElementById("outline")?.hidden);
    assert(await page.evaluate(() => window.__mainTest.getEditor().hasTextFocus()),
      "opening the outline must not steal editor focus");
    const headings = await page.$$eval("#outline .ce-outline-item", (nodes) =>
      nodes.map((node) => ({ line: Number(node.dataset.line), text: node.textContent })));
    assert.deepEqual(headings, [
      { line: 1, text: "Alpha" },
      { line: 12, text: "Beta" },
      { line: 75, text: "Target" },
    ]);
    assert.equal(await page.evaluate(() =>
      JSON.parse(localStorage.getItem("coteditor.settings.v1") ?? "{}").showOutline), true);

    await page.locator("#outline .ce-outline-filter").fill("beta");
    assert.equal(await page.locator("#outline .ce-outline-item").count(), 1);
    await page.locator("#outline .ce-outline-filter").fill("");
    assert.equal(await page.locator("#outline .ce-outline-item").count(), 3);

    await page.locator('#outline .ce-outline-item[data-line="12"] .ce-outline-button').click();
    await page.waitForFunction(() =>
      window.__mainTest.getEditor().getPosition()?.lineNumber === 12);
    assert(await page.evaluate(() => window.__mainTest.getEditor().hasTextFocus()),
      "heading click moves the caret into the editor");

    await page.evaluate(() => {
      const editor = window.__mainTest.getEditor();
      editor.setPosition({ lineNumber: 75, column: 1 });
      editor.focus();
    });
    await page.waitForFunction(() => {
      const active = document.querySelector('#outline .ce-outline-item[data-active="true"]');
      return active?.textContent === "Target";
    });

    // Switching the syntax away from Markdown hides the panel; switching back
    // restores it without touching the persisted preference.
    await page.locator("#toolbar select").first().selectOption("");
    await page.waitForFunction(() => document.getElementById("outline")?.hidden === true);
    await page.locator("#toolbar select").first().selectOption("Markdown");
    await page.waitForFunction(() => document.getElementById("outline")?.hidden === false);

    await page.keyboard.press("Control+Shift+O");
    await page.waitForFunction(() => document.getElementById("outline")?.hidden === true);
    assert.equal(await page.evaluate(() =>
      JSON.parse(localStorage.getItem("coteditor.settings.v1") ?? "{}").showOutline), false);

    // Menu entry restores it and reports its checked state.
    await page.locator("#menubar > .ce-menu-item").filter({ hasText: /^(视图|View)$/ }).click();
    await page.locator(".ce-menu-dropdown button")
      .filter({ hasText: /显示大纲|Show Outline/ }).click();
    await page.waitForFunction(() => document.getElementById("outline")?.hidden === false);
    await page.locator("#menubar > .ce-menu-item").filter({ hasText: /^(视图|View)$/ }).click();
    assert.equal(
      await page.locator(".ce-menu-dropdown button")
        .filter({ hasText: /显示大纲|Show Outline/ }).getAttribute("aria-checked"),
      "true",
    );
    await page.keyboard.press("Escape");
  });

  await test("outline preference and width survive a reload", async () => {
    await page.evaluate(() => {
      localStorage.setItem("coteditor.settings.v1", JSON.stringify({
        language: "zh",
        showOutline: true,
        outlineWidth: 320,
      }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForApp();
    await page.waitForFunction(() => !document.getElementById("outline")?.hidden);
    const width = await page.locator("#outline").evaluate((element) =>
      element.getBoundingClientRect().width);
    assert(Math.abs(width - 320) <= 1, `outline width should follow settings: ${width}`);
    assert.equal(await page.locator("#outline .ce-outline-item").count(), 3);
    assert(await page.evaluate(() => window.__mainTest.getEditor().hasTextFocus()),
      "restored outline must not steal editor focus");

    await page.locator("#menubar > .ce-menu-item").filter({ hasText: /^(视图|View)$/ }).click();
    assert.equal(
      await page.locator(".ce-menu-dropdown button")
        .filter({ hasText: /显示大纲|Show Outline/ }).getAttribute("aria-checked"),
      "true",
    );
    await page.locator(".ce-menu-dropdown button")
      .filter({ hasText: /显示大纲|Show Outline/ }).click();
    await page.waitForFunction(() => document.getElementById("outline")?.hidden === true);
    assert.equal(await page.evaluate(() =>
      JSON.parse(localStorage.getItem("coteditor.settings.v1") ?? "{}").showOutline), false);
  });

  await test("active buffer and theme changes refresh the rendered preview", async () => {
    await ensureNoteEditor();
    await enterFullPreview();
    await page.evaluate((value) => {
      window.__mainTest.getModel().setValue(`${value}\n## Added\n`);
    }, NOTE_MARKDOWN);
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".preview-body h2")].some((h) => h.textContent === "Added"));
    await page.evaluate((value) => {
      window.__mainTest.getModel().setValue(value);
    }, NOTE_MARKDOWN);
    await page.waitForFunction(() =>
      ![...document.querySelectorAll(".preview-body h2")].some((h) => h.textContent === "Added"));

    await page.locator("#menubar > .ce-menu-item").filter({ hasText: /^(主题|Theme)$/ }).click();
    await page.locator('.ce-menu-dropdown [data-menu-action="theme-Anura (Dark)"]').click();
    await page.waitForFunction(() =>
      document.documentElement.dataset.ceTheme === "dark"
      && document.querySelector(".preview-body h1")?.textContent === "Alpha");
    await page.locator("#menubar > .ce-menu-item").filter({ hasText: /^(主题|Theme)$/ }).click();
    await page.locator('.ce-menu-dropdown [data-menu-action="theme-Classic"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.ceTheme === "light");

    await page.keyboard.press("Control+e");
    await page.waitForFunction(() =>
      (document.getElementById("editor")?.getAttribute("data-ce-preview-mode") ?? "off") === "off");
  });

  await test("outline follows live buffer edits", async () => {
    await ensureNoteEditor();
    await page.keyboard.press("Control+Shift+O");
    await page.waitForFunction(() => document.getElementById("outline")?.hidden === false);
    await page.evaluate((value) => {
      window.__mainTest.getModel().setValue(`${value}\n## Late heading\n`);
    }, NOTE_MARKDOWN);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#outline .ce-outline-item")]
        .some((item) => item.textContent === "Late heading"));
    await page.evaluate((value) => {
      window.__mainTest.getModel().setValue(value);
    }, NOTE_MARKDOWN);
    await page.waitForFunction(() =>
      ![...document.querySelectorAll("#outline .ce-outline-item")]
        .some((item) => item.textContent === "Late heading"));
  });

  await test("no unhandled page errors", async () => {
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
  });
} catch (error) {
  failures.push("suite setup");
  console.error(error.stack || error);
} finally {
  await browser.close();
}

console.log(failures.length
  ? `FAIL (${failures.length}): ${failures.join("; ")}`
  : "ALL PREVIEW/MAIN REGRESSIONS PASS");
process.exitCode = failures.length ? 1 : 0;
