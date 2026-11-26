# 多会话真实 Pi / Windows Electron 验收记录

日期：2026-11-26。**当前状态：最终生产构建（exe `71b9ed51…`、backend `9e554f4b…`，HEAD `18a6d4a0…`）已完成同构建真实预检 10/10 与完整 exercise→recovery 66/66（exercise 35/35、recovery 31/31），exit 0、`fullLiveAcceptance=true`。此前 backend `917a5fbc…` 的 66/66 已被窄复核 Important 修复取代，只对旧产物有效。按用户指示本轮未 push，最终 PR head 的 CI 尚未产生；下文历史失败与旧轮记录原样保留，不能与结果拼接。**
本记录只涵盖真实验收 runner；最终 head 的完整 canonical 由 PR CI 提供，生产修复及独立安全复审另见主验收记录。

## 路径与授权边界

- 入口：`tests/parallel-runtime-live.cjs`；观察驱动：`tests/fixtures/parallel-runtime-electron.cjs`。
- 默认运行立即输出 skipped、exit 0；只有 `PI_GUI_PARALLEL_LIVE=1` 才读取 SDK / 建 fixture / 启动 Pi 与模型。不得把该变量固化进 `npm test`。
- 基线 HEAD：`ac812c6fa49dfd960867a5688ee6f61cb8ec5f67`。对应成功 CI：[45711901260](https://github.com/HYJ1817/pi-gui/actions/runs/45711901260)，push / attempt 1，core、ui、security、native、faults、Electron build 与最终 gate 成功；这不是当前生产修复的完整证明。生产修复已提交为 `7a277aeb2e19459799a3d9202687b757c8c3c2ea`，测试基建为 `d5878103ded34bd5aad67b165bb3b0a97de02387`；运行时提交前身份与文件 digest 仍按原始证据保留。
- 完整模型轮在 `os.tmpdir()` 新建 `pi-parallel-live-*`：两个独立 Git 项目、Pi agent/session/config、GUI data/runtime、Electron profile/cache/log、HOME 与 TEMP 全部隔离。用户配置与已安装 Pi 只读，不修改真实项目 / 会话 / 全局 npm，不下载依赖。零 prompt probe 同样新建 TEMP，仅复制原 fixture 的 GUI manifest 与真实原生 session 字节；原生 header.cwd/UUID 不变，原 TEMP 项目路径仅作只读控制面输入，新 locator/stat 指向实际副本并核对字节相同。不得借重定位改 native schema、造 locator 或换 session ID；不复制 auth/config/log。
- 使用官方 SDK 在内存中 resolve 已有 provider auth；凭据只经子进程 env 传递，fixture model 配置保存 `$PI_GUI_PARALLEL_KEY` 环境引用（已对读到的上游纯 parser 核实；裸 `PI_GUI_PARALLEL_KEY` 是 literal，不能算环境引用）。证据不保存原始 stdout/stderr、消息、工具参数、响应 payload 或 auth/provider 配置值。
- 打包层：把 `dist-app/Pi GUI-win32-x64` 整体复制进 TEMP；只把**副本** manifest 的 `main` 改为观察 bootstrap，再加载未修改的生产 `main.cjs`。exe / backend / main 的 SHA-256 和 main/public 源码比对保存在各轮 `identity.json`。未修改仓库 `dist-app` 或生产文件。
- 实际使用生产 BrowserWindow、preload、HTTP/RPC/SSE、runtimeStore 与原生鼠标/键盘输入；正常 sandbox，未用 `--no-sandbox`。未 mock Pi、fetch、事件或 registry 工厂。
- 预算保持 classic + runtime 合计默认 2、绝对上限 3；计划 A=classic、B=同项目 runtime、C=另一项目 runtime；第三个经真实 UI 确认，不关闭 hello/sessionId/tool lease。

## 可复现命令

```powershell
# 默认关闭：不得调用模型
node --check tests/parallel-runtime-live.cjs
node --check tests/fixtures/parallel-runtime-electron.cjs
node tests/fixtures/parallel-runtime-electron.cjs --check-driver
node tests/fixtures/parallel-runtime-electron.cjs --check-safety
node tests/parallel-runtime-live.cjs

# 用户已明确授权本轮真实模型开销后，选择已有配置中的模型 ID
$env:PI_GUI_PARALLEL_LIVE='1'
$env:PI_GUI_PARALLEL_PACKAGED='1'
$env:PI_GUI_PARALLEL_MODEL='xingchiapi/gpt-6.1-sol' # 完整模型 ID；provider 沿既有配置，不硬写 xingchiapi
$env:PI_GUI_PARALLEL_PHASE='preflight' # 两个轻量真实 turn，独立资格
node tests/parallel-runtime-live.cjs
# 同一最终构建的预检通过后，明确进入完整 exercise → recovery
$env:PI_GUI_PARALLEL_PHASE='full'
node tests/parallel-runtime-live.cjs
```

可选 `PI_GUI_PARALLEL_PROVIDER` / `PI_GUI_PARALLEL_BUILD_ROOT`；不写用户配置。每次调用新建 fixture；应用副本与会话数据保留在 TEMP 供只读复核。模型失败、timeout 和未运行场景不得算作通过。

## 本轮驱动冻结与旧预检追领（不替代最终新构建）

- 2026-11-26 两个驱动文件冻结：runner SHA-256 `b35c122bd683aa32aecf751caf6b28a627b03e96de61673788451bbfdd11424f`（30,219 字节）；fixture `310a1f715f571f0e9da8de87842ea53a5eab00c85c47fc2f12f359892ae0c48d`（77,602 字节）。作者离线语法 **50/50**、安全 **32/32**、默认 off 为 skipped。32 项保留原 31 项，只新增一项恢复证据复合负例；未减少断言。最终独立驱动资格复验进行中。
- 独立资格复验对上述冻结字节给出新增 **Blocker 0 / Important 0 / Nit 0 / Pre-existing 1**；两文件语法 **2/2**、模板 **50/50**、安全 **32/32**、额外 TEMP 负例 **47/47**（skip 0）。既有 Important：exercise 主进程 exit 0 但进程族清理未确认时仍进入 recovery；最终汇总会拒绝，不是绿色假阳性，但违反阶段不重叠约束。
- 随后主线程最小修复该既有问题：下一阶段须通过原 `phaseValid(report, phase)`，不能仅凭 exit 0。新增四项实际 loop-tail 回归（清理未知、公开 close 未确认、缺阶段证据、完整阶段）；修复前测试确实 exit 1，修复后模板 **50/50**、安全 **36/36**、语法及 diff check exit 0，默认 off 仍 skipped。新 runner SHA-256 `2bf993b9208ad2bacedfe0832c14f4ab1d4fb15d1b1c2d7d3f9798836d259b1f`（30,312 字节）；fixture `c3c31d92a1c1344254fdb17d82e989abd96b993fb94123ba6fdc3b5136877c19`（78,745 字节）。该增量随后通过独立窄复验：安全 **36/36**（新增 **4/4**、原 **32/32**），执行实际阶段循环的独立验证 **30/30**、两种错误门禁变异负例 **2/2**（均被测试捕获，skip 0），新增 Blocker/Important/Nit 均 0。P1 的“不确认就不推进”已闭合；不等于残留进程已被自动安全清理，也不替代最终真实环境验收。
- 已追领前代理 TEMP `pi-parallel-live-qqidkV/evidence/summary.json`：**10/10**、exit 0、`completed=true`、`preflightComplete=true`、`fullLiveAcceptance=false`，privacy verified；记录八个创建身份，代理按完整身份只读复核残留 0，未 kill。07:09:32.569Z–07:13:06.371Z，213.802 秒，输出 turn 47.790 秒、工具 turn 161.536 秒。
- 此预检的实际 backend 仍是旧 `9495579e…`，driver 摘要也早于本次冻结；不能使用 identity 中“源码当时已改”掩盖实际打包字节。它证明该次已有模型输出及 write/read 路径，不证明当前 dirty 修复或最终完整并行通过；`thinkingOff=false` 保留为事实，不能声称当时实际关闭思考。
- 恢复驱动已增加一次真实 UI write/read、完整 owner/seq 与工具起止配对、文件及输出摘要、settled、当 turn 原生历史、restart 旧 owner 拒绝与无自动重放。代码存在和离线负例不等于真实恢复执行通过；最终生产提交、重建、同构建预检与完整 exercise→recovery 均仍待验证。未新建模型轮或覆盖旧失败。

## 最终构建：预检与完整真实 exercise→recovery（2026-11-26）

- 构建身份：预检 `1CfIzx`、首次完整尝试 `hGBJUN`、最终完整 `ci41oY` 三个 TEMP 世界的 exe 均为 `71b9ed5105a31a…`、backend `917a5fbc0b91401c…`、main `135a00e0…`，与提交后逐字节校验的产物一致；正常 sandbox / contextIsolation / 无 nodeIntegration，Pi 1.6.0，Node v24.22.1，模型 `xingchiapi/gpt-6.1-sol` 沿既有 provider，无 fallback。HEAD `4bdd29f4…`。
- 预检（`1CfIzx`，fixture `c3c31d9…`）：在产物字节相同的构建上实跑 **10/10**、exit 0、`preflightComplete=true`、`fullLiveAcceptance=false`；两个真实 turn 的输出与 native write/read 均通过。该资格独立，不替代完整阶段。
- 首次完整尝试（`hGBJUN`，同一 fixture）：exercise **35/35**、exit 0；recovery **19/21**、exit 1、`fullLiveAcceptance=false`。失败不是产品回合失败：恢复后真实 turn 输出精确（11 字节、sha `106da1c5…`），write/read 均 completed、0 tool error、settled、idle；驱动仍要求用非空 `toolCallId` 配对，而生产公开 SSE 对白名单外 id（真实 Pi id 含 `|`）投影为 absence，导致 `toolPairsComplete=false`、`writeThenRead=false`。这是驱动证据形状错误，不能把 35/35 与预检拼成整体通过。
- 最小修复仅动 driver，生产零改动且未重建：有 id 时仍按 id 严格配对；全部无 id（生产已证明的投影形状）时按同名、seq 顺序、每个 end 恰好消费一次配对；混合 id、缺失 end 与错误 end 仍拒绝。新增 4 条离线断言；模板 **50/50**、安全 **36/36**。fixture 新字节 80,473 / sha `0d7b327a…`，runner 不变 30,312 / `2bf993b9…`。
- 旧产物完整（`ci41oY`，backend `917a5fbc…`，final driver）：exercise **35/35**、recovery **31/31**、合计 **66/66**、failed 0、两阶段 exit 0 且 `phaseValid=true`、`completed=true`、`fullLiveAcceptance=true`、privacy verified。恢复真实 turn：输出 11 字节 sha `106da1c5…`，write→read 工具 0 错误且 `toolPairsComplete=true`、`writeThenRead=true`、settled/idle、12.639 秒；结果文件 21 字节 sha `c89212fd…`、精确；随后真实 restart 保持 resumed native、轮换 runtime owner、旧 owner 读取/回放被拒且不自动重放。该轮只对 backend `917a5fbc…` 有效，已被下面的窄复核修复取代。
- 独立窄复核（绑定 `4bdd29f4…`）给出 **Blocker 0 / Important 1**：`request(switch_session,{timeoutMs:5})` 超时后账本仍改变中，新 native hello 仍获 `tool_guard_initializing`，与“unknown/timeout 不得获得”相反；实测 `requestResult:null` / `ledgerChanging:true` / `helloCode:"tool_guard_initializing"`。其余恢复分支、lease、Stop 与 Classic 两种 B 时序通过；独立重跑 bridge **52/52**、session-runtime **9/9**、integration **41/41**、stop **19/19**（121/121）。
- 修复（生产 `ae37a832`、测试 `18a6d4a0`）：RPC 账本对请求超时、部分写失败与同步写异常标记 uncertain；`providerSessionPending()` 仅当所有会话 mutation 都未 unknown 时为真；Classic `isInitializing` 同时要求 pending。超时后新 native 首次 hello 即 `stale_runtime`，正常 in-flight 早到 hello 路径保持。定向复跑 bridge **52/52**、provider-auth **75/75**、session-runtime **9/9**、integration **41/41**、stop **19/19**、message-edit service **49/49**、scheduler **9/9**、registry **43/43**，skip 0。
- 重建后（HEAD `18a6d4a0`、exe `71b9ed51…`、backend `9e554f4b…`）：`npm run build:app -- --rebuild` exit 0；产物字节校验 **734/734**；预检（`aUEbW1`）**10/10**、exit 0、`preflightComplete=true`；完整（`vIZXkf`）exercise **35/35** + recovery **31/31** = **66/66**、exit 0、`fullLiveAcceptance=true`、privacy verified。恢复真实 turn：输出 11 字节 sha `106da1c5…`、工具 0 错误、`toolPairsComplete=true`、`writeThenRead=true`、settled/idle、47.079 秒；结果文件 21 字节 sha `c89212fd…`、精确。新归档见 [证据说明](assets/parallel-runtime/README.md)。
- 仍未运行：最终 PR head 的 `npm test` CI（用户指示本轮不 push）。canonical 全量仍为**待验证**，新 66/66 只证明本机同构建真实打包验收。

## 上一轮已执行结果（按当时字节保留）

| 检查 | 实际结果 |
| --- | --- |
| `node tests/session-tool-bridge.cjs`（本线程定向基线） | **11/11**，exit 0 |
| `node tests/runtime-resources.cjs`（本线程定向基线） | **45/45**，exit 0 |
| 两个新文件 `node --check` | 成功，exit 0 |
| `node tests/fixtures/parallel-runtime-electron.cjs --check-driver`（最终 driver） | **46/46**（23 个 renderer 模板 × 两组输入；无 Electron/Pi/model），exit 0。48→46 是去掉修改/恢复 DOM 的截图表达式，改为单个只读矩形查询；未删功能或安全断言 |
| `node tests/fixtures/parallel-runtime-electron.cjs --check-safety` | 默认模式不读取本机 Pi 的 **25 项**离线回归；本线程显式指定上游纯 parser 路径的实测为 **27/27**，exit 0；多出的 2 项是实际 parser 的 bare literal 与 `$ENV` 对照，不冒充默认 CI 结果 |
| `node tests/parallel-runtime-live.cjs`（未设 opt-in） | `Parallel runtime live: skipped (set PI_GUI_PARALLEL_LIVE=1 explicitly)`，exit 0 |

### 调试尝试（不计产品通过证明）

1. TEMP `pi-parallel-live-SCF0tL`：随机系统端口均落入本机低端口范围，preflight `port_unavailable`，未启动模型。runner 改为 16000–39999 显式 bind-check。
2. TEMP `pi-parallel-live-TXifuq`：生产窗口 / preload 2 项通过，classic RPC 未 ready。原因是 runner 把裸 `.js` CLI entry 作为 Windows `PI_BIN`；已改为真实 PATH shim。该轮后续全部未验证。证据扫描曾与短凭据等长的公开 provider 别名碰撞；后续 identity 不再保存 provider 别名，不把旧 identity/summary 纳入归档。

### 第一轮真实模型尝试：未通过（3/4）

- 时间：04:53:46Z–04:55:50Z。
- TEMP 证据：`%LOCALAPPDATA%/Temp/pi-parallel-live-cLtsjU/evidence/`。
- Windows 11 / Electron 44.4.3 / Pi 1.6.0 / Node v24.22.1；全新打包副本与正常 sandbox。
- **通过 3 项**：生产 sandbox/contextIsolation/nodeIntegration 设置、生产 preload、初始 classic 1 / limit 2 / hardLimit 3。
- **失败 1 项**：等待 A 的真实工具 shell marker；真实画面显示“请求失败 / 当前模型触发限流”。A 未调用工具；不能据此推断产品串行或算作三会话验收。
- A 原生 `sessionId=01a21633-e116-74ee-b961-90b28dfe0d56`；`runtimeId=52915322-3637-4a1d-b564-1280eb622c0f`；generation `1`。
- SSE：`agent_start` seq 12 / `1795668832630ms`；`agent_end` seq 21、`agent_settled` seq 22 / `1795668834333ms`。该轮未得到 generationResult 分类；限流结论来自实际渲染截图，不是把 marker timeout 当作限流。
- 原始脱敏 PNG：`failure-start_A_real_tools.png`；它是实际 `capturePage()`，仅把 TEMP 绝对路径文本替换为 `<TEMP>`，没有合成布局。
- 此后 runner 增加仅闭合字段的模型失败检测，等待 `agent_settled` 或 prompt 拒绝后提前停止；不把原始 errorMessage 存入证据。补强 reload 前后事件合并，避免丢失前半段证据。

### 新产物第二轮：部分证据（5/6），driver 失败

- 时间：05:03:15Z–05:03:36Z；TEMP `pi-parallel-live-9Q1Giq/evidence/`。
- 已有配置的另一个模型可执行工具；A 实际 `write` / `read` / `bash` SSE 和 `A-started.flag` 证明真实工具已运行。A 仍执行延时 shell 时，B 已 ready，原生 session 与 A 不同。
- A session `01a2163c-9127-741e-ada4-a051b927f2d8`；B session `01a2163c-d6be-70b7-87f1-a46944cac6f0`。预算未超过 2。
- **通过 5 项、失败 1 项**。B 尚未发送模型任务，观察 driver 的 focus fallback 中存在未包 async 的 `await import`，导致 `executeJavaScript` 失败；不是生产缺陷。
- 已修复所有同类表达式，增加 `--check-driver` 离线预编译全部 24 个模板 × 两组输入（**48/48**），主 runner 在 SDK/auth/fixture 创建前强制执行，`read()` 入口也逐条 `vm.Script` 编译。
- 新产物：backend SHA-256 `7c7efb19cb648e9a2fbb73d390282094051ddfc784f42ae3143800cc74961aa9`；exe SHA-256 `71b9ed5105a31ad944f82376b0e66ea8b147068aafb16330a556f44bebe5a19f`；生产 main 与源码相同、抽查 public 相同。该轮仍不是整体通过。

### 第三轮历史：真实主路径 29/31，restart 失败（保留，不覆盖）

TEMP `pi-parallel-live-BAHvF5`，05:07:24.385Z–05:08:37.414Z。两个失败是 restart accepted 与随后的 runner 汇总失败；后续零模型复现取得 `unknown_workspace`。该轮已有实际三线重叠、原生 write/read/bash、B 同根写等待、C 独立根前进、第三名额确认/第四拒绝、连续导航、只停 A、B/C 继续、renderer reload 与 B/C 原生历史等 **29 项通过**，但整个专项仍未通过。旧轮还使用了后来发现会被 Pi 当 literal 的裸 env 名称，不能当作最终凭据传递修复后的模型证明。

真实重叠的**重载前 SSE 观察时间**（不是供应商服务端时间）来自归档 `facts.overlap`，不要用重载后事件 replay 的接收时间倒推 start：

| 运行线 | agent_start 观察时间（UTC） | 原生 sessionId | 之后的事实 |
| --- | --- | --- | --- |
| A / Classic / 项目一 | 05:07:29.667 | `01a21640-5c6c-714c-9a84-fafaa7bf8782` | 05:08:11.224 请求 Stop，未写 a-done |
| B / Runtime / 项目一 | 05:07:50.402 | `01a21640-b6ea-7565-becd-b59fbef77863` | A 仍运行时已进入模型任务；写工具等待 A；之后完成 B_DONE |
| C / Runtime / 项目二 | 05:07:53.660 | `01a21640-c275-721c-88b2-c05a381398de` | 独立根真实 shell 已开始；之后完成 C_DONE |

05:08:08.866 实际回读三条均 streaming：距 C start **15.206 秒**。B 的等待事件为 05:07:55.756（waiting=true），A Stop 后 05:08:12.196 释放（false）；不是用“API accepted”代替并行证据。B/C 两条 runtime 的 owner/runtimeId/generation 与每条 SSE 序号保存在 [历史结构证据](assets/parallel-runtime/attempt-3-exercise.json)。

历史实际文件结果（只读复核；完整摘要见 [file-results](assets/parallel-runtime/attempt-3-file-results.json)）：

| 项目 / 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| 1 / a-native.txt | 14 | `839c0569a200c70382f7816075f52e9a8049b454fa0adc0d328c627d4f932df7` |
| 1 / b-native.txt | 14 | `51fb9cb7bab9d8e9a8774d2693a5b3a45fc16a6176da42a01779b0984ddd0fc0` |
| 1 / b-done.txt | 6 | `9cef5614ef25563102cdfe30a9904c6579dcd730bfdd5fd30ae6288696c167b2` |
| 2 / c-native.txt | 14 | `700f9bc837d4bf51ed0136352189ce2db1a3b2bb559d024c127dda835583d4a4` |
| 2 / c-done.txt | 6 | `edd88083c781b4644e48b9e6544fa5128307fc55096d5ffe6b5b6971e7901530` |

空无 prompt 会话的旧 probe **7/9 未通过**保留为 `restart-empty-native-*`：空会话可能因 Pi 惰性落盘而 `session_unavailable`。没有通过伪造 locator 或改原生 ID 消除该限制。

## 最终 driver 安全修复与离线负例（D1–D5）

未修改生产代码；未安装依赖、调整权限或继续委派。显式上游 parser 模式的命令如下，仅只读已安装文件、不 import / spawn Pi、不调用模型：

```powershell
$env:PI_GUI_PARALLEL_RESOLVER='<installed Pi package>/dist/core/resolve-config-value.js'
node tests/fixtures/parallel-runtime-electron.cjs --check-safety
# Parallel driver safety: 27/27; evidence=<TEMP>/pi-parallel-driver-safety-fn16jH
Remove-Item Env:PI_GUI_PARALLEL_RESOLVER
node tests/fixtures/parallel-runtime-electron.cjs --check-driver
# Parallel renderer syntax: 46/46 (23 templates; no Electron/Pi/model)
```

[实际 27 项结果](assets/parallel-runtime/final-driver-safety.json)，源 TEMP `pi-parallel-driver-safety-fn16jH/safety.json`。这 27 项不等于真实模型验收；默认 canonical 模式不设 RESOLVER，不依赖本机安装 Pi，额外两项不计入该模式分子分母。

| 发现 | 修复 | 实际负例 / 验证 |
| --- | --- | --- |
| D1 / Blocker：Git 环境覆盖逃出 fixture | 所有 Git 命令清除大小写不敏感 `GIT_*`；强制隔离 global/system config、禁 hooks、签名、fsmonitor 与网络协议；应用子环境也清除继承定位覆盖 | 恶意 GIT_DIR/WORK_TREE/INDEX_FILE/CONFIG 等；两个真实 TEMP Git，外侧 config/index 不变；内侧故意 exit 97 的 hook 不执行，commit 完成 |
| D2 / Important：signal exit / PID 复用误杀 | 同时要求 handle.exitCode 与 signalCode 为 null，并核对原始创建时间、exe/command hash 和本轮 marker；未知/复用/已信号退出不 kill | signal exit、同 PID 新 birth、command 变化、缺原 witness 均拒；仅完整匹配可授权失败路径 fallback |
| D3 / Important：summary 误报完成 | 明确 phase/endedAt/completed/failed、exit、必需 check 集合、cleanup 和过程族退出；privacy scan 在绿色 summary 之前；缺阶段也算完整性失败 | 缺 failed、缺结束标记、缺必需 check、exit 1 / signal、privacy 失败、未完 phase、缺 recovery 均不得绿色；本轮实际失败 summary 两个完成布尔均 false |
| D4 / Important：忽略 cleanup_pending / 残留进程 | public close 必须 ok，重读无 live owner；parent 在退出前观察进程族，按创建时间+exe/command hash 核验退出 | cleanup_pending、throw 均失败；成功 close+无 owner 才确认。控制面实测 **12 个身份→残留 0**；最终模型尝试 **8 个身份→残留 0** |
| D5 / Important：API key 环境引用被当 literal | fixture config 改 `$PI_GUI_PARALLEL_KEY`，不落盘 secret | 已读取的官方 resolve-config-value.js 纯 parser：bare 名称仍 literal；加 `$` 才解析到 synthetic key；共额外 2 项 |

最终 driver 字节身份（完整模型轮运行期间未修改）：

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| tests/parallel-runtime-live.cjs | 26486 | `cc1d1518de2b8938605cf264b4102ae279399485673c35aa4080a5995ce9596c` |
| tests/fixtures/parallel-runtime-electron.cjs | 50744 | `453ecb2cb49938357008b6cbf01ced43beac52cbae7b63b6b5fcf93fc2d14c26` |

## 最终产物零 prompt 控制面：17/17，通过但不是模型验收

- TEMP `pi-parallel-live-68fYSd`，05:35:16.158Z–05:35:25.325Z（**9.167 秒**），exit 0。证据：[owner-probe](assets/parallel-runtime/final-control-owner-probe.json)、[summary](assets/parallel-runtime/final-control-owner-probe-summary.json)。
- Backend / App bundled backend 均为 **3,880,553 字节**，SHA-256 `9495579ee39ee69c29f9a9b5cebc08491ad9eb8467de0ae3d3a8554d8f6f8aae`；main **66,128 字节**，SHA-256 `135a00e0423d9df5d739eb0c576023f1ea8296de802fcf60029cd2b4403fee05`。exe `71b9ed5105a31ad944f82376b0e66ea8b147068aafb16330a556f44bebe5a19f`，main/public 源码匹配；正常 sandbox/contextIsolation、无 nodeIntegration / no-sandbox。
- 原 BA HvF5（目录实际名 `BAHvF5`）fixture 的 project / session / 所选 GUI data / evidence 共 **90 文件、1,415,345 字节**前后 SHA-256 均 `96d45eac377eb2618d1d2a6c5b18954188fbad6a1264ee0e944bc621d0ee833e`；旧失败证据未覆盖。没有复制 auth，也没有改原 native JSONL。
- Classic 原生继续持有历史 B `01a21640-b6ea-7565-becd-b59fbef77863`，重复 resume 返回 `session_in_use`，资源前后均为 1。
- 已持久化 C `01a21640-c275-721c-88b2-c05a381398de` resume 成功；restart 前 runtime `786cee45-b3b7-49c0-b06c-699872c5ece6` / generation `c35e50f9-5fce-427f-8a9a-9fb76f78425d`，后为 `1e930f6c-7b2f-4ce5-832b-d8608bd94f0d` / generation `b2ac0237-f74a-4683-ab8e-f757709430b9`。native session 不变，旧 read/events 都拒 `stale_runtime`。实际 get_state 同 session、isStreaming=false，原生 history API 含旧 C_DONE，整个 probe **0 agent_start**。
- HTTP closes 确认，观察到 12 个进程身份，退出后残留 0。控制面 PNG 显示 Runtime 就绪/空闲；取景时 model 控件仍在同步、运行视图为空，不能把这张截图宣称成完整模型可用或已渲染 C 历史。
- 两文件语法 exit 0，模板 46/46，默认入口 skipped；完整模型轮前再次执行显式 parser 安全负例 27/27。probe 通过后仅增加最终完整轮的 Git/driver 身份采集，没有更改生产行为。

## 上一轮最终完整模型尝试：未通过，历史保留

- 命令：`PI_GUI_PARALLEL_LIVE=1 PI_GUI_PARALLEL_PACKAGED=1 PI_GUI_PARALLEL_MODEL=xingchiapi/gpt-6.1-sol node tests/parallel-runtime-live.cjs`（Bash 写法；PowerShell 见上文）。provider 沿已有配置，未改用户配置。之前一次错误地把 `xingchiapi` 当 provider 的预备调用在 SDK `model_unavailable` 阶段退出，未启动 Pi/模型；没有因此增加真实模型轮次。
- 新 TEMP `pi-parallel-live-WfQuPN`，**05:37:00.194Z–05:39:05.024Z，124.830 秒**，exercise exit 1；使用上述 `9495579e…` 最终产物及正常 sandbox。运行 identity 是提交前 `ac812c6f…` + 源文件 digest；生产随后由主线程提交为 `7a277aeb`，产物字节未变，不把提交后的身份冒充运行起点。
- **实际 exercise 5/6**：sandbox、preload、初始预算 3 项，加 parent 进程族观察与 HTTP close 确认 2 项通过；1 项失败为 `A_real_shell_started` 的 120 秒条件超时。
- summary **5/7** 不是另一个“7 条功能断言”的结果：它把 exercise 的 1 个失败，加上**缺失 recovery 阶段的 1 个完整性失败**计为 failed=2；`completed=false`、`fullLiveAcceptance=false`。B、C 和 recovery **均未执行**。
- A native `01a2165b-7434-7579-9482-7b9827f0f547`，runtime `3dcdc5ed-5a94-485e-a608-ea923cb9a9af`，generation `1`；真实 SSE `agent_start` seq 12 / **05:37:05.229Z**。到失败取景时没有任何 tool_execution_start、a-native.txt 或 hold marker，也没有 agent_end/agent_settled 或闭合 failureClass。实际画面为 Pi 处理中。**不归因限流、认证错误、供应商故障或生产串行**；只报告等待真实工具超时。
- 两个临时 Git 的 HEAD / index 均前后不变：项目一 HEAD `c7652668693b8adf04a04db6762e9f40234954bc`、index **209 字节** / `9a8033f9a435e5d32a626ee27b7b68f50a815e50b0f89572171ad37acf1b1f99`；项目二 HEAD `3785aa17580f50fd2090b07762a748e4cb030dd6`、index **209 字节** / `8982adff318ac17338488f1ebceb20e6f97392f42e7bdf1bea92d48a534b97dc`。
- 两项目 seed.txt 均 **23 字节** / `a7b86066348d9f25060d98e6b0aa0c240dfe8da85c7e909f41f0f421e5e1c7b1`；hold.cjs 均 **498 字节** / `1863991ebe4ae94242844081a340689d3ca51b0b2bed6074f2de5955f5cf3ab1`。唯一新增文件是 finally 创建的 release-A/B/C.flag（每个 7 字节）；没有原生模型结果可报。完整前后 Git 事实见 [最终 summary](assets/parallel-runtime/final-live-summary.json)。
- public runtime closes 确认，退出前观察 **8 个创建身份，残留 0**；不是只看 PID 或 Electron exit。privacy scan 通过，未保存 raw payload 或凭据。[最终结构事件与失败](assets/parallel-runtime/final-live-exercise.json)。

## PNG 与最小长期证据

新归档仅 5 份结构 JSON、2 张真实 PNG 和摘要 manifest，不归档应用副本、用户配置、auth、原生会话全文或日志。见 [最终 archive manifest](assets/parallel-runtime/final-archive-manifest.json)。

- [控制面 C 已重启 / dark / wide](assets/parallel-runtime/final-control-C-restarted-dark-wide.png)：1980×1230；无敏感矩形，无额外遮盖；SHA-256 `f55441c537c0de542847eec93f91ff2977ee9396cd09d490b122eb8529a845cf`。
- [最终模型 A 等待超时 / dark / wide](assets/parallel-runtime/final-live-failure-start-A.png)：1980×1230；归档时仅对 model/provider picker 进行不透明矩形遮盖，像素坐标 **x=1450, y=1150, width=215, height=45**。归档 SHA-256 `565b1b4245cc871a6013e54ab7bed5b1ceaa00ec4b2a5c801d75df5c2574eb87`；遮盖区域外逐通道比较差异 **0**。driver 自身仅做只读文本矩形查询后像素遮盖，未重排 DOM。
- 本线程已亲自 Read 新原图和两个最终归档 PNG，并复核一张历史三运行窗口；旧宽/窄、明/暗 6 张脱敏 PNG 与失败 JSON 原样保留，不能当作最终产物成功矩阵。控制面截图的同步中模型控件与最终失败截图的等待状态均没有修补隐藏。

## 证据边界与未验证项（不得标绿）

- 历史 29/31 的三线重叠及原生文件/Stop/工具等待事实仍保留；**最终产物完整 A/B/C + exercise/recovery 未通过**，不能拼接旧主路径与新控制面声称“一轮完整通过”。
- 最终产物的 C 持久化 resume/restart、Classic B 重复持有拒绝与旧 owner 拒绝已有控制面 17/17；这不替代最终三模型重叠、最终模型工具完成、整个 app/backend exercise→recovery 端到端验证。
- 真实模型设置 thinking **off**；没有真实 thinking delta 并行证明。审批归属/重复 ID、异常退出/撤权窗口/超时、跨 owner 路由等只由主线程对应离线生产回归覆盖，不宣称本轮真实全矩阵通过。
- 未覆盖真实供应商失败后的恢复、长时压力、断电、其它 OS/provider/model，以及脱离工具生命周期的后台 Shell/Git 外部副作用。空 native 会话惰性持久化限制保留。
- 完整 canonical、独立生产功能/安全审查、提交与 PR 状态由主线程按自己的证据报告；本线程不重跑全量、不继续启动 Pi/模型、不提交、不推送、不合并、不发版。runner/测试证据可独立回退；生产回滚见主线程验收材料。
