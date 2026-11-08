const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const entry = pathToFileURL(path.resolve(__dirname, '../server/provider-config-store.js')).href;
async function fixture(t, { fault, io } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { modelsJson: path.join(root, 'agent', 'models.json'), metadataPath: path.join(root, 'gui', 'provider-management.json') };
  fs.mkdirSync(path.dirname(options.modelsJson));
  fs.mkdirSync(path.dirname(options.metadataPath));
  const { createProviderConfigStore } = await import(entry);
  return { ...options, options, store: createProviderConfigStore({ ...options, fault, io }), open: () => createProviderConfigStore(options) };
}
function write(store, fields = {}) {
  return store.transact({ ...fields, apply({ config, metadata }) {
    config.providers.fixture = { baseUrl: 'https://fixture.invalid/v1', models: [{ id: 'fixture' }] };
    metadata.services.fixture = { displayName: 'Fixture' };
    return { ok: true, serviceId: 'fixture', saved: true, credentialSaved: null, credentialState: 'none', operationId: null, sync: { state: 'pending', reason: 'runtime_sync_pending' } };
  } });
}

test('credential dispatch holds the existing config lock and survives reopening', async t => {
  const f = await fixture(t);
  const request = { requestId: 'native-dispatch', fingerprint: 'a'.repeat(64) };
  let receipt;
  await f.store.withCredentialOperation(async tx => {
    tx.prepare({ ...request, providerId: 'fixture', action: 'apply-staged' });
    assert.throws(() => tx.dispatch(request.requestId), { code: 'config_recovery_required' });
    receipt = write(tx, request);
    tx.dispatch(request.requestId);
    await Promise.resolve();
    assert.throws(() => write(f.open()), { code: 'config_busy' });
  });
  await f.open().withCredentialOperation(tx => {
    assert.equal(tx.lookup(request.requestId, request.fingerprint).operation.phase, 'dispatching');
    assert.deepEqual(tx.lookup(request.requestId, request.fingerprint).receipt, receipt);
    assert.throws(() => tx.dispatch(request.requestId), { code: 'config_recovery_required' });
    assert.throws(() => tx.lookup(request.requestId, 'b'.repeat(64)), { code: 'request_id_conflict' });
  });
});

test('an unresolved native operation protects its exact P1 receipt from legacy eviction', async t => {
  const f = await fixture(t);
  const request = { requestId: 'protected-receipt', fingerprint: 'a'.repeat(64) };
  await f.store.withCredentialOperation(tx => {
    tx.prepare({ ...request, providerId: 'fixture', action: 'clear-native' });
    write(tx, request);
  });
  const metadata = JSON.parse(fs.readFileSync(f.metadataPath, 'utf8'));
  for (let i = 0; i < 127; i++) metadata.receipts[`historical-${i}`] = metadata.receipts[request.requestId];
  fs.writeFileSync(f.metadataPath, JSON.stringify(metadata));
  const reopened = f.open();
  write(reopened, { requestId: 'unrelated-request', fingerprint: 'b'.repeat(64) });
  const receipts = reopened.read().metadata.receipts;
  assert.equal(Object.keys(receipts).length, 128);
  assert.equal(receipts[request.requestId].fingerprint, request.fingerprint);
  assert.equal(Object.hasOwn(receipts, 'historical-0'), false);
});

test('a prepared operation abandoned before P1 publication cannot pin its provider indefinitely', async t => {
  const f = await fixture(t);
  const first = { requestId: 'abandoned-request', fingerprint: 'a'.repeat(64), providerId: 'fixture', action: 'apply-staged' };
  const next = { ...first, requestId: 'new-request' };
  await f.store.withCredentialOperation(tx => tx.prepare(first));
  await f.open().withCredentialOperation(tx => {
    tx.prepare(next);
    assert.equal(tx.lookup(first.requestId, first.fingerprint).operation, undefined);
    assert.equal(tx.lookup(next.requestId, next.fingerprint).operation.phase, 'prepared');
  });
});

test('missing files initialize lazily; external edits conflict and durable request replay stays idempotent', async t => {
  const f = await fixture(t);
  const before = f.store.read();
  assert.equal(before.exists, false);
  assert.equal(fs.existsSync(f.metadataPath), false);
  const request = { expectedRevision: before.revision, requestId: 'fixture-request', fingerprint: 'a'.repeat(64) };
  const receipt = write(f.store, request);
  const first = fs.readFileSync(f.modelsJson);
  const reopened = f.open();
  assert.deepEqual(write(reopened, request), receipt);
  assert.deepEqual(fs.readFileSync(f.modelsJson), first);
  assert.throws(() => write(reopened, { ...request, fingerprint: 'b'.repeat(64) }), { code: 'request_id_conflict' });
  fs.writeFileSync(f.modelsJson, '{"providers":{},"external":true}');
  assert.throws(() => write(reopened, { expectedRevision: receipt.revision }), { code: 'config_conflict' });
  assert.equal(reopened.read().config.external, true);
});

test('malformed and unreadable inputs are never overwritten', async t => {
  let denied = false;
  const io = Object.create(fs);
  io.openSync = (...args) => {
    if (denied && args[0] === f.modelsJson) throw Object.assign(new Error('private-path'), { code: 'EACCES' });
    return fs.openSync(...args);
  };
  const f = await fixture(t, { io });
  fs.writeFileSync(f.modelsJson, '{bad');
  assert.throws(() => write(f.store), { code: 'config_invalid' });
  assert.equal(fs.readFileSync(f.modelsJson, 'utf8'), '{bad');
  fs.writeFileSync(f.modelsJson, '{"providers":{}}');
  denied = true;
  assert.throws(() => write(f.store), { code: 'config_unreadable' });
  assert.equal(fs.readFileSync(f.modelsJson, 'utf8'), '{"providers":{}}');
});

test('first-file interruption recovers the same receipt after restart', async t => {
  const f = await fixture(t, { fault(stage) { if (stage === 'after-models') throw new Error('interrupted'); } });
  const request = { requestId: 'interrupted', fingerprint: 'f'.repeat(64) };
  assert.throws(() => write(f.store, request), { code: 'config_recovery_required' });
  assert.equal(fs.existsSync(f.metadataPath), false);
  const recovered = f.open();
  const receipt = write(recovered, request);
  assert.equal(receipt.saved, true);
  assert.equal(recovered.read().metadata.services.fixture.displayName, 'Fixture');
  assert.notEqual(recovered.read().revision, receipt.revision); // A restarted process issues its own opaque revisions.
});

test('recovery leaves an external edit intact and reports the conflict', async t => {
  const f = await fixture(t, { fault(stage) { if (stage === 'after-models') throw new Error('interrupted'); } });
  assert.throws(() => write(f.store), { code: 'config_recovery_required' });
  const external = '{"providers":{},"external":true}';
  fs.writeFileSync(f.modelsJson, external);
  assert.throws(() => f.open().read(), { code: 'config_recovery_required' });
  assert.equal(fs.readFileSync(f.modelsJson, 'utf8'), external);
  assert.equal(fs.existsSync(f.metadataPath), false);
});

test('another GUI process cannot write while a transaction holds the lock', async t => {
  const f = await fixture(t);
  const script = `const {createProviderConfigStore}=await import(process.argv[1]);
    const store=createProviderConfigStore({...JSON.parse(process.argv[2]),fault(stage){
      if(stage===process.argv[3]){process.stdout.write('locked\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15000);}
    }});
    store.transact({apply({config}){config.external='child';return {saved:true};}});`;
  for (const checkpoint of ['before-publish', 'after-recovery-claim']) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, entry, JSON.stringify(f.options), checkpoint], { stdio: ['ignore','pipe','pipe'] });
    const exit = new Promise(resolve => child.once('exit', resolve));
    try {
      await new Promise((resolve, reject) => {
        child.stdout.once('data', resolve);
        child.once('exit', () => reject(new Error('fixture exited before lock')));
      });
      assert.throws(() => write(f.store), { code: 'config_busy' });
    } finally {
      child.kill();
      await exit;
    }
  }
  assert.equal(write(f.open()).saved, true);
});

test('unprotected recovery files cannot publish a forged journal', async t => {
  const f = await fixture(t);
  const transaction = f.modelsJson + '.pi-gui-transaction';
  fs.mkdirSync(transaction, { mode: 0o755 });
  if (process.platform !== 'win32') fs.chmodSync(transaction, 0o755);
  const digest = data => createHash('sha256').update(data).digest('hex');
  const files = { models: f.modelsJson, metadata: f.metadataPath };
  const values = {
    models: { providers: { fixture: { apiKey: '!fixture-must-never-install' } } },
    metadata: { schemaVersion: 1, services: {}, receipts: {} },
  };
  const manifest = { version: 1, installId: randomUUID(), files: {}, entries: {} };
  for (const [key, file] of Object.entries(files)) {
    const data = JSON.stringify(values[key]);
    const s = fs.statSync(path.dirname(file), { bigint: true });
    manifest.files[key] = digest(file);
    manifest.entries[key] = { directory: `${s.dev}:${s.ino}:${s.birthtimeNs}`, before: null, stamp: null, after: digest(data) };
    fs.writeFileSync(path.join(transaction, key + '.after'), data);
  }
  fs.writeFileSync(path.join(transaction, 'journal.json'), JSON.stringify(manifest));
  assert.throws(() => f.open().recoverPending(), { code: 'config_unsafe' });
  assert.equal(fs.existsSync(f.modelsJson), false);
  assert.equal(fs.existsSync(f.metadataPath), false);
});

test('hardlinked models file is rejected', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.modelsJson, '{"providers":{}}');
  fs.linkSync(f.modelsJson, path.join(path.dirname(f.modelsJson), 'other.json'));
  assert.throws(() => write(f.store), { code: 'config_unsafe' });
});
