# PI-Desktop 多会话运行时源码参考研究

> 研究日期：2026-11-26。用途：为 pi-GUI 的多会话专项修复提供可核查的架构参考；不是实现方案批准、运行验收或安全审计通过意见。
>
> **结论先行：PI-Desktop 的默认 Desktop 会话不是“一会话一个 `pi --mode rpc` 子进程”。它在共享 Node sidecar 内，按 session ID 持有独立 `DesktopAgentRuntime` / Pi `Agent` 对象；另有使用 Pi SDK 的原生 Pi 会话续接路径。应参考身份、归属和生命周期原则，不能照搬其进程模型、持久化或 LGPL 源码。**

## 1. 获取记录、固定版本与研究边界

| 项目 | 本次实际记录 |
| --- | --- |
| 参考仓 | https://github.com/vastsa/PI-Desktop |
| 获取方式 | 实际执行 `git clone --depth 1 --no-recurse-submodules`，禁用 clone hooks；目标为本次在 `os.tmpdir()` 下独立新建的空目录 |
| 本次 clone 目录 | `C:\Users\21022\AppData\Local\Temp\pi-desktop-runtime-ref.QGrG0RyJ`；未覆盖主仓 `.t3-ref/` 或其他参考资料 |
| 完整 commit | `71c637bf823dcec9c9eb3e33a8514826925cd436` |
| 提交时间、标题 | `2026-11-26T11:23:49+08:00`；`Merge pull request #2606 from vastsa/fix/subagent-panel-message-width` |
| 源码声明版本 | 根目录、Desktop、agent-runtime 的 package.json 均为 `0.24.0-beta.5`；这是源码版本字段，不冒称已发布 tag |
| Pi 库声明 | agent-runtime 声明 `@earendil-works/pi-agent-core`、`pi-ai`、`pi-codemode`、`pi-coding-agent` 均为 `1.5.2`；未安装依赖，未据此声称验证了供应商包的实际执行行为 |
| 许可 | 根 `LICENSE` 为 **GNU LGPL Version 3** 文本；不擅自追加 “or later”，也不据此推断所有第三方文件采用同一许可 |
| 主仓对照基线 | `C:\pi-GUI`，`fix/parallel-session-runtime`，`ac812c6fa49dfd960867a5688ee6f61cb8ec5f67` |

版本、许可的固定源码证据见 [P01]、[P02]。下文所有参考仓链接均固定到上述完整 commit，不使用浮动 `main` 链接。

安全执行边界：

- 下载内容只作为不可信数据读取。未 `npm install` / `pnpm install`，未构建、测试、执行或 import 参考源码，未从参考目录运行解释器，未调用真实模型。
- 未用真实用户项目或会话进行写入验证；未修改 Pi 本体、用户全局 npm、Pi session schema。
- 主仓唯一由本研究写入的文件是本文。研究开始时另有 `server/pi-probes.js`、`server/session-tool-bridge.js`、`tests/session-tool-bridge.cjs` 的既有未提交修改及未跟踪文件；收尾时也观察到其他并行工作新增的 package/test/报告改动。它们均不属于本研究，未覆盖、清理或据此宣称基线行为已经改变。
- 证据来自所列函数的实际实现与调用边界，不以 README、产品名、注释中的愿景或测试文件存在来替代行为核查。未运行的行为明确保持“未实测”。

## 2. 核心结论与勘察修正

1. **焦点不是运行归属。** renderer 的 `activeSessionId` 决定当前显示；`runningSessions[sessionId]`、后台 transcript cache、审批队列以及 main 的 `activeTurns` 各自按 session 持有状态。切走会话不等于 abort、dispose 或把输出转投新焦点。[P03] [P10]
2. **默认运行隔离是对象级，不是进程级。** main 共享一个 sidecar 句柄；sidecar 的 runtime map 按 session ID 复用/替换对象，每个对象直接创建 Pi `Agent`。共享 sidecar 崩溃会影响其中全部运行会话。[P05] [P06] [P22]
3. **同会话串行、不同会话可并行。** main 的 session-operation 锁、Host 的 durable turn 准入、sidecar 的 busy 检查是不同层；不能只靠 composer 的按钮禁用。普通 renderer 发送也不能误画成必经 `AgentHost.startTurn`：它直接进 IPC handler，Host 队列/RACP 等入口才通过该 admission API 再回到 runtime port。[P04] [P07]
4. **`accepted` 不是完成。** sidecar 启动异步 prompt 后返回 accepted/turnId，thinking/text/tool/终态继续经 notification 上报；RPC request ID、session ID、durable turn ID 不能混用。[P08] [P09]
5. **已有跨会话 typed-file 协调，不能漏报。** Rust Host 的共享 `ToolBudget` / `FileResources` 在审批后协调物理文件身份冲突，实际阻塞文件任务结束前持有 permit。只看到 runtime 内 `PathMutex` 就断言“没有跨会话文件锁”是错误的。[P17] [P18]
6. **文件协调不等于 shell/git 隔离。** Bash 不属于上述 file-resource 分类；同工作区 shell、外部编辑器和跨工具的 read→decide→write 事务仍不能靠该文件锁获得一致性。worktree 也不是 OS sandbox。[P18] [P19]
7. **恢复存储，不等于重放副作用。** Desktop 有 outbox、流式 checkpoint、turn 终态与启动恢复；共享进程有有界重启。它们不构成“自动重放崩溃前所有 prompt / 工具”的保证。[P20] [P21] [P22]
8. **pi-GUI 已有更合适的外部 Pi 抽象。** `runtime-registry`、`session-runtime`、`rpc-bridge`、共享 tool scheduler 已覆盖身份、后台事件、Stop 屏障及清理等大部分原则。应定位这些抽象的实际接线和竞态，不另建一套 SDK Agent/session 数据库。[G01]–[G07]

## 3. 进程拓扑与身份分层

### 3.1 默认 Desktop 路径

按职责依次是：renderer store → preload 的白名单 IPC → Electron main 的 agent IPC/session coordination → 共享 Node agent sidecar → 每 session 的 `DesktopAgentRuntime` → 该对象内部的 Pi `Agent`；工具和持久记录经反向 `host.proxy` 回到 main，再转共享 Rust host-core。[P03]–[P09]

Electron `AgentSidecar` 使用自身可执行文件、`ELECTRON_RUN_AS_NODE=1` 和 bundled sidecar；共享 transport 最终以 pipe stdio spawn。这里没有为每条会话再启动一份外部 `pi --mode rpc`。工具可以另起 shell/runner/后台进程，因此“没有每会话 Pi child”不等于“产品只有两个子进程”。[P05] [P19] [P25]

| 身份/状态 | 持有者与作用 | 不应混淆为 |
| --- | --- | --- |
| 当前选中会话 | renderer `activeSessionId`；当前视图、输入目标、通知已读语境 | 全局唯一运行会话 |
| session ID | Host durable session、runtime map key、事件/工具/缓存归属 | cwd、PID、当前选中项目 |
| durable turn ID | `session.beginTurn` 创建，main `activeTurns` 保存，传入 runtime 和工具调用 | JSON-RPC request ID、provider-local UUID |
| runtime 实例 | sidecar map 中的对象；配置不兼容时 dispose 并替换 | 可跨配置/崩溃沿用的独立进程身份 |
| transport request ID | JSON-RPC pending map 的一次往返配对 | 整轮生成、异步事件游标 |
| process / Host generation | 共享进程生命周期；`HostProcess.generation` 标识新 Host | 某一个 session 或 turn |
| message/tool ID | 气泡、流式更新、工具 start/end、持久化幂等键 | 全局 UI 数组下标 |

`agent.testRuntimeIdentity` 中的对象观察标记只在测试探针开关下存在；不把它当作生产公开 runtime identity。默认 event envelope 主要带 sessionId/turnId/time；pi-GUI 的完整 owner/generation 不应因此被简化成 sessionId。[P06] [P09] [G01]

### 3.2 原生 Pi 会话是另一条路径

`native-pi:` 会话由 `NativePiSessionService` 管理：读取原生 JSONL、确认身份和项目信任、取得 cooperative lease，然后以公开 Pi SDK `createAgentSession` 打开 `AgentSession`。它不是外部 CLI RPC；也不走 Desktop outbox、Host 队列的同一条持久化链。[P26] [P27]

该版本 native 续接入口限制为文本；创建 SDK session 使用 `noTools: "all"`，extension 绑定为 headless print、无 UI context，并拒绝 new/fork/switch 等 command actions。不能把默认 Desktop 的工具/审批能力无条件套到这条路径上。[P26] [P27]

## 4. 用户发送到开始运行：实际调用链

1. `useComposerSubmit` 把捕获的 `activeSessionId` 作为明确目标传给 `sendPrompt`，而不是异步完成后再猜当前焦点。[P03]
2. `queue-slice.sendPrompt` 捕获 `requestedSessionId ?? activeSessionId`，以 session-specific submission key 防重，记录 optimistic user message ID。已经运行的普通 Desktop session 进入 enqueue；native session 不支持这套 Desktop 队列。`api.prompt` → preload `ipcRenderer.invoke` → `IPC.invoke.agentPrompt`。[P03]
3. main 的 `agentPrompt` 对普通 session 取得 `acquireSessionOperation(sessionId)`；按该 ID 从 Host 读 session/settings，按 session 的项目解析 MCP/launch，不借当前 renderer 项目。锁覆盖异步准备直至 sidecar 接受，Stop 使用同一锁关闭“按钮已能点、runtime 尚未建立”的窗口。[P04] [P23]
4. `resolveAgentRuntimeLaunch` 选择该 session 的 provider/model/thinking、工具/扩展、项目配置和文件根。`session.beginTurn` 创建 durable turn ID；main 保存 `activeTurns[sessionId]`。Rust `begin_turn` 在数据库中阻止同 session 再建 running turn，其他 session 不受此条件阻塞。[P04] [P07] [P11]
5. main 先 append 用户行，再向 sidecar 发 prompt。append 失败会将 turn 以 error 收口，不启动缺少用户转录记录的生成。传入的 userMessageId 用于恢复历史时排除本轮刚持久化的用户行，避免重复送入模型。[P04] [P06]
6. sidecar `runtimeFor` 拒绝正在运行的同 session；兼容则复用，不兼容则 await dispose 后重建。新对象从 Host `session.get` 恢复历史，内部 `new Agent`；不是按一次发送 spawn 一个 Pi child。[P06]
7. `agent.prompt` 使用 main 传入的 durable turn ID，启动异步 `runtime.prompt` 后即返回 `{accepted, turnId}`；后续失败通过 `agent.event` 的 error 上报。完成必须由后续终态与持久化收口确认。[P08]

补充：`AgentHost.startTurn` / `enqueueTurn` 对队列、RACP、后台 continuation 等入口用 `withAdmission(sessionId)` 串行化 busy check 和队列写入，再调用 runtime port。**这层与普通 IPC handler 内的 session-operation 锁、Rust durable turn 准入并存，不是同一个锁，也不是所有发送都先经过它。** [P07]

## 5. cwd、项目、worktree、scratch 与配置 ownership

- **projectPath 是项目身份，workspaceRoot 是文件操作根。** 隔离会话保留项目身份以解析 memory、skills、plugins、MCP、subagent，但文件和项目指令读取根指向 worktree；远端 workspace 是单独分支，不冒称本地 worktree。[P11]
- **没有项目的会话使用 session-specific scratch。** launch 传入 dataDir 下的 `scratch/sessionId`；Host `resolve_tool_workspace` 从持久 session 解析 worktree → project → scratch。未知 session 拒绝，不回退到可变全局 workspace。[P11] [P12]
- **共享 sidecar 的 process cwd 不是每会话 authority。** Desktop launcher 没有逐会话 spawn cwd；tools.execute 的根在 Host 按 session 解析，再传给工具 runner。不能为切换会话调用全局 `process.chdir` 来替代这个绑定。[P05] [P12] [P18]
- **配置是每次 launch 的有效快照，不是焦点会话的全局临时变量。** runtime `firstMismatch` 比较 provider/model/auth/header、thinking、shell、工具、项目指令、projectPath、workspaceRoot 等；不兼容则换 runtime，一些可更新开关原位刷新。global settings 仍是共享来源，不能声称所有配置从此完全私有且永不变化。[P06] [P11]
- **权限的 owner 不在模型参数中。** Host 从自己的 session mode / staged run 决定授权；shell identity 在执行时再核对。main-side vendor auth resolver 另按 session 绑定 provider allowlist，不允许 runtime 任意读取其他 provider 凭据。[P13] [P14]
- **重要能力限制：per-turn permission ceiling 尚未落地。** main 将 `req.permissionMode` 传下去，但 sidecar 明确只接收占位，不改变 enforcement；实际仍由 Host 存储的 session 模式等决定。不能把 API 字段存在或 AgentHost 的 effectivePermissionMode 记录，描述成 Rust 已执行更窄的单轮权限上限。[P08] [P14]

## 6. RPC、流式消息与后台缓冲

### 6.1 往返响应与异步事件分离

main↔sidecar 使用 NDJSON JSON-RPC。`AgentSidecar.call` 创建 UUID、注册 pending，再写一行；response 根据 id settle pending，notification 交观察者。exit/error/dispose reject 挂起调用并清 timer/controller。sidecar 的 stdin handler 先尝试消费反向 Host response，再处理方法请求。[P08] [P13]

工具使用 `ParentHostProxy.call` 输出 `host.proxy` 请求；main 侧代理检查允许方法/局部工具分支后调用 Host，再把同一 request ID 的 result/error 写回。`ParentHostProxy` 另有自己的 pending map；父通道关闭时 reject。**反向 RPC 的响应不应被当成 agent 事件，超时也不是工具已停止或副作用已回滚的证明。** [P13]

Rust Host 也是独立 pipe RPC，`HostProcess` 有 generation、pending、关闭/握手边界。它不是某会话的 Pi 子进程。[P05] [P24]

### 6.2 thinking / text / tool 事件

`DesktopAgentRuntime.handleAgentEvent` 为 assistant 创建 `currentAssistant`，将 Pi Agent 的累计 content 拆为 text/thinking；`message_update` 计算 delta，非前缀变化明确发 reset，不把重试/替换误作追加。工具事件映射为 tool_start/update/end，关联 toolCallId。[P09]

runtime `emit` 给事件附 sessionId 和当前 turnId。流式 coalescer 以 sessionId、parent tool、message ID 分组；遇到非 delta/语义事件先 flush，避免最终 message_end 或 tool_start 越过尚未发出的文本。工具执行请求带 sessionId、turnId、toolCallId；取消控制器属于发起 runtime 的调用，不借焦点定位。[P09] [P13]

### 6.3 UI 只是一个投影，不是持久化 owner

`events-slice.handleAgentEvent` 先按 envelope.sessionId 更新 status、running、审批等；非当前 session 的 transcript 走 `cacheBackgroundTranscriptEvent`，当前 session 才更新主视图 messages。后台 permission/ask 仍按原 session 入队并提醒；不会因为切走就自动批准或丢给新会话。[P10]

缓存是优化而非事实源：LRU transcript cache 上限 20；后台 projector 仅在已有 cache/retained transcript 时更新，没有缓存会直接返回。它并不为所有后台会话永久保留全量流；持久化链独立消费同一事件，重新选择会话再从 Host 读取并合并 live 状态。[P10] [P20]

## 7. 工具与 approval 的闭环

默认 Desktop 的 typed tool 调用闭环如下：

1. runtime → `tools.execute`，携带 session/turn/tool identity、参数及必要的 shell/batch 身份；主进程代理到 Rust Host。[P13]
2. Host 核对自己的 session mode、workspace、外部路径和权限模式；等待审批之前就注册 cancellation。自动授权成立才免弹卡，否则创建 requestId/sessionId/toolCallId 绑定的 request 与等待 receiver，发 `permissions.request`。[P14]
3. main `runtime/host.ts` 把请求转换为 `tool_permission_request`；通过 `(sessionId, toolCallId)` 补 delegate lineage。AgentHost 生成审批投影；renderer 的 pendingPermissions 按 session 保留，即使目标不是当前会话。[P15] [P10]
4. `interaction-slice.resolvePermission` 核对目标 session 当前卡的 requestId；经 main `toolResolvePermission` → Host `permissions.resolve`，由 Host 持有的 request ID 找等待者。transport payload 不带 sessionId，不代表授权全局生效：归属在 Host pending request 内。[P15]
5. deny、receiver 消失、取消均不继续执行；allow-session 的 grant 进入该 session 的工具名集合。**审批等待不占用下面的工具执行 permit**；批准后才排队获取 ToolBudget / file resources，并重验 root/shell/文件绑定，再执行。[P14] [P17] [P18]

AskTool/extension UI 与 Rust tool approval 是不同等待者：前者由 sidecar runtime 持有、通过 session/request identity resolve，后者由 Host 权限管理器持有。不能仅因都表现为“卡片”就放进一个全局 callback。native Pi 又绑定 headless extension UI，不能声称复用了 Desktop 弹卡链。[P15] [P26]

## 8. 持久化、历史恢复与陈旧事件

### 8.1 Desktop：Host canonical transcript + main outbox/checkpoint

- Host 使用数据库保存 session/turn/index；canonical transcript 为应用 dataDir 的 `sessions/sessionId.jsonl`，不是用户原生 Pi 的同一份 schema/文件。[P16]
- 用户行在 main 发 prompt 前写；assistant/tool 的终态由 event persistence 入 outbox。outbox 的 key 和 Host message ID 去重使重启重试具有幂等基础；Host 还处理跨 session toolCallId 碰撞，不能把 provider toolCallId 当作全局唯一主键。[P04] [P16] [P20]
- assistant text/thinking 按 session checkpoint，默认间隔 1500 ms，终态先 flush 最后快照再 append；logical settle 与物理正在进行的 write 分开跟踪。该间隔是节流参数，**不是无条件“最多丢 1.5 秒”保证**：写入、Host 或磁盘失败仍可能让 checkpoint 落后。[P20]
- outbox 不是无限缓冲或无限重试：满时拒绝；反复不可分类失败会隔离 dead letter，不自动重放隔离项。不能把“终态已收到”写成“所有内容必然已经持久落盘”。[P21]

### 8.2 冷启动与恢复

Host 打开数据库时将旧 running turns 标记 aborted；`AppState.open` 恢复孤立 transcript 的 session/index，并处理 inflight checkpoint。Desktop startHost 握手后先 drain outbox，再请求恢复剩余 inflight，避免先给 renderer 一份缺少 assistant/tool 的历史。[P16] [P21]

新 runtime 从 Host `session.get` 获取 canonical history；renderer 则用有界分页尾部/内容限制读取并与 live transcript 合并。这是两种读者，不能把 UI 显示裁剪后的文本当作完整模型上下文。[P06] [P10] [P16]

### 8.3 防止旧 turn 终态结束新 turn

`session-coordination.isStaleTerminalEvent` 对 root agent_end/error 核对当前 active turn；缺 ID、旧 ID、delegate 终态不得结束父 turn、推进队列或清理新审批。fan-out 与 persistence 是两个独立入口，都调用该守卫。transcript rewrite 另有 fence；历史归档和当前运行状态变更不是同一个动作。[P20] [P22]

### 8.4 native Pi：不应复制的持久化特例

`NativePiSessionService.openRuntime` 用 SDK `SessionManager.open` / `AgentSession` 续写原生 JSONL，事件先用 provisional message ID，SDK append 后再以原生 durable entry ID 替换。它使用 `.pi-desktop.lock` cooperative lease + 字节 fingerprint；源码明确原生 Pi 客户端尚不共享该锁。[P26] [P27]

尤其 `guardNativePiSessionManager` 会包装替换 manager 的 append/branch 方法。这与 pi-GUI **只通过外部 `pi --mode rpc` 通信、不 monkey patch、不改 session schema** 的约束冲突；只可研究“写前重验、稳定消息身份”的原则，不能搬这条实现路线。[P27] [G02]

## 9. Stop、崩溃恢复与退出清理

### 9.1 Stop 必须捕获原来的 session/turn

renderer 的 abort 先捕获目标 session，调用 `api.abort(sessionId)`；普通 Desktop 路径还并行 deny 该 session 的未决权限。调用失败保留运行态以便重试，不能直接清空全局 processing。[P23]

main `agentAbort` 与 prompt 共用 session-operation 锁，捕获 active turn、提前锁定 abort reason、取消该 session 的工具和 extension prompts，再调用 sidecar。sidecar 在 await 前后核 expected turn，且核对 map 仍是原 runtime 对象，防止迟到 Stop 杀到替换后的对象。[P23]

runtime `abort()` single-flight：停止 steering、pending asks、delegates、Agent、retry、compaction，并主动驱动 active tool abort handlers；等待 turn settlement/delegate completion。读操作可放弃等待，但带写入/外部动作的路径不能仅因 transport waiter 消失就当作停止；Host 文件 permit 仍留在真实执行体里。[P18] [P23]

另有 `agent.stop` = graceful stop request，并不等价于 `agent.abort`；**已转入 Host background-task registry 的 shell 明确可跨 turn/Stop 存活**，需要独立 stop-task / session lifecycle 管理。[P19] [P23]

### 9.2 sidecar / Host 崩溃不是同一种故障

- sidecar 是共享失败域。exit 清旧实例句柄、工具表，并对所有 active session 捕获原 crashedTurnId；flush checkpoint 后再次核对，只有仍属原 turn 才 settle/recover，迟到清理不得结束新 turn。[P22]
- Host transport 退出会 reject Host pending requests；main 重新启动 Host、重绑 sidecar 的 Host link，startup 执行持久化恢复。不能据此宣称 sidecar 中每个模型请求都被同步取消，或所有未完成动作可透明续跑；这是与 sidecar exit 不同的边界。[P13] [P21] [P24]
- 两个 child 各自 single-flight 监督：每 120 秒窗口最多 3 次，退避基数 500 ms、上限 4000 ms；shutdown 后不重启，明确不可恢复错误直接停止。**重启 transport ≠ 自动重放上一条用户任务。** [P22] [P24]

### 9.3 关闭窗口、托盘、真正退出

window-all-closed 并非无条件退出：macOS 和配置的 tray 模式可以保活；before-quit 的用户确认可以取消。只有确认退出后才设置 quitting，停止服务和 supervisor。[P24]

确认退出后的关键顺序是：

1. 结束 live voice、关闭远端 host；
2. Host 仍活时 flush streaming checkpoints，尝试 abort 活跃 session，让最终转录进入 outbox；该 turn settle 阶段预算常量为 2000 ms，单次 abort race 800 ms，并非无限等模型；
3. 关闭 plugin surfaces；dispose sidecar，停止新事件产生；
4. 再 flush checkpoints、等待 event persistence（另有有界等待）、flush outbox；
5. HostProcess 关闭 stdin 发 EOF，Rust runner 调 `AppState.shutdown`，取消权限/前台工具并通知后台任务停止，等待 RPC tasks 收尾；HostProcess 超过宽限有强杀 fallback；最后处理 MCP/plugins/browser 等。[P24] [P25]

这是一套**尽力且有界**的有序退出，不是掉电、强杀或整个进程树任意崩溃都零丢失的证明。sidecar dispose 本身也只有 2000 ms 等待 child exit，不能拿该方法名推导“所有资源已被操作系统验证清零”。[P24] [P25]

## 10. 共享工作区：实际保证与不能推出的保证

### 10.1 已证实的两层文件协调

第一层是 runtime 内的 fallback `PathMutex`，只在 Host batch 协调不支持时保护本 runtime 的 mutating path/read；不能代替跨 session 锁。[P17]

第二层在共享 Rust Host：

- `ToolBudget` 全局持有 file holders；Read/Glob/Grep 是 read 类，Write/Edit 是 mutation 类。只要一方 exclusive，物理文件身份相同、地址相同或身份无法证明独立就冲突。
- `FileResources` 解析发生在授权之后，不为分类读取内容；普通既有文件可绑定物理身份和地址，新文件/未知身份、Glob/Grep、结构性 Edit 等走保守 fence。Windows 身份判定也有本地盘适用边界，不把网络路径擅自当独立。
- admission 后重验，真实 `spawn_blocking` 文件任务内再次 validate；permit 的 `Arc` 被任务持有到真实文件操作返回。取消上层 future 不会提前开放仍在写的文件。
- file-batch ticket 绑定 session/delegation/batch/ordinal/tool identity/参数，并保护同 batch 冲突调用的源顺序；它与全局物理资源锁是不同层。[P17] [P18]

### 10.2 不受上述保证覆盖的行为

| 场景 | 源码能支持的判断 |
| --- | --- |
| 两会话 typed Write/Edit 命中同一物理文件 | Host 有冲突调度；不是“完全没有保护”。但只是调用区间协调，不是整轮业务事务 |
| A Read、B Write、A 再 Edit | 逐调用锁不覆盖 A 的思考间隔；hashline 等可检测部分陈旧修改，不能据此保证整个 read-modify-write 或多文件事务原子性 |
| Bash 写文件与另一会话 typed Write/Edit | Bash 走 Shell budget、不是 FileResources；这条 file-identity 机制不提供统一互斥 |
| 两会话在同 checkout 跑 git、构建、安装、测试 | shell 并发预算不是 repository transaction lock；index、分支、构建目录、数据库、端口等仍可冲突 |
| 外部编辑器、原生 CLI、另一个应用实例 | 不参加 Host 内锁；native lease 也不被原生 Pi 客户端共同遵守 |
| 各自 worktree | 降低工作文件/index 的重叠；公共 Git 元数据、外部绝对路径、全局配置、端口等不能由 worktree 自动隔离 |
| 远端 workspace / Host-local 特殊工具 | 有独立分派路径；不能将本地 FileResources 的保证外推过去 |

上述是边界分析，不是本次复现的缺陷清单。没有运行并发写文件或 shell/git 实验，不使用真实项目进行破坏性验证。基于这些边界，**不能借 PI-Desktop 的“多会话可并行”来降低 pi-GUI 既有 shared-workspace 准入和保守 shell 守卫。** [P13] [P18] [P19] [G06]

## 11. 资源上限：数值必须注明作用域

下表是固定版本源码中的静态参数，不是本机压测结果，也不是保证能同时达到的容量。

| 对象 | 源码参数 | 作用域/限制 |
| --- | --- | --- |
| sidecar V8 old space | 2048 MiB | 整个共享 sidecar 的 old-space 上限；不是每 session，也不是进程 RSS 硬上限 [P05] |
| 活跃 session runtime 总数 | **未知** | 所读 runtime map/复用/dispose 路径未见按数量准入；不把“未见”写成产品确定无限制 [P06] |
| 子任务 agent | 10 个运行中 | runtime/session 内的 delegation 检查，不是应用全局 10 个 [P28] |
| Host 并发 RPC | 32 | dispatcher 请求槽；控制面有分派特例，不能把它当所有消息/进程数量上限 [P28] |
| 工具执行 | 全局 16；每 session 4 | 下列分类上限与文件冲突还会进一步限制 [P17] |
| Shell / Reads / Mutations / Plugins | 全局分别 4 / 8 / 2 / 4 | Shell budget 不代表共享文件互斥 [P17] |
| 每 session mutations | 保守 1；协调路径 2 | 协调路径仍受全局 2 与资源冲突限制 [P17] |
| 工具等待队列 | 64；等待 30000 ms | 批准后 admission；超限/等待超时返回 overloaded [P17] |
| Host background shell tasks | 每 session 10、全局 64 | 与前台 turn 分离；启动路径实际检查两个配额 [P19] |
| background output | 每 stream 256 KiB ring；已结束历史 16 | 不等于全部 session 历史都永久在内存 [P19] |
| Desktop transcript cache | 20 个 session；页大小 100；显示内容限制 64 KiB | UI 读取/缓存参数，不是 canonical transcript 或模型上下文上限 [P10] |
| persistence outbox | 1024 entries；dead letters 默认 256 | 未分类连续失败最多 5 次，退避 5–60 秒，隔离后不自动重放 [P21] |
| AgentHost bookkeeping | 每 session turn records 保留目标 200；幂等记录上限 2000 | 不应当成数据库总 session/turn 配额 [P07] |
| Host queue / RACP 默认值 | 每 session queued turns 8；replay 10000 events / 24 h | AgentHost 使用相关 defaults；不据此声称普通 renderer stdio 全部受 RACP frame 限制 [P07] [P29] |
| RACP transport 默认值 | frame 1 MiB、prompt 256 KiB、attachment 50 MiB；每连接订阅 8、clients 16 | 协议对应入口的默认值，非通用模型/进程配额 [P29] |
| file batch | 总 calls 512、单 batch 128、arguments 32 MiB、未使用 TTL 15 分钟 | batch 登记的边界，不是 session 数上限 [P17] |
| 自动重启 | 每 child 每 120 s 最多 3 次；500 ms 指数退避、cap 4000 ms | host 与 sidecar 分开计数；不是无限恢复 [P22] |

## 12. 对照 pi-GUI：复用现有抽象，不搬参考实现

主仓对照使用指定基线中未被现场修改的文件；`rpc-bridge.js` 和 `session-runtime.js` 已读实现，不仅引用旧架构文档。

| 研究主题 | pi-GUI 已有实现 | 可借鉴的原则 / 不应复制的路线 |
| --- | --- | --- |
| 多会话持有者 | `runtime-registry` 分开 records/lives/leases；完整 owner 包含 backend/project/repo/workspace/epoch/conversation/runtime/generation/session [G01] | 保留完整 owner 与 async 后重验，不退化为“当前 sessionId + 全局 rpc” |
| 独立执行环境 | `session-runtime` 为每 runtime 建独立 Runtime/launch/supervisor/bridge；固定 context.cwd，外部 Pi RPC；`PI_NO_CONTINUE=1`，resume 定位被验证 session [G02] | 直接复用 factory，不复制对方 SDK Agent 或改变 Pi 持久化 owner |
| 装配与共享根准入 | `server.js` 的 registry factory 注入同一有效 Pi 入口、共享 toolScheduler/mutationAdmission/browser/process；重叠项目要求 toolGuard ready [G03] | 优先查接线/guard readiness，不因参考项目有多会话就放开未经证明的 shared workspace |
| 消息与后台事件 | Registry 生成 owner/eventSequence，单 runtime 默认 200 events / 1 MiB，淘汰标 historyRequired；bind session 以私有 get_state 验证 [G01] [G04] | 学“后台投影不依赖焦点”，但无需再加另一套 Host event store/outbox |
| focus/blur | Registry 独立维护 focus；会清 attention/视图资源，不因此停止 Agent [G07] | 排查 UI 若仍把 focus 切换当 runtime 切换，应修调用边界，非推翻 Registry |
| RPC response/event | `rpc-bridge` LF-only JSONL、pending ID 配对、私有 response 不广播、exit settle、ready 必须有 get_state 应答 [G05] | 维持官方 Pi 协议；不抄对方自有 JSON-RPC 协议当外部 Pi 能力 |
| text/thinking/tool 投影 | `session-runtime.projectRuntimeEvent` 保留白名单文本/思考增量、工具身份/事实，剥离不需外传的参数/结果/诊断 [G02] | 不为调试多会话把原始 payload 加进日志或全局后台 buffer |
| Stop | Registry command 走 adapter.abortAndWait；bridge 先 clear_queue、再 abort，成功应答或 settled+idle 回读才解屏障；超时保持 stop_unconfirmed [G04] [G05] | 保留本仓更严格的“未确认不得当已停”；不可照搬 UI 清 running 或 graceful stop 当权威停止 |
| 工具并发 | `session-tool-scheduler` 按 canonical root overlap 在不同 channel 间协调 writer；只有已证明 native read 允许 bypass，未知工具/shell 应取 writer lease [G06] | 已有更保守的粗粒度策略；参考物理文件身份只能作为后续独立优化题，不先降级 shell 守卫 |
| 容量与回收 | Registry 默认总数阈值 2、显式 allowThird 后硬上限 3，计入 externalCount；资源上限、retire single-flight、cleanup_pending 保留槽/lease [G01] [G07] | 保留 admission→启动→失败回滚→确认清理闭环；不要改成无界 map 或看到 child exit 就释放所有资源 |
| 历史与恢复 | 后端记录已证明的 session locator/identity；history route 只接受 conversation ID 并重验，不让 renderer 指定路径 [G04] [G07] | 继续让外部 Pi 拥有原生 session；不复制原生 JSONL append wrapper、SQLite session/turn 体系 |

注意既有 scheduler 的保护也是 cooperating GUI tools 的边界，不是 OS sandbox；read bypass 也不是全工作区读写事务隔离。这里的对照不宣称 pi-GUI 已无并发 bug，只说明专项修复应先验证现有 owner、guard、Stop、后台投影是否贯通，而非重造 runtime。[G06]

## 13. 可交给实现方的验证清单（本研究未执行）

均应使用 fixture / 临时目录，不依赖本机安装真 Pi，不写用户真实会话：

- A/B 同时发送，切焦点后 text/thinking/tool/approval/终态仍回到原 owner；关闭当前视图不误杀后台任务。
- prompt 准入尚未完成时立即 Stop；并发第二次 Stop single-flight；abort 超时保持屏障，随后新 prompt 不偷跑。
- 旧 runtime、旧 turn、旧 bridgeRun 的迟到事件/响应/审批、异步 cleanup，均不能影响新 owner。
- 后台事件缓冲溢出→historyRequired→以后端 locator 恢复；历史加载慢于新 live message 时不得覆盖新消息。
- 共享根两个 channel 的 Write/Edit、未知 shell、受管进程、撤销 mutation admission 相互作用；guard 无法证明 ready 则拒绝，不静默降级。
- 同 checkout 的 shell/git 不能仅靠 session 隔离宣称安全；worktree 与共享根分别验证，外部写入边界明确告知。
- 单 runtime crash、supervisor cleanup 失败、quota 满、启动中取消、app close；未确认清理仍持有槽/lease，未决权限不迁移到新 runtime。
- 所有断言绑定身份和可观察证据，不以 PID/端口/时间序号代替身份，不把 fire-and-forget accepted 当运行完成。

## 14. 验证状态、风险与回滚

- **已完成：** 实际独立 shallow clone、固定 SHA/版本/许可、主仓精确基线核对、上述源码调用链与边界分析、本文静态自查。静态校验读取本地 clone 和 `git show <baseline>:<path>` 核对链接文件/行范围、固定 SHA、证据编号、基线一致性及空白；不等于 HTTP 链接可达性或运行行为验证。
- **可复查命令：** 在主仓运行 `python -I C:/Users/21022/AppData/Local/Temp/pi-desktop-ref-audit.aORS5cOg/check_report.py C:/pi-GUI/docs/parallel-runtime-reference-pi-desktop.md C:/Users/21022/AppData/Local/Temp/pi-desktop-runtime-ref.QGrG0RyJ C:/pi-GUI`；另运行 `git diff --no-index --check -- /dev/null docs/parallel-runtime-reference-pi-desktop.md`（Git Bash）。校验脚本由本研究编写，位于参考 checkout 之外，未加载参考代码。
- **静态检查实际结果：** 36 组证据编号；125/125 个固定源码链接的本地文件/行范围有效，覆盖 52 个唯一源码文件，错误 0；`git diff --no-index --check` 无空白错误输出（对新增文件相对 `/dev/null` 的差异返回退出码 1，不将它写成退出码 0）。初轮发现主仓 routes 文件末尾空行锚点越界，已改为有效行范围后复核。这些数字不是产品测试断言数。
- **基线证据：** 主仓 `ac812c6fa49dfd960867a5688ee6f61cb8ec5f67` 的 [CI run 45711901260](https://github.com/HYJ1817/pi-gui/actions/runs/45711901260)，push / attempt 1 / success；这是既有基线的证明，不是现场其他未提交修改、参考实现或未来专项修复的验收。
- **未运行：** PI-Desktop 编译/测试/真实发送/并发写入/崩溃实验；pi-GUI `npm test`、UI 渲染验收、build:exe/build:app。本文是纯文档且没有 UI/server/public 行为变更，故按测试政策跳过产品全量与产物重建。没有测试断言被新增、删减或重计。
- **仍未知：** 全产品活跃 session runtime 的统一硬上限；所有插件/远端/第三方 SDK 的运行行为；强杀、掉电、跨应用协作时的全部清理/一致性结果。不能从本次未观察到推断能力不存在。
- **主要风险：** 把对象并行当进程隔离、把文件锁当 shell/git 沙箱、把单轮权限占位当已生效、把缓存当历史或把重启当副作用重放，都会导致错误修复方向。
- **许可与实现约束：** PI-Desktop LGPL 源码仅用于理解机制；后续基于本仓接口和约束独立实现，不搬源码、不翻译移植其 runtime/SDK wrapper，不默认引入它的库或传染持久化格式。新增依赖或高风险权限设计仍须用户另行同意。
- **回滚：** 仅撤回本文的新增内容；不需要产品数据迁移或运行时回滚。本研究不提交、不推送、不创建 PR、不合并或发版。

## 15. 固定源码证据索引

以下包含实际文件路径、函数及行号；链接固定到完整 commit。一个编号可以有多个连续调用边界证据。

### PI-Desktop

- **P01 — 版本与依赖：** [package.json:1–9](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/package.json#L1-L9)；[packages/agent-runtime/package.json:1–43](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/package.json#L1-L43)。
- **P02 — 许可：** [LICENSE:1–17](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/LICENSE#L1-L17)。
- **P03 — Composer / renderer 发送 / preload：** [useComposerSubmit.ts:196–208](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/src/features/chat/composer/hooks/useComposerSubmit.ts#L196-L208)；[queue-slice.ts · sendPrompt:386–552](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/src/stores/slices/queue-slice.ts#L386-L552)；[api.ts · prompt:1245–1257](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/src/lib/api.ts#L1245-L1257)；[electron/preload/index.ts · invoke/on:15–31](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/preload/index.ts#L15-L31)。
- **P04 — main 准入 / durable turn / 用户行 / dispatch：** [agent-ipc.ts · agentPrompt:217–300](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/ipc/agent-ipc.ts#L217-L300)；[同文件:384–403](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/ipc/agent-ipc.ts#L384-L403)；[同文件:548–633](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/ipc/agent-ipc.ts#L548-L633)；[同文件:659–727](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/ipc/agent-ipc.ts#L659-L727)；[session-coordination.ts · acquireSessionOperation:171–190](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/runtime/session-coordination.ts#L171-L190)。
- **P05 — 共享进程句柄、Node launcher 与 Host spawn：** [runtime/context.ts:5–10](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/runtime/context.ts#L5-L10)；[main/agent-sidecar.ts · AgentSidecar:54–85](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/agent-sidecar.ts#L54-L85)；[host-runtime/agent-sidecar.ts:180–205](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/host-runtime/src/agent-sidecar.ts#L180-L205)；[host-process.ts:91–155](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/host-runtime/src/host-process.ts#L91-L155)。
- **P06 — runtime map / 复用 / 历史 / Pi Agent：** [agent-runtime/sidecar.ts · runtimeFor:244–377](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/sidecar.ts#L244-L377)；[runtime.ts · new Agent:2295–2340](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/runtime.ts#L2295-L2340)；[runtime.ts · firstMismatch:2905–2976](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/runtime.ts#L2905-L2976)；[sidecar.ts · testRuntimeIdentity:77–108](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/sidecar.ts#L77-L108)。
- **P07 — 独立 admission 与 durable busy 防线：** [agent-host-bridge.ts · runtime port:140–175](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/agent-host-bridge.ts#L140-L175)；[agent-host.ts · fields/defaults:177–236](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-host/src/agent-host.ts#L177-L236)；[agent-host.ts · startTurn/enqueueTurn:471–599](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-host/src/agent-host.ts#L471-L599)；[withAdmission:1176–1186](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-host/src/agent-host.ts#L1176-L1186)；[sessions.rs · begin_turn:4125–4164](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/sessions.rs#L4125-L4164)；[agent-host.ts · turn retention:1403–1418](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-host/src/agent-host.ts#L1403-L1418)。
- **P08 — prompt 的 accepted/异步结果、权限占位：** [sidecar.ts · agent.prompt:482–541](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/sidecar.ts#L482-L541)；[sidecar.ts · stdin RPC dispatch:700–730](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/sidecar.ts#L700-L730)。
- **P09 — thinking/text/tool、envelope、coalescer：** [runtime.ts · handleAgentEvent:8828–8940](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/runtime.ts#L8828-L8940)；[tool events:9324–9384](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/runtime.ts#L9324-L9384)；[emit:6984–7001](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/runtime.ts#L6984-L7001)；[stream-coalescer.ts:47–129](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/stream-coalescer.ts#L47-L129)。
- **P10 — 前台/后台分流、缓存不是存储：** [events-slice.ts:322–404](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/src/stores/slices/events-slice.ts#L322-L404)；[后台分流:501–527](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/src/stores/slices/events-slice.ts#L501-L527)；[session-runtime.ts · limits/cache/load:1–207](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/src/stores/runtime/session-runtime.ts#L1-L207)；[cacheBackgroundTranscriptEvent:369–384](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/src/stores/runtime/session-runtime.ts#L369-L384)。
- **P11 — 每 session launch 配置、项目/文件根：** [session-launch.ts · resolveAgentRuntimeLaunch:361–438](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/runtime/session-launch.ts#L361-L438)；[projectPath/workspaceRoot:511–533](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/runtime/session-launch.ts#L511-L533)；[sidecarParams/scratch:812–868](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/runtime/session-launch.ts#L812-L868)。
- **P12 — 不信任全局 cwd：** [rpc/mod.rs · resolve_tool_workspace:1430–1457](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/rpc/mod.rs#L1430-L1457)；[resolve_tool_workspace_for_call:1465–1506](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/rpc/mod.rs#L1465-L1506)。
- **P13 — 工具反向 RPC / 关闭 / auth 约束：** [runtime.ts · tools.execute:3844–3928](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/runtime.ts#L3844-L3928)；[parent-host-proxy.ts:23–125](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/parent-host-proxy.ts#L23-L125)；[host-runtime/agent-sidecar.ts · setHost/auth:389–445](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/host-runtime/src/agent-sidecar.ts#L389-L445)；[局部工具/response/call:580–683](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/host-runtime/src/agent-sidecar.ts#L580-L683)。
- **P14 — Host-owned authorization / permission 等待：** [rpc/mod.rs · authorization/cancellation:4410–4474](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/rpc/mod.rs#L4410-L4474)；[权限/root/request:4478–4657](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/rpc/mod.rs#L4478-L4657)；[decision/grants:4667–4765](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/rpc/mod.rs#L4667-L4765)；[permissions.resolve:5354–5374](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/rpc/mod.rs#L5354-L5374)；[执行前 shell identity 重验:4980–5021](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/rpc/mod.rs#L4980-L5021)。
- **P15 — 审批到 UI 再返回：** [runtime/host.ts · permissions.request:114–169](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/runtime/host.ts#L114-L169)；[agent-host.ts · approval/input ingest:331–350](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-host/src/agent-host.ts#L331-L350)；[interaction-slice.ts · resolvePermission:160–179](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/src/stores/slices/interaction-slice.ts#L160-L179)；[agent-ipc.ts · permission/ask resolution:933–972](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/ipc/agent-ipc.ts#L933-L972)。
- **P16 — Host canonical history / append / startup：** [transcripts.rs · base_dir/path:617–644](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/transcripts.rs#L617-L644)；[sessions.rs · get_session_with_options:1685–1743](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/sessions.rs#L1685-L1743)；[append_message_with_receipt:2367–2480](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/sessions.rs#L2367-L2480)；[db/migrations.rs · running→aborted:59–75](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/db/migrations.rs#L59-L75)；[state.rs · open/recover:110–140](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/state.rs#L110-L140)。
- **P17 — 文件协调层与工具预算：** [runtime.ts · PathMutex fallback:4178–4222](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/runtime.ts#L4178-L4222)；[tool_budget.rs · limits:9–39](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/tool_budget.rs#L9-L39)；[can_admit/reserve:253–309](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/tool_budget.rs#L253-L309)；[file_batches.rs · bounds/ownership:1–230](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/file_batches.rs#L1-L230)。
- **P18 — 跨 session 文件身份、准入、真实任务持锁：** [file_resources.rs:1–230](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/file_resources.rs#L1-L230)；[rpc/mod.rs · post-permission admission/validation:4767–4896](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/rpc/mod.rs#L4767-L4896)；[执行分流/传 permit:5063–5104](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/rpc/mod.rs#L5063-L5104)；[tools/mod.rs · run_file_tool:1210–1288](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/tools/mod.rs#L1210-L1288)；[file/Bash 分派:1352–1387](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/tools/mod.rs#L1352-L1387)。
- **P19 — background shell 所有权与配额：** [background_tasks.rs:1–39](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/background_tasks.rs#L1-L39)；[rpc/mod.rs · background turn-cancellation 例外:4431–4474](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/rpc/mod.rs#L4431-L4474)；[background_tasks.rs · session stop:173–198](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/background_tasks.rs#L173-L198)；[background_tasks.rs · background admission:271–306](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/background_tasks.rs#L271-L306)。
- **P20 — event persistence/checkpoint/stale guard：** [event-persistence.ts:110–184](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/runtime/event-persistence.ts#L110-L184)；[终态持久化:265–414](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/runtime/event-persistence.ts#L265-L414)；[inflight-checkpoint.ts:8–159](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/host-runtime/src/inflight-checkpoint.ts#L8-L159)；[session-coordination.ts · stale terminal:323–344](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/runtime/session-coordination.ts#L323-L344)。
- **P21 — durable outbox / 恢复次序：** [persistence-outbox.ts · limits/enqueue:34–110](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/persistence-outbox.ts#L34-L110)；[flushLoop/quarantine:179–268](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/persistence-outbox.ts#L179-L268)；[runtime/host.ts · boot drain/recover:425–438](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/runtime/host.ts#L425-L438)。
- **P22 — 共享 sidecar 故障域 / turn-aware cleanup / supervisor：** [runtime/sidecar.ts · settleCrashedSession:160–205](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/runtime/sidecar.ts#L160-L205)；[onExit:312–382](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/runtime/sidecar.ts#L312-L382)；[runtime-supervisor.ts:22–27](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/host-runtime/src/runtime-supervisor.ts#L22-L27)；[single-flight/restart loop:74–131](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/host-runtime/src/runtime-supervisor.ts#L74-L131)。
- **P23 — abort/graceful stop：** [transcript-slice.ts · abort:483–550](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/src/stores/slices/transcript-slice.ts#L483-L550)；[agent-ipc.ts · agentAbort:813–864](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/ipc/agent-ipc.ts#L813-L864)；[sidecar.ts · abort/stop:602–636](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/sidecar.ts#L602-L636)；[runtime.ts · abort/turn settlement:10084–10141](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/runtime.ts#L10084-L10141)。
- **P24 — Host restart / window-close / quit 次序：** [runtime/host.ts · onExit:368–407](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/runtime/host.ts#L368-L407)；[lifecycle.ts · supervisor/rebind:1–150](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/runtime/lifecycle.ts#L1-L150)；[bootstrap/shutdown.ts · close/confirmation:60–145](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/bootstrap/shutdown.ts#L60-L145)；[确认退出清理:162–235](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/bootstrap/shutdown.ts#L162-L235)；[settleRunningTurnsForQuit:258–299](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/bootstrap/shutdown.ts#L258-L299)；[host-process.ts · disposeInternal:371–390](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/host-runtime/src/host-process.ts#L371-L390)。
- **P25 — 运行资源最终清理：** [host-runtime/agent-sidecar.ts · dispose:686–708](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/host-runtime/src/agent-sidecar.ts#L686-L708)；[runtime.ts · dispose:10195–10229](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/runtime.ts#L10195-L10229)；[rpc/mod.rs · shutdown/drain:533–545](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/rpc/mod.rs#L533-L545)；[state.rs · shutdown:435–459](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/state.rs#L435-L459)。
- **P26 — native Pi SDK / event projection：** [native-pi-session.ts · NativePiRuntime:428–564](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/native-pi-session.ts#L428-L564)；[openRuntime:1339–1422](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/native-pi-session.ts#L1339-L1422)；[runtime/sidecar.ts · native 独立事件链:209–214](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/apps/desktop/electron/main/runtime/sidecar.ts#L209-L214)。
- **P27 — cooperative lease / manager 方法包装：** [native-pi-session-lease.ts:107–180](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/native-pi-session-lease.ts#L107-L180)；[guardNativePiSessionManager:246–275](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/native-pi-session-lease.ts#L246-L275)。
- **P28 — subagent 与 RPC 槽：** [subagent-definition.ts · MAX_SUBAGENT_CONCURRENCY:220](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/shared/src/subagent-definition.ts#L220)；[runtime.ts · 运行前检查:5394–5396](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/agent-runtime/src/runtime.ts#L5394-L5396)；[rpc/mod.rs · MAX_IN_FLIGHT_RPC:347–350](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/crates/host-core/src/rpc/mod.rs#L347-L350)。
- **P29 — RACP 默认限制：** [packages/shared/src/racp.ts · RACP_DEFAULT_LIMITS:501–524](https://github.com/vastsa/PI-Desktop/blob/71c637bf823dcec9c9eb3e33a8514826925cd436/packages/shared/src/racp.ts#L501-L524)。

### pi-GUI 指定基线

- **G01 — 身份、配额、Registry 创建：** [runtime-registry.js · OWNER_KEYS/createRuntimeRegistry:1–105](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-registry.js#L1-L105)；[snapshot:230–238](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-registry.js#L230-L238)；[launchRecord:425–475](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-registry.js#L425-L475)。
- **G02 — 独立外部 Pi adapter、投影、清理：** [session-runtime.js · projectRuntimeEvent:83–164](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/session-runtime.js#L83-L164)；[createSessionRuntime:167–230](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/session-runtime.js#L167-L230)；[send/approval/dispose:244–335](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/session-runtime.js#L244-L335)。
- **G03 — 组合根：** [server.js · sharedAdmission/factory:1438–1516](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server.js#L1438-L1516)。
- **G04 — 后台事件、Stop、history：** [runtime-registry.js · emit:241–384](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-registry.js#L241-L384)；[refreshSession:386–424](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-registry.js#L386-L424)；[command:521–587](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-registry.js#L521-L587)；[runtime-routes.js:1–76](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-routes.js#L1-L76)。
- **G05 — 官方 RPC 桥接与 Stop 屏障：** [rpc-bridge.js · LF-only/response 契约:1–24](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/rpc-bridge.js#L1-L24)；[rpc-bridge.js · args/env/spawn:248–294](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/rpc-bridge.js#L248-L294)；[readiness/response 配对:498–512](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/rpc-bridge.js#L498-L512)；[request/Stop:659–878](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/rpc-bridge.js#L659-L878)；[abortAndWait/reportWithin:880–954](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/rpc-bridge.js#L880-L954)。
- **G06 — 既有 shared-workspace scheduler：** [session-tool-scheduler.js · createSessionToolScheduler:8–79](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/session-tool-scheduler.js#L8-L79)。
- **G07 — focus 与确认清理：** [runtime-registry.js · focus/blur/retire:806–885](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-registry.js#L806-L885)；[closeAll/historyTarget:915–936](https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-registry.js#L915-L936)。
