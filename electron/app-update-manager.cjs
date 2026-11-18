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
  resolveEffectivePreference,
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
  let autoTask = null;
  let downloadSource = null;
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

  function effectivePreference() {
    return resolveEffectivePreference(storedState().preference, support);
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
    const stored = storedState();
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
      received: Number.isFinite(state.received) ? state.received : 0,
      total: Number.isFinite(state.total) ? state.total : 0,
      speed: Number.isFinite(state.speed) ? state.speed : 0,
      error: typeof state.error === 'string' ? state.error : '',
      code: typeof state.code === 'string' ? state.code : '',
      preference: effectivePreference(),
      storedPreference: stored.preference,
      automaticSupported: support.supported,
      automaticUnsupportedReason: support.code,
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
    const result = store.update(patch);
    return result.ok ? result.state : stored;
  }

  function maybeAutoDownload() {
    if (disposed) return Promise.resolve(null);
    if (autoTask) return autoTask;
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

    downloadSource = 'auto';
    autoTask = Promise.resolve()
      .then(() => updater.download({ confirm: true }))
      .then((result) => {
        if (!result || result.ok !== true) {
          // 后台下载失败不弹通知；状态已经由更新器发布，页面会显示原因。
          logger('auto-download', result && result.code ? result.code : 'failed');
        }
        return result;
      })
      .catch((error) => {
        logger('auto-download', error && error.message ? error.message : 'failed');
        return null;
      })
      .finally(() => {
        if (downloadSource === 'auto') downloadSource = null;
        autoTask = null;
        publishNow();
      });
    return autoTask;
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
      discovery = {
        status: normalized.updateAvailable ? 'available' : 'latest',
        latestVersion: normalized.latestVersion,
        release: normalized.release,
        error: '',
        checkedAt: new Date(now()).toISOString(),
      };

      const wantAutomatic =
        resolveEffectivePreference(stored.preference, support) === 'automatic';
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
    const previous = effectivePreference();
    const result = store.setPreference(value);
    if (!result.ok) {
      return { ok: false, code: result.code, snapshot: snapshot() };
    }
    if (value === 'manual' && previous === 'automatic' && downloadSource === 'auto') {
      // 自动下载在切换后立即失效；已经校验完成的包保留，可手动安装。
      downloadSource = null;
      try {
        updater.cancel();
      } catch {
        // 取消失败由更新器自行收敛，不能因此假装切换失败。
      }
    }
    publishNow();
    if (value === 'automatic') void maybeAutoDownload();
    return {
      ok: true,
      persisted: result.persisted === true,
      snapshot: snapshot(),
    };
  }

  function download() {
    if (disposed) return Promise.resolve({ ok: false, code: 'disposed' });
    const stored = storedState();
    const target = isStrictVersion(discovery.latestVersion)
      ? discovery.latestVersion
      : updaterState().version;
    if (target && stored.ignoredVersion === target) {
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
    if (target && stored.pausedVersion === target) {
      store.setPausedVersion(null);
    }
    downloadSource = 'manual';
    return Promise.resolve()
      .then(() => updater.download({ confirm: true }))
      .then((result) => {
        if (!result || result.ok !== true) {
          downloadSource = null;
        }
        publishNow();
        return result || { ok: false, code: 'failed' };
      })
      .catch((error) => {
        downloadSource = null;
        publishNow();
        return {
          ok: false,
          code: 'failed',
          error: safeError(error && error.message, '下载更新失败'),
        };
      });
  }

  function cancel() {
    if (disposed) return { ok: false, code: 'disposed', snapshot: snapshot() };
    const state = updaterState();
    if (state.phase !== 'downloading' && state.phase !== 'verifying') {
      return { ok: false, code: 'not_downloading', snapshot: snapshot() };
    }
    const target = isStrictVersion(state.version)
      ? state.version
      : isStrictVersion(discovery.latestVersion)
        ? discovery.latestVersion
        : null;
    downloadSource = null;
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
    // 与 snapshot()/界面一致：先忽略当前已下载或下载中的那个版本；
    // 只有更新器没有持有版本时，才忽略发现层显示的最新版本。
    const target = isStrictVersion(state.version)
      ? state.version
      : isStrictVersion(discovery.latestVersion)
        ? discovery.latestVersion
        : null;
    if (!target) {
      return { ok: false, code: 'no_version', snapshot: snapshot() };
    }
    const result = store.update({
      ignoredVersion: target,
      lastNotifiedVersion: target,
    });
    if (!result.ok) {
      return { ok: false, code: result.code, snapshot: snapshot() };
    }
    if (
      (state.phase === 'downloading' ||
        state.phase === 'verifying' ||
        state.phase === 'ready') &&
      state.version === target
    ) {
      // 已下载/下载中的版本被忽略后，立即取消自动安装资格；
      // 若还在下载，同时中止网络请求并清理临时文件。
      if (state.phase === 'downloading' || state.phase === 'verifying') {
        downloadSource = null;
        try {
          updater.cancel();
        } catch {
          // 更新器会自行收敛；忽略状态已经生效。
        }
      }
    }
    publishNow();
    return { ok: true, version: target, persisted: result.persisted === true, snapshot: snapshot() };
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
    if (state.phase === 'failed' || state.phase === 'cancelled') {
      downloadSource = null;
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
    maybeAutoDownload,
    whenIdle() {
      return autoTask ? Promise.resolve(autoTask).then(() => undefined) : Promise.resolve();
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
