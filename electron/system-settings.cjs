'use strict';

const { createSystemSettingsStore, validSetting } = require('./system-settings-store.cjs');
const { createSystemPower, TYPES } = require('./system-power.cjs');
const { createSystemTray } = require('./system-tray.cjs');
const { createSystemCache } = require('./system-cache.cjs');

const CHANNELS = Object.freeze({
  state: 'pi-gui:system-state', set: 'pi-gui:system-set', measure: 'pi-gui:system-cache-measure',
  clear: 'pi-gui:system-cache-clear', quit: 'pi-gui:system-quit',
  networkSave: 'pi-gui:system-network-save', networkTest: 'pi-gui:system-network-test',
  storagePick: 'pi-gui:system-storage-pick', storageMigrate: 'pi-gui:system-storage-migrate',
});

// One main-process owner. A tray hide never reaches Pi, Runtime or maintenance.
async function createSystemSettings({ ipcMain, getWindow, origin, directory, session,
  browserDirectory, powerSaveBlocker, Tray, Menu, icon, quit, platform = process.platform,
  network = null, storage = null, cacheProviders, store: injectedStore } = {}) {
  const store = injectedStore || await createSystemSettingsStore({ directory });
  const power = createSystemPower({ powerSaveBlocker });
  const tray = createSystemTray({ Tray, Menu, icon, getWindow, quit, platform });
  const cache = createSystemCache({ session, ...(cacheProviders ? { providers: cacheProviders } : {}) });
  let registered = false, disposed = false, saving = null, cachePending = null, drainingQuit = false, error = '';
  const warnings = new Map();
  const saved = store.snapshot().settings;
  for (const key of Object.keys(TYPES)) {
    try { power.set(key, saved[key]); } catch { warnings.set(key, '部分电源设置未能恢复，请检查当前状态。'); }
  }
  try { tray.apply(saved.closeBehavior); } catch { warnings.set('closeBehavior', '托盘不可用，关闭窗口将退出应用。'); }

  function snapshot() {
    const persisted = store.snapshot();
    return {
      persistence: persisted.status,
      effective: { ...power.snapshot(), closeBehavior: tray.behavior() },
      capabilities: { power: power.supported, tray: tray.supported, cache: cache.supported, network: Boolean(network), storage: Boolean(storage) },
      network: network?.snapshot(), storage: storage?.state(),
      browserDirectory, error: [error, ...new Set(warnings.values()), persisted.error].filter(Boolean).join(' '),
    };
  }
  function trusted(event) {
    try {
      const win = getWindow();
      return !disposed && !tray.exiting() && win && !win.isDestroyed()
        && event.sender === win.webContents && event.senderFrame
        && event.senderFrame === win.webContents.mainFrame
        && new URL(event.senderFrame.url).protocol === 'http:'
        && new URL(event.senderFrame.url).origin === origin;
    } catch { return false; }
  }
  async function persist(key, value) {
    const previous = store.snapshot().settings;
    const wasActive = power.snapshot()[key];
    let committed = false;
    try {
      if (key === 'closeBehavior' && value === 'tray') tray.ensure();
      if (Object.hasOwn(TYPES, key)) power.set(key, value);
      const result = await store.save({ ...previous, [key]: value });
      if (!result.ok) throw Error('settings_save_failed');
      committed = true;
      if (!disposed && key === 'closeBehavior') tray.apply(value);
      warnings.delete(key);
      error = '';
      return { ok: true, snapshot: snapshot() };
    } catch {
      if (committed) {
        // The atomic file replacement is final. Report the saved intent and
        // actual runtime policy rather than pretending persistence rolled back.
        error = '';
        warnings.set(key, '系统设置已保存，但未能应用。当前关闭行为保持不变，请重试或重启应用。');
        return { ok: false, code: 'settings_saved_not_applied', committed: true, snapshot: snapshot() };
      }
      let restored = true;
      if (!disposed) {
        try {
          if (key === 'closeBehavior' && tray.behavior() === 'quit') tray.apply('quit');
          else if (Object.hasOwn(TYPES, key)) {
            power.set(key, wasActive ?? previous[key]);
            restored = power.snapshot()[key] === wasActive;
          }
        } catch { restored = false; }
      }
      error = restored ? '系统设置保存或应用失败，此次更改未保存。请重试。' : '';
      if (!restored) warnings.set(key, '系统设置保存失败，运行状态未能恢复。请检查开关或退出应用。');
      return { ok: false, code: 'settings_not_applied', snapshot: snapshot() };
    }
  }
  function set(request) {
    if (!request || Object.keys(request).length !== 2 || !validSetting(request.key, request.value)) {
      return { ok: false, code: 'invalid_setting' };
    }
    if (saving || drainingQuit) return { ok: false, code: 'settings_busy' };
    if (store.snapshot().status === 'unavailable') return { ok: false, code: 'settings_unavailable', snapshot: snapshot() };
    saving = persist(request.key, request.value).finally(() => { saving = null; });
    return saving;
  }
  // Ordinary quits wait for the one already-authorized atomic save. Do not
  // admit another save into that gap or bypass the updater on the retry.
  function deferQuit(event) {
    if (disposed || tray.isSystemEnding() || event.defaultPrevented || (!saving && !cachePending && !drainingQuit)) return false;
    event.preventDefault();
    if (!drainingQuit) {
      drainingQuit = true;
      const resume = () => {
        drainingQuit = false;
        if (!disposed && !tray.isSystemEnding()) quit();
      };
      const pending = saving && cachePending ? Promise.all([saving, cachePending]) : saving || cachePending;
      void pending.then(resume, resume);
    }
    return true;
  }
  function register() {
    if (registered || disposed) return;
    registered = true;
    const handle = (channel, count, run) => ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) return { ok: false, code: 'forbidden' };
      if (args.length !== count) return { ok: false, code: 'invalid_request' };
      return run(...args);
    });
    handle(CHANNELS.state, 0, async () => { await saving; return { ok: true, snapshot: snapshot() }; });
    handle(CHANNELS.set, 1, set);
    handle(CHANNELS.networkSave, 1, request => {
      if (!network) return { ok: false, code: 'network_unavailable' };
      if (saving || drainingQuit) return { ok: false, code: 'settings_busy' };
      saving = network.save(request).then(result => ({ ...result, snapshot: snapshot() })).finally(() => { saving = null; });
      return saving;
    });
    handle(CHANNELS.networkTest, 1, request => {
      if (!network || saving || drainingQuit) return { ok: false, code: 'network_unavailable' };
      return network.test(request);
    });
    handle(CHANNELS.storagePick, 0, () => {
      if (!storage || saving || cachePending || drainingQuit) return { ok: false, code: 'storage_unavailable' };
      saving = storage.pick().finally(() => { saving = null; });
      return saving;
    });
    handle(CHANNELS.storageMigrate, 1, request => {
      if (!storage || saving || cachePending || drainingQuit) return { ok: false, code: 'storage_unavailable' };
      saving = storage.migrate(request).finally(() => { saving = null; });
      return saving;
    });
    const cacheOperation = run => {
      if (saving || cachePending || drainingQuit) return { ok: false, code: 'cache_busy', bytes: null };
      // Native disk statistics are slower than P1's memory query. They exclude
      // migration/exit, but must not disable unrelated power/tray preferences.
      cachePending = Promise.resolve().then(run).finally(() => { cachePending = null; });
      return cachePending;
    };
    handle(CHANNELS.measure, 0, () => cacheOperation(cache.measure));
    handle(CHANNELS.clear, 1, request => cacheOperation(() => cache.clear(request)));
    handle(CHANNELS.quit, 0, () => { setImmediate(quit); return { ok: true }; });
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (registered) for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel);
    registered = false;
    cache.dispose(); power.dispose(); tray.dispose();
  }
  return { register, dispose, deferQuit, hideOnClose: tray.hideOnClose, restore: tray.restore,
    beginQuit: tray.beginQuit, markSystemEnding: tray.markSystemEnding, isSystemEnding: tray.isSystemEnding };
}
module.exports = { createSystemSettings, CHANNELS };
