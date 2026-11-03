# 02. 截图与源码组件详细映射表 (Source Mapping)

> **修订说明 (Audit Revision)**：
> 1. 本文档已对所有组件引用进行深度穿透，剔除浅层包装/再导出入口（如 `App.tsx`、`pages/SettingsPage.tsx`、`components/ChatTranscript.tsx`），直接映射至实际承载业务逻辑与渲染的深层组件（如 `features/app/AppShell.tsx`、`features/settings/SettingsPage.tsx`、`features/chat/transcript/ChatTranscript.tsx`）。
> 2. 所有源码链接均已转换为固定 Commit 的 GitHub 永久链接（Commit SHA: `92ae661f1e399e69d514086b46029b4c34ba1a92`，版本 `v0.21.0`），保证第三方审计与后续开发 Agent 长期可用。
> 3. 证据等级严格划分为 **已验证 (Verified)**、**部分验证 (Partially Verified)** 与 **待验证 (Pending Verification)**，并在文首建立完整对照证据表。

---

## 1. 证据等级与映射全景表

| 截图编号 | 截图文件名 | 界面区域与功能 | 核心承载组件 (穿透后实际实现) | 证据等级 | 验证依据与未验证边界 |
|---|---|---|---|---|---|
| **REF-001** | `Snipaste_2026-10-31_23-10-09.png` | 聊天主界面初始空状态 (深色·边栏展开) | `features/app/AppShell.tsx`, `components/Sidebar.tsx`, `components/Composer.tsx` | **已验证** | DOM 层级、无边框外壳、吉祥物 GIF、引导清单、Composer 布局完全吻合 |
| **REF-002** | `Snipaste_2026-10-31_23-10-37.png` | 聊天主界面初始空状态 (深色·边栏折叠) | `features/app/chrome.tsx` (`CollapsedTitlebarActions`), `components/Composer.tsx` | **已验证** | 顶部独立展开按钮与全宽主视区过渡逻辑完全吻合 |
| **REF-003** | `Snipaste_2026-10-31_23-10-45.png` | 主界面 + 右侧工作区 (新建标签页状态) | `components/workpanel/WorkPanel.tsx`, `components/workpanel/WorkTabEmpty.tsx` | **已验证** | 三栏弹性布局、WorkTabEmpty 图标与操作入口完全吻合 |
| **REF-004** | `Snipaste_2026-10-31_23-11-36.png` | 设置中心 · 常规与外观偏好 | `features/settings/SettingsPage.tsx`, `components/settings/FontFamilyRow.tsx` | **已验证** | 分类侧栏 (`.settings-rail`)、SettingsCard、D601 行内帮助图标布局完全吻合 |
| **REF-005** | `Snipaste_2026-10-31_23-11-47.png` | 设置中心 · AI 偏好 | `features/settings/SettingsPage.tsx`, `components/ui.tsx` (`SegmentedControl`) | **已验证** | 运行模式三段式胶囊选择器、过程显示、无尽重试开关项完全吻合 |
| **REF-006** | `Snipaste_2026-10-31_23-11-56.png` | 设置中心 · 实时语音 | `features/settings/voice/VoiceSettingsSection.tsx`, `components/settings/JevSettingsCard.tsx` | **部分验证** | 视觉结构与各账号下拉框已验证；但底层 JEV 音频流与 OAuth 账号握手逻辑依赖未配置的外部凭据 |
| **REF-007** | `Snipaste_2026-10-31_23-12-09.png` | 设置中心 · 模型配置空状态 | `components/settings/ModelConfigPage.tsx` | **已验证** | 空状态双圆角服务器图标、引导文案、添加服务按钮及快照版本页脚完全吻合 |
| **REF-008** | `Snipaste_2026-10-31_23-12-23.png` | 设置中心 · 技能列表 | `components/settings/AgentSkillsPage.tsx`, `components/settings/AgentCapabilityLayout.tsx` | **已验证** | 范围过滤胶囊、搜索栏、内置/全局技能分组与开关项完全吻合 |
| **REF-009** | `Snipaste_2026-10-31_23-12-32.png` | 设置中心 · 技能市场 | `components/settings/SkillMarketPanel.tsx`, `components/ui.tsx` (`Badge`) | **已验证** | 双列卡片流、分类标签、已验证徽标与安装胶囊按钮完全吻合 |
| **REF-010** | `Snipaste_2026-10-31_23-12-40.png` | 设置中心 · MCP 服务器 | `components/settings/AgentMcpPage.tsx` | **部分验证** | 列表空状态卡片与工具栏已验证；但 stdio/SSE 服务器探测与动态心跳因无配置未在截图中触发 |
| **REF-011** | `Snipaste_2026-10-31_23-12-49.png` | 设置中心 · 子智能体 | `components/settings/AgentSubagentsPage.tsx`, `components/settings/SubagentEditorSheet.tsx` | **已验证** | 5 个内置子智能体列表、工具权限徽章及开关完全吻合 |
| **REF-012** | `Snipaste_2026-10-31_23-13-04.png` | 设置中心 · 开发者与调试信息 | `features/settings/SettingsPage.tsx` (About & Developer 分支) | **已验证** | 大字号产品名、版本与协议号、更新卡片、开发者模式切换完全吻合 |
| **REF-013** | `Snipaste_2026-10-31_23-56-39.png` | 模态弹窗 · 添加 AI 服务网格 | `components/settings/ProviderSetupDialog.tsx`, `components/settings/ServiceChooser.tsx` | **已验证** | 4 列供应商卡片网格、分类过滤、自定义端点入口完全吻合 (D625) |
| **REF-014** | `Snipaste_2026-10-31_23-57-32.png` | 模态弹窗 · 供应商配置与模型选择 | `components/settings/ProviderSetupDialog.tsx`, `components/settings/ModelSelectionPanes.tsx` | **部分验证** | 左右双栏结构、密钥输入、模型拖拽与启用开关已验证；但真实 API 探测测速分支需实时网络回应 |
| **REF-015** | `Snipaste_2026-10-31_23-57-55.png` | 输入框 · 模型选择器浮层 | `features/chat/composer/ComposerModelPicker.tsx`, `ComposerModelList.tsx`, `ThinkingLevelSlider.tsx` | **已验证** | 分组模型列表、上下文窗口大小胶囊、思考级别滑动条完全吻合 |
| **REF-016** | `Snipaste_2026-10-31_23-58-36.png` | 对话流式执行 · 思考折叠与指标 | `features/chat/transcript/AssistantTurn.tsx`, `ActivityGroup.tsx`, `TurnUsageCapsule.tsx` | **部分验证** | 折叠思考卡片、Token 速度胶囊 (`29 tokens/s`)、停止按钮已验证；流式追加底层增量渲染状态为动态行为 |
| **REF-017** | `Snipaste_2026-10-31_23-58-53.png` | 对话完成态 · 悬停操作浮条 | `components/TurnOutcomeCard.tsx`, `features/chat/transcript/AssistantTurn.tsx`, `UserTurn.tsx` | **已验证** | 运行完成状态行 (`3s`)、用户消息悬停工具栏 (复制/重发/编辑/删除) 完全吻合 |
| **REF-018** | `Snipaste_2026-10-31_23-59-20.png` | 工作台 · 浏览器标签页 | `components/workpanel/WorkPanel.tsx`, `components/workpanel/PluginViewTab.tsx` | **部分验证** | Tab 头、地址栏控件 (`URL`、刷新、外跳) 已验证；底层 Electron WebContents 隔离视图渲染依宿主环境而定 |
| **REF-019** | `Snipaste_2026-10-31_23-59-41.png` | 工作台 · 文件管理器标签页 | `components/workpanel/WorkPanel.tsx`, `components/workpanel/FilesTab.tsx` | **已验证** | 树形文件列表、文件大小统计、右侧全文搜索预览完全吻合 |
| **REF-020** | `Snipaste_2026-10-31_23-59-53.png` | 项目右键上下文菜单 | `components/ContextMenu.tsx`, `components/Sidebar.tsx`, `components/SidebarMenuPanel.tsx` | **已验证** | 浮动菜单视觉层级、操作项图标、分级子菜单 (`>`) 及危险标红完全吻合 |
| **REF-021** | `Snipaste_2026-11-01_00-00-22.png` | 浅色模式对话主视图 | `features/app/AppShell.tsx`, `components/SessionPane.tsx`, `styles/tokens.css` | **已验证** | `#f3f3f3` 浅灰边栏、纯白主背景、中性黑主文字、白底 Composer 投影微边完全吻合 |
| **REF-022** | `Snipaste_2026-11-01_10-41-57.png` | 浅色模式 · 斜杠命令补全浮层 | `components/ComposerAutocomplete.tsx`, `features/chat/composer/hooks/useComposerCompletions.ts` | **已验证** | 命令分组卡片、键盘高亮行、底部按键说明完全吻合 |
| **REF-023** | `Snipaste_2026-11-01_10-42-10.png` | 浅色模式 · 上下文检查器用量分析 | `components/ContextUsageInspector.tsx`, `features/chat/context-usage/useSessionTiming.ts` | **已验证** | Token 剩余环比、生成速度、网络/模型/工具三段式耗时瀑布完全吻合 |
| **REF-024** | `Snipaste_2026-11-01_10-42-22.png` | 浅色模式 · 文件提及补全浮层 | `components/ComposerAutocomplete.tsx`, `components/Composer.tsx` | **已验证** | `@` 触发文件树列表、路径相对引用胶囊、键盘导航完全吻合 |

**统计汇总**：
- **总截图数**：24 / 24
- **已验证 (Verified)**：19 / 24 (79.2%)
- **部分验证 (Partially Verified)**：5 / 24 (20.8%)
- **待验证 (Pending Verification)**：0 / 24 (0.0%)

---

## 2. 逐张截图深度映射清单

### REF-001: 聊天主界面初始空状态 (深色主题 · 侧边栏展开)
- **原始文件**：`Snipaste_2026-10-31_23-10-09.png`
- **主要区域与可见元素**：
  1. 顶部连续导航栏 (无底部分割线)：应用图标、项目/会话面包屑导航 (`pi-GUI / 新建任务`)、新建会话按钮 (`+`)、全局搜索按钮 (`Q`)、工作面板切换按钮 (`[|]`)、窗口最小化/最大化/关闭按钮。
  2. 左侧导航边栏 (Sidebar)：顶部品牌标 (`π PI-Desktop`) 与侧边栏折叠按钮；会话分组 (`会话` > `新建任务`)；项目树分组 (`项目` > `> 📁 pi-GUI •`)；底部状态工具条 (设置、插件、定时任务、通知中心、版本号 `v0.21.0`)。
  3. 中央主视区 (Empty Hero Stack)：居中 100px 招手吉祥物 (`HomeMascotLogo`)；主标题 `今天想在 pi-GUI 里做点什么？`；首日引导清单卡片 (`OnboardingChecklist`，包含 5 项任务及关闭按钮)。
  4. 底部浮动输入框 (Floating Composer)：圆角胶囊容器、占位文本 `随便问问`、底部工具栏 (附件 `+`、智能体模式胶囊、权限模式胶囊、模型选择器、禁用态向上箭头发送按钮)。
- **实际承载组件 (穿透后)**：
  - 应用外壳容器：[`features/app/AppShell.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/app/AppShell.tsx#L364-L393)
  - 侧边栏主体：[`components/Sidebar.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/Sidebar.tsx#L250-L500)
  - 顶部导航栏：[`components/ConversationTopbar.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ConversationTopbar.tsx#L40-L160)
  - 聊天主界面：[`components/ChatSurface.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ChatSurface.tsx#L60-L145)
  - 吉祥物动画：[`components/HomeMascotLogo.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/HomeMascotLogo.tsx#L10-L45)
  - 引导清单：[`components/OnboardingChecklist.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/OnboardingChecklist.tsx#L20-L95)
  - 输入框容器：[`components/Composer.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/Composer.tsx#L80-L260)
- **对应样式定义**：
  - 基础变量：[`styles/tokens.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/tokens.css#L20-L120)
  - 外壳布局：[`styles/chrome.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/chrome.css#L15-L95)
  - 主视区：[`styles/chat-shell.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/chat-shell.css#L30-L140)
  - 输入框：[`styles/composer.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/composer.css#L10-L85)
- **布局约束与关键尺寸**：
  - 侧边栏宽度：`var(--ds-sidebar-width)` (默认 275px，可拖拽 clamp: 240px ~ 520px)。
  - 顶部栏高度：`var(--ds-toolbar-height)` (46px)。
  - 主内容居中区最大宽度：`var(--chat-content-max-width, 760px)`。
  - 输入框圆角：`var(--ds-composer-radius, var(--radius-xl))` (20px)。
- **设计 Token 取值**：
  - 侧边栏背景：`--ds-bg-sidebar` (`#000000`)。
  - 主视区背景：`--ds-bg-primary` (`#181818`)。
  - 输入框背景：`--ds-bg-composer` (`color-mix(in oklab, var(--gray-800) 96%, transparent)`)。
  - 输入框阴影：`--ds-shadow-composer` (`0 3px 7.5px #0000000a, 0 0 20px #0000000d`)，无外描边 (D297)。
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-002: 聊天主界面初始空状态 (深色主题 · 侧边栏完全折叠)
- **原始文件**：`Snipaste_2026-10-31_23-10-37.png`
- **主要区域与可见元素**：
  与 REF-001 相同的主界面，但左侧边栏完全折叠至视口外，顶部左侧呈现独立的展开侧边栏图标按钮 (`IconSidebar`)。中央内容区自适应填满可用宽度。
- **实际承载组件 (穿透后)**：
  - 外壳容器：[`features/app/AppShell.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/app/AppShell.tsx#L364-L375) (`.sidebar-collapsed`)
  - 折叠态标题栏动作：[`features/app/chrome.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/app/chrome.tsx#L35-L74) (`CollapsedTitlebarActions`)
  - 输入框：[`components/Composer.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/Composer.tsx)
- **对应样式定义**：[`styles/chrome.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/chrome.css#L110-L160)
- **布局与过渡**：
  - 折叠时侧边栏宽度平滑过渡到 0，主聊天区自动弹性撑满。
  - 左上角保留 46px 拖拽安全带和 `IconSidebar` 展开触发器。
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-003: 主界面 + 右侧工作区 (深色主题 · 新建标签页状态)
- **原始文件**：`Snipaste_2026-10-31_23-10-45.png`
- **主要区域与可见元素**：
  1. 界面分为三栏结构：左侧边栏 (折叠)、中间聊天视区、右侧停靠工作区 (`WorkPanel`)。
  2. 工作区顶部 Tab 栏：新建标签页激活，带 `+` 新建按钮、最大化按钮、折叠按钮。
  3. 工作区空内容卡片 (`WorkTabEmpty`)：居中图标、标题 `新建工作区标签`，下方列表入口 (`审阅`、`浏览器`、`文件管理器`)。
- **实际承载组件 (穿透后)**：
  - 工作区容器：[`components/workpanel/WorkPanel.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/workpanel/WorkPanel.tsx#L40-L200)
  - 新标签引导卡：[`components/workpanel/WorkTabEmpty.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/workpanel/WorkTabEmpty.tsx#L10-L31)
- **对应样式定义**：[`styles/work-panel.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/work-panel.css#L10-L120)
- **布局约束与关键尺寸**：
  - 工作区分栏默认宽度：`clamp(344px, 35vw, 680px)`，带可拖拽 Splitter 调整。
  - 聊天主视区保留最小宽度：`MAIN_PANE_MIN_WIDTH = 450px`。
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-004: 设置中心 · 常规与外观偏好 (深色主题)
- **原始文件**：`Snipaste_2026-10-31_23-11-36.png`
- **主要区域与可见元素**：
  1. 全屏设置页面接管 (`settings-mode`)。
  2. 左侧设置分类导航栏 (`.settings-rail`)：搜索框、偏好分组 (`常规` 选中、`AI`、`快捷键`、`指令`)、智能体分组、工作区分组、系统分组、底部 `← 返回应用`。
  3. 右侧设置内容区：
     - 分组 1 `外观与窗口`：`主题` 下拉框、`字体` 下拉框、`字号` 滑块 (带百分比读数)、`语言` 下拉框。
     - 分组 2 `侧边栏`：4 项开关 (`始终展开项目`、`隐藏归档会话` 等)。
- **实际承载组件 (穿透后)**：
  - 设置主页实现：[`features/settings/SettingsPage.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/settings/SettingsPage.tsx#L450-L545)
  - 设置基础原语：[`features/settings/primitives.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/settings/primitives.tsx#L20-L80) (`SettingsCard`, `SettingsRow`)
  - 字体配置行：[`components/settings/FontFamilyRow.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/FontFamilyRow.tsx)
  - 字号配置行：[`components/settings/FontSizeRow.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/FontSizeRow.tsx)
- **对应样式定义**：[`styles/settings.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/settings.css#L10-L150)
- **设计规范与 D601 规则**：
  - 遵循 D601 规范：标题与控件同行，解释说明文案收纳于标题旁边的 `HelpIcon` 问号气泡内，严禁占用常驻第二行。
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-005: 设置中心 · AI 偏好 (深色主题)
- **原始文件**：`Snipaste_2026-10-31_23-11-47.png`
- **主要区域与可见元素**：
  1. 权限模式下拉菜单 (`每次询问 v`)。
  2. 默认模式三段式分段器 (`智能体` 选中、`规划`、`目标`)。
  3. `命令 Shell` 下拉菜单 (`Windows PowerShell v`)。
  4. `链接打开位置` 分段器 (`工作区浏览器` 选中、`系统默认浏览器`)。
  5. 思考与过程显示开关、上下文用量读数分段器 (`剩余` 选中、`已用`)、回车发送开关、无尽重试开关。
- **实际承载组件 (穿透后)**：
  - 设置主页分支：[`features/settings/SettingsPage.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/settings/SettingsPage.tsx#L550-L640)
  - 分段选择器：[`components/ui.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ui.tsx#L687-L740) (`SegmentedControl`)
  - 帮助气泡：[`components/ui.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ui.tsx#L507-L525) (`HelpIcon`)
- **对应样式定义**：[`styles/settings.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/settings.css#L250-L380)
- **设计 Token**：
  - 分段选择器槽底色：`var(--ds-tile-hover)`，选中胶囊：`var(--ds-raised)` + `var(--ds-raised-shadow)`。
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-006: 设置中心 · 实时语音 (深色主题)
- **原始文件**：`Snipaste_2026-10-31_23-11-56.png`
- **主要区域与可见元素**：
  1. 页面标题 `实时语音`，右侧带跳转链接 `模型配置`。
  2. 启用实时语音总开关 (当前 OFF)。
  3. 各供应商账号绑定下拉：`Codex 账号`、`Gemini Live`、`OpenAI Realtime`。
  4. 辅助引导文案：`尚未配置兼容账号，请前往模型配置添加服务或登录。`
- **实际承载组件 (穿透后)**：
  - 语音设置区块：[`features/settings/voice/VoiceSettingsSection.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/settings/voice/VoiceSettingsSection.tsx)
  - 语音设置卡片：[`components/settings/JevSettingsCard.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/JevSettingsCard.tsx)
- **对应样式定义**：[`styles/voice.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/voice.css), [`styles/settings.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/settings.css)
- **证据与置信度**：**部分验证 (Partially Verified)**。视觉结构与下拉选项已由源码证实，但因未配置兼容账号，实时语音通信通道（PCM AudioWorklet）与 OAuth 登录分支未在界面中激活。

---

### REF-007: 设置中心 · 模型配置空状态 (深色主题)
- **原始文件**：`Snipaste_2026-10-31_23-12-09.png`
- **主要区域与可见元素**：
  1. 标题 `模型配置`，副操作 `从其他工具导入`、`+ 添加服务` 主按钮 (白底黑字)。
  2. 中央大卡片：空状态双圆角服务器图标、标题 `还没有 AI 服务`、说明文案及居中 `+ 添加服务` 按钮。
  3. 底部状态栏：`目录：内置快照 · 8893 个模型 · 更新于：从未获取`，右侧 `更新模型目录` 按钮。
- **实际承载组件 (穿透后)**：
  - 模型配置主页：[`components/settings/ModelConfigPage.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/ModelConfigPage.tsx#L35-L160)
- **对应样式定义**：[`styles/model-config.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/model-config.css), [`styles/providers.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/providers.css)
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-008: 设置中心 · 技能列表 (深色主题)
- **原始文件**：`Snipaste_2026-10-31_23-12-23.png`
- **主要区域与可见元素**：
  1. 顶部工具栏：范围过滤胶囊 (`全部 5`、`全局 2`、`项目 0`)、搜索框 `Q 搜索技能`、工作区下拉、`扫描`、`+ 新建`、`市场` 按钮。
  2. 内置技能分组 (`内置 3`)：3 项系统技能与独立开关。
  3. 全局技能分组 (`全局 · ~/.agents/skills 2`)：带导入文件/目录按钮。
- **实际承载组件 (穿透后)**：
  - 技能主页：[`components/settings/AgentSkillsPage.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/AgentSkillsPage.tsx#L25-L160)
  - 技能通用布局：[`components/settings/AgentCapabilityLayout.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/AgentCapabilityLayout.tsx)
- **对应样式定义**：[`styles/settings.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/settings.css), [`styles/ui-kit.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/ui-kit.css)
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-009: 设置中心 · 技能市场 (深色主题)
- **原始文件**：`Snipaste_2026-10-31_23-12-32.png`
- **主要区域与可见元素**：
  1. `← 返回我的技能` 返回按钮。
  2. 市场搜索栏、分类过滤标签 (`全部`、`工作流`、`写作`、`编程`、`数据`、`文档`)。
  3. 双列技能卡片网格：图标、标题、`已验证` 成功徽标、作者、`安装` 白底黑字胶囊按钮、两行摘要文本。
- **实际承载组件 (穿透后)**：
  - 技能市场面板：[`components/settings/SkillMarketPanel.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/SkillMarketPanel.tsx#L30-L240)
  - 徽章原语：[`components/ui.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ui.tsx#L829-L855) (`Badge`)
- **对应样式定义**：[`styles/plugins.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/plugins.css#L180-L320)
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-010: 设置中心 · MCP 服务器 (深色主题)
- **原始文件**：`Snipaste_2026-10-31_23-12-40.png`
- **主要区域与可见元素**：
  1. 顶部工具栏：过滤胶囊、搜索框、工作区选择器、`从其他工具扫描`、`+ 新增`、`市场` 按钮。
  2. 全局与项目级空卡片：服务器图标、说明 `此目录中没有 MCP 服务器`、`+ 新增` 按钮。
- **实际承载组件 (穿透后)**：
  - MCP 设置主页：[`components/settings/AgentMcpPage.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/AgentMcpPage.tsx#L20-L180)
- **对应样式定义**：[`styles/settings.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/settings.css)
- **证据与置信度**：**部分验证 (Partially Verified)**。空状态结构与工具栏已验证；但活跃 stdio 子进程管道探测与 OAuth 授权回调属于动态后台状态。

---

### REF-011: 设置中心 · 子智能体 (深色主题)
- **原始文件**：`Snipaste_2026-10-31_23-12-49.png`
- **主要区域与可见元素**：
  1. 标题 `子智能体`，搜索框与 `+ 新建子智能体` 主按钮。
  2. 5 个内置子智能体列表 (`探索者`、`代码审查员`、`测试执行者`、`修复者`、`UI 设计师`)，展示各自授权工具胶囊 (`Read`, `Glob`, `Grep`, `Bash`, `Edit`, `Write`) 与开关。
- **实际承载组件 (穿透后)**：
  - 子智能体主页：[`components/settings/AgentSubagentsPage.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/AgentSubagentsPage.tsx#L30-L210)
- **对应样式定义**：[`styles/settings.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/settings.css), [`styles/ui-kit.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/ui-kit.css)
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-012: 设置中心 · 开发者与调试信息 (深色主题)
- **原始文件**：`Snipaste_2026-10-31_23-13-04.png`
- **主要区域与可见元素**：
  1. 大号标题 `PI-Desktop`、版本号 `版本 0.21.0`、协议号 `protocol 11 · host 0.21.0`。
  2. 软件更新卡片：下载图标、`已是最新版本。` (绿色字体)、`发版日志` 按钮、`检查更新` 主按钮。
  3. 日志与反馈卡片：`打开日志`、`打开 GitHub` 按钮。
  4. 开发者选项：`开发者模式` 开关、`打开控制台` 按钮。
- **实际承载组件 (穿透后)**：
  - 关于与版本展示：[`features/settings/SettingsPage.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/settings/SettingsPage.tsx#L660-L710)
  - 开发者设置原语：[`features/settings/developer-sections.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/settings/developer-sections.tsx#L10-L60)
- **对应样式定义**：[`styles/settings.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/settings.css)
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-013: 模态弹窗 · 添加 AI 服务 (选择供应商网格)
- **原始文件**：`Snipaste_2026-10-31_23-56-39.png`
- **主要区域与可见元素**：
  1. 全局半透明遮罩背景 (`--ds-modal-veil`)。
  2. 居中模态卡片，标题 `添加 AI 服务`，副标题 `支持官方服务与自定义兼容端点。`。
  3. 4 列供应商卡片网格：
     - `自定义兼容服务` (首位推荐卡片)。
     - 官方供应商：OpenAI, Anthropic, Google Gemini, DeepSeek, Ollama, OpenRouter, Groq, Mistral, Moonshot, SiliconFlow, Zhipu, MiniMax 等，各带品牌字母缩写头像。
- **实际承载组件 (穿透后)**：
  - 服务配置弹窗：[`components/settings/ProviderSetupDialog.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/ProviderSetupDialog.tsx#L30-L100)
  - 供应商选择网格：[`components/settings/ServiceChooser.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/ServiceChooser.tsx#L40-L220)
- **对应样式定义**：[`styles/providers.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/providers.css), [`styles/overlays.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/overlays.css)
- **设计规则 (D625)**：
  - 采用 D625 规范：将自定义端点置于首位平铺，所有 API 供应商与订阅选项作为卡片直观呈现，免除深层二级菜单嵌套。
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-014: 模态弹窗 · 供应商设置步骤 (以 DeepSeek 为例)
- **原始文件**：`Snipaste_2026-10-31_23-57-32.png`
- **主要区域与可见元素**：
  1. 弹窗头部：`DeepSeek` 品牌图标与名称，右侧 `取消` / `添加服务` 按钮。
  2. 左栏连接配置：`API 密钥` 密文输入框、端点地址输入框。
  3. 右栏模型管理：可选模型列表、已启用模型卡片、`deepseek-chat` / `deepseek-reasoner`、推荐默认标记与排序把手。
- **实际承载组件 (穿透后)**：
  - 弹窗外壳：[`components/settings/ProviderSetupDialog.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/ProviderSetupDialog.tsx#L120-L380)
  - 连接字段表单：[`components/settings/ProviderConnectionFields.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/ProviderConnectionFields.tsx)
  - 左右双栏模型管理：[`components/settings/ModelSelectionPanes.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/ModelSelectionPanes.tsx)
- **对应样式定义**：[`styles/providers.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/providers.css)
- **证据与置信度**：**部分验证 (Partially Verified)**。双栏布局与模型列表已验证；但在线拉取远程模型列表与延迟测试反馈需要网络连通。

---

### REF-015: 底部输入框 · 模型选择器浮层 (Popover)
- **原始文件**：`Snipaste_2026-10-31_23-57-55.png`
- **主要区域与可见元素**：
  1. 点击 Composer 工具栏模型胶囊向上弹出的模型列表浮层。
  2. 模型列表项：供应商图标、模型名 (`gpt-5`、`claude-3-7-sonnet` 等)、上下文容量胶囊 (`1.05M`)、激活勾选标记。
  3. 底部思考程度 (Reasoning Effort) 滑动刻度：`omit` / `off` / `low` / `medium` / `high` / `max`。
- **实际承载组件 (穿透后)**：
  - 选择器浮层：[`features/chat/composer/ComposerModelPicker.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/chat/composer/ComposerModelPicker.tsx#L35-L120)
  - 模型列表组件：[`features/chat/composer/ComposerModelList.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/chat/composer/ComposerModelList.tsx)
  - 思考程度滑块：[`features/chat/composer/ThinkingLevelSlider.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/chat/composer/ThinkingLevelSlider.tsx)
- **对应样式定义**：[`styles/composer-menus.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/composer-menus.css), [`styles/composer.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/composer.css)
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-016: 会话执行态 · 流式输出与思考折叠 (深色主题)
- **原始文件**：`Snipaste_2026-10-31_23-58-36.png`
- **主要区域与可见元素**：
  1. 用户提问气泡：右侧对齐圆角胶囊容器。
  2. AI 助手流式回复：直接呈现在主视区背景上，无对话气泡边框。
  3. 折叠式思考过程指示器：`? 思考中 · 8s`，左侧呼吸动画圆点。
  4. 底部状态指示器：Token 吞吐速度 (`29 tokens/s`)、停止生成按钮 (`■`)。
- **实际承载组件 (穿透后)**：
  - 对话流容器：[`features/chat/transcript/ChatTranscript.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/chat/transcript/ChatTranscript.tsx#L450-L575)
  - 助手轮次：[`features/chat/transcript/AssistantTurn.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/chat/transcript/AssistantTurn.tsx)
  - 思考与执行指示器：[`features/chat/transcript/ActivityGroup.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/chat/transcript/ActivityGroup.tsx)
  - 指标胶囊：[`features/chat/transcript/TurnUsageCapsule.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/chat/transcript/TurnUsageCapsule.tsx)
- **对应样式定义**：[`styles/chat-shell.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/chat-shell.css), [`styles/messages.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/messages.css)
- **证据与置信度**：**部分验证 (Partially Verified)**。静态样式与呼吸圆点动画已核验；但动态流式 Token 追加入 DOM 的渲染批处理属于动态运行时。

---

### REF-017: 对话执行完成态与消息悬停操作 (深色主题)
- **原始文件**：`Snipaste_2026-10-31_23-58-53.png`
- **主要区域与可见元素**：
  1. 状态行：`✓ 运行完成 · 3s`。
  2. 结构化 Markdown 渲染：段落、粗体标题、行内代码块。
  3. 用户消息悬停浮动工具条：时间戳 (`23:58:31`)、复制图标、编辑并重发图标、删除图标。
  4. 底部滚动定位锚点按钮 (`↓`)。
- **实际承载组件 (穿透后)**：
  - 完成结果卡片：[`components/TurnOutcomeCard.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/TurnOutcomeCard.tsx)
  - 消息轮次操作：[`features/chat/transcript/TranscriptMenu.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/chat/transcript/TranscriptMenu.tsx)
  - Markdown 渲染器：[`components/Markdown.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/Markdown.tsx)
- **对应样式定义**：[`styles/messages.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/messages.css)
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-018: 工作区工作台 · 浏览器标签页 (深色主题)
- **原始文件**：`Snipaste_2026-10-31_23-59-20.png`
- **主要区域与可见元素**：
  1. 工作台 Tab 头：`[浏览器] x`，新建 `+`，最大化/折叠按钮。
  2. 浏览器内部导航条：后退、前进、刷新按钮、只读 URL 地址输入框 (`http://localhost:3000`)、外部系统浏览器打开按钮。
  3. 网页预览视口区域。
- **实际承载组件 (穿透后)**：
  - 工作台容器：[`components/workpanel/WorkPanel.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/workpanel/WorkPanel.tsx)
  - 浏览器视图面板：[`components/workpanel/PluginViewTab.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/workpanel/PluginViewTab.tsx#L25-L120)
- **对应样式定义**：[`styles/work-panel.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/work-panel.css#L140-L260)
- **证据与置信度**：**部分验证 (Partially Verified)**。工作面板外壳与地址栏已验证；但底层与 Electron Webview 进程安全沙箱通信依运行环境而定。

---

### REF-019: 工作区工作台 · 文件管理器标签页 (深色主题)
- **原始文件**：`Snipaste_2026-10-31_23-59-41.png`
- **主要区域与可见元素**：
  1. Tab 头：`[文件管理器] x`。
  2. 文件树左子栏：搜索框、树形目录、文件大小。
  3. 右子栏全局搜索预览区：标题 `项目文件`、提示文案。
- **实际承载组件 (穿透后)**：
  - 文件管理器标签页：[`components/workpanel/FilesTab.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/workpanel/FilesTab.tsx#L35-L210)
- **对应样式定义**：[`styles/work-panel.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/work-panel.css)
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-020: 项目右键菜单与消息底部操作栏 (深色主题)
- **原始文件**：`Snipaste_2026-10-31_23-59-53.png`
- **主要区域与可见元素**：
  1. 侧边栏项目行右键弹出的上下文菜单 (`ContextMenu`)：打开文件夹、编辑项目、置顶项目、归档项目、复制二级菜单、Git 二级菜单、危险操作二级菜单。
  2. 消息底部常驻操作条：时间戳、复制、创建分叉分支、重新生成回复。
- **实际承载组件 (穿透后)**：
  - 浮动上下文菜单：[`components/ContextMenu.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ContextMenu.tsx#L25-L140)
  - 侧边栏集成：[`components/SidebarMenuPanel.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/SidebarMenuPanel.tsx)
- **对应样式定义**：[`styles/ui-kit.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/ui-kit.css#L260-L340)
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-021: 浅色模式对话主视图 (Light Theme Baseline)
- **原始文件**：`Snipaste_2026-11-01_00-00-22.png`
- **主要区域与可见元素**：
  1. 浅色模式侧边栏：柔和浅灰色底色 (`#f3f3f3`)，高对比度文字 (`#1a1c1f`)。
  2. 浅色模式主视区：纯白背景 (`#ffffff`)。
  3. 浅色模式 Composer：纯白浮动卡片 (`#ffffff`)，极轻柔双层弥散阴影，0.5px 发丝微边框，黑色实心发送按钮。
  4. 模型指示胶囊：浅灰底色胶囊 (`#f3f3f3`)。
- **实际承载组件 (穿透后)**：
  - 应用外壳：[`features/app/AppShell.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/app/AppShell.tsx) (`[data-theme="light"]`)
  - 会话视区：[`components/SessionPane.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/SessionPane.tsx)
  - 输入框：[`components/Composer.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/Composer.tsx)
- **对应样式定义**：
  - 浅色 Tokens：[`styles/tokens.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/tokens.css#L180-L260) (`:root[data-theme="light"]`)
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-022: 浅色模式 · 斜杠命令补全浮动菜单 (Slash Autocomplete)
- **原始文件**：`Snipaste_2026-11-01_10-41-57.png`
- **主要区域与可见元素**：
  1. Composer 中输入 `/` 触发向上弹出的命令补全浮层。
  2. `应用命令` 分组：`/new`, `/compact`, `/goal-mode`, `/plan-mode`, `/agent-mode`。
  3. `技能` 分组：`/skill:...`。
  4. 底部快捷键提示：`↑↓ 选择 · Enter 确认 · Esc 关闭`。
- **实际承载组件 (穿透后)**：
  - 补全浮层：[`components/ComposerAutocomplete.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ComposerAutocomplete.tsx#L35-L150)
  - 补全逻辑钩子：[`features/chat/composer/hooks/useComposerCompletions.ts`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/chat/composer/hooks/useComposerCompletions.ts)
- **对应样式定义**：[`styles/composer-autocomplete.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/composer-autocomplete.css#L10-L90)
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-023: 浅色模式 · 上下文检查器用量分析 (Context Inspector)
- **原始文件**：`Snipaste_2026-11-01_10-42-10.png`
- **主要区域与可见元素**：
  1. 点击 Composer 右侧环形指示器 (`O 99%`) 弹出的性能分析卡片。
  2. 头部：大字号 `剩余 1.04M tokens`，右侧 `99%`。
  3. 耗时瀑布流：`网络请求耗时 (0s · 1%)`、`模型响应耗时 (3s · 3%)`、`工具调用耗时 (0s · 0%)`。
  4. 底部用量分析：输入、输出、推理 Token 拆解。
- **实际承载组件 (穿透后)**：
  - 检查器卡片：[`components/ContextUsageInspector.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ContextUsageInspector.tsx#L40-L240)
  - 耗时统计算法：[`features/chat/context-usage/useSessionTiming.ts`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/features/chat/context-usage/useSessionTiming.ts)
- **对应样式定义**：[`styles/composer.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/composer.css#L540-L620)
- **证据与置信度**：**已验证 (Verified)**。

---

### REF-024: 浅色模式 · 文件目录路径提及补全 (@-Mention Autocomplete)
- **原始文件**：`Snipaste_2026-11-01_10-42-22.png`
- **主要区域与可见元素**：
  1. 输入框中键入 `@` 触发工作区文件路径检索补全卡片。
  2. 列表项：`📁 repos/ repos`、`📁 meeting-copilot/` 等，带文件/文件夹图标。
  3. 底部快捷键提示：`↑↓ 选择 · Enter 确认 · Esc 关闭`。
- **实际承载组件 (穿透后)**：
  - 自动补全组件：[`components/ComposerAutocomplete.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ComposerAutocomplete.tsx#L160-L220) (`item.kind === 'path'`)
  - 输入框交互：[`components/Composer.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/Composer.tsx)
- **对应样式定义**：[`styles/composer-autocomplete.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/composer-autocomplete.css)
- **证据与置信度**：**已验证 (Verified)**。
