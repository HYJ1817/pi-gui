'use strict';

/* Observation bootstrap, NOT an alternate Electron application. The only window,
 * preload, backend, token injection and sandbox are owned by production main.
 * No BrowserWindow construction, IPC replacement or request interception here.
 */
const renderer = {
  async readiness() {
    const { S } = await import('/state.js');
    return { cwd: S.cwd, owner: S.legacyOwner, connected: document.querySelector('#connText')?.textContent.includes('已连接') === true,
      desktop: window.piGuiDesktop?.isDesktop === true, node: [typeof require, typeof process, typeof Buffer, typeof ipcRenderer],
      inputReady: Boolean(document.querySelector('#input')) };
  },
  async health() { const response = await fetch('/api/health'); return { status: response.status, app: (await response.json()).app }; },
  async theme(mode) { return (await import('/theme.js')).setThemePreference(mode); },
  geometry() { return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    scrollWidth: document.documentElement.scrollWidth, theme: document.documentElement.dataset.theme,
    language: document.documentElement.lang || null }; },
  target(selector) {
    const element = document.querySelector(selector);
    if (!element) throw Error('missing_target');
    element.scrollIntoView({ block: 'center' });
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) throw Error('hidden_target');
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  },
  sidebarCollapsed() { return document.querySelector('#btnSidebarExpand')?.hidden === false; },
  async closeOwners() {
    const { S } = await import('/state.js');
    const call = async body => {
      const response = await fetch('/api/runtime-sessions', body ? { method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(S.legacyOwner ? { 'X-Pi-Gui-Owner': JSON.stringify(S.legacyOwner) } : {}) }, body: JSON.stringify(body) } : {});
      return response.json();
    };
    const before = await call();
    if (!Array.isArray(before.items)) return { confirmed: false, closed: 0 };
    let closed = 0;
    for (const item of before.items) if (item.owner) {
      if ((await call({ action: 'close', owner: item.owner })).ok !== true) return { confirmed: false, closed };
      closed++;
    }
    const after = await call();
    return { confirmed: Array.isArray(after.items) && after.items.every(item => !item.owner), closed };
  },
};
function validateRendererScripts() {
  const vm = require('node:vm');
  for (const fn of Object.values(renderer)) new vm.Script('(' + fn.toString().replace(/^(async\s+)?[\w]+\(/, '$1function(') + ')');
  return Object.keys(renderer).length;
}
module.exports = { renderer, validateRendererScripts };

if (process.versions.electron && process.env.VISUAL_REPLIES_OBSERVER === '1') {
  // Electron's app bootstrap does not consistently set require.main to this
  // module. Gate on the explicit observer marker plus the real runtime instead.
  start().catch(() => { process.exitCode = 1; require('electron').app.exit(1); });
} else if (require.main === module && process.argv.includes('--check-driver')) {
  const count = validateRendererScripts();
  console.log(`Visual Replies renderer syntax: ${count}/${count}; no Electron/Pi/model`);
} else if (require.main === module) process.exit(2);

async function start() {
  const fs = require('node:fs'), path = require('node:path');
  const { app, BrowserWindow } = require('electron');
  const h = require('./visual-replies-support.cjs');
  const world = h.validateWorld(process.env.VISUAL_REPLIES_WORLD, process.env.VISUAL_REPLIES_TEMP_ROOT), mode = process.env.VISUAL_REPLIES_MODE;
  if (path.resolve(require('node:os').tmpdir()) !== path.join(world, 'tmp')) throw Error('invalid_child_tmp');
  if (!['preflight', 'offline', 'live'].includes(mode)) throw Error('invalid_mode');
  const main = path.join(h.ROOT, 'electron/main.cjs');
  if (path.resolve(process.env.VISUAL_REPLIES_MAIN || '') !== main) throw Error('nonproduction_main');
  for (const [name, directory] of Object.entries({ home: 'home', appData: 'appdata', userData: 'profile', sessionData: 'profile',
    temp: 'tmp', logs: 'logs', crashDumps: 'logs' })) app.setPath(name, path.join(world, directory));
  const file = path.join(world, 'evidence/observer.json');
  let win, stage = 'before-production-main', quitting = false;
  const report = { schemaVersion: 1, mode, scope: mode === 'preflight' ? 'production-launch-only' : 'visual-replies',
    startedAt: new Date().toISOString(), stage, completed: false, failed: 0, checks: [], shots: [], facts: {},
    visualRepliesAcceptance: false, unverified: ['visual-reply-tool-contract', 'iframe-security', 'lifecycle', 'real-model-turn'] };
  const save = () => h.saveJson(file, report);
  const mark = name => { stage = name; report.stage = name; save(); console.log('STAGE ' + name); };
  const check = (id, pass, details) => {
    report.checks.push({ id, pass: Boolean(pass), ...(details === undefined ? {} : { details }) });
    if (!pass) report.failed++;
    save(); console.log((pass ? 'PASS ' : 'FAIL ') + id);
    if (!pass) throw Error('check_failed');
  };
  const read = async (fn, ...args) => {
    const expression = '(' + fn.toString().replace(/^(async\s+)?[\w]+\(/, '$1function(') + ')(...' + JSON.stringify(args) + ')';
    new (require('node:vm').Script)(expression);
    try { return await win.webContents.executeJavaScript(expression, true); }
    catch { throw Error('renderer_evaluation_failed'); }
  };
  const until = async (fn, name, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await fn()) return; await h.sleep(75); }
    report.timeout = name; throw Error('condition_timeout');
  };
  const click = async selector => {
    const point = await read(renderer.target, selector);
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type, ...point, button: 'left', clickCount: 1,
    });
  };
  const shot = async name => {
    const metrics = await read(renderer.geometry), png = (await win.webContents.capturePage()).toPNG();
    if (!png.length) throw Error('empty_capture');
    fs.writeFileSync(path.join(world, 'evidence', name + '.png'), png, { flag: 'wx' });
    report.shots.push({ file: name + '.png', bytes: png.length, sha256: h.hashText(png), ...metrics }); save();
    return metrics;
  };
  app.once('will-quit', () => {
    report.cleanup = { ...(report.cleanup || {}), quitObserved: true };
    report.endedAt = new Date().toISOString(); save();
  });
  // Earliest persisted marker distinguishes native runtime failure from failures
  // after production main or renderer boot. No arbitrary error/payload is saved.
  save();
  require(main);
  try {
    await app.whenReady(); mark('production-window');
    await until(() => {
      win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('http://127.0.0.1:' + process.env.PORT + '/'));
      return Boolean(win);
    }, 'production-window', 60000);
    if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.debugger.attach('1.3');
    const prefs = win.webContents.getLastWebPreferences();
    report.facts.preferenceShape = Object.fromEntries(Object.entries(prefs).map(([key, value]) => [key, typeof value]));
    report.facts.productionModuleLoaded = Boolean(require.cache[main]?.loaded); save();
    // Electron 44's getLastWebPreferences projection omits preload paths. Prove
    // the real main module here, then the production bridge in the renderer;
    // retain the source preload digest instead of inventing a missing property.
    const preload = path.join(h.ROOT, 'electron/preload.cjs');
    check('production-main', require.cache[main]?.loaded === true);
    check('normal-sandbox', prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false
      && !app.commandLine.hasSwitch('no-sandbox') && !app.commandLine.hasSwitch('disable-web-security'));
    report.facts.runtime = { electron: process.versions.electron, node: process.versions.node, platform: process.platform,
      sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration,
      preloadSha256: h.digest(preload), mainSha256: h.digest(main), remoteDebuggingPort: app.commandLine.hasSwitch('remote-debugging-port') };
    await until(async () => { const ready = await read(renderer.readiness); return ready.connected && ready.owner?.sessionId && ready.inputReady; }, 'production-ready');
    const ready = await read(renderer.readiness), health = await read(renderer.health);
    check('production-preload', ready.desktop);
    check('backend-health', health.status === 200 && health.app === 'pi-gui');
    check('temporary-owner', path.resolve(ready.cwd) === path.join(world, 'project-a') && ready.owner?.backendInstance
      && ready.owner?.workspaceId && ready.owner?.workspaceEpoch && ready.owner?.sessionId);
    check('renderer-no-node', ready.node.every(value => value === 'undefined'));
    report.facts.owner = ready.owner;
    mark('trusted-pointer-roundtrip');
    await click('#btnSidebarCollapse');
    await until(() => read(renderer.sidebarCollapsed), 'sidebar-collapsed');
    await click('#btnSidebarExpand');
    await until(async () => !await read(renderer.sidebarCollapsed), 'sidebar-expanded');
    check('pointer-sidebar-roundtrip', true);
    for (const theme of ['dark', 'light']) for (const [label, width, height] of [['wide', 1320, 820], ['narrow', 700, 600]]) {
      mark('theme-' + theme + '-' + label); win.setContentSize(width, height);
      if (!await read(renderer.theme, theme)) throw Error('theme_update_rejected');
      await until(async () => { const m = await read(renderer.geometry); return Math.abs(m.width - width) <= 1 && m.theme === theme; }, 'theme-and-size');
      await h.sleep(150);
      const metrics = await shot('preflight-' + theme + '-' + label);
      check('theme-' + theme + '-' + label, metrics.scrollWidth <= metrics.width + 1 && metrics.height >= height - 1, metrics);
    }
    if (mode !== 'preflight') {
      // Fail closed until the real tool/ref/owner contract lands. Infrastructure
      // success is never described as iframe or Visual Replies acceptance.
      throw Error('visual_reply_contract_pending');
    }
    report.completed = true;
  } catch (error) {
    if (error.message !== 'check_failed') report.failed++;
    report.failure = { stage, code: ['check_failed', 'condition_timeout', 'renderer_evaluation_failed', 'theme_update_rejected',
      'empty_capture', 'visual_reply_contract_pending'].includes(error.message) ? error.message : 'observer_failed' };
    save();
  } finally {
    mark('cleanup');
    try {
      if (win && !win.isDestroyed()) {
        const closed = await read(renderer.closeOwners);
        report.cleanup = { runtimeOwners: closed };
        if (!closed.confirmed) throw Error('runtime_cleanup_unconfirmed');
      }
    } catch { report.failed++; report.cleanup = { runtimeOwners: { confirmed: false } }; }
    fs.writeFileSync(path.join(world, 'ready-for-cleanup'), 'ready', { flag: 'wx' });
    try {
      await until(() => fs.existsSync(path.join(world, 'processes-observed')), 'parent-observation', 30000);
      check('parent-observed', fs.readFileSync(path.join(world, 'processes-observed'), 'utf8') === 'confirmed');
    } catch { report.failed++; }
    report.completed = report.completed && report.failed === 0;
    save(); quitting = true; app.quit();
    const watchdog = setTimeout(() => {
      if (quitting) { report.completed = false; report.failed++; report.failure = { stage: 'cleanup', code: 'quit_timeout' }; save(); app.exit(1); }
    }, 20000);
    watchdog.unref();
  }
}
