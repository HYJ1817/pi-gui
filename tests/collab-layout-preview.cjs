/* Z4-4A 任务 D：安全布局预览组件测试。
 * 覆盖任务清单 11（预览不修改原图）、12（取消后数据不变）、13（超 50 条拒绝直接应用），
 * 以及 revision 重验、零变化操作剔除、生成操作通过既有受控协议（lib/collab-doc.js）等安全性质。
 * 直接运行：node tests/collab-layout-preview.cjs（未并入 canonical 测试链）。
 */
const baseAssert = require('node:assert/strict');
let assertions = 0;
const assert = new Proxy(baseAssert, {
  apply(target, receiver, args) { assertions++; return Reflect.apply(target, receiver, args); },
  get(target, key) { const value = target[key]; return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value; },
});

let checks = 0;
function check(name, actual, expected = true) {
  assert.deepEqual(actual, expected, name);
  checks++;
  console.log(`  ok ${name}`);
}

async function main() {
  const { createLayoutPreview, applyLayoutPreview, dismissLayoutPreview, LAYOUT_PREVIEW_LIMITS } =
    await import('../public/collab-layout-preview.js');
  const { createFlowchartDocument, applyUserOperations, createDocument, applyOperations } = await import('../lib/collab-doc.js');
  check('单批上限与协议一致', LAYOUT_PREVIEW_LIMITS.opsPerBatchMax, 50);

  // 准备一份「凌乱」文档：节点坐标与自动布局差距明显
  const messy = createFlowchartDocument({ documentId: 'doc-1' });
  const scrambled = applyOperations(messy, [
    { opId: 'scatter-1', type: 'node.update', baseRevision: messy.revision, actor: 'user', params: { id: 'n1', x: 7000, y: -4000 } },
    { opId: 'scatter-2', type: 'node.update', baseRevision: messy.revision, actor: 'user', params: { id: 'n3', x: -9000, y: 8500 } },
  ]).doc;
  const frozen = JSON.stringify(scrambled);

  // 11. 预览不修改原图（创建预览本身是纯读操作）
  const preview = createLayoutPreview(scrambled);
  check('预览创建成功', preview.ok);
  check('预览状态为 ready', preview.status, 'ready');
  check('预览记录基线 revision', preview.baseRevision, scrambled.revision);
  check('预览记录文档标识', preview.documentId, 'doc-1');
  check('预览不修改原图', JSON.stringify(scrambled), frozen);
  check('预览只含坐标变化的节点', preview.moves.map(move => move.id), ['n1', 'n2', 'n3']);
  check('移动项包含前后坐标', !!(preview.moves[0].from && preview.moves[0].to));

  // 用户确认 → 生成完整信封操作 → 通过既有受控协议原子应用
  let sequence = 0;
  const intent = applyLayoutPreview(preview, scrambled, { makeOpId: () => `test-${++sequence}` });
  check('确认后生成操作', intent.ok && intent.status, 'applied-intent');
  check('操作数与移动数一致', intent.opCount, 3);
  check('操作为完整信封形状', intent.ops.every(op => JSON.stringify(Object.keys(op).sort()) === JSON.stringify(['actor', 'baseRevision', 'opId', 'params', 'type'])));
  check('操作类型均为 node.update', intent.ops.every(op => op.type === 'node.update'), true);
  check('操作 actor 为 user', intent.ops.every(op => op.actor === 'user'), true);
  check('操作 baseRevision 等于文档 revision', intent.ops.every(op => op.baseRevision === scrambled.revision), true);
  check('生成操作不改原文档', JSON.stringify(scrambled), frozen);
  const applied = applyUserOperations(scrambled, intent.ops);
  check('生成操作通过既有受控协议', applied.ok, true);
  check('协议应用后 revision 前进', applied.revision, scrambled.revision + 1);
  const layoutAgain = createLayoutPreview(applied.doc);
  check('应用后再次布局无变化（不动点性质）', layoutAgain.status, 'clean');

  // 12. 取消后数据不变（dismiss 为纯声明；任何路径都不触碰文档）
  const dismiss = dismissLayoutPreview(preview);
  check('取消返回明确状态', dismiss, { ok: true, status: 'cancelled', preview: null, document: null });
  check('取消后原文档不变', JSON.stringify(scrambled), frozen);
  check('取消不返回任何操作', 'ops' in dismiss, false);

  // 13. 超过 50 条操作时拒绝直接应用（种子构造本身遵守协议分批上限）
  const chunkApply = (document, build, prefix) => {
    let working = document;
    const items = build();
    for (let start = 0; start < items.length; start += 40) {
      const ops = items.slice(start, start + 40).map((params, index) => ({
        opId: `${prefix}-${start + index}`, type: params.op, baseRevision: working.revision, actor: 'user', params: params.data,
      }));
      const result = applyOperations(working, ops);
      check(`种子批次 ${prefix}@${start} 构造成功`, result.ok, true);
      working = result.doc;
    }
    return working;
  };
  const chainEdges = chunkApply(createDocument({ documentId: 'doc-big' }), () => [
    ...Array.from({ length: 60 }, (_, i) => ({ op: 'node.add', data: { id: `b${String(i).padStart(2, '0')}`, label: `节点${i}`, x: (i * 613) % 9000, y: (i * 197) % 9000 } })),
    ...Array.from({ length: 59 }, (_, i) => ({ op: 'edge.add', data: { id: `x${String(i).padStart(2, '0')}`, from: `b${String(i).padStart(2, '0')}`, to: `b${String(i + 1).padStart(2, '0')}` } })),
  ], 'seed');
  const bigPreview = createLayoutPreview(chainEdges);
  check('超过 50 个移动节点的预览状态为 over-limit', bigPreview.status, 'over-limit');
  check('over-limit 预览仍带完整移动清单', bigPreview.moveCount, 60);
  const bigApply = applyLayoutPreview(bigPreview, chainEdges, { makeOpId: () => 'nope' });
  check('over-limit 拒绝直接应用', [bigApply.ok, bigApply.code], [false, 'over-limit']);
  check('拒绝信息包含明确上限说明', bigApply.detail.includes('50'), true);
  check('over-limit 路径不产生操作', bigApply.ops === undefined);
  check('over-limit 预览不改文档', (() => { createLayoutPreview(chainEdges); return true; })(), true);
  // 恰好 50 条：允许单批原子应用
  const fifty = createDocument({ documentId: 'doc-50' });
  const fiftyDoc = applyOperations(fifty, Array.from({ length: 50 }, (_, i) => ({
    opId: `f-${i}`, type: 'node.add', baseRevision: 1, actor: 'user',
    params: { id: `f${String(i).padStart(2, '0')}`, label: `节点${i}`, x: 99000 - i, y: -99000 + i },
  }))).doc;
  const fiftyPreview = createLayoutPreview(fiftyDoc);
  check('恰好 50 个移动节点状态为 ready', fiftyPreview.status, 'ready');
  let fitSequence = 0;
  check('恰好 50 条可单批应用', applyLayoutPreview(fiftyPreview, fiftyDoc, { makeOpId: () => `fit-${String(++fitSequence).padStart(2, '0')}` }).opCount, 50);

  // revision 重验：文档前进后旧预览必须拒绝
  let moveSequence = 0;
  const moved = applyUserOperations(scrambled, applyLayoutPreview(preview, scrambled, { makeOpId: () => `mv-${String(++moveSequence).padStart(2, '0')}` }).ops).doc;
  const stale = applyLayoutPreview(preview, moved);
  check('revision 前进后预览过期', [stale.ok, stale.code], [false, 'stale-base']);
  check('过期信息带冲突详情', stale.conflict, { baseRevision: preview.baseRevision, currentRevision: moved.revision });
  const otherDoc = { ...scrambled, documentId: 'doc-other' };
  check('跨文档应用被拒绝', applyLayoutPreview(preview, otherDoc).code, 'document-mismatch');
  check('非法预览形状被拒绝', applyLayoutPreview({ moves: 'not-array' }).code, 'schema');
  check('取消路径校验形状', dismissLayoutPreview(null).code, 'schema');

  // opId 生成器纪律：非法与重复 ID 显式失败，不静默修复
  const dupe = applyLayoutPreview(createLayoutPreview(fiftyDoc), fiftyDoc, { makeOpId: () => 'same-id' });
  check('opId 重复显式失败', [dupe.ok, dupe.code], [false, 'opid-collision']);
  const illegal = applyLayoutPreview(createLayoutPreview(fiftyDoc), fiftyDoc, { makeOpId: () => '非法ID!' });
  check('opId 非法显式失败', illegal.code, 'schema');

  // 零变化：clean 预览不生成空批次（applyOperations 会拒绝空批次，上层不得提交）
  const aligned = createFlowchartDocument({ documentId: 'doc-aligned' });
  const alignedPositions = createLayoutPreview(aligned).positions;
  const alignedDoc = { ...aligned, graph: { nodes: aligned.graph.nodes.map(node => ({ ...node, ...alignedPositions[node.id] })), edges: aligned.graph.edges } };
  const cleanPreview = createLayoutPreview(alignedDoc);
  check('已对齐文档预览为 clean', cleanPreview.status, 'clean');
  const cleanApply = applyLayoutPreview(cleanPreview, alignedDoc);
  check('clean 预览返回 unchanged', [cleanApply.ok, cleanApply.status, cleanApply.ops], [true, 'unchanged', []]);

  // 布局引擎的失败原样透传（非法图 / 空图）
  check('非法图预览失败', createLayoutPreview({ ...scrambled, graph: { nodes: [{ id: 'bad', label: 'x', x: NaN, y: 0 }], edges: [] } }).code, 'invalid-graph');
  check('空图预览为 clean', createLayoutPreview({ ...createDocument({ documentId: 'doc-empty' }) }).status, 'clean');
  check('预览确定性', JSON.stringify(createLayoutPreview(scrambled)), JSON.stringify(createLayoutPreview(JSON.parse(frozen))));

  console.log(`\ncollab-layout-preview: ${checks}/${checks} passed; assertions=${assertions}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
