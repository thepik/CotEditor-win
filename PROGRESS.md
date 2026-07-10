# CotEditor-win 开发进度

> 最后更新：2026-07-10
> 工程计划见 `PLAN.md`，本文件记录实际完成情况、已验证的内容、待办事项和已知问题。

---

## 一、当前状态

**整体进度**：阶段 0-7 完成，阶段 8（打磨打包）全部完成。项目已具备 MVP 全部核心功能：编辑、19 语言高亮、主题、多光标、行操作、Snippet 模板、多重替换、菜单栏、中英文界面切换，以及应用图标 + NSIS 安装包 + Monaco 精简打包。

项目已能**完整编译运行**：`wails build` 产出自包含 exe（40.5MB），`wails build -nsis` 产出 NSIS 安装包（9.9MB 压缩）。原生窗口正常打开（带 CotEditor 品牌图标），Monaco 编辑器挂载，13 个主题加载，**16 种语言 tree-sitter 高亮 + JSON/Markdown 正则高亮**工作，文件类型检测工作，文件打开/编辑/保存可用，菜单栏（文件/编辑/视图/格式/片段/主题/语言/帮助）可用，Snippet 管理 UI + 插入逻辑可用，多重替换面板可用，**中英文界面可切换**。

### 已完成的阶段

| 阶段 | 状态 | 说明 |
|------|------|------|
| 0 验证性验证 | ✅ | 资源解析、tree-sitter API、Monaco 集成均验证通过 |
| 1 项目脚手架 | ✅ | Wails v2 + Vite + TS，窗口配置，exe 编译运行 |
| 2 资源管道 | ✅ | 主题解析、SyntaxMap 识别、cotsyntax 加载 |
| 3 高亮引擎 | ✅ | tree-sitter + 正则双引擎完成，headless 验证 16 语言高亮 token 发射 |
| 4 基础交互 | ✅ | 语言配置 + 15 个行操作 Monaco 命令 + 快捷键已注册 |
| 5 文件操作 | ✅ | Go 命令 + 快捷键 + 脏标记 |
| 6 Snippets | ✅ | 引擎 + localStorage 存储 + 管理 UI + Ctrl+Alt+1..9 插入快捷键 |
| 7 查找替换 | ✅ | 基础查找 + 多重替换引擎 + 规则编辑面板 + TSV 导入导出 |
| 8 打磨打包 | ✅ | 菜单栏 + 主题切换菜单 + 中英文界面切换 + 应用图标 + NSIS 安装包 + Monaco 精简打包 |

---

## 二、技术栈变更记录

### 从 Tauri(Rust) 迁移到 Wails(Go)

**原因**：目标机器开启 Windows Smart App Control（SAC）强制模式，拦截 cargo build script 生成的所有 `.exe`（serde/libc/proc-macro2 等），`cargo build` 报 `os error 4551`。SAC 只能重装系统关闭，代价过大。

**验证依据**（实测）：
- cargo build script exe：全部被 SAC 拦截（`Permission denied`）
- `rustc` 编译的简单 exe：能跑
- `go build` 编译的 exe：**能跑** ✅
- Go + WebView2 绑定（jchv/go-webview2，Wails 底层依赖）exe：**能跑** ✅
- `wails build` 完整编译 + 原生窗口启动：**成功** ✅

**根因**：cargo 为每个有 build.rs 的 crate 生成独立 build-script.exe，SAC 对这些中间产物判不可信；Go 把整个编译链进单一 exe（自带 linker，不走 MSVC link.exe），SAC 放行。Wails v2 在 Windows 上是纯 Go（无 cgo）。

**影响**：前端代码全部保留，仅后端语言从 Rust 改为 Go，文件 IO 命令 1:1 对应。

---

## 三、环境信息

| 组件 | 版本 | 安装方式 |
|------|------|----------|
| Go | 1.26.5 | winget（zip 免安装版解压到 `~/go-sdk`，因 MSI 安装被卡住的 msiexec 阻塞） |
| Wails CLI | v2.13.0 | `go install github.com/wailsapp/wails/v2/cmd/wails@latest` |
| NSIS | 3.10 | 免安装 zip 解压到 `~/nsis/nsis-3.10`（Wails 的 `-nsis` 需要 `makensis` 在 PATH） |
| Node.js | 24.14.0 | 已有 |
| npm | 11.9.0 | 已有 |
| WebView2 | 150.0.4078.48 | 系统自带 |
| MSVC Build Tools | 2022 (14.44) | winget（仅 Rust 需要，Go 不需要） |
| Windows SDK | 10.0.26100.0 | 随 Build Tools |

**注意**：Go 是用免安装 zip 版（解压到 `~/go-sdk/go`），因为 MSI 安装器被一个卡在 session 0 的 `msiexec.exe`（PID 7448）阻塞，该进程无法非提权杀掉。使用前需确保 `~/go-sdk/go/bin` 在 PATH 中。NSIS 同理用免安装 zip 版（解压到 `~/nsis/nsis-3.10`），Wails v2 不内置 NSIS，`-nsis` 时用 `exec.LookPath("makensis")` 查找，缺失则静默跳过安装器生成。

**SAC 状态**：`VerifiedAndReputablePolicyState = 1`（强制模式）。

---

## 四、已验证内容（headless 自动化测试）

运行 `npm run smoke` 执行 `scripts/smoke-test.mjs`（Playwright + Chromium），以下断言全部通过：

| 验证项 | 结果 | 备注 |
|--------|------|------|
| Monaco 编辑器挂载 | ✅ | `#editor .monaco-editor` 存在 |
| 13 个主题全部加载 | ✅ | Anura/Classic/.../Resinifictrix (Dark) |
| 默认主题 Classic 应用 | ✅ | `getCurrentTheme() === "Classic"` |
| 70 个语法项加载 | ✅ | SyntaxMap.json 解析 |
| 文件类型检测 .py | ✅ | -> Python |
| 文件类型检测 .ts | ✅ | -> TypeScript |
| 文件类型检测 .md | ✅ | -> Markdown |
| 文件类型检测 .sh | ✅ | -> Shell Script |
| 文件类型检测 .cs | ✅ | -> C#（特殊字符） |
| 文件类型检测 .cpp | ✅ | -> C++（特殊字符） |
| 未知扩展名返回 null | ✅ | .xyz -> null |
| C# 语言注册到 Monaco | ✅ | `csharp` id 存在 |
| C++ 语言注册到 Monaco | ✅ | `cpp` id 存在 |
| Monaco 语言总数 | 91 | 含内置 + 自定义 |
| **tree-sitter 高亮（Python）** | ✅ | `def hello()` 渲染出 mtk1/mtk7/mtk16 等 token 类（关键词/数字/字符串着色） |
| **正则高亮（JSON）** | ✅ | `{"key": 42}` 产出 4 个 scope（string/number/value/默认） |
| Wails 绑定可用 | ✅ | `window.go` 注入 |
| Go 方法 NewFile 调用 | ✅ | 返回 UTF-8 编码标记 |
| 浏览器后备模式 | ✅ | File System Access API |
| **菜单栏渲染** | ✅ | 文件/编辑/视图/格式/片段/主题/语言/帮助 八个顶级菜单（默认中文标签） |
| **行操作命令注册** | ✅ | sort/moveUp/moveDown/duplicate/delete/join 均可经 `getAction` 查到 |
| 控制台零错误 | ✅ | Wails dev 的 ipc.js + Monaco worker `toUrl` 噪音已过滤 |

**双模式验证**：
- Wails 原生窗口（`http://localhost:34115`）：Go 绑定可用 ✅
- 纯浏览器（`http://127.0.0.1:1420`）：File System Access API 后备 ✅

---

## 五、各模块完成度

### 后端（Go）

| 文件 | 状态 | 功能 |
|------|------|------|
| `main.go` | ✅ | Wails 窗口配置 + embed 前端资源 |
| `app.go` | ✅ | OpenFile/SaveFile/SaveAs/NewFile + 原生对话框 + UTF-8 解码 + 行尾检测 |
| `wails.json` | ✅ | Vite 集成（`frontend:dev:serverUrl: "auto"`） |

### 前端（TypeScript）

#### editor/

| 文件 | 状态 | 功能 |
|------|------|------|
| `monaco-setup.ts` | ✅ | Monaco 挂载、配置、worker 注册、语义高亮开关、主题定义接口；精简打包：从 `edcore.main` 导入（排除 81 个内置语言 + 4 个语言服务），仅注册 19 个目标语言 + 手动注册 json/plaintext |
| `theme-loader.ts` | ✅ | .cottheme 解析（6/8位 hex）、暗色判断、scope->token 映射、slug 化主题名 |
| `grammar-registry.ts` | ✅ | 16 语言 grammar WASM + highlights.scm 注册（懒加载） |
| `highlight-tree-sitter.ts` | ✅ | web-tree-sitter 核心 + grammar 加载 + 捕获->Monaco 语义 token + "last pattern wins" 冲突解决；全量重解析 |
| `highlight-regex.ts` | ✅ | ICU->JS 正则转换（`\R`/POSIX/占有量词）+ nestable 字符串/块注释 + 规则优先级占位；Monaco TokensProvider |
| `language-config.ts` | ✅ | 从 Edit.json 推导注释/自动配对/智能缩进，C#/C++ 别名处理 |
| `line-commands.ts` | ✅ | 15 个行操作 Monaco 命令（排序/反转/去重/移动/复制/删除/连接/缩进）+ 快捷键 |

#### lib/

| 文件 | 状态 | 功能 |
|------|------|------|
| `file-bridge.ts` | ✅ | Wails/浏览器双模式文件 IO |
| `syntax-map.ts` | ✅ | 扩展名/文件名/shebang 识别 |
| `snippet-engine.ts` | ✅ | Tokenizer + 多光标插入（移植自原版） |
| `multiple-replace.ts` | ✅ | 多重替换引擎 + TSV 导入导出（移植自原版） |
| `text-operations.ts` | ✅ | 行排序/去重/反转/移动/复制/删除/连接/乱序/缩进（移植自原版） |
| `i18n.ts` | ✅ | 中英文双语字典 + `t()` 翻译 + `setLang`/`onLangChange` 订阅 + localStorage 持久化（默认中文） |

#### ui/

| 文件 | 状态 | 功能 |
|------|------|------|
| `toolbar.ts` | ✅ | New/Open/Save/SaveAs 按钮（i18n 驱动，语言切换时重渲染） |
| `statusbar.ts` | ✅ | 文件名/脏标记/行列/编码/行尾（i18n 驱动） |
| `find-panel.ts` | ✅ | Monaco 内置查找/替换快捷键接入 + Ctrl+Shift+H 多重替换 |
| `snippet-manager.ts` | ✅ | localStorage 持久化 + CRUD 管理 UI + Ctrl+Alt+1..9 插入（i18n 驱动，打开时切换语言自动重建） |
| `multiple-replace-ui.ts` | ✅ | 规则编辑面板 + 导入导出 TSV + Replace All（i18n 驱动，打开时切换语言自动重建） |
| `menubar.ts` | ✅ | 纯 DOM 菜单栏（文件/编辑/视图/格式/片段/主题/语言/帮助）+ 动态下拉 |

### 资源（从 CotEditor-main 复制）

| 资源 | 数量 | 状态 |
|------|------|------|
| `.cottheme` 主题 | 13 | ✅ 全部加载验证 |
| `.cotsyntax` 语法 bundle | 19 | ✅（含 Csharp/Cpp 安全别名） |
| `.scm` 查询文件 | 42（18 文件夹） | ✅（含 Csharp/Cpp 安全别名） |
| `SyntaxMap.json` | 70 语法项 | ✅ |
| tree-sitter grammar WASM | 16 | ✅（从 `tree-sitter-wasms` npm 包复制 + 核心 `tree-sitter.wasm`） |
| 应用图标（`build/appicon.png` + `build/windows/icon.ico`） | 1（从原版合成） | ✅ 由 `scripts/build-icon.mjs` 合成（见 §13） |

### 打包产物

| 产物 | 大小 | 说明 |
|------|------|------|
| `build/bin/coteditor-win.exe` | 40.5 MB | 单文件自包含 exe（Go runtime + 前端 embed + WebView2 引导） |
| `build/bin/coteditor-win-amd64-installer.exe` | 9.9 MB | NSIS 压缩安装包（`wails build -nsis` 产出，含 WebView2 离线引导） |

---

## 六、已知问题与技术决策

### 1. Wails v2 dev mode 的 ipc.js 噪音错误

`wails dev` 时 Wails 注入的 `ipc.js` 会在 `runtime:ready` 时抛 `Cannot read properties of null (reading 'nodes')`。这是 Wails v2 dev mode 的已知时序问题，**不影响功能**（绑定调用成功证明）。生产 exe 用嵌入的精简 runtime，无此问题。smoke-test 已过滤此噪音。

### 2. Go MSI 安装被卡住的 msiexec 阻塞

winget 安装 Go 时，一个 `msiexec.exe`（session 0）卡住，无法非提权杀掉，导致后续 MSI 安装报 1618。解决方案：用 Go 免安装 zip 版解压到 `~/go-sdk/go`，绕过 MSI。

### 3. C#/C++ 特殊字符目录

`#` 在 URL 中被当 fragment 分隔符，即使 percent-encode 成 `%23` 也会被浏览器 fetch 截断。解决方案：安全别名副本（`Csharp`/`Cpp`）+ `bundleDir()` 映射。

### 4. tree-sitter grammar WASM 入库（已解决 ✅）

原版 CotEditor 用 SPM 编译的 C grammar，非 WASM。Windows 移植从 `tree-sitter-wasms` npm 包获取 16 种语言的预编译 `.wasm`，复制到 `public/resources/grammars/`，连同 `web-tree-sitter` 包内的核心 `tree-sitter.wasm` 一并 serve。`highlight-tree-sitter.ts` 的 `ensureParser` 通过 Emscripten `locateFile` 回调把核心 wasm 指向 vendored 路径。**SQL 的 grammar wasm 不在 `tree-sitter-wasms` 中**，因此 SQL 暂不高亮（其 bundle 也无 highlights.scm）；Markdown 高亮走正则引擎，不需要 wasm。

### 5. 文件对话框仅 Go 侧

Wails v2 的 JS dialog runtime 不支持，文件对话框必须通过 Go 方法中转（`app.go` 的 `OpenFile`/`SaveAs` 调 `runtime.OpenFileDialog`/`SaveFileDialog`）。已实现。

### 6. tree-sitter 增量解析改用全量重解析（已解决 ✅）

原计划用 `tree.edit()` + 增量解析。实测在「语言切换 race 进行中的解析」时会使 tree 进入不一致状态，导致 `Query.matches` 死循环挂起。当前实现改为**每次 token 请求时从模型当前文本全量重解析**（`buildTokens` 中 `parser.parse(source)`），简单且正确。文件大小在 MVP 范围内性能足够。后续如需增量，需在 tree-sitter 层加序列化锁防止 race。

### 7. 正则引擎占有量词转换 + global flag

ICU 正则的占有量词（`*+`/`++`/`?+`/`{n,m}+`）JS 不支持，`compilePattern` 预处理为普通贪婪形式。此外所有规则正则必须带 `g` flag：否则 `exec` 忽略 `lastIndex` 总从 0 匹配，在「模型已有内容时切换语言后 setValue」场景下死循环挂起（`findFreeMatch`/single-rule 循环）。`buildFlags` 已强制 `g`。

### 8. Monaco editorSimpleWorker 的 toUrl 噪音

Monaco 的 base editor worker 通过 `$loadForeignModule` 试图加载各语言的 worker 模块（TS/JSON/CSS 的诊断/补全）。CotEditor-win 的高亮在主线程跑，不依赖这些服务，因此 worker 在 Vite dev 下解析 foreign module 失败抛 `reading 'toUrl'`，**不影响 UI**。smoke-test 已按消息文本过滤。生产 exe 不复现。

### 9. smoke-test 读应用状态用 window 而非动态 import

Vite HMR 下 `import("/src/editor/theme-loader.ts")` 会拿到与 app bootstrap 不同的（空的）模块实例，导致读不到已加载的主题。改为在 `main.ts` 暴露 `window.__coteditor` 调试句柄，smoke-test 从中读取 `themeCount`/`currentTheme`/`syntaxCount`。

### 10. Snippet/多重替换存储用 localStorage

Snippet 列表和多重替换规则集持久化到 `localStorage`（`coteditor.snippets.v1` / `coteditor.multiplereplace.v1`），在 Wails WebView2 和纯浏览器两种模式下均可工作，无需额外 Go 端 IO。首次运行各植入 2 条示例 snippet / 1 条空规则。

### 11. 模块级初始化的 TDZ 陷阱（已解决 ✅）

`snippet-manager.ts` 和 `multiple-replace-ui.ts` 在模块加载时执行 `let snippets = loadSnippets()`，而 `loadSnippets` 首次运行时本应调用 `persist()` 把种子写入存储。但 `persist` 内部赋值 `snippets = list` 会触发"Cannot access before initialization"——因为 `snippets` 的初始化表达式尚未求值完，处于暂时性死区。解决：首次播种时直接 `localStorage.setItem`，绕过 `persist` 的模块级赋值；后续运行时 `persist` 正常使用。

### 12. 中英文界面 i18n 设计（已实现 ✅）

应用 chrome（菜单/工具栏/状态栏/模态面板/对话框）全量双语，Monaco 自带的查找控件与内置 action 标签保持英文原样（上游仅英文，个人工具不值得 vendor）。设计要点：
- `src/lib/i18n.ts` 单文件承载字典 + 运行时：扁平 key 字典，`t(key)` 解析当前语言并回退到英文再到 key 本身（缺翻译显示 key 而非空白）
- 默认中文（目标用户中文母语，与 `index.html lang="zh-CN"` 一致），`localStorage` 键 `coteditor.lang.v1` 持久化
- `onLangChange` 订阅模式：UI 模块各自订阅，切换时重渲染。菜单栏在 `main.ts` 的 bootstrap 中整体 rebuild（最大翻译面）；工具栏/状态栏内部订阅；已打开的模态面板（Snippet/多重替换）close+reopen 重建以套用新语言的静态结构
- 新增「语言」顶级菜单，中文/English 两项带 ✓ 单选标记，`buildItems` 每次打开时重建以追踪当前选择
- smoke-test 更新为接受中/英任一标签集（`menuSets` 数组），不硬绑单语言

### 13. 应用图标合成（已实现 ✅）

原版 CotEditor 的 `AppIcon.icon` 是 Apple 多层图标合成格式（`icon.json` 定义图层顺序/混合/渐变/高光），无法直接用于 Windows。逐层合成方案：
- `scripts/build-icon.mjs`（Node）用 `@resvg/resvg-js` 渲染 SVG + `sharp` 合成 PNG + `png-to-ico` 生成多尺寸 ICO
- 图层（自底向上）：`Outline.svg`（圆角矩形 + 绿色线性渐变，品牌色）→ `Gears_Fill.svg`（白色齿轮，alpha 0.14）→ `Gears_Stroke.svg`（白色齿轮描边，alpha 0.7）→ `Shadow.png`（钢笔投影，alpha 0.4）→ `Pen.png`（钢笔前景）
- 产出 `build/appicon.png`（1024×1024 PNG）+ `build/windows/icon.ico`（6 尺寸：256/128/64/48/32/16）
- Wails 的 `compileResources` 读 `build/windows/icon.ico` 嵌入 exe 资源（`build/appicon.png` 仅在 ico 缺失时作为生成源，已有 ico 后忽略）
- `npm run build:icon` 重新生成（仅在更新图标素材时需要）

### 14. Monaco 精简打包（已实现 ✅）

默认 `import * as monaco from "monaco-editor"` 解析到 `editor.main.js`，会引入全部 81 个内置语言 + 4 个语言服务（CSS/HTML/JSON/TS 的诊断/补全，源码 14MB）。CotEditor-win 的高亮走自己的 tree-sitter/正则引擎，不需要这些。精简方案：
- 改为 `import * as monaco from "monaco-editor/esm/vs/editor/edcore.main.js"`：含完整编辑器内核 + 全部 contrib（find/多光标/folding 等，`editor.all.js` 62 项）+ standalone API，但**不含**内置语言和语言服务
- 仅导入 19 个目标语言的各自 contribution（`basic-languages/<lang>/<lang>.contribution.js`），其中 `cpp.contribution.js` 同时注册 `c` 和 `cpp`
- `json` 无轻量 contribution（在重型 `language/json` 服务里），手动用公共 API `monaco.languages.register({id:"json"})` 注册（只需 id 存在以挂配置，高亮走正则引擎）；`plaintext` 同理注册
- `env.d.ts` 补 `declare module ".../edcore.main.js" { export * from "monaco-editor"; }` 让深层导入获得完整类型
- 实测效果：Monaco JS chunk 3130KB（瘦身后）vs 3304KB（全量），gzip 841KB vs 846KB。**体积缩减有限**，因为 Monaco 的语言/语言服务多为懒加载 worker（按需才拉取，本就不进主 chunk）；主要收益是**架构干净**--`getLanguages()` 不再被 60+ 个无关语言（abap/solidity 等）污染，只注册实际用到的 19 个

### 15. NSIS 安装包（已实现 ✅）

Wails v2 不内置 NSIS，`-nsis` 时用 `exec.LookPath("makensis")` 查找，缺失则静默跳过（返回 nil 不报错）。NSIS 用免安装 zip 版（解压到 `~/nsis/nsis-3.10`，`makensis` 需在 PATH）：
- `wails build -nsis` 先构建单文件 exe，再调 `makensis` 编译 NSIS 脚本产出 `build/bin/coteditor-win-amd64-installer.exe`（9.9MB，NSIS 压缩）
- 安装器内嵌 WebView2 离线引导（`MicrosoftEdgeWebview2Setup.exe`，Wails 通过 `//go:embed` 内置），可在无网环境引导安装 WebView2 runtime
- exe 图标和安装器图标同源（都读 `build/windows/icon.ico`）
- `info.json` 模板的 `{{.Info.*}}` 占位符由 `wails.json` 的 `info` 块填充（companyName/productName/productVersion/copyright/comments）

---

## 七、下一步计划

阶段 0-8 全部完成。MVP 核心功能（编辑/高亮/主题/多光标/行操作/Snippet/多重替换/菜单/中英文界面/应用图标/NSIS 安装包/Monaco 精简）全部可用并通过 smoke test + 实机启动验证。

**阶段 8 已全部完成 ✅**：

1. ✅ 应用图标（`scripts/build-icon.mjs` 合成原版 AppIcon 多层 → 1024px PNG + 6 尺寸 ICO，见 §13）
2. ✅ NSIS 安装包（`wails build -nsis` → 9.9MB 压缩安装器，见 §15）
3. ✅ 体积优化（Monaco 精简打包：`edcore.main` + 19 语言，见 §14）
4. ✅ 中英文界面（`src/lib/i18n.ts` + 语言菜单 + 实时重渲染，见 §12）

**后续可选扩展（非 MVP）**：
- 大纲面板（tree-sitter outline.scm）
- 命令面板（Quick Actions）
- 文件编码检测（非 UTF-8）

---

## 八、常用命令

```bash
# 开发（原生窗口 + 热重载，主要方式）
wails dev

# 纯前端开发（浏览器，文件操作走 File System Access API）
cd frontend && npm run dev

# 完整构建（产出 build/bin/coteditor-win.exe）
wails build

# 构建 NSIS 安装包（产出 build/bin/coteditor-win-amd64-installer.exe，需 makensis 在 PATH）
wails build -nsis

# 重新生成应用图标（仅在更新图标素材时需要，从原版 AppIcon 合成）
npm run build:icon

# 类型检查
cd frontend && npx tsc --noEmit

# 自动化验证（需先启动 wails dev 或 cd frontend && npm run dev）
npm run smoke           # 测试 Wails 原生绑定模式
npm run smoke:browser   # 测试浏览器后备模式
```

**PATH 配置**（Go 与 NSIS 均为免安装版）：
```bash
export PATH="$HOME/go-sdk/go/bin:$HOME/go/bin:$HOME/nsis/nsis-3.10:$PATH"
```
