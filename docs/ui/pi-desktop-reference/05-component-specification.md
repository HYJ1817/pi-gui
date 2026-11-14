# 05. 公共组件体系规范 (Component Specification)

> 本文用于复核 PI-Desktop 参考与当时的改造阶段。当前开发与验收见 [pi-GUI 全局 UI/UX 设计规范](../design-system.md)。

## 1. 概述

本规范基于 PI-Desktop 官方前端组件库（`apps/desktop/src/components/ui.tsx`、`apps/desktop/src/components/*` 及 `styles/ui-kit.css`）制定。明确定义各个可复用 UI 基础构件的视觉规格、交互状态、按键焦点行为及在 pi-GUI 中的实现策略。

---

## 2. 基础原子组件规范 (Base UI Primitives)

### 2.1 按钮 (Button)
- **源码文件**：[`components/ui.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ui.tsx#L528-L554)
- **样式文件**：[`styles/ui-kit.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/ui-kit.css#L140-L190) (`.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`)
- **使用场景**：主操作提交、模态确认、保存服务、技能安装、导入扫描。
- **视觉规格**：
  - 高度：`32px` 标准高度；内边距：`7px 12px`；
  - 圆角：`var(--radius-sm)` (10px)；
  - 字体：`var(--text-md)` (13px)，字重 `500`（次级）/ `600`（主要）；
- **变体与色彩**：
  - **Primary (`.btn-primary`)**：
    - 暗色：背景 `--ds-accent` (`#ffffff`)，文本 `--ds-bg-primary` (`#181818`)；悬停背景 `#ededed`；
    - 浅色：背景 `--ds-accent` (`#1a1c1f`)，文本 `#ffffff`；悬停背景 `#303030`；
  - **Secondary (`.btn-secondary`)**：
    - 背景：`--ds-tile-hover`，文本 `--ds-text-primary`；悬停背景 `--ds-tile-deep`；无边框；
  - **Ghost (`.btn-ghost`)**：
    - 背景：透明；文本 `--ds-text-secondary`；悬停背景 `--ds-bg-hover`，文本变亮；
  - **Danger (`.btn-danger`)**：
    - 背景：`color-mix(in oklab, var(--ds-error) 14%, transparent)`，文字 `--ds-error`；
- **状态与交互**：
  - 激活按压：`transform: scale(0.98)`；
  - 禁用态：`opacity: 0.45; cursor: not-allowed; transform: none;`；
- **键盘行为**：支持 `Tab` 键聚焦，聚焦显示焦点环 `0 0 0 2px var(--ds-focus)`，按 `Enter` / `Space` 触发。

---

### 2.2 图标按钮 (Icon Button)
- **源码文件**：[`components/ui.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ui.tsx#L427-L460) (`TooltipButton`), [`components/Composer.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/Composer.tsx)
- **样式文件**：[`styles/ui-kit.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/ui-kit.css#L190-L210), [`styles/composer.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/composer.css#L420-L450) (`.icon-btn`, `.icon-btn-square`)
- **使用场景**：标题栏功能按钮、底部输入框附件按钮、侧边栏底部工具图标、消息悬停操作。
- **视觉规格**：
  - 纯方块图标按钮 (`.icon-btn-square`)：尺寸固定为 **`28px × 28px`** (`var(--ds-control-size)`)，`flex: 0 0 28px`；
  - 带文本的胶囊图标按钮：高度 28px，内边距 `0 8px`，圆角 `var(--radius-full)`；
  - 内部图标尺寸：`14px` ~ `16px`，居中对齐；
- **交互状态**：
  - 默认：背景透明，颜色 `--ds-text-secondary`；
  - 悬停：背景 `--ds-bg-hover`，颜色 `--ds-text-primary`；
  - 激活/按下：背景 `--ds-bg-active`，按压轻微缩放 `scale(0.96)`；
  - 选中标记 (`aria-pressed="true"` 或 `.active`)：保持 `--ds-bg-active` 底色；
- **pi-GUI 适配建议**：原生替换 pi-GUI 中不规则尺寸的小图标按钮，统一锁定为 28×28px 规范。

---

### 2.3 输入框与密文输入框 (Input & PasswordInput)
- **源码文件**：[`components/ui.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ui.tsx#L556-L608)
- **样式文件**：[`styles/ui-kit.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/ui-kit.css#L55-L100) (`.field-input`, `.password-input`, `.password-input-toggle`)
- **使用场景**：全局设置搜索、API Key 录入、模型 ID 自定义添加、文件重命名。
- **视觉规格**：
  - 统一最小高度：`--ds-field-height` (`calc(18px + var(--text-base) * var(--leading-body))`)，约 38px；
  - 边框：`border: 0;`（去线条化设计，杜绝静态灰色描边）；
  - 背景：`background: var(--ds-tile-hover)`；
  - 圆角：`var(--radius-sm)` (10px)；
  - 内边距：`9px 11px`；
- **聚焦状态 (Focus State)**：
  - 背景自动抬升为凸起色：`background: var(--ds-raised)`；
  - 聚焦光晕外环：`box-shadow: 0 0 0 2px color-mix(in oklab, var(--ds-accent) 22%, transparent)`；
  - 无刺眼的默认蓝色外框；
- **密文带眼睛切换 (`PasswordInput`)**：
  - 右侧预留 34px 内边距；
  - 眼睛图标按钮绝对定位在输入框右侧（28×28px），点击切换明文/密文，保持焦点不丢失。

---

### 2.4 多行输入框 (Textarea & Composer Textarea)
- **源码文件**：[`components/ui.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ui.tsx#L610-L620), [`components/Composer.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/Composer.tsx#L180-L240)
- **样式文件**：[`styles/composer.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/composer.css#L305-L330) (`.composer-input`)
- **使用场景**：底部核心提示词输入框、指令编辑、系统提示词配置。
- **视觉与伸缩机制**：
  - 初始最小高度：`min-height: 3lh` (约 44px)；
  - 最大高度：`max-height: 7lh` (约 150px)；
  - 超出后行为：`overflow-y: hidden` 切换为自动内部垂直滚动；
  - 自动高度计算：监听 `input` 事件，通过隐藏 mirror 计算或设置 `style.height = 'auto'` 然后赋给 `scrollHeight`；
  - 边框与轮廓：`border: 0; outline: none; background: transparent;`，与浮动卡片融为一体；
  - 换行与断词：`white-space: pre-wrap; overflow-wrap: break-word;`。

---

### 2.5 下拉选择框与锚定菜单 (Select & SettingsMenuSelect)
- **源码文件**：[`components/ui.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ui.tsx#L622-L625), [`components/settings/SettingsMenuSelect.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/SettingsMenuSelect.tsx)
- **样式文件**：[`styles/ui-kit.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/ui-kit.css), [`styles/settings.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/settings.css)
- **使用场景**：设置项选项选择（主题选择、语言选择、Shell 切换、权限模式）。
- **视觉规格**：
  - 外观表现为带右侧 Chevron 下拉小箭头的胶囊卡片；
  - 高度与 Input 保持严格一致（`--ds-field-height`）；
  - 背景：`var(--ds-tile-hover)`，圆角 `var(--radius-sm)`；
  - 展开菜单：通过 Portaled 浮动菜单展示，浮层具备 1px 微发丝边线与 `--ds-shadow-dialog` 深度投影；
- **无障碍与按键**：支持键盘光标 `↑` / `↓` 移动，`Enter` 选中，`Esc` 退出。

---

### 2.6 开关 (SettingsToggle)
- **源码文件**：[`components/ui.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ui.tsx#L656-L685)
- **样式文件**：[`styles/ui-kit.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/ui-kit.css), [`styles/tokens.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/tokens.css#L70-L80)
- **使用场景**：设置项开闭（显示思考、侧边栏流光、回车发送、无尽重试、开发者模式）。
- **视觉规格与关键参数**：
  - 轨道宽度：`38px`；高度：`22px`；圆角：`var(--radius-full)`；
  - 内部滑钮直径：`18px` 纯圆；位移：`2px` (关闭) 至 `18px` (开启)；
- **状态色彩细节 (解决反差缺陷)**：
  - **关闭态 (OFF)**：
    - 轨道：`--ds-switch-track-off` (浅暗灰弱填充) + 1px 细环 `--ds-switch-ring-off`，确保空槽依然清晰可见；
    - 滑钮：暗色下为中灰 `--ds-switch-knob-off` (`#afafaf`)，不隐入轨道；浅色下为纯白；
  - **开启态 (ON)**：
    - 轨道：反转为实心高亮 `--ds-accent`（暗色为纯白 `#ffffff`，浅色为深墨黑 `#1a1c1f`）；
    - 滑钮：反色滑钮 `--ds-switch-knob-on`（暗色为深底色 `#181818`，浅色为纯白 `#ffffff`）；
  - **过渡动画**：滑钮位移与轨道色彩过渡为 `150ms var(--motion-ease-out)`。

---

### 2.7 分段选择器 (SegmentedControl)
- **源码文件**：[`components/ui.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ui.tsx#L687-L740)
- **样式文件**：[`styles/ui-kit.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/ui-kit.css)
- **使用场景**：AI 默认模式（智能体/规划/目标）、过程显示模式、用量读数方式、链接打开位置。
- **视觉规格**：
  - 整体外槽：高度 32px，背景 `var(--ds-tile-hover)`，内边距 2px，圆角 `var(--radius-sm)`；
  - 单个选项胶囊：圆角 `calc(var(--radius-sm) - 2px)` (8px)，内边距 `4px 10px`，字号 `12.5px`；
  - 激活项：背景为 `--ds-raised`（带微明度抬升），叠加 `--ds-raised-shadow`（`0 1px 2px rgba(0,0,0,0.2)`），字重 `500`；
  - 未激活项：文本弱化为 `--ds-text-secondary`，悬停微变浅。

---

### 2.8 徽章与标签 (Badge)
- **源码文件**：[`components/ui.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ui.tsx#L829-L855)
- **样式文件**：[`styles/ui-kit.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/ui-kit.css#L210-L240)
- **使用场景**：内置技能标识、实验性功能提示、工具权限列表、数量计数。
- **色彩变体**：
  - **中性徽章 (`.badge-neutral`)**：背景 `color-mix(in oklab, var(--ds-text-primary) 8%, transparent)`，文字 `--ds-text-secondary`；
  - **成功徽章 (`.badge-success`)**：背景 16% 绿色弱遮罩，文字 `--ds-success`；
  - **警告/实验性徽章 (`.badge-warning`)**：背景 16% 橙色弱遮罩，文字 `--ds-warning`（如设置中 `实验性` 橙色胶囊）；
  - **错误徽章 (`.badge-error`)**：背景 16% 红色弱遮罩，文字 `--ds-error`。

---

### 2.9 工具提示与帮助说明 (Tooltip & HelpIcon)
- **源码文件**：[`components/ui.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ui.tsx#L365-L525)
- **样式文件**：[`styles/ui-kit.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/ui-kit.css#L10-L54)
- **设计与交互策略 (D601 单槽互斥机制)**：
  - 全局同一时刻**只允许显示一个活动 Tooltip**（通过 `visibleTooltip` 单例槽锁控），杜绝鼠标在相邻按钮滑动时出现多个残影叠加；
  - **帮助问号图标 (`.ui-help-icon`)**：为独立的透明按钮，点击或悬停显示左对齐的详细说明气泡，将长篇大论的辅助说明移出主布局。

---

## 3. 业务复合构件规范 (Composite Components)

### 3.1 设置组卡片与行 (Settings Group & Settings Row)
- **对应截图**：`REF-004`, `REF-005`, `REF-006`
- **样式类**：`.settings-card-block`, `.settings-card-heading`, `.panel-card`, `.settings-row`
- **布局规范**：
  - 组标题：`font-size: 13.5px; font-weight: 560; margin-bottom: 10px;`；
  - 卡片容器：圆角 `16px` (`var(--radius-lg)`)，背景 `var(--ds-tile)`，内边距 `0`；
  - 组内每一行 (`.settings-row`)：
    - `display: flex; align-items: center; justify-content: space-between;`
    - 内边距：`12px 16px`；
    - 行间**不绘制 1px 分割线**，利用柔和背景与间距维持整齐；
    - 左侧区域：主标题 (`--ds-text-primary`) 与可选的 `HelpIcon`，下方可选次级说明；
    - 右侧区域：表单控件（Select、Toggle、SegmentedControl、Slider）。

---

### 3.2 模型选择器与推理深度滑块 (Model Selector Popover)
- **对应截图**：`REF-015`
- **对应组件**：[`components/Composer.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/Composer.tsx), [`components/settings/ReasoningEffortSelect.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/ReasoningEffortSelect.tsx)
- **规格与特性**：
  - 容器尺寸：固定宽度约 `320px`，圆角 `16px`，背景 `--ds-bg-elevated-opaque`，阴影 `--ds-shadow-dialog`；
  - 顶部模型搜索：内置小搜索框，支持键入拼音或关键词过滤厂商模型；
  - 列表行：展示厂商名称、模型标识、能力小图标（如 Sparkles、Eye）、上下文尺寸（如 `1.05M`）、当前激活态右侧对勾；
  - 底部连续滑块（推理深度）：
    - 刻度：`omit` / `off` / `low` / `medium` / `high` / `max`；
    - 滑块与刻度文字一体联动，调节直接作用于当前会话的 `reasoning_effort` 参数。

---

### 3.3 上下文检查器 (ContextUsageInspector)
- **对应截图**：`REF-023`
- **对应组件**：[`components/ContextUsageInspector.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ContextUsageInspector.tsx)
- **视觉与数据展现**：
  - 触发器：Composer 右侧带百分比文字的微型 SVG 环形进度条 (`CONTEXT_RING_RADIUS = 9`)；
  - 弹出卡片内容：
    - 顶端大字：剩余 Token 总量与百分比；
    - 窗口占用比例进度条；
    - 阶段耗时拆解树（精确到秒与百分比）：网络请求耗时、模型响应耗时、本地工具执行耗时；
    - 模型用量细分（输入 Tokens、输出 Tokens、推理 Tokens）。

---

### 3.4 输入框补全菜单 (ComposerAutocomplete)
- **对应截图**：`REF-022`, `REF-024`
- **对应组件**：[`components/ComposerAutocomplete.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ComposerAutocomplete.tsx)
- **特性规范**：
  - 触发模式：支持斜杠 `/` 呼出系统命令与技能，支持 `@` 呼出工作区文件/文件夹；
  - 宽度：填满输入框可用宽度，圆角 `16px`；
  - 焦点策略：光标保持在 Textarea 中，通过事件监听器拦截上下键与回车，实现无缝键入；
  - 高亮匹配：用户输入的前缀字符在结果项中通过 `.composer-ac-hl` 施加半加粗高亮；
  - 底部快捷提示行：统一固定为 `↑↓ 选择 · Enter 确认 · Esc 关闭`。

---

### 3.5 模态对话框 (Dialog & Provider Setup Dialog)
- **对应截图**：`REF-013`, `REF-014`
- **对应组件**：[`components/settings/ProviderSetupDialog.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/settings/ProviderSetupDialog.tsx)
- **架构规范**：
  - 挂载宿主：Portal 插入至 `#pi-desktop-overlays`；
  - 遮罩：全屏渐入，点击遮罩或按 `Esc` 触发取消回调；
  - 弹窗外框：圆角 `20px`，最大宽度根据内容自适应（单栏 440px，供应商双栏 780px），`max-height: calc(100vh - 48px)`；
  - 头部结构：主标题居左，操作按钮（高级设置、取消、确定主按钮）居右水平排列。

---

### 3.6 上下文菜单 (ContextMenu)
- **对应截图**：`REF-020`
- **对应组件**：[`components/ContextMenu.tsx`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/components/ContextMenu.tsx)
- **样式文件**：[`styles/ui-kit.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/ui-kit.css#L260-L340)
- **视觉规格**：
  - 最小宽度：`184px`；内边距：`5px`；圆角：`14px` (`var(--radius-md-plus)`)；
  - 背景：`var(--ds-bg-elevated-opaque)`；边框：1px `var(--ds-border-subtle)`；阴影：`--ds-shadow-dialog`；
  - 菜单项：高度约 30px，左侧带小图标，右侧可带二级子菜单 Chevron (`>`)；
  - 危险项：标记 `.danger`，图标与文字变为 `--ds-error`，悬停背景为 10% 红色弱遮罩。
