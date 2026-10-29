/**
 * Minimal i18n core (PLAN §阶段8 - 中英文界面).
 *
 * The app's chrome (menus, toolbar, statusbar, modal panels, dialogs) is fully
 * bilingual Chinese / English. Monaco's own find widget and built-in action
 * labels are left untouched - those ship English-only upstream and are not
 * worth vendoring for a personal tool.
 *
 * Design:
 *  - Two flat string dictionaries keyed by a stable id.
 *  - `t(key)` resolves the current language's string, falling back to English
 *    then to the key itself (so a missing translation shows as the key rather
 *    than blank).
 *  - `setLang` persists the choice to localStorage and notifies subscribers; UI
 *    modules subscribe so a live language switch re-renders their chrome.
 *  - The dictionary also carries the small set of shortcut strings used by the
 *    menu's shortcut hints, so the same string isn't duplicated between the
 *    menu definition and the shortcuts dialog.
 */

export type Lang = "en" | "zh";

const STORAGE_KEY = "coteditor.lang.v1";

/** Current language, loaded once at module init and mutated via `setLang`. */
let currentLang: Lang = loadLang();

/** Listeners notified on `setLang` (UI modules that rebuild chrome on change). */
const listeners: Array<(lang: Lang) => void> = [];

function loadLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {
    // localStorage may be unavailable; fall back to detection below.
  }
  // Default to Chinese: the project is zh-first (index.html lang="zh-CN") and
  // the target user is a Chinese speaker. English remains one toggle away.
  return "zh";
}

/** Read the current UI language. */
export function getLang(): Lang {
  return currentLang;
}

/** Switch language, persist, and notify subscribers. No-op if unchanged. */
export function setLang(lang: Lang): void {
  if (lang === currentLang) return;
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // storage unavailable; keep the in-memory choice for this session
  }
  for (const fn of listeners) fn(lang);
}

/** Toggle between zh and en (convenience for the menu switch). */
export function toggleLang(): void {
  setLang(currentLang === "zh" ? "en" : "zh");
}

/** Subscribe to language changes; returns an unsubscribe function. */
export function onLangChange(fn: (lang: Lang) => void): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** Human-readable name of a language, in that language (for the menu label). */
export function langName(lang: Lang): string {
  return lang === "zh" ? "中文" : "English";
}

/**
 * Resolve a string key to the current language's value.
 * Falls back to English, then to the raw key.
 */
export function t(key: string): string {
  const zh = dictZh[key];
  const en = dictEn[key];
  if (currentLang === "zh" && zh) return zh;
  if (en) return en;
  return key;
}

/* -------------------------------------------------------------------------- */
/*  Dictionaries                                                               */
/* -------------------------------------------------------------------------- */

const dictEn: Record<string, string> = {
  /* menus - top level */
  "menu.file": "File",
  "menu.edit": "Edit",
  "menu.view": "View",
  "menu.format": "Format",
  "menu.snippet": "Snippet",
  "menu.theme": "Theme",
  "menu.help": "Help",
  "menu.language": "Language",
  "menu.syntax": "Syntax",

  /* file menu */
  "file.new": "New",
  "file.open": "Open…",
  "file.openWithEncoding": "Open with Encoding…",
  "file.save": "Save",
  "file.saveAs": "Save As…",
  "file.closeTab": "Close Tab",
  "file.openRecent": "Open Recent",
  "file.noRecent": "No Recent Files",
  "file.autoSave": "Auto Save",

  /* edit menu */
  "edit.undo": "Undo",
  "edit.redo": "Redo",
  "edit.cut": "Cut",
  "edit.copy": "Copy",
  "edit.paste": "Paste",
  "edit.selectAll": "Select All",
  "edit.find": "Find",
  "edit.findAll": "Find All in Document…",
  "edit.replace": "Replace",
  "edit.replaceAllPreview": "Preview Replace All…",
  "edit.multipleReplace": "Multiple Replace…",

  /* view menu */
  "view.lineNumbers": "Toggle Line Numbers",
  "view.renderWhitespace": "Toggle Render Whitespace",
  "view.wordWrap": "Toggle Word Wrap",
  "view.zoomIn": "Zoom In",
  "view.zoomOut": "Zoom Out",
  "view.language": "Language",
  "view.togglePreview": "Toggle Preview",
  "view.toggleSplit": "Split Preview",
  "view.toggleOutline": "Show Outline",

  /* format menu */
  "format.sortLines": "Sort Lines",
  "format.sortLinesDesc": "Sort Lines (Desc)",
  "format.reverseLines": "Reverse Lines",
  "format.shuffleLines": "Shuffle Lines",
  "format.deleteDuplicateLines": "Delete Duplicate Lines",
  "format.moveLineUp": "Move Line Up",
  "format.moveLineDown": "Move Line Down",
  "format.duplicateLine": "Duplicate Line",
  "format.deleteLine": "Delete Line",
  "format.joinLines": "Join Lines",
  "format.indentLines": "Indent Lines",
  "format.outdentLines": "Outdent Lines",
  "format.removeEmptyLines": "Remove Empty Lines",
  "format.trimTrailingWhitespace": "Trim Trailing Whitespace",

  /* snippet menu */
  "snippet.manage": "Manage Snippets…",
  "snippet.insert": "Insert Snippet",

  /* help menu */
  "help.about": "About CotEditor-win",
  "help.shortcuts": "Keyboard Shortcuts",

  /* toolbar */
  "toolbar.new": "New",
  "toolbar.open": "Open…",
  "toolbar.save": "Save",
  "toolbar.saveAs": "Save As…",
  "toolbar.edit": "Edit",
  "toolbar.split": "Split",
  "toolbar.preview": "Preview",

  /* preview */
  "preview.empty": "Nothing to preview",

  /* find results */
  "find.queryPrompt": "Text to find in this document",
  "find.replacePrompt": "Replacement text (preview only, nothing is changed)",
  "find.replacePreview":
    "Preview only: {count} match(es) would be replaced. The document was not modified.",

  /* accessibility labels */
  "a11y.toolbar": "Main toolbar",
  "a11y.workspace": "Editor workspace",
  "a11y.editor": "Editor",
  "a11y.findResults": "Find results",
  "a11y.statusbar": "Status bar",
  "a11y.outline": "Outline",

  /* statusbar */
  "status.untitled": "Untitled",
  "status.line": "Ln",
  "status.column": "Col",
  "status.totalLines": "Total lines",
  "status.characters": "Graphemes",
  "status.codePoints": "Code points",
  "status.readOnly": "Read-only",
  "status.utf16Position": "Cursor offset in UTF-16 code units",
  "status.newerEdits": "The snapshot was saved, but newer edits remain. Save again before switching documents.",
  "format.mixed": "Mixed EOL",
  "format.mixedReadOnly": "Mixed line endings: read-only. Monaco normalizes the displayed text; the original file has NOT been rewritten. Choose Normalize to LF to explicitly allow conversion and editing.",
  "format.unsupportedReadOnly": "Unsupported encoding or binary content: read-only. Saving and automatic write-back are disabled.",
  "format.normalizeLF": "Normalize to LF…",
  "format.normalizeTitle": "Convert all line endings to LF?",
  "format.normalizeMessage": "This file contains mixed line endings. Their original layout cannot be preserved by this editor. All line endings will be converted to LF.",
  "format.normalizeHint": "Confirming enables editing and automatic saving to the current file. Cancel keeps the original file untouched and read-only.",
  "status.position": "Position",
  "status.currentLine": "Line",
  "syntax.plainText": "Plain Text",
  "status.unsaved": "Not saved",
  "status.saving": "Saving…",
  "status.saved": "Saved",
  "status.saveError": "Save failed",

  /* unsaved changes + file feedback */
  "unsaved.title": "Save your changes?",
  "unsaved.message": "“{name}” has changes that haven't been saved.",
  "unsaved.hint": "Your changes will be lost if you continue without saving.",
  "unsaved.save": "Save",
  "unsaved.discard": "Don't Save",
  "unsaved.cancel": "Cancel",
  "close.title": "Save all changes before closing?",
  "close.message": "These documents have unsaved changes: {names}.",
  "close.hint": "Save All writes every changed document, then quits. Don't Save discards them and quits. Cancel keeps the window open.",
  "close.saveAll": "Save All",
  "error.openFailed": "Could not open the file: ",
  "error.saveFailed": "Could not save the file: ",
  "error.autosaveFailed": "Automatic save failed: ",
  "common.close": "Close",

  /* title */
  "title.app": "CotEditor",

  /* snippet manager panel */
  "snippet.title": "Snippets",
  "snippet.close": "Close (Esc)",
  "snippet.fieldName": "Name",
  "snippet.fieldFormat": "Format",
  "snippet.namePlaceholder": "Snippet name",
  "snippet.formatPlaceholder": "Use <<<SELECTION>>> and <<<CURSOR>>> as placeholders",
  "snippet.hint": "<<<SELECTION>>> inserts the current selection; <<<CURSOR>>> marks caret stop(s).",
  "snippet.new": "+ New",
  "snippet.done": "Done",
  "snippet.save": "Save",
  "snippet.add": "Add",
  "snippet.empty": "No snippets yet. Click \u201C+ New\u201D to create one.",
  "snippet.unnamed": "(unnamed)",
  "snippet.moveUp": "Move up",
  "snippet.moveDown": "Move down",
  "snippet.insertNow": "Insert now",
  "snippet.edit": "Edit",
  "snippet.delete": "Delete",
  "snippet.confirmDelete": "Delete snippet \u201C{name}\u201D?",

  /* multiple replace panel */
  "mr.title": "Multiple Replace",
  "mr.colOn": "On",
  "mr.colFind": "Find",
  "mr.colReplace": "Replace",
  "mr.colRegex": "Regex",
  "mr.colCase": "i",
  "mr.onHint": "Enable/disable rule",
  "mr.regexHint": "Treat find as regular expression",
  "mr.caseHint": "Ignore case",
  "mr.addRule": "+ Add Rule",
  "mr.import": "Import TSV…",
  "mr.export": "Export TSV",
  "mr.replaceAll": "Replace All",
  "mr.done": "Done",
  "mr.deleteRule": "Delete rule",
  "mr.findPlaceholder": "find…",
  "mr.replacePlaceholder": "replace…",
  "mr.noRules": "No rules found in the imported file.",

  /* about dialog */
  "about.body":
    "CotEditor-win\nA lightweight Windows port of CotEditor.\n\nBuilt with Wails + Monaco + tree-sitter.\nVersion 0.1.0",

  /* shortcuts dialog */
  "sc.title": "CotEditor-win - Keyboard Shortcuts",
  "sc.file": "File:  Ctrl+N new  |  Ctrl+O open  |  Ctrl+S save  |  Ctrl+Shift+S save as",
  "sc.edit": "Edit:  Ctrl+Z undo  |  Ctrl+Y redo  |  Ctrl+F find  |  Ctrl+Shift+F find all  |  Ctrl+H replace",
  "sc.multi": "Multi: Ctrl+Shift+H multiple replace",
  "sc.tabs": "Tabs: Ctrl+W close  |  Ctrl+Tab next  |  Ctrl+Shift+Tab previous  |  Ctrl+1..9 switch",
  "sc.preview": "Preview: Ctrl+E full screen  |  Ctrl+Shift+E split  |  Ctrl+Shift+O outline",
  "sc.format": "Format:",
  "sc.sortLines": "  Sort lines      Ctrl+F5",
  "sc.reverseLines": "  Reverse lines   Ctrl+Shift+F5",
  "sc.moveUp": "  Move line up     Ctrl+Shift+\u2191",
  "sc.moveDown": "  Move line down   Ctrl+Shift+\u2193",
  "sc.dupLine": "  Duplicate line   Ctrl+Shift+D",
  "sc.delLine": "  Delete line      Ctrl+Shift+K",
  "sc.joinLines": "  Join lines       Ctrl+J",
  "sc.indent": "  Indent / Outdent Ctrl+] / Ctrl+[",
  "sc.snippets": "Snippets: Ctrl+Alt+P manage | Ctrl+Alt+1..9 insert",
  "sc.multicursor": "Multi-cursor: Ctrl+Click add  |  Ctrl+Alt+\u2191/\u2193 column  |  Ctrl+D next match",
};

const dictZh: Record<string, string> = {
  "menu.file": "文件",
  "menu.edit": "编辑",
  "menu.view": "视图",
  "menu.format": "格式",
  "menu.snippet": "片段",
  "menu.theme": "主题",
  "menu.help": "帮助",
  "menu.language": "语言",
  "menu.syntax": "语法",

  "file.new": "新建",
  "file.open": "打开…",
  "file.openWithEncoding": "以编码打开…",
  "file.save": "保存",
  "file.saveAs": "另存为…",
  "file.closeTab": "关闭标签",
  "file.openRecent": "最近打开",
  "file.noRecent": "无最近文件",
  "file.autoSave": "自动保存",

  "edit.undo": "撤销",
  "edit.redo": "重做",
  "edit.cut": "剪切",
  "edit.copy": "复制",
  "edit.paste": "粘贴",
  "edit.selectAll": "全选",
  "edit.find": "查找",
  "edit.findAll": "在文档中查找全部…",
  "edit.replace": "替换",
  "edit.replaceAllPreview": "替换全部预览…",
  "edit.multipleReplace": "多重替换…",

  "view.lineNumbers": "切换行号显示",
  "view.renderWhitespace": "切换空白字符显示",
  "view.wordWrap": "切换自动换行",
  "view.zoomIn": "放大",
  "view.zoomOut": "缩小",
  "view.language": "界面语言",
  "view.togglePreview": "切换预览",
  "view.toggleSplit": "分屏预览",
  "view.toggleOutline": "显示大纲",

  "format.sortLines": "排序行",
  "format.sortLinesDesc": "排序行（降序）",
  "format.reverseLines": "反转行",
  "format.shuffleLines": "乱序行",
  "format.deleteDuplicateLines": "删除重复行",
  "format.moveLineUp": "上移行",
  "format.moveLineDown": "下移行",
  "format.duplicateLine": "复制行",
  "format.deleteLine": "删除行",
  "format.joinLines": "合并行",
  "format.indentLines": "增加缩进",
  "format.outdentLines": "减少缩进",
  "format.removeEmptyLines": "删除空行",
  "format.trimTrailingWhitespace": "去除行尾空白",

  "snippet.manage": "管理片段…",
  "snippet.insert": "插入片段",

  "help.about": "关于 CotEditor-win",
  "help.shortcuts": "键盘快捷键",

  "toolbar.new": "新建",
  "toolbar.open": "打开…",
  "toolbar.save": "保存",
  "toolbar.saveAs": "另存为…",
  "toolbar.edit": "编辑",
  "toolbar.split": "分屏",
  "toolbar.preview": "预览",

  /* preview */
  "preview.empty": "暂无内容可预览",

  /* find results */
  "find.queryPrompt": "要在当前文档中查找的文本",
  "find.replacePrompt": "替换文本（仅预览，不会修改文档）",
  "find.replacePreview": "仅预览：将替换 {count} 处，文档未被修改。",

  /* accessibility labels */
  "a11y.toolbar": "主工具栏",
  "a11y.workspace": "编辑器工作区",
  "a11y.editor": "编辑器",
  "a11y.findResults": "查找结果",
  "a11y.statusbar": "状态栏",
  "a11y.outline": "大纲",

  "status.untitled": "未命名",
  "status.line": "行",
  "status.column": "列",
  "status.totalLines": "总行数",
  "status.characters": "字素",
  "status.codePoints": "码点",
  "status.readOnly": "只读",
  "status.utf16Position": "光标偏移量（UTF-16 码元）",
  "status.newerEdits": "本次快照已保存，但仍有较新的编辑未保存。请再次保存后再切换文档。",
  "format.mixed": "混合换行",
  "format.mixedReadOnly": "混合换行文件现为只读。编辑器仅归一化显示，尚未改写原文件；如需转换并编辑，请明确选择“统一为 LF”。",
  "format.unsupportedReadOnly": "不支持的编码或二进制内容：仅可只读查看，已禁止保存和自动写回。",
  "format.normalizeLF": "统一为 LF…",
  "format.normalizeTitle": "将所有换行统一为 LF？",
  "format.normalizeMessage": "此文件包含混合换行。编辑器无法保留原有混合换行分布，继续后会将全部换行转换为 LF。",
  "format.normalizeHint": "确认后允许编辑，并恢复向当前文件自动保存；取消将保留原文件不变，继续只读查看。",
  "status.position": "位置",
  "status.currentLine": "行",
  "syntax.plainText": "纯文本",
  "status.unsaved": "尚未保存",
  "status.saving": "正在保存…",
  "status.saved": "已保存",
  "status.saveError": "保存失败",

  "unsaved.title": "要保存更改吗？",
  "unsaved.message": "“{name}”包含尚未保存的更改。",
  "unsaved.hint": "如果不保存就继续，这些编辑内容将会丢失。",
  "unsaved.save": "保存",
  "unsaved.discard": "不保存",
  "unsaved.cancel": "取消",
  "close.title": "关闭前保存所有更改？",
  "close.message": "以下文档包含尚未保存的更改：{names}。",
  "close.hint": "“全部保存”会写入所有已更改文档后退出；“不保存”将丢弃更改并退出；“取消”保持窗口打开。",
  "close.saveAll": "全部保存",
  "error.openFailed": "无法打开文件：",
  "error.saveFailed": "无法保存文件：",
  "error.autosaveFailed": "自动保存失败：",
  "common.close": "关闭",

  "title.app": "CotEditor",

  "snippet.title": "片段",
  "snippet.close": "关闭 (Esc)",
  "snippet.fieldName": "名称",
  "snippet.fieldFormat": "格式",
  "snippet.namePlaceholder": "片段名称",
  "snippet.formatPlaceholder": "使用 <<<SELECTION>>> 和 <<<CURSOR>>> 作为占位符",
  "snippet.hint": "<<<SELECTION>>> 插入当前选中文本；<<<CURSOR>>> 标记光标停留位置。",
  "snippet.new": "+ 新建",
  "snippet.done": "完成",
  "snippet.save": "保存",
  "snippet.add": "添加",
  "snippet.empty": "暂无片段。点击 \u201C+ 新建\u201D 创建一个。",
  "snippet.unnamed": "（未命名）",
  "snippet.moveUp": "上移",
  "snippet.moveDown": "下移",
  "snippet.insertNow": "立即插入",
  "snippet.edit": "编辑",
  "snippet.delete": "删除",
  "snippet.confirmDelete": "确认删除片段 \u201C{name}\u201D？",

  "mr.title": "多重替换",
  "mr.colOn": "启用",
  "mr.colFind": "查找",
  "mr.colReplace": "替换为",
  "mr.colRegex": "正则",
  "mr.colCase": "忽略大小写",
  "mr.onHint": "启用/禁用规则",
  "mr.regexHint": "将查找内容作为正则表达式",
  "mr.caseHint": "忽略大小写",
  "mr.addRule": "+ 添加规则",
  "mr.import": "导入 TSV…",
  "mr.export": "导出 TSV",
  "mr.replaceAll": "全部替换",
  "mr.done": "完成",
  "mr.deleteRule": "删除规则",
  "mr.findPlaceholder": "查找…",
  "mr.replacePlaceholder": "替换为…",
  "mr.noRules": "导入的文件中未找到规则。",

  "about.body":
    "CotEditor-win\nCotEditor 的轻量级 Windows 移植版。\n\n基于 Wails + Monaco + tree-sitter 构建。\n版本 0.1.0",

  "sc.title": "CotEditor-win - 键盘快捷键",
  "sc.file": "文件：Ctrl+N 新建 | Ctrl+O 打开 | Ctrl+S 保存 | Ctrl+Shift+S 另存为",
  "sc.edit": "编辑：Ctrl+Z 撤销 | Ctrl+Y 重做 | Ctrl+F 查找 | Ctrl+Shift+F 查找全部 | Ctrl+H 替换",
  "sc.multi": "多重：Ctrl+Shift+H 多重替换",
  "sc.tabs": "标签：Ctrl+W 关闭 | Ctrl+Tab 下一个 | Ctrl+Shift+Tab 上一个 | Ctrl+1..9 切换",
  "sc.preview": "预览：Ctrl+E 全屏 | Ctrl+Shift+E 分屏 | Ctrl+Shift+O 大纲",
  "sc.format": "格式：",
  "sc.sortLines": "  排序行          Ctrl+F5",
  "sc.reverseLines": "  反转行          Ctrl+Shift+F5",
  "sc.moveUp": "  上移行          Ctrl+Shift+\u2191",
  "sc.moveDown": "  下移行          Ctrl+Shift+\u2193",
  "sc.dupLine": "  复制行          Ctrl+Shift+D",
  "sc.delLine": "  删除行          Ctrl+Shift+K",
  "sc.joinLines": "  合并行          Ctrl+J",
  "sc.indent": "  增加/减少缩进   Ctrl+] / Ctrl+[",
  "sc.snippets": "片段：Ctrl+Alt+P 管理 | Ctrl+Alt+1..9 插入",
  "sc.multicursor": "多光标：Ctrl+Click 添加 | Ctrl+Alt+\u2191/\u2193 列选 | Ctrl+D 下一个相同词",
};
