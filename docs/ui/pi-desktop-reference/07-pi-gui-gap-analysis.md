# 07. pi-GUI 现有实现逐项差异分析 (Gap Analysis & Alignment)

> **版本基准说明 (Baseline Audited)**：
> - **目标项目 (Target)**：`HYJ1817/pi-gui` @ Commit SHA: `f4e6591e22206a4a0b2447292003fdf4eaf21c03` (当前工作区基线)
> - **参考项目 (Reference)**：`vastsa/PI-Desktop` @ Commit SHA: `92ae661f1e399e69d514086b46029b4c34ba1a92` (版本 `v0.21.0`)
> - **开源协议边界 (License Compliance)**：PI-Desktop 遵循 **LGPL-3.0** 许可证，pi-GUI 遵循 **MIT** 许可证。严格采用**独立净室实现 (Clean-Room Implementation)** 策略——仅从参考源码中逆向提取设计参数、尺寸阶梯、色彩空间与交互规格，在 pi-GUI 中使用原生 ES Modules 和原生 CSS 独立编写，严禁直接复制、改编或分发上游 TypeScript/React 组件或 CSS 样式文件。

---

## 1. 核心技术架构与真实状态持有边界对比

经过对 pi-GUI 当前源码的全面核查，纠正此前将功能错误归属到单个文件的偏差，梳理出真实的状态持有与模块边界：

| 架构维度 | PI-Desktop (参考实现) | pi-GUI (当前真实实现与模块归属) | 适配与复用策略 (严守软硬件与功能约束) |
|---|---|---|---|
| **技术底座** | React 19 + TypeScript + Zustand + Tailwind v4 + Electron + Rust 宿主核心 | 原生 JavaScript (ES Modules) + Electron + Node.js RPC + 原生 Vanilla CSS | **严守用户硬约束**：不迁移 React/TS/Rust，完全复用 pi-GUI 原生 JS 架构，通过标准化 `--ds-*` 令牌与原生 DOM 模块实现视觉逼近。 |
| **设置与偏好生命周期** | 全屏接管模式 (`.settings-mode`)，275px 固定左侧导航轨，右侧流式卡片，D601 行内帮助图标 | **真实实现分属三个模块**：<br>1. 外壳与视图生命周期：`public/ui/settings-surface.js` (`initSettingsSurface`, `openWorkSurface('settings')`, `returnToWorkspace`, `sidebar.classList.toggle('settings-mode')`)；<br>2. 外观与更新弹窗：`public/settings.js` (`openAppearance`, `openAppUpdates`)；<br>3. 主题与持久化：`public/theme.js` (`themePreference`, `setThemePreference`, `onThemeChange`) | **深度复用现有结构**：保留 `settings-surface.js` 的生命周期与导航切入机制，将侧边栏在 `settings-mode` 下的展示形态对齐为 275px 分类轨 (`--ds-settings-nav-width`)，卡片流采用 D601 单行 + `HelpIcon` 规范。 |
| **供应商与认证管理** | `ProviderSetupDialog.tsx` + `ServiceChooser.tsx`，网格卡片选择器，多供应商凭据抽屉 | **真实实现位于**：<br>1. 供应商管理：`public/providers.js` (`loadProviders`, `renderProviders`, `openProvidersPanel`, `openProviderAuthPanel`, `removeProvider`, `openAddProvider`, `reloadPi`)；<br>2. 认证交互流：`public/provider-auth.js` (`mountProviderAuth`, `safeAuthUrl`, 浏览器 OAuth 与 Device Code) | **保留业务逻辑，重构展示层**：绝不重写 `providers.js` 的读写与测试逻辑；将 `renderProviders` 与 `openProviderAuthPanel` 的弹窗/面板容器对齐为 PI-Desktop 的 D625 网格平铺与 D297 无分割线风格。 |
| **浮动输入框 (Composer)** | 浮动胶囊 (Floating Composer, 20px 圆角 `--ds-composer-radius`)，集成模式选择、模型与思考深度选择、Token 环 | **真实已有完整组件架构**：<br>1. 容器与自适应：`public/composer.js` (`initComposerLayout`, `autoGrow`, `updateSendState`, `renderModelControls`) 与 `public/ui3-composer.css` (`#chatComposer .composer-box`)；<br>2. 模型与推理等级：`public/ui3-model-picker.js` (`renderModelPicker`, `renderThinkingPicker`, `applyChipState`) 与 `public/ui3-model.css`；<br>3. 斜杠命令：`public/ui/inline-command-menu.js` 与 `public/ui3-inline-commands.css` | **已具备完整功能，仅需视觉令牌对齐**：pi-GUI 已拥有浮动 Composer (`ui3-composer`) 与模型选择器 (`ui3-model-picker`)，无需从零开发！本次重点是将边框、阴影、圆角与发送按钮状态全面映射到 `--ds-*` 规范（如 `--ds-shadow-composer`, `--ds-send-disabled-*`, 20px 大圆角）。 |
| **右侧工作面板 (WorkPanel)** | 多标签工作区 (`WorkPanel.tsx`)：内置审阅、浏览器、文件管理器、子智能体监控，支持拖拽与最大化 | **真实已有完整多标签工作台**：<br>1. 分栏拖拽与容器：`public/right-pane.js` (`initRightPane`, `createPaneHeader`, `RIGHT_PANE_LIMITS`) 与 `public/ui/split-workbench.js`；<br>2. 标签导航栏 (`#workPanelNav`)：<br>  - 分支树 (`#btnTree`, `public/tree.js`, `worktrees.js`)<br>  - 文件变更与审阅 (`#navChanges`, `candidate-review.js`, `diff.js`, `diff-comments.js`)<br>  - Specs 规范 (`#btnSpecs`, `specs-panel.js`, `specs-tree.js`)<br>  - 协同文档 (`#btnCollab`, `collab-panel.js`, `collab-canvas.js`)<br>  - 内置浏览器 (`#btnBrowser`, `browser.js`, `browser-pane.js`) | **规范化视觉对齐**：右侧面板各业务功能已高度完备，重点是对齐标题栏高度 (`--ds-toolbar-height: 46px`)、关闭与最大化控制簇 (`--ds-work-panel-toggle-size: 28px`) 及标签内联徽章 (`Badge`) 的视觉样式。 |

---

## 2. 完整功能映射矩阵 (Three-Tier Feature Matrix)

为防止盲目追求截图一致而伪造无后端支撑的假功能或破坏原有逻辑，建立严格的三级功能分类矩阵：

### 2.1 类别 A：pi-GUI 已存在且需视觉重构的功能 (Visual Restyle)
*这些功能在 pi-GUI 中已有完备的业务逻辑与后端接口，重点是对齐视觉语言、布局尺寸和状态动效。*

| 功能模块 | pi-GUI 当前真实实现路径 | PI-Desktop 参考位置 (GitHub Permalinks) | 关键视觉差距与重构要点 |
|---|---|---|---|
| **全局设计令牌与主题** | `public/tokens.css`, `public/theme.js`, `public/styles.css` | [`styles/tokens.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/tokens.css) | 统一接入 `tokens.reference.css` 的 `--ds-*` 体系；实现浅色模式下 Accent 反转为 `#1a1c1f`；消除页面内强硬边框。 |
| **全局导航外壳与顶栏** | `public/index.html` (`.stage-head`), `public/app.js` | [`features/app/AppShell.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/app/AppShell.tsx), [`components/ConversationTopbar.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ConversationTopbar.tsx) | 顶栏高度定为 46px (`--ds-toolbar-height`)；增加项目/会话面包屑导航；预留右侧 120px (`--ds-window-controls-width`) 窗口控件安全区。 |
| **侧边栏项目与会话树** | `public/projects.js`, `public/sessions.js`, `public/tree.js` | [`components/Sidebar.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/Sidebar.tsx) | 边栏背景改纯黑 `#000000` (浅色 `#f3f3f3`)；增加橙色两轮呼吸后常亮运行圆点；底部固定 4 键工具条与版本号。 |
| **对话流式消息流** | `public/messages.js`, `public/runtime-conversation.css` | [`features/chat/transcript/ChatTranscript.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/chat/transcript/ChatTranscript.tsx), [`AssistantTurn.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/chat/transcript/AssistantTurn.tsx) | 助手回复剥离外层灰色气泡框，采用纯净 Prose 直排；用户气泡右对齐 18px 圆角 (`--radius-lg-plus`)；增加悬停半透明浮动操作条。 |
| **浮动输入框 (Composer)** | `public/composer.js`, `public/ui3-composer.css`, `public/index.html` (`#chatComposer`) | [`components/Composer.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/Composer.tsx), [`styles/composer.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/composer.css) | 复用现有 `ui3-composer` 结构；容器圆角对齐 20px (`--radius-xl`)，阴影应用 `--ds-shadow-composer`；发送按钮应用 `--ds-send-disabled-*`。 |
| **模型与思考深度选择** | `public/ui3-model-picker.js`, `public/ui3-model.css` | [`features/chat/composer/ComposerModelPicker.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/chat/composer/ComposerModelPicker.tsx) | 复用现有 `ui3-model-picker` 逻辑；弹出卡片应用 `--ds-shadow-model-menu` 与 `--radius-md` (12px)，优化模型身份行与思维深度标签。 |
| **斜杠命令自动补全** | `public/ui/inline-command-menu.js`, `public/ui3-inline-commands.css` | [`components/ComposerAutocomplete.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ComposerAutocomplete.tsx) | 复用现有命令拦截与定位逻辑；卡片样式对齐 REF-022（分类标题大写、单项悬停 `--ds-bg-hover`、图标左侧对齐）。 |
| **供应商配置与管理** | `public/providers.js` (`renderProviders`), `public/provider-auth.js` (`mountProviderAuth`) | [`components/settings/ProviderSetupDialog.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/ProviderSetupDialog.tsx), [`ServiceChooser.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/ServiceChooser.tsx) | 采用 D625 网格平铺设计重构弹窗；左右双栏模型管理；保留现有端点连接与 OAuth/Device-Code 认证链路。 |
| **右侧工作面板与审阅** | `public/right-pane.js`, `candidate-review.js`, `diff-comments.js` | [`components/workpanel/WorkPanel.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/workpanel/WorkPanel.tsx), [`FilesTab.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/workpanel/FilesTab.tsx) | 顶栏对齐 46px 高度与 28px 方形图标按钮；空状态对齐 `WorkTabEmpty` 规范（图标居中 + 标题 + 弱化正文）；保留完整 Diff 批注能力。 |

### 2.2 类别 B：pi-GUI 已存在但交互组织不同的功能 (Interaction Alignment)
*这些功能在两个项目中具备等价的业务价值，但 UI 交互架构存在组织形态差异，需进行优雅适配。*

| 功能模块 | pi-GUI 当前交互形态 | PI-Desktop 交互形态 | 推荐适配方案 (保持原有能力不丢失) |
|---|---|---|---|
| **设置中心整体形态** | `settings-surface.js` 将设置作为工作区表面呈现，侧栏展开抽屉菜单；卡片样式较散乱 | 全屏接管 (`settings-mode`)，左侧 275px 固定分类轨 (`.settings-rail`)，右侧卡片流，D601 行内说明 | **复用 `settings-surface.js`**：保留 `openWorkSurface('settings')` 与 `returnToWorkspace()` 生命周期，将侧边栏在 `settings-mode` 下重构为分类导航轨（偏好、智能体、工作区、系统），右侧 `#workSurface` 组织为标准的 `SettingsCard` 流，行内集成 `HelpIcon`。 |
| **任务规划与审阅 (Planner)** | 作为独立中央视图 (`workspaceView === 'planner'`)，具备步骤清单与阶段审阅 | 集成在对话流内的内联审批条 (`PlanApprovalBar`, `ReviewChangeCard`) 及 Composer 规划模式胶囊 | **双模保持**：保留 pi-GUI 完整的多步骤 Planner 视图和独立生命周期，在对话流中增加符合 PI-Desktop 视觉风格的流内审批卡片，并在 Composer 工具栏提供规划模式切换胶囊。 |
| **工具权限审批** | 会话内简单提示或原生对话框确认 | 内联权限卡片 (`PermissionCard`) + Composer 权限模式胶囊 (`ComposerPermissionPicker`) | 统一使用内联式权限卡片规范（包含操作标题、参数摘要、允许/拒绝操作），与 PI-Desktop 视觉规范完全对齐。 |

### 2.3 类别 C：PI-Desktop 独有、pi-GUI 尚未实现的功能 (PI-Desktop Exclusive)
*严禁为了追求视觉截图表面一致而伪造无实际业务支撑的空入口或死按钮！*

| 功能模块 | PI-Desktop 实现机制 | pi-GUI 现状与处理准则 |
|---|---|---|
| **跨设备配置云同步 (Config Sync)** | 连接远端保险库加密同步配置 (`ConfigSyncPage.tsx`) | **不予新增 / 排除验收**。pi-GUI 配置为本地文件持有，无云端服务端支持，严禁在设置中增加虚假云同步入口。 |
| **远程主机 SSH (Remote Hosts)** | 维护远程 SSH 凭据与远程代理会话 (`RemoteHostsPage.tsx`) | **不予新增 / 排除验收**。pi-GUI 专注本地工作区与外部 pi RPC 交互，不引入无后端的假远程主机页面。 |
| **JEV 实时语音通信 (Live Voice)** | 基于 PCM AudioWorklet 的双向全双工语音流 (`VoiceSettingsSection.tsx`) | **不予新增 / 排除验收 (REF-006)**。pi-GUI 无实时双向音频引擎，保留现有文本与附件交互，不在设置中放置不可用的语音呼叫假控件。 |
| **第三方插件生态市场 (Plugin Market)** | 在线插件源检索与评论打分系统 (`PluginsPage.tsx`, `SkillMarketPanel.tsx`) | **不予新增 / 排除验收 (REF-009)**。pi-GUI 已有本地 Extensions 与 Skills 管理，优先做好本地扩展与技能的卡片化展示，不构建假外部市场网络请求。 |
| **独立子智能体配置抽屉 (Subagents Sheet)** | 多智能体声明与委托规则编辑 (`AgentSubagentsPage.tsx`, `SubagentEditorSheet.tsx`) | **不予新增 / 排除验收 (REF-011)**。pi-GUI 的子智能体由底层 pi 引擎按指令调度，未提供独立声明抽屉，不在界面上伪造独立抽屉。 |

---

## 3. 逐项深度技术差异与代码级改造方案

### 3.1 设置中心生命周期与架构复用 (Settings Lifecycle)
- **参考截图**：`REF-004`, `REF-005`, `REF-007`, `REF-008`, `REF-010`, `REF-012`
- **参考源码**：[`features/settings/SettingsPage.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/settings/SettingsPage.tsx), [`features/settings/primitives.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/settings/primitives.tsx)
- **pi-GUI 现有代码**：
  - `public/ui/settings-surface.js`: `initSettingsSurface()`, `openWorkSurface('settings', ...)`, `sidebar.classList.toggle('settings-mode', open)`, `returnToWorkspace()`, `presentDetail(target)`.
  - `public/settings.js`: `openAppearance()`, `openAppUpdates()`.
  - `public/theme.js`: `themePreference()`, `setThemePreference()`, `onThemeChange()`.
  - `public/providers.js`: `loadProviders()`, `renderProviders()`, `openProvidersPanel()`, `openProviderAuthPanel()`.
  - `public/provider-auth.js`: `mountProviderAuth()`.
- **现有差异**：
  - pi-GUI 现有逻辑已经能成功触发 `settings-mode` 并挂载到 `#workSurface`，但 `#workSurface` 内部排版松散，左侧侧边栏只作为弹出菜单而非 275px 固定分类导轨。
  - 控件混杂了原生浏览器单选/复选框，缺乏 PI-Desktop 的 `SettingsToggle` 与 `SegmentedControl` 质感。
- **重构方案**：
  1. 复用 `settings-surface.js` 中的 `initSettingsSurface` 与 `returnToWorkspace`。
  2. 当 `sidebar.classList.contains('settings-mode')` 时，应用新的 CSS 规则将侧栏呈现为 275px 的固定分类导轨 (`.settings-rail`)，包含偏好、智能体、工作区、系统四大分组。
  3. 点击导轨条目调用现有的 `presentDetail(target)`，在 `#workSurface` 中渲染对应的标准 `SettingsCard`。
  4. 严格执行 D601 规范：将设置项标题与控件放在单行，辅助解释文本收纳于 `HelpIcon` 问号气泡内。

---

### 3.2 聊天对话流与无边框 Prose 渲染 (Chat Transcript)
- **参考截图**：`REF-016`, `REF-017`, `REF-021`
- **参考源码**：[`features/chat/transcript/ChatTranscript.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/chat/transcript/ChatTranscript.tsx), [`styles/messages.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/messages.css)
- **pi-GUI 现有代码**：`public/messages.js`, `public/runtime-conversation.css`
- **现有差异**：
  - pi-GUI 将助手回复包裹在灰色卡片气泡内，带生硬边框；PI-Desktop 则让助手文字作为无边框 Prose 直接渲染在画布上。
  - 用户气泡缺乏大圆角，未右对齐；
  - 缺乏消息悬停时浮现的操作栏（复制、重新编辑发送、删除、重新生成）。
- **重构方案**：
  1. 改造 `public/messages.js` 的渲染模板，移除 AI 回复气泡外框，改用纯净 Markdown 流。
  2. 用户气泡应用 `border-radius: var(--radius-lg-plus)` (18px)，底色设为 `--ds-tile`，靠右对齐。
  3. 为每条消息增加悬停浮动工具条，悬停时以 `--ds-bg-elevated-opaque` 浮现，提供复制、编辑重发与删除动作。
  4. 思考过程封装为折叠式弱对比度块 (`.thinking-block`)，支持动态呼吸圆点。

---

### 3.3 浮动输入框一体化改造 (Composer)
- **参考截图**：`REF-001`, `REF-015`, `REF-022`, `REF-024`
- **参考源码**：[`components/Composer.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/Composer.tsx), [`styles/composer.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/composer.css)
- **pi-GUI 现有代码**：`public/composer.js`, `public/ui3-composer.css`, `public/ui3-model-picker.js`, `public/ui3-model.css`, `public/ui/inline-command-menu.js`, `public/index.html` (`#chatComposer`)
- **现有差异**：
  - pi-GUI 现有 `ui3-composer` 已经具备浮动输入框容器与自适应伸缩能力，但部分阴影参数、圆角阶梯与按钮反转状态仍采用旧版 `--ui-*` 变量。
  - 模型选择器卡片与思考深度切换卡片已在 `ui3-model-picker.js` 中开发，需将其弹出层阴影由旧版投影切换为 `--ds-shadow-model-menu`。
- **重构方案**：
  1. 将 `#chatComposer .composer-box` 的圆角严格对齐为 `--ds-composer-radius` (`20px`)，阴影采用 `--ds-shadow-composer`。
  2. 发送按钮在浅色模式下应用 `--ds-accent` (`#1a1c1f`) 实心黑底白箭头，禁用态应用 `--ds-send-disabled-*`。
  3. 模型选择器弹窗完全复用 `ui3-model-picker.js` 逻辑，样式层消费 `--ds-*` 语义令牌。

---

### 3.4 许可证合规与净室实施边界 (LGPL-3.0 vs MIT)
- **合规隔离准则**：
  1. **禁止代码照搬**：严禁将 PI-Desktop 中的任何 `.tsx`、`.ts`、`.mjs`、`.css` 文件直接复制、改名或引入到 pi-GUI 仓库。
  2. **规范提取定义**：将提取的设计 Token（颜色、间距、圆角、字阶）与交互规范视为**事实性设计参数 (Functional Design Parameters)**，依据这些参数在 pi-GUI 中以原生 JavaScript 与原生 CSS 独立全新编写实现。
  3. **模块所有权声明**：pi-GUI 所有重构产物保持原有的 **MIT** 许可证，并在相应模块文件头标明基于设计规范自主实现，彻底杜绝版权传染风险。
