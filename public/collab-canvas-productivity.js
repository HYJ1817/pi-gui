// 协同画布生产力工具条 —— 自动整理 / 导出 SVG / 导出 PNG。
//
// Z4-4B 起正式接入：public/collab-panel.js 在协同文档面板挂载本模块（紧邻画布下方），
// 样式 public/collab-productivity.css 由 index.html 引入。
//
// 集成方式：与 mountCollabCanvas 同宿主并排挂载（不动 collab-canvas.js，
// 不新增图形协议，不加多用户协作）。与画布说同一种操作方言：
//   onOperations 只发 [{type,params}] 意图；上层（collab-panel）补 opId/baseRevision/actor=user，
//   与 Z4-2 契约「UI 边界」一致。applyLayoutPreview 生成的完整信封在此剥壳为意图，
//   revision 预检仍由 collab-layout-preview 完成，服务端 CAS 仍是权威。
//
// 安全边界：预览期间不保存；取消预览不改变文档；over-limit 只给明确状态不分批不静默应用；
// 导出由用户点击触发，结果经 onExport 交给宿主（本模块不下载、不写盘、不上传）。

import { createLayoutPreview, applyLayoutPreview, dismissLayoutPreview } from './collab-layout-preview.js';
import { exportFlowchart } from './collab-export.js';

export function mountCollabProductivity(host, {
  document: initialDocument = null, readOnly = false, busy = false,
  onOperations = () => {}, onExport = () => {}, onNotice = () => {},
  layoutOptions, exportOptions, confirmExport,
} = {}) {
  const dom = host.ownerDocument;
  const listeners = [];
  let document = initialDocument, isReadOnly = readOnly, isBusy = busy;
  let preview = null, alive = true, working = false;
  let noticeSequence = 0;

  const element = (tag, className, text) => {
    const node = dom.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  };
  const button = (parent, text, handler) => {
    const node = element('button', '', text); node.type = 'button';
    listen(node, 'click', () => { if (alive && !node.disabled) handler(); });
    parent.append(node); return node;
  };
  const notice = (message, level = 'info') => {
    if (!alive) return;
    onNotice({ message, level, sequence: ++noticeSequence });
  };

  const root = element('section', 'collab-productivity');
  root.setAttribute('aria-label', '画布生产力工具');
  const badge = element('p', 'collab-prod-badge', '自动整理与导出');
  const toolbar = element('div', 'collab-prod-toolbar');
  toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', '自动整理与导出');
  const autoButton = button(toolbar, '自动整理', startAutoLayout);
  const svgButton = button(toolbar, '导出 SVG', () => runExport('svg'));
  const pngButton = button(toolbar, '导出 PNG', () => runExport('png'));
  const directionWrap = element('label', 'collab-prod-field', '布局方向');
  const directionSelect = element('select'); directionSelect.name = 'layoutDirection';
  for (const [value, label] of [['LR', '从左到右'], ['TB', '从上到下']]) {
    const option = element('option', '', label); option.value = value; directionSelect.append(option);
  }
  directionWrap.append(directionSelect);
  const themeWrap = element('label', 'collab-prod-field', '导出背景');
  const themeSelect = element('select'); themeSelect.name = 'exportTheme';
  for (const [value, label] of [['light', '浅色'], ['dark', '深色'], ['transparent', '透明']]) {
    const option = element('option', '', label); option.value = value; themeSelect.append(option);
  }
  themeWrap.append(themeSelect);
  toolbar.append(directionWrap, themeWrap);
  const status = element('p', 'collab-prod-status'); status.setAttribute('role', 'status');
  const previewPanel = element('div', 'collab-prod-preview'); previewPanel.hidden = true;
  previewPanel.setAttribute('role', 'group'); previewPanel.setAttribute('aria-label', '自动布局预览');
  const previewText = element('p'); previewPanel.append(previewText);
  const confirmButton = button(previewPanel, '确认应用布局', confirmLayout);
  button(previewPanel, '取消预览', cancelLayout);
  root.append(badge, toolbar, status, previewPanel);
  host.append(root);

  const usable = () => alive && document && !isReadOnly && !isBusy && !working;

  function startAutoLayout() {
    if (!usable()) { notice('当前状态不可自动整理。', 'warn'); return; }
    const created = createLayoutPreview(document, { ...layoutOptions, direction: directionSelect.value });
    if (!created.ok) { notice(`自动布局失败：${created.code}`, 'error'); return; }
    if (created.status === 'clean') { notice('画布已经是整理后的状态，无需移动节点。'); return; }
    preview = created;
    if (created.status === 'over-limit') {
      previewText.textContent = `需要移动 ${created.moveCount} 个节点，超过单批 50 条操作上限；` +
        '为避免部分静默保存，本轮不提供自动分批，请手动分区整理或等待大图事务方案。';
    } else {
      previewText.textContent = `自动整理预览：将移动 ${created.moveCount} 个节点（基于版本 ${created.baseRevision}）。预览期间不保存。`;
    }
    renderPreviewGraph();
    previewPanel.hidden = false;
    renderControls();
  }

  /* 只读图形预览：按建议坐标渲染节点与连线的静态 SVG（纯 DOM/textContent，无事件、
   * 不触碰权威文档、不引入新协议）。取消、确认、版本变化与销毁时随预览一并清理。 */
  function renderPreviewGraph() {
    previewPanel.querySelector('.collab-prod-preview-graph')?.remove();
    if (!preview || !document) return;
    const nodes = document.graph.nodes
      .map(node => ({ node, target: preview.positions[node.id] }))
      .filter(entry => entry.target);
    if (!nodes.length) return;
    const SVG = 'http://www.w3.org/2000/svg';
    const svgElement = (tag, className) => {
      const domNode = dom.createElementNS(SVG, tag);
      if (className) domNode.setAttribute('class', className);
      return domNode;
    };
    const minX = Math.min(...nodes.map(entry => entry.target.x)), minY = Math.min(...nodes.map(entry => entry.target.y));
    const maxX = Math.max(...nodes.map(entry => entry.target.x)) + 156, maxY = Math.max(...nodes.map(entry => entry.target.y)) + 64;
    const pad = 24;
    const svg = svgElement('svg', 'collab-prod-preview-graph');
    svg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '自动布局预览图');
    for (const edge of document.graph.edges) {
      const from = preview.positions[edge.from], to = preview.positions[edge.to];
      if (!from || !to) continue;
      const line = svgElement('line', 'collab-prod-preview-edge');
      line.setAttribute('x1', from.x + 78); line.setAttribute('y1', from.y + 32);
      line.setAttribute('x2', to.x + 78); line.setAttribute('y2', to.y + 32);
      svg.append(line);
    }
    for (const { node, target } of nodes) {
      const group = svgElement('g', 'collab-prod-preview-node');
      group.setAttribute('transform', `translate(${target.x} ${target.y})`);
      const rect = svgElement('rect');
      rect.setAttribute('width', '156'); rect.setAttribute('height', '64'); rect.setAttribute('rx', '7');
      const text = svgElement('text');
      text.setAttribute('x', '78'); text.setAttribute('y', '36'); text.setAttribute('text-anchor', 'middle');
      const characters = Array.from(node.label);
      text.textContent = characters.length > 12 ? `${characters.slice(0, 11).join('')}…` : node.label;
      group.append(rect, text);
      svg.append(group);
    }
    previewText.after(svg);
  }

  function confirmLayout() {
    if (!alive || !preview || !usable()) return;
    const intent = applyLayoutPreview(preview, document, { makeOpId: () => `prod-${globalThis.crypto.randomUUID()}` });
    if (!intent.ok) { notice(`应用布局失败：${intent.code}`, 'error'); return; }
    if (intent.status === 'unchanged' || !intent.ops.length) { notice('没有需要移动的节点。'); }
    else {
      // 与画布 onOperations 同方言：只发意图，信封由上层补全。
      // 宿主返回 false 表示本轮未实际接受（busy/只读/会话失效）：保留预览，不报成功。
      const accepted = onOperations(intent.ops.map(({ type, params }) => ({ type, params })));
      if (accepted === false) {
        notice('当前状态不可提交（保存中、只读或会话已变化），预览已保留。', 'warn');
        renderControls();
        return;
      }
      notice(`已提交 ${intent.opCount} 个节点的移动意图。`);
    }
    preview = null; previewPanel.hidden = true; renderPreviewGraph();
    renderControls();
  }

  function cancelLayout() {
    if (!alive) return;
    if (preview) dismissLayoutPreview(preview);
    preview = null; previewPanel.hidden = true; renderPreviewGraph();
    notice('已取消自动整理，文档保持不变。');
    renderControls();
  }

  async function runExport(format) {
    if (!alive || !document) { notice('当前没有可导出的文档。', 'warn'); return; }
    if (working) return;
    // 绑定导出开始时的文档身份：异步导出期间文档变化时，产物与文件名都使用这份快照，
    // 保证内容与版本号一致（选择「使用原始快照」而非取消旧导出）。
    const source = { documentId: document.documentId, revision: document.revision, title: document.title };
    working = true; renderControls();
    try {
      const result = await exportFlowchart(document, { format, ...exportOptions, theme: themeSelect.value, confirm: confirmExport });
      if (!alive) return;
      if (!result.ok) { notice(`导出失败：${result.code}`, 'error'); return; }
      if (result.status === 'cancelled') { notice('已取消导出。'); return; }
      onExport({ ...result, source });
      notice(`导出完成（${format.toUpperCase()}，${result.width}×${result.height}）。`);
    } finally {
      working = false;
      if (alive) renderControls();
    }
  }

  function renderControls() {
    const disabled = !usable();
    autoButton.disabled = disabled;
    svgButton.disabled = !alive || !document || isBusy || working;
    pngButton.disabled = svgButton.disabled;
    // 确认按钮同样受 busy/只读/会话状态门控（over-limit 由 preview 状态表达）。
    confirmButton.disabled = disabled || preview?.status === 'over-limit';
    status.textContent = preview ? '预览中：确认前不会保存任何修改。' : '';
  }

  function update(next = {}) {
    if (!alive) return;
    if (Object.hasOwn(next, 'document')) {
      // 预览只对创建时那份文档有效：文档身份或版本前进立即作废预览（不自动重新计算）。
      const changed = document?.documentId !== next.document?.documentId ||
        document?.revision !== next.document?.revision;
      document = next.document;
      if (changed && preview) { preview = null; previewPanel.hidden = true; renderPreviewGraph(); notice('文档已更新，布局预览已作废。', 'warn'); }
    }
    if (Object.hasOwn(next, 'readOnly')) isReadOnly = !!next.readOnly;
    if (Object.hasOwn(next, 'busy')) isBusy = !!next.busy;
    renderControls();
  }

  renderControls();
  return {
    update,
    destroy() {
      if (!alive) return;
      alive = false; preview = null;
      for (const dispose of listeners.splice(0)) dispose();
      root.remove(); document = null;
    },
  };
}
