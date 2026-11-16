# Subagent Activity

P17 Subagent 属于当前 Pi 对话的 Tool Activity。Planner 是独立任务图，CLI adapter、Attempt、Review、Verification、Evidence 不参与这条链；不共享任务、ID、stdout 或状态机。

## 手动安装

在终端执行 `pi install npm:pi-subagents`，然后在 Extensions 页面确认重启 Pi 并刷新。
GUI 不安装、不改 package/cache/settings、不扫描 Agent 定义。
installed/configured/loaded/runtimeObserved 分别显示；磁盘发现不证明工具注册。同名工具可能来自其他 Extension。
观察只针对当前 workspace generation / bridge run，切项目、重启、退出、错误、无项目清空观察。

## 核对的公开契约

2026-09-30 npm 最新发布版 **0.73.1**，gitHead **8a403efba6975988cc0488ec8bb941db5ef1a19e**。
这是契约核对版本，不是 GUI 的安装要求。

- [Manifest](https://github.com/nicobailon/pi-subagents/blob/8a403efba6975988cc0488ec8bb941db5ef1a19e/package.json)：skills、prompts、发布入口 index.js。
- [Tool reference](https://github.com/nicobailon/pi-subagents/blob/8a403efba6975988cc0488ec8bb941db5ef1a19e/docs/tool-reference.md)：当前输入。
- [Types](https://github.com/nicobailon/pi-subagents/blob/8a403efba6975988cc0488ec8bb941db5ef1a19e/src/shared/types.ts)：SingleResult、Details、WorkflowChildSummary、WaitCompletion。
- [Activation](https://github.com/nicobailon/pi-subagents/blob/8a403efba6975988cc0488ec8bb941db5ef1a19e/src/extension/tool-activation.ts) 与 [wait](https://github.com/nicobailon/pi-subagents/blob/8a403efba6975988cc0488ec8bb941db5ef1a19e/src/runs/background/wait-tool.ts)：注册工具名。

pi-subagents v0.73.1 的 parent-side 相关工具包括：`subagents_enable`、`bg_wait`、`subagent_supervisor`、`subagent`。
wait 行为可由上游配置关闭，但工具仍注册并立即返回。
Pi 0.86.1+ 的 fresh unrestricted parent 初始 active tools 是 subagents_enable、bg_wait、subagent_supervisor；
subagent registered but initially inactive，调用 subagents_enable 后在后续模型请求中激活。
Supervisor 无需等待 loader；观察到 Supervisor 而未观察到 subagent 完全正常，不表示安装/加载失败。
pi 满足最低版本（核对基线 0.87.0；0.99.1 的 RPC 事件面与之一致），loaded 仍需运行证据；
loader 不启动 child，部分 provider 要等下一次用户 prompt，GUI 不重试或强制激活。

| 路径 | 输入 | 展示依据 |
|---|---|---|
| foreground | agent/task，显式 async:false | results 的实际 agent/model/exitCode/progress/stop/interrupt |
| parallel workflow | workflowScript 的 runs.all() 或命名 workflow | workflowChildren 的实际父 ID、run ID、child ID 与状态，或真实 results |
| background | async:true，默认由 asyncByDefault 决定 | asyncId/runId 表示启动，完成未知 |
| management | subagent action/id，例如 status/stop/steer | 调用和可用结构化证据；纯文本 status 不解析为权威状态 |
| wait | bg_wait 的 id/all/nonBlocking/timeoutMs 等 | completions 的 runId/state/success；wait window 结束不证明 child 结束 |
| supervisor | subagent_supervisor 的 status/pending/list/reply，输入 action/to/message/replyTo | 只展示 action 与 producer 明确的安全 metadata；message 和内部路径不展示 |

**顶层 chain/tasks/parallel 已移除。** 不解析脚本猜数量、Agent、model 或关系。
workflow summary 的 version、parentToolCallId、workflowRunId 必须对应当前 entry。
foreground index 仅在实际 runId 内作为身份展示，UI 行号不是 ID。

### Parent-child coordination

当前 Supervisor producer 与生命周期已对照同一发布 revision 的
[native-supervisor-channel.ts](https://github.com/nicobailon/pi-subagents/blob/8a403efba6975988cc0488ec8bb941db5ef1a19e/src/intercom/native-supervisor-channel.ts)、
[configuration](https://github.com/nicobailon/pi-subagents/blob/8a403efba6975988cc0488ec8bb941db5ef1a19e/docs/configuration.md)、
[workflows](https://github.com/nicobailon/pi-subagents/blob/8a403efba6975988cc0488ec8bb941db5ef1a19e/docs/workflows.md) 与
[activation smoke](https://github.com/nicobailon/pi-subagents/blob/8a403efba6975988cc0488ec8bb941db5ef1a19e/test/smoke/tool-activation.test.ts) 核对。

- status：Checking / Checked supervisor channel；仅布尔 active 与非负整数 pending（Pending replies）。
- pending/list：Checking supervisor requests / Checked 或 Listed supervisor requests；数组长度表示 Pending requests。
  最多 24 条，白名单为 id、runId、agent、childIndex、reason、expectsReply；字符串最多 180 字符（reason 80），总事实最多 8000 字符。
- reply：Replying / Replied to subagent；只取 details 的 replyTo、runId、agent，不从 input 推断已回复。
- error：Supervisor action failed，只展示 action；不回显 raw error content 或 request payload。
- 未来未知 action：Subagent supervisor action 与 bounded action 名，仍走专用安全投影，绝不回到 raw JSON renderer。

这是当前 Pi session 的 child-parent coordination，不是 Planner approval/review、GUI confirmation、Automation 或权限系统。
GUI 不创建 Planner task，不弹窗问答，不提供 inbox/reply 按钮，不主动调用/回复、不扫描 channel 或读取 request files。
真正回复仍由 Pi/model 调用工具完成。历史复用同一投影，落盘内容不放宽限制；child-facing contact_supervisor 不在本轮范围。

## 数据流与历史

`Pi RPC/SSE → workspace/run guard → ToolEntry → allowlist adapter → Timeline DOM`。
历史 toolCall/toolResult 复用同一 adapter。按 toolCallId 就地更新，partial details 保存累积快照。
缺少 end 或父回合 Stop 后变 incomplete，最后 partial 是最后已知状态。
后台 launch 明确 completion unknown，没有后台 spinner、轮询或 GUI kill；后续 status/wait 各自是独立卡片。
没有运行 metadata 显示 unknown，没有时间戳不造 duration，历史不产生 runtimeObserved。
成功 foreground/wait completion 复用 Git 450ms 防抖读刷新，不把 child 输出写入 Changes 账本，磁盘以 Git 为准。

## 安全投影与 child sessions

任务单行预览最多 180 字符、结果任务 320、child 行 24、事实合计 8000。
只取白名单字段，不展示 child token 流、messages、finalOutput、raw script、env/auth/token、transcript 或任意 details。
外部文本全部 textContent。Context/session 隔离不是 OS sandbox：Extension 与 Pi 拥有同等文件、shell、网络权限；
凭据继承和 child Extension 选择由上游管理，background runner 可 detached。

getSubagentSessionRoot 默认是父 jsonl 同目录的父文件 stem，再分 runId/run-index 或 async-id 子目录；
无父 session 使用临时目录。Sidebar 只读现有根直接 jsonl，不递归这些目录，因此不新增扫描根或文件名过滤。
显式 sessionDir 由操作者管理，GUI 不凭文件名猜 parent-child。
child Web 调用未必广播为父 RPC 独立事件，不读 transcript 或按事件顺序猜归属；实际到达父 Timeline 的 Web 调用仍走 P16。

本阶段没有 FleetView、steering UI、transcript browser、mission dashboard、Agent Editor、worktree/lane 管理或跨会话编排。

## P4-A 紧凑子项卡片

父工具行仍是原来的 `.tl-item`：名称、父状态、请求摘要、耗时和 disclosure 不变。展开后，
在现有 `.tl-more` 内增加一个单列子项列表；父行折叠时计数仍可见，用户主动折叠优先。

- 只对 `entry.name === 'subagent'` 且没有 `args.action` 的调用生成结构化列表。
- 来源一：`details.workflowChildren`，必须同时满足 `version === 1`、
  `parentToolCallId === entry.id`、非空 `workflowRunId`，且父 `details.runId` 存在时必须相等。
  子项必须带非空 `childId`，以 `childId` 为稳定键；重复键追加 `#2` 等后缀。
- 来源二：`details.results`。只有父 `runId` 存在、每个结果都带唯一非负整数 `index` 时
  才用 `${runId}/${index}` 作为身份；缺少任一证据或 index 重复时整组回退既有 facts，
  不从行号推断 producer 身份。
- 每项只读取 allowlist：`agent`、`model`、`state`、`task`、`activity/progress` 的
  `currentTool/toolCount/turnCount/tokens/durationMs`。缺失字段省略；状态只映射白名单值，
  未知值显示「状态未知」；不以工具调用数推算完成百分比，不以 `args.agent/task`
  证明已经执行成功。
- 计数只统计已知 `running`、成功（`complete/completed`）和 `failed`；摘要显示总项数、
  已知状态计数、实际显示数和 `inventoryComplete === false` 时的「清单不完整」。
- 每个来源最多 24 项，事实权重预算 8000 字符；超限时按前缀截断，摘要显示「显示 N」，
  但仍继续统计后续已知项。原始 facts 仍按既有 8000 字符截断，现有 facts 字符串未改。
- 父生命周期使用完整的 `details.results` 证据，不受 24 项展示上限截断：第 25 项之后的
  失败、停止或中断也会反映在父工具状态，避免父状态显示成功而计数显示失败。workflow
  的父状态仍以 producer 的 `workflowState` 为准。
- 展开复用现有 `.tl-toggle`、`aria-expanded`、`aria-controls`；列表为
  `role=list` + `aria-label=子代理`，每项 `role=listitem`。不新增独立滚动区、
  子代理 Stop 按钮、编排/控制入口或第二套状态机。
- 以下情况完全回退到既有安全 facts 工具行：管理/控制调用、`bg_wait` 的未知完成状态、
  background launch、空 `details`、过期或父 ID 不匹配的 workflow 帧、无法确认归属的 results。
- Runtime 实时/历史的工具投影仍只有 `id/name/state/waiting/durationMs`；本阶段没有把
  `args/details` 或子代理 facts 加进 Runtime。Runtime 的 `subagent` 工具行继续显示现有安全回退。

## 验证

npm test 串行包含 tests/subagents.cjs 和 tests/session-ux-phase4a.cjs，完全离线，不安装、不读真实 Agent、不启动 child model/detached runner、不消耗 quota。
UI smoke 验证真实 SSE 并发/stale/Stop/Git 防抖/重启确认。Chrome shots:harness 157/158 检查 workflow 状态、父关系及 background launch。
P4-A 的 jsdom 契约与真实 Chromium 视觉证据分别见 `tests/session-ux-phase4a.cjs` 与
`tests/session-ux-phase4a-shots.cjs`；截图和测量在
[docs/ui/session-ux-phase4a-evidence](ui/session-ux-phase4a-evidence/)。

Live 是人工可选流程，不在 CI/default tests，本阶段未自动运行。安装可信 Extension 并配置真实模型后，在隔离项目显式授权验证：

1. loader 前后模型请求的工具选择，确认只启用不执行。
2. 自定义 Agent async:false 小任务、Stop、实际 model、history reload。
3. runs.all() workflow，核对真实 child ID，包含一项失败、一项成功。
4. background 小任务，对照 launch 与原生通知/bg_wait，不能把 launch 当完成。
5. 后台运行时切 workspace/重启，旧事件不能进入新 Timeline，child 不进入普通 Sidebar。

这些操作可能写文件及访问服务，只在隔离测试项目执行，不向真实会话写 fixture。
