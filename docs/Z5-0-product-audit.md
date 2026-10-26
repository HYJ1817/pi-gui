# Z5-0 产品、体验与技术审计

日期：2026-10-26（Asia/Shanghai）。单一 Codex 执行；只读产品审计及规划，不是独立安全验收。

## 1. 审计身份与结论

- 审计基线：`c7fbad65500e1c20b6084f421c7920d8f77ffbc6`，即开始时最新 `origin/main`，PR #35 合并提交。
- 工作分支：`codex/z5-0-roadmap`；独立目录：`C:\Users\21022\.codex\worktrees\z5-0-roadmap\pi-GUI`。没有在原工作区或 Z4-6B 工作区编辑文件。
- main 的 [CI 40315861760](https://github.com/HYJ1817/pi-gui/actions/runs/40315861760)：push / attempt 1 / success，8 个作业成功；gate 日志确认 221 个 canonical 叶命令完成。它证明基线，不能替代未来 Z5 行为提交的测试。
- [PR #36](https://github.com/HYJ1817/pi-gui/pull/36) 初查仍为 open、未合并，head `465762951c52a56c3eabdc49a3b4003f20e03855`。其增量是 102 个文档/证据文件及 `scripts/verify-collab-packaged-gui.mjs`，没有生产、依赖、现有测试或 CI 改动。审计分支没有合入它；最终状态快照见 [本轮验收](Z5-0-acceptance.md)。
- 最新公开 Release/tag 为 v0.29.0，版本号相同不代表安装包包含此后 Z1/Z3/Z4 的 main 源码。本轮没有把安装版作为最新源码实测。

产品已经覆盖本地 Coding Agent 的主要闭环。现有 Registry、Surface、能力三值投影、Git 事实源、Owner/generation 防护与协同 CAS 值得保留。优先补并行会话输入可靠性，再解决明确的产品合同分歧和恢复上下文缺口；没有证据支持全面重写 UI、合并两套 Runtime 或新建大型平台。

本轮确认 **1 项条件可复现的产品缺陷、1 项产品合同分歧、2 项能力限制/机会**。没有在本轮确认新的安全越界或数据文件损坏；这不构成安全无缺陷保证。问题均为 main 已有行为，本轮没有引入产品回归。

## 2. 证据等级

| 标记 | 本文含义 | 不能推出的结论 |
| --- | --- | --- |
| S | 当前 main 源码、入口接线及调用边界已检查 | 不能凭函数存在宣称实际模型或桌面闭环通过 |
| T | 本轮实际运行的离线定向测试/生产模块探针 | jsdom 不证明布局、真实 IME 或 OS 输入 |
| H | main 中历史验收报告、JSON、截图；本轮重新阅读/看图 | 只证明报告对应提交和环境，不冒称本轮重新运行 |
| B | 未合并 PR #36 的固定 SHA 证据，使用 `git show`/GitHub 只读核对 | 不视为 main 已交付脚本或本轮独立复验 |
| U | 未验证的风险/体验假设 | 不计入已确认缺陷 |

本轮没有启动完整 `npm test`，没有真实 Pi/model/OAuth/安装升级操作，也没有新 Electron 窗口测试。独立依赖目录离线恢复 93 个锁定包，未升级依赖；其中没有可执行的 Electron dist，不为本次审计下载运行时。下面“Electron 有证据”均明确是 H/B。

### 主要证据入口

- S：`server.js` 的模块装配、`server/router.js` 的鉴权后分发；`public/app.js` 的生产 handler、`public/index.html` 的入口；具体文件见下一节。
- T：`runtime-conversation` 48/48、`runtime-store` 25/25、`daily-use` 31/31、`runtime-models` 51/51、`ui3-model` 50/50；共 5 套、205/205 项。另有 8+5 项现状刻画断言，验证缺口仍存在，绝不是修复通过。
- H：[P32.4](p32-4-acceptance.md)、[后台会话](session-background-acceptance-2026-10-20.md)、[UI 收尾](UI-visual-finish-acceptance.md)、[Z1](Z1-acceptance.md)、[Z3](Z3-A-acceptance.md)、[Z4-6A](Z4-6A-acceptance.md)、[T4-C](T4-C-acceptance.md)、[G4](G4-acceptance.md)。
- H：`docs/evidence/p32-4/screenshots.json` 记 170 项；其 runner 默认含 `--no-sandbox`，不能按窗口偏好 `sandbox:true` 升格为正常沙箱证据。Z4-6 的 `electron/results.json` 则明确记 `qualification: normal-sandbox`，54 场景；55/55 报告还含进程清理项，不混用分母。
- B：[Z4-6B 39 项索引](https://github.com/HYJ1817/pi-gui/blob/465762951c52a56c3eabdc49a3b4003f20e03855/docs/Z4-6B-feature-audit.md)及[最终验收](https://github.com/HYJ1817/pi-gui/blob/465762951c52a56c3eabdc49a3b4003f20e03855/docs/Z4-6B-final-acceptance.md)：正常沙箱窗口 55/55、35/35、6/6；打包窗口 27/27、含系统输入流程 28/28。fake Pi、离线 guard/Inspector 条件仍成立；真实 Pi 9/9 仅控制面、modelCalls=0。上述记录本轮未重跑。

## 3. 十二类产品能力盘点

“接入”按 HTML → app handler → 模块 → 后端边界核对，不仅依据 README。测试列是当前存在的套件，不表示本轮全部执行；仅 T 为本轮运行。

| 模块 | 实际实现及生产入口（S） | 自动化覆盖 | Electron 证据及限制 | UX / 重复实现结论 |
| --- | --- | --- | --- | --- |
| 1 项目与 Workspace | `public/projects.js`、`worktrees.js` → `server/projects.js`、`worktrees.js`、`lib/git-worktree.js`；侧栏添加/激活、项目菜单创建/移除受管 Worktree。普通项目会话另经 `ordinary-sessions.js` 登记 | project-config、worktrees/http/ui、ordinary-session-resolver/runtime | H P32.4、后台会话；Git 与 Pi fixture，非本轮运行 | 浏览项目与改变执行 cwd 已分开。不能把旧文档“每会话必须独占 Worktree”泛化到现在；禁止删除现有普通会话路径 |
| 2 会话、多会话并行 | `sessions.js`、`session-navigation.js`、`runtime-nav.js`、`runtime-conversation.js` → sessions/registry；创建、搜索、归档、软删除、分叉、后台执行、只读历史及恢复 | sessions/search、session-background/recovery、runtime-*；T conversation/store | H P32.4 170 项和后台会话证据；默认 runner 沙箱限制另列 | 稳定 createdAt/conversationId 排序已有实现。Runtime 草稿只在当前 renderer 内存保留，见 O1；只读历史缺工具上下文，见 O2 |
| 3 Pi 启停与恢复 | `rpc.js`、bridge-recovery、runtime-recovery；`rpc-bridge.js`、session-runtime、pi-supervisor、Stop barrier；前台/后台分别按 owner 控制 | bridge-state-recovery、stop-barrier、gui-browser-stop、runtime-resource-cleanup/processes、process-budget | H Z4-6A；B 真实 Pi 1.4.0 控制面 9/9、零模型；模型运行中崩溃恢复未认证 | 只读查看不自动 spawn；cleanup 未确认仍占 slot。不能为简化界面移除停止屏障或强制释放 |
| 4 模型与 Provider | Classic `ui3-model-picker.js`/rpc；Runtime `runtime-models.js`/conversation；`providers.js`/models-api；设置中配置供应商、拉模型列表；切换经 Pi 回读 | models-api、model-capabilities、fallback、runtime-models；T models/picker | H UI-3/UI 收尾/P32.4；无真实付费请求复验 | Classic 分组 popover 与 Runtime select 不同但都是真入口；思考候选合同分歧 D1 已复现。不能合并认证/Quota/模型选择的权威状态 |
| 5 MCP/Skills/扩展 | `app.js:1081-1105` 将能力、MCP、Skills 指向同一个 Extensions Surface；skills/extension-registry/mcp-native 各有职责；官方 CLI 代理 add/remove/login/logout，Skills 修改既有设置并提示重启 | skills、extensions、capability/install、mcp-native、runtime-secondary | H UI 与 P32/历史能力测试；本轮未连接真实 MCP 服务或改变设置 | 多入口是同一过滤器的快捷方式，不等于重复业务。没有通用扩展市场或标准 MCP Apps 生产宿主；不据未见入口断言上游永不支持 |
| 6 OAuth/供应商认证 | `public/provider-auth.js` → provider-auth/SDK worker；设置“供应商与认证”可达。沿 launch identity 使用 Pi 公开 SDK，安全快照与凭据分离；MCP login 是另一条官方 CLI 路径 | provider-auth、provider-auth-runtime、native-provider-quota | H 历史 UI/fixture；本轮未进行真实登录、回调、登出或 token 轮换 | 供应商配置与用户级认证有不同用途，不应机械合并成一个写入面。新 Pi SDK 兼容资格 U1 仍需核对 |
| 7 文件查看与编辑 | `public/git.js`（文件头明确非 IDE）、specs-panel、attachments、messages；Git Diff/评论、只读 SPEC.md/specs Markdown、附件正文预览；“打开”经 git-routes 解析后由 Electron `shell.openPath` 交外部程序 | git、specs/ui、diff-comments、review-comments、body-integrity、split-workbench | H T1/T2/T3、Z1、UI-5；本轮未写真实项目 | **部分实现**：没有通用文件树/任意源码编辑器。图节点编辑和 Diff 评论不等于编辑源码；这是一项产品边界，不直接登记成缺陷或扩建 IDE 任务 |
| 8 内置浏览器 | browser-pane/runtime-browser → Electron browser-view/agent/host；对话顶栏及右栏，Browser+Changes 分屏；Agent Control 默认关闭、受控本地网页；外部 Browser Extension Activity 是另一种能力 | gui-browser-*、runtime-browser、browser-workbench/viewport-safety、Stop | H T2-B/UI-4/Z4-6；B 打包窗口。部分旧 runner 有 `--no-sandbox`，不可混报 | 内置 browser、外部 Browser Use、Web fetch/search 应保留独立权限解释；遮挡与 bounds 有唯一 owner，不增加伪造 Allow/Bypass |
| 9 规划与人工审阅 | public/planner、review-task-preview、candidate UI；server/planner scheduler/store/verifier、review-comment authority、candidate apply/transactions；任务页、Changes 选择评论→准备修改任务→候选 Diff→明确采纳 | planner/reviews/verification、workflow-relations、review-task、candidate 及恢复/故障套件 | H T4-A/B/C、候选 Electron crash；当前全量资格依各报告，独立安全核验不自动继承 | Planner、第三方 Subagent、协同建议三者不是同一调度器。候选 Worktree 不是 OS sandbox；历史 Git 全部变更不能当 Agent attribution |
| 10 协同文档/流程图 | app 顶栏→collab-panel/canvas；lib/collab-doc、server authority/service/store/source/queue。节点/边、编辑、多选、对齐、布局预览、undo/redo、SVG/PNG、明确接受 Agent 建议。另有 Z3 受控 line/bar 图表 | test:collab 当前 21 叶、test:viz；store 双进程/CAS/故障、panel 生命周期 | H Z4-6A 正常沙箱；B Z4-6B 已有完整打包窗口索引，不重复开发 | 是会话绑定的本地图编辑和 Agent 建议，不是云端多人实时协作或任意富文本文档。200 节点/400 边/每批50操作是当前限制；大图原子布局另案，不因历史报告写“Z5”就自动启动 |
| 11 日志/诊断/恢复 | diagnostics、logs、log-client → diagnostics/logging/lib log-contract/core；设置可看快照、时间线、崩溃线索、导出 ZIP；runtime/bridge recovery 继续持有恢复权 | diagnostics、logging/leaks/secret-state/client/ui、bridge-state-recovery | H UI-5、Z1 的日志引用反馈及 Z4-6；本轮未读取真实用户日志 | 快照回答“现在”，日志回答“前后”，并非冗余。Z1 概览引用反馈和通知去重已修，不列新任务 |
| 12 更新/构建/发布 | 设置→应用更新和独立 Pi 更新；Electron app-update/维护锁/helper；build-app/build-exe/build-installer；正式发布 workflow | app-update 及 opt-in Windows 故障、app/exe/portable/installer、CI evidence/proof | H G4/UI-5；当前 main CI build-check；不是本轮安装升级证明 | 安装版与便携版路径有意不同。digest 不等于签名；历史 NotSigned、真实原位升级与独立资格不能由新 CI 覆盖。未经本轮授权不运行发布或安装 |

附件的 `text`/预览来源于上传及提取结果，经消息渲染展示；不提供任意项目文件写入，不将附件卡片等同于通用文件编辑器。

## 4. 日常工作流与 UI 审计

| 操作/界面 | 已确认现状及证据 | 对效率的判断/处置 |
| --- | --- | --- |
| 打开项目、侧栏导航 | projects/session-navigation 分离只读浏览与激活；运行中可看别的项目/历史；后台完成不抢输入焦点，列表不按活动重排 | 没有复现新的会话位置漂移。保持已有行为；不能回退成“切项目就停止所有任务” |
| 选模型 | Classic 供应商分组/键盘漫游，Runtime 原生 select；均有真实 handler 与 readback | 选择器形式差异是体验债，未测“选择耗时”不声称效率缺陷。先解决 D1 语义，再考虑统一外观 |
| 发起任务、输入框 | Classic 有 isComposing/keyCode229/内联命令 composition 守卫；Runtime 只有 isComposing；普通 Enter、Shift+Enter 已存在 | F1 是有条件的误发送缺口；O1 是刷新后草稿恢复缺口。优先处理这一条高频链路 |
| 主对话与历史 | Classic 消息/工具时间线较完整；Runtime live 是有界文本、工具状态、思考和用量投影；dormant 历史只保留 user/assistant 正文并明确提示 | O2 是恢复工作时的信息损失，不是“会话文件丢失”。只读恢复不能重播审批/工具执行 |
| 审阅修改 | Changes 读实际 Git，行/区间评论、准备任务、候选预览/采纳已接通；Z1 恢复实际滚动容器及 diff 横向位置 | 复用既有审阅闭环，不新增另一套 Code Review 状态。撤销/采纳资格继续 fail-closed |
| 看文件并继续对话 | Specs、附件预览、Diff 与外部打开已存在；右栏/分屏 Surface 管理释放 | 通用编辑器不在当前产品范围。返回对话不应重建 Composer；没有新证据要求全局布局改版 |
| 设置及工具入口 | Settings 按模型/认证、能力、MCP、更新、诊断分组；命令面板调用同一 handler | 入口多并不证明冗余；尚无可测“过深”阻断。Runtime 头部含多颗控制按钮，拥挤是待观察假设 |
| 反馈、弹窗、术语 | UI 收尾普通 info/success 静默、30s 去重、历史不重复 alert；错误有详情和动作。Runtime 仍暴露 Browser、推理强度、当前会话输出等与 Classic 不完全一致的用语 | 通知降噪已经实现，不重复立项。开发工具术语是否难懂缺用户观察；不凭审美列 Important |
| 窄窗口、布局 | 本轮看过历史 `ui5-visual-evidence/packaged-current-final/light-700-pane.png`、`native-dark-1300.png` 和 `evidence/p32-4/A-stopped-B-running.png`；700px 右栏为覆盖承载而非强压多列 | 截图支持已有覆盖式布局/外观差异，不证明当前 main 所有交互无溢出；未新测 DPI/IME/拖动/焦点，均标 U |

### F1：Runtime 输入法兼容守卫缺失（Important / Pre-existing / 未解决）

- 位置：`public/runtime-conversation.js:219-225`；对照 `public/app.js:959-965`。
- 条件：活动 Runtime ready/idle、输入非空、发送可用，收到 `key=Enter, keyCode=229, isComposing=false` 的 keydown。
- 预期：将该事件视作 IME 过程，不触发 prompt，保持用户草稿；这与 Classic 已有保护一致。
- 实际：Runtime preventDefault 并调用 send.click，进入 captured owner 的 prompt 请求。探针获得 **1 次 prompt**；标准 isComposing=true 与 Shift+Enter 各 **0 次**。
- 影响：在产生此兼容事件序列的输入环境中，确认候选字可能变成提交尚未完成的任务。**没有证明本机特定 Windows IME 一定产生该序列**；确认的是生产事件处理链的条件缺口。
- 本轮证据：真实导入 createRuntimeConversation，jsdom 分发事件，mock HTTP 记录 `command.type` 和完整 owner；没有发给 Pi。既有 48/48 不能覆盖该新增条件。
- 建议：Z5-1 补 keyCode229 和局部 composition 生命周期守卫，继续调用同一发送动作；不复制 submit、扩大全局快捷键或自动 Stop。

### D1：思考等级的 Classic/Runtime 合同分歧（已确认分歧，不定性回归）

- 位置：`public/ui3-model-picker.js:103-134`、`public/runtime-models.js:48-66,109`、`public/runtime-conversation.js:362-387`。
- 同一合规模型 `{provider:'fixture',id:'reason-conflict',reasoning:false}`，同一原生读回 `levels=['off','low','high']`。
- Classic `thinkingAvailability` 返回 ready；Runtime 将 levels 置 null，setThinking('high') 返回 false。
- [model-capabilities 当前说明](model-capabilities.md)写“Pi 若给出了多个等级，以该列表为准”；[P32.4 §11](p32-4-acceptance.md)却明确规定 Runtime 只有 reasoning=true 才允许。这是历史设计分歧，不能声称“P32 忘了实现”。
- 本轮 5 项现状断言及两套既有测试 51/51、50/50，证明差异可重复；没有连接真实模型证明上游一定返回此组合。
- 建议 Z5-2 由用户确认统一合同：有当前模型且 Pi 成功回读的非 off 档位优先；无模型/未成功读取/仅 off 保持不可用。不推断缺失档位，不改后端协议。

### O1：Runtime 未发送草稿不跨页面恢复（已确认限制，非既有承诺回归）

- 位置：`runtime-conversation.js:220,253-264`、`runtime-store.js:11,19,34`；对照 `draft.js` 的 Classic 文本持久化。
- 内存中 A/B 切换保留各自 draft；createRuntimeStore 新实例 seed 同一 snapshot 后 draft 为空，Runtime 输入后 localStorage 新增键数为 0。backendInstance 改变还会清 records。
- Pi 原生 session 文件没有这段“未发送文本”，不能靠 get_messages 恢复。只读后台新会话草稿的现有机制也不覆盖这个 live Runtime textarea。
- 用户收益：刷新/重启后不用重写长任务。列入 Z5-1，但明确这是扩展能力；必须保留身份、容量、发送 ACK 与后续编辑的隔离，而不是直接给 Runtime 调用 Classic 全局 draftSync。

### O2：关闭后恢复缺少工具执行上下文（已确认限制，非解析错误）

- 位置：`server/session-history.js:23-27,77-105`、`runtime-conversation.js:113,427`；P32.4 §12 明示只读历史正文合同。
- dormant 历史按后端证明的 sessionLocator 限量读磁盘，仅投影 user/assistant text；toolResult/thinking/toolCall 参数均不进接口。live renderer 恢复则另有 `runtime-recovery.js` 的事件环/get_messages 路径，两者不能混为一谈。
- 收益：次日恢复工作可确认做过什么，而非重复运行任务获取线索。
- 建议 Z5-3 首先补只读、限量、脱敏的工具名称/可证明状态/显式缺失提示；不开放原始参数、任意日志或审批回放。不顺带建设完整 IDE/全文检索系统。

## 5. 架构与代码质量

| 边界/问题 | 当前审计结论 | 建议 |
| --- | --- | --- |
| 组合根增长 | server.js 同时接线 classic/Runtime、权限、候选、协同；app.js 同时负责两类会话及多个 Surface。复杂度来自跨模块生命周期，不能仅按行数认定差 | Z5 修改只落入明确模块；组合根仅增加接线。无本轮证据支持整体拆解 |
| 状态归属 | Classic S/runtime；Runtime Registry → runtime-state 单 store，projection 只读展示；authority/cache 均有 owner/epoch/token | 继续保留。O1 新增的持久草稿是 UI 文本，不得建立第二 Registry 或把本地草稿当执行身份 |
| Classic/Runtime 重复 | 两套 Composer/模型/Browser adapter 部分 UI 逻辑重复；F1、D1 表明策略漂移可发生；execution owner/生命周期本身不同 | 从实际漂移抽取小型纯策略或复用存储原语，不合并 RPC、Registry、Bridge 与认证状态机 |
| 异步竞态 | 既有 owner、revision、eventSequence、historyToken、scope instance 防迟到覆盖；发送 ACK 还比较 draftRevision。`api.js` 网络错误结构化返回，不能仅见 action 无 catch 就报未处理 rejection | 在新草稿恢复/模型策略中保留双向 owner 比较及捕获目标；本轮没有确认新的跨会话写回竞态 |
| 轮询 | collab-panel:128-146 为 1.5s 轮询且 pollPending 单飞；process-panel:79-109 为 1s、loading 单飞并有 disposer，日志有 revision/cursor/容量 | 不能把旧慢轮询缺陷重新立项。隐藏但未销毁时的活动量/后台电量未量测，先作 U，不改成新 SSE 总线 |
| 资源生命周期 | Surface disposer、Browser bounds/occlusion owner、Stop barrier、Runtime slot/lease 与 supervisor 各有职责；协同已有40轮有界资源检查 | 短循环不是小时级稳定性资格。沿原有脚本复验真实失效场景，不建立通用生命周期框架 |
| IPC/RPC | main/preload 同源 top-frame 检查、loopback Token/Origin、HTTP command admission、stdio JSONL；SDK worker 只在已有公开认证边界内使用 | 不改 Pi、不把内嵌 Browser 的权限扩展到用户浏览器，不用 UI 按钮模拟上游没有的审批协议 |
| Pi 兼容 | pi-compat-matrix current 仍是1.0.0；Z4-6记录1.4.0控制面。版本 metadata、probe 三值和真实活动证据是不同层 | 新版本完整认证仍未知（U1），不能把1.4.0控制面成功写进“全功能已认证”矩阵；不按版本号猜能力 |
| 废弃路径 | `session-revert-object-writer.js:12`/profile 明确 production_allowlist_empty；Z4-1 prototype 仍在 canonical；Classic 仍是生产路径 | 前者是安全资格闸门，后者是测试来源；都不能凭名字当死代码删除。未建立可安全清理的生产路径清单 |
| Windows | shell shim 身份、PID复用、动态端口、Native ACL/SACL/文件句柄、NSIS/portable 检测都是实际边界 | 使用 TEMP、身份与创建时间判据；本轮不提权、不改变用户审计策略、不做真实项目写测试 |

## 6. 测试与构建成本

当前 `package.json` 的 test/pretest 递归展开 221 叶；本轮 `node scripts/run-test-group.mjs --validate` 确认 core145/ui24/security27/native4/faults21。验证计划不等于执行221条。

main 精确 SHA 的远端 gate 日志给出：

| 分组 | 通过叶命令 | 执行耗时 |
| --- | ---: | ---: |
| core | 145/145 | 616.840s |
| ui | 24/24 | 106.476s |
| security | 27/27 | 1119.661s |
| native | 4/4 | 990.425s |
| faults | 21/21 | 897.163s |

总和3730.565s是各组累计执行时间，不能当墙钟；该 run 从首作业11:32:48 UTC至gate完成11:53:12 UTC约20m24s。五个隔离测试 runner 与独立 build-check 已并行，G3 已做过优化。不能为提速删 Native 故障矩阵、复制测试清单或继续新增减测基础设施。本轮只是文档，不重建 app/SEA；将来改 public/server 后必须重建并验证资源。

Electron opt-in、真实外部服务、打包完整窗口、安装升级和 canonical 是不同证明；CI build-check 不能替代全部交互。未核对 GitHub ruleset/required checks 的实际启用状态，不声称远端强制保护已生效。

## 7. 未确认风险与暂不进入 Z5 的工作

| 编号 | 风险/机会 | 缺少的证据或重启条件 |
| --- | --- | --- |
| U1 | Pi 1.4.0 全面兼容、公开认证 SDK/扩展接口漂移 | 仅有控制面记录；需按 upgrade-playbook 做当前官方安装包/RPC/SDK逐项核对，不能付费模型探测 |
| U2 | 真实模型建议生成、运行中 Stop、异常退出与恢复 | fake/控制面不够；有明确模型调用授权及费用边界后再独立验证，本轮不发 prompt |
| U3 | 安全写入、P33、T4-C、Windows 安装升级的完整资格 | 旧报告保留独立审查/SACL/原位升级限制；复用现有专项验证及人工决策，不因 Z5 改 UI 自动放行 |
| U4 | 窄窗口/DPI、长期占用、罕见 capturePage UnknownVizError | 本轮只有历史截图/有界循环；需实际重现/指标后才登记产品缺陷，不将单次失败宣称已修复 |
| U5 | 大于50操作的原子布局 | 当前明确拒绝且无部分写入；需证实高频需求、独立协议/降级与崩溃设计，不能直接放宽LIMITS或自动分批 |
| U6 | 菜单过深、重复装饰、Runtime按钮过多 | 尚无当前可重复的操作失败或用户任务时间证据；不启动纯视觉改版 |

通用文件编辑器、MCP Apps 宿主、云端多人协作、全局状态重写、依赖升级、CI再造均不进入本轮建议。GitHub open issues 查询为0（连接器及 gh issue list 双查）；它只表示没有公开登记的开放 Issue，不表示没有缺陷。最终筛选及范围见 [Z5 路线图](Z5-roadmap.md)，Z5-1 只在用户独立验收后另行启动。
