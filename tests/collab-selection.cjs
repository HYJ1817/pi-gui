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
  const { createSelection, hitTestRect } = await import('../public/collab-selection.js');

  // 1. 初始化
  const sel = createSelection();
  check('init empty count', sel.count(), 0);
  check('init nodeCount', sel.nodeCount(), 0);
  check('init edgeCount', sel.edgeCount(), 0);
  check('init describe', sel.describe(), '');
  check('init primary', sel.primary(), null);

  // 2. 单选
  sel.selectOne('node', 'n1');
  check('single select count', sel.count(), 1);
  check('has n1', sel.has('node', 'n1'), true);
  check('has n2 false', sel.has('node', 'n2'), false);
  check('nodeIds', sel.nodeIds(), ['n1']);
  check('primary is n1', sel.primary(), { kind: 'node', id: 'n1' });
  check('describe single', sel.describe(), '已选择 1 个节点');

  // 3. 再次单选替换旧选择
  sel.selectOne('node', 'n2');
  check('selectOne replaces count', sel.count(), 1);
  check('has n1 false after replace', sel.has('node', 'n1'), false);
  check('has n2 true after replace', sel.has('node', 'n2'), true);

  // 4. Ctrl+点击切换 (toggle)
  sel.toggle('node', 'n1');
  check('toggle add n1 count', sel.count(), 2);
  check('has n1 and n2', [sel.has('node', 'n1'), sel.has('node', 'n2')], [true, true]);
  check('describe 2 nodes', sel.describe(), '已选择 2 个节点');

  sel.toggle('node', 'n2');
  check('toggle remove n2 count', sel.count(), 1);
  check('has n2 false', sel.has('node', 'n2'), false);

  // 5. 混合节点与连线
  sel.add('node', 'n2');
  sel.add('edge', 'e1');
  check('mixed count', sel.count(), 3);
  check('nodeCount 2', sel.nodeCount(), 2);
  check('edgeCount 1', sel.edgeCount(), 1);
  check('edgeIds', sel.edgeIds(), ['e1']);
  check('describe mixed', sel.describe(), '已选择 2 个节点、1 条连线');

  // 6. 全选节点
  const graph = {
    nodes: [{ id: 'n1', x: 0, y: 0 }, { id: 'n2', x: 100, y: 50 }, { id: 'n3', x: 200, y: 100 }],
    edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
  };
  sel.clear();
  sel.selectAllNodes(graph);
  check('selectAllNodes count', sel.count(), 3);
  check('selectAllNodes nodeIds', sel.nodeIds().sort(), ['n1', 'n2', 'n3']);

  // 7. Revision 更新修剪 (prune)
  // 假设外部删除了 n2，保留 n1, n3
  const nextGraph = {
    nodes: [{ id: 'n1', x: 0, y: 0 }, { id: 'n3', x: 200, y: 100 }],
    edges: [],
  };
  const pruned = sel.prune(nextGraph);
  check('prune reported change', pruned, true);
  check('prune count 2', sel.count(), 2);
  check('has n2 false after prune', sel.has('node', 'n2'), false);
  check('has n1 and n3 true', [sel.has('node', 'n1'), sel.has('node', 'n3')], [true, true]);

  // 再次修剪无变化
  check('prune with same graph returns false', sel.prune(nextGraph), false);

  // 8. 框选碰撞检测 (hitTestRect)
  // n1 at (0, 0, 156, 64)
  // n2 at (200, 0, 156, 64)
  // n3 at (400, 100, 156, 64)
  const g2 = {
    nodes: [
      { id: 'n1', x: 0, y: 0 },
      { id: 'n2', x: 200, y: 0 },
      { id: 'n3', x: 400, y: 100 },
    ],
  };

  // 选框覆盖 n1 和 n2
  const hits1 = hitTestRect(g2, { x: -10, y: -10, width: 300, height: 100 });
  check('hitTestRect hits n1 and n2', hits1.sort(), ['n1', 'n2']);

  // 反向拖动的选框 (width < 0, height < 0)
  const hitsReverse = hitTestRect(g2, { x: 290, y: 90, width: -300, height: -100 });
  check('hitTestRect reverse drag', hitsReverse.sort(), ['n1', 'n2']);

  // 空白区域未命中任何节点
  const hitsEmpty = hitTestRect(g2, { x: 600, y: 600, width: 100, height: 100 });
  check('hitTestRect empty', hitsEmpty, []);

  // 9. 清空
  check('clear returns true when items existed', sel.clear(), true);
  check('clear returns false when already empty', sel.clear(), false);
  check('count after clear', sel.count(), 0);

  console.log(`\ncollab-selection: ${checks}/${checks} passed; assertions=${assertions}`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
