/* 技能市场的网络读取：只做 HTTPS GET、只连固定的几个主机、不跟随重定向、
 * 有超时与大小上限，返回原始字节。
 *
 * 线路与地址的判定**逐条照搬 MCP 市场已有的那一套**（server/mcp-market.js 的
 * checkMarketUrl / inspectMarketTarget / resolveMarketRoute / fetchJson）：
 *   - 先判线路：NO_PROXY 命中 → 直连；有代理意图就必须由 Electron 主进程的代理桥确认
 *     是「代理」线路，确认不了（unknown / unsupported）一律拒绝，绝不悄悄退回直连；
 *   - 直连时先解析域名、逐个校验解析结果是公网地址，然后把连接**固定**到校验过的 IP
 *     （域名只用于 TLS SNI 与证书校验），所以不存在「查一次、连的时候再查一次」的窗口；
 *   - 代理线路上本地解析结果仍要过同一套地址类别判定，fake-IP 只在允许的线路上放行。
 * 地址类别与代理列表的判定本身不在这里，用的是 lib/market-network-policy.cjs 那一份。
 *
 * 为什么不直接调用 MCP 市场的实现：那些函数没有导出，而本阶段不改 MCP 模块；
 * 它也只返回 JSON，技能包里的脚本、图片需要字节。两份流程的等价性由
 * tests/skills-market.cjs 里的对照组断言守着（同一组输入，两边结论必须一致）。
 *
 * 比 MCP 市场更窄的地方：主机是写死的白名单，调用方传不进别的主机。 */
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import {
  blockedHostname, classifyAddress, hostnameOf, isAcceptableResolvedAddress, isFakeIpAddress,
} from '../lib/market-network-policy.cjs';
import { hasSystemProxyCapability } from './system-network-agent.js';

/** 技能市场会连接的全部主机。界面在用户点「加载目录」之前把这份名单原样列给他看。 */
export const MARKET_HOSTS = Object.freeze(['api.github.com', 'cdn.jsdelivr.net', 'data.jsdelivr.com', 'raw.githubusercontent.com']);

const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'];
const MAX_PINNED_ADDRESSES = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const USER_AGENT = 'pi-gui-skills-market/1';

const netError = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });
const coded = (code, message) => Object.assign(new Error(message), { marketCode: code });

/** 只做 URL 语法边界：HTTPS、443、无凭据、主机在白名单里。 */
export function checkMarketUrl(rawUrl, allowedHosts = MARKET_HOSTS) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return netError('blocked-url', 'URL 不是合法地址');
  }
  if (u.protocol !== 'https:') return netError('blocked-url', '技能市场只允许 HTTPS');
  if (u.username || u.password) return netError('blocked-url', 'URL 不能包含用户名或密码');
  if (u.port && u.port !== '443') return netError('blocked-url', '技能市场只允许 443 端口');
  const hostname = hostnameOf(u);
  if (blockedHostname(hostname)) return netError('blocked-host', '不允许访问本机或内网主机');
  if (!allowedHosts.includes(hostname)) return netError('blocked-host', '技能市场只连接固定的几个主机，这个地址不在其中');
  return { ok: true, url: u, hostname };
}

/**
 * 把目标收敛成一组已经校验过的 IP。直连时真正的连接随后只允许连到这里的地址。
 * 与 MCP 市场的 inspectMarketTarget 同语义。
 */
export async function inspectMarketTarget(parsed, {
  route = 'direct', allowFakeIp = false, allowProxiedFakeIp = true, lookupImpl = dns.promises.lookup,
} = {}) {
  const hostname = hostnameOf(parsed);
  const addresses = [];
  let fakeIp = false;
  if (net.isIP(hostname)) {
    if (isFakeIpAddress(hostname)) return netError('proxy-blocked', '地址落在代理的 fake-IP 网段（198.18.0.0/15），无法确认实际连接目标，已拒绝。');
    if (classifyAddress(hostname) !== 'public') return netError('blocked-host', '不允许访问本机或内网地址');
    addresses.push({ address: hostname, family: net.isIP(hostname) });
  } else {
    let rows;
    try {
      rows = await lookupImpl(hostname, { all: true, verbatim: true });
    } catch {
      return netError('dns-failed', `无法解析 ${hostname}`);
    }
    const list = Array.isArray(rows) ? rows : [rows];
    if (!list.length) return netError('dns-failed', `${hostname} 没有解析结果`);
    for (const row of list) {
      const address = String((row && row.address) || '');
      const family = net.isIP(address);
      const kind = family ? classifyAddress(address) : 'invalid';
      if (kind === 'benchmark') fakeIp = true;
      if ((kind === 'benchmark' && !allowProxiedFakeIp) || !isAcceptableResolvedAddress(kind, route, { allowFakeIp })) {
        if (kind === 'benchmark') {
          return netError(
            'proxy-blocked',
            `${hostname} 解析到了代理的 fake-IP 网段（198.18.0.0/15），但当前无法确认 TUN / 代理线路，已拒绝请求。请在桌面版中启用系统代理，或改用直连 DNS 后重试。`,
          );
        }
        return netError('blocked-host', `${hostname} 解析到了本机或内网地址，已拒绝`);
      }
      addresses.push({ address, family: row.family === 4 || row.family === 6 ? row.family : family });
    }
  }
  if (!addresses.length) return netError('dns-failed', `${hostname} 没有解析结果`);
  return { ok: true, url: parsed, hostname, fakeIp, addresses: addresses.slice(0, MAX_PINNED_ADDRESSES) };
}

function noProxyMatches(host, port, raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    if (entry === '*') return true;
    let entryHost = entry;
    let entryPort = '';
    const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    if (bracket) {
      entryHost = bracket[1];
      entryPort = bracket[2] || '';
    } else {
      const plain = /^([^:]+)(?::(\d+))?$/.exec(entry);
      if (plain) {
        entryHost = plain[1];
        entryPort = plain[2] || '';
      }
    }
    if (entryPort && entryPort !== String(port || '443')) continue;
    entryHost = entryHost.replace(/^\*?\./, '').toLowerCase();
    if (!entryHost) continue;
    if (h === entryHost || h.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

const proxyEnvKeys = (env) => PROXY_ENV_KEYS.filter((key) => typeof env[key] === 'string' && env[key].trim());

const usableBridge = (network) => Boolean(network && typeof network.resolveRoute === 'function' && typeof network.fetchProxied === 'function');

/**
 * 这条 URL 会走哪条线路：direct / proxied / unknown / unsupported。
 * 与 MCP 市场的 resolveMarketRoute 同语义；unknown 与 unsupported 都必须在发起
 * DNS 或 HTTP 之前拒绝，不能当成 direct。
 */
export async function resolveMarketRoute(parsed, { network = null, env = process.env } = {}) {
  const host = hostnameOf(parsed);
  const port = parsed.port || '443';
  const safeEnv = env || {};
  if (noProxyMatches(host, port, safeEnv.NO_PROXY || safeEnv.no_proxy)) return { route: 'direct', source: 'no-proxy' };
  const bridge = usableBridge(network) ? network : null;
  // 主进程自己的兼容网关不算第二个「用户代理意图」
  const internal = Boolean(bridge && safeEnv.PI_GUI_DESKTOP === '1' && hasSystemProxyCapability(safeEnv));
  const envKeys = proxyEnvKeys(safeEnv).filter((key) => !internal || safeEnv[key] !== safeEnv.PI_GUI_SYSTEM_PROXY);
  if (!bridge) {
    if (network) {
      return {
        route: 'unsupported',
        source: envKeys.length ? 'env-proxy' : 'system-proxy',
        reason: 'bridge-incomplete',
        ...(envKeys.length ? { proxyKey: envKeys[0] } : {}),
      };
    }
    if (envKeys.length) return { route: 'unsupported', source: 'env-proxy', proxyKey: envKeys[0] };
    return { route: 'direct', source: 'no-proxy-stack' };
  }

  let route = 'unknown';
  let reason = '';
  try {
    route = await bridge.resolveRoute(parsed.toString());
  } catch {
    route = 'unknown';
    reason = 'resolve-failed';
  }
  if (route !== 'direct' && route !== 'proxied') {
    route = 'unknown';
    reason = reason || 'invalid-route';
  }
  if (envKeys.length) {
    if (route === 'proxied') return { route, source: 'system-proxy', proxyKey: envKeys[0] };
    return {
      route: 'unknown',
      source: 'env-proxy',
      reason: route === 'direct' ? 'env-proxy-bypassed' : 'env-proxy-route-unknown',
      proxyKey: envKeys[0],
    };
  }
  return { route, source: 'system-proxy', ...(reason ? { reason } : {}) };
}

function pinnedLookupFor(address, family) {
  const fam = family === 4 || family === 6 ? family : net.isIPv6(address) ? 6 : 4;
  return (hostname, options, callback) => {
    if (options && options.all) return callback(null, [{ address, family: fam }]);
    return callback(null, address, fam);
  };
}

/** 真实连接参数：hostname 保持原域名（SNI / 证书校验），lookup 只回已校验的 IP。 */
export function pinnedRequestOptions(url, address, family, headers = {}) {
  const hostname = hostnameOf(url);
  const options = {
    method: 'GET',
    protocol: 'https:',
    hostname,
    port: url.port ? Number(url.port) : 443,
    path: `${url.pathname || '/'}${url.search || ''}`,
    headers: { ...headers, host: url.host },
    // 每个请求单独建连，不复用别的请求留下的连接
    agent: false,
    rejectUnauthorized: true,
    lookup: pinnedLookupFor(address, family),
  };
  if (!net.isIP(hostname)) options.servername = hostname;
  return options;
}

/**
 * 一次 HTTPS GET：不跟随重定向、整体超时、响应体上限，连接固定到已校验的 IP。
 * 非 2xx 不读 body。成功返回 { status, body:Buffer|null }；失败抛带 marketCode 的错误。
 */
export function httpsGetPinned(rawUrl, { address, family, timeoutMs, maxBytes, headers = {} } = {}) {
  const u = new URL(rawUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const failWith = (err) => finish(reject, err);
    let req;
    try {
      req = https.request(pinnedRequestOptions(u, address, family, headers), (res) => {
        const status = Number(res.statusCode) || 0;
        if (status < 200 || status >= 300) {
          res.resume();
          finish(resolve, { status, body: null });
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          failWith(coded('too-large', '远端响应超过大小上限'));
          return;
        }
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            req.destroy();
            failWith(coded('too-large', '远端响应超过大小上限'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('aborted', () => failWith(coded('network', '响应被中断')));
        res.on('error', failWith);
        res.on('end', () => finish(resolve, { status, body: Buffer.concat(chunks) }));
      });
    } catch (err) {
      failWith(err);
      return;
    }
    timer = setTimeout(() => req.destroy(coded('timeout', '响应超时')), Math.max(1, timeoutMs));
    req.on('error', failWith);
    req.end();
  });
}

const PROXY_FAILURES = {
  'too-large': '远端响应超过大小上限',
  timeout: '经系统代理访问时超时',
  'proxy-auth-required': '系统代理要求认证或认证失败。Pi GUI 不接收代理凭据，请在操作系统或代理工具中完成认证后重试。',
  'proxy-unreachable': '无法连接系统代理，请确认代理正在运行，或把目标域名加入 NO_PROXY 后重试。',
  'tls-failed': 'HTTPS 证书校验失败，已拒绝连接。',
  'dns-failed': '代理侧无法解析目标域名。',
  busy: '网络通道正忙，请稍后重试。',
};

/** 代理线路的失败收口：固定文案 + 稳定 code，不回显代理地址、认证信息或原始错误。 */
function proxyFailure(err) {
  const code = err && err.marketCode;
  if (code === 'blocked-route') return netError('proxy-blocked', '系统代理线路在请求前发生了变化，无法确认实际连接路径，已拒绝请求。');
  if (PROXY_FAILURES[code]) return netError(code, PROXY_FAILURES[code]);
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return netError('timeout', PROXY_FAILURES.timeout);
  return netError('network', '无法通过系统代理连接。');
}

/**
 * @param network      Electron 主进程代理桥（server/market-network.js 的 createParentMarketNetwork()）；网页版为 null
 * @param env          环境变量（读代理意图与桌面端策略）
 * @param requestImpl  直连取数实现，测试注入
 * @param lookupImpl   DNS 解析实现，测试注入
 */
export function createSkillsMarketNetwork({
  network = null, env = process.env, requestImpl = httpsGetPinned, lookupImpl = dns.promises.lookup, allowedHosts = MARKET_HOSTS,
} = {}) {
  /**
   * 取一个 URL 的字节。永不抛：{ ok:true, bytes, status, route } 或 { ok:false, code, error, status? }。
   */
  async function fetchBytes(rawUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, accept = '*/*' } = {}) {
    const checked = checkMarketUrl(rawUrl, allowedHosts);
    if (!checked.ok) return checked;
    const parsed = checked.url;
    const routeInfo = await resolveMarketRoute(parsed, { network, env });
    if (routeInfo.route === 'unsupported') {
      const detected = routeInfo.proxyKey ? `检测到代理环境变量 ${routeInfo.proxyKey}。` : '';
      const why = routeInfo.reason === 'bridge-incomplete' ? '代理网络桥能力不完整。' : '当前运行方式没有可信的代理网络栈。';
      return netError('proxy-unsupported', `${detected}${why}不能确认实际连接地址，也不会绕过代理直连。请在桌面版中通过系统代理访问，或把目标域名加入 NO_PROXY 后重试。`);
    }
    if (routeInfo.route === 'unknown') {
      const envConflict = routeInfo.reason === 'env-proxy-bypassed' || routeInfo.reason === 'env-proxy-route-unknown';
      return netError(
        'proxy-blocked',
        envConflict
          ? `检测到代理环境变量 ${routeInfo.proxyKey}，但系统代理线路为${routeInfo.reason === 'env-proxy-bypassed' ? '直连' : '未知'}，不能确认请求会走代理，已拒绝。请关闭环境变量代理，或让系统代理使用同一代理后重试。`
          : '无法确认系统代理线路（解析超时、异常或结果非法）。为避免绕过代理，请求已拒绝，也不会退回直连。',
      );
    }
    const safeEnv = env || {};
    const desktopPolicy = safeEnv.PI_GUI_DESKTOP === '1' && ['0', '1'].includes(safeEnv.PI_GUI_NETWORK_RELAXED);
    const fakeIpAllowed = desktopPolicy ? safeEnv.PI_GUI_NETWORK_RELAXED === '1' && routeInfo.route === 'proxied' : usableBridge(network);
    const safe = await inspectMarketTarget(parsed, {
      route: routeInfo.route,
      allowFakeIp: fakeIpAllowed,
      allowProxiedFakeIp: !desktopPolicy || fakeIpAllowed,
      lookupImpl,
    });
    if (!safe.ok) return safe;

    const deadline = Date.now() + timeoutMs;
    const headers = { accept, 'user-agent': USER_AGENT };
    let status = 0;
    let body = null;
    if (routeInfo.route === 'proxied') {
      try {
        /* 代理桥是 MCP 市场已有的那一条（electron/market-network.cjs），原样使用、没有为技能市场改它：
         *   - 它不接收调用方的请求头，自己带固定的 accept / user-agent（这四个主机都不挑）；
         *   - 单次响应上限 2 MB、超时上限 15 秒，这里传更大的值也会被它压回去；
         *   - 响应体当 UTF-8 文本传回来：文本原样可逆，二进制会失真 —— 由调用方的完整性校验发现。 */
        const raw = await network.fetchProxied(parsed.toString(), { timeoutMs: Math.max(1, deadline - Date.now()), maxBytes });
        if (!raw || raw.ok !== true) throw coded((raw && raw.code) || 'network', 'bridge failed');
        status = Number(raw.status) || 0;
        body = typeof raw.body === 'string' ? Buffer.from(raw.body, 'utf8') : Buffer.alloc(0);
        if (body.length > maxBytes) return netError('too-large', PROXY_FAILURES['too-large']);
      } catch (err) {
        return proxyFailure(err);
      }
    } else {
      let lastError = null;
      let sawTimeout = false;
      let answered = false;
      for (const target of safe.addresses) {
        try {
          const response = await requestImpl(safe.url.toString(), {
            hostname: safe.hostname,
            address: target.address,
            family: target.family,
            timeoutMs: Math.max(1, deadline - Date.now()),
            maxBytes,
            headers,
          });
          status = Number(response && response.status) || 0;
          body = response && Buffer.isBuffer(response.body) ? response.body : null;
          answered = true;
          break;
        } catch (err) {
          if (err && err.marketCode === 'too-large') return netError('too-large', '远端响应超过大小上限');
          if (err && (err.marketCode === 'timeout' || err.name === 'TimeoutError' || err.name === 'AbortError')) sawTimeout = true;
          lastError = err;
          if (Date.now() >= deadline) break;
        }
      }
      if (!answered) {
        if (sawTimeout) return netError('timeout', `连接 ${safe.hostname} 超时`);
        // 只带错误码，不带原始报错正文
        const errno = lastError && typeof lastError.code === 'string' ? `（${lastError.code}）` : '';
        return netError('network', `无法连接 ${safe.hostname}${errno}`);
      }
    }
    if (status >= 300 && status < 400) return netError('redirect-blocked', `${safe.hostname} 返回了重定向。为防绕过地址校验，已拒绝跟随。`, { status });
    if (routeInfo.route === 'proxied' && status === 407) return netError('proxy-auth-required', PROXY_FAILURES['proxy-auth-required'], { status });
    if (status < 200 || status >= 300) return netError(`http-${status || 0}`, `${safe.hostname} 返回 HTTP ${status || '未知'}`, { status });
    return { ok: true, bytes: body || Buffer.alloc(0), status, route: routeInfo.route };
  }

  return { fetchBytes, hosts: allowedHosts };
}
