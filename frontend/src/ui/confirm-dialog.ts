import { t } from "../lib/i18n";

export type UnsavedDecision = "save" | "discard" | "cancel";
let activeConfirmation = false;

/** Only one confirmation may own focus; background controls are inert. */
export function confirmUnsavedChanges(fileName: string): Promise<UnsavedDecision> {
  return confirm({
    title: t("unsaved.title"),
    message: t("unsaved.message").replace("{name}", fileName),
    hint: t("unsaved.hint"),
    accept: t("unsaved.save"),
    discard: true,
  });
}

export async function confirmNormalizeLineEndings(): Promise<boolean> {
  return (await confirm({
    title: t("format.normalizeTitle"),
    message: t("format.normalizeMessage"),
    hint: t("format.normalizeHint"),
    accept: t("format.normalizeLF"),
    discard: false,
  })) === "save";
}

/**
 * Whole-window close guard. The backend cancels the native close and asks the
 * frontend to resolve every dirty tab; saving is all-or-nothing, while discard
 * closes immediately.
 */
export function confirmCloseSession(fileNames: string[]): Promise<UnsavedDecision> {
  const names = fileNames.join(", ");
  return confirm({
    title: t("close.title"),
    message: t("close.message").replace("{names}", names),
    hint: t("close.hint"),
    accept: t("close.saveAll"),
    discard: true,
  });
}

function confirm(options: {
  title: string;
  message: string;
  hint: string;
  accept: string;
  discard: boolean;
}): Promise<UnsavedDecision> {
  if (activeConfirmation) return Promise.resolve("cancel");
  activeConfirmation = true;
  const previousFocus = document.activeElement as HTMLElement | null;
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
    title.textContent = options.title;
    const message = document.createElement("p");
    message.id = "ce-confirm-message";
    message.textContent = options.message;
    const hint = document.createElement("p");
    hint.className = "ce-confirm-hint";
    hint.textContent = options.hint;
    copy.append(title, message, hint);
    body.append(icon, copy);

    const foot = document.createElement("div");
    foot.className = "ce-modal-foot ce-confirm-actions";
    const discard = makeButton(t("unsaved.discard"), "ce-danger-text");
    discard.dataset.decision = "discard";
    const spacer = document.createElement("div");
    spacer.className = "ce-spacer";
    const cancel = makeButton(t("unsaved.cancel"));
    const save = makeButton(options.accept, "ce-primary");
    cancel.dataset.decision = "cancel";
    save.dataset.decision = "save";
    if (options.discard) foot.append(discard);
    foot.append(spacer, cancel, save);
    card.append(body, foot);
    overlay.appendChild(card);

    const background = [...document.body.children]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .map((element) => ({ element, inert: element.inert }));
    for (const { element } of background) element.inert = true;
    document.body.appendChild(overlay);
    let finished = false;
    const finish = (decision: UnsavedDecision) => {
      if (finished) return;
      finished = true;
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", keepFocus, true);
      overlay.remove();
      for (const { element, inert } of background) element.inert = inert;
      activeConfirmation = false;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(decision);
    };

    discard.addEventListener("click", () => finish("discard"));
    cancel.addEventListener("click", () => finish("cancel"));
    save.addEventListener("click", () => finish("save"));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish("cancel");
    });

    const focusable = options.discard ? [discard, cancel, save] : [cancel, save];
    const onKeyDown = (event: KeyboardEvent) => {
      // Do not let window-level editor/file handlers observe dialog keys.
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        finish("cancel");
      } else if (event.key === "Tab") {
        const current = focusable.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.shiftKey
          ? (current <= 0 ? focusable.length - 1 : current - 1)
          : (current + 1) % focusable.length;
        event.preventDefault();
        focusable[next].focus();
      }
    };
    const keepFocus = (event: FocusEvent) => {
      if (!card.contains(event.target as Node)) cancel.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", keepFocus, true);
    // Destructive format conversion must not be accepted by an accidental Enter.
    (options.discard ? save : cancel).focus();
  });
}

function makeButton(label: string, className = ""): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}
