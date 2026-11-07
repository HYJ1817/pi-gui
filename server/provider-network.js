/* 供应商管理 P2：模型发现的受限网络 transport 与授权绑定。
 *
 * 设计边界（provider-management-rebuild-plan.md §5.3，P2 只提供 transport 与
 * 能力接口；/discover、/test 的业务状态机由 P3 接线）：
 *   - 只允许读模型目录的 GET；不发推理消息，不产生付费调用。
 *   - 公共服务必须 HTTPS；URL 禁凭据、query、hash；初版拒绝一切重定向。
 *   - DNS 与实际连接地址绑定：先解析、逐地址校验、再把已校验地址钉进请求，
 *     阻断私网 / 链路本地 / 云元数据 / IPv4 映射 IPv6 绕过。
 *   - localhost 只允许显式授权的 loopback 目标，且必须无秘密（不附带任何 key）。
 *   - 超时、真实 Abort、响应体大小、候选数量与模型数量都有硬上限。
 *   - 错误一律是闭集安全码；原始响应体、异常文本、密钥不出本模块
 *     （错误字符串在出口处做一次无条件哨兵替换，与 models-api.js 同一纪律）。
 *
 * 本模块不知道密钥从哪来：调用方（P3 的 worker 侧编排）负责在私有边界内
 * 解析凭据后传入。本模块只保证 key 不进 URL、日志、错误与返回值。
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { buildCandidates } from '../lib/models-api.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TOTAL_MS = 30_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 3000;
const MAX_CANDIDATES = 8;

/* 闭集错误：只回码与固定文案，绝不携带原始异常。 */
const FAILURES = Object.freeze({
  invalid_target: ['invalid_target', '目标地址不在授权范围内。'],
  policy_rejected: ['policy_rejected', '该目标不允许携带凭据或不在已授权的路径策略内。'],
  loopback_requires_consent: ['loopback_requires_consent', '本机地址只允许显式授权且无秘密的发现。'],
  private_address: ['private_address', '目标解析到内网或保留地址，已拒绝。'],
  dns_failed: ['dns_failed', '目标域名解析失败。'],
  redirect_rejected: ['redirect_rejected', '模型目录请求不允许重定向。'],
  timeout: ['timeout', '模型目录请求超时，已取消。'],
  aborted: ['aborted', '请求已取消。'],
  too_large: ['too_large', '模型目录响应超过大小上限。'],
  not_json: ['not_json', '模型目录返回的不是 JSON。'],
  http_status: ['http_status', '模型目录请求被拒绝。'],
  network_failed: ['network_failed', '模型目录请求失败。'],
});
const fail = (code, status) => ({ ok: false, code: FAILURES[code][0], message: FAILURES[code][1], ...(status ? { status } : {}) });

const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/* ---------- 地址分类 ---------- */

const v4Parts = value => String(value).split('.').map(part => Number(part));
const inCidr4 = (value, prefix, bits) => {
  const parts = v4Parts(value);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const addr = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (addr & mask) === (prefix & mask);
};
const v6Groups = value => String(value).split(':');


/* IPv4 映射地址（::ffff:a.b.c.d）先解包再按 IPv4 分类，防止用 v6 语法绕过私网检查。 */
function unwrapMapped(host) {
  const lower = String(host).toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice(7);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return { host: tail, version: 4 };
  }
  return { host: lower, version: lower.includes(':') ? 6 : 4 };
}

/** 地址归类。返回 'loopback' | 'private' | 'linklocal' | 'unspecified' | 'public' | null(不识别)。 */
export function classifyAddress(address) {
  const { host, version } = unwrapMapped(address);
  if (version === 4) {
    if (inCidr4(host, 0, 8)) return 'unspecified'; // 0.0.0.0/8
    if (inCidr4(host, 0x7F000000, 8)) return 'loopback'; // 127/8
    if (inCidr4(host, 0x0A000000, 8) || inCidr4(host, 0xAC100000, 12) || inCidr4(host, 0xC0A80000, 16)) return 'private';
    if (inCidr4(host, 0xA9FE0000, 16)) return 'linklocal'; // 169.254/16（含云元数据 169.254.169.254）
    if (inCidr4(host, 0x64400000, 10)) return 'private'; // 100.64/10 CGNAT
    return 'public';
  }
  const groups = v6Groups(host).map(group => group === '' ? 0 : Number.parseInt(group, 16) || 0);
  if (groups.every(group => group === 0)) return 'unspecified';
  if (groups.slice(0, -1).every(group => group === 0) && groups.at(-1) === 1) return 'loopback'; // ::1
  if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return 'linklocal';
  if (host.startsWith('fc') || host.startsWith('fd')) return 'private'; // fc00::/7
  if (host.startsWith('::ffff:')) return classifyAddress(host.slice(7));
  return 'public';
}

/* ---------- 目标解析与候选路径 ---------- */

/** 把已验证的 connection 拆成授权目标。URL 已经过 contract.validateConnection，
 * 这里只做进一步收敛并拒绝残留的凭据/query/hash。 */
export function parseTarget(baseUrl) {
  let url;
  try { url = new URL(String(baseUrl ?? '')); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (url.username || url.password || url.search || url.hash || !url.hostname) return null;
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const pathname = url.pathname.endsWith('/') && url.pathname !== '/' ? url.pathname.slice(0, -1) : url.pathname;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return { href: url.href, protocol: url.protocol.slice(0, -1), host, port, basePath: pathname === '/' ? '' : pathname, isLoopbackName: ['localhost'].includes(host) };
}

/** 生成候选路径（复用 lib/models-api.js 的既有归一化），并截断到授权上限。 */
export function planCandidates(connection, api) {
  return buildCandidates(connection.baseUrl, api).slice(0, MAX_CANDIDATES).map(url => new URL(url).href);
}

/** 目标是否允许本次凭据来源。核心策略：
 *  - 公共地址：必须 HTTPS；http 一律拒绝（旧 LAN 配置不自动发现）。
 *  - loopback（名字或解析地址）：必须显式 loopback 授权且无秘密。
 *  - 其他私网 / 链路本地 / 元数据 / 未指定地址：一律拒绝。 */
export function targetPolicy({ target, addressClass, credentialAttached, loopbackAuthorized }) {
  if (!isRecord(target) || typeof addressClass !== 'string') return 'invalid_target';
  if (addressClass === 'loopback' || target.isLoopbackName) {
    return loopbackAuthorized === true && credentialAttached === false ? null : 'loopback_requires_consent';
  }
  if (addressClass !== 'public') return 'private_address';
  if (target.protocol !== 'https') return 'policy_rejected';
  return credentialAttached === true || credentialAttached === false ? null : 'policy_rejected';
}

/* ---------- 受限 transport ---------- */

function pickRequester(protocol) { return protocol === 'https:' ? https.request : http.request; }

/** 单次受限请求。返回 {ok:true, status, body:Buffer} 或 {ok:false, code, message, status?}。
 * - lookup 钉桩：请求只允许使用调用方已校验的地址列表（自定义 lookup 逐个给出）。
 * - 重定向一律拒绝（不跟随、不跨源携带任何头）。
 * - signal 贯穿到 socket destroy；超时同样走 abort。
 * - 响应体边读边计数，超限即断。 */
function restrictedFetch({ url, headers = {}, addresses, timeoutMs, signal, maxBytes = MAX_BYTES, io = {} }) {
  const target = parseTarget(url);
  if (!target || !Array.isArray(addresses) || addresses.length === 0) return Promise.resolve(fail('invalid_target'));
  const controller = new AbortController();
  const abort = reason => { if (!controller.signal.aborted) controller.abort(reason); };
  const onOuterAbort = () => abort('aborted');
  if (signal) {
    if (signal.aborted) return Promise.resolve(fail('aborted'));
    signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => abort('timeout'), timeoutMs);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onInternalAbort);
      signal?.removeEventListener('abort', onOuterAbort);
      resolve(value);
    };
    /* 无论底层实现是否把 abort 转成 error，本 promise 都必须 settle：
     * 真实 http.request 会 emit error，测试桩可能不会。 */
    const onInternalAbort = () => finish(fail(controller.signal.reason === 'timeout' ? 'timeout' : 'aborted'));
    controller.signal.addEventListener('abort', onInternalAbort, { once: true });
    const parsed = new URL(url);
    const options = {
      host: target.host,
      port: target.port,
      path: `${parsed.pathname}${parsed.search || ''}`,
      method: 'GET',
      servername: target.protocol === 'https:' && !/^\d/.test(target.host) && !target.host.includes(':') ? target.host : undefined,
      headers: { accept: 'application/json', connection: 'close', ...headers },
      signal: controller.signal,
      /* DNS 钉桩：不依赖系统解析顺序，只用调用方已校验的地址。 */
      lookup: (hostname, lookupOptions, callback) => {
        const list = addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
        if (lookupOptions?.all) return callback(null, list);
        callback(null, list[0].address, list[0].family);
      },
    };
    const req = (io.requester ?? pickRequester(`${target.protocol}:`))(options);
    let received = 0;
    const chunks = [];
    req.on('error', () => finish(controller.signal.aborted ? fail(controller.signal.reason === 'timeout' ? 'timeout' : 'aborted') : fail('network_failed')));
    req.on('response', res => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return finish(fail('redirect_rejected'));
      }
      const declared = Number(res.headers['content-length'] ?? 0);
      if (declared > maxBytes) { finish(fail('too_large')); res.destroy(); return; }
      res.on('data', chunk => {
        received += chunk.length;
        if (received > maxBytes) { finish(fail('too_large')); res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => finish({ ok: true, status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', () => finish(fail('network_failed')));
    });
    req.end();
  });
}

/** 解析并校验目标的全部地址。任何一段解析到非授权类别即整体拒绝。 */
export function resolveTargetAddresses({ host, lookup = dns.promises.lookup }) {
  return lookup(host, { all: true, verbatim: true }).then(entries => {
    const list = (Array.isArray(entries) ? entries : []).map(entry => entry?.address).filter(address => typeof address === 'string' && address);
    if (!list.length) return { ok: false, ...fail('dns_failed') };
    const classes = list.map(address => classifyAddress(address));
    const loopback = classes.every(classOf => classOf === 'loopback');
    if (!loopback && classes.some(classOf => classOf !== 'public')) return { ok: false, ...fail('private_address') };
    return { ok: true, addresses: list, addressClass: loopback ? 'loopback' : 'public' };
  }).catch(() => ({ ok: false, ...fail('dns_failed') }));
}

/** 解析模型目录响应（复用 models-api 的 pickList/normalize 语义由调用方完成），
 * 这里只做形状与数量护栏。 */
export function pickModelList(json) {
  if (!isRecord(json) && !Array.isArray(json)) return { ok: false, ...fail('not_json') };
  const arr = Array.isArray(json) ? json : Array.isArray(json.models) ? json.models : Array.isArray(json.data) ? json.data : null;
  if (!arr) return { ok: false, ...fail('not_json') };
  return { ok: true, items: arr.slice(0, MAX_MODELS), truncated: arr.length > MAX_MODELS };
}

/** P2 的授权绑定 transport：每个请求必须携带一个未过期 consent，
 * 目标（协议+主机+端口+完整 basePath）与候选路径必须逐字在授权范围内。
 * 密钥只在 headers 组装时短暂出现，错误出口做哨兵替换。 */
export function createDiscoveryTransport({ consentStore, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_BYTES, maxTotalMs = MAX_TOTAL_MS, io = {}, lookup } = {}) {
  return async function discover({ consentId, url, key = null, signal }) {
    /* 过期判定由 consent store 自己的时钟负责（测试注入与生产一致）。 */
    const consent = consentStore.get(consentId);
    if (!consent) return fail('invalid_target');
    let target = parseTarget(url);
    if (!target) return fail('invalid_target');
    if (target.protocol !== consent.target.protocol || target.host !== consent.target.host || target.port !== consent.target.port ||
        !(target.basePath === consent.target.basePath || target.basePath.startsWith(`${consent.target.basePath}/`))) {
      return fail('policy_rejected');
    }
    if (!consent.candidatePaths.includes(url)) return fail('policy_rejected');
    const credentialAttached = typeof key === 'string' && key.length > 0;
    if (credentialAttached && !consent.credentialAttached) return fail('policy_rejected');
    const resolved = await resolveTargetAddresses({ host: target.host, ...(lookup ? { lookup } : {}) });
    if (!resolved.ok) return resolved;
    const policy = targetPolicy({ target: { ...target, protocol: target.protocol }, addressClass: resolved.addressClass,
      credentialAttached, loopbackAuthorized: consent.loopback === true });
    if (policy) return fail(policy);
    const headers = {};
    if (credentialAttached) {
      if (consent.api === 'anthropic-messages') { headers['anthropic-version'] = '2023-06-01'; headers['x-api-key'] = key; }
      else if (consent.api === 'google-generative-ai') headers['x-goog-api-key'] = key;
      else headers.authorization = `Bearer ${key}`;
    }
    const deadline = Date.now() + maxTotalMs;
    let lastStatus = null;
    const attempts = consent.candidatePaths.slice(consent.candidatePaths.indexOf(url));
    for (const candidate of attempts) {
      if (Date.now() > deadline || signal?.aborted) return fail(signal?.aborted ? 'aborted' : 'timeout');
      const result = await restrictedFetch({ url: candidate, headers, addresses: resolved.addresses, timeoutMs, signal, maxBytes, io });
      if (!result.ok) {
        if (['aborted', 'timeout', 'too_large', 'redirect_rejected', 'private_address', 'invalid_target'].includes(result.code)) return result;
        lastStatus = result.status ?? null;
        continue;
      }
      if (result.status === 401 || result.status === 403 || result.status === 429) return fail('http_status', result.status);
      if (result.status < 200 || result.status >= 300) { lastStatus = result.status; continue; }
      let json;
      try { json = JSON.parse(result.body.toString('utf8')); } catch { return fail('not_json'); }
      const picked = pickModelList(json);
      if (!picked.ok) return picked;
      return { ok: true, source: candidate, models: picked.items, truncated: picked.truncated, status: result.status };
    }
    return fail(lastStatus ? 'http_status' : 'network_failed', lastStatus ?? undefined);
  };
}
