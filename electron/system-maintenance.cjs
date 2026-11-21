'use strict';

// A storage restart borrows the existing backend maintenance barrier, NOT the
// update install authority. It never stops a busy Agent to make a preflight pass.
function createSystemMaintenance({ getServer, updates, inspectDesktop = () => ({ ok: true }),
  prepareDesktop = async () => {}, relaunch, quit, timeoutMs = 30000 } = {}) {
  let sequence = 0, operation = null, restarting = false, disposed = false, recoveryBlocked = false, deferredExit = null;
  const failure = code => ({ ok: false, code,
    error: '仍有任务、审批、终端或维护操作，或无法确认安全退出。请完成后重试。' });

  function backend(action, child) {
    if (!child?.connected) return Promise.resolve(failure('backend_unavailable'));
    // Updater correlation IDs are positive. A late reply from that owner must
    // never acknowledge a storage operation (and vice versa).
    const id = --sequence;
    return new Promise(resolve => {
      let finished = false;
      const finish = result => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.removeListener('message', message);
        child.removeListener('exit', exited);
        resolve(result);
      };
      const message = value => { if (value?.type === 'app-update' && value.id === id) finish(value); };
      const exited = () => finish(failure('backend_exited'));
      const timer = setTimeout(() => finish(failure('backend_timeout')), timeoutMs);
      child.on('message', message);
      child.once('exit', exited);
      try { child.send({ type: 'app-update', id, action }, error => { if (error) finish(failure('backend_unavailable')); }); }
      catch { finish(failure('backend_unavailable')); }
    });
  }

  async function restart({ commit, arm, cancel } = {}) {
    if (disposed || operation || restarting || recoveryBlocked) return failure('maintenance_busy');
    // Acquire synchronously. An updater can neither enter its confirmation gap
    // nor arm an installer while this lease is held.
    const lease = updates ? updates.reserveMaintenance?.() : Symbol('storage-without-updater');
    if (!lease) return failure('update_busy');
    const child = getServer();
    operation = (async () => {
      let prepared = false, prepareUncertain = false, intentId, stopped = false;
      try {
        const desktop = inspectDesktop();
        if (!desktop?.ok) return desktop;
        const status = await backend('inspect', child);
        if (!status.ok) return status;
        const result = await backend('prepare', child);
        prepareUncertain = ['backend_timeout', 'backend_unavailable'].includes(result.code);
        if (!result.ok) return result;
        prepared = true;
        if (disposed || !inspectDesktop()?.ok) return failure('desktop_changed');
        await prepareDesktop();
        const intent = await commit();
        intentId = intent?.intentId;
        if (!intent?.ok || !intentId) return intent?.ok === false ? intent : failure('storage_intent_failed');
        if (disposed || getServer() !== child || !child?.connected) return failure('backend_unavailable');
        let listener, timer;
        const exited = new Promise(resolve => {
          listener = (code, signal) => resolve(code === 0 && !signal);
          child.once('exit', listener);
          timer = setTimeout(() => resolve(false), timeoutMs);
        });
        try {
          const response = await backend('shutdown', child);
          if (!response.ok || !(await exited)) return failure('backend_exit_unconfirmed');
          stopped = true;
        } finally { clearTimeout(timer); child.removeListener('exit', listener); }
        if (disposed) return failure('maintenance_disposed');
        const ready = await arm(intentId);
        if (!ready?.ok) throw Error('storage_arm_failed');
        if (disposed) return failure('maintenance_disposed');
        // Cold copying is deferred to the next startup, before any writers.
        relaunch();
        restarting = true;
        setImmediate(() => { if (!disposed) quit(); });
        return { ok: true, restartPending: true };
      } catch { return { ok: false, code: 'maintenance_failed',
        error: stopped ? '已停止旧服务，但未能确认自动重启。请重新启动应用并检查迁移状态。'
          : '维护准备失败，未切换数据目录。请重试。' }; }
      finally {
        if (!restarting) {
          // An unarmed record can never copy on boot, even if cancellation
          // also fails. Keep the maintenance gate closed on uncertain cleanup.
          if (intentId && !stopped) {
            try { recoveryBlocked = (await cancel?.(intentId))?.ok !== true; }
            catch { recoveryBlocked = true; }
          }
          if (stopped) recoveryBlocked = true; // no live backend to resume
          if (!recoveryBlocked && (prepared || prepareUncertain)) {
            const released = await backend('release', child);
            recoveryBlocked = !released.ok;
          }
          if (!recoveryBlocked) updates?.releaseMaintenance?.(lease);
        }
      }
    })();
    try { return await operation; }
    finally {
      operation = null;
      const resumeExit = deferredExit;
      deferredExit = null;
      if (!restarting && resumeExit) setImmediate(() => { if (!disposed) resumeExit(); });
    }
  }

  return { restart, busy: () => Boolean(operation) || restarting || recoveryBlocked,
    restarting: () => restarting, recoveryBlocked: () => recoveryBlocked,
    deferQuit(event, retry = quit) {
      if (!operation || restarting) return false;
      event?.preventDefault?.();
      // An explicit app quit takes priority over a window close, which may
      // only hide to tray. Re-enter the normal gates after settlement.
      if (!deferredExit || retry === quit) deferredExit = retry;
      return true;
    },
    dispose() { disposed = true; deferredExit = null; } };
}
module.exports = { createSystemMaintenance };
