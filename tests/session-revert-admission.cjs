const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log('  ok  ' + name); };
(async () => {
  const { createSessionRevertAdmission } = await import('../server/session-revert-admission.js');
  const { createSessionRevertMutationAuthority } = await import('../server/session-revert-authority.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p34-admission-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'p34-other-'));
  try {
    const gate = createSessionRevertAdmission();
    await check('reservation is immediate, exclusive, and blocks canonical aliases', () => {
      const lease = gate.acquire(root);
      assert.throws(() => gate.acquire(path.join(root, '.')), { code: 'workspace_revert_busy' });
      assert.throws(() => gate.assertAllowed(root), { code: 'workspace_revert_busy' });
      assert.throws(() => gate.enterWriter(root), { code: 'workspace_revert_busy' });
      gate.assertAllowed(other); lease.release(); lease.release(); gate.assertAllowed(root);
      assert.throws(() => lease.assertCurrent(root), { code: 'stale_revert_token' });
    });
    await check('already entered disk writer drains while gate rejects new writers', async () => {
      const leave = gate.enterWriter(root), lease = gate.acquire(root);
      let drained = false; const waiting = lease.drain().then(() => { drained = true; });
      await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
      leave(); await waiting; assert.equal(drained, true); lease.release();
    });
    await check('drain timeout refuses mutation and release reopens admission', async () => {
      const leave = gate.enterWriter(root), lease = gate.acquire(root);
      await assert.rejects(lease.drain({ timeout: 5 }), { code: 'active_writer' });
      lease.release(); leave(); gate.assertAllowed(root);
    });
    await check('expiry revokes retained confirmation lease', async () => {
      const expiring = createSessionRevertAdmission({ timeoutMs: 5 }); const lease = expiring.acquire(root);
      await new Promise(resolve => setTimeout(resolve, 15));
      assert.throws(() => lease.assertCurrent(), { code: 'stale_revert_token' }); expiring.assertAllowed(root);
    });
    await check('authorized in-flight apply holds GUI gate past confirmation expiry until settled', async () => {
      const expiring = createSessionRevertAdmission({ timeoutMs: 5 }), lease = expiring.acquire(root);
      lease.pinForApply(); await new Promise(resolve => setTimeout(resolve, 65));
      lease.assertCurrent(root);
      assert.throws(() => expiring.enterWriter(root), { code: 'workspace_revert_busy' });
      lease.release(); expiring.assertAllowed(root);
      assert.throws(() => lease.pinForApply(), { code: 'stale_revert_token' });
    });
    const scope = { workspaceId: 'w', nativeSessionId: 'native', runtimeOwner: { runtimeId: 'r' } };
    let locked = false, stops = 0, revalidations = 0;
    const authority = async (_req, _body, action) => {
      assert.equal(locked, false); locked = true;
      try { return await action({ root, scope: structuredClone(scope), revalidate: async () => { revalidations++; } }); }
      finally { locked = false; }
    };
    const mutation = createSessionRevertMutationAuthority({ withAuthority: authority, admission: gate, stopAndDrain: async () => {
      assert.equal(locked, false); stops++;
      assert.throws(() => gate.enterWriter(root), { code: 'workspace_revert_busy' });
      // A real extension settle needs precisely this otherwise deadlocked lock.
      await authority(null, {}, () => {});
    } });
    let retained;
    await check('Stop runs after lifecycle lock release; callback reacquires and retains lease', async () => {
      const result = await mutation(null, {}, value => { assert.equal(locked, true); retained = value.lease; return 17; });
      assert.equal(result, 17); assert.equal(stops, 1); assert.equal(revalidations, 1);
      assert.throws(() => gate.assertAllowed(root), { code: 'workspace_revert_busy' });
    });
    await check('apply can reuse retained lease with fresh authority', async () => {
      await mutation(null, {}, value => assert.equal(value.lease, retained), { lease: retained });
      retained.release(); gate.assertAllowed(root);
    });
    await check('callback failure always releases lease', async () => {
      await assert.rejects(mutation(null, {}, () => { throw Object.assign(Error('stale_current'), { code: 'stale_current' }); }), { code: 'stale_current' });
      gate.assertAllowed(root);
    });
    await check('lease reuse for another physical root is refused', async () => {
      const lease = gate.acquire(other);
      await assert.rejects(mutation(null, {}, () => assert.fail(), { lease }), { code: 'stale_revert_token' });
      gate.assertAllowed(other);
    });
    await check('Stop failure releases gate before surfacing refusal', async () => {
      const rejected = createSessionRevertMutationAuthority({ withAuthority: authority, admission: gate, stopAndDrain: async () => { throw Object.assign(Error('active_writer'), { code: 'active_writer' }); } });
      await assert.rejects(rejected(null, {}, () => assert.fail()), { code: 'active_writer' }); gate.assertAllowed(root);
    });
    const { createSessionChangeBridge } = await import('../server/session-change-bridge.js');
    const native = '11111111-1111-4111-8111-111111111111', ioId = '22222222-2222-4222-8222-222222222222';
    const operationId = '33333333-3333-4333-8333-333333333333';
    const disk = path.join(root, 'file.txt'); fs.writeFileSync(disk, 'B');
    const records = new Map(); let brokenStore = false;
    const store = { settings: async () => { if (brokenStore) throw Error('broken'); return { enabled: true, exclusions: [] }; },
      gap: async () => {}, captureBefore: async (_scope, record) => records.set(record.operationId, record),
      prepare: async (_scope, record) => records.set(record.operationId, record),
      settle: async (_scope, id, record) => Object.assign(records.get(id), record) };
    const bridge = createSessionChangeBridge({ store: () => { if (brokenStore) throw Error('broken'); return store; },
      admission: gate, inspectFileMetadata: async () => ({ supported: false, reason: 'fixture_unsupported' }),
      launch: { packageDir: () => root }, supported: true, withAuthority: async action => action({ root }),
      resolveScope: async () => ({ ...scope, nativeSessionId: native, conversationId: 'classic-chat', runtimeOwner: { ...scope.runtimeOwner, projectId: 'p', repoId: null } }) });
    try {
      const launch = await bridge.prepare();
      const call = async (endpoint, body = {}) => {
        const response = await fetch(launch.env.PI_GUI_SESSION_CHANGE_URL + endpoint, { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-pi-session-change-token': launch.env.PI_GUI_SESSION_CHANGE_TOKEN },
          body: JSON.stringify({ nativeSessionId: native, ...body }) }); return response.json();
      };
      await check('disabled or broken evidence store still brackets native disk IO', async () => {
        brokenStore = true; assert.equal((await call('/begin-io', { ioId })).ok, true);
        const lease = gate.acquire(root); let drained = false; const waiting = lease.drain().then(() => { drained = true; });
        assert.equal((await call('/begin-io', { ioId: operationId })).ok, false);
        assert.equal(drained, false); assert.equal((await call('/end-io', { ioId })).ok, true);
        await waiting; lease.release(); brokenStore = false;
      });
      const payload = { operationId, parentOperationId: null, toolCallId: 'call', path: disk,
        before: Buffer.from('B').toString('base64'), effectiveToolSource: 'pi-gui-revert' };
      await call('/hello', { version: 1, sources: { write: 'own', edit: 'own' } });
      await check('native metadata capture rejects mismatched before bytes', async () => {
        assert.equal((await call('/before', { ...payload, before: Buffer.from('lie').toString('base64') })).ok, false);
        assert.equal(records.size, 0);
      });
      await check('unsupported native metadata preserves ordinary before capture', async () => {
        assert.equal((await call('/before', payload)).ok, true);
        assert.deepEqual(records.get(operationId).beforeMetadata, { supported: false, reason: 'fixture_unsupported' });
      });
      await check('native after bytes must match independently observed postimage', async () => {
        const outcome = { operationId, observedAfter: Buffer.from('A').toString('base64'), toolOutcome: 'success', mutationOutcome: 'written', evidenceLevel: 'intent_verified' };
        assert.equal((await call('/settle', outcome)).ok, false); fs.writeFileSync(disk, 'A');
        assert.equal((await call('/settle', outcome)).ok, true);
        assert.deepEqual(records.get(operationId).afterMetadata, { supported: false, reason: 'fixture_unsupported' });
      });
      await check('invalidate keeps abandoned IO fail-closed until child cleanup proof', async () => {
        assert.equal((await call('/begin-io', { ioId })).ok, true); await bridge.invalidate();
        const lease = gate.acquire(root); await assert.rejects(lease.drain({ timeout: 5 }), { code: 'active_writer' });
        bridge.confirmWritersStopped(); await lease.drain({ timeout: 5 }); lease.release();
      });
    } finally { await bridge.dispose(); }
    console.log(`Session revert admission: ${checks}/${checks}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
