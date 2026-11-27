import { readHtmlArtifact } from './api.js';
import { onThemeChange } from './theme.js';
import { projectHtmlArtifactReference, HTML_ARTIFACT_MAX_BYTES } from './html-artifact-model.js';
import { captureReadingPosition, restoreReadingPosition, findScrollContainer } from './reading-position.js';
import { readHtmlArtifactTheme } from './html-artifact-theme.js';
import { htmlArtifactDocument, HTML_ARTIFACT_FRAME_NAME, HTML_ARTIFACT_PERMISSIONS } from './html-artifact-frame.js';
import { createHtmlArtifactResizeController, createHtmlArtifactVisibilityController } from './html-artifact-layout.js';
import { createArtifactDialog } from './html-artifact-dialog.js';
import { createArtifactInteractions, validArtifactMessage } from './html-artifact-interactions.js';

const viewers = new WeakMap(); // DOM resource ownership, never an HTML/message cache.
const REGISTER_TIMEOUT_MS = 3000;
const READY_TIMEOUT_MS = 8000;
const READ_TIMEOUT_MS = 10000;
const PENDING_RETRIES = 3;
const PRESENTATION_TIMEOUT_MS = 1200;

function randomNonce(view) {
  const bytes = new Uint8Array(16);
  view.crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function captureScope(scope) {
  if (!scope || typeof scope !== 'object') return null;
  const copy = {};
  for (const key of ['conversationId', 'sessionId']) if (typeof scope[key] === 'string' && scope[key]) copy[key] = scope[key];
  if (scope.owner && typeof scope.owner === 'object') copy.owner = Object.freeze({ ...scope.owner });
  return Object.keys(copy).length ? Object.freeze(copy) : null;
}
const sameReference = (left, right) => right && Object.keys(left).every(key => left[key] === right[key]);

export function createHtmlArtifactViewer(reference, {
  scope, isCurrent = () => true, document: doc = globalThis.document,
  fetcher = readHtmlArtifact, preserveLayout = null,
} = {}) {
  const artifact = projectHtmlArtifactReference(reference);
  const capturedScope = captureScope(scope);
  if (!artifact || !doc?.defaultView) return null;
  const view = doc.defaultView;
  const wrapper = doc.createElement('div');
  wrapper.className = 'html-artifact';
  wrapper.dataset.artifactId = artifact.id;
  wrapper.dataset.state = 'loading';
  wrapper.setAttribute('aria-busy', 'true');
  const status = doc.createElement('div');
  status.className = 'html-artifact-loading';
  status.setAttribute('role', 'status');
  const caption = doc.createElement('span');
  caption.textContent = '正在加载可视化…';
  const retry = doc.createElement('button');
  retry.type = 'button'; retry.className = 'btn ghost tiny html-artifact-retry'; retry.textContent = '重试'; retry.hidden = true;
  status.append(caption, retry);
  wrapper.append(status);

  const bridge = view.piGuiDesktop?.htmlArtifacts;
  let frame = null, disposed = false, started = false, registered = false, inFlight = false;
  let nonce = null, controller = null, attempt = 0, resizer = null;
  let visibility = null, visible = false, lastEscape = -Infinity;
  let presentationSequence = 0, pendingPresentation = null;
  let unsubscribeTheme = null, themeObserver = null, lastTheme = '';
  const timers = new Map();
  const current = () => !disposed && wrapper.isConnected && isCurrent();
  const clearTimer = key => {
    const timer = timers.get(key);
    if (!timer) return;
    clearTimeout(timer.id); timers.delete(key); timer.resolve?.(null);
  };
  const later = (key, ms, callback) => {
    clearTimer(key);
    timers.set(key, { id: setTimeout(() => { timers.delete(key); callback(); }, ms) });
  };
  const bounded = async (key, promise, ms) => {
    const timeout = new Promise(resolve => {
      timers.set(key, { id: setTimeout(() => { timers.delete(key); resolve(null); }, ms), resolve });
    });
    try { return await Promise.race([promise, timeout]); }
    finally { clearTimer(key); }
  };
  const delay = ms => bounded('pending', new Promise(resolve => {
    later('pending-delay', ms, () => resolve(true));
  }), ms + 50);
  const layout = (action, options = {}) => {
    if (!current()) return;
    if (preserveLayout && options.isPinned !== false) return preserveLayout(action);
    const scroller = findScrollContainer(wrapper);
    const bookmark = scroller?.clientHeight > 0 ? captureReadingPosition(scroller, scroller, { isPinned: false }) : null;
    action();
    if (bookmark) restoreReadingPosition(scroller, scroller, bookmark);
  };
  const notice = doc.createElement('div');
  notice.className = 'html-artifact-notice'; notice.setAttribute('role', 'status'); notice.hidden = true;
  const report = text => { notice.textContent = text; notice.hidden = false; };
  const dialog = createArtifactDialog({ wrapper, title: artifact.title, document: doc, layout,
    present: requestPresentation, cancelPresentation: () => settlePresentation(false), isCurrent: current, report,
    onChange: () => { sendVisibility(); visibility?.refresh(); } });
  wrapper.append(notice);
  const interactions = createArtifactInteractions({ document: doc, isCurrent: current, getFrame: () => frame,
    closeExpanded: () => dialog.close(), report });
  function settlePresentation(ok) {
    if (!pendingPresentation) return;
    const pending = pendingPresentation; pendingPresentation = null;
    clearTimer('presentation'); pending.resolve(ok);
  }
  function requestPresentation(expanded) {
    settlePresentation(false);
    if (!current() || !registered || !frame?.contentWindow || !nonce
      || presentationSequence >= Number.MAX_SAFE_INTEGER) return Promise.resolve(false);
    const sequence = ++presentationSequence;
    return new Promise(resolve => {
      pendingPresentation = { sequence, expanded, resolve, deadline: view.performance.now() + PRESENTATION_TIMEOUT_MS };
      later('presentation', PRESENTATION_TIMEOUT_MS, () => settlePresentation(false));
      try {
        frame.contentWindow.postMessage({ schemaVersion: 1, type: 'presentation', id: artifact.id,
          nonce, expanded, sequence }, '*');
      } catch { settlePresentation(false); }
    });
  }
  function sendVisibility() {
    if (!current() || !registered || !frame || !nonce) return;
    frame.contentWindow?.postMessage({ schemaVersion: 1, type: 'visibility', id: artifact.id, nonce,
      visible: !doc.hidden && (visible || dialog.isExpanded()) }, '*');
  }
  const releaseRegistration = () => {
    try { Promise.resolve(bridge?.releaseFrame?.({ name: HTML_ARTIFACT_FRAME_NAME })).catch(() => {}); }
    catch { /* best-effort cleanup; native guards never unprotect a live frame */ }
  };
  const removeFrame = () => {
    settlePresentation(false);
    resizer?.dispose(); resizer = null;
    interactions.closeImage(); dialog.close();
    if (frame) { frame.remove(); frame.removeAttribute('srcdoc'); frame = null; }
    dialog.setFrame(null);
    if (registered) releaseRegistration(); // Removal MUST precede release.
    registered = false; nonce = null;
  };
  const fail = text => {
    if (!current()) return;
    clearTimer('ready');
    controller?.abort();
    layout(() => {
      removeFrame(); wrapper.dataset.state = 'error'; wrapper.setAttribute('aria-busy', 'false');
      status.hidden = false; caption.textContent = text; retry.hidden = false; retry.disabled = false;
    });
  };
  const sendTheme = (force = false) => {
    if (!current() || !registered || !nonce || !frame) return;
    const theme = readHtmlArtifactTheme(doc);
    const signature = JSON.stringify(theme);
    if (!force && lastTheme === signature) return;
    lastTheme = signature;
    // Opaque srcdoc has no target origin. Only this exact frame receives these
    // resolved theme values, never host handles, commands, HTML or credentials.
    frame.contentWindow?.postMessage({ schemaVersion: 1, type: 'theme', id: artifact.id, nonce, theme }, '*');
  };
  const onMessage = event => {
    if (!current() || !registered || !nonce || !frame || event.source !== frame.contentWindow || event.origin !== 'null') return;
    const value = event.data;
    if (!value || value.id !== artifact.id || value.nonce !== nonce || !validArtifactMessage(value)) return;
    if (value.type === 'ready') {
      if (wrapper.dataset.state === 'ready') return;
      clearTimer('ready');
      layout(() => { wrapper.dataset.state = 'ready'; wrapper.setAttribute('aria-busy', 'false'); status.hidden = true; });
      sendTheme(true); sendVisibility();
    } else if (value.type === 'resize') {
      resizer?.accept(value);
    } else if (value.type === 'presentation-ready') {
      const pending = pendingPresentation;
      if (!pending || value.sequence !== pending.sequence || value.expanded !== pending.expanded) return;
      settlePresentation(view.performance.now() < pending.deadline);
    } else if (wrapper.dataset.state === 'ready') {
      if (value.type === 'escape' && view.performance.now() - lastEscape >= 250) {
        lastEscape = view.performance.now();
        if (interactions.hasImage()) interactions.closeImage();
        else dialog.close(); // Also cancels an expansion still waiting for ACK.
      } else if (value.type === 'link') void interactions.link(value.href);
      else if (value.type === 'image') interactions.image(value.src, value.alt);
    }
  };
  function appendEmptyFrame() {
    frame = doc.createElement('iframe');
    frame.className = 'html-artifact-frame'; frame.title = artifact.title;
    frame.name = HTML_ARTIFACT_FRAME_NAME;
    frame.setAttribute('sandbox', ''); // No scripts until native qualification.
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', HTML_ARTIFACT_PERMISSIONS);
    frame.style.height = `${artifact.height}px`;
    // No src attribute: the default empty about:blank must be in the real frame
    // tree before registration can acknowledge this specific child identity.
    dialog.stage.append(frame);
    dialog.setFrame(frame, artifact.height);
    resizer = createHtmlArtifactResizeController({ view, isCurrent: current,
      apply: value => { if (frame) dialog.resize(value); } });
  }
  async function register(generation) {
    if (!capturedScope || typeof bridge?.registerFrame !== 'function') return false;
    const candidate = frame;
    const registration = Promise.resolve().then(() => bridge.registerFrame({ name: HTML_ARTIFACT_FRAME_NAME }));
    const result = await bounded('register', registration, REGISTER_TIMEOUT_MS);
    if (!result) registration.then(late => {
      if (late?.ok === true) { candidate.remove(); releaseRegistration(); }
    }, () => {});
    if (!current() || generation !== attempt) {
      candidate.remove(); if (result?.ok === true) releaseRegistration(); return false;
    }
    if (result?.ok !== true || result.javascriptEnabled !== true) {
      candidate.remove(); if (result?.ok === true) releaseRegistration(); return false;
    }
    return true;
  }
  async function read(signal) {
    for (let index = 0; index <= PENDING_RETRIES; index++) {
      if (!current() || signal.aborted) return null;
      const result = await fetcher(artifact.id, capturedScope, { signal });
      if (!current() || signal.aborted) return null;
      if (result?.ok === true || result?.code !== 'reference_pending' || index === PENDING_RETRIES) return result;
      if (!await delay(120 * (index + 1))) return null;
    }
    return null;
  }
  async function load() {
    if (!current() || inFlight) return false;
    inFlight = true;
    const generation = ++attempt;
    try {
      layout(() => {
        removeFrame(); appendEmptyFrame(); wrapper.dataset.state = 'loading'; wrapper.setAttribute('aria-busy', 'true');
        status.hidden = false; caption.textContent = '正在加载可视化…'; retry.hidden = true; retry.disabled = true;
      });
      registered = await register(generation);
      if (!current() || generation !== attempt) return false;
      if (!registered) { fail('可视化安全环境不可用。'); return false; }
      controller = new AbortController();
      const result = await bounded('read', read(controller.signal), READ_TIMEOUT_MS);
      if (!current() || generation !== attempt || controller.signal.aborted) return false;
      if (!result) { fail('可视化加载超时，请重试。'); return false; }
      const returned = projectHtmlArtifactReference(result.artifact);
      if (result.ok !== true || !sameReference(artifact, returned) || typeof result.html !== 'string'
        || new TextEncoder().encode(result.html).length !== artifact.bytes
        || artifact.bytes > HTML_ARTIFACT_MAX_BYTES) {
        fail(result.code === 'reference_pending' ? '可视化仍在保存，请重试。' : '可视化暂时无法加载。'); return false;
      }
      nonce = randomNonce(view); lastTheme = '';
      frame.setAttribute('sandbox', 'allow-scripts');
      // The fetched HTML remains only in this call and the isolated srcdoc;
      // ordinary state, tool details, diagnostics and caches never own it.
      frame.srcdoc = htmlArtifactDocument(result.html, { id: artifact.id, nonce,
        hostOrigin: view.location.origin, theme: readHtmlArtifactTheme(doc) });
      later('ready', READY_TIMEOUT_MS, () => fail('可视化未能显示，请重试。'));
      return true;
    } catch { if (current()) fail('可视化暂时无法加载。'); return false; }
    finally { inFlight = false; clearTimer('read'); }
  }
  function mount() {
    if (!current() || started) return;
    started = true;
    view.addEventListener('message', onMessage);
    view.addEventListener('pagehide', dispose, { once: true });
    unsubscribeTheme = onThemeChange(sendTheme);
    themeObserver = new view.MutationObserver(sendTheme);
    for (const target of [doc.documentElement, doc.body]) if (target) themeObserver.observe(target,
      { attributes: true, attributeFilter: ['data-theme', 'data-theme-preference', 'style', 'class'] });
    visibility = createHtmlArtifactVisibilityController({ node: wrapper, document: doc,
      onVisibility: next => {
        visible = next;
        if (next && !frame && !inFlight && wrapper.dataset.state === 'loading') void load();
        else sendVisibility();
      } });
  }
  function dispose() {
    if (disposed) return;
    disposed = true; ++attempt; settlePresentation(false);
    controller?.abort(); controller = null;
    for (const key of [...timers.keys()]) clearTimer(key);
    unsubscribeTheme?.(); themeObserver?.disconnect(); visibility?.dispose();
    view.removeEventListener('message', onMessage); view.removeEventListener('pagehide', dispose);
    retry.onclick = null;
    interactions.dispose(); dialog.dispose();
    removeFrame();
    viewers.delete(wrapper);
  }
  retry.onclick = () => { void load(); };
  const viewer = { node: wrapper, mount, dispose };
  viewers.set(wrapper, viewer);
  return viewer;
}

function artifactNodes(root) {
  return [...(root?.matches?.('.html-artifact') ? [root] : []), ...root?.querySelectorAll?.('.html-artifact') || []];
}
export function mountHtmlArtifacts(root) {
  for (const node of artifactNodes(root)) viewers.get(node)?.mount();
}
export function disposeHtmlArtifacts(root) {
  for (const node of artifactNodes(root)) viewers.get(node)?.dispose();
}
