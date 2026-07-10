# CotEditor for Windows（中文版）

[English](./README.md) | **中文**

一个面向 Windows 的轻量级、本地优先的文本/代码编辑器，基于 macOS
[CotEditor](https://github.com/coteditor/CotEditor) 的设计与资源重新实现。

采用 **Wails v2 (Go)** + **Monaco Editor** + **web-tree-sitter** 构建。目标是
打造一个小巧、快速的单窗口编辑器，保留 CotEditor 的核心编辑体验、语法高亮、
主题与代码片段功能，同时摆脱 Electron 的臃肿以及 macOS 专有依赖。

## 功能特性

- **19 种语言语法高亮** —— 其中 16 种通过 tree-sitter 实现（JavaScript、
  TypeScript、Python、HTML、CSS、C、C++、C#、Java、Go、Rust、Ruby、PHP、
  Swift、Kotlin、Bash），另外 JSON 与 Markdown 通过基于原始 `.cotsyntax`
  规则的正则引擎实现。
- **13 套主题** —— 直接从 CotEditor 的 `.cottheme` 文件加载，解析为 Monaco
  主题，并自动识别明/暗模式。
- **多光标编辑** —— Ctrl+点击、列选择、选中下一个匹配项（Monaco 内置）。
- **智能编辑** —— 自动补全配对符号、注释切换，以及根据各语言的
  `.cotsyntax/Edit.json` 派生的智能缩进。
- **15 项行操作** —— 排序、反转、乱序、去重、上移/下移、复制、删除、合并、
  缩进/取消缩进、删除空行、去除行尾空白。
- **代码片段模板** —— 支持 `<<<SELECTION>>>` / `<<<CURSOR>>>` 占位符，支持
  多光标定位与缩进保持。通过面板管理，用 Ctrl+Alt+1..9 插入。
- **查找与替换** —— Monaco 内置查找部件（正则、区分大小写、全字匹配），
  外加一个支持有序规则与 TSV 导入/导出的多重替换引擎。
- **中英双语界面** —— 中英文界面可实时切换（视图 → 语言）。
- **文件操作** —— 通过原生对话框进行打开/保存/另存为/新建，带有未保存
  标记与 UTF-8 编码。

## 截图

应用图标由原始 CotEditor `AppIcon`（绿色圆角方块 + 齿轮 + 钢笔）合成而来。
合成流程详见 `scripts/build-icon.mjs`。


## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 应用外壳 | Wails v2 | Go 后端 + 系统 WebView2；单一自包含 exe |
| 编辑器内核 | Monaco Editor | 多光标、查找/替换、行号——全部内置 |
| 语法高亮 | `web-tree-sitter` + 原始 `.scm` 查询 | 16 种语言；语法 WASM 懒加载 |
| 正则高亮 | 自研 ICU→JS 正则引擎 | JSON、Markdown（解析 `.cotsyntax/Regex/Highlights.json`） |
| 前端 | TypeScript | 原生 DOM，无 React/Vue |
| 打包器 | Vite | Wails 默认 |
| 后端 | Go（极简） | 仅文件 IO + 原生对话框 |

## 构建与运行

### 前置要求

- **Go** ≥ 1.21 —— <https://go.dev/dl/>
- **Node.js** ≥ 20 及 npm
- **WebView2 Runtime** —— Windows 10/11 已预装
- **Wails CLI** —— `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- **NSIS**（可选，用于生成安装包）—— 安装并确保 `makensis` 在 `PATH` 中

在 Windows 上无需 C 编译器 / cgo —— 本项目中的 Wails 是纯 Go。

### 开发

```bash
# 原生应用 + 热重载（编译 Go + 启动 Vite）
wails dev

# 仅前端（浏览器环境，使用 File System Access API 进行文件 IO）
cd frontend && npm run dev

# 类型检查
cd frontend && npx tsc --noEmit

# 无界面冒烟测试（需先启动开发服务器）
npm run smoke           # Wails 原生绑定模式
npm run smoke:browser   # 浏览器回退模式
```

### 生产构建

```bash
# 独立 exe → build/bin/coteditor-win.exe（约 40 MB，内嵌前端）
wails build

# NSIS 安装包 → build/bin/coteditor-win-amd64-installer.exe（约 10 MB，已压缩）
wails build -nsis
```

### 重新生成应用图标

仅在更新图标源资源时需要（资源来自原始 CotEditor `AppIcon.icon`）：

```bash
npm run build:icon
```

该命令将分层图标（`Outline.svg` 渐变 + 齿轮 + 钢笔/阴影）合成为
`build/appicon.png`（1024px）与 `build/windows/icon.ico`（6 种尺寸），
Wails 会将它们嵌入 exe 与安装包。

## 项目结构

```
main.go, app.go              Wails Go 后端（窗口 + 文件 IO 方法）
wails.json                   Wails 项目配置（Vite 集成）
go.mod / go.sum              Go 模块
frontend/
  src/
    main.ts                  引导：编辑器 + 主题 + 语法 + UI 接线
    editor/
      monaco-setup.ts        Monaco 挂载 + 精简语言注册
      theme-loader.ts        .cottheme → Monaco 主题解析
      grammar-registry.ts    tree-sitter 语法 WASM + .scm 查询注册
      highlight-tree-sitter.ts  tree-sitter → Monaco 语义 token
      highlight-regex.ts     ICU→JS 正则 → Monaco TokensProvider
      language-config.ts     .cotsyntax/Edit.json → Monaco 语言配置
      line-commands.ts       15 项行操作命令 + 快捷键
    lib/
      file-bridge.ts         Wails/浏览器双模式文件 IO
      syntax-map.ts          文件类型检测（SyntaxMap.json）
      snippet-engine.ts      代码片段分词器 + 插入
      multiple-replace.ts    多重替换引擎 + TSV 导入/导出
      text-operations.ts     行处理算法
      i18n.ts                双语词典 + 运行时（zh/en）
    ui/
      menubar.ts, toolbar.ts, statusbar.ts
      find-panel.ts, snippet-manager.ts, multiple-replace-ui.ts
    wailsjs/                 自动生成的 Wails 绑定（请勿手动编辑）
  public/resources/          内置 CotEditor 资源
    themes/                  13 个 .cottheme 文件
    syntaxes/                19 个 .cotsyntax 捆绑包（+ Csharp/Cpp 别名）
    queries/                 tree-sitter .scm 高亮/大纲/注入查询
    grammars/                tree-sitter 语法 WASM（已 gitignore，需拉取）
    SyntaxMap.json           文件类型自动检测映射
  vite.config.ts, tsconfig.json, package.json
build/
  appicon.png                1024px 应用图标（icon.ico 的来源）
  windows/
    icon.ico                 多尺寸 Windows 图标（嵌入 exe）
    info.json, wails.exe.manifest  版本资源 + 清单模板
scripts/
  build-icon.mjs             图标合成（SVG 分层 → PNG → ICO）
  smoke-test.mjs             无界面验证（Playwright + Chromium）
```

## 资源来源

所有语法主题、`.cotsyntax` 捆绑包以及 tree-sitter `.scm` 查询均逐字复制自
原始 CotEditor，并以静态文件形式提供。tree-sitter 语法 WASM 来自
[`tree-sitter-wasms`](https://www.npmjs.com/package/tree-sitter-wasms) npm
包（已 gitignore；运行 `npm install` 拉取）。

> **特殊字符别名：** `C#` 与 `C++` 捆绑包/查询中包含 `#` 和 `+`，会破坏开发
> 服务器中的 URL 路径解析（`#` 会被当作片段标识符）。它们旁边保留了安全名称
> 的副本（`Csharp`、`Cpp`），`language-config.ts` 通过 `bundleDir()` 映射到
> 这些别名。

## 文件 IO

文件打开/保存由 `frontend/src/lib/file-bridge.ts` 抽象封装：

- **Wails 模式** —— 通过生成的 `wailsjs/go/main/App.js` 包装器调用 `app.go`
  中的 Go 方法（`OpenFile` / `SaveFile` / `SaveAs` / `NewFile`）。原生文件
  对话框在 Go 侧实现（Wails v2 的 JS 对话框 API 不支持）。
- **浏览器模式**（开发回退） —— 使用 File System Access API。

## 限制 / 不在范围内

- 单文档（无标签页 / 侧边栏）。
- 仅支持 UTF-8（不对其他编码进行自动检测）。
- SQL 没有可用的 tree-sitter 语法 WASM，因此不做高亮。
- 无云同步、QuickLook、AppleScript 或自动更新。
- 界面仅支持中文/英文。

## 致谢

- [CotEditor](https://github.com/coteditor/CotEditor) —— 原始 macOS 编辑器，
  本项目复用了其设计、主题、语法定义与 tree-sitter 查询。
- [Wails](https://wails.io)、[Monaco Editor](https://microsoft.github.io/monaco-editor/)
  与 [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) —— 让本移植
  项目得以实现的框架。

## 许可

CotEditor 的主题、语法与查询保留其原始许可。
本仓库中的应用代码仅供个人使用。
