// Z4-1 隔离原型测试：只验证数据层，不接入 npm test 链，不依赖真 pi / 网络。
// 运行：node prototype/z4-1-collab/collab-test.mjs

import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION, LIMITS,
  createDocument, createFlowchartDocument, serialize, deserialize,
  applyOperations, applyUserOperation, bindSession,
  createProposal, previewProposalReadonly, acceptProposal, rejectProposal,
  createEditorState, commitOperations, undo, redo,
} from './collab-doc.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

const userOp = (opId, type, baseRevision, params) => ({ opId, type, baseRevision, actor: 'user', params });

// 1. 文档 schema 校验 ---------------------------------------------------------
check('1a documentId 非法被拒绝', () => {
  assert.throws(() => createDocument({ documentId: '../evil' }), /schema/);
  assert.throws(() => createDocument({ documentId: 42 }), /schema/);
});

check('1b 反序列化拒绝未知字段', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-1' });
  const json = JSON.parse(serialize(doc));
  json.extra = 'injected';
  assert.throws(() => deserialize(JSON.stringify(json)), /schema/);
});

check('1c 反序列化拒绝未知 schemaVersion', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-1' });
  const json = JSON.parse(serialize(doc));
  json.schemaVersion = 99;
  assert.throws(() => deserialize(JSON.stringify(json)), /schema-version/);
});

check('1d 反序列化拒绝悬空连线引用与自环', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-1' });
  const json = JSON.parse(serialize(doc));
  json.graph.edges[0].to = 'ghost';
  assert.throws(() => deserialize(JSON.stringify(json)), /schema/);
  const json2 = JSON.parse(serialize(doc));
  json2.graph.edges[0].to = json2.graph.edges[0].from;
  assert.throws(() => deserialize(JSON.stringify(json2)), /schema/);
});

check('1e 操作携带未知字段被拒绝', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-1' });
  const bad = { opId: 'x1', type: 'node.update', baseRevision: doc.revision, actor: 'user', params: { id: 'n1', label: '新' }, exec: 'rm -rf /' };
  const r = applyUserOperation(doc, bad);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'schema');
});

check('1f 未知操作类型被拒绝', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-1' });
  const r = applyUserOperation(doc, { opId: 'x1', type: 'doc.replaceAll', baseRevision: doc.revision, actor: 'user', params: {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unknown-type');
});

// 2. 正常节点与连线操作 -------------------------------------------------------
check('2a 建样例文档：3 节点 2 连线', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-demo' });
  assert.equal(doc.graph.nodes.length, 3);
  assert.equal(doc.graph.edges.length, 2);
  assert.equal(doc.revision, 2); // 种子批次占一个 revision
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
});

check('2b 用户改文字 / 移动节点 / 加连线', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const st = createEditorState();
  const r1 = applyUserOperation(doc, userOp('u1', 'node.update', doc.revision, { id: 'n2', label: '校验并处理' }));
  assert.equal(r1.ok, true);
  doc = r1.doc;
  const r2 = applyUserOperation(doc, userOp('u2', 'node.update', doc.revision, { id: 'n2', x: 260, y: 40 }));
  assert.equal(r2.ok, true);
  doc = r2.doc;
  const r3 = applyUserOperation(doc, userOp('u3', 'edge.add', doc.revision, { id: 'e3', from: 'n3', to: 'n1', label: '回环' }));
  assert.equal(r3.ok, true);
  doc = r3.doc;
  assert.equal(doc.graph.nodes.find((n) => n.id === 'n2').label, '校验并处理');
  assert.equal(doc.graph.nodes.find((n) => n.id === 'n2').x, 260);
  assert.equal(doc.graph.edges.length, 3);
  assert.equal(doc.revision, 5);
  // 走 commitOperations 入口同样可用（撤销栈记录）
  const r4 = commitOperations(doc, st, [userOp('u4', 'node.update', doc.revision, { id: 'n1', label: 'Start' })]);
  assert.equal(r4.ok, true);
  assert.equal(st.undoStack.length, 1);
});

// 3. 无效操作拒绝 -------------------------------------------------------------
check('3a 自环 / 悬空引用 / 重复边被拒绝', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const r1 = applyUserOperation(doc, userOp('b1', 'edge.add', doc.revision, { id: 'bx', from: 'n1', to: 'n1' }));
  assert.equal(r1.code, 'self-loop');
  const r2 = applyUserOperation(doc, userOp('b2', 'edge.add', doc.revision, { id: 'bx', from: 'n1', to: 'ghost' }));
  assert.equal(r2.code, 'missing');
  const r3 = applyUserOperation(doc, userOp('b3', 'edge.add', doc.revision, { id: 'bx', from: 'n1', to: 'n2' }));
  assert.equal(r3.code, 'duplicate-edge');
});

check('3b 非法坐标与超长文字被拒绝', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const r1 = applyUserOperation(doc, userOp('b1', 'node.add', doc.revision, { id: 'n9', label: 'x', x: 'a', y: 0 }));
  assert.equal(r1.code, 'schema');
  const r2 = applyUserOperation(doc, userOp('b2', 'node.add', doc.revision, { id: 'n9', label: 'x', x: Infinity, y: 0 }));
  assert.equal(r2.code, 'schema');
  const r3 = applyUserOperation(doc, userOp('b3', 'node.add', doc.revision, { id: 'n9', label: 'l'.repeat(LIMITS.labelMax + 1), x: 0, y: 0 }));
  assert.equal(r3.code, 'schema');
});

check('3c 删除仍被引用的节点被拒绝', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const r = applyUserOperation(doc, userOp('b1', 'node.remove', doc.revision, { id: 'n2' }));
  assert.equal(r.code, 'referenced');
});

// 4. 重复操作幂等 -------------------------------------------------------------
check('4a 同一 opId 重复提交不产生重复修改', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const op = userOp('dup-1', 'node.add', doc.revision, { id: 'n9', label: '缓存', x: 0, y: 100 });
  const r1 = applyUserOperation(doc, op);
  assert.equal(r1.ok, true);
  doc = r1.doc;
  const rev = doc.revision;
  const before = serialize(doc);
  const r2 = applyUserOperation(doc, op);
  assert.equal(r2.ok, true);
  assert.equal(r2.status, 'duplicate');
  assert.equal(doc.revision, rev);
  assert.equal(serialize(doc), before);
});

check('4c 同 opId 夹带不同内容被拒绝（opid-reuse）', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const op = userOp('dup-1', 'node.add', doc.revision, { id: 'n9', label: '缓存', x: 0, y: 100 });
  doc = applyUserOperation(doc, op).doc;
  const before = serialize(doc);
  // 同一 opId，内容换成更新操作（伪装成「已应用」的重放）
  const forged = userOp('dup-1', 'node.update', doc.revision, { id: 'n1', label: '被篡改' });
  const r = applyUserOperation(doc, forged);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'opid-reuse');
  assert.equal(serialize(doc), before);
});

check('4d 幂等窗口外的重放由 revision 单调性兜底（stale-base）', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' }); // revision 2，日志含 5 条种子
  const ops = [];
  for (let i = 0; i < LIMITS.journalMax; i += 1) {
    ops.push(userOp(`evict-${i}`, 'node.update', doc.revision, { id: 'n1', label: `L${i}` }));
  }
  doc = applyOperations(doc, ops).doc; // 日志达到 505 条，5 条种子被 FIFO 淘汰
  assert.equal(doc.appliedOps.length, LIMITS.journalMax);
  assert.equal(doc.appliedOps.some((e) => e.id === 'seed-n1'), false);
  const before = serialize(doc);
  const r = applyUserOperation(doc, userOp('seed-n1', 'node.add', 1, { id: 'n1', label: '开始', x: 0, y: 0 }));
  // 种子 opId 已被淘汰，日志不再认识它；但它的 baseRevision 1 永远追不上单调前进的 revision
  assert.equal(r.ok, false);
  assert.equal(r.code, 'stale-base');
  assert.equal(serialize(doc), before);
});

check('4b 建议重复接受幂等', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  doc = bindSession(doc, 'sess-1');
  const st = createEditorState();
  const prop = createProposal({
    documentId: 'doc-demo', baseRevision: doc.revision, sessionId: 'sess-1',
    ops: [{ opId: 'a1', type: 'node.add', baseRevision: doc.revision, params: { id: 'n9', label: '缓存', x: 0, y: 100 } }],
  });
  const r1 = acceptProposal(doc, st, prop, { expectedRevision: doc.revision });
  assert.equal(r1.ok, true);
  doc = r1.doc;
  const before = serialize(doc);
  const r2 = acceptProposal(doc, st, prop, { expectedRevision: doc.revision });
  assert.equal(r2.ok, true);
  assert.equal(r2.status, 'duplicate');
  assert.equal(serialize(doc), before);
});

// 5. revision 不一致 ----------------------------------------------------------
check('5a 旧 baseRevision 的操作被拒绝', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const stale = userOp('s1', 'node.update', 1, { id: 'n1', label: '旧' });
  const r = applyUserOperation(doc, stale);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'stale-base');
  assert.match(r.detail, /revision 1/);
});

check('5b 基于旧 revision 的建议带冲突信息', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  doc = bindSession(doc, 'sess-1');
  const base = doc.revision;
  doc = applyUserOperation(doc, userOp('u1', 'node.update', doc.revision, { id: 'n1', label: '用户改过' })).doc;
  const prop = createProposal({
    documentId: 'doc-demo', baseRevision: base, sessionId: 'sess-1',
    ops: [{ opId: 'a1', type: 'node.add', baseRevision: base, params: { id: 'n9', label: 'Agent 加的', x: 0, y: 100 } }],
  });
  const pv = previewProposalReadonly(doc, prop);
  assert.equal(pv.ok, false);
  assert.equal(pv.code, 'stale-base');
  assert.deepEqual(pv.conflict, { baseRevision: base, currentRevision: doc.revision });
});

// 6. 并发修改冲突 -------------------------------------------------------------
check('6a Agent 建议过期后：用户内容保留，建议不落盘', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  doc = bindSession(doc, 'sess-1');
  const base = doc.revision;
  const prop = createProposal({
    documentId: 'doc-demo', baseRevision: base, sessionId: 'sess-1',
    ops: [{ opId: 'a1', type: 'node.update', baseRevision: base, params: { id: 'n2', label: 'Agent 版本' } }],
  });
  // 用户在建议生成后先改了同一个节点
  doc = applyUserOperation(doc, userOp('u1', 'node.update', doc.revision, { id: 'n2', label: '我的版本' })).doc;
  const st = createEditorState();
  const r = acceptProposal(doc, st, prop, { expectedRevision: doc.revision });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'stale-base');
  assert.equal(doc.graph.nodes.find((n) => n.id === 'n2').label, '我的版本');
  // 建议仍在，可提示 Agent 重新生成
  assert.equal(typeof prop.proposalId, 'string');
});

// 7. 修改失败原状态保留 -------------------------------------------------------
check('7a 批次中途失败：整批不生效', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const before = serialize(doc);
  const beforeNodes = doc.graph.nodes.length;
  const r = applyOperations(doc, [
    userOp('g1', 'node.add', doc.revision, { id: 'n8', label: '会成功', x: 0, y: 100 }),
    userOp('g2', 'edge.add', doc.revision, { id: 'e9', from: 'n8', to: 'ghost' }), // 悬空引用
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'missing');
  assert.equal(serialize(doc), before);
  assert.equal(doc.graph.nodes.length, beforeNodes);
  assert.equal(doc.graph.nodes.some((n) => n.id === 'n8'), false);
});

// 8. Agent 建议接受与拒绝 -----------------------------------------------------
check('8a 预览给出可解释差异，接受后原子应用', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  doc = bindSession(doc, 'sess-1');
  const base = doc.revision;
  const prop = createProposal({
    documentId: 'doc-demo', baseRevision: base, sessionId: 'sess-1',
    rationale: '补充缓存层',
    ops: [
      { opId: 'a1', type: 'node.add', baseRevision: base, params: { id: 'n4', label: '缓存层', x: 200, y: 120 } },
      { opId: 'a2', type: 'edge.add', baseRevision: base, params: { id: 'e4', from: 'n2', to: 'n4' } },
    ],
  });
  const pv = previewProposalReadonly(doc, prop);
  assert.equal(pv.ok, true);
  assert.equal(pv.preview.diff.length, 2);
  assert.match(pv.preview.diff[0].summary, /新增节点 n4「缓存层」/);
  assert.equal(pv.preview.resultingRevision, base + 1);
  assert.equal(pv.preview.nodeCount, 4);
  // 预览是只读的
  assert.equal(doc.graph.nodes.length, 3);

  const acc = acceptProposal(doc, createEditorState(), prop, { expectedRevision: doc.revision });
  assert.equal(acc.ok, true);
  doc = acc.doc;
  assert.equal(doc.revision, base + 1);
  assert.equal(doc.graph.nodes.length, 4);
  assert.equal(doc.graph.edges.length, 3);
});

check('8b 拒绝建议不改变任何状态', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-demo' });
  bindSession(doc, 'sess-1'); // 拒绝路径不依赖绑定状态，这里只构造建议
  const prop = createProposal({
    documentId: 'doc-demo', baseRevision: doc.revision, sessionId: 'sess-1',
    ops: [{ opId: 'a1', type: 'node.add', baseRevision: doc.revision, params: { id: 'n4', label: 'X', x: 0, y: 0 } }],
  });
  const before = serialize(doc);
  const r = rejectProposal(doc, prop);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'rejected');
  assert.equal(serialize(doc), before);
});

// 9. 撤销、重做边界 -----------------------------------------------------------
check('9a 撤销一次已接受的建议修改', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  doc = bindSession(doc, 'sess-1');
  const st = createEditorState();
  const base = doc.revision;
  const prop = createProposal({
    documentId: 'doc-demo', baseRevision: base, sessionId: 'sess-1',
    ops: [
      { opId: 'a1', type: 'node.add', baseRevision: base, params: { id: 'n4', label: '缓存层', x: 200, y: 120 } },
      { opId: 'a2', type: 'edge.add', baseRevision: base, params: { id: 'e4', from: 'n2', to: 'n4' } },
    ],
  });
  doc = acceptProposal(doc, st, prop, { expectedRevision: doc.revision }).doc;
  const afterAccept = serialize(doc);
  const u = undo(doc, st);
  assert.equal(u.ok, true);
  doc = u.doc;
  assert.equal(doc.graph.nodes.length, 3);
  assert.equal(doc.graph.edges.length, 2);
  const r = redo(doc, st);
  assert.equal(r.ok, true);
  doc = r.doc;
  assert.equal(doc.graph.nodes.length, 4);
  assert.equal(doc.graph.edges.length, 3);
  // 重做结果与接受后图内容一致（revision 会随撤销/重做继续前进，不参与比较）
  assert.deepEqual(JSON.parse(serialize(doc)).graph, JSON.parse(afterAccept).graph);
});

check('9b 空栈撤销 / 重做报错且文档不变', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const st = createEditorState();
  const before = serialize(doc);
  assert.equal(undo(doc, st).code, 'undo-empty');
  assert.equal(redo(doc, st).code, 'redo-empty');
  assert.equal(serialize(doc), before);
});

check('9c 新编辑清空重做栈', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const st = createEditorState();
  doc = commitOperations(doc, st, [userOp('u1', 'node.update', doc.revision, { id: 'n1', label: 'A' })]).doc;
  doc = undo(doc, st).doc;
  assert.equal(st.redoStack.length, 1);
  doc = commitOperations(doc, st, [userOp('u2', 'node.update', doc.revision, { id: 'n1', label: 'B' })]).doc;
  assert.equal(st.redoStack.length, 0);
  const r = redo(doc, st);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'redo-empty');
});

// 10. 超大数据及非法引用限制 --------------------------------------------------
check('10a 节点数超限被拒绝', () => {
  let doc = createDocument({ documentId: 'doc-big' });
  const ops = [];
  for (let i = 0; i < LIMITS.maxNodes; i += 1) {
    ops.push(userOp(`bn${i}`, 'node.add', 1, { id: `n${i}`, label: `N${i}`, x: 0, y: 0 }));
  }
  const r = applyOperations(doc, ops);
  assert.equal(r.ok, true);
  doc = r.doc;
  const overflow = applyUserOperation(doc, userOp('overflow', 'node.add', doc.revision, { id: 'nX', label: 'X', x: 0, y: 0 }));
  assert.equal(overflow.ok, false);
  assert.equal(overflow.code, 'limit');
});

check('10b 超过上限的建议被拒绝', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const ops = [];
  for (let i = 0; i <= LIMITS.opsPerProposalMax; i += 1) {
    ops.push({ opId: `m${i}`, type: 'node.update', baseRevision: doc.revision, params: { id: 'n1', label: `L${i}` } });
  }
  assert.throws(() => createProposal({ documentId: 'doc-demo', baseRevision: doc.revision, sessionId: 's', ops }), /limit/);
});

check('10c 序列化体积超限被拒绝（守卫对非法状态兜底）', () => {
  // 合法操作受 maxNodes/labelMax 约束到不了 2MiB；这里直接构造越限状态验证守卫。
  const doc = createDocument({ documentId: 'doc-fat' });
  for (let i = 0; i < 20000; i += 1) {
    doc.graph.nodes.push({ id: `n${i}`, label: 'x'.repeat(LIMITS.labelMax), x: 0, y: 0 });
  }
  assert.throws(() => serialize(doc), /too-large/);
});

// 11. 旧 owner、旧会话和旧文档操作拒绝 ----------------------------------------
check('11a 文档不匹配的建议被拒绝', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const prop = createProposal({
    documentId: 'doc-other', baseRevision: doc.revision, sessionId: 'sess-1',
    ops: [{ opId: 'a1', type: 'node.update', baseRevision: doc.revision, params: { id: 'n1', label: 'X' } }],
  });
  assert.equal(previewProposalReadonly(doc, prop).code, 'document-mismatch');
});

check('11b 未绑定会话时 Agent 建议缺 sessionId 被拒绝', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const prop = createProposal({
    documentId: 'doc-demo', baseRevision: doc.revision,
    ops: [{ opId: 'a1', type: 'node.update', baseRevision: doc.revision, params: { id: 'n1', label: 'X' } }],
  });
  assert.equal(previewProposalReadonly(doc, prop).code, 'session-mismatch');
});

check('11c 切换会话后旧会话建议被拒绝', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  doc = bindSession(doc, 'sess-1');
  const oldProp = createProposal({
    documentId: 'doc-demo', baseRevision: doc.revision, sessionId: 'sess-1',
    ops: [{ opId: 'a1', type: 'node.update', baseRevision: doc.revision, params: { id: 'n1', label: '旧会话' } }],
  });
  // 会话切换（旧会话解绑、新会话绑定）
  doc = { ...doc, boundSessionId: 'sess-2' };
  const r = previewProposalReadonly(doc, oldProp);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'session-mismatch');
  assert.match(r.detail, /旧会话 sess-1/);
});

check('11d Agent 不能伪装 user 直接执行操作', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const r = applyUserOperation(doc, { opId: 'a1', type: 'node.update', baseRevision: doc.revision, actor: 'agent', params: { id: 'n1', label: 'X' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'actor-forbidden');
});

check('11e 会话冲突绑定的 bindSession fail closed', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  doc = bindSession(doc, 'sess-1');
  assert.throws(() => bindSession(doc, 'sess-2'), /session-conflict/);
});

// 12. 可序列化、可复现 --------------------------------------------------------
check('12a serialize → deserialize → serialize 幂等', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const json = serialize(doc);
  assert.equal(serialize(deserialize(json)), json);
});

check('12b 同样操作序列在空白文档上产出同样结果', () => {
  const build = () => {
    let d = createFlowchartDocument({ documentId: 'doc-r' });
    d = applyUserOperation(d, userOp('u1', 'node.update', d.revision, { id: 'n2', label: '处理（改）' })).doc;
    d = applyUserOperation(d, userOp('u2', 'node.add', d.revision, { id: 'n4', label: '缓存', x: 10, y: 20 })).doc;
    return serialize(d);
  };
  assert.equal(build(), build());
});

check('12c 反序列化后的文档可直接继续编辑', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  doc = deserialize(serialize(doc));
  const r = applyUserOperation(doc, userOp('u1', 'node.update', doc.revision, { id: 'n1', label: '续编辑' }));
  assert.equal(r.ok, true);
});

// 13. 同批「先新增、再修改」的预览、接受、撤销、重做 ---------------------------
const graphOf = (doc) => JSON.parse(serialize(doc)).graph;

check('13a 先新增节点再修改它：预览不异常，撤销恢复原状，重做恢复结果', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  doc = bindSession(doc, 'sess-1');
  const st = createEditorState();
  const base = doc.revision;
  const original = serialize(doc);
  const prop = createProposal({
    documentId: 'doc-demo', baseRevision: base, sessionId: 'sess-1',
    ops: [
      { opId: 'a1', type: 'node.add', baseRevision: base, params: { id: 'n4', label: '缓存层', x: 200, y: 120 } },
      { opId: 'a2', type: 'node.update', baseRevision: base, params: { id: 'n4', label: '缓存层 L2', x: 260 } },
    ],
  });
  const pv = previewProposalReadonly(doc, prop); // 修复前这里抛 TypeError
  assert.equal(pv.ok, true);
  assert.match(pv.preview.diff[1].summary, /修改节点 n4：文字「缓存层」→「缓存层 L2」/);
  const acc = acceptProposal(doc, st, prop, { expectedRevision: doc.revision });
  assert.equal(acc.ok, true);
  doc = acc.doc;
  const afterAccept = serialize(doc);
  const u = undo(doc, st);
  assert.equal(u.ok, true);
  assert.deepEqual(graphOf(u.doc), graphOf(JSON.parse(original))); // 精确恢复原状
  const r = redo(u.doc, st);
  assert.equal(r.ok, true);
  assert.deepEqual(graphOf(r.doc), graphOf(JSON.parse(afterAccept))); // 精确恢复修改结果
});

check('13b 先新增无 label 连线再改 label：撤销恢复无此连线，重做恢复带 label', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  doc = bindSession(doc, 'sess-1');
  const st = createEditorState();
  const base = doc.revision;
  const original = serialize(doc);
  const prop = createProposal({
    documentId: 'doc-demo', baseRevision: base, sessionId: 'sess-1',
    ops: [
      { opId: 'a1', type: 'edge.add', baseRevision: base, params: { id: 'e4', from: 'n1', to: 'n3' } },
      { opId: 'a2', type: 'edge.update', baseRevision: base, params: { id: 'e4', label: '回执' } },
    ],
  });
  const pv = previewProposalReadonly(doc, prop); // 修复前抛 TypeError
  assert.equal(pv.ok, true);
  assert.match(pv.preview.diff[1].summary, /修改连线 e4 文字「」→「回执」/);
  const acc = acceptProposal(doc, st, prop, { expectedRevision: doc.revision });
  assert.equal(acc.ok, true);
  doc = acc.doc;
  const afterAccept = serialize(doc);
  const u = undo(doc, st);
  assert.equal(u.ok, true);
  assert.deepEqual(graphOf(u.doc), graphOf(JSON.parse(original)));
  const r = redo(u.doc, st);
  assert.equal(r.ok, true);
  assert.deepEqual(graphOf(r.doc), graphOf(JSON.parse(afterAccept)));
  assert.equal(graphOf(JSON.parse(afterAccept)).edges.find((e) => e.id === 'e4').label, '回执');
});

check('13c 既有无 label 连线两次改 label 后撤销：恢复为无 label（而非报错）', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const st = createEditorState();
  const original = serialize(doc);
  const r1 = commitOperations(doc, st, [
    userOp('u1', 'edge.update', doc.revision, { id: 'e1', label: '回执' }),
    userOp('u2', 'edge.update', doc.revision, { id: 'e1', label: '确认' }),
  ]);
  assert.equal(r1.ok, true);
  doc = r1.doc;
  const u = undo(doc, st);
  assert.equal(u.ok, true);
  const restored = graphOf(u.doc).edges.find((e) => e.id === 'e1');
  assert.equal('label' in restored, false); // 精确回到「无 label」状态
  assert.deepEqual(graphOf(u.doc), graphOf(JSON.parse(original)));
  const r = redo(u.doc, st);
  assert.equal(r.ok, true);
  assert.equal(graphOf(r.doc).edges.find((e) => e.id === 'e1').label, '确认');
});

check('13d 同批先新增连线（带 label）再改 label：撤销恢复带原 label 的连线', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const st = createEditorState();
  const original = serialize(doc);
  const r1 = commitOperations(doc, st, [
    userOp('u1', 'edge.add', doc.revision, { id: 'e4', from: 'n1', to: 'n3', label: '初审' }),
    userOp('u2', 'edge.update', doc.revision, { id: 'e4', label: '终审' }),
  ]);
  assert.equal(r1.ok, true);
  doc = r1.doc;
  const u = undo(doc, st);
  assert.equal(u.ok, true);
  assert.deepEqual(graphOf(u.doc), graphOf(JSON.parse(original)));
  const r = redo(u.doc, st);
  assert.equal(r.ok, true);
  assert.equal(graphOf(r.doc).edges.find((e) => e.id === 'e4').label, '终审');
});

// 14. 建议幂等路径不得绕过身份验证 ---------------------------------------------
function appliedProposal(doc, sessionId) {
  const bound = bindSession(doc, sessionId);
  const prop = createProposal({
    documentId: doc.documentId, baseRevision: doc.revision, sessionId,
    ops: [{ opId: 'a1', type: 'node.update', baseRevision: doc.revision, params: { id: 'n1', label: '已应用' } }],
  });
  const acc = acceptProposal(bound, createEditorState(), prop, { expectedRevision: bound.revision });
  assert.equal(acc.ok, true);
  return { doc: acc.doc, prop };
}

check('14a 伪造错误 sessionId 的重复接受被拒绝（即使 opId 已记录）', () => {
  const doc0 = createFlowchartDocument({ documentId: 'doc-demo' });
  const { doc, prop } = appliedProposal(doc0, 'sess-1');
  const before = serialize(doc);
  const forged = { ...prop, sessionId: 'sess-evil' };
  const r = acceptProposal(doc, createEditorState(), forged, { expectedRevision: doc.revision });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'session-mismatch');
  assert.equal(serialize(doc), before);
});

check('14b 不同 documentId 的重复接受被拒绝', () => {
  const doc0 = createFlowchartDocument({ documentId: 'doc-demo' });
  const { doc, prop } = appliedProposal(doc0, 'sess-1');
  const forged = { ...prop, documentId: 'doc-other' };
  const r = acceptProposal(doc, createEditorState(), forged, { expectedRevision: doc.revision });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'document-mismatch');
});

check('14c 非法 schema 的建议即使 opId 已记录也被拒绝', () => {
  const doc0 = createFlowchartDocument({ documentId: 'doc-demo' });
  const { doc, prop } = appliedProposal(doc0, 'sess-1');
  const malformed = { ...prop, ops: 'not-an-array' };
  const r = acceptProposal(doc, createEditorState(), malformed, { expectedRevision: doc.revision });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'schema');
});

check('14d 同会话、同文档、同内容的重复接受仍幂等成功', () => {
  const doc0 = createFlowchartDocument({ documentId: 'doc-demo' });
  const { doc, prop } = appliedProposal(doc0, 'sess-1');
  const before = serialize(doc);
  const r = acceptProposal(doc, createEditorState(), prop, { expectedRevision: doc.revision });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'duplicate');
  assert.equal(serialize(doc), before);
});

// 15. 反序列化上限 ------------------------------------------------------------
check('15a 节点数超限的反序列化被拒绝', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const json = JSON.parse(serialize(doc));
  json.graph.nodes.push({ id: 'nX', label: 'X', x: 0, y: 0 });
  json.graph.nodes.length = LIMITS.maxNodes + 1;
  assert.throws(() => deserialize(JSON.stringify(json)), /limit/);
});

check('15b 连线数超限的反序列化被拒绝', () => {
  const doc = createDocument({ documentId: 'doc-many' });
  const nodes = [];
  for (let i = 0; i < LIMITS.maxNodes; i += 1) nodes.push({ id: `n${i}`, label: `N${i}`, x: 0, y: 0 });
  const edges = [];
  for (let i = 0; i < LIMITS.maxNodes && edges.length < LIMITS.maxEdges + 1; i += 1) {
    for (let j = 0; j < LIMITS.maxNodes && edges.length < LIMITS.maxEdges + 1; j += 1) {
      if (i === j) continue;
      edges.push({ id: `e${i}_${j}`, from: `n${i}`, to: `n${j}` });
    }
  }
  const json = { documentId: 'doc-many', schemaVersion: 1, revision: 1, title: '', boundSessionId: null, graph: { nodes, edges } };
  assert.throws(() => deserialize(JSON.stringify(json)), /limit/);
});

check('15c 连线 ID 重复与同向重复连线的反序列化被拒绝', () => {
  const doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const json = JSON.parse(serialize(doc));
  json.graph.edges.push({ id: 'e1', from: 'n1', to: 'n3' });
  assert.throws(() => deserialize(JSON.stringify(json)), /schema/); // CollabError.message 只含错误码
  const json2 = JSON.parse(serialize(doc));
  json2.graph.edges.push({ id: 'e9', from: 'n1', to: 'n2' }); // 与 e1 同向
  assert.throws(() => deserialize(JSON.stringify(json2)), /duplicate-edge/);
});

check('15d 超大输入的反序列化被拒绝', () => {
  const fat = `{"pad":"${'x'.repeat(LIMITS.serializedMaxBytes)}"}`;
  assert.throws(() => deserialize(fat), /too-large/);
});

check('15e 合法文档（含 label 与边界规模）序列化-反序列化兼容', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-round' });
  doc = applyUserOperation(doc, userOp('u1', 'edge.update', doc.revision, { id: 'e1', label: '回执' })).doc;
  const json = serialize(doc);
  assert.equal(serialize(deserialize(json)), json);
});

// 16. 指纹与键序无关 ----------------------------------------------------------
check('16 同语义但键序不同的操作视为同一操作（duplicate，而非 reuse）', () => {
  let doc = createFlowchartDocument({ documentId: 'doc-demo' });
  const base = doc.revision; // 重放 = 字节级重发：baseRevision 也必须一致
  const op1 = { opId: 'k1', type: 'node.update', baseRevision: base, actor: 'user', params: { id: 'n1', label: '新' } };
  doc = applyUserOperation(doc, op1).doc;
  const before = serialize(doc);
  const op2 = { actor: 'user', baseRevision: base, type: 'node.update', opId: 'k1', params: { label: '新', id: 'n1' } };
  const r = applyUserOperation(doc, op2);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'duplicate');
  assert.equal(serialize(doc), before);
});

// ----------------------------------------------------------------------------
console.log(`\nZ4-1 原型数据层测试：${passed} 通过，${failed} 失败（共 ${passed + failed} 项）`);
if (failed > 0) process.exit(1);
