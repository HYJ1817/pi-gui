// Z4-3 阶段 C 集成测试：service generate/proposal_status 动作 + 真实来源适配器
// + 真实存储（os.tmpdir()）。覆盖：生成触发校验、事件→队列→预览→接受全链路、
// 生成期间编辑冲突、重新生成 supersede、跨 scope/owner 隔离、迟到建议、
// 保存失败字节不变、后端重启清空。离线，fake Pi 协议形状见 tests/collab-proposal-source.cjs。
'use strict';
const baseAssert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let assertions = 0;
const assert = new Proxy(baseAssert, {
  apply(target, receiver, args) { assertions++; return Reflect.apply(target, receiver, args); },
  get(target, key) { const value = target[key]; return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value; },
});
let checks = 0;
const checksToRun = [];
const check = (name, fn) => { checksToRun.push([name, fn]); };
(async () => {
  const { createCollabService } = await import('../server/collab-service.js');
  const { createCollabStore } = await import('../server/collab-store.js');
  const { createCollabProposalSource } = await import('../server/collab-proposal-source.js');
  const { createProposalQueue } = await import('../server/collab-proposal-queue.js');

  const FENCE = json => '分析完成。\n```pi-gui-collab\n' + JSON.stringify(json) + '\n```';
  const ADD_N9 = { version: 1, rationale: '增加异常处理节点', ops: [{ type: 'node.add', params: { id: 'n9', label: '异常处理', x: 600, y: 0 } }] };
  const ADD_N8 = { version: 1, rationale: '第二个建议', ops: [{ type: 'node.add', params: { id: 'n8', label: '重试', x: 300, y: 100 } }] };
  const start = bridgeRun => ({ type: 'agent_start', bridgeRun });
  const end = (bridgeRun, role, textContent, stopReason = 'stop') =>
    ({ type: 'message_end', message: { role, content: [{ type: 'text', text: textContent }], stopReason, timestamp: 1 }, bridgeRun });
  const settled = (bridgeRun, aborted = false) => ({ type: 'agent_settled', aborted, bridgeRun });

  let promptLog = [];
  const channels = {
    classic: { captureIdentity: () => ({ bridgeRun: 7 }), sendPrompt: async (_key, message) => { promptLog.push(message); } },
    runtime: { captureIdentity: id => ({ backendInstance: 'be', conversationId: id, runtimeId: 'rt', runtimeGeneration: 'g1' }),
      sendPrompt: async () => {} },
  };
  const makeHarness = () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-z43-flow-'));
    const store = createCollabStore({ dataDir });
    const source = createCollabProposalSource({ queue: createProposalQueue(), channels });
    const service = createCollabService({ store, proposals: source });
    const cleanup = () => fs.rmSync(dataDir, { recursive: true, force: true });
    return { store, source, service, dataDir, cleanup };
  };
  const fakeRoot = suffix => path.join(os.tmpdir(), `pi-gui-z43-${suffix}`);
  const hex = (seed) => require('node:crypto').createHash('sha256').update(seed).digest('hex');
  const scopeFor = (seed, tokenSeed, origin = 'classic', conversationId = null) => ({
    key: hex(seed), token: hex(tokenSeed), sessionId: hex(`session-${seed}`), origin, conversationId,
    projectRoot: fakeRoot(`project-${seed}`), workspaceCwd: fakeRoot(`project-${seed}`), gitCommon: fakeRoot(`git-${seed}`),
    assertCurrent() {},
  });
  const A = () => scopeFor('a'.repeat(64), '1'.repeat(64));
  const B = () => scopeFor('b'.repeat(64), '2'.repeat(64));

  const openAndCreate = (service, scope) => {
    const open = service.execute(scope, { action: 'open' });
    return service.execute(scope, { action: 'create', editorId: open.editorId, expectedRevision: null });
  };
  // generate 现在分两段：execute 在 authority 锁内校验并返回 pendingGenerate，
  // dispatchPendingGenerate 在锁外真实发起（与生产 routes 行为一致）。
  const generate = async (service, scope, editorId, revision, instruction = '增加一个异常处理节点') => {
    const result = service.execute(scope, { action: 'generate', editorId, expectedRevision: revision, instruction });
    if (result?.pendingGenerate) {
      const outcome = await service.dispatchPendingGenerate(result.pendingGenerate);
      if (!outcome.ok) throw Object.assign(Error(outcome.code), { code: outcome.code });
      return { ...result, ...outcome };
    }
    return result;
  };
  const feedRun = (source, fenceJson, { bridgeRun = 7, role = 'assistant', aborted = false, textContent = null } = {}) => {
    source.observeClassic(start(bridgeRun));
    if (fenceJson !== null || textContent !== null) source.observeClassic(end(bridgeRun, role, textContent ?? FENCE(fenceJson)));
    source.observeClassic(settled(bridgeRun, aborted));
  };

  check('generate 请求形状与前置校验：未建文档/空指令/超长指令/缺字段', async () => {
    const { service, cleanup } = makeHarness();
    const scope = A();
    const editor = service.execute(scope, { action: 'open' });
    await assert.rejects(() => generate(service, scope, editor.editorId, null), e => e.code === 'collab_invalid');
    const created = openAndCreate(service, scope);
    await assert.rejects(() => generate(service, scope, created.editorId, 1, '   '), e => e.code === 'collab_invalid');
    await assert.rejects(() => generate(service, scope, created.editorId, 1, 'x'.repeat(2001)), e => e.code === 'collab_invalid');
    await assert.rejects(async () => service.execute(scope, { action: 'generate', editorId: created.editorId, expectedRevision: 1 }),
      e => e.code === 'collab_invalid');
    await assert.rejects(() => generate(service, scope, created.editorId, 2), e => e.code === 'collab_conflict');
    assert.deepEqual(promptLog, []);
    cleanup();
  });

  check('全链路：generate → 事件 → 队列 → proposal_status → preview → accept → 撤销', async () => {
    const { service, source, cleanup } = makeHarness();
    const scope = A();
    const editor = openAndCreate(service, scope);
    assert.equal(editor.document.revision, 1);
    const generating = await generate(service, scope, editor.editorId, 1);
    assert.equal(generating.generating, true);
    assert.equal(promptLog.length, 1);
    assert.match(promptLog[0], /```pi-gui-collab/);
    feedRun(source, ADD_N9);
    let status = service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 1 });
    assert.equal(status.proposalSourceAvailable, true);
    assert.equal(status.generating, false);
    assert.equal(status.generation.state, 'ready');
    assert.equal(status.proposal.baseRevision, 1);
    assert.equal(status.proposal.opCount, 1);
    // 信箱只投递一次
    status = service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 1 });
    assert.equal(status.generation, null);
    assert.notEqual(status.proposal, null);
    const preview = service.execute(scope, { action: 'preview', editorId: editor.editorId, expectedRevision: 1, proposalId: status.proposal.proposalId });
    assert.equal(preview.ok, true);
    assert.equal(preview.preview.resultingRevision, 2);
    const accepted = await service.execute(scope, { action: 'accept', editorId: editor.editorId, expectedRevision: 1, proposalId: status.proposal.proposalId });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.document.revision, 2);
    assert.ok(accepted.document.graph.nodes.some(n => n.id === 'n9'));
    const undone = service.execute(scope, { action: 'undo', editorId: editor.editorId, expectedRevision: 2 });
    assert.equal(undone.ok, true);
    assert.equal(undone.document.revision, 3); // undo 产生新 revision
    cleanup();
  });

  check('生成期间用户编辑：接受时返回冲突，保留用户当前文档', async () => {
    const { service, source, cleanup } = makeHarness();
    const scope = A();
    const editor = openAndCreate(service, scope);
    await generate(service, scope, editor.editorId, 1);
    feedRun(source, ADD_N9);
    const status = service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 1 });
    // 生成落队列后，用户先编辑（revision 2）
    const edited = service.execute(scope, { action: 'operations', editorId: editor.editorId, expectedRevision: 1,
      ops: [{ opId: 'u1', type: 'node.update', baseRevision: 1, actor: 'user', params: { id: 'n2', label: '用户改过' } }] });
    assert.equal(edited.ok, true);
    // 服务层 revision 闸门先拒绝：接受旧版本建议 = 明确冲突，不修改文档。
    assert.throws(() => service.execute(scope, { action: 'accept', editorId: editor.editorId, expectedRevision: 1, proposalId: status.proposal.proposalId }),
      e => e.code === 'collab_conflict');
    const current = service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 2 });
    assert.equal(current.document.revision, 2);
    assert.equal(current.document.graph.nodes.find(n => n.id === 'n2').label, '用户改过');
    cleanup();
  });

  check('重新生成发起新受控任务：旧 pending 被 supersede，旧 proposalId 不可用', async () => {
    const { service, source, cleanup } = makeHarness();
    const scope = A();
    const editor = openAndCreate(service, scope);
    await generate(service, scope, editor.editorId, 1);
    feedRun(source, ADD_N9);
    const first = service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 1 });
    await generate(service, scope, editor.editorId, 1, '改成两个分支');
    feedRun(source, ADD_N8);
    const second = service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 1 });
    assert.equal(second.proposal.proposalId !== first.proposal.proposalId, true);
    assert.equal(second.proposal.rationale, '第二个建议');
    await assert.rejects(async () => service.execute(scope, { action: 'preview', editorId: editor.editorId, expectedRevision: 1, proposalId: first.proposal.proposalId }),
      e => e.code === 'collab_proposal_unavailable');
    // 新建议仍可接受
    const accepted = await service.execute(scope, { action: 'accept', editorId: editor.editorId, expectedRevision: 1, proposalId: second.proposal.proposalId });
    assert.equal(accepted.ok, true);
    assert.ok(accepted.document.graph.nodes.some(n => n.id === 'n8'));
    cleanup();
  });

  check('跨 scope/owner 隔离：B 的 scope 看不到 A 的建议；token 变化后不可见', async () => {
    const { service, source, cleanup } = makeHarness();
    const scopeA = A(), scopeB = B();
    const editorA = openAndCreate(service, scopeA);
    openAndCreate(service, scopeB);
    await generate(service, scopeA, editorA.editorId, 1);
    feedRun(source, ADD_N9);
    const statusA = service.execute(scopeA, { action: 'proposal_status', editorId: editorA.editorId, expectedRevision: 1 });
    assert.notEqual(statusA.proposal, null);
    const statusB = service.execute(scopeB, { action: 'proposal_status', editorId: service.execute(scopeB, { action: 'open' }).editorId, expectedRevision: 1 });
    assert.equal(statusB.proposal, null);
    // owner 代次变化 → token 变化 → A 的旧建议不可见
    const staleScope = scopeFor('a'.repeat(64), '9'.repeat(64));
    const staleEditor = service.execute(staleScope, { action: 'open' });
    const stale = service.execute(staleScope, { action: 'proposal_status', editorId: staleEditor.editorId, expectedRevision: 1 });
    assert.equal(stale.proposal, null);
    cleanup();
  });

  check('迟到的旧 run 建议：bridge 异常后事件不再归属；aborted 丢弃', async () => {
    const { service, source, cleanup } = makeHarness();
    const scope = A();
    const editor = openAndCreate(service, scope);
    await generate(service, scope, editor.editorId, 1);
    source.observeClassic({ type: 'bridge_status', state: 'exited', bridgeRun: 8 });
    feedRun(source, ADD_N9); // 新 bridge 上的 run 与已失败的 attempt 无关
    const status = service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 1 });
    assert.equal(status.generation.state, 'failed');
    assert.equal(status.generation.code, 'collab_generate_failed');
    assert.equal(status.proposal, null);
    // aborted run 不产出建议
    await generate(service, scope, editor.editorId, 1);
    feedRun(source, ADD_N9, { aborted: true });
    const status2 = service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 1 });
    assert.equal(status2.generation.state, 'failed');
    assert.equal(status2.generation.code, 'collab_generate_aborted');
    assert.equal(status2.proposal, null);
    cleanup();
  });

  check('保存失败：文档字节不变，建议保持 pending 可重试', async () => {
    const { store, source, service, dataDir, cleanup } = makeHarness();
    const scope = A();
    const editor = openAndCreate(service, scope);
    await generate(service, scope, editor.editorId, 1);
    feedRun(source, ADD_N9);
    const status = service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 1 });
    const docPath = path.join(dataDir, 'collab-documents', `${scope.key}.json`);
    const before = fs.readFileSync(docPath);
    let failWrite = true;
    const realWrite = store.write.bind(store);
    store.write = (...args) => {
      if (failWrite) throw Object.assign(Error('injected'), { code: 'collab_storage_write_failed' });
      return realWrite(...args);
    };
    await assert.rejects(async () => service.execute(scope, { action: 'accept', editorId: editor.editorId, expectedRevision: 1, proposalId: status.proposal.proposalId }),
      e => e.code === 'collab_storage_write_failed');
    assert.deepEqual(fs.readFileSync(docPath), before);
    // 注入解除后同一建议可再次接受成功（CAS 仍基于 revision 1）
    failWrite = false;
    const accepted = await service.execute(scope, { action: 'accept', editorId: editor.editorId, expectedRevision: 1, proposalId: status.proposal.proposalId });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.document.revision, 2);
    cleanup();
  });

  check('后端重启等价：新 service+source 实例无任何在途生成与建议', async () => {
    const first = makeHarness();
    const scope = A();
    const editor = openAndCreate(first.service, scope);
    await generate(first.service, scope, editor.editorId, 1);
    feedRun(first.source, ADD_N9);
    assert.notEqual(first.service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 1 }).proposal, null);
    first.cleanup();
    // 全新进程内存态为空：同 scope 重开无建议、无生成
    const second = makeHarness();
    const reopened = second.service.execute(scope, { action: 'open' });
    const status = second.service.execute(scope, { action: 'proposal_status', editorId: reopened.editorId, expectedRevision: 1 });
    assert.equal(status.generating, false);
    assert.equal(status.generation, null);
    assert.equal(status.proposal, null);
    second.cleanup();
  });

  check('重复接受与重复拒绝：终局后幂等或明确拒绝，不重复修改文档', async () => {
    const { service, source, cleanup } = makeHarness();
    const scope = A();
    const editor = openAndCreate(service, scope);
    await generate(service, scope, editor.editorId, 1);
    feedRun(source, ADD_N9);
    const status = service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 1 });
    const accepted = await service.execute(scope, { action: 'accept', editorId: editor.editorId, expectedRevision: 1, proposalId: status.proposal.proposalId });
    assert.equal(accepted.ok, true);
    // 已接受的建议重复接受 → duplicate（不改变 revision）
    const again = await service.execute(scope, { action: 'accept', editorId: editor.editorId, expectedRevision: 2, proposalId: status.proposal.proposalId });
    assert.equal(again.ok, true);
    assert.equal(again.status, 'duplicate');
    assert.equal(again.document.revision, 2);
    // 拒绝另一条建议：文档不变
    await generate(service, scope, editor.editorId, 2, '再来一条');
    feedRun(source, ADD_N8);
    const second = service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 2 });
    const rejected = await service.execute(scope, { action: 'reject', editorId: editor.editorId, expectedRevision: 2, proposalId: second.proposal.proposalId });
    assert.equal(rejected.ok, true);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.document.revision, 2);
    // 重复拒绝幂等：仍是 rejected，文档不变
    const rejectedAgain = await service.execute(scope, { action: 'reject', editorId: editor.editorId, expectedRevision: 2, proposalId: second.proposal.proposalId });
    assert.equal(rejectedAgain.ok, true);
    assert.equal(rejectedAgain.status, 'rejected');
    assert.equal(rejectedAgain.document.revision, 2);
    cleanup();
  });

  check('Runtime scope：conversationId 进入来源； Classic/Runtime 生成互不串扰', async () => {
    const { service, source, cleanup } = makeHarness();
    const scopeR = scopeFor("scope-r", "token-r", "runtime", "conv-1");
    const editor = openAndCreate(service, scopeR);
    await generate(service, scopeR, editor.editorId, 1);
    // Runtime 帧到达
    let seq = 0;
    const owner = { backendInstance: 'be', conversationId: 'conv-1', runtimeId: 'rt', runtimeGeneration: 'g1' };
    source.observeRuntime({ type: 'runtime_event', owner, eventSequence: ++seq, event: start(2) });
    source.observeRuntime({ type: 'runtime_event', owner, eventSequence: ++seq, event: end(2, 'assistant', FENCE(ADD_N9)) });
    source.observeRuntime({ type: 'runtime_event', owner, eventSequence: ++seq, event: settled(2) });
    const status = service.execute(scopeR, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 1 });
    assert.equal(status.generation.state, 'ready');
    const accepted = await service.execute(scopeR, { action: 'accept', editorId: editor.editorId, expectedRevision: 1, proposalId: status.proposal.proposalId });
    assert.equal(accepted.ok, true);
    cleanup();
  });

  check('终局状态转换矩阵：rejected→accepted 与 accepted→rejected 均被服务端拒绝', async () => {
    const { service, source, dataDir, cleanup } = makeHarness();
    const scope = A();
    const editor = openAndCreate(service, scope);
    const docPath = path.join(dataDir, 'collab-documents', `${scope.key}.json`);
    // rejected → accepted：拒绝后的建议不能再被应用
    await generate(service, scope, editor.editorId, 1);
    feedRun(source, ADD_N9);
    const rejectedStatus = service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 1 });
    const rejectedId = rejectedStatus.proposal.proposalId;
    await service.execute(scope, { action: 'reject', editorId: editor.editorId, expectedRevision: 1, proposalId: rejectedId });
    const bytesAfterReject = fs.readFileSync(docPath);
    assert.throws(() => service.execute(scope, { action: 'accept', editorId: editor.editorId, expectedRevision: 1, proposalId: rejectedId }),
      e => e.code === 'collab_proposal_unavailable');
    assert.deepEqual(fs.readFileSync(docPath), bytesAfterReject, '拒绝后再接受不得改变文档字节');
    // accepted → rejected：接受成功后反向终局必须拒绝
    await generate(service, scope, editor.editorId, 1, '第二条建议');
    feedRun(source, ADD_N8);
    const acceptedStatus = service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 1 });
    const acceptedId = acceptedStatus.proposal.proposalId;
    const accepted = await service.execute(scope, { action: 'accept', editorId: editor.editorId, expectedRevision: 1, proposalId: acceptedId });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.document.revision, 2);
    const bytesAfterAccept = fs.readFileSync(docPath);
    assert.throws(() => service.execute(scope, { action: 'reject', editorId: editor.editorId, expectedRevision: 2, proposalId: acceptedId }),
      e => e.code === 'collab_proposal_unavailable');
    assert.deepEqual(fs.readFileSync(docPath), bytesAfterAccept, '接受后反向拒绝不得改变文档字节');
    // 同一建议重复接受仍是幂等 duplicate（合法迁移的重复确认）
    const again = await service.execute(scope, { action: 'accept', editorId: editor.editorId, expectedRevision: 2, proposalId: acceptedId });
    assert.equal(again.ok, true);
    assert.equal(again.status, 'duplicate');
    // rejected → rejected：幂等重复拒绝
    await service.execute(scope, { action: 'reject', editorId: editor.editorId, expectedRevision: 2, proposalId: rejectedId });
    cleanup();
  });

  check('superseded 建议不可接受或重新激活', async () => {
    const { service, source, cleanup } = makeHarness();
    const scope = A();
    const editor = openAndCreate(service, scope);
    await generate(service, scope, editor.editorId, 1);
    feedRun(source, ADD_N9);
    const first = service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 1 });
    await generate(service, scope, editor.editorId, 1, '替代生成');
    feedRun(source, ADD_N8);
    const second = service.execute(scope, { action: 'proposal_status', editorId: editor.editorId, expectedRevision: 1 });
    assert.throws(() => service.execute(scope, { action: 'accept', editorId: editor.editorId, expectedRevision: 1, proposalId: first.proposal.proposalId }),
      e => e.code === 'collab_proposal_unavailable');
    assert.throws(() => service.execute(scope, { action: 'reject', editorId: editor.editorId, expectedRevision: 1, proposalId: first.proposal.proposalId }),
      e => e.code === 'collab_proposal_unavailable');
    const accepted = await service.execute(scope, { action: 'accept', editorId: editor.editorId, expectedRevision: 1, proposalId: second.proposal.proposalId });
    assert.equal(accepted.ok, true);
    cleanup();
  });

  for (const [name, fn] of checksToRun) { await fn(); checks++; console.log('ok ' + name); }
  console.log(`\n${checks}/${checks} 通过，${assertions} 次断言`);
})().catch(e => { console.error('失败：' + (e && e.stack ? e.stack : e)); process.exit(1); });
