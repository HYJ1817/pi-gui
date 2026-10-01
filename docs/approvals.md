# Approval / Permission（P19）

这份文档回答一个问题：**Pi GUI 到底能不能拦住一次工具调用？**

答案是：**能拦，但只在特定条件下**。P19 的第一原则是「没有真实拦截能力就不要画成能拦截」，
所以下面每一句都标了真实出处的证据（原始核对对象是本机装的 **pi 0.87.0** 包，
路径相对于 pi 包根）。

> **P20.5 复核对（0.99.1）**：这套机制**没有变**。`ToolCallEventResult` 仍是
> `block?` / `reason?` / `terminate?`（`terminate` **0.87.0 就有，不是 0.99 新增**）；
> `extension_ui_request` 的
> 9 个方法一字不差；`ctx.ui.custom()` 在 RPC 下依旧返回 `undefined`
> （0.99.1 的 `docs/rpc-extension-ui.md` 明确列出）。核心依然没有自带审批闸门。
> 所以 P19 的结论与实现**不需要迁移**。见
> [pi-compatibility.md](pi-compatibility.md) §〇。

## 一、真实能力（核对到 pi 0.87.0，0.99.1 已复核）

| 能力 | 真实出处 | 结论 |
|---|---|---|
| **Extension 可以在工具执行前阻断** | `docs/extensions.md`：`pi.on("tool_call", …)`「Fired after `tool_execution_start`, before the tool executes. **Can block.**」；`dist/core/extensions/types.d.ts` 的 `ToolCallEventResult` 有 `block?: boolean` | **支持**（在 Extension 侧）|
| **扩展可以问用户，并阻塞等待回答** | `docs/rpc.md`：对话框方法（`select`/`confirm`/`input`/`editor`）「emit an `extension_ui_request` on stdout and **block until** the client sends back an `extension_ui_response` with the matching `id`」 | **支持**（RPC 子协议）|
| **Pi 核心自带审批弹窗 / 全局权限闸门** | `docs/usage.md`：「It intentionally does not include built-in MCP, sub-agents, **permission popups**, plan mode…」 | **不支持** |
| **GUI 自己决定「每个工具调用都先问我」** | 没有这种通道：`tool_call` handler 只能由 pi 进程内的 Extension 注册；Pi GUI 是 RPC 客户端 | **不支持** |
| **用 `ctx.ui.custom()` 画审批框的扩展** | `dist/modes/rpc/rpc-mode.js`：`async custom() { // Custom UI not supported in RPC mode; return undefined }` | **在 Pi GUI 里退化为不弹窗**（拿不到对话框）|

**官方/第三方 permission 扩展**（例如 `pi-ask-permission`、`pi-edit-approval`、
`@thurstonsand/pi-permissions`）就是靠上表前两行工作的：`tool_call` 里
`await ctx.ui.confirm(...)`，用户点「拒绝」→ 返回 `{ block: true }` → 工具不执行。
**Pi GUI 不实现这些 Extension**，只负责把它们的对话框如实呈现。

### 典型写法（pi docs/extensions.md 原文示例）

```js
pi.on("tool_call", async (event, ctx) => {
  const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
  if (!ok) return { block: true, reason: "Blocked by user" };
});
```

## 二、Pi GUI 真正做了什么

```
Pi 进程里的 Extension
  └ ctx.ui.confirm/select/input/editor
      └ RPC: extension_ui_request（阻塞）
          └ SSE → approval.js observeApprovalEvent（workspace/run 守卫）
              └ 统一确认层（#confirmLayer）或输入弹层（#modal）
                  └ 用户决定 → extension_ui_response（明确协议命令）
                      └ Extension 拿到 true/false → { block: true } 或放行
```

- **允许 / 拒绝是真的**：应答走 `extension_ui_response`，`confirm` 的
  `{confirmed:false}` 或 `{cancelled:true}` 在 `rpc-mode.js` 里都被解析成 `false`
  （**fail-closed**），权限扩展据此返回 `{block:true}`，工具就不会执行。
- **决定只有一次性**：协议没有持久化能力（每次都是新的 `id` + 一次性应答），
  所以界面**不提供**「总是允许 / 按作用域允许」。`supportsPersistentDecision()` 恒为 `false`。
- **不做风险分级**：协议里没有结构化风险字段 → `risk` 恒为 `unknown`。
  不从标题/正文的自然语言猜「这是不是危险命令」。
- **不是 OS sandbox**：这里拦的是「有 Extension 来问」的调用；进程权限、
  文件系统、网络仍由操作系统和 pi 进程本身决定。

### 统一确认 foundation

`confirm` 类请求走 `ui/modal.js` 的 `confirmModal` —— **和撤销文件、删除会话、
重启 Pi 是同一层、同一套危险语义**（危险操作用 `.btn.danger`，键盘 Enter 不会误确认）。
`select` / `input` / `editor` 需要真正的输入控件，走 `#modal`，但生命周期由
`approval.js` 的同一张表管理。P19 删掉了 `app.js` 里原先自己实现的三套对话框函数
（`uiSelect` / `uiConfirm` / `uiInput`），因此不存在两套并行的确认 UI。

## 三、生命周期

| 状态 | 何时进入 |
|---|---|
| `pending` | 收到 `extension_ui_request` 且通过身份 + 陈旧守卫 |
| `allowed` / `denied` | `confirm` 类请求被允许 / 拒绝（Esc、点遮罩、被别的确认框顶掉都算拒绝 —— fail-closed）|
| `answered` / `cancelled` | `select` / `input` / `editor` 提交了值 / 被取消 |
| `expired` | 请求自带 `timeout`，到点后 Pi 侧已用默认值 resolve（GUI 只收卡片，**不发应答**）；或桥接/工作区已变、`agent_settled` 后仍挂着 |

守卫：

- **身份**：`requestId` 就是 Pi 给的 `id`；没有 `id` 的请求**不弹窗**（没法应答，就不让用户对着空气点）。
- **防重放**：同一个 `id` 在 pending 或已结算时再来（SSE backlog / 重连补发）**不重复弹窗**。
- **陈旧**：workspaceGeneration / bridgeRun 不匹配、或正在切项目（`S.switching`）时直接丢弃。
- **桥接重启 / 退出 / 无项目**：所有 pending 本地作废并收卡，**不给一个已经不存在的进程发应答**。
- **Stop / 中断**：所有 pending 收到 `{cancelled:true}`（fail-closed）并收卡，不留永远等的卡片。
- **`agent_settled`**：Pi 已收尾，还挂着的对话框不可能再被应答 → 本地作废。

## 四、安全投影

对话框是**不可信输入**（来自第三方 Extension）：

- 只投影协议真实字段：`id`、`method`、`title`、`message`、`options`、`placeholder`、`prefill`、`timeout`。
- `title` ≤ 200 字符、`message` ≤ 600、每个 `option` ≤ 80 字符且最多 20 条、`prefill` ≤ 2000。
- 一律 `textContent`：`<img onerror>`、`<script>` 只是文本。
- 事件里多出来的字段（`env`、`token`、`apiKey`、`authorization`、`cookie`、`command`、`rawArgs`…）
  **不投影**，也不进 DOM。
- 后端能力报告只回**出处片段**（文件名 + 行号 + 原文截断），**不回 pi 包目录的绝对路径**。
- 原始 payload 不进日志、不进诊断、不进 renderer。

## 五、能力报告

`GET /api/approvals/capability`（后端只读本机 pi 包，不执行它的代码）返回四项三值结论：
`toolCallHook` / `uiPromptDialog` / `coreApproval` / `customUiOverRpc`，每项都带
「文件名:行号 + 原文」的证据。找不到证据就是 `null`（未知），**不猜**。

Extensions 页的 **Approval / Permission** 区块把它显示出来，并写明：

> Pi GUI 只能阻断「走 extension_ui_request 来问」的请求 —— 也就是装了这类
> permission Extension 之后才存在的闸门。它无法拦下没人来问的工具调用，也不是 OS sandbox。

**没有装这类 Extension 时，界面上不会出现任何「允许/拒绝」按钮**（也没有全局开关），
因为那种按钮会是假的。

## 六、明确不做

- 不做全局权限系统 / RBAC / 策略引擎 / 云策略；不做「按路径自动白名单」。
- 不从模型文本猜风险，不做自动批准。
- 不修改第三方 Extension，不自动安装 package（包括 permission 扩展）。
- 不做 Browser Use、不做 OS sandbox。
- **不用「先放行再假装取消」冒充审批**：`tool_execution_start` 之后 Pi GUI 没有任何
  取消通道，所以绝不根据它画一个假的取消。

## 七、验证

`npm run test:approvals`（79 条，已并入 `npm test`，完全离线）：模型字段与边界、
四种对话框、allow/deny/answered/cancelled/expired、缺失 id 拒弹、重放去重、
陈旧守卫、桥接重启、Stop、超时、恶意 HTML 惰性、额外字段不投影、
「不存在总是允许」、能力块不出现假按钮、能力探测（fixture 世界 + 缺包未知 + 不泄露路径）、
以及 Session Search / Planner / Web / Subagent / Memory 回归。

`tests/smoke.cjs` 的 P19 段落走**真实 SSE**：统一确认层弹出、只有一次性的允许/拒绝、
重放不重复弹窗、允许走 `extension_ui_response`、已结算不再弹、Stop 取消并收卡、
切项目同步期间不弹新请求、重启清空并收卡。

live（不属于默认 CI）：装一个真实的 permission Extension（例如
`pi install npm:<你信任的 permission 包>`），重启 Pi，让它问一次，确认
「拒绝」真的让这次工具调用没有执行 —— 这是唯一能证明端到端拦截的人工步骤。
本阶段**没有执行** live。

## 八、相关文件

- `public/approval-model.js` —— 规范化模型（纯函数）
- `public/approval.js` —— 存储 / 生命周期 / 统一确认层渲染 / 能力块
- `server/approval-probe.js` —— 只读能力探测（复用 `server/mcp.js` 的 pi 包定位）
- `public/ui/modal.js` —— `confirmModal`（统一确认 foundation）+ `dismissConfirm`
- `tests/approvals.cjs` —— 离线契约
- [security.md](security.md) / [pi-compatibility.md](pi-compatibility.md) / [architecture.md](architecture.md)
