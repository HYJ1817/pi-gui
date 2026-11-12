# P14-D Stage Work Surfaces

本文负责 UI 工作区的承载、生命周期与布局约束。开发/审查规则见
[AGENTS.md](../AGENTS.md) 和 [REVIEW.md](../REVIEW.md)，其他任务入口见 [文档导航](README.md)。

## 当前右栏工作区（T2-A / T2-B）

PI-Desktop 阶段 E 将原空白 `rp-titlebar` 与 `#workPanelNav` 合为同一条 46px 工具带；保留 `rp-titlebar` 类作为原生标题栏验收的定位接口。工具带按实际原生 caption 区域结束拖拽矩形，28px 控件及选中标签可横向滚动；选中状态仍来自各工具 owner，更新后仅滚动到当前项。右栏默认 392px、最小 320px、宽度记忆、dock/overlay 与分屏比例都由原模块持有。

“工作面板”打开的是工具列表，选择入口委托既有按钮；“选择工具”返回列表，不承诺创建任意独立标签。列表观察原按钮的 hidden/disabled/标签属性，离开时释放观察器。起始页是「工具」卡片网格，固定两列四格：变更、终端、文件、更多工具…；浏览器、Specs、分支树、协同文档收在默认折叠的「更多工具…」里。卡片只克隆原按钮图标并委托点击，快捷键提示从 `public/shortcuts.js` 的唯一注册表读取：`Ctrl+Shift+G` 变更、``Ctrl+` `` 终端、`Ctrl+P` 文件。没有推荐区。Specs 仍使用自己的文档树、Markdown、空态与只读边界。

终端与文件是右栏里的两个真实 surface，入口按钮、快捷键和起始页卡片走同一条 `openSecondarySurface` 生命周期：

- **终端**：项目级 PTY（node-pty，Windows 走 ConPTY），前端为 xterm。Windows 默认绝对路径 PowerShell，缺失时回退绝对路径 CMD；POSIX 用 `$SHELL`，统一以 `TERM=xterm-256color` 启动。只有桌面版（本地令牌边界）或显式 `PI_GUI_ENABLE_TERMINAL=1` 时启用；cwd 来自聚焦会话的 workspace identity，Renderer 不传 shell、cwd、参数或环境变量；`start` / `read` / `input` / `resize` / `stop` 全部按 workspace 校验，跨工作区返回 409。输入拒绝 NUL 与超长、按原始字节写入且不追加换行；输出保留 ANSI/CR 原文、只在内存保留上限内的尾部、不写日志；`cols` / `rows` 有范围校验。每个工作区复用一个活动会话，达到并发上限时显式拒绝而不是杀掉用户其它终端。关闭面板只销毁 xterm 前端，后端继续运行并在重开时重放缓冲；只有显式停止、工作区变化、空闲超时或服务关闭才结束整棵进程树（Windows `taskkill /T`）。源码运行与打包产物都必须带 node-pty 原生模块（`resources/app/node_modules/node-pty` / `build/node_modules/node-pty`）。
- **文件**：只读项目文件树与文本预览；按目录懒加载，跳过符号链接/junction 与隐藏项（除非用户显式显示），正文上限 256 KiB，二进制只标注不预览。没有写入、删除、重命名或上传入口。

参考文件管理器的任意文件编辑、最大化及拖放不属于该阶段。实际证据与未验证边界见 [阶段 E 实施记录](ui/pi-desktop-reference/16-phase-e-implementation.md)。

2026-11-01 Refined 工作区将会话顶栏的 Changes、Specs、Browser 等按钮移入右栏内的持久导航，
顶栏只保留总开关。导航在 `.rp-body` 外，业务 Surface 切换不会卸载入口；关闭后焦点回到顶栏总开关。
Settings 现为 `workspace-surface` 的一种视图，任务、资源与普通设置叶子都在中央详情承载；各表单保留原 persistence/auth owner，确认框仍使用独立模态层。
详见 [App Shell](app-shell.md) 的当前实施记录。
下方 T2-A / T2-B 的入口位置为历史描述；原有 split、dispose 和 Browser 几何合同仍适用。

下方 P14-D 记录为历史设计。当前 Changes 和 Specs 从会话顶栏进入右栏，
默认单面板；标题内可开启 Specs（上）+ Changes（下）分屏，没有新增全局导航。
`ui/secondary-surface.js` 保留一个外层 surface 实例，用 dispose 集合释放两个业务面板；
`ui/split-workbench.js` 只管布局，两面板分别使用原有 mount、请求和状态。
分屏比例独立于 `right-pane.js` 的宽度记忆；窗口宽度低于 900px 或内容高度低于
448px 时回退为单面板页签，保留聊天节点、草稿与原有 dock/overlay 规则。
Browser 保留独占模式，标题内的分屏操作可改为 Browser（上）+ Changes（下）；
它与 Specs + Changes 共用同一比例和回退机制，没有通用拖放或三面板布局。
Browser 的原生 WebContentsView 沿用同一控制器与 session；布局切换只移动界面节点，
不清除页面表单与导航历史。关闭按钮仍遵守原有销毁/运行时隐藏语义。
右栏观察实际 viewport：隐藏页签、弹窗或拖动时统一 detach，重新显示前先提交新几何；
主进程按窗口 zoom 转换为 DIP 后 clamp，不使用 devicePixelRatio。
细节和验证见 [Specs](specs.md)、[T2-A 验收](T2-A-acceptance.md) 与 [T2-B 验收](T2-B-acceptance.md)。
Diff 单行/区间评论当前行为见 [Git Changes](git-changes.md#十多行区间评论t3-c)；
[T3-A 验收](T3-A-acceptance.md) 只保留对应阶段限制，修改时仍须核对当前实现。

## P14-D 历史记录

以下记录保留当时 Stage 设计及其验证背景；涉及当前入口和右栏承载时，以上方当前实现为准。
历史测试场景与通过结论不自动构成新行为提交的验证证明。

Global Rail 的 Home、任务、文件变更、扩展是四个一级视图。`public/ui/workspace-surface.js` 只管理当前视图、Stage 容器、唯一激活的 Rail 项和实例生命周期；各业务模块继续渲染自己的唯一一套内容。`#workspace[data-workspace-view]` 供样式、测试与排查读取，真实状态保存在模块内存中。

切出 Chat 时只隐藏 `#chatView` 和 `#chatComposer`。Conversation、Composer、附件及输入草稿的 DOM 不重建；SSE 消息继续写入同一消息流。返回 Home 即恢复原节点、滚动和当前流式状态。项目切换先回到 Chat，沿用 `workspaceGeneration` 清掉旧项目数据。

每次打开工作视图都会创建实例 token，先 dispose 上一个实例并清空 Stage host，再 mount 新实例。Planner 的 `plannerAlive()` 同时检查项目代号与 Surface 实例；Git 离开时清除 `panels.changes`，旧 diff response 由实例身份拦截；Skills 与 MCP 的异步结果也只允许当前实例落地。此状态只在前端运行时存在，不进入 Plan、Session 或后端配置。

Planner、Changes、Extensions 是一级 Stage 页面。危险操作确认继续用 `confirmModal`；Planner 历史 Diff、诊断、供应商等临时内容继续用 `openModal`。关闭二级 Modal 不切换当前一级视图。Planner DAG、Attempt、Review、Verification、Git 安全授权、Skills 发现和启停语义均沿用原业务模块。

布局使用同一 Stage 背景、轻分隔的列表与详情。桌面列表和详情并排，700px 转为上下排列；窄屏及低高度下滚动发生在 Surface 内部，不让页面整体横向溢出。Plan 和 Skill 列表项使用原生 button，选中项提供 `aria-current`；Tab 提供 `aria-selected`，Rail 继续使用 `aria-current="page"`。颜色之外仍保留状态文字。

验证：`npm run test:ui` 的 P14-D 段检查节点身份、草稿、附件、滚动、后台流式更新、唯一激活态和二级 Modal；`npm run harness` 加 `npm run shots:harness` 的 105–124 场景在真实 Chrome 中检查 Stage bounds、列表与详情、Diff、MCP、700/900/1200/1536px 和低高度窗口。完整回归以 `npm test` 为准。

P14-E 保留这套承载与滚动结构。Planner、Changes、Extensions 的按钮和选中行统一为灰阶，危险操作只用少量红色文字提示；状态文字、Git Diff 和执行结果继续使用语义色。Planner / Extensions Tab 的 `aria-selected` 与可见面板一致，并通过 `aria-controls` 指向对应面板。被替换的 Surface 内若持有焦点，统一生命周期会将焦点送到新视图的入口。

P22 把 Extensions 的标签行扩成 **All / Capabilities / Extensions / Skills / MCP** 五个过滤器：**没有新增导航**，复用的还是这一套 tab 机制 —— 同样的 `role="tablist"` / `aria-selected` / `aria-controls="extensionsTabPanel"`，同样的懒建面板与实例身份守卫；All 与 Capabilities 两个过滤器由 `capability-view.js` 渲染（它自己再守一次 workspace generation）。详见 [capability-ux.md](capability-ux.md)。
