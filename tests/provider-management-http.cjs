const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const key = 'fixture-key-must-not-be-projected';
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-http-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modelsJson = path.join(root, 'models.json');
  const metadataPath = path.join(root, 'provider-management.json');
  const { createProviders } = await import('../server/providers.js');
  const { createProviderConfigStore } = await import('../server/provider-config-store.js');
  const { createProviderManagement } = await import('../server/provider-management.js');
  const native = new Map();
  const inspect = id => Promise.resolve(native.get(id) ?? { present: false, builtIn: false });
  const legacy = createProviders({ modelsJson, metadataPath, inspectCredential: inspect });
  const make = (enabled = true, nativeCredentials, fault, discovery, runtimeSync, desktopCapabilities) => createProviderManagement({
    store: fault ? createProviderConfigStore({ modelsJson, metadataPath, fault }) : legacy.store,
    inspectCredential: inspect, enabled, nativeCredentials, discovery, now: discovery?.now, runtimeSync, desktopCapabilities });
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

test('management sync is revision-bound, idempotent and exposes a read-only operation receipt', async t => {
  const f = await setup(t);
  const pending = { state: 'pending', reason: 'no_live_runtime', runtimes: [] };
  const deferred = Promise.withResolvers();
  const retry = t.mock.fn(() => deferred.promise);
  const { handle } = f.make(true, null, null, null, { retry, snapshot: () => pending });
  const snapshot = (await http(handle, 'GET', root)).body;
  assert.equal(snapshot.capabilities?.syncMode, 'deferred');
  assert.equal(retry.mock.callCount(), 0);
  const request = { requestId: 'sync-fixture', revision: snapshot.revision };
  const stale = await http(handle, 'POST', `${root}/sync`, { ...request, revision: 'stale' });
  assert.equal(stale.status, 409);
  assert.equal(retry.mock.callCount(), 0);
  const results = await Promise.all([http(handle, 'POST', `${root}/sync`, request), http(handle, 'POST', `${root}/sync`, request)]);
  assert.equal(results[0].status, 202);
  assert.deepEqual(results[0], results[1]);
  assert.equal(retry.mock.callCount(), 1);
  const { operationId } = results[0].body;
  assert.equal((await http(handle, 'GET', `${root}/operations/${operationId}`)).body.state, 'running');
  deferred.resolve(pending);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await http(handle, 'GET', `${root}/operations/${operationId}`)).body,
    { ok: true, kind: 'sync', state: 'success', revision: request.revision, result: { sync: pending } });
  const reuse = await http(handle, 'POST', `${root}/drafts`, { requestId: request.requestId, expectedRevision: snapshot.revision, draft: draft() });
  assert.equal(reuse.body.code, 'request_id_conflict');
});

test('management snapshot does not mix configuration revisions across desktop qualification', async t => {
  const f = await setup(t);
  const desktop = Promise.withResolvers(), entered = Promise.withResolvers();
  const { handle } = f.make(true, null, null, null, {
    snapshot: (_metadata, revision) => { assert.equal(revision, f.legacy.store.read().revision); return { state: 'pending' }; },
  }, () => { entered.resolve(); return desktop.promise; });
  const pending = http(handle, 'GET', root);
  await entered.promise;
  const saved = f.legacy.store.transact({ apply({ config }) { config.providers.example.models[0].name = 'Changed'; } });
  desktop.resolve(null);
  const snapshot = await pending;
  assert.equal(snapshot.body.revision, saved.revision);
  assert.equal(snapshot.body.services[0].models[0].effectiveValues.name, 'Changed');
});

test('discovery requires exact authorization and limits the real transport to the consented base path', async t => {
  const f = await setup(t);
  const sockets = [];
  let time = Date.now();
  const lookup = t.mock.fn(async () => [{ address: '93.184.216.34' }]);
  const requester = options => {
    sockets.push(options);
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      Object.assign(response, { statusCode: 200, headers: {}, destroy() {} });
      req.emit('response', response);
      response.emit('data', Buffer.from(JSON.stringify({ data: [{ id: 'fixture-model', name: 'Fixture model' }] })));
      response.emit('end');
    });
    return req;
  };
  const { handle } = f.make(true, null, null, { now: () => time, io: { requester, lookup } });
  const expectedRevision = (await http(handle, 'GET', root)).body.revision;
  const form = (await http(handle, 'POST', root + '/drafts', { requestId: 'discovery-draft', expectedRevision,
    draft: draft('no-key-fixture', 'https://fixture.invalid/tenant-a/v1') })).body;
  const body = { requestId: 'discover-no-grant', draftId: form.draftId, draftRevision: form.draftRevision,
    consentId: 'unknown', dialogGeneration: 1, requestSeq: 1, force: false };
  const denied = await http(handle, 'POST', root + '/discover', body);
  assert.equal(denied.body.code, 'invalid_target');
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(sockets.length, 0);
  const grant = (await http(handle, 'POST', root + '/discovery-authorizations', { requestId: 'authorize-fixture',
    draftId: form.draftId, draftRevision: form.draftRevision, confirm: true, rememberTarget: true })).body;
  assert.equal(grant.ok, true);
  assert.equal(sockets.length, 0);
  const start = async (requestId, force = false, requestSeq = 1) => http(handle, 'POST', root + '/discover',
    { ...body, requestId, force, requestSeq, consentId: grant.consentId });
  const result = accepted => http(handle, 'GET', `${root}/operations/${accepted.body.operationId}`);
  const accepted = await start('discover-with-grant');
  assert.equal(accepted.status, 202);
  await new Promise(resolve => setImmediate(resolve));
  const first = await result(accepted);
  assert.equal(first.body.result.sourceKind, 'remote');
  assert.equal(first.body.result.models[0].modelId, 'fixture-model');
  assert.deepEqual(sockets.map(o => o.path), ['/tenant-a/v1/models']);
  assert.equal(sockets[0].headers.authorization, undefined);
  assert.deepEqual(await start('discover-with-grant'), accepted);
  const fromCache = await start('discover-cache', false, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await result(fromCache)).body.result.sourceKind, 'cache');
  assert.equal(sockets.length, 1);
  assert.equal((await start('old-discover', true, 1)).body.code, 'config_conflict');
  await start('discover-forced', true, 3);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sockets.length, 2);
  time += 60_000;
  await start('discover-cache-expired', false, 4);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sockets.length, 3);
  assert.equal((await http(handle, 'POST', root + '/discovery-authorizations/revoke', { requestId: 'revoke-fixture', consentId: grant.consentId })).body.revoked, true);
  assert.equal((await result(accepted)).body.result, undefined);
  assert.equal((await start('discover-revoked')).body.code, 'invalid_target');
  assert.equal(sockets.length, 3);
});

test('explicit cancel aborts the requester, rejects conflicting cancel IDs and drops late models', async t => {
  const f = await setup(t);
  const started = Promise.withResolvers();
  let complete;
  let transportSignal;
  const requester = t.mock.fn(options => {
    transportSignal = options.signal;
    const req = new EventEmitter();
    req.end = () => {
      complete = () => {
        const response = new EventEmitter();
        Object.assign(response, { statusCode: 200, headers: {}, destroy() {} });
        req.emit('response', response);
        response.emit('data', Buffer.from('{"data":[{"id":"late-model"}]}'));
        response.emit('end');
      };
      started.resolve();
    };
    return req;
  });
  const { handle } = f.make(true, null, null, { io: { requester, lookup: async () => [{ address: '93.184.216.34' }] } });
  const expectedRevision = (await http(handle, 'GET', root)).body.revision;
  const { body: form } = await http(handle, 'POST', root + '/drafts', { requestId: 'cancel-draft', expectedRevision, draft: draft('cancel-provider') });
  const { draftId, draftRevision } = form;
  const { body: grant } = await http(handle, 'POST', root + '/discovery-authorizations', { requestId: 'cancel-auth', draftId,
    draftRevision, confirm: true, rememberTarget: false });
  const { body: accepted } = await http(handle, 'POST', root + '/discover', { requestId: 'cancel-discover', draftId, draftRevision,
    consentId: grant.consentId, dialogGeneration: 1, requestSeq: 1, force: false });
  await started.promise;
  const operation = `${root}/operations/${accepted.operationId}`;
  const cancel = { requestId: 'cancel-operation' };
  const stopped = await http(handle, 'POST', `${operation}/cancel`, cancel);
  assert.deepEqual(stopped.body, { ok: true, state: 'cancelled' });
  assert.equal(transportSignal.aborted, true);
  complete();
  assert.deepEqual(await http(handle, 'POST', `${operation}/cancel`, cancel), stopped);
  assert.equal((await http(handle, 'POST', `${root}/operations/another/cancel`, cancel)).body.code, 'request_id_conflict');
  const after = await http(handle, 'GET', operation);
  assert.equal(after.body.state, 'cancelled');
  assert.equal(after.body.result, undefined);
  assert.equal(requester.mock.callCount(), 1);
});

test('closing a draft and changing its endpoint both revoke an in-flight discovery', async t => {
  const f = await setup(t);
  for (const action of ['close', 'rebind']) {
    const entered = Promise.withResolvers();
    const dns = Promise.withResolvers();
    const requester = t.mock.fn(() => { throw new Error('unexpected socket'); });
    const { handle, forgetDraft } = f.make(true, null, null, { io: { requester, lookup: () => { entered.resolve(); return dns.promise; } } });
    const expectedRevision = (await http(handle, 'GET', root)).body.revision;
    const { body: form } = await http(handle, 'POST', root + '/drafts', { requestId: `draft-${action}`, expectedRevision, draft: draft('rotating-provider') });
    const { draftId, draftRevision } = form;
    const { body: grant } = await http(handle, 'POST', root + '/discovery-authorizations', { requestId: `grant-${action}`, draftId,
      draftRevision, confirm: true, rememberTarget: false });
    const { body: accepted } = await http(handle, 'POST', root + '/discover', { requestId: `discover-${action}`, draftId,
      draftRevision, consentId: grant.consentId, dialogGeneration: 1, requestSeq: 1, force: false });
    await entered.promise;
    if (action === 'close') forgetDraft(draftId);
    else {
      const edit = await http(handle, 'POST', root + '/drafts', { requestId: 'new-endpoint', expectedRevision, draftId,
        expectedDraftRevision: draftRevision, draft: draft('rotating-provider', 'https://fixture.invalid/rebound/v1') });
      assert.equal(edit.body.consentState, 'unapproved');
      assert.deepEqual(edit.body.cachedModels, []);
    }
    dns.resolve([{ address: '93.184.216.34' }]);
    await new Promise(resolve => setImmediate(resolve));
    const old = (await http(handle, 'GET', `${root}/operations/${accepted.operationId}`)).body;
    assert.equal(old.error.code, 'invalid_target');
    assert.equal(old.result, undefined);
    assert.equal(requester.mock.callCount(), 0);
  }
});

test('native cancellation times out without a stop acknowledgement and leaves the provider reserved', async t => {
  const f = await setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createDiscoveryConsentStore } = await import('../server/provider-discovery-consent.js');
  const consentStore = createDiscoveryConsentStore({ strict: true });
  t.after(() => consentStore.dispose());
  const start = Promise.withResolvers();
  const acknowledgement = Promise.withResolvers();
  let signal;
  const executeNative = t.mock.fn((_grant, _draft, options) => {
    signal = options.signal;
    start.resolve();
    return acknowledgement.promise;
  });
  const { handle, draftSnapshot } = f.make(true, null, null, { consentStore, executeNative, nativeCurrent: () => true, verifyNative: async () => true });
  const expectedRevision = (await http(handle, 'GET', root)).body.revision;
  const { body: form } = await http(handle, 'POST', root + '/drafts', { requestId: 'native-cancel-draft', expectedRevision,
    draft: { ...draft('native-discovery'), authMode: 'pi-credential' } });
  const { draftId, draftRevision } = form;
  const bound = draftSnapshot(draftId);
  const grant = consentStore.issue({ ...bound, api: bound.connection.api, credentialSource: 'staged', credentialRevision: 'stage-epoch', workerEpoch: 'worker-epoch' });
  const body = { requestId: 'native-cancel-discover', draftId, draftRevision, consentId: grant.consentId,
    dialogGeneration: 1, requestSeq: 1, force: false };
  const { body: accepted } = await http(handle, 'POST', root + '/discover', body);
  await start.promise;
  const operation = `${root}/operations/${accepted.operationId}`;
  const cancel = http(handle, 'POST', `${operation}/cancel`, { requestId: 'native-cancel-op' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  t.mock.timers.tick(2000);
  assert.equal((await cancel).body.code, 'timeout');
  assert.equal((await http(handle, 'POST', root + '/discover', { ...body, requestId: 'new-before-ack' })).body.code, 'config_busy');
  acknowledgement.resolve({ ok: true, models: [{ id: 'must-not-publish' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await http(handle, 'GET', operation)).body.result, undefined);
  assert.equal(executeNative.mock.callCount(), 1);
});

test('connection evidence distinguishes HTTP outcomes without proving authentication or inference', async t => {
  const f = await setup(t);
  let statusCode = 200;
  let payload = '{"data":[]}';
  const requester = t.mock.fn(options => {
    assert.equal(options.method, 'GET');
    assert.match(options.path, /\/models$/);
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      Object.assign(response, { statusCode, headers: { 'retry-after': '20' }, destroy() {} });
      req.emit('response', response);
      response.emit('data', Buffer.from(payload));
      response.emit('end');
    });
    return req;
  });
  const env = { OPENAI_API_KEY: 'fixture-env-only', PI_GUI_TOKEN: 'must-not-use-renderer-token' };
  const { handle } = f.make(true, null, null, { env, io: { requester, lookup: async () => [{ address: '93.184.216.34' }] } });
  const expectedRevision = (await http(handle, 'GET', root)).body.revision;
  const custom = (await http(handle, 'POST', root + '/drafts', { requestId: 'test-custom', expectedRevision,
    draft: { ...draft('custom-env'), authMode: 'environment' } })).body;
  assert.equal((await http(handle, 'POST', root + '/discovery-authorizations', { requestId: 'test-custom-auth', draftId: custom.draftId,
    draftRevision: custom.draftRevision, confirm: true, rememberTarget: false })).body.code, 'environment_target_unsupported');
  assert.equal(requester.mock.callCount(), 0);
  const { body: form } = await http(handle, 'POST', root + '/drafts', { requestId: 'test-preset', expectedRevision,
    draft: { ...draft('openai', 'https://api.openai.com/v1'), authMode: 'environment',
      connection: { baseUrl: 'https://api.openai.com/v1', api: 'openai-responses' } } });
  const { draftId, draftRevision } = form;
  const { body: grant } = await http(handle, 'POST', root + '/discovery-authorizations', { requestId: 'test-preset-auth',
    draftId, draftRevision, confirm: true, rememberTarget: false });
  let seq = 0;
  for (const [status, code] of [[200, undefined], [401, 'http_401'], [403, 'http_403'], [404, 'http_404'], [429, 'http_429'], [200, 'not_json']]) {
    statusCode = status;
    payload = code ? 'untrusted raw response fixture-env-only' : '{"data":[]}';
    const { body: accepted } = await http(handle, 'POST', root + '/test', { requestId: `test-${++seq}`, draftId,
      draftRevision, consentId: grant.consentId, dialogGeneration: 1, requestSeq: seq, force: false });
    await new Promise(resolve => setImmediate(resolve));
    const { body: result } = await http(handle, 'GET', `${root}/operations/${accepted.operationId}`);
    assert.equal(result.error?.code, code);
    assert.equal(result.result.reachability, true);
    assert.equal(result.result.modelListAccess, !code);
    assert.equal(result.result.credentialAccepted, null);
    assert.equal(result.result.inferenceVerified, false);
    assert.equal(Number.isFinite(result.result.retryAt), status === 429);
    assert.ok(!JSON.stringify(result).includes('fixture-env-only'));
  }
  assert.equal(requester.mock.calls[0].arguments[0].headers.authorization, 'Bearer fixture-env-only');
  env.OPENAI_API_KEY = 'rotated-fixture';
  const stale = await http(handle, 'POST', root + '/test', { requestId: 'test-rotated', draftId, draftRevision,
    consentId: grant.consentId, dialogGeneration: 1, requestSeq: seq + 1, force: true });
  assert.equal(stale.body.code, 'invalid_target');
});

test('duplicate native commits share one config-first dispatch and a durable partial failure', async t => {
  const f = await setup(t);
  let calls = 0;
  const nativeCredentials = {
    authorize: binding => binding,
    async persist(approval) {
      calls++;
      assert.equal(approval.providerId, 'native-fixture');
      const config = JSON.parse(fs.readFileSync(f.modelsJson, 'utf8'));
      assert.equal(config.providers['native-fixture'].baseUrl, 'https://fixture.invalid/v1');
      assert.equal(config.misc.a, true);
      return { ok: false, credentialSaved: false, code: 'native_write_failed', message: key };
    },
  };
  const { handle } = f.make(true, nativeCredentials);
  const expectedRevision = (await http(handle, 'GET', root)).body.revision;
  const d = await http(handle, 'POST', root + '/drafts', { requestId: 'native-draft', expectedRevision,
    draft: { ...draft('native-fixture'), authMode: 'pi-credential' } });
  const request = { requestId: 'native-commit', action: 'create', expectedRevision, draftId: d.body.draftId,
    draftRevision: d.body.draftRevision, credentialAction: { type: 'apply-staged' } };
  const [first, second] = await Promise.all([http(handle, 'POST', root + '/commit', request), http(handle, 'POST', root + '/commit', request)]);
  assert.equal(first.status, 200);
  assert.equal(first.body.saved, true);
  assert.equal(first.body.credentialSaved, false);
  assert.equal(first.body.credentialState, 'saved-credential-error');
  assert.ok(!JSON.stringify(first).includes(key));
  assert.deepEqual(second, first);
  assert.deepEqual(await http(f.make(true, nativeCredentials).handle, 'POST', root + '/commit', request), first);
  const conflict = await http(handle, 'POST', root + '/commit', { ...request, credentialAction: { type: 'clear-native' } });
  assert.equal(conflict.body.code, 'request_id_conflict');
  assert.equal(calls, 1);
});

for (const [checkpoint, callsExpected, credentialState] of [
  ['before-credential-dispatch', 0, 'saved-credential-error'],
  ['before-credential-finish', 1, 'credential-unconfirmed'],
]) {
  test(`a restart at ${checkpoint} recovers config and never replays a credential write`, async t => {
    const f = await setup(t);
    let calls = 0;
    const nativeCredentials = { authorize: binding => binding, persist() {
      calls++;
      return { ok: true, credentialSaved: true, credentialState: 'saved' };
    } };
    const { handle } = f.make(true, nativeCredentials, stage => {
      if (stage === checkpoint) throw new Error('simulated crash');
    });
    const expectedRevision = (await http(handle, 'GET', root)).body.revision;
    const d = await http(handle, 'POST', root + '/drafts', { requestId: 'crash-draft', expectedRevision,
      draft: { ...draft('crash-fixture'), authMode: 'pi-credential' } });
    const request = { requestId: 'crash-commit', action: 'create', expectedRevision, draftId: d.body.draftId,
      draftRevision: d.body.draftRevision, credentialAction: { type: 'apply-staged' } };
    const interrupted = await http(handle, 'POST', root + '/commit', request);
    assert.notEqual(interrupted.body.credentialSaved, true);
    assert.equal(calls, callsExpected);
    const config = fs.readFileSync(f.modelsJson);
    assert.ok(JSON.parse(config).providers['crash-fixture']);
    const { handle: reopened } = f.make(true, nativeCredentials);
    const recovered = await http(reopened, 'POST', root + '/commit', request);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.saved, true);
    assert.equal(recovered.body.credentialState, credentialState);
    assert.equal(recovered.body.credentialSaved, callsExpected ? null : false);
    assert.deepEqual(await http(reopened, 'POST', root + '/commit', request), recovered);
    assert.deepEqual(fs.readFileSync(f.modelsJson), config);
    assert.equal(calls, callsExpected);
  });
}

test('a native call that ignores cancellation releases the config lock but remains isolated', async t => {
  const f = await setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let sent, finish, signal, onQuiesced;
  const started = new Promise(resolve => { sent = resolve; });
  const native = new Promise(resolve => { finish = resolve; });
  const nativeCredentials = { authorize: binding => binding, qualifyAfter: () => true, persist(_approval, options) {
    signal = options?.signal;
    onQuiesced = options?.onQuiesced;
    sent();
    return native;
  } };
  const { handle } = f.make(true, nativeCredentials);
  const expectedRevision = (await http(handle, 'GET', root)).body.revision;
  const d = await http(handle, 'POST', root + '/drafts', { requestId: 'timeout-draft', expectedRevision,
    draft: { ...draft('timeout-fixture'), authMode: 'pi-credential' } });
  const request = { requestId: 'timeout-commit', action: 'create', expectedRevision, draftId: d.body.draftId,
    draftRevision: d.body.draftRevision, credentialAction: { type: 'apply-staged' } };
  const pending = http(handle, 'POST', root + '/commit', request);
  await started;
  t.mock.timers.tick(30_000);
  assert.equal(signal?.aborted, true);
  const result = await pending;
  assert.equal(result.body.credentialState, 'credential-unconfirmed');
  const change = await http(f.legacy.handle, 'POST', '/api/providers', { name: 'timeout-fixture',
    config: { baseUrl: 'https://elsewhere.invalid', api: 'openai-completions', models: [{ id: 'model-a' }] } });
  assert.equal(change.body.code, 'config_busy');
  const other = await http(f.legacy.handle, 'POST', '/api/providers', { name: 'unrelated-fixture',
    config: { baseUrl: 'https://elsewhere.invalid', api: 'openai-completions', models: [{ id: 'model-a' }] } });
  assert.equal(other.status, 200);
  finish({ ok: true, credentialSaved: true, credentialState: 'saved' });
  assert.deepEqual(await http(handle, 'POST', root + '/commit', request), result);
  await onQuiesced();
  const recovered = await http(f.legacy.handle, 'POST', '/api/providers', { name: 'timeout-fixture',
    config: { baseUrl: 'https://elsewhere.invalid', api: 'openai-completions', models: [{ id: 'model-a' }] } });
  assert.equal(recovered.status, 200);
  assert.deepEqual(await http(handle, 'POST', root + '/commit', request), result);
});

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

test('legacy route still supports update and create while management is disabled', async t => {
  const f = await setup(t);
  const listed = await http(f.legacy.handle, 'GET', '/api/providers');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.providers.example.apiKey, undefined);
  const updated = await http(f.legacy.handle, 'POST', '/api/providers', {
    name: 'example',
    config: {
      baseUrl: 'https://fixture.invalid/v1',
      api: 'openai-completions',
      models: [{ id: 'model-a', name: 'After' }, { id: 'model-b' }],
    },
  });
  assert.equal(updated.status, 200);
  const afterUpdate = JSON.parse(fs.readFileSync(f.modelsJson));
  assert.equal(afterUpdate.providers.example.apiKey, key, 'omitting apiKey must preserve the existing value');
  assert.equal(afterUpdate.providers.example.headers.Authorization, key);
  assert.equal(afterUpdate.providers.example.models[0].name, 'After');
  assert.equal(afterUpdate.providers.example.models[0].unknown.value, key);
  assert.ok(afterUpdate.providers.example.models.some(model => model.id === 'model-b'));

  const created = await http(f.legacy.handle, 'POST', '/api/providers', {
    name: 'legacy-custom',
    config: { baseUrl: 'https://legacy.invalid/v1', api: 'openai-completions', apiKey: '$LEGACY_KEY', models: [{ id: 'legacy-model' }] },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.keyState.kind, 'env');
  const afterCreate = JSON.parse(fs.readFileSync(f.modelsJson));
  assert.equal(afterCreate.providers['legacy-custom'].apiKey, '$LEGACY_KEY');
  assert.equal(afterCreate.misc.a, true);
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

test('builtin API-key provider accepts an environment reference with the legacy guards', async t => {
  const f = await setup(t);
  f.native.set('openai', { present: false, builtIn: true });
  f.native.set('deepseek', { present: false, builtIn: true });
  f.native.set('anthropic', { present: true, builtIn: true, type: 'oauth' });
  const { handle } = f.make(true);
  const snapshot = (await http(handle, 'GET', root)).body;
  const connection = { baseUrl: 'https://api.openai.com/v1', api: 'openai-responses' };
  const draftFor = providerId => ({ providerId, displayName: providerId, authMode: 'environment', connection,
    enabled: true, modelPatches: [], selectedModelIds: [], modelOrder: [] });
  const create = (requestId, providerId, over = {}) => http(handle, 'POST', root + '/drafts', { requestId, expectedRevision: snapshot.revision,
    draft: { ...draftFor(providerId), ...over } });

  // 预设端点 + 无原生凭据：创建成功并写入 env 引用（与旧入口同一语义）。
  const form = (await create('builtin-env-draft', 'openai')).body;
  assert.equal(form.ok, true);
  const commit = await http(handle, 'POST', root + '/commit', { requestId: 'builtin-env-commit', expectedRevision: snapshot.revision,
    action: 'create', draftId: form.draftId, draftRevision: form.draftRevision, credentialAction: { type: 'env', reference: '$OPENAI_API_KEY' } });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  assert.equal(commit.body.saved, true);
  const saved = JSON.parse(fs.readFileSync(f.modelsJson, 'utf8'));
  assert.deepEqual(saved.providers.openai, { baseUrl: 'https://api.openai.com/v1', api: 'openai-responses', models: [], apiKey: '$OPENAI_API_KEY' });
  assert.deepEqual(saved.misc, { a: true }, 'unknown top-level fields stay untouched');

  // 非预设端点：拒绝（换端点必须复制为新标识）。
  const proxy = await http(handle, 'POST', root + '/drafts', { requestId: 'builtin-proxy-draft', expectedRevision: commit.body.revision,
    draft: { ...draftFor('deepseek'), connection: { baseUrl: 'https://proxy.invalid/v1', api: 'openai-completions' } } });
  assert.equal(proxy.status, 200);
  const proxyCommit = await http(handle, 'POST', root + '/commit', { requestId: 'builtin-proxy-commit', expectedRevision: commit.body.revision,
    action: 'create', draftId: proxy.body.draftId, draftRevision: proxy.body.draftRevision, credentialAction: { type: 'env', reference: '$DEEPSEEK_API_KEY' } });
  assert.equal(proxyCommit.status, 409);
  assert.equal(proxyCommit.body.code, 'credential_target_conflict');

  // 原生凭据不可证明为空：拒绝（与旧入口一致）。
  const occupied = await http(handle, 'POST', root + '/drafts', { requestId: 'builtin-oauth-draft', expectedRevision: commit.body.revision,
    draft: { ...draftFor('anthropic'), connection: { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' } } });
  assert.equal(occupied.status, 200);
  const occupiedCommit = await http(handle, 'POST', root + '/commit', { requestId: 'builtin-oauth-commit', expectedRevision: commit.body.revision,
    action: 'create', draftId: occupied.body.draftId, draftRevision: occupied.body.draftRevision, credentialAction: { type: 'env', reference: '$ANTHROPIC_API_KEY' } });
  assert.equal(occupiedCommit.status, 409);
  assert.equal(occupiedCommit.body.code, 'credential_conflict');

  // 原生化对内置仍不开放（没有精确的 Endpoint 证据）。
  const nativeCommit = await http(handle, 'POST', root + '/commit', { requestId: 'builtin-native-commit', expectedRevision: commit.body.revision,
    action: 'create', draftId: form.draftId, draftRevision: form.draftRevision, credentialAction: { type: 'apply-staged' } });
  assert.equal(nativeCommit.status, 422);
  assert.equal(nativeCommit.body.code, 'unsupported');
});

test('disable and enable are symmetric metadata-only actions for services without drafts', async t => {
  const f = await setup(t);
  const { handle } = f.make(true);
  const snapshot = (await http(handle, 'GET', root)).body;
  const disable = await http(handle, 'POST', root + '/commit', { requestId: 'disable-fixture', expectedRevision: snapshot.revision,
    action: 'disable', serviceId: 'example' });
  assert.equal(disable.status, 200, JSON.stringify(disable.body));
  assert.equal(disable.body.saved, true);
  let metadata = JSON.parse(fs.readFileSync(f.metadataPath, 'utf8'));
  assert.equal(metadata.services.example.enabled, false);
  const before = JSON.parse(fs.readFileSync(f.modelsJson, 'utf8'));
  const enable = await http(handle, 'POST', root + '/commit', { requestId: 'enable-fixture', expectedRevision: disable.body.revision,
    action: 'enable', serviceId: 'example' });
  assert.equal(enable.status, 200, JSON.stringify(enable.body));
  metadata = JSON.parse(fs.readFileSync(f.metadataPath, 'utf8'));
  assert.equal(metadata.services.example.enabled, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.modelsJson, 'utf8')), before, 'enable/disable never touch Pi configuration');
  // 不存在的服务：404；带草稿字段的 enable：400（合同拒绝混用）。
  const missing = await http(handle, 'POST', root + '/commit', { requestId: 'enable-missing', expectedRevision: enable.body.revision,
    action: 'enable', serviceId: 'never-existed' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'not_found');
  const malformed = await http(handle, 'POST', root + '/commit', { requestId: 'enable-draft', expectedRevision: enable.body.revision,
    action: 'enable', serviceId: 'example', draftId: 'opaque-draft', draftRevision: 1 });
  assert.equal(malformed.status, 400);
});

const settle = () => new Promise(resolve => setImmediate(resolve));
const terminal = async (handle, operationId, tries = 40) => {
  for (let index = 0; index < tries; index++) {
    const body = (await http(handle, 'GET', `${root}/operations/${operationId}`)).body;
    if (['success', 'failed', 'cancelled'].includes(body.state)) return body;
    await settle();
  }
  throw new Error('operation did not settle');
};

test('service cache endpoint is target/credential bound and never triggers network', async t => {
  const f = await setup(t);
  let time = Date.now();
  let sockets = 0;
  const requester = t.mock.fn(options => {
    sockets += 1;
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      Object.assign(response, { statusCode: 200, headers: {}, destroy() {} });
      req.emit('response', response);
      response.emit('data', Buffer.from(JSON.stringify({ data: [{ id: 'model-a', name: 'A', context_length: 32000 }] })));
      response.emit('end');
    });
    return req;
  });
  const env = { OPENAI_API_KEY: 'fixture-env-key', DEEPSEEK_API_KEY: 'fixture-env-key-2' };
  f.legacy.store.transact({ apply: current => {
    current.config.providers.openai = { baseUrl: 'https://api.openai.com/v1', api: 'openai-responses', apiKey: '$OPENAI_API_KEY', models: [] };
    current.config.providers.deepseek = { baseUrl: 'https://api.deepseek.com', api: 'openai-completions', apiKey: '$DEEPSEEK_API_KEY', models: [] };
    current.metadata.services.openai = { providerId: 'openai', displayName: 'OpenAI', enabled: true, kind: 'builtin' };
    current.metadata.services.deepseek = { providerId: 'deepseek', displayName: 'DeepSeek', enabled: true, kind: 'builtin' };
  } });
  const { handle } = f.make(true, null, null, { now: () => time, io: { requester, lookup: async () => [{ address: '93.184.216.34' }] }, env });
  const snapshot = (await http(handle, 'GET', root)).body;
  const openai = { baseUrl: 'https://api.openai.com/v1', api: 'openai-responses' };
  const draft = (await http(handle, 'POST', root + '/drafts', { requestId: 'cache-draft', expectedRevision: snapshot.revision,
    draft: { providerId: 'openai', displayName: 'OpenAI', authMode: 'environment', connection: openai, enabled: true,
      modelPatches: [], selectedModelIds: [], modelOrder: [] } })).body;
  const grant = (await http(handle, 'POST', root + '/discovery-authorizations', { requestId: 'cache-auth', draftId: draft.draftId,
    draftRevision: draft.draftRevision, confirm: true, rememberTarget: false })).body;
  const accepted = await http(handle, 'POST', root + '/discover', { requestId: 'cache-discover', draftId: draft.draftId,
    draftRevision: draft.draftRevision, consentId: grant.consentId, dialogGeneration: 1, requestSeq: 1, force: false });
  assert.equal((await terminal(handle, accepted.body.operationId)).result.sourceKind, 'remote');
  assert.equal(sockets, 1);
  const cache = async serviceId => http(handle, 'GET', `${root}/services/${serviceId}/cache`);

  const fresh = await cache('openai');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.sourceKind, 'cache');
  assert.deepEqual(fresh.body.cachedModels.map(model => model.modelId), ['model-a']);
  assert.equal(fresh.body.cachedModels[0].configSource, 'cache');
  assert.equal(fresh.body.cachedModels[0].effectiveValues.contextWindow, 32000);
  assert.equal(fresh.body.cacheStale, false);
  assert.equal(typeof fresh.body.cachedAt, 'number');
  assert.equal(sockets, 1, 'cache read never requests the provider');

  const otherProvider = await cache('deepseek');
  assert.equal(otherProvider.body.cachedModels.length, 0, 'different provider never shares cache');
  assert.equal(otherProvider.body.sourceKind, 'none');

  time += 61_000;
  const stale = await cache('openai');
  assert.equal(stale.body.sourceKind, 'cache');
  assert.equal(stale.body.cacheStale, true, 'cache beyond 60s is explicitly marked stale');
  assert.equal(stale.body.cachedModels[0].cacheStale, true);

  time += 15 * 60_000;
  assert.equal((await cache('openai')).body.cachedModels.length, 0, 'cache beyond retention is dropped');

  time += 1_000;
  const freshDraft = (await http(handle, 'POST', root + '/drafts', { requestId: 'cache-draft-2', expectedRevision: snapshot.revision,
    draft: { providerId: 'openai', displayName: 'OpenAI', authMode: 'environment', connection: openai, enabled: true,
      modelPatches: [], selectedModelIds: [], modelOrder: [] } })).body;
  const grant2 = (await http(handle, 'POST', root + '/discovery-authorizations', { requestId: 'cache-auth-2', draftId: freshDraft.draftId,
    draftRevision: freshDraft.draftRevision, confirm: true, rememberTarget: false })).body;
  assert.equal(grant2.ok, true);
  const rediscovered = await http(handle, 'POST', root + '/discover', { requestId: 'cache-rediscover', draftId: freshDraft.draftId,
    draftRevision: freshDraft.draftRevision, consentId: grant2.consentId, dialogGeneration: 1, requestSeq: 1, force: true });
  await terminal(handle, rediscovered.body.operationId);
  assert.equal(sockets, 2);
  assert.equal((await cache('openai')).body.sourceKind, 'cache');
  env.OPENAI_API_KEY = 'rotated-env-key';
  const rotated = await cache('openai');
  assert.equal(rotated.body.cachedModels.length, 0, 'credential generation change invalidates the display cache');
  assert.equal(sockets, 2);

  const unknown = await cache('never-existed');
  assert.equal(unknown.status, 404);
  assert.equal((await http(handle, 'POST', `${root}/services/openai/cache`, { requestId: 'cache-post' })).status, 405);
});

test('environment authorization distinguishes missing variables and unsupported targets and recovers after retry', async t => {
  const f = await setup(t);
  const env = {};
  const { handle } = f.make(true, null, null, { env, io: { requester: () => { throw new Error('unexpected socket'); }, lookup: async () => [{ address: '93.184.216.34' }] } });
  const snapshot = (await http(handle, 'GET', root)).body;
  const openai = { baseUrl: 'https://api.openai.com/v1', api: 'openai-responses' };
  const draftForm = async (providerId, connection, requestId) => (await http(handle, 'POST', root + '/drafts', {
    requestId, expectedRevision: snapshot.revision,
    draft: { providerId, displayName: providerId, authMode: 'environment', connection, enabled: true,
      modelPatches: [], selectedModelIds: [], modelOrder: [] },
  })).body;
  const form = await draftForm('openai', openai, 'env-missing-draft');
  const authorize = requestId => http(handle, 'POST', root + '/discovery-authorizations', { requestId, draftId: form.draftId,
    draftRevision: form.draftRevision, confirm: true, rememberTarget: false });
  const missing = await authorize('env-missing-auth');
  assert.equal(missing.status, 422);
  assert.equal(missing.body.code, 'environment_missing');
  assert.deepEqual(missing.body.fieldErrors, { environmentReference: 'invalid' });
  assert.ok(!JSON.stringify(missing.body).includes('fixture-env-key'));

  env.OPENAI_API_KEY = 'fixture-env-key';
  const recovered = await authorize('env-recovered-auth');
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.ok, true);
  assert.equal(typeof recovered.body.consentId, 'string');

  const custom = await draftForm('example', { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions' }, 'env-target-draft');
  const unsupported = await http(handle, 'POST', root + '/discovery-authorizations', { requestId: 'env-target-auth', draftId: custom.draftId,
    draftRevision: custom.draftRevision, confirm: true, rememberTarget: false });
  assert.equal(unsupported.status, 422);
  assert.equal(unsupported.body.code, 'environment_target_unsupported');
});

test('builtin updates reject endpoint changes explicitly and keep same-target edits working', async t => {
  const f = await setup(t);
  f.native.set('openai', { present: false, builtIn: true });
  const { handle } = f.make(true);
  const legacy = f.legacy;
  const snapshot = (await http(handle, 'GET', root)).body;
  // 干净的内置配置记录 + GUI 元数据 kind=builtin：guardExistingTarget 会放行端点变化，
  // 必须由显式的目标拒绝拦住（FIX-05）。
  legacy.store.transact({ apply: current => {
    current.config.providers.openai = { baseUrl: 'https://api.openai.com/v1', api: 'openai-responses', models: [] };
    current.metadata.services.openai = { providerId: 'openai', displayName: 'OpenAI', enabled: true, kind: 'builtin' };
  } });
  const revision = legacy.store.read().revision;
  const openai = { baseUrl: 'https://api.openai.com/v1', api: 'openai-responses' };
  const draftFor = async (connection, requestId) => (await http(handle, 'POST', root + '/drafts', {
    requestId, serviceId: 'openai', expectedRevision: revision,
    draft: { providerId: 'openai', displayName: 'OpenAI', catalogId: 'openai', authMode: 'environment', connection,
      enabled: true, modelPatches: [], selectedModelIds: [], modelOrder: [] },
  })).body;
  const changed = await draftFor({ baseUrl: 'https://proxy.invalid/v1', api: 'openai-responses' }, 'builtin-target-draft');
  const rejected = await http(handle, 'POST', root + '/commit', { requestId: 'builtin-target-commit', expectedRevision: revision,
    action: 'update', serviceId: 'openai', draftId: changed.draftId, draftRevision: changed.draftRevision,
    credentialAction: { type: 'env', reference: '$OPENAI_API_KEY' } });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'credential_target_conflict');
  assert.equal(legacy.store.read().config.providers.openai.baseUrl, 'https://api.openai.com/v1');

  const same = await draftFor(openai, 'builtin-same-draft');
  const accepted = await http(handle, 'POST', root + '/commit', { requestId: 'builtin-same-commit', expectedRevision: revision,
    action: 'update', serviceId: 'openai', draftId: same.draftId, draftRevision: same.draftRevision,
    credentialAction: { type: 'env', reference: '$OPENAI_API_KEY' } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(legacy.store.read().config.providers.openai.apiKey, '$OPENAI_API_KEY');
});
