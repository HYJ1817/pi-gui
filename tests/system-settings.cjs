'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createSystemSettingsStore, DEFAULTS } = require('../electron/system-settings-store.cjs');
const { createSystemPower } = require('../electron/system-power.cjs');
const { createSystemTray } = require('../electron/system-tray.cjs');
const { createSystemCache } = require('../electron/system-cache.cjs');
const { createSystemSettings, CHANNELS } = require('../electron/system-settings.cjs');

async function world(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-gui-system-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function nativePower() {
  const live = new Map(); let id = 0, starts = 0;
  return { live, get starts() { return starts; }, start(type) { starts++; live.set(++id, type); return id; },
    stop(id) { live.delete(id); }, isStarted: id => live.has(id) };
}
function trayFixture() {
  const trays = [];
  class Tray extends EventEmitter {
    constructor() { super(); this.destroyed = false; trays.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    setToolTip() {}
    setContextMenu(menu) { this.menu = menu; }
  }
  const win = { visible: true, minimized: false, hides: 0, isDestroyed: () => false,
    isVisible() { return this.visible; }, isMinimized() { return this.minimized; },
    show() { this.visible = true; }, hide() { this.visible = false; this.hides++; },
    restore() { this.minimized = false; }, focus() {}, webContents: { mainFrame: { url: 'http://127.0.0.1:7788/' } },
  };
  return { Tray, Menu: { buildFromTemplate: x => x }, icon: 'local-icon', getWindow: () => win, win, trays };
}
function memoryCache() {
  let bytes = 4096, calls = 0;
  const session = { isPersistent: () => false, getStoragePath: () => null,
    getCacheSize: async () => bytes, clearCache: async () => { calls++; bytes = 0; } };
  return { session, cache: createSystemCache({ session }), get calls() { return calls; }, set bytes(value) { bytes = value; } };
}

test('preferences: defaults, atomic save and independent settings survive restart', async t => {
  const directory = await world(t), store = await createSystemSettingsStore({ directory });
  assert.deepEqual(store.snapshot().settings, DEFAULTS);
  const settings = { ...DEFAULTS, keepAwake: true, closeBehavior: 'tray' };
  assert.equal((await store.save(settings)).ok, true);
  assert.deepEqual((await createSystemSettingsStore({ directory })).snapshot().settings, settings);
  assert.deepEqual((await fs.readdir(directory)), ['system-settings.json']);
  assert.equal((await store.save({ ...settings, unknown: true })).ok, false);
});
test('preferences: corrupt/future schema is not applied or rewritten until explicit save', async t => {
  const directory = await world(t), file = path.join(directory, 'system-settings.json');
  for (const text of ['not json', JSON.stringify({ schemaVersion: 2, ...DEFAULTS }), 'null']) {
    await fs.writeFile(file, text);
    const store = await createSystemSettingsStore({ directory });
    assert.equal(store.snapshot().status, 'corrupt');
    assert.deepEqual(store.snapshot().settings, DEFAULTS);
    assert.equal(await fs.readFile(file, 'utf8'), text);
    assert.equal((await store.save(DEFAULTS)).ok, true);
  }
});
test('preferences: disk/rename failure leaves disk and committed state unchanged', async t => {
  const directory = await world(t);
  const store = await createSystemSettingsStore({ directory });
  await store.save(DEFAULTS);
  const before = await fs.readFile(path.join(directory, 'system-settings.json'));
  const fail = await createSystemSettingsStore({ directory, io: { ...fs, rename: async () => { throw Error('disk full SECRET'); } } });
  assert.equal((await fail.save({ ...DEFAULTS, keepAwake: true })).ok, false);
  assert.deepEqual(fail.snapshot().settings, DEFAULTS);
  assert.deepEqual(await fs.readFile(path.join(directory, 'system-settings.json')), before);
  assert.doesNotMatch(fail.snapshot().error, /SECRET/);
  assert.deepEqual(await fs.readdir(directory), ['system-settings.json']);
});
test('preferences: write, sync and close faults preserve committed bytes and remove only the owned temporary file', async t => {
  const directory = await world(t), file = path.join(directory, 'system-settings.json');
  await (await createSystemSettingsStore({ directory })).save(DEFAULTS);
  const before = await fs.readFile(file);
  for (const operation of ['writeFile', 'sync', 'close']) {
    let injected = false;
    const store = await createSystemSettingsStore({ directory, io: { ...fs, open: async (target, ...args) => {
      const handle = await fs.open(target, ...args);
      if (!path.basename(target).startsWith('.system-settings-')) return handle;
      return Object.fromEntries(['writeFile', 'sync', 'close'].map(name => [name, async (...values) => {
        if (name === operation && !injected) { injected = true; throw Error('fixture disk failure SECRET'); }
        return handle[name](...values);
      }]));
    } } });
    assert.equal((await store.save({ ...DEFAULTS, keepAwake: true })).ok, false, operation);
    assert.equal(injected, true, operation);
    assert.deepEqual(store.snapshot().settings, DEFAULTS, operation);
    assert.deepEqual(await fs.readFile(file), before, operation);
    assert.doesNotMatch(store.snapshot().error, /SECRET/);
    assert.deepEqual(await fs.readdir(directory), ['system-settings.json'], operation);
    assert.deepEqual((await createSystemSettingsStore({ directory })).snapshot().settings, DEFAULTS);
  }
});
test('preferences: hardlinks, junctions, ancestor links and replaced roots are rejected', async t => {
  const directory = await world(t), target = await world(t);
  const file = path.join(target, 'protected'); await fs.writeFile(file, 'protected');
  await fs.link(file, path.join(directory, 'system-settings.json'));
  const linked = await createSystemSettingsStore({ directory });
  assert.equal(linked.snapshot().status, 'unavailable');
  assert.equal((await linked.save(DEFAULTS)).ok, false);
  await fs.unlink(path.join(directory, 'system-settings.json'));
  const link = path.join(directory, 'junction');
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await createSystemSettingsStore({ directory: link })).snapshot().status, 'unavailable');
  const store = await createSystemSettingsStore({ directory });
  await fs.rename(directory, directory + '-old');
  t.after(() => fs.rm(directory + '-old', { recursive: true, force: true }));
  await fs.mkdir(directory);
  assert.equal((await store.save(DEFAULTS)).ok, false);
  assert.equal(await fs.readFile(file, 'utf8'), 'protected');
});
test('preferences: aliases of the same directory are accepted, foreign realpaths are not', async t => {
  const directory = await world(t), other = await world(t);
  const alias = directory + '-alias';
  await fs.symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.unlink(alias).catch(() => {}));
  /* Simulate an 8.3 short name / subst drive: realpath has a different spelling
   * but resolves to the same directory. The guard must accept it. */
  const aliased = await createSystemSettingsStore({ directory, io: { ...fs,
    realpath: async p => p === directory ? alias : fs.realpath(p) } });
  assert.equal(aliased.snapshot().status, 'default');
  assert.equal((await aliased.save(DEFAULTS)).ok, true);
  /* A realpath that points at another directory is still rejected. */
  const foreign = await createSystemSettingsStore({ directory, io: { ...fs,
    realpath: async p => p === directory ? other : fs.realpath(p) } });
  assert.equal(foreign.snapshot().status, 'unavailable');
  assert.equal((await foreign.save(DEFAULTS)).ok, false);
});
test('power: independent IDs, repeated enable, priority and dispose', () => {
  const native = nativePower(), power = createSystemPower({ powerSaveBlocker: native });
  assert.deepEqual(power.snapshot(), { keepAwake: false, preventDisplaySleep: false });
  power.set('keepAwake', true); power.set('keepAwake', true);
  assert.equal(native.starts, 1);
  power.set('preventDisplaySleep', true);
  assert.deepEqual([...native.live.values()], ['prevent-app-suspension', 'prevent-display-sleep']);
  power.set('keepAwake', false);
  assert.deepEqual(power.snapshot(), { keepAwake: false, preventDisplaySleep: true });
  power.dispose(); power.dispose(); assert.equal(native.live.size, 0);
});
test('power: unsupported/failure does not touch the other setting', () => {
  const native = nativePower(), power = createSystemPower({ powerSaveBlocker: native });
  power.set('keepAwake', true);
  native.start = () => { throw Error('unavailable'); };
  assert.throws(() => power.set('preventDisplaySleep', true));
  assert.equal(power.snapshot().keepAwake, true);
  native.stop = () => { throw Error('stop failed'); };
  assert.throws(() => power.set('keepAwake', false));
  assert.equal(power.snapshot().keepAwake, true);
  const unsupported = createSystemPower();
  assert.throws(() => unsupported.set('keepAwake', true));
  assert.equal(unsupported.snapshot().preventDisplaySleep, false);
});
test('tray: default quit, one icon, same-window hide/restore and native exit menu', () => {
  const fixture = trayFixture(); let quits = 0;
  const tray = createSystemTray({ ...fixture, quit: () => quits++, platform: 'win32' });
  let prevented = 0;
  const close = { preventDefault() { prevented++; } };
  assert.equal(tray.hideOnClose(close), false);
  tray.apply('tray'); tray.apply('tray'); assert.equal(fixture.trays.length, 1);
  assert.equal(tray.hideOnClose(close), true); assert.equal(prevented, 1);
  assert.equal(fixture.win.visible, false);
  fixture.trays[0].emit('click'); assert.equal(fixture.win.visible, true);
  fixture.trays[0].menu.at(-1).click(); assert.equal(quits, 1);
  tray.beginQuit(); assert.equal(tray.hideOnClose(close), false);
  tray.dispose(); assert.equal(fixture.trays[0].destroyed, true);
});
test('tray: shutdown, prior veto, failure and unsupported platform never hide', () => {
  const fixture = trayFixture(), tray = createSystemTray({ ...fixture, quit() {}, platform: 'win32' });
  tray.apply('tray');
  assert.equal(tray.hideOnClose({ defaultPrevented: true }), false);
  fixture.win.hide = () => { throw Error('native failure'); };
  assert.equal(tray.hideOnClose({ preventDefault() { assert.fail('must not prevent'); } }), false);
  tray.markSystemEnding(); assert.equal(tray.hideOnClose({}), false);
  assert.equal(createSystemTray({ ...fixture, platform: 'linux' }).supported, false);
});
test('cache: same official bucket counted/cleared; confirmation is single-use', async () => {
  const { cache } = memoryCache();
  const preview = await cache.measure(); assert.equal(preview.bytes, 4096);
  const cleared = await cache.clear({ ticket: preview.ticket, confirm: true });
  assert.equal(cleared.status, 'cleared'); assert.equal(cleared.bytes, 0);
  assert.equal((await cache.clear({ ticket: preview.ticket, confirm: true })).ok, false);
  assert.equal((await cache.measure()).status, 'empty');
});
test('cache: arbitrary path, traversal, partition and storage types cannot widen deletion', async () => {
  const fixture = memoryCache(), preview = await fixture.cache.measure();
  for (const extra of [{ path: '../../secret' }, { directory: 'C:\\data' }, { partition: 'persist:main' }, { storages: ['cookies'] }]) {
    assert.equal((await fixture.cache.clear({ ticket: preview.ticket, confirm: true, ...extra })).ok, false);
  }
  assert.equal(fixture.calls, 0);
});
test('cache: persistent/disk-backed sessions, including replaced targets, fail closed', async () => {
  const fixture = memoryCache();
  fixture.session.isPersistent = () => true;
  assert.equal((await fixture.cache.measure()).status, 'unknown');
  assert.equal(createSystemCache({ session: fixture.session }).supported, false);
  fixture.session.isPersistent = () => false;
  fixture.session.getStoragePath = () => 'junction-or-any-disk-path';
  assert.equal((await fixture.cache.measure()).bytes, null);
  assert.equal(fixture.calls, 0);
});
test('cache: no filesystem operations despite symlinks/junctions and protected data fixtures', async t => {
  const dir = await world(t), protectedDir = await world(t);
  const names = ['session.jsonl', 'titles.json', 'flags.json', 'auth.json', 'models.json', 'projects.json',
    'settings.json', 'worktree.txt', 'mcp.json', 'plugin.txt', 'model.bin', 'revert-evidence', 'recovery-data',
    'agent-live.tmp', 'update-recovery', 'diagnostic.log', 'attachment.bin'];
  for (const name of names) await fs.writeFile(path.join(protectedDir, name), name);
  await fs.symlink(protectedDir, path.join(dir, 'Cache'), process.platform === 'win32' ? 'junction' : 'dir');
  const fixture = memoryCache(), preview = await fixture.cache.measure();
  await fixture.cache.clear({ ticket: preview.ticket, confirm: true });
  for (const name of names) assert.equal(await fs.readFile(path.join(protectedDir, name), 'utf8'), name);
  assert.equal((await fs.lstat(path.join(dir, 'Cache'))).isSymbolicLink(), true);
});
test('cache: busy operations, expiry, growth and invalid sizes are truthful', async () => {
  const fixture = memoryCache(); let release;
  fixture.session.getCacheSize = () => new Promise(resolve => { release = resolve; });
  const pending = fixture.cache.measure();
  assert.equal((await fixture.cache.measure()).code, 'cache_busy');
  release(10); const preview = await pending;
  fixture.session.getCacheSize = async () => 11;
  assert.equal((await fixture.cache.clear({ ticket: preview.ticket, confirm: true })).code, 'cache_changed');
  assert.equal(fixture.calls, 0);
  fixture.session.getCacheSize = async () => -1;
  assert.equal((await fixture.cache.measure()).bytes, null);
  let now = 0;
  fixture.session.getCacheSize = async () => 1;
  const timed = createSystemCache({ session: fixture.session, now: () => now });
  const p = await timed.measure(); now = 60001;
  assert.equal((await timed.clear({ ticket: p.ticket, confirm: true })).code, 'cache_confirmation_expired');
});
test('cache: partial clear, regenerated cache, failed recheck and clear failure differ', async () => {
  const fixture = memoryCache();
  fixture.session.clearCache = async () => { fixture.bytes = 128; throw Error('occupied'); };
  let preview = await fixture.cache.measure();
  assert.equal((await fixture.cache.clear({ ticket: preview.ticket, confirm: true })).status, 'partial');
  fixture.session.clearCache = async () => {};
  preview = await fixture.cache.measure();
  assert.equal((await fixture.cache.clear({ ticket: preview.ticket, confirm: true })).status, 'partial');
  fixture.session.clearCache = async () => { throw Error('occupied'); };
  preview = await fixture.cache.measure();
  assert.equal((await fixture.cache.clear({ ticket: preview.ticket, confirm: true })).status, 'failed');
  fixture.session.clearCache = async () => { fixture.session.getCacheSize = async () => { throw Error('unreadable'); }; };
  preview = await fixture.cache.measure();
  const unknown = await fixture.cache.clear({ ticket: preview.ticket, confirm: true });
  assert.equal(unknown.status, 'partial'); assert.equal(unknown.bytes, null);
});
test('main owner: trust/arity/schema, native rollback, restart, concurrent save and cleanup', async t => {
  const directory = await world(t), fixture = trayFixture(), native = nativePower(), handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) };
  const store = await createSystemSettingsStore({ directory });
  const options = { ...fixture, ipcMain, origin: 'http://127.0.0.1:7788', directory, browserDirectory: directory,
    powerSaveBlocker: native, session: memoryCache().session, platform: 'win32', quit() {}, store };
  let owner = await createSystemSettings(options); owner.register(); owner.register();
  assert.equal(handlers.size, 9); // P1's five plus fixed network save/test and native storage pick/migrate.
  const event = { sender: fixture.win.webContents, senderFrame: fixture.win.webContents.mainFrame };
  const call = (key, ...args) => handlers.get(CHANNELS[key])(event, ...args);
  for (const bad of [{ sender: {}, senderFrame: event.senderFrame }, { sender: event.sender, senderFrame: { url: event.senderFrame.url } },
    { sender: event.sender, senderFrame: { url: 'https://evil.invalid' } }]) {
    for (const fn of handlers.values()) assert.equal((await fn(bad)).code, 'forbidden');
  }
  assert.equal((await call('state', {})).code, 'invalid_request');
  assert.equal((await call('set', { key: 'unknown', value: true })).code, 'invalid_setting');
  assert.equal((await call('set', { key: 'keepAwake', value: true })).ok, true);
  assert.equal((await call('state')).snapshot.effective.keepAwake, true);
  owner.dispose(); assert.equal(native.live.size, 0); assert.equal(handlers.size, 0);
  owner = await createSystemSettings(options); owner.register();
  assert.equal((await call('state')).snapshot.effective.keepAwake, true);
  let finish;
  store.save = () => new Promise(resolve => { finish = resolve; });
  const save = call('set', { key: 'preventDisplaySleep', value: true });
  assert.equal((await call('set', { key: 'closeBehavior', value: 'tray' })).code, 'settings_busy');
  finish({ ok: false });
  const failed = await save; assert.equal(failed.ok, false);
  assert.equal(failed.snapshot.effective.keepAwake, true);
  assert.equal(failed.snapshot.effective.preventDisplaySleep, false);
  owner.dispose(); assert.equal(native.live.size, 0);
});
test('main owner: a post-commit native restore failure reports saved intent and retains the working tray', async t => {
  const directory = await world(t), fixture = trayFixture(), handlers = new Map();
  const store = await createSystemSettingsStore({ directory });
  await store.save({ ...DEFAULTS, closeBehavior: 'tray' });
  const owner = await createSystemSettings({ ...fixture, store, platform: 'win32', quit() {},
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    origin: 'http://127.0.0.1:7788', powerSaveBlocker: nativePower(), session: memoryCache().session });
  t.after(() => owner.dispose()); owner.register();
  const event = { sender: fixture.win.webContents, senderFrame: fixture.win.webContents.mainFrame };
  const invoke = (key, ...args) => handlers.get(CHANNELS[key])(event, ...args);
  fixture.win.hide();
  fixture.win.show = () => { throw Error('native restore failure SECRET'); };
  const result = await invoke('set', { key: 'closeBehavior', value: 'quit' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'settings_saved_not_applied');
  assert.equal(result.committed, true);
  assert.equal(result.snapshot.persistence, 'saved');
  assert.equal(result.snapshot.effective.closeBehavior, 'tray');
  assert.match(result.snapshot.error, /已保存/);
  assert.doesNotMatch(result.snapshot.error, /未保存|SECRET/);
  assert.equal(fixture.trays[0].destroyed, false);
  assert.equal(fixture.win.visible, false);
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'system-settings.json'), 'utf8'));
  assert.equal(saved.closeBehavior, 'quit');
  assert.equal((await createSystemSettingsStore({ directory })).snapshot().settings.closeBehavior, 'quit');
  assert.equal((await invoke('state')).snapshot.effective.closeBehavior, 'tray');
  const other = await invoke('set', { key: 'keepAwake', value: true });
  assert.equal(other.ok, true);
  assert.equal(other.snapshot.effective.closeBehavior, 'tray');
  assert.match(other.snapshot.error, /已保存，但未能应用/);
  assert.match((await invoke('state')).snapshot.error, /已保存，但未能应用/);
  fixture.win.show = function () { this.visible = true; };
  assert.equal((await invoke('set', { key: 'closeBehavior', value: 'quit' })).ok, true);
  assert.equal((await invoke('state')).snapshot.error, '');
  assert.equal((await invoke('state')).snapshot.effective.closeBehavior, 'quit');
  assert.equal(fixture.win.visible, true);
  assert.equal(fixture.trays[0].destroyed, true);
});
test('main owner: unrelated saves cannot erase an unresolved startup power warning', async t => {
  const directory = await world(t), fixture = trayFixture(), native = nativePower(), handlers = new Map();
  const store = await createSystemSettingsStore({ directory });
  await store.save({ ...DEFAULTS, keepAwake: true });
  const start = native.start; native.start = () => { throw Error('fixture start failure'); };
  const owner = await createSystemSettings({ ...fixture, store, platform: 'win32', quit() {},
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    origin: 'http://127.0.0.1:7788', powerSaveBlocker: native, session: memoryCache().session });
  t.after(() => owner.dispose()); owner.register();
  const event = { sender: fixture.win.webContents, senderFrame: fixture.win.webContents.mainFrame };
  const invoke = (key, ...args) => handlers.get(CHANNELS[key])(event, ...args);
  assert.match((await invoke('state')).snapshot.error, /电源设置未能恢复/);
  const other = await invoke('set', { key: 'closeBehavior', value: 'tray' });
  assert.equal(other.ok, true); assert.match(other.snapshot.error, /电源设置未能恢复/);
  native.start = start;
  assert.equal((await invoke('set', { key: 'keepAwake', value: true })).snapshot.error, '');
});
test('main owner: repeated close/quit waits for one pending save and re-enters the existing quit callback once', async t => {
  const directory = await world(t), fixture = trayFixture(), handlers = new Map();
  const store = await createSystemSettingsStore({ directory }), save = store.save;
  let release, quits = 0, committedAtQuit = false;
  store.save = async next => { await new Promise(resolve => { release = resolve; }); return save(next); };
  const owner = await createSystemSettings({ ...fixture, store, platform: 'win32',
    quit() { quits++; committedAtQuit = store.snapshot().settings.keepAwake; },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    origin: 'http://127.0.0.1:7788', powerSaveBlocker: nativePower(), session: memoryCache().session });
  t.after(() => owner.dispose()); owner.register();
  const event = { sender: fixture.win.webContents, senderFrame: fixture.win.webContents.mainFrame };
  const pending = handlers.get(CHANNELS.set)(event, { key: 'keepAwake', value: true });
  let prevented = 0;
  assert.equal(owner.deferQuit({ preventDefault() { prevented++; } }), true);
  assert.equal(owner.deferQuit({ preventDefault() { prevented++; } }), true);
  assert.equal(quits, 0); assert.equal(prevented, 2);
  assert.equal((await handlers.get(CHANNELS.set)(event, { key: 'closeBehavior', value: 'tray' })).code, 'settings_busy');
  release(); await pending;
  assert.equal(quits, 1); assert.equal(committedAtQuit, true);
  assert.equal(owner.deferQuit({ preventDefault() { assert.fail('no pending save'); } }), false);
});
test('main owner: slow cache statistics exclude migration and quit, not unrelated power preferences', async t => {
  const directory = await world(t), fixture = trayFixture(), handlers = new Map(), cache = memoryCache();
  let finish, quits = 0, picked = 0;
  cache.session.getCacheSize = () => new Promise(resolve => finish = resolve);
  const owner = await createSystemSettings({ ...fixture, directory, platform: 'win32', quit() { quits++; },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    origin: 'http://127.0.0.1:7788', powerSaveBlocker: nativePower(), session: cache.session,
    storage: { state: () => ({}), pick: async () => { picked++; return { ok: true }; } } });
  t.after(() => owner.dispose()); owner.register();
  const event = { sender: fixture.win.webContents, senderFrame: fixture.win.webContents.mainFrame };
  const invoke = (name, ...args) => handlers.get(CHANNELS[name])(event, ...args);
  const pending = invoke('measure'); await Promise.resolve();
  assert.equal((await invoke('set', { key: 'keepAwake', value: true })).ok, true);
  assert.equal((await invoke('state')).snapshot.effective.keepAwake, true);
  assert.equal((await invoke('storagePick')).ok, false); assert.equal(picked, 0);
  assert.equal(owner.deferQuit({ preventDefault() {} }), true); assert.equal(quits, 0);
  finish(0); await pending; await new Promise(resolve => setImmediate(resolve)); assert.equal(quits, 1);
});

test('storage metadata: actual resolver output, explicit environment, Electron source and authenticated router', async t => {
  const { createSystemStorage } = await import('../server/system-storage.js');
  const { resolveDataDir } = await import('../server/data-dir.js');
  const { createRouter } = await import('../server/router.js');
  const { createAuth } = await import('../server/auth.js');
  const http = require('node:http'), directory = await world(t);
  for (const mode of ['source-web', 'electron', 'portable-sea']) {
    const env = { PI_GUI_DATA: directory }, resolved = resolveDataDir({ env });
    const storage = createSystemStorage({ dataDir: resolved, piAgentDir: path.join(directory, 'pi'), env, executionMode: mode });
    let router;
    const server = http.createServer((req, res) => router(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port, origin = `http://127.0.0.1:${port}`;
    const auth = createAuth({ token: 'fixture-token', port });
    router = createRouter({ auth, systemStorage: storage });
    try {
      assert.equal((await fetch(origin + '/api/system/storage')).status, 401);
      const headers = { 'x-pi-gui-token': 'fixture-token' };
      const response = await fetch(origin + '/api/system/storage', { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await fetch(origin + '/api/system/storage', { headers: { ...headers, origin: 'https://untrusted.invalid' } })).status, 403);
      const badHost = await new Promise((resolve, reject) => {
        http.get(origin + '/api/system/storage', { headers: { ...headers, host: 'untrusted.invalid' } }, res => {
          res.resume(); res.on('end', () => resolve(res.statusCode));
        }).on('error', reject);
      });
      assert.equal(badHost, 403);
      const info = await response.json();
      assert.equal(info.storage.dataDirectory, resolved); assert.equal(info.storage.source, 'environment');
      assert.equal((await fetch(origin + '/api/system/storage', { method: 'POST', headers })).status, 405);
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
  let document;
  createSystemStorage({ dataDir: directory, env: { PI_GUI_DATA: directory, PI_GUI_DESKTOP: '1', PI_GUI_DATA_SOURCE: 'electron-user-data' },
    executionMode: 'electron' }).handle({ method: 'GET' }, { setHeader() {}, writeHead() {}, end(body) { document = JSON.parse(body); } });
  assert.equal(document.storage.source, 'electron-user-data');
});
