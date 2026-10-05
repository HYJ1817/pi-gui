/* Stop（停止）在装配层、Router、bridge 与前端之间的完整契约 —— 包含 P29 的
 * 内置浏览器取消确认。
 *
 * 这一份**只管浏览器那一段**（内置浏览器自动动作必须先失效、且必须有确认），
 * Pi 侧的权威停止时序（clear_queue → abort → 等应答 → 屏障）在 tests/stop-barrier.cjs。
 * 两者合起来才是完整的 Stop：**browser cancellation confirmed + Pi cancellation confirmed**。
 *
 * 契约（换过一版，别按旧行为改回去）：
 *   - 浏览器没确认之前，**一个字节都不许进 pi**（HTTP 也压着不回）；
 *   - 浏览器确认失败 ≠ 不停 Pi：abort 照样送，但**绝不宣称成功**，
 *     HTTP 503 + 固定安全文案（不回显任何原始错误）；
 *   - 时间轴上永远 clear_queue 在 abort 之前；
 *   - 前端：「正在停止…」是点击那一刻就写的（不是「已请求停止…」——
 *     那会让用户以为已经停了）；失败不覆盖状态栏、只弹一条安全 toast。
 */
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, fn, timeoutMs = 4000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error('等待超时：' + what);
    await sleep(5);
  }
}

async function main() {
  const { createRpcBridge } = await import('../server/rpc-bridge.js');
  const { createRouter } = await import('../server/router.js');
  let ack, entered, stopped = false, writeError = null, lastSendResult;
  let abortReply = true;
  const writes = [], guarded = [], modelAccepted = [], activityAccepted = [];
  const raw = createRpcBridge({
    runtime: { getCurrentCwd: () => os.tmpdir(), isShuttingDown: () => stopped },
    publish() {}, piBin: 'fixture-pi', isWin: false, env: {},
    stopTimeoutMs: 300,
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
      const reply = (command) => {
        const ok = { id: command.id, type: 'response', command: command.type, success: true, data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } };
        child.stdout.emit('data', JSON.stringify(ok) + '\n');
      };
      child.stdin = { on() {}, end() {}, write(line) {
        if (writeError) throw writeError;
        const command = JSON.parse(line);
        writes.push(command);
        /* 浏览器确认失败的那条路径也照样要停 Pi —— 用例通过 abortReply 决定
         * 这条 abort 应答是不是会回来。 */
        if (command.type === 'abort') { if (abortReply) setImmediate(() => reply(command)); }
        else if (command.id !== undefined) setImmediate(() => reply(command));
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
  let syncing = false, guardError = null, wrapped = null;
  const context = {
    createRouter(options) { wrapped = options.rpc; return createRouter(options); },
    rpc: { ...raw, send(command) {
      lastSendResult = raw.send(command);
      // Observe without replacing the Promise; also avoid an unhandled rejection.
      lastSendResult?.catch(() => {});
      return lastSendResult;
    }, abortAndWait(command) {
      /* 停止走的是这个入口（不是 send）—— 同样只观察、不替换。 */
      lastSendResult = raw.abortAndWait(command);
      lastSendResult?.catch(() => {});
      return lastSendResult;
    } },
    auth: { denyRequest: () => null }, sse: {},
    providerAuth: { snapshot: () => ({ sync: { state: syncing ? 'syncing' : 'idle' } }) },
    modelGeneration: {
      guardCommand(command) { if (guardError) throw guardError; guarded.push(command); },
      noteCommandAccepted: (command) => modelAccepted.push(command),
    },
    piActivity: { noteCommandAccepted: (command) => activityAccepted.push(command) },
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/command`;
  const post = async (command) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    return { status: response.status, body: await response.json() };
  };
  try {
    await check('A 浏览器未确认时，HTTP 与 Pi 都压着；确认后按 clear_queue → abort 的顺序发出，abort 应答回来才算成功', async () => {
      ack = deferred(); entered = deferred(); responseFinished = false;
      const before = writes.length;
      const response = post({ type: 'abort' });
      await entered.promise;
      try {
        assert.ok(lastSendResult instanceof Promise);
        await sleep(30);
        assert.equal(responseFinished, false, 'HTTP 不能在浏览器取消确认之前结束');
        assert.equal(writes.length, before, 'Pi 不能提前收到任何命令');
      } finally { ack.resolve(); }
      const result = await response;
      assert.deepEqual(result, { status: 200, body: { ok: true, stop: { evidence: 'abort-response', queue: 'cleared' } } });
      assert.deepEqual(writes.slice(before).map((c) => c.type), ['clear_queue', 'abort']);
    });
    await check('B 浏览器确认失败：abort 照样送出去，HTTP 503 只有安全文案，且不宣称成功', async () => {
      ack = deferred(); entered = deferred();
      const before = writes.length;
      const response = post({ type: 'abort' });
      await entered.promise;
      ack.reject(new Error('token=fixture-secret raw bridge error stack'));
      const result = await response;
      /* 报告先于「把命令写进 pi」返回，所以这里等写入落地再断言顺序。 */
      await waitFor('abort 写进 Pi', () => writes.some((c) => c.type === 'abort'));
      assert.deepEqual(writes.slice(before).map((c) => c.type), ['clear_queue', 'abort']);
      assert.equal(result.status, 503);
      assert.equal(result.body.ok, false);
      assert.equal(result.body.code, 'browser_cancel_unconfirmed');
      assert.equal(result.body.error, 'Pi 已收到停止请求，但内置浏览器取消确认不可用。');
      assert.ok(!/token|fixture-secret|stack|raw bridge error/.test(JSON.stringify(result.body)));
      /* 浏览器确认失败只是**报告**失败；Pi 侧照旧有权威确认 → 屏障必须解除。 */
      await waitFor('屏障解除', () => !raw.stopState());
      assert.ok(!JSON.stringify(raw.getState()).includes('fixture-secret'));
    });
    await check('C prompt 与 steer 仍是同步发送，剥掉备用标记并保持接受顺序', async () => {
      assert.ok(wrapped, '生产装配层的 rpc facade 必须被取到');
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
    await check('C 同步写失败保持错误身份，且不标记「已接受」', () => {
      const before = [modelAccepted.length, activityAccepted.length];
      writeError = new Error('fixture synchronous failure');
      try { assert.throws(() => wrapped.send({ type: 'prompt' }), error => error === writeError); }
      finally { writeError = null; }
      assert.deepEqual([modelAccepted.length, activityAccepted.length], before);
    });
    await check('C provider 与模型守卫仍然同步生效，且不写不记账', () => {
      const before = [writes.length, modelAccepted.length, activityAccepted.length];
      syncing = true;
      try { assert.throws(() => wrapped.send({ type: 'prompt' }), /正在同步/); }
      finally { syncing = false; }
      guardError = new Error('fixture guard');
      try { assert.throws(() => wrapped.send({ type: 'steer' }), error => error === guardError); }
      finally { guardError = null; }
      assert.deepEqual([writes.length, modelAccepted.length, activityAccepted.length], before);
    });
    await check('D 包装层把 bridge 的停止 Promise 原样返回（不吞、不替换），确认前不写 Pi', async () => {
      ack = deferred(); entered = deferred();
      const before = writes.length;
      const result = wrapped.send({ type: 'abort' });
      try {
        assert.equal(result, lastSendResult, '包装层不许换掉 Promise 身份');
        await entered.promise;
        assert.equal(writes.length, before, '浏览器没确认之前一个字节都不写');
      } finally { ack.resolve(); }
      assert.equal((await result).ok, true);
      assert.deepEqual(writes.slice(before).map((c) => c.type), ['clear_queue', 'abort']);
    });
  } finally {
    ack?.resolve(); stopped = true; raw.stop(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
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
    return { ok: body.ok !== false, status: body.ok === false ? 503 : 200, json: async () => body };
  };
  // Real rpc.js -> api.sendCommand -> existing toast / shell status functions.
  const frontend = w.eval(bundle(path.join(pub, 'rpc.js')).code);
  const reset = () => {
    frontend.S.streaming = true; frontend.S.stopping = false; frontend.S.stopOwnedTurn = false;
    frontend.S.bridgeRun = 1; frontend.S.hasProject = true; frontend.S.bridgeState = 'ready';
    frontend.el.statusText.textContent = '正在处理'; frontend.el.toasts.replaceChildren(); commands.length = 0;
  };
  try {
    await check('前端：浏览器确认失败时状态栏停在「正在停止…」，只有一条安全 toast', async () => {
      reset(); commandReply = { ok: false, code: 'browser_cancel_unconfirmed', error: '内置浏览器取消确认不可用' };
      const changes = [];
      const observer = new w.MutationObserver(records => changes.push(...records));
      observer.observe(frontend.el.statusText, { childList: true, characterData: true, subtree: true });
      try {
        await frontend.stop();
        /* 点击那一刻写的是「正在停止…」；失败路径**不许**再改它（也没有「已请求停止…」）。 */
        assert.equal(frontend.el.statusText.textContent, '正在停止…');
        assert.equal(changes.length + observer.takeRecords().length, 1, '状态栏只该被写一次（点击时）');
      } finally { observer.disconnect(); }
      assert.equal(frontend.S.stopping, true, 'Pi 侧还没确认，必须保持保护');
      assert.equal(frontend.el.toasts.querySelectorAll('.toast.error').length, 1);
      assert.equal(frontend.el.toasts.textContent, '内置浏览器取消确认不可用');
      assert.equal(commands.length, 1); assert.equal(commands[0].type, 'abort');
    });
    await check('前端：成功时显示「已停止」而不是「已请求停止…」，且不再多弹 toast', async () => {
      reset(); commandReply = { ok: true, stop: { evidence: 'abort-response' } };
      await frontend.stop();
      assert.equal(frontend.el.statusText.textContent, '已停止');
      assert.equal(frontend.S.stopping, false);
      assert.equal(frontend.S.streaming, false);
      assert.equal(frontend.el.toasts.children.length, 0);
      assert.equal(commands.length, 1);
    });
    await check('前端：等待确认期间就显示「正在停止…」（不是「已请求停止…」）', async () => {
      reset(); const pending = deferred(); commandReply = pending.promise;
      const stopping = frontend.stop();
      assert.equal(commands.length, 1);
      assert.equal(frontend.el.statusText.textContent, '正在停止…');
      assert.equal(frontend.S.stopping, true);
      pending.resolve({ ok: true, stop: { evidence: 'abort-response' } });
      await stopping;
      assert.equal(frontend.el.statusText.textContent, '已停止');
    });
  } finally { w.close(); }
  console.log(`gui-browser-stop: ${passed}/${passed + failed} cases passed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
