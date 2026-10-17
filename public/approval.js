/* P19 Approval：把 Pi 的 extension UI 对话框接成**统一、可追踪、可过期**的审批流。
 *
 * ---------- 它拦得住什么，拦不住什么 ----------
 *
 * 拦得住：Pi 进程里的 Extension 用 `ctx.ui.confirm/select/input/editor` 发起的请求。
 * 这些方法在 RPC 模式下会**阻塞**到客户端回应答（`docs/rpc.md`），典型权限扩展的
 * 写法就是 `const ok = await ctx.ui.confirm(…); if (!ok) return { block: true }`
 * —— 所以「拒绝」是真的会让这次工具调用不执行（阻断点在 Extension 的 `tool_call`
 * hook：pi docs/extensions.md 说它「在工具执行之前触发、**Can block**」）。
 *
 * 拦不住：没有任何 Extension 来问的工具调用。Pi GUI 是 RPC 客户端，注册不了
 * `tool_call` handler；Pi 核心也没有自带审批弹窗。**不会**用「先放行再假装取消」充数。
 *
 * ---------- 复用同一套确认 foundation ----------
 *
 * `confirm` 类请求走 `ui/modal.js` 的 `confirmModal`（与撤销文件、删除会话、
 * 重启 Pi 同一层、同一套危险语义），不再各画一个；`select` / `input` / `editor`
 * 需要真正的输入控件，走 `openModal`，但生命周期由这里的同一张表管。
 * 全程 textContent，扩展给的文案一律当不可信文本。 */

import { S } from './state.js';
import { closeModal, confirmModal, confirmSurfaceMeta, dismissConfirm, modalSurfaceMeta, openModal } from './ui/modal.js';
import { feedbackContext, toast } from './ui/toast.js';
import { sendCommand } from './api.js';
import { logRendererEvent } from './log-client.js';
import {
  approvalSummary,
  decidePayload,
  normalizeApprovalRequest,
  statusForDecision,
  supportsPersistentDecision,
} from './approval-model.js';

/** 正在等待用户决定的请求：requestId -> { request, timer, expired, submitting, settled }。 */
const pending = new Map();
/** 已结算的 requestId。**防重放**：同一 id 再来（SSE backlog / 重连补发）不再弹窗。 */
const settled = new Map();
/** 应答投递结果：requestId -> { requestId, outcome, network }。
 *  只记结构与结果，**不记应答正文或错误原文**（诊断报告可能被贴出去）。 */
const deliveries = new Map();
const SETTLED_MAX = 200;
/** 桥接生命周期里这些状态意味着「那个 Pi 已经不在了」。
 *  `maintenance`（Pi 正在被 self-update 替换）也算：进程正在退出，
 *  挂着的审批不可能再被应答 —— 但它是**计划内**的停机，所以调用方
 *  只当「expire」，不要顺手把它说成崩溃。 */
const BRIDGE_GONE = new Set(['starting', 'restarting', 'exited', 'error', 'no-project', 'maintenance']);

function rememberSettled(requestId, status) {
  settled.set(requestId, status);
  while (settled.size > SETTLED_MAX) settled.delete(settled.keys().next().value);
}

function rememberDelivery(requestId, outcome, network = false) {
  deliveries.set(requestId, { requestId, outcome, network });
  while (deliveries.size > SETTLED_MAX) deliveries.delete(deliveries.keys().next().value);
}

function dropPending(requestId) {
  const entry = pending.get(requestId);
  if (!entry) return null;
  if (entry.timer) clearTimeout(entry.timer);
  pending.delete(requestId);
  return entry;
}

/** 这条 pending 是否仍然属于当前 workspace / bridge run。
 *
 *  协议没有「请求属于哪一代」的字段，`workspaceGeneration` / `bridgeRun` 是
 *  **收到请求那一刻** 抓的。切换工作区或 bridge 换代之后，旧请求不能再被当作
 *  当前项目的授权 —— 即使卡片还留在屏幕上，点下去也只能本地作废。 */
function stillCurrent(request) {
  if (S.switching) return false;
  if (Number.isInteger(S.workspaceGeneration) && Number.isInteger(request.workspaceGeneration)
    && request.workspaceGeneration !== S.workspaceGeneration) return false;
  if (Number.isInteger(S.bridgeRun) && Number.isInteger(request.bridgeRun) && request.bridgeRun !== S.bridgeRun) return false;
  return true;
}

/**
 * 发出一条协议应答，并等它**真正被后端接受**。
 *
 * 三种结果必须分开（验收文档里的状态矩阵就是按这个分的）：
 *   · `sent`      —— HTTP 已接受、命令已写进 Pi 的 stdin。协议没有回执，
 *                    所以这**不是**「Pi 已确认执行」；
 *   · `failed`    —— 后端明确拒绝（stale_approval / 桥接不在 / 停止屏障…）；
 *   · `unknown`   —— 网络或响应解析失败；可能已经写入 stdin，不能重发决定。
 *
 * 旧实现用 fire-and-forget 的 respond()，失败完全不可见：卡片照常关闭、
 * 状态记成 allowed。这里改成可等待的发送，让调用方决定是收卡还是保留重试。
 */
async function deliver(request, send) {
  const entry = pending.get(request.requestId);
  let result;
  try {
    result = await sendCommand({ type: 'extension_ui_response', id: request.requestId, ...send }, { notify: false });
    // The owned card (or Stop's local warning) displays this result once.
  } catch {
    result = { ok: false, network: true };
  }
  const network = result?.network === true;
  const ok = result?.ok === true;
  const outcome = ok ? 'sent' : result?.ok === false && !network ? 'failed' : 'unknown';
  if (outcome === 'failed') logRendererEvent('runtime.approval_failed', { state: 'failed', reason: 'delivery_failed' });
  else if (outcome === 'unknown') logRendererEvent('runtime.approval_unknown', { state: 'unknown', reason: 'delivery_unknown' });
  rememberDelivery(request.requestId, outcome, network);
  if (entry) entry.lastDelivery = outcome;
  return { ok, network, outcome };
}

/** 结算一条：记状态、清 pending。
 *  已经不在 pending 的（被 Stop / 切换 / 超时先作废）不再改写状态 ——
 *  否则一条迟到的成功会把 `expired` 悄悄改成 `allowed`。 */
function settle(requestId, status) {
  const dropped = dropPending(requestId);
  if (!dropped) return false;
  rememberSettled(requestId, status);
  return true;
}

/* ---------- 事件入口 ---------- */

/**
 * SSE 入口。只认两类事件：approval 请求本身，以及会让所有 pending 作废的桥接生命周期。
 * @param {object} evt
 * @param {{workspaceGeneration:number, bridgeRun:number|null, switching?:boolean}} scope
 */
export function observeApprovalEvent(evt, scope = S) {
  if (evt?.type === 'bridge_status' && BRIDGE_GONE.has(evt.state)) {
    /* Pi 没了 / 正在换：pending 的对话框不可能再被应答，本地作废，**不发应答**
     * （发了也是给一个不存在的进程）。 */
    expireAll('bridge');
    return;
  }
  if (evt?.type === 'bridge_status' && evt.state === 'ready' && Number.isInteger(evt.bridgeRun)) {
    /* 新 bridge run：旧 run 的对话框一律作废。 */
    for (const [id, entry] of [...pending]) {
      if (entry.request.bridgeRun !== null && entry.request.bridgeRun !== evt.bridgeRun) expire(id, 'bridge-run-changed');
    }
    return;
  }
  if (evt?.type !== 'extension_ui_request') return;
  const request = normalizeApprovalRequest(evt, scope);
  if (!request) return;
  /* 回放 / 重复：已经结算过或正在等待的 id 都不再弹第二次。 */
  if (settled.has(request.requestId) || pending.has(request.requestId)) return;
  /* 陈旧守卫：请求属于旧 workspace / 旧 bridge run 时直接丢弃。 */
  if (Number.isInteger(S.workspaceGeneration) && Number.isInteger(request.workspaceGeneration)
    && request.workspaceGeneration !== S.workspaceGeneration) return;
  if (Number.isInteger(S.bridgeRun) && Number.isInteger(request.bridgeRun) && request.bridgeRun !== S.bridgeRun) return;
  if (S.switching) return;
  show(request);
}

/** 桥接/工作区变化时把所有等待中的请求作废（本地，不回话）。 */
export function expireAll(reason = 'stale') {
  for (const id of [...pending.keys()]) expire(id, reason);
}

/** 用户 Stop / 中断：pending 的对话框必须收到 fail-closed 的取消，不能永远挂着。
 *  两个方向都要收干净：给 Pi 一个明确的取消应答，并且把界面上的卡片收掉
 *  （`expired` 标记保证关闭动作不会再触发一次提交）。
 *
 *  正在提交中的那条不再补发取消：决定已经写出去了，再补一条
 *  `{cancelled:true}` 会让 Pi 收到两条互相矛盾的应答。卡片仍然收掉 ——
 *  Stop 之后屏幕上不能留一张关不掉的卡。 */
export function cancelPendingApprovals() {
  for (const id of [...pending.keys()]) {
    const entry = pending.get(id);
    if (!entry) continue;
    if (entry.timer) clearTimeout(entry.timer);
    entry.expired = true;
    pending.delete(id);
    rememberSettled(id, 'cancelled');
    if (!entry.submitting && !entry.deliveryUnknown) {
      /* Stop 的取消是**用户明确意图**：即使投递失败也要收卡，并把失败原因
       * 说出来。留着卡片让用户再点一次「拒绝」并不能让 Pi 收到取消。 */
      const context = feedbackContext();
      void deliver(entry.request, decidePayload(entry.request.kind, 'cancel')).then((r) => {
        if (!r.ok) toast(r.outcome === 'unknown' ? '停止已请求；审批取消的投递结果未知，无法确认 Pi 是否收到' : '停止已请求；后端未接受审批取消，请重新读取会话状态', 'warn', { context });
      });
    }
    closeSurface(entry);
  }
}

function expire(requestId, reason) {
  const entry = pending.get(requestId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.expired = true;
  pending.delete(requestId);
  rememberSettled(requestId, 'expired');
  closeSurface(entry);
  if (reason === 'timeout') toast('这次 Pi Extension 请求已超时，Pi 按默认值处理了', 'info');
}

/* ---------- 工作区 / 会话生命周期 ----------
 *
 * 旧实现只在**收到新请求时**比较 generation，对「已经挂着的请求」没有动作：
 * 切了工作区，旧卡片还留在屏幕上，点「允许一次」真的会把应答发给旧 run
 * （如果桥接恰好还活着）或者被后端 stale_approval 拒绝。两种都不该发生。
 *
 * 这里监听的是 state.js / rpc.js 已经派发的既有事件，不新增协议：
 *   · `pi-gui:workspace-generation` —— 换工作区，整代作废；
 *   · `pi-gui:session-switch`       —— 新会话 / 分叉，旧会话的请求不再属于当前上下文。
 * 作废是**本地**的：不发应答（旧请求的 Pi 侧要么已经不在，要么由 Pi 自己的
 * 超时按默认值处理），只收卡、记 expired。 */
function onWorkspaceGeneration() {
  for (const [id, entry] of [...pending]) {
    if (!stillCurrent(entry.request)) expire(id, 'workspace-changed');
  }
}

function onSessionSwitch() {
  for (const id of [...pending.keys()]) expire(id, 'session-switched');
}

if (typeof document !== 'undefined') {
  document.addEventListener('pi-gui:workspace-generation', onWorkspaceGeneration);
  document.addEventListener('pi-gui:session-switch', onSessionSwitch);
}

/* ---------- 展示 ---------- */

/** 只关「自己那张卡」。
 *
 *  旧实现直接 dismissConfirm() / closeModal()：如果用户在这条审批还挂着时
 *  打开了别的弹层（例如从文件变更面板点了撤销），超时/桥接重启会把**别人的**
 *  卡片一起关掉。现在按 surface + requestId 认领。 */
function closeSurface(entry) {
  if (entry.surface === 'confirm') {
    if (confirmSurfaceMeta()?.requestId === entry.request.requestId) dismissConfirm();
  } else if (entry.surface === 'modal') {
    if (modalSurfaceMeta()?.requestId === entry.request.requestId) closeModal();
  }
}

/** 卡片上的「来源 / 一次性 / 超时」事实行。全部来自协议真实字段或模型常量。 */
function contextNote(request) {
  const bits = ['此请求来自经典会话，与 Runtime / Planner 视图分别归属', '一次性决定（协议没有「总是允许」）'];
  if (request.timeout) bits.push(`Pi 会在 ${Math.round(request.timeout / 1000)} 秒后按默认值处理`);
  return bits.join(' · ');
}

const KIND_LABELS = {
  confirm: '确认请求',
  select: '选择请求',
  input: '输入请求',
  editor: '编辑请求',
};

/** 展示模型：卡片要显示什么，以及为什么。
 *
 *  ---------- 这里刻意**不**做什么 ----------
 *
 *  · 不做风险分级：协议没有结构化风险字段（`risk` 恒为 unknown），
 *    所以只显示「协议未提供结构化风险信息」，绝不从自然语言猜「危险 / 安全」；
 *  · 不做摘要代替正文：`message` 是扩展给用户判断用的原文，完整渲染、
 *    可滚动，不在 UI 层再截断；
 *  · 不发明作用域：没有 scope 就没有「本次会话 / 这个工具」这类按钮；
 *  · 不把命令 / 路径解析成链接或高亮成「可执行代码」—— 只按纯文本
 *    换行渲染（CSS 的 overflow-wrap:anywhere 负责长串不撑破卡片）。 */
export function approvalCardModel(request) {
  const kind = request?.kind || 'confirm';
  const details = [];
  if (request?.message) details.push({ label: '请求内容', text: request.message });
  return {
    requestId: request?.requestId || '',
    kind,
    title: request?.title || `Pi Extension ${KIND_LABELS[kind] || '请求'}`,
    source: '来源：Pi Extension · 经典会话',
    kindLabel: KIND_LABELS[kind] || '请求',
    details,
    context: contextNote(request || {}),
    risk: request?.risk || 'unknown',
    riskNote: '协议未提供结构化风险信息：这里不判断这次操作是否危险，请按上面的真实内容自行决定。',
    timeout: request?.timeout || null,
    scope: request?.scope ?? null,
    action: request?.action ?? null,
    persistent: supportsPersistentDecision(),
    options: Array.isArray(request?.options) ? [...request.options] : [],
    placeholder: request?.placeholder || '',
    prefill: request?.prefill || '',
  };
}

/* ---------- Runtime 审批的展示接口（供集成方接线，本阶段不直接改共享文件） ----------
 *
 * Runtime 的审批来自另一条真相（runtime-store.js 的 approvals[]），由
 * runtime-conversation.js / runtime-sessions.js 渲染。本任务不允许修改那两个
 * 文件，所以这里只提供一个**可集成的展示函数**：
 *
 *   renderRuntimeApproval(row, { approval, respond })
 *
 * `row` 是调用方已经创建的 `.rtc-approval` / `.runtime-approval` 容器；
 * `respond(response)` 由调用方提供，必须自己完成 owner 守卫（现有代码在
 * 闭包里抓 `{...r.owner}` 再比较），返回：
 *   · `{ok:true}`            —— 后端已接受命令；
 *   · `{ok:false,error}`     —— 明确失败，卡片保留可重试；
 *   · `null` / `undefined`   —— owner 已变化，本次点击作废（卡片标为失效）。
 *
 * 这个函数**只做展示与一次性点击**：不碰 store、不发请求、不改协议、
 * 不提供「总是允许」。集成方接线后即可获得：提交中禁用、重复点击只发一次、
 * 失败可见、owner 变化后不再可点。 */
export function renderRuntimeApproval(row, { approval, respond } = {}) {
  if (!row || !approval || typeof respond !== 'function') return null;
  const method = approval.method;
  const buttons = [];
  let settled = false;
  let submitting = false;

  row.dataset.approvalId = String(approval.id || '');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', approval.title ? `Pi Extension 请求：${approval.title}` : 'Pi Extension 请求');

  const title = document.createElement('p');
  title.textContent = approval.title || 'Pi Extension 请求';
  row.appendChild(title);

  const status = document.createElement('div');
  status.className = 'ui4-confirm-status';
  status.hidden = true;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  row.appendChild(status);

  const setBusy = (on, text = '') => {
    submitting = on;
    for (const b of buttons) {
      if (b.tagName === 'TEXTAREA') b.readOnly = on || settled;
      else b.disabled = on || settled;
    }
    row.setAttribute('aria-busy', on ? 'true' : 'false');
    if (on) {
      status.hidden = false;
      status.dataset.state = 'pending';
      status.textContent = text || '正在把决定发给 Pi…';
    }
  };

  const send = async (response) => {
    if (settled || submitting) return;
    const payload = typeof response === 'function' ? response() : response;
    setBusy(true);
    let result;
    try {
      result = await respond(payload);
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err || '') };
    }
    if (result === null || result === undefined) {
      /* owner 已变化：这条审批不属于当前会话了。保留卡片但不再可点，
       * 并明确说明没有发送 —— 不伪造「已取消」。 */
      settled = true;
      for (const b of buttons) {
        if (b.tagName === 'TEXTAREA') b.readOnly = true;
        else b.disabled = true;
      }
      row.setAttribute('aria-busy', 'false');
      row.dataset.state = 'stale';
      status.hidden = false;
      status.dataset.state = 'error';
      status.textContent = '会话已切换，这条审批不再属于当前会话；没有发送任何应答。';
      return;
    }
    if (result?.ok === true) {
      settled = true;
      for (const b of buttons) {
        if (b.tagName === 'TEXTAREA') b.readOnly = true;
        else b.disabled = true;
      }
      row.setAttribute('aria-busy', 'false');
      row.dataset.state = 'sent';
      status.hidden = false;
      status.dataset.state = 'pending';
      /* 措辞刻意区分「已交给 Pi」与「Pi 已确认」—— 协议没有回执。 */
      status.textContent = '应答已交给 Pi。';
      return;
    }
    setBusy(false);
    status.hidden = false;
    status.dataset.state = 'error';
    status.textContent = result?.error || '后端没有接受这条应答；请重试或取消。';
  };

  const button = (label, className, response) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.onclick = () => void send(response);
    buttons.push(b);
    row.appendChild(b);
    return b;
  };

  /* textarea 只进 buttons 是为了统一 readOnly；按钮禁用逻辑里会跳过它。 */
  const textareaButton = (node) => { buttons.push(node); return node; };

  if (method === 'confirm') {
    button('确认', 'btn', { confirmed: true });
    button('拒绝', 'btn', { confirmed: false });
  } else if (method === 'select') {
    for (const value of approval.options || []) button(String(value), 'btn', { value: String(value) });
  } else {
    const value = document.createElement('textarea');
    value.setAttribute('aria-label', approval.title || '审批输入');
    row.appendChild(value);
    textareaButton(value);
    button('提交', 'btn', () => ({ value: value.value }));
  }
  const cancel = button('取消', 'btn', { cancelled: true });
  return { send, cancel, buttons };
}

/* ---------- 样式表注入 ----------
 *
 * `public/index.html` 不在本任务的允许修改范围内，所以 ui4-approval.css 由本模块
 * 幂等注入。集成方以后在 index.html 里加静态 <link id="ui4-approval-style"> 时，
 * 这里会检测到并复用，不会出现第二份样式表。 */
const STYLE_ID = 'ui4-approval-style';

export function ensureApprovalStylesheet(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return null;
  const existing = doc.getElementById(STYLE_ID);
  if (existing) return existing;
  const link = doc.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.setAttribute('data-ui4-approval', '');
  let href = './ui4-approval.css';
  try {
    href = new URL('/ui4-approval.css', doc.baseURI).href;
  } catch {
    /* 老引擎没有 URL —— 回落相对路径 */
  }
  link.href = href;
  (doc.head || doc.documentElement).appendChild(link);
  return link;
}

ensureApprovalStylesheet();

/** 一次决定的完整流程：本地作废守卫 → 发协议应答 → 等后端接受。
 *
 *  返回给展示层的结果只有两种：`{ok:true, outcome:'sent'}` 或
 *  `{ok:false, error, outcome}`。**只有 ok 才能关闭卡片** —— 这样
 *  「点了允许但后端没接受」不会再被静默吞掉。 */
async function commitDecision(request, decision, value) {
  const entry = pending.get(request.requestId);
  if (!entry || entry.settled) return { ok: false, error: '这条审批已经处理过了' };
  if (entry.expired) return { ok: false, error: '这条审批已失效（工作区 / 会话已切换或已超时）' };
  if (entry.submitting) return { ok: false, error: '上一条决定还在发送中' };
  if (!stillCurrent(request)) {
    /* 卡片还在屏幕上，但它已经不属于当前项目：本地作废，不发应答，并且
     * 把卡片收掉 —— 留一张点了也没用的卡只会让用户反复尝试。 */
    entry.expired = true;
    rememberSettled(request.requestId, 'expired');
    dropPending(request.requestId);
    closeSurface(entry);
    return { ok: false, error: '项目或会话已切换，这条审批已失效；没有向 Pi 发送任何应答' };
  }
  entry.submitting = true;
  entry.settled = true;
  const status = statusForDecision(request.kind, decision);
  const result = await deliver(request, decidePayload(request.kind, decision, value));
  entry.submitting = false;
  const ownsSurface = (entry.surface === 'confirm' ? confirmSurfaceMeta() : modalSurfaceMeta())?.requestId === request.requestId;
  const current = pending.get(request.requestId) === entry && !entry.expired && stillCurrent(request);
  if (!result.ok && (!current || !ownsSurface)) {
    toast(result.outcome === 'unknown' ? '此前审批的投递结果未知，不能据此重发决定；Stop 不能撤回已发决定。' : '此前审批的应答未被后端接受；不会自动重发。', 'warn', { context: entry.context, persistent: true });
  }
  // Never let a late decision change the surface or settled status of a replacement.
  if (!current) {
    return { ok: false, stale: true };
  }
  if (!result.ok) {
    if (result.outcome === 'unknown') {
      entry.deliveryUnknown = true;
      rememberSettled(request.requestId, 'unknown');
      return { ok: false, uncertain: true, outcome: 'unknown', error: '投递结果未知：决定可能已送达，不能重复发送。Stop 不能撤回已经发出的决定；可关闭提示并重新读取会话状态。' };
    }
    /* 投递失败：撤销本地结算，把卡片留在屏幕上让用户重试。
     * 不自动重发 —— 重试必须是用户的下一次明确点击。
     * 但如果这条在等待期间已经被生命周期作废（Stop / 切工作区 / 超时），
     * 就不能把 expired 抹掉 —— 那会让 SSE 重放有机会再弹一次。 */
    entry.settled = false;
    if (!entry.expired) settled.delete(request.requestId);
    return {
      ok: false,
      outcome: result.outcome,
      error: '后端没有接受这条应答；请核实当前会话后重试或停止。',
    };
  }
  settle(request.requestId, status);
  if (decision === 'allow') toast('已允许这一次', 'info');
  else if (decision === 'deny') toast('已拒绝这次请求', 'info');
  return { ok: true, outcome: 'sent' };
}

function show(request) {
  const { requestId, kind } = request;
  const entry = { request, timer: null, expired: false, settled: false, submitting: false, surface: null, context: feedbackContext() };
  pending.set(requestId, entry);

  /* timeout 是 Pi 真实给的字段，且 rpc-mode.js 到点就自己用默认值 resolve ——
   * 所以这里只做「到点把卡片收掉并标记 expired」，不替 Pi 决定。 */
  if (request.timeout) {
    entry.timer = setTimeout(() => expire(requestId, 'timeout'), Math.min(request.timeout + 50, 24 * 60 * 60 * 1000));
  }

  const model = approvalCardModel(request);

  if (kind === 'confirm') {
    entry.surface = 'confirm';
    confirmModal({
      title: model.title,
      message: '',
      okText: '允许一次',
      cancelText: '拒绝',
      source: model.source,
      kindLabel: model.kindLabel,
      details: model.details,
      risk: model.riskNote,
      context: model.context,
      surface: 'approval',
      meta: { requestId, kind, enterBlocked: true },
      submittingText: '正在把决定发给 Pi…',
      failureText: '未能确认应答结果，请核实当前会话状态。',
      onDecide: (answer) => {
        if (answer === true) return commitDecision(request, 'allow');
        if (answer === 'cancel' || answer === 'alt') return commitDecision(request, 'cancel');
        return commitDecision(request, 'deny');
      },
    }).then((answer) => {
      /* 没有 onDecide 成功路径之外的关闭只可能来自：被别的确认框顶掉、
       * Esc / 点遮罩（提交中已屏蔽）。这些在协议语义里都是「取消」。 */
      if (entry.deliveryUnknown) { dropPending(requestId); return; }
      if (entry.expired || entry.settled) return;
      if (answer === true) void commitDecision(request, 'allow');
      else if (answer === 'alt') void commitDecision(request, 'cancel');
      else void commitDecision(request, 'deny');
    });
    return;
  }

  entry.surface = 'modal';
  /* 卡片里的取消按钮要在 build 闭包外也能被 Esc / 点遮罩触发，
   * 所以先把引用留在这里。 */
  let cancelButton = null;
  openModal((card, close) => {
    const h = document.createElement('h3');
    h.id = 'ui4ApprovalTitle';
    h.textContent = model.title;
    card.appendChild(h);

    const src = document.createElement('div');
    src.className = 'ui4-confirm-source';
    src.textContent = `${model.source} · ${model.kindLabel}`;
    card.appendChild(src);

    if (request.message) {
      const p = document.createElement('div');
      p.className = 'modal-desc';
      p.id = 'ui4ApprovalMessage';
      p.textContent = request.message;
      card.appendChild(p);
    }

    const risk = document.createElement('div');
    risk.className = 'ui4-confirm-risk';
    risk.id = 'ui4ApprovalRisk';
    risk.textContent = model.riskNote;
    card.appendChild(risk);

    const note = document.createElement('div');
    note.className = 'ui4-confirm-context';
    note.id = 'ui4ApprovalContext';
    note.textContent = model.context;
    card.appendChild(note);

    const status = document.createElement('div');
    status.className = 'ui4-confirm-status';
    status.hidden = true;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    card.appendChild(status);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = '取消';
    cancelButton = cancel;
    actions.appendChild(cancel);

    const buttons = [cancel];
    const setBusy = (on, text = '') => {
      for (const b of buttons) b.disabled = on;
      card.setAttribute('aria-busy', on ? 'true' : 'false');
      if (on) {
        status.hidden = false;
        status.dataset.state = 'pending';
        status.textContent = text || '正在把决定发给 Pi…';
      }
    };
    const showFailure = (text) => {
      status.hidden = false;
      status.dataset.state = 'error';
      status.textContent = text;
    };

    const decide = async (decision, value, button) => {
      if (entry.settled || entry.expired) return;
      setBusy(true);
      const result = await commitDecision(request, decision, value);
      /* 提交期间卡片可能被生命周期收掉（Stop / 工作区切换 / 超时）——
       * 这时 DOM 已清空，不能再写状态或还焦点。 */
      if (!card.isConnected || entry.expired || modalSurfaceMeta()?.requestId !== requestId || !stillCurrent(request)) return;
      if (result.ok) {
        close();
        return;
      }
      setBusy(false);
      showFailure(result.error);
      if (result.uncertain) {
        for (const b of buttons) b.disabled = true;
        card.querySelectorAll('input,textarea').forEach(input => { input.readOnly = true; });
        status.dataset.state = 'unknown';
        cancel.disabled = false; cancel.textContent = '关闭提示'; cancel.onclick = close;
        cancel.focus();
        return;
      }
      (button || cancel).focus();
    };

    /* 先结算再关闭：close() 会触发下面的 onClose，如果顺序反了，
     * onClose 会先把这次请求按「取消」结掉，用户真正选的值就丢了。 */
    cancel.onclick = () => void decide('cancel', undefined, cancel);

    if (kind === 'select') {
      const list = document.createElement('div');
      list.className = 'modal-list';
      for (const opt of request.options) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'modal-item';
        item.textContent = opt;
        item.onclick = () => void decide('value', opt, item);
        buttons.push(item);
        list.appendChild(item);
      }
      card.appendChild(list);
      card.appendChild(actions);
      return;
    }

    const input = document.createElement(kind === 'editor' ? 'textarea' : 'input');
    input.className = 'modal-input';
    input.setAttribute('aria-labelledby', h.id);
    if (kind === 'editor') input.rows = 6;
    if (request.placeholder && kind !== 'editor') input.placeholder = request.placeholder;
    if (kind === 'editor' && request.prefill) input.value = request.prefill;
    card.appendChild(input);
    setTimeout(() => { if (modalSurfaceMeta()?.requestId === requestId && !entry.expired) input.focus(); }, 30);

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn primary';
    ok.textContent = '提交';
    ok.onclick = () => void decide('value', input.value, ok);
    buttons.push(ok);
    actions.appendChild(ok);
    card.appendChild(actions);
  }, () => {
    /* 被别的弹层顶掉（openModal 会先关旧的）：没结算过的按取消结掉，
     * 不能让这条请求永远挂着。用户主动的 Esc / 点遮罩走下面的 onCancel，
     * 那条路径会把失败原因留在卡片上。 */
    if (entry.deliveryUnknown) { dropPending(requestId); return; }
    if (!entry.expired && !entry.settled) void commitDecision(request, 'cancel');
  }, {
    surface: 'approval',
    meta: { requestId, kind },
    labelledBy: 'ui4ApprovalTitle',
    describedBy: 'ui4ApprovalRisk ui4ApprovalContext',
    onCancel: () => {
      /* 卡片里的取消按钮与 Esc / 点遮罩共用这一个出口。
       * 走按钮的 onclick 而不是直接关层，这样投递失败时卡片会留着说明原因。 */
      if (cancelButton) cancelButton.click();
    },
  });
}

/* ---------- 只读快照（给测试与诊断） ---------- */

export function approvalSnapshot() {
  return {
    pending: [...pending.values()].map((e) => ({ ...e.request })),
    settled: [...settled.entries()].map(([requestId, status]) => ({ requestId, status })),
    /* 应答投递结果（sent / failed / unknown）。**不是**「Pi 已确认执行」——
     * 协议没有回执，sent 只代表后端接受了命令并写进 stdin。 */
    deliveries: [...deliveries.values()].map((d) => ({ ...d })),
    persistentDecisionSupported: supportsPersistentDecision(),
    summaryOf: (request) => approvalSummary(request),
  };
}

/* ---------- Extensions / Capabilities 页：能力报告（supported / unsupported 都必须说清） ---------- */

import { renderSetupSection } from './ui/capability-setup.js';
import { setupViewModel, NA, TRI_UNKNOWN, statusOf } from './capability-model.js';

const CHECK_LABELS = {
  toolCallHook: 'Extension 可在工具执行前阻断（tool_call hook）',
  uiPromptDialog: '扩展可向本界面要一次确认并阻塞等待应答',
  coreApproval: 'Pi 核心自带审批弹窗 / 全局权限闸门',
  customUiOverRpc: 'RPC 模式下 ctx.ui.custom() 可用',
};

/**
 * Approval 能力 → 统一 setup 布局的 descriptor（P22）。
 *
 * 它**不是 Extension 包**：没有安装命令、没有 npm 名字。这里只把四项探测结果
 * （每项都带出处）投影成统一的一行，不宣称任何没探到的拦截能力。
 */
export function approvalCapability(report) {
  const checks = report?.checks || {};
  const verdict = (key) => {
    const check = checks[key];
    if (check?.supported === true) return '是';
    if (check?.supported === false) return '否';
    return TRI_UNKNOWN;
  };
  const hook = checks.toolCallHook?.supported;
  return {
    id: 'approval',
    kind: 'capability',
    name: 'Approval / Permission',
    purpose: '装了会「先问一句」的 permission Extension 时，用本界面的一次性确认把请求接住，并把允许 / 拒绝作为明确的协议应答回给 Pi。',
    origin: 'pi',
    packageName: null,
    installCommand: null,
    installNote: '这是 Pi 的协议能力（extension_ui_request），不是 Extension 包 —— 没有安装命令。真正的闸门来自你装的 permission Extension。',
    state: {
      installed: NA,
      configured: NA,
      loaded: typeof hook === 'boolean' ? hook : null,
      runtimeObserved: NA,
      restartRequired: NA,
      diagnostic: report && report.ok === false ? { phase: 'probe', message: '能力报告暂不可用；此处不宣称任何已具备的拦截能力' } : null,
    },
    statusOverride: typeof hook === 'boolean'
      ? (hook
        ? { dot: 'on', key: 'loaded', label: 'Extension 可以在工具执行前阻断' }
        : { dot: 'warn', key: 'not-loaded', label: '这个 pi 不支持 tool_call 阻断' })
      : statusOf({ installed: NA }),
    notes: Object.entries(CHECK_LABELS).map(([key, label]) => {
      const check = checks[key];
      return `${label}：${verdict(key)}${check?.evidence ? ' —— ' + check.evidence : ''}`;
    }).concat(
      Object.keys(checks).length ? [] : ['能力报告暂不可用；此处不宣称任何已具备的拦截能力。'],
      [
        report?.piVersion ? `检测到 pi ${report.piVersion}` : '无法确认本机 pi 版本',
        'Pi GUI 只能阻断「走 extension_ui_request 来问」的请求 —— 也就是装了这类 permission Extension 之后才存在的闸门。它无法拦下没人来问的工具调用，也不是 OS sandbox。',
      ],
    ),
    limits: [
      '决定是一次性的：协议没有持久化能力，所以界面不提供「总是允许 / 按作用域允许」，也不做风险分级（协议没有结构化风险字段，风险显示 unknown）。',
    ],
    source: 'GET /api/approvals/capability（只读本机 pi 包探测，不联网、不执行扩展）',
  };
}

export function renderApprovalSetup(box, report) {
  const model = setupViewModel(approvalCapability(report && report.ok !== false ? report : null));
  box.replaceChildren(renderSetupSection(model));
  return box;
}

