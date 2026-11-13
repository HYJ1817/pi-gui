# 终端 P3-C 设计第二轮修订记录

- 修订对象：[terminal-p3c-job-object-design.md](terminal-p3c-job-object-design.md)
- 仓库基线：`origin/main` `5c8c9a4`
- 上一版设计提交：`3c0e1b8`（`feat/terminal-p3c-design`）
- 修订日期：2026-11-13
- 本轮性质：**只修改设计文档**；未修改 server/Electron/node-pty 生产代码、`package.json`、依赖、P3-B 门控；未创建实现 PR、未推送、未合并、未发版
- 结论：设计达到进入 **P3-C0（真机 spike）** 的条件；**未达到进入 P3-C1（原生实现）** 的条件

---

## 1. 修订范围

本轮把第一版设计从“方向正确的方案”修订为“可指导高风险 Windows 原生开发的工程设计”，重点解决六个架构问题：

1. Job 模式与终止路径隔离
2. spawn 失败与未受保护 shell 的清理
3. shell 退出与整个 Job 进程树退出的状态管理
4. `ClosePseudoConsole` 清理线程资源控制
5. 原生 HANDLE 并发与生命周期
6. `PtyConnect` 失败与资源泄漏

同时重新审查两个决策：

1. Plan A 的回退政策
2. 自然退出时后台子进程的处理

并补充测试、错误码、状态机、HANDLE 所有权、打包校验、残余风险和 P3-C0 条件。

---

## 2. 六个技术问题的修订对照

### 2.1 Job 模式与终止路径隔离

| 项 | 第一版 | 第二版 |
| --- | --- | --- |
| 模式表示 | `hJob` 是否为空/可用隐式表示 | `const JobMode jobMode`，创建时固定 |
| `TerminateJobObject` 失败 | 关闭 `hJob` 并置空，可能让后续代码进入 legacy 路径 | 关闭 `hJob` 只触发 `KILL_ON_JOB_CLOSE`；`jobMode` 仍为 `Required`；结果 `ClosingUnverified` / `Unconfirmed` |
| 重复 `dispose` | 未明确模式是否变化 | 只改变 `disposeRequested/hpc`，不改变 `jobMode` |
| Job 模式终止路径 | 仍保留 `defaultKillPty` 兜底的可能 | 分支内**没有** `process.kill` / `taskkill` / `_getConsoleProcessList` |
| 成功语义 | 可能把 `CloseHandle` 当成清理完成 | `TerminateJobObject` 只算“已发起”；`verified` 只来自 `ActiveProcesses==0` |
| 状态区分 | `Closed` 无法区分 drained/unverified | 增加 `drainedVerified`；`PtyKill`/`status` 必须返回该字段 |

修改位置：

- 设计文档 §3（不变量 I1/I2）、§6.1（`jobMode`）、§6.2（状态规则）、§6.5（`PtyKill` 伪代码）、§7.1（状态机）、§7.3（两个终止机制的顺序）
- 新增错误码 `job_handle_missing`、`job_terminate_failed`、`job_close_failed`

修订原因：

- `hJob` 是资源，不是模式。句柄关闭、终止失败、重入都不能改变“这个终端从创建起就承诺 Job 保护”的事实。
- 一旦进入 PID 路径，就重新引入了 P3-B 的 PID 复用窗口，违背 P3-C 的目标。
- `KILL_ON_JOB_CLOSE` 是终止请求，不是 accounting 证明；不能把“关句柄”写成“已清空”。

剩余不确定性：

- `KILL_ON_JOB_CLOSE` 对挂起进程、子 Job 的实际行为需要 C0 验证。
- `CloseHandle` 失败时的句柄泄漏路径只做 `Unconfirmed` 标记，不在用户态强行恢复。

### 2.2 Spawn 失败与未受保护 Shell 的清理

| 项 | 第一版 | 第二版 |
| --- | --- | --- |
| 能力检查 | spawn 后看 `pty.jobObject`，false 时调 `defaultKillPty` | spawn 前检查**实际加载的 conpty 二进制**的 `supportsJobObject`；false 直接 503，不创建 shell |
| 旧 `.node`/打包错配 | 依赖 P3-B 捕获兜底 | 预检 + 打包 hash；shell 创建前拒绝 |
| `CreateJobObject`/`SetInformation` 失败 | 未明确谁清理 | 原生 `PtyStartGuard` 清理 hpc/管道/Job；不创建 shell |
| `UpdateProcThreadAttribute(JOB_LIST)` 失败 | 未明确 | `PtyConnectGuard` 清理；不创建 shell |
| `CreateProcessW` 失败 | 只抛错 | guard 清理 hpc/Job/管道 |
| `IsProcessInJob`/`ActiveProcesses`/`ResumeThread` 失败 | 未定义 | `TerminateProcess(hProcess)` 按**句柄**终止 + 有界等待 + guard 清理 |
| `PtyConnect` 抛异常 | 可能留下 baton/hpc | 原生 guard 清理；JS 构造 catch 再调 `dispose` 作为幂等兜底 |
| JS socket/connect 异常 | 无清理 | `WindowsPtyAgent` 保存 `_pty` 后 try/catch，异常调 native `dispose`；`WindowsTerminal` 构造也 catch |
| `pty.jobObject !== true` | 调 `defaultKillPty` | 视为 fatal invariant；不调 P3-B/PID kill；尝试 native `abortJob`（按句柄），否则记录并拒绝继续 |

修改位置：

- 设计文档 §6.3（`PtyStartProcess` RAII）、§6.4（`PtyConnect` 绑定/验证/resume + guard）、§6.5（`PtyKill`）、§6.10（JS 构造/预检）、§9.1（失败矩阵）、§9.2（失败关闭）
- 新增错误码 `pty_job_unavailable`、`pty_job_invariant`、`job_create_failed`、`job_set_limit_failed`、`job_limit_unverified`、`job_attribute_failed`、`job_assign_failed`、`job_accounting_failed`、`job_resume_failed`

修订原因：

- P3-B 的 `capture` 是异步的；spawn 返回时它可能还没完成。用它来清理一个“未受 Job 保护”的 shell，等于把未建立的安全能力当成兜底。
- `pty.kill()` 在系统 ConPTY 上会走 `_getConsoleProcessList` + `process.kill`；对未受保护的 shell 调用它，正是 P3-C 要禁止的路径。
- 唯一安全的做法是**让这个状态在接口上不可达**：能力预检在 shell 前；原生在 `PtyConnect` 处强制 `jobMode`；创建失败由原生清理。
- 如果打包错配仍然造成 shell 已创建但 `jobObject` 不为 true，设计不假装能安全清理：不 PID kill，记录 fatal invariant，根因是打包/接口校验，必须修构建。

剩余不确定性：

- `abortJob` 依赖 native 仍持有 `hShell`；如果 native 已经丢失句柄，无法安全清理。
- 旧 JS + 新 native、新 JS + 旧 native 的错配测试需要构造 staged 包；本轮未实现。

### 2.3 Shell 退出与整个 Job 进程树退出

| 项 | 第一版 | 第二版 |
| --- | --- | --- |
| 事实 | `onExit` 近似等于“终端结束” | 拆成 `shellExited` / `jobTerminating` / `jobDrained` / `ptyDisposed` / `sessionExited` |
| Shell 退出 | 立即关 Job/认为树结束 | 保留 `hJob`，查 `ActiveProcesses`；>0 则 `TerminateJobObject`；轮询到 0 或超时 |
| 后代 | 依赖 `taskkill /T` 或未处理 | Job 终止；drain 验证；超时 `Unconfirmed` |
| `hJob` 关闭时机 | shell 退出即关 | 只有 `Drained` 后才关；失败兜底关句柄但标 `ClosingUnverified` |
| `ActiveProcesses` 验证 | 未与句柄关闭顺序绑定 | 明确“关最后一个 hJob 后无法再 accounting”；不把 `KILL_ON_JOB_CLOSE` 当验证 |
| JS 会话 | `handleExit` 直接 `exited` | Job 模式等 `onJobState(drained)`；`onExit` 时补查 `jobStatus()`；超时 `killUnconfirmed` |
| 嵌套 Job | 未讨论 | 明确 `ActiveProcesses` 只保证直接会计；子 Job/WMI 是残余缺口 |

修改位置：

- 设计文档 §3.1（五个事实）、§6.6（退出线程与 drain）、§7.1–§7.5（状态机、顺序、嵌套 Job、UI）、§8.2（场景表）、§12.2（T23/T24）、§14.3（不可解边界）

修订原因：

- Shell 退出只说明 shell 进程结束；后台子进程/孙进程可能仍活着。
- `TerminateJobObject` 返回只表示“已发起”，必须用 `ActiveProcesses` 轮询确认。
- `KILL_ON_JOB_CLOSE` 需要关闭最后一个 Job 句柄才触发；一旦关闭，`QueryInformationJobObject` 不再可用，因此它只能作为兜底，不能作为 drained 证据。
- `ActiveProcesses` 的 accounting 边界（嵌套 Job/WMI）必须如实写出，不能把 `Drained` 宣传成“整棵 Windows 进程树绝对为空”。

剩余不确定性：

- `ActiveProcesses` 对挂起进程、子 Job 的统计行为需要 C0。
- `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` 的 completion port 方案未采用；本轮只选轮询，C0 可比较。

### 2.4 `ClosePseudoConsole` 清理线程资源控制

| 项 | 第一版 | 第二版 |
| --- | --- | --- |
| 线程模型 | 每次 dispose 创建一个 detached 线程 | 固定 2 个 worker + 容量预约（最多 32 tracked） |
| 容量耗尽 | 未定义 | 拒绝新终端 503 `pty_cleanup_busy`；已有会话保留 `hpc`，`cleanupPending` 重试 |
| 句柄所有权 | 线程可能访问 baton | task 独立持有 `HPCON` + `shared_ptr<PtyCloseState>`，不访问 baton |
| disposed 语义 | 请求即 disposed | `disposeRequested` 与 `disposed` 分开；只有 `ClosePseudoConsole` 返回后才 disposed |
| 阻塞 | 无限线程累积 | worker 可阻塞，但队列有界；进程退出兜底，不假装完成 |
| shutdown | 未定义 | 停止接收；对无法 join 的固定 worker `detach()`；manager 为进程生命周期单例，避免静态析构 `std::terminate` |
| 测试 | 未覆盖 | T30（阻塞 60s）、T31（容量耗尽）、T27（100+ 循环） |

修改位置：

- 设计文档 §6.7（清理管理器）、§6.8（hpc 所有权）、§6.9（并发时序 E）、§12.2（T27/T30/T31）、§14.1（风险）
- 新增错误码 `pty_cleanup_busy`、`pty_dispose_pending`

修订原因：

- 旧版 Windows 的 `ClosePseudoConsole` 可能在输出未 drain 时长时间阻塞；每次 dispose 建线程会无限累积线程和句柄。
- 不能因为清理线程阻塞就丢弃 `HPCON`；否则 conhost/伪控制台资源无人释放。
- 清理任务不能访问可能已释放的 baton；独立所有权是唯一可靠方式。
- 队列满时必须保护进程资源：拒绝新终端，而不是继续创建。

剩余不确定性：

- 固定 worker 永久阻塞时，应用需要重启才能恢复清理能力；这是有意的资源保护，不是可自动恢复的故障。
- `ClosePseudoConsole` 在 Windows 11 24H2 的行为可能与旧版不同；需要 T30 真机对比。

### 2.5 原生 HANDLE 并发与生命周期

| 项 | 第一版 | 第二版 |
| --- | --- | --- |
| 所有权 | 描述了“谁创建”，未逐项定义转移 | hJob/hShell/hpc/hIn/hOut/hThread 逐项所有者、转移、关闭条件 |
| 并发保护 | 提到 mutex，未覆盖所有路径 | baton mutex + 状态机 + 单一所有者；`shared_ptr` 只保证对象生命周期 |
| `hShell` | `PtyKill`/退出线程可能竞争 | 只有退出线程等待/关闭；`PtyKill` 只发 Job 终止 |
| `hpc` | dispose/退出线程可能双重关闭 | 只转移一次；转移后 baton 为 null；task 独占 |
| `hThread` | 当前代码提前关闭 | 保留到 `ResumeThread` 之后；失败 guard 关闭 |
| 退出线程删 baton | 当前代码在回调前删 | baton 保留到 cleanup worker 完成；避免 `PtyKill`/`dispose` 丢失状态 |
| 并发测试 | 未覆盖 | T21/T29 覆盖 kill+dispose、自然退出、重复 dispose、worker/回调、backend 退出 |

修改位置：

- 设计文档 §6.1（baton 字段/生命周期）、§6.8（所有权表/规则）、§6.9（时序 A–E）、§12.2（T21/T29）、§14.2（中风险）

修订原因：

- `shared_ptr` 只防止 baton 被提前析构，不防止两个线程同时 `CloseHandle` 同一个 HANDLE。
- `PtyKill` 与 `dispose` 并发、自然退出与 `dispose` 并发、重复 dispose 都是正常用户操作，必须有确定状态，而不是“尽量不要同时发生”。
- 退出线程提前删 baton 会让 `PtyKill` 拿不到状态，也会让 `dispose` 误以为已经 disposed。

剩余不确定性：

- `PtyKill`/`dispose`/退出线程的状态组合仍有少量边界需要在 C1 用 TSAN/压力测试验证。
- `CloseHandle` 失败路径的句柄泄漏只能标记，不能用户态恢复。

### 2.6 `PtyConnect` 失败与资源泄漏

| 项 | 第一版 | 第二版 |
| --- | --- | --- |
| 失败路径 | 只描述“要清理” | `PtyConnectGuard` 明确：终止已创建进程、关 hThread/hShell、关管道、转移 hpc、关 hJob、移除 baton |
| `CreateProcessW` 失败 | 未列出 attrList 释放 | `DeleteProcThreadAttributeList` + `delete[]` RAII，成功/失败都执行 |
| `IsProcessInJob`/accounting/resume 失败 | 未定义 | 按 `hProcess` 终止 + 有界等待；不按 PID |
| `SetupExitCallback` 失败 | 未定义 | 终止 hProcess + guard 清理 |
| JS 构造失败 | 未定义 | native guard + JS catch `dispose`；无 pty 对象逃逸 |
| 重复 dispose | 未定义 | 幂等；`hpcEnqueued` 只转移一次；baton 保留到 disposed |
| 资源无人持有 | 可能 | 每个失败分支有明确 owner；清理 idempotent |

修改位置：

- 设计文档 §6.3、§6.4、§6.7、§9.1（失败矩阵）、§9.2（失败关闭）
- 新增错误码 `job_attribute_failed`、`job_assign_failed`、`job_accounting_failed`、`job_resume_failed`

修订原因：

- 当前 `PtyConnect` 在 `CreateProcessW` 失败时没有释放 attrList/hpc/管道；`PtyStartProcess` 在 `inNameStr` 为空时也没有清理。
- Job 失败路径不能让 JS 去猜“PTY 对象是否完整”；原生必须保证失败时没有半成品逃逸。
- 所有清理必须可重复调用，才能承受“JS catch + dispose + 退出线程 + cleanup worker”多路径。

剩余不确定性：

- `PtyConnect` 失败后是否一定能立即关掉 ConPTY 取决于 `ClosePseudoConsole`；可能需要清理队列排队。
- `SetupExitCallback` 的 TSFN 创建失败路径需要 C1 的 native 测试确认。

### 2.7 修订过程中发现并修正的次要问题

这些问题不在用户列出的六项里，但属于同一轮架构审查，已同步进设计文档：

| 问题 | 修订 |
| --- | --- |
| `Closed` 无法区分 drained 与 unverified | 增加 `drainedVerified`；`PtyKill`/`status` 返回 `unconfirmed` |
| 清理队列只有 pending，没有创建端容量控制 | 增加容量预约 `reserve()`；`PtyStartProcess` 在创建 hpc 前预约；耗尽则 503 `pty_cleanup_busy` |
| `onJobState` 可能早于 JS 监听器注册 | 增加 `jobStatus()`；`onExit` 时补查 |
| `ClosePseudoConsole` 可能等待 output drain | Job 模式延迟 `_close()`/`_cleanUpProcess`/socket 销毁到 `onPtyDisposed` |
| `PtyKill` 在 baton 已移除时返回普通错误 | 返回 `gone:true`；`defaultKillPty` 映射为 `gone` |
| `defaultKillPty` 需要与现有 `KILL_STOP_RESULTS` 对齐 | 使用 `unknown`，不引入 `unconfirmed` 结果值 |
| `PtyStartProcess` 失败时没有 pty id 可交给 JS | 失败路径同步/入队清理 hpc；不能假设 JS 会 dispose |
| `PtyConnect` 失败时 JS 已有 pty id | 入队失败则保留 baton/hpc/预约，让 JS catch dispose 重试 |
| `PtyCleanupManager::shutdown` join 阻塞线程会卡死 | 固定 worker `detach()`；manager 为进程生命周期单例 |

---

## 3. 两个决策的修订

### 3.1 Plan A 回退政策

第一版：

- B+ 首选；B 可回退；A 作为最终回退；只写“需验证”。

第二版：

- B+ 首选，C0 必须通过。
- B 仅作兼容回退：B+ 不可用、C0 证明 B 可用、**人工批准**；因为 B 的验证发生在进程创建后，它比 B+ 弱。
- **A 不作为交付回退**；只有用户明确要求时才单独 spike + 单独批准。A 有“CreateProcessW 后、Assign 前 backend 崩溃”的挂起孤儿窗口，不能自动启用。
- **B+ 和 B 都不可用 → 停止 P3-C**，不强行降级到 A，也不使用 post-spawn Assign。

修改位置：设计文档 §4.5、§16.2。

原因：用户明确要求“B+ 和 B 都不可用就停止，而不是强行降级 A”；同时保留 A 作为独立研究选项，避免把未批准的风险带进交付。

### 3.2 自然退出时后台子进程的处理

第一版：

- 建议自然退出时关闭 Job、杀后代，但把它写成设计方向，接近已批准。

第二版：

- 保留“终端生命周期结束 → 终止正常后代”的方向；
- 明确这是**产品行为变化**：shell 退出后，用户仍在后台运行的 `npm run dev`、测试服务、日志进程等会被杀；
- 说明用户若要长期驻留，应使用独立服务/计划任务/显式脱离 Job 的方式，而不是依赖终端 shell 后代；
- 增加 T24 测试（后台后代仍运行时输入 `exit`）；
- 标记为 **`[决策]` 待用户最终确认**，不写成已批准。

修改位置：设计文档 §12.2（T24）、§14.1、§A.4（待决策清单）。

---

## 4. 文档同步清单

| 章节 | 修订内容 |
| --- | --- |
| 0 | 第二轮修订结论摘要 |
| 1 | 现状审计；明确当前 `PtyKill`/退出线程/HPCON 泄漏；保留 P3-B 边界 |
| 2 | node-pty 源码失败点；`_isReady` 延迟、`_close` drain 风险 |
| 3 | 新增 10 条不变量、五个事实 |
| 4 | Plan A/B/B+ 对比；B+ 首选；B 批准回退；A 不自动；停止条件 |
| 5 | 进程/HANDLE 拓扑、组件表、设计原则 |
| 6 | 原生设计：不可变 `jobMode`、RAII、drain、清理管理器、HANDLE 所有权、JS 管线、错误码 |
| 7 | 原生/JS 状态机；`TerminateJobObject` vs `KILL_ON_JOB_CLOSE`；嵌套 Job 缺口；UI 语义 |
| 8 | Electron/backend 生命周期；disconnect；killServer 保留 |
| 9 | 失败矩阵、失败关闭、cleanupPending、日志 |
| 10 | fork/vendor、构建、staging、升级 |
| 11 | CI 分层 |
| 12 | 原 20 个用例 + 新增 T21–T32；每项含步骤/预期/证据/失败判定/真机 |
| 13 | 工作量修订为 24–38 人日 |
| 14 | 风险与不可解边界；嵌套 Job/WMI、`KILL_ON_JOB_CLOSE` 验证缺口、清理队列满 |
| 15 | P3-C0–C4 实施顺序与退出标准 |
| 16 | 10 个最终问题回答；结论：当前架构不能，必须改 node-pty；可进 C0，不可进 C1 |
| 附录 A | 代码证据、外部文档、未做/未核实、待用户决策 |

---

## 5. 测试新增对照

| 新增用例 | 覆盖问题 | 关键断言 |
| --- | --- | --- |
| T21 Job HANDLE 重复关闭 | 2.5 | 无崩溃/双重 CloseHandle；`jobMode` 不变 |
| T22 Job 终止失败 | 2.1 | `fallback=kill_on_close`；不 PID kill；`killUnconfirmed` |
| T23 ActiveProcesses 清零 | 2.3 | 单调下降到 0；drained 后才 exited |
| T24 shell 自然退出 + 后台后代 | 2.3/3.2 | shellExited 后仍 drain；后代被杀；产品决策待确认 |
| T25 spawn 中途失败 | 2.2/2.6 | 每个 hook 都 503；无 shell/句柄泄漏 |
| T26 旧 binary/打包错配 | 2.2 | 预检拒绝；不创建 shell；不 PID kill |
| T27 100+ 打开/关闭 | 2.4/2.5 | 句柄回基线；队列不永久满 |
| T28 多终端并发退出 | 2.3/2.5 | 无跨终端误杀；队列有界 |
| T29 多线程竞争 | 2.5 | 无崩溃/竞态；状态单调 |
| T30 ClosePseudoConsole 阻塞 | 2.4 | worker 有界；hpc 不丢；503 |
| T31 清理容量耗尽 | 2.4 | 新终端拒绝；旧会话保留；恢复后 disposed |
| T32 backend 异常退出 | 2.3/2.5 | Job 关闭；后代退出；重启可创建 |

---

## 6. 尚未解决的问题

### 6.1 需要 P3-C0 真机实验

1. B+ 的 `PSEUDOCONSOLE` + `JOB_LIST` + `CREATE_SUSPENDED` 三属性组合是否在 Windows 10 22H2 / 11 23H2 / 11 24H2/25H2 上全部成功。
2. `ActiveProcesses` 是否统计挂起进程；`ResumeThread` 前断言是否可靠。
3. conhost/OpenConsole 是否计入 per-terminal Job；退出时是否受影响。
4. `KILL_ON_JOB_CLOSE` 对挂起进程、子 Job 的实际行为。
5. `ActiveProcesses` 是否统计子 Job 的进程；嵌套 Job 的 drain 语义。
6. Windows 10/11 23H2 的 `ClosePseudoConsole` 在输出未 drain 时的阻塞时长。
7. B 方案在创建后验证的实际窗口；是否可接受。
8. A 方案（若单独批准）的挂起孤儿复现与清理。

### 6.2 需要用户决策

1. 自然退出杀后台后代是否接受（产品行为变化）。
2. fork/vendor node-pty + 预编译 `.node` 的供应链方案、签名要求。
3. 最低 Windows 版本是否定为 Windows 10 1809+；受限外层 Job 环境是否接受 fail closed。
4. 是否把 `server.js` 的 `disconnect` 父进程死亡处理纳入 P3-C。
5. 是否接受 B+ 首选、B 仅批准回退、A 不自动启用。
6. 日志/诊断允许记录 `ActiveProcesses` 计数和错误码（不记录 PID 列表/命令行）。
7. 清理队列满时拒绝新终端的上限/worker 数量是否有产品要求。

### 6.3 技术残余

1. `KILL_ON_JOB_CLOSE` 兜底后无法验证 `ActiveProcesses`；`ClosingUnverified`/`Unconfirmed` 是永久验证缺口。
2. 嵌套 Job/WMI/UAC 进程不受 Job 管理或不计入 accounting；Job 不是安全沙箱。
3. 清理 worker 永久阻塞时，队列满、创建被拒绝；只能重启恢复。
4. backend 挂起/死锁时 `disconnect` 不执行；Job 只在进程真正退出时关闭。
5. 旧二进制/打包错配若绕过预检，可能留下未受保护 shell；设计选择不 PID kill，记录 fatal invariant，根因必须靠构建校验修复。
6. `ClosePseudoConsole` 在旧版 Windows 的阻塞行为无法在 Windows 11 26200 上复现，必须真机/VM。
7. `PtyKill`/`dispose`/退出线程的并发状态还需要 C1 stress/TSAN 验证。

---

## 7. 更新后的 P3-C 实施顺序

### P3-C0：spike（3–5 人日）

- 分支 `spike/terminal-job-object`，不合并；
- 验证 B+/B/A（A 仅在用户明确要求时）；
- 矩阵：Windows 10 22H2 / 11 23H2 / 11 24H2/25H2 x64；
- 记录 §6.1 的 8 个问题；
- 退出：选定 B+ 或 B；A 需单独批准；都不行则停止。

### P3-C1：原生（8–12 人日）

- 不可变 `jobMode`；Job 状态机；RAII；drain；有界清理管理器；HANDLE 所有权；test hooks；
- 退出：native 单测/压力/并发通过；无句柄泄漏；P3-B legacy 不回归；
- 独立安全审查；不合并。

### P3-C2：backend（4–6 人日）

- capability；五事实；cleanupPending；503；disconnect；日志；
- 退出：失败关闭；P3-B 不回归；unit/fake PTY 全绿；
- 独立审查；不合并。

### P3-C3：测试/打包/真机/安全（7–10 人日）

- T21–T32；源码/Electron/SEA；hash；真机矩阵；截图；安全审查；
- 退出：gating 用例通过；打包证据；用户批准；
- 不合并、不发版。

### P3-C4：上游/维护（2–5 人日 + 审阅）

- upstream PR；rebase/升级/签名 playbook；升级矩阵。

---

## 8. 是否具备进入 P3-C0 的条件

**具备，但有前置条件：**

1. 用户确认本轮设计修订和 §6.2 的待决策项中与 C0 相关的部分（尤其 B+ 首选、B 批准回退、A 不自动）。
2. 准备 Windows 10 22H2、Windows 11 23H2、Windows 11 24H2/25H2 x64 真机/VM。
3. 安装 Spectre-mitigated MSVC libraries（本机当前未安装）。
4. C0 只在 spike 分支写测试代码，不修改生产代码、不合并。

**不具备进入 P3-C1 的条件：**

- B+ 组合未验证；
- conhost 归属、挂起进程 accounting、嵌套 Job、旧版 `ClosePseudoConsole` 阻塞未验证；
- 自然退出产品决策、fork/vendor/签名未批准；
- 清理队列饱和/100+ 压力/多线程竞争未实测。

**如果 C0 证明 B+ 和 B 都不可用：停止 P3-C。** 不自动降级到 A，不使用 post-spawn Assign，不静默退化为无 Job 的终端。

---

## 9. 本轮验证与限制

- 只修改 `docs/terminal-p3c-job-object-design.md` 和本修订记录；`docs/README.md` 仅更新导航描述。
- 未修改 `server/`、`electron/`、`node_modules/node-pty`、`package.json`。
- 未运行 `npm test`（纯文档变更）；未运行 C0。
- 未核实上游 node-pty 是否已有 Job PR/issue（本轮 WebSearch 不可用）。
- 代码证据来自本地仓库与 `node_modules/node-pty` 1.1.0；外部行为以 Microsoft 文档标注，未实测的部分标 `[C0]`。
- 已执行 `git diff --check`（本任务文档无空白错误）；文档相对链接检查 122 条，0 缺失。
- 本轮文档未提交；工作区中与本任务无关的既有修改未被触碰。
- 未创建 PR、未推送、未合并、未发版。
