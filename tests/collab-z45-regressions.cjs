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
  documentId: 'doc-regress', schemaVersion: 1, revision: 1, title: '回归测试图', boundSessionId: 'sess-1', appliedOps: [],
  graph: {
    nodes: [
      { id: 'n1', label: '节点1', x: 0, y: 0 },
      { id: 'n2', label: '节点2', x: 100, y: 100 },
      { id: 'n3', label: '节点3', x: 200, y: 200 },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
    ],
  },
});

async function main() {
  const { mountCollabCanvas } = await import('../public/collab-canvas.js');
  const dom = new JSDOM('<main><div id="canvas"></div></main>');
  const win = dom.window;
  const host = win.document.querySelector('#canvas');

  const q = selector => host.querySelector(selector);
  const qAll = selector => [...host.querySelectorAll(selector)];
  const fire = (el, type, init = {}) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  const key = (el, value, init = {}) => el.dispatchEvent(new win.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init }));

  const calls = [];
  let doc = fixture();
  const canvas = mountCollabCanvas(host, {
    document: doc,
    onOperations: ops => calls.push(ops),
  });

  console.log('--- 测试 1：鼠标事件序列与交互 ---');
  // 1.1 Ctrl+点击单次 toggle 选中
  const n1El = q('[data-node-id="n1"]');
  fire(n1El, 'pointerdown', { button: 0, ctrlKey: true });
  fire(win.document, 'pointerup', { button: 0, ctrlKey: true });
  fire(n1El, 'click', { button: 0, ctrlKey: true });
  check('1.1: 真实 Ctrl+点击序列后 n1 必须处于选中状态', n1El.classList.contains('is-selected'), true);

  // 1.2 再次 Ctrl+点击 toggle 取消选中
  fire(n1El, 'pointerdown', { button: 0, ctrlKey: true });
  fire(win.document, 'pointerup', { button: 0, ctrlKey: true });
  fire(n1El, 'click', { button: 0, ctrlKey: true });
  check('1.2: 再次 Ctrl+点击取消选中', n1El.classList.contains('is-selected'), false);

  // 1.3 普通点击未选节点进行单选
  fire(n1El, 'pointerdown', { button: 0 });
  fire(win.document, 'pointerup', { button: 0 });
  fire(n1El, 'click', { button: 0 });
  check('1.3: 普通点击单选成功', n1El.classList.contains('is-selected'), true);

  // 1.4 多选后拖拽：选中 n1 和 n2，拖拽 n1，保持多选并提交位移
  const n2El = q('[data-node-id="n2"]');
  fire(n2El, 'pointerdown', { button: 0, ctrlKey: true });
  fire(win.document, 'pointerup', { button: 0, ctrlKey: true });
  fire(n2El, 'click', { button: 0, ctrlKey: true });
  check('1.4 前置: n1 与 n2 均被多选', qAll('.collab-node.is-selected').length, 2);

  calls.length = 0;
  fire(n1El, 'pointerdown', { clientX: 0, clientY: 0, button: 0 });
  fire(win.document, 'pointermove', { clientX: 30, clientY: 20 });
  fire(win.document, 'pointerup', { clientX: 30, clientY: 20 });
  fire(n1El, 'click', { clientX: 30, clientY: 20 });
  check('1.4: 拖动多选节点后保持多选，不被随后的 click 破坏', qAll('.collab-node.is-selected').length, 2);
  check('1.4: 拖拽产生了批量更新操作', calls.length, 1);

  // 1.5 多选后单次点击（未拖拽）：降级为单选
  fire(n1El, 'pointerdown', { clientX: 0, clientY: 0, button: 0 });
  fire(win.document, 'pointerup', { clientX: 0, clientY: 0 });
  fire(n1El, 'click', { clientX: 0, clientY: 0 });
  check('1.5: 多选状态下直接点击单个节点收敛为单选', qAll('.collab-node.is-selected').length, 1);
  check('1.5: 唯独 n1 保持选中', n1El.classList.contains('is-selected'), true);

  // 1.6 框选序列与 click 抑制
  const svg = q('svg');
  fire(svg, 'pointerdown', { clientX: 0, clientY: 0, shiftKey: true, button: 0 });
  fire(win.document, 'pointermove', { clientX: 150, clientY: 150 });
  fire(win.document, 'pointerup', { clientX: 150, clientY: 150 });
  fire(svg, 'click', { clientX: 150, clientY: 150 });
  check('1.6: 框选结束后随后的 click 不能清空选区', qAll('.collab-node.is-selected').length >= 2, true);

  // 1.7 点击空白区域清空选区
  fire(svg, 'pointerdown', { clientX: 500, clientY: 500, button: 0 });
  fire(win.document, 'pointerup', { clientX: 500, clientY: 500 });
  fire(svg, 'click', { clientX: 500, clientY: 500 });
  check('1.7: 点击空白区域清空选区', qAll('.collab-node.is-selected').length, 0);

  // 1.8 pointercancel / Escape / blur 清理拖动状态
  calls.length = 0;
  fire(n1El, 'pointerdown', { clientX: 0, clientY: 0, button: 0 });
  fire(win.document, 'pointermove', { clientX: 50, clientY: 50 });
  fire(win.document, 'pointercancel');
  check('1.8: pointercancel 不产生操作提交', calls.length, 0);

  console.log('--- 测试 2：焦点恢复与 Tab 导航 ---');
  // 2.1 update() revision 更新时恢复焦点并不破坏多选
  fire(q('[data-node-id="n1"]'), 'click');
  fire(q('[data-node-id="n2"]'), 'click', { ctrlKey: true });
  q('[data-node-id="n1"]').focus();
  check('2.1 前置: 此时 n1 与 n2 均被多选', qAll('.collab-node.is-selected').length, 2);

  const rev2Doc = fixture();
  rev2Doc.revision = 2;
  canvas.update({ document: rev2Doc });
  check('2.1: update() 恢复焦点后保持多选', qAll('.collab-node.is-selected').length, 2);

  // 2.2 update() 剔除已删除对象
  const prunedDoc = fixture();
  prunedDoc.revision = 3;
  prunedDoc.graph.nodes = [prunedDoc.graph.nodes[0]]; // 只保留 n1
  prunedDoc.graph.edges = []; // 伴随连线一同删除
  canvas.update({ document: prunedDoc });
  check('2.2: update() 剔除已删除的 n2', qAll('.collab-node.is-selected').length, 1);
  check('2.2: 现存的 n1 仍处于选中', q('[data-node-id="n1"]').classList.contains('is-selected'), true);

  // 2.3 会话切换清空选择
  const newSessionDoc = fixture();
  newSessionDoc.documentId = 'doc-other';
  canvas.update({ document: newSessionDoc });
  check('2.3: 切换 documentId 时清空选区', qAll('.collab-node.is-selected').length, 0);

  // 2.4 用户 Tab 导航聚焦新节点时选中新节点
  const n3El = q('[data-node-id="n3"]');
  n3El.dispatchEvent(new win.FocusEvent('focusin', { bubbles: true }));
  check('2.4: 用户主动聚焦未选节点选中该节点', n3El.classList.contains('is-selected'), true);

  // 2.5 用户聚焦已选节点时不破坏多选
  fire(q('[data-node-id="n1"]'), 'click');
  fire(q('[data-node-id="n2"]'), 'click', { ctrlKey: true });
  check('2.5 前置: n1 与 n2 均被选中', qAll('.collab-node.is-selected').length, 2);
  q('[data-node-id="n2"]').dispatchEvent(new win.FocusEvent('focusin', { bubbles: true }));
  check('2.5: 用户聚焦已选节点保留既有多选', qAll('.collab-node.is-selected').length, 2);

  console.log('--- 测试 3：批量移动严格保持相对位移与边界控制 ---');
  // 3.1 单侧接近 +100000 边界位移夹紧
  const extremeDoc = fixture();
  extremeDoc.graph.edges = [];
  extremeDoc.graph.nodes = [
    { id: 'nA', label: '节点A', x: 99995, y: 0 },
    { id: 'nB', label: '节点B', x: 100, y: 0 },
  ];
  canvas.update({ document: extremeDoc });
  calls.length = 0;

  fire(q('[data-node-id="nA"]'), 'click');
  fire(q('[data-node-id="nB"]'), 'click', { ctrlKey: true });

  // 向右移动 10 像素，但 nA 距离 100000 仅剩 5 像素
  key(q('svg'), 'ArrowRight');
  const moveOps1 = calls.pop();
  check('3.1: 产生了批量移动提交', !!moveOps1 && moveOps1.length === 2, true);
  const nA_new1 = moveOps1.find(o => o.params.id === 'nA').params.x;
  const nB_new1 = moveOps1.find(o => o.params.id === 'nB').params.x;
  check('3.1: 集合整体夹紧为移动 +5 像素 (nA 触碰 100000)', nA_new1, 100000);
  check('3.1: nB 同步只移动 +5 像素 (105)', nB_new1, 105);
  check('3.1: 相对坐标差严格不变', nA_new1 - nB_new1, 99995 - 100);

  // 3.2 节点接近 -100000 边界位移夹紧
  const extremeDocNeg = fixture();
  extremeDocNeg.graph.edges = [];
  extremeDocNeg.graph.nodes = [
    { id: 'nNegA', label: '负A', x: -99995, y: 0 },
    { id: 'nNegB', label: '负B', x: -100, y: 0 },
  ];
  canvas.update({ document: extremeDocNeg });
  calls.length = 0;
  fire(q('[data-node-id="nNegA"]'), 'click');
  fire(q('[data-node-id="nNegB"]'), 'click', { ctrlKey: true });

  // 向左移动 10 像素，但 nNegA 距离 -100000 仅剩 5 像素
  key(q('svg'), 'ArrowLeft');
  const moveOps2 = calls.pop();
  check('3.2: 产生了批量移动提交', !!moveOps2 && moveOps2.length === 2, true);
  const nNegA_new = moveOps2.find(o => o.params.id === 'nNegA').params.x;
  const nNegB_new = moveOps2.find(o => o.params.id === 'nNegB').params.x;
  check('3.2: 负边界整体夹紧为移动 -5 像素 (nNegA 触碰 -100000)', nNegA_new, -100000);
  check('3.2: nNegB 同步只移动 -5 像素 (-105)', nNegB_new, -105);
  check('3.2: 负边界相对坐标差严格不变', nNegA_new - nNegB_new, -99995 - (-100));

  // 3.3 多节点同时逼近不同坐标边界
  const extremeDocOpposite = fixture();
  extremeDocOpposite.graph.edges = [];
  extremeDocOpposite.graph.nodes = [
    { id: 'nLeft', label: '左极', x: -99995, y: 0 },
    { id: 'nRight', label: '右极', x: 99995, y: 0 },
  ];
  canvas.update({ document: extremeDocOpposite });
  calls.length = 0;
  fire(q('[data-node-id="nLeft"]'), 'click');
  fire(q('[data-node-id="nRight"]'), 'click', { ctrlKey: true });

  // 向右移动 20 像素，右极受限只能 +5
  key(q('svg'), 'ArrowRight');
  const moveOps3 = calls.pop();
  const nLeft_3 = moveOps3.find(o => o.params.id === 'nLeft').params.x;
  const nRight_3 = moveOps3.find(o => o.params.id === 'nRight').params.x;
  check('3.3: 向右移动时右极限制全组最大 +5', nRight_3, 100000);
  check('3.3: 左极跟随 +5 到达 -99990', nLeft_3, -99990);
  check('3.3: 两极间距严格守恒', nRight_3 - nLeft_3, 99995 - (-99995));

  // 3.4 已经在边界上无法再同向移动时零提交
  calls.length = 0;
  const atBoundaryDoc = fixture();
  atBoundaryDoc.graph.edges = [];
  atBoundaryDoc.graph.nodes = [
    { id: 'nWall', label: '撞墙', x: 100000, y: 0 },
    { id: 'nOther', label: '他处', x: 50, y: 0 },
  ];
  canvas.update({ document: atBoundaryDoc });
  fire(q('[data-node-id="nWall"]'), 'click');
  fire(q('[data-node-id="nOther"]'), 'click', { ctrlKey: true });

  key(q('svg'), 'ArrowRight');
  check('3.4: 边界处无法再位移时零提交', calls.length, 0);

  // 3.5 批量移动超过 50 个节点明确拒绝并提示错误
  const largeNodes = [];
  for (let i = 0; i < 55; i++) {
    largeNodes.push({ id: `bulk-${i}`, label: `节点${i}`, x: i * 10, y: i * 10 });
  }
  const largeDoc = fixture();
  largeDoc.graph.edges = [];
  largeDoc.graph.nodes = largeNodes;
  canvas.update({ document: largeDoc });
  // Ctrl+A 全选 55 个节点
  key(q('svg'), 'a', { ctrlKey: true });
  check('3.5 前置: 成功选中 55 个节点', qAll('.collab-node.is-selected').length, 55);

  calls.length = 0;
  key(q('svg'), 'ArrowRight');
  check('3.5: 超过 50 个节点批量移动拒绝提交 (零提交)', calls.length, 0);
  check('3.5: 展示单次最多 50 项操作错误提示', host.querySelector('.collab-error').textContent.includes('单次最多 50 项操作'), true);

  // 3.6 拖拽批量移动在边界夹紧时严格保持相对位移
  const dragClampDoc = fixture();
  dragClampDoc.graph.edges = [];
  dragClampDoc.graph.nodes = [
    { id: 'dClampA', label: '拖拽A', x: 99995, y: 0 },
    { id: 'dClampB', label: '拖拽B', x: 200, y: 0 },
  ];
  canvas.update({ document: dragClampDoc });
  calls.length = 0;
  fire(q('[data-node-id="dClampA"]'), 'click');
  fire(q('[data-node-id="dClampB"]'), 'click', { ctrlKey: true });
  check('3.6 前置: dClampA 与 dClampB 被多选', qAll('.collab-node.is-selected').length, 2);

  // 拖拽 dClampA 向右 50px
  fire(q('[data-node-id="dClampA"]'), 'pointerdown', { clientX: 0, clientY: 0, button: 0 });
  fire(win.document, 'pointermove', { clientX: 50, clientY: 0 });
  fire(win.document, 'pointerup', { clientX: 50, clientY: 0 });
  const dragMoveOps = calls.pop();
  check('3.6: 拖拽产生批量提交', !!dragMoveOps && dragMoveOps.length === 2, true);
  const dClampA_x = dragMoveOps.find(o => o.params.id === 'dClampA').params.x;
  const dClampB_x = dragMoveOps.find(o => o.params.id === 'dClampB').params.x;
  check('3.6: dClampA 触碰边界 100000', dClampA_x, 100000);
  check('3.6: dClampB 同步移动 +5 至 205', dClampB_x, 205);
  check('3.6: 拖拽批量移动相对位移严格不变', dClampA_x - dClampB_x, 99995 - 200);

  // 3.7 拖拽超过 50 个节点拒绝直接提交
  canvas.update({ document: largeDoc });
  key(q('svg'), 'a', { ctrlKey: true });
  calls.length = 0;
  fire(q('[data-node-id="bulk-0"]'), 'pointerdown', { clientX: 0, clientY: 0, button: 0 });
  fire(win.document, 'pointermove', { clientX: 20, clientY: 20 });
  fire(win.document, 'pointerup', { clientX: 20, clientY: 20 });
  check('3.7: 拖拽超过 50 个节点拒绝提交 (零提交)', calls.length, 0);
  check('3.7: 拖拽超过上限提示错误', host.querySelector('.collab-error').textContent.includes('单次最多 50 项操作'), true);

  canvas.destroy();
  dom.window.close();
  console.log(`\ncollab-z45-regressions: ${checks}/${checks} passed; assertions=${assertions}`);
}

main().catch(err => {
  console.error('反证失败证据 (预期红):', err.message);
  process.exitCode = 1;
});
