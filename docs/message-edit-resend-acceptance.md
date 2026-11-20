# 历史用户消息编辑 / 重新发送与重新生成：验收记录

- 分支：`feat/message-edit-resend`
- 基线：`66586aa0`（`main`，Merge PR #97，2026-11-20）；上一轮功能验收在 `ff19178`
- 本轮：`ff19178` 之上的合并前安全修复（事务互斥、RPC 结果未知恢复、原目标身份锁定）
- 应用版本：0.34.0（未改正式版本号）
- 验证环境：Windows 11 10.0.26200，Node v24.22.1，Electron 44.4.3，Pi 1.5.2
- 范围：Classic 会话与**活动中的** Runtime 会话的历史用户消息编辑 / 重新发送，以及同一机制的「重新生成」
- 不在范围：dormant Runtime 历史只读视图；新会话 / 分叉模拟；文件、git、终端的自动回滚；Pi 本体或会话 JSONL 改写

## 1. 结论

本轮在原会话内实现了历史用户消息编辑、重新发送与重新生成。实现使用 Pi 的公开树导航
`ExtensionCommandContext.navigateTree(targetId, { summarize: false })` 把活动 leaf 移到目标用户
消息之前，再通过普通 RPC `prompt` 在同一原生会话里开始新一轮 Agent run。没有创建新会话、
没有 fork、没有改写 Pi 的 JSONL，也没有修改 Pi。

真实 Pi 1.5.2 与真实 Electron 验收均通过：编辑前后 `sessionId`、会话文件、侧栏条目数量不变；
旧分支仍留在 append-only 文件中，但不在活动路径与模型上下文里；重启后从 Pi 原生活动路径恢复。

第二轮（合并前安全修复）补上了三个 P1 缺陷：编辑事务只阻止 prompt 而没有阻止会改变历史、
owner 或 bridge 代次的命令；RPC 超时被当成「没有发生」；提交时按 `userIndex` 重新解析目标而
不是核对首次预检锁定的身份。修复后真实 Pi 故障注入（导航 / prompt 已执行、应答被丢弃）与
Electron 验收均通过，详见第 5A–6B 节与第 11 节。

第三轮（合并前复审）：Runtime 重复提交**已完成**事务时，服务端返回缓存的成功结果
（`duplicate:true`）且不会启动新 Agent；Registry 原先仍会为这次调用重新占用 `editTurn`，
而没有 `agent_start` / `settled` 来释放，导致该 Runtime 永久 `runtime_busy`（prompt、close、
restart 全被拒）。现在缓存结果当场释放执行锁，同一 requestId 可安全重试。

## 1A. 第二轮三个 P1 的根因

1. **事务互斥不完整**：第一轮只在 `/api/command` 与 Runtime `command` 入口拦截了
   `prompt` / `steer` / `follow_up`。`new_session`、`switch_session`、`fork`、`compact`、
   `set_session_name`、`set_model`、Runtime 的 `close` / `restart`、`/api/restart`、配置保存
   触发的 Pi 重启、会话切换 / 归档 / 删除都不在锁内。导航成功后若这些入口之一执行，事务的
   RPC 通道、owner 或目标历史就会被换掉，事务既无法提交也无法回滚。
2. **超时被当成「未发生」**：导航与 prompt 都只按 `ok/!ok` 分支。`rpc.request()` 超时返回
   `null`、bridge 换代返回 `stale_runtime`、恢复命令自身超时，都会走普通失败分支并释放事务
   锁；但 Pi 可能已经完成导航或接受 prompt。结果是「明明已经回滚到旧路径却报告未发送」，
   或「prompt 已被接受却又恢复旧路径」。
3. **提交时目标身份被替换**：编辑器打开后，提交只按 `userIndex` 重新预检并直接采用最新的
   `entryId` / `leafId`。导航、压缩或其它会话变化后，同一个 `userIndex` 可能指向另一条消息，
   于是「编辑 A」实际提交成了「编辑 B」。后端也没有把 `expectedEntryId` / `expectedLeafId`
   作为正式提交的必填契约。

### 1B. 独立自审补充发现的缺陷（同轮修复）

1. **guard + 回读失败无法收敛**：导航前追加 guard 后，如果导航应答丢失且紧接着的
   `get_entries` 回读也失败，`inspectNavigation` 会在认领 guard 之前返回 unknown，事务进入
   `recovery_pending`。后续 `reconcile` 虽然能读到 entries，却没有补认 guard，`guardId`
   永远为 null，`restoreAfterFailure` 返回 `restore_unavailable`，恢复入口反复失败并永久
   持有锁。修复：`reconcile` 在拿到 entries 后先补认 guard，再判断 leaf。
2. **collab 生成绕过编辑锁**：Classic 的 collab `sendPrompt` 直接调用
   `rpc.request({type:'prompt'})`，不经过 `/api/command` 的 `blocksCommand` 闸门，可以在
   导航与重发之间插入一条 prompt，或把重发挤成 `queued`。修复：在写 stdin 前后各核对一次
   编辑锁。
3. **status GET 没带 owner 头**：`messageEditStatus` 用 `getJSON`，不会像 `sendJSON` 那样
   注入 `X-Pi-Gui-Owner`；路由要求逐字段 owner 核对，于是真实渲染器在断线后查询 status
   永远得到 409，被误判为「未确认」。修复：status GET 显式携带当前 owner。
4. **requestId 活不过渲染器刷新**：未解决事务的 requestId 只存在内存里，刷新后无法再查询，
   服务端锁却仍然存在，形成用户不可解除的忙状态。修复：提交前把 requestId / 文本 / 作用域
   写入 `sessionStorage`，刷新后按原 requestId 查询；accepted / failed 清记录，未解决时在
   重新打开编辑器或启动恢复时提供「重新同步」。后端换代时清除本地记录，不伪造结果。
5. **Classic 预检在锁存在时仍报可编辑**：`preflight` 不检查 `sessionLocks`，Classic 的
   `busyReason` 也不含编辑锁，于是刷新后重新打开编辑器会拿到 `ok:true, canEdit:true`；
   成功预检还会清掉同会话的持久化记录，随后提交才被 `resend` 拒绝，恢复入口已经丢失。
   Runtime 的真实形状是 `ok:true, canEdit:false, reason:'edit_in_progress'`，而 UI 测试
   只 mock 了 `ok:false, code:'edit_in_progress'`，两种真实形状都没有覆盖。修复：服务
   `preflight` 在 `sessionLocks` 命中时返回 `edit_in_progress`；渲染器用
   `isEditInProgress()` 统一识别两种形状，并在提交撞锁时接回已有记录。
6. **sessionStorage 只有一个槽**：Classic 与多个独立 Runtime 会话同时各有一个未解决事务
   时，后写入的记录会覆盖前一个会话唯一的恢复句柄。修复：按作用域存储一个小数组，同会话
   替换、跨会话保留；读取、resume、清除都带作用域。
7. **bridge ready 早于会话身份**：`resumeClassicPendingEdit` 在 `S.legacyOwner.sessionId`
   为空时直接返回，之后身份到达也不会重试。修复：`legacyOwner` 的 sessionId 变化时补一次
   resume。
8. **guard 被外部删除后恢复入口死循环**：导航已执行、guard 在回读中消失（例如会话文件被
   其它进程改写/压缩）时，`restoreAfterFailure` 永远返回 `restore_unavailable`，事务停在
   `recovery_pending`。修复：显式 recover 且 guard 缺失时收口为 `recovery_required` 并释放
   锁，提示用户刷新检查历史。

## 2. PI-Desktop 调用链对照

参考实现（本地固定副本 `PI-Desktop-ref`）的链路：

1. `apps/desktop/src/stores/slices/transcript-slice.ts` 的 `editUserMessage(messageId, content, attachments)`：
   校验会话未运行、无 pending plan，按 `messageId` 找到 `userIndex`，把消息列表裁剪为
   `kept = messages.slice(0, userIndex)`，插入一条乐观用户消息，然后调用
   `api.prompt({ sessionId, content, messageId, attachments, truncateFromMessageId })`。
2. `apps/desktop/electron/main/ipc/agent-ipc.ts` 的 `agentPrompt`：取消该会话工具、abort 残留
   turn、flush 持久化 outbox，调用 Host 的 `session.truncateFrom`（Host 自己持有的 transcript
   存储），然后 `agent.disposeSession`、重新读取 session，再 `session.beginTurn` 并让 sidecar
   发送 prompt。
3. 重新生成走同一个 `truncateFromMessageId` 字段，但只裁剪、不插入新的用户消息，正文复用目标
   用户消息原文。

pi-GUI 有意不照搬第 2 步的 **Host transcript 截断 + sidecar 重启**：

- 本仓库的硬约束是只通过 `pi --mode rpc` 使用外部程序，不碰 Pi 本体、不改写会话 schema/JSONL。
- Pi 1.5.2 已公开 `navigateTree`，其语义正好是「把 leaf 移到目标之前」；用户消息与
  `custom_message` 会落到 `target.parentId`，其余条目落到 `targetId`。
- 因此 pi-GUI 用一次内部扩展命令完成导航，再发普通 `prompt`；身份、文件与原生树由 Pi 自己
  维护，pi-GUI 只持有稳定目标 ID 与事务状态。
- 差异是有意的：PI-Desktop 由 Host 重写自己的 transcript；pi-GUI 只追加 Pi 原生条目。

## 3. 采用的 Pi 原生能力

- `get_entries` → `{ entries, leafId }`：后端用 `id`/`parentId` 还原活动路径，得到目标用户
  条目的稳定 `entryId`、`parentId` 与当前 `leafId`。
- `get_messages`：同一套投影生成可见用户消息的 `userIndex`、文本、图片与 `hasToolsAfter`；
  与 `session-edit-target.js` 的 `contextEntries` 规则一致（含 compaction、`branch_summary`、
  `context_edit`）。
- 扩展命令：每次启动生成随机命令名 `pi-gui-edit-<12 hex>` 与随机 token，通过 `--extension`
  与 `PI_GUI_EDIT_COMMAND` / `PI_GUI_EDIT_TOKEN` 注入 `extensions/pi-gui-edit`；命令处理器只
  接受 `<targetId> <leaf> <parent> <session> <requestId> <token>`，校验 token、会话身份、
  当前 leaf、目标节点与父节点、空闲状态后调用公开 `navigateTree`。命令不存在或 token 不符
  时能力判定为 `navigate_unavailable` 并失败关闭。
- `prompt`：导航成功后发送编辑文本与原始图片；Pi 在目标父节点下追加新的用户条目，正常开始
  Agent run，工具权限与审批仍走既有流程。
- 回滚 guard：若导航前旧 leaf 是用户消息或 `custom_message`，扩展先 `appendEntry` 一个
  `pi-gui-edit-guard` 自定义条目，使旧 leaf 可被精确恢复；guard 不进入模型上下文。

## 4. 身份契约

一次事务绑定并核对：

| 字段 | 来源 | 作用 |
| --- | --- | --- |
| `nativeSessionId` | `get_state.sessionId` | 拒绝跨会话 requestId / 结果读取 |
| 原生会话文件 | `get_state.sessionFile` | 身份不变；真实 Pi 测试断言文件数不增 |
| `conversationId` | Runtime 记录 | Runtime 事务只作用于该并行会话 |
| `workspace` / `workspaceGeneration` | Runtime registry / 经典 workspace | 拒绝切换工作区后的迟到写入 |
| `bridgeRun` | RPC bridge | 拒绝重启 / 重连后的旧请求 |
| `entryId` + `parentId` | `get_entries` | 目标用户消息的稳定身份 |
| `leafId` | `get_entries` | 提交时历史修订判据 |
| `userIndex` | `get_messages` 投影 | 前端可见序号；提交时重新投影核对 |
| `requestId` | 前端生成 | 幂等、状态查询、跨会话隔离 |

提交时重新读取 `get_state` / `get_entries` / `get_messages` / `get_commands`，任一不匹配即返回
`stale_session`、`stale_history`、`stale_runtime` 或 `edit_in_progress`，不执行导航。

### 4.1 原目标身份锁定（第二轮）

- 首次预检把 `sessionId`、`entryId`、`parentId`、`leafId`（以及 Runtime 的 `conversationId`）
  冻结为编辑器的基线；`public/ui/message-edit.js` 同时核对被点击消息的文本、图片数量与
  是否截断，防止 DOM 序号与后端投影错位。
- 提交只**验证**基线：重新预检的 `entryId` / `parentId` / `leafId` / `sessionId` 必须与首次
  完全一致；不一致返回 `stale_history`，保留用户已编辑的文本，并提示关闭旧编辑器后重新打开
  目标消息。任何路径都不会用新的 `userIndex` 结果替换基线。
- 正式提交请求必须携带 `expectedSessionId`、`expectedEntryId`、`expectedParentId`（可为
  `null`，但字段必须存在）、`expectedLeafId`；缺一即 `missing_target_identity`。后端不再按
  `userIndex` 自动解析目标，`userIndex` 只用于兼容旧协议与定位展示。
- 命令闸门 / 变更采集闸门之后、真正导航之前，后端再读一次 `get_entries`，核对 leaf、目标
  entry 与 parent；扩展在 `navigateTree` 之前再核对会话身份、当前 leaf、目标节点与父节点、
  空闲状态，关闭「后端最后一次检查」与「扩展真正执行」之间的竞态。
- 重新生成同样绑定首次预检的原始用户消息身份，不使用前端传入的正文；重复 `requestId` 还要
  核对目标身份与操作内容摘要（编辑文本的 SHA-256，重新生成为空），换目标或换内容即
  `stale_history`。

## 5. 生命周期与事务状态

服务端事务状态（第二轮收敛后）：

| 状态 / 阶段 | 含义 | 锁 |
| --- | --- | --- |
| `pending` + `navigating` | 已核对目标与命令，正在发送内部导航命令 | 持有 |
| `pending` + `sending` | 导航已被回读确认，正在发送普通 prompt | 持有 |
| `accepted` | Pi 已接受新用户消息（`started`、回读 entry 或事件证据） | 释放 requestId 锁；`editTurn` 保留到 `agent_start` / `settled` |
| `failed` | 确认未执行并已恢复原路径，或前置校验失败 | 释放 |
| `acceptance_unknown` | prompt 已发出但结果无法确认 | **保留** |
| `recovery_pending` | 历史可能已改变，恢复命令结果无法确认 | **保留** |
| `recovery_required` | 原 bridge / 会话已消失，无法继续核对 | 释放并明确标记，由用户刷新会话 |
| `stale_session` | 状态查询来自另一个 native session | 按 `recovery_required` 处理 |

`requestId` 在服务端去重：同一请求重复提交只执行一次；未解决事务的重复提交返回原状态且
不会再次导航 / 发送。重复提交**已完成**的事务时返回缓存结果（`duplicate:true`），不启动
新 Agent；Runtime Registry 不会为这种缓存结果重新占用 `editTurn`，否则没有
`agent_start` / `settled` 来释放，会把该 Runtime 永久锁在 `runtime_busy`。`pending`、
`acceptance_unknown`、`recovery_pending` 不受普通 TTL 清理；状态查询与显式 `recover` 才
继续核对。状态 JSON 只含状态、身份与结果摘要，不返回消息正文。

### 5.1 事务互斥范围（第二轮）

互斥绑定**目标 native session + bridge 代次**，不是全应用大锁：

- Classic：`messageEditService` 按 native sessionId 加锁；`blocksCommand()` 在 `/api/command`
  入口拦截除只读命令与 `abort` / `extension_ui_response` 外的全部命令（含 `new_session`、
  `switch_session`、`fork`、`compact`、`set_session_name`、模型与思考级别切换）。`/api/restart`、
  配置保存触发的 Pi 重启、经典工作区切换、会话切换、归档、删除目标会话都返回
  `edit_in_progress` / `session_running` 的明确错误，而不是由 Renderer 禁用按钮兜底。
  Classic 的 collab 生成直接写 `rpc.request({type:'prompt'})`，不经过 `/api/command`，
  因此在写 stdin 前后也各核对一次 `blocksCommand`，不能成为绕过锁的第二条 prompt 通道。
- Runtime：registry 的 `editing` / `editTurn` / `editUnresolved` 三个标志在 `command` 入口
  拦截同一组命令；`close`、`restart`、`invalidateWorkspace`、`healthCheck` 不会退掉仍有
  编辑事务的 Runtime。只有**当前事务 requestId** 的状态结论才能释放锁；迟到的旧 requestId
  查询不会清掉正在生效的 `editTurn`。真正发出 prompt 并成功的提交保留 `editTurn` 到
  `agent_start` / `settled`；重复提交命中已完成事务的缓存结果时当场释放，不等待永远不会
  到来的 Agent 事件。只影响该 `conversationId`；其它独立 Runtime 的
  prompt、读取、关闭与重启不受影响。生命周期已经不是 `ready`（bridge 退出或 native 身份
  回读失败）时，通道已无法继续核对，允许用户显式关闭/重启；事务保持未确认，不会把关闭
  当成成功或已恢复。
- 读取（`get_state` / `get_messages` / `get_entries` / `get_tree` / `get_commands` /
  `get_session_stats` / `get_available_models` / `get_available_thinking_levels`）始终允许；
  `abort` 也允许，但不会为了释放编辑锁而自动停止 Agent。
- 预检（`preflight`）在事务未解决时同样返回 `edit_in_progress`：Classic 由服务检查
  `sessionLocks`，Runtime 由 `busyReason` 返回 `canEdit:false, reason:'edit_in_progress'`。
  这样刷新后重新打开编辑器不会拿到「可编辑」的假结论，也不会清掉持久化的恢复记录。
- status / recover 绑定的是**稳定归属**（backendInstance、projectId、repoId、workspaceId、
  workspaceEpoch、conversationId），不绑定 bridgeRun / runtimeId / runtimeGeneration /
  native sessionId。bridge 异常重启后仍能用原 requestId 查询；native session 是否仍是
  同一个由服务回读 `get_state` 判定，不一致收口为 `recovery_required(stale_session)`。
  preflight / resend 仍要求 owner 逐字段一致，不能把旧页面的编辑写进新会话。
- 应用退出 / `closeAll` 是显式的生命周期路径：进程退出后事务状态不持久化，下一次启动以 Pi
  原生 leaf 为准；不会伪造「已恢复」或新建会话。

## 6. 三种结果与恢复保护契约（第二轮）

RPC 超时、传输断开、bridge 换代、恢复命令自身超时，都不能直接等同于「操作未发生」。事务把
每个改变历史的步骤归为：

1. **已确认执行**：导航后回读 `leaf === targetParentId`（需要 guard 时还必须看到 guard
   entry）；或 prompt 后有与事务文本 / 图片 / parentId 一致、且属于同一 native session 的
   新 user entry；`message_start` 的 user 事件只在文本、附件完全一致且 id 不在事务开始前
   集合里时作为补充证据。`agent_start` / `agent_settled` 只用于运行状态，**不**作为接受
   证据。
2. **已确认未执行**：Pi 明确拒绝（`__error` / `rejected` / `handled`），或回读证明 leaf 未动
   且会话空闲。
3. **无法确认**：其余情况，进入 `acceptance_unknown` / `recovery_pending`，保留 requestId、
   目标身份与事务锁，由状态查询或显式 `recover` 继续核对。

具体恢复路径：

- 导航调用抛异常 / 超时：先回读 `get_state` + `get_entries`。leaf 仍在原处且会话空闲 → 普通
  失败；leaf 已在目标父节点 → 统一恢复原路径并核对；两者都无法证明 → `recovery_pending`。
- 导航成功但 `get_entries` 回读失败：进入 `recovery_pending`，不释放锁。此时 guard 可能已经
  追加但尚未被认领；后续 `reconcile` 拿到 entries 后会先按 requestId + oldLeafId 补认 guard，
  再判断 leaf，确保恢复目标不是 null。guard + 导航已执行、guard + 导航未执行两种组合都有
  测试覆盖。
- guard 已追加、导航已执行，但回读中找不到 guard（会话文件被外部改写/压缩）：guard 是恢复
  原 leaf 的唯一锚点，继续发恢复命令只会永远停在 `recovery_pending`。显式 `recover` 时收口
  为 `recovery_required(restore_unavailable)` 并释放锁，提示用户刷新检查历史；不会伪造已恢复。
- 导航后 `io.validate()` 失败（bridge / 工作区 / owner 换代）：走统一 `recoverUnexpected`，
  不直接返回普通失败。
- 扩展已追加 guard、导航却没执行：leaf 停在 guard，原路径仍有效，返回带 `restored: true`
  的失败，不删除 guard。
- prompt 后没有明确 disposition：回读新 user entry 的 parentId、文本、图片与 native session
  身份；事件只作补充，不能仅凭「出现一条 user entry」认领。确认已接受 → 保留新路径；确认
  未接受且会话安全空闲 → 恢复；否则 `acceptance_unknown`。
- prompt 已被接受后模型生成失败：按正常 Agent 错误流程处理，**不**恢复旧路径、**不**重发。
- 恢复命令自身超时：仍以回读 leaf 为判据；回读失败返回 `restore_unconfirmed` /
  `recovery_pending`，不谎称已恢复。
- 未解决事务：前端显示「重新同步会话状态」，通过 `requestId` 调用 status / recover；在结果
  可核对前不显示「未发送」或「已恢复」，也不允许同 `requestId` 盲目重发。提交前把
  requestId / 文本 / 作用域写入 `sessionStorage`，渲染器刷新后仍能用原 requestId 查询；
  status GET 显式携带 owner 头，断线重连后不会被 409 误判。记录按作用域分开保存，Classic
  与多个 Runtime 会话的未解决事务互不覆盖。重新打开编辑器或启动恢复时，未解决事务显示
  「重新同步」入口；Classic 的 `ok:false, code:'edit_in_progress'` 与 Runtime 的
  `ok:true, canEdit:false, reason:'edit_in_progress'` 两种真实形状都能接回记录。accepted /
  failed 清本地记录并重载历史，backendInstance 已变化则清记录、不伪造结果；
  `recovery_required` 明确提示需要刷新会话检查历史。bridge ready 早于 `legacyOwner` 时，
  身份到达后会补一次 resume。

## 7. Classic 与 Runtime 支持范围

- Classic：完整支持，包括普通项目、Worktree 项目、已关闭后重新打开的历史会话（通过
  `get_entries` 投影恢复）。
- Runtime：支持**活动中的** live Runtime 会话（`edit-preflight` / `edit-resend` /
  `edit-status` / `edit-recover`）；事务额外绑定 `conversationId`、workspace 与 registry
  生命周期。结果未知期间 registry 保留 `editing` / `editUnresolved` 锁，状态查询与 recover
  不要求 bridge 处于 ready，以便 bridge 异常重启后仍能核对原 `requestId`。工作正常的
  Runtime 在事务期间不能被关闭/重启；只有生命周期已经不是 `ready`（bridge 已退出，或
  native 身份回读失败）时，才允许用户显式关闭/重启 —— 此时通道已无法继续核对，事务保持
  未确认，不会把关闭当成成功或已恢复。
- dormant Runtime 历史是既有只读视图（`server/session-history.js`），没有 live RPC 可导航，
  因此不提供编辑入口；不降级为新建会话，也不伪装成原会话。
- Runtime 的 pending edit 只替换目标 block，不追加重复用户消息；迟到的 HTTP 结果不会删除新
  run 的 block；`agent_settled` 会清理被中断 run 留下的 pending 状态。

## 8. 附件与命令文本边界

- 文本、Markdown、代码块原样提交；图片从目标用户条目的 `image` part 提取并随新 `prompt`
  重发，`imagesPreserved` 计入结果。
- 非文本 / 非图片 part（例如 `file`）在导航前拒绝，返回 `attachments_unsupported`；不把附件
  转成纯文本、不提交旧本地路径。
- 编辑文本为空 / 全空白拒绝；超过 1,000,000 字符拒绝。
- 编辑或重新生成文本若以已注册命令（含扩展命令、prompt template、`skill:<name>`）开头，
  返回 `command_text_conflict`，避免被 Pi 当成命令分发而不是用户消息。
- 重新生成不使用前端传入的文本，只使用后端从目标条目重新投影出的原文与图片。

## 9. 文件 / 工具安全

- 只移动 Pi 的活动 leaf，不自动撤销之前的文件修改、git 状态、终端输出或数据库操作。
- 不调用既有 session revert / 文件撤销服务执行隐式回滚。
- 被替换的后续历史含工具或文件动作时，UI 显示
  「重新发送会替换后续对话，之前已经执行的文件修改和命令操作不会自动撤销。」
- 新 run 的工具权限、审批、stop 屏障沿用既有流程；不重放旧工具调用。

## 10. UI 与交互

- 用户消息 action bar 增加铅笔「编辑并重新发送」；每个 Turn 的最后一条可见 Assistant 增加
  「重新生成」。复用既有 `iconMarkup` / `createIcon`、`.message-action-btn`、tooltip 与
  hover / `:focus-within` 显现；窄窗口与触屏沿用既有可见性规则。
- 编辑器在**原消息位置**内联展开，不弹页面 / 对话框，不占用 Composer：聊天列宽度、中性灰底、
  克制焦点边框、统一圆角与内距；textarea 预填原文并自动聚焦，随内容增长、到上限内部滚动。
- 底部右侧「取消」（低强调）与「重新发送」（Primary）；Escape 取消；中文 IME 组合期间
  Enter 不提交；空白禁止提交；提交中防双击；失败保留文本；不跳到底部。
- 一次会话只允许一个编辑事务；Composer 草稿不受影响；取消恢复原文。
- 重新生成复用同一事务与导航机制，不打开编辑器；成功后只保留一个用户消息与一条新回复。

## 11. 测试命令、退出码与结果（第二轮 + 第三轮实际运行）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `node tests/message-edit-target.cjs` | `Message edit target: 20/20` | 0 |
| `node tests/message-edit-service.cjs` | `Message edit service: 49/49` | 0 |
| `node tests/message-edit-http.cjs` | `Message edit HTTP: 10/10` | 0 |
| `node tests/message-edit-ui.cjs` | `Message edit UI: 42/42` | 0 |
| `PI_GUI_MESSAGE_EDIT_FIXTURE=1 node tests/message-edit-real-pi.cjs` | `Message edit real Pi: 16/16` | 0 |
| `PI_GUI_MESSAGE_EDIT_ELECTRON=1 node tests/message-edit-electron.cjs` | `Message edit Electron: 31/31` | 0 |
| `node tests/runtime-registry.cjs` | `Runtime registry: 42/42` | 0 |
| `node tests/sessions.cjs` | `97 passed, 0 failed` | 0 |
| `node tests/runtime-http.cjs` | `Runtime HTTP: 12/12` | 0 |
| `node tests/session-runtime.cjs` | `Session runtime: 7/7` | 0 |
| `node tests/runtime-nav.cjs` | `Runtime nav: 46/46` | 0 |
| `node tests/runtime-conversation.cjs` | `Runtime conversation: 110/110` | 0 |
| `node tests/smoke.cjs` | `1338/1338 通过` | 0 |
| `node tests/project-config.cjs` | `115/115 通过` | 0 |
| `node tests/hotfix.cjs` | `26/26 通过` | 0 |

- target / service / http / UI / real-Pi 套件都在 `package.json` 的 `test` 链里；real-Pi 默认
  打印 SKIP 并以 0 退出（CI 不依赖真 Pi）。Electron 需要图形环境与真实 Electron，未加入
  `npm test` 链，按上面的环境变量单独运行。
- 本轮未运行完整 `npm test`，按任务约定把全局回归交给 PR CI；已运行的定向套件没有断言数下降
  （service 25 → 49、UI 26 → 42、real-Pi 12 → 16；新增 http 10 条、runtime registry 42 条、
  sessions 4 条）。
- 第三轮（重复提交释放执行锁）改动后重跑受影响的定向套件：`runtime-registry` 42/42、
  `runtime-http` 12/12、`session-runtime` 7/7、`runtime-nav` 46/46、`smoke` 1338/1338，
  退出码均为 0。
- 产物重建：`npm run build:app -- --rebuild` 退出码 0；`dist-app\Pi GUI-win32-x64`
  整包 334.1 MB，入口 `Pi GUI.exe` 234.9 MB；同时生成 `build/Pi GUI.exe` 100.7 MB。
- `tests/message-edit-http.cjs` 覆盖：bridge 换代后仍可用原 `requestId` 查询 status /
  recover、正式提交绑定 bridge 代次、路由不替用户补目标身份、owner 不符与未知 action / 字段、
  `/api/restart` 在编辑事务期间返回 503 且不重启。
- Classic collab 生成的 `server.js` 接线在写 prompt 前后各核对一次编辑锁；该接线没有独立的
  完整 server 启动测试（现有 collab 测试使用假 channel），由独立代码审查、smoke 模块加载与
  定向闸门测试间接覆盖，列为残余风险。
- `tests/message-edit-service.cjs` 新增：导航事务在飞时对 `new_session` / `switch_session` /
  `fork` / `compact` / `set_session_name` / 模型切换等命令返回 `edit_in_progress`；只读命令、
  `abort`、其它会话、其它 bridge 代次不受影响；事务结束后锁释放。另覆盖 guard + 导航应答
  丢失 + `get_entries` 回读失败（导航已执行 / 未执行两种组合）在 `recover` 后能收敛并恢复
  原路径，不再永久停在 `recovery_pending`；事务期间 `preflight` 返回 `edit_in_progress`，
  接受后恢复可预检；guard 被外部删除时显式 recover 收口为 `recovery_required` 并释放锁。
- `tests/message-edit-ui.cjs` 新增：status GET 携带 owner 头；未解决提交把 requestId 写入
  `sessionStorage`，刷新后重新打开编辑器会接回原事务并提供恢复入口；Classic
  `ok:false, code` 与 Runtime `ok:true, canEdit:false, reason` 两种真实形状都覆盖；不同消息
  上打开编辑器仍能看到会话级恢复入口；不同作用域的记录互不覆盖；后端明确返回
  `state:'unknown'` 时清掉本地句柄并允许关闭，不留永久锁死的编辑器；成功预检只清同一
  native session 的记录；`resumePendingMessageEdit` 对 accepted / failed / backend 换代
  分别收口。
- `tests/runtime-registry.cjs` 新增：目标 Runtime 的编辑事务阻止命令、关闭、重启、工作区失效；
  其它 Runtime 可继续写入 / 读取 / 关闭；`acceptance_unknown` 保留锁，`editRecover` 后仍保留，
  `accepted` 后才释放；bridge 掉线后原 `requestId` 仍可查询；生命周期进入 `error`（身份回读
  失败）时，显式关闭是唯一逃生口，不会留下永久忙锁；`get_entries` /
  `get_available_thinking_levels` 在事务期间仍可读；重复提交已完成事务拿到
  `duplicate:true` 缓存结果时不重新占用 `editTurn`，同一 requestId 可连续重试，随后
  prompt 与 close 都可用（没有 Agent 事件也不会永久 `runtime_busy`）。
- `tests/sessions.cjs` 新增：编辑事务期间切换会话返回 `edit_in_progress`，归档 / 删除被编辑
  会话被拒绝，其它会话照常归档。

真实 Pi 第二轮证据（`PI_GUI_MESSAGE_EDIT_FIXTURE=1`）：

- `piVersion=1.5.2`，`sessionId=01a1f51f-505d-7187-a9f8-6421d0613033`，会话文件 1 个、
  8112 字节、20 行，8 次模型请求。
- 重启后用户消息为 `["edited first question"]`；guard 场景中断 leaf 为 `message/user`，
  guard 后编辑成功，最终用户消息为 `["edited after interruption"]`。
- 故障注入 1：真实导航命令执行完毕、`get_entries` 已看到 leaf 移到目标父节点，但导航 RPC
  应答被客户端丢弃并超时。事务回读确认导航已执行，继续发送 prompt 并成功提交；模型只跑了
  1 次，会话文件仍为 1 个，`sessionId` 不变。
- 故障注入 2：导航正常，真实 prompt 已被 Pi 接受、用户 entry 已落盘、Agent 已开跑，但 prompt
  RPC 应答被丢弃并超时。事务通过新 user entry 的 parentId / 文本 / session 身份确认已接受，
  保留新路径，**没有恢复旧路径、没有重发**；`requestId` 状态查询返回 `accepted`。

## 12. 真实 Electron 验收

生产后端（真实 `server.js`）+ 真实 Pi 1.5.2 + 回环确定性模型 + 真实 `BrowserWindow`，临时项目 /
会话 / agent / userData 全部在 `os.tmpdir()`：

- `sessionId=01a1f52a-7c9f-76ac-a796-7131299af38c`（第二轮最终运行）
- 会话文件 1 个、17467 字节；侧栏条目编辑前 1、编辑后 1
- 5 次模型请求；编辑后的模型上下文只含 `["edited first question"]`
- 标题：编辑前 `first question`（首条用户消息 fallback）；通过生产
  `/api/session-titles/rename` 设为 `手工标题·保留` 后，编辑重发与重新生成后仍为
  `手工标题·保留`，`titleSource=manual`
- 渲染器 console error：0
- 结果：`Message edit Electron: 31/31`，退出码 0。Windows 上 Electron 退出后临时目录偶尔
  晚一拍释放；测试对清理做了有限重试，清理仍失败时打印 `NOTE temp directory left behind`
  而不再把已通过的验收判成失败。

截图（`.shots/message-edit/`，均为真实 `capturePage`）：

| 文件 | 内容 |
| --- | --- |
| `edit-hover-light.png` | 用户消息 hover 后出现编辑 / 复制按钮 |
| `edit-focus-light.png` | 键盘 focus 显现同一 action bar |
| `editor-light.png` | 原位置内联编辑器、工具警告、取消 / 重新发送 |
| `editor-dark.png` | 深色主题下的同一编辑器 |
| `editor-narrow.png` | 560px 窗口下不越界、无横向页面滚动 |
| `after-resend-light.png` | 编辑后的用户消息、新回复、旧工具与旧回复离开活动路径 |
| `regenerate-light.png` | 重新生成后的新回复与保留的用户原文 |

说明：早先一次 Electron 运行使用 `PI_CODING_AGENT_SESSION_DIR` 把会话文件放到 pi-GUI 会话
列表扫描不到的位置，侧栏只剩 pending 占位行；页面显示的 `second question` 是既有
`pi-gui:classic-prompt-sent` 对 pending 行的临时兜底标题，不是标题被清空。改为 Pi 默认会话
目录后，列表行是真实文件，fallback 为首条用户消息；手动标题在编辑与重新生成后保持不变。

## 13. 身份、文件、侧栏与模型上下文证据

第二轮实测对比（真实 Pi 与真实 Electron 各一次）：

| 指标 | 编辑 / 重发前 | 编辑 / 重发后 |
| --- | --- | --- |
| native `sessionId` | 真实 Pi `01a1f51f-…` / Electron `01a1f52a-…` | 与各自编辑前完全相同 |
| 原生会话文件数 | 1 | 1 |
| 侧栏条目数（Electron） | 1 | 1 |
| 原生会话文件 | append-only，旧文本仍可检索 | 继续追加；旧分支离开 active path |
| 模型上下文用户消息 | 编辑前两轮 | 只含 `["edited first question"]` |
| 手动标题 | `手工标题·保留`（`titleSource=manual`） | 编辑与重新生成后不变 |

- 编辑前后 `sessionId` 相同；会话文件路径与数量不变（真实 Pi 与 Electron 均为 1 个文件）。
- 旧文本与旧回复仍留在 append-only JSONL 中（`first question` 仍可检索），但 `get_entries`
  的 leaf 路径与 `get_messages` 投影不再包含它们。
- 侧栏条目数量不变（Electron 1 → 1）；没有新会话、没有 fork、没有 `new_session`。
- 模型请求体只包含编辑后的历史（真实 Pi 与 Electron 都断言 `editedModelContext` 为
  `["edited first question"]`）。
- 重启 Pi 后从同一会话文件恢复编辑后的活动路径；guard 场景证明用户消息 leaf 可精确恢复。
- 手动标题通过生产标题服务写入 pi-GUI 元数据，编辑 / 重新生成不触碰它；会话标题存储不在
  Pi JSONL 中，符合既有标题设计。

## 14. 未验证项与残余风险

第二轮新增的未验证项与残余风险：

- 真实 Pi 故障注入覆盖「导航应答丢失」与「prompt 应答丢失」；「导航已执行但 `get_entries`
  回读失败」「guard + 回读失败」「恢复命令应答丢失」「恢复无法确认」由假 RPC 的 service
  测试覆盖，没有在真实 Pi 上逐项注入。
- Electron 验收覆盖正常编辑 / 重新生成与既有视觉交互，没有在真实 Electron 里注入
  `acceptance_unknown` / `recovery_pending` 的恢复 UI，也没有在真实 Electron 里做一次
  「事务进行中刷新渲染器」；该路径由 jsdom UI 测试与 API helper 测试覆盖。
- Classic 的 `/api/command` 与 `/api/restart` 闸门在 `server.js` 中接线，HTTP 级测试分别
  覆盖了 service 的 `blocksCommand` 与 router 的 `restartGuard`；collab 生成的
  `blocksCommand` 接线没有独立完整 server 测试。完整 `server.js` 启动路径由 Electron
  验收间接覆盖，但没有为每个维护入口单独起完整后端。
- 渲染器刷新后的恢复依赖 `sessionStorage`；应用重启会清空它，后端内存事务也已消失，因此
  以 Pi 原生 leaf 为准，不伪造「已恢复」。后端换代（backendInstance 变化）时前端主动清除
  本地记录，不继续查询旧 requestId。记录按作用域分开保存，Classic 与多个 Runtime 会话的
  未解决事务不会互相覆盖；但 `sessionStorage` 不跨窗口/标签页共享，另一个窗口发起的编辑
  事务在恢复时只会表现为该会话的 `edit_in_progress`，本窗口无法替它 recover —— 锁仍由
  服务端强制，另一个窗口仍持有自己的 requestId。
- `app.js` 在 `legacyOwner.sessionId` 到达时补一次 resume；该接线没有独立 jsdom 测试
  （`app.js` 不在 UI 套件的加载范围），由真实 Electron 正常路径与独立审查覆盖。
- 真实 Electron 没有注入「事务进行中刷新渲染器后接回记录」；该路径由 jsdom UI 测试覆盖，
  两种后端真实形状都有断言。
- guard 被外部删除的收敛路径由 service 测试覆盖（导航已执行、回读成功、guard 缺失 →
  `recovery_required` 并释放锁）；没有在真实 Pi 上模拟会话文件被外部改写。
- prompt 的非 `started` disposition（例如 `queued`）按既有契约走恢复分支。事务要求发送前
  会话空闲，正常路径不会产生 queued；该行为是基线已有的，本轮没有放宽。collab 生成绕过
  锁的入口已封堵。
- 应用退出 / `closeAll` 不阻止进行中的编辑事务：事务状态只在内存里，退出后不持久化；下一次
  启动以 Pi 原生 leaf 为准。这是有意的降级，不伪造「已恢复」。
- Runtime 通道本来就不接受 `new_session` / `fork` / `switch_session`（白名单拒绝），编辑期间
  同样是 `invalid_command`；没有为这些命令另开入口。
- 未运行完整 `npm test` / PR CI：全局回归与其它套件的交叉影响待 PR CI 验证。

第一轮遗留（仍然适用）：

- Electron 验收只覆盖 Windows 11 + Electron 44.4.3；macOS / Linux 的窗口与输入法行为未实测。
- 真实中文 IME 组合在 jsdom 中按 `compositionstart/end` 事件模拟；真实输入法候选窗行为
  未在 Electron 中自动化，建议人工复核。
- dormant Runtime 历史不支持编辑（设计限制，不降级）；需要在 Runtime 重新激活后才能编辑。
- 图片只验证了 `image` part 的原样重发；其它多模态 part（如未来新增类型）会按
  `attachments_unsupported` 失败关闭，未做前向兼容。
- 若 Pi 未来改变 `navigateTree` 对用户消息 / `custom_message` 的 leaf 语义，事务会在
  `navigate_unverified` 失败关闭；需要按新 Pi 版本重新验收。
- 编辑后的标题：手动 / AI 标题不受影响；pending 会话的临时兜底标题仍可能在列表刷新时回到
  默认值，这是既有行为，不属于本功能对标题的覆盖。

## 15. 变更文件与回滚

新增：

- `server/message-edit.js`、`server/message-edit-routes.js`、`server/session-edit-target.js`、
  `server/message-edit-launch.js`
- `extensions/pi-gui-edit/index.js`
- `public/ui/message-edit.js`、`public/message-edit.css`
- `tests/message-edit-target.cjs`、`tests/message-edit-service.cjs`、`tests/message-edit-http.cjs`、
  `tests/message-edit-ui.cjs`、`tests/message-edit-real-pi.cjs`、`tests/message-edit-electron.cjs`

修改：

- `server.js`、`server/router.js`、`server/rpc-bridge.js`、`server/child-env.js`、
  `server/session-runtime.js`、`server/runtime-registry.js`、`server/runtime-routes.js`、
  `server/sessions.js`
- `public/api.js`、`public/app.js`、`public/index.html`、`public/messages.js`、`public/runtime-conversation.js`、
  `public/runtime-store.js`、`public/ui/message-actions.js`
- `tests/runtime-registry.cjs`、`tests/sessions.cjs`、`tests/message-edit-electron.cjs`（Windows
  临时目录清理重试）
- `scripts/build-exe.mjs`、`package.json`（测试链）
- `docs/conversation-ui.md`（本功能约束）、`docs/message-edit-resend-acceptance.md`（本文件）

回滚：删除上述新增文件，还原上述修改文件与 `package.json` 测试链，重新构建
`npm run build:app -- --rebuild`。回滚不触碰用户会话文件；已发生的编辑只留在 Pi 原生
append-only 历史里，按 Pi 自己的分支语义处理。
