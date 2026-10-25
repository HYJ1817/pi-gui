# Z4-3 真实 Pi Agent 协同编辑链路 · 验收材料

状态：**开发与本地自动验证已完成；完整 canonical `npm test` 见第 7 节标注；独立审查未进行**。
本报告不表示代码验收通过、允许合并或允许发布（未 push、未提 PR、未合并、未发版）。
审查标准唯一见 [REVIEW.md](../REVIEW.md)；来源协议事实见
[Z4-3-agent-source-contract.md](Z4-3-agent-source-contract.md)；证据分层依 [acceptance.md](acceptance.md)。

## 1. 任务目标与交付范围

Z4-2 留下的唯一缺口：生产 `createCollabService` 没有注入可信 proposals source，
HTTP 不能登记自述为 Agent 的建议。本轮补齐这条真实链路：

- **阶段 A**：核对 pi 1.4.0 官方 RPC 协议与 dist 源码，产出来源契约文档。
- **阶段 B**：后端可信建议队列（`server/collab-proposal-queue.js`）与事件入口适配器
  （`server/collab-proposal-source.js`）：注册后不可变、规范化摘要绑定、proposalId
  复用拒绝、supersede、TTL/容量、来源伪装全部拒绝。
- **阶段 C**：`collab-service` 新增 `generate` / `proposal_status` 动作；
  `server.js` 装配真实来源——Classic 经 `rpc.request`（busy/stop/disposition 校验）、
  Runtime 经 `registry.command`（复用既有执行队列与停止屏障）；不新建第二个 Pi 进程。
- **阶段 D**：协同面板生成输入与「让 Agent 修改」按钮、`proposal_status` 轮询、
  建议卡片展示、接受走既有 CAS、冲突后重新生成入口。
- **阶段 E**：真实协议形状的 Electron 专项场景、离线产物重建、守卫夹具补齐。

**明确未做**：真实 Pi/模型 smoke（未获用户授权，见第 9 节）；自动接受建议；多用户
实时协作/CRDT；Z3 图表引擎与 Z4-2 数据协议改动；新依赖（零新增 npm 依赖）。

## 2. 基线、工作区与提交

- 基线 before HEAD：`67ed9e8c7e1eaf07c4221500b9da5528712a4b95`
  （`codex/z4-2-integration` 验收 HEAD，本地与 `origin/codex/z4-2-integration` 一致）。
  Z4-2 未合并 main（main 最新为 Z3-A `c9ac555`），故按任务书以 Z4-2 集成分支为基线。
- 分支 `codex/z4-3-agent-collaboration`，独立 worktree
  `C:\Users\21022\.codex\worktrees\z4-3-agent-collaboration\pi-GUI`；未触碰 Z4-2 原工作区。
- 最终行为提交：`446ad7e`（阶段 E）。含本报告的交付提交用
  `git log -1 --format=%H -- docs/Z4-3-acceptance.md` 解析。

| 提交 | 阶段 | 内容 |
| --- | --- | --- |
| `0024b9c` | A | 来源契约文档（协议证据、可信边界、集成位置） |
| `7bbe678` | B | 队列 + 来源适配器 + 30 项检查 |
| `4d20154` | C | authority scope 扩展、service generate/status、server.js 装配 |
| `dbb643d` | C 修复 | 队列 head 返回 rationale（此前读错层级） |
| `170e37a` | D | 面板生成入口、轮询、冲突重新生成；canvas 只读断言按新契约更新 |
| `446ad7e` | E | fake Pi 围栏分支、Electron 场景、锁序修复、产物重建、守卫夹具 |

## 3. 实际修改文件（`git diff --name-status 67ed9e8..HEAD`）

| 文件 | 变更 | 用途 |
| --- | --- | --- |
| `docs/Z4-3-agent-source-contract.md` | A | 阶段 A 契约：事件形状、可信边界、提取协议 |
| `server/collab-proposal-queue.js` | A | 可信建议队列（纯内存、有界、不可变、摘要绑定） |
| `server/collab-proposal-source.js` | A | 事件入口适配器：attempt 生命周期、围栏提取、注册 |
| `server/collab-service.js` | M | `generate`/`proposal_status` 动作、settle 集成、新错误码闭集 |
| `server/collab-authority.js` | M | scope 增加 `origin`/`conversationId`；错误码闭集扩展 |
| `server/collab-routes.js` | M | `beforeAuthority` 钩子（锁序修复，见第 8 节） |
| `server.js` | M | 来源装配、Classic/Runtime 通道、两个事件 tap、锁序修复 |
| `public/collab-panel.js` / `.css` | M | 生成输入、轮询、重新生成闭环、来源说明文案 |
| `public/collab-proposal.js` | M | 冲突/只读下保留重新生成入口（接受/拒绝仍按 Z4-2 禁用） |
| `package.json` | M | `test:collab` 链注册 4 个新套件 |
| `tests/collab-proposal-queue.cjs` 等 4 个 | A | 阶段 B/C/D 定向套件 |
| `tests/collab-canvas.cjs` | M | 只读建议断言按 Z4-3 契约更新（重新生成保持可用） |
| `tests/fixtures/candidate-pi.cjs` | M | fake Pi 增加 `PI_FAKE_COLLAB=1` 门控的真实协议围栏应答 |
| `tests/fixtures/z4-collab-electron.cjs` / `z4-collab-scenarios.cjs` | M | shim 启用围栏分支；场景文案更新 + 5 项新检查 |
| `tests/gui-browser-stop.cjs` / `stop-barrier.cjs` | M | VM 注入白名单补齐两个新构造器 |
| `docs/assets/z4-3/` | A | Electron 证据（results.json、截图） |

## 4. Pi 来源协议证据（摘要，全文见契约文档）

- 角色区分：`AgentMessage` role 闭集；只有 `role:"assistant"` 的 `message_end`
  （终值权威、`stopReason` 非 `pending`）进入提取；user/toolResult/custom/
  流式 `text_delta`/Z3 `pi-gui-viz` 围栏一律不采纳（1.4.0 `docs/json.md`、
  `docs/message-types.md`、`dist/core/agent-session.js:689/1887` 核对）。
- 运行归属：Classic 用 rpc-bridge 服务端盖的 `bridgeRun` + `agent_start` 窗口门控；
  Runtime 用 registry 帧 `owner` 闭集五字段匹配；`agent_settled{aborted:true}`、
  bridge 非 ready、`runtime_closed` 一律丢弃。
- 上游无模型最终消息的原生结构化输出通道（`outputSchema` 仅扩展工具层）→
  受限 `pi-gui-collab` 围栏协议：键闭集 `{version,rationale,ops}`、op 键闭集
  `{type,params}`（模型不可提供 opId/baseRevision/actor，由后端重编号/赋值）、
  围栏 64 KiB、ops 1..50、类型闭集，经 `lib/collab-doc.js` `createProposal` 复检。
- **来源可信 ≠ 内容可信**：schema/状态校验全部保留；HTTP 只引用后端 proposalId。

## 5. 已实现的交互流程

1. 用户在协同面板输入修改需求（≤2000 字符）→「让 Agent 修改」（仅用户显式触发）。
2. 服务端核对 owner/documentId/revision → 服务端组合 prompt（文档受控快照+指令+
   围栏契约）→ 经当前会话既有 Pi RPC 通道发送（Classic 校验 ready/非 streaming/
   非 stop-pending、disposition 必须为 `started`；Runtime 经 `registry.command`，
   `runtime_busy`/`stop_in_progress` 拒绝照常生效）。
3. 后端事件 tap 采集本次运行窗口内的 assistant 终值消息 → `agent_settled` 收口 →
   提取围栏 → 严格校验 → `createProposal` → 队列注册（supersede 旧 pending）。
4. 面板轮询 `proposal_status` → ready 后自动 `preview` → 展示修改说明与逐条差异
   （预览不改变文档）。
5. 接受：后端再次核对 owner（scope token）、proposalId+摘要、expectedRevision，
   复用 Z4-2 CAS 提交与撤销历史；拒绝：仅状态变化，文档不变；重复接受 duplicate、
   重复拒绝幂等。
6. 冲突（生成期间用户编辑或外部推进 revision）：接受/预览返回 `collab_conflict`，
   文档保留，卡片「重新生成」保持可用 → 点击后按最新 revision 重开编辑器并**发起新
   受控任务**（不重放旧操作）。
7. 生命周期：会话/工作区切换同步停轮失效；停止 Agent（abort）→ `agent_settled
   {aborted:true}` → 丢弃；后端重启队列清空（纯内存）；旧 scope token 的建议对新
   owner 不可见。

## 6. Classic / Runtime 验证状态

- **Classic**：单元（source 套件 20 项）、service 集成（flow 套件 10 项）、HTTP
  真实 Router（7 项）、Electron 真实组合根端到端（生成→预览→接受→撤销，fake Pi
  以真实事件形状应答）全部通过。
- **Runtime**：source 套件 runtime 帧归属/`runtime_closed` 7 项、flow 套件 Runtime
  scope 端到端 1 项通过；Z4-2 Electron 既有 Runtime/项目隔离场景全部保持通过。
  Runtime 通道经 `registry.command` 复用执行队列的装配在源码层验证
  （`server.js` runtime sendPrompt），但没有独立的 Runtime 生成 Electron 端到端场景
  （Z4-2 场景验证的是 Runtime 的用户编辑与隔离）——见第 10 节未验证项。

## 7. 测试命令、退出码与实测数量

环境：Windows 11、Node v24.22.1、Electron 44.4.3（`ELECTRON_OVERRIDE_DIST_PATH`
指向本机离线解压的 44.4.3 dist——本机共享 `node_modules/electron/dist` 在本轮
启动即崩溃（0x80000003，基线复测同样失败，与本轮改动无关）；`node_modules` 为指向
主工作区的目录联接（只读使用，未修改）。写入类测试一律 `os.tmpdir()`。

### 7.1 定向套件（本轮全部实际运行，退出码 0）

| 套件 | 检查项 | 断言调用 | 说明 |
| --- | --- | --- | --- |
| `node tests/collab-proposal-queue.cjs` | 10/10 | 53 | 不可变/摘要/ID 复用/supersede/TTL/容量/淘汰 |
| `node tests/collab-proposal-source.cjs` | 20/20 | 119 | 真实协议形状：伪装来源、窗口归属、取消/超时、重编号 |
| `node tests/collab-agent-flow.cjs` | 10/10 | 62 | service+source+真实存储全链路、冲突、隔离、保存失败 |
| `node tests/collab-panel-agent.cjs` | 8/8 | 87 | jsdom 面板闭环：发起/轮询/接受/失败/冲突重新生成/生命周期 |
| `node tests/collab-doc.cjs` | 56/56 | 135 | Z4-2 基线保持 |
| `node tests/collab-store.cjs` | 53/53 | 149 / skip 1 | Z4-2 基线保持 |
| `node tests/collab-authority.cjs` | 24/24 | 68 | scope 扩展后基线保持 |
| `node tests/collab-service.cjs` | 13/13 | 58 | generate/status 动作加入后基线保持 |
| `node tests/collab-http.cjs` | 7/7 | 28 | beforeAuthority 钩子加入后基线保持 |
| `node tests/collab-canvas.cjs` | 72/72 | 72 | 一项只读断言按 Z4-3 契约更新（数量不变） |
| `node tests/collab-panel.cjs` | 11/11 | 58 | 面板重构后 Z4-2 基线保持 |
| `node tests/gui-browser-stop.cjs` | 12/12 cases | 12 | VM 注入补齐后通过 |
| `node tests/stop-barrier.cjs` | 17/17 cases | 17 | 同上 |
| `node tests/modules.cjs` | 120/120 | — | 依赖方向守卫（含 lib/collab-doc 纯度） |
| `node tests/smoke.cjs` | 1338/1338 | — | 无断言删除 |
| `node prototype/z4-1-collab/collab-test.mjs` | 49/49 | — | 原型基线保持 |

### 7.2 正常沙箱 Electron 专项（真实协议形状端到端）

`ELECTRON_OVERRIDE_DIST_PATH=<离线 44.4.3 dist> Z4_COLLAB_OUTPUT=%TEMP%\pi-gui-z43-electron-run6 node tests/collab-electron.cjs`
→ 退出码 0；**53/53**（52 项业务检查 + 1 项进程清理），残留进程 0/9。新增检查：
来源契约文案、建议卡片（rationale+差异条目）、预览不改持久化文档、接受经 CAS 应用
且可撤销、建议撤销。Z4-2 全部既有场景（含 Runtime/项目隔离、100 节点、原生 Browser
遮挡、离线守卫拦截外部更新）保持通过。证据：[electron-results.json](assets/z4-3/electron-results.json)。

### 7.3 打包产物（离线重建后）

`PI_GUI_ELECTRON_ZIP_DIR=<本机 44.4.3 zip 目录> npm run build:app -- --rebuild` → 退出码 0
（零网络下载）；`node tests/app-check.cjs` 26/26；`node tests/exe-check.cjs` 49/49；
`npm run test:collab:packaged` 28/28。

### 7.4 完整 canonical `npm test`

**状态：第 1 次完整运行 207/208 叶通过，唯一失败叶为预存环境敏感项（与本轮改动无关，
证据链见下）；已按修正后的会话环境重跑，结果见下方回填。**

- 第 1 次运行（本会话 shell 环境）：`npm test`，日志
  `%TEMP%/z43-canonical.log`，退出码 1。除最后一叶外全部通过（含本轮 4 个新套件：
  proposal-queue、proposal-source、agent-flow、panel-agent 均在该运行内通过）。
  唯一失败：`tests/session-revert-object-assets.cjs` 22/23（检查
  `real observer refuses relative SystemRoot without PATH fallback`）。
- **环境根因（已定位，非产品缺陷、非本轮引入）**：该检查以
  `{...process.env, SystemRoot:'.', PATH:<project>}` 启动子进程，依赖
  `SystemRoot` 键被覆盖为相对路径后 `resolveObjectInterpreter` 拒绝。本会话
  shell（ZCode Git Bash）导出的环境键为**大写 `SYSTEMROOT`**，与字面量
  `SystemRoot:'.'` 并存 → Windows 环境块大小写不敏感合并后子进程收到真实
  `C:\WINDOWS` → 观察成功 → 断言失败。实测证据：`{SystemRoot:'.'}`（无展开）子进程
  见 `.`；`{...process.env, SystemRoot:'.'}` 子进程见 `C:\WINDOWS`；
  `{...process.env, SYSTEMROOT:'.'}` 子进程见 `.`。删除该键则 Node 启动即崩
  （CSPRNG 断言），属既有的测试环境脆弱性（AGENTS.md §七同类）。
- 基线对照：同一套件在 `67ed9e8`（Z4-2 验收 HEAD，本轮改动 stash）下同样
  22/23 失败；在 Z4-2 集成 worktree 中运行同样失败。该套件文件自 `8dfe71a`
  起未被任何本轮提交修改。Z4-2 验收台账（208/208，failure:null）运行于标准
  大小写环境，故当时通过。
- 处置：不改产品、不改该套件（超出本轮范围），以只修正 `SystemRoot` 键大小写的
  启动器（`env.SystemRoot='C:\WINDOWS'`，删除大写重复键）重跑完整 canonical。

**第 2 次运行（修正环境，最终有效证明）：通过。**

- 命令：`node <launcher> npm test`（launcher 仅做两件事：经 `cmd.exe /d /s /c npm test`
  启动——Node 24 拒绝直接 spawn `.cmd`；环境删除大写 `SYSTEMROOT` 重复键并设
  `SystemRoot='C:\WINDOWS'` 标准大小写。不改变任何测试输入）。
- 工作区：`446ad7e` + 待提交文档 diff（仅文档与注释，无行为差异）。
- 日志：`%TEMP%/z43-canonical-run3.log`；退出码 **0**；耗时 70m34s
  （2026-10-25 23:15:30 → 2026-10-26 00:26:04，上海时间）。
- 结果：完整 canonical 全部通过，包括第 1 次失败的 `Object assets: 23/23; failed=0;
  skipped=0`——证实该失败纯属会话环境变量大小写，与代码无关。本轮 4 个新套件在
  该运行内的记录：proposal-queue / proposal-source / agent-flow 汇总行与定向一致
  （10/10+20/20+10/10）；`Collab panel agent: 8/8; assertions=88`（定向运行为 87——
  fetch mock 每次调用计一次断言，轮询次数随时序 +1，检查数固定 8/8，skip 0）。
- 链尾 `Object witness: 0/0; failed=0; skipped=8`（`existing_token_sacl_unavailable`），
  与 Z4-2 验收记录相同的既有平台 skip，不计入分母、不冒充通过。
- 注意：本次完整证明为本机标准大小写环境下的一次性运行；该套件在「大写 SYSTEMROOT
  的 shell」这一环境形态下的脆弱性已如实记录，属既有测试基建问题，本轮不修。

## 8. 首次失败与修复历史

1. 队列 `fail` 帮助函数未 `throw`（两次红测暴露）→ 修复。
2. 容量淘汰把 `rejected` 视为不可淘汰 → 容量耗尽红测 → 改为优先级淘汰。
3. `head` 读错层级导致 rationale 缺失 → flow 套件红测 → `dbb643d`。
4. **锁序自锁（重要）**：Classic 生成通道在 collab authority 持有
   `worktrees.withWorkspace`（生命周期锁）期间调用 `sessionChanges.assertReady()`
   → 其内部 `withActivation` 是同一把 `serialize` 锁 → 生成请求永久挂起
   （Electron run4 诊断 `status:"正在保存…"` 复现）。修复：`collab-routes` 新增
   `beforeAuthority` 钩子，capture 就绪检查移到取锁之前；classic 通道不再嵌套
   `withActivation`。Runtime 通道经核实无锁冲突（project 工作区走 ordinarySessions，
   无互斥）。
5. fake Pi 围栏分支两处夹具错误（真实换行、围栏缺 `pi-gui-collab` 标记）→ 修正后
   Electron 端到端通过。
6. `gui-browser-stop`/`stop-barrier` VM 白名单缺新构造器（ReferenceError）→ 补齐。

## 9. 真实 Pi 测试

**未执行**（未获得用户授权的真实 Pi 会话测试环境）。Electron 端到端使用 fake Pi 以
pi 1.4.0 官方文档核对过的真实事件形状（`agent_start`/`message_end` 终值/
`agent_settled{aborted}`）应答，这不构成真实模型验证；真实模型是否稳定遵守围栏
契约无法离线证明（不遵守时表现为「生成失败」，fail-closed）。

## 10. 未验证项与残余风险

- **独立审查未进行**：按 REVIEW.md 本轮属高风险变更（事件入口、执行权限、队列），
  需独立功能与安全审查 + 用户审批。完整 canonical 已通过（第 7.4 节第 2 次运行）。
- Runtime 通道的生成链路没有独立 Electron 端到端场景（服务层已覆盖）。
- 围栏协议依赖模型遵守输出格式；多次失败会表现为「生成失败」而非错误建议
  （fail-closed，但可能影响可用性）。
- 队列/attempt 为进程内存态：后端重启即清空（规格如此，已测试）；attempt TTL 10 分钟、
  队列容量 32、pending 30 分钟。
- 经 shell 启动平台的老边界不变：`agent_settled` 缺失时 attempt 以 TTL 兜底失败。
- 共享 Electron dist 在本机当前损坏（基线同样失败）；本轮证据全部来自同版本离线
  解压 dist，不声明其他环境已验证。

## 11. 回滚方法

分支未合并、未推送：主工作区与安装版完全未受影响。若需撤销本分支：在确认工作区
干净后 `git worktree remove` 该 worktree 并删除 `codex/z4-3-agent-collaboration`
分支即可；Z4-2 基线 `67ed9e8` 原样保留。已重建的产物只存在于本 worktree 的
`dist-app/`，不影响任何安装版。协同文档数据目录 `collab-documents/` 不需要回滚
（本轮未改变其格式；Z4-2 的备份/恢复策略继续适用）。

## 12. 交付结论区分

| 结论 | 状态 |
| --- | --- |
| 开发完成 | **是**（六个阶段提交齐全，交付范围见第 1 节） |
| 代码验收通过 | **未定**——待独立功能/安全审查 + 用户审批（未进行） |
| 允许合并 | **未授权**（未 push、未 PR、未合并） |
| 允许发布 | **未授权**（未打 tag、未发版） |
