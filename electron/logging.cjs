/* Electron 主进程的日志适配。
 *
 * 主进程与后端各写自己的文件（main-* / app-*）；设置文件由后端写，
 * 主进程在每次记录前按 mtime 重新读取，所以用户在设置里关闭/切换详细模式
 * 会同时作用到两端。任何日志失败都不能影响窗口、后端或退出流程。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadCore() {
  const candidates = [
    path.join(__dirname, 'log-core.cjs'),
    path.join(__dirname, '..', 'lib', 'log-core.cjs'),
  ];
  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      if (mod && typeof mod.createLogCore === 'function') return mod;
    } catch { /* try next */ }
  }
  return null;
}

function createMainLogging({ dir, version = '0.0.0', appRoot = path.resolve(__dirname, '..'), now = Date.now, fsApi } = {}) {
  const coreMod = loadCore();
  if (!coreMod) {
    /* 打包布局异常时不要让整个应用起不来；日志退化为 no-op。 */
    const noop = () => false;
    return {
      available: false, dir, role: 'main', runId: null,
      log: noop, event: noop, crash: noop, flush: async () => {}, flushSync: noop,
      status: () => ({ ok: false, role: 'main', unavailable: true }),
      refreshSettings: () => ({}), close: () => {}, isEnabled: () => false,
    };
  }
  const core = coreMod.createLogCore({ dir, role: 'main', version, appRoot, now, fsApi });
  const event = (source, name, details, meta) => {
    try { core.refreshSettings(); return core.event(source, name, details, meta); } catch { return false; }
  };
  const crash = (source, name, error, details, meta) => {
    try { core.refreshSettings(); return core.crash(source, name, error, details, meta); } catch { return false; }
  };
  return {
    available: true,
    dir: core.dir,
    role: 'main',
    runId: core.runId,
    log: event,
    event,
    crash,
    flush: () => core.flush(),
    flushSync: () => { try { core.flushSync(); } catch { /* noop */ } },
    status: () => core.status(),
    refreshSettings: () => core.refreshSettings(),
    updateSettings: patch => core.updateSettings(patch),
    close: reason => { try { core.close({ reason }); } catch { /* noop */ } },
    isEnabled: () => core.isEnabled(),
  };
}

function defaultMainLogDir({ app, env = process.env } = {}) {
  if (env.PI_GUI_LOG_DIR) return path.resolve(env.PI_GUI_LOG_DIR);
  const root = env.PI_GUI_DATA || (app && typeof app.getPath === 'function' ? app.getPath('userData') : process.cwd());
  return path.join(root, 'logs');
}

module.exports = { createMainLogging, defaultMainLogDir };
