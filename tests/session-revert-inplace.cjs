// Isolated experiment, NOT a production writer or an eligibility provider.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const run = promisify(execFile);
const helper = path.join(__dirname, 'fixtures/session-revert-inplace-native.ps1');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const relativePath = 'workspace/file.txt';
const children = new Set();
let passed = 0, failed = 0, skipped = 0;

function start(args) {
  const env = { ...process.env, PI_INPLACE_INPUT: Buffer.from(JSON.stringify(args)).toString('base64') };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper], { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  const lines = [], waiters = new Set(); let text = '', stderrBytes = 0, closed = false;
  const wake = () => { for (const next of [...waiters]) next(); };
  const timer = setTimeout(() => child.kill(), 30000);
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { closed = true; clearTimeout(timer); children.delete(child); wake(); resolve({ code, signal }); });
  });
  child.stdout.on('data', bytes => {
    text += bytes;
    if (Buffer.byteLength(text) > 65536 || lines.length > 32) { child.kill(); return; }
    let newline;
    while ((newline = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, newline).trim(); text = text.slice(newline + 1);
      try { if (line) lines.push(JSON.parse(line)); } catch { lines.push({ phase: 'invalid_output' }); }
    }
    wake();
  });
  // Native failure messages must never become raw test/product diagnostics.
  child.stderr.on('data', bytes => { stderrBytes += bytes.length; if (stderrBytes > 8192) child.kill(); });
  const wait = phase => new Promise((resolve, reject) => {
    const next = () => {
      const value = lines.find(line => line.phase === phase);
      if (value) { waiters.delete(next); resolve(value); }
      else if (closed || lines.some(line => ['refused', 'invalid_output'].includes(line.phase))) { waiters.delete(next); reject(Object.assign(Error('native_refused'), { code: lines.find(line => line.phase === 'refused')?.code || 'native_refused', rows: lines })); }
    };
    waiters.add(next); next();
  });
  return { child, lines, exit, wait, send: line => child.stdin.write(line + '\n'), async dispose() { if (!closed) child.stdin.end('cancel\n'); await exit; } };
}
async function one(args) {
  const native = start(args);
  const result = await native.exit;
  assert.equal(result.code, 0, 'bounded native fixture completes');
  assert.equal(native.lines.length, 1, 'single bounded JSON snapshot');
  return native.lines[0];
}
async function fixturePowerShell(script, root) {
  // Scripts are fixed test code; the only path is the fresh fixture in an env field.
  const env = { ...process.env, PI_INPLACE_ROOT: root };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  return run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, windowsHide: true, timeout: 15000, maxBuffer: 8192 });
}
async function fixture(bytes, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p33-inplace-'));
  try {
    await fs.mkdir(path.join(root, 'workspace'));
    await fs.writeFile(path.join(root, relativePath), bytes);
    return await fn(root, path.join(root, relativePath));
  } finally {
    for (const child of [...children]) { child.kill(); }
    await Promise.allSettled([...children].map(child => new Promise(resolve => child.once('close', resolve))));
    const resolved = path.resolve(root), parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('p33-inplace-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
const observe = root => one({ root, relativePath, mode: 'observe' });
const setup = (root, metadataKind = 'protected', withExtras = true) => one({ root, relativePath, mode: 'setup', metadataKind, withExtras });
const check = async (name, fn) => { try { await fn(); passed++; console.log('ok', name); } catch (e) { failed++; console.error('FAIL', name, e.code || e.name); } };
const skip = (name, reason) => { skipped++; console.log('SKIP', name, reason); };

async function prepared(root, before, candidate, privateAcl = false, researchOptions = {}) {
  const { createSessionChangeStore } = await import('../server/session-change-store.js');
  const scope = { projectId: 'prototype', repoId: null, workspaceId: 'temporary', workspaceEpoch: 'epoch', conversationId: 'isolated', nativeSessionId: 'fixture' };
  const options = { dataDir: path.join(root, 'private-data'), ...(!privateAcl ? { privacyCheck: async () => true } : {}), ...researchOptions.storeOptions };
  const store = await createSessionChangeStore(options);
  const currentRef = await store.restorePut(scope, before), candidateRef = await store.restorePut(scope, candidate);
  const planId = randomUUID(), file = { fileId: 'temporary-file', relativePath, operationIds: [], currentRef, candidateRef, state: 'prepared',
    ...(researchOptions.metadata ? { currentMetadata: researchOptions.metadata } : {}) };
  const plan = { planId, mode: 'research_only', tokenHash: hash(randomUUID()), expiresAt: Date.now() + 60000, files: [file], selectedOperationIds: [], residualRacePossible: true };
  await store.applyCreate(scope, plan);
  assert.deepEqual(await store.restoreRead(scope, currentRef), before);
  assert.deepEqual(await store.restoreRead(scope, candidateRef), candidate);
  return { store, scope, options, planId, file, async intent() { await store.applyUpdate(scope, planId, { confirmationAt: Date.now(), files: [{ ...file, state: 'replacing' }] }); }, async finish(state, observed) { await store.applyUpdate(scope, planId, { state, completion: state === 'applied_verified' ? 'completed' : 'partial', files: [{ ...file, state, observedPostDigest: hash(observed) }] }); } };
}
async function write(root, C, R, { fault = 'none', afterReady, privateAcl = false } = {}) {
  const before = await observe(root);
  const materials = await prepared(root, C, R, privateAcl);
  const native = start({ root, relativePath, mode: 'write', expectedId: before.id, expectedBase64: C.toString('base64'), candidateBase64: R.toString('base64'), fault });
  try {
    const ready = await native.wait('ready'); assert.equal(ready.id, before.id);
    await afterReady?.(native, materials);
    await materials.intent(); // fsync-backed evidence intent BEFORE commit handshake.
    native.send('commit');
    const exited = await native.exit;
    if (fault !== 'none') assert.equal(exited.code, 73, 'native crash at selected write boundary');
    else {
      assert.equal(exited.code, 0);
      assert.equal(native.lines.at(-1).phase, 'done'); assert.equal(native.lines.at(-1).verified, true);
      const observed = await fs.readFile(path.join(root, relativePath));
      assert.deepEqual(observed, R);
      await materials.finish('applied_verified', observed);
    }
    return { materials, before, after: await observe(root), rows: native.lines };
  } finally { if (children.has(native.child)) await native.dispose(); }
}

// Shared only by isolated research suites; direct npm test behavior is unchanged.
module.exports = { start, one, fixture, observe, setup, prepared, write, fixturePowerShell, hash, relativePath };
if (require.main === module) (async () => {
  await fs.access(helper);
  if (process.platform !== 'win32') { skip('original-object native experiment', 'Windows required'); console.log(`session-revert-inplace: 0/0; failed=0; skipped=${skipped}; research only`); return; }
  for (const [name, C, R] of [
    ['ordinary dirty content', Buffer.from('user old\nanchor\n'), Buffer.from('user restored\nanchor\n')],
    ['shorter target', Buffer.from('123456789'), Buffer.from('R')],
    ['longer target', Buffer.from('C'), Buffer.from('longer restored bytes')],
    ['empty target', Buffer.from('current'), Buffer.alloc(0)],
    ['BOM mixed CRLF/LF exact bytes', Buffer.from('\ufeffuser\r\nanchor\nlater\r\n'), Buffer.from('\ufeffrestored\r\nanchor\nlater\r\n')]
  ]) await check(name + ' preserves file object and preimage backup', () => fixture(C, async root => {
    const result = await write(root, C, R);
    assert.equal(result.before.fileSystem, 'NTFS');
    assert.equal(result.after.id, result.before.id);
    assert.deepEqual(await result.materials.store.restoreRead(result.materials.scope, result.materials.file.currentRef), C);
  }));

  for (const kind of ['protected', 'inherited']) await check(kind + ' DACL owner group ADS EA and tested attributes stay equal', () => fixture(Buffer.from('current'), async root => {
    const initial = await setup(root, kind), result = await write(root, Buffer.from('current'), Buffer.from('restored'));
    for (const key of ['id', 'dacl', 'owner', 'group', 'ea', 'ads', 'attributes']) assert.deepEqual(result.after[key], initial[key], key);
    assert.ok(initial.ea && !initial.ea.startsWith('status:'), 'nonempty actual EA fixture');
    assert.ok(initial.ads, 'actual named stream fixture');
    console.log('measurement', JSON.stringify({ kind, idEqual: result.after.id === initial.id, daclEqual: true, eaEqual: true, adsEqual: true, attributesEqual: true, auditReadable: initial.auditReadable }));
    if (!initial.auditReadable) { assert.equal(initial.sacl, null); skip(kind + ' nonempty SACL preservation', 'SeSecurityPrivilege unavailable; not empty SACL'); }
    else {
      assert.ok(initial.sacl && initial.auditCount > 0, 'nonempty audit fixture required');
      assert.deepEqual(result.after.sacl, initial.sacl);
      if (kind === 'inherited') assert.ok(initial.inheritedAuditCount > 0, 'inherited audit ACE required');
      passed++; console.log('ok', kind + ' actual nonempty SACL stays equal');
    }
  }));

  await check('fresh second plan and durable current backup restore C without replacing file object', () => fixture(Buffer.from('original user'), async root => {
    const first = await write(root, Buffer.from('original user'), Buffer.from('restored target'), { privateAcl: true });
    const { createSessionChangeStore } = await import('../server/session-change-store.js');
    const reopened = await createSessionChangeStore(first.materials.options);
    const savedC = await reopened.restoreRead(first.materials.scope, first.materials.file.currentRef);
    const second = await write(root, await fs.readFile(path.join(root, relativePath)), savedC, { privateAcl: true });
    assert.notEqual(first.materials.planId, second.materials.planId);
    assert.equal(first.before.id, second.after.id);
    assert.deepEqual(await second.materials.store.restoreRead(second.materials.scope, second.materials.file.currentRef), Buffer.from('restored target'));
  }));

  await check('existing durable B/A/P produces R preserving dirty and later independent bytes before isolated write', () => fixture(Buffer.from('agent\nanchor\nuser later\n'), async root => {
    const { createSessionChangeStore } = await import('../server/session-change-store.js');
    const { computeSessionRevert } = await import('../lib/session-revert.js');
    const owner = { backendInstance: 'fixture', projectId: 'fixture', repoId: null, workspaceId: 'workspace', workspaceEpoch: 'epoch', conversationId: 'conversation', runtimeId: 'runtime', runtimeGeneration: 'generation', sessionId: 'native' };
    const scope = { runtimeOwner: owner, workspaceId: owner.workspaceId, workspaceEpoch: owner.workspaceEpoch, conversationId: owner.conversationId, nativeSessionId: owner.sessionId };
    const store = await createSessionChangeStore({ dataDir: path.join(root, 'capture-data'), privacyCheck: async () => true });
    const B = Buffer.from('user original\nanchor\ntail\n'), A = Buffer.from('agent\nanchor\ntail\n'), C = await fs.readFile(path.join(root, relativePath));
    await store.configure(scope, { enabled: true, acknowledged: true });
    await store.prepare(scope, { operationId: 'synthetic-capture', toolCallId: 'tool', path: 'file.txt', before: B, intendedAfter: A, effectiveToolSource: 'fixture' });
    await store.settle(scope, 'synthetic-capture', { observedAfter: A, toolOutcome: 'success', mutationOutcome: 'written', evidenceLevel: 'intent_verified' });
    await store.amendOutcome(scope, 'synthetic-capture', { toolOutcome: 'success' });
    const snapshot = await store.previewSnapshot(scope, { evidenceIds: ['synthetic-capture'] });
    const result = computeSessionRevert({ records: snapshot.records, selectedOperationIds: snapshot.selectedOperationIds, current: C, gapRevision: snapshot.gapRevision });
    assert.equal(result.status, 'candidate'); assert.deepEqual(result.candidate, Buffer.from('user original\nanchor\nuser later\n'));
    const written = await write(root, C, result.candidate);
    assert.deepEqual(await fs.readFile(path.join(root, relativePath)), result.candidate);
    assert.deepEqual(await written.materials.store.restoreRead(written.materials.scope, written.materials.file.currentRef), C);
    console.log('BAP pipeline', JSON.stringify({ capture: 'synthetic dispatcher', durableEvidence: true, currentDigest: hash(C), candidateDigest: hash(result.candidate), userBytesRetained: true, productionMetadataQualified: false }));
  }));

  await check('stale C refuses before native ready and preserves new D', () => fixture(Buffer.from('D'), async root => {
    const snapshot = await observe(root), native = start({ root, relativePath, mode: 'write', expectedId: snapshot.id, expectedBase64: Buffer.from('C').toString('base64'), candidateBase64: Buffer.from('R').toString('base64'), fault: 'none' });
    await native.exit; assert.equal(native.lines.at(-1).phase, 'refused'); assert.ok(!native.lines.some(row => row.phase === 'ready'));
    assert.deepEqual(await fs.readFile(path.join(root, relativePath)), Buffer.from('D'));
  }));

  await check('cancel before durable intent writes nothing', () => fixture(Buffer.from('C'), async root => {
    const before = await observe(root), native = start({ root, relativePath, mode: 'write', expectedId: before.id, expectedBase64: 'Qw==', candidateBase64: 'Ug==', fault: 'none' });
    await native.wait('ready'); native.send('cancel'); await native.exit;
    assert.deepEqual(await fs.readFile(path.join(root, relativePath)), Buffer.from('C'));
  }));

  await check('same bytes on a replacement object cannot satisfy old identity', () => fixture(Buffer.from('C'), async root => {
    const before = await observe(root);
    await fs.rename(path.join(root, relativePath), path.join(root, 'old-original'));
    await fs.writeFile(path.join(root, relativePath), 'C');
    const native = start({ root, relativePath, mode: 'write', expectedId: before.id, expectedBase64: 'Qw==', candidateBase64: 'Ug==', fault: 'none' });
    await native.exit; assert.equal(native.lines.at(-1).phase, 'refused'); assert.ok(!native.lines.some(row => row.phase === 'ready'));
    assert.deepEqual(await fs.readFile(path.join(root, relativePath)), Buffer.from('C'));
    assert.deepEqual(await fs.readFile(path.join(root, 'old-original')), Buffer.from('C'));
  }));

  await check('persistent preimage failure never reaches native commit', () => fixture(Buffer.from('C'), async root => {
    const original = fs.open;
    fs.open = async (location, ...args) => { if (String(location).includes(path.sep + 'objects' + path.sep) && args[0] === 'wx') throw Object.assign(Error('fixture'), { code: 'ENOSPC' }); return original(location, ...args); };
    try { await assert.rejects(write(root, Buffer.from('C'), Buffer.from('R'))); }
    finally { fs.open = original; }
    assert.deepEqual(await fs.readFile(path.join(root, relativePath)), Buffer.from('C'));
    assert.equal(children.size, 0);
  }));

  for (const failure of ['append_open', 'append_fsync']) await check('durable intent ' + failure + ' fails while native is ready; no commit or mutation', () => fixture(Buffer.from('C'), async root => {
    const original = fs.open; let reachedReady = false, saved;
    try {
      await assert.rejects(write(root, Buffer.from('C'), Buffer.from('R'), { afterReady: async (_native, materials) => {
        reachedReady = true; saved = materials;
        fs.open = async (location, ...args) => {
          if (!String(location).endsWith(path.sep + 'journal.jsonl') || args[0] !== 'a') return original(location, ...args);
          if (failure === 'append_open') throw Object.assign(Error('fixture'), { code: 'EIO' });
          const handle = await original(location, ...args);
          handle.sync = async () => { throw Object.assign(Error('fixture'), { code: 'EIO' }); };
          return handle;
        };
      } }));
    } finally { fs.open = original; }
    assert.equal(reachedReady, true); assert.equal(children.size, 0);
    assert.deepEqual(await fs.readFile(path.join(root, relativePath)), Buffer.from('C'));
    const { createSessionChangeStore } = await import('../server/session-change-store.js');
    const reopened = await createSessionChangeStore(saved.options);
    assert.equal((await reopened.applyGet(saved.scope, saved.planId)).state, 'recovery_required');
    assert.deepEqual(await reopened.restoreRead(saved.scope, saved.file.currentRef), Buffer.from('C'));
    assert.deepEqual(await reopened.restoreRead(saved.scope, saved.file.candidateRef), Buffer.from('R'));
  }));

  await check('multi-hardlink ordinary object refuses without touching either name', () => fixture(Buffer.from('C'), async root => {
    const before = await observe(root); await fs.link(path.join(root, relativePath), path.join(root, 'second-name'));
    const native = start({ root, relativePath, mode: 'write', expectedId: before.id, expectedBase64: 'Qw==', candidateBase64: 'Ug==', fault: 'none' });
    await native.exit; assert.equal(native.lines.at(-1).phase, 'refused');
    assert.deepEqual(await fs.readFile(path.join(root, 'second-name')), Buffer.from('C'));
  }));

  await check('junction in source parent refuses before writer admission', () => fixture(Buffer.from('C'), async root => {
    const before = await observe(root);
    await fs.rename(path.join(root, 'workspace'), path.join(root, 'real-workspace'));
    await fs.symlink(path.join(root, 'real-workspace'), path.join(root, 'workspace'), 'junction');
    const native = start({ root, relativePath, mode: 'write', expectedId: before.id, expectedBase64: 'Qw==', candidateBase64: 'Ug==', fault: 'none' });
    await native.exit; assert.equal(native.lines.at(-1).phase, 'refused'); assert.ok(!native.lines.some(row => row.phase === 'ready'));
    assert.deepEqual(await fs.readFile(path.join(root, 'real-workspace/file.txt')), Buffer.from('C'));
    await fs.unlink(path.join(root, 'workspace'));
  }));

  await check('readonly source refuses without removing its attribute', () => fixture(Buffer.from('C'), async root => {
    const before = await observe(root);
    await fixturePowerShell("$ErrorActionPreference='Stop';$p=Join-Path $env:PI_INPLACE_ROOT 'workspace/file.txt';[IO.File]::SetAttributes($p,([IO.File]::GetAttributes($p) -bor [IO.FileAttributes]::ReadOnly))", root);
    try {
      const native = start({ root, relativePath, mode: 'write', expectedId: before.id, expectedBase64: 'Qw==', candidateBase64: 'Ug==', fault: 'none' });
      await native.exit; assert.equal(native.lines.at(-1).phase, 'refused'); assert.ok(!native.lines.some(row => row.phase === 'ready'));
      assert.deepEqual(await fs.readFile(path.join(root, relativePath)), Buffer.from('C'));
      assert.ok((await observe(root)).attributes & 1);
    } finally { await fixturePowerShell("$ErrorActionPreference='Stop';$p=Join-Path $env:PI_INPLACE_ROOT 'workspace/file.txt';[IO.File]::SetAttributes($p,([IO.File]::GetAttributes($p) -band (-bnot 1)))", root); }
  }));

  for (const boundary of ['after_first_write', 'after_eof', 'after_flush']) await check('real native process exit ' + boundary + ' retains C/R and needs recovery, no retry', () => fixture(Buffer.from('CCCCCCCC'), async root => {
    const result = await write(root, Buffer.from('CCCCCCCC'), Buffer.from('RRRR'), { fault: boundary });
    const { createSessionChangeStore } = await import('../server/session-change-store.js');
    const restarted = await createSessionChangeStore(result.materials.options), plan = await restarted.applyGet(result.materials.scope, result.materials.planId);
    assert.equal(plan.state, 'recovery_required');
    assert.deepEqual(await restarted.restoreRead(result.materials.scope, result.materials.file.currentRef), Buffer.from('CCCCCCCC'));
    assert.deepEqual(await restarted.restoreRead(result.materials.scope, result.materials.file.candidateRef), Buffer.from('RRRR'));
    const D = await fs.readFile(path.join(root, relativePath));
    if (boundary === 'after_first_write') assert.notDeepEqual(D, Buffer.from('RRRR'), 'partial content is observed, not auto repaired');
    else assert.deepEqual(D, Buffer.from('RRRR'));
    await fs.writeFile(path.join(root, relativePath), 'user D after crash');
    await restarted.applyGet(result.materials.scope, result.materials.planId);
    assert.deepEqual(await fs.readFile(path.join(root, relativePath)), Buffer.from('user D after crash'));
    console.log('crash observation', JSON.stringify({ boundary, observedBytes: D.length, observedDigest: hash(D), state: plan.state, fullPreimageSaved: true }));
  }));

  await check('existing independent data reader blocks original-object acquisition', () => fixture(Buffer.from('C'), async root => {
    const before = await observe(root), held = start({ root, relativePath, mode: 'hold' });
    try {
      await held.wait('held');
      const native = start({ root, relativePath, mode: 'write', expectedId: before.id, expectedBase64: 'Qw==', candidateBase64: 'Ug==', fault: 'none' });
      await native.exit; assert.equal(native.lines.at(-1).phase, 'refused'); assert.ok(!native.lines.some(row => row.phase === 'ready'));
    } finally { held.send('release'); await held.exit; }
    assert.deepEqual(await fs.readFile(path.join(root, relativePath)), Buffer.from('C'));
  }));

  await check('held source parent prevents real independent rename attempt', () => fixture(Buffer.from('C'), async root => {
    await write(root, Buffer.from('C'), Buffer.from('R'), { afterReady: async () => {
      await assert.rejects(run(process.execPath, ['-e', "require('fs').renameSync(process.argv[1],process.argv[1]+'-renamed')", path.join(root, 'workspace')], { windowsHide: true, timeout: 10000 }));
      assert.deepEqual(await fs.readdir(path.join(root, 'workspace')), ['file.txt']);
    } });
  }));

  await check('genuine preexisting writable mapping is measured; never inferred OS exclusion', () => fixture(Buffer.from('CCCCCCCC'), async root => {
    const before = await observe(root), mapping = start({ root, relativePath, mode: 'mapping' });
    try {
      await mapping.wait('mapped');
      const native = start({ root, relativePath, mode: 'write', expectedId: before.id, expectedBase64: Buffer.from('CCCCCCCC').toString('base64'), candidateBase64: Buffer.from('RRRRRRRR').toString('base64'), fault: 'none' });
      let acquired = false;
      try { await native.wait('ready'); acquired = true; } catch { assert.equal(native.lines.at(-1).phase, 'refused'); }
      if (acquired) {
        mapping.send('mutate'); await mapping.wait('mutated');
        native.send('commit'); await native.exit;
        assert.equal(native.lines.at(-1).phase, 'refused', 'repeat same-handle C check catches known mapped change');
      } else await native.exit;
      console.log('mapping observation', JSON.stringify({ originalDataHandleClosed: true, writerAcquired: acquired, modeStrict: false }));
    } finally { mapping.send('release'); await mapping.exit; }
  }));

  await check('independent ADS write can bypass unnamed stream share mode; metadata is not globally locked', () => fixture(Buffer.from('C'), async root => {
    await setup(root);
    const result = await write(root, Buffer.from('C'), Buffer.from('R'), { afterReady: async () => {
      await run(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1]+':probe','external stream D')", path.join(root, relativePath)], { windowsHide: true, timeout: 10000 });
    } });
    assert.equal(result.after.ads, 'external stream D');
    console.log('metadata race', JSON.stringify({ namedStreamWriterSucceeded: true, primaryCandidateCorrect: true, fullMetadataExclusion: false }));
  }));

  await check('independent DACL update during held data handle is preserved and exposes metadata admission gap', () => fixture(Buffer.from('C'), async root => {
    const initial = await setup(root);
    const result = await write(root, Buffer.from('C'), Buffer.from('R'), { afterReady: async () => {
      // Set-Acl serializes audit sections and requires SeSecurityPrivilege here.
      // Deliberately modify Access only: this is a real independent WRITE_DAC probe.
      await fixturePowerShell("$ErrorActionPreference='Stop';$p=Join-Path $env:PI_INPLACE_ROOT 'workspace/file.txt';$source=Get-Acl -LiteralPath $p;$acl=[Security.AccessControl.FileSecurity]::new();$acl.SetSecurityDescriptorSddlForm($source.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access),[Security.AccessControl.AccessControlSections]::Access);$id=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545');$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($id,'Read','Allow'));[IO.File]::SetAccessControl($p,$acl)", root);
    } });
    assert.notEqual(result.after.dacl, initial.dacl);
    assert.equal(result.after.id, initial.id);
    console.log('DACL race', JSON.stringify({ securityWriterSucceeded: true, externalDaclRetained: true, fullMetadataExclusion: false }));
  }));

  await check('data-only write measures Archive attribute changes instead of repairing attributes', () => fixture(Buffer.from('C'), async root => {
    await fixturePowerShell("$ErrorActionPreference='Stop';[IO.File]::SetAttributes((Join-Path $env:PI_INPLACE_ROOT 'workspace/file.txt'),[IO.FileAttributes]::NotContentIndexed)", root);
    const result = await write(root, Buffer.from('C'), Buffer.from('R'));
    assert.equal(result.before.attributes, 8192);
    assert.equal(result.after.attributes & 8192, 8192);
    console.log('attribute observation', JSON.stringify({ before: result.before.attributes, after: result.after.attributes, archiveChanged: !!((result.before.attributes ^ result.after.attributes) & 32), repaired: false }));
  }));

  await check('prototype remains unreachable from production API and unknown SACL remains refused', async () => {
    const sources = await Promise.all(['server/session-revert-writer.js', 'server/session-revert-service.js', 'server/session-revert-routes.js', 'server/session-revert-metadata.js', 'server.js'].map(name => fs.readFile(path.resolve(__dirname, '..', name), 'utf8')));
    for (const source of sources) assert.ok(!source.includes('inplace-native') && !source.includes('session-revert-inplace'));
    assert.ok(sources[3].includes("if(!$auditEnabled){@{supported=$false;reason='metadata_audit_unavailable'}"));
  });
  console.log(`session-revert-inplace: ${passed}/${passed + failed}; failed=${failed}; skipped=${skipped}; research only; no production eligibility`);
  if (failed) process.exitCode = 1;
})().catch(e => { console.error('prototype fixture failed', e.code || e.name); process.exitCode = 1; });
