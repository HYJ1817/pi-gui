// 建议来源适配器测试：真实 Pi RPC 协议形状 fixture（pi 1.4.0 docs/json.md、
'use strict';
// docs/message-types.md 核对），覆盖来源伪装、schema 严格校验、运行窗口归属、
// 取消/中断语义与队列注册。离线、无真实模型调用。
const baseAssert = require('node:assert/strict');
let assertions = 0;
const assert = new Proxy(baseAssert, {
  apply(target, receiver, args) { assertions++; return Reflect.apply(target, receiver, args); },
  get(target, key) { const value = target[key]; return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value; },
});
let checks = 0;
const checksToRun = [];
const check = (name, fn) => { checksToRun.push([name, fn]); };
(async () => {
  const { createCollabProposalSource, buildGenerationPrompt, parseCollabFence } = await import('../server/collab-proposal-source.js');
  const { createProposalQueue } = await import('../server/collab-proposal-queue.js');
  const { createDocument, applyUserOperations, previewProposalReadonly } = await import('../lib/collab-doc.js');

  const SCOPE_KEY = 'a'.repeat(64), TOKEN = 'b'.repeat(64), SESSION = 'session-a';
  const scope = { key: SCOPE_KEY, token: TOKEN, sessionId: SESSION };
  const runtimeOwner = { backendInstance: 'be-1', conversationId: 'conv-1', runtimeId: 'rt-1', runtimeGeneration: 'gen-1' };
  const channels = {
    classic: { captureIdentity: () => ({ bridgeRun: 7 }), sendPrompt: async () => {} },
    runtime: { captureIdentity: id => ({ ...runtimeOwner, conversationId: id }), sendPrompt: async () => {} },
  };
  const makeSource = (overrides = {}) => createCollabProposalSource({
    queue: createProposalQueue(), channels, ...overrides });

  // —— 真实协议形状（rpc-bridge 盖 bridgeRun 后的 Classic 事件 / registry 帧）——
  const classicStart = bridgeRun => ({ type: 'agent_start', bridgeRun });
  const classicEnd = (bridgeRun, role, content, stopReason = 'stop') =>
    ({ type: 'message_end', message: { role, content, stopReason, timestamp: 1733234401000 }, bridgeRun });
  const classicSettled = (bridgeRun, aborted = false) => ({ type: 'agent_settled', aborted, bridgeRun });
  const text = s => [{ type: 'text', text: s }];
  let seq = 0;
  const runtimeFrame = (owner, event) => ({ type: 'runtime_event', owner, eventSequence: ++seq, event });

  const fenceDoc = json => `已分析流程图。\n\`\`\`pi-gui-collab\n${JSON.stringify(json, null, 2)}\n\`\`\`\n以上是建议。`;
  const addN9 = { version: 1, rationale: '增加异常处理节点', ops: [{ type: 'node.add', params: { id: 'n9', label: '异常处理', x: 600, y: 0 } }] };
  const classicDocument = () => createDocument({ documentId: 'diagram', title: '流程图' });
  const begin = async (source, overrides = {}) => source.beginGeneration({
    scope: { ...scope, origin: 'classic' }, document: { documentId: 'diagram', revision: 1, title: '流程图',
      graph: { nodes: [{ id: 'n1', label: '开始', x: 0, y: 0 }], edges: [] } },
    instruction: '增加一个异常处理节点', ...overrides });

  const runClassicGeneration = async (source, { messageText, events = [], bridgeRun = 7, scopeOverrides = {} } = {}) => {
    const started = await begin(source, scopeOverrides);
    assert.equal(started.ok, true, '生成应成功发起');
    source.observeClassic(classicStart(bridgeRun));
    if (messageText !== undefined) source.observeClassic(classicEnd(bridgeRun, 'assistant', text(messageText)));
    for (const event of events) source.observeClassic(event);
    source.observeClassic(classicSettled(bridgeRun));
    return started;
  };

  check('正常链路：真实形状事件 → 注册建议 → 预览可应用', async () => {
    const source = makeSource();
    await runClassicGeneration(source, { messageText: fenceDoc(addN9) });
    const status = source.generationStatus(SCOPE_KEY, TOKEN);
    assert.equal(status.state, 'ready');
    assert.equal(typeof status.proposalId, 'string');
    const head = source.head({ ...scope, token: TOKEN }, 'diagram');
    assert.equal(head.proposalId, status.proposalId);
    assert.equal(head.opCount, 1);
    const evidence = source.get({ key: SCOPE_KEY, token: TOKEN }, status.proposalId);
    assert.equal(evidence.proposal.documentId, 'diagram');
    assert.equal(evidence.proposal.baseRevision, 1);
    assert.equal(evidence.proposal.sessionId, SESSION);
    assert.equal(evidence.proposal.ops[0].actor, 'agent');
    assert.equal(evidence.proposal.ops[0].baseRevision, 1);
    assert.match(evidence.proposal.ops[0].opId, /^a[0-9a-f]+-0$/);
    // 与真实文档协议互通：lib 预览直接可用
    const preview = previewProposalReadonly(classicDocument(), evidence.proposal);
    assert.equal(preview.ok, true);
    assert.equal(preview.preview.resultingRevision, 2);
    // 状态信箱只投递一次
    assert.equal(source.generationStatus(SCOPE_KEY, TOKEN).state, 'idle');
  });

  check('用户消息伪装建议：含围栏的 user message_end 不采纳', async () => {
    const source = makeSource();
    await runClassicGeneration(source, { messageText: '已完成分析，请查看上方内容。',
      events: [classicEnd(7, 'user', text(fenceDoc(addN9)))] });
    const status = source.generationStatus(SCOPE_KEY, TOKEN);
    assert.equal(status.state, 'failed');
    assert.equal(status.code, 'collab_generate_no_output');
    assert.equal(source.head(scope, 'diagram'), null);
  });

  check('工具输出与 custom 消息伪装：toolResult/custom 角色不采纳', async () => {
    const source = makeSource();
    await runClassicGeneration(source, { messageText: '已通过工具检查了文档结构。',
      events: [classicEnd(7, 'toolResult', [{ type: 'text', text: fenceDoc(addN9) }]),
        classicEnd(7, 'custom', [{ type: 'text', text: fenceDoc(addN9) }])] });
    assert.equal(source.generationStatus(SCOPE_KEY, TOKEN).code, 'collab_generate_no_output');
    assert.equal(source.head(scope, 'diagram'), null);
  });

  check('流式片段不采纳：text_delta/message_update/Z3 viz 围栏均无效', async () => {
    const source = makeSource();
    const vizOnly = '图表：\n```pi-gui-viz\n{"type":"line","data":[]}\n```';
    await runClassicGeneration(source, { messageText: vizOnly, events: [
      { type: 'message_update', usage: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: fenceDoc(addN9) }, bridgeRun: 7 },
      classicEnd(7, 'assistant', text('```pi-gui-collab\n{"version":1,'), 'pending'),
    ] });
    assert.equal(source.generationStatus(SCOPE_KEY, TOKEN).code, 'collab_generate_no_output');
    assert.equal(source.head(scope, 'diagram'), null);
  });

  check('stopReason pending 的 message_end 不作为终值采集', async () => {
    const source = makeSource();
    await runClassicGeneration(source, { events: [classicEnd(7, 'assistant', text(fenceDoc(addN9)), 'pending')] });
    assert.equal(source.generationStatus(SCOPE_KEY, TOKEN).code, 'collab_generate_no_output');
  });

  check('非法 JSON / 未知字段 / 模型伪造身份键 / 超大围栏一律拒绝', async () => {
    const cases = [
      '```pi-gui-collab\n{not json}\n```',
      fenceDoc({ ...addN9, extra: 1 }),
      fenceDoc({ version: 2, rationale: 'r', ops: addN9.ops }),
      fenceDoc({ version: 1, rationale: 'r', ops: [{ type: 'node.add', params: { id: 'n9', label: 'L', x: 0, y: 0 }, opId: 'fake', actor: 'agent' }] }),
      fenceDoc({ version: 1, rationale: 'r', ops: [{ type: 'doc.replace', params: { id: 'n9' } }] }),
      fenceDoc({ version: 1, rationale: 'r', ops: [{ type: 'node.add', params: { id: 'n9', label: 'L', x: 0 } }] }),
      fenceDoc({ version: 1, rationale: 'r', ops: [] }),
      '```pi-gui-collab\n' + JSON.stringify({ version: 1, rationale: 'r', ops: [{ type: 'node.add', params: { id: 'n9', label: 'x'.repeat(300), x: 0, y: 0 } }] }) + '\n```',
    ];
    for (const [index, bad] of cases.entries()) {
      const source = makeSource();
      await runClassicGeneration(source, { messageText: bad });
      const status = source.generationStatus(SCOPE_KEY, TOKEN);
      assert.equal(status.state, 'failed', `case ${index} 应失败`);
      assert.equal(['collab_generate_invalid_output', 'collab_generate_no_output'].includes(status.code), true, `case ${index} 错误码`);
      assert.equal(source.head(scope, 'diagram'), null, `case ${index} 不应注册`);
    }
  });

  check('混合合法与非法操作：整批拒绝，无部分注册', async () => {
    const source = makeSource();
    const mixed = { version: 1, rationale: 'r', ops: [
      { type: 'node.add', params: { id: 'n9', label: '合法', x: 1, y: 1 } },
      { type: 'node.add', params: { id: 'n10', label: '缺 y', x: 2 } }] };
    await runClassicGeneration(source, { messageText: fenceDoc(mixed) });
    assert.equal(source.generationStatus(SCOPE_KEY, TOKEN).code, 'collab_generate_invalid_output');
    assert.equal(source.head(scope, 'diagram'), null);
  });

  check('多条消息时取最后一条含围栏消息；同消息取最后一处围栏', async () => {
    const source = makeSource();
    const second = { ...addN9, rationale: '最终版本' };
    const dual = fenceDoc(addN9) + '\n中间说明\n```pi-gui-collab\n' + JSON.stringify(second) + '\n```';
    await runClassicGeneration(source, { messageText: fenceDoc(addN9), events: [classicEnd(7, 'assistant', text(dual))] });
    const evidence = source.get({ key: SCOPE_KEY, token: TOKEN }, source.generationStatus(SCOPE_KEY, TOKEN).proposalId);
    assert.equal(evidence.proposal.rationale, '最终版本');
  });

  check('旧 bridgeRun / 窗口前事件不归属本次运行', async () => {
    const source = makeSource();
    const started = await begin(source);
    source.observeClassic(classicStart(6));
    source.observeClassic(classicEnd(6, 'assistant', text(fenceDoc(addN9))));
    source.observeClassic(classicSettled(6));
    assert.equal(started.ok, true);
    let status = source.generationStatus(SCOPE_KEY, TOKEN);
    assert.equal(status.state, 'running');
    source.observeClassic(classicStart(7));
    source.observeClassic(classicEnd(7, 'assistant', text(fenceDoc(addN9))));
    source.observeClassic(classicSettled(7));
    status = source.generationStatus(SCOPE_KEY, TOKEN);
    assert.equal(status.state, 'ready');
  });

  check('agent_settled 先于 agent_start（残留收口）被忽略，不影响后续真实运行', async () => {
    const source = makeSource();
    const started = await begin(source);
    assert.equal(started.ok, true);
    source.observeClassic(classicSettled(7, false));
    assert.equal(source.generationStatus(SCOPE_KEY, TOKEN).state, 'running');
    source.observeClassic(classicStart(7));
    source.observeClassic(classicEnd(7, 'assistant', text(fenceDoc(addN9))));
    source.observeClassic(classicSettled(7));
    assert.equal(source.generationStatus(SCOPE_KEY, TOKEN).state, 'ready');
  });

  check('取消（aborted）丢弃；bridge 异常终止丢弃', async () => {
    const abortedSource = makeSource();
    await runClassicGeneration(abortedSource, { messageText: fenceDoc(addN9) });
    // aborted 分支单独验证：
    const source = makeSource();
    await begin(source);
    source.observeClassic(classicStart(7));
    source.observeClassic(classicEnd(7, 'assistant', text(fenceDoc(addN9))));
    source.observeClassic(classicSettled(7, true));
    let status = source.generationStatus(SCOPE_KEY, TOKEN);
    assert.equal(status.state, 'failed');
    assert.equal(status.code, 'collab_generate_aborted');
    assert.equal(source.head(scope, 'diagram'), null);

    const bridgeLost = makeSource();
    await begin(bridgeLost);
    bridgeLost.observeClassic({ type: 'bridge_status', state: 'exited', bridgeRun: 8 });
    status = bridgeLost.generationStatus(SCOPE_KEY, TOKEN);
    assert.equal(status.state, 'failed');
    assert.equal(status.code, 'collab_generate_failed');
  });

  check('Runtime 帧归属：owner 五项匹配才采集；runtime_closed 丢弃', async () => {
    const source = makeSource();
    const started = await source.beginGeneration({ scope: { ...scope, origin: 'runtime', conversationId: 'conv-1' },
      document: { documentId: 'diagram', revision: 1, title: '流程图', graph: { nodes: [], edges: [] } },
      instruction: '增加异常节点' });
    assert.equal(started.ok, true);
    source.observeRuntime(runtimeFrame({ ...runtimeOwner, extra: 'ignored' }, classicStart(2)));
    source.observeRuntime(runtimeFrame(runtimeOwner, classicEnd(2, 'assistant', text(fenceDoc(addN9)))));
    source.observeRuntime(runtimeFrame({ ...runtimeOwner, runtimeGeneration: 'gen-0' }, classicSettled(2)));
    assert.equal(source.generationStatus(SCOPE_KEY, TOKEN).state, 'running');
    source.observeRuntime(runtimeFrame(runtimeOwner, classicSettled(2)));
    const status = source.generationStatus(SCOPE_KEY, TOKEN);
    assert.equal(status.state, 'ready');
    source.observeRuntime({ type: 'runtime_closed', conversationId: 'conv-1', owner: runtimeOwner });
    assert.equal(source.head(scope, 'diagram') !== null, true);

    const closed = makeSource();
    await closed.beginGeneration({ scope: { ...scope, origin: 'runtime', conversationId: 'conv-1' },
      document: { documentId: 'diagram', revision: 1, title: '流程图', graph: { nodes: [], edges: [] } }, instruction: 'x' });
    closed.observeRuntime(runtimeFrame(runtimeOwner, classicStart(2)));
    closed.observeRuntime({ type: 'runtime_closed', conversationId: 'conv-1', owner: runtimeOwner });
    assert.equal(closed.generationStatus(SCOPE_KEY, TOKEN).code, 'collab_generate_failed');
  });

  check('并发限制：同 scope 运行中再发起被拒绝；终局后可重新发起', async () => {
    const source = makeSource();
    const first = await begin(source);
    assert.equal(first.ok, true);
    const second = await begin(source);
    assert.equal(second.ok, false);
    assert.equal(second.code, 'collab_generation_active');
    source.observeClassic(classicStart(7));
    source.observeClassic(classicEnd(7, 'assistant', text(fenceDoc(addN9))));
    source.observeClassic(classicSettled(7));
    assert.equal(source.generationStatus(SCOPE_KEY, TOKEN).state, 'ready');
    const third = await begin(source);
    assert.equal(third.ok, true);
  });

  check('指令与文档校验：空/超长指令、非法文档拒绝', async () => {
    const source = makeSource();
    assert.equal((await begin(source, { instruction: '   ' })).code, 'collab_invalid');
    assert.equal((await begin(source, { instruction: 'x'.repeat(2001) })).code, 'collab_invalid');
    assert.equal((await begin(source, { instruction: 42 })).code, 'collab_invalid');
    assert.equal((await begin(source, { document: { documentId: 'bad id!', revision: 1, title: '', graph: { nodes: [], edges: [] } } })).code, 'collab_invalid');
    assert.equal(source.stats().attempts, 0);
  });

  check('通道失败映射：busy/未知错误码，且不留幽灵 attempt', async () => {
    const busy = makeSource({ channels: { ...channels, classic: { ...channels.classic,
      sendPrompt: async () => { throw Object.assign(Error(), { code: 'runtime_busy' }); } } } });
    const busyResult = await begin(busy);
    assert.equal(busyResult.ok, false);
    assert.equal(busyResult.code, 'collab_agent_busy');
    assert.equal(busy.stats().attempts, 0);
    busy.observeClassic(classicStart(7));
    busy.observeClassic(classicEnd(7, 'assistant', text(fenceDoc(addN9))));
    busy.observeClassic(classicSettled(7));
    assert.equal(busy.generationStatus(SCOPE_KEY, TOKEN).state, 'idle');

    const unknown = makeSource({ channels: { ...channels, classic: { ...channels.classic, sendPrompt: async () => { throw Error('boom'); } } } });
    assert.equal((await begin(unknown)).code, 'collab_generate_unavailable');

    const unavailable = makeSource({ channels: {} });
    assert.equal((await begin(unavailable)).code, 'collab_generate_unavailable');
    const badIdentity = makeSource({ channels: { ...channels, classic: { ...channels.classic, captureIdentity: () => ({ bridgeRun: 'x' }) } } });
    assert.equal((await begin(badIdentity)).code, 'collab_generate_unavailable');
  });

  check('运行超时：TTL 到点后 attempt 失败且信箱投递一次', async () => {
    let clock = 1000;
    const source = makeSource({ attemptTtlMs: 1000, now: () => clock });
    const started = await begin(source);
    assert.equal(started.ok, true);
    clock += 1001;
    const status = source.generationStatus(SCOPE_KEY, TOKEN);
    assert.equal(status.state, 'failed');
    assert.equal(status.code, 'collab_generate_timeout');
    assert.equal(source.generationStatus(SCOPE_KEY, TOKEN).state, 'idle');
  });

  check('生成 prompt 由服务端组合：含文档快照、指令与围栏契约，不含身份泄漏', async () => {
    const prompts = [];
    const capture = makeSource({ channels: { ...channels,
      classic: { ...channels.classic, sendPrompt: async (_key, message) => prompts.push(message) } } });
    await runClassicGeneration(capture, { messageText: fenceDoc(addN9) });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /documentId=diagram/);
    assert.match(prompts[0], /版本 1/);
    assert.match(prompts[0], /- n1「开始」\(0,0\)/);
    assert.match(prompts[0], /增加一个异常处理节点/);
    assert.match(prompts[0], /```pi-gui-collab/);
    assert.doesNotMatch(prompts[0], new RegExp(SCOPE_KEY.slice(0, 16)));
    assert.doesNotMatch(prompts[0], new RegExp(TOKEN.slice(0, 16)));
  });

  check('parseCollabFence 直接校验：取最后一处围栏并严格解析', () => {
    const dual = fenceDoc(addN9) + '\n```pi-gui-collab\n' + JSON.stringify({ ...addN9, rationale: '后者' }) + '\n```';
    assert.equal(parseCollabFence(dual, { maxFenceBytes: 65536 }).rationale, '后者');
    assert.throws(() => parseCollabFence('no fence', { maxFenceBytes: 65536 }), e => e.code === 'collab_generate_no_output');
    assert.throws(() => parseCollabFence('```pi-gui-collab\n' + 'x'.repeat(70000) + '\n```', { maxFenceBytes: 65536 }),
      e => e.code === 'collab_generate_invalid_output');
  });

  check('候选容量有界：超长消息标记失败，历史候选被淘汰', async () => {
    const source = makeSource({ maxCandidateBytes: 100 });
    await runClassicGeneration(source, { messageText: fenceDoc(addN9) });
    assert.equal(source.generationStatus(SCOPE_KEY, TOKEN).code, 'collab_generate_invalid_output');

    const capped = makeSource();
    const fourMessages = [1, 2, 3, 4].map(i => classicEnd(7, 'assistant', text(fenceDoc({ ...addN9, rationale: `v${i}` }))));
    await runClassicGeneration(capped, { events: fourMessages });
    const evidence = capped.get({ key: SCOPE_KEY, token: TOKEN }, capped.generationStatus(SCOPE_KEY, TOKEN).proposalId);
    assert.equal(evidence.proposal.rationale, 'v4');
  });

  check('空事件流与无关帧不崩溃', () => {
    const source = makeSource();
    source.observeClassic(null);
    source.observeClassic({ type: 'message_end' });
    source.observeRuntime(null);
    source.observeRuntime({ type: 'runtime_state' });
    source.observeRuntime({ type: 'runtime_event', owner: null, event: null });
    assert.equal(source.generationStatus(SCOPE_KEY, TOKEN).state, 'idle');
    assert.deepEqual(source.stats(), { size: 0, pending: 0, attempts: 0 });
  });

  // ---- Z4-3 独立验收：问题 2（token 隔离）与问题 4（prompt 竞态）----
  const TOKEN2 = 'f'.repeat(64);
  const scope2 = { ...scope, token: TOKEN2 };
  const docFixture = { documentId: 'diagram', revision: 1, title: '流程图', graph: { nodes: [{ id: 'n1', label: '开始', x: 0, y: 0 }], edges: [] } };

  check('旧 token 的生成结果对新 token 信箱不可见', async () => {
    const source = makeSource();
    await runClassicGeneration(source, { messageText: fenceDoc(addN9) });
    // 旧 token 一次性消费到 ready
    assert.equal(source.generationStatus(SCOPE_KEY, TOKEN).state, 'ready');
    // 新 token 看不到任何旧结果
    assert.deepEqual(source.generationStatus(SCOPE_KEY, TOKEN2), { state: 'idle' });
    assert.equal(source.head(scope2, 'diagram'), null);
    const evidence = source.get(scope2, source.get(scope, 'p-none') ? 'p-none' : 'x');
    assert.equal(evidence, null);
  });

  const gatedSource = () => {
    const pendings = [];
    const source = makeSource({ channels: { ...channels,
      classic: { ...channels.classic, sendPrompt: () => new Promise((resolve, reject) => pendings.push({ resolve, reject })) } } });
    return { source, releaseAll: () => pendings.splice(0).forEach(p => p.resolve()),
      rejectAll: err => pendings.splice(0).forEach(p => p.reject(err)) };
  };
  check('旧 token 未完成的 attempt 不阻塞新 token 合法生成；同 token 并发仍拒绝', async () => {
    const { source, releaseAll } = gatedSource();
    const first = begin(source);
    const second = source.beginGeneration({ scope: { ...scope2, origin: 'classic' }, document: docFixture, instruction: '新 owner 生成' });
    const sameToken = source.beginGeneration({ scope: { ...scope, origin: 'classic' }, document: docFixture, instruction: '并发' });
    releaseAll();
    assert.equal((await first).ok, true, '旧 token 发起成功');
    assert.equal((await sameToken).ok, false);
    assert.equal((await sameToken).code, 'collab_generation_active');
    assert.equal((await second).ok, true, '新 token 不被旧 attempt 阻塞');
  });

  check('token 失效后迟到的旧结果不能注册为新 owner 可用的建议', async () => {
    const { source, releaseAll } = gatedSource();
    const startedPromise = begin(source);
    releaseAll();
    const started = await startedPromise;
    assert.equal(started.ok, true);
    await Promise.resolve();
    // 旧 token 的 run 完成（armed 缓冲回放或 prompted 采集）
    source.observeClassic(classicStart(7));
    source.observeClassic(classicEnd(7, 'assistant', text(fenceDoc(addN9))));
    source.observeClassic(classicSettled(7));
    // 新 owner：无 pending 建议可见
    assert.equal(source.head(scope2, 'diagram'), null);
    const status = source.generationStatus(SCOPE_KEY, TOKEN2);
    assert.equal(status.state, 'idle', '新 token 信箱不得消费旧 token 结果');
    // 旧 token 自己仍能读到一次性结果（绑定旧 token，非新 owner 可用）
    assert.equal(source.generationStatus(SCOPE_KEY, TOKEN).state, 'ready');
    assert.notEqual(source.head(scope, 'diagram'), null);
  });

  check('sendPrompt 未确认期间出现的完整运行不注册为建议（失败清理）', async () => {
    const { source, rejectAll, releaseAll } = gatedSource();
    const startedPromise = begin(source);
    await new Promise(resolve => setImmediate(resolve));
    // 确认前：别的 run 完整跑完（含合法围栏）
    source.observeClassic(classicStart(7));
    source.observeClassic(classicEnd(7, 'assistant', text(fenceDoc(addN9))));
    source.observeClassic(classicSettled(7));
    // 我们的 prompt 被拒（rejected/queued/handled/异常同理）
    rejectAll(Object.assign(Error(), { code: 'collab_generate_rejected' }));
    const started = await startedPromise;
    assert.equal(started.ok, false);
    // attempt 已删除：任何 token 都读不到状态或建议
    assert.deepEqual(source.generationStatus(SCOPE_KEY, TOKEN), { state: 'idle' });
    assert.equal(source.head(scope, 'diagram'), null);
    // 通道释放后可立即重新发起
    const retryPromise = begin(source);
    releaseAll();
    assert.equal((await retryPromise).ok, true);
  });

  check('快速完成：确认响应与全部事件同批到达时不丢失合法完成', async () => {
    const { source, releaseAll } = gatedSource();
    const startedPromise = begin(source);
    await new Promise(resolve => setImmediate(resolve));
    // 确认前缓冲：我们自己的 run 已完整跑完（同批到达的真实竞态）
    source.observeClassic(classicStart(7));
    source.observeClassic(classicEnd(7, 'assistant', text(fenceDoc(addN9))));
    source.observeClassic(classicSettled(7));
    releaseAll();
    const started = await startedPromise;
    assert.equal(started.ok, true);
    const status = source.generationStatus(SCOPE_KEY, TOKEN);
    assert.equal(status.state, 'ready', '缓冲回放不得丢失合法完成');
    assert.equal(source.head(scope, 'diagram') !== null, true);
  });

  check('armed 缓冲超限时生成失败且不注册', async () => {
    const { source, releaseAll } = gatedSource();
    const startedPromise = begin(source);
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 20; i++) source.observeClassic(classicEnd(7, 'assistant', text(`消息 ${i}`)));
    releaseAll();
    const started = await startedPromise;
    assert.equal(started.ok, true);
    await Promise.resolve();
    const status = source.generationStatus(SCOPE_KEY, TOKEN);
    assert.equal(status.state, 'failed');
    assert.equal(status.code, 'collab_generate_failed');
    assert.equal(source.head(scope, 'diagram'), null);
  });

  for (const [name, fn] of checksToRun) {
    // 单检查超时：挂起（如旧实现里 gate Promise 永不 resolve）必须显式红，不能静默退出。
    let timer;
    try { await Promise.race([fn(), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('check-timeout: ' + name)), 5000); })]); }
    finally { clearTimeout(timer); }
    checks++; console.log('ok ' + name);
  }
  console.log(`\n${checks}/${checks} 通过，${assertions} 次断言`);
})().catch(e => { console.error('失败：' + (e && e.stack ? e.stack : e)); process.exit(1); });
