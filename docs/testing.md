# 测试分层与 CI

## P16 Web Activity

`npm run test:web`（纳入唯一入口 `npm test`）使用 0.33.0 真实 schema 的
离线 result fixtures 与 DOM。覆盖三种 renderer、并发/identity、取消与错误、
历史一致性、缺字段、结构化来源与危险 URL、Electron 校验、能力证据重置、
手工安装降级与重启复用。默认不联网、不装包、不调用模型或消耗 quota。
`shots:harness` 的 156 场景验证紧凑 Web Activity 与全文不铺开。
真实联网验收仅按 [Web Access](web-access.md) 手工步骤显式执行。

这份文档回答一个问题：**改了代码之后，该跑哪些测试、在哪里跑。**
这份文档讲**分层与边界**：哪些测试进 CI、哪些要真 pi、哪些只在发布前跑。
每条套件具体覆盖什么，README 里只留一句话索引，细节不重复维护。

## 一、总览

| 层 | 命令 | 需要什么 | 跑在哪 |
|---|---|---|---|
| **A. 基础测试** | `npm test` | 只要 Node ≥ 22.19 | 每次 push / PR（CI）+ 本地 |
| **B. 打包验证** | `npm run test:exe` / `test:app` | 先跑 `npm run fixtures` 与 `build:exe` / `build:app` | CI 的 build-check job |
| **C. 安装程序验证** | `npm run test:portable` / `test:installer` | 先跑 `build:installer`，且本机有 NSIS | 手动（release-check）或本地 |
| **D. 真 pi 验证** | `npm run test:skills-live` / `test:reliability-live` / `test:inject` | 本机装了 `pi` | 只在本地 / 手动 |
| **E. 界面视觉核对** | `npm run harness` + `shots` / `test:window` | 真浏览器 / 真窗口 | 只在本地 |

> **B 层要先跑 `npm run fixtures`。** 它生成测试用的 docx / png / pdf
> （放在 `os.tmpdir()/pi-gui-fixtures`）。PDF 以前只能靠 LibreOffice 转，
> runner 上没有 → 那几条断言在干净机器上必然红。现在脚本内置了一个
> **纯 Node 写的最小 PDF**，任何机器都能生成；有 LibreOffice 时仍会用
> 它转出的中文版覆盖掉（本地行为不变）。
> 想强制走最小 PDF 那条路（复现 CI）：`PI_GUI_SKIP_LIBREOFFICE=1 npm run fixtures`。

## 二、`npm test` 的定位

**`package.json` 的 `test` 脚本是测试入口的唯一真相。** CI 只调 `npm test`，
不把子测试抄进 workflow —— 抄一份就会有两个真相，以后加了新套件漏改一处，
就是「本地跑了、CI 没跑」的假绿。

P15 的 `tests/extensions.cjs` 使用 `os.tmpdir()` 中的 Pi 目录和假 RPC，覆盖发现、
作用域、重复、坏 metadata、缺失 package、路径越界、command 关联、未知工具、
状态区分、重启与项目隔离、错误脱敏和不支持的写操作。P15-Fix 增加目录 manifest、
settings 目录解析、override 优先级、package filter、空 filter、manifest glob 与路径保护
的 parity fixture，以及纯 helper 直接测试（包括空 manifest 与 filter 回退的源码差异）。
符号链接 fixture 若无系统权限会跳过并单独报告，不计入通过数量。`tests/smoke.cjs` 检查
Extensions 独立标签及列表与详情渲染。它们不启动真 Pi、不安装包、不访问网络。
Pi RPC 没有 tool registry，真实 tool 来源需要上游新增可验证接口后才能做 live 对拍。
（P20.5 在 **0.99.1** 上再次确认、P20.6-Fix 在 **0.99.2** 上第三次确认：
33 条 RPC 命令里没有一条返回已注册工具清单，`rpc-types.d.ts` 两版 diff 为空。
`tests/pi-version.cjs` 把这条钉住了。）

`npm test` 里现在有 36 个套件，全部是**纯自动化**：

```
smoke 1062 · git 161 · modules 117 · reliability · interactions · port-owner
project-config 115 · skills 196 · extensions 52 · web-access 66 · subagents 141
memory 236 · browser 215 · approvals 80 · planner 115 · workflow-relations 71
reviews 133 · review-gate 217 · verification 136 · evidence 100 · attempt-lifecycle 98
sessions 77 · session-search 71 · pi-compat 57 · pi-version 136 · mcp-native 187 · usage-quota 229 · body-integrity 5
dev-server 20 · models-api 50 · server-security 36 · diagnostics 13 · update-check 87
version-consistency 34 · release-artifacts 70 · electron-guard 76
```

> `reliability` / `interactions` / `port-owner` 是早期套件，只打印
> `X: passed`、不报条数（断言失败就直接抛）。**没有数字不等于没有断言**，
> 所以别拿这张表去推「总共有多少条」—— 那个数字看 `npm test` 的实际输出。

`workflow-relations`（P7）测的是任务 ↔ 会话 / 任务 ↔ 文件的全部关系语义，
见 [workflows.md](workflows.md)。它和 `planner` 一样全程 `os.tmpdir()` + fake adapter，
**不 spawn 真 Agent、不联网、不消耗额度** —— 所以能进默认 CI。

`attempt-lifecycle`（P8-B）测的是 retry / cancel / stop / shutdown / restart 对**历史**的影响：
允许重试的状态表、Retry = 新 attempt 而不是重写历史、每次 attempt 的
session/files/snapshot/outcome 各自独立、终态 Plan 重试后能再次执行、
下游重新评估且历史保留、取消与关闭只形成一条记录、硬崩恢复补的那条「结论明确、
细节留空」、以及 A→B 的核心 E2E。

它的 **G 段**（`G. Active Plan 的生命周期操作作用于 active.plan`）测的是运行期所有权：
计划仍 active 时 retry 已完成的任务被拒（`plan-active`）且**不会自动执行**；
cancel / skip 一个尚未开始的任务时改的是 **Scheduler 的 `active.plan`**，所以在
Scheduler 收尾整份写盘之后**改动仍然在**（不会被冲回 `pending`），并且那个任务
**从未被执行、不产生假 attempt**；非 active 时 cancel / skip 的行为不变。
这几段的判据都刻意用「Scheduler 收尾之后磁盘上的状态」，而不是「接口返回了什么」
—— 原来的缺陷正是「接口返回 ok、磁盘随后被覆盖」。

`reviews`（P8-A）测的是人工审阅的数据契约：归一化与旧数据兼容、`verificationSnapshot`
的冻结时机、审阅资格（成功可接受、失败/取消/中断不可接受、运行中不可审阅）、
按 attempt 精确定位、`revision` 冲突（含**真的并发**两个请求只允许一个成功）、
持久化与清除、重试不覆盖历史、计划编辑不擦审阅、跨项目 403、隐私，
以及写盘失败必须如实报错。同样全程 fixture。

`review-gate`（P11 / P12，217 条）测**人工验收门控**（可选的工作流策略）：把审阅从「事后记录」
升级成「下游要不要等」的条件。同样全程 fixture（真 git + fake adapter，不 spawn 真 Agent）：

- **A / B 段**（纯函数）：`reviewGateState` 只看**最新一次成功** attempt 的 review
  （**旧 accepted 不跨 Attempt 继承**）；`dependencyStateOf` 的原因与优先级 ——
  **执行失败 > 等人工验收**，上游真失败了绝不能说成「在等验收」。
- **C / D 段**（端到端）：门控真的挡住调度（下游 `blocked` + `waiting-review`，
  Plan `paused`）；accepted 之后下游变 `ready` 但**不自动执行**；多级门控；
  无门控时行为与旧实现完全一致；最后一个 gated 任务没被接受时 Plan **不能**
  `completed`，接受之后 `completed`，再改回 `needs_changes` 又退回 `paused`。
- **E 段**：Retry 之后门控**重新关上** —— Attempt1 的 accepted 不被沿用，
  Attempt2 成功 + pending 时下游重新 `blocked`。
- **F 段**：Verification 结果（跑过 / 通过 / 失败）与 `changeEvidence` 都**不参与**门控；
  failed / cancelled / skipped / interrupted 的依赖者各说各的原因，**不冒充**「等验收」；
  老 Plan 缺字段 → false，schemaVersion 不变。
- **G 段**：revision 冲突与写盘失败都**不改变 DAG**；`PUT Plan` 可开/关门控并**就地重算**
  下游；重启后从持久化 review 重算；跨项目审阅被拒。
- **H 段**：门控字段里只有任务 id 与稳定枚举，没有可注入的内容（标题是不可信文本）。
- **I 段（P12 · Blocker A）**：`required` 把「有没有成功产出」和「有没有过」分开 ——
  失败 / 取消 / 中断 / 跳过 / 还没跑 → `required=false`，于是这些**不进「等验收」**：
  gated 任务跑失败时 Plan 是 `failed`（或与**无门控的同构计划完全同态**的
  `paused + dependency-blocked`），`workflowReason` 不是 `waiting-review`，
  `reviewGateSummary.waiting` 不算它。`status=success` 却没有成功 attempt 的老数据
  仍按等验收处理（不静默放行下游）。
- **J 段（P12 · Blocker B）**：真并发窗口（A 立刻成功、X 拖住 session、B 依赖 A）——
  运行中把 A 标 accepted 后，**这一轮**不启动 B（attempts 仍为 0），
  无关的 X 照常跑完，Plan 落 `ready`，用户再点开始才执行 B → `completed`；
  反向（accepted → needs_changes / pending）则回到 `blocked + waiting-review`。
  还断言 accepted 没被 Scheduler 的整份写盘冲掉。
- **K 段（P12 · Retry × Barrier，22 条）**：真并发的**第三条**路 ——
  A 成功 + 已验收 → **Retry A** → A 回到 pending（attempt1 的 accepted 留在历史里）
  → session 开始 → A 的 attempt2 成功、在窗口里被 accepted。
  老判据 `enabled && !satisfied` 在 session 开始时**看不见**这道门，
  于是这一轮把下游跑掉；修好后下游 **attempts=0**、Plan 落 `ready`，
  用户再点开始才跑 → `completed`。顺带钉住 Retry 只动当前态、
  两次 attempt 的 review 互不污染、验收确实发生在 session 进行中。
- **L 段（7 条）**：`reviewGateSummary` 三个数各数什么 ——
  `satisfied` 只数 `required && satisfied`（「当前失败 + 历史 accepted」= 0），
  `waiting` 只数 `required && !satisfied`；老数据 `success` 无成功 attempt 仍算 `waiting`。
- **M / N 段（12 条）**：barrier 的两条边界 —— 多级门控（中间那道门是在 session 里
  通过的，最后一级也不自动跑）与多上游（只记没通过的那个，已验收的不挡人）。
  这两段**修复前后都绿**，是钉住不是反证。
- **O 段（21 条）**：判据矩阵。`shouldCheckpointGate()` 的 14 种输入（disabled /
  成功四态 / Retry 后的 pending / ready / failed / cancelled / interrupted / skipped /
  running / 没跑过 / 老数据），加上 `gateCheckpointsFor()` 直接断言 **checkpoint 的
  内容**（`{downB: ['gateC']}` 这种），把「下游跑没跑」的端到端反推换成看得见的表；
  还断言 `reviewGateState` 的历史语义**没被改**（Retry 后仍 `satisfied=true, required=false`）。

> **守卫验证过会红**：把门控判定临时退回旧行为（忽略门控 / 拿**第一次**成功尝试），
> 本套件 **27 条**失败 —— 包括「下游直接跑掉」与「旧 accepted 被沿用」这两条 blocker。
>
> **P12 的两条 blocker 同样验证过会红**：拿这份测试跑**改动前**的实现 → **23 条**失败
> （I 段 19 条 = Blocker A，J 段 4 条 = Blocker B，其中「B 在这一轮被自动执行掉了」
> 是那条正主）。
>
> **Retry × Barrier（本轮）的反证也先跑过一遍**：测试先加在**改动前**的实现上 →
> `review-gate` **188 passed / 7 failed** —— 4 条是正主（K14「downB 这一轮被自动执行
> 掉了」+ K17 / K18 / K20，Plan 直接跑成了 `completed`），2 条是 C2 汇总
> （L1 / L6：把「当前失败 + 历史 accepted」算进 `satisfied`），1 条是我夹具写错
> （L4 把从没跑过的任务设成 `status=success`，撞上 §5.9 的老数据例外，改回 `pending`
> 后按设计通过）。同一份测试跑 `smoke` → **808/809**（G17 显示「门控已通过」）。
> 改判据之后：`review-gate` **217/0**、`smoke` **809/809**。

`smoke` 里的 **P11 / P12 段**（17 条）测门控的**前端行为**：`人工门控` 标记与五种状态文案
（含 P12 新增的「执行未成功 · 门控未开始」—— 执行失败时**不能**写「等待人工验收」，
更不能写「门控已通过」：`required=false` 必须排在 `satisfied` **前面**判，
否则 Retry 之后「当前没成功 + 历史 accepted」会被显示成已通过）、
下游「等待人工验收：<上游 id>」、上游失败时**不**说成等验收、Plan 顶部那句
「已暂停：等待人工验收」与门控汇总、任务上的勾选框（默认状态 + 勾选后保持）、
以及恶意 task id / 上游 id 全部按纯文本渲染。

`smoke` 里的 **P13 段**（39 条 = 主体 29 + 收尾 10，`smoke` 从 809 涨到 848）测
Planner 的收敛行为 —— 界面状态全部是 **runtime 推导 / 前端内存**，一条都不落盘：

- **下一步**（`derivePlanAttention`，纯函数）：七个分支各给一条断言
  （验证在跑 → 执行中 → 失败 → 被阻塞 → 等验收 → 收尾 → 可执行），一次只有
  **一个**主焦点，次级信息进第二行（「另有 N 个任务等待验收」）；
  给 CTA 的只有 `ready` / `focus-task` 两种，`running` 与收尾态**不给**按钮。
- **Attempt 默认只展开最新一次**：旧的收起但**内容仍在 DOM 里**；折叠头是真
  `<button>` + `aria-expanded` + `aria-controls`；展开/收起记在 `attemptOpen`，
  重绘、切计划、SSE 事件都**不许**把它改回去（Blocker 2）。
- **交互必需优先于默认**：审阅草稿 / 正在清除 / 独立验证在跑的那条**强制展开**
  （Blocker 3），用户显式收起**也认**（用户选择 > 交互必需 > 默认）。
- **focus 到 attempt**：`openPlanner({planId, taskId, attempt})` 打开面板就展开
  那一条老尝试并滚到视口内（Blocker 4）。
- **Review 草稿跨折叠不丢**：折叠头在 DOM 里、编辑态在 body 里 —— 收起后再展开，
  输入框与文字原样回来；切换计划 / 关面板才丢（**没保存的不该被持久化**，§四十五）。
- **§二十九文案**：`required=false` 且任务还是 `pending/ready/blocked/running` 时写
  「尚未产生新结果 · 门控未开始」（还没跑过 ≠ 执行未成功），真失败/取消/中断/跳过
  才保留 P12 那句「执行未成功」；`no-successful-attempt` 分支不动。
- **动作层级**：等待人工验收时任务上的主动作是「验收结果」（不是 Retry），
  执行结果 / 证据 / 打开会话都排在它后面；点它会跳到该 attempt 的审阅编辑器。
- **P13 收尾 A：runnable 的口径**（A10–A12）：`有 N 个任务可以执行` 的 N
  **只数 `status === 'ready'`** —— 断言写的是**精确文案** `有 1 个任务可以执行`
  （夹具 = A ready + B pending(dependsOn A) + C success）；`/可以执行/` 这种正则
  对旧实现照样绿，等于没测。ready 计划数不出 ready 任务 → 降级 `计划待执行`，
  **不拿 pending 凑数**。反证实测：旧实现（`ready || pending`）跑 A10/A11 红，
  实际输出 `有 2 个任务可以执行`。
- **P13 收尾 B：折叠头的人工验收一格**（B11–B17）：成功三态照实显示
  （`待审阅` / `已接受` / `需修改`）；failed / cancelled / interrupted + `pending`
  **不渲染这一格**（R4–R6，执行状态那一格照常）、失败 + `需修改` 仍显示（R7，
  人为标记不被抹掉）；历史隔离（§二十五）：`pair` 的 Attempt 1 成功·已接受
  不被 `task.status=failed` 改写，Attempt 2 失败不写「待审阅」。断言看
  `.planner-att-review` **元素在不在**（`null`），不是看文字包不包含。反证实测：
  旧实现（`REVIEW_STATE[reviewOf(a).status]`）跑 B14/B15/B17 红，实际输出
  `{"review":"待审阅","state":"失败"}`、`{"cancelled":"待审阅","interrupted":"待审阅"}`。

> **夹具共享的坑**（记在这里免得再踩一次）：P13 段一开始直接拿 `stubPlanReview`
> 测草稿，结果两条断言红 —— 因为**前面的 P8-C 段会就地改这个夹具**（保存审阅、
> 开验证），跑到 P13 时它已经不是原样了。现在 P13 用的是进程启动时拍下的快照
> `stubPlanDraft`。**看数据被改过没有，别信「我这个段没改它」。**

`smoke`（`npm run test:ui`）里的 **P8-C 段**（63 条）测人工审阅的**前端行为** ——
后端契约已经有 `reviews` 覆盖，所以这一段只测界面怎么解释它：

- 三种审阅态的文案；状态**带文字**不只靠颜色；失败 / 取消 / 被中断
  **只有「需要修改」**；运行中的那一次不给审阅操作。
- 点状态按钮只进编辑态、**不发请求**；说明 `maxlength=1000` 与字数反馈；
  保存带上 `expectedRevision`（夹具里是 3，用来证明它**不是写死的 0**）。
- 保存**不顺手重试任务**（只允许 `PUT …/review`，没有 retry / cancel / skip）。
- 清除走**同一个** API（`status=pending`）且先确认。
- 保存失败显示**后端原话**、输入不丢、按钮变「重试」；
  冲突显示「已在其他窗口被修改」+「重新加载」、**本地输入不丢**、
  **不自动重试**（只发一次请求）、不 last-write-wins；
  「重新加载」只重拉一次 plan detail。
- 验证快照三种情形（`command` / `description` / 无快照 + 「当前任务验证要求」）
  与「尚未独立确认」；全卡片**不出现**「验证通过 / 已验证」字样。
- 当前 diff 的**两个分支**：把 Git 工作区状态打桩成「只有 mod-0 还有差异」，
  于是「给按钮」与「已无该文件的未提交差异」都被真的断言到。
- 说明的 XSS：`<img onerror>` / `<script>` / `<svg onload>` 一律按纯文本渲染，
  **DOM 里注入节点数为 0**。
- Plan 汇总的**最新一次 attempt 规则**与分母（失败 / 取消 / 被中断不进「待审阅」）。
- **stale 守卫**：保存还没回来就切项目（`S.workspaceGeneration++`），
  响应回来后**界面零变化**，别的 attempt 也不受影响。
- **收口两项**（P8 最终验收的 blocker）：
  * 汇总把 `interrupted` **单列**成「中断」，不并进「失败」——
    含一条「中断为 0 时不显示『中断 0』」的断言（换一个没有 interrupted 的
    夹具真的重画一次），以及「明细里仍写『被中断』」的对照断言。
  * 切项目之后旧面板的临时状态被清理：**不留永久「正在保存…」**、
    旧面板被收成提示且**没有可点的审阅控件**；再加一组**实例隔离**断言 ——
    旧面板的响应回来时**不会关掉后来打开的新 Planner**、也不往它里面写提示。
    （modal 只有一个槽位且没有实例 token，所以这条边界必须真的测。）

`verification`（P9，86 条）测 **Pi GUI 自己跑命令**这件事。绝大多数用**注入的假
`runShell`**（确定性、不 spawn 真进程），只有最后一节故意用真 shell 跑一条无害命令，
证明那条路真的通：

- 跑起来、拿到真结果：启动先落盘 `running`（结论字段一律为空）→ 结束写
  `passed` / `failed`，退出码 / 耗时 / 输出摘要齐全；命令起不来与超时都算 `failed`
  并说明原因（不冒充「跑失败了」）。
- 输出上限：落盘摘要截到 2000 字符、**保留末尾**、带 `truncated`，
  并断言计划文件实际大小仍在 KB 级。
- 准入拒绝（`code` 是契约）：`no-command`（含「只有 description」那条独立措辞）、
  `attempt-not-found`、`invalid-cwd`（目录不存在 / `../` 逃逸）、`workspace-stale`、
  `no-project`、`plan-active`、`already-running`。
- 收口：停止 → `interrupted`；优雅退出 → `interrupted` 且退出之后回来的结果
  **不会**把它改写；硬崩 → `recoverAll()` 才翻；**普通 `load()` 绝不翻**
  （否则前端轮询会把正在跑的那次标成中断）。
- 不变式：验证**不改** `task.status` / `outcomeStatus`、不自动 Retry、
  验证通过不把 `needs_changes` 改成 `accepted`、验证失败不改写 `accepted`。
- Retry：旧 attempt 的验证结果原样保留，新 attempt 默认没有，两者命令各自独立。
- **两个写者**（三组）：验证跑着时保存审阅 → 两边都在；已有验证结果时保存审阅 →
  验证结果不丢；Scheduler 整份写盘 → 验证证据不丢。
  最后一组**验证过会红**：去掉 `mergeExternalAttemptState` 里那行合并，它立刻报 `null`。
- 重复验证是**替换**不是追加；老计划（没有该字段）读得出来且照常能验证；
  `schemaVersion` 仍是 1。

`smoke` 里的 **P9 段**（27 条）测验证的**前端行为**：有命令才给「运行验证」、
只有 description 不给按钮、四种状态文案（都带文字）、命令 / **执行目录** / 退出码 /
耗时 / 输出摘要、长命令与长目录有 `title`、**输出与目录都按纯文本渲染
（XSS 注入节点为 0）**、点运行/停止调对接口、被拒绝时显示后端原话、
**老 attempt 的 fallback 有明确说明**（不冒充冻结记录）、切项目后旧响应不写界面，
以及**验证在跑时的动作锁**（开始执行 / 保存修改 / 删除计划 / 重试 被禁用 +
把原因写出来，锁释放后恢复）。

**验证在跑时的排他（P9 收口）** 在后端由 `verification.cjs` 的 **L 段**（49 条）盯：
计划在跑时**任何** Plan 的验证都拒绝（含「同一个 workspace 的另一个 Plan」）、
同一 attempt 连点是 `already-running`、另一条是 `verification-active`、
反向闸门（Scheduler / Retry / PUT / DELETE / 切项目）、**Review 保存仍允许**、
以及各种收尾（通过 / 失败 / 起不来 / 超时 / 中断）之后**锁都释放**。
`M 段`（32 条）盯 **cwd 快照**：attempt 开始时冻结、改 task 不影响旧快照、
Retry 冻结新值、两次互不覆盖、老 attempt 走 fallback 且**标记来源**、
绝对路径 / `../` / 已删除目录一律 `invalid-cwd`（不退到 fallback 静默跑别处）。

`evidence`（P10，100 条）测**历史变更证据**（attempt 冻结的 Diff），全程 `os.tmpdir()`
上的真 git 仓库 + 注入的假执行器：

- **A 段**（纯函数）：unified diff 切块（带空格 / 带 TAB 的路径、`rename from|to`）、
  numstat 与 diff 文本两条来源合并、上限与截断标记、认不出的值退成默认（不猜）。
- **B 段**（真 git 端到端）：modified / added（untracked 新文件）/ deleted / rename /
  binary；路径一律**项目相对**、证据里**没有**绝对路径与临时目录泄露；
  以及 **dirty 基线**这条 blocker —— 执行前用户已改过时，patch 必须是 `2 → 3`
  而**不是** `1 → 3`。
- **C 段**（冻结，P10 的核心）：执行之后继续改工作区 / 变回 clean / 又产生新 diff，
  旧 attempt 的证据**一个字节都不变**；Retry 后两条 attempt 的证据互相独立。
- **D 段**：采不到证据**不是任务失败**（非 git 项目、没接采集、采集抛错、任务本身失败
  时照采）；**中断与硬崩不伪造** post 快照，如实标 `unavailable` + 原因；
  老 attempt 没有该字段 → 归一化成 `null`（**不假装有 Diff**）。
- **E 段**：四条写盘路径（Review / PUT Plan / Scheduler 收尾 / **Verifier 收尾**）
  都**不许**覆盖已落盘的证据。Verifier 那条刻意制造「验证还在跑」的窗口 ——
  期间把证据写进磁盘，再放行收尾，钉子就是「这几秒里别人写的东西没被盖掉」。
- **F 段**：文件数 / 单文件 / 总量三处上限、截断有显式标记、计划文件没膨胀到失控、
  XSS 载荷**原样**存进 patch（当文本，不做任何编码）。
- **G 段**（防回归）：用同一套组装逻辑喂两种**错误基线**做对照 ——
  「按当前工作区重算」给出 `1 → 999`、「拿 HEAD 当基线」给出 `1 → 3`，
  两者都与 B 段 / C 段的断言**不可能同时成立**。所以那两条断言只要被改坏就必红。
- **H 段**（项目只是仓库的子目录）：另建一个**独立的仓库**（`repo2/project` +
  `repo2/sibling`），当前项目是它的子目录，sibling 的改动由 fake 写出 `../sibling/…`
  模拟。钉住：只采项目内的变化、路径**不带仓库前缀**、sibling 全程不出现、
  只有 sibling 变化时是 `available + files=[]`、dirty 基线仍是 `2 → 3`、
  以及跨边界 rename 的安全降级（项目内 → 外 `deleted`、外 → 内 `added`）。
  ⚠️ 修这条边界时**最容易被忽略的是「只改 `worktreeTree` 不改 diff」** ——
  H 段会红。
- **I 段**（路径契约）：手工篡改的 `path` / `oldPath`（绝对路径 / 盘符 / UNC /
  `..` / 空段 / 超长）一律丢掉那条 evidence file，合法路径原样保留 ——
  并且与 `filesChanged` 用的是**同一个**判据（同输入同输出）。

`smoke` 里的 **P10 段**测前端：两个入口措辞分开（「查看当前 Diff」/「查看本次 Diff」）、
面板写明「之后的修改不会改变这里的内容」、文件默认收起 + 可全部展开、
`unavailable` / 老 attempt **不给按钮也不假装有**、binary / 截断 / 大量文件的说明、
以及路径与 patch **全部纯文本**（XSS 注入节点为 0）。

最后三个里，`version-consistency` 与 `release-artifacts` 是**发版守卫**：
前者管 package / lock / tag 一致与「构建链路里有没有写死版本号」，
后者管发布目录的资产命名、校验和与 P5 兼容性，**外加发布编排的分支表**
（用注入的假 gh 测：已发布必须拒绝、只剩 draft 才复用、核对不过绝不 publish）。
两者都在 `os.tmpdir()` 上跑 fixture，不需要先构建 —— 所以放在默认 CI 里是便宜的。

它们的共同约束（新加测试时要守住）：

- **不联网。** 上游接口一律打桩（`models-api` 自己起一个假供应商；
  `update-check` 把 `fetch` 作为依赖注入，默认测试**绝不**打真 GitHub）。
- **不 spawn 真 pi。** 需要 pi 的地方用桩 rpc，或者把 `PI_BIN` 指到不存在的命令。
- **不碰真实用户目录。** 数据目录、agent 目录、HOME 一律用 `os.tmpdir()`；
  写盘的用例（改 settings、会话改名/删除）**必须**走临时 fixture。
- **不需要模型额度。** 一条 prompt 都不发。
- **不需要显示器。** jsdom 跑前端，打包验证用 `node` 直接跑打包后的 `server.cjs`。
- **不依赖「跑测试这台机器装了什么」。** 要探测外部程序的地方用 **fixture 驱动**
  —— 造一个假的全局 npm 目录、把 `env.APPDATA` 指过去；要验「能 spawn 外部命令」
  就给一个假的 `.cmd` shim，而不是断言「本机装了 pi」。

最后一条是真实踩出来的，值得单独讲（三处都让 CI 红过）：

> **① `tests/planner.cjs`** 原来断言「pi 能被探测到，且能力里有 toolEvents」，
> 而它拿的是 `process.env`。结果这条断言**在开发机上是绿的、在干净的 CI runner 上直接红**
> —— 它测的不是 registry 的逻辑，而是那台机器的状态。
>
> 探测逻辑真正依赖的是 `env.APPDATA\npm\node_modules` 这条路径（`server/agents/cli.js`
> 的 `npmGlobalRoots`），而 `env` 本来就是注入进 registry 的 —— 所以这件事**本来就能测**。
> 现在用 fixture 造出「什么都没装」与「装了 pi + codex」两种世界，分别断言
> `not-installed`、`entry-missing`、版本号、入口类型，以及 `auto` 的解析规则。
>
> **② `tests/app-check.cjs` / `tests/exe-check.cjs`** 同样断言「pi 子进程已拉起」。
> 这里要验的其实是**打包出来的应用还能不能 spawn 外部命令并跟踪它的生命周期**，
> 与「本机装没装 pi」无关。现在给一个假的 `.cmd` shim（`PI_BIN` 指过去），
> 它只负责活着 —— 断言因此在任何机器上都确定。
>
> **③ 这两个测试还依赖 PDF 固件**，而固件原本只能靠 LibreOffice 转（见上面 B 层的说明）。
>
> ⚠️ 顺带一个坑：本地模拟 CI 时**只把全局 npm bin 从 PATH 里摘掉是不够的** ——
> 那条路径跟 PATH 无关，`pi` 照样会被探测到，于是模拟是绿的、真 CI 是红的。
> 模拟干净 runner 要把 `APPDATA` / `LOCALAPPDATA` 也一起指走。

## 三、CI 里跑什么

三个 workflow，分工按「多贵」划：

| workflow | 触发 | 内容 | 为什么这样分 |
|---|---|---|---|
| `ci.yml` | push / PR 到 main、手动 | `test`（matrix Node 22/24 跑 `npm test`）+ `build-check`（`build:app --rebuild` → `test:app` → `test:exe`） | 每次提交都要跑的便宜层。`build-check` 刻意**不**跑 `build:installer` —— 那要 NSIS 和 ~430MB 产物 |
| `release-check.yml` | **手动**（`workflow_dispatch`） | 完整发布路径：`npm test` → 两条打包链路 → `test:app` / `test:exe` / `test:portable` / `test:installer` → `release:collect` → `release:verify` | 45-60 分钟，**不创建 Release**。挂到每个 PR 上会让贡献者等到放弃；而 PR 需要的版本一致性守卫已经在 `npm test` 里 |
| `release.yml` | **tag `v*`** | `npm run release:check -- --tag=<tag> --with-installer` → draft → 上传 → 核对 sha256 → publish | 正式发布。**全部验证通过之后才碰 GitHub**，所以失败不会留下半成品 |

三者调用的是**同一套 npm 脚本**，没有各自手写构建逻辑 ——
`release.yml` 更是直接调那一条 `npm run release:check` 入口。

`ci.yml` 的 `build-check` 只验两条打包链路能出产物；安装程序 / 便携版的真装真跑
放在后面两个 workflow 里，因为那要 NSIS 与 ~430MB 产物。见下一节。

### Node 版本：最低 22.19，CI 测 22 与 24

`package.json` 的 `engines.node` 是 **`>=22.19`** —— 这个下限由依赖链决定，
不是随手定的：

| 来源 | 要求 | 说明 |
|---|---|---|
| `pi-coding-agent`（被 GUI 驱动的那个 pi） | `>= 22.19.0` | 装 pi 本身的要求，也是这里的上限来源 |
| `pdfjs-dist` | `>=22.13.0 \|\| >=24` | **运行时依赖**，PDF 抽取用 |
| `electron` / `@electron/packager` 等 11 个 | `>= 22.12.0` | 开发依赖（打包链路） |

取其中最严的一条 ⇒ **22.19**。

CI 的 matrix 是 **22 与 24**：22 是这条下限所在的大版本，24 是当前最新
（也是开发机在用的版本）。不按 22.19 建 matrix —— 那只会多出一个几乎重复的
runner，而 22.x 内部的补丁差异不是这个项目要防的风险。

## 四、不进默认 CI 的测试

### D. 真 pi 验证

| 命令 | 要真 pi | 会发 prompt | 说明 |
|---|---|---|---|
| `npm run test:skills-live` | ✅ | ❌ | 拉起真 pi 用真 `get_commands` 对拍；启动 6 次 pi，约 2-3 分钟 |
| `npm run test:reliability-live` | ✅ | ❌ | 异步链路与状态审计的真机对拍 |
| `npm run test:inject` | ✅ | ⚠️ 会发一条 `ping` | 断言点在 provider 请求**之前**（扩展在 `before_agent_start` dump 系统提示词），但严格说仍可能产生一次极小的模型调用 |

**为什么不进 CI**：CI 里不装 `pi-coding-agent`（它是被 GUI 驱动的外部程序，
不是这个仓库的依赖）。装了也会让每次 push 多花几分钟，还会因为模型调用产生额度
消耗 —— 而这三条要验的是「pi 真的会那样应答」，属于**发布前 / 改动协议相关代码后**
才需要跑的验证。

### C. 安装程序

`test:portable` / `test:installer` 需要先 `npm run build:installer --zip`，
而 `build:installer` 需要 **NSIS 的 `makensis`**（本机是从 electron-builder 的缓存里
白捡的，见 `scripts/util.mjs` 的 `findMakensis()`）。GitHub 的 windows runner
不预装 NSIS，要现装。

因此它们放在**手动触发**的 `.github/workflows/release-check.yml` 里，
并且可以用输入项关掉（`installer: false`）。

`test:installer` 会真的安装、建快捷方式、启动一次、再卸载。runner 是一次性虚拟机，
所以这是安全的；但它比 CI 慢一个量级，不该挂在每次 push 上。

> ⚠️ **受限环境里 `reg.exe` 会被安全策略拉黑** —— 那时 4 条注册表断言
> （以及解析不到桌面目录时的桌面快捷方式断言）会被**跳过**，而不是误报失败；
> 跳过的条目会在输出里逐条点名。GitHub runner 上一般都能跑全。

### E. 界面视觉核对

jsdom **不做布局**（`getBoundingClientRect()` 恒为 0，也不套用外部样式表），
所以「排版对不对」在 `npm test` 里是测不出来的 —— 断言全绿也说明不了问题。

| 命令 | 用途 |
|---|---|
| `npm run harness` | 起视觉夹具（静态托管真 `public/`，`/api/*` 全换成脚本数据） |
| `npm run shots:harness` | 用无头 Chrome + CDP 截图 |
| `npm run test:window` | 窗口状态记忆（关掉再开，窗口不能每次变大一点） |

改了 `public/` 里的样式或布局之后，**必须真看一眼截图**，不能只看测试是不是绿的。

**P8-C 人工审阅的场景**（`shots:harness` 的 11–22）：夹具在
`tests/visual-harness.cjs` 的 `PLAN_DETAIL` 与 `PLAN_STRESS` 里，
**全部是脚本数据，不跑任何 Agent**。它把审阅 UI 的每条分支都摆了出来：

| 场景 | 验什么 |
|---|---|
| `11-rev-summary` | Plan 顶部两行汇总（执行结果 / 成功结果审阅） |
| `12-rev-pending` | 成功 + 待审阅 + 验证要求（`description`）+ 会话 + 当前 Diff 入口 |
| `13-rev-accepted` | 已接受 + 说明 + `reviewedAt` |
| `14-rev-needs-changes` | 需修改 |
| `15-rev-retry-history` | Attempt 1 已接受 + Attempt 2 执行中（运行期不给审阅操作） |
| `16-rev-failed` | 失败的 Attempt **只有**「需要修改」 |
| `17-rev-null-snapshot` | 没有历史验证要求 → 另起一行标「当前任务验证要求」 |
| `18-rev-editor` | 编辑态：状态选择 + 说明 + 字数 + 保存 |
| `19-rev-conflict` | 冲突：本地输入保留、等用户点「重新加载」 |
| `20-stress-long-note` | 压力：1000 字说明 + 20 个变更文件 + 超长路径 |
| `21-stress-many-attempts` | 压力：10 次尝试 |
| `22-stress-narrow-700` | 压力：窄窗口 700px（脚本会打印是否横向溢出，判据是**数值**不是肉眼） |

**P9 独立验证的场景**（`shots:harness` 的 24–30）：

| 场景 | 验什么 |
|---|---|
| `24-verify-never` | 从未验证 ——「尚未独立确认」+「运行验证」 |
| `25-verify-passed` | 通过 —— 命令 / 退出码 / 耗时 / 输出摘要 |
| `26-verify-failed` | 失败 —— 失败输出 +「输出已截断」 |
| `27-verify-interrupted` | 已中断 +「重新运行验证」+ **老 attempt 的 fallback 说明**（黄色、明说证据强度更低） |
| `28-verify-running` | 正在验证… +「停止验证」（且**没有**结果行） |
| `29-verify-long` | 压力：长命令（带满参数）+ 长输出（含超长无空格行） |
| `30-verify-narrow-700` | 压力：窄窗口 700px 下的验证明细 |

> 夹具里 `live` 任务确实有一条验证在跑，所以 plan-1 的那些场景**同时**显示
> 「验证在跑」的动作锁（开始 / 编辑 / 删除 / 重试 被禁用 + 原因写在进度行里）——
> 摆出来界面才是一致的。`29-verify-long` 里那条超长**执行目录**（与长命令、
> 长输出挤在同一张卡片上）是这一轮新加的排版压力项。

**P10 历史变更证据的场景**（`shots:harness` 的 31–37）：

| 场景 | 验什么 |
|---|---|
| `31-attempt-diff` | 历史 Diff 面板：标题 +「之后的修改不会改变这里的内容」+ 路径 + `+n −n` |
| `32-attempt-diff-added-deleted` | 新增（A）/ 删除（D）的类型标记与增删行数 |
| `33-attempt-diff-binary` | 展开二进制那行：只说「二进制文件已变化，不展示文本 Diff」，**没有** patch 块 |
| `34-attempt-diff-truncated` | 展开被截断那行：patch + 文件级「已截断」（面板级另有一处「历史 Diff 已截断」） |
| `35-attempt-diff-unavailable` | 采不到的 attempt：卡片上如实写原因，**不给按钮** |
| `36-attempt-diff-long` | 压力：超长路径 + 超长单行 patch（脚本会打印是否横向溢出） |
| `37-attempt-diff-narrow-700` | 压力：窄窗口 700px 下的历史 Diff |

> ⚠️ **33 与 34 要各自展开对应的那一行再取景**：`shot()` 截的是**整个视口**
> （`Page.captureScreenshot` 不带 `clip`），两行同在一张卡片上、滚动位置又一样时，
> 都是收起状态就会截出**同一张图** —— 那样等于有一条没验。
> `35` 拍的是 attempt 卡片而不是弹层：`unavailable` 时**根本没有**可点的入口。

**P11 / P12 人工验收门控的场景**（`shots:harness` 的 38–45，夹具是 `plan-gate`）：

| 场景 | 验什么 |
|---|---|
| `38-review-gate-pending` | 执行成功但**等待人工验收**（badge + 文案 + 第几次尝试） |
| `39-review-gate-accepted` | 已接受 → 「门控已通过」 |
| `40-review-gate-needs-changes` | 需修改 → 「需要修改 · 门控未通过」 |
| `41-review-gate-downstream-blocked` | 下游「等待人工验收：gated-a」（**带上游 id**，不只写「blocked」） |
| `42-review-gate-plan-paused` | Plan 顶部「已暂停：等待人工验收」+「人工门控 1/5 已通过 · 待验收 3」（`satisfied` 只数**已放行**的，历史 accepted 不算） |
| `43-review-gate-editor` | 任务上的「需要人工验收后再继续下游」勾选框 |
| `44-review-gate-narrow-700` | 压力：700px 下**超长标题** + 门控行 + 下游等待原因 |
| `45-review-gate-retry-pending` | P12→P13：重试排队中 —— attempt1 曾被接受（历史），当前这次还没跑 → 「尚未产生新结果 · 门控未开始」，**不是**「门控已通过」，也**不是**「执行未成功」（§二十九：还没发生的执行不算失败） |

**P13 下一步 / Attempt 折叠的场景**（`shots:harness` 的 46–56，夹具见下）：

| 场景 | 夹具 | 验什么 |
|---|---|---|
| `46-next-action-ready` | `plan-ux` | 下一步：`有 1 个任务可以执行` + **「开始执行」**（唯一给 CTA 的分支）。P13 收尾起 `mustTrue` 检查文案**精确等于**这句话（数量是数出来的，不是写死的） |
| `47-next-action-review` | `plan-wait` | 下一步：`验收 gated-main 的最新成功结果` + 「查看任务」（点名到任务，不写「去验收」） |
| `48-next-action-verification` | `plan-1` | 下一步：`正在独立验证 live · 第 1 次尝试` —— 优先级最高，**压掉**「开始执行」 |
| `49-attempt-history-collapsed` | `plan-1` | 历史默认收起：两条尝试 → `aria-expanded` 依次 `false,true`，旧那条 `body.hidden=true` |
| `50-attempt-history-expanded` | `plan-1` | 手动展开后 `true,true`，展开内容**有实际高度**（不是空壳） |
| `51-attempt-history-10` | `plan-stress` | 10 次尝试只展开 1 条（第 10 次），9 条历史一条不少 |
| `52-attempt-head-summary` | `plan-1` | 折叠头四个维度各占一格：执行 / 验证 `正在验证…` / 验收 `已接受` / 证据；验证在跑 → 强制展开 |
| `53-focus-attempt` | `plan-1` | `openPlanner({taskId, attempt:1})` 新开面板就展开**老那一条**并滚进视口（默认规则会收着它） |
| `54-next-action-narrow-700` | `plan-ux` | 700px：下一步那一行不横向溢出、CTA 仍在视口里 |
| `55-next-action-blocked` | `plan-gate` | 下一步：`处理被阻塞的任务 gated-faildown` —— 「被阻塞」排在「等验收」**之前**，这一支的优先级看得见 |
| `56-attempt-failed-compact` | `plan-1` | **P13 收尾**：失败的 Attempt 折叠头**没有** `.planner-att-review`（结构判据），验证 / 证据两格照常，展开的审阅区仍写「待审阅」—— 收起 ≠ 删状态 |

> 夹具全是**新计划**（`plan-ux` / `plan-wait`），不是改旧的：`plan-gate` 里有一条
> `dependency-failed` 的下游（P11 的场景要它），为了截图好看去动它会把 P11/P12 的
> 断言一起带跑偏。计划列表的顺序就是 `pickPlan(i)` 的下标，**改顺序会打乱所有场景号**。

> **结构判据（P13 新增）**：`shotOf()` 的第 5 个参数 `mustTrue` 是**必须为真的
> 页面表达式** —— 因为「收起 / 展开」在截图和 `textContent` 里**长得一模一样**
> （收起的节点还在 DOM 里，文本照样算进去）。折叠头是不是真 `button`、
> `aria-expanded` 的值、`hidden`、展开后的实际高度，全靠它算出来；任一条不成立
> 就进失败清单、`cdp-shot.cjs` 以退出码 1 结束。P13 收尾先跑红再改的：
> 修复前 `56-attempt-failed-compact` 报 `结构判据不成立 —— 折叠头没有「待审阅」`
> （退出码 1），改完 46–56 全部 ✓。

> **截图的判据不靠人眼**：`shotOf()` 现在会把「被取景的那个元素」打出来 ——
> 矩形在不在视口里、归一化后的文本、以及该场景的关键词齐不齐 —— 并把关键词缺失 /
> 取景中心不在视口内记成失败，`cdp-shot.cjs` 有失败就以退出码 1 结束。
> 所以上面这两张表的每一行都有日志里的机器可查对应物（本轮 38–56 全部 ✓）。
> 判据用「取景中心落在视口内」而不是「矩形完全在视口内」：1000 字说明、10 次尝试
> 这类比视口还高的元素，后者按构造就永远失败。

**P14-A App Shell 的场景**（`shots:harness` 的 57–66，另有 `900/1200/1536-shell-width`）：全局导航与三列布局、多个 Session 及选中态、侧栏折叠、用量摘要和明细、More、Planner / 文件变更激活态、700px 与三档更宽视口。每个场景都检查目标在视口内，并用 `mustTrue` 验证唯一激活项、入口 handler、侧栏显隐和水平溢出；截图留在 `.shots/` 供人工复看。

## 五、发布前验证（F 层）

**一条命令**：

```
npm run release:check -- --with-installer
```

它按固定顺序跑完（顺序钉在 `scripts/release-check.mjs` 里，不靠记忆）：

```
版本一致性（含 tag）  →  npm test（A 层 36 个套件）
  →  build:app --rebuild  →  fixtures  →  test:app（25 项）  →  test:exe（47 项）
  →  build:installer --zip  →  test:portable（11 项）  →  test:installer（20 项，需 --with-installer）
  →  release:collect（集中到 dist-release/）  →  产物守卫  →  独立复算 SHA256
```

通过时最后一行是 `READY TO RELEASE`。

> **`--with-installer` 为什么是显式开关**：`test:installer` 会**真的安装**
> Pi GUI（写注册表、建快捷方式）再卸掉。一次性 runner 上没问题，但开发机上
> 可能装着一份你在用的 Pi GUI —— 跑一遍就把它卸了。所以本机默认不跑。
> 代价是：不带这个开关时，安装程序**没有被真正执行过** ——
> 半截的 `Setup.exe`（名字、大小、校验和全都正常）只有真去装才会暴露。

**CI 与 Release 用的是同一套**：`release.yml` 直接调这条入口，
`release-check.yml` 调同一批 npm 脚本。所以本机通过就意味着 CI 也该通过。

手动入口：GitHub Actions 里跑 **Release check**（`workflow_dispatch`，
不创建 Release）；正式发布是 tag 触发的 **Release** workflow。
完整发版步骤见 [releasing.md](releasing.md)。

> ⚠️ **`test:portable` / `test:installer` 必须在 runner 上真跑过一次。**
> 它们的失败模式常常是环境相关的，而本机环境比 runner **更宽松**：
> 仓库与 `TEMP` 都在 `C:`，而 runner 的 workspace 在 `D://`、`TEMP` 在 `C://`。
> 已经因此漏过一次（同盘限制，本机永远不触发）——见
> [development.md](development.md) 的「坑」一节。本机想复现跨盘可以用
> `subst D: <某个目录>` 造一个第二盘再把 `TEMP` 指过去。

## 六、环境隔离（改测试时的硬要求）

测试跑在开发机上，所以**任何一处忘了隔离都会打到真实数据**。已经踩过的坑：

- 为了验证会话改名，对着用户真实项目跑了一次 `set_session_name` —— pi 往他的会话
  文件里追加了一行。**写盘的用例一律用 `os.tmpdir()` 的 fixture。**
- `tests/dev-server.cjs` 一度没设 `PI_GUI_DATA`，于是 `server.js` 把仓库根当数据目录、
  读到了开发机上的 `projects.json`，把上次的项目当初始 cwd，**真的拉起了一个 pi 会话**。
  现在它显式隔离，并且有一条守卫断言「工作目录为空」盯着这件事。
- `tests/planner.cjs` 一度断言「本机装了 pi」—— 见上一节，它让第一次 CI 直接红。

CI 上这些坑大多不会触发（干净检出里没有 `projects.json`、runner 上没装 pi），
但**「靠开发机的偶然状态碰巧不触发」不算隔离** —— 行为必须在任何机器上都一样。
上面第二条与第三条都是**被 CI 抓出来的**，不是靠 code review 看出来的。

## 七、已知风险

1. **部分测试套件硬编码端口**（`tests/*.cjs` 里的 `7791`–`7799`）。
   这些端口落在**某些机器**的 Windows 动态端口范围里 —— 默认动态范围是
   49152 起，但有些机器被改成从很低的端口开始，那就正好覆盖了 7791–7799。
   被别的进程当临时源端口占掉时 `listen` 会报 `EACCES`，表现为随机假红。
   GitHub 的 windows runner 用默认动态范围，所以 CI 上不会撞到；
   但本机如果出现 `EACCES`，需要把端口改成动态分配。
2. **`docs/testing.md` 里的断言数量会随测试增长而过时**。它们只是「这些套件确实
   在断言东西」的量级参考，不参与任何判断 —— 真实数字以 `npm test` 的输出为准。
   不要为同步它们引入脚本生成文档。

## 八、相关文档

- [architecture.md](architecture.md) — 模块地图与数据目录
- [development.md](development.md) — 构建与发版（`test:app` / `test:exe` /
  `test:portable` / `test:installer` 需要先构建）
- [sessions.md](sessions.md) / [planner.md](planner.md) /
  [extensions.md](extensions.md) — 各子系统末尾都列了自己的测试入口
- [reviews.md](reviews.md) / [workflows.md](workflows.md) — 人工审阅与任务工作流的
  语义（审阅的**前端行为**测在 `smoke` 的 P8-C 段里，见第二节）
- [security.md](security.md) — 安全守卫由哪些测试盯着
- [diagnostics.md](diagnostics.md) — 诊断快照的采集范围、脱敏与隐私边界
- [pi-compatibility.md](pi-compatibility.md) — 兼容层测什么、升级 pi 后怎么验
- [updates.md](updates.md) — 版本检查测什么、为什么默认测试不访问 GitHub
- [releasing.md](releasing.md) — 发版流程（F 层在哪一步跑、产物守卫查什么）

## 九、P14-B Conversation 视觉验证

`npm run test:ui` 在 jsdom 中验证消息节点与控件语义、Thinking 默认折叠及用户选择在流式结束后的保留、工具详情与状态文字、多附件、Minimap 的当前项。jsdom 不计算真实布局，因此它的 class 或 `aria-expanded` 结果不能证明用户看到了什么。

启动 `npm run harness` 后运行 `npm run shots:harness`，CDP 在真实 Chrome 中对 69–85 场景截图并运行 `mustTrue` 结构判据：Bubble 的实际右对齐和最大宽度、Assistant 透明背景、Thinking 内容高度、Tool 状态、附件数量与高度、Minimap 定位、长代码的内部滚动，以及 700/900/1200/1536px 的无页面横向溢出。场景 57–68 仍先在原对话夹具上运行。截图保存在被忽略的 `.shots/`。

## 十、P14-C Composer 视觉验证

`shots:harness` 的 86–104 场景覆盖空态、单行、三行、textarea 达到高度上限、单/多/解析中附件、拖入态、Model/Thinking/Context 弹层、运行态 Stop、无项目锁定视觉夹具、700/900/1200/1536px、700×600，以及长 URL/路径/中文。`mustTrue` 检查真实矩形：Composer 与 `#stream` 同轴且在视口内；CSS 留白变量与实测高度相符；末条消息能滚到 Composer 上方；达到上限时 textarea 内滚；弹层在 Composer 上方且不被裁切；窄屏控件都在容器内且页面无横向溢出。锁定场景只在浏览器测试夹具中模拟已有的禁用状态，不修改项目选择逻辑。

修改 `public/` 后须重建可执行产物，避免源码验证与用户打开的打包版不一致。完整回归仍以 `npm test` 为准。

## 十一、P14-D Work Surface 验证

`test:ui` 检查四个一级视图、Rail 唯一激活、Chat 与 Composer 节点身份、草稿/附件/滚动保留、后台流式消息、二级 Modal 关闭后原视图保留和 Surface 容器唯一性。CDP 105–124 场景检查 Planner、Changes、Skills/MCP 的真实 Stage 布局，以及四档宽度和低高度；每张图附 `mustTrue` 结构判据。历史 Diff 仍检查二级 Modal。完整说明见 [work-surfaces.md](work-surfaces.md)。

## 十二、P14-E 中性控件与日用验证

`test:ui` 静态检查交互选择器不再引用旧黄色 token 或已知琥珀色字面量，同时验证成功会话切换、一级视图替换后的焦点及 Tab ARIA 关联。警告色 token 和状态呈现仍保留。`shots:harness` 从 126 起检查真实计算后的按钮文字、背景和边框颜色，覆盖 Chat、Composer、Popover、Planner、Git、Extensions、Modal、Confirm；响应式场景检查 700px、低高度及页面滚动边界。计算颜色只约束交互元素，允许警告、错误、成功、运行和 Diff 的语义色。真实 Electron 窗口仍需单独检查标题栏、拖拽区与原生窗口按钮避让。

Electron 的 `shots:app` 可带 `--size=700x600 --view=planner` 在隔离数据目录启动的打包应用中复核最小窗口、Stage 边界和标题栏；`test:guard` 检查最小窗口与状态恢复使用同一阈值。

CDP 场景 153 使用 701×602 复现 Windows DPI 取整，断言项目侧栏收窄且 Planner 列表与详情上下排列；仅测恰好 700px 会漏掉这一种真实窗口差异。

## P17 Subagent 验证

npm test 串行包含 tests/subagents.cjs（也可 npm run test:subagents）。fixtures 对照 0.73.1 的 SingleResult/WorkflowChildSummary/WaitCompletion，默认完全离线；不安装、不读真实 Agent、不启动真实 child 或 detached runner。UI smoke 验证实际 SSE stale/并发/Stop/Git 防抖/重启确认；真实 Chrome 场景 157/158 检查 workflow 与 background launch。live 人工流程见 [subagents.md](subagents.md)。

Supervisor fixtures 对照同一 revision 的 native-supervisor-channel.ts：status 的 pending 是数字，pending/list 是 public metadata 数组，reply 返回 replyTo/runId/agent。
hostile extra fields 验证 message/root/path/凭据及 raw output 不进入 DOM，包含未知 action、历史、安全降级和 runtime observation reset/stale。
现有 Subagent/Web/Planner 断言保留；真实 Chrome 场景 159 检查 Supervisor 标签、安全 metadata 与 raw payload 排除。

## P18 Pi Memory 验证

npm test 串行包含 tests/memory.cjs（也可 npm run test:memory，236 条）。
fixtures 对照 **pi-memory 0.4.2 的真实 tool schema 与 details 形状**（v0.4.2 tag 与
npm 发布包指向同一 commit `39e6b998`，`index.ts` 逐字节相同），
默认完全离线：不安装 Extension、不装 / 不跑 qmd、不读 `~/.pi/agent/memory`、
不改真实记忆、不联网、不调用模型。

覆盖：7 个真实工具（memory_write / memory_read / memory_search / memory_forget /
memory_restore / memory_status / scratchpad）的识别与生命周期文案；query / match
的边界；`count` / `removed` / `restored` 的真实性（缺字段不写成 0）；
`mode` 只信 result；`needsEmbed` / `embedStarted`；forget 的可恢复语义但
**不显示 recovery ID 与 recoveryPath**；status 的 qmd / collection / embeddings；
敏感字段（path/recoveryPath/dir/preview/content/env/token/apiKey/embedding/vector…）
在投影与 DOM 中都不出现；raw args/details/result 文本不进 DOM；hostile HTML 惰性；
runtime observation 的 generation / bridge run 隔离与 restart 清空；
installed / configured / loaded 三值；历史与实时同一投影、缺 details 降级。
回归：Session Search / Planner / Web / Subagent / Extension Registry / Changes 账本
与 git 刷新都不受影响。

P18-Fix 之后，契约测试还明确覆盖四件事：

- **请求意图 ≠ 成功证据**：`args.target` / `args.action` / `args.date` 只用于
  running 与请求信息；success 文案必须由 result `details` 证明。
  `memory_read` 四个 target、`scratchpad` 五个 action 各有「有证据 → 成功文案」与
  「只有 `{}` → …result unavailable」两条成对断言，`memory_write` 同理。
- **soft-failure（`details: {}`）**：既不误报 success，也不被强行改成 error
  （0.87.0 不传播 Extension 的 `isError`，GUI 只能断言「没有成功证据」；
  **0.99.1 会传播**，但「只认结构化证据」的策略在两个版本下都成立）。
- **`refresh` snapshot mode**：v0.4.2 的 `getSnapshotMode()` 只返回
  `stable` / `per-turn`（`refresh` 是仓库 main 上未发布的第三种）；
  测试钉住 `stable` / `per-turn` 会展示，`refresh` 这类不在白名单的**非空字符串**
  显示 `Snapshot: unrecognized`（不回显原值），字段缺失则完全不显示这一行。
- **history soft-failure 一致**：`memory_read`（`args.target=daily` + `{}` +
  raw `No daily log…`）与 `scratchpad`（`args.action=done` + `{}` +
  raw `No matching open item…`）在历史重建里同样降级为 result unavailable，
  raw 文本（含路径、SECRET、`<img onerror>`、`<script>`）不进 DOM。

UI smoke 的 P18 段落走真实 SSE：并发 id 隔离、逆序完成、`.tl-args` 为空、
不额外刷新 Git、不进 Changes 账本、不发 RPC、Runtime evidence 显示、
切项目期间丢弃旧事件、Stop 收尾、重启清空观察、旧 workspace 的确认框不重启。

真实 Chrome 场景 160/161/162 检查：写入与检索的文案、记忆正文与绝对路径不在 DOM、
recovery ID 与路径不展示、Extensions 页 Pi Memory 设置区的固定命令与真实运行观察。
这一轮同时修了 harness 的失真：真实 SSE 事件带 `bridgeRun`，harness 以前不带，
导致 Extensions 页的 runtimeObserved 在真实浏览器里永远显示「尚未观察到调用」
（fixture 不照真实形状造，把观察链路整条藏住了）。

live 是人工流程（不属于默认 CI，本阶段未执行），步骤见 [memory.md](memory.md)。
没有现场安装与真实模型时不能声称 live 通过。默认测试**不需要** qmd 或任何网络。

## P19 Approval 验证

npm test 串行包含 tests/approvals.cjs（也可 npm run test:approvals，80 条）。
完全离线：不装 permission Extension、不 spawn pi、不读真实 `~/.pi`、不执行 pi 代码；
能力探测跑在 `os.tmpdir()` 造的假 pi 包上。

覆盖：模型的真实字段与边界（缺失 `id` 拒弹、未知 method 拒绝、title/message/option 上限、
`scope`/`action` 恒为 null、`risk` 恒为 unknown、没有持久化决定）；
四种对话框的展示与应答（`confirm` 走统一确认层、`select`/`input`/`editor` 走输入弹层）；
`allowed`/`denied`/`answered`/`cancelled`/`expired` 五种终态；
重放去重（pending 与已结算都不重弹）；陈旧守卫（generation / bridgeRun / switching）；
桥接重启本地作废且**不发应答**；Stop fail-closed 取消并收卡；`timeout` 只收卡不发应答；
恶意 HTML 惰性、额外字段（env/token/apiKey/authorization/cookie/command/rawArgs）不投影；
**不存在「总是允许」按钮**；能力块在 unsupported 时明确说清且没有假按钮；
后端探测三值 + 缺包未知 + 不泄露 pi 包路径；
统一确认 foundation 回归（`confirmModal` / `dismissConfirm` / danger 无 Enter 捷径）。
回归：Session Search / Planner / Web / Subagent / Memory 都不受影响。

UI smoke 的 P19 段落走真实 SSE：统一确认层弹出、只有一次性的允许/拒绝、
重放不重复弹窗、允许走 `extension_ui_response`、已结算不再弹、Stop 取消并收卡、
切项目同步期间不弹新请求、重启清空并收卡。

live（人工，本阶段未执行）：装一个真实的 permission Extension，确认「拒绝」真的让
这次工具调用没有执行 —— 这是唯一能证明端到端拦截的步骤，见 [approvals.md](approvals.md)。

## P20 Browser Use 验证

npm test 串行包含 tests/browser.cjs（也可 npm run test:browser，215 条）。
**完全离线**：不启动 Chrome / Playwright、不联网、不登录任何站点、不安装任何包。
fixtures 对照 pi-browser-harness **0.11.0** 发布 tarball 的 `src/util/tool.ts` 与
`src/domains/*`（tag v0.11.0 与发布包逐字节相同）。

覆盖：全部 **40 个**动作的 start/success/error；`details.ok` 成功证据与闭集 `kind`
（`ok:false` 优先于 pi 的 `isError`；缺证据只显示「结果不可用」，不拿请求参数顶成成功）；
navigate / open_urls 的真实字段；**输入内容与凭据的脱敏**（type / fill / fill_form 的 value、
select 的原始值、`press_key` 的单字符、`handle_dialog` 的 promptText、`http_get` 的请求头）；
**原始页面内容不投影**（execute_js 的求值结果、read_page 的正文与标题、snapshot 的落盘路径、
network/console 的记录、upload/download/pdf/screenshot 的本机路径）；URL scheme 与
query/fragment 拒绝；并发与逆序完成；取消 / 中断不残留 spinner；历史重建与实时一致且不铺
raw JSON；运行观察（发现 ≠ 观察到、重启/切项目/旧 run 清空、最近列表有界）；
Web / Subagent / Memory / Planner 回归；DOM 渲染（含 `outerHTML` 级别的脱敏断言）与
未知工具 fallback；设置区纪律（复用 `restartBackend`、**不假装有审批**）。

`shots:harness` 的场景 **165-browser-activity** 用 `PRIVATE_*` marker 证明输入内容、
页面正文、页面标题、点击到的页面文本、本机路径、上游错误原文都不进 DOM。

真实浏览器验收（opt-in，**不在 CI 里**）：`PI_GUI_BROWSER_LIVE=1 npm run test:browser-live`。
它拉起真的 `pi --mode rpc`（`--no-session` + 临时工作目录），让模型真的调浏览器工具，
把真实事件喂给同一个 `browserActivity`；不带那个环境变量时只打印手工清单并退出 0
（既不会在 CI 误跑，也不会让手滑的人花掉额度）。
**本阶段没有执行真实浏览器验收** —— 见 [browser.md](browser.md#十一验证)。

## P20.5 Pi 0.99 兼容迁移验证

`npm run test:pi-version`（已纳入 `npm test`，**136 条**）—— 完全离线：
不启动 pi、不联网、不读用户的真实 `~/.pi`、不执行任何 Extension。
所有 pi 包都在 `os.tmpdir()` 里现造（**一个「断言这台机器装了什么」的测试都不许有**）。

覆盖：

- **版本真值**：`known` / `unknown` / `malformed` 三态；两种来源
  （`package.json` 优先、`pi --version` 兜底、都没有 → `none`）；畸形版本**不退回**兜底
  （它是有信息的结果）；探测抛错 / 非零退出 / 空输出都降级成 unknown；
  TTL 缓存与 `force` 刷新；`updatedAt` 是 ISO。
- **兜底探测的形状**：命令成形走 `launcher()`（= 与 `rpc-bridge` 同一份
  `formatLaunch()`；POSIX 是 `shell: false` + args 数组，Windows 是命令串 + `shell: true`）、
  有超时、有输出上限。注入的 `run` 能原样收到那份 spec，钉住「两边不是各拼各的」。
- **launch identity（Blocker A）**：明确路径的入口 → 绑到它自己那份包；
  入口不存在 → `packageDir = null`（**旁边躺着真包也不去捡**）；
  裸命令按 PATH / PATHEXT（Windows 先 cwd）解析；没有 PATH → `null`；
  **★ 分叉回归**：`PATH` 指向 A、"常见全局位置"里藏着 B 时绑 A，且版本 / built-in
  探测跟着一起读 A；显式指向 B 时才绑 B；`summary()` 只有枚举与 basename；
  Windows 下切 cwd 会重新解析（缓存按 cwd 分键）。
- **`formatLaunch` 契约**：POSIX 走数组不拼串；Windows 拼串、空 args、`shell: true`。
- **built-in 解析**：用 **0.87.0 与 0.99.1 的真实原文**当 fixture
  （0.87 只有 `llama.cpp` 且 `hidden: true`；0.99 四个且后三个 `replaceable: true`）；
  形状不认识 → `null`，**不返回空数组冒充「没有」**。
- **built-in 能力**：0.99 形态 / 0.87 形态 / 包找不到 三种；`getAllTools` 两版都有
  （**不是新能力**）；RPC 命令表读出来且确认没有工具清单命令；
  **缓存按 cwd 分键**（切项目不会拿到上一个项目的结论）。
- **MCP 三态**：`true` / `false`（0.87 legacy）/ `null`（形状不认识或包找不到）；
  `servers` 永远是空数组（不编造 Server）。
- **`get_commands` ≠ tool registry**：它返回 slash command / prompt 模板 / skill，
  命令表里确实有 `get_commands`，但 `toolListCommand === false`。
- **脱敏**：`mcp.json` 里的 `Authorization` / `env` 密钥 / Server 名 / 配置内容
  一个字节都不进报告；报告里没有 pi 包绝对路径（`piPackageDir` 已移除，
  换成布尔 `piPackageFound`）。
- **schema drift**：缺 `sessionFile` → 记 `missing-field`；未知事件 → 记
  `unknown-event` 但 payload 不进记录；版本源的未知枚举被归一（不回显原值）。

配套更新的既有套件：`tests/skills.cjs` 的 MCP 段（L1–L36，182 → 196）重写成
「0.87 形态 / 0.99 形态 / 形状不认识 / 配置脱敏 / 无项目」五个 fixture；
`tests/smoke.cjs` 的 MCP 标签页断言改成检查新的事实（版本与来源、built-in 清单、
RPC 事实、配置只报存在性）—— 1023 → 1043。

## P20.6 Native MCP 集成验证

`npm run test:mcp`（已纳入 `npm test`，**187 条**）—— 完全离线：
不启动 pi、不起真实 MCP server、不联网、不 OAuth、不读用户真实目录。
`pi mcp list --json` 与各动作的执行一律注入假 runCli；配置文件全在
`os.tmpdir()`。契约基线 **pi 0.99.2**。`npm run test:ui`（smoke，1051 → **1062**）
另有 MCP 标签页的界面行为（状态横幅、server 行、刷新/移除/添加 wiring、
trust 提示、workspace 隔离文案、unsupported 声明、无凭据字段）与 P15 Extension 页回归。

分组（详见 [mcp.md](mcp.md) 末节）：

| 组 | 内容 |
|---|---|
| **A. cache / workspace isolation** | A 刷新 → 切 B → B 看不到 A 的 runtime；A `replaced=true` → 切 B → B 重新 probe；同 cwd+identity 的 TTL 复用与过期重跑；launch identity 变化不复用；`reset()` 清 runtime + command probe；无 identity 注入时仍按 cwd 隔离 |
| **B. project trust** | 未信任 + project add/remove → 拒绝且 `runCli` 0 次；已信任 → 正常；未信任下 user scope 仍可用；trust 未知 / 抛异常 → fail closed；未信任项目 `.pi/settings.json` 的 `-builtin:mcp` 不影响 native；已信任时正确变 disabled；用户级与项目级覆盖关系 |
| **C. secret API contract** | header value / env value / `oauth` / `auth` / 常见 token 字段 → `secret-input-unsupported` 且不调 `runCli`、不回显值；`bearerTokenEnvVar` 只传名字被允许；success 响应不含配置原文；`mcp-auth.json` 含 token 也一个字节都不进报告 |
| **D. 0.99.2 fixture / schema** | `codemode-deferred` 归一为 `codemode`（含 `toolExposure` 值）；`description` 单行化 + 限长；`auth` 计入 `hasSecrets`；`resources` / `resourceTemplates` / `toolExposure` / `note` 接收与脱敏；`--description` argv |
| **E. unknown enum / schema fallback** | 闭集外的 `state` → `unknown`（不回显原文）；未知 `scope` / `exposure` → `null`；`resources` 只收非负整数；`source` / `command` / `url` / `headers` / `env` / 未知字段一律不取 |
| **F. 回归** | 配置安全解析、入口派生、scope/状态机、list 合并与脱敏、动作 argv 与校验、stale、unsupported、前端语义投影与运行观察 |
| **G. 覆盖受 trust 约束**（Fix-2 A） | trusted 同名 → 用户级 `overridden`；untrusted / unknown 同名 → 用户级继续 active、项目项 untrusted / trust-unknown；trusted 但项目项 invalid → 用户级不被覆盖；不同名互不覆盖；项目文件坏 JSON 不误标；`readConfigs` 本身不产出 `overridden` |
| **H. raw MCP tool name**（Fix-2 B） | `get-user` / `tool name` / `a/b` / `x:y` / `工具搜索` / `emoji-🔎` 不被过滤；控制字符（NUL/CR/LF/C0/C1）被替换、不产生换行注入；纯控制字符名从列表丢但仍计入 `toolCount`；超长安全截断；非字符串丢弃且不 `String()`；`tools` 非数组 → `null`；展示列表 ≤200 而 `toolCount` 是上游数量；`toolExposure` 键同样是 raw name |
| **I. 两层命名边界**（Fix-2 B） | CLI 侧不做 `-`→`_` 归一；Timeline 侧仍按注册后标识符解析；raw 名（无 `mcp__` 前缀）不匹配 → generic fallback；CLI 侧不再导出 tool 名字符集正则；`mcp-activity` 资源工具与 `mcp__` 解析无回归 |
| **J. 上游校验逐条对拍**（Fix-3） | 33 条「上游会拒绝」用例（`args` 非 string[]、`env` 非 string→string、`cwd` 非 string、`timeout` ≤ 0、`description` 非 string、URL 非 http/https、`headers` 非 string→string、`oauth` 各字段非法、`auth` 非法/项目文件禁用、`toolExposure` 非法整条拒、未知 `type`、`sse`、缺 command/url）+ 12 条「上游会接受」用例（防误拒）；namespace 冲突（同文件 / 跨文件 / 同名不算冲突 / 不同名）；超长 server 名上游接受而动作入参拒绝 |
| **J2. 端到端覆盖**（Fix-3） | 截图场景（trusted 项目同名项 `args:[123]` 非法 → 用户级继续生效）；namespace 冲突不覆盖；合法同名项**照常覆盖**（反向证明）；项目文件带 `auth` 不覆盖；用户级自己非法时两侧都如实报 invalid |

**live MCP 测试本轮未执行**（不进 CI）。真机流程（手工）：配一个本地 stdio
fixture server → 打开 MCP 页 → 刷新状态见 connected + 工具数 → 调一次工具见
Timeline 语义行 → logout 清理。不要用真实远端 server，不要做真 OAuth 登录。

## P21-Fix-2 Usage / Quota 验证

`npm run test:quota`（**190 条**，已并入 `npm test`，完全离线）。P21-Fix-2 把这一套从
「有假断言的 83 条」重写成真实契约测试：

- **严格 URL 的 mock**：mock fetch 只认识白名单 URL，其它一律 `throw new Error("unexpected URL")`
  —— 杜绝「mock 不区分 URL」导致的假绿。OpenRouter 只允许 `https://openrouter.ai/api/v1/key`；
  DeepSeek 只允许 `https://api.deepseek.com/user/balance`。
- **NewAPI 两个 endpoint 各返回不同 fixture**，断言两个 URL **各调用正好一次**、
  只带 `Authorization: Bearer`（`New-Api-User` 只在配了 `quotaUserId` 时才带）；
  `hard_limit_usd=100` + `total_usage=2500` → `used=25` / `remaining=75`
  （这两个数是**站点展示数值**，单位未知，见下）。
- **`resetAt` 语义**：`limit_reset="monthly"` + `expires_at=2027-12-31T23:59:59Z` → `resetAt === null`，
  且 `expires_at` 绝不成为 `resetAt`；只有能解析成日期的 `limit_reset` 才保留。
- **DeepSeek 多币种**：CNY 110 + USD 15 → `balances.length === 2`、**不相加**、primary 优先 CNY。
- **缓存身份**：环境变量改值（`$ENV_VAR` 字符串没变）必须重新 fetch；`quotaAdapter` 去掉后
  不再命中 newapi 缓存；in-flight 按身份隔离（A 的慢请求 resolve 不污染 B）；
  `clearCache(providerId)` 真能清掉。
- **错误与脱敏**：401 / 网络错误 / 畸形响应 / 未配置 Key 的文案都是白名单，
  不含 `ECONNREFUSED`、主机端口、路径或响应体；HTTP handler 内部抛异常时只回
  `{ ok:false, error:"额度查询失败" }`。
- **前端 DOM（jsdom）**：`resetUsageState()` 同时清 JS 与 DOM（`uTok/uCache/uCost/uQuota/uPct`
  全部 `—`、进度条 0%、ctx chip `—`）；`beginWorkspaceSwitch` 后旧数字立刻消失；
  session A→B 时会话用量立刻清（`stats`/totals/`lastTurn` 全空）；
  新模型解析不出 Provider 时清旧 quota 且 epoch 失效；多币种渲染不再 `ReferenceError`
  并显示 `¥110.00 | $15.00`；`null → —` 与真实 `0 → 0`；恶意币种字符串只当文本。
- **静态守卫**：P21 相关源码不含 U+FFFD / GBK 乱码标记，也不再有 `fmt(x || 0)` 这类兜底。

删掉的假断言：`check(..., true)` × 3、`check('fixed_malformedRes', true)`、
`/* removed check */`、两处 `console.log(JSON.stringify(...))` 调试输出。

**live 未执行**：只有 `LIVE_PROVIDER_TEST=1` 才可能连真机；默认不计入 CI。

## P21-Fix-3 Usage / Quota 事实收口验证

`npm run test:quota` 现在 **204 条**（+14）。本轮只动两处逻辑与事实文档：

- **NewAPI 不再强制 `quotaUserId`**：没有它也会正常调两个 endpoint（断言 status 为 `ok`、
  两个 URL 各一次、`used = 25` / `remaining = 75`）；默认**不发** `New-Api-User`，
  配了才发（旧部署兼容）。没配 `quotaAdapter` → `unsupported` 且**零请求**；
  没配 `apiKey` → `auth_error` 且**零请求**。
- **NewAPI cache endpoint identity 含 base path**：`https://example.com/api-a` → `api-b`
  必须换身份并重新 fetch（两套 fixture 返回不同数值，证明没有串缓存）；
  `https://example.com/api-b/` 与 `/api-b` 是**同一**身份（命中缓存）。
  OpenRouter / DeepSeek 用固定 canonical endpoint，baseUrl 带路径不影响身份。

## P21-Fix-4 Usage / Quota 单位语义收口验证

`npm run test:quota` 现在 **229 条**（+25）。本轮只动 NewAPI 的单位语义与前端货币符号：

- **后端不再把 NewAPI 数值标成 USD**：`balance.currency === null`、`windows.unit === null`，
  且整个 quota 对象里**不出现** `USD` / `CNY` 字符串；`used = total_usage/100 = 25`、
  `limit = 100`、`remaining = 75` 的数值不变（变量名也从 `usedUsd`/`remainingUsd`
  改成 `used`/`remaining`）。
- **前端 unknown currency**：`currencySymbol()` 只认 `USD → $`、`CNY → ¥`，
  其它/null/undefined/TOKENS 一律**空**；`fmtCurrency` / `fmtBalanceShort` / `fmtMaybeMoney`
  默认单位改为 `null`，不再把未知单位默认成美元。
- **DOM**：NewAPI 的 `{amount:75, currency:null}` + `{used:25, limit:100, remaining:75, unit:null}`
  → 侧栏 `75.00`（不含 `$`/`¥`/`USD`/`CNY`）；Popover 出现「剩余额度 / 已使用 / 总额度」三行
  且带「单位未知」标注，正文里**没有** `$`/`¥`/`USD`/`CNY`。
- **回归**：OpenRouter 仍是 `$8.00`（Popover 有 `USD`、且 remaining 与余额同值时不出现重复行、
  没有「单位未知」标注）；DeepSeek 仍是 `¥110.00 | $15.00` 与 `(CNY)`/`(USD)` 逐条；
  恶意币种字符串现在**根本不进 DOM**（未知单位不加币种标注）。

⚠️ **上游核对边界（如实记录）**：
- **能核实的**：Pi 侧是本机 `@earendil-works/pi-coding-agent@0.99.2` 与其依赖
  `@earendil-works/pi-ai@0.99.2` 的类型定义**逐条读出来**的（wire `Usage`、
  `get_session_stats` 的 `tokens`/`cost`/`contextUsage`、`contextWindow` 而非 `limit`、
  compaction 后 `tokens`/`percent` 可为 null）。
- **取不到的**：`web_fetch` 对本机是阻断的（`raw.githubusercontent.com`、`github.com`、
  `doc.newapi.pro`、`deepwiki.com` 全部解析到非公网 IP），所以 **QuantumNous/new-api 与
  OpenRouter 的 upstream 源码/文档无法直接阅读**。NewAPI 的 `quota_display_type`
  语义（USD/CNY/TOKENS/CUSTOM、`TotalUsage = amount * 100`、CNY 按
  `quota / QuotaPerUnit * USDExchangeRate` 折算）来自本轮任务给出的 upstream 说明，
  检索仅能佐证 new-api 有独立的额度显示单位与货币换算模块。
  **代码方向取安全侧**：拿不到权威单位就不标单位、不猜、不转换 —— 这一侧的结论
  不依赖于该说明的具体细节是否逐字准确。

## P22 Capability UX 验证

三层，各管一段（**不要把 DOM 断言当排版证明**）：

| 层 | 命令 | 条数 | 量什么 |
|---|---|---|---|
| 纯投影 | `npm run test:capability`（进 `npm test`） | 62 | 四值状态、`null` 不冒充 `false`、built-in 与 Native MCP、unknown Extension、搜索与过滤、运行观察重置、`restartRequired`、无自动安装、Registry 无特化 |
| DOM（jsdom） | `npm run test:ui` 的 P22 段 | 21 | 五个过滤器、六个状态字段、统一文案、未知不写成否、restartRequired、stale 不落地、Usage 入口只读 |
| 真实 Chrome | `npm run harness` + `npm run shots:harness` | 场景 171–180 | 布局宽度、列表项高度、横向溢出、四档宽度 |

关键判定（写错任何一条，界面就开始撒谎）：

- **`null` 只显示「未知（无法确认）」**：`tests/capability.cjs` 用「发现失败」的
  Registry 报告钉住 `installed` / `configured` / `loaded` 全是 `null`；
  smoke 那一段临时把 `/api/extensions` 换成 `{ok:false}`，断言详情里是
  「未知（无法确认）」而**不是**「未安装」。
- **Native MCP 不显示 npm 安装命令**：纯测断言 `installCommand === null` 且
  说明里含「没有安装命令」；截图 173 断言详情里**没有** `<code>` 元素、
  也没有任何按钮（一个伪造开关都不给）。
- **built-in 不伪装成普通 Extension**：`builtin:` 前缀 + `pi 内置扩展` 来源徽标 +
  「不由 Extension Registry 的目录扫描发现」；「启用 / 加载」显示**不适用**而不是「否」。
- **unknown Extension 不丢**：registry fixture 里放一个完全不认识的包，
  断言它在 All 与 Extensions 里都在、状态是未知、坏掉的那条带自己的诊断。
- **运行观察随 bridge run 重置**：观察实例在 `bridge_status` 的
  starting / restarting / exited / error / no-project 上清空；换 workspace
  generation 也不沿用（纯测直接对 `createWebObservation()` 断言）。
- **stale workspace**：smoke 在 `openExtensions()` 之后**同步**把
  `S.workspaceGeneration` 加一，断言结果回来时列表为空并显示「项目已切换」。
- **无自动安装**：四个 `*Setup()` 都声明 `automaticInstall === false`；
  投影层与视图层都不出现 `child_process` / `execFile` / `spawn(` / `node:fs`；
  Capability 视图里没有任何按钮以「安装」开头。
- **Registry 无特化**：直接读 `server/extension-registry.js` 与
  `lib/extension-paths.js` 的源码，断言里面**不出现**任何 feature 包名
  （`pi-web-access` / `pi-subagents` / `pi-memory` / `pi-browser-harness`）、
  工具名（`web_search` / `memory_search` / `browser_navigate`）或 `nativeState`。

⚠️ **测试占用的固定端口别去蹲**：`visual-harness` 默认 7789、`dev-server` 7791、
`git.cjs` 7799；CDP 9222–9225。跑截图 harness 用表外端口
（本次用 `HARNESS_PORT=7800` + `CDP_PORT=9233`）。

⚠️ **同一个 harness 进程不要连着跑两次 `cdp-shot`**：harness 的内存夹具是有状态的
（会话、Git 干净开关、对话推送），第二轮会看到第一轮留下的世界，
表现为 59 / 125 这类**与本次改动无关**的取景失败。每轮截图前重启 harness。

## P23 Long-term Compatibility / Upgrade Safety 验证

四层，各管一段：

| 层 | 命令 | 条数 | 量什么 |
|---|---|---|---|
| 离线契约 | `npm run test:probes`（进 `npm test`） | 62 | 兼容矩阵、probe 三值与**抛错**、缓存 / stale / restart invalidation、版本 `verifiedAgainst` 四态、schema 漂移只记字段名与类型、诊断五块集成与脱敏 |
| P20.5 既有 | `npm run test:pi-version` | 136 | 版本真值（known / malformed / unknown）、built-in 探测、launch identity 同源 |
| DOM（jsdom） | `npm run test:ui` 的 P23 段 | 16 | 诊断五个新小节、三值文案、摘要脱敏与剪贴板、漂移记录与清空 |
| **真实 pi** | `npm run test:probes-live [-- --strict]` | opt-in | 对着本机真装着的 pi 打一张 probe 表；`--strict` 在「版本不在矩阵里」时退出码 1 |

关键判定：

- **未知版本是安全的**：`verification` 有四个值，`unverified`（矩阵里没有这个版本）
  **不影响功能**，只是不能声称「核对过」。没注入矩阵 → `unchecked`；版本读不到 → `unknown`。
- **probe 拿不到就是未知**：读不到包 / 文件是目录 / 形状不认识，三种情形分开断言
  （分别是 `null` / `null` / `false`）；一条 probe 抛错不影响其它 probe。
- **缓存与失效**：TTL 内不重读、`force` 立即重读、launch identity 一变立即重算、
  `reset()` 后 runtime probe 立刻回未知。
- **漂移不带值**：往漂移记录里塞 secret 与对象，断言序列化结果里既没有值、
  也没有对象键名；前端环同一条断言，另有「同一条只记一次」与「bridge 重启清空」。
- **诊断脱敏**：整份快照（含 probe 证据 / 矩阵 / Native MCP / Extension 版本）
  不含注入的 secret 与绝对路径；`privacy` 五个标记恒为 `false`。
- **两处判定不许各说各话**：`tests/pi-probes.cjs` 用同一份假包同时跑
  `server/approval-probe.js`（P19）与 `server/pi-probes.js`（P23），断言结论一致 ——
  这条正是为了挡住「文档措辞变了，一处改了另一处没改」。
- **契约措辞与位置漂移**：0.87 的「Can block」与 0.99.2 的
  「can mutate input or block execution」两侧各一条 fixture；对话框契约在
  `docs/rpc.md`（旧）与 `docs/rpc-extension-ui.md`（0.99.2）两侧各一条，并断言
  证据指认真正命中的文件。

⚠️ **`npm run test:probes-live` 不进 CI**：它断言的是「这台机器上装的 pi 现在长什么样」，
在 CI 上必红。它属于升级流程第 5 步（见 [upgrade-playbook.md](upgrade-playbook.md)）。
