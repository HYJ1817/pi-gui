/* Runtime 同步状态（P5 接通 P3-C）。
 *
 * 只做两件事：读取服务端已经给出的逐目标事实，以及按用户点击发起一次
 * **只读**核验（POST /sync → 202 → GET /operations/:id）。这里不重启
 * Classic/Runtime、不结束会话、不改模型或思考等级，也不自动轮询重试。
 * 迟到的操作结果按代次丢弃，避免切换页面/工作区后污染新状态。 */

import { newRequestId } from './state.js';

export const SYNC_STATE_LABEL = Object.freeze({
  idle: '无需同步',
  pending: '待同步',
  syncing: '核验中',
  applied: '已生效',
  error: '同步失败',
  unsupported: '同步能力未启用',
});

export const SYNC_REASON_LABEL = Object.freeze({
  runtime_sync_pending: '等待 Runtime 在下次生命周期加载新配置',
  no_live_runtime: '没有活动进程可核验',
  credential_unconfirmed: '凭据写入结果尚未确认',
  runtime_readback_failed: '无法从 Runtime 回读配置',
  sync_evidence_unavailable: '缺少可核验的目录/版本证据',
});

export function syncSupported(snapshot) {
  return snapshot?.capabilities?.syncMode === 'deferred';
}

export function syncLabel(sync) {
  return SYNC_STATE_LABEL[sync?.state] || '未知';
}

export function syncReasonLabel(reason) {
  return reason ? SYNC_REASON_LABEL[reason] || '原因未知' : '';
}

export function syncTargetLabel(target) {
  const kind = target?.kind === 'classic' ? 'Classic' : target?.kind === 'runtime' ? 'Runtime' : '目标';
  return `${kind} ${target?.id || ''}`.trim();
}

export function createSyncController({
  api = {},
  pollIntervalMs = 700,
  operationTimeoutMs = 40_000,
  now = () => Date.now(),
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = timer => clearTimeout(timer),
} = {}) {
  let state = { state: 'idle', sync: null, error: '', reason: '', operationId: null, checkedAt: null, saving: false };
  const listeners = new Set();
  let generation = 0;
  let timer = null;
  let wake = null;
  let disposed = false;

  const notify = patch => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) {
      try { listener(state); } catch { /* 视图问题不影响控制器 */ }
    }
    return state;
  };

  function stopTimer() {
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
    const resume = wake;
    wake = null;
    resume?.();
  }

  function delay(ms) {
    return new Promise(resolve => {
      wake = resolve;
      timer = setTimeoutFn(() => {
        timer = null;
        wake = null;
        resolve();
      }, ms);
    });
  }

  async function poll(id, mine) {
    const deadline = now() + operationTimeoutMs;
    while (!disposed && generation === mine) {
      if (now() >= deadline) {
        if (generation === mine) notify({ state: 'error', error: 'timeout', reason: '同步核验超时，可以稍后重试', operationId: null });
        return state;
      }
      await delay(pollIntervalMs);
      if (disposed || generation !== mine) return state;
      let operation = null;
      try { operation = await api.fetchProviderOperation(id); } catch { operation = { ok: false, network: true }; }
      if (disposed || generation !== mine) return state;
      if (!operation || operation.ok !== true) {
        if (operation?.network) continue;
        notify({ state: 'error', error: operation?.code || 'unavailable',
          reason: operation?.message || '无法读取同步操作状态', operationId: null });
        return state;
      }
      if (operation.state === 'pending' || operation.state === 'running') continue;
      if (operation.state === 'success') {
        const sync = operation.result?.sync || null;
        // 操作成功只说明「核验完成」；是否真正生效仍以 sync.state 为准。
        notify({ state: sync?.state === 'error' ? 'error' : 'success', sync, error: '',
          reason: sync?.state === 'pending' ? '核验完成，仍有目标待生效' : '', operationId: null, checkedAt: now() });
        return state;
      }
      if (operation.state === 'cancelled') {
        notify({ state: 'syncing', error: 'cancelled', reason: '已取消本次核验', operationId: null });
        return state;
      }
      notify({ state: 'error', error: operation.error?.code || 'failed',
        reason: operation.error?.message || '同步核验失败', operationId: null });
      return state;
    }
    return state;
  }

  async function verify({ revision, requestId = newRequestId('sync') } = {}) {
    if (disposed) return state;
    if (state.saving) return state; // 单飞：重复点击不产生第二次写入
    if (typeof revision !== 'string' && typeof revision !== 'number') {
      return notify({ state: 'error', error: 'invalid_request', reason: '缺少当前配置版本，无法核验' });
    }
    const mine = ++generation;
    state.saving = true;
    notify({ state: 'syncing', sync: state.sync, error: '', reason: '正在核验 Runtime 是否已加载新配置…', operationId: null });
    let result;
    try {
      result = await api.syncProviderConfiguration({ requestId, revision });
    } catch {
      result = { ok: false, network: true, code: 'network_failed' };
    }
    if (disposed || generation !== mine) { state.saving = false; return state; }
    if (!result || result.ok !== true) {
      state.saving = false;
      notify({ state: 'error', error: result?.code || (result?.network ? 'network_failed' : 'failed'),
        reason: result?.network ? '网络请求失败，配置已保存；可以稍后重试只读核验' : (result?.message || '同步核验失败'), sync: result?.sync || state.sync });
      return state;
    }
    notify({ state: 'syncing', sync: result.sync || state.sync, error: '', reason: '', operationId: result.operationId || null });
    if (!result.operationId) { state.saving = false; return notify({}); }
    try { return await poll(result.operationId, mine); }
    finally { if (generation === mine) { state.saving = false; notify({}); } }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    verify,
    /** 用快照里的同步事实刷新展示；不会发起任何请求。 */
    applySnapshot(sync) {
      if (disposed) return state;
      generation += 1;
      stopTimer();
      return notify({ state: 'idle', sync: sync || null, error: '', reason: '', operationId: null, saving: false });
    },
    cancel() {
      generation += 1;
      stopTimer();
      if (disposed) return state;
      return notify({ state: 'syncing', error: 'cancelled', reason: '已取消本次核验', operationId: null, saving: false });
    },
    dispose() {
      disposed = true;
      generation += 1;
      stopTimer();
      listeners.clear();
    },
  };
}
