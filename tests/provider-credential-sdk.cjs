const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const { Worker } = require('node:worker_threads');

const fakeSdk = String.raw`
import fs from 'node:fs';
export class CredentialSynchronizationError extends Error {
  constructor(credential) { super(credential.key); this.credential = credential; this.cause = { raw: credential.key }; }
}
export function readStoredCredential(id, authPath) {
  try { return JSON.parse(fs.readFileSync(authPath, 'utf8'))[id]; } catch { return undefined; }
}
export class ModelRuntime {
  static async create(opts) {
    if (opts.allowModelNetwork !== false || opts.refreshOnCreate !== false || process.env.PI_GUI_TOKEN) throw new Error('invalid fixture isolation');
    return new ModelRuntime(opts);
  }
  constructor({ credentials, authPath, modelsPath }) {
    this.credentials = credentials; this.authPath = authPath; this.ids = new Set(['builtin-fixture']);
    if (modelsPath) {
      const models = fs.readFileSync(modelsPath, 'utf8');
      if (models.includes('apiKey') || models.includes('headers')) throw new Error('unsafe registration');
      for (const id of Object.keys(JSON.parse(models).providers)) this.ids.add(id);
    }
  }
  getProviders() { return [...this.ids].map(id => ({ id, auth: { apiKey: { login() {} } } })); }
  registerProvider(id, options) {
    if (!this.credentials || !options.baseUrl || !Array.isArray(options.models)) throw new Error('invalid provider registration');
    this.ids.add(id);
  }
  read() { try { return JSON.parse(fs.readFileSync(this.authPath, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } }
  async listCredentials(opts) {
    opts?.signal?.throwIfAborted();
    if (this.credentials) return this.credentials.list(opts);
    return Object.entries(this.read()).map(([providerId, c]) => ({ providerId, type: c.type }));
  }
  async login(id, type, interaction) {
    if (type !== 'api_key' || !this.ids.has(id)) throw new Error('wrong login');
    const key = await interaction.prompt({ type: 'secret', signal: interaction.signal });
    const credential = { type, key };
    interaction.signal.throwIfAborted();
    if (this.credentials) await this.credentials.modify(id, () => credential, { signal: interaction.signal });
    else {
      if (key === 'fixture-write-fails') throw new Error(key);
      if (key === 'fixture-cooperative-stop') {
        fs.writeFileSync(this.authPath + '.entered', 'fixture');
        await new Promise(resolve => interaction.signal.addEventListener('abort', resolve, { once: true }));
        interaction.signal.throwIfAborted();
      }
      const data = this.read(); data[id] = credential;
      fs.writeFileSync(this.authPath, JSON.stringify(data), { mode: 0o600 });
      if (key === 'fixture-saved-sync-error') throw new CredentialSynchronizationError(credential);
    }
    return credential;
  }
  async logout(id, options) {
    options.signal.throwIfAborted();
    const data = this.read(); delete data[id]; fs.writeFileSync(this.authPath, JSON.stringify(data));
  }
  async getAuth() { throw new Error('default credential resolver is forbidden'); }
}
`;
const binding = { draftId: 'draft-a', providerId: 'fixture', connectionRevision: 1,
  connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions' } };
async function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-sdk-'));
  const pkg = path.join(root, 'pi');
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.5.0', exports: { '.': { import: './sdk.mjs' } } }));
  fs.writeFileSync(path.join(pkg, 'sdk.mjs'), fakeSdk);
  const authPath = path.join(root, 'auth.json');
  const { createProviderCredentialSdk } = await import('../server/provider-credential-sdk.js');
  const sdk = createProviderCredentialSdk({ resolvePackageDir: () => pkg, identityKey: () => 'fixture-install', authPath,
    env: { ...process.env, PI_GUI_TOKEN: 'must-not-reach-worker' }, enabled: true, authorizeStorage: () => true, ...overrides });
  t.after(async () => { await sdk.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { sdk, authPath };
}
async function stage(sdk, key, context = binding, confirmOAuthReplacement = false) {
  const state = await sdk.inspect(context.providerId);
  return sdk.stageNativeLogin(context, key, { expectedCredentialRevision: state.credentialRevision, confirmOAuthReplacement });
}

test('the private discovery worker admits no requester after revocation even if its cancel frame is delayed', async t => {
  const counts = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
  const testModule = String.raw`
import dns from 'node:dns';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { workerData } from 'node:worker_threads';
const { counts, workerEntry } = workerData;
dns.promises.lookup = async () => {
  Atomics.add(counts, 0, 1);
  Atomics.notify(counts, 0);
  await Atomics.waitAsync(counts, 2, 0).value;
  return [{ address: '93.184.216.34' }];
};
https.request = options => {
  Atomics.add(counts, 1, 1);
  if (options.headers.authorization === 'Bearer synthetic-private-discovery') Atomics.store(counts, 3, 1);
  const req = new EventEmitter();
  req.end = () => queueMicrotask(() => {
    const res = new EventEmitter();
    Object.assign(res, { statusCode: 200, headers: {}, destroy() {} });
    req.emit('response', res);
    res.emit('data', Buffer.from(JSON.stringify({data:[{id:'fixture-model',object:'model',created:1,owned_by:'fixture'}]})));
    res.emit('end');
  });
  return req;
};
await import(workerEntry);
`;
  const { sdk, authPath } = await setup(t, { workerFactory(entry, options) {
    const worker = new Worker(new URL(`data:text/javascript;base64,${Buffer.from(testModule).toString('base64')}`),
      { ...options, workerData: { ...options.workerData, counts, workerEntry: entry.href } });
    const send = worker.postMessage.bind(worker);
    worker.postMessage = message => { if (message.action !== 'cancel-discovery') send(message); };
    return worker;
  } });
  const { createDiscoveryConsentStore } = await import('../server/provider-discovery-consent.js');
  const consents = createDiscoveryConsentStore({ strict: true });
  t.after(() => consents.dispose());
  const staged = await stage(sdk, 'synthetic-private-discovery');
  const issued = consents.issue({ ...binding, draftRevision: 1, api: binding.connection.api, credentialSource: 'staged',
    credentialRevision: staged.stagedRevision, workerEpoch: staged.workerEpoch });
  assert.equal(issued.ok, true);
  const grant = consents.get(issued.consentId);
  Atomics.store(counts, 2, 1);
  const first = await sdk.discoverNative(binding, grant, { deadline: performance.now() + 5000 });
  assert.deepEqual(first.models, [{ id: 'fixture-model' }]);
  assert.equal(Atomics.load(counts, 3), 1);
  assert.ok(!JSON.stringify(first).includes('synthetic-private-discovery'));
  Atomics.store(counts, 2, 0);
  const abort = new AbortController();
  const pending = sdk.discoverNative(binding, grant, { deadline: performance.now() + 5000, signal: abort.signal });
  await Atomics.waitAsync(counts, 0, 1, 3000).value;
  assert.equal(Atomics.load(counts, 0), 2);
  abort.abort();
  Atomics.store(counts, 2, 1);
  Atomics.notify(counts, 2);
  assert.equal((await pending).code, 'invalid_target');
  assert.equal(Atomics.load(counts, 1), 1);

  const writeFixture = key => fs.writeFileSync(authPath, JSON.stringify({ fixture: { type: 'api_key', key } }), { mode: 0o600 });
  for (const expression of ['$FAKE_KEY', '!fixture-command']) {
    writeFixture(expression);
    const observed = await sdk.inspectDiscovery(binding.providerId);
    assert.equal(observed.present, true);
    assert.equal(observed.literal, false);
    assert.equal(Object.hasOwn(observed, 'key'), false);
  }
  writeFixture('synthetic-private-discovery');
  const stored = await sdk.inspectDiscovery(binding.providerId);
  assert.equal(stored.literal, true);
  const storedGrant = consents.get(consents.issue({ ...binding, draftRevision: 1, api: binding.connection.api, credentialSource: 'stored',
    credentialRevision: stored.credentialRevision, workerEpoch: stored.workerEpoch }).consentId);
  assert.deepEqual((await sdk.discoverNative(binding, storedGrant, { deadline: performance.now() + 5000 })).models, first.models);
  Atomics.store(counts, 2, 0);
  const beforeRotation = sdk.discoverNative(binding, storedGrant, { deadline: performance.now() + 5000 });
  await Atomics.waitAsync(counts, 0, 3, 3000).value;
  assert.equal(Atomics.load(counts, 0), 4);
  writeFixture('synthetic-replacement-after-dns');
  Atomics.store(counts, 2, 1);
  Atomics.notify(counts, 2);
  assert.equal((await beforeRotation).code, 'invalid_target');
  await sdk.dispose();
  assert.equal((await sdk.discoverNative(binding, storedGrant, { deadline: performance.now() + 5000 })).code, 'invalid_target');
  assert.equal(Atomics.load(counts, 1), 2);
});

test('commit can use only the exact private stage generation, including clear', async t => {
  const { sdk, authPath } = await setup(t);
  const first = await stage(sdk, 'first-fixture');
  const latest = await stage(sdk, 'second-fixture');
  assert.equal((await sdk.persistNative(binding, first.stagedRevision)).code, 'credential_conflict');
  assert.equal(fs.existsSync(authPath), false);
  assert.equal((await sdk.persistNative(binding, latest.stagedRevision)).credentialSaved, true);
  const observed = await sdk.inspect(binding.providerId);
  const cleared = await sdk.stageClear(binding, { confirmed: true, expectedCredentialRevision: observed.credentialRevision });
  assert.match(cleared.stagedRevision, /^[a-f0-9-]{36}$/);
  assert.equal((await sdk.clearNative(binding, latest.stagedRevision)).code, 'credential_conflict');
  assert.equal((await sdk.clearNative(binding, cleared.stagedRevision)).credentialState, 'cleared');
});

test('a cancelled native worker reports uncertainty before its matching stop proof', async t => {
  const { sdk, authPath } = await setup(t);
  const staged = await stage(sdk, 'fixture-cooperative-stop');
  const cancellation = new AbortController();
  let acknowledge;
  const quiesced = new Promise(resolve => { acknowledge = resolve; });
  const result = sdk.persistNative(binding, staged.stagedRevision, { signal: cancellation.signal, onQuiesced: acknowledge });
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(authPath + '.entered') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(authPath + '.entered'), true);
  cancellation.abort();
  assert.equal((await result).credentialSaved, null);
  let timer;
  try {
    await Promise.race([quiesced, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('missing stop proof')), 3000); })]);
  } finally { clearTimeout(timer); }
  assert.equal(fs.existsSync(authPath), false);
});

test('private bridge staging reaches config-first save and clear through the real SDK worker fixture', async t => {
  const { sdk, authPath } = await setup(t);
  const { createProviderCredentialBridge } = await import('../server/provider-credential-bridge.js');
  const { createProviderManagement } = await import('../server/provider-management.js');
  const { createProviderConfigStore } = await import('../server/provider-config-store.js');
  const folder = path.dirname(authPath);
  const modelsJson = path.join(folder, 'models.json');
  const metadataPath = path.join(folder, 'provider-management.json');
  const store = createProviderConfigStore({ modelsJson, metadataPath });
  const management = createProviderManagement({ store, enabled: true, inspectCredential: sdk.inspect,
    nativeCredentials: { authorize: (...args) => bridge.authorizeNative(...args), persist: (...args) => bridge.persistApproved(...args) } });
  const bridge = createProviderCredentialBridge({ sdk, draftLookup: management.draftSnapshot, draftFrozen: management.draftFrozen,
    nativePersistence: () => true, enabled: true });
  const frame = { type: 'provider-credential', backendEpoch: bridge.epoch, requestId: 'fixture' };
  const post = (route, value) => new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(value))]);
    req.method = 'POST';
    management.handle(req, { writeHead() {}, end(body) { resolve(JSON.parse(body)); } },
      new URL(`/api/provider-management/${route}`, 'http://localhost')).catch(reject);
  });
  const createDraft = (id, serviceId) => post('drafts', { requestId: id, expectedRevision: store.read().revision, serviceId,
    draft: { providerId: 'fixture', authMode: 'pi-credential', displayName: 'Fixture', connection: binding.connection,
      modelPatches: [], selectedModelIds: [], modelOrder: [], enabled: true } });
  const prepare = (draft, purpose) => bridge.handle({ ...frame, action: 'prepare', purpose, draftId: draft.draftId, draftRevision: draft.draftRevision });
  const submit = (response, payload) => bridge.handle({ ...frame, flowId: response.flowId, promptId: response.promptId, nonce: response.nonce, ...payload });
  const commit = (draft, action, type, serviceId) => post('commit', { requestId: `commit-${type}`, action, serviceId,
    expectedRevision: store.read().revision, draftId: draft.draftId, draftRevision: draft.draftRevision, credentialAction: { type } });

  const created = await createDraft('create-draft');
  const secret = 'only-the-fake-sdk-stores-this-fixture';
  const staged = await submit(await prepare(created, 'set'), { action: 'stage', input: secret, allowDiscovery: false, rememberTarget: false });
  assert.equal(staged.credentialState, 'staged');
  assert.equal(fs.existsSync(authPath), false);
  const saved = await commit(created, 'create', 'apply-staged');
  assert.equal(saved.credentialSaved, true);
  assert.equal(saved.sync.state, 'pending');
  assert.equal(JSON.parse(fs.readFileSync(authPath)).fixture.key, secret);
  assert.ok(!JSON.stringify(saved).includes(secret));
  for (const file of [modelsJson, metadataPath, modelsJson + '.pi-gui-operations.json']) assert.ok(!fs.readFileSync(file, 'utf8').includes(secret));

  const clearDraft = await createDraft('clear-draft', 'fixture');
  assert.equal((await submit(await prepare(clearDraft, 'clear'), { action: 'clear-stage', confirmed: true })).credentialState, 'clear-staged');
  assert.equal(JSON.parse(fs.readFileSync(authPath)).fixture.key, secret);
  const cleared = await commit(clearDraft, 'update', 'clear-native', 'fixture');
  assert.equal(cleared.credentialState, 'cleared');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(authPath)), 'fixture'), false);
});

test('a cancelled replacement cannot take over the last accepted private stage', async t => {
  const { sdk, authPath } = await setup(t);
  const { createProviderCredentialBridge } = await import('../server/provider-credential-bridge.js');
  let release, arrived;
  const atBoundary = new Promise(resolve => { arrived = resolve; });
  const pendingReply = new Promise(resolve => { release = resolve; });
  const staging = { ...sdk, async stageNativeLogin(...args) {
    const result = await sdk.stageNativeLogin(...args);
    if (args[1] === 'cancelled-replacement') { arrived(); await pendingReply; }
    return result;
  } };
  const draft = { ...binding, draftRevision: 1, expires: Infinity };
  const bridge = createProviderCredentialBridge({ sdk: staging, draftLookup: () => draft, nativePersistence: () => true, enabled: true });
  const base = { type: 'provider-credential', backendEpoch: bridge.epoch, requestId: 'fixture' };
  const prepare = () => bridge.handle({ ...base, action: 'prepare', draftId: binding.draftId, draftRevision: 1, purpose: 'replace' });
  const submit = ({ flowId, promptId, nonce }, input) => bridge.handle({ ...base, action: 'stage', flowId, promptId, nonce, input,
    allowDiscovery: false, rememberTarget: false });
  assert.equal((await submit(await prepare(), 'last-accepted')).ok, true);
  const replacement = await prepare();
  const late = submit(replacement, 'cancelled-replacement');
  await atBoundary;
  await bridge.handle({ ...base, action: 'cancel', flowId: replacement.flowId });
  release();
  assert.equal((await late).ok, false);
  const staleFlow = await prepare();
  draft.draftRevision = 2;
  assert.equal((await submit(staleFlow, 'old-form-fixture')).ok, false);
  const approval = await bridge.authorizeNative({ ...binding, action: 'apply-staged' });
  assert.ok(approval);
  assert.equal((await bridge.persistApproved(approval)).credentialSaved, true);
  assert.match(fs.readFileSync(authPath, 'utf8'), /last-accepted/);
  assert.equal((await bridge.persistApproved(approval)).credentialSaved, false);
});

test('FIX-08: replacing a staged key revokes the old grant even when native revision stays the same', async t => {
  const { sdk, authPath } = await setup(t);
  const { createProviderCredentialBridge } = await import('../server/provider-credential-bridge.js');
  const { createDiscoveryConsentStore } = await import('../server/provider-discovery-consent.js');
  const { createDiscoveryTransport } = await import('../server/provider-network.js');
  const store = createDiscoveryConsentStore();
  const draft = { ...binding, draftRevision: 1, expires: Infinity };
  const bridge = createProviderCredentialBridge({ sdk, consentStore: store, draftLookup: () => draft, nativePersistence: () => true, enabled: true });
  t.after(() => bridge.dispose());
  const frame = { type: 'provider-credential', backendEpoch: bridge.epoch, requestId: 'fixture' };
  const stageThroughBridge = async (input, allowDiscovery) => {
    const prepared = await bridge.handle({ ...frame, action: 'prepare', draftId: draft.draftId, draftRevision: 1, purpose: 'set' });
    assert.equal(prepared.ok, true);
    const { flowId, promptId, nonce } = prepared;
    const result = await bridge.handle({ ...frame, action: 'stage', flowId, promptId, nonce, input, allowDiscovery, rememberTarget: false });
    assert.equal(result.ok, true);
    return result;
  };

  const native = await sdk.inspect(binding.providerId);
  const first = await stageThroughBridge('fixture-first', true);
  const grant = store.get(first.consent.consentId);
  assert.ok(grant);
  const replacement = await stageThroughBridge('fixture-replacement', false);
  assert.equal(replacement.consent, null);
  assert.equal((await sdk.inspect(binding.providerId)).credentialRevision, native.credentialRevision);
  const requester = t.mock.fn(() => { throw new Error('unexpected socket'); });
  const transport = createDiscoveryTransport({ consentStore: store, lookup: async () => [{ address: '93.184.216.34' }],
    io: { requester } });
  const rejected = await transport({ consentId: grant.consentId, url: grant.candidatePaths[0], key: 'fixture-replacement',
    credentialRevision: grant.credentialRevision });
  assert.equal(rejected.code, 'invalid_target');
  assert.equal(requester.mock.callCount(), 0);
  const next = await stageThroughBridge('fixture-third', true);
  const nextGrant = store.get(next.consent.consentId);
  assert.notEqual(grant.credentialRevision, native.credentialRevision);
  assert.notEqual(nextGrant.credentialRevision, grant.credentialRevision);
  assert.equal(next.stagedRevision, undefined, 'the private generation stays inside backend');
  assert.equal(fs.existsSync(authPath), false);
});

test('private stage never writes; target binding, cancellation and literal persistence round trip', async t => {
  const { sdk, authPath } = await setup(t);
  const key = '!must-not-run-$ENV-${VALUE}-$$-$!';
  assert.equal((await stage(sdk, key)).credentialState, 'staged');
  assert.equal(fs.existsSync(authPath), false);
  assert.equal((await sdk.persistNative({ ...binding, connectionRevision: 2 })).code, 'credential_conflict');
  await sdk.disposeDraft(binding.draftId);
  assert.equal((await sdk.persistNative(binding)).code, 'credential_conflict');
  assert.equal(fs.existsSync(authPath), false);
  await stage(sdk, key);
  const saved = await sdk.persistNative(binding);
  assert.equal(saved.credentialSaved, true);
  assert.equal(saved.credentialState, 'saved');
  assert.ok(!JSON.stringify(saved).includes('must-not-run'));
  const raw = JSON.parse(fs.readFileSync(authPath)).fixture;
  assert.equal(raw.type, 'api_key');
  assert.equal(raw.key, '$!must-not-run-$$ENV-$${VALUE}-$$$$-$$!');
  assert.equal((await sdk.persistNative(binding)).code, 'credential_conflict');
});

test('same-slot OAuth requires confirmation, changes invalidate staged writes, clear touches only the target', async t => {
  const { sdk, authPath } = await setup(t);
  const oauth = { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: 1700000000000 };
  const save = data => fs.writeFileSync(authPath, JSON.stringify(data), { mode: 0o600 });
  save({ fixture: oauth, other: { type: 'api_key', key: 'other-fixture' } });
  assert.equal((await stage(sdk, 'new-fixture')).code, 'oauth_conflict');
  assert.equal((await stage(sdk, 'new-fixture', binding, true)).credentialState, 'staged');
  save({ fixture: { ...oauth, access: 'external-update' }, other: { type: 'api_key', key: 'other-fixture' } });
  assert.equal((await sdk.persistNative(binding)).code, 'credential_conflict');
  assert.equal(JSON.parse(fs.readFileSync(authPath)).fixture.access, 'external-update');
  await stage(sdk, 'new-fixture', binding, true);
  assert.equal((await sdk.persistNative(binding)).credentialSaved, true);
  const observed = await sdk.inspect(binding.providerId);
  assert.equal((await sdk.stageClear(binding, { confirmed: true, expectedCredentialRevision: observed.credentialRevision })).credentialState, 'clear-staged');
  assert.equal((await sdk.clearNative(binding)).credentialState, 'cleared');
  assert.deepEqual(JSON.parse(fs.readFileSync(authPath)), { other: { type: 'api_key', key: 'other-fixture' } });
});

test('SDK synchronization exceptions and failed writes return separate sanitized phases', async t => {
  const { sdk, authPath } = await setup(t);
  await stage(sdk, 'fixture-saved-sync-error');
  const saved = await sdk.persistNative(binding);
  assert.equal(saved.credentialSaved, true);
  assert.equal(saved.sync.state, 'pending');
  assert.ok(!JSON.stringify(saved).includes('fixture-saved-sync-error'));
  await stage(sdk, 'fixture-write-fails');
  const failed = await sdk.persistNative(binding);
  assert.equal(failed.credentialSaved, false);
  assert.equal(failed.credentialState, 'saved-credential-error');
  assert.equal(JSON.parse(fs.readFileSync(authPath)).fixture.key, 'fixture-saved-sync-error');
  assert.ok(!JSON.stringify(failed).includes('fixture-write-fails'));
});

test('unqualified storage and disabled input fail closed', async t => {
  const { sdk, authPath } = await setup(t, { authorizeStorage: () => false });
  await stage(sdk, 'expiry-key');
  assert.equal((await sdk.persistNative(binding)).code, 'storage_unqualified');
  assert.equal(fs.existsSync(authPath), false);
  fs.writeFileSync(authPath, '{bad');
  assert.equal((await sdk.inspect(binding.providerId)).present, null);
  const disabled = await setup(t, { enabled: false });
  assert.equal((await stage(disabled.sdk, 'must-not-stage')).code, 'unsupported');
  assert.equal(fs.existsSync(disabled.authPath), false);
});

test('expired drafts cannot be consumed', async t => {
  const { sdk, authPath } = await setup(t, { ttlMs: 25 });
  assert.equal((await stage(sdk, 'expiry-key')).credentialState, 'staged');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await sdk.persistNative(binding)).code, 'expired');
  assert.equal(fs.existsSync(authPath), false);
});
