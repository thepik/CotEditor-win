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
  onSave: () => void | Promise<void>;
  onSaveAs: () => void | Promise<void>;
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

  // Language switcher on the right edge. A native <select> keeps the
  // implementation small and is keyboard/screen-reader friendly; the
  // highlight engines re-tint automatically on model language change.
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
  host.appendChild(select);
}

export function wireToolbar(act: ToolbarActions): void {
  actions = act;
  renderToolbar();
  // Re-render labels when the UI language changes.
  onLangChange(() => renderToolbar());
}
