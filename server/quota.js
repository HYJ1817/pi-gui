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

  let keyRes = null;
  const endpoint = 'https://openrouter.ai/api/v1/key';
  try {
    const pKey = await fetchFn(endpoint, { headers, signal: ctl.signal });
    keyRes = { status: pKey.status, ok: pKey.ok, json: await pKey.json().catch(() => null) };
  } catch (e) {
    keyRes = { error: e };
  } finally {
    clearTimeout(timer);
  }

  if (keyRes?.error) {
    const err = keyRes.error;
    const isTimeout = err.name === 'AbortError';
    return {
      status: 'unavailable',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: endpoint,
      updatedAt: new Date(now()).toISOString(),
      message: isTimeout ? 'OpenRouter ��Ȳ�ѯ��ʱ' : '�޷����ӵ� OpenRouter ����',
    };
  }

  if (keyRes.status === 401 || keyRes.status === 403) {
    return {
      status: 'auth_error',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: endpoint,
      updatedAt: new Date(now()).toISOString(),
      message: 'API Key ��Ч��δ��Ȩ',
    };
  }

  if (!keyRes.ok) {
    return {
      status: 'unavailable',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: endpoint,
      updatedAt: new Date(now()).toISOString(),
      message: `OpenRouter ���񷵻� HTTP ${keyRes.status}`,
    };
  }

  const d = keyRes.json?.data;
  if (!d || typeof d !== 'object') {
    return {
      status: 'error',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: endpoint,
      updatedAt: new Date(now()).toISOString(),
      message: 'OpenRouter ���ص����ݸ�ʽ������Ԥ��',
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
    windows = {
      used: usage,
      limit,
      remaining: limitRemaining,
      unit: 'USD',
    };
  }

  let rateLimit = null;
  if (d.rate_limit && typeof d.rate_limit === 'object') {
    rateLimit = {
      requests: cleanNumber(d.rate_limit.requests),
      interval: typeof d.rate_limit.interval === 'string' ? d.rate_limit.interval : null,
    };
  }
  
  let resetAt = null;
  if (d.limit_reset && !Number.isNaN(Date.parse(d.limit_reset))) {
    resetAt = d.limit_reset;
  } else if (d.expires_at && !Number.isNaN(Date.parse(d.expires_at))) {
    resetAt = d.expires_at;
  }

  return {
    status: 'ok',
    balance: balanceAmount !== null ? {
      amount: balanceAmount,
      currency: 'USD',
      granted: null,
      toppedUp: null,
    } : null,
    windows,
    rateLimit,
    resetAt,
    source: endpoint,
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
      message: isTimeout ? 'DeepSeek ��Ȳ�ѯ��ʱ' : '�޷����ӵ� DeepSeek ��ȷ���',
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
      message: 'API Key ��Ч��δ��Ȩ',
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
      message: `DeepSeek ���� HTTP ${res.status}`,
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
      message: 'DeepSeek ���ص����ݸ�ʽ������Ԥ��',
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
      message: 'DeepSeek �˻���Ȳ�����',
    };
  }

  const balances = [];
  if (Array.isArray(jsonVal.balance_infos)) {
    for (const info of jsonVal.balance_infos) {
      balances.push({
        amount: cleanNumber(info.total_balance),
        currency: typeof info.currency === 'string' && info.currency ? info.currency : 'CNY',
        granted: cleanNumber(info.granted_balance),
        toppedUp: cleanNumber(info.topped_up_balance),
      });
    }
  }

  let primary = balances[0] || null;
  // DeepSeek ����չʾ CNY
  const cny = balances.find(b => b.currency === 'CNY');
  if (cny) primary = cny;

  return {
    status: jsonVal.is_available === false ? 'unavailable' : 'ok',
    balance: primary,
    balances: balances.length > 0 ? balances : null,
    windows: null,
    rateLimit: null,
    resetAt: null,
    source: 'https://api.deepseek.com/user/balance',
    updatedAt: new Date(now()).toISOString(),
    message: jsonVal.is_available === false ? 'DeepSeek �˻����ڲ�����״̬' : null,
  };
}



/** NewAPI / Sub2API 专有适配器（必须显式配置 quotaAdapter 或命中 provider 标识） */
async function fetchNewApiQuota({ baseUrl, apiKey, config, fetchFn, now }) {
  if (!config || !config.quotaUserId) {
    return {
      status: 'unsupported',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: 'none',
      updatedAt: new Date(now()).toISOString(),
      message: 'NewAPI ��Ҫ��ģ�͹�Ӧ����������д quotaUserId ���ܲ�ѯ���',
    };
  }

  const base = trimSlash(baseUrl);
  const subUrl = `${base}/dashboard/billing/subscription`;
  const usageUrl = `${base}/dashboard/billing/usage`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'New-Api-User': String(config.quotaUserId),
    Accept: 'application/json',
  };
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
    const err = subRes.error;
    const isTimeout = err.name === 'AbortError';
    return {
      status: 'unavailable',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: subUrl,
      updatedAt: new Date(now()).toISOString(),
      message: isTimeout ? 'NewAPI ��Ȳ�ѯ��ʱ' : '�޷����ӵ� NewAPI ��ȷ���',
    };
  }

  if (subRes.status === 401 || subRes.status === 403) {
    return {
      status: 'auth_error',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: subUrl,
      updatedAt: new Date(now()).toISOString(),
      message: 'API Key �� quotaUserId ��Ч��δ��Ȩ',
    };
  }

  if (!subRes.ok) {
    return {
      status: 'unavailable',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: subUrl,
      updatedAt: new Date(now()).toISOString(),
      message: `NewAPI ���񷵻� HTTP ${subRes.status}`,
    };
  }

  const jsonVal = subRes.json;
  if (!jsonVal || typeof jsonVal !== 'object') {
    return {
      status: 'error',
      balance: null,
      windows: null,
      rateLimit: null,
      resetAt: null,
      source: subUrl,
      updatedAt: new Date(now()).toISOString(),
      message: 'NewAPI ���ص����ݸ�ʽ������Ԥ��',
    };
  }

  const hardLimit = cleanNumber(jsonVal.hard_limit_usd);
  
  let totalUsageCents = null;
  if (usageRes?.ok && usageRes.json && typeof usageRes.json.total_usage !== 'undefined') {
    totalUsageCents = cleanNumber(usageRes.json.total_usage);
  }

  const usedUsd = totalUsageCents !== null ? totalUsageCents / 100 : null;
  let remainingUsd = null;
  if (hardLimit !== null && usedUsd !== null) {
    remainingUsd = Math.max(0, hardLimit - usedUsd);
  }

  let amount = remainingUsd !== null ? remainingUsd : null;

  return {
    status: 'ok',
    balance: amount !== null ? {
      amount,
      currency: 'USD',
      granted: null,
      toppedUp: null,
    } : null,
    windows: {
      used: usedUsd,
      limit: hardLimit,
      remaining: remainingUsd,
      unit: 'USD',
    },
    rateLimit: null,
    resetAt: null,
    source: subUrl,
    updatedAt: new Date(now()).toISOString(),
    message: null,
  };
}



/** 探测该 provider 是否有对应的远端额度 adapter */
export function resolveQuotaAdapter(providerId, config) {
  const pid = String(providerId || '').toLowerCase();
  const base = String(config?.baseUrl || '').toLowerCase();

  let urlObj = null;
  if (base) {
    try {
      urlObj = new URL(base);
    } catch (e) {
      // url 解析失败则保留为 null
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
      res = await fetchNewApiQuota({ baseUrl: config.baseUrl, apiKey, config, fetchFn, now });
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
        error: `��Ӧ�� ${providerId} ������`,
        quota: null,
      };
    }

    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256');
    hash.update(providerId || '');
    hash.update('|');
    hash.update(config.baseUrl || '');
    hash.update('|');
    hash.update(config.apiKey || '');
    hash.update('|');
    hash.update(config.quotaUserId || '');
    const configKey = hash.digest('hex');

    const t = now();
    const hit = cache.get(configKey);
    if (!force && hit && t - hit.cachedAt < ttlMs) {
      return { ok: true, quota: hit.quota, cached: true };
    }

    if (inFlight.has(configKey)) {
      const q = await inFlight.get(configKey);
      return { ok: true, quota: q, cached: false };
    }

    const p = fetchQuotaDirect(providerId, config)
      .then((q) => {
        cache.set(configKey, { quota: q, cachedAt: now() });
        return q;
      })
      .finally(() => {
        inFlight.delete(configKey);
      });

    inFlight.set(configKey, p);
    const quota = await p;
    return { ok: true, quota, cached: false };
  }

  function clearCache() { cache.clear(); }


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
