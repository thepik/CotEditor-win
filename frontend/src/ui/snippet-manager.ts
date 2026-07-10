/**
 * Snippet manager UI (PLAN §阶段6).
 *
 * A modal panel listing the user's snippets with add / edit / delete and an
 * "insert" action. Snippets are persisted in `localStorage` (works in both the
 * Wails WebView2 window and a plain browser) as a JSON array of `SnippetDef`.
 *
 * Insertion delegates to `lib/snippet-engine`'s `insertSnippet`, which honours
 * `<<<SELECTION>>>` and `<<<CURSOR>>>` template variables and multi-cursor.
 *
 * Shortcuts: Ctrl+Alt+1..9 insert the first nine snippets (CotEditor's
 * convention), provided a snippet exists at that index.
 */

import { getEditor } from "../editor/monaco-setup";
import { insertSnippet } from "../lib/snippet-engine";
import { t, onLangChange } from "../lib/i18n";

export interface SnippetDef {
  /** Stable id (so reordering edits don't thrash). */
  id: string;
  name: string;
  format: string;
}

const STORAGE_KEY = "coteditor.snippets.v1";

let snippets: SnippetDef[] = loadSnippets();
/** Sorted, deduped list of the slot indexes currently bound to a shortcut. */
let listeners: Array<(s: SnippetDef[]) => void> = [];

/** Load snippets from localStorage, seeding with a couple of examples on first run. */
function loadSnippets(): SnippetDef[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as SnippetDef[];
  } catch {
    // fall through to defaults
  }
  const seed: SnippetDef[] = [
    {
      id: genId(),
      name: "if statement",
      format: "if <<<SELECTION>>>:\n    <<<CURSOR>>>",
    },
    {
      id: genId(),
      name: "print debug",
      format: 'print(f"{<<<CURSOR>>>=}")',
    },
  ];
  // Persist the seed directly to storage (not via `persist`, which assigns to
  // the module-level `snippets` binding that is still being initialised here).
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
  } catch {
    // storage unavailable; the in-memory seed is enough
  }
  return seed;
}

function persist(list: SnippetDef[]): void {
  snippets = list;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // storage may be unavailable (private mode); keep in-memory copy only
  }
  for (const l of listeners) l(list);
}

/** Generate a short unique id without pulling in a uuid dependency. */
function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Return a snapshot of the current snippet list. */
export function getSnippets(): SnippetDef[] {
  return [...snippets];
}

/** Subscribe to snippet-list changes; returns an unsubscribe function. */
export function onSnippetsChanged(fn: (s: SnippetDef[]) => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

/** Add a snippet; returns the new def (with a fresh id). */
export function addSnippet(name: string, format: string): SnippetDef {
  const def: SnippetDef = { id: genId(), name: name.trim() || "Untitled", format };
  persist([...snippets, def]);
  return def;
}

/** Update an existing snippet by id. No-op if the id is unknown. */
export function updateSnippet(id: string, name: string, format: string): void {
  persist(
    snippets.map((s) =>
      s.id === id ? { ...s, name: name.trim() || s.name, format } : s,
    ),
  );
}

/** Delete a snippet by id. */
export function deleteSnippet(id: string): void {
  persist(snippets.filter((s) => s.id !== id));
}

/** Move a snippet up or down in the list (swaps neighbours). */
export function moveSnippet(id: string, dir: -1 | 1): void {
  const idx = snippets.findIndex((s) => s.id === id);
  const target = idx + dir;
  if (idx < 0 || target < 0 || target >= snippets.length) return;
  const next = [...snippets];
  [next[idx], next[target]] = [next[target], next[idx]];
  persist(next);
}

/** Insert a snippet into the active editor by id. */
export function insertSnippetById(id: string): void {
  const def = snippets.find((s) => s.id === id);
  if (!def) return;
  const editor = getEditor();
  if (!editor) return;
  insertSnippet(editor, def.format);
}

/* ----------------------------- panel rendering ---------------------------- */

let panelEl: HTMLDivElement | null = null;

/** Open the snippet manager panel, building it lazily. */
export function openSnippetManager(): void {
  if (panelEl && document.body.contains(panelEl)) {
    closeSnippetManager();
    return;
  }
  panelEl = buildPanel();
  document.body.appendChild(panelEl);
  // Close on Escape.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      closeSnippetManager();
      document.removeEventListener("keydown", onKey);
    }
  };
  document.addEventListener("keydown", onKey);
  renderList();
}

/** Remove the panel if open. */
export function closeSnippetManager(): void {
  if (panelEl) {
    panelEl.remove();
    panelEl = null;
  }
}

function buildPanel(): HTMLDivElement {
  const panel = document.createElement("div");
  panel.className = "ce-modal ce-snippet-manager";
  panel.innerHTML =
    `<div class="ce-modal-card">
       <div class="ce-modal-head">
         <h2>${t("snippet.title")}</h2>
         <button type="button" class="ce-modal-close" title="${t("snippet.close")}">✕</button>
       </div>
       <div class="ce-modal-body">
         <div class="ce-snippet-list" data-list></div>
         <div class="ce-snippet-edit" data-edit hidden>
           <label class="ce-field">
             <span>${t("snippet.fieldName")}</span>
             <input type="text" data-field-name placeholder="${t("snippet.namePlaceholder")}" />
           </label>
           <label class="ce-field">
             <span>${t("snippet.fieldFormat")}</span>
             <textarea data-field-format rows="5"
               placeholder="${t("snippet.formatPlaceholder")}"></textarea>
           </label>
           <p class="ce-hint">${t("snippet.hint")}</p>
         </div>
       </div>
       <div class="ce-modal-foot">
         <button type="button" data-action-add>${t("snippet.new")}</button>
         <div class="ce-spacer"></div>
         <button type="button" data-action-done>${t("snippet.done")}</button>
       </div>
     </div>`;

  panel.querySelector(".ce-modal-close")!.addEventListener("click", closeSnippetManager);
  panel.querySelector('[data-action-done]')!.addEventListener("click", closeSnippetManager);
  panel.querySelector('[data-action-add]')!.addEventListener("click", () => startEdit(null));
  panel.addEventListener("click", (e) => {
    // Click on the backdrop (the panel root itself, not its card) closes.
    if (e.target === panel) closeSnippetManager();
  });
  return panel;
}

function renderList(): void {
  if (!panelEl) return;
  const listEl = panelEl.querySelector<HTMLElement>("[data-list]");
  if (!listEl) return;
  listEl.innerHTML = "";

  if (snippets.length === 0) {
    const empty = document.createElement("p");
    empty.className = "ce-empty";
    empty.textContent = t("snippet.empty");
    listEl.appendChild(empty);
    return;
  }

  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i];
    const row = document.createElement("div");
    row.className = "ce-snippet-row";
    const slot = i < 9 ? `${i + 1}` : "";
    row.innerHTML =
      `<span class="ce-snippet-slot" title="Ctrl+Alt+${slot}">${slot}</span>` +
      `<span class="ce-snippet-name"></span>` +
      `<span class="ce-snippet-actions">` +
      `<button type="button" data-act="up" title="${t("snippet.moveUp")}">↑</button>` +
      `<button type="button" data-act="down" title="${t("snippet.moveDown")}">↓</button>` +
      `<button type="button" data-act="insert" title="${t("snippet.insertNow")}">${t("snippet.insertNow")}</button>` +
      `<button type="button" data-act="edit" title="${t("snippet.edit")}">${t("snippet.edit")}</button>` +
      `<button type="button" data-act="del" title="${t("snippet.delete")}">${t("snippet.delete")}</button>` +
      `</span>`;
    row.querySelector<HTMLElement>(".ce-snippet-name")!.textContent = s.name || t("snippet.unnamed");

    row.querySelector<HTMLElement>('[data-act="up"]')!.addEventListener("click", () => moveSnippet(s.id, -1));
    row.querySelector<HTMLElement>('[data-act="down"]')!.addEventListener("click", () => moveSnippet(s.id, 1));
    row.querySelector<HTMLElement>('[data-act="insert"]')!.addEventListener("click", () => {
      insertSnippetById(s.id);
      closeSnippetManager();
    });
    row.querySelector<HTMLElement>('[data-act="edit"]')!.addEventListener("click", () => startEdit(s));
    row.querySelector<HTMLElement>('[data-act="del"]')!.addEventListener("click", () => {
      if (confirm(t("snippet.confirmDelete").replace("{name}", s.name))) deleteSnippet(s.id);
    });
    listEl.appendChild(row);
  }
}

/** Show the edit form for an existing snippet, or a blank form when `def` is null. */
function startEdit(def: SnippetDef | null): void {
  if (!panelEl) return;
  const editEl = panelEl.querySelector<HTMLElement>("[data-edit]");
  const nameEl = panelEl.querySelector<HTMLInputElement>("[data-field-name]");
  const fmtEl = panelEl.querySelector<HTMLTextAreaElement>("[data-field-format]");
  if (!editEl || !nameEl || !fmtEl) return;

  editEl.hidden = false;
  nameEl.value = def?.name ?? "";
  fmtEl.value = def?.format ?? "";
  nameEl.focus();

  // Replace any prior save button by rebuilding the foot actions for the form.
  const oldBtn = panelEl.querySelector('[data-action-save]');
  if (oldBtn) oldBtn.remove();
  const save = document.createElement("button");
  save.type = "button";
  save.dataset.action = "save";
  save.textContent = def ? t("snippet.save") : t("snippet.add");
  save.addEventListener("click", () => {
    const name = nameEl.value;
    const format = fmtEl.value;
    if (!format.trim()) {
      fmtEl.focus();
      return;
    }
    if (def) updateSnippet(def.id, name, format);
    else addSnippet(name, format);
    editEl.hidden = true;
    save.remove();
    renderList();
  });
  // Insert the save button next to Done.
  panelEl.querySelector('[data-action-done]')!.before(save);
}

/** Bind Ctrl+Alt+1..9 to insert the first nine snippets. */
export function registerSnippetShortcuts(): void {
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.altKey) return;
    const digit = parseInt(e.key, 10);
    if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
    if (snippets.length < digit) return;
    e.preventDefault();
    insertSnippetById(snippets[digit - 1].id);
  });
}

// Re-render the list whenever the underlying data changes (e.g. after an edit
// performed programmatically).
onSnippetsChanged(() => {
  if (panelEl && document.body.contains(panelEl)) renderList();
});

// When the UI language changes while the panel is open, rebuild it so the
// static strings (title, field labels, buttons) follow the new language. The
// list is then re-rendered with the translated labels too. An in-progress edit
// is discarded on rebuild, which is acceptable for this rare interaction.
onLangChange(() => {
  if (panelEl && document.body.contains(panelEl)) {
    closeSnippetManager();
    openSnippetManager();
  }
});
