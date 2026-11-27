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
  // Absence is an old-v1 snapshot, not permission to use raw naturalHeight.
  if (value.feedback !== undefined) {
    if (typeof value.feedback !== 'boolean') return null;
    snapshot.feedback = value.feedback;
  }
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
 * IO remains the primary signal; after a stale non-intersection sample, a measured
 * nonzero rect can recover a target moved into the 600px prewarm band. Zero-sized
 * jsdom rectangles never guess. Old browsers retain eager mount while
 * document/ancestor visibility still pauses existing frames.
 */
export function createHtmlArtifactVisibilityController({ node, onVisibility, document: doc = node?.ownerDocument } = {}) {
  const view = doc?.defaultView;
  if (!node || !view) return { refresh() {}, dispose() {} };
  const prewarmMargin = 600, geometryRecheckInterval = 80, maxGeometryRechecks = 8;
  let disposed = false, last = null, queued = null, geometryTimer = null, geometryRechecks = 0;
  let nearby = typeof view.IntersectionObserver !== 'function';
  function measuredNearby() {
    if (typeof node.getBoundingClientRect !== 'function') return false;
    let rect;
    try { rect = node.getBoundingClientRect(); } catch { return false; }
    const width = Number(view.innerWidth || doc.documentElement?.clientWidth);
    const height = Number(view.innerHeight || doc.documentElement?.clientHeight);
    if (!rect || ![rect.left, rect.right, rect.top, rect.bottom, rect.width, rect.height, width, height].every(Number.isFinite)
      || rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) return false;
    if (rect.right < 0 || rect.left > width || rect.bottom < -prewarmMargin || rect.top > height + prewarmMargin) return false;
    const bounds = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = view.getComputedStyle(parent);
      for (const [axis, start, end] of [['X', 'left', 'right'], ['Y', 'top', 'bottom']]) {
        const overflow = style[`overflow${axis}`] || style.overflow;
        const scrolls = ['auto', 'scroll', 'overlay'].includes(overflow);
        if (!scrolls && !['hidden', 'clip'].includes(overflow)) continue;
        const clip = parent.getBoundingClientRect();
        if (![clip[start], clip[end]].every(Number.isFinite) || clip[end] <= clip[start]) return false;
        // Overflow alone does not make clipped negative-offset content reachable.
        const margin = scrolls && axis === 'Y' && parent.clientHeight > 0
          && parent.scrollHeight > parent.clientHeight ? prewarmMargin : 0;
        if (bounds[end] < clip[start] - margin || bounds[start] > clip[end] + margin) return false;
        // Project the prewarmed fragment onto its scrollport before testing
        // outer clips. A shell clip must not erase an inner scrollport's band;
        // a hidden/clip ancestor inside that scrollport is never expanded.
        bounds[start] = Math.max(clip[start], Math.min(clip[end], bounds[start]));
        bounds[end] = Math.max(clip[start], Math.min(clip[end], bounds[end]));
      }
    }
    return true;
  }
  function visible() {
    if (!node.isConnected || doc.hidden || node.closest('[hidden]')) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = view.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.contentVisibility === 'hidden') return false;
      if (parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector('summary')?.contains(node)) return false;
    }
    return nearby || measuredNearby();
  }
  function stopGeometryRechecks() {
    if (geometryTimer !== null) view.clearTimeout(geometryTimer);
    geometryTimer = null; geometryRechecks = 0;
  }
  function scheduleGeometryRecheck() {
    if (typeof view.IntersectionObserver !== 'function' || nearby || last === true
      || geometryTimer !== null || geometryRechecks >= maxGeometryRechecks || disposed) return;
    geometryTimer = view.setTimeout(() => {
      geometryTimer = null; geometryRechecks++;
      refresh();
    }, geometryRecheckInterval);
  }
  function refresh() {
    if (disposed) return;
    const next = visible();
    if (next !== last) { last = next; onVisibility?.(next); }
    if (next) stopGeometryRechecks(); else scheduleGeometryRecheck();
  }
  function schedule() {
    if (queued !== null || disposed) return;
    queued = view.requestAnimationFrame(() => { queued = null; refresh(); });
  }
  const intersection = typeof view.IntersectionObserver === 'function'
    ? new view.IntersectionObserver(entries => {
      for (const entry of entries) if (entry.target === node) nearby = entry.isIntersecting;
      refresh();
    }, { rootMargin: `${prewarmMargin}px 0px` }) : null;
  intersection?.observe(node);
  const mutation = new view.MutationObserver(schedule);
  // Only this ancestor chain owns visibility; no subtree/per-artifact observers
  // across the whole timeline. Resize reports don't cause observer feedback.
  for (let parent = node; parent; parent = parent.parentElement) {
    mutation.observe(parent, { attributes: true, attributeFilter: ['hidden', 'style', 'class', 'open'] });
  }
  doc.addEventListener('scroll', schedule, true);
  doc.addEventListener('visibilitychange', refresh);
  view.addEventListener('resize', schedule);
  view.addEventListener('pageshow', refresh);
  refresh();
  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (queued !== null) view.cancelAnimationFrame(queued);
      queued = null; intersection?.disconnect(); mutation.disconnect(); stopGeometryRechecks();
      doc.removeEventListener('scroll', schedule, true);
      doc.removeEventListener('visibilitychange', refresh);
      view.removeEventListener('resize', schedule);
      view.removeEventListener('pageshow', refresh);
    },
  };
}
