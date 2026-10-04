// Stop contract across the actual server.js assembly, Router, bridge and frontend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');
const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log('  ok  ' + name); }
  catch (error) { failed++; console.error(' FAIL ' + name + ': ' + error.message); }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function main() {
  const { createRpcBridge } = await import('../server/rpc-bridge.js');
  const { createRouter } = await import('../server/router.js');
  let ack, entered, stopped = false, writeError = null, lastSendResult;
  const writes = [], guarded = [], modelAccepted = [], activityAccepted = [];
  const raw = createRpcBridge({
    runtime: { getCurrentCwd: () => os.tmpdir(), isShuttingDown: () => stopped },
    publish() {}, piBin: 'fixture-pi', isWin: false, env: {},
    browserLaunch: {
      available: () => true,
      prepare: async () => ({ args: [], env: {} }),
      invalidate: (options) => {
        if (!options?.strict) return Promise.resolve();
        entered.resolve();
        return ack.promise;
      },
    },
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      child.stdin = { on() {}, end() {}, write(line) {
        if (writeError) throw writeError;
        writes.push(JSON.parse(line));
      } };
      child.kill = () => {};
      return child;
    },
  });
  await raw.start();
  // Evaluate the production composition block verbatim: do not copy its send wrapper.
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = source.indexOf('const route = createRouter({');
  const end = source.indexOf('\nconst server = http.createServer(route);', start);
  assert.ok(start >= 0 && end > start, 'server.js Router assembly must be found');
  let wrapped, syncing = false, guardError = null;
  const context = {
    createRouter(options) { wrapped = options.rpc; return createRouter(options); },
    rpc: { ...raw, send(command) {
      lastSendResult = raw.send(command);
      // Observe without replacing the Promise; also avoid an unhandled rejection in the pre-fix regression.
      lastSendResult?.catch(() => {});
      return lastSendResult;
    } },
    auth: { denyRequest: () => null }, sse: {},
    providerAuth: { snapshot: () => ({ sync: { state: syncing ? 'syncing' : 'idle' } }) },
    modelGeneration: {
      guardCommand(command) { if (guardError) throw guardError; guarded.push(command); },
      noteCommandAccepted: command => modelAccepted.push(command),
    },
    piActivity: { noteCommandAccepted: command => activityAccepted.push(command) },
    createSessionExport: () => null, runtime: {}, piLaunch: { packageDir: () => null },
  };
  for (const name of ['providers', 'projects', 'projectConfig', 'skills', 'mcp', 'mcpNative',
    'approvalProbe', 'extensions', 'sessions', 'sessionSearch', 'planner', 'gitRoutes',
    'uploads', 'diagnostics', 'updateCheck', 'piUpdate', 'capabilityInstall', 'quota', 'piCompat']) context[name] = {};
  const route = vm.runInNewContext(source.slice(start, end) + '\nroute;', context);
  let responseFinished = false;
  const server = http.createServer((req, res) => {
    res.once('finish', () => { responseFinished = true; });
    route(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/command`;
  const post = async command => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    return { status: response.status, body: await response.json() };
  };
  try {
    await check('A pending ack holds HTTP response and Pi abort; success sends exactly once then 200', async () => {
      ack = deferred(); entered = deferred(); responseFinished = false;
      const before = writes.length;
      const response = post({ type: 'abort' });
      await entered.promise;
      try {
        assert.ok(lastSendResult instanceof Promise);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(responseFinished, false, 'HTTP must not finish before cancellation ack');
        assert.equal(writes.length, before, 'Pi must not receive an early abort');
      } finally { ack.resolve(); }
      assert.deepEqual(await response, { status: 200, body: { ok: true } });
      assert.deepEqual(writes.slice(before), [{ type: 'abort' }]);
    });
    await check('B failed ack still sends one Pi abort; HTTP 503 contains only safe copy', async () => {
      ack = deferred(); entered = deferred();
      const before = writes.length;
      const response = post({ type: 'abort' });
      await entered.promise;
      ack.reject(new Error('token=fixture-secret raw bridge error stack'));
      const result = await response;
      assert.deepEqual(writes.slice(before), [{ type: 'abort' }]);
      assert.equal(result.status, 503);
      assert.equal(result.body.ok, false);
      assert.equal(result.body.error, 'Pi 已收到停止请求，但内置浏览器取消确认不可用。');
      assert.ok(!/token|fixture-secret|stack|raw bridge error/.test(JSON.stringify(result.body)));
    });
    await check('abort wrapper returns the original bridge Promise unchanged', async () => {
      ack = deferred(); entered = deferred();
      const before = writes.length;
      const result = wrapped.send({ type: 'abort' });
      try { assert.equal(result, lastSendResult); }
      finally { ack.resolve(); await lastSendResult; }
      assert.deepEqual(writes.slice(before), [{ type: 'abort' }]);
    });
    await check('C prompt and steer remain synchronous, strip fallback owner and preserve acceptance order', async () => {
      for (const type of ['prompt', 'steer']) {
        const command = { type, message: 'fixture', __fallbackOwner: 'owner' };
        const before = writes.length;
        assert.equal(wrapped.send(command), undefined);
        assert.equal(writes.length, before + 1);
        assert.deepEqual(writes.at(-1), { type, message: 'fixture' });
        assert.equal(guarded.at(-1), command);
        assert.equal(modelAccepted.at(-1), command);
        assert.equal(activityAccepted.at(-1), command);
        assert.deepEqual(await post({ type, message: 'fixture' }), { status: 200, body: { ok: true } });
      }
    });
    await check('C synchronous send errors retain identity and do not mark commands accepted', () => {
      const before = [modelAccepted.length, activityAccepted.length];
      writeError = new Error('fixture synchronous failure');
      try { assert.throws(() => wrapped.send({ type: 'prompt' }), error => error === writeError); }
      finally { writeError = null; }
      assert.deepEqual([modelAccepted.length, activityAccepted.length], before);
    });
    await check('C provider and model guards stay synchronous and prevent writes/acceptance', () => {
      const before = [writes.length, modelAccepted.length, activityAccepted.length];
      syncing = true;
      try { assert.throws(() => wrapped.send({ type: 'prompt' }), /正在同步/); }
      finally { syncing = false; }
      guardError = new Error('fixture guard');
      try { assert.throws(() => wrapped.send({ type: 'steer' }), error => error === guardError); }
      finally { guardError = null; }
      assert.deepEqual([writes.length, modelAccepted.length, activityAccepted.length], before);
    });
  } finally {
    ack?.resolve(); stopped = true; raw.stop(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }

  const pub = path.join(ROOT, 'public');
  const dom = new JSDOM(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'),
    { url: 'http://localhost:7788', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, commands = [];
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  let commandReply;
  w.fetch = async (target, options) => {
    assert.equal(target, '/api/command');
    commands.push(JSON.parse(options.body));
    const body = await commandReply;
    return { ok: body.ok, json: async () => body };
  };
  // Real rpc.js -> api.sendCommand -> existing toast / shell status functions.
  const frontend = w.eval(bundle(path.join(pub, 'rpc.js')).code);
  const reset = () => {
    frontend.S.streaming = true; frontend.S.bridgeRun = 1;
    frontend.el.statusText.textContent = '正在处理'; frontend.el.toasts.replaceChildren(); commands.length = 0;
  };
  try {
    await check('frontend failure preserves status and existing single error toast', async () => {
      reset(); commandReply = { ok: false, error: '内置浏览器取消确认不可用' };
      const changes = [];
      const observer = new w.MutationObserver(records => changes.push(...records));
      observer.observe(frontend.el.statusText, { childList: true, characterData: true, subtree: true });
      try {
        await frontend.stop();
        assert.equal(frontend.el.statusText.textContent, '正在处理');
        assert.equal(changes.length + observer.takeRecords().length, 0, 'failed Stop must not write status');
      } finally { observer.disconnect(); }
      assert.equal(frontend.el.toasts.querySelectorAll('.toast.error').length, 1);
      assert.equal(frontend.el.toasts.textContent, '内置浏览器取消确认不可用');
      assert.equal(commands.length, 1); assert.equal(commands[0].type, 'abort');
    });
    await check('frontend success alone displays requested-stop status without another toast', async () => {
      reset(); commandReply = { ok: true };
      await frontend.stop();
      assert.equal(frontend.el.statusText.textContent, '已请求停止…');
      assert.equal(frontend.el.toasts.children.length, 0);
      assert.equal(commands.length, 1);
    });
    await check('frontend pending acknowledgement does not display requested-stop status', async () => {
      reset(); const pending = deferred(); commandReply = pending.promise;
      const stopping = frontend.stop();
      assert.equal(commands.length, 1);
      assert.equal(frontend.el.statusText.textContent, '正在处理');
      pending.resolve({ ok: true }); await stopping;
      assert.equal(frontend.el.statusText.textContent, '已请求停止…');
    });
  } finally { w.close(); }
  console.log(`gui-browser-stop: ${passed}/${passed + failed} cases passed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
