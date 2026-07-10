# CotEditor for Windows

**English** | [中文](./README.zh-CN.md)

A lightweight, local-first text/code editor for Windows, re-implemented from the
macOS [CotEditor](https://github.com/coteditor/CotEditor) design and resources.

Built with **Wails v2 (Go)** + **Monaco Editor** + **web-tree-sitter**. The goal
is a small, fast, single-window editor that preserves CotEditor's core editing
experience, syntax highlighting, themes, and snippets—without Electron's
bloat or macOS-specific dependencies.

## Features

- **19-language syntax highlighting** — 16 via tree-sitter (JavaScript, TypeScript,
  Python, HTML, CSS, C, C++, C#, Java, Go, Rust, Ruby, PHP, Swift, Kotlin, Bash),
  plus JSON and Markdown via a regex engine driven by the original `.cotsyntax`
  rules.
- **13 themes** — loaded verbatim from CotEditor's `.cottheme` files, parsed into
  Monaco themes with light/dark auto-detection.
- **Multi-cursor editing** — Ctrl+Click, column selection, select-next-match
  (Monaco built-in).
- **Smart editing** — auto-closing pairs, comment toggle, and smart indentation
  derived from each language's `.cotsyntax/Edit.json`.
- **15 line operations** — sort, reverse, shuffle, dedupe, move up/down, duplicate,
  delete, join, indent/outdent, remove empty lines, trim trailing whitespace.
- **Snippet templates** — `<<<SELECTION>>>` / `<<<CURSOR>>>` placeholders with
  multi-cursor positioning and indentation preservation. Manage via a panel,
  insert via Ctrl+Alt+1..9.
- **Find & replace** — Monaco's built-in find widget (regex, case, whole-word) plus
  a multiple-replace engine with ordered rules and TSV import/export.
- **Bilingual UI** — Chinese / English interface with live switching (View → 语言).
- **File operations** — open / save / save-as / new via native dialogs, with dirty
  marker and UTF-8 encoding.

## Screenshots

The app icon is synthesized from the original CotEditor `AppIcon` (green rounded
square + gears + pen). See `scripts/build-icon.mjs` for the compositing pipeline.


## Tech stack

| Layer | Tech | Notes |
|-------|------|-------|
| App shell | Wails v2 | Go backend + system WebView2; single self-contained exe |
| Editor core | Monaco Editor | multi-cursor, find/replace, line numbers—all built-in |
| Syntax highlighting | `web-tree-sitter` + original `.scm` queries | 16 languages; grammar WASMs loaded lazily |
| Regex highlighting | custom ICU→JS regex engine | JSON, Markdown (parses `.cotsyntax/Regex/Highlights.json`) |
| Frontend | TypeScript | plain DOM, no React/Vue |
| Bundler | Vite | Wails default |
| Backend | Go (minimal) | file IO + native dialogs only |

## Build & run

### Prerequisites

- **Go** ≥ 1.21 — <https://go.dev/dl/>
- **Node.js** ≥ 20 and npm
- **WebView2 Runtime** — preinstalled on Windows 10/11
- **Wails CLI** — `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- **NSIS** (optional, for installer) — install and ensure `makensis` is on `PATH`

No C compiler / cgo is needed on Windows — Wails is pure Go here.

### Development

```bash
# Native app with hot reload (compiles Go + starts Vite)
wails dev

# Frontend-only (browser, File System Access API for file IO)
cd frontend && npm run dev

# Type check
cd frontend && npx tsc --noEmit

# Headless smoke test (needs dev server running)
npm run smoke           # Wails native binding mode
npm run smoke:browser   # browser fallback mode
```

### Production build

```bash
# Standalone exe → build/bin/coteditor-win.exe (~40 MB, frontend embedded)
wails build

# NSIS installer → build/bin/coteditor-win-amd64-installer.exe (~10 MB, compressed)
wails build -nsis
```

### Regenerating the app icon

Only needed when updating the icon source assets (sourced from the original
CotEditor `AppIcon.icon`):

```bash
npm run build:icon
```

This composites the layered icon (`Outline.svg` gradient + gears + pen/shadow)
into `build/appicon.png` (1024px) and `build/windows/icon.ico` (6 sizes), which
Wails embeds into the exe and installer.

## Project layout

```
main.go, app.go              Wails Go backend (window + file IO methods)
wails.json                   Wails project config (Vite integration)
go.mod / go.sum              Go module
frontend/
  src/
    main.ts                  Bootstrap: editor + themes + syntax + UI wiring
    editor/
      monaco-setup.ts        Monaco mount + slimmed language registration
      theme-loader.ts        .cottheme → Monaco theme parsing
      grammar-registry.ts    tree-sitter grammar WASM + .scm query registry
      highlight-tree-sitter.ts  tree-sitter → Monaco semantic tokens
      highlight-regex.ts     ICU→JS regex → Monaco TokensProvider
      language-config.ts     .cotsyntax/Edit.json → Monaco language config
      line-commands.ts       15 line-operation commands + shortcuts
    lib/
      file-bridge.ts         Wails/browser dual-mode file IO
      syntax-map.ts          file-type detection (SyntaxMap.json)
      snippet-engine.ts      snippet tokenizer + insertion
      multiple-replace.ts    multiple-replace engine + TSV import/export
      text-operations.ts     line-processing algorithms
      i18n.ts                bilingual dictionary + runtime (zh/en)
    ui/
      menubar.ts, toolbar.ts, statusbar.ts
      find-panel.ts, snippet-manager.ts, multiple-replace-ui.ts
    wailsjs/                 auto-generated Wails bindings (do not edit)
  public/resources/          vendored CotEditor assets
    themes/                  13 .cottheme files
    syntaxes/                19 .cotsyntax bundles (+ Csharp/Cpp aliases)
    queries/                 tree-sitter .scm highlight/outline/injection queries
    grammars/                tree-sitter grammar WASMs (gitignored, fetched)
    SyntaxMap.json           file-type auto-detection map
  vite.config.ts, tsconfig.json, package.json
build/
  appicon.png                1024px app icon (source for icon.ico)
  windows/
    icon.ico                 multi-size Windows icon (embedded in exe)
    info.json, wails.exe.manifest  version resource + manifest templates
scripts/
  build-icon.mjs             icon compositing (SVG layers → PNG → ICO)
  smoke-test.mjs             headless verification (Playwright + Chromium)
```

## Resources

All syntax themes, `.cotsyntax` bundles, and tree-sitter `.scm` queries are
copied verbatim from the original CotEditor and served as static files. The
tree-sitter grammar WASMs come from the
[`tree-sitter-wasms`](https://www.npmjs.com/package/tree-sitter-wasms) npm
package (gitignored; run `npm install` to fetch).

> **Special-character aliases:** the `C#` and `C++` bundles/queries contain `#`
> and `+`, which break URL path resolution in the dev server (`#` is read as a
> fragment). Safe-name copies are kept alongside them (`Csharp`, `Cpp`) and
> `language-config.ts` maps to them via `bundleDir()`.

## File IO

File open/save is abstracted by `frontend/src/lib/file-bridge.ts`:

- **Wails mode** — calls the Go methods in `app.go` (`OpenFile` / `SaveFile` /
  `SaveAs` / `NewFile`) via the generated `wailsjs/go/main/App.js` wrappers.
  Native file dialogs are Go-side (Wails v2's JS dialog API is unsupported).
- **Browser mode** (dev fallback) — uses the File System Access API.

## Limitations / out of scope

- Single-document (no tabs / sidebar).
- UTF-8 only (no encoding auto-detection for other encodings).
- SQL has no tree-sitter grammar WASM available, so it is not highlighted.
- No cloud sync, QuickLook, AppleScript, or auto-update.
- UI is Chinese/English only.

## Acknowledgements

- [CotEditor](https://github.com/coteditor/CotEditor) — the original macOS editor
  whose design, themes, syntax definitions, and tree-sitter queries this project
  reuses.
- [Wails](https://wails.io), [Monaco Editor](https://microsoft.github.io/monaco-editor/),
  and [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) — the
  frameworks that make this port possible.

## License

CotEditor's themes, syntaxes, and queries retain their original license.
Application code in this repository is for personal use.
