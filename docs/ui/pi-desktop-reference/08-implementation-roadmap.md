# 08. 分阶段实施与代码重构路线图 (Implementation Roadmap)

> **修订说明 (Audit Revision)**：
> 1. 本实施方案摒弃了前一版本的脱节设想，完全立足于 pi-GUI 真实已有代码（Commit: `f4e6591e22206a4a0b2447292003fdf4eaf21c03`）。
> 2. 全面核实所有 npm 命令与真实测试套件：彻底移除不存在的 `npm run test:unit` 与 `test/unit/settings.test.mjs`，换用 `package.json` 中真实注册的 `npm run test:theme`、`npm run test:auth`、`npm run test:ui3`、`node tests/ui3-composer.cjs` 及全量规范测试 `npm test`。
> 3. 明确运行时真实命令用途：
>    - `npm start`：启动 Web 后端服务 (`node server.js`)。
>    - `npm run dev`：带热重载的开发态 Web 后端 (`node --watch server.js`)。
>    - `npm run app`：启动 Electron 桌面客户端 (`electron .`)。
> 4. 深度复用已有组件：`public/composer.js` (`ui3-composer`), `public/ui3-model-picker.js`, `public/ui/inline-command-menu.js`, `public/right-pane.js`, `public/providers.js`, `public/provider-auth.js`, `public/theme.js`，重构重点为视觉代币对齐，绝不重复造轮子。

---

## 1. 总体实施原则与工程约束

1. **架构自治**：坚持 pi-GUI 现有的 **原生 JavaScript (ES Modules) + Electron + Node.js** 技术架构。不搞休克式技术栈重写，不引入 React、TypeScript 或 Rust 编译依赖。
2. **净室独立实现**：遵守 LGPL-3.0 许可证合规要求，严禁从 PI-Desktop 源码中直接复制任何 `.tsx`、`.ts` 或 `.css` 文件。仅复用其提取出的设计代币参数与交互规格，在 pi-GUI 中以原生标准自主编码。
3. **现有抽象优先**：严格遵循仓库原则“任务描述与现有代码冲突时，以现有代码为准”，复用既有的 `workspace-surface.js`、`settings-surface.js`、`right-pane.js`、`ui3-composer.css` 等模块。
4. **真实测试与证据门槛**：每一阶段完成后必须运行真实的定向回归测试（通过 `package.json` 中的实际测试套件），必须采集实际运行截图证明视觉对齐，禁止口头宣布“全绿”。

---

## 2. 真实测试命令与运行环境矩阵

| 命令 | 实际执行操作 | 适用场景与验证目标 |
|---|---|---|
| `npm start` | `node server.js` | 启动 Web 端主后端服务，监听本地端口。 |
| `npm run dev` | `node --watch server.js` | 开发调试 Web 端，文件变动时自动重启后端。 |
| `npm run app` | `electron .` | **运行真实 Electron 桌面客户端**，用于实时视觉与窗口交互验证。 |
| `npm run test:theme` | `node tests/theme.cjs` | 主题配置持久化与切换逻辑回归。 |
| `npm run test:auth` | `node tests/provider-auth.cjs` | 供应商认证状态机与安全回调回归。 |
| `node tests/ui3-composer.cjs` | `node tests/ui3-composer.cjs` | 浮动 Composer 输入框自适应与发送状态单测。 |
| `node tests/ui3-model.cjs` | `node tests/ui3-model.cjs` | 模型选择器与思考深度状态渲染单测。 |
| `node tests/ui3-inline-commands.cjs` | `node tests/ui3-inline-commands.cjs` | 斜杠命令补全菜单按键拦截与项选择单测。 |
| `npm run test:ui3` | `node tests/ui3-integration-electron.cjs` | UI-3 输入框与模型选择器 Electron 端端集成。 |
| `node tests/split-workbench-ui.cjs` | `node tests/split-workbench-ui.cjs` | 工作面板分栏拖拽与视区切换单测。 |
| `npm test` | 执行 `package.json` 完整测试链 | **全量回归唯一真相**，发版与阶段合并前必须绿灯。 |

---

## 3. 分阶段实施方案详述

### 阶段 A：统一 Design Tokens 与基础 UI 原语 (Tokens & Primitives) 【已完成】
- **实施状态**：**已完成并通过全部定向测试与集成验证**
- **目标概述**：将 `tokens.reference.css` 引入项目，建立与 PI-Desktop 完全对齐的 `--ds-*` 语义令牌层，实现中性单色强调体系（浅色下 Accent 反转为 `#1a1c1f`），对齐圆角与排版阶梯，引入 `--font-scale: 1` 确保跨平台计算严密性。
- **复用模块**：
  - `public/tokens.css` (注入 `--ds-*` 完整变量体系，保留所有既有 `--ui-*` 变量桥接保证兼容性)
  - `public/theme.js` (`themePreference()`, `setThemePreference()`, `onThemeChange()`)
- **新增模块**：
  - `public/ui/primitives.js` (封装原生 DOM 控件：`createSettingsToggle`, `createSegmentedControl`, `createHelpIcon`, `createBadge`, `createSettingsCard`, `createSettingsRow`)
  - `public/ui/primitives.css` (实现对应 UI 原语的样式表，遵循 PI-Desktop 2px 节拍圆角与微交互)
  - `tests/primitives.cjs` (公共控件自动化单测套件)
- **状态管理影响**：无业务状态破坏，变量层完全向前兼容。
- **功能回归测试**：
  - `node tests/primitives.cjs` (通过)
  - `npm run test:theme` (47/47 通过)
  - `node tests/dev-server.cjs` (30/30 通过)
- **验收截图交付**：已在 Electron 1.5x 真实环境下采集并纳入 `docs/ui/screenshots/`。

---

### 阶段 B：重构设置中心为分类导轨与卡片流 (Settings Overhaul) 【已完成】
- **实施状态**：**已完成并通过全部定向测试与真实 Electron 截图对比验收**
- **目标概述**：将设置界面从原有简陋行布局重构为 275px 固定分类导轨 (`--ds-settings-nav-width`) + 居中 760px 卡片流模式，严格落实 D601 规范（标题与控件同行，解释文字与微型选择器对齐）。重构供应商管理为 REF-007 空态与 REF-008 卡片列表，重构应用更新为 REF-012 版本卡片。
- **复用与重构模块**：
  - `public/ui/settings-surface.js` (`initSettingsSurface()`, `returnToWorkspace()`, `presentDetail()`, `sync()`)
  - `public/ui/workspace-surface.js` (`openWorkSurface('settings', ...)`, `#workSurface` 容器管理)
  - `public/settings.js` (`openAppearance()`, `openAppUpdates()` 全面卡片化)
  - `public/providers.js` (`renderProviders()` 重构为空态双圆角矢量图标卡片与 Monogram 供应商卡片)
  - `public/styles.css` (重构 `.project-sidebar.settings-mode`、`#globalMoreMenu`、`#settingsReturn`、`.settings-surface`、`.settings-detail-card`、`.appearance-body`、`.ds-select`、`.prov` 等)
- **废弃/清理的旧样式**：
  - 移除旧有的无边框下划线 `.settings-row` 简陋排版；
  - 移除原 `.prov` 扁平无品牌首字母的旧条目样式。
- **状态管理影响**：
  - 设置持久化完全由 `providers.js` 与 `theme.js` 既有模型处理，新增分类切换不改变配置保存路径与网络协议。
- **功能回归测试**：
  - `node tests/ui-ia.cjs` (26/26 通过)
  - `npm run test:auth` (105/105 通过)
  - `npm run test:theme` (47/47 通过)
  - `node tests/ui2-visual.cjs` (57/57 通过)
  - `node tests/smoke.cjs` (1338/1338 通过)
- **验收截图交付**：
  - `settings-overview-dark.png` (对标 `REF-004`)
  - `settings-appearance-dark.png` (对标 `REF-004` / `REF-005`)
  - `settings-providers-empty-dark.png` (对标 `REF-007`)
  - `settings-providers-list-dark.png` (对标 `REF-008`)
  - `settings-app-updates-dark.png` (对标 `REF-012`)
  - `settings-overview-light.png` / `settings-appearance-light.png` / `settings-providers-list-light.png` (对标浅色规范与 `REF-021`)

---

### 阶段 C：重构主界面外壳、连续顶栏与侧边栏 (App Shell & Sidebar)
- **本轮实施说明**：以固定源码和真实生产边界修正以下早期设想，见 [源码勘察](12-phase-c-implementation.md) 与 [验收记录](13-phase-c-acceptance.md)。
- **目标概述**：46px 连续无分割线顶栏、275px 侧栏、深浅语义背景、折叠至 0 与项目/会话导航。运行点读取既有活动状态；底栏只保留真实设置、外观及连接状态，不硬造四个无业务按钮，不新增呼吸动画。
- **复用模块**：
  - `public/app.js` (`updateTitle()`, `bindSidebarEvents()`)
  - `public/projects.js`, `public/sessions.js`, `public/tree.js`
  - `public/index.html` 中的主容器结构
- **实际复用与样式归属**：
  - `public/shell.js` 的 Classic/Runtime 标题投影增加所属项目显示；改名继续使用已有侧栏编辑器及其能力限制。
  - `public/ui/action-menu.js` 继续作为唯一菜单系统；项目和经典会话右键复用同一入口与权限。
  - `public/app-shell.css` 集中外壳样式，清理 `styles.css` 内已取代的侧栏覆盖规则；设置 A/B 的布局继续由原规则持有。
- **废弃/清理的旧样式**：
  - 移除侧边栏右边缘突兀的 1px 亮灰竖线；
  - 移除侧边栏底部旧的折叠式 `设置` 下拉容器样式。
- **状态管理影响**：
  - 保持 `currentSessionId` 与 `currentProjectPath` 数据结构不变，仅改变其在顶栏与侧栏的渲染形式。
- **功能回归测试**：
  - `node tests/sidebar-menu.cjs`
  - `node tests/stable-session-order.cjs`
  - `node tests/app-shell.cjs`、`npm run test:shell:electron`
  - 会话后台执行、Runtime、主题、设置定向检查与完整 canonical，实际数字见验收记录。
- **验收截图交付**：
  - 截图 1：聊天主界面空状态 · 侧边栏展开态（对标 `REF-001`）。
  - 截图 2：聊天主界面空状态 · 侧边栏完全折叠态（对标 `REF-002`）。
  - 截图 3：侧边栏项目右键上下文菜单展开态（对标 `REF-020`）。

---

### 阶段 D：重构核心对话流与完善 Composer (Conversation & Composer)
- **目标概述**：剥离助手回复的外围灰色气泡框，改为纯净 Prose 直排；用户消息改为右侧大圆角卡片并增加悬停浮动工具条；将既有 `ui3-composer` 的圆角、阴影与发送按钮全面接入 `--ds-*` 规范（20px 圆角 `--ds-composer-radius`，阴影 `--ds-shadow-composer`）；将既有 `ui3-model-picker` 卡片应用 `--ds-shadow-model-menu`。
- **复用模块**：
  - `public/messages.js` (消息流追加、Markdown 渲染与代码高亮)
  - `public/composer.js` (`initComposerLayout()`, `autoGrow()`, `updateSendState()`)
  - `public/ui3-composer.css` (既有浮动 Composer 样式表)
  - `public/ui3-model-picker.js` (既有模型与思考深度选择器)
  - `public/ui3-model.css`
  - `public/ui/inline-command-menu.js` (既有斜杠命令自动补全)
  - `public/ui3-inline-commands.css`
- **新增模块**：
  - `public/ui/message-actions.js` (消息悬停浮动工具条：复制、编辑重发、删除)
  - `public/ui/context-inspector.js` (Token 环点击弹出的用量卡片，对标 `REF-023`)
- **废弃/清理的旧样式**：
  - 移除 `public/styles.css` 中包裹在 AI 消息外层的卡片边框与灰色背景；
  - 清理 `ui3-composer.css` 与 `ui3-model.css` 中残留的旧版 `--ui-*` 临时参数。
- **状态管理影响**：
  - 保持消息流与 WebSocket/RPC 通道完全不变；输入草稿通过既有逻辑暂存。
- **功能回归测试**：
  - `node tests/ui3-composer.cjs`
  - `node tests/ui3-model.cjs`
  - `node tests/ui3-inline-commands.cjs`
  - `npm run test:ui3`
- **验收截图交付**：
  - 截图 1：单轮对话流式执行态与思考折叠（对标 `REF-016`）。
  - 截图 2：对话执行完成态与消息悬停操作条（对标 `REF-017`）。
  - 截图 3：模型选择器 Popover 展开态（对标 `REF-015`）。

---

### 阶段 E：规范化右侧多标签工作台 (WorkPanel Alignment)
- **目标概述**：将 pi-GUI 现有已高度完备的右侧工作台（`#workPanelNav` 中的分支树、文件变更/审阅、项目 Specs、协同文档、内置浏览器）的顶栏与标签样式对齐为 PI-Desktop 规范（46px 顶栏、28px 方形控制簇、D297 无分割线、`WorkTabEmpty` 空状态）。
- **复用模块**：
  - `public/right-pane.js` (`initRightPane()`, `createPaneHeader()`, `RIGHT_PANE_LIMITS`)
  - `public/ui/split-workbench.js` (分栏拖拽与宽度计算)
  - `public/index.html` 中的 `#workPanelNav` 与 `#rightPane`
  - `public/candidate-review.js`, `public/diff.js`, `public/diff-comments.js` (审阅与批注)
  - `public/specs-panel.js` (Specs 标签)
  - `public/browser-pane.js` (浏览器标签)
  - `public/collab-panel.js` (协同标签)
- **新增模块**：
  - `public/ui/work-tab-empty.js` (封装规范化的空状态卡片原语：居中图标 + 标题 + 弱化正文)
- **废弃/清理的旧样式**：
  - 移除工作面板顶栏与标签项多余的硬编码边框；
  - 统一工作台内部背景为 `--ds-bg-dock` (`#212121` / 浅色 `#fafafa`)。
- **状态管理影响**：
  - 保持各工作区子业务的状态隔离，Tab 仅控制挂载与隐藏。
- **功能回归测试**：
  - `node tests/split-workbench-ui.cjs`
  - `node tests/browser-workbench-ui.cjs`
  - `npm run test:diff-comments`
- **验收截图交付**：
  - 截图 1：主界面 + 工作台新建标签页空状态（对标 `REF-003`）。
  - 截图 2：工作台文件管理器与审阅标签页（对标 `REF-019`）。

---

### 阶段 F：浅色模式适配与全量测试收敛 (Light Theme & Convergence)
- **目标概述**：在 `:root[data-theme="light"]` 下对全量界面进行严格视觉验收，确保浅色模式下 `#f3f3f3` 边栏、纯白主背景、中性深墨黑文字与白底浮动卡片层次分明，完成全局高对比度与无边框阴影验收。
- **复用模块**：全局所有重构后组件。
- **新增模块**：无新增 JS 模块，仅微调浅色模式下的令牌消费。
- **废弃/清理的旧样式**：彻底清除浅色模式下任何残留的文字发白或强边框问题。
- **状态管理影响**：无。
- **功能回归测试**：
  - 运行全量测试套件：`npm test` (必须保持全部通过，断言总数不减少)。
- **验收截图交付**：
  - 截图 1：浅色模式完整对话视图（对标 `REF-021`）。
  - 截图 2：浅色模式斜杠命令补全菜单（对标 `REF-022`）。
  - 截图 3：浅色模式上下文用量检查器（对标 `REF-023`）。
  - 截图 4：浅色模式文件提及补全卡片（对标 `REF-024`）。
