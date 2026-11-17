# pi-GUI 全项目图标整改验收

基线为 `main` 的 `e6a47642f358dabbef191292659d922da45c0c60`，已合入第三批 UI 整改。[基线 main push CI](https://github.com/HYJ1817/pi-gui/actions/runs/43603781639) 通过。独立分支为 `codex/ui-icon-unification`，代码与回归测试提交为 `bb2d6427e09c8c5a1c4a1c0249d9f7e6c74b0309`。报告提交用 `git log -1 --format=%H -- docs/ui/PI-GUI-UI-ICON-ACCEPTANCE.md` 定位。

依据为[全局设计规范](design-system.md#图标与-pi-desktop-参考)与[全项目 UI 审计](PI-GUI-UI-FULL-AUDIT.md)。工作区在切分支前干净，核对了开放 PR 与本机 worktree。

## 盘点与公共实现

扫描基线 `public/` 中 186 个非 vendor 的 JS、CSS、HTML、SVG 文件，另核对原生应用资源边界。基线有 95 处 SVG 起始标签或直接构造写法，整改后有 51 处，其中包含静态图标占位和明确保留的 SVG。计数是源码声明及构造位置。审查同时查找独立映射、硬编码颜色、字符键帽或图标、可访问名称和角色尺寸。按文件的前后计数及 68 个语义名称见 `source-inventory.json`。

公共入口为 [public/ui/icons.js](../../public/ui/icons.js)。用 `createIcon('search')` 生成装饰 SVG，需要贴合小字号时可指定 `size` 或让既有容器样式定义角色尺寸。静态 HTML 使用 `<svg data-icon="search">`，应用启动时填充。已有可信字符串模板用 `iconMarkup('search')`。字符串入口仅接受本地映射中的名称，未登记名称返回空串。Provider、MCP、侧栏菜单及工具时间线沿用各自既有的渲染接口，共享图形定义。

| 界面 | 统一的图标和语义名 |
| --- | --- |
| 导航、项目、会话 | `conversation`、`search`、`settings`、`sun`、`folder`、`task`、`book`、`layers`、`sidebarExpand`、`sidebarCollapse` |
| Classic、Runtime、模型选择 | `plus` 附件、`arrowUp` 发送、`stop` 停止、`copy`、`chevronRight`、`check` 选中。保留已存在的模型和思考文字、上下文进度环。 |
| 设置、Provider、MCP | `search`、`plus`、`edit`、`trash`、`refresh`、`key`、`lock`、`help`、`external`、`server`、`scan`、`market` |
| 右侧工作区、Browser、Terminal、Files、Worktree、Collab | `panel`、`grid`、`globe`、`terminal`、`pin`、`folder`、`file`、`fileText`、`changes`、`branch`、`diagram`、`split`、`exitSplit` |
| 菜单、弹窗、反馈、Planner | `more`、`close`、`chevronLeft`、`chevronRight`、`chevronDown`、`archive`、`restore`、`check`、`warning`、`info`、`pending`、`progress`、`pause` |

图形来源为本仓库基线中的动作菜单、Provider、MCP 和应用 HTML 等本地实现，按仓库 MIT 许可使用。分屏与退出分屏由本地面板几何组合，保存在公共映射中。核对了 IconMCP 官方入口和许可页，当前工具无 IconMCP 连接器，公开检索未返回可核验的分屏候选。实际交付没有采用 IconMCP 或其他第三方图形。全部图形随公共 ESM 模块安装，无外部请求或新增运行依赖。[仓库许可](../../LICENSE) · [IconMCP 图标库](https://iconmcp.com/) · [Agent 接入](https://iconmcp.com/agents) · [许可说明](https://iconmcp.com/licence)

## 尺寸、对齐和例外

- 公共图标为 24×24 viewBox，普通角色默认 16px，描边 1.7、圆角线帽与连接、`currentColor`。顶栏实测由 15px 到 16px，命中区仍为 28×28。Classic 发送图标从 15px、2.0 改为 16px、1.7，附件从 15px 改为 16px，点击区仍为 28×28 与 26×26。Runtime 发送和停止共享同一语义图形及 16px、1.7。
- 设置帮助为 13px，文件树紧凑标记为 12px，工作面板启动卡为 20px。其他紧凑或空状态尺寸继续由既有容器控制。三点用实心点表达同一个动作，成功、失败和等待保留文字状态。纯装饰 SVG 设 `aria-hidden` 与 `focusable=false`。
- 应用 Logo、欢迎页品牌标识、原生窗口按钮、任务栏和安装图标留在原边界。保留图表、流程图节点和可交互连线、上下文进度环、动画及纯 CSS 加载状态。文件内容的附件类型图形与原生 Select 下拉提示继续由各自的组件持有，快捷键符号和用于内容阅读的标点保留。

## 真实渲染与交互证据

使用 Windows Chrome 157，DPR 1，在 1320×820 和 700×600 分别检查 Dark、Light。基线实际加载从基线提交归档的 `public/`。使用项目视觉夹具和 CDP 键盘、鼠标事件，记录导航、两个 Composer、设置、Provider、MCP、模型选择器、工作面板、Browser、Terminal、Files、Worktree、Collab、菜单及对话框。Planner 另采集。核对 SVG 是否存在内容、显示尺寸和描边、命中区、键盘焦点及维护后的名称。

截图和 JSON 存于 `%TEMP%/pi-gui-icon-evidence`，对照图、探测脚本和日志汇总在 `pi-gui-icon-visual-evidence.zip`。

- `settled-before-navigation-700-light.png` 与 `settled-navigation-700-light.png`，窄窗导航。
- `verified-before-classic-1320-dark.png` 与 `verified-classic-1320-dark.png`，Classic 输入区。Runtime 与模型选择见 `verified-runtime-700-dark.png`、`verified-picker-700-dark.png`。
- `verified-before-settings-700-light.png` 与 `verified-settings-700-light.png`，设置。帮助、Provider 模态与 MCP 见 `verified-help-700-light.png`、`verified-dialog-700-light.png`、`verified-mcp-700-dark.png`。
- `browser-before-browser-loading-700-light.png` 与 `browser-final-browser-loading-700-light.png`，Browser 加载。Terminal 和 Files 分别见 `verified-terminal-700-dark.png` 与 `verified-files-700-dark.png`，对应基线文件前缀为 `verified-before-`。
- `secondary-menu-700-dark.png`、`secondary-worktree-700-dark.png`、`secondary-planner-700-dark.png`，菜单、工作区行和 Planner。协同文档见 `settled-collab-700-light.png`。

使用 `verified.json` 和 `verified-before.json` 的 44 个场景记录，合并 `browser-final.json` 和 `browser-before.json` 的各四项补测。Browser 通过离线桥接验证后退/前进禁用、刷新与加载图标、Enter 停止。Terminal 实际验证了不可用态工具栏和禁用控件，正常终端动作依定向 UI 测试。首次探测有旧定位、夹具缺方法及点击落空，保留原始 JSON。等待项目行稳定并以 Enter 打开菜单后，基线和变更版的 Escape 回焦均为 4/4，见 `keyboard-before.json` 和 `keyboard.json`。另以 `settled*.json` 补采主题稳定后的导航与协同文档，以 `secondary*.json` 记录 Worktree 和 Planner。检查了共享帮助 Escape 回焦、模态入口和两种 Composer 的可见焦点。真实 Native Browser WebContents、交互式 PTY、Windows 安装与主题系统高对比未在本轮渲染。

## 测试、复核与构建

运行现有定向套件。新增公共原语图标断言验证静态填充和动态 SVG 一致、装饰语义、描边及非法名称。Smoke 的旧字符断言改为实际 SVG 开合状态。安全检查只从指定位置移除与公共图形完全一致的节点再扫描其余内容。早期试跑的旧断言误报及 20ms 等待波动均保留，最终 Smoke 通过。

| 测试 | 结果 |
| --- | --- |
| Primitives、Settings、Provider UI | 6 组、18/18、79/79 |
| MCP 管理、MCP 市场、Theme | 31/31、72/72、47/47 |
| Classic Composer、模型选择器、Runtime UI | 34/34、54/54、106/106 |
| 动作菜单、Browser UI、Files/Terminal UI、Worktree UI | 37/37、24/24、95/95、16/16 |
| Collab 画布、Collab 面板、反馈、Planner | 72/72、12/12、27/27、124/124 |
| Smoke | 1345/1345 |

独立只读复核以当前改动和真实 Chromium 验证了填充顺序、来源名称、可访问性、点击区和角色大小，发现的 Composer 线宽、Browser 分屏字符和通知图标遗留已处理。无已知未修复的阻断发现。

使用 `npm run build:app -- --rebuild --output-root <独立目录>` 离线重建 Windows 应用，复用 Electron 44.4.3 本地缓存，整包 333.4 MB。包内 45 个改动的前端资源 SHA-256 与源码一致。产物位于证据目录的 `build-delivery/dist-app/Pi GUI-win32-x64`，日志为 `build-delivery.log`。

## 修改文件与交付

- 公共图标、设置、按钮和浮层涉及 `public/ui/icons.js`、`app.js`、`index.html`、`styles.css`、`ui/action-menu.js`、`ui/primitives.js`、`ui/primitives.css`、`ui/settings-surface.js`、`ui/fallback-settings.js`、`ui/popover.js`。
- 导航、工具、消息、Composer 和 Planner 涉及 `projects.js`、`project-config.js`、`sessions.js`、`session-search.js`、`util.js`、`tool-view.js`、`plan-view.js`、`planner.js`、`attachments.js`、`messages.js`、`markdown.js`、`scroll-button.js`、`runtime-conversation.js`、`runtime-conversation.css`、`ui3-composer.css`、`ui/message-actions.js`。
- Provider、MCP 和工作面板涉及 `provider-management/dom.js`、`mcp-shared.js`、`browser-pane.js`、`terminal-panel.js`、`terminal-tabs.js`、`files-panel.js`、`git.js`、`diff.js`、`worktrees.js`、`specs-panel.js`、`specs.css`、`runtime-secondary.js`、`ui4-pane.css`、`ui/secondary-surface.js`、`ui/split-workbench.js`、`ui/work-panel-launcher.js`。
- 反馈涉及 `ui/notice.js`、`ui/toast.js`、`ui4-feedback.css`。测试涉及 `tests/primitives.cjs`、`tests/smoke.cjs`。含本报告共 48 个文件。

回滚时依次回退报告提交、`bb2d642`，再重建同样的应用产物，无用户数据迁移。已具备人工验收材料。合并验收仍待当前分支 PR 的完整 CI 及人工确认。未运行完整本地 `npm test`、已打包应用启动和安装升级。

## 后续变更：侧栏切换图标（2026-11-17）

侧栏的收起/展开两个图标改用 Lucide `panel-left-close` / `panel-left-open` 的几何，仍内嵌在 [public/ui/icons.js](../../public/ui/icons.js) 的受控映射中，不引入运行依赖、外部请求或运行时 SVG 注入。来源：[panel-left-close](https://lucide.dev/icons/panel-left-close)、[panel-left-open](https://lucide.dev/icons/panel-left-open)，许可 ISC，取得日期 2026-11-17。其余图形与上文盘点不变；上文「未采用第三方图形」的结论仅对应原验收提交。
