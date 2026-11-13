# 终端 P3-C0 真机 spike 结论记录

- 分支：`spike/terminal-job-object`（不合并）
- 日期：2026-11-13
- 设计基线：[terminal-p3c-job-object-design.md](terminal-p3c-job-object-design.md)（第五轮修订，`origin/main` 5c8c9a4）
- spike 代码与原始证据：[spike/terminal-job-object/](../spike/terminal-job-object/)
- 状态：**本机（Windows 11 25H2，10.0.26200.9711，x64）C0 完成；跨版本矩阵未完成**。
  未改生产代码、未提交、未发 PR、未合并。C1 未开始。

## 1. 结论

**在这台机器上，B+ 与 B 都可用，选择 B+。** 依据：

- `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` + `PROC_THREAD_ATTRIBUTE_JOB_LIST` +
  `CREATE_SUSPENDED` + `ResumeThread` 的组合在本机多次运行均成功；
- resume 之前 `IsProcessInJob=true`、`ActiveProcesses==1`，resume 之前 marker 不存在、
  resume 之后存在（证明进程确实被挂起）；
- `KILL_ON_JOB_CLOSE` 对**挂起**进程有效（关最后一个 Job 句柄后 1–2 ms 退出）；
- conhost 在所有 ConPTY 用例中**不在** Job 内。

本轮新增四项实验，全部通过：

1. **后端异常退出**：真实 ConPTY + B+，shell 恢复后启动持续运行的子进程，fixture backend
   以 `0xC0DE` 自杀。父进程在崩溃前用 `OpenProcess` 拿到 shell 与子进程句柄；
   崩溃后两者分别在 1–3 ms 内 `WAIT_OBJECT_0`，tick 文件停止增长。
2. **双终端隔离**：两个独立 Job/ConPTY/shell/子进程；终止 A 后 A 的 shell 与子进程退出、
   tick 冻结在 18，B 的 tick 从 3 涨到 17 且两个进程仍存活、accounting 仍为 2。
3. **worker_threads 环境销毁**（Node 24.22.1 与 Electron 44.4.3 结果一致）：worker env
   可以正常结束、宿主继续运行；env 所属 Job 在清理线程关闭最后一个句柄后回收
   （子进程 1–7 ms 退出）；清理线程返回后写入 native 终态。实测顺序为
   `env-cleanup-hook → tsfn-finalize(holdersAtEntry=1) → release exit-thread(status=0) →
   worker exit`——**finalizer 可能在最后一个 release 返回之前执行**。
4. **ConPTY 尾部输出 EOF**：shell 自然退出后，输出管道 **8 s 内没有 EOF**；
   `ClosePseudoConsole` 返回后约 31–38 ms 才出现 `ERROR_BROKEN_PIPE(109)`。
   关闭仍在运行的 ConPTY：`ClosePseudoConsole` 0 ms 返回，14–18 ms 后 EOF，
   shell 退出码 `0xC000013A`（STATUS_CONTROL_C_EXIT）。

Plan A 未验证（按 C0 约束需用户单独批准）。**C0 未覆盖 Windows 10 22H2、11 23H2、
11 24H2**：本机是 Windows 11 25H2（build 26200.9711），不能把本次观察写成跨版本保证。

C0 暴露的、会改变 C1 实现的事实集中在 §6；三处实现契约已收敛到
[C1 实现规格](terminal-p3c1-implementation-spec.md)，本文只保留证据与结论。

## 2. 环境

| 项 | 值 |
| --- | --- |
| OS | Windows 11 Home China 10.0.26200.9711，x64 —— **Windows 11 25H2**（RtlGetVersion 报 26200） |
| 编译器 | VS 18 BuildTools，MSVC 14.51.36231 |
| SDK | Windows SDK 10.0.26100.0 |
| Node | v24.22.1（N-API 10） |
| Electron | 44.4.3（内置 Node 24.21.0，N-API 10） |
| 构建 | 完全离线：本机 MSVC + `%LOCALAPPDATA%\node-gyp\Cache\24.22.1` 头文件/`node.lib`；无新增依赖、无网络 |

环境限制，读数字时必须带上：

- 本会话的 spike 进程本身运行在一个**外层 Job** 里（`selftest.inAnyJob=true`），
  且该外层 Job 拒绝 `CREATE_BREAKAWAY_FROM_JOB`（`CreateProcessW` 返回 5）。
  因此本次所有 Job 用例都是**嵌套 Job** 场景；生产 Electron 是否带外层 Job 需在打包环境复核。
- 执行沙箱拒绝在 `%TEMP%` 下 `CreateDirectoryW`（错误 5）。fixture 改放
  `spike/terminal-job-object/.tmp/`；这是测试环境限制，不是产品缺陷。
- `ClosePseudoConsole` 的 0 ms 结果只属于本 OS 版本，不能外推。
- 本机只有 25H2 一个系统；pre-24H2 行为（尤其 `ClosePseudoConsole` 阻塞）没有真机证据。

## 3. 方法

`win32-spike.cpp` 是一个自包含的 Win32 控制台程序，所有子进程都是它自己的
`child` / `crash-helper` / `backend-crash-helper` / `watch-child` / `conpty-close` 模式，
不依赖 pi、node-pty 运行时或用户数据。
`lifecycle-spike.cc` 是按 node-pty 同款方式（node-gyp 延时加载钩子）构建的 N-API addon；
`run-lifecycle.mjs` 驱动原有 TSFN 场景，`run-worker-lifecycle.mjs` 在 Node 24 与
`ELECTRON_RUN_AS_NODE=1` 的 Electron 44 下驱动 worker env 销毁场景。

子进程身份一律用**预先打开的进程句柄**判定，不用崩溃后的 PID 查找；子进程存活用
tick 文件（每 100 ms 追加一行）判定，不用 PID/端口/时间戳猜测。

未做：UAC 提权、计划任务、真实服务创建、真实 pi 会话、任何写用户数据的操作。

## 4. Win32 结果

原始输出：

- 首轮 16 项：[results/win32-all.jsonl](../spike/terminal-job-object/results/win32-all.jsonl)（`failed:0`）
- 增加新用例后的回归：[results/win32-all-v2.jsonl](../spike/terminal-job-object/results/win32-all-v2.jsonl)
  （**20 项，`failed:0`**）
- 新用例单跑：`results/win32-backend-crash-run1.log`、`win32-backend-crash-run2.log`、
  `win32-two-terminals.log`、`win32-conpty-eof-natural.log`、`win32-conpty-eof-close.log`

### 4.1 B+ / B 组合

| 用例 | 结果（首轮 / 回归） |
| --- | --- |
| `bplus-conpty`（ConPTY + JOB_LIST + suspended） | spawn **15 / 14 ms**；`inJobBeforeResume=true`；`activeBeforeResume=1`；`markerBeforeResume=false`；`resumeRet=1`；`markerAfterResume=true`；shell 退出码 0；`conhostInJob=false` |
| `bplus-noconpty` | 同上，spawn **11 / 11 ms** |
| `b-conpty`（不挂起） | `inJobBeforeResume=true`；`activeBeforeResume=1`；shell 退出码 0；spawn **12 / 15 ms** |
| `b-noconpty` | 同上，spawn **12 / 12 ms** |

> 更正：上一版报告写的 12/22/12/16 ms 与原始日志不符；上表取自两份 JSONL。

**实现细节（新增，设计未写）**：ConPTY 客户端必须按 node-pty `conpty.cc:387-390`
设置 `STARTF_USESTDHANDLES` 且 `hStdInput/hStdOutput/hStdError = nullptr`。
spike 最初漏了这一步，`cmd /k` 在 2 s 内以退出码 0 自行退出、只输出两段转义序列；
补上后同一组合稳定给出 banner 与提示符。C1 重建 `CreateProcessW` 时必须保留这一行为。

### 4.2 accounting、嵌套 Job、conhost

- `conpty-shell`：`activeBeforeResume=1`、`activeRunning=1`（仅 `cmd.exe`）、
  `conhostBeforeResume=false`、`conhostRunning=false`；`exit` 后
  `activeAfterShellExit=0`、`activeAfterCloseShell=0`。
- `nested-job`：同一进程同时在 parent/child 两个 Job（`inParent=true`、`inChild=true`），
  两边 `ActiveProcesses` 都是 1；`TerminateJobObject(parent)` 后进程 `wait=0`，
  两边 accounting 都归 0。
- `natural-exit-descendant`：shell 正常退出后，`start /b` 起的后代仍在 Job 内且存活
  （`activeAfterShellExit=1`，`pidsAfterShellExit=[pid]`）；`TerminateJobObject` 后
  1 ms 退出。

### 4.3 失败路径与句柄语义（`wait-failures`）

| 调用 | 结果 |
| --- | --- |
| `WaitForSingleObject` 运行中 | `WAIT_TIMEOUT` (258) |
| `WaitForSingleObject` 无效句柄 | `WAIT_FAILED` (0xFFFFFFFF)，`GetLastError=6` |
| `TerminateProcess` 运行中 | `TRUE`，随后 `wait=0` |
| `TerminateProcess` 已退出 | `FALSE`，错误 5 |
| `TerminateProcess` 无效句柄 | `FALSE`，错误 6 |
| `CloseHandle` 第二次 | `FALSE`，错误 6 |
| 二次关闭失败后继续用该值 | `WaitForSingleObject=WAIT_FAILED` 错误 6；`TerminateProcess=FALSE` 错误 6（句柄值已失效） |
| `CloseHandle(NULL)` / 非法值 | `FALSE`，错误 6 |

`TerminateJobObject` 的时间窗（`terminate-timing`）：返回耗时 0 ms；
立即 `WaitForSingleObject(0)` 三次都是 258；`ActiveProcesses` 立即读到 0；
进程实际退出在**首轮 3/3/3 ms、回归 1/1/1 ms**。`TerminateJobObject` 成功不等于进程已退出，
**accounting 归零也不等于进程已退出**（先归零、后退出）。

### 4.4 `ClosePseudoConsole`

`conpty-close`（子进程内调用，父进程 25 s 等待）：

- drain（持续读走输出）：`closeMs=0`，`bytesRead=337`，父进程 elapsed 1074 ms；
- nodrain（积压 8000 行不读）：`closeMs=0`，`bytesRead=0`，elapsed 1063 ms。

本机两种模式都立即返回。**不能据此认为它在所有版本都不阻塞**；设计里的有界清理
与后台线程约束仍然必要。

### 4.5 崩溃与挂起进程

- `kill-on-close-suspended`：resume 前 `ActiveProcesses=1`；关闭最后一个 Job 句柄后
  `wait=0`，`exitMs=1`。
- `crash-before-resume`：helper 建 Job + 挂起子进程、记录 PID 后以 `0xC0DE` 自杀；
  父进程在 helper 死前先拿到子进程句柄（`childOpen=true`），helper 退出后
  子进程 `wait=0`。用句柄身份等待，不依赖 PID 复用窗口。

### 4.6 Connecting 期取消竞态（`connect-race`）

同一 Job 句柄被 `CreateProcessW`（JOB_LIST）与 `TerminateJobObject` 并发使用，
每个时序 20 次迭代：

| 时序 | 结果 |
| --- | --- |
| Terminate **先于** CreateProcessW（空 Job 已 terminate） | CreateProcessW 仍成功 20/20；新进程 `inJob=true` 20/20；`ResumeThread=1`；3 s 后仍 `STILL_ACTIVE`、`ActiveProcesses=1`（20/20）——**已终止的 Job 不会杀死后来创建的成员，也不阻止创建** |
| Terminate **与** CreateProcessW 并发 | CreateProcessW **全部失败，错误 5（拒绝访问）** 20/20；无进程产生 |
| CreateProcessW（挂起）后、Resume 前 Terminate | CreateProcessW 成功 20/20；`inJob=true`；`ResumeThread=0`（不是 1，也不是 -1）；进程已退出，`wait=0`，退出码 1 |
| Resume 后 Terminate | 正常：`ResumeThread=1`，`wait=0`，退出码 1 |

直接含义：

1. `TerminateJobObject` 只杀**当时**的成员，不是“关闭闸门”。abort 落在
   `CreateProcessW` 之前时，之后创建的 shell 仍会运行；连接路径必须在 create 之后
   检查 `abortRequested`，并对这个新 shell（或 Job 句柄）做受检清理。
2. 并发 Terminate 会让 `CreateProcessW` 返回 `ERROR_ACCESS_DENIED`。C1 必须把
   “abort 已请求时的 CreateProcess 失败”当作取消路径处理，不能当普通 spawn 错误上报。
3. `ResumeThread` 在 Terminate 之后返回 0；不能用它的返回值证明“shell 已恢复运行”。

### 4.7 后端异常退出（新，实验 1）

OS 10.0.26200.9711；命令 `./win32-spike.exe backend-crash`，连续两次留档：
[run1](../spike/terminal-job-object/results/win32-backend-crash-run1.log)、
[run2](../spike/terminal-job-object/results/win32-backend-crash-run2.log)。
全量回归 `win32-all-v2.jsonl` 中同一用例测得 1 ms，因此记为 **1–3 ms**。

fixture backend 自己做 B+：Job（`KILL_ON_JOB_CLOSE`）+ ConPTY + 挂起 `cmd /k`，
resume 后经 ConPTY 启动 `child --seconds 60 --tick-file ... --tick-ms 100`，
写状态文件后 `TerminateProcess(self, 0xC0DE)`，不关闭任何句柄。

| 事实 | run1 | run2 |
| --- | --- | --- |
| helper 退出 | `wait=0`，退出码 **49374（0xC0DE）** | 同 |
| helper 崩溃前 | `inJobBeforeResume=true`、`activeBeforeResume=1`、`activeBeforeCrash=2`、`pidsBeforeCrash=[shell, child]` | 同 |
| 父进程预取句柄 | shell/child 均 `OpenProcess` 成功，崩溃前 `wait(0)=258`（存活） | 同 |
| shell 崩溃后 | `wait=0`，**3 ms**，`GetExitCodeProcess=0` | `wait=0`，**3 ms**，退出码 0 |
| 子进程崩溃后 | `wait=0`，**3 ms**，退出码 0 | 同 |
| tick 文件 | 崩溃前 1 行 → 死亡时 19 行 → 500 ms 后仍 19 行 | 1 → 20 → 20 |

**含义：** Job 句柄随进程退出关闭后，`KILL_ON_JOB_CLOSE` 同时带走 shell 与后代；
判定用预先打开的进程句柄，不依赖崩溃后的 PID。**退出码 0 不能区分“自然退出”与
“Job 关闭击杀”**——C1 不得用退出码推断清理原因。

### 4.8 双终端隔离（新，实验 2）

OS 10.0.26200.9711；命令 `./win32-spike.exe two-terminals`；
原始日志：[win32-two-terminals.log](../spike/terminal-job-object/results/win32-two-terminals.log)。

两个终端各自持有独立 Job、HPCON、`cmd /k` 和 tick 子进程（每 100 ms 一行）。

| 事实 | 结果 |
| --- | --- |
| 停止前 | A tick 18 行、B tick 3 行；两边 `ActiveProcesses=2` |
| `TerminateJobObject(A)` | 返回 TRUE；A shell `wait=0`；A 子进程 `wait=0`；A accounting 立刻为 0 |
| 1.5 s 后 | A tick **18（冻结）**；B tick **17（3 → 17）**；B shell/子进程 `wait(0)=258`（存活）；B accounting **2** |
| B 清理 | 测试结束时 `TerminateJobObject(B)` 后两边退出 |

**含义：** 每个终端一个 Job 的隔离成立；停一个不会波及另一个。`TerminateJobObject`
后 accounting 立即归零，再次说明它不能作为“进程已退出”的判据。

### 4.9 ConPTY 尾部输出 EOF（新，实验 4）

OS 10.0.26200.9711；命令 `./win32-spike.exe conpty-eof-natural` /
`./win32-spike.exe conpty-eof-close`；
原始日志：[win32-conpty-eof-natural.log](../spike/terminal-job-object/results/win32-conpty-eof-natural.log)、
[win32-conpty-eof-close.log](../spike/terminal-job-object/results/win32-conpty-eof-close.log)。

| 场景 | 结果 |
| --- | --- |
| 自然退出：`call script`（`@echo tailmarker_p3c0`）+ `exit` | shell 1.5 s 内退出，退出码 0；尾部输出 marker 可见（`bytesRead=292`）；**随后 8 s 内 `PeekNamedPipe` 未报 EOF**；调用 `ClosePseudoConsole`（0 ms 返回）后约 **31–38 ms** 才得到 `ERROR_BROKEN_PIPE(109)`（`eofMs=9555`，action 在 1517 ms） |
| 运行中关闭：`ClosePseudoConsole` | 返回 **0 ms**；**14–18 ms** 后 EOF（`eofMs=1533`，action 在 1515 ms）；shell `wait=0`，退出码 **3221225786 = 0xC000013A**（STATUS_CONTROL_C_EXIT） |

**含义：**

1. **shell 退出不等于输出 EOF。** ConPTY 的输出写端由 pseudoconsole 持有；
   shell 退出后它仍保持打开，直到 `ClosePseudoConsole`。
2. 因此 C1 不能把“读端 EOF”当作 shell 退出或清理完成的信号；读取端必须保留到
   `ptyDisposed`/`ClosePseudoConsole` 返回之后（与设计 §6.10 的 socket 保留规则一致）。
3. `ClosePseudoConsole` 会让仍在运行的 shell 以 `0xC000013A` 退出；退出码映射不能假设 0。

### 4.10 WMI 与服务/UAC/AppInfo

- 基线（PowerShell 只在环境外层 Job 内，不在 spike 新建的 Job 内）：
  `[wmiclass]'Win32_Process'.Create(...)` 返回 `RV=0`，成功创建进程并写出 marker/PID；
  该进程不在 spike 的 Job 内。
- 把 PowerShell 放进 spike 的新 Job（`JOB_LIST` 创建，或创建后
  `AssignProcessToJobObject`；带/不带 `KILL_ON_JOB_CLOSE`；带
  `JOB_OBJECT_LIMIT_BREAKAWAY_OK`）后，`Win32_Process.Create` **全部抛“拒绝访问”**，
  进程未创建（4 种变体结果一致，各运行 1 次）。
- `Invoke-CimMethod` 在本机 PowerShell 上本身就有 `CimType` 参数异常，改用
  `[wmiclass]` 路径；这是环境事实，不是产品结论。
- 由于外层 Job 拒绝 breakaway，无法构造“调用方只在一个非嵌套 Job 中”的生产形态；
  WMI 这一项的最终结论是**未知（三值中的“未知”）**，需要在打包后的 Electron
  环境重测。服务/计划任务/UAC/AppInfo 未测试（需要提权或写系统状态）。

设计第 14 节已把 WMI/服务/UAC/AppInfo 列为 Job 无法管理的路径；本次实测至少说明：
**不能假设这些路径创建出来的进程会进入终端 Job**，也不能为了“兜底”而依赖
`TerminateJobObject` 覆盖它们。

## 5. N-API / TSFN 生命周期（Node 24 与 Electron 44）

原有 addon 场景：`napi_create_threadsafe_function`（initial thread count = 1，
queue = 64，unref），`napi_add_env_cleanup_hook` 只置 stop/SetEvent，不释放 TSFN；
退出线程持初始引用，清理线程不持引用。Node 与 Electron 的结果逐项一致。

| 场景 | Node 24.22.1 | Electron 44.4.3（Node 24.21.0） |
| --- | --- | --- |
| JS 退出时退出线程仍持引用（`wait`，150 ms 后 `process.exit`） | 退出 0（165 ms）；`holders=1`、`exitThreadDone=false`；teardown 未被阻塞 | 同 |
| JS 线程忙 400 ms、退出线程排空队列（`drain`） | 退出 0（404 ms），未阻塞 | 同 |
| 清理线程在“`ClosePseudoConsole` 式”调用中阻塞 3 s、零 TSFN 引用（`closeBlock`） | stop 57 ms；TSFN 在 **57 ms** finalize；进程 **212 ms** 退出，**没有等清理线程**（`cleanupThreadDone=false`、`finalPtyDisposed=false`） | stop 60 ms；finalize **62 ms**；退出 **214 ms** |
| 队列容量 2、5 万次 post（`spam`） | `queueFull=50083`，成功 post 23，无崩溃 | `queueFull=50068`，成功 post 22 |
| finalize 之后再 post | **段错误**（UAF） | **段错误** |
| `napi_tsfn_abort` 后立刻 post（无额外引用） | post 返回 **1（`napi_invalid_arg`）**；进程随后崩溃（日志停在退出线程 release 内，退出码 139） | 同 |
| 先 `napi_acquire` 再 abort，然后 post | post 返回 **16（`napi_closing`）**，计入 `closingPosts`；但 finalizer **在 abort 时立即执行**（holders 仍为 2）；进程随后崩溃（退出码 139） | 同 |
| 自然退出（unref、无定时器） | `process.on('exit')` → 队列回调 `status=10`（`napi_pending_exception`）→ cleanup hook → finalize → 退出线程 release，退出 0 | 同 |
| 不 unref（`UNREF=0`） | 事件循环被 TSFN 引用撑住，直到 1013 ms 退出线程 release 后才自然退出 0 | 同 |

> 更正：上一版写的“finalize 56–63 ms、进程 211–216 ms 退出”与日志不符；
> 上表取自 `results/node-closeblock.log`、`results/electron-closeblock.log`。

### 5.1 worker_threads 环境销毁（新，实验 3）

驱动：[run-worker-lifecycle.mjs](../spike/terminal-job-object/run-worker-lifecycle.mjs)；
命令 `node run-worker-lifecycle.mjs win32-spike.exe` /
`ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron.exe run-worker-lifecycle.mjs win32-spike.exe`；
OS 10.0.26200.9711；原始日志：
[node-worker-env.log](../spike/terminal-job-object/results/node-worker-env.log)、
[electron-worker-env.log](../spike/terminal-job-object/results/electron-worker-env.log)。

worker env 内：Job（`KILL_ON_JOB_CLOSE`）+ 挂起子进程（JOB_LIST，resume 成功）+
TSFN/exit-thread fixture（mode 4）。清理线程**零 TSFN 引用**、阻塞在宿主控制的
barrier 文件上，且**从不 post**，只写 native 终态。宿主在 worker 退出前用
`win32-spike.exe watch-child` 打开子进程句柄，worker 退出后释放 barrier。

| 事实 | Node 24.22.1 | Electron 44.4.3 |
| --- | --- | --- |
| worker 内 B+ | `inJob=1`、`activeBeforeResume=1`、`resumeRet=1` | 同 |
| worker 退出 | `exit code 0`，`workerError=null`；宿主继续运行 | 同 |
| env 结束 | cleanup hook 后约 1–5 ms 完成 finalize/release/exit-thread | 同 |
| finalizer 入口 | `holdersAtEntry=1`，`holdersNow=1` | 同 |
| 最后一次 release | finalize 之后调用，返回 **0（napi_ok）**，`holders=0` | 同 |
| TSFN 引用顺序（append 顺序） | cleanup hook → finalize → release → exit-thread done → **host 观察到 worker exit** | 同 |
| Job 回收 | 清理线程关最后一个 Job 句柄后，子进程 **1–2 ms** 退出，`childWait=0` | **3–7 ms** |
| native 终态 | barrier 释放后写入：`released=true`、`childWait=0`、`childExitMs`、`stateWrittenAt` | 同 |
| tick | 打开时 1 行 → 释放前 3 行 → 结束后仍 3 行（子进程确实运行过并已停止） | 同 |
| barrier 释放 → 子进程退出 | 25–32 ms（含 watch-child 进程调度） | 34–44 ms |

逐字顺序（Node，毫秒为 native 精确时钟）：

```text
... worker-unref → worker-posted → worker-port-closed
env-cleanup-hook → exit-thread-stop-observed → tsfn-finalize(holdersAtEntry=1)
→ release exit-thread(holders=0, status=0) → exit-thread-done
→ host-worker-exit(code=0)          [宿主仍在运行]
→ host-release-written → cleanup-release-observed
→ cleanup-final-state-written(childWait=0) → cleanup-thread-done → host-watcher-exit
```

**结论：** “清理线程零 TSFN 引用、只写 native 终态，JS 定期对账”的最小方案可用。
worker env 销毁不会阻塞宿主，也不会丢失 Job 回收与终态写入。

### 5.2 TSFN finalizer 执行 vs 底层对象实际销毁（两个事实）

- **事实 A（实测）：finalizer 回调被执行。** 在 env teardown 期间执行，且可能发生在
  最后一个 `napi_release_threadsafe_function` 返回**之前**（本实验 `holdersAtEntry=1`）；
  release 随后仍返回 `napi_ok`。finalizer 不是“最后一个使用者已退出”的信号。
- **事实 B（无法直接观测）：底层 TSFN 对象的实际销毁时刻。** Node-API 不暴露该时刻。
  已确认的是：finalize 之后调用 `napi_call_threadsafe_function` 会崩溃（§5 表），
  说明对象已进入不可用状态；但**不能**据此推断 release、finalizer、对象释放三者的
  严格先后。C1 不得依赖“finalize 之后某个 release 才完成”或“release 返回时对象仍可用”。

## 6. 需要回写设计的发现

按影响排序（C1 开始前应更新设计或明确接受）：

1. **`TerminateJobObject` 不是关闭闸门**（§4.6 第一行）。设计 §6.4/§6.5 的 abort 路径
   需要明确：abort 早于 CreateProcessW 时，`TerminateJobObject` 不能阻止新 shell
   创建并运行；必须由连接路径在 create 后检查并清理。
2. **并发 Terminate 使 `CreateProcessW` 失败（错误 5）**。设计中“Terminate 并发安全”
   的表述需要限定：内核调用本身安全，但并发窗口内的 CreateProcessW 可能失败，
   必须映射为取消，而不是启动失败。
3. **`ResumeThread` 返回值不能作为恢复成功的判据**（Terminate 后返回 0）。
4. **ConPTY 客户端的 `STARTF_USESTDHANDLES` + null std handles** 必须写入 C1 的
   CreateProcess 步骤（设计当前只写了 `bInheritHandles=false`）。
5. **TSFN 生命周期规则**（§5）：禁止 finalize 后调用；禁止 abort 后其他线程再触碰；
   cleanup hook 不 release；终态存储独立于 env。**新增：finalizer 可能在最后一个
   release 返回前执行**，因此 finalizer 内不得关闭 `hStopEvent`、不得释放 channel/
   baton 对象、不得假设退出线程已结束；`hStopEvent` 由 `ExitThreadControl` 的
   最后一个强引用在清理 hook 注销/执行之后关闭（见 C1 规格 §3.1）。
6. **shell 退出不等于输出 EOF**（§4.9）：ConPTY 输出管道在 shell 退出后仍保持打开，
   直到 `ClosePseudoConsole`。C1 的读取端不能以 EOF 驱动 shell 退出/清理状态机；
   `onExit` 只来自进程句柄。
7. **`ClosePseudoConsole` 会让运行中的 shell 以 `0xC000013A` 退出**（§4.9）。
   退出码映射不能假设 0，也不能把非 0 当作启动失败。
8. **`KILL_ON_JOB_CLOSE` 击杀的进程退出码可以是 0**（§4.7）。不能靠退出码区分
   自然退出与 Job 击杀；需要 `terminateAccepted`/Job 状态与快照。
9. **accounting 归零早于进程退出**（§4.3、§4.8）。`ActiveProcesses==0` 不能证明
   进程已退出；drain 判定只用于“树已清空”的最终确认，且仍需句柄等待配合。
10. **双终端 Job 隔离成立**（§4.8），停止一个终端的任何操作不得触碰另一个的
    Job/HPCON/shell 句柄。

## 7. 逐版本边界与未验证项

- **已覆盖：** Windows 11 25H2（10.0.26200.9711，x64）。
- **未覆盖：** Windows 10 22H2（19045）、Windows 11 23H2（22631）、Windows 11 24H2（26100）。
  `ClosePseudoConsole` 阻塞、管道 EOF 时序、`TerminateJobObject` 时间窗、WMI 行为
  在不同版本可能不同，不能把本报告数字当作跨版本保证。
- **未验证：** Plan A；服务/计划任务/UAC/AppInfo 创建路径；真实 pi 会话；打包 Electron
  主进程（无外层 Job、无控制台）下的 WMI 与 Job 归属；App 退出时清理线程与
  `ClosePseudoConsole` 的真实时序；worker 场景仅覆盖 `ELECTRON_RUN_AS_NODE`，
  未覆盖 Electron 主进程与渲染进程的完整生命周期。
- `conhost` 未进入 Job 是本次所有 ConPTY 用例的一致结果，但设计已声明不依赖它退出。

**在缺失版本上复现本报告的命令**（任何一台机器）：

```bash
cmd.exe //c "C:\pi-GUI\spike\terminal-job-object\build.cmd"
cd spike/terminal-job-object
./win32-spike.exe selftest
./win32-spike.exe --all
node run-worker-lifecycle.mjs win32-spike.exe
ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron.exe run-worker-lifecycle.mjs win32-spike.exe
```

重点对比：`conpty-close` 的 `closeMs`（旧版本可能阻塞）、`conpty-eof-*` 的
`eofAfterAction`/`eofMs`、`terminate-timing` 的 `exitMsFromTerminate`、`connect-race`
的 `createErr=5` 计数。每台机器记录 `selftest.windows` 与 `winver` 输出。

## 8. 复现

```bash
cmd.exe //c "C:\pi-GUI\spike\terminal-job-object\build.cmd"
cd spike/terminal-job-object
./win32-spike.exe --all
```

Node / Electron 原有生命周期场景与全部环境变量见
[spike/terminal-job-object/README.md](../spike/terminal-job-object/README.md)。
新增 worker 场景：

```bash
node run-worker-lifecycle.mjs win32-spike.exe
ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron.exe run-worker-lifecycle.mjs win32-spike.exe
```

原始证据在 `results/`：`win32-all.jsonl`、`win32-all-v2.jsonl`、
`win32-backend-crash-run1.log`、`win32-backend-crash-run2.log`、
`win32-two-terminals.log`、`win32-conpty-eof-*.log`、
`node-worker-env.log`、`electron-worker-env.log`、`node-*.log`、`electron-*.log`。

## 9. 边界声明

本次只新增/修改 `spike/terminal-job-object/` 与相关文档；**未修改** `server/`、`electron/`、
`public/`、`package.json`、node-pty 源码或任何生产代码，未新增依赖，未提交、未推送、
未发 PR、未合并。C1 未开始。

## 10. C1 准入判断

**结论：可以进入 C1，前提是把“跨版本验证”作为 C1 的出口门槛，而不是入口门槛。**

已具备的依据：

1. Plan B+ 在本机通过全部 20 项 Win32 用例（含真实 ConPTY、后端崩溃、双终端、EOF、
   取消竞态），B 作为回退可用；
2. 三处实现契约已经收敛并可执行：Connecting 仲裁与句柄交接、TSFN 引用/finalizer/
   停止事件/终态归属、真实回调接入与四类确认。见
   [C1 实现规格](terminal-p3c1-implementation-spec.md)；
3. 最小 TSFN 方案（清理线程零引用、只写 native 终态，JS 定期对账）在 Node 24 与
   Electron 44 的 worker env 销毁场景下验证通过；
4. 设计文档中与实测冲突的点（§6 的 10 条）已有明确处置方向。

仍缺的证据（C1 期间必须补齐，不能作为“已完成”报告）：

- Windows 10 22H2 / 11 23H2 / 11 24H2 的真机结果，尤其 `ClosePseudoConsole` 是否阻塞、
  管道 EOF 时序、`JOB_LIST` 创建路径；
- 打包 Electron 主进程（无外层 Job）下的 WMI/服务创建路径与 Job 归属；
- App 退出、`disconnect`、进程崩溃三种清理路径的真实时序；
- Plan A（未获批准，不启动）。

需要人工决定的事项：

1. **支持版本矩阵**：是否把 Win10 22H2 / 11 23H2 / 11 24H2 作为 C1 合并门槛，
   还是允许在 25H2 先行、旧版本 fail-closed（`supportsJobObject=false`）。
2. **node-pty 改造方式**：fork/vendor 的最小补丁范围与打包 hash 策略（设计 §11），
   以及是否保留 Plan B 作为运行时回退。
3. **C1 交付范围**：是否包含打包环境 WMI 重测与 worker/主进程双形态验证。
