import DOMPurify from '../vendor/file-preview/purify.js';
import { node, button, searchControl } from './common.js';
import { OFFICE_LIMITS, officeError } from './office-policy.js';

export function mountDocument(ctx, result) {
  if (typeof result.html !== 'string' || result.html.length > OFFICE_LIMITS.textChars * 4) throw officeError('size');
  const article = node('article', 'office-document');
  article.setAttribute('aria-label', 'Word 文档正文');
  const clean = DOMPurify.sanitize(result.html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'u', 's', 'del', 'sup', 'sub', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'img', 'br', 'blockquote', 'pre', 'code', 'hr', 'span'],
    ALLOWED_ATTR: ['src', 'alt', 'colspan', 'rowspan', 'start'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'input'],
    FORBID_ATTR: ['style', 'srcset', 'href', 'id', 'name'],
  });
  for (const image of clean.querySelectorAll('img')) {
    if (!/^data:image\/(?:png|jpeg|gif);base64,[a-z\d+/]+=*$/i.test(image.getAttribute('src') || '')) image.remove();
    else { image.loading = 'lazy'; image.decoding = 'async'; }
  }
  for (const cell of clean.querySelectorAll('[colspan],[rowspan],[start]')) {
    for (const attr of ['colspan', 'rowspan', 'start']) {
      if (cell.hasAttribute(attr) && !/^\d{1,5}$/.test(cell.getAttribute(attr))) cell.removeAttribute(attr);
    }
  }
  article.append(clean);
  const scroll = node('div', 'office-document-scroll'); scroll.append(article);
  const wrapper = node('div', 'office-view');
  const note = node('p', 'office-note', '正文阅读模式；分页、浮动布局与高级图表可能简化。外部链接和宏不受支持。');
  wrapper.append(note, scroll); ctx.host.replaceChildren(wrapper);
  const actions = node('div', 'office-actions'); ctx.toolbar.append(actions);
  const count = node('span', 'office-match-count'); count.setAttribute('aria-live', 'polite');
  let marks = [], selected = -1, disposed = false;
  const input = searchControl(actions, search);
  input.setAttribute('aria-label', '搜索文档正文'); actions.append(count);
  actions.append(button('上一处', () => move(-1)), button('下一处', () => move(1)));
  actions.append(button('复制正文', async () => {
    try { await navigator.clipboard.writeText(article.innerText || article.textContent); if (!disposed && ctx.resources.isCurrent()) count.textContent = '已复制正文'; }
    catch { if (!disposed && ctx.resources.isCurrent()) count.textContent = '无法访问剪贴板，请选择正文后复制'; }
  }));

  function search(value) {
    for (const mark of marks) mark.replaceWith(document.createTextNode(mark.textContent));
    article.normalize(); marks = []; selected = -1;
    const query = String(value || '').slice(0, 256).toLocaleLowerCase();
    if (query) {
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      const texts = []; let text;
      while ((text = walker.nextNode())) texts.push(text);
      outer: for (const textNode of texts) {
        const source = textNode.textContent;
        const folded = source.toLocaleLowerCase();
        let start = 0, match;
        const fragment = document.createDocumentFragment();
        while ((match = folded.indexOf(query, start)) >= 0) {
          fragment.append(document.createTextNode(source.slice(start, match)));
          const mark = node('mark', '', source.slice(match, match + query.length)); marks.push(mark); fragment.append(mark);
          start = match + query.length;
          if (marks.length >= 500) { fragment.append(document.createTextNode(source.slice(start))); textNode.replaceWith(fragment); break outer; }
        }
        if (start) { fragment.append(document.createTextNode(source.slice(start))); textNode.replaceWith(fragment); }
      }
    }
    count.textContent = query ? (marks.length ? `${marks.length === 500 ? '≥' : ''}${marks.length} 处` : '无匹配') : '';
  }
  function move(delta) {
    if (!marks.length) return;
    selected = (selected + delta + marks.length) % marks.length;
    marks[selected].scrollIntoView({ block: 'center', behavior: 'instant' });
    count.textContent = `${selected + 1} / ${marks.length === 500 ? '≥' : ''}${marks.length}`;
  }
  const onKey = event => { if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1); } };
  input.addEventListener('keydown', onKey);
  scroll.scrollTop = Math.max(0, Number(ctx.state.scrollTop) || 0);
  return {
    getState: () => ({ scrollTop: scroll.scrollTop }),
    dispose() { disposed = true; input.removeEventListener('keydown', onKey); marks = []; actions.remove(); wrapper.remove(); },
  };
}
