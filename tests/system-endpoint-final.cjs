'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const local = require('../lib/local-endpoint-policy.cjs');
const load = name => import(pathToFileURL(path.resolve(__dirname, '../server', name)).href);
const connection = host => ({ baseUrl: `http://${host}/v1`, api: 'openai-completions' });
const issue = (store, conn, extra = {}) => store.issue({ draftId: 'draft-final', draftRevision: 1,
  connectionRevision: 1, providerId: 'local-final', connection: conn, api: conn.api,
  credentialSource: 'none', localEndpoint: true, ...extra });

function requester(records, status = 200) {
  return options => {
    records.push(options);
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = status; res.headers = {};
      res.destroy = () => {};
      req.emit('response', res);
      queueMicrotask(() => { res.emit('data', Buffer.from('{"data":[{"id":"local-fixture"}]}')); res.emit('end'); });
    };
    return req;
  };
}

for (const host of ['localhost:11434', '127.0.0.1:11434', '[::1]:11434', '192.168.1.30:8000', '10.1.2.3:8000', '[fd00::10]:8000']) {
  test(`explicit relaxed endpoint is scoped and pinned: ${host}`, async t => {
    const { createDiscoveryConsentStore } = await load('provider-discovery-consent.js');
    const { createDiscoveryTransport } = await load('provider-network.js');
    let relaxed = true;
    const store = createDiscoveryConsentStore({ strict: true, networkPolicy: () => ({ relaxed, controlPorts: [7788] }) });
    t.after(() => store.dispose());
    const issued = issue(store, connection(host));
    assert.equal(issued.ok, true);
    const records = [];
    const run = createDiscoveryTransport({ consentStore: store, lookup: async () => [{ address: '127.0.0.1' }], io: { requester: requester(records) } });
    const result = await run({ consentId: issued.consentId, url: issued.candidatePaths[0] });
    assert.equal(result.ok, true, result.code);
    assert.equal(records.length, 1);
    assert.equal(records[0].headers.authorization, undefined);
    assert.equal((await run({ consentId: issued.consentId, url: issued.candidatePaths[0].replace('/v1/', '/other/') })).ok, false);
    relaxed = false;
    assert.equal(store.get(issued.consentId), null, 'turning relaxed off revokes extra permission');
    assert.equal((await run({ consentId: issued.consentId, url: issued.candidatePaths[0] })).ok, false);
  });
}

test('new HTTP model registrations cannot turn directory consent into an inference credential grant', async () => {
  const { applyProviderCommit, applyLegacyProvider } = await load('provider-config-records.js');
  const snapshot = () => ({ config: { providers: {} }, metadata: { services: {}, receipts: {} } });
  const draft = { providerId: 'local-final', connection: connection('127.0.0.1:11434'), authMode: 'environment' };
  const credential = { present: false, builtIn: false };
  assert.throws(() => applyProviderCommit(snapshot(), { action: 'create', credentialAction: { type: 'env', reference: '$FIXTURE_KEY' } }, draft, credential),
    { code: 'credential_target_conflict' });
  assert.throws(() => applyLegacyProvider(snapshot(), 'local-final', { ...draft.connection, apiKey: '$FIXTURE_KEY', models: [] }, credential),
    { code: 'credential_target_conflict' });
  const { validateProviderRequest } = await import('../public/provider-management/contract.js');
  const referenceDraft = validateProviderRequest('drafts', { requestId: 'request-final', expectedRevision: 'revision-final',
    draft: { providerId: 'local-final', displayName: 'Local fixture',
      connection: draft.connection, authMode: 'none', piRegistrationReference: '$FIXTURE_KEY',
      modelPatches: [], selectedModelIds: [], modelOrder: [], enabled: true } }).draft;
  assert.throws(() => applyProviderCommit(snapshot(), { action: 'create', credentialAction: { type: 'keep' } }, referenceDraft, credential),
    { code: 'credential_target_conflict' });
});

test('closing relaxed mode permanently revokes local grants and remembered approval without touching public grants', async t => {
  const { createDiscoveryConsentStore } = await load('provider-discovery-consent.js');
  let relaxed = true, generation = 0;
  const store = createDiscoveryConsentStore({ strict: true, networkPolicy: () => ({ relaxed, generation }) });
  t.after(() => store.dispose());
  const conn = connection('127.0.0.1:11434');
  const localGrant = issue(store, conn, { rememberTarget: true }); assert.equal(localGrant.ok, true);
  const localSignal = store.signalFor(localGrant.consentId);
  const publicGrant = issue(store, { baseUrl: 'https://public.example/v1', api: conn.api },
    { draftId: 'public-draft', providerId: 'public-final', localEndpoint: false });
  assert.equal(publicGrant.ok, true);
  const publicSignal = store.signalFor(publicGrant.consentId);
  relaxed = false; generation++; store.revokeLocalEndpoints();
  assert.equal(localSignal.aborted, true); assert.equal(publicSignal.aborted, false);
  relaxed = true;
  assert.equal(store.get(localGrant.consentId), null);
  assert.equal(store.matchRemembered({ providerId: 'local-final', connection: conn, api: conn.api, credentialSource: 'none' }), null);
  assert.ok(store.get(publicGrant.consentId));
  // Generation binding also prevents revival if a consumer misses its callback.
  const stale = issue(store, conn); generation++; relaxed = false; relaxed = true;
  assert.equal(store.get(stale.consentId), null);
  assert.equal(issue(store, conn).ok, true, 'a fresh explicit grant is still available');
});

test('MCP confirmation issued before closing relaxed mode cannot be replayed after reopening', () => {
  const { createMcpEndpointPermission } = require('../lib/mcp-endpoint-permission.cjs');
  let relaxed = true, generation = 0;
  const authorize = createMcpEndpointPermission({ networkPolicy: () => ({ relaxed, generation }), urlLooksSensitive: () => false });
  const request = { config: { type: 'http', url: 'http://127.0.0.1:11434/mcp' }, scope: 'user', name: 'local-tools', file: 'fixture', revision: 'revision' };
  const issued = authorize(request); assert.equal(issued.needsEndpointAuthorization, true);
  relaxed = false; generation++; relaxed = true;
  assert.equal(authorize({ ...request, authorization: issued.endpointChallenge }).ok, false);
  const fresh = authorize(request);
  assert.equal(authorize({ ...request, authorization: fresh.endpointChallenge }), null);
});

test('strict default, no endpoint confirmation and HTTP credentials do not gain permission', async t => {
  const { createDiscoveryConsentStore } = await load('provider-discovery-consent.js');
  const strict = createDiscoveryConsentStore({ strict: true });
  const relaxed = createDiscoveryConsentStore({ strict: true, networkPolicy: () => ({ relaxed: true }) });
  t.after(() => { strict.dispose(); relaxed.dispose(); });
  assert.equal(issue(strict, connection('192.168.1.30:8000')).ok, false);
  assert.equal(issue(relaxed, connection('192.168.1.30:8000'), { localEndpoint: false }).ok, false);
  assert.equal(issue(relaxed, connection('192.168.1.30:8000'), { credentialSource: 'stored', credentialRevision: 'revision', workerEpoch: 'epoch' }).ok, false);
});

test('metadata/reserved/Fake-IP cannot become local endpoint permission', () => {
  for (const host of ['169.254.169.254', '168.63.129.16', '100.100.100.200', '198.18.0.1', '0.0.0.0', '[fe80::1]', '[2001:db8::1]', '[::ffff:a9fe:a9fe]', '[fd00:ec2::254]']) {
    const target = local.endpoint(`http://${host}/v1`);
    assert.equal(local.permitsAddresses(target, [target.host]), false, host);
  }
  assert.equal(local.permitsAddresses(local.endpoint('http://localhost:7788/v1'), ['127.0.0.1'], { controlPorts: [7788] }), false);
  for (const url of ['http://u:p@127.0.0.1:8000', 'http://127.0.0.1:8000/?key=x', 'http://127.0.0.1:8000/#x']) assert.equal(local.endpoint(url), null);
});

test('authorized localhost still rejects mixed DNS / rebinding and redirects', async t => {
  const { createDiscoveryConsentStore } = await load('provider-discovery-consent.js');
  const { createDiscoveryTransport } = await load('provider-network.js');
  const store = createDiscoveryConsentStore({ strict: true, networkPolicy: () => ({ relaxed: true }) });
  t.after(() => store.dispose());
  const issued = issue(store, connection('localhost:11434'));
  assert.equal(issued.ok, true);
  for (const addresses of [['127.0.0.1', '169.254.169.254'], ['192.168.1.30'], ['8.8.8.8']]) {
    const records = [];
    const run = createDiscoveryTransport({ consentStore: store, lookup: async () => addresses.map(address => ({ address })), io: { requester: requester(records) } });
    assert.equal((await run({ consentId: issued.consentId, url: issued.candidatePaths[0] })).ok, false);
    assert.equal(records.length, 0);
  }
  const records = [];
  const run = createDiscoveryTransport({ consentStore: store, lookup: async () => [{ address: '127.0.0.1' }], io: { requester: requester(records, 302) } });
  assert.equal((await run({ consentId: issued.consentId, url: issued.candidatePaths[0] })).code, 'redirect_rejected');
  assert.equal(records.length, 1);
});

test('real authorized local HTTP model directory uses pinned socket without credentials', async t => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; assert.equal(req.headers.authorization, undefined); res.setHeader('content-type', 'application/json'); res.end('{"data":[{"id":"local-fixture"}]}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const { createDiscoveryConsentStore } = await load('provider-discovery-consent.js');
  const { createDiscoveryTransport } = await load('provider-network.js');
  const store = createDiscoveryConsentStore({ strict: true, networkPolicy: () => ({ relaxed: true }) });
  t.after(() => store.dispose());
  const issued = issue(store, connection(`127.0.0.1:${server.address().port}`));
  assert.equal(issued.ok, true);
  const result = await createDiscoveryTransport({ consentStore: store })({ consentId: issued.consentId, url: issued.candidatePaths[0] });
  assert.equal(result.ok, true); assert.equal(hits, 1);
});

test('MCP local endpoint confirmation binds full config, scope, revision and server identity', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-endpoint-final-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { createMcpConfigStore } = await load('mcp-config.js');
  let relaxed = true;
  const store = createMcpConfigStore({ env: { HOME: root }, networkPolicy: () => ({ relaxed, controlPorts: [7788] }) });
  const payload = { scope: 'user', name: 'lan-model-tools', transport: 'http', url: 'http://192.168.1.30:8000/mcp', expectedRevision: '' };
  const challenge = await store.save(payload);
  assert.equal(challenge.needsEndpointAuthorization, true);
  assert.equal((await store.save({ ...payload, name: 'other', endpointAuthorization: challenge.endpointChallenge })).ok, false);
  const fresh = await store.save(payload);
  assert.equal((await store.save({ ...payload, endpointAuthorization: fresh.endpointChallenge })).ok, true);
  const data = JSON.parse(await fs.readFile(path.join(root, '.pi/agent/mcp.json'), 'utf8'));
  assert.equal(data.mcpServers[payload.name].url, payload.url);
  assert.equal(JSON.stringify(data).includes('endpointChallenge'), false);
  relaxed = false;
  assert.equal((await store.save({ ...payload, name: 'other', expectedRevision: store.revisions().user })).ok, false);
});

test('MCP protected native URLs stay masked and cannot get a local authorization challenge', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-endpoint-final-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'mcp.json');
  const marker = 'sk-FIXTURE-ONLY-PATH';
  const before = Buffer.from(JSON.stringify({ mcpServers: {
    local: { type: 'http', url: `http://127.0.0.1:8000/mcp/${marker}` },
    secureLocal: { type: 'http', url: `https://127.0.0.1:8443/mcp/${marker}` },
  } }));
  await fs.writeFile(file, before);
  const { createMcpConfigStore } = await load('mcp-config.js');
  const store = createMcpConfigStore({ env: { PI_CODING_AGENT_DIR: root }, networkPolicy: () => ({ relaxed: true }) });
  for (const name of ['local', 'secureLocal']) {
    const detail = await store.getDetail({ scope: 'user', name });
    assert.equal(detail.entry.urlProtected, true);
    assert.equal(detail.entry.url, null);
    assert.equal(JSON.stringify(detail).includes(marker), false, 'detail must not return protected paths');
    const result = await store.save({ scope: 'user', name, originalName: name, transport: 'http', keepUrl: true,
      description: 'description only', expectedRevision: store.revisions().user });
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(marker), false, 'a save response must not return protected paths');
    assert.equal(result.code, 'endpoint-policy');
    assert.equal(result.field, 'url');
    for (const field of ['needsEndpointAuthorization', 'endpointChallenge', 'targetSummary']) {
      assert.equal(Object.hasOwn(result, field), false, 'protected targets must not enter the confirmation flow');
    }
  }
  assert.equal((await fs.readFile(file)).equals(before), true, 'a denied save must preserve the original config bytes');
  assert.deepEqual(await fs.readdir(root), ['mcp.json']);
});

test('MCP default strict and HTTP secret headers never get a local authorization challenge', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-endpoint-final-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { createMcpConfigStore } = await load('mcp-config.js');
  const strict = createMcpConfigStore({ env: { HOME: root }, networkPolicy: () => ({ relaxed: false }) });
  const relaxed = createMcpConfigStore({ env: { HOME: root }, networkPolicy: () => ({ relaxed: true }) });
  for (const [store, extra] of [[strict, {}], [relaxed, { headers: [{ key: 'Authorization', value: 'Bearer ${FIXTURE_KEY}' }] }]]) {
    const result = await store.save({ scope: 'user', name: 'local-tools', transport: 'http', url: 'http://127.0.0.1:8000/mcp', expectedRevision: '', ...extra });
    assert.equal(result.ok, false);
    assert.notEqual(result.needsEndpointAuthorization, true);
  }
});
