const baseAssert = require('node:assert/strict');
let assertions = 0;
const assert = new Proxy(baseAssert, {
  apply(target, receiver, args) { assertions++; return Reflect.apply(target, receiver, args); },
  get(target, key) { const value = target[key]; return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value; },
});
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

let checks = 0;
function check(name, actual, expected = true) {
  assert.deepEqual(actual, expected, name);
  checks++;
  console.log(`  ok ${name}`);
}

const fixture = () => ({
  documentId: 'doc-test', schemaVersion: 1, revision: 1, title: '测试流程图', boundSessionId: 'sess-1', appliedOps: [],
  graph: {
    nodes: [
      { id: 'n1', label: '节点1', x: 10, y: 20 },
      { id: 'n2', label: '节点2', x: 200, y: 100 },
      { id: 'n3', label: '节点3', x: 400, y: 50 },
      { id: 'n4', label: '节点4', x: 100, y: 300 },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2', label: '流转1' },
      { id: 'e2', from: 'n2', to: 'n3' },
      { id: 'e3', from: 'n3', to: 'n4' },
    ],
  },
});

async function main() {
  const { mountCollabCanvas } = await import('../public/collab-canvas.js');
  const dom = new JSDOM('<main><div id="canvas"></div></main>');
  const win = dom.window;
  const style = win.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../public/tokens.css'), 'utf8') + '\n' +
                      fs.readFileSync(path.join(__dirname, '../public/collab.css'), 'utf8');
  win.document.head.append(style);
  const host = win.document.querySelector('#canvas');

  const q = selector => host.querySelector(selector);
  const qAll = selector => [...host.querySelectorAll(selector)];
  const button = name => qAll('button').find(el => el.textContent === name);
  const fire = (el, type, init = {}) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  const key = (el, value, init = {}) => el.dispatchEvent(new win.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init }));

  const calls = [];
  let doc = fixture();
  const canvas = mountCollabCanvas(host, {
    document: doc,
    onOperations: ops => calls.push(ops),
  });

  // =========================================================================
  // 任务 A：多选系统
  // =========================================================================

  // A1. 单选普通点击
  fire(q('[data-node-id="n1"]'), 'click');
  check('A1: 单选 n1', q('[data-node-id="n1"]').getAttribute('aria-pressed'), 'true');
  check('A1: n2 未选中', q('[data-node-id="n2"]').getAttribute('aria-pressed'), 'false');
  check('A1: 选中标签显示单选', q('.collab-selection').textContent, '节点 · n1');

  // A2. Ctrl+点击追加选择
  fire(q('[data-node-id="n2"]'), 'click', { ctrlKey: true });
  check('A2: n1 仍选中', q('[data-node-id="n1"]').getAttribute('aria-pressed'), 'true');
  check('A2: n2 现已选中', q('[data-node-id="n2"]').getAttribute('aria-pressed'), 'true');
  check('A2: 选中标签显示数量', q('.collab-selection').textContent, '已选择 2 个节点');

  // A3. Ctrl+点击取消选择其中一个
  fire(q('[data-node-id="n1"]'), 'click', { ctrlKey: true });
  check('A3: n1 已取消选中', q('[data-node-id="n1"]').getAttribute('aria-pressed'), 'false');
  check('A3: n2 仍选中', q('[data-node-id="n2"]').getAttribute('aria-pressed'), 'true');
  check('A3: 恢复单选标签', q('.collab-selection').textContent, '节点 · n2');

  // A4. 点击连线
  fire(q('[data-edge-id="e1"]'), 'click');
  check('A4: 连线选中', q('[data-edge-id="e1"]').getAttribute('aria-pressed'), 'true');
  check('A4: n2 不再选中', q('[data-node-id="n2"]').getAttribute('aria-pressed'), 'false');
  check('A4: 连线标签', q('.collab-selection').textContent, '连线 · e1');

  // A5. Ctrl+A 在画布聚焦时选择全部节点
  q('svg').focus();
  key(q('svg'), 'a', { ctrlKey: true });
  check('A5: Ctrl+A 全选 4 个节点', q('.collab-selection').textContent, '已选择 4 个节点');
  check('A5: 所有节点均 is-selected', qAll('.collab-node.is-selected').length, 4);

  // A6. 输入框中打字 Ctrl+A 不被画布劫持
  q('[name="label"]').focus();
  key(q('[name="label"]'), 'a', { ctrlKey: true });
  check('A6: 输入框内 Ctrl+A 不改变画布', q('.collab-selection').textContent, '已选择 4 个节点');

  // A7. Escape 清空选择
  key(q('svg'), 'Escape');
  check('A7: Escape 清空选择', q('.collab-selection').textContent, '选择节点或连线以编辑');
  check('A7: 无 is-selected 节点', qAll('.collab-node.is-selected').length, 0);

  // A8. Shift+拖动空白区域：框选节点
  // svg bounds mock: width 360, height 260
  // n1 (10, 20), n2 (200, 100), n4 (100, 300)
  // 框选 (0, 0) 到 (250, 150) -> 应命中 n1, n2
  const initialZoom = Number(q('.collab-viewport').getAttribute('transform').match(/scale\(([^)]+)/)[1]);
  const stageRect = q('svg').getBoundingClientRect();
  const panMatch = q('.collab-viewport').getAttribute('transform').match(/translate\(([^ ]+) ([^)]+)\)/);
  const panX = Number(panMatch[1]), panY = Number(panMatch[2]);

  // 从 clientX, clientY 计算到 graphX, graphY: (clientX - panX) / zoom
  const startClientX = (0 * initialZoom) + panX;
  const startClientY = (0 * initialZoom) + panY;
  const endClientX = (300 * initialZoom) + panX;
  const endClientY = (150 * initialZoom) + panY;

  fire(q('svg'), 'pointerdown', { clientX: startClientX, clientY: startClientY, shiftKey: true, button: 0 });
  check('A8: 框选矩形显示', q('.collab-marquee').hidden, false);
  fire(win.document, 'pointermove', { clientX: endClientX, clientY: endClientY });
  fire(win.document, 'pointerup', { clientX: endClientX, clientY: endClientY });
  check('A8: 框选结束矩形隐藏', q('.collab-marquee').hidden, true);
  check('A8: 命中 n1 和 n2', q('.collab-selection').textContent, '已选择 2 个节点');
  check('A8: n1 选中状态', q('[data-node-id="n1"]').classList.contains('is-selected'), true);
  check('A8: n2 选中状态', q('[data-node-id="n2"]').classList.contains('is-selected'), true);

  // A9. 文档 revision 更新后修剪（保留仍存在的，清理已删除的）
  const updatedDoc = fixture();
  updatedDoc.revision = 2;
  // 移除 n2，保留 n1
  updatedDoc.graph.nodes = updatedDoc.graph.nodes.filter(n => n.id !== 'n2');
  updatedDoc.graph.edges = updatedDoc.graph.edges.filter(e => e.from !== 'n2' && e.to !== 'n2');
  canvas.update({ document: updatedDoc });
  check('A9: 更新后修剪，只剩 n1', q('.collab-selection').textContent, '节点 · n1');
  check('A9: n1 仍保持选中', q('[data-node-id="n1"]').classList.contains('is-selected'), true);

  // A10. 会话切换清空选择
  canvas.update({ document: { ...fixture(), documentId: 'new-doc-id', revision: 1 } });
  check('A10: 会话切换清空选择', q('.collab-selection').textContent, '选择节点或连线以编辑');

  // =========================================================================
  // 任务 B：批量编辑（拖动与删除）
  // =========================================================================

  // 恢复标准 fixture
  doc = fixture();
  canvas.update({ document: doc });
  calls.length = 0;

  // B1. 批量拖动：选中 n1 和 n2，拖动 n1
  fire(q('[data-node-id="n1"]'), 'click');
  fire(q('[data-node-id="n2"]'), 'click', { ctrlKey: true });
  check('B1: 选中两个节点', q('.collab-selection').textContent, '已选择 2 个节点');

  // 拖动 n1 移动 (dx = 50, dy = 30)
  const currentZoom = Number(q('.collab-viewport').getAttribute('transform').match(/scale\(([^)]+)/)[1]);
  fire(q('[data-node-id="n1"]'), 'pointerdown', { clientX: 100, clientY: 100, button: 0 });
  fire(win.document, 'pointermove', { clientX: 150, clientY: 130 });
  check('B1: 拖拽中不提交', calls.length, 0);

  // pointerup 提交单批批量更新
  fire(win.document, 'pointerup', { clientX: 150, clientY: 130 });
  check('B1: 提交了一批操作', calls.length, 1);
  const moveOps = calls.pop();
  check('B1: 批次包含两个节点的更新', moveOps.length, 2);
  check('B1: 相对位移相同', {
    n1_dx: moveOps[0].params.x - 10,
    n1_dy: moveOps[0].params.y - 20,
    n2_dx: moveOps[1].params.x - 200,
    n2_dy: moveOps[1].params.y - 100,
  }, {
    n1_dx: Math.round(50 / currentZoom),
    n1_dy: Math.round(30 / currentZoom),
    n2_dx: Math.round(50 / currentZoom),
    n2_dy: Math.round(30 / currentZoom),
  });

  // B1-Cancel: 拖动过程中 PointerCancel 不产生提交
  fire(q('[data-node-id="n1"]'), 'pointerdown', { clientX: 100, clientY: 100, button: 0 });
  fire(win.document, 'pointermove', { clientX: 150, clientY: 130 });
  fire(win.document, 'pointercancel');
  check('B1-Cancel: 取消不提交', calls.length, 0);

  // B2. 批量删除：选中 n2 和 n3，删除
  // n2 连接了 e1(from:n1, to:n2) 和 e2(from:n2, to:n3)
  // n3 连接了 e2(from:n2, to:n3) 和 e3(from:n3, to:n4)
  // 受影响的连线去重后：e1, e2, e3 共 3 条！
  // 节点：n2, n3 共 2 个！
  // 必须先删除边再删除节点！
  fire(q('[data-node-id="n2"]'), 'click');
  fire(q('[data-node-id="n3"]'), 'click', { ctrlKey: true });
  fire(button('删除所选'), 'click');

  check('B2: 删除确认弹窗显示', q('.collab-confirm').hidden, false);
  check('B2: 弹窗包含对象与连线计数', q('.collab-confirm p').textContent, '删除所选的 2 个节点及 3 条连线？');

  // 取消删除
  fire(button('取消'), 'click');
  check('B2: 取消删除隐藏弹窗', q('.collab-confirm').hidden, true);
  check('B2: 取消无操作提交', calls.length, 0);

  // 再次点击删除并确认
  fire(button('删除所选'), 'click');
  fire(button('确认删除'), 'click');
  check('B2: 提交了删除操作', calls.length, 1);
  const delOps = calls.pop();
  check('B2: 总操作数 5 条', delOps.length, 5);
  // 前 3 条是 edge.remove，后 2 条是 node.remove
  const edgeOps = delOps.filter(op => op.type === 'edge.remove');
  const nodeOps = delOps.filter(op => op.type === 'node.remove');
  check('B2: 先删除 3 条边', edgeOps.length, 3);
  check('B2: 再删除 2 个节点', nodeOps.length, 2);
  check('B2: 边去重无重复 id', new Set(edgeOps.map(o => o.params.id)).size, 3);

  // =========================================================================
  // 任务 C：复制与粘贴
  // =========================================================================

  canvas.update({ document: fixture() });
  calls.length = 0;

  // C1. 复制选中节点及内部连线 (Ctrl+C)
  // 选中 n1, n2（内部连线为 e1）
  fire(q('[data-node-id="n1"]'), 'click');
  fire(q('[data-node-id="n2"]'), 'click', { ctrlKey: true });
  key(q('svg'), 'c', { ctrlKey: true });

  // C2. 粘贴 (Ctrl+V)
  key(q('svg'), 'v', { ctrlKey: true });
  check('C2: 粘贴提交了一批操作', calls.length, 1);
  const pasteOps1 = calls.pop();
  // 2 个节点 + 1 条内部连线 = 3 条操作
  check('C2: 包含 2 个节点和 1 条连线', pasteOps1.length, 3);
  check('C2: 前两条为 node.add', pasteOps1.slice(0, 2).map(o => o.type), ['node.add', 'node.add']);
  check('C2: 第三条为 edge.add', pasteOps1[2].type, 'edge.add');
  // 相对位置保持一致：原 n1 (10, 20), n2 (200, 100) -> 相对差 dx=190, dy=80
  const pastedN1 = pasteOps1[0].params, pastedN2 = pasteOps1[1].params;
  check('C2: 粘贴节点相对位移保持', [pastedN2.x - pastedN1.x, pastedN2.y - pastedN1.y], [190, 80]);
  // 内部连线端点连接新节点
  check('C2: 内部连线连接新节点', [pasteOps1[2].params.from, pasteOps1[2].params.to], [pastedN1.id, pastedN2.id]);
  // 偏移量：第一次粘贴偏移 +30
  check('C2: 首次粘贴偏移 30', [pastedN1.x - 10, pastedN1.y - 20], [30, 30]);

  // C3. 连续粘贴递增偏移
  key(q('svg'), 'v', { ctrlKey: true });
  const pasteOps2 = calls.pop();
  const secondN1 = pasteOps2[0].params;
  check('C3: 连续粘贴偏移 60', [secondN1.x - 10, secondN1.y - 20], [60, 60]);
  check('C3: 两次粘贴的节点 ID 互不相同', secondN1.id !== pastedN1.id, true);

  // C4. 快捷键 Ctrl+D 创建副本 (Duplicate)
  calls.length = 0;
  fire(q('[data-node-id="n3"]'), 'click');
  key(q('svg'), 'd', { ctrlKey: true });
  check('C4: Duplicate 提交单次原子添加', calls.length, 1);
  const dupOps = calls.pop();
  check('C4: 复制单个节点产生 1 条操作', dupOps.length, 1);
  check('C4: 副本节点标签相同', dupOps[0].params.label, '节点3');

  // C5. 剪贴板超限拒绝 (超过 50 条操作拒绝)
  // 创建包含 26 个节点和 25 条边的假数据
  const bigGraphDoc = fixture();
  bigGraphDoc.graph.nodes = Array.from({ length: 30 }, (_, i) => ({ id: `bn${i}`, label: `B${i}`, x: i * 20, y: i * 20 }));
  bigGraphDoc.graph.edges = Array.from({ length: 29 }, (_, i) => ({ id: `be${i}`, from: `bn${i}`, to: `bn${i + 1}` }));
  canvas.update({ document: bigGraphDoc });
  q('svg').focus();
  key(q('svg'), 'a', { ctrlKey: true }); // 全选 30 个节点
  key(q('svg'), 'c', { ctrlKey: true }); // 复制 30 节点 + 29 边 = 59 条
  calls.length = 0;
  key(q('svg'), 'v', { ctrlKey: true }); // 尝试粘贴
  check('C5: 超过 50 条操作拒绝直接粘贴', calls.length, 0);
  check('C5: 超限错误提示', q('.collab-error').textContent.includes('50'));

  // =========================================================================
  // 任务 D：节点对齐与快捷键完善
  // =========================================================================

  canvas.update({ document: fixture() });
  calls.length = 0;

  // D1. 左对齐：选中 n1 (x:10, y:20), n2 (x:200, y:100), n3 (x:400, y:50)
  // minX = 10。n1 已经在 10，因此只有 n2 和 n3 需要移动
  fire(q('[data-node-id="n1"]'), 'click');
  fire(q('[data-node-id="n2"]'), 'click', { ctrlKey: true });
  fire(q('[data-node-id="n3"]'), 'click', { ctrlKey: true });

  const alignSelect = q('[name="alignAction"]');
  alignSelect.value = 'left';
  fire(q('.collab-align-form'), 'submit');

  check('D1: 左对齐提交 2 条更新（忽略无变化的 n1）', calls.length, 1);
  const alignOps = calls.pop();
  check('D1: 只有 n2 和 n3', alignOps.map(o => o.params.id), ['n2', 'n3']);
  check('D1: n2 与 n3 的 x 均被设为 10', alignOps.every(o => o.params.x === 10), true);

  // D2. 水平居中
  // avgX = (10 + 200 + 400) / 3 = 203.33 -> 203
  alignSelect.value = 'centerH';
  fire(q('.collab-align-form'), 'submit');
  const centerOps = calls.pop();
  check('D2: 水平居中坐标为整数', centerOps.every(o => Number.isInteger(o.params.x)), true);

  // D3. 水平等间距 (distributeH)
  // 排序后: n1(10), n2(200), n3(400)
  // span = 400 - 10 = 390, step = 195. 目标：n1(10), n2(205), n3(400)
  // 只有 n2 需要微调从 200 到 205
  alignSelect.value = 'distributeH';
  fire(q('.collab-align-form'), 'submit');
  const distOps = calls.pop();
  check('D3: 水平等间距调整 n2 坐标', distOps[0].params, { id: 'n2', x: 205 });

  // D4. 零变化对齐不发请求
  // 如果当前所有选中的节点已经在目标位置
  const alignedDoc = fixture();
  alignedDoc.graph.nodes[1].x = 10;
  alignedDoc.graph.nodes[2].x = 10;
  canvas.update({ document: alignedDoc });
  fire(q('[data-node-id="n1"]'), 'click');
  fire(q('[data-node-id="n2"]'), 'click', { ctrlKey: true });
  fire(q('[data-node-id="n3"]'), 'click', { ctrlKey: true });
  alignSelect.value = 'left';
  fire(q('.collab-align-form'), 'submit');
  check('D4: 零变化对齐不提交', calls.length, 0);
  check('D4: 提示无须调整', q('.collab-error').textContent.includes('无须调整'));

  // D5. 方向键批量移动选中节点
  canvas.update({ document: fixture() });
  calls.length = 0;
  fire(q('[data-node-id="n1"]'), 'click');
  fire(q('[data-node-id="n2"]'), 'click', { ctrlKey: true });
  key(q('svg'), 'ArrowRight'); // 向右移动 10
  check('D5: 方向键批量移动 2 个节点', calls.length, 1);
  const arrowOps = calls.pop();
  check('D5: n1 从 10 移动到 20', arrowOps[0].params.x, 20);
  check('D5: n2 从 200 移动到 210', arrowOps[1].params.x, 210);

  // D6. 只读或 busy 状态禁用对齐与复制粘贴
  canvas.update({ document: fixture(), readOnly: true });
  check('D6: 只读下复制按钮禁用', button('复制').disabled, true);
  check('D6: 只读下对齐按钮禁用', button('应用对齐').disabled, true);

  // =========================================================================
  // 综合集成与边界测试
  // =========================================================================

  // E1. 49, 50, 51 批次操作边界测试
  // 测试批量移动 49, 50, 51 个节点
  canvas.update({ document: fixture(), readOnly: false });
  const boundaryDoc = fixture();
  boundaryDoc.graph.nodes = Array.from({ length: 55 }, (_, i) => ({
    id: `bound${i}`, label: `节点${i}`, x: i * 20, y: i * 20,
  }));
  boundaryDoc.graph.edges = [];
  canvas.update({ document: boundaryDoc });

  // 选中 49 个节点移动
  calls.length = 0;
  q('svg').focus();
  key(q('svg'), 'Escape'); // 清空
  for (let i = 0; i < 49; i++) {
    fire(q(`[data-node-id="bound${i}"]`), 'click', { ctrlKey: true });
  }
  check('E1: 选中 49 个节点', q('.collab-selection').textContent, '已选择 49 个节点');
  key(q('svg'), 'ArrowDown'); // 触发批量移动
  check('E1: 49 个节点操作成功提交', calls.length, 1);
  check('E1: 批次包含 49 条', calls.pop().length, 49);

  // 选中 50 个节点移动
  calls.length = 0;
  fire(q('[data-node-id="bound49"]'), 'click', { ctrlKey: true }); // 加第 50 个
  check('E1: 选中 50 个节点', q('.collab-selection').textContent, '已选择 50 个节点');
  key(q('svg'), 'ArrowDown');
  check('E1: 恰好 50 个节点操作成功提交', calls.length, 1);
  check('E1: 批次恰好包含 50 条', calls.pop().length, 50);

  // 选中 51 个节点移动
  calls.length = 0;
  fire(q('[data-node-id="bound50"]'), 'click', { ctrlKey: true }); // 加第 51 个
  check('E1: 选中 51 个节点', q('.collab-selection').textContent, '已选择 51 个节点');
  key(q('svg'), 'ArrowDown');
  check('E1: 51 个节点超过 50 上限拒绝提交', calls.length, 0);
  check('E1: 显示超限错误', q('.collab-error').textContent.includes('50'));

  // E2. 服务端真实原子批次与单步撤销重做 (CollabService & History)
  const { createCollabService } = await import('../server/collab-service.js');
  const { validateDocument } = await import('../lib/collab-doc.js');

  const sDocs = new Map();
  const scope = {
    key: 'k'.repeat(64),
    token: 't'.repeat(64),
    sessionId: 'sess-srv',
    assertCurrent() {},
  };
  const store = {
    read: s => ({ doc: sDocs.get(s.key) || null }),
    write(s, expected, d) {
      assert.equal(sDocs.get(s.key)?.revision ?? null, expected);
      sDocs.set(s.key, validateDocument(d));
      return { doc: structuredClone(d) };
    },
  };

  const service = createCollabService({ store });
  let sEditor = service.execute(scope, { action: 'open' });
  sEditor = service.execute(scope, { action: 'create', editorId: sEditor.editorId, expectedRevision: null });
  let sDoc = sEditor.document;
  // 初始文档有 3 个节点 (n1, n2, n3) 和 2 条边 (e1, e2)

  // 1. 批量拖拽 3 个节点
  const batchDragOps = [
    { opId: 'drag-1', actor: 'user', type: 'node.update', baseRevision: sDoc.revision, params: { id: 'n1', x: 50, y: 50 } },
    { opId: 'drag-2', actor: 'user', type: 'node.update', baseRevision: sDoc.revision, params: { id: 'n2', x: 250, y: 50 } },
    { opId: 'drag-3', actor: 'user', type: 'node.update', baseRevision: sDoc.revision, params: { id: 'n3', x: 450, y: 50 } },
  ];
  sEditor = service.execute(scope, {
    action: 'operations',
    editorId: sEditor.editorId,
    expectedRevision: sDoc.revision,
    ops: batchDragOps,
  });
  check('E2: 批量移动提交成功', sEditor.ok, true);
  sDoc = sEditor.document;
  check('E2: 版本前进到 2', sDoc.revision, 2);
  check('E2: 3 个节点全部更新到新坐标', sDoc.graph.nodes.map(n => n.x), [50, 250, 450]);

  // 单次撤销：必须一次性将 3 个节点全部恢复为初始坐标！
  sEditor = service.execute(scope, { action: 'undo', editorId: sEditor.editorId, expectedRevision: sDoc.revision });
  check('E2: 单次撤销成功', sEditor.ok, true);
  sDoc = sEditor.document;
  check('E2: 3 个节点一次撤销全部恢复初始坐标', sDoc.graph.nodes.map(n => n.x), [0, 200, 400]);

  // 单次重做：必须一次性将 3 个节点全部恢复为更新坐标！
  sEditor = service.execute(scope, { action: 'redo', editorId: sEditor.editorId, expectedRevision: sDoc.revision });
  check('E2: 单次重做成功', sEditor.ok, true);
  sDoc = sEditor.document;
  check('E2: 3 个节点一次重做全部恢复移动坐标', sDoc.graph.nodes.map(n => n.x), [50, 250, 450]);

  // 2. 批量删除：同时删除边 e1、e2 与节点 n2
  const batchDelOps = [
    { opId: 'del-e1', actor: 'user', type: 'edge.remove', baseRevision: sDoc.revision, params: { id: 'e1' } },
    { opId: 'del-e2', actor: 'user', type: 'edge.remove', baseRevision: sDoc.revision, params: { id: 'e2' } },
    { opId: 'del-n2', actor: 'user', type: 'node.remove', baseRevision: sDoc.revision, params: { id: 'n2' } },
  ];
  sEditor = service.execute(scope, {
    action: 'operations',
    editorId: sEditor.editorId,
    expectedRevision: sDoc.revision,
    ops: batchDelOps,
  });
  check('E2: 批量删除原子提交成功', sEditor.ok, true);
  sDoc = sEditor.document;
  check('E2: 边被清空且只剩 2 个节点', [sDoc.graph.edges.length, sDoc.graph.nodes.length], [0, 2]);

  // 单次撤销批量删除：同时恢复节点 n2 与两条边！
  sEditor = service.execute(scope, { action: 'undo', editorId: sEditor.editorId, expectedRevision: sDoc.revision });
  check('E2: 单次撤销批量删除成功', sEditor.ok, true);
  sDoc = sEditor.document;
  check('E2: 恢复后拥有 3 个节点和 2 条边', [sDoc.graph.nodes.length, sDoc.graph.edges.length], [3, 2]);
  check('E2: 恢复的节点 n2 存在', sDoc.graph.nodes.some(n => n.id === 'n2'), true);
  check('E2: 恢复的两条边存在', sDoc.graph.edges.map(e => e.id).sort(), ['e1', 'e2']);

  // E3. CAS 冲突拒绝部分保存 (fail closed)
  assert.throws(
    () => service.execute(scope, {
      action: 'operations',
      editorId: sEditor.editorId,
      expectedRevision: 999, // 错误的期望版本
      ops: [{ opId: 'cas-test', actor: 'user', type: 'node.update', baseRevision: 999, params: { id: 'n1', label: '冲突' } }],
    }),
    e => e.code === 'collab_conflict'
  );
  check('E3: CAS 冲突拒绝提交且原文档字节未变', sDocs.get(scope.key).revision, sDoc.revision);

  canvas.destroy();
  dom.window.close();
  console.log(`\ncollab-advanced-editing: ${checks}/${checks} passed; assertions=${assertions}`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
