/**
 * Top toolbar: New / Open / Save / Save As buttons + a language switcher
 * (`<select>`) on the right edge, mirroring the original CotEditor's
 * top-right syntax picker.
 *
 * Built with plain DOM (no framework, per PLAN §二). `wireToolbar` renders the
 * buttons and the language `<select>` once into `#toolbar` and binds handlers to
 * the supplied callbacks (which live in main.ts so they can drive file IO and
 * the model's language).
 *
 * Button labels are i18n-driven and re-render on language switch via
 * `renderToolbar`, keeping the stored callbacks intact.
 */

import { t, onLangChange } from "../lib/i18n";
import { SUPPORTED_SYNTAXES } from "../editor/language-config";

export interface ToolbarActions {
  onNew: () => void | Promise<void>;
  onOpen: () => void | Promise<void>;
  onSave: () => void | Promise<unknown>;
  onSaveAs: () => void | Promise<unknown>;
  /** Apply a manual language override; `null` resets to plaintext. */
  onSyntaxChange: (syntax: string | null) => void;
  /** Read the active syntax name (or null for plaintext), to echo in the select. */
  currentSyntax: () => string | null;
}

/** The actions bound at `wireToolbar` time, retained for re-rendering. */
let actions: ToolbarActions | null = null;

/** Re-render the toolbar buttons + language select using the current language. */
export function renderToolbar(): void {
  const host = document.getElementById("toolbar");
  if (!host || !actions) return;
  host.innerHTML = "";

  const buttons: Array<{
    command: string;
    label: string;
    shortcut: string;
    icon: string;
    handler: () => void | Promise<unknown>;
  }> = [
    { command: "new", label: t("toolbar.new"), shortcut: "Ctrl+N", icon: "new", handler: actions.onNew },
    { command: "open", label: t("toolbar.open"), shortcut: "Ctrl+O", icon: "open", handler: actions.onOpen },
    { command: "save", label: t("toolbar.save"), shortcut: "Ctrl+S", icon: "save", handler: actions.onSave },
    { command: "save-as", label: t("toolbar.saveAs"), shortcut: "Ctrl+Shift+S", icon: "saveAs", handler: actions.onSaveAs },
  ];

  for (const { command, label, shortcut, icon, handler } of buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toolbar-button";
    btn.dataset.command = command;
    btn.title = `${label} (${shortcut})`;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = `${toolbarIcon(icon)}<span class="toolbar-label"></span>`;
    btn.querySelector<HTMLElement>(".toolbar-label")!.textContent = label;
    btn.addEventListener("click", () => void handler());
    host.appendChild(btn);
  }

  const spacer = document.createElement("div");
  spacer.className = "spacer";
  host.appendChild(spacer);

  // Language switcher on the right edge. A native <select> keeps the
  // implementation small and is keyboard/screen-reader friendly; the
  // highlight engines re-tint automatically on model language change.
  const syntaxWrap = document.createElement("label");
  syntaxWrap.className = "toolbar-syntax";
  const syntaxLabel = document.createElement("span");
  syntaxLabel.textContent = t("menu.syntax");

  const select = document.createElement("select");
  select.className = "toolbar-lang";
  select.title = t("menu.syntax");
  select.setAttribute("aria-label", t("menu.syntax"));

  const plain = document.createElement("option");
  plain.value = "";
  plain.textContent = t("syntax.plainText");
  select.appendChild(plain);

  for (const syntax of SUPPORTED_SYNTAXES) {
    const opt = document.createElement("option");
    opt.value = syntax;
    opt.textContent = syntax;
    select.appendChild(opt);
  }

  select.value = actions.currentSyntax() ?? "";
  select.addEventListener("change", () => {
    const v = select.value;
    actions!.onSyntaxChange(v ? v : null);
  });
  syntaxWrap.append(syntaxLabel, select);
  host.appendChild(syntaxWrap);
}

export function wireToolbar(act: ToolbarActions): void {
  actions = act;
  renderToolbar();
  // Re-render labels when the UI language changes.
  onLangChange(() => renderToolbar());
}

function toolbarIcon(name: string): string {
  const paths: Record<string, string> = {
    new: '<path d="M5 2.75h6l3 3V15.25H5z"/><path d="M11 2.75v3h3M9.5 8v4M7.5 10h4"/>',
    open: '<path d="M2.75 5.5h5l1.4 1.5h6.1l-1.8 6.25H3.8z"/><path d="M3.5 5.5V3.75h4l1.3 1.5h4.7V7"/>',
    save: '<path d="M3 2.75h10.5l1.5 1.5v11H3z"/><path d="M5.25 2.75v4h7v-4M5.5 15.25v-5.5h7v5.5"/>',
    saveAs: '<path d="M2.75 2.75h9.5l1.5 1.5v5.5M5 2.75v4h6.5v-4M5.25 14.75v-5h5"/><path d="M10.5 13.75l3.9-3.9 1.25 1.25-3.9 3.9-1.75.5z"/>',
  };
  return `<svg class="toolbar-icon" viewBox="0 0 18 18" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}
