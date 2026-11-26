# 多会话并行运行时：T3 Code 源码对照研究

研究日期：2026-11-26。性质：固定版本的静态源码研究，不是产品实现、运行验收或安全认证。

## 1. 范围、基线与获取证据

### 1.1 两仓版本

| 项目 | 固定版本与事实 |
| --- | --- |
| pi-GUI | `fix/parallel-session-runtime`，基线 `ac812c6fa49dfd960867a5688ee6f61cb8ec5f67`；核对时 `origin/main` 相同 |
| T3 Code | `https://github.com/pingdotgg/t3code.git`；获取时默认分支 `origin/main`，完整 commit `d5d5c17ecb1c7289dc50a6ac602197560e8668bf` |
| T3 commit | `fix(web,mobile): approval cards show characters a screen would not draw (#43049)`；提交时间 `2026-11-25 20:14:18 -0800` |
| 发布包标识 | [`apps/server/package.json:1–8`][meta-server]：包名 `t3`，版本 `0.1.12`，`license: MIT`；这不是从 Release 名称推算的版本 |
| monorepo / Pi 包 | 根 `package.json` 为私有 `@t3tools/monorepo`，无独立 `version`；[`packages/provider-pi/package.json`][meta-pi] 为私有 workspace 包，无独立 `version`、`license` 字段 |
| 仓库许可证 | [`LICENSE:1–21`][meta-license]：MIT，Copyright (c) 2026 T3 Tools Inc.；若以后直接移植实质代码，须保留相应版权和许可声明。本记录只提炼机制，未复制实现 |

实际下载位置为系统临时目录下独立新目录：

```text
C:\Users\21022\AppData\Local\Temp\pi-gui-t3-audit-d33cf32ae8b541a9a7ef65cc68d2c442
```

执行了 `git clone --depth 1 https://github.com/pingdotgg/t3code.git <上述新目录>`。
对象获取成功，但首次 checkout 在 `.repos/alchemy-effect/.../migrations/snapshots/...` 报
`Filename too long`，Git 明确报告 `Clone succeeded, but checkout failed`。
随后在**该临时仓**设置 cone sparse-checkout，并执行定向恢复：

```text
git -C <上述新目录> sparse-checkout init --cone
git -C <上述新目录> sparse-checkout set apps packages docs
git -C <上述新目录> -c core.longpaths=true restore --source=HEAD --staged --worktree -- apps packages docs package.json LICENSE pnpm-lock.yaml
```

因此证据是“浅克隆对象 + 已恢复研究路径”，不是“完整工作树 checkout 成功”。
`git rev-parse HEAD` 和 `git symbolic-ref refs/remotes/origin/HEAD` 实际分别返回上述完整 SHA 与
`refs/remotes/origin/main`。未覆盖或使用主仓已有 `.t3-ref/`。

下载内容始终作为不可信数据：只读源码/元数据，没有安装依赖、执行脚本、import 模块、启动 T3、调用模型或运行真实 Pi；没有从下载目录启动解释器或构建工具。
本子任务不创建下级代理，不修改真实用户会话，不修改测试注册，不 commit/push/创建 PR。

### 1.2 pi-GUI 基线证明的有效范围

实际运行 `git status`、`git log`、`git fetch origin`、`git tag --list`、Release 列表及精确 SHA CI 查询。
基线 [CI run 45711901260](https://github.com/HYJ1817/pi-gui/actions/runs/45711901260)：

- `headSha = ac812c6fa49dfd960867a5688ee6f61cb8ec5f67`，`event = push`，`attempt = 1`，`conclusion = success`。
- **8/8 个 job 成功**：Validate complete test plan、Electron build check、Tests (ui/core/security/faults/native)、CI gate。
- [CI gate job](https://github.com/HYJ1817/pi-gui/actions/runs/45711901260/job/139557059110) 成功。这里的 8 是 job 数，不是断言数；本研究未取得各 suite 断言总数。
- 已核对的最新 Release 为 `v0.35.1`。Release 只用于基线勘察，不代替精确 SHA CI。
- **本研究未运行本地测试或 T3 测试**。本次只新增研究 Markdown，不改变产品行为、测试链或发布输入，按 `docs/testing.md` 的纯文档政策跳过完整 `npm test`；基线 CI 不证明主代理正在制作的行为修复。

## 2. 勘察结论：适合复用什么，哪些设想需要修正

1. **并行的单位是后端持有的运行实例，不是 UI 当前选中项。** T3 在发送入口捕获目标 thread，后端以 thread/run/attempt/provider session 归属调度；切换显示页不会把旧请求重定向到新页。
2. **不能把通用 provider 能力投射给 Pi。** T3 Pi adapter 明确不支持一个 provider session 同时挂多个 app thread；它把外部 Pi RPC 连接置于独立 session scope。其他 provider 的 multiplex 不等于 Pi 的能力。
3. **pi-GUI 不是从零开始。** 基线已有 `RuntimeRegistry`、完整 owner/generation、每 session 独立 bridge/supervisor、停止屏障、硬资源限额及共享工作区工具协调。修复应打通这些现有边界，而不是换一套 Effect/SQL/runtime 系统。
4. **调度槽、会话数、进程树、队列预算是不同上限。** T3 默认 4 个 effect worker 不是“最多 4 个 Pi”；Linux 可选 cgroup 有另一层资源保护，Windows/macOS 不继承该保护。
5. **T3 的 workspace lease 不是整个回合的文件写锁。** 它覆盖启动/清理/Git 的特定临界区；另有 restore admission 与 shared-checkout 检查，但不能替代 pi-GUI 的 tool scheduler，更不能约束任意 Shell/Git 或外部进程。
6. **借用原则，不借用更宽松的产品策略。** T3 注入权限扩展、跨供应商 handoff、accept-for-session、自动续跑、原始 cause 日志均有其产品前提，不能因此扩大 pi-GUI 的授权或隐私边界。

以下链接全部绑定固定 commit；文件/函数与行号才是结论依据，不以 README 代替。

## 3. 完整调用链索引

下表列出实际读取的生产路径。`apps/server/src/orchestration-v2/` 下的服务简称只在表内缩写。

| 阶段 | 源码、关键函数与行号 | 已证实的交接 |
| --- | --- | --- |
| UI 发起 | [`apps/web/src/components/chat/useComposerSend.ts:980–1009,1453–1582`][send-ui] | 捕获 `threadIdForSend` 和 composer snapshot；`startThreadTurn` 携带该目标，清 UI 时还检查当前 route 是否仍相同 |
| client command | [`packages/client-runtime/src/operations/commands.ts:782–912`][send-client]；[`dispatchMessage:353–375`][send-resend] | 分配 commandId，按 thread/message 持久附件；新 thread 走 `launchThread`，已有 thread 走 `message.dispatch`；断线重送复用该 command |
| WS admission | [`apps/server/src/ws.ts:2058–2109`][send-ws] | 经 `startup.enqueueCommand`；服务端补 creation provenance、检查 sender scopes；非 preparation retry 交 `ThreadMessageIntake.dispatchCommand` |
| attachment / provider admission | [`ThreadMessageIntake.ts:224–279`][send-intake]；[`ThreadManagementService.ts:849–853`][send-management] | claim 附件、处理重放后的 unused claims；确认 transcript/目标 provider 后才调用 `orchestrator.dispatch` |
| 同 thread 顺序 | [`Orchestrator.ts:16838–16914`][schedule-lock]；[`ThreadCommandExecutor.ts:19–31`][schedule-executor] | message intake 与 dispatch 按 thread 加锁；fork/delete 等还锁相关 thread。不是拿 UI selection 当全局运行锁 |
| 规划命令 | [`Orchestrator.ts:7294–7320`][schedule-message]、[`9950–10054`][schedule-plan] | 读取目标 thread 投影，形成 message/run/node 等事件与 `provider-turn.start` effect；queue、steer、restart 有不同分支 |
| durable acceptance | [`Orchestrator.ts:16547–16603,16727–16754`][schedule-receipt]；[`EventSink.ts:788–896`][persist-command] | command receipt 去重；事件、投影、effect outbox、receipt 同事务提交，随后通知/发布 |
| effect 调度 | [`EffectOutbox.ts:348–400,586–638`][schedule-outbox]；[`EffectWorker.ts:123–130`][worker-start]、[`1059–1142`][schedule-worker] | SQL claim 按同 thread 的 running/更早 pending 排序；worker 的 start effect 调用 `ProviderTurnStartService.start` |
| 启动 / cwd / session | [`ProviderTurnStartService.ts:972–1105,2416–2530`][start-provider]；[`RuntimePolicy.ts:148–199`][start-policy] | 绑定 run attempt，检查 abandoned turn；从已登记 thread/project 推导 cwd；打开/复用指定 providerSessionId |
| runtime 复用/新建 | [`ProviderSessionManager.ts:3240–3423`][session-open] | 按 providerSessionId 单飞；存在则复用 exposedRuntime，否则 adapter.openSession + session scope + event pump + idle timer |
| Pi / process | [`packages/provider-pi/src/server/adapter.ts:495–606`][pi-open]；[`mcpInjection.ts:249–324`][pi-launch]；[`rpc.ts:213–310`][pi-spawn] | 构造外部 `pi --mode rpc`，固定 cwd/env，注入 T3 扩展，AgentScope.wrap，spawn 后立即登记 finalizer |
| native session 绑定 | [`adapter.ts:3140–3304`][pi-register] | `get_state` 确认；必要时 `switch_session` / `new_session`；providerThread 的 native ref 是 Pi session file，不是 UI thread |
| prompt / streams / tools | [`adapter.ts:3496–3694`][pi-turn]、[`2280–2384`][pi-events]、[`1405–1523`][pi-tools]、[`2431–2442`][pi-tool-events] | 安装当前 active turn 后发送 prompt；message delta、toolCallId、parentToolCallId 都由捕获的 turn 生成带归属的 domain event |
| RPC request / response | [`rpc.ts:294–335,433–478`][pi-rpc]；[`adapter.ts:2664–2714`][pi-ack] | 私有 request id → Deferred；prompt ACK 另外按 prompt id/turn 配对；stream 不等价于 request response |
| approval / question | [`adapter.ts:1889–2001`][pi-approval]、[`3819–3901`][pi-approval-response]；[`RuntimeRequestService.ts:78–123`][approval-service] | runtime request 绑定 thread、native request、live provider session；持久决策后 effect 再送回对应连接 |
| ingest / publish | [`RunExecutionService.ts:412–590`][run-routing]、[`1244–1281`][run-subscription]、[`1817–1856`][run-ingest]；[`ProviderEventIngestor.ts:775–820`][event-ingest]；[`EventSink.ts:545–681`][persist-owner] | run/attempt/providerThread 归属过滤；normalize 后进入对应 sink，关键写入事务内重核 owner，commit 后发布有序 sequence |
| stop / crash | [`adapter.ts:3756–3818`][pi-stop]、[`2843–2968`][pi-pump]；[`rpc.ts:198–310`][pi-spawn] | exact turn stop，clear_queue 后 abort；压缩/恢复可终止连接；transport failure 清 pending、终结事件流，再由 session manager release |
| restart recovery | [`serverRuntimeStartup.ts:422–498,544–577`][startup-order]；[`ProviderRuntimeRecoveryService.ts:1094–1248`][recovery-service] | recovery 在 effect worker 之前；区分 lost process 工作、未接受消息、可重放工作和设置允许的 continuation |
| server/app 退出 | [`DesktopLifecycle.ts:94–189`][shutdown-desktop-life]；[`DesktopApp.ts:164–173`][shutdown-pool]、[`448–468`][shutdown-desktop-app]；[`serverRuntimeStartup.ts:471–498`][startup-order] | 等待 backend scopes stop；server 关闭 command gate/worker，准备 continuation，关闭全部 provider sessions，再落 shutdown reconciliation |

## 4. 身份、复用和项目隔离

### 4.1 不应合并的身份

- **selected/active UI thread**：当前编辑/显示目标。发送入口将其快照成 `threadIdForSend`；上传、worktree 准备之后不能重新读取 selected thread 决定归属。[UI 证据][send-ui]
- **app thread**：持久对话、project、worktree 与 run 的归属。
- **provider instance**：某种 driver 的一份配置/账户实例；[`driver.ts:77–142`][pi-driver] 的 `supportsMultipleInstances: true` 不表示单个 Pi 进程可同时服务所有对话。
- **provider session / runtime**：live adapter 资源。`ProviderSessionManager.open` 按 providerSessionId 复用的是 runtime，不是“当前可见 thread”。它拒绝把另一 app thread 附到不支持 multiplex 的 runtime。[open 检查][session-open]
- **provider thread / native session**：adapter 当前绑定的 native conversation。Pi `threadState` 是单值，register 时必须无 active turn；恢复文件由 `get_state` 复核。[registerThread][pi-register]
- **run / attempt / provider turn**：一次用户任务、其中一次执行尝试、provider 的一次回合。Pi 没有可用的原生 turn id，T3 使用包含 `attemptId` 的合成弱身份，而非把 native session 文件当 turn。[capabilities][pi-capabilities]、[startTurn][pi-turn]

这些身份独立，才允许“不显示的 A 继续运行，显示中的 B 独立发送”，同时不把 A 的 completion/approval 写进 B。

### 4.2 cwd 不是 UI 的全局状态

`RuntimePolicy.resolve` 使用 `thread.worktreePath ?? registeredProject.workspaceRoot`，随后 Pi `openSession` 把该 cwd 传给进程；不依赖用户之后选中了哪个项目。[policy][start-policy]、[Pi open][pi-open]

Pi 恢复还要考虑**session header 的 cwd**：T3 先读 header，跨 cwd 时不直接当 initial session 启动。
其 `forkSessionIntoCwd` 使用另一个短命、禁用扩展/工具的 Pi RPC 进程，加原生 CLI `--fork`，由 Pi 自己创建目标 session file，再 `get_state` 验证文件不同。[`adapter.ts:2971–3025`][pi-cwd-fork]
这不是手写 Pi JSONL 格式；也不是“改 process.cwd 就完成跨项目恢复”。不过这种 handoff 产品行为不应在本次 pi-GUI 修复中顺带引入。

Pi native session 恢复与 capability `turns.supportsNativeResume: false` 是不同概念：后者是 provider turn 能否原生续跑，不是否定 `--session` / `switch_session` 的磁盘会话恢复能力。

## 5. 调度、持久化和迟到事件

### 5.1 调度和 acceptance 的两个阶段

`dispatch` 只规划/提交，不在 renderer 请求里持有整个 provider 回合。commandId 用于重送去重；`EventSink.commitCommand` 的事务内依次：

1. `commandReceipts.insertIfAbsent`；若已存在，返回原 receipt 与 stored events。
2. normalize/append events，更新 projections。
3. enqueue effects，更新 accepted receipt，必要时取消旧 effects。
4. **commit 后**发 cancellation/available 信号和 stored events。

`commitThenPublishNow` 使用 SQL transaction 与单 publish lane，防止后提交事件先发布导致客户端 sequence 倒退；该 lane 不是单一 provider 运行锁。[receipt][persist-command]、[`EventSink.ts:316–355`][persist-order]

Outbox SQL claim 不允许同 thread 的同类工作越过 running/更早 pending；标题生成与非标题 effect 分开排序。
`claimNext` 原子 UPDATE/RETURNING 写 `lease_owner`，完成/重试还核 `lease_owner`。不能把 worker 的一次本地超时等同于释放了该 thread 的 durable ownership。[claim][schedule-outbox]

pi-GUI 不需要为了这一点引入 Effect、SQLite 或跨 provider 事件系统。对应的最小原则是：区分“请求已接受 / 正在运行 / 权威终态 / 结果未知”，持久 metadata 与 live runtime 不互相冒充。

### 5.2 多层迟到事件防护，而非只比 threadId

- **connection 层**：Pi pump 捕获 `activeConnection`；take 后若连接已换就丢弃旧记录，旧 transport error 也不能杀新连接。[pump][pi-pump]
- **adapter 层**：active turn 安装、prompt ACK、settle probe 带 providerTurnId/对象身份；开始新 turn 前等上一批 prompt response drained。slash command 可能等交互对话框，不能持锁等 ACK 把 event pump 堵死。[startTurn][pi-turn]、[ACK][pi-ack]
- **manager 层**：`markBusy` 检查 Map 中 runtime 是同一个对象；busy key 是 `providerThreadId#runOrdinal`，旧回合 idle 不会直接删除新回合 busy。session-scoped artifacts 写入与 stream 结束都再核 `current.runtime === entry.runtime`。[busy/idle][session-busy]、[pump 路由][session-pump]
- **run 层**：订阅在发 prompt 前建立；`routeProviderEvent` 依据 run/attempt/providerThread 和已拥有的 child 关系过滤，不按当前 UI 选择转发。[routing][run-routing]
- **持久化层**：`writeIfRunCurrent` 在事务里检查 run.status + activeAttemptId；终态后的 provider-thread 更新由 `writeIfProviderThreadOwner` 再核 lastRunOrdinal，避免旧尝试覆盖替代尝试。[事务 guard][persist-owner]

**协议残余限制**：Pi capability 将 native turn identity 标为 weak；不能声称每个原始 JSONL 事件本身都有不可伪造的 turn epoch。连接隔离、active-turn 单飞、ACK drain、idle 回读是建立归属的条件，不是给无标签原始事件凭空补出上游证据。

### 5.3 stream、tool 与 approval 不是一个 pending Map

`rpc.request` 的 `t3-N` 私有 ID 对应 Deferred；transport 失败一次性 fail 所有 pending 并 fail outgoing/events。
未匹配 RPC response 和 stream 进入 event queue。adapter 发出的 `t3-prompt-N` 另有 ACK 队列，不能以 prompt ACK 推断整个 turn 结束。[RPC][pi-rpc]、[ACK][pi-ack]

`emitToolItem` 从 active turn 提取归属，用 toolCallId 和 parentToolCallId 组织节点；Shell 输出 delta 以 threadId/itemId 路由，manager 让大体积 live output 绕过持久化和业务 subscriber，避免拖慢 domain event。[tools][pi-tools]、[`ProviderSessionManager.ts:3013–3025`][session-pump]

`handleExtensionUiRequest` 可在 active turn 之前处理启动期交互：threadId 从 turn、已绑定 providerThread、openSession input 依次确定，responseCapability 固定为当前 live providerSessionId。
因此不能用“没有 activeTurn 就丢弃所有事件”代替生命周期分类。[request 构造][pi-approval]

回审批时，`RuntimeRequestService.respond` 要求 durable request 已 resolved、能力仍为 live、providerSessionId 相同且 session 仍在；adapter 再查 pendingPrompts/过期时间，映射回原 nativeRequestId。
**重启后旧卡片仍可显示，不代表新进程能接旧 callback。** [service][approval-service]、[adapter response][pi-approval-response]

## 6. stop、崩溃、恢复和退出

### 6.1 停止不是 stdin 写成功

Pi `interruptTurn` 要求 exact providerTurnId。普通路径先 `clear_queue` 再等待 `abort` request；否则已排 steering/follow-up 可能继续唤醒 agent。
压缩、settling、需要 runtime restart 的路径会读回 session/tree refs 后 terminate connection。
`agent_settled` 后也会 probe `get_state`，确认非 streaming、非 compacting、pendingMessageCount 为 0 才 finalize。[stop][pi-stop]、[`adapter.ts:2592–2663,2825–2858`][pi-settle]

在复用 native conversation 前，`ProviderTurnStartService` 检查 abandoned provider turns，先中断**那一条旧 turn**，再以当前 attempt guard 修复 projection；不是把旧 projection 改成 finished 就直接向同进程发新 prompt。[`972–1105`][start-provider]

T3 transport 的 POSIX 路径用进程组，升级信号前检查原 child 是否已退出；Windows 用 system32 `taskkill /PID /T /F`。这比只杀 shell 多一步，但源码本身不等于跨平台“全部后代已停止”的运行证明，尤其不能以 PID 存在性代替 owned guardian 身份。[`rpc.ts:193–292`][pi-spawn]

### 6.2 crash / restart 的 durable reconciliation

Pi pump 遇非预期 transport failure 将 runtime retired、fail pending barriers，并给 active turn 生成失败终态；空闲/主动 stop 与工作中异常分开。manager 核当前 runtime 后才 release，旧 stream 结束不释放替代 runtime。[Pi pump][pi-pump]、[manager][session-pump]

启动顺序为 legacy shells import → runtime recovery → delegated task recovery → effect worker → auto-bootstrap。
command gate 未 ready 时排队，ready 后直接执行各请求；并不是所有运行永远串过 startup queue。[`serverRuntimeStartup.ts:103–146`][startup-gate]、[有序启动][startup-order]

Recovery 不是“所有 running 改 idle 并自动重发”：

- `EffectOutbox.reconcileAfterProcessLoss` 取消进程绑定的 pending/running effects，只重排白名单里的 replay-safe running effects。[`EffectOutbox.ts:553–584`][recovery-outbox]
- 仍待 live callback 的请求在 startup 标 expired、shutdown 标 cancelled，responseCapability 变 not_resumable；可转为 message 的 question 有另外的恢复分支，不能笼统说全部交互被删除。[`ProviderRuntimeRecoveryService.ts:649–675`][recovery-requests]
- 未开始/未被 provider 接受的消息与已执行工作分开处理。先 drain 旧 outbox，再写 resends，避免 crash 窗口把未发送消息丢失。[reconcile][recovery-service]
- `continueThreadsAfterServerUpdate` 由全局/项目设置决定；只有符合条件的 run 才构造 `provider-runtime.continue`，并记录 processLossCount。它不是通用、无条件的自动恢复承诺。[`990–1032`][recovery-continuation]

pi-GUI 不应为了参考 T3 就新增自动调用模型或未知结果重放。网络/模型续跑和恢复后的写入必须仍受本仓既有授权策略约束。

### 6.3 app shutdown 链与实际保证的边界

1. Desktop `handleBeforeQuit` preventDefault，flush bounds、request shutdown、等 complete 再允许 quit；重复退出超过 10 秒可走显式强制退出。updater-controlled quit 是独立分支，不能用普通 quit 的保证概括它。[lifecycle][shutdown-desktop-life]、[`DesktopLifecycle.ts:263–329`][shutdown-desktop-special]
2. `DesktopApp` scope finalizer 并行 `stopAllPoolInstances`，随后 flush renderer history / markComplete。backend stop 先禁 restart，再 close active run scope；配置 SIGTERM 和 5 秒 graceful budget。[app][shutdown-desktop-app]、[pool stop][shutdown-pool]、[`DesktopBackendManager.ts:329–364,508–519`][shutdown-backend]、[`1198–1283`][shutdown-backend-stop]
3. background service launcher 的另一条路径：`terminateChild` 可先通过 IPC 发 `{type:stop}`，Windows 默认如此，因为 `kill()` 会跳过 finalizers；5 秒后升级强杀。child 的 `awaitServiceLauncherStop` 使 server effect interrupt。[`serviceLauncher.ts:787–804,925–949`][shutdown-service]、[`cloud/serviceLauncherClient.ts:245–258`][shutdown-ipc]、[`cli/server.ts:19–44`][shutdown-cli]
4. server finalizer 先 fail command gate、interrupt effect worker；`prepareForShutdown` 的 ensuring 关闭 provider sessions，然后 `reconcile("shutdown")`。session manager 枚举所有 live entry 并行 release，并关闭 session scopes。[server 顺序][startup-order]、[`ProviderSessionManager.ts:3211–3235`][shutdown-sessions]
5. Pi spawn 后立即登记 finalizer；关闭连接先 fail transport/pending，再终止进程；有 Linux scope 时进一步 reap detached work。[Pi open][pi-open]、[RPC finalizer][pi-spawn]

**不可夸大**：manager 的 `closeScopeWithin` 30 秒到点会 warning 并后台等迟到清理，而 live Map entry 已先移除；launcher 可在 5 秒强杀。
这是一套有预算/降级的退出机制，不是“Map 删除或超时即证明进程树消失”。desktop launcher loss 的父 PID 检查还明确跳过 Windows；其语义也不能冒充所有平台的 guardian。[`ProviderSessionManager.ts:1445–1515`][session-release]、[`launcherWatch.ts:18–68`][shutdown-launcher-loss]

## 7. 运行资源上限：已经证实与仍未知的部分

| 层次 | 固定源码事实 | 不能据此声称什么 |
| --- | --- | --- |
| effect worker | 默认 concurrency 4；等 30 秒后槽位可继续 claim，原 execution 保持 running row 并继续运行；标题最多占 concurrency−1 | 不是 provider session/process 总数硬限，也不是超时取消 provider |
| idle 生命周期 | 通用默认 2 分钟；不支持 native turn resume 的 runtime 默认 30 分钟；max idle pin 默认 4 小时。Pi 的 native turn resume 为 false，所以默认走后者，除非 options 覆盖 | 不是忙碌进程预算，不是“切换 UI 就立刻释放” |
| RPC/adapter 队列 | Pi RPC `events`、`outgoing` 与 adapter events 明确是 `Queue.unbounded` | 单帧有限不等于队列总内存有限 |
| 协议帧 | `MAX_PI_RECORD_CHARS = 2 * MAX_TOOL_OUTPUT_IMAGES * MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH + 8MiB`；超限丢到下一 LF；计量是 JS 字符数 | 不应与 pi-GUI 的 byte budget 混用单位，也不能推成总输出预算 |
| 通用 live session 数 | 已读 `open` 的主 admission 路径未见通用 count guard；shutdown 注释出现“up to 15 sessions” | 本研究**未证实**固定全局硬 cap；不能把注释当作 15，也不能从未搜到推成全产品绝无其它上限 |
| Linux OS 资源层 | 可用 systemd user manager 时有 agent slices、scope stop、MemoryHigh/MemoryMax、CPU/IO weight 与 TasksMax；非 Linux 为默认 no-op，探测失败也降级 | 不是 Windows/macOS 的资源保证，更不是文件/网络 sandbox |

证据：[worker][schedule-worker]；[`ProviderSessionManager.ts:81–101`][session-idle]、[`581–589`][session-idle-choice]；[Pi queues/framer][pi-rpc]、[`rpc.ts:115–148`][pi-framing]；[`adapter.ts:625–744`][pi-state]；[Linux scopes][os-scope]、[默认 AgentScope][os-default]。

Linux 细节值得单独保留，避免把 T3 误述为完全没有 OS 保护：

- `apps/server/src/process/agentScope.ts:101–104` 非 Linux 返回默认实现；Linux 需要 XDG_RUNTIME_DIR、systemd-run/systemctl 与成功 probe。
- agent slice 的 `MemoryMax = max(totalRAM−4GiB, floor(totalRAM*0.75))`；有 swap 时 `MemoryHigh = max(totalRAM−6GiB, floor(totalRAM/2))`，无 swap 时 High 为 infinity；每次 launch 重核 RAM/swap。父 slice 设置 CPUWeight=10、IOWeight=10、TasksMax=25%。这些是共享 agent 资源策略，不是“每个会话固定 X MB”。
- stateDir 派生 owned slice；启动时先尝试停止上次 server 遗留 agent，再做 recovery。无法读取/停止会记录警告，不能当作跨平台严格清理证明。
- scope 可以清理 setsid 逃离普通 process group 的后代，但不设置文件/网络访问权限；wrap 的 fallback 只调整 OOM 倾向或直接运行。

[实现与公式][os-scope]、[`stopLeftoverAgents:129–158`][os-leftover]、[`wrap:425–470`][os-wrap]、[server 实际装配 `server.ts:1445`][os-wire]。

## 8. 工作区写入协调，以及 Shell / Git 的能力边界

T3 不是完全不做协调，而是有**不同范围**的协调：

1. `withWorkspaceLease(cwd)`：进程内 Map + semaphore；用于具体工作区操作。turn-start reservation 对 restore 互斥，但两个 turn-start 彼此不冲突；canonical path 包括父子重叠及 symlink alias。[`workspace/workspaceLease.ts:7–114`][workspace-lease]
2. `ProviderTurnStartService.start` 在该 reservation/lease 内做 startup，返回的长期 provider execution **在 lease 释放后运行**。源码注释明确写 `Only startup holds it`。[启动边界][start-provider]
3. `isCheckpointRestoreIsolated` 检查 worktree、其它 thread/sidechat、provider cwd、未终结工作；root/shared workspace 不自动获得全 checkout restore 权限。它是 restore 的 admission/rollback 安全检查，不是每个工具的写锁。[`CheckpointRestoreSafety.ts:17–65,178–200`][workspace-restore]
4. `GitWorkflowService.withCheckoutLease` 按 repository root realpath 协调 create/switch ref；WS 的 createRef(switch)/switchRef 先 `assertCheckoutIdle`，检查包括 archived 的活跃 thread 与同 checkout 嵌套项目。[`GitWorkflowService.ts:201–206,538–552`][workspace-git]、[`ws.ts:3433–3449`][workspace-git-ws]、[`sharedCheckoutGuard.ts:41–100`][workspace-git-guard]

这些代码不提供以下保证：

- 任意 Bash/PowerShell 中的 `git checkout/reset/clean`、后台进程、编辑器或另一个应用都会走 T3 WS/GitWorkflowService。共享 checkout guard 自身还明确在部分查询失败时 fail-open；不能机械复制为本仓 fail-closed 写入许可。
- 不同 worktree 等于 OS sandbox。它分开常见工作文件/索引/HEAD，但命令仍以同一用户权限访问绝对路径，Git 还存在共享仓库元数据、对象/refs 和其它公共资源。
- Git checkpoint 是任意工具、网络调用、外部目录写入、数据库或后台子进程副作用的通用事务/撤销。
- 获得某次 tool approval 等于持有整个 shell 生命周期的目录独占锁，或可以安全撤销其它会话已经完成的写入。

T3 Pi capability 本身写的是 `runtimePolicy.enforcement: "client-boundary"`。
其注入扩展用公开 `tool_call` hook：full-access 放行、已分类 read-only 放行、auto-accept-edits 放行 edit/write，其余请求 `ctx.ui.confirm`；只读 MCP 还验证工具来源。[capability][pi-capabilities]、[`mcpExtensionSource.ts:343–382`][permission-hook]
这说明**扩展许可、工作流协调、文件 restore、OS 资源限制是四个不同层次**，不能合并成“它有 sandbox 所以同目录安全”。

## 9. pi-GUI 基线已经具备的对应能力

下表链接固定到 pi-GUI 基线，不包含其它并行作者的新 diff。

| 现有模块 | 已有抽象与证据 | 对本次修复的约束 |
| --- | --- | --- |
| `server/runtime-registry.js` | `records` 持久 conversation 与 `lives` 分离；manifest 闭合 schema、最多 256 records、临时文件原子 rename；`owner/resolve/belongs` 验完整 owner，不能只传 conversationId。[48–106][gui-owner] | 不另建第二个 selected-thread → process 真相，不弱化 owner 形状 |
| 同文件 `launchRecord` | 校验 workspace；按 canonical root lease；project 共享需 `sharedAdmission`；总数含 `externalCount`，默认 2、显式第三个、硬限 3；factory 注入 cwd/workspace/isCurrent/getOwner。[425–474][gui-launch] | 不能用 per-thread lock 替换全局 admission 后让上限/manifest/lease 竞态；并行不意味着取消控制面原子性 |
| 同文件 `emit` / `events` | bridgeRun 过滤/换代，runtimeGeneration 更新；事件带 owner/sequence，默认每 live 200 条/1MiB，溢出要求 history；pending/approval 有上限。[237–379][gui-events] | 后台状态和 stream 必须保留 captured owner，不按 UI selected 重写 |
| 同文件 `focus/blur` | focus 是显示与浏览器资源归属；它没有关闭其它 Pi；旧/新行状态均发布。[806–830][gui-focus] | 切页不得变相 stop/dispose 或让所有命令落向一个全局 bridge |
| 同文件 `refreshSession` | 私有 `get_state` 比对 native session、locator 和文件 identity，防双 live 占同 native session。[386–423][gui-session] | 恢复必须复用已证明的 locator，不让 renderer 传任意 sessionPath，不靠 `--continue` 猜目标 |
| `server/runtime-browser-launch.js` | `createRuntimeBrowserGateway` 分开 focus 与 allocate/dispose；分配时捕获 owner 对应的 browser scope，私有 loopback/token 通道传递该 scope，repoId 只因不是 browser scope 维度而移除。[5–30][gui-browser] | 浏览器焦点切换与 Pi 生命周期分开；不得把 focused browser 等同唯一可运行会话 |
| `server/runtime-routes.js` | command/read/close/restart/events/process 都走 registry 和 owner；process action 在 await 后再核同 adapter，异常只公开固定 code。[35–74][gui-routes] | 不新增绕 registry 的“当前会话快捷入口” |
| `server/session-runtime.js` | 每次 factory 单独 runtime + supervisor + bridge；`autoRestart:false`、`PI_NO_CONTINUE:1`，证明后的显式 session；read/send await 前后核 current，审批 Map 绑定该 runtime。[167–277][gui-adapter] | Pi 独立连接已存在，修复优先沿此 factory/guard 体系接通 |
| `server/rpc-bridge.js` | backend 私有数字 request ID，LF/CR 分帧，output byte budget；spawn 还需 `get_state` 就绪确认；退出清 pending；通用桥 autoRestart 可退避，而 session adapter 明确关闭自动重启。[428–605,659–701][gui-rpc] | 不把进程 spawn、HTTP accepted、stdin write 或 transport reconnect 当 provider ready/turn success |
| 同文件 `abortAndWait` | 单飞 stop barrier，先 pause/cancel 资源、clear_queue、abort；超时保留屏障，迟到 abort 还要匹配本轮 request ID。[767–937][gui-stop] | 不退化成 T3 代码片段式 fire-and-forget，也不在 timeout 后释放新 prompt |
| `server/pi-supervisor.js` | 独立 token 私有 transport，bounded frames/input，owned Job/process-group guardian；stop 等 guardian 与 completion，不以 PID 当资源身份。[15–137][gui-supervisor] | 不换成裸 taskkill/PID 存在性；保留所属资源的停止确认 |
| Registry `retire` + adapter `dispose` | 先 generation invalidation，再等 factory/adapter/resource cleanup；失败 `cleanup_pending` 保留 slot/lease；adapter 只有所有 owned dispose 完成才 cleanupConfirmed。[831–858][gui-retire]、[`session-runtime.js:323–335`][gui-cleanup] | 不照搬 T3“先删 Map，scope close 超时后台继续”等于资源已释放的假设 |
| `server/session-tool-scheduler.js` | root realpath + dev/ino/birthtimeMs，目录重叠 channel 协调；proven read 可绕写队列，未知工具/shell 走 writer；pause 只取消未 grant，cleanup confirmed 才释放 active ownership。[1–80][gui-tools] | 不以 T3 startup lease 替代整合好的 tool dispatch 协调；它本身也明确不是外部进程/OS sandbox |
| `server.js` shutdown | 标 shuttingDown，dispose primary guard/candidate/runtime registry 等，再关 SSE/主 bridge/managed processes；owned guardians 也是后端 EOF 清理边界。[1991–2033][gui-shutdown] | 全局退出须覆盖每个 live，不只“最后显示的 session” |

一个细节必须保留：`rpc-bridge.js` 是可注入的通用桥，其 `stop()` 发起关闭本身不返回“全部清理已确认”；session 级确认来自 supervisor/adapter dispose 与 Registry retire。
不能把任何一层的名称当作下一层已完成的证明。

## 10. 可复用原则与不适合机械移植之处

### 10.1 建议由主实现沿现有模块落实的原则

1. **发送快照固定归属。** 在任何上传、兼容探测、工具门控 await 前捕获目标 owner；之后使用 captured owner，await 后重核；旧 generation 的成功也不能升级当前 generation。
2. **每 live 自己持有桥和资源。** stream、RPC pending、tool approvals、browser/managed process/token/cleanup 都随该 live 生命周期，而非 UI selected。
3. **单会话有序，不同会话可推进。** 对同一会话的 start/stop/turn mutation 保持顺序；全局 admission/manifest/shared-directory 等真正共享状态仍保留协调，不能为了并行把所有锁删掉。
4. **停止/恢复保留未知态。** clear_queue/abort/readback/cleanup 证据各自独立；超时不是否定存在，也不是成功；旧 turn 不明确停下前不能复用其 writable native session。
5. **资源预算覆盖所有入口。** 数量、单帧、队列/事件缓冲、pending、退出未确认占用都纳入；candidate/legacy runtime 不得漏出计数。T3 worker 数不能替代本仓硬限。
6. **共享目录只能宣称合作式协调。** 未识别 shell/扩展保守处理，覆盖父子路径与别名；同权限外部进程、背景子进程、Git 公共元数据和远端副作用仍是残余边界。
7. **日志只保存结构。** 可复用 T3 stderr 仅记长度的方向，但不能复制其 `summarizePiError` 截断原始 error 或 raw cause 日志策略；截到 200 字也可能泄露 payload。本仓 diagnostic 的结构化/安全固定措辞规则更严格。

### 10.2 不建议照搬

- 不引入 Effect/SQLite/outbox 依赖，只为修补本地少量 Pi runtime；先复用 Registry 的稳定数据和生命周期。
- 不把支持 multiplex 的其他 provider adapter 改造直接套到 Pi；Pi capability 明确 false。
- 不把 T3 注入扩展的 runtimeMode/auto-accept/acceptForSession 新增成 pi-GUI 的隐式授权；本仓既有真实 extension 请求代理和权限设计是边界。
- 不重写 Pi session schema，不 fork/monkey patch Pi，不操作全局 npm；T3 的原生 fork/handoff 也不意味着本任务获准新增跨项目迁移。
- 不默认引入自动续跑、模型调用或网络行为；T3 restart continuation 有独立设置和恢复策略。
- 不为减少等待而把清理未确认资源提前从 admission count/lease 移除。
- 不以 T3 的 Linux cgroup、某条 Git guard 或 permission hook 宣称跨平台文件写 sandbox。

### 10.3 供主代理设计回归用例的证据清单（本研究未注册/执行）

- A 发送后切 B，A/B stream、completion、approval 与 cwd 互不串线；切回只恢复显示，不隐式重启。
- A startup/兼容探测或 dialog 阻塞时，B 的独立运行可推进；共享上限/manifest admission 仍原子。
- prompt accepted 尚无 agent_start、slash dialog、compaction/ACK 交错均不误判 idle。
- 同 ID/旧 generation/旧 connection 的迟到 response、abort、terminal 和 async error 不能释放或污染新 owner。
- Stop 超时保持屏障；clear_queue 不支持、abort 延迟、process tree 未退出时不谎报已完成。
- close/restart/shutdown 覆盖全部 live；factory 未完成时 close 不漏资源；cleanup 未确认保留占用。
- 同 root、父子 root、symlink alias 的 unknown tool/shell 走相同协调；不能从“两个不同 projectId”推断隔离。
- 空闲释放/后端 crash 后恢复显式 native session，旧 approval callback 失效；恢复未知结果不自动重复副作用。
- LF 跨 chunk、CRLF、字符串内 U+2028/U+2029、超大单帧与流量洪峰分别覆盖；单帧预算与总缓冲预算分开断言。

所有写盘 fixture 应在 `os.tmpdir()`，不依赖本机真 Pi；fixture 形状应以相应 Pi 上游真实实现为准。
这些是研究建议，不是新增断言数或测试已通过的证据。

## 11. 验证状态与证据索引

实际读取的关键文件已在第 3、7、8、9 节按路径、函数、行号及固定 commit 链接列出；另已读主仓
`AGENTS.md`、`REVIEW.md`、`docs/README.md`、`docs/architecture.md`、`docs/security.md`、
`docs/runtime-recovery.md`，并按任务读取 `docs/sessions.md` 和测试执行政策。

本研究的证据是源码链、Git metadata、获取错误/恢复记录及基线 CI 查询，不是录制的运行日志。

- 未运行：T3 安装/测试/构建、真实 provider/model/Pi 请求、产品交互、并行压力、进程 crash 注入、跨平台 shutdown 实测、本地 `npm test`。
- 没有 UI/public/server 产品变更，因此本子任务不需要截图或重建产物。
- 未证实：T3 全产品所有入口是否还有其它统一 session cap、不同操作系统/依赖版本的强杀完整性、任意扩展能否遵守所有合作式调度约定；不能据此填写“无”或“保证”。
- 本子任务只写此研究文件。主仓中其它作者的并行改动及既有未跟踪项不属于本研究 diff，未清理或覆盖。

## 固定源码链接

[worker-start]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/EffectWorker.ts#L123-L130
[schedule-message]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/Orchestrator.ts#L7294-L7320
[pi-tool-events]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/adapter.ts#L2431-L2442
[pi-approval-response]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/adapter.ts#L3819-L3901
[run-subscription]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/RunExecutionService.ts#L1244-L1281
[run-ingest]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/RunExecutionService.ts#L1817-L1856
[event-ingest]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/ProviderEventIngestor.ts#L775-L820
[shutdown-pool]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/desktop/src/app/DesktopApp.ts#L164-L173
[shutdown-backend-stop]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/desktop/src/backend/DesktopBackendManager.ts#L1198-L1283
[session-idle-choice]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L581-L589
[meta-server]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/package.json#L1-L8
[meta-pi]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/package.json#L1-L40
[meta-license]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/LICENSE#L1-L21
[send-ui]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/web/src/components/chat/useComposerSend.ts#L980-L1582
[send-client]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/client-runtime/src/operations/commands.ts#L782-L914
[send-resend]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/client-runtime/src/operations/commands.ts#L353-L375
[send-ws]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/ws.ts#L2058-L2109
[send-intake]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/ThreadMessageIntake.ts#L224-L279
[send-management]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/ThreadManagementService.ts#L849-L853
[schedule-lock]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/Orchestrator.ts#L16838-L16914
[schedule-executor]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/ThreadCommandExecutor.ts#L19-L31
[schedule-plan]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/Orchestrator.ts#L9950-L10054
[schedule-receipt]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/Orchestrator.ts#L16547-L16754
[persist-command]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/EventSink.ts#L788-L896
[persist-order]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/EventSink.ts#L316-L355
[schedule-outbox]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/EffectOutbox.ts#L348-L687
[schedule-worker]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/EffectWorker.ts#L1059-L1142
[start-provider]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/ProviderTurnStartService.ts#L972-L2530
[start-policy]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/RuntimePolicy.ts#L148-L199
[session-open]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L3240-L3423
[pi-open]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/adapter.ts#L495-L606
[pi-launch]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/mcpInjection.ts#L249-L324
[pi-spawn]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/rpc.ts#L193-L310
[pi-register]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/adapter.ts#L3140-L3304
[pi-turn]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/adapter.ts#L3496-L3694
[pi-events]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/adapter.ts#L2280-L2384
[pi-tools]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/adapter.ts#L1405-L1523
[pi-rpc]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/rpc.ts#L294-L478
[pi-ack]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/adapter.ts#L2664-L2714
[pi-approval]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/adapter.ts#L1889-L2001
[approval-service]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/RuntimeRequestService.ts#L78-L123
[run-routing]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/RunExecutionService.ts#L412-L590
[persist-owner]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/EventSink.ts#L545-L681
[pi-stop]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/adapter.ts#L3756-L3818
[pi-pump]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/adapter.ts#L2843-L2968
[startup-order]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/serverRuntimeStartup.ts#L422-L577
[recovery-service]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L1094-L1248
[shutdown-desktop-life]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/desktop/src/app/DesktopLifecycle.ts#L94-L189
[shutdown-desktop-app]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/desktop/src/app/DesktopApp.ts#L448-L468
[pi-driver]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/driver.ts#L77-L142
[pi-capabilities]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/adapter.ts#L105-L198
[pi-cwd-fork]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/adapter.ts#L2971-L3025
[session-busy]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L2013-L2069
[session-pump]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L3013-L3208
[pi-settle]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/adapter.ts#L2592-L2858
[startup-gate]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/serverRuntimeStartup.ts#L103-L146
[recovery-outbox]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/EffectOutbox.ts#L553-L584
[recovery-requests]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L649-L675
[recovery-continuation]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L990-L1032
[shutdown-desktop-special]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/desktop/src/app/DesktopLifecycle.ts#L263-L329
[shutdown-backend]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/desktop/src/backend/DesktopBackendManager.ts#L329-L519
[shutdown-service]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/serviceLauncher.ts#L787-L949
[shutdown-ipc]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/cloud/serviceLauncherClient.ts#L245-L258
[shutdown-cli]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/cli/server.ts#L19-L44
[shutdown-sessions]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L3211-L3235
[session-release]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L1445-L1515
[shutdown-launcher-loss]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/launcherWatch.ts#L18-L68
[session-idle]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L81-L101
[pi-framing]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/rpc.ts#L115-L148
[pi-state]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/adapter.ts#L625-L744
[os-scope]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/process/agentScope.ts#L23-L256
[os-default]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/shared/src/AgentScope.ts#L4-L54
[os-leftover]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/process/agentScope.ts#L129-L158
[os-wrap]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/process/agentScope.ts#L425-L470
[os-wire]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/server.ts#L1428-L1451
[workspace-lease]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/workspace/workspaceLease.ts#L7-L114
[workspace-restore]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts#L17-L200
[workspace-git]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/git/GitWorkflowService.ts#L201-L552
[workspace-git-ws]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/ws.ts#L3433-L3449
[workspace-git-guard]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/apps/server/src/git/sharedCheckoutGuard.ts#L41-L100
[permission-hook]: https://github.com/pingdotgg/t3code/blob/d5d5c17ecb1c7289dc50a6ac602197560e8668bf/packages/provider-pi/src/server/mcpExtensionSource.ts#L343-L382
[gui-owner]: https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-registry.js#L48-L106
[gui-launch]: https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-registry.js#L425-L474
[gui-events]: https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-registry.js#L237-L379
[gui-focus]: https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-registry.js#L806-L830
[gui-session]: https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-registry.js#L386-L423
[gui-browser]: https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-browser-launch.js#L5-L30
[gui-routes]: https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-routes.js#L35-L74
[gui-adapter]: https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/session-runtime.js#L167-L277
[gui-rpc]: https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/rpc-bridge.js#L428-L701
[gui-stop]: https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/rpc-bridge.js#L767-L937
[gui-supervisor]: https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/pi-supervisor.js#L15-L137
[gui-retire]: https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/runtime-registry.js#L831-L858
[gui-cleanup]: https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/session-runtime.js#L323-L335
[gui-tools]: https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server/session-tool-scheduler.js#L1-L80
[gui-shutdown]: https://github.com/HYJ1817/pi-gui/blob/ac812c6fa49dfd960867a5688ee6f61cb8ec5f67/server.js#L1991-L2033
