/* A controlled graph view. Only the owner commits intents and owns history. */
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
  let alive = true, generation = 0, selected = null, drag = null, pendingDelete = null, confirming = false;
  let valid = false, suppressClick = false, localError = '';
  let firstRender = true;
  let zoom = 1, pan = { x: 24, y: 24 };
  const markerId = `collab-arrow-${++instanceNumber}`;
  const element = (tag, className, text) => {
    const el = dom.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const svgElement = (tag, attrs = {}) => {
    const el = dom.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  };
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };
  const root = element('section', 'collab-canvas');
  root.setAttribute('aria-label', '协同编辑画布');
  const toolbar = element('div', 'collab-toolbar');
  toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', '画布操作');
  const button = (parent, text, handler) => {
    const el = element('button', '', text); el.type = 'button';
    listen(el, 'click', () => { if (alive && !el.disabled) handler(); });
    parent.append(el); return el;
  };
  const add = button(toolbar, '新增节点', addNode);
  const undo = button(toolbar, '撤销', () => invoke(onUndo));
  const redo = button(toolbar, '重做', () => invoke(onRedo));
  button(toolbar, '缩小', () => scale(1 / 1.2));
  const zoomLabel = element('output', 'collab-zoom', '100%');
  zoomLabel.setAttribute('aria-label', '缩放比例'); toolbar.append(zoomLabel);
  button(toolbar, '放大', () => scale(1.2));
  button(toolbar, '适应画布', fit);
  const status = element('p', 'collab-status'); status.setAttribute('role', 'status');
  const alert = element('p', 'collab-error'); alert.setAttribute('role', 'alert');
  const help = element('p', 'collab-help', '拖动节点或空白处；滚轮缩放。Tab 选择，Enter 编辑，Delete 删除；方向键移动节点或平移画布。');
  help.id = `${markerId}-help`;
  const svg = svgElement('svg', { class: 'collab-stage', tabindex: '0', role: 'group', 'aria-label': '节点与有向连线', 'aria-describedby': help.id });
  const defs = svgElement('defs');
  const marker = svgElement('marker', { id: markerId, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
  marker.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z' })); defs.append(marker);
  const viewport = svgElement('g', { class: 'collab-viewport' });
  svg.append(defs, viewport);
  const empty = element('p', 'collab-empty', '画布为空。新增节点开始绘制。');
  const editor = element('div', 'collab-inspector');
  const selectionLabel = element('p', 'collab-selection', '选择节点或连线以编辑');
  const editForm = element('form', 'collab-edit-form');
  const labelWrap = element('label', '', '所选文字');
  const labelInput = element('input'); labelInput.name = 'label'; labelInput.maxLength = 200;
  labelWrap.append(labelInput); editForm.append(labelWrap);
  const save = button(editForm, '保存文字', saveLabel);
  const remove = button(editor, '删除所选', requestDelete);
  const connectForm = element('form', 'collab-connect-form');
  const targetWrap = element('label', '', '连接到');
  const targetSelect = element('select'); targetSelect.name = 'edgeTarget'; targetWrap.append(targetSelect);
  const edgeWrap = element('label', '', '连线文字（可选）');
  const edgeLabel = element('input'); edgeLabel.name = 'edgeLabel'; edgeLabel.maxLength = 200; edgeWrap.append(edgeLabel);
  connectForm.append(targetWrap, edgeWrap);
  const connect = button(connectForm, '新增连线', addEdge);
  editor.prepend(selectionLabel, editForm); editor.append(connectForm);
  const confirmation = element('div', 'collab-confirm'); confirmation.hidden = true;
  confirmation.setAttribute('role', 'group'); confirmation.setAttribute('aria-label', '删除确认');
  const confirmationText = element('p'); confirmation.append(confirmationText);
  const confirm = button(confirmation, '确认删除', () => finishDelete(pendingDelete, true));
  button(confirmation, '取消', cancelDelete);
  root.append(toolbar, status, alert, svg, empty, editor, confirmation, help);
  host.append(root);

  function writable() { return alive && valid && !readOnly && !busy && !error && !confirming; }
  function currentItem() {
    if (!valid || !selected) return null;
    return (selected.kind === 'node' ? document.graph.nodes : document.graph.edges).find(item => item.id === selected.id) || null;
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
    emit([{ type: 'node.add', params: { id: id('n'), label: '新节点', x: clamp(x), y: clamp(y) } }]);
  }
  function saveLabel() {
    const item = currentItem();
    if (!writable() || !item) return;
    const label = labelInput.value.trim();
    if (label.length > 200 || (selected.kind === 'node' && !label)) {
      localError = '节点文字须为 1–200 字符。'; renderControls(); labelInput.focus(); return;
    }
    if (label === (item.label || '')) return;
    emit([{ type: `${selected.kind}.update`, params: { id: item.id, label: label || null } }]);
  }
  function addEdge() {
    const item = currentItem();
    if (!writable() || selected?.kind !== 'node' || !item || document.graph.edges.length >= 400) return;
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
    if (accepted === true && writable()) emit(request.operations);
    renderControls(); remove.focus();
  }
  function requestDelete() {
    const item = currentItem();
    if (!writable() || !item) return;
    const edges = selected.kind === 'node' ? document.graph.edges.filter(edge => edge.from === item.id || edge.to === item.id) : [];
    if (edges.length >= 50) {
      localError = '单次最多 50 项操作，请先分批删除连线。'; renderControls(); return;
    }
    const operations = [...edges.map(edge => ({ type: 'edge.remove', params: { id: edge.id } })), { type: `${selected.kind}.remove`, params: { id: item.id } }];
    const message = selected.kind === 'node' ? `删除节点“${item.label}”及其 ${edges.length} 条连线？` : '删除所选连线？';
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
  function clamp(value) { return Math.max(-100000, Math.min(100000, value)); }
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
    return drag?.kind === 'node' && drag.id === node.id && drag.moved ? drag.preview : node;
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
    for (const el of viewport.querySelectorAll('[data-node-id]')) {
      const node = position(document.graph.nodes.find(item => item.id === el.dataset.nodeId));
      el.setAttribute('transform', `translate(${node.x} ${node.y})`);
    }
    for (const el of viewport.querySelectorAll('[data-edge-id]')) {
      const edge = document.graph.edges.find(item => item.id === el.dataset.edgeId), points = edgePoints(edge);
      for (const line of el.querySelectorAll('line')) for (const [key, value] of Object.entries(points)) line.setAttribute(key, value);
      const text = el.querySelector('text');
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
    for (const el of viewport.querySelectorAll('[data-node-id],[data-edge-id]')) {
      const active = selected?.id === (el.dataset.nodeId || el.dataset.edgeId);
      el.classList.toggle('is-selected', active); el.setAttribute('aria-pressed', String(active));
    }
    const item = currentItem();
    selectionLabel.textContent = item ? `${selected.kind === 'node' ? '节点' : '连线'} · ${item.id}` : '选择节点或连线以编辑';
    labelInput.value = item?.label || '';
    const previous = targetSelect.value; targetSelect.replaceChildren();
    if (valid && selected?.kind === 'node') for (const node of document.graph.nodes) {
      if (node.id === selected.id) continue;
      const option = element('option', '', node.label); option.value = node.id; targetSelect.append(option);
    }
    if ([...targetSelect.options].some(option => option.value === previous)) targetSelect.value = previous;
    renderControls();
  }
  function renderControls() {
    const disabled = !writable(), item = currentItem();
    root.setAttribute('aria-busy', String(busy));
    root.dataset.readonly = String(readOnly);
    add.disabled = disabled || document.graph.nodes.length >= 200;
    undo.disabled = disabled || !canUndo; redo.disabled = disabled || !canRedo;
    save.disabled = remove.disabled = labelInput.disabled = disabled || !item;
    targetSelect.disabled = edgeLabel.disabled = connect.disabled = disabled || selected?.kind !== 'node' || !targetSelect.options.length || document.graph.edges.length >= 400;
    const message = !valid ? '画布数据无效或尚未加载。' : (typeof error === 'string' ? error : error ? '操作失败，请刷新后重试。' : localError);
    alert.textContent = message; alert.hidden = !message;
    status.textContent = valid ? `版本 ${document.revision} · ${document.graph.nodes.length} 节点 · ${document.graph.edges.length} 连线${readOnly ? ' · 只读' : ''}${busy ? ' · 处理中' : ''}` : '画布不可编辑';
    empty.hidden = !valid || document.graph.nodes.length > 0;
  }
  function choose(target) {
    const node = target.closest?.('[data-node-id]'), edge = target.closest?.('[data-edge-id]');
    selected = node ? { kind: 'node', id: node.dataset.nodeId } : edge ? { kind: 'edge', id: edge.dataset.edgeId } : null;
    renderSelection(); return node || edge;
  }
  listen(editForm, 'submit', event => { event.preventDefault(); saveLabel(); });
  listen(connectForm, 'submit', event => { event.preventDefault(); addEdge(); });
  listen(svg, 'click', event => { if (!alive || suppressClick) { suppressClick = false; return; } choose(event.target); });
  listen(svg, 'focusin', event => { if (event.target.closest?.('[data-node-id],[data-edge-id]')) choose(event.target); });
  listen(svg, 'dblclick', event => { if (choose(event.target) && writable()) { labelInput.focus(); labelInput.select(); } });
  listen(svg, 'pointerdown', event => {
    if (!alive || !valid || event.button !== 0 || confirming) return;
    suppressClick = false;
    const item = choose(event.target);
    if (item?.dataset.edgeId) return;
    if (item && !writable()) return;
    const node = item ? currentItem() : null;
    drag = { kind: node ? 'node' : 'pan', id: node?.id, startX: event.clientX, startY: event.clientY, x: node?.x, y: node?.y, pan: { ...pan }, generation, moved: false, pointerId: event.pointerId };
    svg.focus(); event.preventDefault();
  });
  listen(dom, 'pointermove', event => {
    if (!alive || !drag || (drag.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    if (drag.kind === 'pan') { pan = { x: drag.pan.x + dx, y: drag.pan.y + dy }; transform(); }
    else { drag.preview = { x: clamp(Math.round(drag.x + dx / zoom)), y: clamp(Math.round(drag.y + dy / zoom)) }; renderPositions(); }
  });
  listen(dom, 'pointerup', event => {
    if (!drag || (drag.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
    const finished = drag; drag = null; suppressClick = finished.moved;
    renderPositions();
    if (finished.kind === 'node' && finished.moved && finished.generation === generation && (finished.preview.x !== finished.x || finished.preview.y !== finished.y))
      emit([{ type: 'node.update', params: { id: finished.id, ...finished.preview } }]);
  });
  listen(dom, 'pointercancel', () => { drag = null; suppressClick = false; renderPositions(); });
  listen(dom.defaultView, 'blur', () => { drag = null; renderPositions(); });
  listen(svg, 'wheel', event => {
    if (!alive) return;
    event.preventDefault(); const rect = svg.getBoundingClientRect();
    scale(event.deltaY < 0 ? 1.1 : 1 / 1.1, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, { passive: false });
  listen(root, 'keydown', event => {
    if (!alive || event.target.matches?.('input,select,textarea') || event.target.isContentEditable) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y')) {
      event.preventDefault(); const forward = key === 'y' || event.shiftKey;
      if (writable() && (forward ? canRedo : canUndo)) invoke(forward ? onRedo : onUndo); return;
    }
    if (event.key === 'Escape') { drag = null; renderPositions(); cancelDelete(); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); requestDelete(); return; }
    if ((event.key === 'Enter' || event.key === 'F2') && svg.contains(event.target)) {
      event.preventDefault();
      if (event.target.closest?.('[data-node-id],[data-edge-id]')) choose(event.target);
      if (writable() && currentItem()) { labelInput.focus(); labelInput.select(); } return;
    }
    if (!svg.contains(event.target)) return;
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (direction) {
      event.preventDefault(); const nodeElement = event.target.closest?.('[data-node-id]');
      if (nodeElement) {
        choose(nodeElement); const node = currentItem(), step = event.shiftKey ? 1 : 10;
        if (writable()) emit([{ type: 'node.update', params: { id: node.id, x: clamp(node.x + direction[0] * step), y: clamp(node.y + direction[1] * step) } }]);
      } else { pan.x += direction[0] * 30; pan.y += direction[1] * 30; transform(); }
    } else if (event.key === '+' || event.key === '=') { event.preventDefault(); scale(1.2); }
    else if (event.key === '-') { event.preventDefault(); scale(1 / 1.2); }
    else if (event.key === '0') { event.preventDefault(); fit(); }
  });

  function update(next = {}) {
    if (!alive) return;
    generation++; drag = null; pendingDelete = null; confirming = false; confirmation.hidden = true; localError = ''; suppressClick = false;
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
    if (!valid || oldId !== document?.documentId) selected = null;
    if (!currentItem()) selected = null;
    renderGraph(); renderSelection(); transform();
    if (valid && (firstRender || oldId !== document.documentId)) fit();
    firstRender = false;
    if (focusId) {
      const replacement = [...viewport.querySelectorAll('[data-node-id],[data-edge-id]')].find(el => (el.dataset.nodeId || el.dataset.edgeId) === focusId);
      (replacement || svg).focus();
    }
  }
  update({});
  return {
    update,
    destroy() {
      if (!alive) return;
      alive = false; generation++; drag = null; pendingDelete = null;
      for (const dispose of listeners.splice(0)) dispose();
      root.remove(); document = null; selected = null;
    },
  };
}
