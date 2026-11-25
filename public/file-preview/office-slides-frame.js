/* Classic, trusted bootstrap inside an opaque-origin sandbox only. No document
 * markup or filename is interpolated into this program or the iframe srcdoc. */
(() => {
  'use strict';
  const stage = document.getElementById('slides');
  const script = document.currentScript;
  const key = script.dataset.key;
  const nativeHtml = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  const purifier = window.DOMPurify;
  const urls = new Set();
  let preview = null, page = 0, scale = 'fit', started = false, cleaning = false, disposed = false;
  const send = (type, extra = {}) => parent.postMessage({ officeSlides: key, type, ...extra }, '*');
  const safeImage = value => typeof value === 'string' && (urls.has(value) || /^data:image\/(?:png|jpeg|gif);base64,[a-z\d+/]+=*$/i.test(value));

  // pptx-preview's text renderer assigns innerHTML from a:t. Sanitize BEFORE
  // that assignment, not after appending untrusted nodes. Recursion is limited
  // to DOMPurify's own inert parser while the guard is set. CSP still forbids
  // all non-nonced scripts and remote subresources, even on a sanitizer miss.
  Object.defineProperty(Element.prototype, 'innerHTML', {
    configurable: true, get: nativeHtml.get,
    set(value) {
      if (cleaning) return nativeHtml.set.call(this, value);
      cleaning = true;
      let clean;
      try {
        clean = purifier.sanitize(String(value), { ALLOWED_TAGS: ['span', 'b', 'strong', 'i', 'em', 'u', 's', 'br', 'sup', 'sub'], ALLOWED_ATTR: [], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
      } finally { cleaning = false; }
      nativeHtml.set.call(this, clean);
    },
  });
  const createUrl = URL.createObjectURL.bind(URL), revokeUrl = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => { const url = createUrl(blob); urls.add(url); return url; };
  URL.revokeObjectURL = url => { urls.delete(url); revokeUrl(url); };
  const imageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, get: imageSrc.get, set(value) { imageSrc.set.call(this, safeImage(value) ? value : ''); } });

  // Patched ECharts is SVG-only in pptx-preview. Bound any incidental canvas
  // surface (font measurement etc.) rather than accepting document dimensions.
  const canvases = new Map();
  for (const dimension of ['width', 'height']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dimension);
    Object.defineProperty(HTMLCanvasElement.prototype, dimension, {
      configurable: true, get: descriptor.get,
      set(value) {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0 || number > 4096) throw new Error('Canvas budget');
        const next = { width: this.width, height: this.height, [dimension]: Math.floor(number) };
        canvases.set(this, next.width * next.height);
        if (canvases.size > 128 || [...canvases.values()].reduce((sum, pixels) => sum + pixels, 0) > 16 * 1024 * 1024) throw new Error('Canvas budget');
        descriptor.set.call(this, number);
      },
    });
  }
  // No network API is needed: every byte comes from a worker-validated buffer.
  window.fetch = () => Promise.reject(new Error('Network disabled'));
  window.XMLHttpRequest = class { constructor() { throw new Error('Network disabled'); } };
  document.addEventListener('click', event => { if (event.target.closest('a,form,button,input')) event.preventDefault(); }, true);
  document.addEventListener('submit', event => event.preventDefault(), true);
  purifier.addHook('uponSanitizeAttribute', (_node, data) => {
    if (/^on/i.test(data.attrName)) data.keepAttr = false;
    if (['href', 'xlink:href'].includes(data.attrName) && !/^#[a-z\d_.:-]+$/i.test(data.attrValue)) data.keepAttr = false;
    if (data.attrName === 'src' && !safeImage(data.attrValue)) data.keepAttr = false;
    if (data.attrName === 'style' && /(?:@import|expression\s*\(|javascript\s*:)/i.test(data.attrValue)) data.keepAttr = false;
    if (['style', 'fill', 'stroke', 'filter', 'mask', 'clip-path'].includes(data.attrName)) {
      for (const match of data.attrValue.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)) {
        if (!/^#[a-z\d_.:-]+$/i.test(match[1]) && !safeImage(match[1])) data.keepAttr = false;
      }
    }
  });
  function cleanStage() {
    cleaning = true;
    try {
      purifier.sanitize(stage, {
        IN_PLACE: true, USE_PROFILES: { html: true, svg: true, svgFilters: true }, ALLOW_DATA_ATTR: false,
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base', 'foreignObject', 'audio', 'video', 'source', 'track', 'animate', 'animateMotion', 'set', 'a'],
        FORBID_ATTR: ['srcset', 'action', 'formaction', 'target'],
      });
    } finally { cleaning = false; }
  }
  function layout() {
    if (!preview || disposed) return;
    const width = Number(preview.pptx.width), height = Number(preview.pptx.height);
    if (!width || !height || width > 2880 || height > 2880) throw new Error('Slide size');
    const factor = scale === 'fit' ? Math.max(.1, Math.min(2, (innerWidth - 32) / width, (innerHeight - 32) / height)) : Number(scale) / 100;
    const wrapper = preview.wrapper;
    wrapper.style.width = `${width * factor}px`; wrapper.style.height = `${height * factor}px`;
    wrapper.style.background = 'transparent'; wrapper.style.overflow = 'visible';
    // Constructing the renderer once at 960 CSS px
    // keeps all Office coordinates intact. Scale its complete source surface.
    const slide = stage.querySelector('.pptx-preview-slide-wrapper');
    if (slide) { slide.style.top = '0'; slide.style.transformOrigin = '0 0'; slide.style.transform = `scale(${width * factor / 960})`; }
  }
  function render() {
    if (!preview || disposed) return;
    preview.renderSingleSlide(page);
    cleanStage(); layout();
    send('page', { page, count: preview.slideCount });
  }
  function dispose() {
    if (disposed) return;
    disposed = true; preview?.destroy(); preview = null;
    for (const url of urls) revokeUrl(url);
    urls.clear(); canvases.clear(); stage.replaceChildren();
  }
  window.addEventListener('message', async event => {
    if (event.source !== parent || event.data?.officeSlides !== key || disposed) return;
    const message = event.data;
    try {
      if (typeof message.background === 'string' && /^[#\w\s(),.%+-]{1,100}$/.test(message.background) && CSS.supports('color', message.background)) document.body.style.backgroundColor = message.background;
      if (message.type === 'load' && !started && message.buffer instanceof ArrayBuffer) {
        started = true;
        preview = window.PptxPreview.init(stage, { width: 960, height: 960 / Math.max(.25, Math.min(4, Number(message.aspect) || 16 / 9)), mode: 'slide' });
        await preview.load(message.buffer);
        if (disposed) return;
        if (preview.slideCount !== message.slides || preview.slideCount > 80) throw new Error('Slide count');
        page = Math.max(0, Math.min(preview.slideCount - 1, Math.trunc(Number(message.page)) || 0));
        scale = ['fit', '50', '75', '100', '125', '150', '200'].includes(message.scale) ? message.scale : 'fit';
        render(); send('loaded', { page, count: preview.slideCount });
      } else if (message.type === 'page' && preview) {
        page = Math.max(0, Math.min(preview.slideCount - 1, Math.trunc(Number(message.page)) || 0)); render();
      } else if (message.type === 'scale' && preview) {
        scale = ['fit', '50', '75', '100', '125', '150', '200'].includes(message.scale) ? message.scale : 'fit'; layout();
      } else if (message.type === 'dispose') dispose();
    } catch { dispose(); send('error'); }
  });
  window.addEventListener('resize', () => { try { layout(); } catch { dispose(); send('error'); } });
  window.addEventListener('pagehide', dispose);
  send('ready');
})();
