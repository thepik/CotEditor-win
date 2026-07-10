/**
 * Application menu bar (PLAN §阶段8).
 *
 * A lightweight, plain-DOM menu bar rendered above the toolbar. Each top-level
 * menu (File / Edit / View / Format / Find / Snippet / Help) opens a dropdown
 * of action items. Menu items dispatch to either a Monaco editor action id
 * (looked up via `editor.getAction(id)`) or a plain callback.
 *
 * Behaviour:
 *  - Click a top-level item to open its dropdown; click again (or click the
 *    same item) to close it.
 *  - Click outside, or press Escape, to dismiss.
 *  - Hovering a sibling top-level item while one is open switches focus.
 *
 * This is intentionally minimal — no accelerators drawn as native menu items —
 * because Monaco owns the editor shortcuts and the OS-level menu is not
 * available under Wails v2's system WebView.
 */

import { getEditor } from "../editor/monaco-setup";

export interface MenuAction {
  /** Stable id, used for Monaco action lookup if no `run` is given. */
  id?: string;
  /** Monaco action id to trigger (when `run` is not provided). */
  monacoAction?: string;
  /** Display label. */
  label: string;
  /** Optional keyboard shortcut hint shown on the right. */
  shortcut?: string;
  /** Direct callback (takes precedence over `monacoAction`). */
  run?: () => void;
  /** Disable the item (e.g. when no document is open). */
  disabled?: boolean;
  /** Render a check mark before the label (for toggles / radio-like items). */
  checked?: boolean;
}

export interface MenuSeparator {
  sep: true;
}

export type MenuItem = MenuAction | MenuSeparator;

export interface Menu {
  label: string;
  items: MenuItem[];
  /**
   * Optional lazy builder invoked each time the dropdown opens. When present
   * it replaces `items` for rendering that open. Used for menus whose contents
   * depend on live state (e.g. the active theme's checkmark).
   */
  buildItems?: () => MenuItem[];
}

/** The set of menus to render. */
export type MenuBar = Menu[];

function isSeparator(i: MenuItem): i is MenuSeparator {
  return (i as MenuSeparator).sep === true;
}

/** Run a menu action: prefer the explicit callback, else a Monaco action. */
function runAction(a: MenuAction): void {
  if (a.disabled) return;
  if (a.run) {
    a.run();
    return;
  }
  if (a.monacoAction) {
    getEditor()?.getAction(a.monacoAction)?.run();
  }
}

let openItem: HTMLElement | null = null;
let globalListenersInstalled = false;
/** Close whichever dropdown is currently open. */
export function closeMenu(): void {
  if (openItem) {
    openItem.classList.remove("open");
    openItem.setAttribute("aria-expanded", "false");
    const dd = openItem.querySelector(".ce-menu-dropdown");
    if (dd) dd.remove();
    openItem = null;
  }
}

/** Render the menu bar into `#menubar`. Called once at boot from main.ts. */
export function renderMenuBar(menus: MenuBar): void {
  const host = document.getElementById("menubar");
  if (!host) return;
  host.innerHTML = "";
  host.setAttribute("role", "menubar");
  host.setAttribute("aria-label", "Application menu");

  for (const menu of menus) {
    const item = document.createElement("div");
    item.className = "ce-menu-item";
    item.tabIndex = 0;
    item.textContent = menu.label;
    item.setAttribute("role", "menuitem");
    item.setAttribute("aria-haspopup", "menu");
    item.setAttribute("aria-expanded", "false");

    item.addEventListener("click", (e) => {
      e.stopPropagation();
      // Toggle: if this item is already open, close it.
      if (openItem === item) {
        closeMenu();
        return;
      }
      openDropdown(item, menu);
    });

    // Hover-switch when another menu is already open.
    item.addEventListener("mouseenter", () => {
      if (openItem && openItem !== item) {
        openDropdown(item, menu);
      }
    });

    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        openDropdown(item, menu, true);
        return;
      }
      if (e.key === "Escape") {
        closeMenu();
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const all = [...host.querySelectorAll<HTMLElement>(".ce-menu-item")];
      const index = all.indexOf(item);
      const offset = e.key === "ArrowRight" ? 1 : -1;
      all[(index + offset + all.length) % all.length]?.focus();
    });

    host.appendChild(item);
  }

  if (!globalListenersInstalled) {
    globalListenersInstalled = true;
    // Click anywhere outside dismisses the open dropdown.
    document.addEventListener("click", closeMenu);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMenu();
    });
  }
}

/** Open `menu`'s dropdown under the given top-level item element. */
function openDropdown(item: HTMLElement, menu: Menu, focusFirst = false): void {
  closeMenu();

  // Use the lazy builder when present so dynamic content (e.g. theme
  // checkmarks) reflects the current state on each open.
  const items = menu.buildItems ? menu.buildItems() : menu.items;

  const dd = document.createElement("div");
  dd.className = "ce-menu-dropdown";
  dd.setAttribute("role", "menu");

  for (const mi of items) {
    if (isSeparator(mi)) {
      const sep = document.createElement("div");
      sep.className = "ce-menu-sep";
      dd.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.disabled = !!mi.disabled;
    btn.setAttribute("role", "menuitem");
    btn.tabIndex = -1;

    const left = document.createElement("span");
    left.className = "ce-menu-label";
    if (mi.checked) {
      const chk = document.createElement("span");
      chk.className = "ce-menu-check";
      chk.textContent = "✓";
      left.appendChild(chk);
    }
    left.append(mi.label);
    btn.appendChild(left);

    if (mi.shortcut) {
      const sc = document.createElement("span");
      sc.className = "ce-menu-shortcut";
      sc.textContent = mi.shortcut;
      btn.appendChild(sc);
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      runAction(mi);
      closeMenu();
    });

    dd.appendChild(btn);
  }

  item.classList.add("open");
  item.setAttribute("aria-expanded", "true");
  item.appendChild(dd);
  openItem = item;

  // Keep menus usable near the right window edge and support conventional
  // arrow-key navigation inside the open dropdown.
  if (dd.getBoundingClientRect().right > window.innerWidth - 4) {
    dd.classList.add("align-right");
  }
  const buttons = [...dd.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  buttons.forEach((button, index) => {
    button.addEventListener("keydown", (event) => {
      let next = index;
      if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
      else if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = buttons.length - 1;
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        closeMenu();
        item.focus();
        item.dispatchEvent(new KeyboardEvent("keydown", { key: event.key }));
        return;
      } else return;
      event.preventDefault();
      buttons[next]?.focus();
    });
  });
  if (focusFirst) buttons[0]?.focus();
}
