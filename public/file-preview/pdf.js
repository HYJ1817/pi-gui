import { node, button, searchControl, loadStyle } from './common.js';

export const PDF_LIMITS = Object.freeze({
  bytes: 32 * 1024 * 1024, pages: 1200, pagePixels: 20 * 1024 * 1024,
  residentPages: 5, residentPixels: 24 * 1024 * 1024,
  textPages: 8, textBytes: 4 * 1024 * 1024, pageChars: 512 * 1024,
  textItems: 20000, matches: 5000, outline: 500,
  parseMs: 30000, renderMs: 15000, textMs: 12000, searchMs: 60000,
});
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const cancelled = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });
const budget = () => new Error('budget');

// Exact, case-sensitive literal search. Never interpret document/input as regex.
export function findLiteral(text, query, limit = PDF_LIMITS.matches) {
  const found = [];
  if (!query) return found;
  for (let start = 0; found.length < limit;) {
    const index = text.indexOf(query, start);
    if (index < 0) break;
    found.push(index); start = index + query.length;
  }
  return found;
}

export async function mount(ctx) {
  loadStyle('pdf.css');
  let disposed = false, pdfjs, pdf, loadingTask, worker, port;
  let zoom = clamp(Number(ctx.state?.zoom) || 1, .1, 4);
  let fitWidth = typeof ctx.state?.fitWidth === 'boolean' ? ctx.state.fitWidth : !Number.isFinite(ctx.state?.zoom);
  let currentPage = Math.max(1, Math.trunc(Number(ctx.state?.page) || Number(ctx.request?.line) || 1));
  let wanted = [], pumping = false, frame = 0, resizeFrame = 0, searchTimer = 0, searchVersion = 0;
  let hits = [], hitIndex = -1, query = '', cacheBytes = 0, searching = false;
  const records = [], textCache = new Map(), textFlights = new Map(), waiters = new Set(), readers = new Set();
  const listeners = new AbortController();
  const current = () => !disposed && !ctx.resources.signal.aborted && ctx.resources.isCurrent();
  const assertCurrent = () => { if (!current()) throw cancelled(); };
  const tools = node('div', 'fp-pdf-tools');
  const wrapper = node('section', 'fp-pdf');
  const scroll = node('div', 'fp-pdf-scroll');
  scroll.tabIndex = 0; scroll.setAttribute('aria-label', 'PDF 连续页面');
  const pagesRoot = node('div', 'fp-pdf-pages');
  const status = node('span', 'fp-pdf-status', '正在打开 PDF…'); status.setAttribute('role', 'status');
  const pageInput = node('input', 'ds-input fp-pdf-page-input');
  pageInput.type = 'number'; pageInput.min = '1'; pageInput.step = '1'; pageInput.setAttribute('aria-label', '跳到页码');
  const total = node('span', 'fp-pdf-total');
  const zoomLabel = node('span', 'fp-pdf-zoom');
  const matches = node('span', 'fp-pdf-match-count'); matches.setAttribute('role', 'status');
  const outline = node('select', 'ds-select fp-pdf-outline');
  outline.hidden = true; outline.setAttribute('aria-label', 'PDF 目录');
  let destinations = [];
  const previous = button('上一个匹配项', () => move(-1));
  const next = button('下一个匹配项', () => move(1));
  const less = button('缩小', () => setZoom(zoom / 1.2));
  const more = button('放大', () => setZoom(zoom * 1.2));
  const fit = button('适合宽度', () => { fitWidth = true; setZoom(fitScale(), true); });
  const navigation = node('div', 'fp-pdf-navigation');
  navigation.append(pageInput, total, less, more, fit, zoomLabel, outline);
  const searchTools = node('div', 'fp-pdf-search-tools');
  const searchInput = searchControl(searchTools, value => {
    query = value.slice(0, 256); searchVersion++; hits = []; hitIndex = -1;
    clearTimeout(searchTimer); updateHits(); highlight();
    if (query && pdf) searchTimer = setTimeout(() => void search(searchVersion), 180);
  });
  searchInput.title = '按原文查找（区分大小写，不使用正则）';
  searchTools.append(previous, next, matches); tools.append(navigation, searchTools);
  scroll.append(pagesRoot); wrapper.append(scroll, status); ctx.host.append(wrapper); ctx.toolbar.append(tools);
  for (const control of [pageInput, less, more, fit, searchInput]) control.disabled = true;
  updateHits();

  function wait(promise, ms) {
    if (!current()) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => {
        if (done) return; done = true; clearTimeout(timer); waiters.delete(abort); fn(value);
      };
      const abort = () => finish(reject, cancelled());
      const timer = setTimeout(() => {
        finish(reject, new Error('timeout')); fail(new Error('timeout'));
      }, ms);
      waiters.add(abort);
      Promise.resolve(promise).then(value => {
        if (current()) finish(resolve, value); else abort();
      }, error => finish(reject, error));
    });
  }
  function fail(error) {
    if (!current()) return;
    const message = error?.name === 'PasswordException' ? '加密 PDF 暂不支持预览。'
      : error?.message === 'timeout' ? 'PDF 处理超时，请选择其他打开方式。'
      : /budget|limit|large|size/.test(error?.message || error?.code || '') ? 'PDF 超出安全预览预算。'
      : 'PDF 无法预览，文件可能已损坏。';
    dispose(); ctx.error(message);
  }
  function evict(record) {
    record.version++; record.render?.cancel(); record.render = null;
    record.layer?.cancel(); record.layer = null;
    if (record.canvas) { record.canvas.width = 0; record.canvas.height = 0; record.canvas.remove(); }
    record.canvas = null; record.text?.remove(); record.text = null; record.offsets = null; record.pixels = 0;
    record.state = 'empty'; record.shell.removeAttribute('aria-busy');
    if (!record.users) { record.proxy?.cleanup(); record.proxy = null; }
  }
  function dispose() {
    if (disposed) return;
    disposed = true; searchVersion++; clearTimeout(searchTimer); cancelAnimationFrame(frame); cancelAnimationFrame(resizeFrame);
    listeners.abort(); ctx.resources.signal.removeEventListener('abort', dispose); resize?.disconnect();
    for (const abort of [...waiters]) abort();
    for (const reader of readers) reader.cancel(cancelled()).catch(() => {});
    readers.clear();
    for (const record of records) evict(record);
    textCache.clear(); textFlights.clear(); cacheBytes = 0; hits = []; wanted = []; destinations = [];
    // Allow PDF.js to release transport/fonts normally, but never depend on a
    // responding worker for termination (e.g. a stalled document parser).
    const ownedTask = loadingTask, ownedWorker = worker, ownedPort = port;
    let stopped = false;
    const stop = () => {
      if (stopped) return; stopped = true; clearTimeout(hardStop);
      ownedWorker?.destroy(); ownedPort?.terminate();
    };
    const hardStop = setTimeout(stop, 100);
    try { Promise.resolve(ownedTask?.destroy()).catch(() => {}).finally(stop); } catch { stop(); }
    loadingTask = null; worker = null; port = null; pdf = null;
    pagesRoot.replaceChildren(); records.length = 0; wrapper.remove(); tools.remove();
  }
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (resizeFrame || !pdf || !current() || !fitWidth) return;
    // Fit changes page/scroll geometry. Defer it outside ResizeObserver delivery
    // so the observer never mutates the same layout it is currently reporting.
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (pdf && current() && fitWidth) setZoom(fitScale(), true);
    });
  }) : null;
  ctx.resources.signal.addEventListener('abort', dispose, { once: true });
  ctx.resources.own(dispose);
  if (!current()) { dispose(); return { dispose, getState }; }

  async function withPage(record, use) {
    record.users++;
    try {
      const page = await wait(pdf.getPage(record.index + 1), PDF_LIMITS.parseMs);
      assertCurrent(); record.proxy = page;
      return await use(page);
    } finally {
      record.users--;
      if (!record.users && !record.canvas) { record.proxy?.cleanup(); record.proxy = null; }
    }
  }
  function sizeShell(record) {
    record.shell.style.width = `${record.width * zoom}px`;
    record.shell.style.height = `${record.height * zoom}px`;
  }
  function fitScale() {
    const record = records[currentPage - 1] || records[0];
    return clamp((Math.max(1, scroll.clientWidth - 32)) / (record?.width || 612), .1, 4);
  }
  function updateZoom() {
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    fit.setAttribute('aria-pressed', String(fitWidth));
    less.disabled = zoom <= .1; more.disabled = zoom >= 4;
  }
  function pageOffset() {
    const record = records[currentPage - 1];
    return record ? clamp((scroll.scrollTop - record.shell.offsetTop) / (record.height * zoom), 0, 1) : 0;
  }
  function getState() { return { page: currentPage, zoom, fitWidth, pageOffset: pageOffset() }; }
  function setZoom(value, fitting = false) {
    if (!pdf || !current()) return;
    const offset = pageOffset(), nextZoom = clamp(value, .1, 4);
    if (!fitting) fitWidth = false;
    if (Math.abs(nextZoom - zoom) > .001) {
      zoom = nextZoom;
      for (const record of records) { evict(record); sizeShell(record); }
      jump(currentPage, offset);
    }
    if (fitting) scroll.scrollLeft = Math.max(0, (scroll.scrollWidth - scroll.clientWidth) / 2);
    updateZoom(); schedule();
  }
  function jump(value, offset = 0) {
    if (!pdf || !current()) return;
    currentPage = clamp(Math.trunc(Number(value) || 1), 1, records.length);
    pageInput.value = String(currentPage);
    const record = records[currentPage - 1];
    scroll.scrollTop = record.shell.offsetTop + offset * record.height * zoom;
    // Shells are centered in the widest known page. Keep the reading column
    // centered too, otherwise visiting a landscape page makes later fit-width
    // portrait pages appear horizontally clipped despite the correct scale.
    scroll.scrollLeft = Math.max(0, (scroll.scrollWidth - scroll.clientWidth) / 2);
    schedule();
  }
  function schedule() {
    if (frame || !pdf || !current()) return;
    frame = requestAnimationFrame(() => {
      frame = 0; if (!current()) return;
      const top = scroll.getBoundingClientRect().top + 12, bottom = top + scroll.clientHeight;
      const candidates = [];
      let first = -1;
      for (const record of records) {
        const rect = record.shell.getBoundingClientRect();
        if (first < 0 && rect.bottom > top) first = record.index;
        if (rect.bottom > top - 300 && rect.top < bottom + 300) candidates.push(record);
      }
      if (first >= 0) { currentPage = first + 1; pageInput.value = String(currentPage); }
      candidates.sort((a, b) => Math.abs(a.index - currentPage + 1) - Math.abs(b.index - currentPage + 1));
      wanted = candidates.slice(0, PDF_LIMITS.residentPages);
      const keep = new Set(wanted);
      for (const record of records) if ((record.canvas || record.state === 'loading') && !keep.has(record)) evict(record);
      void pump();
    });
  }
  async function pump() {
    if (pumping || !current()) return;
    pumping = true;
    try {
      for (;;) {
        const record = wanted.find(item => item.state === 'empty');
        if (!record || !current()) break;
        await render(record);
      }
    } catch (error) { if (current()) fail(error); }
    finally { pumping = false; }
  }
  async function render(record) {
    const version = record.version;
    record.state = 'loading'; record.shell.setAttribute('aria-busy', 'true');
    const valid = () => current() && record.version === version && wanted.includes(record);
    try {
      await withPage(record, async page => {
        if (!valid()) throw cancelled();
        const base = page.getViewport({ scale: 1 });
        if (base.width !== record.width || base.height !== record.height) {
          const anchor = pageOffset(), previousWidth = scroll.scrollWidth;
          record.width = base.width; record.height = base.height; sizeShell(record);
          scroll.scrollLeft += (scroll.scrollWidth - previousWidth) / 2;
          // The current page can itself differ from the first-page placeholder
          // (rotation/mixed paper sizes). Preserve its fractional anchor too.
          if (record.index <= currentPage - 1) jump(currentPage, anchor);
        }
        const viewport = page.getViewport({ scale: zoom });
        const area = viewport.width * viewport.height;
        if (!Number.isFinite(area) || area < 1 || area > PDF_LIMITS.pagePixels) throw budget();
        // At high DPI/zoom reduce backing resolution, not document zoom. This
        // keeps ordinary pages usable without ever allocating an over-budget canvas.
        const ratio = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(PDF_LIMITS.pagePixels / area));
        const width = Math.floor(viewport.width * ratio), height = Math.floor(viewport.height * ratio);
        if (!Number.isSafeInteger(width * height) || width < 1 || height < 1 || width > 32767 || height > 32767 || width * height > PDF_LIMITS.pagePixels) throw budget();
        // Enforce both count and aggregate pixel bounds, including in-flight work.
        for (const other of [...records].filter(item => item.canvas).reverse()) {
          if (records.reduce((sum, item) => sum + item.pixels, 0) + width * height <= PDF_LIMITS.residentPixels) break;
          if (other !== record) { evict(other); other.state = 'deferred'; }
        }
        const canvas = node('canvas', 'fp-pdf-canvas'); canvas.setAttribute('aria-hidden', 'true');
        canvas.width = width; canvas.height = height; record.canvas = canvas; record.pixels = width * height;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('canvas');
        const layer = node('div', 'fp-pdf-text-layer'); record.text = layer;
        layer.setAttribute('aria-label', `第 ${record.index + 1} 页文本`);
        layer.style.setProperty('--total-scale-factor', String(viewport.scale * page.userUnit));
        record.shell.append(canvas, layer);
        record.render = page.render({ canvas, canvasContext: context, viewport,
          transform: [width / viewport.width, 0, 0, height / viewport.height, 0, 0], background: 'rgb(255,255,255)' });
        await wait(record.render.promise, PDF_LIMITS.renderMs);
        if (!valid()) throw cancelled(); record.render = null;
        const text = await textFor(record);
        if (!valid()) throw cancelled();
        let offset = 0;
        record.offsets = text.content.items.map(item => { const start = offset; offset += item.str.length + Number(!!item.hasEOL); return start; });
        record.layer = new pdfjs.TextLayer({ textContentSource: text.content, container: layer, viewport });
        await wait(record.layer.render(), PDF_LIMITS.renderMs);
        if (!valid()) throw cancelled();
        record.state = 'ready'; record.shell.removeAttribute('aria-busy'); highlightRecord(record);
      });
    } catch (error) {
      if (record.version === version) evict(record);
      if (error?.name !== 'AbortError' && error?.name !== 'RenderingCancelledException') throw error;
    }
  }
  async function textFor(record) {
    if (textCache.has(record.index)) {
      const value = textCache.get(record.index); textCache.delete(record.index); textCache.set(record.index, value); return value;
    }
    if (textFlights.has(record.index)) return textFlights.get(record.index);
    const flight = withPage(record, async page => {
      const reader = page.streamTextContent({ includeMarkedContent: false }).getReader(); readers.add(reader);
      const content = { items: [], styles: Object.create(null), lang: null };
      let text = '', weight = 0;
      const expires = performance.now() + PDF_LIMITS.textMs;
      try {
        for (;;) {
          const remaining = expires - performance.now();
          if (remaining <= 0) throw new Error('timeout');
          const chunk = await wait(reader.read(), remaining); assertCurrent();
          if (chunk.done) break;
          content.lang ||= chunk.value.lang;
          for (const [key, style] of Object.entries(chunk.value.styles || {})) {
            if (!(key in content.styles)) weight += 256;
            content.styles[key] = style;
          }
          for (const item of chunk.value.items) {
            if (typeof item.str !== 'string') continue;
            text += item.str + (item.hasEOL ? '\n' : ''); weight += item.str.length * 2 + 128;
            content.items.push(item);
          }
          if (content.items.length > PDF_LIMITS.textItems || text.length > PDF_LIMITS.pageChars || weight > PDF_LIMITS.textBytes) throw budget();
        }
      } finally {
        readers.delete(reader);
        // PDF.js requires an Error reason; undefined closes the native stream
        // before its protocol marks it closed, allowing late enqueue errors.
        // Cancellation acknowledgement itself must not hold up hard termination.
        reader.cancel(cancelled()).catch(() => {});
      }
      assertCurrent();
      const entry = { content, text, weight: weight + text.length * 2 };
      if (entry.weight > PDF_LIMITS.textBytes) throw budget();
      while (textCache.size && (textCache.size >= PDF_LIMITS.textPages || cacheBytes + entry.weight > PDF_LIMITS.textBytes)) {
        const key = textCache.keys().next().value; cacheBytes -= textCache.get(key).weight; textCache.delete(key);
      }
      textCache.set(record.index, entry); cacheBytes += entry.weight; return entry;
    });
    textFlights.set(record.index, flight);
    try { return await flight; } finally { textFlights.delete(record.index); }
  }
  function updateHits(scanning = false) {
    previous.disabled = next.disabled = !hits.length;
    matches.textContent = scanning ? '正在查找…' : query ? `${hits.length ? hitIndex + 1 : 0}/${hits.length}${hits.length >= PDF_LIMITS.matches ? '+' : ''}` : '';
  }
  function highlightRecord(record) {
    if (!record.layer) return;
    const ranges = hits.filter(hit => hit.page === record.index);
    record.layer.textDivs.forEach((span, index) => {
      const text = record.layer.textContentItemsStr[index] || '', offset = record.offsets[index];
      span.classList.toggle('has-search-hit', ranges.some(hit => hit.start < offset + text.length && hit.start + query.length > offset));
    });
  }
  function highlight() { for (const record of records) if (record.layer) highlightRecord(record); }
  async function search(version) {
    if (!current() || version !== searchVersion || !query || searching) return;
    searching = true;
    const needle = query, found = [], started = performance.now(); updateHits(true);
    try {
      for (const record of records) {
        if (!current() || version !== searchVersion) return;
        const entry = await textFor(record);
        if (!current() || version !== searchVersion) return;
        for (const start of findLiteral(entry.text, needle, PDF_LIMITS.matches - found.length)) found.push({ page: record.index, start });
        if (found.length >= PDF_LIMITS.matches) break;
        if (performance.now() - started > PDF_LIMITS.searchMs) throw new Error('timeout');
      }
      if (!current() || version !== searchVersion) return;
      hits = found; hitIndex = found.length ? 0 : -1; updateHits(); highlight();
      if (hits.length) jump(hits[0].page + 1);
    } catch (error) { if (current()) fail(error); }
    finally {
      searching = false;
      if (current() && query && version !== searchVersion) {
        clearTimeout(searchTimer); searchTimer = setTimeout(() => void search(searchVersion), 180);
      }
    }
  }
  function move(delta) {
    if (!hits.length || !current()) return;
    hitIndex = (hitIndex + delta + hits.length) % hits.length; updateHits(); jump(hits[hitIndex].page + 1);
  }
  async function loadOutline() {
    const tree = await wait(pdf.getOutline(), PDF_LIMITS.parseMs);
    if (!tree || !current()) return;
    const queue = tree.slice(0, PDF_LIMITS.outline).map(item => ({ item, depth: 0 }));
    outline.append(node('option', '', '目录'));
    let visited = 0;
    while (queue.length && visited++ < PDF_LIMITS.outline) {
      const { item, depth } = queue.shift();
      if (item.dest && (typeof item.dest !== 'string' || item.dest.length < 2048)) {
        const option = node('option', '', `${'　'.repeat(depth)}${String(item.title || '未命名').slice(0, 160)}`);
        destinations.push(item.dest); option.value = String(destinations.length); outline.append(option);
      }
      if (depth < 12 && Array.isArray(item.items)) queue.unshift(...item.items.slice(0, PDF_LIMITS.outline - visited).map(child => ({ item: child, depth: depth + 1 })));
    }
    outline.hidden = !destinations.length;
  }
  async function followOutline() {
    try {
      let dest = destinations[Number(outline.value) - 1];
      if (typeof dest === 'string') dest = await wait(pdf.getDestination(dest), PDF_LIMITS.parseMs);
      if (!Array.isArray(dest) || !current()) return;
      const page = Number.isInteger(dest[0]) ? dest[0] : await wait(pdf.getPageIndex(dest[0]), PDF_LIMITS.parseMs);
      if (current()) { jump(page + 1); outline.selectedIndex = 0; }
    } catch (error) { if (current()) fail(error); }
  }
  pageInput.addEventListener('change', () => jump(pageInput.value), { signal: listeners.signal });
  pageInput.addEventListener('keydown', event => { if (event.key === 'Enter') jump(pageInput.value); }, { signal: listeners.signal });
  scroll.addEventListener('scroll', () => {
    // A deferred neighbor can be reconsidered on the next actual navigation.
    for (const record of records) if (record.state === 'deferred') record.state = 'empty';
    schedule();
  }, { passive: true, signal: listeners.signal });
  outline.addEventListener('change', () => void followOutline(), { signal: listeners.signal });
  searchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
    if (event.key === 'Escape') { searchInput.value = ''; searchInput.dispatchEvent(new Event('input')); }
  }, { signal: listeners.signal });
  try {
    pdfjs = await wait(import('../vendor/file-preview/pdf.js'), PDF_LIMITS.parseMs);
    const bytes = await wait(ctx.access.bytes(PDF_LIMITS.bytes), PDF_LIMITS.parseMs); assertCurrent();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > PDF_LIMITS.bytes) throw budget();
    if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') throw new Error('signature');
    // Explicit ownership avoids PDF.js's implicit fake-worker fallback and its
    // cross-origin blob wrapper. No global pdfjsLib or shared workerPort state.
    port = new Worker(new URL('../vendor/file-preview/pdf.worker.mjs', import.meta.url), { type: 'module' });
    for (const type of ['error', 'messageerror']) port.addEventListener(type, () => fail(new Error('worker')), { signal: listeners.signal });
    worker = new pdfjs.PDFWorker({ port, verbosity: 0 });
    loadingTask = pdfjs.getDocument({ data: bytes, worker, verbosity: 0,
      isEvalSupported: false, enableXfa: false, useSystemFonts: false, stopAtErrors: true,
      maxImageSize: PDF_LIMITS.pagePixels, canvasMaxAreaInBytes: PDF_LIMITS.pagePixels * 4,
      cMapUrl: new URL('../vendor/file-preview/pdf/cmaps/', import.meta.url).href, cMapPacked: true,
      standardFontDataUrl: new URL('../vendor/file-preview/pdf/standard_fonts/', import.meta.url).href,
      wasmUrl: new URL('../vendor/file-preview/pdf/wasm/', import.meta.url).href });
    loadingTask.onPassword = () => fail({ name: 'PasswordException' });
    pdf = await wait(loadingTask.promise, PDF_LIMITS.parseMs); assertCurrent();
    if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > PDF_LIMITS.pages) throw budget();
    currentPage = Math.min(currentPage, pdf.numPages);
    const first = await wait(pdf.getPage(1), PDF_LIMITS.parseMs), initial = first.getViewport({ scale: 1 });
    for (let index = 0; index < pdf.numPages; index++) {
      const shell = node('article', 'fp-pdf-page'); shell.dataset.page = String(index + 1);
      shell.setAttribute('aria-label', `PDF 第 ${index + 1} 页`);
      const record = { index, shell, width: initial.width, height: initial.height, state: 'empty', version: 0, users: 0, pixels: 0 };
      records.push(record); pagesRoot.append(shell);
    }
    first.cleanup();
    if (fitWidth) zoom = fitScale();
    for (const record of records) sizeShell(record);
    total.textContent = `/ ${pdf.numPages} 页`; pageInput.max = String(pdf.numPages);
    for (const control of [pageInput, less, more, fit, searchInput]) control.disabled = false;
    updateZoom(); jump(currentPage, clamp(Number(ctx.state?.pageOffset) || 0, 0, 1));
    // Mount resolves only after the first real render/text layer. Background
    // pages use the same serialized queue; no canvas can have concurrent tasks.
    wanted = [records[currentPage - 1]];
    await pump(); assertCurrent();
    status.textContent = `PDF · ${pdf.numPages} 页`;
    await loadOutline(); resize?.observe(scroll); schedule();
  } catch (error) { if (current()) fail(error); }
  return { dispose, getState };
}
