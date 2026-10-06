# P32.3 Multi Session Runtime：实施与验收记录

日期：2026-10-06（第二轮接手复验）。状态：**仍未宣告通过**，由用户交 ChatGPT 复验。此前缺失的两项硬性验收证据中，真实 A/B 并行 coding 已取得通过证据；30 分钟并行压力测试结论见第五节。

## 基线与交付边界

- 本轮接手 before HEAD：`161473139598ab02685bbffbfae4b1c578e271b6`（上一轮推送 HEAD，与任务书一致）。
- 本轮 after HEAD：以 `git rev-parse HEAD` 为准（本文件提交即最终 HEAD）；未合并 main、未发版、未开始 P32.4。
- branch：`codex/p32-worktree-multisession`。工作区在本轮开始时干净，仅保留既有未跟踪目录 `.p25-1-release-a2b10ddfebd7413789311029f931a3ca/`；全程未使用 `reset --hard` / `git clean` / 强制 checkout。
- 本轮新增/修改的仓库文件仅三处：`tests/runtime-soak.cjs`（新增 opt-in 并行稳定性 soak）、`package.json`（新增 `test:runtime-soak` 脚本，1 行）、`tests/runtime-live.cjs`（等待竞态最小修复 + 失败时补充原始证据；断言与阈值未变）、本文件。
- 遵循 [ADR 0032](adr/0032-worktree-multisession.md) 的 A+B3；未改 Pi 本体、RPC/schema，未新增第三方依赖。

## 架构与 identity

每个 conversation 固定绑定一个经过 P32.2 验证的受控 worktree，拥有独立官方 Pi child、RPC bridge、Activity、ModelGeneration、project config、Browser scope、Managed Process manager、审批集合。经典主会话路径继续保留，独立会话不用全局 Renderer S 路由事件。

所有控制/回读使用完整 owner：`backendInstance / projectId / repoId / workspaceId / workspaceEpoch / conversationId / runtimeId / runtimeGeneration / sessionId`。backend/runtime identity 使用随机标识；sessionId 在官方 get_state 确认后绑定。PID 仅是观测值，不能作为控制权限。原生 session identity 在 child 崩溃时保留，错误状态仍能传到该会话；明确重启时才分配新 runtime/generation。

工作区 canonical root lease 在 spawn 前取得，生命周期 admission 与 P32.2 工作区操作共用锁；同一工作区不能有第二个 writer。恢复逐项核对 project/repo/workspace/epoch/cwd/root/branch，不接受 Renderer 提供任意工作目录。经典主工作区及其目录别名不能同时接独立 writer。

异步操作在 preflight 和执行/返回后重新校验 owner；迟到 command、history、tool result、approval、stop_state、close 不作用于新 generation。前端逐会话 revision 防止较旧 HTTP snapshot 覆盖较新的 SSE 状态；eventSequence 防止重复和乱序。focus 仅切换视图，不终止后台任务。失败清理保留 lease，拒绝新写者。

## 状态与 Stop

- 生命周期：dormant → starting → ready；child crash → error；close/restart 先 disposing，再 dormant 或新 starting。
- 活动：idle / running / stopping，attention 独立标记。
- prompt 在异步发送前进入 running，失败回滚；agent_end 不是 idle 证据，沿用 agent_settled 与权威 Stop barrier。
- Stop 只向所属 bridge 发送既有 abort/clear_queue 等协议，等待既有权威屏障；A 的 Stop 不切断 B 的流。
- 模型生成失败显示简短 error/attention，保留就绪 child 和 owner，允许同一会话 retry。
- 独立会话禁止 new_session/switch_session/fork 等改变固定 session 的命令；原经典入口仍保留这些能力。

## 资源与持久化

默认总 child 上限 2，显式确认可临时达到 3，硬上限 3；经典主工作区占一个名额。列举或打开对话记录不会 spawn。Planner/generation/verifier、Pi CLI 维护与独立池互斥，避免另一个隐含 workspace writer。

每条会话记录只保存 workspace descriptor、conversation/native session ID、经会话 scanner/header 证明的 session locator 和创建时间；不保存 child PID、token、env、消息或运行状态。启动应用重新发现真实 worktree/session，记录先显示 dormant，用户恢复时才 spawn；不使用 --continue 猜会话。

每个 runtime backlog 限制 200 帧/1 MiB，前端文本 1 MiB UTF-8、100 tool 摘要、32 审批。全局 SSE 历史限制 800 帧/8 MiB，最多 8 clients，单 client 输出/待发队列 128 MiB；超限断开并重新发现。RPC 单条 JSON 上限 96 MiB，传输分帧、有背压，LF/CRLF 分隔符不占消息预算。截断显式标记并可受身份约束回读历史。

Managed Process 全局最多 8 个活动实例，沿用 P31 spec/token/generation/tree cleanup、ready、ring buffer、脱敏。每个 Pi child/模型请求/开发进程分别消耗内存、连接和系统资源。

## Browser / Process / 审批边界

Browser 使用现有 WebContentsView/CDP，独立非持久化 partition、私有 bridge 与令牌；各 owner 默认关闭 Agent 权限。仅 focused view 展示，后台 scope 仍独立。最多两个独立 Browser scope，加经典 scope；主进程只暴露具名 preload 方法。控制权限不因启动开发服务而扩展，P29 localhost-only 与 generation/ref 检查保留。后端退出撤销所有 Browser gateway，关闭操作幂等。

Process 每会话独立 manager；跨 processId/token/bridge generation 拒绝。关闭/重启先确认自己持有的树已清理。Agent Tool Timeline 只显示工具名、ID、状态摘要，不显示原始 args、结果、env 或 worker 错误。Model/Auth 沿用既有安全投影，不复制用户 auth.json；审批闭包捕获原 owner，切换会话不会将 A 审批发给 B。

独立会话存在时，经典 workspace switch 和 Pi 维护采取明确拒绝/先清理策略。Pi child 崩溃仅该会话进入错误，不自动重启/猜旧 child；显式重启恢复原生 session，并分配新身份。

## Windows / POSIX 与退出

复用 P31 平台监督原语：Windows guardian 通过 Job Object 清理整个拥有的树；POSIX 使用受控进程组/guardian。私有认证 duplex 通道连接真实官方 Node Pi 入口，退出通过持有的 supervisor handle 完成，不按 PID 查杀。Backend EOF 与 app quit 清理 scoped child、Browser 和 owned dev process。

本机是 Windows；真实树清理、duplex、Electron、实际 Node HTTP 服务均已在 Windows 执行。**没有 POSIX 真机证据**；离线条件/协议检查不等于 POSIX 实跑。

## 一、HTTP 502 诊断结论

**结论：502 来自上游账号策略，不是 pi-GUI 的传输层或 Runtime 缺陷。因此本轮未改动任何 Runtime 架构。**

诊断链（每一步都是本轮实测，未打印任何密钥）：

| 步骤 | 实际结果 |
|---|---|
| magpie 代理存活 | `127.0.0.1:3425` LISTENING（`magpie-windows-amd64.exe`），`GET /v1/models` 返回 200，43 个模型 |
| 绕过 Pi 与 pi-GUI，直接 POST magpie `/v1/chat/completions`（model=`gemini/gemini-3.8-flash`） | **HTTP 502**，响应体为 Google 侧原文：`Gemini CLI: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite …` |
| Pi 真实版本与入口 | `@earendil-works/pi-coding-agent` **1.0.4**，入口 `dist/bundle/cli.js`（`createPiLaunch().cliEntry()` 解析，kind=node） |
| Pi 实际选择的 Provider/Model | `settings.json` → `magpie` / `gemini/gemini-3.8-flash`；magpie 上游 `gemini` 账号在 `logins.json` 中 `auth: null` |
| 本机其它 provider 实测 | `codex/gpt-5.6-sol` → 200；`zcode/GLM-5.3-Flash` → 502 `exceed quota limit`；`deepseek/*` 余额 ¥0.99；`workbuddy/*` → 200 |

即：magpie 的 gemini 路由所绑定的 Gemini CLI 个人账号已被 Google 停用，magpie 原样转发上游 502。**上游服务异常，不是 pi-GUI 实现缺陷**；不需要为它修改 Runtime 架构。

未做（按要求）：未读取/打印/提交/上传 API Key 与 OAuth token 内容；未修改用户全局 magpie 配置；未刷新 OAuth 或重新登录；未猜测任何模型是否支持工具调用（改用真实运行证明，见第四节）。

**附带安全观察（未使用、未复制、未提交其值）**：`~/.config/magpie/providers.json` 以明文保存 DeepSeek API Key。这是用户本机配置的卫生问题，不属于 P32.3 范围，仅在此记录。

## 二、本轮实测环境与两项宿主级限制

本轮 agent 会话的执行环境与上一轮不同（Git 由 2.53.0.windows.2 变为 2.55.0.windows.3），并存在两项**宿主级拦截**，与 pi-GUI 代码无关：

1. **文件 symlink 创建被静默降级为 0 字节普通文件**。连系统 `mklink` 也报「创建成功」但产物不是重分析点（`fsutil reparsepoint query` → 错误 4390），`readlink` → EINVAL；目录 junction 正常。已用隔离探针在多个目录、托管 Node、清空 `NODE_OPTIONS`、禁用工具沙箱四种条件下复现。
2. **同步 spawn 在 stdin 为管道时必然 EBUSY**。`spawnSync` / `execFileSync` 未显式给 `stdio`（默认 stdin=pipe）时返回 `EBUSY`；显式 `['ignore','pipe','pipe']` 正常，**异步 `spawn` 完全正常**（因此产品自身的 child/guardian/Process 路径不受影响）。

为取得可比较的数字，本轮使用了一个**透明 harness 适配器**（位于临时目录，不在仓库内）：仅在调用方未指定 `stdio` 且未提供 `input` 时，把同步 spawn 的默认 stdin 由 pipe 改为 ignore。它不修改任何产品代码、测试文件或断言。

第 2 项限制无法消除；第 1 项无法消除，因此 `tests/hotfix.cjs` 的 `H5 failure cleanup and path privacy: symlink` 用例在本环境**必然失败**（该用例要求 symlink 产物被拒绝为 502，而本环境根本产不出 symlink）。这是环境伪影，不是产品回归：HEAD 未变、工作区干净，且上一轮日志中同一套件为 26/26。

## 三、真实模型与 A/B 并行 coding（此前缺失项之一）

用户本轮指定使用 `magpie / workbuddy/glm-5.3-flash`（WorkBuddy 免费额度）。该模型通过 Pi 的 `openai-completions` 路径接入，凭据由官方 SDK 在进程 env 中传递；测试全程使用 `os.tmpdir()` 下的临时 Git repo、两个真实 `git worktree`、临时 agentDir 与 sessions 目录，**未触碰任何真实业务项目**。

命令：`PI_GUI_RUNTIME_LIVE=1 P32_LIVE_MODEL=workbuddy/glm-5.3-flash P32_STRESS_MS=600000 npm run test:runtime-live`

10 分钟运行结果（`live/runtime-live.json`，EXIT 0）：

| 项目 | 实际值 |
|---|---|
| 两个真实 Pi child 的原生 sessionId | `01a110fb-1e47-7124-aa45-54686a5e55fc` / `01a110fb-2233-778c-9743-52954315ebe5`（不同） |
| 真实 coding 轮次 | 4 轮，每轮 A、B 同时收到任务 |
| 累计真实工具执行数 | A/B 各 3 → 5 → 7 → 9（每轮 +2，证明 write 与 bash 真实执行） |
| 各轮 A/B 工作区 Git 状态 | 均为 `M counter.js`（各自 worktree 内被真实修改） |
| main 仓库 | 每轮 `counter = 0` 不变 |
| 断言 | 53/53 通过；`both children executed real tools` 通过 |
| 清理 | `cleanupConfirmed: true` |

即：**A/B 同时真实 coding 成功**——两路拥有不同 Pi child、不同原生 session、真实工具执行与真实文件写入，且互不污染、main 不受影响。

### 30 分钟真实并行压力测试（此前缺失项之二）

命令：`PI_GUI_RUNTIME_LIVE=1 P32_LIVE_MODEL=workbuddy/glm-5.3-flash P32_STRESS_MS=1800000 npm run test:runtime-live`

| 项目 | 实际值 |
|---|---|
| 起止 | 2026-10-06T12:04:53Z → 12:35:04Z（UTC），本地 20:04:53 → 20:35:04 |
| 实际持续时间 | **1,800,015 ms（30 分 0.015 秒）**，`EXIT 0` |
| 并行执行线 | 2 条独立 Runtime（各自 Pi child、各自 worktree、各自原生 session） |
| 完成的真实 coding 轮次 | **14 轮**，每轮 A、B 同时收到任务并各自完成 |
| 累计真实工具执行 | A 2→28，B 4→43（每轮每路 +2：write + bash） |
| 各轮工作区 | 每轮 A、B 均为 `M counter.js`，main 每轮 `counter = 0` 不变 |
| 断言 | **177/177 通过**（含每轮 `real A/B coding round N`、`main unchanged round N`、周期性 `both real children responsive`） |
| 模型/版本 | `magpie` / `workbuddy/glm-5.3-flash`；Pi `1.0.4` |
| backend RSS 采样 | 113.3–113.7 MB（14 个样本，波动 <0.4 MB，无增长趋势） |
| 清理 | `cleanupConfirmed: true`；无 generation 失败事件；无 `unresponsive` 记录 |

即：**在 30 分钟内持续、周期性地交错执行真实 Agent 工作负载**（不是让两个空闲 child 挂着等待），并全程保持 A/B 隔离。

#### 该长跑之前两次失败的原因（已定位并修复）

第一次（`live30`）在约 147 秒时 `both real children responsive` 断言失败；最小复现探针在 5 分钟内 60 次轮询**未复现**，根因未定（见"剩余风险"）。

第二次（`live30b`）在第 5 轮 `real A/B coding round 5` 失败。现场证据（保留的临时工作区 + Pi 会话 JSONL）：

- A/B 两侧会话文件都只到第 5 轮的 **user** 消息（`export const counter = 5;`），**其后没有任何 assistant 回合**；
- 两侧 `counter.js` 仍为 `counter = 4`；
- 无 generation 失败事件。

根因是**测试自身的等待竞态**，不是产品缺陷：`send()` 之后立刻轮询 `get_state`，可能在 Pi 尚未把 `isStreaming` 置真时读到 `false`，于是把"还没开始"当成"已经结束"，随后对尚未写入的文件做断言。

最小修复（`tests/runtime-live.cjs`）：在 `send()` 后先等待"运行已被观测到开始"（`isStreaming === true` 或该会话 `messageCount` 增长），再等待结束。该修改**加强**了判定——原先"未开始"会被误判为"已完成"，现在必须先证明真的跑起来了。修复后同一命令 30 分钟运行一次通过。

## 四、不消耗模型的部分证据（fixture 并行 soak）

用户本轮选择"先跑不耗模型的证据"。为此新增 opt-in 套件 `tests/runtime-soak.cjs`（`npm run test:runtime-soak`），它使用**生产实现**：真实 `createRuntimeRegistry` + 真实 `runtime-routes` + 真实 `router`/SSE 总线 + 真实 HTTP 服务 + 真实 `createSessionRuntime` + 真实 `git worktree` + 真实 Managed Dev Process。Pi child 是本地 fixture（说真实 RPC 线协议、真实写文件、真实发 tool 事件），因此**它只证明稳定性与隔离，不构成真实模型 coding 证据**。

覆盖维度（每轮循环一种）：

- 2 个独立 Runtime 在工作区 A/B 同时执行任务，断言"同一瞬间两路都在 streaming"；
- 多次 focus 切换（A→B→A→B）时后台任务不中断；
- 权威 Stop A：A 停止且不再产生新的工具副作用，B 继续并完成任务；
- A child crash（exit 7）→ A 进入 error、B 不受影响、显式 restart 后保留原生 session 并换新 runtime identity；
- 显式启用第 3 个 Runtime 并在其真实工作区完成任务，第 4 个被 `runtime_limit` 拒绝（`totalCount` 上限 3）；
- 每个 Runtime 独立 Managed Dev Process：start/logs/ready、真实端口互不相同、真实 HTTP 响应归属正确、错误 revision 被 `stale_process` 拒绝、stop A 不影响 B；
- SSE 重连：live `eventSequence` 单调无重复，`_replay` 帧被标记且仍带 owner；
- 关闭后 lease/slot 回收（`inUse(root)=false`、`liveCount` 递减）；
- 后端重启：新 registry 从磁盘重新发现会话为 dormant、不自动 spawn，resume 后绑定**同一原生 sessionId** 并分配新 generation；
- 结束时无存活 runtime、全部 owned 树清理确认。

结果（30 分钟版，`PI_GUI_SOAK_MS=1800000`）：

| 项目 | 实际值 |
|---|---|
| 起止 / 持续时间 | 2026-10-06T13:16:56Z → 13:47:11Z，**1,809,952 ms（30 分 10 秒）**，`EXIT 0` |
| 轮次 / 断言 | **215 轮 / 1140 项断言全通过**，`failures: []` |
| 维度覆盖 | coding 53、focus 27、stop 27、crash 27、runtime 上限 27、managed process 27、SSE 27 |
| A/B 真实并行重叠 | 53/53 个 coding 轮次都观测到"A、B 同一瞬间都在 streaming" |
| SSE | 重连 28 次，累计 27,325 帧，live `eventSequence` 全程单调无重复，`_replay` 帧均带 owner |
| backend RSS | 71.4–228.8 MB（216 个样本） |
| 结束时 | 无存活 runtime、无 owned 树残留、租约与槽位已回收 |

soak 装置在验证期自身发现并修掉两处 **harness** bug（不是产品缺陷）：① 失败路径没有关闭监听中的 HTTP 服务与 SSE 客户端，导致进程不退出（表现像"清理挂住"，隔离探针证明 `manager.dispose()` / `runtime.dispose()` 实际为 206 ms / 132 ms）；② 用 `processes[0]` 取受控进程，而早前轮次留下的已退出记录排在前，导致找不到本轮进程（第 14 轮"process ready B"失败与"B process closed"超时均由此而来）。改为按进程 id 定位后即通过。

> 本节是**不消耗模型的部分证据**，只证明稳定性与隔离，**不能替代**第三节的真实模型 coding 验收。

## 五、最终测试结果（本轮实测）

### 完整 `npm test`

- 链式 `npm test`（仓库唯一入口）：**EXIT 1**，在第 7 个脚本 `tests/hotfix.cjs` 中断（`&&` 链），原因是上文环境伪影的 symlink 用例。前 6 个脚本通过，其余 72 个未执行。
- 为不被一个环境伪影遮住其余结果，另用同一入口的脚本清单**逐个运行**（不改任何测试）：**78/79 通过，仅 `tests/hotfix.cjs` 失败**（25/26，唯一失败项是 symlink 环境伪影）。
  - 说明：首轮逐脚本运行时因与本轮 soak 冒烟并发，`models-api.cjs`（本地 6665 端口）与 `runtime-processes.cjs`（process ready 超时）出现瞬时争用失败；无并发负载重跑后两者均通过（50/50、10/10），故以 78/79 为准。

### P32.3 专项（`npm run test:runtime`，10 个套件）

| 套件 | 结果 |
|---|---|
| runtime registry | 31/31 |
| runtime HTTP | 12/12 |
| runtime store | 25/25 |
| runtime UI | 14/14 |
| session factory（真实 Windows guardian + fixture Pi） | 5/5 |
| Pi supervisor | 24/24 |
| runtime Browser scope | 45/45 |
| 全局 Process budget | 4/4 |
| SSE bounded delivery | 14/14 |
| 实际 Node HTTP Process | 10/10 |
| **合计** | **184/184** |

与上一轮报告数字完全一致。

### Electron 真机（`npm run test:runtime-electron`）

**36/36，8 张截图，EXIT 0**。使用实际 Electron 44.4.3 + production server + 临时真实 Git + fixture Pi，覆盖 A/B 独立 child、focus 切换、真实 HTTP 权威 Stop、独立 Browser scope 与 CDP snapshot 隔离、remote 权限拒绝、崩溃/重启、磁盘重新发现、三个分辨率与 125% 缩放、真实键盘 Escape/Tab。

### 构建与打包

本轮未改动 `public/`、`server/`、`electron/` 任何文件，因此未重新构建产物；上一轮的 `build:app` 成功记录（整包 327.7 MB）继续有效。**本项为"未重新执行"，不是本轮通过。**

## 六、代码变更与回归测试

| 变更 | 原因 | 回归 |
|---|---|---|
| 新增 `tests/runtime-soak.cjs` | P32.3 缺少可复跑的并行稳定性/隔离证据载体（fixture，不耗模型） | 自身即断言集；opt-in，不进 `npm test` |
| `package.json` 新增 `test:runtime-soak` | 让该 opt-in 套件可被复跑 | 1 行，`npm test` 链未变 |
| `tests/runtime-live.cjs` 修复等待竞态 | 30 分钟运行曾在 `real A/B coding round 5` 失败：`send()` 后立即轮询 `get_state` 可能读到运行开始前的 `isStreaming=false`，把"未开始"当"已结束"。现场证据为会话 JSONL 只有 user 消息、无 assistant 回合 | 在 `send()` 后先等待"运行已被观测开始"（`isStreaming===true` 或 `messageCount` 增长）再等待结束。判定被**加强**：修复前"未开始"会被误判为"完成"，修复后必须先证明真的跑起来 |
| `tests/runtime-live.cjs` 失败时记录原始证据 | 第一次 30 分钟运行在 `both real children responsive` 失败，但无法判断是 `rpc-bridge` 的 10 秒请求超时（返回 `null`）还是 child 已死 | 断言、阈值、判定完全未变，仅新增 `report.unresponsive` 诊断字段 |

**未做任何"为通过测试而放宽"的改动**：未放宽 ownership、Stop、路径校验、权限或资源上限；未删除既有断言；未跳过失败测试；未用 sleep 或 PID 存在替代权威状态。

## 七、结论

| 分类 | 内容 |
|---|---|
| **已通过** | ① 真实 A/B 并行 coding（独立 Pi child/原生 session、真实工具与文件写入、工作区与 main 隔离）；② **30 分钟 2 路真实并行压力测试**（1,800,015 ms、14 轮、177/177 断言、RSS 平稳、清理确认）；③ **30 分钟 fixture 并行 soak**（1,809,952 ms、215 轮、1140/1140 断言、53 次并行重叠、28 次 SSE 重连、无残留）；④ P32.3 专项 184/184；⑤ Electron 真机 36/36；⑥ 逐脚本完整套件 78/79；⑦ HTTP 502 根因定位（上游账号策略，非产品缺陷） |
| **未通过** | 无产品级失败项 |
| **未执行** | 本轮未重新构建/打包（未改 `public/`、`server/`、`electron/` 产品代码）；POSIX 真机验证；三 Chromium view 内存 |
| **外部服务阻塞** | `gemini/*` 全部经 magpie 返回 502（Google 已停用该个人账号的 Gemini CLI 登录，需用户迁移到 Antigravity 或指定 GCP 项目）；`zcode/*` 配额超限；`deepseek/*` 余额 ¥0.99 |
| **环境限制（非产品）** | ① 文件 symlink 被宿主静默降级 → `tests/hotfix.cjs` 的 `H5 … symlink` 用例必然失败，并因此使链式 `npm test` 在第 7 个脚本中断；② 同步 spawn stdin=pipe 必然 EBUSY → 需透明 harness 适配器才能跑完；③ 首轮逐脚本运行曾因与本轮 soak 并发出现两处瞬时争用失败，无并发重跑后消失 |

**本轮不宣告 P32.3 验收通过。** 未合并 main、未发布、未开始 P32.4。HEAD、验收摘要与剩余风险由用户交 ChatGPT 复验。

## 剩余风险

1. **一次未定根因的间歇失败**：本轮第一次 30 分钟运行（`live30`）在约 147 秒的 `both real children responsive` 断言失败；最小复现探针在 5 分钟内 60 次轮询未复现，此后两次 30 分钟运行（`live30b`、`live30c`）也未在该断言处失败。`rpc-bridge.request()` 默认 10 秒超时返回 `null`，因此该次失败可能只是"某次 `get_state` 超过 10 秒"，也可能是 child 真实退出。本轮已给测试补上 `report.unresponsive` 原始证据记录（记录 raw 返回形状与 bridge state）以便下次直接判定，但**该单次事件的根因未定**，属未决风险。
2. `runtime-live` 让两个 child 共用同一个 `--session-dir`（临时目录），这与产品中每个 runtime 各自按 cwd 分目录的形状不同，是上述间歇现象的候选干扰源，本轮未证明也未排除。
3. 第三方 Extension/MCP/全局 memory 不是 OS sandbox，可能共享内部状态；不承诺完全隔离。
4. 清理无法证明时保留 lease，需要人工恢复；不自动 stash/reset/强制移除。
5. POSIX 真机、三 Chromium view 内存、不同 Pi 版本兼容性仍待后续阶段验证。
6. `gemini/*` 在本机仍不可用（上游账号策略）。在用户迁移 magpie 的 Google 账号（Antigravity 或 `GOOGLE_CLOUD_PROJECT`）之前，本机默认模型仍会返回 502；本轮验收改用 `workbuddy/glm-5.3-flash`，结论不依赖 gemini。
