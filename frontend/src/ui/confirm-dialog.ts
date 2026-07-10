import { t } from "../lib/i18n";

export type UnsavedDecision = "save" | "discard" | "cancel";

/**
 * Show a focused, keyboard-safe confirmation before replacing an unsaved
 * buffer. Native window closing has a matching guard in Go; this dialog covers
 * in-app New/Open actions where a richer three-way choice is possible.
 */
export function confirmUnsavedChanges(fileName: string): Promise<UnsavedDecision> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ce-modal ce-confirm";
    overlay.setAttribute("role", "presentation");

    const card = document.createElement("div");
    card.className = "ce-modal-card ce-confirm-card";
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "ce-confirm-title");
    card.setAttribute("aria-describedby", "ce-confirm-message");

    const body = document.createElement("div");
    body.className = "ce-confirm-body";

    const icon = document.createElement("div");
    icon.className = "ce-confirm-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "!";

    const copy = document.createElement("div");
    copy.className = "ce-confirm-copy";
    const title = document.createElement("h2");
    title.id = "ce-confirm-title";
    title.textContent = t("unsaved.title");
    const message = document.createElement("p");
    message.id = "ce-confirm-message";
    message.textContent = t("unsaved.message").replace("{name}", fileName);
    const hint = document.createElement("p");
    hint.className = "ce-confirm-hint";
    hint.textContent = t("unsaved.hint");
    copy.append(title, message, hint);
    body.append(icon, copy);

    const foot = document.createElement("div");
    foot.className = "ce-modal-foot ce-confirm-actions";

    const discard = makeButton(t("unsaved.discard"), "ce-danger-text");
    discard.dataset.decision = "discard";
    const spacer = document.createElement("div");
    spacer.className = "ce-spacer";
    const cancel = makeButton(t("unsaved.cancel"));
    const save = makeButton(t("unsaved.save"), "ce-primary");
    cancel.dataset.decision = "cancel";
    save.dataset.decision = "save";
    foot.append(discard, spacer, cancel, save);
    card.append(body, foot);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const finish = (decision: UnsavedDecision) => {
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve(decision);
    };

    discard.addEventListener("click", () => finish("discard"));
    cancel.addEventListener("click", () => finish("cancel"));
    save.addEventListener("click", () => finish("save"));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish("cancel");
    });

    const focusable = [discard, cancel, save];
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish("cancel");
        return;
      }
      if (event.key !== "Tab") return;
      const current = focusable.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.shiftKey
        ? (current <= 0 ? focusable.length - 1 : current - 1)
        : (current + 1) % focusable.length;
      event.preventDefault();
      focusable[next].focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    save.focus();
  });
}

function makeButton(label: string, className = ""): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}
