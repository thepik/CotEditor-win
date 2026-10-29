/**
 * Document tab strip for the phase-C multi-document shell.
 *
 * The component is deliberately controlled: `setTabs` is the only source of
 * tab data. Close reports intent and never removes a tab by itself; the owner
 * decides whether the document can be closed (e.g. after an unsaved changes
 * prompt) and then calls `setTabs` again. Reorder updates the strip's order
 * immediately for drag feedback and reports the resulting id order, which the
 * owner should persist and mirror back with `setTabs`.
 *
 * Wiring notes for main.ts:
 *  - Call `createTabs(host, options)` once after the host element exists.
 *  - Mirror the document store's order/active state through `setTabs`; use
 *    `updateTab` for title/dirty patches so the strip does not rebuild.
 *  - `onReorder(ids)` receives the complete new order; persist it and call
 *    `setTabs(ids.map(...), active)` (the strip already renders the new order
 *    immediately so the drag does not flicker).
 *  - `destroy()` removes the strip and all listeners; the host is untouched.
 *
 * The stylesheet is imported here so wiring main.ts only needs the module
 * import; every selector lives under the `ce-tabs-` prefix.
 */

import "./tabs.css";
import { t } from "../lib/i18n";

export type TabItem = {
  id: string;
  title: string;
  dirty: boolean;
  path?: string | null;
};

export type TabsOptions = {
  onActivate(id: string): void;
  onClose(id: string): void;
  onReorder(ids: string[]): void;
  onNew?(): void;
};

export type TabsApi = {
  setTabs(items: TabItem[], activeId: string | null): void;
  updateTab(item: TabItem): void;
  setActive(id: string): void;
  getOrder(): string[];
  destroy(): void;
};

/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 4;
/** Distance from the scroller edge that triggers drag auto-scroll. */
const AUTO_SCROLL_EDGE = 28;
const AUTO_SCROLL_STEP = 14;

interface DragState {
  id: string;
  element: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  changed: boolean;
}

function elementFrom(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

function tabFrom(target: EventTarget | null): HTMLElement | null {
  const element = elementFrom(target);
  return element?.closest<HTMLElement>(".ce-tabs-tab") ?? null;
}

function displayTitle(item: TabItem): string {
  return item.title.trim() ? item.title : t("status.untitled");
}

function tabTooltip(item: TabItem): string {
  const title = displayTitle(item);
  return item.path ? `${title}\n${item.path}` : title;
}

function closeLabel(item: TabItem): string {
  return `${t("common.close")}: ${displayTitle(item)}`;
}

export function createTabs(host: HTMLElement, options: TabsOptions): TabsApi {
  const abort = new AbortController();
  const { signal } = abort;

  const root = document.createElement("div");
  root.className = "ce-tabs";
  root.hidden = true;
  root.dataset.empty = "true";

  const scroller = document.createElement("div");
  scroller.className = "ce-tabs-scroller";
  scroller.setAttribute("role", "tablist");
  scroller.setAttribute("aria-label", "Document tabs");
  scroller.setAttribute("aria-orientation", "horizontal");
  root.appendChild(scroller);

  let newButton: HTMLButtonElement | null = null;
  if (options.onNew) {
    const add = options.onNew;
    newButton = document.createElement("button");
    newButton.type = "button";
    newButton.className = "ce-tabs-new";
    newButton.hidden = true;
    newButton.textContent = "+";
    newButton.title = t("toolbar.new");
    newButton.setAttribute("aria-label", t("toolbar.new"));
    newButton.addEventListener("click", () => add(), { signal });
    root.appendChild(newButton);
  }

  host.appendChild(root);

  const tabElements = new Map<string, HTMLElement>();
  let items: TabItem[] = [];
  let activeId: string | null = null;
  let suppressClick = false;
  let drag: DragState | null = null;
  let destroyed = false;

  /**
   * Keep the active tab visible inside the horizontal scroller without
   * scrolling the page (scrollIntoView would also move the editor chrome).
   */
  function ensureVisible(element: HTMLElement): void {
    const bar = scroller.getBoundingClientRect();
    const tab = element.getBoundingClientRect();
    if (tab.left < bar.left) {
      scroller.scrollLeft -= bar.left - tab.left;
    } else if (tab.right > bar.right) {
      scroller.scrollLeft += tab.right - bar.right;
    }
  }

  function syncActiveState(): void {
    for (const [id, element] of tabElements) {
      const active = id === activeId;
      element.classList.toggle("ce-tabs-tab--active", active);
      element.dataset.active = String(active);
      element.setAttribute("aria-selected", String(active));
      element.tabIndex = active ? 0 : -1;
    }
    if (activeId) {
      const element = tabElements.get(activeId);
      if (element) ensureVisible(element);
    }
  }

  function activate(id: string, focus: boolean, force = false): void {
    if (!items.some((item) => item.id === id)) return;
    const changed = activeId !== id;
    activeId = id;
    syncActiveState();
    // Focus before notifying the owner: an onActivate handler that switches the
    // document and focuses the editor keeps that focus instead of losing it to
    // the strip. Keyboard navigation still lands on the tab when the handler
    // does not move focus itself.
    if (focus) {
      const target = tabElements.get(activeId ?? id) ?? tabElements.get(id);
      target?.focus({ preventScroll: true });
      if (target) ensureVisible(target);
    }
    if (changed || force) options.onActivate(id);
  }

  function requestClose(id: string): void {
    // The owner may veto the close (unsaved edits); never remove data here.
    if (items.some((item) => item.id === id)) options.onClose(id);
  }

  function createTabElement(item: TabItem, index: number): HTMLElement {
    const active = item.id === activeId;
    // With no active document, keep one tab in the tab order so the strip is
    // reachable with Tab; the first arrow/Enter then activates it.
    const roving = active || (activeId === null && index === 0);

    const tab = document.createElement("div");
    tab.className = "ce-tabs-tab";
    if (active) tab.classList.add("ce-tabs-tab--active");
    tab.dataset.tabId = item.id;
    tab.dataset.active = String(active);
    tab.dataset.dirty = String(item.dirty);
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(active));
    tab.setAttribute("aria-label", displayTitle(item));
    tab.tabIndex = roving ? 0 : -1;
    tab.title = tabTooltip(item);

    const title = document.createElement("span");
    title.className = "ce-tabs-title";
    title.textContent = displayTitle(item);

    const dirty = document.createElement("span");
    dirty.className = "ce-tabs-dirty";
    dirty.setAttribute("aria-hidden", "true");
    dirty.title = t("status.unsaved");

    const close = document.createElement("button");
    close.type = "button";
    close.className = "ce-tabs-close";
    close.tabIndex = -1;
    close.textContent = "\u00d7";
    close.title = t("common.close");
    close.setAttribute("aria-label", closeLabel(item));

    tab.append(title, dirty, close);
    return tab;
  }

  function render(): void {
    const hadFocus = root.contains(document.activeElement);
    scroller.replaceChildren();
    tabElements.clear();
    items.forEach((item, index) => {
      const element = createTabElement(item, index);
      tabElements.set(item.id, element);
      scroller.appendChild(element);
    });

    const hasTabs = items.length > 0;
    root.hidden = !hasTabs;
    root.dataset.empty = String(!hasTabs);
    if (newButton) newButton.hidden = !hasTabs;

    if (hasTabs && hadFocus) {
      const target = (activeId && tabElements.get(activeId))
        || tabElements.get(items[0].id);
      target?.focus({ preventScroll: true });
    }
    if (activeId) {
      const element = tabElements.get(activeId);
      if (element) ensureVisible(element);
    }
  }

  function moveDragTo(clientX: number): void {
    if (!drag) return;
    const currentIds = items.map((item) => item.id);
    const remaining = currentIds.filter((id) => id !== drag!.id);
    let beforeId: string | null = null;
    for (const element of scroller.querySelectorAll<HTMLElement>(".ce-tabs-tab")) {
      if (element === drag.element) continue;
      const rect = element.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        beforeId = element.dataset.tabId ?? null;
        break;
      }
    }

    const at = beforeId ? remaining.indexOf(beforeId) : remaining.length;
    const nextIds = [...remaining];
    nextIds.splice(at < 0 ? remaining.length : at, 0, drag.id);
    if (nextIds.length !== currentIds.length) return;
    if (nextIds.every((id, index) => id === currentIds[index])) return;

    const byId = new Map(items.map((item) => [item.id, item]));
    items = nextIds.map((id) => byId.get(id)!);
    const beforeElement = beforeId ? tabElements.get(beforeId) ?? null : null;
    scroller.insertBefore(drag.element, beforeElement);
    drag.changed = true;
  }

  function autoScroll(clientX: number): void {
    const bar = scroller.getBoundingClientRect();
    if (clientX < bar.left + AUTO_SCROLL_EDGE) {
      scroller.scrollLeft = Math.max(0, scroller.scrollLeft - AUTO_SCROLL_STEP);
    } else if (clientX > bar.right - AUTO_SCROLL_EDGE) {
      scroller.scrollLeft += AUTO_SCROLL_STEP;
    }
  }

  /**
   * End a drag. `commit` reports the visible order; destroy/setTabs pass false
   * because the owner is already replacing the data.
   *
   * Reordering moves the dragged node, which drops pointer capture, so the
   * move/up listeners live on `window` and survive the DOM mutation.
   */
  function finishDrag(commit: boolean): void {
    const state = drag;
    drag = null;
    root.classList.remove("ce-tabs--dragging");
    if (!state) return;
    state.element.classList.remove("ce-tabs-tab--dragging");
    if (commit && state.changed) options.onReorder(items.map((item) => item.id));
  }

  scroller.addEventListener("click", (event) => {
    const target = elementFrom(event.target);
    const close = target?.closest(".ce-tabs-close");
    if (close) {
      const tab = close.closest<HTMLElement>(".ce-tabs-tab");
      if (tab?.dataset.tabId) {
        event.stopPropagation();
        requestClose(tab.dataset.tabId);
      }
      return;
    }
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const tab = tabFrom(event.target);
    if (tab?.dataset.tabId) activate(tab.dataset.tabId, true, true);
  }, { signal });

  // Middle-click closes, matching browser/editor tab conventions.
  scroller.addEventListener("mousedown", (event) => {
    if (event.button === 1) event.preventDefault();
  }, { signal });

  scroller.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    const tab = tabFrom(event.target);
    if (!tab?.dataset.tabId) return;
    event.preventDefault();
    requestClose(tab.dataset.tabId);
  }, { signal });

  scroller.addEventListener("keydown", (event) => {
    if (!items.length) return;
    const target = elementFrom(event.target);
    const tab = tabFrom(event.target);
    const currentId = tab?.dataset.tabId ?? activeId ?? items[0].id;
    const onCloseButton = Boolean(target?.closest(".ce-tabs-close"));

    if (event.key === "Delete") {
      event.preventDefault();
      requestClose(currentId);
      return;
    }
    // Let the native button handle Enter/Space when it owns focus, but keep
    // arrow/Home/End navigation working from the close button.
    if (onCloseButton && (event.key === "Enter" || event.key === " ")) return;

    const ids = items.map((item) => item.id);
    const currentIndex = Math.max(0, ids.indexOf(currentId));
    const step = (delta: number): void => {
      event.preventDefault();
      const next = ids[(currentIndex + delta + ids.length) % ids.length];
      activate(next, true);
    };

    switch (event.key) {
      case "ArrowLeft":
        step(-1);
        break;
      case "ArrowRight":
        step(1);
        break;
      case "Home":
        event.preventDefault();
        activate(ids[0], true);
        break;
      case "End":
        event.preventDefault();
        activate(ids[ids.length - 1], true);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        activate(currentId, true, true);
        break;
      default:
        break;
    }
  }, { signal });

  scroller.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    // Touch/pen keep native horizontal scrolling; dragging is mouse-only.
    if (event.pointerType !== "mouse") return;
    const target = elementFrom(event.target);
    if (!target || target.closest(".ce-tabs-close")) return;
    const element = target.closest<HTMLElement>(".ce-tabs-tab");
    const id = element?.dataset.tabId;
    if (!element || !id) return;
    drag = {
      id,
      element,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      changed: false,
    };
  }, { signal });

  window.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      root.classList.add("ce-tabs--dragging");
      drag.element.classList.add("ce-tabs-tab--dragging");
    }
    event.preventDefault();
    moveDragTo(event.clientX);
    autoScroll(event.clientX);
  }, { signal });

  window.addEventListener("pointerup", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = drag.moved;
    finishDrag(true);
    if (!moved) return;
    // A drag ends with a click on some tab; it must not also activate it.
    suppressClick = true;
    window.setTimeout(() => {
      suppressClick = false;
    }, 0);
    const target = (activeId && tabElements.get(activeId))
      || (items[0] ? tabElements.get(items[0].id) : undefined);
    target?.focus({ preventScroll: true });
  }, { signal });

  window.addEventListener("pointercancel", () => {
    finishDrag(true);
  }, { signal });

  // Alt-Tab while dragging never delivers pointerup; keep the visible order.
  window.addEventListener("blur", () => {
    finishDrag(true);
  }, { signal });

  return {
    setTabs(nextItems, nextActiveId) {
      if (destroyed) return;
      finishDrag(false);
      items = nextItems.map((item) => ({ ...item }));
      activeId = nextActiveId && items.some((item) => item.id === nextActiveId)
        ? nextActiveId
        : null;
      render();
    },

    updateTab(item) {
      if (destroyed) return;
      const index = items.findIndex((candidate) => candidate.id === item.id);
      if (index < 0) return;
      items[index] = { ...item };
      const element = tabElements.get(item.id);
      if (!element) return;
      const title = element.querySelector<HTMLElement>(".ce-tabs-title");
      if (title) title.textContent = displayTitle(item);
      element.dataset.dirty = String(item.dirty);
      element.setAttribute("aria-label", displayTitle(item));
      element.title = tabTooltip(item);
      const close = element.querySelector<HTMLButtonElement>(".ce-tabs-close");
      if (close) close.setAttribute("aria-label", closeLabel(item));
      if (item.id === activeId) ensureVisible(element);
    },

    setActive(id) {
      if (destroyed) return;
      if (!tabElements.has(id)) return;
      activeId = id;
      syncActiveState();
    },

    getOrder() {
      return items.map((item) => item.id);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      finishDrag(false);
      abort.abort();
      root.remove();
      tabElements.clear();
      items = [];
      activeId = null;
    },
  };
}
