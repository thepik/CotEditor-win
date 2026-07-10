/**
 * Top toolbar: New / Open / Save / Save As buttons.
 *
 * Built with plain DOM (no framework, per PLAN §二). `wireToolbar` renders the
 * buttons once into `#toolbar` and binds click handlers to the supplied
 * callbacks (which live in main.ts so they can invoke Tauri commands).
 *
 * Button labels are i18n-driven and re-render on language switch via
 * `renderToolbar`, keeping the stored callbacks intact.
 */

import { t, onLangChange } from "../lib/i18n";

export interface ToolbarActions {
  onNew: () => void | Promise<void>;
  onOpen: () => void | Promise<void>;
  onSave: () => void | Promise<void>;
  onSaveAs: () => void | Promise<void>;
}

/** The actions bound at `wireToolbar` time, retained for re-rendering. */
let actions: ToolbarActions | null = null;

/** Re-render the toolbar buttons using the current language. */
export function renderToolbar(): void {
  const host = document.getElementById("toolbar");
  if (!host || !actions) return;
  host.innerHTML = "";

  const buttons: Array<[string, () => void | Promise<void>]> = [
    [t("toolbar.new"), actions.onNew],
    [t("toolbar.open"), actions.onOpen],
    [t("toolbar.save"), actions.onSave],
    [t("toolbar.saveAs"), actions.onSaveAs],
  ];

  for (const [label, handler] of buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", () => void handler());
    host.appendChild(btn);
  }

  const spacer = document.createElement("div");
  spacer.className = "spacer";
  host.appendChild(spacer);
}

export function wireToolbar(act: ToolbarActions): void {
  actions = act;
  renderToolbar();
  // Re-render labels when the UI language changes.
  onLangChange(() => renderToolbar());
}
