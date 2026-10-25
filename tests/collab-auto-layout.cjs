/* Z4-4A 任务 D：自动布局引擎组件测试。
 * 覆盖任务清单 1-10、14（坐标边界）、17（非法图结构）的布局侧，
 * 以及确定性、输入不可变、不重叠、规模性能等性质。
 * 直接运行：node tests/collab-auto-layout.cjs（未并入 canonical 测试链）。
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

const NODE_W = 156, NODE_H = 64;
const doc = (nodes, edges, extra = {}) => ({
  documentId: 'doc-1', schemaVersion: 1, revision: 2, title: '流程图', boundSessionId: 'session-1',
  graph: { nodes, edges }, appliedOps: [], ...extra,
});
const n = (id, label = '节点', x = 0, y = 0) => ({ id, label, x, y });
const e = (id, from, to, label) => (label === undefined ? { id, from, to } : { id, from, to, label });

/** 两节点不重叠：主副轴间距不能同时小于节点尺寸。 */
function noOverlap(positions) {
  const entries = Object.entries(positions);
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    if (Math.abs(entries[i][1].x - entries[j][1].x) < NODE_W && Math.abs(entries[i][1].y - entries[j][1].y) < NODE_H) {
      return `${entries[i][0]} 与 ${entries[j][0]} 重叠`;
    }
  }
  return true;
}

async function main() {
  const { computeAutoLayout, AUTO_LAYOUT_DEFAULTS } = await import('../public/collab-auto-layout.js');
  check('默认方向从左到右', AUTO_LAYOUT_DEFAULTS.direction, 'LR');

  // 1. 三节点直线流程
  const line = computeAutoLayout(doc([n('n1', '开始'), n('n2', '处理', 40, 500), n('n3', '结束', -300, 900)],
    [e('e1', 'n1', 'n2'), e('e2', 'n2', 'n3')]));
  check('直线布局成功', line.ok);
  check('直线沿 x 轴前进', line.positions.n2.x > line.positions.n1.x && line.positions.n3.x > line.positions.n2.x);
  check('直线同层共线', line.positions.n1.y === line.positions.n2.y && line.positions.n2.y === line.positions.n3.y);
  check('直线层数为 3', line.stats.layers, 3);
  check('直线零交叉', line.stats.crossings, 0);

  // 2. 多分支流程（一对多）
  const branch = computeAutoLayout(doc(
    [n('s', '开始'), n('a', '分支甲'), n('b', '分支乙'), n('c', '分支丙')],
    [e('ea', 's', 'a'), e('eb', 's', 'b'), e('ec', 's', 'c')]));
  check('分支布局成功', branch.ok);
  check('分支源在最左', Math.min(branch.positions.s.x, branch.positions.a.x, branch.positions.b.x, branch.positions.c.x), branch.positions.s.x);
  check('分支不重叠', noOverlap(branch.positions));
  check('分支同层并列', new Set([branch.positions.a.x, branch.positions.b.x, branch.positions.c.x]).size, 1);

  // 3. 多分支汇合（菱形）
  const diamond = computeAutoLayout(doc(
    [n('s', '开始'), n('u', '上面'), n('d', '下面'), n('t', '汇合')],
    [e('e1', 's', 'u'), e('e2', 's', 'd'), e('e3', 'u', 't'), e('e4', 'd', 't')]));
  check('菱形布局成功', diamond.ok);
  check('菱形汇合在源右侧', diamond.positions.t.x > diamond.positions.s.x);
  check('菱形不重叠', noOverlap(diamond.positions));
  check('菱形零交叉', diamond.stats.crossings, 0);

  // 4. 环路：不无限循环、去环后仍沿主轴前进
  const cycle = computeAutoLayout(doc(
    [n('a', '甲'), n('b', '乙'), n('c', '丙')],
    [e('e1', 'a', 'b'), e('e2', 'b', 'c'), e('e3', 'c', 'a')]));
  check('环路布局成功（不无限循环）', cycle.ok);
  check('环路坐标完整', Object.keys(cycle.positions).length, 3);
  check('环路不重叠', noOverlap(cycle.positions));
  const bigCycle = computeAutoLayout(doc(
    Array.from({ length: 30 }, (_, i) => n(`c${String(i).padStart(2, '0')}`)),
    Array.from({ length: 30 }, (_, i) => e(`x${String(i).padStart(2, '0')}`, `c${String(i).padStart(2, '0')}`, `c${String((i + 1) % 30).padStart(2, '0')}`))));
  check('30 节点全环布局成功', bigCycle.ok);

  // 5. 孤立节点（与有边图共存）
  const orphan = computeAutoLayout(doc(
    [n('a', '甲'), n('b', '乙'), n('alone', '孤立')],
    [e('e1', 'a', 'b')]));
  check('孤立节点获得坐标', orphan.ok && orphan.positions.alone !== undefined);
  check('孤立节点不与链重叠', noOverlap(orphan.positions));
  check('独立分量数', orphan.stats.components, 2);

  // 6. 无连线
  const loose = computeAutoLayout(doc([n('a'), n('b'), n('c'), n('d'), n('f'), n('g')], []));
  check('无连线布局成功', loose.ok);
  check('无连线不重叠', noOverlap(loose.positions));
  check('无连线分量数等于节点数', loose.stats.components, 6);
  const loose15 = computeAutoLayout(doc(Array.from({ length: 15 }, (_, i) => n(`z${String(i).padStart(2, '0')}`)), []));
  check('15 孤立节点换列打包不重叠', noOverlap(loose15.positions));

  // 7. 空图
  const empty = computeAutoLayout(doc([], []));
  check('空图返回空坐标', empty, { ok: true, positions: {}, stats: { direction: 'LR', nodeCount: 0, edgeCount: 0, layers: 0, components: 0, crossings: 0 } });

  // 8. 大量节点（200 节点，随机状连线）+ 性能背板（防回归成死循环；阈值宽松以容忍繁忙机器）
  const denseNodes = Array.from({ length: 200 }, (_, i) => n(`n${String(i).padStart(3, '0')}`, `节点${i}`, (i * 613) % 9000, (i * 197) % 9000));
  const denseEdges = [];
  for (let i = 1; i < 200; i++) {
    const from = (i * 31 + 7) % i; // 确定性伪随机 DAG：只连向更小下标
    if (from !== i) denseEdges.push(e(`e${String(i).padStart(3, '0')}`, `n${String(from).padStart(3, '0')}`, `n${String(i).padStart(3, '0')}`));
  }
  const dense = doc(denseNodes, denseEdges);
  const started = Date.now();
  const denseResult = computeAutoLayout(dense);
  const elapsed = Date.now() - started;
  check('200 节点布局成功', denseResult.ok);
  check('200 节点坐标齐全', Object.keys(denseResult.positions).length, 200);
  check('200 节点不重叠', noOverlap(denseResult.positions));
  check(`200 节点在 5 秒内完成（实测 ${elapsed}ms）`, elapsed < 5000);
  const chainDoc = doc(Array.from({ length: 200 }, (_, i) => n(`c${String(i).padStart(3, '0')}`)),
    Array.from({ length: 199 }, (_, i) => e(`x${String(i).padStart(3, '0')}`, `c${String(i).padStart(3, '0')}`, `c${String(i + 1).padStart(3, '0')}`)));
  const chain = computeAutoLayout(chainDoc);
  check('200 节点最长链不越界', chain.ok && Object.values(chain.positions).every(p => Math.abs(p.x) <= 100000 && Math.abs(p.y) <= 100000));
  const extreme = computeAutoLayout(chainDoc, { layerGap: 200, nodeGap: 200 });
  check('极限间距选项仍在协议边界内', extreme.ok && Object.values(extreme.positions).every(p => p.x >= 0 && p.x <= 100000 && p.y >= 0 && p.y <= 100000));

  // 9. 重复运行布局结果一致（含图结构乱序输入）
  const again = computeAutoLayout(dense);
  check('同样输入重复运行结果一致', JSON.stringify(again), JSON.stringify(denseResult));
  const shuffled = doc([...denseNodes].reverse(), [...denseEdges].reverse());
  const fromShuffled = computeAutoLayout(shuffled);
  check('节点/连线输入顺序不影响结果', JSON.stringify(fromShuffled), JSON.stringify(denseResult));
  check('TB 方向确定性', JSON.stringify(computeAutoLayout(dense, { direction: 'TB' })), JSON.stringify(computeAutoLayout(shuffled, { direction: 'TB' })));

  // 10. 节点与连线数据不变（输入文档深比较）
  const before = JSON.stringify(dense);
  computeAutoLayout(dense);
  computeAutoLayout(dense, { direction: 'TB' });
  check('布局不修改输入文档', JSON.stringify(dense), before);

  // 14. 坐标边界：整数、界内、不重叠、沿主轴单调
  const boundary = computeAutoLayout(dense, { direction: 'LR' });
  check('坐标全部为整数', Object.values(boundary.positions).every(p => Number.isSafeInteger(p.x) && Number.isSafeInteger(p.y)));
  check('坐标全部在 ±100000 内', Object.values(boundary.positions).every(p => Math.abs(p.x) <= 100000 && Math.abs(p.y) <= 100000));
  check('LR 方向无倒退边', denseEdges.every(edge => boundary.positions[edge.to].x > boundary.positions[edge.from].x));
  const vertical = computeAutoLayout(dense, { direction: 'TB' });
  check('TB 方向沿 y 轴前进', denseEdges.every(edge => vertical.positions[edge.to].y > vertical.positions[edge.from].y));

  // 17. 非法图结构（布局侧）
  check('引用不存在节点的边被拒绝', computeAutoLayout(doc([n('a')], [e('e1', 'a', 'ghost')])).code, 'invalid-graph');
  check('自环被拒绝', computeAutoLayout(doc([n('a')], [e('e1', 'a', 'a')])).code, 'invalid-graph');
  check('重复节点 ID 被拒绝', computeAutoLayout(doc([n('a'), n('a')], [])).code, 'invalid-graph');
  check('同向重复边被拒绝', computeAutoLayout(doc([n('a'), n('b')], [e('e1', 'a', 'b'), e('e2', 'a', 'b')])).code, 'invalid-graph');
  check('空白标签被拒绝', computeAutoLayout(doc([n('a', '   ')], [])).code, 'invalid-graph');
  check('越界坐标节点被拒绝', computeAutoLayout(doc([n('a', '甲', 100001, 0)], [])).code, 'invalid-graph');
  check('超过 200 节点被拒绝', computeAutoLayout(doc(Array.from({ length: 201 }, (_, i) => n(`n${i}`)), [])).code, 'invalid-graph');
  check('schemaVersion 错误被拒绝', computeAutoLayout(doc([n('a')], [], { schemaVersion: 2 })).code, 'invalid-graph');
  check('空文档对象被拒绝', computeAutoLayout(null).code, 'invalid-graph');
  check('未知方向回落到 LR', computeAutoLayout(doc([n('a')], []), { direction: 'DIAGONAL' }).stats.direction, 'LR');

  // 长中文标签：不影响合法性（标签只透传，坐标与标签内容无关）
  const chinese = computeAutoLayout(doc([n('a', '中文长标签'.repeat(28)), n('b', '结束')], [e('e1', 'a', 'b')]));
  check('长中文标签布局成功', chinese.ok);

  console.log(`\ncollab-auto-layout: ${checks}/${checks} passed; assertions=${assertions}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
