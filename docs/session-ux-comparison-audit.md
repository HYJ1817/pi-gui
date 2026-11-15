# pi-GUI 会话过程 UI/UX 源码对照审计

> 审计日期：2026-11-15
>
> pi-GUI 基线：`c43fc3f21ae72a8948bb9b8b13dc01d304205c88`（`main`，v0.34.0 合并后）
>
> PI-Desktop 基线：`043d11c23d153d9a9088d315bb50d12ebd8283e2`（`main`，`apps/desktop/package.json` 为 `0.23.0-beta.1`）
>
> 参考档案基线：`docs/ui/pi-desktop-reference/` 记录的是 v0.21.0（`92ae661f1e399e69d514086b46029b4c34ba1a92`）。本文以**当前源码**为准，凡与旧档案不同处均按新版源码描述。
>
> 范围：只审计会话执行过程的展示与交互；本阶段不修改业务代码、UI 或思考动画。
>
> 许可边界：PI-Desktop 为 LGPL-3.0，pi-GUI 为 MIT。本文只提取设计事实、信息结构与交互规格，不复制代码；任何后续实现须按 pi-GUI 原生 ES Modules + 原生 CSS 独立编写。

## 0. 勘察结论

1. pi-GUI 已经具备 PI-Desktop 会话体验的**大部分底层能力**：实时/历史双路径统一到 `ToolEntry`、工具分组、可折叠 Thinking、任务列表、错误映射、停止归属、会话内导航、Runtime 有界时间线、多会话并行。差距主要不在“缺 widget”，而在**轮次级信息层级、阅读连续性、重试/中断的状态收口**。
2. 本审计不建议照搬 PI-Desktop 的“整轮 Process 父折叠”。pi-GUI Runtime 的核心契约是“按真实事件顺序排列、节点按 block id 复用、展开状态按会话保存”（`docs/conversation-ui.md` 第 25—33 行）。加一层父折叠会隐藏正在流式的内容，并让 Classic/Runtime 两套展开状态再次分叉。
3. 已发现 5 个**源码可证、体验较差**的现有实现，应优先优化而不是新增：
   - 多工具组在第二个工具开始时自动折叠，运行中的工具行被藏起来（`public/tool-view.js:317-337`）。
   - Runtime 实时用户消息同时命中“外层卡片”和“内层气泡”两套规则（`public/agent-execution.css:127-132` + `public/runtime-conversation.css:17-21`）。
   - 自动重试开始时，上一轮错误块被删除，用户看不到“为什么在重试”（`public/app.js:550-557`、`public/messages.js:608-618`）。
   - Classic 历史重建/切换会话后强制滚到底，没有按会话恢复阅读位置（`public/messages.js:764`）。
   - `incomplete` 的组状态文字用错误红，结果行却用警告色，同一状态两种语义色（`public/styles.css:545`、`public/styles.css:554`）。
4. 思考动画（`public/thinking-dots.js`、`public/thinking-dots.css` 及其调用点）在本方案中是**冻结区**。任何新增状态行、轮次行、折叠辅助都不得复用其类名、关键帧、节奏或触发时机；第 9 节给出完整保护清单与回归清单。
5. 推荐分 4 个阶段实施：先修“运行中可读性 + 状态收口”，再做“阅读连续性”，然后做“信息密度与视觉一致性”，最后处理需要用户决策的可选项（子代理卡片、错误恢复动作、密度 Token、性能虚拟化）。本阶段只提交本文档。

---

## 1. 当前会话 UI 的完整功能清单

### 1.1 两套会话承载

pi-GUI 目前有两条会话渲染路径，二者共享数据契约，但不共享 DOM：

| 视图 | 入口 | 渲染方式 | 适用场景 |
| --- | --- | --- | --- |
| Classic | `public/messages.js`、`public/tools.js` | 每条消息一个 `<article>`；工具组是 thread 的直接子节点 | 单会话主对话 |
| Runtime | `public/runtime-conversation.js`、`public/runtime-store.js`、`public/runtime-timeline.js` | 一个有界 block 列表，按真实事件顺序渲染进 `.rtc-output` | 并行会话、恢复会话、只读历史 |

共享层：`public/tool-model.js`（ToolEntry 数据模型）、`public/tool-view.js`（工具行/组视图）、`public/plan-model.js` / `plan-view.js` / `plan-live.js`（任务列表）、`public/message-meta.js`（单条消息用量）、`public/scroll-button.js`（回到底部）、`public/thinking-dots.js`（思考动画，冻结）。

### 1.2 Classic 功能清单

| 编号 | 功能 | 当前位置 | 当前行为 | 数据依据 |
| --- | --- | --- | --- | --- |
| C-01 | 阅读列与轮次间距 | `public/styles.css:32-35`、`:386-398` | 760px 阅读列、20/32px 内距、用户轮次间 36px 间距 | 设计 Token |
| C-02 | 用户消息 | `public/messages.js:345-367`；`public/styles.css:394-417` | 右对齐灰色气泡，最大 82%/600px；附件卡片、图片缩略图、复制栏 | 消息内容 |
| C-03 | 助手消息 | `public/messages.js:369-401`、`:630-687` | 透明正文、Markdown；只有工具调用、没有正文的助手外壳会被整条收掉 | `message_end.message` 权威内容 |
| C-04 | 流式文本组装 | `public/messages.js:403-518` | `message_update` 按 `contentIndex` 组装，`message_end` 覆盖为权威值；rAF 合并绘制 | Pi 事件 |
| C-05 | Thinking 折叠 | `public/messages.js:194-229` | 默认折叠；标题显示“思考过程 · N 字 · 状态”；状态有生成中/已返回/已完成/发生错误/已中断 | 真实 thinking part |
| C-06 | 工具组 | `public/tool-view.js:317-403`；`public/tools.js:126-147` | 一组 = 一条 assistant 消息里的全部 toolCall；两项以上显示组头“工具调用 · N 次”；未手动操作时默认折叠；单项不摆组头 | 真实 message 边界 |
| C-07 | 工具行 | `public/tool-view.js:77-279` | 图标 + 语义标签 + 状态 + 参数摘要 + 耗时 + 结果行；整行可点展开 | `ToolEntry` |
| C-08 | 工具详情 | `public/tool-view.js:99-129`、`:214-311` | 折叠区含输出、原始参数/details、截断说明；输出/参数只走 `textContent` | 原始结果 |
| C-09 | 工具语义适配 | `public/tool-view.js:161-169` | Web、Browser、Subagent、Memory、GUI Browser、Process、MCP 各自接管，未识别工具降级为“执行工具 + 原名” | 工具名与 details |
| C-10 | 工具状态 | `public/tool-view.js:38-57`；`public/tool-model.js:363-383` | running/success/error/incomplete/interrupted/cancelled/unknown；`tool_wait_state` 显示“等待写入” | `tool_execution_*`、`tool_wait_state` |
| C-11 | 退出码/截断/diff | `public/tool-model.js:158-206`、`:235-287`、`:489-567` | 从 bash 输出文本解析退出码；转述 pi 截断；edit 的 +N−M 先用工具 diff，再由 Git 覆盖 | 输出文本、details、Git |
| C-12 | 任务列表 | `public/plan-model.js`、`public/plan-view.js`、`public/plan-live.js` | `gui_plan` 每次提交完整列表；按稳定 id 复用行；默认展开；收尾仍有 in_progress 时只改文案为“未完成” | 扩展校验后的 `details` |
| C-13 | 运行指示 | `public/messages.js:97-157`；`public/thinking-dots.js` | “Pi 正在处理…” + 四点/三点动画；有工具在跑时只隐藏文案，动画继续 | 运行状态（冻结动画） |
| C-14 | 跟随滚动 | `public/messages.js:85-93` | 距底 160px 内才跟随；用户消息强制到底 | `scrollTop/scrollHeight` |
| C-15 | 回到底部 | `public/scroll-button.js:20-22`、`:43-170` | 离底 >160px 显示，回到 8px 内消失；运行中复用思考动画，悬停/聚焦换成箭头；只滚当前容器 | 视图状态 |
| C-16 | 会话内导航 | `public/conversation-nav.js` | 每条用户消息一个短标记；当前项高亮；点击只写 `#stream.scrollTop`，不用 `scrollIntoView` | DOM 锚点 |
| C-17 | 消息复制 | `public/ui/message-actions.js` | 用户/助手消息 hover 显示复制；失败可见且可重试；不修改会话 | 消息原文 |
| C-18 | 错误块 | `public/messages.js:527-576` | 把上游错误翻译为标题 + 下一步 + 原始详情；`role=alert` | `errorMessage` |
| C-19 | 停止归属 | `public/messages.js:167-183`、`:630-687`；`public/state.js:70-89` | `stopOwnedTurn` 区分“用户主动停止”和 provider 报的取消；用户停止显示中性说明，其余取消照常显示错误 | 停止代次/状态 |
| C-20 | 自动重试 | `public/app.js:550-557` | 状态条显示“请求失败，第 N/M 次重试…”，并删除上一轮错误块 | `auto_retry_start/end` |
| C-21 | 单条消息用量 | `public/message-meta.js:10-26` | 逐字段显示输入/输出/缓存读取/缓存写入/思考/总计 Token；`reasoning` 标注“含在输出中” | `message.usage` |
| C-22 | 会话用量/上下文 | `public/usage.js:316-346`、`:378-396`、`:427-668` | 上下文百分比、上下文/Token/缓存/成本；单轮 `lastTurn` | `get_session_stats`、`message_update/end` |
| C-23 | 历史重建 | `public/messages.js:689-765`；`public/tool-history.js` | 纯函数配对 toolCall/toolResult；缺 result 标“未完成”，孤儿 result 就地降级；重建后重扫导航 | `get_messages` |
| C-24 | 会话搜索落点 | `public/conversation-nav.js:367-386`；`server/session-search.js` | 按“第 N 次提问”跳转，复用同一份 `.msg.user` 顺序 | 搜索索引 |

### 1.3 Runtime 功能清单

| 编号 | 功能 | 当前位置 | 当前行为 | 数据依据 |
| --- | --- | --- | --- | --- |
| R-01 | 有界执行时间线 | `public/runtime-timeline.js:19-25`、`:143-280` | 最多 240 block、1MiB 文本；保留 user/assistant/thinking/tools/plan；工具 args/result 正文不进入投影 | 原生 JSONL / get_messages |
| R-02 | 实时 block 顺序 | `public/runtime-store.js:129-260` | 按事件到达顺序建 block；`message_end` 只补齐/覆盖已有段，不移动已出现的工具 | `message_update/end` |
| R-03 | 实时工具组 | `public/runtime-store.js:160-170`、`:491-521`；`public/runtime-conversation.js:703-739` | 每条 assistant 消息一个工具组；复用 `createGroup/renderEntry`；状态 running/success/error/incomplete/interrupted | `tool_execution_*` |
| R-04 | 实时任务列表 | `public/runtime-store.js:285-344`；`public/runtime-conversation.js:742-761` | plan block 按真实调用位置插入；拒绝时回到上一张；当前计划按运行态呼吸 | `gui_plan` details |
| R-05 | Thinking | `public/runtime-conversation.js:679-701`；`public/runtime-display.js:171-188` | `<details>` 折叠；显示字数、截断、状态；当前消息 thinking 再受展示上限裁剪 | 真实 thinking |
| R-06 | 按会话视图态 | `public/runtime-conversation.js:204-230`、`:586`、`:767-805` | 每个会话独立保存 scrollTop、Thinking/组/行展开状态、历史缓存 | 视图状态 |
| R-07 | 会话状态行 | `public/runtime-conversation.js:268-282`、`:556-584`、`:835-843` | 生命周期 + 活动 + 资源数；活动时显示思考点动画（冻结） | runtime item/lifecycle |
| R-08 | 审批 | `public/runtime-conversation.js:977-1003` | 会话内确认/选择/输入；提交中禁用；请求随 owner 归属 | `extension_ui_request` |
| R-09 | 只读历史 | `public/runtime-conversation.js:522-554`、`:845-917`；`server/session-history.js` | “打开历史”不 spawn、不占运行名额；有 execution timeline 时恢复计划/思考/工具/正文，否则退回正文+工具摘要；状态行说明缺什么 | 后端证明的 sessionLocator |
| R-10 | 草稿 | `public/runtime-draft.js`；`public/runtime-conversation.js:317-395` | 按会话稳定身份保存/恢复草稿；超出上限时提示 | 本地存储 |
| R-11 | 模型/思考选择 | `public/runtime-conversation.js:283-297`、`:591-620` | 每会话模型与推理强度；不可用时如实显示 | runtime models |
| R-12 | 会话控制 | `public/runtime-conversation.js:403-487` | 发送、停止、重启、关闭、恢复、打开历史、返回实时 | runtime action |
| R-13 | 并行会话侧栏 | `public/runtime-nav.js`；`public/runtime-sessions.js`；`public/runtime-resources.js` | 按后端 createdAt 排序；状态点 + 文字；资源占用；新建并行会话走既有 worktree/runtime 编排 | registry 快照 |
| R-14 | 中央并行会话 | `public/runtime-conversation.js:214-230`、`:1039-1089` | 一次聚焦一条会话；切换时恢复该会话 scrollTop/展开态；迟到响应只写所属会话 | 按会话视图态 |
| R-15 | 历史搜索落点 | `public/runtime-conversation.js:1017-1026` | 找到 `data-history-message-id` 后 `scrollIntoView({block:'center'})` | 搜索匹配 |

### 1.4 共用能力

| 编号 | 能力 | 位置 | 说明 |
| --- | --- | --- | --- |
| S-01 | ToolEntry 双路径 | `public/tool-model.js:307-440` | 实时事件与历史消息都转成同一个 ToolEntry；视图只认 ToolEntry |
| S-02 | 工具写租约 | `server/session-tool-scheduler.js:12-83` | 协作式写租约；等待中的调用通过 `onState` 广播 `waiting`，UI 显示“等待写入” |
| S-03 | 会话证据/归属 | `public/runtime-store.js:395-534`；`server/session-runtime.js` | owner、eventSequence、generation、backendInstance 多重校验；拒绝的帧不会进入投影 |
| S-04 | 设计 Token | `public/tokens.css`；`docs/ui/design-system.md` | 阅读列 760px、语义色、字号、圆角、焦点环 |
| S-05 | 思考动画 | `public/thinking-dots.js`、`public/thinking-dots.css` | 四点方阵/三点轨道自动交替；冻结区，详见第 9 节 |

### 1.5 数据边界（设计必须遵守）

| 数据 | 是否可用 | 依据 |
| --- | --- | --- |
| 工具开始/结束时间、实时耗时 | 可用 | `tool_execution_start/end` 到达时间；`tool-model.makeEntry/applyEnd` |
| 历史工具耗时 | 估算 | assistant 消息时间戳 → toolResult 时间戳，包含模型落库到工具启动的开销（`tool-model.js:397-425` 注释已说明） |
| 退出码 | 仅 bash 输出文本可解析 | `tool-model.js:166-175`；协议无结构化字段 |
| Git 行数 | 可用 | 工具 details.diff 先行，Git 状态回填覆盖（`tool-model.js:514-567`） |
| Thinking 文本与状态 | 可用 | `thinking` part；历史无块级时间戳 |
| Thinking 的单独 Token 数 | **不可用** | `usage.reasoning` 是整条回复的推理 Token，包含在 output 内，不等于某段 Thinking |
| 单轮响应开始/结束时间 | 实时可测（当前未持久化），历史不可靠 | 历史只有消息时间戳；不得据此编造吞吐 |
| 重试次数/上限 | 可用 | `auto_retry_start.attempt/maxAttempts` |
| 重试等待秒数 | **未确认** | 当前代码只消费 `attempt/maxAttempts`；未核对上游是否提供 delay，因此不得倒计时 |
| 运行阶段（等待模型/工具停止等） | 部分可用 | 明确事件：压缩、重试、工具等待、审批、停止屏障；没有“等待模型”显式事件 |
| 任务状态 | 可用 | `gui_plan` 白名单字段；不得从工具次数/时长推断 |
| 用量与成本 | 可用（存在才显示） | `message.usage`；`cost.total` 可选；缺失不补 0 |

---

## 2. PI-Desktop 对应功能及实现位置

PI-Desktop 是 React + Electron 的 monorepo；会话渲染集中在 `apps/desktop/src/features/chat/transcript/`，纯逻辑在 `apps/desktop/src/lib/`。以下路径均相对于 `apps/desktop/src/`。

### 2.1 轮次组织

- `lib/transcript-projection.ts` 把消息投影成 `message` / `assistant-turn` / `compaction` 三类 entry；`lib/assistant-turns.ts` 定义 `AssistantTurnEntry` 与 `parts`。
- `lib/turn-process.ts:307-321` 的 `projectTurnProcess` 把“最后一条有正文的 assistant 消息/错误消息”作为回答，其余作为过程。
- `features/chat/transcript/AssistantTurn.tsx:397-443` 渲染一个轮次：`TurnProcess` 包住过程，回答放在过程折叠之外，随后是模型/用量元信息和操作栏。
- `features/chat/transcript/TurnProcess.tsx:56-186` 是整个过程的**单层父折叠**：头部显示状态、耗时、工具数；活跃时默认展开，已结束默认折叠，用户显式选择保持；子级通过 `DisclosureScope` 继承父级可见性。
- `lib/turn-process.ts:222-251` 定义轮次终态：failed / stopped / running / unsettled / completed；`stopped` 从 aborted 行读取，`unsettled` 表示没有运行但仍有 streaming 行。
- `lib/turn-process.ts:324-349` 用消息时间戳与工具耗时计算轮次起止；没有时间就省略时长。

### 2.2 连续工具调用的分组、折叠、展开

- `features/chat/transcript/ActivityGroup.tsx` 负责活动组：`items` 是连续的 Thinking/工具/hosted search；头部显示“做了什么”的短语与操作数。
- `features/chat/transcript/ProcessActivityGroup.tsx:32-72` 是普通活动组的单行头部；`grouped = items.length > 1`，单项不摆组头。
- `lib/activity-group-label.ts:27-127` 定义活动分类、最多命名 3 类、操作数不把 Thinking 算作操作。
- `lib/activity-group-folding.ts:18-38`：活跃轮次/活跃组默认展开；已结束按 `autoCollapseSettledGroups` 偏好折叠；Thinking 行按 `autoCollapseThinking` 偏好折叠。
- `features/chat/transcript/disclosure.tsx:105-219` 是嵌套折叠状态机：用户显式选择优先；父级关闭时子级保留自己的选择；焦点/文本选择会阻止自动关闭；`DisclosureScope` 让子级无需知道祖先。
- `lib/turn-process.ts:150-189` 支持 `fully-folded` / `flat` / `command-first` 三种过程布局；`fully-folded` 合并连续活动段，`command-first` 把 Bash/run 行单独拆出。

### 2.3 工具执行状态、耗时、结果预览

- `features/chat/transcript/ToolRow.tsx:154-611`：一行一个工具调用；`HostToolRow` 负责头部、状态、命令、复制、详情、子代理行。
- `lib/tool-display.ts` 把工具名映射为 read/list/search/write/edit/run/fetch/fork/delegate/todo 等动作；`shared.tsx:362-405` 给出进行时/完成时的动作文案。
- `ToolRow.tsx:472-585`：run 行头部保留命令 + 复制按钮 + 结果状态点（成功/失败/运行/拒绝）；普通行头部显示动作名、参数摘要、结果 chips、状态，耗时只在子代理拓扑节点显示（`:449-452`）。
- `ToolRow.tsx:592-600` 用 `ToolDetailBlocks` 渲染折叠区；`lib/tool-presentation.ts` 负责把结果拆成摘要、输出、diff、图片等块。
- `ToolRow.tsx:366-384`：工具运行中且详情展开时，`tool-row-content` 在距底 40px 内自动跟随输出；用户手动上滚不被覆盖。
- `lib/tool-presentation.ts` 的 `runOutcome` 把 shell 退出码与工具状态合并，退出码失败优先于工具调用成功（D227）。

### 2.4 思考内容折叠与 Token 统计

- `features/chat/transcript/shared.tsx:705-788` 的 `ThinkingRow`：流式中默认展开，结束后按偏好折叠；标题是“Thinking” + 闪光文字；没有字数统计。
- `features/chat/transcript/shared.tsx:161-223` 的 `MessageMeta`：显示模型 ID；有完整 usage 时渲染 `TurnUsageCapsule`，没有 usage 时退回吞吐估算。
- `features/chat/transcript/TurnUsageCapsule.tsx:78-370`：默认显示“速度 · 总 Token（· 成本）”；悬停/聚焦弹出组成条与输入/输出/缓存读/缓存写明细；成本只在可计价时显示。
- `components/ContextUsageInspector.tsx` 与 `features/chat/context-usage/useSessionTiming.ts`：Composer 右侧上下文检查器，显示网络/模型/工具耗时瀑布；这些时间来自 PI-Desktop 自己的 runtime 计时，不是 pi 事件（`useSessionTiming.ts` 未逐行核验）。

### 2.5 Agent 任务清单与进度状态

- `components/TodoDock.tsx:31-52`：`todoProgress` 产生“2/4 done”/“全部取消”/“完成”标签；折叠头部显示当前 in_progress 项。
- `components/TodoDock.tsx:101-165`：独立 dock；展开后列表在内部滚动，不截断；`useSessionTodosRecovery` 从 host 快照恢复。
- `components/TaskDock.tsx`：把 todo 与后台任务合并成一个 Composer 上方容器；`TodoPanel` 是其中的列表形态。
- `features/chat/todos/useSessionTodosRecovery.ts:5-12`：订阅 `api.getTodos` 与 host 状态，应用到 store；具体后端实现未在本次审计展开。
- `features/chat/transcript/PlanHistoryCard.tsx:15-51`：历史 PlanProposal 卡，只读、可展开 Markdown、显示 pending/approved/rejected/expired/interrupted；审批在 `PlanApprovalBar`，不在卡里。
- 注意：PI-Desktop 的 todo、PlanProposal、子代理是三个不同契约；不要把它们当成 pi-GUI `gui_plan` 的同一种数据。

### 2.6 流式输出与执行状态同步

- `features/chat/transcript/ChatTranscript.tsx:429-567`：`thread-scroll` 是唯一滚动容器；`role="log"`、`aria-live="polite"`；尾部状态 lane 在整轮运行期间保留，避免指示器挂载/卸载改变布局。
- `ActivityGroup.tsx:435-470` 的 `WorkingIndicator`：运行点 + “Running” + 秒数。
- `ActivityGroup.tsx:472-622` 的 `RunActivityIndicator`：按 `AgentActivity.phase` 显示 starting / waiting-model / preparing / compacting / recovering / retrying / waiting-tool-stop / waiting-subagents；重试阶段显示次数、上限、倒计时和错误弹层。
- `ActivityGroup.tsx:624-642` 的 `PlanningIndicator`：规划状态。
- `features/chat/transcript/hooks/useTranscriptScroll.ts` 把“执行状态”与“历史阅读范围”分开；状态 lane 的显示条件来自 runtime activity，不从消息内容推断。

### 2.7 自动滚动、阅读位置恢复、底部跳转

- `features/chat/transcript/ChatTranscript.tsx:557-566`：离底或处于阅读窗口时显示 `jump-latest-btn`。
- `features/chat/transcript/hooks/useTranscriptScroll.ts:409-492`：`handleScroll` 用输入手势（wheel/touch/pointer/key）与程序滚动区分；真实上滚才退出 follow；重钉阈值 48px（`lib/transcript-scroll.ts:1`）。
- `features/chat/transcript/hooks/useTranscriptScroll.ts:499-525`：发送/重试/重新生成时重新钉到底部；运行开始是布局阶段处理，避免长历史先停一帧。
- `features/chat/transcript/hooks/useTranscriptScroll.ts:770-785`：`jumpToLatest` 先取消其他滚动所有者，再平滑到底。
- `lib/transcript-reading-position.ts:27-73`：按会话保存 `{pinned, messageId, offset, scrollTop, windowSize}`；只采集可见布局。
- `lib/transcript-reading-position.ts:93-124`：恢复时按锚点行 + 偏移校正；锚点未挂载时退回保存的 `scrollTop`。
- `hooks/use-transcript-reading-position.ts` 负责异步恢复与“书签缺失”上报。
- `features/chat/transcript/hooks/useTurnCompletionScroll.ts:27-80`：跟随中的轮次完成后，把该轮用户提问滚到视口顶部；失败/中止/隐藏面板/已回滚的不动。
- `lib/transcript-window.ts:22-28`：初次挂载 15 行，稳态 60 行，每次顶部增加 40 行；`useTranscriptHistoryPaging.ts` 负责向上取页并保持锚点。
- `lib/transcript-settle.ts:19-25`：首次挂载长会话时，几何稳定 3 帧或 600ms 后揭掉骨架遮罩，避免追逐布局跳动。
- `components/ConversationMinimap.tsx`：按消息锚点做会话内导航；隐藏面板不测量。

### 2.8 错误、取消、中断、重试

- `features/chat/transcript/shared.tsx:225-361` 的 `AssistantErrorMessage`：本地化摘要、错误码、网络 errno、provider/model、原始错误、复制、继续、打开设置、关闭。
- `ActivityGroup.tsx:472-622`：重试阶段把错误作为可聚焦弹层，显示错误码、网络码、HTTP 状态、原始 message；`--run-activity-error-max-height` 按可用空间测量。
- `lib/turn-process.ts:222-251`：失败优先于停止，停止优先于运行/完成；没有终止证据的轮次是 `unsettled`，不谎报完成。
- `components/TurnOutcomeCard.tsx:23-81`：尾部失败卡片，显示失败、步数、继续按钮；有内联错误时不重复。
- `SessionMessageOrigin` / `MessageRow.tsx` 区分系统消息、agent 消息与用户消息。

### 2.9 会话排版、间距、信息密度、视觉一致性

- `styles/chat-shell.css:48-50`：阅读列 760px、Composer 同宽、prose 同宽。
- `styles/messages.css:7-21`：消息行 `padding:12px 0`、`gap:12px`、`content-visibility:auto`，离屏行跳过布局/绘制。
- `styles/messages.css:2297-2420`：活动组 7px 外边距、头部 26px、折叠用 grid-rows 过渡；头部宽度占满阅读带。
- `styles/messages.css:2858-2914`：工具行头部最小 24px，头部/命令/复制/状态点的几何。
- `styles/tokens.css`：语义色、字号、圆角、动效 Token；没有把原始色散到页面。
- `styles/messages.css:1379-1587`：用量胶囊与弹层；组成条按 token 比例增长。

### 2.10 并行工具调用与多会话

- `features/chat/transcript/ToolRow.tsx:406-470` 的拓扑节点显示 delegate 的 agent/状态/模型/思考级别/步骤数/停止按钮；`:614-771` 的 `SubagentRunRows` 渲染子代理产生的行，并带独立 follow 滚动。
- `features/chat/transcript/SubagentDetail.tsx`：多个并行 Task 收成一张拓扑卡，而不是平铺成多个工具行。
- `stores/slices/session-slice.ts`：`activeSessionId`、session history、retained messages；`ADRs 0329/0137` 描述 worktree 隔离与保留面板。
- PI-Desktop 的后台会话会继续运行，但同一时间只显示一个 transcript；`TaskDock` 汇总后台任务。
- pi-GUI 的 Runtime 并行会话是**更强的**多会话能力（同时列出多条运行中的 runtime，资源上限，聚焦中央）；PI-Desktop 的子代理拓扑与后台任务汇总更成熟。两者不是同一层面的“多会话”。

---

## 3. 差异对照矩阵

### 3.1 逐项对照

#### 3.1.1 会话轮次组织与信息层级

- **PI-Desktop**：一个 `assistant-turn` = 一个轮次；`projectTurnProcess` 把过程与最终回答分开；`TurnProcess` 是单层父折叠；`AssistantTurn.tsx:397-443` 先过程、后回答、后元信息/操作。
- **pi-GUI**：Classic 每条 assistant 消息一个 `.msg.assistant`，工具组夹在消息之间；Runtime 是扁平 block 顺序。二者都没有“轮次头/轮次尾”的显式层级；`messages.js:159-183` 收尾只隐藏 working，不产出轮次摘要。
- **差异**：PI-Desktop 的层级更清楚（“做了什么” vs “回答”），但代价是过程整体可被父折叠隐藏；pi-GUI 的层级更平，真实顺序更完整，但用户要自己从一串消息/组里判断一轮何时结束、结果如何。
- **相同能力**：都有真实的轮次边界（用户消息、assistant 消息、agent_settled），都能区分过程与回答的内容。pi-GUI 缺少的是**轮次终态展示**，不是边界数据。
- **建议**：不引入父折叠；新增“轮次终态行”（完成/停止/失败/未完成 · 耗时 · 工具数），Classic 放在该轮最后一个节点（最后一条 assistant 或工具组）之后，Runtime 放在该轮最后一个 block 之后。保留现有消息/工具组节点与展开状态。
- **复杂度/风险**：中 / 中。需要新增一个纯模型 + 视图模块，并处理历史重建的“无证据不编造”。

#### 3.1.2 连续工具调用的分组、折叠与展开

- **PI-Desktop**：三层：轮次过程 → 活动组 → 工具行。组头有动作短语 + 操作数；活跃默认展开，结束按偏好折叠；父级关闭不覆盖子级选择；焦点/选择阻止自动关闭。
- **pi-GUI**：两层：工具组 → 工具行。组头有“工具调用 · N 次” + 状态汇总；多项默认折叠；单项不摆组头；`syncGroup` 在第二项加入时立即折叠，即使还在运行（`tool-view.js:317-337`）。
- **差异**：pi-GUI 的状态汇总更细（运行/失败/未完成/中断计数），但缺少动作短语、组级耗时、活跃组保持展开；PI-Desktop 的嵌套折叠状态机更成熟。
- **相同能力**：都以真实消息/事件为分组边界，都不按时间猜测；都保留单项无组头。
- **建议**：保留两层，不新增父级；修“运行中折叠”，组头增加耗时与等待写入计数；动作短语作为可选增强，不强制。
- **复杂度/风险**：小 / 低。改动集中在 `syncGroup`、`onToolWait` 与组头文字。

#### 3.1.3 工具执行状态、执行耗时及结果预览

- **PI-Desktop**：动作语义、运行/失败/拒绝状态、命令复制、结果 chips、详情块、运行中内部自动跟随、子代理行、生成图片、文件/URL 预览。
- **pi-GUI**：状态更全（含 incomplete/interrupted/cancelled/unknown）、退出码、截断、+N−M 的 Git 权威、结果行、原始输出/参数、未知工具降级；缺少命令复制、文件/URL 预览、运行中详情自动跟随、`denied` 状态。
- **差异**：pi-GUI 的数据诚实度更高；PI-Desktop 的操作便利性更好。`denied` 在 pi-GUI 没有真实来源，不应为了对齐而新增。
- **相同能力**：都有状态、耗时、结果摘要、展开后的完整输出；都不丢原始错误。
- **建议**：优先补“运行中已展开输出自动跟随”和“等待写入计数”；命令复制可选；文件/URL 预览需要走既有安全边界，暂不纳入前三阶段。
- **复杂度/风险**：小 / 低（自动跟随）；中 / 中（预览链路）。

#### 3.1.4 思考内容折叠与 Token 统计展示

- **PI-Desktop**：Thinking 流式中默认展开、结束后按偏好折叠；标题无字数；Token 统计在轮次级胶囊（速度/总量/组成/成本），历史从消息 usage 读取。
- **pi-GUI**：Thinking 始终默认折叠，标题有字数与状态；Token 统计在每条消息底部（输入/输出/缓存/思考/总计），会话级上下文 chip 在 Composer；Runtime 实时有一行本轮 usage，历史明确不含用量。
- **差异**：pi-GUI 更克制、更细粒度；PI-Desktop 更聚合、更有“速度”感。pi-GUI 没有可归因到单段 Thinking 的 Token 数，不能伪造。
- **相同能力**：都有折叠、状态、真实 usage（存在才显示）；都不把 reasoning 当额外总量。
- **建议**：保留默认折叠与字数；新增“轮次级/消息级紧凑 Token 摘要 + 展开明细”，保留全部字段与 0/缺失语义；成本可用时显示；**不新增** Thinking 单独 Token 数，不新增吞吐（历史不可靠），不改思考动画。
- **复杂度/风险**：中 / 低到中。主要是格式与可访问性，不涉及数据源。

#### 3.1.5 Agent 任务清单与进度状态

- **PI-Desktop**：Composer 上方 TodoDock/TaskDock；进度标签 + 当前 in_progress 项 + 展开列表；数据来自 host 的 todo 快照；PlanProposal 另有无状态卡。
- **pi-GUI**：`gui_plan` 任务卡在时间线内，按轮次归属，默认展开，稳定 id 复用，收尾 stalled，历史按 turnId 归并并标注 unknown/mixed。
- **差异**：pi-GUI 的 provenance 与历史兼容更强；PI-Desktop 的“当前任务”在滚动到别处时仍可见。两者数据契约不同，不能直接互换。
- **相同能力**：都有真实任务状态、完成计数、进行中项、失败/取消；都不从工具次数推断。
- **建议**：保留时间线内任务卡；折叠时头部补“正在执行：<标题>”；不迁移到 Composer dock，避免同一任务出现两处、破坏轮次归属。
- **复杂度/风险**：小 / 低。

#### 3.1.6 流式输出与执行状态同步

- **PI-Desktop**：显式 `AgentActivity` 阶段（starting/waiting-model/preparing/compacting/recovering/retrying/waiting-tool-stop/waiting-subagents），配 `RunActivityIndicator`；状态 lane 固定在轮次尾部。
- **pi-GUI**：Classic 用“Pi 正在处理…” + 状态条（压缩/重试）；Runtime 用生命周期/活动状态行 + 思考点；没有阶段枚举；`tool_wait_state` 只在工具行显示“等待写入”。
- **差异**：PI-Desktop 的阶段文案更具体；pi-GUI 的数据源没有对应的显式阶段事件。能诚实展示的只有压缩、重试、工具等待、审批、停止屏障。
- **相同能力**：都有运行/空闲/停止/错误状态；都用真实事件驱动；都不在消息内容里猜状态。
- **建议**：只新增有明确事件依据的阶段文案；没有事件的保持通用“Pi 正在处理…”。不伪造“等待模型”倒计时。
- **复杂度/风险**：小到中 / 低。文案与状态映射为主。

#### 3.1.7 自动滚动、阅读位置恢复和底部跳转

- **PI-Desktop**：显式 pinned follow + 输入手势识别；按会话书签（messageId + offset）；历史分页保持锚点；折叠高度变化保持标题位置；轮次完成后把提问滚到顶部；jump pill；minimap。
- **pi-GUI**：Classic 只按距底 160px 跟随，历史重建强制到底；Runtime 按会话保存 scrollTop，但没有锚点；两者都有回到底部按钮（复用思考动画）和 minimap；Classic 的 minimap 只索引用户消息。
- **差异**：pi-GUI 的“回到底部”和 minimap 已成熟；缺的是**阅读位置书签**与**折叠高度补偿**。PI-Desktop 的“完成后滚到提问”会改变阅读位置，不建议默认采用。
- **相同能力**：都有跟随、跳到底部、会话内导航；都不共享其他会话的滚动位置。
- **建议**：Classic 增加按会话书签 + 恢复；两种模式增加折叠锚点补偿；Runtime 修历史搜索的 `scrollIntoView`；保留 160/8px 阈值与现有按钮行为。
- **复杂度/风险**：中 / 中。历史重建是异步的，必须用真实完成信号，不能 setTimeout 猜。

#### 3.1.8 错误、取消、中断及重试状态的可视化

- **PI-Desktop**：错误卡含摘要/错误码/网络码/provider/model/原始错误/复制/继续/设置/关闭；重试状态有次数/上限/倒计时/错误弹层；轮次终态区分 failed/stopped/unsettled/completed；尾部失败卡。
- **pi-GUI**：错误卡含人话标题/下一步/原始详情；用户停止与 provider 取消分开；重试只改状态条并删除旧错误；没有轮次终态；工具/Thinking/任务在收尾时分别标未完成/中断。
- **差异**：pi-GUI 的错误可读性更好、停止归属更准确；PI-Desktop 的错误可恢复性与“错误在重试后仍可查”更好。pi-GUI 缺少统一轮次终态。
- **相同能力**：都有错误、停止、中断、重试；都不把失败投影成成功。
- **建议**：保留 `explainError` 与停止归属；重试时保留一条紧凑“失败原因 + 第 N/M 次重试”行，成功后移除，最终失败仍显示完整错误；新增轮次终态；不采纳“关闭错误”。
- **复杂度/风险**：中 / 中。重试会重发 message_start/message_end，DOM 生命周期要小心。

#### 3.1.9 会话排版、间距、信息密度和视觉一致性

- **PI-Desktop**：760px、消息 12px 上下、组 7px、工具行头部 24px、`content-visibility:auto`、统一 disclosure 几何与语义 Token。
- **pi-GUI**：760px、20/32 内距、用户轮次 36px、工具组 9/18、工具行 30px；Runtime 与 Classic 在用户消息盒、角色标签、组/计划边距、`incomplete` 状态色上不一致。
- **差异**：pi-GUI 更宽松；PI-Desktop 更紧凑且有离屏优化。pi-GUI 的视觉不一致是“现有实现的问题”，不是缺组件。
- **相同能力**：都使用语义 Token、可读的焦点/状态、代码块横向滚动、窄窗适配。
- **建议**：先修 Runtime 用户消息双盒、角色标签、`incomplete` 颜色、组/计划边距；密度 Token 暂不改，等实际截图与用户决策；`content-visibility` 先做测量，不作为默认改动。
- **复杂度/风险**：小到中 / 低（一致性）；中 / 中（密度与虚拟化）。

#### 3.1.10 并行工具调用与多会话运行场景

- **PI-Desktop**：并行 Task 收成子代理拓扑卡，delegate 有状态/模型/思考级别/步骤/停止/独立滚动；后台任务 dock；后台会话与 worktree 隔离；同一时间一个 transcript。
- **pi-GUI**：Runtime 同时列出多条会话、资源上限、聚焦中央视图；每会话独立视图态；协作式写租约让需要写磁盘的工具排队并显示“等待写入”；子代理目前是工具行内的 text facts，不是拓扑卡。
- **差异**：pi-GUI 的并行会话更强；PI-Desktop 的子代理可视化更强。普通工具的并行在两边都是按事件顺序排列的行，没有“并行泳道”。
- **相同能力**：都支持多个工具/多个会话；都不共享状态；都有真实状态反馈。
- **建议**：保留 pi-GUI 的多会话与写租约；不新增普通工具泳道；子代理卡片作为阶段 4 可选项，复用现有 `subagent-activity` facts，不新建编排引擎。
- **复杂度/风险**：子代理卡片中 / 中；其余保持。

### 3.2 差异对照矩阵（摘要）

| 维度 | pi-GUI 是否已有 | 主要差距 | 推荐动作 | 复杂度 | 回归风险 |
| --- | --- | --- | --- | --- | --- |
| 轮次组织 | 部分 | 无轮次终态/回答分离 | 新增轮次终态行 | 中 | 中 |
| 工具分组 | 是 | 运行中折叠、无组耗时/动作短语 | 优化现有组 | 小 | 低 |
| 工具状态/耗时/预览 | 是（更全） | 无运行中详情跟随、无命令复制/预览 | 优化 + 可选补 | 小到中 | 低 |
| 思考/Token | 是 | 缺少聚合与历史用量；数据不能伪造 | 紧凑元信息 | 中 | 低到中 |
| 任务清单 | 是（更强 provenance） | 折叠时看不到当前任务 | 头部补当前项 | 小 | 低 |
| 流式/执行状态 | 是 | 缺显式阶段文案 | 只补有事件依据的阶段 | 小到中 | 低 |
| 滚动/阅读位置 | 部分 | 无书签/折叠锚点 | 新增书签 + 锚点 | 中 | 中 |
| 错误/取消/重试 | 是 | 重试丢错误、无轮次终态 | 保留错误 + 终态 | 中 | 中 |
| 排版/密度/一致性 | 部分 | Runtime 双盒/角色/颜色不一致 | 统一现有样式 | 小到中 | 低 |
| 并行/多会话 | 是（多会话更强） | 子代理可视化弱 | 保持；可选卡片 | 中 | 中 |

---

## 4. 推荐保留、优化、新增及不采纳

### 4.1 保留（不动或只做等价重构）

| 编号 | 能力 | 原因 |
| --- | --- | --- |
| K-01 | `ToolEntry` 统一模型与实时/历史双路径 | 这是 pi-GUI 最关键的抽象；新增 UI 必须继续只认 ToolEntry |
| K-02 | 真实状态全集（incomplete/interrupted/cancelled/unknown） | 比 PI-Desktop 更诚实；不要为了对齐删状态 |
| K-03 | 退出码解析、截断说明、Git +N−M 权威 | 有协议/实测依据；错误信息不能丢 |
| K-04 | 思考动画与“Pi 正在处理…” | 任务明确冻结；见第 9 节 |
| K-05 | 回到底部按钮的 160/8 阈值与按容器滚动 | 现有交互契约；多会话不滚错 |
| K-06 | `gui_plan` 任务卡与 turnId 归属 | 真实任务状态与历史兼容性强于 PI-Desktop 的 dock |
| K-07 | Runtime 有界时间线、owner/sequence 校验、按会话视图态 | 安全与多会话基础；不要为排版重写 |
| K-08 | Runtime 多会话侧栏、资源上限、注意力点 | pi-GUI 的强项；保留 |
| K-09 | 错误人话映射、停止归属 | 比 PI-Desktop 的纯错误码更易读；保留并补细节 |
| K-10 | 用户消息/助手消息现有排版与 760px 阅读列 | 现有设计系统与视觉验收基线；只修不一致 |
| K-11 | Minimap 只索引用户提问 | 设计明确；不要扩成每条消息 |
| K-12 | 复制动作、无假消息操作 | 现有业务边界；不新增删除/编辑/重发 |

### 4.2 优化（现有能力，体验较差）

#### O-01 运行中的多工具组不应自动折叠

- **现状**：`public/tool-view.js:317-337` 的 `syncGroup` 在 `count >= 2`、用户未手动切换、焦点不在组内时直接 `list.hidden = true`。第二个工具 `tool_execution_start` 时立即触发（`public/tools.js:126-147`）。于是一次并行/连续工具执行中，用户只能看到“工具调用 · 2 次”与状态汇总，看不到任何运行中的输出；失败项也要等结束或手动展开。
- **目标**：折叠优先级固定为：**① 用户显式展开/折叠 > ② 活跃组默认展开 > ③ 已结束默认折叠**。用户显式选择永远不被运行状态、新工具到达或结束事件覆盖。
- **实现**：在 `syncGroup` 区分“显式选择”和“默认规则”：
  - `g.userToggled`（组头点击）或 `openChild`（任一工具行被用户展开）存在时，只同步状态文字，不改 `hidden` / `aria-expanded`；`userToggled` 不得在 `syncGroup` 中被清掉。
  - 没有显式选择且有 `running`/`waiting` 子项时默认展开。
  - 没有显式选择且全部子项结束、焦点/文本选择不在组内时默认折叠；焦点/选择在组内时保持展开。
  - 运行中不再“强制展开”一个被用户手动折叠的组；只在无显式选择时按默认展开。
  - `syncGroup` 在 `onToolWait` 时也要调用（更新等待状态）。
- **不改变**：组边界、单项无组头、状态图标、思考动画。
- **测试**：工具 1 启动 → 组只有 1 行；工具 2 启动 → 组仍展开；两者结束 → 组折叠；用户运行中手动折叠 → 第二个工具到来时保持折叠；用户手动展开 → 结束后保持展开；用户展开某行 → 结束时不自动折叠该组。

#### O-02 新增轮次终态行

- **现状**：`public/messages.js:159-183` 的 `onSettled` 只隐藏 working、发统计请求、settle 计划；没有“这一轮完成了什么/为什么停止”的轮次摘要。Runtime 只有会话级状态行（`public/runtime-conversation.js:835-843`）。
- **目标**：每轮结束出现一行紧凑终态：`已完成 · 12.4s · 5 次工具`、`已停止 · 3.1s · 2 次工具`、`失败 · 1 次工具`、`未完成 · 工具未返回`。没有真实时长就不显示时长；没有真实工具数就不显示数量。工具失败单独计数（如 `已完成 · 2 次工具失败`），不改变轮次状态。
- **实现**：新增 `public/turn-outcome.js`（纯模型 + 小视图，无业务依赖）：
  - 输入证据：本轮用户消息时间、最后一条消息/工具时间、`stopOwnedTurn`、assistant 消息的 `stopReason`/`errorMessage`、工具状态集合、Thinking 状态、是否仍有 streaming 行。
  - **轮次 `failed` 只接受轮次级错误证据**：本轮 assistant 消息的 `stopReason === 'error'` 或非空 `errorMessage`，或明确属于该轮的最终错误事件。工具结果 `isError` 只计入 `toolFailures`，**不得**把整轮判成 `failed`；全部工具失败但轮次正常收尾时仍是 `completed`，只在终态行显示工具失败数。
  - 输出状态：`completed` / `stopped` / `failed` / `unsettled`；已结束行的优先级 failed > stopped > unsettled > completed。`running` 只用于实时状态行，不写进已结束终态（与 PI-Desktop `turn-process.ts:222-251` 同序，但这里只作为展示层）。
  - Classic：在 `agent_settled` 时创建/更新该轮终态行，下一次用户消息前保留；历史重建按用户回合分组，只有上述轮次级证据/工具状态/时间戳可证明时才显示。
  - Runtime：首版由视图扫描 block 派生，不改 timeline 契约；在最后一个 block 后追加一个视图节点，下一用户 block 出现时把上一轮节点固定。没有时间戳就省略时长。
  - Thinking 行若要显示耗时，只在实时把 `thinking_start`/`thinking_end` 的到达时间记在视图状态里；历史没有块级时间戳，省略。
- **不改变**：现有消息/组/计划节点位置；不新增父折叠。
- **测试**：完成、轮次级失败、仅工具失败、用户停止、provider 取消、工具未完成、历史无时间戳、切换会话。

#### O-03 自动重试时保留“为什么在重试”

- **现状**：`public/app.js:550-554` 在 `auto_retry_start` 调 `dropTrailingError()`；`public/messages.js:608-618` 删除错误块，空助手外壳也一并移除。重试期间只剩状态条“第 N/M 次重试…”，上一轮失败原因不可见。
- **目标**：重试期间保留一条紧凑、可展开的错误摘要；成功后移除；最终失败仍显示完整错误块。不能出现多条重复错误。
- **实现**：新增 `S.retryNotice`（或复用 `noteBlock` 容器）在 thread 中占一个稳定位置；`auto_retry_start` 用 `explainError(raw)` 生成标题 + `<details>` 原始错误；`auto_retry_end` 成功/继续时移除；`message_end` 最终 error 时移除 retry 行并走现有 `errorBlock`。失败上下文用真实 `attempt/maxAttempts`，不显示倒计时。
- **不改变**：`dropTrailingError` 清理空壳的逻辑保留，只是把错误信息先搬到 retry 行。
- **测试**：重试成功、重试后仍失败、重试中用户停止、连续多次重试只有一行。

#### O-04 单条消息 Token 元信息收敛为“摘要 + 明细”

- **现状**：`public/message-meta.js:10-26` 逐项平铺输入/输出/缓存读取/缓存写入/思考/总计；字段多时换行，占据多行。
- **目标**：默认一行 `Token 1,234 · 推理 200（含在输出中）`；完整拆分放在 `<details>` 或现有展开机制里；成本存在时显示 `预估成本 0.0123`（不带货币符号，除非上游提供）。
- **实现**：保持 `FIELDS` 白名单与“缺失不显示、0 是真实值”的规则；主行只放 `totalTokens`（缺失时退回 output）与 `reasoning`；明细保留全部有效字段；`aria-label` 说明“本条助手消息用量”。
- **不改变**：`message.usage` 数据、`onTurnUsage`、会话上下文 chip。
- **测试**：全字段/缺字段/0 值/只有 cost/长数字/键盘展开。

#### O-05 Classic 按会话恢复阅读位置

- **现状**：`public/messages.js:764` 在历史重建后 `scrollBottom(true)`（除非 `afterHistoryRendered` 返回 true）；没有阅读书签。切换会话/刷新后总是回到底部，用户找不到刚才读到的位置。
- **目标**：同一渲染进程内，每个会话记住“是否贴底 + 可见锚点（用户/助手消息的 `data-nav-id` 或新增 id）+ 偏移”；切回时恢复；贴底会话仍回到底部；搜索跳转/用户发送优先于书签。
- **实现**：新增 `public/reading-position.js`（纯函数 + DOM 锚点，不存消息副本）：`capture(scroller, content, pinned)`、`restore(scroller, content, bookmark)`；键用 pi `sessionId`（不要用路径/标题猜）；在 `renderUser`/`onSettled` 更新 pinned；在 `rebuildFromMessages` 末尾、`afterHistoryRendered` 之前尝试恢复；恢复用 `scrollTop += rect.top - viewportTop - offset`，绝不 `scrollIntoView`。
- **恢复边界**：阶段 2 只做**渲染进程内存书签**（`Map<sessionId, bookmark>`），完整刷新页面或重启应用后丢失；不写 `localStorage`、不写会话文件、不改 pi 数据。跨刷新持久化是**独立的后续决策**，需要另行明确会话身份、保留期限、隐私边界与清理策略，不与本阶段混在一起。
- **不改变**：160px 跟随阈值、回到底部按钮、minimap；新用户发送仍强制到底。
- **测试**：同一渲染进程内中段滚动 → 切会话 → 切回；历史重建；搜索落点；新发送；无 sessionId 时不恢复。跨刷新恢复不在阶段 2 验收范围，单列为未验证/后续项。

#### O-06 折叠/展开保持被点击标题的位置

- **现状**：`public/tool-view.js:115-129`、`public/plan-view.js:108-114`、`public/messages.js:212` 的折叠只改 `hidden`；Runtime 的 `<details>` 也是原生展开。展开位于视口上方的行会把下方内容推走，用户失去阅读位置。
- **目标**：点击标题展开/收起时，标题在视口中的位置保持不变（除非用户已贴底，此时保持跟随）。
- **实现**：在共享小工具中记录 `header.getBoundingClientRect().top`，同步切换 DOM 后 `requestAnimationFrame` 计算新 top 并调整所属滚动容器 `scrollTop`；只调整当前容器，不使用 `scrollIntoView`；若这一帧内用户已经滚动，则放弃补偿。现有折叠是 `hidden` 瞬时切换（无高度过渡），单帧补偿足够；若未来给折叠加高度过渡，需改为 ResizeObserver 持续保持。
- **不改变**：折叠动效（现有过渡可保留）、aria 状态、思考动画。
- **测试**：展开上方工具/Thinking/Plan；收起；贴底时展开；用户同时滚动。

#### O-07 运行中已展开的工具输出自动跟随

- **现状**：`public/tool-view.js:214-220` 只写 `pre.textContent`；长输出运行中不会滚动到底，用户看到的是静止的旧行。
- **目标**：仅当工具 running、详情展开、`pre` 距底 <40px 时，把 `pre.scrollTop` 设到 `scrollHeight`；用户手动上滚后不再拉回。
- **实现**：在**写入 `pre.textContent` 之前**读取 `pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40`（`wasNearBottom`）；写入后仅当 `entry.status === 'running'`、详情展开（`!p.more.hidden`）、`wasNearBottom` 时，把 `pre.scrollTop` 设到 `scrollHeight`。追加内容会增大 `scrollHeight`，写完再测会把“原本贴底”误判成“用户已上滚”，因此必须先测后写。用户手动上滚后 `wasNearBottom` 为 false，不再拉回。
- **不改变**：输出截断、`textContent` 安全边界、工具组折叠。
- **测试**：长输出、展开/收起、先贴底后上滚、先上滚后追加、结束后不再跟随。

#### O-08 Runtime 历史搜索不要使用 `scrollIntoView`

- **现状**：`public/runtime-conversation.js:1024` 用 `row?.scrollIntoView?.({ block:'center' })`。`public/conversation-nav.js:340-353` 的注释明确记录过：`scrollIntoView` 会连带滚动可编程祖先，曾把 `.stage` 顶栏推出视口。Runtime 的历史视图在 work surface 内，风险尚未实测。
- **目标**：只写 `.rtc-output` 自己的 `scrollTop`，与 Classic 的跳转规则一致。
- **实现**：用 `row.offsetTop`（相对 `output` 的定位上下文）或 `row.getBoundingClientRect().top - output.getBoundingClientRect().top + output.scrollTop` 计算目标，clamp 后设置，保留 `block:'center'` 的居中意图。
- **验证**：真实浏览器检查 `.stage`/work surface 的 `scrollTop` 不变；源码层已有同类先例（`conversation-nav.js` 注释），Runtime 的风险待渲染验证。

#### O-09 统一 Runtime 与 Classic 的消息视觉

- **现状**：
  1. Runtime 实时用户消息同时命中 `public/agent-execution.css:127-132` 的外层卡片（padding/border/background）和 `public/runtime-conversation.css:19` 的内层气泡（`max-width:82%`、`background:var(--ds-tile-deep)`、圆角）。选择器特异度：前者 `0,4,0`，后者 `0,3,0`，前者胜出，形成“盒中盒”。
  2. Runtime 的 `data-role-label` 对用户和助手都生成可见标签（`public/agent-execution.css:120-126`），而 Classic 的用户角色被视觉隐藏（`public/styles.css:396`）。
  3. `incomplete` 的组状态文字用 `--err`（`public/styles.css:545`），结果行用 `--warn`（`public/styles.css:554`）。
- **目标**：Runtime 实时用户消息与 Classic 一致：只有气泡、右对齐、无外层框；用户角色标签视觉隐藏、助手标签保留；`incomplete` 用现有 warning 语义（与 `.tl-result` 的 `--warn` 一致），只有真正的 `error` 用错误色。
- **实现**：删除/覆盖 `agent-execution.css` 的 Runtime 用户外层框；用同一特异度的规则在 `runtime-conversation.css` 明确“气泡即容器”；为用户行 `::before` 加与 Classic 相同的 `clip-path`；拆分 `styles.css:545` 的选择器。
- **不改变**：气泡尺寸、颜色 Token、Markdown 排版、思考动画。
- **验证**：深浅主题、700/1320px、中英文真实渲染截图；计算样式检查 padding/border/background。

#### O-10 Runtime 历史补回真实用量（阶段 3）

- **现状**：`public/runtime-timeline.js:143-280` 的历史投影没有 usage 字段；`public/runtime-conversation.js:140` 的历史提示写“不含原始参数/输出及用量”；`public/runtime-display.js:189` 的 `usageOf` 只在实时投影里提供 usage。
- **目标**：历史中显示**真实存在**的数字，不伪造；老记录没有 usage 就不显示。
- **实现**：在 `timelineFromMessages` 的 assistant block 上增加白名单 `usage`（input/output/cacheRead/cacheWrite/reasoning/totalTokens；成本可选），在 `cloneBlock`/`blockChars`/历史契约测试中同步；渲染复用 O-04 的摘要组件；不把原始 `message` 或未白名单字段带进投影。
- **风险**：投影契约是安全边界；新增字段必须显式白名单、限量、无自由文本。旧历史兼容（缺字段即省略）。

#### O-11 工具组头补真实耗时与等待写入计数

- **现状**：组头只有“工具调用 · N 次”，状态汇总在下面一行；`tool_wait_state` 只改行内状态，不触发 `syncGroup`（`public/tools.js:156-161`），组头看不到等待。
- **目标**：组头/状态行显示 `运行中 1 · 等待写入 1 · 成功 2 · 8.4s`；耗时只在本组有真实起止时显示。
- **实现**：`syncGroup` 从子节点 `dataset.status` 与新增 `dataset.waiting` 计数；`onToolWait` 调用 `syncGroup`；耗时用组内最早 `startedAt` 与最晚 `endedAt`（并行重叠不重复计时）；`formatDuration` 复用 `tool-model.js:281-287`。
- **不改变**：组头文案主体、折叠规则（配合 O-01）、单项无组头。
- **测试**：并行两工具、等待写入、完成/失败混合、历史估算时长。

#### O-12 可访问性收口

- **现状**：Classic `#stream` 没有 `role="log"`/`aria-live`；Runtime `.rtc-output` 只有 `tabIndex` 和 `aria-label`；工具组/计划/Thinking 有局部 `aria-expanded`，但新终态行需要状态语义。
- **目标**：让读屏能感知“新增了一条消息/一个状态变化”，但不要每个 delta 都播报。
- **实现**：优先给 `#stream` 与 `.rtc-output` 加 `role="log"`；是否加 `aria-live="polite"` 需真实读屏验证，若流式过于吵，则保留 `role="log"` 与局部 `role="status"`。轮次终态行只在状态变化时 `role="status"`，运行秒数不加 live。所有新折叠控件沿用 `aria-controls`/`aria-expanded` 与键盘激活。
- **验证**：键盘 Tab/Shift+Tab、Enter/Space、Escape、焦点回退；深浅主题焦点环；真实读屏或至少可访问性树检查。

### 4.3 新增（现有实现没有、但值得做）

| 编号 | 新增 | 理由 | 阶段 |
| --- | --- | --- | --- |
| N-01 | 轮次终态行（Classic + Runtime） | 补足轮次层级与“完成/停止/失败/未完成”的真实状态 | 1 |
| N-02 | 重试保留错误摘要 | 不丢失失败原因，符合“错误信息不能丢” | 1 |
| N-03 | Classic 阅读位置书签 | 切换/刷新后回到原阅读位置 | 2 |
| N-04 | 折叠锚点补偿 | 展开/收起不把用户正在读的内容推走 | 2 |
| N-05 | 紧凑 Token 摘要 + 明细 | 默认隐藏低频技术细节，保留完整查看 | 3 |
| N-06 | Runtime 历史用量（可选） | 历史与实时信息对等；只在数据存在时显示 | 3 |
| N-07 | 子代理紧凑卡片（可选） | 复用现有 facts，提升并行子任务可读性；不建编排引擎 | 4 |
| N-08 | 错误恢复动作（可选） | “继续/打开设置”只在有真实命令与授权时提供 | 4 |

### 4.4 不采纳

| 编号 | 不采纳 | 理由 |
| --- | --- | --- |
| X-01 | PI-Desktop 的整轮 Process 父折叠 | 会隐藏正在流式的内容；与 Runtime 扁平 block 契约、按会话展开状态冲突；用轮次终态行替代 |
| X-02 | 把任务列表移到 Composer dock | 破坏 `gui_plan` 的轮次归属与历史 turnId；同一任务会出现两处 |
| X-03 | 消息级编辑/删除/重新生成/分支 | pi-GUI 没有这些消息级业务/API；`docs/conversation-ui.md` 明确不添加假入口；高风险 |
| X-04 | Thinking 流式中自动展开 / “隐藏思考”偏好 | 改变现有默认与信息可得性；折叠行已足够紧凑；显示偏好会增加设置面 |
| X-05 | 运行标签的 TextShimmer/新动画 | 与冻结的思考动画重复且会抢注意力；禁止新增同类动画 |
| X-06 | 可关闭的错误卡 | 违反“错误保持可见”；用户可能丢失证据 |
| X-07 | 轮次完成后滚到提问顶部 | 会改变阅读位置；pi-GUI 的跟随语义已足够 |
| X-08 | 默认启用 `content-visibility` 虚拟化 | Classic 依赖 DOM 锚点/minimap/整表重建；先测量再决定，不作为默认 |
| X-09 | 吞吐速度、网络/模型/工具耗时瀑布 | pi 事件没有可靠的响应开始与阶段边界；历史不可复现；不编造 |
| X-10 | `denied` 工具状态 | pi-GUI 没有真实来源；已有 error/cancelled/incomplete 足够 |
| X-11 | 放射状右键菜单 | 与现有菜单/工作区入口重复，超出会话 UX 范围 |
| X-12 | 关闭/隐藏工具原始输出 | 违反“不能丢失工具原始输出和错误信息”；折叠只影响默认可见性 |

---

## 5. 优化后的会话信息架构

### 5.1 设计原则

1. **真实顺序优先**：Runtime 的 block 顺序、Classic 的消息顺序不变；不按类别重排，不把后面的内容并回前面。
2. **两层折叠足够**：工具组 → 工具行；Thinking/Plan 各自一层。不引入第三层父折叠。
3. **轮次有始有终**：用户消息开始，轮次终态行结束；过程与回答在视觉上有层次，但不强制隐藏。
4. **默认紧凑，完整可达**：低频技术细节（完整 Token 拆分、工具原始参数、截断详情）默认收起；折叠不删除数据。
5. **状态有证据**：完成/停止/失败/未完成/等待写入都来自真实事件或持久化字段；缺数据就省略，不用 0 或占位符代替。
6. **阅读位置属于用户**：流式跟随只在用户贴底时发生；展开/收起保持被点击标题；切会话恢复书签。
7. **动画冻结**：思考动画、运行点、回到底部按钮的运行态动画不改。

### 5.2 目标层级

```text
会话
├─ 会话头（现有）
│  ├─ 标题 / 会话身份
│  ├─ 生命周期 · 活动 · 资源
│  └─ 模型 / 思考强度 / 控制
├─ 轮次 1
│  ├─ 用户消息（气泡 / 附件 / 复制）
│  ├─ 过程（按真实顺序）
│  │  ├─ 计划卡（gui_plan，默认展开；折叠时显示当前任务）
│  │  ├─ Thinking 行（默认折叠；字数 · 状态 · 实时耗时）
│  │  ├─ 工具组（组头：N 次 · 状态汇总 · 组耗时；活跃保持展开）
│  │  │  └─ 工具行（状态 · 摘要 · 耗时 · 结果行）
│  │  │     └─ 详情（输出 / 参数 / 截断 / 来源）
│  │  └─ 中间助手正文（保持原位，不并入回答）
│  ├─ 最终回答（现有 Markdown）
│  ├─ 回答元信息（模型 · 紧凑 Token；展开看完整拆分）
│  └─ 轮次终态行（完成 / 停止 / 失败 / 未完成 · 耗时 · 工具数）
└─ 轮次 2 ...
```

> 这是**语义层级**，不是新的 DOM 包装。实现不移动现有消息/工具组节点：Classic 仍按消息顺序渲染，Runtime 仍按 block 顺序渲染；本轮新增的只有轮次终态行（以及可选的折叠头部当前任务文案）。

### 5.3 Classic 与 Runtime 的映射

| 层级 | Classic 实现 | Runtime 实现 | 共享 |
| --- | --- | --- | --- |
| 用户消息 | `.msg.user` | `user` block | 气泡视觉、复制 |
| Thinking | `.think` | `details.ui2-runtime-thinking` | 状态文案、字数、折叠默认；**动画不共享/不改** |
| 计划 | `.plan-card` | `.ui2-runtime-plan` | `plan-view` |
| 工具组 | `.tl-group` | `.ui2-runtime-tools > .tl-group` | `tool-view` |
| 工具行/详情 | `.tl-item` | 同上 | `ToolEntry` |
| 最终回答 | `.msg.assistant` | `assistant` block | Markdown |
| 用量 | `message-meta` | 实时 `ui2-runtime-usage`；历史可选 | 同一白名单/格式 |
| 轮次终态 | 新增 `.turn-outcome` | 新增视图节点 | `turn-outcome.js` |

### 5.4 状态模型与数据来源

| 展示状态 | 允许的来源 | 禁止的推断 |
| --- | --- | --- |
| 运行中 | `agent_start` 后、`agent_settled` 前；工具 `running`；`tool_wait_state.waiting` | 不能因为“很久没输出”判失败 |
| 等待写入 | `tool_wait_state.waiting === true` | 不能从工具名猜写租约 |
| 完成 | `agent_settled` + 无错误/中止/未完成行 | 不能把“没有 error”直接当完成（可能 unsettled） |
| 已停止 | `stopOwnedTurn` + `stopReason:aborted`，或后端 stop 确认 | 不能把 provider 取消当用户停止 |
| 失败 | 仅轮次级证据：本轮 assistant 的 `stopReason:error` / 非空 `errorMessage`，或明确属于该轮的最终错误事件 | **工具 `isError` 只能计入工具失败数，不能把整轮判失败**；不能把工具失败自动升级为整轮失败 |
| 完成但含工具失败 | `agent_settled` + 无轮次级错误/中止/未完成行；工具状态中有 `error` | 不把工具失败改写成轮次 `failed`；单独显示失败数 |
| 未完成 | 收尾仍有 `running`/`streaming` 行；历史缺 result | 不能伪造 `completed` |
| 思考耗时 | 实时 `thinking_start` → `thinking_end` | 历史没有块级时间戳，不能估算 |
| 轮次耗时 | 用户消息/agent_start → 最后消息/工具/agent_settled | 缺失就省略，不补 0 |
| Token | `message.usage` 白名单字段 | `reasoning` 不能当 Thinking 单独 Token；缺失不补 0 |

---

## 6. UI 与交互设计方案

### 6.1 轮次终态行

- **位置**：Classic 在该轮最后一个节点（最后一条 assistant 或工具组）之后、下一轮用户消息之前；Runtime 在该轮最后一个 block 之后。
- **结构**：

```html
<div class="turn-outcome" data-state="completed">
  <div class="turn-outcome-line" role="status">
    <span class="turn-outcome-dot" aria-hidden="true"></span>
    <span class="turn-outcome-label">已完成</span>
    <span class="turn-outcome-sep" aria-hidden="true">·</span>
    <span class="turn-outcome-time">12.4s</span>
    <span class="turn-outcome-sep" aria-hidden="true">·</span>
    <span class="turn-outcome-tools">5 次工具</span>
  </div>
  <button type="button" class="turn-outcome-details" aria-expanded="false"
          aria-controls="turn-outcome-details-1">详情</button>
</div>
<div id="turn-outcome-details-1" class="turn-outcome-panel" hidden>
  <!-- 可选：失败原因、未完成工具、停止归属。原始错误只走 textContent。 -->
</div>
```

- **可访问性**：`role="status"` 只放在非交互的状态行上，详情按钮在其外；避免把可聚焦控件放进 live region。

- **状态样式**：完成用 `--ds-success`；停止用 `--ds-text-secondary`；失败用 `--ds-error`；未完成用 warning 语义（新组件用 `--ds-warning`；既有工具行沿用该区域已有的 `--warn`）。始终有文字和形状，不仅靠颜色。
- **交互**：整行不是按钮（避免误点）；“详情”按钮可键盘展开；失败时详情里给出已有错误块/原始错误，不复制错误文本；没有详情时不渲染按钮。
- **内容克制**：成功且无异常时只显示三个值；不显示“运行完成”之类重复装饰；不显示模型/Token（回答元信息已有）。工具失败不改变轮次状态：`completed` 行可附加 `· N 次工具失败`，用 warning 语义，`data-state` 仍为 `completed`。
- **历史**：只有能证明的才显示；缺时间就不显示时间；缺工具数就不显示；不能从“消息条数”猜工具数；工具 `isError` 只计入失败数，不把整轮标成失败。

### 6.2 工具组头与折叠

- **组头**：`工具调用 · 3 次`；状态行 `运行中 1 · 等待写入 1 · 成功 2 · 8.4s`。状态项按固定顺序：运行中、等待写入、失败、未完成、中断、已取消、状态未知、成功；只显示存在的项。
- **活跃组**：始终展开；组头仍可点击折叠（用户显式操作优先）。结束后若用户从未操作、焦点/选择不在组内、没有展开的行，则折叠。
- **单项**：不摆组头，直接显示工具行。
- **错误可见**：折叠时状态行仍显示“失败 N”；失败行在展开后保留红色状态与原始错误。
- **图标**：沿用现有 SVG 状态图标；`incomplete` 用警告色；`interrupted/cancelled/unknown` 用中性色；不新增彩色 badge。
- **动效**：只保留现有 `background`/`color` 过渡与运行点呼吸；不新增展开动画；不触碰思考动画。

### 6.3 工具行

- **头部**：状态图标 + 语义标签 + 参数摘要 + 组内耗时 + 结果行。保持单行，超长省略；`title` 提供全文。
- **展开**：整行可点；按钮文案“展开输出/详细信息/收起”；`aria-expanded`/`aria-controls`。
- **详情**：输出、原始参数/details、截断说明、结构化来源。输出/参数只走 `textContent`；`<pre>` 限高内部滚动。
- **运行中**：已展开的输出在距底 40px 内自动跟随；用户上滚不拉回。
- **等待写入**：状态文字“等待写入”；不把等待显示成失败/完成。
- **复制命令**：可选，放在行头 hover/focus；只复制参数里的 command，不复制整段 JSON；不影响键盘顺序。
- **不做**：不新增“denied”状态；不把原始输出默认铺开；不把工具结果转成 Markdown。

### 6.4 Thinking 行与 Token 元信息

- **Thinking 行**：保持默认折叠；标题 `思考过程 · 1,240 字 · 已完成`；实时 `生成中 · 8s`（仅实时可测）；错误/中断用状态文字 + 语义色。**不改变** `.thinking-dots` 的任何节点/动画/触发。
- **Token 元信息**：
  - 默认：`Token 1,234 · 推理 200（含在输出中）`；成本存在时追加 `预估成本 0.0123`。
  - 展开：输入/输出/缓存读取/缓存写入/总计；缺失字段不出现；0 显示 0。
  - 不使用“思考 Token”这个标签指代 `usage.reasoning`；文案沿用“推理（含在输出中）”。
- **不新增**：Thinking 单独 Token 数、吞吐速度、耗时瀑布。

### 6.5 任务列表

- **保持**：时间线内任务卡、稳定 id、默认展开、stalled 只改文案。
- **增强**：折叠头部显示 `任务列表 · 2/5 · 正在执行：<标题>`；没有 in_progress 时只显示计数；标题超长省略，`title` 给全文。
- **状态**：pending/in_progress/completed/failed/cancelled 使用现有图标与文字；stalled 的 in_progress 显示“未完成”，停止呼吸动画（现有 `plan-pulse` 不是思考动画，可保留其现有规则）。
- **历史**：保留 `verified/unknown/mixed` 说明；不按时间间隔猜新运行。
- **不做**：不迁移到 Composer dock；不新增第二份任务列表；不从工具调用次数推断任务。

### 6.6 执行状态、错误、停止、重试

- **运行状态**：只显示有事件依据的文案：
  - 压缩：`正在压缩上下文…`（现有）
  - 自动重试：`请求失败，第 N/M 次重试…` + 可展开错误摘要（O-03）
  - 工具等待：工具行“等待写入”（现有）
  - 停止屏障：`正在停止…`（现有 stop_state 路径）
  - 其他：`Pi 正在处理…`（现有，不改动画）
- **错误卡**：保留人话标题、下一步、原始详情；可选增加错误码/网络码（如果上游有结构化字段且不泄露敏感信息）；不默认增加“关闭”。
- **停止**：用户主动停止显示中性“已由用户取消”；provider 取消照常显示错误；工具/Thinking/任务分别标未完成/中断；轮次终态行显示“已停止”。
- **重试**：成功后移除重试行；最终失败显示完整错误卡 + 轮次“失败”；连续重试只保留一行。
- **轮次失败与工具失败分离**：轮次“失败”只认 assistant 的轮次级错误；工具失败在终态行单独计数并保持 warning 语义，不改写轮次状态，也不触发错误卡。
- **不伪造**：没有 `auto_retry` 事件时不显示重试；未确认上游 delay 字段时不倒计时。

### 6.7 滚动与阅读位置

- **跟随**：保持距底 160px 内跟随；用户上滚立即停止；回到底部按钮保持 160/8px 两段阈值与运行态动画。
- **书签**：每个会话保存 `{pinned, anchorId, offset, scrollTop}`；切会话/历史重建恢复；搜索跳转/发送优先。阶段 2 仅在渲染进程内存中保存，刷新/重启后丢失；跨刷新持久化另做决策，不写 `localStorage` 或会话文件。
- **折叠锚点**：点击标题时保持标题位置；贴底时保持跟随。
- **跳转**：只写当前滚动容器；不使用 `scrollIntoView`；点击后短期 follow（现有 900ms）保留。
- **Minimap**：保持只索引用户消息；聚簇布局与点击只写 `#stream.scrollTop` 的规则不变。

### 6.8 排版、间距、视觉一致性

- **阅读列**：保持 760px 与 20/32 内距；不改变用户气泡 82%/600px。
- **统一项**：
  - Runtime 用户消息只保留气泡；用户角色标签视觉隐藏；助手标签保留。
  - `incomplete` 状态文字用现有 warning 语义（`--warn`，与 `.tl-result` 一致）；`error` 才用错误色。
  - Runtime/Classic 的工具组、计划卡外边距统一到现有实现中的一个值（当前 Classic 组 9/18、Runtime 8/14；计划 Classic 8/16、Runtime 10/14），用截图选定，不新增魔法数。
  - Runtime 历史工具摘要与实时工具行的字号/颜色对齐（现有 12px/1.5）。
- **密度**：本轮不修改 36px 轮次间距、30px 工具行高；若后续要做，单独用 1320/700px 截图与用户决策，避免把“紧凑”变成“拥挤”。
- **离屏**：不默认加 `content-visibility`；先测量长会话的 DOM/布局成本，再决定是否按 PI-Desktop 的方式做。
- **焦点**：新控件用 `--ds-focus` 2px outline；折叠行/按钮不被裁切；深浅主题实测对比度。

### 6.9 并行工具与多会话

- **普通工具并行**：保持按事件顺序的同一组；状态行显示运行/等待计数；不为并行工具新增泳道或拓扑连线。
- **写租约**：保留“等待写入”；组头可见；不把等待伪装成运行中或完成。
- **多会话**：保留 Runtime 侧栏、资源上限、注意力点；轮次终态/阅读书签必须按会话隔离；后台会话更新不能改当前会话 DOM。
- **子代理**：阶段 4 可选卡片，只读展示 agent/status/model/elapsed/child count/facts；不新增停止按钮，除非已有安全授权路径。

### 6.10 可访问性

- 新终态行用 `role="status"`，只在状态变化时更新；运行秒数不加 live。
- 所有折叠控件保留 `aria-expanded`/`aria-controls`；键盘 Enter/Space 可操作；收起时焦点回到标题。
- `#stream`/`.rtc-output` 的 `role="log"` 先做读屏验证；如果 `aria-live` 过于吵，保留 `role="log"` 与局部状态。
- 颜色不作为唯一状态线索：状态文字 + 形状/图标。
- 700px 窄窗、中英文长标签、字体缩放、`prefers-reduced-motion` 均需验收。

### 6.11 组件复用与不新增清单

**复用**：
- 工具组/行/详情：`public/tool-view.js`，不另写一套工具卡片。
- 任务列表：`public/plan-model.js` / `plan-view.js`，不另写任务组件。
- 消息复制：`public/ui/message-actions.js`。
- 图标：`public/ui/icons.js` 现有 `iconMarkup`。
- 回到底部：`public/scroll-button.js`。
- 思考动画：`public/thinking-dots.js`（冻结，不新增调用点）。
- 视觉：`public/tokens.css` 的 `--ds-*`、`--text-*`、`--radius-*`、`--ui-space-*`、`--motion-*`。

**允许新增的模块**：
- `public/turn-outcome.js`：轮次终态纯模型 + 小视图；不依赖业务模块，Classic/Runtime 共用。
- `public/reading-position.js`：阅读书签纯函数 + DOM 锚点；不存消息副本、不写会话文件。

**不新增**：React/Vue 等框架、第三方 UI 库、图标服务、状态管理库、第二套工具时间线、第二套任务列表、第二套滚动容器。所有改动保持原生 ES Modules + 原生 CSS，与现有架构一致。

---

## 7. 分阶段实施计划

> 阶段边界按“风险从低到高、依赖从少到多”排列。每阶段独立可回滚；阶段 1—3 不需要服务端数据迁移。

### 阶段 0：审计（本次）

- 产出：本文档。
- 不修改业务代码/UI/测试；不运行完整测试（纯文档变更，按 `AGENTS.md` 说明原因）。
- 退出：用户审阅并确认推荐范围。

### 阶段 1：运行中可读性与状态收口

**目标**：让正在执行的会话“看得见、收得住、错不丢”。

| 工作项 | 文件 | 说明 |
| --- | --- | --- |
| 1-A 活跃工具组保持展开 | `public/tool-view.js`、`public/tools.js` | O-01；保留用户显式折叠与焦点/选择保护 |
| 1-B 轮次终态行 | 新增 `public/turn-outcome.js`；`public/messages.js`、`public/runtime-conversation.js`、`public/styles.css` | O-02；Classic 完整，Runtime 视图派生；缺数据省略 |
| 1-C 重试保留错误摘要 | `public/app.js`、`public/messages.js`、`public/styles.css` | O-03；一行摘要 + 可展开原始错误 |
| 1-D `incomplete` 颜色修正 | `public/styles.css` | O-09 的一部分；警告色而非错误红 |
| 1-E 单条消息 Token 收敛（可选提前） | `public/message-meta.js`、`public/styles.css` | O-04；若阶段 1 控制范围，可移到阶段 3 |

- **不包含**：阅读书签、Runtime 历史用量、子代理卡片、密度 Token。
- **回滚**：按提交回退；无数据格式变化；无迁移。

### 阶段 2：阅读连续性与折叠稳定性

**目标**：切换/刷新/展开后，用户还在原来的阅读位置。

| 工作项 | 文件 | 说明 |
| --- | --- | --- |
| 2-A Classic 阅读书签 | 新增 `public/reading-position.js`；`public/messages.js` | O-05；按 sessionId，锚点 + 偏移；搜索/发送优先；只在内存，不做跨刷新持久化 |
| 2-B 折叠锚点补偿 | `public/tool-view.js`、`public/plan-view.js`、`public/messages.js`、`public/runtime-conversation.js`、共享小工具 | O-06；只调当前容器 |
| 2-C 工具输出跟随 | `public/tool-view.js` | O-07；距底 40px 内 |
| 2-D Runtime 历史搜索滚动修正 | `public/runtime-conversation.js` | O-08；先实测祖先滚动风险 |
| 2-E 等待写入进入组头（可与 3-A 合并） | `public/tools.js`、`public/tool-view.js` | O-11 的一部分 |

- **依赖**：阶段 1 的组折叠规则稳定；否则锚点补偿会与自动折叠互相干扰。
- **回滚**：回退新增模块与调用；书签只在内存，清除即恢复原行为。

### 阶段 3：信息密度与视觉一致性

**目标**：默认更紧凑，完整信息仍可达；Classic/Runtime 看起来是同一个产品。

| 工作项 | 文件 | 说明 |
| --- | --- | --- |
| 3-A 组头耗时/等待计数 | `public/tool-view.js`、`public/tools.js` | O-11；真实起止，缺失省略 |
| 3-B Token 摘要 + 明细 | `public/message-meta.js`、`public/styles.css` | O-04；0/缺失语义不变 |
| 3-C Runtime 用户消息/角色标签统一 | `public/agent-execution.css`、`public/runtime-conversation.css` | O-09；先截图确认双盒 |
| 3-D Runtime 历史用量（可选） | `public/runtime-timeline.js`、`public/runtime-store.js`、`server/session-history.js`、测试 | O-10；白名单、旧记录兼容 |
| 3-E 可访问性 | `public/index.html`、`public/messages.js`、`public/runtime-conversation.js`、CSS | O-12；`role=log` + 读屏验证 |
| 3-F 长会话性能测量 | 测量脚本/文档，不一定改代码 | 决定是否采用 `content-visibility` 或窗口化 |

- **依赖**：阶段 2 的滚动规则稳定；3-D 需要服务端/契约测试。
- **回滚**：3-D 是加字段，可独立回退；其余为样式/格式化。

### 阶段 4：可选增强（需用户逐项批准）

| 工作项 | 前置 | 说明 |
| --- | --- | --- |
| 4-A 子代理紧凑卡片 | 用户确认范围；现有 `subagent-activity` facts 足够 | 不做编排/停止；只改善展示 |
| 4-B 错误恢复动作（继续/打开设置） | 确认真实命令/路由与授权 | 不伪造动作；失败仍保留原始错误 |
| 4-C 密度 Token 调整 | 1320/700px 对照截图 | 只调已有 Token，不新建样式体系 |
| 4-D 长会话虚拟化 | 性能测量结果 | 优先 `content-visibility` 或窗口化；不得破坏 minimap/复制/搜索 |
| 4-E 后台会话完成提示 | 现有 attention 机制评估 | 不自动切换当前会话 |

---

## 8. 每阶段验收标准

> 通用规则：实际运行并记录**真实数字**；跳过的断言不计入分子/分母；断言总数减少必须列出少了哪几条；UI 变更必须提供真实截图（jsdom 不做布局、不套外部样式表）；`public/` 变更后必须重建产物（`npm run build:exe` 或 `npm run build:app -- --rebuild`），或明确说明“只有跑源码版才看得到”。

### 8.1 阶段 1

| 验收项 | 方法 | 通过标准 |
| --- | --- | --- |
| 活跃组展开 | `node tests/ui2-classic.cjs`、`node tests/runtime-conversation.cjs`（或新增定向断言） | 工具 2 启动时组列表可见；结束后按规则折叠；用户折叠不被覆盖 |
| 轮次终态 | 新增 `tests/turn-outcome.cjs`（纯模型）+ DOM 断言 | completed/stopped/failed/unsettled 映射正确；缺时间不显示时长；历史无证据不显示 |
| 重试错误保留 | 定向 DOM 测试 + 真实事件夹具 | 重试中可展开看到原始错误；成功后移除；最终失败只有一张完整错误卡；连续重试只有一行 |
| 颜色 | 计算样式检查 | `incomplete` 的 `.tl-status` 使用 warning，`error` 使用 error；对比度达标 |
| 思考动画 | `node tests/thinking-dots.cjs`、`node tests/ui2-visual.cjs` | 与基线逐项一致；动画节奏/类名/关键帧零 diff |
| 视觉 | `npm run harness` + `npm run shots:harness`；1320×820、700×600、深/浅 | 无横向溢出；组/终态/错误行不遮挡 Composer；截图归档 |
| 回归 | `npm run test:ui2`、`node tests/agent-execution-ui.cjs`、`node tests/runtime-store.cjs` | 实际 N/N；失败项有解释 |
| 完整证明 | 功能稳定后按 `docs/testing.md` 跑 `npm test` 或用户选择的 PR CI | 结果出来前标“待验证” |

### 8.2 阶段 2

| 验收项 | 方法 | 通过标准 |
| --- | --- | --- |
| 阅读书签 | 新增 `tests/reading-position.cjs`（纯函数）+ 真实浏览器会话切换 | 同一渲染进程内中段 → 切走 → 切回，锚点误差 ≤1px；贴底会话回到底部；搜索/发送优先；完整刷新后不恢复（阶段 2 不承诺跨刷新） |
| 历史重建恢复 | 夹具会话 + 刷新/重新打开 | 不强制到底；无书签时保持原行为 |
| 折叠锚点 | 真实浏览器：展开视口上方工具/Thinking/Plan | 被点击标题的视口 top 变化 ≤1px；用户滚动不被覆盖 |
| 工具输出跟随 | 长输出夹具 | 距底 <40px 跟随；上滚后不拉回；结束后停止 |
| Runtime 历史搜索 | 真实浏览器长历史 | `.rtc-output` 滚动；`.stage`/work surface 的 scrollTop 不变 |
| 多会话隔离 | 两个 runtime 会话 | 滚动位置/书签不串；切换不写错 DOM |
| 思考动画 | 同阶段 1 | 零 diff |

### 8.3 阶段 3

| 验收项 | 方法 | 通过标准 |
| --- | --- | --- |
| 组头耗时 | 纯函数 + DOM | 并行重叠不重复计时；缺起止省略；实时秒表只在运行时更新 |
| Token 摘要 | `node tests/usage-quota.cjs` + 定向 DOM | 0/缺失/全字段/cost 正确；展开可键盘操作；不出现“思考 Token”误标 |
| Runtime 视觉统一 | 计算样式 + 截图 | 用户消息只有一个气泡；用户角色标签视觉隐藏；组/计划边距一致 |
| 历史用量 | `node tests/history-tool-summary*.cjs`、`runtime-timeline` 定向测试 | 旧记录无 usage 不显示；新记录白名单字段；无自由文本/原始 payload |
| 可访问性 | 键盘/读屏/可访问性树 | Tab/Shift+Tab/Enter/Space/Escape 正常；焦点可见；流式播报不刷屏 |
| 性能测量 | 长会话（≥500 行/≥200 工具） | 记录首屏、滚动、切换耗时；是否采用虚拟化有数据依据 |
| 思考动画 | 同阶段 1 | 零 diff |

### 8.4 阶段 4

| 验收项 | 方法 | 通过标准 |
| --- | --- | --- |
| 子代理卡片 | 真实 subagent 夹具 | 只读、状态/模型/步骤来自真实 details；无 facts 时降级为现有行；不新增停止权限 |
| 错误恢复动作 | 真实命令/路由验证 | 只在有授权路径时出现；失败保留原始错误；不伪造成功 |
| 密度 Token | 1320/700px 深/浅截图 | 通过设计规范对比度/可读性；用户明确批准 |
| 虚拟化 | 性能与滚动/搜索/复制回归 | minimap/搜索/复制/打印不破；无跳变 |

---

## 9. 思考动画保护范围及回归检查清单

### 9.1 冻结文件

| 文件 | 冻结内容 |
| --- | --- |
| `public/thinking-dots.js` | `THINKING_DOT_COUNT`、`PHASES`、`AUTO_CYCLE`（triangle 5500ms / square 15000ms / triangle 26000ms）、`thinkingDots`、`setThinkingDotsPhase`、`startThinkingDotsCycle`、`stopThinkingDotsCycle`、`morph`、`waitForBoundary`、`applyPhase`、reduced-motion 分支 |
| `public/thinking-dots.css` | `.thinking-dots` 布局/尺寸/颜色/透明度、全部 `@keyframes thinking-dots-*`、`[data-phase]`、`[data-transition]`、`[hidden]`、`.working.is-tool-active .working-label`、`.runtime-conversation .rtc-head > .rtc-state .thinking-dots`、reduced-motion 规则 |

### 9.2 冻结调用点

| 调用点 | 冻结行为 |
| --- | --- |
| `public/messages.js:95-157` | `showWorking`/`hideWorking`/`syncToolWorking`/`setStreaming` 的显示时机；`is-tool-active` 只隐藏标签，不停止动画 |
| `public/scroll-button.js:18`、`:55-61`、`:95-102`、`:166` | 运行中显示点组、闲置显示箭头、悬停/聚焦切换、尺寸不变、只滚传入容器 |
| `public/runtime-conversation.js:56`、`:276-279`、`:575-584`、`:1035` | 状态行点组在 starting/running 时显示；idle/历史/审批/错误时停止；切会话 `restart` |
| `public/agent-execution.css:185-210` | `.scroll-bottom` 的点组/箭头显隐与悬停规则 |
| `public/styles.css:613-618` | `.working` 行的布局；不得通过改 gap/padding 影响点组位置 |
| `tests/thinking-dots.cjs`、`tests/ui2-visual.cjs`、`tests/runtime-conversation.cjs` | 现有断言与快照 |

### 9.3 允许与禁止

**允许**：
- 在 Thinking 行**标题文字**中增加字数/状态/实时耗时（不改变点组）。
- 在工具组/轮次终态中新增静态状态行，不引用 `.thinking-dots`、不复用 `thinking-dots-*` 关键帧。
- 使用现有 `--motion-*` 做折叠过渡；不得针对 `.thinking-dots` 后代新增 `animation`。

**禁止**：
- 修改 `AUTO_CYCLE`、点数量、相位切换逻辑、CSS 关键帧、动画时长、颜色、透明度、过渡。
- 在新增组件中创建 `.thinking-dots` 节点或复用其类名。
- 改变 `showWorking`/`hideWorking`/`setStreaming` 的触发时机，或把工具起停接进点组相位。
- 在 `.working`/`.rtc-state` 外包一层会改变布局/裁切的容器。
- 用 `!important` 覆盖 `thinking-dots.css` 的动画/布局。
- 在 `prefers-reduced-motion` 下新增与现有点组冲突的动画。

### 9.4 回归检查清单

| # | 检查 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| T-01 | 点组相位节奏 | `node tests/thinking-dots.cjs` | 开场三点 5.5s → 方阵 15s → 三点 26s；重复调用不重置；`restart` 从开场开始 |
| T-02 | 过渡接缝 | 真实浏览器录屏/动画检查 | 只在循环边界切换；`data-transition` 结束后移除；无跳帧 |
| T-03 | 运行指示 | 发送消息 | 运行中显示；`agent_settled` 隐藏；有工具时只隐藏文案，点组继续 |
| T-04 | 回到底部按钮 | 长会话滚动/运行/悬停/键盘聚焦 | 运行态点组、闲置箭头；hover/focus 换箭头；尺寸 44×44（窄窗 40×40）不变 |
| T-05 | Runtime 状态行 | 空闲/运行/审批/历史/错误/切会话 | 只在 starting/running 显示；切会话重启；不残留上一条会话的相位 |
| T-06 | reduced-motion | 系统偏好 | 动画关闭；静态状态仍可理解；按钮/折叠无过渡 |
| T-07 | 深浅主题 | 两主题截图 | 点组颜色、对比度与基线一致 |
| T-08 | 布局稳定 | 工具起停、状态行出现/消失 | `.thread`/`.rtc-output` 不因点组出现而跳动；Composer 不被遮挡 |
| T-09 | 代码冻结 | `git diff -- public/thinking-dots.js public/thinking-dots.css` | 零 diff（本任务范围内） |
| T-10 | 断言数量 | 测试输出 | 总数不减少；减少时列出少了哪几条并说明原因 |

---

## 10. 证据、未验证项与残余风险

### 10.1 本次审计的证据

- 阅读了两仓库当前源码：pi-GUI `c43fc3f` 的 `public/`、`server/`、`docs/`；PI-Desktop `043d11c` 的 `apps/desktop/src/features/chat/transcript/`、`lib/`、`styles/`、`stores/`。
- 关键结论均带文件:行号；CSS 级联结论按选择器特异度计算。
- 未启动应用、未生成截图、未运行测试。本文所有视觉判断是源码级预测，实际渲染需按第 8 节验收。

### 10.2 未验证项

| 项 | 原因 | 后续 |
| --- | --- | --- |
| Runtime 用户消息“盒中盒”的实际渲染 | 未启动浏览器 | 阶段 1/3 用真实截图与计算样式确认 |
| Runtime 历史 `scrollIntoView` 是否真的滚动祖先 | 需真实浏览器/长历史 | 阶段 2 实测 |
| PI-Desktop TodoDock 的后端持久化与恢复细节 | 只读了 renderer 侧 `api.getTodos`/host 状态 | 不影响 pi-GUI 方案（不采纳 dock） |
| PI-Desktop 子代理拓扑的完整数据契约 | 只读了 `ToolRow`/`SubagentRunRows` 渲染层 | 阶段 4 若采用需另做源码审计 |
| 长会话性能数据 | 未测量 | 阶段 3 |
| 读屏对 `aria-live` 的实际反应 | 未用真实读屏 | 阶段 3 |

### 10.3 残余风险

- **轮次终态与历史兼容**：历史消息没有统一的轮次标记，只能按用户消息/stopReason/时间戳派生；旧会话可能缺时间或状态，必须省略而不是猜测。任何“看起来像完成”的推断都要有测试。
- **重试 DOM 生命周期**：pi 每次重试重发 `message_start/message_end`，错误块/空壳/重试行可能竞争；必须用事件顺序与稳定节点测试。
- **折叠锚点与自动折叠**：O-01 与 O-06 同时存在时，自动折叠可能改变高度；必须让“用户正在阅读/展开”优先，并在同一帧内完成补偿。
- **Runtime 历史用量**：新增投影字段会触及安全边界与历史契约；必须白名单、限量、无自由文本，并保留旧记录兼容。
- **多会话**：任何新状态（轮次终态、书签、展开）都必须按会话隔离；迟到响应只能写所属会话。现有 Runtime 已有 owner/sequence 防护，新增视图态不得绕过。
- **视觉一致性**：本轮只修不一致，不调整整体密度；密度变更需要单独截图与用户决策，避免影响既有视觉验收基线。

---

## 附录 A：任务维度与本文位置

| 用户要求 | 本文位置 |
| --- | --- |
| 会话轮次组织与信息层级 | 3.1.1、5.2、6.1 |
| 连续工具调用的分组、折叠与展开 | 3.1.2、6.2 |
| 工具执行状态、执行耗时及结果预览 | 3.1.3、6.3、6.6 |
| 思考内容折叠与 Token 统计展示（不改动画） | 3.1.4、6.4、第 9 节 |
| Agent 任务清单与进度状态 | 3.1.5、6.5 |
| 流式输出与执行状态同步 | 3.1.6、6.6 |
| 自动滚动、阅读位置恢复、底部跳转 | 3.1.7、6.7 |
| 错误、取消、中断及重试可视化 | 3.1.8、6.6 |
| 排版、间距、信息密度、视觉一致性 | 3.1.9、6.8 |
| 并行工具调用与多会话 | 3.1.10、6.9 |

## 附录 B：PI-Desktop 源码索引（基线 `043d11c`）

永久链接前缀：`https://github.com/vastsa/PI-Desktop/blob/043d11c23d153d9a9088d315bb50d12ebd8283e2/`

| 主题 | 路径 |
| --- | --- |
| 轮次投影/回答分离 | `apps/desktop/src/lib/transcript-projection.ts`、`assistant-turns.ts`、`turn-process.ts` |
| 轮次渲染/父折叠 | `apps/desktop/src/features/chat/transcript/AssistantTurn.tsx`、`TurnProcess.tsx` |
| 活动组/折叠状态机 | `ActivityGroup.tsx`、`ProcessActivityGroup.tsx`、`ActivityItems.tsx`、`disclosure.tsx`、`lib/activity-group-label.ts`、`activity-group-folding.ts` |
| 工具行/详情 | `ToolRow.tsx`、`lib/tool-display.ts`、`tool-presentation.ts`、`components/ToolDetails.tsx` |
| Thinking/用量 | `shared.tsx`（`ThinkingRow`/`MessageMeta`）、`TurnUsageCapsule.tsx`、`components/ContextUsageInspector.tsx`、`features/chat/context-usage/useSessionTiming.ts` |
| 任务列表 | `components/TodoDock.tsx`、`TaskDock.tsx`、`features/chat/todos/useSessionTodosRecovery.ts`、`transcript/PlanHistoryCard.tsx` |
| 流式/状态 | `ChatTranscript.tsx`、`ActivityGroup.tsx`、`stores/slices/transcript-slice.ts`、`events-slice.ts` |
| 滚动/阅读 | `features/chat/transcript/hooks/useTranscriptScroll.ts`、`features/chat/transcript/hooks/useTurnCompletionScroll.ts`、`features/chat/transcript/hooks/useTranscriptHistoryPaging.ts`、`lib/transcript-scroll.ts`、`transcript-reading-position.ts`、`transcript-window.ts`、`transcript-settle.ts` |
| 错误/重试 | `shared.tsx`（`AssistantErrorMessage`）、`components/TurnOutcomeCard.tsx`、`ActivityGroup.tsx`（`RunActivityIndicator`）、`lib/turn-process.ts` |
| 排版/Token | `apps/desktop/src/styles/messages.css`、`chat-shell.css`、`tokens.css` |
| 并行/多会话 | `ToolRow.tsx`（`SubagentRunRows`）、`SubagentDetail.tsx`、`stores/slices/session-slice.ts`、`docs/adr/0329-session-worktree-isolation.md`、`docs/adr/0137-retained-session-panes.md` |

## 附录 C：pi-GUI 源码索引（基线 `c43fc3f`）

| 主题 | 路径 |
| --- | --- |
| Classic 消息/Thinking/错误/历史 | `public/messages.js`、`public/message-meta.js`、`public/state.js`、`public/app.js` |
| 工具模型/视图/历史 | `public/tool-model.js`、`public/tool-view.js`、`public/tool-history.js`、`public/tools.js` |
| 任务列表 | `public/plan-model.js`、`public/plan-view.js`、`public/plan-live.js` |
| Runtime 时间线/存储/渲染 | `public/runtime-timeline.js`、`public/runtime-store.js`、`public/runtime-conversation.js`、`public/runtime-display.js` |
| 阅读/导航/按钮 | `public/scroll-button.js`、`public/conversation-nav.js`、`public/runtime-nav.js` |
| 用量 | `public/usage.js`、`public/runtime-display.js` |
| 视觉 | `public/styles.css`、`public/agent-execution.css`、`public/runtime-conversation.css`、`public/tokens.css` |
| 思考动画（冻结） | `public/thinking-dots.js`、`public/thinking-dots.css` |
| 平行/写租约 | `server/session-tool-scheduler.js`、`server/session-runtime.js` |
| 历史读取 | `server/session-history.js`、`server/session-tool-bridge.js` |

---

**结论**：pi-GUI 不需要再长出一套 PI-Desktop 的会话壳。它需要的是在现有 `ToolEntry`、`plan-view`、`runtime-timeline` 之上补三个“收口”：**轮次终态**、**阅读连续性**、**重试/中断的真实状态**；同时修掉运行中折叠、Runtime 双盒、`incomplete` 颜色这三处已经存在的体验问题。思考动画在整个方案中保持冻结，任何后续实现都按第 9 节逐项回归。
