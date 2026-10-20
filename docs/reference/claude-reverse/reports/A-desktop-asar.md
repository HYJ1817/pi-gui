# 报告 A — Claude Desktop 2.42304.0 · ASAR 全量解剖

> 目标：`C:/Program Files/WindowsApps/Claude_2.42304.0.0_x64__pzs8sxrjxfjjc/app/resources/app.asar`
> sha256 `8f4d3dec5e4f3ddffb150321060b18807d83a40f3a65618fe4f29325379da9db` · 49,338,428 B · **506 entries**
> 提取落盘：`C:/claude逆向素材/claude-app-asar/`（76.3 MB，6 unpacked，0 links）
> 逐文件 sha256：`claude-app-asar/_manifest.json`

---

## 1. 顶层结构

| 目录 | 内容 |
|---|---|
| `.vite/build/` | **377 文件** — Electron 主进程 + 全部 preload/worker（354 个 `index.chunk-*` + 23 个命名入口） |
| `.vite/renderer/` | 6 个本地窗口：`main_window` `about_window` `buddy_window` `find_in_page` `local_exec_consent` `quick_window` |
| `compile-cache/` | `.jsc` — V8 code cache（**热路径预编译字节码，非源码**） |
| `resources/` | `artifact-libs/` `bundled-skills/` `github-mcp/` `office365-mcp/` |
| `node_modules/` | 打包进 asar 的运行时依赖（含 `@ant/claude-native`、`node-pty`） |

文件类型：431 `.js` (29.4 MB) · 21 `.woff2` (2.85 MB) · 16 `.css` · 6 `.html` · 6 `.skill` · 4 `.node` · 4 `.mjs` · 3 `.jsc`

最大文件：`resources/github-mcp/github-mcp-server.exe` 19.6 MB → `resources/office365-mcp/office365-mcp-stdio.mjs` 6.95 MB → `.vite/build/index.chunk-lzaSYO3Q.js` **6.75 MB（主 bundle）** → `compile-cache/index.chunk-lzaSYO3Q.js.x64.jsc` 6.54 MB（同文件字节码）→ `claude-native-binding.node` 3.6 MB

`package.json`：`@ant/desktop` / productName `Claude` / `2.42304.0` / main `.vite/build/index.pre.js` / node ≥22

---

## 2. 运行时拓扑

```
main process  ── .vite/build/index.pre.js (930 KB) ──> index.js ──> index.chunk-*(354)
   │
   ├─ BrowserWindow  B        (Di.MAIN_WINDOW)      ← 本地 shell: main_window/index.html
   │     └─ WebContentsView  V (Di.CLAUDE_AI_WEB)   ← 远程 https://claude.ai 渲染
   ├─ WebContentsView  no     (Di.FIND_IN_PAGE)     ← find_in_page 窗口
   ├─ BrowserWindow    qK     (Di.QUICK_ENTRY)      ← 606×470 常驻置顶浮窗
   ├─ Window                   (Di.ABOUT)
   ├─ Window                   (Di.CUSTOM3P_SETUP / CUSTOM3P_DEVICE_CODE)
   ├─ Window                   (Di.IN_APP_BROWSER + artifact popout 窗口族)
   └─ Workers × 8
```

**窗口标识枚举 `Di`**：`CLAUDE_AI_WEB="claude.ai-web"` `FIND_IN_PAGE` `ABOUT` `MAIN_WINDOW` `QUICK_ENTRY="quick-entry-window"` `CUSTOM3P_SETUP` `CUSTOM3P_DEVICE_CODE` `IN_APP_BROWSER`（另有 `Hme = ["main", ...]` 全量清单）

**22 个命名入口**（`index.chunk-*` 之外）：

| 层 | 文件 |
|---|---|
| preload | `mainWindow.js` `mainView.js` `aboutWindow.js` `quickWindow.js` `findInPage.js` `buddy.js` `localExecConsent.js` `designWindow.js` `claudePagePreview.js` `coworkArtifact.js` `computerUseTeach.js` `computerUseWatchRecord.js` `watchRecordChooser.js` |
| worker | `file-index-worker/` `heavy-work-worker/` `mcp-runtime/`(`directMcpHost.js` `nodeHost.js`) `msal-broker-worker/` `pty-host/` `shell-path-worker/` `stall-sampler-worker/` `transcript-search-worker/` |
| 主入口 | `index.pre.js` → `index.js` |

`pty-host` + `node-pty` + `conpty*.node` ⇒ 内建终端；`msal-broker-worker` + `office365-mcp` ⇒ Office 集成；`stall-sampler-worker` ⇒ 卡顿采样器。

---

## 3. 安全基线（所有 WebContents 共用）

```js
{ sandbox: true, contextIsolation: true, nodeIntegration: false,
  nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
  webviewTag: false, navigateOnDragDrop: false, spellcheck: false,
  enableBlinkFeatures: "", backgroundThrottling: true,
  disableHtmlFullscreenWindowResize: true }
// devTools: !app.isPackaged
```
`setWindowOpenHandler` 一律 `{action:"deny"}`（quick entry / artifact popup），window-open 走 `LI()/J9()` 允许表 + `q9()` 日志。
导航白名单 `Ol()`：仅允许 `Yze` 集合内 host 或 `CLAUDE_HYBRID_BOOTSTRAP_URL`（仅未打包）。

---

## 4. 布局度量（真值，全部来自主 bundle 常量）

### 4.1 外壳与侧栏

| 常量 | 值 | 含义 |
|---|---|---|
| `oZn.sidebarWidth` | **288** | 侧栏默认宽度（px） |
| `oZn.collapsed` | `false` | 默认展开 |
| `oZn.narrowViewportMaxWidth` | **700** | 视口宽度 ≤700 自动折叠 |
| `--boot-placeholder-sidebar-width` | `sidebarWidth * scale` px | 首帧占位侧栏宽 |
| `--boot-placeholder-scale` | `zoomFactor / shellZoomFactor` | 占位整体缩放 |

### 4.2 标题栏 / Windows 覆盖层

| 常量 | 值 |
|---|---|
| `PYn` | **44** — main 窗口标题栏高 |
| `FYn` | **24** — 覆盖层最小高 |
| `GKn` / `KKn` | main / popout 基础高（×zoom 后取 `max(24, round(base*factor))`） |
| 浅色 overlay | color `#f9f8f4`，symbol `#000` |
| 深色 overlay | color `#141412`，symbol `#fff` |
| 透明 | `#00000000` |
| 本地 shell CSS 默认 `titleBarHeight` | **36**（`MainWindowPage` 的 `E` 组件默认参数） |

调用：`BYn(win)` → `win.setTitleBarOverlay(JSON)`，按 `JSON.stringify` 结果缓存去重，失败落 `LYn` 黑名单（"this is probably expected"）。

### 4.3 缩放

| 常量 | 值 |
|---|---|
| `UIi`（缩放步长） | **0.5** zoomLevel |
| actual size | `setZoomLevel(0)` |
| 量化函数 `AKn` | level 对齐到 0.5 网格 |
| 菜单启用判定 | `zoom-in` 需 `level < kKn`，`zoom-out` 需 `level > OKn` |

### 4.4 浮窗尺寸

| 窗口 | 尺寸 / 约束 |
|---|---|
| quick entry `qK` | **606 × 470**，`alwaysOnTop(true,"pop-up-menu")`，`closable:false`，`show:false`，清理延迟 `R5r=30` |
| artifact popout | `minWidth 320` × `minHeight 240`，默认 `800 × 600`（`GYn/KYn`），`useContentSize:true`，`frame:true`，`autoHideMenuBar:true` |
| 轮询/节流 | popup 存活检查 2s（`XYn=2000`），关闭延迟 250ms（`ZYn`） |

### 4.5 首帧占位骨架（`tZn` 内联脚本，最精确的本地布局证据）

```
行 1:  top 188, left 14, w 88,  h 10          （标题占位）
行 n:  top 218 + i*26 (i=0..4)                （导航行，间距 26）
       每行: 图标 {top:+3, left:19, 6×6, r:3}
             文本 {left:38, w: round((sidebarWidth-20) * ratio)}
             ratio = [.68, .54, .44, .68, .54]
```
`data-boot-placeholder-frame` ∈ `sidebar` | `collapsed`；`root.style.setProperty("--boot-placeholder-*")`。
`paintShapes()` 最多接受 **160** 个 shape。

---

## 5. 本地 shell 组件树（`main_window/index.html` → `MainWindowPage-BM1J3SeB.js`）

```
<html class="cds-root" data-mode="system" data-density="comfortable" data-platform="desktop">
  #root
    └─ MainWindowPage (React)
         ├─ TitleBar            h=36, 类 nc-drag；子元素 nc-no-drag
         │    ├─ MenuButton     （Windows/Linux；图标 = icon "Menu"）
         │    └─ <title 文本>
         ├─ BootPlaceholder     首帧骨架（§4.5），加载完成后移除
         ├─ ErrorOverlay        icon "Warning" + 重试
         ├─ ErrorDetailsPanel   <details> 折叠 + 复制诊断
         └─ <webview 宿主>       ← 实际内容由 WebContentsView V 覆盖，非 DOM 子节点
```

**shell 内仅 3 个图标**：`Menu` `Spinner` `Warning`（`{name:"X",master16:…}` 结构）。
整机 icon set（anthropicons）不在 asar 内 ⇒ 由远程 claude.ai bundle 提供。这与 `claude-design-tokens/NOTICE.md`「只提 CSS，不含源码/字体/图标」的边界一致。

**CSS**：`MainWindowPage-DTxMhyWF.css` 251 KB / 2 行 / **747 规则 / 6 个顶层块**；`@layer theme` `@layer cds-card`；`@supports color-mix(...)`；容器查询 `width>=48rem`；64 处 `.cds-root`。
主题落地：`html[data-mode]` + `prefers-color-scheme` + `body.darkTheme`。
拖拽：`.nc-drag` / `.nc-no-drag`。

---

## 6. IPC / API 面（详见 `out/IPC.md` `out/API-SURFACE.md`）

- 通道格式：`$eipc_message$_<uuid>$_<interface>$_<Class>$_<method>`
- **16 接口前缀 / 94 类 / 1401 方法 / 17 observable store**
- 关键 UUID：`fcb91d11-972d-4fd6-b90b-72739699bff5`（electron_window）、`6010a08f-a0fa-48b4-99da-0689b9e2de7b`（`claude.web.*`）
- Top 类：`LocalSessions` 339 · `LocalAgentModeSessions` 134 · `Launch` 111 · `Simulator` 71 · `Custom3pSetup` 41 · `CoworkSpaces` 34 · `Extensions` 28 · `EngineSurface` 25 · `CoworkArtifacts` 25 · `ClaudeAiImport` 24 · `ClaudeVM` 22 · `MenuEvents` 21 · `WindowState` 21 · `FileSystem` 19
- `exposeInMainWorld` 18 个全局：`window.buddy` `buddyBle` `claudeAppBindings` `claudeAppSettings` `claudeDesktopArtifactPane` `cowork` `desktopBootFeatures` `desktopBootPlaceholder` `desktopDeviceClass` `desktopEnterpriseConfig` `desktopEssentialTelemetryDisabled` `desktopManagedConfig` …

---

## 7. 随包资源

| 资源 | 内容 |
|---|---|
| `resources/artifact-libs/` | `chart.js@4.5.0` UMD · `gridjs@5.0.2` UMD + mermaid 主题 CSS · `mermaid@11.17.2` |
| `resources/bundled-skills/` | `docx.skill` `pdf.skill` `pdf-reading.skill` `pptx.skill` `xlsx.skill` `frontend-design.skill` |
| `resources/github-mcp/` | `github-mcp-server.exe` 19.6 MB |
| `resources/office365-mcp/` | `office365-mcp-stdio.mjs` 6.95 MB + `msal-node-runtime.node` + `msalruntime.dll`（unpacked） |
| `app.asar.unpacked/` | 6 个：`claude-native-binding.node`、`node-pty/prebuilds/win32-x64/{conpty,conpty_console_list}.node`、上面 3 个 MCP/office 文件 |
| 同目录非 asar | `ion-dist/`（本地推理？）、`smol-bin.x64.vhdx`（Cowork VM 镜像）、`claude-ssh-*.exe`、`cowork-svc.exe`、`chrome-native-host.exe`、40+ 语言 JSON（`en-US.json` 837 键 / `zh-Hans.json` 42 KB，扁平 `messageId → string`） |

---

## 8. 明确边界（不要误判）

1. **UI 主体不在 asar**。窗口内是 `WebContentsView` 加载 `https://claude.ai`，聊天界面/侧栏/输入框/消息气泡全部是远程代码。asar 只提供外壳（标题栏、占位骨架、错误页、菜单、托盘、浮窗）。
2. **因此「全量组件树」最多只能到 §5**。想要 claude.ai 侧的组件树得抓运行时 DOM（走 `--remote-debugging-port` + CDP），不是解包能做到的。
3. `compile-cache/*.jsc` 是字节码缓存，改 `.js` 后 Electron 会校验/失效重编译，不代表不可改——但 renderer 主 bundle 走 Vite/rolldown，改 asar 需重新生成 asar 头（本仓库 `src/asar.mjs` 只实现了读）。
4. 语言文件里没有 UI 文案主体（837 键远少于一个完整聊天应用）——同样印证 1。

---

## 9. 复现

```bash
node C:/claude逆向素材/analysis/extract-all.mjs      # → claude-app-asar/ + _manifest.json
python C:/claude逆向素材/analysis/ipc_map.py         # → out/ipc-map.json, out/IPC.md
python C:/claude逆向素材/analysis/api_surface.py     # → out/api-surface.json, out/API-SURFACE.md
python C:/claude逆向素材/analysis/css_rules.py       # → out/css-selectors.json
python C:/claude逆向素材/analysis/menu_full.py       # → out/menu-tree.json, out/MENU.md
python C:/claude逆向素材/analysis/accel_sweep.py     # → out/accelerators.json
```
