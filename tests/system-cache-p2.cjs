'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { createSystemCache, SCOPE } = require('../electron/system-cache.cjs');
const { createSessionDiskRoot, inspectWindowsPaths } = require('../electron/system-cache-disk.cjs');

async function world(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cache-p2-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  return root;
}
function memory(bytes = 4096) {
  const fixture = { bytes, calls: 0 };
  fixture.session = { isPersistent: () => false, getStoragePath: () => null,
    getCacheSize: async () => fixture.bytes, clearCache: async () => { fixture.calls++; fixture.bytes = 0; } };
  return fixture;
}
// Fast fault-injection metadata. Most tests exercise real filesystem identities,
// links, bounds and file contents with deterministic allocation units. The native
// allocation probe is separately exercised below; these units are NOT that proof.
async function fakeMetadata(paths) {
  return Promise.all(paths.map(async target => {
    const stat = await fs.lstat(target);
    return { reparse: stat.isSymbolicLink(), allocatedBytes: stat.isFile() ? Math.ceil(stat.size / 4096) * 4096 : null };
  }));
}
async function diskFixture(t, profileName = 'Profile') {
  const root = await world(t), profile = path.join(root, profileName);
  const http = path.join(profile, 'Cache', 'Cache_Data', 'entry_0');
  const code = path.join(profile, 'Code Cache', 'js', 'entry_0');
  await fs.mkdir(path.dirname(http), { recursive: true });
  await fs.mkdir(path.dirname(code), { recursive: true });
  await fs.writeFile(http, randomBytes(65536));
  await fs.writeFile(code, randomBytes(8192));
  const protectedNames = ['session.jsonl', 'titles.json', 'flags.json', 'auth.json', 'models.json', 'projects.json',
    'settings.json', 'worktree.txt', 'mcp.json', 'mcp-registry-catalog.json.gz', 'plugin.txt', 'model.bin',
    'revert-evidence', 'recovery-data', 'agent-live.tmp', 'update-recovery', 'diagnostic.log', 'attachment.bin',
    'Cookies', 'Local Storage/leveldb/data', 'IndexedDB/login/data', 'GPUCache/entry'];
  const protectedFiles = protectedNames.map(name => path.join(profile, name));
  for (const [i, file] of protectedFiles.entries()) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `protected-fixture-${i}`);
  }
  const digest = async () => {
    const hash = createHash('sha256');
    for (const file of protectedFiles) hash.update(await fs.readFile(file));
    return hash.digest('hex');
  };
  const initialDigest = await digest();
  const fixture = { root, profile, http, code, httpCalls: 0, codeCalls: 0, digest, initialDigest };
  fixture.session = {
    isPersistent: () => true, getStoragePath: () => profile,
    getCacheSize: async () => { try { return (await fs.stat(http)).size; } catch (e) { if (e.code !== 'ENOENT') throw e; return 0; } },
    clearCache: async () => { fixture.httpCalls++; await fs.rm(http, { force: true }); },
    clearCodeCaches: async options => { assert.deepEqual(options, {}); fixture.codeCalls++; await fs.rm(code, { force: true }); },
    clearStorageData: () => assert.fail('storage data must never be cleared'),
  };
  fixture.make = (providers = {}, options = {}) => createSystemCache({ providers: { defaultSession: fixture.session, ...providers },
    diskOptions: { inspectPaths: fakeMetadata }, ...options });
  return fixture;
}
const bucket = (result, id) => result.buckets.find(b => b.id === id);
const clear = async cache => { const preview = await cache.measure(); assert.equal(preview.ok, true); return cache.clear({ confirm: true, ticket: preview.ticket }); };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

// Existing P1 tests are intentionally untouched, and remain the compatibility
// authority. This check additionally prevents opt-in from changing exported SCOPE.
test('P1 remains memory-only and does not load a disk provider', async () => {
  const fixture = memory(), cache = createSystemCache({ session: fixture.session });
  const preview = await cache.measure();
  assert.equal(SCOPE, 'browser-memory-http-cache'); assert.equal(preview.scope, SCOPE);
  assert.equal(preview.bytes, 4096); assert.equal(Object.hasOwn(preview, 'diskBytes'), false);
  assert.equal((await cache.clear({ confirm: true, ticket: preview.ticket })).status, 'cleared');
  assert.equal(fixture.calls, 1);
});

test('persistent HTTP fixture and Code Cache have separate fixed physical buckets; all protected data survives', async t => {
  const f = await diskFixture(t), cache = f.make(), preview = await cache.measure();
  assert.equal(preview.ok, true); assert.equal(preview.diskBytes, 73728); assert.equal(preview.memoryBytes, 0);
  assert.equal(preview.bytes, preview.diskBytes + preview.memoryBytes);
  assert.equal(bucket(preview, 'default-session-http-cache').cacheBytes, 65536);
  assert.equal(bucket(preview, 'default-session-code-cache').cacheBytes, 8192);
  assert.deepEqual(preview.buckets.map(b => [b.id, b.owner, b.medium, b.source]), [
    ['default-session-http-cache', 'electron.defaultSession', 'disk', 'session.getCacheSize+validated-file-allocation'],
    ['browser-memory-http-cache', 'electron.browser', 'memory', 'session.getCacheSize'],
    ['runtime-memory-http-cache', 'electron.runtimeBrowserHost', 'memory', 'session.getCacheSize'],
    ['default-session-code-cache', 'electron.defaultSession', 'disk', 'validated-code-cache-file-allocation'],
  ]);
  assert.equal(bucket(preview, 'browser-memory-http-cache').status, 'excluded');
  assert.equal(bucket(preview, 'runtime-memory-http-cache').bytes, null);
  assert.equal(f.httpCalls + f.codeCalls, 0, 'statistics are read-only');
  const result = await cache.clear({ confirm: true, ticket: preview.ticket });
  assert.equal(result.status, 'cleared'); assert.equal(result.diskBytes, 0);
  assert.equal(result.beforeDiskBytes, 73728); assert.equal(result.releasedDiskBytes, 73728);
  assert.equal(result.diskReleaseConfirmed, true); assert.equal(result.releasedMemoryBytes, 0);
  assert.equal(f.httpCalls, 1); assert.equal(f.codeCalls, 1);
  await assert.rejects(fs.stat(f.http), { code: 'ENOENT' }); await assert.rejects(fs.stat(f.code), { code: 'ENOENT' });
  assert.equal(await f.digest(), f.initialDigest);
});

test('native metadata: real temporary disk allocation before/after official-shaped API and unchanged protected digest', async t => {
  const f = await diskFixture(t, '中文 Cache Profile $literal'), cache = f.make({}, { diskOptions: undefined });
  const physical = async () => {
    const paths = [f.http, f.code];
    if (process.platform === 'win32') return (await inspectWindowsPaths(paths)).reduce((n, s) => n + s.allocatedBytes, 0);
    return (await Promise.all(paths.map(p => fs.stat(p)))).reduce((n, s) => n + s.blocks * 512, 0);
  };
  const actual = await physical(), preview = await cache.measure();
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.diskBytes, actual); assert.ok(actual > 0);
  const result = await cache.clear({ confirm: true, ticket: preview.ticket });
  assert.equal(result.status, 'cleared', JSON.stringify(result));
  assert.equal(result.diskBytes, 0); assert.equal(result.releasedDiskBytes, actual);
  assert.equal(result.diskReleaseConfirmed, true); assert.equal(await f.digest(), f.initialDigest);
  t.diagnostic(`real file allocation ${actual} -> ${result.diskBytes} B; released ${result.releasedDiskBytes} B; protected SHA256 ${f.initialDigest}`);
});

test('Runtime callback enumerates hidden registered sessions, deduplicates globally, and tolerates order only', async () => {
  const legacy = memory(10), a = memory(20), b = memory(30);
  let sessions = [legacy.session, a.session, a.session, b.session];
  const providers = { browserSession: legacy.session, getBuckets: () => sessions };
  const cache = createSystemCache({ providers });
  const preview = await cache.measure();
  assert.equal(preview.memoryBytes, 60); assert.equal(preview.diskBytes, 0);
  assert.equal(bucket(preview, 'runtime-memory-http-cache').sessionCount, 2);
  sessions = [b.session, a.session, legacy.session];
  providers.browserSession = memory(999).session; // construction captures authority
  const result = await cache.clear({ confirm: true, ticket: preview.ticket });
  assert.equal(result.status, 'cleared'); assert.equal(result.releasedMemoryBytes, 60);
  assert.equal(result.releasedDiskBytes, 0); assert.equal(result.diskReleaseConfirmed, false);
  assert.deepEqual([legacy.calls, a.calls, b.calls], [1, 1, 1]);
});

test('renderer selectors, directory paths and provider ids cannot widen confirmed authority', async () => {
  const f = memory(), cache = createSystemCache({ providers: { browserSession: f.session } });
  const p = await cache.measure();
  for (const extra of [{ path: '../../private' }, { directory: 'C:\\private' }, { partition: 'persist:evil' },
    { buckets: ['default-session-code-cache'] }, { providers: [] }, { storages: ['cookies'] }, { runtimeId: 'anything' }]) {
    assert.equal((await cache.clear({ confirm: true, ticket: p.ticket, ...extra })).code, 'invalid_request');
  }
  assert.equal(f.calls, 0);
  assert.equal((await cache.clear({ confirm: true, ticket: p.ticket })).status, 'cleared');
  assert.throws(() => createSystemCache({ providers: { path: 'C:\\private' } }), TypeError);
  assert.throws(() => createSystemCache({ providers: { getBuckets: ['renderer-id'] } }), TypeError);
});

test('new, retired or replaced Runtime targets reject the entire stale confirmation before any API', async () => {
  for (const change of ['new', 'retired', 'replacement']) {
    const a = memory(8), b = memory(8), legacy = memory(8); let sessions = [a.session];
    const cache = createSystemCache({ providers: { browserSession: legacy.session, getBuckets: () => sessions } });
    const p = await cache.measure();
    sessions = change === 'new' ? [a.session, b.session] : change === 'retired' ? [] : [b.session];
    assert.equal((await cache.clear({ confirm: true, ticket: p.ticket })).code, 'cache_changed', change);
    assert.deepEqual([a.calls, b.calls, legacy.calls], [0, 0, 0]);
    assert.equal((await cache.clear({ confirm: true, ticket: p.ticket })).code, 'cache_confirmation_expired');
  }
});

test('missing, malformed, failing or persistent Runtime enumeration is unknown, not zero', async () => {
  for (const getBuckets of [() => null, () => [null], () => ['renderer-id'], () => { throw Error('SECRET'); },
    () => new Array(65).fill(memory().session), () => [Promise.resolve(memory().session)], () => Promise.reject(Error('SECRET')),
    () => [{ isPersistent: () => true, getStoragePath: () => 'C:\\private' }]]) {
    const result = await createSystemCache({ providers: { getBuckets } }).measure();
    assert.equal(result.ok, false); assert.equal(result.bytes, null); assert.equal(result.ticket, undefined);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|private|renderer-id/);
  }
});

test('real junction/symlink cache tree or storage ancestors are refused; protected targets are never visited or cleared', async t => {
  for (const where of ['Cache', 'Code Cache', 'storage-root', 'ancestor']) {
    const f = await diskFixture(t), protectedTarget = path.join(f.root, 'Protected');
    await fs.mkdir(protectedTarget); await fs.writeFile(path.join(protectedTarget, 'sentinel'), 'do-not-touch');
    let session = f.session;
    if (where === 'storage-root') {
      const link = path.join(f.root, 'LinkedProfile');
      await fs.symlink(f.profile, link, process.platform === 'win32' ? 'junction' : 'dir');
      session = { ...session, getStoragePath: () => link };
    } else if (where === 'ancestor') {
      const link = path.join(f.root, 'LinkedAncestor');
      await fs.symlink(f.root, link, process.platform === 'win32' ? 'junction' : 'dir');
      session = { ...session, getStoragePath: () => path.join(link, 'Profile') };
    } else {
      const target = path.join(f.profile, where);
      await fs.rename(target, target + '-original');
      await fs.symlink(protectedTarget, target, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const cache = f.make({ defaultSession: session }), p = await cache.measure();
    if (where === 'Code Cache') {
      assert.equal(p.ok, true); assert.equal(bucket(p, 'default-session-code-cache').status, 'excluded');
      assert.equal(bucket(p, 'default-session-code-cache').bytes, null);
      assert.equal((await cache.clear({ confirm: true, ticket: p.ticket })).status, 'cleared');
      assert.equal(f.httpCalls, 1); assert.equal(f.codeCalls, 0);
    } else { assert.equal(p.ok, false); assert.equal(p.diskBytes, null); assert.equal(f.httpCalls, 0); }
    assert.equal(await fs.readFile(path.join(protectedTarget, 'sentinel'), 'utf8'), 'do-not-touch');
    assert.equal(await f.digest(), f.initialDigest);
  }
});

test('real file symlink and hardlink are never counted/cleared as owned HTTP files', async t => {
  for (const type of ['symlink', 'hardlink']) {
    await t.test(type, async t => {
      const f = await diskFixture(t), protectedFile = path.join(f.root, 'private');
      await fs.writeFile(protectedFile, 'protected'); await fs.unlink(f.http);
      // This is a real link fixture, not a patched stat. A platform refusal is
      // reported explicitly and does not silently skip the hardlink case.
      try {
        if (type === 'symlink') await fs.symlink(protectedFile, f.http, 'file');
        else await fs.link(protectedFile, f.http);
      } catch (error) {
        if (type === 'symlink' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip(`file symlink unavailable: ${error.code}`); return; }
        throw error;
      }
      const result = await f.make().measure();
      assert.equal(result.ok, false); assert.equal(result.bytes, null); assert.equal(f.httpCalls, 0);
      assert.equal(await fs.readFile(protectedFile, 'utf8'), 'protected');
    });
  }
});

test('unknown Windows reparse attributes fail closed before directory descent', async t => {
  const f = await diskFixture(t); let entered = false;
  const cache = f.make({}, { diskOptions: {
    io: { ...fs, opendir: async target => { if (target === path.join(f.profile, 'Cache')) entered = true; return fs.opendir(target); } },
    inspectPaths: async paths => (await fakeMetadata(paths)).map((row, i) => paths[i] === path.join(f.profile, 'Cache') ? { ...row, reparse: true } : row),
  } });
  const p = await cache.measure(); assert.equal(p.ok, false); assert.equal(p.diskBytes, null);
  assert.equal(entered, false); assert.equal(f.httpCalls + f.codeCalls, 0);
});

test('storage root, HTTP directory and Code Cache replacement invalidate an existing confirmation', async t => {
  for (const tree of ['root', 'Cache', 'Code Cache']) {
    const f = await diskFixture(t), cache = f.make(), p = await cache.measure(); assert.equal(p.ok, true);
    const target = tree === 'root' ? f.profile : path.join(f.profile, tree);
    await fs.rename(target, target + '-old'); await fs.mkdir(target);
    const result = await cache.clear({ confirm: true, ticket: p.ticket });
    assert.equal(result.code, 'cache_changed', tree); assert.equal(f.httpCalls + f.codeCalls, 0);
  }
});

test('file replacement or injected directory replacement during a scan is unknown', async t => {
  const f = await diskFixture(t); let changed = false;
  const cache = f.make({}, { diskOptions: { inspectPaths: async paths => {
    const rows = await fakeMetadata(paths);
    if (!changed && paths.includes(f.http)) {
      changed = true; await fs.rename(f.http, f.http + '-old'); await fs.writeFile(f.http, randomBytes(65536));
    }
    return rows;
  } } });
  const result = await cache.measure(); assert.equal(changed, true); assert.equal(result.ok, false);
  assert.equal(result.bytes, null); assert.equal(f.httpCalls, 0);
});

test('a Session storage-path switch across an asynchronous getCacheSize is refused', async t => {
  const f = await diskFixture(t), gate = deferred(), entered = deferred();
  f.session.getCacheSize = async () => { entered.resolve(); await gate.promise; return 1; };
  const cache = f.make(), pending = cache.measure(); await entered.promise;
  f.session.getStoragePath = () => f.root; gate.resolve();
  const p = await pending; assert.equal(p.bytes, null); assert.equal(p.ok, false);
  assert.equal(f.httpCalls + f.codeCalls, 0);
});

test('bounded scans reject excessive breadth/depth, unreadable metadata and allocation unknowns', async t => {
  for (const kind of ['entries', 'depth', 'metadata-error', 'allocation-unknown', 'io-error', 'timeout']) {
    const f = await diskFixture(t);
    const diskOptions = { inspectPaths: fakeMetadata };
    if (kind === 'entries') diskOptions.limits = { entries: 1 };
    if (kind === 'depth') { await fs.mkdir(path.join(path.dirname(f.http), 'nested', 'too-deep'), { recursive: true }); diskOptions.limits = { depth: 1 }; }
    if (kind === 'metadata-error') diskOptions.inspectPaths = async () => { throw Error('SECRET path'); };
    if (kind === 'allocation-unknown') diskOptions.inspectPaths = async paths => (await fakeMetadata(paths)).map(row => ({ ...row, allocatedBytes: null }));
    if (kind === 'io-error') diskOptions.io = { ...fs, opendir: async () => { throw Error('EACCES SECRET'); } };
    if (kind === 'timeout') { let clock = 0; diskOptions.clock = () => (clock += 2); diskOptions.limits = { milliseconds: 1 }; }
    const p = await f.make({}, { diskOptions }).measure();
    assert.equal(p.ok, false, kind); assert.equal(p.diskBytes, null, kind); assert.equal(f.httpCalls, 0);
    assert.doesNotMatch(JSON.stringify(p), /SECRET/);
  }
});

test('logical growth, physical allocation growth and per-Runtime growth need new confirmation', async t => {
  for (const kind of ['logical', 'physical', 'runtime']) {
    const f = await diskFixture(t), a = memory(10), b = memory(20), cache = f.make({ getBuckets: () => [a.session, b.session] });
    const p = await cache.measure(); assert.equal(p.ok, true);
    if (kind === 'logical') f.session.getCacheSize = async () => 65537; // same file allocation, official bytes grew
    if (kind === 'physical') { f.session.getCacheSize = async () => 65536; await fs.appendFile(f.http, randomBytes(8192)); }
    if (kind === 'runtime') { a.bytes++; b.bytes--; } // aggregate unchanged cannot mask a growing Session
    const result = await cache.clear({ confirm: true, ticket: p.ticket });
    assert.equal(result.code, 'cache_changed', kind);
    assert.deepEqual([f.httpCalls, f.codeCalls, a.calls, b.calls], [0, 0, 0, 0]);
  }
});

test('one single flight covers all measures/clears and disposal invalidates pending work', async () => {
  const f = memory(), gate = deferred(), entered = deferred();
  f.session.getCacheSize = async () => { entered.resolve(); return gate.promise; };
  const cache = createSystemCache({ providers: { browserSession: f.session } });
  const pending = cache.measure(); await entered.promise;
  assert.equal((await cache.measure()).code, 'cache_busy');
  assert.equal((await cache.clear({ confirm: true, ticket: 'anything' })).code, 'cache_busy');
  cache.dispose(); gate.resolve(1);
  assert.equal((await pending).ok, false); assert.equal((await cache.measure()).code, 'cache_unavailable');
  assert.equal(f.calls, 0);
});

test('clear is single-flight, confirmation is one-shot, expiry is exact and checked after awaits', async () => {
  const f = memory(), gate = deferred(), entered = deferred(); let now = 0;
  const cache = createSystemCache({ providers: { browserSession: f.session }, now: () => now });
  let p = await cache.measure(); now = 60000;
  assert.equal((await cache.clear({ confirm: true, ticket: p.ticket })).code, 'cache_confirmation_expired'); assert.equal(f.calls, 0);
  now = 0; p = await cache.measure();
  f.session.getCacheSize = async () => { entered.resolve(); await gate.promise; return f.bytes; };
  const clearing = cache.clear({ confirm: true, ticket: p.ticket }); await entered.promise;
  assert.equal((await cache.measure()).code, 'cache_busy');
  assert.equal((await cache.clear({ confirm: true, ticket: p.ticket })).code, 'cache_busy');
  now = 60000; gate.resolve();
  assert.equal((await clearing).code, 'cache_confirmation_expired'); assert.equal(f.calls, 0);
  assert.equal((await cache.clear({ confirm: true, ticket: p.ticket })).code, 'cache_confirmation_expired');
});

test('a Runtime registered during a preceding native clear is never cleared under the old ticket', async () => {
  const a = memory(10), b = memory(20); let sessions = [a.session];
  a.session.clearCache = async () => { a.calls++; a.bytes = 0; sessions = [a.session, b.session]; };
  const cache = createSystemCache({ providers: { getBuckets: () => sessions } });
  const result = await clear(cache);
  assert.equal(result.ok, false); assert.equal(result.status, 'partial');
  assert.equal(result.code, 'cache_changed'); assert.equal(result.memoryBytes, null);
  assert.equal(result.diskReleaseConfirmed, false); assert.deepEqual([a.calls, b.calls], [1, 0]);
});

test('growth in a later Runtime during an earlier clear stops before the later API', async () => {
  const a = memory(10), b = memory(20);
  a.session.clearCache = async () => { a.calls++; a.bytes = 0; b.bytes++; };
  const result = await clear(createSystemCache({ providers: { getBuckets: () => [a.session, b.session] } }));
  assert.equal(result.status, 'partial'); assert.equal(result.code, 'cache_changed');
  assert.equal(result.releasedMemoryBytes, 9); assert.deepEqual([a.calls, b.calls], [1, 0]);
});

test('unknown official sizes and post-clear measurement failures never become zero or disk release', async t => {
  const f = await diskFixture(t);
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
    f.session.getCacheSize = async () => value;
    const p = await f.make().measure(); assert.equal(p.ok, false); assert.equal(p.bytes, null);
  }
  f.session.getCacheSize = async () => 65536;
  f.session.clearCache = async () => { f.httpCalls++; f.session.getCacheSize = async () => { throw Error('SECRET'); }; };
  const result = await clear(f.make({ codeCache: false }));
  assert.equal(result.status, 'partial'); assert.equal(result.diskBytes, null); assert.equal(result.releasedDiskBytes, null);
  assert.equal(result.diskReleaseConfirmed, false); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('native clear rejection with actual physical reduction is partial, not falsely failed or fully cleared', async t => {
  const f = await diskFixture(t);
  f.session.clearCache = async () => { f.httpCalls++; await fs.writeFile(f.http, randomBytes(4096)); throw Error('occupied SECRET'); };
  const result = await clear(f.make({ codeCache: false }));
  assert.equal(result.status, 'partial'); assert.equal(result.diskBytes, 4096);
  assert.equal(result.releasedDiskBytes, 61440); assert.equal(result.diskReleaseConfirmed, true);
  assert.equal(bucket(result, 'default-session-http-cache').clearStatus, 'failed');
  assert.equal(await f.digest(), f.initialDigest); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('successful API with regenerated disk data remains partial; only net physical decrease counts', async t => {
  const f = await diskFixture(t);
  f.session.clearCache = async () => { f.httpCalls++; await fs.writeFile(f.http, randomBytes(73728)); };
  const result = await clear(f.make({ codeCache: false }));
  assert.equal(result.status, 'partial'); assert.equal(result.diskBytes, 73728);
  assert.equal(result.releasedDiskBytes, 0); assert.equal(result.diskReleaseConfirmed, false);
  assert.equal(await f.digest(), f.initialDigest);
});

test('getCacheSize decrease without disk decrease does not claim physical disk release', async t => {
  const f = await diskFixture(t); let size = 65536;
  f.session.getCacheSize = async () => size;
  f.session.clearCache = async () => { f.httpCalls++; size = 0; };
  const result = await clear(f.make({ codeCache: false }));
  assert.equal(result.status, 'partial'); assert.equal(result.diskBytes, 65536);
  assert.equal(bucket(result, 'default-session-http-cache').cacheBytes, 0);
  assert.equal(result.releasedDiskBytes, 0); assert.equal(result.diskReleaseConfirmed, false);
});

test('a failed unchanged disk cache is failed, while another successful bucket makes a partial result', async t => {
  for (const another of [false, true]) {
    const f = await diskFixture(t), a = memory(12);
    f.session.clearCache = async () => { f.httpCalls++; throw Error('occupied'); };
    const result = await clear(f.make({ codeCache: false, ...(another ? { getBuckets: () => [a.session] } : {}) }));
    assert.equal(result.status, another ? 'partial' : 'failed');
    assert.equal(result.releasedDiskBytes, 0); assert.equal(result.releasedMemoryBytes, another ? 12 : 0);
    assert.equal(result.diskReleaseConfirmed, false); assert.equal(await f.digest(), f.initialDigest);
  }
});

test('Code Cache unsupported or explicitly disabled leaves official HTTP disk cache fully usable', async t => {
  for (const mode of ['unsupported', 'disabled']) {
    const f = await diskFixture(t);
    if (mode === 'unsupported') delete f.session.clearCodeCaches;
    const result = await clear(f.make(mode === 'disabled' ? { codeCache: false } : {}));
    assert.equal(result.status, 'cleared'); assert.equal(f.httpCalls, 1); assert.equal(f.codeCalls, 0);
    assert.equal(bucket(result, 'default-session-code-cache').status, 'excluded');
    assert.equal((await fs.stat(f.code)).size, 8192); assert.equal(await f.digest(), f.initialDigest);
  }
});

test('an initially absent disk tree becoming a directory cannot expand the ticket; after-clear replacement is unknown', async t => {
  for (const mode of ['absent', 'post-replacement']) {
    const f = await diskFixture(t);
    if (mode === 'absent') await fs.rename(path.join(f.profile, 'Cache'), path.join(f.profile, 'Cache-old'));
    const cache = f.make({ codeCache: false }), p = await cache.measure(); assert.equal(p.ok, true);
    if (mode === 'absent') {
      await fs.mkdir(path.dirname(f.http), { recursive: true }); await fs.writeFile(f.http, randomBytes(1));
      assert.equal((await cache.clear({ confirm: true, ticket: p.ticket })).code, 'cache_changed'); assert.equal(f.httpCalls, 0);
    } else {
      f.session.clearCache = async () => {
        f.httpCalls++; await fs.rename(path.join(f.profile, 'Cache'), path.join(f.profile, 'Cache-old'));
        await fs.mkdir(path.dirname(f.http), { recursive: true }); await fs.writeFile(f.http, randomBytes(1));
      };
      const result = await cache.clear({ confirm: true, ticket: p.ticket });
      assert.equal(result.status, 'partial'); assert.equal(result.diskBytes, null);
      assert.equal(result.releasedDiskBytes, null); assert.equal(result.diskReleaseConfirmed, false);
    }
  }
});

test('links introduced after preview and directory replacement during enumeration invalidate authority', async t => {
  for (const mode of ['hardlink', 'junction', 'enumeration-replacement']) {
    const f = await diskFixture(t), privateFile = path.join(f.root, 'private');
    await fs.writeFile(privateFile, 'private-sentinel');
    let replaced = false;
    const diskOptions = { inspectPaths: fakeMetadata };
    if (mode === 'enumeration-replacement') diskOptions.io = { ...fs, opendir: async target => {
      if (!replaced && target === path.join(f.profile, 'Cache')) {
        replaced = true; await fs.rename(target, target + '-old'); await fs.mkdir(target);
      }
      return fs.opendir(target);
    } };
    const cache = f.make({}, { diskOptions });
    if (mode === 'enumeration-replacement') {
      assert.equal((await cache.measure()).ok, false); assert.equal(replaced, true);
    } else {
      const p = await cache.measure(); assert.equal(p.ok, true);
      if (mode === 'hardlink') { await fs.unlink(f.http); await fs.link(privateFile, f.http); }
      else {
        const target = path.join(f.profile, 'Cache');
        await fs.rename(target, target + '-old');
        await fs.symlink(f.root, target, process.platform === 'win32' ? 'junction' : 'dir');
      }
      assert.equal((await cache.clear({ confirm: true, ticket: p.ticket })).code, 'cache_changed');
    }
    assert.equal(f.httpCalls + f.codeCalls, 0); assert.equal(await fs.readFile(privateFile, 'utf8'), 'private-sentinel');
  }
});

test('a disk target replaced during an earlier API is refused before its own API', async t => {
  const f = await diskFixture(t);
  f.session.clearCache = async () => {
    f.httpCalls++; await fs.unlink(f.http);
    const target = path.join(f.profile, 'Code Cache');
    await fs.rename(target, target + '-old'); await fs.mkdir(target);
  };
  const result = await clear(f.make());
  assert.equal(result.status, 'partial'); assert.equal(result.code, 'cache_changed');
  assert.equal(f.httpCalls, 1); assert.equal(f.codeCalls, 0);
  assert.equal(bucket(result, 'default-session-code-cache').status, 'unknown');
  assert.equal(result.diskBytes, null); assert.equal(result.releasedDiskBytes, null); assert.equal(result.diskReleaseConfirmed, false);
  assert.equal(await f.digest(), f.initialDigest);
});

test('a previously included Code Cache with unknown post-statistics stays unknown, never excluded/zero', async t => {
  const f = await diskFixture(t); let unreadable = false;
  const nativeClear = f.session.clearCodeCaches;
  f.session.clearCodeCaches = async options => { await nativeClear(options); unreadable = true; };
  const result = await clear(f.make({}, { diskOptions: { inspectPaths: async paths => {
    if (unreadable && paths.some(p => p.includes('Code Cache'))) throw Error('SECRET');
    return fakeMetadata(paths);
  } } }));
  assert.equal(result.status, 'partial'); assert.equal(f.codeCalls, 1);
  assert.equal(bucket(result, 'default-session-code-cache').status, 'unknown');
  assert.equal(bucket(result, 'default-session-code-cache').bytes, null);
  assert.equal(result.releasedDiskBytes, null); assert.equal(result.diskReleaseConfirmed, false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('read-only scanner exposes no path selector outside its fixed Chromium whitelist', async t => {
  const f = await diskFixture(t), scanner = createSessionDiskRoot(f.session, { inspectPaths: fakeMetadata });
  for (const name of ['..', '../auth.json', 'GPUCache', 'Cookies', 'Local Storage', 'mcp-registry-catalog.json.gz']) {
    await assert.rejects(scanner.scan(name), /cache_scope_invalid/);
  }
  assert.equal(await f.digest(), f.initialDigest); assert.equal(f.httpCalls + f.codeCalls, 0);
});
