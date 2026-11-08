const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

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

test('FIX-08: replacing a staged key revokes the old grant even when native revision stays the same', async t => {
  const { sdk, authPath } = await setup(t);
  const { createProviderCredentialBridge } = await import('../server/provider-credential-bridge.js');
  const { createDiscoveryConsentStore } = await import('../server/provider-discovery-consent.js');
  const { createDiscoveryTransport } = await import('../server/provider-network.js');
  const store = createDiscoveryConsentStore();
  const draft = { ...binding, draftRevision: 1, expires: Infinity };
  const bridge = createProviderCredentialBridge({ sdk, consentStore: store, draftLookup: () => draft, enabled: true });
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
