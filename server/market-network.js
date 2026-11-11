/* MCP 市场 ↔ Electron 主进程代理桥（后端侧客户端）。
 *
 * 市场请求由 Node 后端发起，但**系统代理的判定与代理线路的连接只能在
 * Electron 主进程里做**：Node 既读不到 `Session.resolveProxy`，也没有
 * Chromium 的代理栈（PAC / SOCKS5 / TUN 都由它处理）。所以后端通过
 * Electron 已经拉起的私有 IPC 通道询问主进程：
 *
 *   { type:'mcp-market-network', id, action:'resolve-route', url }
 *   { type:'mcp-market-network', id, action:'fetch', url, timeoutMs, maxBytes }
 *
 * 主进程回：
 *   { type:'mcp-market-network-result', id, ok:true, route:'direct'|'proxied'|'unknown' }
 *   { type:'mcp-market-network-result', id, ok:true, status, headers, body }
 *   { type:'mcp-market-network-result', id, ok:false, code:'...' }
 *
 * 边界：
 *   - 这个通道只在后端是 Electron 直属子进程时存在（`process.send`）；
 *     网页版 / SEA 独立运行时返回 null，市场退回「没有可信代理栈」的
 *     fail-closed 行为。
 *   - 请求只带 URL 与上限，不带 method / headers / 代理凭据；主进程只做
 *     GET、固定请求头、`redirect:'manual'`。
 *   - 应答固定字段；代理地址、认证信息、Chromium 原始错误都不经过这里。
 */
import crypto from 'node:crypto';

const REQUEST_TYPE = 'mcp-market-network';
const RESULT_TYPE = 'mcp-market-network-result';
const ROUTE_TIMEOUT_MS = 2_500;

function networkError(code) {
  const err = new Error(code || 'network');
  err.marketCode = code || 'network';
  return err;
}

export function createParentMarketNetwork({
  send = typeof process.send === 'function' ? process.send.bind(process) : null,
  on = typeof process.on === 'function' ? process.on.bind(process) : null,
  off = typeof process.off === 'function' ? process.off.bind(process) : null,
  routeTimeoutMs = ROUTE_TIMEOUT_MS,
} = {}) {
  if (typeof send !== 'function' || typeof on !== 'function') return null;

  const pending = new Map();
  let disposed = false;

  const listener = (message) => {
    if (!message || message.type !== RESULT_TYPE || !Number.isSafeInteger(message.id)) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve(message);
  };
  on('message', listener);

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (typeof off === 'function') off('message', listener);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(networkError('unavailable'));
    }
    pending.clear();
  }

  function request(action, payload, timeoutMs) {
    if (disposed) return Promise.reject(networkError('unavailable'));
    return new Promise((resolve, reject) => {
      const id = crypto.randomInt(1, 0x7fffffff);
      /* 极小概率与在飞请求撞 id；撞了就直接拒绝，不能复用同一个等待槽。 */
      if (pending.has(id)) {
        reject(networkError('busy'));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(networkError('timeout'));
      }, Math.max(1, timeoutMs));
      pending.set(id, { resolve, reject, timer });
      try {
        send({ type: REQUEST_TYPE, id, action, ...payload }, (err) => {
          if (!err) return;
          const entry = pending.get(id);
          if (!entry) return;
          pending.delete(id);
          clearTimeout(entry.timer);
          reject(networkError('unavailable'));
        });
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        reject(networkError('unavailable'));
      }
    });
  }

  return {
    available: true,
    async resolveRoute(url) {
      const result = await request('resolve-route', { url: String(url) }, routeTimeoutMs);
      if (!result || result.ok !== true) throw networkError((result && result.code) || 'unavailable');
      const route = result.route;
      return route === 'direct' || route === 'proxied' ? route : 'unknown';
    },
    async fetchProxied(url, { timeoutMs, maxBytes } = {}) {
      const budget = Number(timeoutMs);
      const message = await request('fetch', {
        url: String(url),
        timeoutMs: Number.isFinite(budget) ? Math.max(1, Math.min(15_000, Math.round(budget))) : 8_000,
        maxBytes: Number.isFinite(Number(maxBytes)) ? Math.max(1, Math.min(2 * 1024 * 1024, Number(maxBytes))) : 2 * 1024 * 1024,
      }, (Number.isFinite(budget) ? Math.max(1, Math.min(15_000, Math.round(budget))) : 8_000) + 1_500);
      if (!message || message.ok !== true) throw networkError((message && message.code) || 'network');
      return {
        ok: true,
        status: message.status,
        headers: message.headers || {},
        body: message.body,
      };
    },
    dispose,
  };
}
