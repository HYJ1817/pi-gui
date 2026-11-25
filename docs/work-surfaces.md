# P14-D Stage Work Surfaces

本文负责 UI 工作区的承载、生命周期与布局约束。开发/审查规则见
[AGENTS.md](../AGENTS.md) 和 [REVIEW.md](../REVIEW.md)，其他任务入口见 [文档导航](README.md)。

## 当前右栏工作区（2026-11-25 最终整改）

当前 owner 是 `public/ui/secondary-surface.js` 的工具注册表与有序 Surface 描述符，`right-pane.js` 只持有公共几何、可见性、最大化与焦点隔离。旧常驻工具按钮、隐藏 source-button、卡片网格与“更多工具”导航已删除；不再通过观察旧按钮重建第二套入口。

- 会话顶栏“工作面板”只切换整栏可见性。无标签时呈现居中单列 Launcher；图标来自本仓库公共图标，快捷键提示读取唯一 shortcut 注册表。字母只在 Launcher 焦点内做 type-ahead，Enter/Space 执行，不抢 Composer、文件搜索或 Terminal 的输入。
- 顶部只列实际打开的工具 Surface，`+` 新建独立空 Launcher，选择尚未打开的工具将该空标签转换；单例工具已存在时激活原实例，不创建第二个业务 owner。支持切换、关闭、中键关闭、左右键/Home/End、Delete、Alt+Shift+方向键与拖动重排；右键/Shift+F10 菜单支持关闭当前/其它/右侧/全部。上限16标签、8个导航scope；只保存有界描述符，不保存内容、grant、Blob/native/PTY id。
- **两层标签有意保留**：外层是工具，Files 内层仍是文件标签，工作簿内层仍是 sheets。Files 内部24 tabs、6 scope、192KiB持久化合同不变，不将文件再复制到外层 store。
- **隐藏不等于关闭**：切换/隐藏保留各业务 owner，投影 `onVisibility(false)`；Files 保存有界阅读状态并 dispose 重预览，返回后重新校验权限与对象身份；Browser detach native view，返回先更新 bounds 再 attach 同一实例；Terminal 保留 controller/PTY并降频，不重建进程、不自动夺焦。显式关闭 Surface 才执行其 dispose；Terminal 外层关闭仍只释放前端，结束后端PTY须走内层 stop/close。
- 导航scope与瞬时owner identity分开。backend/epoch/runtime身份变化令旧实例和异步结果失效；恢复描述符不等于恢复授权。Browser/Terminal描述符不得隐式导航或创建PTY，空后端必须等用户显式动作。
- Changes/Specs/Browser split 只借用既有 singleton host，不重复 mount；首次进入也经完整业务open动作准备头部和权限。退出/关闭split归还仍活着的子工具。
- 公共最大化覆盖聊天**可用工作区**，不覆盖既有项目侧栏，不是OS全屏。聊天DOM保留但变为inert，移出被覆盖区域焦点；还原/隐藏恢复原inert与正常宽度，不把临时最大宽度写入偏好。Files无私有fullscreen owner。
- Files树在预览右侧，左侧分隔条向左拖/ArrowLeft增宽；窄于620px用overlay与Escape焦点返回。只读语义保留在ARIA和具体状态，不重复常驻说明。格式低频复制、编码、公式等进入公共阅读菜单；不存在为旧测试保留的隐藏controls。

参考T3 Code精确SHA `c925b9ab198099f67de862ed01701bd1d8809f2b`，仅借鉴交互机制，不复制其品牌、React/Zustand store、host-path权限、可写文件能力或所有资源关闭策略。T3的`+`实际是类型菜单、文件位于同层Surface；Pi按本任务明确要求改为独立空Launcher，并保留既有Files双层结构。研究调用链与差异见[最终整改参考](surface-final-reference.md)，当前测试与产物资格见[最终整改验收](surface-final-acceptance.md)。

## 历史右栏工作区（T2-A / T2-B，以下至P14-D历史记录均非当前导航合同）

PI-Desktop 阶段 E 将原空白 `rp-titlebar` 与 `#workPanelNav` 合为同一条 46px 工具带；保留 `rp-titlebar` 类作为原生标题栏验收的定位接口。工具带按实际原生 caption 区域结束拖拽矩形，28px 控件及选中标签可横向滚动；选中状态仍来自各工具 owner，更新后仅滚动到当前项。右栏默认 392px、最小 320px、宽度记忆、dock/overlay 与分屏比例都由原模块持有。

“工作面板”打开的是工具列表，选择入口委托既有按钮；“选择工具”返回列表，不承诺创建任意独立标签。列表观察原按钮的 hidden/disabled/标签属性，离开时释放观察器。起始页是「工具」卡片网格，固定两列四格：变更、终端、文件、更多工具…；浏览器、Specs、分支树、协同文档收在默认折叠的「更多工具…」里。卡片只克隆原按钮图标并委托点击，快捷键提示从 `public/shortcuts.js` 的唯一注册表读取：`Ctrl+Shift+G` 变更、``Ctrl+` `` 终端、`Ctrl+P` 文件。没有推荐区。Specs 仍使用自己的文档树、Markdown、空态与只读边界。

终端与文件是右栏里的两个真实 surface，入口按钮、快捷键和起始页卡片走同一条 `openSecondarySurface` 生命周期：

- **终端**：工作区级多会话 PTY（node-pty，Windows 走 ConPTY），前端为多个 xterm 标签。Windows 默认绝对路径 PowerShell，缺失时回退绝对路径 CMD；POSIX 用 `$SHELL`，统一以 `TERM=xterm-256color` 启动。只有桌面版（本地令牌边界）或显式 `PI_GUI_ENABLE_TERMINAL=1` 时启用；cwd 来自聚焦会话的 workspace identity，Renderer 不传 shell、cwd、参数或环境变量。`create` / `list` / `start` / `read` / `input` / `resize` / `stop` / `close` 全部按 workspace 校验，跨工作区返回 409；`list` 只返回当前工作区的会话。输入拒绝 NUL 与超长、按原始字节写入且不追加换行；输出保留 ANSI/CR 原文、只在内存保留上限内的尾部、不写日志；`cols` / `rows` 有范围校验。每工作区最多 6 个未关闭终端，全局最多 12 个，达到上限时显式拒绝而不是杀掉用户其它终端。关闭面板只销毁 xterm 前端，后端继续运行并在重开时重放缓冲；只有显式 `stop` / `close`、所属会话确认失效、空闲超时或服务关闭才结束整棵进程树。Windows 的停止先按 spawn 时抓取的 `(pid, 创建时间, 映像路径)` 复查身份，匹配才 `taskkill /T`；不匹配/查询失败不杀，且不再回退 `pty.kill()`（P3-B）。源码运行与打包产物都必须带 node-pty 原生模块（`resources/app/node_modules/node-pty` / `build/node_modules/node-pty`）。
- **文件**：只读项目文件树与文本预览；按目录懒加载，跳过符号链接/junction 与隐藏项（除非用户显式显示），正文上限 256 KiB，二进制只标注不预览。没有写入、删除、重命名或上传入口。

### 多终端与工作区隔离（2026-11 P2）

- **会话账本。** 每个终端是服务端账本中的一条独立会话：随机 UUID（不使用 PID）、独立 PTY、独立 256 KiB 输出缓冲和绝对游标、独立尺寸与 `creating` / `running` / `exited` / `closing` / `error` 状态。`read` / `input` / `resize` / `stop` / `close` 都先按请求方 workspace 校验；伪造别的 workspace 的 session id 只会得到 `stale_workspace`，未知 id 返回 `terminal_missing`。id 是随机 UUID，不能靠响应差异枚举；跨区请求也不能控制其他工作区的会话。
- **标签语义。** 新标签走 `create`；`start` 保留 P1 兼容语义，复用当前工作区最近运行中的会话。`stop` 只结束进程并把标签留在 `exited` 供原地重启；`close` 删除标签和缓冲，对未知 id 幂等成功，对已知 id 仍校验归属；关闭一个标签只树杀该会话，其他终端继续运行。关闭或重启遇到网络错误等没有定论的响应时保留标签并提示重试，避免界面把一个可能仍存活的 PTY 藏起来、继续占用工作区额度。标签序号由服务端按 workspace 分配，最后一个标签关闭后从 1 重新开始。
- **前端切换。** 每个标签只有一个 xterm 视图；切换只显示/隐藏已经挂载的视图，不重建 PTY。隐藏标签降低轮询频率但仍同步状态和输出游标；键盘输入只进入当前可见标签。标签条横向滚动，长标题省略号截断，状态点区分创建中、运行、已退出、停止中与错误；空态、错误态和达上限时禁用「新建终端」都有明确文案，没有占位按钮。
- **工作区不是标签。** 关闭面板只销毁 xterm，后端 PTY 和会话账本继续存在；重开时 `list` 恢复标签并按游标重放缓冲，不新建 PTY。切换工作区只 detach 当前标签、停止轮询，不停止任何会话；回到原工作区重新 `list` 并接管同一批会话。`pi-gui:workspace-generation` 视为强制 detach，`pi-gui:git-scope` 先探测确认是否仍为同一 workspace。迟到的创建响应若不属于当前标签集会被关闭，迟到的列表响应按 token 丢弃，不能把旧工作区的会话挂到新界面；已被后端确认关闭的 id 也会从迟到列表里过滤，不会重新挂成死标签。
- **退出与重启。** 服务关闭时停止账本中所有未结束会话并等待真实退出；Electron 外壳先结束后端进程树再退出。应用重启不持久化 session id，旧 id 按 `terminal_missing` 处理，前端在新进程里新建终端。

### 终端生命周期与缓存截断（2026-11）

PTY 的生命周期由后端持有，前端换面板不结束进程：

- **已确认失效才结束。** 后端每 5 秒用会话自己的 conversation 重新解析 workspace。`unknown_conversation`、`unknown_workspace`、`unknown_project`、`workspace_unavailable`、`stale_workspace` 属于确认失效，即使 shell 仍在持续输出也会立即退休并树杀；`registry_unavailable`、快照不可用、`workspace_check_failed` 和没有确认码的普通文件系统错误只表示暂时答不上来，保留到下一轮，避免误杀健康 shell。`workspace_unavailable` 只在根目录确实不存在（`ENOENT`/`ENOTDIR`）或不是目录时产生；`EACCES`/`EBUSY`/`EMFILE` 等暂时性 stat 失败归为 `workspace_check_failed`。`stop` 仍先校验请求方 workspace，别的 conversation 只有 session id 不能跨工作区结束终端。
- **退休不等于退出。** 退休会话保留在账本里，状态只随真实 `onExit` 变为 `exited`；kill 失败时 sweep 在预算内重试，退出前或预算耗尽后都不会被静默删除。
- **面板与缓存。** 关闭右栏或切到 Files/Changes 只销毁 xterm，后端继续运行；重开时按游标重放内存缓冲，输入与 resize 继续可用。缓冲上限 256 KiB，保留尾部并避免切开 UTF-16 代理对。
- **空闲计时。** 服务端按会话维护活动时间，只有成功写入的用户输入和 PTY 新输出会刷新；`read` / `list` / `resize` / `start` 复用、切换标签或重开面板都不算活动，否则前端的 60–240ms 轮询会让静默 shell 永不超时。默认仍为 30 分钟，计时器在退出、停止、关闭和 dispose 时清除；面板隐藏本身不终止 PTY。任何进度输出都会续期，但完全无输入、无输出超过 30 分钟的长期任务在服务端看来与空闲 shell 不可区分，会被停止并保留 `exited` 标签供重启，这是有界资源策略而不是前端计时器。
- **保持运行（P3-A）。** 每个终端可显式开启 Keep Alive；默认关闭，普通终端仍走 30 分钟空闲超时。开启只豁免空闲计时，状态由服务端会话账本持有，按钮和标签图钉只是投影；手动停止、关闭标签、workspace 确认失效、应用退出和服务端 dispose 仍然结束进程。关闭后从这次操作重新计算完整 30 分钟。它不通过心跳或伪造输入实现，也不跨应用重启持久化。
- **身份门控终止（P3-B）。** Windows 停止前用 spawn 时抓取的 `(pid, 创建时间, 映像路径)` 复查；只有 `match` 才 `taskkill /T`，`mismatch` / `gone` / 查询失败一律不杀，Windows 不再回退 `pty.kill()`。每会话最多 3 次 kill 尝试且单飞；无法确认时标签保持「停止中」，不谎报已退出，也不释放额度。身份查询与 `taskkill` 之间仍有 TOCTOU，后代枚举仍按 PID；完整修复是 P3-C 的 Job Object。
- **截断的降级。** 当请求的游标早于缓存起点时，回放不再把尾部 ANSI 片段当作完整屏幕重放：前端调用 `reset()` 清屏并显示「较早的输出已超出缓存上限，无法完整恢复；显示已重置，输入仍可用。」PTY 不停止，键盘输入和 resize 保留。alternate-screen 的完整快照不在本期范围。
- **验证环境分开记录。** 源码 Node、Node SEA 便携版和 Electron 桌面安装版是三个运行时；`npm run test:terminal:source` 证明普通 `node server.js` + 仓库 node-pty，`npm run test:app` 只证明打包后的 `server.cjs` 在 Node 下可启动，`npm run test:exe` 只证明 SEA，真实 Electron 用 `npm run test:terminal:electron`（Windows 11 桌面 + Electron 44.4.3）单独验收，详见 [测试分层](testing.md)。

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

P22 曾把 Extensions 的标签行扩成 **All / Capabilities / Extensions / Skills / MCP** 五个过滤器。P36 移除了独立的能力状态页，All 与 Capabilities 两个过滤器一并删除，只剩 Extensions / Skills / MCP 三个标签。之后三者拆成独立入口（见 [agent-capabilities.md](agent-capabilities.md)）：`extensions` Work Surface 只剩 **已安装 / 插件市场** 两个页签，复用的仍是同一套 `role="tablist"` / `aria-selected` / `aria-controls="extensionsTabPanel"`、懒建面板与实例身份守卫；技能与 MCP 配置是设置详情页。共享的 `capability-model.js` / `ui/capability-setup.js` 继续服务已安装包的详情；独立的「已知能力设置」折叠区已移除，详见 [capability-ux.md](capability-ux.md)。
