/* MCP 市场的 Electron 主进程网络桥（纯逻辑，可注入 session 测试）。
 *
 * 为什么需要它：市场请求由后端 Node 进程发起，但系统代理 / PAC / SOCKS5 /
 * TUN fake-IP 的判定与连接只有 Chromium 网络栈知道。后端通过 IPC 把
 * 「这条 URL 会走哪条线路」和「代理线路上的 GET」交给这里；主进程用
 * `Session.resolveProxy` + `Session.fetch` 回答。
 *
 * 安全边界：
 *   - 只接受后端直属子进程发来的帧；不经过 renderer，也不暴露 IPC 给页面。
 *   - 只做 HTTPS:443、无凭据、非本机主机名的 GET；不跟随重定向。
 *   - 不接收调用方给的请求头 / method / 代理凭据；请求头固定。
 *   - 代理线路在真正 fetch 前**再判一次**；线路在两次判定之间变成
 *     direct / unknown 时拒绝（fail closed），不让代理桥变成通用取数器。
 *   - 只回固定字段；代理地址、认证信息、Chromium 原始错误都不出主进程。
 *   - 单次响应与并发都有上限。
 */
'use strict';

const net = require('node:net');
const path = require('node:path');

/* 开发时策略在 ../lib/；打包后 electron/*.cjs 被平铺到 resources/app/，
 * 策略文件也平铺在同一目录（见 scripts/build-app.mjs）。两处都要能 require。 */
function loadPolicy() {
  const candidates = [
    path.join(__dirname, 'market-network-policy.cjs'),
    path.join(__dirname, '..', 'lib', 'market-network-policy.cjs'),
  ];
  for (const candidate of candidates) {
    try { return require(candidate); } catch (err) {
      if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
    }
  }
  throw new Error('market-network-policy.cjs not found next to electron or in lib/');
}
const {
  blockedHostname, classifyAddress, classifyProxyRoute, hostnameOf,
} = loadPolicy();

const RESULT_TYPE = 'mcp-market-network-result';
const MAX_URL_LENGTH = 2048;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 15_000;
const MAX_INFLIGHT = 8;

function parseMarketUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  const host = hostnameOf(u);
  if (blockedHostname(host)) return null;
  /* URL 里的 IP 字面量不是 DNS 结果，不能享受 fake-IP 的路径判断：
   * 它本身就是一个目标地址，只有公网地址可以交给代理。 */
  if (net.isIP(host) && classifyAddress(host) !== 'public') return null;
  return u;
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { marketCode: 'timeout' })), Math.max(1, timeoutMs));
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function responseHeaders(response) {
  const out = {};
  for (const key of ['content-type', 'content-length', 'location']) {
    const value = response.headers.get(key);
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out;
}

function classifyFetchError(err) {
  const text = String((err && (err.message || err.name)) || '').toLowerCase();
  if (text.includes('err_proxy_auth') || text.includes('proxy authentication')) return 'proxy-auth-required';
  if (text.includes('err_proxy_connection_failed')
    || text.includes('err_tunnel_connection_failed')
    || text.includes('err_mandatory_proxy_configuration_failed')
    || text.includes('err_no_supported_proxies')
    || text.includes('err_socks')) return 'proxy-unreachable';
  if (text.includes('err_cert') || text.includes('err_ssl')) return 'tls-failed';
  if (text.includes('err_name_not_resolved') || text.includes('err_name_resolution')) return 'dns-failed';
  if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) return 'timeout';
  return 'network';
}

async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    throw Object.assign(new Error('too large'), { marketCode: 'too-large' });
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw Object.assign(new Error('too large'), { marketCode: 'too-large' });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw Object.assign(new Error('too large'), { marketCode: 'too-large' });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

/**
 * @param {object} options
 * @param {Electron.Session} options.session 承载 resolveProxy 与 fetch 的同一个 session
 * @param {(event:string, details?:object)=>void} [options.log] 只记动作 / 结果，不记 URL
 */
function createMarketNetworkBridge({ session, log = () => {} } = {}) {
  if (!session || typeof session.resolveProxy !== 'function' || typeof session.fetch !== 'function') {
    throw new Error('market network bridge requires an Electron session with resolveProxy and fetch');
  }
  const inflight = new Set();
  let disposed = false;

  async function resolveRoute(u, timeoutMs) {
    try {
      const raw = await withTimeout(session.resolveProxy(u.toString()), timeoutMs);
      return classifyProxyRoute(raw);
    } catch {
      return 'unknown';
    }
  }

  async function fetchOnce(u, { timeoutMs, maxBytes }) {
    if (inflight.size >= MAX_INFLIGHT) {
      return { ok: false, code: 'busy' };
    }
    const controller = new AbortController();
    inflight.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      /* 线路在真正发请求前再判一次。返回 DIRECT / unknown 说明这个 URL
       * 不会再由代理承载；调用方应按直连固定 IP 处理，而不是借用代理桥。 */
      const route = await resolveRoute(u, Math.min(2_000, timeoutMs));
      if (route !== 'proxied') return { ok: false, code: 'blocked-route' };
      const response = await session.fetch(u.toString(), {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          'user-agent': 'pi-gui-mcp-market/1',
        },
        signal: controller.signal,
      });
      if (response.status === 407) return { ok: false, code: 'proxy-auth-required' };
      const body = await readBoundedBody(response, maxBytes);
      return {
        ok: true,
        status: response.status,
        headers: responseHeaders(response),
        body,
      };
    } catch (err) {
      if (err && err.marketCode === 'too-large') return { ok: false, code: 'too-large' };
      return { ok: false, code: classifyFetchError(err) };
    } finally {
      clearTimeout(timer);
      inflight.delete(controller);
    }
  }

  async function handle(message) {
    if (disposed) {
      return {
        type: RESULT_TYPE,
        id: message && Number.isSafeInteger(message.id) ? message.id : 0,
        ok: false,
        code: 'unavailable',
      };
    }
    if (!message || message.type !== 'mcp-market-network' || !Number.isSafeInteger(message.id)) return null;
    const id = message.id;
    const action = message.action;
    if (action !== 'resolve-route' && action !== 'fetch') {
      return { type: RESULT_TYPE, id, ok: false, code: 'bad-action' };
    }
    const u = parseMarketUrl(message.url);
    if (!u) {
      log('market_network_blocked', { action, reason: 'url' });
      return { type: RESULT_TYPE, id, ok: false, code: 'blocked-url' };
    }
    if (action === 'resolve-route') {
      const route = await resolveRoute(u, 2_500);
      log('market_network_route', { route });
      return { type: RESULT_TYPE, id, ok: true, route };
    }
    const timeoutMs = Number.isFinite(Number(message.timeoutMs))
      ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.round(Number(message.timeoutMs))))
      : 8_000;
    const maxBytes = Number.isFinite(Number(message.maxBytes))
      ? Math.max(1, Math.min(MAX_BYTES, Math.round(Number(message.maxBytes))))
      : MAX_BYTES;
    const result = await fetchOnce(u, { timeoutMs, maxBytes });
    log('market_network_fetch', { outcome: result.ok ? 'ok' : result.code });
    return { type: RESULT_TYPE, id, ...result };
  }

  function dispose() {
    disposed = true;
    for (const controller of inflight) {
      try { controller.abort(); } catch { /* ignore */ }
    }
    inflight.clear();
  }

  return { handle, dispose };
}

module.exports = {
  createMarketNetworkBridge,
  parseMarketUrl,
  classifyFetchError,
  readBoundedBody,
};
