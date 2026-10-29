/**
 * Encoding picker (phase B/F2).
 *
 * One focusable trigger opens a menu with the five encodings the backend can
 * read/write losslessly. Each encoding offers two deliberately separate
 * actions:
 *
 *   "reopen"  reinterpret the file bytes with this encoding (reload)
 *   "save"    transcode the editor buffer and save it with this encoding
 *
 * Missing callbacks disable their action; with neither callback the trigger
 * itself is disabled. This keeps the menu honest in the browser fallback or
 * before `main.ts` wires the native bridge.
 *
 * Keyboard: Enter/Space/ArrowDown opens, Arrow keys/Home/End move, Enter or
 * Space activates, Escape closes and restores the trigger, Tab closes.
 *
 * Wiring notes for `main.ts` (phase F2):
 *  - place the trigger in the statusbar (replacing the passive encoding span):
 *    `createEncodingMenu({ host: encodingSlot, current: document.encoding,
 *      reopen: (encoding) => manager.reopenWithEncoding(id, encoding),
 *      save: (encoding) => manager.saveWithEncoding(id, encoding) })`
 *  - `setEncoding()` on every active-document change, `setHandlers()` if the
 *    native bridge becomes available after boot, `destroy()` on teardown.
 */

import "./encoding-menu.css";
import { getLang, type Lang } from "../lib/i18n";

export const ENCODING_CHOICES = [
  "UTF-8",
  "UTF-8 BOM",
  "UTF-16LE",
  "UTF-16BE",
  "GB18030",
] as const;

export type EncodingChoice = (typeof ENCODING_CHOICES)[number];
export type EncodingAction = "reopen" | "save";

export interface EncodingMenuHandlers {
  reopen?: (encoding: EncodingChoice) => void;
  save?: (encoding: EncodingChoice) => void;
}

export interface EncodingMenuOptions extends EncodingMenuHandlers {
  /** Container for the trigger. Defaults to `document.body`. */
  host?: HTMLElement;
  /** Displayed encoding (case-insensitive match against the choices). */
  current?: string;
  lang?: Lang;
  /** Override the accessible trigger label. */
  label?: string;
  align?: "left" | "right";
  /** Force the whole control off (e.g. read-only unsupported document). */
  disabled?: boolean;
}

export interface EncodingMenuApi {
  readonly root: HTMLElement;
  readonly trigger: HTMLButtonElement;
  readonly menu: HTMLElement;
  open(): void;
  close(restoreFocus?: boolean): void;
  toggle(): void;
  isOpen(): boolean;
  getEncoding(): string;
  setEncoding(encoding: string): void;
  setHandlers(handlers: EncodingMenuHandlers): void;
  setEnabled(enabled: boolean): void;
  destroy(): void;
}

interface Labels {
  encoding: string;
  reopen: string;
  save: string;
  current: string;
  unavailable: string;
}

function labelsFor(lang: Lang): Labels {
  if (lang === "zh") {
    return {
      encoding: "编码",
      reopen: "重新以该编码打开",
      save: "以该编码保存",
      current: "当前",
      unavailable: "编码操作尚不可用",
    };
  }
  return {
    encoding: "Encoding",
    reopen: "Reopen with this encoding",
    save: "Save with this encoding",
    current: "current",
    unavailable: "Encoding actions are not available yet",
  };
}

interface MenuItem {
  button: HTMLButtonElement;
  encoding: EncodingChoice;
  action: EncodingAction;
}

let activeMenu: EncodingMenu | null = null;
let menuSerial = 0;

class EncodingMenu implements EncodingMenuApi {
  readonly root: HTMLElement;
  readonly trigger: HTMLButtonElement;
  readonly menu: HTMLElement;

  private readonly labels: Labels;
  private readonly triggerId: string;
  private readonly menuId: string;
  private readonly align: "left" | "right";
  private readonly labelOverride?: string;
  private handlers: EncodingMenuHandlers;
  private encoding: string;
  private forcedEnabled: boolean;
  private items: MenuItem[] = [];
  private openFlag = false;
  private destroyed = false;

  constructor(options: EncodingMenuOptions) {
    this.labels = labelsFor(options.lang ?? getLang());
    this.handlers = { reopen: options.reopen, save: options.save };
    this.encoding = options.current ?? "UTF-8";
    this.forcedEnabled = options.disabled !== true;
    this.align = options.align ?? "left";
    this.labelOverride = options.label;

    menuSerial += 1;
    this.triggerId = `ce-encoding-trigger-${menuSerial}`;
    this.menuId = `ce-encoding-menu-${menuSerial}`;

    this.root = document.createElement("div");
    this.root.className = "ce-encoding-root";
    this.root.dataset.encodingMenu = "true";

    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "ce-encoding-trigger";
    this.trigger.id = this.triggerId;
    this.trigger.setAttribute("aria-haspopup", "menu");
    this.trigger.setAttribute("aria-expanded", "false");
    this.trigger.setAttribute("aria-controls", this.menuId);

    this.menu = document.createElement("div");
    this.menu.className = "ce-encoding-menu";
    this.menu.id = this.menuId;
    this.menu.setAttribute("role", "menu");
    this.menu.setAttribute("aria-labelledby", this.triggerId);
    this.menu.dataset.align = this.align;
    this.menu.hidden = true;

    this.root.append(this.trigger, this.menu);
    (options.host ?? document.body).append(this.root);

    this.trigger.addEventListener("click", (event) => {
      event.preventDefault();
      this.toggle();
    });
    this.trigger.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.open();
        const enabled = this.enabledItems();
        if (enabled.length > 0) {
          const target = event.key === "ArrowUp"
            ? enabled[enabled.length - 1]
            : enabled[0];
          target.focus({ preventScroll: true });
        }
      }
    });
    this.menu.addEventListener("keydown", (event) => this.onMenuKeyDown(event));

    this.rebuild();
    this.updateTrigger();
  }

  open(): void {
    if (this.destroyed || this.trigger.disabled || this.openFlag) return;
    if (activeMenu && activeMenu !== this) activeMenu.close(false);
    activeMenu = this;
    this.rebuild();
    this.openFlag = true;
    this.menu.hidden = false;
    this.trigger.setAttribute("aria-expanded", "true");
    this.root.classList.add("is-open");
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    document.addEventListener("keydown", this.onDocumentKeyDown, true);
    const enabled = this.enabledItems();
    if (enabled.length > 0) enabled[0].focus({ preventScroll: true });
  }

  close(restoreFocus = true): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.menu.hidden = true;
    this.trigger.setAttribute("aria-expanded", "false");
    this.root.classList.remove("is-open");
    document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    document.removeEventListener("keydown", this.onDocumentKeyDown, true);
    if (activeMenu === this) activeMenu = null;
    if (restoreFocus && !this.destroyed) {
      this.trigger.focus({ preventScroll: true });
    }
  }

  toggle(): void {
    if (this.openFlag) this.close(true);
    else this.open();
  }

  isOpen(): boolean {
    return this.openFlag;
  }

  getEncoding(): string {
    return this.encoding;
  }

  setEncoding(encoding: string): void {
    this.encoding = encoding || "UTF-8";
    this.updateTrigger();
    if (this.openFlag) this.rebuild();
  }

  setHandlers(handlers: EncodingMenuHandlers): void {
    this.handlers = { reopen: handlers.reopen, save: handlers.save };
    this.updateTrigger();
    if (this.trigger.disabled) this.close(false);
    else if (this.openFlag) this.rebuild();
  }

  setEnabled(enabled: boolean): void {
    this.forcedEnabled = enabled;
    this.updateTrigger();
    if (this.trigger.disabled) this.close(false);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.close(false);
    this.destroyed = true;
    this.root.remove();
    if (activeMenu === this) activeMenu = null;
  }

  private available(): boolean {
    return this.forcedEnabled && Boolean(this.handlers.reopen || this.handlers.save);
  }

  private updateTrigger(): void {
    const available = this.available();
    this.trigger.disabled = !available;
    this.trigger.setAttribute("aria-disabled", String(!available));
    this.trigger.textContent = this.encoding;
    const label = this.labelOverride
      ?? `${this.labels.encoding}: ${this.encoding}`;
    this.trigger.setAttribute("aria-label", label);
    this.trigger.title = available
      ? `${this.labels.encoding}: ${this.encoding}`
      : `${this.labels.unavailable} (${this.labels.encoding}: ${this.encoding})`;
    this.root.dataset.enabled = String(available);
    this.root.dataset.current = this.encoding;
  }

  private rebuild(): void {
    this.menu.replaceChildren();
    this.items = [];
    const currentChoice = this.currentChoice();

    for (const encoding of ENCODING_CHOICES) {
      const isCurrent = currentChoice === encoding;
      const group = document.createElement("div");
      group.className = "ce-encoding-group";
      group.setAttribute("role", "group");
      group.setAttribute(
        "aria-label",
        isCurrent ? `${encoding} (${this.labels.current})` : encoding,
      );
      if (isCurrent) group.dataset.current = "true";

      const label = document.createElement("div");
      label.className = "ce-encoding-group-label";
      label.textContent = encoding;
      group.append(label);

      for (const action of ["reopen", "save"] as const) {
        const handler = this.handlers[action];
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ce-encoding-item";
        button.dataset.action = action;
        button.dataset.encoding = encoding;
        button.setAttribute("role", "menuitem");
        const actionLabel = action === "reopen"
          ? this.labels.reopen
          : this.labels.save;
        button.textContent = actionLabel;
        button.setAttribute("aria-label", `${encoding}: ${actionLabel}`);
        button.disabled = !handler;
        button.setAttribute("aria-disabled", String(!handler));
        button.tabIndex = -1;
        button.addEventListener("click", () => this.choose(action, encoding));
        group.append(button);
        this.items.push({ button, encoding, action });
      }
      this.menu.append(group);
    }
  }

  private currentChoice(): EncodingChoice | null {
    const wanted = this.encoding.trim().toLowerCase();
    for (const choice of ENCODING_CHOICES) {
      if (choice.toLowerCase() === wanted) return choice;
    }
    return null;
  }

  private enabledItems(): HTMLButtonElement[] {
    return this.items
      .filter((item) => !item.button.disabled)
      .map((item) => item.button);
  }

  private choose(action: EncodingAction, encoding: EncodingChoice): void {
    const handler = this.handlers[action];
    if (!handler) return;
    this.close(true);
    try {
      handler(encoding);
    } catch (error) {
      console.warn("encoding-menu: action handler failed", error);
    }
  }

  private onMenuKeyDown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    const buttons = this.enabledItems();
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % buttons.length;
    else if (event.key === "ArrowUp") next = current <= 0 ? buttons.length - 1 : current - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    if (next < 0) return;
    event.preventDefault();
    event.stopPropagation();
    buttons[next].focus({ preventScroll: true });
  }

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (target && this.root.contains(target)) return;
    this.close(false);
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (!this.openFlag) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
    } else if (event.key === "Tab") {
      // The menu is not a modal; Tab leaves it and returns focus to the trigger.
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
    }
  };
}

/** Create the encoding trigger/menu; the caller inserts `api.root`. */
export function createEncodingMenu(options: EncodingMenuOptions): EncodingMenuApi {
  return new EncodingMenu(options);
}
