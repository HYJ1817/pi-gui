'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createSystemStorage } = require('../electron/system-storage-migration.cjs');
const { createStorageFs } = require('../electron/system-storage-fs.cjs');
const { createStorageInventory } = require('../electron/system-storage-inventory.cjs');
const { obtainPiAgentDirectory, BOOT_FILE } = require('../electron/system-storage-policy.cjs');
const { initializeSystemStorage } = require('../electron/system-storage-startup.cjs');
const { REASONS } = require('../electron/system-storage-desktop.cjs');
const { FAILURE_REASONS } = require('../electron/system-storage-boot.cjs');

const ROOT = path.resolve(__dirname, '..');
const STOPPED = { writersStopped: true };
const SECRET = 'storage-final-fixture-secret-do-not-report';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const safeFields = () => ({ ok: true, serviceId: 'fixture', saved: true, credentialSaved: null,
  credentialState: 'none', operationId: null, sync: { state: 'pending', reason: 'runtime_sync_pending' } });
const document = () => ({ schemaVersion: 1, services: { fixture: { providerId: 'fixture', catalogId: 'custom', displayName: '离线供应商',
  kind: 'custom', enabled: true, selectedModelIds: ['model/one'], modelOrder: ['model/one'],
  ownedOverrides: { 'model/one': { name: 'Model One', contextWindow: 32768, maxTokens: 1024, reasoning: true, input: ['text', 'image'] } } } },
  receipts: { 'save-fixture': { fingerprint: hash('request'), result: { ...safeFields(), revision: hash('revision') } } },
  syncRequired: true, syncGeneration: 'sync-generation', syncRemoved: [['fixture', 'removed/model']] });
const succeeds = value => { assert.equal(value.ok, true, value.code); return value; };
function refuses(value, code) {
  assert.equal(value.ok, false);
  assert.equal(value.code, code);
  assert.equal(Object.hasOwn(value, 'ticket'), false);
  assert.equal(JSON.stringify(value).includes(SECRET), false);
  return value;
}

async function fixture(t, { metadata = true } = {}) {
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pi-gui-storage-final-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'), target = path.join(base, 'target'), pi = path.join(base, '.pi', 'agent');
  await Promise.all([source, target, pi].map(directory => fs.mkdir(directory, { recursive: true })));
  const metadataPath = path.join(source, 'provider-management.json'), modelsJson = path.join(pi, 'models.json'), auth = path.join(pi, 'auth.json');
  await fs.writeFile(path.join(source, 'projects.json'), '{"active":"","items":[]}\n');
  await fs.writeFile(modelsJson, json({ providers: { fixture: { baseUrl: 'https://fixture.invalid/v1', apiKey: SECRET,
    models: [{ id: 'model/one', name: 'Model One' }] } } }));
  await fs.writeFile(auth, json({ fixture: { type: 'api_key', key: SECRET } }));
  if (metadata) await fs.writeFile(metadataPath, json(document()));
  const make = options => createSystemStorage({ directory: source, piAgentDirectory: pi, inspectWindows: async () => 'ok', ...options });
  const open = async options => { const core = make(options); succeeds(await core.initialize()); return core; };
  const write = async (relative, value = '', root = source) => {
    const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); return file;
  };
  const provider = async (file = metadataPath) => {
    const { createProviderConfigStore } = await import('../server/provider-config-store.js');
    return createProviderConfigStore({ modelsJson, metadataPath: file });
  };
  return { base, source, target, pi, metadataPath, modelsJson, auth, make, open, write, provider, boot: path.join(source, BOOT_FILE) };
}
async function intent(core, target, arm = true) {
  const preview = succeeds(await core.preview(target));
  const saved = succeeds(await core.commit({ ticket: preview.ticket, confirm: true }));
  assert.equal(saved.state.phase, 'intent');
  if (arm) assert.equal(succeeds(await core.arm({ transactionId: saved.intentId })).state.phase, 'ready');
  return saved.intentId;
}
async function witness(file) { return { bytes: await fs.readFile(file), stat: await fs.stat(file, { bigint: true }) }; }
async function unchanged(file, before) {
  assert.deepEqual(await fs.readFile(file), before.bytes);
  const after = await fs.stat(file, { bigint: true });
  for (const field of ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before.stat[field], field);
}

// The normal case is authored by the real transaction owner, not an invented
// metadata fixture. No credential qualification, real Pi, network, or model.
test('real provider-store metadata cold-migrates byte-exactly; Pi models/auth and source stay at their original authority', async t => {
  const w = await fixture(t, { metadata: false });
  const owner = await w.provider();
  const fields = document();
  owner.transact({ expectedRevision: owner.read().revision, requestId: 'save-fixture', fingerprint: hash('request'), apply({ metadata }) {
    Object.assign(metadata, { services: fields.services, syncRequired: true, syncRemoved: fields.syncRemoved });
    return safeFields();
  } });
  const before = await witness(w.metadataPath), models = await witness(w.modelsJson), auth = await witness(w.auth);
  const actual = JSON.parse(before.bytes);
  assert.equal(actual.schemaVersion, 1); assert.equal(actual.syncRequired, true);
  assert.equal(typeof actual.syncGeneration, 'string'); assert.deepEqual(actual.syncRemoved, fields.syncRemoved);
  assert.equal(Object.keys(actual.receipts).length, 1);
  const core = await w.open();
  const preview = succeeds(await core.preview(w.target));
  assert.ok(preview.summary.included.includes('provider-management.json'));
  assert.equal(preview.summary.files, 2);
  assert.equal(preview.summary.bytes, before.bytes.length + Buffer.byteLength('{"active":"","items":[]}\n'));
  assert.deepEqual(await fs.readdir(w.target), []);
  const saved = succeeds(await core.commit({ ticket: preview.ticket, confirm: true }));
  succeeds(await core.arm({ transactionId: saved.intentId }));
  const cold = await w.open();
  assert.equal(cold.state().dataDirectory, w.source);
  assert.equal(succeeds(await cold.runPendingCold(STOPPED)).state.dataDirectory, w.target);
  const copied = path.join(w.target, 'provider-management.json');
  assert.equal(hash(await fs.readFile(copied)), hash(before.bytes));
  await unchanged(w.metadataPath, before); await unchanged(w.modelsJson, models); await unchanged(w.auth, auth);
  for (const name of ['models.json', 'auth.json', BOOT_FILE]) await assert.rejects(fs.stat(path.join(w.target, name)), { code: 'ENOENT' });
  // Failed new-root startup must not return to the old metadata writer.
  succeeds(await cold.markStarted({ transactionId: saved.intentId, dataDirectory: w.target, ok: false }));
  const reopened = await w.open();
  assert.equal(reopened.state().dataDirectory, w.target); assert.equal(reopened.state().reason, 'start_failed');
  const movedOwner = await w.provider(copied);
  assert.deepEqual(movedOwner.read().metadata, actual);
  movedOwner.transact({ expectedRevision: movedOwner.read().revision, apply({ metadata }) {
    metadata.services.fixture.displayName = 'Only the new root writes'; return safeFields();
  } });
  assert.equal((await w.open()).state().dataDirectory, w.target);
  assert.equal(movedOwner.read().metadata.services.fixture.displayName, 'Only the new root writes');
  await unchanged(w.metadataPath, before); await unchanged(w.modelsJson, models); await unchanged(w.auth, auth);
  t.diagnostic(`owner metadata ${before.bytes.length} bytes; source/target SHA-256 ${hash(before.bytes)}; Pi models/auth unchanged`);
});

test('unarmed metadata intent and interrupted cold copy never select two metadata writers', async t => {
  for (const armed of [false, true]) await t.test(armed ? 'copy failure' : 'unarmed intent', async sub => {
    const w = await fixture(sub), original = await witness(w.metadataPath);
    const core = await w.open({ hook: point => { if (armed && point === 'after_copy') throw Error(SECRET); } });
    await intent(core, w.target, armed);
    const result = refuses(await core.runPendingCold(STOPPED), armed ? 'copy_failed' : 'shutdown_unconfirmed');
    assert.equal(result.state.dataDirectory, w.source);
    const reopened = await w.open();
    assert.equal(reopened.state().dataDirectory, w.source); assert.equal(reopened.state().phase, 'failed');
    succeeds(await reopened.runPendingCold(STOPPED));
    await unchanged(w.metadataPath, original);
    if (!armed) assert.deepEqual(await fs.readdir(w.target), []);
    else assert.equal(hash(await fs.readFile(path.join(w.target, 'provider-management.json'))), hash(original.bytes));
  });
});

test('real prepared, dispatching, finished and authGeneration ledgers all block relocation without ledger edits', async t => {
  for (const phase of ['prepared', 'dispatching', 'finished', 'authGeneration']) await t.test(phase, async sub => {
    const w = await fixture(sub, { metadata: false }), owner = await w.provider();
    if (phase === 'authGeneration') {
      const release = owner.acquireOAuthWrite('fixture'); release(true, true);
    } else await owner.withCredentialOperation(async operation => {
      operation.prepare({ requestId: 'credential-fixture', fingerprint: hash('credential'), providerId: 'fixture', action: 'apply-staged' });
      if (phase !== 'prepared') {
        operation.transact({ requestId: 'credential-fixture', fingerprint: hash('credential'), apply() { return safeFields(); } });
        operation.dispatch('credential-fixture');
        if (phase === 'finished') operation.finish('credential-fixture', 'saved');
      }
    });
    const file = w.modelsJson + '.pi-gui-operations.json', ledger = await witness(file);
    const models = await witness(w.modelsJson), auth = await witness(w.auth);
    const value = JSON.parse(ledger.bytes);
    assert.equal(value.authority, hash(JSON.stringify({ models: w.modelsJson, metadata: w.metadataPath })));
    if (phase === 'authGeneration') { assert.equal(typeof value.authGeneration, 'string'); assert.deepEqual(value.operations, []); }
    else assert.equal(value.operations[0].phase, phase);
    refuses(await (await w.open()).preview(w.target), 'provider_authority_present');
    assert.deepEqual(await fs.readdir(w.target), []);
    await unchanged(file, ledger); await unchanged(w.modelsJson, models); await unchanged(w.auth, auth);
    await assert.rejects(fs.stat(w.boot), { code: 'ENOENT' });
  });
});

test('Pi lock and transaction block even when empty; a late ledger is rechecked at confirmation and cold start', async t => {
  for (const suffix of ['.pi-gui-lock', '.pi-gui-transaction']) await t.test(suffix, async sub => {
    const w = await fixture(sub), file = w.modelsJson + suffix;
    if (suffix.endsWith('transaction')) await fs.mkdir(file); else await fs.writeFile(file, '');
    refuses(await (await w.open()).preview(w.target), 'provider_authority_present');
    assert.deepEqual(await fs.readdir(w.target), []); assert.ok(await fs.lstat(file));
  });
  for (const cold of [false, true]) await t.test(cold ? 'cold ledger appearance' : 'confirmation ledger appearance', async sub => {
    const w = await fixture(sub), core = await w.open();
    const preview = succeeds(await core.preview(w.target));
    if (cold) {
      const saved = succeeds(await core.commit({ ticket: preview.ticket, confirm: true }));
      succeeds(await core.arm({ transactionId: saved.intentId }));
    }
    const ledger = await w.write('models.json.pi-gui-operations.json', SECRET, w.pi);
    const before = await witness(ledger);
    refuses(cold ? await core.runPendingCold(STOPPED) : await core.commit({ ticket: preview.ticket, confirm: true }), 'provider_authority_present');
    assert.deepEqual(await fs.readdir(w.target), []); await unchanged(ledger, before);
    assert.equal((await w.open()).state().dataDirectory, w.source);
  });
});

test('shared metadata schema rejects unknown fields/secrets and digest arrays; migration rejects duplicate JSON without changing store layout compatibility', async t => {
  const changes = [
    ['future schema', doc => { doc.schemaVersion = 2; }, 'provider_metadata_unsupported'],
    ['unknown root secret', doc => { doc.apiKey = SECRET; }, 'provider_metadata_unsupported'],
    ['service secret', doc => { doc.services.fixture.apiKey = SECRET; }, 'provider_metadata_invalid'],
    ['model secret', doc => { doc.services.fixture.ownedOverrides['model/one'].apiKey = SECRET; }, 'provider_metadata_invalid'],
    ['receipt secret', doc => { doc.receipts['save-fixture'].result.apiKey = SECRET; }, 'provider_metadata_invalid'],
    ['sync secret', doc => { doc.receipts['save-fixture'].result.sync.token = SECRET; }, 'provider_metadata_invalid'],
    ['fingerprint array', doc => { doc.receipts['save-fixture'].fingerprint = [hash('request')]; }, 'provider_metadata_invalid'],
    ['revision array', doc => { doc.receipts['save-fixture'].result.revision = [hash('revision')]; }, 'provider_metadata_invalid'],
    ['services array', doc => { doc.services = []; }, 'provider_metadata_invalid'],
    ['receipts array', doc => { doc.receipts = []; }, 'provider_metadata_invalid'],
    ['invalid provider id', doc => { doc.services['..'] = {}; }, 'provider_metadata_invalid'],
    ['invalid model field', doc => { doc.services.fixture.ownedOverrides['model/one'].input = ['audio']; }, 'provider_metadata_invalid'],
    ['invalid sync flag', doc => { doc.syncRequired = 'true'; }, 'provider_metadata_invalid'],
    ['invalid removed tuple', doc => { doc.syncRemoved = [['fixture', 'model', SECRET]]; }, 'provider_metadata_invalid'],
  ];
  for (const [name, change, code] of changes) await t.test(name, async sub => {
    const w = await fixture(sub), doc = document(); change(doc); await fs.writeFile(w.metadataPath, json(doc));
    const before = await witness(w.metadataPath), owner = await w.provider();
    assert.throws(() => owner.read(), { code: code === 'provider_metadata_unsupported' ? 'config_unsupported' : 'config_invalid' });
    refuses(await (await w.open()).preview(w.target), code);
    await unchanged(w.metadataPath, before); assert.deepEqual(await fs.readdir(w.target), []);
  });
  for (const [name, bytes] of [
    ['duplicate root schema', '{\n  "schemaVersion": 2,\n  "schemaVersion": 1,\n  "services": {},\n  "receipts": {}\n}\n'],
    ['duplicate root hiding secret', `{\n  "schemaVersion": 1,\n  "services": {"hidden":{"apiKey":"${SECRET}"}},\n  "services": {},\n  "receipts": {}\n}\n`],
    ['duplicate nested field', json(document()).toString().replace('"displayName":', `"displayName": "${SECRET}",\n      "displayName":`)],
    ['minified supported store data', JSON.stringify(document())],
  ]) await t.test(name, async sub => {
    const w = await fixture(sub); await fs.writeFile(w.metadataPath, bytes);
    // The store's existing parsing compatibility is deliberately unchanged.
    assert.equal((await w.provider()).read().metadata.schemaVersion, 1);
    const before = await witness(w.metadataPath);
    refuses(await (await w.open()).preview(w.target), 'provider_metadata_format_unsupported');
    await unchanged(w.metadataPath, before); assert.deepEqual(await fs.readdir(w.target), []);
  });
});

test('metadata uses the inventory readBound buffer once, has a 16 MiB limit, and rejects invalid UTF-8', async t => {
  const w = await fixture(t);
  let reads = 0;
  const core = await w.open({ io: { open: async (file, ...args) => {
    if (file === w.metadataPath) reads++;
    return fs.open(file, ...args);
  }, readFile: async () => assert.fail('migration facts must not independently reopen metadata') } });
  succeeds(await core.preview(w.target)); assert.equal(reads, 1);
  await fs.writeFile(w.metadataPath, Buffer.alloc(16 * 1024 ** 2 + 1));
  refuses(await core.preview(w.target), 'inventory_limit'); assert.equal(reads, 1);
  await fs.writeFile(w.metadataPath, Buffer.from([0xff, 0xfe, 0x7b]));
  refuses(await core.preview(w.target), 'provider_metadata_invalid');
  assert.deepEqual(await fs.readdir(w.target), []);
});

test('metadata identity changes during read, after preview and after copy cannot publish a new root', async t => {
  for (const phase of ['read', 'confirmation', 'copied-target']) await t.test(phase, async sub => {
    const w = await fixture(sub), original = await fs.readFile(w.metadataPath);
    let replaced = false;
    const replace = async file => {
      await fs.rename(file, path.join(w.base, 'retained-original'));
      await fs.writeFile(file, original); replaced = true;
    };
    const core = await w.open(phase === 'read' ? { io: { open: async (file, ...args) => {
      const handle = await fs.open(file, ...args);
      if (file !== w.metadataPath) return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === 'read') return async (...readArgs) => { const result = await target.read(...readArgs); if (!replaced) await replace(file); return result; };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
    } } } : { hook: async point => { if (phase === 'copied-target' && point === 'after_copy') await replace(path.join(w.target, 'provider-management.json')); } });
    if (phase === 'read') refuses(await core.preview(w.target), 'inventory_changed');
    else if (phase === 'confirmation') {
      const preview = succeeds(await core.preview(w.target)); await replace(w.metadataPath);
      refuses(await core.commit({ ticket: preview.ticket, confirm: true }), 'source_changed');
    } else {
      await intent(core, w.target);
      refuses(await core.runPendingCold(STOPPED), 'verification_failed');
    }
    assert.equal(replaced, true); assert.equal((await w.open()).state().dataDirectory, w.source);
    assert.equal(hash(await fs.readFile(w.metadataPath)), hash(original));
    if (phase !== 'copied-target') assert.deepEqual(await fs.readdir(w.target), []);
  });
});

test('only physically empty worktree/candidate skeletons are excluded; exact empty manifest bytes are copied', async t => {
  const w = await fixture(t);
  const skeletons = ['worktrees', `worktrees/${'a'.repeat(24)}`, `worktrees/${'b'.repeat(24)}`, 'candidate-runs', 'candidate-transactions', 'revert-evidence/v1/objects'];
  for (const relative of skeletons) await fs.mkdir(path.join(w.source, relative), { recursive: true });
  const manifest = Buffer.from('{ "entries": [ ],\n "version": 1 }\n');
  await w.write('worktrees.json', manifest);
  const inspected = new Set();
  const core = await w.open({ inspectWindows: async entries => { for (const entry of entries) inspected.add(entry.path); return 'ok'; } });
  const preview = succeeds(await core.preview(w.target));
  assert.equal(preview.summary.files, 3); assert.equal(preview.summary.directories, 0);
  assert.ok(preview.summary.included.includes('worktrees.json'));
  if (process.platform === 'win32') for (const relative of skeletons) assert.ok(inspected.has(path.join(w.source, relative)), relative);
  await intent(core, w.target); succeeds(await core.runPendingCold(STOPPED));
  assert.deepEqual(await fs.readFile(path.join(w.target, 'worktrees.json')), manifest);
  for (const relative of ['worktrees', 'candidate-runs', 'candidate-transactions', 'revert-evidence']) {
    assert.ok((await fs.stat(path.join(w.source, relative))).isDirectory());
    await assert.rejects(fs.stat(path.join(w.target, relative)), { code: 'ENOENT' });
  }
});

test('worktree/candidate/review/revert records and unknown descendants remain fail-closed, including zero-byte evidence', async t => {
  const uuid = '01010101-0101-4101-8101-010101010101', repo = 'a'.repeat(24);
  const cases = [
    ['worktree UUID', `worktrees/${repo}/${uuid}`, null],
    ['unexpected direct UUID', `worktrees/${uuid}`, null],
    ['unknown worktree name', 'worktrees/unknown', null],
    ['worktree lock', `worktrees/${repo}/.lock`, ''],
    ['worktree git registration', `worktrees/${repo}/.git`, SECRET],
    ['candidate run UUID', `candidate-runs/${uuid}`, null],
    ['candidate lock', 'candidate-runs/.lock', ''],
    ['candidate unknown file', 'candidate-runs/unknown', ''],
    ['transaction UUID', `candidate-transactions/${uuid}`, null],
    ['transaction lock', 'candidate-transactions/execute.lock', ''],
    ['future manifest', 'worktrees.json', '{"version":2,"entries":[]}'],
    ['active manifest', 'worktrees.json', '{"version":1,"entries":[{"id":"active"}]}'],
    ['history manifest', 'worktrees.json', '{"version":1,"entries":[{"removed":true}]}'],
    ['unknown manifest field', 'worktrees.json', '{"version":1,"entries":[],"unknown":true}'],
    ['duplicate manifest entries', 'worktrees.json', '{"version":1,"entries":[{"id":"history"}],"entries":[]}'],
    ['review root', 'review-evidence', null, 'revert_evidence_present'],
    ['zero-byte journal', 'revert-evidence/v1/journal.jsonl', '', 'revert_evidence_present'],
    ['zero-byte object', 'revert-evidence/v1/objects/object', '', 'revert_evidence_present'],
  ];
  for (const [name, relative, value, code = 'worktree_or_candidate_present'] of cases) await t.test(name, async sub => {
    const w = await fixture(sub);
    if (value === null) await fs.mkdir(path.join(w.source, relative), { recursive: true }); else await w.write(relative, value);
    refuses(await (await w.open()).preview(w.target), code);
    assert.deepEqual(await fs.readdir(w.target), []); assert.ok(await fs.lstat(path.join(w.source, relative)));
    await assert.rejects(fs.stat(w.boot), { code: 'ENOENT' });
  });
});

test('empty skeleton exclusion still checks links, volume, parent identity and per-directory native inspection', async t => {
  for (const mode of ['link', 'volume', 'identity', ...(process.platform === 'win32' ? ['native'] : [])]) await t.test(mode, async sub => {
    const w = await fixture(sub), skeleton = path.join(w.source, 'candidate-runs');
    if (mode === 'link') await fs.symlink(w.target, skeleton, process.platform === 'win32' ? 'junction' : 'dir');
    else await fs.mkdir(skeleton);
    let changed = false;
    const core = await w.open({
      io: mode === 'volume' ? { lstat: async (file, ...args) => {
        const stat = await fs.lstat(file, ...args);
        if (file !== skeleton) return stat;
        return new Proxy(stat, { get(target, key) { const value = key === 'dev' ? target.dev + 1n : target[key]; return typeof value === 'function' ? value.bind(target) : value; } });
      } } : mode === 'identity' ? { opendir: async (file, ...args) => {
        const cursor = await fs.opendir(file, ...args);
        if (file !== skeleton) return cursor;
        return { read: () => cursor.read(), close: async () => {
          await cursor.close();
          if (!changed) { await fs.rename(file, path.join(w.base, 'retained-skeleton')); await fs.mkdir(file); changed = true; }
        } };
      } } : undefined,
      inspectWindows: async entries => mode === 'native' && entries.some(entry => entry.path === skeleton) ? 'unsafe' : 'ok',
    });
    refuses(await core.preview(w.target), mode === 'identity' ? 'path_changed' : 'unsafe_entry');
    if (mode === 'identity') assert.equal(changed, true);
    assert.deepEqual(await fs.readdir(w.target), []);
  });
});

test('relative Pi override never reads a cwd-guessed agent; idle startup and explicit data override remain usable', async t => {
  const w = await fixture(t);
  const relative = 'different-backend-cwd/agent';
  const reads = [];
  const core = await w.open({ piAgentDirectory: relative, io: { lstat: async (file, ...args) => { reads.push(file); return fs.lstat(file, ...args); } } });
  refuses(await core.preview(w.target), 'pi_agent_path_relative');
  assert.equal(reads.some(file => file.includes('different-backend-cwd')), false);
  assert.equal(core.state().dataDirectory, w.source); assert.deepEqual(await fs.readdir(w.target), []);
  assert.throws(() => obtainPiAgentDirectory(relative), { code: 'pi_agent_path_relative' });
  assert.equal(obtainPiAgentDirectory('~/.pi/agent'), path.join(os.homedir(), '.pi', 'agent'));
  assert.equal(obtainPiAgentDirectory(w.pi), w.pi);
  if (process.platform === 'win32') for (const value of ['C:agent', '/agent', '\\agent']) assert.throws(() => obtainPiAgentDirectory(value), { code: 'pi_agent_path_relative' });
  const startup = await initializeSystemStorage({ directory: w.source, appRoot: path.join(w.base, 'app'), executable: path.join(w.base, 'app', 'app.exe'),
    env: { PI_CODING_AGENT_DIR: relative }, probe: () => assert.fail('idle startup does not probe') });
  assert.equal(startup.dataDirectory, w.source);
  refuses(await startup.storage.preview(w.target), 'pi_agent_path_relative');
  const explicit = await initializeSystemStorage({ directory: w.source, appRoot: path.join(w.base, 'app'), executable: path.join(w.base, 'app', 'app.exe'),
    env: { PI_GUI_DATA: w.target, PI_CODING_AGENT_DIR: relative }, probe: () => assert.fail('override does not probe') });
  assert.equal(explicit.dataDirectory, w.target); assert.equal(explicit.source, 'environment');
});

test('relative Pi override permits an identity-bound managed startup but still rejects a new migration', async t => {
  const w = await fixture(t), runtimeDirectory = path.join(w.source, 'runtime');
  const core = await w.open({ runtimeDirectory });
  const id = await intent(core, w.target);
  succeeds(await core.runPendingCold(STOPPED));
  succeeds(await core.markStarted({ transactionId: id, dataDirectory: w.target, ok: true }));
  const before = await witness(w.boot), reads = [];
  const relative = 'different-backend-cwd/agent';
  const reopened = await w.open({ runtimeDirectory, piAgentDirectory: relative,
    io: { lstat: async (file, ...args) => { reads.push(file); return fs.lstat(file, ...args); } } });
  assert.equal(reopened.state().source, 'managed'); assert.equal(reopened.state().dataDirectory, w.target);
  succeeds(await reopened.runPendingCold(STOPPED));
  const next = path.join(w.base, 'next-target'); await fs.mkdir(next);
  refuses(await reopened.preview(next), 'pi_agent_path_relative');
  assert.equal(reads.some(file => file.includes('different-backend-cwd')), false);
  const started = await initializeSystemStorage({ directory: w.source, appRoot: path.join(w.base, 'app'),
    executable: path.join(w.base, 'app', 'app.exe'), env: { PI_CODING_AGENT_DIR: relative },
    probe: () => assert.fail('active managed startup does not probe') });
  assert.equal(started.source, 'managed'); assert.equal(started.dataDirectory, w.target);
  assert.deepEqual(await fs.readdir(next), []); await unchanged(w.boot, before);
  const overlap = w.make({ runtimeDirectory, piAgentDirectory: w.target });
  refuses(await overlap.initialize(), 'protected_overlap');
});

test('new migration refusal codes persist in boot and project actionable messages without payloads', async t => {
  for (const code of ['provider_metadata_invalid', 'provider_metadata_unsupported', 'provider_metadata_format_unsupported', 'provider_metadata_unavailable', 'pi_agent_path_relative']) {
    assert.ok(FAILURE_REASONS.has(code)); assert.equal(typeof REASONS[code], 'string'); assert.ok(REASONS[code].length > 15);
  }
  assert.match(REASONS.provider_authority_present, /勿删除或修改账本/);
  assert.match(REASONS.pi_agent_path_relative, /绝对路径/);
  for (const code of ['provider_metadata_invalid', 'provider_metadata_unsupported', 'provider_metadata_format_unsupported', 'pi_agent_path_relative']) await t.test(code, async sub => {
    const w = await fixture(sub), core = await w.open(); await intent(core, w.target);
    if (code === 'provider_metadata_invalid') await fs.writeFile(w.metadataPath, SECRET);
    if (code === 'provider_metadata_unsupported') await fs.writeFile(w.metadataPath, json({ ...document(), schemaVersion: 2 }));
    if (code === 'provider_metadata_format_unsupported') await fs.writeFile(w.metadataPath, JSON.stringify(document()));
    const cold = await w.open(code === 'pi_agent_path_relative' ? { piAgentDirectory: './agent' } : {});
    const result = refuses(await cold.runPendingCold(STOPPED), code);
    assert.equal(result.state.reason, code); assert.equal(result.state.dataDirectory, w.source);
    const recorded = JSON.parse(await fs.readFile(w.boot, 'utf8'));
    assert.equal(recorded.transaction.phase, 'failed'); assert.equal(recorded.transaction.reason, code); assert.equal(recorded.managed, null);
    assert.equal(JSON.stringify(recorded).includes(SECRET), false);
    assert.equal((await w.open()).state().reason, code); assert.deepEqual(await fs.readdir(w.target), []);
  });
});

test('packaged policy loads generated CJS schema with no source tree and preserves shared validation', async t => {
  const w = await fixture(t), stage = path.join(w.base, 'packaged-app'); await fs.mkdir(stage);
  const esbuild = require('esbuild');
  const bundle = esbuild.buildSync({ entryPoints: [path.join(ROOT, 'lib/provider-management-metadata.mjs')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false });
  const resource = path.join(stage, 'provider-management-metadata.cjs'); await fs.writeFile(resource, bundle.outputFiles[0].contents);
  for (const name of ['system-storage-policy.cjs', 'system-storage-fs.cjs', 'system-storage-windows.cjs']) await fs.copyFile(path.join(ROOT, 'electron', name), path.join(stage, name));
  const schema = require(resource), esm = await import(pathToFileURL(path.join(ROOT, 'lib/provider-management-metadata.mjs')).href);
  assert.deepEqual(schema.defaultMetadata(), esm.defaultMetadata());
  const valid = document(); schema.validateMetadata(valid); esm.validateMetadata(valid);
  valid.receipts['save-fixture'].fingerprint = [hash('request')];
  for (const validator of [schema.validateMetadata, esm.validateMetadata]) assert.throws(() => validator(valid), { code: 'config_invalid' });
  const storage = createStorageFs({ inspectWindows: async () => 'ok' });
  const facts = await createStorageInventory(storage).scan(await storage.directory(w.source));
  const options = { storage, anchor: w.source, legacy: w.source, piAgent: w.pi, protectedRoots: [], getProtectedRoots: () => [], runtimeDirectory: null };
  await require(path.join(stage, 'system-storage-policy.cjs')).createStoragePolicy(options).verifyBusiness(w.source, w.target, facts);
  // A missing generated resource cannot silently accept unvalidated metadata.
  await fs.unlink(resource);
  delete require.cache[require.resolve(resource)]; delete require.cache[require.resolve(path.join(stage, 'system-storage-policy.cjs'))];
  await assert.rejects(require(path.join(stage, 'system-storage-policy.cjs')).createStoragePolicy(options).verifyBusiness(w.source, w.target, facts), { code: 'provider_metadata_unavailable' });
  t.diagnostic(`generated standalone metadata CJS ${bundle.outputFiles[0].contents.length} bytes; no packaged ESM tree required`);
});
