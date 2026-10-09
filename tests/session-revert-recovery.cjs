const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const scope = { projectId: 'p', repoId: null, workspaceId: 'w', workspaceEpoch: 'e', conversationId: 'c', nativeSessionId: 's', workspaceFingerprint: null };
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log('  ok ' + name); };
const rejects = (fn, code) => assert.rejects(fn, e => e.code === code);
(async () => {
  const { createSessionChangeStore } = await import('../server/session-change-store.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p334-recovery-'));
  const options = { dataDir: dir, privacyCheck: async () => true };
  try {
    let store = await createSessionChangeStore(options);
    let currentRef, restoreRef;
    await check('backup exact bytes and null absence remain private and durable', async () => {
      currentRef = await store.restorePut(scope, Buffer.from('\ufeffC\r\n'));
      restoreRef = await store.restorePut(scope, Buffer.from('R\n'));
      assert.deepEqual(await store.restoreRead(scope, currentRef), Buffer.from('\ufeffC\r\n'));
      assert.equal(await store.restorePut(scope, null), null);
    });
    const plan = { planId: 'plan1', requestId: 'req1', selectedOperationIds: [], tokenHash: 'a'.repeat(64), expiresAt: Date.now() + 60000, paths: [{ path: 'a.txt', currentRef, restoreRef }], riskNoticeVersion: 1 };
    await check('plan persistence binds request and rejects rebinding', async () => {
      assert.equal((await store.applyCreate(scope, plan)).state, 'prepared');
      assert.equal((await store.applyCreate(scope, plan)).planId, 'plan1');
      await rejects(() => store.applyCreate(scope, { ...plan, planId: 'plan2' }), 'invalid_evidence_operation');
      await rejects(() => store.applyCreate(scope, { ...plan, riskNoticeVersion: 2 }), 'invalid_evidence_operation');
      await rejects(() => store.restoreRead({ ...scope, conversationId: 'other' }, currentRef), 'evidence_not_found');
    });
    await check('restart marks uncertain intent recovery required without consuming', async () => {
      await store.applyUpdate(scope, 'plan1', { state: 'replacing' });
      store = await createSessionChangeStore(options);
      assert.equal((await store.applyGet(scope, 'plan1')).state, 'recovery_required');
      assert.equal((await store.applyList(scope)).length, 1);
      assert.deepEqual(await store.restoreRead(scope, currentRef), Buffer.from('\ufeffC\r\n'));
      await rejects(() => store.applyUpdate(scope, 'plan1', { state: 'replacing' }), 'invalid_evidence_operation');
    });
    await check('immutable token and scope cannot change', async () => {
      await rejects(() => store.applyUpdate(scope, 'plan1', { tokenHash: 'b'.repeat(64) }), 'invalid_evidence_operation');
      await rejects(() => store.applyUpdate(scope, 'plan1', { scope: { ...scope, conversationId: 'other' } }), 'invalid_evidence_operation');
      await rejects(() => store.applyCreate(scope, { ...plan, planId: 'bad', requestId: 'bad', token: 'secret' }), 'invalid_evidence_operation');
    });
    const ownerScope = { ...scope, runtimeOwner: { backendInstance: 'b', projectId: 'p', repoId: null, workspaceId: 'w', workspaceEpoch: 'e', conversationId: 'c', runtimeId: 'r', runtimeGeneration: 'g', sessionId: 's' } };
    const args = { operationId: 'op1', toolCallId: 't1', path: 'a.txt', effectiveToolSource: 'gui-protected-default', before: Buffer.from('B'), intendedAfter: Buffer.from('A') };
    const meta = { supported: true, profile: 'fixture', version: 1, attributes: 32, acl: 'private' };
    await check('captured metadata is bounded JSON and old unknown metadata stays null', async () => {
      await store.configure(ownerScope, { enabled: true, acknowledged: true });
      await store.prepare(ownerScope, { ...args, beforeMetadata: meta });
      await store.settle(ownerScope, 'op1', { observedAfter: Buffer.from('A'), afterMetadata: meta, toolOutcome: 'success', mutationOutcome: 'written', evidenceLevel: 'intent_verified' });
      await store.amendOutcome(ownerScope, 'op1', { toolOutcome: 'success' });
      const record = await store.read(ownerScope, 'op1');
      assert.deepEqual(record.beforeMetadata, meta); assert.deepEqual(record.afterMetadata, meta);
      await rejects(() => store.prepare(ownerScope, { ...args, operationId: 'badMeta', beforeMetadata: { callback() {} } }), 'invalid_evidence_operation');
      await store.prepare(ownerScope, { ...args, operationId: 'legacy' });
      assert.equal((await store.read(ownerScope, 'legacy')).beforeMetadata, null);
    });
    await check('verified writes consume only their own operations and survive restart', async () => {
      const files = [{ fileId: 'f1', relativePath: 'a.txt', operationIds: ['op1'], currentRef, candidateRef: restoreRef, state: 'prepared' }];
      const { paths, ...basePlan } = plan;
      await store.applyCreate(scope, { ...basePlan, planId: 'verified', requestId: null, selectedOperationIds: ['op1'], files });
      await store.applyUpdate(scope, 'verified', { requestId: 'apply-verified', state: 'replacing', files: files.map(f => ({ ...f, state: 'replacing' })) });
      assert.equal((await store.summary(ownerScope)).operations.find(x => x.operationId === 'op1').consumed, false);
      await rejects(() => store.applyUpdate(scope, 'verified', { state: 'applied_verified', files: files.map(f => ({ ...f, state: 'applied_verified', observedPostDigest: '0'.repeat(64) })) }), 'invalid_evidence_operation');
      await store.applyUpdate(scope, 'verified', { state: 'applied_verified', files: files.map(f => ({ ...f, state: 'applied_verified', observedPostDigest: restoreRef.digest })) });
      assert.equal((await store.summary(ownerScope)).operations.find(x => x.operationId === 'op1').consumed, true);
      await rejects(() => store.applyCreate(scope, { ...plan, planId: 'again', requestId: 'again', selectedOperationIds: ['op1'] }), 'invalid_evidence_operation');
      store = await createSessionChangeStore(options);
      assert.equal((await store.applyGet(scope, 'verified')).state, 'applied_verified');
      assert.equal((await store.summary(ownerScope)).operations.find(x => x.operationId === 'op1').eligible, false);
    });
    await check('GC removes only never journal referenced blobs and retains recovery pins', async () => {
      const orphanName = 'f'.repeat(64), objects = path.join(dir, 'revert-evidence', 'v1', 'objects');
      await fs.writeFile(path.join(objects, orphanName), 'orphan', { mode: 0o600 });
      assert.deepEqual(await store.collectGarbage(), { removed: 1, bytes: 6 });
      assert.deepEqual(await store.restoreRead(scope, currentRef), Buffer.from('\ufeffC\r\n'));
      assert.equal((await store.applyGet(scope, 'plan1')).state, 'recovery_required');
    });
    await check('quota is checked before unjournaled backup creation', async () => {
      const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'p334-quota-'));
      try {
        const limited = await createSessionChangeStore({ dataDir: isolated, privacyCheck: async () => true, budgets: { conversationBytes: 3 } });
        await limited.restorePut(scope, Buffer.from('abc'));
        await rejects(() => limited.restorePut(scope, Buffer.from('d')), 'evidence_quota_exceeded');
        assert.equal((await fs.readdir(path.join(isolated, 'revert-evidence', 'v1', 'objects'))).length, 1);
      } finally { await fs.rm(isolated, { recursive: true, force: true }); }
    });
    await check('changed pinned blob and truncated apply journal fail closed on reopen', async () => {
      const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'p334-corrupt-'));
      try {
        const damaged = await createSessionChangeStore({ dataDir: isolated, privacyCheck: async () => true });
        const reference = await damaged.restorePut(scope, Buffer.from('C'));
        const object = path.join(isolated, 'revert-evidence', 'v1', 'objects', reference.digest);
        await fs.writeFile(object, 'X');
        await rejects(() => createSessionChangeStore({ dataDir: isolated, privacyCheck: async () => true }), 'evidence_integrity_failed');
        await fs.writeFile(object, 'C');
        const journal = path.join(isolated, 'revert-evidence', 'v1', 'journal.jsonl');
        await fs.truncate(journal, (await fs.stat(journal)).size - 1);
        await rejects(() => createSessionChangeStore({ dataDir: isolated, privacyCheck: async () => true }), 'evidence_integrity_failed');
      } finally { await fs.rm(isolated, { recursive: true, force: true }); }
    });
    await check('separate process exit after moving intent requires recovery without retry', async () => {
      const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'p334-process-exit-'));
      try {
        const moduleUrl = pathToFileURL(path.resolve(__dirname, '../server/session-change-store.js')).href;
        const script = `import {createSessionChangeStore} from ${JSON.stringify(moduleUrl)};
          const scope=${JSON.stringify(scope)};
          const store=await createSessionChangeStore({dataDir:process.argv[1],privacyCheck:async()=>true});
          const reference=await store.restorePut(scope,Buffer.from('private-backup'));
          await store.applyCreate(scope,{planId:'exited',requestId:null,tokenHash:'a'.repeat(64),expiresAt:Date.now()+60000,selectedOperationIds:[],files:[{fileId:'f',relativePath:'a.txt',currentRef:reference,candidateRef:null,state:'prepared'}]});
          await store.applyUpdate(scope,'exited',{state:'moving',requestId:'request'});process.exit(0);`;
        await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, isolated], { windowsHide: true });
        const reopened = await createSessionChangeStore({ dataDir: isolated, privacyCheck: async () => true });
        const plan = await reopened.applyGet(scope, 'exited');
        assert.equal(plan.state, 'recovery_required'); assert.equal(plan.files[0].state, 'prepared');
        assert.deepEqual(await reopened.restoreRead(scope, plan.files[0].currentRef), Buffer.from('private-backup'));
      } finally { await fs.rm(isolated, { recursive: true, force: true }); }
    });
    await check('privacy drift prevents backup reads and writes', async () => {
      let privateRoot = true;
      const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'p334-private-'));
      try {
        const guarded = await createSessionChangeStore({ dataDir: isolated, privacyCheck: async () => privateRoot });
        const ref = await guarded.restorePut(scope, Buffer.from('x'));
        privateRoot = false;
        await rejects(() => guarded.restoreRead(scope, ref), 'evidence_privacy_unavailable');
        await rejects(() => guarded.restorePut(scope, Buffer.from('y')), 'evidence_privacy_unavailable');
      } finally { await fs.rm(isolated, { recursive: true, force: true }); }
    });
    console.log(`session-revert-recovery: ${checks}/${checks}`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
