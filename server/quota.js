/* 供应商远端额度与配额适配器（Remote Quota）。
 *
 * 职责：
 *   - 针对有官方标准 balance/quota 接口的 Provider 进行按需拉取；
 *   - 当前经过核实的适配器只有三个：OpenRouter / DeepSeek / NewAPI
 *     （NewAPI 还必须显式配 quotaAdapter="newapi" 并提供 quotaUserId）；
 *   - 其它 Provider（OpenAI / Anthropic / Google / Sub2API 等）严格返回 unsupported，
 *     不猜、不抓网页、不调用 Management-only 接口；
 *   - 凭据只在后端解析使用：**绝不**回传前端，也绝不进 cache key 原文；
 *   - TTL 缓存与去重按「配置身份」隔离，配置一变就是另一条身份。
 */
import { createHash } from 'node:crypto';
import { resolveApiKey } from '../lib/models-api.js';
import { json } from './http-utils.js';

const TIMEOUT_MS = 10_000;
const DEFAULT_TTL_MS = 60_000;
/** 统一的安全错误：内部异常原因留在后端，不返回给 renderer。 */
const SAFE_ERROR = '额度查询失败';

/** 脱敏文本里的密钥 */
export function scrubSecret(text, secret) {
  if (!text) return '';
  const s = String(text);
  if (!secret || typeof secret !== 'string') return s;
  return s.split(secret).join('***');
}

export function scrubQuotaSecret(value, secret) {
  if (typeof value === 'string') return secret ? value.split(secret).join('***') : value;
  if (Array.isArray(value)) return value.map(item => scrubQuotaSecret(item, secret));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubQuotaSecret(item, secret)]));
  return value;
}

/** 规范化数值：只有有限数字才返回，否则 null。**0 是真实 0，不是缺失。** */
export function cleanNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 移除结尾的斜杠 */
function trimSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/** 规范化 endpoint：保留 origin + pathname，去掉 query / fragment 与尾部斜杠。
 *  `https://example.com/api-a/` 与 `https://example.com/api-a` 是同一个 endpoint。 */
function normalizeEndpoint(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.origin.toLowerCase()}${path}`;
  } catch {
    return raw.replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * adapter 维度的 **endpoint identity**。
 *
 *  - OpenRouter / DeepSeek：请求打的是固定 canonical endpoint（自定义 host 时压根不会
 *    选中这两个 adapter），所以用常量 —— baseUrl 带不带路径都不影响身份。
 *  - NewAPI：请求 URL 是 `{baseUrl}/dashboard/billing/...`，**path 必须进身份**：
 *    `https://example.com/api-a` 与 `https://example.com/api-b` 是两个不同的部署，
 *    各自的 /dashboard/billing/* 不同，绝不能共享缓存。
 *  - 其它：没有 endpoint（unsupported 不发任何请求）。
 */
function endpointIdentity(adapter, config) {
  if (adapter === 'openrouter') return 'https://openrouter.ai/api/v1/key';
  if (adapter === 'deepseek') return 'https://api.deepseek.com/user/balance';
  if (adapter === 'newapi') return normalizeEndpoint(config?.baseUrl);
  return '';
}

/** 时间戳：只有真的能解析成日期才认（"monthly" 这类周期标签不是时间戳）。 */
function timestampOrNull(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/* ---------- OpenRouter ---------- */

/** OpenRouter 额度：GET https://openrouter.ai/api/v1/key（当前 key 自己的 limit/usage）。 */
async function fetchOpenRouterQuota({ apiKey, fetchFn, now, timeoutMs = 10_000 }) {
  const endpoint = 'https://openrouter.ai/api/v1/key';
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  let keyRes = null;
  try {
    const pKey = await fetchFn(endpoint, { headers, signal: ctl.signal });
    keyRes = { status: pKey.status, ok: pKey.ok, json: await pKey.json().catch(() => null) };
  } catch (e) {
    keyRes = { error: e };
  } finally {
    clearTimeout(timer);
  }

  if (keyRes?.error) {
    const isTimeout = keyRes.error.name === 'AbortError';
    return {
      status: 'unavailable',
      balance: null,
      balances: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: endpoint,
      updatedAt: new Date(now()).toISOString(),
      message: isTimeout ? 'OpenRouter 额度查询超时' : '无法连接到 OpenRouter 服务',
    };
  }

  if (keyRes.status === 401 || keyRes.status === 403) {
    return {
      status: 'auth_error',
      balance: null,
      balances: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: endpoint,
      updatedAt: new Date(now()).toISOString(),
      message: 'API Key 无效或未授权',
    };
  }

  if (!keyRes.ok) {
    return {
      status: 'unavailable',
      balance: null,
      balances: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: endpoint,
      updatedAt: new Date(now()).toISOString(),
      message: `OpenRouter 服务返回 HTTP ${keyRes.status}`,
    };
  }

  const d = keyRes.json?.data;
  if (!d || typeof d !== 'object') {
    return {
      status: 'error',
      balance: null,
      balances: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: endpoint,
      updatedAt: new Date(now()).toISOString(),
      message: 'OpenRouter 返回的数据格式不符合预期',
    };
  }

  const limitRemaining = cleanNumber(d.limit_remaining);
  const limit = cleanNumber(d.limit);
  const usage = cleanNumber(d.usage);

  let balanceAmount = null;
  if (limitRemaining !== null) {
    balanceAmount = limitRemaining;
  }

  let windows = null;
  if (limit !== null || usage !== null) {
    windows = { used: usage, limit, remaining: limitRemaining, unit: 'USD' };
  }

  let rateLimit = null;
  if (d.rate_limit && typeof d.rate_limit === 'object') {
    rateLimit = {
      requests: cleanNumber(d.rate_limit.requests),
      interval: typeof d.rate_limit.interval === 'string' ? d.rate_limit.interval : null,
    };
  }

  /* resetAt 只表示「额度/限额的重置时间戳」。
   * OpenRouter 的 `limit_reset` 是 daily / weekly / monthly 这类**周期标签**，
   * `expires_at` 是**这把 API Key 自己的失效时间** —— 两者都不是额度重置时间戳，
   * 所以：能解析成日期的 limit_reset 才收；expires_at 一律不映射（本阶段不扩模型）。 */
  const resetAt = timestampOrNull(d.limit_reset);

  return {
    status: 'ok',
    kind: 'key-quota',
    balance: balanceAmount !== null ? {
      amount: balanceAmount,
      currency: 'USD',
      granted: null,
      toppedUp: null,
    } : null,
    balances: null,
    windows,
    rateLimit,
    resetAt,
    source: endpoint,
    updatedAt: new Date(now()).toISOString(),
    message: null,
  };
}

/* ---------- DeepSeek ---------- */

/** DeepSeek 额度：GET https://api.deepseek.com/user/balance，balance_infos 可含多币种。 */
async function fetchDeepSeekQuota({ apiKey, fetchFn, now, timeoutMs = 10_000 }) {
  const endpoint = 'https://api.deepseek.com/user/balance';
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  let res = null;
  try {
    const r = await fetchFn(endpoint, { headers, signal: ctl.signal });
    res = { status: r.status, ok: r.ok, json: await r.json().catch(() => null) };
  } catch (err) {
    const isTimeout = err?.name === 'AbortError';
    return {
      status: 'unavailable',
      balance: null,
      balances: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: endpoint,
      updatedAt: new Date(now()).toISOString(),
      message: isTimeout ? 'DeepSeek 额度查询超时' : '无法连接到 DeepSeek 余额服务',
    };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return {
      status: 'auth_error',
      balance: null,
      balances: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: endpoint,
      updatedAt: new Date(now()).toISOString(),
      message: 'API Key 无效或未授权',
    };
  }

  if (!res.ok) {
    return {
      status: 'unavailable',
      balance: null,
      balances: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: endpoint,
      updatedAt: new Date(now()).toISOString(),
      message: `DeepSeek 服务返回 HTTP ${res.status}`,
    };
  }

  const jsonVal = res.json;
  if (!jsonVal || typeof jsonVal !== 'object' || (jsonVal.is_available !== false && !Array.isArray(jsonVal.balance_infos))) {
    return {
      status: 'error',
      balance: null,
      balances: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: endpoint,
      updatedAt: new Date(now()).toISOString(),
      message: 'DeepSeek 返回的数据格式不符合预期',
    };
  }

  if (jsonVal.is_available === false && (!Array.isArray(jsonVal.balance_infos) || !jsonVal.balance_infos.length)) {
    return {
      status: 'unavailable',
      balance: null,
      balances: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: endpoint,
      updatedAt: new Date(now()).toISOString(),
      message: 'DeepSeek 账户余额不可用',
    };
  }

  /* 多币种：**不相加**。每种币种各自是一条余额，界面逐条展示。 */
  const balances = [];
  if (Array.isArray(jsonVal.balance_infos)) {
    for (const info of jsonVal.balance_infos) {
      if (!info || typeof info !== 'object') continue;
      balances.push({
        amount: cleanNumber(info.total_balance),
        currency: typeof info.currency === 'string' && info.currency ? info.currency : 'CNY',
        granted: cleanNumber(info.granted_balance),
        toppedUp: cleanNumber(info.topped_up_balance),
      });
    }
  }

  /* primary 策略：优先 CNY（DeepSeek 主币种），否则第一条。只是「默认展示哪条」，
   * 不影响 balances 的完整性。 */
  const cny = balances.find((b) => b.currency === 'CNY');
  const primary = cny || balances[0] || null;

  return {
    status: jsonVal.is_available === false ? 'unavailable' : 'ok',
    balance: primary,
    balances: balances.length > 0 ? balances : null,
    windows: null,
    rateLimit: null,
    resetAt: null,
    source: endpoint,
    updatedAt: new Date(now()).toISOString(),
    message: jsonVal.is_available === false ? 'DeepSeek 账户处于不可用状态' : null,
  };
}

/* ---------- NewAPI ---------- */

/** NewAPI：仅当显式 quotaAdapter="newapi" 时启用。
 *  两个 endpoint：/dashboard/billing/subscription（hard_limit_usd）与
 *  /dashboard/billing/usage（total_usage，单位是美分）。
 *
 *  鉴权：当前 NewAPI 的 dashboard 接口走 `middleware.TokenAuth()` ——
 *  `Authorization: Bearer <API key>` 就能解析出 user context，
 *  **不要求** `New-Api-User`，也**不要求**配置 quotaUserId。
 *  `quotaUserId` 只为旧部署兼容：配了才额外带上这个头，没配照常查询。 */
async function fetchNewApiQuota({ baseUrl, apiKey, config, fetchFn, now }) {
  const base = trimSlash(baseUrl);
  const subUrl = `${base}/dashboard/billing/subscription`;
  const usageUrl = `${base}/dashboard/billing/usage`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
  /* 可选兼容头：只在配置里确实给了 quotaUserId 时才发。 */
  if (config && config.quotaUserId) headers['New-Api-User'] = String(config.quotaUserId);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  let subRes = null;
  let usageRes = null;
  try {
    const pSub = fetchFn(subUrl, { headers, signal: ctl.signal })
      .then(async (r) => ({ status: r.status, ok: r.ok, json: await r.json().catch(() => null) }))
      .catch((e) => ({ error: e }));

    const pUsage = fetchFn(usageUrl, { headers, signal: ctl.signal })
      .then(async (r) => ({ status: r.status, ok: r.ok, json: await r.json().catch(() => null) }))
      .catch(() => null);

    [subRes, usageRes] = await Promise.all([pSub, pUsage]);
  } finally {
    clearTimeout(timer);
  }

  if (subRes?.error) {
    const isTimeout = subRes.error.name === 'AbortError';
    return {
      status: 'unavailable',
      balance: null,
      balances: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: subUrl,
      updatedAt: new Date(now()).toISOString(),
      message: isTimeout ? 'NewAPI 额度查询超时' : '无法连接到 NewAPI 余额服务',
    };
  }

  if (subRes.status === 401 || subRes.status === 403) {
    return {
      status: 'auth_error',
      balance: null,
      balances: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: subUrl,
      updatedAt: new Date(now()).toISOString(),
      message: 'API Key 无效或未授权',
    };
  }

  if (!subRes.ok) {
    return {
      status: 'unavailable',
      balance: null,
      balances: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: subUrl,
      updatedAt: new Date(now()).toISOString(),
      message: `NewAPI 服务返回 HTTP ${subRes.status}`,
    };
  }

  const jsonVal = subRes.json;
  if (!jsonVal || typeof jsonVal !== 'object') {
    return {
      status: 'error',
      balance: null,
      balances: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: subUrl,
      updatedAt: new Date(now()).toISOString(),
      message: 'NewAPI 返回的数据格式不符合预期',
    };
  }

  const hardLimit = cleanNumber(jsonVal.hard_limit_usd);

  let totalUsageCents = null;
  if (usageRes?.ok && usageRes.json && typeof usageRes.json.total_usage !== 'undefined') {
    totalUsageCents = cleanNumber(usageRes.json.total_usage);
  }

  /* ⚠️ 单位语义：这里的字段名是历史命名（`hard_limit_usd` / `total_usage`），
   * **但数值不保证是美元**。NewAPI 的 GetSubscription / GetUsage 会按站点的
   * `quota_display_type`（至少 USD / CNY / TOKENS / CUSTOM）把数值换算成**站点展示单位**；
   * GetUsage 最后统一 `TotalUsage = amount * 100`，所以 `total_usage / 100` 还原的是
   * 「站点展示数值」，**不是「美元」**。
   *
   * 这两个 billing endpoint 自身不带可靠的单位元数据 —— 没有证据就不标 USD/CNY。
   * 因此 balance.currency 与 windows.unit 都返回 null（generic numeric quota），
   * 由界面按「无单位纯数值」展示；不猜、不做跨单位转换或相加。
   * （本轮刻意**不**引入第三个请求去读 /api/status 的 quota_display_type：
   *  那会扩大收口范围，且自托管站点的 base path / CUSTOM 符号/汇率各有边界。） */
  const used = totalUsageCents !== null ? totalUsageCents / 100 : null;
  let remaining = null;
  if (hardLimit !== null && used !== null) {
    remaining = Math.max(0, hardLimit - used);
  }

  const amount = remaining !== null ? remaining : null;

  return {
    status: 'ok',
    balance: amount !== null ? {
      amount,
      currency: null,
      granted: null,
      toppedUp: null,
    } : null,
    balances: null,
    windows: {
      used,
      limit: hardLimit,
      remaining,
      unit: null,
    },
    rateLimit: null,
    resetAt: null,
    source: subUrl,
    updatedAt: new Date(now()).toISOString(),
    message: null,
  };
}

/**
 * 探测该 provider 是否有对应的远端额度 adapter。
 * 返回 adapter 名（'openrouter' / 'deepseek' / 'newapi'）或 null。
 *
 * 官方托管商的 host 必须完全匹配：配了自定义 baseUrl 指向别处时不再当作官方接口。
 */
export function resolveQuotaAdapter(providerId, config) {
  const pid = String(providerId || '').toLowerCase();
  const base = String(config?.baseUrl || '').toLowerCase();

  let urlObj = null;
  if (base) {
    try {
      urlObj = new URL(base);
    } catch (e) {
      /* 解析失败则保留 null */
    }
  }

  const isOfficialHost = (host) => {
    return urlObj && urlObj.hostname === host && (urlObj.port === '' || urlObj.port === '443' || urlObj.port === '80');
  };

  if (pid === 'openrouter') {
    if (base && !isOfficialHost('openrouter.ai')) return null;
    return 'openrouter';
  }
  if (isOfficialHost('openrouter.ai')) return 'openrouter';

  if (pid === 'deepseek') {
    if (base && !isOfficialHost('api.deepseek.com')) return null;
    return 'deepseek';
  }
  if (isOfficialHost('api.deepseek.com')) return 'deepseek';

  if (config?.quotaAdapter === 'newapi') return 'newapi';

  return null;
}

/* Fixed worker code, serialized from the SAME adapters used for custom config.
 * A bundled/SEA backend has no source-file URL to import inside an eval worker. */
export function nativeQuotaWorkerSource() {
  // Explicit aliases survive esbuild renaming top-level function bindings.
  return [cleanNumber, timestampOrNull, scrubQuotaSecret, fetchOpenRouterQuota, fetchDeepSeekQuota, resolveQuotaAdapter].map(fn => fn.toString()).join('\n')
    + `\nconst nativeAdapters={openrouter:${fetchOpenRouterQuota.name},deepseek:${fetchDeepSeekQuota.name},resolve:${resolveQuotaAdapter.name},scrub:${scrubQuotaSecret.name}};`;
}

export function quotaFacts(quota, credentialAvailable = null) {
  return {
    providerExists: true,
    quotaSupported: quota.status !== 'unsupported',
    credentialAvailable,
    quotaQuerySucceeded: quota.status === 'ok',
  };
}

/**
 * 组装 Quota 管理器。
 *
 * @param readModelsConfig 读取 ~/.pi/agent/models.json 的函数
 * @param fetchFn          HTTP fetch 函数，支持注入以做纯离线测试
 * @param now              当前时间戳提供函数
 * @param ttlMs            缓存有效期（毫秒）
 */
export function createQuotaManager({
  readModelsConfig,
  fetchFn = fetch,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  nativeAdapter = null,
}) {
  const cache = new Map();
  const inFlight = new Map();

  async function fetchQuotaDirect(providerId, config) {
    const adapter = resolveQuotaAdapter(providerId, config);
    if (!adapter) {
      return {
        providerId,
        status: 'unsupported',
        balance: null,
        balances: null,
        windows: null,
        rateLimit: null,
        resetAt: null,
        source: 'none',
        updatedAt: new Date(now()).toISOString(),
        message: '该供应商当前没有已验证的远端额度接口',
      };
    }

    const keyRes = resolveApiKey(config?.apiKey);
    if (keyRes.error) {
      return {
        providerId,
        status: 'auth_error',
        balance: null,
        balances: null,
        windows: null,
        rateLimit: null,
        resetAt: null,
        source: 'config',
        updatedAt: new Date(now()).toISOString(),
        message: scrubSecret(keyRes.error, keyRes.value),
      };
    }
    if (!keyRes.value) {
      return {
        providerId,
        status: 'auth_error',
        balance: null,
        balances: null,
        windows: null,
        rateLimit: null,
        resetAt: null,
        source: 'config',
        updatedAt: new Date(now()).toISOString(),
        message: '未配置 API Key',
      };
    }

    const apiKey = keyRes.value;
    let res;
    if (adapter === 'openrouter') {
      res = await fetchOpenRouterQuota({ apiKey, fetchFn, now });
    } else if (adapter === 'deepseek') {
      res = await fetchDeepSeekQuota({ apiKey, fetchFn, now });
    } else if (adapter === 'newapi') {
      res = await fetchNewApiQuota({ baseUrl: config.baseUrl, apiKey, config, fetchFn, now });
    } else {
      res = {
        status: 'unsupported',
        balance: null,
        balances: null,
        windows: null,
        rateLimit: null,
        resetAt: null,
        source: 'none',
        updatedAt: new Date(now()).toISOString(),
        message: '该供应商当前没有已验证的远端额度接口',
      };
    }

    return { providerId, ...scrubQuotaSecret(res, apiKey) };
  }

  /**
   * 配置身份：缓存与去重都按它隔离。
   *
   * 必须包含（少一个就会出现「配置变了还命中旧缓存」）：
   *   providerId、**解析后的 adapter**、**adapter 维度的 endpoint identity**、
   *   以及**已解析凭据的 SHA-256 指纹**。
   *
   *   `quotaUserId` 只在**真的会改变请求**时才进身份（newapi 且配置了它 → 会发
   *   New-Api-User 头）；一个完全不参与请求的字段不该让缓存无意义地 miss。
   *
   * ⚠️ 指纹只进这个哈希的输入，哈希只当 Map key：
   *     API key 原文不进 Map key、不进日志、不进 HTTP 响应、不进诊断。
   *     `$ENV_VAR` 写法尤其要注意 —— 原文不变而环境变量变了，身份也必须变。
   */
  function identityOf(providerId, config) {
    const adapter = resolveQuotaAdapter(providerId, config) || 'unsupported';
    const keyRes = resolveApiKey(config?.apiKey);
    const credential = keyRes.value ? hashOf(keyRes.value) : '';
    const compatUser = adapter === 'newapi' && config?.quotaUserId ? String(config.quotaUserId) : '';
    return hashOf([
      String(providerId || ''),
      adapter,
      endpointIdentity(adapter, config),
      credential,
      compatUser,
    ].join('|'));
  }

  async function getQuota(providerId, { force = false } = {}) {
    const cfgAll = readModelsConfig() || {};
    const config = cfgAll.providers?.[providerId];
    if (!config) {
      if (nativeAdapter?.quota) return nativeAdapter.quota(providerId, { force, ttlMs });
      return { ok: false, error: `供应商 ${providerId} 不存在`, quota: null, providerExists: false, quotaSupported: false, credentialAvailable: null, quotaQuerySucceeded: false };
    }

    const configKey = identityOf(providerId, config);

    const t = now();
    const hit = cache.get(configKey);
    if (!force && hit && t - hit.cachedAt < ttlMs) {
      return { ok: true, quota: hit.quota, cached: true, ...quotaFacts(hit.quota, hit.quota.credentialAvailable) };
    }

    if (inFlight.has(configKey)) {
      const q = await inFlight.get(configKey);
      return { ok: true, quota: q, cached: false, ...quotaFacts(q, q.credentialAvailable) };
    }

    const p = fetchQuotaDirect(providerId, config)
      .then((q) => {
        const key = resolveApiKey(config?.apiKey);
        Object.assign(q, quotaFacts(q, Boolean(!key.error && key.value)));
        cache.set(configKey, { providerId, quota: q, cachedAt: now() });
        return q;
      })
      .finally(() => {
        inFlight.delete(configKey);
      });

    inFlight.set(configKey, p);
    const quota = await p;
    return { ok: true, quota, cached: false, ...quotaFacts(quota, quota.credentialAvailable) };
  }

  /** 清缓存：给了 providerId 就只清它的（缓存按身份哈希存，所以按 providerId 过滤）。 */
  function clearCache(providerId = null) {
    if (!providerId) {
      cache.clear();
      nativeAdapter?.clearQuotaCache?.();
      return;
    }
    for (const [key, entry] of [...cache]) {
      if (entry?.providerId === providerId) cache.delete(key);
    }
    nativeAdapter?.clearQuotaCache?.(providerId);
  }

  function handle(req, res, url) {
    const pathname = url.pathname;

    // GET /api/quota/:providerId
    // POST /api/quota/:providerId/refresh
    if (pathname.startsWith('/api/quota/')) {
      const sub = decodeURIComponent(pathname.slice('/api/quota/'.length)).trim();
      const isRefresh = sub.endsWith('/refresh');
      const providerId = isRefresh ? sub.slice(0, -'/refresh'.length) : sub;

      if (!providerId) {
        return json(res, 400, { ok: false, error: '供应商 ID 不能为空' });
      }

      /* 内部异常只回统一安全文案：不把 exception message / headers / 文件路径 / stack 交给 renderer。 */
      if (req.method === 'GET' && !isRefresh) {
        const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
        return getQuota(providerId, { force })
          .then((out) => json(res, out.ok ? 200 : 404, out))
          .catch(() => json(res, 500, { ok: false, error: SAFE_ERROR }));
      }

      if (req.method === 'POST' && (isRefresh || url.searchParams.get('force') === '1')) {
        return getQuota(providerId, { force: true })
          .then((out) => json(res, out.ok ? 200 : 404, out))
          .catch(() => json(res, 500, { ok: false, error: SAFE_ERROR }));
      }

      return json(res, 405, { ok: false, error: 'Method not allowed' });
    }

    // GET /api/quota（读取所有供应商的额度概览）
    if (pathname === '/api/quota') {
      if (req.method !== 'GET') {
        return json(res, 405, { ok: false, error: 'Method not allowed' });
      }
      const force = url.searchParams.get('force') === '1';
      const cfgAll = readModelsConfig() || {};
      return Promise.resolve(nativeAdapter?.list?.()).then(native => {
        const providers = [...new Set([...Object.keys(cfgAll.providers || {}), ...(native?.providers || []).map(p => p.providerId)])];
        return Promise.all(providers.map((p) => getQuota(p, { force }))).then(list => ({ providers, list }));
      })
        .then(({ providers, list }) => {
          const quotas = {};
          for (let i = 0; i < providers.length; i++) {
            const r = list[i];
            if (r.ok) quotas[providers[i]] = r.quota;
          }
          return json(res, 200, { ok: true, quotas });
        })
        .catch(() => json(res, 500, { ok: false, error: SAFE_ERROR }));
    }

    return json(res, 404, { ok: false, error: 'Not found' });
  }

  return { handle, getQuota, clearCache };
}

/* ---------- 内部工具 ---------- */

/** SHA-256 十六进制。只用于「内部身份」，不外传。 */
function hashOf(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
