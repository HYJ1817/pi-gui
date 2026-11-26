/* 历史消息编辑的 HTTP 边界：路由如何绑定 bridge 代次、status/recover 如何在
 * bridge 换代后仍可查询，以及 `/api/restart` 的编辑事务闸门。
 *
 * 这里不启动完整 server.js，也不 spawn Pi：路由只做鉴权后的 owner 核对与 io
 * 构造，业务状态机由 message-edit-service 的测试覆盖。重点验证「旧实现会在
 * bridge 换代后拒绝 status/recover」这一回归不会回来。
 */
'use strict';
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

let checks = 0;
const pass = async (name, fn) => {
  try { await fn(); checks++; console.log('PASS ' + name); }
  catch (error) { console.error('FAIL ' + name + ': ' + (error.stack || error.message)); throw error; }
};

const OWNER = { backendInstance: 'fixture', runtimeId: 'classic', runtimeGeneration: '1' };

function response() {
  const out = { code: 0, body: null };
  out.done = new Promise(resolve => { out.finish = resolve; });
  out.writeHead = code => { out.code = code; };
  out.end = payload => { out.body = payload ? JSON.parse(payload) : null; out.finish(); };
  return out;
}

function requestFor({ method = 'POST', url = '/api/message-edit', body = null, owner = OWNER } = {}) {
  const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = owner ? { 'x-pi-gui-owner': JSON.stringify(owner) } : {};
  return req;
}

(async () => {
  const { createMessageEditRoutes } = await import('../server/message-edit-routes.js');
  const { createRouter } = await import('../server/router.js');

  const state = {
    owner: { ...OWNER },
    bridgeRun: 1,
    workspaceGeneration: 1,
    cwd: '/fixture/project',
    sessionId: 'native-1',
  };
  const seen = { status: [], recover: [], preflight: [], resend: [], requests: [], beforePrompt: 0, afterPrompt: 0, forceStale: false, throwPreflight: false };
  let statusResult = { ok: true, state: 'accepted', result: { ok: true, accepted: true } };

  /* 状态查询故意在 bridgeRun 已变化后调用 io.validate()：status / recover 不能
   * 绑定 bridge 代次，否则 bridge 重启后原 requestId 永远查不到结果。 */
  const service = {
    async status(io, requestId) {
      seen.status.push({ requestId, sessionId: io.sessionId });
      const saved = state.bridgeRun;
      state.bridgeRun = saved + 1;
      try { io.validate(); } finally { state.bridgeRun = saved; }
      return statusResult;
    },
    async recover(io, requestId) {
      seen.recover.push({ requestId, sessionId: io.sessionId });
      const saved = state.bridgeRun;
      state.bridgeRun = saved + 1;
      try { io.validate(); } finally { state.bridgeRun = saved; }
      return statusResult;
    },
    async preflight(io, body) {
      seen.preflight.push(body);
      if (seen.throwPreflight) throw Object.assign(Error('stale_runtime'), { code: 'stale_runtime' });
      io.validate();
      return { ok: true, entryId: 'entry-1', parentId: null, leafId: 'leaf-1', sessionId: state.sessionId };
    },
    async resend(io, body) {
      seen.resend.push(body);
      if (seen.forceStale) {
        /* 正式提交必须绑定 bridge 代次：命令通道换掉后，这条事务不能再写。 */
        const saved = state.bridgeRun;
        state.bridgeRun = saved + 1;
        try { io.validate(); } catch (error) { return { ok: false, code: error.code }; } finally { state.bridgeRun = saved; }
        return { ok: true, accepted: true };
      }
      await io.request({ type: 'prompt', message: '/edit-cmd target leaf parent native-1 req-1 token-1', __messageEditNav: true });
      await io.request({ type: 'prompt', message: body.text });
      return { ok: true, accepted: true };
    },
  };

  const routes = createMessageEditRoutes({
    service,
    getOwner: () => state.owner,
    getSessionId: () => state.sessionId,
    commandName: () => 'edit-cmd',
    editToken: () => 'token-1',
    getBridgeRun: () => state.bridgeRun,
    getWorkspaceGeneration: () => state.workspaceGeneration,
    getCwd: () => state.cwd,
    request: async cmd => {
      seen.requests.push(cmd);
      if (cmd.type === 'get_state') return { ok: true, data: { sessionId: state.sessionId } };
      return { ok: true, data: { disposition: 'started' } };
    },
    beforePrompt: async () => { seen.beforePrompt++; },
    afterPrompt: () => { seen.afterPrompt++; },
  });

  const call = async options => {
    const res = response();
    await routes.handle(requestFor(options), res, new URL(options.url || '/api/message-edit', 'http://localhost'));
    return res;
  };

  await pass('GET status after a bridge generation change still returns the original requestId result', async () => {
    state.bridgeRun = 7;
    const res = await call({ method: 'GET', url: '/api/message-edit/status?requestId=req-status-1' });
    assert.equal(res.code, 200);
    assert.equal(res.body.state, 'accepted');
    assert.equal(seen.status.at(-1).requestId, 'req-status-1');
    assert.equal(seen.status.at(-1).sessionId, 'native-1', 'status uses the native session, not the body');
  });

  await pass('POST status and recover work through the same bridge-independent io', async () => {
    const status = await call({ body: { action: 'status', requestId: 'req-status-2' } });
    assert.equal(status.code, 200);
    assert.equal(status.body.state, 'accepted');
    const recover = await call({ body: { action: 'recover', requestId: 'req-recover-1' } });
    assert.equal(recover.code, 200);
    assert.equal(recover.body.state, 'accepted');
    assert.equal(seen.recover.at(-1).requestId, 'req-recover-1');
    assert.equal(seen.recover.at(-1).sessionId, 'native-1');
  });

  await pass('formal submit forwards the full stable target identity and gates only the edited prompt', async () => {
    const body = {
      action: 'resend', userIndex: 0, kind: 'edit', text: 'edited',
      expectedEntryId: 'entry-1', expectedParentId: null, expectedLeafId: 'leaf-1',
      expectedSessionId: 'native-1', requestId: 'req-resend-1',
    };
    const res = await call({ body });
    assert.equal(res.code, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(seen.resend.at(-1), body);
    assert.equal(seen.beforePrompt, 1, 'only the edited prompt passes the mutation gate');
    assert.equal(seen.afterPrompt, 1, 'only the started prompt is recorded as a run');
    assert.deepEqual(seen.requests.filter(cmd => cmd.type === 'prompt').map(cmd => cmd.message),
      ['/edit-cmd target leaf parent native-1 req-1 token-1', 'edited']);
  });

  await pass('formal submit is rejected once the bridge generation changes', async () => {
    seen.forceStale = true;
    try {
      const res = await call({ body: {
        action: 'resend', userIndex: 0, kind: 'edit', text: 'edited',
        expectedEntryId: 'entry-1', expectedParentId: null, expectedLeafId: 'leaf-1',
        expectedSessionId: 'native-1', requestId: 'req-stale-1',
      } });
      assert.equal(res.code, 409);
      assert.equal(res.body.code, 'stale_runtime');
    } finally { seen.forceStale = false; }
  });

  await pass('route never invents missing target identity (the service rejects it)', async () => {
    const body = { action: 'resend', userIndex: 0, kind: 'edit', text: 'x', expectedEntryId: 'entry-1', expectedLeafId: 'leaf-1', requestId: 'req-missing-1' };
    const res = await call({ body });
    assert.equal(res.code, 200);
    const forwarded = seen.resend.at(-1);
    assert.equal(Object.hasOwn(forwarded, 'expectedParentId'), false);
    assert.equal(Object.hasOwn(forwarded, 'expectedSessionId'), false);
  });

  await pass('unknown actions and unknown body keys are rejected before touching the service', async () => {
    const before = seen.resend.length;
    const unknown = await call({ body: { action: 'delete', requestId: 'req-unknown-1' } });
    assert.equal(unknown.code, 400);
    const extra = await call({ body: { action: 'resend', expectedEntryId: 'entry-1', expectedLeafId: 'leaf-1', expectedParentId: null, expectedSessionId: 'native-1', userIndex: 0, kind: 'edit', text: 'x', requestId: 'req-extra-1', pid: 1 } });
    assert.equal(extra.code, 400);
    assert.equal(seen.resend.length, before);
  });

  await pass('owner mismatch is rejected for every message-edit entry point', async () => {
    const transient = { ...OWNER, runtimeGeneration: '2', runtimeId: 'bridge-2' };
    const other = { ...OWNER, workspaceEpoch: '2' };
    for (const options of [
      { method: 'GET', url: '/api/message-edit/status?requestId=req-status-1', owner: other },
      { body: { action: 'status', requestId: 'req-status-1' }, owner: other },
      { body: { action: 'recover', requestId: 'req-recover-1' }, owner: other },
      { body: { action: 'preflight', userIndex: 0, kind: 'edit' }, owner: transient },
      { body: { action: 'preflight', userIndex: 0, kind: 'edit' }, owner: null },
    ]) {
      const res = await call(options);
      assert.equal(res.code, 409, JSON.stringify(options));
      assert.equal(res.body.code, 'stale_runtime');
    }
    /* status / recover 必须能跨 bridge 代次：runtimeId / runtimeGeneration
     * 变了，但项目、工作区、conversation 没变，查询仍应进入服务层；
     * native session 是否一致由服务回读 get_state 判定。 */
    for (const options of [
      { method: 'GET', url: '/api/message-edit/status?requestId=req-status-1', owner: transient },
      { body: { action: 'status', requestId: 'req-status-1' }, owner: transient },
      { body: { action: 'recover', requestId: 'req-recover-1' }, owner: transient },
    ]) {
      const res = await call(options);
      assert.equal(res.code, 200, JSON.stringify(options));
    }
  });

  await pass('route preserves the service error code instead of flattening it to invalid_request', async () => {
    seen.throwPreflight = true;
    try {
      const res = await call({ body: { action: 'preflight', userIndex: 0, kind: 'edit' } });
      assert.equal(res.code, 409);
      assert.equal(res.body.code, 'stale_runtime');
    } finally { seen.throwPreflight = false; }
  });

  await pass('preflight requires an authoritative native session before constructing io', async () => {
    const original = state.sessionId;
    state.sessionId = null;
    try {
      const res = await call({ body: { action: 'preflight', userIndex: 0, kind: 'edit' } });
      assert.equal(res.code, 409);
      assert.equal(res.body.code, 'stale_session');
    } finally { state.sessionId = original; }
  });

  await pass('/api/restart is blocked while the edit transaction owns the bridge', async () => {
    let restarts = 0;
    let guard = async () => { throw Object.assign(Error('消息编辑事务进行中，请稍候。'), { code: 'edit_in_progress' }); };
    const router = createRouter({
      auth: { denyRequest: () => null },
      rpc: { restart: () => { restarts++; }, getState: () => ({ state: 'ready' }) },
      restartGuard: () => guard(),
    });
    const hit = async () => {
      const req = Readable.from([]);
      req.method = 'POST';
      req.url = '/api/restart';
      req.headers = {};
      const res = response();
      router(req, res);
      await Promise.race([res.done, new Promise((_, reject) => setTimeout(() => reject(new Error('restart_timeout')), 1000))]);
      return res;
    };
    const blocked = await hit();
    assert.equal(blocked.code, 503);
    assert.equal(blocked.body.code, 'edit_in_progress');
    assert.equal(restarts, 0, 'bridge was not restarted');
    guard = async () => {};
    const allowed = await hit();
    assert.equal(allowed.code, 200);
    assert.equal(allowed.body.ok, true);
    assert.equal(restarts, 1);
  });

  await pass('completed Stop during an awaited Classic edit gate rejects the old prompt, not the next explicit input', async () => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let stopGeneration = 0, hold = true; const sent = [];
    const fixture = createMessageEditRoutes({
      service: { async resend(io, body) { return io.request({ type: 'prompt', message: body.text }); } },
      getOwner: () => OWNER, getSessionId: () => 'native-1', getBridgeRun: () => 1,
      getWorkspaceGeneration: () => 1, getCwd: () => '/fixture/project',
      captureCommandGuard: () => { const expected = stopGeneration; return () => {
        if (expected !== stopGeneration) throw Object.assign(Error('stale_runtime'), { code: 'stale_runtime' });
      }; },
      beforePrompt: async () => { if (hold) { entered.resolve(); await release.promise; } },
      request: async cmd => { sent.push(cmd); return { ok: true, data: cmd.type === 'get_state' ? { sessionId: 'native-1' } : { disposition: 'started' } }; },
    });
    const hit = async text => {
      const req = requestFor({ body: { action: 'resend', text, requestId: 'stop-gate-fixture' } }), res = response();
      await fixture.handle(req, res, new URL('/api/message-edit', 'http://localhost')); return res;
    };
    const input = 'KEEP_EDIT_DRAFT', waiting = hit(input); await entered.promise;
    stopGeneration++; hold = false; release.resolve();
    const rejected = await waiting; assert.equal(rejected.code, 409); assert.equal(rejected.body.code, 'stale_runtime');
    assert.equal(sent.filter(cmd => cmd.type === 'prompt').length, 0);
    const fresh = await hit(input); assert.equal(fresh.code, 200);
    assert.deepEqual(sent.filter(cmd => cmd.type === 'prompt').map(cmd => cmd.message), [input]);
  });

  console.log(`Message edit HTTP: ${checks}/${checks}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
