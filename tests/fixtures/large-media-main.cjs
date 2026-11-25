'use strict';
// Test-owned BrowserWindow, production renderer/server/preload. NOT packaged-main proof.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, session, ipcMain, nativeTheme } = require('electron');
const { installGrantRevocationObserver, isSynchronousGrantTeardown } = require('./large-media-revocation.cjs');
const SOURCE = path.resolve(__dirname, '../..'), world = process.env.LARGE_MEDIA_WORLD;
const ROOT = process.env.PREVIEW_APP_ROOT || SOURCE;
const DESKTOP = ROOT === SOURCE ? path.join(SOURCE, 'electron') : ROOT;
const out = path.join(world, 'evidence'), repo = path.join(world, 'repo');
const rows = [], ranges = [], samples = [], memory = [], screenshots = [], io = [];
let messageId = 100, mediaRequestCount = 0;
function backendRequest(type, data = {}) {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    const timer = setTimeout(() => { backend.off('message', receive); reject(Error('private-fixture-ipc-timeout')); }, 10000);
    function receive(message) { if (message?.id === id && message.type === type + '-result') { clearTimeout(timer); backend.off('message', receive); resolve(message.result || message.stats); } }
    backend.on('message', receive); backend.send({ type, id, ...data });
  });
}
async function observe(label) { const stats = await backendRequest('large-media-observe'); io.push({ label, atMs: Date.now() - started, stats }); return stats; }
const diagnostics = { blockedRemote: 0, crashes: 0 };
let win, backend, origin, fixture, phase = 'generation';
const started = Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = code => win.webContents.executeJavaScript(code, true);
function check(name, value, details) { rows.push({ name, passed: !!value, ...(details ? { details } : {}) }); console.log((value ? 'PASS ' : 'FAIL ') + name); if (!value) throw Object.assign(Error(name), { testLabel: name }); }
async function until(test, label, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return; await sleep(50); } throw Object.assign(Error('timeout'), { testLabel: label }); }
async function shot(name) { const image = await win.capturePage(); assert.ok(!image.isEmpty()); fs.writeFileSync(path.join(out, name + '.png'), image.toPNG()); screenshots.push(name + '.png'); }
async function snapshot(label) {
  const value = await read(`(()=>{const v=document.querySelector('video');if(!v)return null;const q=v.getVideoPlaybackQuality();return {time:v.currentTime,duration:v.duration,paused:v.paused,seeking:v.seeking,readyState:v.readyState,networkState:v.networkState,width:v.videoWidth,height:v.videoHeight,decoded:q.totalVideoFrames,dropped:q.droppedVideoFrames,error:v.error?.code||0,buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)])}})()`);
  samples.push({ label, phase, atMs: Date.now() - started, value });
  memory.push({ label, processes: app.getAppMetrics().map(row => ({ type: row.type, workingSetKB: row.memory.workingSetSize, peakWorkingSetKB: row.memory.peakWorkingSetSize })) });
  return value;
}
async function open() {
  await read("Promise.all([import('/files-panel.js'),import('/state.js')]).then(([f,{S}])=>{f.openFileReference({path:'large.webm',name:'large.webm',cwd:S.cwd});return true})");
  await until(() => read("!!document.querySelector('video')"), 'video-mounted');
  await until(() => read("document.querySelector('video')?.readyState>=1"), 'video-metadata', 25000);
  await read("window.__largeVideo=document.querySelector('video'); true");
}
async function progress(label, seconds = 1) {
  const before = await snapshot(label + '-before');
  await read("document.querySelector('video').play().then(()=>true)");
  await until(async () => { const now = await read("(()=>{const v=document.querySelector('video');return {time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,error:v.error?.code||0}})()"); if (now.error) throw Error('decoder-error-' + now.error); return now.time > before.time + seconds && now.frames > before.decoded + 3; }, label + '-progress', 25000);
  return snapshot(label + '-after');
}
async function nativeSeek(fraction) {
  await read("(()=>{const v=document.querySelector('video');v.pause();window.__seekEvents=[];v.addEventListener('seeking',event=>window.__seekEvents.push({trusted:event.isTrusted,time:v.currentTime}),{once:true});return true})()");
  win.focus(); win.webContents.focus();
  const rect = await read("(()=>{const r=document.querySelector('video').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height - 25) }); await sleep(180);
  const debug = win.webContents.debugger; debug.attach('1.3'); let box;
  try {
    await debug.sendCommand('DOM.enable');
    const { root } = await debug.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    function locate(node) { const a = node.attributes || []; if (a.includes('-webkit-media-controls-timeline')) return node.nodeId; for (const c of [...(node.children || []), ...(node.shadowRoots || [])]) { const result = locate(c); if (result) return result; } return 0; }
    const nodeId = locate(root); assert.ok(nodeId, 'native Chromium timeline exists, no fake product seek control');
    const { model } = await debug.sendCommand('DOM.getBoxModel', { nodeId }); const q = model.content;
    const x = Math.min(q[0], q[2], q[4], q[6]), y = Math.min(q[1], q[3], q[5], q[7]);
    box = { x, y, width: Math.max(q[0], q[2], q[4], q[6]) - x, height: Math.max(q[1], q[3], q[5], q[7]) - y };
  } finally { debug.detach(); }
  const before = await snapshot('seek-' + fraction + '-before');
  samples.push({ label: 'native-timeline-box', fraction, box, rect });
  const x0 = Math.round(box.x + 6 + (box.width - 12) * Math.min(.95, before.time / before.duration));
  const x1 = Math.round(box.x + 6 + (box.width - 12) * fraction), y = Math.round(box.y + box.height / 2);
  await read("(()=>{window.__largeTimelineMoves=[];window.__largeTimelineMoveListener=event=>{if(event.isTrusted)window.__largeTimelineMoves.push({x:event.clientX,y:event.clientY,buttons:event.buttons})};document.addEventListener('mousemove',window.__largeTimelineMoveListener,true);return true})()");
  try {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: x0, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: x0, y, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 10; step++) {
      const x = Math.round(x0 + (x1 - x0) * step / 10);
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y, button: 'left', modifiers: ['leftButtonDown'] });
      // A wall-clock sleep is not acknowledgement that a busy renderer handled
      // the preceding native move. Keep the held drag ordered by trusted input.
      await until(() => read(`window.__largeTimelineMoves.some(event=>Math.abs(event.x-${x})<1&&Math.abs(event.y-${y})<1&&event.buttons===1)`), 'native-drag-move-' + step, 2000);
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: x1, y, button: 'left', clickCount: 1 });
    samples.push({ label: 'trusted-native-drag-input', fraction, moves: await read('window.__largeTimelineMoves') });
  } finally {
    await read("document.removeEventListener('mousemove',window.__largeTimelineMoveListener,true);delete window.__largeTimelineMoveListener;true");
  }
  await until(() => read(`(()=>{const v=document.querySelector('video');return !v.seeking&&Math.abs(v.currentTime-v.duration*${fraction})<.8&&window.__seekEvents.some(e=>e.trusted)})()`), 'trusted-native-drag-' + fraction, 10000);
  const after = await progress('seek-' + fraction, .6);
  check('trusted native timeline drag and decoded frame resume ' + fraction, Math.abs(after.time - before.duration * fraction) < 4 && after.decoded > before.decoded, { box, fraction, before: before.time, after: after.time, frames: after.decoded - before.decoded });
  await shot('seek-' + fraction);
}
async function closeFileTab() {
  const target = await read(`(()=>{const tab=document.querySelector('.files-tab[aria-selected="true"]');const button=tab?.querySelector('.files-tab-close');if(!button)throw Error('file_tab_close_required');const id=tab.querySelector('.files-tab-select').id;window.__largeFileClose=null;button.addEventListener('click',event=>{window.__largeFileClose={trusted:event.isTrusted,tabPresent:!!document.getElementById(id)}},{once:true,capture:true});const r=button.getBoundingClientRect();return {id,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  win.focus(); win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await until(() => read(`!!window.__largeFileClose&&!document.getElementById(${JSON.stringify(target.id)})`), 'file-tab-removed', 1500);
  const result = await read(`import('/ui/secondary-surface.js').then(m=>({...window.__largeFileClose,tabRemoved:!document.getElementById(${JSON.stringify(target.id)}),videoRemoved:!window.__largeVideo.isConnected,fileTabsRemaining:document.querySelectorAll('.files-tab').length,filesSurfaceActive:m.secondaryTabs().some(tab=>tab.view==='files'&&tab.active)}))`);
  check('trusted file-tab close removes the inner tab and keeps Files surface active', result.trusted && result.tabPresent && result.tabRemoved && result.videoRemoved && result.fileTabsRemaining === 0 && result.filesSurfaceActive, result);
}
async function pausedAndIdle() {
  await read('window.__largeVideo.pause();true');
  let previous, idleSince = Date.now();
  await until(async () => {
    const stats = await backendRequest('large-media-observe');
    const current = { readCalls: stats.readCalls, actualBytes: stats.actualBytes, requests: mediaRequestCount };
    if (stats.active || !previous || Object.keys(current).some(key => current[key] !== previous[key])) idleSince = Date.now();
    previous = current;
    return stats.active === 0 && Date.now() - idleSince >= 500;
  }, 'paused-buffered-media-idle', 15000);
  const value = await snapshot('paused-buffered-before-revoke'), stats = await observe('paused-buffered-before-revoke');
  check('paused buffered media has no active reads before HTTP revoke', value.paused && value.readyState >= 2 && !value.error && value.buffered.some(([a, b]) => a <= value.time && b >= value.time + .25) && stats.active === 0, { value, stats, idleMs: 500 });
}
async function stopped(label, action, { playing = true } = {}) {
  if (playing) await progress(label + '-playing', .5);
  const activeBefore = (await observe(label + '-before-action')).active;
  const actionAt = Date.now();
  await action();
  await until(() => read("window.__largeVideo.paused&&!window.__largeVideo.getAttribute('src')&&window.__largeVideo.readyState===0"), label + '-release', 1500);
  const decoderReleaseMs = Date.now() - actionAt;
  await until(async () => (await backendRequest('large-media-observe')).active === 0, label + '-descriptor-close', 1500);
  const descriptorReleaseMs = Date.now() - actionAt;
  const released = await observe(label + '-released');
  const a = await read("({frames:window.__largeVideo.getVideoPlaybackQuality().totalVideoFrames,time:window.__largeVideo.currentTime})");
  const count = ranges.length, requestCount = mediaRequestCount; await sleep(1200);
  const b = await read("({frames:window.__largeVideo.getVideoPlaybackQuality().totalVideoFrames,time:window.__largeVideo.currentTime})");
  const stats = await observe(label + '-settled');
  check(label + ' clears decoder immediately and does not start background Range', ranges.length === count && mediaRequestCount === requestCount && a.frames === b.frames && a.time === b.time && stats.active === 0 && stats.readCalls === released.readCalls && stats.actualBytes === released.actualBytes, { decoderReleaseMs, descriptorReleaseMs, settledMs: 1200, activeDescriptorsBefore: activeBefore, responses: count, requests: requestCount, before: a, after: b, activeDescriptors: stats.active, stableReadCalls: stats.readCalls, stableReadBytes: stats.actualBytes });
}
app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('disable-background-networking');
app.setPath('userData', path.join(world, 'profile'));
require('./system-settings-offline.cjs');
async function main() {
  check('normal sandbox flags', !app.commandLine.hasSwitch('no-sandbox') && !app.commandLine.hasSwitch('remote-debugging-port'));
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, done) => { const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(details.url).hostname); if (!local) diagnostics.blockedRemote++; done({ cancel: !local }); });
  const pending = new Map();
  session.defaultSession.webRequest.onSendHeaders(details => { if (/\/api\/files\/(?:external\/)?content\?/.test(details.url)) { mediaRequestCount++; pending.set(details.id, { phase, atMs: Date.now() - started, range: Object.entries(details.requestHeaders).find(([k]) => k.toLowerCase() === 'range')?.[1] || null }); } });
  session.defaultSession.webRequest.onHeadersReceived((details, done) => { const row = pending.get(details.id); if (row) { const get = name => Object.entries(details.responseHeaders).find(([key]) => key.toLowerCase() === name)?.[1]?.[0]; Object.assign(row, { status: details.statusCode, contentRange: get('content-range'), length: Number(get('content-length')) }); ranges.push(row); } done({}); });
  session.defaultSession.webRequest.onCompleted(details => pending.delete(details.id));
  session.defaultSession.webRequest.onErrorOccurred(details => { const row = pending.get(details.id); if (row) row.cancelled = true; pending.delete(details.id); });
  win = new BrowserWindow({ width: 1320, height: 850, useContentSize: true, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(DESKTOP, 'preload.cjs') } });
  win.webContents.on('render-process-gone', () => diagnostics.crashes++);
  fs.writeFileSync(path.join(world, 'encoder.html'), '<!doctype html><title>Offline VP8 fixture generation</title>');
  await win.loadFile(path.join(world, 'encoder.html'));
  const mediaDir = path.join(world, 'media'); fs.mkdirSync(mediaDir);
  const target = path.join(mediaDir, 'large.webm');
  const prior = process.env.LARGE_MEDIA_FIXTURE;
  if (prior) {
    assert.ok(path.resolve(prior).startsWith(path.resolve(os.tmpdir()) + path.sep), 'reuse only explicitly generated TEMP fixture');
    fixture = JSON.parse(fs.readFileSync(path.join(prior, 'fixture.json'), 'utf8'));
    assert.match(fixture.method, /^new canvas noise/); assert.equal(fs.statSync(path.join(prior, 'large.webm')).size, fixture.bytes);
    fs.copyFileSync(path.join(prior, 'large.webm'), target);
  } else {
    fixture = await require('./large-media-webm.cjs')({ win, target });
  }
  fs.writeFileSync(path.join(mediaDir, 'fixture.json'), JSON.stringify(fixture, null, 2));
  check('over 100 MiB consists of real newly encoded VP8 frames, not padding', fixture.encodedBytes > 100 * 1024 * 1024 && fixture.containerBytes / fixture.bytes < .01 && fixture.frames >= 360, fixture);
  process.env.PREVIEW_NODE_EXECUTABLE ||= process.execPath;
  const { shim, data, home } = await require('./file-preview-desktop-data.cjs')({ SOURCE, world, repo });
  fs.copyFileSync(target, path.join(repo, 'large.webm'));
  const socket = require('node:net').createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); origin = 'http://127.0.0.1:' + port;
  backend = spawn(process.env.PREVIEW_NODE_EXECUTABLE, ['--require', path.join(SOURCE, 'tests/fixtures/large-media-observe.cjs'), path.join(ROOT, ROOT === SOURCE ? 'server.js' : 'server.cjs')], { cwd: ROOT, env: { ...process.env, PORT: String(port), PI_GUI_DESKTOP: '1', PI_GUI_DATA: data, PI_CWD: repo, PI_BIN: shim, PI_GUI_TOKEN: '', PI_GUI_OPEN: '0', PI_CODING_AGENT_DIR: path.join(home, 'agent') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  backend.stdout.resume(); backend.stderr.resume();
  await until(async () => { try { return (await (await fetch(origin + '/api/health')).json()).app === 'pi-gui'; } catch { return false; } }, 'backend-health');
  const theme = require(path.join(DESKTOP, 'theme.cjs')).createDesktopTheme({ ipcMain, nativeTheme, getWindow: () => win, origin, preferenceFile: path.join(world, 'theme.json') }); theme.register();
  win.webContents.on('console-message', details => { if (details.level === 'error') { diagnostics.consoleErrors ||= []; diagnostics.consoleErrors.push({ source: String(details.sourceId || '').replace(origin, '').split('?')[0], length: details.message.length, words: ['export','undefined','SyntaxError','TypeError','Failed','fetch','theme','module','permission'].filter(word => details.message.includes(word)) }); } });
  phase = 'metadata'; await win.loadURL(origin);
  if (process.env.LARGE_MEDIA_TRANSPORT_ONLY === '1') {
    // Explicit isolated transport reproduction while another owner changes app boot.
    // Does NOT count as production-renderer/lifecycle or packaged qualification.
    phase = 'isolated-native-transport';
    await read(`fetch('/api/files/metadata?'+new URLSearchParams({path:'large.webm',root:${JSON.stringify(repo)}})).then(r=>r.json()).then(meta=>{const v=document.createElement('video');v.controls=true;v.muted=true;v.style.cssText='width:960px;height:540px';v.src='/api/files/content?'+new URLSearchParams({path:'large.webm',root:${JSON.stringify(repo)},fileId:meta.file.fileId});document.body.replaceChildren(v);return true})`);
    await until(() => read("document.querySelector('video').readyState>=1||!!document.querySelector('video').error"), 'transport-metadata');
    await read("document.querySelector('video').play().catch(()=>false)"); await sleep(5000);
    await snapshot('isolated-transport'); await shot('isolated-transport');
    for (const fraction of [.73, .23, .88]) { phase = 'isolated-seek-' + fraction; await nativeSeek(fraction); }
    check('isolated native transport has no rejected valid Chromium range', ranges.length > 1 && ranges.every(row => row.status === 206), ranges);
    return;
  }
  await until(() => read("document.querySelector('#connText')?.textContent.includes('已连接')"), 'production-connected');
  await until(() => read("import('/state.js').then(({S})=>!!(S.legacyOwner?.workspaceId&&S.legacyOwner?.workspaceEpoch&&S.legacyOwner?.sessionId&&S.legacyOwner?.backendInstance))"), 'production-owner');
  await sleep(350);
  const preferences = win.webContents.getLastWebPreferences();
  check('production renderer and preload with normal sandbox and no Node globals', preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration && await read("typeof require==='undefined'&&typeof process==='undefined'&&!!window.piGuiDesktop"));
  await read("(()=>{const f=window.fetch;window.__largeReadAll={contentFetch:0,objectUrl:0};window.fetch=function(input,...args){const u=typeof input==='string'?input:input.url||String(input);if(/\\/api\\/files\\/(external\\/)?content\\?/.test(u))window.__largeReadAll.contentFetch++;return f.call(this,input,...args)};const create=URL.createObjectURL;URL.createObjectURL=function(...args){window.__largeReadAll.objectUrl++;return create.apply(this,args)};return true})()");
  await open();
  await read("(()=>{const s=document.querySelector('#workPanelMaximize');if(s&&document.querySelector('#rightPane').dataset.maximized!=='true')s.click();return true})()");
  const meta = await snapshot('loaded'); check('real decoder sees dimensions and finite seekable duration', meta.width === fixture.width && meta.height === fixture.height && Math.abs(meta.duration - fixture.durationSeconds) < .1 && !meta.error, meta);
  phase = 'continuous'; await progress('continuous', 4);
  check('continuous playback crosses multiple 8 MiB responses', ranges.filter(row => row.status === 206 && row.length === 8388608).length >= 3, ranges);
  await shot('continuous-playback');
  for (const fraction of [.73, .23, .88]) { phase = 'seek-' + fraction; await nativeSeek(fraction); }
  check('all successful media responses remain bounded and never use whole-file 200', ranges.every(row => row.status === 206 && row.length <= 8388608), ranges);
  phase = 'surface-hide';
  await stopped('surface hide', () => read("import('/ui/secondary-surface.js').then(m=>{m.openSecondarySurface('large-media-notes',host=>{const p=document.createElement('p');p.textContent='Temporary surface';host.append(p);return {dispose(){}}},{label:'Temporary surface'});return true})"));
  phase = 'reopen'; await open();
  check('returning to media does not autoplay', (await snapshot('restored')).paused);
  phase = 'surface-close';
  await stopped('surface close', () => read("import('/ui/secondary-surface.js').then(m=>{m.closeSecondarySurface();return true})"));
  phase = 'reopen-after-surface-close'; await open();
  phase = 'file-tab-close';
  // Empty the Files owner before the grant scenario, so closing its last
  // external tab cannot legitimately activate a different saved media tab.
  await stopped('file tab close', closeFileTab);
  phase = 'external-grant';
  // A synthetic private-IPC grant covers ONLY this generated TEMP video. No
  // native user prompt is substituted, and no real user file is authorized.
  const inspected = await backendRequest('files-grant', { action: 'inspect', path: target, scopeKind: 'file' });
  check('private grant inspection is limited to generated TEMP media', inspected.ok === true && !!inspected.approval);
  const granted = await backendRequest('files-grant', { action: 'create', approval: inspected.approval, scopeKind: 'file' });
  check('private synthetic grant created for generated file only', granted.ok === true && !!granted.grant?.id);
  const grantId = granted.grant.id;
  await read(`Promise.all([import('/files-panel.js'),import('/state.js')]).then(([f,{S}])=>{f.openFileReference({path:${JSON.stringify(target)},name:'large.webm',cwd:S.cwd,external:true,grantId:${JSON.stringify(grantId)}});return true})`);
  await until(() => read("!!document.querySelector('video')&&document.querySelector('video').readyState>=1"), 'external-video-ready');
  await read("window.__largeVideo=document.querySelector('video');true");
  // Prepare a buffered tail, whose bounded final Range can finish even after
  // pause. Pausing near the start may leave Chromium's read-ahead response under
  // backpressure indefinitely. This setup seek is not native-input evidence;
  // the three timeline drags above remain the separate native qualification.
  await read('window.__largeVideo.currentTime=Math.max(0,window.__largeVideo.duration-2);true');
  await progress('external-playing', 1);
  await pausedAndIdle();
  await read(`(${installGrantRevocationObserver.toString()})(${JSON.stringify(grantId)})`);
  const beforeRevokeRequests = mediaRequestCount, beforeRevokeResponses = ranges.length;
  phase = 'grant-revoke';
  await stopped('grant revoke', async () => {
    // Use the existing production publisher, not private IPC revoke (which only
    // changes the ledger and does not publish an explicit-revoke SSE frame).
    const revoked = await read(`import('/api.js').then(api=>api.revokeExternalGrant(${JSON.stringify(grantId)})).then(result=>({ok:result.ok===true,matchingId:result.id===${JSON.stringify(grantId)}}))`);
    check('production HTTP revoke confirms the matching session grant was removed', revoked.ok && revoked.matchingId, revoked);
  }, { playing: false });
  await until(() => read('window.__largeGrantObserver.summary().nativeSse.length>0&&!!window.__largeGrantObserver.summary().dispatches[0]?.after'), 'native-sse-and-renderer-dispatch', 5000);
  const revokeEvidence = await read('window.__largeGrantObserver.summary()');
  check('matching real SSE causes synchronous file-tab and media teardown without a 403 fallback', isSynchronousGrantTeardown(revokeEvidence) && mediaRequestCount === beforeRevokeRequests && ranges.length === beforeRevokeResponses, { ...revokeEvidence, newMediaRequests: mediaRequestCount - beforeRevokeRequests, newMediaResponses: ranges.length - beforeRevokeResponses });
  await read('window.__largeGrantObserver.dispose();true');
  const denied = await read(`fetch('/api/files/external/metadata?'+new URLSearchParams({path:${JSON.stringify(target)},grant:${JSON.stringify(grantId)}})).then(r=>r.status)`);
  check('revoked real video cannot reopen through stale grant', denied === 403);
  const stats = await observe('final');
  const js = await read('window.__largeReadAll');
  check('media never enters renderer fetch/Blob whole-file path', js.contentFetch === 0 && js.objectUrl === 0, js);
  check('actual backend reads stay 64 KiB and descriptors all close', stats.readCalls > 100 && stats.maxReadRequest <= 65536 && stats.maxReadResult <= 65536 && stats.wholeFileReads === 0 && stats.active === 0 && stats.opened === stats.closed, stats);
  check('no renderer crash or remote request', diagnostics.crashes === 0 && diagnostics.blockedRemote === 0, diagnostics);
}
main().catch(async error => { if (!rows.some(row => row.name === error.testLabel && !row.passed)) rows.push({ name: 'scenario completes', passed: false, details: { phase, stage: error.testLabel || error.message, type: error.name } }); if (win && !win.isDestroyed()) { await snapshot('failure').catch(() => {}); samples.push({ label: 'failure-seek-events', events: await read('window.__seekEvents||[]').catch(() => []) }); await shot('failure-' + phase).catch(() => {}); } }).finally(async () => {
  if (win && !win.isDestroyed()) {
    await read('window.__largeGrantObserver?.dispose();true').catch(() => {});
    win.destroy();
  }
  if (backend?.exitCode === null) {
    backend.send({ type: 'app-update', action: 'prepare', id: 1 }); await sleep(150);
    backend.send({ type: 'app-update', action: 'shutdown', id: 2 });
    await until(() => backend.exitCode !== null, 'backend-cleanup', 15000).catch(() => rows.push({ name: 'backend cleanup', passed: false }));
  }
  const failed = rows.filter(row => !row.passed).length;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ qualification: failed ? 'failed-normal-sandbox' : process.env.LARGE_MEDIA_TRANSPORT_ONLY === '1' ? 'isolated-native-transport-only' : ROOT === SOURCE ? 'source-production-renderer-normal-sandbox' : 'built-production-renderer-normal-sandbox', boundary: 'Test-owned BrowserWindow main; actual selected server/renderer/preload; NOT packaged production-main proof; UA timeline box observation via temporarily attached debugger, trusted native input after detach', revocationBoundary: 'Only grant creation uses private IPC; production HTTP revoke publishes SSE; a second native EventSource observes the matching wire event and capture-before-owner observes synchronous app document-event teardown. No synthetic dispatch, media error fallback, production-main local IPC, persistent grant or native permission UI qualification.', appRoot: ROOT, passed: rows.length - failed, failed, skipped: 0, rows, fixture, ranges, samples, memory, io, screenshots, diagnostics, elapsedMs: Date.now() - started, electron: process.versions.electron, chromium: process.versions.chrome }, null, 2));
  console.log('EVIDENCE ' + out); app.exit(failed ? 1 : 0);
});
