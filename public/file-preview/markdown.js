import { md } from '../markdown.js';
import DOMPurify from '../vendor/file-preview/purify.js';
import { node, button, searchControl, loadStyle } from './common.js';
import { inspectImage } from './image.js';

function textNodes(root) {
  const walker = root.ownerDocument.createTreeWalker(root, root.ownerDocument.defaultView.NodeFilter.SHOW_TEXT);
  const result = []; let current;
  while ((current = walker.nextNode())) if (current.nodeValue) result.push(current);
  return result;
}
function markQuery(root, query) {
  for (const mark of root.querySelectorAll('mark.fp-md-hit')) mark.replaceWith(root.ownerDocument.createTextNode(mark.textContent || ''));
  root.normalize();
  if (!query) return [];
  const hits = [], needle = query.toLocaleLowerCase();
  for (const text of textNodes(root)) {
    // MathML and KaTeX's accessible/visual copies must stay structurally intact.
    if (text.parentElement?.closest('.fp-math-inline,.fp-math-display')) continue;
    const value = text.nodeValue, lower = value.toLocaleLowerCase(); let at = 0, cursor = 0;
    const fragment = root.ownerDocument.createDocumentFragment();
    while ((at = lower.indexOf(needle, cursor)) >= 0 && hits.length < 5000) {
      if (at > cursor) fragment.append(root.ownerDocument.createTextNode(value.slice(cursor, at)));
      const mark = node('mark', 'fp-md-hit', value.slice(at, at + query.length)); fragment.append(mark); hits.push(mark);
      cursor = at + query.length;
    }
    if (cursor) { if (cursor < value.length) fragment.append(root.ownerDocument.createTextNode(value.slice(cursor))); text.replaceWith(fragment); }
    if (hits.length >= 5000) break;
  }
  return hits;
}
function prepare(source) {
  // Choose a marker absent from the authored document. Literal marker-like text
  // cannot request extra resources or be mistaken for generated placeholders.
  let prefix = 'FP';
  while (source.includes(prefix)) prefix += 'X';
  const slots = [], codes = [];
  const slot = value => `${prefix}${slots.push(value) - 1}`;
  let safe = source.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[^\S\n]*(?=\n|$)|$)/g, block => `${prefix}C${codes.push(block) - 1}`);
  safe = safe.replace(/(`+)([^`\n]*)\1/g, inline => `${prefix}C${codes.push(inline) - 1}`);
  let imageCount = 0, mathCount = 0;
  safe = safe.replace(/!\[([^\]]*)\]\((?:<([^>\n]+)>|([^\s)]+))\)/g, (all, alt, angled, plain) => {
    const href = angled || plain;
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#|\\)/i.test(href)) return all;
    if (++imageCount > 32) return alt || '（图片超出数量限制）';
    return slot({ kind: 'image', href, alt });
  });
  safe = safe.replace(/\$\$([\s\S]{1,2000}?)\$\$|\$([^$\n]{1,500})\$/g, (all, display, inline) => {
    if (++mathCount > 500) return all;
    return slot({ kind: 'math', formula: display ?? inline, display: display !== undefined });
  });
  safe = safe.replace(new RegExp(`${prefix}C(\\d+)`, 'g'), (_all, index) => codes[Number(index)] || '');
  return { source: safe, prefix, slots };
}

export async function mount(ctx) {
  loadStyle('katex.css');
  let disposed = false, complete = false, query = '', hits = [], hitIndex = -1, source = '', prepared = null;
  const current = () => !disposed && !ctx.resources.signal.aborted && ctx.resources.isCurrent();
  const wrapper = node('div', 'fp-markdown'), toc = node('nav', 'fp-markdown-toc');
  toc.setAttribute('aria-label', '文档目录');
  const body = node('article', 'fp-markdown-body'), count = node('span', 'fp-markdown-count'); count.setAttribute('role', 'status');
  const previous = button('上一个匹配项', () => move(-1)), next = button('下一个匹配项', () => move(1));
  const copy = button('复制文档文本', async () => {
    try { await navigator.clipboard.writeText(body.innerText || body.textContent || ''); if (current()) count.textContent = '已复制'; }
    catch { if (current()) count.textContent = '无法访问剪贴板'; }
  });
  searchControl(ctx.toolbar, value => { query = value.slice(0, 256); if (complete) search(); });
  ctx.toolbar.append(previous, next, copy, count); wrapper.append(toc, body); ctx.host.append(wrapper);
  async function populate() {
    let katex = null;
    if (prepared.slots.some(slot => slot.kind === 'math')) {
      try { katex = (await import('../vendor/file-preview/katex.js')).default; } catch { /* keep readable formula text */ }
      if (!current()) return;
    }
    const pending = [];
    for (const text of textNodes(body)) {
      const value = text.nodeValue, matcher = new RegExp(`${prepared.prefix}(\\d+)`, 'g');
      const fragment = body.ownerDocument.createDocumentFragment(); let cursor = 0, match;
      while ((match = matcher.exec(value))) {
        const item = prepared.slots[Number(match[1])]; if (!item) continue;
        if (match.index > cursor) fragment.append(body.ownerDocument.createTextNode(value.slice(cursor, match.index)));
        if (item.kind === 'math') {
          const span = node('span', item.display ? 'fp-math-display' : 'fp-math-inline', item.formula);
          if (katex) {
            try { span.innerHTML = DOMPurify.sanitize(katex.renderToString(item.formula, { displayMode: item.display, throwOnError: false, trust: false, strict: 'ignore' }), { USE_PROFILES: { html: true, mathMl: true }, FORBID_TAGS: ['script', 'style', 'iframe', 'img', 'svg'] }); }
            catch { /* malformed formulas remain literal text */ }
          }
          fragment.append(span);
        } else {
          const label = node('span', 'fp-md-image-loading', item.alt || '正在载入图片');
          fragment.append(label); pending.push({ item, label });
        }
        cursor = matcher.lastIndex;
      }
      if (cursor) { if (cursor < value.length) fragment.append(body.ownerDocument.createTextNode(value.slice(cursor))); text.replaceWith(fragment); }
    }
    for (const { item, label } of pending) {
      const resource = await ctx.access.relative(item.href, 2 * 1024 * 1024).catch(() => null);
      if (!current()) return;
      try {
        if (!resource) throw new Error('unavailable');
        const details = inspectImage(resource.bytes);
        // SVG is decoded only as an image, using the same active-content and
        // dimension checks as the standalone image viewer, never as app HTML.
        const image = node('img', 'fp-markdown-image'); image.alt = item.alt; image.loading = 'lazy';
        image.src = ctx.resources.url(new Blob([resource.bytes], { type: details.mime })); label.replaceWith(image);
      } catch { label.textContent = item.alt || '图片无法预览'; }
    }
  }
  function search() {
    if (!current()) return;
    hits = markQuery(body, query); hitIndex = hits.length ? 0 : -1;
    count.textContent = query ? `${hits.length}${hits.length >= 5000 ? '+' : ''} 处` : '';
    if (hits.length) { hits[0].classList.add('is-current'); hits[0].scrollIntoView({ block: 'center' }); }
  }
  function move(delta) {
    if (!hits.length) return;
    hits[hitIndex]?.classList.remove('is-current'); hitIndex = (hitIndex + delta + hits.length) % hits.length;
    hits[hitIndex].classList.add('is-current'); hits[hitIndex].scrollIntoView({ block: 'center' }); count.textContent = `${hitIndex + 1}/${hits.length}`;
  }
  function onClick(event) {
    const anchor = event.target.closest('a'); if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href') || '';
    if (href.startsWith('#')) {
      let id; try { id = decodeURIComponent(href.slice(1)); } catch { return; }
      const heading = [...body.querySelectorAll('[id]')].find(element => element.id === id);
      heading?.scrollIntoView({ block: 'start' }); return;
    }
    const descriptor = ctx.resolve(href);
    if (descriptor && current()) ctx.open(descriptor);
  }
  body.addEventListener('click', onClick);
  const dispose = () => { if (disposed) return; disposed = true; body.removeEventListener('click', onClick); source = ''; prepared = null; hits = []; };
  ctx.resources.own(dispose);
  const getState = () => ({ scrollTop: body.scrollTop });
  try {
    source = await ctx.access.text(4 * 1024 * 1024);
    if (!current()) return { dispose, getState };
    prepared = prepare(source);
    body.innerHTML = DOMPurify.sanitize(md(prepared.source, { headingIds: true, documentHeadings: true }), { USE_PROFILES: { html: true }, FORBID_TAGS: ['img', 'style', 'iframe', 'svg', 'math', 'form', 'video', 'audio'], FORBID_ATTR: ['style', 'src', 'srcset', 'target', 'formaction'] });
    const headings = [...body.querySelectorAll('h1[id],h2[id],h3[id],h4[id]')].slice(0, 300);
    if (headings.length > 1) {
      const list = node('ol');
      for (const heading of headings) {
        const item = node('li', `fp-md-toc-level-${heading.tagName.slice(1)}`);
        const link = node('button', 'fp-md-toc-link', heading.textContent); link.type = 'button'; link.title = heading.textContent;
        link.addEventListener('click', () => heading.scrollIntoView({ block: 'start' })); item.append(link); list.append(item);
      }
      toc.append(list);
    }
    await populate(); if (!current()) return { dispose, getState };
    complete = true; search(); body.scrollTop = Math.max(0, Number(ctx.state?.scrollTop) || 0);
  } catch { if (current()) ctx.error('无法读取 Markdown 文档。'); }
  return { dispose, getState };
}
