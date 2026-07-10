/// <reference types="vite/client" />

// Allow importing CSS files as side-effect modules.
declare module "*.css";

// Allow importing CotEditor vendored resource files as raw strings.
declare module "*.cottheme" {
  const content: string;
  export default content;
}

declare module "*.scm" {
  const content: string;
  export default content;
}

// Monaco's editor worker, imported via Vite's `?worker` suffix.
declare module "monaco-editor/esm/vs/editor/editor.worker?worker" {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

// The editor core entry (`edcore.main`) re-exports the same `editor.api`
// surface as the package root (`monaco-editor`), but TypeScript can't see that
// because the package's `module` field points at `editor.main.js`. We import
// `edcore.main` directly to skip bundling all 81 built-in languages + the 4
// language services (CotEditor-win uses its own highlight engines); this
// declaration gives that deep import the full Monaco type surface.
declare module "monaco-editor/esm/vs/editor/edcore.main.js" {
  export * from "monaco-editor";
}

// Wails v2 injects a `go` global on `window` when the page is loaded inside the
// native webview; its presence is how we detect Wails mode at runtime. The
// generated bindings under `src/wailsjs/` populate it.
interface Window {
  go?: unknown;
}
