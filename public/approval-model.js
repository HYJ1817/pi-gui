/* P19 Approval 的规范化模型（纯函数，无 DOM、无 IO）。
 *
 * ---------- 这个模型建立在什么之上 ----------
 *
 * Pi 0.87.0 的真实协议（`pi-coding-agent/docs/rpc.md` 第 1186-1275 行、
 * `dist/modes/rpc/rpc-mode.js` 的 createExtensionUIContext）：
 *
 *   · 对话框方法 `select` / `confirm` / `input` / `editor` 会发出
 *     `extension_ui_request`，并**阻塞**到客户端用匹配的 `id` 回
 *     `extension_ui_response`；
 *   · `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text`
 *     是 fire-and-forget，不需要应答；
 *   · 请求可带 `timeout`（毫秒），**由 Pi 侧自行用默认值 resolve**
 *     （confirm 的默认是 false）—— 客户端不需要自己计时来「替 Pi 决定」；
 *   · 应答形状：`{confirmed: true|false}` / `{value}` / `{cancelled: true}`。
 *
 * 与之配套的拦截能力在 Extension 侧：`pi.on("tool_call", …)` —— pi 的
 * docs/extensions.md 说它「在工具执行之前触发、**Can block**」，返回
 * `{ block: true, reason?: string, terminate?: boolean }`。典型写法是
 * `const ok = await ctx.ui.confirm(…); if (!ok) return { block: true }`。
 *
 * ---------- 这个模型**不是**什么 ----------
 *
 * · 不是 OS sandbox，也不是全局权限系统：Pi GUI 是 RPC 客户端，
 *   自己**不能**注册 `tool_call` handler，因此无法拦下「没人来问」的工具调用。
 * · 风险等级不做文本猜测：协议里没有结构化的风险字段，所以 risk 恒为
 *   `unknown`（宁可不分类，也不从自然语言猜）。
 * · 不发明作用域：协议没有 scope 字段 → `scope` 恒为 null，
 *   因此也不会出现「总是允许 / 按作用域允许」（那需要真实持久化协议）。
 *
 * 字段永远只来自协议真实字段；没有证据的一律 null。 */

/** 会阻塞等待应答的对话框方法（rpc.md 明确列出这四个）。 */
export const APPROVAL_KINDS = Object.freeze(['select', 'confirm', 'input', 'editor']);
/** 不需要应答的 fire-and-forget 方法 —— 不是 approval。 */
export const FIRE_AND_FORGET_METHODS = Object.freeze(['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']);

/** 生命周期状态。`answered` 只用于 select/input/editor（协议里它们没有「允许/拒绝」语义）。 */
export const APPROVAL_STATUSES = Object.freeze(['pending', 'allowed', 'denied', 'answered', 'cancelled', 'expired']);

const TITLE_MAX = 200;
const MESSAGE_MAX = 600;
const OPTION_MAX = 80;
const OPTION_COUNT_MAX = 20;
const VALUE_MAX = 2000;

/** 单行化 + 截断。控制字符一律去掉：它们是终端/日志注入面，不是内容。 */
function line(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 多行文本：保留换行，但去控制字符、限长。扩展给的 message 是给人读的正文。 */
function block(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
}

/** 只保留字符串选项，去重、限量、限长。非字符串一律丢掉（不 JSON.stringify）。 */
function options(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = line(item, OPTION_MAX);
    if (!s || out.includes(s)) continue;
    out.push(s);
    if (out.length >= OPTION_COUNT_MAX) break;
  }
  return out;
}

/** 这条事件是不是等待应答的 approval 请求。 */
export function isDialogRequest(evt) {
  return evt?.type === 'extension_ui_request' && APPROVAL_KINDS.includes(evt?.method);
}

/**
 * 把一条 `extension_ui_request` 规范化成 approval 请求。
 * 没有 `id` 就返回 null —— 没有身份就没法应答，宁可不弹窗，也不让用户对着空气点按钮。
 *
 * @param {object} evt  SSE 事件（真实字段：type/id/method/title/message/options/placeholder/prefill/timeout）
 * @param {{workspaceGeneration:number, bridgeRun:number|null}} scope
 */
export function normalizeApprovalRequest(evt, scope = {}) {
  if (!isDialogRequest(evt)) return null;
  const requestId = typeof evt.id === 'string' && evt.id ? evt.id : '';
  if (!requestId) return null;
  const kind = evt.method;
  const title = line(evt.title, TITLE_MAX);
  const message = block(evt.message, MESSAGE_MAX);
  /* timeout 只作为「Pi 会自己按默认值处理」的事实展示，GUI 不据此替 Pi 决定。 */
  const timeout = Number.isFinite(evt.timeout) && evt.timeout > 0 ? Math.floor(evt.timeout) : null;
  return {
    requestId,
    kind,
    /* 协议里没有这些字段，所以是 null，不是猜出来的值。 */
    action: null,
    scope: null,
    risk: 'unknown',
    /* 有证据：请求来自 Pi 进程里的 Extension（RPC 子协议就是扩展 UI 通道）。 */
    source: 'pi-extension',
    title,
    message,
    options: kind === 'select' ? options(evt.options) : [],
    placeholder: line(evt.placeholder, TITLE_MAX),
    prefill: kind === 'editor' ? block(evt.prefill, VALUE_MAX) : '',
    timeout,
    status: 'pending',
    /* 同一 SSE 重放不会重复弹窗：身份就是 Pi 给的 id。 */
    requestedAt: Date.now(),
    settledAt: null,
    workspaceGeneration: Number.isInteger(scope.workspaceGeneration) ? scope.workspaceGeneration : null,
    bridgeRun: Number.isInteger(scope.bridgeRun) ? scope.bridgeRun : null,
  };
}

/**
 * 用户决定 → 协议应答载荷。只产出 rpc.md 列出的三种形状。
 * 「关闭 / 取消」一律走 `cancelled`，显式拒绝走 `confirmed: false`
 * （rpc-mode.js 对两者都解析成 false，是 fail-closed 的）。
 */
export function decidePayload(kind, decision, value) {
  if (decision === 'cancel') return { cancelled: true };
  if (kind === 'confirm') return { confirmed: decision === 'allow' };
  const text = typeof value === 'string' ? value.slice(0, VALUE_MAX) : '';
  return { value: text };
}

/** 决定对应的终态。 */
export function statusForDecision(kind, decision) {
  if (decision === 'cancel') return 'cancelled';
  if (kind === 'confirm') return decision === 'allow' ? 'allowed' : 'denied';
  return 'answered';
}

/** 卡片上那一行安全摘要：只有 kind 与扩展自己写的 title，没有原始 payload。 */
export function approvalSummary(request) {
  const kind = APPROVAL_KINDS.includes(request?.kind) ? request.kind : 'unknown';
  const title = line(request?.title, TITLE_MAX);
  return `Pi Extension · ${kind}${title ? ' · ' + title : ''}`.slice(0, 380);
}

/** 是否允许出现「总是允许 / 按作用域允许」。
 * 协议没有持久化能力（每次都是新的 id + 一次性应答），所以答案恒为 false。 */
export function supportsPersistentDecision() {
  return false;
}
