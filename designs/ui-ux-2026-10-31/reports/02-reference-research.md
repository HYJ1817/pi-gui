# PI-Desktop 视觉与交互研究

研究日期：2026-10-31（Asia/Shanghai）。本报告服务于 pi-GUI 设计阶段，不构成生产代码实施或架构迁移建议。

**补充证据：**用户随后提供 12 张 PI-Desktop **0.21.0** 实机截图，本轮已逐张查看。它们补充了下文官方 0.14.6 历史截图，详见 [用户截图与现有原型对照](08-user-reference-comparison.md)。新图覆盖首页、面板入口和多类设置；没有聊天内容、运行时间线、菜单打开或浅色状态，不将其扩展为交互验证。

2026-11-01 又补充 9 张，累计 21 张，详见 [聊天、模型菜单、工作面板与双主题对照](09-user-reference-chat-comparison.md)。新增证据与仍缺的工具调用、Diff、失败状态分别记录，不把静态截图当作交互运行证明。

## 1. 研究基线、证据分层与限制

参考仓库：[vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop)。固定研究提交：[`c85251b7d968c21fbf0f07fb515bdc31ada49399`](https://github.com/vastsa/PI-Desktop/tree/c85251b7d968c21fbf0f07fb515bdc31ada49399)。研究直接读取了 README、官方截图文档、12 张官方图片，以及当前组件、布局、主题、浮层、通知、会话恢复和工具展示源码。

本报告使用三种证据：

| 标记 | 含义 | 可支持的结论 |
| --- | --- | --- |
| 官方截图观察 | 本次实际打开官方仓库图片进行视觉检查 | 图片里的外观、信息组织与可见状态 |
| 当前源码核对 | 在上述固定提交读取实现与行号 | 默认参数、实现意图和实际代码路径 |
| 建议 / 推导 | 基于前两种证据提出适配 | 供 pi-GUI 原型比较，不是已验证产品行为 |

**版本差异必须保留：**当前参考仓库 `package.json` 为 **0.21.0**，已查看官方截图页脚显示 **v0.14.6**。截图是官方历史运行证据，不是本次最新版本的现场运行结果。参数有差异时以当前源码为实现事实，截图仅描述其可见样貌，不用旧图证明新行为。

[官方截图文档第 7–14 行](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/docs/zh-CN/guide/screenshots.md#L7)说明，图片来自临时数据目录中的运行截图装置，文案是样例数据。没有启动 PI-Desktop、没有调用模型、没有安装其依赖或执行项目脚本。临时只读研究 clone 中，`node_modules`、`apps/desktop/dist`、`target/debug/pi-desktop-host-core` 均不存在；官方重新截图要求预先构建 renderer 和 Rust host，因此没有声称完成本机运行验收。

临时研究目录：`C:\Users\21022\AppData\Local\Temp\pi-desktop-design-research-20261031`。该目录仅便于复查，不属于交付运行依赖。报告的引用均固定到原始仓库，不将参考品牌或素材复制到 pi-GUI 产物。

## 2. 已实际查看的官方截图索引

下列原始链接均固定到研究提交。它们是参考项目官方图片，和本阶段 pi-GUI 原版截图、改版原型截图有不同证据身份。

| 编号 | 原版图片 | 本次可见内容与判断边界 |
| --- | --- | --- |
| R01 | [home-light.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/c85251b7d968c21fbf0f07fb515bdc31ada49399/docs/public/screenshots/app/zh/home-light.webp) | 浅灰侧栏、白聊天区、居中空态、底部浮起输入框 |
| R02 | [home-dark.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/c85251b7d968c21fbf0f07fb515bdc31ada49399/docs/public/screenshots/app/zh/home-dark.webp) | 深色对应布局；黑侧栏、炭黑主区和深灰输入框 |
| R03 | [model-menu.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/c85251b7d968c21fbf0f07fb515bdc31ada49399/docs/public/screenshots/app/zh/model-menu.webp) | 输入区模型入口上方菜单，模型与推理的二级入口；属旧图外观 |
| R04 | [panel-files.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/c85251b7d968c21fbf0f07fb515bdc31ada49399/docs/public/screenshots/app/zh/panel-files.webp) | 右文件面板、自己的空态和标题，聊天跟随收窄 |
| R05 | [plugins-market.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/c85251b7d968c21fbf0f07fb515bdc31ada49399/docs/public/screenshots/app/zh/plugins-market.webp) | 已安装/市场、搜索、来源、分类、权限摘要、更新/已安装/无安装包 |
| R06 | [settings-live.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/c85251b7d968c21fbf0f07fb515bdc31ada49399/docs/public/screenshots/app/zh/settings-live.webp) | 整页设置目的地、独立可搜索分类栏、表单分区 |
| R07 | [minimap.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/c85251b7d968c21fbf0f07fb515bdc31ada49399/docs/public/screenshots/app/zh/minimap.webp) | 长对话、用户气泡、助手正文、行内代码、会话缩略导航 |
| R08 | [panel-review.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/c85251b7d968c21fbf0f07fb515bdc31ada49399/docs/public/screenshots/app/zh/panel-review.webp) | 文件列表 M/A/D、增删计数、折叠行和右侧审阅面板 |
| R09 | [panel-browser.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/c85251b7d968c21fbf0f07fb515bdc31ada49399/docs/public/screenshots/app/zh/panel-browser.webp) | 同一面板壳的浏览器标签；图中内容为空，不能证明网页导航功能 |
| R10 | [toasts-light.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/c85251b7d968c21fbf0f07fb515bdc31ada49399/docs/public/screenshots/app/zh/toasts-light.webp) | 顶部堆叠通知；主要靠图标表达语义色 |
| R11 | [notifications-dark.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/c85251b7d968c21fbf0f07fb515bdc31ada49399/docs/public/screenshots/app/zh/notifications-dark.webp) | 通知收件箱、未读过滤、大量通知滚动和 99+ 角标 |
| R12 | [extensions-mcp.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/c85251b7d968c21fbf0f07fb515bdc31ada49399/docs/public/screenshots/app/zh/extensions-mcp.webp) | **文件名与可见内容不一致：**实际看到插件市场，不能用于证明 MCP 独立界面 |

本地已查看图片前缀为 `C:\Users\21022\AppData\Local\Temp\pi-desktop-design-research-20261031\docs\public\screenshots\app\zh\`。图像尺寸为 1600×1067；图中侧栏约 367 个图像像素。不能直接将图像像素当 CSS px：275px 在约 1.333 倍下与其相符，但未取得截图装置 DPR 证据，不确定这是缩放还是历史布局差异。

## 3. 整体窗口、导航与区域比例

当前源码采用侧栏、主目的地、可选右工作面板的三列结构。聊天本身是内容表面，不再嵌入多重卡片。设置是独立目的地，工作面板是当前会话的辅助空间。

| 当前源码参数 | 数值与意义 | 来源 |
| --- | --- | --- |
| 侧栏 | 默认 275px，fallback 最小 240px，最大受窗口预算限制 | [tokens.css:154](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/tokens.css#L154) |
| 工具栏 | 46px，外壳与面板标题同一节奏 | [tokens.css:159](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/tokens.css#L159) |
| 图标控件 | 28px 方形命中区 | [tokens.css:162](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/tokens.css#L162) |
| 内容带 | 正文/输入框默认最大 760px | [chat-shell.css:45](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/chat-shell.css#L45) |
| 右面板 | 默认 360px，常规最小 244px | [work-panel-resize.ts:1](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/lib/work-panel-resize.ts#L1) |
| 主聊天下限 | 450px，侧栏优先让出空间 | [work-panel-resize.ts:6](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/lib/work-panel-resize.ts#L6) |

**参数推导，非运行测量：**1280px 窗口按默认宽度分配时，侧栏约 21.5%，右面板约 28.1%，聊天余约 50.4%；1440px 时聊天余 805px，接近内容带；1920px 时聊天区域增宽，但正文仍受 760px 阅读宽度约束。

值得借鉴的是固定窄侧栏、正文与输入区对齐、统一顶栏节奏和面板空间预算。自动折叠侧栏的具体阈值不直接继承：pi-GUI 已有 dock/overlay、split 回退和 Browser 原生视图边界，必须按自己的状态机与窗口预算设计。

## 4. 侧栏的密度、层级与点击稳定性

源码会话行最小 28px，标题 13px、单行省略；分组主要靠字级、缩进和间距建立层级。日期与 hover 操作菜单在一个 grid 槽位叠放，通过 opacity/visibility 切换，保留宽度。这比 hover 后新增按钮更能保证鼠标目标稳定。

来源：[sidebar-threads.css:7](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/sidebar-threads.css#L7)、[sidebar-threads.css:47](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/sidebar-threads.css#L47)。项目折叠使用 grid 行高过渡，hover、focus-within、菜单打开时共用状态规则。

pi-GUI 建议：会话行预留菜单槽；选中不增加外边框、不改变高度、不通过大幅加粗挤压文字；激活会话不修改排序键，只有真实更新或用户排序操作才改变序列。PI-Desktop 自身存在近期、手动、项目等排序能力，因此不能将它描述为永不重排的产品。

## 5. 字体、颜色、边框、圆角和图标

参考设计文档明确把 Codex 桌面作为视觉基线。研究价值是它如何将视觉规范落到组件与状态，而非要求 pi-GUI 复制其产品身份。

| 项目 | 当前源码与使用规律 |
| --- | --- |
| 深色 | 主面 #181818、侧栏底 #000000、次级 #212121 |
| 浅色 | 主面 #ffffff、侧栏 #f3f3f3、工作面板 #fafafa |
| 强调 | 中性灰阶；状态、错误和 diff 才使用语义色 |
| 字体 | 系统 sans，Windows 为 Segoe UI；代码使用系统 mono/Consolas 等 |
| 字号 | 正文 14px、会话标题 13px、次级 12/12.5px |
| 行高 | 聊天 1.55、长文 1.6 |
| 圆角 | 4–24px 阶梯；composer 20px，紧凑控件较小 |
| 图标 | 通过统一 icons.tsx 封装 Lucide React |
| 阴影 | 浮起层负责；浅色 dialog 阴影 alpha 0.12，深色更强 |

来源：[tokens.css:16](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/tokens.css#L16)、[tokens.css:222](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/tokens.css#L222)、[tokens.css:337](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/tokens.css#L337)、[icons.tsx:107](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/components/icons.tsx#L107)、[设计原则文档:10](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/docs/spec/04-ux/07-ui-design-system.md#L10)。

页内靠表面明度、文字与间距组织，边缘与阴影主要给菜单、dialog、tooltip；字段聚焦时表面提升并显示焦点环。深浅主题共用语义和几何，分别调整明度与阴影。

pi-GUI 适配建议：系统字体优先，避免为设计稿下载新字体；可把 composer 调为 12–14px、按钮 6–8px，以更紧凑的专业工具感比较另一种方向。不要不加区分地继承全部胶囊与 20px 圆角。状态色应有文字/图形双重线索。

## 6. 输入框、模型与推理

当前模型与推理选择已经整合为一个入口；官方旧图的二级菜单不能完整代表当前组件。当前代码以模型名为主要信息、推理 badge 为元信息；向上、右对齐展开，焦点进入搜索框。搜索覆盖供应商、模型和别名，默认优先最近 3 个模型。供应商必须启用且有凭据或无需认证才进入可用组。

推理变更使用最新值提交队列，避免连续滑动旧请求反写。窄输入区先隐藏推理说明，再截断模型名，最后才收为带完整 accessible name 的图标。模型触发器 pressed 时不缩放，防止测量到变形后的菜单锚点。

来源：[ComposerModelPicker.tsx:63](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/features/chat/composer/ComposerModelPicker.tsx#L63)、[useComposerModelMenu.ts:91](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/features/chat/composer/hooks/useComposerModelMenu.ts#L91)、[responsive.css:46](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/responsive.css#L46)、[composer-menus.css:155](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/composer-menus.css#L155)。

浮起输入框的实际高度必须计入聊天滚动区预留；多行、附件增长后末条消息仍可滚动到它上方，不能仅加一层不透明遮罩掩盖内容。空会话与已有会话共享组件和内容宽度。

pi-GUI 应借鉴信息压缩与布局稳定规则，不添加参考项目特有的权限模式、图片生成、增强提示词或 fast tier。推理能力三值与权威回读继续由 pi-GUI 现有模块决定，设计不能凭静态 reasoning 字段推定档位。

## 7. 菜单、弹窗、Tooltip 与键盘

`AnchoredMenu` 展示了可维护的统一浮层合同：

1. portal 到 body 的 fixed 层，避开父 overflow 裁切。
2. 先测量后显示，避免左上角闪现。
3. viewport 边距 8px，锚点间隔 6px，优选方向放不下则翻转，最后钳位。
4. 使用布局尺寸，避免入场 transform 污染锚点计算。
5. 触发器滚出视口后关闭，ResizeObserver 跟踪尺寸。
6. 外部点击关闭；Escape 捕获后消费，只关闭当前菜单，不穿透关闭父 dialog。
7. 关闭恢复触发器焦点；搜索菜单初始聚焦 input，选项菜单聚焦当前项。
8. 右键菜单支持上下键、Home/End；初始聚焦 preventScroll，避免滚动又触发关闭。

来源：[AnchoredMenu.tsx:1](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/components/settings/AnchoredMenu.tsx#L1)、[AnchoredMenu.tsx:137](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/components/settings/AnchoredMenu.tsx#L137)、[ContextMenu.tsx:318](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/components/ContextMenu.tsx#L318)。

pi-GUI 原型必须实际覆盖底部模型 picker、侧栏靠近底边右键菜单、dialog 内 dropdown、窗口 resize 后定位与焦点恢复。可取其合同，不复制 TSX 实现。

## 8. 长会话、工具时间线与状态恢复

当前源码规定草稿按 session 缓存在 renderer 内存，文本和附件引用一起恢复，覆盖 chat/settings/plugins 及 composer remount；完整 renderer reload 后清空，不是持久草稿。最近 3 个会话保留 DOM、阅读位置与行窗口；隐藏项用 absolute、visibility/content-visibility hidden，避免布局盒子消失带来跳动。隐藏会话不追流式尾部。

活动过程默认展开，已完成且用户未主动操作的过程默认收起；工具 payload 不自动展开；外层过程重新展开时恢复子组选择。长历史有 earlier loading、导航 loading、jump latest 和 minimap 等不同状态。

来源：[composer-draft-cache.ts:13](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/lib/composer-draft-cache.ts#L13)、[session-panes.ts:3](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/lib/session-panes.ts#L3)、[chat-shell.css:76](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/chat-shell.css#L76)、[TurnProcess.tsx:88](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/features/chat/transcript/TurnProcess.tsx#L88)、[ToolRow.tsx:196](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/features/chat/transcript/ToolRow.tsx#L196)。

可复用原则是“阅读位置由用户持有”“草稿归属明确”“过程摘要先行、详情渐进展开”。不得把参考项目的 React/store/DOM 保留机制作为 pi-GUI 架构重写理由。历史工具摘要展示仍遵守 pi-GUI 现有脱敏和来源边界。

## 9. 右工作面板与窗口原生区域

工作面板为 in-flow dock，不覆盖主聊天。文件、审阅、浏览器与插件 view 共用外壳；标题 46px，与主顶栏对齐。Windows/Linux 为窗口控制额外预留 120px，避免 Electron drag region 吞点击。resize 热区 10px，视觉把手 2×32px，仅在 hover/focus/drag 显示。

打开动画同时改变分配宽度与轻微位移，避免 flex 瞬间占满空间后只做 transform。面板上下文随会话保留；Agent 或工具结果不主动打开、切换或 resize 面板。关闭最后一个标签仍保留面板并显示 launcher。

来源：[work-panel.css:8](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/work-panel.css#L8)、[work-panel.css:94](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/work-panel.css#L94)、[01-ui-ia.md:100](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/docs/spec/04-ux/01-ui-ia.md#L100)。

pi-GUI 可统一标题、操作与空态，但 Browser WebContentsView、Changes authority、Specs 编辑、分屏回退均继续归现有所有者管理。不能用视觉统一暗示这些资源已有相同销毁语义。

## 10. 市场、设置、通知和错误

市场以页面、soft tile、raised control 三种层级代替密集分割线；当前网格最小 340px。截图中的内容顺序稳定：名称、作者/版本、简介、权限摘要、状态/操作。已安装、可更新、尚无安装包不是同一个安装按钮。

来源：[plugins.css:7](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/plugins.css#L7)、[plugins.css:285](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/plugins.css#L285)。

设置是完整目的地，分类可搜索，字段高度统一。pi-GUI 可借鉴页面组织，不添加参考项目独有市场、目录 source、voice、automations 或 import。

通知当前代码按 message + variant + sessionId 去重并封顶；hover 或键盘 focus 暂停自动消失；error/warning 使用 alert，其余使用 status。来源：[interaction-slice.ts:225](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/stores/slices/interaction-slice.ts#L225)、[Toast.tsx:38](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/components/Toast.tsx#L38)。

官方图里顶部三层 toast 与 99+ 通知也提示应谨慎取舍：容器一致值得采用，数量和干扰强度不必继承。pi-GUI 失败反馈应留在错误发生处，提供重试或恢复路径；短暂 toast 不应替代可恢复状态。

## 11. 动效、滚动与减弱动态

当前 duration 为 fast 150ms、normal 200ms、slow 300ms，分别使用 ease-out/ease-in/standard。reduce-motion 保留最终状态和滚动目标，取消位移、缩放与循环；部分退出动画用近零时长保留 animationend 的卸载路径。

来源：[tokens.css:210](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/tokens.css#L210)、[responsive.css:116](https://github.com/vastsa/PI-Desktop/blob/c85251b7d968c21fbf0f07fb515bdc31ada49399/apps/desktop/src/styles/responsive.css#L116)。

pi-GUI 原型建议 100–160ms hover/menu、180ms 面板；菜单 anchor、会话行、tab 不使用引起位移的按压缩放。自动追尾仅在用户处于底部时发生，用户向上阅读后展示新内容计数和回到底部入口。

## 12. pi-GUI 已有抽象：后续必须优先复用

以下是在当前 pi-GUI 源码与设计文档中读到的既有合同，不是本次新设计的成果，也不等于本次重新验证其所有分支。

| 已有抽象 | 已存在的价值 | 后续设计约束 |
| --- | --- | --- |
| `public/ui/popover.js` | Model/Thinking/Context 共用定位和焦点恢复 | 先统一 token/尺寸，再核对边界；不另造每个 picker 的定位系统 |
| `public/composer.js` 的 ResizeObserver | 测量输入区高度，给滚动区预留；多行有视口上限 | 保持已有节点和 IME/发送/停止语义 |
| `ui/workspace-surface.js` | 切换一级工作视图时保留 Chat/Composer DOM 和流式写入 | 不以整页重建替代页面切换 |
| `ui/secondary-surface.js` + `ui/split-workbench.js` | 右栏外层实例、业务 mount/dispose、分屏只管布局 | 统一外观不重写资源所有权 |
| `right-pane.js` / Browser 原生视图控制 | 宽度记忆、dock/overlay、viewport 与原生几何转换 | Windows zoom/DIP 校验独立保留 |
| 会话导航与现有排序修复 | 活跃状态与会话身份有既有管理路径 | 激活、运行、置顶、排序必须保持明确语义 |

本地依据：[composer-ui.md](../../../docs/composer-ui.md)、[work-surfaces.md](../../../docs/work-surfaces.md)、[conversation-ui.md](../../../docs/conversation-ui.md)、[app-shell.md](../../../docs/app-shell.md)。特别是 `docs/work-surfaces.md` 首段“当前右栏工作区”已经说明 Browser/Specs/Changes 的最新承载，与后面的历史 P14-D 不能混用。

## 13. 采用、适配、排除与对原型的要求

### 采用原则

- 中性表面层级、统一顶栏与控件节奏、正文和输入区同轴。
- 稳定的会话操作槽、选中不位移、焦点和 disabled 明确。
- viewport-safe 浮层、Escape 只关最上层、关闭恢复焦点。
- 会话拥有草稿、阅读位置、运行与面板上下文。
- 工具摘要先行，后台输出不抢面板、不抢滚动。
- 深浅主题共用几何与组件合同，语义色克制。

### 适配到 pi-GUI

- 比较较柔和的内容工作室与更紧凑的开发工作台；用真实长内容比较，不只换颜色。
- 保留 Classic/Runtime 差异、原生 thinking 权威回读与历史摘要隐私约束。
- Tasks、Skills、Extensions、MCP 使用真实资源入口，不包装成不存在的统一市场。
- 统一 Work Panel 外壳，不统一本来不同的销毁和写入权限。
- 面板压缩时优先截断描述，保留发送、停止、关闭与当前模型可识别性。
- 权限、更新、恢复等危险动作保留原有严肃说明，视觉不能淡化风险。

### 明确排除

- PI-Desktop mascot、logo、品牌名称和未经许可素材。
- 为模仿而加入 voice、自动化、图片生成、prompt enhance、fast tier 等无真实能力入口。
- React/Zustand/Rust host 技术方案移植、对外部 pi 的打包/patch 模式。
- 将旧截图标为当前实测，将源码存在标为本机操作通过。
- 把这些研究结论当成 pi-GUI 的生产实施、提交、推送或合并授权。

### 原型必须体现的可检查场景

1. 空会话、正常聊天、运行中和长工具链均有真实样例内容。
2. 切换会话不改变行位置；草稿、阅读位置与运行状态按明文合同恢复。
3. 模型 picker 可搜索、选中、键盘操作，在窗口边缘不溢出。
4. 右面板打开、关闭、resize 后正文仍可读，输入区不被遮挡。
5. 弹窗内菜单正确分层，Escape 逐层关闭并返回焦点。
6. 错误、loading、disabled、空态分别有可识别反馈。
7. 深浅主题与 reduced motion 都实际渲染，1280×800、1440×900、1920×1080 有真实截图。

本报告完成的是参考研究；pi-GUI 原版审计、改版截图与交互验证应在各自报告中单独给证据。
