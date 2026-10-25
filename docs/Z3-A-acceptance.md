# Z3-A：pi-GUI 受控 Gen UI 与交互式可视化 验收报告

**提交/目标**：Z3-A 交互图表 MVP 及最终收口修复（受控 Gen UI、参数联动、Composer 引用、Classic 真实消息 DOM 绑定、流式增量替换失效防护、Runtime 真实渲染链路、消除测试假阳性、精确零基线与会话生命周期隔离）  
**工作区**：`C:\Users\21022\.codex\worktrees\z3-interactive-viz\pi-GUI`（分支 `codex/z3-interactive-viz`）  
**第一轮验收基线 commit**：`a609d3ae64ccc18ddb5012298a2dac6b4e5441f8`  
**第二轮验收基线 commit**：`d51375ee574faec5e3fd71f29e4db61894ff0049`  
**最终收口基线 commit**：`dce1a2f1ec51b9a8e22646bf67f2b023c844eb05`  
**最终收口提交**：`d622f6c`（业务代码修复）、`bd3204e`（测试回归与假阳性清除）  
**交付状态**：已完成全部三轮独立验收与最终收口修复，本地单元测试、UI 集成测试、标准沙箱 Electron 实测、EXE 打包与回归测试全绿，等待独立验收与用户授权。未擅自推送、合并、发版。

---

## 一、改动摘要与关键模块清单

本阶段严格遵循「不依赖 MCP Apps、不开发第三方插件系统、不修改 Pi 本体、离线优先与零外部图表库依赖」原则，实现了一套高性能、安全且符合 pi-GUI 灰阶极简风格的原生 SVG 交互可视化与受控参数引擎，并根据独立代码审查进行了深度质量收口：

| 模块文件 | 职责与安全实现 |
|---|---|
| [`public/viz-schema.js`](file:///c:/pi-GUI/public/viz-schema.js) | 结构化数据协议白名单校验器。严格限制体积（≤ 128KB）、标签数（≤ 100）、系列数（≤ 8）、参数数（≤ 5）；严格校验 `version: '1'` 与 `type: 'line' \| 'bar'`；**严格有限数值校验**，拒绝 `null`、布尔值、空字符串隐式转数值及极端绝对值（`> 1e12`）；字段白名单过滤防原型链污染；参数去重与边界严格清洗。 |
| [`public/viz-chart.js`](file:///c:/pi-GUI/public/viz-chart.js) | 纯原生 SVG 交互图表渲染引擎（无任何 npm 外部图表库依赖）。自适应 `viewBox` 缩放，支持折线图与柱状图；**柱状图零基线几何**，针对全正数、全负数、恒定负数及跨零数据均严格锚定零基线，杜绝截断基线引起的视觉夸大；跨零数据渲染显式零基线；坐标计算 clamp 防范 NaN/Infinity；支持阈值告警参考线与超标高亮；提供 `dispose()` 句柄以清理 DOM 与浮层。 |
| [`public/viz-panel.js`](file:///c:/pi-GUI/public/viz-panel.js) | 右栏交互面板组件。接入既有 `openSecondarySurface('viz', ...)` 与 `createPaneHeader`；提供形态切换、系列多选 Chip、数据范围滑块及阈值告警滑块；**统一 Classic 与 Runtime 会话身份校验**（`captureSessionScope` 与 `validateSessionScope`），Runtime 使用真实 `gitConversationScope()` 与 `runtimeStore`，严禁被 `S.state.sessionId` 覆盖；**双重来源节点校验（cardNode + sourceNode）**，同时记录原始 `.viz-card` 与所属宿主节点，在引用时严格核验 `cardNode.isConnected && sourceNode.isConnected && sourceNode.contains(cardNode)`，即使消息 article 仍然挂载，若旧卡片被重新渲染或替换亦必须安全拒绝旧引用；源消息删除、历史重建、Live 输出刷新或会话切换时明确拒绝引用。 |
| [`public/viz-integration.js`](file:///c:/pi-GUI/public/viz-integration.js) | 消息流事件委托与控制器。统一拦截 `[data-viz-open]` 与 `[data-viz-toggle-raw]`，解析底层代码块内容；**捕获原始 `.viz-card` 与所属真实消息宿主**（`article.msg.assistant`、`[data-history-message-id]`、`.rtc-output-block`），若无有效宿主或宿主脱离界面则严禁打开面板。 |
| [`public/markdown.js`](file:///c:/pi-GUI/public/markdown.js) | 围栏代码块安全拦截。导出 `renderVizCardHtml` 共享卡片渲染结构；检查围栏闭合状态，未完整闭合的代码块始终渲染为原生 `<pre class="code" data-lang="pi-gui-viz">`，绝不把流式草稿提前变成卡片。 |
| [`public/runtime-conversation.js`](file:///c:/pi-GUI/public/runtime-conversation.js) | **Runtime 真实渲染链路接通**。引入 `hasVizBlock`、`appendRuntimeContent` 与 `createVizCardNode`。在不破坏原有纯文本输出、权限、owner、生命周期与滚动追随的前提下：Live 模式识别 `r.text` 中合法的 `pi-gui-viz` 闭合块并渲染为带 `.rtc-output-block` 容器的交互卡片；History 模式将历史消息中的合规图表解析挂载在对应 `[data-history-message-id]` 行内；未闭合围栏或普通输出完全保持既有文本行为。 |
| [`public/viz.css`](file:///c:/pi-GUI/public/viz.css) | 极简灰阶主题样式。严格适配 pi-GUI CSS 变量，适配 320px 窄窗口 Overlay 抽屉；卡片声明 `white-space: normal`，在 `pre.rtc-output`（`pre-wrap`）内布局完美呈现。 |
| [`public/app.js`](file:///c:/pi-GUI/public/app.js) | 全局启动接线，调用 `initVizIntegration()` 挂载事件委托。 |
| [`public/index.html`](file:///c:/pi-GUI/public/index.html) | 引入 `viz.css` 样式文件。 |
| [`package.json`](file:///c:/pi-GUI/package.json) | 注册 `"test:viz"` 与 `"test:viz:electron"`，接入主测试链。 |
| [`tests/viz-schema.cjs`](file:///c:/pi-GUI/tests/viz-schema.cjs) | 22 项协议校验定向测试，全面覆盖白名单、大小超限、类型校验、严格数值判定（拒绝 `null`、`false`、`true`、`""`、`>1e12`）与参数清洗。 |
| [`tests/viz-ui.cjs`](file:///c:/pi-GUI/tests/viz-ui.cjs) | **66 项 UI、几何与真实渲染链路测试**。彻底清除测试假阳性；Classic 完全对接 `messages.js` 的 `article.msg.assistant` 与流式 `paint()` 重绘替换失效验证；Runtime 完全对接 `runtimeStore` 与 `runtime-conversation.js`，包含 Live 输出刷新失效与 History 独立按钮验证。 |
| [`tests/viz-electron.cjs`](file:///c:/pi-GUI/tests/viz-electron.cjs) | 11 项真实 Electron 沙箱实测，完全移除 `--no-sandbox`，采用真实 `rebuildFromMessages` 构造消息，验证渲染进程安全沙箱（Node integration 禁用、context isolation 启用）、断言失败非零退出码验证（支持 `--simulate-failure` 退出码 1）及 8 张界面截图证据。 |

---

## 二、收口核心问题修复对照

### 1. Classic 流式更新后过期图表引用失效
- **问题分析**：在真实 Classic 会话流式输出中，`messages.js` 的 `paint()` 会通过 `b.node.innerHTML = md(b.text)` 重新渲染消息正文。此时外层 `article.msg.assistant` 仍然挂载在 DOM 上，但旧的 `.viz-card` DOM 节点已被替换并脱钩。如果仅校验 `sourceNode.isConnected`，旧卡片打开的面板在点击引用时无法察觉正文已被替换。
- **双重来源校验修复**：
  - `captureSessionScope` 与 `viz-integration.js` 同时捕获原始 `.viz-card`（`cardNode`）与所属宿主消息节点（`sourceNode`）。
  - `validateSessionScope` 执行严格的三重包含与挂载检查：
    1. `sourceNode.isConnected === true`（所属消息仍在 DOM 树上）
    2. `cardNode.isConnected === true`（图表卡片本身仍在 DOM 树上）
    3. `sourceNode.contains(cardNode) === true`（卡片仍属于该消息节点）
  - 当流式更新替换 `innerHTML` 时，旧 `cardNode` 脱钩，旧面板点击引用立即被安全拦截；新图表卡片可以正常打开并引用。

### 2. 测试假阳性清除与真实断言强化
- **消除旧按钮误测**：在 `tests/viz-ui.cjs` 中，历史重建与 Runtime History 打开新面板后，一律重新查询当前活动右栏中的最新引用按钮（`reloadedQuoteBtn` 与 `historyQuoteBtn`），严禁使用已销毁面板的悬空按钮测试新会话状态。
- **新增流式消息替换回归测试**：模拟真实 `paint()` 流程，验证流式第二阶段替换正文后，旧面板引用被拒、新卡片打开与引用成功。
- **新增 Runtime Live 输出刷新失效测试**：更新 `r.text` 触发 `runtimeComponent.draw()` 刷新后，断言旧 live 卡片脱钩且引用失效，新输出块正常受控。

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
- **`node tests/viz-ui.cjs`**：**66/66 PASS**（耗时 ~0.38s，净增 10 项严密防假阳性断言）
  - 覆盖真实 `messages.js` 消息结构（`article.msg.assistant`）、流式 `paint()` 重绘替换卡片失效防护、新卡片正常引用、全正/全负/常数负/跨零柱状图零基线几何、截取切片精确统计、真实 Runtime Live 与 History 链路渲染、Live 刷新失效、Classic 与 Runtime 身份隔离、历史重建失效及拒绝 null/脱钩来源打开。
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
- `CHECK_PORT=19790 node tests/exe-check.cjs`：49/49 PASS，全部自测与单文件内嵌资源加载正常。

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
   - 若会话身份不一致、来源消息 DOM 脱钩、卡片节点被重新渲染替换、或历史被重建覆盖，点击「引用到对话」时会明确拒绝写入并给出提示，保护草稿上下文不被串扰。
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
