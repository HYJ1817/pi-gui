# 会话执行体验 P4-E 验收记录

日期：2026-11-16。分支：`feat/session-ux-p4e-background-completion`，
基线 `origin/main` = `42b5e44`（PR #93 合并提交）。
本记录冻结当次的代码、fixture、浏览器与测量范围；后续行为变化不沿用这里的结果。

- 已实现后台会话完成、失败、中断与未知终态的提示，复用现有 Runtime
  attention、侧栏与「独立会话」列表，不另建通知系统。
- 已用真实 Chromium 完成 1320×820 / 700×600、深色 / 浅色验收，43/43 断言通过。
- 只运行相关定向测试，未运行完整 `npm test`；不自动合并、不发版、未实施 P4-D。
  本记录不构成合并或发布授权。

## 1. 前置与范围

- 用户要求一次完成 UI、功能和定向测试；从最新 main 建独立分支后提交、推送并创建 PR。
- 用户要求复用已有 attention、未读状态和侧栏机制；点击提示定位正确会话；
  不自动切换会话、不抢输入焦点、不打断当前任务；多条结果合理聚合；严格区分
  已完成 / 失败 / 中断 / 未知；只使用真实生命周期事件。
- 冻结 `public/thinking-dots.js`、`public/thinking-dots.css` 与 P1–P4-C 行为；
  未修改 `public/tokens.css`，未新增依赖、网络行为或写盘路径。
- `git diff --check` 无输出；冻结文件无 diff。

## 2. 终态来源与判定

只消费 registry 已收到的生命周期证据，不读错误文案、不从连接状态猜任务结果，
也不把历史 replay 当成本次运行。

| 证据 | 判定 | 说明 |
| --- | --- | --- |
| `generationResult.outcome = 'success'` | 已完成 | `server/model-generation.js` 对已开始 prompt 的结构化总结 |
| `generationResult.outcome = 'failed'` + `failure.class = 'user_cancelled'` | 已中断 | 用户 Stop / abort |
| `generationResult.outcome = 'failed'` + 其他类别 | 失败 | 不展开原始错误内容 |
| `generationResult.outcome = 'unknown'` | 未知 | 除非同一轮已有 abort 证据 |
| prompt preflight `response.generationResult` | 按上表 | preflight 没有 `agent_start` / `agent_settled` |
| `agent_settled.aborted = true` | 已中断 | Pi 自带的真实运行中断标志，优先于 `generationResult` 和 stopReason |
| 最后一条 assistant `message_end.stopReason` | 回退判定 | `stop`/`length` → 已完成；`error` → 失败；`aborted` → 已中断；其余 → 未知 |
| 活跃运行中 bridge `error` / `exited` | 已中断 | reason `runtime_unavailable`；空闲断线不伪造任务终态 |
| 用户 abort 成功且此前确有运行 | 已中断 | 覆盖 adapter 不补发 `agent_settled` 的情况 |
| 无上述证据的 `agent_settled` | 未知 | 不把 settled 本身当成成功 |

`toolUse` 单独不作为「已完成」证据。`generationResult` 是首选来源；只有缺失时才
回退到最后一条 assistant 消息的真实 `stopReason`。

## 3. 去重、焦点与状态生命周期

- 每条 live conversation 有 `outcome: { kind, reason, sequence } | null`；
  `sequence` 来自该会话单调递增的 `outcomeRevision`，不是全局事件序号。
- `outcomeClaimed` 记住本轮终态已处理：同一轮后续 settled（包括迟到且带
  `generationResult` 的帧）不会重复计数、不会把 abort / preflight / bridge crash
  的终态降级或覆盖，也不会在用户聚焦读掉后重新点亮 outcome 或通用 attention 点。
- 失败的 `generation_failed` 与终态在同一次 `recordOutcome` 中收口：重复/迟到的
  失败帧不会在成功或已读之后重新写 error 或 attention。
- 用户正看着的会话失败时不写 outcome、不点亮 attention，但详情错误仍保留；
  自动重试/续跑的新 `agent_start` 会清掉上一轮 `generation_failed`，避免重试成功后
  详情仍显示上次失败。
- Stop 未被 adapter 确认成功（返回失败或请求异常）时清掉 `abortRequested`，避免后续
  正常完成被误报为已中断；若模型确实以 `aborted` 结束，仍由真实 stopReason /
  failure 证据判为中断。
- 新 `agent_start`、新 prompt / steer / follow_up 提交会清掉上一轮终态，并清空
  属于上一轮的 stopReason / abort 证据，避免自动重试沿用旧取消状态。
- bridgeRun 换代（generation 变化）会作废旧终态；关闭 / 换代不把旧结果带进新一代。
- 后台终态才产生提示：`focused === conversationId` 时不写 outcome，只记 claimed。
- `focus` 在 `onFocus` 前捕获已看见的 outcome；成功后只清除同一个对象。
  `onFocus` 期间新到的终态不会被这次聚焦吞掉；聚焦失败则保留原终态。
- 用户提交新任务后上一轮结果即被取代，因此每个会话只保留最新一条未读终态。
- 终态只在 live registry 内存中，无跨重启持久化；`attention` 布尔项保持原语义，
  审批 / 扩展 / runtime 错误仍可独立置位。

`summary()` 新增可选字段：

```json
{ "outcome": { "kind": "completed|failed|interrupted|unknown",
  "reason": "generation_completed|generation_failed|user_cancelled|runtime_unavailable|unconfirmed",
  "sequence": 1 } }
```

## 4. UI 行为

- 侧栏每个并行会话行用现有状态点 + 一行小字展示终态：
  已完成 / 失败 / 已中断 / 已结束（未知）。失败与中断使用语义色点及可辨文字；
  未知点使用空心点，标题说明「结果未确认」。运行中 / 正在停止 / 待审批仍优先显示；
  终态之后若 session 进入错误或清理未完成，状态文字同时保留两者
  （如「已完成 · 错误」），不把当前运行错误盖掉。
- 当前项目只增加**一条**聚合入口：「N 个后台会话有结果」，`aria-label` 给出
  各终态数量。后台更新只改列表和计数，不切换会话、不移动键盘焦点、不改草稿，
  不发送 prompt / abort / focus。
- 单条结果：点击聚合入口直接经现有 `focusRuntimeById` 定位该会话。
- 多条结果：打开既有「独立会话」列表，预选 revision 最新的一条；
  不自动 focus、不切换中央视图。用户点击具体行后才走现有 owner 校验 focus 并切换。
- 列表行与详情状态行区分四种终态；中断不再显示「生成失败，请重试」文案。
  前台失败只更新详情错误，不产生未读点；自动重试开始后旧失败提示清除。
- 键盘焦点在重画后保留在聚合入口；聚合入口有 2px `:focus-visible` 轮廓。
  单条结果被激活、入口随已读消失时，焦点交给刚切到的会话行，不退到 `body`。
- 颜色只消费现有 `--ds-*` / `--ui-space-*` / `--text-*` / `--radius-2xs`。
  浅色主题下 11px 状态文字使用语义色与主文字混合，实测对比度 ≥5.34。

实现文件：

- `server/runtime-registry.js`：终态归一、事件接线、去重、focus / abort / prompt 生命周期。
- `public/runtime-nav.js`：状态文案、语义类、聚合入口、单条 / 多条点击分流、焦点保持。
- `public/runtime-sessions.js`：可选 `selectedId` 预选、结果行与详情状态、中断文案。
- `public/styles.css`、`public/app-shell.css`：聚合入口、语义点、状态文字与焦点样式。
- `tests/session-ux-phase4e.cjs`、`tests/session-ux-phase4e-shots.cjs`；`package.json`
  注册单元入口。

## 5. 定向测试

`git diff --check` 无输出；`public/thinking-dots.js`、`public/thinking-dots.css`、
`public/tokens.css` 无 diff。逐项 `node tests/<套件>.cjs`，结果如下：

| 套件 | 结果 |
| --- | ---: |
| `session-ux-phase4e` | 60/60 |
| `session-ux-phase4e-shots` | 43/43 |
| `runtime-registry` | 36/36 |
| `runtime-events` | 14/14 |
| `runtime-store` | 34/34 |
| `runtime-nav` | 38/38 |
| `runtime-conversation` | 106/106 |
| `runtime-finish-ui` | 48/48 |
| `runtime-ui` | 16/16 |
| `runtime-draft` | 42/42 |
| `runtime-resources` | 45/45 |
| `high-risk-regressions` | 28/28 |
| `session-background` | 5/5 |
| `session-background-ui` | 9/9 |
| `session-background-recovery` | 6/6 |
| `session-ux-phase1` | 81/81 |
| `session-ux-phase2` | 96/96 |
| `session-ux-phase3` | 128/128 |
| `session-ux-phase4a` | 110/110 |
| `session-ux-phase4b` | 108/108 |
| `session-ux-phase4c-shots` | 128/128 |
| `ui2-classic` | 55/55 |
| `ui2-runtime-display` | 83/83 |
| `ui2-visual` | 57/57 |
| `subagents` | 141/141 |
| `thinking-dots` | 90/90 |
| `ui4-feedback` | 27/27 |
| `theme` | 47/47 |
| `app-shell` | 10/10 |
| `sidebar-menu` | 37/37 |
| `stable-session-order` | 41 passed / 0 failed |

`session-ux-phase4e` 覆盖：四种终态、成功 / 失败 / 中断 / 未知、assistant
stopReason 回退、`agent_settled.aborted` 优先判中断、preflight、bridge 活跃崩溃与
空闲断线、用户 abort、Stop 未被确认或请求异常时不误报中断、重复成功/失败 settled
与迟到结果不覆盖或重新点亮已读终态、attention 和 error、前台失败不产生未读点、
自动重试清掉上一轮失败错误、新任务清除旧终态、换代作废、focus 清除与失败保留、
focus 期间新终态保留、终态与当前 runtime 错误同时可见、单条 / 多条聚合、列表预选、
用户改选后 refresh 不回跳、点击定位、单条结果激活后焦点落到对应会话行、后台更新不切会话不抢焦点。

`session-ux-phase4c-shots` 重跑后，其截图被浏览器重新编码；为避免无关证据混入，
已还原 `docs/ui/session-ux-phase4bc-evidence/p4c/` 的工作区改动。

跳过断言不计入分子分母；上表是本次运行的 `N/N` 与失败数 0，不是完整
`npm test` 的结果。

## 6. 真实 Chromium 视觉验收

`node tests/session-ux-phase4e-shots.cjs`：**43/43 通过**。产物在
[p4e 证据](ui/session-ux-phase4e-evidence/measurements.json)，8 张截图：

- `sidebar-{dark,light}-{1320,700}.png`：侧栏聚合入口与四种终态。
- `results-{dark,light}-{1320,700}.png`：既有「独立会话」列表。

关键实测：

- 1320×820 侧栏宽 275px、列表宽 247px；700×600 分别为 240px / 212px。
  所有矩阵 `document`、侧栏、列表、聚合入口、行与状态文字横向溢出均为 0。
- 聚合入口宽 231px（1320）/ 196px（700），高 28px；文案与 `aria-label` 正确，
  只有一条聚合入口。
- 深色主题聚合文字对比度 9.51，四种状态 9.90 / 10.01 / 11.24 / 5.69；
  浅色主题聚合文字 6.60，四种状态 6.88 / 6.15 / 5.34 / 5.93。
- 聚合入口实际键盘焦点 `:focus-visible` 为 `outline solid 2px`。
- 多条结果打开既有列表后预选最新一条（未知终态），4 行分别为
  `已完成 / 失败 / 已中断 / 已结束`；中央视图保持打开前状态，未自动切换。
- 700px 下既有列表切换为单列、无横向溢出；状态行显示「就绪 · 空闲 · 已结束」。

## 7. 构建产物

`npm run build:app -- --rebuild` 退出 0，`dist-app/Pi GUI-win32-x64/Pi GUI.exe`
246,324,736 字节（234.9 MB），整包 333.6 MB。构建产物在 `.gitignore` 内，
不进入提交。用户运行源码版即可看到本分支改动。

## 8. 未验证与残余风险

- 未运行完整 `npm test`；未在真实 Electron 打包应用、真实 Pi 长会话或真实读屏下复验。
- 未对真实模型调用做端到端完成 / 失败 / Stop 循环，只使用真实事件形状的 fixture 与
  真实 registry 状态机。
- 终态不跨应用重启保留，符合规划；关闭会话后 live 记录消失，提示也随之消失。
- 自动重试 / compaction 期间不提前产生中间结果；只在会话级运行结束时记录一次。
- 本轮不合并、不发版；合并与发布需另行授权。

## 9. 复审与处置

独立 general-purpose agent 复审了工作树，范围包括 registry 终态状态机、focus
竞态、bridge / abort / preflight 边界、侧栏聚合与既有列表预选、键盘焦点和强约束；
当时结论为无确认遗留缺陷。

随后用户复审确认 1 项状态缺陷：失败的 `generationResult` 在 `recordOutcome`
之外无条件设置 `live.error` 和 `live.attention`，绕过了去重与已读保护。重复失败
settled 会在用户读掉提示后重新点亮未读点，用户正看着会话时首次失败也会产生多余
未读点；另外新 `agent_start` 未清上一轮 `generation_failed`，自动续跑成功后会继续
显示旧失败。已通过最小复现确认并修复：失败错误与终态一起进入 `recordOutcome`
一次性收口，`agent_start` 只清 `generation_failed`、不清 runtime 错误；新增 9 条
断言，P4-E 60/60。

此前独立复审确认并修复 3 项：`agent_settled.aborted` 可能被成功摘要盖成已完成；
已读结果后的重复 settled 可能重新点亮 attention；单条结果激活后键盘焦点会掉到
`body`。作者自审另修正了同一轮迟到 `generationResult` 的覆盖、Stop 未确认或请求
异常的证据清理，以及终态与当前 runtime 错误同时可见。每项均以最小复现验证，
修复后复跑；复审者未改仓库文件，其临时 repro 只在 `/tmp`。
