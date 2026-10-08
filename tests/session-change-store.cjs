const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('  ok ' + name); }
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const scope = (conversationId = 'conversation-A', workspaceEpoch = 'epoch-A') => ({
  runtimeOwner: { backendInstance: 'backend-A', projectId: 'project-A', repoId: 'repo-A',
    workspaceId: 'workspace-A', workspaceEpoch, conversationId, runtimeId: 'runtime-' + conversationId,
    runtimeGeneration: 'generation-A', sessionId: 'native-' + conversationId },
  conversationId, nativeSessionId: 'native-' + conversationId, workspaceId: 'workspace-A', workspaceEpoch,
});
const input = (operationId, extra = {}) => ({ operationId, toolCallId: 'tool-' + operationId,
  path: 'src/example.txt', before: Buffer.from('\ufeffbefore\r\n'), intendedAfter: Buffer.from('\ufeffafter\r\n'),
  effectiveToolSource: 'gui-protected-default', ...extra });
const reject = (fn, code) => assert.rejects(fn, e => e.code === code && e.message === code);
(async () => {
  let createSessionChangeStore;
  try { ({ createSessionChangeStore } = await import('../server/session-change-store.js')); }
  catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
  await check('store factory is available', () => assert.equal(typeof createSessionChangeStore, 'function'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-change-store-'));
  const options = { dataDir: dir, privacyCheck: async () => true };
  try {
    let store = await createSessionChangeStore(options);
    const a = scope();
    await check('consent defaults off and enable requires acknowledgement', async () => {
      assert.equal((await store.settings(a)).enabled, false);
      await reject(() => store.configure(a, { enabled: true, acknowledged: false }), 'evidence_consent_required');
      await store.configure(a, { enabled: true, acknowledged: true, exclusions: ['secrets/'] });
      assert.equal((await store.settings(a)).enabled, true);
      await store.configure(scope('conversation-B'), { enabled: true, acknowledged: true });
    });
    await check('B is durable before A exists', async () => {
      await store.captureBefore(a, input('edit-one'), input('edit-one').before);
      const record = await store.read(a, 'edit-one');
      assert.equal(record.state, 'begun'); assert.deepEqual(record.before, input('edit-one').before);
      assert.equal(record.intendedAfter, null);
    });
    await check('prepare preserves exact BOM and CRLF bytes', async () => {
      await store.prepare(a, input('edit-one'));
      const record = await store.read(a, 'edit-one');
      assert.equal(record.state, 'prepared'); assert.deepEqual(record.intendedAfter, input('edit-one').intendedAfter);
    });
    await check('abort does not erase a verified mutation', async () => {
      await store.settle(a, 'edit-one', { observedAfter: input('edit-one').intendedAfter,
        toolOutcome: 'aborted', mutationOutcome: 'written', evidenceLevel: 'intent_verified' });
      const record = await store.read(a, 'edit-one');
      assert.equal(record.toolOutcome, 'aborted'); assert.equal(record.evidenceLevel, 'intent_verified');
      assert.deepEqual(record.observedAfter, input('edit-one').intendedAfter);
    });
    await check('eligibility waits for the final Pi tool result', async () => {
      let record = await store.read(a, 'edit-one'); assert.equal(record.toolResultObserved, false);
      assert.equal((await store.summary(a)).operations.find(row => row.operationId === 'edit-one').eligible, false);
      await store.amendOutcome(a, 'edit-one', { toolOutcome: 'error' });
      record = await store.read(a, 'edit-one'); assert.equal(record.toolResultObserved, true); assert.equal(record.toolOutcome, 'aborted');
      assert.equal((await store.summary(a)).operations.find(row => row.operationId === 'edit-one').eligible, true);
    });
    await check('sequences are global across workspace conversations', async () => {
      const first = await store.read(a, 'edit-one');
      const second = await store.prepare(scope('conversation-B'), input('write-two', { before: null }));
      assert.ok(second.workspaceSequence > first.workspaceSequence);
      await reject(() => store.read(scope('conversation-B'), 'edit-one'), 'evidence_not_found');
      await reject(() => store.read(scope('conversation-A', 'epoch-B'), 'edit-one'), 'evidence_not_found');
    });
    await check('safe summary contains normalized relative paths but no raw content or digest', async () => {
      const summary = await store.summary(a); const json = JSON.stringify(summary);
      for (const secret of ['\ufeffbefore', '\ufeffafter', hash(input('edit-one').before), dir]) assert.ok(!json.includes(secret));
      assert.ok(json.includes('src/example.txt'));
      assert.ok(summary.revision > 0); assert.equal(summary.operationCount, 1);
    });
    await check('gap revision persists and contaminates the workspace', async () => {
      await store.gap(a, 'unknown_tool');
      const summary = await store.summary(scope('conversation-B'));
      assert.ok(summary.gapRevision > 0);
      store = await createSessionChangeStore(options);
      // Restart can append a newer gap for the other conversation's prepared call.
      assert.ok((await store.summary(a)).gapRevision >= summary.gapRevision);
    });
    await check('unknown writer gap also degrades later verified captures', async () => {
      await store.prepare(a, input('after-gap'));
      await store.settle(a, 'after-gap', { observedAfter: input('after-gap').intendedAfter, toolOutcome: 'success', mutationOutcome: 'written', evidenceLevel: 'intent_verified' });
      const row = (await store.summary(a)).operations.find(row => row.operationId === 'after-gap');
      assert.equal(row.evidenceLevel, 'intent_verified'); assert.equal(row.eligible, false);
    });
    await check('gap between begun and prepared never resets capture provenance', async () => {
      await store.captureBefore(a, input('between-gap'), input('between-gap').before);
      const beforeGap = (await store.read(a, 'between-gap')).attributionGapRevision;
      await store.gap(a, 'unknown_tool'); await store.prepare(a, input('between-gap'));
      assert.equal((await store.read(a, 'between-gap')).attributionGapRevision, beforeGap);
    });
    await check('restart turns uncompleted prepared records incomplete', async () => {
      const record = await store.read(scope('conversation-B'), 'write-two');
      assert.equal(record.state, 'incomplete'); assert.equal(record.evidenceLevel, 'incomplete');
    });
    await check('mismatched P cannot claim verified intent', async () => {
      await store.prepare(a, input('raced'));
      await store.settle(a, 'raced', { observedAfter: Buffer.from('external'), toolOutcome: 'success',
        mutationOutcome: 'written', evidenceLevel: 'intent_verified' });
      assert.equal((await store.read(a, 'raced')).evidenceLevel, 'incomplete');
    });
    await check('inconsistent owner is rejected', async () => {
      await reject(() => store.prepare({ ...a, nativeSessionId: 'other' }, input('bad-owner')), 'invalid_evidence_scope');
    });
    await check('path traversal is rejected without leaking text', async () => {
      await reject(() => store.prepare(a, input('bad-path', { path: '../secret-token.txt' })), 'unsupported_evidence_path');
    });
    await check('exclusions refuse raw capture and path settings cannot escape', async () => {
      await reject(() => store.prepare(a, input('excluded', { path: 'secrets/key.txt' })), 'evidence_path_excluded');
      await reject(() => store.configure(a, { enabled: true, acknowledged: true, exclusions: ['../escape'] }), 'unsupported_evidence_path');
    });
    await check('new runtime owner may read history but cannot settle old operations', async () => {
      await store.prepare(a, input('old-owner'));
      const fresh = { ...a, runtimeOwner: { ...a.runtimeOwner, backendInstance: 'new-backend', runtimeGeneration: 'new-generation' } };
      assert.deepEqual((await store.read(fresh, 'edit-one')).before, input('edit-one').before);
      await reject(() => store.amendOutcome(fresh, 'edit-one', { toolOutcome: 'success' }), 'invalid_evidence_scope');
      await reject(() => store.settle(fresh, 'old-owner', { observedAfter: input('old-owner').intendedAfter, toolOutcome: 'success', mutationOutcome: 'written', evidenceLevel: 'intent_verified' }), 'invalid_evidence_scope');
    });
    await check('dormant summary uses persistent authority without inventing runtime owners', async () => {
      const persistent = { projectId: a.runtimeOwner.projectId, repoId: a.runtimeOwner.repoId, workspaceId: a.workspaceId,
        workspaceEpoch: a.workspaceEpoch, conversationId: a.conversationId, nativeSessionId: a.nativeSessionId, workspaceFingerprint: null };
      const summary = await store.summaryPersistent(persistent);
      assert.equal(summary.operationCount, (await store.summary(a)).operationCount);
      assert.equal(summary.capture.enabled, true); assert.equal(Object.hasOwn(summary, 'runtimeOwner'), false);
      assert.equal((await store.summaryPersistent({ ...persistent, nativeSessionId: 'another-native' })).operationCount, 0);
      assert.equal((await store.summaryPersistent({ ...persistent, workspaceEpoch: 'another-epoch' })).operationCount, 0);
      await reject(() => store.summaryPersistent({ ...persistent, workspaceId: '' }), 'invalid_evidence_scope');
    });
    await check('workspace fingerprint prevents replaced-root evidence reuse', async () => {
      const first = { ...a, workspaceFingerprint: hash(Buffer.from('first-root')) };
      const second = { ...a, workspaceFingerprint: hash(Buffer.from('replacement-root')) };
      await store.configure(first, { enabled: true, acknowledged: true });
      await store.prepare(first, input('root-specific'));
      await reject(() => store.read(second, 'root-specific'), 'evidence_not_found');
      assert.equal((await store.settings(second)).enabled, false);
    });
    await check('unreferenced private objects count against disk quota', async () => {
      const orphanDir = path.join(dir, 'orphan');
      const orphan = await createSessionChangeStore({ ...options, dataDir: orphanDir, budgets: { globalBytes: 4 } });
      await orphan.configure(a, { enabled: true, acknowledged: true });
      const bytes = Buffer.from('1234');
      fs.writeFileSync(path.join(orphanDir, 'revert-evidence', 'v1', 'objects', hash(bytes)), bytes);
      await reject(() => orphan.prepare(a, input('over-disk', { before: null, intendedAfter: Buffer.from('x') })), 'evidence_quota_exceeded');
    });
    await check('truncated journal fails closed on restart', async () => {
      const corruptDir = path.join(dir, 'truncated');
      const corrupt = await createSessionChangeStore({ ...options, dataDir: corruptDir });
      await corrupt.configure(a, { enabled: true, acknowledged: true });
      fs.appendFileSync(path.join(corruptDir, 'revert-evidence', 'v1', 'journal.jsonl'), '{');
      await reject(() => createSessionChangeStore({ ...options, dataDir: corruptDir }), 'evidence_integrity_failed');
    });
    await check('exclusive verification cannot be asserted without a provider', async () => {
      await store.prepare(a, input('fake-exclusive'));
      await store.settle(a, 'fake-exclusive', { observedAfter: input('fake-exclusive').intendedAfter, toolOutcome: 'success', mutationOutcome: 'written', evidenceLevel: 'exclusive_verified' });
      assert.equal((await store.read(a, 'fake-exclusive')).evidenceLevel, 'incomplete');
    });
    await check('classic owner allows the actual null repo identity and nested tool IDs', async () => {
      const classic = { ...scope('classic'), runtimeOwner: { ...scope('classic').runtimeOwner, repoId: null } };
      await store.configure(classic, { enabled: true, acknowledged: true });
      await store.prepare(classic, input('classic-op', { toolCallId: 'parent:child.1' }));
      assert.equal((await store.read(classic, 'classic-op')).toolCallId, 'parent:child.1');
    });
    await check('native platform private directory and inherited child permissions work', async () => {
      const nativeDir = path.join(dir, 'native-private');
      const native = await createSessionChangeStore({ dataDir: nativeDir });
      await native.configure(a, { enabled: true, acknowledged: true });
      await native.prepare(a, input('native-op'));
      assert.deepEqual((await native.read(a, 'native-op')).before, input('native-op').before);
      const reopened = await createSessionChangeStore({ dataDir: nativeDir });
      assert.equal((await reopened.read(a, 'native-op')).state, 'incomplete');
    });
    await check('privacy failure is fail closed', async () => {
      await reject(() => createSessionChangeStore({ dataDir: path.join(dir, 'private-failure'), privacyCheck: async () => false }), 'evidence_privacy_unavailable');
    });
    await check('privacy is rechecked before any raw bytes enter a new blob', async () => {
      const privacyDir = path.join(dir, 'privacy-before-write'); let rejectFiles = false;
      const guarded = await createSessionChangeStore({ dataDir: privacyDir, privacyCheck: async target => {
        if (rejectFiles && /^[0-9a-f]{64}$/.test(path.basename(target))) return false;
        return true;
      } });
      await guarded.configure(a, { enabled: true, acknowledged: true }); rejectFiles = true;
      await reject(() => guarded.prepare(a, input('no-raw-leak')), 'evidence_privacy_unavailable');
      const objectDir = path.join(privacyDir, 'revert-evidence', 'v1', 'objects');
      for (const name of fs.readdirSync(objectDir)) assert.equal(fs.statSync(path.join(objectDir, name)).size, 0);
    });
    await check('insecure objects directory is rejected before creating a blob', async () => {
      const privacyDir = path.join(dir, 'privacy-parent'); let insecure = false;
      const guarded = await createSessionChangeStore({ dataDir: privacyDir, privacyCheck: async target => !(insecure && path.basename(target) === 'objects') });
      await guarded.configure(a, { enabled: true, acknowledged: true }); insecure = true;
      await reject(() => guarded.prepare(a, input('no-inherited-leak')), 'evidence_privacy_unavailable');
      assert.deepEqual(fs.readdirSync(path.join(privacyDir, 'revert-evidence', 'v1', 'objects')), []);
    });
    await check('oversized corrupted object is refused without an unbounded readFile', async () => {
      const corruptDir = path.join(dir, 'oversized-object');
      const guarded = await createSessionChangeStore({ ...options, dataDir: corruptDir });
      await guarded.configure(a, { enabled: true, acknowledged: true }); await guarded.prepare(a, input('oversized-corruption'));
      const object = path.join(corruptDir, 'revert-evidence', 'v1', 'objects', hash(input('oversized-corruption').before));
      fs.truncateSync(object, 2 * 1024 ** 2 + 1);
      const promises = require('node:fs/promises'), original = promises.readFile; let unboundedReads = 0;
      promises.readFile = async function(target, ...args) { if (target === object) unboundedReads++; return original.call(this, target, ...args); };
      try { await reject(() => guarded.read(a, 'oversized-corruption'), 'evidence_integrity_failed'); assert.equal(unboundedReads, 0); }
      finally { promises.readFile = original; }
    });
    await check('lost final tool result becomes incomplete after restart and poisons prior eligibility', async () => {
      const missingDir = path.join(dir, 'missing-final'); let missing = await createSessionChangeStore({ ...options, dataDir: missingDir });
      await missing.configure(a, { enabled: true, acknowledged: true });
      for (const operationId of ['finished', 'lost']) {
        await missing.prepare(a, input(operationId));
        await missing.settle(a, operationId, { observedAfter: input(operationId).intendedAfter, toolOutcome: 'success', mutationOutcome: 'written', evidenceLevel: 'intent_verified' });
      }
      await missing.amendOutcome(a, 'finished', { toolOutcome: 'success' });
      await missing.amendOutcome(a, 'finished', { toolOutcome: 'error' });
      const finalError = await missing.read(a, 'finished');
      assert.equal(finalError.toolOutcome, 'error'); assert.equal(finalError.mutationOutcome, 'written');
      assert.equal(finalError.evidenceLevel, 'intent_verified'); assert.deepEqual(finalError.observedAfter, input('finished').intendedAfter);
      missing = await createSessionChangeStore({ ...options, dataDir: missingDir });
      assert.equal((await missing.read(a, 'lost')).evidenceLevel, 'incomplete');
      assert.equal((await missing.summary(a)).eligibleCount, 0); assert.ok((await missing.summary(a)).gapRevision > 0);
    });
    await check('incomplete post verification poisons earlier workspace operations', async () => {
      const missingDir = path.join(dir, 'post-incomplete'), missing = await createSessionChangeStore({ ...options, dataDir: missingDir });
      await missing.configure(a, { enabled: true, acknowledged: true }); await missing.prepare(a, input('post-missing'));
      await missing.settle(a, 'post-missing', { observedAfter: null, toolOutcome: 'error', mutationOutcome: 'unknown', evidenceLevel: 'incomplete' });
      assert.ok((await missing.summary(a)).gapRevision > 0);
    });
    await check('ENOSPC before prepared journal never admits a protected operation', async () => {
      const fullDir=path.join(dir,'disk-full'), full=await createSessionChangeStore({...options,dataDir:fullDir});
      await full.configure(a,{enabled:true,acknowledged:true});
      const promises=require('node:fs/promises'),original=promises.open;
      promises.open=async function(target,...args){if(target===path.join(fullDir,'revert-evidence','v1','journal.jsonl'))throw Object.assign(Error('fixture disk full'),{code:'ENOSPC'});return original.call(this,target,...args);};
      try{await reject(()=>full.prepare(a,input('disk-full')),'evidence_storage_failed');assert.equal((await full.summary(a)).operationCount,0);}
      finally{promises.open=original;}
    });
    await check('separate process exit after prepared recovers incomplete evidence', async () => {
      const crashDir=path.join(dir,'process-crash'),entry=require('node:url').pathToFileURL(path.resolve(__dirname,'../server/session-change-store.js')).href;
      const script=`import {createSessionChangeStore} from ${JSON.stringify(entry)}; const s=JSON.parse(process.env.P33_SCOPE); const store=await createSessionChangeStore({dataDir:process.env.P33_DATA,privacyCheck:async()=>true}); await store.configure(s,{enabled:true,acknowledged:true});await store.prepare(s,{operationId:'crash',toolCallId:'crash-call',parentOperationId:null,path:'file.txt',before:Buffer.from('B'),intendedAfter:Buffer.from('A'),effectiveToolSource:'pi-gui-revert'});process.exit(86);`;
      try{require('node:child_process').execFileSync(process.execPath,['--input-type=module','-e',script],{windowsHide:true,stdio:'pipe',env:{...process.env,P33_SCOPE:JSON.stringify(a),P33_DATA:crashDir}});assert.fail('fixture must exit at prepared');}
      catch(e){assert.equal(e.status,86);}
      const recovered=await createSessionChangeStore({...options,dataDir:crashDir}),item=await recovered.read(a,'crash');
      assert.equal(item.evidenceLevel,'incomplete');assert.deepEqual(item.before,Buffer.from('B'));assert.deepEqual(item.intendedAfter,Buffer.from('A'));assert.equal(item.observedAfter,null);assert.equal((await recovered.summary(a)).eligibleCount,0);
    });
    await check('100-operation replay validates each deduplicated object once', async () => {
      const replayDir = path.join(dir, 'replay-100'); let objectChecks = 0;
      const replayOptions = { dataDir: replayDir, privacyCheck: async target => { if (/^[0-9a-f]{64}$/.test(path.basename(target))) objectChecks++; return true; } };
      let replay = await createSessionChangeStore(replayOptions); await replay.configure(a, { enabled: true, acknowledged: true });
      for (let n = 0; n < 100; n++) {
        const args = input('repeat-' + n); await replay.prepare(a, args);
        await replay.settle(a, args.operationId, { observedAfter: args.intendedAfter, toolOutcome: 'success', mutationOutcome: 'written', evidenceLevel: 'intent_verified' });
        await replay.amendOutcome(a, args.operationId, { toolOutcome: 'success' });
      }
      objectChecks = 0; const started = Date.now(); replay = await createSessionChangeStore(replayOptions);
      assert.equal((await replay.summary(a)).operationCount, 100); assert.equal(objectChecks, 2);
      console.log('  fixture replay 100 operations:', Date.now() - started, 'ms; object privacy checks:', objectChecks);
    });
    await check('file quota refuses before recording a complete operation', async () => {
      const tiny = await createSessionChangeStore({ ...options, dataDir: path.join(dir, 'tiny'), budgets: { fileBytes: 3 } });
      await tiny.configure(a, { enabled: true, acknowledged: true });
      await reject(() => tiny.prepare(a, input('large')), 'evidence_quota_exceeded');
      assert.equal((await tiny.summary(a)).operationCount, 0);
    });
    await check('CAS deduplicates matching raw bytes and corruption fails closed', async () => {
      const root = path.join(dir, 'revert-evidence', 'v1', 'objects');
      const files = fs.readdirSync(root); const digest = hash(input('edit-one').before);
      assert.equal(files.filter(name => name === digest).length, 1);
      fs.writeFileSync(path.join(root, digest), 'corrupt');
      await reject(() => store.read(a, 'edit-one'), 'evidence_integrity_failed');
      await reject(() => store.prepare(a, input('after-corruption')), 'evidence_integrity_failed');
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`session-change-store: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
