# UI-4B 审批与确认交互验收

日期：2026-10-17，Asia/Shanghai。工作区 `C:/pi-GUI-ui4-approval`；分支 `codex/ui4-approval`；共同基线 `17f855f01fedb7b13a13496ba45ebf8d28e465ac`。

状态：Classic 审批卡、确认弹窗与既有 Runtime 审批 DOM 的展示层改造完成；专项 jsdom 契约与真实 Electron 渲染矩阵全绿。本地提交，未 push、未 merge main、未打 tag、未发版。完整 `npm test` 留给集成阶段。

## 1. 勘察结论

复用的现有抽象：

- Classic 审批生命周期已在 `public/approval.js`：`pending` / `settled`、workspaceGeneration / bridgeRun 守卫、Stop / 超时 / 桥接重启 / agent settled 路径。
- 协议规范化在 `public/approval-model.js`（未改）：title ≤200、message ≤600、options ≤20×80、`risk` 恒为 `unknown`、无持久化。
- 确认层、焦点陷阱、焦点归还、Esc / Enter 语义在 `public/ui/modal.js`；`#modal` / `#confirmLayer` 也是 `right-pane.js` 原生 Browser 遮挡逻辑认的两个既有层。

与任务设想的偏离（按现有代码为准）：

1. `public/index.html` 禁改，所以 `public/ui4-approval.css` 由 `approval.js` 幂等注入 `<link id="ui4-approval-style">`；集成方以后加静态 link 时复用同一节点。模式与 UI-3C 的 `ensureStylesheet` 一致。
2. `runtime-conversation.js` / `runtime-sessions.js` 禁改，所以 Runtime 侧只做两件事：新 CSS 统一既有 `.rtc-approval` / `.runtime-approval` 的视觉；从 `approval.js` 导出 `renderRuntimeApproval()` 作为可集成的展示接口（一次性点击、提交中禁用、失败可见、owner 变化标为失效）。本分支不接线。
3. Classic 协议对 `extension_ui_response` **没有回执**。UI 只能区分「展示完成」「HTTP 已接受并写入 Pi stdin」「发送失败」，不能声称「Pi 已确认执行」。状态矩阵与文案都按这条边界写。

改动前的两个实测缺陷（本任务修复）：

- **Workspace 切换后旧审批仍可点击并真的发出应答**：旧实现只在收到新请求时比较 generation，已在屏幕上的卡片没有生命周期清理；点击后会带着当前 `__bridgeRun` 发送。
- **投递失败不可见**：旧实现用 fire-and-forget 的 `respond()`，`/api/command` 返回 `{ok:false}` 时卡片照常关闭、本地记为 `allowed`。现在改为等待发送结果，失败保留卡片并允许重试。

## 2. 变更范围

相对基线 `17f855f`：

| 文件 | 行数 | 说明 |
|---|---:|---|
| `public/approval.js` | 751 | Classic 审批展示、状态机、生命周期守卫、投递结果、Runtime 展示接口 |
| `public/ui/modal.js` | 475 | confirmModal 结构化正文 / 提交态 / 失败态 / surface 认领；默认行为不变 |
| `public/ui4-approval.css` | 377 | 新增；仅 `--ui-*` 语义 token；Classic + 既有 Runtime DOM |
| `tests/ui4-approval.cjs` | 1010 | 新增；jsdom 契约 + `--electron` 真实渲染矩阵 |
| `docs/claude-ui-redesign/UI-4B-acceptance.md` | 本文 | 验收与接口说明 |
| `docs/claude-ui-redesign/ui4b-evidence/` | 证据 | 日志、`electron/results.json`、22 张 PNG |

未改动：`server/`、`electron/`、`app.js`、`index.html`、`tokens.css`、`styles.css`、`rpc.js`、`api.js`、`runtime-store.js`、`runtime-state.js`、`runtime-conversation.js`、`runtime-sessions.js`、`approval-model.js`、`package.json`。

## 3. 审批状态矩阵（Classic）

「展示完成」= 卡片已经渲染；「请求发送成功」= `/api/command` 返回 `ok:true`（后端已把命令写进 Pi stdin）；「Pi 确认完成」协议**不存在**，UI 不显示这个状态。

| 状态 | 触发 | 卡片 | 协议 | 本地记录 |
|---|---|---|---|---|
| `pending` | 收到 `extension_ui_request` | 显示完整正文、来源/类型、一次性决定、超时事实、风险未知 | 无 | `pending` |
| `submitting` | 点击允许/拒绝/取消，或 Esc / 点遮罩取消 | 按钮禁用、`aria-busy=true`、状态行「正在把决定发给 Pi…」 | `extension_ui_response` 在飞 | `pending` 保留，`entry.submitting=true` |
| `sent` | 后端接受命令 | 关闭卡片 + toast「已允许这一次 / 已拒绝这次请求」 | 命令已写入 Pi stdin；无回执 | `settled=allowed/denied/answered/cancelled`；`deliveries=sent` |
| `failed` | 后端明确拒绝（`ok:false`，非网络） | 卡片保留、错误状态行、按钮恢复、可重试 | 应答未送达 | 仍在 `pending`；`deliveries=failed` |
| `unreached` | 网络层失败（fetch 抛错） | 同上，文案明确「没有送达」 | 应答未送达 | 仍在 `pending`；`deliveries.unreached/network=true` |
| `expired` | 超时 / 桥接重启 / 工作区切换 / 会话切换 / agent settled | 关闭卡片；超时保留既有 toast | **不发应答**（Pi 自行按默认值处理或进程已消失） | `settled=expired` |
| `cancelled` | Stop；或 select/input/editor 的取消成功投递 | 关闭卡片 | `{cancelled:true}` | `settled=cancelled` |
| `allowed` / `denied` / `answered` | 成功投递后的终态 | 已关闭 | confirm 允许 `{confirmed:true}`；拒绝 `{confirmed:false}`；其余 `{value}` | `settled` 对应值 |
| 迟到结果 | 发送在 Stop / 切换 / 超时之后才返回 | 不再打开卡片 | — | 不改写已记录的 `expired/cancelled` |
| 重复提交 | 提交中再次点击 / 键盘 | 按钮已禁用 + 状态机 guard | 只发一条 | — |

补充：确认卡的「拒绝」回 `{confirmed:false}`；Esc、点遮罩、Stop 回 `{cancelled:true}`。两者在 Pi 侧都按 false 解析（fail-closed），但 UI 语义不再把「关闭」说成「明确拒绝」。被另一个确认框顶掉时仍按 `denied` 结算（保持既有 P19 断言）。

## 4. Classic / Runtime 差异

| 维度 | Classic | Runtime |
|---|---|---|
| 事实来源 | `approval.js` 的 `pending/settled`，SSE → `observeApprovalEvent` | `runtime-store.js` 的 `approvals[]`（`runtime_event`） |
| 渲染位置 | `#confirmLayer` / `#modal` | `runtime-conversation.js` / `runtime-sessions.js` 内联 DOM |
| 应答通道 | `/api/command` + `__bridgeRun`，等待 HTTP 结果 | `/api/runtime-sessions` + 抓取的 owner；服务端 `stale_approval` |
| 可展示字段 | title / message / options / placeholder / prefill / timeout | 只投影 id / method / title / options（无 message、timeout） |
| 风险信息 | `risk` 恒为 `unknown`，只显示「协议未提供」 | 无风险字段 |
| 重复提交 | 本任务新增 `submitting` 状态机 | 现有 `action` busy / `view.pending`（未改） |
| Owner 变化 | workspaceGeneration + bridgeRun + `S.switching` | 闭包抓取的 owner + 服务端 stale_approval |
| 本任务改动 | 展示 + 生命周期 + 投递观测 | 仅新 CSS 统一视觉；提供 `renderRuntimeApproval()` 接口，未接线 |

关键差异：Runtime 的展示投影**没有正文**。本任务没有、也不能在 UI 层编造；接入 `renderRuntimeApproval()` 后仍然只显示 store 真实有的字段。若需要正文，必须先扩展 store 投影（属于集成阶段）。

## 5. 安全边界

- **fail-closed**：拒绝、取消、Esc、点遮罩、Stop、超时、切换都不会产生「允许」。
- **没有 Always Allow / Bypass / Auto Approve**：确认卡仍只有「拒绝 / 允许一次」两个按钮；`supportsPersistentDecision()` 恒为 false；Runtime 接口也不提供。
- **不猜风险**：`risk` 恒为 `unknown`；卡片只陈述「协议未提供结构化风险信息」，不从文案推断危险等级。
- **真实操作完整展示**：`message` 是扩展给用户判断的原文；UI 不再二次截断，长命令 / 长路径在卡片内滚动换行。上游 `approval-model.js` 的 600 字符上限未改（不在允许范围），限制见第 9 节。
- **不可信文本**：title / message / options / placeholder / prefill / Runtime title 全部 `textContent`；`approval.js` 无 `innerHTML`。
- **不存原始 payload**：快照的 `deliveries` 只记 `requestId / outcome / network` 三个结构字段，不记应答正文或后端错误原文。
- **旧上下文不可授权**：工作区 generation / 会话切换 / bridgeRun 变化时本地作废；点击时再次校验，陈旧卡片不发应答并收掉。
- **Stop 不留关不掉的卡**：等待中的请求收到 `{cancelled:true}` 并收卡；已在提交中的决定不补发第二条互相矛盾的应答，但卡片仍然收掉。
- **重复点击**：提交中按钮同步禁用 + `entry.submitting/settled` 双重 guard；Esc / 点遮罩 / Enter 在提交中不关闭、不重发。
- **键盘不隐式允许**：确认卡初始焦点在「拒绝」；卡片本身聚焦时 Enter 被阻止（`enterBlocked`）；危险确认的既有 Enter 阻止逻辑保留。
- **Runtime owner 不变**：本任务不改 Runtime 的 owner 判定；接口把 `respond()` 返回 `null/undefined` 视为「会话已切换」，只标失效并说明没有发送，不伪造取消。
- **默认 Modal 行为不变**：没有 `onDecide` 的既有 confirmModal 调用仍点击即关闭；焦点陷阱 / 焦点归还 / Esc 语义保持。

## 6. 专项测试

新增 `tests/ui4-approval.cjs`，使用真实 `index.html`、`approval.js`、`ui/modal.js`，`/api/command` 换成可控 fetch 桩（成功 / 后端拒绝 / 网络失败 / 手动放行），不绕过真实审批 handler。

| 命令 | 结果 | 失败 | 跳过 | 退出码 |
|---|---:|---:|---:|---:|
| `node tests/ui4-approval.cjs` | **44/44** | 0 | 0 | 0 |
| `node tests/ui4-approval.cjs --electron` | jsdom 44/44 + Electron **44/44**，22 张截图 | 0 | 0 | 0 |

jsdom 覆盖：允许 / 拒绝 / Esc 取消 / 点遮罩取消；三连击与提交中 Esc·遮罩·Enter 不重发；迟到结果不覆盖 `expired`；工作区 / 会话切换；Stop（含提交中）；超时；桥接重启；空字段；恶意 HTML 与额外字段；长命令完整渲染；焦点初始位置 / Tab·Shift+Tab / 焦点归还；Enter 不隐式允许；确认层叠在普通弹层之上、超时只收自己的卡；select / input / editor（含提交中与失败重试）；Runtime 展示接口（一次性点击、失败可见、owner 变化、select/input、恶意标题）；样式表幂等与 token 边界；`respond()` 已被可观察的 `sendCommand` 替代；既有 confirmModal 默认行为未变。

## 7. 回归结果（实际数字）

| 命令 | 结果 |
|---|---|
| `node tests/approvals.cjs` | 80/80 |
| `node tests/interactions.cjs` | passed |
| `node tests/runtime-ui.cjs` | 16/16 |
| `node tests/runtime-conversation.cjs` | 48/48 |
| `node tests/runtime-resources.cjs` | 45/45 |
| `node tests/runtime-finish-ui.cjs` | 27/27 |
| `node tests/stop-barrier.cjs` | 16/16 cases |
| `node tests/smoke.cjs` | 1338/1338（与基线相同） |
| `node tests/ui2-classic.cjs` | 48/48 |
| `node tests/ui2-runtime-display.cjs` | 82/82 |
| `node tests/modules.cjs` | 117/117 |
| `node tests/dev-server.cjs` | 30/30 |

全部退出码 0；既有套件断言数未下降。原始输出：[regressions.log](ui4b-evidence/regressions.log)。

未运行：完整 `npm test`（按任务要求留给集成阶段；`package.json` 测试入口未改）、完整 `tests/cdp-shot.cjs` 270 张矩阵（本轮 700/900/1200/1536 的真实渲染由 Electron 矩阵覆盖）。

## 8. Electron 渲染证据

- 结果：[electron/results.json](ui4b-evidence/electron/results.json)；Electron 44.4.3 / Chromium 152.0.7977.130；44/44，0 失败，0 跳过，22 张 PNG。
- 矩阵：Dark/Light × 700/900/1200/1536 CSS px × 右栏关闭/打开（Changes surface）= 16 张；另有提交中、投递失败、select、input、Runtime、reduced-motion 共 6 张。
- 断言：卡片在视口内、页面无横向滚动、正文与操作区无横向溢出、按钮 nowrap 且高度 ≥30、初始焦点在「拒绝」、右栏状态正确、提交中按钮禁用、失败卡片不关闭、reduced-motion 下 `animationName === 'none'`、受信 CDP 键盘的 Tab / Shift+Tab / Enter / Esc 行为。
- 方法：真实 Electron 加载生产 `public/index.html` + `public/`；`tests/visual-harness.cjs` 提供离线静态资源与 SSE 夹具；`capturePage` 只取网页像素。
- 限制：右栏使用 Changes（DOM）而不是原生 Browser 视图；截图不含 OS 窗口装饰；不连接真实 Pi；Runtime 截图使用本任务提供的 `renderRuntimeApproval()` 接口渲染在真实页面里，**不是**已接线的 Runtime 数据流。

## 9. 待集成接口

1. **样式表**：集成时可在 `index.html` 加
   ```html
   <link id="ui4-approval-style" rel="stylesheet" href="/ui4-approval.css">
   ```
   `ensureApprovalStylesheet()` 会按 id 复用；不加也会在 `approval.js` 加载时幂等注入一份。
2. **Runtime 展示**：
   ```js
   import { renderRuntimeApproval } from './approval.js';

   const row = /* 现有的 .rtc-approval / .runtime-approval 容器 */;
   const view = renderRuntimeApproval(row, {
     approval: a,                 // { id, method, title, options }
     respond: (payload) => {      // 必须保留现有 owner 闭包守卫
       const owner = { ...r.owner };
       if (!same(store.get(id)?.owner, owner)) return Promise.resolve(null);
       return action(id, { action: 'command', owner, command: { type: 'extension_ui_response', id: a.id, ...payload } });
     },
   });
   ```
   `respond` 返回 `{ok:true}` / `{ok:false,error}` / `null`（owner 已变）。接口负责一次性点击、提交中禁用、失败重试、失效提示；**不**负责 owner 校验、不碰 store、不发请求。
3. **建议接线点**：`runtime-conversation.js` 的 approvals 渲染块（约 398–412 行）与 `runtime-sessions.js` 的等价块（约 124–137 行）。本分支未改这两个共享文件。
4. **测试入口**：集成时把 `node tests/ui4-approval.cjs` 加进 canonical test 链；Electron 矩阵单独放 `test:ui4`（需要图形环境，不强迫无头 CI 执行）。
5. **风险字段**：如果以后 Pi 提供结构化 risk，应先在协议/模型层增加字段，再在 `approvalCardModel()` 里展示；不要在 UI 层解析自然语言。
6. **正文上限**：`approval-model.js` 的 600 字符上限未改。若需要展示更长的命令，应单独评审并修改模型层，而不是在 UI 层绕过规范化。

## 10. 已知限制

- Classic 协议没有应答回执：`ok:true` 只代表后端接受并写入 Pi stdin，UI 不显示「Pi 已确认」。
- `approval-model.js` 把 message 截到 600 字符（title 200、option 80×20）；这是既有安全边界，本任务不在允许修改范围内。UI 完整显示**规范化后的**正文，并在超长命令测试里验证不再二次截断。
- Runtime 审批仍未接入新展示接口；当前只获得 CSS 统一。Runtime store 投影没有正文，UI 不编造。
- 同一时刻只有一个确认框：新确认框顶掉旧的时，旧请求按 `denied` 结算（既有 P19 行为，未改）。
- Stop 发生在「允许已发出但结果未知」的窗口时，无法撤回已写出的允许；界面只保证不再补发第二条矛盾应答并收卡。
- 本分支只改源码：**未重建 `dist-app` / 安装包**。源码版可见全部改动；集成合并后必须重建产物（`npm run build:app -- --rebuild` 或项目发布流程），否则用户看到的仍是旧界面。
- 没有使用真实 Pi、真实用户会话或真实项目做写操作；所有测试数据为 jsdom / Electron fixture。

## 11. 提交

| 内容 | SHA |
|---|---|
| 共同基线 | `17f855f01fedb7b13a13496ba45ebf8d28e465ac` |
| 产品（`approval.js` / `modal.js` / `ui4-approval.css`） | `6848689e916c9c56f99930b5030f2a306a6cdfad` |
| 测试（`tests/ui4-approval.cjs`） | `015f7d2265ff3d9cfaad94ee9a20fd0358ccb376` |
| 本文档与证据 | 见 `git log -1`（文档无法包含自身提交 SHA） |

未 push、未 merge main、未打 tag、未发版。
