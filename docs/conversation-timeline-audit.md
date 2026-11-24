# 会话时间线源码对照审计与目标设计

## 审计基线（2026-11-23）

- pi-GUI：`6b38415c59a4818177fa706bb3e6086af0e802be`，与当时 `origin/main` 相同。准确基线 CI：[45136803834](https://github.com/HYJ1817/pi-gui/actions/runs/45136803834)，attempt 2，完整 test plan / native / security / faults / core / ui / Electron build / gate 成功。
- 工作区另有附件功能未提交修改，不能把 HEAD 的 CI 当作它们的证明。本任务开始实现前保存了源码快照和原有 diff；原有 diff 的 SHA-256 为 `fd85c658fa31852ae2b776fcd7b01313bed814e8518f93f89757c64102045869`，不清理或覆盖附件工作。
- 当前工作区定向基线：smoke **1337/1337**、Agent execution UI **221/221**、Runtime conversation **110/110**。P5 基线见后续验收记录；jsdom 不证明布局。
- T3 Code：固定提交 [`1e088be4b5dc15ca3dd66fa01c6f2e035511a827`](https://github.com/pingdotgg/t3code/tree/1e088be4b5dc15ca3dd66fa01c6f2e035511a827)。读取实际 Git blobs，未执行参考项目、安装依赖或以 README / 截图代替源码审计。
- Playwright **1.57.0** 使用本机既有安装和 Chrome；首次默认 headless-shell 路径不可用，改用已安装 Chrome，未下载浏览器。页面加载真实 `public/index.html`、实际 CSS 和生产模块；所有 API 由现有离线 visual harness 提供，上传目录、浏览器状态和证据均在独立系统 TEMP fixture 内。

## 一、T3 Code 的实际实现

以下行号固定上述参考提交，不是对第三方库内部实现的推测。

| 职责 | 实际源码 | 可借鉴的结构 / 行为 |
| --- | --- | --- |
| 活跃聊天入口 | `apps/web/src/components/chat/ThreadTimeline.tsx:14–58` | `ChatView → ThreadTimeline → MessagesTimeline`；流式正文按 assistant 行订阅，避免整页重画 |
| 只读入口 | `apps/web/src/components/chat/ReadOnlyThreadTimeline.tsx:40–132` | Guest / LinkedThreadPane 仍用同一 MessagesTimeline，不是第二套排版；写入动作不提供 |
| 有序投影 | `apps/web/src/session-logic.ts:71–160,595–745` | `visibleTurnItems → TimelineEntry[]`，消息与 work 在同一顺序中；稳定 messageId / item.id |
| 连续工作组 | `apps/web/src/components/chat/MessagesTimeline.logic.ts:2061–2210` | 连续 work 且同 run / attempt 才合组；消息、审批、错误、compaction 等边界中断分组；key 取第一条 entry.id |
| 已结束回合折叠 | `MessagesTimeline.logic.ts:1180–1229,1691–1731` | 保留最后 assistant 正文，中间正文和工作记录折叠；待审批、运行中、失败 / 中断有例外 |
| WorkLog 密度 | `apps/web/src/components/chat/WorkLog.tsx:24–185`、`TimelineRowParts.tsx:14–42` | 行 `min-h-6 text-sm leading-relaxed gap-1.5`；组内 `py-0`，独立行 `py-0.5`；图标槽 24px、图形 16px；普通行不依赖实底 hover |
| Thinking | `TimelineWorkEntryRow.logic.ts:205–220`、`TimelineWorkGroupRows.tsx:631–679` | Thinking 是 work，不是新助手气泡；有界预览 / 折叠，完整 trace 可检视 |
| 工具详情 | `TimelineWorkEntryRow.tsx:698–737` | 详情默认不挂载，展开后呈现；按 source item / revision 获取大输出，Loading / Error / No output 分开 |
| Plan | `MessagesTimeline.logic.ts:949–963`、`ProposedPlanCard.tsx:59–94,170–241` | 独立顶层 Plan，不藏入工作 fold；长内容裁高和展开，不把工具次数当进度 |
| Usage | `TimelineAssistantRows.tsx:222–280`、`threadDetailsItems.ts:28–55` | 不是每条 assistant 下反复摆 token footer；线程详情默认关闭 |
| 跟随 / 阅读 | `timelineViewport.ts:222–283`、`timelineScrollTarget.ts:1–31` | following 与 released 分离；流式增长造成短暂离底不代表用户导航，内层可消费滚轮时不释放外层 |
| 披露锚定 | `MessagesTimeline.tsx:510–600` | 取消旧滚动，按触发行 key 锚定；只做最小必要补偿，避免把触发行推过顶部 |
| 恢复位置 | `useTimelinePositionRestore.ts:8–149` | row ID + 行内偏移，丢 ID 才退到绝对 offset；两帧稳定即结束、最多 60 帧、用户导航取消 |
| 外层虚拟化 | `MessagesTimeline.tsx:878–902,1640–1651` | 非空态使用 LegendList，估高 90；长消息按自身 ID 隔离高度统计，选择 / 恢复 / 音频 / 全屏行可 pin |
| 内层虚拟化 | `TimelineWorkGroupRows.tsx:188–347` | 仅展开且非纯 reasoning 组；估高 24、drawDistance 240、详情高度补入；只有真实 append 且原先贴底才跟随 |
| 锚算法 / 缓存 | `packages/client-runtime/src/work-log/scrollAnchor.ts:1–33`、`ChatView.logic.ts:354–415`、`timelineScrollAnchoring.ts:115–151` | 按布局 top 二分定位 rowId + offset；timeline 缓存 16 线程，位置 / disclosure 缓存 100 线程；增量投影复用引用 |

样式说明：T3 的入口实际加载 Inter / `index.css`，后者导入 Tailwind 并映射语义色。24px / 28px / 14px 是源码默认 root 字号的解释，不冒充参考产品的 computed-style 实测。LegendList 声明为 3.7.3；参考仓库补丁不是 Web 高度索引实现，未声称审计该依赖内部。

许可：根 `LICENSE:1–21` 为 MIT，版权 **Copyright (c) 2026 T3 Tools Inc.**。本任务借鉴展示组织和算法原则，以 pi-GUI 现有原生模块独立实现，不复制 React 组件、后端 schema 或第三方虚拟器。直接复用 / 实质移植源码时必须随分发保留其版权和完整 MIT 声明；字体、图标与依赖须分别核对许可，MIT 不授予品牌使用权。

## 二、pi-GUI 现有抽象与回退根因

### 合适的抽象应继续复用

- `messages.js`：原生消息权威收尾、contentIndex 流式块、Thinking 节点复用、消息编辑 / 重新生成、分块历史挂载。
- `tool-model.js / tool-history.js / tool-view.js`：真实 ToolEntry 配对、开始顺序、语义适配器、安全详情与增量更新。
- `plan-model.js / plan-view.js / plan-live.js`：真实 gui_plan 契约、稳定任务 ID、session 级 settled 边界。
- `runtime-store.js / runtime-timeline.js`：已验 owner / sequence 的单一事实源与有界只读投影；不替换生命周期。
- `execution-timeline-model / adapter / state / view`：可选的 P5 归属证据与已验证回合；不是全量 UI 的唯一入口。
- `message-meta.js`：白名单数字、缺字段不补零、reasoning 含在 output 中、成本不编货币。
- `reading-position.js`：内存书签、稳定锚点、当前容器专属的披露补偿；已有 Classic 长历史分块和 P5 40 项窗口。

### 为什么统一时间线仍会回退

`executionTurnForInput()` 只接受绑定 session、正确 source、live domain、verified / complete 和匹配 input sequence。Classic 还核对实际工具节点、附加输入数量、Plan；历史核对原生范围、entry IDs、tool/result 配对和 session / leaf。Runtime 再用 store 的 executionWitness 验证 block / tool 的归属和覆盖。

因此旧协议、无 session 的首帧、部分覆盖、截断或不完整恢复必然退到原生 renderer。这是安全设计，不是应被删除的障碍。**只美化 P5 会让真实会话反复回到旧版排版。**

### 已确认的问题

| 编号 | 代码路径 / 原因 | 实际证据 |
| --- | --- | --- |
| C1 | `messages.js` 的 live / history 每条可见 assistant 都生成 Pi；Runtime 每个正文 block 的伪元素同样显示 Pi。P5 采用原节点，“执行过程”展开仍带入标签 | 8 个 Classic / Runtime、实时 / 历史、verified / fallback 场景均有 **3 个可见 Pi** |
| C2 | native tools 按 assistant 消息分组；`styles.css` 的边框、result 第二行、26px 详情按钮和组 metadata 行叠加 | Classic fallback 工具行 **53.97 / 54.97 / 53.97px**；P5 行 **28.19px**；fallback 两张描边卡 |
| C3 | 原生 assistant footer / Runtime thinking-wrap / tool-wrap 各有独立 usage；P5 又把 activity / progress / thinking 分为类别槽位 | Classic fallback 三条外露 metadata；两段 thinking / 工具与最终正文割裂 |
| C4 | `messages.js:276–284` 的贴底 rAF 仅检查 threadGeneration，没有检查后续用户导航 | 排队后用户 scrollTop **250**，下一帧变成 **28,928** |
| C5 | `runtime-conversation.js` 工具签名变化后 `wrapper.replaceChildren()` 重建组头和工具行 | 聚焦组头后 tool end：旧按钮 `isConnected=false`，焦点不再在原按钮 |

普通 streaming probe：从距底 0px 开始，50 段追加后仍距底 **0px**。这是正常基线，不将代码疑点误报为已复现缺陷。

改造前展开内容跨度（1320×820，真实 CSS，单位 px）：Classic live fallback **1033.64**、verified **830.88**；Classic history fallback **889.52**、verified **696.45**；Runtime live fallback **851.80**、verified **820.84**；Runtime history fallback **762.84**、verified **640.42**。这些是同一 fixture 的页面差异，不是 T3 产品基准或模型运行耗时。所有场景横向溢出 0、pageerror 0。

## 三、最终目标设计（先于实现确定）

1. **两个阅读层级**：User 保持原气泡与原编辑 / 附件；最终 / 部分回答使用无角色重复的开放 Markdown 正文。屏幕阅读器身份保留，不把“隐藏标签”当作取消角色语义。
2. **紧凑工作记录**：已验证回合把工具与中间说明按真实位置交错到一个 work log，保留 Plan 顶层、最终回答外露；原生回退同样使用紧凑展示。原生仅按实际有序显示片段组合，不产生新的 execution turn、run / attempt 归属或成功结论，不跨 User / Plan / 错误 / 中断边界擅自合并。
3. **单行工具**：图标、短摘要、明确状态、必要耗时；初稿目标基础行高 28–32px，实施后按 T3 `WorkLog` 的 `min-h-6` 语义校准为 24px，放大字号可自然增长。路径 / 命令在摘要省略、展开可换行和检视；输出内部限高滚动。正常成功不另占结果预览行，失败不藏在成功标签中。
4. **一层披露优先**：工作组只提供一行汇总；已有工具详情仍由 ToolEntry 提供，不套新卡片。Thinking 默认折叠且复用原节点，流式 / 收尾 / 切换不覆盖手动选择；完成用量放一个低优先级区域，真实字段仍可达。
5. **Plan 连续但不混为工具**：保留原任务状态和计数，与工作行对齐，减少外框 / 留白；不从工具数量推断计划进度，也不隐藏待审批或 Stop。
6. **滚动归用户**：合并过期贴底请求，检查后续用户导航；保留已有流式限流。切会话 / 恢复优先稳定行 ID + 偏移，丢锚回退绝对位置；披露只补偿所属 scroller，不滚 Composer / 祖先。回底行为可取消，复用而不改变 thinking-dots 动画。
7. **先复用既有长列表能力**：保留 Classic 800 条阈值的分块挂载、P5 40 活动页和有界 Runtime；本轮不引入 LegendList / React。用 2,000 项活动和长历史、流式 / 焦点 / 展开测量判断是否需要进一步虚拟化，不能仅凭 T3 使用它就引入新架构。
8. **权限不扩张**：Classic 仅展开已拥有的 ToolEntry 安全详情。Runtime 普通事件 / 历史不包含原始 args / output；现有 `readExecutionDetail` 是后端验证内部能力，未向前端开放。受限 / 未返回 / 不可用如实显示，不新增网络接口、恢复 raw JSON 或绕过 owner / branch 守卫。

## 四、验证与冻结边界

- 新增定向回归纳入 `npm test` 的唯一链：多消息连续工具、failed / interrupted / waiting、thinking、native fallback / P5、历史、长列表、流式增量、焦点、阅读锚与用户导航取消。
- Playwright 真实生产页面矩阵：Classic / Runtime，live / restored，verified / fallback，1320×820 / 700×600，dark / light，中英长文本、键盘 / pointer / focus、展开和失败；实际字体、行高、溢出、对比度与截图。
- 验证前后必须核对断言数量；任何旧布局预期的更新说明目标行为，不删除行为断言或隐瞒首次失败。稳定后完成一次 canonical `npm test`，独立审查实际 diff，并重建本机产物。
- 冻结 `thinking-dots.js`、`thinking-dots.css` 与现有动画视觉 / 时序；用基线 digest 证明未改。输入框、附件功能、独立页面、Pi、session schema、审批 / Stop / 编辑事务和后台执行不重做。
- 本文件是**实施前审计与设计**，不等同于开发完成、验收通过、合并许可或发布许可。最终命令 / 数字 / 截图 / 未验证项另见验收记录。

## 五、实施后校准（2026-11-24）

- T3 对照截图复核后，工作行采用 24px 行高、24px 图标槽 / 16px 图形、14px 次级文字；成功行不显示绿点或「已完成 0.5s」，失败与未完成靠图标颜色与可访问状态表达。
- 运行中 / 等待 / 失败 / 中断的工作组默认展开，仅成功且已结束的组默认折叠；这与 T3 活动组展开的语义一致，也是对本文「保留最后正文」原则的实现细化。
- 终态行只对停止 / 失败 / 未完成保留，完成轮次不额外占行；逐条 token 摘要退为 hover / focus 背景，已验证回合保留一个折叠用量入口。
- 最终数值、截图、测试与产物证据见 [conversation-timeline-acceptance.md](conversation-timeline-acceptance.md)，不以本文的初稿目标值代替实测。
