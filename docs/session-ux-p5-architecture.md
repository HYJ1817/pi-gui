# P5-0 统一 Agent 执行时间线架构

**决策**：经典会话（Classic）和并行会话（Runtime）共享任务级读模型和渲染器。两端继续使用现有命令、SSE、审批与运行状态所有者。pi-GUI 追加可选的执行归属元数据和受控详情读取，Pi 原生 RPC 与会话格式沿用现状。

## 源码勘察

审查基线为 `origin/main` 和当前 HEAD `c444b7c8`。工作区另有系统设置改动，设计以已提交的会话代码为基线；涉及共享入口的本地改动单独核对。只读查阅了本机已安装 Pi `@earendil-works/pi-coding-agent@1.5.2` 的 `dist/modes/json-event.d.ts`、`dist/modes/rpc/rpc-mode.js`、`dist/core/agent-session.js` 和依赖的 `pi-agent-core/dist/types.d.ts`，没有调用真实模型。安装包证据用于核对字段与先后，兼容性仍由仓库 fixture 和版本能力门控。

| 范围 | 现有实现与可复用部分 | P5 的缺口与处理 |
| --- | --- | --- |
| Pi 原始事件 | `rpc-bridge.js` 逐行解码 RPC stdout，盖 bridge 身份；`server.js` 的 Classic 发布口附 `legacyOwner`；`sse.js` 分配全局 `_seq` 并在连接时重放有界 backlog。Runtime 先由 `session-runtime.js` 投影，再由 registry 生成带 owner 和 `eventSequence` 的帧。 | 接纳事件后在 pi-GUI 内统一映射生命周期与来源位置。全局 SSE 序号用于运输去重，Runtime 会话序号用于本会话回放，两者都不是持久 ID。 [RPC 桥](../server/rpc-bridge.js) · [Classic 发布口](../server.js#L514) · [SSE](../server/sse.js) · [Runtime registry](../server/runtime-registry.js#L222) |
| Assistant 生命周期 | Classic `messages.js` 按 content index 接收事件，`message_end.message` 重建权威正文。Runtime `runtime-store.js` 校正分段与状态，`runtime-timeline.js` 还能从原生消息恢复 blocks。Pi 1.5.2 的 JSON/RPC 流可只给增量和有限用量，没有每帧 cumulative message。 | 一个 ExecutionTurn 内可有多条 assistant、多个 Pi `turn_start/end`、多个 `agent_start`。保留所有可见正文，区分过程发言和最终回答。 [Classic 消息](../public/messages.js#L970) · [Runtime store](../public/runtime-store.js#L482) · [时间线](../public/runtime-timeline.js#L64) |
| Thinking | Classic 处理公开 thinking 事件及 `type: 'thinking'` 的消息 content，Runtime 有同源 block、状态和长度上限。工作动画分别由 Classic working 行、Runtime 状态行和回底部按钮持有。 | 只改变已结束思考文本的位置与默认折叠。进程动画宿主、节点生命周期、调用点和条件一律沿用。 [Classic working 与思考](../public/messages.js#L348) · [Runtime 状态行](../public/runtime-conversation.js#L632) · [滚动按钮](../public/scroll-button.js) |
| 工具 | `tool_execution_start/update/end` 按 `toolCallId` 配对。Classic 复用 `tool-model.js`、`tools.js`、`tool-view.js`；partialResult 是累积值。Runtime 有状态、已知耗时、等待写入及 Plan 例外，投影主动移除通用 args/result。上游 1.5.2 声明 end 有 toolName，已有兼容实现允许旧 end 省略它，持续采用 start 绑定。 | 收拢现有渲染，保留真实调用粒度；在 Runtime 安全边界前提取小型结构化摘要，详情另走按需读取。 [模型](../public/tool-model.js#L307) · [Classic 工具](../public/tools.js) · [Runtime 投影](../server/session-runtime.js#L28) |
| Plan | 仓库自有扩展 `gui_plan` v1，任务带 `id/title/status`，结果带 `revision/updatedAt/turnId`，运行中的补充输入继承该计划。两端已有窄投影、Plan 组件与中断显示。扩展可保留遗漏的终态任务。 | `turnId` 是 Plan 范围的佐证，无 Plan 的轮次也需可识别。v1 支持多任务同时进行，缺少任务父子字段和单任务起止时间。 [扩展](../extensions/pi-gui-plan/index.js#L140) · [Plan 投影](../server/plan-projection.js) · [Classic Plan](../public/plan-live.js) · [组件](../public/plan-view.js) |
| 子代理 | P4-A 以可信 details 显示父工具和子项。绑定通过实际 call ID、workflow ID / child ID 或 run ID + producer index，附真实模型、状态和限额。Runtime 当前只展示安全父行，前端接到的工具 summary 没有子项事实。 | 复用现有 allowlist；需要 Runtime 子项时在投影边界前按父调用校验，再发送同样有界的摘要。后台脱离、控制工具、unknown 等沿用现有保守回退。 [子代理投影](../public/subagent-activity.js) · [P4-A](session-ux-phase4a-acceptance.md#数据契约与回退) |
| 历史 | Classic 用关联的 `get_state/get_messages` 和 `tool-history.js`，按 P4-D 分块挂载。Runtime live reconnect 用 registry ring/events、游标与 `get_messages`。只读历史使用原生 JSONL 有界尾读和 `timelineFromMessages`，目前按物理消息行扫描，临时 block ID 重建；`get_messages` 没有 entry ID。 | 受控通过原生 entry/leaf 绑定，不用物理尾部或文本相似性判活跃分支。保留真实回放缺口；活跃/只读/Classic 三条历史路径统一实体键。 [Classic 回读](../public/rpc.js#L59) · [Runtime 恢复](../public/runtime-recovery.js) · [原生历史](../server/session-history.js#L82) · [既有 branch 解析](../server/session-edit-target.js#L59) |
| 多会话与变更分支 | Runtime registry 验证完整 owner，store 分会话验 generation 与序号，普通会话已可后台执行。Classic 维护 bridge/workspace/session 和切换隔离。编辑重发通过事务及 native entry/leaf 定位，存在 pending echo、分支变化和恢复分支。 | 适配器在原入口接收身份，DOM 挂载只读当前视图。不得绕开审批、Stop、写入排队、编辑事务或后台通知；多模型和子代理的身份/用量分层。 [Runtime 状态](../public/runtime-store.js#L422) · [会话并行](../server/ordinary-sessions.js) · [编辑重发](message-edit-resend-acceptance.md) |

### P1–P4 与明确冲突

| 已有行为 | 保护点 |
| --- | --- |
| P1 的结态、单次汇总和错误/重试反馈 | 复用 `deriveTurnOutcome` 与实际 `agent_settled`/Stop 证据。保留原恢复入口；渲染层的新分组不驱动副作用。 [P1](session-ux-phase1-acceptance.md) · [终态组件](../public/turn-outcome.js) |
| P2 的阅读位置、展开补偿、历史定位和自动跟随 | 外层 wrapper 会影响 `reading-position.js` 直接子元素扫描和导航索引，需要在 P5-B/C 将稳定锚点映射到任务与实际消息。锚点失败继续明确提示。 [P2](session-ux-phase2-final-acceptance.md) · [锚点扫描](../public/reading-position.js#L34) |
| P3 的工具等待、组耗时、Plan-only usage 和读屏语义 | 用量现随 block，P5 改归属到任务内逐消息账本，保留 Plan-only 明细和折叠可达性。旧 renderer 保留原路径至 P5-C 验收。 [P3](session-ux-phase3-acceptance.md) · [用量组件](../public/message-meta.js) |
| P4-A/B 的子代理和错误恢复 | 子项身份/限额、安全回退和重试授权沿原实现。P4-B 判终态时机也适用于 P5。 [P4-A](session-ux-phase4a-acceptance.md) · [P4-B/C](session-ux-phase4bc-acceptance.md) |
| P4-C/D/E 的密度、性能与后台提示 | 保留已收窄的布置、Classic 分块和 Runtime 裁剪反馈。后台提示只订阅现有合法终态与 scope/revision 去重；恢复和折叠不产生提示。 [P4-D](session-ux-phase4d-acceptance.md) · [P4-E](session-ux-phase4e-acceptance.md) |

Runtime 当前从文本投影生成任务卡和回答，图片/附件数据未进入既有历史 blocks。P5 需在授权的消息读取路径保留富内容引用，Classic 复用 `userBody` 单一渲染。Runtime 现按 assistant 批次建组并在工具签名变化时替换组 DOM。P5 使用任务级稳定容器和按行更新。冻结 `public/thinking-dots.js`、`public/thinking-dots.css`，同时冻结 `messages.js` 的 working、Runtime 的状态行、`scroll-button.js` 的动画调用、参数与触发顺序。合成视图只包装执行正文，动画宿主和流尾锚点沿用原路径。若 wrapper 改变节点存活或 CSS 选择器命中，调整 wrapper 或留用原挂载结构，记为 P5-B 回归项。

## 架构选择

在视图中合并 DOM 可以快速做原型，但无法恢复运行边界、处理重连或证明输出属于哪次调用。重写 RPC 则会复制既有身份、调度、取消和恢复责任。采用第三种方案：从现有 Classic 事件、Runtime 安全帧和原生会话读入，产生共享的有界投影。P5-A 沿用 `runtime-timeline.js` 的分段、白名单和预算，提取任务级 reducer，旧 block 结构留作兼容视图或适配输入，禁止让两个投影视图各自解释终态。建议采用仓库现有 ESM JavaScript，以下 TypeScript 定义是接口契约。

## 实体契约

```ts
type Id = string
type Origin = 'classic-rpc' | 'runtime-frame' | 'native-entry' | 'gui-metadata'
type Position = {
  domain: 'live' | 'history'
  stream: Id                  // generation-bound stream or verified branch view
  sequence: number            // source ordinal within stream, never compared across streams
  part: number                // content/event sub-index, zero when unused
}
type Evidence = 'verified' | 'legacy' | 'partial'
type Outcome = 'queued' | 'running' | 'waiting' | 'stopping' | 'completed'
  | 'failed' | 'cancelled' | 'interrupted' | 'incomplete' | 'unknown'
type TimeEvidence = 'observed' | 'recorded' | 'estimated' | 'unknown'
type Timing = {
  startedAt: number | null    // epoch milliseconds
  endedAt: number | null
  durationMs: number | null
  evidence: TimeEvidence
}
type Issue = { code: string; displayText?: string }
type Scoped<S> = {
  id: Id
  sessionId: Id | null        // null only for an owned provisional live session
  turnId: Id
  parentId: Id | null
  position: Position
  source: Origin
  evidence: Evidence
  timing: Timing
  status: S
  issue?: Issue
}
type PayloadRef = {
  id: Id                       // opaque handle resolved within current scope
  source: 'live-buffer' | 'native-entry'
  state: 'available' | 'pending' | 'unavailable' | 'restricted'
}
type UsageFields = Partial<Record<
  'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1h' |
  'reasoning' | 'totalTokens' | 'costTotal', number>>
type MessageRef = {
  id: Id
  nativeEntryId?: Id
  userIndex?: number          // navigation only
  content: PayloadRef         // existing message body / rich content owner
}
type AssistantPart = {
  id: Id
  message: MessageRef
  partIndices: number[]
  position: Position
  kind: 'thinking' | 'progress-text' | 'answer' | 'partial-answer'
}
type ExecutionTurn = Scoped<Outcome> & {
  input: MessageRef | null
  additionalInputs: MessageRef[]
  attempts: { id: Id; kind: 'initial' | 'auto-retry' | 'fallback' | 'continue'
    status: Outcome; timing: Timing }[]
  plan: { sourceTurnId: Id | null; revision: number | null
    state: 'confirmed' | 'provisional' | 'stalled'; items: PlanItem[] } | null
  activityGroupId: Id | null
  parts: AssistantPart[]
  usage: { responseId: Id; model?: { provider?: string; id: string }
    recorded: UsageFields; position: Position }[]
  completeness: 'complete' | 'partial'
}
type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
type PlanItem = Scoped<PlanStatus> & {
  producerId: Id
  title: string
  order: number
  retained?: boolean
  planRevision: number | null
}
type ActivityGroup = Scoped<Outcome> & {
  activeItemId: Id | null
  itemIds: Id[]                // first-observed start order
  completeness: 'complete' | 'partial'
}
type ActivityItem = Scoped<Outcome> & {
  kind: 'tool' | 'subagent' | 'compaction'
  toolName?: string
  callId?: Id
  attemptId: Id
  responseId?: Id
  childIds: Id[]
  title: string                // derived from validated fields, never from assistant prose
  detailRef?: PayloadRef
}
type ActivityDetail = Scoped<Outcome> & {
  ref: PayloadRef
  parameters?: unknown         // validated per-tool typed fields at the boundary
  output?: { kind: 'text' | 'diff'; text: string; truncated: boolean }
  diffStat?: { added: number; removed: number }
  exitCode?: number
  omitted?: 'expired' | 'missing' | 'unsupported' | 'restricted'
}
type TimelineViewState = {
  scopeKey: Id
  openById: Record<Id, boolean> // missing key means apply default
}
```

根实体的 `id = turnId`、`parentId = null`。PlanItem 默认父级为该 turn，可在未来有可信父任务字段时引用同一版本内的 PlanItem（校验存在及无环）。组的父级为 turn，工具父级为组，子代理子项父级为调用，Detail 父级为条目。实体 position 只记录首个可信位置；末次更新的位置与版本保存在 reducer 索引中。Plan 的 `order` 沿用最新确认列表顺序，常规状态变更不移动行；扩展明确重排列表时按新顺序更新，终态保留行为沿用 producer。没有可信父关系或活动关联时显示平级项，不按名称、顺序或相似文本把工具和 PlanItem 对齐。工具和计划的时间、错误可各自未知。读模型不保留整段原始工具参数、输出和二进制附件。展开状态不进入执行事实或 Pi 文件。

### P5-A reducer 输入接口

```ts
type RuntimeOwner = {
  backendInstance: Id; projectId: Id; repoId: Id; workspaceId: Id
  workspaceEpoch: Id | number; conversationId: Id; runtimeId: Id
  runtimeGeneration: Id; sessionId: Id | null
}
type LiveScope = { kind: 'runtime'; owner: RuntimeOwner }
  | { kind: 'classic'; bridgeInstance: Id; bridgeRun: number
      workspaceKey: Id; workspaceGeneration: number; sessionId: Id | null }
type Fact =
  | { type: 'turn.open'; submissionId: Id; input?: MessageRef }
  | { type: 'turn.input'; input: MessageRef; role: 'initial' | 'additional' }
  | { type: 'attempt'; attempt: ExecutionTurn['attempts'][number] }
  | { type: 'message.start'; message: MessageRef }
  | { type: 'message.delta'; responseId: Id; partIndex: number
      kind: 'thinking' | 'text'; delta: string }
  | { type: 'message.end'; responseId: Id; parts: AssistantPart[]
      usage?: ExecutionTurn['usage'][number]; stopReason?: string }
  | { type: 'activity.start'; item: ActivityItem }
  | { type: 'activity.update'; itemId: Id
      patch: Partial<Pick<ActivityItem, 'status' | 'timing' | 'issue' | 'title' | 'detailRef' | 'childIds'>> }
  | { type: 'plan'; callId: Id; plan: ExecutionTurn['plan']; state: 'proposed' | 'applied' | 'rejected' }
  | { type: 'turn.settle'; status: Extract<Outcome,
      'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'>; issue?: Issue }
type ExecutionEvent = {
  scope: LiveScope; turnId: Id; eventId: Id; position: Position; observedAt: number
  fact: Fact
}
```

这些是适配器交给 P5 的内部事实。帧中无法确定 turnId 或 itemId 时先留在适配层，reducer 不使用当前可见会话填空。一个输入帧可产生多个事实，按 `position.part` 分派，`eventId` 取 scope、运输序号和 part 的组合。初始 turn 在接受入口预留，assistant response、工具、组、详情和 Plan 项从已有作用域及父 ID 派生。后续 canonical 键使用原生 entry ID、角色/content 段索引或该 entry 下的 call ID。B 阶段可用正常形状的历史快照开发，C 阶段以同一 reducer 的 `mergeHistory` 录入权威切面。历史 cut 至少携带 scope 证据、branch witness、已覆盖水位、已绑定实体与临时键别名，以及裁剪标记。

## 事件映射和归属

| 输入 | 归约规则 |
| --- | --- |
| 已接纳的 prompt、用户消息、`agent_start` | 在**服务端已接纳的提交**时分配 GUI turn ID 或预留提交槽，再以首个真实用户消息/运行证据确认归属。适配器兼容 user 与 start 的两种先后。等待权威回声时复用乐观节点，以提交/命令身份替换内容，异步 echo、响应和首轮 native session ID 补齐均不新增用户卡。拒绝的命令无用户消息时由现有提交失败入口反馈；明确已接纳但生成预检失败时由结构化响应关闭该提交。斜杠 handled 不开始模型轮次。 |
| steer / follow_up | 按现有命令 disposition 与实际送达的 message_start 绑定：活动未 settle 且实际消费的输入加入 `additionalInputs`，仍有单独消息锚；下轮才由 Pi 接纳的输入创建新任务；已排队未送达或被 Stop 清空的输入留在现有排队/提交反馈中。歧义进入待归属队列，失败时置部分记录。 |
| Assistant `message_start/update/end` | 以 scoped response key 记录每条消息和 content index；流式只追加一次 delta，终值从 `message_end.message` 原位校正。每条部分正文、公开思考、附件内容和真实 usage 均引用原拥有者。Pi 的 assistant 工具声明用于元数据关联，真实 live 活动行由执行 start 创建。 |
| `tool_execution_start/update/end`、`tool_wait_state` | 第一条可信 start 固定行位置；update 替换累积结果引用，end 更新终态、事实和真实耗时。调度等待只改变对应已绑定调用。若最终只读历史有声明无结果且无执行证据，标记未完成/执行未确认，不能当成实际已启动。 |
| `gui_plan` | 开始参数可作当前计划的待确认更新；严格绑定 toolCallId，结果 `details`/revision 胜出。拒绝回到最后一次确认的数据；无权威确认的尝试历史仅可标为未确认。较旧 revision 不回滚较新确认，revision 与 Plan source turn/分支配对。终态只让未完项目呈停滞，不将它们人工写成完成、失败或取消。 |
| retry、fallback、compaction | Pi 自动重试/压缩期间重复 `agent_start` 继承 turn 与起始时间。以 `auto_retry_start/end`、已接受的 fallback owner 链和真实压缩事件记状态；压缩有明确开始/收尾证据才入活动区。助手失败状态不覆盖后续成功。Classic 受控换模型 fallback 即使跨上一尝试的 settle，也只在现有 coordinator 证实同一请求链时继承 turn。Runtime 沿用其当前执行能力，普通 UI 重试/重新生成走现有提交/编辑事务。 |
| `agent_end`、`agent_settled`、Stop、bridge 状态 | `agent_end` 和内部 `turn_end` 只收模型循环/消息，继续等待会话 settle。用结构化终态及已验证 Stop 的 idle 证据关闭任务；脱离运行或进程断开时有活跃证据才记中断。没有 end 的 running 行在关闭时标为未完成/中断，不以任务成功反推工具成功。stop pending 仍由现有闸门管理；重复终态幂等。 |

Live owner 复用现有全量检查。Runtime 比较 backendInstance、projectId、repoId、workspaceId、workspaceEpoch、conversationId、runtimeId、runtimeGeneration 和 sessionId。Classic 复用 bridgeInstance/run、workspace witness 和当前 native session。仅原 authority 证明同一运行且空 ID 补齐时可重绑，已确认的两个不同 session 一律不合并。sessionId 缺失时记录限定在该 owner 的内存。

Live response 以起始帧序号和角色生成临时键，调用索引用 `turn + attempt + response + callId`，end 常只需从当前 owner 的 in-flight 表反查。桥代、切换、分叉和 attempt 结束保留有界 tombstone，避免迟到 end 写入下一轮同 ID 调用。同一 session 的不同提交可以内容完全相同；用户消息和正文从已接纳的命令、原生 entry 或可证实的同源帧对齐，禁用文本、标题、时间戳或全局 call ID 单独去重。

活动组每 turn 一个，按真实开始接收序号排；并行调用 A、B 先后开始、B 先完成时仍为 A、B。历史无开始事件时以同一分支上的 assistant content 次序和 entry 次序重建，明确证据精度；不按结果顺序倒排。组标题优先显示开始位置最新的仍活跃调用，其他并行数另提示；暂无活跃调用时使用已知状态或 `执行活动`。组时长取首次可靠活动开始到最新结束/当前时刻的墙钟跨度，包含等待及重试间隔，整体结束后冻结，和一次工具的真实执行耗时及任务总耗时区分。未知时省略，采集时间戳与 Pi 时长各记出处；只在已知历史估算情况下标「约」。

最终回答使用最后一个有成功收尾证据、无待处理工具调用的可见终结 assistant 响应。其余有意义的文本以原分段成为过程发言，包括工具前后的说明，保留独立消息锚与 Markdown。运行中无工具的尾部文本可原位显示为暂定答复；发现真实工具活动时归回其所属过程，保持同一内容节点和位置锚。在失败/取消时保留可见部分并标为未完成；只有工具或思考时省略空回答。投影移动节点不会再生成过程摘要或修改导出/复制原消息。

### 去重、乱序与回读合并

1. Classic 延续 `_seq` 防重与 bridge snapshot 换代。全局序号的数字跳跃本身不能证明某会话缺失；使用重连、回读版本、已归属事件的水位和缺少先导事件判定是否补读。Runtime 共享 `observeRuntimeFrame` 的 owner 验证，P5 在旧 store 的游标门槛之前接收授权帧。现有 store 遇跳号会直接推进游标且不广播之后到达的低序号帧，P5 需要独立维护**最高连续水位**。已有事件消费者继续按各自入口工作。
2. 同一流有重复时忽略相同运输键。存在 Runtime 缺口先暂存后续帧并从 P5 连续游标调用 `events`，补帧重走 owner 验证后直接喂 P5，避免被旧游标拦截。Runtime 同一 live 对象换 generation 时序号可能继续增长且 ring 含旧代帧，快照需提供由服务器观测的本代起始水位，按 owner 过滤旧代。建议候补上限 200 帧/1 MiB、等待 2 秒，超过则进入一次快照恢复。对消费顺序本身出现的 end-before-start，按已验证 scope 暂存；若仍找不到 start，只有历史证实才能立项，否则给出记录缺失提示。无唯一匹配的重复 call ID fail closed。
3. 回读带请求 token 和 owner、branch、cut 水位。发起前捕获 view generation 和服务器候选水位，读取中缓存后续增量。读后再次检查 owner/branch，使用**已落盘且与 live entity 明确对应的原生 entry**证明可覆盖的连续语义前缀，或以已确认的终态 checkpoint 与完整映射作切面。请求前后的序号只能界定检查范围；Pi 的 `get_entries` 与 SSE 没有原子快照关系。读取期间若无法证明 cut，仅按 entry/已绑定别名做非破坏性补充，保留活跃未落盘记录并在 settle 时重试。确认 cut 后才替换对应已结算记录、重放高于 cut 的增量。任何跨 branch/owner 的结果直接丢弃；恢复只修数据，不能再次启动、审批、通知或滚动跟随。

## 持久化、分支和详情安全

**原生数据为事实来源。** 已授权的原生 entry 留存消息、工具声明、toolResult、公开 thinking、Plan result 和真实 usage。复用 `get_entries` 的 `entries + leafId` 或原生文件的已验证叶节点链。Pi 1.5.2 中 public message_end 先于 appendMessage，必须等可证实的持久化条目，不能在收到 message_end 就宣称已落盘。优先复用 `session-edit-target.js` 的 nested message 和 parent/leaf 校验；历史浏览用经过验证的完整分支路径，编辑事务的压缩上下文语义按它自己的入口保留。旧日文件仅有物理末尾时不能从最后一行猜 active leaf，缺少叶节点证据则沿用原只读历史回退并提示范围。

**补充持久化元数据。** 精确恢复新轮次，建议在 P5-C 用既有 pi-GUI dataDir 下的独立、版本化有界元数据索引补上任务边界。键由服务端确定的项目/工作区身份、原生 session ID、首条用户 entry ID 及分支 lineage 组成，值保存 GUI turn ID、提交角色、响应/调用键到 native entry 的映射、位置、时间/可信终态及范围。索引不写原生 schema，不保存用户输入、输出、Thinking、环境、凭据或文件路径正文。旧数据读取兼容，缺记录时走 legacy。按 native 会话串行更新、临时写后原子替换，读校验版本/限额；孤立、损坏、过期索引 fail closed。所有路径由 authority 派生，禁止 renderer 传绝对路径。旧样式回滚只停用读取，历史文件及索引可继续存在。

对新轮次在首个可信原生用户 entry 落盘后尽早记录开头和分支锚。长任务可按已绑定的条目批次节流保存中途位置，在明确终态后收口。崩溃恢复时验证已持久化前缀和执行代；已落盘的 Plan 和工具结果仍可按原生证据加入，遗失的事件和未落盘输出以「记录不完整」标记。对明确已退役但有开头证据的旧运行可以标记中断。页内修补只使用已验证记录，避免把新 live turn 误认成旧中断任务的续跑。

**P5-A 必须用 fixture 定锚。** 第一次进入已存在会话时，以当前已确认 owner 的私有分支基线为前锚。提交边界取进入该运行前最后确认的 leaf；完成后沿目标 leaf 回走到该前锚，选择唯一的首条用户 entry，按已观察的用户角色、消息位置和工具调用配对逐项绑定。可以用 `get_entries` 读取增量，在服务端校验后丢弃正文；新会话允许空前锚，但要验证 native ID 首次绑定与分支根。分批采样只在必要的 checkpoint 做，禁止逐 token 回读。编辑重发使用事务证明的 entry/leaf 及新分支回执，失效旧 tail 的 UI 缓存和详情句柄。竞争期间如果出现非本任务可解释的分支变化、同身份重复/缺页或多个候选，保持临时键并标为局部恢复，不写猜测映射。P5-A 若无法证明任一入口的边界，对该入口保留旧视图，直到该场景有契约证据。

**历史恢复顺序。** 有验证过的 GUI 边界时使用该边界和 native 条目构建相同实体；没有边界时使用已验证的 Plan turnId 作为局部证据（只约束有明确关联的 Plan 更新），其他按用户 entry 的可见段落分组并标 `legacy`。历史缺口开头使用 `input=null` 的部分记录，既不把裁掉的前半轮并入随后用户，也不将残留 running 标为成功。为已绑定的临时键建立 canonical 别名并搬移展开与滚动锚。页外命中、外部 fork/回退、compact、跨进程后无法证明旧水位、缺少附件/结果均显示当前可恢复边界。

**详情通过读权限按需获取。** Classic 优先引用当前已接纳且绑定的原工具对象和现有详情 UI。Runtime 保持专用工具事件、`cloneBlock` 及 history search summary 的通用无正文契约；新增按 `scope + opaque detailRef` 的本地只读动作，沿用 HTTP session token、workspace 校验、registry owner 或已登记只读历史目标，在读前/读后复核 scope、branch 版本、entry 与 toolCall 对应。只读历史需要现有文件身份校验；过期、跨会话、删除或分支变更返回稳定错误码。活动期间的原始值可在边界前使用小型仅内存缓存，按 owner、容量、TTL 和退役清理；终态与历史优先读原生 source。无权限及不支持时只显示已知安全摘要。

当前 Runtime 的预计剥离范围是专用工具事件、部分消息字段和 `data.messages`，静态审查可见通用投影仍扩展整个 event。在 Pi 1.5.2 契约中，`agent_end.messages` 和 `turn_end.toolResults` 有独立的位置，旧的已授权 `get_entries` 也返回 `data.entries`。这些路径没有由 `projectRuntimeEvent` 的上述分支递归处理。P5-A 的私有分支证据只允许留在后端。P5-A 验证须分别覆盖这些入口的字段与调用者，确认新 P5 接口从闭集重建自己的出站响应，现有消费者仍兼容。发现可复现的旧通道边界问题时单独记录风险及受影响入口，禁止拿它作为新详情权限的依据。本轮未对旧通道做动态安全验收。 [通用投影](../server/session-runtime.js#L28) · [已登记 Runtime 读取](../server/runtime-registry.js#L535)

初始候选闭集为内置 `read` 的 path/offset/limit 与文本条目、`grep/find/ls` 的查询、范围与有界结果文本、`edit/write` 的归属路径与已报告 diff、`bash/powershell` 的命令参数、退出状态及有界文本结果。子代理独立复用 P4-A 结构化白名单。工具名字符串不足以证明是内置实现，若工具注册来源或结果形态没有准入证据，则只给摘要。文件/搜索内容限已证实会话作用域内的授权来源，展开只读已捕获的结果，禁止按参数路径重新打开任意文件。命令、文件内容可能含任意业务秘密，字段级清洗不足以证明无泄露。P5-A 审查应逐类批准可见范围；Runtime 对未经批准的结果字段保持受限，尤其任意命令 stdout。保留片段时要展示裁剪与隐藏。建议初值每条输出 32 KiB、参数 4 KiB、活跃缓存每 owner 1 MiB，总量随已登记实例有界。二进制走已有富内容路径。工具层保有原始值。

服务器只为当前已验证 item 签发引用，handle 是查找键，不授予读权限。live handle 随 owner/分支失效；转入只读历史时，须从已授权 current history target 与原生 entry 重新查证并颁发历史引用。范围改变时撤销在途请求并清除已加载临时详情。输出按文本渲染，去控制序列，授权头、环境、已知凭据/秘密、敏感路径、原始子代理输出及未知形态默认受限。详情不进搜索缓存、广播、诊断或持久浏览器存储。日志只允许状态码、字段和计数。P5-A 安全审查通过已选的 Runtime 准入和 Classic 兼容方式后才开启相应详情。

## 统计和可扩展性

- 保留 `usageProjection` 和 `message-meta.js` 的字段、真实 0、成本和缺失语义；每个 response 只有一条原始已结算记录，流式预览另外展示。文本、工具、Thinking 和 Plan-only 的原始归属可在同一详情里回查。已有 `usage.js`、`turn-throughput.js`、ctx/配额的计算入口从原事件继续驱动。
- 任务栏提供一次「用量与耗时」入口。默认展示真实耗时与已知模型身份，展开按响应列出原值（含 Plan-only）；只有已有同口径权威总数时将其作为任务级总数，禁止用会话累计、上下文占用或自行相加替代。多模型使用每条 assistant 的真实 provider/model，已知子代理用量只归该 child；未知或被裁剪的量标为局部，不补值。既有 throughput 使用模型生成时长，活动墙钟计时不参与该计算。
- 序号、调用、Plan revision 与 DOM 以 map 按键更新。活动组、明细和正文各自有界；复用 Classic 分块，Runtime 先保留现有 240 blocks / 1 MiB 文本预算口径（实际以 `runtime-timeline.js` 为准），只有确认分页/恢复能力时才加深加载窗口。大量活动按需分块挂载，详细输出在激活后拉取，收起或失焦不保留重 DOM。具体窗口与几何验收见 [交互规范](session-ux-p5-interaction-spec.md) 和 [实施计划](session-ux-p5-implementation-plan.md)。
