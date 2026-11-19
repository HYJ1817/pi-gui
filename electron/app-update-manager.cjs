'use strict';

/* 可信更新编排层：主进程里唯一的「检查 / 偏好 / 忽略 / 暂停 / 自动下载」状态源。
 *
 * 它不自己下载、不自己安装：下载/校验/缓存/安装全部委托给现有
 * app-update.cjs 更新器；这里只决定「什么时候可以请求它」以及「什么时候
 * 可以把已校验的包交给退出安装」。Renderer 只能看到快照、发出固定操作，
 * 不能指定 URL、路径、命令行、版本或更新源。
 *
 * 并发规则：
 *   - 检查单飞（同一时刻只有一个 readUpdate 请求）；
 *   - 自动下载单飞（同一时刻只有一个 download 任务）；
 *   - 每个异步回调返回后都重新读取当前快照，过期结果不覆盖新状态。 */

const {
  compareVersions,
  isNewerVersion,
  isStrictVersion,
  resolveAutomaticSupport,
} = require('./app-update-policy.cjs');

const ACTIVE_PHASES = new Set([
  'downloading',
  'verifying',
  'preparing',
  'installing',
  'recovering',
]);

const INITIAL_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 300;

function safeError(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text ? text.slice(0, MAX_ERROR_LENGTH) : fallback;
}

function createAppUpdateManager({
  updater,
  store,
  mode,
  currentVersion,
  platform = process.platform,
  packaged = true,
  readUpdate,
  publish = () => {},
  notify = () => {},
  isBlocked = () => false,
  logger = () => {},
  now = () => Date.now(),
  initialDelayMs = INITIAL_CHECK_DELAY_MS,
  intervalMs = CHECK_INTERVAL_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  if (!updater || typeof updater.download !== 'function') {
    throw new TypeError('app update manager requires an updater');
  }
  if (!store || typeof store.snapshot !== 'function') {
    throw new TypeError('app update manager requires a preference store');
  }
  if (typeof readUpdate !== 'function') {
    throw new TypeError('app update manager requires readUpdate');
  }
  if (!isStrictVersion(currentVersion)) {
    throw new TypeError('app update manager requires a strict current version');
  }

  const support = resolveAutomaticSupport({ platform, packaged, mode });
  let disposed = false;
  let started = false;
  let initialTimer = null;
  let intervalTimer = null;
  let checkSeq = 0;
  let checkInflight = null;
  let checkForce = false;
  let downloadTask = null;
  let downloadSeq = 0;
  let supersedeRetries = 0;
  let noticeSeq = 0;
  const readyNotified = new Set();
  let discovery = {
    status: 'idle',
    latestVersion: '',
    release: null,
    error: '',
    checkedAt: '',
  };

  function storedState() {
    return store.snapshot();
  }

  /* 有效策略不是“内存里选了 automatic”这么简单：偏好必须已经成功落盘，
   * 且忽略/暂停等安全字段没有未确认的脏值。写入失败的 automatic 只能算
   * 用户请求，不能获得自动下载或自动安装资格。 */
  function automaticTrusted() {
    const stored = storedState();
    if (stored.preference !== 'automatic') return false;
    if (typeof store.automaticTrusted === 'function') {
      return store.automaticTrusted() === true;
    }
    return stored.saveFailed !== true && stored.corrupt !== true && stored.loaded !== false;
  }

  function effectivePreference() {
    const stored = storedState();
    if (stored.preference !== 'automatic') return 'manual';
    if (!support.supported) return 'manual';
    return automaticTrusted() ? 'automatic' : 'manual';
  }

  function updaterState() {
    try {
      return updater.state() || {};
    } catch {
      return { phase: 'failed', error: '更新器状态不可用', code: 'state' };
    }
  }

  /* 自动安装候选：所有条件都从当前快照重新计算，不做任何缓存式许可。
   * 真正的安装动作仍会由 app-update.cjs 再次校验包、官方元数据和维护状态。 */
  function autoInstallCandidate() {
    if (disposed) return { ok: false, code: 'disposed' };
    const stored = storedState();
    if (stored.preference === 'automatic' && !support.supported) {
      return { ok: false, code: support.code || 'unsupported' };
    }
    if (stored.preference === 'automatic' && !automaticTrusted()) {
      return { ok: false, code: 'preference-unsaved' };
    }
    if (effectivePreference() !== 'automatic') {
      return { ok: false, code: 'preference' };
    }
    if (!support.supported) {
      return { ok: false, code: support.code || 'unsupported' };
    }
    if (mode !== 'installed') return { ok: false, code: 'mode' };
    try {
      if (isBlocked()) return { ok: false, code: 'blocked' };
    } catch {
      return { ok: false, code: 'blocked' };
    }
    const state = updaterState();
    if (state.phase !== 'ready') return { ok: false, code: 'not-ready' };
    if (!isStrictVersion(state.version)) {
      return { ok: false, code: 'invalid-version' };
    }
    if (compareVersions(state.version, currentVersion) !== 1) {
      return { ok: false, code: 'not-newer' };
    }
    if (stored.ignoredVersion === state.version) {
      return { ok: false, code: 'ignored' };
    }
    if (stored.pausedVersion === state.version) {
      return { ok: false, code: 'paused' };
    }
    return { ok: true, code: null, version: state.version };
  }

  /* 安装阶段仍要复核用户意图，但不能再要求 phase==='ready'：更新器一旦
   * 进入 preparing，phase 已经变了。这里只检查「这个自动安装是否仍被允许」
   * 的持久条件，供 app-update.cjs 在每个异步步骤后重新调用。 */
  function autoInstallStillAllowed() {
    if (disposed) return false;
    if (effectivePreference() !== 'automatic') return false;
    if (!support.supported) return false;
    if (mode !== 'installed') return false;
    const state = updaterState();
    if (!isStrictVersion(state.version)) return false;
    if (compareVersions(state.version, currentVersion) !== 1) return false;
    const stored = storedState();
    if (stored.ignoredVersion === state.version) return false;
    if (stored.pausedVersion === state.version) return false;
    return true;
  }

  /* 显式安装的原生确认对话框会停留一段时间。确认期间目标版本、忽略状态
   * 和安装形态仍可能变化；真正写入 armed 前必须按当前状态复核，而不是
   * 把“用户点过确认”当成永久许可。手动安装不受自动偏好影响。 */
  function manualInstallStillAllowed(expectedVersion) {
    if (disposed) return false;
    if (mode !== 'installed') return false;
    if (!isStrictVersion(expectedVersion)) return false;
    const state = updaterState();
    if (!isStrictVersion(state.version) || state.version !== expectedVersion) return false;
    if (state.phase !== 'ready' && state.phase !== 'preparing') return false;
    const stored = storedState();
    if (stored.ignoredVersion === expectedVersion) return false;
    if (stored.corrupt && stored.loaded !== true) return false;
    return true;
  }

  function snapshot() {
    const state = updaterState();
    const stored = storedState();
    const candidate = autoInstallCandidate();
    const target = isStrictVersion(state.version)
      ? state.version
      : isStrictVersion(discovery.latestVersion)
        ? discovery.latestVersion
        : null;
    return {
      phase: typeof state.phase === 'string' ? state.phase : 'failed',
      mode,
      currentVersion,
      version: isStrictVersion(state.version) ? state.version : null,
      transactionId: Number.isSafeInteger(state.transactionId) ? state.transactionId : null,
      received: Number.isFinite(state.received) ? state.received : 0,
      total: Number.isFinite(state.total) ? state.total : 0,
      speed: Number.isFinite(state.speed) ? state.speed : 0,
      error: typeof state.error === 'string' ? state.error : '',
      code: typeof state.code === 'string' ? state.code : '',
      preference: effectivePreference(),
      requestedPreference: stored.preference,
      storedPreference: stored.preference,
      persistedPreference:
        typeof stored.persistedPreference === 'string' ? stored.persistedPreference : null,
      automaticSupported: support.supported,
      automaticUnsupportedReason: support.code,
      automaticTrusted: automaticTrusted(),
      discovery: {
        status: discovery.status,
        latestVersion: discovery.latestVersion,
        release: discovery.release,
        error: discovery.error,
        checkedAt: discovery.checkedAt,
      },
      ignoredVersion: stored.ignoredVersion,
      pausedVersion: stored.pausedVersion,
      lastNotifiedVersion: stored.lastNotifiedVersion,
      ignored: Boolean(stored.ignoredVersion && (!target || stored.ignoredVersion === target)),
      paused: Boolean(stored.pausedVersion && (!target || stored.pausedVersion === target)),
      preferenceSaveFailed: stored.saveFailed === true,
      overrideActive: stored.overrideActive === true,
      overridePersisted: stored.overridePersisted === true,
      installOnQuit: candidate.ok,
      installOnQuitBlockedReason: candidate.ok ? null : candidate.code,
    };
  }

  function publishNow() {
    try {
      publish(snapshot());
    } catch (error) {
      try {
        logger('publish', error);
      } catch {
        // 发布失败不能影响更新状态机。
      }
    }
  }

  function emitNotice(notice) {
    noticeSeq += 1;
    try {
      notify({ ...notice, id: noticeSeq });
    } catch (error) {
      try {
        logger('notice', error);
      } catch {
        // 通知失败不影响更新状态机。
      }
    }
  }

  function normalizeUpdate(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, error: '更新服务返回了无效数据' };
    }
    if (payload.ok === false) {
      return {
        ok: false,
        error: safeError(payload.error, '检查更新失败，请稍后重试'),
        code: typeof payload.code === 'string' ? payload.code : 'check_failed',
      };
    }
    if (
      payload.currentVersion !== undefined &&
      payload.currentVersion !== currentVersion
    ) {
      return { ok: false, error: '更新服务版本与当前运行版本不一致' };
    }
    if (!isStrictVersion(payload.latestVersion)) {
      return { ok: false, error: '更新服务返回的版本号无效' };
    }
    const updateAvailable = payload.updateAvailable === true;
    const release = payload.release;
    if (updateAvailable) {
      if (!release || typeof release !== 'object' || release.tag !== `v${payload.latestVersion}`) {
        return { ok: false, error: '更新服务返回的发布信息与版本不一致' };
      }
    }
    return {
      ok: true,
      latestVersion: payload.latestVersion,
      updateAvailable,
      release: release && typeof release === 'object' ? release : null,
    };
  }

  /* 发现更高版本后，旧的「忽略/暂停」自动失效；同版本仍然保持，
   * 这正是「忽略此版本」而不是「永久关闭更新」的语义。 */
  function reconcileSuppression(latestVersion, stored) {
    const patch = {};
    if (
      stored.ignoredVersion &&
      isStrictVersion(latestVersion) &&
      isNewerVersion(latestVersion, stored.ignoredVersion)
    ) {
      patch.ignoredVersion = null;
    }
    if (
      stored.pausedVersion &&
      isStrictVersion(latestVersion) &&
      isNewerVersion(latestVersion, stored.pausedVersion)
    ) {
      patch.pausedVersion = null;
    }
    if (Object.keys(patch).length === 0) return stored;
    // This runs on a background check, not on a user save. Never let it write
    // an unsaved automatic preference (or an ignore/pause) to disk; the old
    // persisted suppression is harmless and is re-evaluated on every check.
    const result = store.update(patch, { repair: false, transient: true });
    return result.ok ? result.state : stored;
  }

  function currentTask() {
    if (!downloadTask) return null;
    const state = updaterState();
    if (
      Number.isSafeInteger(state.transactionId) &&
      state.transactionId !== downloadTask.id
    ) {
      // 更新器已经在跑另一个事务；旧任务的回调不能操作新事务。
      return null;
    }
    return downloadTask;
  }

  /* 下载器重新读取官方 Release 后、真正拉安装包之前调用。这里的版本是
   * 实际下载目标，不再拿发现层的旧版本猜测；偏好、忽略、暂停必须针对
   * 这个实际版本重新检查。 */
  function approveDownload(task, info) {
    if (disposed || task.cancelled) return { ok: false, code: 'cancelled' };
    const version = info?.version;
    if (!isStrictVersion(version)) return { ok: false, code: 'invalid_asset' };
    const state = updaterState();
    if (Number.isSafeInteger(state.transactionId) && state.transactionId !== task.id) {
      return { ok: false, code: 'stale' };
    }
    if (task.source === 'auto') {
      if (effectivePreference() !== 'automatic' || !support.supported || mode !== 'installed') {
        return { ok: false, code: 'revoked' };
      }
    }
    const stored = storedState();
    if (stored.ignoredVersion === version) return { ok: false, code: 'ignored' };
    if (stored.pausedVersion === version) return { ok: false, code: 'paused' };

    const latest = discovery.latestVersion;
    if (isStrictVersion(latest)) {
      const compared = compareVersions(version, latest);
      if (compared === -1) {
        // 发现层已经指向更高版本：旧下载目标作废，不能拿过期版本覆盖展示。
        task.superseded = true;
        task.supersededFor = latest;
        return { ok: false, code: 'superseded' };
      }
      if (compared === 1) {
        // 实际 Release 比发现层更新：把发现层收敛到实际可信目标。
        discovery = {
          ...discovery,
          status: 'available',
          latestVersion: version,
          release: info.release && typeof info.release === 'object' ? info.release : discovery.release,
          error: '',
        };
        supersedeRetries = 0;
        publishNow();
      }
    }
    task.targetVersion = version;
    publishNow();
    return { ok: true, version };
  }

  function startDownload(source, expectedVersion) {
    if (downloadTask) return downloadTask.promise;
    const task = {
      id: (downloadSeq += 1),
      source,
      expectedVersion: isStrictVersion(expectedVersion) ? expectedVersion : null,
      targetVersion: null,
      supersededFor: null,
      cancelled: false,
      superseded: false,
      promise: null,
    };
    downloadTask = task;
    task.promise = Promise.resolve()
      .then(() =>
        updater.download({
          confirm: true,
          transactionId: task.id,
          expectedVersion: task.expectedVersion,
          approve: (info) => approveDownload(task, info),
        }),
      )
      .then((result) => {
        if (!result || result.ok !== true) {
          // 后台下载失败不弹通知；状态已经由更新器发布，页面会显示原因。
          logger('download', result && result.code ? result.code : 'failed');
        }
        return result;
      })
      .catch((error) => {
        logger('download', error && error.message ? error.message : 'failed');
        return null;
      })
      .finally(() => {
        if (downloadTask === task) downloadTask = null;
        publishNow();
        if (task.superseded && !disposed && supersedeRetries < 2) {
          supersedeRetries += 1;
          // 让旧事务完全结束后再启动新目标，避免并行下载和过期回调。
          void maybeAutoDownload();
        }
      });
    return task.promise;
  }

  function convergeAutoDownload(latestVersion) {
    const task = currentTask();
    if (!task || task.source !== 'auto' || !isStrictVersion(latestVersion)) return;
    if (task.targetVersion && compareVersions(latestVersion, task.targetVersion) === 1) {
      task.superseded = true;
      task.supersededFor = latestVersion;
      try {
        updater.cancel();
      } catch {
        // 更新器自行收敛；旧任务结束时不会再提交 ready。
      }
    }
  }

  function maybeAutoDownload() {
    if (disposed) return Promise.resolve(null);
    if (downloadTask) return downloadTask.promise;
    const preference = effectivePreference();
    if (preference !== 'automatic' || !support.supported) {
      return Promise.resolve(null);
    }
    if (discovery.status !== 'available') return Promise.resolve(null);
    if (!isStrictVersion(discovery.latestVersion)) return Promise.resolve(null);
    const stored = storedState();
    if (stored.ignoredVersion === discovery.latestVersion) {
      return Promise.resolve(null);
    }
    if (stored.pausedVersion === discovery.latestVersion) {
      return Promise.resolve(null);
    }
    try {
      if (isBlocked()) return Promise.resolve(null);
    } catch {
      return Promise.resolve(null);
    }
    const state = updaterState();
    if (ACTIVE_PHASES.has(state.phase)) return Promise.resolve(null);
    if (state.phase === 'ready' && state.version === discovery.latestVersion) {
      return Promise.resolve(null);
    }
    return startDownload('auto', discovery.latestVersion);
  }

  async function check({ manual = false, force = false } = {}) {
    if (disposed) return { ok: false, code: 'disposed', snapshot: snapshot() };
    if (checkInflight) {
      // 手动检查必须绕过缓存。若当前在飞的是后台非强制检查，等它结束
      // 后再补一次强制检查；同一时刻仍只有一个 readUpdate 在跑。
      if ((manual || force === true) && !checkForce) {
        try {
          await checkInflight;
        } catch {
          // 前一次检查的失败由它自己的调用方处理；这里仍要补强制检查。
        }
        if (disposed) return { ok: false, code: 'disposed', snapshot: snapshot() };
        return check({ manual, force });
      }
      return checkInflight;
    }
    checkSeq += 1;
    const seq = checkSeq;
    checkForce = manual || force === true;
    const previous = discovery;
    discovery = {
      ...discovery,
      status: 'checking',
      error: '',
    };
    publishNow();

    checkInflight = (async () => {
      let payload;
      try {
        payload = await readUpdate({ force: manual || force === true });
      } catch (error) {
        payload = {
          ok: false,
          error: safeError(error && error.message, '检查更新失败，请检查网络后重试'),
        };
      }
      if (disposed || seq !== checkSeq) {
        return { ok: false, code: 'stale', snapshot: snapshot() };
      }

      const normalized = normalizeUpdate(payload);
      if (!normalized.ok) {
        if (manual) {
          discovery = {
            status: 'error',
            latestVersion: previous.latestVersion,
            release: previous.release,
            error: safeError(normalized.error, '检查更新失败，请稍后重试'),
            checkedAt: new Date(now()).toISOString(),
          };
        } else if (previous.status === 'available' || previous.status === 'latest') {
          // 后台检查失败不覆盖上一次成功结果，也不弹反复打扰的通知。
          discovery = { ...previous, error: '' };
        } else {
          discovery = {
            status: 'error',
            latestVersion: '',
            release: null,
            error: safeError(normalized.error, '检查更新失败，请稍后重试'),
            checkedAt: new Date(now()).toISOString(),
          };
        }
        publishNow();
        return {
          ok: false,
          code: normalized.code || 'check_failed',
          error: safeError(normalized.error, '检查更新失败，请稍后重试'),
          snapshot: snapshot(),
        };
      }

      let stored = storedState();
      stored = reconcileSuppression(normalized.latestVersion, stored);
      const discoveryChanged = discovery.latestVersion !== normalized.latestVersion;
      discovery = {
        status: normalized.updateAvailable ? 'available' : 'latest',
        latestVersion: normalized.latestVersion,
        release: normalized.release,
        error: '',
        checkedAt: new Date(now()).toISOString(),
      };
      if (discoveryChanged) supersedeRetries = 0;

      const wantAutomatic = effectivePreference() === 'automatic';
      if (
        normalized.updateAvailable &&
        !wantAutomatic &&
        stored.lastNotifiedVersion !== normalized.latestVersion &&
        stored.ignoredVersion !== normalized.latestVersion
      ) {
        store.update({ lastNotifiedVersion: normalized.latestVersion }, { repair: false });
        emitNotice({ kind: 'available', version: normalized.latestVersion });
      }

      publishNow();
      if (wantAutomatic) {
        // 发现层已经出现更高版本时，先让旧事务作废，再启动新目标。
        convergeAutoDownload(normalized.latestVersion);
        // 不阻塞检查响应：自动下载在后台进行，状态由更新器持续发布。
        void maybeAutoDownload();
      }
      return { ok: true, snapshot: snapshot() };
    })();

    try {
      return await checkInflight;
    } finally {
      checkInflight = null;
      checkForce = false;
    }
  }

  function setPreference(value) {
    if (disposed) return { ok: false, code: 'disposed', snapshot: snapshot() };
    if (value !== 'automatic' && value !== 'manual') {
      return { ok: false, code: 'invalid_preference', snapshot: snapshot() };
    }
    if (value === 'automatic' && !support.supported) {
      return {
        ok: false,
        code: 'unsupported',
        reason: support.code,
        snapshot: snapshot(),
      };
    }
    const result = store.setPreference(value);
    if (!result.ok) {
      return { ok: false, code: result.code, snapshot: snapshot() };
    }
    // Any switch to manual must stop an automatic transaction immediately,
    // even if the previous effective policy had already degraded to manual
    // because a safety field was unsaved. Already verified packages stay.
    if (value === 'manual' && downloadTask?.source === 'auto') {
      downloadTask.cancelled = true;
      try {
        updater.cancel();
      } catch {
        // 取消失败由更新器自行收敛，不能因此假装切换失败。
      }
    }
    const effective = effectivePreference();
    publishNow();
    if (effective === 'automatic') void maybeAutoDownload();
    const stored = storedState();
    let error = '';
    if (result.persisted !== true) {
      if (value === 'manual') {
        error = stored.overridePersisted
          ? '已立即关闭自动更新；设置写入失败，但重启后仍会保持手动。请稍后重试保存。'
          : '已立即关闭自动更新，但设置未能写入；重启后可能恢复自动更新，请稍后重试。';
      } else {
        error = '自动更新设置未能写入，本次运行仍按手动更新。请重试保存。';
      }
    }
    return {
      ok: true,
      persisted: result.persisted === true,
      preference: effective,
      requestedPreference: value,
      ...(error ? { error } : {}),
      snapshot: snapshot(),
    };
  }

  function download() {
    if (disposed) return Promise.resolve({ ok: false, code: 'disposed' });
    const stored = storedState();
    const expected = isStrictVersion(discovery.latestVersion)
      ? discovery.latestVersion
      : null;
    if (expected && stored.ignoredVersion === expected) {
      return Promise.resolve({
        ok: false,
        code: 'ignored',
        error: '此版本已被忽略，请先取消忽略。',
      });
    }
    const state = updaterState();
    if (state.phase === 'downloading' || state.phase === 'verifying') {
      return Promise.resolve({ ok: true, code: 'already-running' });
    }
    if (ACTIVE_PHASES.has(state.phase)) {
      return Promise.resolve({ ok: false, code: 'busy', error: '更新正在进行中。' });
    }
    // 用户主动下载等同于恢复这个版本：清除它的暂停标记，但不动其他版本。
    if (expected && stored.pausedVersion === expected) {
      store.setPausedVersion(null);
    }
    return startDownload('manual', expected).then((result) => {
      publishNow();
      return result || { ok: false, code: 'failed' };
    });
  }

  function cancel() {
    if (disposed) return { ok: false, code: 'disposed', snapshot: snapshot() };
    const state = updaterState();
    if (state.phase !== 'downloading' && state.phase !== 'verifying') {
      return { ok: false, code: 'not_downloading', snapshot: snapshot() };
    }
    const task = currentTask();
    if (task) task.cancelled = true;
    // 只有本事务已经解析出目标版本时才记录暂停；元数据尚未返回时，
    // 旧任务的 version 不属于当前下载，绝不能拿来写 pausedVersion。
    const target = task
      ? task.targetVersion
      : Number.isSafeInteger(state.transactionId)
        ? null
        : isStrictVersion(state.version)
          ? state.version
          : null;
    if (target) {
      store.setPausedVersion(target);
      if (store.snapshot().ignoredVersion !== target) {
        store.setLastNotifiedVersion(target);
      }
    }
    try {
      updater.cancel();
    } catch {
      // 取消请求已经发出；更新器会把状态收敛到 cancelled/failed。
    }
    publishNow();
    return { ok: true, version: target, paused: Boolean(target), snapshot: snapshot() };
  }

  function ignore() {
    if (disposed) return { ok: false, code: 'disposed', snapshot: snapshot() };
    const state = updaterState();
    const task = currentTask();
    const active = state.phase === 'downloading' || state.phase === 'verifying';
    // 下载中优先使用本事务解析出的实际目标；尚未解析时，用户看到的是
    // 发现层版本，就忽略那个版本并取消整个事务。绝不沿用旧任务的版本。
    const target = (active ? task?.targetVersion : null)
      || (isStrictVersion(state.version) && !active ? state.version : null)
      || (isStrictVersion(discovery.latestVersion) ? discovery.latestVersion : null);
    if (!target) {
      if (active) {
        if (task) task.cancelled = true;
        try {
          updater.cancel();
        } catch {
          // 取消失败不影响“没有可忽略版本”的结果。
        }
      }
      return { ok: false, code: 'no_version', snapshot: snapshot() };
    }
    const result = store.update({
      ignoredVersion: target,
      lastNotifiedVersion: target,
    });
    if (!result.ok) {
      return { ok: false, code: result.code, snapshot: snapshot() };
    }
    if (active && (!task || task.id === state.transactionId)) {
      if (task) task.cancelled = true;
      // 已下载/下载中的版本被忽略后，立即取消自动安装资格；
      // 若还在下载，同时中止网络请求并清理临时文件。
      try {
        updater.cancel();
      } catch {
        // 更新器会自行收敛；忽略状态已经生效。
      }
    }
    publishNow();
    return {
      ok: true,
      version: target,
      persisted: result.persisted === true,
      snapshot: snapshot(),
    };
  }

  function unignore() {
    if (disposed) return { ok: false, code: 'disposed', snapshot: snapshot() };
    const result = store.update({ ignoredVersion: null });
    if (!result.ok) {
      return { ok: false, code: result.code, snapshot: snapshot() };
    }
    publishNow();
    if (effectivePreference() === 'automatic') void maybeAutoDownload();
    return { ok: true, persisted: result.persisted === true, snapshot: snapshot() };
  }

  function handleUpdaterChange() {
    if (disposed) return;
    const state = updaterState();
    if (state.phase === 'ready' && isStrictVersion(state.version)) {
      const stored = storedState();
      if (
        effectivePreference() === 'automatic' &&
        support.supported &&
        stored.ignoredVersion !== state.version &&
        stored.pausedVersion !== state.version &&
        !readyNotified.has(state.version)
      ) {
        readyNotified.add(state.version);
        emitNotice({ kind: 'ready', version: state.version });
      }
    }
    publishNow();
  }

  const unsubscribe =
    typeof updater.onChange === 'function'
      ? updater.onChange(handleUpdaterChange)
      : null;

  function start() {
    if (started || disposed) return;
    started = true;
    const run = () => {
      void check({ manual: false }).catch(() => {});
    };
    if (initialDelayMs > 0) {
      initialTimer = setTimeoutImpl(run, initialDelayMs);
    } else {
      run();
    }
    intervalTimer = setIntervalImpl(run, intervalMs);
    if (initialTimer && typeof initialTimer.unref === 'function') initialTimer.unref();
    if (intervalTimer && typeof intervalTimer.unref === 'function') intervalTimer.unref();
  }

  function stop() {
    if (initialTimer) {
      clearTimeoutImpl(initialTimer);
      initialTimer = null;
    }
    if (intervalTimer) {
      clearIntervalImpl(intervalTimer);
      intervalTimer = null;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    checkSeq += 1;
    stop();
    try {
      if (typeof unsubscribe === 'function') unsubscribe();
    } catch {
      // 解绑失败不影响退出。
    }
  }

  return {
    check,
    snapshot,
    start,
    stop,
    dispose,
    setPreference,
    download,
    cancel,
    ignore,
    unignore,
    autoInstallCandidate,
    autoInstallStillAllowed,
    manualInstallStillAllowed,
    maybeAutoDownload,
    whenIdle() {
      return downloadTask
        ? Promise.resolve(downloadTask.promise).then(() => undefined)
        : Promise.resolve();
    },
    get support() {
      return support;
    },
  };
}

module.exports = {
  ACTIVE_PHASES,
  CHECK_INTERVAL_MS,
  INITIAL_CHECK_DELAY_MS,
  createAppUpdateManager,
};
