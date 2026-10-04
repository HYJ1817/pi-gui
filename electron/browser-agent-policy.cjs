'use strict';
const { isSelfEndpoint } = require('./browser-policy.cjs');
function loopback(host) {
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}
function allowedAgentUrl(raw, origin) {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\s\x00-\x1f\x7f]/.test(raw)) return false;
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !loopback(u.hostname)) return false;
    // All 127/8 aliases of the GUI service are excluded too.
    const self = new URL(origin || 'http://localhost:0');
    return !isSelfEndpoint(u, origin) && !(loopback(u.hostname) && (u.port || (u.protocol === 'https:' ? '443' : '80')) === (self.port || (self.protocol === 'https:' ? '443' : '80')));
  } catch { return false; }
}
function safeUrl(raw) {
  try { const u = new URL(raw); return ['http:', 'https:'].includes(u.protocol) ? u.origin + u.pathname : ''; } catch { return ''; }
}
const keyCodes = {Enter:13,Tab:9,Escape:27,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Backspace:8,Delete:46,Home:36,End:35,PageUp:33,PageDown:34};
const KEYS = Object.freeze({ ...Object.fromEntries(Object.entries(keyCodes).map(([key, windowsVirtualKeyCode]) => [key, {key, code:key, windowsVirtualKeyCode}])), 'Ctrl+Enter':{key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:2} });
const ACTIONS = Object.freeze(['open','snapshot','click','fill','press','reload','back','forward','screenshot','console','network','status']);
function validateRequest(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.requestId !== 'string' || !/^[\w.-]{1,100}$/.test(r.requestId)) return 'invalid_request';
  if (!ACTIONS.includes(r.action)) return 'unknown_action';
  const a = r.args ?? {};
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'invalid_arguments';
  const keys = {open:['url'],click:['ref'],fill:['ref','text'],press:['key'],console:['limit'],network:['limit']}[r.action] || [];
  if (Object.keys(a).some(k => !keys.includes(k))) return 'invalid_arguments';
  if (r.action === 'open' && (typeof a.url !== 'string' || a.url.length > 8192)) return 'invalid_arguments';
  if (['click','fill'].includes(r.action) && (typeof a.ref !== 'string' || !/^e\d+$/.test(a.ref))) return 'invalid_arguments';
  if (r.action === 'fill' && (typeof a.text !== 'string' || Buffer.byteLength(a.text) > 32768)) return 'invalid_arguments';
  if (r.action === 'press' && !Object.hasOwn(KEYS, a.key)) return 'invalid_key';
  if (a.limit !== undefined && (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 100)) return 'invalid_arguments';
  return null;
}
module.exports = { allowedAgentUrl, safeUrl, validateRequest, KEYS, ACTIONS };
