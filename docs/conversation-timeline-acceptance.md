# Conversation 展示重构验收材料

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
