/* A controlled graph view. Only the owner commits intents and owns history. */
import { createSelection, hitTestRect } from './collab-selection.js';

const SVG = 'http://www.w3.org/2000/svg';
const WIDTH = 156, HEIGHT = 64;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const validLabel = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const coordinate = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000;
let instanceNumber = 0;

// Projection checks only: appliedOps and authoritative validation belong upstream.
function validGraph(document) {
  if (!document || !validId(document.documentId) || document.schemaVersion !== 1 ||
      !Number.isSafeInteger(document.revision) || document.revision < 1) return false;
  const graph = document.graph;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length > 200 || graph.edges.length > 400) return false;
  const ids = new Set(), nodes = new Set(), endpoints = new Set();
  for (const node of graph.nodes) {
    if (!node || !validId(node.id) || ids.has(node.id) || !validLabel(node.label) || !coordinate(node.x) || !coordinate(node.y)) return false;
    ids.add(node.id); nodes.add(node.id);
  }
  for (const edge of graph.edges) {
    if (!edge || !validId(edge.id) || ids.has(edge.id) || !nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to ||
        (edge.label !== undefined && !validLabel(edge.label))) return false;
    const pair = `${edge.from}:${edge.to}`;
    if (endpoints.has(pair)) return false;
    ids.add(edge.id); endpoints.add(pair);
  }
  return true;
}

export function mountCollabCanvas(host, {
  document: initialDocument, readOnly = false, onOperations = () => {},
  onUndo = () => {}, onRedo = () => {}, confirmDelete,
} = {}) {
  const dom = host.ownerDocument;
  const listeners = [];
  let document = initialDocument, busy = false, error = null, canUndo = false, canRedo = false;
  let alive = true, generation = 0, drag = null, pendingDelete = null, confirming = false;
  let valid = false, suppressClick = false, localError = '';
  let pointerAction = null, restoringFocus = false;
  let firstRender = true;
  let zoom = 1, pan = { x: 24, y: 24 };
  const markerId = `collab-arrow-${++instanceNumber}`;

  // 多选与剪贴板模型
  const selection = createSelection();
  let clipboard = null;
  let pasteCount = 0;

  const element = (tag, className, text) => {
    const domNode = dom.createElement(tag);
    if (className) domNode.className = className;
    if (text !== undefined) domNode.textContent = text;
    return domNode;
  };
  const svgElement = (tag, attrs = {}) => {
    const domNode = dom.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) domNode.setAttribute(key, value);
    return domNode;
  };
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };

  const root = element('section', 'collab-canvas');
  root.setAttribute('aria-label', '协同编辑画布');

  // 工具栏
  const toolbar = element('div', 'collab-toolbar');
  toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', '画布操作');
  const button = (parent, text, handler) => {
    const domNode = element('button', '', text); domNode.type = 'button';
    listen(domNode, 'click', () => { if (alive && !domNode.disabled) handler(); });
    parent.append(domNode); return domNode;
  };

  const add = button(toolbar, '新增节点', addNode);
  const undo = button(toolbar, '撤销', () => invoke(onUndo));
  const redo = button(toolbar, '重做', () => invoke(onRedo));
  const copyBtn = button(toolbar, '复制', copySelected);
  const pasteBtn = button(toolbar, '粘贴', pasteClipboard);
  button(toolbar, '缩小', () => scale(1 / 1.2));
  const zoomLabel = element('output', 'collab-zoom', '100%');
  zoomLabel.setAttribute('aria-label', '缩放比例'); toolbar.append(zoomLabel);
  button(toolbar, '放大', () => scale(1.2));
  button(toolbar, '适应画布', fit);

  const status = element('p', 'collab-status'); status.setAttribute('role', 'status');
  const alert = element('p', 'collab-error'); alert.setAttribute('role', 'alert');
  const help = element('p', 'collab-help', '拖动节点或空白处；Shift+拖动框选；滚轮缩放。Ctrl+点击多选，Ctrl+A 全选，Ctrl+C/V 复制粘贴，Ctrl+D 副本，Delete 批量删除，方向键移动所选。');
  help.id = `${markerId}-help`;

  const svg = svgElement('svg', { class: 'collab-stage', tabindex: '0', role: 'group', 'aria-label': '节点与有向连线', 'aria-describedby': help.id });
  const defs = svgElement('defs');
  const marker = svgElement('marker', { id: markerId, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
  marker.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z' })); defs.append(marker);
  const viewport = svgElement('g', { class: 'collab-viewport' });
  // 框选指示矩形
  const marquee = svgElement('rect', { class: 'collab-marquee', hidden: 'true' });
  svg.append(defs, viewport, marquee);

  const empty = element('p', 'collab-empty', '画布为空。新增节点开始绘制。');

  // 属性与操作面板
  const editor = element('div', 'collab-inspector');
  const selectionLabel = element('p', 'collab-selection', '选择节点或连线以编辑');

  // 单选文字编辑表单
  const editForm = element('form', 'collab-edit-form');
  const labelWrap = element('label', '', '所选文字');
  const labelInput = element('input'); labelInput.name = 'label'; labelInput.maxLength = 200;
  labelWrap.append(labelInput); editForm.append(labelWrap);
  const save = button(editForm, '保存文字', saveLabel);

  // 单选连线表单
  const connectForm = element('form', 'collab-connect-form');
  const targetWrap = element('label', '', '连接到');
  const targetSelect = element('select'); targetSelect.name = 'edgeTarget'; targetWrap.append(targetSelect);
  const edgeWrap = element('label', '', '连线文字（可选）');
  const edgeLabel = element('input'); edgeLabel.name = 'edgeLabel'; edgeLabel.maxLength = 200; edgeWrap.append(edgeLabel);
  connectForm.append(targetWrap, edgeWrap);
  const connect = button(connectForm, '新增连线', addEdge);

  // 多选对齐与间距表单
  const alignForm = element('form', 'collab-align-form');
  const alignWrap = element('label', '', '节点对齐');
  const alignSelect = element('select'); alignSelect.name = 'alignAction';
  for (const [val, text] of [
    ['', '选择对齐方式…'],
    ['left', '左对齐'],
    ['centerH', '水平居中'],
    ['right', '右对齐'],
    ['top', '顶对齐'],
    ['centerV', '垂直居中'],
    ['bottom', '底对齐'],
    ['distributeH', '水平等间距 (≥3)'],
    ['distributeV', '垂直等间距 (≥3)'],
  ]) {
    const opt = element('option', '', text); opt.value = val; alignSelect.append(opt);
  }
  alignWrap.append(alignSelect); alignForm.append(alignWrap);
  const applyAlignBtn = button(alignForm, '应用对齐', applyAlignment);

  // 删除按钮
  const remove = button(editor, '删除所选', requestDelete);

  // 删除确认对话框
  const confirmation = element('div', 'collab-confirm'); confirmation.hidden = true;
  confirmation.setAttribute('role', 'group'); confirmation.setAttribute('aria-label', '删除确认');
  const confirmationText = element('p'); confirmation.append(confirmationText);
  const confirm = button(confirmation, '确认删除', () => finishDelete(pendingDelete, true));
  button(confirmation, '取消', cancelDelete);

  editor.append(selectionLabel, editForm, connectForm, alignForm, remove);
  root.append(toolbar, status, alert, svg, empty, editor, confirmation, help);
  host.append(root);

  function writable() { return alive && valid && !readOnly && !busy && !error && !confirming; }

  function currentItem() {
    if (!valid) return null;
    const pri = selection.primary();
    if (!pri) return null;
    return (pri.kind === 'node' ? document.graph.nodes : document.graph.edges).find(item => item.id === pri.id) || null;
  }

  function invoke(callback, value) {
    const expectedGeneration = generation, expectedDocument = document;
    try {
      const result = callback(value);
      if (result?.then) Promise.resolve(result).catch(() => {
        if (alive && generation === expectedGeneration && document === expectedDocument) {
          localError = '操作失败，请刷新后重试。'; renderControls();
        }
      });
    } catch {
      localError = '操作失败，请刷新后重试。'; renderControls();
    }
  }

  function emit(operations) {
    if (!writable()) return;
    localError = ''; invoke(onOperations, operations); renderControls();
  }

  function id(prefix) {
    const used = new Set([...document.graph.nodes, ...document.graph.edges].map(item => item.id));
    let next;
    do { next = `${prefix}-${dom.defaultView.crypto.randomUUID()}`; } while (used.has(next));
    return next;
  }

  function addNode() {
    if (!writable() || document.graph.nodes.length >= 200) return;
    const rect = svg.getBoundingClientRect();
    const x = Math.round(((rect.width || 360) / 2 - pan.x) / zoom - WIDTH / 2);
    const y = Math.round(((rect.height || 260) / 2 - pan.y) / zoom - HEIGHT / 2);
    const newId = id('n');
    emit([{ type: 'node.add', params: { id: newId, label: '新节点', x: clamp(x), y: clamp(y) } }]);
    selection.selectOne('node', newId);
  }

  function saveLabel() {
    const item = currentItem();
    const pri = selection.primary();
    if (!writable() || !item || !pri) return;
    const label = labelInput.value.trim();
    if (label.length > 200 || (pri.kind === 'node' && !label)) {
      localError = '节点文字须为 1–200 字符。'; renderControls(); labelInput.focus(); return;
    }
    if (label === (item.label || '')) return;
    emit([{ type: `${pri.kind}.update`, params: { id: item.id, label: label || null } }]);
  }

  function addEdge() {
    const item = currentItem();
    const pri = selection.primary();
    if (!writable() || pri?.kind !== 'node' || !item || document.graph.edges.length >= 400) return;
    const to = targetSelect.value, label = edgeLabel.value.trim();
    if (!document.graph.nodes.some(node => node.id === to) || to === item.id || label.length > 200 ||
        document.graph.edges.some(edge => edge.from === item.id && edge.to === to)) {
      localError = '请选择其他节点，且不能重复连接。'; renderControls(); return;
    }
    const params = { id: id('e'), from: item.id, to };
    if (label) params.label = label;
    emit([{ type: 'edge.add', params }]);
  }

  function cancelDelete() {
    confirming = false; pendingDelete = null; confirmation.hidden = true;
    renderControls(); if (alive) remove.focus();
  }

  function finishDelete(request, accepted) {
    if (!request || !alive || request.generation !== generation || request.document !== document) return;
    confirming = false; pendingDelete = null; confirmation.hidden = true;
    if (accepted === true && writable()) {
      selection.clear();
      emit(request.operations);
    }
    renderControls(); remove.focus();
  }

  function requestDelete() {
    if (!writable() || selection.count() === 0) return;
    const selNodes = new Set(selection.nodeIds());
    const selEdges = new Set(selection.edgeIds());

    // 收集所有关联边（去重）
    const edgesToDelete = new Set(selEdges);
    for (const edge of document.graph.edges) {
      if (selNodes.has(edge.from) || selNodes.has(edge.to)) {
        edgesToDelete.add(edge.id);
      }
    }

    const totalOps = edgesToDelete.size + selNodes.size;
    if (totalOps === 0) return;
    if (totalOps > 50) {
      localError = '单次最多 50 项操作，请先分批删除连线或节点。'; renderControls(); return;
    }

    // 先删除边，再删除节点
    const operations = [
      ...[...edgesToDelete].map(edgeId => ({ type: 'edge.remove', params: { id: edgeId } })),
      ...[...selNodes].map(nodeId => ({ type: 'node.remove', params: { id: nodeId } })),
    ];

    // 明确提示文案
    let message = '';
    if (selNodes.size === 1 && selEdges.size === 0) {
      const node = document.graph.nodes.find(n => n.id === [...selNodes][0]);
      message = `删除节点“${node?.label || [...selNodes][0]}”及其 ${edgesToDelete.size} 条连线？`;
    } else if (selNodes.size === 0 && selEdges.size === 1) {
      message = '删除所选连线？';
    } else {
      const parts = [];
      if (selNodes.size > 0) parts.push(`${selNodes.size} 个节点`);
      if (edgesToDelete.size > 0) parts.push(`${edgesToDelete.size} 条连线`);
      message = `删除所选的 ${parts.join('及 ')}？`;
    }

    const request = { operations, generation, document };
    pendingDelete = request; confirming = true; renderControls();
    if (typeof confirmDelete === 'function') {
      try {
        Promise.resolve(confirmDelete(message)).then(accepted => finishDelete(request, accepted), () => {
          if (alive && request.generation === generation) { cancelDelete(); localError = '删除确认失败。'; renderControls(); }
        });
      } catch { cancelDelete(); localError = '删除确认失败。'; renderControls(); }
    } else {
      confirmationText.textContent = message; confirmation.hidden = false; confirm.focus();
    }
  }

  // ---------------------------------------------------------------------------
  // 任务 C：复制与粘贴
  // ---------------------------------------------------------------------------
  function copySelected() {
    if (!valid) return false;
    const nodeIds = new Set(selection.nodeIds());
    if (nodeIds.size === 0) return false;

    const copiedNodes = document.graph.nodes
      .filter(n => nodeIds.has(n.id))
      .map(n => ({ id: n.id, label: n.label, x: n.x, y: n.y }));

    // 只复制两端都在选中集合中的内部连线
    const copiedEdges = document.graph.edges
      .filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
      .map(e => ({ id: e.id, from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) }));

    clipboard = {
      documentId: document.documentId,
      nodes: copiedNodes,
      edges: copiedEdges,
    };
    pasteCount = 0;
    renderControls();
    return true;
  }

  function pasteClipboard() {
    if (!writable() || !clipboard || !clipboard.nodes.length) return false;
    const countNodes = clipboard.nodes.length;
    const countEdges = clipboard.edges.length;

    // 容量与批次上限检查
    if (document.graph.nodes.length + countNodes > 200) {
      localError = '粘贴后节点数将超过上限 200。'; renderControls(); return false;
    }
    if (document.graph.edges.length + countEdges > 400) {
      localError = '粘贴后连线数将超过上限 400。'; renderControls(); return false;
    }
    if (countNodes + countEdges > 50) {
      localError = '单次最多 50 项操作，剪贴板包含对象过多。'; renderControls(); return false;
    }

    pasteCount++;
    const offset = pasteCount * 30;
    const idMap = new Map();
    const ops = [];

    // 1. 新增节点
    for (const node of clipboard.nodes) {
      const newId = id('n');
      idMap.set(node.id, newId);
      ops.push({
        type: 'node.add',
        params: {
          id: newId,
          label: node.label,
          x: clamp(node.x + offset),
          y: clamp(node.y + offset),
        },
      });
    }

    // 2. 新增内部连线
    for (const edge of clipboard.edges) {
      const newEdgeId = id('e');
      ops.push({
        type: 'edge.add',
        params: {
          id: newEdgeId,
          from: idMap.get(edge.from),
          to: idMap.get(edge.to),
          ...(edge.label ? { label: edge.label } : {}),
        },
      });
    }

    // 提交单批原子操作
    emit(ops);

    // 选中新粘贴的节点
    selection.clear();
    for (const newId of idMap.values()) {
      selection.add('node', newId);
    }
    renderSelection();
    return true;
  }

  function duplicateSelected() {
    if (copySelected()) {
      pasteClipboard();
    }
  }

  // ---------------------------------------------------------------------------
  // 任务 D：节点对齐与间距
  // ---------------------------------------------------------------------------
  function applyAlignment() {
    if (!writable()) return;
    const action = alignSelect.value;
    if (!action) return;

    const nodeIds = selection.nodeIds();
    if (nodeIds.length < 2) {
      localError = '至少需要选中 2 个节点才能进行对齐。'; renderControls(); return;
    }
    if ((action === 'distributeH' || action === 'distributeV') && nodeIds.length < 3) {
      localError = '等间距调整至少需要选中 3 个节点。'; renderControls(); return;
    }

    const nodes = document.graph.nodes.filter(n => nodeIds.includes(n.id));
    const ops = [];

    if (action === 'left') {
      const minX = Math.min(...nodes.map(n => n.x));
      for (const n of nodes) {
        if (n.x !== minX) ops.push({ type: 'node.update', params: { id: n.id, x: minX } });
      }
    } else if (action === 'centerH') {
      const avgX = Math.round(nodes.reduce((sum, n) => sum + n.x, 0) / nodes.length);
      for (const n of nodes) {
        if (n.x !== avgX) ops.push({ type: 'node.update', params: { id: n.id, x: avgX } });
      }
    } else if (action === 'right') {
      const maxX = Math.max(...nodes.map(n => n.x));
      for (const n of nodes) {
        if (n.x !== maxX) ops.push({ type: 'node.update', params: { id: n.id, x: maxX } });
      }
    } else if (action === 'top') {
      const minY = Math.min(...nodes.map(n => n.y));
      for (const n of nodes) {
        if (n.y !== minY) ops.push({ type: 'node.update', params: { id: n.id, y: minY } });
      }
    } else if (action === 'centerV') {
      const avgY = Math.round(nodes.reduce((sum, n) => sum + n.y, 0) / nodes.length);
      for (const n of nodes) {
        if (n.y !== avgY) ops.push({ type: 'node.update', params: { id: n.id, y: avgY } });
      }
    } else if (action === 'bottom') {
      const maxY = Math.max(...nodes.map(n => n.y));
      for (const n of nodes) {
        if (n.y !== maxY) ops.push({ type: 'node.update', params: { id: n.id, y: maxY } });
      }
    } else if (action === 'distributeH') {
      const sorted = [...nodes].sort((a, b) => a.x - b.x);
      const minX = sorted[0].x, maxX = sorted[sorted.length - 1].x;
      const step = (maxX - minX) / (sorted.length - 1);
      sorted.forEach((n, idx) => {
        const targetX = Math.round(minX + idx * step);
        if (n.x !== targetX) ops.push({ type: 'node.update', params: { id: n.id, x: targetX } });
      });
    } else if (action === 'distributeV') {
      const sorted = [...nodes].sort((a, b) => a.y - b.y);
      const minY = sorted[0].y, maxY = sorted[sorted.length - 1].y;
      const step = (maxY - minY) / (sorted.length - 1);
      sorted.forEach((n, idx) => {
        const targetY = Math.round(minY + idx * step);
        if (n.y !== targetY) ops.push({ type: 'node.update', params: { id: n.id, y: targetY } });
      });
    }

    alignSelect.value = '';
    if (ops.length === 0) {
      localError = '所选节点已处于该对齐状态，无须调整。'; renderControls(); return;
    }
    if (ops.length > 50) {
      localError = '单次最多 50 项操作，超过批次上限。'; renderControls(); return;
    }

    emit(ops);
  }

  function clamp(value) { return Math.max(-100000, Math.min(100000, value)); }

  function computeGroupDelta(nodes, requestedDeltaX, requestedDeltaY) {
    if (!nodes || nodes.length === 0) return { effectiveDeltaX: 0, effectiveDeltaY: 0 };
    const minX = Math.min(...nodes.map(n => n.startX !== undefined ? n.startX : n.x));
    const maxX = Math.max(...nodes.map(n => n.startX !== undefined ? n.startX : n.x));
    const minY = Math.min(...nodes.map(n => n.startY !== undefined ? n.startY : n.y));
    const maxY = Math.max(...nodes.map(n => n.startY !== undefined ? n.startY : n.y));

    const minAllowedDeltaX = -100000 - minX;
    const maxAllowedDeltaX = 100000 - maxX;
    const minAllowedDeltaY = -100000 - minY;
    const maxAllowedDeltaY = 100000 - maxY;

    let effectiveDeltaX = requestedDeltaX;
    if (minAllowedDeltaX <= maxAllowedDeltaX) {
      effectiveDeltaX = Math.max(minAllowedDeltaX, Math.min(maxAllowedDeltaX, requestedDeltaX));
    } else {
      effectiveDeltaX = 0;
    }

    let effectiveDeltaY = requestedDeltaY;
    if (minAllowedDeltaY <= maxAllowedDeltaY) {
      effectiveDeltaY = Math.max(minAllowedDeltaY, Math.min(maxAllowedDeltaY, requestedDeltaY));
    } else {
      effectiveDeltaY = 0;
    }

    return { effectiveDeltaX, effectiveDeltaY };
  }
  function transform() {
    viewport.setAttribute('transform', `translate(${pan.x} ${pan.y}) scale(${zoom})`);
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }
  function scale(factor, point) {
    const next = Math.max(0.2, Math.min(3, zoom * factor));
    const anchor = point || { x: (svg.getBoundingClientRect().width || 360) / 2, y: (svg.getBoundingClientRect().height || 260) / 2 };
    pan = { x: anchor.x - (anchor.x - pan.x) * next / zoom, y: anchor.y - (anchor.y - pan.y) * next / zoom };
    zoom = next; transform();
  }
  function fit() {
    if (!valid || !document.graph.nodes.length) { zoom = 1; pan = { x: 24, y: 24 }; transform(); return; }
    const nodes = document.graph.nodes;
    const minX = Math.min(...nodes.map(node => node.x)), minY = Math.min(...nodes.map(node => node.y));
    const width = Math.max(...nodes.map(node => node.x)) - minX + WIDTH;
    const height = Math.max(...nodes.map(node => node.y)) - minY + HEIGHT;
    const rect = svg.getBoundingClientRect(), availableWidth = rect.width || 360, availableHeight = rect.height || 260;
    zoom = Math.max(0.2, Math.min(1.5, (availableWidth - 40) / width, (availableHeight - 40) / height));
    pan = { x: (availableWidth - width * zoom) / 2 - minX * zoom, y: (availableHeight - height * zoom) / 2 - minY * zoom };
    transform();
  }

  function position(node) {
    if (drag?.kind === 'nodes' && drag.moved && drag.preview[node.id]) {
      return drag.preview[node.id];
    }
    return node;
  }

  function edgePoints(edge) {
    const from = position(document.graph.nodes.find(node => node.id === edge.from));
    const to = position(document.graph.nodes.find(node => node.id === edge.to));
    const dx = to.x - from.x, dy = to.y - from.y;
    const ratio = Math.min(dx ? WIDTH / 2 / Math.abs(dx) : Infinity, dy ? HEIGHT / 2 / Math.abs(dy) : Infinity, 0.49);
    return { x1: from.x + WIDTH / 2 + dx * ratio, y1: from.y + HEIGHT / 2 + dy * ratio,
      x2: to.x + WIDTH / 2 - dx * ratio, y2: to.y + HEIGHT / 2 - dy * ratio };
  }

  function renderPositions() {
    if (!valid) return;
    for (const domNode of viewport.querySelectorAll('[data-node-id]')) {
      const node = position(document.graph.nodes.find(item => item.id === domNode.dataset.nodeId));
      domNode.setAttribute('transform', `translate(${node.x} ${node.y})`);
    }
    for (const domNode of viewport.querySelectorAll('[data-edge-id]')) {
      const edge = document.graph.edges.find(item => item.id === domNode.dataset.edgeId), points = edgePoints(edge);
      for (const line of domNode.querySelectorAll('line')) for (const [key, value] of Object.entries(points)) line.setAttribute(key, value);
      const text = domNode.querySelector('text');
      if (text) { text.setAttribute('x', (points.x1 + points.x2) / 2); text.setAttribute('y', (points.y1 + points.y2) / 2 - 8); }
    }
  }

  function renderGraph() {
    viewport.replaceChildren();
    if (!valid) return;
    for (const edge of document.graph.edges) {
      const group = svgElement('g', { class: 'collab-edge', 'data-edge-id': edge.id, tabindex: '0', role: 'button', 'aria-label': `连线：${edge.from} → ${edge.to}${edge.label ? `，${edge.label}` : ''}` });
      group.append(svgElement('line', { class: 'collab-edge-hit' }), svgElement('line', { class: 'collab-edge-line', 'marker-end': `url(#${markerId})` }));
      if (edge.label) { const text = svgElement('text', { 'text-anchor': 'middle' }); text.textContent = edge.label.length > 24 ? `${edge.label.slice(0, 23)}…` : edge.label; group.append(text); }
      const title = svgElement('title'); title.textContent = edge.label || `${edge.from} → ${edge.to}`; group.append(title); viewport.append(group);
    }
    for (const node of document.graph.nodes) {
      const group = svgElement('g', { class: 'collab-node', 'data-node-id': node.id, tabindex: '0', role: 'button', 'aria-label': `节点：${node.label}` });
      group.append(svgElement('rect', { width: WIDTH, height: HEIGHT, rx: '7' }));
      const title = svgElement('title'); title.textContent = node.label; group.append(title);
      const text = svgElement('text', { x: WIDTH / 2, y: 26, 'text-anchor': 'middle' });
      const characters = Array.from(node.label), lines = [];
      for (let i = 0; i < Math.min(characters.length, 22); i += 11) lines.push(characters.slice(i, i + 11).join(''));
      if (characters.length > 22) lines[1] = `${lines[1].slice(0, -1)}…`;
      lines.forEach((line, index) => { const span = svgElement('tspan', { x: WIDTH / 2, dy: index ? '18' : '0' }); span.textContent = line; text.append(span); });
      group.append(text); viewport.append(group);
    }
    renderPositions(); renderSelection();
  }

  function renderSelection() {
    for (const domNode of viewport.querySelectorAll('[data-node-id]')) {
      const active = selection.has('node', domNode.dataset.nodeId);
      domNode.classList.toggle('is-selected', active); domNode.setAttribute('aria-pressed', String(active));
    }
    for (const domNode of viewport.querySelectorAll('[data-edge-id]')) {
      const active = selection.has('edge', domNode.dataset.edgeId);
      domNode.classList.toggle('is-selected', active); domNode.setAttribute('aria-pressed', String(active));
    }

    const count = selection.count();
    const pri = selection.primary();
    const item = currentItem();

    if (count === 0) {
      selectionLabel.textContent = '选择节点或连线以编辑';
    } else if (count === 1) {
      selectionLabel.textContent = item ? `${pri.kind === 'node' ? '节点' : '连线'} · ${item.id}` : '选择节点或连线以编辑';
    } else {
      selectionLabel.textContent = selection.describe();
    }

    // 单项编辑与连线
    const isSingle = count === 1 && item !== null;
    const isSingleNode = isSingle && pri.kind === 'node';
    editForm.hidden = !isSingle;
    connectForm.hidden = !isSingleNode;
    alignForm.hidden = selection.nodeCount() < 2;

    labelInput.value = isSingle ? (item.label || '') : '';

    const previous = targetSelect.value; targetSelect.replaceChildren();
    if (valid && isSingleNode) {
      for (const node of document.graph.nodes) {
        if (node.id === pri.id) continue;
        const option = element('option', '', node.label); option.value = node.id; targetSelect.append(option);
      }
    }
    if ([...targetSelect.options].some(option => option.value === previous)) targetSelect.value = previous;

    renderControls();
  }

  function renderControls() {
    const disabled = !writable(), item = currentItem(), count = selection.count();
    root.setAttribute('aria-busy', String(busy));
    root.dataset.readonly = String(readOnly);

    add.disabled = disabled || document.graph.nodes.length >= 200;
    undo.disabled = disabled || !canUndo; redo.disabled = disabled || !canRedo;

    copyBtn.disabled = disabled || selection.nodeCount() === 0;
    pasteBtn.disabled = disabled || !clipboard || !clipboard.nodes.length;

    save.disabled = labelInput.disabled = disabled || count !== 1 || !item;
    remove.disabled = disabled || count === 0;

    targetSelect.disabled = edgeLabel.disabled = connect.disabled = disabled || count !== 1 || selection.primary()?.kind !== 'node' || !targetSelect.options.length || document.graph.edges.length >= 400;

    alignSelect.disabled = applyAlignBtn.disabled = disabled || selection.nodeCount() < 2;

    const message = !valid ? '画布数据无效或尚未加载。' : (typeof error === 'string' ? error : error ? '操作失败，请刷新后重试。' : localError);
    alert.textContent = message; alert.hidden = !message;
    status.textContent = valid ? `版本 ${document.revision} · ${document.graph.nodes.length} 节点 · ${document.graph.edges.length} 连线${readOnly ? ' · 只读' : ''}${busy ? ' · 处理中' : ''}` : '画布不可编辑';
    empty.hidden = !valid || document.graph.nodes.length > 0;
  }

  function choose(target, { toggle = false } = {}) {
    const node = target.closest?.('[data-node-id]'), edge = target.closest?.('[data-edge-id]');
    if (node) {
      const id = node.dataset.nodeId;
      if (toggle) selection.toggle('node', id);
      else selection.selectOne('node', id);
    } else if (edge) {
      const id = edge.dataset.edgeId;
      if (toggle) selection.toggle('edge', id);
      else selection.selectOne('edge', id);
    } else {
      if (!toggle) selection.clear();
    }
    renderSelection();
    return node || edge;
  }

  listen(editForm, 'submit', event => { event.preventDefault(); saveLabel(); });
  listen(connectForm, 'submit', event => { event.preventDefault(); addEdge(); });
  listen(alignForm, 'submit', event => { event.preventDefault(); applyAlignment(); });

  listen(svg, 'click', event => {
    if (!alive) return;
    if (suppressClick) {
      suppressClick = false;
      pointerAction = null;
      return;
    }
    const action = pointerAction;
    pointerAction = null;

    if (action?.type === 'handled') {
      return;
    }
    if (action?.type === 'deferSingleSelect') {
      selection.selectOne(action.kind, action.id);
      renderSelection();
      return;
    }

    const isToggle = event.ctrlKey || event.metaKey;
    choose(event.target, { toggle: isToggle });
  });

  listen(svg, 'focusin', event => {
    if (restoringFocus) return;
    const node = event.target.closest?.('[data-node-id]');
    const edge = event.target.closest?.('[data-edge-id]');
    if (node) {
      const id = node.dataset.nodeId;
      if (!selection.has('node', id)) {
        choose(event.target);
      }
    } else if (edge) {
      const id = edge.dataset.edgeId;
      if (!selection.has('edge', id)) {
        choose(event.target);
      }
    }
  });

  listen(svg, 'dblclick', event => {
    if (choose(event.target) && writable() && selection.count() === 1) {
      labelInput.focus(); labelInput.select();
    }
  });

  listen(svg, 'pointerdown', event => {
    if (!alive || !valid || event.button !== 0 || confirming) return;
    suppressClick = false;
    pointerAction = null;

    const targetNode = event.target.closest?.('[data-node-id]');
    const targetEdge = event.target.closest?.('[data-edge-id]');
    const isToggle = event.ctrlKey || event.metaKey;
    const isShift = event.shiftKey;

    if (targetEdge) {
      const edgeId = targetEdge.dataset.edgeId;
      if (isToggle) {
        selection.toggle('edge', edgeId);
      } else {
        selection.selectOne('edge', edgeId);
      }
      renderSelection();
      pointerAction = { type: 'handled' };
      return;
    }

    if (targetNode) {
      if (!writable()) return;
      const nodeId = targetNode.dataset.nodeId;

      if (isToggle) {
        selection.toggle('node', nodeId);
        renderSelection();
        pointerAction = { type: 'handled' };
      } else if (!selection.has('node', nodeId)) {
        selection.selectOne('node', nodeId);
        renderSelection();
        pointerAction = { type: 'handled' };
      } else {
        pointerAction = { type: 'deferSingleSelect', kind: 'node', id: nodeId };
      }

      // 如果当前选中包含节点，准备批量拖拽
      const selectedNodes = document.graph.nodes.filter(n => selection.has('node', n.id));
      if (selectedNodes.length > 0) {
        drag = {
          kind: 'nodes',
          startX: event.clientX,
          startY: event.clientY,
          nodes: selectedNodes.map(n => ({ id: n.id, startX: n.x, startY: n.y })),
          preview: {},
          generation,
          moved: false,
          pointerId: event.pointerId,
        };
        svg.focus();
        event.preventDefault();
      }
      return;
    }

    // 点击空白处
    if (isShift) {
      // Shift+拖动空白区域：框选
      const rect = svg.getBoundingClientRect();
      const startGraphX = (event.clientX - (rect.left || 0) - pan.x) / zoom;
      const startGraphY = (event.clientY - (rect.top || 0) - pan.y) / zoom;
      drag = {
        kind: 'box',
        startX: event.clientX,
        startY: event.clientY,
        startGraphX,
        startGraphY,
        generation,
        pointerId: event.pointerId,
        moved: false,
      };
      marquee.hidden = false;
      marquee.setAttribute('x', event.clientX - (rect.left || 0));
      marquee.setAttribute('y', event.clientY - (rect.top || 0));
      marquee.setAttribute('width', 0);
      marquee.setAttribute('height', 0);
      svg.focus();
      event.preventDefault();
      return;
    }

    // 普通拖动空白处：平移画布
    if (!isToggle) {
      selection.clear();
      renderSelection();
      pointerAction = { type: 'handled' };
    }
    drag = {
      kind: 'pan',
      startX: event.clientX,
      startY: event.clientY,
      pan: { ...pan },
      generation,
      moved: false,
      pointerId: event.pointerId,
    };
    svg.focus();
    event.preventDefault();
  });

  listen(dom, 'pointermove', event => {
    if (!alive || !drag || (drag.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;

    if (drag.kind === 'box') {
      if (Math.hypot(dx, dy) >= 3) {
        drag.moved = true;
      }
      const rect = svg.getBoundingClientRect();
      const curX = event.clientX - (rect.left || 0);
      const curY = event.clientY - (rect.top || 0);
      const startX = drag.startX - (rect.left || 0);
      const startY = drag.startY - (rect.top || 0);
      const rx = Math.min(startX, curX), ry = Math.min(startY, curY);
      const rw = Math.abs(curX - startX), rh = Math.abs(curY - startY);
      marquee.setAttribute('x', rx);
      marquee.setAttribute('y', ry);
      marquee.setAttribute('width', rw);
      marquee.setAttribute('height', rh);
      return;
    }

    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 3) return;
    drag.moved = true;

    if (drag.kind === 'pan') {
      pan = { x: drag.pan.x + dx, y: drag.pan.y + dy };
      transform();
    } else if (drag.kind === 'nodes') {
      const deltaX = Math.round(dx / zoom);
      const deltaY = Math.round(dy / zoom);
      const { effectiveDeltaX, effectiveDeltaY } = computeGroupDelta(drag.nodes, deltaX, deltaY);
      for (const node of drag.nodes) {
        drag.preview[node.id] = {
          x: node.startX + effectiveDeltaX,
          y: node.startY + effectiveDeltaY,
        };
      }
      renderPositions();
    }
  });

  listen(dom, 'pointerup', event => {
    if (!drag || (drag.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
    const finished = drag; drag = null; suppressClick = finished.moved;

    if (finished.kind === 'box') {
      suppressClick = true;
      marquee.hidden = true;
      const rect = svg.getBoundingClientRect();
      const endGraphX = (event.clientX - (rect.left || 0) - pan.x) / zoom;
      const endGraphY = (event.clientY - (rect.top || 0) - pan.y) / zoom;
      const boxRect = {
        x: Math.min(finished.startGraphX, endGraphX),
        y: Math.min(finished.startGraphY, endGraphY),
        width: Math.abs(endGraphX - finished.startGraphX),
        height: Math.abs(endGraphY - finished.startGraphY),
      };
      const hitIds = hitTestRect(document.graph, boxRect, WIDTH, HEIGHT);
      for (const hitId of hitIds) {
        selection.add('node', hitId);
      }
      renderSelection();
      return;
    }

    renderPositions();

    if (finished.kind === 'nodes' && finished.moved && finished.generation === generation) {
      const ops = [];
      for (const node of finished.nodes) {
        const prev = finished.preview[node.id];
        if (prev && (prev.x !== node.startX || prev.y !== node.startY)) {
          ops.push({ type: 'node.update', params: { id: node.id, ...prev } });
        }
      }
      if (ops.length > 50) {
        localError = '单次最多 50 项操作，无法批量移动。';
        renderControls();
      } else if (ops.length > 0) {
        emit(ops);
      }
    }
  });

  listen(dom, 'pointercancel', () => {
    if (drag?.kind === 'box') marquee.hidden = true;
    drag = null; suppressClick = false; pointerAction = null; renderPositions();
  });
  listen(dom.defaultView, 'blur', () => {
    if (drag?.kind === 'box') marquee.hidden = true;
    drag = null; pointerAction = null; renderPositions();
  });

  listen(svg, 'wheel', event => {
    if (!alive) return;
    event.preventDefault(); const rect = svg.getBoundingClientRect();
    scale(event.deltaY < 0 ? 1.1 : 1 / 1.1, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, { passive: false });

  listen(root, 'keydown', event => {
    if (!alive || event.target.matches?.('input,select,textarea') || event.target.isContentEditable) return;
    const key = event.key.toLowerCase();
    const ctrl = event.ctrlKey || event.metaKey;

    // 撤销 / 重做
    if (ctrl && (key === 'z' || key === 'y')) {
      event.preventDefault(); const forward = key === 'y' || event.shiftKey;
      if (writable() && (forward ? canRedo : canUndo)) invoke(forward ? onRedo : onUndo); return;
    }

    // Ctrl+A 全选节点
    if (ctrl && key === 'a') {
      if (svg.contains(event.target) || root.contains(event.target)) {
        event.preventDefault();
        selection.selectAllNodes(document.graph);
        renderSelection();
        return;
      }
    }

    // 复制 (Ctrl+C)
    if (ctrl && key === 'c') {
      event.preventDefault();
      copySelected();
      return;
    }

    // 粘贴 (Ctrl+V)
    if (ctrl && key === 'v') {
      event.preventDefault();
      pasteClipboard();
      return;
    }

    // 副本 (Ctrl+D)
    if (ctrl && key === 'd') {
      event.preventDefault();
      duplicateSelected();
      return;
    }

    // 取消 / 清空选择
    if (event.key === 'Escape') {
      if (drag?.kind === 'box') marquee.hidden = true;
      drag = null;
      pointerAction = null;
      renderPositions();
      if (confirming) { cancelDelete(); return; }
      if (selection.count() > 0) { selection.clear(); renderSelection(); return; }
      return;
    }

    // 删除
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault(); requestDelete(); return;
    }

    // 编辑文字
    if ((event.key === 'Enter' || event.key === 'F2') && svg.contains(event.target)) {
      event.preventDefault();
      if (event.target.closest?.('[data-node-id],[data-edge-id]')) choose(event.target);
      if (writable() && currentItem() && selection.count() === 1) {
        labelInput.focus(); labelInput.select();
      }
      return;
    }

    if (!svg.contains(event.target)) return;

    // 方向键移动所选节点或平移画布
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (direction) {
      event.preventDefault();
      const nodeElement = event.target.closest?.('[data-node-id]');
      if (nodeElement && !selection.has('node', nodeElement.dataset.nodeId)) {
        choose(nodeElement);
      }
      const selNodeIds = selection.nodeIds();
      if (selNodeIds.length > 0) {
        const step = event.shiftKey ? 1 : 10;
        const nodesToMove = document.graph.nodes.filter(n => selNodeIds.includes(n.id));
        if (nodesToMove.length > 50) {
          localError = '单次最多 50 项操作，无法批量移动。'; renderControls(); return;
        }
        const { effectiveDeltaX, effectiveDeltaY } = computeGroupDelta(
          nodesToMove.map(n => ({ startX: n.x, startY: n.y })),
          direction[0] * step,
          direction[1] * step
        );
        if (effectiveDeltaX === 0 && effectiveDeltaY === 0) {
          return;
        }
        const ops = nodesToMove.map(node => ({
          type: 'node.update',
          params: { id: node.id, x: node.x + effectiveDeltaX, y: node.y + effectiveDeltaY },
        }));
        if (writable()) emit(ops);
      } else {
        pan.x += direction[0] * 30; pan.y += direction[1] * 30; transform();
      }
    } else if (event.key === '+' || event.key === '=') { event.preventDefault(); scale(1.2); }
    else if (event.key === '-') { event.preventDefault(); scale(1 / 1.2); }
    else if (event.key === '0') { event.preventDefault(); fit(); }
  });

  function update(next = {}) {
    if (!alive) return;
    generation++; drag = null; pendingDelete = null; confirming = false; confirmation.hidden = true; localError = ''; suppressClick = false; pointerAction = null;
    const focused = dom.activeElement;
    const focusId = focused?.dataset?.nodeId || focused?.dataset?.edgeId;
    const oldId = document?.documentId;
    if (Object.hasOwn(next, 'document')) document = next.document;
    for (const key of ['readOnly', 'busy', 'error', 'canUndo', 'canRedo']) {
      if (!Object.hasOwn(next, key)) continue;
      if (key === 'readOnly') readOnly = !!next.readOnly;
      if (key === 'busy') busy = !!next.busy;
      if (key === 'error') error = next.error;
      if (key === 'canUndo') canUndo = !!next.canUndo;
      if (key === 'canRedo') canRedo = !!next.canRedo;
    }
    valid = validGraph(document);

    // 会话/文档变化时重置剪贴板与选择
    if (!valid || oldId !== document?.documentId) {
      selection.clear();
      clipboard = null;
      pasteCount = 0;
    } else {
      // 保持现存选中项，修剪被删除项
      selection.prune(document.graph);
    }

    renderGraph(); renderSelection(); transform();
    if (valid && (firstRender || oldId !== document.documentId)) fit();
    firstRender = false;
    if (focusId && oldId === document?.documentId) {
      const replacement = [...viewport.querySelectorAll('[data-node-id],[data-edge-id]')].find(domNode => (domNode.dataset.nodeId || domNode.dataset.edgeId) === focusId);
      restoringFocus = true;
      try {
        (replacement || svg).focus();
      } finally {
        restoringFocus = false;
      }
    }
  }

  update({});
  return {
    update,
    destroy() {
      if (!alive) return;
      alive = false; generation++; drag = null; pendingDelete = null; pointerAction = null;
      for (const dispose of listeners.splice(0)) dispose();
      root.remove(); document = null; selection.clear(); clipboard = null;
    },
  };
}
