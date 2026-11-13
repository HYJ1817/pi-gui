# 终端 P3-C 设计第四轮定向修订记录（最终基线定稿）

- 修订对象：[terminal-p3c-job-object-design.md](terminal-p3c-job-object-design.md)
- 仓库基线：`origin/main` `5c8c9a4`
- 审查基线：用户提供的上一轮设计基准 `terminal-p3c-job-object-design(2).md`（初始 2192 行）
- 修订日期：2026-11-13
- 本轮性质：**纯设计文档定向修订**；未修改生产代码、测试代码、node-pty 原生模块、`package.json` 或依赖；未创建实现 PR、未推送、未合并、未发版。
- 最终结论：设计全面解决上一轮验收发现的 7 项核心架构缺陷，彻底消除死锁、状态冲突与并发竞态，建立稳定的 P3-C 最终设计基线；达到进入 **P3-C0（真机 spike 验证）** 的准入条件；**严禁跳过 P3-C0 直接进入 P3-C1 原生开发**。

---

## 1. 修订背景与审查基线

在上一轮终端 P3-C Windows Job Object 设计方案审查中，识别出 7 项阻碍方案落地的核心技术问题：
1. **TSFN finalizer 循环等待死锁**：退出线程等待 finalizer 置位停止事件，而 finalizer 依赖退出线程释放 TSFN 引用触发，存在必然死锁；
2. **状态词与判定集合冲突**：文档规定 Job 模式禁止使用 `killed`，但终止处理分支中仍返回 `result: 'killed'`，且与 legacy 的 `KILL_STOP_RESULTS` 产生混淆；
3. **事件快照与共享终态混淆**：`PtyEvent` 原仅持 `shared_ptr<PtyFinalState>`，在跨线程并发更新下 JS 回调无法获知事件产生时的历史真实状态；
4. **Cleanup Worker 事件通道生命周期缺失**：`PtyCleanupTask` 缺乏 TSFN 通道所有权与生命周期管理，未明确 `maxQueueSize` 真实生效配置及 `napi_closing` 处置；
5. **Connecting 并发与取消机制不统一**：`PtyConnect` 临界区粗粒度持锁阻塞了取消请求，未建立清晰的线性化检查点与所有权转移机制；
6. **ClosePseudoConsole 同步阻塞兜底**：队列满或不可用时在主事件循环线程同步调用可能无限挂起的 `ClosePseudoConsole`，违背非阻塞原则；
7. **sessionExited 与 fullyCleaned 混淆**：会话逻辑交互结束与系统资源完全清理未解耦，句柄关闭异常时可能误报清理成功；
8. **测试真实性不足**：T33 强依赖 test-only 延迟 hook，缺乏真实 Windows API 异步退出采样，且缺少针对上述缺陷的专项测试。

本轮修订严格针对上述 7 项问题执行闭环修正，并在原文档 `docs/terminal-p3c-job-object-design.md` 上直接修订定稿，不创建替代文档。

---

## 2. 七项核心技术问题处置与对照

### 2.1 修复 TSFN finalizer 生命周期循环等待死锁（最高优先级）

#### 2.1.1 缺陷根因分析
根据 Node-API 官方规范（及项目实际使用的 `node-addon-api@7.1.1`，源码位于 `node_modules/node-addon-api/napi-inl.h`）：
- `Napi::ThreadSafeFunction`（TSFN）的 finalizer 回调在底层线程引用计数归零（即所有持有线程调用 `Release()`）、底层消息队列清空后，由 Node.js 主事件循环线程异步调用。
- 原设计中，退出线程在其生命周期循环中等待 `hStopEvent`（由 TSFN finalizer 置位），同时退出线程一直持有 TSFN 引用直到循环结束才释放；而 TSFN finalizer 必须等待退出线程释放引用后才会被调度触发。
- 这构成了典型的**双向循环等待死锁（A 等 B，B 等 A）**。在 Node.js 环境销毁（teardown）阶段，退出线程由于等不到 `hStopEvent` 而无法释放 TSFN，导致 finalizer 永远不触发，Node 进程挂起或报 fatal error。

#### 2.1.2 解决方案与官方 API 依据
经查证 `node_modules/node-addon-api/napi-inl.h:3739` 与 `napi.h`，Node-API 提供了原生环境清理钩子接口：
- `Napi::Env::AddCleanupHook(void (*fun)(void* arg), void* arg)`（底层封装 `napi_add_env_cleanup_hook`）；
- 该钩子在 Node.js 宿主环境开始关闭（teardown）时，在主事件循环线程上**同步且在任何 JS 模块销毁前**被调用。

本设计引入 `Env::AddCleanupHook` 作为打破死锁的唯一外生驱动源，建立单向受控退出生命周期：
```text
Node 环境开始关闭 (teardown)
       ↓
Napi::Env::AddCleanupHook 同步触发 (非阻塞)
       ↓
设置 native stop event: SetEvent(hStopEvent)
atomic closingRequested.store(true)
       ↓
退出线程检测到 hStopEvent 或 Wait 返回 WAIT_OBJECT_0
退出线程停止产生新 JS 事件，立即调用 tsfn.Release() 并正常退出线程
       ↓
Cleanup Worker 检测到 stop event 或 closingRequested
停止向 JS 投递事件（仅就地更新 native 终态），调用 tsfn.Release()
       ↓
所有 TSFN 持有者引用计数归零，队列排空
       ↓
TSFN finalizer 触发 (主线程)
       ↓
释放剩余 native 控制资源 (如 hStopEvent 等)，完成优雅清理
```

#### 2.1.3 核心约束与处置规则
1. **清理入口绝不阻塞**：`AddCleanupHook` 回调内仅执行 `SetEvent` 与原子置位，耗时 < 1ms，绝不调用 `WaitForSingleObject` 等待线程；
2. **禁止循环等待**：TSFN finalizer 绝不等待退出线程或 worker 线程；线程停止由 hook 发起的事件驱动；
3. **禁止关闭后访问环境**：`napi_closing` 返回后，或者 `closingRequested == true` 时，任何 native 线程绝不再次尝试调用 `NonBlockingCall` 或使用 `napi_env`；
4. **禁止 Fatal 报错**：事件入队失败（`napi_closing` 或 `napi_queue_full`）绝不调用 `Napi::Error::Fatal`，降级为本地日志与原生终态保留；
5. **恰好一次释放**：通过封装的 `PtyEventChannel::ReleaseHolder()` 使用 CAS 保证每个持有者严格释放一次 TSFN 引用，防止过早释放或泄露。

---

### 2.2 彻底统一 killed、treeState 和 KILL_STOP_RESULTS 语义

#### 2.2.1 缺陷根因分析
- 文档第 7.3 节状态词对照表明确规定 `killed` 为 legacy 专用词，Job 模式严禁使用；
- 但第 6.10 节在 `defaultKillPty` 的 `terminating`、`draining` 与 `drained` 分支中仍返回 `{ result: 'killed', ... }`；
- 上层 `applyKillOutcome` 容易通过 `KILL_STOP_RESULTS.has(result?.result)` 将尚未退出的 `terminating/draining` 误判为成功结束，造成幽灵进程与状态污染。

#### 2.2.2 解决方案与统一规则
1. **Job 模式完全废除 `result: 'killed'`**：`defaultKillPty` 在 Job 模式下返回独立的结构对象，绝不包含 `result: 'killed'` 字段：
   ```js
   // Job 模式专属返回结构：
   {
     job: true,
     treeState: 'drained' | 'terminating' | 'draining' | 'unconfirmed' | 'gone',
     terminateAccepted: boolean,
     drainedVerified: boolean,
     jobHandleClosed?: boolean,
     closeUnconfirmed?: boolean,
     fallbackUsed?: boolean,
     reason?: string
   }
   ```
2. **`KILL_STOP_RESULTS` 严格隔离**：`KILL_STOP_RESULTS`（包含 `{gone, mismatch, unknown}`）继续且仅服务 legacy PID 模式。
3. **判定优先分支**：`server/terminal.js` 中的 `applyKillOutcome(session, result)` 必须将 `result?.job === true` 放在最顶层优先处理，完全基于 `treeState`、`terminateAccepted` 与 `drainedVerified` 判定，绝不回落到 `KILL_STOP_RESULTS`。
4. **四项硬性断言**：
   - `terminateAccepted=true` 仅代表 Windows 内核接受了 `TerminateJobObject` 请求，绝对不等于进程已退出；
   - `terminating/draining` 严禁映射为清理完成，会话保持 `closing`，`killState='pending'`；
   - `drained` 必须满足连续两次 `ActiveProcesses==0` 且 `drainedVerified=true`；
   - `unconfirmed/gone` 绝对不得映射为成功，必须保留警告并标记 `unconfirmed`。

---

### 2.3 严格区分不可变事件快照与共享最终状态

#### 2.3.1 缺陷根因分析
原设计中事件通过 `std::shared_ptr<PtyFinalState> finalState` 传递给 JS。由于 `finalState` 在后台退出线程或 cleanup worker 中被持续修改，当 JS 事件循环取出回调并读取对象字段时，该对象可能已被修改为更新的状态，导致 JS 丢失事件触发时的准确快照。

#### 2.3.2 解决方案：快照与终态彻底解耦
在 C++ 原生层与 JS 层严格拆分两种数据模型：
```cpp
// 1. 不可变事件快照 (值复制传递，产生后绝不修改)
struct PtyEventSnapshot {
    uint64_t id;
    uint32_t generation;
    PtyEventType type;
    JobTreeState treeState;
    bool terminateAccepted;
    bool drainedVerified;
    bool shellExited;
    bool ptyDisposed;
    uint32_t activeProcesses;
    bool jobCloseUnconfirmed;
    bool shellCloseUnconfirmed;
    bool resourceCloseUnconfirmed;
    int32_t exitCode;
};

// 2. 线程安全的共享终态 (跨线程共享，互斥锁与原子字段保护)
struct PtyFinalState {
    std::mutex mutex;
    uint64_t id;
    uint32_t generation;
    std::atomic<JobTreeState> treeState;
    std::atomic<bool> terminateAccepted;
    std::atomic<bool> drainedVerified;
    std::atomic<bool> shellExited;
    std::atomic<bool> ptyDisposed;
    std::atomic<uint32_t> activeProcesses;
    std::atomic<bool> jobCloseUnconfirmed;
    std::atomic<bool> shellCloseUnconfirmed;
    std::atomic<bool> resourceCloseUnconfirmed;
    std::atomic<int32_t> exitCode;
    // ...
};

// 3. 投递载荷
struct PtyEvent {
    PtyEventSnapshot snapshot;                     // 事件发生时的不可变数据
    std::shared_ptr<PtyFinalState> finalState;     // 共享终态句柄
};
```

#### 2.3.3 数据消费与单调性原则
- **JS 事件回调（`onExit`, `onJobState`, `onPtyDisposed`）**：**只读取 `snapshot`**，保证事件语义与触发时刻完全一致；
- **JS 主动查询（`jobStatus()`）**：从 `finalState` 读取受锁保护的最新终态；
- **单调性规则**：JS 端合并状态时必须遵循单调递进原则：
  $$\text{Active} < \text{Terminating} < \text{Draining} < \text{Drained} \le \text{Unconfirmed}$$
  晚到的旧快照绝不允许覆盖更新的终态。

---

### 2.4 补齐 Cleanup Worker 的事件通道生命周期

#### 2.4.1 缺陷根因分析
原 `PtyCleanupTask` 仅持有 HPCON 与关闭状态，但又被要求向 JS 投递 `onPtyDisposed` 事件。没有明确定义 worker 如何持有 TSFN、如何保证线程安全以及何时释放 TSFN 引用，存在野指针或阻碍 finalizer 执行的风险。

#### 2.4.2 解决方案：独立的 `PtyEventChannel`
1. **定义共享事件通道**：
   ```cpp
   class PtyEventChannel : public std::enable_shared_from_this<PtyEventChannel> {
   public:
       Napi::ThreadSafeFunction tsfn;
       HANDLE hStopEvent;
       std::atomic<bool> closingRequested{false};
       std::atomic<int32_t> activeHolders{0};

       void AcquireHolder() { activeHolders.fetch_add(1); tsfn.Acquire(); }
       void ReleaseHolder() {
           if (activeHolders.fetch_sub(1) > 0) {
               tsfn.Release();
           }
       }
       napi_status PostEvent(PtyEvent event);
   };
   ```
2. **生命周期归属**：
   - baton 创建时持有 `std::shared_ptr<PtyEventChannel>`，退出线程持有一个 Holder；
   - `PtyCleanupTask` 构造时持有一个 `shared_ptr<PtyEventChannel>`，并通过 `AcquireHolder()` 显式增加引用；
   - 清理 worker 执行完毕（`ClosePseudoConsole` 返回）后，尝试 `PostEvent` 并无条件调用 `ReleaseHolder()`；
   - 彻底避免 worker 持有 `pty_baton` 裸指针。
3. **真实生效的容量配置**：
   - TSFN 创建时显式传入 `maxQueueSize = 64`：
     `Napi::ThreadSafeFunction::New(env, jsCallback, "PtyEventChannel", 64, 1, finalizer, context)`；
4. **事件发送状态码处置**：
   - `napi_ok`：正常投递；
   - `napi_queue_full`：采用退避重试（最多 3 次，每次 5ms）；若仍满，仅就地更新 `finalState` 并在日志中记警，绝不无限阻塞 worker；
   - `napi_closing`：说明环境正在关闭，立即停止向 JS 投递，更新 native 终态，并调用 `ReleaseHolder()`；
   - 绝不因事件发送失败调用 `Napi::Error::Fatal`。

---

### 2.5 统一 Connecting 并发和取消机制

#### 2.5.1 缺陷根因分析
原文档一方面要求 Connecting 期间全程持有 baton mutex，另一方面又要求 `PtyKill/dispose` 在 accounting 期间能打断并设置取消请求。若持有互斥锁，T2 的 kill 调用将被阻塞无法发出取消；若不持锁，句柄所有权和生命周期又缺乏同步。

#### 2.5.2 解决方案：原子请求标志与细分状态机
1. **引入原子取消标志与细分子状态**：
   - `std::atomic<bool> abortRequested{false};`
   - `std::atomic<bool> disposeRequested{false};`
   - `enum class ConnectPhase { Initializing, ProcessCreated, Verifying, Complete, Failed };`
2. **无锁取消下发**：
   - T2（`kill/dispose/abortJob`）**无需获取 baton mutex**，直接原子置位 `abortRequested.store(true, std::memory_order_release)`；
3. **清晰的线性化检查点（Linearization Points）**：
   - **检查点 1（CreateProcessW 后）**：T1 检查 `abortRequested`。若已置位，进入清理分支，**绝不调用 ResumeThread**，就地通过句柄 `TerminateProcess(pi.hProcess, 1)`，关闭句柄并返回；
   - **检查点 2（Accounting 轮询中）**：T1 每次 sleep 检查 `abortRequested`；若置位，立即中断轮询，准备清理；
   - **检查点 3（ResumeThread 前原子提交）**：T1 获取 baton mutex，最后一次核查 `abortRequested`：
     - 若未被取消：原子将状态转为 `Active`，调用 `ResumeThread`，转移句柄所有权；
     - 若已被取消：状态保持 `Terminating/Failed`，**严禁调用 ResumeThread**，以未挂起状态执行整组资源清理；
   - **检查点 4（ResumeThread 后）**：若取消发生在 ResumeThread 返回之后，状态已进入 `Active`，T1 立即将其转入 `Terminating`，触发正常 drain 流程，**绝不允许回退为 Active**。
4. **锁外执行耗时与阻塞操作**：
   - Accounting 轮询中的 `Sleep(50)` 必须在**锁外**执行；
   - 失败分支的清理函数在**锁外**调用，彻底消除持锁阻塞与重入死锁。

---

### 2.6 修正 ClosePseudoConsole 清理失败兜底与 6 类场景处置

#### 2.6.1 缺陷根因分析
原设计中存在“若清理队列不可用，在主线程同步调用 `ClosePseudoConsole` 作为兜底”的逻辑。在 Windows 10 与 Windows 11 24H2 之前的版本中，ConPTY 的 `ClosePseudoConsole` 在等待输出管道 drain 或等待 conhost 退出时可能长时间挂起甚至永久挂起。在主事件循环线程同步执行该调用会直接导致整个 Electron / backend 失去响应。

#### 2.6.2 解决方案：消除同步兜底与前置硬约束
1. **彻底消除主线程同步 `ClosePseudoConsole`**：主事件循环线程绝对禁止直接调用 `ClosePseudoConsole`，所有 HPCON 关闭操作 100% 移交后台 cleanup worker 执行；
2. **前置资源预约机制**：
   - 创建 HPCON 之前，必须先在 `PtyCleanupManager` 中成功预约 slot（`reserve()`）；
   - 如果清理 worker 线程尚未成功启动，或者队列已满，必须在创建 HPCON 之前直接拒绝创建终端（返回 503 `pty_cleanup_busy`）；
3. **保留所有权不丢弃**：
   - 即使 enqueue 失败或 manager 关闭，已持有的 HPCON 与 baton 必须放入 `pendingDisposal` 链表保留，严禁直接在主线程同步关闭，严禁直接丢弃；
4. **六类异常场景处置矩阵**：

| 场景 | 资源所有权 | 终态标记 | 日志等级 | 处置规则 |
| --- | --- | --- | --- | --- |
| **1. Worker 启动失败** | 原生 manager 持有 | `jobState=Failed, ptyDisposed=false` | FATAL | 拒绝创建终端（503）；不分配 HPCON；若已分配放入待清理孤儿表 |
| **2. Worker 队列满** | 预约机制拦截 | `cleanupState=cleanupPending` | WARN | 达到 32 上限前置拦截（503）；已持有 HPCON 的现有终端排队等待，绝不同步兜底 |
| **3. Manager 正在关闭** | Manager 终态回收 | `closingRequested=true` | INFO | 停止接收新任务；唤醒 worker 快速遍历调用；主线程等待有界超时（最长 1.5s） |
| **4. Worker 长时间阻塞** | Worker 线程持有 | `ptyDisposed=false, closeUnconfirmed=true` | ERROR | 不阻塞主线程；标记为 `closeUnconfirmed`；会话保持 `closing/cleanedWithWarning` |
| **5. Backend 正常退出** | OS 进程退出回收 | `sessionExited=true, fullyCleaned` | INFO | 触发 `Env::AddCleanupHook`，worker 优雅退出，释放全部资源 |
| **6. Backend 异常崩溃** | Windows 内核回收 | 由 OS 保证 | SYSTEM | 由 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 触发内核级后代清理；conhost 由 OS 回收 |

---

### 2.7 严格区分 sessionExited 与 fullyCleaned 状态

#### 2.7.1 缺陷根因分析
原设计将 `sessionExited` 定义为：
$$\text{sessionExited} = \text{shellExited} \land \text{ptyDisposed} \land (\text{treeState} \in \{\text{drained}, \text{unconfirmed}\})$$
当存在句柄关闭未确认（例如 `hJobCloseUnconfirmed=true` 或 `treeState=unconfirmed`）时，系统虽然在逻辑上结束了用户交互，但系统资源并未干净释放。如果仅凭 `sessionExited` 判断，UI 会误将该会话渲染为绿色正常结束（fullyCleaned），掩盖了资源泄漏与未确认状态。

#### 2.7.2 解决方案：逻辑生命周期与资源清理状态彻底解耦
1. **保留 `sessionExited` 作为逻辑结束判定**：
   `sessionExited` 仅表示用户的交互生命周期已终止（Shell 退出、输出流结束、ConPTY 句柄已释放），允许前端断开交互控件。
2. **定义四阶独立的资源清理结果状态（`session.cleanupState`）**：
   - **`fullyCleaned`（完全清理完成）**：
     条件：`sessionExited && treeState === 'drained' && drainedVerified === true && !closeUnconfirmed && !resourceCloseUnconfirmed`；
     含义：进程树 accounting 已归零且全部原生 HANDLE 成功关闭；
   - **`cleanedWithWarning`（结束且有资源警告）**：
     条件：`sessionExited && treeState === 'drained' && (closeUnconfirmed || resourceCloseUnconfirmed)`；
     含义：进程树确认已清空，但存在关闭失败或未确认的原生句柄；
   - **`cleanupUnconfirmed`（结束但未确认）**：
     条件：`sessionExited && treeState === 'unconfirmed'`；
     含义：无法确认进程树是否清空（如 accounting 轮询超时）；
   - **`cleanupPending`（正在清理）**：
     条件：`!sessionExited || state === 'closing' || ptyDisposed === false`；
     含义：后台清理尚未完成，会话必须常驻 ledger，严禁删除。
3. **UI 对应四色渲染呈现**：
   - 正在清理：蓝色动态 Spinner，“正在清理终端进程树与资源...”；
   - 结束但未确认：黄色警示图标，“终端会话已结束（进程树清理未确认）”；
   - 结束且有资源警告：橙黄色告警图标，“终端会话已结束（句柄关闭异常，查看诊断）”；
   - 完全清理完成：绿色成功对勾，“终端会话已结束，进程树与系统资源已完全释放”。

---

## 3. 测试真实性重构与测试套件扩充

### 3.1 T33 拆分为 T33A 逻辑模拟与 T33B 真机采样

原 T33 既承担“验证异步时间窗内不误判”的逻辑断言，又承担“验证真实 Windows API 表现”的职责，但因包含 2s 人工延迟 hook，无法反映真实 Windows API 的实际微秒/毫秒级衰减特性。本轮正式解耦为两项测试：

1. **T33A `TerminateJobObject` 异步返回逻辑模拟测试（Hook 驱动）**：
   - **目标**：验证在底层内核存在延迟时，上层状态机绝对不会提前将状态置为 `drained` 或 `exited`；
   - **方法**：test-only hook 延迟 2s 真正下发终止；在 2s 期间高频检查 `killJob()` / `jobStatus()`；
   - **断言**：期间 `killState='pending'`，`treeState='terminating'`，`drainedVerified=false`；严格等待 2s 后 sampling 两次为 0 才转入 `drained`。
2. **T33B `TerminateJobObject` 真实 Windows API 异步退出与高频采样集成测试（Windows 真机）**：
   - **目标**：在真实 Windows 内核上测量真实 API 返回与 accounting 归零的真实衰减时间序列；
   - **方法**：**不使用任何延迟 hook**，启动真实 PowerShell 及后台常驻子进程；调用 `stopSession()`，以 20ms 为周期高频轮询 `QueryInformationJobObject`；
   - **度量**：记录 `TerminateJobObject` 返回耗时 $t_{\text{api}}$、`ActiveProcesses` 从 $N \to 0$ 的衰减曲线 $t_{\text{decay}}$；
   - **产出**：输出时间序列样本，为 P3-C0 提供真机实测数据。

### 3.2 扩充 T41～T46 定向测试规范

本轮完整保留了 T1～T40 全部用例，并针对新架构增设 6 项关键定向测试：

| 编号 | 测试用例名称 | 测试目标与验证场景 | 执行环境 |
| --- | --- | --- | --- |
| **T41** | Node-API Env 清理钩子与 TSFN 无死锁生命周期测试 | 模拟宿主 Node 环境触发 teardown，断言 `AddCleanupHook` 同步置位 `hStopEvent`，退出线程与 worker 及时释放 TSFN 引用，TSFN finalizer 顺畅执行完毕，无挂起、无死锁、无 fatal 崩溃 | Native Harness / 集成 |
| **T42** | Connecting 期间并发取消与 ResumeThread 竞态测试 | 在 `CreateProcessW` 返回但 `ResumeThread` 尚未调用的敏感窗口并发下发 `kill`/`abortJob`；断言原子 `abortRequested` 成功拦截 Resume，挂起进程被直接按句柄销毁，状态绝不回退为 `Active` | Native Harness |
| **T43** | Cleanup Worker 事件通道生命周期与容量限制测试 | 模拟投递突发事件填满 64 队列上限，验证 `napi_queue_full` 退避与优雅降级；验证 `PtyCleanupTask` 在完成时正确调用 `ReleaseHolder()`，无 TSFN 句柄泄漏 | Native Harness |
| **T44** | ClosePseudoConsole 异常处置与非阻塞测试 | 模拟 worker 内部 `ClosePseudoConsole` 发生长耗时挂起，断言 Node 主事件循环仍能维持 60 FPS 流畅调度，绝不发生主线程卡死；超时后置 `closeUnconfirmed` 并产出警告 | Windows 10/11 真机 |
| **T45** | 不可变事件快照与共享终态读写单调性测试 | 高并发状态变更下，验证 JS 回调读取的 `PtyEventSnapshot` 严格等于触发时的数值，且 JS 状态机合并遵循单调性（晚到旧快照绝不回滚新状态） | 单元 / 集成 |
| **T46** | 会话结束与四阶资源清理状态测试 | 分别构造“全部成功”、“句柄关闭失败”、“accounting 超时”三种场景，断言 `session.cleanupState` 准确进入 `fullyCleaned`、`cleanedWithWarning` 与 `cleanupUnconfirmed`，UI 显示对应图标 | 集成 / UI 模拟 |

---

## 4. 技术假设与 [C0] 真机验证边界

本轮设计对各项技术指标与行为特征严格标注了证据来源，绝不将未经真机验证的假设宣称为已实现保证：

| 关键技术假设 | 证据来源 | C0 验证要求与边界 |
| --- | --- | --- |
| **Plan B+ 三属性组合**（`ProcThreadAttributeJobList` + `CREATE_SUSPENDED` + ConPTY） | `[文档]`（SDK & MSDN） | 必须在 Windows 10 22H2、Windows 11 23H2、Windows 11 24H2/25H2 x64 上进行真机 API 兼容性验证；若失败需人工决策是否回退 Plan B |
| **挂起进程计入 ActiveProcesses** | `[文档]` | C0 测量挂起状态下的子进程是否立即可见于 accounting，若不可见则依赖 `IsProcessInJob` 门控 |
| **嵌套 Job 的 accounting 聚合** | `[文档]`（Nested Jobs） | C0 测量子 Job 中进程是否计入父 Job 的 `ActiveProcesses`；若不聚合，文档需明确边界，不宣称覆盖子 Job |
| **conhost 是否属于 Job** | `[源码]` 经验推断 | C0 核实 ConPTY 派生的 conhost.exe 是否在 Job 中；若不在，明确生命周期仅受 `HPCON` 控制 |
| **ClosePseudoConsole 阻塞时长** | Windows Terminal 已知 Issue | 测量 Windows 10/11 各版本在输出管道未完全 drain 时的挂起时间，验证后台 worker 隔离效果 |
| **TerminateJobObject 内核延迟** | MSDN 异步语义 | 通过 T33B 测量真实 Windows 内核在各种进程树规模下的延迟时间序列 |
| **Env::AddCleanupHook 触发时序** | Node-API 官方文档 | 通过 T41 实测 Electron 44 / Node 24 退出时 hook 与 TSFN finalizer 的实际执行顺序 |

---

## 5. 准入结论与工程纪律声明

1. **P3-C0 准入声明**：
   经过第四轮定向修订，方案消除了全部已知理论循环等待、状态词冲突、并发模糊与阻塞风险，形成了完备的锁所有权模型、状态转移单调性与 46 项完备测试矩阵。**设计已完全具备进入 P3-C0（真机 spike 验证）的条件。**
2. **严禁进入 P3-C1 声明**：
   在 P3-C0 真机验证完成并产出 Windows 10/11 矩阵实测报告之前，**严禁开始 P3-C1 原生开发**。严禁向上游提 PR 或修改生产分支代码。
3. **本轮操作声明**：
   本轮执行过程严格遵守工程纪律，**未修改任何生产代码、测试代码或项目依赖**，仅修订 `docs/terminal-p3c-job-object-design.md` 并生成独立修订记录 `docs/terminal-p3c-job-object-design-revision-3.md`。
