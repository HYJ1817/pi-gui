import DOMPurify from '../vendor/file-preview/purify.js';
import { node, button, searchControl, loadStyle, decodeText } from './common.js';
import { highlightSource } from '../ui/source-highlight.js';
import { inspectImage } from './image.js';
import { safeDocumentCss } from './html-style.js';

const ALLOWED_TAGS = ['html', 'head', 'body', 'main', 'article', 'section', 'div', 'span', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'small', 'sub', 'sup', 'mark', 'details', 'summary', 'figure', 'figcaption', 'time', 'abbr', 'kbd', 'samp', 'img'];
const ALLOWED_ATTR = ['class', 'id', 'title', 'colspan', 'rowspan', 'scope', 'start', 'value', 'open', 'lang', 'dir', 'alt', 'width', 'height', 'data-preview-key'];

function markSource(root, query) {
  for (const mark of root.querySelectorAll('mark.fp-html-hit')) mark.replaceWith(root.ownerDocument.createTextNode(mark.textContent || ''));
  if (!query) return [];
  const hits = [], needle = query.toLocaleLowerCase(), walker = root.ownerDocument.createTreeWalker(root, root.ownerDocument.defaultView.NodeFilter.SHOW_TEXT);
  const nodes = []; let text;
  while ((text = walker.nextNode())) nodes.push(text);
  for (const text of nodes) {
    if (hits.length >= 5000) break;
    if (text.parentElement?.closest('mark')) continue;
    const value = text.nodeValue, lower = value.toLocaleLowerCase(); let at = 0, cursor = 0;
    const fragment = root.ownerDocument.createDocumentFragment();
    while ((at = lower.indexOf(needle, cursor)) >= 0 && hits.length < 5000) {
      if (at > cursor) fragment.append(root.ownerDocument.createTextNode(value.slice(cursor, at)));
      const mark = node('mark', 'fp-html-hit', value.slice(at, at + query.length)); fragment.append(mark); hits.push(mark); cursor = at + query.length;
    }
    if (cursor) { if (cursor < value.length) fragment.append(root.ownerDocument.createTextNode(value.slice(cursor))); text.replaceWith(fragment); }
  }
  return hits;
}
function imagesWithoutSources(source, ctx, descriptors) {
  // Strip every user-supplied resource URL before HTML enters a DOM. The only
  // marker kept is an integer for a path independently re-resolved by the owner.
  return source.replace(/<img\b([^>]*)>/gi, (_whole, attrs) => {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const href = src?.[1] ?? src?.[2] ?? src?.[3];
    const descriptor = href ? ctx.resolve(href) : null;
    let key = '';
    if (descriptor && descriptors.length < 32) key = String(descriptors.push(href) - 1);
    const safeAlt = (alt?.[1] ?? alt?.[2] ?? alt?.[3] ?? '').replace(/[<>]/g, '');
    return `<img alt="${safeAlt.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"${key !== '' ? ` data-preview-key="${key}"` : ''}>`;
  });
}

export async function mount(ctx) {
  loadStyle('preview.css');
  let disposed = false, source = '', rendered = ctx.state?.rendered === true, frame = null, query = '', hits = [], hitIndex = -1;
  const current = () => !disposed && !ctx.resources.signal.aborted && ctx.resources.isCurrent();
  const wrapper = node('section', 'fp-html'), sourceView = node('pre', 'fp-html-source');
  sourceView.tabIndex = 0; sourceView.setAttribute('aria-label', 'HTML 源码');
  const sourceCode = node('code'); sourceView.append(sourceCode);
  const body = node('div', 'fp-html-body');
  const toggle = button('切换到静态预览', switchMode), count = node('span', 'fp-html-match-count'); count.setAttribute('role', 'status');
  const previous = button('上一个匹配项', () => move(-1)), next = button('下一个匹配项', () => move(1));
  searchControl(ctx.toolbar, value => { query = value.slice(0, 256); updateSearch(); });
  ctx.toolbar.append(toggle, previous, next, count);
  const warning = node('p', 'fp-html-note', '静态隔离预览：脚本、表单、外链和网络资源均已禁用；仅加载已授权的相对图片和安全样式。');
  wrapper.append(warning, sourceView, body); ctx.host.append(wrapper);

  let documentPromise = null, modeEpoch = 0;
  const attribute = (attrs, name) => {
    const found = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
    return found?.[1] ?? found?.[2] ?? found?.[3] ?? '';
  };
  async function buildDocument() {
    const descriptors = [], sheets = [];
    let css = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].slice(0, 32).map(match => safeDocumentCss(match[1])).filter(Boolean).join('\n').slice(0, 256 * 1024);
    let withoutCss = source.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
    withoutCss = withoutCss.replace(/<link\b([^>]*)>/gi, (_whole, attrs) => {
      const href = attribute(attrs, 'href');
      if (/^stylesheet$/i.test(attribute(attrs, 'rel')) && sheets.length < 8 && ctx.resolve(href)) sheets.push(href);
      return '';
    });
    const prepared = imagesWithoutSources(withoutCss, ctx, descriptors);
    const safe = DOMPurify.sanitize(prepared, {
      ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false,
      FORBID_TAGS: ['script', 'style', 'link', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'svg', 'math', 'template', 'base', 'source'],
      FORBID_ATTR: ['style', 'src', 'srcset', 'href', 'xlink:href', 'action', 'formaction', 'poster', 'onerror', 'onclick'],
      KEEP_CONTENT: true,
    });
    const detached = node('div'); detached.innerHTML = safe;
    if (detached.querySelectorAll('*').length > 50000) throw new Error('node_budget');
    for (const href of sheets) {
      const resource = await ctx.access.relative(href, 256 * 1024).catch(() => null);
      if (!current()) return '';
      if (resource && css.length < 256 * 1024) {
        try { css = (css + '\n' + safeDocumentCss(decodeText(resource.bytes))).slice(0, 256 * 1024); } catch { /* ignore unsupported stylesheet */ }
      }
    }
    for (const image of detached.querySelectorAll('img[data-preview-key]')) {
      const index = Number(image.getAttribute('data-preview-key')), href = descriptors[index];
      image.removeAttribute('data-preview-key');
      if (!Number.isInteger(index) || !href) { image.remove(); continue; }
      const resource = await ctx.access.relative(href, 2 * 1024 * 1024).catch(() => null);
      if (!current()) return '';
      if (!resource) { image.remove(); continue; }
      try {
        const details = inspectImage(resource.bytes);
        if (resource.bytes.length > 2 * 1024 * 1024) throw new Error('image_budget');
        // An opaque sandbox cannot dereference the parent origin's blob URL in
        // Electron. Embed only freshly authorized, inspected image bytes. No
        // authored data URL survives sanitization and no same-origin grant is
        // added to the frame. SVG, when accepted, stays an inert img decoder.
        const chunks = [];
        for (let at = 0; at < resource.bytes.length; at += 0x8000) chunks.push(String.fromCharCode(...resource.bytes.subarray(at, at + 0x8000)));
        image.src = `data:${details.mime};base64,${btoa(chunks.join(''))}`;
      } catch { image.remove(); }
    }
    // Navigation is removed by sanitization and the empty sandbox. Chromium
    // ignores navigate-to; do not advertise an unsupported CSP protection.
    const csp = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; media-src 'none'; font-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'";
    const frameStyle = 'body{font:14px/1.55 system-ui,sans-serif;color:#222;background:#fff;margin:1rem;overflow-wrap:anywhere}table{border-collapse:collapse}th,td{border:1px solid #aaa;padding:.3rem .5rem}pre{white-space:pre-wrap}img{max-width:100%;height:auto}';
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${frameStyle}\n${css}</style></head><body>${detached.innerHTML}</body></html>`;
  }
  async function createFrame() {
    const epoch = ++modeEpoch;
    try {
      documentPromise ||= buildDocument();
      const srcdoc = await documentPromise;
      if (!current() || !rendered || epoch !== modeEpoch || !srcdoc) return;
      frame?.remove(); frame = node('iframe', 'fp-html-frame');
      frame.title = `静态 HTML 预览：${ctx.meta.name || ctx.request.name || ''}`;
      frame.setAttribute('sandbox', ''); frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('aria-label', '隔离的静态 HTML 内容'); frame.srcdoc = srcdoc;
      body.replaceChildren(frame);
    } catch { if (current() && rendered && epoch === modeEpoch) { body.replaceChildren(node('p', 'fp-fallback', '无法安全渲染此 HTML，可返回源码查看。')); } }
  }
  function switchMode() {
    if (!current()) return;
    rendered = !rendered; modeEpoch++; toggle.textContent = rendered ? '查看源码' : '切换到静态预览';
    toggle.setAttribute('aria-label', toggle.textContent); sourceView.hidden = rendered; body.hidden = !rendered;
    if (rendered) void createFrame(); else { frame?.removeAttribute('srcdoc'); frame?.remove(); frame = null; }
  }
  function updateSearch() {
    hits = markSource(sourceCode, query); hitIndex = hits.length ? 0 : -1;
    count.textContent = query ? `${hits.length}${hits.length >= 5000 ? '+' : ''} 处` : '';
    if (hits.length) { hits[0].classList.add('is-current'); hits[0].scrollIntoView({ block: 'center' }); }
  }
  function move(delta) {
    if (!hits.length) return;
    hits[hitIndex]?.classList.remove('is-current'); hitIndex = (hitIndex + delta + hits.length) % hits.length;
    hits[hitIndex].classList.add('is-current'); hits[hitIndex].scrollIntoView({ block: 'center' }); count.textContent = `${hitIndex + 1}/${hits.length}`;
  }
  function dispose() {
    if (disposed) return; disposed = true; modeEpoch++; frame?.removeAttribute('srcdoc'); frame?.remove(); frame = null; source = ''; documentPromise = null; hits = [];
  }
  ctx.resources.own(dispose);
  try {
    source = await ctx.access.text(4 * 1024 * 1024);
    if (!current()) return { dispose, getState: () => ({ rendered, scrollTop: sourceView.scrollTop }) };
    sourceCode.innerHTML = highlightSource(source, ctx.meta.name || ctx.request.name || '').html;
    sourceView.hidden = rendered; body.hidden = !rendered; toggle.textContent = rendered ? '查看源码' : '切换到静态预览';
    updateSearch(); sourceView.scrollTop = Math.max(0, Number(ctx.state?.scrollTop) || 0); if (rendered) await createFrame();
  } catch { if (current()) ctx.error('无法读取 HTML 文件。'); }
  return { dispose, getState: () => ({ rendered, scrollTop: sourceView.scrollTop }) };
}
