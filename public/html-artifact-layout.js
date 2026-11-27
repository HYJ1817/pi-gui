// Host-side scheduling only. The viewer owns identity validation, frame
// registration and disposal; these helpers never create/remove/navigate a frame.
export const HTML_ARTIFACT_RESIZE_INTERVAL_MS = 100;
export const HTML_ARTIFACT_MAX_NATURAL_SIZE = 1000000;

function resizeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.height !== 'number' || !Number.isFinite(value.height)) return null;
  const snapshot = { height: Math.max(80, Math.min(4096, Math.ceil(value.height))) };
  for (const key of ['naturalHeight', 'naturalWidth']) {
    if (value[key] === undefined) continue; // v1 callers need only height.
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) return null;
    snapshot[key] = Math.min(HTML_ARTIFACT_MAX_NATURAL_SIZE, Math.ceil(value[key]));
  }
  if (value.capped !== undefined && typeof value.capped !== 'boolean') return null;
  snapshot.capped = value.capped ?? value.height > 4096;
  return snapshot;
}

/** Call accept only AFTER source/origin/schema/id/nonce validation. Limit host
 * writes too: same-realm scripts can bypass the trusted bootstrap's scheduler.
 * flush schedules the final value; it deliberately cannot bypass the rate limit.
 */
export function createHtmlArtifactResizeController({ view = globalThis.window, apply, isCurrent = () => true } = {}) {
  let pending = null, previous = '', lastWrite = -Infinity, timer = null, frame = null, disposed = false;
  const now = () => view.performance.now();
  function cancel() {
    if (timer !== null) view.clearTimeout(timer);
    if (frame !== null) view.cancelAnimationFrame(frame);
    timer = null; frame = null;
  }
  function commit() {
    frame = null;
    if (disposed || !isCurrent()) { pending = null; return; }
    const snapshot = pending;
    pending = null;
    if (!snapshot) return;
    const signature = JSON.stringify(snapshot);
    if (signature === previous) return;
    previous = signature; lastWrite = now();
    apply?.(snapshot);
  }
  function schedule() {
    if (disposed || !pending || timer !== null || frame !== null) return;
    const wait = Math.max(0, HTML_ARTIFACT_RESIZE_INTERVAL_MS - (now() - lastWrite));
    if (wait > 0) timer = view.setTimeout(() => { timer = null; schedule(); }, wait);
    else frame = view.requestAnimationFrame(commit);
  }
  return {
    accept(value) {
      if (disposed || !isCurrent()) return false;
      const snapshot = resizeSnapshot(value);
      if (!snapshot) return false;
      pending = snapshot; schedule(); return true;
    },
    flush: schedule,
    dispose() { disposed = true; pending = null; cancel(); },
  };
}

/** Near-viewport lazy-mount/activity signal, NOT a second resource owner.
 * C decides when to mount and sends the visibility envelope to an existing frame.
 * No IO fallback guesses from zero-sized jsdom rectangles; old browsers retain
 * eager mount while document/ancestor visibility still pauses existing frames.
 */
export function createHtmlArtifactVisibilityController({ node, onVisibility, document: doc = node?.ownerDocument } = {}) {
  const view = doc?.defaultView;
  if (!node || !view) return { refresh() {}, dispose() {} };
  let disposed = false, last = null, queued = null;
  let nearby = typeof view.IntersectionObserver !== 'function';
  function visible() {
    if (!node.isConnected || doc.hidden || !nearby || node.closest('[hidden]')) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = view.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.contentVisibility === 'hidden') return false;
      if (parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector('summary')?.contains(node)) return false;
    }
    return true;
  }
  function refresh() {
    if (disposed) return;
    const next = visible();
    if (next !== last) { last = next; onVisibility?.(next); }
  }
  function schedule() {
    if (queued !== null || disposed) return;
    queued = view.requestAnimationFrame(() => { queued = null; refresh(); });
  }
  const intersection = typeof view.IntersectionObserver === 'function'
    ? new view.IntersectionObserver(entries => {
      for (const entry of entries) if (entry.target === node) nearby = entry.isIntersecting;
      refresh();
    }, { rootMargin: '600px 0px' }) : null;
  intersection?.observe(node);
  const mutation = new view.MutationObserver(schedule);
  // Only this ancestor chain owns visibility; no subtree/per-artifact observers
  // across the whole timeline. Resize reports don't cause observer feedback.
  for (let parent = node; parent; parent = parent.parentElement) {
    mutation.observe(parent, { attributes: true, attributeFilter: ['hidden', 'style', 'class', 'open'] });
  }
  doc.addEventListener('visibilitychange', refresh);
  view.addEventListener('pageshow', refresh);
  refresh();
  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (queued !== null) view.cancelAnimationFrame(queued);
      queued = null; intersection?.disconnect(); mutation.disconnect();
      doc.removeEventListener('visibilitychange', refresh);
      view.removeEventListener('pageshow', refresh);
    },
  };
}
