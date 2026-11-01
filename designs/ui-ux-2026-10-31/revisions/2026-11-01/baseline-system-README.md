# Pi Workbench

Pi Workbench 是 pi-GUI 的桌面设计提案：让会话、工具活动和工作面板在同一套尺度里稳定地协作。它面向长时间阅读与操作，不使用装饰性渐变、发光、超大圆角或重复卡片。

**状态：设计阶段，未接入生产应用。** 本系统来自当前源码清单与本轮重新设计，不能视为生产 CSS 的逐值镜像。所有交互示例是明确标记的演示，不连接模型或真实用户数据。

## 构建来源与清单

- 源码基线：`HYJ1817/pi-gui`，`9694339ecee18383c34897fdd98fa79457598a83`。
- 已枚举 `public/*.css` 中 155 个 CSS 自定义属性声明、115 个唯一名称，注释已排除；逐项原始值与行号见 [source-inventory.json](source-inventory.json)。
- 重点来源：`public/tokens.css:4–149`、`public/styles.css:34–38`、`public/ui3-composer.css`、`public/ui4-pane.css:34–35`；状态边界依据 `docs/app-shell.md`、`docs/composer-ui.md`、`docs/work-surfaces.md`。
- 原项目有中央 token 层和兼容别名，不能以“完全无设计系统”描述现状。当前基础为深灰/暖白、13px UI、14px正文、4px间距格；本提案保留这些适合桌面工作的抽象。
- 原始值与新方案分开记录：[Original-Inventory.md](Original-Inventory.md) 是事实清单；`tokens.json` 是新方案。
- 19 组件均有状态规范和原生可交互预览，完整清单见 [Component-Coverage.md](Component-Coverage.md)。
- 源码根 public 未发现可分发的字体文件。采用本机 Windows 字体栈，不复制系统字体、不从网络加载字体。无品牌图片导入；名称使用普通排字，不近似任何外部品牌标识。
- **Not synced：** 未构建或复制生产组件；本系统是用户要求的新设计，19 预览均为手写原生 HTML/CSS 设计组件，不宣称与生产组件自动同步。原始 color-mix/calc/兼容别名保存在事实清单，未伪装为新 tokens 的精确迁移。

## 设计原则

1. **位置是记忆。** 选择会话不触发重新排序；hover/pressed 不缩放、不加边框宽度。固定 Rail/Sidebar/Composer 的主轴。
2. **内容先行。** Assistant 正文开放排版，用户消息只用 `surface-user`；工具详情按需展开，代码与 Diff 内部滚动。
3. **只在需要时强调。** 中性主按钮使用 `primary`；蓝色 `accent` 只用于链接、焦点和选中项。成功/警告/错误配合文字，不以颜色替代状态。
4. **一个功能，一个归属。** 对话、任务、扩展仍是既有一级入口；Changes、Specs、Browser 是会话工作面板；设置里的低频操作分组，不造无业务能力的按钮。
5. **每个等待都有名称。** 读取中、运行中、停止中、等待审批与已停止是不同状态；未经 Pi 权威回读，模型与思考档位不能伪造成功。
6. **恢复有边界。** 草稿、附件、阅读位置按会话 owner 保存；Browser 不因打开页面或刷新自动恢复外部连接。错误保留原数据与可恢复路径。

## 视觉基础与消费方式

先读取 `tokens.json`；编辑器自动从它生成 `tokens.css`。消费端依次载入：

```html
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="components/bundle.css">
```

设 `<html data-theme="light">` 或 `dark`，不在组件里写独立近似颜色。不把 tokens.css 当第二份真相，不手改生成文件。组件仅提供 scoped CSS 类，例如 `.pw-button`、`.pw-icon-button`、`.pw-input`、`.pw-badge`。没有 JavaScript 组件 bundle、没有 React 或组件全局；原生语义与生命周期由 consumer 的现有模块负责。

| 用途 | Token |
| --- | --- |
| 主背景/导航/浮层/输入/代码 | surface-canvas / surface-nav / surface-panel / surface-input / surface-code |
| 主/次/辅助文字 | text-primary / text-secondary / text-muted |
| 装饰分隔/可操作控件边界 | border-subtle / border-control |
| 选中与焦点 | accent + accent-soft / focus |
| 主按钮 | primary + text-on-primary，hover/pressed 对应 token |
| 状态 | success/warning/danger/running；始终配文字 |
| 布局 | rail-width 52 / sidebar-width 248 / header-height 52 / status-height 28 / reading-width 780 / pane-width 420 |
| 圆角 | control 6 / panel 8 / composer 10；正文区域无外壳 |
| 排字 | font-sans，UI 13/20；prose 14/24；caption 12/18；font-mono 12/20 |
| 间距 | space-4 基本格；8/12/16/24/32 分别为组件内/组内/区块尺度 |

所有颜色、文字、间距、布局、图标、边框、阴影、z-index 与时长均在 tokens.json 可编辑。时长归 `timing` family，因为该编辑器不接受 `motion` family。每个 token 有 usage。

## 状态、浮层与动效

每个组件明确 default / hover / pressed / selected / focus / disabled / error。复合组件将状态作用于真实可交互子项；只读信息没有 selection/disabled 时，规范明确不制造语义。聚焦始终 2px focus + 2px offset；不隐藏浏览器焦点。

菜单/模型选择器优先向上打开，保持至少8px视口留白，溢出时内部滚动；Dialog max-height 由视口减32px限制。native Browser 必须沿用既有 detach 规则，不能让网页盖过 Modal。Escape 按最内层浮层优先关闭，关闭回到原触发器；全局错误不抢焦点。

只使用 80ms hover、120ms menu、160ms panel 的必要反馈，最长200ms。不自动滚动打断阅读，不用 spinner 掩盖不确定状态。`prefers-reduced-motion: reduce` 时所有过渡归零。图标统一16px/1.5px描边，辅助14px，主要20px；目标36px，触摸44px。高DPI使用CSS px与1px边界，不依赖物理像素硬算位置。

## 对比度与视觉验收

对文字与其说明的背景、主按钮、语义状态、焦点/控件边界进行了 78 个确定实色配对计算，78/78 达到要求；详细配对和算法见 [Contrast-Checks.md](Contrast-Checks.md)。最小普通文字比值 4.61:1。首次 text-muted 在 hover/pressed 不达标，已迭代为 light #536171 / dark #a7b4c4。

数值检查不等于视觉验收。关键页面三尺寸、light/dark、键盘、菜单与面板截图/交互记录由本轮设计交付的真实 Chromium 验收补充。Windows OS 字体回退、实体 IME、原生 Browser 和系统150%高DPI最终仍需产品集成阶段验证，不能从本系统预览推断通过。

## 品牌与内容示例

- 正确：“模型列表读取失败。草稿已保留。重试。”错误说明范围并给动作。
- 正确：“正在停止… 等待 Pi 确认。”保留 submit barrier。
- 正确：“历史工具活动 · 已完成 / 错误 / 未知”，只显示后端允许字段。
- 避免：“全绿”“一键修复”“已完成”这类没有实际证据的反馈。
- 日期、标题、路径、供应商身份从实际 owner 取得并安全写入；不将原始 payload、密钥、用户文件内容写到诊断或通知里。


---

## Consuming this system (generated — do not edit)

Every path named below is under `project/` in this design system: read `project/api/tokens.md`, not `api/tokens.md`.

19 components are documented without a runnable `components/bundle.js`: read each component’s card, and its README where it has one (`components/<Comp>/README.md`), and build to those guidelines. Tokens: the values are on `api/tokens.md`; a Slides deck or Design canvas also takes `tokens.json` by file path. On a Design canvas, also copy `tokens.css` to `project/ds/<folder>/tokens.css` in the call that installs this system, and link it in each artboard that uses this system, right after the `support.js` line and before the system’s other stylesheets: `<link rel="stylesheet" href="ds/<folder>/tokens.css">` (with one `../` in front for each folder the artboard is in).

**Read, per thing:** a component’s props, parts and examples: `api/components/<Comp>.md`; token values: `api/tokens.md`. After this README, fetch the cards and fonts you need in ONE message as parallel calls — none depends on another.

**Two rules.** Before you use a thing — a component, a token group, an icon, an asset — read its card from the index below; a value you did not read from a card is a guess. `tokens.json`, `manifest.json` and `design-system.json` are sources for tools: hand them over. `components/<Comp>/README.md` is the long-form second read a card links to; the `design-system` skill is authoring guidance, not needed to consume the system.

## Index (generated — do not edit)

**Tokens**

- `api/tokens.md` — Every token: surface, text, fill, border, palette, type, spacing, radius, shadow, layout, icon, z-index, timing. (14.2k)

**Components** (`api/components/<Comp>.md`, 19)

- **Actions**: `Button` — 按钮以稳定尺寸表达单次操作，只保留一个主要动作。 · `IconButton` — 图标按钮提供紧凑且有可访问名称的辅助操作。
- **Conversation**: `ChatMessage` — 聊天消息以角色、正文和可收拢活动建立可长读的信息层级。 · `ToolActivity` — 工具活动默认压缩为可扫描的阶段与结果，需要时再展开细节。
- **Overlays**: `Dialog` — 模态对话框只用于需要中断当前工作的确认或独立编辑。 · `Menu` — Dropdown 和右键菜单共用动作列表、锚点边界和键盘规则。 · `Popover` — 非模态浮层承载当前操作的补充信息，不改变输入区布局。 · `Tooltip` — Tooltip 解释图标操作与快捷键，不承载必要操作或错误原因。
- **Feedback**: `EmptyState` — 空状态解释当前上下文并提供一个真实可执行的下一步。 · `ErrorState` — 错误状态保留上下文、说明影响范围，并提供可验证的恢复动作。 · `Progress` — 进度条仅在有可靠分母时显示百分比，否则显示活动和阶段文字。 · `StatusIndicator` — 状态标识以文字和形状共同表达系统状态，颜色只作补充。 · `Toast` — Toast 对非阻断操作提供短暂、去重且不打断焦点的确认。
- **Inputs**: `Input` — 单行输入通过标签、提示和内联错误完整表达字段含义。 · `ModelPicker` — 模型选择器同时呈现供应商、模型身份与权威回读状态。 · `Textarea` — 多行输入固定宽度并按内容增高，超出上限后内部滚动。
- **Navigation**: `Sidebar` — 会话侧栏使用固定行序和项目层级，让选择动作保持空间稳定。 · `Tabs` — 页签切换同一工作面板内的兄弟视图并保留各自状态。
- **Workspace**: `WorkPanel` — 右侧工作面板共用标题、页签、尺寸和关闭规则，并保留业务实例。
