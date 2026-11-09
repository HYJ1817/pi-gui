/* 主页面侧的桌面安全凭据入口（P5）。
 *
 * 边界：主页面永远不接收密钥。这里只调用预加载暴露的 open/cancel/status/
 * closeDraft，并订阅主进程发布的状态（open/staged/cancelled/expired/
 * unavailable）。真实输入、校验、暂存都发生在受限输入窗与私有桥里。
 *
 * 窗口生命周期：
 *   - open() 成功返回后等待终态；staged 表示「已暂存，保存时写入」。
 *   - 取消/关闭/过期/桥不可用都返回明确的本地原因，不伪装成成功。
 *   - 管理弹窗关闭或换目标时调用 closeDraft，撤销该草稿的暂存与授权。 */

export const CREDENTIAL_REASON = Object.freeze({
  web: '网页版没有 Electron 安全凭据窗口；API Key 只能在桌面版的受限输入窗中录入。',
  unqualified: '当前桌面环境未通过安全资格检查（例如使用了 --no-sandbox 或远程调试端口），安全凭据窗口已禁用。',
  key_input_disabled: '后端未开启密钥输入功能（PI_GUI_PROVIDER_KEY_INPUT=1），安全凭据窗口已禁用。',
  bridge_unavailable: '后端私有凭据桥不可用；请确认桌面应用已连接后端，然后重试。',
  busy: '已有凭据窗口或操作正在进行，请稍后重试。',
  stale: '凭据输入会话已失效，请重新打开。',
  expired: '凭据输入已过期，请重新打开。',
  load_failed: '安全凭据窗口加载失败，请重试。',
  cancelled: '已取消凭据输入。',
  credential_conflict: '草稿或凭据状态已变化，请重新打开凭据窗口。',
  config_busy: '供应商配置正在被其他操作占用，请稍后重试。',
  oauth_conflict: '目标槽位已有 OAuth 登录，需要再次确认后才能替换。',
  unsupported: '当前环境不支持安全凭据输入。',
});

const TERMINAL = new Set(['staged', 'cancelled', 'closed', 'expired', 'unavailable', 'load_failed']);

export function desktopCredentialBridge(scope = globalThis) {
  const bridge = scope?.piGuiDesktop?.providerCredentials;
  return bridge && typeof bridge.open === 'function' ? bridge : null;
}

export function credentialOpenReason(result) {
  if (!result) return CREDENTIAL_REASON.bridge_unavailable;
  if (result.reason && CREDENTIAL_REASON[result.reason]) return CREDENTIAL_REASON[result.reason];
  if (result.reason === 'desktop_unqualified') return CREDENTIAL_REASON.unqualified;
  if (result.reason === 'key_input_disabled') return CREDENTIAL_REASON.key_input_disabled;
  if (result.reason === 'bridge_unavailable') return CREDENTIAL_REASON.bridge_unavailable;
  if (result.code === 'busy') return CREDENTIAL_REASON.busy;
  if (result.code === 'unsupported') return CREDENTIAL_REASON.unsupported;
  if (result.code === 'expired') return CREDENTIAL_REASON.expired;
  const mapped = CREDENTIAL_REASON[result.code];
  return mapped || result.message || result.reason || '无法打开安全凭据窗口。';
}

export function createCredentialController({
  bridge = desktopCredentialBridge(),
  scope = globalThis,
  onEvent = null,
  waitTimeoutMs = 180_000,
  now = () => Date.now(),
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = timer => clearTimeout(timer),
} = {}) {
  let state = {
    bridge: Boolean(bridge),
    available: Boolean(bridge),
    phase: 'idle',
    action: null,
    reason: '',
    lastError: '',
    expiresAt: null,
    nativePersistence: false,
  };
  const listeners = new Set();
  let waiter = null;
  let waitTimer = null;
  let unsubscribe = null;
  let lastTerminal = null;

  const notify = patch => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) {
      try { listener(state); } catch { /* 视图问题不影响控制器 */ }
    }
    return state;
  };

  function settle(outcome) {
    if (!waiter) return;
    const resolve = waiter;
    waiter = null;
    if (waitTimer !== null) clearTimeoutFn(waitTimer);
    waitTimer = null;
    resolve(outcome);
  }

  if (bridge && typeof bridge.onState === 'function') {
    unsubscribe = bridge.onState(value => {
      if (!value || typeof value !== 'object') return;
      const next = typeof value.state === 'string' ? value.state : '';
      if (!next) return;
      const patch = { phase: next, reason: "", lastError: "" };
      if (next === 'open') patch.action = value.action || state.action;
      if (next === 'unavailable') patch.lastError = CREDENTIAL_REASON.bridge_unavailable;
      notify(patch);
      onEvent?.(value);
      if (TERMINAL.has(next)) {
        lastTerminal = next;
        settle(next);
      }
    });
  }

  async function probe() {
    if (!bridge) {
      return notify({ bridge: false, available: false, phase: 'unsupported', reason: CREDENTIAL_REASON.web });
    }
    if (typeof bridge.status !== 'function') return notify({ available: true });
    try {
      const status = await bridge.status();
      if (!status || status.ok !== true) {
        return notify({ available: false, phase: 'unsupported', reason: CREDENTIAL_REASON.bridge_unavailable });
      }
      return notify({ available: true, nativePersistence: status.nativeCredentialPersistence === true,
        ...(status.hasFlow && status.action ? { phase: 'open', action: status.action, expiresAt: status.expiresAt ?? null } : {}) });
    } catch {
      return notify({ available: false, phase: 'unsupported', reason: CREDENTIAL_REASON.bridge_unavailable });
    }
  }

  async function open({ draftId, draftRevision, action = 'set' } = {}) {
    if (!bridge) {
      return { ok: false, code: 'unsupported', reason: CREDENTIAL_REASON.web };
    }
    if (waiter) return { ok: false, code: 'busy', reason: CREDENTIAL_REASON.busy };
    if (!draftId || !Number.isSafeInteger(draftRevision) || draftRevision < 1) {
      return { ok: false, code: 'invalid_request', reason: '草稿尚未保存，无法打开凭据窗口' };
    }
    lastTerminal = null;
    notify({ phase: 'opening', action, reason: '', lastError: '', expiresAt: null });
    let opened;
    try { opened = await bridge.open({ draftId, draftRevision, action }); }
    catch { opened = { ok: false, code: 'unavailable' }; }
    if (!opened || opened.ok !== true) {
      const reason = credentialOpenReason(opened);
      notify({ phase: opened?.cancelled ? 'cancelled' : 'error', lastError: opened?.code || 'unavailable', reason });
      return { ok: false, code: opened?.code || 'unavailable', reason, cancelled: opened?.cancelled === true };
    }
    notify({ phase: 'open', action: opened.state?.action || action,
      expiresAt: Number.isFinite(opened.state?.expiresAt) ? opened.state.expiresAt : null });
    // 等受限窗进入终态。事件可能早于 open() 解决到达，先记下终态再兑现。
    const outcome = await new Promise(resolve => {
      waiter = resolve;
      waitTimer = setTimeoutFn(() => settle('expired'), waitTimeoutMs);
      if (lastTerminal) settle(lastTerminal);
    });
    if (outcome === 'staged') {
      notify({ phase: 'staged', reason: '', lastError: '' });
      return { ok: true, staged: true, action };
    }
    const cancelled = outcome === 'cancelled' || outcome === 'closed';
    const reason = outcome === 'expired' ? CREDENTIAL_REASON.expired
      : outcome === 'unavailable' ? CREDENTIAL_REASON.bridge_unavailable
        : outcome === 'load_failed' ? CREDENTIAL_REASON.load_failed
          : CREDENTIAL_REASON.cancelled;
    notify({ phase: cancelled ? 'cancelled' : outcome, lastError: outcome, reason });
    return { ok: false, code: outcome, reason, cancelled };
  }

  async function closeDraft(draftId) {
    if (!bridge || typeof bridge.closeDraft !== 'function' || !draftId) return { ok: false, code: 'unsupported' };
    try { return await bridge.closeDraft({ draftId }); }
    catch { return { ok: false, code: 'unavailable' }; }
  }

  function cancel() {
    try { bridge?.cancel?.(); } catch { /* 主进程会自行清理 */ }
    settle('cancelled');
    return notify({ phase: 'cancelled', reason: CREDENTIAL_REASON.cancelled });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    probe,
    open,
    closeDraft,
    cancel,
    dispose() {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (waitTimer !== null) clearTimeoutFn(waitTimer);
      waitTimer = null;
      waiter = null;
      listeners.clear();
    },
  };
}
