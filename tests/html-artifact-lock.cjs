/* Real local child handles + TEMP fixtures. Never addresses unrelated PIDs. */
const strict = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const processIdentity = require('../lib/process-identity.cjs');
let assertions = 0, checks = 0, skipped = 0;
const assert = new Proxy(strict, { get(target, key) {
  const value = target[key];
  return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value;
} });
const input = { sessionId: 'lock-session', messageId: 'lock-message', toolCallId: 'lock-call',
  title: 'Fixture', html: '<p>lock fixture</p>' };
const busy = error => error?.code === 'html_artifact_storage_busy';
const snapshot = root => fs.readdirSync(root).sort().map(name => {
  const file = path.join(root, name);
  return [name, fs.lstatSync(file).isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('hex')];
});
async function check(name, action) { await action(); checks++; console.log('  ok ' + name); }
(async () => {
  const { createHtmlArtifactStore } = await import('../server/html-artifact-store.js');
  const { htmlArtifactLockOwner, htmlArtifactOwnerDead, queryHtmlArtifactProcess,
    acquireHtmlArtifactGate } = await import('../server/html-artifact-lock.js');
  if (process.argv[2] === '--child') {
    const [dataDir, action, barrier] = process.argv.slice(3);
    const emit = value => fs.writeSync(1, JSON.stringify(value) + '\n');
    if (action === 'cold-self') {
      const query = processIdentity.queryProcessIdentity;
      // Observe which reviewed probe is used, but return only its REAL OS
      // evidence. The barrier models delayed startup, not permission success.
      processIdentity.queryProcessIdentitySync = () => { throw Error('sync_probe_used'); };
      processIdentity.queryProcessIdentity = async pid => {
        emit({ stage: 'self-query-pending' });
        const deadline = Date.now() + 20000;
        while (!fs.existsSync(barrier) && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 10));
        if (!fs.existsSync(barrier)) throw Error('fixture_timeout');
        return query(pid);
      };
    }
    const store = createHtmlArtifactStore({ dataDir, checkpoint(stage) {
      if (action === 'crash' && stage === 'before-rename') process.exit(73);
      const held = action === 'recover-hold' ? 'recovery-proven' : action === 'hold-renamed' ? 'renamed' : 'before-rename';
      if (['recover-hold', 'hold', 'hold-renamed'].includes(action) && stage === held) {
        emit({ stage });
        const deadline = Date.now() + 20000;
        while (!fs.existsSync(barrier) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        if (!fs.existsSync(barrier)) throw Error('fixture_timeout');
      }
    } });
    try {
      const result = action.startsWith('recover') ? await store.recoverLock() : await store.publish(input);
      emit({ ok: true, result });
    } catch (error) { emit({ ok: false, code: error.code }); }
    return;
  }
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-html-lock-')), children = new Set();
  let serial = 0;
  function fixture(extra = {}) {
    const dataDir = path.join(world, String(++serial)); fs.mkdirSync(dataDir);
    const root = path.join(dataDir, 'html-artifacts');
    return { dataDir, root, store: createHtmlArtifactStore({ dataDir, ...extra }), lock: path.join(root, '.writer.lock') };
  }
  function child(f, action) {
    const barrier = path.join(f.dataDir, 'fixture-release-' + randomUUID());
    const process = spawn(global.process.execPath, [__filename, '--child', f.dataDir, action, barrier],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.add(process);
    let pending = '', messages = [], errors = '', resolveReady, rejectReady;
    const ready = new Promise((yes, no) => { resolveReady = yes; rejectReady = no; });
    // Some actions exit without holding a checkpoint; suppress only unobserved ready rejection.
    ready.catch(() => {});
    process.stdout.on('data', bytes => {
      pending += bytes;
      for (;;) {
        const end = pending.indexOf('\n'); if (end < 0) break;
        const message = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
        messages.push(message); if (message.stage) resolveReady(message);
      }
    });
    process.stderr.on('data', bytes => { errors += bytes; });
    const timeout = setTimeout(() => process.kill('SIGKILL'), 30000);
    const done = new Promise((resolve, reject) => {
      process.once('error', reject);
      process.once('close', (status, signal) => {
        clearTimeout(timeout); children.delete(process); rejectReady(Error('child exited before stage: ' + errors));
        resolve({ status, signal, messages, errors });
      });
    });
    return { process, ready, done, release: () => fs.writeFileSync(barrier, 'release') };
  }
  const supported = ['win32', 'linux'].includes(process.platform);
  const identity = process.platform === 'linux'
    ? JSON.stringify(['linux', '12345678-1234-4234-8234-123456789abc', '12345'])
    : JSON.stringify(['win32', '133000000000000000', 'c:\\fixture\\node.exe']);
  const owner = () => ({ version: 2, pid: 12345, processIdentity: identity, nonce: randomUUID() });
  try {
    await check('empty, malformed, denied or throwing identity probes cannot prove a dead owner', async () => {
      const value = owner();
      for (const query of [() => ({ state: 'unknown' }), () => ({ state: 'found', identity: '' }),
        () => ({ state: 'found' }), () => { throw Error('probe denied'); }]) {
        assert.equal(htmlArtifactOwnerDead(value, query), false);
      }
      assert.equal(htmlArtifactOwnerDead({ ...value, processIdentity: 'unrecognized-owner' }, () => ({ state: 'gone' })), false);
    });
    await check('PID existence is not identity; same birth stays live, reused birth proves only the OLD owner dead', async () => {
      const value = owner();
      assert.equal(htmlArtifactOwnerDead(value, () => ({ state: 'found', identity })), false);
      const reused = process.platform === 'linux' ? JSON.stringify(['linux', '12345678-1234-4234-8234-123456789abc', '12346'])
        : JSON.stringify(['win32', '133000000000000001', 'c:\\fixture\\node.exe']);
      assert.equal(htmlArtifactOwnerDead(value, () => ({ state: 'found', identity: reused })), true);
      assert.equal(htmlArtifactOwnerDead(value, () => ({ state: 'gone' })), true);
      for (const bad of [{ ...value, version: 1 }, { ...value, nonce: 'unknown' }, { ...value, pid: 0 },
        { ...value, extra: 'not-our-schema' }, null, [], {}]) {
        assert.equal(htmlArtifactOwnerDead(bad, () => ({ state: 'gone' })), false);
      }
    });
    await check('unknown self identity prevents lock creation, not merely recovery', async () => {
      const f = fixture({ queryProcess: () => ({ state: 'unknown' }) });
      await assert.rejects(f.store.publish(input), busy);
      assert.deepEqual(fs.readdirSync(f.root), []);
      await assert.rejects(htmlArtifactLockOwner(() => ({ state: 'found', identity: '' })), busy);
    });
    await check('legacy, empty, torn, future and unknown records stay byte-for-byte intact on recovery', async () => {
      for (const bytes of ['', 'abandoned', '{"version":2', JSON.stringify({ pid: 1 }),
        JSON.stringify({ ...owner(), version: 3 }), JSON.stringify({ ...owner(), processIdentity: 'unknown' })]) {
        const f = fixture({ queryProcess: () => ({ state: 'gone' }) });
        fs.mkdirSync(f.root, { mode: 0o700 }); fs.writeFileSync(f.lock, bytes);
        const before = snapshot(f.root);
        await assert.rejects(f.store.recoverLock(), busy);
        await assert.rejects(f.store.publish(input), busy);
        await assert.rejects(f.store.stats(), busy);
        assert.deepEqual(snapshot(f.root), before);
      }
    });
    if (process.platform === 'win32') await check('Windows successful query lacking image/time is UNKNOWN, not a different owner', async () => {
      const original = processIdentity.queryProcessIdentitySync;
      try {
        for (const value of [{ state: 'found', creationTimeUtc: '133000000000000000', imagePath: '' },
          { state: 'found', creationTimeUtc: 'bad', imagePath: 'C:\\fixture\\node.exe' }]) {
          processIdentity.queryProcessIdentitySync = () => value;
          assert.deepEqual(queryHtmlArtifactProcess(1), { state: 'unknown' });
        }
      } finally { processIdentity.queryProcessIdentitySync = original; }
    });
    await check('async unknown, gone, malformed and rejected self probes still fail closed', async () => {
      for (const value of [{ state: 'unknown' }, { state: 'gone' }, { state: 'found', identity: '' }])
        await assert.rejects(htmlArtifactLockOwner(async () => value), busy);
      await assert.rejects(htmlArtifactLockOwner(async () => { throw Error('denied'); }), busy);
    });
    if (supported) {
      if (process.platform === 'win32') await check('cold self probe yields under the gate and uses real async OS evidence', async () => {
        const f = fixture(), running = child(f, 'cold-self');
        try {
          assert.equal((await running.ready).stage, 'self-query-pending');
          assert.deepEqual(fs.readdirSync(f.root), []);
          await assert.rejects(acquireHtmlArtifactGate(f.root), busy);
          await assert.rejects(f.store.publish(input), busy);
        } finally { running.release(); }
        const done = await running.done;
        assert.equal(done.status, 0); assert.equal(done.messages.at(-1).ok, true);
        assert.equal((await f.store.read(done.messages.at(-1).result.id)).html, input.html);
      });
      for (const replaced of ['root', 'data']) await check('identity await rejects physical directory replacement: ' + replaced, async () => {
        let enter, resume;
        const entered = new Promise(resolve => { enter = resolve; });
        const paused = new Promise(resolve => { resume = resolve; });
        const f = fixture({ queryProcess: async pid => { enter(); await paused; return queryHtmlArtifactProcess(pid); } });
        const publishing = f.store.publish(input);
        await entered;
        try {
          const target = replaced === 'root' ? f.root : f.dataDir;
          fs.renameSync(target, target + '-original'); fs.mkdirSync(target, { mode: 0o700 });
        } finally { resume(); }
        await assert.rejects(publishing, error => error.code === 'html_artifact_storage_unsafe');
        assert.deepEqual(fs.readdirSync(replaced === 'root' ? f.root : f.dataDir), []);
        const original = replaced === 'root' ? f.root + '-original' : path.join(f.dataDir + '-original', 'html-artifacts');
        assert.deepEqual(fs.readdirSync(original), []);
        await (await acquireHtmlArtifactGate(original))();
      });
      await check('real local OS reports a stable creation identity for THIS process', async () => {
        const first = queryHtmlArtifactProcess(process.pid), second = queryHtmlArtifactProcess(process.pid);
        assert.equal(first.state, 'found'); assert.deepEqual(second, first);
        const record = await htmlArtifactLockOwner();
        assert.equal(record.pid, process.pid); assert.equal(record.processIdentity, first.identity);
        assert.equal(htmlArtifactOwnerDead(record), false);
      });
      await check('kernel gate excludes aliases and releases after normal close', async () => {
        const f = fixture(); fs.mkdirSync(f.root, { mode: 0o700 });
        const release = await acquireHtmlArtifactGate(f.root);
        try {
          const alias = process.platform === 'win32' ? f.root.toUpperCase() : path.join(f.root, '.');
          await assert.rejects(acquireHtmlArtifactGate(alias), busy);
        } finally { await release(); }
        await (await acquireHtmlArtifactGate(f.root))();
        assert.deepEqual(fs.readdirSync(f.root), []);
      });
      await check('live writer excludes recovery and a second writer before temp publication', async () => {
        const f = fixture(), running = child(f, 'hold');
        try {
          assert.equal((await running.ready).stage, 'before-rename');
          const before = snapshot(f.root);
          await assert.rejects(f.store.recoverLock(), busy);
          await assert.rejects(f.store.publish(input), busy);
          assert.deepEqual(snapshot(f.root), before);
        } finally { running.release(); }
        const done = await running.done;
        assert.equal(done.status, 0); assert.equal(done.messages.at(-1).ok, true);
        assert.equal((await f.store.read(done.messages.at(-1).result.id)).html, input.html);
      });
      await check('process crash releases kernel gate; only explicit proven-dead recovery removes its lock', async () => {
        const f = fixture(), crashed = await child(f, 'crash').done;
        assert.equal(crashed.status, 73); assert.equal(fs.existsSync(f.lock), true);
        const before = snapshot(f.root);
        await assert.rejects(f.store.publish(input), busy); assert.deepEqual(snapshot(f.root), before);
        assert.deepEqual(await f.store.recoverLock(), { ok: true, exists: true });
        assert.equal(fs.existsSync(f.lock), false);
        // Recovery does not automatically discard the interrupted temp evidence.
        assert.equal(fs.readdirSync(f.root).filter(name => name.startsWith('.tmp-')).length, 1);
        await assert.rejects(f.store.publish(input), busy);
        assert.deepEqual(await f.store.cleanupTemporary(), { removed: 1, retained: 0 });
        const ref = await f.store.publish(input); assert.equal((await f.store.read(ref.id)).html, input.html);
      });
      for (const action of ['hold', 'hold-renamed']) await check('hard kill by owned child HANDLE preserves state: ' + action, async () => {
        const f = fixture(), running = child(f, action);
        await running.ready;
        const before = snapshot(f.root);
        assert.equal(running.process.kill('SIGKILL'), true);
        const killed = await running.done;
        assert.notEqual(killed.status, 0); assert.deepEqual(snapshot(f.root), before);
        const stale = JSON.parse(fs.readFileSync(f.lock));
        assert.equal(htmlArtifactOwnerDead(stale), true);
        await f.store.recoverLock(); assert.equal(fs.existsSync(f.lock), false);
        const names = fs.readdirSync(f.root);
        if (action === 'hold') {
          assert.equal(names.filter(name => name.startsWith('.tmp-')).length, 1);
          await f.store.cleanupTemporary();
        } else {
          assert.equal(names.length, 1);
          assert.equal((await f.store.read(names[0])).html, input.html);
          assert.equal(fs.readFileSync(path.join(f.root, names[0], '.pending'), 'utf8'), '1\n');
        }
      });
      await check('simultaneous recoverers cannot unlink each other or admit a writer during recovery', async () => {
        const f = fixture(); assert.equal((await child(f, 'crash').done).status, 73);
        const recoverer = child(f, 'recover-hold');
        try {
          assert.equal((await recoverer.ready).stage, 'recovery-proven');
          const before = snapshot(f.root);
          const contenders = await Promise.all(Array.from({ length: 3 }, () => child(f, 'recover').done));
          for (const result of contenders) {
            assert.equal(result.status, 0);
            assert.deepEqual(result.messages.at(-1), { ok: false, code: 'html_artifact_storage_busy' });
          }
          await assert.rejects(f.store.publish(input), busy);
          assert.deepEqual(snapshot(f.root), before);
        } finally { recoverer.release(); }
        const done = await recoverer.done;
        assert.equal(done.status, 0); assert.equal(done.messages.at(-1).ok, true);
        assert.equal(fs.existsSync(f.lock), false);
        await f.store.cleanupTemporary(); const ref = await f.store.publish(input);
        assert.equal((await f.store.read(ref.id)).html, input.html);
      });
      await check('PID-reuse simulation recovers only an old record, never signals its live replacement', async () => {
        const f = fixture(), current = queryHtmlArtifactProcess(process.pid);
        const parts = JSON.parse(current.identity);
        parts[process.platform === 'linux' ? 2 : 1] = (BigInt(parts[process.platform === 'linux' ? 2 : 1]) - 1n).toString();
        fs.mkdirSync(f.root, { mode: 0o700 });
        fs.writeFileSync(f.lock, JSON.stringify({ version: 2, pid: process.pid, processIdentity: JSON.stringify(parts), nonce: randomUUID() }));
        assert.equal((await f.store.recoverLock()).ok, true);
        assert.equal(fs.existsSync(f.lock), false);
        assert.deepEqual(queryHtmlArtifactProcess(process.pid), current);
      });
      function releaseFixture() {
        const io = Object.create(fs), fault = { remaining: 0, attempts: 0 };
        const f = fixture({ io });
        io.unlinkSync = (file, ...args) => {
          if (file === f.lock) {
            fault.attempts++;
            if (fault.remaining > 0) {
              fault.remaining--;
              throw Object.assign(Error('PRIVATE ' + f.dataDir + ' ' + input.html), { code: 'EACCES' });
            }
          }
          return fs.unlinkSync(file, ...args);
        };
        return { ...f, io, fault };
      }
      const releaseFailed = error => {
        assert.equal(error.code, 'html_artifact_storage_release_failed');
        assert.equal(error.message, error.code);
        assert.deepEqual(Object.keys(error), ['code']);
        return true;
      };
      await check('recover reports its own unlink failure once, releases the gate and retries only its own proof', async () => {
        const f = releaseFixture(), ref = await f.store.publish(input), before = snapshot(f.root);
        f.fault.remaining = 1; f.fault.attempts = 0;
        await assert.rejects(f.store.recoverLock(), releaseFailed);
        assert.equal(f.fault.attempts, 1); assert.equal(fs.existsSync(f.lock), true);
        assert.equal(JSON.parse(fs.readFileSync(f.lock)).pid, process.pid);
        // Failure must release the kernel gate, not strand it or spin on unlink.
        await (await acquireHtmlArtifactGate(f.root))();
        assert.deepEqual(await f.store.recoverLock(), { ok: true, exists: true });
        assert.equal(f.fault.attempts, 3); assert.deepEqual(snapshot(f.root), before);
        assert.equal((await f.store.read(ref.id)).html, input.html);
      });
      await check('persistent own release failures stay release_failed, not busy, without rerunning the action', async () => {
        const f = releaseFixture(), ref = await f.store.publish(input);
        f.fault.remaining = 10; f.fault.attempts = 0;
        await assert.rejects(f.store.recoverLock(), releaseFailed);
        const before = snapshot(f.root);
        for (const action of [() => f.store.read(ref.id), () => f.store.stats(), () => f.store.recoverLock()]) {
          await assert.rejects(action(), releaseFailed);
          assert.deepEqual(snapshot(f.root), before);
          await (await acquireHtmlArtifactGate(f.root))();
        }
        assert.equal(f.fault.attempts, 4);
        f.fault.remaining = 0;
        assert.equal((await f.store.read(ref.id)).html, input.html);
        assert.equal(fs.existsSync(f.lock), false);
      });
      await check('publish release failure preserves committed bytes and pending; same-tuple retry returns the original reference', async () => {
        const f = releaseFixture(); f.fault.remaining = 1;
        await assert.rejects(f.store.publish(input), releaseFailed);
        const ids = fs.readdirSync(f.root).filter(name => !name.startsWith('.'));
        assert.equal(ids.length, 1);
        const dir = path.join(f.root, ids[0]), before = snapshot(dir);
        const ref = JSON.parse(fs.readFileSync(path.join(dir, 'reference.json')));
        assert.equal(fs.readFileSync(path.join(dir, 'document.html'), 'utf8'), input.html);
        assert.equal(fs.readFileSync(path.join(dir, '.pending'), 'utf8'), '1\n');
        assert.deepEqual(await f.store.publish(input), ref);
        assert.deepEqual(snapshot(dir), before); assert.deepEqual(fs.readdirSync(f.root), ids);
        assert.deepEqual(await f.store.read(ref.id), { artifact: ref, html: input.html });
      });
      for (const mode of ['no-op', 'removed-then-error']) await check('release confirms absence and handles uncertain unlink outcome: ' + mode, async () => {
        const io = Object.create(fs), f = fixture({ io }); let once = true;
        io.unlinkSync = (file, ...args) => {
          if (file === f.lock && once) {
            once = false;
            if (mode === 'no-op') return;
            fs.unlinkSync(file, ...args);
            throw Object.assign(Error('PRIVATE ' + f.dataDir), { code: 'EIO' });
          }
          return fs.unlinkSync(file, ...args);
        };
        await assert.rejects(f.store.publish(input), releaseFailed);
        assert.equal(fs.existsSync(f.lock), mode === 'no-op');
        await (await acquireHtmlArtifactGate(f.root))();
        const ref = await f.store.publish(input);
        assert.equal((await f.store.read(ref.id)).html, input.html);
        assert.equal(fs.existsSync(f.lock), false);
      });
      await check('same PID is not a release capability: a second Store cannot steal the live residual lock', async () => {
        const f = releaseFixture(); await f.store.publish(input); f.fault.remaining = 1;
        await assert.rejects(f.store.recoverLock(), releaseFailed);
        const other = createHtmlArtifactStore({ dataDir: f.dataDir }), before = snapshot(f.root);
        await assert.rejects(other.recoverLock(), busy); await assert.rejects(other.publish(input), busy);
        assert.deepEqual(snapshot(f.root), before);
        assert.equal((await f.store.recoverLock()).ok, true);
        assert.equal((await other.publish(input)).sessionId, input.sessionId);
      });
      for (const replacement of ['inode', 'owner-bytes', 'root']) await check('residual release proof rejects replacement: ' + replacement, async () => {
        const f = releaseFixture(); await f.store.publish(input); f.fault.remaining = 1;
        await assert.rejects(f.store.recoverLock(), releaseFailed);
        const foreign = JSON.stringify(await htmlArtifactLockOwner()) + '\n';
        if (replacement === 'root') {
          fs.renameSync(f.root, path.join(f.dataDir, 'original-root'));
          fs.mkdirSync(f.root, { mode: 0o700 });
        } else if (replacement === 'inode') fs.renameSync(f.lock, path.join(f.dataDir, 'original-lock'));
        fs.writeFileSync(f.lock, foreign);
        const before = snapshot(f.root), attempts = f.fault.attempts;
        for (let retry = 0; retry < 2; retry++) {
          await assert.rejects(f.store.recoverLock(), error => error.code === 'html_artifact_storage_unsafe');
          assert.deepEqual(snapshot(f.root), before);
          assert.equal(f.fault.attempts, attempts);
        }
        assert.equal(fs.readFileSync(f.lock, 'utf8'), foreign);
      });
      for (const action of ['read', 'stats', 'collect', 'cleanupTemporary']) await check('release failure is not complete success for ' + action, async () => {
        const f = releaseFixture(), ref = await f.store.publish(input);
        const dir = path.join(f.root, ref.id), before = fs.readFileSync(path.join(dir, 'document.html'));
        if (action === 'cleanupTemporary') {
          const temp = path.join(f.root, '.tmp-' + randomUUID());
          fs.mkdirSync(temp); fs.writeFileSync(path.join(temp, 'document.html'), 'fixture');
        }
        f.fault.remaining = 1;
        const operation = action === 'read' ? () => f.store.read(ref.id)
          : action === 'collect' ? () => f.store.collect({ scan: () => ({ complete: true,
            referencedIds: [ref.id], beforeMs: Date.now() }) }) : () => f.store[action]();
        await assert.rejects(operation(), releaseFailed);
        assert.equal(fs.existsSync(f.lock), true);
        assert.deepEqual(fs.readFileSync(path.join(dir, 'document.html')), before);
        if (action === 'collect') assert.equal(fs.existsSync(path.join(dir, '.pending')), false);
        if (action === 'cleanupTemporary') assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.tmp-')), false);
        assert.equal((await f.store.read(ref.id)).html, input.html);
        assert.equal(fs.existsSync(f.lock), false);
      });
      await check('business failure remains primary when release also fails; exact residual proof is still retryable', async () => {
        const f = releaseFixture(), ref = await f.store.publish(input), before = snapshot(path.join(f.root, ref.id));
        f.fault.remaining = 1;
        await assert.rejects(f.store.publish({ ...input, title: 'Conflict' }), error => {
          assert.equal(error.code, 'html_artifact_conflict'); assert.equal(error.message, error.code);
          assert.deepEqual(Object.keys(error), ['code']); return true;
        });
        assert.equal(fs.existsSync(f.lock), true);
        assert.equal((await f.store.recoverLock()).ok, true);
        assert.deepEqual(snapshot(path.join(f.root, ref.id)), before);
      });
      await check('close failure is reported independently while the file lock and kernel gate are still released', async () => {
        const io = Object.create(fs), writerFds = new Set(); let failures = 1;
        const f = fixture({ io });
        io.openSync = (file, flags, ...args) => {
          const fd = fs.openSync(file, flags, ...args);
          if (file === f.lock && flags === 'wx') writerFds.add(fd);
          return fd;
        };
        io.closeSync = fd => {
          const writer = writerFds.delete(fd); fs.closeSync(fd);
          if (writer && failures-- > 0) throw Object.assign(Error('PRIVATE ' + f.dataDir), { code: 'EIO' });
        };
        await assert.rejects(f.store.publish(input), error => error.code === 'html_artifact_storage_failed'
          && error.message === error.code);
        assert.equal(fs.existsSync(f.lock), false); assert.equal(writerFds.size, 0);
        await (await acquireHtmlArtifactGate(f.root))();
        const ref = await f.store.publish(input);
        assert.equal((await f.store.read(ref.id)).html, input.html);
      });
      for (const mode of ['ENOSPC', 'short-write']) await check('partial owner acquisition plus failed unlink retains only this Store release capability: ' + mode, async () => {
        const f = releaseFixture(), ref = await f.store.publish(input), writers = new Set(); let once = true;
        f.io.openSync = (file, flags, ...args) => {
          const fd = fs.openSync(file, flags, ...args);
          if (file === f.lock && flags === 'wx') writers.add(fd);
          return fd;
        };
        f.io.closeSync = fd => { writers.delete(fd); return fs.closeSync(fd); };
        f.io.writeFileSync = (fd, bytes, ...args) => {
          if (writers.has(fd) && once) {
            once = false; fs.writeFileSync(fd, Buffer.from('{'));
            if (mode === 'ENOSPC') throw Object.assign(Error('PRIVATE ' + f.dataDir), { code: 'ENOSPC' });
            return;
          }
          return fs.writeFileSync(fd, bytes, ...args);
        };
        f.fault.remaining = 1;
        await assert.rejects(f.store.publish({ ...input, messageId: 'next' }), error =>
          error.code === (mode === 'ENOSPC' ? 'html_artifact_storage_failed' : 'html_artifact_storage_corrupt'));
        assert.equal(fs.readFileSync(f.lock, 'utf8'), '{');
        const before = snapshot(f.root), other = createHtmlArtifactStore({ dataDir: f.dataDir });
        await assert.rejects(other.recoverLock(), busy); assert.deepEqual(snapshot(f.root), before);
        assert.equal((await f.store.recoverLock()).ok, true);
        assert.equal((await f.store.read(ref.id)).html, input.html);
        assert.equal(fs.existsSync(f.lock), false);
      });
      await check('a different owner in the acquisition inode cannot be laundered as a partial owner write', async () => {
        const io = Object.create(fs), f = fixture({ io }), writers = new Set();
        const foreign = JSON.stringify(await htmlArtifactLockOwner()) + '\n';
        io.openSync = (file, flags, ...args) => {
          const fd = fs.openSync(file, flags, ...args);
          if (file === f.lock && flags === 'wx') writers.add(fd);
          return fd;
        };
        io.closeSync = fd => { writers.delete(fd); return fs.closeSync(fd); };
        io.writeFileSync = (fd, bytes, ...args) => fs.writeFileSync(fd, writers.has(fd) ? foreign : bytes, ...args);
        await assert.rejects(f.store.publish(input), error => error.code === 'html_artifact_storage_corrupt');
        assert.equal(fs.readFileSync(f.lock, 'utf8'), foreign);
        await assert.rejects(f.store.recoverLock(), error => error.code === 'html_artifact_storage_unsafe');
        assert.equal(fs.readFileSync(f.lock, 'utf8'), foreign);
        await (await acquireHtmlArtifactGate(f.root))();
      });
      await check('acquisition fsync plus release failure preserves the original error and releases the gate', async () => {
        const f = releaseFixture(), writerFds = new Set(); let failures = 1;
        f.io.openSync = (file, flags, ...args) => {
          const fd = fs.openSync(file, flags, ...args);
          if (file === f.lock && flags === 'wx') writerFds.add(fd);
          return fd;
        };
        f.io.closeSync = fd => { writerFds.delete(fd); return fs.closeSync(fd); };
        f.io.fsyncSync = fd => {
          if (writerFds.has(fd) && failures-- > 0) throw Object.assign(Error('PRIVATE ' + f.dataDir), { code: 'EIO' });
          return fs.fsyncSync(fd);
        };
        f.fault.remaining = 1;
        await assert.rejects(f.store.publish(input), error => error.code === 'html_artifact_storage_failed');
        assert.equal(fs.existsSync(f.lock), true);
        await (await acquireHtmlArtifactGate(f.root))();
        assert.equal((await f.store.recoverLock()).ok, true);
        const ref = await f.store.publish(input); assert.equal((await f.store.read(ref.id)).html, input.html);
      });
      await check('a later foreign lock swapped after identity proof is preserved, not removed', async () => {
        const f = fixture(); assert.equal((await child(f, 'crash').done).status, 73);
        const foreign = JSON.stringify(await htmlArtifactLockOwner());
        const store = createHtmlArtifactStore({ dataDir: f.dataDir, checkpoint(stage) {
          if (stage === 'recovery-proven') { fs.unlinkSync(f.lock); fs.writeFileSync(f.lock, foreign); }
        } });
        await assert.rejects(store.recoverLock(), error => error.code === 'html_artifact_storage_unsafe');
        assert.equal(fs.readFileSync(f.lock, 'utf8'), foreign);
        await assert.rejects(f.store.recoverLock(), busy);
      });
    } else { skipped++; console.log('  SKIP local OS gate/creation-identity integration unsupported; fail-closed probes only'); }
    console.log(`HTML artifact lock: ${checks}/${checks} scenarios; assertions=${assertions}; skipped=${skipped}`);
  } finally {
    for (const running of children) running.kill('SIGKILL');
    // All owned children have a bounded deadline. Only TEMP fixture trees are removed.
    await Promise.all([...children].map(running => new Promise(resolve => running.once('close', resolve))));
    fs.rmSync(world, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
