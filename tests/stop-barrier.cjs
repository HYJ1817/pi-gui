/* Stop 语义（权威停止屏障）回归 —— **测整个时序，不是只测「stdin 收到了 abort」**。
 *
 * 旧测试只看「写进 stdin 的字节里有 abort」就绿了，于是漏掉了真正的 bug：
 *
 *     prompt A → Stop（写了 abort）→ HTTP 立刻 200 → 用户发 B
 *     → 前端还认为在跑（S.streaming 仍为 true）→ B 被当成 steer 排进**旧 run**
 *     → 旧任务继续跑完，新任务也被吞进去
 *
 * 所以这里用一颗模拟 Pi 的假 RPC child，把「abort 写下去了但 Pi 还没确认」
 * 那一段**停住**，在那一段里尝试发送，断言：
 *
 *   1. 后端必须拒绝 prompt / steer / follow_up（稳定错误 stop_in_progress），
 *      这些命令**一个字节都不能进 Pi 的 stdin**；
 *   2. 只有拿到 Pi 的权威 abort 应答（或 agent_settled 后回读确认 idle）才解除；
 *   3. 超时不解除 —— 屏障继续挡着，宁可暂时不让发。
 *
 * 覆盖官方契约（本机 pi 1.0.2 的 docs/rpc-commands.md）：
 *   - `abort` = 「中止当前操作**并等会话变空闲之后**才应答」
 *   - `clear_queue` 必须在 abort **之前**：abort 会把还在队列里的
 *     steering / follow-up 继续跑完
 *   - `agent_settled` 是会话级真正结束的权威事件（规则同 server/pi-activity.js）
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
const PUB = path.join(ROOT, 'public');

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

/* ---------- 模拟 Pi 的 RPC child ----------
 *
 * 只实现本测试用到的那几条命令的**官方应答形状**：
 *   get_state   → data.isStreaming / isCompacting / pendingMessageCount
 *   clear_queue → data.{steering,followUp}；旧 pi 走 rpc-mode 的 default 分支回
 *                 "Unknown command: clear_queue"
 *   abort       → 由用例决定何时回、成功还是失败（这是本文件的主角）
 * 其余一律记进 writes，供断言「有没有真的写进 pi」。
 */
function createFakePi() {
  const writes = [];
  const child = new EventEmitter();
  child.pid = 5150;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.kill = () => {};
  const state = {
    streaming: false,
    queueMode: 'ok',      // ok | unsupported | silent
    abortMode: 'manual',  // manual | respond | settle-then-respond | respond-then-settle | fail | silent
    pendingAbort: null,
  };
  const emit = (msg) => child.stdout.emit('data', JSON.stringify(msg) + '\n');
  const respond = (cmd, data, success = true, error = undefined) => {
    const msg = { id: cmd.id, type: 'response', command: cmd.type, success };
    if (success) msg.data = data ?? {};
    else msg.error = error;
    emit(msg);
  };
  const settle = () => { state.streaming = false; emit({ type: 'agent_settled' }); };

  function handle(cmd) {
    switch (cmd.type) {
      case 'get_state':
        return respond(cmd, { isStreaming: state.streaming, isCompacting: false, pendingMessageCount: 0, sessionId: 'fixture' });
      case 'clear_queue':
        if (state.queueMode === 'unsupported') return respond(cmd, null, false, 'Unknown command: clear_queue');
        if (state.queueMode === 'silent') return undefined;
        return respond(cmd, { steering: [], followUp: [] });
      case 'abort':
        switch (state.abortMode) {
          case 'silent': return undefined;
          case 'fail': return respond(cmd, null, false, 'fixture abort failure');
          case 'respond': state.streaming = false; return respond(cmd, {});
          case 'settle-then-respond':
            /* 官方实现里 agent_settled 那条 stdout 记录**先**于 abort 应答写出
             * （agent-session.ts 的 _emitAgentSettled 先 emit 事件、再 resolve idle）。 */
            settle();
            return setTimeout(() => respond(cmd, {}), 5);
          case 'respond-then-settle':
            respond(cmd, {});
            return setTimeout(settle, 5);
          default:
            state.pendingAbort = cmd;
            return undefined;
        }
      case 'prompt':
        state.streaming = true;
        emit({ type: 'agent_start' });
        return undefined;
      case 'steer':
      case 'follow_up':
        return undefined;
      default:
        return respond(cmd, null, false, 'Unknown command: ' + cmd.type);
    }
  }

  child.stdin = {
    destroyed: false,
    writable: true,
    writableEnded: false,
    on() {},
    end() { this.writableEnded = true; },
    write(line) {
      const cmd = JSON.parse(line);
      writes.push(cmd);
      setImmediate(() => handle(cmd));
      return true;
    },
  };
  return {
    child, writes, state,
    settle,
    /** 脚本化模式之外的用例自己决定何时回 abort。 */
    respondAbort() {
      const cmd = state.pendingAbort;
      assert.ok(cmd, 'fake pi 没有待回的 abort');
      state.pendingAbort = null;
      state.streaming = false;
      respond(cmd, {});
    },
  };
}

async function main() {
  const { createRpcBridge } = await import('../server/rpc-bridge.js');
  const { createRouter } = await import('../server/router.js');

  const cwd = os.tmpdir();
  const pi = createFakePi();
  let serverStopped = false;
  const published = [];
  const raw = createRpcBridge({
    runtime: { getCurrentCwd: () => cwd, isShuttingDown: () => serverStopped },
    publish: (evt) => published.push(evt),
    piBin: 'fixture-pi', isWin: false, env: {},
    spawnProcess: () => pi.child,
    /* 缩短等待：生产是 30s，这里 120ms —— 语义一模一样，只是别让测试白等。 */
    stopTimeoutMs: 120,
  });
  await raw.start();

  /* 路由用**生产的那一段装配**（从 server.js 里原样取出来跑），不另抄一份 wrapper
   * —— 抄一份就等于测了个仿制品。这一段里现在有 abortAndWait 的前置守卫与记账。 */
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = source.indexOf('const route = createRouter({');
  const end = source.indexOf('\nconst server = http.createServer(route);', start);
  assert.ok(start >= 0 && end > start, 'server.js Router assembly must be found');
  let syncing = false;
  const guarded = [], modelAccepted = [], activityAccepted = [];
  const context = {
    createRouter(options) { return createRouter(options); },
    rpc: raw,
    auth: { denyRequest: () => null },
    sse: {},
    providerAuth: { snapshot: () => ({ sync: { state: syncing ? 'syncing' : 'idle' } }) },
    modelGeneration: {
      guardCommand(command) { guarded.push(command); },
      noteCommandAccepted: (command) => modelAccepted.push(command),
    },
    piActivity: { noteCommandAccepted: (command) => activityAccepted.push(command) },
    createSessionExport: () => null,
    runtime: {},
    piLaunch: { packageDir: () => null },
  };
  for (const name of ['providers', 'projects', 'projectConfig', 'skills', 'mcp', 'mcpNative',
    'approvalProbe', 'extensions', 'sessions', 'sessionSearch', 'planner', 'gitRoutes',
    'uploads', 'diagnostics', 'updateCheck', 'piUpdate', 'capabilityInstall', 'quota', 'piCompat']) context[name] = {};
  const route = vm.runInNewContext(source.slice(start, end) + '\nroute;', context);

  const server = http.createServer(route);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (command) => {
    const response = await fetch(origin + '/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    });
    return { status: response.status, body: await response.json() };
  };
  const status = async () => (await fetch(origin + '/api/status')).json();
  const has = (predicate) => pi.writes.some(predicate);
  const resetLog = () => { pi.writes.length = 0; };

  try {
    /* ================= 核心时序：屏障真的挡住新命令 ================= */

    await check('1. 停止未确认期间，prompt / steer / follow_up 全部被后端拒绝，且不进 Pi stdin', async () => {
      resetLog();
      pi.state.abortMode = 'manual';
      assert.deepEqual(await post({ type: 'prompt', message: 'A' }), { status: 200, body: { ok: true } });
      await waitFor('prompt A 到达 Pi', () => has((c) => c.type === 'prompt'));

      /* 长任务正在跑，用户点 Stop。abort 应答**故意扣住**，模拟「写下去了但还没停」。 */
      const stopping = post({ type: 'abort' });
      await waitFor('clear_queue / abort 到达 Pi', () => has((c) => c.type === 'abort'));

      const before = pi.writes.length;
      for (const type of ['prompt', 'steer', 'follow_up']) {
        const result = await post({ type, message: 'B' });
        assert.equal(result.status, 503, `${type} 必须被拒绝`);
        assert.equal(result.body.ok, false);
        assert.equal(result.body.code, 'stop_in_progress', `${type} 必须是稳定错误码`);
      }
      assert.equal(pi.writes.length, before, '被拒绝的命令一个字节都不许进 Pi 的 stdin');
      assert.ok(!has((c) => c.message === 'B'), 'Pi 不能看到 B');
      assert.equal((await status()).stop?.pending, true, '屏障必须在 /api/status 里看得见');

      /* 等过 abort 应答超时：HTTP 报 stop_unconfirmed，但**屏障不许解除**。 */
      const timedOut = await stopping;
      assert.equal(timedOut.status, 503);
      assert.equal(timedOut.body.code, 'stop_unconfirmed');
      assert.match(timedOut.body.error, /停止尚未得到 Pi 确认/);
      assert.equal((await status()).stop?.pending, true, '超时后屏障仍在');
      const late = await post({ type: 'prompt', message: 'B' });
      assert.equal(late.body.code, 'stop_in_progress', '超时后仍然不许发');
      assert.ok(!has((c) => c.message === 'B'));

      /* 权威 abort 应答此刻才到 —— 它同样是终止信号，不能因为本地放弃了就不认。 */
      pi.respondAbort();
      await waitFor('屏障解除', () => !raw.stopState());
      assert.equal(raw.stopState(), null);

      const after = await post({ type: 'prompt', message: 'B' });
      assert.deepEqual(after, { status: 200, body: { ok: true } });
      const sent = pi.writes.filter((c) => c.message === 'B');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].type, 'prompt', 'Stop 之后的新任务必须是真正的 prompt，不能是 steer');
      assert.ok(!has((c) => c.type === 'steer'), '整段时序里不该出现任何 steer');
    });

    await check('2. clear_queue 排在 abort 之前（官方顺序：先清队列再中止）', async () => {
      resetLog();
      pi.state.abortMode = 'manual';
      await post({ type: 'prompt', message: 'A' });
      /* Stop 之前已经有排队的 steering / follow-up（abort 会把它们继续跑完）。 */
      await post({ type: 'steer', message: '改方向' });
      await post({ type: 'follow_up', message: '做完再说' });
      const stopping = post({ type: 'abort' });
      await waitFor('abort 到达 Pi', () => has((c) => c.type === 'abort'));
      const order = pi.writes.map((c) => c.type);
      assert.ok(order.indexOf('steer') < order.indexOf('clear_queue'), 'clear_queue 必须在排队消息之后');
      assert.ok(order.indexOf('clear_queue') < order.indexOf('abort'), 'clear_queue 必须在 abort 之前');
      assert.equal(raw.stopState().queue, 'cleared', 'clear_queue 的处置要如实记录');
      pi.respondAbort();
      const result = await stopping;
      assert.equal(result.status, 200);
      await waitFor('屏障解除', () => !raw.stopState());
    });

    await check('3. abort 应答先到 → 以 abort-response 解除；随后的 agent_settled 不产生错误状态', async () => {
      resetLog();
      pi.state.abortMode = 'manual';
      const stopping = post({ type: 'abort' });
      await waitFor('abort 到达 Pi', () => has((c) => c.type === 'abort'));
      pi.respondAbort();
      const result = await stopping;
      assert.deepEqual(result, { status: 200, body: { ok: true, stop: { evidence: 'abort-response', queue: 'cleared' } } });
      /* 应答之后才到的 agent_settled：只是普通事件，不该再改什么。 */
      pi.settle();
      await sleep(20);
      assert.equal(raw.stopState(), null);
      assert.deepEqual(await post({ type: 'prompt', message: 'C' }), { status: 200, body: { ok: true } });
    });

    await check('4. agent_settled 先到 → 回读 get_state 确认 idle 才解除（evidence = agent-settled-idle）', async () => {
      resetLog();
      pi.state.abortMode = 'manual';
      const stopping = post({ type: 'abort' });
      await waitFor('abort 到达 Pi', () => has((c) => c.type === 'abort'));
      /* 只发 agent_settled、**不回** abort 应答：必须能靠「事件 + 回读」收口。 */
      pi.settle();
      const result = await stopping;
      assert.equal(result.status, 200);
      assert.equal(result.body.stop.evidence, 'agent-settled-idle', 'abort 应答没来，只可能是回读确认的');
      assert.ok(has((c) => c.type === 'get_state'), '必须回读一次 get_state 才敢解除');
      assert.equal(published.filter((e) => e.type === 'stop_state' && e.evidence === 'agent-settled-idle').length, 1,
        '这条路径的解除也要广播出去（SSE）');
    });

    await check('5. abort 应答失败 → 不宣称成功，屏障继续挡着', async () => {
      resetLog();
      pi.state.abortMode = 'fail';
      const result = await post({ type: 'abort' });
      assert.equal(result.status, 503);
      assert.equal(result.body.code, 'stop_unconfirmed');
      assert.equal(raw.stopState()?.pending, true, 'abort 明确失败也不能解除');
      const blocked = await post({ type: 'prompt', message: 'B' });
      assert.equal(blocked.body.code, 'stop_in_progress');
      /* 恢复：Pi 自己 settle 了（回读确认 idle）才放行。 */
      pi.state.abortMode = 'manual';
      pi.settle();
      await waitFor('屏障解除', () => !raw.stopState());
      assert.deepEqual(await post({ type: 'prompt', message: 'B' }), { status: 200, body: { ok: true } });
    });

    await check('6. clear_queue 不被支持（旧 Pi）→ 明确降级，abort 与屏障照旧', async () => {
      resetLog();
      pi.state.queueMode = 'unsupported';
      pi.state.abortMode = 'manual';
      const stopping = post({ type: 'abort' });
      await waitFor('abort 到达 Pi', () => has((c) => c.type === 'abort'));
      assert.equal(raw.stopState().queue, 'unsupported', '不认识这条命令要如实记为 unsupported');
      const blocked = await post({ type: 'steer', message: 'B' });
      assert.equal(blocked.body.code, 'stop_in_progress');
      pi.respondAbort();
      const result = await stopping;
      assert.equal(result.status, 200);
      assert.equal(result.body.stop.queue, 'unsupported');
      pi.state.queueMode = 'ok';
    });

    await check('7. 连续点 Stop：只写出一次 clear_queue / abort，第二次复用同一个等待', async () => {
      resetLog();
      pi.state.abortMode = 'manual';
      const first = post({ type: 'abort' });
      await waitFor('abort 到达 Pi', () => has((c) => c.type === 'abort'));
      const second = post({ type: 'abort' });
      await sleep(30);
      assert.equal(pi.writes.filter((c) => c.type === 'abort').length, 1, '不能有第二条 abort');
      assert.equal(pi.writes.filter((c) => c.type === 'clear_queue').length, 1, '不能有第二条 clear_queue');
      pi.respondAbort();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200, '第二次 Stop 也要拿到权威结论（复用同一次停止）');
      assert.equal(raw.stopState(), null);
    });

    await check('8. 认证同步中不绕过后端闸门，且不会留下屏障', async () => {
      resetLog();
      syncing = true;
      try {
        const result = await post({ type: 'abort' });
        assert.equal(result.body.code, 'auth-syncing');
      } finally { syncing = false; }
      assert.equal(raw.stopState(), null, '闸门拒掉的停止不该立起屏障');
      assert.equal(pi.writes.length, 0, '被闸门拒掉的停止不该写任何命令');
      assert.equal(guarded.length > 0, true, 'abortAndWait 也必须过 modelGeneration 守卫');
      assert.equal(modelAccepted.length > 0, true, 'abortAndWait 也必须记账');
      assert.equal(activityAccepted.length > 0, true, 'abortAndWait 也必须记账（piActivity）');
    });

    /* 放在最后：它真的会把 bridge 打换代，之后的用例不再依赖这颗 child。 */
    await check('9. bridge 换代（重启 Pi / 换工作区）→ 屏障随手作废，不会把界面永久锁死', async () => {
      resetLog();
      pi.state.abortMode = 'silent';
      const stopping = post({ type: 'abort' });
      await waitFor('abort 到达 Pi', () => has((c) => c.type === 'abort'));
      assert.equal((await post({ type: 'prompt', message: 'B' })).body.code, 'stop_in_progress');
      raw.restart();
      const result = await stopping;
      assert.equal(result.status, 503);
      assert.equal(result.body.code, 'stop_reset', '换代不是「Pi 确认停止」，要如实分开');
      assert.equal(raw.stopState(), null, '屏障必须随换代解除');
    });

    /* ================= 前端：stopping 是独立于 streaming 的第三态 =================
     *
     * 这里只到 rpc.js 那一层（stop / submit / state / messages）。app.js 的装配
     * （按钮 onclick、Enter 键、stop_state 的 SSE 分发）在 tests/smoke.cjs 里测 ——
     * 那一份才有真实的 index.html + app.js。 */

    const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'),
      { url: 'http://localhost:7788', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.ResizeObserver = class { observe() {} disconnect() {} };
    const commands = [];
    let reply = { ok: true };
    w.fetch = async (target, options) => {
      commands.push({ target, body: JSON.parse(options.body) });
      const body = await (typeof reply === 'function' ? reply() : reply);
      if (body?.__network) throw new Error('fixture network down');
      return { ok: body.ok !== false, status: body.ok === false ? 503 : 200, json: async () => body };
    };
    const frontend = w.eval(bundle(path.join(PUB, 'rpc.js')).code);

    const ready = (streaming = true) => {
      frontend.S.streaming = streaming;
      frontend.S.stopping = false;
      frontend.S.stopOwnedTurn = false;
      frontend.S.bridgeRun = 1;
      frontend.S.hasProject = true;
      frontend.S.switching = false;
      frontend.S.bridgeState = 'ready';
      frontend.S.submitting = false;
      frontend.S.attachments = [];
      frontend.el.input.value = '准备发送';
      frontend.el.statusText.textContent = '正在处理';
      frontend.el.toasts.replaceChildren();
      frontend.updateSendState();
      commands.length = 0;
    };
    const abortCalls = () => commands.filter((c) => c.body?.type === 'abort').length;
    const sentOf = (type) => commands.filter((c) => c.body?.type === type);

    try {
      await check('10. 点 Stop 立即进入 stopping：发送键禁用、状态是「正在停止…」', async () => {
        ready(); const pending = deferred(); reply = pending.promise;
        assert.equal(frontend.el.btnSend.disabled, false, '前提：停止之前发送键是可用的');
        const stopping = frontend.stop();
        assert.equal(frontend.S.stopping, true);
        assert.equal(frontend.el.btnSend.disabled, true);
        assert.equal(frontend.el.statusText.textContent, '正在停止…');
        assert.equal(abortCalls(), 1);
        pending.resolve({ ok: true, stop: { evidence: 'abort-response' } });
        await stopping;
      });

      await check('11. 停止未完成时：submit 不发送、再点 Stop 不重发、输入的字留着', async () => {
        ready(); const pending = deferred(); reply = pending.promise;
        const stopping = frontend.stop();
        const before = commands.length;
        frontend.el.input.value = 'B';
        await frontend.submit();
        await frontend.stop();
        assert.equal(commands.length, before, '停止期间一个命令都不许发出去');
        assert.equal(abortCalls(), 1, '第二次 Stop 不能重发 abort');
        pending.resolve({ ok: true, stop: { evidence: 'abort-response' } });
        await stopping;
        assert.equal(frontend.el.input.value, 'B', '输入框里的字要留着（只是不让提交）');
      });

      await check('12. agent_settled 先到不解除 stopping；stop_state 事件才收口', async () => {
        ready(); const pending = deferred(); reply = pending.promise;
        const stopping = frontend.stop();
        frontend.onSettled();
        assert.equal(frontend.S.stopping, true, 'agent_settled 不是停止确认');
        assert.equal(frontend.el.statusText.textContent, '正在停止…');
        /* HTTP 超时：界面明说还没得到确认，**保持保护**。 */
        pending.resolve({ ok: false, code: 'stop_unconfirmed', error: '停止尚未得到 Pi 确认，请等待或重启 Pi。' });
        await stopping;
        assert.equal(frontend.S.stopping, true);
        assert.match(frontend.el.statusText.textContent, /停止尚未得到 Pi 确认/);
        assert.equal(frontend.el.btnSend.disabled, true);
        /* 屏障稍后才解除 —— 由后端广播的 stop_state 收口。 */
        frontend.onStopState({ state: 'stopped', evidence: 'abort-response' });
        assert.equal(frontend.S.stopping, false);
        assert.equal(frontend.S.streaming, false);
        assert.equal(frontend.el.statusText.textContent, '已停止');
        /* 断线重连补发的历史事件不许写状态。 */
        frontend.el.statusText.textContent = '';
        frontend.onStopState({ state: 'stopped', evidence: 'abort-response', _replay: true });
        assert.equal(frontend.el.statusText.textContent, '');
      });

      await check('13. HTTP 应答先到：abort 应答保证已空闲，下一条消息走 prompt 而不是 steer', async () => {
        ready(); reply = { ok: true, stop: { evidence: 'abort-response' } };
        await frontend.stop();
        assert.equal(frontend.S.stopping, false);
        assert.equal(frontend.S.streaming, false, 'abort 应答 = 会话已空闲，不必等 agent_settled');
        assert.equal(frontend.el.statusText.textContent, '已停止');
        commands.length = 0;
        frontend.el.input.value = '在项目里创建一个 hello.txt';
        await frontend.submit();
        const sent = sentOf('prompt');
        assert.equal(sent.length, 1, 'Stop 完成后必须是 prompt');
        assert.equal(sentOf('steer').length, 0);
      });

      await check('14. 换工作区 / bridge 换代：旧停止作废，迟到应答不再写状态', async () => {
        ready(); const pending = deferred(); reply = pending.promise;
        const stopping = frontend.stop();
        frontend.beginWorkspaceSwitch('/other');
        assert.equal(frontend.S.stopping, false, '换工作区必须解除 stopping');
        pending.resolve({ ok: true, stop: { evidence: 'abort-response' } });
        await stopping;
        assert.notEqual(frontend.el.statusText.textContent, '已停止', '迟到的旧停止不许写新工作区的状态');

        ready(); const second = deferred(); reply = second.promise;
        const again = frontend.stop();
        frontend.invalidateStop();
        assert.equal(frontend.S.stopping, false, 'bridge 生命周期变了要解除 stopping');
        second.resolve({ ok: true, stop: { evidence: 'abort-response' } });
        await again;
      });

      await check('15. 网络失败 = 没问到，不算停止完成', async () => {
        ready(); reply = { __network: true };
        await frontend.stop();
        assert.equal(frontend.S.stopping, true, '没问到后端就必须保持保护');
        assert.equal(frontend.el.btnSend.disabled, true);
      });

      await check('16. 用户主动停止的中断消息按中性状态呈现；非本次停止的取消照旧报错', async () => {
        const render = (msg) => {
          const body = w.document.createElement('div');
          frontend.rebuildAssistant(body, msg);
          return body;
        };
        frontend.S.stopOwnedTurn = true;
        const owned = render({ role: 'assistant', content: [{ type: 'text', text: '半句' }], stopReason: 'aborted', errorMessage: '请求已取消' });
        assert.equal(owned.querySelector('.msg-note')?.textContent, '已由用户取消');
        assert.equal(owned.querySelector('.msg-err'), null, '本次停止不能渲染成错误');

        /* 归属只属于那一轮 run：新一轮一开始就失效。 */
        frontend.setStreaming(true);
        assert.equal(frontend.S.stopOwnedTurn, false);
        const unowned = render({ role: 'assistant', content: [{ type: 'text', text: '半句' }], stopReason: 'aborted', errorMessage: '请求已取消' });
        assert.ok(unowned.querySelector('.msg-err'), '不是本次停止的取消必须照常显示错误');
        assert.equal(unowned.querySelector('.msg-note'), null);

        /* 没有归属、也没有 errorMessage 时，旧行为不变。 */
        const plain = render({ role: 'assistant', content: [], stopReason: 'aborted' });
        assert.equal(plain.querySelector('.msg-note')?.textContent, '已中断');
      });
    } finally { w.close(); }
  } finally {
    serverStopped = true;
    raw.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(published.some((e) => e.type === 'stop_state'), true, '停止状态必须广播出去（SSE）');
  }

  console.log(`stop-barrier: ${passed}/${passed + failed} cases passed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
