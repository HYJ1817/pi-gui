# Conversation 展示重构验收材料

> 本文件保留上一轮（工作记录与紧凑展示）的验收记录。2026-11-24 收尾轮在基线
> `37c58e27` 上完成耗时折叠与细节修复，源码对照、实际测试、截图与剩余风险见
> 文末「2026-11-24 收尾轮」；那一节不改变上一轮已核验的历史结论。

- 目标：在不引入 React、不照搬 T3 Code 后端的前提下，把连续思考 / 工具 / 中间进展呈现为 T3 Code WorkLog 式的紧凑工作行，并让 User、Plan、最终回答和轮次终态保持独立层级；Classic 回退与 Runtime 已验证路径共用同一套展示。已交付源码、定向测试、真实 Chrome 矩阵、离线打包产物。未交付：完整 canonical 通过、独立代码审查结论、真实模型会话、Agent 启动打包窗口的实际交互。
- 身份：分支 `feat/compact-attachments`；起点 HEAD `a315b46e48f4ce6d3dad720f72731fd9241596ed`；展示代码提交 `5a0e87e1`，测试与注册提交 `461eb770`，两者已推送至 `origin/feat/compact-attachments`。本验收材料随文档提交推送；未合并、未打 tag、未创建 PR、未发布。
- T3 Code 对照基线：固定提交 [`1e088be4b5dc15ca3dd66fa01c6f2e035511a827`](https://github.com/pingdotgg/t3code/tree/1e088be4b5dc15ca3dd66fa01c6f2e035511a827)，审计结论见 [conversation-timeline-audit.md](conversation-timeline-audit.md)。本轮按该提交的 `WorkLog`、`TimelineWorkEntryRow`、`MessagesTimeline.logic.ts` 结构独立实现，不复制 React / 后端代码；新增图标来自 Lucide（ISC）并在 `public/ui/icons.js` 就地注明来源。
- 修改范围：`git diff --stat` 为 29 个已跟踪文件、1357 insertions / 432 deletions；另有 6 个新增代码 / 测试 / 文档文件，已随本轮提交纳入版本库。
  - 展示归并与分类：`public/conversation-work-log.js`（新）、`public/ui/work-presentation.js`（新）
  - Classic / Runtime：`public/messages.js`、`public/runtime-conversation.js`、`public/tool-view.js`、`public/execution-timeline-view.js`、`public/classic-execution-view.js`、`public/tools.js`、`public/conversation-nav.js`
  - 选区与操作条：`public/ui/text-selection.js`（新）、`public/reading-position.js`、`public/ui/message-actions.js`
  - 样式与图标：`public/agent-execution.css`、`public/styles.css`、`public/runtime-conversation.css`、`public/ui/icons.js`
  - 测试：`tests/conversation-flow.cjs`（新，18 个用例），以及 `smoke` / phase1–4 / P5 / ui2-classic / ui2-visual / agent-execution-ui / agent-execution-visual 的断言适配
  - 文档：`docs/conversation-ui.md`、`docs/conversation-timeline-audit.md`（新）、`docs/README.md`、本文件
  - `package.json`：注册 `test:conversation-flow`
- 最终展示规则：
  - 工作行 24px 高；24px 图标槽内 16px 图形；14px 次级文字；6px 间距；行尾折叠箭头。成功行不画绿点、不重复「已完成 0.5s」；失败 / 未完成用图标颜色与可访问状态表达；耗时 hover / 键盘 focus 时显示。
  - 记录头显示动作摘要（读取 N 个文件 · 搜索 N 次 · 运行 N 条命令 · 思考 N 次）与首个动作图标；真实工具次数与运行 / 失败状态保留在 DOM 和可访问名中，不宣称任务成功。
  - 运行中 / 等待 / 失败 / 中断的工作组默认展开；仅成功且已结束的组可折叠。用户显式选择优先，并按模式与会话记忆。
  - Thinking 使用脑图标 + 首行预览；完整状态（生成中 / 已完成 / 已中断 / 已截断）仍在可访问文本中。中间进展正文与最终回答同为 14px，靠次级颜色区分。
  - 完成的轮次不再额外占一行；停止 / 失败 / 未完成保留一行 24px 终态文字，统计数字仍在 DOM 中。逐条消息 token 默认不占视觉层；已验证回合保留一个低优先级折叠「用量与耗时」入口。
  - 用户补充输入始终可见；Plan、错误、审批、Notice、compaction、User 和最终回答是工作记录的硬边界。
- 行为边界：
  - `conversation-work-log.js` / `work-presentation.js` 只做展示分类与摘要，不创建 run、attempt、owner、成功或授权证据；P5 的 `[data-execution-turn]` 不被再次包裹。
  - Runtime 受限投影继续隐藏工具原始参数与输出；没有扩大任何读取权限，没有新增网络请求、依赖、服务端或 Pi schema 改动。
  - 文本选区只保存在 DOM Range；阅读位置继续按稳定 ID + 视口偏移恢复，不写入偏好、日志或会话文件。
  - `thinking-dots.js` / `thinking-dots.css` 未修改：SHA-256 分别 `e38d9a69fce2db53bf8db22f9fa2d0b4c42a1c1331aeb72a7f5183263a837e03` 与 `29c72645a4a9f6cfc81f77dbd0f83682c017ba800b9cb0927c6279c8a15f722c`，与 HEAD 相同。
- 风险：中（常规展示 / 焦点 / 选区 / 历史渲染）。不涉及凭据、文件写入、安装更新、执行权限或上游协议。按 REVIEW 需要独立复审；本轮独立审查仍被供应方 429 配额阻断。

| 证据层 | 命令 / 场景与代码状态 | 环境、退出码与实际结果 | 证据位置 |
| --- | --- | --- | --- |
| 作者定向测试 | 最终工作区代码上的受影响套件 | `conversation-flow` 18/18；`agent-execution-ui` 221/221；`agent-execution-visual`（Electron）28/28；`ui2-classic` 55/55；`ui2-visual`（真实 Chrome）57/57；`smoke` 1339/1339；`session-ux-phase1` 81/81；`phase2` 98/98；`phase3` 128/128；`phase4a` 110/110；`phase4b` 108/108；`phase4d` 14/14；`phase4e` 60/60；P5 view 6/6、UI 17/17、runtime 1/1、persistence 9/9、recovery 8/8、classic-history 1/1、runtime-recovery 3/3；`ui2-runtime-display` 83/83；`runtime-ui` 16/16；`runtime-conversation` 110/110；`thinking-dots` 90/90；`message-edit-ui` exit 0。断言总数没有减少；skip 不计入分子。 | 各套件直接运行；本轮没有把 jsdom 结果当作布局证明 |
| 真实浏览器矩阵 | `probe-matrix.cjs`：Classic / Runtime × verified / fallback × live / history × 1320×820 暗色；另加 2 个亮色、1 个 700×820 窄窗、1 个 `--font-scale:130%`，共 12 个场景 | 12/12 完成；pageerror 0；页面 / 根横向溢出 0；每场景 5 条可见工作行；普通行 24px / 14px，字体放大行 29.13px / 18.2px；可见状态元素均为 1×1 裁切文本；可见重复角色标签 0（`你` 亦为 1×1 裁切）；逐条 meta 可见数 0；记录摘要均来自真实动作。 | `%LOCALAPPDATA%\Temp\pi-gui-conversation-20261123-b582c14d\t3-matrix\`；`report.json`、`*-default.png`、`*-expanded.png` |
| 截图人工对照 | 与 T3 Code 截图并排检查 Runtime verified 暗 / 亮 / 700px、Classic fallback、Runtime verified history | 工作行图标、字号、行高、箭头位置与 T3 WorkLog 对齐；没有独立卡片、重复状态后缀或大块空白；历史中空参数行的箭头也已回到行尾（修复了 `.execution-activity-facts:empty` 丢失弹性占位）。 | 同上；代表截图 `runtime-verified-live-dark-expanded.png`、`runtime-verified-live-light-expanded.png`、`runtime-verified-live-dark-narrow700-expanded.png`、`classic-fallback-live-dark-expanded.png`、`runtime-verified-history-dark-expanded.png` |
| 本地完整 canonical | `npm test`，2026-11-24 00:07:04 启动，起点代码 | **未通过（无关套件）**：exit 1，约 30.8 分钟；`tests/provider-config-store.cjs` 所在套件 184 通过 / 3 失败（`prepareCredentialStorage...` / “normal machine must qualify for native key input”），与本轮 diff 无关。用户明确「失败也别重跑了」，因此没有重跑；本文件不把定向结果冒充完整 canonical。最终 CSS / 文档改动晚于该次 canonical，未经 canonical 覆盖。 | `%TEMP%\canonical-final.txt`（344,131 bytes） |
| 独立审查 | 最终 diff + 未跟踪新文件 | **未运行（环境配额）**：两次尝试均返回 HTTP 429 `Devin: usage limit reached ... deepseek-v4-flash`；没有切换供应方或模型，也没有产生审查结论。 | 会话错误记录 |
| 打包产物 | `npm run build:exe`；`PI_GUI_ELECTRON_ZIP_DIR=<本机 Electron 44.4.3 缓存> npm run build:app -- --rebuild`；离线，无下载 | 均 exit 0。`build/Pi GUI.exe` 106,609,152 bytes，SHA-256 `86837c80a8d73bef21f9a9a6533c5df140807dc4f998ff85ff132f4aa2560ca6`；SEA 清单包含 `public/ui/work-presentation.js`、`public/conversation-work-log.js`、`public/ui/text-selection.js`。`dist-app\Pi GUI-win32-x64` 整包 335.4 MB，入口 `Pi GUI.exe` 246,324,736 bytes，SHA-256 `71b9ed5105a31ad944f82376b0e66ea8b147068aafb16330a556f44bebe5a19f`。 | `build/Pi GUI.exe`；`dist-app\Pi GUI-win32-x64\Pi GUI.exe`；`build/asset-manifest.json` |
| 产物内容一致性 | 打包内 `public/` 与源文件逐字节比较 | `agent-execution.css`、`styles.css`、`execution-timeline-view.js`、`conversation-work-log.js`、`work-presentation.js`、`icons.js`、`tool-view.js`、`messages.js`、`runtime-conversation.js` 全部 MATCH；源文件 SHA-256：`agent-execution.css` `491d7bb73ea05141ffdeead49f7d8d0edce19a9c19ad6ac9a39a82e767c55975`，`styles.css` `9cded131c6ccfaa859ea93bf416d73fc67e99f8eaaff2b952a6480ae62dfd0b5`，`work-presentation.js` `a3686f747abcedf9f4a3b7ce1dcd0a670cae4a5a28e6ce0cda6ee1c9dde257bd`，`conversation-work-log.js` `f52a84fc8c218a7a45ee7ede392bbbbad2206f88f532bb4e5d8a035d4d7c35a4`。 | 同上 |
| Git 交付 | 展示代码 `5a0e87e1`、测试与注册 `461eb770`、文档与验收材料（本条文档提交） | 前两者已推送至 `origin/feat/compact-attachments`；文档提交随本次推送。未合并、未打 tag、未创建 PR、未发布。 | `git log --oneline -3`；`git status -sb` |
| Electron 实际交互 | 未由 Agent 启动打包窗口 | **未验证（未运行）**：只完成打包、清单与逐字节核对；按用户口径，最终以实际打开构建产物体验验收。 | 不适用 |
| 真实模型 / 真实数据 | 未运行 | **未验证（未运行）**：没有授权模型调用、真实项目写操作或安装升级；fixture 结果不代表真实模型性能。 | 不适用 |

- 断言适配说明（均为目标行为变化，不是隐藏失败，断言总数未减少）：
  - 工具行最小高度 30px → 24px：`ui2-visual` 同步目标值。
  - 运行中 / 失败的工作组默认展开：`conversation-flow`、`session-ux-p5-view`、`session-ux-p5-runtime`、`session-ux-p5-ui`、`agent-execution-visual` 改为「仅折叠时点击展开」；`agent-execution-visual` 还验证了故障工作记录的摘要与展开。
  - Plan 不再套独立卡片背景：`agent-execution-visual` 改查阅读面背景与透明卡片，保留文字和运行态断言。
  - 用户补充输入不再折进工作记录：`session-ux-p5-ui` 改为断言始终可见，并继续验证导航落点。
  - usage 文案沿用产品既有 `推理`（Pi `Usage.reasoning` 是输出子集）：`agent-execution-visual` 更新期望。
  - 未完成工具继续使用虚线圆图标：修复 `tool-view.js` 在改用动作图标后丢失的非颜色状态线索，`smoke` 1339/1339。
- 本轮修复：
  - 工作记录接管后，原生组头隐藏造成 `execution-activity-facts` 为空时右侧箭头贴到标题；已保留空弹性占位，历史行箭头统一回到行尾。
  - 消息操作条原先为每条消息预留 26px 高度，形成明显空白；改为 hover / focus 浮出，同时保留原按钮、焦点和复制反馈。
  - 记录摘要的图标 / 文案与行内状态分离：摘要只宣称动作与数量，不宣称成功。
- 限制与残余风险：
  - 完整 canonical 未通过，失败点与本轮无关；用户明确不重跑。会话展示证明来自定向套件、Electron 视觉套件与真实 Chrome 矩阵。
  - 独立代码审查未运行（429）；按项目规则不能宣称代码审查已通过。
  - 未由 Agent 启动打包窗口或真实模型会话；最终体验与验收由用户以构建产物完成。
  - jsdom 不做布局；布局结论只来自真实 Chrome / Electron 截图与测量。
  - 打包已核对内容一致性，但未验证签名、安装器或自动更新链。
- 回滚：回退 29 个已跟踪文件并删除新增的 `public/conversation-work-log.js`、`public/ui/work-presentation.js`、`public/ui/text-selection.js`、`tests/conversation-flow.cjs`、`docs/conversation-timeline-audit.md`、本文件；删除或重建 `build/`、`dist-app/` 可恢复旧产物。回滚不涉及用户会话、凭据或 Pi 安装。
- 结论：实现与定向验证 **完成**；完整 canonical **未通过（无关凭据套件）**；独立审查 **未运行**；Git 提交与推送 **已按用户指令执行**；合并 / 发布 **未授权且未执行**。

## 2026-11-24 收尾轮：T3 耗时折叠与细节修复

- 身份：分支 `feat/compact-attachments`，基线 `37c58e27`（上一轮展示代码 `5a0e87e1`、测试注册 `461eb770` 已在此基线上）。本轮交付源码、测试、真实 Chrome / Electron 验收、打包产物与文档；**未合并、未打 tag、未发布**。提交与推送按用户指令执行，推送后由 PR 流程补完整 CI。
- T3 Code 对照基线：固定提交 [`1e088be4b5dc15ca3dd66fa01c6f2e035511a827`](https://github.com/pingdotgg/t3code/tree/1e088be4b5dc15ca3dd66fa01c6f2e035511a827)。本轮直接读取 `MessagesTimeline.logic.ts:506,1180–1313,1238–1271,1243–1253,1193–1221,1276–1310,1691–1731,1963,2103`、`WorkLog.tsx:24–185`、`TimelineRowParts.tsx:14–42`、`TimelineWorkGroupRows.tsx:188–347,631–679`、`TimelineAssistantRows.tsx:222–280`；对照结论已写入 [conversation-timeline-audit.md](conversation-timeline-audit.md#六耗时折叠实施后校准2026-11-24)。未执行 T3 仓库、未安装其依赖、未复制 React 组件或后端 schema。
- 修改范围：21 个已跟踪文件（10 个 `public/`、7 个测试、`package.json`、3 个文档）；另新增 `public/ui/turn-fold.js`、`tests/turn-fold.cjs`、`tests/conversation-work-fold.cjs`，共 24 个文件。`git diff --stat` 为 1378 insertions / 279 deletions（不含新增文件）。`package.json` 只把两个新套件加入唯一 `test` 链，没有第二份测试清单。
  - 展示：`public/ui/turn-fold.js`（新，纯标签 / 计时）、`public/execution-timeline-view.js`（已验证分段折叠）、`public/conversation-work-log.js`（原生折叠头）、`public/ui/work-presentation.js`（摘要分类）、`public/classic-execution-view.js`（补充输入与最终回答中的 Thinking）
  - 计时与回退：`public/messages.js`、`public/runtime-conversation.js`、`public/runtime-store.js`、`public/runtime-timeline.js`
  - 样式：`public/agent-execution.css`、`public/styles.css`
  - 测试：`tests/turn-fold.cjs`、`tests/conversation-work-fold.cjs`、`tests/conversation-flow.cjs`、`tests/agent-execution-ui.cjs`、`tests/session-ux-p5-view.cjs`、`tests/session-ux-p5-ui.cjs`、`tests/session-ux-p5-runtime.cjs`、`tests/session-ux-p5-shots.cjs`、`tests/exe-check.cjs`
  - 文档：`docs/conversation-ui.md`、`docs/conversation-timeline-audit.md`、本文件
- 后续补丁（2026-11-24，展开用量明细修复）：`public/styles.css`、`tests/agent-execution-ui.cjs`、`tests/session-ux-p5-shots.cjs` 三个文件，65 insertions / 3 deletions；新增 2 条 CSS 契约与 1 个真实 Chrome 展开断言。
- 折叠机制：
  - 每个已结束回合最多一条主折叠；标题由真实回合 start / end 计算墙钟，并行工具取最晚结束，**不相加**。正常结束「执行了 3 分 27 秒」；运行中「执行中 · 已运行 5 秒」；等待 / 停止 / 失败 / 中断 / 未完成各用对应真实状态；补充输入后的段落「继续执行了 1.5 秒」。
  - 主折叠覆盖整轮（含补充输入之间的工作），补充段从该条真实用户消息的时间开始，结束于**该段最后一项真实工作**；只有最后一段采用 settled 的回合结束时间，前段不能借用后段时钟。已验证时间线用 P5 `timing` 与已授权的 `_tlEntry`，Classic 用用户 / assistant 消息时间戳与 ToolEntry，Runtime 回退用真实 block 观察时间。
  - 无可信时间证据时退化为「工作记录」/「继续执行」，不显示 0 秒或约数；settled 后标签不再走动，重开会话从历史时间恢复；后台子代理在回合结束后的活动不延长已结算耗时。
  - 折叠只覆盖该段工作条目；最终回答、User、Plan、审批、等待输入和错误终态保留在折叠之外。P5 的 compaction 是 `kind=compaction` 的 activity 工作行，按真实顺序随所属段折叠（展开后可读），没有照搬 T3 的 compaction 分隔行；后台子代理完成若以独立用户 / 系统消息到达则按真实边界保持可见，其迟到活动不延长已结算耗时。T3 的其它保留项按 pi-GUI 现有数据契约映射；不伪造新的 run / attempt / owner。
  - 运行中 / 等待 / 失败 / 中断默认展开；正常完成默认折叠。用户显式选择按会话记忆；切换、展开、状态更新前后用稳定锚点保持阅读位置。
  - Classic / Runtime / 原生回退共用 `public/ui/turn-fold.js` 的文案与 `public/ui/work-presentation.js` 的摘要；没有新增虚拟列表、React、服务端字段或 Pi schema 改动。
- 本轮修复：
  1. **动作名被截断**：工具行标题改为 `flex: 0 0 auto; max-inline-size: 45%`，参数 / facts `flex: 1 1 0; min-inline-size: 0`，状态图标与行尾箭头固定 16px；正常宽度下「执行」等短名完整可见，长命令 / 路径吸收截断，窄窗与字体放大同样成立。
  2. **用量默认占位留白**：`.ui2-msg-meta` 改为绝对定位的 1px 裁切层，`opacity: 0`、`pointer-events: none`，不再占布局；hover / 键盘 focus 在消息底部 12px 间隙内浮出（`inset-block-end: -11px`），带背景与阴影；操作条同步收进间隙（`-12px`）。真实 token / reasoning / cost / 字段仍可达，「用量」入口不再重复轮次耗时。后续补丁：摘要固定单行，长内容省略而不是向上换行；展开「明细」时 footer 切回正常流，向下推开后续内容并为操作条预留 18px，避免此前绝对定位向上生长、盖住思考与最终回答。
  3. **折叠异常状态不可感知**：失败 / 中断 / 取消 / 未完成改用 `circleAlert` / `stop` / `warning` 图标与标题后缀「· N 项失败」等，`data-attention` 驱动默认展开；不画成功标签，也不把单个工具失败升级为整轮失败。
  4. **摘要夸大**：只有同一动作的每次调用都带可靠目标标识（P5 `summary.fileName`、原生 `ToolEntry.path`）时才说「读取 N 个文件」；否则退回「N 次工具」。Thinking、命令、搜索分类保持独立，未扩大任何读取权限。
  5. **Thinking / 过程正文**：最终回答保持可见，中间思考与过程文本作为工作条目进入折叠；Classic 在回合结束后才把最终回答消息内的 Thinking 节点借出到记录中，并保留 marker，释放时原位还原，编辑 / 重发目标不变。运行中内容保持可读，正常完成后通过耗时折叠收起。
- 本轮补充修正：Classic 实时多补充输入的原生回退此前会让每个补充段都使用整轮结束时间，早段被高估。现按真实 DOM 观察（assistant `message_end` 时间戳、ToolEntry 起止）在下一个补充输入处收尾；若该段只有思考 / 过程正文、且节点已被工作记录接管，仍会从记录内部读取 assistant 的原生时间戳，不借用后段时钟。新增 `conversation-flow` 用例覆盖两段补充输入（其中一段没有工具、只靠 assistant 时间戳收尾），标签为「执行了 11 秒 / 继续执行了 2 秒 / 继续执行了 4 秒」。

| 证据层 | 命令 / 场景与代码状态 | 环境、退出码与实际结果 | 证据位置 |
| --- | --- | --- | --- |
| 作者定向测试 | 最终工作区代码上的受影响套件 | `turn-fold` 6/6；`conversation-work-fold` 6/6；`conversation-flow` 19/19（原 18 + 新补充段用例）；`agent-execution-ui` 228/228；`ui2-classic` 55/55；`ui2-visual`（真实 Chrome）57/57；`session-ux-phase1` 81/81、`phase2` 98/98、`phase3` 128/128；`smoke` 1339/1339；P5-A 25 组 / 61 条模型断言 / 7 组后端，P5 view 7/7、UI 17/17、runtime 1/1，persistence 9/9、recovery 8/8、classic-history 1/1、runtime-recovery 3/3；`runtime-conversation` 110/110；`runtime-store` 34/34；`runtime-ui` 16/16；`runtime-history-search` 37/37；`history-tool-summary` 38/38 用例、168/168 断言；`session-search` 72/72（5i 因本机无符号链接权限跳过，不计入）；`message-edit-ui` 42/42。断言总数没有减少。 | 各套件直接运行；jsdom 结果不作为布局证明 |
| 真实 Chrome 折叠矩阵 | `node tests/session-ux-p5-shots.cjs`：Classic / Runtime 实时完成后的折叠、已验证完成 / 运行 / 失败 / 停止 / 中断 / 补充段、60 项长记录、原生长命令、用量隐藏 / hover、暗 / 亮、1320 / 700 宽；键盘 Enter、滚动位置、文本选区与截图 | `P7 fold matrix` 完成；`P5-B Chromium: 20 layouts verified`，exit 0。完成态标题 `执行了 3 分 27 秒`，运行态 `执行中 · 已运行 5 秒`，停止态 `你在 8 秒后停止`，补充段三段标题按真实边界；折叠头展开 / 收起前后触发行偏移保持；选中文本在折叠切换后仍保留；用量 chip 与操作条底边均未越过下一条消息顶边，消息高度在有 / 无用量的两种情况下一致；展开用量「明细」后 footer 位于回答下方、下一条消息被正常推开，操作条不压住字段；长记录显示 60 项分页且名称未被截成「执...」。 | `C:\pi-GUI\.shots\session-ux-p5b\`：`classic-completed-fold-collapsed.png`、`classic-completed-fold-expanded.png`、`runtime-completed-fold-collapsed.png`、`runtime-completed-fold-expanded.png`、`fold-completed/running/failed/stopped/interrupted/continued-*.png`、`fold-long-*.png`、`fold-native-long-*.png`、`usage-hidden-dark.png`、`usage-hover-dark.png`、`usage-details-open-dark.png`、`measurements.json` |
| 前 / 后对照 | 前一轮真实 Chrome 矩阵（工作记录已有、尚无轮次耗时折叠）与本轮矩阵并排检查 | 前：记录头只有「工作记录」与摘要，完成回合没有低优先级耗时行；后：同一位置是带箭头的「执行了 … / 继续执行了 …」折叠头，展开仍是 24px 工作行，无新卡片 / 背景 / 重复标题。用量前一轮占布局的 meta 空白，本轮默认零布局。 | 前：`%LOCALAPPDATA%\Temp\pi-gui-conversation-20261123-b582c14d\t3-matrix\`、`.shots\ui2-visual\`；后：`.shots\session-ux-p5b\` |
| Electron 实际渲染 | `node tests/agent-execution-visual.cjs`，真实 Electron 44.4.3 | 28/28，exit 0；运行中工具组默认展开、故障工作记录默认展开、Runtime 状态与滚动、深 / 浅 / 700px 均通过。交互录屏已生成。 | `.shots\agent-execution\`、`agent-execution-interaction.mp4` |
| 打包产物 | `npm run build:exe`；`PI_GUI_ELECTRON_ZIP_DIR=<本机 v44.4.3 缓存> npm run build:app -- --rebuild`，离线 | 均 exit 0。`build/Pi GUI.exe` 106,642,432 bytes，SHA-256 `fc47ee19c92467bd12dd78c3ecf18b1adb56106f4ac5287cac699db281f151a7`；`dist-app\Pi GUI-win32-x64\Pi GUI.exe` 246,324,736 bytes，SHA-256 `71b9ed5105a31ad944f82376b0e66ea8b147068aafb16330a556f44bebe5a19f`；整包 335.5 MB。 | `build/Pi GUI.exe`；`dist-app\Pi GUI-win32-x64\`；`build/asset-manifest.json` |
| 产物内容一致性 | dist-app 的 `resources/app/public` 与源 `public/` 全量逐字节比较；SEA 内嵌资源通过实际启动 exe 后 HTTP 读取 | dist-app 253 个 public 文件 **0 差异 / 0 缺失**；`exe-check` **55/55**，其中 `index.html`、`styles.css`、`app.js`、`agent-execution.css`、`messages.js`、`runtime-conversation.js`、`execution-timeline-view.js`、`conversation-work-log.js`、`ui/turn-fold.js`、`ui/work-presentation.js` 均与磁盘逐字节一致；exe 正常启动、假 pi 子进程与 PTY、PDF、配置读写全部通过。 | 同上；`node tests/exe-check.cjs` 输出 |
| Git 交付 | 本轮源码 / 测试 / 文档提交 | 按回滚边界拆分提交并推送 `origin/feat/compact-attachments`；未合并、未打 tag、未发布。提交哈希见推送后的 `git log --oneline`。 | `git status -sb`；`git log --oneline -5` |
| 完整 canonical / PR CI | 未在本机重跑 | **待验证**：上一轮完整 `npm test` 因无关凭据套件失败，用户明确不重跑；本轮按用户口径让 PR CI 完成 canonical。CI 结果出来前不宣称完整通过。 | PR 流程 |
| 独立审查 | 未运行 | **未运行（环境配额）**：上一轮两次独立审查均返回 HTTP 429；本轮未切换供应方或模型。作者自审修复了 Classic 补充段计时问题，但不能替代独立复审。 | 会话记录 |
| 真实模型 / 打包窗口 | 未运行 | **未验证**：未调用模型、未打开打包后的 Electron 窗口做人工体验；SEA exe 只做启动与 HTTP 内容验证，Electron 视觉套件运行的是开发态渲染器。 | 不适用 |

- 断言适配说明（均为目标行为变化，不是隐藏失败，断言总数没有减少）：
  - 已验证回合的旧「工作记录」标题改为耗时折叠标题；运行中断言改为「执行中」且不出现伪造的「已运行 / 用时」，失败 / 完成断言接受「执行了 / 工作记录」。
  - 补充输入从 progress 区域移到 activity-flow，保持可见；原导航 / 焦点断言保留，新增每段独立计时断言。
  - `agent-execution-ui` 新增 7 条 CSS 契约：工具名不收缩、用量默认零布局且 hover 可达、已验证用量仍正常显示、展开用量明细回到正常流、展开时为操作条留出间距、折叠头图标 / 标题 / 摘要弹性、工作行动作名与参数宽度分配。
  - `exe-check` 新增 7 个内嵌资源逐字节比较，原有 3 个保留。
- 限制与残余风险：
  - 完整 canonical 与 PR CI **待验证**；本文件只把定向套件、Electron 视觉套件、真实 Chrome 矩阵与打包检查当作已完成的证据层。
  - 独立代码审查 **未运行**；按项目规则不能宣称审查通过。
  - 真实模型会话、真实项目写操作、打包 Electron 窗口的人工体验未执行；fixture 的耗时和状态不代表真实模型性能。
  - 折叠状态按会话偏好保存，不写入 Pi 会话文件；老会话缺少时间证据时只显示「工作记录」/「继续执行」，这是有意的降级。
  - 离线 Electron 打包使用本机 zip 并跳过校验和（`PI_GUI_ELECTRON_ZIP_DIR` 的设计），只使用本机既有、此前已由 npm 安装校验过的 44.4.3 缓存。
  - `session-search` 的符号链接用例在无权限机器上跳过，不计入分子分母。
- 回滚：回退本轮 21 个已跟踪文件并删除 `public/ui/turn-fold.js`、`tests/turn-fold.cjs`、`tests/conversation-work-fold.cjs`；随后重建 `build/` 与 `dist-app/`。不涉及用户会话、凭据、Pi 安装或全局 npm。
- 结论：源码、定向测试、真实渲染矩阵、Electron 视觉与打包产物 **已完成**；完整 CI **待 PR 验证**；独立审查 **未运行**；合并 / 发布 **未授权且未执行**。

## 2026-11-24 最终验收整改：操作栏与用量 Popover

- 身份：分支 `feat/compact-attachments`，基线 `803a8d56`；固定 T3 Code 提交 [`1e088be4b5dc15ca3dd66fa01c6f2e035511a827`](https://github.com/pingdotgg/t3code/tree/1e088be4b5dc15ca3dd66fa01c6f2e035511a827)。本轮源码提交 `15079aee`、测试提交 `9ac22884`、文档提交 `e69ced8b`；PR [#110](https://github.com/HYJ1817/pi-gui/pull/110) 的 8 项 CI 在 `e69ced8` 全部通过，本文件仅回填该结果。**未合并、未打 tag、未发布**。
- 修改范围：34 个已跟踪文件（`public/` 11、测试 21、文档 2），1704 insertions / 812 deletions；另新增 `public/ui/usage-action.js`、`public/ui/usage-popover.js`、`public/ui/tooltip.js`。没有新增依赖、React、服务端字段、网络请求或 Pi 协议 / 权限 / 会话格式改动。`thinking-dots.css/js` 与 composer / 侧栏 / 设置保持未改。
- T3 源码对照（固定提交，全部为只读源码，不执行 T3 仓库）：
  - `MessagesTimeline.logic.ts:1229–1313`：整轮耗时取 run 的 start / completed（或首条工作到终态消息），steer 之后的每个折叠段从该条 steer 开始、结束于**该段自己的最后一项工作**；顶部折叠保留整轮时间（角标注释 1262–1298）。迟到的 background subagent 活动从段结束时间中排除（1240–1253）。
  - `TimelineAssistantRows.tsx:222–280`：助手操作行 `flex items-center gap-2`、`opacity-0` 默认，`group-hover/assistant` 与 `focus-within` 显示；工具按钮与时间戳同排。`TimelineUserMessageRow.tsx:356–381`：用户操作行右对齐（`justify-end`）、`opacity-0` + hover / focus-within 显示，和气泡尾部对齐。
  - `tooltip.tsx:122–141`：T3 Tooltip 默认 `side="top"`、`sideOffset=4`。本产品消息操作栏紧贴最后一行正文，若向上弹出会盖住刚读完的正文，因此只在消息操作栏改用 `placement: "bottom"`（视口不够时自动翻回上方）；其余 Tooltip 语义与 T3 相同，且不使用原生 `title`。
  - 任务描述里的设想与本仓库现状的偏离：①T3 / 旧实现把用量放在轮次终态或逐条消息页脚；本仓库已有 `messageActions`、`message-meta` 聚合和操作栏事务，因此复用操作栏，只删掉旧页脚，没有另造统计组件。②任务描述只要求「最终回答附近预留空间」；实际所有可操作消息都保留 24px 槽位，否则 hover 显示会造成布局跳动，也覆盖不到用户编辑 / 复制和工具记录入口。③旧 `classic-execution-view.js` 还保留了一段读取 `.ui2-msg-meta` 的兼容逻辑；本轮直接删除，否则 P5 会继续把已不存在的节点当用量来源。
- 修复内容：
  1. **计时归属**：原生回退按调用方给的**有序 block 数组**切 turn 与 supplement 段，不再读 DOM previous sibling；每次 render 重新计算并覆盖 `data-turn-*`，不跨会话 / 轮次 / 相邻段借用时间。历史恢复使用已持久化的可信时间戳；没有证据时不写 start / end，不伪造 0 秒或约数。只有最后一段可以使用真实 settled 时间；早段用该段最后一项观测工作收尾；迟到 background subagent 不延长已结算段。
  2. **异常计数与默认展开**：失败 / 中断 / 取消 / 未完成按真实条目逐项计数，不按类型去重；多个同类失败显示实际数量。运行中 / 等待 / 失败 / 中断 / 取消 / 未完成默认展开，正常完成默认折叠；用户显式选择仍优先。
  3. **补充输入计时**：Classic / Runtime / P5 / 原生回退共用同一段边界语义；顶部折叠保留整轮时间，补充段从真实用户输入开始，到该段最后一项工作结束；最后一段才使用真实 settled end。Classic 实时多补充输入由 assistant `message_end` / ToolEntry 的真实观察时间收尾；无工具段只用自己的 assistant 时间，不借用后段。
  4. **消息操作栏视觉**：操作栏回到正文下方正常流，固定 24px 槽位；用户消息右对齐到气泡尾部，助手消息沿阅读边左对齐。按钮 24×24、图标 16×16、间距 2px、统一 muted 色 / hover / focus-visible；默认 `opacity: 0; pointer-events: none`，消息 hover / `focus-within` 时显示并启用指针。修复了旧 CSS 选择器把 hover 写成后代 hover、导致「看得见但点不到」的问题；`message-edit.css` 里会绕过 `pointer-events` 的第二套 reveal 已删除。正文 → 操作栏的指针移动保持按钮可见。
  5. **用量入口重构**：删除 `renderUsageMeta` / `renderMessageMeta` 与 `.ui2-msg-meta*`、`.ui2-runtime-usage*` 全部样式；助手操作栏只保留一枚统计图标（`aria-label="查看用量"`、设计系统 Tooltip）。点击打开固定定位的 `#messageUsagePopover`：整轮汇总 + 逐响应分段、模型、真实耗时、成本、流式中提示；关闭方式为再次点击、外部指针、Escape、focus 移出、resize / scroll。打开时关闭 Tooltip，避免两层重叠；Popover 避开视口边缘与 `#chatComposer`。缺失字段不补 0，真实 0 保留；`reasoning` 明确标注为 output 子集；没有真实 usage 时不创建按钮。每个 turn 只有一处入口；P5 已验证回合显示整轮用量并保留逐响应明细，原生回退沿用原 block 用量。
  6. **死代码清理**：`classic-execution-view.js` 移除对已删除 `.ui2-msg-meta` 的读取、模型标签注入和 usage 过滤；`docs/conversation-ui.md` 同步为操作栏 + Popover 的现行行为。
- 证据层（全部为 2026-11-24 当前工作区代码）：

| 证据层 | 命令 / 场景 | 实际结果 | 位置 |
| --- | --- | --- | --- |
| 定向套件 | `conversation-flow`、`message-edit-ui`、phase1/2/3/4a/4b/4d/4e、P5 view/UI/runtime/persistence/recovery、`ui2-classic`、`ui2-runtime-display`、`ui2-visual`、`agent-execution-ui`、`turn-fold`、`conversation-work-fold`、`thinking-dots` | `conversation-flow` **23/23**；`message-edit-ui` **42/42**；phase1 **82/82**、phase2 **98/98**、phase3 **154/154**、phase4a **110/110**、phase4b **108/108**、phase4d **14/14**、phase4e **60/60**；P5 view **7/7**、UI **17/17**、runtime **1/1**、persistence **9/9**、recovery **3/3**、classic-history **1/1**；`ui2-classic` **55/55**、`ui2-runtime-display` **83/83**；`agent-execution-ui` **227/227**；`turn-fold` **6/6**；`conversation-work-fold` **10/10**；`thinking-dots` **90/90**。jsdom 结果只作行为契约，不作布局证明。 | 各套件直接运行 |
| 真实 Chrome 操作栏 / 用量 | `node tests/session-ux-p5-shots.cjs`（Classic / Runtime、折叠矩阵、用量、问候、多轮） | **P5-B Chromium: 23 layouts verified，exit 0**。断言包括：操作栏默认 opacity 0 但保留 24px 槽位；hover / focus 显示且几何完全不变；body → bar 指针移动不隐藏；按钮 24×24 / 图标 16×16 / 间距 2px；无原生 title；用户栏与气泡右缘对齐；Popover 固定定位、不越视口 / 输入框、开关不改变消息高度 / 下一条位置 / 滚动；Escape / 外部点击关闭；工具提示在栏下方且不覆盖正文；窄屏 + 浅色 + `--font-scale:1.25` 边界；每轮只有一枚入口；「你好啊」单轮问候与两轮对话各自命中真实用量。 | `.shots/session-ux-p5b/`：`usage-bar-idle-dark.png`、`usage-bar-hover-dark.png`、`usage-popover-dark.png`、`usage-popover-light-narrow.png`、`greeting-idle-dark.png`、`greeting-hover-dark.png`、`greeting-usage-popover-dark.png`、`greeting-user-hover-dark.png`、`multi-turn-usage-popover-dark.png`、`measurements.json` |
| 真实 Chrome 基础视觉 | `node tests/ui2-visual.cjs` | **57/57 通过**；24px 操作按钮 / 固定 Popover / 用量网格与各断点、主题、reduced-motion 均通过；截图见 `.shots/ui2-visual/c5-final.png` 等。 | `.shots/ui2-visual/report.json` |
| 打包 exe | `npm run build:exe`；`node tests/exe-check.cjs`（workspace TEMP，`CHECK_PORT=15797`；用内置最小 PDF fixture） | `exe-check` **57/57**, exit 0；exe 启动、假 pi 子进程 / PTY、PDF、配置读写、无 build/ 污染均通过。 | `build/Pi GUI.exe`；`build/asset-manifest.json` |
| 打包内容 | `cmp` 逐字节比较 `dist-app/Pi GUI-win32-x64/resources/app/public/` 与 `public/` | `styles.css`、`ui/usage-popover.js`、`message-meta.js`、`classic-execution-view.js` 等 **MATCH**；`asset-manifest.json` 已包含 `ui/usage-action.js`、`ui/usage-popover.js`、`ui/tooltip.js`。 | 同上 |
| 产物 | `build/Pi GUI.exe` / `dist-app` | `build/Pi GUI.exe` **106,656,768 bytes**，SHA-256 `5716af0df65a24a67034ca696b4884cd672458cf45d3dcecdffee14e5c984e91`；`dist-app/Pi GUI-win32-x64/Pi GUI.exe` **246,324,736 bytes**，SHA-256 `71b9ed5105a31ad944f82376b0e66ea8b147068aafb16330a556f44bebe5a19f`。 | 同上 |
| 完整 canonical / PR CI | PR [#110](https://github.com/HYJ1817/pi-gui/pull/110) 的 CI，head `e69ced8` | **8/8 全部通过**（2026-11-24 11:45–12:05Z，run [45387084542](https://github.com/HYJ1817/pi-gui/actions/runs/45387084542)）：`Validate complete test plan`、`Tests (core / ui / security / native / faults)`、`Electron build check`、`CI gate` 均为 SUCCESS。本机完整 `npm test` 仍按用户要求未重跑；此后只能修改本验收文档回填结果，不改变代码 / 测试状态。 | PR #110 checks |
| 独立审查 | — | **未运行**：本轮未启动独立审查 agent；作者自审发现并修复了操作栏 hover 的 `pointer-events` 选择器缺陷、Tooltip 覆盖正文、P5 旧 meta 兼容分支。自审不能替代独立复审。 | 会话记录 |
| 真实模型 / Electron 窗口 | — | **未验证**：未调用真实模型、未打开打包 Electron 窗口人工体验；Electron 视觉脚本已更新选择器，但本轮未运行。真实 Chrome 证据来自离线 fixture + 生产 `index.html` / 模块。 | 不适用 |

- 断言数量变化（必须解释，不能只看「全绿」）：
  - `agent-execution-ui` **228 → 227**：删除 4 条已失效的旧用量 CSS 契约，新增 3 条现行契约（操作栏正常流 + opacity / 固定可滚动 Popover / 网格与逐响应分段），净少 1 条。没有删行为断言。
  - `phase3` **128 → 154**：新增操作栏入口、Popover 字段 / 成本 / 多段、原生回退按钮位置、缺失 / 0 语义等真实 DOM 断言。
  - `conversation-flow` **19 → 23**；`phase1` **81 → 82**；`message-edit-ui` 保持 **42/42**；`ui2-classic` **55/55**；`ui2-visual` **57/57**。
- 截图的可见结论：`greeting-hover-dark.png` 里用户气泡靠右、助手回答靠左，操作栏在回答下方且 Tooltip「查看用量」位于栏下、不覆盖回答；`greeting-usage-popover-dark.png` 打开后字段完整、不改变气泡位置；`usage-popover-light-narrow.png` 在 700px + 1.25 字体缩放下夹在视口内并让开输入框；`multi-turn-usage-popover-dark.png` 只展开当前轮次的用量，另一轮不出现重复入口。
- 未验证 / 残余风险：
  - 完整 canonical 已由 PR CI 在 `e69ced8` 验证为 8/8 通过；本机完整 `npm test` 未重跑，后续文档回填不改变代码状态。
  - 未运行独立代码审查；操作栏与 Popover 属常规 UI 风险，未触及凭据、执行权限、文件写入或安装更新。
  - 真实模型会话、真实项目写操作、打包 Electron 窗口人工体验未执行；fixture 的时长 / 状态不代表真实模型性能。
  - 历史恢复与补充段计时的真实渲染证据仍来自 P5 夹具和 jsdom 行为契约；未在真实长会话上重放。
- 回滚：回退上述 34 个已跟踪文件并删除 `public/ui/usage-action.js`、`public/ui/usage-popover.js`、`public/ui/tooltip.js`；随后重建 `build/` 与 `dist-app/`。不涉及用户会话、凭据、Pi 安装或全局 npm。
- 结论：操作栏、用量 Popover、计时归属、异常计数与补充段计时 **已实现并通过定向 + 真实 Chrome 验收**；打包产物 **已重建且 exe-check 57/57**；完整 canonical **已由 PR CI 在 `e69ced8` 验证 8/8 通过**；独立审查 **未运行**；合并 / 发布 **未授权且未执行**。
