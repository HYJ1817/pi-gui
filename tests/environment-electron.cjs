const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installEnvironmentSetup } = require('../electron/environment-setup.cjs');

const origin = 'http://127.0.0.1:7788';
const selection = { planId: 'plan-' + 'a'.repeat(20), components: ['node', 'pi'] };

function fixture({ showMessageBox, showOpenDialog } = {}) {
  const handlers = new Map(), frames = [], dialogs = [];
  const frame = { url: origin + '/' };
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  const event = { sender: window.webContents, senderFrame: frame };
  const server = new EventEmitter();
  server.connected = true;
  server.send = (message, callback) => {
    frames.push(message);
    callback(null);
    const result = message.action === 'approve' ? { ok: true, ticket: 'private-ticket' }
      : { ok: true, job: { id: 'job' }, ticket: 'defensive-projection' };
    queueMicrotask(() => server.emit('message', { type: 'environment-install-result', id: message.id, result }));
  };
  installEnvironmentSetup({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: {
      showMessageBox: async (parent, options) => {
        assert.equal(parent, window);
        dialogs.push(options);
        return showMessageBox ? showMessageBox(options) : { response: 0 };
      },
      showOpenDialog,
    },
    getWindow: () => window, getServer: () => server, origin,
  });
  return { event, frames, dialogs, install: handlers.get('pi-gui:environment-install'), handlers, server };
}

test('native confirmation must finish before the parent grants and starts its exact selection', async () => {
  let confirm;
  const h = fixture({ showMessageBox: () => new Promise(resolve => { confirm = resolve; }) });
  const pending = h.install(h.event, { ...selection, consent: true, title: 'renderer text' });
  assert.deepEqual(h.frames, []);
  assert.equal((await h.install(h.event, selection)).code, 'busy');
  assert.equal(h.dialogs.length, 1);
  assert.deepEqual(h.dialogs[0].buttons, ['开始安装', '取消']);
  assert.equal(h.dialogs[0].defaultId, 1);
  assert.equal(h.dialogs[0].cancelId, 1);
  assert.doesNotMatch(JSON.stringify(h.dialogs[0]), /renderer text/);
  confirm({ response: 0 });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(result.job, { id: 'job' });
  assert.equal(Object.hasOwn(result, 'ticket'), false);
  assert.deepEqual(h.frames, [
    { type: 'environment-install', id: 1, action: 'approve', ...selection },
    { type: 'environment-install', id: 2, action: 'start', ...selection, ticket: 'private-ticket' },
  ]);
});

test('cancelled and untrusted native requests issue no backend command', async () => {
  const h = fixture({ showMessageBox: () => ({ response: 1 }) });
  assert.equal((await h.install(h.event, selection)).cancelled, true);
  assert.equal((await h.install({ ...h.event, senderFrame: { url: origin } }, selection)).code, 'untrusted-sender');
  assert.equal((await h.install(h.event, { ...selection, components: ['pi', 'pi'] })).code, 'invalid-components');
  assert.equal((await h.install(h.event, { ...selection, components: ['constructor'] })).code, 'invalid-components');
  h.server.connected = false;
  assert.equal((await h.install(h.event, selection)).code, 'install-unavailable');
  assert.equal(h.dialogs.length, 1);
  assert.deepEqual(h.frames, []);
});

test('Pi selection sends only the native file chooser result', async () => {
  const selected = 'C:\\fixture\\pi.cmd';
  const h = fixture({ showOpenDialog: async () => ({ filePaths: [selected], canceled: false }) });
  const handler = h.handlers.get('pi-gui:environment-choose-pi');
  assert.equal((await handler(h.event, 'C:\\renderer\\pi.cmd')).ok, true);
  assert.equal(h.frames[0].path, selected);
  const cancelled = fixture({ showOpenDialog: async () => ({ filePaths: [], canceled: true }), showMessageBox: () => ({ response: 1 }) });
  assert.equal((await cancelled.handlers.get('pi-gui:environment-choose-pi')(cancelled.event)).cancelled, true);
  assert.equal((await cancelled.handlers.get('pi-gui:environment-clear-pi')(cancelled.event)).cancelled, true);
  assert.deepEqual(cancelled.frames, []);
});
