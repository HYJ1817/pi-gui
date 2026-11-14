# pi-GUI 设计系统现状审查

日期 2026-11-13。代码基线为 `origin/main` 的 `9ddf0aa1018481616ce9fdc32a2ea7671237ef8c`，工作区为独立文档 checkout。该 SHA 的 main push CI 第 1 次尝试 8/8 检查成功，含 UI、Electron build check 与 CI gate。[基线 CI](https://github.com/HYJ1817/pi-gui/actions/runs/43448003847)

[全局 UI/UX 设计规范](design-system.md) 是当前标准。下文的实现快照、发现和建议均绑定上述基线。

## 审查范围与复用结论

| 范围 | 基线证据与结论 |
| --- | --- |
| Agent 约束 | 受跟踪的仓库入口为 [AGENTS.md](../../AGENTS.md) 和 [CLAUDE.md](../../CLAUDE.md)。Codex 已读 AGENTS，Claude Code 用 `@AGENTS.md` 导入。基线无 Gemini、DeepSeek 或其他客户端专属的项目指令文件。本次新增 [GEMINI.md](../../GEMINI.md) 用 Gemini CLI 的相对导入；使用 DeepSeek 等模型时，由实际宿主加载 AGENTS，通用交接可直接链接 AGENTS。 [Gemini CLI 导入说明](https://geminicli.com/docs/cli/gemini-md/#modularize-context-with-imports) |
| 既有规范 | PI-Desktop 参考档案已有 01–19 号材料和参考 CSS，涵盖 Token、布局、组件、交互、阶段路线及历史视觉验收。Refined 设计目录含原型 Token 和样式。外壳、Composer、会话与工作区文档含业务和阶段细节。旧索引仍有「后续开发 Agent」和固定参考截图尺寸，已从当前开发阅读路径移除这种指令性表述。 [PI-Desktop 档案](pi-desktop-reference/README.md) · [Refined 归档](../../designs/ui-ux-2026-10-31/README.md) · [外壳](../app-shell.md) · [Composer](../composer-ui.md) · [会话](../conversation-ui.md) |
| CSS 与 Token | 盘点了 `public/` 的 22 份非 vendor CSS（含原语），并查了主入口的样式顺序和代表选择器。Token → 原语 → `styles.css` → 功能样式的层叠会影响最终值。`--ds-*` 提供主要语义，`--ui-*` 与短别名继续服务旧实现。现有字体、行高、状态色、阴影、圆角、动效及 4–32px 间距足以承接规范，无需增加一份 Token 表或主题文件。 [主入口](../../public/index.html) · [Token](../../public/tokens.css) · [公共样式](../../public/ui/primitives.css) |
| 深浅主题 | `theme-init.js` 在首屏前决定 `data-theme` 和字体偏好，`theme.js` 与 Electron 主题桥同步偏好与解析结果，Token 同步设置 `color-scheme`。凭据窗口用隔离的内联样式，终端有 ANSI ramp，外部 Browser 内容由原生视图持有。 [首屏主题](../../public/theme-init.js) · [主题入口](../../public/theme.js) · [Electron 主题](../../electron/theme.cjs) · [隔离凭据窗口](../../electron/provider-credential-page.cjs) |
| 按钮、表单、搜索 | `.btn`、`.icon-btn`、`.modal-input` 在 `styles.css`，`.ds-input` / `.ds-select` 在公共样式，Select 有后置覆盖。搜索在设置、会话侧栏和 Provider 中有各自外壳。`createSettingsToggle` / `createSegmentedControl` 现有且有 ARIA 语义，复选框有原生实例。审查范围内的公共 JS 没有单独的 Input、SearchInput、Textarea 或 Checkbox 工厂。 [通用样式](../../public/styles.css) · [原语](../../public/ui/primitives.js) · [供应商样式](../../public/provider-management.css) |
| 菜单、弹层、列表、标签 | `openActionMenu` 支持方向键与回焦。Composer Popover、模型选择和行内命令保留各自所有者。Modal 与确认层复用 `modal.js`，工作面板由既有 surface 管理。卡片/行/Badge 有设置原语，Tabs 在扩展、日志、Planner、终端等已有表面实现。 [动作菜单](../../public/ui/action-menu.js) · [Popover](../../public/ui/popover.js) · [Dialog](../../public/ui/modal.js) · [工作区](../../public/ui/workspace-surface.js) · [原语](../../public/ui/primitives.js) |
| 反馈 | Toast 与常驻 Notice 有公共入口，反馈 CSS 提供若干表面上的空态、加载和错误样式。Approval、Runtime、Provider 等保留各自的状态来源。`toast.js` 有反馈去重和普通成功/信息抑制逻辑。 [Toast](../../public/ui/toast.js) · [Notice](../../public/ui/notice.js) · [反馈样式](../../public/ui4-feedback.css) |
| 图标 | 主界面使用内联 SVG 与部分局部映射，`styles.css:115` 提供 `currentColor` 默认值，`action-menu.js:39` 提供菜单 SVG 基础属性。可在已有映射中复用同义图标，暂无引入图标运行时依赖的理由。IconMCP 官网公开页面标示 MIT，单个图标纳入仓库时仍需记录来源及许可。图标集页面依赖 JavaScript，未核对其中单个图标。 [IconMCP](https://iconmcp.com/) · [许可](https://iconmcp.com/licence) |

PI-Desktop 的 46px 顶栏、275px 导轨和 28px 紧凑控件能在 pi-GUI 的现有 Token 找到对应。中性色调、设置行分组与紧凑动作可以沿用这批共同尺度。设置 Select 的 34px 高度、工作面板的布局、Runtime/Classic 的状态归属和各自的原生窗口行为，依 pi-GUI 的实际实现和业务约束维护。 [参考布局](pi-desktop-reference/04-layout-specification.md) · [运行时 Token](../../public/tokens.css) · [工作面板契约](../work-surfaces.md)

## 已有差距与后续实施建议

这些均为基线发现，按后续工作优先级排列。

| 优先级 | 证据、触发与影响 | 后续验证与实施建议 |
| --- | --- | --- |
| 1 · 键盘焦点叠加 | **实测。** 外观页从「主题」帮助图标按 Tab 到主题 Select。浅色宽、窄窗以及深色窄窗，边框和 2px outline 同时使用焦点色。深色宽窗该轮为中性边框加白色 2px outline。源头为 `primitives.css:337` 的字段焦点边框与 `styles.css:42–46` 的键盘轮廓。 | 在公共字段族实现一道可见指示。复测宽窄、深浅、鼠标和真实 Tab，再覆盖设置/会话/Provider 搜索和弹窗字段。 |
| 1 · 两套焦点变量和局部规则 | **源码确认。** `tokens.css:92,211,371,444,560` 可见中性 `--ds-focus`、蓝色 `--ui-focus` 和衍生 glow；`styles.css:826,3280,3402` 分别使用旧全局 outline、菜单背景式焦点、Browser 地址框 glow。`provider-management.css:143,183,203` 同时定义字段/容器焦点与弹层轮廓。`ui3-composer.css:15` 去除 textarea 轮廓，外层在同文件为零边框。可见程度、颜色和遮挡尚需逐场景实测。 | 从公共字段和菜单入口归并至 `--ds-focus`。逐个核对复合输入的内部焦点、滚动裁切、错误叠加及强制颜色模式。原生 Browser 独立跑 Electron。 |
| 1 · 帮助提示无法点击展开 | **源码确认，入口可见。** `primitives.js:112–121` 构造可 Tab 的 `span[role=note]`，说明挂在 `title`，没有激活行为。外观页主题和字体旁都可见。 | 对需点击展开的帮助内容，复用有名称的按钮和 Popover，验证键盘开关、Escape 和回焦。把必要字段说明保留在正文附近。 |
| 2 · 通用控件存在样式分叉 | **实测及源码确认。** 外观页 Select 34px / 13px，分段项 26px / 12.5px，属于不同角色。跨功能的同类文本按钮则分别由 `styles.css:806` 的 30px `.btn` 与 `provider-management.css:73–105` 的 `.pm-btn` 族维护；搜索也由 `styles.css:2093,2675` 与 `provider-management.css:171–194` 分别维护。CSS 盘点中专用 `:active` 写法少于 hover/disabled，需检查原生按下与共享样式覆盖。 | 先在小范围统一同角色按钮和搜索字段的公共样式，保留业务变体。按角色核对高度、字重、边界、焦点、禁用、忙态和错误后再扩面。 |
| 2 · 可移入帮助的说明 | **实测。** 外观页标题下显示「自定义界面主题与字体排版偏好」，下方再说明「仅改变界面外观；System 随系统主题变化」；同屏已有主题、字体及字体大小字段。`settings.js:18,149`。设置容器还支持按页面渲染描述，`settings-surface.js:62`。 | 逐页审查常驻说明。优先清理重复定义，把系统主题含义就近放入帮助，同时保留必要操作、输入限制与安全文案。 |
| 2 · 状态语义与对比度待扩测 | **源码确认有多套样式，覆盖待验证。** `tokens.css` 同时维护新旧语义色，`provider-management.css:142,194,438` 在浅底可能使用浅色主题的 `--ds-text-faint`。日志、原生对话框、Diff、终端和 Collab 未逐状态测色。 | 按实际表面取样，核查字段边界、placeholder、状态字、选中与错误焦点。把仍需显示的内容移到合适语义色，对有意义的色彩差异保留文本标记。 |
| 3 · 英文验收路径 | **源码确认。** `public/index.html:2` 为 `zh-CN`，已查主入口和设置页面未找到全局语言切换入口。 | 后续用离线夹具覆盖代表性的中英文名称和长标签，并单列验证范围。 |

## 当次验证与复核边界

- Windows 上用 Chrome 157.0.8103.78、DPR 1 和 `node tests/visual-harness.cjs` 渲染实际 `public/`。夹具绑定 loopback，使用临时上传目录和浏览器配置。外观页 `#navAppearance` 在 1320×820 与 700×600 的深浅四组均截图，使用产品主题模块切换，截取主题字段键盘焦点。查看了代表截图。证据保存在本机临时目录，由交付消息提供链接。
- 复查方法为打开离线夹具，进入设置的「常规」，切换主题后把焦点放到「主题」旁的帮助图标，再按 Tab。检查可见 Select 的计算样式 `border-color`、`outline-style`、`outline-width`、`outline-color` 和 `:focus-visible`。主题色按当时渲染值记录。
- 本轮真实渲染限外观页和主题下拉焦点。英文夹具、其他页面的完整状态矩阵、强制颜色、原生 Electron、打包产物和真实模型未运行。设计系统审查中的源码发现仍需按表中范围复测。PI-Desktop 对照采用仓库已归档的参考证据，外部固定 commit 页面本轮未重新获取。
- 本轮交付范围仅 Markdown。按 [测试政策](../testing.md#测试执行政策) 用 diff、链接和事实检查验收文档，跳过完整 `npm test` 和构建。现有代码基线 CI 作为来源记录。人工验收待定。
