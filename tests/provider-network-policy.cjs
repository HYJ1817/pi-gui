/* P2 供应商网络策略与受限 transport 专项。
 *
 * 全部离线：DNS 与底层请求都可注入，另有一条真实 loopback socket 链路
 * 证明实现（而非桩）能连上。假网络服务的响应只含非秘密 fixture。
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter, getEventListeners, once } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
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
    requests.push(options);
    const req = new EventEmitter();
    req.end = () => {
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
  /* 默认签发**无凭据**授权：本文件的多数用例验证网络策略与 transport
   * 行为本身（不涉及代次）。需要 keyed 授权的用例显式传
   * { credentialSource: 'staged', credentialRevision } 覆盖。 */
  const issued = consent.issue({ draftId: 'draft-a', draftRevision: 1, connectionRevision: 1, providerId: 'fixture',
    connection: httpsConnection, api: 'openai-completions', credentialSource: 'none',
    credentialRevision: null, rememberTarget: false, loopback: false, ...overrides });
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

test('IPv4-mapped IPv6 in hex notation is decoded and reclassified under IPv4 semantics', async () => {
  const { net } = await modules();
  const cases = [
    // 高 16 位 = 前两个 v4 段，低 16 位 = 后两个 v4 段。
    ['::ffff:7f00:1', 'loopback'],       // 127.0.0.1
    ['::ffff:7f00:0001', 'loopback'],   // 127.0.0.1（补零位宽）
    ['::ffff:A9FE:A9FE', 'linklocal'],  // 169.254.169.254（大写不绕过）
    ['::ffff:a9fe:01', 'linklocal'],    // 169.254.0.1
    ['::ffff:c0a8:101', 'private'],     // 192.168.1.1
    ['::ffff:0a01:0203', 'private'],    // 10.1.2.3
    ['::ffff:ac10:01', 'private'],      // 172.16.0.1
    ['::ffff:6440:9', 'private'],       // 100.64.0.9（CGNAT）
    ['::ffff:6440:0901', 'private'],    // 100.64.9.1
    ['::ffff:5db8:d001', 'public'],     // 93.184.208.1
    ['::ffff:df8e:1107', 'public'],     // 223.142.17.7
  ];
  for (const [address, expected] of cases) assert.equal(net.classifyAddress(address), expected, address);
});

test('other reserved v4/v6 ranges never classify as public', async () => {
  const { net } = await modules();
  // RFC 5737 文档段、RFC 7526、RFC 2544、组播/保留/240/4 与全广播 ——
  // 模型目录的可达公网目标里都不该出现；策略防线是「DNS 解析出任何
  // 非 public/loopback 地址即整体拒发」。
  const reserved = [
    ['192.0.0.9', 'private'], ['192.0.2.1', 'private'], ['198.51.100.7', 'private'],
    ['203.0.113.5', 'private'], ['192.88.99.1', 'private'], ['198.18.0.4', 'private'],
    ['240.0.0.1', 'private'], ['255.255.255.255', 'private'],
  ];
  for (const [address, expected] of reserved) assert.equal(net.classifyAddress(address), expected, address);
  // 可路由公网不误伤。
  assert.equal(net.classifyAddress('8.8.8.8'), 'public');
  assert.equal(net.classifyAddress('93.184.216.34'), 'public');
  // DNS 层联动：解析表既有 public 又有保留段地址时整体拒发。
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '203.0.113.5', family: 4 }];
  const resolved = await net.resolveTargetAddresses({ host: 'mixed-reserved.example.invalid', lookup });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, 'private_address');
});

const reportedReserved = [
  ['198.51.100.64', 4], ['248.0.0.1', 4], ['2001:db8::1', 6], ['ff02::1', 6],
];

for (const [address, family] of reportedReserved) {
  test(`FIX-10: discovery never sends a request to ${address}`, async t => {
    const { net, consent } = await modules();
    const store = consent.createDiscoveryConsentStore();
    t.after(() => store.dispose());
    const requester = fakeRequester([req => req.emit('response', fakeRes({ body: '[]' }))]);
    const publicAddress = { address: '93.184.216.34', family: 4 };
    const reservedAddress = { address, family };
    const literal = family === 6 ? `[${address}]` : address;
    const grant = { credentialSource: 'stored', credentialRevision: 'fixture-rev' };
    const hostnameConsent = await consentFor(store, grant);
    const literalConsent = await consentFor(store, { ...grant,
      connection: { ...httpsConnection, baseUrl: `https://${literal}/v1` } });
    for (const [issued, entries] of [
      [hostnameConsent, [reservedAddress]],
      [hostnameConsent, [publicAddress, reservedAddress]],
      // Node can bypass lookup when options.host is already a numeric address.
      [literalConsent, [publicAddress]],
    ]) {
      const transport = net.createDiscoveryTransport({ consentStore: store, lookup: async () => entries,
        io: { requester } });
      const result = await transport({ consentId: issued.consentId, url: issued.candidatePaths[0],
        key: 'fixture-secret', credentialRevision: grant.credentialRevision });
      assert.equal(requester.requests.length, 0, 'no credential-bearing request reaches the requester');
      assert.equal(result.code, 'private_address');
    }
    assert.equal(net.classifyAddress(address), 'private');
  });
}

test('FIX-10: reserved prefixes cover their endpoints and alternate IPv6 notation', async () => {
  const { net } = await modules();
  for (const address of [
    '198.51.100.0', '198.51.100.255', '240.0.0.0', '255.255.255.254',
    '0:0:0:0:0:FFFF:198.51.100.64', '::ffff:f800:1',
    '2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff',
    'ff00::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', '3ffe::1', 'fec0::1',
    '64:ff9b::a9fe:a9fe', '64:ff9b:1::1', '2002:a9fe:a9fe::1', '2001::1',
  ]) assert.equal(net.classifyAddress(address), 'private', address);

  assert.equal(net.classifyAddress('0:0:0:0:0:ffff:127.0.0.1'), 'loopback');
  assert.equal(net.classifyAddress('0:0:0:0:0:ffff:93.184.216.34'), 'public');
  for (const address of ['198.51.99.255', '198.51.101.0', '2001:4860::8888', '2606:4700::1111']) {
    assert.equal(net.classifyAddress(address), 'public', address);
  }
});

test('FIX-10: unrecognized or scoped DNS answers fail closed', async () => {
  const { net } = await modules();
  const publicEntry = { address: '93.184.216.34', family: 4 };
  for (const address of ['not-an-ip', '2606:4700::1111%fixture', null, [publicEntry.address], Buffer.from(publicEntry.address)]) {
    assert.equal(net.classifyAddress(address), null);
    const result = await net.resolveTargetAddresses({ host: 'fixture.invalid',
      lookup: async () => [publicEntry, { address }] });
    assert.equal(result.code, 'private_address');
  }
  const incomplete = [publicEntry];
  incomplete.length = 2;
  const result = await net.resolveTargetAddresses({ host: 'fixture.invalid', lookup: async () => incomplete });
  assert.equal(result.code, 'private_address');
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
    credentialSource: 'staged', credentialRevision: 'cred-rev-1', rememberTarget: false, loopback: true });
  assert.equal(loopbackAttached.ok, false, 'loopback discovery never carries a credential');
  const remembered = await consentFor(store, { rememberTarget: true, credentialSource: 'stored', credentialRevision: 'cred-rev-1' });
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
  /* 确定 DNS fixture：不依赖执行环境对 .invalid 域名的解析行为
   * （CI NXDOMAIN → dns_failed 会把 happy-path 变成环境敏感断言）。 */
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const transport = net.createDiscoveryTransport({ consentStore: store, lookup: publicLookup,
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

test('model list output whitelist drops credentials, secrets echo, bad types and overlong strings', async () => {
  const { net } = await modules();
  const SECRET = 'sentinel-key-FIXTURE';
  const malicious = { data: [
    { id: 'good-model', name: 'Good', context_length: 4096 },
    { id: 'leaky-model', apiKey: SECRET, headers: { Authorization: `Bearer ${SECRET}` } },
    { id: 'echo-id-' + SECRET.slice(0, 12), name: SECRET },
    { id: 'echo-name', name: `prefix ${SECRET} suffix` },
    { id: { nested: 'object-id' } },
    { id: 'x'.repeat(400) },
    { id: 'long-name', name: 'n'.repeat(400), context_length: 128 },
    { id: 'control\u0000id' },
    { id: 'token-model', token: SECRET, access_token: SECRET },
    { id: 'deep-model', metadata: { apiKey: SECRET }, pricing: { prompt: SECRET } },
    42, null, [], true,
    'plain-string-model',
  ] };
  const picked = net.pickModelList(malicious, [SECRET]);
  assert.equal(picked.ok, true);
  const ids = picked.models.map(model => model.id);
  assert.deepEqual(ids, ['good-model', 'long-name', 'plain-string-model']);
  // 白名单字段：无 apiKey/headers/token/嵌套对象字段。
  for (const model of picked.models) {
    const text = JSON.stringify(model);
    assert.equal(text.includes(SECRET), false, model.id);
    assert.ok(!('apiKey' in model) && !('headers' in model) && !('token' in model) && !('metadata' in model), model.id);
  }
  assert.equal(picked.models[0].contextWindow, 4096);
  assert.equal(typeof picked.models[1].name, 'undefined', 'overlong name is dropped');
  assert.equal(picked.models[2].contextWindow, undefined, 'string entries carry id only');
});

test('model capability evidence comes only from declared fields, never from model ids', async () => {
  const { net } = await modules();
  const SECRET = 'sentinel-key-CAPABILITY';
  const picked = net.pickModelList({ data: [
    { id: 'tools-model', supported_parameters: ['tools', 'temperature'] },
    { id: 'explicit-false', toolCalling: false, streaming: true },
    { id: 'explicit-true', toolCalling: true, streaming: false },
    { id: 'text-out', architecture: { output_modalities: ['text'] } },
    { id: 'image-out', architecture: { output_modalities: ['image'] } },
    { id: 'malformed-out', architecture: { output_modalities: [1, null, {}] } },
    { id: 'empty-out', architecture: { output_modalities: [] } },
    { id: 'mixed-out', modalities: { output: [1, 'text'] } },
    { id: 'unknown-model' },
    { id: 'secret-tools', name: SECRET, supported_parameters: ['tools'] },
  ] }, [SECRET]);
  const byId = Object.fromEntries(picked.models.map(model => [model.id, model]));
  assert.equal(byId['tools-model'].toolCalling, true, 'a tools parameter is explicit tool evidence');
  assert.equal(byId['tools-model'].chatCapable, true);
  assert.equal(byId['tools-model'].streaming, undefined, 'missing streaming is unknown, not false');
  assert.equal(byId['explicit-false'].toolCalling, false, 'an explicit boolean is preserved');
  assert.equal(byId['explicit-false'].streaming, true);
  assert.equal(byId['explicit-true'].streaming, false);
  assert.equal(byId['text-out'].chatCapable, true);
  assert.equal(byId['text-out'].toolCalling, undefined);
  assert.equal(byId['image-out'].chatCapable, false, 'non-text output is negative chat evidence');
  assert.ok(!('chatCapable' in byId['malformed-out']), 'malformed output modalities are unknown, not false');
  assert.ok(!('chatCapable' in byId['empty-out']), 'an empty output list is not negative chat evidence');
  assert.equal(byId['mixed-out'].chatCapable, true, 'valid string entries still count when malformed ones are present');
  assert.ok(!('toolCalling' in byId['unknown-model']) && !('chatCapable' in byId['unknown-model']),
    'models without declarations stay unknown');
  assert.equal(byId['secret-tools'], undefined, 'capability parsing never bypasses the secret filter');

  const google = net.pickModelList({ models: [
    { name: 'models/gemini-chat', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/embed-only', supportedGenerationMethods: ['embedContent'] },
  ] }, [], 'google-generative-ai');
  assert.deepEqual(google.models.map(model => [model.id, model.chatCapable]), [['gemini-chat', true]],
    'generateContent is the only Google chat capability witness');
});

test('transport strips credentials from discovery results and respects the total deadline', async t => {
  const { net, consent } = await modules();
  const store = consent.createDiscoveryConsentStore({ now: () => 1_000_000 });
  t.after(() => store.dispose());
  const SECRET = 'sentinel-key-LIVE';
  const issued = await consentFor(store, { credentialSource: 'staged', credentialRevision: 'cred-rev-1' });
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  // 供应商把鉴权头回显进第一个模型名，然后第二个候选成功。
  const transport = net.createDiscoveryTransport({ consentStore: store, lookup,
    io: { requester: fakeRequester([
      req => req.emit('response', fakeRes({ status: 500, body: 'boom' })),
      req => req.emit('response', fakeRes({ status: 200, body: JSON.stringify({ data: [
        { id: 'echo', name: `Echo Bearer ${SECRET}` },
        { id: 'clean', name: 'Clean Model' },
      ] }) })),
    ]) } });
  const result = await transport({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models', key: SECRET, credentialRevision: 'cred-rev-1' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map(model => model.id), ['clean']);
  assert.equal(JSON.stringify(result.models).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes('boom'), false, 'raw upstream error body never escapes');
});

test('credential revision mismatch after staged replacement invalidates the old grant', async t => {
  const { net, consent } = await modules();
  const store = consent.createDiscoveryConsentStore({ now: () => 1_000_000 });
  t.after(() => store.dispose());
  const issued = await consentFor(store, { credentialSource: 'staged', credentialRevision: 'cred-rev-1' });
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const transport = net.createDiscoveryTransport({ consentStore: store, lookup,
    io: { requester: fakeRequester([req => req.emit('response', fakeRes({ status: 200, body: '{"data":[]}' }))]) } });
  const same = await transport({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models', key: 'k', credentialRevision: 'cred-rev-1' });
  assert.equal(same.ok, true);
  const rotated = await transport({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models', key: 'k', credentialRevision: 'cred-rev-2' });
  assert.equal(rotated.code, 'policy_rejected', 'rotating the key invalidates the previous grant');
  const missing = await transport({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models', key: 'k', credentialRevision: null });
  assert.equal(missing.code, 'policy_rejected', 'a grant bound to evidence cannot be used without it');
  const absent = await transport({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models', key: 'k' });
  assert.equal(absent.code, 'policy_rejected', 'omitting the revision entirely is also refused');
  const keyless = await transport({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models', credentialRevision: 'cred-rev-1' });
  assert.equal(keyless.code, 'policy_rejected', 'a keyed grant requires the key itself, not just a revision');
});

test('total deadline bounds every attempt, including the last one', async t => {
  const { net, consent } = await modules();
  const store = consent.createDiscoveryConsentStore({ now: () => 1_000_000 });
  t.after(() => store.dispose());
  const issued = await consentFor(store);
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  // 全部候选都不响应：每个 attempt 的单次超时都被截到 maxTotalMs 剩余，
  // 完成 N 次尝试的总耗时必须 <= maxTotalMs + 少量调度余量。
  const timeouts = net.createDiscoveryTransport({ consentStore: store, lookup,
    timeoutMs: 60_000, maxTotalMs: 2_000,
    io: { requester: fakeRequester([() => { /* hangs */ }, () => { /* hangs */ }]) } });
  const started = Date.now();
  const result = await timeouts({ consentId: issued.consentId, url: 'https://api.fixture.invalid/v1/models' });
  const elapsed = Date.now() - started;
  assert.equal(result.code, 'timeout');
  assert.ok(elapsed <= 3_000, `total ${elapsed}ms must stay within maxTotalMs(2000) + slack`);
});

test('model list shape guard truncates beyond the cap and rejects non-list JSON', async () => {
  const { net } = await modules();
  const truncated = net.pickModelList({ data: Array.from({ length: 3200 }, (_, index) => ({ id: `m${index}` })) });
  assert.equal(truncated.ok, true);
  assert.equal(truncated.models.length, 3000);
  assert.equal(truncated.truncated, true);
  assert.equal(net.pickModelList({ error: 'nope' }).code, 'not_json');
  assert.equal(net.pickModelList('["str"]').code, 'not_json');
  assert.equal(net.pickModelList({ data: [] }).models.length, 0);
});

/* ---------- 第二轮独立验收回归（FIX-01/02/03/06） ---------- */

test('FIX-01: string entries are subject to the same secret filter as objects', async () => {
  const { net } = await modules();
  const SECRET = 'sentinel-key-FULL';
  const picked = net.pickModelList({ data: [
    'plain-model',
    `${SECRET}`,
    `pre-${SECRET}-post`,
    `len-${SECRET.length}`,
    { id: `also-${SECRET}` },
  ] }, [SECRET]);
  assert.equal(picked.ok, true);
  assert.deepEqual(picked.models.map(model => model.id), ['plain-model', 'len-17']);
  // 完整密钥子串也拒（防有序拼接绕过）。
  const half = net.pickModelList({ data: ['x-y-' + SECRET.slice(0, 8) + '-tail'] }, [SECRET.slice(0, 8)]);
  assert.equal(half.models.length, 0, 'partial secrets never leak either');
  // 恶意字符串条目（控制字符/超长/空）过滤。
  const junk = net.pickModelList({ data: ['', '   ', 'a'.repeat(400), 'bad\u0000id', 'ok-id'] });
  assert.deepEqual(junk.models.map(model => model.id), ['ok-id']);
});

test('FIX-02: a consent revoked or aborted during DNS never produces a request', async t => {
  const { net, consent } = await modules();
  const store = consent.createDiscoveryConsentStore({ now: () => 1_000_000 });
  t.after(() => store.dispose());
  const issued = await consentFor(store);
  let sent = 0;
  const requester = () => {
    sent += 1;
    const req = new EventEmitter();
    req.end = () => req.emit('response', fakeRes({ status: 200, body: '[]' }));
    return req;
  };
  const lookup = async (host, opts, dnsSignal) => {
    store.revoke(issued.consentId);
    if (dnsSignal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    return [{ address: '93.184.216.34', family: 4 }];
  };
  const transport = net.createDiscoveryTransport({ consentStore: store, lookup, io: { requester } });
  const revoked = await transport({ consentId: issued.consentId, url: issued.candidatePaths[0] });
  assert.equal(revoked.code, 'invalid_target');
  assert.equal(sent, 0, 'no socket work after revocation');

  // 外部 Abort 期间 DNS 挂起：解析与请求都必须终止。
  const store2 = consent.createDiscoveryConsentStore({ now: () => 1_000_000 });
  t.after(() => store2.dispose());
  const issued2 = await consentFor(store2);
  const lookup2 = (host, opts, dnsSignal) => new Promise((resolve, reject) => { dnsSignal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); });
  const transport2 = net.createDiscoveryTransport({ consentStore: store2, lookup: lookup2, io: { requester } });
  const controller = new AbortController();
  const pending = transport2({ consentId: issued2.consentId, url: issued2.candidatePaths[0], signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const aborted = await pending;
  assert.equal(aborted.code, 'aborted');
  assert.equal(sent, 0, 'abort during DNS also prevents any request');
});

const publicAddresses = [{ address: '93.184.216.34', family: 4 }];
const byNextTurn = pending => Promise.race([pending, nextTurn('pending')]);

test('FIX-06/07: a candidate gets only the total deadline left after DNS', async t => {
  const { net, consent } = await modules();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const store = consent.createDiscoveryConsentStore();
  t.after(() => store.dispose());
  const issued = await consentFor(store);
  const dns = Promise.withResolvers();
  const requester = fakeRequester([() => { /* response stays pending */ }]);
  const transport = net.createDiscoveryTransport({ consentStore: store, lookup: () => dns.promise,
    maxTotalMs: 100, now: Date.now, io: { requester } });
  const pending = transport({ consentId: issued.consentId, url: issued.candidatePaths[0] });
  t.mock.timers.tick(90);
  dns.resolve(publicAddresses);
  await nextTurn();
  assert.equal(requester.requests.length, 1, 'one pinned request may use the remaining budget');
  t.mock.timers.tick(9);
  assert.equal(await byNextTurn(pending), 'pending');
  t.mock.timers.tick(1);
  assert.equal((await byNextTurn(pending))?.code, 'timeout');
  assert.equal(requester.requests[0].signal.aborted, true);
  assert.equal(requester.requests.length, 1, 'no retry after the total deadline');
});

for (const [name, cancel, finishDns, expected] of [
  ['hung DNS', ({ timers }) => timers.tick(100), () => {}, 'timeout'],
  ['external abort during hung DNS', ({ controller }) => controller.abort(), dns => dns.resolve(publicAddresses), 'aborted'],
  ['DNS resolves after timeout', ({ timers }) => timers.tick(100), dns => dns.resolve(publicAddresses), 'timeout'],
  ['DNS rejects after timeout', ({ timers }) => timers.tick(100), dns => dns.reject(new Error('late lookup')), 'timeout'],
]) {
  test(`FIX-07: ${name} cannot send a request`, async t => {
    const { net, consent } = await modules();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const store = consent.createDiscoveryConsentStore();
    t.after(() => store.dispose());
    const issued = await consentFor(store);
    const dns = Promise.withResolvers();
    const controller = new AbortController();
    const requester = fakeRequester([() => {}]);
    let lookupSignal;
    const lookup = (_host, _options, signal) => { lookupSignal = signal; return dns.promise; };
    const transport = net.createDiscoveryTransport({ consentStore: store, lookup, maxTotalMs: 100,
      now: Date.now, io: { requester } });
    const pending = transport({ consentId: issued.consentId, url: issued.candidatePaths[0], signal: controller.signal });
    await nextTurn();
    assert.ok(lookupSignal);
    cancel({ timers: t.mock.timers, controller });
    const result = await byNextTurn(pending);
    finishDns(dns);
    await nextTurn();
    assert.equal(result?.code, expected, 'discover must settle while DNS is still pending');
    assert.equal(lookupSignal.aborted, true);
    assert.equal(requester.requests.length, 0);
    assert.equal(getEventListeners(lookupSignal, 'abort').length, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

for (const [name, invalidate] of [
  ['revoke', (store, issued) => assert.equal(store.revoke(issued.consentId), true)],
  ['close draft', store => assert.equal(store.revokeDraft('draft-a'), 1)],
  ['change connection', store => assert.equal(store.revokeDraftConnection('draft-a', 2), 1)],
  ['expire', (_store, _issued, timers) => timers.tick(50)],
  ['dispose', store => store.dispose()],
]) {
  test(`FIX-08: ${name} aborts an active request and discards its late models`, async t => {
    const { net, consent } = await modules();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const store = consent.createDiscoveryConsentStore({ ttlMs: 50 });
    t.after(() => store.dispose());
    const issued = await consentFor(store);
    const sent = Promise.withResolvers();
    const requester = fakeRequester([
      (req, options) => sent.resolve({ req, options }),
      req => req.emit('response', fakeRes({ body: '{"data":["new-model"]}' })),
    ]);
    const transport = net.createDiscoveryTransport({ consentStore: store, lookup: async () => publicAddresses,
      now: Date.now, io: { requester } });
    const pending = transport({ consentId: issued.consentId, url: issued.candidatePaths[0] });
    const { req, options } = await sent.promise;
    invalidate(store, issued, t.mock.timers);
    const result = await byNextTurn(pending);
    req.emit('response', fakeRes({ body: '{"data":["old-model"]}' }));
    const completed = await pending;
    assert.equal(completed.code, 'invalid_target', 'the old response must not return models');
    assert.equal(completed.models, undefined);
    assert.equal(result, completed, 'invalidation must settle before the requester responds');
    assert.equal(options.signal.aborted, true);
    assert.equal(requester.requests.length, 1);

    if (name !== 'dispose') {
      const fresh = await consentFor(store, { connectionRevision: 2 });
      const response = await transport({ consentId: fresh.consentId, url: fresh.candidatePaths[0] });
      assert.deepEqual(response.models, [{ id: 'new-model' }]);
    }
  });
}

test('FIX-08: revocation after response end but before discovery returns wins', async t => {
  const { net, consent } = await modules();
  const store = consent.createDiscoveryConsentStore();
  t.after(() => store.dispose());
  const issued = await consentFor(store);
  const requester = fakeRequester([req => {
    const res = fakeRes({ body: '{"data":["racing-model"]}' });
    req.emit('response', res);
    res.on('end', () => store.revoke(issued.consentId));
  }]);
  const transport = net.createDiscoveryTransport({ consentStore: store, lookup: async () => publicAddresses,
    io: { requester } });
  const result = await transport({ consentId: issued.consentId, url: issued.candidatePaths[0] });
  assert.equal(result.code, 'invalid_target');
  assert.equal(result.models, undefined);
});

test('FIX-07: redirect rejection closes a socket with an unfinished response', async t => {
  const { net, consent } = await modules();
  const store = consent.createDiscoveryConsentStore();
  t.after(() => store.dispose());
  const closed = Promise.withResolvers();
  const server = http.createServer((_req, res) => {
    res.once('close', closed.resolve);
    res.writeHead(302, { location: 'https://fixture.invalid/models' });
    res.write('unfinished');
  });
  server.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const issued = await consentFor(store, { loopback: true,
    connection: { ...httpsConnection, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } });
  const transport = net.createDiscoveryTransport({ consentStore: store });
  const result = await transport({ consentId: issued.consentId, url: issued.candidatePaths[0] });
  assert.equal(result.code, 'redirect_rejected');
  const deadline = AbortSignal.timeout(1000);
  const onTimeout = () => closed.reject(new Error('redirect response stayed open'));
  deadline.addEventListener('abort', onTimeout, { once: true });
  try { await closed.promise; }
  finally { deadline.removeEventListener('abort', onTimeout); }
});

test('FIX-07: pinned requests bypass the global agent and its proxy or pooled sockets', async t => {
  const { net, consent } = await modules();
  const store = consent.createDiscoveryConsentStore();
  t.after(() => store.dispose());
  const issued = await consentFor(store);
  const requester = fakeRequester([req => req.emit('response', fakeRes({ body: '[]' }))]);
  const transport = net.createDiscoveryTransport({ consentStore: store, lookup: async () => publicAddresses,
    io: { requester } });
  const result = await transport({ consentId: issued.consentId, url: issued.candidatePaths[0] });
  assert.equal(result.ok, true);
  assert.equal(requester.requests[0].agent, false);
});
test('P3 scopes known directory suffixes and rejects ambiguous path escapes', async () => {
  const { net, consent } = await modules();
  assert.deepEqual(net.planScopedCandidates({ baseUrl: 'https://fixture.invalid/tenant-a/v1', api: 'openai-completions' }),
    ['https://fixture.invalid/tenant-a/v1/models']);
  assert.deepEqual(net.planScopedCandidates({ baseUrl: 'https://fixture.invalid/tenant%252fescape/v1', api: 'openai-completions' }), []);
  assert.equal(net.targetPolicy({ target: net.parseTarget('http://localhost:5000'), addressClass: 'public',
    credentialAttached: false, loopbackAuthorized: true }), 'private_address');
  const store = consent.createDiscoveryConsentStore({ strict: true });
  const { consentId } = await consentFor(store);
  const url = 'https://api.fixture.invalid/v10/models';
  const requester = fakeRequester([req => req.emit('response', fakeRes({ body: '{"data":[]}' }))]);
  const lookup = async () => [{ address: '93.184.216.34' }];
  const forgedView = { get: id => ({ ...store.get(id), candidatePaths: [url] }) };
  for (const consentStore of [store, forgedView]) {
    const transport = net.createDiscoveryTransport({ consentStore, io: { requester, lookup } });
    assert.equal((await transport({ consentId, url })).code, 'policy_rejected');
  }
  assert.equal(requester.requests.length, 0);
});

test('P3 accepts standard Anthropic and Google directory metadata while keeping the output closed', async () => {
  const net = await import('../server/provider-network.js');
  const anthropic = net.pickModelList({ data: [{ id: 'claude-fixture', type: 'model', display_name: 'Fixture', created_at: '2026-01-01T00:00:00Z' }] }, [], 'anthropic-messages');
  assert.deepEqual(anthropic.models, [{ id: 'claude-fixture', name: 'Fixture' }]);
  const google = net.pickModelList({ models: [
    { name: 'models/embed-fixture', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-fixture', description: 'ignored', displayName: 'Fixture', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 100 },
    { name: 'models/gemini-fixture', supportedGenerationMethods: ['generateContent'] },
  ] }, [], 'google-generative-ai');
  assert.deepEqual(google.models, [{ id: 'gemini-fixture', name: 'Fixture', contextWindow: 100, chatCapable: true }]);
  assert.deepEqual(net.pickModelList({ models: [{ name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] }, [], 'google-generative-ai').models, []);
  assert.equal(net.pickModelList({ data: [{ id: 'sentinel-fixture', object: 'model' }] }, ['sentinel-fixture'], 'openai-completions').code, 'not_json');
});
