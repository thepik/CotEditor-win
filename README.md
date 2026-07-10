# CotEditor for Windows

A lightweight, local-first text/code editor for Windows, re-implemented from the macOS
[CotEditor](https://github.com/coteditor/CotEditor) design and resources.

> Status: scaffolding stage (theme/syntax/highlight engines working). See `PLAN.md`
> for the full engineering plan.

## Why Wails (not Tauri)

Originally scaffolded with Tauri, but migrated to **Wails v2 (Go)** because the
target machine runs Windows **Smart App Control (SAC)** in enforcement mode, which
blocks the `.exe` that Cargo generates for every crate build script (serde, libc,
proc-macro2, …). Wails on Windows is pure Go (no cgo, no build scripts), so its
binaries run fine under SAC. Verified: `wails build` succeeds and the resulting
exe launches a WebView2 window.

## Stack

| Layer | Tech |
|------|------|
| App shell | Wails v2 (Go backend + system WebView2) |
| Editor core | Monaco Editor |
| Syntax highlighting | `web-tree-sitter` + original `.scm` queries, plus a regex engine for JSON/Markdown |
| Frontend | TypeScript (no React/Vue) |
| Bundler | Vite |

## Reused resources (copied verbatim from CotEditor)

Resources live under `frontend/public/resources/` so Vite serves them as static
files (fetched at runtime, which sidesteps import-resolution issues with special
characters in some bundle names):

- `themes/` - 13 `.cottheme` files
- `syntaxes/` - 19 `.cotsyntax` bundles (the languages in scope)
- `queries/` - tree-sitter `.scm` highlight/outline/injection queries
- `SyntaxMap.json` - file-type auto detection map

> **Special-character aliases:** the `C#` and `C++` bundles/queries contain `#`
> and `+`, which break URL path resolution in the dev server (`#` is read as a
> fragment). Safe-name copies are kept alongside them - `Csharp.cotsyntax`,
> `Cpp.cotsyntax`, `queries/Csharp/`, `queries/Cpp/` - and `language-config.ts`
> maps to them via `bundleDir()`. The originals are retained for reference.

## Prerequisites

1. **Go** ≥ 1.21 (install via <https://go.dev/dl/> or `winget install GoLang.Go`).
2. **Node.js** ≥ 20 and npm (for the frontend build).
3. **WebView2 Runtime** - preinstalled on Windows 10/11.
4. **Wails CLI**: `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
   (run `wails doctor` to verify).

No C compiler / cgo is needed on Windows - Wails is pure Go here.

## Development

Run the native app with hot reload (compiles Go + starts Vite):

```bash
wails dev
```

This opens a native window. It also serves the app at `http://localhost:34115`
so you can open it in a browser and call the bound Go methods from devtools.

Frontend-only iteration (browser, no native window, uses File System Access
API for file IO):

```bash
cd frontend && npm run dev
```

## Build

```bash
wails build
```

Produces `build/bin/coteditor-win.exe` (~16 MB, self-contained, frontend embedded).

## Project layout

```
main.go, app.go          Wails Go backend (window + file IO methods)
wails.json               Wails project config (Vite integration)
go.mod / go.sum          Go module
frontend/
  src/                   TypeScript frontend (Monaco, themes, highlight engines)
    wailsjs/             auto-generated Wails bindings (do not edit)
  public/resources/      vendored CotEditor assets (themes/syntaxes/queries)
  vite.config.ts, ...
scripts/smoke-test.mjs   headless verification (Playwright)
```

## File IO

File open/save is abstracted by `frontend/src/lib/file-bridge.ts`:

- **Wails mode**: calls the Go methods in `app.go` (`OpenFile` / `SaveFile` /
  `SaveAs` / `NewFile`) via the generated `wailsjs/go/main/App.js` wrappers.
  Native file dialogs are Go-side (Wails v2's JS dialog API is unsupported).
- **Browser mode** (dev fallback): uses the File System Access API.

## License

CotEditor's themes, syntaxes and queries retain their original license. Application code
in this repository is for personal use.
