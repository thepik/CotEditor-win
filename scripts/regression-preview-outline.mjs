// Preview + outline regressions. Run against the Vite dev server:
//   node scripts/regression-preview-outline.mjs http://127.0.0.1:1420/
//
// The suite imports the modules dynamically and mounts its own outline host /
// focus fixture. It does not require main.ts to have wired the outline panel
// (that integration is owned by a later change).
import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1420/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);

const failures = [];
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

async function test(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.stack || error}`);
  }
}

/** Render Markdown through the preview module. */
async function render(markdown) {
  await page.evaluate((content) => window.__preview.renderPreview(content), markdown);
}

/** Click an anchor inside the preview without Playwright scrolling it into view. */
async function clickPreviewLink(text) {
  return page.evaluate((label) => {
    const link = [...document.querySelectorAll(".preview-body a")]
      .find((anchor) => anchor.textContent === label);
    if (!link) throw new Error(`preview link not found: ${label}`);
    link.click();
  }, text);
}

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  // index.html always provides #preview/.preview-body; do not wait for the
  // editor bootstrap so this suite is independent of in-flight main.ts work.
  await page.waitForFunction(() => !!document.getElementById("preview"));

  await page.evaluate(async () => {
    const resources = [...new Set(performance.getEntriesByType("resource").map((entry) => entry.name))];
    // Bind to the exact specifier the page loaded (Vite may append ?t=... for
    // HMR); otherwise the dynamic import can create a second module instance.
    const previewUrl = resources.filter((name) => name.includes("/src/ui/preview.ts")).pop()
      ?? "/src/ui/preview.ts";
    window.__preview = await import(previewUrl);
    window.__outline = await import("/src/ui/outline.ts");
    window.__originalRuntime = window.runtime;
    window.__originalOpen = window.open;

    const host = document.getElementById("preview");
    host.hidden = false;
    host.style.position = "relative";
    host.style.width = "900px";
    host.style.height = "600px";
    host.style.maxHeight = "600px";
    host.style.overflow = "auto";
    host.style.padding = "16px";
    host.scrollTop = 0;
    if (!host.querySelector(".preview-body")) {
      const body = document.createElement("div");
      body.className = "preview-body";
      host.appendChild(body);
    }

    let fixture = document.getElementById("ce-outline-focus-fixture");
    if (!fixture) {
      fixture = document.createElement("textarea");
      fixture.id = "ce-outline-focus-fixture";
      fixture.setAttribute("data-ce-outline-editor-focus", "");
      fixture.style.position = "fixed";
      fixture.style.left = "-1000px";
      fixture.style.top = "0";
      document.body.appendChild(fixture);
    }
  });

  await test("slugger: stable ids, duplicate suffixes, Unicode headings", async () => {
    const slugs = await page.evaluate(() => {
      const { createPreviewSlugger, slugifyHeading } = window.__preview;
      const slug = createPreviewSlugger();
      return [
        slug("Hello World"),
        slug("Hello World"),
        slug("Hello World"),
        slug("中文 标题"),
        slugifyHeading("  A  B!! "),
      ];
    });
    assert.deepEqual(slugs, [
      "hello-world",
      "hello-world-1",
      "hello-world-2",
      "中文-标题",
      "a-b",
    ]);

    await render("# Intro\n\n## Intro\n\n### Intro\n\n## 中文 标题");
    const ids = await page.$$eval(".preview-body h1, .preview-body h2, .preview-body h3", (nodes) =>
      nodes.map((node) => ({ tag: node.tagName, id: node.id })));
    assert.deepEqual(ids.map((entry) => entry.id), [
      "intro",
      "intro-1",
      "intro-2",
      "中文-标题",
    ]);
  });

  await test("in-page #anchor scrolls the preview container, not the document", async () => {
    const content = [
      "# Top",
      "",
      "[jump](#target)",
      "",
      ...Array.from({ length: 90 }, (_, index) => `paragraph ${index}\n`),
      "## Target",
      "",
      ...Array.from({ length: 25 }, (_, index) => `tail ${index}\n`),
    ].join("\n");
    await render(content);
    const beforeUrl = page.url();
    const result = await page.evaluate(() => {
      const host = document.getElementById("preview");
      host.scrollTop = 0;
      window.scrollTo(0, 0);
      const link = [...document.querySelectorAll(".preview-body a")]
        .find((anchor) => anchor.textContent === "jump");
      link.click();
      const target = document.getElementById("target");
      return {
        scrollTop: host.scrollTop,
        offset: target.getBoundingClientRect().top - host.getBoundingClientRect().top,
        pageY: window.scrollY,
        scrollable: host.scrollHeight > host.clientHeight,
      };
    });
    assert.equal(result.scrollable, true, "fixture must be tall enough to scroll");
    assert(result.scrollTop > 100, `expected container scroll, got ${result.scrollTop}`);
    assert(result.offset >= 0 && result.offset < 60, `anchor offset ${result.offset}`);
    assert.equal(result.pageY, 0, "document must not scroll");
    assert.equal(page.url(), beforeUrl, "in-page anchor must not change the URL");
  });

  await test("external links go to the OS/browser and never navigate the WebView", async () => {
    const target = "https://example.com/path?q=1";
    await render(`[ext](${target})`);
    const beforeUrl = page.url();

    await page.evaluate(() => {
      window.__externalCalls = [];
      window.runtime = {
        BrowserOpenURL: (href) => window.__externalCalls.push(href),
      };
    });
    await clickPreviewLink("ext");
    assert.deepEqual(await page.evaluate(() => window.__externalCalls), [target]);
    assert.equal(page.url(), beforeUrl, "Wails path must not navigate the page");

    await page.evaluate(() => {
      delete window.runtime;
      window.__openCalls = [];
      window.__originalOpen = window.open;
      window.open = (...args) => {
        window.__openCalls.push(args);
        return null;
      };
    });
    await clickPreviewLink("ext");
    assert.deepEqual(await page.evaluate(() => window.__openCalls), [[target, "_blank", "noopener"]]);
    assert.equal(page.url(), beforeUrl, "browser path must not navigate the page");
  });

  await test("relative links are blocked visibly without a handler, handled with one", async () => {
    await render("[doc](./guide.md)");
    const beforeUrl = page.url();
    await clickPreviewLink("doc");
    const notice = await page.locator("#preview > .preview-notice").first().textContent();
    assert(notice.includes("./guide.md"), `notice should mention the link: ${notice}`);
    assert.equal(page.url(), beforeUrl, "relative link must not navigate");

    await render("[doc](./guide.md)");
    await page.evaluate(() => {
      window.__handled = [];
      window.__preview.setPreviewLinkHandler((href) => {
        window.__handled.push(href);
        return true;
      });
    });
    await clickPreviewLink("doc");
    assert.deepEqual(await page.evaluate(() => window.__handled), ["./guide.md"]);
    assert.equal(await page.locator("#preview > .preview-notice").count(), 0);
    assert.equal(page.url(), beforeUrl);

    // Resolver fallback can turn a relative link into an external destination.
    await page.evaluate(() => {
      window.__preview.setPreviewLinkHandler(null);
      window.__preview.setPreviewResourceResolver((href, kind) =>
        kind === "link" && href === "docs/a.md" ? "https://example.com/a" : null);
      window.__externalCalls = [];
      window.runtime = {
        BrowserOpenURL: (href) => window.__externalCalls.push(href),
      };
    });
    await render("[resolved](docs/a.md)");
    await clickPreviewLink("resolved");
    assert.deepEqual(await page.evaluate(() => window.__externalCalls), ["https://example.com/a"]);
  });

  await test("relative images resolve through the resolver and are blocked otherwise", async () => {
    const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    await render("![pic](./pic.png)");
    const blocked = await page.evaluate(() => {
      const image = document.querySelector(".preview-body img");
      return {
        src: image.getAttribute("src"),
        blocked: image.getAttribute("data-preview-blocked"),
        notice: document.querySelector("#preview > .preview-notice")?.textContent ?? "",
      };
    });
    assert.equal(blocked.src, null);
    assert.equal(blocked.blocked, "true");
    assert(blocked.notice.includes("./pic.png"));

    await render("![pic](./pic.png)");
    await page.evaluate((dataUri) => {
      window.__preview.setPreviewResourceResolver((href, kind) =>
        kind === "image" && href === "./pic.png" ? dataUri : null);
    }, pixel);
    await render("![pic](./pic.png)");
    assert.equal(
      await page.$eval(".preview-body img", (image) => image.getAttribute("src")),
      pixel,
    );

    await page.evaluate(() => {
      window.__preview.setPreviewResourceResolver(() => "javascript:window.__xss=9");
    });
    await render("![pic](./pic.png)");
    const unsafe = await page.evaluate(() => ({
      src: document.querySelector(".preview-body img").getAttribute("src"),
      xss: window.__xss,
    }));
    assert.equal(unsafe.src, null);
    assert.equal(unsafe.xss, undefined);
  });

  await test("re-render preserves the preview scroll position", async () => {
    const content = [
      "# Scroll",
      "",
      ...Array.from({ length: 150 }, (_, index) => `line ${index}\n`),
    ].join("\n");
    await render(content);
    const before = await page.evaluate(() => {
      const host = document.getElementById("preview");
      host.scrollTop = 420;
      return host.scrollTop;
    });
    assert(before > 0, "fixture must be scrollable");
    await render(`${content}\n\nappended`);
    const after = await page.evaluate(() => document.getElementById("preview").scrollTop);
    assert(Math.abs(after - before) <= 1, `scroll ${before} -> ${after}`);
  });

  await test("empty and oversized documents degrade safely", async () => {
    await render("   \n\t\n");
    const empty = await page.evaluate(() => ({
      count: document.querySelectorAll(".preview-body .preview-empty").length,
      text: document.querySelector(".preview-body")?.textContent ?? "",
    }));
    assert.equal(empty.count, 1);
    assert(empty.text.trim().length > 0);

    await page.evaluate(() => {
      window.__preview.renderPreview(`# Big\n${"x".repeat(320000)}`);
    });
    const large = await page.evaluate(() => ({
      plain: document.querySelectorAll(".preview-body pre.preview-plain").length,
      headings: document.querySelectorAll(".preview-body h1").length,
      notice: document.querySelector("#preview > .preview-notice")?.textContent ?? "",
      textLength: document.querySelector(".preview-body")?.textContent?.length ?? 0,
    }));
    assert.equal(large.plain, 1);
    assert.equal(large.headings, 0);
    assert(large.notice.length > 0, "degraded render must show a notice");
    assert(large.textLength >= 320000);
  });

  await test("HTML stays disabled, DOMPurify sanitises, unsafe schemes are blocked", async () => {
    const malicious = [
      "# <img src=x onerror=\"window.__xss=1\">",
      "",
      "[bad](javascript:window.__xss=2)",
      "",
      "<script>window.__xss=3</script>",
      "",
      "![bad](javascript:window.__xss=4)",
      "",
      "[ok](https://example.com)",
    ].join("\n");
    await render(malicious);
    const result = await page.evaluate(() => ({
      xss: window.__xss,
      scripts: document.querySelectorAll(".preview-body script").length,
      liveImages: document.querySelectorAll(".preview-body img[src]").length,
      headingId: document.querySelector(".preview-body h1")?.id ?? "",
    }));
    assert.equal(result.xss, undefined);
    assert.equal(result.scripts, 0);
    assert.equal(result.liveImages, 0, "raw HTML must be escaped, not rendered");
    assert(result.headingId.length > 0);

    const routes = await page.evaluate(() => [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///C:/a",
      "https://a.example/x",
      "//cdn.example/x",
      "#frag",
      "./a.md",
      "C:\\docs\\a.md",
      "mailto:a@b",
    ].map((href) => {
      const route = window.__preview.routePreviewHref(href);
      return {
        kind: route.kind,
        url: route.url ?? null,
        reason: route.reason ?? null,
      };
    }));
    assert.deepEqual(routes.map((route) => route.kind), [
      "blocked",
      "blocked",
      "blocked",
      "external",
      "external",
      "anchor",
      "relative",
      "relative",
      "external",
    ]);
    assert.equal(routes[4].url, "https://cdn.example/x");
    assert.equal(routes[0].reason, "unsafe-scheme");
  });

  await test("outline parser skips fenced code and keeps 1-based lines", async () => {
    const markdown = [
      "# Alpha",
      "",
      "```js",
      "# Not a heading",
      "```",
      "",
      "## Beta",
      "",
      "~~~",
      "### Not either",
      "~~~",
      "",
      "####### Too deep",
      "",
      "   ### Gamma ###",
      "",
      "##",
    ].join("\n");
    const parsed = await page.evaluate((text) => window.__outline.parseOutlineHeadings(text), markdown);
    assert.deepEqual(parsed, [
      { level: 1, text: "Alpha", line: 1 },
      { level: 2, text: "Beta", line: 7 },
      { level: 3, text: "Gamma", line: 15 },
    ]);
    const crlf = await page.evaluate(() => window.__outline.parseOutlineHeadings("# A\r\n## B\r\n"));
    assert.deepEqual(crlf, [
      { level: 1, text: "A", line: 1 },
      { level: 2, text: "B", line: 2 },
    ]);
  });

  await test("outline controller: update, filtering, keyboard, click, active line, dispose", async () => {
    const markdown = [
      "# Alpha",
      "",
      "text",
      "",
      "## Beta",
      "",
      "```",
      "# Not heading",
      "```",
      "",
      "### Gamma",
      "",
      "## Beta",
    ].join("\n");
    await page.evaluate((text) => {
      document.getElementById("ce-outline-test-host")?.remove();
      const host = document.createElement("div");
      host.id = "ce-outline-test-host";
      host.style.cssText = "position:fixed;right:8px;top:8px;width:260px;height:360px;z-index:2147483647;background:#fff;display:block;";
      document.body.appendChild(host);
      window.__outlineCtl = window.__outline.createOutline(host);
      window.__navLines = [];
      window.__outlineCtl.onNavigate((line) => window.__navLines.push(line));
      window.__outlineCtl.update({ getValue: () => text });
    }, markdown);

    const items = await page.$$eval("#ce-outline-test-host .ce-outline-item", (nodes) =>
      nodes.map((node) => ({
        line: Number(node.dataset.line),
        level: Number(node.dataset.level),
        text: node.textContent,
      })));
    assert.deepEqual(items, [
      { line: 1, level: 1, text: "Alpha" },
      { line: 5, level: 2, text: "Beta" },
      { line: 11, level: 3, text: "Gamma" },
      { line: 13, level: 2, text: "Beta" },
    ]);
    assert.equal(
      await page.evaluate(() =>
        getComputedStyle(document.querySelector("#ce-outline-test-host .ce-outline-panel")).display),
      "flex",
      "outline.css must be imported by outline.ts",
    );

    await page.locator("#ce-outline-test-host .ce-outline-filter").fill("beta");
    assert.equal(await page.locator("#ce-outline-test-host .ce-outline-item").count(), 2);
    assert.equal(
      await page.locator("#ce-outline-test-host .ce-outline-count").textContent(),
      "2/4",
    );

    const filter = page.locator("#ce-outline-test-host .ce-outline-filter");
    await filter.focus();
    await filter.press("ArrowDown");
    await filter.press("ArrowDown");
    await filter.press("Enter");
    assert.deepEqual(await page.evaluate(() => window.__navLines), [13]);
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "ce-outline-focus-fixture",
      "navigation must focus the editor surface",
    );

    await filter.fill("");
    await page.locator('#ce-outline-test-host .ce-outline-item[data-line="5"] .ce-outline-button').click();
    assert.deepEqual(await page.evaluate(() => window.__navLines), [13, 5]);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "ce-outline-focus-fixture");

    await page.evaluate(() => window.__outlineCtl.setActiveLine(6));
    assert.equal(
      await page.locator('#ce-outline-test-host .ce-outline-item[data-active="true"]').getAttribute("data-line"),
      "5",
    );
    await page.evaluate(() => window.__outlineCtl.setActiveLine(12));
    assert.equal(
      await page.locator('#ce-outline-test-host .ce-outline-item[data-active="true"]').getAttribute("data-line"),
      "11",
    );
    await page.evaluate(() => window.__outlineCtl.setActiveLine(0));
    assert.equal(await page.locator('#ce-outline-test-host .ce-outline-item[data-active="true"]').count(), 0);

    await page.evaluate(() => window.__outlineCtl.toggle(false));
    assert.equal(await page.evaluate(() => document.getElementById("ce-outline-test-host").hidden), true);
    await page.evaluate(() => window.__outlineCtl.toggle());
    assert.equal(await page.evaluate(() => document.getElementById("ce-outline-test-host").hidden), false);
    await page.evaluate(() => window.__outlineCtl.toggle(true));
    assert.equal(await page.evaluate(() => document.getElementById("ce-outline-test-host").hidden), false);

    await page.evaluate(() => {
      window.__outlineCtl.dispose();
      window.__outlineCtl.update("# After dispose");
    });
    assert.equal(await page.locator("#ce-outline-test-host .ce-outline-panel").count(), 0);
    assert.equal(await page.locator("#ce-outline-test-host .ce-outline-item").count(), 0);
  });

  await test("outline renders heading text as text, never as markup", async () => {
    const markdown = "# <img src=x onerror=\"window.__xss=7\">\n\n## ok";
    await page.evaluate((text) => {
      document.getElementById("ce-outline-xss-host")?.remove();
      const host = document.createElement("div");
      host.id = "ce-outline-xss-host";
      document.body.appendChild(host);
      window.__outlineXss = window.__outline.createOutline(host);
      window.__outlineXss.update(text);
    }, markdown);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator("#ce-outline-xss-host img").count(), 0);
    const first = await page.locator("#ce-outline-xss-host .ce-outline-button").first().textContent();
    assert(first.startsWith("<img"), `heading text should be literal: ${first}`);
    await page.evaluate(() => {
      window.__outlineXss.dispose();
      document.getElementById("ce-outline-xss-host")?.remove();
    });
  });
} catch (error) {
  failures.push("suite setup");
  console.error(error.stack || error);
} finally {
  await browser.close();
}

if (pageErrors.length) {
  // In-flight main.ts work is not owned by this suite; surface page errors for
  // diagnosis but do not fail on unrelated bootstrap noise.
  console.warn(`page errors observed (not asserted): ${pageErrors.join(" | ")}`);
}
console.log(failures.length
  ? `FAIL (${failures.length}): ${failures.join("; ")}`
  : "ALL PREVIEW/OUTLINE REGRESSIONS PASS");
process.exitCode = failures.length ? 1 : 0;
