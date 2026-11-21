/* Production main entry, with observation-only adapters around actual Electron
 * Tray/power APIs. No product test hooks, remote CDP port or weakened sandbox. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const Module = require('node:module');
const electron = require('electron');
const { app, BrowserWindow, session, nativeImage, powerSaveBlocker } = electron;
const ROOT = path.resolve(__dirname, '../..');
const phase = process.env.SYSTEM_PHASE, world = process.env.SYSTEM_WORLD, out = process.env.SYSTEM_OUTPUT;
const origin = 'http://127.0.0.1:' + process.env.PORT;
const report = { phase, checks: [], failed: 0, screenshots: [], powerCalls: [], trayCreated: 0, errors: [], sandbox: null };
const trays = [], nativeIds = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win, cacheWindow, pageServer, exitReady = false, deadline;
const update = { eligible: true, preflights: 0, installs: 0, veto: false, release: null };
const read = code => win.webContents.executeJavaScript(code, true);
async function until(test, name) {
  for (let i = 0; i < 1500; i++) { if (await test()) return; await sleep(50); }
  throw Error('timeout: ' + name);
}
function check(name, value) { assert.ok(value, name); report.checks.push(name); console.log('PASS ' + phase + ': ' + name); }
async function click(selector) {
  win.show(); win.focus(); win.webContents.focus();
  const point = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input target');e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  await sleep(100);
}
async function key(keyCode, modifiers = []) {
  win.webContents.focus(); win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  // Chromium's native button default action consumes the Enter character event.
  if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(80);
}
const state = () => read('window.piGuiDesktop.systemSettings.state()');
async function set(key, value) {
  const result = await read(`window.piGuiDesktop.systemSettings.set(${JSON.stringify(key)},${JSON.stringify(value)})`);
  assert.equal(result.ok, true, 'set ' + key); return result;
}
async function api(body, route = '/api/runtime-sessions') {
  return read(`(async()=>{const a=await import('/api.js');return ${body ? `a.sendJSON(${JSON.stringify(route)},{body:${JSON.stringify(body)}})` : `a.getJSON(${JSON.stringify(route)})`}})()`);
}
function trace() { try { return fs.readFileSync(process.env.SYSTEM_PI_TRACE, 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } }
async function readyToExit() {
  fs.writeFileSync(path.join(world, phase + '-ready'), 'ready');
  await until(() => fs.existsSync(path.join(world, phase + '-ack')), 'process identity capture');
  exitReady = true;
}
function saveReport() {
  report.powerRemaining = [...nativeIds].filter(id => powerSaveBlocker.isStarted(id)).length;
  report.trayRemaining = trays.filter(tray => !tray.isDestroyed()).length;
  report.electron = process.versions.electron; report.node = process.versions.node; report.platform = process.platform;
  fs.writeFileSync(path.join(out, phase + '.json'), JSON.stringify(report, null, 2) + '\n');
}

app.setPath('userData', process.env.SYSTEM_PROFILE); app.setPath('sessionData', process.env.SYSTEM_PROFILE);
app.commandLine.appendSwitch('disable-background-networking');
// Packaged Electron ignores NODE_OPTIONS --require. Install the main guard
// explicitly and pass the backend preload as a Node CLI argument below.
require(process.env.SYSTEM_OFFLINE_PRELOAD);
app.on('session-created', bucket => bucket.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, done) => {
  done({ cancel: !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(details.url).hostname) });
}));
app.on('browser-window-created', (_event, created) => { if (!win) win = created; });
const originalLoad = Module._load;
const mainFile = process.env.SYSTEM_APP_MAIN || path.join(ROOT, 'electron/main.cjs');
Module._load = function (name, parent, isMain) {
  // An isolated gate scenario drives the real coordinator and production main
  // listeners without creating/downloading/launching an installer.
  if (phase === 'update-gates' && name === './app-update-desktop.cjs' && parent?.filename === mainFile) {
    return { installAppUpdate(options) {
      const { createAutoQuitCoordinator } = require(path.join(path.dirname(mainFile), 'app-update-quit.cjs'));
      let ending = false;
      const coordinator = createAutoQuitCoordinator({
        manager: { autoInstallCandidate: () => ({ ok: update.eligible }) },
        preflight: async () => { update.preflights++; if (update.wait) await new Promise(resolve => { update.release = resolve; }); return { ok: true }; },
        install: async () => { update.installs++; coordinator.markQuitIssued(); await options.quit(); return { ok: true }; },
        quit: options.quit, isRecovering: () => update.veto, isSystemShutdown: () => ending,
      });
      return { ...coordinator, markSystemSessionEnding() { ending = true; } };
    } };
  }
  if (name === 'node:child_process' && parent?.filename === mainFile) {
    const native = originalLoad.call(this, name, parent, isMain);
    return { ...native, spawn(command, args, options) {
      const backend = args?.[0] === path.join(path.dirname(mainFile), 'server.cjs') || args?.[0] === path.join(ROOT, 'server.js');
      if (backend) {
        report.offlineBackendPreloads = (report.offlineBackendPreloads || 0) + 1;
        return native.spawn(command, ['--require', process.env.SYSTEM_OFFLINE_PRELOAD, ...args], options);
      }
      return native.spawn(command, args, options);
    } };
  }
  if (name === 'electron' && parent?.filename === mainFile) return { ...electron,
    Tray: function (...args) {
      const tray = new electron.Tray(...args); trays.push(tray); report.trayCreated++;
      const setMenu = tray.setContextMenu.bind(tray);
      tray.setContextMenu = menu => { tray.fixtureMenu = menu; return setMenu(menu); };
      return tray;
    },
    powerSaveBlocker: {
      start(type) { const id = powerSaveBlocker.start(type); nativeIds.add(id); report.powerCalls.push({ operation: 'start', type, id }); return id; },
      stop(id) { report.powerCalls.push({ operation: 'stop', id }); return powerSaveBlocker.stop(id); },
      isStarted: id => powerSaveBlocker.isStarted(id),
    },
  };
  return originalLoad.call(this, name, parent, isMain);
};
require(mainFile); Module._load = originalLoad;
// Product cleanup listeners were registered first; observe their native results.
app.on('will-quit', () => {
  clearTimeout(deadline);
  if (!exitReady) { report.failed++; report.errors.push('unexpected_exit'); }
  if (phase === 'pending-save-quit') {
    report.savedBeforeExit = JSON.parse(fs.readFileSync(path.join(process.env.SYSTEM_PROFILE, 'system-settings.json'), 'utf8')).keepAwake === true;
    if (!report.savedBeforeExit) { report.failed++; report.errors.push('pref_not_committed_before_exit'); }
    else check('the one deferred real quit happens after atomic commit', true);
  }
  if (phase === 'update-gates') {
    report.update = { preflights: update.preflights, fixtureInstalls: update.installs };
    if (update.installs !== 1) { report.failed++; report.errors.push('update_exit_not_reached'); }
    else check('update-authorized quit reaches real app exit exactly once', true);
  }
  saveReport();
});
process.on('exit', () => { try { saveReport(); } catch { /* parent reports missing evidence */ } });

async function main() {
  await app.whenReady();
  await until(() => win && !win.isDestroyed() && win.webContents.getURL() === origin + '/', 'production main window');
  await until(() => read("document.querySelector('#connText')?.textContent.includes('已连接')"), 'backend/Pi connected');
  report.sandbox = win.webContents.getLastWebPreferences();
  check('normal sandbox, context isolation and no Node integration', report.sandbox.sandbox && report.sandbox.contextIsolation && !report.sandbox.nodeIntegration && !app.commandLine.hasSwitch('no-sandbox'));
  // Fixed state only, not preload internals or command lines in evidence.
  report.sandbox = { sandbox: report.sandbox.sandbox, contextIsolation: report.sandbox.contextIsolation, nodeIntegration: report.sandbox.nodeIntegration, backgroundThrottling: report.sandbox.backgroundThrottling };
  check('fetch, DNS and raw socket guards active in main and exactly one backend', globalThis.__systemOfflineGuard === true
    && globalThis.__systemRawNetworkGuard === true && report.offlineBackendPreloads === 1
    && fs.readFileSync(path.join(world, phase + '-offline-backend'), 'utf8') === 'active-raw');
  win.webContents.on('render-process-gone', (_event, detail) => { report.failed++; report.errors.push(detail.reason); });
  check('production bridge only exposes named system operations', await read("typeof require==='undefined' && !window.ipcRenderer && Object.keys(window.piGuiDesktop.systemSettings).sort().join(',')==='clearCache,measureCache,migrateData,pickDataDirectory,quit,saveNetwork,set,state,testNetwork'"));
  const initial = (await state()).snapshot;
  if (phase === 'exercise') {
    check('first run defaults off/off/quit without creating preferences', initial.effective.keepAwake === false && initial.effective.preventDisplaySleep === false && initial.effective.closeBehavior === 'quit' && !fs.existsSync(path.join(process.env.SYSTEM_PROFILE, 'system-settings.json')));
    await read("document.querySelector('#navGlobalMore').click();document.querySelector('#navSystem').click()");
    await until(() => read("document.querySelector('.system-path')?.textContent.includes('data-中文')"), 'real resolved storage path');
    check('server storage is actual override, not profile/project/Pi directory', await read(`document.querySelector('.system-path').textContent===${JSON.stringify(process.env.SYSTEM_DATA)} && document.querySelector('.system-path-detail').textContent.includes('PI_GUI_DATA')`));
    await require('./system-settings-visual.cjs').runSystemVisual({ win, read, until, click, key, check, out, report });
    await set('preventDisplaySleep', true);
    let effective = (await state()).snapshot.effective;
    check('two real native independent blockers are active', effective.keepAwake && effective.preventDisplaySleep && report.powerCalls.filter(c => c.operation === 'start').length === 2);
    const displayId = report.powerCalls.find(call => call.type === 'prevent-display-sleep').id;
    await set('keepAwake', false);
    check('turning off app blocker preserves native display blocker', powerSaveBlocker.isStarted(displayId) && (await state()).snapshot.effective.preventDisplaySleep === true);
    await set('keepAwake', true);
    check('power saved outside PI_GUI_DATA and persisted in profile', !fs.existsSync(path.join(process.env.SYSTEM_DATA, 'system-settings.json')) && JSON.parse(fs.readFileSync(path.join(process.env.SYSTEM_PROFILE, 'system-settings.json'))).keepAwake);

    // Seed one cacheable loopback document and storage in the EXACT production
    // Browser Session. Cookies/DOM storage are deliberately not cache candidates.
    const partition = require('../../electron/browser-policy.cjs').PARTITION;
    const bucket = session.fromPartition(partition);
    check('production Browser cache bucket is non-persistent and pathless', !bucket.isPersistent() && bucket.getStoragePath() === null);
    pageServer = http.createServer((req, res) => {
      if (req.url === '/asset.js') { res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public,max-age=3600' }); res.end('window.cacheFixture=true;' + '/* HTTP cache fixture */'.repeat(20000)); return; }
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'public,max-age=3600' }); res.end('<!doctype html><title>Offline cache fixture</title><script src="/asset.js"></script><h1>Offline cache</h1>');
    });
    await new Promise(resolve => pageServer.listen(0,'127.0.0.1',resolve));
    const cacheOrigin = 'http://127.0.0.1:' + pageServer.address().port;
    cacheWindow = new BrowserWindow({ show: false, webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await cacheWindow.loadURL(cacheOrigin);
    await cacheWindow.webContents.executeJavaScript(`(async()=>{document.cookie='fixture=preserve;SameSite=Lax';localStorage.setItem('fixture','preserve');const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('fixture',1);r.onupgradeneeded=()=>r.result.createObjectStore('values');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('db'))});await new Promise((resolve,reject)=>{const tx=db.transaction('values','readwrite');tx.objectStore('values').put('preserve','fixture');tx.oncomplete=resolve;tx.onerror=()=>reject(Error('write'))});db.close()})()`);
    await until(async () => (await bucket.getCacheSize()) > 0, 'actual cache seeded');
    // Reopening the production page starts its own native multi-bucket scan.
    // Wait for its real completion instead of racing a second IPC against it.
    await until(() => read("!document.querySelector('#system-cache-actions button:first-child').disabled"), 'initial native cache statistics complete');
    let preview;
    // Earlier visual pages can have an authorized scan finishing after unmount;
    // Chromium can also finish writing its HTTP tree during a strict scan. Only
    // retry read-only measurements, bounded to three completed attempts. Never
    // turn unknown disk bytes into zero or skip the original equality assertion.
    const measurements = []; let completed = 0;
    await until(async () => {
      preview = await read('window.piGuiDesktop.systemSettings.measureCache()');
      if (preview.code === 'cache_busy') return false;
      measurements.push(preview); completed++;
      return preview.ok || completed >= 3 || preview.code !== 'cache_measure_failed';
    }, 'stable main cache statistics after visual page scans');
    report.cacheMeasurements = measurements;
    report.cacheBefore = preview;
    check('real getCacheSize matches its exact P2 memory bucket', preview.ok && preview.bytes > 0 && preview.buckets.find(b => b.id === 'browser-memory-http-cache').memoryBytes === await bucket.getCacheSize());
    let clear;
    for (let n = 0; n < 3; n++) {
      clear = await read('(async()=>{const a=window.piGuiDesktop.systemSettings;const p=await a.measureCache();return a.clearCache(p.ticket)})()');
      if (clear.code !== 'cache_changed') break;
      await sleep(1500);
    }
    report.cacheAfter = clear;
    check('real Chromium memory bucket clears and independently remeasures zero; disk result is truthful', ['cleared', 'partial'].includes(clear.status) && clear.buckets.find(b => b.id === 'browser-memory-http-cache').memoryBytes === 0 && await bucket.getCacheSize() === 0);
    const preserved = await cacheWindow.webContents.executeJavaScript(`(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('fixture');r.onsuccess=()=>resolve(r.result)});const value=await new Promise(resolve=>{const r=db.transaction('values').objectStore('values').get('fixture');r.onsuccess=()=>resolve(r.result)});db.close();return document.cookie==='fixture=preserve'&&localStorage.getItem('fixture')==='preserve'&&value==='preserve'})()`);
    check('real cookies, LocalStorage and IndexedDB preserved', preserved);
    check('untrusted Browser page has no desktop/preload bridge', await cacheWindow.webContents.executeJavaScript("typeof window.piGuiDesktop==='undefined' && typeof require==='undefined'"));
    // Reseed the same real Chromium bucket for the complete pointer/dialog path.
    await cacheWindow.loadURL(cacheOrigin + '/pointer');
    await until(async () => (await bucket.getCacheSize()) > 0, 'real pointer cache seed');
    await click('#system-cache-actions button:first-child');
    await until(() => read("!document.querySelector('#system-cache-actions .danger').disabled"), 'pointer cache available');
    const pointerBytes = await bucket.getCacheSize();
    await click('#system-cache-actions .danger');
    await until(() => read("!document.querySelector('#confirmLayer').hidden"), 'real cache confirmation');
    check('real cache confirmation states size and protected data', await read("document.querySelector('#confirmCard').textContent.includes('预计清理') && document.querySelector('#confirmCard').textContent.includes('聊天记录、设置、凭据、附件、模型和插件数据均会保留')"));
    await click('#confirmCard .modal-actions button:first-child');
    await until(() => read("document.querySelector('#confirmLayer').hidden && !document.querySelector('#system-cache-actions .danger').disabled"), 'pointer cancellation');
    check('pointer cancellation preserves native cache and returns usable focus', await bucket.getCacheSize() === pointerBytes && await read("document.activeElement===document.querySelector('#system-cache-actions .danger')"));
    await click('#system-cache-actions .danger');
    await until(() => read("!document.querySelector('#confirmLayer').hidden"), 'Escape confirmation after fresh native statistics');
    await key('Escape');
    await until(() => read("document.querySelector('#confirmLayer').hidden && !document.querySelector('#system-cache-actions .danger').disabled"), 'Escape cancellation');
    check('real Escape cancels cache deletion without clearing', await bucket.getCacheSize() === pointerBytes);
    await click('#system-cache-actions .danger');
    await until(() => read("!document.querySelector('#confirmLayer').hidden"), 'pointer confirmation retry');
    await click('#confirmCard .modal-actions .danger');
    await until(async () => await bucket.getCacheSize() === 0 && await read("!document.querySelector('#system-cache-actions button:first-child').disabled"), 'pointer clear result');
    check('pointer result reports verified success or a specifically identified partial clear', await read("(()=>{const e=document.querySelector('#system-cache-feedback');return (e.textContent.startsWith('缓存已清理。')||e.textContent.startsWith('缓存已清理；未确认磁盘占用下降'))&&!e.classList.contains('is-error') || e.textContent.startsWith('清理未完全确认。')&&e.classList.contains('is-error')})()"));
    report.pointerCache = { beforeBytes: pointerBytes, afterBytes: await bucket.getCacheSize() };
    check('real pointer confirmation clears its memory bucket, remeasures and refocuses the valid remaining action', report.pointerCache.afterBytes === 0 && await read("(()=>{const a=document.querySelector('#system-cache-actions');return document.querySelector('#confirmLayer').hidden && document.activeElement===a.querySelector(a.querySelector('.danger').disabled?'button:first-child':'.danger')})()"));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, 'system-cache-pointer-success.png'), image.toPNG());
    report.screenshots.push({ file: 'system-cache-pointer-success.png', fixture: 'real-native-cache-pointer', pixels: image.getSize() });
    cacheWindow.destroy(); cacheWindow = null; await new Promise(resolve => pageServer.close(resolve)); pageServer = null;
    await click('#system-cache-actions button:first-child');
    await until(() => read("!document.querySelector('#system-cache-actions button:first-child').disabled"), 'remeasured multi-bucket UI');
    const emptyPreview = await read('window.piGuiDesktop.systemSettings.measureCache()');
    check('actual empty memory bucket is shown separately; aggregate delete follows actual remaining capacity', emptyPreview.buckets.find(b => b.id === 'browser-memory-http-cache').status === 'empty' && await read(`document.querySelector('#system-cache-size').textContent.includes('内存 0 B') && !document.querySelector('#system-cache-actions button').disabled && (${JSON.stringify(emptyPreview.status)}!=='empty' || document.querySelector('#system-cache-actions .danger').disabled)`));

    await set('closeBehavior', 'tray'); await set('closeBehavior', 'tray');
    check('one native Tray and fixed native menu after repeated enable', trays.length === 1 && !trays[0].isDestroyed() && trays[0].fixtureMenu.items.filter(item => item.type !== 'separator').map(item => item.label).join('|') === '显示 pi-GUI|退出应用');
    await read("document.querySelector('#settingsReturn').click()");
    const runtime = await api({ action: 'open-session', args: { project: process.env.PI_CWD, requestId: require('node:crypto').randomUUID() } });
    report.runtimeOpen = { ok: runtime.ok, code: runtime.code };
    assert.equal(runtime.ok, true, 'real ordinary Runtime starts: ' + (runtime.code || 'no_code'));
    let runtimeOwner;
    await until(async () => { const snap = await api(); runtimeOwner = snap.items.find(item => item.conversationId === runtime.conversationId)?.owner; return runtimeOwner?.sessionId; }, 'Runtime ready');
    assert.equal((await api({ action: 'command', owner: runtimeOwner, command: { type: 'prompt', message: 'SYSTEM_APPROVAL' } })).ok, true);
    await read("(async()=>{const a=await import('/api.js');await a.sendCommand({type:'prompt',message:'SYSTEM_STREAM'})})()");
    await until(() => read("import('/state.js').then(({S})=>S.streaming && [...S.blocks.values()].some(block=>block.text.includes('fixture-tick-')))"), 'classic streaming delta');
    const streamBefore = await read("import('/state.js').then(({S})=>S.seq)");
    const identity = await read("import('/state.js').then(({S})=>({owner:S.legacyOwner,run:S.bridgeRun}))");
    const traceBefore = trace();
    const hasApproval = async () => (await api({ action: 'events', owner: runtimeOwner, cursor: 0 })).approvals.some(request => request.id === 'system-approval' && request.method === 'confirm');
    await until(hasApproval, 'authoritative Runtime approval before hide');
    await read("window.systemRendererIdentity={nonce:crypto.randomUUID(),chat:document.querySelector('#chatView'),ticks:0};window.systemTimer=setInterval(()=>systemRendererIdentity.ticks++,50);document.querySelector('#input').value='Unsent retained draft';");
    const nonce = await read('systemRendererIdentity.nonce');
    const wcId = win.webContents.id, hwnd = win.getNativeWindowHandle().toString('hex');
    win.close(); await until(() => !win.isVisible(), 'native X hides');
    await sleep(650);
    check('native close hides the same window and keeps renderer timers running', !win.isDestroyed() && win.webContents.id === wcId && win.getNativeWindowHandle().toString('hex') === hwnd && await read('systemRendererIdentity.ticks>=5'));
    check('classic task and Runtime approval owner survive hidden state', JSON.stringify((await read("import('/state.js').then(({S})=>({owner:S.legacyOwner,run:S.bridgeRun}))"))) === JSON.stringify(identity) && await read("import('/state.js').then(({S})=>S.streaming)") && (await api()).items.some(item => item.owner?.runtimeId === runtimeOwner.runtimeId && item.owner?.runtimeGeneration === runtimeOwner.runtimeGeneration));
    check('hiding sends no abort/restart/approval decision to either actual Pi fixture', !trace().slice(traceBefore.length).some(row => ['abort','extension_ui_response','start'].includes(row.type)));
    check('live SSE deltas continue while the original renderer is hidden', await read(`import('/state.js').then(({S})=>S.seq>${streamBefore} && [...S.blocks.values()].some(block=>block.text.includes('fixture-tick-')))`));
    check('both real power requests remain active while hidden', (await state()).snapshot.effective.keepAwake && (await state()).snapshot.effective.preventDisplaySleep);
    check('authoritative Runtime approval remains pending while hidden', await hasApproval());
    trays[0].emit('click'); await until(() => win.isVisible(), 'native Tray click handler restores');
    check('Tray restores same DOM, draft and renderer identity', await read(`systemRendererIdentity.nonce===${JSON.stringify(nonce)} && document.querySelector('#chatView')===systemRendererIdentity.chat && document.querySelector('#input').value==='Unsent retained draft'`));
    win.close(); app.emit('second-instance', {}, [], world); await until(() => win.isVisible(), 'existing second-instance handler restores');
    check('second-instance restore never duplicates the main window or Tray', BrowserWindow.getAllWindows().length === 1 && trays.length === 1);
    const runtimePending = await api({ action: 'events', owner: runtimeOwner, cursor: 0 });
    check('Runtime approval remains pending in authoritative event history', runtimePending.approvals.some(request => request.id === 'system-approval' && request.method === 'confirm') && !trace().some(row => row.type === 'extension_ui_response'));
    await read("(async()=>{const a=await import('/api.js');await a.sendCommand({type:'abort'})})()");
    await until(() => read("import('/state.js').then(({S})=>!S.streaming)"), 'explicit classic Stop');
    await api({ action: 'command', owner: runtimeOwner, command: { type: 'extension_ui_response', id: 'system-approval', confirmed: false } });
    await api({ action: 'close', owner: runtimeOwner });
    // An actual server preflight opens the existing editor; hide must not clear
    // its target or unsent text. No resend/native history mutation is requested.
    await read("document.querySelector('.message-edit').click()");
    await until(() => read("!!document.querySelector('textarea.message-edit-input')"), 'real edit preflight');
    await read("window.retainedEditor=document.querySelector('textarea.message-edit-input');retainedEditor.value='Unsent edit fixture';");
    win.close(); await sleep(200); trays[0].emit('click');
    check('existing message editor target and text remain mounted through hide', await read("document.querySelector('textarea.message-edit-input')===retainedEditor && retainedEditor.value==='Unsent edit fixture'"));
    await read("document.querySelector('.message-edit-cancel').click();clearInterval(systemTimer)");
    await readyToExit();
    // Real settings quit path, not app.exit() or bypassing maintenance.
    await read('window.piGuiDesktop.systemSettings.quit()');
  } else if (phase === 'update-gates') {
    await set('closeBehavior', 'tray');
    update.veto = true; win.close();
    check('update recovery veto prevents close before tray handling', win.isVisible() && !win.isDestroyed() && update.preflights === 0);
    update.veto = false; win.close();
    await until(() => !win.isVisible(), 'update eligible but ordinary close hides');
    check('a ready candidate does not turn a tray hide into installation', update.preflights === 0 && update.installs === 0);
    trays[0].emit('click');
    await until(() => win.isVisible(), 'restore during update fixture');
    update.wait = true; app.quit();
    await until(() => update.release, 'explicit quit reaches update preflight');
    win.close();
    check('active update preflight still vetoes ordinary close', win.isVisible() && !win.isDestroyed() && update.preflights === 1 && update.installs === 0);
    await readyToExit();
    update.release();
  } else if (phase === 'visual-states') {
    await require('./system-settings-states.cjs').runSystemStates({ BrowserWindow, origin, out, report, check });
    await readyToExit(); app.quit();
  } else if (phase === 'restart-tray-quit') {
    check('restart restores both native blockers and tray policy', initial.effective.keepAwake && initial.effective.preventDisplaySleep && initial.effective.closeBehavior === 'tray' && nativeIds.size === 2 && trays.length === 1);
    win.close(); await until(() => !win.isVisible(), 'restart hidden');
    trays[0].emit('double-click'); await until(() => win.isVisible(), 'native double-click restore');
    await readyToExit(); trays[0].fixtureMenu.items.find(item => item.label === '退出应用').click();
  } else if (phase === 'default-close') {
    await set('closeBehavior', 'quit'); await set('keepAwake', false); await set('preventDisplaySleep', false);
    check('disabling tray destroys native icon without leaving hidden UI', trays[0].isDestroyed() && win.isVisible());
    await readyToExit(); win.close();
  } else if (phase === 'ctrl-q') {
    check('saved quit mode and power-off survive another real app restart', initial.effective.closeBehavior === 'quit' && !initial.effective.keepAwake && !initial.effective.preventDisplaySleep);
    await set('closeBehavior', 'tray'); await readyToExit(); await key('q', ['control']);
  } else if (phase === 'pending-save-quit') {
    await set('closeBehavior', 'quit'); await set('keepAwake', false);
    const target = path.join(process.env.SYSTEM_PROFILE, 'system-settings.json');
    const io = require('node:fs/promises'), rename = io.rename;
    let release;
    io.rename = async (...args) => {
      if (args[1] === target) await new Promise(resolve => { release = resolve; });
      return rename(...args);
    };
    try {
      await read('void window.piGuiDesktop.systemSettings.set("keepAwake",true)');
      await until(() => release, 'atomic save paused before rename');
      win.close();
      check('ordinary close preserves main window while atomic preferences save is pending', !win.isDestroyed());
      app.quit();
      check('explicit app quit also waits for the same pending atomic save', !win.isDestroyed());
      await readyToExit();
      release();
      await until(() => JSON.parse(fs.readFileSync(target, 'utf8')).keepAwake === true, 'pending preference committed before quit');
    } finally { io.rename = rename; }
  } else if (phase === 'session-end') {
    await set('closeBehavior', 'tray');
    check('tray restored for Windows session-end simulation', initial.effective.closeBehavior === 'tray');
    await set('keepAwake', true); await set('preventDisplaySleep', true);
    win.emit('query-session-end', { preventDefault() { throw Error('must not veto Windows shutdown'); } });
    win.close(); await until(() => !win.isVisible(), 'cancelled shutdown still permits tray hide');
    trays[0].emit('click'); await until(() => win.isVisible(), 'cancelled shutdown still permits restore');
    check('cancelled Windows shutdown query preserves tray and settings IPC', (await state()).ok && (await set('keepAwake', true)).ok);
    await readyToExit();
    win.emit('session-end', {});
    check('Windows session-end handler releases real native blockers and Tray', [...nativeIds].every(id => !powerSaveBlocker.isStarted(id)) && trays.every(tray => tray.isDestroyed()));
    win.destroy(); app.quit();
  }
}

// P2 revalidates disk allocation before and after each native clear. Keep the
// scenario bounded while allowing the real Windows metadata probes to finish.
deadline = setTimeout(() => { report.failed++; report.errors.push('bounded_scenario_timeout'); console.error('System desktop timeout: ' + phase); app.exit(1); }, 240000);
main().catch(async error => {
  report.failed++; console.error(error.stack); report.errors.push(error.message);
  if (win && !win.isDestroyed()) { try { fs.writeFileSync(path.join(out, phase + '-failure.png'), (await win.webContents.capturePage()).toPNG()); } catch { /* no fake screenshot */ } }
  try { await readyToExit(); } catch { /* parent reports timeout */ }
  clearTimeout(deadline); app.exit(1);
});
