import { node, navigationButton } from './common.js';
import { OFFICE_LIMITS, officeError } from './office-policy.js';

function html(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

export function slidesDocument({ key, nonce, base }) {
  const url = file => html(new URL(file, base).href);
  // No same-origin, popups, forms, downloads, top-navigation or clipboard
  // permission. A nonce authorizes only our local data-only view program.
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${html(csp)}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;width:100%;height:100%;overflow:auto;font-family:system-ui,sans-serif}body{display:flex}#slides{position:relative;flex:none;margin:auto;padding:16px}.pptx-slide{box-shadow:0 1px 8px #0002}*:focus-visible{outline:2px solid Highlight}</style></head><body><div id="slides" aria-label="幻灯片内容"></div><script nonce="${nonce}" data-key="${html(key)}" src="${url('./office-slides-frame.js')}"></script></body></html>`;
}

export async function mountSlides(ctx, bytes, summary) {
  const key = crypto.randomUUID();
  const random = new Uint8Array(24); crypto.getRandomValues(random);
  const nonce = [...random].map(value => value.toString(16).padStart(2, '0')).join('');
  const wrapper = node('div', 'office-slides-view');
  const note = node('p', 'office-note', '此文稿包含暂不支持的图表、几何或布局，相关内容未完整显示。');
  note.hidden = !summary.deck?.unsupported;
  const frame = node('iframe', 'office-slides-frame');
  frame.title = '隔离的 PowerPoint 幻灯片'; frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
  wrapper.append(note, frame); ctx.host.replaceChildren(wrapper);
  const actions = node('div', 'office-actions'); ctx.toolbar.append(actions);
  let disposed = false, loaded = false, sent = false, page = Math.max(0, Math.min(summary.slides - 1, Math.trunc(Number(ctx.state.page)) || 0));
  let scale = ['fit', '50', '75', '100', '125', '150', '200'].includes(ctx.state.scale) ? ctx.state.scale : 'fit';
  const send = (type, extra = {}) => { if (!disposed) frame.contentWindow?.postMessage({ officeSlides: key, type, ...extra }, '*'); };
  const background = () => getComputedStyle(ctx.host).getPropertyValue('--ds-bg-secondary').trim();
  const themeObserver = new MutationObserver(() => send('theme', { background: background() }));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  const previous = navigationButton('上一页', () => go(page - 1));
  const next = navigationButton('下一页', () => go(page + 1));
  const input = node('input', 'ds-input office-page-input'); input.type = 'number'; input.min = '1'; input.max = String(summary.slides); input.value = String(page + 1); input.setAttribute('aria-label', '幻灯片页码');
  const count = node('span', 'office-page-count', `/ ${summary.slides}`); count.setAttribute('aria-live', 'polite');
  const zoom = node('select', 'ds-select office-zoom'); zoom.setAttribute('aria-label', '幻灯片缩放');
  for (const value of ['fit', '50', '75', '100', '125', '150', '200']) { const option = node('option', '', value === 'fit' ? '适应窗口' : `${value}%`); option.value = value; zoom.append(option); }
  zoom.value = scale; actions.append(previous, input, count, next, zoom);
  function controls() { previous.disabled = !loaded || page <= 0; next.disabled = !loaded || page >= summary.slides - 1; input.disabled = !loaded; zoom.disabled = !loaded; input.value = String(page + 1); }
  function go(value) { if (loaded) { page = Math.max(0, Math.min(summary.slides - 1, Math.trunc(Number(value)) || 0)); controls(); send('page', { page }); } }
  const changePage = () => go(Number(input.value) - 1);
  const changeZoom = () => { scale = zoom.value; send('scale', { scale }); };
  const keydown = event => {
    if (event.target === input || event.target === zoom) return;
    if (['ArrowRight', 'PageDown'].includes(event.key)) { event.preventDefault(); go(page + 1); }
    if (['ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); go(page - 1); }
    if (event.key === 'Home') { event.preventDefault(); go(0); }
    if (event.key === 'End') { event.preventDefault(); go(summary.slides - 1); }
  };
  input.addEventListener('change', changePage); zoom.addEventListener('change', changeZoom); wrapper.addEventListener('keydown', keydown);
  controls();
  let finish;
  const ready = new Promise((resolve, reject) => { finish = error => error ? reject(error) : resolve(); });
  const timer = setTimeout(() => { finish(officeError('timeout')); dispose(); }, OFFICE_LIMITS.parseMs);
  function dispose() {
    if (disposed) return;
    send('dispose'); disposed = true; clearTimeout(timer); themeObserver.disconnect();
    if (!loaded) finish(officeError('cancelled'));
    window.removeEventListener('message', receive);
    input.removeEventListener('change', changePage); zoom.removeEventListener('change', changeZoom); wrapper.removeEventListener('keydown', keydown);
    frame.remove(); wrapper.remove(); actions.remove();
  }
  function receive(event) {
    if (disposed || !ctx.resources.isCurrent() || ctx.resources.signal.aborted) return;
    if (event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.officeSlides !== key) return;
    const message = event.data;
    if (message.type === 'ready' && !sent) {
      sent = true;
      frame.contentWindow.postMessage({ officeSlides: key, type: 'load', deck: summary.deck, slides: summary.slides, page, scale, background: background() }, '*');
    } else if (message.type === 'loaded' && message.count === summary.slides) {
      loaded = true; clearTimeout(timer); controls(); finish();
    } else if (message.type === 'page' && Number.isInteger(message.page) && message.page >= 0 && message.page < summary.slides && message.count === summary.slides) {
      page = message.page; controls();
    } else if (message.type === 'error') {
      if (loaded) ctx.error('无法安全渲染此幻灯片。');
      finish(officeError('invalid')); dispose();
    }
  }
  window.addEventListener('message', receive);
  ctx.resources.own(dispose);
  frame.srcdoc = slidesDocument({ key, nonce, base: import.meta.url });
  await ready;
  return { getState: () => ({ page, scale }), dispose };
}
