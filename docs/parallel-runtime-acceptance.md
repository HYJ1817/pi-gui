# 多会话并行运行机制专项修复 · 验收记录

> 状态：修复实现已提交，最终真实模型专项未通过，按待验收 Draft 交付。定向测试不等于完整验收；完整 canonical 与最终独立闭合尚欠证明。没有合并或发布许可。

## 1. 身份、范围和勘察结论

- 日期：2026-11-26；分支 `fix/parallel-session-runtime`。
- before HEAD：`ac812c6fa49dfd960867a5688ee6f61cb8ec5f67`。
- 基线完整证明：[main push CI 45711901260](https://github.com/HYJ1817/pi-gui/actions/runs/45711901260)，上述精确 SHA，attempt 1，success，8/8 jobs（含五组 canonical、build-check 和 gate）。该证明只覆盖基线。
- 行为提交：`7a277aeb2e19459799a3d9202687b757c8c3c2ea`。测试基建提交 `d5878103ded34bd5aad67b165bb3b0a97de02387`，证据报告另按回滚边界提交；报告自身可用 `git log -1 --format=%H -- docs/parallel-runtime-acceptance.md` 定位，后续报告提交不冒充行为提交。
- 与本任务无关的初始未跟踪文件全部保留；不清理、不纳入本次提交（如 `.t3-ref/`、`spike/`、根目录 `.obj/.lib/.exp` 和旧 `tmp-*.log`）。
- 风险：高。触及外部 Pi 能力识别与共享项目写工具的准入，但不改变 Pi 本体、凭据、会话 schema、资源上限或 UI 视觉。

**现有抽象足以承载真正并行**：`runtime-registry.js` 已拥有 conversation、owner、generation、事件序号和资源预算；`session-runtime.js` 为每个 Runtime 创建独立 Pi child、guardian、RPC、活动与审批状态。经典聊天另有一条 Pi 运行线，不是所有 Runtime 共享的执行单例。选中视图与运行所有权已经分开。

因此不新建 Runtime Registry、不引入线程池/数据库/依赖，也不把任务串到一条全局 FIFO。修复既有工具协调器的生产能力门槛，以及已经接受 A、但其 prepare/hello 尚未完成时新建 B 的启动竞态；补充此前被 `supported:true` fixture 和预先等待 ready 跳过的完整路径。

## 2. 已证实根因与完整链路

### 2.1 准确启动身份与可重复失败

只读使用与应用相同的 `createEnvironmentStore().effectivePiBin()`、`applyManagedPath()` 与 `createPiLaunch()`，实测：

```json
{"source":"path","launch":{"source":"path","binName":"pi","entryKnown":true,"packageDirKnown":true},"version":"1.6.0","officialEntry":true,"guardVersionAllowed":false}
```

不是用另一次 `pi --version` 猜测应用入口。原 `session-tool-bridge.js:capable()` 只接受 1.2.0/1.3.0；实际启动包 1.6.0 被无条件拒绝，即使所需公开 hook/API 均存在。后果：

1. `rpc-bridge.start()` 调用 `toolLaunch.prepare()`，得到 null，未注入私有工具协调扩展。
2. 同项目已有 classic/runtime 的 `sharedAdmission` 检查真实 guard ready，失败返回 `tool_guard_unavailable`，新会话不能启动。
3. Classic 的单线发送原本不以 primary tool guard 为门槛，因此可能出现 **Classic A 仍在跑、同项目 Runtime B 启动被拒绝**，与用户症状吻合。Runtime A 则不同：`session-runtime.send()` 对 project workspace 的 prompt/steer/follow_up 先要求 guard `assertReady()`，因此第一条 Runtime 本身也可能被拒绝；输入按既有前端逻辑保留。
4. 这不是必须增加并行池的证据；也不能通过删除写保护解决。

新增生产 gate 回归使用临时 Pi 1.6.0 契约 fixture，不依赖本机 Pi。将 HEAD 原 bridge 在 TEMP 中执行同一新增测试，首项稳定失败：`compatible 1.6 package was incorrectly rejected`；修复实现通过。原测试全部 `supported:true`，没有覆盖该生产分支。

### 2.2 独立的启动竞态

`RuntimeRegistry.launchRecord()` 返回 accepted 时只建立了 adapter 并调用 start，并不保证异步
prepare 已安装 token 或原生 hello 已完成。原 `sharedAdmission` 对已有 Runtime 只同步检查
`toolGuard.ready()`，立即创建同项目 B 会误拒绝；旧 integration 自己先等待 A guard，藏住此窗。
仅加 `await toolGuard.assertReady()` 也不充分：token 尚未安装时该方法会立即 fail。

本次沿现有 adapter 新增 `assertToolGuardReady()`：最多 30 秒等待本 child 的控制面 startup
和 native binding，然后仍调用原私有 hello 证明，await 前后重验完整 owner；初始 null
sessionId 仅允许首次绑定，既有非空身份不能漂移。Classic 同根分支也有有界 startup 等待与
owner 重验。生产和 integration 共用 `ordinary-sessions.js:assertSharedSessionTools()`，不在
fixture 里另写一份更宽松的 admission。等待后 Registry 再验目标 workspace 与 maintenance。

新增回归在 A accepted、token 尚未安装时立即创建 B，无人工 sleep/重试。将精确基线
`server.js` 的 Runtime admission 闭包取出，在同一真 guardian 子进程 fixture 中执行，
旧逻辑因 `tool_guard_unavailable` exit 1；修复逻辑通过。共享根 startup 等待是控制面准入，
不是等待整个模型回合，也不阻塞已运行会话的 RPC/Stop/流式事件。

### 2.3 真实窗口验收发现的项目恢复错接

第三轮正常沙箱的打包 Electron 已完成三条真实模型运行重叠与工具/Stop/历史等 29 项，
但项目 B 的 restart 返回失败，旧 child 关闭后记录停在 dormant。保留该轮 **29/31，未通过**；
随后在原 TEMP 以真实 Pi、零 prompt 的控制面复现得到闭合错误码 `unknown_workspace`，
不是模型供应商故障。根因是 `Registry.resume()` 把 `project-*` 身份交给仅认识 Worktree 的
`worktrees.withWorkspace()`，而 initial open 已经正确走普通项目 resolver。

本次复用 `ordinary-sessions.js` 权威：Registry 仅向后端 admission 传递持久记录的 workspace
和 native sessionId；组合根对该 target 选择 `withResume()`，重验项目登记、workspace epoch
与 Classic 当前 native session 占用；再由既有 Registry 核全量 workspace 字段、工具协调、
maintenance、总预算与实际 native locator。初始 `start` 和 Worktree admission 不变。
不能为了恢复成功跳过这些门槛：应用重启后 Classic 可能已续接某个 native 会话，此时它的
独立 Runtime resume 必须返回 `session_in_use`，选择未被占用的记录才能显式恢复。

新增八个离线 case：旧代码先稳定返回 `unknown_workspace`；修复后验证 restart 同 native /
新 runtime generation、旧 owner 拒绝、Classic 占用/身份未知、登记撤销、目录替换、guard/维护/预算、
backend dormant 后显式 resume。另有红回归证明 Classic 在 sharedAdmission 等待期间续接目标时，
仅 resume 初检不够；现在 `launchRecord` 在等待后把 record native sessionId 一并交给原
`validateWorkspace` 权威复核，在创建 live owner/child 之前拒绝 `session_in_use`，未知 native
也不能视为可用。真实新产物补验结果见专项证据，不能由这些 fixture 代替。

### 2.4 异步准入证明失效与 Classic 私有切换窗口

第二轮增量审查确认 I-1：逐一 await 已有 child 的 guard 后，再 await workspace/native
校验时，较早的 guard、Classic cwd 或 owner 可能已被撤销；旧代码仍会创建 child。
第三轮恢复审查进一步以 TEMP 故障注入证实 R-1：最终 `get_state` 的旧答复在途时，
Classic 可先通过 `switchTo`，而私有 `switch_session` 应答不广播，`primaryNativeSession`
及 hello 仍暂存旧值。只同步比较 owner/guard 仍可能让 Classic 与恢复 child 同持一个 native。

修复复用已有权威而非新锁/Registry：

- adapter 的 `assertToolGuardReady()` 返回同步 proof closure；共享准入收集所有 proof，
  Registry 在最后异步验证后、live 登记和 factory 之前立即重验，缺少 closure 也 fail-closed。
- Classic proof 同时绑定 cwd、完整 owner、guard 和已有 `rpc.providerSessionEpoch()`；
  该 epoch 在私有/公开 new/switch/fork 发出及成功应答时变化，不能用缓存 native 替代。
- 已发送但尚未完成的会话变更也不能当成稳定身份：复用 RPC 原 `updateCommands` 账本登记
  私有 mutation，`providerSessionChanging()` 只派生查询该账本，不另建运行事实源。
  超时不等于未切换，保留未知在途，直到权威应答或进程清理；普通只读请求不被当作 mutation。
- 上游 Pi 1.6.0 `rpc-mode.js:614–664` 对输入采用 `void handleInputLine(line)`，不是将所有
  RPC 完整串行等待；因此不能假定后发 get_state 一定等待早发 switch 完成。
- 第三轮 R-2：恢复扫描所有已登记项目时会被无关已卸盘项目阻断；`withResume` 改为直接验证
  后端保存的目标 cwd/完整 workspace/native，仍核登记与目录 epoch，不再依赖无关项目可读。

作者最终回归已覆盖较早 Runtime proof 撤权、Classic 换根/换代/guard 撤权、私有切换发出/
完成/预先在途、缺 proof，以及无关失效项目。第三轮独立报告是在上述最终修改前形成，
其中 R-1/R-2 原复现仍保留；修复状态为“作者已修复并定向验证，最终独立闭合未验证”，
不把原不通过报告改写为通过。按 REVIEW 的三轮收敛约定不再自动启动第四轮泛审查。

### 2.5 发送、事件和持久化责任

| 阶段 | 权威模块/函数 | 归属与约束 |
| --- | --- | --- |
| 创建/历史绑定 | `ordinary-sessions.js` → `runtime-routes.js` → `RuntimeRegistry.openProjectSession/launchRecord` | 服务端证明项目、cwd、workspace epoch、native session locator；浏览器不指定文件路径或锁 owner |
| 输入提交 | `public/runtime-conversation.js` → `api.runtimeSessionAction` | 捕获目标 conversation/完整 owner；异步回写仍核对目标，不随当前选中项漂移 |
| 执行分发 | `runtime-registry.js:command` → `session-runtime.js:send` | 只阻止同一个 Runtime 重复 prompt，其他会话独立准入；等待工具不是全局任务锁 |
| 外部进程 | `session-runtime.js:createSessionRuntime` → `rpc-bridge.js` → `pi-supervisor.js` | 每会话固定 cwd、私有 RPC pending、Pi child 与 guardian；不改变 Pi 程序 |
| 工具准入 | `session-tool-bridge.js` + `extensions/pi-gui-tool-guard/index.js` | 每 child 私有 token、原生 session hello；工具开始前 await 写租约，执行结束/权威 settled 才释放 |
| 工具冲突 | `session-tool-scheduler.js` | canonical root、目录对象身份与路径重叠判定；不同项目独立；同/重叠项目写工具排队；已证明 builtin read 可旁路 |
| 事件投影 | `session-runtime.js:projectRuntimeEvent` → Registry emit → SSE | backend/runtime/generation/native session/bridgeRun/eventSequence；工具参数与结果不作为诊断原样归档 |
| 前端归并 | `app.js` → `runtime-state.js` → `runtime-store.js` | 按 owner/事件序号归并每会话文本、thinking、工具和审批；selected view 仅决定展示 |
| Pi 持久化 | Pi 自己的原生 session JSONL | GUI 不改 session schema；列表/历史按 cwd 与 native 身份只读；Runtime manifest 保存会话身份而非原始内容/PID |
| Stop/退出 | Registry command/retire → adapter abortAndWait/dispose → guardian | 仅停止目标运行线，等待权威确认；未确认 cleanup 不释放活动写租约 |
| 应用重启 | Registry manifest + `runtime-recovery.js` | 恢复为 dormant/只读历史，不复用旧进程、不重放旧审批，不擅自续调模型 |

## 3. 修复机制与安全边界

- `pi-probes.js:probeSessionToolGuard()` 只读实际 launch 包的两个已知声明文件，每文件 512 KiB 上限；不 import Pi、不执行源码、不 spawn、不访问网络。
- 按公开契约核验异步 `ExtensionHandler`、`session_start`、可阻断 `tool_call`、`tool_result`、`tool_execution_end`、`agent_settled`、`getAllTools()`、`getSessionId()`，不按版本白名单或版本大小推断支持。
- 缺文件/超限/不可读 → unknown；读到但缺必需契约 → false。两者都不注入并保持 fail-closed。
- 同一 probe 供生产准入和 diagnostics 使用，避免两处对同一包各说各话。该 source verdict **不是** runtime ready；仍须私有 token 和 authoritative native sessionId 的真实 hello，重启/身份漂移/扩展错误保留失效路径。
- 仅改变能力识别，不增加资源上限；默认两个运行名额，第三个仍显式确认，总硬上限三个（计 classic 与其他既有外部任务）。
- 仅协调合作工具调度，不是 OS sandbox/任意文件事务。未知工具与 Shell 保守占 workspace 写 lease；这不能可靠阻止脱离父工具生命周期的子进程、用户外部编辑、其他程序、跨根路径副作用或全局 Git/网络副作用。不声明“所有 Shell/Git 已完全协调”。
- 同 workspace 的不相关写文件仍可能串行，这是既有保守工具策略，不是模型请求/整个会话的全局串行。

## 4. 参考源码

- [T3 Code 固定源码研究](parallel-runtime-reference-t3.md)：commit `d5d5c17ecb1c7289dc50a6ac602197560e8668bf`，包 `t3` 0.1.12，MIT；下载与源码路径/函数/调用链见报告。借鉴 thread/run/provider session 独立归属、RPC ACK 与回合终态区分、迟到事件多层 guard；不移植 Effect/SQL/跨供应商恢复。
- [PI-Desktop 固定源码研究](parallel-runtime-reference-pi-desktop.md)：commit `71c637bf823dcec9c9eb3e33a8514826925cd436`，源码声明 `0.24.0-beta.5`，LGPL v3；独立 TEMP shallow clone。默认 Desktop 在共享 Node sidecar 内按 session 持有不同 Pi Agent 对象，而非每会话外部 RPC child；另有独立 native Pi SDK 续接路径。借鉴焦点/归属分离、Stop 捕获原 turn、后台投影和文件资源持锁到实际任务结束；不移植 SDK/manager wrapper、数据库或源码。Host 确有跨会话 typed-file 协调，但不覆盖任意 Shell/Git。主代理复核两仓 `rev-parse HEAD`、T3 RPC response/event 配对以及 PI-Desktop runtime map 和 Host 文件预算实现；源码报告不冒充运行实测。
- 本机 Pi 1.6.0：只读 `dist/core/extensions/types.d.ts`、`session-manager.d.ts`、`extensions/runner.js:emitToolCall`、`agent-session.js:_beforeToolCall/_emitExtensionEvent/_emitAgentSettled`。已确认 tool_call handler 被 await，抛错向上阻断；结束/settled hook 被 await。只认证此专项依赖，不把全产品当前 Pi 兼容基线从 1.0.0 自动改成 1.6.0。

## 5. 实测证据（分层）

| 层次 | 命令/场景 | 实际结果 |
| --- | --- | --- |
| 红回归 | TEMP 中 HEAD 原 bridge + 新 Pi 1.6 fixture | 预期 assertion failure，确认原实现拒绝兼容契约；当前实现通过 |
| 定向 · 并发 | `npm run test:session-concurrency`，最终同步 witness / 恢复修复后完整执行 | scheduler **9/9**、bridge **11/11**、resolver **7/7**、ordinary runtime **16/16**、integration **26/26**，总计 **69/69 case**（套件自报口径）；无旧断言删除，新增启动/恢复/撤权/私有切换回归 |
| 定向 · 驱动离线 | canonical alias 新增 `node tests/fixtures/parallel-runtime-electron.cjs --check-driver` / `--check-safety` | 模板 **46/46**（23 模板 × 两组输入）、离线安全 **25/25**；显式只读实际 Pi 纯 parser 专项额外两项为 **27/27**，不纳入默认 CI 的真实 Pi 依赖。此前 48→46 是删除两条截图文本替换/恢复模板并加入一条像素隐私区域查询，不是删除产品断言 |
| 定向 · 探测 | `node tests/pi-probes.cjs` | 62/62，无 skip；新增 gate 各缺失/unknown/超限等在 bridge 套件中 |
| 定向 · Runtime / RPC | `npm run test:runtime`；后续新行为补验 | 前轮 exit 0、23 套件，发生在 startup/恢复增量前，不冒充最终全量证明；最终相关增量 Registry **42/42**、HTTP **13/13**、session-runtime **7/7**、provider-auth-runtime **56/56**、resource-cleanup **16/16**、stop-barrier **17/17**、server-security **44/44**、app-update-activity **6/6**（skip 0） |
| canonical | `npm test`（首次完整链；最终状态另跑中） | 首次 **exit 1，未通过**：provider-management 的 Windows 凭据存储资格三项失败，该叶命令 **184/187**、skip 0；不冒充最终状态证明。独立诊断确认 `ancestor-danger`：TEMP 祖先有不可信主体继承的 Modify ACE，写入前正确 fail-closed；相关产品/测试与 HEAD 无差异。单文件重跑 **17/20**，三项仍失败。未调整真实 ACL、信任表或断言。最终完整证明待验证 |
| 构建 | `npm run build:app -- --rebuild`，最终 RPC epoch / mutation ledger / witness 状态 | **exit 0**；`build/server.cjs` 与打包副本 backend SHA-256 均为 `9495579ee39ee69c29f9a9b5cebc08491ad9eb8467de0ae3d3a8554d8f6f8aae`，main `135a00e0423d9df5d739eb0c576023f1ea8296de802fcf60029cd2b4403fee05`；SEA 116.0 MB、Electron exe 234.9 MB、整包 349.8 MB；应用 0.35.1，Electron 44.4.3。构建成功不等于签名或发版资格 |
| 真 Pi / Windows Electron | 显式 opt-in，隔离 TEMP 项目/config/session/profile | 最终 9495579e 构建的零 prompt 控制面 **17/17**；唯一完整模型补验 **未通过**：exercise 实际 **5/6**，A 启动后 120 秒未观察到工具，B/C 与 recovery 未执行；summary **5/7** 额外含缺 recovery 的完整性失败，不是七条实际断言。此前旧构建三线真实重叠证据 **29/31** 仍只证明其覆盖主路径，不能升级为最终整体通过 |
| 独立功能/安全审查 | 独立上下文、指定 Sol max | 首轮功能：新增阻断 0、历史 startup 竞态 1；首轮安全：阻断 0、故障注入 **17/17**。第二轮 I-1 / 第三轮 R-1/R-2 已作者修复定向验证，最终独立闭合仍未验证；真实 driver 独立安全报告 **Blocker 1 / Important 4**，均已实现修复并通过作者离线负例，最终独立复验未运行。详细处置见下节，不能把旧报告改称通过 |

三子进程离线集成明确覆盖：同 cwd A/B 与另项目 C 三份原生身份/运行代次；A/B/C 的 run 同时活跃；B 写工具等待时 C 实际写 fixture；同名 RPC/tool/approval ID 不串流；Stop A 不停止 B/C；B 独立审批；session JSONL 归属；第四进程拒绝；退出确认清理；重启恢复 dormant、旧 owner 拒绝。该测试是真子进程和生产模块，但 Agent 本身是假 Pi，**不计入真实模型通过项**。

[真实专项记录](parallel-runtime-live-evidence.md) 与 [长期最小证据索引](assets/parallel-runtime/README.md) 分别保留最终控制面/模型失败及历史三线重叠。主线程核对两份 archive manifest 的结构 JSON 与 PNG 共 **19/19** 摘要，其中最终归档 **7/7**；归档目录合计 **1,297,749 字节**（含索引），不是完整日志或原生会话存档。

最终 canonical 由现有 `createTestGroupPlan()` 从唯一 npm 链解析，**349 个唯一 leaf 命令**：core 273、ui 24、security 27、native 4、faults 21；计划 SHA-256 `78848abcbccbc14ca9c6ec441a22fff529eab6d61b851179382103e663f34b9d`。两个驱动离线模式加入后由 347 增至 349；最终 alias 已另行执行。已知失败 leaf `test:provider-management` 位于当前计划第 193 项，继续验证只动态读取其后 156 项，失败前缀永不覆盖为通过；最终完整链与累计后缀仍在运行，未运行或未完成项不算通过。

### 独立发现逐项处置（不把作者自测冒充独立通过）

所有独立委派均使用用户指定的 `xingchiapi/gpt-6.1-sol` / `effort=max`，无代码合并/发布审批权。

| 编号 | 原报告与证据 | 当前处置 |
| --- | --- | --- |
| 首轮历史 startup | accepted 早于 prepare/hello，旧测试先等 ready 漏窗 | 已作者修复；真 guardian 立即 B 回归通过 |
| 第二轮 I-1 · Important | 共享准入 await 后旧 guard/Classic 根证明仍可被使用 | 同步 witness + 创建前复核；作者 69/69 定向覆盖，最终独立闭合未验证 |
| 第三轮 R-1 · Blocker | 最后 native get_state 的旧答复与 Classic 私有切换并发，缓存 owner/hello 未变而双持 native；TEMP 实证，不是猜测 | RPC epoch + 原命令账本在途 + 最终同步 proof；作者新增 sent/completed/already-pending/timeout 回归通过；最终独立闭合未验证，不能继承第三轮之前通过意见 |
| 第三轮 R-2 · Important | 无关 missing 项目导致有效目标 resume 报 git_unavailable / ENOENT | 直接验证后端 target；ordinary runtime 16/16，最终独立闭合未验证 |
| Driver D-1 · Blocker | Git 覆盖环境可让 cwd 在 TEMP 的 config/add/commit 写到外部仓库（只在两套 TEMP 仓库复现） | 清除所有不区分大小写 GIT_ 环境，显式隔离配置/禁止 hooks 与网络；两 TEMP 仓库 hostile-env 实测外部 config/index 未写，作者离线验证通过；最终独立复验未运行 |
| Driver D-2 · Important | signal 退出时 exitCode 为 null，旧清理仍裸 PID taskkill | 同时核 exitCode/signalCode、创建时间、exe/命令行摘要及本轮 marker；signal/复用PID/改命令/缺见证负例拒绝终止；作者验证通过，最终独立复验未运行 |
| Driver D-3 · Important | 阶段缺 failed/endedAt 或 exit 非零仍可保留 fullLiveAcceptance=true；privacy scan 在发布结论后 | 显式阶段完整性、必需检查集合、exit、privacy、HTTP与进程清理共同出结论；缺失/失败负例通过，最终模型失败实际保持 completed/fullLiveAcceptance=false；最终独立复验未运行 |
| Driver D-4 · Important | close 返回 cleanup_pending 被当成普通 JSON 忽略，未确认整族清理 | ok:false/异常/仍有owner计失败；正常退出前与父进程握手观察进程族，退出后按身份核残留；离线负例通过、最终失败轮观察8个身份残留0；最终独立复验未运行 |
| Driver D-5 · Important | Pi 模型配置的无 `$` key 名是 literal，不是 env 引用 | 改 `$PI_GUI_PARALLEL_KEY`；实际 Pi 1.6纯解析器用合成值的 bare/dollar 两向专项通过；不把 source key/auth 保存到证据；最终独立复验未运行 |

第三轮尚未给最终修复代码独立通过。遵守三轮收敛上限，不自动新增第四轮审查/修补循环；
若交付时仍欠独立闭合或完整 canonical，PR 必须保持待验收，不自动合并。源码实现和作者验证
不等于用户批准合并或发布。

### 失败与环境修复历史

1. 新 bridge fixture 首次使用 fetch 时遇 OS 随机 loopback 端口命中浏览器 forbidden port（`TypeError: fetch failed / bad port`），与产品扩展实际 Node HTTP transport 不一致。测试改为和扩展一致的 `node:http`，仍保留 token/Origin/closed body 安全断言；不是删除断言。
2. 第一次 build 失败：已声明依赖 `fflate` 等未安装。尝试忽略 lock 的离线补齐遇 `ENOTCACHED @electron/packager`，没有联网。改为严格使用现有 lock 的 `npm install --offline --ignore-scripts --no-audit --no-fund`，从本地缓存补齐 219 packages，package-lock 无差异；第二次 build 成功。
3. 构建打印既有 Liberation 字体对应源码资格未解决提示和 SEA 注入签名 warning。本任务只做本地构建，不据此宣称获准再分发/签名/发布；未修复与本专项无关的许可问题。
4. 原完整链在 provider-management 187 项中 3 项失败；独立单文件重跑 20 项中仍同 3 项。
   `prepareCredentialStorage` 在写入前因 TEMP 祖先继承的 `CodexSandboxUsers` Modify ACE 返回
   `config_unsafe` / `ancestor-danger`。只读取证确认，不将该主体加入可信表、不改 ACL、
   不强制 qualified、不删除或 skip 断言。该环境下本地完整证明仍失败，合格环境/PR CI 待验证。
5. 作者补充 RPC 在途回归时，新增公开 switch 的应答被计入后续“私有认证同步零广播”观察区间，
   测试首次 1≠0；改为先明确断言公开应答仅一条、私有/迟到应答零条，再为独立认证操作开始
   新观察区间，56/56。未删原零广播断言，也未改变产品发布行为。

### 既有恢复限制与剩余风险

- `extension_error` 目前不区分扩展来源，任意该事件会清 native 并 pause；首次 `session_start`
  hello 失败也没有主动重试。普通 Runtime 的发送闸门位于 tool hook 前，因此不能承诺普通重试
  自动恢复。显式目标 Runtime restart 仍须重新完成 source/hello/native 证明，不能强制 ready。
  这是后端审计确认的既有保守可用性限制，未证明是用户原始现场的唯一原因；本次不新增自动恢复。
- Pi 的空会话可能尚未落盘；没有可由 native scanner 证明的 session 文件时，restart/resume
  仍可能 `session_unavailable`。不生成假 locator、不改 Pi schema，也不将这种失败标成通过。
- 真实模型 thinking 设置 off，不将文本流/工具通过冒充真实 thinking delta 并行证明；thinking
  与审批归属目前由离线生产状态机回归覆盖。其它 OS、任意 provider/model、长时压力/断电
  和脱离工具生命周期的 Shell/Git 副作用未获得本次资格。

## 6. UI、回滚和交付门槛

- UI 视觉约束：未改 `public/`、CSS、Token、布局、动画或产品组件。已有真实打包窗口交互与截图；失败画面同样保留，不能据截图存在宣称最终通过。diagnostics 多一条能力证据，沿既有展示，不新增设计。
- 回滚：对本次行为提交执行单独 `git revert <行为提交>`，再 `npm run build:app -- --rebuild`；测试/文档提交按需独立回退。不改真实项目、Pi session 或全局安装，无数据 schema migration 要撤销。
- 开发实现：本次代码修复已提交；完整任务验收尚未完成。代码验收：未通过/待验证（最终真实模型补验失败、完整 canonical 和独立最终闭合仍欠证明）。允许合并：未授权；允许发布：未授权。
- 交付策略：提交测试基建与最小证据、推送并创建待验收 Draft PR；不合并、不打 tag、不发版，也不自动追加模型轮次或第四轮泛审查。最终提交/PR 与 CI 状态由交付消息记录。
