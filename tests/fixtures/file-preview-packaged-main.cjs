'use strict';
/* Observation bootstrap around byte-identical production main/preload/backend.
 * Only the TEMP copy's manifest selects this file. No CDP, sandbox bypass,
 * product test hook, native-dialog substitution or model call. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const electron = require('electron');
const { app, session, clipboard } = electron;
const SOURCE = path.resolve(__dirname, '../..');
const ROOT = process.env.PREVIEW_APP_ROOT;
const world = process.env.PREVIEW_DESKTOP_WORLD, out = process.env.PREVIEW_DESKTOP_OUTPUT;
const repo = path.join(world, 'repo'), origin = 'http://127.0.0.1:' + process.env.PORT;
const rows = [], screenshots = [], notes = [], timings = [], geometry = [];
const diagnostics = { rendererGone: 0, blockedNonLoopback: 0, backendPreloads: 0 };
let win, failed = 0, exitReady = false;
const started = Date.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = code => win.webContents.executeJavaScript(code, true);
function check(name, value, details) {
  const passed = !!value;
  rows.push({ name, passed, ...(details ? { details } : {}) });
  if (!passed) failed++;
  console.log((passed ? 'PASS ' : 'FAIL ') + name);
  return passed;
}
async function until(test, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await test()) return; await sleep(50); }
  throw Object.assign(Error('qualification timeout'), { testLabel: label });
}
async function shot(name) {
  await sleep(160);
  const image = await win.capturePage(); assert.ok(!image.isEmpty());
  fs.writeFileSync(path.join(out, name + '.png'), image.toPNG()); screenshots.push(name + '.png');
}
async function group(name, action) {
  const at = Date.now();
  try { await action(); }
  catch (error) {
    check(name + ' completes', false, { type: error.name, stage: error.testLabel || 'interaction' });
    if (win && !win.isDestroyed()) await shot('failure-' + name).catch(() => {});
  }
  timings.push({ name, elapsedMs: Date.now() - at });
}
async function click(selector) {
  win.show(); win.focus(); win.webContents.focus();
  const point = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),width:r.width,height:r.height}})()`);
  assert.ok(point && point.width > 0 && point.height > 0, 'visible input target');
  const { x, y } = point;
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await sleep(80);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(70);
}
async function type(selector, text) {
  await click(selector);
  assert.ok(await read(`document.activeElement===document.querySelector(${JSON.stringify(selector)})&&!document.activeElement.disabled`), 'trusted click must focus the requested input');
  await key('A', ['control']); await win.webContents.insertText(text); await sleep(100);
  assert.ok(await read(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(text)}`), 'trusted input must reach the requested field');
}
async function value(selector, next) {
  await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(next)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(80);
}
async function open(name, expected, extra = {}) {
  await read(`Promise.all([import('/files-panel.js'),import('/state.js')]).then(([f,{S}])=>{f.openFileReference({path:${JSON.stringify(name)},name:${JSON.stringify(path.basename(name))},cwd:S.cwd,...${JSON.stringify(extra)}});return true})`);
  if (expected) await until(() => read(`document.querySelector('.files-preview-path')?.textContent===${JSON.stringify(name)}&&!!document.querySelector(${JSON.stringify(expected)})&&!document.querySelector('.fp-loading')`), 'open-' + name, 25000);
}
function report() {
  fs.writeFileSync(path.join(out, 'desktop.json'), JSON.stringify({ qualification: failed ? 'failed' : 'packaged-production-main-normal-sandbox',
    boundary: 'Byte-identical packaged main/preload/backend/public; TEMP manifest observation bootstrap; offline backend preload; no CDP or sandbox bypass',
    passed: rows.filter(row => row.passed).length, failed, skipped: 0, rows, screenshots, geometry, timings, notes, diagnostics,
    electron: process.versions.electron, chromium: process.versions.chrome, elapsedMs: Date.now() - started,
    unverified: ['unmodified manifest launch without observation bootstrap', 'native external-file grant dialogs', 'long-duration memory stability', 'other OS and codecs', 'installer and upgrade', 'full canonical npm test / CI'],
  }, null, 2) + '\n');
}
assert.ok(path.isAbsolute(ROOT) && path.isAbsolute(world) && path.isAbsolute(out));
app.setPath('userData', path.join(world, 'profile')); app.setPath('sessionData', path.join(world, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
require(process.env.PREVIEW_OFFLINE_PRELOAD);
app.on('session-created', bucket => bucket.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, done) => {
  const cancel = !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(details.url).hostname);
  if (cancel) diagnostics.blockedNonLoopback++;
  done({ cancel });
}));
app.on('browser-window-created', (_event, created) => { if (!win) { win = created; win.webContents.on('render-process-gone', () => diagnostics.rendererGone++); } });
const mainFile = path.join(ROOT, 'main.cjs'), originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === 'node:child_process' && parent?.filename === mainFile) {
    const native = originalLoad.call(this, name, parent, isMain);
    return { ...native, spawn(command, args, options) {
      if (args?.[0] === path.join(ROOT, 'server.cjs')) {
        diagnostics.backendPreloads++;
        return native.spawn(command, ['--require', process.env.PREVIEW_OFFLINE_PRELOAD, ...args], options);
      }
      return native.spawn(command, args, options);
    } };
  }
  return originalLoad.call(this, name, parent, isMain);
};
try { require(mainFile); } finally { Module._load = originalLoad; }
app.on('will-quit', () => { if (!exitReady) check('explicit qualified exit', false); report(); });
const watchdog = setTimeout(() => { check('bounded qualification', false); report(); app.exit(1); }, 240000);
async function main() {
  await app.whenReady();
  await until(() => win && !win.isDestroyed() && win.webContents.getURL() === origin + '/', 'production-window', 30000);
  await until(() => read("document.querySelector('#connText')?.textContent.includes('已连接')"), 'production-connected', 30000);
  await until(() => read("import('/state.js').then(({S})=>!!S.legacyOwner?.backendInstance)"), 'production-owner');
  win.setContentSize(1320, 820);
  const preferences = win.webContents.getLastWebPreferences();
  check('actual packaged production main and sandbox', app.isPackaged && preferences.sandbox === true && preferences.contextIsolation === true && preferences.nodeIntegration === false && preferences.webSecurity !== false && !app.commandLine.hasSwitch('no-sandbox') && !app.commandLine.hasSwitch('remote-debugging-port'));
  check('actual packaged preload without renderer Node globals', await read("typeof require==='undefined'&&typeof process==='undefined'&&!!window.piGuiDesktop?.systemSettings"));
  check('production backend binds only the temporary fixture', await read(`import('/state.js').then(({S})=>S.cwd===${JSON.stringify(repo)}&&Number.isInteger(S.bridgeRun))`));
  check('offline raw network and fetch guards cover main and backend', globalThis.__systemRawNetworkGuard === true && diagnostics.backendPreloads === 1 && fs.existsSync(path.join(world, 'offline-backend')));
  check('production desktop token protects backend API', (await fetch(origin + '/api/status')).status === 401);
  const tools = { fs, path, assert, SOURCE, ROOT, world, repo, out, rows, screenshots, geometry, notes, timings, diagnostics,
    clipboard, win, read, check, sleep, until, shot, click, key, type, value, open };
  await require('./file-preview-desktop-scenarios.cjs')(tools, group);
  await require('./file-preview-desktop-formats.cjs')(tools, group);
  /* Natural scenario order restored: the Surface scenarios deliberately close
   * every top-level tab, then the layout proof reopens Files with a queued file
   * request — exactly the close-all/reopen interleaving that raced the deferred
   * history restore before the F2 fix. Restoration now merges into user state
   * (never overwrites open tabs) and stale snapshots are discarded by the
   * scope/epoch guards, so this ordering is itself a production-environment
   * regression proof of R0: if a late restore could still clobber the queued
   * open, the geometry assertions below fail. */
  await require('./surface-final-scenarios.cjs')(tools, group);
  await group('packaged-layout', async () => {
    /* This reopen-after-close-all ordering is the production regression proof
     * of the R0 restore race: the restored Files surface must accept the queued
     * open and merge the deferred history around it, never overwrite it. The
     * state snapshot is failure evidence, not an assertion shortcut. */
    notes.push({ kind: 'layout-reopen-state', paneHidden: await read("document.querySelector('#rightPane')?.hidden"),
      surfaceTabs: await read("import('/ui/secondary-surface.js').then(m=>m.secondaryTabs())"),
      fileTabCount: await read("document.querySelectorAll('.files-tab').length") });
    /* Structured open trace: the helper only returns true, so a timeout cannot
     * distinguish "open never delivered" from "metadata failed" from "sequence
     * invalidated". Arm a metadata/logger capture before opening so the failure
     * evidence shows exactly where the open chain stopped. */
    await read(`(()=>{
      window.__guideTrace={fetches:[],toasts:[]};
      const origFetch=window.fetch;
      window.fetch=function(url,opts){const u=String(url&&url.url||url);if(u.includes('/api/files'))window.__guideTrace.fetches.push(u.slice(0,140));return origFetch.apply(this,arguments)};
      const origToast=window.toast||null;
      return true;
    })()`);
    let openError = null;
    try { await open('guide.md', '.fp-markdown-body'); }
    catch (error) { openError = { type: error.name, stage: error.testLabel || 'interaction' }; }
    notes.push({ kind: 'layout-after-open',
      openError,
      filesPath: await read("document.querySelector('.files-preview-path')?.textContent||null"),
      fileTabLabels: await read("[...document.querySelectorAll('.files-tab')].map(t=>t.textContent.trim().replace(/\\s+/g,' ').slice(0,24))"),
      guideTrace: await read("window.__guideTrace||null"),
      openChain: await read("window.__openChain||null"),
      activeSurface: await read("import('/ui/secondary-surface.js').then(m=>m.secondaryTabs().find(t=>t.active)?.view||null)"),
      activeFileTab: await read("document.querySelector('.files-tab[aria-selected=\"true\"], .files-tab.active')?.textContent?.trim()||null") });
    if (openError) throw Object.assign(Error('open-guide.md'), { testLabel: 'open-guide.md' });
    if (!await read("document.querySelector('#rightPane').dataset.maximized==='true'")) await click('#workPanelMaximize');
    for (const width of [1320, 700]) for (const theme of ['dark', 'light']) {
      win.setContentSize(width, width === 700 ? 600 : 820);
      check('packaged theme ' + theme + ' ' + width, await read(`import('/theme.js').then(m=>m.setThemePreference(${JSON.stringify(theme)}))`));
      await sleep(200);
      const measured = await read(`(${require('./file-preview-desktop-geometry.cjs').toString()})()`);
      geometry.push(measured);
      check('packaged bounded common-maximize layout ' + width + '-' + theme,
        Math.abs(measured.pane.width - measured.expectedWidth) <= 2 && Math.abs(measured.surface.width - measured.body.width) <= 2 &&
        Math.abs(measured.surface.x - measured.body.x) <= 2 && Math.abs(measured.pane.right - measured.app.right) <= 2 &&
        measured.docOverflow <= 1 && measured.bodyText && measured.chatPresent && measured.chatInert, measured);
      await shot('packaged-' + width + '-' + theme);
    }
  });
  check('packaged renderer did not crash', diagnostics.rendererGone === 0);
}
main().catch(error => { check('packaged boot and integration', false, { type: error.name, stage: error.testLabel || 'boot' }); }).finally(async () => {
  report();
  fs.writeFileSync(path.join(world, 'ready-for-cleanup'), 'yes');
  try { await until(() => fs.existsSync(path.join(world, 'processes-observed')), 'parent-process-observation'); }
  catch { check('parent observed owned process identities', false); }
  exitReady = true; clearTimeout(watchdog); report();
  // Use the production quit coordinator: it owns the backend/Pi cleanup.
  if (win && !win.isDestroyed()) await read('window.piGuiDesktop.systemSettings.quit()').catch(() => app.quit());
  else app.quit();
});
