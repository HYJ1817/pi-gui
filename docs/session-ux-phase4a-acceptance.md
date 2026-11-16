# 会话过程 UI/UX P4-A 实施与验收

验收日期为 2026-11-16（Asia/Shanghai）。目标分支为
`feat/session-ux-p4a-subagent-cards`，基线为已合并 P3 的 `origin/main`
`0683b89`（Merge PR #90）。本轮只实现 P4-A 子代理紧凑卡片，不提前实施
P4-B、P4-C、P4-D、P4-E。本轮不合并、不发版；pi 本体、用户真实会话、
全局 npm 均未改动。所有会话、子代理、工具、计划与 usage 证据都来自固定
fixture，未读取用户真实项目做写操作。

## 结论

- 父工具行保留原有 `.tl-item` 生命周期、名称、状态、请求摘要、耗时和
  `aria-expanded` / `aria-controls` disclosure；展开后新增单列子项列表，
  没有第二层卡片、独立滚动区或独立 Stop 控件。
- 结构化列表只消费 `subagent-activity.js` 既有 allowlist：绑定的
  `workflowChildren.children[]` 或实际 `details.results[]`。workflow 帧必须
  同时通过 `version === 1`、父 `toolCallId`、`workflowRunId` 校验；优先
  `childId`，普通结果只在已确认 `runId` 与 producer `index` 同时存在时使用
  `${runId}/${index}`。无法可靠确认归属时完全回退既有安全 facts 工具行。
- 每项可显示 Agent、Model、状态、实际工具数、轮次、Token、耗时、已有任务
  摘要和安全结果字段。缺失字段省略；不从工具数推算完成百分比；不把请求
  参数中的 `agent/task` 当作执行成功的事实。
- 每个来源最多 24 项、8000 字符权重预算；超限按前缀截断，摘要显示实际
  显示数，但仍继续统计后续已知状态。既有 `facts` 字符串保持原样。
- Runtime 实时与历史工具投影没有增加 `args/details` 或子代理 facts；
  Runtime 的 `subagent` 工具行继续使用现有安全回退，不生成卡片。
- 定向测试 880/880 通过，其中新增 `tests/session-ux-phase4a.cjs` 为
  107/107；既有六个受影响套件为 773/773。真实 Chromium 验收 after 44/44、
  before 24/24 通过。
- 完整 `npm test` **未运行**（按任务要求），因此不能把本轮结论当作完整
  canonical 证明。真实读屏软件、真实 pi 子代理执行也未运行。

## 修改文件

| 文件 | 内容 |
| --- | --- |
| `public/subagent-activity.js` | 在既有 allowlist 投影上增加有界结构化子项；workflow 绑定校验、childId/runId+index 身份、前缀截断与计数 |
| `public/tool-view.js` | 父行计数元信息、单列子项列表、状态文案、懒创建、既有 disclosure 与折叠优先契约 |
| `public/styles.css` | 紧凑计数行、单列子项、状态色点、宽窗同行与 700px 第二行模型布局；无动画 |
| `tests/session-ux-phase4a.cjs` | P4-A 行为、安全、身份、截断、回退、折叠与 Runtime 回归（107 条断言） |
| `tests/session-ux-phase4a-shots.cjs` | 真实 Chromium/CDP 的 before/after 截图、几何、键盘、焦点与 AX 树 |
| `tests/cdp-shot.cjs` | P17 视觉场景改验结构化子项卡片；不再要求已由卡片取代的 `.tl-out` facts 文本 |
| `package.json` | 把 `session-ux-phase4a.cjs` 加入 `test` 链并新增 `test:session-ux-phase4a` |
| `docs/subagents.md` | 记录 P4-A 卡片、allowlist、回退、预算与 Runtime 边界 |
| `docs/README.md` | 导航增加 P3/P4-A 验收入口 |
| `docs/session-ux-phase4a-acceptance.md` | 本验收记录 |
| `docs/ui/session-ux-phase4a-evidence/` | before/after 真实截图与 `measurements.json` |

没有修改 `public/thinking-dots.js`、`public/thinking-dots.css`，也没有改
思考动画的调用逻辑、关键帧、节奏或触发时机。

## 数据契约与回退

### 父行

父行仍是原来的工具项：

- `label`、父 `status`、`summary`、耗时、Git stat 与 output/args 的既有
  语义不变。
- 只有生成结构化子项时才在 `.tl-more` 前插入一行计数元信息；折叠后这行
  计数仍可见，展开按钮文案为「子代理」；展开后为「收起」。
- 父行和父工具组的用户折叠选择优先；子代理状态更新不会自动展开，也不会
  覆盖用户折叠。

### 结构化来源

1. **绑定 workflow**：`details.workflowChildren` 必须满足
   `version === 1`、`parentToolCallId === entry.id`、非空
   `workflowRunId`，且父 `details.runId` 存在时必须相等。子项必须有非空
   `childId`；重复 `childId` 追加 `#2` 等后缀。
2. **实际 results**：只有父 `runId` 存在、每个结果都带唯一非负整数
   `result.index` 时才使用 `${runId}/${index}` 作为身份；任一结果缺少
   run/index 证据或 index 重复时，整组回退既有 facts。行位置不是 producer
   身份。

每项白名单字段：`agent`、`model`、`state`、`task`、`activity/progress` 的
`currentTool`、`toolCount`、`turnCount`、`tokens`、`durationMs`。状态只
映射白名单值，未知值显示「状态未知」。

### 回退

以下情况不生成卡片，继续显示原来的安全 facts：

- `subagents_enable`、`subagent_supervisor` 或带 `args.action` 的管理/控制调用。
- `bg_wait` 的完成状态未知；后台 launch 只声明 completion unknown。
- 空 `details` / 没有可绑定子项。
- workflow 版本、父 `toolCallId` 或 `workflowRunId` 不匹配的过期帧。
- 绑定的 workflow 没有任何带非空 `childId` 的子项（即使同时存在
  `results`，也不混用第二来源）。
- 没有可靠 `runId` 或每个结果缺少唯一非负整数 `index` 的 results。

### 禁止项

不读取或展示 raw args、未授权的 raw details、child transcript、最终输出、
脚本路径、env/auth/token、文件路径或任意额外字段；不新增 Agent 编排、控制
或 Stop 机制；不由 GUI 生成子代理状态；不用工具调用数推算完成百分比；不从
请求参数推断执行成功。

### 预算与截断

- 每个来源最多 24 项。
- 结构化事实权重预算 8000 字符；超过后保持前缀，不跳过超大行再展示后面的
  小行；摘要显示「显示 N」，但仍统计全部已知项。
- 既有 `facts` 继续按原字符串和 8000 字符上限输出；本轮对 7 个代表夹具
  比对了旧/新 `label/status/summary/facts`，结果逐字节相同。

## 视觉与交互

- 宽窗：Agent、状态、Model 在子项第一行；Model 过长用省略号和 `title`
  保留全文；任务摘要和「当前工具 / 工具数 / 轮次 / Token / 耗时」在后续行。
- 700px：Agent 和状态优先留在第一行，Model 强制换到第二行并允许
  `overflow-wrap:anywhere`；页面和 `#stream` 横向溢出均为 0。
- 状态颜色使用既有 `--run` / `--ok` / `--err` / `--warn` Token，文字仍可读。
- 展开复用现有 `.tl-toggle`；键盘 Enter/Space 可开合；`aria-expanded`、
  `aria-controls` 指向同一个 `.tl-more`；列表为 `role=list`、
  `aria-label=子代理`，每项为 `role=listitem`。
- 不新增独立滚动区；子项没有按钮，父行内只有一个 disclosure 按钮。

## Runtime 边界

本阶段没有扩展 Runtime 工具投影。`runtime-conversation.js` 的
`toolEntryOf` 仍提供 `id/name/state/waiting/durationMs`，`args` 与 `details`
为 `null`。真实 Chromium 中 Runtime 的 `subagent` 工具行：

- 子代理卡片数、子项数、计数元信息数均为 0；
- 仍显示「Delegation returned / Agent unknown · Task unavailable」安全回退；
- `args === null`、`details === null`，没有 `PRIVATE`、`SECRET` 或
  `provider/model` 文本泄漏；
- 1320 与 700px 下文档/Runtime/输出容器横向溢出均为 0。

## 测试

本轮没有运行完整 `npm test`。按任务要求运行以下七个定向套件：

| 套件 | 结果 |
| --- | --- |
| `node tests/subagents.cjs` | 141/141，退出 0 |
| `node tests/agent-execution-ui.cjs` | 221/221，failed=0，skipped=0，退出 0 |
| `node tests/session-ux-phase1.cjs` | 81/81，退出 0 |
| `node tests/session-ux-phase2.cjs` | 96/96，退出 0 |
| `node tests/session-ux-phase3.cjs` | 128/128，退出 0 |
| `node tests/runtime-conversation.cjs` | 106/106，退出 0 |
| `node tests/session-ux-phase4a.cjs` | 107/107，退出 0 |

合计 **880/880**。新增套件覆盖：同步与并行子代理、多模型、空 details、
恶意额外字段、30 项/24 项上限、8000 字符预算与前缀截断、混合终态、未知
后台完成状态、过期 workflow 帧、缺失/重复 producer 身份回退、绑定 workflow
缺少 childId 时不混用 results、父子工具同时存在时 `gui_plan` 唯一、缺失
事实回退、用户折叠优先、父组折叠优先、历史/实时一致、Runtime 缩减投影。

断言总数没有减少：既有六个套件保持原数量，新增套件从 97 增至 107（新增
前缀截断断言，缺少 `runId`、缺少 `index`、`index` 重复三组各两条回退断言，
以及绑定 workflow 无 `childId` 时的两条回退断言）。没有跳过断言计入分子。
`tests/cdp-shot.cjs` 的 P17 场景属于人工视觉核对，不在本轮定向测试清单中，
未单独重跑整套 `shots:harness`。

`git diff --check` 无输出。

## 真实 Chromium 验收

运行方式：

```bash
node tests/session-ux-phase4a-shots.cjs
TMP=$(mktemp -d)
git worktree add --detach "$TMP" 0683b89
P4A_SHOT_LABEL=before VISUAL_PUBLIC_ROOT="$TMP/public" node tests/session-ux-phase4a-shots.cjs
git worktree remove --force "$TMP"
```

同一份固定 fixture 覆盖：已完成的单子代理、并行 workflow（成功/失败/
运行中/长名称/长模型）、后台 launch 回退、`subagents_enable` 回退、普通
工具组、Thinking、usage、`gui_plan` 计划卡，以及实时 workflow 从运行中
到混合终态的状态变化。

| 截图 | 内容 |
| --- | --- |
| `after/01-classic-history-dark-1320.png` | 单子代理父行、计数、子项 |
| `after/02-classic-workflow-dark-1320.png` | 并行 workflow、多模型、混合终态 |
| `after/02b-classic-plan-dark-1320.png` | P1–P3 回归：Thinking、usage、计划卡、工具组、回退行 |
| `after/03-classic-live-running-dark-1320.png` | 实时运行中 |
| `after/04-classic-live-ended-dark-1320.png` | 同一父行的终态更新 |
| `after/05-classic-live-collapsed-dark-1320.png` | 折叠后计数仍可见 |
| `after/06-classic-live-light-1320.png` | 浅色宽屏 |
| `after/07-classic-dark-700.png` | 700px 深色、长名称/长模型 |
| `after/07b-classic-dark-700-collapsed.png` | 700px 折叠 |
| `after/08-classic-light-700.png` | 700px 浅色 |
| `after/09-runtime-subagent-dark-1320.png` | Runtime 安全工具行，无卡片 |
| `after/10-runtime-subagent-light-700.png` | Runtime 700px，无卡片 |

`before/` 使用 `origin/main` `0683b89` 的 `public/` 和同一 fixture；对应
截图保留同样的文件名。完整断言与几何数据见
[after/measurements.json](ui/session-ux-phase4a-evidence/after/measurements.json)
与 [before/measurements.json](ui/session-ux-phase4a-evidence/before/measurements.json)。

### 关键测量

| 项目 | after | before |
| --- | --- | --- |
| 结构化卡片 | 3 个父工具、7 个子项 | 0（全部 facts） |
| 父行 head 高度（1320） | 26px | 26px |
| 父行折叠高度（含计数） | 51.39px | 35px |
| 计数元信息高度 | 15.39px | — |
| 宽窗 Agent/状态/Model 顶部差 | 2.81px（同一行） | — |
| 700px 模型换行 | `white-space:normal`，模型 top 293.7 > Agent bottom 290.3 | — |
| 文档 / `#stream` 横向溢出 | 0 / 0（1320 与 700） | 0 / 0 |
| 子项行横向溢出 | 全部 0（700px） | — |
| 子列表内部滚动 | 无（clientHeight = scrollHeight = 117） | — |
| 父行折叠锚点（1320） | 0px | 0px |
| 父行折叠锚点（700） | 0px | 0px |
| 父组/子项用户折叠优先 | 通过 | 通过 |
| 键盘焦点环 | 2px solid `rgb(40,91,150)` | 2px solid（既有） |
| Enter / Space | 收起 / 展开 | 收起 / 展开 |
| AX 列表 | 3 个 `子代理` 列表，10 个 listitem | 1 个空名列表，3 个计划 listitem |
| Runtime 卡片 / 泄露 | 0 / 无 | 0 / 无 |
| Composer 底部（700×600） | 600（Classic）；590（Runtime） | 600 / 590 |

实时状态从「Delegating… 运行中 · 运行 1 · 成功 1 · 失败 1」更新为
「Delegation error 失败 · 成功 2 · 失败 1」，同一父行保持展开，子项状态
从 completed/running/failed 更新为 completed/failed/completed；没有新增
卡片或独立状态源。

### P1–P3 回归

同一 fixture 中：

- 计划卡恰好 1 张；`gui_plan` 没有独立工具行；普通工具组包含 2 项。
- Thinking 块 1 个，assistant usage 元信息 2 个。
- `02b` 截图显示计划卡、工具组、usage、Thinking 与现有消息排版。
- before/after 的 Classic 文档与 `#stream` 横向溢出均为 0，Composer 未超出
  600px 视口。

## 构建与冻结

- 最终源码状态已用
  `node scripts/build-app.mjs --rebuild --output-root <临时绝对目录>` 打包通过：
  `Pi GUI.exe` 234.9 MB，整包 333.6 MB，退出 0。
- 仓库内 `dist-app` 的原地重建被正在运行的 `Pi GUI.exe`（5 个进程，
  路径为 `dist-app/Pi GUI-win32-x64/Pi GUI.exe`）占用，`clearDir` 报
  `EPERM`；因此 `dist-app` 中现有产物不是最终 CSS。关闭应用后重跑
  `npm run build:app -- --rebuild` 才会更新它；在此之前请运行源码版
  （`npm run app` / `npm start`，以仓库脚本为准）查看最终排版。
- `git diff --exit-code origin/main -- public/thinking-dots.js public/thinking-dots.css`
  退出 0；思考动画未改动。
- 构建产物位于 `.gitignore` 的 `build/`、`dist-app/`，不进入提交。

## 残余风险与未验证项

- **完整 `npm test` 未运行**；本轮不能替代完整 canonical 证明。
- 未运行真实 pi / 真实 pi-subagents 子代理；所有子代理结果都是固定
  fixture，未验证上游字段在真实会话中的漂移。
- 未运行真实读屏软件；只验证了 Chromium AX 树、键盘和焦点环。
- 仓库 `dist-app` 的原地重建被正在运行的 `Pi GUI.exe` 占用，当前放着的不是
  最终 CSS；最终源码已用临时输出目录打包通过。关闭应用后需重建，或运行源码版。
- 计数扫描全部已知 `results` / `workflowChildren.children`，而父工具状态
  仍由既有 `lifecycle` 的前 24 项与 `workflowState` 决定；超过 24 项且失败
  出现在截断之后时，父状态与计数摘要可能表达不同层面的信息。本轮保留既有
  父生命周期语义，没有改变这个边界。
- 宽窗长 Model 用省略号，完整值在 `title` 中；窄窗完整换行。超长任务文本
  仍可能让单行卡片变高，但没有独立滚动区或横向溢出。
- 本阶段只覆盖 Classic；Runtime 的 cards 是后续独立契约工作，不在本轮。

## 回滚

- 回滚业务展示提交即可恢复到原来的 facts 文本工具行；不涉及 schema、持久化、
  会话文件、Runtime store 或用户数据迁移。
- 测试与文档提交可独立回滚；回滚后不影响现有 `subagents_enable`、`bg_wait`、
  supervisor 或 Runtime 工具行。
- 未合并、未发版、未打 tag；推送分支不等于合并或发布授权。
