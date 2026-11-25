import { node, button, searchControl, decodeText } from './common.js';
import { highlightSource } from '../ui/source-highlight.js';

const MAX_LINES = 100000;
const WINDOW_LINES = 180;
const MAX_MATCHES = 10000;

export async function mount(ctx) {
  let disposed = false, sourceText = '', lines = [], query = '', matches = [], matchIndex = -1;
  let wrap = ctx.state?.wrap === true, lineNumbers = ctx.state?.lineNumbers !== false;
  let encoding = ctx.state?.encoding || 'auto', bytes;
  const referenceLine = Math.max(0, Math.trunc(Number(ctx.request.line) || 0));
  const referenceEnd = Math.max(referenceLine, Math.trunc(Number(ctx.request.endLine) || referenceLine));
  let target = referenceLine, endTarget = referenceEnd;
  let offsets = [0], widths = [], rowHeight = 20, charWidth = 8, measuredWidth = 0;
  let renderedFirst = -1, renderedLast = -1;
  const live = () => !disposed && !ctx.resources.signal.aborted && ctx.resources.isCurrent();
  const view = node('div', 'fp-text');
  const scroller = node('div', 'fp-text-scroll files-preview-scroll');
  scroller.tabIndex = 0; scroller.setAttribute('aria-label', '文件文本预览');
  const code = node('div', 'fp-text-code');
  const top = node('div', 'fp-text-spacer'), rows = node('div', 'fp-text-rows'), bottom = node('div', 'fp-text-spacer');
  code.append(top, rows, bottom); scroller.append(code); view.append(scroller); ctx.host.append(view);
  const count = node('span', 'fp-text-count'); count.setAttribute('role', 'status');
  const numbers = button('行号', () => { lineNumbers = !lineNumbers; measure(); render(); });
  const wrapping = button('自动换行', () => { wrap = !wrap; measure(); render(); });
  const previous = button('上一个匹配项', () => move(-1));
  const next = button('下一个匹配项', () => move(1));
  const location = node('input', 'ds-input fp-line-input'); location.type = 'number'; location.min = '1'; location.step = '1'; location.placeholder = '行'; location.setAttribute('aria-label', '跳到行');
  location.addEventListener('change', () => goTo(Number(location.value)));
  const encodingSelect = node('select', 'ds-select fp-encoding'); encodingSelect.setAttribute('aria-label', '文本编码');
  for (const [value, label] of [['auto', '自动编码'], ['utf-8', 'UTF-8'], ['gb18030', 'GB18030'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE']]) {
    const option = node('option', '', label); option.value = value; encodingSelect.append(option);
  }
  encodingSelect.value = encoding;
  encodingSelect.addEventListener('change', () => { encoding = encodingSelect.value; decode(); });
  const copy = button('复制全文', () => copyText(sourceText));
  const copyRange = button('复制引用区间', () => {
    const first = Math.max(0, referenceLine - 1), last = Math.min(lines.length - 1, referenceEnd - 1);
    const parts = lines.slice(first, last + 1);
    if (!parts.length) return;
    const startColumn = Math.max(0, (Number(ctx.request.column) || 1) - 1);
    const endColumn = Number(ctx.request.endColumn);
    if (parts.length === 1) parts[0] = parts[0].slice(startColumn, endColumn > 0 ? endColumn : undefined);
    else { if (endColumn > 0) parts[parts.length - 1] = parts.at(-1).slice(0, endColumn); parts[0] = parts[0].slice(startColumn); }
    void copyText(parts.join('\n'));
  });
  copyRange.hidden = !target;
  searchControl(ctx.toolbar, value => { query = value; find(); });
  ctx.toolbar.append(previous, next, location, wrapping, numbers, encodingSelect, copy, copyRange, count);
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); if (live()) count.textContent = '已复制'; }
    catch { if (live()) count.textContent = '无法访问剪贴板'; }
  }
  function measure() {
    view.classList.toggle('is-wrapped', wrap); view.classList.toggle('no-line-numbers', !lineNumbers);
    numbers.setAttribute('aria-pressed', String(lineNumbers)); wrapping.setAttribute('aria-pressed', String(wrap));
    const style = scroller.ownerDocument.defaultView.getComputedStyle(scroller);
    rowHeight = Math.max(16, parseFloat(style.lineHeight) || 20);
    charWidth = Math.max(6, (parseFloat(style.fontSize) || 13) * .62);
    measuredWidth = scroller.clientWidth || 640;
    const available = Math.max(80, measuredWidth - (lineNumbers ? 68 : 24));
    offsets = new Float64Array(lines.length + 1);
    for (let i = 0; i < lines.length; i++) offsets[i + 1] = offsets[i] + rowHeight * (wrap ? Math.max(1, Math.ceil(widths[i] * charWidth / available)) : 1);
    code.style.minWidth = wrap ? '' : `${Math.min(16 * 1024 * 1024, widths.reduce((max, width) => Math.max(max, width), 0) * charWidth + 72)}px`;
  }
  function indexAt(position) {
    let low = 0, high = lines.length;
    while (low < high) { const mid = (low + high) >>> 1; if (offsets[mid + 1] <= position) low = mid + 1; else high = mid; }
    return low;
  }
  function goTo(value, rangeEnd = value) {
    if (!lines.length || !Number.isFinite(value)) return;
    target = Math.max(1, Math.min(lines.length, Math.trunc(value))); endTarget = Math.min(lines.length, Math.max(target, rangeEnd));
    location.value = String(target); scroller.scrollTop = Math.max(0, offsets[target - 1] - rowHeight * 2); render();
  }
  function render(force = true) {
    if (!live()) return;
    const first = Math.max(0, indexAt(scroller.scrollTop) - 12), last = Math.min(lines.length, first + WINDOW_LINES);
    // Programmatic line/search jumps deliver a later native scroll event. Do
    // not replace the same text nodes and destroy the just-created selection.
    if (!force && first === renderedFirst && last === renderedLast) return;
    renderedFirst = first; renderedLast = last;
    const hitLines = new Set(matches.map(item => item.line));
    const fragment = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const targeted = target > 0 && i + 1 >= target && i + 1 <= endTarget;
      const row = node('div', `fp-text-line${targeted ? ' is-target files-line-highlight' : ''}${hitLines.has(i) ? ' has-match' : ''}`);
      row.dataset.line = String(i + 1);
      if (targeted) { row.dataset.lineFrom = String(target); row.dataset.lineTo = String(endTarget); row.classList.add('files-line-highlight'); row.hidden = false; }
      const gutter = node('span', 'fp-text-gutter files-preview-gutter', String(i + 1)); gutter.dataset.line = String(i + 1); gutter.setAttribute('aria-hidden', 'true');
      const text = node('span', 'fp-text-source');
      text.innerHTML = highlightSource(lines[i], ctx.meta.name || ctx.request.name || ctx.request.path).html;
      row.append(gutter, text); fragment.append(row);
    }
    rows.replaceChildren(fragment);
    // Browser measurements refine wrap estimates without ever mounting the file
    // in full. Search/line jumps work against the same bounded prefix index.
    let adjusted = false;
    if (wrap) for (const row of rows.children) {
      const i = Number(row.dataset.line) - 1, actual = row.getBoundingClientRect().height;
      if (actual > 0 && Math.abs(actual - (offsets[i + 1] - offsets[i])) > .5) {
        const delta = actual - (offsets[i + 1] - offsets[i]);
        for (let j = i + 1; j < offsets.length; j++) offsets[j] += delta;
        adjusted = true;
      }
    }
    top.style.height = `${offsets[first] || 0}px`; bottom.style.height = `${Math.max(0, offsets[lines.length] - (offsets[last] || 0))}px`;
    if (adjusted) scroller.setAttribute('aria-rowcount', String(lines.length));
  }
  function selectColumn(line, column, length = 1) {
    const element = rows.querySelector(`[data-line="${line}"] .fp-text-source`);
    if (!element) return;
    const doc = element.ownerDocument, walker = doc.createTreeWalker(element, doc.defaultView.NodeFilter.SHOW_TEXT);
    const nodes = []; let text, total = 0;
    while ((text = walker.nextNode())) { nodes.push({ text, from: total }); total += text.length; }
    if (!nodes.length) return;
    const start = Math.min(total, Math.max(0, column - 1)), end = Math.min(total, start + length);
    const a = nodes.find(item => start <= item.from + item.text.length) || nodes.at(-1);
    const b = nodes.find(item => end <= item.from + item.text.length) || nodes.at(-1);
    const range = doc.createRange(); range.setStart(a.text, start - a.from); range.setEnd(b.text, end - b.from);
    const selection = doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  }
  function find() {
    matches = []; matchIndex = -1;
    const needle = query.toLocaleLowerCase();
    if (needle) for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
      const lower = lines[i].toLocaleLowerCase(); let at = 0;
      while ((at = lower.indexOf(needle, at)) >= 0 && matches.length < MAX_MATCHES) { matches.push({ line: i, column: at }); at += Math.max(1, needle.length); }
    }
    count.textContent = needle ? `${matches.length}${matches.length === MAX_MATCHES ? '+' : ''} 处` : `${lines.length} 行`;
    if (matches.length) { matchIndex = 0; showMatch(); } else render();
  }
  function showMatch() { const item = matches[matchIndex]; endTarget = item.line + 1; goTo(item.line + 1); selectColumn(item.line + 1, item.column + 1, query.length); count.textContent = `${matchIndex + 1}/${matches.length}${matches.length === MAX_MATCHES ? '+' : ''}`; }
  function move(delta) { if (matches.length) { matchIndex = (matchIndex + delta + matches.length) % matches.length; showMatch(); } }
  function decode() {
    try {
      sourceText = decodeText(bytes, encoding); lines = sourceText.split(/\r\n|\r|\n/);
      if (lines.length > MAX_LINES) throw new Error('line_budget');
      widths = lines.map(line => { let width = 0; for (const char of line) width += char === '\t' ? 4 : char.codePointAt(0) > 255 ? 2 : 1; return width; });
      measure(); render(); find();
    } catch (error) { ctx.error(error?.message === 'binary_text' ? '此二进制文件无法作为文本预览。' : '文本编码不受支持，或文件超过 100,000 行的预览范围。'); }
  }
  const onScroll = () => render(false); scroller.addEventListener('scroll', onScroll, { passive: true });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (live() && scroller.clientWidth !== measuredWidth) { measure(); render(); } }) : null;
  observer?.observe(scroller);
  const dispose = () => { if (disposed) return; disposed = true; observer?.disconnect(); scroller.removeEventListener('scroll', onScroll); bytes = null; sourceText = ''; lines = []; widths = []; };
  ctx.resources.own(dispose);
  const getState = () => ({ scrollTop: scroller.scrollTop, scrollLeft: scroller.scrollLeft, wrap, lineNumbers, encoding, line: target });
  try {
    bytes = await ctx.access.bytes(4 * 1024 * 1024);
    if (!live()) return { dispose, getState };
    decode();
    scroller.scrollTop = Math.max(0, Number(ctx.state?.scrollTop) || 0); scroller.scrollLeft = Math.max(0, Number(ctx.state?.scrollLeft) || 0); render();
    if (target && !Object.hasOwn(ctx.state || {}, 'scrollTop')) {
      goTo(target, endTarget);
      if (ctx.request.column) {
        const endColumn = Number(ctx.request.endColumn);
        selectColumn(target, Number(ctx.request.column), target === endTarget && endColumn >= Number(ctx.request.column) ? endColumn - Number(ctx.request.column) + 1 : 1);
      }
    }
  } catch (error) { if (live()) ctx.error(error?.code === 'binary_text' ? '此二进制文件无法作为文本预览。' : '此文件无法作为文本预览。'); }
  return { dispose, getState };
}
