const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
let checks = 0; const check = async (name, fn) => { await fn(); checks++; console.log('  ok  ' + name); };
(async () => {
  const { createRuntimeRegistry } = await import('../server/runtime-registry.js');
  const { createRuntimeRoutes } = await import('../server/runtime-routes.js');
  const { createRouter } = await import('../server/router.js');
  const { createAuth } = await import('../server/auth.js');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-runtime-http-')), cwd = path.join(fixture, 'workspace'); fs.mkdirSync(cwd);
  let wire = [], resolveHealth, healthEntered, pendingHealth = null;
  const registry = createRuntimeRegistry({ dataDir: fixture, resolveWorkspace: async () => ({ projectId: 'p', repoId: 'r', workspaceId: 'w', workspaceEpoch: 'e', cwd, root: cwd, branch: 'branch' }),
    validateWorkspace: async () => { if (pendingHealth) { healthEntered?.(); await pendingHealth; } },
    factory: async (_context, emit) => ({ start: () => emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }),
      send: cmd => wire.push(cmd), request: async cmd => cmd.type === 'get_state' ? { sessionId: 'native' } : { messages: [] },
      abortAndWait: async () => { wire.push({ type: 'abort' }); return { ok: true }; }, getState: () => ({ state: 'ready' }), dispose: async () => {}, cleanupConfirmed: () => true }) });
  const auth = createAuth({ token: 'fixture-auth', port: 7788, appId: 'pi-gui', protocol: 1, version: '0.22.0' });
  const legacy = { backendInstance: 'primary', runtimeId: 'classic', runtimeGeneration: '1' };
  const router = createRouter({ auth, sse: { subscribe() {} }, rpc: { getState: () => ({ state: 'ready' }), send: cmd => wire.push({ legacy: true, ...cmd }) },
    runtimeSessions: createRuntimeRoutes({ registry }), requireLegacyScope: () => registry.liveCount() > 0, legacyScope: () => legacy });
  const server = http.createServer(router); await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body, headers = {}, endpoint = '/api/runtime-sessions') => { const r = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Gui-Token': 'fixture-auth', ...headers }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    await check('runtime HTTP受现有 token鉴权', async () => { const r = await fetch(base + '/api/runtime-sessions'); assert.equal(r.status, 401); });
    await check('跨 Origin token正确仍拒绝', async () => assert.equal((await post({ action: 'start', args: { id: 'w', epoch: 'e' } }, { Origin: 'https://foreign.invalid' })).status, 403));
    const started = await post({ action: 'start', args: { id: 'w', epoch: 'e' } }); assert.equal(started.body.ok, true);
    const snapshot = await (await fetch(base + '/api/runtime-sessions', { headers: { 'X-Pi-Gui-Token': 'fixture-auth' } })).json(); const owner = snapshot.items[0].owner;
    await check('启动/快照 owner齐全，不按activeUI路由', () => { assert.ok(owner.sessionId); assert.equal(owner.workspaceId, 'w'); assert.ok(owner.runtimeId); });
    await check('command缺身份拒绝', async () => assert.equal((await post({ action: 'command', command: { type: 'prompt', message: 'x' } })).body.code, 'stale_runtime'));
    await check('经典写入口在并行时缺scope拒绝', async () => assert.equal((await post({ type: 'prompt', message: 'x' }, {}, '/api/command')).body.code, 'stale_runtime'));
    await check('经典 owner不能发独立会话命令', async () => assert.equal((await post({ action: 'command', owner: legacy, command: { type: 'prompt', message: 'x' } })).body.code, 'stale_runtime'));
    await check('scoped命令接受且仅写目标', async () => { assert.equal((await post({ action: 'command', owner, command: { type: 'prompt', message: 'owned' } })).body.ok, true); assert.equal(wire.at(-1).message, 'owned'); });
    await check('只读回读不成为prompt旁路', async () => assert.equal((await post({ action: 'read', owner, command: { type: 'prompt', message: 'escape' } })).body.code, 'invalid_command'));
    await check('客户端未知控制字段拒绝', async () => assert.equal((await post({ action: 'command', owner, command: { type: 'prompt' }, pid: 1 })).body.ok, false));
    await check('经典scope正确仍可独立发命令', async () => { assert.equal((await post({ type: 'get_state' }, { 'X-Pi-Gui-Owner': JSON.stringify(legacy) }, '/api/command')).body.ok, true); assert.equal(wire.at(-1).legacy, true); });
    pendingHealth = new Promise(r => resolveHealth = r);
    const entered=new Promise(r=>healthEntered=r);
    const late = post({ action: 'command', owner, command: { type: 'prompt', message: 'late' } });
    await entered; await registry.close(owner); resolveHealth(); pendingHealth = null;
    await check('body/read/preflight晚到owner失效，未写stdin', async () => { assert.equal((await late).body.code, 'stale_runtime'); assert.ok(!wire.some(c => c.message === 'late')); });
    await check('关闭保留conversation且不信旧owner', async () => assert.equal((await post({ action: 'command', owner, command: { type: 'abort' } })).body.code, 'stale_runtime'));
  } finally { await registry.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(fixture, { recursive: true, force: true }); }
  console.log(`Runtime HTTP: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
