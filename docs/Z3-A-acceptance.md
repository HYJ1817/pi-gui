# Z3-A：pi-GUI 受控 Gen UI 与交互式可视化 验收报告

**提交/目标**：Z3-A 交互图表 MVP（受控 Gen UI、参数联动、Composer 引用与生命周期隔离）  
**工作区**：`C:\Users\21022\.codex\worktrees\z3-interactive-viz\pi-GUI`（分支 `codex/z3-interactive-viz`）  
**基线 commit**：`c6a44b2b62558837b74cfed98d6956699f613c87`（origin/main，合并 Z1 上下文引用与右栏状态恢复）  
**交付状态**：已开发完成，本地单元测试、UI 集成测试、正常沙箱 Electron 实测、EXE 打包与回归测试全绿，等待独立验收与用户授权。未推送、未合并、未发版。

---

## 一、改动摘要与关键模块清单

本阶段严格遵循「不依赖 MCP Apps、不开发第三方插件系统、不修改 Pi 本体、离线优先与零外部图表库依赖」原则，实现了一套高性能、安全且符合 pi-GUI 灰阶极简风格的原生 SVG 交互可视化与受控参数引擎。

| 模块文件 | 职责与安全实现 |
|---|---|
| [`public/viz-schema.js`](file:///c:/pi-GUI/public/viz-schema.js) | 结构化数据协议白名单校验器。严格限制体积（≤ 128KB）、标签数（≤ 100）、系列数（≤ 8）、参数数（≤ 5）；严格校验 `version: '1'` 与 `type: 'line' \| 'bar'`；对所有数值做 `Number.isFinite` 检查；字段白名单过滤防原型链污染；任何校验失败安全返回 `{ ok: false, error }`，不抛错。 |
| [`public/viz-chart.js`](file:///c:/pi-GUI/public/viz-chart.js) | 纯原生 SVG 交互图表渲染引擎（无任何 npm 外部图表库依赖）。自适应 `viewBox` 缩放，支持折线图（曲线/数据点）与柱状图（分组柱条）；自适应网格与 Y 轴刻度、密集 X 轴标签防重叠采样；支持阈值告警参考线与超标数据点高亮标记；鼠标悬停与键盘 Tab 聚焦展示 Tooltip；提供 `dispose()` 句柄以清理 DOM 与浮层。 |
| [`public/viz-panel.js`](file:///c:/pi-GUI/public/viz-panel.js) | 右栏交互面板组件。接入既有 `openSecondarySurface('viz', ...)` 与 `createPaneHeader`；提供形态切换（折线 ↔ 柱状）、系列多选 Chip（至少保留 1 个激活）、数据范围滑块（截取最近 N 项）、阈值告警滑块及一键重置；提供「引用到对话」能力（基于 `fillReviewComposer` 格式化紧凑 Markdown 统计摘要追加到草稿，严格限制在 1000 字符内）；绑定会话与工作区身份，切换即自动关闭失效。 |
| [`public/viz-integration.js`](file:///c:/pi-GUI/public/viz-integration.js) | 消息流事件委托与控制器。统一拦截 `[data-viz-open]` 与 `[data-viz-toggle-raw]`，解析底层代码块内容并提取当前消息与会话身份，避免将未完成的流式 JSON 当成有效图表；支持展开查看原始 JSON 源码。 |
| [`public/viz.css`](file:///c:/pi-GUI/public/viz.css) | 极简灰阶主题样式。严格适配 pi-GUI CSS 变量（`--bg`、`--border`、`--text`、`--accent`），无缝兼容浅色/深色模式；适配 320px 窄窗口 Overlay 抽屉与高 DPI 屏幕。 |
| [`public/markdown.js`](file:///c:/pi-GUI/public/markdown.js) | 围栏代码块安全拦截。当 `lang === 'pi-gui-viz'` 且校验合法时渲染带操作入口的 `.viz-card`；若 JSON 未闭合、语法错误或超限，安全回退为原生 `<pre class="code" data-lang="pi-gui-viz">`，普通对话不受任何干扰。 |
| [`public/app.js`](file:///c:/pi-GUI/public/app.js) | 全局启动接线，调用 `initVizIntegration()` 挂载事件委托。 |
| [`public/index.html`](file:///c:/pi-GUI/public/index.html) | 引入 `viz.css` 样式文件。 |
| [`package.json`](file:///c:/pi-GUI/package.json) | 注册 `"test:viz"`（Schema + UI）与 `"test:viz:electron"`，接入主测试链。 |
| [`tests/viz-schema.cjs`](file:///c:/pi-GUI/tests/viz-schema.cjs) | 16 项协议校验定向测试，覆盖全部白名单、大小超限、异常类型、非数值降级及参数清洗。 |
| [`tests/viz-ui.cjs`](file:///c:/pi-GUI/tests/viz-ui.cjs) | 40 项 UI 与生命周期测试，覆盖 Markdown 降级、折叠/展开、面板打开、SVG 元素与坐标、类型切换、系列开关、阈值调整、重置、Composer 引用及会话切换失效。 |
| [`tests/viz-electron.cjs`](file:///c:/pi-GUI/tests/viz-electron.cjs) | 8 项真实 Electron 44.4.3 正常沙箱实测，生成真实 Chromium 布局与 PNG 截图证据。 |

---

## 二、真实 Electron 实测与交互截图证据

在真实 Electron 44.4.3 / Chromium 环境（`BrowserWindow` 1280×800、`sandbox: true, contextIsolation: true`）中完成实机测试与截图生成，证据保存在 `docs/evidence/z3/`：

1. **消息流内图表卡片**：[`01-chat-stream-viz-cards.png`](evidence/z3/01-chat-stream-viz-cards.png)
   - 消息流正常呈现段落与标题，两个 `pi-gui-viz` 代码块被渲染为精致的灰阶图表卡片（含图表图标、标题、系列与数据点统计）。
   - 提供「打开可视化」按钮与「JSON」源码展开按钮。
2. **右栏折线图呈现**：[`02-line-chart-in-right-pane.png`](evidence/z3/02-line-chart-in-right-pane.png)
   - 点击卡片按钮无缝滑出右侧工作区面板（复用 Secondary Surface），主聊天界面不脱卸。
   - 顶部显示标题、数据项概览、重置与引用按钮；中部为参数交互栏；下方为自适应 SVG 折线图与坐标网格。
3. **切换为柱状图形态**：[`03-bar-chart-switched.png`](evidence/z3/03-bar-chart-switched.png)
   - 点击形态栏的「柱状图」按钮，即时转换为分组柱状图，SVG 自适应重新计算柱宽与间距。
4. **阈值告警高亮**：[`04-threshold-highlight.png`](evidence/z3/04-threshold-highlight.png)
   - 调整阈值滑块为 50%，SVG 自动画出橙红色虚线参考线与数值标签，超过阈值的点与柱条自动获得 `is-alert` 警示样式。
5. **引用配置与摘要到 Composer**：[`05-quoted-to-composer.png`](evidence/z3/05-quoted-to-composer.png)
   - 点击「引用到对话」，当前图表名称、形态、激活系列均值/极值、超标统计与参数以紧凑 Markdown 格式追加至输入框，保留原草稿，不自动发送。
6. **浅色主题自适应**：[`06-light-theme-adaptation.png`](evidence/z3/06-light-theme-adaptation.png)
   - 切换到浅色模式，卡片背景、边框、坐标轴文本与网格线完美适配高对比度。
7. **窄窗口自适应布局**：[`07-narrow-window-responsive.png`](evidence/z3/07-narrow-window-responsive.png)
   - 窗口缩窄至 760px 时，右栏自动进入受控 Overlay 模式，聊天地板受到保护。
8. **多图表无冲突切换**：[`08-second-chart-switched.png`](evidence/z3/08-second-chart-switched.png)
   - 点击消息流中第二个图表卡片（编译耗时柱状图），旧图表及参数监听器干净销毁，右栏即时刷新为新图表。

---

## 三、测试证据与验证记录

### 1. 新增定向测试套件

- **`node tests/viz-schema.cjs`**：16/16 PASS，耗时 ~0.08s
- **`node tests/viz-ui.cjs`**：40/40 PASS，耗时 ~0.25s
- **`node tests/viz-electron.cjs`**：8/8 PASS，耗时 ~3.2s

### 2. 相邻模块回归测试

- `node tests/context-reference-ui.cjs`：10/10 PASS
- `node tests/logging-ui.cjs`：11/11 PASS
- `node tests/specs-ui.cjs`：25/25 PASS
- `node tests/split-workbench-ui.cjs`：30/30 PASS
- `node tests/ui2-classic.cjs`：48/48 PASS
- `node tests/ui3-composer.cjs`：34/34 PASS

### 3. Canonical 测试计划验证

- `scripts/test-group-plan.mjs`：计划校验 `validateTestGroupPlan` 为 `true`。
- 完整命令数由 198 条平稳扩增至 200 条（增加 `node tests/viz-schema.cjs` 与 `node tests/viz-ui.cjs`），各组严格有序。

### 4. 单文件 EXE 打包与产物检验

- `npm run build:exe`：成功生成 `build/Pi GUI.exe`（98.0 MB），无语法或模块丢失。
- `CHECK_PORT=19788 node tests/exe-check.cjs`：49/49 PASS，全部自测与单文件内嵌资源加载正常。

---

## 四、安全与会话生命周期边界说明

1. **不可信输入防护**：
   - 模型输出无论多么复杂或异常，均通过 `parseVizData` 经过极其严格的白名单剥离。严禁任何 HTML 注入，所有动态标签与文本均通过 DOM API 设置 `textContent` 或 `setAttribute`，杜绝 XSS。
2. **纯函数受控计算**：
   - 参数面板仅允许调节预定义的阈值数值、数据范围截取（`slice`）与系列布尔显隐，严禁执行模型传入的任何 JavaScript 函数或表达式。
3. **零外部网络与文件越权**：
   - 不产生任何新的网络请求，不读取本地文件系统，不暴露任何 Electron 内部接口。
4. **会话与工作区隔离**：
   - 图表面板打开时记录 `sessionId` 与 `workspaceGeneration`。
   - 当检测到会话切换（`pi-gui:session-switch`）或工作区视图变更时，图表面板自动关闭。
   - 若会话身份不一致，点击「引用到对话」时会明确拒绝写入并弹出提示，保护上下文不被串扰。
5. **资源释放（No Leaks）**：
   - 通过 `instance.onDispose` 在面板切换或关闭时注销全部事件监听、移除 Tooltip 浮层与图表 DOM，避免内存泄漏。

---

## 五、后续扩展建议（Z3-B 及更高阶段）

1. **扩展可视化类型**：
   - 在保持零大型依赖的前提下，可继续用受控原生 SVG 扩展出雷达图（Radar）、饼图/环形图（Pie/Donut）、以及散点图（Scatter）。
2. **流程图与架构图（Diagrams）**：
   - 制定受控的 `pi-gui-flow` 节点与连接线协议（`nodes: [...], edges: [...]`），利用 SVG 拓扑布局自动渲染技术架构与流程图。
3. **Agent / 用户双向协同编辑**：
   - 允许用户在参数面板修改后的配置通过结构化 Action 反馈给 Agent（例如由 Agent 根据用户调整的阈值重新进行代码优化或分析）。
