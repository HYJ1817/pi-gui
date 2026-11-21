'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSystemMaintenance } = require('../electron/system-maintenance.cjs');

function fixture(options = {}) {
  const child = new EventEmitter();
  const actions = [];
  let held = null, commits = 0, arms = 0, cancellations = 0, launches = 0, quits = 0;
  child.connected = true;
  child.send = message => {
    actions.push(message.action);
    queueMicrotask(() => {
      const response = options.respond?.(message.action) ?? { ok: true };
      child.emit('message', { type: 'app-update', id: message.id, ...response });
      if (message.action === 'shutdown' && response.ok && !options.stuck) {
        child.connected = false;
        child.emit('exit', options.exitCode ?? 0);
      }
    });
  };
  const updates = {
    reserveMaintenance() { if (held || options.updateBusy) return null; return held = Symbol('lease'); },
    releaseMaintenance(lease) { assert.equal(lease, held); held = null; },
  };
  const owner = createSystemMaintenance({ getServer: () => child, updates: options.noUpdater ? null : updates, timeoutMs: 30,
    inspectDesktop: () => options.desktop ?? { ok: true },
    prepareDesktop: async () => { if (options.prepareFailure) throw Error('fixture SECRET'); },
    relaunch: () => { launches++; if (options.launchFailure) throw Error('fixture SECRET'); }, quit: () => { quits++; } });
  const request = { commit: async () => { commits++; return options.intent ?? { ok: true, intentId: 'this-intent' }; },
    arm: async id => { assert.equal(id, 'this-intent'); assert.equal(child.connected, false); arms++; return { ok: !options.armFailure }; },
    cancel: async id => { assert.equal(id, 'this-intent'); cancellations++; if (options.cancelFailure) throw Error('fixture SECRET'); return { ok: true }; } };
  return { owner, child, actions, request, values: () => ({ commits, arms, cancellations, launches, quits, held }) };
}

test('cold maintenance: unavailable updater does not block storage when no update owner exists', async () => {
  const f = fixture({ noUpdater: true });
  assert.equal((await f.owner.restart(f.request)).ok, true);
  assert.equal(f.values().arms, 1);
});

test('cold maintenance: busy updater and unowned backend admit no write or stop', async () => {
  const f = fixture({ updateBusy: true });
  assert.equal((await f.owner.restart(f.request)).code, 'update_busy');
  assert.equal(f.values().commits, 0); assert.deepEqual(f.actions, []);
  const unavailable = fixture(); unavailable.child.connected = false;
  assert.equal((await unavailable.owner.restart(unavailable.request)).ok, false);
  assert.equal(unavailable.values().held, null);
});
test('cold maintenance: active browser and backend activity cannot stop an Agent', async () => {
  for (const options of [{ desktop: { ok: false, code: 'busy-browser' } },
    { respond: action => action === 'inspect' ? { ok: false, code: 'busy-runtime' } : { ok: true } }]) {
    const f = fixture(options);
    assert.equal((await f.owner.restart(f.request)).ok, false);
    assert.equal(f.values().commits, 0); assert.ok(!f.actions.includes('prepare'));
    assert.ok(!f.actions.includes('shutdown')); assert.equal(f.values().held, null);
  }
});
test('cold maintenance: prepare failure never writes intent or releases another barrier', async () => {
  const f = fixture({ respond: action => ({ ok: action !== 'prepare' }) });
  assert.equal((await f.owner.restart(f.request)).ok, false);
  assert.deepEqual(f.actions, ['inspect', 'prepare']);
  assert.equal(f.values().commits, 0); assert.equal(f.values().held, null);
});
test('cold maintenance: intent failure resumes only the acquired barrier without restart', async () => {
  const f = fixture({ intent: { ok: false, code: 'disk_full' } });
  assert.equal((await f.owner.restart(f.request)).code, 'disk_full');
  assert.deepEqual(f.actions, ['inspect', 'prepare', 'release']);
  assert.equal(f.values().launches, 0); assert.equal(f.values().cancellations, 0);
});
test('cold maintenance: an intent reported durable after a write error is cancelled before release', async () => {
  const f = fixture({ intent: { ok: false, code: 'boot_write_failed', intentId: 'this-intent' } });
  const send = f.child.send;
  f.child.send = request => {
    if (request.action === 'release') assert.equal(f.values().cancellations, 1);
    send(request);
  };
  assert.equal((await f.owner.restart(f.request)).code, 'boot_write_failed');
  assert.equal(f.values().arms, 0);
  assert.equal(f.values().cancellations, 1);
  assert.deepEqual(f.actions, ['inspect', 'prepare', 'release']);
});

test('cold maintenance: dirty exit or failure to arm never requests a relaunch', async () => {
  for (const options of [{ exitCode: 1 }, { armFailure: true }]) {
    const f = fixture(options);
    assert.equal((await f.owner.restart(f.request)).ok, false);
    assert.equal(f.values().arms, options.exitCode ? 0 : 1);
    assert.equal(f.values().launches, 0);
    assert.equal(f.owner.restarting(), false);
    assert.equal(f.owner.recoveryBlocked(), true);
  }
});

test('cold maintenance: desktop drain failure preserves data and resumes Pi', async () => {
  const f = fixture({ prepareFailure: true });
  const result = await f.owner.restart(f.request);
  assert.equal(result.code, 'maintenance_failed'); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.equal(f.values().commits, 0); assert.deepEqual(f.actions, ['inspect', 'prepare', 'release']);
});
test('cold maintenance: one intent after prepare, actual exit before relaunch, single flight', async () => {
  const f = fixture();
  const pending = f.owner.restart(f.request);
  assert.equal((await f.owner.restart(f.request)).code, 'maintenance_busy');
  assert.equal((await pending).restartPending, true);
  assert.equal(f.child.connected, false);
  assert.equal(f.values().arms, 1);
  assert.deepEqual(f.actions, ['inspect', 'prepare', 'shutdown']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.values().commits, 1); assert.equal(f.values().launches, 1); assert.equal(f.values().quits, 1);
  assert.equal(f.owner.restarting(), true); assert.ok(f.values().held);
});
test('cold maintenance: unconfirmed exit cancels intent and does not claim restart', async () => {
  const f = fixture({ stuck: true });
  const result = await f.owner.restart(f.request);
  assert.equal(result.code, 'backend_exit_unconfirmed');
  assert.equal(f.values().cancellations, 1); assert.equal(f.values().launches, 0);
  assert.equal(f.values().held, null); assert.equal(f.owner.busy(), false);
});
test('cold maintenance: post-exit relaunch failure preserves recovery intent, no automatic old-root rollback', async () => {
  const f = fixture({ launchFailure: true });
  const result = await f.owner.restart(f.request);
  assert.equal(result.ok, false); assert.match(result.error, /重新启动应用/);
  assert.equal(f.values().cancellations, 0); assert.ok(!f.actions.includes('release'));
});
test('cold maintenance: failed intent cancellation retains barrier and updater exclusion', async () => {
  const f = fixture({ stuck: true, cancelFailure: true });
  assert.equal((await f.owner.restart(f.request)).ok, false);
  assert.equal(f.owner.recoveryBlocked(), true); assert.equal(f.owner.busy(), true);
  assert.ok(f.values().held); assert.ok(!f.actions.includes('release'));
  assert.equal((await f.owner.restart(f.request)).code, 'maintenance_busy');
});
test('cold maintenance: storage correlation IDs cannot consume late updater replies', async () => {
  const f = fixture();
  const send = f.child.send;
  f.child.send = request => {
    assert.ok(Number.isSafeInteger(request.id) && request.id < 0);
    f.child.emit('message', { type: 'app-update', id: Math.abs(request.id), ok: false, code: 'stale' });
    send(request);
  };
  assert.equal((await f.owner.restart(f.request)).ok, true);
  await new Promise(resolve => setImmediate(resolve));
});
test('cold maintenance: quit cannot destroy the owner while intent acceptance is unresolved', async () => {
  const f = fixture(); let prevented = 0;
  const pending = f.owner.restart(f.request);
  assert.equal(f.owner.deferQuit({ preventDefault: () => prevented++ }), true);
  assert.equal(prevented, 1); await pending;
  assert.equal(f.owner.deferQuit({ preventDefault: () => prevented++ }), false);
  await new Promise(resolve => setImmediate(resolve));
});
test('cold maintenance: failed migration replays an explicit quit, not an earlier window close', async () => {
  const f = fixture({ intent: { ok: false, code: 'disk_full' } });
  const pending = f.owner.restart(f.request);
  let closes = 0, prevented = 0;
  const event = { preventDefault: () => prevented++ };
  assert.equal(f.owner.deferQuit(event, () => closes++), true);
  assert.equal(f.owner.deferQuit(event), true);
  assert.equal(f.owner.deferQuit(event, () => closes++), true);
  assert.equal((await pending).code, 'disk_full');
  assert.equal(f.values().held, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, 3);
  assert.equal(closes, 0);
  assert.equal(f.values().quits, 1);
});

test('cold maintenance: disposed owner rejects new maintenance', async () => {
  const f = fixture(); f.owner.dispose();
  assert.equal((await f.owner.restart(f.request)).code, 'maintenance_busy');
  assert.deepEqual(f.actions, []);
});
