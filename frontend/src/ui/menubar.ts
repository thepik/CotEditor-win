/** Plain-DOM application menus, with editor commands and keyboard navigation. */

import { getEditor } from "../editor/monaco-setup";
import { getLang } from "../lib/i18n";
import { showToast } from "./notifications";

export interface MenuAction {
  /** Stable id, also used for Monaco lookup if no action or callback is given. */
  id?: string;
  /** Monaco action (or the undo/redo command) to execute. */
  monacoAction?: string;
  label: string;
  shortcut?: string;
  /** Direct callback takes precedence over Monaco commands/actions. */
  run?: () => void | Promise<void>;
  disabled?: boolean;
  /** Supplying either true or false makes this a checkable menu item. */
  checked?: boolean;
  /** Nested items rendered as a flyout submenu. */
  submenu?: MenuItem[];
}

export interface MenuSeparator {
  sep: true;
}

export type MenuItem = MenuAction | MenuSeparator;

export interface Menu {
  label: string;
  items: MenuItem[];
  /** Rebuild live state (e.g. theme checkmarks) whenever the menu opens. */
  buildItems?: () => MenuItem[];
}

export type MenuBar = Menu[];

function isSeparator(i: MenuItem): i is MenuSeparator {
  return (i as MenuSeparator).sep === true;
}

/** Existing panels do not all have dialog roles yet, so include their class. */
function modalIsOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>(
    '.ce-modal, dialog[open], [aria-modal="true"]',
  )].some((element) => element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden" &&
    !element.closest('[hidden], [aria-hidden="true"]'));
}

/** Commands such as undo/redo are not returned by Monaco's getAction(). */
async function runAction(action: MenuAction): Promise<void> {
  if (action.disabled || modalIsOpen()) return;
  try {
    if (action.run) {
      await action.run();
      return;
    }
    const editor = getEditor();
    const id = action.monacoAction ?? action.id;
    if (!editor || !id) throw new Error("No editor or action id");
    // Restore the editor context before checking an action's precondition.
    editor.focus();
    if (id === "undo" || id === "redo") {
      if (!editor.getModel()) throw new Error("No active document");
      editor.trigger("menubar", id, null);
      return;
    }
    const editorAction = editor.getAction(id);
    if (!editorAction?.isSupported()) throw new Error(`Unsupported action: ${id}`);
    await editorAction.run();
  } catch (error) {
    console.warn(`Menu action failed: ${action.monacoAction ?? action.id ?? action.label}`, error);
    // Do not silently claim success for missing/unsupported actions. Keep this
    // message local until the shared translation catalogue gains a menu key.
    showToast(getLang() === "zh"
      ? `无法执行“${action.label}”：此操作不可用或执行失败。`
      : `Could not run “${action.label}”: the action is unavailable or failed.`, "error");
  }
}

let host: HTMLElement | null = null;
let entries: Array<{ item: HTMLElement; menu: Menu }> = [];
let openItem: HTMLElement | null = null;
let rovingItem: HTMLElement | null = null;
let menuActive = false;
let sourceFocus: HTMLElement | null = null;
let sourceWasEditor = false;
let globalListenersInstalled = false;
let altPending = false;

/** Currently open flyout submenu, if any (at most one at a time). */
let openSub: { button: HTMLButtonElement; dropdown: HTMLElement } | null = null;
/** The action behind each rendered menu button, for keyboard submenu opening. */
const buttonActions = new WeakMap<HTMLButtonElement, MenuAction>();

function rememberSource(source: EventTarget | null = document.activeElement): void {
  if (menuActive) return;
  menuActive = true;
  sourceFocus = source instanceof HTMLElement && !host?.contains(source) ? source : null;
  sourceWasEditor = !!sourceFocus && !!getEditor()?.getDomNode()?.contains(sourceFocus);
}

function setRovingItem(item: HTMLElement): void {
  rovingItem = item;
  for (const entry of entries) entry.item.tabIndex = entry.item === item ? 0 : -1;
}

function closeSubmenu(): void {
  if (!openSub) return;
  openSub.button.setAttribute("aria-expanded", "false");
  openSub.dropdown.remove();
  openSub = null;
}

function closeDropdown(): void {
  if (!openItem) return;
  closeSubmenu();
  openItem.classList.remove("open");
  openItem.setAttribute("aria-expanded", "false");
  openItem.removeAttribute("aria-controls");
  openItem.querySelector(".ce-menu-dropdown")?.remove();
  openItem = null;
  if (rovingItem) setRovingItem(rovingItem);
}

/** Dismiss menu mode; actions close before running so dialogs retain focus. */
export function closeMenu(restoreFocus = true): void {
  const wasActive = menuActive;
  const source = sourceFocus;
  const editorSource = sourceWasEditor;
  closeDropdown();
  menuActive = false;
  sourceFocus = null;
  sourceWasEditor = false;
  if (!restoreFocus || !wasActive || modalIsOpen()) return;
  if (editorSource) getEditor()?.focus();
  else if (source?.isConnected && source !== document.body) source.focus();
  else getEditor()?.focus();
}

function moveMenu(item: HTMLElement, position: number, open: boolean): void {
  const index = entries.findIndex((entry) => entry.item === item);
  const next = entries[(index + position + entries.length) % entries.length];
  if (!next) return;
  if (open) openDropdown(next.item, next.menu);
  else {
    setRovingItem(next.item);
    next.item.focus();
  }
}

function toggleMenuMode(): void {
  if (menuActive) {
    closeMenu();
    return;
  }
  if (!entries.length) return;
  rememberSource();
  const item = rovingItem ?? entries[0].item;
  setRovingItem(item);
  item.focus();
}

function installGlobalListeners(): void {
  if (globalListenersInstalled) return;
  globalListenersInstalled = true;
  // Capture pointer focus before the browser transfers it to a menu element.
  document.addEventListener("pointerdown", (event) => {
    altPending = false;
    if (modalIsOpen()) {
      closeMenu(false);
      return;
    }
    if (event.target instanceof Node && host?.contains(event.target)) rememberSource();
    else closeMenu(); // The pointer's default action may then focus its target.
  }, true);
  document.addEventListener("focusin", (event) => {
    if (event.target instanceof Node && host?.contains(event.target)) {
      rememberSource(event.relatedTarget);
    } else if (menuActive) closeMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (modalIsOpen()) {
      altPending = false;
      closeMenu(false);
      return; // In particular, leave Escape/Tab to the modal's own handler.
    }
    if (event.key === "Alt") {
      if (!event.repeat) altPending = !event.ctrlKey && !event.metaKey && !event.shiftKey && event.location !== 2;
      return;
    }
    altPending = false; // Alt+letter and AltGr shortcuts must not enter menus.
    if (event.key === "F10" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleMenuMode();
    } else if (event.key === "Escape" && menuActive) {
      event.preventDefault();
      event.stopPropagation();
      // Escape unwinds one level: an open flyout first, then the menu itself.
      if (openSub) {
        const owner = openSub.button;
        closeSubmenu();
        owner.focus();
      } else {
        closeMenu();
      }
    } else if (event.key === "Tab" && menuActive) {
      // Collapse onto the top-level tab stop, then allow normal Tab traversal
      // out of the menubar (rather than trapping Tab inside the dropdown).
      rovingItem?.focus();
      closeMenu(false);
    }
  }, true);
  document.addEventListener("keyup", (event) => {
    if (event.key !== "Alt") return;
    const activate = altPending;
    altPending = false;
    if (!activate || modalIsOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    toggleMenuMode();
  }, true);
  window.addEventListener("blur", () => {
    altPending = false;
    closeMenu(false);
  });
}

/** Render/re-render the bar, preserving no references to detached menu nodes. */
export function renderMenuBar(menus: MenuBar): void {
  const element = document.getElementById("menubar");
  if (!element) return;
  closeMenu();
  host = element;
  host.replaceChildren();
  host.setAttribute("role", "menubar");
  host.setAttribute("aria-label", getLang() === "zh" ? "应用程序菜单" : "Application menu");
  host.setAttribute("aria-orientation", "horizontal");
  entries = [];
  rovingItem = null;

  menus.forEach((menu, index) => {
    const item = document.createElement("div");
    item.className = "ce-menu-item";
    item.id = `ce-menu-${index}`;
    item.tabIndex = index === 0 ? 0 : -1;
    item.textContent = menu.label;
    item.setAttribute("role", "menuitem");
    item.setAttribute("aria-haspopup", "menu");
    item.setAttribute("aria-expanded", "false");
    item.addEventListener("focus", () => setRovingItem(item));
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      if (modalIsOpen()) return;
      if (openItem === item) closeMenu();
      else openDropdown(item, menu);
    });
    item.addEventListener("mouseenter", () => {
      if (!modalIsOpen() && openItem && openItem !== item) openDropdown(item, menu);
    });
    item.addEventListener("keydown", (event) => {
      if (event.target !== item || modalIsOpen()) return;
      const key = event.key;
      if (!["Enter", " ", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (key === "ArrowLeft" || key === "ArrowRight") {
        moveMenu(item, key === "ArrowRight" ? 1 : -1, !!openItem);
      } else if (key === "Home" || key === "End") {
        moveMenu(item, (key === "Home" ? 0 : entries.length - 1) - index, !!openItem);
      } else openDropdown(item, menu, key === "ArrowUp");
    });
    entries.push({ item, menu });
    host!.appendChild(item);
  });
  if (entries.length) rovingItem = entries[0].item;
  installGlobalListeners();
}

/**
 * Render one dropdown level. Returns the enabled buttons (the only ones that
 * participate in arrow navigation). Submenu items render a flyout on hover,
 * click or ArrowRight.
 */
function buildMenuItems(dropdown: HTMLElement, items: MenuItem[]): HTMLButtonElement[] {
  const rendered: HTMLButtonElement[] = [];
  for (const action of items) {
    if (isSeparator(action)) {
      const separator = document.createElement("div");
      separator.className = "ce-menu-sep";
      separator.setAttribute("role", "separator");
      dropdown.appendChild(separator);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = !!action.disabled;
    button.tabIndex = -1;
    button.setAttribute("role", action.checked === undefined ? "menuitem" : "menuitemcheckbox");
    if (action.checked !== undefined) button.setAttribute("aria-checked", String(action.checked));
    if (action.disabled) button.setAttribute("aria-disabled", "true");
    if (action.id ?? action.monacoAction) button.dataset.menuAction = action.id ?? action.monacoAction;
    buttonActions.set(button, action);
    const label = document.createElement("span");
    label.className = "ce-menu-label";
    if (action.checked) {
      const check = document.createElement("span");
      check.className = "ce-menu-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "\u2713";
      label.appendChild(check);
    }
    label.append(action.label);
    button.appendChild(label);
    if (action.shortcut) {
      const shortcut = document.createElement("span");
      shortcut.className = "ce-menu-shortcut";
      shortcut.textContent = action.shortcut;
      button.appendChild(shortcut);
    }
    if (action.submenu) {
      button.dataset.submenu = "true";
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      const arrow = document.createElement("span");
      arrow.className = "ce-menu-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "\u203A";
      button.appendChild(arrow);
    }
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (modalIsOpen()) return;
      if (action.submenu) {
        // A hover may already have opened it; keep it open instead of toggling.
        openSubmenu(button, action);
        return;
      }
      closeMenu();
      void runAction(action);
    });
    if (action.submenu) {
      button.addEventListener("mouseenter", () => openSubmenu(button, action));
    }
    rendered.push(button);
    dropdown.appendChild(button);
  }
  const enabled = rendered.filter((button) => !button.disabled);
  for (const button of enabled) {
    button.addEventListener("focus", () => {
      for (const entry of entries) entry.item.tabIndex = -1;
      for (const sibling of enabled) sibling.tabIndex = sibling === button ? 0 : -1;
    });
  }
  return enabled;
}

function openSubmenu(
  button: HTMLButtonElement,
  action: MenuAction,
): HTMLButtonElement[] {
  if (openSub?.button === button) {
    return [...openSub.dropdown.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  }
  closeSubmenu();
  const submenu = document.createElement("div");
  submenu.className = "ce-menu-dropdown ce-submenu";
  submenu.setAttribute("role", "menu");
  submenu.setAttribute("aria-label", action.label);
  const buttons = buildMenuItems(submenu, action.submenu ?? []);
  button.setAttribute("aria-expanded", "true");
  button.appendChild(submenu);
  if (submenu.getBoundingClientRect().right > window.innerWidth - 4) {
    submenu.classList.add("align-right");
  }
  openSub = { button, dropdown: submenu };
  submenu.addEventListener("keydown", (event) => {
    handleSubmenuKey(event, buttons, button);
  });
  return buttons;
}

function handleSubmenuKey(
  event: KeyboardEvent,
  buttons: HTMLButtonElement[],
  owner: HTMLButtonElement,
): void {
  if (modalIsOpen()) return;
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  let next = index;
  switch (event.key) {
    case "ArrowDown": next = (index + 1) % buttons.length; break;
    case "ArrowUp": next = (index - 1 + buttons.length) % buttons.length; break;
    case "Home": next = 0; break;
    case "End": next = buttons.length - 1; break;
    case "Enter": case " ":
      if (!event.repeat) buttons[index]?.click();
      break;
    case "ArrowLeft": case "Escape":
      event.preventDefault();
      event.stopPropagation();
      closeSubmenu();
      owner.focus();
      return;
    default: return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (next >= 0 && next !== index) buttons[next]?.focus();
}

function openDropdown(item: HTMLElement, menu: Menu, focusLast = false): void {
  if (modalIsOpen()) return;
  rememberSource();
  // Focus a connected node before removing the old dropdown's focused button.
  setRovingItem(item);
  item.focus();
  closeDropdown();
  const items = menu.buildItems ? menu.buildItems() : menu.items;
  const dropdown = document.createElement("div");
  dropdown.className = "ce-menu-dropdown";
  dropdown.id = `${item.id}-dropdown`;
  dropdown.setAttribute("role", "menu");
  dropdown.setAttribute("aria-labelledby", item.id);

  const buttons = buildMenuItems(dropdown, items);

  openItem = item;
  item.classList.add("open");
  item.setAttribute("aria-expanded", "true");
  item.setAttribute("aria-controls", dropdown.id);
  item.appendChild(dropdown);
  if (dropdown.getBoundingClientRect().right > window.innerWidth - 4) dropdown.classList.add("align-right");

  dropdown.addEventListener("keydown", (event) => {
    if (modalIsOpen()) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = index;
    switch (event.key) {
      case "ArrowDown":
        closeSubmenu();
        next = (index + 1) % buttons.length;
        break;
      case "ArrowUp":
        closeSubmenu();
        next = (index - 1 + buttons.length) % buttons.length;
        break;
      case "Home": next = 0; break;
      case "End": next = buttons.length - 1; break;
      case "ArrowLeft":
        if (openSub) closeSubmenu();
        else moveMenu(item, -1, true);
        break;
      case "ArrowRight": {
        const action = buttons[index] ? buttonActions.get(buttons[index]) : undefined;
        if (action?.submenu && buttons[index]) {
          const subButtons = openSubmenu(buttons[index], action);
          if (subButtons[0]) {
            next = -1;
            subButtons[0].focus();
          }
        } else {
          moveMenu(item, 1, true);
        }
        break;
      }
      case "Enter": case " ":
        // Suppress the button's native activation, which preventDefault below
        // also blocks; a held key must not run the command repeatedly.
        if (!event.repeat) buttons[index]?.click();
        break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (openItem === item && next !== index) buttons[next]?.focus();
  });
  buttons[focusLast ? buttons.length - 1 : 0]?.focus();
}
