'use strict';
// Production bootstrap and Renderer. Only native picker selection, TLS test
// destination/CA and relaunch spawning are fixture-owned adapters, all in TEMP.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), https = require('node:https'), net = require('node:net');
const assert = require('node:assert/strict'), Module = require('node:module'), { createHash } = require('node:crypto');
const electron = require('electron'), { app, BrowserWindow, session } = electron;
const ROOT = path.resolve(__dirname, '../..'), world = process.env.SYSTEM_WORLD, out = process.env.SYSTEM_OUTPUT, phase = process.env.SYSTEM_PHASE;
const origin = 'http://127.0.0.1:' + process.env.PORT, profile = process.env.SYSTEM_PROFILE, target = process.env.SYSTEM_TARGET;
const mainFile = process.env.SYSTEM_APP_MAIN || path.join(ROOT, 'electron/main.cjs');
const certificate = require('./system-network-tls.cjs');
const report = { phase, checks: [], screenshots: [], failed: 0, errors: [], sandbox: null };
let win, backend, diskWindow, cacheServer, modelServer, proxy, tlsServer, proxyPort, tlsPort, ready = false, deadline;
let endpointSendFailures = 0, installerLaunchAttempts = 0;
const localSockets = new Set(), proxyRequests = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, name, limit = 120000) { const end = Date.now() + limit; while (Date.now() < end) { if (await predicate()) return; await sleep(80); } throw Error('timeout: ' + name); }
const read = code => win.webContents.executeJavaScript(code, true);
const state = () => read('window.piGuiDesktop.systemSettings.state()');
function check(name, value) { assert.ok(value, name); report.checks.push(name); console.log('PASS ' + phase + ': ' + name); }
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function save() { fs.writeFileSync(path.join(out, phase + '.json'), JSON.stringify(report, null, 2) + '\n'); }
async function click(selector) {
  win.show(); win.focus(); win.webContents.focus();
  const point = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 }); await sleep(120);
}
async function exitReady() { fs.writeFileSync(path.join(world, phase + '-ready'), 'ready'); await until(() => fs.existsSync(path.join(world, phase + '-ack')), 'parent identities'); ready = true; }
function track(server) { server.on('connection', socket => { localSockets.add(socket); socket.on('error', () => {}); socket.once('close', () => localSockets.delete(socket)); }); return server; }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function closeFixtures() {
  diskWindow?.destroy(); diskWindow = null;
  for (const socket of localSockets) socket.destroy();
  for (const server of [cacheServer, modelServer, proxy, tlsServer]) if (server?.listening) await new Promise(resolve => server.close(resolve));
}
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.commandLine.appendSwitch('disable-background-networking');
require(process.env.SYSTEM_OFFLINE_PRELOAD);
app.on('session-created', bucket => bucket.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, done) => done({ cancel: !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(details.url).hostname) })));
app.on('browser-window-created', (_event, created) => { if (!win) win = created; });
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === 'node:child_process' && parent?.filename === path.join(path.dirname(mainFile), 'app-update-desktop.cjs')) {
    const native = originalLoad.call(this, name, parent, isMain);
    return { ...native, spawn() { installerLaunchAttempts++; throw Error('unexpected installer helper in P2 fixture'); } };
  }
  if (name === './app-update-fetch.cjs' && parent?.filename === mainFile) {
    const native = originalLoad.call(this, name, parent, isMain);
    return { ...native, createSessionFetch: options => {
      const fetch = native.createSessionFetch(options);
      globalThis.__systemUpdateFetch = fetch;
      return fetch;
    } };
  }
  if (name === './system-network-test.cjs' && parent?.filename === mainFile) {
    const native = originalLoad.call(this, name, parent, isMain);
    return { ...native, createSystemConnectionTest: options => {
      let probe;
      return config => {
        probe ??= native.createSystemConnectionTest({ ...options, target: `https://public.example:${tlsPort}/fixed-ping`,
          lookup: async () => [{ address: '93.184.216.34', family: 4 }], tlsOptions: { ca: certificate.cert } });
        return probe(config);
      };
    } };
  }
  if (name === 'electron' && parent?.filename === mainFile) return { ...electron, dialog: { ...electron.dialog,
    showOpenDialog: async () => ({ canceled: false, filePaths: [target] }) } };
  if (name === 'node:child_process' && parent?.filename === mainFile) {
    const native = originalLoad.call(this, name, parent, isMain);
    return { ...native, spawn(command, args, options) {
      const isBackend = args?.[0] === path.join(ROOT, 'server.js') || args?.[0] === path.join(path.dirname(mainFile), 'server.cjs');
      const child = native.spawn(command, isBackend ? ['--require', process.env.SYSTEM_OFFLINE_PRELOAD, ...args] : args, options);
      if (isBackend) {
        backend = child; report.backendCount = (report.backendCount || 0) + 1;
        const send = child.send.bind(child);
        child.send = (message, ...args) => {
          if (message?.type === 'system-endpoint-policy' && endpointSendFailures > 0) {
            endpointSendFailures--;
            queueMicrotask(() => args.at(-1)(Error('fixture endpoint delivery refused')));
            return false;
          }
          return send(message, ...args);
        };
        child.once('exit', (code, signal) => { report.backendExit = { code, signal }; });
      }
      return child;
    } };
  }
  return originalLoad.call(this, name, parent, isMain);
};
// Parent runner performs the next real process launch after observing exit 0
// and zero residual identities; it does not run a second writer concurrently.
app.relaunch = () => {
  report.backendExitedBeforeRelaunch = report.backendExit?.code === 0 && report.backendExit.signal === null;
  report.relaunchRequested = true;
};
require(mainFile); Module._load = originalLoad;
app.on('will-quit', () => {
  clearTimeout(deadline);
  if (!ready) { report.failed++; report.errors.push('unexpected_exit'); }
  if (phase === 'prepare-migration' && report.failed === 0) {
    // Observe the actual exit event before relaunch; IPC disconnection alone
    // is not evidence that the backend has stopped writing.
    if (!report.relaunchRequested || !report.backendExitedBeforeRelaunch || fs.readdirSync(target).length) { report.failed++; report.errors.push('cold_restart_contract'); }
    else check('intent requests relaunch only after backend exit and before any cold target write', true);
    report.installerLaunchAttempts = installerLaunchAttempts;
    if (installerLaunchAttempts !== 0) { report.failed++; report.errors.push('unexpected_update_helper'); }
    else check('storage restart does not launch an installer', true);
  }
  save();
});
process.on('exit', () => { try { save(); } catch {} });
async function networkAndCache() {
  const seen = [];
  tlsServer = track(https.createServer(certificate, (req, res) => { seen.push({ method: req.method, path: req.url, authorization: Boolean(req.headers.authorization || req.headers['x-api-key']) }); res.end(); }));
  tlsPort = await listen(tlsServer);
  proxy = track(http.createServer()); proxy.on('connect', (req, socket) => {
    proxyRequests.push(req.url);
    const upstream = net.connect({ host: '127.0.0.1', port: tlsPort }, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.pipe(upstream); upstream.pipe(socket); });
    localSockets.add(upstream); upstream.on('close', () => localSockets.delete(upstream)); upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy());
  }); proxyPort = await listen(proxy);
  await click('[aria-label="代理"] [data-value="custom"]');
  await click('[aria-label="自定义代理地址"]'); win.webContents.insertText(`http://127.0.0.1:${proxyPort}`);
  await click('button[aria-label="网络宽松模式"]');
  await read("[...document.querySelectorAll('button')].find(e=>e.textContent==='测试连接').id='p2-test'");
  await click('#p2-test');
  await until(async () => {
    const feedback = await read("({text:document.querySelector('#system-network-feedback').textContent,error:document.querySelector('#system-network-feedback').classList.contains('is-error')})");
    if (feedback.error) throw Error('connection test: ' + feedback.text);
    return feedback.text.includes('连接成功');
  }, 'draft real CONNECT TLS', 25000);
  check('draft test uses actual configured Chromium route and TLS HEAD only', seen.length === 1 && seen[0].method === 'HEAD' && seen[0].path === '/fixed-ping' && !seen[0].authorization && proxyRequests[0] === `93.184.216.34:${tlsPort}`);
  check('draft test leaves persisted network file absent', !fs.existsSync(path.join(profile, 'system-network.json')));
  await read("[...document.querySelectorAll('button')].find(e=>e.textContent==='保存网络设置').id='p2-save'"); await click('#p2-save');
  await until(async () => (await state()).snapshot.network.settings.mode === 'custom', 'saved custom proxy');
  check('custom and independent relaxed values persist without restarting backend', JSON.parse(fs.readFileSync(path.join(profile, 'system-network.json'))).relaxed && backend.connected && report.backendCount === 1);
  let modelHits = 0;
  modelServer = track(http.createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined); assert.equal(req.headers['x-api-key'], undefined);
    assert.equal(req.method, 'GET'); modelHits++;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[{"id":"local-final-model"}]}');
  }));
  const modelPort = await listen(modelServer);
  await require('./system-settings-final-visual.cjs').runFinalNetworkVisual({ win, read, until, click, check, out, report,
    modelUrl: `http://127.0.0.1:${modelPort}/v1`, modelHits: () => modelHits, agentDir: process.env.PI_CODING_AGENT_DIR });
  await until(() => read("!document.querySelector('[aria-label=\"代理\"] [data-value=\"direct\"]').disabled"), 'network controls restored');
  await read("[...document.querySelectorAll('button')].find(e=>e.textContent==='保存网络设置').id='p2-save'");
  await click('[aria-label="代理"] [data-value="direct"]'); await click('#p2-save');
  await until(async () => (await state()).snapshot.network.settings.mode === 'direct', 'saved direct');
  check('real direct route ignores custom proxy and backend loopback stays reachable', await session.defaultSession.resolveProxy('https://public.example/') === 'DIRECT' && backend.connected);
  // One bounded Main→child send failure; all state, writes and the recovery
  // ACK still come from the production owners. Leave a clean startup policy.
  endpointSendFailures = 1;
  await click('[aria-label="代理"] [data-value="system"]'); await click('button[aria-label="网络宽松模式"]'); await click('#p2-save');
  await until(() => read("document.querySelector('#system-network-feedback').classList.contains('is-error')"), 'real unconfirmed save');
  check('failed backend permission delivery is not rendered as saved', (await state()).snapshot.network.endpointPermissions === 'unconfirmed' &&
    await read("{const t=document.querySelector('#system-network-feedback').textContent; t.includes('后端端点权限尚未确认') && t.includes('重试保存网络设置') && !t.includes('已保存') }"));
  await read("document.querySelector('#navAppearance').click();document.querySelector('#navSystem').click()");
  const saveButton = "[...document.querySelectorAll('button')].find(e=>e.textContent==='保存网络设置')";
  await until(() => read(`${saveButton}?.disabled === false && document.querySelector('#system-network-feedback')?.classList.contains('is-error')`), 'same-value retry after reopen');
  await read(`${saveButton}.id='p2-save'`);
  fs.writeFileSync(path.join(out, 'p2-network-permission-unconfirmed.png'), (await win.webContents.capturePage()).toPNG());
  report.screenshots.push({ file: 'p2-network-permission-unconfirmed.png' });
  await click('#p2-save');
  await until(() => read("document.querySelector('#system-network-feedback').textContent.includes('网络设置已保存')"), 'same-value backend ACK');
  const restored = (await state()).snapshot.network;
  check('same-value retry after reopening confirms strict on the same backend', restored.settings.mode === 'system' &&
    !restored.settings.relaxed && restored.endpointPermissions === 'strict' && backend.connected && report.backendCount === 1);
  cacheServer = track(http.createServer());
  cacheServer.on('request', (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/asset.js' }); res.end(); return; }
    if (req.url === '/update-rejected') {
      res.once('close', () => { report.rejectedUpdateConnectionClosed = true; });
      // Chromium may wait for the first buffered byte before publishing a
      // response event. The updater still rejects before attaching a reader.
      res.writeHead(200, { 'Content-Length': '999', 'Content-Type': 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff' }); res.write('x'); return;
    }
    res.writeHead(200, { 'Content-Type': req.url === '/asset.js' ? 'application/javascript' : 'text/html', 'Cache-Control': 'public,max-age=3600' });
    res.end(req.url === '/asset.js' ? 'window.fixture=true;' + '/* real disk HTTP fixture */'.repeat(180000) : '<!doctype html><script src="/asset.js"></script><h1>Disk cache fixture</h1>');
  });
  const port = await listen(cacheServer);
  const updateResponse = await globalThis.__systemUpdateFetch(`http://127.0.0.1:${port}/redirect`, { redirect: 'manual', credentials: 'omit' });
  check('updater network adapter exposes manual redirect Location without following it', updateResponse.status === 302
    && updateResponse.headers.get('location') === '/asset.js' && updateResponse.ok === false);
  for await (const _chunk of updateResponse.body) {}
  // Keep the real updater's official URL/size/digest authority. Only its
  // transport destination is injected to an offline, header-only fixture.
  const { createAppUpdate } = require(path.join(path.dirname(mainFile), 'app-update.cjs'));
  const updateDirectory = path.join(world, 'rejected-update-cache');
  let rejectedBody;
  const updater = createAppUpdate({ directory: updateDirectory, version: '1.2.2', mode: 'installed',
    readUpdate: async () => ({ ok: true, updateAvailable: true, latestVersion: '1.2.3', release: { tag: 'v1.2.3', assets: [{
      name: 'Pi-GUI-Setup-1.2.3.exe', size: 16, digest: 'sha256:' + createHash('sha256').update('verified fixture').digest('hex'),
      url: 'https://github.com/HYJ1817/pi-gui/releases/download/v1.2.3/Pi-GUI-Setup-1.2.3.exe',
    }] } }),
    fetchImpl: async (_url, options) => {
      const response = await globalThis.__systemUpdateFetch(`http://127.0.0.1:${port}/update-rejected`,
        { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) });
      rejectedBody = response.body; return response;
    },
    prepare: async () => assert.fail('invalid update must not prepare'),
    launch: async () => assert.fail('invalid update must not install'), quit: async () => assert.fail('invalid update must not quit') });
  const rejection = await updater.download({ confirm: true });
  report.rejectedUpdate = { code: rejection.code, phase: updater.state().phase,
    bodyDestroyed: rejectedBody?.destroyed === true, cacheFiles: fs.readdirSync(updateDirectory).length };
  await until(() => report.rejectedUpdateConnectionClosed, 'native update early rejection closes the connection', 10000);
  check('native update header rejection preserves checksum and closes the unread body and connection', rejection.code === 'checksum'
    && updater.state().phase === 'failed' && rejectedBody.destroyed && fs.readdirSync(updateDirectory).length === 0);
  assert.doesNotThrow(() => rejectedBody.emit('error', Error('synthetic late native body error')));
  check('disposed native update safely consumes a synthetic late body error without admitting install', updater.state().phase === 'failed');
  diskWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await diskWindow.loadURL(`http://127.0.0.1:${port}/`);
  await diskWindow.webContents.executeJavaScript("document.cookie='protected=keep;SameSite=Lax';localStorage.setItem('protected','keep')");
  await until(async () => await session.defaultSession.getCacheSize() > 1000000, 'real disk seed');
  await sleep(2000);
  const protectedDigest = hash(path.join(profile, '.uploads/sample.bin'));
  const cacheRefresh = '#system-cache-actions button:first-child';
  const cacheRefreshEnabled = () => read(`!document.querySelector(${JSON.stringify(cacheRefresh)}).disabled`);
  // Reopening Settings auto-measures. The native operation owns its single
  // flight even if the old card was unmounted, so an enabled button is not
  // proof that the native measurement has finished.
  let measured;
  report.cacheMeasureBusyCount = 0;
  await until(async () => {
    measured = await read('window.piGuiDesktop.systemSettings.measureCache()');
    if (measured.code !== 'cache_busy') return true;
    report.cacheMeasureBusyCount++;
    return false;
  }, 'native cache measurement no longer busy', 20000);
  report.cachePreview = measured;
  check('P2 cache counts verified disk and memory separately', measured.ok && measured.diskBytes > 1000000 && Number.isSafeInteger(measured.memoryBytes) && measured.buckets.some(bucket => bucket.id === 'default-session-http-cache' && bucket.diskBytes > 0));
  await until(cacheRefreshEnabled, 'cache refresh available');
  await click(cacheRefresh);
  await until(() => read("!document.querySelector('#system-cache-actions button:first-child').disabled && document.querySelector('#system-cache-size').textContent.includes('磁盘') && !document.querySelector('#system-cache-feedback').classList.contains('is-error')"), 'real cache refresh renders the measured breakdown', 20000);
  // Evaluation can itself warm Chromium Code Cache. Growth must reject the old
  // ticket, not silently broaden it. Re-preview through the same constant
  // script once code compilation has settled; never weaken the native guard.
  const script = '(async()=>{const api=window.piGuiDesktop.systemSettings;const preview=await api.measureCache();return {preview,result:await api.clearCache(preview.ticket)}})()';
  const attempts = []; let result;
  for (let n = 0; n < 3; n++) {
    const attempt = await read(script); attempts.push(attempt); result = attempt.result;
    if (result.diskReleaseConfirmed || result.code !== 'cache_changed') break;
    await sleep(1500);
  }
  report.cacheAttempts = attempts; report.cacheResult = result;
  check('actual Chromium clear confirms physical disk reduction without ignoring growth', result.diskReleaseConfirmed && result.releasedDiskBytes > 1000000 && result.diskBytes < measured.diskBytes);
  check('clear keeps protected business bytes and browser login/local storage', hash(path.join(profile, '.uploads/sample.bin')) === protectedDigest && await diskWindow.webContents.executeJavaScript("document.cookie==='protected=keep' && localStorage.getItem('protected')==='keep'"));
  await click('#system-cache-actions button:first-child'); await until(() => read("!document.querySelector('#system-cache-actions button:first-child').disabled"), 'cache updated UI');
  const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(out, 'p2-cache-disk.png'), image.toPNG()); report.screenshots.push({ file: 'p2-cache-disk.png' });
}
async function main() {
  await app.whenReady(); await until(() => win && win.webContents.getURL() === origin + '/', 'production window');
  await until(() => read("document.querySelector('#connText')?.textContent.includes('已连接')"), 'fake Pi ready');
  const prefs = win.webContents.getLastWebPreferences(); report.sandbox = { sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation };
  check('normal sandbox and production backend run in isolated TEMP', prefs.sandbox && !prefs.nodeIntegration && prefs.contextIsolation &&
    backend.connected && globalThis.__systemRawNetworkGuard &&
    fs.readFileSync(path.join(world, phase + '-offline-backend'), 'utf8') === 'active-raw');
  await read("document.querySelector('#navGlobalMore').click();document.querySelector('#navSystem').click()");
  await until(() => read("document.querySelector('#system-cache-actions') && document.querySelector('.system-path')?.textContent!=='正在读取…'"), 'settings mounted');
  await until(() => read("!document.querySelector('#system-cache-actions button:first-child').disabled"), 'initial production cache statistics');
  console.log('READY P2 settings and initial cache');
  if (phase === 'network-cache') await networkAndCache();
  if (phase === 'prepare-migration') {
    await until(() => read("!document.querySelector('#system-cache-actions button:first-child').disabled"), 'initial cache measure');
    await read("[...document.querySelectorAll('button')].find(e=>e.textContent==='更改路径…').id='p2-change'");
    check('native migration control is supported for default business root', !(await read("document.querySelector('#p2-change').disabled")));
    await click('#p2-change');
    await until(() => read("!document.querySelector('#confirmLayer').hidden || document.querySelector('#system-storage-feedback').classList.contains('is-error')"), 'migration preflight');
    const failed = await read("document.querySelector('#system-storage-feedback').classList.contains('is-error')");
    if (failed) throw Error('migration preview: ' + await read("document.querySelector('#system-storage-feedback').textContent") + '; top names=' + fs.readdirSync(profile).join(','));
    check('native selected target is confirmed with preservation warning', await read("document.querySelector('#confirmCard').textContent.includes('原目录保留为备份')"));
    for (const [theme, width, height] of [['dark',1320,820],['dark',700,600],['light',1320,820],['light',700,600]]) {
      await read(`import('/theme.js').then(m=>m.setThemePreference('${theme}'))`);
      win.setContentSize(width, height);
      await until(() => read(`document.documentElement.dataset.theme==='${theme}'&&Math.abs(innerWidth-${width})<=2&&Math.abs(innerHeight-${height})<=6`), 'migration modal theme and geometry');
      const metrics = await read(`(()=>{const c=document.querySelector('#confirmCard'),r=c.getBoundingClientRect();return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,overflow:c.scrollWidth>c.clientWidth+1,focused:c.contains(document.activeElement)}})()`);
      check(theme + '-' + width + ' actual migration confirmation stays within viewport with focus', metrics.inside && !metrics.overflow && metrics.focused);
      const file = 'p2-migration-' + theme + '-' + width + '.png';
      fs.writeFileSync(path.join(out, file), (await win.webContents.capturePage()).toPNG());
      report.screenshots.push({ file, theme, metrics });
    }
    await exitReady(); await click('#confirmCard .modal-actions button:last-child');
    // The app may quit before this call returns. will-quit records the exit,
    // relaunch, and no-installer witnesses synchronously for the parent.
    return;
  }
  if (phase === 'verify-migration') {
    const info = await state();
    check('new backend reports actual managed root only after cold copy verified', info.snapshot.storage.dataDirectory === target && info.snapshot.storage.source === 'managed' && info.snapshot.storage.phase === 'active');
    const oldFile = path.join(profile, '.uploads/sample.bin'), newFile = path.join(target, '.uploads/sample.bin');
    check('binary attachments keep exact SHA256 and original backup', hash(oldFile) === hash(newFile));
    report.attachmentDigest = hash(newFile); report.attachmentBytes = fs.statSync(newFile).size;
    const oldMetadata = path.join(profile, 'provider-management.json'), newMetadata = path.join(target, 'provider-management.json');
    report.metadataDigest = hash(newMetadata); report.metadataBytes = fs.statSync(newMetadata).size;
    check('provider metadata cold-copies with exact original bytes and retained source backup', hash(oldMetadata) === report.metadataDigest
      && JSON.parse(fs.readFileSync(newMetadata, 'utf8')).services['local-final'].displayName === 'Local migration fixture');
    const agent = process.env.PI_CODING_AGENT_DIR;
    check('Pi native models and auth remain at their original unmodified location', fs.readFileSync(path.join(agent, 'models.json'), 'utf8') === '{"providers":{}}\n'
      && fs.readFileSync(path.join(agent, 'auth.json'), 'utf8') === '{}\n' && !fs.existsSync(path.join(target, 'models.json')) && !fs.existsSync(path.join(target, 'auth.json')));
    check('fixed network and system bootstrap stay outside relocated business root', fs.existsSync(path.join(profile, 'system-network.json')) && fs.existsSync(path.join(profile, 'system-storage-bootstrap.json')) && !fs.existsSync(path.join(target, 'system-network.json')));
  }
  await closeFixtures(); await exitReady(); await read('window.piGuiDesktop.systemSettings.quit()');
}
deadline = setTimeout(() => { report.failed++; report.errors.push('deadline'); save(); app.exit(1); }, 240000);
main().catch(async error => {
  console.error(error.stack); report.failed++; report.errors.push(error.message);
  try { fs.writeFileSync(path.join(out, phase + '-failure.png'), (await win.webContents.capturePage()).toPNG()); report.failureState = await state(); } catch {}
  await closeFixtures(); try { await exitReady(); } catch {} save(); app.exit(1);
});
