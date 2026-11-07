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
    // 其余 IANA 保留/特殊段（RFC 5737 文档、RFC 7526、RFC 2544 基准、
    // RFC 1112/3188 组播诊断、240/4 未分配、255.255.255.255）不是可达的
    // 模型目录目标；保守按「本地/保留」拒发，防止可路由误判。
    if (inCidr4(host, 0xC0000000, 24) || inCidr4(host, 0xC0000200, 24) ||
        inCidr4(host, 0xC6336400, 26) || inCidr4(host, 0xCB007100, 24) ||
        inCidr4(host, 0xC0586300, 24) || inCidr4(host, 0xC6120000, 15) ||
        inCidr4(host, 0xE0000000, 4) || inCidr4(host, 0xF0000000, 5) ||
        host === '255.255.255.255') return 'private';
    return 'public';
  }
  /* IPv4 映射地址的十六进制写法（::ffff:7f00:1 等）：先还原为点分 IPv4
   * 再按 IPv4 语义分类——不能留给 v6 分支当普通公网 v6 处理。 */
  if (host.startsWith('::ffff:')) {
    const tail = host.slice(7);
    const hex = /^([0-9a-f]{1,4})(?::([0-9a-f]{0,4}))?$/.exec(tail);
    if (hex) {
      // 完整形（两组各 4 位）或双组写法：高 16 位 = a.b 段，低 16 位 = c.d 段。
      const hi = Number.parseInt(hex[1], 16);
      const lo = hex[2] ? Number.parseInt(hex[2], 16) : null;
      if (lo !== null) {
        const dotted = `${hi >>> 8}.${hi & 0xFF}.${lo >>> 8}.${lo & 0xFF}`;
        return classifyAddress(dotted);
      }
      // 单组写法（::ffff:7f00:1 → 组内含 '.' 会被当点分；纯 hex 单组如
      // ::ffff:a9fe 在严格 RFC 形态里不完整，按不可识别拒绝。
      return null;
    }
    return classifyAddress(tail); // 点分形式或未识别形态
  }
  const groups = v6Groups(host).map(group => group === '' ? 0 : Number.parseInt(group, 16) || 0);
  if (groups.every(group => group === 0)) return 'unspecified';
  if (groups.slice(0, -1).every(group => group === 0) && groups.at(-1) === 1) return 'loopback'; // ::1
  if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return 'linklocal';
  if (host.startsWith('fc') || host.startsWith('fd')) return 'private'; // fc00::/7
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
export function resolveTargetAddresses({ host, lookup = dns.promises.lookup, signal }) {
  if (signal?.aborted) return Promise.resolve({ ok: false, ...fail('aborted') });
  const lookupSignal = signal;
  return Promise.resolve(lookup(host, { all: true, verbatim: true }, lookupSignal)).then(entries => {
    signal?.throwIfAborted?.();
    const list = (Array.isArray(entries) ? entries : []).map(entry => entry?.address).filter(address => typeof address === 'string' && address);
    if (!list.length) return { ok: false, ...fail('dns_failed') };
    const classes = list.map(address => classifyAddress(address));
    const loopback = classes.every(classOf => classOf === 'loopback');
    if (!loopback && classes.some(classOf => classOf !== 'public')) return { ok: false, ...fail('private_address') };
    return { ok: true, addresses: list, addressClass: loopback ? 'loopback' : 'public' };
  }).catch(error => {
    /* 外部/超时 abort 转成 aborted；其余解析失败仍是 dns_failed。 */
    if (signal?.aborted || error?.name === 'AbortError') return { ok: false, ...fail('aborted') };
    return { ok: false, ...fail('dns_failed') };
  });
}

/* 模型目录的输出白名单。供应商返回的原始条目可能有 apiKey/headers/token、
 * 异常类型、超长回显（例如把请求头回显进模型名）；这些一律不进入普通前端。
 * 有效字段与 lib/models-api.js 的归一化目标保持一致（id/name/contextWindow/
 * maxTokens/reasoning/input/capabilities 只留 provider-metadata 三值）。 */
const safeText = (value, max) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
const positiveCount = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isSafeInteger(Math.round(value)) ? Math.round(value) : undefined);

/* 供应商条目允许出现的键。任何白名单之外的键（apiKey/headers/token/任意
 * 嵌套对象）都让整条被丢弃——不是静默删字段，而是整条不可信。 */
const ENTRY_FIELDS = new Set(['id', 'name', 'displayName', 'display_name', 'label',
  'context_length', 'context_window', 'inputTokenLimit', 'max_tokens', 'max_completion_tokens',
  'outputTokenLimit', 'reasoning', 'input', 'top_provider', 'limit', 'supported_parameters',
  'supportedGenerationMethods', 'architecture', 'modalities']);

/** 单条模型 → 白名单投影。返回 null 表示条目被丢弃（不能映射为有效模型）。 */
export function sanitizeModelEntry(item, secrets = []) {
  if (typeof item === 'string') {
    // 字符串条目与对象条目同一密钥纪律：供应商把密钥整条回显成模型 ID
    // 时同样不进普通前端。
    const cleanId = safeText(item.trim(), 300);
    if (!cleanId) return null;
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret.length > 0 && cleanId.includes(secret)) return null;
    }
    return { id: cleanId };
  }
  if (!isRecord(item)) return null;
  // 未知键直接整条丢弃：嵌入的凭据/任意对象不再有输出路径，也不留下
  // 「投影函数漏了一个字段」的隐患。
  for (const field of Object.keys(item)) {
    if (!ENTRY_FIELDS.has(field)) return null;
    if (field === 'top_provider' || field === 'limit' || field === 'architecture' || field === 'modalities') {
      if (!isRecord(item[field])) return null;
      for (const sub of Object.keys(item[field])) {
        if (!ENTRY_FIELDS.has(sub)) return null;
      }
    }
  }
  const id = safeText(item.id ?? item.name, 300);
  if (!id) return null;
  const out = { id };
  const label = safeText(item.displayName ?? item.display_name ?? item.name ?? item.label, 200);
  if (label && label !== out.id) out.name = label;
  const contextWindow = positiveCount(item.context_length ?? item.top_provider?.context_length ?? item.limit?.context ?? item.inputTokenLimit ?? item.context_window);
  if (contextWindow) out.contextWindow = contextWindow;
  const maxTokens = positiveCount(item.top_provider?.max_completion_tokens ?? item.max_completion_tokens ?? item.max_tokens ?? item.limit?.output ?? item.outputTokenLimit);
  if (maxTokens) out.maxTokens = maxTokens;
  if (typeof item.reasoning === 'boolean') out.reasoning = item.reasoning;
  if (Array.isArray(item.input) && item.input.length && item.input.every(x => x === 'text' || x === 'image')) {
    if (item.input.includes('image')) out.input = [...item.input];
  }
  const text = JSON.stringify(out);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0 &&
        (text.includes(secret) || out.id.includes(secret) || (out.name ?? '').includes(secret))) return null;
  }
  return out;
}

/** 解析模型目录响应：形状护栏 + 输出白名单。secrets 传当前使用的密钥值，
 * 出现在 id/name 等字段即整条丢弃（供应商回显请求头是真实发生过的形态）。 */
export function pickModelList(json, secrets = []) {
  if (!isRecord(json) && !Array.isArray(json)) return { ok: false, ...fail('not_json') };
  const arr = Array.isArray(json) ? json : Array.isArray(json.models) ? json.models : Array.isArray(json.data) ? json.data : null;
  if (!arr) return { ok: false, ...fail('not_json') };
  const safeSecrets = Array.isArray(secrets) ? secrets.filter(secret => typeof secret === 'string' && secret) : [];
  const cleaned = [];
  const seen = new Set();
  const scanned = arr.slice(0, MAX_MODELS);
  for (const item of scanned) {
    const model = sanitizeModelEntry(item, safeSecrets);
    if (model && !seen.has(model.id)) { seen.add(model.id); cleaned.push(model); }
  }
  return { ok: true, models: cleaned, truncated: arr.length > MAX_MODELS, dropped: arr.length - cleaned.length };
}

/** P2 的授权绑定 transport：每个请求必须携带一个未过期 consent，
 * 目标（协议+host+port+完整 basePath）与候选路径必须逐字在授权范围内；
 * credentialRevision 传入时必须与 consent 绑定值一致——换成另一把 key
 * （代次变化）后旧授权当场失效，不允许旧授权绑定替换后的密钥。
 * 密钥只在 headers 组装时短暂出现，错误出口做哨兵替换。 */
/** startInfo 返回包内复用的校验产物；verifyConsent 每次发包前重查
 * （授权撤销/过期/目标变化立即生效，响应不再适用旧授权）。 */
function verifyConsent(consentStore, consentId, url, credentialRevision) {
  /* 过期判定由 consent store 自己的时钟负责（测试注入与生产一致）。 */
  const consent = consentStore.get(consentId);
  if (!consent) return { error: fail('invalid_target') };
  if (consent.credentialAttached) {
    /* FIX-03：需要凭据的授权必须核准凭据代次——缺失/不匹配一律拒绝，
     * 不允许旧 consent 绑定替换后的新 key。 */
    if (typeof credentialRevision !== 'string') return { error: fail('policy_rejected') };
    if (consent.credentialRevision !== credentialRevision) return { error: fail('policy_rejected') };
  } else if (credentialRevision !== undefined && credentialRevision !== null) {
    // 无凭据授权保持独立语义：PI_GUI none 源不收代次。
    return { error: fail('policy_rejected') };
  }
  const target = parseTarget(url);
  if (!target) return { error: fail('invalid_target') };
  /* 目标身份（协议/host/port/basePath 根）必须与授权一致，防止把 A 目标的
   * consent 用到 B 目标；具体路径的合法性由授权的候选路径集合决定——
   * planCandidates 的逐级回退路径（如 /models）在签发时已整组批准。 */
  if (target.protocol !== consent.target.protocol || target.host !== consent.target.host || target.port !== consent.target.port) {
    return { error: fail('policy_rejected') };
  }
  if (!consent.candidatePaths.includes(url)) return { error: fail('policy_rejected') };
  return { consent, target };
}

export function createDiscoveryTransport({ consentStore, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_BYTES, maxTotalMs = MAX_TOTAL_MS, io = {}, lookup } = {}) {
  return async function discover({ consentId, url, key = null, credentialRevision, signal }) {
    /* 总时限从发现操作开始计算（FIX-06）：DNS 解析与请求同池。 */
    const deadline = Date.now() + maxTotalMs;
    const abortIf = () => {
      if (signal?.aborted) return fail('aborted');
      if (Date.now() >= deadline) return fail('timeout');
      return null;
    };
    const initial = verifyConsent(consentStore, consentId, url, credentialRevision);
    if (initial.error) return initial.error;
    const { consent, target } = initial;
    const credentialAttached = typeof key === 'string' && key.length > 0;
    if (credentialAttached && !consent.credentialAttached) return fail('policy_rejected');
    if (consent.credentialAttached && !credentialAttached) return fail('policy_rejected');
    /* FIX-02：外部 abort 必须能中止解析与之后的任何网络动作；
     * 超时同样作用于 DNS。 */
    const dnsDeadline = Math.min(deadline, Date.now() + maxTotalMs);
    const dnsController = new AbortController();
    const onOuterAbort = () => dnsController.abort();
    if (signal) {
      if (signal.aborted) return fail('aborted');
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const dnsTimer = setTimeout(() => dnsController.abort(), Math.max(0, dnsDeadline - Date.now()));
    let resolved;
    try {
      resolved = await resolveTargetAddresses({ host: target.host,
        ...(lookup ? { lookup } : { ...(io.lookup ? { lookup: io.lookup } : {}) }),
        signal: dnsController.signal });
    } finally {
      clearTimeout(dnsTimer);
      signal?.removeEventListener('abort', onOuterAbort);
      if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    if (!resolved.ok) return signal?.aborted ? fail('aborted') : resolved;
    /* DNS 期间授权可能被撤销/过期/目标变化：发包前重查。 */
    const afterDns = verifyConsent(consentStore, consentId, url, credentialRevision);
    if (afterDns.error) return afterDns.error;
    const policy = targetPolicy({ target: { ...target, protocol: target.protocol }, addressClass: resolved.addressClass,
      credentialAttached, loopbackAuthorized: consent.loopback === true });
    if (policy) return fail(policy);
    const headers = {};
    if (credentialAttached) {
      if (consent.api === 'anthropic-messages') { headers['anthropic-version'] = '2023-06-01'; headers['x-api-key'] = key; }
      else if (consent.api === 'google-generative-ai') headers['x-goog-api-key'] = key;
      else headers.authorization = `Bearer ${key}`;
    }
    let lastStatus = null;
    const attempts = consent.candidatePaths.slice(consent.candidatePaths.indexOf(url));
    for (const candidate of attempts) {
      /* 每个候选请求前都重新验证授权与 abort/时限（FIX-02：撤销即时生效）。 */
      const aborted = abortIf();
      if (aborted) return aborted;
      const pre = verifyConsent(consentStore, consentId, candidate, credentialRevision);
      if (pre.error) return pre.error;
      const remaining = deadline - Date.now();
      /* 严格 30s：单次请求的超时截到总时限剩余，不得靠最后一次请求突破总上限。 */
      const attemptTimeout = Math.min(timeoutMs, remaining);
      const result = await restrictedFetch({ url: candidate, headers, addresses: resolved.addresses, timeoutMs: attemptTimeout, signal, maxBytes, io });
      if (!result.ok) {
        if (['aborted', 'timeout', 'too_large', 'redirect_rejected', 'private_address', 'invalid_target'].includes(result.code)) return result;
        lastStatus = result.status ?? null;
        continue;
      }
      if (result.status === 401 || result.status === 403 || result.status === 429) return fail('http_status', result.status);
      if (result.status < 200 || result.status >= 300) { lastStatus = result.status; continue; }
      let json;
      try { json = JSON.parse(result.body.toString('utf8')); } catch { return fail('not_json'); }
      /* 密钥（以及原始请求头值）传入白名单：出现在任何模型字段里的
       * 哨兵即整条丢弃，供应商回显头不会进普通前端。 */
      const picked = pickModelList(json, [...(credentialAttached ? [key] : []), ...Object.values(headers).filter(header => typeof header === 'string' && header.length > 8)]);
      if (!picked.ok) return picked;
      return { ok: true, source: candidate, models: picked.models, truncated: picked.truncated, dropped: picked.dropped, status: result.status };
    }
    return fail(lastStatus ? 'http_status' : 'network_failed', lastStatus ?? undefined);
  };
}
