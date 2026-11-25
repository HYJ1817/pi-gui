'use strict';
// Test-owned main, NOT electron/main.cjs. Real server/renderer/CSS/preload.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, ipcMain, session, nativeTheme, clipboard } = require('electron');
const SOURCE = path.resolve(__dirname, '../..');
const ROOT = path.resolve(process.env.PREVIEW_APP_ROOT || SOURCE);
// build-app flattens the desktop modules into resources/app.
const DESKTOP = fs.existsSync(path.join(ROOT, 'electron/preload.cjs')) ? path.join(ROOT, 'electron') : ROOT;
const world = process.env.PREVIEW_DESKTOP_WORLD, out = process.env.PREVIEW_DESKTOP_OUTPUT;
const repo = path.join(world, 'repo');
const rows = [], screenshots = [], geometry = [], timings = [], notes = [];
const diagnostics = { consoleErrors: 0, consoleCodes: [], consoleEvents: [], rendererGone: 0, blockedNonLoopback: 0 };
let scenario = 'boot';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win, backend, origin, theme, failed = 0;
const start = Date.now();
app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('disable-background-networking');
const read = code => win.webContents.executeJavaScript(code, true);
function check(name, value, details) {
  const ok = !!value; rows.push({ name, passed: ok, ...(details ? { details } : {}) });
  if (!ok) failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name); return ok;
}
async function until(action, label, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await action()) return; await sleep(50); }
  throw Object.assign(new Error('timeout'), { testLabel: label });
}
async function shot(name) {
  await sleep(160);
  const image = await win.capturePage();
  assert.ok(!image.isEmpty(), 'capture must contain pixels');
  fs.writeFileSync(path.join(out, name + '.png'), image.toPNG()); screenshots.push(name + '.png');
}
async function group(name, action) {
  const before = Date.now(); scenario = name;
  try { await action(); }
  catch (error) {
    check(name + ' completes', false, { error: error.name, stage: error.testLabel || 'assertion-or-interaction' });
    if (win && !win.isDestroyed()) {
      try {
        const state = await read("(()=>{const side=document.querySelector('.files-sidebar'),surface=document.querySelector('.files-surface'),frame=document.querySelector('.fp-html-frame');return {kind:'failure-structure',scenario:" + JSON.stringify(name) + ",sidebar:side?{hidden:side.hidden,width:side.getBoundingClientRect().width}:null,surface:surface?{narrow:surface.classList.contains('files-narrow'),treeOpen:surface.classList.contains('files-tree-open')}:null,html:frame?{sourceImages:(frame.srcdoc.match(/<img\\b/g)||[]).length,blobSources:(frame.srcdoc.match(/src=\"blob:/g)||[]).length}:null}})()");
        notes.push(state); await shot('failure-' + name);
      } catch {}
    }
  }
  timings.push({ name, elapsedMs: Date.now() - before });
}
async function click(selector) {
  win.focus(); win.webContents.focus();
  const point = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e) return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:r.width,h:r.height}})()`);
  if (!(point && point.w > 0 && point.h > 0)) throw Object.assign(new Error('invisible-click'), { testLabel: 'click:' + selector });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await sleep(80);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(70);
}
async function type(selector, value) {
  await click(selector);
  assert.ok(await read(`document.activeElement===document.querySelector(${JSON.stringify(selector)})&&!document.activeElement.disabled`), 'trusted click must focus the requested input');
  await key('A', ['control']); await win.webContents.insertText(value); await sleep(100);
  assert.ok(await read(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`), 'trusted input must reach the requested field');
}
async function value(selector, next) {
  await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(next)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(80);
}
async function open(name, expected, extra = {}) {
  const before = Date.now();
  await read(`Promise.all([import('/files-panel.js'),import('/state.js')]).then(([f,{S}])=>{f.openFileReference({path:${JSON.stringify(name)},name:${JSON.stringify(path.basename(name))},cwd:S.cwd,...${JSON.stringify(extra)}});return true})`);
  if (expected) await until(() => read(`document.querySelector('.files-preview-path')?.textContent===${JSON.stringify(name)}&&!!document.querySelector(${JSON.stringify(expected)})&&!document.querySelector('.fp-loading')`), 'open-' + name, 22000);
  timings.push({ name: 'open:' + name, elapsedMs: Date.now() - before });
}
async function main() {
  assert.ok(world && path.isAbsolute(world));
  assert.ok(!app.commandLine.hasSwitch('no-sandbox') && !app.commandLine.hasSwitch('remote-debugging-port'));
  app.setPath('userData', path.join(world, 'electron')); fs.mkdirSync(out, { recursive: true });
  const { shim, data, home } = await require('./file-preview-desktop-data.cjs')({ SOURCE, world, repo });
  const socket = require('node:net').createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve)); origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), PI_GUI_DATA: data, PI_CWD: repo, PI_BIN: shim, PI_GUI_TOKEN: '', PI_GUI_OPEN: '0', PI_GUI_OFFLINE: '1', PI_OFFLINE: '1', PI_CODING_AGENT_DIR: path.join(home, 'agent') };
  delete env.ELECTRON_RUN_AS_NODE;
  const server = fs.existsSync(path.join(ROOT, 'server.cjs')) ? 'server.cjs' : 'server.js';
  backend = spawn(process.env.PREVIEW_NODE_EXECUTABLE, [path.join(ROOT, server), '--preview-desktop-fixture', world], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  backend.stdout.resume(); backend.stderr.resume();
  await until(async () => { try { return (await (await fetch(origin + '/api/health')).json()).app === 'pi-gui'; } catch { return false; } }, 'production-health', 20000);
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, done) => {
    const host = new URL(details.url).hostname, cancel = !['127.0.0.1', 'localhost', '[::1]'].includes(host);
    if (cancel) diagnostics.blockedNonLoopback++; done({ cancel });
  });
  theme = require(path.join(DESKTOP, 'theme.cjs')).createDesktopTheme({ ipcMain, nativeTheme, getWindow: () => win, origin, preferenceFile: path.join(world, 'theme.json') }); theme.register();
  win = new BrowserWindow({ title: 'Offline unified file preview qualification', width: 1320, height: 820, useContentSize: true, show: true, autoHideMenuBar: true, titleBarStyle: 'hidden', ...theme.windowOptions(),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(DESKTOP, 'preload.cjs') } });
  win.webContents.on('render-process-gone', () => diagnostics.rendererGone++);
  win.webContents.on('console-message', details => {
    if (details.level !== 'error') return; diagnostics.consoleErrors++;
    const message = details.message || '';
    const code = /^ResizeObserver loop (?:completed with undelivered notifications\.|limit exceeded)/.test(message) ? 'resize-observer-loop' : /Unrecognized Content-Security-Policy directive ['"]navigate-to['"]/i.test(message) ? 'csp-unsupported-navigation-directive' : /The specified value .* cannot be parsed, or is out of range\./.test(message) ? 'invalid-native-input-value' : /preventDefault.*passive|passive.*preventDefault/i.test(message) ? 'passive-listener-prevent-default' : /Not allowed to load local resource/.test(message) ? 'local-resource-denied' : /Content Security Policy|violates.*directive|Refused to load/.test(message) ? 'csp-denied' : /Blocked script execution|script execution.*disabled|script.*blocked/i.test(message) ? 'sandbox-script-denied' : /ERR_FILE_NOT_FOUND/.test(message) ? 'resource-not-found' : /AbortException|Worker was terminated/.test(message) ? 'worker-cancelled' : 'other-error';
    diagnostics.consoleCodes.push(code);
    // Structure only: no raw message, URL query, document name or payload.
    const sourceModule = details.sourceId === origin + '/' ? 'document' : ['file-preview/pdf.js', 'file-preview/html.js', 'vendor/file-preview/pdf.js', 'vendor/file-preview/pdf.worker.mjs'].find(file => details.sourceId === origin + '/' + file) || 'other';
    if (diagnostics.consoleEvents.length < 32) diagnostics.consoleEvents.push({ scenario, code, sourceModule, messageLength: message.length, line: Number.isSafeInteger(details.lineNumber) ? details.lineNumber : 0, sourceKind: String(details.sourceId || '').startsWith('blob:') ? 'blob' : String(details.sourceId || '').startsWith(origin + '/') ? 'app' : 'other', uncaught: /Uncaught/.test(message), rejectedPromise: /in promise/.test(message), resourceLoad: /Failed to load resource/.test(message), features: ['sandbox', 'script', 'blocked', 'worker', 'font', 'fetch', 'network', 'exception', 'abort', 'budget', 'terminated', 'stream', 'canvas', 'cancel', 'error', 'unrecognized', 'csp', 'textlayer', 'deprecated', 'undefined', 'null', 'scale', 'origin', 'denied', 'failed', 'invalid', 'api', 'destroyed', 'content', 'policy'].filter(word => message.toLowerCase().includes(word)) });
  });
  await win.loadURL(origin);
  await until(() => read("document.querySelector('#connText')?.textContent.includes('已连接')"), 'renderer-connect', 20000);
  await until(() => read("import('/state.js').then(({S})=>!!(S.legacyOwner?.workspaceId&&S.legacyOwner?.workspaceEpoch&&S.legacyOwner?.sessionId&&S.legacyOwner?.backendInstance))"), 'production-owner');
  const preferences = win.webContents.getLastWebPreferences();
  check('normal sandbox and isolation with production preload', preferences.sandbox === true && preferences.contextIsolation === true && preferences.nodeIntegration === false && preferences.webSecurity !== false);
  check('renderer has no Node globals and actual desktop preload API', await read("typeof require==='undefined'&&typeof process==='undefined'&&!!window.piGuiDesktop"));
  check('real backend owner belongs to temporary Git fixture', await read(`import('/state.js').then(({S})=>S.cwd===${JSON.stringify(repo)}&&Number.isInteger(S.bridgeRun))`));
  const tools = { fs, path, assert, ROOT, SOURCE, world, repo, out, rows, screenshots, geometry, timings, notes, diagnostics, clipboard, check, read, sleep, until, shot, click, key, type, value, open, get win() { return win; } };
  await require('./file-preview-desktop-selection.cjs')(tools, group);
  if (process.env.PREVIEW_SELECTION_ONLY === '1') {
    check('no renderer crash during selection qualification', diagnostics.rendererGone === 0);
    return;
  }
  await require('./file-preview-desktop-scenarios.cjs')(tools, group);
  await require('./file-preview-desktop-formats.cjs')(tools, group);
  await group('layout', async () => {
    await open('long-lines.js', '.fp-text-rows');
    if (!await read("document.querySelector('#rightPane').dataset.maximized==='true'")) await click('#workPanelMaximize');
    for (const width of [1320, 700]) for (const mode of ['dark', 'light']) {
      win.setContentSize(width, width === 700 ? 600 : 820);
      check('production theme API ' + mode + ' at ' + width, await read(`import('/theme.js').then(m=>m.setThemePreference(${JSON.stringify(mode)}))`));
      await sleep(260);
      const measured = await read(`(${require('./file-preview-desktop-geometry.cjs').toString()})()`);
      geometry.push(measured);
      check('bounded visible preview ' + width + '-' + mode, measured.docOverflow <= 1 && measured.preview.width > 200 && measured.preview.x >= 0 && measured.preview.x + measured.preview.width <= measured.width + 1, measured);
      check('common maximize fills available workspace and preserves sidebar ' + width + '-' + mode,
        Math.abs(measured.pane.width - measured.expectedWidth) <= 2 && Math.abs(measured.surface.width - measured.body.width) <= 2 &&
        Math.abs(measured.surface.x - measured.body.x) <= 2 && Math.abs(measured.pane.right - measured.app.right) <= 2 &&
        measured.chatPresent && measured.chatInert, measured);
      await shot('text-' + width + '-' + mode);
    }
    check('many tabs overflow in narrow viewport with menu reachable', await read("document.querySelector('.files-tablist').scrollWidth>document.querySelector('.files-tablist').clientWidth&&document.querySelector('.files-tabs-menu').getBoundingClientRect().right<=innerWidth"));
    await click('.files-tabs-menu'); await key('Down'); await key('Return');
    check('trusted tab menu closes others and restores active tab focus', await read("document.querySelectorAll('.files-tab').length===1&&document.activeElement.matches('.files-tab-select')"));
    // The common maximized width excludes the existing project sidebar.
    // Restore the normal pane before qualifying its independent tree overlay.
    await click('#workPanelMaximize');
    await until(() => read("document.querySelector('.files-surface').classList.contains('files-narrow')"), 'restored-narrow-pane');
    check('restored narrow pane starts with tree off-canvas', await read("document.querySelector('.files-surface').getBoundingClientRect().width<620&&document.querySelector('.files-sidebar').hidden&&!document.querySelector('.files-main').inert"));
    await click('.files-tree-toggle'); await until(() => read("!document.querySelector('.files-sidebar').hidden"), 'narrow-tree');
    check('narrow tree makes preview inert', await read("document.querySelector('.files-main').inert"));
    await key('Escape');
    check('Escape closes tree and restores trigger focus', await read("document.querySelector('.files-sidebar').hidden&&document.activeElement.matches('.files-tree-toggle')"));
    await key('Tab');
    check('trusted keyboard advances focus', await read("document.activeElement!==document.body&&document.activeElement!==document.querySelector('.files-tree-toggle')"));
    win.setContentSize(1320, 820); await sleep(200);
    await click('#workPanelMaximize');
    await until(() => read("document.querySelector('#rightPane').dataset.maximized==='true'"), 'remaximize-wide-pane');
    const scaleBefore = await read("parseFloat(getComputedStyle(document.querySelector('.fp-text-scroll')).fontSize)");
    await read("document.documentElement.style.setProperty('--font-scale','1.25')"); await sleep(180);
    const scaleAfter = await read("parseFloat(getComputedStyle(document.querySelector('.fp-text-scroll')).fontSize)");
    check('preview follows 125 percent font scale', scaleAfter > scaleBefore);
    await shot('text-font125'); await read("document.documentElement.style.removeProperty('--font-scale')");
    const before = await read("document.querySelector('.files-surface').getBoundingClientRect().width");
    await click('#workPanelMaximize'); await sleep(180);
    const restored = await read("document.querySelector('.files-surface').getBoundingClientRect().width");
    check('maximize restore returns original outer pane geometry', restored < before && !await read("document.querySelector('#rightPane').dataset.maximized==='true'"), { maximizedWidth: before, restoredWidth: restored });
    await shot('restored-outer-pane');
    const divider = await read("(()=>{const r=document.querySelector('#rightPane>.rp-resizer').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:divider.x,y:divider.y});
    win.webContents.sendInputEvent({type:'mouseMove',button:'left',x:divider.x-72,y:divider.y});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:divider.x-72,y:divider.y});
    await sleep(150);
    const resized = await read("document.querySelector('#rightPane').getBoundingClientRect().width");
    check('outer pane trusted resize changes geometry and keeps preview live', resized > restored + 20 && await read("!!document.querySelector('.fp-text-line')"), { before: restored, after: resized });
  });
  check('no renderer crash during integration', diagnostics.rendererGone === 0);
  check('PDF fit-width does not trigger a ResizeObserver layout loop', !diagnostics.consoleCodes.includes('resize-observer-loop'));
  notes.push({ kind: 'memory', metrics: app.getAppMetrics().map(item => ({ type: item.type, workingSetKB: item.memory.workingSetSize, peakWorkingSetKB: item.memory.peakWorkingSetSize })) });
}
async function cleanup() {
  theme?.dispose(); win?.destroy();
  if (backend?.exitCode === null) {
    const reply = new Promise(resolve => backend.once('message', resolve));
    backend.send({ type: 'app-update', action: 'prepare', id: 1 });
    assert.equal((await reply).ok, true, 'shutdown maintenance');
    backend.send({ type: 'app-update', action: 'shutdown', id: 2 });
    await until(() => backend.exitCode !== null, 'backend-shutdown', 15000);
  }
}
main().catch(async error => {
  check('main integration boot completes', false, { error: error.name, stage: error.testLabel || 'boot' });
  if (win && !win.isDestroyed()) { try { await shot('failure-boot'); } catch {} }
}).finally(async () => {
  fs.writeFileSync(path.join(world, 'ready-for-cleanup'), 'yes');
  try { await until(() => fs.existsSync(path.join(world, 'processes-observed')), 'parent-observation', 15000); await cleanup(); }
  catch (error) { check('clean shutdown', false, { error: error.name, stage: error.testLabel || 'shutdown' }); }
  const identityFiles = ['public/files-panel.js', 'public/files-tree.js', 'public/files-tabs.js', 'public/file-links.css', 'public/ui4-pane.css', 'public/file-preview/preview.css', 'public/file-preview/office.css', 'public/file-preview/media-archive.css', 'public/file-preview/index.js', 'public/file-preview/pdf.js', 'public/file-preview/office.js', 'public/file-preview/office-worker.js', 'public/file-preview/html.js', 'public/file-preview/text.js', 'electron/preload.cjs'];
  const identities = identityFiles.map(file => { const physical = file.startsWith('electron/') ? path.join(DESKTOP, file.slice('electron/'.length)) : path.join(ROOT, file); const bytes = fs.readFileSync(physical); return { file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }; });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ qualification: failed ? 'failed-normal-sandbox' : 'normal-sandbox', sandbox: true, passed: rows.filter(row => row.passed).length, failed, skipped: 0, rows, screenshots, geometry, timings, notes, diagnostics, elapsedMs: Date.now() - start,
    electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, platform: process.platform, appRoot: ROOT, inputKind: ROOT === SOURCE ? 'source' : 'explicit-app-root', identities,
    boundary: 'Test-owned BrowserWindow main; production server/renderer/CSS/preload; temporary Git and fake Pi; no external CDP; NOT actual packaged-main qualification',
    unverified: ['actual packaged electron/main.cjs startup (parent task)', 'external native dialog grant/revoke', 'late external revoke response', 'cross-session stale readiness', 'long-duration memory stability', 'OS window resize drag and DPI multi-monitor', 'full canonical npm test / CI'],
  }, null, 2) + '\n');
  app.exit(failed ? 1 : 0);
});
