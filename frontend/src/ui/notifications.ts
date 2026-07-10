import { t } from "../lib/i18n";

export type ToastKind = "info" | "error";

/** Surface recoverable file errors without blocking the editor. */
export function showToast(message: string, kind: ToastKind = "info", timeout = 5000): void {
  let host = document.querySelector<HTMLDivElement>(".ce-toast-region");
  if (!host) {
    host = document.createElement("div");
    host.className = "ce-toast-region";
    host.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
    host.setAttribute("aria-atomic", "false");
    document.body.appendChild(host);
  }

  const toast = document.createElement("div");
  toast.className = `ce-toast ce-toast-${kind}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");

  const mark = document.createElement("span");
  mark.className = "ce-toast-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = kind === "error" ? "!" : "i";

  const copy = document.createElement("span");
  copy.className = "ce-toast-copy";
  copy.textContent = message;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "ce-toast-close";
  close.setAttribute("aria-label", t("common.close"));
  close.textContent = "×";

  const remove = () => {
    toast.classList.add("ce-toast-leave");
    window.setTimeout(() => {
      toast.remove();
      if (host && host.childElementCount === 0) host.remove();
    }, 140);
  };
  close.addEventListener("click", remove);
  toast.append(mark, copy, close);
  host.appendChild(toast);
  window.setTimeout(remove, timeout);
}
