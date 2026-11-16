# 会话执行体验 P4-B / P4-C 验收记录

日期：2026-11-16。分支：`feat/session-ux-p4bc-recovery-density`。
本记录冻结当时的代码、夹具、浏览器与测量范围；后续行为变化不能沿用这里的结论。

- P4-B：已实现并验证错误恢复入口，含 `agent_settled` 收口时序修复。
- P4-C：已按确认的方案修改正式 CSS；真实 Chromium 128/128 通过，
  `public/tokens.css` 与冻结的 `thinking-dots` 文件未改。详见
  [P4-C 方案与实施记录](session-ux-phase4c-visual-proposal.md)。
- 不自动合并、不发版；本记录不构成合并或发布授权。

## 1. 前置与基线

- 用户给定的 P4-A 前置已满足：P4-A 由 PR #91 合并，合并提交
  `e93f32e`（`Merge pull request #91 from HYJ1817/feat/session-ux-p4a-subagent-cards`）。
- 分支从该 main 基线创建。
- 冻结文件 `public/thinking-dots.js`、`public/thinking-dots.css` 无改动；
  `git diff --check` 干净。
- 未运行完整 `npm test`；只运行受影响的定向套件，数字见第 5 节。
- `dist-app` 已用 `npm run build:app -- --rebuild` 重建成功（退出 0，
  `dist-app/Pi GUI-win32-x64/Pi GUI.exe` 246,324,736 字节，整包 333.6 MB）。
  构建产物在 `.gitignore` 内，不进入提交。

## 2. P4-B 实现

### 2.1 证据来源

只消费服务端已有的结构化失败证据：

- `server/model-generation.js` 的 `generationResult.failure`：
  `{ class, retryable, reason, source, statusCode }`。
- `public/model-fallback.js`（由 `lib/model-fallback.js` 复用）的
  `safeFallbackFailure`，校验类别、来源与状态码并剥掉 payload。
- 不读错误文本、不猜 provider、不解析原始请求参数。

### 2.2 动作表

| 结构化失败 | 动作 | 打开的既有入口 | 额外条件 |
| --- | --- | --- | --- |
| `auth_error` + 401/403 + 受信来源 | `provider_auth`：检查供应商认证 | `openProviderAuthPanel()`（既有“供应商与认证”设置） | 当前有项目、bridge 为 `ready`/`maintenance`、点击时仍有会话上下文 |
| `model_unavailable` + 404 + 受信来源 | `model_picker`：选择其他模型 | `openModelPicker()`（既有模型列表） | 当前模型身份完整、模型列表非空、非 streaming/stopping/switching/modelSwitchPending；自动备用接管时不显示 |
| 其他类别 | 无按钮 | — | 保持原始错误与现有提示 |

其他类别包括：`rate_limited`、`quota_exhausted`、`provider_unavailable`、
`retryable_provider_error`、`request_incompatible`、`context_overflow`、
`user_cancelled`、`unknown`。权限/审批、读失败、清理/owner 失效走各自既有入口，
本阶段不生成通用“重试/继续”。

### 2.3 生效条件与安全性质

- 只在实时 `agent_settled` 上附加，且在 `onSettled()` 收口 `streaming` 与当前
  消息之后判断；`_replay`、历史重建、Runtime `generation_failed` 不经过该路径。
- 要求 `generationResult.outcome === 'failed'` 且 `requestId` 为字符串。
- 点击时重新核对 `bridgeRun`、`workspaceGeneration`、`cwd`、会话与模型身份；
  任一变化都不执行。
- 动作只调用既有设置入口；不发送 `prompt`、`steer`、`follow_up`、`set_model`、
  `new_session`、`switch_session`、`fork`、`abort`，不自动切换会话或模型。
- 不删除原始错误文本；动作状态是独立的 `role=status` / `aria-live=polite` 区域。
- 重复点击由 busy 标志、`disabled` 与 `aria-busy` 挡住；失败后恢复可点击。
- 不记录 API Key、原始参数或敏感 payload；测试断言原始错误仍可见且不新增泄漏。

### 2.4 实现文件

- 新增 `public/error-recovery.js`：纯策略映射，最多返回一个动作。
- `public/messages.js`：`attachErrorRecovery(action, { run })`，在错误块内创建
  `.me-actions`、一个 `.btn.tiny.me-action` 与状态行；成功/失败只更新状态。
- `public/app.js`：`recoveryIdentity()`、`recoveryActionAvailable()`、
  `runRecoveryAction()`、`attachGenerationRecovery()`；恢复判断位于
  `agent_settled` 分支的 `onSettled()` 之后。
- `public/styles.css`：`.me-actions`、`.me-action-status` 的紧凑样式；错误块仍是
  透明背景、无边框，不新增红色大卡片。
- `tests/session-ux-phase4b.cjs`、`tests/session-ux-phase4b-shots.cjs`；
  `package.json` 注册测试入口。
- P4-C 另改 `public/styles.css`、`public/agent-execution.css`、
  `public/runtime-conversation.css`，并更新 `tests/session-ux-phase4c-shots.cjs`
  与 `tests/ui2-visual.cjs` 的字号预期。

## 3. P4-B 验证

### 3.1 行为与策略（jsdom）

`node tests/session-ux-phase4b.cjs`：**108/108 通过**（0 失败）。覆盖：

- 所有已知失败类别的映射、未知来源、状态码不匹配、敏感字段剥离。
- 服务端结构化链路：401/404/429 与不可信 404。
- DOM：只出现一个动作、原始错误保留、状态 `role=status`/`aria-live`、
  busy/`aria-busy`、重复点击、成功/失败/抛异常、无可附加错误块、无 runner。
- 真实事件顺序：`agent_start`（`streaming=true`）→ `message_start` →
  `message_end`（404）→ `agent_settled`；断言收口前不生成入口、`streaming`
  先为 true 后为 false、随后出现「选择其他模型」，点击打开真实模型列表且
  不发 `set_model`/`prompt`，当前模型不变。
- 真实应用集成：401/403 打开供应商认证弹窗；404 打开模型列表；
  其他类别无动作；回放无动作；`source: tool` 无动作；缺 `requestId`/成功结果无动作；
  会话或模型过期、无会话、bridge 异常、空模型列表均拒绝；入口生成后新一轮
  `agent_start` 使 `streaming=true`，点击仍拒绝打开模型列表；自动备用接管时
  跳过模型动作但保留认证动作；键盘焦点与类名；历史重建不生成动作。

### 3.2 真实 Chromium（视觉）

`node tests/session-ux-phase4b-shots.cjs`：**21/21 通过**。

- 证据：[p4b/measurements.json](ui/session-ux-phase4bc-evidence/p4b/measurements.json)，
  9 张截图在 [p4b](ui/session-ux-phase4bc-evidence/p4b/)。
- 动作按钮高 28px，与原文间距 8px；错误块背景透明、边框 0。
- 1320 与 700 宽、深色与浅色下 `document`/`stream`/错误块/动作行横向溢出均为 0。
- 真实键盘 `Shift+Tab` 可聚焦动作，`:focus-visible` 为 `outline solid 2px`。
- 对比度：按钮 9.45（深色）/ 7.34（浅色），状态文字 9.45 / 6.42 或 6.29。
- 成功/失败状态文案、原始错误保留、重复点击禁用均有实测。

### 3.3 `agent_settled` 时序修复

问题：`attachGenerationRecovery()` 原在 `handleEvent` 的 `switch` 之前调用。
实时 `agent_start` 已把 `S.streaming` 置为 true，而此时 `onSettled()` 尚未执行；
`recoveryActionAvailable('model_picker')` 要求 `streaming=false`，于是真实的
404 模型错误不会出现「选择其他模型」。认证动作不依赖 `streaming`，因此未受影响。

修复：把调用移入 `agent_settled` 分支，在 `onSettled()` 之后执行。`onSettled()`
先收口 `streaming`、当前消息和运行中工具，再判断恢复动作；事件来源、会话、模型、
`workspaceGeneration` 与 `bridgeRun` 的身份校验保持不变。没有新增自动重试、
模型切换或会话命令。

验证：`session-ux-phase4b` 108/108。测试按真实顺序发事件，并断言收口前后的
`streaming` 与按钮状态；旧夹具中手动预置 `streaming=false` 的写法已删除。

## 4. P4-C 视觉实施

- 方案与实施记录：[session-ux-phase4c-visual-proposal.md](session-ux-phase4c-visual-proposal.md)。
- 正式修改：`--turn-gap` 使用 `--ui-space-6`；Thinking、工具组、Plan 卡与 Runtime
  外壳外距分别收回 `--ui-space-2/3`、`--ui-space-2/4`；辅助字号统一
  `--text-xs` + `--leading-normal`，主披露标题统一 `--text-sm`；Runtime
  `≤700px` 的 `.rtc-output` 横向内边距改为 `--ui-space-5`。
- 修改前回滚覆盖：[p4c-before-overrides.css](ui/session-ux-phase4bc-evidence/p4c-before-overrides.css)，
  只在证据页注入；测试断言 `public/` 中没有引用。`public/tokens.css` 未改。
- 真实 Chromium：`node tests/session-ux-phase4c-shots.cjs`，**128/128 通过**。
- 覆盖 1320×820 与 700×600、深色与浅色，Classic 与 Runtime，共 16 张矩阵截图，
  另有工具详情展开 4 张、子代理卡 4 张、右栏现状 1 张、699/701 断点 2 张、
  125% 字体缩放 2 张，共 29 张；证据在
  [p4c/measurements.json](ui/session-ux-phase4bc-evidence/p4c/measurements.json)。
- 关键实测：Runtime 窄窗净宽 366 → **382px**；Classic 内容高 1057.28 → 1040.92px
  （1320）与 1090.25 → 1078.89px（700）；Runtime 内容高 705 → 698px（1320）与
  762 → 754px（700）；所有矩阵横向溢出 0，Composer 可见，工具详情展开锚点偏移 0。
- 补充验证：699px Runtime 净宽 381px、701px 为 339px 且断点两侧零溢出；
  125% 字体缩放下主披露 15px、辅助 13.75px、零溢出且 Composer 完整可见；
  reduced motion 下计划呼吸点 `animation:none`、回到底部 `transition:0s`；
  计划头键盘焦点为 2px `solid` 轮廓。右栏仍为 392px、阅读列净宽 589px。

## 5. 定向回归

逐项 `node tests/<套件>.cjs`，均为退出 0：

| 套件 | 结果 |
| --- | ---: |
| `session-ux-phase1` | 81/81 |
| `session-ux-phase2` | 96/96 |
| `session-ux-phase3` | 128/128 |
| `session-ux-phase4a` | 110/110 |
| `session-ux-phase4b` | 108/108 |
| `session-ux-phase4b-shots` | 21/21 |
| `session-ux-phase4c-shots` | 128/128 |
| `ui2-classic` | 55/55 |
| `ui2-runtime-display` | 83/83 |
| `ui2-visual` | 57/57 |
| `runtime-conversation` | 106/106 |
| `subagents` | 141/141 |
| `thinking-dots` | 90/90 |
| `ui4-feedback` | 27/27 |
| `model-fallback` | 74/74 |
| `provider-auth` | 110/110 |

跳过断言不计入分子分母；上表数字是本次运行的 `N/N` 与失败数 0，不是完整
`npm test` 的结果。

## 6. 冻结、差异与产物

- `public/thinking-dots.js`、`public/thinking-dots.css`：无 diff；动画关键帧、
  速度、节奏、触发时机和调用逻辑未触碰。
- `git diff --check`：无输出。
- 变更 diff：P4-B 为 `public/app.js`、`public/messages.js`，新增
  `public/error-recovery.js`；P4-C 为 `public/styles.css`、
  `public/agent-execution.css`、`public/runtime-conversation.css`；
  `public/tokens.css` 无 diff。`package.json` 只增加 P4-B 测试入口。
- P4-C 的视觉证据包含 29 张截图、回滚覆盖与更新后的 `measurements.json`；
  测试文件为 `tests/session-ux-phase4c-shots.cjs`，另同步
  `tests/ui2-visual.cjs` 的组状态字号断言。
- 未跟踪的 `conpty.*`、`path_util.obj`、`win_delay_load_hook.obj`、`spike/`、
  `tmp-p3-shots.log` 等既有开发残留不进入提交。
- `dist-app` 重建成功；构建产物不入库。用户运行源码版即可看到本分支改动。

## 7. 未验证与待确认

- 未运行完整 `npm test`；未在真实 Electron 沙箱、真实模型长会话、真实读屏下验证。
- P4-B 未对“供应商设置打开后用户实际完成认证/换模型再重发”的闭环做端到端模型调用；
  本轮只验证入口打开、身份校验与状态反馈。
- P4-C 已补 699/701px、125% 字体缩放、reduced motion、键盘焦点与右栏宽度；
  仍未覆盖真实 Electron 打包应用手测、长历史分页与读屏。
- P4-C 正式 CSS 已落地，但本轮不合并、不发版；合并与发布需另行授权。
