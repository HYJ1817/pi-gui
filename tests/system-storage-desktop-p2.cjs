'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSystemStorageDesktop } = require('../electron/system-storage-desktop.cjs');
const { initializeSystemStorage } = require('../electron/system-storage-startup.cjs');
const { createSystemStorage } = require('../electron/system-storage-migration.cjs');
function fixture(overrides = {}) {
  const calls = [], value = { dataDirectory: 'fixture', source: 'electron-user-data', phase: 'idle', canMigrate: true, transactionId: 'transaction' };
  let busy = false;
  const storage = { state: () => ({ ...value }), preview: async target => { calls.push(['preview', target]); return { ok: true, ticket: 'native-ticket' }; },
    commit: async request => { calls.push(['commit', request]); return { ok: true }; },
    arm: async request => { calls.push(['arm', request]); return { ok: true }; },
    cancelPending: async request => { calls.push(['cancel', request]); return { ok: true }; } };
  const dialog = { showOpenDialog: async (win, options) => { calls.push(['picker', win, options]); return { canceled: false, filePaths: ['native-picked-only'] }; } };
  const maintenance = { busy: () => busy, restart: async callbacks => { calls.push(['maintenance']); const result = await callbacks.commit(); return { ...result, restartPending: result.ok }; } };
  const owner = createSystemStorageDesktop({ storage, dialog, maintenance, getWindow: () => 'trusted-window', ownsBackend: () => true, ...overrides });
  return { owner, calls, value, storage, dialog, maintenance, setBusy: next => { busy = next; } };
}
test('storage desktop: only native picker supplies a path, no create-directory or recent-document side effects', async () => {
  const f = fixture();
  assert.equal(f.owner.state().supported, true);
  assert.deepEqual(await f.owner.pick(), { ok: true, ticket: 'native-ticket' });
  assert.deepEqual(f.calls[0], ['picker', 'trusted-window', { title: '选择空文件夹作为数据保存目录', buttonLabel: '预检此目录', properties: ['openDirectory', 'dontAddToRecent'] }]);
  assert.deepEqual(f.calls[1], ['preview', 'native-picked-only']);
});
test('storage desktop: explicit override, unowned backend, maintenance and disposed owners cannot open picker', async () => {
  for (const kind of ['environment', 'backend', 'maintenance', 'disposed']) {
    const f = fixture(kind === 'backend' ? { ownsBackend: () => false } : {});
    if (kind === 'environment') f.value.source = 'environment';
    if (kind === 'maintenance') f.setBusy(true);
    if (kind === 'disposed') f.owner.dispose();
    assert.equal((await f.owner.pick()).ok, false); assert.equal(f.calls.length, 0);
  }
});
test('storage desktop: picker is single-flight, cancellation and errors never echo native payload', async () => {
  const f = fixture(); let finish;
  f.dialog.showOpenDialog = () => new Promise(resolve => finish = resolve);
  const first = f.owner.pick(); assert.equal(f.owner.state().canMigrate, false);
  assert.equal((await f.owner.pick()).ok, false);
  finish({ canceled: true, filePaths: ['SECRET'] }); assert.equal((await first).code, 'cancelled');
  assert.equal(f.calls.length, 0);
  f.dialog.showOpenDialog = async () => { throw Error('SECRET raw path'); };
  assert.doesNotMatch(JSON.stringify(await f.owner.pick()), /SECRET/);
  f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['a', 'b'] });
  assert.equal((await f.owner.pick()).code, 'cancelled');
});
test('storage desktop: confirmed ticket goes through maintenance; renderer paths cannot widen authority', async () => {
  const f = fixture();
  for (const request of [null, {}, { ticket: 't', confirm: false }, { ticket: 't', confirm: true, path: 'arbitrary' }, ['t']]) assert.equal((await f.owner.migrate(request)).ok, false);
  assert.equal(f.calls.length, 0);
  const request = { confirm: true, ticket: 'native-ticket' };
  assert.equal((await f.owner.migrate(request)).restartPending, true);
  assert.deepEqual(f.calls, [['maintenance'], ['commit', request]]);
  f.maintenance.restart = async callbacks => { await callbacks.commit(); await callbacks.arm('durable-intent'); return { ok: true }; };
  assert.equal((await f.owner.migrate(request)).ok, true);
  assert.deepEqual(f.calls.at(-1), ['arm', { transactionId: 'durable-intent' }]);
  f.maintenance.restart = async callbacks => { await callbacks.commit(); await callbacks.cancel('transaction'); return { ok: false, code: 'prepare_failed' }; };
  assert.equal((await f.owner.migrate(request)).ok, false);
  assert.deepEqual(f.calls.at(-1), ['cancel', { transactionId: 'transaction' }]);
});
async function world(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-storage-startup-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
test('storage startup: explicit environment shadows corrupt managed boot without reading or rewriting it', async t => {
  const root = await world(t), directory = path.join(root, 'profile'), selected = path.join(root, 'operator-data');
  await fs.mkdir(directory); const boot = path.join(directory, 'system-storage-bootstrap.json'); await fs.writeFile(boot, 'corrupt');
  const result = await initializeSystemStorage({ directory, appRoot: path.join(root, 'app'), executable: path.join(root, 'runtime/app.exe'), env: { PI_GUI_DATA: selected, PI_GUI_RUNTIME_DIR: path.join(root, 'fixed-runtime') }, probe() { assert.fail('override never probes managed intent'); } });
  assert.equal(result.dataDirectory, selected); assert.equal(result.source, 'environment'); assert.equal(result.storage.state().canMigrate, false);
  assert.equal(await fs.readFile(boot, 'utf8'), 'corrupt');
});
test('storage startup: Windows UNC operator override shadows managed paths without filesystem access', async t => {
  if (process.platform !== 'win32') { t.skip('Windows UNC path syntax'); return; }
  const root = await world(t), directory = path.join(root, 'profile'); await fs.mkdir(directory);
  const selected = '\\\\fixture-server\\share\\operator-data';
  const result = await initializeSystemStorage({ directory, appRoot: path.join(root, 'app'), executable: path.join(root, 'runtime/app.exe'),
    env: { PI_GUI_DATA: selected, PI_CODING_AGENT_DIR: '\\\\fixture-server\\share\\pi', PI_GUI_RUNTIME_DIR: '\\\\fixture-server\\share\\runtime' },
    probe() { assert.fail('operator override must not probe managed transaction'); } });
  assert.equal(result.dataDirectory, selected);
  assert.equal(result.source, 'environment');
  assert.deepEqual(await fs.readdir(directory), []);
});

test('storage startup: cold intent refuses a live/unowned backend, then verifies copy before choosing managed root', async t => {
  const root = await world(t), directory = path.join(root, 'profile'), target = path.join(root, 'target'), local = path.join(root, 'local'), agent = path.join(root, 'agent');
  await Promise.all([directory, target, local, agent].map(p => fs.mkdir(p)));
  await fs.writeFile(path.join(directory, 'session-titles.json'), '{"version":1,"items":[]}');
  const runtimeDirectory = path.join(local, 'pi-gui/runtime');
  const core = createSystemStorage({ directory, runtimeDirectory, piAgentDirectory: agent, inspectWindows: async () => 'ok' });
  assert.equal((await core.initialize()).ok, true);
  const preview = await core.preview(target); assert.equal(preview.ok, true);
  const intent = await core.commit({ confirm: true, ticket: preview.ticket }); assert.equal(intent.ok, true);
  assert.equal((await core.arm({ transactionId: intent.intentId })).ok, true);
  const args = { directory, appRoot: path.join(root, 'app'), executable: path.join(root, 'electron/app.exe'), env: { LOCALAPPDATA: local, PI_CODING_AGENT_DIR: agent } };
  await assert.rejects(initializeSystemStorage({ ...args, probe: async () => ({ state: 'ready' }) }), /storage_writers_unconfirmed/);
  assert.deepEqual(await fs.readdir(target), []);
  const active = await initializeSystemStorage({ ...args, probe: async () => ({ state: 'not-running' }) });
  assert.equal(active.dataDirectory, target); assert.equal(active.source, 'managed'); assert.equal(active.storage.state().phase, 'committed');
  assert.equal(await fs.readFile(path.join(target, 'session-titles.json'), 'utf8'), await fs.readFile(path.join(directory, 'session-titles.json'), 'utf8'));
  assert.equal((await active.storage.markStarted({ transactionId: active.storage.state().transactionId, dataDirectory: target, ok: true })).ok, true);
  assert.equal(active.storage.state().phase, 'active');
});
