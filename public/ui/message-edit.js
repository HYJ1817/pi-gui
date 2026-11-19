/* 历史用户消息的就地编辑器。
 *
 * 只负责 DOM、键盘、IME 与一次提交的忙/错状态；历史定位、事务、身份校验
 * 全部由调用方注入的 `preflight` / `resend` 完成。这样 Classic 与 Runtime
 * 共用同一套编辑器，而两边各自保留自己的 owner / conversationId 语义。
 *
 * 关键约束：
 *   - 原消息位置就地展开，不跳到底部输入区，也不弹页面级对话框；
 *   - 首次预检锁定的 nativeSessionId / entryId / parentId / leafId 就是本次
 *     事务的目标；提交时只核对，绝不用新的 userIndex 投影替换目标；
 *   - Escape / 取消恢复原消息；组合输入期间不响应 Escape；
 *   - 空白消息不提交；提交中按钮禁用，双击不会发第二次；
 *   - 失败保留用户已经输入的全部文本，只有成功才关闭；
 *   - 结果未知时保留 requestId，提供“重新同步会话状态”入口，不盲目重试；
 *   - 只有 preflight 确认后续历史含工具/文件操作时才显示“不会自动撤销”警告。
 */
let active = null;
let editorSeq = 0;

const ERROR_TEXT = {
  session_streaming: '当前会话正在生成，完成后再试。',
  session_compacting: '当前会话正在压缩历史，完成后再试。',
  session_queued: '当前会话还有排队中的消息，完成后再试。',
  session_busy: '当前会话正在处理，完成后再试。',
  runtime_busy: '当前会话正在生成或等待审批，完成后再试。',
  edit_in_progress: '这个会话已经有一个编辑事务在进行中，请稍候。',
  stop_in_progress: '正在停止当前生成，完成后再试。',
  stale_runtime: '会话已经切换或重启，请关闭编辑器后重新操作。',
  stale_session: '会话已经切换，请刷新后重新操作。',
  stale_history: '会话历史已经变化，请关闭编辑器后重新打开这条消息。',
  missing_target_identity: '无法确认要编辑的原始消息，请关闭编辑器后重新打开。',
  unknown_user_message: '这条消息已不在当前对话路径上，请刷新后重试。',
  history_unparsable: '无法解析当前会话历史，未发送。',
  navigate_unavailable: '当前 Pi 版本不支持在原会话内移动历史，未发送。',
  navigate_failed: '无法移动会话历史，未发送。',
  navigate_unverified: '历史移动结果未能确认，已尝试恢复原对话。',
  restore_unconfirmed: '无法确认已经恢复原对话，请刷新会话检查后再操作。',
  restore_unavailable: '当前 Pi 版本无法安全恢复原对话，未发送。',
  attachments_unsupported: '这条消息包含无法安全重发的附件，请重新附上文件后再发送。',
  command_text_conflict: '消息以已注册的命令开头，会被当成命令执行；请修改开头。',
  empty_message: '消息不能为空。',
  message_too_large: '消息过长，未发送。',
  model_unavailable: '当前会话没有可用模型，未发送。',
  prompt_handled: '这条消息被命令处理器接管，未产生新的回复。',
  prompt_rejected: 'Pi 拒绝了这次发送，已尝试恢复原对话。',
  prompt_unconfirmed: 'Pi 没有接受这次发送，已尝试恢复原对话。',
  pi_timeout: 'Pi 没有及时应答，未发送。',
  pi_request_failed: 'Pi 没有接受这次操作，未发送。',
  acceptance_unknown: '提交结果未确认，请重新同步会话状态后再操作。',
  recovery_pending: '事务结果尚未确认，请重新同步会话状态。',
  recovery_required: '会话或运行时已经变化，无法继续确认这次事务；请刷新会话检查历史。',
};

function errorText(code) {
  return ERROR_TEXT[code] || '重新发送失败，请稍后重试。';
}

export const messageEditErrorText = errorText;

/* 预检遇到「这个会话已有编辑事务」时，后端有两种真实形状：
 *   - Classic 服务直接失败：{ ok:false, code:'edit_in_progress' }
 *   - Runtime 走 busyReason：{ ok:true, canEdit:false, reason:'edit_in_progress' }
 * 渲染器必须两种都认，否则刷新后只能看到一个无法解除的忙状态，拿不到
 * 持久化的 requestId 恢复入口。 */
export function isEditInProgress(result) {
  return result?.code === 'edit_in_progress'
    || (result?.ok === true && result.canEdit === false && result.reason === 'edit_in_progress');
}

export function messageEditRequestId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* fall through */ }
  return 'edit-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

/* 未解决事务的 requestId 只存在内存里的话，渲染器一刷新就再也查不到结果，
 * 服务端的锁却不会因此释放。用 sessionStorage 按标签页保留记录：
 * 刷新/重连后仍能用原 requestId 调 status / recover；应用重启时 storage
 * 自然清空，后端内存事务也已消失，不伪造“已恢复”。
 *
 * 存储是一个**按作用域区分的小数组**，不是单槽：Classic 与多个独立
 * Runtime 会话可以同时各有一个未解决事务，后写入的记录不能把前一个
 * 会话唯一的恢复句柄覆盖掉。 */
const PENDING_KEY = 'pi-gui:message-edit-pending';
const MAX_PENDING_RECORDS = 8;

function pendingStore() {
  try { return globalThis.sessionStorage || null; } catch { return null; }
}

function readPendingRecords() {
  try {
    const raw = pendingStore()?.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter(record => record && typeof record.requestId === 'string');
  } catch { return []; }
}

function writePendingRecords(records) {
  try {
    if (!records.length) { pendingStore()?.removeItem(PENDING_KEY); return; }
    pendingStore()?.setItem(PENDING_KEY, JSON.stringify(records.slice(-MAX_PENDING_RECORDS)));
  } catch { /* storage unavailable */ }
}

function pendingScopeMatches(recordScope, currentScope) {
  if (!recordScope || !currentScope) return true;
  return Object.keys(currentScope).every(key => recordScope[key] === currentScope[key]);
}

/* 同一会话/对话的记录互相替换；不同作用域各自保留。 */
function samePendingScope(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'runtime') return Boolean(a.conversationId) && a.conversationId === b.conversationId;
  return Boolean(a.sessionId) && a.sessionId === b.sessionId;
}

/* scope 为空时返回最近一条（兼容旧调用与单记录场景）；有 scope 时只返回
 * 匹配该作用域的记录，避免 Classic 读到另一个 Runtime 会话的句柄。 */
export function readPendingMessageEdit(scope = null) {
  const records = readPendingRecords();
  if (!records.length) return null;
  if (!scope) return records[records.length - 1];
  const matches = records.filter(record => pendingScopeMatches(record.scope, scope));
  return matches.length ? matches[matches.length - 1] : null;
}

export function rememberPendingMessageEdit(record) {
  if (!record || typeof record.requestId !== 'string') return;
  const records = readPendingRecords().filter(existing =>
    existing.requestId !== record.requestId
    && !samePendingScope(existing.scope, record.scope));
  records.push(record);
  writePendingRecords(records);
}

export function clearPendingMessageEdit(requestId = null) {
  try {
    if (!requestId) { writePendingRecords([]); return; }
    writePendingRecords(readPendingRecords().filter(record => record.requestId !== requestId));
  } catch { /* storage unavailable */ }
}

/* 渲染器刷新 / 重连后，用持久化的 requestId 查一次权威状态。
 * - accepted / failed / recovery_required：事务已收口，清记录并让调用方刷新；
 * - acceptance_unknown / recovery_pending：保留记录，返回状态供调用方展示恢复入口；
 * - backendInstance 已经变化：后端内存事务随进程消失，清掉本地记录，不伪造结果。
 * 作用域不匹配（用户切到了另一个会话）时原样保留，等回到目标会话再处理。 */
export async function resumePendingMessageEdit({ scope = null, status, onSettled } = {}) {
  let record = readPendingMessageEdit(scope);
  if (!record && scope) {
    /* 同一会话但 backendInstance 已换代：后端内存事务随旧进程消失，清掉
     * 这条旧记录，不把新进程的“unknown”伪装成未确认。 */
    const stale = readPendingRecords().filter(candidate => samePendingScope(candidate.scope, scope)).at(-1);
    if (stale) { clearPendingMessageEdit(stale.requestId); return { record: stale, state: 'stale' }; }
    return null;
  }
  if (!record) return null;
  if (record.scope?.backendInstance && scope?.backendInstance
    && record.scope.backendInstance !== scope.backendInstance) {
    clearPendingMessageEdit(record.requestId);
    return { record, state: 'stale' };
  }
  if (!pendingScopeMatches(record.scope, scope)) return null;
  let result = null;
  try { result = await status?.(record.requestId); } catch { return { record, state: 'unknown' }; }
  if (!result) return { record, state: 'unknown' };
  if (result.state === 'accepted') {
    clearPendingMessageEdit(record.requestId);
    onSettled?.({ ...(result.result || {}), ok: true, accepted: true, duplicate: true }, record);
    return { record, state: 'accepted', result };
  }
  if (result.state === 'failed' || result.state === 'recovery_required' || result.state === 'stale_session') {
    clearPendingMessageEdit(record.requestId);
    onSettled?.({ ...(result.result || {}), ok: false }, record);
    return { record, state: result.state, result };
  }
  if (result.state === 'acceptance_unknown' || result.state === 'recovery_pending') {
    return { record, state: result.state, result };
  }
  if (result.ok === false && ['stale_runtime', 'stale_session', 'unavailable'].includes(result.code)) {
    clearPendingMessageEdit(record.requestId);
    return { record, state: 'stale', result };
  }
  return { record, state: 'unknown', result };
}

/* 传输层失败（断线、后端重启）不等于事务失败：后端可能已经接受 prompt。
 * 用 requestId 读一次权威状态；accepted 就按成功处理，failed 就按失败处理，
 * 未解决时返回带 `unresolved` 的结果，由调用方决定“未确认”的呈现，绝不盲目重试。 */
export async function resolveEditAcceptance(status, requestId, { attempts = 5, delayMs = 120 } = {}) {
  if (typeof status !== 'function' || !requestId) return null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let result = null;
    try { result = await status(requestId); } catch { /* transient */ }
    if (result?.state === 'accepted') return { ...(result.result || {}), ok: true, accepted: true, duplicate: true };
    if (result?.state === 'failed') return { ...(result.result || {}), ok: false };
    if (result?.state === 'acceptance_unknown' || result?.state === 'recovery_pending') {
      return { ...(result.result || {}), ok: false, code: 'acceptance_unknown', unresolved: true, state: result.state };
    }
    if (result?.state === 'recovery_required' || result?.state === 'stale_session') {
      return { ...(result.result || {}), ok: false, code: result.result?.code || result.state, unresolved: false };
    }
    if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return null;
}

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  const view = textarea.ownerDocument?.defaultView;
  const line = view ? parseFloat(view.getComputedStyle(textarea).lineHeight) : 0;
  const min = Number.isFinite(line) && line > 0 ? line * 3 : 0;
  const max = Number.isFinite(line) && line > 0 ? line * 12 : 0;
  const wanted = Math.max(textarea.scrollHeight || 0, min);
  const height = max > 0 ? Math.min(wanted, max) : wanted;
  if (height > 0) textarea.style.height = height + 'px';
  textarea.style.overflowY = max > 0 && (textarea.scrollHeight || 0) > max ? 'auto' : 'hidden';
}

function sameTarget(baseline, result) {
  if (!baseline || !result) return false;
  return baseline.sessionId === result.sessionId
    && baseline.entryId === result.entryId
    && (baseline.parentId ?? null) === (result.parentId ?? null)
    && (baseline.leafId ?? null) === (result.leafId ?? null)
    && baseline.userIndex === result.userIndex
    && baseline.text === result.text
    && Boolean(baseline.hasImages) === Boolean(result.hasImages)
    && (baseline.imageCount || 0) === (result.imageCount || 0)
    && Boolean(baseline.hasToolsAfter) === Boolean(result.hasToolsAfter);
}

function build({ text, kind, userIndex, hasImages: initialHasImages, imageStateKnown = true, textTruncated = false,
  mount, originals, preflight, resend, readStatus, recover, onAccepted, onRecovered, onClose, returnFocus, pendingScope = null }) {
  let hasImages = initialHasImages === true;
  const initialText = typeof text === 'string' ? text : '';
  const wrap = document.createElement('div');
  wrap.className = 'message-edit';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', kind === 'regenerate' ? '重新生成消息' : '编辑消息');
  const id = 'message-edit-' + (++editorSeq);
  wrap.dataset.editorId = id;

  const label = document.createElement('label');
  label.className = 'message-edit-label';
  label.htmlFor = id + '-input';
  label.textContent = kind === 'regenerate' ? '重新生成' : '编辑消息';
  const textarea = document.createElement('textarea');
  textarea.className = 'message-edit-input';
  textarea.id = id + '-input';
  textarea.value = text;
  textarea.rows = 3;
  textarea.setAttribute('aria-describedby', id + '-status ' + id + '-warning');

  const warning = document.createElement('div');
  warning.className = 'message-edit-warning';
  warning.id = id + '-warning';
  warning.hidden = true;
  warning.textContent = '重新发送会替换后续对话，之前已经执行的文件修改和命令操作不会自动撤销。';

  const status = document.createElement('div');
  status.className = 'message-edit-status';
  status.id = id + '-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const actions = document.createElement('div');
  actions.className = 'message-edit-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn tiny ghost message-edit-cancel';
  cancel.textContent = '取消';
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn tiny primary message-edit-submit';
  submit.textContent = kind === 'regenerate' ? '重新生成' : '重新发送';
  actions.append(cancel, submit);
  wrap.append(label, textarea, warning, status, actions);

  let closed = false;
  let busy = false;
  let composing = false;
  let baseline = null;
  let baselineSettled = false;
  let baselinePromise = null;
  let unresolved = false;
  let lastRequest = null;
  let recoverButton = null;
  let preflightState = 'pending'; // pending | ready | blocked | failed

  const setStatus = (textValue, state) => {
    status.textContent = textValue || '';
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  };
  const syncSubmit = () => {
    const blank = !textarea.value.trim() && !hasImages;
    submit.disabled = closed || busy || unresolved || preflightState === 'blocked' || preflightState === 'failed' || blank;
    cancel.disabled = closed || busy;
    textarea.readOnly = busy;
  };
  const setWarning = value => {
    warning.hidden = value !== true;
  };

  /* 会话已有未解决事务：接回持久化的 requestId。恢复入口属于整个会话，
   * 不要求用户点的正是记录所属的那条消息；只有文本回填要求 userIndex
   * 一致，避免把 A 的编辑文本塞进 B。 */
  const adoptPending = record => {
    lastRequest = { requestId: record.requestId, text: record.text, userIndex: record.userIndex };
    if (typeof record.text === 'string' && record.userIndex === userIndex) textarea.value = record.text;
    unresolved = true;
    preflightState = 'blocked';
    setStatus(errorText('edit_in_progress'), 'error');
    showRecover();
    syncSubmit();
  };

  const captureBaseline = result => {
    baselineSettled = true;
    /* 刷新后原 requestId 仍在 sessionStorage 里。后端说明锁还没释放时，
     * 把它接回编辑器，提供“重新同步会话状态”入口，而不是让用户面对
     * 一个无法解除的忙状态。Classic 与 Runtime 的 preflight 形状不同，
     * isEditInProgress 统一识别。 */
    const pending = isEditInProgress(result) ? readPendingMessageEdit(pendingScope) : null;
    if (pending && typeof recover === 'function' && pendingScopeMatches(pending.scope, pendingScope)) {
      adoptPending(pending);
      return false;
    }
    if (!result || result.ok !== true) {
      /* 首次预检失败就没有可信目标。允许用户继续输入，但提交前会要求先
       * 成功锁定目标；不会拿提交时的 userIndex 投影临时替换。 */
      preflightState = 'pending';
      setStatus(errorText(result?.code), 'error');
      syncSubmit();
      return false;
    }
    /* preflight 成功 = 当前目标会话没有未解决事务；只清理**同一作用域**
     * 上次刷新遗留的记录，不能把另一个会话仍在进行的事务记录抹掉。 */
    const leftover = readPendingMessageEdit(pendingScope);
    if (leftover && pendingScopeMatches(leftover.scope, { ...(pendingScope || {}), sessionId: result.sessionId })) {
      clearPendingMessageEdit(leftover.requestId);
    }
    /* 首次预检必须对应**被点击的那条消息**，而不是一个可能已经变化的
     * DOM 序号。文本/图片是点击时前端独立持有的证据。Runtime 的 block 可能
     * 被截断、也不携带图片投影，此时只核对“完整文本以已显示文本开头”。 */
    const textOk = textTruncated
      ? typeof result.text === 'string' && result.text.startsWith(initialText)
      : result.text === initialText;
    const imagesOk = !imageStateKnown || Boolean(result.hasImages) === initialHasImages;
    if (!textOk || !imagesOk) {
      preflightState = 'blocked';
      setStatus(errorText('stale_history'), 'error');
      syncSubmit();
      return false;
    }
    baseline = { ...result };
    if (result.hasImages === true) hasImages = true;
    setWarning(result.hasToolsAfter === true);
    if (result.canEdit === false) {
      preflightState = 'blocked';
      setStatus(errorText(result.reason) || '当前无法编辑这条消息。', 'error');
      syncSubmit();
      return false;
    }
    preflightState = 'ready';
    setStatus('', '');
    syncSubmit();
    return true;
  };

  /* 提交预检只能核对首次捕获的目标；任何身份/leaf/文本/附件变化都拒绝，
   * 不采用新结果里的 entryId/leafId。 */
  const verifyBaseline = result => {
    if (!result || result.ok !== true) {
      preflightState = 'blocked';
      setStatus(errorText(result?.code), 'error');
      syncSubmit();
      return false;
    }
    if (!sameTarget(baseline, result)) {
      preflightState = 'blocked';
      setStatus(errorText('stale_history'), 'error');
      syncSubmit();
      return false;
    }
    if (result.canEdit === false) {
      preflightState = 'blocked';
      setStatus(errorText(result.reason) || '当前无法编辑这条消息。', 'error');
      syncSubmit();
      return false;
    }
    return true;
  };

  const applyPreflight = result => baseline ? verifyBaseline(result) : captureBaseline(result);

  const close = ({ restore = true, focus = true } = {}) => {
    if (closed) return;
    closed = true;
    wrap.remove();
    for (const node of originals) node.hidden = false;
    if (active === controller) active = null;
    if (restore && focus) {
      try { returnFocus?.focus?.(); } catch { /* focus is best effort */ }
    }
    try { onClose?.(); } catch { /* observation only */ }
  };

  const cancelEdit = () => {
    if (busy || closed) return;
    /* 事务结果未知时不能把唯一的恢复入口（requestId）关掉；先要求重新同步。 */
    if (unresolved && typeof recover === 'function') {
      setStatus(errorText('acceptance_unknown'), 'error');
      return;
    }
    close({ restore: true });
  };

  const showRecover = () => {
    if (recoverButton || typeof recover !== 'function') return;
    recoverButton = document.createElement('button');
    recoverButton.type = 'button';
    recoverButton.className = 'btn tiny ghost message-edit-recover';
    recoverButton.textContent = '重新同步会话状态';
    recoverButton.addEventListener('click', async () => {
      if (!lastRequest || recoverButton.disabled) return;
      recoverButton.disabled = true;
      setStatus('正在重新同步…', 'pending');
      let result = null;
      try { result = await recover(lastRequest.requestId); } catch { result = null; }
      if (closed) return;
      if (result?.state === 'accepted') {
        const accepted = { ...(result.result || {}), ok: true, accepted: true, duplicate: true };
        unresolved = false;
        clearPendingMessageEdit(lastRequest.requestId);
        close({ restore: true });
        try {
          onRecovered?.(accepted, { text: lastRequest.text, userIndex: accepted.userIndex ?? lastRequest.userIndex, kind });
        } catch { /* rendering failure must not resurrect the editor */ }
        return;
      }
      recoverButton.disabled = false;
      if (result?.state === 'failed') {
        unresolved = false;
        preflightState = 'pending';
        clearPendingMessageEdit(lastRequest.requestId);
        syncSubmit();
        setStatus(errorText(result.result?.code || 'prompt_unconfirmed'), 'error');
        return;
      }
      if (result?.state === 'recovery_required' || result?.state === 'stale_session') {
        unresolved = false;
        preflightState = 'blocked';
        clearPendingMessageEdit(lastRequest.requestId);
        syncSubmit();
        setStatus(errorText(result.result?.code || result.state), 'error');
        return;
      }
      /* 后端明确没有这条 requestId（请求没到达，或状态已过普通 TTL）：
       * 没有可恢复的事务，也没有服务端锁。清掉本地句柄并解除提交禁用，
       * 明确提示刷新检查历史，而不是把编辑器永久锁死。 */
      if (result?.state === 'unknown') {
        unresolved = false;
        preflightState = 'pending';
        clearPendingMessageEdit(lastRequest.requestId);
        syncSubmit();
        setStatus(errorText('recovery_required'), 'error');
        return;
      }
      /* 后端已经换代/没有这条事务（stale_runtime 等）：锁不可能再存在，
       * 不能把用户永久困在“重新同步”里。清掉本地记录并允许重新开始。 */
      if (result && result.ok === false && ['stale_runtime', 'stale_session', 'unavailable'].includes(result.code)) {
        unresolved = false;
        preflightState = 'pending';
        clearPendingMessageEdit(lastRequest.requestId);
        syncSubmit();
        setStatus(errorText(result.code), 'error');
        return;
      }
      setStatus(errorText('recovery_pending'), 'error');
    });
    actions.insertBefore(recoverButton, submit);
  };

  const submitEdit = async () => {
    if (busy || closed || unresolved) return;
    const value = textarea.value;
    if (!value.trim() && !hasImages) {
      setStatus('消息不能为空。', 'error');
      textarea.focus();
      return;
    }
    busy = true;
    syncSubmit();
    setStatus('正在重新发送…', 'pending');
    const requestId = messageEditRequestId();
    let result;
    let sendAttempted = false;
    try {
      /* 首次预检可能还在飞；必须等它落定并锁定目标，不能拿提交时的投影
       * 临时生成一个新的目标。 */
      if (!baseline && baselinePromise) await baselinePromise;
      if (!baseline) {
        busy = false;
        preflightState = 'blocked';
        syncSubmit();
        setStatus(errorText('missing_target_identity'), 'error');
        return;
      }
      /* 提交前重新 preflight：只核对首次捕获的目标，不替换。用户输入永远
       * 以 textarea 为准，不被 preflight 返回的旧文本覆盖。 */
      const fresh = await preflight({ userIndex: baseline.userIndex, kind });
      if (!verifyBaseline(fresh)) {
        busy = false;
        syncSubmit();
        return;
      }
      lastRequest = { requestId, text: value, userIndex: baseline.userIndex };
      /* 在真正发出前落盘：渲染器可能在应答回来之前刷新/崩溃，requestId
       * 必须活过这次刷新，才能在后端锁未释放时重新查询并恢复。 */
      rememberPendingMessageEdit({
        requestId,
        text: value,
        userIndex: baseline.userIndex,
        kind,
        scope: { ...(pendingScope || {}), sessionId: baseline.sessionId },
        at: Date.now(),
      });
      sendAttempted = true;
      result = await resend({
        userIndex: baseline.userIndex,
        kind,
        text: value,
        expectedEntryId: baseline.entryId,
        expectedParentId: baseline.parentId ?? null,
        expectedLeafId: baseline.leafId,
        expectedSessionId: baseline.sessionId,
        requestId,
      });
    } catch {
      result = { ok: false, code: 'network', network: true };
    }
    if (closed) return;
    /* 传输失败不代表事务失败：先按 requestId 读权威状态。只有 resend 真的
     * 发出过才查询；preflight 阶段断网时服务端根本没有这次事务，不能把它
     * 当成 acceptance_unknown（否则 lastRequest 为空，恢复按钮也无法工作）。 */
    if (sendAttempted && result && result.ok !== true && (result.network === true || result.code === 'network')) {
      const resolved = await resolveEditAcceptance(readStatus, requestId);
      if (closed) return;
      result = resolved || { ok: false, code: 'acceptance_unknown', unresolved: true };
    }
    busy = false;
    if (!result || result.ok !== true) {
      syncSubmit();
      if (result?.unresolved || result?.code === 'acceptance_unknown' || result?.code === 'recovery_pending') {
        unresolved = true;
        preflightState = 'blocked';
        syncSubmit();
        setStatus(errorText('acceptance_unknown'), 'error');
        showRecover();
        return;
      }
      /* 提交时才撞上锁（另一个窗口或另一个预览刚拿到事务）：持久化记录
       * 可能属于同一会话。不要把用户困在纯错误提示里，接回那条记录的
       * 恢复入口；本次提交的 requestId 不会被当成成功。 */
      if (result?.code === 'edit_in_progress') {
        const pending = readPendingMessageEdit(pendingScope);
        if (pending && pending.requestId !== requestId && pendingScopeMatches(pending.scope, pendingScope)) {
          adoptPending(pending);
          return;
        }
      }
      /* 普通失败（含已确认恢复）代表事务已经收口，requestId 不再需要。 */
      clearPendingMessageEdit(requestId);
      setStatus(errorText(result?.code), 'error');
      /* 失败时文本原样保留，编辑器不关闭。 */
      return;
    }
    clearPendingMessageEdit(requestId);
    close({ restore: true });
    try {
      onAccepted?.(result, { text: value, userIndex: result.userIndex, kind });
    } catch { /* rendering failure must not resurrect the editor */ }
  };

  textarea.addEventListener('input', () => {
    autoGrow(textarea);
    if (status.dataset.state === 'error' && status.textContent === '消息不能为空。') setStatus('', '');
    syncSubmit();
  });
  textarea.addEventListener('compositionstart', () => { composing = true; });
  textarea.addEventListener('compositionend', () => {
    composing = false;
    autoGrow(textarea);
    syncSubmit();
  });
  textarea.addEventListener('keydown', event => {
    if (event.isComposing || composing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
    }
  });
  cancel.addEventListener('click', cancelEdit);
  submit.addEventListener('click', submitEdit);

  const controller = {
    element: wrap,
    textarea,
    close,
    isBusy: () => busy,
    isClosed: () => closed,
    applyPreflight,
    setStatus,
    setWarning,
    submit: submitEdit,
    cancel: cancelEdit,
    expected: () => baseline,
  };

  for (const node of originals) node.hidden = true;
  mount.appendChild(wrap);
  autoGrow(textarea);
  syncSubmit();
  /* 打开时先检查一次：拿到 entryId / leafId / 是否含工具操作，同时把
   * “正在生成 / 不支持导航”这类不可编辑原因尽早告诉用户。这个结果是本次
   * 事务唯一的目标身份来源。 */
  baselinePromise = Promise.resolve()
    .then(() => preflight({ userIndex, kind }))
    .then(result => { if (!closed) captureBaseline(result); })
    .catch(() => { if (!closed) captureBaseline({ ok: false, code: 'pi_request_failed' }); });
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn => setTimeout(fn, 0));
  raf(() => { if (!closed) textarea.focus(); });
  return controller;
}

export function openMessageEditor(options) {
  if (active?.isBusy()) return null;
  if (active) active.close({ restore: true });
  if (!options?.mount || !Array.isArray(options.originals) || typeof options.preflight !== 'function' || typeof options.resend !== 'function') return null;
  active = build(options);
  return active;
}

export function closeMessageEditor(options) {
  if (active) active.close(options);
}

export function messageEditorBusy() {
  return active?.isBusy() === true;
}

export function activeMessageEditor() {
  return active;
}
