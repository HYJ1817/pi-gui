const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('  ok  ' + name); }
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  let createRuntimeRegistry;
  try { ({ createRuntimeRegistry } = await import('../server/runtime-registry.js')); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
  await check('独立 registry 可用', () => assert.equal(typeof createRuntimeRegistry, 'function'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-runtime-registry-'));
  const events = [], contexts = new Map(), adapters = [], workspaces = new Map();
  for (const id of ['A', 'B', 'C']) { const cwd = path.join(dir, id); fs.mkdirSync(cwd); workspaces.set(id, { projectId: 'project', repoId: 'repo', workspaceId: id, workspaceEpoch: 'epoch-' + id, cwd, root: cwd, branch: id }); }
  let external = 0, blocked = false, hold = null, spawnCount = 0;
  const options = { dataDir: dir, publish: e => events.push(e), externalCount: () => external,
    beforeStart: () => blocked ? 'maintenance' : null,
    resolveWorkspace: async args => { if (hold) await hold; const w = workspaces.get(args.id); if (!w || args.epoch !== w.workspaceEpoch) throw Object.assign(Error(), { code: 'stale_workspace' }); return { ...w }; },
    validateWorkspace: async w => { if (hold) await hold; if (workspaces.get(w.workspaceId)?.workspaceEpoch !== w.workspaceEpoch) throw Object.assign(Error(), { code: 'stale_workspace' }); },
    factory: async (context, emit) => {
      spawnCount++; contexts.set(context.owner.conversationId, context);
      let status = { state: 'starting', bridgeRun: 1 }, disposed = false, sessionId = null;
      const commands = [], adapter = { commands, context, emit, start() { status.state = 'ready'; sessionId = 'native-' + context.owner.workspaceId; emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }); },
        getState: () => ({ ...status, piRunning: !disposed, stop: null }),
        send: cmd => { commands.push(cmd); }, abortAndWait: async () => { commands.push({ type: 'abort' }); return { ok: true, evidence: 'pi-abort-response' }; },
        request: async cmd => cmd.type === 'get_state' ? { sessionId, isStreaming: false } : { messages: [] },
        dispose: async () => { disposed = true; }, cleanupConfirmed: () => disposed };
      adapters.push(adapter); return adapter;
    } };
  let registry = createRuntimeRegistry(options);
  const reject = (fn, code) => assert.rejects(fn, e => e.code === code);
  const start = (id, extra = {}) => registry.start({ id, epoch: 'epoch-' + id, ...extra });
  function controlled(name, { locator = () => null, cleanup = async () => {}, admission } = {}) {
    const scopedEvents = [], children = [];
    const w = { ...workspaces.get('A') };
    const instance = createRuntimeRegistry({ dataDir: path.join(dir, name), resolveWorkspace: async () => ({ ...w }),
      validateWorkspace: async () => {}, admission, publish: e => scopedEvents.push(e),
      factory: async (context, emit) => {
        const index = children.length; let disposed = false;
        const adapter = { emit, context, disposeCalls: 0,
          start: () => emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }),
          request: async () => ({ sessionId: 'native-controlled-A' }),
          getState: () => ({ state: 'ready', stop: null }), send() {},
          sessionLocator: () => locator(index),
          async dispose() { adapter.disposeCalls++; await cleanup(index); disposed = true; },
          cleanupConfirmed: () => disposed };
        children.push(adapter); return adapter;
      } });
    return { instance, children, events: scopedEvents, workspace: w };
  }
  try {
    await check('列举不 spawn', () => { assert.equal(registry.snapshot().items.length, 0); assert.equal(spawnCount, 0); });
    const a = await start('A'); await tick(); const ao = registry.snapshot().items[0].owner;
    const b = await start('B'); await tick(); const bo = registry.snapshot().items.find(e => e.owner.workspaceId === 'B').owner;
    await check('A/B child 与 immutable cwd 独立', () => { assert.equal(spawnCount, 2); assert.notEqual(ao.runtimeId, bo.runtimeId); assert.notEqual(contexts.get(ao.conversationId).cwd, contexts.get(bo.conversationId).cwd); });
    await check('并行 writer 不共用工作区', () => reject(() => start('A'), 'workspace_in_use'));
    await check('默认 2 个上限', () => reject(() => start('C'), 'runtime_limit'));
    const c = await start('C', { allowThird: true }); await tick();
    await check('第三条必须显式允许且硬上限 3', () => { assert.equal(registry.snapshot().liveCount, 3); });
    await check('命令缺 owner 拒绝', () => reject(() => registry.command(null, { type: 'prompt', message: 'x' }), 'stale_runtime'));
    await check('旧 generation 拒绝', () => reject(() => registry.command({ ...ao, runtimeGeneration: 'old' }, { type: 'prompt', message: 'x' }), 'stale_runtime'));
    await registry.command(ao, { type: 'prompt', id: 'same', message: 'only A' });
    await registry.command(bo, { type: 'prompt', id: 'same', message: 'only B' });
    await check('同 request id 写入各自 stdin且 owner 不进 Pi wire', () => { assert.equal(adapters[0].commands[0].message, 'only A'); assert.equal(adapters[1].commands[0].message, 'only B'); assert.ok(!('owner' in adapters[0].commands[0])); });
    adapters[0].emit({ type: 'agent_start', bridgeRun: 1 }); adapters[1].emit({ type: 'agent_start', bridgeRun: 1 });
    await registry.command(ao, { type: 'abort' });
    await check('Stop A 不停止 B，agent_end不代表idle', () => { assert.equal(adapters[0].commands.at(-1).type, 'abort'); assert.equal(adapters[1].commands.length, 1); adapters[1].emit({ type: 'agent_end', bridgeRun: 1 }); assert.equal(registry.snapshot().items.find(i => i.owner.workspaceId === 'B').activity, 'running'); });
    await check('不能用 switch_session 改写固定 conversation', () => reject(() => registry.command(ao, { type: 'switch_session', sessionPath: '/tmp/unknown' }), 'invalid_command'));
    await check('Focus 只选视图，不 spawn/stop', async () => { await registry.focus(bo); await registry.focus(ao); assert.equal(spawnCount, 3); assert.equal(adapters[1].commands.length, 1); });
    await check('换焦点时旧会话也被广播（前端按 item.focused 画，否则会两行同时高亮）', async () => {
      const before = events.length;
      await registry.focus(bo);
      const states = events.slice(before).filter(e => e.type === 'runtime_state');
      const touched = new Set(states.map(e => e.owner.workspaceId));
      assert.ok(touched.has('A') && touched.has('B'), '两侧都要广播');
      assert.equal(states.filter(e => e.item.focused).length, 1, '同一时刻只有一条 focused');
      assert.equal(states.find(e => e.item.focused).owner.workspaceId, 'B');
      assert.equal(registry.snapshot().items.filter(i => i.focused).length, 1, '快照里也只有一个 focused');
      await registry.focus(ao);
    });
    await check('事件附完整身份，同 toolCallId不合并', () => { adapters[0].emit({ type: 'tool_execution_start', toolCallId: 'same', toolName: 'write' }); adapters[1].emit({ type: 'tool_execution_start', toolCallId: 'same', toolName: 'write' }); const got = events.filter(e => e.event?.type === 'tool_execution_start'); assert.equal(got.length, 2); assert.notEqual(got[0].owner.conversationId, got[1].owner.conversationId); });
    await check('有界 backlog/bytes且截断显式', () => { for (let i = 0; i < 220; i++) adapters[0].emit({ type: 'message_update', delta: 'x'.repeat(8000) }); const state = registry.events(ao, 0); assert.ok(state.events.length <= 200); assert.ok(state.bytes <= 1024 * 1024); assert.equal(state.historyRequired, true); });
    await check('Unicode backlog按UTF8字节计量，预算不按字符估算', () => {
      for (let i = 0; i < 220; i++) adapters[1].emit({ type: 'message_update', delta: '中🙂'.repeat(1000) });
      const state = registry.events(bo, 0);
      assert.ok(state.bytes <= 1024 * 1024);assert.equal(state.historyRequired, true);
      assert.equal(state.bytes, state.events.reduce((bytes, frame) => bytes + Buffer.byteLength(JSON.stringify(frame), 'utf8'), 0));
      assert.ok(state.events.length < 200);
    });
    let release; hold = new Promise(r => release = r);
    const stale = registry.command(ao, { type: 'prompt', message: 'late' });
    const closed = registry.close(ao); release(); hold = null; await closed;
    await check('异步 preflight 后再次校验，迟到命令不执行', () => reject(() => stale, 'stale_runtime'));
    const before = events.length; adapters[0].emit({ type: 'stop_state', pending: false });
    await check('close 后 late callback 不发布', () => assert.equal(events.length, before));
    const restarted = await registry.resume(a.conversationId, { allowThird: true }); await tick();
    await check('恢复 conversation 生新 generation，旧 scope拒绝', async () => { assert.notEqual(restarted.owner.runtimeGeneration, ao.runtimeGeneration); await reject(() => registry.command(ao, { type: 'abort' }), 'stale_runtime'); });
    await registry.dispose(); registry = createRuntimeRegistry(options);
    await check('应用重启只重发现记录，不 spawn、不认旧child', () => { assert.equal(registry.snapshot().liveCount, 0); assert.equal(registry.snapshot().items.length, 3); assert.equal(spawnCount, 4); });
    blocked = true;
    await check('维护禁止新 child', () => reject(() => registry.resume(b.conversationId), 'maintenance'));
    blocked = false; external = 3;
    await check('预算包含外部主 child/CLI', () => reject(() => registry.resume(b.conversationId, { allowThird: true }), 'runtime_limit'));
    external = 0;
    workspaces.set('B', { ...workspaces.get('B'), workspaceEpoch: 'replaced' });
    await check('重发现 external replacement epoch不继承', () => reject(() => registry.resume(b.conversationId), 'stale_workspace'));
    await check('manifest没有env/消息/PID', () => { const raw = fs.readFileSync(path.join(dir, 'conversations.json'), 'utf8'); assert.ok(!raw.includes('only A')); assert.ok(!raw.includes('pid')); assert.ok(!raw.includes('env')); });
    await check('after restart backendInstance不同', () => assert.notEqual(registry.snapshot().backendInstance, ao.backendInstance));
    await check('迟到旧 sessionLocator 不修改恢复后的共享 record', async () => {
      let resolveOld;const oldLocator = new Promise(r => { resolveOld = r; });
      const freshPath = path.join(dir, 'new-session.jsonl'), stalePath = path.join(dir, 'old-session.jsonl');
      fs.writeFileSync(freshPath, 'new fixture');fs.writeFileSync(stalePath, 'old fixture');
      const f = controlled('locator-race', { locator: index => index === 0 ? oldLocator : freshPath });
      try {
        const first = await f.instance.start({ id: 'A', epoch: 'epoch-A' });await tick();
        const oldOwner = f.instance.getOwner(first.conversationId);
        await f.instance.close(oldOwner);await f.instance.resume(first.conversationId);await tick();
        const newOwner = f.instance.getOwner(first.conversationId);
        assert.notEqual(newOwner.runtimeId, oldOwner.runtimeId);
        resolveOld(stalePath);await tick();
        const record = JSON.parse(fs.readFileSync(path.join(dir, 'locator-race/conversations.json'), 'utf8')).items[0];
        assert.equal(record.sessionLocator, freshPath);
        assert.equal(record.sessionId, 'native-controlled-A');
        const next = await f.instance.start({ id: 'unused' }).catch(() => null);
        assert.equal(next, null); // A failed admission/save must not persist the old locator later.
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'locator-race/conversations.json'), 'utf8')).items[0].sessionLocator, freshPath);
      } finally { resolveOld(stalePath);await f.instance.dispose(); }
    });
    await check('并发 close/retire 共享清理承诺，新 lease 与 owner 保留', async () => {
      let releaseCleanup;const cleanupGate = new Promise(r => { releaseCleanup = r; });
      const f = controlled('retire-race', { cleanup: index => index === 0 ? cleanupGate : Promise.resolve() });
      let pending;
      try {
        const first = await f.instance.start({ id: 'A', epoch: 'epoch-A' });await tick();
        const oldOwner = f.instance.getOwner(first.conversationId);
        const closing = f.instance.close(oldOwner), retiring = f.instance.closeAll();
        const resuming = f.instance.resume(first.conversationId);pending = Promise.all([closing, retiring, resuming]);
        await tick();assert.equal(f.children[0].disposeCalls, 1);
        assert.equal(f.instance.inUse(f.workspace.root), true);
        releaseCleanup();await pending;await tick();
        const newOwner = f.instance.getOwner(first.conversationId);
        assert.notEqual(newOwner.runtimeId, oldOwner.runtimeId);
        assert.equal(f.instance.inUse(f.workspace.root), true);assert.equal(f.instance.liveCount(), 1);
        assert.equal(f.events.filter(e => e.type === 'runtime_closed' && e.owner.runtimeId === oldOwner.runtimeId).length, 1);
        const before = f.events.length;f.children[0].emit({ type: 'stop_state', pending: false });assert.equal(f.events.length, before);
        await f.instance.command(newOwner, { type: 'prompt', message: 'new owner remains usable' });
      } finally { releaseCleanup();await pending?.catch(() => {});await f.instance.dispose(); }
    });
    await check('持久化恢复核对 admission 全部不可变 workspace 字段', async () => {
      let admitted = { ...workspaces.get('A') };
      let f = controlled('admission-fields', { admission: (_args, action) => action({ ...admitted }) });
      try {
        const first = await f.instance.start({ id: 'A', epoch: 'epoch-A' });await tick();await f.instance.close(f.instance.getOwner(first.conversationId));
        await f.instance.dispose();f = controlled('admission-fields', { admission: (_args, action) => action({ ...admitted }) });
        assert.equal(f.instance.snapshot().items.length, 1);assert.equal(f.children.length, 0);
        for (const key of ['projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'cwd', 'root', 'branch']) {
          admitted = { ...f.workspace, [key]: ['cwd', 'root'].includes(key) ? path.join(dir, 'different-' + key) : 'changed-' + key };
          await reject(() => f.instance.resume(first.conversationId), 'stale_workspace');
          assert.equal(f.children.length, 0, key + ' mismatch spawned a child');
          assert.equal(f.instance.liveCount(), 0);assert.equal(f.instance.inUse(f.workspace.root), false);
        }
        admitted = { ...f.workspace };await f.instance.resume(first.conversationId);await tick();assert.equal(f.children.length, 1);
      } finally { await f.instance.dispose(); }
    });
    const failedTurn = controlled('generation-failure');
    try {
      const initial = await failedTurn.instance.start({ id: 'A', epoch: 'epoch-A' });await tick();
      const expected = failedTurn.instance.getOwner(initial.conversationId), child = failedTurn.children[0];
      await failedTurn.instance.command(expected, { type: 'prompt', id: 'first-turn', message: 'fixture task' });
      child.emit({ type: 'agent_start', bridgeRun: 1 });
      child.emit({ type: 'agent_settled', bridgeRun: 1, generationResult: { requestId: 'first-turn', outcome: 'failed', hasVisibleOutput: false, failure: { class: 'server_error' } } });
      await check('生成失败保留ready与owner，空输出也记录error/attention', () => {
        const item = failedTurn.instance.snapshot().items[0];
        assert.equal(item.lifecycle, 'ready');assert.equal(item.activity, 'idle');assert.equal(item.error, 'generation_failed');assert.equal(item.attention, true);
        assert.deepEqual(item.owner, expected);assert.equal(failedTurn.instance.liveCount(), 1);
      });
      await check('failed generation摘要附失败会话owner而不变成bridge crash', () => {
        const frame = failedTurn.events.find(e => e.event?.generationResult?.outcome === 'failed');
        assert.deepEqual(frame.owner, expected);assert.equal(frame.event.generationResult.failure.class, 'server_error');
        assert.ok(!failedTurn.events.some(e => e.type === 'runtime_closed'));
      });
      await check('失败后同一owner可retry，清error且不另spawn', async () => {
        const retry = await failedTurn.instance.command(expected, { type: 'prompt', id: 'retry-turn', message: 'retry fixture task' });
        const item = failedTurn.instance.snapshot().items[0];assert.equal(retry.ok, true);
        assert.equal(item.lifecycle, 'ready');assert.equal(item.activity, 'running');assert.equal(item.error, null);
        assert.deepEqual(item.owner, expected);assert.equal(failedTurn.children.length, 1);
      });
      await check('Pi crash保留已证明native session身份并权威发布错误态', async () => {
        child.emit({type:'bridge_status',state:'exited',bridgeRun:1});
        const item=failedTurn.instance.snapshot().items[0];
        assert.equal(item.lifecycle,'error');assert.equal(item.activity,'idle');assert.equal(item.error,'runtime_unavailable');
        assert.deepEqual(item.owner,expected);
        await reject(()=>failedTurn.instance.command(expected,{type:'prompt',message:'dead child'}),'runtime_not_ready');
      });
    } finally { await failedTurn.instance.dispose(); }
  } finally { await registry.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`Runtime registry: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
