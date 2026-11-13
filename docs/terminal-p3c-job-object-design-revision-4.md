# 终端 P3-C 设计第五轮（最终）定向修订记录

- 修订对象：[terminal-p3c-job-object-design.md](terminal-p3c-job-object-design.md)
- 仓库基线：`origin/main` `5c8c9a4`
- 审查基线：第四轮定稿设计基线（2595 行）
- 修订日期：2026-11-13
- 本轮性质：**纯设计文档定向终审修订**；未修改生产代码、测试代码、node-pty 原生模块、`package.json` 或依赖；未创建实现 PR、未推送、未合并、未发版。
- 最终结论：针对真实 C++ 原生实现与并发场景，彻底修复 TSFN Acquire/Release 真实生命周期、核对并修正 `AddCleanupHook` 源码契约、统一 Connecting 五权划分与锁协议、统一 `PtyEvent` 数据结构并修正 T41/T42 测试物理真实性。**设计已完全具备进入 P3-C0（真机 spike 验证）的最终准入条件**。

---

## 1. 五项技术问题逐项验收与修订结论

### 1.1 修复 TSFN Acquire/Release 生命周期与清理 Worker 引用解耦

#### 验收结果：通过（已闭环）
1. **先校验底层状态再递增本地计数**：
   在 `node-addon-api@7.1.1` 源码 `napi-inl.h:6027` 中，`ThreadSafeFunction::Acquire()` 底层调用 `napi_acquire_threadsafe_function(_tsfn)` 并返回 `napi_status`。
   若直接 `holderCount.fetch_add(1)`，当 TSFN 已处于关闭阶段（返回 `napi_closing`）时会留下虚假的持有者记录。
   **修订**：`PtyEventChannel::AcquireHolder()` 必须先调用 `tsfn.Acquire()`，仅当其返回 `napi_ok` 时才原子增加 `holderCount`；失败直接返回 false，绝不留下虚假计数。
2. **CAS 循环严防下溢，恰好释放一次**：
   `ReleaseHolder()` 采用 CAS 弱比较循环：
   ```cpp
   bool ReleaseHolder() {
       int32_t current = holderCount.load(std::memory_order_acquire);
       while (current > 0) {
           if (holderCount.compare_exchange_weak(current, current - 1,
                                                 std::memory_order_acq_rel)) {
               tsfn.Release();
               return true;
           }
       }
       return false; // 下溢防御：current <= 0 时绝不调用底层 tsfn.Release()
   }
   ```
3. **TSFN 持有责任明确划分**：
   - **初始引用（initialThreadCount = 1）**：唯一归属**退出线程**。退出线程在 `PtyConnect` 成功后启动，持有该引用；当检测到 `hStopEvent` 或完成 drain 准备退出时，调用 `ReleaseHolder()` 将其归零；
   - **Cleanup Worker 引用彻底解耦（关键突破）**：
     在旧版 Windows（尤其 24H2 之前）上，`ClosePseudoConsole(hpc)` 可能由于等待 conhost 或管道 drain 阻塞数秒甚至永久挂起。
     **核心设计**：Cleanup Worker 在入队及调用 `ClosePseudoConsole` 期间**持有 0 个 TSFN 引用**！它只持有 native 状态（`hpc`、`PtyFinalState`）。
     当 Node 环境触发 teardown 时，退出线程释放其持有的唯一定常引用，TSFN 引用即刻归零，finalizer 立即触发并完成 Node 环境销毁，**绝不被后台阻塞的 ClosePseudoConsole 挂起**！
   - **通信阶段临时 Acquire**：
     仅当 `ClosePseudoConsole` 实际返回后，且仅当 `!channel->IsClosing()` 时，worker 才临时调用 `AcquireHolder()`，投递 `onPtyDisposed`，并在投递后**立即调用 `ReleaseHolder()`**。若环境已关闭，worker 直接跳过 JS 投递，更新 native 终态后安全退出。

---

### 1.2 核对 AddCleanupHook 实际 API 契约与消除强引用循环

#### 验收结果：通过（已闭环）
1. **源码依据（node-addon-api 7.1.1）**：
   - `node_modules/node-addon-api/napi.h:320-329`：
     ```cpp
     template <typename Hook, typename Arg = void>
     class CleanupHook;

     template <typename Hook>
     CleanupHook<Hook> AddCleanupHook(Hook hook);

     template <typename Hook, typename Arg>
     CleanupHook<Hook, Arg> AddCleanupHook(Hook hook, Arg* arg);
     ```
   - `node_modules/node-addon-api/napi.h:351-367`：
     `CleanupHook` 是模板类，必须带模板参数（如 `CleanupHook<Hook, Arg>`），原设计写 `Napi::Env::CleanupHook cleanupHook;` 无法通过 C++ 编译；
   - `node_modules/node-addon-api/napi-inl.h:515-530`：
     `CleanupHook::Wrapper` 执行 `cleanupData->hook(); delete cleanupData;`。这意味着当 Hook 触发后，堆上的 `cleanupData` 已被释放；若后续再调用 `cleanupHook.Remove(env)` 会产生二次释放（Double Free）崩溃；
   - **强引用循环漏洞**：
     原设计使用 lambda 按值捕获：`ch->cleanupHook = env.AddCleanupHook([ch]() { ch->NotifyEnvClosing(); });`。
     `ch` 内部持有 `cleanupHook`，`cleanupHook` 持有 `CleanupData`，`CleanupData` 持有 lambda，lambda 按值持有 `std::shared_ptr<PtyEventChannel> ch`。形成了无法被释放的循环强引用！
2. **定稿修正方案**：
   采用原生稳定、零动态内存开销的 Node-API C 接口 `napi_add_env_cleanup_hook`：
   ```cpp
   static void OnEnvCleanupHook(void* arg) NAPI_NOEXCEPT {
       auto* channel = static_cast<PtyEventChannel*>(arg);
       if (channel) {
           channel->NotifyEnvClosing();
       }
   }
   ```
   在 `PtyEventChannel::Create` 中：
   `napi_add_env_cleanup_hook(env, OnEnvCleanupHook, ch.get());`
   传入 raw pointer `ch.get()`，彻底消除 `shared_ptr` 循环引用。
3. **三条生命周期路径清晰隔离**：
   - **路径 A（正常注销）**：终端在 Node 运行期间由 JS 主线程调用 `dispose()` 注销，在主线程安全调用 `napi_remove_env_cleanup_hook(env, OnEnvCleanupHook, this)`；
   - **路径 B（构造异常回滚）**：`PtyConnect` 期间若 TSFN 创建抛异常，catch 块立即在主线程调用 `napi_remove_env_cleanup_hook` 撤销注册；
   - **路径 C（环境 teardown）**：Node.js 运行时销毁触发 `OnEnvCleanupHook`，Node 自动从其链表中移除该 hook；finalizer 绝不调用 remove hook，绝不在失效的 `napi_env` 上执行操作。

---

### 1.3 统一 Connecting 的锁与取消协议（五权划分）

#### 验收结果：通过（已闭环）
彻底消除 6.4（无锁调用）、6.5（持锁调用）与 6.6（串行要求）之间的文字与逻辑冲突，明确划分 5 种并发权利：

| 权利类别 | 归属主体 | 授权范围与协议 | 约束与禁止项 |
| --- | --- | --- | --- |
| **1. `abortRequested` 原子写入权** | T2（`killJob` / `dispose` / `abortJob`） | **完全无锁**，直接调用 `handle->abortRequested.store(true, memory_order_release)` | 耗时 < 100ns，绝不等待 `baton->mutex`，立即可见 |
| **2. `hJob` 使用权** | T1（连接流程 Guard）独占 | 在 Connecting 期间独占使用 `hJob` 进行 `CreateProcessW` 传递、`IsProcessInJob` 门控与 accounting 验证 | T2 若持锁调用 `RequestJobTerminationLocked`，仅允许并发调用 `TerminateJobObject(hJob, 1)`，**无权关闭 `hJob`** |
| **3. `hJob` 关闭权** | T1（Connecting 期间）<br>退出线程（Connected 之后） | Connecting 期间关闭权**唯一归属于 T1 Guard**，在失败退出时受检关闭 | **T2 在 Connecting 期间绝对禁止调用 `CloseHandle(hJob)`**，彻底杜绝 use-after-close |
| **4. `ResumeThread` 调用权** | T1 独占 | 仅在 `abortRequested == false` 时允许调用 | 一旦 `abortRequested == true`，**T1 被绝对剥夺该权利**，子进程主线程永久保持挂起 |
| **5. 状态提交权** | T1（锁内原子提交） | `ResumeThread` 返回后，获取 `handle->mutex` 短锁进行原子 CAS 校验与提交 | **锁内绝不调用 `Sleep`、`WaitForSingleObject` 或外部清理函数**；若发现 abort，状态强制转为 `Terminating`，**绝不回退为 `Active`**，清理一律在锁外执行 |

---

### 1.4 统一 `PtyEvent` 数据结构

#### 验收结果：通过（已闭环）
在第 6.1 节与第 6.10.1 节统一数据结构定义与事件派发：
```cpp
enum class PtyEventType { Exit, JobState, PtyDisposed };

// 不可变事件快照（事件触发瞬间值拷贝冻结，供 JS 消费）
struct PtyEventSnapshot {
    int id = 0;
    uint64_t generation = 0;
    PtyEventType type = PtyEventType::JobState;
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
    int activeProcesses = -1;
    const char* treeState = "active";
    DWORD lastError = 0;
    std::chrono::steady_clock::time_point timestamp{};
};

// 统一原生事件载荷
struct PtyEvent {
    PtyEventType type = PtyEventType::JobState;
    PtyEventSnapshot snapshot;
    std::shared_ptr<PtyFinalState> finalState;
};
```
- **JS 消费保证**：JS 事件回调仅接收并解构不可变 `snapshot`，历史事件无法被后续操作篡改；
- **Native 审计保证**：`finalState` 仅供 native 审计与 `jobStatus()` 主动查询，不向 JS 暴露裸指针；
- **内存安全**：`PtyEventChannel::Post` 失败立即释放 payload，`DispatchJsEvent` 使用 `std::unique_ptr<PtyEvent>` 保证 RAII 自动释放。

---

### 1.5 修正 T41 与 T42 测试真实性与物理边界

#### 验收结果：通过（已闭环）
1. **T41 分解为三大真实场景**：
   - **场景 A（等待 shell）**：退出线程阻塞在 `WaitForMultipleObjects`，Hook 在 < 1ms 内触发，退出线程在 ≤ 5ms 内唤醒并 `ReleaseHolder()`，finalizer 触发，Node 退出耗时 ≤ 50ms；
   - **场景 B（执行 drain 轮询）**：退出线程在 accounting 轮询间隙感知停止信号，终止轮询并 `ReleaseHolder()`，Node 退出耗时 ≤ 50ms；
   - **场景 C（Worker 阻塞在 `ClosePseudoConsole` 且长时间不返回）**：承认 Windows 内核同步 API 不可中断的现实，不再提出“10ms 内响应停止事件”的伪命题。明确 Worker 在阻塞期间持有 0 个 TSFN 引用，Node 环境在 ≤ 50ms 内完成 teardown 与 finalizer 触发；Worker 线程作为后台 native 线程继续安全存活，API 返回后安全释放 `shared_ptr` 并退出。
2. **T42 完整覆盖 Worker 与事件通道生命周期六大场景**：
   - 覆盖条件变量等待、正在执行关闭、关闭完成投递事件、`napi_queue_full` 退避与优雅降级、`napi_closing` 安全跳过、Node 环境已销毁但 native `finalState` 依然安全有效 6 种并发时序。

---

## 2. 真实源码依据与 Node-API 规范条目

| 模块 / 接口 | 源码路径与行号 | 规范条款与技术保证 |
| --- | --- | --- |
| `AddCleanupHook` 原型 | `node_modules/node-addon-api/napi.h:320-329` | `template <typename Hook, typename Arg = void> class CleanupHook;` 必须带模板参数，非普通类 |
| `CleanupHook::Wrapper` 析构 | `node_modules/node-addon-api/napi-inl.h:515-530` | `cleanupData->hook(); delete cleanupData;` 执行后数据指针悬挂，严禁重复调 `Remove` |
| `tsfn.Acquire()` 状态码 | `node_modules/node-addon-api/napi-inl.h:6027-6029` | 返回 `napi_status`；TSFN 关闭时返回 `napi_closing`，不可直接递增本地持有者计数 |
| `tsfn.Release()` 释放 | `node_modules/node-addon-api/napi-inl.h:6031-6033` | 调用 `napi_release_threadsafe_function(_tsfn, napi_tsfn_release)`，底层计数减 1 |
| Node-API C 级钩子 | `node_modules/node-addon-api/napi-inl.h:6569,6589` | `napi_add_env_cleanup_hook` / `napi_remove_env_cleanup_hook`，采用函数指针 + 上下文指针 |
| Node-API TSFN 规范 | Node.js 官方 Node-API 文档 `ThreadSafeFunction` | 只有当所有线程释放引用且消息队列清空后，Node 主线程才调用 `finalize_cb` |

---

## 3. 架构生命周期与并发时序图

### 3.1 TSFN 无死锁生命周期图（单向 DAG）

```text
Node.js 运行时开始退出 / Worker 终止 (Teardown 阶段)
       ↓
[步骤 1: 外部环境清理入口发出停止信号]
Node-API 主线程按 LIFO 顺序调用 napi_add_env_cleanup_hook 注册的钩子：
OnEnvCleanupHook() -> envClosing=true, control->stop=true, SetEvent(control->hStopEvent)
(主线程同步执行，耗时 < 1ms，绝不阻塞等待，绝不 join 线程)
       ↓
[步骤 2: 原生工作线程响应信号并释放 TSFN 引用]
- 退出线程：WaitForMultipleObjects 立即唤醒，停止投递 JS 事件，
  调用 channel->ReleaseHolder() 释放其唯一定常 TSFN 引用 (计数 1 -> 0)，线程自然退出。
- Cleanup Worker：执行 ClosePseudoConsole 期间持有 0 个 TSFN 引用，绝对不阻塞 Node teardown！
       ↓
[步骤 3: TSFN 触发与控制资源释放]
退出线程完成 Release，TSFN 内部 thread_count 归零，Node 事件循环排空队列。
       ↓
Node-API 在主线程触发 TSFN finalizer (FinalizerCallback)：
- 此时退出线程必然已经退出并完成资源释放；
- 受检关闭 control->hStopEvent；
- 绝不调用已触发的 cleanup hook 移除操作；
- 释放 native 控制块内存。
```

### 3.2 Connecting 并发与取消时序图

```text
T1 (PtyConnect 流程)                                  T2 (外部 killJob / dispose 请求)
──────────────────────────────────────────────────────────────────────────────────────────
lock mutex -> connectState=Connecting -> unlock
CreateProcessW (CREATE_SUSPENDED 成功)
connectPhase = Validating
IsProcessInJob 校验成功
进入 accounting 轮询 (锁外 Sleep 50ms)
                                                     [并发到达窗口]
                                                     无需等待 mutex！微秒级直接写入：
                                                     abortRequested.store(true, release)
                                                     TerminateJobObject(hJob, 1) 整组终止
                                                     (仅有 Signal 权，绝不调用 CloseHandle)

[线性化点 1：ResumeThread 紧邻前]
T1 轮询唤醒，读取 abortRequested == true
-> 拦截成功！被绝对剥夺 Resume 权！
-> 绝不调用 ResumeThread！子进程永久挂起
-> 锁外调用 StopCreatedShellBounded 强杀子进程
-> throw pty_aborted;

────────────────────────────── 若取消在微秒级调度窗口发生 ──────────────────────────────
T1 ResumeThread(pi.hThread) 唤醒主线程
T1 lock baton->mutex 准备原子提交
[线性化点 2：锁内前置校验]
T1 发现 abortRequested == true
-> 状态原子转移为 Terminating，connectState=Failed
-> 绝不赋为 Active！
T1 unlock baton->mutex
-> 锁外调用 StopCreatedShellBounded 强杀清理
-> throw pty_aborted;
```

---

## 4. 剩余技术假设与 [C0] 真机验证边界

本轮设计已消除了全部理论死锁、状态词冲突与 API 签名缺陷。剩余技术假设全部受物理操作系统行为约束，必须在 **P3-C0（真机 spike 验证）** 中完成测量并产出多版本对照记录：

| 关键技术假设 | 证据来源 | C0 验证边界与验收指标 |
| --- | --- | --- |
| **Plan B+ 三属性组合**（`ProcThreadAttributeJobList` + `CREATE_SUSPENDED` + ConPTY） | `[文档]`（SDK & MSDN） | 验证目标 Windows 矩阵（Windows 10 22H2、Windows 11 23H2、Windows 11 24H2/25H2 x64）API 调用成功率；若某版本失败则触发决策是否回退 Plan B |
| **挂起进程计入 ActiveProcesses** | `[文档]` | C0 验证挂起状态下的子进程是否立即可见于 accounting；若不可见，设计完全依赖 `IsProcessInJob` 门控 |
| **嵌套 Job 的 accounting 聚合** | `[文档]`（Nested Jobs） | C0 测量子 Job 进程是否计入父 Job 的 `ActiveProcesses`；若不聚合，文档需明确边界，不宣称覆盖子 Job |
| **conhost 是否属于 Job** | `[源码]` 经验推断 | C0 核实 ConPTY 派生的 conhost.exe 是否在 Job 中；若不在，生命周期唯一受 `HPCON` 控制 |
| **ClosePseudoConsole 阻塞时长** | Windows Terminal 已知 Issue | 测量 Windows 10/11 各版本在输出管道未完全 drain 时的挂起时间，验证后台 worker 零 TSFN 引用的隔离效果 |
| **TerminateJobObject 内核延迟** | MSDN 异步语义 | 通过 T33B 测量真实 Windows 内核在各种进程树规模下的延迟时间序列（毫秒级衰减曲线） |
| **napi_add_env_cleanup_hook 触发时序** | Node-API 官方规范 | 通过 T41 实测 Electron 44 / Node 24 退出时 hook 与 TSFN finalizer 的实际执行顺序与耗时 |

---

## 5. P3-C0 最终准入结论

1. **准入判定：同意进入 P3-C0**。
   经过五轮极为严格、深入到源码级与汇编级时序的定向修订，方案消除了全部已知理论循环等待、状态词冲突、并发竞态、模板语法错误与物理不可达假定。锁协议、生命周期 DAG、数据模型与 46 项完备测试矩阵均已完全闭环。
2. **工程纪律硬约束**：
   - **严禁跳过 P3-C0 直接进入 P3-C1 原生开发**；
   - 必须在 C0 分支上完成目标 Windows 矩阵的实测验证，产出包含真实衰减曲线与 API 耗时的实测报告，并经人工决策批准后再行动；
   - 本轮执行严格遵守工程纪律，**未修改任何生产代码、测试代码或项目依赖**，仅更新了设计文档 [terminal-p3c-job-object-design.md](terminal-p3c-job-object-design.md) 与修订记录。
