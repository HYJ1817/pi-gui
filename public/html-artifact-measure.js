// Self-contained: serialized into srcdoc AFTER locks and BEFORE model bytes.
export function installHtmlArtifactMeasurement(view, post) {
  const doc = view.document;
  const setTimer = view.setTimeout.bind(view), clearTimer = view.clearTimeout.bind(view);
  const raf = view.requestAnimationFrame.bind(view), cancelRaf = view.cancelAnimationFrame.bind(view);
  const now = view.performance.now.bind(view.performance);
  const readRect = view.Element.prototype.getBoundingClientRect;
  const listen = view.EventTarget.prototype.addEventListener;
  const unlisten = view.EventTarget.prototype.removeEventListener;
  const subscriptions = [];
  const on = (target, name, handler, options) => {
    listen.call(target, name, handler, options);
    subscriptions.push(() => unlisten.call(target, name, handler, options));
  };
  let visible = true, disposed = false, ready = false, timer = null, frame = null;
  let lastAt = -Infinity, previous = null, signature = '', revision = 0;
  const size = value => Math.max(0, Math.min(1000000, Math.ceil(value)));
  const clamp = value => Math.max(80, Math.min(4096, value));
  function cancel() {
    if (timer !== null) clearTimer(timer);
    if (frame !== null) cancelRaf(frame);
    timer = null; frame = null;
  }
  function report() {
    frame = null;
    if (disposed || !visible || !ready || !doc.body) return;
    const body = doc.body, box = readRect.call(body);
    if (![box.height, box.width, body.scrollHeight, body.scrollWidth].every(Number.isFinite)) return;
    const naturalHeight = size(Math.max(box.height, body.scrollHeight));
    const naturalWidth = size(Math.max(box.width, body.scrollWidth));
    if (naturalWidth === 0) return; // hidden layout must never replace a good size.
    const viewportHeight = view.innerHeight, viewportWidth = view.innerWidth;
    let height = clamp(naturalHeight), feedback = false;
    // Viewport-dependent author CSS (100vh + padding, min-height:100%, etc.)
    // must not grow the host on every assigned height. Without a content/font/
    // width change, keep the previous viewport and let excess scroll internally.
    if (previous && revision === previous.revision && viewportWidth === previous.viewportWidth
        && (previous.feedback || viewportHeight !== previous.viewportHeight && naturalHeight !== previous.naturalHeight)) {
      height = previous.height; feedback = true;
    }
    const snapshot = { type: 'resize', height, naturalHeight, naturalWidth,
      capped: naturalHeight > height || feedback };
    const nextSignature = JSON.stringify(snapshot);
    previous = { ...snapshot, feedback, revision, viewportHeight, viewportWidth };
    if (signature === nextSignature) return;
    signature = nextSignature; lastAt = now(); post(snapshot);
  }
  function queue(changed = false) {
    if (changed) revision++;
    if (disposed || !ready || !visible || timer !== null || frame !== null) return;
    const wait = Math.max(0, 100 - (now() - lastAt));
    if (wait > 0) timer = setTimer(() => { timer = null; queue(); }, wait);
    else frame = raf(report);
  }
  const resize = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => queue()) : null;
  const mutation = new view.MutationObserver(records => {
    if (records.some(record => !(record.target === doc.documentElement
      && record.type === 'attributes' && record.attributeName?.startsWith('data-pi-artifact-')))) queue(true);
  });
  function observe() {
    resize?.observe(doc.body);
    mutation.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  const changed = () => queue(true);
  const resized = () => {
    if (previous && view.innerWidth !== previous.viewportWidth) revision++;
    queue();
  };
  function start() {
    if (disposed || ready) return;
    ready = true;
    post({ type: 'ready' });
    if (visible) observe();
    on(view, 'resize', resized);
    on(doc, 'load', changed, true); on(doc, 'error', changed, true);
    on(doc, 'toggle', changed, true);
    on(doc, 'input', changed, true); on(doc, 'change', changed, true);
    if (doc.fonts) {
      on(doc.fonts, 'loadingdone', changed); on(doc.fonts, 'loadingerror', changed);
      doc.fonts.ready.then(changed, changed);
    }
    queue(true);
  }
  if (doc.readyState === 'loading') on(doc, 'DOMContentLoaded', start, { once: true });
  else start();
  return {
    queue: changed,
    setVisible(value) {
      if (disposed || value === visible) return;
      visible = value; cancel();
      if (!value) { resize?.disconnect(); mutation.disconnect(); }
      else { if (ready) observe(); queue(true); }
    },
    dispose() {
      if (disposed) return;
      disposed = true; cancel(); resize?.disconnect(); mutation.disconnect();
      for (const unsubscribe of subscriptions) unsubscribe();
    },
  };
}
