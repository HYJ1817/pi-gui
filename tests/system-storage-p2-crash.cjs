'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createSystemMaintenance } = require('../electron/system-maintenance.cjs');
const { createSystemStorage } = require('../electron/system-storage-migration.cjs');
const { BOOT_FILE } = require('../electron/system-storage-policy.cjs');

const STOPPED = { writersStopped: true };
const INTERRUPTED = 86;
const PROJECTS = '{"active":"","items":[]}';
const inspected = async () => 'ok'; // Hard exits exercise disk behavior, real Win32 inspector is tested separately.

function storage(world, options) {
  return createSystemStorage({ directory: world.source, piAgentDirectory: path.join(world.base, 'pi'), inspectWindows: inspected, ...options });
}
async function executeFixtureChild() {
  const [phase, base] = process.argv.slice(3);
  const world = { base, source: path.join(base, 'source'), target: path.join(base, 'target') };
  const kernel = storage(world, { hook: point => { if (phase === point) process.exit(INTERRUPTED); } });
  if (!(await kernel.initialize()).ok) process.exit(11);
  if (phase === 'after_intent') {
    const { ticket } = succeeds(await kernel.preview(world.target));
    await kernel.commit({ ticket, confirm: true });
  } else if (!(await kernel.runPendingCold(STOPPED)).ok) process.exit(12);
  process.exit(13); // The stated checkpoint must have been reached.
}

function succeeds(reply) { assert.equal(reply.ok, true, reply.code); return reply; }
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pi-gui-storage-crash-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'), target = path.join(base, 'target');
  await fs.mkdir(source);
  await fs.mkdir(target);
  await fs.writeFile(path.join(source, 'projects.json'), PROJECTS);
  return { base, source, target, boot: path.join(source, BOOT_FILE) };
}
async function schedule(world, kernel = storage(world)) {
  succeeds(await kernel.initialize());
  const { ticket } = succeeds(await kernel.preview(world.target));
  const { intentId } = succeeds(await kernel.commit({ ticket, confirm: true }));
  assert.equal(succeeds(await kernel.arm({ transactionId: intentId })).state.phase, 'ready');
  return intentId;
}
function crash(phase, world) {
  const child = spawnSync(process.execPath, [__filename, '--fixture-child', phase, world.base], { timeout: 20_000, windowsHide: true, stdio: 'pipe' });
  assert.equal(child.error, undefined);
  assert.equal(child.status, INTERRUPTED);
}

if (process.argv[2] === '--fixture-child') {
  void executeFixtureChild().catch(() => process.exit(14));
} else {
  test('cold restart after hard exit retains original authority until verified pointer switch', async t => {
    const states = [['after_staging', 'staging'], ['after_copy_chunk', 'staging'], ['after_verified', 'verified'], ['after_committed', 'committed']];
    for (const [hook, firstPhase] of states) await t.test(hook, async sub => {
      const w = await fixture(sub);
      const transactionId = await schedule(w);
      crash(hook, w);
      const before = JSON.parse(await fs.readFile(w.boot, 'utf8'));
      assert.equal(before.transaction.phase, firstPhase);
      assert.equal(before.transaction.id, transactionId);
      assert.equal(Boolean(before.managed), firstPhase === 'committed');
      let repeatedCopies = 0;
      const reopened = storage(w, { hook: point => { if (point === 'before_copy_file') repeatedCopies++; } });
      const initialized = succeeds(await reopened.initialize());
      assert.equal(initialized.state.phase, firstPhase);
      assert.equal(initialized.state.dataDirectory, firstPhase === 'committed' ? w.target : w.source);
      const resumed = await reopened.runPendingCold(STOPPED);
      assert.equal(repeatedCopies, 0);
      assert.equal(resumed.state.transactionId, transactionId);
      if (firstPhase === 'staging') {
        assert.equal(resumed.ok, false);
        assert.equal(resumed.code, 'interrupted_staging');
        assert.equal(resumed.state.phase, 'failed');
        assert.equal(resumed.state.dataDirectory, w.source);
        if (hook === 'after_copy_chunk') assert.equal(await fs.readFile(path.join(w.target, 'projects.json'), 'utf8'), PROJECTS);
        else assert.deepEqual(await fs.readdir(w.target), []);
      } else {
        succeeds(resumed);
        assert.equal(resumed.state.phase, 'committed');
        assert.equal(resumed.state.dataDirectory, w.target);
        assert.equal(await fs.readFile(path.join(w.target, 'projects.json'), 'utf8'), PROJECTS);
        const updated = '{"active":"","items":[],"testStartupWrite":true}';
        await fs.writeFile(path.join(w.target, 'projects.json'), updated);
        const samePointer = succeeds(await reopened.runPendingCold(STOPPED));
        assert.equal(samePointer.state.transactionId, transactionId);
        assert.equal(await fs.readFile(path.join(w.target, 'projects.json'), 'utf8'), updated);
        succeeds(await reopened.markStarted({ transactionId, dataDirectory: w.target, ok: true }));
      }
      assert.equal(await fs.readFile(path.join(w.source, 'projects.json'), 'utf8'), PROJECTS);
    });
  });

  test('a crash immediately after persisting intent never authorizes a cold copy', async t => {
    const w = await fixture(t);
    crash('after_intent', w);
    const record = JSON.parse(await fs.readFile(w.boot, 'utf8'));
    assert.equal(record.transaction.phase, 'intent');
    assert.equal(record.managed, null);
    const reopened = storage(w);
    succeeds(await reopened.initialize());
    const recovery = await reopened.runPendingCold(STOPPED);
    assert.equal(recovery.code, 'shutdown_unconfirmed');
    assert.equal(recovery.state.phase, 'failed');
    assert.equal(recovery.state.dataDirectory, w.source);
    assert.deepEqual(await fs.readdir(w.target), []);
    assert.equal(await fs.readFile(path.join(w.source, 'projects.json'), 'utf8'), PROJECTS);
  });

  test('an error after boot rename preserves the intent identity without arming it', async t => {
    const w = await fixture(t);
    const io = { ...fs, rename: async (from, to) => {
      await fs.rename(from, to);
      if (to === w.boot) throw Object.assign(Error('fixture write acknowledgement'), { code: 'EIO' });
    } };
    const kernel = storage(w, { io });
    succeeds(await kernel.initialize());
    const { ticket } = succeeds(await kernel.preview(w.target));
    const failure = await kernel.commit({ ticket, confirm: true });
    assert.equal(failure.ok, false);
    assert.equal(failure.code, 'boot_write_failed');
    assert.equal(failure.state.phase, 'intent');
    assert.equal(failure.intentId, failure.state.transactionId);
    const restarted = storage(w);
    succeeds(await restarted.initialize());
    assert.equal((await restarted.runPendingCold(STOPPED)).code, 'shutdown_unconfirmed');
    assert.deepEqual(await fs.readdir(w.target), []);
  });

  test('double failure after bootstrap rename preserves in-process intent identity and restart barrier', async t => {
    const w = await fixture(t);
    let renameObserved = false;
    const io = { ...fs, rename: async (from, to) => {
      await fs.rename(from, to);
      if (to === w.boot) { renameObserved = true; throw Object.assign(Error('fixture lost acknowledgement'), { code: 'EIO' }); }
    }, lstat: async (file, ...args) => {
      if (renameObserved && file === w.boot) throw Object.assign(Error('fixture bootstrap reread unavailable'), { code: 'EIO' });
      return fs.lstat(file, ...args);
    } };
    const kernel = storage(w, { io });
    succeeds(await kernel.initialize());
    const { ticket } = succeeds(await kernel.preview(w.target));
    const child = new EventEmitter(), actions = [];
    child.connected = true;
    child.send = message => {
      actions.push(message.action);
      queueMicrotask(() => child.emit('message', { type: 'app-update', id: message.id, ok: true }));
    };
    let held = false, failure;
    const maintenance = createSystemMaintenance({ getServer: () => child,
      updates: { reserveMaintenance() { held = true; return Symbol('fixture-lease'); },
        releaseMaintenance() { held = false; } },
      relaunch: () => assert.fail('ambiguous intent cannot relaunch'), quit: () => assert.fail('ambiguous intent cannot quit') });
    t.after(() => maintenance.dispose());
    const result = await maintenance.restart({
      commit: async () => { failure = await kernel.commit({ ticket, confirm: true }); return failure; },
      arm: () => assert.fail('ambiguous intent cannot arm'),
      cancel: transactionId => kernel.cancelPending({ transactionId }),
    });
    assert.equal(result, failure);
    assert.equal(maintenance.recoveryBlocked(), true);
    assert.equal(maintenance.busy(), true);
    assert.equal(held, true, 'updater exclusion is retained with the actual unreadable storage result');
    assert.deepEqual(actions, ['inspect', 'prepare'], 'no shutdown or release of backend writers');
    assert.equal(failure.ok, false);
    assert.equal(failure.code, 'boot_write_failed');
    assert.equal(typeof failure.intentId, 'string');
    assert.equal(failure.state.transactionId, null);
    assert.equal(failure.state.phase, 'unavailable');
    assert.equal((await kernel.cancelPending({ transactionId: failure.intentId })).ok, false, 'unreadable authority must not be guessed or cleared');
    const reopened = storage(w);
    succeeds(await reopened.initialize());
    assert.equal((await reopened.runPendingCold(STOPPED)).code, 'shutdown_unconfirmed');
    assert.deepEqual(await fs.readdir(w.target), []);
  });

  test('restart re-verifies a verified payload; changing it cannot publish stale staging', async t => {
    const w = await fixture(t);
    await schedule(w);
    crash('after_verified', w);
    await fs.writeFile(path.join(w.target, 'projects.json'), PROJECTS.replace('items', 'other'));
    const restarted = storage(w);
    succeeds(await restarted.initialize());
    const result = await restarted.runPendingCold(STOPPED);
    assert.equal(result.code, 'verification_failed');
    assert.equal(result.state.phase, 'failed');
    assert.equal(result.state.dataDirectory, w.source);
    assert.equal(await fs.readFile(path.join(w.source, 'projects.json'), 'utf8'), PROJECTS);
  });

  test('a stale in-memory boot owner cannot overwrite another saved intent', async t => {
    const w = await fixture(t);
    const alt = path.join(w.base, 'another target');
    await fs.mkdir(alt);
    const first = storage(w), stale = storage(w);
    succeeds(await stale.initialize());
    const prior = succeeds(await stale.preview(alt));
    const transactionId = await schedule(w, first);
    const rejected = await stale.commit({ ticket: prior.ticket, confirm: true });
    assert.equal(rejected.code, 'boot_changed');
    assert.equal(rejected.state.dataDirectory, null);
    const recovered = succeeds(await stale.initialize());
    assert.equal(recovered.state.transactionId, transactionId);
    assert.deepEqual(await fs.readdir(alt), []);
  });

  test('same-process operations stay single-flight across asynchronous copy and boot writes', async t => {
    const w = await fixture(t);
    let release, entered;
    const copying = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const kernel = storage(w, { hook: async point => { if (point === 'before_copy_file') { entered(); await gate; } } });
    const transactionId = await schedule(w, kernel);
    const executing = kernel.runPendingCold(STOPPED);
    await copying;
    try {
      assert.equal((await kernel.runPendingCold(STOPPED)).code, 'storage_busy');
      assert.equal((await kernel.cancelPending({ transactionId })).code, 'storage_busy');
      assert.equal((await kernel.initialize()).code, 'storage_busy');
    } finally { release(); }
    assert.equal(succeeds(await executing).state.phase, 'committed');
  });
}
