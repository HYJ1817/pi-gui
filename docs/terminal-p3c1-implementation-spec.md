# 终端 P3-C1 实现规格（精简版）

- 状态：**C1 本机试用版已实现（2026-11-13）**。本规格是 P3-C0 真机证据收敛后的实现契约；
  本轮按本机试用范围做了最小修订，见文末「C1 本机试用版修订」。未提交、未合并。
- 依据：[P3-C0 结论记录](terminal-p3c0-spike-report.md)、
  [Job Object 设计](terminal-p3c-job-object-design.md) 第五轮修订（§6.4–§6.10、§7、§8、§12）。
- 适用：Windows 终端的 Job Object 改造第一版；Plan B+ 为默认创建路径，Plan B 保留为回退。
- 原则：**事件是提示，native 终态是真相。** 所有 JS 状态都必须能从 `jobStatus(id)`
  重建；丢事件、乱序、env 销毁都不得让会话卡死或把未确认说成已完成。

## 0. 不可协商的约束

1. 每终端独立 Job；`KILL_ON_JOB_CLOSE`；Job 模式**禁止** PID 终止
   （`process.kill`/`taskkill`/PID 复用判定都不允许）。
2. shell 只能由 `CreateProcessW` + `PROC_THREAD_ATTRIBUTE_JOB_LIST` +
   `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 创建；B+ 必须 `CREATE_SUSPENDED` 后
   `ResumeThread`；`STARTF_USESTDHANDLES` 且三个 std 句柄为 `NULL`。
3. 启动失败 fail closed，不降级到无 Job 路径；先 `TerminateJobObject`，
   再按**句柄** `TerminateProcess`，最后有界等待；不能只杀 shell 留后代。
4. 不碰 pi 本体；最小 node-pty 补丁；不新增依赖；不写用户真实会话数据。
5. C0 实测覆盖了设计文本的以下点，冲突时**以 C0 为准**：
   `TerminateJobObject` 不是关闭闸门；并发 Terminate 会让 `CreateProcessW` 返回 5；
   `ResumeThread` 返回值不可作成功判据；shell 退出不产生输出 EOF；finalizer 可能
   早于最后一个 release。

## 1. 改动面与落地顺序

| 层 | 文件 | 内容 |
| --- | --- | --- |
| node-pty native | `src/win/conpty.cc` | `PtyConnect`/`PtyKill`/`PtyStartProcess`/退出线程/清理管理器；baton、Job、事件通道 |
| node-pty native | 新增 `src/win/job-object.*`、`src/win/pty-baton.h`（模块名可调） | Job 创建/绑定/验证/终止/drain；`PtyFinalState`；有界清理队列 |
| node-pty binding | `src/win/pty.cc` | 导出 `status/killJob/abortJob/dispose`、`supportsJobObject` |
| node-pty JS | `src/windowsPtyAgent.ts`、`src/windowsTerminal.ts`、`src/index.ts`、`typings/node-pty.d.ts` | `useJobObject`、`killJob/abortJob/dispose/jobStatus`、事件转发 |
| backend | `server/terminal-process.js` | 能力预检、Job 路由、fatal invariant、`defaultAbortPty` |
| backend | `server/terminal.js` | 会话状态机、kill 结果优先级、终态对账、`maybeFinishSession` |
| 构建 | `scripts/node-pty-package.mjs`、`build-*.mjs` | fork/vendor staging 与 hash（设计 §11） |

落地顺序（每一步都保持 `useJobObject` 默认 false，能力开关打开前不改变现有行为）：

1. native 骨架：baton/状态枚举/句柄所有权 + `status/abortJob/killJob/dispose` 导出；
2. 事件通道 + 退出线程 + 有界清理管理器；
3. node-pty JS API + 能力探测；
4. backend 路由与 Job 模式 kill 分支（先删 PID 路径，再加 Job 路径）；
5. T40–T46 测试与 C0 回归脚本；最后才把 `useJobObject` 接到 backend 默认路径。

## 2. 契约 A：Connecting 如何仲裁取消与 Resume

### A.1 五权归属（设计 §6.4 定稿，C1 必须逐条实现）

| 权利 | 归属 | 规则 |
| --- | --- | --- |
| `abortRequested` 原子写 | 任意外部线程 T2（kill/dispose/abort） | 无锁 `store(true, release)`；随后可并发 `TerminateJobObject(hJob,1)` |
| `hJob` 使用 | Connecting 期间**只有 T1** | 属性列表、`IsProcessInJob`、accounting 查询；T2 不得使用 |
| `hJob` 关闭 | Connecting 期间**只有 T1 Guard**；Connected 后退出线程/PtyKill | **T2 在 Connecting 期间绝对禁止 `CloseHandle(hJob)`** |
| `ResumeThread` | **只有 T1**，且仅当 `abortRequested==false` | `abortRequested==true` 时永久不 resume；挂起进程不执行用户代码 |
| 状态提交 | Resume 成功后 T1 持短锁 | 锁内若见 abort/terminate 则强制 `Terminating`，绝不置 `Active` |

### A.2 线性化点与动作

| 时点 | 检测 | 动作 |
| --- | --- | --- |
| create 前 | abort/dispose 已置位 | 不创建 shell；`MarkConnectFailedAndCleanup(shellCreated=false)` |
| create 后、resume 前 | abort/dispose | `StopCreatedShellBounded` → `RetainOrQuarantineIfUnconfirmed` → 抛 `pty_aborted`；**绝不 Resume** |
| create 后、resume 前 | `IsProcessInJob=false` / accounting 三次仍为 0 | 同一清理路径；映射为 `job_assign_failed` / `job_accounting_failed` |
| `CreateProcessW` 失败 | `GetLastError()==5` 且 abort 已置位 | 映射为**取消**（`pty_aborted`），不是启动失败 |
| resume 后、提交锁内 | abort/terminate 已置位 | `jobState=Terminating`、`connectState=Failed`；锁外 `StopCreatedShellBounded`；绝不置 `Active` |
| `StartExitThread` 失败（shell 已创建） | — | 按启动失败清理；未确认则入 startup quarantine；不能返回成功 |

实现规则：

- 五个检查点全部用 `memory_order_acquire` 读 `abortRequested`；accounting 轮询间隙
  也要检查（T2 可能在此期间叫停）。
- 锁内只做内存字段提交；`Sleep`、`WaitForSingleObject`、`StopCreatedShellBounded`
  一律在锁外。
- `ResumeThread` 返回 `0`/`(DWORD)-1` 都不作为“已恢复”的证据；恢复成功只由
  后续接口返回与状态提交证明。
- `CreateProcessW` 已成功但 abort 先到：**必须**在 create 后检查并清理这个新 shell；
  不能因为 Job 已 terminate 就假设它不会运行（C0 §4.6）。

### A.3 句柄所有权交接表

| 阶段 | `hJob` | `hShell`/`pi.hProcess` | `HPCON` |
| --- | --- | --- | --- |
| TSFN 创建前 | baton | 无 | baton |
| Connecting（T1 独占） | T1 Guard（使用+关闭） | T1 局部 `pi.hProcess`；提交成功才转 baton | T1 经属性列表使用；失败转清理管理器 |
| Resume 提交成功 | baton → 退出线程（drain/关闭） | baton（退出线程等待/关闭） | baton → 清理管理器（`PtyCleanupTask`） |
| 提交时发现 abort | 交给 `StopCreatedShellBounded`/quarantine | 同一路径 | 清理管理器 |
| 失败且未确认退出 | `startupQuarantine` 持有 `{hJob,hProcess}` | quarantine 持有 | 清理管理器 |
| dispose / 进程退出 | 按上表；进程退出由 OS 回收 | 同 | 清理线程关闭 |

硬规则：

- 同一时刻只有一个 owner 能 `CloseHandle`；交接通过 `baton->mutex` 内的状态字段完成，
  不靠“谁先跑到”。
- 退出线程与 `PtyKill` 对 `hJob` 的 Query/Terminate/Close 必须串行（同一把 mutex）。
- 失败路径不得留下“无 owner 的 shell/HPCON”；入队失败时保留 baton 与预约，
  由 JS 的 `dispose` 重试。

## 3. 契约 B：TSFN、引用、finalizer、停止事件、终态

### B.1 谁持有、谁释放

| 对象 | 创建者 | 初始持有 | 谁 Acquire | 谁 Release | 谁最终销毁 |
| --- | --- | --- | --- | --- | --- |
| TSFN 线程引用（thread count） | `PtyEventChannel::Create`，初始 **1** | **退出线程** | 需要 post 的生产者（本版仅退出线程；清理线程 0 引用） | 每个持有者恰好一次；退出线程在停止/退出路径 | Node 在 thread count 归零且队列排空后销毁 |
| `envClosing/stop` 标志 | channel | — | — | — | 随 channel |
| `hStopEvent` | channel（`ExitThreadControl`） | `ExitThreadControl` 的 `shared_ptr` 所有者集合 | — | — | **由 `ExitThreadControl` 最后一个强引用析构时关闭**；finalizer 不关闭 |
| `PtyFinalState` | `PtyStartProcess` | baton + 终态 cache（64 项/TTL 10 min） | 清理任务、查询 | 各自 `shared_ptr` 释放 | cache 淘汰/`forgetFinalState` |
| finalize token | `PtyEventChannel::Create` | TSFN（作为 finalize_data） | — | — | **finalizer 自己释放 token**；token 只含 `shared_ptr<PtyFinalState>` 与标志，不含 channel/baton 裸指针 |

实现约束：

- `hStopEvent` 只能在**清理 hook 已注销（正常 dispose 路径）或已执行（teardown 路径）之后**
  由最后一个 `ExitThreadControl` 强引用析构关闭；否则 hook 可能对已关闭/复用的句柄
  `SetEvent`。finalizer 不参与该生命周期。
- `napi_add_env_cleanup_hook` 中只做：`envClosing=true`、`stop=true`、`SetEvent(hStopEvent)`；
  **不 release TSFN、不 join、不关闭句柄**。
- 退出线程发现 stop 后：不再 post，`ReleaseHolder()` 恰好一次，退出。
- 需要 post 的代码必须先 `AcquireHolder()` 成功再调用；`napi_queue_full` 只记
  `lostEvents++`，不重试阻塞、不 fatal；`napi_closing` 直接丢弃。
- **本版清理线程不发起任何 post**（最小方案）；它只做 `ClosePseudoConsole` 与
  native 终态写入。

### B.2 finalizer：执行与对象销毁是两个事实

C0 实测（Node 24.22.1 / Electron 44.4.3 的 worker env 销毁）：

- finalizer 在 env teardown 期间执行，`holdersAtEntry=1`；
- 之后退出线程的 `napi_release_threadsafe_function` 仍返回 `napi_ok`；
- 顺序为 `cleanup hook → finalizer → release → exit-thread done → worker exit`。

因此：

1. **finalizer 不是“最后一个使用者已退出”的信号**；不得在其中关闭 `hStopEvent`、
   关闭 Job/HPCON/shell、释放 channel/baton、访问 `napi_env`。
2. finalizer 只允许：设置 `PtyFinalState.finalizerRan`、释放自己的 finalize token。
3. 底层 TSFN 对象的实际销毁时刻不可观测；C1 不得依赖“release 返回后对象仍可用”。
   finalize 之后任何 `napi_call_threadsafe_function` 都是 UAF（C0 实测崩溃）。
4. 禁止 `napi_tsfn_abort` 后让其他线程再触碰 TSFN（C0 实测崩溃）；
   abort 只允许由最后一个使用者执行。

### B.3 最小方案：清理线程只写 native 终态，JS 定期对账

```text
dispose / 退出线程请求清理
  → 有界清理队列（2 worker / 32 tracked / 4 quarantine）
  → PtyCleanupTask{ hpc, closeState, finalState, channel(0 TSFN refs) }
  → worker: ClosePseudoConsole(hpc)  [可能阻塞，绝不持 TSFN 引用]
  → 返回后：锁内写 finalState->ptyDisposed=true、closeReturned=true、closeMs
  → 不发事件（v1）；JS 通过 jobStatus(id) 对账
```

JS 对账时机（缺一不可）：

1. `onExit` 到达后立即一次；
2. `killJob()`/`dispose()` 返回后各一次；
3. 会话处于 `cleanupPending/closing` 时每 **200–250 ms** 一次，直到
   `ptyDisposed && treeState∈{drained,unconfirmed}` 或超时（建议 10 s）；
4. 检测到事件序号缺口或 `lostEvents>0` 时立即一次；
5. 收到 `onPtyDisposed`（若后续启用推送）后一次最终对账。

超时处理：置 `treeState='unconfirmed'`、记录 `cleanupState='timeout'`，结束会话，
**不伪装 drained**；`ClosePseudoConsole` 仍可能稍后返回，终态 cache 继续可查。

### B.4 事件与终态的权威关系

- 事件携带不可变 `snapshot`（id/generation/seq/type/shellExited/ptyDisposed/
  treeState/drainedVerified/activeProcesses/closeUnconfirmed/exitCode）。
- `PtyFinalState` 是唯一可被清理线程晚写、可被 `jobStatus()` 读取的共享对象；
  事件丢失时 JS 以它为准。
- 事件是优化：允许丢、允许晚到；不允许“没收到事件就永远 closing”。

## 4. 契约 C：真实回调接入与四类确认

### C.1 管线

| 层 | 输入 | 必须做什么 |
| --- | --- | --- |
| native `PtyEventChannel` | 退出线程/清理任务写的 snapshot | TSFN 非阻塞投递；失败只记 `lostEvents` |
| `WindowsPtyAgent` | TSFN 回调 + native `status(id)` | 保存 `_pty`；`onExit/onJobState/onPtyDisposed` 转发；`jobStatus()` 合并 cache |
| `WindowsTerminal` | agent 事件 | Job 模式 `kill()` 不 `_deferNoArgs`、不提前 `_close()`；socket 保留到 `ptyDisposed` |
| `server/terminal-process.js` | spawn/kill 路由 | capability 预检；Job 模式只走 `killJob/abortJob/dispose`；invariant 违反即 fatal，不降级 |
| `server/terminal.js` | pty 事件 + kill 结果 | 会话状态机；`applyKillOutcome` 先判 `result.job`；`maybeFinishSession` 对账 |
| renderer/IPC | `terminal:data`/`terminal:exit` | 只消费最终会话事件；不直接读 native |

`onExit` 载荷至少包含：`exitCode`（可能 unknown）、`shellExited`、`treeState`、
`drainedVerified`、`activeProcesses`、`jobState`、`ptyDisposed`、`closeUnconfirmed`。
`exitCode` 仅用于展示；**不得**用于判断自然退出/被杀。

### C.2 四类确认（每条独立，不得互相替代）

| 事实 | 确认方式 | 正证据 | 不能作为证据 |
| --- | --- | --- | --- |
| 输出 EOF | ConPTY 输出管道 `PeekNamedPipe`/`ReadFile` 返回 `ERROR_BROKEN_PIPE(109)` | 只会在 `ClosePseudoConsole` 之后出现（C0：shell 退出后 8 s 内无 EOF） | shell 退出、`onExit`、退出码 0 |
| Shell 退出 | `WaitForSingleObject(hShell)==WAIT_OBJECT_0` + `GetExitCodeProcess` | 退出线程置 `shellExited=true` 并只发一次 `onExit` | 管道 EOF、accounting 0、`ResumeThread` 返回值 |
| Job drain | shell 退出后连续两次成功查询 `ActiveProcesses==0`，间隔 ≥50 ms | `drainedVerified=true`、`treeState=drained` | 单次 0、`TerminateJobObject` 返回 TRUE（C0：accounting 先归零、进程后退出） |
| HPCON 关闭返回 | 清理线程实际从 `ClosePseudoConsole` 返回 | `closeReturned=true` + `closeMs`；`ptyDisposed` 只由此置位 | 退出线程的清理请求、`dispose()` 返回、队列入队成功 |

补充：

- **`drained` 的含义是“Job accounting 连续两次读到 0”，不是“所有进程已退出”。**
  C0 实测 `TerminateJobObject` 后 accounting 立即归零、进程 1–3 ms 后才退出；
  因此终止路径下不能因为 `drained` 就提前关闭 shell 句柄或宣告进程已死。
  shell 是否退出只由 `hShell` 等待判定；后代没有句柄时，accounting 是唯一可用信号，
  报告与 UI 必须保留这个边界，不能说成“整棵进程树已确认退出”。
- 读取端在 `ptyDisposed` 之前**不得**因 `onExit` 关闭 socket；否则可能让
  `ClosePseudoConsole` 等不到 drain。
- `ClosePseudoConsole` 会让运行中的 shell 以 `0xC000013A` 退出；退出码映射必须容忍。
- `dispose()` 返回只表示“已请求/已入队”，不表示 HPCON 已关闭；UI 不得据此结束会话。

### C.3 丢失/乱序通知的对账算法

```text
onEvent(e):
  if e.generation != session.generation: ignore        // 旧终端/旧一代
  if e.seq <= session.lastSeq: ignore                  // 重复/乱序旧事件
  if e.seq > session.lastSeq + 1: session.lost = true
  session.lastSeq = e.seq
  merge(session, e.snapshot)                           // 单调合并，见下
  if e.type == Exit: scheduleReconcile()
  if e.type == PtyDisposed: reconcileNow(final=true)

reconcileNow():
  s = pty.jobStatus(id)
  if s.generation && s.generation != session.generation: return
  merge(session, s)
  if s.final || s.gone: maybeFinishSession()           // gone 只按 unconfirmed 结束

merge(session, s):
  session.shellExited      |= s.shellExited
  session.ptyDisposed      |= s.ptyDisposed
  session.drainedVerified  |= s.drainedVerified
  session.terminateAccepted|= s.terminateAccepted
  session.treeState = maxRank(session.treeState, s.treeState)
  // rank: active < terminating < draining < drained < unconfirmed/gone(终态)
  if s.closeUnconfirmed: session.closeUnconfirmed = true
```

规则：

- 状态只前进不后退；`drained` 不会被后来的 `terminating` 覆盖，`shellExited` 不会
  被清掉；`unconfirmed/gone` 只在没有更好终态时采用。
- `maybeFinishSession` 条件（设计 §7.2）：`shellExited && ptyDisposed &&
  treeState∈{drained,unconfirmed}`，且清理队列无未完成项；任一不满足就保持
  `cleanupPending`，由定时对账推进。
- `jobStatus()` 返回 `gone/final:false` 时只能映射为 `unconfirmed`，不能映射为 drained；
  有 cache 快照时以快照为准。

## 5. native 对外接口与状态字段

必须导出/返回：

- `supportsJobObject: boolean`（读实际加载的二进制）；
- `killJob(id) -> JobControlResult`：`requested/terminateAccepted/treeState/
  drainedVerified/jobHandleClosed/closeUnconfirmed/fallbackUsed/error`；
- `abortJob(id) -> JobControlResult`：构造失败/防御性清理，不按 PID；
- `dispose(id) -> {disposed,queued,retry,connecting}`；
- `status(id) -> {present,gone,final,jobMode,jobAssigned,jobState,treeState,
  terminateAccepted,drainedVerified,shellExited,ptyDisposed,activeProcesses,
  closeUnconfirmed,resourceCloseUnconfirmed,startupQuarantine,disposeRequested,
  disposed,queued,lostEvents,error}`。

错误码沿用设计 §6.11；新增/明确的映射：

| 场景 | 结果 |
| --- | --- |
| abort 已请求时的 `CreateProcessW` 错误 5 | `pty_aborted`（取消），不是 `cannot_create_process` |
| `ResumeThread` 在 terminate 后返回 0 | 不得据此判成功；按 abort 路径处理 |
| 清理队列满 | `pty_cleanup_busy`，保留 hpc 与预约，不丢句柄 |
| 启动 quarantine 满 | `pty_startup_cleanup_busy`，拒绝新终端 |

## 6. 测试与证据映射

| 编号 | 内容 | 本规格对应 |
| --- | --- | --- |
| T40 | B+ 创建、Job 绑定、挂起/resume、conhost 不在 Job | A、C.2 |
| T41 | A/B/C 失败路径（create/job/accounting/resume/exit thread） | A.2 |
| T42 | kill 六场景（Active/Terminating/Connecting/shell 已退/Job 已关/重复 kill） | §5、C.2 |
| T43 | snapshot/cache、`gone ≠ drained` | C.3 |
| T44 | Connecting 取消竞态 100 次（覆盖错误 5、Resume 0） | A.2 |
| T45 | worker/清理线程启动失败、队列满、入队失败 | B.3 |
| T46 | cleanupState 矩阵（queued/running/returned/timeout/unconfirmed） | B.3、C.2 |
| C0 回归 | `win32-spike.exe --all` 20 项 + `run-worker-lifecycle.mjs`（Node/Electron） | 全部 |

执行要求：

- 单测用 fixture（假 `.cmd` shim、注入 env），**不依赖真 pi**、不写用户数据；
- 新套件加入 `package.json` 的 `test` 链（AGENTS.md 硬约束），CI 分组读取同一条链；
- UI 需要真实截图（jsdom 不证明布局）；断言总数变化要写清少了哪几条；
- 每个支持版本各跑一遍 C0 回归，记录 `selftest.windows` 与原始日志。

## 7. C1 完成定义（出口门槛）

1. `useJobObject` 在支持版本上默认开启；不支持/未验证版本
   `supportsJobObject=false`，spawn 前拒绝（fail closed）。
2. 20 项 C0 Win32 回归 + worker env 销毁场景在目标版本全部通过。
3. Job 模式代码中不存在 PID 终止路径（代码审查 + 搜索断言）。
4. Connecting 期间不存在 T2 的 `CloseHandle(hJob)`；所有失败路径有 owner。
5. 事件丢失/队列满/乱序测试通过；`jobStatus()` 能独立重建终态。
6. 清理线程阻塞 3 s 时进程/worker 仍能退出；`ClosePseudoConsole` 返回后终态可见。
7. App 退出、`disconnect`、backend 崩溃三条清理路径有时序证据。
8. 按 [acceptance.md](acceptance.md) 提交证据；独立复审；高风险安全审查；
   用户明确批准合并后才合并。

## 8. 人工待决（C1 开始前）

1. **支持版本矩阵**：Win10 22H2 / 11 23H2 / 11 24H2 是否作为 C1 合并门槛，
   或允许 25H2 先行、旧版本 fail closed。
2. **node-pty 改造方式**：fork/vendor 的最小补丁范围与打包 hash；是否保留 Plan B
   运行时回退（C0 已验证 B 可用）。
3. **C1 范围**：是否包含打包 Electron 主进程的 WMI 重测、worker/主进程双形态、
   App 退出时序专项。

## 9. C1 本机试用版修订（2026-11-13）

本轮目标只有「Windows 11 25H2 x64、单用户、本机可试用」，因此按最小可验证路径
落地；以下偏离是**有意的范围收缩**，不是把 §7 的合并门槛当作已满足。

| 规格 | 本轮实现 | 原因 / 验证 |
| --- | --- | --- |
| 新增 `job-object.*`、`pty-baton.h`、`src/win/pty.cc` 导出 | 全部收敛在 `src/win/conpty.cc`；`pty_baton`、Job 帮助函数、导出同文件 | 单文件补丁更容易在 `node_modules` 里回滚；C0 已证明算法 |
| 事件通道带 `seq/snapshot/onJobState/onPtyDisposed` | 单个原始 TSFN 回调只投递 shell 退出；JS 用 `jobStatus()` 对账，不依赖事件 | 事件丢失去风险由轮询兜底；后端回归覆盖「无 onExit」 |
| 有界 2 worker 清理队列 + 32 tracked + quarantine | 每终端一个 detached 清理线程；`TerminateJobObject` 后 5 s/500 ms 有界 drain；`ClosePseudoConsole` 后写终态 | 终端数量由后端上限约束；线程只在退出时创建一次 |
| finalizer 只记录、不碰 Job/HPCON | finalizer 在 `hJob && !shellExited` 时判定为 env teardown，置 `envClosing` 并 `TerminateJobObject` | worker env 销毁/进程异常退出必须回收；`acceptance-env-teardown` 与 `acceptance-crash` 验证 |
| `abortJob` / `dispose` 公开 API | 只公开 `killJob`/`jobStatus`/`supportsJobObject`；`dispose` native 导出未接入 JS | Job 模式的停止语义统一为 `killJob`，避免第二条仲裁路径 |
| `killJob` 返回完整 `JobControlResult` | 返回 `{requested, terminateAccepted, final, jobMode}`；完整状态走 `jobStatus()` | 后端只用 requested/terminateAccepted 决策，终态以快照为准 |
| `status` 字段名 `resourceCloseUnconfirmed/startupQuarantine/disposed` | 字段名为 `closeUnconfirmed/closeMs/drainedVerified/finalizerRan/envClosing/spawnedAtMs/assignedAtMs/resumeAtMs` | 与 C0 报告字段对齐；时间戳用于证明 assign 在 resume 之前 |
| 清理线程只写 native 终态，不 post | 清理线程只写终态；退出线程在 env 未关闭时 post 一次 | 与规格 B.3 的最小方案一致 |
| 默认开启 `useJobObject` | **默认关闭**；`PI_GUI_TERMINAL_JOB_OBJECT=1` 显式开启 | 用户本轮要求「本机显式开关，默认关闭」；关闭时保持 P3-B |
| 跨版本矩阵、打包 Electron 窗口、WMI 重测 | 只验证 25H2 + 便携产物；Electron 源码入口未做窗口验收 | 用户明确旧版 Windows 与跨版本矩阵不是本轮门槛 |
| `scripts/node-pty-package.mjs` 增加 fork/vendor hash | 未改；现有 staging 已复制 `lib/` 与当前 prebuild | 本轮不引入 fork 目录；产物 SHA-256 已在交付文档记录 |

另外两处实现细节需要后续 C1 正视：

1. **Connecting 取消**：本轮在 `killJob` 置 abort 后由 `connect` 的首个检查点拒绝
   （`pty_aborted`），并验证 Job/pipe/HPCON 回收；C0 的 100 次竞态仍是对
   「CreateProcessW 后、Resume 前取消」的权威证据，本轮没有改写成产品级 100 次压测。
2. **`drained` 语义**：沿用 C0 的 accounting 连续两次 0；它不等于整棵进程树已确认退出，
   报告和 UI 不得把它说成后者。

这些偏离需要在进入正式 C1（默认开启、跨版本、Electron 产物）前重新收敛；
本机试用版的验收记录见 [terminal-p3c-local-trial.md](terminal-p3c-local-trial.md)。
