/**
 * Multiple-replace UI (PLAN §阶段7).
 *
 * A modal panel that edits an ordered list of `ReplaceRule`s (find / replace /
 * regex / ignore-case / enabled) backed by `lib/multiple-replace`. Supports
 * TSV import/export (the same format the engine uses) and "Replace All" against
 * the whole document or the current selection.
 *
 * Mirrors CotEditor's `MultipleReplaceView` columns: enabled, find, replace,
 * regex, ignore-case.
 *
 * Shortcut: Ctrl+Shift+H opens this panel.
 */

import type { MultipleReplace, ReplaceRule } from "../lib/multiple-replace";
import { runMultipleReplace, exportToTsv, importFromTsv } from "../lib/multiple-replace";
import { getEditor, getModel } from "../editor/monaco-setup";
import { t, onLangChange } from "../lib/i18n";

const STORAGE_KEY = "coteditor.multiplereplace.v1";

/** The current rule set, persisted to localStorage between sessions. */
let current: MultipleReplace = load();

function load(): MultipleReplace {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MultipleReplace;
      if (parsed.rules && parsed.rules.length > 0) return parsed;
    }
  } catch {
    // fall through to default
  }
  const def: MultipleReplace = {
    name: "Default",
    rules: [emptyRule()],
  };
  // Persist the default directly to storage (not via `persist`, which assigns
  // to the module-level `current` binding that is still being initialised).
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(def));
  } catch {
    // storage unavailable; the in-memory default is enough
  }
  return def;
}

function persist(mr: MultipleReplace): void {
  current = mr;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mr));
  } catch {
    // storage unavailable; keep in-memory only
  }
}

function emptyRule(): ReplaceRule {
  return { enabled: true, ignoreCase: false, isRegex: true, find: "", replace: "" };
}

let panelEl: HTMLDivElement | null = null;

/** Open the multiple-replace panel, building it lazily on first open. */
export function openMultipleReplacePanel(): void {
  if (panelEl && document.body.contains(panelEl)) {
    closeMultipleReplacePanel();
    return;
  }
  panelEl = buildPanel();
  document.body.appendChild(panelEl);
  renderRules();

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      closeMultipleReplacePanel();
      document.removeEventListener("keydown", onKey);
    }
  };
  document.addEventListener("keydown", onKey);
}

export function closeMultipleReplacePanel(): void {
  if (panelEl) {
    panelEl.remove();
    panelEl = null;
  }
}

// When the UI language changes while the panel is open, rebuild it so the
// header, column titles, and foot buttons follow the new language. Rule rows
// are re-rendered by `renderRules` with translated placeholders.
onLangChange(() => {
  if (panelEl && document.body.contains(panelEl)) {
    closeMultipleReplacePanel();
    openMultipleReplacePanel();
  }
});

function buildPanel(): HTMLDivElement {
  const panel = document.createElement("div");
  panel.className = "ce-modal ce-multiple-replace";
  panel.innerHTML =
    `<div class="ce-modal-card ce-wide">
       <div class="ce-modal-head">
         <h2>${t("mr.title")}</h2>
         <button type="button" class="ce-modal-close" title="${t("snippet.close")}">✕</button>
       </div>
       <div class="ce-modal-body">
         <table class="ce-mr-table">
           <thead>
             <tr>
               <th class="ce-mr-on" title="${t("mr.onHint")}">${t("mr.colOn")}</th>
               <th>${t("mr.colFind")}</th>
               <th>${t("mr.colReplace")}</th>
               <th class="ce-mr-regex" title="${t("mr.regexHint")}">${t("mr.colRegex")}</th>
               <th class="ce-mr-case" title="${t("mr.caseHint")}">${t("mr.colCase")}</th>
               <th class="ce-mr-del"></th>
             </tr>
           </thead>
           <tbody data-rules></tbody>
         </table>
       </div>
       <div class="ce-modal-foot">
         <button type="button" data-action-add>${t("mr.addRule")}</button>
         <button type="button" data-action-import>${t("mr.import")}</button>
         <button type="button" data-action-export>${t("mr.export")}</button>
         <div class="ce-spacer"></div>
         <button type="button" class="ce-primary" data-action-replace>${t("mr.replaceAll")}</button>
         <button type="button" data-action-done>${t("mr.done")}</button>
       </div>
     </div>`;

  panel.querySelector(".ce-modal-close")!.addEventListener("click", closeMultipleReplacePanel);
  panel.querySelector('[data-action-done]')!.addEventListener("click", closeMultipleReplacePanel);
  panel.querySelector('[data-action-add]')!.addEventListener("click", () => {
    current.rules.push(emptyRule());
    persist(current);
    renderRules();
  });
  panel.querySelector('[data-action-replace]')!.addEventListener("click", applyAll);
  panel.querySelector('[data-action-export]')!.addEventListener("click", exportTsv);
  panel.querySelector('[data-action-import]')!.addEventListener("click", importTsv);
  panel.addEventListener("click", (e) => {
    if (e.target === panel) closeMultipleReplacePanel();
  });
  return panel;
}

function renderRules(): void {
  if (!panelEl) return;
  const tbody = panelEl.querySelector<HTMLElement>("[data-rules]");
  if (!tbody) return;
  tbody.innerHTML = "";

  current.rules.forEach((rule, idx) => {
    const tr = document.createElement("tr");
    tr.className = "ce-mr-row" + (rule.enabled ? "" : " ce-disabled");
    tr.innerHTML =
      `<td class="ce-mr-on"><input type="checkbox" data-col="enabled" ${rule.enabled ? "checked" : ""}/></td>` +
      `<td><input type="text" class="ce-mr-find" data-col="find" value="${attr(rule.find)}" placeholder="${attr(t("mr.findPlaceholder"))}"/></td>` +
      `<td><input type="text" class="ce-mr-replace" data-col="replace" value="${attr(rule.replace)}" placeholder="${attr(t("mr.replacePlaceholder"))}"/></td>` +
      `<td class="ce-mr-regex"><input type="checkbox" data-col="isRegex" ${rule.isRegex ? "checked" : ""}/></td>` +
      `<td class="ce-mr-case"><input type="checkbox" data-col="ignoreCase" ${rule.ignoreCase ? "checked" : ""}/></td>` +
      `<td class="ce-mr-del"><button type="button" data-act="del" title="${attr(t("mr.deleteRule"))}">✕</button></td>`;

    // Wire field edits.
    tr.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[data-col]").forEach((el) => {
      el.addEventListener("change", () => {
        const col = el.dataset.col!;
        const val = el.type === "checkbox" ? (el as HTMLInputElement).checked : el.value;
        (current.rules[idx] as unknown as Record<string, unknown>)[col] = val;
        persist(current);
        if (col === "enabled") renderRules();
      });
    });

    tr.querySelector<HTMLElement>('[data-act="del"]')!.addEventListener("click", () => {
      current.rules.splice(idx, 1);
      if (current.rules.length === 0) current.rules.push(emptyRule());
      persist(current);
      renderRules();
    });

    tbody.appendChild(tr);
  });
}

/** Escape a value for safe embedding in an HTML attribute. */
function attr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Apply every enabled rule to the whole document (or the selection). */
export function applyAll(): void {
  const editor = getEditor();
  const model = getModel();
  if (!editor || !model) return;

  const sel = editor.getSelection();
  const inSelection = sel && !sel.isEmpty();
  const text = inSelection ? model.getValueInRange(sel) : model.getValue();
  const result = runMultipleReplace(text, current);

  if (inSelection && sel) {
    editor.executeEdits("multiple-replace", [{ range: sel, text: result }]);
  } else {
    editor.executeEdits("multiple-replace", [
      { range: model.getFullModelRange(), text: result },
    ]);
  }
  editor.focus();
  closeMultipleReplacePanel();
}

/** Export the current rule set as a TSV file download. */
function exportTsv(): void {
  const tsv = exportToTsv(current);
  const blob = new Blob([tsv], { type: "text/tab-separated-values" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "multiple-replace.tsv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Import rules from a user-selected TSV file, replacing the current set. */
function importTsv(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".tsv,text/tab-separated-values,text/plain";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    const imported = importFromTsv(current.name, text);
    if (imported.rules.length === 0) {
      alert(t("mr.noRules"));
      return;
    }
    persist(imported);
    renderRules();
  });
  input.click();
}
