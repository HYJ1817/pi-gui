import { node, compactNavigation, toolbarMenu } from './common.js';
import { OFFICE_LIMITS, officeError } from './office-policy.js';
import { parseInWorker } from './office-worker-client.js';

const MESSAGES = Object.freeze({
  'size': '文件超过 Office 预览大小限制。',
  'sheet-limit': '表格超出预览限制（50,000 行、128 列或 500,000 个单元格）。',
  'slide-limit': '演示文稿超过 80 页预览限制。',
  'slide-size': '演示文稿的页面尺寸不受支持。',
  'image-limit': '文档图片过大或格式不受支持；仅支持有界 PNG、JPEG 和 GIF 嵌图。',
  'xml-limit': '文档结构超过安全预览限制。',
  'active-content': '文档包含宏、嵌入对象或外部链接，已停止预览。',
  'external-link': '文档包含外部资源链接，已停止预览。',
  'entity': '文档包含不受支持的 XML 实体。',
  'encoding': '无法按所选编码读取文件。',
  'csv-format': 'CSV/TSV 引号结构不完整，无法安全预览。',
  'timeout': '文档解析超时，已终止预览。',
  'worker-unavailable': '此环境无法启动隔离解析 Worker。',
  'parser-unavailable': '本地 Office 预览组件不可用。',
});

/* Adapt existing renderer-owned controls, not document bytes or parser state.
 * The detached originals still own their behavior; the shared menu only invokes
 * those actions. Their references and any open menu die with this renderer. */
export function compactOfficeUI(ctx, kind) {
  if (kind === 'pptx') return () => {}; // Slide chrome is owned with the isolated slide renderer.
  const actions = ctx.toolbar.querySelector('.office-actions');
  if (!actions) return () => {};
  for (const control of actions.querySelectorAll('button')) compactNavigation(control);
  const low = [...actions.querySelectorAll('button')].filter(control => ['复制正文', '复制选区', '显示公式'].includes(control.getAttribute('aria-label')));
  const encoding = actions.querySelector('.office-encoding');
  const note = ctx.host.querySelector('.office-note');
  const explanation = note?.textContent;
  note?.remove();
  for (const control of low) control.remove();
  encoding?.closest('.office-encoding-label')?.remove();
  const owned = [];
  const menu = toolbarMenu({ ...ctx, resources: { ...ctx.resources, own: fn => owned.push(fn) } }, () => [
    ...low.map(control => ({
      label: `${control.getAttribute('aria-label')}${control.getAttribute('aria-pressed') === 'true' ? ' ✓' : ''}`,
      disabled: control.disabled, onClick: () => control.click(),
    })),
    ...(encoding ? [{ separator: true }, ...[...encoding.options].map(option => ({
      label: `${option.textContent}${encoding.value === option.value ? ' ✓' : ''}`,
      onClick: () => { encoding.value = option.value; encoding.dispatchEvent(new encoding.ownerDocument.defaultView.Event('change', { bubbles: true })); },
    }))] : []),
    ...(explanation ? [{ separator: true }, { label: '文档信息', disabled: true, disabledReason: explanation }] : []),
  ]);
  actions.append(menu);
  return () => { for (const dispose of owned.splice(0)) dispose(); };
}

export async function mount(ctx) {
  const name = String(ctx.meta?.name || ctx.request?.name || ctx.meta?.path || '');
  const kind = /\.([^.\/\\]+)$/.exec(name)?.[1]?.toLowerCase();
  if (!['docx', 'xlsx', 'csv', 'tsv', 'pptx'].includes(kind)) throw officeError('format');
  let disposed = false, renderer = null, epoch = 0, controller = null, disposeUI = null;
  let encoding = ctx.state.encoding || 'auto';
  const current = () => !disposed && !ctx.resources.signal.aborted && ctx.resources.isCurrent();
  const dispose = () => {
    if (disposed) return;
    disposed = true; epoch++; controller?.abort(); disposeUI?.(); disposeUI = null; renderer?.dispose?.(); renderer = null;
    ctx.resources.signal.removeEventListener('abort', dispose);
  };
  ctx.resources.own(dispose);
  ctx.resources.signal.addEventListener('abort', dispose, { once: true });

  async function load(nextEncoding = encoding) {
    const requestEpoch = ++epoch;
    controller?.abort(); controller = new AbortController();
    const localController = controller;
    const previousState = renderer?.getState?.() || ctx.state;
    disposeUI?.(); disposeUI = null; renderer?.dispose?.(); renderer = null;
    encoding = nextEncoding;
    const loading = node('div', 'office-note', '正在解析文档…');
    loading.setAttribute('role', 'status'); ctx.host.replaceChildren(loading);
    try {
      const bytes = await ctx.access.bytes(['csv', 'tsv'].includes(kind) ? OFFICE_LIMITS.csvBytes : OFFICE_LIMITS.fileBytes);
      if (!current() || requestEpoch !== epoch) return;
      const workerCtx = { ...ctx, resources: { ...ctx.resources, signal: localController.signal } };
      const result = await parseInWorker(workerCtx, kind, bytes, encoding);
      if (!current() || requestEpoch !== epoch) return;
      const renderCtx = { ...ctx, state: { ...previousState, encoding } };
      if (kind === 'docx') {
        const { mountDocument } = await import('./office-document.js');
        if (current() && requestEpoch === epoch) renderer = mountDocument(renderCtx, result);
      } else if (kind === 'pptx') {
        const { mountSlides } = await import('./office-slides.js');
        if (current() && requestEpoch === epoch) renderer = await mountSlides(renderCtx, bytes, result);
      } else {
        const { mountGrid } = await import('./office-grid.js');
        if (current() && requestEpoch === epoch) renderer = mountGrid(renderCtx, result, ['csv', 'tsv'].includes(kind) ? { onEncoding: load } : {});
      }
      if (!current() || requestEpoch !== epoch) { renderer?.dispose?.(); renderer = null; }
      else if (renderer) disposeUI = compactOfficeUI(ctx, kind);
    } catch (error) {
      if (current() && requestEpoch === epoch && error?.code !== 'cancelled') {
        ctx.error(MESSAGES[error?.code] || '无法预览此文档。文件可能已损坏、包含不支持的内容或超过安全限制。');
      }
    }
  }
  await load();
  return { dispose, getState: () => ({ ...(renderer?.getState?.() || {}), encoding }) };
}
