/* 模型发现与连接测试的控制器（P5 接通 P3-B）。
 *
 * 真实协议：POST /discover 或 /test 返回 HTTP 202 {operationId}，结果从
 * GET /operations/:id 轮询；取消走 POST /operations/:id/cancel。授权
 * （consent）由服务端持有，本控制器只保存不透明句柄，并把它绑定到
 * 草稿/连接/请求代次——迟到的应答不能覆盖当前列表，也不能改变用户选择。
 *
 * 关键纪律：
 *   - 600ms 防抖后发请求；授权后自动发现同样经过防抖。
 *   - 每次操作都带 dialogGeneration/requestSeq；轮询结果还要核对连接代次
 *     与授权句柄，任何一个变化都丢弃。
 *   - 发现成功只把候选交给 onModels（只增不减）；失败保留草稿里已有的
 *     已配置/手动模型，旧缓存标注 stale。
 *   - 测试与发现共享授权与取消语义，但测试结果只描述合同可证明的事实：
 *     credentialAccepted 始终是未知，inferenceVerified 始终为 false。 */

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
  discovery_transport_pending: '当前后端未提供自动发现能力',
  network_not_approved: '尚未授权本次网络访问',
  draft_changed: '草稿已变化，需要重新授权',
  unsupported: '当前后端未提供自动发现能力',
  network: '网络请求失败，保留上次结果',
  stale: '结果已过期，已丢弃',
  cancelled: '已取消本次发现',
  cancel_requested: '已请求取消本次发现；等待后端确认停止',
  cancel_unconfirmed: '取消已请求，但后端未确认停止；新操作可能仍被占用',
  authorize_required: '请先保存草稿并授权目标',
});

const FAILURE_REASON = Object.freeze({
  invalid_target: '授权已失效，请重新授权目标',
  config_conflict: '请求已被更新的操作取代，请重试',
  config_busy: '已有发现/测试操作正在进行，请稍后重试',
  policy_rejected: '目标不符合已授权的网络策略',
  private_address: '目标解析到不允许访问的地址',
  loopback_requires_consent: '回环目标需要单独授权，且不允许携带凭据',
  redirect_rejected: '供应商返回了重定向，已停止发现',
  too_large: '模型目录响应超过大小限制',
  not_json: '供应商返回的模型目录格式不受支持',
  http_401: '供应商拒绝了认证请求（401）',
  http_403: '供应商拒绝了目录访问权限（403）',
  http_404: '授权目标没有模型目录（404）',
  http_429: '供应商限制了目录查询频率（429），请稍后重试',
  timeout: '操作超时，可以重试',
  dns_failed: '目标 DNS 解析失败',
  network_failed: '网络请求失败',
  unsupported: '当前认证来源不支持自动发现（授权/目标限制）',
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

export function discoveryModes(snapshot) {
  return Array.isArray(snapshot?.capabilities?.discoveryModes) ? [...snapshot.capabilities.discoveryModes] : [];
}

/** 当前认证来源是否在真实的发现模式里。三值：true / false / 未知（null）。 */
export function discoverySupportsAuth(snapshot, authMode) {
  const modes = snapshot?.capabilities?.discoveryModes;
  if (!Array.isArray(modes) || modes.length === 0) return false;
  const mode = authMode === 'environment' ? 'environment' : authMode === 'pi-credential' ? 'pi-credential' : authMode === 'none' ? 'none' : null;
  return mode ? modes.includes(mode) : null;
}

export function discoveryFailureReason(error) {
  if (!error || typeof error !== 'object') return '操作失败，请重试';
  return FAILURE_REASON[error.code] || (typeof error.message === 'string' && error.message) || '操作失败，请重试';
}

function initialStatus(supported) {
  return supported ? DISCOVERY_STATUS.UNAPPROVED : DISCOVERY_STATUS.UNSUPPORTED;
}

const isCounter = value => Number.isSafeInteger(value) && value >= 0;

export function createDiscoveryController({
  api = {},
  supported = false,
  debounceMs = 600,
  pollIntervalMs = 500,
  operationTimeoutMs = 32_000,
  now = () => Date.now(),
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = timer => clearTimeout(timer),
  ensureDraft = null,
  authorizeDesktop = null,
  onModels = null,
} = {}) {
  let state = {
    status: initialStatus(supported),
    reason: supported ? '' : DISCOVERY_REASON.unsupported,
    models: [],
    source: 'none',
    lastError: '',
    requestSeq: 0,
    consentId: null,
    consentExpiresAt: null,
    consentState: 'unapproved',
    dialogGeneration: 0,
    draftId: null,
    draftRevision: null,
    connectionRevision: null,
    targetFingerprint: '',
    authMode: 'none',
    modes: [],
    operationId: null,
    updatedAt: null,
    test: { status: 'idle', facts: null, error: '', reason: '', operationId: null },
  };
  const listeners = new Set();
  let timer = null;
  let pollTimer = null;
  let pollWake = null;
  let disposed = false;
  let activeRequest = 0;

  const notify = (patch) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) {
      try { listener(state); } catch { /* 视图自爆不拖垮控制器 */ }
    }
    return state;
  };

  const notifyTest = (patch) => notify({ test: { ...state.test, ...patch } });

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  };

  function wakePoll() {
    if (pollTimer !== null) clearTimeoutFn(pollTimer);
    pollTimer = null;
    const wake = pollWake;
    pollWake = null;
    wake?.();
  }

  function delay(ms) {
    return new Promise(resolve => {
      pollWake = resolve;
      pollTimer = setTimeoutFn(() => {
        pollTimer = null;
        pollWake = null;
        resolve();
      }, ms);
    });
  }

  const targetKey = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);

  function snapshotOf(seq) {
    return {
      seq,
      dialogGeneration: state.dialogGeneration,
      draftId: state.draftId,
      draftRevision: state.draftRevision,
      connectionRevision: state.connectionRevision,
      targetFingerprint: state.targetFingerprint,
      consentId: state.consentId,
    };
  }

  function isCurrent(snapshot) {
    return !disposed
      && snapshot.seq === activeRequest
      && snapshot.dialogGeneration === state.dialogGeneration
      && snapshot.draftId === state.draftId
      && snapshot.draftRevision === state.draftRevision
      && snapshot.connectionRevision === state.connectionRevision
      && snapshot.targetFingerprint === state.targetFingerprint
      && snapshot.consentId === state.consentId;
  }

  function bindingMatches(snapshot, result) {
    if (!result || typeof result !== 'object') return true;
    if (isCounter(result.dialogGeneration) && result.dialogGeneration !== snapshot.dialogGeneration) return false;
    if (isCounter(result.requestSeq) && result.requestSeq !== snapshot.seq) return false;
    if (Number.isSafeInteger(result.connectionRevision) && Number.isSafeInteger(snapshot.connectionRevision)
      && result.connectionRevision !== snapshot.connectionRevision) return false;
    return true;
  }

  /* 新操作开始前同时撤掉发现与测试两个单飞槽。旧操作没有后端停止证明时
   * 也不能假定它已释放；这里只发取消并等既有取消预算，不缩短超时。 */
  async function abortActiveOperations() {
    const ids = [...new Set([state.operationId, state.test.operationId].filter(Boolean))];
    const testWasActive = state.test.status === 'running' || Boolean(state.test.operationId);
    state.operationId = null;
    // 被新操作顶掉的测试也必须立刻退出 running，不能留下一个没有
    // operationId 的“正在测试”状态。202 尚未返回时没有 id 可取消，
    // 但代次递增会让迟到的 202 自行取消。
    state.test = testWasActive
      ? { ...state.test, status: 'idle', facts: null, error: '', reason: DISCOVERY_REASON.cancelled, operationId: null }
      : { ...state.test, operationId: null };
    wakePoll();
    await Promise.all(ids.map(id => cancelOperation(id)));
  }

  /* 取消是幂等请求；失败（not_found/config_conflict/网络）只表示没有得到
   * 停止证明，不影响本地丢弃旧结果，也绝不抛到调用方。 */
  async function cancelOperation(id) {
    if (!id || typeof api.cancelProviderOperation !== 'function') return null;
    try { return await api.cancelProviderOperation(id, { requestId: newRequestId('cancel') }); }
    catch { return null; }
  }

  function applyHandle(handle) {
    if (!handle || !handle.ok) return false;
    // 首次绑定（state.draftId 为空）不是「目标变了」；只有已经有目标再换才算。
    // 部分投影（如桌面授权句柄）可能不带连接代次，缺字段不能当成「变了」。
    const connectionChanged = Number.isSafeInteger(state.connectionRevision) && Number.isSafeInteger(handle.connectionRevision)
      && state.connectionRevision !== handle.connectionRevision;
    const targetChanged = state.draftId != null && (state.draftId !== handle.draftId
      || connectionChanged
      || (state.targetFingerprint && handle.targetFingerprint && state.targetFingerprint !== handle.targetFingerprint));
    const patch = {
      draftId: handle.draftId,
      draftRevision: handle.draftRevision,
      ...(Number.isSafeInteger(handle.connectionRevision) ? { connectionRevision: handle.connectionRevision } : {}),
      ...(handle.targetFingerprint ? { targetFingerprint: handle.targetFingerprint } : {}),
    };
    if (targetChanged) {
      const oldOperationId = state.operationId;
      activeRequest += 1;
      clearTimer();
      wakePoll();
      if (oldOperationId) void cancelOperation(oldOperationId);
      Object.assign(patch, {
        consentId: null,
        consentExpiresAt: null,
        consentState: 'unapproved',
        status: supported ? DISCOVERY_STATUS.UNAPPROVED : DISCOVERY_STATUS.UNSUPPORTED,
        reason: supported ? DISCOVERY_REASON.network_not_approved : DISCOVERY_REASON.unsupported,
        models: [],
        source: 'none',
        lastError: '',
        operationId: null,
      });
    }
    notify(patch);
    return true;
  }

  async function prepare() {
    if (disposed) return false;
    if (!supported) {
      notify({ status: DISCOVERY_STATUS.UNSUPPORTED, reason: DISCOVERY_REASON.unsupported });
      return false;
    }
    if (typeof ensureDraft === 'function') {
      let handle = null;
      try { handle = await ensureDraft(); } catch { handle = null; }
      if (disposed) return false;
      if (!handle || handle.ok !== true) {
        notify({ status: DISCOVERY_STATUS.UNAPPROVED,
          reason: handle?.message || '草稿没有保存成功，无法读取模型列表' });
        return false;
      }
      applyHandle(handle);
    }
    if (!state.draftId || !Number.isSafeInteger(state.draftRevision) || state.draftRevision <= 0) {
      notify({ status: DISCOVERY_STATUS.UNAPPROVED, reason: '请先保存草稿后再发现模型' });
      return false;
    }
    return true;
  }

  function modeReason(authMode) {
    const supportedMode = discoverySupportsAuth({ capabilities: { discoveryModes: state.modes } }, authMode);
    if (supportedMode === false) {
      return authMode === 'pi-credential'
        ? 'Pi 本机凭据发现需要桌面版的安全凭据窗口；当前环境未把它列为可用模式'
        : '当前认证来源不在自动发现的支持范围内';
    }
    if (supportedMode === null) return '当前认证来源不支持自动发现';
    return '';
  }

  function failurePatch(error) {
    return {
      status: DISCOVERY_STATUS.ERROR_STALE,
      reason: discoveryFailureReason(error),
      lastError: error?.code || 'error',
      updatedAt: now(),
      operationId: null,
    };
  }

  function applyDiscoverResult(snapshot, operation) {
    if (!isCurrent(snapshot)) return state;
    const payload = operation?.result && typeof operation.result === 'object' ? operation.result : null;
    if (payload && !bindingMatches(snapshot, payload)) return state;
    const models = Array.isArray(payload?.models) ? payload.models : [];
    if (operation?.state === 'success') {
      const sourceKind = typeof payload?.sourceKind === 'string' ? payload.sourceKind : 'remote';
      notify({
        status: models.length ? DISCOVERY_STATUS.READY : DISCOVERY_STATUS.EMPTY,
        reason: models.length ? '' : '没有发现模型，请手动添加或检查目标',
        models,
        source: sourceKind,
        lastError: '',
        updatedAt: now(),
        operationId: null,
      });
      if (models.length) onModels?.(models, { sourceKind, stale: false });
      return state;
    }
    // 失败：若服务端保留了上次缓存，候选仍然展示，但必须标 stale。
    const stale = models.length > 0 && payload?.stale !== false;
    notify({
      ...failurePatch(operation?.error),
      ...(stale ? {
        models,
        source: 'cache',
        status: DISCOVERY_STATUS.ERROR_STALE,
        reason: `${discoveryFailureReason(operation?.error)}；显示上次缓存的候选`,
      } : {
        status: DISCOVERY_STATUS.ERROR_STALE,
        models: state.models,
        source: state.source,
      }),
    });
    if (stale) onModels?.(models, { sourceKind: 'cache', stale: true });
    return state;
  }

  function applyTestResult(snapshot, operation) {
    if (!isCurrent(snapshot)) return state;
    const payload = operation?.result && typeof operation.result === 'object' ? operation.result : null;
    if (payload && !bindingMatches(snapshot, payload)) return state;
    if (operation?.state === 'success') {
      notify({
        operationId: null,
        test: { status: 'ready', facts: payload, error: '', reason: '', operationId: null },
      });
      return state;
    }
    const error = operation?.error || null;
    notify({
      operationId: null,
      test: {
        status: 'failed',
        facts: payload,
        error: error?.code || 'failed',
        reason: discoveryFailureReason(error),
        operationId: null,
      },
    });
    return state;
  }

  async function poll(snapshot, operationId, kind) {
    const deadline = now() + operationTimeoutMs;
    while (!disposed && isCurrent(snapshot)) {
      if (now() >= deadline) {
        await cancelOperation(operationId);
        if (!isCurrent(snapshot)) return state;
        return kind === 'test'
          ? notify({ operationId: null, test: { ...state.test, status: 'failed', error: 'timeout', reason: FAILURE_REASON.timeout } })
          : notify(failurePatch({ code: 'timeout' }));
      }
      await delay(pollIntervalMs);
      if (!isCurrent(snapshot)) { void cancelOperation(operationId); return state; }
      let operation = null;
      try { operation = await api.fetchProviderOperation(operationId); } catch { operation = { ok: false, network: true }; }
      if (!isCurrent(snapshot)) { void cancelOperation(operationId); return state; }
      if (!operation || operation.ok !== true) {
        if (operation?.network) continue; // 单次轮询网络抖动不结束操作，等下一次或超时
        const error = operation?.code ? { code: operation.code, message: operation.message } : { code: 'network_failed' };
        return kind === 'test'
          ? notify({ operationId: null, test: { ...state.test, status: 'failed', error: error.code, reason: discoveryFailureReason(error) } })
          : notify(failurePatch(error));
      }
      if (operation.state === 'pending' || operation.state === 'running') continue;
      if (operation.state === 'success') return kind === 'test' ? applyTestResult(snapshot, operation) : applyDiscoverResult(snapshot, operation);
      if (operation.state === 'failed') return kind === 'test' ? applyTestResult(snapshot, operation) : applyDiscoverResult(snapshot, operation);
      if (operation.state === 'cancelled') {
        return kind === 'test'
          ? notify({ operationId: null, test: { ...state.test, status: 'failed', error: 'cancelled', reason: DISCOVERY_REASON.cancelled } })
          : notify({ status: state.consentId ? DISCOVERY_STATUS.AUTHORIZED_IDLE : initialStatus(supported),
            reason: DISCOVERY_REASON.cancelled, operationId: null });
      }
      return kind === 'test'
        ? notify({ operationId: null, test: { ...state.test, status: 'failed', error: 'failed', reason: '操作返回了未知状态' } })
        : notify(failurePatch({ code: 'failed' }));
    }
    return state;
  }

  async function runDiscover(seq, force) {
    if (!await prepare() || disposed || seq !== activeRequest) return state;
    const modeError = modeReason(state.authMode);
    if (modeError) return notify({ status: DISCOVERY_STATUS.UNSUPPORTED, reason: modeError });
    if (!state.consentId) return notify({ status: DISCOVERY_STATUS.UNAPPROVED, reason: DISCOVERY_REASON.network_not_approved });
    await abortActiveOperations();
    if (disposed || seq !== activeRequest) return state;
    const snapshot = snapshotOf(seq);
    notify({ status: DISCOVERY_STATUS.REFRESHING, reason: '', requestSeq: seq, operationId: null, lastError: '' });
    let result;
    try {
      result = await api.discoverProviderModels({
        requestId: newRequestId('discover'),
        draftId: snapshot.draftId,
        draftRevision: snapshot.draftRevision,
        consentId: snapshot.consentId,
        dialogGeneration: snapshot.dialogGeneration,
        requestSeq: snapshot.seq,
        force: Boolean(force),
      });
    } catch {
      result = { ok: false, network: true, code: 'network_failed' };
    }
    if (!isCurrent(snapshot)) {
      // 202 在取消/换目标/关窗之后才返回：本地已经丢弃结果，但服务端操作
      // 可能仍在占用单飞槽，必须用新 requestId 明确取消。
      if (result?.ok === true && result.operationId) void cancelOperation(result.operationId);
      return state;
    }
    if (!result || result.ok !== true) {
      const error = result?.network ? { code: 'network_failed', message: DISCOVERY_REASON.network } : result || { code: 'failed' };
      return notify(failurePatch(error));
    }
    if (result.operationId) {
      notify({ operationId: result.operationId });
      return poll(snapshot, result.operationId, 'discover');
    }
    // 兼容直接返回结果的适配器（测试夹具/旧适配）；真实 P3-B 总是 202。
    return applyDiscoverResult(snapshot, { kind: 'discover', state: result.ok === true ? 'success' : 'failed', result });
  }

  const controller = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    configure({
      supported: nextSupported = supported,
      draftId = state.draftId,
      draftRevision = state.draftRevision,
      dialogGeneration = state.dialogGeneration,
      connectionRevision = state.connectionRevision,
      targetFingerprint = state.targetFingerprint,
      models = state.models,
      source = state.source,
      authMode = state.authMode,
      modes = state.modes,
    } = {}) {
      const identityChanged = draftId !== state.draftId
        || targetKey(connectionRevision) !== targetKey(state.connectionRevision)
        || targetFingerprint !== state.targetFingerprint;
      const authChanged = authMode !== state.authMode;
      const supportedChanged = nextSupported !== supported;
      // 草稿句柄第一次绑定（null → draftId）是「准备同一个目标」，不是换目标。
      // 它由正在等待 prepare() 的授权/刷新自己触发；此时递增代次会把发起者
      // 判成过期，表现为第一次点「授权并发现」毫无反应。与 applyHandle 同一口径。
      const firstBinding = state.draftId == null && draftId != null;
      const changed = supportedChanged || identityChanged || authChanged
        || draftRevision !== state.draftRevision || dialogGeneration !== state.dialogGeneration
        || JSON.stringify(modes) !== JSON.stringify(state.modes);
      supported = nextSupported;
      if (!changed) return state;
      // 目标或认证来源变化时，发现与测试两个槽都要撤；不能只因为发现状态
      // 不在 refreshing 就放过仍在运行的测试操作。
      if (!firstBinding && (identityChanged || authChanged || supportedChanged)) {
        const ids = [...new Set([state.operationId, state.test.operationId].filter(Boolean))];
        activeRequest += 1;
        clearTimer();
        wakePoll();
        state.operationId = null;
        state.test = { ...state.test, operationId: null };
        for (const id of ids) void cancelOperation(id);
      }
      if (identityChanged || authChanged) {
        return notify({
          status: nextSupported ? DISCOVERY_STATUS.UNAPPROVED : DISCOVERY_STATUS.UNSUPPORTED,
          reason: nextSupported ? DISCOVERY_REASON.network_not_approved : DISCOVERY_REASON.unsupported,
          models: identityChanged ? [] : models,
          source: identityChanged ? 'none' : source,
          requestSeq: firstBinding ? state.requestSeq : ++activeRequest,
          consentId: null,
          consentExpiresAt: null,
          consentState: 'unapproved',
          dialogGeneration,
          draftId,
          draftRevision,
          connectionRevision,
          targetFingerprint,
          authMode,
          modes,
          lastError: '',
          operationId: null,
          updatedAt: null,
          test: { status: 'idle', facts: null, error: '', reason: '', operationId: null },
        });
      }
      return notify({
        status: supportedChanged ? (nextSupported ? DISCOVERY_STATUS.UNAPPROVED : DISCOVERY_STATUS.UNSUPPORTED) : state.status,
        reason: supportedChanged ? (nextSupported ? '' : DISCOVERY_REASON.unsupported) : state.reason,
        draftId,
        draftRevision,
        dialogGeneration,
        connectionRevision,
        targetFingerprint,
        authMode,
        modes,
        models: Array.isArray(models) ? models : [],
        source: source || 'none',
        ...(supportedChanged ? { test: { status: 'idle', facts: null, error: '', reason: '', operationId: null } } : {}),
      });
    },
    async authorize({ rememberTarget = false } = {}) {
      clearTimer();
      if (disposed) return state;
      const seq = ++activeRequest;
      if (!supported) return notify({ status: DISCOVERY_STATUS.UNSUPPORTED, reason: DISCOVERY_REASON.unsupported });
      if (!await prepare() || disposed || seq !== activeRequest) return state;
      const modeError = modeReason(state.authMode);
      if (modeError) return notify({ status: DISCOVERY_STATUS.UNSUPPORTED, reason: modeError });
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
        result = { ok: false, network: true, code: 'network_failed' };
      }
      if (disposed || seq !== activeRequest) return state;
      if (!result || result.ok !== true) {
        if (result?.code === 'unsupported') {
          return notify({ status: DISCOVERY_STATUS.UNSUPPORTED, reason: discoveryFailureReason(result) });
        }
        return notify({ status: DISCOVERY_STATUS.UNAPPROVED,
          reason: result?.network ? DISCOVERY_REASON.network : discoveryFailureReason(result),
          lastError: result?.code || 'authorize_failed' });
      }
      if (result.requiresDesktopConfirmation === true) {
        if (typeof authorizeDesktop !== 'function') {
          return notify({ status: DISCOVERY_STATUS.UNAPPROVED,
            reason: '该认证来源需要桌面安全凭据窗口确认授权；当前环境没有可用的私有桥' });
        }
        let desktop;
        try { desktop = await authorizeDesktop({ draftId: state.draftId, draftRevision: state.draftRevision, rememberTarget }); }
        catch { desktop = { ok: false, reason: '安全凭据窗口没有完成授权' }; }
        if (disposed || seq !== activeRequest) return state;
        if (!desktop?.ok) {
          return notify({ status: DISCOVERY_STATUS.UNAPPROVED,
            reason: desktop?.reason || '安全凭据窗口没有完成授权，请重试', lastError: desktop?.code || 'authorize_cancelled' });
        }
        if (desktop.draftId) applyHandle(desktop);
        if (!desktop.consentId) {
          return notify({ status: DISCOVERY_STATUS.UNAPPROVED,
            reason: '授权已确认，但没能在草稿上读取到有效授权句柄；请重试', lastError: 'invalid_target' });
        }
        notify({ consentId: desktop.consentId, consentExpiresAt: desktop.consentExpiresAt || null,
          consentState: 'authorized-idle', status: DISCOVERY_STATUS.AUTHORIZED_IDLE, reason: '' });
      } else {
        if (!result.consentId) {
          return notify({ status: DISCOVERY_STATUS.UNAPPROVED, reason: '授权应答没有返回有效句柄，请重试', lastError: 'invalid_target' });
        }
        notify({ consentId: result.consentId, consentExpiresAt: result.expiresAt || null,
          consentState: 'authorized-idle', status: DISCOVERY_STATUS.AUTHORIZED_IDLE, reason: '' });
      }
      // 授权后 600ms 防抖再自动读取一次；不越过用户的取消窗口。
      return controller.refresh({ force: true });
    },
    async revoke() {
      clearTimer();
      activeRequest += 1;
      wakePoll();
      const consentId = state.consentId;
      const operationIds = [...new Set([state.operationId, state.test.operationId].filter(Boolean))];
      state.consentId = null;
      state.operationId = null;
      state.test = { status: 'idle', facts: null, error: '', reason: '', operationId: null };
      for (const id of operationIds) void cancelOperation(id);
      if (consentId && supported && typeof api.revokeProviderDiscovery === 'function') {
        try {
          await api.revokeProviderDiscovery({ requestId: newRequestId('revoke'), consentId });
        } catch { /* 撤销失败也应回到未授权，避免界面假装仍被授权 */ }
      }
      if (disposed) return state;
      return notify({ status: initialStatus(supported), consentState: 'unapproved', consentExpiresAt: null,
        reason: supported ? DISCOVERY_REASON.network_not_approved : DISCOVERY_REASON.unsupported });
    },
    refresh({ force = false, immediate = false } = {}) {
      if (disposed) return Promise.resolve(state);
      if (!supported) return Promise.resolve(notify({ status: DISCOVERY_STATUS.UNSUPPORTED, reason: DISCOVERY_REASON.unsupported }));
      clearTimer();
      const seq = ++activeRequest;
      if (immediate) return runDiscover(seq, force);
      notify({ status: DISCOVERY_STATUS.DEBOUNCING, reason: '', requestSeq: seq });
      return new Promise(resolve => {
        timer = setTimeoutFn(() => {
          timer = null;
          runDiscover(seq, force).then(resolve, () => resolve(state));
        }, debounceMs);
      });
    },
    /** 仅用于测试/关闭前的显式冲刷，避免等待 600ms。 */
    flush() {
      if (timer === null) return Promise.resolve(state);
      clearTimer();
      const seq = ++activeRequest;
      return runDiscover(seq, false);
    },
    async test() {
      clearTimer();
      if (disposed) return state;
      const seq = ++activeRequest;
      if (!supported) return notify({ test: { ...state.test, status: 'failed', error: 'unsupported', reason: DISCOVERY_REASON.unsupported } });
      if (!await prepare() || disposed || seq !== activeRequest) return state;
      const modeError = modeReason(state.authMode);
      if (modeError) return notify({ test: { ...state.test, status: 'failed', error: 'unsupported', reason: modeError } });
      if (!state.consentId) return notify({ test: { ...state.test, status: 'failed', error: 'invalid_target', reason: '请先授权目标，再测试连接' } });
      await abortActiveOperations();
      if (disposed || seq !== activeRequest) return state;
      const snapshot = snapshotOf(seq);
      notify({ operationId: null, test: { status: 'running', facts: null, error: '', reason: '正在测试连接…', operationId: null } });
      let result;
      try {
        result = await api.testProviderConnection({
          requestId: newRequestId('test'),
          draftId: snapshot.draftId,
          draftRevision: snapshot.draftRevision,
          consentId: snapshot.consentId,
          dialogGeneration: snapshot.dialogGeneration,
          requestSeq: snapshot.seq,
          force: true,
        });
      } catch {
        result = { ok: false, network: true, code: 'network_failed' };
      }
      if (!isCurrent(snapshot)) {
        // 与发现相同：迟到的测试 202 也必须取消，不能留下后台单飞槽。
        if (result?.ok === true && result.operationId) void cancelOperation(result.operationId);
        return state;
      }
      if (!result || result.ok !== true) {
        const error = result?.network ? { code: 'network_failed' } : result || { code: 'failed' };
        return notify({ test: { status: 'failed', facts: null, error: error.code || 'failed', reason: discoveryFailureReason(error), operationId: null } });
      }
      if (result.operationId) {
        notify({ test: { ...state.test, operationId: result.operationId } });
        return poll(snapshot, result.operationId, 'test');
      }
      return applyTestResult(snapshot, { state: result.ok === true ? 'success' : 'failed', result });
    },
    cancel() {
      clearTimer();
      const cancelSeq = ++activeRequest;
      const ids = [...new Set([state.operationId, state.test.operationId].filter(Boolean))];
      state.operationId = null;
      wakePoll();
      if (disposed) return state;
      const wasTesting = state.test.status === 'running' || Boolean(state.test.operationId);
      const wasBusy = wasTesting || ids.length > 0
        || state.status === DISCOVERY_STATUS.DEBOUNCING || state.status === DISCOVERY_STATUS.REFRESHING;
      const localReason = wasBusy ? DISCOVERY_REASON.cancel_requested : '';
      const current = notify({
        status: state.consentId ? DISCOVERY_STATUS.AUTHORIZED_IDLE : initialStatus(supported),
        reason: localReason,
        operationId: null,
        ...(wasTesting ? { test: { ...state.test, status: 'idle', reason: localReason, operationId: null } } : {}),
      });
      if (ids.length) {
        // 「已请求取消」不等于后端已停止。只有取消请求得到明确结果（已取消，
        // 或操作已不存在/已被替换）才把文案收敛为已取消；网络失败保持保守。
        void Promise.all(ids.map(id => cancelOperation(id))).then(results => {
          if (disposed || activeRequest !== cancelSeq) return;
          const confirmed = results.every(result => result
            && (result.ok === true || result.code === 'not_found' || result.code === 'config_conflict'));
          notify({ reason: confirmed ? DISCOVERY_REASON.cancelled : DISCOVERY_REASON.cancel_unconfirmed });
        });
      }
      return current;
    },
    dispose() {
      disposed = true;
      clearTimer();
      activeRequest += 1;
      wakePoll();
      const ids = [state.operationId, state.test.operationId].filter(Boolean);
      state.operationId = null;
      for (const id of ids) void cancelOperation(id);
      listeners.clear();
    },
  };
  return controller;
}
