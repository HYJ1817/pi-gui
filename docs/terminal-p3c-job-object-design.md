# 终端 P3-C：Windows Job Object 进程生命周期管理设计（第五轮最终定向修订基线）

- 状态：第五轮最终定向修订，彻底解决真实 C++ 实现中的 TSFN 生命周期、环境钩子 API 契约与 Connecting 锁协议剩余问题，建立无可争议的 P3-C 最终设计基线，待人工审查；**本轮未实施任何生产代码修改**
- 目标文件：`docs/terminal-p3c-job-object-design.md`。工作区中本文件是当前唯一的 P3-C Job Object 设计正文，未创建替代文件
- 仓库基线：`origin/main` `5c8c9a4`（PR #79，P3-B 已合并）
- 上一版审查基线：第四轮定稿设计基线（2595 行）
- 日期：2026-11-13
- 范围：pi-GUI 内置终端（ConPTY）；不含 P31 受管进程、Agent 子进程、Git 子进程
- 本轮目标：解决验收发现的五项剩余实现问题：
  1. 修复 TSFN Acquire/Release 真实生命周期（先 check `napi_ok` 再计计数、CAS 严防下溢、清理 Worker 在执行阻塞 `ClosePseudoConsole` 期间解耦 TSFN 引用）；
  2. 核对并修正 `AddCleanupHook` 真实 API（依据 `node-addon-api@7.1.1` 源码，消除模板语法错误与 shared_ptr 循环引用，明确三条清理路径）；
  3. 彻底统一 Connecting 的锁与取消协议（明确区分 5 种权利，消除 6.4/6.5/6.6 冲突，给出严格线性化点与时序图）；
  4. 统一 `PtyEvent` 结构（`{ type, snapshot, finalState }`），不可变快照消费与终态隔离；
  5. 修正 T41（按等待 shell / 执行 drain / Worker 阻塞在 ClosePseudoConsole 三大场景细化）与 T42（覆盖 Worker 与事件通道并发销毁六大场景）测试真实性。

证据等级（全文统一）：

- `[源码]`：当前仓库或 `node_modules` 源码直接证明
- `[文档]`：Microsoft Learn / Windows SDK 头文件 / Node-API 官方规范直接证明
- `[C0]`：需要 P3-C0 真机实验验证的假设，不能当成已成立事实
- `[决策]`：需要用户批准的产品或供应链决策
- `[未核实]`：本轮没有条件确认的外部状态（如上游 node-pty 是否已有相关 PR）

> 本轮依据本地 `node-pty@1.1.0` 源码、`node-addon-api@7.1.1` 源码（`napi.h` 与 `napi-inl.h`）、Microsoft Learn 官方文档与 Node-API 规范进行逐行核验。

---

## 0. 设计修订演进摘要

### 0.1 历史轮次核心问题收敛

1. **Job 模式不可逆与隔离：** `jobMode` 为不可变字段（构造时确定），模式一旦建立绝不降级，Job 模式绝对禁止 `process.kill(pid)` / `taskkill` / `_getConsoleProcessList()`。
2. **生命周期事实解耦：** 拆分 `shellExited`、`jobTerminating`、`jobDrained`、`ptyDisposed`、`sessionExited` 等状态；Shell 退出不等于整树清空，必须依赖 accounting 轮询。
3. **有界清理资源控制：** 废除每次 dispose 创建 detached 线程的做法，采用固定 2 个 worker + 容量预约机制（`kMaxTracked=32`）。
4. **第四轮基线固化：** 引入 Node-API 环境清理钩子打破退出线程死锁；废除 `result: 'killed'`；分离不可变快照与共享终态；消除主线程同步 `ClosePseudoConsole` 兜底；解耦 `sessionExited` 与四阶 `cleanupState`；拆分 T33A/T33B 并增加 T41～T46。

### 0.2 第五轮定向修订（最终实现闭环）清单

| # | 问题项 | 源码与规范核查依据 | 本轮解决方案与最终基线结论 |
| --- | --- | --- | --- |
| 1 | TSFN Acquire/Release 生命周期不完备 | `napi-inl.h:6027` 确认 `tsfn.Acquire()` 返回 `napi_status`；若直接 `fetch_add` 会留下假计数；若 Cleanup Worker 在 `ClosePseudoConsole` 期间持 TSFN 会因旧版 Windows 挂起而阻塞 Node 退出 | `AcquireHolder()` 仅在 `tsfn.Acquire()` 返回 `napi_ok` 后原子递增计数；`ReleaseHolder()` 采用 CAS 循环严防下溢；**核心引用解耦：** Cleanup Worker 执行 `ClosePseudoConsole` 期间只持 native 状态、**绝不持有 TSFN 引用**，API 返回后仅在环境未关闭时临时 Acquire 投递事件并立即 Release，从根本上杜绝阻塞清理任务阻碍 Node 环境 teardown |
| 2 | `AddCleanupHook` 真实 API 语法与强引用循环 | `napi.h:321` 确认 `template <typename Hook, typename Arg = void> class CleanupHook` 为模板类，原设计无模板参数无法编译；lambda 按值捕获 `shared_ptr<channel>` 造成自持有循环引用；`CleanupHook` 无自动析构清理且 `Remove(env)` 需要有效 env | 明确原生类型契约，采用 Node-API 稳定的函数指针控制块 `napi_add_env_cleanup_hook(env, OnEnvCleanupHook, channel.get())`；传递 raw pointer 彻底消除循环强引用；明确区分正常销毁（主线程调 `Remove`）、构造异常（立即回滚）与环境 teardown（Hook 触发后已自动除名，Finalizer 绝不调用 Remove，绝不在失效 env 上调用）三条路径 |
| 3 | Connecting 锁与取消协议冲突 | 原 6.4 称 T2 无锁调 `TerminateJobObject`，而 6.6 又称所有操作受 mutex 串行，且 6.5 的 `RequestJobTerminationLocked` 又持锁调终止，存在概念混淆与所有权风险 | 严格划分 5 种权利：① `abortRequested` 原子写入权（无锁、微秒级、T2 专属）；② `hJob` 使用权（Connecting 期间 T1 Guard 独占）；③ `hJob` 关闭权（Connecting 期间唯一归属 T1 Guard，T2 严禁关闭）；④ `ResumeThread` 调用权（T1 独占，abort 触发即剥夺）；⑤ 状态提交权（`handle->mutex` 短锁内原子 CAS 提交，绝不回退 Active，锁内绝无 Sleep/清理操作） |
| 4 | `PtyEvent` 结构不统一 | 原 6.1 与 6.10 字段不完全对称，缺少显式的 `PtyEventType` 顶层鉴别字段 | 统一使用 `struct PtyEvent { PtyEventType type; PtyEventSnapshot snapshot; std::shared_ptr<PtyFinalState> finalState; };`；JS 回调只消费不可变 snapshot；`finalState` 仅供 native 审计与状态查询；保证事件产生时值拷贝冻结且所有事件带 id 与 generation |
| 5 | T41/T42 测试真实性与物理边界违背 | 原 T41 要求 worker 正在执行不可中断同步 API `ClosePseudoConsole` 时 10ms 内响应停止事件，物理上不可能且违背 Windows API 现实；T42 缺少场景覆盖 | T41 严格分解为三大真实场景：A（等待 shell）、B（执行 drain）、C（Worker 正在执行 `ClosePseudoConsole` 且长时间不返回）；明确场景 C 中 Worker 零 TSFN 引用，Node 环境毫秒级完成 teardown，native worker 继续存活并受控释放；T42 完整覆盖 Worker 等待任务、执行关闭、投递事件、`napi_queue_full` 退避、`napi_closing` 与环境销毁后终态保持 6 大场景 |

本轮未改变的硬约束：Plan B+ 首选；Plan B 需 C0 实测与人工批准；Plan A 不自动启用；每终端独立 Job；Job 模式禁止 PID 终止；保留 P3-B；最小 fork/vendor node-pty；失败关闭；C0 完成前不进入 C1。

---

## 1. 现状架构审计

### 1.1 真实进程树

```text
Electron main (electron.exe)
  │  持有：backend 的 ChildProcess 句柄、AUTH_TOKEN、窗口/浏览器/凭据服务
  │  不持有：任何 PTY / ConPTY / shell 句柄
  └─ backend (electron.exe, ELECTRON_RUN_AS_NODE=1, 运行 server.cjs 或 server.js)
       │  持有：node-pty 原生模块、pty_baton、HPCON、shell 进程句柄
       ├─ conhost.exe / OpenConsole.exe
       │    由 CreatePseudoConsole 创建；不是 shell 的子进程；
       │    当前不在任何 per-terminal Job 中；P3-C 后是否计入 Job 待 C0
       └─ PowerShell / cmd.exe（shell）
            ├─ 子进程（用户在终端里启动）
            └─ 孙进程
```

`[源码]`：

- shell 由 node-pty 的 `PtyConnect` 调用 `CreateProcessW` 创建（`node_modules/node-pty/src/win/conpty.cc:413`）。
- Electron main 只持有 backend 的 `ChildProcess` 句柄（`electron/main.cjs:188-253`），不持有 shell/HPCON。
- conhost 由 `CreatePseudoConsole` 创建（`conpty.cc:292` 调用 `CreateNamedPipesAndPseudoConsole`），不是 shell 的子进程；它的生命周期由 `HPCON` 控制，不由 shell 进程树控制 `[文档]`。

### 1.2 创建流程

```text
server/terminal-process.js:51  loadNodePty()
server/terminal-process.js:188 defaultSpawnPty()
  └─ win32: options.useConpty = true  (line 200)
       └─ nodePty.spawn(file, args, options)  (line 201)
            └─ WindowsTerminal 构造函数  (windowsTerminal.ts:34-51)
                 └─ new WindowsPtyAgent(...)  (windowsPtyAgent.ts:49-122)
                      ├─ conptyNative.startProcess(...)  (line 84)
                      │    └─ PtyStartProcess()  (conpty.cc:245)
                      │         ├─ CreateNamedPipesAndPseudoConsole()  (line 292)
                      │         └─ ptyHandles.emplace_back(pty_baton)  (line 304)
                      └─ conptyNative.connect(...)  (line 119)
                           └─ PtyConnect()  (conpty.cc:325)
                                ├─ InitializeProcThreadAttributeList  (line 393)
                                ├─ UpdateProcThreadAttribute(PSEUDOCONSOLE)  (line 401)
                                ├─ CreateProcessW(...)  (line 413)
                                ├─ handle->hShell = piClient.hProcess  (line 442)
                                ├─ CloseHandle(hThread)  (line 445)
                                ├─ CloseHandle(hIn/hOut)  (line 447-448)
                                └─ SetupExitCallback(...)  (line 450)
```

`startProcess` 先建立管道和 `HPCON`，`connect` 才创建 shell。Job 必须在 `connect` 的 `CreateProcessW` 处生效，JS 在 `spawn` 返回后再绑定已经晚了。

### 1.3 句柄现状

| 对象 | 创建位置 | 当前存放 | 当前关闭点 | 问题 |
| --- | --- | --- | --- | --- |
| PTY PID | `CreateProcessW` | `PtyConnect` 返回 `{pid}`；JS `_innerPid` | 进程存活期 | PID 可复用；JS 只有数字 |
| `hShell` | `CreateProcessW` | `pty_baton.hShell`（`conpty.cc:442`） | 退出线程 `CloseHandle`（`conpty.cc:105`） | 退出线程先删 baton，`PtyKill` 可能拿不到 |
| `hThread` | `CreateProcessW` | `PtyConnect` 局部 | `conpty.cc:445` 立即关闭 | Plan B+ 必须保留到 `ResumeThread` 之后 |
| `hpc` | `CreatePseudoConsole` | `pty_baton.hpc`（`conpty.cc:45`） | `PtyKill` 里关闭（`conpty.cc:554-560`） | **自然退出不关，泄漏** |
| `hIn/hOut` | `CreateNamedPipesAndPseudoConsole` | `pty_baton` | `connect` 成功后关闭 | 失败路径没有统一清理 |
| `pty_baton` | `PtyStartProcess` | 全局 `ptyHandles`（`conpty.cc:52`） | 退出线程 `remove_pty_baton`（`conpty.cc:106`） | 裸指针 + 提前删除，存在 use-after-free |

### 1.4 自然退出释放了什么

`SetupExitCallback` 的退出线程 `[源码]`（`conpty.cc:80-126`）：

1. `WaitForSingleObject(baton->hShell, INFINITE)`（`line 101`）
2. `GetExitCodeProcess`（`line 103`）
3. `CloseHandle(baton->hShell)`（`line 105`）
4. `remove_pty_baton(baton->id)`（`line 106`）
5. `BlockingCall` 通知 JS（`line 108`）

**它不关闭 `hpc`，也不处理 shell 的后代。** 之后 JS 调 `pty.kill()` 时 `get_pty_baton` 已找不到 baton，`PtyKill` 直接返回，`HPCON` 永久泄漏。JS 的 `_cleanUpProcess` 只销毁 socket，不关 `HPCON`（`windowsPtyAgent.ts:232-249`）。

### 1.5 P3-B 身份门控覆盖范围

`[源码]`：

- spawn 时 `defaultSpawnPty` 异步捕获 `(pid, creation time, image path)`（`server/terminal-process.js:201-205`）。
- 终止时 `defaultKillPty` 在 win32 上走 `createWindowsKillGate().kill`（`lines 209-211`），只有 `match` 才 `taskkill /pid <shell> /T /F`。
- 四态 `found/gone/missing/unknown`（`lib/process-identity.cjs:76-110`）；FILETIME 用十进制字符串（`lines 14-17`）。
- `KILL_STOP_RESULTS = {gone, mismatch, unknown}` 立即 `killUnconfirmed`，不伪造退出（`server/terminal.js:84,354-360`）。

**边界：**

- 只保护 shell 的 PID，不保护后代。
- 查询与 taskkill 仍是两步，PID 在两步之间复用仍可能误杀。
- 它不能阻止 shell 在 spawn 后立刻启动子进程。
- 它不能给 shell 绑定 Job，也没有进程句柄。

### 1.6 其他终止路径

| 路径 | 现状 | P3-C 关系 |
| --- | --- | --- |
| `server/agents/cli.js:155-172` | Windows `taskkill /pid <child.pid> /T /F`；POSIX 进程组 | Agent 子进程；P3-C 不修 |
| `lib/git.js:127-130` | 同上，裸 PID | Git 子进程；P3-C 不修 |
| `electron/main.cjs:425-477` | 有身份门控；匹配才 taskkill，之后总是 `server.kill()` | backend 进程；P3-C 保留 |
| `installer/pi-gui.nsi:160,230` | `taskkill /IM "${APP_EXE}" /F /T` | 安装/升级；不在终端生命周期 |
| `scripts/run-test-group.mjs:127` 等 | 测试/验证脚本裸 PID 清理 | 测试基础设施 |
| `server/data-dir.js:27`、`server/provider-config-store.js:273` | `process.kill(pid, 0)` | 只是探活 |

**P3-C 只给终端 shell 及其正常后代提供 Job 生命周期；不声称修好上述路径。**

### 1.7 审计结论

1. 当前没有 Job Object；终端树完全靠 PID + `taskkill /T`。
2. shell 创建点在 node-pty 原生层；JS `spawn` 返回时 shell 可能已经执行 profile/用户代码。
3. 自然退出漏 `HPCON`，且不处理后代的存活。
4. P3-B 是终止时的 PID 身份兜底，不是创建时绑定机制。
5. 正确改造点是 node-pty 的 Windows 原生 `PtyConnect`，不是 `server/terminal.js` 或 `electron/main.cjs`。

---

## 2. node-pty 源码与失败点

### 2.1 JS 构造链

`[源码]`：

- `typings/node-pty.d.ts:96-110` 只有 `useConpty/useConptyDll/conptyInheritCursor`，没有 Job 选项。
- `windowsTerminal.ts:51` 创建 `WindowsPtyAgent`。
- `windowsPtyAgent.ts:84` 调 `startProcess`；`98-121` 建 socket、`connect`。
- `windowsPtyAgent.ts:119-120` 的 `connect` 返回 `{pid}`；`_innerPid` 只是数字。
- `windowsPtyAgent.ts:141-183` 的 `kill()`：系统 ConPTY 先 `_getConsoleProcessList()` 再逐个 `process.kill(pid)`；`185-196` 的 5 秒超时退化为裸 `_innerPid`。
- `windowsTerminal.ts:164-185` 的 `kill()/destroy()` 走 `_deferNoArgs`；`_isReady=false`（还没收到第一段数据）时 kill 被排队，**不会执行**。
- `terminal.ts:190-196` 的 `_close()` 把 socket `readable=false`；如果在 drain 之前调用，会破坏 `ClosePseudoConsole` 需要的输出读取。

### 2.2 原生创建/连接/终止

`[源码]`（`conpty.cc`）：

- `pty_baton`（`41-50`）：`id/hIn/hOut/hpc/hShell`；没有 Job、没有锁。
- `ptyHandles`（`52`）：`vector<unique_ptr<pty_baton>>`，无 mutex；`get_pty_baton` 返回裸指针。
- `SetupExitCallback`（`80-126`）：退出线程在 `BlockingCall` 前 `remove_pty_baton`，不关 `hpc`。
- `PtyStartProcess`（`245-323`）：`CreateNamedPipesAndPseudoConsole` 成功后放入 `ptyHandles`；后续 `inNameStr/outNameStr` 为空时抛错（`307/312`），没有清理 `hpc`/管道/baton。
- `PtyConnect`（`325-456`）：
  - `InitializeProcThreadAttributeList(NULL,1,...)`（`393`）、`new BYTE[size]`（`394`）、`UpdateProcThreadAttribute(PSEUDOCONSOLE)`（`401`）；
  - `CreateProcessW(..., false, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, ...)`（`413-424`）；
  - 失败抛错（`426`），没有 `DeleteProcThreadAttributeList`、没有 `delete[]`、没有关 hpc/管道；
  - 成功后 `hShell = hProcess`（`442`），立即关 `hThread`（`445`），关 `hIn/hOut`（`447-448`），`SetupExitCallback`（`450`）。
- `PtyKill`（`534-568`）：总是 `ClosePseudoConsole(hpc)`；只有 `useConptyDll` 才 `TerminateProcess(hShell)`；系统 ConPTY 靠 JS 的 `process.kill` 列表。
- 没有 Job API。

### 2.3 对 P3-C 的硬约束

1. **不能在 JS 层补绑定**：JS 没有进程句柄；`spawn` 返回时 shell 已运行。
2. **不能依赖 `pty.kill()` 清理未受保护的 shell**：它可能走 `_getConsoleProcessList`/`process.kill`，正是要禁止的路径。
3. **必须修原生退出/失败清理**：否则 Job 只会叠加在已有的 hpc/baton 泄漏上。
4. **必须修 baton 生命周期**：退出线程提前删除 baton，`PtyKill`/`dispose` 可能 use-after-free。
5. **必须修 `_isReady` 延迟**：静默 shell 的 Job kill 不能被 JS 排队。

---

## 3. 设计不变量（新增）

所有后续章节必须满足以下不变量；任何实现偏离都视为设计缺陷。

| 编号 | 不变量 | 说明 |
| --- | --- | --- |
| I1 | `jobMode` 不可变 | 创建时确定；`hJob` 关闭、终止失败、`dispose` 重入都不能改变 |
| I2 | Job 模式禁止 PID 终止 | 不得调用 `process.kill(pid)`、`taskkill`、`_getConsoleProcessList()` |
| I3 | capability 先于 shell | 旧 `.node`/打包错配必须在 `CreateProcessW` 之前拒绝 |
| I4 | 原生负责创建失败清理 | Job 创建/配置/绑定/验证/resume 失败全部由原生 RAII 清理 |
| I5 | 五个事实分开 | `shellExited`、`jobTerminating`、`jobDrained`、`ptyDisposed`、`sessionExited` 不互相冒充；`drainedVerified` 只由 drain 条件置位 |
| I6 | 清理线程有界 | 不允许每次 dispose 创建无限 detached 线程；队列/worker 固定上限 |
| I7 | HANDLE 唯一所有者 | 每个 HANDLE 在任一时刻只有一个所有者；转移有明确规则；关闭必须检查返回值 |
| I8 | 失败关闭 | Job 不可用就拒绝启动终端；不静默降级为无 Job shell；无法确认的清理保持 unconfirmed |
| I9 | P3-B 保留 | 身份门控不因 Job 引入而删除；legacy/非 Job 路径仍用它 |
| I10 | Job 不是安全沙箱 | 只保证仍与 Job 关联的进程；WMI `Win32_Process.Create` 等文档化逃逸不在保证内 |
| I11 | 关闭失败不升级 | `CloseHandle` 失败只进入 `CloseUnconfirmed`；不重试、不重复关闭、不置 `hJobClosed=true` |
| I12 | Connecting 单调 | `Created → Connecting → Connected/Failed` 单调；`dispose`/`kill` 在 Connecting 期间只置中止请求，不提前释放 `HPCON` |
| I13 | 事件先快照后删除 | baton 删除前把终态写入有界缓存；晚到的 JS 查询仍能读到 `drained/unconfirmed`，`gone` 不等于 `drained` |

### 3.1 事实与派生状态（会话结束 vs 完全清理分离）

| 事实/状态 | 准确定义 | 谁产生 | 不等于与禁止推断 |
| --- | --- | --- | --- |
| `shellExited` | 退出线程对 `hShell` 的 `WaitForSingleObject` 返回 `WAIT_OBJECT_0`；`WAIT_TIMEOUT`/`WAIT_FAILED` 不置位 | 退出线程 | 后代已退出、PTY 已释放、HANDLE 已完全关闭 |
| `jobTerminating` | **仅** `TerminateJobObject` 返回非零（终止请求已接受）；`KILL_ON_JOB_CLOSE` 兜底关闭句柄不算 terminating，只算 `fallbackUsed` + `ClosingUnverified`/`Unconfirmed` | `PtyKill`/`abortJob`/`dispose`/退出线程 | 进程树已清空；`KILL_ON_JOB_CLOSE` 已生效；不等于已退出 |
| `jobDrained` / `drainedVerified` | `hJob` 仍有效时，连续两次成功查询 `JobObjectBasicAccountingInformation` 且 `ActiveProcesses==0`；查询之间至少间隔 50ms。查询前已尝试关闭 `hShell`，避免本进程持有的进程引用压住 accounting。**没有 shell 的空 Job 也必须满足这两次查询，不能仅凭“未创建 shell”置位** | 退出线程的 drain 轮询；空树路径同样执行 `QueryZeroTwice` | 所有 WMI/服务/UAC/breakaway 进程已消失；conhost 已退出；不等于底层 HANDLE 已成功关闭 |
| `ptyDisposed` | 清理 worker 中 `ClosePseudoConsole`/`ConptyClosePseudoConsole` **调用已返回**。该 API 返回 `void`，没有成功码 | 清理 worker | conhost 已退出；Windows 11 24H2+ 的 `ClosePseudoConsole` 可能立即返回；不代表 Job 进程已清空 |
| `sessionExited` | `shellExited && ptyDisposed && treeState∈{drained,unconfirmed}`；**仅表示用户逻辑交互会话结束**（Shell 退出、输出断开、PTY 释放） | `server/terminal.js` 的 `maybeFinishSession` | **绝对不等于底层资源完全清理成功！** 即使 `sessionExited=true`，若存在句柄关闭未确认或 `treeState=unconfirmed`，资源清理可能仍有异常 |
| `treeState` | `active/terminating/draining/drained/unconfirmed/gone`；`gone` 只表示 registry 无 baton 且无 cache 快照 | native `status`/事件快照 + JS | `sessionExited` 或 `killState=exited`；禁止把 `gone` 当 `drained` |

#### 独立的资源清理结果（`cleanupState`）

为彻底消除“会话已退出就等于全部清理干净”的假象，系统引入与 `sessionExited` 正交的独立资源清理状态 `cleanupState`：

1. **`cleanupPending`（清理中）**：
   - 判定条件：`!ptyDisposed || hpcEnqueued || connectInProgress`。
   - 含义：清理 worker 尚未完成 `ClosePseudoConsole` 调用，或清理任务仍在队列中排队。
   - 约束：终端会话记录必须保留在 `cleanupPending` 集合中，绝不允许提前删除。
2. **`cleanupUnconfirmed`（结束但清理未确认）**：
   - 判定条件：`sessionExited && (treeState === 'unconfirmed' || treeState === 'gone' || !drainedVerified)`。
   - 含义：逻辑会话虽已结束，但进程树 accounting 无法通过两次 0 计数证明，或因超时/查询失败进入 unconfirmed。
   - 约束：UI 必须以黄色或警示色标注“已结束（资源清理未确认）”，禁止显示全绿成功态。
3. **`cleanedWithWarning`（结束且有资源警告）**：
   - 判定条件：`sessionExited && drainedVerified && ptyDisposed && (hJobCloseUnconfirmed || shellCloseUnconfirmed || resourceCloseUnconfirmed)`。
   - 含义：进程树 accounting 已确认清空且 PTY 已释放，但在句柄受检关闭时至少有一个 HANDLE 返回了失败（`CloseUnconfirmed`）。
   - 约束：虽然操作系统会在宿主进程退出时兜底回收该句柄，但 UI 和日志必须明确标明“已结束（句柄关闭警告）”，向运维暴露句柄泄漏风险。
4. **`fullyCleaned`（完全清理完成）**：
   - 判定条件：`sessionExited && drainedVerified && ptyDisposed && jobHandleClosed && !hJobCloseUnconfirmed && !shellCloseUnconfirmed && !resourceCloseUnconfirmed`。
   - 含义：进程树 accounting 验证清空，PTY 关闭调用已返回，且所有 Native 句柄均经由 `closeHandleChecked` 成功关闭。
   - 约束：UI 方可显示绿色对勾“完全清理完成”。

---

## 4. Job 绑定方案与决策

### 4.1 API 事实

| 事实 | 依据 |
| --- | --- |
| `CreateJobObjectW(nullptr,nullptr)` 创建匿名 Job；默认句柄不可继承 | `[文档]`；P31 `runner-win.ps1:61` `[源码]` |
| `SetInformationJobObject(JobObjectExtendedLimitInformation=9)` 设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000` | `[文档]`；SDK `WinNT.h`；P31 `runner-win.ps1:62-63` `[源码]` |
| `AssignProcessToJobObject` 需要进程句柄 `PROCESS_SET_QUOTA|PROCESS_TERMINATE`、Job 句柄 `JOB_OBJECT_ASSIGN_PROCESS`；嵌套 Job 受 Windows 8+ 规则约束 | `[文档]` |
| `PROC_THREAD_ATTRIBUTE_JOB_LIST`（`ProcThreadAttributeJobList=13`）值是 Job 句柄数组；创建时按顺序加入；`lpValue` 有效到 `DeleteProcThreadAttributeList`；Windows 10/Server 2016+ | `[文档]`；SDK `WinBase.h` |
| `PSEUDOCONSOLE` 与 `JOB_LIST` 可以放在同一属性列表（count=2）；**组合无文档保证** | `[文档]` 各自条目；组合 `[C0]` |
| `CreateProcessW` 的 `EXTENDED_STARTUPINFO_PRESENT` 启用 `STARTUPINFOEX`；`CREATE_SUSPENDED` 挂起主线程；`bInheritHandles=false` | `[文档]`；`conpty.cc:413-424` `[源码]` |
| `IsProcessInJob`：`JobHandle=NULL` 测任意 Job；进程句柄需 `PROCESS_QUERY_INFORMATION`/`LIMITED`，Job 句柄需 `JOB_OBJECT_QUERY` | `[文档]` |
| `QueryInformationJobObject(JobObjectBasicAccountingInformation=1)` 返回 `ActiveProcesses/TotalProcesses/TotalTerminatedProcesses`；`ActiveProcesses` 是“当前仍与 Job 关联的进程数”，进程退出且所有引用释放后才递减 | `[文档]`；P31 `runner-win.ps1:85-90` `[源码]` |
| 嵌套 Job 的 accounting 在父 Job 聚合子 Job；`ActiveProcesses` 的结构页本身没有单列嵌套说明，需以 Nested Jobs / Job Objects 的聚合条目为依据，并在 C0 实测目标 Windows | `[文档]` + `[C0]` |
| `TerminateJobObject` 终止当前 Job 及全部子 Job；返回非零表示调用成功，但文档没有明确保证返回时所有进程已退出；其语义“如同对每个进程调用 `TerminateProcess`”，而 `TerminateProcess` 明确是异步的，必须等待句柄才能确认退出 | `[文档]`；`TerminateProcess` 文档 |
| `KILL_ON_JOB_CLOSE` 在**最后一个** Job 句柄关闭时终止 Job 中进程；有子 Job 时子 Job 也终止 | `[文档]` |
| `ClosePseudoConsole` 返回 `void`，没有成功/失败返回值；发 `CTRL_CLOSE_EVENT`；Windows 11 24H2 返回后立即返回，之前版本可能等待客户端断开或输出 pipe 被 drain，甚至无限等待；不要在读取输出的同一线程调用 | `[文档]`；SDK `consoleapi.h:341-346` `[源码]` |
| `CloseHandle` 失败时返回 0，可用 `GetLastError` 取错误；重复关闭/无效句柄在调试器下会抛异常；文档没有定义失败后句柄是否仍有效，因此失败后不得重试或当作已关闭 | `[文档]` |
| `TerminateProcess` 是异步的；成功只表示终止已发起，必须用 `WaitForSingleObject` 确认；不会终止子进程 | `[文档]` |
| `WaitForSingleObject` 的 `WAIT_TIMEOUT`/`WAIT_FAILED`/`WAIT_ABANDONED` 都不表示对象已退出；进程句柄只能用 `WAIT_OBJECT_0` 证明退出 | `[文档]` |
| `Win32_Process.Create` 创建的子进程**不随**父进程加入 Job；这是文档化逃逸，不属于 Drained 保证 | `[文档]`（Job Objects） |

### 4.2 Plan A：`CREATE_SUSPENDED` + `AssignProcessToJobObject` + 验证 + `ResumeThread`

```text
CreateJobObjectW -> SetInformationJobObject(KILL_ON_JOB_CLOSE)
  -> CreateProcessW(CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, PSEUDOCONSOLE)
  -> AssignProcessToJobObject(hJob, hProcess)
  -> IsProcessInJob(hProcess, hJob)
  -> ResumeThread(hThread)
```

- 优点：resume 前完成绑定；resume 前可验证；仓库 P31 在普通进程上验证过这个模式 `[源码]`。
- 缺点：`CreateProcessW` 返回后、`Assign` 前 backend 崩溃，挂起进程不在 Job 中，`KILL_ON_JOB_CLOSE` 不会杀它 → 挂起孤儿；受嵌套 Job 访问检查；`Assign` 与 ConPTY 的组合 `[C0]`。
- **政策：不自动启用。** A 不属于 B+/B 的回退链；只有用户另行明确要求时才允许作为独立实验分支，且需单独批准挂起孤儿风险。B+ 和 B 都不可用时应停止 P3-C，而不是转向 A。

### 4.3 Plan B：`PROC_THREAD_ATTRIBUTE_JOB_LIST` + `STARTUPINFOEX`

```text
CreateJobObjectW -> SetInformationJobObject(KILL_ON_JOB_CLOSE)
  -> InitializeProcThreadAttributeList(count=2)
  -> UpdateProcThreadAttribute(PSEUDOCONSOLE)
  -> UpdateProcThreadAttribute(JOB_LIST, {hJob})
  -> CreateProcessW(EXTENDED_STARTUPINFO_PRESENT, STARTUPINFOEX)
```

- 优点：创建时原子绑定；无 Assign 窗口；不依赖 `AssignProcessToJobObject`。
- 缺点：进程创建后即运行，`IsProcessInJob` 是事后验证；与 `PSEUDOCONSOLE` 组合 `[C0]`。
- **政策：兼容回退。** 只有 B+ 失败、C0 证明 B 可用、且人工批准接受“验证发生在创建后”时才允许；不能自动切换。

### 4.4 Plan B+：B + `CREATE_SUSPENDED` + resume 前验证

```text
CreateJobObjectW -> SetInformationJobObject(KILL_ON_JOB_CLOSE)
  -> QueryInformationJobObject 验证 LimitFlags
  -> InitializeProcThreadAttributeList(count=2)
  -> UpdateProcThreadAttribute(PSEUDOCONSOLE)
  -> UpdateProcThreadAttribute(JOB_LIST, {hJob})
  -> CreateProcessW(EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT |
                    CREATE_SUSPENDED, STARTUPINFOEX)
  -> IsProcessInJob(hProcess, hJob) == TRUE ?
  -> QueryInformationJobObject(ActiveProcesses) >= 1 ?
  -> ResumeThread(hThread)
```

- 优点：创建时原子绑定 + resume 前验证；backend 在 resume 前崩溃时 Job 句柄关闭，按 Job 语义应杀掉挂起进程 `[C0]`。
- 缺点：三属性组合无文档保证；`ActiveProcesses` 对挂起进程及“本进程仍持有 hShell 引用”的计数 `[C0]`；`CREATE_SUSPENDED` 与 `PSEUDOCONSOLE` 的组合 `[C0]`。
- **C0 必须确认的计数顺序：** 创建挂起进程后、Resume 前查询 `ActiveProcesses>=1`；shell 退出后，先按受检方式关闭 `hShell`，再观察 accounting 是否能降到 0。若本进程持有的 `hShell` 引用会让 `ActiveProcesses` 在 shell 退出后仍大于 0，设计必须按“先关闭再 drain”执行，不能把引用计数当成后代存活。
- **政策：首选。** C0 必须验证；失败则按 4.5 处理。

### 4.5 决策矩阵（修订）

| 顺序 | 方案 | 启用条件 | 验证强度 | 失败时 |
| --- | --- | --- | --- | --- |
| 1 | B+ | C0 通过 | 创建时绑定 + resume 前验证 | 进入 2 |
| 2 | B | B+ 不可用；C0 通过；**人工批准** | 创建时绑定；验证在创建后 | 停止 P3-C |
| — | A | **不作为交付回退**；仅在用户明确要求时单独 spike + 单独批准 | resume 前验证；有挂起孤儿窗口 | 停止 P3-C |
| — | post-spawn Assign | 永不 | 无法保证用户代码前绑定 | 禁止 |

**如果 B+ 和 B 都不可用，停止 P3-C，不为了交付强行降级到 A。** A 是独立研究选项，不在默认决策链里；只有用户明确要求时才评估，且不能把 A 的结果当成 B+/B 的替代品。

### 4.6 P31 先例

`extensions/pi-gui-process/runner-win.ps1:61-97` 已经实现 Plan A 模式 `[源码]`：`CreateJobObject` + `KILL_ON_JOB_CLOSE` + `CREATE_SUSPENDED` + `AssignProcessToJobObject` + `ResumeThread` + `TerminateJobObject` + `QueryInformationJobObject` 轮询；失败时 `TerminateProcess` + 关 Job。

它证明：

- 仓库接受 Job Object + `KILL_ON_JOB_CLOSE` + accounting 的设计；
- Plan A 在普通子进程上可行。

它不能证明：

- ConPTY + `PSEUDOCONSOLE` 的组合可行；
- 可以不重写 node-pty 就复用它。这个 runner 自己创建进程、自己持有管道；`HPCON` 是创建进程的句柄，跨进程交给 helper 需要重新实现 ConPTY。

---

## 5. 推荐架构

### 5.1 进程与 HANDLE 拓扑

```text
┌──────────────────────────────────────────────────────────────────┐
│ Electron main                                                    │
│  - backend ChildProcess 句柄（仅此）                              │
│  - before-quit -> killServer(): 身份门控 taskkill + server.kill() │
│  - 不持有 terminal HPCON / job / shell handle                     │
└───────────────────────────────┬──────────────────────────────────┘
                                │ stdio + IPC
┌───────────────────────────────▼──────────────────────────────────┐
│ backend (Electron as Node)                                        │
│  server/terminal.js: session ledger / 五个事实 / retries          │
│  server/terminal-process.js: capability / spawn / kill routing    │
│  node-pty (patched): WindowsPtyAgent / WindowsTerminal            │
│  native conpty.node:                                              │
│    pty_baton { jobMode(const), hJob, hShell, hpc, ... }           │
│    PtyCleanupManager { 固定 workers + 有界队列 }                   │
│                                                                   │
│  每个终端一个匿名 Job：                                            │
│    T1 job ── shell1 ── child1 ── grandchild1                      │
│    T2 job ── shell2 ── child2                                     │
│  两个 Job 互不共享；一个 Job 的句柄只在 backend 的 baton 里        │
└───────────────────────────────┬──────────────────────────────────┘
                                │ ConPTY (HPCON + named pipes)
                     conhost.exe / OpenConsole.exe
                     （是否计入 Job 由 C0 确认）
```

### 5.2 组件改造

| 组件 | 改造 | 本轮 |
| --- | --- | --- |
| `src/win/conpty.cc` | Job 创建/绑定/验证/终止/drain/清理；baton 生命周期；清理管理器 | 设计 |
| `src/windowsPtyAgent.ts` | `useJobObject` 透传；Job 模式 kill；dispose；构造失败清理 | 设计 |
| `src/windowsTerminal.ts` | Job 模式 kill 不延迟；不提前 `_close`；`onJobState` | 设计 |
| `src/interfaces.ts` / `typings` | 选项、native 签名、状态/能力 | 设计 |
| `src/index.ts` | 从实际 native 导出 `supportsJobObject` | 设计 |
| `server/terminal-process.js` | capability 预检；Job 路由；失败不降级 | 设计 |
| `server/terminal.js` | 五事实状态机；`cleanupPending`；超时 | 设计 |
| `server.js` | `process.on('disconnect')` | 设计 |
| `electron/main.cjs` | 原则上不改；`killServer` 已足够 | 设计 |
| `scripts/node-pty-package.mjs` / `build-*.mjs` | fork/vendor staging + hash | 设计 |
| `package.json` | fork/vendor 依赖（实施阶段） | 本轮禁止 |

### 5.3 设计原则

1. 每终端一个 Job，不共享；不用 workspace/app 级 Job。
2. Job 句柄唯一所有者是 backend 的 native `pty_baton`；Electron 不复制、不继承。
3. `jobMode` 不可变；`hJob` 只是资源，不代表模式。
4. 创建时绑定；B+ 首选；B 仅批准后回退；A 不自动。
5. `TerminateJobObject` 是正常终止；`KILL_ON_JOB_CLOSE` 是失败兜底，不是成功确认。
6. Shell 退出不等于进程树清空；`jobDrained` 必须单独验证。
7. 清理线程有界；句柄不能丢。
8. 失败关闭；旧二进制/错配在 shell 前拒绝。
9. P3-B 保留。
10. Job 是生命周期边界，不是安全沙箱。

---

## 6. 原生模块设计

### 6.1 `pty_baton`、不可变事件快照与共享终态

```cpp
enum class JobMode { None, Required };
enum class JobState {
  None,                 // legacy; no job
  Active,               // hJob valid; shell bound; no termination requested
  Connecting,           // PtyConnect owns creation; shell not yet committed
  Terminating,          // TerminateJobObject accepted; not proof of exit
  Draining,             // shell exited/termination requested; polling accounting
  Drained,              // two consecutive ActiveProcesses==0 while hJob valid
  ClosingUnverified,    // termination fallback used; no accounting proof
  Closed,               // CloseHandle(hJob) succeeded
  Unconfirmed           // cannot verify; terminal must surface unconfirmed
};
enum class ShellState { None, Creating, Running, Exited, HandleCloseUnconfirmed };
enum class ConnectState { None, Connecting, Connected, Failed };
enum class ConnectPhase {
  None,
  Starting,             // 管道/HPCON/Job 已创建，准备 CreateProcessW
  Validating,           // CreateProcessW 已完成，正在验证 IsProcessInJob 与 accounting
  Resuming,             // 挂起验证通过，即将调用 ResumeThread
  Connected,            // ResumeThread 成功且所有权已提交给 baton
  Aborting,             // 收到中止请求，正在执行 StopCreatedShellBounded
  Failed                // 启动或绑定失败，资源已清理或隔离
};
enum class HandleState { Empty, Owned, CloseAttempted, Closed, CloseUnconfirmed };

// Native result shared by PtyKill / abortJob. No `killed` or `terminated` field:
// terminateAccepted means "TerminateJobObject returned TRUE", never "the tree exited".
// Closing hJob to trigger KILL_ON_JOB_CLOSE is reported only by fallbackUsed.
struct JobControlResult {
  bool requested = false;
  bool terminateAccepted = false;   // only TerminateJobObject()==TRUE; not proof of exit
  bool fallbackUsed = false;
  bool drainedVerified = false;
  bool jobHandleClosed = false;
  bool closeUnconfirmed = false;
  const char* treeState = "active"; // active|terminating|draining|drained|unconfirmed|gone|not_job_mode
  const char* error = nullptr;
};

enum class PtyEventType { Exit, JobState, PtyDisposed };

// 不可变事件快照：事件产生瞬间由 native 线程值拷贝冻结，供 JS 事件回调安全消费
struct PtyEventSnapshot {
  int id = 0;
  uint64_t generation = 0;
  PtyEventType type = PtyEventType::JobState; // 事件类型标识
  int exitCode = 0;
  bool exitKnown = false;
  bool shellExited = false;
  bool ptyDisposed = false;
  bool drainedVerified = false;
  bool terminateAccepted = false;
  bool fallbackUsed = false;
  bool jobHandleClosed = false;
  bool jobCloseUnconfirmed = false;
  bool shellCloseUnconfirmed = false;
  bool resourceCloseUnconfirmed = false;
  bool hpcCloseReturned = false;
  int activeProcesses = -1;         // 事件发生时的采样值；-1 = 未知
  const char* treeState = "active"; // 事件发生时的树状态
  DWORD lastError = 0;
  std::chrono::steady_clock::time_point timestamp{};
};

// 跨线程受保护的共享终态：由独立的 std::mutex 同步保护，持续更新并存入缓存
struct PtyFinalState {
  int id = 0;
  uint64_t generation = 0;
  std::mutex mu;
  bool shellExited = false;
  bool ptyDisposed = false;
  bool drainedVerified = false;
  bool terminateAccepted = false;
  bool fallbackUsed = false;
  bool jobHandleClosed = false;
  bool jobCloseUnconfirmed = false;
  bool shellCloseUnconfirmed = false;
  bool resourceCloseUnconfirmed = false; // hThread/hIn/hOut; diagnostics only
  bool hpcCloseReturned = false;
  int activeProcesses = -1;        // last observed; -1 = unknown
  JobState jobState = JobState::None;
  DWORD lastError = 0;
  std::chrono::steady_clock::time_point removedAt{};
};

// 原生向 JS 投递的统一事件包装：明确分离不可变快照与共享终态
struct PtyEvent {
  PtyEventType type = PtyEventType::JobState; // 事件顶层类型
  PtyEventSnapshot snapshot;                  // 不可变历史快照（携带 id 与 generation）
  std::shared_ptr<PtyFinalState> finalState;  // 共享终态对象（供必要时 native 状态查询与审计）
};

class PtyEventChannel; // 前置声明，详见 6.10.1

struct pty_baton {
  int id;
  uint64_t generation;          // id + generation for cleanup removal
  const JobMode jobMode;        // immutable; constructor only
  HANDLE hIn = nullptr;
  HANDLE hOut = nullptr;
  HPCON hpc = nullptr;
  HANDLE hShell = nullptr;
  HANDLE hJob = nullptr;
  JobState jobState = JobState::None;
  ShellState shellState = ShellState::None;
  ConnectState connectState = ConnectState::None;
  std::atomic<ConnectPhase> connectPhase{ConnectPhase::None};
  bool connectInProgress = false;
  std::atomic<bool> abortRequested{false};    // 原子标志，外部可无锁置位，线性化检查点详见 6.4
  std::atomic<bool> disposeRequested{false};  // 原子标志
  bool hpcEnqueued = false;
  bool hpcCloseIssued = false;
  bool hpcCloseReturned = false;
  bool cleanupReserved = false;  // one cleanup slot held for this PTY
  bool startupQuarantineOwned = false; // {hJob,hProcess} handed to startup quarantine
  bool startupQuarantinePending = false; // quarantine full; baton retains handles, retry later
  uint64_t startupQuarantineToken = 0;
  bool disposed = false;
  bool hJobClosed = false;              // only CloseHandle(hJob)==TRUE
  bool hJobCloseUnconfirmed = false;    // failed close; handle abandoned, never retried
  bool hShellClosed = false;
  bool hShellCloseUnconfirmed = false;
  HANDLE hThread = nullptr;             // retained only if close is unconfirmed
  bool hThreadClosed = false;
  bool hThreadCloseUnconfirmed = false;
  bool hInClosed = false;
  bool hInCloseUnconfirmed = false;
  bool hOutClosed = false;
  bool hOutCloseUnconfirmed = false;
  bool terminateAccepted = false;
  bool fallbackUsed = false;
  bool drainedVerified = false; // only true after two zero accounting samples
  bool eventDeliveryPending = false;
  bool finalSnapshotPublished = false;
  int exitCode = 0;
  DWORD lastError = 0;
  std::mutex mutex;
  std::shared_ptr<PtyCloseState> closeState;
  std::shared_ptr<PtyFinalState> finalState;
  std::shared_ptr<PtyEventChannel> channel; // 独立的事件通道所有权
};
```

- `jobMode` 是 `const`，从构造到析构不变。
- `hJob` 可以在 drain/fallback 后置空，但 `jobMode` 仍为 `Required`。
- `jobState` 只允许按第 7 节转移；`hJobClosed` 只在 `CloseHandle(hJob)` 成功后为 true，**不代表模式，也不代表进程树已退出**。
- `hJobCloseUnconfirmed`/`hShellCloseUnconfirmed` 为 true 时，HANDLE 值保留用于诊断，但不再使用、不再重试关闭；析构函数必须跳过它，防止双重 `CloseHandle`。进程退出时由 OS 回收。
- `connectState` 单调：`None → Connecting → Connected/Failed`。`abortRequested` 与 `disposeRequested` 是原子请求位，任何并发线程无需等待 baton mutex 即可快速无锁置位，不改变 `jobMode`。
- `ptyHandles` 改为 `std::vector<std::shared_ptr<pty_baton>>` + `std::mutex`；`get_pty_baton` 返回 `shared_ptr`。
- **不可变快照与共享终态彻底分离：**
  - `PtyEventSnapshot` 在事件触发时刻（如退出线程检测到 `WAIT_OBJECT_0`、drain 确认、或 cleanup worker 完成 HPCON 关闭）在锁内进行纯值拷贝。JS 事件监听器（`onExit`/`onJobState`/`onPtyDisposed`）**仅使用 snapshot** 还原事件发生时的历史状态。
  - `PtyFinalState` 是由独立 `std::mutex mu` 保护的共享终态实体，随 baton、缓存、cleanup task 和 channel 生命周期安全共享。`jobStatus()` 主动查询时加锁读取其最新字段。
  - **JS 状态合并单调性原则：** JS 收到晚到的事件快照时，状态转移必须满足 `active < terminating < draining < drained / unconfirmed` 单调递增，绝不允许旧事件快照将已经进入 `draining` 或 `drained` 的会话覆盖回 `active` 或 `terminating`。
  - baton 被删除后，`finalState` 作为 `std::shared_ptr` 仍在终态缓存（`finalStates`）与未完成的任务中安全存活，外部查询仍能安全读取；缓存淘汰后返回 `gone`，JS **严禁将 `gone` 视为 `drained`**。
- **退出线程不立即移除 baton。** shell 退出后 baton 继续保留 `jobState`/`dispose` 状态，直到 `hpc` 清理调用已返回且 Job 已到终态（`Drained`/`Closed`/`Unconfirmed`，或没有 Job）；否则 `PtyKill`/`dispose`/`jobStatus` 会丢失状态或误报 `disposed`。
- `maybeRemoveBaton(id, generation)` 由“最后完成”的那一方调用（清理 worker、退出线程或 `PtyConnect` 失败 guard）：条件是 `disposed && !connectInProgress && !startupQuarantineOwned && !startupQuarantinePending && (shellState==Exited || shell 从未创建) && jobState 终态/无 Job && hpc==nullptr`。`hJob` 因 `CloseHandle` 失败而残留时仍允许删除 baton，但删除前必须发布终态快照；`remove_pty_baton_if_generation` 只删除匹配项，generation 防 id 复用。
- `startupQuarantineOwned=true` 表示 `{hJob,hProcess}` 已交给启动隔离区，baton 不得关闭/查询该 `hJob`，也不得被删除；隔离区完成后通过 token 清除该标志并重新评估 `maybeRemoveBaton`。`PtyConnect` 失败但 `WaitForSingleObject` 未确认时必须先建立这个所有权标记，再允许 JS 的 `dispose` 返回。
- `startupQuarantinePending=true` 表示隔离区已满、尚未接收：baton 保留 `{hJob,hProcess}` 和 hpc，`PtyConnect` 返回 `pty_startup_cleanup_busy`，新终端被拒绝；`dispose` 只处理 hpc，**不得关闭 hJob/hProcess**，由清理管理器的有界重试尝试接收。若直到进程退出仍无法接收，OS 回收句柄，终态保持 `Unconfirmed`；不得静默丢弃或假装已清理。该 baton 在进程退出前不会被删除，这是有界的失败占用，不是正常清理路径。
- **终态缓存：** `publishFinalState` 填充 `PtyFinalState` 的 `shellExited/ptyDisposed/drainedVerified/terminateAccepted/fallbackUsed/jobHandleClosed/jobCloseUnconfirmed/shellCloseUnconfirmed/resourceCloseUnconfirmed/activeProcesses/jobState/lastError`；`maybeRemoveBaton` 在擦除 registry 前把它放进 `finalStates`（`std::deque<std::shared_ptr<PtyFinalState>>`，固定上限 64，TTL 10 分钟）。`PtyStartProcess` 分配新 id 时必须先清除同 id 的旧 cache 条目，防止 id 复用读到上一个 PTY 的终态。worker 的 `markPtyDisposed` 继续更新这个 shared object，所以 baton 已删除后 `status(id)` 仍能读到最终 `drained/unconfirmed`。缓存满时按最旧淘汰；JS 的退出事件本身也携带不可变快照，缓存仅服务于晚到的 `status()` 查询，不承担唯一通知责任。
- 析构函数只做兜底：关闭仍由 baton 持有且状态为 `Owned` 的非阻塞句柄；`hpc` 若仍存在，交由清理管理器后台异步处理；绝不直接在析构中调用可能阻塞的 `ClosePseudoConsole`。`CloseUnconfirmed` 的 HANDLE 绝不再次关闭。

### 6.2 原生状态机

见第 7 节。核心规则：

- `jobMode=Required` 时，`Active` 之前必须已经完成 Job 创建/配置/绑定/验证；否则 baton 不存在。
- `PtyStartProcess` 创建 baton 后即置 `Connecting`（Job 已建、shell 未建）；`PtyConnect` 沿用同一状态，不重复创建。`Connecting → Connected` 只在 shell 成功 Resume 且所有权转移到 baton 后；`Connecting → Failed` 由失败 guard 设置。`PtyKill`/`dispose` 在 Connecting 期间（包括 `PtyConnect` 尚未开始）只能置 `abortRequested` 并请求 `TerminateJobObject`，不能关闭 `hpc` 或 `hShell`。
- `PtyKill` 只能把 `Active` 或 `Connecting` → `Terminating`（`TerminateJobObject` 成功），或在已终止状态返回当前状态；`Connecting` 时同时置 `abortRequested`，由 `PtyConnect` 的 abort 检查负责不 Resume/清理。`Connecting` 期间 `TerminateJobObject` 失败**不关闭 `hJob`**，只置 `abortRequested`。不能把 `jobMode` 改成 `None`。`abortJob` 与 `PtyKill` 共享同一状态转移，幂等。
- 退出线程只能把 `Terminating/Active` → `Draining`，或 `Draining` → `Drained/Unconfirmed`。`Terminating` 本身不是终态；它只表示终止请求已接受。
- 只有连续两次 `ActiveProcesses==0` 的 drain 验证成功，才能置 `drainedVerified=true`，再按受检方式关闭 hJob；关闭成功才进入 `Closed`。
- `TerminateJobObject` 失败时关 hJob 是 `ClosingUnverified`，不是 `Drained`；之后即使 shell 退出、状态进入 `Closed`，`drainedVerified` 仍为 false。
- `CloseHandle(hJob)` 失败时停留在 `Drained` 或 `Unconfirmed`，置 `hJobCloseUnconfirmed=true`，不进入 `Closed`，不重试。
- `dispose` 只影响 `disposeRequested/disposed/hpc`，不改变 `jobMode`；`disposed` 只在清理调用返回后置位，且不等于 `sessionExited`。

### 6.3 `PtyStartProcess`：创建 Job 与 RAII

顺序：

```text
0. 清理资源前置预约：
   if (!cleanupManager.isWorkerHealthy() || !cleanupManager.reserve())
     throw pty_cleanup_busy; // worker 未就绪或队列满，绝不创建 HPCON
1. CreateNamedPipesAndPseudoConsole(...) -> hIn/hOut/hpc
2. if (useJobObject):
     hJob = CreateJobObjectW(nullptr, nullptr)   // 默认不可继承
     info.BasicLimitInformation.LimitFlags = KILL_ON_JOB_CLOSE
     SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, ...)
     QueryInformationJobObject(hJob, ...); 验证 LimitFlags
     if any failure: 释放管道/hJob/预约; HPCON 交清理队列; throw job_*
3. 创建 shared_ptr<pty_baton>，设置 cleanupReserved=true；
   jobMode==Required 时 jobState=Connecting（shell 尚未创建，等待 PtyConnect），否则 None；
   放入 ptyHandles
4. 返回 { pty, conin, conout }
```

- `PtyStartProcess` 入口先检查 native 自身的 `supportsJobObject`；`useJobObject=true` 但 native 不支持时直接抛 `pty_job_unavailable`，不创建 hpc。
- **清理资源前置硬预约：** 在调用 `CreatePseudoConsole` 之前，必须先确认 cleanup worker 线程已成功启动并运行健康，且 `cleanupManager.reserve()` 预约成功。如果 worker 未就绪或预约失败，直接拒绝终端创建，抛出 503 `pty_cleanup_busy`，**绝对不调用 `CreatePseudoConsole`，从源头杜绝无主 HPCON 的产生**。
- 所有资源由 `PtyStartGuard` 持有，成功后才 `release()` 到 baton；guard 失败时，hpc 若交给清理队列则预约随之转移，否则 `cleanupManager.release()`。guard 关闭每个 HANDLE 都调用 `closeHandleChecked`：成功才清空；失败记录 `GetLastError`、置 `CloseUnconfirmed`，不再重试。
- 如果 `inNameStr/outNameStr` 为空，guard 清理 hpc/管道/baton，不留半成品。
- 如果 `ptyHandles.emplace_back` 抛异常，guard 清理。baton 构造时同时创建 `finalState`（`PtyFinalState`），使失败路径也能发布“无 shell/空 Job”的终态。分配 id 后、放入 registry 前必须清除同 id 的旧终态 cache，避免 id 复用把旧 PTY 的 `drained` 快照返回给新 PTY。
- 如果 `useJobObject=false`，`jobMode=None`；`hJob=nullptr`；不创建 Job。
- `useJobObject=true` 时，Job 创建/配置/验证失败必须在返回前抛出；**绝不允许先返回 PTY 再补 Job**。
- **彻底消除主线程同步 `ClosePseudoConsole` 兜底：** `PtyStartProcess` 失败时若已创建 hpc，由于 HPCON 在创建前已持有清理预约，guard 必须统一通过 `cleanupManager.enqueue(...)` 交付后台固定 worker 异步关闭。**绝不允许在 Node 主事件循环线程同步执行可能阻塞或挂起的 `ClosePseudoConsole`！** 若遇极端情况（例如 cleanup manager 正在 shutdown 导致 enqueue 拒绝），已持有的 HPCON 保留为 manager 的 `pendingHpc` 集合，由后台线程稍后重试或随进程退出由 OS 释放，同时记录严重告警日志，严禁用主线程同步调用冒险兜底。
- Job 创建成功但后续步骤失败时，`TerminateJobObject` 只算“请求已提交”；关闭 `hJob` 必须检查返回值。若关闭失败，记录 `job_close_failed` 并保留 `hJobCloseUnconfirmed`，不能把空 Job 说成已销毁；进程退出由 OS 回收。

### 6.4 `PtyConnect`：绑定、验证、resume 与原子取消机制

```cpp
auto handle = get_pty_baton(id);            // shared_ptr
if (!handle) throw invalid_pty_handle;
if (handle->jobMode == JobMode::Required && !handle->hJob)
  throw job_mode_mismatch;                  // 防止调用方绕过/无 Job 创建 shell
if (!handle->hpc) throw invalid_pseudo_console;

// 0. Connecting 门控：只有 Created 能进入；并发 connect 视为编程错误。
{
  std::lock_guard lock(handle->mutex);
  if (handle->connectState != ConnectState::None)
    throw pty_connect_busy;
  if (handle->disposeRequested.load(std::memory_order_relaxed)
      || handle->abortRequested.load(std::memory_order_relaxed)
      || handle->jobState == JobState::Terminating) {
    handle->connectState = ConnectState::Failed;
    handle->connectPhase.store(ConnectPhase::Failed, std::memory_order_release);
    throw pty_aborted;                      // 不创建 shell，不覆盖 Terminating
  }
  handle->connectState = ConnectState::Connecting;
  handle->connectPhase.store(ConnectPhase::Starting, std::memory_order_release);
  handle->connectInProgress = true;
  handle->jobState = handle->jobMode == JobMode::Required
      ? JobState::Connecting : JobState::None;
}

// 1. 先建立事件通道/TSFN（注册环境清理钩子），再创建 shell。TSFN 失败时没有 shell 可清理。
std::shared_ptr<PtyEventChannel> channel;
try {
  channel = PtyEventChannel::Create(env, id, handle->generation, handle);
  handle->channel = channel;
} catch (...) {
  MarkConnectFailedAndCleanup(handle, /*shellCreated=*/false);
  throw pty_event_channel_failed;
}

// 2. 属性列表：PSEUDOCONSOLE + JOB_LIST，RAII 保证所有路径安全删除。
ProcThreadAttrGuard attr(count, &error);
if (!attr.valid()) { MarkConnectFailedAndCleanup(handle, false); throw job_attribute_failed; }
if (!attr.SetPseudoConsole(handle->hpc)) { MarkConnectFailedAndCleanup(handle, false); throw job_attribute_failed; }
HANDLE jobs[1] = { handle->hJob };
if (handle->jobMode == JobMode::Required && !attr.SetJobList(jobs, 1)) {
  MarkConnectFailedAndCleanup(handle, false);
  throw job_attribute_failed;
}

// 3. 创建前最后检查 abort/dispose；外部请求到达后不再创建 shell。
if (handle->abortRequested.load(std::memory_order_acquire)
    || handle->disposeRequested.load(std::memory_order_acquire)) {
  MarkConnectFailedAndCleanup(handle, /*shellCreated=*/false);
  throw pty_aborted;
}

DWORD flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
if (handle->jobMode == JobMode::Required) flags |= CREATE_SUSPENDED;
PROCESS_INFORMATION pi{};
if (!CreateProcessW(..., false, flags, ..., &attr.startupInfo(), &pi)) {
  MarkConnectFailedAndCleanup(handle, /*shellCreated=*/false, GetLastError());
  throw cannot_create_process;
}

// 4. 创建成功后进入 Validating 阶段。
handle->connectPhase.store(ConnectPhase::Validating, std::memory_order_release);

// 4a. 线性化检查点 1（Resume 前）：若外部已发起 abort/dispose，严禁恢复主线程！
if (handle->abortRequested.load(std::memory_order_acquire)
    || handle->disposeRequested.load(std::memory_order_acquire)) {
  handle->connectPhase.store(ConnectPhase::Aborting, std::memory_order_release);
  StopReport stop = StopCreatedShellBounded(handle->hJob, pi.hProcess, kStartupStopTimeoutMs);
  RetainOrQuarantineIfUnconfirmed(handle, pi, stop);
  MarkConnectFailedAndCleanup(handle, /*shellCreated=*/true, ERROR_CANCELLED);
  throw pty_aborted;
}

if (handle->jobMode == JobMode::Required) {
  BOOL inJob = FALSE;
  if (!IsProcessInJob(pi.hProcess, handle->hJob, &inJob) || !inJob) {
    handle->connectPhase.store(ConnectPhase::Aborting, std::memory_order_release);
    StopReport stop = StopCreatedShellBounded(handle->hJob, pi.hProcess, kStartupStopTimeoutMs);
    RetainOrQuarantineIfUnconfirmed(handle, pi, stop);
    MarkConnectFailedAndCleanup(handle, /*shellCreated=*/true, ERROR_INVALID_HANDLE);
    throw job_assign_failed;
  }

  // accounting 有界重试（无锁轮询，避免在持锁状态下 Sleep 阻塞并发取消）
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION acct{};
  bool counted = false;
  for (int i = 0; i < 3; i++) {
    // 轮询间隙检查 abort，允许 T2 在此期间及时叫停
    if (handle->abortRequested.load(std::memory_order_acquire)
        || handle->disposeRequested.load(std::memory_order_acquire)) {
      break;
    }
    if (QueryInformationJobObject(handle->hJob, JobObjectBasicAccountingInformation,
                                  &acct, sizeof(acct), nullptr) && acct.ActiveProcesses >= 1) {
      counted = true;
      break;
    }
    Sleep(50); // 无锁 Sleep，不占用 baton->mutex
  }

  // 4b. 线性化检查点 2（即将 ResumeThread 前的最终断言）：
  if (handle->abortRequested.load(std::memory_order_acquire)
      || handle->disposeRequested.load(std::memory_order_acquire)) {
    handle->connectPhase.store(ConnectPhase::Aborting, std::memory_order_release);
    StopReport stop = StopCreatedShellBounded(handle->hJob, pi.hProcess, kStartupStopTimeoutMs);
    RetainOrQuarantineIfUnconfirmed(handle, pi, stop);
    MarkConnectFailedAndCleanup(handle, /*shellCreated=*/true, ERROR_CANCELLED);
    throw pty_aborted;
  }

  if (!counted) {
    handle->connectPhase.store(ConnectPhase::Aborting, std::memory_order_release);
    StopReport stop = StopCreatedShellBounded(handle->hJob, pi.hProcess, kStartupStopTimeoutMs);
    RetainOrQuarantineIfUnconfirmed(handle, pi, stop);
    MarkConnectFailedAndCleanup(handle, /*shellCreated=*/true, ERROR_INVALID_DATA);
    throw job_accounting_failed;
  }

  handle->connectPhase.store(ConnectPhase::Resuming, std::memory_order_release);
  if (ResumeThread(pi.hThread) == (DWORD)-1) {
    handle->connectPhase.store(ConnectPhase::Aborting, std::memory_order_release);
    StopReport stop = StopCreatedShellBounded(handle->hJob, pi.hProcess, kStartupStopTimeoutMs);
    RetainOrQuarantineIfUnconfirmed(handle, pi, stop);
    MarkConnectFailedAndCleanup(handle, /*shellCreated=*/true, GetLastError());
    throw job_resume_failed;
  }
}

// 5. Resume 成功后所有权提交（持有 baton mutex，保证状态转移与句柄赋值原子完成）：
bool abortDetectedAfterResume = false;
{
  std::lock_guard lock(handle->mutex);
  // 检查 ResumeThread 返回到获取锁之间极短窗口内是否收到了中止请求
  if (handle->abortRequested.load(std::memory_order_acquire)
      || handle->disposeRequested.load(std::memory_order_acquire)
      || handle->terminateAccepted
      || handle->jobState == JobState::Terminating) {
    abortDetectedAfterResume = true;
    handle->connectPhase.store(ConnectPhase::Aborting, std::memory_order_release);
    handle->jobState = JobState::Terminating; // 严禁改回 Active！
    handle->connectState = ConnectState::Failed;
    handle->connectInProgress = false;
  } else {
    handle->hShell = pi.hProcess;
    handle->shellState = ShellState::Running;
    handle->connectState = ConnectState::Connected;
    handle->connectPhase.store(ConnectPhase::Connected, std::memory_order_release);
    handle->connectInProgress = false;
    handle->jobState = handle->jobMode == JobMode::Required
        ? JobState::Active : JobState::None;
  }
}

// 6. 若 Resume 之后才感知到 abort：离开锁临界区后执行清理，避免锁重入死锁
if (abortDetectedAfterResume) {
  StopReport stop = StopCreatedShellBounded(handle->hJob, pi.hProcess, kStartupStopTimeoutMs);
  RetainOrQuarantineIfUnconfirmed(handle, pi, stop);
  MarkConnectFailedAndCleanup(handle, /*shellCreated=*/true, ERROR_CANCELLED);
  throw pty_aborted;
}

attr.Release();
handle->hThread = pi.hThread;
CloseHandleChecked(handle->hThread, "hThread"); // 失败记录 hThreadCloseUnconfirmed，不重试
CloseHandleChecked(handle->hIn, "hIn");
CloseHandleChecked(handle->hOut, "hOut");
StartExitThread(channel, handle);               // 启动独立退出监控线程
return { pid: pi.dwProcessId, jobAssigned: handle->jobMode == JobMode::Required,
         jobState: handle->jobState };
```

#### Connecting 并发与取消机制：五权划分与锁协议（定稿统一）

为了彻底消除第 6.4、6.5 与 6.6 节之间的锁持有与句柄所有权冲突，P3-C 严格确立**五大并发权利与生命周期归属准则**：

1. **`abortRequested` 原子写入权（Atomic Abort Right）：**
   - **归属**：任何需要取消终端创建或终止运行的外部线程（T2：`killJob` / `dispose` / `abortJob`）；
   - **协议**：**完全无锁**！直接原子写入 `handle->abortRequested.store(true, std::memory_order_release)`。耗时 < 100ns，立即可见，绝对不依赖也不等待 `handle->mutex`；
2. **`hJob` 使用权（hJob Access Right）：**
   - **Connecting 期间（`connectInProgress == true`）**：`hJob` 的生命周期与使用权**完全由 T1（连接流程 Guard）独占持有**，用于 `CreateProcessW` 属性列表传递、`IsProcessInJob` 门控与 accounting 验证；
   - **T2 使用权边界**：T2 若调用 `RequestJobTerminationLocked`（持有 `handle->mutex`），在 `JobState::Connecting` 下仅允许并发调用 `TerminateJobObject(h->hJob, 1)`（Windows 内核保证 Job 句柄并发调用 Terminate 安全），**绝对禁止关闭 `hJob`**；
3. **`hJob` 关闭权（hJob Close Right）：**
   - **Connecting 期间**：关闭权**唯一归属于 T1 的 `PtyConnectGuard`**！T2 严禁在 Connecting 期间调用 `CloseHandle(hJob)`，杜绝 T1 在使用中句柄被意外关闭；
   - **Connected 之后（`connectInProgress == false`）**：关闭权转移给退出线程（正常 drain 后在锁内受检关闭）或 `PtyKill` 兜底（当 jobState 为 Active/Terminating 且在 `handle->mutex` 保护下受检关闭）；
4. **`ResumeThread` 调用权（Resume Right）：**
   - **归属**：**唯一归属于 T1**；
   - **行使前提**：T1 必须在 `abortRequested.load(std::memory_order_acquire) == false` 时才具备调用权；
   - **剥夺条件**：一旦 `abortRequested == true`，T1 **被绝对剥夺该权利**，严禁调用 `ResumeThread`，子进程主线程永久处于挂起态，绝不执行用户代码；
5. **状态提交权（State Commit Right）：**
   - **协议**：在 `ResumeThread` 成功后，T1 获取 `handle->mutex` 短锁进行原子状态提交：
     - 若锁内检测到 `abortRequested == true` 或 `terminateAccepted == true`，状态**强制转入 `Terminating`**，`connectState` 置为 `Failed`，**绝不允许回退为 `Active`**；
     - 只有在确认无取消请求时，才将状态置为 `Active` 并转移 `hShell`；
   - **锁原则**：短锁内仅做内存字段的原子提交，**严禁在持锁期间执行 `Sleep`、`WaitForSingleObject` 或调用外部清理函数（如 `StopCreatedShellBounded`）**！所有清理函数必须在释放锁之后执行。

| # | 并发问题 | 机制设计与工程依据 | 线性化点与保证 |
| --- | --- | --- | --- |
| 1 | T2 能否及时发出取消请求？ | **能。** `abortRequested` 是原子布尔值（`std::atomic<bool>`）。T2（`killJob`/`dispose`）发起取消时，**无需等待 T1 的 `baton->mutex`**，直接执行 `abortRequested.store(true, std::memory_order_release)`；若 `hJob` 有效，并发调用 `TerminateJobObject(hJob, 1)`（Windows 内核保证并发安全）。T2 耗时在微秒级，绝不被 T1 阻塞 | T2 原子写入 `abortRequested` 即为请求发出线性化点 |
| 2 | T1 如何判断取消请求已生效？ | T1 在连接流程的 5 个关键检查点（创建前、创建后、accounting 每次轮询前/后、ResumeThread 紧邻前、锁内提交前）均通过 `memory_order_acquire` 检查 `abortRequested`。一旦检测到 true，立即中止正常流程转入清理 | T1 各阶段 acquire 读取点 |
| 3 | 取消发生在 ResumeThread 前后分别如何处理？ | - **ResumeThread 前到达（线性化点 1）**：T1 确认 abort，**绝对不调用 `ResumeThread`**！子进程主线程永久处于挂起态，未执行用户程序。T1 调用 `StopCreatedShellBounded` 先 TerminateJobObject 整组终止，再按受检句柄回收，抛出 `pty_aborted`。<br>- **ResumeThread 后到达（线性化点 2）**：ResumeThread 已成功返回，主线程已被唤醒。T1 进入锁临界区提交所有权时检测到 abort，**严禁将状态置为 `Active`**，必须标记为 `Terminating`，在锁外执行 `StopCreatedShellBounded` 强杀清理并抛出 `pty_aborted` | 线性化点 1：ResumeThread 调用前；线性化点 2：提交锁内的原子检查 |
| 4 | 如何防止 ResumeThread 后状态被改回 Active？ | 在步骤 5 的 `handle->mutex` 提交临界区内，T1 **必须先行校验** `abortRequested`、`disposeRequested`、`terminateAccepted` 与 `jobState`；若任一指示已取消，`jobState` 强制转移为 `Terminating`，`connectState` 设为 `Failed`，严禁赋值 `Active` | 锁内 CAS 式前置校验，消除回退窗口 |
| 5 | 如何防止 T2 在 T1 使用 hJob 时关闭句柄？ | **句柄所有权法则：** 在 Connecting 期间（`connectInProgress == true`），`hJob` 所有权由 T1 的 Guard 独占。T2 在 Connecting 期间**绝对禁止调用 `CloseHandle(hJob)`**，只允许调用 `TerminateJobObject`！关闭句柄动作只能由 T1 在连接结束或失败 Guard 中串行完成 | Connecting 期间 T2 仅有 Signal 权，无 Close 权 |
| 6 | 如何防止在持锁状态下调用需要重新加锁的清理函数？ | **锁分层与锁外清理原则：** T1/T2 在持锁临界区内仅执行纯内存字段的赋值与检查；一旦决定清理，**必须先释放 `baton->mutex`**，再调用 `StopCreatedShellBounded` 或 `MarkConnectFailedAndCleanup`；清理函数内部按需获取自身所需锁，彻底避免递归锁死或 ABBA 跨锁死锁 | 严格遵守“持锁修改状态，释放锁执行外部清理” |
| 7 | 如何避免在持锁期间执行阻塞等待？ | **彻底消除持锁 Sleep：** 步骤 4 中的 accounting 轮询（3 次重试，每次 50ms）在无锁状态下执行，使用栈上的局部 `pi.hProcess` 和 `handle->hJob` 进行查询；查询间隙调用 `Sleep(50)` 绝不持有 baton mutex，T2 的取消与状态查询畅通无阻 | 阻塞调用完全在锁外进行 |

#### 固有调度窗口的如实保留
对于 `ResumeThread` 已经返回到 T1 获取提交锁之间的微秒级调度窗口，若 T2 在此瞬间发起终止，子进程可能已开始执行极短时间的代码。**这是多任务操作系统抢占式调度的物理固有事实，无法通过用户态代码完全消除。** 本设计如实保留此风险定义，不宣传虚假“绝对零窗口”，而是通过“Resume 后中止必定整组终止且绝不回退 Active”保证系统的安全闭环。

要点：

- 伪代码中的失败清理（`StopCreatedShellBounded`/`MarkConnectFailedAndCleanup`）必须在**释放 Connecting 临界区锁之后**执行；锁内只记录 `abortRequested/StopReport` 所需字段。否则 `PtyKill` 会等待锁，而清理又试图获取同一把锁。
- `hThread` 保留到 `ResumeThread` 之后；当前代码在 `445` 提前关，B+ 必须改。
- `hShell` 只在验证/resume 成功后转移；验证/resume 失败由 `PtyConnectGuard` 按 `hProcess` 终止。
- **`StartExitThread` 失败发生在 shell 已创建/可能已 Resume 之后。** 此时 `PtyConnect` 不能返回 success：置 `connectState=Failed`、`connectInProgress=false`，保持所有权，调用 `StopCreatedShellBounded`（先 `TerminateJobObject`，再按句柄），然后在 `kStartupDrainTimeoutMs` 内做有界 drain；未确认时把 `{hJob,hProcess}` 交给 startup quarantine，置 `startupQuarantineOwned=true`。`hJob` 只在 drain 成功或空树证明后按受检方式关闭；未确认只能 `Unconfirmed`。随后发布终态、把 hpc 交给清理管理器、抛 `pty_exit_thread_failed`。禁止只关 `hShell` 留后代，禁止 PID 终止。
- **TSFN 在 shell 之前创建。** 当前 `SetupExitCallback` 在 shell 已创建后才创建 TSFN；如果 TSFN 创建失败，当前实现留下一个已运行的 shell。P3-C 必须把 `CreateExitChannel` 前移，或在该失败路径用 Job 整组终止。
- **任何启动失败都不能只杀 shell。** `StopCreatedShellBounded` 先 `TerminateJobObject`（若 Job 存在），再 `TerminateProcess`，最后 `WaitForSingleObject`；不能只调用 `TerminateProcess` 就宣称退出，也不能留后代。
- `IsProcessInJob`、`ActiveProcesses` 和 `ResumeThread` 失败都走同一个 `StopCreatedShellBounded`；**禁止 PID 终止**。`hProcess` 是内核句柄，不是 PID，允许按句柄终止。
- `StopCreatedShellBounded` 的判定：
  - `WaitForSingleObject == WAIT_OBJECT_0`：只能说明 shell 已退出；后代是否清空仍看 Job accounting。若 accounting 不为 0 或查询失败，`hJob` 必须交给 `startupQuarantine` 继续终止/查询，不能因为 shell 退出就关闭 Job 并宣称清理完成。
  - `WAIT_TIMEOUT`/`WAIT_FAILED`/`WAIT_ABANDONED`：shell 未确认退出；保留 `hProcess`，把 `{hJob,hProcess}` 交给有界 `startupQuarantine` 继续终止/等待；**不能关闭 hProcess 后假装进程消失**。
  - `TerminateProcess` 返回失败且 `GetLastError()==ERROR_ACCESS_DENIED`：先 `WaitForSingleObject(hProcess,0)`；`WAIT_OBJECT_0` 说明已退出，否则标记 `terminate_failed`。
  - `TerminateJobObject` 返回失败：记录 `jobTerminateError`，继续按句柄终止；不得因为 Job 失败就跳过 shell。
- `startupQuarantine` 固定上限（建议 4 项），由清理管理器周期重试 `TerminateJobObject` + `WaitForSingleObject(hProcess,0)`；超过上限时拒绝新终端（`pty_startup_cleanup_busy`），不静默丢弃 HANDLE。已创建 shell 的失败路径若无法立即入队，baton 置 `startupQuarantinePending=true` 保留 `{hJob,hProcess}`，由清理管理器重试；`dispose` 不得关闭它们。进程退出时 OS 回收仍未关闭的句柄，终态保持 `Unconfirmed`。
- `DeleteProcThreadAttributeList` + `delete[]` 必须在成功/失败所有路径执行；由 `ProcThreadAttrGuard` 负责。
- `JOB_LIST` 的 `jobs` 数组在 `CreateProcessW` 期间有效；栈数组即可。
- `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在旧 SDK 可手写宏（`ProcThreadAttributeValue(13, FALSE, TRUE, FALSE)`），避免把 `_WIN32_WINNT` 从 `0x600` 提高；运行时失败 fail closed。
- `PtyConnect` 任何异常都必须由 `PtyConnectGuard` 负责：按 `StopCreatedShellBounded` 处理已创建 shell、关闭 `hThread`、关闭 `hIn/hOut`、把 `hpc` 交给清理管理器、按受检方式关闭 `hJob`；hpc 成功入队且状态允许时才 `maybeRemoveBaton`，不能留下没有 owner 的 shell 或半关闭的 baton。JS 构造 catch 再调一次 `dispose` 只作为幂等兜底。
- `PtyConnect` 失败时 shell 可能已创建，而 JS 已经持有 pty id。如果 hpc 入队失败（停止/worker 启动失败），guard **保留 baton、hpc 和预约**并抛错，让 JS catch 的 `dispose` 重试；不能移除 baton 留下无主 hpc。
- 如果失败发生在 shell 创建之前，guard 必须先对 `hJob` 连续两次成功查询 `ActiveProcesses==0`（间隔 ≥50ms），确认空树后才能置 `drainedVerified=true`，再受检关闭 Job、置 `jobState=Closed`，最后清理 hpc；否则无退出线程的 baton 会永久残留。即使此前 `PtyKill` 已把 `jobState` 置为 `Terminating`，也不得把空 Job 说成“仍在终止”：两次零查询成功且关闭成功后 `drainedVerified` 为 true，同时保留 `terminateAccepted` 供诊断；查询失败或关闭失败只能 `Unconfirmed`。
- 如果失败发生在 shell 创建之后，guard 按 `hProcess/hShell` 终止并关闭 Job，设置 `shellState=Exited`。只有 `StopCreatedShellBounded` 明确完成两次 `ActiveProcesses==0` 查询时才能置 `jobState=Drained/drainedVerified=true`；否则只能 `Unconfirmed/drainedVerified=false`。不能因为 `TerminateProcess` 成功就声称树已清空。
- 如果 `WaitForSingleObject` 超时或失败，`hShell` 的所有权不转给退出线程，也不关闭；`startupQuarantine` 持有 `{hJob,hProcess}` 直到确认退出或进程退出。此时必须置 `startupQuarantineOwned=true` 并记录 token；baton 若被保留，`connectState=Failed`，`dispose` 不得关闭该 `hJob`，`maybeRemoveBaton` 不得在 quarantine 未释放前删除。

### 6.5 `PtyKill`：Job 模式只发终止请求

```cpp
// PtyKill 与 abortJob 共用；viaAbortJob 只影响 legacy 分支是否允许执行。
static JobControlResult RequestJobTerminationLocked(const std::shared_ptr<pty_baton>& h,
                                                     bool viaAbortJob) {
  if (h->jobMode == JobMode::None) {
    if (!viaAbortJob) return LegacyKill(h);     // 旧终端保留旧行为
    return { requested:true, treeState:"not_job_mode", error:"job_mode_required" };
  }

  // 启动隔离区持有/待接收 hJob/hProcess：不竞争，不重复终止/关闭。
  if (h->startupQuarantineOwned || h->startupQuarantinePending) {
    return { requested:true, terminateAccepted:h->terminateAccepted,
             drainedVerified:false, closeUnconfirmed:h->hJobCloseUnconfirmed,
             treeState:"unconfirmed", error:"startup_quarantine" };
  }

  // Connecting（含 PtyConnect 尚未开始）：只发 Job 级终止请求；不碰 hShell，不关闭 hpc。
  if (h->connectState == ConnectState::Connecting || h->jobState == JobState::Connecting) {
    h->abortRequested.store(true, std::memory_order_release);
    h->disposeRequested.store(true, std::memory_order_release);
  }

  switch (h->jobState) {
    case JobState::Connecting:
      if (!h->hJob) {
        h->jobState = JobState::Unconfirmed;
        return { requested:true, closeUnconfirmed:false,
                 treeState:"unconfirmed", error:"job_handle_missing" };
      }
      h->abortRequested.store(true, std::memory_order_release);
      if (TerminateJobObject(h->hJob, 1)) {
        h->terminateAccepted = true;
        // 请求已接受，但 hJob 保持打开；PtyConnect 仍可能引用它做 IsProcessInJob/
        // accounting。连接路径看到 abort 后负责不 Resume 并由 Guard 清理。
        // T2 此时仅有 Signal 权，绝对没有 Close 权，严禁在此调用 CloseHandle(hJob)！
        h->jobState = JobState::Terminating;
        return { requested:true, terminateAccepted:true,
                 treeState:"terminating" };
      }
      // Connecting 期间禁止关闭 hJob：CreateProcessW 的属性列表/PtyConnect 仍可能使用它。
      // 这里只记录失败并置 abortRequested，由 PtyConnect 的 abort 清理或 dispose 的空 Job
      // 分支在不再使用 hJob 后按受检方式关闭。
      h->lastError = GetLastError();
      return { requested:true, terminateAccepted:false,
               treeState:"unconfirmed", error:"job_terminate_failed" };

    case JobState::Active:
      if (!h->hJob) {
        h->jobState = JobState::Unconfirmed;
        return { requested:true, closeUnconfirmed:false,
                 treeState:"unconfirmed", error:"job_handle_missing" };
      }
      if (TerminateJobObject(h->hJob, 1)) {
        h->terminateAccepted = true;
        h->jobState = JobState::Terminating;
        return { requested:true, terminateAccepted:true,
                 treeState:"terminating" };
      }
      // 兜底：关闭最后一个 Job 句柄，触发 KILL_ON_JOB_CLOSE。
      // 这不是 TerminateJobObject 成功，也不能验证 accounting。
      h->lastError = GetLastError();
      if (CloseHandle(h->hJob)) {
        h->hJob = nullptr;
        h->hJobClosed = true;
        h->fallbackUsed = true;
        h->jobState = JobState::ClosingUnverified;
        return { requested:true, terminateAccepted:false,
                 fallbackUsed:true, treeState:"unconfirmed",
                 error:"job_terminate_failed" };
      }
      h->lastError = GetLastError();
      h->hJobCloseUnconfirmed = true;
      h->jobState = JobState::Unconfirmed;
      return { requested:true, terminateAccepted:false,
               closeUnconfirmed:true, treeState:"unconfirmed",
               error:"job_close_failed" };

    case JobState::Terminating:
      return { requested:true, terminateAccepted:true,
               treeState:"terminating" };
    case JobState::Draining:
      return { requested:true, terminateAccepted:h->terminateAccepted,
               treeState:"draining" };
    case JobState::Drained:
      return { requested:true, terminateAccepted:h->terminateAccepted,
               drainedVerified:true, jobHandleClosed:h->hJobClosed,
               closeUnconfirmed:h->hJobCloseUnconfirmed
                                || h->hShellCloseUnconfirmed,
               treeState:"drained" };
    case JobState::Closed:
      return { requested:true, terminateAccepted:h->terminateAccepted,
               drainedVerified:h->drainedVerified, jobHandleClosed:true,
               closeUnconfirmed:h->hJobCloseUnconfirmed
                                || h->hShellCloseUnconfirmed,
               treeState:h->drainedVerified ? "drained" : "unconfirmed" };
    case JobState::ClosingUnverified:
    case JobState::Unconfirmed:
      return { requested:true, terminateAccepted:h->terminateAccepted,
               fallbackUsed:h->fallbackUsed,
               drainedVerified:false,
               closeUnconfirmed:h->hJobCloseUnconfirmed
                                || h->hShellCloseUnconfirmed,
               treeState:"unconfirmed", error:"unconfirmed" };
    default:
      return { requested:true, treeState:"unconfirmed", error:"invalid_state" };
  }
}

static Napi::Value PtyKill(...) {
  auto handle = get_pty_baton(id);
  if (!handle) {
    // baton 已删除：先读有界终态缓存；有快照时返回快照，不把 gone 当 drained。
    auto snapshot = lookupFinalState(id);
    if (snapshot) {
      return { requested:true,
               terminateAccepted:snapshot->terminateAccepted,
               drainedVerified:snapshot->drainedVerified,
               jobHandleClosed:snapshot->jobHandleClosed,
               closeUnconfirmed:snapshot->jobCloseUnconfirmed
                                 || snapshot->shellCloseUnconfirmed,
               treeState:snapshot->drainedVerified ? "drained" : "unconfirmed",
               error:nullptr };
    }
    return { requested:true, terminateAccepted:false,
             drainedVerified:false, treeState:"gone",
             error:nullptr };  // gone 只表示没有 baton 且没有快照；不等于 drained
  }
  std::lock_guard lock(handle->mutex);
  return RequestJobTerminationLocked(handle, /*viaAbortJob=*/false);
}
```

- **Job 模式分支里没有 `legacyKill`、没有 `process.kill`、没有 `_getConsoleProcessList`。**
- **不再返回 `terminated`。** 唯一表示“终止请求已提交”的字段是 `terminateAccepted`；唯一表示“进程树已确认归零”的字段是 `drainedVerified`；两者不能互相推导。
- `TerminateJobObject` 成功只表示请求已接受，状态是 `Terminating`；在 drain 之前 `treeState` 只能是 `terminating`/`draining`。
- **`Active`** 失败时关 `hJob` 触发 `KILL_ON_JOB_CLOSE`，但结果是 `ClosingUnverified`，`treeState=unconfirmed`，**不能声称已清空**。
- **`Connecting`** 期间 `TerminateJobObject` 失败时**不关闭 `hJob`**：`CreateProcessW` 的属性列表和 `PtyConnect` 仍可能使用它。只置 `abortRequested` 并返回 `unconfirmed`，由连接路径/dispose 在不使用 `hJob` 后受检关闭。
- `CloseHandle(hJob)` 失败时置 `hJobCloseUnconfirmed=true`、`treeState=unconfirmed`；该句柄不再使用、不重试、不再次关闭，不尝试 PID。`hJobClosed` 保持 false。
- `jobState=Drained` 但 `CloseHandle(hJob)` 失败时仍返回 `drainedVerified=true` 和 `jobHandleClosed=false`；drain 的事实不被关闭失败抹掉，但资源清理仍标为不完整。
- `PtyKill` 与 `abortJob` 的重复/并发调用由 mutex 串行化；状态幂等。`abortJob` 在 `jobMode=None` 时只返回 `not_job_mode`，不执行 legacy kill。
- `requested:true` 只表示调用到达了 native 控制路径，不表示任何进程被终止。
- `startupQuarantineOwned=true` 时 `PtyKill`/`abortJob` **不**操作 `hJob/hProcess`，避免与 quarantine worker 竞争；只返回当前 `treeState`（通常 `unconfirmed`）、`terminateAccepted` 和 `closeUnconfirmed`，由隔离区继续清理。`jobStatus` 必须暴露 `startupQuarantine` 标记。

### 6.6 退出线程与 drain（死锁消除与生命周期闭环）

```text
loop:
  w = WaitForMultipleObjects({hShell, control->hStopEvent}, FALSE, 500ms)
  WAIT_OBJECT_0 + 0 -> shell 已正常退出；break
  WAIT_TIMEOUT      -> continue（轮询并检查 channel->envClosing / control->stop）
  WAIT_OBJECT_0 + 1 -> Node 环境清理钩子已触发停止信号；立即中止，释放 TSFN 引用并退出线程
  WAIT_FAILED       -> shellExitUnconfirmed；不能发 onExit；在 mutex 下 TerminateJobObject，
                       再受检关闭 hJob（成功 -> ClosingUnverified，失败 -> Unconfirmed）；
                       随后用 WaitForSingleObject(hShell, 2000ms) 复核一次：
                       仅 WAIT_OBJECT_0 才受检关闭 hShell 并置 hShellClosed，但仍不置
                       shellExited、不发 onExit；超时/再次失败则保留 hShell（baton 所有，
                       不重试、不按 PID），baton 留到硬退出，终态 Unconfirmed

if (control->stop || channel->envClosing) {
  // 环境正在销毁：绝不再调用 JS，立即释放 TSFN 引用，打破循环等待
  channel->ReleaseHolder();
  return;
}

GetExitCodeProcess(hShell) -> exitCode（失败则 null/unknown，不伪造 0）
lock: shellState=Exited; shellExited=true
PublishSnapshot(handle, exitCode, current state)  // 更新共享 finalState 的 shellExited 字段
Post(PtyEvent{ PtyEventType::Exit, snapshot, handle->finalState })   // 立即通知 shell 退出；携带当前不可变快照，此时 treeState 可能仍是 active/terminating
CloseHandleChecked(hShell): 成功 -> hShellClosed=true, hShell=nullptr
                           失败 -> hShellCloseUnconfirmed=true，保留 HANDLE，不再使用/重试
if jobMode == Required:
  if hJob && !hJobCloseUnconfirmed && state in {Active,Terminating,Draining}:
    if state is Active/Terminating -> 查询 accounting
    if active > 0:
      if (TerminateJobObject(hJob, 1)) { terminateAccepted=true; jobState=Terminating; }
      else { lastError=GetLastError(); /* 不置 terminateAccepted；下方按受检关闭兜底 */ }
    jobState=Draining        // shell 已退出，等待 accounting 归零；Draining 不是 Drained
    loop up to JOB_DRAIN_TIMEOUT_MS (100ms step):
      if (control->stop || channel->envClosing) { jobState=Unconfirmed; break; }
      QueryInformationJobObject(JobObjectBasicAccountingInformation)
      query fail -> jobState=Unconfirmed; break
      active == 0 twice (>=50ms apart) -> drainedVerified=true; jobState=Drained; break
      timeout -> jobState=Unconfirmed; break
    if drainedVerified:
      CloseHandleChecked(hJob)
        成功 -> hJobClosed=true, hJob=nullptr, jobState=Closed
        失败 -> hJobCloseUnconfirmed=true, 保持 JobState::Drained（drain 仍为真）
    else:
      // 未确认归零：关闭最后一个 hJob 触发 KILL_ON_JOB_CLOSE 兜底
      CloseHandleChecked(hJob)
        成功 -> hJobClosed=true, hJob=nullptr, jobState=ClosingUnverified
        失败 -> hJobCloseUnconfirmed=true, jobState=Unconfirmed
      drainedVerified=false
  else:
    // hJob 已关闭/不可查询：保留已有终态，不伪造 drained
    if state == ClosingUnverified: jobState=Closed      // drainedVerified=false
    else: jobState=Unconfirmed                          // 已是 Unconfirmed 则保持
    drainedVerified=false
else:
  jobState=None

PublishFinalState(handle, exitCode, drainedVerified, jobState, flags) // 更新同一个共享 finalState
if (!control->stop && !channel->envClosing) {
  Post(PtyEvent{ PtyEventType::JobState, finalSnapshot, handle->finalState })  // drain 后的最终不可变快照；晚到事件/查询以它和 cache 为准
}
if (hpc && !hpcEnqueued) enqueue hpc cleanup（失败则保留 hpc/预约，后端重试）
maybeRemoveBaton()                         // 只有 hpc 已 disposed 且 jobState 终态才移除
channel->ReleaseHolder();                  // 退出线程完成工作，恰好释放一次 TSFN 引用
```

- **`shellExited` 只由 `WAIT_OBJECT_0` 置位。** `WAIT_TIMEOUT`、`WAIT_FAILED`、`WAIT_ABANDONED` 都不是退出；等待循环由 `control->hStopEvent` 唤醒。**该停止事件由 Node-API `napi_add_env_cleanup_hook` 在主线程非阻塞触发，绝不依赖 TSFN finalizer 置位，彻底消除循环死锁。**
- **WAIT_FAILED 的 HANDLE 归属：** `hJob` 由退出线程在 baton mutex 下受检关闭（成功 → `ClosingUnverified`，失败 → `Unconfirmed`，都不置 `hJobClosed=true`）；`hShell` 只在复核得到 `WAIT_OBJECT_0` 时受检关闭，否则留在 baton，永不伪造退出。`hShell` 未关闭时 `maybeRemoveBaton` 拒绝删除 baton；这是每个异常终端一个有界 HANDLE 泄漏，由进程退出回收。不得为了释放 baton 而关闭状态未知的进程句柄，也不得改用 PID。
- `PublishSnapshot` 只更新共享 `PtyFinalState` 的 `shellExited/exitCode/activeProcesses`；`PublishFinalState` 才写 `drainedVerified/jobState/closeUnconfirmed`。两者都不删除 baton；`onExit` 的不可变快照仅反映触发瞬间的历史状态，不能被 JS 当成最终状态。
- **`hJob` 的 Query/Terminate/Close 必须在 baton mutex 下串行。** `PtyKill` 的 `TerminateJobObject` 失败兜底也会关闭 `hJob`；如果退出线程无锁持有旧句柄并继续 `QueryInformationJobObject`，就是 use-after-close。退出线程在每次查询前锁 mutex、确认 `hJob` 仍非空且未 `CloseUnconfirmed`，查询后释放；`PtyKill`/`dispose` 的关闭在同一 mutex 下置空/置标志。禁止无锁使用 `hJob`，也禁止在 `hJob` 已关闭后查询 accounting。
- **drain 轮询也检查 `hStopEvent`/TSFN 停止标志。** Node env 销毁时，退出线程不能为了完成 drain 阻塞 finalizer；发现停止请求就保留当前 `Unconfirmed`/未发布状态、释放不触碰 JS 的事件数据并退出。此时 `KILL_ON_JOB_CLOSE`/进程退出负责最终回收；不得在 env 销毁后发布 `onJobState`。
- **Shell 退出后先按受检方式关闭 `hShell`，再做 drain。** 官方 `ActiveProcesses` 说明“进程退出且所有引用释放后才递减”；本进程持有的 `hShell` 句柄可能暂时压住 accounting。关闭失败时保留 `hShellCloseUnconfirmed`，不能把它当作已释放。
- **只有连续两次成功查询 `ActiveProcesses==0` 才置 `Drained`。** 一次零值可能是瞬态；查询之间至少 50ms。`TerminateJobObject` 返回成功不参与这个判定。`QueryZeroTwice(hJob)` 即这个判定；空 Job/启动失败路径也复用它，不能走“没有 shell 就视为 drained”的捷径。
- 如果 `ActiveProcesses>0`，先发 `TerminateJobObject`；它成功只进入 `Terminating/Draining`，不是 `Drained`。超时/查询失败时关闭 `hJob` 触发 `KILL_ON_JOB_CLOSE`，状态最多到 `ClosingUnverified`/`Unconfirmed`；不报告“清理完成”。
- `CloseHandle(hJob)` 失败时：若此前已 `Drained`，保留 `Drained` + `drainedVerified=true` + `hJobCloseUnconfirmed=true`，不进入 `Closed`；若此前未 drain，进入 `Unconfirmed`。**任何情况下失败都不置 `hJobClosed=true`，也不重试关闭。**
- `onExit` 先发（shell 退出），`onJobState` 后发（drain/unconfirmed）；`onExit` 携带当时的不可变快照，**可能是 drain 前的 `active/terminating`**，不能当成整树清理完成。drain 后的最终状态以 `onJobState`、事件携带的共享 `PtyFinalState` 或 `jobStatus()` cache 为准。
- `hpc` 清理由退出线程请求一次；如果队列满，保留在 baton 里，后端重试；不丢弃。
- 退出线程绝不能调用 `ClosePseudoConsole`（会阻塞），只请求 cleanup。
- 如果 `shellExitUnconfirmed`，不伪造 `onExit`；发 `onJobState(unconfirmed, shellExitUnconfirmed=true)`，后端保持 `closing`/`cleanupPending`，并保存诊断。

**关于 `ActiveProcesses` 与嵌套 Job 的准确边界：**

- 官方 Job Objects 文档明确：嵌套 Job 的 accounting 会在父 Job 聚合子 Job；官方 Nested Jobs 文档也写明父 Job 的资源会计包含子 Job 中的进程。因此本设计把子 Job 进程计入 `ActiveProcesses` 作为**文档依据下的预期**。
- `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.ActiveProcesses` 的结构页只写“当前与 Job 关联的进程数”，没有再次展开嵌套语义；目标 Windows 上的实际计数仍列为 `[C0]`，不能用单次经验替代。
- `TerminateJobObject` 官方明确会终止子 Job；这部分不需要猜测。
- `ActiveProcesses==0` 只说明**当前 Job 的 accounting 归零**；以下进程不在保证内：
  - 通过 WMI `Win32_Process.Create` 创建的进程（官方明确不随父进程加入 Job）；
  - 由服务、计划任务、UAC/AppInfo 等**另一个进程**代为创建的进程（官方未把它们定义为 Job 成员）；
  - 显式 breakaway 或外部 Job 层级允许 breakaway 的进程；
  - conhost/OpenConsole（其生命周期由 `HPCON` 控制，不是 shell 后代）；
  - 与本 Job 关联失败的进程。
- 因此 `Drained` 不是“整棵 Windows 进程树绝对为空”，也不是安全沙箱证明；UI/验收不能扩大这个保证。

### 6.7 `dispose` 与有界清理管理器

**问题：** 每次 dispose 创建一个 detached 线程，在旧版 Windows 上 `ClosePseudoConsole` 长时间阻塞时会不断累积线程和句柄；若队列不可用而在主事件循环同步调用 `ClosePseudoConsole`，会直接导致整个应用界面锁死。

**设计：**

```cpp
struct PtyCleanupTask {
  int id;
  uint64_t generation;
  HPCON hpc;                                  // 独立所有权，绝不持有 baton 裸指针
  bool useConptyDll;
  std::shared_ptr<PtyCloseState> closeState;
  std::shared_ptr<PtyFinalState> finalState;  // 共享终态，worker 完成后在锁内更新
  std::shared_ptr<PtyEventChannel> channel;   // 独立事件通道，持有明确 TSFN 引用
};

struct PtyCloseState {
  std::atomic<bool> closeStarted{false};
  std::atomic<bool> closeReturned{false};     // ClosePseudoConsole 已返回；void，无成功码
};

// 启动失败且 WaitForSingleObject 未确认退出时使用；不是每次 dispose 都创建。
struct PtyStartupQuarantine {
  int id;                                     // 用于清除 startupQuarantineOwned / maybeRemoveBaton
  uint64_t generation;
  HANDLE hJob;                                // 可为 null；只用于 TerminateJobObject/Query
  HANDLE hProcess;                            // 保留，不关闭
  std::shared_ptr<PtyFinalState> finalState;  // 可为 null；worker 发布终态
  uint64_t token;                             // 本地诊断 token，不放 PID
  std::chrono::steady_clock::time_point deadline;
};

class PtyCleanupManager {
  static constexpr int kWorkers = 2;
  static constexpr int kMaxTracked = 32;      // 容量预约 + 队列 + in-flight
  static constexpr int kMaxStartupQuarantine = 4; // 启动失败未确认的进程 HANDLE
  std::mutex mu;
  std::condition_variable cv;
  std::deque<PtyCleanupTask> queue;
  std::deque<PtyStartupQuarantine> startupQuarantine;
  std::vector<HPCON> pendingHpc;             // shutdown 或异常时无法入队的 HPCON 保留集合
  int tracked = 0;                           // 所有需要最终 hpc 清理的 PTY
  bool stopping = false;
  std::vector<std::thread> workers;          // 固定数量，启动时就绪
public:
  bool isWorkerHealthy();                    // 检查固定 worker 线程是否处于存活就绪状态
  bool reserve();                            // 满/停止/worker 未就绪 -> false；不创建 hpc
  void release();                            // hpc 已关闭或创建失败
  bool enqueue(PtyCleanupTask task);         // 调用方必须持有 reservation
  bool quarantineStartup(PtyStartupQuarantine entry); // 满 -> false（fail closed）
  int trackedCount();
  int quarantineCount();
  void shutdown();                           // 停止接收；detach 阻塞 worker
};
```

- **固定 2 个 worker，最多 32 个 tracked（预约 + 队列 + in-flight）。** 不再每次 dispose 建线程。
- **创建 HPCON 的硬前置条件：** `cleanupManager.isWorkerHealthy() && cleanupManager.reserve()` 必须同时为 true。若 worker 启动失败或队列满，直接拒绝创建终端（503 `pty_cleanup_busy`），**在源头上绝不调用 `CreatePseudoConsole`**。
- **Cleanup Worker 的事件通道与 TSFN 引用彻底解耦（关键机制）：**
  - **入队与执行期间零 TSFN 引用**：当 `cleanupManager.enqueue(task)` 成功时，task 持有 `std::shared_ptr<PtyEventChannel> channel` 与 `std::shared_ptr<PtyFinalState> finalState`，但**在入队时以及在 worker 执行 `ClosePseudoConsole` 期间，绝对不调用 `channel->AcquireHolder()`，绝对不持有任何 TSFN 引用！**
  - **杜绝阻塞清理任务阻碍 Node 退出**：在旧版 Windows 上，`ClosePseudoConsole` 可能会长时间甚至无限期阻塞。由于 worker 在阻塞期间持有 0 个 TSFN 引用，Node.js 环境销毁（teardown）时无需等待此 worker，TSFN finalizer 能在退出线程释放引用后立即触发，Node 进程平滑退出，绝不死锁。
  - **完成后的临时通信阶段**：
    1. worker 线程从队列获取 task 后，调用 `ClosePseudoConsole`/`ConptyClosePseudoConsole`；
    2. 调用实际返回后，worker **立即加锁更新 `task.finalState->ptyDisposed = true` 和 `task.finalState->hpcCloseReturned = true`**。Native 终态无论环境是否销毁均保持 100% 物理落地；
    3. 仅在调用返回后且 `!channel->IsClosing()` 时，worker 尝试调用 `channel->AcquireHolder()`；
    4. 若 `AcquireHolder()` 成功（返回 true，即底层确认 `napi_ok` 且环境未处于关闭），worker 构造 `PtyEvent`（`type = PtyDisposed`）调用 `channel->Post(...)`，并在**投递后立即调用 `channel->ReleaseHolder()`**；
    5. 若 `AcquireHolder()` 失败（环境正在关闭或已收到 `napi_closing`），worker 绝不强求通信，直接跳过 JS 投递并安全退出；
  - **状态码处置**：
    - `napi_ok`：正常投递；
    - `napi_queue_full`：采用最多 3 次退避重试（间隔 5ms）；若仍满，记录事件投递警告，**绝对不无限阻塞 worker**，依赖 backend 终态对账和 cache 补查；
    - `napi_closing`：说明环境正在关闭，立即停止，不再调用 JS；
  - worker 绝不持有 baton 裸指针，不直接访问已可能销毁的 baton 结构。
- **`ClosePseudoConsole` 返回 `void`，没有成功/失败返回值。** `closeStarted` 表示 worker 已开始调用，`closeReturned` 表示调用已返回；`disposed` 只能表示“调用已返回”，不能表示 conhost 已退出或资源已全部回收。
- **彻底消除主线程同步 ClosePseudoConsole 兜底，六大异常场景处置矩阵：**

| 异常场景 | 资源所有权归属 | 终态与状态字段 | 会话处理与日志规则 |
| --- | --- | --- | --- |
| **1. cleanup worker 启动失败** | HPCON 尚未创建则直接拒绝；若已存在 HPCON，所有权转入 manager 的 `pendingHpc` | `ptyDisposed=false`<br>`closeReturned=false` | 503 `pty_cleanup_busy`；拒绝新终端创建；记录 `terminal.cleanup_worker_init_failed` 严重告警；**绝对禁止在主线程同步调用 ClosePseudoConsole**，句柄随进程退出回收 |
| **2. cleanup worker 队列已满** | HPCON 由 baton 继续持有，预约保留 | `ptyDisposed=false`<br>`cleanupPending=true` | 新终端返回 503 拒绝；已有会话保持 `closing`，由 backend 定期进行有界重试；记录 `terminal.cleanup_queue_full` |
| **3. cleanup manager 正在 shutdown** | 已入队任务由 worker 尽力完成；未入队 HPCON 归入 `pendingHpc` | `ptyDisposed=false` | 停止接收任何新任务；阻塞中的 worker 执行 `detach()`，不阻塞应用退出；记录 `terminal.cleanup_manager_shutdown` |
| **4. worker 长时间阻塞（旧版 Windows ConPTY 固有缺陷）** | 阻塞任务由该 worker 独占持有，HPCON 处于调用中 | `closeStarted=true`<br>`closeReturned=false`<br>`ptyDisposed=false` | 占用 1 个 tracked 容量；当 32 项容量耗尽时自动 fail closed 拒绝新终端；会话保持 `cleanupPending`；记录 `terminal.cleanup_worker_blocked` |
| **5. backend 正常退出** | 所有权交由 Windows 操作系统内核 | 随进程结束清理 | 触发 Node Cleanup Hook，退出线程停止，detach 阻塞 worker，OS 关闭全部句柄并触发 `KILL_ON_JOB_CLOSE` |
| **6. backend 异常崩溃** | 所有权由 Windows 操作系统内核接管 | 操作系统销毁进程 | Windows 内核自动关闭该进程持有的所有内核句柄，Job 对象的 `KILL_ON_JOB_CLOSE` 机制由内核强制触发，子孙进程树被彻底清空 |

- **容量预约机制：** `PtyStartProcess` 在创建 hpc 之前调用 `reserve()`；失败直接 503 `pty_cleanup_busy`，不创建 hpc。每个活动终端持有一个预约，保证它最终有清理槽位；`kMaxTracked=32` 大于 `maxSessions=12`，正常打开/关闭不会触发。
- `enqueue` 成功时，调用方的预约转换为队列/in-flight 任务，`HPCON` 所有权转移给 task；baton 的 `hpc=nullptr`，`hpcEnqueued=true`。tracked 不增加。
- `enqueue` 失败（停止/worker 启动失败）时，**baton 保留 `hpc` 和预约**；`dispose` 返回 `{disposed:false, queued:false, retry:true}`。不丢句柄。
- Worker 只做 `ClosePseudoConsole`/`ConptyClosePseudoConsole`；调用前置 `closeStarted=true`，返回后置 `closeReturned=true`。通过 `markPtyDisposed(id,generation)` 在 registry 中加锁设置 baton 的 `hpcCloseReturned=true`/`disposed=true`（不直接持有 baton 指针），更新 `finalState->ptyDisposed`，释放预约，并调用 `maybeRemoveBaton(id,generation)`；如果 Job/shell 还没到终态，baton 留给退出线程移除。worker 完成后通过 channel 发 `onPtyDisposed`（带不可变快照）。tracked 的增减用 RAII，异常/提前返回也必须减。
- **worker 关闭 hpc 期间，JS 必须继续读取 output socket。** `ClosePseudoConsole` 可能等待输出管道 drain；提前销毁 conout worker/socket 会让它更久阻塞。`onPtyDisposed` 之后才允许 `_close()`。
- `disposeRequested` 在第一次 dispose 时设置；`disposed` 只在清理调用返回后设置。两者分开。`disposed` 不等于 `sessionExited`，也不等于 `treeState=drained`。
- 如果 worker 永久阻塞：tracked 不降，预约耗尽，创建被拒绝；这是有意的资源保护。进程退出时 OS 关闭句柄；不能假装 disposed。
- `shutdown()` 停止接收新任务；已入队任务尽量完成；阻塞 worker **不 join**（join 会让 shutdown 卡死），对固定 worker 调用 `detach()`，由进程退出回收。`PtyCleanupManager` 是进程生命周期的 `new` 单例，正常路径不析构；避免静态析构时对 joinable `std::thread` 调用析构导致 `std::terminate`。

**`dispose` 流程：**

```text
handle = get_pty_baton(id); if (!handle) return {disposed:true, queued:false, gone:true}
lock baton
if (disposed) return {disposed:true}
disposeRequested = true
if (connectInProgress) {
  abortRequested = true
  if (jobMode == Required && hJob) RequestJobTerminationLocked(handle, /*viaAbortJob=*/true)
  // hpc 仍可能被 CreateProcessW 使用；不由 dispose 转移
  return {disposed:false, queued:false, retry:true, connecting:true}
}
if (jobMode == Required && shellState != Exited
    && !startupQuarantineOwned && !startupQuarantinePending)
  RequestJobTerminationLocked(handle, /*viaAbortJob=*/true)
if (shellState == None && hJob && !startupQuarantineOwned
    && !startupQuarantinePending && !hJobCloseUnconfirmed) {
  // 构造失败，没有 shell：仍按统一条件证明空树（两次 ActiveProcesses==0），
  // 不能仅凭“没有 shell”就置 drainedVerified。
  bool emptyVerified = QueryZeroTwice(hJob);
  if (!TerminateJobObject(hJob, 1)) lastError = GetLastError(); // 记录但不据此宣称退出
  CloseHandleChecked(hJob)
    成功 -> hJob=null; hJobClosed=true;
            jobState=emptyVerified ? Closed : ClosingUnverified;
            drainedVerified=emptyVerified;
    失败 -> hJobCloseUnconfirmed=true; jobState=Unconfirmed; drainedVerified=false;
}
if (hJobCloseUnconfirmed) {
  // 关闭失败：绝不重试关闭。已经 drain 的事实保留；未 drain 只能 Unconfirmed。
  if (!drainedVerified) jobState = JobState::Unconfirmed;
  else jobState = JobState::Drained;
}
if (startupQuarantineOwned && !drainedVerified) {
  // 隔离区仍持有 hJob/hProcess；不能报 Closed/drained。
  jobState = JobState::Unconfirmed;
}
if (!hpc) {
  if (!hpcEnqueued) {
    if (cleanupReserved) { cleanupManager.release(); cleanupReserved=false; }
    disposed = true; publishFinalState(handle);
    // 先释放 baton mutex，再 maybeRemoveBaton（registry 锁），避免 ABBA
  }
  return {disposed: !hpcEnqueued, queued:false}
}
if (hpcEnqueued) return {disposed:false, queued:true}
if (!cleanupManager.enqueue({id, generation, hpc, false, closeState, finalState, channel}))
  return {disposed:false, queued:false, retry:true}
hpc = nullptr; hpcEnqueued = true   // 预约转为队列任务
return {disposed:false, queued:true}
```

- `dispose` 不改变 `jobMode`。
- `dispose` 在释放 baton mutex 后才调用 `maybeRemoveBaton`；不要在持有 baton 锁时获取 registry 锁。
- `dispose` 可以在 shell 运行、退出、已 drain、已 unconfirmed、Connecting、startup quarantine 时调用；在 Connecting 时只置中止请求，**不转移 `HPCON`**，因为 `CreateProcessW` 仍可能使用它。`PtyConnect` 的 guard/成功路径负责在连接结束后 enqueue。
- **`startupQuarantineOwned=true` 或 `startupQuarantinePending=true` 时，`dispose` 不关闭、不查询、不重试 `hJob/hProcess`，也不删除 baton。** 它只处理 hpc；`{hJob,hProcess}` 的生命周期由隔离区 token/待接收队列管理。隔离区确认退出后按受检方式关闭 `hJob/hProcess`、发布终态、清除标志，再由最后完成方评估 `maybeRemoveBaton`；隔离区超时/失败时保持 `Unconfirmed` 并记录诊断，不能把 baton 当成垃圾回收。
- 重复调用幂等；只有一个 enqueue。`dispose` 返回 `disposed:true` 只表示清理调用已返回；不表示 Job 已 drained。
- 如果 `hpc` 已经由退出线程 enqueue，后续 dispose 返回 `queued:true`。
- **`stopSession` 在发起 kill 后立即调用 `dispose`**，不因 kill 未确认而跳过 hpc 清理；`dispose` 自己会幂等地再请求 Job 终止。这样 kill 与 conhost 清理并行，不把 hpc 留到 UI 删除之后。
- `PtyConnect` 失败/JS 构造 catch 可能发生在 shell 尚未创建时。`dispose` 发现 `shellState==None` 时，先做两次 `ActiveProcesses==0` 查询；两次成功且关闭成功才置 `jobState=Closed`、`drainedVerified=true`；查询失败或关闭失败置 `Unconfirmed`/`ClosingUnverified`，不能谎报销毁成功。再释放预约/清理 hpc；否则 baton 会因为没有退出线程而永久残留。
- 如果 `dispose` 发现 `hJob` 已关闭但 `jobState==ClosingUnverified`，不把它升级为 `Drained`；只把 `treeState` 报为 `unconfirmed`。
- 删除 baton 前必须 `publishFinalState`；否则晚到的 `jobStatus()` 只能看到 `gone`，无法区分 drained/unconfirmed。

### 6.8 HANDLE 所有权与转移

| 对象 | 创建者 | 中间所有者 | 最终所有者 | 关闭/释放条件 | 并发规则 |
| --- | --- | --- | --- | --- | --- |
| `hJob` | `PtyStartProcess` | baton；启动失败未确认时转 startup quarantine | baton（关闭成功后 null）或 quarantine | `Drained` 后按受检 `CloseHandle` 关闭；`TerminateJobObject` 失败关句柄兜底；关闭失败进入 `CloseUnconfirmed`；quarantine 持有期间禁止任何其他方关闭/查询 | 只在 baton mutex 下操作；`PtyKill`/`abortJob`/退出线程/`dispose` 串行；Connecting 期间 T2 严禁关闭 `hJob`；`startupQuarantineOwned=true` 时全部让位 |
| `hShell` | `CreateProcessW` | `PtyConnect` guard | 退出线程；启动失败未确认时转 startup quarantine | `WAIT_OBJECT_0` 后按受检 `CloseHandle` 关闭；超时/失败保留给 startup quarantine | 只有退出线程等待/关闭；`PtyKill`/`dispose` 不关；`ClosePseudoConsole` 不碰它；quarantine 持有期间不关闭 |
| `hpc` | `CreatePseudoConsole` | baton | `PtyCleanupTask` | worker 调用 `ClosePseudoConsole`（`void`）并返回；绝对不能在主事件循环同步调用，绝对不能 `CloseHandle` | 只转移一次；转移后 baton 为 null；task 不访问 baton；Connecting 期间不转移 |
| `hIn/hOut` | `PtyStartProcess` | baton | baton（`PtyConnect` 关闭） | `CreateProcessW` 成功后按受检 `CloseHandle` 关闭；失败保留句柄并置 `hInCloseUnconfirmed`/`hOutCloseUnconfirmed`；失败 guard 也只受检关闭 | 只有 `PtyConnect` 使用；失败记录，不重试 |
| `hThread` | `CreateProcessW` | `PtyConnect` guard | baton（成功转移后） | `ResumeThread` 后按受检 `CloseHandle` 关闭；失败保留 `hThread`/`hThreadCloseUnconfirmed`，不重试 | 只有 `PtyConnect` 使用；失败不阻塞终端，但记录并在进程退出时回收 |
| `hStopEvent` | `PtyEventChannel::Create` | `ExitThreadControl` | `PtyEventChannel` / TSFN finalizer | Node 环境清理钩子同步触发信号；退出线程安全退出后由 finalizer 或通道析构受检关闭 | 仅用于唤醒退出线程；不承载进程业务状态；生命周期与 Node-API 保持一致 |

规则：

1. 每个 HANDLE 在任一时刻只有一个所有者；转移必须显式（guard `release` 或 baton 字段置空）。
2. 关闭前必须确保其他线程不再使用：`hJob`/`hpc` 用 mutex + 状态；`hShell` 只有退出线程；`hThread`/`hIn/hOut` 只有 `PtyConnect`；`hStopEvent` 只有退出线程控制块和 finalizer。
3. 统一使用 `closeHandleChecked`：调用前置 `CloseAttempted`；`CloseHandle` 返回非零才置 `Closed` 并清空；返回 0 时记录 `GetLastError`，置对应 `CloseUnconfirmed`，把 HANDLE 值保留在 baton 的资源账本中，但**不再使用、不再重试、不再关闭**。`hJobClosed`/`hShellClosed`/`hThreadClosed`/`hInClosed`/`hOutClosed` 只在成功时为 true。`CloseUnconfirmed` 的句柄是“有意放弃、由 OS 在进程退出时回收”的有界泄漏；不得为了消除它而重试或重复关闭。
4. 不允许重复 `CloseHandle`：`CloseUnconfirmed` 的 HANDLE 在析构/清理路径必须跳过；进程退出时由 OS 回收。
5. 不允许在 `WaitForSingleObject(hShell)` 期间关闭 `hShell`；`PtyKill` 只杀进程，不关句柄。等待必须用 `WaitForMultipleObjects({hShell,hStopEvent})` 或有限超时，不能用 `INFINITE` 阻塞 TSFN finalizer。
6. `ClosePseudoConsole` 不是 `CloseHandle` 的对象：`HPCON` 只能交给 cleanup worker 调用一次；不要在 baton 析构中再调用 `ClosePseudoConsole`，也不要把 `CloseHandle(hpc)` 写进代码。
7. `shared_ptr` 只保证 baton 对象不被提前析构；**不是 HANDLE 线程安全的证明**。HANDLE 访问仍要 mutex/所有权。
8. 清理任务只持有 `HPCON`、`shared_ptr<PtyCloseState>` 和可选的 `shared_ptr<PtyFinalState>`，不持有 baton 指针；不会访问已释放 baton。
9. 析构函数做兜底关闭，但正常路径必须在退出/清理流程中完成；不能把资源释放留给 GC/析构。析构只关闭状态为 `Owned` 的 HANDLE；`CloseUnconfirmed` 一律跳过。
10. **终态快照先于 baton 删除：** `publishFinalState` 必须在 `remove_pty_baton_if_generation` 之前完成；`PtyFinalState` 由 cache 和 worker 共享，baton 删除后仍可更新 `ptyDisposed`。
11. **锁顺序：registry mutex → baton mutex 只能用于“查 shared_ptr 后立即释放 registry，再锁 baton”；禁止在持有 baton mutex 时获取 registry mutex。** `maybeRemoveBaton`/`markPtyDisposed` 必须在释放 baton 锁后调用，或内部先取 shared_ptr 再锁 baton。否则 worker 的 `markPtyDisposed` 与 `dispose` 的 `maybeRemoveBaton` 会形成 ABBA 死锁。
12. `hShell` 的 `CloseUnconfirmed` 不自动使 `drainedVerified=false`：如果 accounting 仍能在不依赖该句柄的情况下归零，drain 结论保留；但最终快照必须带 `shellCloseUnconfirmed=true`，UI 不得显示“完全清理完成”。
13. `startupQuarantineOwned=true` 是 HANDLE 所有权的唯一转移标记：转移后 `hJob/hProcess` 只能由隔离区 worker 使用；其他线程不得 `CloseHandle`、`TerminateJobObject`、`QueryInformationJobObject` 或 `WaitForSingleObject`。`startupQuarantinePending=true` 时同样禁止其他线程关闭/查询，由清理管理器重试接收。隔离区完成/超时都必须发布终态并清除标记；未清除前 `maybeRemoveBaton` 拒绝删除。

### 6.9 关键并发时序

**A. `PtyKill` 与 `dispose` 同时：**

```text
T1 PtyKill: lock -> Active -> TerminateJobObject -> Terminating -> unlock
T2 dispose: lock -> disposeRequested=true -> enqueue hpc -> unlock
退出线程: shell exit -> drain -> Drained -> close hJob -> enqueue/已 enqueue hpc
worker: ClosePseudoConsole -> disposed=true -> maybeRemoveBaton
```

- 两者都可能看到 `hpcEnqueued`；只有一个成功转移。
- `PtyKill` 不关 hpc；`dispose` 不关 hJob；没有交叉关闭。

**B. 自然退出与 `dispose` 同时：**

- 退出线程先拿锁设置 `shellState=Exited`，关闭 hShell；`dispose` 看到 shell 已退出，只请求 hpc 清理。
- 如果 `dispose` 先拿锁，它请求终止并 enqueue hpc；退出线程随后 drain；hpc 已转移，退出线程不重复 enqueue。
- `hJob` 只由退出线程在 drain 后关闭；`dispose` 不直接关 hJob（除非 `TerminateJobObject` 失败兜底，此时用同一状态机）。

**C. 多次 `dispose`：** 第一次 enqueue；后续返回 `queued:true`；worker 完成后 `disposed=true`，baton 移除；再次调用返回 `disposed:true`。

**D. cleanup worker 与退出回调：** worker 只持有 hpc/closeState；退出回调只通过 TSFN 通知 JS；两者不共享 HANDLE。

**E. backend 退出仍有清理任务：** `PtyCleanupManager::shutdown()` 停止接收；已入队 worker 可能阻塞；进程退出关闭句柄。不能保证 `ClosePseudoConsole` 已返回；这是硬退出边界，记录在风险中。

**F. Connecting 与 `dispose`/`PtyKill` 并发时序：**

```text
T1 PtyConnect: lock -> connectState=Connecting, connectPhase=Starting -> unlock
T1 PtyConnect: CreateProcessW 成功 (CREATE_SUSPENDED) -> connectPhase=Validating
T1 PtyConnect: IsProcessInJob 校验成功 -> 进入 accounting 轮询 (无锁 Sleep 50ms)

[并发到达窗口]
T2 dispose/killJob: 无需等待 baton->mutex！
             -> abortRequested.store(true, memory_order_release)
             -> TerminateJobObject(hJob, 1) 发起整组终止 (内核并发安全)
             -> 发现 connectInProgress=true，不关闭句柄、不转移 hpc -> 返回 retry

[线性化点 1：ResumeThread 紧邻前]
T1 PtyConnect: 轮询醒来，检查 abortRequested.load(memory_order_acquire) == true
             -> 确认已取消：绝不调用 ResumeThread！子进程永久挂起
             -> connectPhase=Aborting
             -> 调用 StopCreatedShellBounded (整组终止并受检回收) -> throw pty_aborted

[若取消稍晚发生：线性化点 2：ResumeThread 紧邻后]
T1 PtyConnect: ResumeThread(pi.hThread) 成功唤醒主线程
T1 PtyConnect: lock baton->mutex 准备提交所有权
             -> 检查 abortRequested / terminateAccepted / jobState==Terminating
             -> 发现已被取消：connectPhase=Aborting, jobState=Terminating, connectState=Failed
             -> 绝不把状态改回 Active！
T1 PtyConnect: unlock baton->mutex
             -> 锁外调用 StopCreatedShellBounded 强杀子孙进程 -> throw pty_aborted
```

- `PtyConnect` 在 Connecting 期间不允许 `dispose` 关闭 `hpc`：`CreateProcessW` 的属性列表仍引用它。`dispose` 只置请求；连接路径负责最终转移。
- `PtyKill` 在 Connecting 期间只调用 `TerminateJobObject`；不访问 `hShell`（此时可能尚未创建或尚未转移）。
- 如果 `TerminateJobObject` 在空 Job 上返回成功，`PtyConnect` 仍必须在 Resume 前看到 `abortRequested` 并失败；不能把空 Job 的终止成功当成“没有 shell 要处理”。
- **Connecting 临界区与无锁轮询分离：** `CreateProcessW` 之后，`IsProcessInJob` 和 accounting 查询使用栈上句柄无锁执行，间隙 `Sleep(50)` 绝不持有 baton mutex。这确保了 T2 发出的 `abortRequested` 能被立即设置并快速被 T1 感知。只有在 `ResumeThread` 成功后提交所有权时，T1 才持有短锁进行原子校验与句柄赋值。
- **锁外执行复合清理：** 锁内仅变更状态位与提取句柄；调用 `StopCreatedShellBounded` 或 `MarkConnectFailedAndCleanup` 必须在释放 baton mutex 之后执行，清理函数内部按需获取自身锁，杜绝死锁。
- **调度窗口如实保留：** `ResumeThread` 成功到 T1 获得提交锁之间存在不可避免的微秒级调度窗口，shell 可能执行极短用户代码。此风险如实记录，由 Resume 后立即整组终止且绝不回退 Active 兜底。
- `connectState` 只能由 `PtyConnect`/失败 guard 改变；`dispose`/`PtyKill` 只改请求位。

**G. 退出回调与 baton 删除竞态：**

```text
退出线程: drain -> publishFinalState -> enqueue hpc -> Post(onExit snapshot)
worker: ClosePseudoConsole 返回 -> update finalState.ptyDisposed=true -> maybeRemoveBaton
JS: onExit 到达 -> jobStatus()/event snapshot -> 可能此时 baton 已删除
```

- `publishFinalState` 必须发生在 `maybeRemoveBaton` 之前；`PtyFinalState` 由 cache、退出线程和 worker 共享，baton 删除后仍能更新。
- `onExit` 事件携带 shell 退出时的快照；最终 `treeState/drainedVerified` 由 `onJobState` 或共享的 `PtyFinalState` cache 提供。即使 `jobStatus()` 只看到 `gone`，JS 也应读取 cache 中的最终快照，而不是把 `onExit` 的中间态当最终值。JS 必须按状态等级合并，晚到的 `onExit` 不能把 `drained/unconfirmed` 回退成 `active/terminating`。
- `gone` 不是 `drained`；`gone` + 无终态快照只能按 `unconfirmed` 处理。
- 如果 worker 先完成、baton 被删除，退出线程仍持有 `shared_ptr<pty_baton>`，可以安全完成发布；不能因为 registry 删除就认为 baton 析构。

**H. `CloseHandle` 失败与状态发布竞态：**

- 关闭 `hJob` 失败时，退出线程/`dispose` 必须在 baton mutex 下置 `hJobCloseUnconfirmed=true`，然后发布 `treeState`：此前已 drained → `drained` + `drainedVerified=true` + `jobHandleClosed=false`；此前未 drained → `unconfirmed`。
- 其他线程看到 `CloseUnconfirmed` 后不得重试关闭，也不得把 `hJob` 当有效句柄查询 accounting；`jobStatus` 返回 `closeUnconfirmed=true`，由 UI 显示资源清理未确认。

**I. Node 环境销毁与 TSFN 无死锁生命周期（彻底打破循环等待）：**

```text
Node.js 环境开始销毁 (Worker/Main Teardown)
       ↓
Node-API 触发 napi_add_env_cleanup_hook 注册的清理入口 (主线程非阻塞执行)
       ↓
清理钩子标记 channel->envClosing=true 并 SetEvent(control->hStopEvent) (耗时 < 1ms)
       ↓
退出线程 WaitForMultipleObjects 立即唤醒，停止投递 JS 事件，调用 channel->ReleaseHolder() (引用 1 -> 0)
       ↓
Cleanup Worker 在执行 ClosePseudoConsole 期间持有 0 个 TSFN 引用，绝对不阻塞 Node teardown！
       ↓
所有 TSFN 持有者完成 Release (引用计数归零)，Node 事件循环排空队列
       ↓
Node-API 触发 TSFN finalizer 回调，受检关闭 control->hStopEvent，绝不死锁
       ↓
完全无死锁、无悬挂，安全释放 native 控制块
```

- **彻底消除 finalizer 循环等待死锁：** 严禁由 TSFN finalizer 来设置停止事件并等待退出线程！因为 TSFN finalizer 能够被调用的前提条件就是退出线程和 worker 已经先释放了 TSFN 引用。本设计严格由 Node-API 的 `napi_add_env_cleanup_hook` 主动发出停止信号，驱动退出线程释放 TSFN 引用，最终自然触发 finalizer。
- **Cleanup Worker 引用解耦与非阻塞保证：** Worker 执行 `ClosePseudoConsole` 期间持有 0 个 TSFN 引用，其可能发生的内核挂起彻底与 Node.js TSFN 生命周期解耦。Node teardown 无需等待 worker，finalizer 毫秒级触发并完成。
- **环境销毁后的强约束：** 环境清理钩子执行极简操作（耗时 0ms），严禁在钩子中调用长时间阻塞或 join 操作；环境销毁后绝对禁止继续访问 `napi_env`；退出线程和 worker 在 `channel->envClosing` 为 true 或收到 `napi_closing` 时绝对禁止再次使用 TSFN，更不得因通知失败调用 `Napi::Error::Fatal`；未完成的 Job 进程树由 OS 进程销毁时的 `KILL_ON_JOB_CLOSE` 强制兜底回收。

### 6.10 JS 管线

#### 6.10.1 原生事件通道、不可变快照与 Node-API 生命周期闭环

**现状 `[源码]`：** `conpty.cc:80-126` 的 `SetupExitCallback` 每个 PTY 创建一个 `Napi::ThreadSafeFunction`，`maxQueueSize=0`，退出线程 `WaitForSingleObject(hShell, INFINITE)`，随后 `CloseHandle(hShell)`、`remove_pty_baton(id)`，最后 `BlockingCall` 只把 `exitCode` 发给 JS；finalizer 直接 `th->join()`。这存在三个严重缺陷：

1. JS 收到 `onExit` 时 baton 已被删除，`jobStatus()` 只能得到 `gone`，无法读取最终 `drained/unconfirmed`。
2. `join` 一个 `INFINITE` 等待线程；Node 环境销毁时 finalizer 永久等待导致进程挂起死锁。
3. **上一轮致命缺陷（循环等待死锁）：** 若在 TSFN finalizer 中设置停止事件通知退出线程退出，而 Node-API 规定 TSFN finalizer 只有在所有持有的线程调用 `Release()` 且队列清空后才会被主线程调用——退出线程持有着 TSFN 引用等待 finalizer 发出停止信号，而 finalizer 等待退出线程释放 TSFN 引用，构成了 100% 的双向循环死锁！

**定稿设计：引入 Node-API 环境清理钩子（`Env::AddCleanupHook`）与独立的共享事件通道 `PtyEventChannel`：**

```cpp
struct ExitThreadControl {
  std::atomic<bool> stop{false};
  HANDLE hStopEvent = nullptr;   // CreateEventW(nullptr, TRUE, FALSE, nullptr)
};

class PtyEventChannel : public std::enable_shared_from_this<PtyEventChannel> {
public:
  Napi::ThreadSafeFunction tsfn;
  std::shared_ptr<ExitThreadControl> control;
  std::atomic<int32_t> holderCount{0};     // 活跃持有者计数（初始 1，归属退出线程）
  std::atomic<bool> envClosing{false};
  std::atomic<bool> hookRegistered{false}; // 环境清理钩子是否已注册
  napi_env env_ = nullptr;                 // 仅在主线程且有效时保存

  static void OnEnvCleanupHook(void* arg) NAPI_NOEXCEPT {
    auto* channel = static_cast<PtyEventChannel*>(arg);
    if (channel) {
      channel->NotifyEnvClosing();
    }
  }

  static void FinalizerCallback(napi_env env, void* finalizeData, void* finalizeHint) {
    auto* ch = static_cast<PtyEventChannel*>(finalizeData);
    if (!ch) return;
    // TSFN finalizer 触发时所有工作线程已释放 TSFN 引用；
    // 环境正在销毁，绝不在此访问 napi_env 或调用 napi_remove_env_cleanup_hook；
    // 仅受检回收原生句柄与控制块：
    if (ch->control && ch->control->hStopEvent) {
      CloseHandleChecked(ch->control->hStopEvent, "hStopEvent");
    }
  }

  static void DispatchJsEvent(Napi::Env env, Napi::Function jsCallback, PtyEvent* payload) {
    std::unique_ptr<PtyEvent> holder(payload); // RAII 自动释放 payload 内存，防泄漏
    if (!payload || env.IsUndefined() || env.IsNull()) return;
    // JS 回调只读取消费不可变快照 snapshot，绝不无锁读取正在更新的 finalState
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("id", Napi::Number::New(env, payload->snapshot.id));
    obj.Set("generation", Napi::Number::New(env, payload->snapshot.generation));
    obj.Set("type", Napi::Number::New(env, static_cast<int>(payload->type)));
    obj.Set("treeState", Napi::String::New(env, payload->snapshot.treeState ? payload->snapshot.treeState : "active"));
    obj.Set("shellExited", Napi::Boolean::New(env, payload->snapshot.shellExited));
    obj.Set("ptyDisposed", Napi::Boolean::New(env, payload->snapshot.ptyDisposed));
    obj.Set("terminateAccepted", Napi::Boolean::New(env, payload->snapshot.terminateAccepted));
    obj.Set("drainedVerified", Napi::Boolean::New(env, payload->snapshot.drainedVerified));
    obj.Set("activeProcesses", Napi::Number::New(env, payload->snapshot.activeProcesses));
    obj.Set("closeUnconfirmed", Napi::Boolean::New(env, payload->snapshot.jobCloseUnconfirmed || payload->snapshot.shellCloseUnconfirmed));
    if (payload->snapshot.exitKnown) {
      obj.Set("exitCode", Napi::Number::New(env, payload->snapshot.exitCode));
    }
    jsCallback.Call({ obj });
  }

  static std::shared_ptr<PtyEventChannel> Create(
      Napi::Env env, int id, uint64_t generation,
      const std::shared_ptr<pty_baton>& baton) {
    auto ch = std::make_shared<PtyEventChannel>();
    ch->control = std::make_shared<ExitThreadControl>();
    ch->control->hStopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    ch->holderCount.store(1, std::memory_order_relaxed); // 初始引用 1，唯一归属退出线程
    ch->env_ = env;

    // 1. 注册 Node-API 环境清理钩子（使用静态函数指针 + raw pointer，彻底消除强引用循环）
    napi_status hookSt = napi_add_env_cleanup_hook(env, OnEnvCleanupHook, ch.get());
    if (hookSt == napi_ok) {
      ch->hookRegistered.store(true, std::memory_order_release);
    }

    // 2. 创建 TSFN：配置真实的 maxQueueSize=64，初始线程数设为 1，非阻塞投递
    try {
      ch->tsfn = Napi::ThreadSafeFunction::New(
          env,
          Napi::Function::New(env, [](const Napi::CallbackInfo&) {}), // JS 转发分发器
          "PtyEventChannel",
          kEventQueueSize, // 64
          1,               // 初始持有线程数 1（由退出线程承接）
          ch.get(),
          FinalizerCallback,
          baton.get()
      );
    } catch (...) {
      // 构造异常回滚：撤销已注册的环境清理钩子
      if (ch->hookRegistered.exchange(false, std::memory_order_acq_rel)) {
        napi_remove_env_cleanup_hook(env, OnEnvCleanupHook, ch.get());
      }
      throw;
    }
    return ch;
  }

  // 正常销毁路径注销 Hook（仅在 JS 主线程且 env 有效时调用）
  void UnregisterCleanupHook(napi_env env) {
    if (hookRegistered.exchange(false, std::memory_order_acq_rel)) {
      if (env) {
        napi_remove_env_cleanup_hook(env, OnEnvCleanupHook, this);
      }
    }
  }

  // 非阻塞投递：分离快照与共享终态
  napi_status Post(const PtyEvent& event) {
    if (envClosing.load(std::memory_order_acquire))
      return napi_closing;
    auto* payload = new PtyEvent(event); // DispatchJsEvent 消费后 RAII delete
    napi_status status = tsfn.NonBlockingCall(payload, DispatchJsEvent);
    if (status != napi_ok) {
      delete payload; // 投递失败（如 napi_closing 或 napi_queue_full）立即安全释放
    }
    return status;
  }

  // 增加持有者：先校验底层 tsfn.Acquire() 成功返回 napi_ok，成功才增加本地计数
  bool AcquireHolder() {
    if (envClosing.load(std::memory_order_acquire)) {
      return false; // 环境正在关闭，拒绝新 Acquire
    }
    napi_status status = tsfn.Acquire();
    if (status != napi_ok) {
      // Acquire 失败（如 napi_closing），绝不增加本地计数，不留虚假持有记录
      return false;
    }
    holderCount.fetch_add(1, std::memory_order_release);
    return true;
  }

  // 释放持有者：使用 CAS 循环严格防御下溢，确保每个有效持有者恰好释放一次
  bool ReleaseHolder() {
    int32_t current = holderCount.load(std::memory_order_acquire);
    while (current > 0) {
      if (holderCount.compare_exchange_weak(current, current - 1,
                                            std::memory_order_acq_rel)) {
        tsfn.Release();
        return true;
      }
    }
    // 计数已 <= 0，拒绝重复 Release，防止底层计数下溢崩溃
    return false;
  }

  // 环境关闭通知：主线程同步非阻塞执行，耗时 0ms
  void NotifyEnvClosing() {
    // 标记已由 Node 触发清理，后续无需且严禁调用 napi_remove_env_cleanup_hook
    hookRegistered.store(false, std::memory_order_release);
    envClosing.store(true, std::memory_order_release);
    control->stop.store(true, std::memory_order_release);
    if (control->hStopEvent) {
      SetEvent(control->hStopEvent); // 唤醒退出线程
    }
  }

  bool IsClosing() const {
    return envClosing.load(std::memory_order_acquire);
  }
};
```

#### Node-API 生命周期与循环等待彻底消除证明

```text
Node.js 运行时开始退出 / Worker 终止 (Teardown 阶段)
       ↓
[步骤 1: 外部环境清理入口发出停止信号]
Node-API 主线程按 LIFO 顺序调用 napi_add_env_cleanup_hook 注册的钩子：
OnEnvCleanupHook() -> envClosing=true, control->stop=true, SetEvent(hStopEvent)
(耗时 0ms，绝不执行阻塞等待，绝不 join 线程，hookRegistered 置 false)
       ↓
[步骤 2: 原生工作线程响应信号并释放 TSFN 引用]
- 退出线程：WaitForMultipleObjects 立即收到 hStopEvent，停止新的 JS 通知，
  调用 channel->ReleaseHolder() 释放其持有的唯一定常 TSFN 引用 (计数 1 -> 0)，线程自然退出。
- Cleanup Worker：执行 ClosePseudoConsole 期间持有 0 个 TSFN 引用；若此时正在阻塞，
  绝对不阻止 Node teardown！若稍后返回，检查到 envClosing=true 直接跳过 JS 投递。
       ↓
[步骤 3: TSFN 触发与控制资源释放]
退出线程完成 Release，TSFN 内部 thread_count 归零，Node 事件循环排空底层队列。
       ↓
Node-API 在主线程触发 TSFN finalizer (FinalizerCallback)：
- 此时退出线程必然已经释放了 TSFN 引用并处于退出终点；
- 受检关闭 control->hStopEvent；
- 绝不调用已触发的 cleanup hook 移除操作；
- 释放 native 控制块内存。
```

- **数学证明无死锁：**
  - 旧时序依赖：`TSFN finalizer` → 触发停止事件 → `退出线程` 退出 → 释放 TSFN 引用 → `TSFN finalizer`（形成 ABBA 环形死锁）。
  - 新时序依赖：`Node Teardown Hook` → 触发停止事件 → `退出线程` 退出并调用 `tsfn.Release()` → `TSFN finalizer` 执行并回收原生对象。
  - **依赖关系为严格单向拓扑排序，环路被彻底打破，证明不存在任何循环等待！**
- **三大路径清晰隔离：**
  1. **正常销毁路径**：终端会话在 Node 运行期间被显式关闭；JS 主线程调用 `channel->UnregisterCleanupHook(env)` 注销 hook，退出线程正常 drain 完毕后 `ReleaseHolder()`；
  2. **异常构造路径**：`PtyConnect` 期间若 TSFN 创建抛异常，catch 块立即调用 `napi_remove_env_cleanup_hook` 回滚，防止悬挂 hook 触发访问非法对象；
  3. **环境 teardown 路径**：Node 销毁触发 `OnEnvCleanupHook`，Node 自动将其从队列除名；finalizer 绝不再碰 env，绝不再调用 remove hook。
- **严禁事项：**
  - 环境清理入口（Cleanup Hook）绝不能执行长时间阻塞或 join 操作。
  - 不允许 finalizer 等待一个无限等待的线程。
  - 环境销毁后绝不访问已失效的 `napi_env`。
  - 在 `napi_closing` 或 `envClosing=true` 之后绝对禁止继续调用 TSFN。
  - 严禁在事件投递失败（如 `napi_queue_full`）时调用 `Napi::Error::Fatal` 触发进程崩溃；事件若丢失，由 JS 端终态对账和 cache 机制补查。
  - 每个 TSFN 使用者通过 `ReleaseHolder()` CAS 机制确保恰好释放一次引用，严防下溢。
- 事件队列容量配置：传入 `ThreadSafeFunction::New` 的参数 `maxQueueSize=64`，由 Node-API 底层严格约束原生队列容量。
- 终态缓存固定 64 项、TTL 10 分钟；缓存满按最旧淘汰。即使 baton 已被删除，终态缓存仍可响应随后的 `jobStatus()` 查询。
- **缓存删除时机：** TTL 到期或容量淘汰是默认路径；`onPtyDisposed` 到达后**不立即**删除，因为晚到的 `jobStatus()`/UI 仍可能读取。只有 JS 已消费终态并把 session 从 ledger 删除、且没有未完成的 `status` 等待者时，才允许 `forgetFinalState(id)` 提前释放；即使不调用，TTL 也保证不会永久增长。删除后 `jobStatus` 返回 `gone/final:false`，JS 按 `unconfirmed` 处理。

`src/index.ts`：

```ts
// 布尔属性，不是函数：调用方统一写 `if (!nodePty.supportsJobObject)`。
export const supportsJobObject: boolean = (() => {
  if (process.platform !== 'win32') return false;
  try {
    const native = loadNativeModule('conpty').module;
    return native?.supportsJobObject === true;
  } catch {
    return false;
  }
})();
```

- 必须读**实际加载的 conpty 二进制**，不能在 JS 里写死 `true`。
- 旧 JS + 新 native：旧 JS 无此导出 → backend 预检失败；新 JS + 旧 native：native 无此属性 → false；两者都旧 → false。这样打包错配在 shell 前被拒绝。

`WindowsPtyAgent`：

- 构造前检查 `useJobObject` 与 `this._ptyNative.supportsJobObject`，false 则抛 `pty_job_unavailable`，**不调用 `startProcess`**。
- `startProcess` 返回后立即保存 `_pty`；用 `try/catch` 包住 socket/connect；异常时 `native.dispose(_pty)` 并 rethrow。
- `killJob()` 返回 native `kill` 的 `JobControlResult`；`kill()` 在 Job 模式委托；不再调用 `_getConsoleProcessList`/`process.kill`。`killJob` 抛异常时返回 `{ requested:true, terminateAccepted:false, treeState:'unconfirmed', error:'kill_exception' }`，绝不回退 PID 路径。
- `abortJob()` 调用 native `abortJob(id)`；返回同一 `JobControlResult`，用于 invariant/构造失败/防御性清理。它不能调用 `process.kill` 或 `taskkill`。
- `dispose()` 调用 native dispose；返回 `{disposed,queued,retry,connecting}`。
- `jobStatus()` 调用 native `status(id)`；返回 `{present,gone,final,jobMode,jobAssigned,jobState,treeState,terminateAccepted,drainedVerified,shellExited,ptyDisposed,activeProcesses,closeUnconfirmed,resourceCloseUnconfirmed,startupQuarantine,disposeRequested,disposed,queued,error}`。**`onExit` 到达时 JS 必须读取事件快照，并可按需再查一次 `jobStatus()`**；不能依赖 `onJobState` 一定在监听器注册前/后到达。
- `status(id)` 找不到 baton 时先查 `PtyFinalState` cache：有快照则返回 `{present:false, gone:true, final:true, treeState:<snapshot>, drainedVerified:<snapshot>, terminateAccepted:<snapshot>, jobState:<snapshot>, shellExited:<snapshot>, ptyDisposed:<snapshot>, activeProcesses:<snapshot>, closeUnconfirmed:<snapshot.jobCloseUnconfirmed||snapshot.shellCloseUnconfirmed>, resourceCloseUnconfirmed:<snapshot.resourceCloseUnconfirmed>}`；无快照才返回 `{gone:true, final:false, treeState:'gone', drainedVerified:false}`。**`gone` 只表示 registry/cache 没有可读对象，不等于 drained。**
- `jobObject` getter 返回 native `jobAssigned`；`onJobState`/`onPtyDisposed` 事件转发 native 回调。
- **`onExit` 事件载荷扩展为 `{ exitCode, signal, jobMode, jobAssigned, shellExited, treeState, drainedVerified, activeProcesses, jobState, ptyDisposed, closeUnconfirmed, error }`。** `_$onProcessExit(event)` 不再只接收数字；保留 `exitCode` 兼容 node-pty 的 `IPty.onExit` 形状。
- Job 模式下 `_$onProcessExit` **不能立即 `_cleanUpProcess`/销毁 output socket**：`ClosePseudoConsole` 可能等待输出管道被 drain，提前停止读取会让清理 worker 卡住。`onExit` 只发退出事件；output socket/conout worker 保留到 `onPtyDisposed`（或硬退出兜底）。
- `onPtyDisposed` 载荷 `{id,generation,closeReturned}`；`closeReturned=false`/缺失时不能置 `ptyDisposed=true`。
- **`onPtyDisposed` 到达时做一次终态对账。** `onExit`/`onJobState` 都可能因队列满或 env teardown 未送达；`onPtyDisposed` 是最后一个本地事件。JS 收到后若 `treeState` 还不是 `drained/unconfirmed`，必须调用一次 `jobStatus()` 并合并结果：`final:true` 采用快照；`gone/final:false`（cache 过期或从未发布）时，因 `ptyDisposed=true` 且已无可读状态，按 `treeState='unconfirmed'` 结束。这只是“无法再观察”的映射，不是把 `gone` 当 `drained`，也不允许会话无限停在 `closing`。

`WindowsTerminal`：

- `IWindowsPtyForkOptions` 增加 `useJobObject?: boolean`，构造函数原样传给 `WindowsPtyAgent`；默认 false，仅 backend 显式开启。
- `kill()` Job 模式直接 `this._agent.kill()`，**不 `_deferNoArgs`、不 `_close()`**；保持读取，等 flush/exit。
- `killJob()` 透传；`abortJob()` 透传；`dispose()` 透传；`jobStatus()` 透传；`jobObject` getter 透传；`onJobState`/`onPtyDisposed` 透传。
- `typings/node-pty.d.ts` 增加 `IJobControlResult`、`IJobStatus`、`abortJob(): IJobControlResult`、`killJob(): IJobControlResult`、`useJobObject?: boolean`，以及 `IExitEvent` 的可选 Job 字段；不能只在 JS 层 `any` 透传。
- 构造阶段 `new WindowsPtyAgent` 之后的代码用 try/catch；异常时 `agent.abortJob()`（Job 模式）或 `agent.dispose()`（非 Job 旧路径）并 rethrow；不得调用 `agent.kill()` 触发 PID 路径。
- Job 模式下 `_close()` 也延迟到 `onPtyDisposed`；`_close` 会把 socket 设为不可读，可能让 `ClosePseudoConsole` 等不到 drain。
- `destroy()` 走 kill；如果进程不退出，后端有界重试；Job 模式 socket close 最终由 `onPtyDisposed` 驱动。

`server/terminal-process.js`：

```js
export function defaultSpawnPty(...) {
  const nodePty = loadNodePty();
  if (platform === 'win32') {
    if (nodePty.supportsJobObject !== true) {
      throw Object.assign(new Error('job object unsupported'), { code: 'pty_job_unavailable' });
    }
    options.useConpty = true;
    options.useJobObject = true;
  }
  const pty = nodePty.spawn(file, args, options);
  if (platform === 'win32' && (pty.jobObject !== true
      || typeof pty.killJob !== 'function'
      || typeof pty.abortJob !== 'function'
      || typeof pty.dispose !== 'function')) {
    // 不应到达：native 在创建 shell 前已要求 Job；这是 fatal invariant。
    // 不调用 defaultKillPty/P3-B，不 PID kill。
    try { pty.abortJob?.(); } catch {}
    throw Object.assign(new Error('job invariant violated'), { code: 'pty_job_invariant' });
  }
  if (platform === 'win32') defaultWindowsKillGate.capture(pty, file, { env }); // 诊断/legacy
  return pty;
}

export function defaultAbortPty(pty, platform = process.platform) {
  if (!pty || platform !== 'win32' || pty.jobObject !== true) return undefined;
  return pty.abortJob();   // Job 模式唯一防御接口；不触碰 PID
}

export function defaultKillPty(pty, platform = process.platform) {
  if (!pty) return undefined;
  if (platform === 'win32' && pty.jobObject === true) {
    const outcome = pty.killJob();   // JobControlResult
    if (!outcome) {
      return { job: true, treeState: 'unconfirmed', terminateAccepted: false,
               drainedVerified: false, reason: 'no_job_result' };
    }
    // Job 模式彻底废除 legacy 的 result: 'killed' 语义，返回专用的 JobControl 结果结构
    switch (outcome.treeState) {
      case 'drained':
        return { job: true, treeState: 'drained',
                 terminateAccepted: outcome.terminateAccepted === true,
                 drainedVerified: true,
                 jobHandleClosed: outcome.jobHandleClosed === true,
                 closeUnconfirmed: outcome.closeUnconfirmed === true,
                 fallbackUsed: outcome.fallbackUsed === true };
      case 'terminating':
      case 'draining':
        return { job: true, treeState: outcome.treeState,
                 terminateAccepted: outcome.terminateAccepted === true,
                 drainedVerified: false,
                 closeUnconfirmed: outcome.closeUnconfirmed === true,
                 fallbackUsed: outcome.fallbackUsed === true };
      case 'unconfirmed':
        return { job: true, treeState: 'unconfirmed',
                 terminateAccepted: outcome.terminateAccepted === true,
                 drainedVerified: false,
                 closeUnconfirmed: outcome.closeUnconfirmed === true,
                 fallbackUsed: outcome.fallbackUsed === true,
                 reason: 'tree_unconfirmed' };
      case 'gone':
        return { job: true, treeState: 'gone',
                 terminateAccepted: false,
                 drainedVerified: false,
                 reason: 'baton_or_cache_gone' };
      case 'not_job_mode':
        return { job: true, treeState: 'unconfirmed',
                 terminateAccepted: false,
                 drainedVerified: false,
                 code: 'job_mode_required' };
      default:
        return { job: true, treeState: 'unconfirmed',
                 terminateAccepted: false,
                 drainedVerified: false,
                 reason: outcome.error || 'invalid_job_result' };
    }
  }
  if (platform === 'win32') return defaultWindowsKillGate.kill(pty); // legacy only
  try { pty.kill(); } catch {}
  return undefined;
}
```

`server/terminal.js` 的 `attemptKill` 必须把 Job 结果放在 legacy `KILL_STOP_RESULTS` 之前判断：

```js
function applyKillOutcome(session, result) {
  // 1. Job 模式优先分支：只通过 job=true、treeState、terminateAccepted 和 drainedVerified 判断
  if (result?.job === true) {
    if (result.treeState === 'drained') {
      session.treeState = 'drained';
      session.drainedVerified = result.drainedVerified === true;
      session.killState = 'pending';   // 仍等待 shellExited 与 ptyDisposed，绝不直接 exited
      return true;
    }
    if (result.treeState === 'terminating' || result.treeState === 'draining') {
      session.treeState = result.treeState;
      session.killState = 'pending';   // native 正在 drain；不重试、不标 unconfirmed
      return true;
    }
    if (result.treeState === 'unconfirmed') {
      session.treeState = 'unconfirmed';
      markKillUnconfirmed(session);    // 保持 closing，直到 ptyDisposed
      return true;
    }
    if (result.treeState === 'gone') {
      // registry 无 baton 且无终态快照：只能按 unconfirmed 处理，绝不映射为成功或 drained
      session.treeState = 'unconfirmed';
      markKillUnconfirmed(session);
      return true;
    }
    return false;
  }

  // 2. 仅在非 Job 模式（legacy 传统模式）下才允许回落到 KILL_STOP_RESULTS 集合判定
  if (KILL_STOP_RESULTS.has(result?.result)) {
    markKillUnconfirmed(session);
    return true;
  }
  return false;
}
```

- `pty.jobObject` 为 false 时**不**调用 `defaultKillPty`；旧二进制应在预检被拒。
- **KILL_STOP_RESULTS 继续只服务 legacy 路径：** `KILL_STOP_RESULTS`（包含 legacy 的 `gone/mismatch/unknown`）纯粹服务历史 PID 模式，绝不参与 Job 模式的状态判定。Job 结果先由 `result?.job === true` 拦截并完全按 `treeState` 分支处理，彻底消除了旧代码将 Job 模式的 `terminating/draining` 误入 `KILL_STOP_RESULTS` 的可能。
- **Job 模式彻底废除 `result: 'killed'` 语义：** Job 模式不再返回容易引起误解的 legacy `killed` 语义，改用独立的专属结果结构。Job 模式绝对禁止通过单独读取 `result` 判断进程树是否退出；`terminateAccepted` 仅代表终止请求已被操作系统内核接受；`terminating/draining` 严禁映射为清理完成；`drained` 必须同时具备 `drainedVerified=true`；`unconfirmed/gone` 绝对不得映射为成功；现有 legacy 终止重试机制不受任何破坏。
- `unconfirmed` 在 Job 模式下直接通过 `treeState='unconfirmed'` 表达（由 `markKillUnconfirmed(session)` 停止重试并保持 `closing`，绝不伪装为成功，直到 `ptyDisposed` 后结束）；不再借道 legacy 的 `unknown` 状态或 `KILL_STOP_RESULTS`。
- **`abortJob` 接口完整性：**
  - native：`init()` 导出 `abortJob(id)`，返回 `JobControlResult`；内部复用 `RequestJobTerminationLocked`，只按 `hJob`/`hProcess`（启动清理）操作，绝不按 PID。
  - node-pty JS：`WindowsPtyAgent.abortJob()`、`WindowsTerminal.abortJob()`、`typings` 的 `abortJob(): IJobControlResult`。
  - backend：`defaultSpawnPty` 的 invariant 分支调用 `defaultAbortPty`；`server/terminal.js` 的构造失败/关闭兜底调用它，不调用 `process.kill`。
  - 幂等：baton 已删除时返回 `treeState=gone` 或 cache 的终态；重复调用不重复终止、不重复关闭。
  - 失败返回：`{requested:true, terminateAccepted:false, treeState:'unconfirmed', error}`；不抛异常掩盖失败（参数非法除外）。
  - 如果 native 没有 `abortJob`，backend 记录 fatal invariant，不 PID kill；旧二进制应在 capability 预检被拒。
- P3-B 的 `capture` 保留，但 Job 模式 kill 不使用它；P3-B 仍是 legacy/backend 进程路径。

### 6.11 错误码

| 错误码 | 含义 | 会话处理 |
| --- | --- | --- |
| `pty_job_unavailable` | 预检：实际二进制无 Job 能力 | 503，不创建 shell |
| `pty_job_invariant` | 预检通过但 `jobObject` 不为 true（不可达） | fatal，不 PID kill；拒绝继续 |
| `job_create_failed` | `CreateJobObjectW` 失败 | 503 |
| `job_set_limit_failed` | `SetInformationJobObject` 失败 | 503 |
| `job_limit_unverified` | 查询不到 `KILL_ON_JOB_CLOSE` | 503 |
| `job_attribute_failed` | `UpdateProcThreadAttribute(JOB_LIST)` 失败 | 503 |
| `job_assign_failed` | `IsProcessInJob` 失败/false | 503；shell 已按句柄终止 |
| `job_accounting_failed` | resume 前 `ActiveProcesses<1` | 503；shell 已按句柄终止 |
| `job_resume_failed` | `ResumeThread` 失败 | 503；shell 已按句柄终止 |
| `pty_event_channel_failed` | `CreateExitChannel`/TSFN 创建失败 | 503；不创建 shell |
| `pty_exit_thread_failed` | shell 已创建/Resume 后 `StartExitThread` 失败 | 503；Job 整组终止 + 受检关闭或 quarantine；不返回 success |
| `pty_connect_busy` | 并发/重入 `PtyConnect` | 503；不创建第二个 shell |
| `pty_aborted` | Connecting 期间收到 kill/dispose | 503/取消；不 Resume，按 Job 清理 |
| `pty_startup_cleanup_busy` | startup quarantine 已满 | 503 新终端；不丢 HANDLE |
| `job_terminate_failed` | `TerminateJobObject` 失败 | kill 返回 `terminateAccepted=false`、`fallbackUsed=true`、`treeState=unconfirmed`；会话 `killUnconfirmed` |
| `job_close_failed` | 关 `hJob` 兜底失败 | `hJobCloseUnconfirmed=true`、`treeState=unconfirmed`；不重试 |
| `job_drain_timeout` | drain 超时 | `killUnconfirmed`，保持 closing |
| `job_shell_wait_failed` | 退出线程 `WaitForMultipleObjects` 返回 `WAIT_FAILED`（500ms 的 `WAIT_TIMEOUT` 只是继续等待） | 不发 `onExit`；`treeState=unconfirmed`，保持 closing；hJob 受检关闭，hShell 复核后才关闭 |
| `job_shell_close_unconfirmed` | `CloseHandle(hShell)` 失败 | `shellCloseUnconfirmed=true`；drain 结果可保留，但不能显示完全清理 |
| `job_handle_missing` | Job 模式但 hJob 为空 | `killUnconfirmed` |
| `job_startup_cleanup_unconfirmed` | 启动失败后 shell 未确认退出，已进入 quarantine | 503；新终端受容量限制 |
| `job_startup_quarantine` | `hJob/hProcess` 已由 startup quarantine 持有 | `PtyKill`/`abortJob` 返回 `treeState=unconfirmed`；不竞争关闭；由隔离区继续 |
| `job_event_delivery_pending` | TSFN 队列满，终态只在 cache | 诊断；JS 必须查 `jobStatus()` 快照 |
| `pty_cleanup_busy` | 清理容量预约耗尽（队列/worker 阻塞） | 503 新终端；已有会话保持 closing |
| `pty_dispose_pending` | dispose 已请求但未完成 | 保持 cleanupPending 重试 |
| `pty_disposed` | `ClosePseudoConsole` 调用已返回（`void`，不代表 conhost 已退出） | 可移除会话，但 `treeState` 仍可为 `unconfirmed` |

错误信息只带稳定码和 `GetLastError()` 数字；不带命令行、env、完整 PID 列表。

---

## 7. Job 生命周期状态机

### 7.1 原生 Job 状态

```text
JobMode::None  ->  JobState::None
JobMode::Required:
  [None] --PtyStartProcess 创建 Job/baton--> [Connecting] (shell 尚未创建)
  [Connecting] --PtyConnect 开始--> [Connecting] (同一状态，不重复)
  [Connecting] --resume 成功, shell 所有权转移--> [Active]
  [Connecting] --创建/绑定失败, 无 shell, 两次 ActiveProcesses==0, 关闭成功--> [Closed] (drainedVerified=true)
  [Connecting] --创建/绑定失败, 无 shell, 查询/关闭失败--> [Unconfirmed]
  [Connecting] --创建后失败, shell 已确认退出但未做两次零查询--> [Unconfirmed] (未 drain)
  [Connecting] --创建后失败, shell 未确认退出--> [Unconfirmed] (startup quarantine)
  [Connecting] --PtyKill/dispose, TerminateJobObject 成功--> [Terminating]
  [Connecting] --PtyKill/dispose, TerminateJobObject 失败--> [Connecting] (abortRequested; 不关 hJob，交连接路径/dispose 清理)
  [Terminating] --connect abort，无 shell/空 Job--> [Closed] (drainedVerified=true) / [Unconfirmed]
  [Terminating] --connect abort，shell 已创建未确认退出--> [Unconfirmed] (quarantine)
  [Active] --PtyKill/abortJob/dispose--> [Terminating]
  [Active] --shell exit, hJob 有效--> [Draining] (先尝试 TerminateJobObject；失败仍只能 drain，不得声称已终止)
  [Terminating] --shell exit, hJob 有效--> [Draining]
  [Draining] --active==0 twice--> [Drained]
  [Draining] --timeout/query fail, CloseHandle 成功--> [ClosingUnverified]
  [Draining] --timeout/query fail, CloseHandle 失败--> [Unconfirmed]
  [Active/Terminating] --WaitForSingleObject WAIT_FAILED, TerminateJobObject 后 hJob 关闭成功--> [ClosingUnverified]
  [Active/Terminating] --WaitForSingleObject WAIT_FAILED, hJob 关闭失败--> [Unconfirmed]
  [Active] --TerminateJobObject fail, CloseHandle ok--> [ClosingUnverified]
  [Active] --TerminateJobObject fail, CloseHandle fail--> [Unconfirmed]
  [Drained] --close hJob 成功--> [Closed] (drainedVerified=true)
  [Drained] --close hJob 失败--> [Drained] (drainedVerified=true, hJobCloseUnconfirmed=true)
  [ClosingUnverified] --shell exit--> [Closed] (drainedVerified=false)
  [Unconfirmed] --hJob 已关或无法查询--> [Unconfirmed] (终态，不升级为 drained)
```

- `Drained` 只能在 `hJob` 仍有效时由连续两次 `ActiveProcesses==0` 证明；进入 `Drained` 时置 `drainedVerified=true`。
- `Terminating` 只表示 `TerminateJobObject` 请求已接受；不是终态，也不是 `Drained`。`PtyKill` 在 `Connecting` 期间成功后必须进入 `Terminating`，不能因为 `connectInProgress` 留在 `Connecting`；连接路径靠 `abortRequested/connectState` 判断，不靠 `jobState` 判断。
- `status` 对 `Connecting` 的 `treeState` 映射：`terminateAccepted ? 'terminating' : (abortRequested ? 'unconfirmed' : 'active')`。`PtyKill` 在 Connecting 失败但未关闭 hJob 时返回 `unconfirmed`，后续 `status` 必须一致，不能又显示 `active`。
- `Closed` 不等于 `Drained`；`Closed` 可能是 `ClosingUnverified` 的结果。`PtyKill`/`status` 必须返回 `drainedVerified`，不能只看 `jobState==Closed`。
- `Drained` + `CloseHandle(hJob)` 失败仍停留在 `Drained`，并带 `hJobCloseUnconfirmed=true`；不能为了得到 `Closed` 而重试关闭。
- `Unconfirmed` 是终态之一；后端必须保留 `killUnconfirmed`。`Connecting` 期间收到 kill/dispose 后，`PtyConnect` 必须在 Resume 前和 Resume 后转移所有权前都检查 abort；状态不能回退到 `Active`。

### 7.2 JS 会话状态（会话生命周期与资源清理状态彻底解耦）

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `state` | `creating/running/closing/exited/error` | 用户可见的会话生命周期（逻辑交互维度） |
| `shellExited` | bool | native `onExit` 已到达且 `shellExited=true`；`WAIT_FAILED` 不置位 |
| `treeState` | `active/terminating/draining/drained/unconfirmed/gone` | Job 树状态；`gone` 只表示无 baton/cache，绝不等于 drained |
| `drainedVerified` | bool | 仅由 native 的连续两次 `ActiveProcesses==0` 置位 |
| `ptyDisposed` | bool | 清理 worker 的 `ClosePseudoConsole` 调用已返回；不代表 conhost 退出 |
| `killState` | `none/pending/unconfirmed/exited` | 终止重试状态；`pending` 覆盖 native 正在 `terminating/draining` |
| `cleanupPending` | bool | `ptyDisposed=false` 或 `dispose` 返回 retry；会话必须保留在 ledger，绝不丢失 |
| `sessionExited` | 派生布尔 | `shellExited && ptyDisposed && treeState∈{drained,unconfirmed}`；仅代表用户会话逻辑交互结束 |
| `cleanupState` | `fullyCleaned`<br>`cleanedWithWarning`<br>`cleanupUnconfirmed`<br>`cleanupPending` | **底层原生资源清理状态（与 sessionExited 正交，决定 UI 诊断呈现）** |

规则：

1. `onExit` 只设 `shellExited=true`、`exitCode` 和事件快照中的 `treeState`；Job 模式不直接设 `state=exited`，也不立即 `disposeSessionHandles`。`treeState` 按 `active < terminating < draining < drained/unconfirmed` 单调推进；`onExit` 的不可变快照不得覆盖已经到达的 `draining/drained/unconfirmed`。
2. `onJobState(drained)` 或事件/`jobStatus()` 的 `drainedVerified===true` 更新 `treeState=drained`；`onJobState(unconfirmed)` 更新 `treeState=unconfirmed`。两者都不能单独把 `state` 设为 `exited`。
3. **会话结束与清理状态解耦：** `sessionExited` 仅表示用户会话逻辑结束；而资源是否完全清理成功，必须由独立的 `cleanupState` 判定：
   - 进程树已确认清空（`drainedVerified=true`）且 PTY 已释放（`ptyDisposed=true`），并不代表所有底层 HANDLE 都已正常释放；
   - 若存在 `hJobCloseUnconfirmed`、`shellCloseUnconfirmed` 或 `resourceCloseUnconfirmed`，会话即使 `sessionExited=true`，其 `cleanupState` 也只能是 `cleanedWithWarning`，绝不能显示为完全清理；
   - 若 `treeState=unconfirmed`，`cleanupState` 为 `cleanupUnconfirmed`，UI 显示警告。
4. `stopSession` 在 Job 模式最多等待 `kill 5s + drain/ptyDispose 5s`（10s）；超时后 `killUnconfirmed`，`state` 保持 `closing`，直到 `ptyDisposed` 或 hard shutdown。发起 kill 后立即调用 `pty.dispose()`，让 hpc 清理与 Job 终止并行。
5. `close` 对 `exited` 的会话先调用 `pty.dispose()`；未 disposed 时保留在 `cleanupPending`，不提前删除。`state=exited` 且 `treeState=unconfirmed` 的会话仍保留清理记录，不能按“无资源”删除。
6. `publicSession` 不暴露 PID；暴露 `treeState/drainedVerified/ptyDisposed/cleanupPending/cleanupState`，让 UI 严格区分四态。
7. `onExit` 事件携带不可变快照，JS 可以直接采用；`jobStatus()` 只作为晚到/丢事件时的补查。`gone` 没有 `drainedVerified:true` 或 cache 快照时按 `unconfirmed` 处理。

```js
function maybeFinishSession(session) {
  if (FINISHED_STATES.has(session.state)) return;
  if (session.jobMode !== 'required') {
    // legacy 路径保持原语义：shell 退出即 exited
    finishSession(session);
    return;
  }
  if (!session.shellExited) { session.state = 'closing'; return; }
  if (!session.ptyDisposed) { session.state = 'closing'; return; }
  if (!['drained', 'unconfirmed'].includes(session.treeState)) {
    session.state = 'closing';
    return;
  }

  // 1. 逻辑会话结束（达到 sessionExited 条件）
  session.drainedVerified = session.treeState === 'drained';

  // 2. 独立计算资源清理终态 cleanupState
  if (session.treeState === 'unconfirmed' || session.treeState === 'gone' || !session.drainedVerified) {
    session.cleanupState = 'cleanupUnconfirmed';
  } else if (session.closeUnconfirmed === true || session.resourceCloseUnconfirmed === true) {
    session.cleanupState = 'cleanedWithWarning';
  } else {
    session.cleanupState = 'fullyCleaned';
  }

  // 3. 提交状态变更：此后才允许释放 output socket 与 session 辅助句柄
  finishSession(session); // session.state = 'exited'; session.killState = 'exited'
}
```

- `handleExit` 只设置 `shellExited/exitCode/treeState`，然后调用 `maybeFinishSession`。不能在这里调用 `disposeSessionHandles`，否则会提前停止读取 output，`ClosePseudoConsole` 可能无法 drain。
- `onJobState`/`onPtyDisposed` 都调用 `maybeFinishSession`；只有最后一个条件满足时才真正结束会话。
- `treeState=gone` 不满足 `{drained,unconfirmed}`，所以保持 `closing`；`onPtyDisposed` 触发的终态对账若仍拿不到快照，按 `treeState='unconfirmed'` 结束，不能无限停在 `closing`，也不能把 `gone` 当成 `drained`。

### 7.3 `TerminateJobObject` 与 `KILL_ON_JOB_CLOSE` 的先后

| 步骤 | 做法 | 能否验证 ActiveProcesses | 结论 |
| --- | --- | --- | --- |
| 正常停止 | `TerminateJobObject` 返回非零，保持 hJob 打开 | 能 | **只进入 `Terminating`**；轮询到连续两次 0 → `Drained`；超时 → `Unconfirmed` |
| `TerminateJobObject` 成功但进程尚未退出 | 不关 hJob，继续轮询 | 能 | 仍是 `Terminating/Draining`，不是 `Drained`；不得发 `exited` |
| Shell 自然退出 | 保持 hJob，先关闭 hShell，再查 ActiveProcesses；>0 则 `TerminateJobObject` | 能（只要 hJob 未关） | 连续两次 0 → `Drained`；超时 → `Unconfirmed` |
| `TerminateJobObject` 失败（Active） | 关 hJob 触发 `KILL_ON_JOB_CLOSE` | **不能**（句柄已关） | `ClosingUnverified`；不声称 drained |
| `TerminateJobObject` 失败（Connecting） | 不关 hJob，只置 `abortRequested` | 仍可查询，但连接路径正在使用 | `unconfirmed`；由 connect/dispose 清理 |
| `CloseHandle(hJob)` 失败 | 保留 HANDLE，置 `hJobCloseUnconfirmed` | 不能继续安全查询 | 已 drained → 保持 `Drained` + `drainedVerified=true`；未 drained → `Unconfirmed` |
| hJob 已关闭 | 只能等 shell exit/超时 | 不能 | `Unconfirmed` |
| 清理容量/预约耗尽 | 保留 hpc，拒绝新终端 | 不影响 Job 状态 | `disposePending`，不是 disposed |

**状态词统一表（native / node-pty JS / backend 同一含义，彻底统一）：**

| 词 | native | node-pty JS | backend/session | 禁止的推断 |
| --- | --- | --- | --- | --- |
| `terminateAccepted` | 仅 `TerminateJobObject` 返回非零 | `killJob()/abortJob()` 字段 | `killState=pending`，继续等 drain | 进程树已退出；已清理完成 |
| `drainedVerified` | 两次成功 `ActiveProcesses==0` | `treeState=drained` + `drainedVerified` | 结合句柄状态评估 `fullyCleaned`；仍需 `ptyDisposed` | 系统级无残留；句柄已无泄漏 |
| `fallbackUsed` | `TerminateJobObject` 失败后关闭 hJob | `treeState=unconfirmed` | `killUnconfirmed`，保持 closing | 已 drained；清理成功 |
| `unconfirmed` | 无法验证的终态 | `treeState=unconfirmed` | `cleanupState=cleanupUnconfirmed`，标清理未确认 | 清理完成；全绿 |
| `gone` | registry 无 baton 且 cache 无快照 | `treeState=gone` | 按 `unconfirmed` 处理 | drained/清理完成 |
| `killed` | **严禁用于 Job 模式** | **仅 legacy `kill()` 结果** | **仅用于 legacy 兼容** | **Job 模式严禁使用或返回 `killed`！** |

**明确缺口：** 一旦关闭最后一个 `hJob` 句柄，就无法再 `QueryInformationJobObject`。因此 `KILL_ON_JOB_CLOSE` 兜底只能算“终止已发起”，不能算“已确认清空”。设计不把这两件事写成同一件事。

**`TerminateJobObject` 返回语义：** 微软文档对返回值的定义是“成功非零/失败零”，并说明其效果“如同对每个进程调用 `TerminateProcess`”；`TerminateProcess` 文档明确该调用是异步的，必须 `WaitForSingleObject` 才能确认退出。文档没有明确保证 `TerminateJobObject` 返回时所有进程已经退出。因此本设计采取更保守的语义：

- native 的 `terminateAccepted=true` 只表示终止请求已被接受；
- `treeState` 在收到 drain 证明前只能是 `terminating`/`draining`；
- **Job 模式完全废除 `result: 'killed'`，绝对禁止单独读取 `result` 判断进程退出；**
- `drainedVerified=true` 只能来自连续两次 `ActiveProcesses==0`，不能来自 `TerminateJobObject` 返回值。

### 7.4 嵌套 Job 与 accounting 的准确边界

- 官方 **Nested Jobs** 文档明确：嵌套 Job 的资源会计描述“与该 Job 关联的每个进程，包括子 Job 中的进程”；父 Job 代表其自身及所有子 Job 的聚合使用量。`[文档]`
- 官方 **Job Objects** 文档明确：嵌套时每个子 Job 的 accounting 聚合到父 Job；`TerminateJobObject` 终止当前 Job 及所有子 Job。`[文档]`
- 因此本设计**依据官方聚合语义**把子 Job 进程计入 `ActiveProcesses`；但 `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.ActiveProcesses` 的结构页只写“当前与 Job 关联的进程数”，没有再次展开嵌套；目标 Windows 上的实际计数仍要求 C0 实测，不能用一次经验当保证。`[文档]` + `[C0]`
- `ActiveProcesses` 的递减条件是“进程退出且所有引用释放”，本进程持有的 `hShell` 句柄可能延后递减；所以 drain 前先按受检方式关闭 `hShell`。如果 `CloseHandle(hShell)` 失败且计数不降，超时后只能 `Unconfirmed`，不能解释成“后代仍活着”或“已清空”。`[文档]`
- 明确不在保证内的进程：
  - WMI `Win32_Process.Create` 创建的进程：官方明确不随父进程加入 Job `[文档]`；
  - 服务、计划任务、UAC/AppInfo 等由另一个进程代为创建的进程：官方没有把它们定义为该 Job 的成员；只能记录为边界，C0 观察；
  - 显式 breakaway；本设计不设置 `BREAKAWAY_OK`/`SILENT_BREAKAWAY_OK`，但外部 Job 层级和进程行为仍可能影响；
  - conhost/OpenConsole：不是 shell 后代，生命周期由 `HPCON` 控制；
  - 与 Job 关联失败的进程。
- **`Drained` 的准确含义：** 在 `hJob` 仍有效时，连续两次成功查询 `ActiveProcesses==0`，且此前已尝试关闭 `hShell`；结合官方聚合语义，它表示当前 Job 及其子 Job 的 accounting 归零。它**不**表示整棵 Windows 进程树为空，也不覆盖上述 Job 外进程，更不是安全沙箱证明。
- 这是 P3-C 的明确保证边界，必须在验收文档、UI 文案和日志中如实写出；不能把 `Drained` 宣传成“系统级无残留”。

### 7.5 UI 语义与四阶状态呈现

UI 严格基于 `sessionExited`、`treeState`、`drainedVerified`、`ptyDisposed` 与 `cleanupState` 呈现四种准确状态，杜绝任何误导：

| UI 呈现状态 | 触发条件 | UI 文案与徽标 | 会话记录处理 |
| --- | --- | --- | --- |
| **1. 正在清理** | `state === 'closing'` 或 `cleanupState === 'cleanupPending'` | 蓝色运转图标：“进程已退出，正在清理终端进程树与资源...” | 会话必须保留在 ledger 与 `cleanupPending` 集合中，严禁删除 |
| **2. 结束但未确认** | `sessionExited && cleanupState === 'cleanupUnconfirmed'` | 黄色警示图标：“终端会话已结束（进程树清理未确认）” | 会话结束，但保留警告标识，绝不显示绿色对勾 |
| **3. 结束且有资源警告** | `sessionExited && cleanupState === 'cleanedWithWarning'` | 橙黄色图标：“终端会话已结束（句柄关闭异常，见诊断详情）” | 进程树已确认清空，但向用户暴露具体未确认释放的句柄项 |
| **4. 完全清理完成** | `sessionExited && cleanupState === 'fullyCleaned'` | 绿色成功图标：“终端会话已结束，进程树与系统资源已完全释放” | 进程树与 Native 句柄完全释放，允许清理全部临时记录 |

---

## 8. Electron 与 backend 生命周期

### 8.1 Job 句柄归属

只有 backend 的 native `pty_baton` 持有 `hJob`。Electron main 不复制、不继承、不持有。

理由：

- Job 在 backend 创建并绑定 shell；句柄天然属于创建进程。
- 复制句柄会增加“最后一个句柄”的不确定性：Electron 崩溃时若复制句柄未关，`KILL_ON_JOB_CLOSE` 不触发。
- backend 崩溃/被杀时，OS 关闭全部句柄，`KILL_ON_JOB_CLOSE` 立即生效。

### 8.2 场景表

| 场景 | hJob 是否关闭 | shell/后代 | 需要做什么 |
| --- | --- | --- | --- |
| 停止/关闭终端 | 是（`TerminateJobObject` 请求 → drain → 受检 close；失败则 close 兜底；close 失败可 `CloseUnconfirmed`） | 被杀 | `stopSession`/`close`；Job kill 路由；先 `terminating`，不能直接 exited |
| 正常退出 Electron | 是（`server.kill()` 杀 backend → OS 关句柄；taskkill 匹配时更早） | 被杀 | 保留 `killServer` 身份门控 |
| Electron main 崩溃 | 否（backend 还活着） | 可能继续 | **新增** backend `disconnect` → shutdown |
| backend 崩溃/被 TerminateProcess | 是（OS 关句柄） | 被杀 | `KILL_ON_JOB_CLOSE` |
| backend SIGINT/SIGTERM | 是（shutdown → dispose → 关句柄；关闭失败则 OS 回收） | 被杀 | 已有 shutdown；补 disconnect |
| Node 未捕获异常退出 | 是（进程退出关句柄） | 被杀 | 日志 |
| 用户只杀 shell | hJob 在 drain 后关；`CloseHandle` 失败则保留 HANDLE 标 unconfirmed | 后代被杀 | 退出线程先关 hShell，再 drain；不把 shell 退出当整树完成 |
| 用户杀某个后代 | 否 | 其他进程不受影响 | 用户意图 |
| 系统关机 | 是（OS 终止进程/关句柄） | 被杀 | 不依赖用户态清理 |
| backend 被挂起 | 否 | 继续 | 无法用 Job 解决；边界 |

### 8.3 backend 父进程死亡

在 `server.js` 增加（实施阶段）：

```js
if (process.send) {
  process.on('disconnect', () => {
    void shutdown().catch(() => {});
    // 硬上限；不要 unref，事件循环空掉时也要能退出。
    setTimeout(() => process.exit(0), 3000);
  });
}
```

- `shutdown()` 先 `await terminal.dispose()`（`server.js:1478`），关闭 Job/hpc。
- 3 秒硬退出；进程退出关闭 Job 句柄，`KILL_ON_JOB_CLOSE` 仍生效。
- 这是 JS 级检测，不是内核级；backend 挂起/死锁时可能不执行。要内核级保证，需要 Electron 用 Job 管理 backend 本身或原生 launcher；本设计不包含。

### 8.4 `killServer` 保留

`electron/main.cjs:425-477` 的身份门控不删除：

- 它保护 backend PID，防止 `taskkill /T` 误杀复用 PID 的无关进程；
- `server.kill()` 是句柄级终止；
- 即使 taskkill 被跳过，backend 退出后 Job 句柄关闭，shell 被杀。

---

## 9. 失败恢复与清理

### 9.1 原生失败矩阵

| 失败点 | 检测 | 清理责任 | 是否创建 shell | 会话结果 |
| --- | --- | --- | --- | --- |
| `cleanupManager` 未就绪或预约满 | `!isWorkerHealthy() \|\| !reserve()` | 拒绝创建；不分配任何系统句柄 | 否 | 503 `pty_cleanup_busy`；从源头杜绝无主 HPCON |
| `CreateJobObjectW` | NULL | `PtyStartGuard` 将 HPCON 交清理队列（绝不同步关闭），受检关闭管道 | 否 | 503 `job_create_failed` |
| `SetInformationJobObject` | FALSE | guard 将 HPCON 交清理队列，受检关闭 Job/管道 | 否 | 503 `job_set_limit_failed` |
| 查询 LimitFlags | 不含 0x2000 | guard 异步清理 HPCON，受检关闭 Job/管道 | 否 | 503 `job_limit_unverified` |
| `CreateExitChannel`/TSFN | 异常/`napi_invalid_arg` | channel guard 释放资源；HPCON 异步入队 | 否 | 503 `pty_event_channel_failed` |
| `UpdateProcThreadAttribute(JOB_LIST)` | FALSE | `PtyConnectGuard` 异步清理 HPCON，受检关闭 Job/管道 | 否 | 503 `job_attribute_failed` |
| `CreateProcessW` | FALSE | guard 异步清理 HPCON，受检关闭管道/Job | 否 | 503 `CreateProcessW` |
| `IsProcessInJob` | FALSE/失败 | `StopCreatedShellBounded`：先 `TerminateJobObject`，再 `TerminateProcess`，再 `WaitForSingleObject` | 是，但不得只杀 shell | 退出确认 → 503 `job_assign_failed`；未确认 → `job_startup_cleanup_unconfirmed` + quarantine |
| `ActiveProcesses<1` | accounting 3 次重试后仍 <1 | 同上（无锁轮询间隙检查 abort） | 是 | 同上；503 `job_accounting_failed` |
| `ResumeThread` | `(DWORD)-1` | 同上；不 Resume 主线程 | 是，挂起态 | 同上；503 `job_resume_failed` |
| `StartExitThread` | 创建线程失败 | 已 Resume 的 shell 按 `StopCreatedShellBounded` 整组终止 + 有界 drain；未确认交给 quarantine；受检关闭 hJob | 是 | 503 `pty_exit_thread_failed`；不返回 success |
| `TerminateProcess` | FALSE | 记录 `GetLastError`；`ERROR_ACCESS_DENIED` 先 `WaitForSingleObject(hProcess,0)` 判是否已退出；否则 Job 兜底 + quarantine | 是 | 不能宣称退出；`unconfirmed` |
| `WaitForSingleObject(hProcess,timeout)` | `WAIT_TIMEOUT`/`WAIT_FAILED`/`WAIT_ABANDONED`，或 `WAIT_OBJECT_0` 但 accounting 未归零/查询失败 | 保留 `hProcess`/`hJob`，交给 startup quarantine；不关闭、不按 PID | 是 | `job_startup_cleanup_unconfirmed`；503 |
| 退出线程 `WaitForMultipleObjects` | `WAIT_FAILED` | 不发 `onExit`；mutex 下 `TerminateJobObject` 后受检关闭 hJob；hShell 用 2s 复核，仅 `WAIT_OBJECT_0` 才受检关闭，否则保留在 baton | 已创建 | `treeState=unconfirmed`；`ClosingUnverified`/`Unconfirmed`；baton 保留到硬退出 |
| `TerminateJobObject` | TRUE | 只置 `terminateAccepted=true`、`Terminating`；保持 hJob；继续 drain | 是 | 不是 drained；超时 → `unconfirmed` |
| `TerminateJobObject`（Active） | FALSE | 受检关闭 hJob 触发 `KILL_ON_JOB_CLOSE`；关闭成功 → `ClosingUnverified`，失败 → `Unconfirmed` | 已创建 | `treeState=unconfirmed`；`killUnconfirmed` |
| `TerminateJobObject`（Connecting） | FALSE | **不关闭 hJob**（CreateProcessW/PtyConnect 仍可能使用）；只置 `abortRequested`，由连接路径/dispose 清理 | 可能 | `unconfirmed`；连接返回 `pty_aborted`/503 |
| `CloseHandle(hJob)` | FALSE | 保留 HANDLE，`hJobCloseUnconfirmed=true`；不重试 | 已创建 | 已 drained 保留 `drainedVerified=true`；清理状态标 `cleanedWithWarning` |
| `CloseHandle(hShell)` | FALSE | 保留 HANDLE，`shellCloseUnconfirmed=true`；不重试；继续 accounting | 已创建 | 不自动否定 drain，但清理状态标 `cleanedWithWarning`，禁止全绿 |
| `CloseHandle(hThread/hIn/hOut)` | FALSE | 记录 `resourceCloseUnconfirmed`；不重试；不阻塞终端 | 可能已创建 | 诊断告警；清理状态标 `cleanedWithWarning` |
| `ClosePseudoConsole` | 无返回值（`void`） | 由固定 worker 执行；记录 `closeReturned=true`；崩溃/未返回保持 `ptyDisposed=false` | 是 | **严禁主线程同步执行**；不据此推断 conhost 已退出 |
| drain 超时/查询失败 | 计时/GetLastError | 关闭 hJob 兜底（受检）；标 `Unconfirmed` | 已创建 | `cleanupState=cleanupUnconfirmed`，保持 closing |
| TSFN 队列满 | `napi_queue_full` | 记录警告，不阻塞 worker，不重试；终态已安全保存在 native 缓存中，依赖 JS 终态对账补查 | 是 | `job_event_delivery_pending`；JS 查 status |
| TSFN 已关闭 | `napi_closing`/`napi_invalid_arg` | 释放事件数据；不再调用 TSFN/不调用 Release | 是 | 不调用失效 env；终态完全依靠 native 缓存 |
| 清理队列满 | enqueue false | baton 保留 hpc 与清理预约 | 已创建 | 新终端 503 拒绝；旧会话保持 cleanupPending |
| startup quarantine 满 | 计数 | 无 shell：拒绝新终端；已创建 shell：baton 保留 `{hJob,hProcess}` 置 `startupQuarantinePending`，不丢 HANDLE | 可能 | 503 `pty_startup_cleanup_busy`；终态 `unconfirmed` |
| 旧 binary/打包错配 | 预检 false | 不创建 | 否 | 503 `pty_job_unavailable` |

### 9.2 失败关闭

- Job 创建/配置/绑定失败 → 不启动 shell；返回 503；不回退无 Job。
- 旧 `.node`/打包错配 → 预检拒绝；不调用 `spawn`。
- `pty.jobObject !== true` after spawn → invariant violation；不调用 `defaultKillPty`/P3-B/PID kill；调用 native `abortJob`（按 HANDLE），否则记录 fatal；根因是打包错配，必须修接口/校验。
- Job 模式 `TerminateJobObject` 失败：`Active` 状态受检关闭 hJob 触发 `KILL_ON_JOB_CLOSE`；结果 `treeState=unconfirmed`，不伪造成功；关闭失败进入 `CloseUnconfirmed`。`Connecting` 状态**不关闭 hJob**（CreateProcessW/PtyConnect 仍可能引用），只置 `abortRequested`，由连接路径/dispose 在不再使用后清理。
- `TerminateJobObject` 成功但进程未退出 → 只进入 `terminating`；必须 drain；不能因为返回非零就发 `exited`。
- `TerminateProcess` 失败/`WaitForSingleObject` 超时或失败 → 不宣称 shell 退出；`hProcess` 交给有界 startup quarantine，禁止 PID 回退；quarantine 满时拒绝新终端。
- `CloseHandle` 失败 → 只标 `CloseUnconfirmed`；不重试、不重复关闭、不置 `hJobClosed=true`；`jobStatus` 必须暴露 `closeUnconfirmed`。
- `ClosePseudoConsole` 返回 `void` → 只由 cleanup worker 执行，只标记“调用已返回”；**绝对禁止在 Node 主线程同步执行阻塞调用**；`ptyDisposed=false` 时不得删除会话/清理记录。
- TSFN 关闭/环境销毁 → 不再调用 JS，不 `Release` 已关闭的 TSFN，不用 `Napi::Error::Fatal` 把 worker 问题升级为进程崩溃。
- 清理队列满 → 拒绝新终端；不丢 hpc。

### 9.3 cleanupPending 与资源追踪持久性

- `server/terminal.js` 保留一份 `cleanupPending`（id + pty 引用 + `dispose` 结果 + `sessionExited/treeState/ptyDisposed/cleanupState`）。
- `close`/`dispose` 时如果 `pty.dispose()` 返回 `queued:false/retry:true`，不删除会话；sweep 定期重试。
- **`ptyDisposed` 后才从 ledger 移除**；由 `onPtyDisposed` 或 `pty.dispose()` 的 `disposed:true` 驱动。`onExit`/`shellExited` 本身不够。
- **会话结束与资源未清并存的处理：** 当 `sessionExited=true` 但 `cleanupState` 处于 `cleanupPending`、`cleanupUnconfirmed` 或 `cleanedWithWarning` 时，终端记录必须在系统内部完整保留直到物理清理或硬退出。**绝对不允许因为用户会话在界面上已关闭就丢失底层资源泄漏与挂起记录！**
- `dispose()` 关闭时最多等待 3s；**超时后绝对不能清空仍有 `ptyDisposed=false` 的记录**；把清理责任交给 `cleanupPending`/清理队列，记录实际 pending 数，不谎报全清。进程退出时 Job 句柄由 OS 内核关闭并触发 `KILL_ON_JOB_CLOSE`，但 `ClosePseudoConsole` 是否返回不做保证；`closeReturned` 只说明调用返回，不说明 conhost 已退出。
- `dispose()` 不应调用带 10s 等待的 `stopSession`。它直接对每个会话发起 kill/abort + `pty.dispose()`，然后用 3s 总预算等待 `ptyDisposed/drained`；超时保留 `cleanupPending`，不阻塞进程退出。
- 从 ledger 删除时不强制调用 `forgetFinalState(id)`；终态缓存由 64 项上限 + 10 分钟 TTL 淘汰，也可在 UI 已消费终态且无等待者时提前释放。若缓存已因 TTL/容量淘汰，`jobStatus` 返回 `gone+final:false`，JS 按 `unconfirmed` 处理，不能推断 drained。

### 9.4 日志

只记结构/计数：

- `terminal.job_created` `{sessionId, ptyId}`
- `terminal.job_bind_failed` `{sessionId, code}`
- `terminal.job_kill_requested` `{sessionId, ptyId, fallback?}`
- `terminal.job_drained` `{sessionId, ptyId, activeProcesses}`
- `terminal.job_unconfirmed` `{sessionId, ptyId, reason}`
- `terminal.pty_dispose_queued` `{sessionId, ptyId, pending}`
- `terminal.pty_disposed` `{sessionId, ptyId}`
- `terminal.cleanup_busy` `{pending}`
- `terminal.job_invariant_violation` `{sessionId, ptyId}`（fatal）

不记录命令行、cwd、env、完整 PID 列表、shell 路径。

---

## 10. 依赖与打包

### 10.1 路线

| 路线 | 结论 |
| --- | --- |
| 上游 node-pty PR | 并行做；不作为唯一交付 |
| 最小 fork + 原生补丁 | **推荐** |
| 独立原生 helper | 不推荐；需重写 ConPTY/跨进程 HPCON |
| JS post-spawn Assign / 外部枚举 | 拒绝 |

### 10.2 fork/vendor

- fork `microsoft/node-pty` 1.1.0；
- 补丁：`src/win/conpty.cc`、`src/windowsPtyAgent.ts`、`src/windowsTerminal.ts`、`src/interfaces.ts`、`src/index.ts`、`typings/node-pty.d.ts`；
- `binding.gyp` 不改 target；`SpectreMitigation: 'Spectre'` 已在 `binding.gyp:9`；
- 优先 vendor `vendor/node-pty/`（`package.json`、`lib/`、`prebuilds/win32-x64/`、`LICENSE`、`PATCH.md`、`SHA256SUMS`）；`package.json` 用 `file:vendor/node-pty` [决策]；
- 或发布 scoped 包/Release tarball；不推荐 git 依赖（安装时可能触发 node-gyp）。

### 10.3 构建

- Node 24.22.1 / Electron 44.4.3：N-API，两边都要构建/测试。
- Windows x64；ARM64 当前不发，node-pty 有 win32-arm64 prebuild，若发需补 patched prebuild。
- 本机 VS BuildTools 18 + MSVC 14.51.36231 存在，但 Spectre-mitigated libraries 未安装；CI 必须安装。
- 预编译产物：`conpty.node`；SHA-256 清单；打包测试断言 `supportsJobObject` 和 hash。
- 签名：自建 `.node` 建议 Authenticode；当前签名状态见 `docs/code-signing.md`，未核实 `.node` 是否覆盖 [决策]。

### 10.4 staging

- `scripts/node-pty-package.mjs:23-57` 只复制 `lib/**/*.js` 和 `prebuilds/<platform>`；vendor 的 `lib` 必须是**构建后的 JS**，不能只有 TS。
- `scripts/build-app.mjs:112` 固定 `win32-x64`；`asar:false`、`prune:false`（`250-251`）。
- `scripts/build-exe.mjs:133` SEA sidecar 到 `build/node_modules/node-pty`；同样需要 patched prebuild。
- 不新增原生模块；fork 是替换现有 node-pty。

### 10.5 升级

- 每次 node-pty 升级 rebase 补丁、重建 prebuild、跑 Windows 矩阵；常规 1-3 人日，上游大改 `conpty.cc` 3-5 人日。
- 上游接受后删除 fork，恢复官方依赖。

---

## 11. CI 设计

- `npm test` 仍是唯一 canonical 入口；新增快测试进 `package.json` 链，CI 用 `scripts/run-test-group.mjs` 递归读取，不抄清单。
- 分层：
  - 单元/伪 PTY：扩展 `tests/files-terminal.cjs`；覆盖 Job 路由、失败不降级、状态机、cleanupPending。
  - native 单测：`test:terminal:job:native`（test-only build hooks）。
  - 源码集成：`test:terminal:job:source`（真 `node server.js` + patched node-pty + ConPTY）。
  - 打包 Electron：`test:terminal:job:electron`（`dist-app` + Electron 44.4.3）。
  - 真机矩阵：Windows 10 22H2 / 11 23H2 / 11 24H2/25H2；CI `windows-latest` 是 Server，不替代桌面真机。
- CI 必须构建 patched prebuild、上传 SHA-256、跑 native/source/electron；失败不静默跳过。
- 测试 hooks 只在 test-only build 启用；生产构建不暴露。

---

## 12. 测试与验收

### 12.1 原有核心用例（保留并更新判定）

| # | 用例 | 预期 | 证据 | 真机 |
| --- | --- | --- | --- | --- |
| 1 | 创建时绑定 | `jobAssigned=true`，resume 前 `IsProcessInJob=true` | native status/日志 | 是 |
| 2 | 后代管理 | 子进程计入 ActiveProcesses；关闭后为 0 | accounting | 是 |
| 3 | 停止/关闭 | shell+后代退出；其他终端不受影响 | 标记文件/进程列表 | 是 |
| 4 | 自然退出 | shell 退出后后台后代被杀；会话在 `ptyDisposed && treeState∈{drained,unconfirmed}` 后才 exited | 标记文件/jobState/ptyDisposed | 是 |
| 5 | 静默 shell | 无首段输出也能 Job kill；不被 `_isReady` 延迟 | 进程列表/状态 | 是 |
| 6 | 多终端隔离 | 停 T1 不影响 T2 | 标记文件 | 是 |
| 7 | workspace 隔离 | retire 一个 workspace 只杀该树 | 标记文件 | 是 |
| 8 | backend 崩溃 | shell/后代消失 | 进程列表 | 是 |
| 9 | Electron 崩溃 | disconnect → shutdown → Job 关闭 | 日志/进程列表 | 是 |
| 10 | Electron 正常退出 | killServer + server.kill + Job 关闭 | 日志 | 是 |
| 11 | PID 复用哨兵 | Job 模式无 taskkill/process.kill；哨兵存活 | 标记/日志 | 是 |
| 12 | Job 创建失败 | 503，无 shell | HTTP/native | 是 |
| 13 | 绑定失败 | 按句柄终止；无残留；503 | native/进程列表 | 是 |
| 14 | ConPTY 清理 | `ClosePseudoConsole` 调用返回（不保证 conhost 立即退出）；句柄回基线；旧版阻塞行为记录 | 进程/handle 计数 + closeReturned | 是 |
| 15 | 打包路径 | `supportsJobObject=true`；Job 生效 | hash/日志 | 是 |
| 16 | SEA 路径 | sidecar patched；Job 生效 | 日志 | 是 |
| 17 | Windows 矩阵 | B+/B 结果记录 | 每版本日志 | 是 |
| 18 | 高进程数 | 50 个子进程全部收掉 | accounting | 是 |
| 19 | 逃逸记录 | WMI/UAC 进程不在 Job；文档记录 | 进程列表 | 是 |
| 20 | 输出完整性 | 大输出/自然退出不截断 | 输出尾部标记 | 是 |

### 12.2 第二轮与第三轮新增关键用例（必须逐项写清；T1–T32 不删除）

#### T21 Job HANDLE 重复关闭

- **步骤**：打开终端，记录 `hJob` 状态；同时/交替调用 `pty.kill()`、`pty.dispose()` 多次（≥10 次）；等待退出/清理。
- **预期**：无崩溃、无双重 `CloseHandle`、无 AV；`dispose` 幂等；最终 `disposed=true` 或 `cleanupPending`；`jobMode` 始终为 `Required`。
- **证据**：native status 日志、进程存活、handle 计数、测试断言（kill/dispose 返回状态）。
- **失败判定**：崩溃、双重关闭、`jobMode` 被改为 None、出现 `process.kill`/`taskkill` 调用、句柄计数上升。
- **真机**：是（Windows 10/11）。

#### T22 Job 终止失败

- **步骤**：test-only native hook 让 `TerminateJobObject` 返回 FALSE；打开终端并 `stop`；分别覆盖“hJob 关闭成功”和“hJob 关闭失败”两个分支；观察返回、Job 状态、进程树。
- **预期**：`PtyKill` 不再返回 `terminated`；关闭成功分支返回 `{requested:true, terminateAccepted:false, fallbackUsed:true, drainedVerified:false, treeState:'unconfirmed', error:'job_terminate_failed'}`，`jobState=ClosingUnverified`；关闭失败分支返回 `closeUnconfirmed:true`、`jobState=Unconfirmed`；关闭 hJob 触发 `KILL_ON_JOB_CLOSE`；shell/后代最终退出；若无法核对，会话 `killUnconfirmed`；绝不调用 PID 终止。
- **证据**：native hook 日志、kill 返回字段、`jobState=ClosingUnverified/Unconfirmed`、进程列表、无 `taskkill` 日志。
- **失败判定**：返回或日志出现 `terminated:true`；把 `fallbackUsed` 当 `drainedVerified`；回退到 `process.kill`/`taskkill`；伪造 `drained`；关闭失败仍置 `hJobClosed=true`；shell 未退出且无 unconfirmed。
- **真机**：是。

#### T23 Job ActiveProcesses 清零

- **步骤**：spawn shell；启动 3 个 marker 子进程；stop；每 100ms 查询 `status.activeProcesses`；记录 `jobState`。
- **预期**：终止后 ActiveProcesses 单调下降至 0；`jobState` 先 Terminating/Draining，再 Drained/Closed；会话只在 `shellExited && ptyDisposed && treeState=drained` 后 exited。
- **证据**：时间序列、status 日志、`onExit`/`onPtyDisposed` 顺序、marker 进程列表。
- **失败判定**：ActiveProcesses 长期不降；未清零就报 exited/drained；`TerminateJobObject` 成功后立刻 exited；关闭 hJob 后还声称 drained。
- **真机**：是。

#### T24 Shell 自然退出、后台后代仍运行

- **步骤**：shell 里启动 `ping -n 60 127.0.0.1` 或 marker 子进程；输入 `exit`；观察 onExit、jobState、子进程。
- **预期**：`shellExited=true`；hJob 保持；ActiveProcesses>0 时 `TerminateJobObject`；后代被杀死；连续两次 0 后 `Drained`；`ptyDisposed=true` 后会话才 `exited`。行为变化需产品确认。
- **证据**：onExit/jobState/onPtyDisposed 顺序、marker 文件、进程列表。
- **失败判定**：shell 退出即报整树清理完成；`TerminateJobObject` 返回成功即报 exited；后代存活且无 unconfirmed；hJob 提前关闭导致无法验证。
- **真机**：是。

#### T25 Spawn 中途失败资源回收

- **步骤**：test-only hooks 依次注入：Job 创建失败、SetInformation 失败、JOB_LIST 属性失败、`CreateExitChannel`/TSFN 创建失败（必须在 shell 创建前）、CreateProcessW 失败、IsProcessInJob 失败、ActiveProcesses<1、ResumeThread 失败、Resume 后 abort 注入、`StartExitThread` 失败、`TerminateProcess`/`WaitForSingleObject` 未确认；每次尝试开终端。
- **预期**：每次 503 或明确 `pty_aborted`；TSFN 失败时没有 shell；`StartExitThread` 失败时已创建/已 Resume 的 shell 由 Job 整组终止或进入 startup quarantine；没有 shell 残留；没有 hpc/job/管道泄漏；没有 PID 终止；会话不进入 running。
- **证据**：hook 日志、HTTP 503、进程/句柄计数、native status（无 baton 或 quarantine token）、`ConnectState=Failed`。
- **失败判定**：TSFN 失败后仍有 shell；只杀 shell 留后代；未确认退出却关闭 `hProcess`；shell 残留、hpc/job 泄漏、错误路径调用 P3-B/PID、JS 构造未清理。
- **真机**：是（native hooks）。

#### T26 旧版 node-pty 二进制与打包错配

- **步骤**：构造三种错配：旧 JS + 新 native、新 JS + 旧 native、两者都旧；分别启动打包 app/源码。另测 `dist-app`/SEA 的 staged `node-pty` hash。
- **预期**：预检 `supportsJobObject !== true` → 503 `pty_job_unavailable`；**不创建 shell**；没有 PID 终止；打包测试失败并指出 hash/版本。
- **证据**：HTTP 503、无 shell 进程、`supportsJobObject`/hash 日志。
- **失败判定**：spawn 创建 shell 后才发现不支持；调用 `defaultKillPty`/P3-B；PID kill。
- **真机**：是（打包 app）。

#### T27 100 次以上打开/关闭压力

- **步骤**：循环 100/200 次 open→stop/close；每次记录 handle 数、cleanup pending、jobState；最后等待队列清空。
- **预期**：每次 disposed 或明确 cleanupPending；句柄数回到基线；无崩溃；`ClosePseudoConsole` 调用均返回（conhost 是否立即退出按 OS 版本记录，不当作成功判据）；100 次后仍可创建终端。
- **证据**：循环日志、handle 计数、closeReturned 计数、进程列表、最终 status。
- **失败判定**：句柄/线程增长、队列永久满、终端无法再创建、把 conhost 常驻误报成句柄泄漏或清理失败。
- **真机**：是（Windows 10/11 各至少一台）。

#### T28 多终端并发退出

- **步骤**：开 4-8 个终端，各起 marker 子进程；同时 stop/close；重复 10 轮。
- **预期**：所有树退出；无跨终端误杀；cleanup 队列有界；会话状态一致。
- **证据**：每个 marker、jobState、队列 pending。
- **失败判定**：误杀其他终端；部分树残留且无 unconfirmed；队列泄漏。
- **真机**：是。

#### T29 多线程竞争

- **步骤**：native test harness 用多个线程并发调用 `PtyKill`、`dispose`、`status`、退出回调；每终端 ≥1000 次；同时自然退出。
- **预期**：无崩溃、无 use-after-free、无双重 CloseHandle；状态单调；ASAN/TSAN（如可用）无报告。
- **证据**：native 日志、ASAN/TSAN、退出码。
- **失败判定**：崩溃、竞态报告、状态回退、handle 重复关闭。
- **真机**：是（native 测试）。

#### T30 ClosePseudoConsole 长时间阻塞

- **步骤**：test-only hook 让 `ClosePseudoConsole` sleep 60s；开 3 个终端，先输出大段数据并记录尾部 marker，再 dispose；观察 worker/tracked；再尝试开新终端；释放 hook。
- **预期**：worker 被占用但容量有界；tracked/预约达到上限后新终端 503 `pty_cleanup_busy`；hpc 不被丢弃；JS 在 disposed 前继续读取 output，尾部 marker 可读；释放后队列排空，旧会话 disposed。
- **证据**：tracked 日志、HTTP 503、output 尾部 marker、句柄计数、最终 disposed。
- **失败判定**：每次 dispose 新建线程/线程数增长；丢弃 hpc；队列无限增长；进程崩溃。
- **真机**：是（Windows 10/11 23H2 优先）。

#### T31 清理容量达到上限

- **步骤**：正常 `maxSessions=12` 下先开满 12 个终端，确认不会触发上限；再用 native test harness（不经过 backend `maxSessions`）阻塞两个 worker（hook），连续创建/预约直到 `tracked=32`；第 33 次 `reserve()`；释放 hook。
- **预期**：12 个正常会话不会误触发 503；第 33 次预约失败（`pty_cleanup_busy`），不创建 hpc；已有会话保持 closing/cleanupPending；不丢句柄；释放后恢复。
- **容量验证方法（补充）**：test harness 直接调用 native `reserve()`/`enqueue()`，使用独立的 `PtyCleanupTask` 和假 HPCON（或 test-only hook 的 hpc 占位）填满 `kMaxTracked`；断言 `trackedCount()` 精确到 32、`reserve()` 第 33 次返回 false；正常 app 的 `maxSessions=12` 只用于对照，不作为容量上限判据。另用 4 个假 `{hJob,hProcess}` 填满 `kMaxStartupQuarantine`：第 5 个在 `PtyStartProcess`（无 shell）路径必须返回 `pty_startup_cleanup_busy`；在 `PtyConnect` 已创建 shell 的失败路径必须进入 `startupQuarantinePending`（不丢 HANDLE、不关句柄），释放一个后才能接收。
- **证据**：`trackedCount()`/`quarantineCount()` 时间序列、第 33 次返回值、503、恢复后 disposed。
- **失败判定**：创建继续成功导致队列无限；丢弃 hpc；会话被错误删除；把 `maxSessions=12` 当成 `kMaxTracked` 验证。
- **真机**：是（native harness；Windows 10/11）。

#### T32 backend 异常退出后的残留检查

- **步骤**：开多个终端和后台子进程；用测试控制器 `TerminateProcess(backend)`；检查 shell/后代/conhost；重启 app 再开终端。
- **预期**：Job 句柄随 backend 关闭，shell/后代退出；conhost 是否立即退出按 OS 版本记录为已知边界（`ClosePseudoConsole` 未必已调用/返回），不据此宣称完整清理；新 backend 可创建终端。
- **证据**：进程列表、Job 状态日志（退出前）、重启日志。
- **失败判定**：shell 后代存活且无解释；Job 未触发；重启后句柄/队列异常。
- **真机**：是。

#### T33A `TerminateJobObject` 异步返回逻辑模拟测试（Hook 驱动）

- **步骤**：test-only hook 包装 `TerminateJobObject`：第一次返回 TRUE，但人为延迟 2s 才真正向内核执行终止（模拟 Windows 内核异步清理队列），或者让测试 shell 在收到终止信号后执行 2s 的清理退出耗时；打开终端并启动带后代进程的 marker；调用 `stopSession()` 发起终止；每 100ms 连续轮询读取 `killJob()`/`jobStatus()`；记录 `onExit` 与 `onJobState` 事件时间序列。
- **预期**：
  - 调用发起瞬间，native 返回 `terminateAccepted:true`、`treeState='terminating'`、`drainedVerified:false`；
  - 在 2s 延迟期间，backend 保持 `killState='pending'`、`state='closing'`，**绝对不标记 `exited`**；
  - 2s 后 shell 与后代真正退出，drain 连续采样两次 0，才发布 `onJobState(treeState='drained', drainedVerified=true)`；
  - 若在延迟期间 `ActiveProcesses > 0`，绝对禁止提前出现 `drained`。
- **证据**：kill 初始返回值、100ms 采样时间序列、`onExit`/`onJobState` 顺序、未提前标记 exited 日志。
- **失败判定**：`TerminateJobObject` 返回非零后立即将会话置为 `drained` 或 `exited`；未完成 drain 就关闭 hJob；将 `terminateAccepted` 误判为 `drainedVerified`。
- **真机**：否（可在带 hook 的 CI 环境或 Windows 模拟环境中执行）。

#### T33B `TerminateJobObject` 真实 Windows API 异步退出与采样集成测试（Windows 真机）

- **步骤**：**不使用任何人为延迟 hook**，直接调用真实 Windows API `TerminateJobObject`；启动真实 PowerShell/CMD 并在其中启动一个持久的后台子进程（例如死循环批处理或独立 marker 进程）；调用 `stopSession()`；紧接着以 20ms 为周期高频采样 `QueryInformationJobObject(JobObjectBasicAccountingInformation)` 的 `ActiveProcesses`；使用高精度时钟精确记录：
  1. `TerminateJobObject` API 返回时间；
  2. `ActiveProcesses` 从 N 逐步递减至 0 的实际衰减时间序列；
  3. `hShell` 句柄信号唤醒时间（shell 进程退出时间）；
  4. 连续两次采样为 0 触发 `drainedVerified=true` 的时间。
- **预期**：
  - 真实 API 返回 TRUE 后，`ActiveProcesses` 在真实 Windows 内核中经历短暂异步衰减；
  - 只有在观察到连续两次间隔 ≥50ms 的 `ActiveProcesses == 0` 后，才由退出线程确认为 `drained`；
  - 真实环境中绝无人为伪造的延迟，完全验证真实内核语义与 drain 状态机在真实系统下的匹配度。
- **证据**：真实 Windows API 返回值、内核高频采样时间戳、进程物理消亡时间对比图、无任何 mock/hook 的纯净执行日志。
- **失败判定**：真实子进程尚未在系统进程树中消失就提前标记 `drained`；或者 `ActiveProcesses` 已连续为 0 却永久挂起。
- **真机**：**是（Windows 10 / Windows 11 真机）**。

#### T34 `CloseHandle` 失败注入

- **步骤**：test-only hook 让 `CloseHandle` 对 `hJob`、`hShell`、`hThread`、`hIn`、`hOut` 分别返回 FALSE；覆盖两种注入：句柄实际仍未关闭、句柄实际已关闭但返回 FALSE。依次触发 drain 后关闭、失败清理、自然退出、dispose；重复 kill/dispose ≥10 次。
- **预期**：`hJobClosed=false` 且 `hJobCloseUnconfirmed=true`；已 drained 时保留 `drainedVerified=true` 但 `cleanupState` 标为 `cleanedWithWarning`，UI 绝不显示“完全清理完成”；未 drained 时 `treeState=unconfirmed`；`hShellCloseUnconfirmed`/resource close 告警单独记录；不发生第二次 `CloseHandle`、不崩溃、不 AV；baton 可删除且终态 cache 可读；`jobStatus.closeUnconfirmed=true`。
- **证据**：CloseHandle 调用次数（每个 HANDLE 最多一次）、`GetLastError`、`jobStatus`、句柄计数、终态快照、进程存活。
- **失败判定**：失败后置 `hJobClosed=true`；重试关闭；析构再次关闭；baton 永久残留且无记录；把关闭失败当 drained；崩溃/AV。
- **真机**：是（native hook；Windows 10/11）。

#### T35 `TerminateProcess` 失败注入

- **步骤**：在 `IsProcessInJob` 失败/`ActiveProcesses<1` 的启动失败路径注入 `TerminateProcess` 返回 FALSE（分别注入 `ERROR_ACCESS_DENIED` 与 `ERROR_INVALID_HANDLE`）；若 shell 已在 Job 中，先让 `TerminateJobObject` 成功；观察 `WaitForSingleObject`、quarantine、503、进程列表；重复 10 次。
- **预期**：先尝试 `TerminateJobObject`（整组），不直接只杀 shell；`TerminateProcess` 失败后不宣称退出；`WAIT_OBJECT_0` 才确认；否则 `job_startup_cleanup_unconfirmed`，`hProcess` 留在 startup quarantine，不关闭、不按 PID；quarantine 满时新终端 503；不调用 `taskkill`/`process.kill`。
- **证据**：API 调用序列、`GetLastError`、wait 返回值、quarantine 计数、503、进程列表、无 PID 终止日志。
- **失败判定**：只杀 shell 留后代；失败后关闭 hProcess 并当作清理完成；PID 回退；quarantine 无上限；503 后仍能无限创建。
- **真机**：是（native hook + test marker）。

#### T36 `WaitForSingleObject` 超时与失败注入

- **步骤**：分别在启动失败清理、自然 shell 退出、`dispose` 路径让 `WaitForSingleObject` 返回 `WAIT_TIMEOUT`、`WAIT_FAILED`、`WAIT_ABANDONED`；另让退出线程的 `WaitForMultipleObjects` 返回 `WAIT_FAILED`；记录 `shellExited`、`onExit`、`jobState`、`hProcess/hShell` 所有权；超时后释放 hook，让进程退出。
- **预期**：三种返回都不置 `shellExited`、不发 `onExit`；`treeState=unconfirmed`、会话保持 closing；已创建 shell 的 `hProcess` 交给 quarantine，未被关闭；退出线程 `WAIT_FAILED` 时 hJob 受检关闭（成功 → `ClosingUnverified`，失败 → `Unconfirmed`），hShell 仅在 2s 复核得到 `WAIT_OBJECT_0` 后受检关闭，否则保留且 baton 不被删除；后续真实退出后可被回收/标记；不伪造 exit code。
- **证据**：wait 返回值、`GetLastError`、状态时间序列、quarantine 生命周期、进程列表。
- **失败判定**：`WAIT_TIMEOUT`/`WAIT_FAILED` 被当成退出；`onExit` 带伪造 exitCode；关闭仍在运行的 hProcess；PID kill。
- **真机**：是（native hook）。

#### T37 TSFN/异步通知与 baton 删除竞态

- **步骤**：test-only hook 在 `maybeRemoveBaton` 后暂停退出线程/主线程的 TSFN 回调 500ms；另用 64+ 个事件填满 TSFN 队列；在 drain 完成、baton 删除后才让 JS 收到 `onExit`；随后调用 `jobStatus()`；再触发 cache TTL/容量淘汰。另设一组：丢弃 `onExit` 与 `onJobState`，只投递 `onPtyDisposed`，观察 JS 的终态对账。
- **预期**：`onExit` 携带 shell 退出时的不可变快照（可为 `active/terminating`）；`onJobState` 或共享 `PtyFinalState` 给出最终 `treeState/drainedVerified/activeProcesses`；baton 删除后 `jobStatus()` 从 cache 返回 `present:false/final:true/treeState`，不是裸 `gone`；cache 淘汰后返回 `gone/final:false`，JS 按 `unconfirmed`，绝不按 drained；只收到 `onPtyDisposed` 时 JS 调用一次 `jobStatus()`，拿不到快照则按 `treeState='unconfirmed'` 结束而不是永久 `closing`；无 use-after-free、无崩溃。
- **证据**：事件时间戳与载荷、baton 删除日志、status 返回、cache 命中/淘汰计数、ASAN/TSAN（如可用）。
- **失败判定**：JS 只能读到 `gone` 且被当成 drained；事件丢失且无 cache；回调访问已删除 baton；`BlockingCall`/finalizer 死锁；崩溃。
- **真机**：是（native harness + Node worker）。

#### T38 Node 环境关闭时仍有待处理任务（无死锁基线）

- **步骤**：在 Node `worker_threads` 中创建 PTY；用 hook 让退出线程停在 drain/TSFN 投递；终止 worker 触发 Node 环境销毁（teardown）；记录 `Env::AddCleanupHook` 调用时间、`hStopEvent` 信号时间、线程退出时间、TSFN finalizer 触发与完成时间；重复 50 次。
- **预期**：Node 环境销毁时首先触发清理钩子，钩子在主线程非阻塞执行 `SetEvent(hStopEvent)`；退出线程与 worker 立即检测到信号，停止投递并调用 `ReleaseHolder()`；所有持有人释放后 TSFN finalizer 被调用并回收控制资源；整个 teardown 流程在 100ms 量级内平滑完成，绝无死锁或悬挂；主进程或 worker 正常退出。
- **证据**：钩子调用时间戳、finalizer 完成时间戳、线程退出日志、无任何死锁与崩溃记录。
- **失败判定**：worker 线程 teardown 超时卡死；finalizer 永远不被调用；发生循环等待死锁；进程异常崩溃。
- **真机**：是（Node 24 / Electron 44 worker）。

#### T39 Connecting 过程中并发 dispose

- **步骤**：test-only hook 在 `PtyConnect` 的 `CreateProcessW` 前后/`ResumeThread` 前后各 sleep 500ms；native harness 在第二个线程调用 `dispose`、`kill`/`abortJob`、`status` 各 ≥100 次；分别覆盖 shell 尚未创建、已创建未 Resume、Resume 返回后未转移所有权、已 Connected 四种窗口。
- **预期**：`connectState` 单调 `Connecting→Failed/Connected`；`abortRequested/disposeRequested` 置位；未 Resume 时 shell 不执行用户代码；Resume 后窗口到达的 abort 不会把 `jobState` 改回 `Active`，而是按 Job+hProcess 清理并抛 `pty_aborted`；`TerminateJobObject` 被调用；`hpc` 只在连接结束后转移一次；`dispose` 不在 `CreateProcessW` 使用 hpc 时关闭它；无崩溃/use-after-free。
- **证据**：状态时间序列、hook 时间、Job 终止日志、hpc enqueue 次数、进程列表、ASAN/TSAN。
- **失败判定**：Connecting 期间关闭 hpc/hShell；Resume 了已 abort 的 shell；两个 hpc task；状态回退；双重关闭；崩溃。
- **真机**：是（native harness）。

#### T40 嵌套 Job accounting 的实际行为

- **步骤**：用 test-only helper 在 shell 内创建一个子 Job（`CreateJobObject` + `SetInformationJobObject(KILL_ON_JOB_CLOSE)`），把 marker 子进程创建为 suspended、`AssignProcessToJobObject(childJob, child)`、Resume；确认 marker 同时在终端 Job 与子 Job 中（`IsProcessInJob` 两次）；从终端 Job 查询 `ActiveProcesses`；调用 `TerminateJobObject(terminalJob)`；记录 marker/子 Job 状态和 accounting 序列。Windows 10 22H2 / 11 23H2 / 11 24H2 各跑。
- **预期**：官方文档预期父 Job accounting 聚合子 Job；`TerminateJobObject` 同时终止子 Job；只有 marker 退出且 accounting 连续两次 0 才 `Drained`。如果实测某版本不计入子 Job，记录为 `[C0]` 缺口，`Drained` 文案降级为“当前 Job 可观察 accounting 归零”，不声称覆盖嵌套 Job。
- **证据**：`IsProcessInJob` 结果、`ActiveProcesses` 时间序列、marker/子 Job 进程列表、终止返回值、版本号。
- **失败判定**：把单次 `ActiveProcesses` 结果当成跨版本保证；子 Job 进程存活却报告 drained；`TerminateJobObject` 未覆盖子 Job 且无 unconfirmed；用“没观察到”推断 API 不支持。
- **真机**：是（Windows 10/11 多版本）。

#### T41 Node 环境销毁与 TSFN 无死锁生命周期三大场景测试（定稿修订）

- **目标**：验证在 Node.js 运行时或 Worker 线程销毁时，系统能够在三大关键并发场景下平滑完成 teardown，绝对不发生死锁、资源悬挂或崩溃。
- **场景 A（退出线程正在 WaitForMultipleObjects 等待 shell）**：
  - **时序与步骤**：Shell 正在运行，退出线程阻塞在 `WaitForMultipleObjects({hShell, control->hStopEvent}, FALSE, 500ms)`；主线程触发 Node teardown，调用 `napi_add_env_cleanup_hook` 注册的 `OnEnvCleanupHook`。
  - **Hook 响应时间**：主线程同步执行 < 1ms，立即完成 `SetEvent(control->hStopEvent)`、`envClosing=true` 与 `control->stop=true`。
  - **TSFN 引用释放条件**：退出线程被 `hStopEvent` 唤醒（≤ 5ms），检测到 `envClosing=true`，停止投递新 JS 事件，立即调用 `channel->ReleaseHolder()`（计数 1 → 0），退出线程平滑退出。
  - **Finalizer 触发条件**：TSFN 内部引用计数归零，底层队列排空，Node 主线程调度触发 `FinalizerCallback`，受检关闭 `control->hStopEvent`。
  - **销毁判定**：Node 环境在 ≤ 50ms 内完全销毁，无残留 native 线程，无死锁。
- **场景 B（退出线程正在执行 drain 轮询）**：
  - **时序与步骤**：Shell 已退出，退出线程正在以 50ms-100ms 间隔轮询 `QueryInformationJobObject`；此时主线程触发 Node teardown。
  - **Hook 响应时间**：主线程同步执行 < 1ms。
  - **TSFN 引用释放条件**：退出线程在当前 sleep/query 间隙检测到 `control->stop == true` 或 `envClosing == true`，立即终止 drain 轮询，保持 `jobState=Unconfirmed`，调用 `channel->ReleaseHolder()`（计数 1 → 0），退出线程退出。
  - **Finalizer 触发条件**：TSFN 引用归零后由 Node 主线程触发 `FinalizerCallback`。
  - **销毁判定**：Node 环境在 ≤ 50ms 内完全销毁，未完成的进程树由 OS 的 `KILL_ON_JOB_CLOSE` 兜底，绝不死锁。
- **场景 C（Cleanup Worker 已经进入 ClosePseudoConsole 且调用长时间不返回）**：
  - **物理现实依据**：旧版 Windows 上 `ClosePseudoConsole` 可能因为等待 pipe drain 或 conhost 挂起 1-2 秒甚至永久不返回。这是一个不可中断的 Windows 内核同步 API，**绝对不能、也无法要求该线程在 10ms 内响应停止事件**！
  - **架构解耦与 TSFN 引用释放条件**：按照定稿设计，Cleanup Worker 在执行 `ClosePseudoConsole` 期间**持有 0 个 TSFN 引用**！当 Node teardown 发生时，退出线程按场景 A/B 释放其唯一的定常 TSFN 引用，此时 TSFN 引用计数已经归零！
  - **Finalizer 触发条件**：由于 worker 不持有 TSFN 引用，TSFN finalizer **无需等待阻塞的 worker**，直接触发并完成控制块清理！Node Worker 环境在 ≤ 50ms 内平滑完成销毁！
  - **Native Worker 存活与退出责任**：native worker 线程继续安全运行在 Windows 后台（持有 `std::shared_ptr<PtyFinalState>` 与 `std::shared_ptr<PtyEventChannel>`，两者均为独立堆内存，不依赖已销毁的 JS 环境）；当 `ClosePseudoConsole` 最终返回后，worker 检测到 `channel->IsClosing() == true`，更新 `finalState->ptyDisposed = true`，放弃向 JS 投递事件，安全释放 `shared_ptr` 后退出。若进程整体退出，由 OS 直接回收。
  - **销毁判定**：Node 环境销毁绝不被挂起的 `ClosePseudoConsole` 阻塞，Node 环境退出耗时 ≤ 100ms；进程与 native 内存安全，无崩溃、无 UAF。
- **证据**：三大场景下 Hook 响应时间戳、ReleaseHolder 调用序列、TSFN finalizer 触发时间戳、线程退出日志。
- **失败判定**：场景 A/B 耗时超过 500ms；场景 C 因等待 `ClosePseudoConsole` 导致 Node teardown 挂起；finalizer 永久未调用；UAF 或进程崩溃。
- **真机**：是（Node 24 / Electron 44 worker 与 Windows 10/11）。

#### T42 Cleanup Worker 与事件通道生命周期六大场景并发测试（定稿修订）

- **目标**：验证后台固定 Cleanup Worker 在与事件通道、TSFN 状态及 Node 环境生命周期并发时的完备健壮性，覆盖全部 6 种异常与并发场景。
- **场景 1（Worker 在条件变量等待队列任务）**：
  - **步骤与预期**：队列为空，worker 阻塞在 `cv.wait()`；调用 `cleanupManager.shutdown()`；`stopping=true` 并 `cv.notify_all()` 唤醒 worker；worker 发现 stopping 且队列空，平滑退出循环，线程结束；无泄漏。
- **场景 2（Worker 正在执行 ClosePseudoConsole）**：
  - **步骤与预期**：Worker 正在调用 `ClosePseudoConsole`；此时外部触发 `dispose()` 或 Node teardown；断言 worker 持有 0 个 TSFN 引用，不阻塞 Node teardown；`ClosePseudoConsole` 返回后更新 `closeReturned=true` 与 `ptyDisposed=true`。
- **场景 3（Worker 已完成关闭，正在投递 onPtyDisposed）**：
  - **步骤与预期**：`ClosePseudoConsole` 返回后，worker 检查 `!channel->IsClosing()` 并调用 `channel->AcquireHolder()`；底层 `tsfn.Acquire()` 返回 `napi_ok`，本地计数加 1；worker 投递 `PtyEvent{ type: PtyDisposed, snapshot, finalState }`；投递后立即调用 `channel->ReleaseHolder()`，本地计数减 1，底层 `tsfn.Release()` 成功完成；JS 收到事件。
- **场景 4（投递时 TSFN 返回 napi_queue_full）**：
  - **步骤与预期**：模拟 JS 事件循环繁忙导致 64 项 TSFN 队列打满；worker 调用 `Post` 返回 `napi_queue_full`；worker 采用有界退避重试（最多 3 次，每次 5ms）；若仍满，`Post` 内部立即 `delete payload` 释放内存，记录警告日志，绝不无限阻塞 worker 线程，随后正常 `ReleaseHolder()`；Native `finalState->ptyDisposed=true` 依然保持完整，JS 通过后续 `jobStatus()` 终态对账补查。
- **场景 5（投递时 TSFN 返回 napi_closing）**：
  - **步骤与预期**：worker 刚准备投递时 Node 环境开始 teardown；`AcquireHolder()` 返回 false，或 `Post` 返回 `napi_closing`；worker 立即释放局部 payload，放弃向 JS 通信，绝不再次调用 `NonBlockingCall`，绝不调用 `Napi::Error::Fatal`；worker 安全退出。
- **场景 6（Node 环境已销毁，native finalState 仍需保持正确）**：
  - **步骤与预期**：Node 环境已彻底退出，TSFN finalizer 已执行；随后后台滞后的 worker 中的 `ClosePseudoConsole` 才返回；worker 通过 `task.finalState` 写入 `ptyDisposed=true`；断言由于使用了 `std::shared_ptr<PtyFinalState>`，该原生内存块依然有效完整，写入安全无崩溃，随后 worker 退出时析构最后一个 `shared_ptr` 并释放内存。
- **证据**：六大场景状态转移日志、TSFN 状态码分布、内存检测报告（ASAN）、无崩溃无泄漏记录。
- **失败判定**：worker 永久挂起；TSFN 计数下溢或虚假计数；访问失效 `napi_env`；内存泄漏；崩溃。
- **真机**：是（native harness + Node worker）。

#### T43 不可变事件快照与最终状态缓存一致性测试（新增）

- **步骤**：启动终端并启动带有较长退出耗时的子进程；外部调用 `killJob()`；
  1. 捕获退出线程在 shell 退出瞬间发出的 `onExit` 事件载荷；
  2. 故意让 JS 事件监听器延迟 1000ms 消费；
  3. 在此 1000ms 期间，退出线程完成 drain，更新了共享的 `PtyFinalState` 并将 baton 从 registry 移除；
  4. JS 回调被调度执行，读取 `onExit` 事件的 `snapshot`；
  5. 随后 JS 立即调用 `jobStatus(id)` 查询缓存中的 `finalState`。
- **预期**：
  - `onExit` 回调读取到的 `snapshot.treeState` 忠实反映当时的 `'terminating'` 历史快照；
  - `jobStatus(id)` 查询读取到的是缓存中的最新终态 `'drained'`（`drainedVerified=true`）；
  - JS 遵循状态单调性：不会让晚到的 `onExit` 快照将本地会话覆盖回 `'terminating'`；
  - 不可变快照与最新终态各司其职，无数据竞争与读写冲突。
- **证据**：snapshot 字段、cache 查询结果、状态单调性审计日志。
- **失败判定**：`onExit` 的 snapshot 被后续 drain 操作篡改；JS 会话状态发生回退；无锁读取撕裂。
- **真机**：是。

#### T44 Connecting 取消请求与 ResumeThread 竞态测试（新增）

- **步骤**：使用 test harness 精准控制时序：
  - 组 1：在 `CreateProcessW` 成功后、`ResumeThread` 之前，T2 调用 `killJob()`；
  - 组 2：在 `ResumeThread` 刚刚返回的瞬间（线程刚被操作系统唤醒），T2 调用 `killJob()`。
  各重复 100 次，记录子进程是否曾执行用户代码、最终状态机流转。
- **预期**：
  - 组 1：T1 在线性化点 1 拦截到 abort，**子进程绝对未调用 ResumeThread**，用户代码零执行；整组被终止，抛出 `pty_aborted`；
  - 组 2：子进程虽然被短时间唤醒，但 T1 在锁内拦截到 abort，**绝不将状态置为 `Active`**，而是保持 `Terminating` 并立即整组终止；
  - 两组的最终 `connectState` 均为 `Failed`，无任何孤儿进程残留。
- **证据**：用户代码执行探测 marker、API 调用时间戳、最终 Job 状态。
- **失败判定**：组 1 执行了用户代码；组 2 状态被改回 `Active`；句柄泄漏。
- **真机**：是（Windows 10/11）。

#### T45 Cleanup Worker 启动失败与 HPCON 预约保护测试（新增）

- **步骤**：通过 test hook 模拟后台清理 worker 线程启动崩溃或初始化失败；随后应用尝试调用 `startProcess` 创建新终端；另有一组：模拟 cleanup manager 正在 shutdown 期间，有失败终端尝试调用 `enqueue` 清理 HPCON。
- **预期**：
  - worker 未就绪时，`cleanupManager.isWorkerHealthy()` 为 false，`startProcess` 在创建 HPCON 之前直接抛出 503 `pty_cleanup_busy`，**绝对不调用 CreatePseudoConsole**；
  - 在 shutdown 期间 enqueue 失败的 HPCON，被安全归入 `pendingHpc` 集合，**绝对不在 Node 主线程同步调用阻塞的 ClosePseudoConsole**；
  - 系统记录清晰的 fatal 日志，应用保持可用或安全退出，不卡死。
- **证据**：API 调用拦截证据、`pendingHpc` 列表大小、主事件循环响应时间（耗时 ≤5ms）。
- **失败判定**：在 worker 异常时仍创建 HPCON；在主线程同步调用 `ClosePseudoConsole` 导致主循环挂起。
- **真机**：是（native hook）。

#### T46 sessionExited 与 fullyCleaned 状态矩阵测试（新增）

- **步骤**：通过测试矩阵分别注入不同故障组合：
  1. 正常路径：shell 退出，drain 成功，HPCON 关闭返回，所有句柄成功关闭；
  2. 句柄警告路径：shell 退出，drain 成功，HPCON 关闭返回，但注入 `CloseHandle(hJob)` 失败（`hJobCloseUnconfirmed=true`）；
  3. 未确认路径：shell 退出，drain 超时（`treeState=unconfirmed`），HPCON 关闭返回；
  4. 挂起路径：shell 退出，drain 成功，但 HPCON 阻塞（`ptyDisposed=false`）。
- **预期**：
  - 组合 1：`sessionExited=true`，`cleanupState='fullyCleaned'`，UI 绿色成功对勾；
  - 组合 2：`sessionExited=true`，`cleanupState='cleanedWithWarning'`，UI 橙黄色图标，显示句柄未确认警告；
  - 组合 3：`sessionExited=true`，`cleanupState='cleanupUnconfirmed'`，UI 黄色警示，绝不显示全绿；
  - 组合 4：`sessionExited=false`（保持 `closing`），`cleanupState='cleanupPending'`，会话严格保留在系统内，严禁删除。
- **证据**：四个组合下的会话对象属性、UI 徽标断言、清理队列保留断言。
- **失败判定**：组合 2 或组合 3 被判定为完全清理成功；组合 4 丢失会话记录。
- **真机**：是。

### 12.3 测试方法

- 所有写操作用 `os.tmpdir()` fixture；不碰真实用户数据。
- 用 marker 文件内容/命令行身份判断，不用裸 PID 当唯一判据；HANDLE 判据用所有权状态和调用次数，不用句柄数值。
- 时间等待用轮询 + 超时，不用固定 sleep 作为唯一判据；TSFN/worker 测试用事件/条件变量同步，sleep 只作为上限。
- 原生 test hooks 只在 test-only build 启用；生产构建不包含。hook 必须能注入返回值、延迟、`GetLastError` 和“实际已关闭但返回 FALSE”两种 `CloseHandle` 形态。
- 每个失败注入用例记录：API 调用序列、返回值、`GetLastError`、`WaitForSingleObject` 返回码、`ActiveProcesses` 采样、`CloseHandle` 调用次数（每个 HANDLE 最多一次）、最终 `JobState/treeState`。
- T33–T36 的 hook 必须同时覆盖启动失败、自然退出、`dispose` 三条路径；不能只在一条路径上验证。
- T37/T38 用 `worker_threads` + 真实 Node 24 / Electron 44 的 env teardown；事件顺序用序号和时间戳双重记录，不能只断言“最终没崩”。
- T40 用 test-only helper 创建子 Job；子 Job 的 `KILL_ON_JOB_CLOSE`、`IsProcessInJob`、accounting 结果逐项记录；不同 Windows 版本分开跑，不合并结论。
- 压力测试重复至少 3 次；记录实际数字（open/close 次数、句柄数、pending、closeReturned、耗时）。
- 真机矩阵：Windows 10 22H2、Windows 11 23H2、Windows 11 24H2/25H2；x64。
- UI 证据：关闭/停止/清理中/unconfirmed 的真实截图；jsdom 不算布局证据。

### 12.4 失败判定汇总

- 任何 Job 模式路径出现 `process.kill`、`taskkill`、`_getConsoleProcessList`，或以 PID 作为终止/兜底判据 → 失败。
- `TerminateJobObject` 返回非零即报 `drained`/`exited`/整树清理完成 → 失败。
- Shell 退出即报 `exited`/整树清理完成；`sessionExited` 早于 `ptyDisposed` → 失败。
- `unconfirmed` 被当成 `drained`；`gone` 被当成 `drained`；`fallbackUsed` 被当成 `drainedVerified`；空 Job 未做两次零查询就置 `drainedVerified` → 失败。
- `hJob` 关闭后声称 `ActiveProcesses==0`；`TerminateProcess` 调用后未 `WaitForSingleObject` 确认就声称退出 → 失败。
- `CloseHandle` 失败仍置 `hJobClosed=true`、重试关闭、析构再次关闭或双重释放 → 失败。
- `WAIT_TIMEOUT`/`WAIT_FAILED`/`WAIT_ABANDONED` 被当成退出；关闭仍在运行的 `hProcess` → 失败。
- Connecting 期间关闭 `hpc/hShell`、Resume 已 abort 的 shell、或把 `jobState` 从 `Terminating` 改回 `Active` → 失败。
- `startupQuarantineOwned`/`startupQuarantinePending` 时 `dispose` 关闭 `hJob` 或删除 baton；quarantine 条目无上限/无释放 → 失败。
- baton 删除后 JS 只能读到裸 `gone` 且没有终态快照；TSFN 回调访问已销毁 env；终态 cache 无上限/无 TTL → 失败。
- 清理线程/句柄随 dispose 次数增长 → 失败。
- 旧二进制在 shell 创建后才发现不支持 → 失败。
- 失败路径依赖 P3-B 身份门控兜底 → 失败。

---

## 13. 工作量估算（修订）

| 阶段 | 工作 | 估算（人日） | 依赖 | 退出标准 |
| --- | --- | --- | --- | --- |
| P3-C0 spike | B+/B 组合（A 仅在明确要求时）；Windows 矩阵；conhost/ClosePseudoConsole；ActiveProcesses/嵌套 Job；`TerminateJobObject` 成功不即退出；TSFN/env teardown 观察 | 4-6 | MSVC + Spectre；真机/VM | 选定 B+ 或 B；记录每个版本；失败则停止 |
| P3-C1 native | Job 状态机；不可变 jobMode；RAII；drain；有界终态 cache；Connecting/abort；清理管理器；HANDLE 并发；受检关闭/等待；test hooks | 10-15 | C0 结论 | native 单测/压力/并发；无句柄泄漏；T33–T40 通过 |
| P3-C2 backend | capability；五事实；`sessionExited`；`abortJob`；cleanupPending；503；disconnect；日志 | 5-7 | C1 | 失败关闭；P3-B 不回归；unit/fake PTY 全绿 |
| P3-C3 tests/packaging | 源码/Electron/SEA；hash；真机矩阵；T31–T40；安全审查；文档 | 8-12 | C1/C2 | 第 12 节通过；打包证据；独立安全审查 |
| P3-C4 upstream | PR；rebase/升级/签名 playbook | 2-5 + 审阅 | C1 | PR 提交/合并或明确拒绝 |
| **合计** | | **29-45 人日** | | 不含上游审阅/签名/发布 |

比第二轮增加约 5-7 人日，主要来自：最终状态缓存/TSFN 事件改造、`CloseHandle`/`TerminateProcess`/`WaitForSingleObject` 失败矩阵、startup quarantine、Connecting 并发、T33–T40 真机测试。估算不含上游审阅、代码签名和发布；若 C0 发现需要额外兼容层，需重新估算而不是压缩测试。

---

## 14. 剩余风险与不可解边界

### 14.1 高风险

| 风险 | 影响 | 缓解 | 验收 |
| --- | --- | --- | --- |
| B+ 三属性组合在目标 Windows 版本失败 | 无法创建受保护终端 | C0 矩阵；B 需批准；A 单独批准；都不行则停止 | 每版本记录 |
| `TerminateJobObject` 成功但进程未退出 | 上层误报 `exited/drained` | `terminateAccepted` 与 `drainedVerified` 分离；T33A/T33B；JS 只在 `shellExited+ptyDisposed+drained/unconfirmed` 后结束 | T33A/T33B/T23/T24 |
| `CloseHandle`/`TerminateProcess`/`WaitForSingleObject` 失败 | 句柄所有权/退出状态不明 | `CloseUnconfirmed`、startup quarantine、禁止重试/重复关闭；T34–T36 | T34/T35/T36 |
| TSFN/env teardown 与 finalizer 循环等待 | 退出线程与 finalizer 互相等待死锁；失效 env 回调 | `napi_add_env_cleanup_hook` 驱动停止；Cleanup Worker 执行阻塞关闭期间零 TSFN 引用；事件快照 + 有界终态 cache；PtyEventChannel CAS 引用控制；T37/T38/T41 | T37/T38/T41 |
| `KILL_ON_JOB_CLOSE` 兜底后无法验证 ActiveProcesses | 无法确认树清空 | 标 `ClosingUnverified/Unconfirmed`；不报 drained | 测试 T22/T24 |
| 清理 worker 阻塞导致队列满 | 新终端不可用 | 固定 worker/队列；绝对禁止同步 `ClosePseudoConsole` 兜底；503；保留 hpc | T30/T31/T45 |
| startup quarantine 满 | 新终端不可用 | fail closed；有界条目；不丢 HANDLE | T35/T31 |
| 嵌套 Job/WMI/提权进程逃逸 | 后代不在 Job 或 accounting 不覆盖 | 文档记录；不宣称安全沙箱；C0 实测 | T19/T40 |
| 外层 Job/企业策略 | Job 创建/绑定失败 | fail closed；503 | 受限环境 |
| `ClosePseudoConsole` 24H2 前阻塞 | conhost 清理慢 | 有界队列；drain；真机 23H2 | T30 |
| 自然退出杀后台后代 | 行为变化 | 产品决策；测试；文档 | T24 + 用户确认 |
| fork/prebuild 供应链 | 构建/签名/AV | vendor + SHA-256 + 签名 + 审查 | 打包证据 |
| backend 挂起 | disconnect 不执行 | 无法完全解决；正常退出仍杀 backend | 边界记录 |

### 14.2 中风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `ActiveProcesses` 对挂起进程计数不一致 | resume 前断言失败 | C0；失败则去掉该断言，保留 IsProcessInJob |
| 嵌套 Job 的 `ActiveProcesses` 实测与文档聚合语义不一致 | 误报 drained 或误报未清空 | C0/T40 逐版本实测；失败则把 `Drained` 降级为“当前可观察 accounting 归零”，不宣称覆盖子 Job |
| `TerminateJobObject` 失败后关 hJob | 无 accounting | 标 unverified；不报 drained |
| 旧二进制/打包错配 | shell 未受保护 | 预检 + hash + 打包测试；invariant 失败不 PID kill |
| 多终端并发与 Connecting 取消竞争 | 队列/状态竞争、Resume 调度窗口竞态 | baton mutex + 原子 `abortRequested` + 线性化检查点 + T28/T29/T44 |
| 100+ 循环 | 句柄/线程累积 | T27；固定 worker |
| JS GC/析构 | 原生资源延迟 | 显式 dispose；构造 catch；不依赖 GC |

### 14.3 不可解边界

1. Job Object 不能管理不是由 Job 中进程通过正常 `CreateProcess` 创建的进程：WMI `Win32_Process.Create`、服务/计划任务、UAC/AppInfo 提权进程等。
2. Job 不是安全边界；同一用户下的恶意代码可以绕过。
3. `ActiveProcesses==0` 只证明当前 Job（按官方文档聚合子 Job）的 accounting 归零；不证明 WMI/服务/计划任务/UAC/AppInfo 等 Job 外进程退出，也不证明 conhost 已退出。
4. backend 被挂起/死锁时，JS 级父进程死亡检测不会执行。
5. `ClosePseudoConsole` 的阻塞行为由 OS 版本决定；有界队列只能保护资源，不能消除阻塞；其返回也不代表 conhost 退出。
6. 关闭最后一个 `hJob` 后无法再查询 accounting；`KILL_ON_JOB_CLOSE` 兜底永远无法被 `ActiveProcesses` 验证。
7. `PtyFinalState` cache 只能保存有界时间窗内的终态；TTL/容量淘汰后，晚到的 `jobStatus()` 只能得到 `gone`，必须按 `unconfirmed` 处理，不能反推 `drained`。
8. Legacy/P3-B 路径仍有 PID 复用窗口；Job 模式用句柄消除了终端树的这个窗口。
9. Windows 7/8 不支持 ConPTY/嵌套 Job 组合；只支持 Windows 10 1809+ / Windows 11。

---

## 15. P3-C 实施顺序

### P3-C0：spike 与决策（4-6 人日）

- 分支 `spike/terminal-job-object`，不合并；
- 验证 B+/B 组合；A 仅在用户明确要求时单独验证；Windows 10 22H2 / 11 23H2 / 11 24H2/25H2；x64；
- 记录：CreateProcessW、IsProcessInJob、ActiveProcesses（挂起进程、释放引用、嵌套/子 Job 聚合）、conhost 是否在 Job、ClosePseudoConsole 阻塞与返回、resume 前崩溃、KILL_ON_JOB_CLOSE 对挂起进程；
- 记录：`TerminateJobObject` 成功但进程未退出的时间窗；`CloseHandle` 失败时 `GetLastError` 与句柄是否仍有效；`TerminateProcess` 失败/`WaitForSingleObject` 三种返回的实测；WMI/服务/UAC/AppInfo 进程是否进入 Job；
- 记录：TSFN/异步通知在 Node 24 与 Electron 44 的 env teardown/finalizer 行为及 `Env::AddCleanupHook` 真实时序；Connecting 期间 kill/dispose 的实际时序与无锁取消竞态；
- 退出：选定 B+ 或 B；A 需单独批准；都不行则停止；C0 结论必须逐版本记录，不能把单次观察写成跨版本保证；
- 不合并、不发 PR、不改生产代码；C0 完成前不进入 C1。

### P3-C1：node-pty 原生（10-15 人日）

- 分支 `feat/terminal-p3c-job-native`；
- 不可变 jobMode；Job 状态机；RAII；drain；有界终态 cache；Connecting/abort 线性化点；有界清理管理器；HANDLE 所有权；受检关闭/等待；startup quarantine；test hooks；
- 退出：native 单测/压力/并发通过；T33A/T33B、T34–T46 全部通过；无句柄泄漏；P3-B legacy 不回归；
- 独立安全审查；不合并。

### P3-C2：backend 生命周期（5-7 人日）

- capability 预检；五事实；`sessionExited`；`abortJob`；cleanupPending；503；disconnect；日志；
- 退出：失败关闭；P3-B 不回归；unit/fake PTY 全绿；UI 能区分 cleaning/ending-unconfirmed/ended-unconfirmed/fully-cleaned；
- 独立审查；不合并。

### P3-C3：测试/打包/真机/安全（8-12 人日）

- 第 12 节全部；源码/Electron/SEA；hash；真机矩阵；截图；安全审查；文档/验收；
- 退出：gating 用例通过；打包证据；用户批准；
- 不合并、不发版。

### P3-C4：上游/维护（2-5 人日 + 审阅）

- upstream PR；rebase/升级/签名 playbook；每次升级跑矩阵。

### 合并/发布门槛

- 每阶段单独审查；C1/C2/C3 高风险，需独立安全审查和用户明确决策。
- 审查/测试通过不等于合并许可；合并、推送、发版分别授权。
- 本轮不开始生产代码开发。

---

## 16. 最终问题回答

### 1. 当前真实架构？

Electron main → backend（`ELECTRON_RUN_AS_NODE=1`）→ node-pty 原生 `PtyConnect` → `CreateProcessW` → shell。`HPCON`、shell 句柄、管道都在 backend 的 `pty_baton`；Electron main 只有 backend 的 `ChildProcess` 句柄。P3-B 在 backend JS 层按 `(pid, creation time, image path)` 复核后 `taskkill /T`。

### 2. 两个 Job 方案对比？

- Plan A：resume 前绑定/验证；但 Assign 前崩溃会留挂起孤儿；受嵌套 Job 检查。
- Plan B：创建时原子绑定；但验证在创建后；与 PSEUDOCONSOLE 组合无文档保证。
- Plan B+：B + CREATE_SUSPENDED + resume 前验证；首选，但三属性组合待 C0。
- 修订政策：B+ 首选；B 仅 C0 + 人工批准；A 不自动，单独批准；B+/B 都不行则停止。

### 3. 最终推荐？

Plan B+，在 node-pty 原生 `PtyConnect` 实现；jobMode 不可变；Job 模式禁止 PID 终止；shell 退出后 drain 验证；清理队列有界。

### 4. 是否 fork node-pty？

是，最小 fork/vendor patched 包；上游 PR 并行。Job 绑定必须在 `CreateProcessW` 处，JS/外部 helper 做不到。

### 5. 是否写独立 C++ 原生模块？

不。改动放进 node-pty `conpty.cc`；独立 helper 需重写 ConPTY/跨进程 HPCON，复杂且解决不了自然退出 hpc 泄漏。

### 6. Electron 44.4.3 / Node 24？

原则上兼容（N-API）；Node 24.22.1 和 Electron 44.4.3 两边都要构建/测试；打包 sidecar/SEA 都要验证。

### 7. Windows 11 x64？

是目标；Windows 10 1809+ / Windows 11；当前 win32-x64；ARM64 不发；Windows 7/8 不支持。

### 8. 其他终端/workspace？

每 PTY 一个独立 Job；停止一个不影响其他；Job 句柄只在 backend baton；P3-B 保留。

### 9. 阶段与验收？

C0 spike → C1 native → C2 backend → C3 tests/packaging/security → C4 upstream；验收见第 12/15 节：创建时绑定、drain 验证、失败关闭、旧二进制拒绝、P3-B 不回归、真机矩阵、独立安全审查。

### 10. 复杂度与风险？

高复杂度/高风险；29-45 人日。主要风险：B+ 组合待 C0；`TerminateJobObject` 成功不等于退出；`CloseHandle`/`TerminateProcess`/`WaitForSingleObject` 失败路径；TSFN/env teardown 与 baton 删除竞态；startup quarantine；KILL_ON_JOB_CLOSE 兜底不可验证；清理 worker 阻塞；嵌套 Job/WMI 逃逸；自然退出行为变化；fork/签名供应链；backend 挂起。

### 最终结论

**当前架构不能可靠实现“每终端独立 Job Object + 创建阶段安全绑定”。** 必须修改 node-pty 的 Windows 原生 ConPTY 创建路径：`src/win/conpty.cc` 的 `PtyStartProcess`/`PtyConnect`/`PtyKill`/退出线程，以及 `windowsPtyAgent.ts`/`windowsTerminal.ts`/`interfaces.ts`/`index.ts` 和打包 staging。

**本轮修订后，设计具备进入 P3-C0 的条件**，但不具备进入 P3-C1 的条件：B+ 组合、conhost 归属、ActiveProcesses 对挂起进程/嵌套 Job 的行为、ClosePseudoConsole 旧版阻塞、`TerminateJobObject` 成功后的退出时间窗、`CloseHandle`/`TerminateProcess`/`WaitForSingleObject` 失败语义、TSFN/env teardown 都必须在 C0 真机验证；自然退出行为、fork/vendor、签名、B 回退需用户批准。C0 完成前不得开始 C1。

如果 B+ 和 B 都不可用，停止 P3-C；不得为了交付回退到 A 或 post-spawn Assign，更不得静默降级为无 Job 的终端。

---

## 附录 A：本轮证据与限制

### A.1 代码证据

| 主题 | 文件/行 |
| --- | --- |
| 终端 spawn/kill 路由 | `server/terminal-process.js:51,99-138,151-218` |
| P3-B 身份四态 | `lib/process-identity.cjs:76-171` |
| session 状态/重试/退出 | `server/terminal.js:41-64,80,311-330,369-406,408-422,484-619,788-808,959-977` |
| Electron backend 生命周期 | `electron/main.cjs:95,140,188-253,425-477,1042-1067` |
| backend shutdown | `server.js:1476-1515` |
| node-pty 原生 | `node_modules/node-pty/src/win/conpty.cc:41-126,245-323,325-456,534-568` |
| node-pty JS | `windowsPtyAgent.ts:49-122,141-196,224-249`; `windowsTerminal.ts:51,164-185`; `terminal.ts:190-196` |
| node-pty 选项/导出 | `typings/node-pty.d.ts:96-110`; `src/index.ts`; `src/utils.ts` `loadNativeModule` |
| 构建 | `node_modules/node-pty/binding.gyp:9,36-48` |
| 打包 | `scripts/node-pty-package.mjs:23-57`; `scripts/build-app.mjs:106-112,246-251`; `scripts/build-exe.mjs:133` |
| P31 Job 先例 | `extensions/pi-gui-process/runner-win.ps1:61-97` |

### A.2 外部文档

- Microsoft Learn：`CreateJobObjectW`、`SetInformationJobObject`、`AssignProcessToJobObject`、`TerminateJobObject`、`IsProcessInJob`、`QueryInformationJobObject`、`UpdateProcThreadAttribute`、`ClosePseudoConsole`、Job Objects、Nested Jobs。
- 第三轮核对的具体页面：
  - Nested Jobs：https://learn.microsoft.com/windows/win32/procthread/nested-jobs
  - `QueryInformationJobObject`：https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject
  - `TerminateJobObject`：https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject
  - `CloseHandle`：https://learn.microsoft.com/windows/win32/api/handleapi/nf-handleapi-closehandle
  - `TerminateProcess`：https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess
  - `WaitForSingleObject`：https://learn.microsoft.com/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject
  - `ClosePseudoConsole`：https://learn.microsoft.com/windows/console/closepseudoconsole
- Windows SDK：`WinBase.h` 的 `ProcThreadAttributeJobList=13`、`_WIN32_WINNT_WINTHRESHOLD=0x0A00`；`WinNT.h` 的 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000`、`BREAKAWAY_OK=0x800`、`SILENT_BREAKAWAY_OK=0x1000`、`JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`；本机 `consoleapi.h:341-346` 确认 `ClosePseudoConsole` 返回 `VOID`。
- Node-API / node-addon-api：`Napi::Env::AddCleanupHook`（封装 `napi_add_env_cleanup_hook`）、`ThreadSafeFunction`、`NonBlockingCall`、`Acquire()`/`Release()`、`napi_closing`/`napi_queue_full`、finalizer 与 env teardown 语义；通过独立的环境清理钩子在 Node 环境 teardown 前同步下发停止信号，打破退出线程与 finalizer 的双向依赖，实现单向受控退出生命周期。
- `CreateProcessW` 的 process-creation-flags 页面本轮抓取失败（域名安全校验），相关 flags 以 Job Objects 文档和 SDK 头文件为准。`TerminateJobObject` 文档说明其效果“如同对每个进程调用 `TerminateProcess`”，而 `TerminateProcess` 文档明确是异步的；本设计据此把 `TerminateJobObject` 成功保守地解释为“终止请求已接受”，不把返回值当进程退出证明。这个保守解释是设计决策，不是文档逐字结论。

### A.3 未做/未核实

- 未修改生产代码、node-pty、`package.json`；未新增依赖；未实现 Job；未删除 P3-B；未建 PR、未推送、未合并、未发版。
- 未运行 `npm test`（纯文档变更）；未运行 C0 spike。
- 未核实上游 node-pty 是否已有 Job PR/issue。
- 本机 VS BuildTools 18/MSVC 14.51.36231 存在，但 Spectre-mitigated libraries 未安装；源码构建当前不可直接完成。
- 本机 Windows 11 26200 不能暴露 `ClosePseudoConsole` 在旧版本的阻塞行为；需要 Windows 10/11 23H2 真机/VM。
- B+ 三属性组合、`ActiveProcesses` 对挂起进程/嵌套 Job（含子 Job 聚合的实际计数）、conhost 是否在 Job、KILL_ON_JOB_CLOSE 对挂起进程，均 `[C0]`。
- `TerminateJobObject` 成功到进程实际退出的时间窗、`CloseHandle` 失败后句柄是否仍有效/可否安全重试、`TerminateProcess` 失败与 `WaitForSingleObject` 三种返回的实际组合，均 `[C0]`；本设计按“失败即 CloseUnconfirmed/quarantine、不重试”保守处理，但不是已实测结论。
- TSFN/异步通知在 Node 24 与 Electron 44 的 env teardown/finalizer 真实时序、`Env::AddCleanupHook` 执行与 `napi_closing` 阶段行为，归入 `[C0]` 通过 T41 真机验证；设计依据 Node-API 官方保证构建单向无锁退出，不依赖未证假设。
- `TerminateJobObject` 对嵌套 Job 子进程的终止范围有官方文档依据，但 `ActiveProcesses` 在目标版本上的精确计数仍以 T40 实测为准；两者不能互相替代。

### A.4 待用户决策

1. 自然退出时关闭 Job、杀掉后台后代，是否接受？还是延迟到标签关闭？
2. fork/vendor node-pty + 预编译 `.node` 的供应链方案是否批准？签名要求？
3. 最低 Windows 版本是否定为 Windows 10 1809+？是否接受受限外层 Job 环境下终端不可用（fail closed）？
4. P3-C 是否包含 `server.js` 的 `disconnect` 父进程死亡处理？
5. 是否接受 B+ 首选、B 仅批准后回退、A 不自动启用？
6. 日志/诊断是否允许记录 `ActiveProcesses` 计数和错误码（不记录 PID 列表/命令行）？
7. 清理队列满时拒绝新终端，是否接受？上限/worker 数量是否有产品要求？
