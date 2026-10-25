// 协同画布生产力工具条 —— 自动整理 / 导出 SVG / 导出 PNG（Z4-4A 任务 E）。
//
// 【原型：尚未正式接入】本模块未在 public/collab-panel.js / index.html 挂载，
// 未进入任何生产入口；正式接入是 Z4-4B 的最小改动（见 docs/Z4-4A-acceptance.md 任务 E 一节）。
//
// 最小集成方式：与 mountCollabCanvas 同宿主并排挂载（不动 collab-canvas.js，
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
  root.setAttribute('aria-label', '画布生产力工具（Z4-4A 原型，未正式接入）');
  const badge = element('p', 'collab-prod-badge', 'Z4-4A 原型 · 尚未正式接入生产面板');
  const toolbar = element('div', 'collab-prod-toolbar');
  toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', '自动整理与导出');
  const autoButton = button(toolbar, '自动整理', startAutoLayout);
  const svgButton = button(toolbar, '导出 SVG', () => runExport('svg'));
  const pngButton = button(toolbar, '导出 PNG', () => runExport('png'));
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
    const created = createLayoutPreview(document, layoutOptions);
    if (!created.ok) { notice(`自动布局失败：${created.code}`, 'error'); return; }
    if (created.status === 'clean') { notice('画布已经是整理后的状态，无需移动节点。'); return; }
    preview = created;
    if (created.status === 'over-limit') {
      previewText.textContent = `需要移动 ${created.moveCount} 个节点，超过单批 50 条操作上限；` +
        '为避免部分静默保存，本轮不提供自动分批，请手动分区整理或等待大图事务方案。';
      confirmButton.disabled = true;
    } else {
      previewText.textContent = `自动整理预览：将移动 ${created.moveCount} 个节点（基于版本 ${created.baseRevision}）。预览期间不保存。`;
      confirmButton.disabled = false;
    }
    previewPanel.hidden = false;
    renderControls();
  }

  function confirmLayout() {
    if (!alive || !preview || confirmButton.disabled) return;
    const intent = applyLayoutPreview(preview, document, { makeOpId: () => `prod-${globalThis.crypto.randomUUID()}` });
    if (!intent.ok) { notice(`应用布局失败：${intent.code}`, 'error'); return; }
    if (intent.status === 'unchanged' || !intent.ops.length) { notice('没有需要移动的节点。'); }
    else {
      // 与画布 onOperations 同方言：只发意图，信封由上层补全。
      onOperations(intent.ops.map(({ type, params }) => ({ type, params })));
      notice(`已提交 ${intent.opCount} 个节点的移动意图。`);
    }
    preview = null; previewPanel.hidden = true;
    renderControls();
  }

  function cancelLayout() {
    if (!alive) return;
    if (preview) dismissLayoutPreview(preview);
    preview = null; previewPanel.hidden = true;
    notice('已取消自动整理，文档保持不变。');
    renderControls();
  }

  async function runExport(format) {
    if (!alive || !document) { notice('当前没有可导出的文档。', 'warn'); return; }
    if (working) return;
    working = true; renderControls();
    try {
      const result = await exportFlowchart(document, { format, ...exportOptions, confirm: confirmExport });
      if (!alive) return;
      if (!result.ok) { notice(`导出失败：${result.code}`, 'error'); return; }
      if (result.status === 'cancelled') { notice('已取消导出。'); return; }
      onExport(result);
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
    status.textContent = preview ? '预览中：确认前不会保存任何修改。' : '';
  }

  function update(next = {}) {
    if (!alive) return;
    if (Object.hasOwn(next, 'document')) {
      // 预览只对创建时那份文档有效：文档身份或版本前进立即作废预览（不自动重新计算）。
      const changed = document?.documentId !== next.document?.documentId ||
        document?.revision !== next.document?.revision;
      document = next.document;
      if (changed && preview) { preview = null; previewPanel.hidden = true; notice('文档已更新，布局预览已作废。', 'warn'); }
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
