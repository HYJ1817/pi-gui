// 可信建议队列单元测试：不可变性、摘要绑定、ID 复用拒绝、supersede、TTL、容量。
// 纯内存模块，无 IO；全部断言离线可重复。
'use strict';
const baseAssert = require('node:assert/strict');
let assertions = 0;
const assert = new Proxy(baseAssert, {
  apply(target, receiver, args) { assertions++; return Reflect.apply(target, receiver, args); },
  get(target, key) { const value = target[key]; return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value; },
});
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('ok ' + name); };
(async () => {
  const { createProposalQueue, proposalDigest } = await import('../server/collab-proposal-queue.js');
  const { createProposal } = await import('../lib/collab-doc.js');

  const SCOPE = 'a'.repeat(64), TOKEN = 'b'.repeat(64), SESSION = 'session-a';
  const buildOps = (base = 1, label = '新节点') => {
    const proposal = createProposal({ documentId: 'diagram', baseRevision: base, sessionId: SESSION, rationale: '说明',
      ops: [{ opId: 'x1', type: 'node.add', baseRevision: base, actor: 'agent', params: { id: 'n9', label, x: 10, y: 20 } }] });
    return { ops: proposal.ops, rationale: proposal.rationale };
  };
  const register = (queue, overrides = {}) => queue.register({
    scopeKey: SCOPE, scopeToken: TOKEN, sessionId: SESSION, documentId: 'diagram', baseRevision: 1,
    ...buildOps(), run: { origin: 'classic', bridgeRun: 3 }, ...overrides });

  check('register/get 往返：信封不可变且摘要一致', () => {
    const queue = createProposalQueue();
    const result = register(queue);
    assert.equal(result.ok, true);
    const evidence = queue.get(SCOPE, TOKEN, result.proposalId);
    assert.equal(evidence.status, 'pending');
    assert.equal(evidence.proposal.proposalId, result.proposalId);
    assert.equal(evidence.proposal.ops.length, 1);
    assert.equal(evidence.digest, proposalDigest({ documentId: 'diagram', baseRevision: 1, sessionId: SESSION,
      rationale: evidence.proposal.rationale, ops: evidence.proposal.ops }));
    assert.equal(Object.isFrozen(evidence.proposal), true);
    assert.equal(Object.isFrozen(evidence.proposal.ops), true);
    assert.equal(Object.isFrozen(evidence.proposal.ops[0]), true);
    assert.equal(Object.isFrozen(evidence.proposal.ops[0].params), true);
    assert.throws(() => { evidence.proposal.rationale = '篡改'; }, TypeError);
    assert.throws(() => { evidence.proposal.ops[0].params.label = '篡改'; }, TypeError);
    assert.equal(queue.get(SCOPE, TOKEN, result.proposalId).proposal.ops[0].params.label, '新节点');
  });

  check('摘要对键顺序不敏感', () => {
    const base = { documentId: 'diagram', baseRevision: 1, sessionId: SESSION, rationale: 'r',
      ops: [{ opId: 'o', type: 'node.add', baseRevision: 1, actor: 'agent', params: { id: 'n1', label: 'L', x: 0, y: 1 } }] };
    const reordered = { ops: [{ params: { y: 1, x: 0, label: 'L', id: 'n1' }, actor: 'agent', baseRevision: 1, type: 'node.add', opId: 'o' }],
      rationale: 'r', sessionId: SESSION, baseRevision: 1, documentId: 'diagram' };
    assert.equal(proposalDigest(base), proposalDigest(reordered));
    assert.notEqual(proposalDigest(base), proposalDigest({ ...base, rationale: 'r2' }));
  });

  check('proposalId 复用：同内容幂等、异内容拒绝', () => {
    const queue = createProposalQueue();
    const first = register(queue, { proposalId: 'p-fixed' });
    assert.equal(first.ok, true);
    const replay = register(queue, { proposalId: 'p-fixed' });
    assert.equal(replay.ok, true); assert.equal(replay.duplicate, true); assert.equal(replay.proposalId, 'p-fixed');
    const hijack = register(queue, { proposalId: 'p-fixed', ...buildOps(1, '不同内容') });
    assert.equal(hijack.ok, false); assert.equal(hijack.code, 'proposal_id_reuse');
    assert.equal(queue.get(SCOPE, TOKEN, 'p-fixed').proposal.ops[0].params.label, '新节点');
  });

  check('同 scope+document 的新建议使旧 pending 作废（supersede）', () => {
    const queue = createProposalQueue();
    const first = register(queue);
    const second = register(queue, { ...buildOps(2, '第二次生成'), baseRevision: 2 });
    assert.equal(second.ok, true);
    assert.equal(queue.get(SCOPE, TOKEN, first.proposalId), null);
    assert.equal(queue.get(SCOPE, TOKEN, second.proposalId).status, 'pending');
    const head = queue.head(SCOPE, TOKEN, 'diagram');
    assert.equal(head.proposalId, second.proposalId);
    assert.equal(head.baseRevision, 2);
  });

  check('scope/token 失效后旧建议不可见', () => {
    const queue = createProposalQueue();
    const result = register(queue);
    assert.equal(queue.get('c'.repeat(64), TOKEN, result.proposalId), null);
    assert.equal(queue.get(SCOPE, 'd'.repeat(64), result.proposalId), null);
    assert.equal(queue.head(SCOPE, 'd'.repeat(64), 'diagram'), null);
  });

  check('settle 终局迁移；accepted 证据保留供重复接受幂等', () => {
    const queue = createProposalQueue();
    const result = register(queue);
    assert.equal(queue.settle(SCOPE, result.proposalId, 'rejected'), true);
    assert.equal(queue.settle(SCOPE, result.proposalId, 'accepted'), false);
    assert.equal(queue.get(SCOPE, TOKEN, result.proposalId).status, 'rejected');
    const second = register(queue);
    assert.equal(queue.settle(SCOPE, second.proposalId, 'accepted'), true);
    assert.equal(queue.get(SCOPE, TOKEN, second.proposalId).status, 'accepted');
    assert.equal(queue.head(SCOPE, TOKEN, 'diagram'), null);
  });

  check('pending TTL 过期后不可解析', () => {
    let clock = 1000;
    const queue = createProposalQueue({ pendingTtlMs: 5000, now: () => clock });
    const result = register(queue);
    clock += 5001;
    assert.equal(queue.get(SCOPE, TOKEN, result.proposalId), null);
    assert.equal(queue.head(SCOPE, TOKEN, 'diagram'), null);
  });

  check('容量有界：满时拒绝并优先淘汰终局条目', () => {
    const queue = createProposalQueue({ capacity: 2 });
    const first = register(queue, { documentId: 'doc-1' });
    const second = register(queue, { documentId: 'doc-2' });
    const third = register(queue, { documentId: 'doc-3' });
    assert.equal(third.ok, false); assert.equal(third.code, 'collab_queue_full');
    queue.settle(SCOPE, first.proposalId, 'rejected');
    const fourth = register(queue, { documentId: 'doc-3' });
    assert.equal(fourth.ok, true);
    assert.equal(queue.get(SCOPE, TOKEN, first.proposalId), null);
    assert.equal(queue.get(SCOPE, TOKEN, second.proposalId).status, 'pending');
  });

  check('结构性输入校验拒绝非法信封', () => {
    const queue = createProposalQueue();
    const bad = (overrides) => { assert.throws(() => register(queue, overrides), Error); };
    bad({ scopeKey: 'short' });
    bad({ scopeToken: null });
    bad({ sessionId: '非法 id!' });
    bad({ baseRevision: 0 });
    bad({ rationale: 'x'.repeat(2001) });
    bad({ ops: [] });
    assert.throws(() => register(queue, { ops: [{ opId: 'o', type: 'node.add', baseRevision: 1, actor: 'user', params: { id: 'n1', label: 'L', x: 0, y: 0 } }] }), Error);
  });

  check('dropScope/dropAll/stats 只暴露结构计数', () => {
    const queue = createProposalQueue();
    const result = register(queue);
    assert.deepEqual(queue.stats(), { size: 1, pending: 1 });
    queue.dropScope('e'.repeat(64));
    assert.equal(queue.stats().size, 1);
    queue.dropScope(SCOPE);
    assert.equal(queue.get(SCOPE, TOKEN, result.proposalId), null);
    register(queue);
    queue.dropAll();
    assert.deepEqual(queue.stats(), { size: 0, pending: 0 });
  });

  console.log(`\n${checks}/${checks} 通过，${assertions} 次断言`);
})().catch(e => { console.error('失败：' + (e && e.stack ? e.stack : e)); process.exit(1); });
