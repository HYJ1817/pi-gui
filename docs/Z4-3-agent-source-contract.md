# Z4-3 阶段 A：真实 Pi Agent 建议来源契约

基线：`codex/z4-2-integration` @ `67ed9e8c7e1eaf07c4221500b9da5528712a4b95`。
本文只记录**已核实的上游协议事实与集成设计**，不声称任何生产链路已通过验证。
上游证据来自本机安装的 pi `@earendil-works/pi-coding-agent@1.4.0` 官方文档
（`docs/rpc.md`、`docs/json.md`、`docs/message-types.md`、`docs/rpc-commands.md`、
`docs/extensions.md`）与 `dist/` 源码（只读核对，未修改 pi 本体）。

## 1. 结论

- Pi RPC **没有**面向「模型最终消息」的原生结构化输出通道。`outputSchema`/
  `structuredContent` 只是扩展工具层的约定（工具返回值），不能强制模型的
  assistant 文本成为受控 JSON（[extensions.md](Z4-2-agent-source-research.md) 与
  1.4.0 `docs/extensions.md` 核对）。
- 因此采用**受限的最终 assistant 消息提取规则**：只在后端已验证的事件入口，
  从本次运行的**完整** assistant 消息里提取最后一处 `pi-gui-collab` 围栏，
  经严格 schema 校验后进入后端队列。消息正文、工具输出、用户消息、Z3 围栏
  一律不构成建议。
- 运行归属不依赖模型自述：Classic 用 rpc-bridge 服务端盖的 `bridgeRun` +
  `primaryOwner()`；Runtime 用 registry 服务端封装的 `owner` 闭集（九字段）+
  `eventSequence` + generation。模型输出里的任何 `actor`/`sessionId`/
  `bridgeRun` 字段都不取得权限。

## 2. 实际事件形状（已核对）

RPC stdout 每行一个 JSON 记录。pi-gui 的 `server/rpc-bridge.js` 按 LF 切分后，
把每条事件加盖服务端 `bridgeRun` 与 `cwd` 再 publish（rpc-bridge.js:475）。
以下形状来自官方 json.md/message-types.md 并与 1.4.0 `dist/core/agent-session.js`、
`dist/modes/rpc/rpc-mode.js`、`dist/modes/json-event.js` 核对一致：

| 记录 | 形状（关键字段） | 语义 |
| --- | --- | --- |
| `agent_start` | `{type:"agent_start"}` | 一次底层 agent run 开始 |
| `message_start` | `{type, message}` | 消息开始；assistant 的 `stopReason:"pending"` |
| `message_update` | `{type, usage, assistantMessageEvent:{type:"text_delta",contentIndex,delta}}` | 流式增量；`partial` 已被上游裁掉，**不可作为终值** |
| `message_end` | `{type, message}` | 一条消息完成；`message` 为权威终值，assistant 的 `stopReason` 为终值（`stop/length/toolUse/error/aborted/deferred`，不再是 `pending`）。user/custom/toolResult 等角色也会发 `message_end`，**必须按 `role` 过滤**（agent-session.js:1887 对 custom 消息同样发 `message_end`） |
| `turn_end` | `{type, message, toolResults}` | 一次 assistant 响应及其工具调用结束 |
| `agent_end` | `{type, messages, willRetry}` | 一次底层 run 结束；自动重试/压缩恢复可能继续 |
| `agent_settled` | `{type, aborted}` | **会话级 run 结束的权威收口**；重试、排队消息全部结束后才发。`aborted:true` 表示本次 run 因中止而结束（agent-session.js:689-690） |
| `response` | `{id, type:"response", command, success, data}` | 命令应答；`prompt` 的 `data.disposition ∈ {started,queued,handled}`（rpc-mode.js:307-309、agent-session.js:1644-1693） |
| `compaction_start/end` | `{type, reason, result?}` | 压缩事件；不结束会话级 run |
| `auto_retry_start/end` | `{type, attempt, ...}` | 自动重试；`agent_settled` 之前发生 |
| `bridge_status` | `{type, state, bridgeRun, cwd, ...}` | rpc-bridge 生命周期（pi-gui 自有事件） |

消息角色闭集（message-types.md）：`system / user / assistant / toolResult /
bashExecution / custom / branchSummary / compactionSummary`。
assistant `content` 为 `(TextContent | ThinkingContent | ToolCall)[]`；
文本建议只能来自 `type:"text"` 块的 `text` 字段。

## 3. 运行归属绑定（服务端事实，非模型自述）

### Classic（主聊天）

- 事件来源：`server.js` 组合根 rpc `publish` 回调（server.js:378 起），此处能拿到
  原始事件（含 `bridgeRun`，由 rpc-bridge 服务端赋值）。
- Owner 形状：`primaryOwner()`（server.js:944-950）=
  `{backendInstance, projectId, repoId:null, workspaceId, workspaceEpoch, conversationId:"classic-chat", runtimeId:bridgeInstance, runtimeGeneration:String(bridgeRun), sessionId:primaryNativeSession}`。
  全部由后端闭包/状态派生。
- 归属判定：采集窗口开始前捕获 `rpc.getState().bridgeRun`；事件 `bridgeRun`
  必须相等；`bridge_status` 进入 `starting/restarting/exited/error/no-project/maintenance`
  即作废窗口；`agent_settled` 收口。

### Runtime（并行会话）

- 事件来源：`createRuntimeRegistry` 的 `publish`（server.js:917），帧形状
  `{type:"runtime_event", owner, eventSequence, event}`；owner 为九字段闭集
  （runtime-registry.js:5、63-64），由服务端持有并逐项核验（resolve）。
- 有效性：registry 只对 `belongs(live)` 的当前代发布帧（runtime-registry.js:129-137：
  旧 `bridgeRun` 帧丢弃；run 增长会更新 generation 并 settle 资源）；
  session-runtime 的 publish 还有 `disposed/context.isCurrent()` 前置检查
  （session-runtime.js:86-97）。
- 归属判定：attempt 捕获 `{backendInstance, conversationId, runtimeId, runtimeGeneration, sessionId}`；
  帧的 `owner` 五项必须全部相等；`runtime_closed` 帧或 owner 代次变化即作废。

### 中断、取消、重试、压缩语义

| 场景 | 行为 |
| --- | --- |
| 用户 Stop（abort） | abort 权威应答后 `agent_settled{aborted:true}` → **丢弃**采集窗口，不产出建议 |
| 自动重试 / 压缩恢复 | 都发生在 `agent_settled` 之前 → 窗口继续，最终以 settled 时的最后 assistant 消息为准 |
| 压缩（手动/阈值/溢出） | 中途事件，不影响窗口；若压缩导致本次 run 失败则没有 settled 的产出 |
| bridge 重启 / 维护 / 切项目 | `bridge_status` 非 ready → 作废窗口 |
| Runtime close / 代次变化 | `runtime_closed` / owner 代次变化 → 作废窗口 |
| prompt 被 extension 消费 | `disposition:"handled"` → 没有本次 run，视为发起失败（不进入等待） |

## 4. 受限提取协议（模型输出 → 建议）

上游无结构化输出通道（第 1 节），因此定义**显式围栏协议**：

1. 后端组合 prompt（服务端完成，Renderer 只传用户需求文本）：包含文档当前
   结构化表示（节点/连线/revision，来自 `store.read` 的受控快照）、用户指令、
   以及严格的输出格式要求。
2. 要求模型在**最终回复的末尾**输出且仅输出一个 ` ```pi-gui-collab ` 围栏，
   内容为 JSON：`{"version":1,"rationale":"修改说明","ops":[{"type":"node.add","params":{...}}]}`。
3. 后端提取规则（全部满足才解析）：
   - 只看本次运行窗口内、`role:"assistant"`、`message_end` 完成且 `stopReason`
     为终值的消息；
   - 从**最后一条**含围栏的 assistant 消息中取**最后一处** `pi-gui-collab`
     围栏；围栏字节上限（默认 64 KiB）；
   - JSON 严格解析：顶层键闭集 `{version,rationale,ops}`，`version===1`，
     `rationale` 为 ≤2000 字符字符串，`ops` 为 1..50 条；
   - 每条 op 键闭集 `{type,params}`（**不接受**模型提供的 `opId`/`baseRevision`/
     `actor`/`sessionId` —— 全部由后端赋值或核对）；
   - `type` 必须在 `lib/collab-doc.js` 的 `OP_TYPES` 闭集内，`params` 经
     `validateOperationSchema` 等价校验（经 `createProposal` 复检）；
   - 任何一步失败 → 本次生成失败，**不产出任何建议**（fail-closed，无部分采纳）。
4. 后端构造建议：`createProposal({documentId, baseRevision: 发起时 revision,
   sessionId: scope.sessionId, ops: 后端重编号的 ops, rationale})`——proposalId
   由后端生成；opId 由后端按 attempt 重编号（模型不可选择身份键，避免与文档
   幂等日志的 opId 复用语义交互）。

**被明确排除的来源**：用户消息、toolResult/bashExecution 内容、`custom` 消息、
流式 `text_delta` 片段、Z3 的 `pi-gui-viz` 围栏、任意 Markdown、聊天 DOM、
Renderer 回传的任何 payload。

## 5. 可信边界

- **来源可信 ≠ 内容可信。** 事件入口证明「这是本次已验证运行里模型说的」，
  不证明内容安全。因此内容一律经过第 4 节严格 schema + `lib/collab-doc.js`
  闭集操作校验；文档状态合法性（引用存在、上限、重复）在 preview/accept 时按
  Z4-2 既有语义全批校验。
- 后端确认了消息来源，**不代表**可跳过校验；伪造围栏的文本只会产生「建议被
  拒绝/生成失败」，不会绕过队列。
- HTTP 永远只引用后端 `proposalId`；不接受客户端上传完整建议并登记为可信。
- 注册后建议内容不可变（深冻结 + 规范化摘要绑定）；预览与接受引用同一份
  摘要核验过的建议。

## 6. 集成位置（设计，随阶段 B/C 落地）

| 位置 | 职责 |
| --- | --- |
| `server/collab-proposal-queue.js`（新） | 纯后端有界队列：proposalId 唯一性、规范化摘要、不可变注册、supersede、TTL/容量、scope 失效丢弃；无 IO、无网络 |
| `server/collab-proposal-source.js`（新） | 事件入口适配器：Classic/Runtime 两个 `observe*` tap、attempt 生命周期（armed→running→settled/failed/abandoned）、围栏提取、经 `lib/collab-doc.js` 校验后注册队列 |
| `server/collab-service.js`（改） | 新增 `generate` / `proposal_status` 动作；`proposals` 参数从「仅 fixture 接口」升级为真实 source；错误码闭集扩展 |
| `server/collab-authority.js`（改） | scope 增加服务端派生的 `origin`（classic/runtime）与 `conversationId`（Runtime 时为已验证的会话 id，Classic 为 null），供组合根选择生成通道 |
| `server.js`（改） | 两个事件 tap（rpc publish 顶部、registry publish）；生成通道注入（Classic：`rpc.request get_state/prompt`；Runtime：`registry.command(owner,{type:'prompt'})`——完全复用既有执行队列、停止屏障与 `runtime_busy` 拒绝，不新建第二个 Pi 进程） |
| `public/collab-panel.js`（改，阶段 D） | 发起生成、轮询 `proposal_status`、展示建议；不新增 HTTP 语义 |

生成触发只来自用户显式动作（协同面板按钮）→ `POST /api/collab-documents`
`action:"generate"`（走完整 Origin+Token+collab authority 取证）→ 后端先核对
owner/documentId/revision 再武装采集窗口、再向当前 Pi 发 prompt。

## 7. 无法证明的条件

- 真实模型是否稳定遵守围栏格式：无法离线证明；不遵守即「生成失败」，属产品
  行为而非安全问题。真实 Pi 会话 smoke 需用户授权的测试环境，结果单独标记。
- provider 级 JSON mode / tool-choice 强制：本版本 pi 未提供；未来版本若提供，
  需重新评估而不是继续围栏。
- 模型输出的语义正确性（建议是否「好」）：不在可信边界内，由用户预览决定。
- 本契约的事件形状以 pi 1.4.0 为准；上游升级需按本文第 2 节重新核对。
