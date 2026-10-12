// P33.4b research only; no production imports or eligibility decisions.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const h = require('./session-revert-inplace.cjs');
const run = promisify(execFile), C = Buffer.from('CCCCCCCC'), R = Buffer.from('RRRR');
// Allocation accounting alone is a fixture; content I/O, fsync and NTFS are real.
const storeOptions = { allocationUnit: 4096, allocationProbe: async paths => Promise.all(paths.map(async p => {
  const { size } = await fs.stat(p), allocatedBytes = Math.ceil(size / 4096) * 4096;
  return { logicalBytes: size, allocatedBytes, chargeBytes: Math.max(size, allocatedBytes) };
})) };
function classify({ plan, currentDigest, currentId, expectedId, preimageDigest, candidateDigest, trustedObservation, knownNoCommit = false, integrity = true, externalChange = false }) {
  const persistedState = plan.state, matches = currentDigest === preimageDigest ? 'preimage' : currentDigest === candidateDigest ? 'candidate' : 'other';
  const uncertainExternalChange = externalChange || currentId !== expectedId || (trustedObservation != null && currentDigest !== trustedObservation);
  let classification = 'recovery_required', reason = 'incomplete_commit_history';
  if (!integrity || ![currentDigest, currentId, expectedId, preimageDigest, candidateDigest].every(value => typeof value === 'string' && value.length > 0)) reason = 'material_integrity_failed';
  else if (uncertainExternalChange) { classification = 'uncertain_external_change'; reason = 'observed_change_not_attributable'; }
  else if (persistedState === 'not_applied' && knownNoCommit && matches === 'preimage') { classification = 'not_applied'; reason = 'verified_no_commit'; }
  else if (persistedState === 'applied_verified' && plan.files?.[0]?.observedPostDigest === candidateDigest && matches === 'candidate') { classification = 'applied_verified'; reason = 'durable_observed_result'; }
  return { classification, persistedState, observedMatches: matches, reason, uncertainExternalChange,
    recoveryRequired: !['not_applied', 'applied_verified'].includes(classification), retryAllowed: false, productionQualified: false, residualRacePossible: true };
}
async function diskInputs(root, current, candidate) {
  await fs.mkdir(path.join(root, 'inputs'), { mode: 0o700 });
  for (const [name, bytes] of [['current.bin', current], ['candidate.bin', candidate]]) {
    const f = await fs.open(path.join(root, 'inputs', name), 'wx', 0o600);
    try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
  }
  return { fileTransport: true, expectedDigest: h.hash(current), candidateDigest: h.hash(candidate) };
}
async function exercise(root, current = C, candidate = R, { fault = 'none', disk = false, afterReady, afterNative, privateAcl = false, realStorage = false, metadata } = {}) {
  const initial = await h.observe(root), materials = await h.prepared(root, current, candidate, privateAcl, { ...(realStorage ? {} : { storeOptions }), metadata });
  const transport = disk ? await diskInputs(root, current, candidate) : { expectedBase64: current.toString('base64'), candidateBase64: candidate.toString('base64') };
  const native = h.start({ root, relativePath: h.relativePath, mode: 'write', expectedId: initial.id, fault, ...transport });
  try {
    await native.wait('ready'); await afterReady?.(native, materials, initial); await materials.intent(); native.send('commit');
    const exited = await native.exit, actual = await fs.readFile(path.join(root, h.relativePath)), observed = await h.observe(root);
    await afterNative?.(materials, actual);
    if (metadata) for (const key of ['id', 'owner', 'group', 'dacl', 'sacl', 'fullSDDL', 'attributes', 'ads', 'ea', 'isAuditProtected', 'isDaclProtected']) assert.deepEqual(observed[key], metadata[key], 'witness metadata: ' + key);
    if (exited.code === 0) {
      assert.equal(native.lines.at(-1)?.phase, 'done'); assert.equal(native.lines.at(-1).verified, true); assert.equal(native.lines.at(-1).id, initial.id);
      assert.equal(observed.id, initial.id);
      assert.ok(!native.lines.some(row => ['invalid_output', 'refused'].includes(row.phase)));
      assert.deepEqual(actual, candidate); await materials.finish('applied_verified', actual);
    }
    return { initial, materials, actual, result: native.lines.at(-1), exited, observed };
  } finally { await native.dispose(); }
}
async function reopen(materials) {
  const { createSessionChangeStore } = await import('../server/session-change-store.js');
  const store = await createSessionChangeStore(materials.options);
  return { store, plan: await store.applyGet(materials.scope, materials.planId) };
}
async function setAttrs(root, attrs, afterReady) {
  const initial = await h.observe(root), native = h.start({ root, relativePath: h.relativePath, mode: 'attributes', expectedId: initial.id, attributes: attrs });
  try { await native.wait('attrs_ready'); await afterReady?.(); native.send('commit'); assert.equal((await native.exit).code, 0); return h.observe(root); } finally { await native.dispose(); }
}
module.exports = { classify, diskInputs, exercise, reopen };
if (require.main === module) (async () => {
  let passed = 0, failed = 0, skipped = 0;
  const check = async (name, fn) => { try { await fn(); passed++; console.log('ok', name); } catch (e) { failed++; console.error('FAIL', name, e.code || e.name); } };
  const base = { plan: { state: 'recovery_required' }, currentDigest: 'R', currentId: 'id', expectedId: 'id', preimageDigest: 'C', candidateDigest: 'R' };
  for (const [name, input, expected] of [
    ['R alone', base, 'recovery_required'], ['C alone', { ...base, currentDigest: 'C' }, 'recovery_required'],
    ['no commit', { ...base, currentDigest: 'C', knownNoCommit: true, plan: { state: 'not_applied' } }, 'not_applied'],
    ['durable result', { ...base, plan: { state: 'applied_verified', files: [{ observedPostDigest: 'R' }] } }, 'applied_verified'],
    ['partial bytes', { ...base, currentDigest: 'partial' }, 'recovery_required'],
    ['new object', { ...base, currentId: 'new' }, 'uncertain_external_change'],
    ['new D', { ...base, currentDigest: 'new D', trustedObservation: 'partial' }, 'uncertain_external_change'],
    ['metadata external change despite R', { ...base, externalChange: true }, 'uncertain_external_change'],
    ['bad materials', { ...base, integrity: false }, 'recovery_required']
  ]) await check('Mock classification ' + name, async () => { const r = classify(input); assert.equal(r.classification, expected); assert.equal(r.persistedState, input.plan.state); assert.equal(r.retryAllowed, false); assert.equal(r.productionQualified, false); });
  await check('Mock missing observation cannot establish verified result', async () => { assert.equal(classify({ ...base, currentDigest: undefined, candidateDigest: undefined, plan: { state: 'applied_verified', files: [{}] } }).classification, 'recovery_required'); });
  const { compareWitness } = require('./session-revert-sacl-witness.cjs');
  const witness = { id: 'mock', owner: 'mock', group: 'mock', dacl: 'mock', sacl: 'mock', fullSDDL: 'mock', ads: 'original-ads', ea: 'mock', attributes: 8226, isAuditProtected: false, isDaclProtected: true, explicitAuditCount: 2, inheritedAuditCount: 0, auditCount: 2, auditReadable: true };
  const spec = { auditProfile: 'explicit', metadataKind: 'protected' };
  await check('Mock witness schema accepts only a complete matching observation', async () => { assert.equal(compareWitness(witness, { ...witness }, spec).matched, true); });
  for (const key of ['fullSDDL', 'sacl', 'dacl', 'ads', 'ea', 'attributes', 'id', 'auditReadable']) await check('Mock witness rejects changed ' + key, async () => {
    assert.equal(compareWitness(witness, { ...witness, [key]: key === 'auditReadable' ? false : 'changed' }, spec).matched, false);
  });
  await check('Mock witness unknown SACL never becomes empty', async () => { const unknown = { ...witness, auditReadable: false, sacl: null, fullSDDL: null }; assert.equal(compareWitness(unknown, unknown, spec).matched, false); });
  if (process.platform !== 'win32') { skipped++; console.log('SKIP native safety matrix Windows required'); }
  else {
    await check('read-only audit privilege probe', async () => { const r = await h.one({ mode: 'privilege' }); assert.equal(r.phase, 'privilege'); assert.equal(typeof r.auditEnabled, 'boolean'); assert.equal(typeof r.auditError, 'number'); console.log('privilege', JSON.stringify(r)); });
    for (const [fault, cause, actual, code] of [
      ['write_failure', 'write_failed', C, 5], ['write_after_partial_failure', 'write_failed', Buffer.from('RRCCCCCC'), 5],
      ['eof_failure', 'eof_failed', Buffer.from('RRRRCCCC'), 5], ['flush_failure', 'flush_failed', R, 5], ['zero_write', 'short_write', C, 0]
    ]) await check('real Win32 injected ' + fault, () => h.fixture(C, async root => {
      const r = await exercise(root, C, R, { fault }); assert.equal(r.exited.code, 2); assert.equal(r.result.code, 'recovery_required'); assert.equal(r.result.cause, cause); assert.equal(r.result.nativeCode, code); assert.deepEqual(r.actual, actual);
      const { store, plan } = await reopen(r.materials); assert.equal(plan.state, 'recovery_required');
      assert.deepEqual(await store.restoreRead(r.materials.scope, r.materials.file.currentRef), C); assert.deepEqual(await store.restoreRead(r.materials.scope, r.materials.file.candidateRef), R);
      assert.equal(classify({ ...base, plan, currentDigest: h.hash(actual), currentId: r.observed.id, expectedId: r.initial.id, preimageDigest: h.hash(C), candidateDigest: h.hash(R) }).classification, 'recovery_required');
      console.log('API observation', JSON.stringify({ fault, cause, nativeCode: code, bytes: actual.length, digest: h.hash(actual), injected: true }));
    }));
    await check('limited nonzero Win32 request exercises short-write loop', () => h.fixture(C, async root => { const r = await exercise(root, C, R, { fault: 'short_write' }); assert.equal(r.exited.code, 0); assert.ok(r.result.shortWriteCount > 0); assert.deepEqual(r.actual, R); }));
    await check('post-write journal commit failure leaves R and incomplete history', () => h.fixture(C, async root => {
      let saved, observed; const open = fs.open;
      try { await assert.rejects(exercise(root, C, R, { afterNative: async (materials, actual) => { saved = materials; observed = actual; fs.open = async (p, ...args) => { if (String(p).endsWith(path.sep + 'journal.jsonl') && args[0] === 'a') throw Object.assign(Error('fixture'), { code: 'EIO' }); return open(p, ...args); }; } })); }
      finally { fs.open = open; }
      assert.deepEqual(observed, R); assert.equal((await reopen(saved)).plan.state, 'recovery_required'); assert.deepEqual(await fs.readFile(path.join(root, h.relativePath)), R);
    }));
    await check('new fixture recovery plan restores durable C after partial write and backs up D', () => h.fixture(C, async root => {
      const first = await exercise(root, C, R, { fault: 'write_after_partial_failure' }), restarted = await reopen(first.materials);
      const savedC = await restarted.store.restoreRead(first.materials.scope, first.materials.file.currentRef), second = await exercise(root, first.actual, savedC);
      assert.notEqual(first.materials.planId, second.materials.planId); assert.deepEqual(await second.materials.store.restoreRead(second.materials.scope, second.materials.file.currentRef), first.actual);
      assert.deepEqual(await fs.readFile(path.join(root, h.relativePath)), C); assert.equal((await restarted.store.applyGet(first.materials.scope, first.materials.planId)).state, 'recovery_required');
    }));
    await check('second recovery failure retains original and intermediate preimages', () => h.fixture(C, async root => {
      const first = await exercise(root, C, R, { fault: 'eof_failure' }), restarted = await reopen(first.materials), savedC = await restarted.store.restoreRead(first.materials.scope, first.materials.file.currentRef);
      const second = await exercise(root, first.actual, savedC, { fault: 'write_after_partial_failure' }), again = await reopen(second.materials);
      assert.equal(again.plan.state, 'recovery_required'); assert.deepEqual(await again.store.restoreRead(second.materials.scope, second.materials.file.currentRef), first.actual); assert.deepEqual(await again.store.restoreRead(first.materials.scope, first.materials.file.currentRef), C);
    }));
    await check('actual child changes D after crash; restart never retries', () => h.fixture(C, async root => {
      const r = await exercise(root, C, R, { fault: 'after_first_write' }); assert.equal(r.exited.code, 73);
      await run(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1],'external new D')", path.join(root, h.relativePath)], { windowsHide: true, timeout: 10000 });
      const { plan } = await reopen(r.materials), D = await fs.readFile(path.join(root, h.relativePath));
      assert.equal(classify({ ...base, plan, currentDigest: h.hash(D), currentId: r.observed.id, expectedId: r.initial.id, trustedObservation: h.hash(r.actual), preimageDigest: h.hash(C), candidateDigest: h.hash(R) }).classification, 'uncertain_external_change'); assert.deepEqual(D, Buffer.from('external new D'));
    }));
    for (const kind of ['object', 'journal']) await check('corrupt ' + kind + ' rejects reopen without workspace mutation', () => h.fixture(C, async root => {
      const m = await h.prepared(root, C, R, false, { storeOptions }), dir = path.join(root, 'private-data', 'revert-evidence', 'v1');
      if (kind === 'object') await fs.writeFile(path.join(dir, 'objects', m.file.currentRef.digest), 'bad'); else await fs.appendFile(path.join(dir, 'journal.jsonl'), 'broken');
      await assert.rejects(reopen(m), e => e.code === 'evidence_integrity_failed'); assert.deepEqual(await fs.readFile(path.join(root, h.relativePath)), C);
    }));
    for (const size of [1024, 65536, 2097152]) await check('disk transport mixed UTF-8 byte-exact ' + size, () => {
      const before = Buffer.alloc(size, 65), after = Buffer.alloc(size, 82); Buffer.from('\ufeff\r\nLF\n').copy(before); Buffer.from('\ufeff\nCRLF\r\n').copy(after);
      return h.fixture(before, async root => { const r = await exercise(root, before, after, { disk: true }); assert.equal(r.exited.code, 0); assert.equal(r.initial.id, r.observed.id); console.log('size observation', JSON.stringify({ size, digest: h.hash(r.actual), environmentCarriesContent: false })); });
    });
    await check('tampered input rejects before native ready', () => h.fixture(C, async root => {
      const initial = await h.observe(root), transport = await diskInputs(root, C, R); await fs.writeFile(path.join(root, 'inputs', 'candidate.bin'), 'bad');
      const native = h.start({ root, relativePath: h.relativePath, mode: 'write', expectedId: initial.id, fault: 'none', ...transport }); await native.exit;
      assert.equal(native.lines.at(-1).code, 'input_digest_mismatch'); assert.ok(!native.lines.some(row => row.phase === 'ready')); assert.deepEqual(await fs.readFile(path.join(root, h.relativePath)), C);
    }));
    await check('independent main stream writes and target rename are blocked by held data handle', () => h.fixture(C, async root => {
      await exercise(root, C, R, { afterReady: async () => {
        for (const action of ['write', 'rename', 'replace']) {
          const code = "const fs=require('fs'),p=process.argv[1],a=process.argv[2];let stage='attempt';try{if(a==='write')fs.writeFileSync(p,'external');else if(a==='rename')fs.renameSync(p,p+'.moved');else{stage='create';fs.writeFileSync(p+'.replacement','external',{flag:'wx'});stage='attempt';fs.renameSync(p+'.replacement',p)}console.log(JSON.stringify({stage,blocked:false}))}catch(e){console.log(JSON.stringify({stage,blocked:true,code:e.code}))}";
          const result = await run(process.execPath, ['-e', code, path.join(root, h.relativePath), action], { windowsHide: true, timeout: 10000 });
          const row = JSON.parse(result.stdout); assert.equal(row.stage, 'attempt'); assert.equal(row.blocked, true); assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(row.code));
          console.log('sharing observation', JSON.stringify({ action, code: row.code, realChild: true }));
        }
      } });
      assert.deepEqual(await fs.readFile(path.join(root, h.relativePath)), R);
      assert.deepEqual(await fs.readFile(path.join(root, h.relativePath + '.replacement')), Buffer.from('external'));
    }));
    await check('independent attribute handle can mutate while unnamed data stream is held', () => h.fixture(C, async root => {
      const r = await exercise(root, C, R, { afterReady: async () => { await setAttrs(root, 8226); } }); assert.equal(r.observed.attributes, 8226); assert.equal(r.initial.id, r.observed.id);
    }));
    await check('official Archive reset works but stale attribute replay loses independent Hidden change', () => h.fixture(C, async root => {
      await setAttrs(root, 8192); const first = await exercise(root, C, R); assert.equal(first.observed.attributes, 8224);
      assert.equal((await setAttrs(root, 8192)).attributes, 8192);
      const lost = await setAttrs(root, 8192, async () => { await setAttrs(root, 8194); }); assert.equal(lost.attributes, 8192); assert.equal(lost.attributes & 2, 0);
      console.log('Archive race', JSON.stringify({ handleApi: true, externalHiddenWasSet: true, cachedRestoreLostHidden: true, productionEnabled: false }));
    }));
    await check('Archive already set preserves tested attributes without repair', () => h.fixture(C, async root => { await setAttrs(root, 8226); const r = await exercise(root, C, R); assert.equal(r.observed.attributes, r.initial.attributes); }));
    await check('attribute old identity refuses replacement object', () => h.fixture(C, async root => {
      const initial = await h.observe(root); await fs.rename(path.join(root, h.relativePath), path.join(root, 'original')); await fs.writeFile(path.join(root, h.relativePath), C);
      const native = h.start({ root, relativePath: h.relativePath, mode: 'attributes', expectedId: initial.id, attributes: 8192 }); await native.exit;
      assert.equal(native.lines.at(-1).phase, 'refused'); assert.ok(!native.lines.some(row => row.phase === 'attrs_ready'));
    }));
    const privilege = await h.one({ mode: 'privilege' });
    if (privilege.auditEnabled) { skipped++; console.log('SKIP missing privilege test token has privilege'); }
    else await check('missing audit privilege never changes SACL or creates setup marker', () => h.fixture(C, async root => {
      const initial = await h.observe(root), native = h.start({ root, relativePath: h.relativePath, mode: 'sacl_setup', auditProfile: 'protected', metadataKind: 'protected', withExtras: true }); await native.exit;
      assert.equal(native.lines.at(-1).code, 'audit_privilege_unavailable'); assert.deepEqual(await fs.readdir(root), ['workspace']); assert.deepEqual(await h.observe(root), initial); assert.deepEqual(await fs.readFile(path.join(root, h.relativePath)), C);
    }));
  }
  console.log(`session-revert-inplace-safety: ${passed}/${passed + failed}; failed=${failed}; skipped=${skipped}; research only; no production eligibility`);
  if (failed) process.exitCode = 1;
})().catch(e => { console.error('research failure', e.code || e.name); process.exitCode = 1; });
