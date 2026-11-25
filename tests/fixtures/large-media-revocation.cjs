'use strict';
// Read-only browser observers. A second *native* EventSource observes the real
// production SSE transport; app.js still owns its own connection and dispatch.
// No synthetic SSE, document event, decoder error or teardown is injected here.
function installGrantRevocationObserver(grantId) {
  const video = window.__largeVideo;
  const tab = document.querySelector('.files-tab[aria-selected="true"] .files-tab-select');
  if (!video?.isConnected || !tab) throw Error('external_media_owner_required');
  const tabId = tab.id;
  const started = performance.now();
  const state = { nativeSse: [], dispatches: [], mediaErrors: 0 };
  const snapshot = () => ({
    tabPresent: !!document.getElementById(tabId), connected: video.isConnected,
    sourcePresent: !!video.getAttribute('src'), paused: video.paused,
    readyState: video.readyState, error: video.error?.code || 0,
  });
  const mediaError = () => { state.mediaErrors++; };
  video.addEventListener('error', mediaError);
  const dispatched = event => {
    if (event.detail?.revoked !== grantId) return;
    const row = { atMs: performance.now() - started, before: snapshot(), after: null };
    state.dispatches.push(row);
    // Capture runs before Files' non-capture listener. Its first microtask is
    // queued before any deferred owner cleanup: a microtask/await-based teardown
    // cannot masquerade as synchronous removal in this observation.
    queueMicrotask(() => { row.after = snapshot(); });
  };
  document.addEventListener('pi-gui:external-grants', dispatched, true);
  const source = new EventSource('/api/events');
  source.addEventListener('message', event => {
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.type !== 'external_grants' || frame.detail?.revoked !== grantId) return;
    // Retain only structural proof; no grant id, path or raw event payload.
    state.nativeSse.push({ trusted: event.isTrusted, sequence: frame._seq,
      replay: frame._replay === true, atMs: performance.now() - started });
  });
  window.__largeGrantObserver = {
    summary: () => structuredClone(state),
    dispose() {
      source.close(); video.removeEventListener('error', mediaError);
      document.removeEventListener('pi-gui:external-grants', dispatched, true);
    },
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { source.close(); reject(Error('native_sse_observer_timeout')); }, 5000);
    source.addEventListener('open', () => { clearTimeout(timer); resolve(true); }, { once: true });
    source.addEventListener('error', () => { clearTimeout(timer); reject(Error('native_sse_observer_failed')); }, { once: true });
  });
}
function isSynchronousGrantTeardown(evidence) {
  const wire = evidence?.nativeSse, dispatches = evidence?.dispatches;
  if (wire?.length !== 1 || dispatches?.length !== 1 || evidence.mediaErrors !== 0) return false;
  const event = wire[0], { before, after } = dispatches[0];
  return event.trusted === true && Number.isSafeInteger(event.sequence) && event.sequence > 0 && event.replay === false
    && before?.tabPresent === true && before.connected === true && before.sourcePresent === true
    && before.paused === true && before.readyState >= 2 && before.error === 0
    && after?.tabPresent === false && after.connected === false && after.sourcePresent === false
    && after.paused === true && after.readyState === 0 && after.error === 0;
}
module.exports = { installGrantRevocationObserver, isSynchronousGrantTeardown };
