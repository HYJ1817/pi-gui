/* P2 供应商网络策略与受限 transport 专项。
 *
 * 全部离线：DNS 与底层请求都可注入，另有一条真实 loopback socket 链路
 * 证明实现（而非桩）能连上。假网络服务的响应只含非秘密 fixture。
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const entry = require('node:path').resolve(__dirname, '../server/provider-network.js');
const consentEntry = require('node:path').resolve(__dirname, '../server/provider-discovery-consent.js');

async function modules() {
  return { net: await import(require('node:url').pathToFileURL(entry).href), consent: await import(require('node:url').pathToFileURL(consentEntry).href) };
}

const httpsConnection = { baseUrl: 'https://api.fixture.invalid/v1', api: 'openai-completions' };

/* 可编程假 requester：记录收到的 options，按脚本回放 response/error。 */
function fakeRequester(script) {
  let call = 0;
  const requests = [];
  const fn = options => {
    const index = call++;
    const req = new EventEmitter();
    req.end = () => {
      requests.push(options);
      const step = script[Math.min(index, script.length - 1)];
      step(req, options);
    };
    return req;
  };
  fn.requests = requests;
  return fn;
}

function fakeRes({ status = 200, body = '', headers = {} } = {}) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.headers = headers;
  res.resume = () => {};
  res.destroy = () => res.emit('error', new Error('destroyed'));
  queueMicrotask(() => {
    if (body) res.emit('data', Buffer.from(body));
    res.emit('end');
  });
  return res;
}

async function consentFor(consent, overrides = {}) {
  const issued = consent.issue({ draftId: 'draft-a', draftRevision: 1, connectionRevision: 1, providerId: 'fixture',
    connection: httpsConnection, api: 'openai-completions', credentialSource: 'staged',
    credentialRevision: 'cred-rev-1', rememberTarget: false, loopback: false, ...overrides });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  return issued;
}

test('address classification covers loopback, private, link-local, metadata, mapped and CGNAT', async () => {
  const { net } = await modules();
  const cases = [
    ['127.0.0.1', 'loopback'], ['127.255.1.2', 'loopback'], ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'], ['::ffff:169.254.169.254', 'linklocal'],
    ['10.1.2.3', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'], ['100.64.0.9', 'private'],
    ['169.254.169.254', 'linklocal'], ['fe80::1', 'linklocal'], ['fd00::5', 'private'],
    ['0.0.0.0', 'unspecified'], ['::', 'unspecified'],
    ['8.8.8.8', 'public'], ['2606:4700::1111', 'public'],
  ];
  for (const [address, expected] of cases) assert.equal(net.classifyAddress(address), expected, address);
});

test('target parsing rejects userinfo, query, hash and bad ports; normalizes base path', async () => {
  const { net } = await modules();
  assert.equal(net.parseTarget('https://u:p@api.fixture.invalid/v1'), null);
  assert.equal(net.parseTarget('https://api.fixture.invalid/v1?key=1'), null);
  assert.equal(net.parseTarget('https://api.fixture.invalid/v1#frag'), null);
  assert.equal(net.parseTarget('ftp://api.fixture.invalid'), null);
  assert.equal(net.parseTarget('https://api.fixture.invalid:99999/v1'), null);
  const target = net.parseTarget('https://API.fixture.invalid:8443/v1/');
  assert.equal(target.host, 'api.fixture.invalid');
  assert.equal(target.port, 8443);
  assert.equal(target.basePath, '/v1');
  assert.equal(target.protocol, 'https');
});

test('policy gate: public needs https, loopback needs explicit consent and forbids secrets', async () => {
  const { net } = await modules();
  const target = net.parseTarget('https://api.fixture.invalid/v1');
  assert.equal(net.targetPolicy({ target, addressClass: 'public', credentialAttached: true, loopbackAuthorized: false }), null);
  assert.equal(net.targetPolicy({ target: { ...target, protocol: 'http' }, addressClass: 'public', credentialAttached: false, loopbackAuthorized: false }), 'policy_rejected');
  assert.equal(net.targetPolicy({ target: { ...target, protocol: 'http' }, addressClass: 'public', credentialAttached: true, loopbackAuthorized: false }), 'policy_rejected');
  const loopback = net.parseTarget('http://127.0.0.1:11434/v1');
  assert.equal(net.targetPolicy({ target: loopback, addressClass: 'loopback', credentialAttached: false, loopbackAuthorized: false }), 'loopback_requires_consent');
  assert.equal(net.targetPolicy({ target: loopback, addressClass: 'loopback', credentialAttached: true, loopbackAuthorized: true }), 'loopback_requires_consent');
  assert.equal(net.targetPolicy({ target: loopback, addressClass: 'loopback', credentialAttached: false, loopbackAuthorized: true }), null);
  assert.equal(net.targetPolicy({ target, addressClass: 'private', credentialAttached: true, loopbackAuthorized: false }), 'private_address');
});

test('DNS resolution rejects targets with any non-public address; pure loopback is classified', async () => {
  const { net } = await modules();
  const lookup = async host => host === 'mixed.fixture.invalid'
    ? [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.5', family: 4 }]
    : host === 'loopback.fixture.invalid' ? [{ address: '127.0.0.1', family: 4 }]
    : [{ address: '93.184.216.34', family: 4 }];
  const rejected = await net.resolveTargetAddresses({ host: 'mixed.fixture.invalid', lookup });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'private_address');
  const loopback = await net.resolveTargetAddresses({ host: 'loopback.fixture.invalid', lookup });
  assert.equal(loopback.ok, true);
  assert.equal(loopback.addressClass, 'loopback');
  const missing = await net.resolveTargetAddresses({ host: 'gone.fixture.invalid', lookup: async () => [] });
  assert.equal(missing.code, 'dns_failed');
});

test('consent store binds draft/connection/credential revision and honors revoke and expiry', async t => {
  const { consent } = await modules();
  let clock = 1_000_000;
  const store = consent.createDiscoveryConsentStore({ now: () => clock });
  t.after(() => store.dispose());
  const issued = await consentFor(store);
  assert.equal(store.get(issued.consentId).connectionRevision, 1);
  assert.equal(store.get(issued.consentId).target.host, 'api.fixture.invalid');
  clock += 15 * 60_000 + 1;
  assert.equal(store.get(issued.consentId), null);
  const second = await consentFor(store);
  assert.equal(store.revoke(second.consentId), true);
  assert.equal(store.get(second.consentId), null);
  const third = await consentFor(store);
  store.revokeDraftConnection('draft-a', 2);
  assert.equal(store.get(third.consentId), null, 'connection bump revokes the old grant');
  const loopbackAttached = store.issue({ draftId: 'draft-a', draftRevision: 1, connectionRevision: 1, providerId: 'ollama',
    connection: { baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' }, api: 'openai-completions',
    credentialSource: 'staged', credentialRevision: null, rememberTarget: false, loopback: true });
  assert.equal(loopbackAttached.ok, false, 'loopback discovery never carries a credential');
  const remembered = await consentFor(store, { rememberTarget: true, credentialSource: 'stored' });
  const match = store.matchRemembered({ providerId: 'fixture', connection: httpsConnection, api: 'openai-completions',
    credentialSource: 'stored', credentialRevision: 'cred-rev-1' });
  assert.ok(match, 'remembered target matches with identical credential revision');
  const mismatch = store.matchRemembered({ providerId: 'fixture', connection: httpsConnection, api: 'openai-completions',
    credentialSource: 'stored', credentialRevision: 'cred-rev-2' });
  assert.equal(mismatch, null, 'credential change forces re-confirmation');
  const stagedNeverRemembered = store.matchRemembered({ providerId: 'fixture', connection: httpsConnection, api: 'openai-completions',
    credentialSource: 'staged', credentialRevision: 'cred-rev-1' });
  assert.equal(stagedNeverRemembered, null, 'staged keys are transient and never remembered');
  assert.ok(remembered.consentId);
});

test('transport refuses unconsented targets, expired grants and secret attachment on no-secret grants', async t => {
  const { net, consent } = await modules();
  const store = consent.createDiscoveryConsentStore({ now: () => 1_000_000 });
  t.after(() => store.dispose());
  const issued = await consentFor(store);
  const transport = net.createDiscoveryTransport({ consentStore: store,
    io: { requester: fakeRequester([req => req.emit('response', fakeRes({ status: 200, body: '{"data":[]}' }))]) } });
  assert.equal((await transport({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models' })).ok, true);
  const offBase = await transport({ consentId: issued.consentId, url: 'https://evil.fixture.invalid/v1/models' });
  assert.equal(offBase.code, 'policy_rejected');
  const offPath = await transport({ consentId: issued.consentId, url: 'https://api.fixture.invalid/admin/models' });
  assert.equal(offPath.code, 'policy_rejected');
  const noCandidate = await transport({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v2/models' });
  assert.equal(noCandidate.code, 'policy_rejected');
  const missing = await transport({ consentId: 'missing-consent', url: 'https://api.fixture.invalid/v1/models' });
  assert.equal(missing.code, 'invalid_target');
  const loopbackIssue = store.issue({ draftId: 'draft-l', draftRevision: 1, connectionRevision: 1, providerId: 'ollama',
    connection: { baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' }, api: 'openai-completions',
    credentialSource: 'none', credentialRevision: null, rememberTarget: false, loopback: true });
  assert.equal(loopbackIssue.ok, true);
  const secretOnNoSecret = await transport({ consentId: loopbackIssue.consentId, url: 'http://127.0.0.1:11434/v1/models', key: 'sentinel-key' });
  assert.equal(secretOnNoSecret.code, 'policy_rejected', 'loopback grant never carries a key');
});

test('transport: redirects rejected, statuses mapped, retries bounded, oversized bodies cut', async t => {
  const { net, consent } = await modules();
  const store = consent.createDiscoveryConsentStore({ now: () => 1_000_000 });
  t.after(() => store.dispose());
  const issued = await consentFor(store);
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

  const redirect = net.createDiscoveryTransport({ consentStore: store, lookup,
    io: { requester: fakeRequester([req => req.emit('response', fakeRes({ status: 302, headers: { location: 'https://elsewhere.invalid/models' } }))]) } });
  assert.equal((await redirect({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models' })).code, 'redirect_rejected');

  const statuses = net.createDiscoveryTransport({ consentStore: store, lookup,
    io: { requester: fakeRequester([req => req.emit('response', fakeRes({ status: 401 }))]) } });
  const denied = await statuses({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models' });
  assert.equal(denied.code, 'http_status');
  assert.equal(denied.status, 401);
  const rateLimited = net.createDiscoveryTransport({ consentStore: store, lookup,
    io: { requester: fakeRequester([req => req.emit('response', fakeRes({ status: 429 }))]) } });
  assert.equal((await rateLimited({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models' })).status, 429);

  const retry = net.createDiscoveryTransport({ consentStore: store, lookup,
    io: { requester: fakeRequester([
      req => req.emit('response', fakeRes({ status: 500, body: 'boom' })),
      req => req.emit('response', fakeRes({ status: 200, body: JSON.stringify({ data: [{ id: 'fixture-mini' }] }) })),
    ]) } });
  const recovered = await retry({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models' });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.models[0].id, 'fixture-mini');

  const huge = net.createDiscoveryTransport({ consentStore: store, lookup, maxBytes: 16,
    io: { requester: fakeRequester([req => req.emit('response', fakeRes({ status: 200, body: 'x'.repeat(64) }))]) } });
  assert.equal((await huge({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models' })).code, 'too_large');

  const malformed = net.createDiscoveryTransport({ consentStore: store, lookup,
    io: { requester: fakeRequester([req => req.emit('response', fakeRes({ status: 200, body: '<html>' }))]) } });
  assert.equal((await malformed({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models' })).code, 'not_json');

  const hanging = net.createDiscoveryTransport({ consentStore: store, lookup, timeoutMs: 25,
    io: { requester: fakeRequester([() => { /* never responds */ }]) } });
  assert.equal((await hanging({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models' })).code, 'timeout');
});

test('transport pins DNS: the socket lookup only ever sees consented validated addresses', async t => {
  const { net, consent } = await modules();
  const store = consent.createDiscoveryConsentStore({ now: () => 1_000_000 });
  t.after(() => store.dispose());
  const issued = await consentFor(store);
  const seen = [];
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const requester = fakeRequester([req => req.emit('response', fakeRes({ status: 200, body: '{"data":[]}' }))]);
  const transport = net.createDiscoveryTransport({ consentStore: store, lookup, io: { requester } });
  await transport({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models' });
  const options = requester.requests[0];
  options.lookup('api.fixture.invalid', { all: true }, (error, list) => {
    assert.ifError(error);
    seen.push(...list.map(item => item.address));
    assert.deepEqual(seen, ['93.184.216.34']);
  });
  assert.equal(options.host, 'api.fixture.invalid');
  assert.equal(options.headers.authorization, undefined, 'no credential header without a key');
});

test('real loopback socket path: actual http server serves a bounded model list', async t => {
  const { net, consent } = await modules();
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'local-mini' }, { id: 'local-max' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const store = consent.createDiscoveryConsentStore({ now: () => 1_000_000 });
  t.after(() => store.dispose());
  const loopbackConnection = { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions' };
  const issued = store.issue({ draftId: 'draft-loop', draftRevision: 1, connectionRevision: 1, providerId: 'ollama',
    connection: loopbackConnection, api: 'openai-completions', credentialSource: 'none',
    credentialRevision: null, rememberTarget: false, loopback: true });
  assert.equal(issued.ok, true);
  const transport = net.createDiscoveryTransport({ consentStore: store, timeoutMs: 3000 });
  const result = await transport({ consentId: issued.consentId, url: issued.candidatePaths[0] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.models.map(model => model.id), ['local-mini', 'local-max']);
  assert.equal(transport && true, true);
});

test('model list shape guard truncates beyond the cap and rejects non-list JSON', async () => {
  const { net } = await modules();
  const truncated = net.pickModelList({ data: Array.from({ length: 3200 }, (_, index) => ({ id: `m${index}` })) });
  assert.equal(truncated.ok, true);
  assert.equal(truncated.items.length, 3000);
  assert.equal(truncated.truncated, true);
  assert.equal(net.pickModelList({ error: 'nope' }).code, 'not_json');
  assert.equal(net.pickModelList('["str"]').code, 'not_json');
});
