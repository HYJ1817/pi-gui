'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHtmlPreviewService, HTML_PREVIEW_LIMITS } = require('../electron/html-preview-service.cjs');
const { mountStaticPreview } = require('../electron/html-preview-static.cjs');

let clientModule;
async function clientFactory() {
  clientModule ??= await import('../server/html-preview-client.js');
  return clientModule.createHtmlPreviewClient;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function png(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const pixels = zlib.deflateSync(Buffer.alloc((width * 4 + 1) * height));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function resultFor(request) {
  const image = png(request.width, request.height);
  return {
    schemaVersion: 1, ok: true, width: request.width, height: request.height,
    contentWidth: request.width, contentHeight: request.height,
    screenshot: { mimeType: 'image/png', data: image.toString('base64'), width: request.width, height: request.height },
    diagnostics: { console: [], errors: [], resources: [], warnings: [] },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function wire(render, options = {}) {
  const child = new EventEmitter();
  child.connected = true;
  const port = new EventEmitter();
  port.connected = true;
  port.send = (message, callback) => {
    setImmediate(() => child.emit('message', message));
    if (callback) setImmediate(() => callback(null));
  };
  child.send = (message, callback) => {
    setImmediate(() => port.emit('message', message));
    if (callback) setImmediate(() => callback(null));
  };
  const service = createHtmlPreviewService({ render, ...options });
  service.attach(child);
  const createClient = await clientFactory();
  const client = createClient({ processRef: port });
  return { child, port, service, client };
}
function input(html = '<p>offline</p>') { return { html, width: 240, height: 80, theme: 'dark' }; }
function nativeRuntimeFixture(exposedRealm) {
  const calls = [], windows = [];
  const previewSession = new EventEmitter();
  previewSession.webRequest = { onBeforeRequest() {}, onErrorOccurred() {} };
  previewSession.setPermissionRequestHandler = () => {};
  previewSession.setPermissionCheckHandler = () => {};
  previewSession.clearCache = async () => {};
  previewSession.clearStorageData = async () => {};
  const names = ['pi-gui-preview-rtc-blank', 'pi-gui-preview-rtc-srcdoc', 'pi-gui-preview-rtc-nested-srcdoc'];
  class MockWindow {
    constructor(options) {
      this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        session: previewSession,
        setWindowOpenHandler() {},
        getLastWebPreferences: () => options.webPreferences,
        executeJavaScript: async expression => { calls.push(expression); return {}; },
        mainFrame: { framesInSubtree: names.map((name, index) => ({
          name, url: index === 0 ? 'about:blank' : 'about:srcdoc',
          executeJavaScript: async () => new Proxy({}, { get: (_value, key) => {
            if (key === 'outerScriptRan' || key === 'nestedScriptRan') return true;
            return index === exposedRealm && key === 'RTCPeerConnection' ? 'function' : 'undefined';
          } }),
        })) },
      });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    async loadURL() {}
  }
  return { BrowserWindow: MockWindow, session: { fromPartition: () => previewSession },
    hasSwitch: () => false, argv: [], execArgv: [], env: {}, calls, windows };
}

for (const uncertain of [false, true]) test(uncertain
  ? 'unproven native isolation remains static, including later requests'
  : 'falls back to a separate JavaScript-disabled window after native isolation fails', async () => {
  const html = '<p>Static preview fixture</p><script>document.body.dataset.ran = "yes"</script>';
  const fixture = nativeRuntimeFixture(0);
  const staticCalls = [];
  const first = fixture.BrowserWindow;
  class Window extends first {
    constructor(options) {
      super(options);
      this.options = options;
      if (uncertain) this.webContents.mainFrame.framesInSubtree = [];
      this.webContents.debugger = {
        attach() {}, detach() {}, isAttached: () => true,
        sendCommand: async (method, params) => {
          staticCalls.push([method, params]);
          return method === 'Page.captureScreenshot' ? { data: png(240, 80).toString('base64') }
            : { result: { value: { width: 240, height: 80, ready: true, missingImages: 0 } } };
        },
      };
    }
    setContentSize() {}
  }
  const { client, service } = await wire(undefined, { ...fixture, BrowserWindow: Window });
  try {
    const result = await client.preview(input(html));
    assert.equal(fixture.windows.length, 2);
    assert.equal(fixture.windows[1].options.webPreferences.javascript, false);
    assert.equal(fixture.windows[1].options.webPreferences.offscreen, true);
    assert.ok(fixture.windows.every(window => window.isDestroyed()));
    assert.ok(result.diagnostics.warnings.includes('page_javascript_disabled'));
    assert.equal(fixture.calls.some(expression => expression.includes(html)), false);
    assert.ok(staticCalls.some(([method, params]) => method === 'Runtime.evaluate' && params.expression.includes('Static preview fixture')));
    if (uncertain) {
      const second = await client.preview(input(html));
      assert.equal(fixture.windows.length, 3, 'later request does not re-run the failed interactive qualification');
      assert.equal(fixture.windows[2].options.webPreferences.javascript, false);
      assert.ok(second.diagnostics.warnings.includes('page_scripts_not_executed'));
    }
  } finally { client.dispose(); service.dispose(); }
});

test('static rendering mounts presentation from an inert template', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
  try {
    const args = ['<main><h1>Comparison</h1><script>document.body.dataset.ran = "yes"</script>'
      + '<svg viewBox="0 0 80 20"><rect width="10" height="20"/></svg><iframe title="unneeded"></iframe>'
      + '<form><fieldset><input type="password" value="fixture-value"><input type="checkbox" checked>'
      + '<input type="file" value="fixture-name"><p hidden>Hidden row</p></fieldset></form></main>',
    ':root { --ds-bg-primary: #222; }', 'dark', { background: '--ds-bg-primary' }, "default-src 'none'; style-src 'unsafe-inline'"];
    assert.equal(dom.window.eval(`(${mountStaticPreview})(${args.map(arg => JSON.stringify(arg)).join(',')})`), true);
    const { document } = dom.window;
    assert.equal(document.querySelector('h1').textContent, 'Comparison');
    assert.equal(document.querySelector('svg').getAttribute('viewBox'), '0 0 80 20');
    assert.equal(document.querySelector('script, iframe'), null);
    assert.equal(document.body.dataset.ran, undefined);
    assert.equal(document.documentElement.style.getPropertyValue('--background'), '#222');
    assert.equal(document.querySelector('form fieldset input[type=password]').value, '');
    assert.equal(document.querySelector('input[type=checkbox]').checked, true);
    assert.equal(document.querySelector('input[type=file]'), null);
    assert.equal(document.body.innerHTML.includes('fixture-name'), false);
    assert.equal(document.querySelector('fieldset p').hidden, true);
  } finally { dom.window.close(); }
});
async function rejectCode(promise, code) {
  await assert.rejects(promise, error => error?.code === code);
}

test('page JavaScript errors expose generated descriptions and bounded page locations, never raw values', async () => {
  const { scriptDiagnostic, validDiagnostics } = require('../lib/html-preview-diagnostics.cjs');
  const cases = [
    ['Uncaught ReferenceError: PRIVATE_KEY_CANARY is not defined', 'ReferenceError', 'undefined_identifier'],
    ['Uncaught TypeError: Cannot read properties of null (reading PRIVATE_KEY_CANARY)', 'TypeError', 'null_property'],
    ['Uncaught TypeError: Cannot read properties of undefined (reading PRIVATE_KEY_CANARY)', 'TypeError', 'undefined_property'],
    ['Uncaught TypeError: PRIVATE_KEY_CANARY is not a function', 'TypeError', 'not_callable'],
    ['Uncaught SyntaxError: PRIVATE_KEY_CANARY', 'SyntaxError', 'syntax'],
    ['Uncaught RangeError: PRIVATE_KEY_CANARY', 'RangeError', 'range'],
    ['Uncaught (in promise) Error: file:///C:/PRIVATE_KEY_CANARY', 'Error', 'script_exception'],
  ];
  for (const [text, name, reason] of cases) {
    const error = scriptDiagnostic(text, 42, 'about:srcdoc');
    assert.equal(error.name, name);
    assert.equal(error.reason, reason);
    assert.deepEqual(error.location, { source: 'rendered_document', line: 42 });
    assert.equal(JSON.stringify(error).includes('PRIVATE_KEY_CANARY'), false);
    assert.ok(error.description.length <= 200);
    const { client, service } = await wire(async task => {
      const result = resultFor(task.request); result.diagnostics.errors.push(error); return result;
    });
    try { assert.deepEqual((await client.preview(input())).diagnostics.errors, [error]); }
    finally { client.dispose(); service.dispose(); }
    assert.equal(validDiagnostics({ ...resultFor(input()).diagnostics, errors: [{ ...error, description: text }] }), false);
    assert.equal(validDiagnostics({ ...resultFor(input()).diagnostics, errors: [{ ...error, stack: text }] }), false);
  }
  assert.equal(scriptDiagnostic('Uncaught TypeError: host secret', 1, 'file:///host/private.js'), null);
  assert.equal(scriptDiagnostic('private console arguments', 1, 'about:srcdoc'), null);
  assert.equal(scriptDiagnostic('Uncaught Error: secret', 1_000_001, 'about:srcdoc').location, undefined);
});

test('unknown uncaught page exceptions retain generic diagnostics without copying thrown values', async () => {
  const { scriptDiagnostic, validDiagnostics } = require('../lib/html-preview-diagnostics.cjs');
  const cases = [
    'Uncaught InvalidCharacterError: PRIVATE_KEY_CANARY',
    'Uncaught CustomError: PRIVATE_KEY_CANARY',
    'Uncaught PRIVATE_KEY_CANARY',
    'Uncaught (in promise) #<Object> PRIVATE_KEY_CANARY',
  ];
  for (const text of cases) {
    const error = scriptDiagnostic(text, 42, 'about:srcdoc');
    assert.deepEqual(error, { code: 'script_error' });
    assert.equal(scriptDiagnostic(text, 42, 'file:///host/PRIVATE_KEY_CANARY.js'), null);
    assert.equal(validDiagnostics({ ...resultFor(input()).diagnostics, errors: [error] }), true);
    const { client, service } = await wire(async task => {
      const result = resultFor(task.request); result.diagnostics.errors.push(error); return result;
    });
    try { assert.deepEqual((await client.preview(input())).diagnostics.errors, [{ code: 'script_error' }]); }
    finally { client.dispose(); service.dispose(); }
  }
});

test('static resource and layout diagnostics stay closed and bounded across private IPC', async () => {
  const { client, service } = await wire(async task => {
    const result = resultFor(task.request);
    result.diagnostics.errors = [{ code: 'image_decode_failed', type: 'image' }, { code: 'font_load_failed', type: 'font' }];
    result.diagnostics.warnings = ['page_javascript_disabled', 'native_network_isolation_unavailable', 'page_scripts_not_executed',
      'dynamic_content_not_measured', 'fonts_unavailable', 'content_width_overflows_viewport', 'layout_settle_timeout'];
    return result;
  });
  try { assert.equal((await client.preview(input())).diagnostics.errors.length, 2); }
  finally { client.dispose(); service.dispose(); }
});

test('live evidence recognizes only PNG image blocks and never manufactures vision success', () => {
  const proof = require('./fixtures/html-preview-live-proof.cjs');
  const challenge = proof.createChallenge();
  assert.match(challenge.code, /^\d{4}$/);
  assert.equal(Buffer.from(challenge.data, 'base64').includes(Buffer.from(challenge.code)), false);
  const blocks = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: challenge.data } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + challenge.data } },
    { type: 'input_image', image_url: 'data:image/png;base64,' + challenge.data },
    { type: 'image', mimeType: 'image/png', data: challenge.data },
  ];
  for (const block of blocks) {
    const images = proof.providerImages({ nested: { content: [block] } });
    assert.equal(images.length, 1); assert.equal(images[0].sha256, challenge.sha256);
    assert.equal(images[0].width, 180); assert.equal(images[0].height, 70);
  }
  assert.equal(proof.providerImages({ content: blocks }).length, 1, 'repeated payload image is not counted twice');
  assert.deepEqual(proof.providerImages({ type: 'text', text: challenge.data, token: 'PRIVATE_CANARY' }), []);
  assert.deepEqual(proof.providerImages({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW52YWxpZA==' } }), []);
});

test('bounds requests and returns a strictly validated in-memory PNG result', async () => {
  const { client, service } = await wire(async task => resultFor(task.request));
  try {
    const output = await client.preview(input());
    assert.deepEqual(Object.keys(output), ['schemaVersion', 'ok', 'width', 'height', 'contentWidth', 'contentHeight', 'screenshot', 'diagnostics']);
    assert.equal(output.screenshot.mimeType, 'image/png');
    assert.equal(Buffer.from(output.screenshot.data, 'base64').readUInt32BE(16), 240);
    assert.equal(output.screenshot.data.length <= Math.ceil(HTML_PREVIEW_LIMITS.pngBytes / 3) * 4, true);
    assert.equal(service.getState().active, 0);
    await rejectCode(client.preview(input('x'.repeat(HTML_PREVIEW_LIMITS.htmlBytes + 1))), 'html_preview_failed');
    await rejectCode(client.preview({ ...input(), width: 1601 }), 'html_preview_failed');
    await rejectCode(client.preview({ ...input(), height: 79 }), 'html_preview_failed');
  } finally { client.dispose(); service.dispose(); }
});

test('service rejects malformed child IPC before invoking the renderer', async () => {
  let renders = 0;
  const { child, port, service, client } = await wire(async () => { renders++; throw Error('unexpected_render'); });
  try {
    const response = new Promise(resolve => port.once('message', resolve));
    child.emit('message', { type: 'html-preview-request', id: 41, html: '<p>no</p>', width: 240, height: 80, theme: 'dark', extra: 'rejected' });
    assert.deepEqual(await response, { type: 'html-preview-result', id: 41, ok: false, code: 'html_preview_failed' });
    assert.equal(renders, 0);
  } finally { client.dispose(); service.dispose(); }
});

test('service and client reject a malformed screenshot result', async () => {
  const { client, service } = await wire(async task => {
    const result = resultFor(task.request);
    result.screenshot.data = 'not-a-png';
    return result;
  });
  try { await rejectCode(client.preview(input()), 'html_preview_failed'); }
  finally { client.dispose(); service.dispose(); }
});

test('client rejects forged result payloads that exceed the diagnostic contract', async () => {
  const createClient = await clientFactory();
  const port = new EventEmitter();
  port.connected = true;
  let request;
  port.send = (message, callback) => { request = message; callback?.(null); };
  const client = createClient({ processRef: port });
  try {
    const pending = client.preview(input());
    const result = resultFor(input());
    port.emit('message', { type: 'html-preview-result', id: request.id, ...result,
      diagnostics: { ...result.diagnostics, console: [{ level: 'error', text: 'untrusted payload' }] } });
    await rejectCode(pending, 'html_preview_failed');
  } finally { client.dispose(); }
});

test('bounds active work and queue, then starts accepted work in order', async () => {
  const gate = deferred(), started = [];
  const { client, service } = await wire(async task => {
    started.push(task.request.html);
    if (task.request.html === 'first') await gate.promise;
    return resultFor(task.request);
  });
  try {
    const first = client.preview(input('first'));
    while (!started.length) await new Promise(resolve => setImmediate(resolve));
    const second = client.preview(input('second'));
    const third = client.preview(input('third'));
    await rejectCode(client.preview(input('rejected-fourth')), 'html_preview_busy');
    gate.resolve();
    await Promise.all([first, second, third]);
    assert.deepEqual(started, ['first', 'second', 'third']);
    assert.deepEqual(service.getState(), { active: 0, queued: 0, attachedChildren: 1, disposed: false });
  } finally { client.dispose(); service.dispose(); }
});

test('only registered ephemeral preview sessions are marked as service-owned', async () => {
  let service, previewContents;
  const { client, service: attachedService } = await wire(async (task, { registerSession, unregisterSession }) => {
    const previewSession = {};
    previewContents = { session: previewSession };
    registerSession(previewSession);
    assert.equal(service.ownsWebContents(previewContents), true);
    unregisterSession(previewSession);
    assert.equal(service.ownsWebContents(previewContents), false);
    return resultFor(task.request);
  });
  service = attachedService;
  try {
    await client.preview(input());
    assert.equal(service.ownsWebContents(previewContents), false);
  } finally { client.dispose(); service.dispose(); }
});

test('client abort sends cancel and service invokes the active render abort hook', async () => {
  const entered = deferred();
  let abortCalled = false;
  const { client, service } = await wire((task) => {
    const pending = deferred();
    entered.resolve();
    task.abortRender = code => { abortCalled = code === 'html_cancelled'; pending.reject(Object.assign(Error('cancelled'), { code })); };
    return pending.promise;
  });
  const controller = new AbortController();
  try {
    const pending = client.preview(input(), { signal: controller.signal });
    await entered.promise;
    controller.abort();
    await rejectCode(pending, 'html_cancelled');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(abortCalled, true);
  } finally { client.dispose(); service.dispose(); }
});

test('server render timeout destroys active work and reports a controlled timeout', async () => {
  const entered = deferred();
  let abortCalled = false;
  const { client, service } = await wire(task => {
    entered.resolve();
    task.abortRender = code => { abortCalled = code === 'html_preview_timeout'; };
    return new Promise(() => {});
  }, { renderTimeoutMs: 20, cleanupWaitMs: 5 });
  try {
    const pending = client.preview(input());
    await entered.promise;
    await rejectCode(pending, 'html_preview_timeout');
    assert.equal(abortCalled, true);
  } finally { client.dispose(); service.dispose(); }
});

test('cancelling a queued request removes it without occupying the renderer', async () => {
  const gate = deferred(), entered = deferred(), started = [];
  const { client, service } = await wire(async task => {
    started.push(task.request.html);
    if (task.request.html === 'active') { entered.resolve(); await gate.promise; }
    return resultFor(task.request);
  });
  const controller = new AbortController();
  try {
    const active = client.preview(input('active'));
    await entered.promise;
    const queued = client.preview(input('queued'), { signal: controller.signal });
    while (!service.getState().queued) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await rejectCode(queued, 'html_cancelled');
    while (service.getState().queued) await new Promise(resolve => setImmediate(resolve));
    gate.resolve();
    await active;
    assert.deepEqual(started, ['active']);
    assert.equal(service.getState().queued, 0);
  } finally { client.dispose(); service.dispose(); }
});

for (const [index, realm] of ['fresh about:blank', 'direct srcdoc', 'nested srcdoc'].entries()) {
  test(`native qualification rejects exposed RTC in ${realm} before passing HTML to Chromium`, async () => {
    const fixture = nativeRuntimeFixture(index);
    const { client, service } = await wire(undefined, { ...fixture, staticFallback: false });
    try {
      const html = '<p>fixture-payload-must-never-be-parsed</p>';
      await rejectCode(client.preview(input(html)), 'html_preview_unavailable');
      assert.equal(fixture.windows.length, 1);
      assert.equal(fixture.windows[0].isDestroyed(), true);
      assert.equal(fixture.calls.some(expression => expression.includes(html)), false);
      assert.equal(fixture.calls.some(expression => expression.startsWith('window.__piGuiHtmlPreviewAttach(')), false);
      assert.equal(service.getState().active, 0);
      assert.equal(service.ownsWebContents(fixture.windows[0].webContents), false);
    } finally { client.dispose(); service.dispose(); }
  });
}

test('flattened packaged asset root loads actual shared modules without source-tree fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-preview-packaged-root-'));
  fs.mkdirSync(path.join(root, 'public'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-packaged-layout', main: 'main.cjs' }));
  for (const name of ['html-artifact-frame.js', 'html-artifact-theme.js', 'html-artifact-runtime.js',
    'html-artifact-measure.js', 'html-artifact-scroll.js', 'tokens.css']) {
    fs.copyFileSync(path.resolve(__dirname, '../public', name), path.join(root, 'public', name));
  }
  const fixture = nativeRuntimeFixture(0);
  const { client, service } = await wire(undefined, { ...fixture, root, staticFallback: false });
  try {
    await rejectCode(client.preview(input()), 'html_preview_unavailable');
    assert.equal(fixture.windows.length, 1, 'shared modules load before native qualification');
    assert.equal(fixture.calls.some(expression => expression.includes('__piGuiPreviewRtcProbe')), true);
    assert.equal(fixture.windows[0].isDestroyed(), true);
  } finally {
    client.dispose(); service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('total deadline replies before cleanup grace and queued timeouts never start rendering', async () => {
  const entered = deferred(), cleanup = deferred(), started = [];
  let aborted = false;
  const { client, service } = await wire(async task => {
    started.push(task.request.html);
    task.abortRender = () => { aborted = true; };
    entered.resolve();
    await cleanup.promise;
    return resultFor(task.request);
  }, { totalTimeoutMs: 25, renderTimeoutMs: 1000, cleanupWaitMs: 500 });
  try {
    const active = rejectCode(client.preview(input('active')), 'html_preview_timeout');
    await entered.promise;
    const queued = rejectCode(client.preview(input('queued')), 'html_preview_timeout');
    await Promise.all([active, queued]);
    assert.equal(aborted, true);
    assert.equal(service.getState().active, 1, 'timeout reply is not delayed by cleanup');
    assert.equal(service.getState().queued, 0);
    assert.deepEqual(started, ['active']);
    cleanup.resolve();
    while (service.getState().active) await new Promise(resolve => setImmediate(resolve));
  } finally { cleanup.resolve(); client.dispose(); service.dispose(); }
});

test('unsafe global sandbox flags reject preview before creating a window', async () => {
  const fixture = nativeRuntimeFixture(0);
  const { client, service } = await wire(undefined, { ...fixture, argv: ['electron', '--no-sandbox'] });
  try {
    await rejectCode(client.preview(input()), 'html_preview_unavailable');
    assert.equal(fixture.windows.length, 0);
    assert.equal(fixture.calls.length, 0);
  } finally { client.dispose(); service.dispose(); }
});

test('child disconnect cancels its active render and does not poison the next child', async () => {
  const entered = deferred();
  let cancelled = false, renders = 0;
  const { client, service, child } = await wire(task => {
    renders++;
    if (renders > 1) return resultFor(task.request);
    entered.resolve();
    return new Promise((resolve, reject) => {
      task.abortRender = code => { cancelled = true; reject(Object.assign(Error(code), { code })); };
    });
  });
  try {
    const pending = client.preview(input());
    await entered.promise;
    child.connected = false;
    child.emit('disconnect');
    client.dispose();
    await rejectCode(pending, 'html_preview_unavailable');
    while (service.getState().active) await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, true);
    assert.equal(service.getState().attachedChildren, 0);
    const replacement = new EventEmitter();
    replacement.connected = true;
    const reply = new Promise(resolve => { replacement.send = resolve; });
    service.attach(replacement);
    replacement.emit('message', { type: 'html-preview-request', id: 1, ...input() });
    assert.equal((await reply).ok, true);
    assert.equal(renders, 2);
  } finally { client.dispose(); service.dispose(); }
});

test('client disposal rejects pending requests and detaches IPC listeners', async () => {
  const entered = deferred();
  const { client, service, port } = await wire(() => { entered.resolve(); return new Promise(() => {}); }, { cleanupWaitMs: 5 });
  const before = port.listenerCount('message');
  const pending = client.preview(input());
  await entered.promise;
  client.dispose();
  await rejectCode(pending, 'html_preview_unavailable');
  assert.equal(port.listenerCount('message'), before - 1);
  service.dispose();
});
