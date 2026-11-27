import { artifactIconButton, createArtifactControls } from './html-artifact-controls.js';

const activeDialogs = new WeakMap();
const MAX_EXPANDED_HEIGHT = 65536;

/** A dialog is rendered inline from the beginning, then promoted to the native
 * top layer. Neither it nor its iframe is reparented (appendChild reloads frames).
 * openModal clears/moves its content, so it cannot own this live browsing context.
 */
export function createArtifactDialog({ wrapper, title, document: doc, layout, onChange = () => {} }) {
  const view = doc.defaultView;
  const surface = doc.createElement('dialog');
  surface.className = 'html-artifact-surface';
  surface.setAttribute('role', 'group');
  surface.setAttribute('aria-label', title);
  const viewport = doc.createElement('div');
  viewport.className = 'html-artifact-viewport';
  const stage = doc.createElement('div');
  stage.className = 'html-artifact-stage';
  viewport.append(stage);
  const expand = artifactIconButton(doc, 'external', '全屏查看可视化', 'html-artifact-expand');
  expand.setAttribute('aria-haspopup', 'dialog');
  expand.setAttribute('aria-expanded', 'false');
  const controls = createArtifactControls(doc, {
    onZoom: delta => zoom(delta), onReset: () => zoom(0, 'reset'),
    onFit: () => zoom(0, 'fit'), onClose: () => close(),
  });
  surface.append(viewport, controls.node);
  wrapper.append(surface, expand);
  let frame = null, expanded = false, disposed = false, returnFocus = null;
  let inlineWidth = 728, baseWidth = 728, scale = 1, fitting = true;
  let metrics = { height: 320 }, inlineScroll = null;
  const supported = typeof surface.showModal === 'function';
  expand.disabled = !supported;
  if (!supported) expand.title = '当前浏览器不支持全屏查看';

  function geometry() {
    if (!frame || disposed) return;
    const available = viewport.clientWidth || wrapper.clientWidth || inlineWidth;
    const width = expanded && !fitting ? baseWidth : available;
    // Beyond this explicit bound the frame remains internally scrollable. Never
    // allocate an unbounded host layout from model-controlled naturalHeight.
    const height = expanded && Number.isFinite(metrics.naturalHeight)
      ? Math.max(80, Math.min(MAX_EXPANDED_HEIGHT, metrics.naturalHeight)) : metrics.height;
    const factor = expanded ? scale : 1;
    stage.style.width = `${Math.ceil(width * factor)}px`;
    stage.style.height = `${Math.ceil(height * factor)}px`;
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    frame.style.transform = factor === 1 ? 'none' : `scale(${factor})`;
    wrapper.dataset.capped = String(Boolean(metrics.capped));
    surface.dataset.zoom = String(factor);
    surface.dataset.zoomMode = expanded && !fitting ? 'transform' : 'responsive';
    controls.update(factor, fitting);
  }
  function zoom(delta, mode) {
    if (!expanded || disposed) return;
    const point = { top: viewport.scrollTop / scale, left: viewport.scrollLeft / scale };
    if (mode === 'fit') { fitting = true; scale = 1; }
    else if (mode === 'reset') { fitting = false; baseWidth = inlineWidth; scale = 1; }
    else {
      if (fitting) baseWidth = viewport.clientWidth || inlineWidth;
      fitting = false; scale = Math.max(0.5, Math.min(2, scale + delta));
    }
    geometry();
    // Only a HOST control changes zoom/scroll, never a frame message.
    viewport.scrollTop = point.top * scale;
    viewport.scrollLeft = mode === 'fit' ? 0 : point.left * scale;
  }
  function open() {
    if (disposed || expanded || !supported || !frame || wrapper.dataset.state !== 'ready') return false;
    activeDialogs.get(doc)?.close();
    returnFocus = doc.activeElement;
    inlineWidth = viewport.clientWidth || wrapper.clientWidth || inlineWidth;
    baseWidth = inlineWidth; scale = 1; fitting = true;
    inlineScroll = { top: viewport.scrollTop, left: viewport.scrollLeft };
    layout(() => {
      wrapper.style.height = `${wrapper.getBoundingClientRect().height}px`;
      surface.setAttribute('role', 'dialog');
      surface.setAttribute('aria-modal', 'true');
      surface.showModal();
      expanded = true;
      wrapper.dataset.expanded = 'true';
      expand.setAttribute('aria-expanded', 'true');
      activeDialogs.set(doc, api);
      geometry();
      controls.close.focus({ preventScroll: true });
    }, { isPinned: false });
    onChange(true);
    return true;
  }
  function close(restore = true) {
    if (!expanded) return false;
    const action = () => {
      expanded = false;
      if (surface.open) surface.close();
      surface.setAttribute('role', 'group'); surface.removeAttribute('aria-modal');
      delete wrapper.dataset.expanded; wrapper.style.removeProperty('height');
      expand.setAttribute('aria-expanded', 'false');
      if (activeDialogs.get(doc) === api) activeDialogs.delete(doc);
      geometry();
      if (inlineScroll) { viewport.scrollTop = inlineScroll.top; viewport.scrollLeft = inlineScroll.left; }
    };
    if (disposed) action(); else layout(action, { isPinned: false });
    onChange(false);
    if (restore && !disposed) {
      const target = returnFocus?.isConnected && !surface.contains(returnFocus) ? returnFocus : expand;
      target.focus({ preventScroll: true });
    }
    returnFocus = null;
    return true;
  }
  function onCancel(event) { event.preventDefault(); close(); }
  function onClose() { if (!surface.open) close(); }
  function onKey(event) {
    if (!expanded || activeDialogs.get(doc) !== api) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    // The browser owns the modal Tab loop, including entry/exit from the opaque
    // iframe. No synthetic key RPC or incomplete host-only focus trap.
  }
  expand.onclick = open;
  surface.addEventListener('cancel', onCancel);
  surface.addEventListener('close', onClose);
  surface.addEventListener('keydown', onKey);
  const observer = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => {
    if (disposed) return;
    if (expanded) geometry(); else layout(geometry);
  }) : null;
  observer?.observe(viewport);
  const resize = () => { if (!disposed) { if (expanded) geometry(); else layout(geometry); } };
  view.addEventListener('resize', resize);
  const api = {
    surface, stage, viewport, expand, open, close,
    isExpanded: () => expanded && activeDialogs.get(doc) === api,
    setFrame(next, initialHeight = 320) { frame = next; metrics = { height: initialHeight }; geometry(); },
    resize(value) { metrics = value; if (expanded) geometry(); else layout(geometry); },
    dispose() {
      if (disposed) return;
      disposed = true; close(false);
      observer?.disconnect(); view.removeEventListener('resize', resize);
      surface.removeEventListener('cancel', onCancel); surface.removeEventListener('close', onClose);
      surface.removeEventListener('keydown', onKey); expand.onclick = null;
      controls.dispose(); frame = null;
    },
  };
  return api;
}
