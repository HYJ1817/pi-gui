# Z3-A：pi-GUI 受控 Gen UI 与交互式可视化 验收报告

**提交/目标**：Z3-A 交互图表 MVP 及独立验收修复（受控 Gen UI、参数联动、Composer 引用、Classic 真实消息 DOM 绑定、Runtime 真实渲染链路、流式围栏闭合校验、精确零基线与会话生命周期隔离）  
**工作区**：`C:\Users\21022\.codex\worktrees\z3-interactive-viz\pi-GUI`（分支 `codex/z3-interactive-viz`）  
**第一轮验收基线 commit**：`a609d3ae64ccc18ddb5012298a2dac6b4e5441f8`  
**第二轮验收基线 commit**：`d51375ee574faec5e3fd71f29e4db61894ff0049`  
**交付状态**：已完成两轮独立验收修复，本地单元测试、UI 集成测试、标准沙箱 Electron 实测、EXE 打包与回归测试全绿，等待独立验收与用户授权。未擅自推送、合并、发版。

---

## 一、改动摘要与关键模块清单

本阶段严格遵循「不依赖 MCP Apps、不开发第三方插件系统、不修改 Pi 本体、离线优先与零外部图表库依赖」原则，实现了一套高性能、安全且符合 pi-GUI 灰阶极简风格的原生 SVG 交互可视化与受控参数引擎，并根据独立代码审查进行了两轮深度修复：

| 模块文件 | 职责与安全实现 |
|---|---|
| [`public/viz-schema.js`](file:///c:/pi-GUI/public/viz-schema.js) | 结构化数据协议白名单校验器。严格限制体积（≤ 128KB）、标签数（≤ 100）、系列数（≤ 8）、参数数（≤ 5）；严格校验 `version: '1'` 与 `type: 'line' \| 'bar'`；**严格有限数值校验**，拒绝 `null`、布尔值、空字符串隐式转数值及极端绝对值（`> 1e12`）；字段白名单过滤防原型链污染；参数去重与边界严格清洗。 |
| [`public/viz-chart.js`](file:///c:/pi-GUI/public/viz-chart.js) | 纯原生 SVG 交互图表渲染引擎（无任何 npm 外部图表库依赖）。自适应 `viewBox` 缩放，支持折线图与柱状图；**柱状图零基线几何**，针对全正数、全负数、恒定负数及跨零数据均严格锚定零基线，杜绝截断基线引起的视觉夸大；跨零数据渲染显式零基线；坐标计算 clamp 防范 NaN/Infinity；支持阈值告警参考线与超标高亮；提供 `dispose()` 句柄以清理 DOM 与浮层。 |
| [`public/viz-panel.js`](file:///c:/pi-GUI/public/viz-panel.js) | 右栏交互面板组件。接入既有 `openSecondarySurface('viz', ...)` 与 `createPaneHeader`；提供形态切换、系列多选 Chip、数据范围滑块及阈值告警滑块；**统一 Classic 与 Runtime 会话身份校验**（`captureSessionScope` 与 `validateSessionScope`），Runtime 使用真实 `gitConversationScope()` 与 `runtimeStore`，严禁被 `S.state.sessionId` 覆盖；**真实原消息 DOM 绑定**，严格校验 `scope.sourceNode` 挂载状态与类型（Classic 必须匹配 `article.msg.assistant`，Runtime 匹配 `[data-history-message-id]` 或 `.rtc-output-block`），严禁 `sourceNode=null` 通过；源消息删除、历史重建或会话切换时明确拒绝引用。 |
| [`public/viz-integration.js`](file:///c:/pi-GUI/public/viz-integration.js) | 消息流事件委托与控制器。统一拦截 `[data-viz-open]` 与 `[data-viz-toggle-raw]`，解析底层代码块内容；**从真实消息 DOM 捕获来源节点**（`article.msg.assistant`、`[data-history-message-id]`、`.rtc-output-block`），若无有效宿主或宿主脱离界面则严禁打开面板。 |
| [`public/markdown.js`](file:///c:/pi-GUI/public/markdown.js) | 围栏代码块安全拦截。导出 `renderVizCardHtml` 共享卡片渲染结构；检查围栏闭合状态，未完整闭合的代码块始终渲染为原生 `<pre class="code" data-lang="pi-gui-viz">`，绝不把流式草稿提前变成卡片。 |
| [`public/runtime-conversation.js`](file:///c:/pi-GUI/public/runtime-conversation.js) | **Runtime 真实渲染链路接通**。引入 `hasVizBlock`、`appendRuntimeContent` 与 `createVizCardNode`。在不破坏原有纯文本输出、权限、owner、生命周期与滚动追随的前提下：Live 模式识别 `r.text` 中合法的 `pi-gui-viz` 闭合块并渲染为带 `.rtc-output-block` 容器的交互卡片；History 模式将历史消息中的合规图表解析挂载在对应 `[data-history-message-id]` 行内；未闭合围栏或普通输出完全保持既有文本行为。 |
| [`public/viz.css`](file:///c:/pi-GUI/public/viz.css) | 极简灰阶主题样式。严格适配 pi-GUI CSS 变量，适配 320px 窄窗口 Overlay 抽屉；卡片声明 `white-space: normal`，在 `pre.rtc-output`（`pre-wrap`）内布局完美呈现。 |
| [`public/app.js`](file:///c:/pi-GUI/public/app.js) | 全局启动接线，调用 `initVizIntegration()` 挂载事件委托。 |
| [`public/index.html`](file:///c:/pi-GUI/public/index.html) | 引入 `viz.css` 样式文件。 |
| [`package.json`](file:///c:/pi-GUI/package.json) | 注册 `"test:viz"` 与 `"test:viz:electron"`，接入主测试链。 |
| [`tests/viz-schema.cjs`](file:///c:/pi-GUI/tests/viz-schema.cjs) | 22 项协议校验定向测试，全面覆盖白名单、大小超限、类型校验、严格数值判定（拒绝 `null`、`false`、`true`、`""`、`>1e12`）与参数清洗。 |
| [`tests/viz-ui.cjs`](file:///c:/pi-GUI/tests/viz-ui.cjs) | **56 项 UI、几何与真实渲染链路测试**。Classic 完全对接 `messages.js` 的 `article.msg.assistant`；Runtime 完全对接 `runtimeStore` 与 `runtime-conversation.js`；全面覆盖打开、引用、删除来源、历史重建、owner 变更与会话切换。 |
| [`tests/viz-electron.cjs`](file:///c:/pi-GUI/tests/viz-electron.cjs) | 11 项真实 Electron 沙箱实测，完全移除 `--no-sandbox`，采用真实 `rebuildFromMessages` 构造消息，验证渲染进程安全沙箱（Node integration 禁用、context isolation 启用）、断言失败非零退出码验证（支持 `--simulate-failure` 退出码 1）及 8 张界面截图证据。 |

---

## 二、第二轮独立审查 2 大核心问题修复对照

### 1. Classic 原消息身份绑定修复
- **摒弃虚构测试类名**：彻底废除测试中手动插入的 `.message.assistant-message`，完全对接 `messages.js` 创建的真实 Classic 助手消息 DOM：`article.msg.assistant`（内部包含 `.msg-body` 与 `.assistant-text`）。
- **来源节点真实捕获与校验**：
  - `viz-integration.js`：通过 `card.closest('article.msg.assistant, article.msg, [data-history-message-id], .rtc-output-block')` 提取宿主节点；若 `!messageNode || !messageNode.isConnected`，直接拦截并不打开面板。
  - `viz-panel.js`：
    - `openVizPanel` 明确要求 `initialScope.sourceNode && initialScope.sourceNode.isConnected`，否则拒绝打开并提示。
    - `validateSessionScope` 明确禁止 `sourceNode=null`；在 Classic 下断言 `sourceNode.matches('article.msg.assistant, article.msg')`。
    - 当原消息被从 DOM 删除（`msgEl.remove()`）、历史被重建清空（`rebuildFromMessages([])`）、或当前 `S.state.sessionId` 变化时，引用操作均被安全拦截并拒绝，原草稿得到严格保护。

### 2. Runtime 真实渲染链路与消息绑定修复
- **核对 Runtime 消息与 SSE 架构**：
  - Runtime 使用 `pre.rtc-output` 纯文本承载实时流与历史；若直接赋值 `textContent`，图表围栏代码块无法被渲染为卡片。
- **安全接通 Runtime 图表能力**：
  - 在 `runtime-conversation.js` 中新增受控扫描与挂载机制（`VIZ_BLOCK_RE`、`hasVizBlock`、`appendRuntimeContent`、`createVizCardNode`）。
  - **Live 实时流模式**：检测 `r.text` 中的闭合 ```` ```pi-gui-viz ... ``` ```` 块。若无图表，保持原有的高效 `output.textContent = curText`；若检测到合法闭合图表，将卡片包裹在 `<div class="rtc-output-block">` 中插入 `output`。未闭合的流式围栏保持为普通文本，绝不提前转为卡片。
  - **History 历史模式**：遍历 `view.history.messages`，在助手消息行（带有 `dataset.historyMessageId`）中解析并挂载图表卡片。
  - **零副作用保障**：不破坏 `shouldFollow` 滚动追随判定、不影响 Token/Thinking 只读投影、不影响审批与生命周期；`.viz-card` 显式设置 `white-space: normal`，完全适应 `pre.rtc-output` 的排版上下文。
- **全生命周期隔离**：
  - Live 模式来源节点绑定到 `.rtc-output-block`；History 模式绑定到带有 `[data-history-message-id]` 的消息行。
  - 发生会话切换、历史重新加载、来源块删除、或 Agent 拥有者（`owner.runtimeId`）/代数（`runtimeGeneration`）变更时，引用操作均被可靠拒绝。

---

## 三、真实 Electron 实测与交互截图证据

在真实 Electron 44.4.3 / Chromium 默认沙箱环境（`BrowserWindow` 1280×800、`sandbox: true, contextIsolation: true`）中完成实机测试与截图生成，证据保存在 `docs/evidence/z3/`：

1. **消息流内图表卡片**：[`01-chat-stream-viz-cards.png`](evidence/z3/01-chat-stream-viz-cards.png)
   - 基于真实 `rebuildFromMessages` 消息流呈现，两个 `pi-gui-viz` 代码块被渲染为精致的灰阶图表卡片（含图表图标、标题、系列与数据点统计）。
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
- **`node tests/viz-ui.cjs`**：**56/56 PASS**（耗时 ~0.35s）
  - 覆盖真实 `messages.js` 消息结构（`article.msg.assistant`）、未闭合流式代码块降级、全正/全负/常数负/跨零柱状图零基线几何、截取切片精确统计、真实 Runtime Live 与 History 链路渲染、Classic 与 Runtime 身份隔离、消息删除与重建拒绝、以及禁止 null 来源打开。
- **`node tests/viz-electron.cjs --simulate-failure`**：退出码 1（FAIL deliberate simulated check failure）
- **`node tests/viz-electron.cjs`**：11/11 PASS（耗时 ~3.2s）
  - 标准沙箱环境，Node integration 禁用、context isolation 启用，11 项断言与 8 张截图全部通过。

### 2. 相邻模块回归测试

- `node tests/runtime-conversation.cjs`：**48/48 PASS**
- `node tests/ui2-runtime-display.cjs`：**82/82 PASS**
- `node tests/context-reference-ui.cjs`：**10/10 PASS**
- `node tests/ui2-classic.cjs`：**48/48 PASS**
- `node tests/ui3-composer.cjs`：**34/34 PASS**

### 3. Canonical 测试计划验证

- `scripts/test-group-plan.mjs`：计划校验 `validateTestGroupPlan` 为 `true`。

### 4. 单文件 EXE 打包与产物检验

- `npm run build:exe`：成功生成 `build/Pi GUI.exe`（98.0 MB），资源内嵌完整。
- `CHECK_PORT=19789 node tests/exe-check.cjs`：49/49 PASS，全部自测与单文件内嵌资源加载正常。

---

## 五、安全与会话生命周期边界说明

1. **不可信输入防护**：
   - 模型输出无论多么复杂或异常，均通过 `parseVizData` 经过极其严格的白名单剥离。严禁任何 HTML 注入，所有动态标签与文本均通过 DOM API 设置 `textContent` 或 `setAttribute`，杜绝 XSS。
2. **纯函数受控计算**：
   - 参数面板仅允许调节预定义的阈值数值、数据范围截取（`slice`）与系列布尔显隐，严禁执行模型传入的任何 JavaScript 函数或表达式。
3. **零外部网络与文件越权**：
   - 不产生任何新的网络请求，不读取本地文件系统，不暴露任何 Electron 内部接口。
4. **会话与工作区隔离**：
   - 图表面板打开时记录完整会话身份与工作区代数。
   - 当检测到会话切换（`pi-gui:session-switch`）或工作区视图变更时，图表面板自动关闭。
   - 若会话身份不一致、来源消息 DOM 脱钩、或历史被重建覆盖，点击「引用到对话」时会明确拒绝写入并给出提示，保护草稿上下文不被串扰。
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
