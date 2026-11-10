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
import { isIP } from 'node:net';
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
const retryAt = value => {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const now = Date.now();
  const at = /^\d{1,4}$/.test(value) ? now + Number(value) * 1000 :
    /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) ? Date.parse(value) : NaN;
  return at >= now && at <= now + 30 * 60_000 ? at : undefined;
};

/* ---------- 地址分类 ---------- */

const v4Parts = value => String(value).split('.').map(part => Number(part));
const inCidr4 = (value, prefix, bits) => {
  const parts = v4Parts(value);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const addr = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (addr & mask) === (prefix & mask);
};
/** 地址归类。返回 'loopback' | 'private' | 'linklocal' | 'unspecified' | 'public' | null(不识别)。 */
export function classifyAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return null;
  const version = isIP(address);
  if (!version) return null;
  if (version === 4) {
    const host = address;
    if (inCidr4(host, 0, 8)) return 'unspecified'; // 0.0.0.0/8
    if (inCidr4(host, 0x7F000000, 8)) return 'loopback'; // 127/8
    if (inCidr4(host, 0x0A000000, 8) || inCidr4(host, 0xAC100000, 12) || inCidr4(host, 0xC0A80000, 16)) return 'private';
    if (inCidr4(host, 0xA9FE0000, 16)) return 'linklocal'; // 169.254/16（含云元数据 169.254.169.254）
    if (inCidr4(host, 0x64400000, 10)) return 'private'; // 100.64/10 CGNAT
    // 其余 IANA 保留/特殊段（RFC 5737 文档、RFC 7526、RFC 2544 基准、
    // RFC 1112/3188 组播诊断、240/4 未分配、255.255.255.255）不是可达的
    // 模型目录目标；保守按「本地/保留」拒发，防止可路由误判。
    if (inCidr4(host, 0xC0000000, 24) || inCidr4(host, 0xC0000200, 24) ||
        inCidr4(host, 0xC6336400, 24) || inCidr4(host, 0xCB007100, 24) ||
        inCidr4(host, 0xC0586300, 24) || inCidr4(host, 0xC6120000, 15) ||
        inCidr4(host, 0xE0000000, 4) || inCidr4(host, 0xF0000000, 4)) return 'private';
    return 'public';
  }
  // URL 规范化 IPv6 的压缩、大小写和点分写法。映射地址统一按内嵌 IPv4 分类。
  const host = new URL(`http://[${address}]`).hostname.slice(1, -1);
  if (host.startsWith('::ffff:')) {
    const [hi, lo] = host.slice(7).split(':').map(group => Number.parseInt(group, 16));
    return classifyAddress(`${hi >>> 8}.${hi & 0xFF}.${lo >>> 8}.${lo & 0xFF}`);
  }
  if (host === '::') return 'unspecified';
  if (host === '::1') return 'loopback';
  const [first, second] = host.split(':', 2).map(group => Number.parseInt(group || '0', 16));
  if ((first & 0xffc0) === 0xfe80) return 'linklocal'; // fe80::/10
  // 仅接受当前全球单播分配空间 2000::/3，并排除其中的特殊用途前缀。
  // 组播、旧 site-local、NAT64 特殊前缀等均在该空间之外。
  if ((first & 0xe000) !== 0x2000 ||
      (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) || // 2001::/23、2001:db8::/32
      first === 0x2002 || first === 0x3ffe || // 6to4、旧 6bone
      (first === 0x3fff && second < 0x1000)) return 'private'; // 3fff::/20
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

export function planScopedCandidates(connection) {
  const root = parseTarget(connection.baseUrl);
  if (!root || /%(?:2f|5c|2e|25|00)/i.test(root.basePath) || /\/\//.test(root.basePath)) return [];
  return planCandidates(connection, connection.api).filter(candidate => {
    const target = parseTarget(candidate);
    return target && target.protocol === root.protocol && target.host === root.host && target.port === root.port &&
      insideBasePath(target, root);
  });
}

function insideBasePath(target, root) {
  return target.basePath.startsWith(`${root.basePath}/`) && !/%(?:2f|5c|2e|25|00)|\/\//i.test(target.basePath);
}

/** 目标是否允许本次凭据来源。核心策略：
 *  - 公共地址：必须 HTTPS；http 一律拒绝（旧 LAN 配置不自动发现）。
 *  - loopback（名字或解析地址）：必须显式 loopback 授权且无秘密。
 *  - 其他私网 / 链路本地 / 元数据 / 未指定地址：一律拒绝。 */
export function targetPolicy({ target, addressClass, credentialAttached, loopbackAuthorized }) {
  if (!isRecord(target) || typeof addressClass !== 'string') return 'invalid_target';
  if (target.isLoopbackName && addressClass !== 'loopback') return 'private_address';
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
function restrictedFetch({ url, headers = {}, addresses, timeoutMs, signal, maxBytes = MAX_BYTES, io = {}, admit }) {
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
      agent: false, // 独立直连，避免全局代理或已有 socket 绕过本次 lookup 钉桩。
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
    let req;
    let release;
    try {
      release = admit?.();
      if (admit && !release) return finish(fail('aborted'));
      req = (io.requester ?? pickRequester(`${target.protocol}:`))(options);
    }
    catch { return finish(fail('network_failed')); }
    finally { release?.(); }
    let received = 0;
    const chunks = [];
    req.on('error', () => finish(controller.signal.aborted ? fail(controller.signal.reason === 'timeout' ? 'timeout' : 'aborted') : fail('network_failed')));
    req.on('response', res => {
      res.on('error', () => finish(fail('network_failed')));
      if (settled) {
        res.destroy();
        return;
      }
      if (res.statusCode >= 300 && res.statusCode < 400) {
        finish(fail('redirect_rejected', res.statusCode));
        res.destroy();
        return;
      }
      const declared = Number(res.headers['content-length'] ?? 0);
      if (declared > maxBytes) { finish(fail('too_large', res.statusCode)); res.destroy(); return; }
      res.on('data', chunk => {
        if (settled) return;
        received += chunk.length;
        if (received > maxBytes) { finish(fail('too_large', res.statusCode)); res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (!settled) finish({ ok: true, status: res.statusCode, body: Buffer.concat(chunks),
          ...(res.statusCode === 429 ? { retryAt: retryAt(res.headers['retry-after']) } : {}) });
      });
    });
    try { req.end(); }
    catch { finish(fail('network_failed')); }
  });
}

/** 解析并校验目标的全部地址。任何一段解析到非授权类别即整体拒绝。 */
export async function resolveTargetAddresses({ host, lookup = dns.promises.lookup, signal }) {
  const cancelled = Promise.withResolvers();
  const onAbort = () => cancelled.resolve(null);
  try {
    if (signal?.aborted) return fail('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    // Node 对 IP 字面量直接连接，必须校验字面量本身。
    // 域名的系统 lookup 不保证响应 AbortSignal，竞争负责终止等待并消费迟到 rejection。
    const entries = isIP(host) ? [{ address: host }]
      : await Promise.race([lookup(host, { all: true, verbatim: true }, signal), cancelled.promise]);
    if (signal?.aborted) return fail('aborted');
    const list = Array.isArray(entries) ? Array.from(entries, entry => entry?.address) : [];
    if (!list.length) return { ok: false, ...fail('dns_failed') };
    const classes = list.map(address => classifyAddress(address));
    const loopback = classes.every(classOf => classOf === 'loopback');
    if (!loopback && classes.some(classOf => classOf !== 'public')) return { ok: false, ...fail('private_address') };
    return { ok: true, addresses: list, addressClass: loopback ? 'loopback' : 'public' };
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return { ok: false, ...fail('aborted') };
    return { ok: false, ...fail('dns_failed') };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
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
  'supportedGenerationMethods', 'architecture', 'modalities', 'output_modalities', 'output',
  // 显式能力布尔值（部分聚合服务会返回）；只接受 boolean，绝不影响密钥纪律。
  'toolCalling', 'streaming']);

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
  /* 能力证据只从供应商自己声明的字段推导，不按模型名/ID 猜测：
   *   - toolCalling：显式 boolean，或 supported_parameters 包含 tools；
   *   - streaming：只认显式 boolean；
   *   - chatCapable：Google 的 generateContent、显式输出模态含 text、或
   *     参数表声明 tools。缺失一律 null（未知），不是 false。 */
  const parameters = Array.isArray(item.supported_parameters)
    ? item.supported_parameters.filter(value => typeof value === 'string') : null;
  const methods = Array.isArray(item.supportedGenerationMethods)
    ? item.supportedGenerationMethods.filter(value => typeof value === 'string') : null;
  const rawOutputModalities = Array.isArray(item.architecture?.output_modalities) ? item.architecture.output_modalities
    : Array.isArray(item.modalities?.output) ? item.modalities.output : null;
  // 畸形元素/空数组不构成“明确不支持聊天”的证据；只有非空字符串列表才可判定。
  const outputModalities = rawOutputModalities
    ? rawOutputModalities.filter(value => typeof value === 'string') : null;
  const toolCalling = typeof item.toolCalling === 'boolean' ? item.toolCalling
    : parameters?.includes('tools') ? true : null;
  const streaming = typeof item.streaming === 'boolean' ? item.streaming : null;
  let chatCapable = null;
  if (methods) chatCapable = methods.includes('generateContent');
  else if (outputModalities?.length) chatCapable = outputModalities.includes('text');
  else if (parameters?.includes('tools')) chatCapable = true;
  if (toolCalling !== null) out.toolCalling = toolCalling;
  if (streaming !== null) out.streaming = streaming;
  if (chatCapable !== null) out.chatCapable = chatCapable;
  const text = JSON.stringify(out);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0 &&
        (text.includes(secret) || out.id.includes(secret) || (out.name ?? '').includes(secret))) return null;
  }
  return out;
}

/** 解析模型目录响应：形状护栏 + 输出白名单。secrets 传当前使用的密钥值，
 * 出现在 id/name 等字段即整条丢弃（供应商回显请求头是真实发生过的形态）。 */
export function pickModelList(json, secrets = [], api) {
  if (!isRecord(json) && !Array.isArray(json)) return { ok: false, ...fail('not_json') };
  const arr = Array.isArray(json) ? json : Array.isArray(json.models) ? json.models : Array.isArray(json.data) ? json.data : null;
  if (!arr) return { ok: false, ...fail('not_json') };
  const safeSecrets = Array.isArray(secrets) ? secrets.filter(secret => typeof secret === 'string' && secret) : [];
  const cleaned = [];
  const seen = new Set();
  const scanned = arr.slice(0, MAX_MODELS);
  let invalid = 0;
  for (const item of scanned) {
    let entry = item;
    let ignored = false;
    if (api && isRecord(item)) {
      entry = { ...item };
      const scalarMetadata = api === 'anthropic-messages' ? ['type','created_at'] :
        api.startsWith('openai-') ? ['object','created','owned_by'] : ['version','description','temperature','maxTemperature','topP','topK','thinking'];
      for (const field of scalarMetadata) {
        if (!Object.hasOwn(entry, field)) continue;
        const value = entry[field];
        if ((typeof value === 'string' && safeText(value, 2048)) || (typeof value === 'number' && Number.isFinite(value)) ||
            (field === 'thinking' && typeof value === 'boolean')) delete entry[field];
      }
      if (api === 'google-generative-ai') {
        const methods = entry.supportedGenerationMethods;
        if (methods !== undefined && (!Array.isArray(methods) || methods.length > 32 || !methods.every(value => safeText(value, 64)))) {
          invalid++;
          continue;
        }
        ignored = Boolean(methods?.length && !methods.includes('generateContent'));
        if (typeof (entry.name ?? entry.id) === 'string') {
          entry.id = (entry.name ?? entry.id).replace(/^models\//u, '');
          delete entry.name;
        }
      }
    }
    const model = sanitizeModelEntry(entry, safeSecrets);
    if (!model) { invalid++; continue; }
    if (ignored) continue;
    if (model && !seen.has(model.id)) { seen.add(model.id); cleaned.push(model); }
  }
  if (api && !cleaned.length && invalid) return fail('not_json');
  return { ok: true, models: cleaned, truncated: arr.length > MAX_MODELS, dropped: arr.length - cleaned.length };
}

/** P2 的授权绑定 transport：每个请求必须携带一个未过期 consent，
 * 目标（协议+host+port+完整 basePath）与候选路径必须逐字在授权范围内；
 * credentialRevision 传入时必须与 consent 绑定值一致——换成另一把 key
 * （代次变化）后旧授权当场失效，不允许旧授权绑定替换后的密钥。
 * 密钥只在 headers 组装时短暂出现，错误出口做哨兵替换。 */
/** 发包与发布结果前都核对授权、凭据代次与候选路径。 */
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
  if (target.protocol !== consent.target.protocol || target.host !== consent.target.host || target.port !== consent.target.port ||
      (consent.scoped && !insideBasePath(target, consent.target))) {
    return { error: fail('policy_rejected') };
  }
  if (!consent.candidatePaths.includes(url)) return { error: fail('policy_rejected') };
  return { consent, target };
}

export function createDiscoveryTransport({ consentStore, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_BYTES,
  maxTotalMs = MAX_TOTAL_MS, io = {}, lookup, now = () => performance.now() } = {}) {
  return async function discover({ consentId, url, key = null, credentialRevision, signal, deadline: acceptedDeadline, admit }) {
    const deadline = Number.isFinite(acceptedDeadline) ? Math.min(acceptedDeadline, now() + maxTotalMs) : now() + maxTotalMs;
    if (signal?.aborted) return fail('aborted');
    const initial = verifyConsent(consentStore, consentId, url, credentialRevision);
    if (initial.error) return initial.error;
    const { consent, target } = initial;
    const credentialAttached = typeof key === 'string' && key.length > 0;
    if (credentialAttached && !consent.credentialAttached) return fail('policy_rejected');
    if (consent.credentialAttached && !credentialAttached) return fail('policy_rejected');
    const consentSignal = consentStore.signalFor?.(consentId);
    const deadlineController = new AbortController();
    const operationSignal = AbortSignal.any([deadlineController.signal, ...(signal ? [signal] : []),
      ...(consentSignal ? [consentSignal] : [])]);
    const check = candidate => {
      if (signal?.aborted) return fail('aborted');
      if (consentSignal?.aborted) return fail('invalid_target');
      if (deadlineController.signal.aborted || now() >= deadline) return fail('timeout');
      return verifyConsent(consentStore, consentId, candidate, credentialRevision).error ?? null;
    };
    const timer = setTimeout(() => deadlineController.abort(), Math.max(0, Math.ceil(deadline - now())));
    try {
      const stopped = check(url);
      if (stopped) return stopped;
      const resolve = lookup ?? io.lookup ?? dns.promises.lookup;
      const authorizedLookup = admit ? (...args) => {
        const release = admit();
        if (!release) throw new DOMException('Discovery revoked', 'AbortError');
        try { return resolve(...args); } finally { release(); }
      } : resolve;
      const resolved = await resolveTargetAddresses({ host: target.host, lookup: authorizedLookup, signal: operationSignal });
      const afterDns = check(url);
      if (afterDns) return afterDns;
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
      let lastStatus = null;
      const attempts = consent.candidatePaths.slice(consent.candidatePaths.indexOf(url));
      for (const candidate of attempts) {
        const pre = check(candidate);
        if (pre) return pre;
        const remaining = deadline - now();
        if (remaining <= 0) return fail('timeout');
        /* 严格 30s：单次请求的超时截到总时限剩余，不得靠最后一次请求突破总上限。 */
        const attemptTimeout = Math.min(timeoutMs, Math.ceil(remaining));
        const result = await restrictedFetch({ url: candidate, headers, addresses: resolved.addresses,
          timeoutMs: attemptTimeout, signal: operationSignal, maxBytes, io, admit });
        const afterRequest = check(candidate);
        if (afterRequest) return afterRequest;
        if (!result.ok) {
          if (['aborted', 'timeout', 'too_large', 'redirect_rejected', 'private_address', 'invalid_target'].includes(result.code)) return result;
          lastStatus = result.status ?? null;
          continue;
        }
        if (result.status === 401 || result.status === 403 || result.status === 429) {
          return { ...fail('http_status', result.status), ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }) };
        }
        if (result.status < 200 || result.status >= 300) { lastStatus = result.status; continue; }
        let json;
        try { json = JSON.parse(result.body.toString('utf8')); } catch { return check(candidate) ?? fail('not_json', result.status); }
        /* 密钥（以及原始请求头值）传入白名单：出现在任何模型字段里的
         * 哨兵即整条丢弃，供应商回显头不会进普通前端。 */
        const picked = pickModelList(json, [...(credentialAttached ? [key] : []), ...Object.values(headers).filter(header => typeof header === 'string' && header.length > 8)],
          consent.scoped ? consent.api : undefined);
        const beforeReturn = check(candidate);
        if (beforeReturn) return beforeReturn;
        if (!picked.ok) return { ...picked, status: result.status };
        return { ok: true, source: candidate, models: picked.models, truncated: picked.truncated, dropped: picked.dropped, status: result.status };
      }
      return fail(lastStatus ? 'http_status' : 'network_failed', lastStatus ?? undefined);
    } finally {
      clearTimeout(timer);
    }
  };
}
