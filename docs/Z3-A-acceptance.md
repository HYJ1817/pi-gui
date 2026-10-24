# Z3-A：pi-GUI 受控 Gen UI 与交互式可视化 验收报告

**提交/目标**：Z3-A 交互图表 MVP 及独立验收修复（受控 Gen UI、参数联动、Composer 引用、流式围栏闭合校验、精确零基线与会话生命周期隔离）  
**工作区**：`C:\Users\21022\.codex\worktrees\z3-interactive-viz\pi-GUI`（分支 `codex/z3-interactive-viz`）  
**验收基线 commit**：`a609d3ae64ccc18ddb5012298a2dac6b4e5441f8`  
**交付状态**：已完成全部独立验收修复，本地单元测试、UI 集成测试、标准沙箱 Electron 实测、EXE 打包与回归测试全绿，等待独立验收与用户授权。未擅自推送、合并、发版。

---

## 一、改动摘要与关键模块清单

本阶段严格遵循「不依赖 MCP Apps、不开发第三方插件系统、不修改 Pi 本体、离线优先与零外部图表库依赖」原则，实现了一套高性能、安全且符合 pi-GUI 灰阶极简风格的原生 SVG 交互可视化与受控参数引擎，并在独立代码审查后完成了 5 项关键质量修复：

| 模块文件 | 职责与安全实现 |
|---|---|
| [`public/viz-schema.js`](file:///c:/pi-GUI/public/viz-schema.js) | 结构化数据协议白名单校验器。严格限制体积（≤ 128KB）、标签数（≤ 100）、系列数（≤ 8）、参数数（≤ 5）；严格校验 `version: '1'` 与 `type: 'line' \| 'bar'`；**新增严格有限数值校验**，严禁 `null`、布尔值、空字符串被意外隐式转为数值，防范极端绝对值（`> 1e12`）导致坐标溢出；字段白名单过滤防原型链污染；参数去重与边界严格清洗。 |
| [`public/viz-chart.js`](file:///c:/pi-GUI/public/viz-chart.js) | 纯原生 SVG 交互图表渲染引擎（无任何 npm 外部图表库依赖）。自适应 `viewBox` 缩放，支持折线图（曲线/数据点）与柱状图（分组柱条）；**修复柱状图零基线几何**，针对全正数、全负数、恒定负数及跨零数据均严格锚定零基线，杜绝截断基线引起的视觉夸大；跨零数据渲染显式零基线；坐标计算均做 clamp 防范 NaN/Infinity；支持阈值告警参考线与超标高亮；提供 `dispose()` 句柄以清理 DOM 与浮层。 |
| [`public/viz-panel.js`](file:///c:/pi-GUI/public/viz-panel.js) | 右栏交互面板组件。接入既有 `openSecondarySurface('viz', ...)` 与 `createPaneHeader`；提供形态切换、系列多选 Chip、数据范围滑块及阈值告警滑块（修复负数与恒定数值下阈值上下界 `min < max` 合法性）；**统一 Classic 与 Runtime 会话身份校验**（`captureSessionScope` 与 `validateSessionScope`），Runtime 使用真实 `gitConversationScope()` 与 `runtimeStore`，严禁被 `S.state.sessionId` 覆盖；**修复统计摘要**，`buildVizSummaryMarkdown` 严格基于当前截取范围（`rangeLimit`）计算均值、极值与超标点；源消息删除或会话切换时明确拒绝引用。 |
| [`public/viz-integration.js`](file:///c:/pi-GUI/public/viz-integration.js) | 消息流事件委托与控制器。统一拦截 `[data-viz-open]` 与 `[data-viz-toggle-raw]`，解析底层代码块内容并向面板传递源消息 DOM 节点（`sourceNode`），以实现对 DOM 存活状态与会话归属的精确校验。 |
| [`public/markdown.js`](file:///c:/pi-GUI/public/markdown.js) | 围栏代码块安全拦截。**新增流式未闭合围栏防护**，只有在代码块围栏明确完整闭合（`closed: true`）且 JSON 语法校验合法时才渲染 `.viz-card`；未闭合的流式围栏始终渲染为原生 `<pre class="code" data-lang="pi-gui-viz">`，绝不把流式草稿提前变成卡片。 |
| [`public/viz.css`](file:///c:/pi-GUI/public/viz.css) | 极简灰阶主题样式。严格适配 pi-GUI CSS 变量（`--bg`、`--border`、`--text`、`--accent`），无缝兼容浅色/深色模式；适配 320px 窄窗口 Overlay 抽屉与高 DPI 屏幕。 |
| [`public/app.js`](file:///c:/pi-GUI/public/app.js) | 全局启动接线，调用 `initVizIntegration()` 挂载事件委托。 |
| [`public/index.html`](file:///c:/pi-GUI/public/index.html) | 引入 `viz.css` 样式文件。 |
| [`package.json`](file:///c:/pi-GUI/package.json) | 注册 `"test:viz"` 与 `"test:viz:electron"`，接入主测试链。 |
| [`tests/viz-schema.cjs`](file:///c:/pi-GUI/tests/viz-schema.cjs) | 22 项协议校验定向测试，全面覆盖白名单、大小超限、类型校验、严格数值判定（拒绝 `null`、`false`、`true`、`""`、`>1e12`）与参数清洗。 |
| [`tests/viz-ui.cjs`](file:///c:/pi-GUI/tests/viz-ui.cjs) | 39 项 UI、几何与会话隔离测试，覆盖流式未闭合回退、柱状图全正/全负/跨零基线、截取范围精确统计、Classic 与 Runtime 身份隔离、DOM 节点脱卸拒绝及资源清理。 |
| [`tests/viz-electron.cjs`](file:///c:/pi-GUI/tests/viz-electron.cjs) | 11 项真实 Electron 沙箱实测，完全移除 `--no-sandbox`，验证渲染进程安全沙箱（Node integration 禁用、context isolation 启用）、断言失败非零退出码验证（支持 `--simulate-failure` 退出码 1）及 8 张界面截图证据。 |

---

## 二、独立审查 5 大问题修复对照

### 1. 数值校验与柱状图正确性修复
- **严格类型检查**：使用 `typeof v === 'number' && Number.isFinite(v)`，彻底拒绝 `null`（原 `Number(null) === 0`）、`false`、`true`、`""` 等隐式强制类型转换。
- **极端数值保护**：限制单个数值绝对值不超过 `1e12`，坐标映射计算中加入边界防溢出 clamp，避免出现 `NaN`、`Infinity` 或负高度 SVG 矩形。
- **零基线完整性**：重写 `calculateBounds`。
  - 全正数：`[0, max * 1.1]`
  - 全负数：`[min * 1.1, 0]`（基线位于 0，柱条向下延伸）
  - 恒定负数：保证 `max === 0` 且 `min < 0`
  - 跨零数据：计算包含 0 的对称或自适应范围，并绘制一条明显的水平零基线（`stroke: var(--text-dim)`）。
  - 坚决杜绝截断基线导致的柱状图视觉失真。
- **阈值滑块合法范围**：针对全负数或所有数值恒等场景，滑块范围保证 `threshMin < threshMax`，避免 DOM `range` input 产生异常。

### 2. Classic 与 Runtime 会话身份隔离统一
- **统一会话上下文捕获与校验**：新增 `captureSessionScope()` 与 `validateSessionScope()`。
- **消除了 `S.state.sessionId` 对 Runtime 的干扰**：优先读取当前 `workspaceView()`；在 `'runtime'` 下仅以 `gitConversationScope()` 和 `runtimeStore` 的当前 conversation 为准，绝对不被全局 `S.state.sessionId` 污染。
- **全生命周期防串扰**：切换 Classic 会话、切换 Runtime 对话、项目目录（cwd）变更或 Runtime Generation 失效时，引用操作均被拦截并给出友好拒绝提示，绝不向错误的草稿写入数据。

### 3. 流式解析与消息来源绑定
- **流式未闭合围栏防护**：`markdown.js` 的 `renderBlocks` 与 `codeBlock` 跟踪围栏闭合状态 `{ closed }`。未完整闭合的代码块始终渲染为普通代码块，避免打字机输出中途渲染出损坏的卡片。
- **真实 DOM 存活检查**：面板记录图表卡片所在的源消息 DOM 节点（`sourceNode`）。引用前校验 `sourceNode.isConnected`，当源消息被删除或重新渲染脱卸时，拒绝引用过期配置。

### 4. 统计摘要精确范围计算
- **范围截取同步**：`buildVizSummaryMarkdown` 在计算均值（avg）、极值（min/max）及超标点数（overCount）前，严格对各系列执行 `.slice(-state.rangeLimit)`。
- **精确数值断言**：在 `tests/viz-ui.cjs` 中加入带已知期望值的精确数值测试（如总范围 avg=30，截取最近 3 项 avg=40，overCount=2），杜绝引用摘要与界面显示不一致。

### 5. Electron 测试真实性与安全强化
- **移除 `--no-sandbox`**：测试完全在 Electron 默认的生产级沙箱环境下运行。
- **渲染安全三项检查**：断言 `process` 为 `undefined`、`require` 为 `undefined`、`Buffer` 为 `undefined`。
- **可靠非零退出码**：所有断言失败、未捕获异常均显式触发 `app.exit(1)` 并设置 `process.exitCode = 1`；增加 `node tests/viz-electron.cjs --simulate-failure`，实测触发预期失败并返回退出码 1。

---

## 三、真实 Electron 实测与交互截图证据

在真实 Electron 44.4.3 / Chromium 默认沙箱环境（`BrowserWindow` 1280×800、`sandbox: true, contextIsolation: true`）中完成实机测试与截图生成，证据保存在 `docs/evidence/z3/`：

1. **消息流内图表卡片**：[`01-chat-stream-viz-cards.png`](evidence/z3/01-chat-stream-viz-cards.png)
   - 消息流正常呈现段落与标题，两个 `pi-gui-viz` 代码块被渲染为精致的灰阶图表卡片（含图表图标、标题、系列与数据点统计）。
   - 提供「打开可视化」按钮与「JSON」源码展开按钮。
2. **右栏折线图呈现**：[`02-line-chart-in-right-pane.png`](evidence/z3/02-line-chart-in-right-pane.png)
   - 点击卡片按钮无缝滑出右侧工作区面板（复用 Secondary Surface），主聊天界面不脱卸。
   - 顶部显示标题、数据项概览、重置与引用按钮；中部为参数交互栏；下方为自适应 SVG 折线图与坐标网格。
3. **切换为柱状图形态**：[`03-bar-chart-switched.png`](evidence/z3/03-bar-chart-switched.png)
   - 点击形态栏的「柱状图」按钮，即时转换为分组柱状图，SVG 自适应计算零基线与柱条几何。
4. **阈值告警高亮**：[`04-threshold-highlight.png`](evidence/z3/04-threshold-highlight.png)
   - 调整阈值滑块为 50%，SVG 自动画出橙红色虚线参考线与数值标签，超过阈值的点与柱条自动获得 `is-alert` 警示样式。
5. **引用配置与摘要到 Composer**：[`05-quoted-to-composer.png`](evidence/z3/05-quoted-to-composer.png)
   - 点击「引用到对话」，当前图表名称、形态、当前激活系列（在显示范围内）的均值/极值、超标统计与参数以紧凑 Markdown 格式追加至输入框，保留原草稿，不自动发送。
6. **浅色主题自适应**：[`06-light-theme-adaptation.png`](evidence/z3/06-light-theme-adaptation.png)
   - 切换到浅色模式，卡片背景、边框、坐标轴文本与网格线完美适配高对比度。
7. **窄窗口自适应布局**：[`07-narrow-window-responsive.png`](evidence/z3/07-narrow-window-responsive.png)
   - 窗口缩窄至 760px 时，右栏自动进入受控 Overlay 模式，聊天地板受到保护。
8. **多图表无冲突切换**：[`08-second-chart-switched.png`](evidence/z3/08-second-chart-switched.png)
   - 点击消息流中第二个图表卡片（编译耗时柱状图），旧图表及参数监听器干净销毁，右栏即时刷新为新图表。

---

## 四、测试证据与验证记录

### 1. 新增定向测试套件

- **`node tests/viz-schema.cjs`**：22/22 PASS（耗时 ~0.09s）
  - 覆盖严格数值校验（`null`/`false`/`true`/`""`/`>1e12` 拒绝）、白名单过滤、参数去重与截断。
- **`node tests/viz-ui.cjs`**：39/39 PASS（耗时 ~0.26s）
  - 覆盖未闭合流式代码块降级、全正/全负/常数负/跨零柱状图零基线几何、截取切片精确统计、Classic 与 Runtime 身份隔离及断开 DOM 节点拒绝。
- **`node tests/viz-electron.cjs --simulate-failure`**：退出码 1（FAIL deliberate simulated check failure）
- **`node tests/viz-electron.cjs`**：11/11 PASS（耗时 ~3.2s）
  - 标准沙箱运行，Node integration 禁用、context isolation 启用，11 项断言与 8 张截图全部通过。

### 2. 相邻模块回归测试

- `node tests/context-reference-ui.cjs`：10/10 PASS
- `node tests/ui2-classic.cjs`：48/48 PASS
- `node tests/ui3-composer.cjs`：34/34 PASS

### 3. Canonical 测试计划验证

- `scripts/test-group-plan.mjs`：计划校验 `validateTestGroupPlan` 为 `true`。

### 4. 单文件 EXE 打包与产物检验

- `npm run build:exe`：成功生成 `build/Pi GUI.exe`（98.0 MB），资源内嵌完整。
- `CHECK_PORT=19788 node tests/exe-check.cjs`：49/49 PASS，全部自测与单文件内嵌资源加载正常。

---

## 五、安全与会话生命周期边界说明

1. **不可信输入防护**：
   - 模型输出无论多么复杂或异常，均通过 `parseVizData` 经过极其严格的白名单剥离。严禁任何 HTML 注入，所有动态标签与文本均通过 DOM API 设置 `textContent` 或 `setAttribute`，杜绝 XSS。
2. **纯函数受控计算**：
   - 参数面板仅允许调节预定义的阈值数值、数据范围截取（`slice`）与系列布尔显隐，严禁执行模型传入的任何 JavaScript 函数或表达式。
3. **零外部网络与文件越权**：
   - 不产生任何新的网络请求，不读取本地文件系统，不暴露任何 Electron 内部接口。
4. **会话与工作区隔离**：
   - 图表面板打开时记录 `sessionId` 与 `workspaceGeneration`。
   - 当检测到会话切换（`pi-gui:session-switch`）或工作区视图变更时，图表面板自动关闭。
   - 若会话身份不一致或源消息 DOM 已脱钩，点击「引用到对话」时会明确拒绝写入并弹出提示，保护上下文不被串扰。
5. **资源释放（No Leaks）**：
   - 通过 `instance.onDispose` 在面板切换或关闭时注销全部事件监听、移除 Tooltip 浮层与图表 DOM，避免内存泄漏。

---

## 六、后续扩展建议（Z3-B 及更高阶段）

1. **扩展可视化类型**：
   - 在保持零大型依赖的前提下，可继续用受控原生 SVG 扩展出雷达图（Radar）、饼图/环形图（Pie/Donut）、以及散点图（Scatter）。
2. **流程图与架构图（Diagrams）**：
   - 制定受控的 `pi-gui-flow` 节点与连接线协议（`nodes: [...], edges: [...]`），利用 SVG 拓扑布局自动渲染技术架构与流程图。
3. **Agent / 用户双向协同编辑**：
   - 允许用户在参数面板修改后的配置通过结构化 Action 反馈给 Agent（例如由 Agent 根据用户调整的阈值重新进行代码优化或分析）。
