'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { createSystemNetwork, updateEndpointPolicy } = require('../electron/system-network.cjs');
const { DEFAULTS } = require('../lib/system-network-policy.cjs');

function store(initial = DEFAULTS) {
  let settings = { ...initial };
  return { snapshot: () => ({ settings, status: 'saved', error: '' }), async save(value) { settings = value; return { ok: true }; } };
}

test('saved, Chromium and backend startup policy remain separate; save never restarts Pi', async () => {
  const policies = [];
  const owner = await createSystemNetwork({ store: store(), onEndpointPolicy: async value => policies.push(value) });
  const custom = { ...DEFAULTS, mode: 'custom', proxy: 'http://127.0.0.1:8123', relaxed: true };
  assert.equal((await owner.save(custom)).ok, true);
  const value = owner.snapshot();
  assert.equal(value.saved.mode, 'custom'); assert.equal(value.effective.electron.mode, 'custom');
  assert.equal(value.effective.backendStartup.mode, 'system'); assert.equal(value.effective.pi.configuredMode, 'system');
  assert.equal(value.effective.pi.routeVerified, false);
  assert.equal(value.restartRequired, true);
  assert.deepEqual(policies, [true]);
  assert.equal((await owner.save({ ...custom, relaxed: false })).ok, true);
  assert.deepEqual(policies, [true, false]);
});

test('failed strict-policy delivery stays unconfirmed across same-value saves until the backend ACK succeeds', async () => {
  let backendRelaxed = true, calls = 0;
  const owner = await createSystemNetwork({ store: store({ ...DEFAULTS, relaxed: true }), onEndpointPolicy: async value => {
    calls++; if (calls <= 2) throw Error('message not delivered'); backendRelaxed = value;
  } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await owner.save({ ...DEFAULTS, relaxed: false });
    assert.equal(result.ok, false); assert.equal(result.code, 'network_recovery_required');
    assert.equal(result.snapshot.endpointPermissions, 'unconfirmed');
    assert.equal(result.snapshot.saved.relaxed, false);
    assert.match(result.snapshot.error, /后端端点权限尚未确认。.*重试保存网络设置/u);
    assert.equal(backendRelaxed, true);
  }
  const result = await owner.save({ ...DEFAULTS, relaxed: false });
  assert.equal(calls, 3); assert.equal(result.ok, true); assert.equal(backendRelaxed, false);
  assert.equal(result.snapshot.endpointPermissions, 'strict'); assert.equal(result.snapshot.error, '');
});

test('re-enabling after an unconfirmed disable establishes a backend revocation barrier first', async () => {
  let oldGrant = true;
  const calls = [];
  const owner = await createSystemNetwork({ store: store({ ...DEFAULTS, relaxed: true }), onEndpointPolicy: async value => {
    calls.push(value);
    if (calls.length === 1) throw Error('disable not delivered');
    if (!value) oldGrant = false;
  } });
  assert.equal((await owner.save(DEFAULTS)).ok, false);
  assert.equal(oldGrant, true);
  assert.equal((await owner.save({ ...DEFAULTS, relaxed: true })).ok, true);
  assert.deepEqual(calls, [false, false, true]);
  assert.equal(oldGrant, false);
});

test('a lost enabling ACK is retried even when saving back to the startup value', async () => {
  let backendRelaxed = false, calls = 0;
  const owner = await createSystemNetwork({ store: store(), onEndpointPolicy: async value => {
    backendRelaxed = value; if (++calls === 1) throw Error('ACK lost after delivery');
  } });
  assert.equal((await owner.save({ ...DEFAULTS, relaxed: true })).ok, false);
  assert.equal(backendRelaxed, true);
  const result = await owner.save(DEFAULTS);
  assert.equal(result.ok, true); assert.equal(calls, 2); assert.equal(backendRelaxed, false);
  assert.equal(result.snapshot.endpointPermissions, 'strict');
});

test('endpoint policy update acknowledges the exact child and cleans up listeners', async () => {
  const child = new EventEmitter(); child.connected = true;
  child.send = (message, callback) => { callback(); queueMicrotask(() => child.emit('message', {
    type: 'system-endpoint-policy-ack', requestId: message.requestId, ok: true,
    relaxed: message.relaxed, endpointGeneration: 1,
  })); };
  await updateEndpointPolicy(child, false);
  assert.equal(child.listenerCount('message'), 0); assert.equal(child.listenerCount('exit'), 0);

  const mismatch = new EventEmitter(); mismatch.connected = true;
  mismatch.send = (message, callback) => { callback(); queueMicrotask(() => mismatch.emit('message', {
    type: 'system-endpoint-policy-ack', requestId: message.requestId, ok: true,
    relaxed: !message.relaxed, endpointGeneration: 1,
  })); };
  await assert.rejects(updateEndpointPolicy(mismatch, false), /endpoint_policy_unconfirmed/u);
  assert.equal(mismatch.listenerCount('message'), 0); assert.equal(mismatch.listenerCount('exit'), 0);
});

test('unconfirmed endpoint update is not reported as a successful policy save', async () => {
  const owner = await createSystemNetwork({ store: store(), onEndpointPolicy: async () => { throw Error('unconfirmed'); } });
  const result = await owner.save({ ...DEFAULTS, relaxed: true });
  assert.equal(result.ok, false); assert.equal(result.code, 'network_recovery_required');
  assert.equal(result.snapshot.saved.relaxed, true, 'committed preferences are not falsely rolled back');
  const child = new EventEmitter(); child.connected = true; child.send = (_message, callback) => callback();
  await assert.rejects(updateEndpointPolicy(child, false, 20), /endpoint_policy_unconfirmed/u);
  assert.equal(child.listenerCount('message'), 0);
});

test('real IPC disable aborts an in-flight local directory and old grants cannot revive after enable', async t => {
  const http = require('node:http');
  let received;
  const hit = new Promise(resolve => { received = resolve; });
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const sockets = new Set();
  const server = http.createServer((_req, res) => { res.once('close', closed); received(); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-network-revoke-final-'));
  const entry = path.join(root, 'backend.mjs');
  const moduleUrl = name => JSON.stringify(pathToFileURL(path.resolve(__dirname, '../server', name)).href);
  await fs.writeFile(entry, `import { startSystemNetwork } from ${moduleUrl('system-network-agent.js')};
import { createDiscoveryConsentStore } from ${moduleUrl('provider-discovery-consent.js')};
import { createDiscoveryTransport } from ${moduleUrl('provider-network.js')};
let store;
const state = startSystemNetwork(process.env, { onEndpointPolicyChange: () => store?.revokeLocalEndpoints() });
store = createDiscoveryConsentStore({ strict: true, networkPolicy: () => ({ relaxed: state.relaxed, generation: state.endpointGeneration }) });
const connection = { baseUrl: 'http://127.0.0.1:${server.address().port}/v1', api: 'openai-completions' };
const issued = store.issue({ draftId: 'draft-final', draftRevision: 1, connectionRevision: 1, providerId: 'local-final',
  connection, api: connection.api, credentialSource: 'none', localEndpoint: true });
const signal = store.signalFor(issued.consentId);
const operation = createDiscoveryTransport({ consentStore: store })({ consentId: issued.consentId, url: issued.candidatePaths[0] });
process.on('message', async message => { if (message?.type === 'read') process.send({ type: 'view',
  relaxed: state.relaxed, generation: state.endpointGeneration, aborted: signal.aborted,
  valid: !!store.get(issued.consentId), operationOk: (await operation).ok }); });
process.send({ type: 'ready' });\n`);
  const env = { ...process.env, PI_GUI_DESKTOP: '1', PI_GUI_NETWORK_RELAXED: '1' }; delete env.PI_GUI_SYSTEM_PROXY;
  const child = fork(entry, [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true });
  });
  const receive = type => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', listen); reject(Error('fixture timeout')); }, 5000);
    function listen(message) { if (message?.type === type) { clearTimeout(timer); child.off('message', listen); resolve(message); } }
    child.on('message', listen);
  });
  await receive('ready');
  await Promise.race([hit, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('directory not reached')), 5000); timer.unref(); })]);
  await updateEndpointPolicy(child, false);
  await Promise.race([disconnected, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('directory socket not aborted')), 1000); timer.unref(); })]);
  await updateEndpointPolicy(child, true);
  const view = receive('view'); child.send({ type: 'read' });
  assert.deepEqual(await view, { type: 'view', relaxed: true, generation: 1, aborted: true, valid: false, operationOk: false });
});

test('real backend child applies private permission update without changing its proxy transport', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-network-final-'));
  const entry = path.join(root, 'backend.mjs');
  await fs.writeFile(entry, `import { startSystemNetwork } from ${JSON.stringify(pathToFileURL(path.resolve(__dirname, '../server/system-network-agent.js')).href)};
const state = startSystemNetwork();
process.on('message', message => { if (message?.type === 'read') process.send({ type: 'view', relaxed: state.relaxed, privatePresent: Object.hasOwn(process.env, 'PI_GUI_SYSTEM_PROXY') }); });
process.send({ type: 'ready', relaxed: state.relaxed });\n`);
  const env = { ...process.env, PI_GUI_DESKTOP: '1', PI_GUI_NETWORK_RELAXED: '1' };
  delete env.PI_GUI_SYSTEM_PROXY;
  const child = fork(entry, [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => { child.kill(); await fs.rm(root, { recursive: true, force: true }); });
  const receive = type => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', listen); reject(Error('fixture timeout')); }, 5000);
    function listen(message) { if (message?.type === type) { clearTimeout(timer); child.off('message', listen); resolve(message); } }
    child.on('message', listen);
  });
  assert.equal((await receive('ready')).relaxed, true);
  await updateEndpointPolicy(child, false);
  const result = receive('view'); child.send({ type: 'read', requestId: randomUUID() });
  assert.deepEqual(await result, { type: 'view', relaxed: false, privatePresent: false });
});
