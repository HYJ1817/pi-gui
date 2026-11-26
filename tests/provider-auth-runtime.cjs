/* P25 offline bridge/runtime lifecycle fixtures. No real Pi or user data. */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok  ' + name); }
const load = file => import(pathToFileURL(path.resolve(__dirname, '..', file)).href);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(createAuthRuntimeSync, options = {}) {
  let cwd = 'fixture-A', run = 7, busy = false;
  const listeners = new Set(), calls = [], restarts = [];
  const rpc = {
    getState: () => ({ bridgeRun: run }),
    request: async cmd => { calls.push(cmd.type); return options.request ? options.request(cmd, calls.length) : cmd.type === 'get_state' ? { sessionFile: 'fixture-session.jsonl' } : {}; },
    restart: opts => { restarts.push(opts); options.restart?.(); if (!options.manualReady) { run++; queueMicrotask(() => emit({ type: 'bridge_status', state: 'ready', bridgeRun: run })); } },
  };
  function emit(event) { for (const fn of [...listeners]) fn(event); }
  return { rpc, calls, restarts, listeners, emit, setCwd: value => { cwd = value; }, setRun: value => { run = value; }, setBusy: value => { busy = value; },
    sync: createAuthRuntimeSync({ rpc, getCwd: () => cwd, busyReason: () => busy ? 'busy' : null, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, timeoutMs: 35 }) };
}

async function main() {
  const { createAuthRuntimeSync } = await load('server/provider-auth-runtime.js');
  {
    const fx = fixture(createAuthRuntimeSync);
    const result = await fx.sync();
    check('real readback confirms new runtime', () => assert.equal(result.ok, true));
    check('restart receives authoritative current session', () => assert.deepEqual(fx.restarts, [{ sessionPath: 'fixture-session.jsonl' }]));
    check('new state models and thinking levels all read back', () => assert.deepEqual(fx.calls, ['get_state', 'get_state', 'get_available_models', 'get_available_thinking_levels']));
    check('lifecycle subscription removed after ready', () => assert.equal(fx.listeners.size, 0));
  }
  for (const bad of [null, { __error: 'fixture' }, {}, { sessionFile: null }, { sessionFile: '' }, { sessionFile: 'invalid\npath' }]) {
    const fx = fixture(createAuthRuntimeSync, { request: () => bad });
    const result = await fx.sync();
    check('failed initial state readback refuses restart', () => { assert.equal(result.ok, false); assert.equal(fx.restarts.length, 0); });
  }
  {
    const gate = deferred(); const fx = fixture(createAuthRuntimeSync, { request: () => gate.promise });
    const operation = fx.sync(); fx.setCwd('fixture-B'); gate.resolve({ sessionFile: 'fixture-A-session' });
    const result = await operation;
    check('cwd change during initial read does not restart new workspace', () => { assert.equal(result.ok, false); assert.equal(fx.restarts.length, 0); });
  }
  {
    const gate = deferred(); const fx = fixture(createAuthRuntimeSync, { request: () => gate.promise });
    const operation = fx.sync(); fx.setBusy(true); gate.resolve({ sessionFile: 'fixture-A-session' });
    const result = await operation;
    check('busy check rejects restart after state read', () => { assert.equal(result.ok, false); assert.equal(fx.restarts.length, 0); });
  }
  {
    const fx = fixture(createAuthRuntimeSync, { manualReady: true });
    const operation = fx.sync(); await tick(); fx.setCwd('fixture-B'); fx.emit({ type: 'bridge_status', state: 'ready', bridgeRun: 8 });
    const result = await operation;
    check('cwd change during restart fails old synchronization', () => assert.equal(result.ok, false));
    check('changed workspace receives no old follow-up RPC reads', () => assert.deepEqual(fx.calls, ['get_state']));
    check('changed workspace removes lifecycle listener', () => assert.equal(fx.listeners.size, 0));
  }
  for (const state of ['error', 'exited', 'no-project']) {
    const fx = fixture(createAuthRuntimeSync, { manualReady: true }); const operation = fx.sync(); await tick();
    fx.emit({ type: 'bridge_status', state, bridgeRun: 8 });
    const result = await operation;
    check('failed restart has no false success: ' + state, () => { assert.equal(result.ok, false); assert.equal(fx.calls.length, 1); });
  }
  {
    const fx = fixture(createAuthRuntimeSync, { request: (cmd, n) => n === 1 ? { sessionFile: 'fixture-session.jsonl' } : cmd.type === 'get_available_models' ? { __error: 'fixture' } : {} });
    const result = await fx.sync();
    check('spawn ready cannot conceal failed model readback', () => assert.equal(result.ok, false));
  }
  {
    const gate = deferred();
    const fx = fixture(createAuthRuntimeSync, { request: (_cmd, n) => n === 1 ? { sessionFile: 'fixture-session.jsonl' } : gate.promise });
    const operation = fx.sync(); await tick(); fx.setRun(9); gate.resolve({});
    const result = await operation;
    check('late RPC results from replaced bridge cannot confirm synchronization', () => assert.equal(result.ok, false));
  }
  {
    const fx = fixture(createAuthRuntimeSync, { manualReady: true });
    const result = await fx.sync();
    check('missing ready event times out rather than reporting success', () => assert.equal(result.ok, false));
    check('timeout removes lifecycle subscriber', () => assert.equal(fx.listeners.size, 0));
  }
  {
    const fx = fixture(createAuthRuntimeSync, { manualReady: true }); const operation = fx.sync(); await tick();
    fx.emit({ type: 'bridge_status', state: 'ready', bridgeRun: 7 });
    check('old bridge ready cannot complete restart', () => assert.equal(fx.listeners.size, 1));
    fx.setRun(8); fx.emit({ type: 'bridge_status', state: 'ready', bridgeRun: 8 });
    const result = await operation;
    check('new bridge ready followed by readback completes', () => assert.equal(result.ok, true));
  }
  await bridgeCases(createAuthRuntimeSync);
  await mutationLedgerCases();
  await singleFlightCases();
  const { createProviderConfigSync } = await load('server/provider-config-sync.js');
  let live = false, active = false;
  let intent = { generation: null, unconfirmed: false };
  const coordinator = createProviderConfigSync({ store: { readAuthSyncIntent: () => intent, read: () => ({ metadata: {} }) },
    hasLiveRuntime: () => live, authMutationActive: () => active });
  check('a fresh coordinator with no committed change is idle', () => assert.deepEqual(coordinator.snapshot(), { state: 'idle', reason: null }));
  check('a saved configuration awaits a normal Runtime lifecycle', () => assert.deepEqual(coordinator.snapshot({ syncRequired: true }), { state: 'pending', reason: 'no_live_runtime' }));
  intent = { generation: 'fixture-generation', unconfirmed: false };
  live = true;
  check('an existing Runtime cannot prove it loaded the new auth generation', () => assert.deepEqual(coordinator.snapshot(), { state: 'pending', reason: 'runtime_sync_pending' }));
  intent.unconfirmed = true;
  active = true;
  check('active OAuth write remains pending', () => assert.equal(coordinator.oauthSnapshot().state, 'pending'));
  active = false;
  check('orphaned OAuth write evidence cannot report success', () => assert.deepEqual(coordinator.snapshot(), { state: 'error', reason: 'credential_unconfirmed' }));
  let version = 'before', busy = false, targets = [];
  const expected = [{ provider: 'fixture', id: 'model-a', fields: { maxTokens: 100 } }];
  const sync = createProviderConfigSync({ store: { readSyncEvidence: () => ({ revision: version, native: version, required: true, expected }) }, targets: () => targets });
  const first = sync.capture({ identity: 'pi', version: '1.5.0', agent: 'fixture' });
  version = 'after';
  const current = sync.capture({ identity: 'pi', version: '1.5.0', agent: 'fixture' });
  let reads = 0, token = 'owner-file', modelGate = null, modelFailure = false;
  function target(id, launch) {
    return { id, kind: id === 'classic' ? 'classic' : 'runtime', key: id + '-1', launch, ready: true, busy: () => busy,
      current: () => targets.some(item => item.id === id && item.launch === launch), session: async () => token,
      request: async type => { reads++;
        if (type === 'get_state') return { sessionId: 'fixture', sessionFile: 'fixture-private.jsonl', model: { provider: 'fixture', id: 'model-a' }, thinkingLevel: 'low',
          isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
        if (type === 'get_available_thinking_levels') return { levels: ['off', 'low'] };
        return modelGate ?? (modelFailure ? { __error: 'private fixture error' } : { models: [{ provider: 'fixture', id: 'model-a', maxTokens: 100 }] });
      } };
  }
  targets = [target('classic', first), target('second', current)];
  await sync.retry();
  check('only the Runtime born under the desired configuration may become applied', () => {
    assert.equal(reads, 4);
    assert.deepEqual(sync.snapshot().runtimes.map(item => item.state), ['pending', 'applied']);
    assert.equal(sync.oauthSnapshot().state, 'pending');
  });
  targets = [target('classic', current)];
  busy = true;
  await sync.retry();
  check('busy Runtime receives zero background readback commands', () => { assert.equal(reads, 4); assert.equal(sync.snapshot().state, 'pending'); });
  busy = false; modelFailure = true;
  await sync.retry();
  check('native RPC error is projected as a fixed failure', () => { assert.equal(sync.snapshot().state, 'error'); assert.ok(!JSON.stringify(sync.snapshot()).includes('private fixture error')); });
  modelFailure = false;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  modelGate = { then(resolve, reject) { entered.resolve(); return release.promise.then(resolve, reject); } };
  const late = sync.retry(); await entered.promise;
  token = 'replaced-file'; release.resolve({ models: [{ provider: 'fixture', id: 'model-a', maxTokens: 100 }] });
  await late;
  check('file replacement invalidates an in-flight Runtime readback', () => assert.equal(sync.snapshot().state, 'pending'));
  modelGate = null;
  await sync.retry();
  check('explicit retry can confirm the current stable native instance', () => { assert.equal(sync.snapshot().state, 'applied'); assert.equal(sync.oauthSnapshot().state, 'synced'); });
  console.log(`\n${passed}/${passed} 通过`);
}

async function bridgeCases(createAuthRuntimeSync) {
  const { createRpcBridge } = await load('server/rpc-bridge.js');
  const { createRuntime } = await load('server/runtime.js');
  const runtime = createRuntime({ initialCwd: 'fixture-A' });
  const children = [], launches = [], listeners = new Set(), responses = [];
  let launchRevision = 'revision-one', holdSwitch = false, heldSwitch = null;
  const bridge = createRpcBridge({ runtime, isWin: false, piBin: 'fixture-pi', env: { PI_NO_CONTINUE: '1' }, publish: event => { if (event.type === 'response') responses.push(event); for (const fn of [...listeners]) fn(event); },
    captureProviderLaunch: ({ cwd }) => ({ cwd, revision: launchRevision }),
    spawnProcess: (_bin, args) => {
      launches.push(args);
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      child.stdin = new EventEmitter(); child.stdin.end = () => {};
      child.stdin.write = line => { const cmd = JSON.parse(line);
        if (holdSwitch && cmd.type === 'switch_session') { heldSwitch = { child, cmd }; return; }
        queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: cmd.id, type: 'response', command: cmd.type, success: cmd.type === 'fixture_unqualified' ? undefined : true, data: cmd.type === 'get_state' ? { sessionFile: 'fixture-current-session.jsonl' } : {} }) + '\n')); };
      child.kill = () => { queueMicrotask(() => child.emit('exit', 0, null)); return true; };
      children.push(child); queueMicrotask(() => child.emit('spawn')); return child;
    } });
  try {
    bridge.start(); await tick();
    const unqualified = await bridge.request({ type: 'fixture_unqualified' }, { strict: true });
    check('strict private RPC refuses a missing native success marker', () => assert.equal(unqualified, null));
    const priorEpoch = bridge.providerSessionEpoch();
    await bridge.request({ type: 'switch_session', sessionPath: 'fixture-next-session.jsonl' });
    check('private session switch dispatch and completion both invalidate the Classic owner epoch', () => assert.equal(bridge.providerSessionEpoch(), priorEpoch + 2));
    holdSwitch = true;
    const switching = bridge.request({ type: 'switch_session', sessionPath: 'fixture-pending-session.jsonl' }, { timeoutMs: 20 });
    check('already dispatched private session mutation remains visible without refreshing the owner cache', () => assert.equal(bridge.providerSessionChanging(), true));
    await Promise.all([switching, new Promise(resolve => setTimeout(resolve, 30))]);
    check('private mutation timeout cannot prove that native identity stayed unchanged', () => assert.equal(bridge.providerSessionChanging(), true));
    heldSwitch.child.stdout.emit('data', JSON.stringify({ id: heldSwitch.cmd.id, type: 'response', command: 'switch_session', success: true, data: {} }) + '\n');
    check('late authoritative private mutation response settles the existing command ledger', () => assert.equal(bridge.providerSessionChanging(), false));
    bridge.send({ id: 'public-switch', type: 'switch_session', sessionPath: 'fixture-public-session.jsonl' });
    check('public session mutation uses the same pending authority as private requests', () => assert.equal(bridge.providerSessionChanging(), true));
    heldSwitch.child.stdout.emit('data', JSON.stringify({ id: heldSwitch.cmd.id, type: 'response', command: 'switch_session', success: true, data: {} }) + '\n');
    check('public authoritative mutation response releases only its matching command', () => assert.equal(bridge.providerSessionChanging(), false));
    check('only the public mutation response is broadcast, never the private or expired request', () => assert.deepEqual(responses.map(event => event.id), ['public-switch']));
    responses.length = 0; // The following auth synchronization has its own no-broadcast interval.
    holdSwitch = false;
    launchRevision = 'revision-two';
    check('launch witness remains bound to the actual spawned run', () => assert.deepEqual(bridge.providerLaunch(), { cwd: 'fixture-A', revision: 'revision-one' }));
    const sync = createAuthRuntimeSync({ rpc: bridge, getCwd: runtime.getCurrentCwd, busyReason: () => null, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, timeoutMs: 1000 });
    const result = await sync();
    check('actual bridge fake RPC session reload succeeds', () => assert.equal(result.ok, true));
    check('auth readback uses Promise results without broadcasting SSE responses', () => assert.equal(responses.length, 0));
    check('actual bridge passes exact current session launch argv', () => assert.deepEqual(launches[1], ['--mode', 'rpc', '--session', 'fixture-current-session.jsonl']));
    check('new bridge run captures its own launch witness', () => assert.deepEqual(bridge.providerLaunch(), { cwd: 'fixture-A', revision: 'revision-two' }));
    runtime.setCurrentCwd('fixture-B'); bridge.restart(); await new Promise(resolve => setTimeout(resolve, 15));
    check('session override consumed once and never leaks to next cwd', () => assert.deepEqual(launches[2], ['--mode', 'rpc']));
    check('fake bridge spawned exactly three runs', () => assert.equal(children.length, 3));
    runtime.setCurrentCwd(null); bridge.restart(); await new Promise(resolve => setTimeout(resolve, 15));
    check('no-project auth synchronization succeeds without restarting a workspace', () => assert.equal(children.length, 3));
    const empty = await sync();
    check('no-project needs no chat readback for user-level auth', () => assert.equal(empty.ok, true));
  } finally { runtime.setShuttingDown(true); bridge.stop(); }
}

async function mutationLedgerCases() {
  const { createRpcBridge } = await load('server/rpc-bridge.js');
  const { createRuntime } = await load('server/runtime.js');
  const runtime = createRuntime({ initialCwd: 'fixture-A' });
  const children = [], writes = [], responses = [];
  let failure = null;
  const reply = (child, cmd, extra = {}) => child.stdout.emit('data', JSON.stringify({
    type: 'response', id: cmd.id, command: cmd.type, success: true, data: {}, ...extra,
  }) + '\n');
  const rpc = createRpcBridge({ runtime, isWin: false, piBin: 'fixture', autoRestart: false,
    env: { PI_NO_CONTINUE: '1' }, publish: event => { if (event.type === 'response') responses.push(event); },
    spawnProcess() {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      child.stdin = new EventEmitter(); child.stdin.end = () => {};
      child.stdin.write = (line, callback) => {
        const cmd = JSON.parse(line); writes.push({ child, cmd });
        if (failure) {
          const current = failure; failure = null;
          const error = Object.assign(Error('private transport failure'), { code: current.code });
          if (current.throw) throw error;
          if (current.delay) setTimeout(() => callback?.(error), current.delay);
          else queueMicrotask(() => callback?.(error));
        } else if (cmd.type === 'get_state') queueMicrotask(() => reply(child, cmd));
        return true;
      };
      child.kill = () => { queueMicrotask(() => child.emit('exit', 0, null)); return true; };
      children.push(child); queueMicrotask(() => child.emit('spawn')); return child;
    },
  });
  const lastMutation = () => writes.findLast(row => row.cmd.type === 'switch_session');
  try {
    rpc.start(); await tick();
    for (const transport of [{ code: 'ERR_STREAM_WRITE_AFTER_END', throw: true }, { code: 'ERR_STREAM_WRITE_AFTER_END' }]) {
      failure = transport;
      const result = await rpc.request({ type: 'switch_session', sessionPath: 'fixture-session' });
      check('known unqueued mutation write failure releases only its ledger entry', () => {
        assert.equal(result?.__code, 'pi_command_not_sent'); assert.equal(rpc.providerSessionChanging(), false);
        assert.equal(rpc.updateBusy(), false);
      });
    }
    const circular = {}; circular.self = circular;
    const beforeWrites = writes.length, beforeEpoch = rpc.providerSessionEpoch();
    const unencoded = await rpc.request({ type: 'switch_session', sessionPath: circular });
    check('serialization failure is definitely not sent and creates no mutation authority', () => {
      assert.equal(unencoded?.__code, 'pi_command_not_sent'); assert.equal(writes.length, beforeWrites);
      assert.equal(rpc.providerSessionEpoch(), beforeEpoch); assert.equal(rpc.providerSessionChanging(), false);
    });
    failure = { code: 'ERR_STREAM_WRITE_AFTER_END', delay: 30 };
    const lateFailure = rpc.request({ type: 'switch_session', sessionPath: 'fixture-session' }, { timeoutMs: 5 });
    await Promise.all([lateFailure, new Promise(resolve => setTimeout(resolve, 40))]);
    check('late proof of an unqueued write clears mutation even after the request timed out', () => assert.equal(rpc.providerSessionChanging(), false));
    failure = { code: 'EPIPE' };
    const partial = await rpc.request({ type: 'switch_session', sessionPath: 'fixture-session' });
    const unknown = lastMutation();
    check('ambiguous pipe failure preserves unknown mutation rather than declaring not sent', () => {
      assert.equal(partial, null); assert.equal(rpc.providerSessionChanging(), true);
    });
    reply(unknown.child, unknown.cmd, { command: 'get_state' });
    check('wrong-command response cannot clear unknown mutation', () => assert.equal(rpc.providerSessionChanging(), true));
    reply(unknown.child, unknown.cmd, { success: undefined });
    check('unqualified response cannot clear unknown mutation', () => assert.equal(rpc.providerSessionChanging(), true));
    reply(unknown.child, unknown.cmd, { success: false });
    check('late matching authoritative failure closes the unknown mutation', () => assert.equal(rpc.providerSessionChanging(), false));
    rpc.send({ id: 'reused-public-id', type: 'switch_session', sessionPath: 'first' });
    const first = lastMutation(); reply(first.child, first.cmd);
    const completedEpoch = rpc.providerSessionEpoch();
    reply(first.child, first.cmd);
    check('duplicate authoritative response neither changes epoch nor broadcasts twice', () => {
      assert.equal(rpc.providerSessionEpoch(), completedEpoch); assert.equal(responses.length, 1);
      assert.equal(responses[0].id, 'reused-public-id');
    });
    rpc.send({ id: 'reused-public-id', type: 'switch_session', sessionPath: 'second' });
    const second = lastMutation(); reply(first.child, first.cmd);
    check('late response cannot close a newer public mutation that reused its caller id', () => {
      assert.notEqual(second.cmd.id, first.cmd.id); assert.equal(rpc.providerSessionChanging(), true);
    });
    reply(second.child, second.cmd);
    check('public mutation still broadcasts exactly its caller id on completion', () => {
      assert.equal(rpc.providerSessionChanging(), false); assert.deepEqual(responses.map(event => event.id), ['reused-public-id', 'reused-public-id']);
    });
    rpc.send({ id: 'bash-command-field', type: 'bash', command: 'synthetic-echo' });
    const bash = writes.at(-1);
    check('Bash command text is payload, not the command identity in the ledger', () => {
      assert.equal(rpc.updateBusy(), true); reply(bash.child, bash.cmd);
      assert.equal(rpc.updateBusy(), false);
    });
    for (const type of ['switch_session', 'new_session', 'fork']) {
      rpc.send({ id: 'extra-command-' + type, type, command: 'get_state', sessionPath: 'fixture-session' });
      const mutation = writes.at(-1), sentEpoch = rpc.providerSessionEpoch();
      reply(mutation.child, mutation.cmd, { command: 'get_state' });
      check('extra command payload cannot authorize a wrong response to close ' + type, () => {
        assert.equal(rpc.providerSessionChanging(), true); assert.equal(rpc.updateBusy(), true);
        assert.equal(rpc.providerSessionEpoch(), sentEpoch);
        reply(mutation.child, mutation.cmd);
        assert.equal(rpc.providerSessionChanging(), false); assert.equal(rpc.updateBusy(), false);
        assert.equal(rpc.providerSessionEpoch(), sentEpoch + 1);
      });
    }
    const pending = rpc.request({ type: 'switch_session', sessionPath: 'next' }, { timeoutMs: 1000 });
    const interrupted = lastMutation();
    const epoch = rpc.providerSessionEpoch();
    reply(interrupted.child, interrupted.cmd, { command: 'get_state' });
    check('wrong private response cannot resolve a pending mutation', () => {
      assert.equal(rpc.providerSessionChanging(), true); assert.equal(rpc.providerSessionEpoch(), epoch);
    });
    children[0].emit('exit', 1, null); await pending;
    check('child exit clears pending mutation and update authority', () => {
      assert.equal(rpc.providerSessionChanging(), false); assert.equal(rpc.updateBusy(), false);
    });
    rpc.start(); await tick();
    const next = rpc.request({ type: 'switch_session', sessionPath: 'next' });
    const current = lastMutation(); reply(interrupted.child, interrupted.cmd);
    check('retired child late response cannot close the new process mutation', () => assert.equal(rpc.providerSessionChanging(), true));
    reply(current.child, current.cmd); await next;
    check('new process matching response closes only its own mutation', () => assert.equal(rpc.providerSessionChanging(), false));
  } finally { runtime.setShuttingDown(true); rpc.stop(); }
}

async function singleFlightCases() {
  const { createProviderAuth } = await load('server/provider-auth.js');
  const { authDescriptor } = await load('server/provider-auth-sdk.js');
  const meta = { providerId: 'fixture', methods: [{ type: 'oauth', canLogin: true }], storedType: 'oauth', checkType: 'oauth' };
  const gate = deferred(); let calls = 0, controller;
  controller = createProviderAuth({ adapter: { identityKey: () => 'fixture', list: async () => ({ capability: { sdkAvailable: true }, providers: [authDescriptor(meta)] }), login: async () => {}, dispose() {} },
    synchronize: async () => { calls++; controller.observeRuntime(); await gate.promise; return { ok: true }; } });
  try {
    await controller.start('fixture', 'oauth');
    for (let n = 0; n < 20 && !calls; n++) await tick();
    check('auth synchronization reserves single flight before lifecycle reentry', () => assert.equal(calls, 1));
    check('synchronization exposes busy runtime state', () => { assert.equal(controller.snapshot().sync.state, 'syncing'); assert.equal(controller.inFlight(), true); });
    const login = await controller.start('fixture', 'oauth');
    check('second authentication cannot enter during model synchronization', () => assert.equal(login.code, 'busy'));
    const extra = controller.sync(); gate.resolve(); await extra;
    check('concurrent synchronization joins existing operation', () => assert.equal(calls, 1));
    check('confirmed synchronization releases guard', () => { assert.equal(controller.snapshot().sync.state, 'synced'); assert.equal(controller.inFlight(), false); });
  } finally { gate.resolve(); controller.dispose(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
