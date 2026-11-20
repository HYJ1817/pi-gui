# P5-0 三阶段实施计划

目标是让 Classic 和 Runtime 各自在原会话入口呈现相同的任务、Plan、执行活动和最终回答，同时保留原生会话、执行权限和现有动画。按 A → B → C 三阶段交付。后文标为「新增」的是拟建文件。工作还未进入 P5-A。

## P5-0 基线与证据

- `git fetch --tags origin` 后，`HEAD` 与 `origin/main` 均为 `c444b7c8d1df6735bd998d24b111559b99d63e93`，最新 Release 为 v0.34.0。当前分支已有本地系统设置改动。本轮文档落当前工作区，架构审查基于已提交版本核对。未来实施按当时远端、准确提交和工作区状态重新核对。 [发布列表](https://github.com/HYJ1817/pi-gui/releases)
- 当前准确基线的 main CI 已取消。合入 #98 的 PR CI 中计划、UI、faults 及打包完成，core/security/native 被取消、CI gate 失败。前一 main 成功运行是 `66586aa`，其证明仅适用对应提交。进入 P5-A 时按仓库测试政策重新确认可信基线，必要时取得完整基线。 [当前 main CI](https://github.com/HYJ1817/pi-gui/actions/runs/44673633963) · [PR CI](https://github.com/HYJ1817/pi-gui/actions/runs/44671930727) · [前一成功 CI](https://github.com/HYJ1817/pi-gui/actions/runs/44547191813) · [测试执行政策](testing.md#测试执行政策)
- 当前工作树定向夹具：`node tests/runtime-store.cjs` 34/34、`node tests/session-ux-phase3.cjs` 128/128、`node tests/session-ux-phase4a.cjs` 110/110、`node tests/thinking-dots.cjs` 90/90。属于 P5-0 审查证据。纯文档范围未运行完整 `npm test`、产品打包、新 Timeline 视觉测试或模型 E2E。
- 执行前读 [架构契约](session-ux-p5-architecture.md)、[交互规范](session-ux-p5-interaction-spec.md)、[UI 设计系统](ui/design-system.md) 和 [审查准则](../REVIEW.md)，核对共享文件与本地在进行的工作。沿用 ESM、离线 fixture 和现有依赖。涉及写入的验证只用临时 fixture。

## P5-A 执行数据模型与事件适配

**复杂度高。** 决定两条实时输入是否具备同一语义，以及历史恢复的键是否可证明。依赖 RPC 事件合同、Plan v1、session authority、现有 Stop/fallback 证据与 edit/resend 边界。Classic、Runtime fixture 可以在共同契约确定后并行建设；归属、详情字段与 reducer 由同一集成路径验收。

| 工作 | 预期文件与边界 |
| --- | --- |
| 先写两套真实形状 fixture 和期望投影 | 新增 `tests/session-ux-p5-model.cjs`，需要时新增 `tests/fixtures/session-ux-p5-events.cjs`。Classic 使用 RPC stdout envelope；Runtime 使用 registry 安全帧；原生节点保留 nested message body、`id/parentId/leafId`。 |
| 实现共享读模型 | 新增 `public/execution-timeline-model.js`，复用 `runtime-timeline.js` 的内容分段、usage 和预算、`plan-model.js` 的校验、`turn-outcome.js` 的终态语义。对外提供 `createExecutionTimeline(scope)`、`apply(event)`、`mergeHistory(cut)`、`snapshot()`，同步归约且无 I/O/DOM。 |
| 在既有入口接入观察者 | `server.js` 的 Classic 发布口、`server/session-runtime.js` 与 `server/runtime-registry.js` 的 Runtime 投影/owner 入口接入可选归属元数据。新增 `server/execution-timeline.js` 管理归属、受控 native 锚点探测和有界详情缓存。Classic 前端接入 `public/app.js` 和 `public/rpc.js` 身份闸门。Runtime 从 `public/runtime-state.js` 的 `observeRuntimeFrame` 分发，在共用 owner 校验之后、旧 store 游标判断之前接入。P5 的回放请求沿用服务器事件接口，以新代实际起始水位初始化 P5 cursor。先做旁路比对，现有渲染器继续作为用户入口。 |
| 详情与安全投影 | 在 `server/session-runtime.js` 边界前以原工具事实生成安全摘要/详情索引，复用 `tool-model.js` 的已知工具纯逻辑与 `subagent-activity.js` 的绑定白名单。Runtime 接入 `server/runtime-routes.js` 的 scope 化只读动作；Classic 复用现有来源。离线验证入口先启用新读取，P5-B/C 通过权限回归才启用产品路径。 |
| 注册并运行定向验证 | 新套件纳入 `package.json` 的 canonical `test` 链。运行新套件及 `tests/runtime-events.cjs`、`tests/runtime-store.cjs`、`tests/session-runtime.cjs`、`tests/runtime-http.cjs`、`tests/stop-barrier.cjs` 和 P3/P4-A/P4-B 相关夹具。 |

**开工样例。** `prompt p1` → `message_start user U` → `agent_start` → `assistant M1 message_end`（进度文字、toolCall A/B）→ `start A #10` → `start B #11` → `end B #12` → `end A #13` → Plan-only assistant `MPlan`（toolCall P）→ `start P` → `end P`（`gui_plan` result revision 3）→ `assistant M2 message_end`（终答）→ `agent_end` → `agent_settled`。原生历史夹具为 A/B/P 保留各自 toolResult 及 native entry，包含 P 的 Plan details。预期一 turn、用户一次、一个活动组内 A/B 固定顺序、Plan 位于任务头且不重复画 P、M1 过程原文、M2 最终回答。M1、MPlan 和 M2 若均有 usage，三条均在任务账本各出现一次。一轮内重复 `agent_start`、重复 #12 和延迟 #11 应收敛为同一投影。增加同内容 p2、跨会话同 callId、新 generation 从非 1 序号开始的夹具。

**验收。** 相同事实在两端生成等价的层级、归属、结果和状态。能力差异有明确字段。开工样例与无 Plan、Plan 并发、附件、未知 start、旧桥帧、预检失败、Stop、自动 retry/fallback 和后台并行夹具通过。验证 `get_entries` / 原生 leaf 的绑定，包含首次 sessionId 补齐、steer 和编辑；无法证明的入口保留旧视图。跨会话、过期、裁剪和敏感载荷用例证明详情拒绝越权，通用帧/历史摘要仍符合白名单。完成独立功能和安全复审。主要风险是错绑、覆盖真实事件和 Runtime 详情权限扩大。

## P5-B 统一 Timeline UI 与完整交互

**复杂度中高。** 依赖 A 的实体、终态、允许的详情类型与稳定键。固定 snapshot 的交互样例和可访问性验证可并行。两端接入、详情、动画和消息动作需在同一渲染器中集成验证。

| 工作 | 预期文件与边界 |
| --- | --- |
| 实现共享阅读区 | 新增 `public/execution-timeline-view.js`，按 turn/row/response key 更新。组合 `plan-view.js`、`tool-view.js` 的 disclosure 和详情、`subagent-activity.js`、`markdown.js`、`message-meta.js`、`turn-outcome.js`。用户消息体沿用 `messages.js` 的 `userBody` 和附件能力。 |
| 接入两端 | `public/messages.js`、`public/runtime-conversation.js` 分别挂载同一模型。保留输入回声、编辑重发、搜索、补充输入、审批、状态行及最终回答动作。将 usage 归到任务唯一入口，引用原数据。 |
| 密度、主题、阅读控制 | `public/agent-execution.css` 优先承接共享布局规则，核对 `styles.css`、`runtime-conversation.css` 的实际选择器。复用 `reading-position.js` 和已有的工具/计划展开控制，保持导航锚点。动画文件及调用宿主纳入冻结检查。 |
| 验证与产物 | 新增 `tests/session-ux-p5-ui.cjs` 并纳入 canonical。扩展离线 `tests/visual-harness.cjs` 取桌面 Chromium/Electron 证据，运行 P1–P4、UI2、Thinking、usage、编辑和 Runtime UI 定向回归。以 `npm run build:app -- --rebuild` 或适用产物入口重建。 |

**验收。** 两端使用同一组件树，呈现任务一次、真实 Plan、紧凑活动及既有最终答复。长任务开合、附件、组和行详情、失败、等待、中断、子代理、多模型及 Plan-only usage 覆盖键盘操作和视觉。窄窗 700×600、宽窗约 1320×820 深浅四组各记录实际 CSS 视口/DPR、字体放大、reduced motion 和对比度。活动增量保持组、焦点和上翻位置。检查 `git diff --exit-code <baseline> -- public/thinking-dots.js public/thinking-dots.css`、调用点逐项对照与 `node tests/thinking-dots.cjs`，以录像或帧和状态断言验证原触发及节奏。既有统计、消息动作及加载、受限反馈可用。主要风险是 wrapper 破坏流尾、锚点与 CSS，以及异步更新丢失焦点或展开状态。

## P5-C 历史恢复、多会话与整体验收

**复杂度高。** 依赖 A 的持久键和读权限、B 的节点映射。服务端恢复 fixture、视觉和性能基准可并行准备；端到端恢复、权限和发布候选验收需要同一构建。达到本阶段门槛后将新时间线作为两端默认视图。

| 工作 | 预期文件与边界 |
| --- | --- |
| 落盘和权威历史读取 | 新增 `server/execution-timeline-store.js`，由 A 的观察者写入有界分支元数据。用 `server/session-history.js` 安全读取、`server/session-edit-target.js` 的 branch path 和 `server/runtime-routes.js` 的只读目标核验。保留旧 API 兼容。 |
| 接入重连和多会话 | `public/runtime-recovery.js`、`public/runtime-store.js`、`public/rpc.js` 和 A 观察者接入 owner/branch/cut 合并。`public/reading-position.js`、`public/conversation-nav.js`、`public/messages.js`、`public/runtime-conversation.js` 接入分块、定位、稳定展开键与别名。P4-E 继续消费已有确认终态。 |
| 故障注入、视觉和性能 | 新增 `tests/session-ux-p5-recovery.cjs` 并纳入 canonical。覆盖断电、损坏元数据、回放缺口、历史裁剪、快速切换、版本不符、Stop 和编辑竞态。复用 `tests/session-ux-phase4d-perf.cjs`，在同机、同负载的准确 baseline 与 P5 构建间对照，主要场景至少 5 轮。 |
| 发布候选验证 | 由当次本地 `npm test` 或用户预先选择的对应完整 PR CI 提供 canonical。重建产物，运行离线产品验证，记录差异、断言数、跳过项、截图、耗时分布、独立功能/安全和故障注入审查。 |

**验收。** 同一 native branch 的同一任务，在 live、SSE 断线重连、刷新、切会话、进程重启及只读历史中恢复相同的已证实结构和原始统计。旧记录或被截断记录按 legacy/局部展示，过期响应不改变其他会话。P4-D 同夹具 829/1653 条消息、20 次连切和定位场景，建议同步段 p95 低于 100 ms 且较同机基线回退不超过 10%，全页就绪中位数回退不超过 10%。千条活动 fixture 证明收起无详情 DOM、展开只挂载有界窗口，记录首个展开帧耗时。折叠、展开及异步详情挂载后，静止视口在两个可比渲染帧内的锚误差不超过 2 CSS px，原有自动跟随和用户上翻仍成立。P4-E 后台通知次数及 P4-D 页外定位反馈通过。完整 canonical、产物和审查证据达标后记录验收。主要风险是分支证据不足、回读覆盖 live 与长会话同步渲染反弹。

## 跨阶段验证矩阵

| 场景 | 检查结果 |
| --- | --- |
| Classic / Runtime、单工具、零工具 | 两端同层级。零活动省略组，单工具有组和一条记录，答复仍可读。 |
| 并行、长运行、等待、多模型、子代理 | 行按开始顺序；独立状态、墙钟和真实模型；子项混合终态与 unknown 回退。 |
| 重试、失败、异常退出、用户 Stop | 一次权威终态；保留失败尝试及部分答复；自动 retry 留在当前任务，UI 重交按证据另起分支或任务，Plan 只使用真实状态。 |
| 多会话、重复、乱序、owner 换代 | 相同 call ID、相同消息文本和跨项目同名文件皆隔离；重放不触发副作用，新旧游标相互独立。 |
| 历史截断、恢复、原生分支、编辑重发 | 消息、工具、Plan、usage 有权威引用；非当前分支不污染读取；缺起点、详情和终态有一致提示；损坏与回读竞态不会误绑定。 |
| 高密度、主题、可访问性 | 性能上限、稳定焦点、对比度、尺寸、字号和 reduced motion 达标，P1–P4 行为通过。 |

## 回滚边界

A 可从现有发布/路由入口卸下观察者和新增读取动作。B 可由旧 Classic 和 Runtime 渲染器接管同一会话。C 可关闭 pi-GUI 元数据索引读写，保留它供后续诊断，并继续读取 Pi 原生会话。回滚和恢复验证使用临时会话夹具，执行授权和会话事务继续由原所有者管理。
