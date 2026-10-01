/* 供应商远端额度与配额适配器（Remote Quota）。
 *
 * 职责：
 *   - 针对有官方标准 balance/quota 接口的 Provider 进行按需拉取；
 *   - 提供官方明确支持的 Provider 适配器（OpenRouter / DeepSeek / NewAPI）；
 *   - 对无标准 Quota 接口的 Provider（OpenAI/Anthropic/Google 等）严格返回 unsupported；
 *   - 凭据仅后端解析使用，绝不回传给前端，错误信息严格脱敏；
 *   - 提供 TTL 缓存与去重，避免高频请求。
 */
import { resolveApiKey } from '../lib/models-api.js';
import { json } from './http-utils.js';

const TIMEOUT_MS = 10_000;
const DEFAULT_TTL_MS = 60_000;

/** 脱敏文本里的密钥 */
export function scrubSecret(text, secret) {
  if (!text) return '';
  const s = String(text);
  if (!secret || typeof secret !== 'string') return s;
  return s.split(secret).join('***');
}

/** 规范化数值：确保只有有限数字才返回，否则返回 null（0 是真实 0） */
export function cleanNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 移除结尾的斜杠 */
function trimSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/** OpenRouter 额度拉取 */
async function fetchOpenRouterQuota({ apiKey, fetchFn, now }) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  let creditsRes = null;
  let keyRes = null;
  try {
    const pCredits = fetchFn('https://openrouter.ai/api/v1/credits', { headers, signal: ctl.signal })
      .then(async (r) => ({ status: r.status, ok: r.ok, json: await r.json().catch(() => null) }))
      .catch((e) => ({ error: e }));

    const pKey = fetchFn('https://openrouter.ai/api/v1/auth/key', { headers, signal: ctl.signal })
      .then(async (r) => ({ status: r.status, ok: r.ok, json: await r.json().catch(() => null) }))
      .catch(() => null);

    [creditsRes, keyRes] = await Promise.all([pCredits, pKey]);
  } finally {
    clearTimeout(timer);
  }

  if (creditsRes?.error) {
    const err = creditsRes.error;
    const isTimeout = err.name === 'AbortError';
    return {
      status: 'unavailable',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: 'https://openrouter.ai/api/v1/credits',
      updatedAt: new Date(now()).toISOString(),
      message: isTimeout ? 'OpenRouter 额度查询超时' : '无法连接到 OpenRouter 额度服务',
    };
  }

  if (creditsRes.status === 401 || creditsRes.status === 403) {
    return {
      status: 'auth_error',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: 'https://openrouter.ai/api/v1/credits',
      updatedAt: new Date(now()).toISOString(),
      message: 'API Key 无效或未授权',
    };
  }

  if (!creditsRes.ok) {
    return {
      status: 'unavailable',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: 'https://openrouter.ai/api/v1/credits',
      updatedAt: new Date(now()).toISOString(),
      message: `OpenRouter 服务返回 HTTP ${creditsRes.status}`,
    };
  }

  const d = creditsRes.json?.data;
  if (!d || typeof d !== 'object') {
    return {
      status: 'error',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: 'https://openrouter.ai/api/v1/credits',
      updatedAt: new Date(now()).toISOString(),
      message: 'OpenRouter 返回的数据格式不符合预期',
    };
  }

  const totalCredits = cleanNumber(d.total_credits);
  const totalUsage = cleanNumber(d.total_usage);
  let balanceAmount = null;
  if (totalCredits !== null && totalUsage !== null) {
    balanceAmount = Math.max(0, totalCredits - totalUsage);
  } else if (totalCredits !== null) {
    balanceAmount = totalCredits;
  }

  let windows = null;
  let rateLimit = null;
  if (keyRes?.ok && keyRes.json?.data) {
    const kd = keyRes.json.data;
    const limit = cleanNumber(kd.limit);
    const usage = cleanNumber(kd.usage);
    if (limit !== null || usage !== null) {
      windows = {
        used: usage,
        limit,
        unit: 'USD',
      };
    }
    if (kd.rate_limit && typeof kd.rate_limit === 'object') {
      rateLimit = {
        requests: cleanNumber(kd.rate_limit.requests),
        interval: typeof kd.rate_limit.interval === 'string' ? kd.rate_limit.interval : null,
      };
    }
  }

  return {
    status: 'ok',
    balance: {
      amount: balanceAmount,
      currency: 'USD',
      granted: null,
      toppedUp: null,
    },
    windows,
    rateLimit,
    resetAt: null,
    source: 'https://openrouter.ai/api/v1/credits',
    updatedAt: new Date(now()).toISOString(),
    message: null,
  };
}

/** DeepSeek 额度拉取 */
async function fetchDeepSeekQuota({ apiKey, fetchFn, now }) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  let res = null;
  try {
    const r = await fetchFn('https://api.deepseek.com/user/balance', { headers, signal: ctl.signal });
    res = { status: r.status, ok: r.ok, json: await r.json().catch(() => null) };
  } catch (err) {
    const isTimeout = err?.name === 'AbortError';
    return {
      status: 'unavailable',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: 'https://api.deepseek.com/user/balance',
      updatedAt: new Date(now()).toISOString(),
      message: isTimeout ? 'DeepSeek 额度查询超时' : '无法连接到 DeepSeek 额度服务',
    };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return {
      status: 'auth_error',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: 'https://api.deepseek.com/user/balance',
      updatedAt: new Date(now()).toISOString(),
      message: 'API Key 无效或未授权',
    };
  }

  if (!res.ok) {
    return {
      status: 'unavailable',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: 'https://api.deepseek.com/user/balance',
      updatedAt: new Date(now()).toISOString(),
      message: `DeepSeek 返回 HTTP ${res.status}`,
    };
  }

  const jsonVal = res.json;
  if (!jsonVal || typeof jsonVal !== 'object') {
    return {
      status: 'error',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: 'https://api.deepseek.com/user/balance',
      updatedAt: new Date(now()).toISOString(),
      message: 'DeepSeek 返回的数据格式不符合预期',
    };
  }

  if (jsonVal.is_available === false && (!Array.isArray(jsonVal.balance_infos) || !jsonVal.balance_infos.length)) {
    return {
      status: 'unavailable',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: 'https://api.deepseek.com/user/balance',
      updatedAt: new Date(now()).toISOString(),
      message: 'DeepSeek 账户额度不可用',
    };
  }

  const info = Array.isArray(jsonVal.balance_infos) && jsonVal.balance_infos[0] ? jsonVal.balance_infos[0] : null;
  const total = cleanNumber(info?.total_balance);
  const granted = cleanNumber(info?.granted_balance);
  const toppedUp = cleanNumber(info?.topped_up_balance);
  const currency = typeof info?.currency === 'string' && info.currency ? info.currency : 'CNY';

  return {
    status: jsonVal.is_available === false ? 'unavailable' : 'ok',
    balance: {
      amount: total,
      currency,
      granted,
      toppedUp,
    },
    windows: null,
    rateLimit: null,
    resetAt: null,
    source: 'https://api.deepseek.com/user/balance',
    updatedAt: new Date(now()).toISOString(),
    message: jsonVal.is_available === false ? 'DeepSeek 账户处于不可用状态' : null,
  };
}

/** NewAPI / Sub2API 专有适配器（必须显式配置 quotaAdapter 或命中 provider 标识） */
async function fetchNewApiQuota({ baseUrl, apiKey, fetchFn, now }) {
  const base = trimSlash(baseUrl);
  const targetUrl = `${base}/dashboard/billing/subscription`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  let res = null;
  try {
    const r = await fetchFn(targetUrl, { headers, signal: ctl.signal });
    res = { status: r.status, ok: r.ok, json: await r.json().catch(() => null) };
  } catch (err) {
    const isTimeout = err?.name === 'AbortError';
    return {
      status: 'unavailable',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: targetUrl,
      updatedAt: new Date(now()).toISOString(),
      message: isTimeout ? 'NewAPI 额度查询超时' : '无法连接到 NewAPI 额度服务',
    };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return {
      status: 'auth_error',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: targetUrl,
      updatedAt: new Date(now()).toISOString(),
      message: 'API Key 无效或未授权',
    };
  }

  if (!res.ok) {
    return {
      status: 'unavailable',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: targetUrl,
      updatedAt: new Date(now()).toISOString(),
      message: `NewAPI 服务返回 HTTP ${res.status}`,
    };
  }

  const jsonVal = res.json;
  if (!jsonVal || typeof jsonVal !== 'object') {
    return {
      status: 'error',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: targetUrl,
      updatedAt: new Date(now()).toISOString(),
      message: 'NewAPI 返回的数据格式不符合预期',
    };
  }

  const hardLimit = cleanNumber(jsonVal.hard_limit_usd);
  const totalUsage = cleanNumber(jsonVal.total_usage);
  let amount = null;
  if (hardLimit !== null && totalUsage !== null) {
    amount = Math.max(0, hardLimit - totalUsage);
  } else if (hardLimit !== null) {
    amount = hardLimit;
  }

  return {
    status: 'ok',
    balance: {
      amount,
      currency: 'USD',
      granted: null,
      toppedUp: null,
    },
    windows: {
      used: totalUsage,
      limit: hardLimit,
      unit: 'USD',
    },
    rateLimit: null,
    resetAt: null,
    source: targetUrl,
    updatedAt: new Date(now()).toISOString(),
    message: null,
  };
}

/** 探测该 provider 是否有对应的远端额度 adapter */
export function resolveQuotaAdapter(providerId, config) {
  const pid = String(providerId || '').toLowerCase();
  const base = String(config?.baseUrl || '').toLowerCase();

  if (pid === 'openrouter' || base.includes('openrouter.ai')) {
    return 'openrouter';
  }
  if (pid === 'deepseek' || base.includes('deepseek.com')) {
    return 'deepseek';
  }
  if (config?.quotaAdapter === 'newapi' || config?.quotaAdapter === 'sub2api' || pid === 'newapi' || pid === 'sub2api') {
    return 'newapi';
  }
  return null;
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
        windows: null,
        rateLimit: null,
        resetAt: null,
        source: 'none',
        updatedAt: new Date(now()).toISOString(),
        message: '该供应商未提供公开的官方额度接口',
      };
    }

    const keyRes = resolveApiKey(config?.apiKey);
    if (keyRes.error) {
      return {
        providerId,
        status: 'auth_error',
        balance: null,
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
      res = await fetchNewApiQuota({ baseUrl: config.baseUrl, apiKey, fetchFn, now });
    } else {
      res = {
        status: 'unsupported',
        balance: null,
        windows: null,
        rateLimit: null,
        resetAt: null,
        source: 'none',
        updatedAt: new Date(now()).toISOString(),
        message: '该供应商未提供公开的官方额度接口',
      };
    }

    return {
      providerId,
      ...res,
    };
  }

  async function getQuota(providerId, { force = false } = {}) {
    const cfgAll = readModelsConfig() || {};
    const config = cfgAll.providers?.[providerId];
    if (!config) {
      return {
        ok: false,
        error: `供应商 ${providerId} 不存在`,
        quota: null,
      };
    }

    const t = now();
    const hit = cache.get(providerId);
    if (!force && hit && t - hit.cachedAt < ttlMs) {
      return { ok: true, quota: hit.quota, cached: true };
    }

    if (inFlight.has(providerId)) {
      const q = await inFlight.get(providerId);
      return { ok: true, quota: q, cached: false };
    }

    const p = fetchQuotaDirect(providerId, config)
      .then((q) => {
        cache.set(providerId, { quota: q, cachedAt: now() });
        return q;
      })
      .finally(() => {
        inFlight.delete(providerId);
      });

    inFlight.set(providerId, p);
    const quota = await p;
    return { ok: true, quota, cached: false };
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

      if (req.method === 'GET' && !isRefresh) {
        const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
        return getQuota(providerId, { force })
          .then((out) => {
            if (!out.ok) return json(res, 404, out);
            return json(res, 200, out);
          })
          .catch((err) => json(res, 500, { ok: false, error: String(err?.message || err) }));
      }

      if (req.method === 'POST' && (isRefresh || url.searchParams.get('force') === '1')) {
        return getQuota(providerId, { force: true })
          .then((out) => {
            if (!out.ok) return json(res, 404, out);
            return json(res, 200, out);
          })
          .catch((err) => json(res, 500, { ok: false, error: String(err?.message || err) }));
      }

      return json(res, 405, { ok: false, error: 'Method not allowed' });
    }

    // GET /api/quota (读取所有供应商的额度概览)
    if (pathname === '/api/quota') {
      if (req.method !== 'GET') {
        return json(res, 405, { ok: false, error: 'Method not allowed' });
      }
      const force = url.searchParams.get('force') === '1';
      const cfgAll = readModelsConfig() || {};
      const providers = Object.keys(cfgAll.providers || {});

      return Promise.all(providers.map((p) => getQuota(p, { force })))
        .then((list) => {
          const quotas = {};
          for (let i = 0; i < providers.length; i++) {
            const p = providers[i];
            const r = list[i];
            if (r.ok) quotas[p] = r.quota;
          }
          return json(res, 200, { ok: true, quotas });
        })
        .catch((err) => json(res, 500, { ok: false, error: String(err?.message || err) }));
      return;
    }

    return json(res, 404, { ok: false, error: 'Not found' });
  }

  function clearCache(providerId = null) {
    if (providerId) cache.delete(providerId);
    else cache.clear();
  }

  return {
    handle,
    getQuota,
    clearCache,
  };
}
