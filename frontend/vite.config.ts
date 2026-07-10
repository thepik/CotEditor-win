import { defineConfig } from "vite";

// CotEditor-win — Vite config for the Tauri 2 frontend.
//
// Resources under src/resources/ are vendored as-is from the original CotEditor
// (themes, .cotsyntax bundles, tree-sitter .scm queries, SyntaxMap.json) and
// must be served verbatim. We therefore disable arbitrary asset hashing for
// those file types via `assetsInclude` + explicit public passthrough instead of
// importing them through the bundler.
export default defineConfig({
  // Tauri serves the dev server at a custom port; Vite needs to know it should
  // not intercept OS-level key handling and should expose env vars prefixed TAUURI.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  // Monaco ships a web worker; configure it to be bundled by Vite.
  worker: {
    format: "es",
  },
  resolve: {
    alias: {
      "@": "/src",
      "@editor": "/src/editor",
      "@lib": "/src/lib",
      "@ui": "/src/ui",
      "@resources": "/src/resources",
    },
  },
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    // tree-sitter WASM grammars and Monaco chunks are large; raise the warning.
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ["monaco-editor"],
          treeSitter: ["web-tree-sitter"],
        },
      },
    },
  },
  // Treat vendored resource formats as static assets so imports yield URLs.
  assetsInclude: ["**/*.cottheme", "**/*.scm", "**/*.wasm"],
});
