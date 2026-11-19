/* 历史用户消息的就地编辑器。
 *
 * 只负责 DOM、键盘、IME 与一次提交的忙/错状态；历史定位、事务、身份校验
 * 全部由调用方注入的 `preflight` / `resend` 完成。这样 Classic 与 Runtime
 * 共用同一套编辑器，而两边各自保留自己的 owner / conversationId 语义。
 *
 * 关键约束：
 *   - 原消息位置就地展开，不跳到底部输入区，也不弹页面级对话框；
 *   - Escape / 取消恢复原消息；组合输入期间不响应 Escape；
 *   - 空白消息不提交；提交中按钮禁用，双击不会发第二次；
 *   - 失败保留用户已经输入的全部文本，只有成功才关闭；
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
  pi_timeout: 'Pi 没有及时应答，未发送。',
  pi_request_failed: 'Pi 没有接受这次操作，未发送。',
  acceptance_unknown: '提交结果未确认，请刷新会话检查后再操作。',
};

function errorText(code) {
  return ERROR_TEXT[code] || '重新发送失败，请稍后重试。';
}

export const messageEditErrorText = errorText;

export function messageEditRequestId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* fall through */ }
  return 'edit-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

/* 传输层失败（断线、后端重启）不等于事务失败：后端可能已经接受 prompt。
 * 用 requestId 读一次权威状态；accepted 就按成功处理，failed 就按失败处理，
 * 仍然 unknown 时返回 null，由调用方决定“未确认”的呈现，绝不盲目重试。 */
export async function resolveEditAcceptance(status, requestId, { attempts = 5, delayMs = 120 } = {}) {
  if (typeof status !== 'function' || !requestId) return null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let result = null;
    try { result = await status(requestId); } catch { /* transient */ }
    if (result?.state === 'accepted') return { ...(result.result || {}), ok: true, accepted: true, duplicate: true };
    if (result?.state === 'failed') return { ...(result.result || {}), ok: false };
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

function build({ text, kind, userIndex, hasImages: initialHasImages, mount, originals, preflight, resend, readStatus, onAccepted, onClose, returnFocus }) {
  let hasImages = initialHasImages === true;
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
  let expected = null;
  let preflightState = 'pending'; // pending | ready | blocked | failed
  let hasToolsAfter = false;

  const setStatus = (textValue, state) => {
    status.textContent = textValue || '';
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  };
  const syncSubmit = () => {
    const blank = !textarea.value.trim() && !hasImages;
    submit.disabled = closed || busy || preflightState === 'blocked' || preflightState === 'failed' || blank;
    cancel.disabled = closed || busy;
    textarea.readOnly = busy;
  };
  const setWarning = value => {
    hasToolsAfter = value === true;
    warning.hidden = !hasToolsAfter;
  };

  const applyPreflight = result => {
    if (!result || result.ok !== true) {
      /* 传输/上游暂时失败不锁死编辑器：用户改完还能再点一次，提交前会重新
       * preflight。真正“不能编辑”的原因走下面的 blocked 分支。 */
      preflightState = 'pending';
      setStatus(errorText(result?.code), 'error');
      syncSubmit();
      return false;
    }
    expected = result;
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
    close({ restore: true });
  };

  const submitEdit = async () => {
    if (busy || closed) return;
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
    try {
      /* 提交前重新 preflight：点击编辑之后历史可能已经变化。用户输入永远
       * 以 textarea 为准，不被 preflight 返回的旧文本覆盖。 */
      const fresh = await preflight({ userIndex, kind });
      if (!applyPreflight(fresh)) {
        busy = false;
        syncSubmit();
        return;
      }
      result = await resend({
        userIndex: fresh.userIndex,
        kind,
        text: value,
        expectedEntryId: fresh.entryId,
        expectedLeafId: fresh.leafId,
        requestId,
      });
    } catch {
      result = { ok: false, code: 'network', network: true };
    }
    if (closed) return;
    /* 传输失败不代表事务失败：先按 requestId 读权威状态。 */
    if (result && result.ok !== true && (result.network === true || result.code === 'network')) {
      const resolved = await resolveEditAcceptance(readStatus, requestId);
      if (closed) return;
      if (!resolved) {
        busy = false;
        preflightState = 'blocked';
        syncSubmit();
        setStatus('提交结果未确认，请刷新会话检查后再操作。', 'error');
        return;
      }
      result = resolved;
    }
    busy = false;
    if (!result || result.ok !== true) {
      syncSubmit();
      setStatus(errorText(result?.code), 'error');
      /* 失败时文本原样保留，编辑器不关闭。 */
      return;
    }
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
    expected: () => expected,
  };

  for (const node of originals) node.hidden = true;
  mount.appendChild(wrap);
  autoGrow(textarea);
  syncSubmit();
  /* 打开时先检查一次：拿到 entryId / leafId / 是否含工具操作，同时把
   * “正在生成 / 不支持导航”这类不可编辑原因尽早告诉用户。 */
  Promise.resolve()
    .then(() => preflight({ userIndex, kind }))
    .then(result => { if (!closed) applyPreflight(result); })
    .catch(() => { if (!closed) applyPreflight({ ok: false, code: 'pi_request_failed' }); });
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
