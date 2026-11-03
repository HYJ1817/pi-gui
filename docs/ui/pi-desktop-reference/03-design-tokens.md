# 03. 视觉规范与设计系统 (Design Tokens Specification)

> **审计与对齐说明 (Audit Reconciliation)**：
> 1. 本文档与 PI-Desktop 固定版本源码 [`apps/desktop/src/styles/tokens.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/tokens.css) 及设计规范文档 [`07-ui-design-system.md`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/docs/zh-CN/spec/04-ux/07-ui-design-system.md) 进行了程序化逐变量比对。
> 2. 对此前过于绝对化的设计断言（如“全局绝对零边框”）进行了修正：依据 D297 规范，内流布局（In-flow structure）废弃分割线条，依靠三层色调表达结构；但浮层结构（弹窗、下拉菜单、Tooltip）保留微发丝微边框作为海拔层级提示（Elevation cues），开关关闭态保留 1px 细环。
> 3. 所有变量严格分类为：**原样保留 (Retained)**、**修复不一致 (Corrected)**、**补齐布局与动效 (Added Layout & Motion)** 与 **排除适配别名 (Omitted Tailwind Aliases)**。

---

## 1. 变量提取对照与分类总表

| 变量分类 | 数量 | 包含的具体设计令牌 (Design Tokens) | 上游源码依据与处理说明 |
|---|---|---|---|
| **原样保留 (Retained)** | 78 项 | `--gray-0` 至 `--gray-1000` (基础灰阶)<br>`--accent-50` 至 `--accent-900` (中性强调)<br>`--ds-bg-primary`, `--ds-bg-secondary`, `--ds-bg-tertiary`, `--ds-bg-inset`, `--ds-bg-under`, `--ds-bg-composer`<br>`--ds-text-primary`, `--ds-text-secondary`, `--ds-text-muted`, `--ds-text-faint`<br>`--ds-tile`, `--ds-tile-hover`, `--ds-tile-deep`, `--ds-raised`, `--ds-raised-shadow`<br>`--ds-border-default`, `--ds-border-subtle`, `--ds-border-strong`<br>`--radius-*`, 排版字阶与行高阶梯 | 与 [`tokens.css`](https://github.com/vastsa/PI-Desktop/blob/92ae661f1e399e69d514086b46029b4c34ba1a92/apps/desktop/src/styles/tokens.css) 1:1 完全一致，保留精确的色彩空间公式与 Alpha 不透明度计算。 |
| **修复不一致 (Corrected)** | 23 项 | **状态功能色**：暗色 `--ds-success` (`#40c977`), `--ds-warning` (`#ff8549`), `--ds-error` (`#ff6764`), `--ds-info` (`var(--gray-300)`), `--ds-purple` (`#c27aff`)；亮色 `--ds-success` (`#00a240`), `--ds-warning` (`#e25507`), `--ds-error` (`#e02e2a`), `--ds-info` (`#5d5d5d`), `--ds-purple` (`#7c3aed`)<br>**占位与表单**：`--ds-placeholder-ink` (暗色 42% alpha / 亮色 `#4a4c4f`)、`--ds-settings-field-bg` (`#212121` / `#ffffff`)、`--ds-field-inset-bg` (5% oklab mix)、`--ds-field-inset-focus-bg` (7% oklab mix / `#ffffff`)、`--ds-send-disabled-bg/fg`、`--ds-switch-ring-off` (22% alpha)<br>**浮动阴影**：暗色 `--ds-shadow-dialog` (`0 16px 48px rgba(0, 0, 0, 0.55)`)、`--ds-shadow-model-menu`；亮色 `--ds-shadow-dialog` (`0 16px 48px rgba(0, 0, 0, 0.12)`)、亮色 `--ds-shadow-model-menu` (3 层复合阴影)<br>**渲染遮罩**：`--ds-scrim`、`--ds-modal-veil`、`--ds-thinking-code-bg`、`--ds-mermaid-canvas`、`--ds-code-head/hover-bg` | 彻底修复上轮审查中残留的近似色与 Tailwind 默认色（如误用 `#22c55e`、`#f59e0b`、`#ef4444`），恢复为上游经过 oklab 与无极感知调校的真实原版色彩。 |
| **补齐布局与动效 (Added)** | 22 项 | **布局几何**：`--ds-sidebar-width`, `--ds-settings-nav-width` (`275px`), `--ds-toolbar-height` (`46px`), `--ds-control-size` (`28px`), `--ds-field-height` (`calc(18px + ...)`), `--ds-settings-picker-height`, `--ds-work-panel-toggle-size` (`28px`), `--ds-work-panel-toggle-inset` (`12px`), `--ds-work-panel-control-gap` (`4px`), `--ds-preview-action-lane-width`, `--ds-window-controls-width` (`120px`), `--ds-traffic-light-*`, `--ds-window-lead-inset`, `--ds-composer-radius` (`var(--radius-xl)`), `--ds-bg-elevated-primary`<br>**动效时间与贝塞尔**：`--motion-duration-fast` (`150ms`), `--motion-duration-normal` (`200ms`), `--motion-duration-slow` (`300ms`), `--motion-ease-out`, `--motion-ease-in`, `--motion-ease-standard` | 首轮遗漏的全局视口、设置导轨、输入框与工作面板关键尺寸约束，本次已 1:1 提取并合并进设计系统。 |
| **排除适配别名 (Omitted)** | 25 项 | 上游在 `@theme` 块中定义的 `--color-bg-primary: var(--ds-bg-primary);` 至 `--color-purple: var(--ds-purple);` 等 Tailwind v4 工具类映射别名 | **刻意排除**：pi-GUI 采用原生 Vanilla CSS 与独立命名空间架构，不引入 Tailwind v4 编译依赖。组件直接消费 `--ds-*` 语义令牌，无需冗余的中间桥接别名。 |

---

## 2. 核心设计哲学与规范边界

PI-Desktop 的视觉设计系统基于 **Codex Desktop / ChatGPT.app (electron-dark)** 演进而来，具有极高的信息密度与克制的桌面专业质感：

### 2.1 表面层级与边框规范 (D297 细化规则)
- **内流排版消除线条 (Divider-Free In-Flow Surfaces)**：
  - 常规页面内部（对话流、设置行、侧边栏列表）废弃传统 1px 分割线。
  - 空间结构由三层色调表达：
    - **底板层 (Page)**：主画布底色（深色 `#181818` / 浅色 `#ffffff`）。
    - **瓦片层 (Tile)**：由文字色通过 `color-mix` 混合出的微透明块（深色为 3.5% 白色，浅色为 3.5% 黑色），用于输入框底色、代码块底色、卡片底板。
    - **凸起层 (Raised)**：不透明抬升底色配合柔和微投影（`0 1px 2px rgba(0,0,0,0.35)`），用于分段选择器激活胶囊、聚焦控件。
- **允许保留微边框的场景 (Boundary Exceptions)**：
  - **浮动层 (Floating Layers)**：模态弹窗、右键菜单、下拉 Popover、Tooltip 保留微发丝边框 (`0 0 0 0.5px color-mix(...)` 或 `1px solid var(--ds-border-subtle)`) 作为海拔高度与聚焦提示。
  - **窗口控制接缝**：在 macOS/Windows 窗口控件区域，保留微细分界线以清晰标明归属。
  - **开关控件关闭态**：关闭的 Toggle 保留 1px 内嵌环 (`--ds-switch-ring-off`)，保证无色彩填充时仍可明确识别为可交互控件。

### 2.2 单色中性色阶与去品牌色强调 (Neutral Gray-Scale Accent)
- 主强调色（Accent）严格跟随单色阶反转：
  - 深色模式下，Accent 为纯白（`#ffffff`），悬停为 `#ededed`。
  - 浅色模式下，Accent 翻转为深墨色（`#1a1c1f`），悬停为 `#303030`。
- 状态色仅用于功能指示：
  - 运行中 / 警告：橙色 `--ds-warning` (深色 `#ff8549` / 浅色 `#e25507`)。
  - 成功 / 正常：绿色 `--ds-success` (深色 `#40c977` / 浅色 `#00a240`)。
  - 错误 / 失败：红色 `--ds-error` (深色 `#ff6764` / 浅色 `#e02e2a`)。
  - 信息 / 次级：中性 `--ds-info` (深色 `var(--gray-300)` / 浅色 `#5d5d5d`)。
  - 规划 / 特殊：紫色 `--ds-purple` (深色 `#c27aff` / 浅色 `#7c3aed`)。

---

## 3. 颜色系统与色彩代币 (Color Tokens)

### 3.1 基础灰阶调色板 (Codex Gray Scale)

```css
--gray-0:    #ffffff;
--gray-50:   #f9f9f9;
--gray-75:   #f3f3f3;
--gray-100:  #ededed;
--gray-300:  #afafaf;
--gray-500:  #5d5d5d;
--gray-550:  #4f4f4f;
--gray-600:  #414141;
--gray-700:  #303030;
--gray-750:  #282828;
--gray-800:  #212121;
--gray-900:  #181818;
--gray-1000: #0d0d0d;
```

---

### 3.2 深色主题规范 (Dark Theme - `:root`, `:root[data-theme="dark"]`)

| 代币名称 | 真实取值 / 计算公式 | 视觉语义与对应使用场景 |
|---|---|---|
| `--ds-bg-primary` | `#181818` (`var(--gray-900)`) | 应用程序主体画布背景（对话流、设置主体） |
| `--ds-bg-sidebar` | `#000000` | 左侧边栏、设置导航栏底色（极黑通透） |
| `--ds-bg-secondary` | `#212121` (`var(--gray-800)`) | 次级表面、用户消息气泡背景、侧边栏悬停底板 |
| `--ds-bg-tertiary` | `#282828` (`var(--gray-750)`) | 三级表面、嵌套卡片底色 |
| `--ds-bg-inset` | `#0d0d0d` (`var(--gray-1000)`) | 代码块最深层凹陷背景 |
| `--ds-bg-dock` | `#212121` (`var(--gray-800)`) | 右侧工作面板 (WorkPanel) 背景底色 |
| `--ds-bg-dock-raised` | `transparent` | 工作面板标签栏及浮条底色 |
| `--ds-bg-elevated` | `color-mix(in oklab, #212121 96%, transparent)` | 半透明抬升层 |
| `--ds-bg-elevated-primary`| `color-mix(in oklab, #212121 96%, transparent)`| 抬升首选底色 |
| `--ds-bg-elevated-opaque`| `#282828` (`var(--gray-750)`) | 弹窗、右键菜单、浮层 Popover 不透明抬升底色 |
| `--ds-bg-hover` | `color-mix(in oklab, #ffffff 6%, transparent)` | 通用交互项悬停色（按钮、菜单行） |
| `--ds-bg-active` | `color-mix(in oklab, #ffffff 10%, transparent)`| 通用项点击激活色 |
| `--ds-bg-composer` | `color-mix(in oklab, #212121 96%, transparent)`| 底部浮动输入框底色（微透暗灰） |
| `--ds-tile` | `color-mix(in oklab, #ffffff 3.5%, transparent)` | 无边框瓦片层基础色（列表卡片、输入框、代码块） |
| `--ds-tile-hover` | `color-mix(in oklab, #ffffff 6%, transparent)` | 瓦片层悬停高亮底色 |
| `--ds-tile-deep` | `color-mix(in oklab, #ffffff 8%, transparent)` | 瓦片层凹陷/深色模式底色 |
| `--ds-raised` | `#282828` (`var(--gray-750)`) | 激活分段项凸起块 |
| `--ds-raised-shadow` | `0 1px 2px rgba(0, 0, 0, 0.35)` | 凸起物柔和微投影 |
| `--ds-text-primary` | `#ffffff` (`var(--gray-0)`) | 主文本、标题、核心正文文字 |
| `--ds-text-secondary` | `color-mix(in oklab, #ffffff 70%, transparent)`| 次级文本、导航项文字、时间戳、说明 |
| `--ds-text-muted` | `color-mix(in oklab, #ffffff 52%, transparent)`| 弱化说明、图标默认色、占位符 |
| `--ds-text-faint` | `color-mix(in oklab, #ffffff 38%, transparent)`| 最弱化提示、快捷键提示符 |
| `--ds-placeholder-ink` | `color-mix(in oklab, #ffffff 42%, transparent)`| 输入框内暗色占位符文字 |
| `--ds-border-default` | `color-mix(in oklab, #ffffff 8%, transparent)` | 弹窗、下拉菜单等浮层外圈微发丝边框 |
| `--ds-border-subtle` | `color-mix(in oklab, #ffffff 5%, transparent)` | 菜单内部微弱分割线 |
| `--ds-border-strong` | `color-mix(in oklab, #ffffff 14%, transparent)`| 强对比边框 |
| `--ds-accent` | `#ffffff` | 单色主强调色（主按钮白底、选中态白标记） |
| `--ds-accent-hover` | `#ededed` | 主强调色悬停 |
| `--ds-accent-soft` | `#afafaf` | 软性强调色、超链接文字 |
| `--ds-focus` | `var(--ds-accent)` | 焦点轮廓颜色 |
| `--ds-settings-field-bg`| `#212121` | 设置输入框背景色 |
| `--ds-field-inset-bg` | `color-mix(in oklab, var(--ds-text-primary) 5%, transparent)` | 表单与搜索框内嵌背景 |
| `--ds-field-inset-focus-bg` | `color-mix(in oklab, var(--ds-text-primary) 7%, transparent)` | 表单与搜索框内嵌聚焦背景 |
| `--ds-switch-track-off` | `color-mix(in oklab, #ffffff 10%, transparent)`| 开关关闭轨道色 |
| `--ds-switch-track-off-hover` | `color-mix(in oklab, #ffffff 18%, transparent)`| 开关关闭轨道悬停色 |
| `--ds-switch-ring-off` | `color-mix(in oklab, #ffffff 22%, transparent)`| 开关关闭态外轮廓细环 |
| `--ds-switch-knob-off` | `#afafaf` (`var(--gray-300)`) | 开关关闭滑钮色 |
| `--ds-switch-knob-on` | `#181818` (`var(--gray-900)`) | 开关开启滑钮色（反显在白底轨道上） |
| `--ds-send-disabled-bg`| `color-mix(in oklab, var(--ds-text-primary) 18%, transparent)` | 发送按钮禁用态底色 |
| `--ds-send-disabled-fg`| `color-mix(in oklab, var(--gray-900) 70%, transparent)` | 发送按钮禁用态箭头图标颜色 |
| `--ds-success` | `#40c977` | 成功/验证通过状态色 |
| `--ds-warning` | `#ff8549` | 警告/运行中状态色 |
| `--ds-error` | `#ff6764` | 错误/拒绝状态色 |
| `--ds-info` | `var(--gray-300)` | 提示信息次级色 |
| `--ds-purple` | `#c27aff` | 智能体规划模式高光色 |
| `--ds-shadow-composer` | `0 3px 7.5px #0000000a, 0 0 20px #0000000d` | 输入框浮层轻微自然阴影 |
| `--ds-shadow-dialog` | `0 16px 48px rgba(0, 0, 0, 0.55)` | 模态弹窗深度下沉阴影 |
| `--ds-shadow-model-menu` | `var(--ds-shadow-dialog)` | 模型选择卡片浮层阴影 |

---

### 3.3 浅色主题规范 (Light Theme - `:root[data-theme="light"]`)

| 代币名称 | 真实取值 / 计算公式 | 视觉语义与对应使用场景 |
|---|---|---|
| `--ds-bg-primary` | `#ffffff` | 纯白主画布底色 |
| `--ds-bg-sidebar` | `#f3f3f3` (`var(--gray-75)`) | 浅灰侧边栏底色 |
| `--ds-bg-secondary` | `#f9f9f9` (`var(--gray-50)`) | 浅次级表面 |
| `--ds-bg-tertiary` | `#f3f3f3` | 嵌套层底色 |
| `--ds-bg-inset` | `#ededed` (`var(--gray-100)`) | 浅色代码块凹陷底色 |
| `--ds-bg-dock` | `#fafafa` | 浅色工作面板底色（如宁静信纸） |
| `--ds-bg-dock-raised` | `#ffffff` | 工作面板白色抬头 |
| `--ds-bg-elevated` | `color-mix(in oklab, #ffffff 70%, transparent)`| 浅色半透明抬升底色 |
| `--ds-bg-elevated-primary`| `color-mix(in oklab, #ffffff 70%, transparent)`| 浅色抬升首选底色 |
| `--ds-bg-composer` | `#ffffff` | 底部浮动纯白输入框 |
| `--ds-tile` | `color-mix(in oklab, #1a1c1f 3.5%, transparent)`| 浅色瓦片层底色 |
| `--ds-tile-hover` | `color-mix(in oklab, #1a1c1f 6%, transparent)` | 浅色瓦片悬停底色 |
| `--ds-tile-deep` | `color-mix(in oklab, #1a1c1f 8%, transparent)` | 浅色瓦片深色态（如附件胶囊） |
| `--ds-raised` | `#ffffff` | 浅色凸起激活块 |
| `--ds-raised-shadow` | `0 1px 2px rgba(0,0,0,0.1), 0 0 0 0.5px rgba(0,0,0,0.04)`| 浅色凸起柔光微阴影 |
| `--ds-text-primary` | `#1a1c1f` | 高可读性深墨黑文字 |
| `--ds-text-secondary` | `color-mix(in oklab, #1a1c1f 74%, transparent)`| 次级文字（约 74% 不透明黑） |
| `--ds-text-muted` | `#5d5d5d` | 浅色弱化文字 |
| `--ds-text-faint` | `#afafaf` | 浅色最弱提示文字 |
| `--ds-placeholder-ink` | `#4a4c4f` | 浅色输入框占位符文字 |
| `--ds-border-default` | `color-mix(in oklab, #1a1c1f 8%, transparent)` | 浅色浮层微边框 |
| `--ds-border-subtle` | `color-mix(in oklab, #1a1c1f 5%, transparent)` | 浅色微弱边线 |
| `--ds-accent` | `#1a1c1f` | **浅色强调色反转**：深墨黑主按钮背景、黑滑块 |
| `--ds-accent-hover` | `#303030` | 浅色强调色悬停 |
| `--ds-settings-field-bg`| `#ffffff` | 浅色设置输入框背景 |
| `--ds-field-inset-bg` | `#f3f3f3` | 浅色表单内嵌背景 |
| `--ds-field-inset-focus-bg` | `#ffffff` | 浅色表单聚焦背景 |
| `--ds-switch-track-off` | `color-mix(in oklab, #1a1c1f 10%, transparent)`| 浅色开关关闭轨道 |
| `--ds-switch-track-off-hover` | `color-mix(in oklab, #1a1c1f 18%, transparent)`| 浅色开关关闭轨道悬停 |
| `--ds-switch-ring-off` | `color-mix(in oklab, #1a1c1f 20%, transparent)`| 浅色开关关闭细环 |
| `--ds-switch-knob-off` | `#ffffff` | 浅色开关关闭滑钮（纯白） |
| `--ds-switch-knob-on` | `#ffffff` | 浅色开关开启滑钮（在黑轨道上为纯白） |
| `--ds-thinking-code-bg`| `#f0f0f0` | 思考块浅灰底色 |
| `--ds-mermaid-canvas` | `#ffffff` | 浅色图表画布背景 |
| `--ds-code-head-bg` | `color-mix(in oklab, #1a1c1f 3.5%, transparent)`| 浅色代码头背景 |
| `--ds-code-hover-bg` | `color-mix(in oklab, #1a1c1f 6%, transparent)` | 浅色代码悬停底色 |
| `--ds-scrim` | `color-mix(in oklab, #1a1c1f 28%, transparent)`| 浅色淡化遮罩（防止纯黑遮罩压碎白色视窗） |
| `--ds-modal-veil` | `color-mix(in oklab, #1a1c1f 32%, transparent)`| 浅色模态遮罩 |
| `--ds-tool-row-bg` | `color-mix(in oklab, #1a1c1f 2%, transparent)` | 工具条浅微底色 |
| `--ds-send-disabled-bg`| `#8e8e90` | 浅色发送按钮禁用态金灰色底色 |
| `--ds-send-disabled-fg`| `#ffffff` | 浅色发送按钮禁用态白色箭头 |
| `--ds-success` | `#00a240` | 浅色成功色 |
| `--ds-warning` | `#e25507` | 浅色警告色 |
| `--ds-error` | `#e02e2a` | 浅色错误色 |
| `--ds-info` | `#5d5d5d` | 浅色提示色 |
| `--ds-purple` | `#7c3aed` | 浅色规划模式紫色 |
| `--ds-shadow-composer` | `0 3px 7.5px #0000000a, 0 0 20px #0000000d` | 输入框轻阴影（与暗色同参数） |
| `--ds-shadow-dialog` | `0 16px 48px rgba(0, 0, 0, 0.12)` | 浅色弹窗淡阴影 |
| `--ds-shadow-model-menu` | `0 0 0 0.5px color-mix(in oklab, #1a1c1f 10%, transparent), 0 8px 32px rgba(0, 0, 0, 0.1), 0 2px 8px rgba(0, 0, 0, 0.06)` | 浅色模型菜单复合阴影 |

---

## 4. 布局度量体系 (Layout & Geometry System)

```css
/* 边栏与设置导轨 */
--ds-sidebar-width: clamp(240px, 275px, min(520px, calc(100vw - 320px)));
--ds-settings-nav-width: 275px;

/* 顶栏与核心控件高宽 */
--ds-toolbar-height: 46px;
--ds-control-size: 28px;
--ds-field-height: calc(18px + var(--text-base) * var(--leading-body));
--ds-settings-picker-height: calc(14px + var(--text-sm-plus) * var(--leading-body));

/* 工作面板控制簇 */
--ds-work-panel-toggle-size: 28px;
--ds-work-panel-toggle-inset: 12px;
--ds-work-panel-control-gap: 4px;
--ds-preview-action-lane-width: calc(2 * var(--ds-work-panel-toggle-size) + 4px + 8px);

/* 窗口安全区与红绿灯 */
--ds-window-controls-width: 120px;
--ds-traffic-light-edge: 0px;
--ds-traffic-light-gap: 12px;
--ds-window-lead-inset: 0px;

/* 输入框大圆角 */
--ds-composer-radius: var(--radius-xl);    /* 20px */
--ds-composer-radius-lg: var(--radius-xl); /* 20px */
```

---

## 5. 动效度量体系 (Motion Tokens System)

```css
/* 动效时长 */
--motion-duration-fast: 150ms;
--motion-duration-normal: 200ms;
--motion-duration-slow: 300ms;

/* 缓动曲线 */
--motion-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
--motion-ease-in: cubic-bezier(0.4, 0, 1, 1);
--motion-ease-standard: cubic-bezier(0.2, 0, 0, 1);
```

---

## 6. 排版系统与字体标尺 (Typography System)

### 6.1 字体标尺梯级 (Type Ramp Scale)
排版字号均统一乘以 `--font-scale`（用户可配置范围 0.8 ~ 1.5，默认为 1）：

| 代币名称 | 计算值 (`font-scale = 1`) | 典型使用场景 |
|---|---|---|
| `--text-3xs` | `10.5px` | 极小快捷键说明徽章 (Kbd tags) |
| `--text-xs` / `--text-2xs` | `11px` | 时间戳、最小状态徽章、输入字数统计 |
| `--text-xs-plus` | `11.5px` | 弱化元数据、菜单小副标题 |
| `--text-sm` | `12px` | 次级标签、工具条说明、侧边栏分组标题 (`会话`、`项目`) |
| `--text-sm-plus` | `12.5px` | 状态胶囊、正在处理指示文本、代码块字号 |
| `--text-md` | `13px` | 侧边栏会话/项目标题、空状态引导说明、列表普通项 |
| `--text-md-plus` | `13.5px` | 输入框模式标签、设置行主标题 |
| `--text-base` | `14px` | **应用核心正文字号**：聊天消息文本、输入框输入字号、主要按钮 |
| `--text-base-plus` | `15px` | 品牌名、重要卡片主标题 |
| `--text-lg` | `16px` | 弹窗中标题、设置组大标题 |
| `--text-lg-plus` | `18px` | 大号卡片标题 |
| `--text-xl` | `20px` | 强调页面级标题 |
| `--text-2xl` | `28px` | 设置中心顶层大标题 (`常规`、`模型配置`)、主界面 Hero 标题 |

### 6.2 字重阶梯 (Font Weights)
- `--font-weight-normal`: `400`（正文、常规说明）
- `--font-weight-medium`: `500`（中等强调、分组标签、按钮文字）
- `--font-weight-medium-plus`: `520`（微加粗标签）
- `--font-weight-strong`: `560`（设置大标题、卡片主标题）
- `--font-weight-semibold`: `600`（品牌名、关键 CTA 主按钮）

### 6.3 圆角阶梯 (Radius Scale - Codex Apple-tuned 2px Rhythm)
- `--radius-3xs`: `4px` (行内代码块)
- `--radius-2xs`: `6px` (小型徽章)
- `--radius-xs`: `8px` (紧凑按钮)
- `--radius-sm`: `10px` (表单控件、菜单项)
- `--radius-md`: `12px` (下拉菜单、小卡片)
- `--radius-md-plus`: `14px` (设置普通卡片)
- `--radius-lg`: `16px` (弹窗面板、技能卡片)
- `--radius-lg-plus`: `18px` (用户消息气泡)
- `--radius-xl`: `20px` (输入框 Composer 胶囊)
- `--radius-2xl`: `24px` (大型模态框)
- `--radius-full`: `9999px` (圆形药丸胶囊)
