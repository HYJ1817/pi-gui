/* 模型发现/连接测试的控制器。
 *
 * P4 阶段后端仍返回 422 unsupported，所以生产路径上 `supported` 为 false，
 * 这个控制器只发出「待接通」状态，**不会**请求 /discover。
 *
 * 形状按 P3 合同写死：600ms 防抖、requestSeq、dialogGeneration、
 * draftRevision 三重迟到结果校验，失败时保留上一次缓存。等 P3 接通时
 * 只换注入的 API，不改视图。 */

import { newRequestId } from './state.js';

export const DISCOVERY_STATUS = Object.freeze({
  UNAPPROVED: 'unapproved',
  AUTHORIZED_IDLE: 'authorized-idle',
  DEBOUNCING: 'debouncing',
  REFRESHING: 'refreshing',
  READY: 'ready',
  EMPTY: 'empty',
  ERROR_STALE: 'error-stale',
  UNSUPPORTED: 'unsupported',
});

export const DISCOVERY_REASON = Object.freeze({
  discovery_transport_pending: '自动发现尚未接通（P3）',
  network_not_approved: '尚未授权本次网络访问',
  draft_changed: '草稿已变化，需要重新授权',
  unsupported: '自动发现尚未接通（P3）',
  network: '网络请求失败，保留上次结果',
  stale: '结果已过期，已丢弃',
});

export function discoverySupported(snapshot) {
  return Array.isArray(snapshot?.capabilities?.discoveryModes) && snapshot.capabilities.discoveryModes.length > 0;
}

export function connectionTestSupported(snapshot) {
  // 合同没有独立的 test 能力位；只有发现传输接通时才同步开放测试。
  return discoverySupported(snapshot);
}

export function discoveryUnavailableReason(snapshot) {
  const reason = snapshot?.capabilities?.reasons?.discoveryModes;
  return DISCOVERY_REASON[reason] || DISCOVERY_REASON.discovery_transport_pending;
}

function initialStatus(supported) {
  return supported ? DISCOVERY_STATUS.UNAPPROVED : DISCOVERY_STATUS.UNSUPPORTED;
}

export function createDiscoveryController({
  api = {},
  supported = false,
  debounceMs = 600,
  now = () => Date.now(),
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = timer => clearTimeout(timer),
} = {}) {
  let state = {
    status: initialStatus(supported),
    reason: supported ? '' : DISCOVERY_REASON.unsupported,
    models: [],
    source: 'none',
    lastError: '',
    requestSeq: 0,
    consentId: null,
    dialogGeneration: 0,
    draftId: null,
    draftRevision: null,
    connectionRevision: null,
    updatedAt: null,
  };
  const listeners = new Set();
  let timer = null;
  let disposed = false;
  let activeRequest = 0;

  const notify = (patch) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) {
      try { listener(state); } catch { /* 视图自爆不拖垮控制器 */ }
    }
    return state;
  };

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  };

  const stale = (snapshot) => disposed
    || snapshot.dialogGeneration !== state.dialogGeneration
    || snapshot.draftId !== state.draftId
    || snapshot.draftRevision !== state.draftRevision
    || snapshot.seq !== state.requestSeq
    || snapshot.connectionRevision !== state.connectionRevision;

  async function run(snapshot, force) {
    clearTimer();
    if (disposed || !supported) return state;
    if (!state.consentId) return notify({ status: DISCOVERY_STATUS.UNAPPROVED, reason: DISCOVERY_REASON.network_not_approved });
    if (!state.draftId || !Number.isSafeInteger(state.draftRevision) || state.draftRevision <= 0) {
      return notify({ status: DISCOVERY_STATUS.UNAPPROVED, reason: '请先保存草稿后再发现模型' });
    }
    notify({ status: DISCOVERY_STATUS.REFRESHING, reason: '', requestSeq: snapshot.seq });
    let result;
    try {
      result = await api.discoverProviderModels({
        requestId: newRequestId('discover'),
        draftId: state.draftId,
        draftRevision: state.draftRevision,
        consentId: state.consentId,
        dialogGeneration: state.dialogGeneration,
        requestSeq: snapshot.seq,
        force,
      });
    } catch {
      result = { ok: false, code: 'unavailable' };
    }
    if (stale(snapshot)) return state;
    if (!result || result.ok !== true) {
      if (result?.code === 'unsupported') {
        notify({ status: DISCOVERY_STATUS.UNSUPPORTED, reason: DISCOVERY_REASON.unsupported, lastError: '' });
      } else {
        notify({
          status: DISCOVERY_STATUS.ERROR_STALE,
          reason: result?.network ? '网络请求失败，保留上次结果' : (result?.message || '拉取模型失败，保留上次结果'),
          lastError: result?.code || 'error',
          updatedAt: now(),
        });
      }
      return state;
    }
    const models = Array.isArray(result.models) ? result.models : Array.isArray(result.candidates) ? result.candidates : [];
    // 只替换候选集合；用户已选/顺序在草稿里，视图不会因为这里的状态更新而改动它。
    return notify({
      status: models.length ? DISCOVERY_STATUS.READY : DISCOVERY_STATUS.EMPTY,
      reason: models.length ? '' : '没有发现模型，请手动添加',
      models,
      source: typeof result.source === 'string' ? result.source : 'remote',
      lastError: '',
      updatedAt: now(),
    });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    configure({ supported: nextSupported = supported, draftId = null, draftRevision = null, dialogGeneration = 0, connectionRevision = null, models = state.models, source = state.source } = {}) {
      const changed = nextSupported !== supported
        || draftId !== state.draftId
        || draftRevision !== state.draftRevision
        || dialogGeneration !== state.dialogGeneration
        || connectionRevision !== state.connectionRevision;
      supported = nextSupported;
      if (!changed) return state;
      clearTimer();
      activeRequest += 1;
      return notify({
        status: initialStatus(supported),
        reason: supported ? '' : DISCOVERY_REASON.unsupported,
        models: Array.isArray(models) ? models : [],
        source: source || 'none',
        requestSeq: activeRequest,
        consentId: null,
        dialogGeneration,
        draftId,
        draftRevision,
        connectionRevision,
        lastError: '',
      });
    },
    async authorize({ rememberTarget = false } = {}) {
      clearTimer();
      if (!supported) return notify({ status: DISCOVERY_STATUS.UNSUPPORTED, reason: DISCOVERY_REASON.unsupported });
      if (!state.draftId || !Number.isSafeInteger(state.draftRevision) || state.draftRevision <= 0) {
        return notify({ status: DISCOVERY_STATUS.UNAPPROVED, reason: '请先保存草稿后再授权发现' });
      }
      let result;
      try {
        result = await api.authorizeProviderDiscovery({
          requestId: newRequestId('authorize'),
          draftId: state.draftId,
          draftRevision: state.draftRevision,
          confirm: true,
          rememberTarget: Boolean(rememberTarget),
        });
      } catch {
        result = { ok: false, code: 'unavailable' };
      }
      if (disposed) return state;
      if (!result || result.ok !== true) {
        if (result?.code === 'unsupported') {
          return notify({ status: DISCOVERY_STATUS.UNSUPPORTED, reason: DISCOVERY_REASON.unsupported });
        }
        return notify({ status: DISCOVERY_STATUS.UNAPPROVED, reason: result?.message || '授权失败，请重试', lastError: result?.code || 'authorize_failed' });
      }
      notify({ consentId: result.consentId || result.consent?.consentId || null, status: DISCOVERY_STATUS.AUTHORIZED_IDLE, reason: '' });
      if (state.consentId) await this.refresh({ force: true, immediate: true });
      return state;
    },
    async revoke() {
      clearTimer();
      const consentId = state.consentId;
      state.consentId = null;
      if (consentId && supported && typeof api.revokeProviderDiscovery === 'function') {
        try {
          await api.revokeProviderDiscovery({ requestId: newRequestId('revoke'), consentId });
        } catch { /* 撤销失败也应回到未授权，避免界面假装仍被授权 */ }
      }
      return notify({ status: initialStatus(supported), reason: supported ? DISCOVERY_REASON.network_not_approved : DISCOVERY_REASON.unsupported });
    },
    refresh({ force = false, immediate = false } = {}) {
      if (disposed) return Promise.resolve(state);
      if (!supported) return Promise.resolve(notify({ status: DISCOVERY_STATUS.UNSUPPORTED, reason: DISCOVERY_REASON.unsupported }));
      if (state.draftId && Number.isSafeInteger(state.draftRevision) && state.draftRevision > 0 && !state.consentId) {
        return Promise.resolve(notify({ status: DISCOVERY_STATUS.UNAPPROVED, reason: DISCOVERY_REASON.network_not_approved }));
      }
      clearTimer();
      const seq = ++activeRequest;
      const snapshot = {
        seq,
        dialogGeneration: state.dialogGeneration,
        draftId: state.draftId,
        draftRevision: state.draftRevision,
        connectionRevision: state.connectionRevision,
      };
      if (immediate) return run(snapshot, force);
      notify({ status: DISCOVERY_STATUS.DEBOUNCING, reason: '', requestSeq: seq });
      return new Promise(resolve => {
        timer = setTimeoutFn(() => {
          timer = null;
          run(snapshot, force).then(resolve, () => resolve(state));
        }, debounceMs);
      });
    },
    /** 仅用于测试/关闭前的显式冲刷，避免等待 600ms。 */
    flush() {
      if (timer === null) return Promise.resolve(state);
      clearTimer();
      const seq = ++activeRequest;
      const snapshot = {
        seq,
        dialogGeneration: state.dialogGeneration,
        draftId: state.draftId,
        draftRevision: state.draftRevision,
        connectionRevision: state.connectionRevision,
      };
      return run(snapshot, false);
    },
    cancel() {
      clearTimer();
      activeRequest += 1;
      if (disposed) return state;
      return notify({ status: state.consentId ? DISCOVERY_STATUS.AUTHORIZED_IDLE : initialStatus(supported), reason: '' });
    },
    dispose() {
      disposed = true;
      clearTimer();
      activeRequest += 1;
      listeners.clear();
    },
  };
}
