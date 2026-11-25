/* Self-authored DrawingML view inside opaque allow-scripts iframe. Input is the
 * bounded data projection from our Office worker, never raw document markup. */
(() => {
  'use strict';
  const stage = document.getElementById('slides');
  const key = document.currentScript.dataset.key;
  const urls = new Map();
  let deck = null, page = 0, scale = 'fit', started = false, disposed = false, slide = null, wrapper = null;
  const send = (type, extra = {}) => parent.postMessage({ officeSlides: key, type, ...extra }, '*');
  const node = (tag, className) => { const value = document.createElement(tag); if (className) value.className = className; return value; };
  function svg(item) {
    const namespace = 'http://www.w3.org/2000/svg';
    const root = document.createElementNS(namespace, 'svg');
    root.setAttribute('width', String(Math.max(1, item.width))); root.setAttribute('height', String(Math.max(1, item.height)));
    root.style.overflow = 'visible'; root.style.position = 'absolute';
    root.setAttribute('aria-hidden', 'true');
    const type = { rect: 'rect', roundRect: 'rect', ellipse: 'ellipse', triangle: 'polygon', rtTriangle: 'polygon', diamond: 'polygon', line: 'line' }[item.geometry];
    if (!type) return root;
    const shape = document.createElementNS(namespace, type), w = item.width, h = item.height;
    const set = attributes => { for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, String(value)); };
    if (type === 'rect') { set({ x: 0, y: 0, width: w, height: h }); if (item.geometry === 'roundRect') set({ rx: Math.min(w, h) * .16 }); }
    else if (type === 'ellipse') set({ cx: w/2, cy: h/2, rx: w/2, ry: h/2 });
    else if (type === 'line') set({ x1: 0, y1: 0, x2: w, y2: h });
    else set({ points: item.geometry === 'diamond' ? `${w/2},0 ${w},${h/2} ${w/2},${h} 0,${h/2}` : item.geometry === 'rtTriangle' ? `0,0 ${w},${h} 0,${h}` : `${w/2},0 ${w},${h} 0,${h}` });
    set({ fill: item.fill || 'none', stroke: item.stroke || 'none', 'stroke-width': item.strokeWidth || 0 });
    root.append(shape); return root;
  }
  function text(item) {
    const box = node('div', 'pptx-text');
    Object.assign(box.style, { position: 'absolute', inset: '0', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: item.anchor,
      padding: `${item.margins.top}px ${item.margins.right}px ${item.margins.bottom}px ${item.margins.left}px`, whiteSpace: item.wrap ? 'pre-wrap' : 'pre', overflowWrap: 'anywhere', lineHeight: '1.2' });
    for (const paragraph of item.paragraphs) {
      const p = node('p'); Object.assign(p.style, { margin: '0', textAlign: paragraph.alignment, minHeight: '.9em' });
      for (const run of paragraph.runs) {
        const span = node('span'); span.textContent = run.text;
        Object.assign(span.style, { fontSize: run.size + 'px', color: run.color, fontWeight: run.bold ? '700' : '400', fontStyle: run.italic ? 'italic' : 'normal', textDecoration: run.underline ? 'underline' : 'none' });
        if (run.family) span.style.fontFamily = run.family;
        p.append(span);
      }
      box.append(p);
    }
    return box;
  }
  function imageUrl(name) {
    if (!urls.has(name)) {
      const image = deck.images[name];
      if (!image || !['image/png', 'image/jpeg', 'image/gif'].includes(image.mime) || !(image.bytes instanceof Uint8Array) || image.bytes.byteLength > 16 * 1024 * 1024) throw Error('Image budget');
      urls.set(name, URL.createObjectURL(new Blob([image.bytes], { type: image.mime })));
    }
    return urls.get(name);
  }
  function render() {
    if (!deck || disposed) return;
    const data = deck.slides[page];
    wrapper = node('div', 'pptx-page-viewport');
    slide = node('div', 'pptx-slide'); slide.setAttribute('role', 'img'); slide.setAttribute('aria-label', `幻灯片 ${page + 1}`);
    Object.assign(slide.style, { position: 'relative', width: deck.width + 'px', height: deck.height + 'px', backgroundColor: data.background, overflow: 'hidden', transformOrigin: '0 0' });
    for (const item of data.shapes) {
      const element = node('div', 'pptx-object');
      Object.assign(element.style, { position: 'absolute', left: '0', top: '0', width: item.width + 'px', height: item.height + 'px', transformOrigin: '0 0', transform: `matrix(${item.matrix.join(',')})` });
      if (item.description) element.setAttribute('aria-label', item.description);
      if (item.kind === 'image') {
        const image = node('img', 'pptx-image'), c = item.crop;
        image.alt = item.description || ''; image.src = imageUrl(item.image);
        element.style.overflow = 'hidden';
        Object.assign(image.style, { position: 'absolute', maxWidth: 'none', width: `${100/(1-c.l-c.r)}%`, height: `${100/(1-c.t-c.b)}%`, left: `${-100*c.l/(1-c.l-c.r)}%`, top: `${-100*c.t/(1-c.t-c.b)}%` });
        element.append(image);
      } else {
        element.append(svg(item)); if (item.text) element.append(text(item.text));
      }
      slide.append(element);
    }
    wrapper.append(slide); stage.replaceChildren(wrapper); layout();
    send('page', { page, count: deck.slides.length });
  }
  function layout() {
    if (!deck || disposed || !wrapper) return;
    const factor = scale === 'fit' ? Math.max(.1, Math.min(2, (innerWidth - 32) / deck.width, (innerHeight - 32) / deck.height)) : Number(scale) / 100;
    wrapper.style.width = `${deck.width * factor}px`; wrapper.style.height = `${deck.height * factor}px`;
    slide.style.transform = `scale(${factor})`;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear(); deck = null; stage.replaceChildren(); slide = wrapper = null;
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.officeSlides !== key || disposed) return;
    const message = event.data;
    try {
      if (typeof message.background === 'string' && /^[#\w\s(),.%+-]{1,100}$/.test(message.background) && CSS.supports('color', message.background)) document.body.style.backgroundColor = message.background;
      if (message.type === 'load' && !started && message.deck) {
        started = true;
        const model = message.deck;
        if (model.width !== 960 || !Number.isFinite(model.height) || model.height < 240 || model.height > 3840 || !Array.isArray(model.slides) || model.slides.length !== message.slides || model.slides.length > 80) throw Error('Slide budget');
        deck = model;
        page = Math.max(0, Math.min(deck.slides.length - 1, Math.trunc(Number(message.page)) || 0));
        scale = ['fit', '50', '75', '100', '125', '150', '200'].includes(message.scale) ? message.scale : 'fit';
        render(); send('loaded', { page, count: deck.slides.length, unsupported: deck.unsupported });
      } else if (message.type === 'page' && deck) {
        page = Math.max(0, Math.min(deck.slides.length - 1, Math.trunc(Number(message.page)) || 0)); render();
      } else if (message.type === 'scale' && deck) {
        scale = ['fit', '50', '75', '100', '125', '150', '200'].includes(message.scale) ? message.scale : 'fit'; layout();
      } else if (message.type === 'dispose') dispose();
    } catch { dispose(); send('error'); }
  });
  window.addEventListener('resize', () => { try { layout(); } catch { dispose(); send('error'); } });
  window.addEventListener('pagehide', dispose);
  send('ready');
})();
