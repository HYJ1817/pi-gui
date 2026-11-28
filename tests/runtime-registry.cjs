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
  function controlled(name, { locator = () => null, cleanup = async () => {}, beforeAdapter = async () => {}, admission, adapterExtra = null } = {}) {
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
          cleanupConfirmed: () => disposed, ...(adapterExtra || {}) };
        children.push(adapter); await beforeAdapter(index); return adapter;
      } });
    return { instance, children, events: scopedEvents, workspace: w };
  }
  try {
    await check('列举不 spawn', () => { assert.equal(registry.snapshot().items.length, 0); assert.equal(spawnCount, 0); });
    const a = await start('A'); await tick(); const ao = registry.snapshot().items[0].owner;
    const b = await start('B'); await tick(); const bo = registry.snapshot().items.find(e => e.owner.workspaceId === 'B').owner;
    await check('A/B child 与 immutable cwd 独立', () => { assert.equal(spawnCount, 2); assert.notEqual(ao.runtimeId, bo.runtimeId); assert.notEqual(contexts.get(ao.conversationId).cwd, contexts.get(bo.conversationId).cwd); });
    await check('并行 writer 不共用工作区', () => reject(() => start('A'), 'workspace_in_use'));
    const c = await start('C'); await tick();
    await check('第三个 Runtime 无需额外许可且快照不声明伪上限', () => {
      const state = registry.snapshot(); assert.equal(state.liveCount, 3);
      assert.equal(Object.hasOwn(state, 'limit'), false); assert.equal(Object.hasOwn(state, 'hardLimit'), false);
    });
    await check('快照展示实际 Runtime 加 Classic 外部计数', () => {
      external = 40; assert.equal(registry.snapshot().totalCount, 43); external = 0;
    });
    await check('命令缺 owner 拒绝', () => reject(() => registry.command(null, { type: 'prompt', message: 'x' }), 'stale_runtime'));
    await check('旧 generation 拒绝', () => reject(() => registry.command({ ...ao, runtimeGeneration: 'old' }, { type: 'prompt', message: 'x' }), 'stale_runtime'));
    await registry.command(ao, { type: 'prompt', id: 'same', message: 'only A' });
    await registry.command(bo, { type: 'prompt', id: 'same', message: 'only B' });
    await check('同一 Runtime 的第二条 prompt 在确认窗口也不会重复提交', async () => {
      const before = adapters[0].commands.length;
      await reject(() => registry.command(ao, { type: 'prompt', message: 'duplicate A' }), 'runtime_busy');
      assert.equal(adapters[0].commands.length, before);
      assert.equal(registry.snapshot().items.find(item => item.conversationId === bo.conversationId).activity, 'running');
    });
    await check('同 request id 写入各自 stdin且 owner 不进 Pi wire', () => { assert.equal(adapters[0].commands[0].message, 'only A'); assert.equal(adapters[1].commands[0].message, 'only B'); assert.ok(!('owner' in adapters[0].commands[0])); });
    await check('started 应答早于 agent_start 时仍保护同会话执行线', async () => {
      adapters[0].emit({ type: 'response', command: 'prompt', id: 'same', success: true, data: { disposition: 'started' } });
      await reject(() => registry.command(ao, { type: 'prompt', message: 'not another turn' }), 'runtime_busy');
      assert.equal(adapters[0].commands.length, 1);
    });
    adapters[0].emit({ type: 'agent_start', bridgeRun: 1 }); adapters[1].emit({ type: 'agent_start', bridgeRun: 1 });
    await registry.command(ao, { type: 'abort' });
    await check('Stop A 不停止 B，agent_end不代表idle', () => { assert.equal(adapters[0].commands.at(-1).type, 'abort'); assert.equal(adapters[1].commands.length, 1); adapters[1].emit({ type: 'agent_end', bridgeRun: 1 }); assert.equal(registry.snapshot().items.find(i => i.owner.workspaceId === 'B').activity, 'running'); });
    await check('本地关闭仍拒绝缺失或过期 owner，也不越过其它会话的 busy 闸门', async () => {
      const before = adapters.map(adapter => adapter.commands.length);
      await reject(() => registry.command(null, { type: 'prompt', message: '/gui-capture disable' }), 'stale_runtime');
      await reject(() => registry.command({ ...ao, runtimeGeneration: 'old' }, { type: 'prompt', message: '/gui-capture disable' }), 'stale_runtime');
      await reject(() => registry.command(bo, { type: 'prompt', message: '/gui-capture disable' }), 'runtime_busy');
      assert.deepEqual(adapters.map(adapter => adapter.commands.length), before);
      assert.equal(registry.snapshot().items.find(i => i.owner.workspaceId === 'B').activity, 'running');
    });
    await registry.command(ao, { type: 'prompt', message: '/gui-capture disable' });
    await check('Runtime 本地关闭命令不占用待完成轮次', () => {
      assert.equal(adapters[0].commands.at(-1).message, '/gui-capture disable');
      assert.equal(registry.snapshot().items.find(i => i.owner.workspaceId === 'A').activity, 'idle');
    });
    await registry.command(ao, { type: 'prompt', message: 'after local command' });
    await check('本地关闭后下一条 prompt 不被 runtime_busy 错误拦截', () => {
      assert.equal(adapters[0].commands.at(-1).message, 'after local command');
      assert.equal(registry.snapshot().items.find(i => i.owner.workspaceId === 'A').activity, 'running');
    });
    await registry.command(ao, { type: 'abort' });
    await check('本地关闭回归清理后的 Stop 仍可确认', () => assert.equal(registry.snapshot().items.find(i => i.owner.workspaceId === 'A').activity, 'idle'));
    await check('Runtime Stop 等待确认期间不放行新任务，旧 settled 不能误改状态', async () => {
      const adapter = adapters[0], original = adapter.abortAndWait;
      let releaseAbort;
      const awaitingAbort = new Promise(resolve => { releaseAbort = resolve; });
      adapter.abortAndWait = () => awaitingAbort;
      let stopping;
      try {
        stopping = registry.command(ao, { type: 'abort' });
        await tick();
        const activity = () => registry.snapshot().items.find(i => i.owner?.workspaceId === 'A')?.activity;
        assert.equal(activity(), 'stopping');
        adapter.emit({ type: 'agent_settled', bridgeRun: 1 });
        assert.equal(activity(), 'stopping', '停止确认前，即使旧 settled 到达也不能标成 idle');
        const before = adapter.commands.length;
        await reject(() => registry.command(ao, { type: 'prompt', message: 'must remain blocked' }), 'stop_in_progress');
        await reject(() => registry.command(ao, { type: 'prompt', message: '/gui-capture disable' }), 'stop_in_progress');
        assert.equal(adapter.commands.length, before, '未确认的新任务不得进入 Pi');
        assert.equal(registry.snapshot().items.find(i => i.owner?.workspaceId === 'B')?.activity, 'running',
          'A 停止不得影响 B');
        releaseAbort({ ok: true, evidence: 'abort-response' });
        await stopping;
        assert.equal(activity(), 'idle');
      } finally {
        releaseAbort({ ok: true, evidence: 'abort-response' });
        await stopping?.catch(() => {});
        adapter.abortAndWait = original;
      }
    });
    await check('工作区验证等待跨过完整 Stop 后旧 Runtime 输入不能复活', async () => {
      const adapter = adapters[0], originalAbort = adapter.abortAndWait; let stopped = 0, release;
      adapter.captureCommandGuard = cmd => {
        if (!['prompt', 'steer', 'follow_up'].includes(cmd.type)) return null;
        const expected = stopped; return () => { if (expected !== stopped) throw Object.assign(Error('stale_runtime'), { code: 'stale_runtime' }); };
      };
      adapter.abortAndWait = async cmd => { stopped++; return originalAbort(cmd); };
      hold = new Promise(resolve => { release = resolve; });
      const input = { type: 'prompt', message: 'KEEP_REGISTRY_DRAFT' }, copy = JSON.stringify(input);
      const waiting = registry.command(ao, input);
      try {
        await tick(); await registry.command(ao, { type: 'abort' }); hold = null; release();
        await reject(() => waiting, 'stale_runtime'); assert.equal(JSON.stringify(input), copy);
        assert.equal(adapter.commands.filter(cmd => cmd.message === input.message).length, 0);
        await registry.command(ao, input); assert.equal(adapter.commands.filter(cmd => cmd.message === input.message).length, 1);
        await registry.command(ao, { type: 'abort' });
      } finally { hold = null; release(); adapter.abortAndWait = originalAbort; delete adapter.captureCommandGuard; }
    });
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
    const restarted = await registry.resume(a.conversationId); await tick();
    await check('恢复 conversation 生新 generation，旧 scope拒绝', async () => { assert.notEqual(restarted.owner.runtimeGeneration, ao.runtimeGeneration); await reject(() => registry.command(ao, { type: 'abort' }), 'stale_runtime'); });

    /* ---------- 编辑事务互斥：只锁目标 Runtime ---------- */
    {
      const editAdapter = adapters.at(-1);
      const editOwner = registry.getOwner(restarted.conversationId);
      const otherOwner = registry.getOwner(b.conversationId);
      let releaseEdit = null;
      let statusResult = { ok: true, state: 'pending' };
      editAdapter.messageEditCommand = () => 'pi-gui-edit-fixture';
      editAdapter.messageEditToken = () => 'edit-token-fixture';
      editAdapter.messageEdit = {
        preflight: async () => ({ ok: true, canEdit: true }),
        resend: async () => editGate,
        status: async () => statusResult,
        recover: async () => statusResult,
      };
      editAdapter.messageEditRequest = async cmd => cmd?.type === 'get_state'
        ? { sessionId: 'native-A', isStreaming: false, model: {} }
        : { entries: [], leafId: null };
      let editGate;
      const gate = new Promise(resolve => { releaseEdit = resolve; });
      editGate = gate;
      const pending = registry.editResend(editOwner, {
        userIndex: 0, kind: 'edit', text: 'edited fixture',
        expectedEntryId: 'entry-1', expectedParentId: null, expectedLeafId: 'leaf-1',
        expectedSessionId: 'native-A', requestId: 'runtime-edit-lock-1',
      });
      await tick();
      await check('导航事务在飞时：改变历史/owner/代次的命令与关闭/重启目标 Runtime 一律 edit_in_progress', async () => {
        for (const type of ['compact', 'set_session_name', 'prompt', 'steer', 'follow_up', 'set_model', 'cycle_model']) {
          await reject(() => registry.command(editOwner, { type, message: 'x', id: 'blocked-' + type }), 'edit_in_progress');
        }
        await reject(() => registry.command(editOwner, { type: 'prompt', message: '/gui-capture disable' }), 'edit_in_progress');
        /* new_session / fork / switch_session 在 Runtime 通道本来就被白名单拒绝。 */
        for (const type of ['new_session', 'fork', 'switch_session']) {
          await reject(() => registry.command(editOwner, { type, sessionPath: '/tmp/other', id: 'blocked-' + type }), 'invalid_command');
        }
        assert.throws(() => registry.close(editOwner), e => e.code === 'edit_in_progress');
        await reject(() => registry.restart(editOwner), 'edit_in_progress');
        await reject(() => registry.invalidateWorkspace('A'), 'edit_in_progress');
        assert.equal(editAdapter.commands.some(cmd => cmd.type === 'prompt'), false, 'no user prompt entered Pi');
      });
      await check('导航事务在飞时：读取、Stop 与其它独立 Runtime 不受影响', async () => {
        for (const type of ['get_state', 'get_messages', 'get_entries', 'get_session_stats', 'get_available_models', 'get_available_thinking_levels', 'get_commands']) {
          await registry.read(editOwner, { type });
        }
        await registry.command(editOwner, { type: 'get_tree' });
        await registry.command(editOwner, { type: 'get_entries' });
        await registry.command(editOwner, { type: 'abort' });
        assert.equal(editAdapter.commands.at(-1).type, 'abort');
        await registry.command(otherOwner, { type: 'set_session_name', name: 'B stays usable' });
        await registry.read(otherOwner, { type: 'get_state' });
        await registry.close(otherOwner);
        assert.equal(registry.getOwner(b.conversationId), null);
      });
      releaseEdit({ ok: false, unresolved: true, state: 'acceptance_unknown' });
      const unresolvedResult = await pending;
      await check('结果未知保留锁：未解决事务期间仍禁止 prompt / close，也不永久忙', async () => {
        assert.equal(unresolvedResult.unresolved, true);
        await reject(() => registry.command(editOwner, { type: 'prompt', message: 'must stay blocked' }), 'edit_in_progress');
        assert.throws(() => registry.close(editOwner), e => e.code === 'edit_in_progress');
        statusResult = { ok: true, state: 'acceptance_unknown', result: { ok: false, unresolved: true } };
        const recovered = await registry.editRecover(editOwner, 'runtime-edit-lock-1');
        assert.equal(recovered.state, 'acceptance_unknown');
        await reject(() => registry.command(editOwner, { type: 'prompt', message: 'still blocked' }), 'edit_in_progress');
        statusResult = { ok: true, state: 'accepted', result: { ok: true, accepted: true, newEntryId: 'entry-2' } };
        const status = await registry.editStatus(editOwner, 'runtime-edit-lock-1');
        assert.equal(status.state, 'accepted');
        /* 旧 requestId 的失败状态不能清掉当前事务的 editTurn。 */
        statusResult = { ok: true, state: 'failed', result: { ok: false, code: 'prompt_rejected' } };
        assert.equal((await registry.editStatus(editOwner, 'old-request-9')).state, 'failed');
        statusResult = { ok: true, state: 'accepted', result: { ok: true, accepted: true, newEntryId: 'entry-2' } };
        /* bridge 换代后，旧 owner 仍能用原 requestId 查询：runtimeId /
         * runtimeGeneration 是瞬时字段，稳定归属没有变。 */
        editAdapter.emit({ type: 'bridge_status', state: 'ready', bridgeRun: 2 });
        await tick();
        const statusAfterRestart = await registry.editStatus(editOwner, 'runtime-edit-lock-1');
        assert.equal(statusAfterRestart.state, 'accepted');
        const afterRestartOwner = registry.getOwner(restarted.conversationId);
        /* accepted 后 editTurn 仍保留到 agent_start/settled，堵住应答与开跑之间的窗口。 */
        await reject(() => registry.command(afterRestartOwner, { type: 'prompt', message: 'not yet' }), 'edit_in_progress');
        editAdapter.emit({ type: 'agent_start', bridgeRun: 2 });
        editAdapter.emit({ type: 'agent_settled', bridgeRun: 2 });
        await registry.command(afterRestartOwner, { type: 'get_tree' });
        /* bridge 掉线后仍能用原 requestId 查询已提交事务。 */
        editAdapter.emit({ type: 'bridge_status', state: 'exited', bridgeRun: 2 });
        const afterExit = await registry.editStatus(editOwner, 'runtime-edit-lock-1');
        assert.equal(afterExit.state, 'accepted');
        await registry.close(afterRestartOwner);
        assert.equal(registry.getOwner(restarted.conversationId), null);
      });
    }

    /* 网络重试会带同一个 requestId 再次提交。后端返回缓存的成功结果
     * （duplicate:true），不会启动新 Agent；Registry 不能重新占用 editTurn，
     * 否则没有 agent_start / settled 来释放，Runtime 永久 runtime_busy。 */
    await check('重复提交已完成事务：缓存结果不重新占用执行锁', async () => {
      const accepted = { ok: true, accepted: true, newEntryId: 'entry-2', newLeafId: 'leaf-2', acceptance: 'started' };
      const f = controlled('edit-duplicate-replay', {
        adapterExtra: {
          messageEditCommand: () => 'pi-gui-edit-fixture',
          messageEditToken: () => 'edit-token-fixture',
          messageEdit: {
            preflight: async () => ({ ok: true, canEdit: true }),
            resend: async () => ({ ...accepted, duplicate: true }),
            status: async () => ({ ok: true, state: 'accepted', result: accepted }),
            recover: async () => ({ ok: true, state: 'accepted', result: accepted }),
          },
          messageEditRequest: async cmd => cmd?.type === 'get_state'
            ? { sessionId: 'native-controlled-A', isStreaming: false, model: {} }
            : { entries: [], leafId: null },
        },
      });
      try {
        const started = await f.instance.start({ id: 'A', epoch: 'epoch-A' });
        await tick();
        const owner = f.instance.getOwner(started.conversationId);
        const input = {
          userIndex: 0, kind: 'edit', text: 'edited fixture',
          expectedEntryId: 'entry-1', expectedParentId: null, expectedLeafId: 'leaf-1',
          expectedSessionId: 'native-controlled-A', requestId: 'runtime-edit-replay-1',
        };
        const replay = await f.instance.editResend(owner, input);
        assert.equal(replay.ok, true);
        assert.equal(replay.duplicate, true);
        /* 没有新 run 就没有 agent 事件：同一个 requestId 还能再重试一次。 */
        const replayAgain = await f.instance.editResend(owner, input);
        assert.equal(replayAgain.duplicate, true);
        /* prompt / close 都被 editTurn 拦截；能通过就证明锁已经释放。 */
        await f.instance.command(owner, { type: 'prompt', message: 'usable after replay', id: 'after-replay' });
        await f.instance.close(owner);
        assert.equal(f.instance.getOwner(started.conversationId), null);
      } finally { await f.instance.dispose(); }
    });

    /* 结果未知且生命周期已不可用：显式关闭/重启必须是唯一逃生口。
     * 工作正常的 Runtime 仍不能靠关闭“释放”事务锁；一旦 bridge 身份无法
     * 确认（refreshSession 失败进入 error），通道已不可核对，允许用户关闭。 */
    await check('结果未知且身份不可确认时，显式关闭是唯一逃生口', async () => {
      let failRefresh = false;
      const f = controlled('edit-unconfirmed-lifecycle', {
        adapterExtra: {
          messageEditCommand: () => 'pi-gui-edit-fixture',
          messageEditToken: () => 'edit-token-fixture',
          messageEdit: {
            preflight: async () => ({ ok: true, canEdit: true }),
            resend: async () => ({ ok: false, unresolved: true, state: 'acceptance_unknown' }),
            status: async () => ({ ok: true, state: 'acceptance_unknown', result: { ok: false, unresolved: true } }),
            recover: async () => ({ ok: true, state: 'acceptance_unknown', result: { ok: false, unresolved: true } }),
          },
          messageEditRequest: async () => null,
          request: async cmd => {
            if (failRefresh && cmd?.type === 'get_state') throw Object.assign(Error('fixture read failure'), { code: 'fixture' });
            return cmd?.type === 'get_state' ? { sessionId: 'native-controlled-A' } : { messages: [] };
          },
        },
      });
      try {
        const started = await f.instance.start({ id: 'A', epoch: 'epoch-A' });
        await tick();
        const owner = f.instance.getOwner(started.conversationId);
        const result = await f.instance.editResend(owner, {
          userIndex: 0, kind: 'edit', text: 'edited fixture',
          expectedEntryId: 'entry-1', expectedParentId: null, expectedLeafId: 'leaf-1',
          expectedSessionId: 'native-controlled-A', requestId: 'runtime-edit-dead-1',
        });
        assert.equal(result.unresolved, true);
        assert.throws(() => f.instance.close(owner), e => e.code === 'edit_in_progress',
          'a working Runtime must not be closed to shed the transaction lock');
        failRefresh = true;
        f.children[0].emit({ type: 'bridge_status', state: 'ready', bridgeRun: 2 });
        await tick();
        assert.equal(f.instance.snapshot().items[0].lifecycle, 'error');
        const current = f.instance.getOwner(started.conversationId);
        await f.instance.close(current);
        assert.equal(f.instance.getOwner(started.conversationId), null);
      } finally { await f.instance.dispose(); }
    });

    await registry.dispose(); registry = createRuntimeRegistry(options);
    await check('应用重启只重发现记录，不 spawn、不认旧child', () => { assert.equal(registry.snapshot().liveCount, 0); assert.equal(registry.snapshot().items.length, 3); assert.equal(spawnCount, 4); });
    blocked = true;
    await check('维护禁止新 child', () => reject(() => registry.resume(b.conversationId), 'maintenance'));
    blocked = false; external = 3;
    await check('外部主 child/CLI 数量不阻止恢复', async () => {
      await registry.resume(b.conversationId); await tick();
      assert.equal(registry.snapshot().liveCount, 1); assert.equal(registry.snapshot().totalCount, 4);
      await registry.close(registry.getOwner(b.conversationId));
    });
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
    await check('工作区失效等待迟到的 factory 并释放未启动的 adapter', async () => {
      const entered = Promise.withResolvers(), release = Promise.withResolvers();
      const f = controlled('launch-invalidate-race', { beforeAdapter: () => { entered.resolve(); return release.promise; } });
      const started = reject(() => f.instance.start({ id: 'A', epoch: 'epoch-A' }), 'stale_runtime');
      let invalidated;
      try {
        await entered.promise;
        invalidated = f.instance.invalidateWorkspace('A');
        await tick();
        assert.equal(f.instance.inUse(f.workspace.root), true);
        release.resolve();
        await Promise.all([started, invalidated]);
        assert.equal(f.children[0].disposeCalls, 1);
        assert.equal(f.events.some(event => event.type === 'runtime_event' && event.event.state === 'ready'), false);
        assert.equal(f.instance.inUse(f.workspace.root), false);
      } finally { release.resolve(); await Promise.allSettled([started, invalidated]); await f.instance.dispose(); }
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
    /* Many dormant records must not become an admission or aggregate-byte cap.
     * These adapters are native-shaped mocks; no per-record process is spawned. */
    {
      const capacityDir = path.join(dir, 'unbounded-records'), children = [];
      const w = { ...workspaces.get('A'), branch: Array(24).fill('mock-topic-'.repeat(16)).join('/') };
      let failFactory = false, failStart = false, sendGate = null;
      const capacityOptions = { dataDir: capacityDir, externalCount: () => 20,
        resolveWorkspace: async () => ({ ...w }), validateWorkspace: async () => {}, sharedAdmission: async () => () => true,
        factory: async (context, emit) => {
          if (failFactory) throw Object.assign(Error('fixture'), { code: 'fixture_factory_failure' });
          let disposed = false;
          const rejectStart = failStart, child = { context, emit, commands: [], disposeCalls: 0,
            async start() {
              if (rejectStart) throw Object.assign(Error('fixture'), { code: 'fixture_start_failure' });
              emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 });
            },
            request: async () => ({ sessionId: context.sessionId || 'native-' + context.owner.conversationId }),
            getState: () => ({ state: 'ready', stop: null }),
            async send(command) { child.commands.push(command); if (sendGate) await sendGate; },
            abortAndWait: async () => ({ ok: true }),
            async dispose() { child.disposeCalls++; disposed = true; }, cleanupConfirmed: () => disposed };
          children.push(child); return child;
        } };
      let many = createRuntimeRegistry(capacityOptions);
      const ids = [];
      try {
        await check('创建超过 256 条普通与 worktree 会话记录且不逐条起子进程', async () => {
          for (let i = 0; i < 270; i++) {
            w.cwd = w.root = path.join(capacityDir, 'workspace-' + i); fs.mkdirSync(w.root);
            const result = i % 2 === 0 ? await many.start({ id: 'A', epoch: 'epoch-A' })
              : await many.openProjectSession({ workspace: { ...w, workspaceId: 'project-mock' }, requestId: require('node:crypto').randomUUID() });
            await tick(); ids.push(result.conversationId); await many.close(many.getOwner(result.conversationId));
          }
          assert.equal(many.snapshot().items.length, 270); assert.equal(many.liveCount(), 0);
          const saved = fs.readFileSync(path.join(capacityDir, 'conversations.json'));
          assert.ok(saved.length > 1024 * 1024); assert.equal(JSON.parse(saved).items.length, 270);
          console.log('    capacity manifest bytes=' + saved.length + ', records=270, real children=0');
        });
        await check('大 manifest 完整读回为 dormant，不自动启动也不丢记录', async () => {
          const previous = many.snapshot().backendInstance; await many.dispose(); many = createRuntimeRegistry(capacityOptions);
          assert.equal(many.snapshot().ok, true); assert.equal(many.liveCount(), 0);
          assert.deepEqual(many.snapshot().items.map(item => item.conversationId), ids);
          assert.notEqual(many.snapshot().backendInstance, previous); assert.equal(children.length, 270);
          for (const id of ids) assert.ok(many.historyTarget(id));
        });
        await check('五个 Runtime 在多个既有会话及 Classic 计数下同时恢复', async () => {
          for (const id of ids.slice(0, 5)) await many.resume(id);
          await tick(); assert.equal(many.liveCount(), 5); assert.equal(many.snapshot().totalCount, 25);
          assert.equal(new Set(ids.slice(0, 5).map(id => many.getOwner(id).runtimeId)).size, 5);
        });
        await check('五个模型命令都先进入各自 adapter，不经全局执行 FIFO', async () => {
          const release = Promise.withResolvers(); sendGate = release.promise;
          const sends = ids.slice(0, 5).map(id => many.command(many.getOwner(id), { type: 'prompt', id: 'same', message: 'overlap' }));
          try {
            await tick(); assert.equal(children.slice(-5).filter(child => child.commands.length === 1).length, 5);
            assert.equal(many.runningCount(), 5);
          } finally { sendGate = null; release.resolve(); await Promise.all(sends); }
        });
        await check('已有多个执行线时重启只换目标 owner，其他回合保持运行', async () => {
          const peers = ids.slice(1, 5).map(id => many.getOwner(id)), old = many.getOwner(ids[0]);
          await many.restart(old); await tick(); const current = many.getOwner(ids[0]);
          assert.notEqual(current.runtimeId, old.runtimeId); assert.equal(current.sessionId, old.sessionId);
          assert.equal(many.liveCount(), 5); assert.equal(many.runningCount(), 4);
          assert.deepEqual(ids.slice(1, 5).map(id => many.getOwner(id)), peers);
          await reject(() => many.command(old, { type: 'abort' }), 'stale_runtime');
        });
        await check('单个 factory 或异步 start 失败只清理本次资源，不影响五个已有会话', async () => {
          const peers = ids.slice(0, 5).map(id => many.getOwner(id)), before = many.snapshot().items.length;
          failFactory = true;
          await reject(() => many.start({ id: 'A', epoch: 'epoch-A' }), 'fixture_factory_failure'); failFactory = false;
          assert.equal(many.liveCount(), 5); assert.equal(many.snapshot().items.length, before);
          // Use another worktree root to exercise startup, not its exclusive lease.
          const otherRoot = path.join(dir, 'start-failure-root'); fs.mkdirSync(otherRoot); const originalRoot = w.root; w.root = otherRoot;
          failStart = true;
          try { await reject(() => many.start({ id: 'A', epoch: 'epoch-A' }), 'fixture_start_failure'); }
          finally { failStart = false; w.root = originalRoot; }
          assert.equal(children.at(-1).disposeCalls, 1); assert.equal(many.inUse(otherRoot), false);
          assert.equal(many.liveCount(), 5); assert.equal(many.snapshot().items.length, before);
          assert.deepEqual(ids.slice(0, 5).map(id => many.getOwner(id)), peers);
          await many.read(peers[1], { type: 'get_state' }); await many.command(peers[1], { type: 'abort' });
        });
      } finally { failFactory = false; failStart = false; await many.dispose(); }
      await check('大记录集仍拒绝坏 schema、重复身份与 manifest 链接，保留原文件', async () => {
        const file = path.join(capacityDir, 'conversations.json'), original = fs.readFileSync(file);
        const saved = JSON.parse(original);
        for (const mutate of [value => { value.items[269].unexpected = true; }, value => { value.items[269].conversationId = value.items[0].conversationId; }]) {
          const value = structuredClone(saved); mutate(value); const raw = JSON.stringify(value); fs.writeFileSync(file, raw);
          const invalid = createRuntimeRegistry(capacityOptions);
          try {
            assert.equal(invalid.snapshot().ok, false);
            await reject(() => invalid.start({ id: 'A', epoch: 'epoch-A' }), 'registry_unavailable');
            assert.equal(fs.readFileSync(file, 'utf8'), raw);
          } finally { await invalid.dispose(); }
        }
        fs.writeFileSync(file, original);
        const linkedDir = path.join(dir, 'linked-manifest'); fs.mkdirSync(linkedDir);
        fs.symlinkSync(capacityDir, path.join(linkedDir, 'conversations.json'), process.platform === 'win32' ? 'junction' : 'dir');
        const linked = createRuntimeRegistry({ ...capacityOptions, dataDir: linkedDir });
        try { assert.equal(linked.snapshot().ok, false); assert.deepEqual(fs.readFileSync(file), original); }
        finally { await linked.dispose(); }
      });
    }
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
    /* 回归：settled 后的 refreshSession 失败时，副作用的 .then 必须消费
     * rejection，且不能拿未确认的 locator 触发标题。 */
    {
      const unhandled = [];
      const onUnhandled = reason => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      let f = null;
      try {
        const observed = [];
        let child = null, getStateCalls = 0;
        const w = { ...workspaces.get('A') };
        f = createRuntimeRegistry({
          dataDir: path.join(dir, 'title-settled-reject'),
          resolveWorkspace: async () => ({ ...w }),
          validateWorkspace: async () => {},
          publish: () => {},
          sessionTitle: { resolve: () => null, observe: payload => observed.push(payload) },
          factory: async (context, emit) => {
            child = { emit, context,
              start: () => emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }),
              request: async cmd => {
                if (cmd.type !== 'get_state') return {};
                getStateCalls++;
                if (getStateCalls >= 2) throw Object.assign(Error('unconfirmed'), { code: 'pi_request_unconfirmed' });
                return { sessionId: 'native-title-A' };
              },
              getState: () => ({ state: 'ready', stop: null }), send() {},
              sessionLocator: async () => null,
              async dispose() {}, cleanupConfirmed: () => true };
            return child;
          }
        });
        await f.start({ id: 'A', epoch: 'epoch-A' });
        await tick(); await tick();
        assert.ok(child, 'child spawned');
        child.emit({ type: 'agent_start', bridgeRun: 1 });
        child.emit({ type: 'agent_settled', bridgeRun: 1, generationResult: { requestId: 'settle-1', outcome: 'success', hasVisibleOutput: true } });
        await tick();
        await new Promise(resolve => setTimeout(resolve, 30));
        await check('settled 刷新失败不产生 unhandledRejection 也不触发标题', () => {
          assert.deepEqual(unhandled, []);
          assert.equal(observed.length, 0);
        });
      } finally {
        process.off('unhandledRejection', onUnhandled);
        await f?.dispose();
      }
    }
    /* 回归：HTTP start 等待自己的 adapter.start()，但不能占住全局生命周期队列；
     * 无关工作区的启动不得排在慢启动后面。 */
    {
      const gates = new Map(), slowDir = path.join(dir, 'slow-start'); fs.mkdirSync(slowDir);
      const slow = createRuntimeRegistry({ dataDir: slowDir, publish: () => {},
        resolveWorkspace: async args => { const cwd = path.join(dir, args.id); fs.mkdirSync(cwd, { recursive: true });
          return { projectId: 'p', repoId: 'r', workspaceId: args.id, workspaceEpoch: 'epoch-' + args.id, cwd, root: cwd, branch: args.id }; },
        validateWorkspace: async () => {},
        factory: async (context, emit) => ({ start: async () => { const gate = gates.get(context.workspace.workspaceId); if (gate) await gate;
            emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }); },
          request: async () => ({ sessionId: 'native-' + context.workspace.workspaceId }), getState: () => ({ state: 'ready', stop: null }), send() {},
          dispose: async () => {}, cleanupConfirmed: () => true }) });
      const gate = Promise.withResolvers(); gates.set('slow-A', gate.promise);
      try {
        const pending = slow.start({ id: 'slow-A', epoch: 'epoch-slow-A' }); await tick();
        const fast = await Promise.race([slow.start({ id: 'fast-B', epoch: 'epoch-fast-B' }),
          new Promise((_, rejectSlow) => setTimeout(() => rejectSlow(Error('start_blocked_by_unrelated_slow_start')), 5000))]);
        await check('慢启动只占自己的 HTTP 等待，无关 Runtime 仍可完成登记并启动', () => {
          assert.equal(slow.liveCount(), 2); assert.ok(slow.getOwner(fast.conversationId));
        });
        gate.resolve(); await pending;
      } finally { gate.resolve(); await slow.dispose(); }
    }
  } finally { await registry.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`Runtime registry: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
