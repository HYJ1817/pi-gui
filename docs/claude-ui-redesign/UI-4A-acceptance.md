# UI-4A：右侧工作区与多面板交互（Agent A）

日期：2026-10-17，Asia/Shanghai。工作区 `C:/pi-GUI-ui4-pane`；分支 `codex/ui4-pane`；
共同基线 `17f855f01fedb7b13a13496ba45ebf8d28e465ac`（`codex/ui3-integration`）。
范围：**只做右栏**（外壳、Browser 面、Changes 面、开发进程面、本会话变更面的布局/组件/交互）。
未推送、未合并、未升级版本、未发版、未进入其它 Agent 的文件。

结论：右栏四面共用一条 46px 标题带，Browser 的原生 `WebContentsView` 生命周期（挂载/撤离/边界跟随/弹层遮挡）全部有真实 Electron 断言，
本会话变更与开发进程的层级、空/加载/错误/过期状态、长路径与长日志、不可信文本呈现均有断言与截图；
新增 `tests/ui4-pane.cjs` **280/280**，35 张真实截图；既有相关套件复跑无下降。
**集成方仍需在 `public/index.html` 里加一行 `<link rel="stylesheet" href="/ui4-pane.css">`**（见第 8 节），否则这些视觉规则不生效。

## 1. 预检

| 检查 | 结果 |
|---|---|
| 目标 worktree 是否已存在 | **不存在**，按指定基线新建 `git worktree add -b codex/ui4-pane C:/pi-GUI-ui4-pane 17f855f` |
| 共同基线 | `git cat-file -t 17f855f…` → `commit`；`C:/pi-GUI` 的 HEAD 仍是 `d0585b8`（UI-1），UI-3 集成分支停在 `17f855f` |
| 基线工作区是否有未提交修改 | 本 worktree 创建后 `git status --short` 为空（原仓库的未跟踪素材不属于本任务，未触碰） |
| 依赖 | 本 worktree 无 `node_modules`。按 UI-2/UI-3 同样做法链接本机已有目录（`mklink /J node_modules C:\pi-GUI\node_modules`，`.gitignore` 已忽略），**没有联网、没有新增依赖** |
| 读过的材料 | `AGENTS.md`；`docs/claude-ui-redesign/UI-2-integration-acceptance.md`、`UI-3-integration-acceptance.md`、`UI-design-contract.md`、`UI-component-mapping.md`、`UI-implementation-plan.md`（UI-4 段）；`docs/claude-code-layout-spec.md` §6；Claude Code 实机截图 `22-44-58`（文件预览面板：标题胶囊 + 关闭 + 右侧工具图标、面包屑、内容）与 `22-44-26`/`22-43-12`（主区与输入区）；`docs/browser.md`、`docs/git-changes.md` |

## 2. 勘察结论（以现有代码为准）

现有实现里已经有好用的抽象，本轮**复用而不是覆盖**：

| 现成事实 | 位置 | 本轮的用法 |
|---|---|---|
| 右栏只懂「开/关、多宽、哪一面、viewport 矩形、是否被弹层遮住」 | `public/right-pane.js` | 保持这一边界，**没有**让它认识 browser/process |
| 面（surface）注册与关闭按钮追加 | `public/ui/secondary-surface.js` 的 `openSecondarySurface(view, mount, {headerSelector})` | 用它已有的 `headerSelector` 把共享关闭按钮放进新标题带，**没有改这个文件** |
| 「文件变更」的标题行 = `h3 + .chg-sub + .grow + 按钮` | `public/git.js` | 把它当成标题带的**参照结构**，另外三面按同一顺序画 |
| 地址栏工具栏 | `public/browser-pane.js` | 只读；靠 CSS 对齐到同一条带，不改原生视图所有权与策略 |
| 进程的状态/日志/权限事实 | `process-panel.js` + `server/` 的既有接口 | 只改呈现；`.process-meta` 仍是状态文字的唯一事实源 |
| 会话变更的只读证据与预览 | `session-changes-panel.js` + 既有 HTTP | 只改层级与状态呈现；未开放写回 |
| 弹层遮挡 | `right-pane.js` 的 `MutationObserver` → `setOccluded` | 原样沿用，只补断言 |

**与任务设想偏离的三处**（都有理由，见第 8 节）：没有给 Browser 面新画标题（`browser-pane.js` 只读，地址栏承担身份）；默认宽仍是 420 而不是 327；没有在右栏里造「面板切换 tab」。

## 3. 文件所有权与实际改动

| 文件 | 状态 | 改动性质 |
|---|---|---|
| `public/right-pane.js` | 改 | 新增 `createPaneHeader()` 与 `RIGHT_PANE_LIMITS`；分隔条读屏语义（`aria-valuemin/max/now/valuetext/controls`）、`Home`/`End`/双击复位；关闭后焦点还原到「打开前的那个入口」，找不到才退回既有按面名映射 |
| `public/session-changes-panel.js` | 改 | 标题带改用 `createPaneHeader`；页签独占一行；概览卡 + 状态标记；文件行加状态字母/路径 title/元信息分层；空态/加载/错误/过期分档；`workspaceMatches` 增加 `unknownMeansSame`（见第 4 节） |
| `public/process-panel.js` | 改 | 标题带改用 `createPaneHeader`（带刷新）；权限行单独一行；状态点；空态区块；日志高度按视口收缩；**所有既有守卫逻辑原样保留**（generation/revision/cursor/workspace、串行 `loading`、1s 轮询、dispose） |
| `public/ui4-pane.css` | 新建 | 右栏布局与组件样式增量，只消费 `--ui-*` 语义 Token 及其别名；新增的两个自定义属性是**布局**值（`--rp-head-h`/`--rp-pad`），声明在 `.right-pane` 上，不外溢 |
| `tests/ui4-pane.cjs` | 新建 | 真实 Electron + 离线夹具验收（第 6 节） |
| `docs/claude-ui-redesign/UI-4A-acceptance.md`、`ui4a-evidence/` | 新建 | 本文档与证据（35 张截图、`results.json`、`run.log`） |

**未改**：`public/app.js`、`public/index.html`、`public/styles.css`、`public/tokens.css`、`public/browser-pane.js`、`public/runtime-secondary.js`、`public/git.js`、`public/ui/secondary-surface.js`、`package.json`、`server/`、`lib/`、`electron/`、`extensions/`，以及 Agent B/C 的任何文件。Git 状态见第 9 节。

## 4. 统一后的右栏结构（A1）

四面（Browser / 文件变更 / 本会话变更 / 开发进程）在**不改各自 DOM 归属**的前提下，被对齐成同一条标题带：

```
[标题] [一行说明（窄了先让位）]  ......  [工具按钮] [×]
```

| 统一项 | 实现 | 断言 |
|---|---|---|
| 带高 | `.right-pane{--rp-head-h:46px}`，四面同一高度（Browser 的 `.rp-toolbar` 本来就是 46px） | 矩阵 8×4 状态下每面都断言 `headHeight === 46±1` |
| 标题排版 | `.rp-head-title` / `.chg-head h3`：13px、600、单行省略 | 同上 |
| 一行说明 | `.rp-head-sub` / `.chg-sub`：11px muted，`@container (max-width:360px)` 时隐藏 | 「默认宽度下标题带会显示说明行（窄了才让位）」 |
| 工具按钮 | `.rp-btn`/`.rp-tab` 统一 26px 高；关闭按钮 `.secondary-close` 与 Browser 的 `.icon-btn` 同一个 26px 方块 | 「关闭按钮落在标题带最右端」 |
| 分隔线与间距 | 标题带 `border-bottom`；内容区 `--rp-pad:12px` | 截图矩阵 |
| 滚动 | 标题带 `position:sticky`；`.rp-scroll`/`.chg-body` 自己滚 | 「内容能滚，标题带位置不动」 |
| 状态标记 | `.rp-chip`（证据完整度/归因缺口/过期/预览资格）、`.rp-empty`、`.rp-loading`、`[data-tone=error|warn|info]`、进程状态点 | 会话变更与进程各一组断言 |

**没有新增虚假入口**：右栏里没有终端、命令输入、编辑器、PDF 阅读器、执行按钮。
断言「开发进程里没有命令输入」与「空态不给假的操作入口」把这一点钉住。

**既有操作全部保留**：关闭（`#rightPaneClose`/`#browserClose`）、返回（前进/后退/刷新）、面切换（顶栏 `btnBrowser`/`navChanges`/「更多」菜单，仍由 `app.js` 拥有，本任务没有在右栏里另造一套 tab）。

## 5. Browser / Changes / Processes 的真实边界（A2、A3）

### Browser（A2）

架构未动：`browser-pane.js` 造工具栏 + `pane.onViewport` 量矩形 → 主进程 `electron/browser-view.cjs` 用 `WebContentsView` 承载。
没有改：权限策略、导航允许规则（loopback only）、host 绑定、原生窗口所有权、非 persist partition。

| 验收点 | 实测（真实 Electron） |
|---|---|
| 显示与关闭 | 打开后 `#rightPane` surface=`browser`；`#browserClose` 关闭后 `hidden` |
| 面板标题与操作状态 | 工具栏 + 地址栏在 46px 带内；未导航时后退/前进真实 `disabled`；错误条只在失败时出现 |
| 右栏宽度变化 | 拖动分隔条后 `#browserViewport` 变窄，原生 view `getBounds().width` 与之同步（±2px） |
| Browser ↔ Changes 切换 | 切面后 `#browserToolbar` 卸载、原生 view 撤离；切回按用户宽度重建 |
| 聚焦不同会话的归属 | 由既有 `runtime-secondary.js`/`runtime-browser.cjs` 负责，本轮**未改**；复跑 `runtime-secondary 17/17`、`runtime-git-ui 6/6` |
| 右栏隐藏后原生视图撤离 | 关闭后 `browser.getWebContents()` 为空或不挂在 `contentView` 上 |
| 弹层打开时的遮挡 | 打开「更多」弹层后原生 view 被摘下去，关闭后挂回 |

> 如实记录一条**既有**行为：`Escape` 只由 `#rightPane` 自己的 keydown 接住，
> 焦点还在顶栏入口按钮上时按 `Escape` 不会关面板（测试里把这条写成断言，而不是绕开）。
> 焦点进入面板后 `Escape` 可关，且关闭后焦点回到打开它的那个入口。

### Changes（A3，Classic 文件变更面）

`git.js` 的 DOM 未动，只由 `ui4-pane.css` 参与统一（标题带高度、说明行、滚动容器、按钮尺寸）。
数据仍完全来自 `/api/git/status`、`S.changes` 与 `changes.js` 的账本 —— 右栏**没有**自己数文件、也不把工具声称改过的文件当成 Git 改动。
它在 700/900 覆盖模式与 1200/1536 dock 模式下都通过「无横向溢出 / 关闭按钮在带内」断言。

### 本会话变更（A3，P33 只读面）

| 项目 | 处理 |
|---|---|
| 层级 | 概览卡（真实 `fileCount`/`operationCount` + 状态标记）→ 说明 → 文件行（状态字母 + 等宽路径 + 元信息行 + 行内动作） |
| 状态标记 | `证据完整/不完整`、`归因缺口存在/未记录`、`证据过期`、`内容预览可请求/暂不具备资格`，颜色不是唯一线索 |
| 长路径 | `overflow-wrap:anywhere` + `title` 属性；断言面板与元素都不产生横向滚动 |
| 空态 | `.rp-empty`：「没有已捕获的修改证据；**这不代表文件没有被修改**。」（原句保留） |
| 加载 | `.rp-loading` + `aria-busy="true"` |
| 错误 | `[data-tone=error]` + `role="status"`，文案仍走 `sessionRevertReason()` 的固定映射（不泄后端原码） |
| 数据过期 | 同会话证据变化 → 旧预览失效、提示「请刷新后重新预览」 |
| 会话切换 | 旧文件行清空，只留「会话或工作区正在切换」 |
| 不可信文本 | 路径一律 `textContent`；夹具里塞 `<img src=x onerror=…>` 的路径，断言没有生成 `img`、`onerror` 没执行、文本原样可见 |
| 只读 | 「实际恢复未开放」照旧；预览路径没有触发 apply/prepare |

### 开发进程（A3）

| 项目 | 处理 |
|---|---|
| 层级 | 标题带（标题 + 说明 + 刷新）→ 权限行 → 说明 → 状态行 → 列表 |
| 状态标记 | `.process-meta::before` 圆点按 `data-state` 取语义色；状态**文字**仍在 `.process-meta` 里（读屏与既有脚本的事实源不变） |
| 可读性 | 命令最多两行（完整文本在 `title`）；端点、code 单独一行；动作按钮 26px 高 |
| 长日志 | `.process-logs` `max-height:min(220px,32vh)`、`pre-wrap`、`overflow:auto`、`tabIndex=0`、`aria-label="已脱敏的进程日志"` |
| 空态 | `.rp-empty`「暂无开发进程」+ 真实的权限提示（「开启权限后，Agent 可启动当前工作区的开发服务。」） |
| 失败 | `data-state=failed` 的行 meta 用 danger 色；读不到进度时 `.process-message` 用 error 档 |
| 生命周期 | generation/revision/cursor/workspace 校验、串行加载、1 秒轮询、`dispose` 全部原样；未新增任何执行能力 |

## 6. 组合问题与修复（本轮真实发现）

1. **`workspaceMatches` 在 Classic 无 owner 时永远为 false。** `app.js` 发的 `pi-gui:session-evidence-changed` detail 是
   `{workspaceId: S.legacyOwner?.workspaceId, …}`；Classic 没有 owner 时这两个字段是 `undefined`，
   于是同一个会话里的真实文件改动**不会**让已渲染的撤销预览失效（可能看着一份过期 diff 做决定）。
   修法：给 `workspaceMatches(identity, {unknownMeansSame})` 加一个开关，只有「Classic 证据事件 + 两边都没有工作区维度」按同一会话算；
   Runtime 帧（`onRuntimeChange`）仍然要求两边身份都真实存在，不放宽 owner 判定。
   单测：`session-change-ui.cjs 27/27`（含「同 owner 证据变化让候选失效」「别的 worktree 不影响」）与新增的会话变更过期断言。
2. **`emptyState()` 一开始默认往模块级 `body` 里 append**，而 `body` 是面板闭包变量 → 运行期 `TypeError`。
   改为「返回区块、由调用方 append」，`session-change-ui.cjs` 由红转绿（27/27）。
3. **`.secondary-surface` 原先整块 `overflow-y:auto`**，标题会随内容滚走；`.secondary-surface .chg-list{flex:1}` 说明
   `.chg-body` 本来就想当滚动区。改为「标题带 sticky + 内容区自己滚」，并把右栏内边距从容器挪到子元素，
   这样 sticky 不会在顶部漏出被滚内容。断言：滚 260px 后标题带 `top` 不变。
4. **拖动后的宽度与 `--rp-width` 必须是同一个数**：Toast 让位（`.app.rp-open ~ .toasts`）吃的是这个变量；
   断言拖动后两者差 ≤1px，且 `localStorage['pi-gui.rightpane.v1']` 同步。

## 7. 响应式与可访问性（A4）

| 维度 | 覆盖方式 |
|---|---|
| 700 / 900 / 1200 / 1536 CSS px | 每个宽度 × Dark/Light × {关闭, Changes, Browser, 本会话变更, 开发进程}（8×4=32 状态，含关闭态共 40 个检查点，184 条断言 + 8 条关闭态溢出断言） |
| 宽度拖动 | 真实 CDP 鼠标按下/移动/抬起；断言真实宽度、`--rp-width`、`aria-valuenow`、localStorage 四处一致 |
| 左栏展开/折叠 | 每个矩阵宽度前确保侧栏展开；`applyMode` 仍按**实测可用宽度**判定 |
| 右侧栏覆盖模式 | 实测 700 / 900 为 `overlay`，1200 / 1536 为 `dock`（既有 `CHAT_FLOOR=420` 规则，未改）；两种模式下右栏都完整落在视口内、无横向溢出 |
| 焦点与键盘 | 分隔条可聚焦且带 `aria-valuemin/max/now/valuetext/controls`；`←/→` 12px、`Shift+←/→` 40px、`Home` 到 320、`End` 到上限、双击复位 420；`Tab` 从分隔条进入面板；`Escape` 关闭并把焦点还回打开它的入口 |
| 长路径 / 长日志 | 12 行超长路径 + 2 行超长命令 + 40 行重复日志，断言面板 `scrollWidth <= clientWidth+1` |
| 面板切换/会话切换不串 | 「文件条目数量来自后端 fileCount」「空态下不残留上一批文件行」「切换会话时旧文件行被清掉」 |
| 与 UI-3 弹层的关系 | 右栏 Browser 开着时打开模型弹层，断言弹层 `right <= 右栏 left`（被 UI-3 定位在右栏左侧）；原生 view 不会被弹层盖住（遮挡订阅把 view 摘下去） |
| Dark / Light | 两主题同一套语义 Token；35 张截图覆盖两主题四宽度（含 125% 缩放与错误态） |
| 缩放 | 应用 125%：布局宽度确实变小（`innerWidth` < 1000）、标题带仍完整一条、必要时退成覆盖模式且不溢出 |
| reduced-motion | 用 CDP `Emulation.setEmulatedMedia` 置 `prefers-reduced-motion: reduce`，断言加载点 `animation-name: none`（状态仍可见） |

## 8. 测试与证据

### 新增套件

```
node tests/ui4-pane.cjs
```

真实 Electron（`process.versions.electron`）自动重跑自身；临时 `userData`、临时 uploads、临时 HTTP fixture；
浏览器面用真实 `WebContentsView` 访问 `127.0.0.1` 上的临时静态页；本会话变更/开发进程的数据由**页内 fetch 夹具**提供（形状照抄真实接口）。
不接触真实项目、不连真实 Pi、不调用模型。

**280/280，失败 0，跳过 0，退出码 0，35 张截图。** 分组：

| 组 | 条数 | 内容 |
|---|---|---|
| 右栏开关 / 宽度 / 键盘 / 样式 | 25 | 关→开→关、`--rp-width`、拖动、步进、`Home/End`、双击、aria、localStorage、卸载干净 |
| Browser / 原生 view | 21 | 挂载、边界=viewport、地址栏导航、错误条、遮挡摘除/挂回、宽度跟随、切面撤离、关闭撤离、焦点回入口 |
| 本会话变更 | 20 | 标题带、概览计数、状态标记、长路径换行、不可信文本、滚动、预览只读、过期/加载/空/错误、会话切换 |
| 开发进程 | 13 | 标题带、权限控件、无假终端、`data-state`、状态点配色、长内容、日志可聚焦、停止调用真实接口、空态、焦点 |
| 响应式 × 主题矩阵 | 194 | 8 主题×宽度组合 × {关闭, 4 个面}：溢出、带高、关闭按钮位置、dock/overlay、宽度复位、说明行 |
| 收尾 | 7 | 125% 缩放 3 条、reduced-motion、Tab、Escape、renderer 无报错 |

证据：[ui4a-evidence/results.json](ui4a-evidence/results.json)（每条断言与几何事实）、
[ui4a-evidence/run.log](ui4a-evidence/run.log)（原始输出）、`ui4a-evidence/*.png`（35 张）。
代表图：

- [dark-1200-session-session-changes.png](ui4a-evidence/dark-1200-session-session-changes.png)（默认宽 420：标题+说明+刷新+×、概览卡、状态胶囊、文件行层级、行内动作）
- [dark-1200-browser-browser.png](ui4a-evidence/dark-1200-browser-browser.png)（Browser 在 46px 带内）
- [dark-1200-changes-changes.png](ui4a-evidence/dark-1200-changes-changes.png)（Changes 与上面同一节奏）
- [dark-1200-process-process.png](ui4a-evidence/dark-1200-process-process.png)（状态点、失败红字、日志盒）
- [light-1200-session-session-changes.png](ui4a-evidence/light-1200-session-session-changes.png)（浅色主题）
- [dark-700-process-process.png](ui4a-evidence/dark-700-process-process.png)（700px 覆盖模式）
- [session-changes-error-1200-dark.png](ui4a-evidence/session-changes-error-1200-dark.png)（错误档）
- [changes-zoom125-dark.png](ui4a-evidence/changes-zoom125-dark.png)（125% 缩放）

### 既有套件复跑（改后，未改任何既有断言）

| 命令 | 结果 |
|---|---|
| `node tests/smoke.cjs` | **1338/1338 通过** |
| `node tests/session-change-ui.cjs` | **27/27**（含 `workspaceMatches` 改动后的两条过期语义） |
| `node tests/session-change-startup.cjs` | **11/11** |
| `node tests/runtime-secondary.cjs` | **17/17** |
| `node tests/runtime-git-ui.cjs` | **6/6** |
| `node tests/runtime-ui.cjs` | **16/16** |
| `node tests/runtime-changes.cjs` | **60/60** |
| `node tests/runtime-processes.cjs` | **10/10**（真实 win32 进程树） |
| `node tests/process-ui.cjs` | **17/17** |
| `node tests/gui-browser-ui.cjs` | **22/22** |
| `node tests/hotfix-ui.cjs` | **10/10** |
| `node tests/daily-use.cjs` / `ui-ia.cjs` / `git.cjs` / `modules.cjs` / `sidebar-menu.cjs` / `worktrees-ui.cjs` / `approvals.cjs` / `interactions.cjs` | 31/31、12/12、161/161、117/117、37/37、16/16、80/80、passed —— 均无下降 |

未跑完整 `npm test`（约 50 分钟，任务明确不要求；且 `package.json` 不得修改，本套件不进 canonical 链）。
`tests/browser-pane.cjs`（真实浏览器套件）与 `tests/theme-electron.cjs`、`tests/cdp-shot.cjs` 未在本轮执行 ——
它们断言的是右栏**默认宽 420** 与 UI-1 的像素基线，而本轮的样式增量尚未被 `index.html` 加载，跑也验不到新 CSS；接入后由集成阶段跑。

## 9. 已知限制与需要集成方接入的项目

1. **必须加载新样式表**（阻塞项，一行）：
   在 `public/index.html` 的 `process.css` 之后加
   `<link rel="stylesheet" href="/ui4-pane.css">`。
   本任务不改 `index.html`（共享文件），所以**当前源码版 / 打包版都还看不到本轮的视觉增量**；
   `tests/ui4-pane.cjs` 是按同一路径自己挂上 `<link>` 再断言的。
2. **Browser 面没有标题文字。** 四面的标题带结构已统一，但 Browser 那一面由只读文件 `browser-pane.js` 画，
   它的「身份」位置是地址栏（Claude Code 那边是文件名胶囊）。这一条按任务要求**没有自行修改**只读文件；
   建议集成阶段在 `browser-pane.js` 的 `buildToolbar()` 里加一行
   `const title=document.createElement('h3'); title.className='rp-head-title'; title.textContent='浏览器'; bar.append(title);`
   （样式已就绪：`.rp-head-title` 就是 13px/600/省略）。加了之后 `Browser / Changes / Processes` 三面的标题位才算完全一致。
3. **默认宽保留 420，没有改成 327。** 两个原因：① `tests/browser-pane.cjs:301` 把 `paneW === 420` 写成既有断言，
   改默认宽会动别人的回归判据；② 实测 350px 时地址栏约 180px，327px 时约 150px，虽然可用但很挤。
   UI-4.2 允许「若 327 使现有 toolbar 不可读，保留 420 并记理由」，这里按该条款处理。
4. **右栏顶部的 46px `.rp-titlebar` 仍是空档**：那一带下面是系统画的原生窗口按钮，放控件点不到（`index.html` 里已有注释）。
   所以标题带是它下面那一行，Browser 面因此有 92px 的顶部占用（46 空档 + 46 工具带）。要压缩只能动原生 overlay 高度，超出本任务范围。
5. **`Escape` 只在焦点位于面板内时生效**（既有语义）。若希望「焦点在顶栏入口时也能用 `Escape` 关右栏」，
   需要在 `app.js` 的顶栏键盘处理里加一条，属于共享文件，交给集成阶段决定。
6. **700/900 是覆盖模式**：右栏会盖住对话（既有 `CHAT_FLOOR=420` 规则）。本轮没有把它改成 dock，也没有为此新增断点。
7. **未验证**：真实 Windows 中文 IME 候选窗、真实 OS DPI/多显示器、POSIX、真实 Pi/模型、离线打包产物
   （`npm run build:app` 未执行；打包也不会包含 `ui4-pane.css`，直到第 1 条接上）。
   `tests/ui4-pane.cjs` 也不进入 canonical `npm test`（`package.json` 不得修改），由集成阶段决定是否挂进 `test:ui4`。
8. **开发进程的日志仍是 `pre` 全文**（既有语义，保留 65536 字符上限与 256 行窗口）；本轮只调整盒子高度与换行，没有改脱敏与截断逻辑。

## 10. 回退

按提交回退：

- 视觉增量（`public/ui4-pane.css`）单独一个文件：删掉即可回到 UI-3 的右栏观感，JS 改动仍可用。
- 组件改动（`right-pane.js` / `session-changes-panel.js` / `process-panel.js`）：
  回退 `createPaneHeader` 与三处标题带接线即可；`RIGHT_PANE_LIMITS`、分隔条 aria、`Home/End`/双击、焦点还原是**附加**行为，可单独保留。
- `session-changes-panel.js` 的 `workspaceMatches` 是行为修复：回退会让「Classic 无 owner 时旧预览不过期」的缺陷回来，
  回退时请连同那条断言一起回退，并记录原因。
- `process-panel.js` 是**整文件重写**（逻辑逐行保留、只换 DOM 与状态分档）：回退请整文件回到 `17f855f` 版本，不要局部拼接。
- 新增测试与证据可整体删除，不影响产品代码。

## 11. 提交与 Git 状态

- 产品 + 测试 + 样式提交：`4b0e040`「实现 UI-4A 右栏统一外壳与多面板状态呈现」（5 个文件，+1211/−44）。
- 本文档与 `ui4a-evidence/` 为末尾归档提交；本轮最终 HEAD 见交付消息与本分支 `git log -1`（文档不自引用自身哈希）。
- 交付时 `git status --short` 为空；未推送、未合并 main、未打 tag、未升级版本、未发版。
- 依赖目录 `node_modules` 是指向本机已有目录的 junction，已被 `.gitignore` 忽略，未进入提交。
- 回退顺序：先回退归档提交（只含文档/证据），再按第 10 节回退 `4b0e040`。
