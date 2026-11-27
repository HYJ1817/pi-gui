import { artifactIconButton, createArtifactControls } from './html-artifact-controls.js';

const activeDialogs = new WeakMap();
const MAX_EXPANDED_HEIGHT = 65536;

/** A dialog is rendered inline from the beginning, then promoted to the native
 * top layer. Neither it nor its iframe is reparented (appendChild reloads frames).
 * openModal clears/moves its content, so it cannot own this live browsing context.
 */
export function createArtifactDialog({ wrapper, title, document: doc, layout,
  present = async () => false, cancelPresentation = () => {}, isCurrent = () => true,
  report = () => {}, onChange = () => {} }) {
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
  let frame = null, expanded = false, opening = false, restoring = false, unavailable = false;
  let disposed = false, returnFocus = null, transition = 0;
  let inlineWidth = 728, baseWidth = 728, scale = 1, fitting = true;
  let metrics = { height: 320 }, inlineScroll = null, expandedHeight = 320;
  const acceptedHeight = value => value.feedback === false && Number.isFinite(value.naturalHeight)
    ? Math.max(80, Math.min(MAX_EXPANDED_HEIGHT, value.naturalHeight)) : value.height;
  const supported = typeof surface.showModal === 'function';
  expand.disabled = !supported;
  if (!supported) expand.title = '当前浏览器不支持全屏查看';

  function geometry() {
    if (!frame || disposed) return;
    const available = viewport.clientWidth || wrapper.clientWidth || inlineWidth;
    const width = expanded && !fitting ? baseWidth : available;
    // Beyond this explicit bound the frame remains internally scrollable. Never
    // allocate an unbounded host layout from model-controlled naturalHeight.
    // naturalHeight is raw telemetry. Only an explicitly accepted measurement
    // may update expandedHeight; feedback holds must apply to THIS viewport too.
    const height = expanded ? expandedHeight : metrics.height;
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
  function updateExpand() {
    expand.disabled = !supported || disposed || unavailable;
    // Keep the return-focus target in the keyboard sequence during the ACK wait.
    expand.setAttribute('aria-disabled', String(opening || restoring || unavailable));
    expand.setAttribute('aria-busy', String(opening || restoring));
  }
  function restorePresentation() {
    const generation = ++transition;
    restoring = true; updateExpand();
    // Do not let another true cancel the frame's double-native-rAF restoration.
    // A restore timeout leaves inline usable, but expansion closed until remount.
    Promise.resolve().then(() => !disposed && generation === transition && present(false)).catch(() => false).then(ok => {
      if (disposed || generation !== transition) return;
      restoring = false; unavailable = !ok;
      if (!ok) {
        expand.title = '阅读位置恢复尚未确认，暂时无法全屏查看';
        report('阅读位置恢复尚未确认，已保留内联视图。');
      }
      updateExpand();
    });
  }
  async function open() {
    if (disposed || !isCurrent() || expanded || opening || restoring || unavailable
      || !supported || !frame || wrapper.dataset.state !== 'ready') return false;
    activeDialogs.get(doc)?.close();
    activeDialogs.set(doc, api);
    returnFocus = doc.activeElement;
    const generation = ++transition;
    opening = true; updateExpand();
    // The matching ACK proves local scroll was saved BEFORE any geometry change.
    let prepared = false;
    try { prepared = await present(true); } catch { /* fail closed inline */ }
    if (disposed || generation !== transition) return false;
    if (!prepared || !isCurrent() || !frame || !wrapper.isConnected) {
      if (isCurrent()) report('全屏查看未能就绪，已保留内联视图。');
      close();
      return false;
    }
    inlineWidth = viewport.clientWidth || wrapper.clientWidth || inlineWidth;
    baseWidth = inlineWidth; scale = 1; fitting = true;
    expandedHeight = acceptedHeight(metrics);
    inlineScroll = { top: viewport.scrollTop, left: viewport.scrollLeft };
    try {
      layout(() => {
        wrapper.style.height = `${wrapper.getBoundingClientRect().height}px`;
        surface.setAttribute('role', 'dialog'); surface.setAttribute('aria-modal', 'true');
        surface.showModal();
        expanded = true;
        wrapper.dataset.expanded = 'true'; expand.setAttribute('aria-expanded', 'true');
        geometry(); controls.close.focus({ preventScroll: true });
      }, { isPinned: false });
    } catch {
      report('全屏查看暂时不可用，已保留内联视图。');
      close(); return false;
    }
    if (!expanded) { close(); return false; }
    opening = false; updateExpand(); onChange(true);
    return true;
  }
  function close(restore = true) {
    if (!opening && !expanded) return false;
    ++transition; opening = false; cancelPresentation();
    const action = () => {
      expanded = false;
      if (surface.open) surface.close();
      surface.setAttribute('role', 'group'); surface.removeAttribute('aria-modal');
      delete wrapper.dataset.expanded; wrapper.style.removeProperty('height');
      expand.setAttribute('aria-expanded', 'false');
      if (activeDialogs.get(doc) === api) activeDialogs.delete(doc);
      geometry();
      if (inlineScroll) { viewport.scrollTop = inlineScroll.top; viewport.scrollLeft = inlineScroll.left; }
      inlineScroll = null;
    };
    if (disposed || !isCurrent()) action(); else layout(action, { isPinned: false });
    // The false request must be sent AFTER synchronous inline geometry restore.
    if (!disposed && isCurrent()) restorePresentation();
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
    if ((!expanded && !opening) || activeDialogs.get(doc) !== api) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    // The browser owns the modal Tab loop, including entry/exit from the opaque
    // iframe. No synthetic key RPC or incomplete host-only focus trap.
  }
  expand.onclick = open;
  surface.addEventListener('cancel', onCancel);
  surface.addEventListener('close', onClose);
  view.addEventListener('keydown', onKey);
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
    setFrame(next, initialHeight = 320) {
      ++transition; cancelPresentation();
      opening = false; restoring = false; unavailable = false;
      frame = next; metrics = { height: initialHeight }; expandedHeight = initialHeight;
      if (supported) expand.title = '全屏查看可视化';
      updateExpand(); geometry();
    },
    resize(value) {
      metrics = value;
      if (expanded && value.feedback !== true) expandedHeight = acceptedHeight(value);
      if (expanded) geometry(); else layout(geometry);
    },
    dispose() {
      if (disposed) return;
      disposed = true; ++transition; cancelPresentation(); close(false); updateExpand();
      observer?.disconnect(); view.removeEventListener('resize', resize);
      surface.removeEventListener('cancel', onCancel); surface.removeEventListener('close', onClose);
      view.removeEventListener('keydown', onKey); expand.onclick = null;
      controls.dispose(); frame = null;
    },
  };
  return api;
}
