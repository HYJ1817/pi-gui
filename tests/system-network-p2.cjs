'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const policy = require('../lib/system-network-policy.cjs');
const { createSystemNetwork } = require('../electron/system-network.cjs');
const base = (extra = {}) => ({ ...policy.DEFAULTS, ...extra });
const custom = base({ mode: 'custom', proxy: 'http://127.0.0.1:8123' });
function ses() { return { calls: [], async setProxy(value) { this.calls.push(value); } }; }
async function world(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-system-network-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}

test('proxy values: supported schemes are explicit and credentials or arbitrary settings fail closed', () => {
  for (const protocol of ['http', 'https', 'socks5', 'socks5h']) {
    assert.ok(policy.normalize(base({ mode: 'custom', proxy: `${protocol}://127.0.0.1:8123` })), protocol);
  }
  for (const proxy of ['http://user:SECRET@example.com:80', 'http://user@example.com', 'https://example.com/path',
    'ftp://example.com:90', 'socks4://example.com:90', 'socks5://example.com', 'http://example.com?SECRET',
    'http://example.com#SECRET', 'http://example.com:65536', 'http://exam\nple.com', 'file:///etc/config']) {
    assert.equal(policy.normalize(base({ mode: 'custom', proxy })), null, 'invalid address rejected');
  }
  assert.equal(policy.normalize({ ...custom, password: 'SECRET' }), null);
  assert.equal(policy.normalize({ ...custom, mode: 'pac' }), null);
  assert.equal(policy.normalize({ ...custom, relaxed: 1 }), null);
});
test('bypass values: bounded common grammar preserves mandatory loopback and rejects proxy-policy escape tokens', () => {
  const config = policy.electronProxy(base({ ...custom, bypass: 'example.com; *.example.org\n[2001:db8::1]:443, 10.0.0.1' }));
  for (const name of policy.LOOPBACK) assert.ok(config.proxyBypassRules.includes(name));
  assert.equal(config.mode, 'fixed_servers');
  for (const value of ['<-loopback>', '*', 'http://host', '../path', 'host:0', 'host:99999', '[::invalid]', '10.0.0.0/8', 'x'.repeat(2049)]) {
    assert.equal(policy.bypassEntries(value), null);
  }
  assert.deepEqual(policy.electronProxy(base({ mode: 'direct' })), { mode: 'direct' });
  assert.deepEqual(policy.electronProxy(base()), { mode: 'system' });
  assert.equal(policy.electronProxy(base({ mode: 'custom', proxy: 'socks5h://[::1]:1080' })).proxyRules, 'socks5://[::1]:1080');
});
test('direct environment removes every casing of proxy overrides without touching user machine state', () => {
  const input = { PATH: 'fixture', HTTP_PROXY: 'SECRET', https_proxy: 'SECRET', All_Proxy: 'SECRET', no_proxy: '*', NODE_USE_ENV_PROXY: '1', PI_GUI_TOKEN: 'not-this-owner' };
  assert.deepEqual(policy.withoutProxyEnvironment(input), { PATH: 'fixture', PI_GUI_TOKEN: 'not-this-owner' });
  assert.equal(input.HTTP_PROXY, 'SECRET', 'caller environment is not mutated');
  const direct = policy.directEnvironment(input);
  // Reproduce the public CLI's applyHttpProxySettings ??= semantics; a missing
  // variable would silently restore the user's stored upstream proxy.
  direct.HTTP_PROXY ??= 'http://stored-pi-proxy.invalid:8080';
  direct.HTTPS_PROXY ??= 'http://stored-pi-proxy.invalid:8080';
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) assert.equal(direct[key], '');
  assert.equal(direct.NO_PROXY, '*'); assert.equal(direct.no_proxy, '*');
  assert.equal(direct.NODE_USE_ENV_PROXY, '0'); assert.equal(input.HTTP_PROXY, 'SECRET');
});
test('external client policy is secret-free, supports explicit custom proxies, and does not invent PAC coverage', () => {
  const old = { HTTPS_PROXY: 'http://prior-user-proxy.invalid:8080', PATH: 'fixture' };
  assert.equal(policy.externalEnvironment(base(), old).HTTPS_PROXY, old.HTTPS_PROXY);
  const http = policy.externalEnvironment(custom, old);
  assert.equal(http.HTTP_PROXY, custom.proxy);
  assert.equal(http.http_proxy, custom.proxy);
  assert.ok(http.NO_PROXY.includes('127.0.0.1'));
  assert.equal(http.NODE_USE_ENV_PROXY, undefined);
  assert.equal(http.PI_GUI_SYSTEM_PROXY, undefined);
  assert.equal(policy.externalEnvironment(base({ mode: 'custom', proxy: 'socks5h://127.0.0.1:1080' }), old).HTTPS_PROXY, 'socks5://127.0.0.1:1080');
  assert.equal(policy.externalEnvironment(base({ mode: 'direct' }), old).HTTPS_PROXY, '');
});

test('network owner: restart persistence and separate power preferences, no write on load', async t => {
  const root = await world(t), first = ses();
  const owner = await createSystemNetwork({ directory: root, getSessions: () => [first] });
  assert.equal(owner.snapshot().settings.mode, 'system');
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal((await owner.save(custom)).ok, true);
  assert.equal(owner.snapshot().restartRequired, true);
  assert.deepEqual(await fs.readdir(root), ['system-network.json']);
  const next = await createSystemNetwork({ directory: root, getSessions: () => [ses()] });
  assert.equal(next.snapshot().settings.proxy, custom.proxy);
  assert.equal(next.snapshot().restartRequired, false);
});
test('network owner: failed native initialization cannot start a backend on a fallback route', async t => {
  const root = await world(t);
  await assert.rejects(createSystemNetwork({ directory: root, getSessions: () => [{ setProxy: async () => { throw Error('SECRET'); } }] }), /^Error: network_initialization_failed$/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('network owner: invalid and authentication-bearing input never persists or leaks in output', async t => {
  const root = await world(t), s = ses(), owner = await createSystemNetwork({ directory: root, getSessions: () => [s] });
  const result = await owner.save({ ...custom, proxy: 'http://user:SECRET@example.com:8888' });
  assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.deepEqual(await fs.readdir(root), []); assert.equal(s.calls.length, 1);
});
test('network owner: native failure rolls back every touched session and does not write intent', async t => {
  const root = await world(t), one = ses(), two = ses();
  const set = two.setProxy; two.setProxy = async value => { if (value.mode === 'fixed_servers') throw Error('SECRET'); return set.call(two, value); };
  const owner = await createSystemNetwork({ directory: root, getSessions: () => [one, two] });
  const result = await owner.save(custom);
  assert.equal(result.code, 'network_not_saved'); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.equal(one.calls.at(-1).mode, 'system'); assert.equal(two.calls.at(-1).mode, 'system');
  assert.equal(owner.snapshot().settings.mode, 'system'); assert.deepEqual(await fs.readdir(root), []);
});
test('network owner: disk failure restores session policy instead of pretending it was saved', async () => {
  const s = ses();
  const store = { snapshot: () => ({ settings: base(), status: 'saved', error: '' }), save: async () => ({ ok: false }) };
  const owner = await createSystemNetwork({ store, getSessions: () => [s] });
  assert.equal((await owner.save(custom)).code, 'network_not_saved');
  assert.equal(s.calls.at(-1).mode, 'system'); assert.equal(owner.snapshot().revision, 0);
});
test('network owner: one save in flight, new Runtime session waits before becoming usable', async t => {
  const root = await world(t), s = ses(), owner = await createSystemNetwork({ directory: root, getSessions: () => [s] });
  let release;
  s.setProxy = async value => { if (value.mode === 'fixed_servers') await new Promise(resolve => release = resolve); s.calls.push(value); };
  const pending = owner.save(custom);
  assert.equal((await owner.save(base({ mode: 'direct' }))).code, 'network_busy');
  const runtime = ses(), allocated = owner.registerSession(runtime);
  assert.equal(runtime.calls.length, 0); release(); await pending; await allocated;
  assert.equal(runtime.calls[0].mode, 'fixed_servers'); owner.unregisterSession(runtime);
});
test('network owner: a registration already in flight is included in the next save', async t => {
  const owner = await createSystemNetwork({ directory: await world(t) });
  const runtime = ses();
  let enter, release;
  const started = new Promise(resolve => enter = resolve);
  const gate = new Promise(resolve => release = resolve);
  runtime.setProxy = async value => {
    if (value.mode === 'system') { enter(); await gate; }
    runtime.calls.push(value.mode);
  };
  const registered = owner.registerSession(runtime);
  await started;
  const saving = owner.save(custom);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await registered;
  assert.equal((await saving).ok, true);
  assert.deepEqual(runtime.calls, ['system', 'fixed_servers']);
});

test('network owner: draft connection tests never save, single flight and late generation results are stale', async t => {
  const root = await world(t); let done;
  const owner = await createSystemNetwork({ directory: root, testConnection: () => new Promise(resolve => done = resolve) });
  const pending = owner.test(custom);
  assert.equal((await owner.test(custom)).code, 'network_busy');
  assert.deepEqual(await fs.readdir(root), []); assert.equal(owner.snapshot().settings.mode, 'system');
  assert.equal((await owner.save(base({ mode: 'direct' }))).ok, true);
  done({ ok: true, code: 'connected', body: 'SECRET', error: 'SECRET' });
  assert.equal((await pending).stale, true); assert.equal(owner.snapshot().settings.mode, 'direct');
});
test('network owner: test error projection and config corruption never reveal payload or overwrite corrupt bytes', async t => {
  const root = await world(t), file = path.join(root, 'system-network.json');
  await fs.writeFile(file, '{fixture SECRET');
  const owner = await createSystemNetwork({ directory: root, testConnection: async () => { throw Error('SECRET'); } });
  assert.equal(owner.snapshot().persistence, 'corrupt'); assert.equal(owner.snapshot().settings.mode, 'system');
  assert.equal(await fs.readFile(file, 'utf8'), '{fixture SECRET');
  const result = await owner.test(custom); assert.equal(result.code, 'network_failed'); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});
