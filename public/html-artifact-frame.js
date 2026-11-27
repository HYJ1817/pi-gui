import { HTML_ARTIFACT_THEME_KEYS } from './html-artifact-theme.js';
import { installHtmlArtifactRuntime } from './html-artifact-runtime.js';
import { installHtmlArtifactMeasurement } from './html-artifact-measure.js';
import { installHtmlArtifactScroll } from './html-artifact-scroll.js';

export const HTML_ARTIFACT_FRAME_NAME = 'pi-gui-html-artifact';
export const HTML_ARTIFACT_PROTOCOL_VERSION = 1;
export const HTML_ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'; media-src 'none'; manifest-src 'none'";
export const HTML_ARTIFACT_PERMISSIONS = [
  'accelerometer', 'ambient-light-sensor', 'autoplay', 'battery', 'bluetooth', 'camera',
  'clipboard-read', 'clipboard-write', 'display-capture', 'document-domain',
  'encrypted-media', 'fullscreen', 'gamepad', 'geolocation', 'gyroscope', 'hid',
  'idle-detection', 'local-fonts', 'magnetometer', 'microphone', 'midi', 'otp-credentials',
  'payment', 'picture-in-picture', 'publickey-credentials-create', 'publickey-credentials-get',
  'screen-wake-lock', 'serial', 'speaker-selection', 'storage-access', 'usb',
  'web-share', 'window-management', 'xr-spatial-tracking',
].map(name => `${name} 'none'`).join('; ');

const scriptJson = value => JSON.stringify(value).replace(/</g, '\\u003c')
  .split(String.fromCharCode(0x2028)).join('\\u2028')
  .split(String.fromCharCode(0x2029)).join('\\u2029');

// Runs before any untrusted byte. CSP is first, not retrofitted after parsing.
// The bootstrap has no host capabilities. The nonce prevents cross-frame mixup,
// not forgery by model scripts. The host separately validates/limits every type
// and confirms external actions. Native guards MUST also cover fresh documents.
function frameBootstrap(configuration, installRuntime, installMeasurement, installScroll) {
  'use strict';
  const { id, nonce, hostOrigin, theme, themeKeys, html } = configuration;
  const write = document.write.bind(document);
  const send = parent.postMessage.bind(parent);
  const receive = window.addEventListener.bind(window);
  const apply = snapshot => {
    if (!snapshot || typeof snapshot !== 'object') return;
    const values = snapshot.values;
    if (values && typeof values === 'object') for (const key of themeKeys) {
      if (typeof values[key] === 'string' && values[key].length <= 512) {
        document.documentElement.style.setProperty('--' + key, values[key]);
      }
    }
    if (snapshot.colorScheme === 'dark' || snapshot.colorScheme === 'light') {
      document.documentElement.style.colorScheme = snapshot.colorScheme;
    }
  };
  const disable = (object, name) => {
    try {
      Object.defineProperty(object, name, { value: undefined, configurable: false, writable: false });
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      return descriptor?.value === undefined && descriptor.configurable === false && descriptor.writable === false;
    } catch { return false; }
  };
  let locked = true;
  // WebRTC is not governed by connect-src or webRequest. Lock THIS realm's
  // constructors before model scripts. CSP forbids child/worker requests, but
  // is not proof about initial blank documents; native guards remain required.
  for (const name of [
    'RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel',
    'RTCSessionDescription', 'RTCIceCandidate', 'RTCIceTransport', 'RTCDtlsTransport',
    'RTCSctpTransport', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver',
    'WebTransport', 'WebSocket', 'WebSocketStream', 'EventSource',
    'XMLHttpRequest', 'fetch', 'Worker', 'SharedWorker', 'BroadcastChannel',
  ]) locked = disable(window, name) && locked;
  for (const name of ['sendBeacon', 'registerProtocolHandler', 'unregisterProtocolHandler',
    'getUserMedia', 'webkitGetUserMedia', 'mozGetUserMedia', 'serviceWorker']) locked = disable(navigator, name) && locked;
  // The model document remains an escaped string until every lock is verified.
  // In particular CSP cannot rescue a failed WebRTC lock. Never parse/run the
  // payload on such a platform; the host's ready timeout becomes a closed error.
  if (!locked) return;
  apply(theme); // Set first-paint colors/fonts before the model's styles/content.
  const post = message => send({ schemaVersion: 1, id, nonce, ...message }, hostOrigin);
  const measurement = installMeasurement(window, post);
  const runtime = installRuntime(window);
  if (!runtime || !installScroll(window)) { measurement.dispose(); runtime?.dispose(); return; }
  let hostVisible = true;
  const pausedAnimations = new Set();
  const updateVisibility = () => {
    const visible = hostVisible && !document.hidden;
    if (!visible) for (const animation of document.getAnimations?.() || []) {
      if (pausedAnimations.size < 256 && animation.playState === 'running') {
        animation.pause(); pausedAnimations.add(animation);
      }
    }
    document.documentElement.toggleAttribute('data-pi-artifact-paused', !visible);
    runtime.setVisible(visible); measurement.setVisible(visible);
    if (visible) {
      for (const animation of pausedAnimations) {
        try { if (animation.playState === 'paused') animation.play(); }
        catch { /* an animation's target may have been removed while hidden */ }
      }
      pausedAnimations.clear();
    }
  };
  receive('message', event => {
    if (event.source !== parent || event.origin !== hostOrigin) return;
    const value = event.data;
    if (!value || Array.isArray(value) || value.schemaVersion !== 1
      || value.id !== id || value.nonce !== nonce) return;
    if (value.type === 'theme') { apply(value.theme); measurement.queue(); }
    else if (value.type === 'visibility' && typeof value.visible === 'boolean') {
      hostVisible = value.visible; updateVisibility();
    }
  });
  document.addEventListener('visibilitychange', updateVisibility);
  updateVisibility();
  const dispose = () => { measurement.dispose(); runtime.dispose(); pausedAnimations.clear(); };
  receive('pagehide', dispose, { once: true }); receive('unload', dispose, { once: true });
  const now = performance.now.bind(performance);
  const parseUrl = URL;
  let lastAction = -Infinity;
  const action = message => {
    const time = now();
    if (time - lastAction < 250) return;
    lastAction = time; post(message);
  };
  receive('keydown', event => {
    // This is only a request to close the CURRENT viewer. The nonce is not
    // authentication for model scripts; the host checks/rate-limits it again.
    if (event.isTrusted && event.key === 'Escape') action({ type: 'escape' });
  }, true);
  receive('click', event => {
    const target = event.target?.closest?.('a, img');
    if (!target) return;
    const anchor = target.closest('a');
    if (anchor) {
      const href = anchor.getAttribute('href');
      if (href?.startsWith('#')) return; // local document anchors stay local.
      event.preventDefault();
      if (!event.isTrusted || typeof href !== 'string' || href.length > 2048
          || /[\u0000- \u007f-\u009f]/.test(href)) return;
      try {
        const url = new parseUrl(href); // no relative URLs/baseURI resolution.
        if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) {
          action({ type: 'link', href: url.href });
        }
      } catch { /* not an absolute HTTP(S) link */ }
      return;
    }
    if (!event.isTrusted || target.tagName !== 'IMG') return;
    const src = target.getAttribute('src');
    // Images remain data in both realms. No SVG/HTML/URL/network proxy; the
    // viewer separately checks magic, dimensions and its own interaction gate.
    if (typeof src !== 'string' || src.length > 2 * 1024 * 1024
        || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/i.test(src)) return;
    action({ type: 'image', src, alt: (target.getAttribute('alt') || '').slice(0, 256) });
  }, { capture: true, passive: false });
  // Parse model bytes only inside this already restricted realm, and only once
  // the non-configurable network/RTC locks have all been proved successful.
  write('<style>html,body{margin:0;padding:0;width:100%;min-width:0;min-height:0;height:auto;'
    + 'background:var(--background);color:var(--foreground);'
    + 'font-family:var(--font-sans);font-size:var(--font-size,14px);line-height:1.45;box-sizing:border-box}'
    + 'html{overflow:auto;overscroll-behavior:auto}*,*::before,*::after{box-sizing:inherit}'
    + 'body{display:flow-root;overflow-wrap:anywhere}pre,code{font-family:var(--font-mono)}'
    + 'img,svg,canvas{max-width:100%}:focus-visible{outline:2px solid var(--ring);outline-offset:2px}'
    + 'html[data-pi-artifact-paused] *,html[data-pi-artifact-paused] *::before,html[data-pi-artifact-paused] *::after'
    + '{animation-play-state:paused!important;transition:none!important}</style></head><body>'
    + html + '</body></html>');
}

// Deliberately only concatenate strings. DOMParser/template.innerHTML in the
// host would resolve resources before sandbox/network policy is in force.
export function htmlArtifactDocument(html, { id, nonce, hostOrigin, theme }) {
  const configuration = scriptJson({ id, nonce, hostOrigin, theme, html, themeKeys: HTML_ARTIFACT_THEME_KEYS });
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${HTML_ARTIFACT_CSP}">`
    + `<script>(${frameBootstrap.toString()})(${configuration},${installHtmlArtifactRuntime.toString()},`
    + `${installHtmlArtifactMeasurement.toString()},${installHtmlArtifactScroll.toString()});</script>`;
}
