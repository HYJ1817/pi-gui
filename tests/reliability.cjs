const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = Math.floor(Math.random() * 100000) + 1;
  child.kills = 0;
  child.kill = () => {
    child.kills++;
    process.nextTick(() => child.emit('exit', 0, 'SIGTERM'));
  };
  return child;
}

(async () => {
  const { createRpcBridge } = await import('../server/rpc-bridge.js');
  const { createRuntime } = await import('../server/runtime.js');
  const children = [];
  const events = [];
  const runtime = createRuntime({ initialCwd: process.cwd() });
  const bridge = createRpcBridge({
    runtime,
    publish: (event) => events.push(event),
    piBin: 'fake-pi',
    isWin: false,
    env: {},
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    restartDelayMs: 0,
  });

  bridge.start();
  assert.equal(children.length, 1, 'start spawns one child');
  children[0].emit('spawn');
  assert.throws(() => bridge.send({ type: 'set_model', __bridgeRun: 999 }), /项目已切换/, 'old model command cannot enter a new child');
  const pending = bridge.request({ type: 'get_commands' }, { timeoutMs: 5000 });
  bridge.restart();
  bridge.restart();
  assert.throws(() => bridge.send({ type: 'prompt', message: 'stale' }), /正在重启/, 'commands cannot enter a dying child');
  assert.equal(await pending, null, 'restart settles pending RPC');
  assert.equal(children[0].kills, 1, 'repeated restart kills only once');
  await tick();
  await tick();
  assert.equal(children.length, 2, 'repeated restart spawns one replacement');

  const pendingAfterRestart = bridge.request({ type: 'get_commands' }, { timeoutMs: 5000 });
  children[1].emit('exit', 1, null);
  assert.equal(await pendingAfterRestart, null, 'unexpected exit settles pending RPC');
  runtime.setShuttingDown(true);
  bridge.stop();

  const failedChildren = [];
  const failedRuntime = createRuntime({ initialCwd: process.cwd() });
  const failingBridge = createRpcBridge({
    runtime: failedRuntime,
    publish: () => {},
    piBin: 'missing-pi',
    isWin: false,
    env: {},
    restartDelayMs: 0,
    spawnProcess: () => {
      const child = fakeChild();
      failedChildren.push(child);
      return child;
    },
  });
  failingBridge.start();
  const missingPending = failingBridge.request({ type: 'get_commands' }, { timeoutMs: 5000 });
  failedChildren[0].emit('error', new Error('ENOENT'));
  failedChildren[0].emit('close', -2, null);
  assert.equal(await missingPending, null, 'spawn failure settles pending RPC');
  await tick();
  assert.equal(failedChildren.length, 2, 'spawn failure can retry after close');
  failedRuntime.setShuttingDown(true);
  failingBridge.stop();

  const directChildren = [];
  const directRuntime = createRuntime({ initialCwd: process.cwd() });
  const directBridge = createRpcBridge({
    runtime: directRuntime, publish: () => {}, piBin: 'fake-pi', isWin: false, env: {},
    spawnProcess: () => {
      const child = fakeChild();
      directChildren.push(child);
      return child;
    },
  });
  directBridge.restart();
  directBridge.restart();
  assert.equal(directChildren.length, 1, 'two immediate restarts from idle spawn once');
  assert.equal(directChildren[0].kills, 0, 'new child is not killed by duplicate restart');
  directRuntime.setShuttingDown(true);
  directBridge.stop();

  const { createEventBus } = await import('../server/sse.js');
  const oldSetInterval = global.setInterval;
  const oldClearInterval = global.clearInterval;
  const active = new Set();
  global.setInterval = () => {
    const id = Symbol('ping');
    active.add(id);
    return id;
  };
  global.clearInterval = (id) => active.delete(id);
  try {
    const bus = createEventBus();
    const req = new EventEmitter();
    const res = { writeHead() {}, write() {}, end() {} };
    bus.subscribe(req, res);
    assert.equal(active.size, 1, 'subscribe creates ping timer');
    bus.closeAll();
    assert.equal(active.size, 0, 'closeAll clears ping timer');
  } finally {
    global.setInterval = oldSetInterval;
    global.clearInterval = oldClearInterval;
  }

  const { classifyOccupiedPort } = await import('../server/port-owner.js');
  assert.equal(classifyOccupiedPort({ app: 'pi-gui', protocol: 1 }), 'pi-gui');
  assert.equal(classifyOccupiedPort({ app: 'unrelated', protocol: 1 }), 'foreign-service');
  assert.equal(classifyOccupiedPort({ app: 'pi-gui', protocol: 2 }), 'foreign-service');

  console.log('reliability: passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
