const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { test } = require('node:test');

const key = 'fixture-key-must-not-be-projected';
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-http-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modelsJson = path.join(root, 'models.json');
  const metadataPath = path.join(root, 'provider-management.json');
  const { createProviders } = await import('../server/providers.js');
  const { createProviderManagement } = await import('../server/provider-management.js');
  const native = new Map();
  const inspect = id => Promise.resolve(native.get(id) ?? { present: false, builtIn: false });
  const legacy = createProviders({ modelsJson, metadataPath, inspectCredential: inspect });
  const make = (enabled = true) => createProviderManagement({ store: legacy.store, inspectCredential: inspect, enabled });
  fs.writeFileSync(modelsJson, JSON.stringify({ misc: { a: true }, providers: { example: {
    baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions', apiKey: key,
    headers: { Authorization: key }, unknown: { value: key },
    models: [{ id: 'model-a', name: 'Before', unknown: { value: key }, headers: { Authorization: key } }],
  } } }));
  return { make, legacy, native, modelsJson, metadataPath };
}
function http(handler, method, url, data, headers = {}) {
  return new Promise(resolve => {
    const request = Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]);
    request.method = method;
    request.url = url;
    request.headers = { host: 'localhost:12345', ...headers };
    let status;
    handler(request, { writeHead(code) { status = code; }, end(body) { resolve({ status, body: JSON.parse(body) }); } }, new URL(url, 'http://localhost:12345'));
  });
}
const root = '/api/provider-management';
const draft = (providerId = 'example', baseUrl = 'https://fixture.invalid/v1') => ({ providerId,
  displayName: 'Example', authMode: 'none', connection: { baseUrl, api: 'openai-completions' }, enabled: true,
  selectedModelIds: ['model-a'], modelOrder: ['model-a'], modelPatches: [{ modelId: 'model-a', operation: 'upsert', set: { name: 'After' } }] });

test('draft edit commits losslessly with durable receipt and protects the live credential target', async t => {
  const f = await setup(t);
  const { handle } = f.make();
  const snapshot = await http(handle, 'GET', root);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.capabilities.rawKeyInput, false);
  assert.ok(!JSON.stringify(snapshot).includes(key));
  const expectedRevision = snapshot.body.revision;
  const pending = await http(handle, 'POST', root + '/drafts', { requestId: 'd1', serviceId: 'example', expectedRevision, draft: draft() });
  assert.equal(pending.status, 200);
  const request = { requestId: 'c1', action: 'update', serviceId: 'example', expectedRevision, draftId: pending.body.draftId, draftRevision: pending.body.draftRevision };
  const saved = await http(handle, 'POST', root + '/commit', request);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.sync.state, 'pending');
  assert.deepEqual(await http(f.make().handle, 'POST', root + '/commit', request), saved);
  const config = JSON.parse(fs.readFileSync(f.modelsJson));
  assert.equal(config.misc.a, true);
  assert.equal(config.providers.example.unknown.value, key);
  assert.equal(config.providers.example.models[0].headers.Authorization, key);
  assert.equal(config.providers.example.models[0].name, 'After');
  assert.ok(!JSON.stringify(saved).includes(key));
  const changed = await http(f.legacy.handle, 'POST', '/api/providers', { name: 'example', config: { ...draft().connection, baseUrl: 'https://other.invalid', models: [{ id: 'model-a' }] } });
  assert.equal(changed.status, 409);
  assert.equal(JSON.parse(fs.readFileSync(f.modelsJson)).providers.example.baseUrl, 'https://fixture.invalid/v1');
});

test('clone strips credentials; deleting the copy preserves source and rejects stale revision', async t => {
  const f = await setup(t);
  const { handle } = f.make();
  const revision = (await http(handle, 'GET', root)).body.revision;
  const d = await http(handle, 'POST', root + '/drafts', { requestId: 'd2', serviceId: 'example', expectedRevision: revision, draft: draft('new-copy', 'https://other.invalid') });
  const clone = await http(handle, 'POST', root + '/commit', { requestId: 'c2', action: 'clone', serviceId: 'example', expectedRevision: revision, draftId: d.body.draftId, draftRevision: d.body.draftRevision });
  assert.equal(clone.status, 200);
  const config = JSON.parse(fs.readFileSync(f.modelsJson));
  assert.ok(config.providers['new-copy']);
  assert.ok(!JSON.stringify(config.providers['new-copy']).includes(key));
  assert.equal(config.providers['new-copy'].apiKey, undefined);
  assert.equal(config.providers['new-copy'].headers, undefined);
  const remove = { requestId: 'c3', action: 'delete', serviceId: 'new-copy', expectedRevision: revision };
  assert.equal((await http(handle, 'POST', root + '/commit', remove)).status, 409);
  assert.equal((await http(handle, 'POST', root + '/commit', { ...remove, expectedRevision: clone.body.revision })).status, 200);
  const remaining = JSON.parse(fs.readFileSync(f.modelsJson)).providers;
  assert.equal(remaining['new-copy'], undefined);
  assert.equal(remaining.example.apiKey, key);
});

test('forged desktop approval and reserved network actions are rejected before any write', async t => {
  const f = await setup(t);
  const { handle } = f.make();
  const expectedRevision = (await http(handle, 'GET', root)).body.revision;
  const original = fs.readFileSync(f.modelsJson);
  const d = (await http(handle, 'POST', root + '/drafts', { requestId: 'd3', expectedRevision, draft: draft('new') })).body;
  const apply = { requestId: 'c4', action: 'create', expectedRevision, draftId: d.draftId, draftRevision: d.draftRevision, credentialAction: { type: 'apply-staged' } };
  assert.equal((await http(handle, 'POST', root + '/commit', apply)).body.code, 'unsupported');
  assert.equal((await http(handle, 'POST', root + '/commit', { ...apply, input: key })).status, 400);
  assert.equal((await http(handle, 'POST', root + '/discover', { requestId: 'd4', draftId: d.draftId, draftRevision: d.draftRevision, consentId: 'forged', dialogGeneration: 1, requestSeq: 1, force: false })).body.code, 'unsupported');
  assert.equal(fs.existsSync(f.metadataPath), false);
  assert.deepEqual(fs.readFileSync(f.modelsJson), original);
});

test('router authenticates application-scope writes without a Runtime owner and rejects foreign Host and Origin', async t => {
  const f = await setup(t);
  const { createRouter } = await import('../server/router.js');
  const { createAuth } = await import('../server/auth.js');
  const auth = createAuth({ token: 'fixture-http-token', port: 12345 });
  const route = createRouter({ auth, providers: f.legacy, providerManagement: f.make(), requireLegacyScope: () => true });
  const headers = { 'x-pi-gui-token': 'fixture-http-token' };
  const off = createRouter({ auth, providers: f.legacy, providerManagement: f.make(false), requireLegacyScope: () => true });
  assert.equal((await http(off, 'GET', root, undefined, headers)).body.code, 'unsupported');
  assert.equal((await http(off, 'GET', '/api/providers', undefined, headers)).status, 200);
  assert.equal((await http(route, 'GET', root)).status, 401);
  assert.equal((await http(route, 'GET', root, undefined, { ...headers, host: 'foreign.invalid' })).status, 403);
  assert.equal((await http(route, 'GET', root, undefined, { ...headers, origin: 'https://foreign.invalid' })).status, 403);
  const revision = (await http(route, 'GET', root, undefined, headers)).body.revision;
  assert.equal((await http(route, 'POST', root + '/drafts', { requestId: 'http-auth', expectedRevision: revision, draft: draft('new') }, headers)).status, 200);
});

test('legacy delete removes a model-only native override but cannot rebind an authenticated endpoint', async t => {
  const f = await setup(t);
  f.native.set('example', { present: true, builtIn: true });
  const before = fs.readFileSync(f.modelsJson);
  const blocked = await http(f.legacy.handle, 'DELETE', '/api/providers/example');
  assert.equal(blocked.body.code, 'credential_target_conflict');
  assert.deepEqual(fs.readFileSync(f.modelsJson), before);
  f.native.set('example', { present: null, builtIn: null });
  const { handle } = f.make();
  const revision = (await http(handle, 'GET', root)).body.revision;
  const removal = { requestId: 'native-removal', expectedRevision: revision, action: 'delete', serviceId: 'example' };
  assert.equal((await http(handle, 'POST', root + '/commit', removal)).body.code, 'credential_target_conflict');
  f.native.set('example', { present: false, builtIn: true });
  assert.equal((await http(f.legacy.handle, 'DELETE', '/api/providers/example')).body.code, 'credential_target_conflict');
  assert.equal((await http(handle, 'POST', root + '/commit', removal)).body.saved, true);
  assert.deepEqual(fs.readFileSync(f.modelsJson), before);
  assert.equal((await http(handle, 'GET', root)).body.services[0].enabled, false);
  fs.writeFileSync(f.modelsJson, JSON.stringify({ misc: { a: true }, providers: { example: { modelOverrides: { 'model-a': { name: 'Renamed' } } } } }));
  const response = await http(f.legacy.handle, 'DELETE', '/api/providers/example');
  assert.equal(response.status, 200);
  const after = JSON.parse(fs.readFileSync(f.modelsJson, 'utf8'));
  assert.equal(after.providers.example, undefined);
  assert.deepEqual(after.misc, { a: true });
  assert.equal((await http(f.legacy.handle, 'DELETE', '/api/providers/example')).status, 404);
});

test('preset labels do not override SDK identity and unknown new registrations fail closed', async t => {
  const f = await setup(t);
  const { handle } = f.make();
  const expectedRevision = (await http(handle, 'GET', root)).body.revision;
  f.native.set('opaque-native-id', { present: false, builtIn: null });
  const unknown = (await http(handle, 'POST', root + '/drafts', { requestId: 'd-unknown', expectedRevision, draft: draft('opaque-native-id') })).body;
  const request = { requestId: 'c-unknown', expectedRevision, action: 'create', draftId: unknown.draftId, draftRevision: unknown.draftRevision };
  assert.equal((await http(handle, 'POST', root + '/commit', request)).body.code, 'unsupported');
  assert.equal(fs.existsSync(f.metadataPath), false);
  const custom = (await http(handle, 'POST', root + '/drafts', { requestId: 'd-preset', expectedRevision, draft: { ...draft('siliconflow'), authMode: 'environment' } })).body;
  const response = await http(handle, 'POST', root + '/commit', { ...request, requestId: 'c-preset', draftId: custom.draftId,
    draftRevision: custom.draftRevision, credentialAction: { type: 'env', reference: '$SILICONFLOW_FIXTURE' } });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(f.modelsJson)).providers.siliconflow.apiKey, '$SILICONFLOW_FIXTURE');
});
