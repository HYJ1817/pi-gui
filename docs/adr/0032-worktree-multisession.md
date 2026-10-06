# ADR 0032：Worktree 与并行 Session 的隔离边界

- 状态：**Proposed / 待 ChatGPT 验收**；不是已批准的实现决策。
- 日期：2026-10-06。
- 基线：main / v0.22.0，`30ffad882748264866a9c23c663eae302e975f9e`。
- 分支：`codex/p32-worktree-multisession`。
- 当前阶段：P32.1 Design Spike。只新增设计文档，不改变产品行为。
- 勘察与验证：[P32.1 报告](../p32-design-spike.md)。

## 1. 问题与目标

目前 Pi GUI 只有一个聊天 bridge、一个权威 currentCwd、一份聊天状态和一个内置浏览器。选择项目会重启 Pi；选择历史会话会替换 Pi 内的当前会话。将这些操作直接用于多个后台会话，会把“查看另一条对话”变成“结束上一条执行线”。

P32 要支持同一 Git repo 的独立 Agent 同时工作，同时保留 P30 的克制界面、P29 的独立 Browser 权限、P31 的进程所有权与 Stop 权威屏障。默认模型为：

```text
Project（Git common directory 身份）
├─ Main workspace（已有工作区，最多一条 GUI 写执行线）
├─ Conversation A → Worktree A → Runtime A → Pi child A
├─ Conversation B → Worktree B → Runtime B → Pi child B
└─ Conversation C → Worktree C → Runtime C → Pi child C
```

这里的 Conversation 是 GUI 的稳定会话记录，Pi sessionId 是 Pi 回读的原生身份，Runtime 是本次存活执行线。三者不能合成一个 PID 或“当前 tab”。历史会话、已关闭的 worktree 与打开的视图都不必拥有活着的 Pi child。

此隔离是 GUI 的默认调度与目录归属保证，**不是 OS sandbox**。Pi 的 bash、第三方 Extension、用户在外部终端执行的命令仍有当前用户的文件权限；不能声称 worktree 阻止了恶意绝对路径写入、外部 Git 操作或所有第三方资源共享。

## 2. 已核实的当前事实

| 范围 | 当前实现与证据 | P32 的含义 |
| --- | --- | --- |
| 组合根 | `server.js:142,168,273–306` 单实例 runtime / SSE / rpc / Process adapter / Activity / model-generation | 保留组合根与注入方向，建立 registry 后按执行线实例化；不是重写 Pi runtime |
| 工作区 | `server/runtime.js:15–35` 只有 currentCwd、workspaceGeneration、shuttingDown；`server/projects.js` 激活目录后重启 | currentCwd 不能充当后台命令的目标；focus 与 runtime lifecycle 分开 |
| Pi bridge | `server/rpc-bridge.js:159,259,283–284,395,418,806` 持有一个 child、pending 表、run/launchGeneration 与 ready snapshot | factory 可复用，但必须注入固定 owner，阻止后台实例读取可变 active cwd |
| 会话加载 | `server/sessions.js:301,646–666` header.cwd 归属校验，后端查 ID 再传文件路径给 switch_session | 历史查询按明确 workspace；不能放宽成“同 repo 就任意 resume” |
| 前端 | `public/state.js:170` / `public/rpc.js:357` 清理单份状态；`public/app.js:149–185` 全局 SSE + 单 bridgeRun | 背景事件先路由到 owner 的状态，focused DOM 只是投影 |
| Timeline | `public/tools.js` 使用 `S.tools`；`public/tool-model.js` / `tool-history.js` / `tool-view.js` 共用结构与安全投影 | 复用纯模型，按会话隔离表、计时器、Git 回填和历史重建 |
| Git | `lib/git.js:149` 参数数组、shell:false、有界输出/超时；`lib/git.js:933` worktreeTree 为临时 index 写 tree 的变更证据 | 已有 helper 不是 create/list/remove 生命周期；新增独立管理模块，不调用证据采集来判断删除安全 |
| 路径 | `lib/safe-path.js:78–119` lexical + realpath + 父目录校验 | 可复用比较原语；外部 managed worktree 根需要独立的根级校验，不能借项目内文件路径接口绕过 |
| Browser | `electron/browser-view.cjs:91,218` 一个 controller、固定内存 partition；`browser-agent-host.cjs:8` 一个 Agent/bridge；`browser-agent-bridge.cjs:10` 一个 run token/队列 | 只轮换 token 不够：页面、partition、队列、refs 与 IPC 也必须按 runtime 隔离 |
| Process | `server/process-bridge.js:13–16,56` owner 是 cwd/workspace/run/session；`managed-processes.js:69–85` owner 换代即清理且关闭权限 | 每 runtime 一个 manager/private credential；focus 切换不调用 invalidate |
| Stop | `server/rpc-bridge.js:655–700` Process cancel → Browser cancel → clear_queue → await abort；超时保留屏障 | 每个 runtime 独立 barrier；全局 UI Stop 只能明确选择一个 owner |
| Planner | `server/planner/index.js` 独立 Pi CLI；`scheduler.js:8,445–503,646` 默认串行，可配置并发，冻结 cwd；组合根阻止忙时切项目 | 不并行重写 Planner；跨聊天/Planner 的 workspace 写 lease 与全局资源预算必须覆盖它 |
| 认证/更新 | `server/provider-auth-runtime.js` 单 bridge 重载回读；`server.js:651` 单聊天忙判断 + CLI/Planner/Auth 维护闸门 | 用户级凭据仍共享；维护判断聚合所有 runtime，不准只看 focused 会话 |
| Electron/退出 | `electron/main.cjs:172,318` 一个私有 backend 与整树收尾；`server.js:784–808` 单 rpc/manager shutdown | 仍一个 backend/窗口；退出遍历全部 runtime，不能依赖 focused 项 |

以上是基线代码事实；章节 4–10 都是待批准方案。源码范围中的行号只对应上述 before HEAD。旧文档的会话排序和 Pi 版本有历史描述：当前排序以 `docs/runtime-recovery.md` 和实际代码为准，不用 mtime/current 提升普通会话位置。

## 3. Pi 官方语义与会话存储

本机通过仓库 `createPiLaunch().packageDir()` 定位实际 launch 所属包，仅只读源码，确认 `@earendil-works/pi-coding-agent` **1.0.4**。没有执行模型请求，没有读取真实 auth.json 或用户会话正文。以下路径均相对该包根，而不是猜测全局安装目录。

| 上游证据 | 结论 |
| --- | --- |
| `dist/modes/rpc/rpc-mode.js:24–26,299–355,474–479` | runRpcMode 持有一个当前 session；prompt、get_state、abort 都操作它；switch_session 调 runtimeHost 后 rebind。RPC 没有把每条 prompt 指向不同 session 的多路选择协议 |
| `dist/core/agent-session-runtime.js:102–145` | 替换前 await 当前 session.abort()、发 session_shutdown、dispose，再创建/绑定目标 runtime。用 switch_session 复用一个 child 会终结 A，而非让 A/B 同时 streaming |
| `dist/core/agent-session.js:1905–1923` | abort 中止并 await waitForIdle。stdin 已写入、agent_end、时间到了都不是可替代的 idle 证明 |
| `dist/config.js:491–497` | 默认 agentDir 为 `~/.pi/agent`，受 PI_CODING_AGENT_DIR 覆盖影响；GUI 的 models.json 与 session scanner 共用该变量，路径规范化仍需对拍 |
| `dist/core/session-manager.js:290–301,695–713,1316–1361` | JSONL header 含 cwd/id；默认 sessions 根按 cwd 编码；--session-dir 指定显式目录；open/continueRecent 有不同 cwd/目录语义 |
| `dist/core/auth-storage.js:39,85` / `settings-manager.js:108` | 原生存储已有锁，但多个 child 的内存模型目录与配置仍需分别回读；文件锁不等于 runtime 同步 |

主聊天继续使用官方默认 session 存储和原生 schema；每个 worktree 自己的 cwd 对应不同目录。目录编码不是唯一 ownership 证明（不同路径可能编码碰撞），仍核对 header.cwd、原生 id、真实路径与 GUI 映射。Planner 的 `<PI_GUI_DATA>/planner-sessions` 与主聊天保持分离；精确跳转沿用 extraSessionRoots 和 header 规则。

一个当前兼容注意点：官方 getAgentDir 展开 `~`，`server.js:133–134` 的 models.json 路径也展开，而 `server/sessions.js:111–114` 直接使用覆盖值。P32 的目录发现须针对 `~`/相对路径/测试 HOME 明确对拍；本 Spike 未验证这些输入的实际行为，也不在文档提交里顺带修改它。发现无法证明一致时提示不可用，不扫描其它“常见路径”补事实。

GUI 新增 manifest 放在自身 DATA_DIR，只存 repo/workspace/conversation 关系、受控路径/branch/source commit、归档状态和期望恢复的 session locator。**不移动、重写或修改 Pi session schema，不复制真实账户，不为每个 child 建新 auth 目录**。工作区的项目配置、指令文件和本地 Extensions 由对应 workspace context 读取；不得拿 main 的可变配置 writer 往所有 worktree 同步。未提交配置不隐式复制，新工作区从选择的 commit 建立，这个差异必须在创建提示里显示。

已有 Project 可以是 repo 的子目录：保留其相对 Git top-level 的 project prefix，在新 worktree 中定位同一子目录，校验存在与 realpath 边界，不静默退到 worktree root。writer lease 按整个 worktree root 而非项目子目录互斥；两个项目条目指向同一个 repo/worktree 也不能成为共享写入旁路。Git common-dir 的 repo identity 用于分组，具体 worktree root 用于写隔离，二者不能混淆。

## 4. 方案比较与建议

“Session Pool”有三种不同含义，必须区分：B1 在一个 Pi child 内轮流 switch_session；B2 在 GUI 内 import SDK 创建多个 AgentSession/共享 services；B3 维护有上限的独立 child 池。B3 是 A 的资源管理方式，不是共享 runtime。

| 维度 | A：每个活跃 Session 独立 child/bridge | B1：共享 RPC child | B2：GUI 托管多个 SDK Session |
| --- | --- | --- | --- |
| 文件隔离 | 固定 cwd + 独立 worktree + 写 lease；仍非 sandbox | 需要切 cwd，当前 RPC 无此并行协议 | SDK 可创建不同实例，但必须重新审计 services/cwd/tool state |
| 官方语义 | 原样使用 pi --mode rpc，单 child 单当前 session | switch_session 会 abort/dispose 当前线，不能同时 streaming | 公开 SDK 不等于仓库已接受 runtime 迁移；违反本阶段不迁移的约束 |
| 复杂度 | registry、事件 envelope、scoped adapter；复用现有 factory | 串行切换看似便宜，实际不能满足产品目标 | 重建启动、Extension、stdio、恢复与服务生命周期，兼容风险最高 |
| 内存/成本 | 多份 Pi/module/model/Extension/MCP 资源，须限额；尚无本轮实测数字 | 串行时低，但达不到并行 | 可能共享部分内存，收益未知且故障共享，不能靠推测承诺 |
| 事件路由 | child closure 绑定 immutable owner，request 表天然分开 | 旧 session 事件和替换边界难分，改协议才可能多路 | 需自己复制 Pi 原有 runtimeHost 的路由/解绑语义 |
| Stop | 每 bridge 独立权威屏障 | abort 作用于唯一当前 session，无法独立停止同时运行的 A | 可以实例级 abort，但需要重做生命周期、工具取消证明 |
| Browser | 每 runtime 独立 view/partition/controller/capability | 不能从当前 child 凭据恢复独立页面 ownership | 仍需新隔离 host，并无免费收益 |
| Managed Process | 每 runtime manager，复用 guardian、spec、日志策略 | session 替换导致现有 manager 清理，无法保留后台服务 | 同样需 scoped manager；共享内存不能替代所有权 |
| 崩溃/恢复 | crash A 不杀 B；按磁盘 session/worktree 发现，lazy fresh spawn | child crash 所有会话失去 runtime；必须串行恢复 | GUI backend/共享 services 故障影响面大，兼容测试成本最高 |

**建议接受 A，并采用 B3：有上限、按需启动的独立 child registry。** 不修改 Pi RPC、Pi 核心或全局安装。单 session 的现有 bridge、Stop 与 Process guardian 保留；增加显式 owner 与 registry 路由层。不能把 B1 包装成同时并行功能。SDK Auth worker 仍是独立的现有例外，不因此把聊天迁移到 SDK。

## 5. 身份、事件与状态合同

### 5.1 稳定身份与存活身份

| 字段 | 来源/寿命 | 校验用途 |
| --- | --- | --- |
| projectId / repoId | GUI 随机稳定 ID，后端绑定 Git common-dir 的规范真实路径及登记事实 | 同 repo 的 worktree 与项目子目录识别，不能仅靠 remote URL |
| workspaceId + workspaceEpoch | GUI 稳定 ID + 每次失效/重绑定的随机 epoch；main 也有 ID | path/HEAD/branch/健康状态归属；路径被替换不自动继承信任 |
| conversationId | GUI 稳定记录 ID，创建即存在 | 尚未落盘的新会话、草稿、搜索和 tab 归属 |
| sessionId / sessionLocator | get_state 或合法 JSONL header 的 Pi id；locator 只在后端解析 | 不伪造 Pi id；未就绪可为 null，ready 后必须匹配已绑定会话 |
| backendInstance + runtimeId + runtimeGeneration | 后端实例随机身份、registry runtime UUID、每次启动新随机 generation | HTTP/SSE、request/response、Stop、late callback 的存活身份；bridgeRun 是实例内部计数 |
| browserScope / browserGeneration / documentGeneration | Electron host 登记的 runtime owner + view/文档代次 | refs/CDP/console/network/cancellation 不能跨页或跨 runtime |
| processScope / processId / revision / spawnIdentity | per-runtime manager + P31 内部 UUID/revision/guardian 句柄 | stop/restart/log 全部校验 owner，PID 仅诊断信息 |

`activeConversationId`、viewEpoch 与 UI workspaceGeneration 只是显示/加载选择，不是执行 ownership。registry 中的 runtime context 固定绑定 cwd、workspace 和 conversation；不闭包读取全局“当前项目”。对旧接口的兼容入口只允许明确单 runtime 场景；多个 runtime 存在时缺目标身份的写请求必须拒绝，不能自动落到 focused 会话。

### 5.2 命令与事件

命令至少携带期望的 backendInstance/runtimeId/runtimeGeneration、projectId/workspaceId/workspaceEpoch/conversationId 和绑定后的 sessionId。后端从 registry 解析实际 cwd、bridge、session file，不收 Renderer 给的任意路径或 child PID。读 body、等待锁、异步 preflight 后、写 stdin/调用 controller 前再核对身份。Pi wire 仍是官方原格式；GUI envelope 不传进 Pi。

每个 child 的发布闭包先核对当前 registry owner，再附 owner envelope、经现有安全投影后入 SSE。Pi response.id 只在自己的 pending 表匹配；数字内部请求不进 Renderer。toolCallId/approval requestId 即使在 A/B 相同，也只能在完整 owner namespace 下匹配。另附 owner 内事件序号用于发现流缺口，它不是 session 身份或时间推断。

保留单条 SSE transport 与全局 _seq；_seq 用于重放去重，不用于猜 session。每个 runtime 有独立 snapshot/revision 与有限 backlog 预算；重连同步给出 registry 当前快照。先按 backend identity / owner / generation 路由，再更新对应会话状态，最后仅渲染 focused 会话。缺 scope 的聊天事件 fail-closed；应用级更新、项目目录等事件使用明确独立类型。_replay 不触发通知、审批或命令，也不能覆盖当前生命周期事实。

背景对话内容保留有界缓冲，超限标记需从官方历史重建；不永久保存每个后台 DOM。切到仍 streaming 的会话时，用 scoped get_state/get_messages 加事件序列边界协调历史和后续流，防止丢 chunk/重复结果；历史与 live 共用 Timeline 模型。每个会话草稿、导航、工具表、Git 防抖、Usage、模型请求、fallback 与审批表独立，不只给 S 套一层 map。

### 5.3 状态与写 lease

- runtime lifecycle：dormant → starting → ready → disposing → closed；spawn/handshake/crash → error；恢复或手动重启生成新 generation。ready 不等于正在生成。
- turn/activity：idle → running（已接受 prompt 即进入 pending）→ stopping → idle；agent_settled/readback 或 abort 权威应答收口。agent_end 不代表 idle。Stop 未确认则保持 stopping 与发送屏障，并附可恢复的 error code。
- attention/unread 是独立 UI 元数据：后台收到完成/错误/审批时标记；选中并查看后清除。不能拿 unread 代替运行状态。
- workspace writer lease：规范 worktree root 全局互斥，同一 Pi session locator 也互斥。GUI 能启动的聊天、Planner/CLI task、验证与 Git 写操作都登记所有权；读取无需 writer lease。lease 覆盖可写执行线和仍存活的 managed dev process，不能仅在 isStreaming=true 时持有。运行中的单 session 内受控 dev server 属于同一 owner，不当成第二个 Agent。
- 并行新 Agent 默认分配新 worktree；已存在 main 历史可只读查看。要复用已有 workspace 写入，先显式关闭旧 owner 并确认 child/工具/服务清理，再交接 lease。Planner 首版保持串行同 workspace；跨工作区可与另一聊天并行，但同工作区 GUI 写者互斥，不增加 Planner 多 worktree 调度。

## 6. P32.2 Worktree 生命周期（待进入）

建议新增 `server/worktrees.js`（生命周期/manifest/健康/串行事务）、`lib/git-worktree.js`（有界 Git args 原语）；组合根注入 projects/runtime，不让 Git helper import 业务层。复用 safe-path 比较、现有 HTTP 认证、Git timeout/输出限制；只为需要的 Git 调用提取受控 runner，不重写 git.js。

创建步骤：按 projectId 解析 repo → Git common-dir/top-level 验证 → 所选 source selector 解析为确定 commit，目标 branch 通过 Git check-ref-format → 只读预检 main dirty/branch/path → 用户看到确定的源提交、目标 branch 与“不包含未提交改动/配置、不 stash/reset”提示 → 后端持有 repo 事务锁，重新检查 → 用 shell:false 参数数组 git worktree add → 回读 porcelain 与真实路径/admin link → 原子登记 manifest。默认使用本地明确选择的 source，不隐式 fetch。UI 输入只允许命名建议/source selector，不接收工作区绝对路径；确认绑定预检 nonce 与 repo/source 身份，预检变了重新提示。

目标路径由后端生成：`<PI_GUI_DATA>/worktrees/<repoId>/<workspaceId>`；目标 branch 建议 `pi-gui/p32/<workspaceId 的受控短标识>`，用户可给合法名称但不能覆盖/强制移动现有 ref。目录必须不存在；规范父目录位于受控根内，拒绝 symlink/junction/reparse 逃逸、NUL/traversal/option 注入/跨盘别名。复核完整 workspaceId 与真实路径，不凭短 branch 名证明 ownership。Git common-dir 可在项目根外；只信后端发现的 .git 管理关系，不把 .git 文件当普通目录。

create/list/open/archive/remove 的语义：

| 操作 | 安全合同与失败恢复 |
| --- | --- |
| create | dirty main 不阻断从已提交 source 创建，但必须提示且不复制 dirty 内容；空 Git repo 无 commit 拒绝，提示先人工提交；branch/path 冲突明确报错，不覆盖 |
| list | `git worktree list --porcelain -z` 是当前事实，manifest 是 GUI ownership；解析 locked/prunable/missing、detached HEAD、branch、common-dir；外部 worktree 可显示只读，不冒认可删除 |
| open | 重新 realpath/验证管理关系与健康；打开 metadata/历史不 spawn。P32.2 可顺序使用当前单 runtime，不宣称并行；执行仍走已有 busy/Stop 闸门 |
| archive | 先确认 runtime/服务停止，再标记归档；保留目录、分支与会话。不是压缩、搬目录或删除，不把 session archive 等同 worktree archive |
| remove | 仅 GUI 登记且身份吻合、非 main、非 locked、无 runtime/进程/CLI lease 的健康 worktree；检查 staged/unstaged/untracked、ignored 文件、冲突、submodule/nested repo，以及相对创建时登记的安全整合目标当前提交的未合并提交；未知、无安全整合目标或无法确认即拒绝。dirty/ignored 文件默认保守阻断，由用户在外部自行保留/清理，不提供 --force |
| 外部删除 | 标记 missing，撤销该 workspace epoch/权限与待执行请求，终止其 owner；保留 branch/session/manifest。提供查看历史或选择新 worktree 恢复路径，不悄悄重建被删目录、不落到 main |

remove 预检和实际操作在 repo/workspace 锁内复核，先使 owner tombstone、确认工具/进程整树停止，再执行 **git worktree remove，无 --force**，成功后核实 Git 登记与路径结果。保留 branch，不自动 branch -D；未合并历史不会随 workspace 清理丢失。失败恢复 manifest health，不回退到 recursive rm。Git 不支持或安全性无法确认时只归档，用户可人工处理。

create 失败可能已产生 branch/worktree：admin 回读确定部分结果；保留可发现记录和明确错误，不用粗暴删除进行回滚。prune 是 repo-wide 操作，首版不自动执行、不借 missing 清掉用户其它 worktree 登记。external path replacement/同路径新 repo 必须重新验证，不继承旧权限。

健康检查在 list/open/执行或删除前重新读取真实 Git/路径事实，存活 owner 还有有界周期检查；watcher 仅作加速，不是唯一证据。发现路径消失、管理关系变化或可用的文件系统 identity 变化就 tombstone 旧 workspace epoch。无法证明已恢复的是原受控目录时要求重新绑定，不以路径字符串、mtime 或“又出现了”恢复权限。

非 Git 项目保留现有单会话能力，解释“并行隔离需要 Git worktree”，提供选择 Git 项目/顺序工作路径；不自动 git init、commit、stash、reset、checkout 或迁移真实数据。

## 7. P32.3 Runtime、Browser、Process 与 Stop（待进入）

建议新增 `server/session-runtime-registry.js`、纯 owner/协议校验模块；对 rpc factory 与 router 做小范围注入与显式目标路由。保留一个 HTTP server/Electron backend，不为每个对话启动完整 GUI server。

- 创建 runtime 前检查健康、会话归属、writer lease、全局额度；第一次发送/明确恢复才 spawn。新会话不使用 --continue 猜最近记录：后端给新 conversation 明确的新建意图，通过已核实的官方 session 参数/命令生成并回读；历史恢复用已验证 --session locator。参数合同在 P32.3 先 fixture 验证，不能在两个 child 上恢复同一个 session file。
- crash/restart 仅该 runtime 换代；撤销其 Browser/Process 凭据并清理服务，旧 pending 全部 settle。如沿用 bridge 自恢复退避，必须受 registry slot/lease/shutdown 约束，不能额外无限 spawn。不可恢复时会话 error，B 继续；session 替换/fork 是 owner handoff，focus 是纯显示操作。
- 每 runtime 一个 Process bridge/manager，context 固定 owner，沿用 P31 spawn identity、revision、spec、ready TCP/HTTP/marker、256 行/64 KiB 脱敏 ring、Windows Job/POSIX guardian。UI list/log/stop/restart 也带完整 owner，不接受单 processId 推断。端口属全机，不能把不同 worktree 当成端口命名空间；登记已知 endpoint，重复端口依原策略失败。
- Electron 建有上限的 Browser host registry，每个 runtime 单独非持久 partition、WebContentsView/controller/Agent/串行 action queue、document refs、console/network 和工具凭据。复用现有 controller/CDP 实现，不开新 Chrome。现有固定 PARTITION 与 isBrowserWebContents 判断需改为登记的独立 session 集合；确保任何子页面都拿不到 GUI token，权限处理仍由 main 守住。
- 窗口只有一个 right-pane，挂载 focused owner 的 view；其余存活 view 不换 owner，可在后台完成授权动作。bounds/occlusion/open/close 与 agent-enable IPC 都携 owner 并验证 trusted sender；focus 隐藏不撤销权限，用户明确关闭 Browser 才取消并 dispose 该 view。A 后台工具“打开”只标记 A attention，不把页面强塞进 B 右栏。
- Browser default-off、loopback-only 和 Process default-off 完全独立。Agent Browser 不因 dev server start 获远程权限；从 A 打开 B 已登记的 owned dev endpoint 默认拒绝（含 loopback 别名/跳转/子请求的归一化），未归属 localhost 保留 P29 策略但不声称属于 A。外部终端/未知端口不是隔离证明，手动 Browser 的既有权限仍与 Agent 模式区分。登记端口范围的限制不替代 OS 网络 sandbox。
- Stop A：按 A owner 立 barrier → cancel A 在途 Process 动作（ready 服务按 P31 留待显式 stop）→ await A Browser cancellation → A clear_queue → A abort/idle 证据。B 不参加、不撤销、不清队列。UI focus 到 B 后 A 的 stop_state 只改 A；A 超时不能解除 B 或 A barrier。双 Stop 同 owner 合并，disposed generation 的回调无权释放新 lease。
- 后台审批在所属会话记录 pending/attention，禁止切 tab 把同 requestId 应答发给另一 child；全局 modal 仲裁要显式显示 owner。显示被遮挡不能自动拒绝另一会话审批；用户 Esc 只拒绝当前展示的那项，Stop/close 取消该 owner 全部 pending。历史 replay 不弹 modal。
- Provider/Model/Thinking/Usage/Fallback 按 runtime 回读；Credentials/Auth/MCP 配置安装/Pi 更新属于用户级资源。认证后的同步标记所有受影响 runtime，忙时等待，逐个安全重载并回读，不强杀另一会话。更新/安装必须汇总全部 child、Planner、CLI、Process 清理与维护屏障；不存在“B 空闲所以可更新”的旁路。只读 capability 观察也绑定 owner/run，不能将 A 的已观察能力移给 B。

## 8. 恢复与退出

manifest 使用版本化小型 JSON、原子写、限定大小，不存 PID、token、env、原日志或完整会话消息。应用恢复先重新发现 Git worktree 与官方 session header，对照 manifest；再生成全新 backendInstance/runtime generation。以前 running/stopping 只能呈现 interrupted/需恢复，不认为旧 child 还活着。所有 session 默认 dormant；查看历史不启动 Pi，恢复任务必须显式发起并重新校验目录/slot/lease。原生记录尚未落盘的新空会话允许保持 conversation metadata，不能伪造历史。

恢复到另一个 worktree/cwd 不是直接 resume 旧文件：原 header.cwd 不匹配就拒绝普通加载。用户明确选择继续旧上下文时，只有实际 launch 已证实支持的官方 CLI `--fork` 等跨 cwd 新建机制可用，创建新的原生 session 并回读归属；不修改旧 header、不复制会话文件冒充新会话、不调用私有 SessionManager。能力未知时仅提供只读历史或新空会话。外部删除导致的未提交代码丢失不能由聊天历史恢复承诺替代。

close runtime：阻止新动作、owner tombstone/换代 → 取消请求/审批/Browser → 清理 Process 与 Pi child tree → 确认关闭 → 释放 lease/slot。未确认树清理保持 error/cleanupPending，不把 workspace 转给下一 writer、不允许 remove。worktree archive/remove 等待这条生命周期；关闭 tab 的显示动作须与“结束执行线”分开确认，不能偷偷终止 streaming。

应用退出阻止所有新 spawn，收尾所有 runtime、Planner/Verifier、Browser registry、Process guardian 与 SSE，再有界等待；清理不确认写安全摘要。现有 Electron killServer 和 agents/cli killTree 用 taskkill/POSIX group，属于当前实现，**不等于已满足 P32 PID 复用防误杀证明**。P32.3 必须采用存活 child handle/私有管道 + 实例 token 的生命周期核验，并在 Windows 能力支持时将 owned Pi 树纳入已验证 Job 监督策略；不能拿磁盘 PID 做 fallback。POSIX 以 owned 存活 group leader 控制，主动 daemonize/setsid 不在 P31 首版保证范围。EOF/guardian/Job close 的突然退出清理需覆盖多 owner 真机，不能只验证 graceful quit。

## 9. P32.4 UI 与资源预算（待进入）

侧栏仍 Project → session rows，附短 worktree/branch 标签和一个最低必要状态：运行中、停止中、错误；未读/待处理用弱标记。idle 不加持续状态文案。项目/会话创建顺序与稳定 tie-break 保留；当前/活跃/mtime 不置顶，折叠/搜索/三点菜单与键盘焦点保持。

行点击只 focus/switch；三点菜单包含 Stop 单会话、打开 worktree、查看 Changes、关闭执行线、归档/安全移除。低频创建与安全确认复用现有 modal 与 palette，不新增监控一级入口。Changes/Browser/Process/Review 按 focused owner 进入已有 right-pane；关闭不留空栏；背景状态变更不抢焦点。搜索按 project 汇总它登记的 workspace，会话命中携明确 workspace/conversation locator，再用 scoped restore/nav；只读历史不占 runtime slot。

以下数值是 **建议初值，尚无 P32 压测校准**：

| 资源 | 建议预算与行为 |
| --- | --- |
| 存活聊天 Pi child | 默认 2；用户明确临时允许第 3 个；硬上限 3（starting/idle/stopping/cleanupPending 都计入），不因浏览会话列表 spawn |
| 在途 GUI Agent/CLI/model 工作 | 总预算 3，包含 Planner 生成/执行/验证，不排除后台；超过显示可执行的“停止或关闭一个执行线”提示，不自动驱逐活跃会话 |
| Browser view | 全局最多 3，owner 最多 1；lazy create、窗口最多挂载 1，隐藏 view 的 Chromium/页面内存仍计费 |
| Managed dev processes | 保留 P31 每 manager 8 个 active 的上界，再加全局 8 个（原单会话额度不缩减）；terminal records 原 manager 64 个上界保持；新增总预算集中检查，不按 focus 重置 |
| 消息/事件/日志 | SSE 原 800 条总 backlog 保持有界，建议每 runtime 至多 200 条；背景消息建议每活跃会话 1 MiB，超限标记 history-required；P31 每进程 64 KiB；所有累计预算和截断必须可见 |

每个 child 都可能另起 MCP/Extension 子进程；模型请求、token、dev server、Chromium 的成本不是一个 PID 的 RSS 能说明的。记录 backend、每 owned child/树、Browser、dev process 的可获得内存/CPU、活动请求与总峰值，未知值显示未知。正式初值是否需要收紧在 P32.3 的 2/3 会话 30 分钟真机压测后验收，不承诺具体 MB。

该默认 2、硬 3 的预算需要贯穿 chat/Planner/恢复/自动 crash restart/Browser/Process，不以打开 tab 数计费，不暗中降级成 B1 串行共享 child。无资源余量时历史查看与已运行 B 的 Stop 仍可用。

## 10. 分阶段交付与否决条件

| 子阶段 | 产品改动/拟涉及文件 | 必须交付 | 不准提前做 |
| --- | --- | --- | --- |
| P32.1 当前 | 本 ADR + 勘察报告 | 源码证据、A/B 比较、身份/资源/恢复合同、基线 test、已知限制；提交后等验收 | Worktree 生命周期/Runtime/UI 行为 |
| P32.2 | 新 worktrees/Git helper/fixture tests；projects/router 受控管理入口与必要风险确认 | create/list/open/archive/remove、健康/外部删除、无 destructive fallback；离线 fixture 与平台真 Git；before/after/branch | 同时 streaming、多 child registry、大规模侧栏设计 |
| P32.3 | runtime registry、rpc/router/sse scopes、Browser main/preload/host scopes、Process/Stop/审批/模型/维护归属、无监控 UI 的测试装配 | 完整 identity、并行独立与所有资源上界；真实 A/B coding 与 30 分钟压力证据；Windows/POSIX 能跑平台；重建产物 | P32.4 侧栏信息架构重做 |
| P32.4 | public 的 per-conversation store、focus/历史导航/搜索/菜单/right-pane、键盘与视觉 harness | P30 兼容与最小状态；三个分辨率/缩放/焦点实测；全部回归与 build | MOA/Tag Team、runtime 技术栈迁移、自动 stash/reset 或 sandbox 扩展 |

P32.3 必须有最小可用的 focus/发送/Stop 验证路径以验收真实并行；可以是窄范围测试 surface/现有交互适配，不能等 P32.4 才证明路由。P32.4 负责完成用户界面与发现路径，不成为 P32.3 核心正确性的依赖。每阶段独立提交，报告当前 HEAD 与验证证据，验收未过不进入下一阶段；本分支不自行 push、merge 或 Release。

### 验收矩阵（计划，不是本阶段已运行结果）

| # | 场景 | 阶段/测试层与可判定证据 |
| --- | --- | --- |
| 1 | 同 repo A/B worktree | P32.2 临时 repo 实 Git：porcelain/admin/common-dir、路径、branch 与 manifest 对拍 |
| 2 | A/B 同时真实 coding | P32.3 opt-in 真实 Pi/model、临时 repo，事件证明两条 owner run 重叠；记录模型/版本/任务，不只 fixture |
| 3 | 文件/Git 状态隔离 | A/B 写不同 marker，互相 git status/diff 无对方 marker，main HEAD/index/dirty 内容前后不变 |
| 4 | A streaming focus B/send | barrier 控制的 fixture + Electron live：B prompt 写 B stdin，A 流继续，UI 不混 |
| 5 | Stop A/B 不受影响 | fixture 与 live：只有 A clear_queue/abort/cancel，B 后续工具与输出继续；A 超时保持屏障 |
| 6 | Browser/Process 隔离 | A/B 同名工具/requestId、独立页面与端口、交叉 token/processId/ref 全拒绝，A Stop 不改 B 页面/服务；Electron + 实 dev server |
| 7 | A stale 迟到事件 | controllable callbacks/body/preflight/response/stop_state 在 A 重启、B focus、A→B→A 后到达，registry 和 DOM 均不串线 |
| 8 | app restart rediscovery | 保存 manifest/worktree/Pi session 后杀 backend/应用重开；无旧 PID 信任、无自动 spawn、历史可见，新 generation |
| 9 | 外部删除 worktree | os.tmpdir fixture 外部 Git/文件操作后 missing、取消 owner、拒绝启动/remove unknown，不退到 main |
| 10 | branch 冲突 | 同 branch 并发 create 只成功一次/合法拒绝；refs 不覆盖，保留部分失败证据 |
| 11 | path 占用 | 占位文件/目录、junction/symlink/traversal、慢请求竞态；占位内容 digest 不变 |
| 12 | dirty main | staged/unstaged/untracked/配置 marker digest 与 index 前后同一；提示源 commit 不含 dirty，零 stash/reset |
| 13 | dirty worktree remove | 各类 dirty/ignored/submodule/unmerged/locked/cleanupPending 分别拒绝；目录/branch/history digest 保留 |
| 14 | 非 Git repo | 明确错误/顺序恢复路径；无隐式 init、commit、spawn 回退 |
| 15 | Pi crash/restart 单会话 | A error/fresh generation/权限关闭/服务清理，B ready/流/审批/模型状态不变；EOF 和树清理真实验证 |
| 16 | 2–3 parallel ≥30 分钟 | P32.3 平台 opt-in：真实 coding/读写/Browser/Process/Stop/focus 循环；逐 owner 成败、资源样本/峰值、漏路由、退出后 owned 树归零；所有失败样本保留 |

默认 `npm test` 新增套件只用离线 deterministic fixture（假 Pi、fake clock/可控 barrier、隔离临时 Git）；真实模型/Electron/Vite/Python/平台树验证 opt-in。PID 存在、固定 sleep、时间戳接近、exit 0、截图有文字都不能代替 identity/状态断言。UI 另验 Tab/Shift+Tab、Escape/palette、project/session menu、搜索/折叠、hover/active/focus、缩放和 1280×800 / 1440×900 / 1920×1080。

## 11. 批准前仍未证明的边界

本 Spike 无并行实现、无新 worktree 试建、无真实模型请求、无 30 分钟压测；因此 child pool 内存收益、平台 Pi 树监督和多 Browser view 的 Electron 行为尚未得到运行证明。上述验收是下一阶段条件，不能把本阶段 baseline test 当成 P32 功能已通过。

需要验收的实质选择是 A+B3、focus/dispose 分离、全 workspace writer lease、per-runtime Browser/Process、默认 2/硬 3 的资源策略及 conservative archive/remove。若任一 ownership/树清理/路径安全证据不足，阶段应停在拒绝操作或只读历史，不能用共享 runtime、PID fallback、--force、自动 stash/reset 掩盖。第三方 Extension/MCP/global memory 的跨会话状态可能天然共享；只能标明未知/共享与安全投影，不能承诺未经审计的完全隔离。
