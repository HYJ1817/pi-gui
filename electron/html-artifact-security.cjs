'use strict';

/* Visual Replies P1: authority belongs to a WebContents + FrameTreeNode, never
 * to a renderer-provided routing ID. frameTreeNodeId survives opaque srcdoc RFH
 * swaps and is never reused (Electron 44 WebFrameMain contract). The fixed name
 * locates candidate frames, but does not grant them any host privilege.
 *
 * This is defense in depth, NOT a standalone HTML sanitizer/network sandbox:
 * the trusted srcdoc prefix must install CSP and lock RTC/WebTransport/worker
 * constructors before untrusted bytes. webRequest does not intercept ICE.
 */
const { desktopQualification } = require('./desktop-qualification.cjs');
const FRAME_NAME = 'pi-gui-html-artifact';
const CHANNELS = Object.freeze({
  register: 'pi-gui:visual-replies-register-frame',
  release: 'pi-gui:visual-replies-release-frame',
});
const MAX_FRAMES = 1024;
const MAX_PENDING = 32;
const UNSAFE_SWITCHES = Object.freeze([
  'disable-setuid-sandbox', 'disable-seccomp-filter-sandbox', 'disable-site-isolation-trials',
]);
const fail = code => ({ ok: false, code });
const nodeId = frame => Number.isSafeInteger(frame?.frameTreeNodeId) && frame.frameTreeNodeId >= 0
  ? frame.frameTreeNodeId : null;

function safeEnvironment(wc, { argv, execArgv, env, hasSwitch }) {
  try {
    const prefs = wc.getLastWebPreferences();
    if (prefs.sandbox !== true || prefs.contextIsolation !== true || prefs.webSecurity !== true
      || prefs.nodeIntegration !== false || prefs.nodeIntegrationInSubFrames !== false
      || prefs.nodeIntegrationInWorker !== false || prefs.webviewTag !== false
      || prefs.allowRunningInsecureContent !== false) return false;
    // Reuse the existing desktop qualification for debugger/sandbox/env flags.
    // This check is about the renderer, not backend installation authority.
    if (!desktopQualification({ argv, execArgv, env, hasSwitch: name => hasSwitch(name) !== false,
      backendConnected: true }).ok) return false;
    const args = [...argv, ...execArgv];
    for (const flag of UNSAFE_SWITCHES) {
      if (hasSwitch(flag) !== false || args.some(arg => arg === `--${flag}` || arg.startsWith(`--${flag}=`))) return false;
    }
    return wc.getWebRTCIPHandlingPolicy() === 'disable_non_proxied_udp';
  } catch { return false; }
}

// Executed ONLY in the proved trusted main frame. Count the actual host DOM,
// not a renderer assertion. A count mismatch waits for Chromium's frame tree:
// otherwise an older registered frame could acknowledge a not-yet-created one.
function inspectHostFrames() {
  const frames = [...document.querySelectorAll('iframe[name="pi-gui-html-artifact"]')];
  return { count: frames.length, valid: frames.every(frame =>
    frame.hasAttribute('sandbox') && ['', 'allow-scripts'].includes(frame.getAttribute('sandbox').trim())
    && !frame.hasAttribute('src') && !frame.hasAttribute('allowpaymentrequest')) };
}

function createHtmlArtifactSecurity({ getWindow, origin, argv = process.argv,
  execArgv = process.execArgv, env = process.env, hasSwitch = () => false,
  registrationTimeoutMs = 1000, pollIntervalMs = 10 } = {}) {
  const states = new Map();
  let ipc = null, ipcInstalled = false, disposed = false, guardedSession = null, requestsInstalled = false;
  const environment = { argv, execArgv, env, hasSwitch };
  const waitMs = Math.max(1, Math.min(2000, registrationTimeoutMs));
  const pollMs = Math.max(1, Math.min(50, pollIntervalMs));

  function selfUrl(url) {
    try { const parsed = new URL(url); return parsed.origin === origin && !parsed.username && !parsed.password; }
    catch { return false; }
  }

  function isMainFrame(wc, frame) {
    try {
      return !wc.isDestroyed() && frame === wc.mainFrame && frame.detached === false
        && nodeId(frame) !== null && frame.parent === null;
    } catch { return false; }
  }

  function isTrustedSender(event) {
    try {
      const wc = getWindow()?.webContents;
      return !disposed && !!wc && states.has(wc) && event?.sender === wc
        && isMainFrame(wc, event.senderFrame) && selfUrl(event.senderFrame.url)
        && event.senderFrame.origin === origin;
    } catch { return false; }
  }

  // Reused for legacy Browser IPC. Its old handlers had no sender-frame guard;
  // do not let an opaque child turn that bridge into network/shell authority.
  const guardHandler = handler => (event, ...args) => isTrustedSender(event)
    ? handler(event, ...args) : fail('untrusted_sender');

  // Three-valued classification: a lost parent/frame is not proof of safety.
  function classifyFrame(state, frame) {
    try {
      const visited = new Set();
      let current = frame;
      for (let depth = 0; current && depth < 128; depth++) {
        const id = nodeId(current);
        if (id === null || visited.has(id)) return 'unknown';
        // Recognizing a name may only RESTRICT access, never grant authority.
        if (state.roots.has(id) || current.name === FRAME_NAME) return 'artifact';
        if (current.detached !== false) return 'unknown';
        visited.add(id);
        const parent = current.parent;
        if (parent === null) {
          if (current !== state.wc.mainFrame) return 'unknown';
          return current === frame ? 'main' : 'child';
        }
        current = parent;
      }
    } catch { /* Disposed RenderFrameHosts can throw on every getter. */ }
    return 'unknown';
  }

  function isArtifactFrame(frame, wc) {
    const state = states.get(wc);
    return !!state && classifyFrame(state, frame) === 'artifact';
  }

  function requestState(details) {
    if (details.webContents) return states.get(details.webContents) || null;
    return [...states.values()].find(state => state.wc.id === details.webContentsId) || null;
  }

  // Only the host/default Session installs this policy. Browser/credential
  // partitions retain their existing independent owners and stricter policies.
  function shouldBlockRequest(details) {
    try {
      const state = requestState(details);
      if (!state || disposed) return true;
      const kind = classifyFrame(state, details.frame);
      if (kind === 'unknown' || kind === 'artifact') return true;
      return details.resourceType === 'mainFrame' && details.initiatorOrigin !== undefined
        && details.initiatorOrigin !== origin;
    } catch { return true; }
  }

  function canAuthenticateRequest(details) {
    try {
      const state = requestState(details);
      if (!state || shouldBlockRequest(details) || !selfUrl(details.url)) return false;
      if (!isMainFrame(state.wc, details.frame) || details.resourceType === 'subFrame') return false;
      if (details.initiatorOrigin !== undefined && details.initiatorOrigin !== origin) return false;
      // Initial BrowserWindow.loadURL has no current URL/initiator yet.
      return (selfUrl(details.frame.url) && details.frame.origin === origin)
        || (details.resourceType === 'mainFrame' && ['', 'about:blank'].includes(details.frame.url)
          && details.initiatorOrigin === undefined);
    } catch { return false; }
  }

  function installRequestGuards(selectedSession, { token, tokenHeader, backendConnected }) {
    if (disposed || requestsInstalled || selectedSession !== guardedSession) throw new Error('artifact_session_unavailable');
    requestsInstalled = true;
    // Electron keeps only the LAST listener per webRequest event. Compose the
    // pre-existing disconnected-backend install gate here, not in a second hook.
    selectedSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      let cancel = shouldBlockRequest(details);
      try {
        const target = new URL(details.url);
        const local = target.origin === origin || target.origin === origin.replace('127.0.0.1', 'localhost');
        if (local && !backendConnected() && details.method === 'POST'
          && ['/api/environment/install', '/api/environment/pi-path'].includes(target.pathname)) cancel = true;
      } catch { cancel = true; }
      callback({ cancel });
    });
    selectedSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
      if (shouldBlockRequest(details)) return callback({ cancel: true });
      const headers = { ...details.requestHeaders };
      // Strip every spelling on EVERY destination, including redirect hops to
      // external origins. Otherwise a trusted fetch's redirect can carry a token.
      for (const key of Object.keys(headers)) if (key.toLowerCase() === tokenHeader.toLowerCase()) delete headers[key];
      if (canAuthenticateRequest(details)) headers[tokenHeader] = token;
      callback({ requestHeaders: headers });
    });
  }

  function pruneRemovedFrames(state, frames) {
    const liveIds = new Set(frames.map(nodeId));
    for (const id of state.roots.keys()) if (!liveIds.has(id)) state.roots.delete(id);
    // A removed frame's ID is never reused. Late requests from detached RFHs
    // still fail classification; a renderer release never revokes a live guard.
  }

  function findFrames(state, host) {
    const main = state.wc.mainFrame;
    const frames = main.framesInSubtree;
    const matches = frames.filter(frame => frame.parent === main
      && (frame.name === FRAME_NAME || state.roots.has(nodeId(frame))));
    if (!host.valid || host.count > MAX_FRAMES) return { error: 'invalid_frame' };
    if (!host.count || matches.length !== host.count) return { missing: true };
    const fresh = [];
    for (const frame of matches) {
      if (frame.detached !== false || nodeId(frame) === null || frame.parent !== main
        || frame.origin !== 'null') return { error: 'invalid_frame' };
      if (state.roots.has(nodeId(frame))) continue;
      if (!['', 'about:blank'].includes(frame.url)) return { error: 'frame_not_blank' };
      fresh.push(frame);
    }
    pruneRemovedFrames(state, frames);
    if (state.roots.size + fresh.length > MAX_FRAMES) return { error: 'frame_limit' };
    return { fresh };
  }

  function validRequest(request) {
    return request && typeof request === 'object' && !Array.isArray(request)
      && Object.keys(request).length === 1 && request.name === FRAME_NAME;
  }

  async function registerFrame(event, request) {
    if (!isTrustedSender(event)) return fail('untrusted_sender');
    if (!validRequest(request)) return fail('invalid_request');
    const state = states.get(event.sender);
    if (!requestsInstalled || guardedSession !== state.wc.session || !safeEnvironment(state.wc, environment)
      || !state.rtcRestricted) return fail('unsafe_environment');
    if (state.pending.size >= MAX_PENDING) return fail('registration_busy');
    return new Promise(resolve => {
      let timer = null, timeout = null, finished = false;
      const deadline = Date.now() + waitMs;
      function finish(result) {
        if (finished) return;
        finished = true; clearTimeout(timer); clearTimeout(timeout); state.pending.delete(cancel); resolve(result);
      }
      const cancel = () => finish(fail('unavailable'));
      state.pending.add(cancel);
      async function attempt() {
        if (finished) return;
        if (!isTrustedSender(event) || states.get(state.wc) !== state) return finish(fail('untrusted_sender'));
        try {
          const host = await event.senderFrame.executeJavaScript(`(${inspectHostFrames.toString()})()`);
          if (finished) return;
          if (!isTrustedSender(event)) return finish(fail('untrusted_sender'));
          const found = findFrames(state, host);
          if (found.error) return finish(fail(found.error));
          if (found.fresh) {
            for (const frame of found.fresh) state.roots.set(nodeId(frame), { initialSrcdoc: true });
            return finish({ ok: true, javascriptEnabled: true });
          }
        } catch { return finish(fail('frame_unavailable')); }
        if (Date.now() >= deadline) return finish(fail('frame_unavailable'));
        timer = setTimeout(attempt, pollMs);
      }
      // A hung executeJavaScript must not leave an unbounded pending promise.
      timeout = setTimeout(cancel, waitMs);
      attempt();
    });
  }

  function releaseFrame(event, request) {
    if (!isTrustedSender(event)) return fail('untrusted_sender');
    if (!validRequest(request)) return fail('invalid_request');
    try { pruneRemovedFrames(states.get(event.sender), event.sender.mainFrame.framesInSubtree); }
    catch { /* Retain all guards when removal cannot be proved. */ }
    return { ok: true };
  }

  function installIpc(nextIpc = ipc) {
    if (disposed || !nextIpc || ipcInstalled) return;
    ipc = nextIpc;
    ipc.handle(CHANNELS.register, registerFrame);
    ipc.handle(CHANNELS.release, releaseFrame);
    ipcInstalled = true;
  }

  function removeIpc() {
    if (!ipcInstalled) return;
    ipc.removeHandler(CHANNELS.register); ipc.removeHandler(CHANNELS.release);
    ipcInstalled = false;
  }

  function shouldBlockNavigation(wc, event, redirect = false) {
    const state = states.get(wc);
    if (!state) return false;
    try {
      if (disposed) return true;
      const target = classifyFrame(state, event.frame);
      const initiator = event.initiator ? classifyFrame(state, event.initiator) : 'unknown';
      if (initiator === 'artifact' || target === 'unknown') return true;
      if (target === 'artifact') {
        const record = state.roots.get(nodeId(event.frame));
        // Only the parent may spend the initial allowance on a cancellable
        // request. Internal commits can spend it without that request event.
        if (!redirect && record?.initialSrcdoc && event.url === 'about:srcdoc'
          && ['', 'about:blank'].includes(event.frame.url) && isMainFrame(wc, event.initiator)) {
          record.initialSrcdoc = false;
          return false;
        }
        return true;
      }
      return initiator === 'unknown';
    } catch { return true; }
  }

  function canOpenExternal(wc, event) {
    return states.has(wc) && !shouldBlockNavigation(wc, event)
      && isMainFrame(wc, event.frame) && isMainFrame(wc, event.initiator);
  }

  function hasLiveArtifacts(state) {
    try { return state.wc.mainFrame.framesInSubtree.some(frame => classifyFrame(state, frame) === 'artifact'); }
    catch { return true; }
  }

  function attachWebContents(wc) {
    if (disposed || states.has(wc)) return;
    const state = { wc, roots: new Map(), pending: new Set(), rtcRestricted: false };
    states.set(wc, state);
    try {
      wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      state.rtcRestricted = wc.getWebRTCIPHandlingPolicy() === 'disable_non_proxied_udp';
    } catch { /* Registration fails closed if this API is absent or fails. */ }
    const navigate = event => { if (shouldBlockNavigation(wc, event)) event.preventDefault(); };
    const redirect = event => { if (shouldBlockNavigation(wc, event, true)) event.preventDefault(); };
    const commit = (_event, url, _code, _status, isMainFrame, processId, routingId) => {
      if (isMainFrame || url !== 'about:srcdoc') return;
      try {
        // The native event supplies routing identity for the committed document.
        // Resolve it to the current native frame node before spending its allowance.
        const frame = wc.mainFrame.frames.find(candidate =>
          candidate.processId === processId && candidate.routingId === routingId);
        if (frame?.url !== url || frame.detached !== false) return;
        const record = state.roots.get(nodeId(frame));
        if (record) record.initialSrcdoc = false;
      } catch { /* Chromium may detach an old frame before it can be inspected. */ }
    };
    wc.on('will-frame-navigate', navigate);
    wc.on('will-redirect', redirect);
    wc.on('did-frame-navigate', commit);
    wc.on('will-attach-webview', event => event.preventDefault());
    // HandlerDetails does not prove the initiating frame. Never translate a
    // child popup into shell.openExternal. Host external links use guarded IPC.
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.once('destroyed', () => {
      for (const cancel of [...state.pending]) cancel();
      states.delete(wc); state.roots.clear();
      wc.removeListener('will-frame-navigate', navigate); wc.removeListener('will-redirect', redirect);
      wc.removeListener('did-frame-navigate', commit);
    });
  }

  function installSessionGuards(selectedSession) {
    if (guardedSession || disposed) throw new Error('artifact_session_already_guarded');
    guardedSession = selectedSession;
    const trustedPermission = (wc, details) => {
      try {
        return !disposed && states.has(wc) && wc === getWindow()?.webContents
          && details?.isMainFrame === true && selfUrl(details.requestingUrl)
          && isMainFrame(wc, wc.mainFrame) && selfUrl(wc.mainFrame.url);
      } catch { return false; }
    };
    selectedSession.setPermissionCheckHandler((wc, _permission, _origin, details) => trustedPermission(wc, details));
    selectedSession.setPermissionRequestHandler((wc, _permission, callback, details) => callback(trustedPermission(wc, details)));
    selectedSession.on('will-download', (event, _item, wc) => {
      const state = states.get(wc);
      // No trustworthy initiating frame is supplied here. Deny this WC's
      // downloads while ANY artifact lives, not only for suspicious blob URLs.
      if (state && hasLiveArtifacts(state)) event.preventDefault();
    });
  }

  function dispose() {
    disposed = true; removeIpc();
    for (const state of states.values()) for (const cancel of [...state.pending]) cancel();
    // Request/navigation/download protection remains until actual destruction.
  }

  return { installIpc, installSessionGuards, installRequestGuards, attachWebContents,
    isTrustedSender, guardHandler, isArtifactFrame, shouldBlockRequest, canAuthenticateRequest,
    shouldBlockNavigation, canOpenExternal, registerFrame, releaseFrame, dispose };
}

module.exports = { createHtmlArtifactSecurity, safeEnvironment, FRAME_NAME, CHANNELS };
