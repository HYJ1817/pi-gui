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
  await singleFlightCases();
  console.log(`\n${passed}/${passed} 通过`);
}

async function bridgeCases(createAuthRuntimeSync) {
  const { createRpcBridge } = await load('server/rpc-bridge.js');
  const { createRuntime } = await load('server/runtime.js');
  const runtime = createRuntime({ initialCwd: 'fixture-A' });
  const children = [], launches = [], listeners = new Set(), responses = [];
  const bridge = createRpcBridge({ runtime, isWin: false, piBin: 'fixture-pi', env: { PI_NO_CONTINUE: '1' }, publish: event => { if (event.type === 'response') responses.push(event); for (const fn of [...listeners]) fn(event); },
    spawnProcess: (_bin, args) => {
      launches.push(args);
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      child.stdin = new EventEmitter(); child.stdin.end = () => {};
      child.stdin.write = line => { const cmd = JSON.parse(line); queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: cmd.id, type: 'response', command: cmd.type, success: true, data: cmd.type === 'get_state' ? { sessionFile: 'fixture-current-session.jsonl' } : {} }) + '\n')); };
      child.kill = () => { queueMicrotask(() => child.emit('exit', 0, null)); return true; };
      children.push(child); queueMicrotask(() => child.emit('spawn')); return child;
    } });
  try {
    bridge.start(); await tick();
    const sync = createAuthRuntimeSync({ rpc: bridge, getCwd: runtime.getCurrentCwd, busyReason: () => null, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, timeoutMs: 1000 });
    const result = await sync();
    check('actual bridge fake RPC session reload succeeds', () => assert.equal(result.ok, true));
    check('auth readback uses Promise results without broadcasting SSE responses', () => assert.equal(responses.length, 0));
    check('actual bridge passes exact current session launch argv', () => assert.deepEqual(launches[1], ['--mode', 'rpc', '--session', 'fixture-current-session.jsonl']));
    runtime.setCurrentCwd('fixture-B'); bridge.restart(); await new Promise(resolve => setTimeout(resolve, 15));
    check('session override consumed once and never leaks to next cwd', () => assert.deepEqual(launches[2], ['--mode', 'rpc']));
    check('fake bridge spawned exactly three runs', () => assert.equal(children.length, 3));
    runtime.setCurrentCwd(null); bridge.restart(); await new Promise(resolve => setTimeout(resolve, 15));
    check('no-project auth synchronization succeeds without restarting a workspace', () => assert.equal(children.length, 3));
    const empty = await sync();
    check('no-project needs no chat readback for user-level auth', () => assert.equal(empty.ok, true));
  } finally { runtime.setShuttingDown(true); bridge.stop(); }
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
