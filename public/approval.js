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
import { closeModal, confirmModal, dismissConfirm, openModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import { respond } from './rpc.js';
import {
  approvalSummary,
  decidePayload,
  normalizeApprovalRequest,
  statusForDecision,
  supportsPersistentDecision,
} from './approval-model.js';

/** 正在等待用户决定的请求：requestId -> { request, timer, expired }。 */
const pending = new Map();
/** 已结算的 requestId。**防重放**：同一 id 再来（SSE backlog / 重连补发）不再弹窗。 */
const settled = new Map();
const SETTLED_MAX = 200;
/** 桥接生命周期里这些状态意味着「那个 Pi 已经不在了」。 */
const BRIDGE_GONE = new Set(['starting', 'restarting', 'exited', 'error', 'no-project']);

function rememberSettled(requestId, status) {
  settled.set(requestId, status);
  while (settled.size > SETTLED_MAX) settled.delete(settled.keys().next().value);
}

function dropPending(requestId) {
  const entry = pending.get(requestId);
  if (!entry) return null;
  if (entry.timer) clearTimeout(entry.timer);
  pending.delete(requestId);
  return entry;
}

/** 结算一条：记状态、清 pending、必要时空闲掉 UI。 */
function settle(requestId, status, { send = null } = {}) {
  const entry = dropPending(requestId);
  rememberSettled(requestId, status);
  if (!entry) return false;
  if (send) {
    try {
      respond(requestId, send);
    } catch {
      /* 桥接已经不在（sendCommand 会自己报错）—— 状态已经记下，不重复弹窗才是关键 */
    }
  }
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
 *  （`expired` 标记保证关闭动作不会再触发一次 finish()）。 */
export function cancelPendingApprovals() {
  for (const id of [...pending.keys()]) {
    const entry = pending.get(id);
    if (!entry) continue;
    if (entry.timer) clearTimeout(entry.timer);
    entry.expired = true;
    pending.delete(id);
    rememberSettled(id, 'cancelled');
    try {
      respond(id, decidePayload(entry.request.kind, 'cancel'));
    } catch {
      /* 桥接已断：状态记下即可 */
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

/* ---------- 展示 ---------- */

function contextNote(request) {
  const bits = ['来源：Pi Extension', '一次性决定（协议没有「总是允许」）'];
  if (request.timeout) bits.push(`Pi 会在 ${Math.round(request.timeout / 1000)} 秒后按默认值处理`);
  return bits.join(' · ');
}

function closeSurface(entry) {
  if (entry.surface === 'confirm') dismissConfirm();
  else if (entry.surface === 'modal') closeModal();
}

function show(request) {
  const { requestId, kind } = request;
  const entry = { request, timer: null, expired: false, settled: false, surface: null };
  pending.set(requestId, entry);

  /* timeout 是 Pi 真实给的字段，且 rpc-mode.js 到点就自己用默认值 resolve ——
   * 所以这里只做「到点把卡片收掉并标记 expired」，不替 Pi 决定。 */
  if (request.timeout) {
    entry.timer = setTimeout(() => expire(requestId, 'timeout'), Math.min(request.timeout + 50, 24 * 60 * 60 * 1000));
  }

  if (kind === 'confirm') {
    entry.surface = 'confirm';
    const title = request.title || 'Pi Extension 请求确认';
    confirmModal({
      title,
      message: request.message ? `${request.message}\n\n${contextNote(request)}` : contextNote(request),
      okText: '允许一次',
      cancelText: '拒绝',
    }).then((answer) => {
      if (entry.expired) return;
      if (answer === true) finish(request, 'allow');
      else if (answer === 'alt') finish(request, 'cancel');
      else finish(request, 'deny');
    });
    return;
  }

  entry.surface = 'modal';
  openModal((card, close) => {
    const h = document.createElement('h3');
    h.textContent = request.title || (kind === 'select' ? '请选择' : '请输入');
    card.appendChild(h);

    if (request.message) {
      const p = document.createElement('div');
      p.className = 'modal-desc';
      p.textContent = request.message;
      card.appendChild(p);
    }

    const note = document.createElement('div');
    note.className = 'modal-desc';
    note.textContent = contextNote(request);
    card.appendChild(note);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = '取消';
    /* 先结算再关闭：close() 会触发下面的 onClose，如果顺序反了，
     * onClose 会先把这次请求按「取消」结掉，用户真正选的值就丢了。 */
    cancel.onclick = () => {
      finish(request, 'cancel');
      close();
    };
    actions.appendChild(cancel);

    if (kind === 'select') {
      const list = document.createElement('div');
      list.className = 'modal-list';
      for (const opt of request.options) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'modal-item';
        item.textContent = opt;
        item.onclick = () => {
          finish(request, 'value', opt);
          close();
        };
        list.appendChild(item);
      }
      card.appendChild(list);
      card.appendChild(actions);
      return;
    }

    const input = document.createElement(kind === 'editor' ? 'textarea' : 'input');
    input.className = 'modal-input';
    if (kind === 'editor') input.rows = 6;
    if (request.placeholder && kind !== 'editor') input.placeholder = request.placeholder;
    if (kind === 'editor' && request.prefill) input.value = request.prefill;
    card.appendChild(input);
    setTimeout(() => input.focus(), 30);

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn primary';
    ok.textContent = '提交';
    ok.onclick = () => {
      const value = input.value;
      finish(request, 'value', value);
      close();
    };
    actions.appendChild(ok);
    card.appendChild(actions);
  }, () => {
    /* 点遮罩 / Esc / 被别的弹层顶掉：没结算过的按取消结掉，不能让 Promise 永久挂着。
     * 已经结算过的（按钮路径）什么都不做。 */
    if (!entry.expired && !entry.settled) finish(request, 'cancel');
  });
}

function finish(request, decision, value) {
  const entry = pending.get(request.requestId);
  if (!entry || entry.settled) return;
  entry.settled = true;
  const status = statusForDecision(request.kind, decision);
  settle(request.requestId, status, { send: decidePayload(request.kind, decision, value) });
  if (decision === 'allow') toast('已允许这一次', 'info');
  else if (decision === 'deny') toast('已拒绝这次请求', 'info');
}

/* ---------- 只读快照（给测试与诊断） ---------- */

export function approvalSnapshot() {
  return {
    pending: [...pending.values()].map((e) => ({ ...e.request })),
    settled: [...settled.entries()].map(([requestId, status]) => ({ requestId, status })),
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

