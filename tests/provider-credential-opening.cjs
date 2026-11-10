'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { test } = require('node:test');
const { createProviderCredentialDesktop } = require('../electron/provider-credentials.cjs');

const request = { draftId: 'fixture-draft', draftRevision: 1, action: 'set' };

async function fixture(t) {
  const { createProviderCredentialBridge } = await import('../server/provider-credential-bridge.js');
  const windows = new Set();
  let peak = 0;
  class Window extends EventEmitter {
    constructor() {
      super();
      windows.add(this);
      peak = Math.max(peak, windows.size);
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: 'https://fixture.invalid/' },
        getURL: () => this.webContents.mainFrame.url,
        setWindowOpenHandler() {},
        loadURL: async url => { this.webContents.mainFrame.url = url; },
        send() {},
      });
    }
    static getAllWindows() { return [...windows]; }
    isDestroyed() { return !windows.has(this); }
    destroy() { windows.delete(this); this.emit('closed'); }
    focus() {}
    getContentBounds() { return { width: 800 }; }
  }
  const main = new Window();
  const handlers = new Map();
  const session = { fromPartition: () => ({
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {},
    protocol: { handle() {} },
  }) };
  function backend() {
    const draft = { ...request, providerId: 'fixture', connectionRevision: 1, expires: Infinity,
      connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions' } };
    const sdk = { qualified: async () => true,
      inspect: async () => ({ present: false, type: null }),
      disposeDraft: async () => {} };
    const bridge = createProviderCredentialBridge({ sdk, draftLookup: () => draft, nativePersistence: () => true, enabled: true });
    const child = new EventEmitter();
    child.connected = true;
    t.after(() => { child.connected = false; child.emit('disconnect'); });
    const calls = [];
    child.send = ({ id, ...frame }, callback) => {
      const result = bridge.handle(frame);
      calls.push({ frame, result, reply: async () => {
        const response = await result;
        child.emit('message', { type: frame.type, id, ...response });
        return response;
      } });
      if (frame.action === 'cancel') void calls.at(-1).reply();
      callback(null);
    };
    t.after(() => bridge.dispose());
    return { child, bridge, sdk, calls };
  }
  let current = backend();
  const desktop = createProviderCredentialDesktop({
    BrowserWindow: Window, ipcMain: { handle: (channel, fn) => handlers.set(channel, fn),
      removeHandler: channel => handlers.delete(channel) },
    protocol: { handle() {} }, session, getMainWindow: () => main, getBackend: () => current.child,
    isDesktopQualified: () => true,
  });
  t.after(() => desktop.dispose());
  const invoke = (action, payload) => handlers.get(`pi-gui:provider-credential-${action}`)({
    sender: main.webContents, senderFrame: main.webContents.mainFrame,
  }, payload);
  return {
    open: () => invoke('open', request),
    cancel: () => invoke('cancel'),
    get backend() { return current; },
    get peak() { return peak - 1; },
    get sheets() { return [...windows].filter(window => window !== main); },
    destroyMain: () => main.destroy(),
    restart() {
      const previous = current;
      current = backend();
      desktop.resetHandshake('fixture_restart');
      return previous;
    },
  };
}

async function replyTo(backend, action) {
  await nextTurn();
  const call = backend.calls.findLast(item => item.frame.action === action);
  assert.ok(call, `expected ${action} on the selected backend`);
  return call.reply();
}

test('FIX-09: cancel during handshake discards late capability without preparing', async t => {
  const f = await fixture(t);
  const pending = f.open();
  assert.equal(f.cancel().ok, true);
  await replyTo(f.backend, 'capability');
  // Complete prepare if an unfixed controller wrongly sends it so the test stays bounded.
  await nextTurn();
  await f.backend.calls.find(call => call.frame.action === 'prepare')?.reply();
  assert.equal((await pending).ok, false);
  assert.deepEqual(f.backend.calls.map(call => call.frame.action), ['capability']);
  assert.equal(f.peak, 0);
  assert.equal(f.backend.child.listenerCount('message'), 0);
});

test('FIX-09: cancelled prepare cannot reopen or clear the next opening', async t => {
  const f = await fixture(t);
  const old = f.open();
  await replyTo(f.backend, 'capability');
  await nextTurn();
  const oldPrepare = f.backend.calls.at(-1);
  assert.equal(oldPrepare.frame.action, 'prepare');
  assert.equal((await oldPrepare.result).ok, true, 'a backend nonce already exists');
  assert.equal(f.cancel().ok, true);
  const next = f.open();
  await oldPrepare.reply();
  assert.equal((await old).ok, false);
  assert.equal(f.peak, 0);
  assert.equal((await f.open()).code, 'busy', 'the old finally cannot unlock the new opening');
  const newPrepare = f.backend.calls.at(-1);
  assert.equal(newPrepare.frame.action, 'prepare');
  assert.notEqual(newPrepare, oldPrepare);
  assert.equal((await newPrepare.result).ok, true);
  assert.equal(f.backend.bridge.activeFlows, 1, 'only the new nonce survives');
  await newPrepare.reply();
  assert.equal((await next).ok, true);
  assert.equal(f.peak, 1);
  f.sheets[0].destroy();
  assert.equal(f.backend.bridge.activeFlows, 0, 'window destruction invalidates its nonce');
});

test('FIX-09: cancel and backend restart cannot install the old handshake', async t => {
  const f = await fixture(t);
  const old = f.open();
  const oldBackend = f.restart();
  assert.equal(f.cancel().ok, true);
  const next = f.open();
  await replyTo(oldBackend, 'capability');
  await nextTurn();
  await oldBackend.calls.find(call => call.frame.action === 'prepare')?.reply();
  assert.equal((await Promise.race([old, nextTurn({ ok: 'pending' })])).ok, false);
  assert.equal((await f.open()).code, 'busy');
  await replyTo(f.backend, 'capability');
  const prepared = await replyTo(f.backend, 'prepare');
  assert.equal(prepared.ok, true);
  assert.equal((await next).ok, true);
  assert.equal(f.peak, 1);
  assert.equal(oldBackend.bridge.activeFlows, 0);
  assert.equal(oldBackend.child.listenerCount('message'), 0);
});

test('FIX-09: prepare timeout while backend inspect is pending leaves no usable nonce', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const inspect = Promise.withResolvers();
  f.backend.sdk.inspect = () => inspect.promise;
  const pending = f.open();
  await replyTo(f.backend, 'capability');
  await nextTurn();
  const prepare = f.backend.calls.at(-1);
  assert.equal(prepare.frame.action, 'prepare');
  t.mock.timers.tick(25_000);
  assert.equal((await pending).code, 'backend_timeout');
  inspect.resolve({ present: false, type: null });
  await prepare.reply();
  assert.equal(f.backend.bridge.activeFlows, 0);
  assert.equal(f.backend.child.listenerCount('message'), 0);
  assert.equal(f.peak, 0);
});

test('FIX-09: destroying the parent during prepare drops the backend nonce', async t => {
  const f = await fixture(t);
  const pending = f.open();
  await replyTo(f.backend, 'capability');
  await nextTurn();
  const prepare = f.backend.calls.at(-1);
  f.destroyMain();
  await prepare.reply();
  assert.equal((await pending).ok, false);
  assert.equal(f.backend.bridge.activeFlows, 0);
  assert.equal(f.peak, 0);
});
