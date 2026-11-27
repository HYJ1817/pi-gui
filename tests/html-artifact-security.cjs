'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHtmlArtifactSecurity, safeEnvironment, FRAME_NAME, CHANNELS } = require('../electron/html-artifact-security.cjs');
const ORIGIN = 'http://127.0.0.1:18000';
const TOKEN_HEADER = 'X-Pi-Gui-Token';
const TOKEN = 'synthetic-test-only';
const preferences = { sandbox: true, contextIsolation: true, webSecurity: true,
  nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
  webviewTag: false, allowRunningInsecureContent: false };

function world(options = {}) {
  const session = new EventEmitter(), hooks = {}, handlers = new Map();
  session.webRequest = Object.fromEntries(['onBeforeRequest', 'onBeforeSendHeaders'].map(name =>
    [name, (_filter, handler) => { assert.equal(hooks[name], undefined, 'only one listener per event'); hooks[name] = handler; }]));
  session.setPermissionCheckHandler = handler => { hooks.permissionCheck = handler; };
  session.setPermissionRequestHandler = handler => { hooks.permissionRequest = handler; };
  const wc = new EventEmitter();
  Object.assign(wc, { id: 7, session, isDestroyed: () => false,
    getLastWebPreferences: () => ({ ...preferences, ...options.prefs }),
    setWebRTCIPHandlingPolicy: policy => { wc.rtc = policy; }, getWebRTCIPHandlingPolicy: () => wc.rtc,
    setWindowOpenHandler: handler => { hooks.popup = handler; } });
  const main = { frameTreeNodeId: 1, detached: false, parent: null, name: '', origin: ORIGIN, url: ORIGIN + '/' };
  wc.mainFrame = main;
  main.framesInSubtree = [main];
  main.executeJavaScript = async () => ({ count: main.framesInSubtree.filter(f => f.name === FRAME_NAME).length, valid: true });
  const security = createHtmlArtifactSecurity({ getWindow: () => ({ webContents: wc }), origin: ORIGIN,
    argv: [], execArgv: [], env: {}, registrationTimeoutMs: 40, pollIntervalMs: 1, ...options });
  security.installSessionGuards(session);
  security.attachWebContents(wc);
  security.installIpc({ handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) });
  if (options.installRequests !== false) security.installRequestGuards(session, {
    token: TOKEN, tokenHeader: TOKEN_HEADER, backendConnected: () => options.connected !== false,
  });
  const event = { sender: wc, senderFrame: main };
  const add = (id = 2, parent = main, name = FRAME_NAME) => {
    const frame = { frameTreeNodeId: id, detached: false, parent, name, origin: 'null', url: 'about:blank' };
    main.framesInSubtree.push(frame); return frame;
  };
  const request = (frame = main, extra = {}) => ({ frame, webContents: wc, webContentsId: wc.id,
    url: ORIGIN + '/api/status', resourceType: 'xhr', method: 'GET', initiatorOrigin: frame.origin,
    requestHeaders: { 'x-pi-gui-token': 'spoof', [TOKEN_HEADER]: 'spoof2', Accept: 'application/json' }, ...extra });
  const hook = (name, details) => { let calls = 0, result; hooks[name](details, value => { calls++; result = value; }); assert.equal(calls, 1); return result; };
  return { security, wc, main, event, add, request, hook, hooks, session, handlers };
}
const register = w => w.security.registerFrame(w.event, { name: FRAME_NAME });

test('only the actual trusted main frame authenticates and reaches guarded IPC', () => {
  const w = world(), child = w.add(), guard = w.security.guardHandler(() => 'allowed');
  assert.equal(w.security.isTrustedSender(w.event), true);
  assert.equal(guard(w.event), 'allowed');
  for (const event of [{}, { sender: {}, senderFrame: w.main }, { sender: w.wc, senderFrame: child },
    { sender: w.wc, senderFrame: { ...w.main } }, { sender: w.wc, senderFrame: null }]) {
    assert.equal(w.security.isTrustedSender(event), false);
    assert.equal(guard(event).code, 'untrusted_sender');
  }
  w.main.origin = 'null'; assert.equal(w.security.isTrustedSender(w.event), false);
});

test('trusted main API works; all header spellings are stripped before injection', () => {
  const w = world();
  assert.equal(w.hook('onBeforeRequest', w.request()).cancel, false);
  assert.deepEqual(w.hook('onBeforeSendHeaders', w.request()).requestHeaders,
    { Accept: 'application/json', [TOKEN_HEADER]: TOKEN });
});

test('external redirect hops and non-artifact Office children never carry token', () => {
  const w = world(), office = w.add(3, w.main, 'office');
  for (const details of [w.request(w.main, { url: 'https://external.invalid/' }),
    w.request(office), w.request(w.main, { resourceType: 'subFrame' })]) {
    const result = w.hook('onBeforeSendHeaders', details);
    assert.equal(result.cancel, undefined);
    assert.equal(Object.keys(result.requestHeaders).some(k => k.toLowerCase() === TOKEN_HEADER.toLowerCase()), false);
  }
});

test('initial native load is allowed but opaque top initiators are rejected', () => {
  const w = world(); w.main.url = ''; w.main.origin = 'null';
  assert.equal(w.security.canAuthenticateRequest(w.request(w.main, { resourceType: 'mainFrame', initiatorOrigin: undefined })), true);
  for (const initiatorOrigin of ['null', 'https://external.invalid']) {
    assert.equal(w.security.shouldBlockRequest(w.request(w.main, { resourceType: 'mainFrame', initiatorOrigin })), true);
  }
});

test('artifact and descendants deny every scheme/resource without returning token', async () => {
  const w = world(), frame = w.add(); assert.equal((await register(w)).javascriptEnabled, true);
  frame.name = 'renamed'; frame.url = 'about:srcdoc';
  const nested = w.add(4, frame, 'different');
  for (const target of [frame, nested]) for (const url of [ORIGIN + '/api/status', 'http://localhost:18000/',
    'http://10.0.0.1/', 'http://192.168.1.1/', 'https://external.invalid/', 'file:///synthetic',
    'ws://127.0.0.1:18000/', 'data:text/html,x', 'blob:http://127.0.0.1:18000/id']) {
    for (const resourceType of ['xhr', 'image', 'script', 'ping', 'subFrame', 'webSocket', 'media', 'stylesheet', 'other']) {
      const details = w.request(target, { url, resourceType, initiatorOrigin: ORIGIN });
      assert.equal(w.hook('onBeforeRequest', details).cancel, true);
      assert.deepEqual(w.hook('onBeforeSendHeaders', details), { cancel: true });
    }
  }
});

test('unregistered named, unknown, detached and foreign frames fail closed', () => {
  const w = world(), named = w.add();
  for (const frame of [named, undefined, { ...w.main, detached: true }, { ...w.main, parent: {}, frameTreeNodeId: 9 }]) {
    assert.equal(w.security.shouldBlockRequest(w.request(frame, { frame })), true);
  }
  assert.equal(w.security.shouldBlockRequest(w.request(w.main, { webContents: {}, webContentsId: 7 })), true);
  const broken = { get frameTreeNodeId() { throw Error('disposed'); } };
  assert.equal(w.security.shouldBlockRequest(w.request(broken)), true);
});

test('existing disconnected backend install restrictions are composed, not overwritten', () => {
  const w = world({ connected: false });
  for (const host of [ORIGIN, 'http://localhost:18000']) for (const pathname of ['/api/environment/install', '/api/environment/pi-path']) {
    assert.equal(w.hook('onBeforeRequest', w.request(w.main, { url: host + pathname, method: 'POST' })).cancel, true);
  }
  assert.equal(w.hook('onBeforeRequest', w.request()).cancel, false);
});

test('fixed name supports multiple frames and idempotent registration', async () => {
  const w = world(), a = w.add(), b = w.add(3);
  assert.deepEqual(await register(w), { ok: true, javascriptEnabled: true });
  a.url = b.url = 'about:srcdoc';
  assert.equal((await register(w)).ok, true);
  assert.equal(w.security.isArtifactFrame(a, w.wc), true);
  assert.equal(w.security.isArtifactFrame(b, w.wc), true);
});

test('registration waits for actual DOM/frame-tree agreement instead of acknowledging an old frame', async () => {
  const w = world(); w.add(); assert.equal((await register(w)).ok, true);
  w.main.executeJavaScript = async () => ({ count: 2, valid: true });
  const pending = register(w); let settled = false; pending.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 4)); assert.equal(settled, false);
  w.add(3); assert.equal((await pending).ok, true);
});

test('registration accepts only exact closed requests from actual senderFrame', async () => {
  const w = world(), frame = w.add();
  for (const request of [undefined, {}, { name: 'random' }, { name: FRAME_NAME, frameId: 2 }, [FRAME_NAME]]) {
    assert.equal((await w.security.registerFrame(w.event, request)).ok, false);
  }
  assert.equal((await w.security.registerFrame({ sender: w.wc, senderFrame: frame }, { name: FRAME_NAME })).code, 'untrusted_sender');
});

test('nonblank, nested, same-origin or unsafe DOM candidates do not receive capability', async () => {
  for (const mutate of [w => { w.add().url = 'about:srcdoc'; }, w => { w.add().origin = ORIGIN; },
    w => { const p = w.add(3, w.main, 'parent'); w.add(4, p); },
    w => { w.add(); w.main.executeJavaScript = async () => ({ count: 1, valid: false }); }]) {
    const w = world(); mutate(w); assert.equal((await register(w)).ok, false);
  }
});

test('missing or hung frame inspection times out and disposal resolves pending registrations', async () => {
  const w = world({ registrationTimeoutMs: 12 });
  assert.equal((await register(w)).ok, false);
  w.main.executeJavaScript = () => new Promise(() => {});
  assert.equal((await register(w)).code, 'unavailable');
  const pending = register(w); w.security.dispose(); assert.equal((await pending).ok, false);
  assert.equal(w.handlers.size, 0);
});

test('sandbox, security, node, worker, webview and insecure-content preferences all fail closed', async () => {
  for (const [key, value] of Object.entries(preferences)) {
    const w = world({ prefs: { [key]: !value } }); w.add();
    assert.equal((await register(w)).code, 'unsafe_environment', key);
  }
});

test('unsafe argv, execArgv, commandLine and environment disable executable capability', async () => {
  for (const options of [{ argv: ['--no-sandbox'] }, { execArgv: ['--disable-web-security=true'] },
    { hasSwitch: name => name === 'remote-debugging-port' }, { hasSwitch: () => undefined },
    { argv: ['--inspect'] }, { env: { NODE_OPTIONS: '--inspect-brk=127.0.0.1:0' } },
    { env: { ELECTRON_DISABLE_SANDBOX: '1' } }]) {
    const w = world(options); w.add(); assert.equal((await register(w)).code, 'unsafe_environment');
  }
  assert.equal(safeEnvironment({}, { argv: [], execArgv: [], env: {}, hasSwitch: () => false }), false);
});

test('only one parent-initiated initial srcdoc is allowed; rename/release never shed live guards', async () => {
  const w = world(), frame = w.add(); await register(w);
  const event = { frame, initiator: w.main, url: 'about:srcdoc' };
  assert.equal(w.security.shouldBlockNavigation(w.wc, event), false);
  assert.equal(w.security.shouldBlockNavigation(w.wc, event), true);
  frame.name = 'renamed'; frame.url = 'about:srcdoc';
  assert.equal(w.security.releaseFrame(w.event, { name: FRAME_NAME }).ok, true);
  assert.equal(w.security.shouldBlockRequest(w.request(frame)), true);
  for (const url of [ORIGIN, 'about:blank', 'data:text/html,x', 'file:///synthetic', 'https://external.invalid/']) {
    assert.equal(w.security.shouldBlockNavigation(w.wc, { frame, initiator: frame, url }), true);
    assert.equal(w.security.shouldBlockNavigation(w.wc, { frame: w.main, initiator: frame, url }), true);
  }
  assert.equal(w.security.canOpenExternal(w.wc, { frame: w.main, initiator: frame, url: 'https://external.invalid/' }), false);
});

test('a committed initial document spends only the matching frame node allowance', async () => {
  const w = world();
  const loaded = Object.assign(w.add(2), { processId: 11, routingId: 7 });
  const pending = Object.assign(w.add(3), { processId: 12, routingId: 7 });
  w.main.frames = [pending, loaded];
  assert.deepEqual(await register(w), { ok: true, javascriptEnabled: true });

  // Chromium can commit an internal document without a cancellable request event.
  loaded.url = 'about:srcdoc';
  w.wc.emit('did-frame-navigate', {}, loaded.url, -1, '', false, loaded.processId, loaded.routingId);
  loaded.url = 'about:blank';

  assert.equal(w.security.shouldBlockNavigation(w.wc, { frame: pending, initiator: w.main, url: 'about:srcdoc' }), false);
  assert.equal(w.security.shouldBlockNavigation(w.wc, { frame: loaded, initiator: w.main, url: 'about:srcdoc' }), true);
});

test('a replacement document on a registered frame node retains its restrictions', async () => {
  const w = world();
  const frame = w.add();
  assert.deepEqual(await register(w), { ok: true, javascriptEnabled: true });
  assert.equal(w.security.shouldBlockNavigation(w.wc, { frame, initiator: w.main, url: 'about:srcdoc' }), false);

  // Model Chromium replacing the live document without changing its frame node.
  const replacement = { ...frame, name: '', url: 'about:blank' };
  w.main.framesInSubtree = [w.main, replacement];

  assert.equal(w.security.isArtifactFrame(replacement, w.wc), true);
  assert.equal(w.security.shouldBlockNavigation(w.wc,
    { frame: replacement, initiator: w.main, url: 'about:srcdoc' }), true);
  assert.deepEqual(w.hook('onBeforeRequest', w.request(replacement)), { cancel: true });
  assert.deepEqual(w.hook('onBeforeSendHeaders', w.request(replacement)), { cancel: true });
  const guarded = w.security.guardHandler(() => assert.fail('child reached the IPC handler'));
  assert.deepEqual(guarded({ sender: w.wc, senderFrame: replacement }), { ok: false, code: 'untrusted_sender' });
  assert.deepEqual(w.hook('onBeforeSendHeaders', w.request(w.main)).requestHeaders,
    { Accept: 'application/json', [TOKEN_HEADER]: TOKEN });
});

test('native guards deny redirects, missing initiators, popups and webviews', async () => {
  const w = world(), frame = w.add(); await register(w);
  assert.equal(w.security.shouldBlockNavigation(w.wc, { frame, initiator: w.main, url: 'about:srcdoc' }, true), true);
  assert.equal(w.security.shouldBlockNavigation(w.wc, { frame: w.main, url: ORIGIN }), true);
  assert.equal(w.security.canOpenExternal(w.wc, { frame: w.main, initiator: w.main, url: 'https://external.invalid/' }), true);
  assert.deepEqual(w.hooks.popup({ url: 'https://external.invalid/' }), { action: 'deny' });
  let prevented = false; w.wc.emit('will-attach-webview', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});

test('permission requests/checks cannot claim main authority from a child origin', () => {
  const w = world(), good = { requestingUrl: ORIGIN + '/', isMainFrame: true };
  assert.equal(w.hooks.permissionCheck(w.wc, 'media', ORIGIN, good), true);
  for (const details of [undefined, { ...good, isMainFrame: false }, { ...good, requestingUrl: 'about:srcdoc' }]) {
    assert.equal(w.hooks.permissionCheck(w.wc, 'media', ORIGIN, details), false);
    let allowed; w.hooks.permissionRequest(w.wc, 'media', value => { allowed = value; }, details);
    assert.equal(allowed, false);
  }
});

test('downloads denied while live artifacts exist, resume after removal; disposal retains guards', async () => {
  const w = world(), frame = w.add(); await register(w);
  const prevented = () => { let deny = false; w.session.emit('will-download', { preventDefault() { deny = true; } }, {}, w.wc); return deny; };
  assert.equal(prevented(), true);
  w.security.releaseFrame(w.event, { name: FRAME_NAME }); assert.equal(prevented(), true);
  frame.detached = true; w.main.framesInSubtree = [w.main];
  w.security.releaseFrame(w.event, { name: FRAME_NAME }); assert.equal(prevented(), false);
  w.security.dispose(); assert.equal(w.security.shouldBlockRequest(w.request()), true);
});

test('missing request guards never acknowledge JS capability and repeated installation cannot overwrite hooks', async () => {
  const absent = world({ installRequests: false }); absent.add();
  assert.equal((await register(absent)).code, 'unsafe_environment');
  const w = world();
  assert.throws(() => w.security.installRequestGuards(w.session, {
    token: 'other', tokenHeader: TOKEN_HEADER, backendConnected: () => true,
  }));
  assert.equal(w.hook('onBeforeSendHeaders', w.request()).requestHeaders[TOKEN_HEADER], TOKEN);
});

test('bounded pending registrations are cancelled without leaving timers or authority', async () => {
  const w = world({ registrationTimeoutMs: 100 }); w.add();
  w.main.executeJavaScript = () => new Promise(() => {});
  const pending = Array.from({ length: 32 }, () => register(w));
  assert.equal((await register(w)).code, 'registration_busy');
  w.security.dispose();
  assert.equal((await Promise.all(pending)).every(result => result.ok === false), true);
});

test('renaming an existing frame cannot block sibling registration or release its identity', async () => {
  const w = world(), a = w.add(); await register(w); a.name = 'changed'; a.url = 'about:srcdoc';
  w.add(3); w.main.executeJavaScript = async () => ({ count: 2, valid: true });
  assert.equal((await register(w)).ok, true);
  assert.equal(w.security.isArtifactFrame(a, w.wc), true);
});

function loadPreload(isMainFrame, topIsSelf = true) {
  let bridge, required = false;
  const bridges = {};
  const invokes = [], window = {};
  window.top = topIsSelf ? window : {};
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { bridges[name] = value; if (name === 'piGuiDesktop') bridge = value; } },
    ipcRenderer: { on() {}, invoke: (...args) => { invokes.push(args); return Promise.resolve({ ok: true }); } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    process: { isMainFrame, argv: [] }, window,
    require: name => { assert.equal(name, 'electron'); required = true; return electron; },
  });
  return { bridge, bridges, invokes, required };
}

test('subframe and unknown-frame preloads never even import Electron or expose any bridge', () => {
  for (const [main, top] of [[false, false], [false, true], [undefined, true], [true, false]]) {
    const result = loadPreload(main, top);
    assert.equal(result.bridge, undefined); assert.equal(result.required, false);
    assert.deepEqual(Object.keys(result.bridges), []);
  }
});

test('main preload keeps one bridge and its htmlArtifacts channels project request fields', async () => {
  const { bridge, bridges, invokes } = loadPreload(true);
  assert.deepEqual(Object.keys(bridges), ['piGuiDesktop']);
  assert.equal(bridge.isDesktop, true);
  const artifacts = bridge.htmlArtifacts;
  await artifacts.registerFrame({ name: FRAME_NAME, channel: 'arbitrary', frameId: 2, html: 'untrusted' });
  await artifacts.releaseFrame({ name: FRAME_NAME, frameId: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(invokes)), [[CHANNELS.register, { name: FRAME_NAME }], [CHANNELS.release, { name: FRAME_NAME }]]);
  assert.deepEqual(Object.keys(artifacts).sort(), ['registerFrame', 'releaseFrame']);
});

test('production wiring retains one composed request policy and explicit host preferences', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(main, /htmlArtifactSecurity\.installRequestGuards\(session\.defaultSession/);
  assert.match(main, /token: AUTH_TOKEN, tokenHeader: TOKEN_HEADER, backendConnected:/);
  assert.doesNotMatch(main, /webRequest\.onBefore(?:Request|SendHeaders)\(/);
  assert.match(main, /ipcMain\.handle\(channel, htmlArtifactSecurity\.guardHandler\(handler\)\)/);
  for (const [key, value] of Object.entries(preferences)) assert.match(main, new RegExp(key + ': ' + value));
  assert.match(main, /if \(isBrowserWebContents\(wc\)\) return/);
  assert.match(main, /session\.fromPartition\(CREDENTIAL_SHEET_PARTITION\)/);
});
