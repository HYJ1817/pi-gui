const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('  ok ' + name); }
const reject = (fn, code) => assert.rejects(fn, e => e.code === code && e.message === code);
const scope = (conversationId = 'A', extra = {}) => ({ runtimeOwner: { backendInstance: 'backend', projectId: 'project', repoId: 'repo', workspaceId: 'workspace', workspaceEpoch: 'epoch', conversationId, runtimeId: 'runtime-' + conversationId, runtimeGeneration: 'generation', sessionId: 'native-' + conversationId }, conversationId, nativeSessionId: 'native-' + conversationId, workspaceId: 'workspace', workspaceEpoch: 'epoch', ...extra });
const persistent = s => ({ projectId: s.runtimeOwner.projectId, repoId: s.runtimeOwner.repoId, workspaceId: s.workspaceId, workspaceEpoch: s.workspaceEpoch, conversationId: s.conversationId, nativeSessionId: s.nativeSessionId, workspaceFingerprint: s.workspaceFingerprint ?? null });
const args = (operationId, target = 'file.txt', bytes = Buffer.from('before')) => ({ operationId, toolCallId: 'call-' + operationId, path: target, before: bytes, intendedAfter: Buffer.from('after'), effectiveToolSource: 'pi-gui-revert' });
(async () => {
  const { createSessionChangeStore } = await import('../server/session-change-store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-revert-store-'));
  const options = { dataDir: dir, privacyCheck: async () => true };
  try {
    const store = await createSessionChangeStore(options), a = scope(), b = scope('B');
    await store.configure(a, { enabled: true, acknowledged: true });
    await store.configure(b, { enabled: true, acknowledged: true });
    await store.prepare(a, args('a-first'));
    await store.prepare(b, args('b-middle'));
    await store.prepare(b, args('b-other', 'unrelated.txt'));
    await store.prepare(a, args('a-last'));
    await store.settle(a, 'a-first', { observedAfter: Buffer.from('after'), toolOutcome: 'success', mutationOutcome: 'written', evidenceLevel: 'intent_verified' });
    await store.amendOutcome(a, 'a-first', { toolOutcome: 'success' });
    await check('snapshot includes ordered same-file interleaving with exact raw bytes', async () => {
      const result = await store.previewSnapshot(a, { evidenceIds: ['a-last', 'a-first'] });
      assert.deepEqual(result.records.map(r => r.operationId), ['a-first', 'b-middle', 'a-last']);
      assert.deepEqual(result.selectedOperationIds, ['a-last', 'a-first']);
      assert.deepEqual(result.records[0].before, Buffer.from('before'));
      assert.deepEqual(result.records[0].intendedAfter, Buffer.from('after'));
      assert.deepEqual(result.records[0].observedAfter, Buffer.from('after'));
      assert.equal(result.records[1].observedAfter, null);
      assert.equal(result.retentionDays, 7);
      assert.deepEqual({ revision: result.revision, gapRevision: result.gapRevision }, await store.previewRevision(a));
    });
    await check('selected operation IDs cannot target another session', async () => {
      await reject(() => store.previewSnapshot(a, { evidenceIds: ['b-middle'] }), 'evidence_not_found');
      await reject(() => store.previewSnapshot(a, { evidenceIds: ['a-first', 'b-middle'] }), 'evidence_not_found');
    });
    await check('persistent scope reads dormant history without a synthetic owner', async () => {
      assert.equal((await store.previewSnapshot(persistent(a), { evidenceIds: ['a-first'] })).records.length, 3);
      await reject(() => store.previewSnapshot({ ...persistent(a), runtimeOwner: null }, { evidenceIds: ['a-first'] }), 'invalid_evidence_scope');
      await reject(() => store.previewSnapshot({ ...a, nativeSessionId: 'wrong' }, { evidenceIds: ['a-first'] }), 'invalid_evidence_scope');
    });
    await check('epoch fingerprint native conversation project and repo isolate selection', async () => {
      for (const change of [{ workspaceEpoch: 'other' }, { workspaceFingerprint: 'f'.repeat(64) }, { nativeSessionId: 'other' }, { conversationId: 'other' }, { projectId: 'other' }, { repoId: 'other' }]) {
        await reject(() => store.previewSnapshot({ ...persistent(a), ...change }, { evidenceIds: ['a-first'] }), 'evidence_not_found');
      }
    });
    await check('same relative path in other workspace generations is not disclosed', async () => {
      for (const foreign of [scope('C', { workspaceFingerprint: 'f'.repeat(64) }), { ...scope('D'), workspaceEpoch: 'epoch-other', runtimeOwner: { ...scope('D').runtimeOwner, workspaceEpoch: 'epoch-other' } }]) {
        await store.configure(foreign, { enabled: true, acknowledged: true }); await store.prepare(foreign, args('foreign'));
      }
      assert.deepEqual((await store.previewSnapshot(a, { evidenceIds: ['a-first'] })).records.map(r => r.operationId), ['a-first', 'b-middle', 'a-last']);
    });
    await check('snapshot and revision queue atomically around concurrent writes', async () => {
      const first = store.previewSnapshot(a, { evidenceIds: ['a-first'] });
      const write = store.gap(b, 'unknown_tool');
      const last = store.previewRevision(a);
      const [snapshot, gap, revision] = await Promise.all([first, write, last]);
      assert.equal(revision.revision, snapshot.revision + 1);
      assert.equal(revision.gapRevision, gap.gapRevision);
      assert.ok(snapshot.gapRevision < revision.gapRevision);
    });
    await check('preview changes no journal bytes or captured records', async () => {
      const journal = path.join(dir, 'revert-evidence/v1/journal.jsonl'), before = fs.readFileSync(journal);
      const snapshot = await store.previewSnapshot(a, { evidenceIds: ['a-first'] });
      snapshot.records[0].before.fill(0); snapshot.records[0].scope.runtimeOwner.projectId = 'changed';
      assert.deepEqual((await store.read(a, 'a-first')).before, Buffer.from('before'));
      assert.deepEqual(fs.readFileSync(journal), before);
    });
    await check('requested operation limit is enforced and cannot exceed hard cap', async () => {
      assert.equal((await store.previewSnapshot(a, { evidenceIds: ['a-first'], maxOperations: 3 })).records.length, 3);
      for (const maxOperations of [2, 129, 0, -1, 1.5]) await reject(() => store.previewSnapshot(a, { evidenceIds: ['a-first'], maxOperations }), 'evidence_quota_exceeded');
      await reject(() => store.previewSnapshot(a, { evidenceIds: Array(129).fill('a-first') }), 'evidence_quota_exceeded');
    });
    await check('32-file snapshot limit includes all selected paths', async () => {
      const ids = [];
      for (let n = 0; n < 33; n++) { ids.push('file-' + n); await store.prepare(a, args(ids.at(-1), 'paths/' + n)); }
      assert.equal((await store.previewSnapshot(a, { evidenceIds: ids.slice(0, 32) })).records.length, 32);
      await reject(() => store.previewSnapshot(a, { evidenceIds: ids }), 'evidence_quota_exceeded');
    });
    await check('128-operation cap includes interleaved operations', async () => {
      for (let n = 0; n < 126; n++) await store.prepare(b, args('many-' + n));
      await reject(() => store.previewSnapshot(a, { evidenceIds: ['a-first'] }), 'evidence_quota_exceeded');
    });
    await check('raw byte budget conservatively counts duplicate references before reads', async () => {
      const large = await createSessionChangeStore({ ...options, dataDir: path.join(dir, 'large') });
      await large.configure(a, { enabled: true, acknowledged: true });
      const bytes = Buffer.alloc(2 * 1024 ** 2, 65), ids = [];
      for (let n = 0; n < 33; n++) { ids.push('large-' + n); await large.prepare(a, { ...args(ids.at(-1), 'large.txt', bytes), intendedAfter: bytes }); }
      await reject(() => large.previewSnapshot(a, { evidenceIds: [ids[0]] }), 'evidence_quota_exceeded');
    });
    for (const mode of ['missing', 'corrupt', 'privacy']) await check(mode + ' object fails closed with fixed integrity error', async () => {
      const dataDir = path.join(dir, mode); let privateObjects = true;
      const guarded = await createSessionChangeStore({ dataDir, privacyCheck: async target => privateObjects || !/^[0-9a-f]{64}$/.test(path.basename(target)) });
      await guarded.configure(a, { enabled: true, acknowledged: true }); await guarded.prepare(a, args('guarded'));
      const hash = crypto.createHash('sha256').update('before').digest('hex'), object = path.join(dataDir, 'revert-evidence/v1/objects', hash);
      if (mode === 'missing') fs.unlinkSync(object); else if (mode === 'corrupt') fs.writeFileSync(object, 'broken'); else privateObjects = false;
      await reject(() => guarded.previewSnapshot(a, { evidenceIds: ['guarded'] }), 'evidence_integrity_failed');
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`session-revert-store: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
