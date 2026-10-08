const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http');
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log('  ok  ' + name); };
(async () => {
  let createSessionRevertRoutes;
  try { ({ createSessionRevertRoutes } = await import('../server/session-revert-routes.js')); }
  catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
  await check('preview route factory exists', () => assert.equal(typeof createSessionRevertRoutes, 'function'));
  const { createRouter } = await import('../server/router.js');
  const { createAuth } = await import('../server/auth.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p33-http-'));
  const scope = { projectId: 'project', repoId: null, workspaceId: 'workspace', workspaceEpoch: 'epoch', conversationId: 'conversation', nativeSessionId: 'native' };
  const original = { operationId: 'op-1', path: 'file.txt', workspaceSequence: 1, createdAt: Date.now(), state: 'observed', evidenceLevel: 'intent_verified', toolResultObserved: true, mutationOutcome: 'written', toolOutcome: 'success', attributionGapRevision: 0,
    scope, before: Buffer.from('before\n'), intendedAfter: Buffer.from('after\n'), observedAfter: Buffer.from('after\n') };
  let snapshot, writer, denied, changed, throwStore, revalidated, snapshotCalls, limits, revalidateHook, backingStore;
  const reset = async () => {
    snapshot = { revision: 1, gapRevision: 0, retentionDays: 7, selectedOperationIds: ['op-1'], records: [{ ...original }] };
    writer = false; denied = false; changed = false; throwStore = null; revalidated = 0; snapshotCalls = 0; limits = {}; revalidateHook = null; backingStore = null;
    await fs.rm(path.join(root, 'file.txt'), { force: true, recursive: true });
    await fs.writeFile(path.join(root, 'file.txt'), 'after\n');
  };
  const store = { previewSnapshot: async (...args) => { snapshotCalls++; if (throwStore) throw throwStore; return backingStore ? backingStore.previewSnapshot(...args) : snapshot; }, previewRevision: async (...args) => backingStore ? backingStore.previewRevision(...args) : ({ revision: changed ? 2 : snapshot.revision, gapRevision: snapshot.gapRevision }) };
  const authority = async (_req, body, fn) => {
    if (denied || (body.conversationId && body.conversationId !== scope.conversationId) || (body.owner && body.owner.runtimeGeneration !== 'current')) throw Object.assign(Error('private payload'), { code: 'stale_runtime' });
    return fn({ scope, root, activeWriter: writer, revalidate: async () => { revalidated++; if (revalidateHook) await revalidateHook(); if (denied) throw Object.assign(Error('private'), { code: 'stale_runtime' }); } });
  };
  let server, base;
  server = http.createServer((req, res) => {
    const routes = createSessionRevertRoutes({ store: async () => store, withAuthority: authority, budgets: limits });
    createRouter({ auth: createAuth({ token: 'fixture-token', port: server.address().port }), sessionRevert: routes })(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  const request = async (body = {}, options = {}) => {
    const response = await fetch(base + (options.url || '/api/session-revert/preview'), { method: options.method || 'POST', headers: { 'content-type': 'application/json', 'x-pi-gui-token': 'fixture-token', ...options.headers }, body: options.method === 'GET' ? undefined : options.raw ?? JSON.stringify({ evidenceIds: ['op-1'], mode: 'confirmed_limited', ...body }) });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = { text }; } return { status: response.status, ...data };
  };
  try {
    await reset();
    await check('missing token is rejected before evidence read', async () => { assert.equal((await request({}, { headers: { 'x-pi-gui-token': '' } })).status, 401); assert.equal(snapshotCalls, 0); });
    await check('foreign Origin rejects valid token', async () => { assert.equal((await request({}, { headers: { origin: 'https://foreign.invalid' } })).status, 403); assert.equal(snapshotCalls, 0); });
    await check('same Origin is accepted', async () => assert.equal((await request({}, { headers: { origin: base } })).ok, true));
    await check('GET cannot preview', async () => assert.equal((await request({}, { method: 'GET' })).status, 405));
    await check('raw endpoint is unavailable', async () => assert.equal((await request({}, { url: '/api/session-revert/raw' })).status, 404));
    await check('apply endpoint is unavailable', async () => assert.equal((await request({}, { url: '/api/session-revert/apply' })).status, 404));
    for (const key of ['path', 'root', 'nativeSessionId', 'scope', 'before', 'indexRef', 'readonly'])
      await check('closed schema rejects ' + key, async () => assert.equal((await request({ [key]: 'private' })).status, 400));
    await check('malformed JSON is fixed refusal', async () => assert.equal((await request({}, { raw: '{' })).code, 'invalid_request'));
    await check('oversized body is bounded', async () => assert.equal((await request({}, { raw: 'x'.repeat(17000) })).status, 413));
    await check('empty selected ids refused', async () => assert.equal((await request({ evidenceIds: [] })).status, 400));
    await check('invalid selected ids refused', async () => assert.equal((await request({ evidenceIds: ['../secret'] })).status, 400));
    await check('duplicate selected ids refused', async () => assert.equal((await request({ evidenceIds: ['op-1', 'op-1'] })).status, 400));
    await check('unknown mode refused', async () => assert.equal((await request({ mode: 'force' })).status, 400));
    await check('diff requires boolean', async () => assert.equal((await request({ includeDiff: 'yes' })).status, 400));
    await check('revision requires integer', async () => assert.equal((await request({ evidenceRevision: -1 })).status, 400));
    await check('wrong dormant conversation refused', async () => assert.equal((await request({ conversationId: 'foreign' })).status, 409));
    await check('stale owner refused', async () => assert.equal((await request({ owner: { runtimeGeneration: 'old' } })).status, 409));
    await check('active writer refuses before read', async () => { writer = true; const previous = snapshotCalls; assert.equal((await request()).code, 'active_writer'); assert.equal(snapshotCalls, previous); writer = false; });
    await check('strict is unavailable independently of content candidate', async () => { const r = await request({ mode: 'strict' }); assert.equal(r.files[0].contentEligible, true); assert.equal(r.strict.reason, 'exclusive_provider_unavailable'); assert.equal(r.strict.applyEligible, false); });
    await check('limited candidate requires metadata and backups', async () => { const r = await request(); assert.equal(r.limited.contentEligible, true); assert.equal(r.limited.reason, 'metadata_unsupported'); assert.equal(r.backupReady, false); assert.equal(r.limited.applyEligible, false); assert.deepEqual(r.limited.requires, ['metadata_validation', 'prepare_backup', 'confirmation', 'bounded_writer']); });
    await check('candidate change summary reports exact byte counts without content', async () => { const r = await request(); assert.deepEqual(r.files[0].changeSummary, { currentBytes: 6, candidateBytes: 7, selectedOperationCount: 1, action: 'replace' }); });
    await check('summary contains no raw bytes digest or absolute root', async () => { const r = await request(); const raw = JSON.stringify(r); for (const secret of ['before\n', 'after\n', root, 'fixture-token', 'beforeRef', 'digest', 'nativeSessionId']) assert.ok(!raw.includes(secret)); assert.ok(!Object.hasOwn(r.files[0], 'diff')); assert.equal(r.target.conversationId, 'conversation'); });
    await check('explicit C to R diff is deterministic and bounded', async () => { const a = await request({ includeDiff: true }), b = await request({ includeDiff: true }); assert.deepEqual(a, b); assert.match(a.files[0].diff, /-after/); assert.match(a.files[0].diff, /\+before/); assert.ok(Buffer.byteLength(a.files[0].diff) <= 32768); });
    await check('current bytes never change during preview', async () => { await request({ includeDiff: true }); assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'after\n'); });
    await check('authority is revalidated after candidate calculation', async () => { const n = revalidated; await request(); assert.ok(revalidated > n); });
    await check('authority is revalidated after final file reads', async () => { revalidated = 0; await request(); assert.equal(revalidated, 2); });
    await check('current change at revalidation invalidates candidate and preserves external bytes', async () => { revalidateHook = async () => { await fs.writeFile(path.join(root, 'file.txt'), 'external\n'); }; const r = await request(); assert.equal(r.code, 'stale_current'); assert.equal(r.needsRepreview, true); assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'external\n'); await reset(); });
    await check('owner invalidated after final reads refuses preview', async () => { revalidated = 0; revalidateHook = async () => { if (revalidated === 2) denied = true; }; assert.equal((await request()).code, 'stale_runtime'); await reset(); });
    await check('client stale revision requires repreview', async () => { const r = await request({ evidenceRevision: 0 }); assert.equal(r.code, 'stale_evidence'); assert.equal(r.needsRepreview, true); });
    await check('changed evidence revision invalidates candidate', async () => { changed = true; assert.equal((await request()).code, 'stale_evidence'); changed = false; });
    await check('gap prevents candidate', async () => { snapshot.gapRevision = 1; assert.equal((await request()).files[0].contentEligible, false); snapshot.gapRevision = 0; });
    await check('unsupported evidence is a file refusal rather than service error', async () => { snapshot.records[0].evidenceLevel = 'unsupported'; const r = await request(); assert.equal(r.ok, true); assert.equal(r.files[0].contentEligible, false); await reset(); });
    await check('already reverted preview has empty diff and unchanged byte summary', async () => { await fs.writeFile(path.join(root, 'file.txt'), original.before); const r = await request({ includeDiff: true }); assert.equal(r.files[0].status, 'already_reverted'); assert.equal(r.files[0].diff, ''); assert.deepEqual(r.files[0].changeSummary, { currentBytes: 7, candidateBytes: 7, selectedOperationCount: 1, action: 'none' }); await reset(); });
    await check('creation removal summary has absent candidate bytes', async () => { snapshot.records[0].before = null; const r = await request(); assert.deepEqual(r.files[0].changeSummary, { currentBytes: 6, candidateBytes: null, selectedOperationCount: 1, action: 'move_to_recovery' }); await reset(); });
    await check('refused preview omits candidate change summary', async () => { snapshot.gapRevision = 1; assert.equal(Object.hasOwn((await request()).files[0], 'changeSummary'), false); await reset(); });
    await check('missing current file is a read-only refusal', async () => { await fs.rm(path.join(root, 'file.txt')); assert.equal((await request()).files[0].reason, 'current_missing'); await reset(); });
    await check('binary current refuses content eligibility', async () => { await fs.writeFile(path.join(root, 'file.txt'), Buffer.from([0, 255])); assert.equal((await request()).files[0].reason, 'unsupported_text'); await reset(); });
    await check('lower raw snapshot budget refuses without exposing bytes', async () => { limits = { rawBytes: 1 }; assert.equal((await request()).code, 'budget_exceeded'); limits = {}; });
    await check('missing selected evidence is refused', async () => { throwStore = Object.assign(Error('raw secret'), { code: 'evidence_not_found' }); const r = await request(); assert.equal(r.code, 'evidence_not_found'); assert.ok(!JSON.stringify(r).includes('raw secret')); throwStore = null; });
    await check('corrupt evidence is fixed refusal', async () => { throwStore = Object.assign(Error(root), { code: 'evidence_integrity_failed' }); assert.equal((await request()).code, 'evidence_integrity_failed'); throwStore = null; });
    await check('unrecognized store failure is redacted', async () => { throwStore = Error('secret payload'); assert.equal((await request()).code, 'preview_unavailable'); throwStore = null; });
    await check('server evidence traversal path is refused', async () => { snapshot.records[0].path = '../secret'; assert.equal((await request()).files[0].reason, 'unsupported_path'); snapshot.records[0].path = 'file.txt'; });
    await check('sensitive server evidence path is refused', async () => { snapshot.records[0].path = '.env'; assert.equal((await request()).files[0].reason, 'unsupported_path'); snapshot.records[0].path = 'file.txt'; });
    await check('directory target is refused', async () => { await fs.rm(path.join(root, 'file.txt')); await fs.mkdir(path.join(root, 'file.txt')); assert.equal((await request()).files[0].reason, 'unsupported_path'); await reset(); });
    await check('hardlink target is refused', async () => { const other = path.join(root, 'other.txt'); await fs.link(path.join(root, 'file.txt'), other); assert.equal((await request()).files[0].reason, 'unsupported_path'); await fs.rm(other); });
    await check('junction ancestor is refused', async () => { const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'p33-outside-')); try { await fs.writeFile(path.join(outside, 'file.txt'), 'after\n'); await fs.symlink(outside, path.join(root, 'link'), 'junction'); snapshot.records[0].path = 'link/file.txt'; assert.equal((await request()).files[0].reason, 'unsupported_path'); } finally { snapshot.records[0].path = 'file.txt'; await fs.rm(path.join(root, 'link'), { force: true }); await fs.rm(outside, { recursive: true, force: true }); } });
    await check('current file size is bounded before allocation with oversized reason', async () => { await fs.writeFile(path.join(root, 'file.txt'), Buffer.alloc(2 * 1024 ** 2 + 1)); assert.equal((await request()).files[0].reason, 'oversized'); await reset(); });
    await check('worker computation budget has a distinct diff reason', async () => { limits = { computeMs: 1 }; const r = await request(); assert.equal(r.files[0].reason, 'diff_budget_exceeded'); limits = {}; });
    await check('file count is bounded', async () => { snapshot.records = Array.from({ length: 33 }, (_, i) => ({ ...original, path: 'f' + i, operationId: 'op-' + i })); assert.equal((await request()).code, 'budget_exceeded'); await reset(); });
    await check('multi-file partial conflict preserves both disk files and refuses aggregate eligibility', async () => {
      snapshot.records = [{ ...original }, { ...original, operationId:'op-2',path:'conflict.txt',workspaceSequence:2 }];
      snapshot.selectedOperationIds = ['op-1','op-2'];
      await fs.writeFile(path.join(root,'conflict.txt'),'user conflict\n');
      const result=await request({evidenceIds:snapshot.selectedOperationIds});
      assert.equal(result.ok,true);assert.equal(result.files[0].status,'candidate');assert.equal(result.files[1].status,'refused');
      assert.equal(result.files[1].reason,'overlapping_changes');assert.equal(result.limited.contentEligible,false);
      assert.equal(await fs.readFile(path.join(root,'file.txt'),'utf8'),'after\n');
      assert.equal(await fs.readFile(path.join(root,'conflict.txt'),'utf8'),'user conflict\n');await reset();
    });
    await check('operation count is bounded', async () => { snapshot.records = Array.from({ length: 129 }, (_, i) => ({ ...original, operationId: 'op-' + i })); assert.equal((await request()).code, 'budget_exceeded'); await reset(); });
    await check('explicit diff aggregate remains within 32KiB', async () => {
      const before = Buffer.from('b'.repeat(9000) + '\n'), after = Buffer.from('a'.repeat(9000) + '\n');
      snapshot.records = ['first.txt', 'second.txt'].map((file, i) => ({ ...original, operationId: 'diff-' + i, path: file, before, intendedAfter: after, observedAfter: after }));
      snapshot.selectedOperationIds = snapshot.records.map(r => r.operationId);
      for (const r of snapshot.records) await fs.writeFile(path.join(root, r.path), after);
      const r = await request({ evidenceIds: snapshot.selectedOperationIds, includeDiff: true }); assert.equal(r.ok, true);
      assert.ok(r.files.reduce((size, file) => size + Buffer.byteLength(file.diff || ''), 0) <= 32768);
      assert.ok(r.files.some(file => file.diffUnavailable === 'diff_budget_exceeded')); await reset();
    });
    await check('workspace mismatch is rejected even if store adapter returns it', async () => { snapshot.records[0].scope = { ...scope, workspaceId: 'foreign' }; assert.equal((await request()).code, 'invalid_evidence_scope'); await reset(); });
    await check('real persistent store snapshot previews with default worker', async () => {
      const { createSessionChangeStore } = await import('../server/session-change-store.js');
      const runtimeScope = { ...scope, runtimeOwner: { backendInstance: 'backend', projectId: 'project', repoId: null, workspaceId: 'workspace', workspaceEpoch: 'epoch', conversationId: 'conversation', runtimeId: 'runtime', runtimeGeneration: 'current', sessionId: 'native' } };
      backingStore = await createSessionChangeStore({ dataDir: path.join(root, 'data'), privacyCheck: async () => true });
      await backingStore.configure(runtimeScope, { enabled: true, acknowledged: true });
      await backingStore.prepare(runtimeScope, { operationId: 'real-op', toolCallId: 'tool', path: 'file.txt', before: original.before, intendedAfter: original.intendedAfter, effectiveToolSource: 'pi-gui-revert' });
      await backingStore.settle(runtimeScope, 'real-op', { observedAfter: original.observedAfter, toolOutcome: 'success', mutationOutcome: 'written', evidenceLevel: 'intent_verified' });
      await backingStore.amendOutcome(runtimeScope, 'real-op', { toolOutcome: 'success' });
      const r = await request({ evidenceIds: ['real-op'] }); assert.equal(r.ok, true); assert.equal(r.limited.contentEligible, true); backingStore = null;
    });
    await check('request operation count is bounded', async () => assert.equal((await request({ evidenceIds: Array.from({ length: 129 }, (_, i) => 'op-' + i) })).status, 400));
    await check('private evidence I/O has a separate deadline from diff CPU', async () => { const old = store.previewSnapshot; store.previewSnapshot = async (...args) => { await new Promise(r => setTimeout(r, 2050)); return old(...args); }; try { assert.equal((await request()).ok, true); } finally { store.previewSnapshot = old; } });
    await check('preview admission bounds retained snapshots before store reads', async () => {
      const originalSnapshot = store.previewSnapshot; let entered = 0, release;
      const blocked = new Promise(resolve => { release = resolve; });
      store.previewSnapshot = async (...args) => { entered++; await blocked; return originalSnapshot(...args); };
      const first = request(), second = request();
      try {
        for (let i = 0; entered < 2 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
        const third = request();
        const result = await Promise.race([third, new Promise(resolve => setTimeout(() => resolve({code:'not_admitted_bounded'}),100))]);
        assert.equal(result.code, 'preview_busy'); assert.equal(entered, 2);
      } finally { release(); await Promise.all([first,second]); store.previewSnapshot = originalSnapshot; }
    });
    await check('lower deadline refuses without writes', async () => { limits = { deadlineMs: 1 }; const old = store.previewSnapshot; store.previewSnapshot = async (...args) => { await new Promise(r => setTimeout(r, 5)); return old(...args); }; assert.equal((await request()).code, 'budget_exceeded'); store.previewSnapshot = old; limits = {}; });
    console.log(`Session revert HTTP: ${checks}/${checks}`);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await fs.rm(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
