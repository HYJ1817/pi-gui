/* P21 Usage / Quota 自动化测试（完全离线）。
 *
 * 覆盖：
 *   1. 数值语义：0 与 null 的分界（后端 cleanNumber / 前端 fmtMaybeNumber）
 *   2. Provider 契约：OpenRouter / DeepSeek / NewAPI / unsupported
 *      —— mock fetch **严格断言 URL**，不认识的 URL 直接抛错；
 *      NewAPI 两个 endpoint 各自返回不同 fixture，并核对调用次数与请求头
 *   3. 安全：凭据脱敏、错误文案不泄露、HTTP handler 不回传内部异常
 *   4. 缓存身份：TTL / force / 并发去重 / 环境变量变化 / adapter 变化 / inFlight 隔离
 *   5. HTTP 路由
 *   6. 前端 DOM：workspace reset、session 切换、provider unknown、多币种、0 与 null
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok && typeof ok === 'string' ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}

function mockRes() {
  return {
    code: null,
    headers: null,
    chunks: [],
    ended: false,
    writeHead(code, headers) {
      this.code = code;
      this.headers = headers || {};
      return this;
    },
    write(s) {
      this.chunks.push(String(s));
      return true;
    },
    end(s) {
      if (s) this.chunks.push(String(s));
      this.ended = true;
    },
    json() {
      try {
        return JSON.parse(this.chunks.join(''));
      } catch {
        return null;
      }
    },
    text() {
      return this.chunks.join('');
    },
  };
}

/** 只接受白名单 URL 的 fetch mock：任何其它 URL 直接抛错，避免"mock 不区分 URL"的假绿。 */
function strictFetch(handlers, onCall) {
  return async (url, opts) => {
    if (typeof onCall === 'function') onCall(url, opts);
    const key = String(url);
    if (!Object.prototype.hasOwnProperty.call(handlers, key)) {
      throw new Error('unexpected URL: ' + key);
    }
    return handlers[key](opts);
  };
}

const KEY = 'sk-or-v1-secret-test-key-12345';
const DS_KEY = 'sk-deepseek-secret-key-99999';
const NEWAPI_KEY = 'sk-newapi-secret-key-88888';

(async function main() {
  console.log('=== 1. 数值语义：0 与 null 的分界 ===');
  const { createQuotaManager, scrubSecret, cleanNumber, resolveQuotaAdapter } = await import('../server/quota.js');

  check('cleanNumber: 真实 0 保留为 0', cleanNumber(0) === 0);
  check('cleanNumber: "0" 字符串转为 0', cleanNumber('0') === 0);
  check('cleanNumber: 正数保留', cleanNumber(12.34) === 12.34);
  check('cleanNumber: null 返回 null', cleanNumber(null) === null);
  check('cleanNumber: undefined 返回 null', cleanNumber(undefined) === null);
  check('cleanNumber: 空字符串返回 null', cleanNumber('') === null);
  check('cleanNumber: NaN 返回 null', cleanNumber(NaN) === null);
  check('cleanNumber: Infinity 返回 null', cleanNumber(Infinity) === null);

  console.log('=== 1b. 适配器识别（含自定义 baseUrl 的拒绝） ===');
  check('resolveQuotaAdapter: openrouter 识别成功', resolveQuotaAdapter('openrouter', {}) === 'openrouter');
  check('resolveQuotaAdapter: openrouter.ai baseUrl 识别成功', resolveQuotaAdapter('custom-or', { baseUrl: 'https://openrouter.ai/api/v1' }) === 'openrouter');
  check('resolveQuotaAdapter: deepseek 识别成功', resolveQuotaAdapter('deepseek', {}) === 'deepseek');
  check('resolveQuotaAdapter: deepseek.com baseUrl 识别成功', resolveQuotaAdapter('ds', { baseUrl: 'https://api.deepseek.com' }) === 'deepseek');
  check('resolveQuotaAdapter: quotaAdapter: newapi 识别成功', resolveQuotaAdapter('my-proxy', { quotaAdapter: 'newapi', quotaUserId: 'user_123' }) === 'newapi');
  check('resolveQuotaAdapter: sub2api 当前无稳定契约 → null', resolveQuotaAdapter('sub2api', { quotaAdapter: 'sub2api' }) === null);
  check('resolveQuotaAdapter: openai → null（unsupported）', resolveQuotaAdapter('openai', { baseUrl: 'https://api.openai.com/v1' }) === null);
  check('resolveQuotaAdapter: anthropic → null（unsupported）', resolveQuotaAdapter('anthropic', { baseUrl: 'https://api.anthropic.com' }) === null);
  check('resolveQuotaAdapter: google → null（unsupported）', resolveQuotaAdapter('google', { baseUrl: 'https://generativelanguage.googleapis.com' }) === null);
  check('resolveQuotaAdapter: 自称 openrouter 但 baseUrl 指向别处 → null', resolveQuotaAdapter('openrouter', { baseUrl: 'https://evil.example.com' }) === null);
  check('resolveQuotaAdapter: 自称 deepseek 但 baseUrl 指向别处 → null', resolveQuotaAdapter('deepseek', { baseUrl: 'https://evil.example.com' }) === null);

  console.log('=== 2. 安全与凭据脱敏 ===');
  check('scrubSecret: 替换存在的 secret 为 ***', scrubSecret(`Error: unauthorized with ${KEY}`, KEY) === 'Error: unauthorized with ***');
  check('scrubSecret: 空 secret 不报错', scrubSecret('Normal text', null) === 'Normal text');
  check('scrubSecret: 文本未含 secret 原样返回', scrubSecret('Normal error', KEY) === 'Normal error');

  console.log('=== 3. OpenRouter 契约（GET /api/v1/key） ===');
  const orUrls = [];
  const orFetch = strictFetch({
    'https://openrouter.ai/api/v1/key': () => ({
      status: 200,
      ok: true,
      json: async () => ({
        data: {
          usage: 2.5,
          limit: 50.0,
          limit_remaining: 8.0,
          limit_reset: 'monthly',
          expires_at: '2027-12-31T23:59:59Z',
          rate_limit: { requests: 20, interval: '10s' },
        },
      }),
    }),
  }, (url, opts) => {
    orUrls.push({ url: String(url), auth: opts?.headers?.Authorization });
  });
  const orManager = createQuotaManager({
    readModelsConfig: () => ({ providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY } } }),
    fetchFn: orFetch,
    now: () => 1700000000000,
  });
  const orResult = await orManager.getQuota('openrouter');
  check('OpenRouter: 只调用 /api/v1/key（严格 URL）', orUrls.length === 1 && orUrls[0].url === 'https://openrouter.ai/api/v1/key');
  check('OpenRouter: Authorization 为 Bearer <key>', orUrls[0].auth === `Bearer ${KEY}`);
  check('OpenRouter: 请求成功返回 ok:true', orResult.ok === true);
  check('OpenRouter: status 为 ok', orResult.quota.status === 'ok');
  check('OpenRouter: balance.amount = limit_remaining (8.0)', orResult.quota.balance.amount === 8.0);
  check('OpenRouter: currency 为 USD', orResult.quota.balance.currency === 'USD');
  check('OpenRouter: windows.used = usage (2.5)', orResult.quota.windows.used === 2.5);
  check('OpenRouter: windows.limit = limit (50)', orResult.quota.windows.limit === 50.0);
  check('OpenRouter: windows.remaining = limit_remaining (8.0)', orResult.quota.windows.remaining === 8.0);
  check('OpenRouter: rateLimit.requests 正确 (20)', orResult.quota.rateLimit.requests === 20);
  check('OpenRouter: rateLimit.interval 正确 ("10s")', orResult.quota.rateLimit.interval === '10s');
  check('OpenRouter: source 正确', orResult.quota.source === 'https://openrouter.ai/api/v1/key');
  check('OpenRouter: limit_reset="monthly" 不是时间戳 → resetAt 为 null', orResult.quota.resetAt === null);
  check('OpenRouter: expires_at 绝不映射成 resetAt', orResult.quota.resetAt !== '2027-12-31T23:59:59Z');
  check('OpenRouter: 结果里不含 API key 原文', !JSON.stringify(orResult).includes(KEY));

  // 真实 0 余额
  const orZeroManager = createQuotaManager({
    readModelsConfig: () => ({ providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY } } }),
    fetchFn: strictFetch({ 'https://openrouter.ai/api/v1/key': () => ({ status: 200, ok: true, json: async () => ({ data: { limit_remaining: 0.0 } }) }) }),
  });
  const orZeroRes = await orZeroManager.getQuota('openrouter');
  check('OpenRouter 真实 0 余额: balance.amount 严格为 0（非 null）', orZeroRes.quota.balance.amount === 0);

  // limit_reset 真的是时间戳时保留
  const orTsManager = createQuotaManager({
    readModelsConfig: () => ({ providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY } } }),
    fetchFn: strictFetch({ 'https://openrouter.ai/api/v1/key': () => ({ status: 200, ok: true, json: async () => ({ data: { limit_remaining: 1, limit_reset: '2027-01-01T00:00:00Z' } }) }) }),
  });
  const orTsRes = await orTsManager.getQuota('openrouter');
  check('OpenRouter: limit_reset 是合法时间戳时才作为 resetAt', orTsRes.quota.resetAt === '2027-01-01T00:00:00Z');

  console.log('=== 4. DeepSeek 契约（GET /user/balance，多币种不相加） ===');
  const dsUrls = [];
  const dsFetch = strictFetch({
    'https://api.deepseek.com/user/balance': () => ({
      status: 200,
      ok: true,
      json: async () => ({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '110', granted_balance: '10', topped_up_balance: '100' },
          { currency: 'USD', total_balance: '15' },
        ],
      }),
    }),
  }, (url, opts) => dsUrls.push({ url: String(url), auth: opts?.headers?.Authorization }));
  const dsManager = createQuotaManager({
    readModelsConfig: () => ({ providers: { deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: DS_KEY } } }),
    fetchFn: dsFetch,
    now: () => 1700000000000,
  });
  const dsResult = await dsManager.getQuota('deepseek');
  check('DeepSeek: 只调用 /user/balance（严格 URL）', dsUrls.length === 1 && dsUrls[0].url === 'https://api.deepseek.com/user/balance');
  check('DeepSeek: Authorization 为 Bearer <key>', dsUrls[0].auth === `Bearer ${DS_KEY}`);
  check('DeepSeek: status 为 ok', dsResult.quota.status === 'ok');
  check('DeepSeek: balances 两个币种都在', Array.isArray(dsResult.quota.balances) && dsResult.quota.balances.length === 2);
  check('DeepSeek: CNY 那条 amount=110', dsResult.quota.balances.find((b) => b.currency === 'CNY').amount === 110);
  check('DeepSeek: USD 那条 amount=15', dsResult.quota.balances.find((b) => b.currency === 'USD').amount === 15);
  check('DeepSeek: 两个币种**不相加**（没有 125 这种数）', !JSON.stringify(dsResult.quota).includes('125'));
  check('DeepSeek: primary 策略明确（优先 CNY）', dsResult.quota.balance.currency === 'CNY' && dsResult.quota.balance.amount === 110);
  check('DeepSeek: granted/toppedUp 逐币种保留', dsResult.quota.balances[0].granted === 10 && dsResult.quota.balances[0].toppedUp === 100);

  console.log('=== 5. NewAPI 契约（subscription + usage 两个 endpoint） ===');
  const newApiCalls = [];
  const newApiFetch = strictFetch({
    'https://oneapi.example.com/dashboard/billing/subscription': () => ({
      status: 200, ok: true, json: async () => ({ hard_limit_usd: 100 }),
    }),
    'https://oneapi.example.com/dashboard/billing/usage': () => ({
      status: 200, ok: true, json: async () => ({ total_usage: 2500 }),
    }),
  }, (url, opts) => newApiCalls.push({ url: String(url), auth: opts?.headers?.Authorization, user: opts?.headers?.['New-Api-User'] }));
  const newApiManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: { 'my-oneapi': { baseUrl: 'https://oneapi.example.com', apiKey: NEWAPI_KEY, quotaAdapter: 'newapi', quotaUserId: 'user_123' } },
    }),
    fetchFn: newApiFetch,
    now: () => 1700000000000,
  });
  const newApiRes = await newApiManager.getQuota('my-oneapi');
  check('NewAPI: 正好调用两个 endpoint', newApiCalls.length === 2);
  check('NewAPI: 调用了 subscription', newApiCalls.some((c) => c.url.endsWith('/dashboard/billing/subscription')));
  check('NewAPI: 调用了 usage', newApiCalls.some((c) => c.url.endsWith('/dashboard/billing/usage')));
  check('NewAPI: 两个 endpoint 各调用正好一次（没有重复或互相顶替）',
    newApiCalls.length === 2 && new Set(newApiCalls.map((c) => c.url)).size === 2);
  check('NewAPI: Authorization 为 Bearer <key>', newApiCalls.every((c) => c.auth === `Bearer ${NEWAPI_KEY}`));
  check('NewAPI: 配了 quotaUserId 时才带 New-Api-User（旧部署兼容）', newApiCalls.every((c) => c.user === 'user_123'));
  check('NewAPI: status 为 ok', newApiRes.quota.status === 'ok');
  check('NewAPI: used = total_usage/100 = 25', newApiRes.quota.windows.used === 25);
  check('NewAPI: limit = hard_limit_usd = 100', newApiRes.quota.windows.limit === 100);
  check('NewAPI: remaining = 100 - 25 = 75', newApiRes.quota.windows.remaining === 75);
  check('NewAPI: balance.amount = remaining = 75', newApiRes.quota.balance.amount === 75);
  check('NewAPI: balance.currency 为 null（字段名带 _usd，但数值不保证是美元）', newApiRes.quota.balance.currency === null);
  check('NewAPI: windows.unit 为 null（generic numeric quota）', newApiRes.quota.windows.unit === null);
  check('NewAPI: 结果里没有把单位标成 USD/CNY', !/USD|CNY/.test(JSON.stringify(newApiRes.quota)));
  check('NewAPI: 结果里不含 API key 原文', !JSON.stringify(newApiRes).includes(NEWAPI_KEY));

  /* 没有 quotaUserId：当前 NewAPI 用 Bearer TokenAuth，这**不该**是必要条件。 */
  const newApiNoUserCalls = [];
  const newApiNoUser = createQuotaManager({
    readModelsConfig: () => ({ providers: { 'my-oneapi': { baseUrl: 'https://newapi.example.com', apiKey: NEWAPI_KEY, quotaAdapter: 'newapi' } } }),
    fetchFn: strictFetch({
      'https://newapi.example.com/dashboard/billing/subscription': () => ({ status: 200, ok: true, json: async () => ({ hard_limit_usd: 100 }) }),
      'https://newapi.example.com/dashboard/billing/usage': () => ({ status: 200, ok: true, json: async () => ({ total_usage: 2500 }) }),
    }, (url, opts) => newApiNoUserCalls.push({ url: String(url), auth: opts?.headers?.Authorization, user: opts?.headers?.['New-Api-User'] })),
  });
  const newApiNoUserRes = await newApiNoUser.getQuota('my-oneapi');
  check('NewAPI 无 quotaUserId: **不是** unsupported（正常执行）', newApiNoUserRes.quota.status === 'ok');
  check('NewAPI 无 quotaUserId: 两个 endpoint 各一次', newApiNoUserCalls.length === 2 && new Set(newApiNoUserCalls.map((c) => c.url)).size === 2);
  check('NewAPI 无 quotaUserId: 用 subscription + usage 两个 URL',
    newApiNoUserCalls.some((c) => c.url === 'https://newapi.example.com/dashboard/billing/subscription')
    && newApiNoUserCalls.some((c) => c.url === 'https://newapi.example.com/dashboard/billing/usage'));
  check('NewAPI 无 quotaUserId: Authorization 仍是 Bearer <key>', newApiNoUserCalls.every((c) => c.auth === `Bearer ${NEWAPI_KEY}`));
  check('NewAPI 无 quotaUserId: 默认**不发** New-Api-User', newApiNoUserCalls.every((c) => c.user === undefined));
  check('NewAPI 无 quotaUserId: used=25 / remaining=75 照常算出',
    newApiNoUserRes.quota.windows.used === 25 && newApiNoUserRes.quota.windows.remaining === 75);

  /* 没有 quotaAdapter：不猜 NewAPI，unsupported 且零请求。 */
  let newApiNoAdapterFetches = 0;
  const newApiNoAdapter = createQuotaManager({
    readModelsConfig: () => ({ providers: { 'my-proxy': { baseUrl: 'https://newapi.example.com', apiKey: NEWAPI_KEY } } }),
    fetchFn: async () => { newApiNoAdapterFetches++; throw new Error('不应发起请求'); },
  });
  const newApiNoAdapterRes = await newApiNoAdapter.getQuota('my-proxy');
  check('NewAPI 没配 quotaAdapter: status 为 unsupported（不按名字猜）', newApiNoAdapterRes.quota.status === 'unsupported');
  check('NewAPI 没配 quotaAdapter: 零网络请求', newApiNoAdapterFetches === 0);

  /* 没有 apiKey：auth_error，零请求。 */
  let newApiNoKeyFetches = 0;
  const newApiNoKey = createQuotaManager({
    readModelsConfig: () => ({ providers: { 'my-oneapi': { baseUrl: 'https://newapi.example.com', apiKey: '', quotaAdapter: 'newapi' } } }),
    fetchFn: async () => { newApiNoKeyFetches++; throw new Error('不应发起请求'); },
  });
  const newApiNoKeyRes = await newApiNoKey.getQuota('my-oneapi');
  check('NewAPI 没配 apiKey: status 为 auth_error', newApiNoKeyRes.quota.status === 'auth_error');
  check('NewAPI 没配 apiKey: 零网络请求', newApiNoKeyFetches === 0);
  check('NewAPI 没配 apiKey: 文案是白名单', newApiNoKeyRes.quota.message === '未配置 API Key');

  /* Fix B：NewAPI 的 endpoint identity 必须包含 base path。 */
  let pathAFetches = 0;
  let basePath = 'https://example.com/api-a';
  const pathManager = createQuotaManager({
    readModelsConfig: () => ({ providers: { 'my-oneapi': { baseUrl: basePath, apiKey: NEWAPI_KEY, quotaAdapter: 'newapi' } } }),
    fetchFn: async (url) => {
      pathAFetches++;
      const u = String(url);
      /* 两套 path 各自返回不同的数，用来证明没有串缓存。 */
      const isA = u.includes('/api-a/');
      if (u.endsWith('/dashboard/billing/subscription')) return { status: 200, ok: true, json: async () => ({ hard_limit_usd: isA ? 100 : 200 }) };
      return { status: 200, ok: true, json: async () => ({ total_usage: isA ? 2500 : 5000 }) };
    },
    now: () => 1700000000000,
    ttlMs: 60000,
  });
  const pathA = await pathManager.getQuota('my-oneapi');
  check('NewAPI base path A: remaining = 100 - 25 = 75', pathA.quota.windows.remaining === 75);
  const fetchesAfterA = pathAFetches;
  basePath = 'https://example.com/api-b';
  const pathB = await pathManager.getQuota('my-oneapi');
  check('NewAPI base path A → B: 必须重新 fetch（不吃 A 的缓存）', pathAFetches === fetchesAfterA + 2);
  check('NewAPI base path A → B: 拿到的是 B 的结果', pathB.quota.windows.limit === 200 && pathB.quota.windows.remaining === 150);
  basePath = 'https://example.com/api-b/';
  const pathB2 = await pathManager.getQuota('my-oneapi');
  check('NewAPI 尾部斜杠: /api-b/ 与 /api-b 是同一 identity（命中缓存）', pathAFetches === fetchesAfterA + 2 && pathB2.cached === true);
  check('NewAPI 尾部斜杠: 结果与 /api-b 一致', pathB2.quota.windows.remaining === 150);

  console.log('=== 6. unsupported 供应商：绝不发请求 ===');
  let unsuppFetches = 0;
  const unsuppManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: {
        openai: { baseUrl: 'https://api.openai.com/v1', apiKey: KEY },
        anthropic: { baseUrl: 'https://api.anthropic.com', apiKey: KEY },
        sub2api: { baseUrl: 'https://sub2.example.com', apiKey: KEY, quotaAdapter: 'sub2api' },
      },
    }),
    fetchFn: async () => { unsuppFetches++; throw new Error('不应发起请求'); },
  });
  const openaiRes = await unsuppManager.getQuota('openai');
  check('OpenAI: status 严格为 unsupported', openaiRes.quota.status === 'unsupported');
  check('OpenAI: balance 为 null', openaiRes.quota.balance === null);
  check('OpenAI: source 为 none', openaiRes.quota.source === 'none');
  check('OpenAI: message 说明未提供官方接口', openaiRes.quota.message.includes('未提供公开的官方额度接口'));
  check('Anthropic: status 严格为 unsupported', (await unsuppManager.getQuota('anthropic')).quota.status === 'unsupported');
  check('Sub2API: status 严格为 unsupported', (await unsuppManager.getQuota('sub2api')).quota.status === 'unsupported');
  check('unsupported 全部零请求', unsuppFetches === 0);

  console.log('=== 7. 认证与错误边界（文案安全） ===');
  const noKeyManager = createQuotaManager({
    readModelsConfig: () => ({ providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' } } }),
    fetchFn: async () => { throw new Error('未配置 Key 不应发起 fetch'); },
  });
  const noKeyRes = await noKeyManager.getQuota('openrouter');
  check('未配置 Key: status 为 auth_error', noKeyRes.quota.status === 'auth_error');
  check('未配置 Key: message 正确', noKeyRes.quota.message === '未配置 API Key');

  const envKeyManager = createQuotaManager({
    readModelsConfig: () => ({ providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '$NON_EXISTENT_ENV_KEY_VAR_XYZ' } } }),
    fetchFn: async () => { throw new Error('Key 错误不应发起 fetch'); },
  });
  check('环境变量未设置: status 为 auth_error', (await envKeyManager.getQuota('openrouter')).quota.status === 'auth_error');

  const authErrManager = createQuotaManager({
    readModelsConfig: () => ({ providers: { deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: KEY } } }),
    fetchFn: strictFetch({ 'https://api.deepseek.com/user/balance': () => ({ status: 401, ok: false, json: async () => ({ error: 'Unauthorized' }) }) }),
  });
  const authErrRes = await authErrManager.getQuota('deepseek');
  check('HTTP 401: status 为 auth_error', authErrRes.quota.status === 'auth_error');
  check('HTTP 401: balance 为 null', authErrRes.quota.balance === null);
  check('HTTP 401: 不把响应体带回前端', !JSON.stringify(authErrRes).includes('Unauthorized'));

  const unavailManager = createQuotaManager({
    readModelsConfig: () => ({ providers: { deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: KEY } } }),
    fetchFn: async () => { const e = new Error('connect ECONNREFUSED 127.0.0.1:443'); e.code = 'ECONNREFUSED'; throw e; },
  });
  const unavailRes = await unavailManager.getQuota('deepseek');
  check('网络错误: status 为 unavailable', unavailRes.quota.status === 'unavailable');
  check('网络错误: message 是白名单文案且不含内部细节', unavailRes.quota.message === '无法连接到 DeepSeek 余额服务');
  check('网络错误: 不泄露 ECONNREFUSED/主机端口', !JSON.stringify(unavailRes).includes('ECONNREFUSED') && !JSON.stringify(unavailRes).includes('127.0.0.1'));

  const malformedManager = createQuotaManager({
    readModelsConfig: () => ({ providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY } } }),
    fetchFn: strictFetch({ 'https://openrouter.ai/api/v1/key': () => ({ status: 200, ok: true, json: async () => ({ unexpected: true }) }) }),
  });
  const malformedRes = await malformedManager.getQuota('openrouter');
  check('畸形响应: status 为 error', malformedRes.quota.status === 'error');
  check('畸形响应: message 为白名单文案', malformedRes.quota.message === 'OpenRouter 返回的数据格式不符合预期');

  const missingRes = await malformedManager.getQuota('non_existent_provider');
  check('不存在的供应商: ok 为 false', missingRes.ok === false);
  check('不存在的供应商: error 文案明确', missingRes.error === '供应商 non_existent_provider 不存在');

  console.log('=== 8. HTTP handler：内部异常不回传 ===');
  const boomManager = createQuotaManager({
    readModelsConfig: () => { throw new Error('internal: /home/user/.pi/agent/models.json unreadable, key=' + KEY); },
    fetchFn: async () => { throw new Error('不应到达这里'); },
  });
  const resBoom = mockRes();
  await boomManager.handle({ method: 'GET' }, resBoom, new URL('http://127.0.0.1/api/quota/openrouter'));
  check('handler 异常: 状态码 500', resBoom.code === 500);
  check('handler 异常: 统一安全文案', resBoom.json()?.error === '额度查询失败');
  check('handler 异常: 不回传内部 message / 路径 / key', !resBoom.text().includes('internal') && !resBoom.text().includes('/home/user') && !resBoom.text().includes(KEY));

  console.log('=== 9. 缓存身份（配置一变就是另一条身份） ===');
  // 9.1 TTL / force / 并发（原有真实覆盖）
  let fetchCount = 0;
  let simulatedTime = 1000;
  const cacheTestManager = createQuotaManager({
    readModelsConfig: () => ({ providers: { deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: DS_KEY } } }),
    fetchFn: strictFetch({ 'https://api.deepseek.com/user/balance': () => { fetchCount++; return { status: 200, ok: true, json: async () => ({ is_available: true, balance_infos: [{ total_balance: '10.00', currency: 'CNY' }] }) }; } }),
    now: () => simulatedTime,
    ttlMs: 60000,
  });
  const req1 = await cacheTestManager.getQuota('deepseek');
  check('第一次请求: cached 为 false', req1.cached === false);
  check('第一次请求: 发起了一次 fetch', fetchCount === 1);
  simulatedTime += 10000;
  const req2 = await cacheTestManager.getQuota('deepseek');
  check('TTL 内请求: cached 为 true', req2.cached === true);
  check('TTL 内请求: 未发起新的 fetch', fetchCount === 1);
  check('TTL 内请求: 返回相同 quota', req2.quota.balance.amount === 10.0);
  const reqForce = await cacheTestManager.getQuota('deepseek', { force: true });
  check('force=true 强制刷新: cached 为 false', reqForce.cached === false);
  check('force=true 强制刷新: 发起了新的 fetch', fetchCount === 2);
  simulatedTime += 70000;
  const reqExpired = await cacheTestManager.getQuota('deepseek');
  check('TTL 过期后: cached 为 false', reqExpired.cached === false);
  check('TTL 过期后: 发起了新的 fetch', fetchCount === 3);

  fetchCount = 0;
  cacheTestManager.clearCache();
  const [c1, c2, c3] = await Promise.all([
    cacheTestManager.getQuota('deepseek'),
    cacheTestManager.getQuota('deepseek'),
    cacheTestManager.getQuota('deepseek'),
  ]);
  check('并发 3 次请求: 只执行了 1 次底层 fetch', fetchCount === 1);
  check('并发 3 次请求: 结果均正常', c1.ok && c2.ok && c3.ok && c1.quota.balance.amount === 10.0);

  // 9.2 环境变量变化：models.json 里的字符串没变，但解析出的凭据变了 → 必须重新拉
  let envFetchCount = 0;
  process.env.P21_QUOTA_KEY = 'env-key-A';
  const envManager = createQuotaManager({
    readModelsConfig: () => ({ providers: { deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: '$P21_QUOTA_KEY' } } }),
    fetchFn: strictFetch({
      'https://api.deepseek.com/user/balance': () => {
        envFetchCount++;
        return { status: 200, ok: true, json: async () => ({ is_available: true, balance_infos: [{ total_balance: String(envFetchCount), currency: 'CNY' }] }) };
      },
    }),
  });
  const envA = await envManager.getQuota('deepseek');
  process.env.P21_QUOTA_KEY = 'env-key-B';
  const envB = await envManager.getQuota('deepseek');
  check('环境变量改值: 必须重新 fetch（不吃 A 的缓存）', envFetchCount === 2);
  check('环境变量改值: 第二次拿到的是新结果', envB.quota.balance.amount === 2 && envA.quota.balance.amount === 1);
  delete process.env.P21_QUOTA_KEY;

  // 9.3 adapter 变化：newapi → 去掉 quotaAdapter
  let adapterFetchCount = 0;
  let withAdapter = true;
  const adapterManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: {
        'my-oneapi': withAdapter
          ? { baseUrl: 'https://oneapi.example.com', apiKey: NEWAPI_KEY, quotaAdapter: 'newapi', quotaUserId: 'u1' }
          : { baseUrl: 'https://oneapi.example.com', apiKey: NEWAPI_KEY },
      },
    }),
    fetchFn: strictFetch({
      'https://oneapi.example.com/dashboard/billing/subscription': () => { adapterFetchCount++; return { status: 200, ok: true, json: async () => ({ hard_limit_usd: 100 }) }; },
      'https://oneapi.example.com/dashboard/billing/usage': () => ({ status: 200, ok: true, json: async () => ({ total_usage: 2500 }) }),
    }),
  });
  const withNewApi = await adapterManager.getQuota('my-oneapi');
  withAdapter = false;
  const withoutNewApi = await adapterManager.getQuota('my-oneapi');
  check('adapter 变化: 旧 newapi 结果不再命中', withNewApi.quota.status === 'ok' && withoutNewApi.quota.status === 'unsupported');
  check('adapter 变化: 去掉 adapter 后不再发 newapi 请求', adapterFetchCount === 1);

  // 9.4 inFlight 隔离：A 在途，配置切成 B，A 后 resolve 不能污染 B
  let slowResolve = null;
  let identityFetch = 0;
  let currentKey = 'key-A';
  const inflightManager = createQuotaManager({
    readModelsConfig: () => ({ providers: { deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: currentKey } } }),
    fetchFn: async () => {
      identityFetch++;
      const isA = currentKey === 'key-A';
      if (isA) {
        return new Promise((resolve) => {
          slowResolve = () => resolve({ status: 200, ok: true, json: async () => ({ is_available: true, balance_infos: [{ total_balance: '111', currency: 'CNY' }] }) });
        });
      }
      return { status: 200, ok: true, json: async () => ({ is_available: true, balance_infos: [{ total_balance: '222', currency: 'CNY' }] }) };
    },
  });
  const pendingA = inflightManager.getQuota('deepseek');
  await new Promise((r) => setTimeout(r, 0));
  currentKey = 'key-B';
  const resultB = await inflightManager.getQuota('deepseek');
  check('inFlight 隔离: B 发起自己的请求', identityFetch === 2);
  check('inFlight 隔离: B 拿到的是自己的结果', resultB.quota.balance.amount === 222);
  slowResolve();
  const settledA = await pendingA;
  check('inFlight 隔离: A 后 resolve 属于 A 身份', settledA.quota.balance.amount === 111);
  currentKey = 'key-B';
  const resultB2 = await inflightManager.getQuota('deepseek');
  check('inFlight 隔离: B 身份不会被 A 的结果污染', resultB2.quota.balance.amount === 222);

  // 9.5 clearCache(providerId) 真的清得掉（按身份哈希存也要能按 providerId 清）
  let clearFetch = 0;
  const clearManager = createQuotaManager({
    readModelsConfig: () => ({ providers: { deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: DS_KEY } } }),
    fetchFn: strictFetch({ 'https://api.deepseek.com/user/balance': () => { clearFetch++; return { status: 200, ok: true, json: async () => ({ is_available: true, balance_infos: [{ total_balance: '5', currency: 'CNY' }] }) }; } }),
  });
  await clearManager.getQuota('deepseek');
  clearManager.clearCache('deepseek');
  const afterClear = await clearManager.getQuota('deepseek');
  check('clearCache(providerId): 清掉后必须重新 fetch', clearFetch === 2 && afterClear.cached === false);

  console.log('=== 10. HTTP 路由集成 ===');
  const httpManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: {
        deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: DS_KEY },
        openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY },
      },
    }),
    fetchFn: strictFetch({
      'https://api.deepseek.com/user/balance': () => ({ status: 200, ok: true, json: async () => ({ is_available: true, balance_infos: [{ total_balance: '20.00', currency: 'CNY' }] }) }),
      'https://openrouter.ai/api/v1/key': () => ({ status: 200, ok: true, json: async () => ({ data: { limit: 30, limit_remaining: 25 } }) }),
    }),
  });
  const resGet = mockRes();
  await httpManager.handle({ method: 'GET' }, resGet, new URL('http://127.0.0.1/api/quota/deepseek'));
  check('HTTP GET /api/quota/deepseek: 状态码 200', resGet.code === 200);
  check('HTTP GET: ok: true', resGet.json()?.ok === true);
  check('HTTP GET: 返回 quota 对象', resGet.json()?.quota?.balance?.amount === 20.0);

  const resRefresh = mockRes();
  await httpManager.handle({ method: 'POST' }, resRefresh, new URL('http://127.0.0.1/api/quota/deepseek/refresh'));
  check('HTTP POST /api/quota/deepseek/refresh: 状态码 200', resRefresh.code === 200);
  check('HTTP POST refresh: cached 为 false', resRefresh.json()?.cached === false);

  const resAll = mockRes();
  await httpManager.handle({ method: 'GET' }, resAll, new URL('http://127.0.0.1/api/quota'));
  check('HTTP GET /api/quota: 状态码 200', resAll.code === 200);
  check('HTTP GET /api/quota: quotas 包含 deepseek', Boolean(resAll.json()?.quotas?.deepseek));
  check('HTTP GET /api/quota: quotas 包含 openrouter', Boolean(resAll.json()?.quotas?.openrouter));
  check('HTTP GET /api/quota: 响应里没有任何 key 原文', !resAll.text().includes(KEY) && !resAll.text().includes(DS_KEY));

  const res405 = mockRes();
  httpManager.handle({ method: 'DELETE' }, res405, new URL('http://127.0.0.1/api/quota/deepseek'));
  check('HTTP 不支持的请求方法: 405', res405.code === 405);

  const res404 = mockRes();
  await httpManager.handle({ method: 'GET' }, res404, new URL('http://127.0.0.1/api/quota/unknown-p'));
  check('HTTP 不存在的 provider: 404', res404.code === 404);

  console.log('=== 11. 前端 DOM：reset / session / provider / 多币种 / 0 与 null ===');
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'), { url: 'http://127.0.0.1/' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.navigator = dom.window.navigator;

  const quotaResponses = [];
  const fetchStub = async (url) => {
    if (String(url).startsWith('/api/quota/')) {
      const body = quotaResponses.shift() ?? { ok: false, error: 'no fixture' };
      return { json: async () => body };
    }
    return { json: async () => ({ ok: false }) };
  };
  global.fetch = fetchStub;
  dom.window.fetch = fetchStub;

  const { S, resetUsageState, beginWorkspaceSwitch, setUsageRenderHook } = await import('../public/state.js');
  const usage = await import('../public/usage.js');
  const $ = (id) => document.getElementById(id);
  const tick = () => new Promise((r) => setTimeout(r, 0));

  check('usage.js 注册了渲染钩子（state.js 不 import usage.js，避免成环）', typeof setUsageRenderHook === 'function');

  // 11.1 0 与 null
  usage.applyStats({ sessionId: 's1', tokens: { input: null, output: 10, cacheRead: 0 }, cost: 0, contextUsage: { tokens: 0, contextWindow: 1000, percent: 0 } });
  check('null 输入显示「—」，真实 0 显示 0：null → —', $('uTok').textContent.startsWith('—'));
  check('null 输入 + 真实输出：— / 10', $('uTok').textContent === '— / 10');
  check('缓存真实 0 显示 0（不是 —）', $('uCache').textContent === '0');
  check('成本真实 0 显示 $0.0000', $('uCost').textContent === '$0.0000');
  check('上下文 0% 显示 0%（不是 —）', $('uPct').textContent === '0%');
  usage.applyStats({ sessionId: 's1', tokens: { input: 0, output: 10 }, cost: null, contextUsage: { tokens: null, contextWindow: null, percent: null } });
  check('真实 0 输入显示 0 / 10', $('uTok').textContent === '0 / 10');
  check('缺失成本显示 —', $('uCost').textContent === '—');
  check('缺失上下文显示 —', $('uPct').textContent === '—');

  // 11.2 workspace reset：JS + DOM 同时归零
  usage.applyStats({ sessionId: 's1', tokens: { input: 100, output: 20, cacheRead: 5 }, cost: 1.5, contextUsage: { tokens: 900, contextWindow: 1000, percent: 90 } });
  S.remoteQuota = { providerId: 'openrouter', status: 'ok', balance: { amount: 20, currency: 'USD' }, balances: null, windows: null, rateLimit: null, resetAt: null, source: 'x', updatedAt: null, message: null };
  S.currentProviderId = 'openrouter';
  S.quotaLoading = false;
  usage.renderUsageState();
  const epochBefore = S.quotaEpoch;
  check('reset 前 DOM 上有真实数字', $('uTok').textContent === '100 / 20' && $('uQuota').textContent === '$20.00');
  S.quotaLoading = true;
  resetUsageState();
  check('resetUsageState: stats 清空', S.stats === null);
  check('resetUsageState: remoteQuota 清空', S.remoteQuota === null);
  check('resetUsageState: quotaLoading = false', S.quotaLoading === false);
  check('resetUsageState: quotaEpoch 自增（旧请求失效）', S.quotaEpoch === epochBefore + 1);
  check('resetUsageState: currentProviderId 清空', S.currentProviderId === null);
  check('resetUsageState: LocalUsage 清空', S.localUsage.inputTokens === null && S.localUsage.sessionId === null && S.localUsage.lastTurn === null);
  check('resetUsageState: DOM 立即归零（不等下一次应答）', $('uTok').textContent === '—' && $('uCache').textContent === '—' && $('uCost').textContent === '—' && $('uQuota').textContent === '—' && $('uPct').textContent === '—');
  check('resetUsageState: 上下文进度条清空', $('uCtxBar').style.width === '0%');
  check('resetUsageState: ctx chip 归零', $('ctxPct').textContent === '—');

  // 11.3 workspace switch 走同一条路径
  usage.applyStats({ sessionId: 's1', tokens: { input: 7, output: 8 }, cost: 0.5, contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } });
  beginWorkspaceSwitch('C:/other');
  check('切项目: DOM 上的旧数字立刻消失', $('uTok').textContent === '—' && $('uCost').textContent === '—');
  S.switching = false;

  // 11.4 session A → B：会话用量立刻清
  usage.applyStats({ sessionId: 'session-A', tokens: { input: 100, output: 5 }, cost: 2, contextUsage: { tokens: 50, contextWindow: 100, percent: 50 } });
  S.localUsage.lastTurn = { inputTokens: 20, outputTokens: 1 };
  check('session A: 有 session 级用量', S.localUsage.inputTokens === 100 && S.stats !== null);
  usage.applyState({ sessionId: 'session-B', model: { id: 'm', provider: 'deepseek' } });
  check('session 切换: stats 立刻为 null', S.stats === null);
  check('session 切换: session totals 立刻清空', S.localUsage.inputTokens === null && S.localUsage.outputTokens === null);
  check('session 切换: lastTurn 立刻清空', S.localUsage.lastTurn === null);
  check('session 切换: sessionId 已更新为 B', S.localUsage.sessionId === 'session-B');
  check('session 切换: DOM 立刻归零', $('uTok').textContent === '—' && $('uCost').textContent === '—');
  await tick();

  // 11.5 provider 无法解析 → 清旧 quota，且旧请求回来也写不回
  quotaResponses.length = 0;
  quotaResponses.push({ ok: true, quota: { providerId: 'openrouter', status: 'ok', balance: { amount: 20, currency: 'USD' }, balances: null, windows: null, rateLimit: null, resetAt: null, source: 'x', updatedAt: null, message: null } });
  await usage.syncRemoteQuota('openrouter');
  check('provider A: 侧栏显示 $20.00', $('uQuota').textContent === '$20.00');
  const epochA = S.quotaEpoch;
  usage.applyState({ sessionId: 'session-B', model: { id: 'unknown-model-xyz', name: 'unknown-model-xyz' } });
  check('provider unknown: remoteQuota 清空', S.remoteQuota === null && S.currentProviderId === null);
  check('provider unknown: quotaLoading = false', S.quotaLoading === false);
  check('provider unknown: DOM 显示 —', $('uQuota').textContent === '—');
  check('provider unknown: epoch 自增（在途应答失效）', S.quotaEpoch > epochA);

  // 11.6 DeepSeek 多币种渲染（原来会 ReferenceError）
  S.currentProviderId = 'deepseek';
  S.quotaLoading = false;
  S.remoteQuota = {
    providerId: 'deepseek', status: 'ok',
    balance: { amount: 110, currency: 'CNY', granted: 10, toppedUp: 100 },
    balances: [
      { amount: 110, currency: 'CNY', granted: 10, toppedUp: 100 },
      { amount: 15, currency: 'USD', granted: null, toppedUp: null },
    ],
    windows: null, rateLimit: null, resetAt: null, source: 'x', updatedAt: null, message: null,
  };
  let renderErr = null;
  try { usage.renderRemoteQuota(); } catch (e) { renderErr = e; }
  check('多币种渲染不抛 ReferenceError', renderErr === null);
  check('多币种侧栏摘要：¥110.00 | $15.00', $('uQuota').textContent === '¥110.00 | $15.00');
  check('多币种不相加（没有 125）', !$('uQuota').textContent.includes('125'));

  let tipErr = null;
  try { usage.openCtxTip(); } catch (e) { tipErr = e; }
  check('多币种 Popover 渲染不抛错', tipErr === null);
  const quotaSection = document.querySelector('.tip-quota-section');
  check('Popover 逐币种展示 CNY 与 USD', quotaSection && quotaSection.textContent.includes('剩余额度 (CNY)') && quotaSection.textContent.includes('剩余额度 (USD)'));
  check('Popover 显示赠送/充值（DOM 构建，无 innerHTML 插值）', quotaSection.textContent.includes('赠送额度 (CNY)') && quotaSection.textContent.includes('充值额度 (CNY)'));
  check('Popover 里没有 HTML 元素被动态注入', quotaSection.querySelectorAll('img,script').length === 0);

  // 11.6b NewAPI：单位未知（currency/unit 都是 null）→ 纯数值，绝不加 $ / ¥ / USD / CNY
  S.currentProviderId = 'my-oneapi';
  S.quotaLoading = false;
  S.remoteQuota = {
    providerId: 'my-oneapi', status: 'ok',
    balance: { amount: 75, currency: null, granted: null, toppedUp: null },
    balances: null,
    windows: { used: 25, limit: 100, remaining: 75, unit: null },
    rateLimit: null, resetAt: null, source: 'https://newapi.example.com/dashboard/billing/subscription',
    updatedAt: null, message: null,
  };
  let naErr = null;
  try { usage.renderRemoteQuota(); } catch (e) { naErr = e; }
  check('NewAPI 未知单位渲染不抛错', naErr === null);
  check('NewAPI 侧栏显示纯数值 75.00', $('uQuota').textContent === '75.00');
  check('NewAPI 侧栏不含货币符号或币种名', !/[$¥]|USD|CNY/.test($('uQuota').textContent));

  let naTipErr = null;
  try { usage.openCtxTip(); } catch (e) { naTipErr = e; }
  check('NewAPI Popover 渲染不抛错', naTipErr === null);
  const naSection = document.querySelector('.tip-quota-section');
  const naText = naSection ? naSection.textContent : '';
  check('NewAPI Popover 显示数值 75 / 25 / 100', naText.includes('75.0000') && naText.includes('25') && naText.includes('100'));
  check('NewAPI Popover 出现「剩余额度 / 已使用 / 总额度」三行', naText.includes('剩余额度') && naText.includes('已使用') && naText.includes('总额度'));
  check('NewAPI Popover 不含 $ 或 ¥', !/[$¥]/.test(naText));
  check('NewAPI Popover 不含 USD / CNY', !/USD|CNY/.test(naText));
  check('NewAPI Popover 明确标注单位未知', naText.includes('单位未知'));
  check('NewAPI Popover 里没有 HTML 元素被动态注入', naSection.querySelectorAll('img,script').length === 0);

  // 11.6c OpenRouter（USD）与 DeepSeek（CNY/USD）不能被打坏
  S.currentProviderId = 'openrouter';
  S.remoteQuota = {
    providerId: 'openrouter', status: 'ok',
    balance: { amount: 8, currency: 'USD', granted: null, toppedUp: null },
    balances: null,
    windows: { used: 2.5, limit: 50, remaining: 8, unit: 'USD' },
    rateLimit: null, resetAt: null, source: 'https://openrouter.ai/api/v1/key', updatedAt: null, message: null,
  };
  usage.renderRemoteQuota();
  check('OpenRouter: 侧栏仍然是 $8.00（货币符号保留）', $('uQuota').textContent === '$8.00');
  usage.openCtxTip();
  const orSection = document.querySelector('.tip-quota-section');
  check('OpenRouter: Popover 仍然是 $ 且有 USD 标注', /[$]/.test(orSection.textContent) && orSection.textContent.includes('USD'));
  check('OpenRouter: remaining 与余额同值时不出现重复的「额度剩余」行', !orSection.textContent.includes('额度剩余'));
  check('OpenRouter: 没有「单位未知」标注', !orSection.textContent.includes('单位未知'));

  S.currentProviderId = 'deepseek';
  S.remoteQuota = {
    providerId: 'deepseek', status: 'ok',
    balance: { amount: 110, currency: 'CNY', granted: null, toppedUp: null },
    balances: [
      { amount: 110, currency: 'CNY', granted: null, toppedUp: null },
      { amount: 15, currency: 'USD', granted: null, toppedUp: null },
    ],
    windows: null, rateLimit: null, resetAt: null, source: 'x', updatedAt: null, message: null,
  };
  usage.renderRemoteQuota();
  check('DeepSeek: 侧栏仍然是 ¥110.00 | $15.00', $('uQuota').textContent === '¥110.00 | $15.00');
  usage.openCtxTip();
  check('DeepSeek: Popover 仍然是 (CNY)/(USD) 逐条', document.querySelector('.tip-quota-section').textContent.includes('剩余额度 (CNY)'));
  check('currencySymbol: USD → $', usage.currencySymbol('USD') === '$');
  check('currencySymbol: CNY → ¥', usage.currencySymbol('CNY') === '¥');
  check('currencySymbol: null/未知 → 空（不加符号）', usage.currencySymbol(null) === '' && usage.currencySymbol(undefined) === '' && usage.currencySymbol('TOKENS') === '');
  check('fmtBalanceShort(null 单位) 只输出数值', usage.fmtBalanceShort(75, null) === '75.00');
  check('fmtCurrency(null 单位) 只输出数值', usage.fmtCurrency(75, null) === '75.0000');
  check('fmtMaybeMoney(null 单位) 只输出数值', usage.fmtMaybeMoney(75, null) === '75.0000');

  // 11.7 恶意币种/金额字符串：只当文本
  S.remoteQuota = {
    ...S.remoteQuota,
    balances: [{ amount: 1, currency: '<img onerror="evil()">', granted: null, toppedUp: null }],
  };
  usage.renderRemoteQuota();
  usage.openCtxTip();
  check('恶意 currency 只当文本（无 img 元素）', document.querySelector('.tip-quota-section').querySelector('img') === null);
  check('恶意 currency 既不成元素、也不进 DOM（未知单位直接不加币种标注）',
    !document.querySelector('.tip-quota-section').outerHTML.includes('onerror')
    && !document.querySelector('.tip-quota-section').outerHTML.includes('&lt;img'));

  // 11.8 null 余额：显示 —，不崩
  S.remoteQuota = { ...S.remoteQuota, balance: { amount: null, currency: 'CNY' }, balances: [{ amount: null, currency: 'CNY' }] };
  check('余额为 null 时侧栏显示 —（不崩）', (() => { usage.renderRemoteQuota(); return $('uQuota').textContent === '—'; })());
  check('fmtMaybeNumber: null → —', usage.fmtMaybeNumber(null) === '—');
  check('fmtMaybeNumber: 0 → 0', usage.fmtMaybeNumber(0) === '0');
  check('fmtMaybeNumber: 1234 → 1.23k（沿用 fmt 的紧凑写法）', usage.fmtMaybeNumber(1234) === '1.23k');
  check('fmtMaybeMoney: null → —', usage.fmtMaybeMoney(null, 'CNY') === '—');

  console.log('=== 12. Live Provider Opt-in 隔离（默认离线） ===');
  check('默认不跑 live（LIVE_PROVIDER_TEST != 1 时不访问公网）', process.env.LIVE_PROVIDER_TEST !== '1');

  console.log('=== 13. 静态守卫：源码不能带乱码 / 旧的 0 兜底 ===');
  const P21_FILES = [
    'server/quota.js',
    'public/usage.js',
    'public/state.js',
    'public/app.js',
    'public/rpc.js',
    'public/projects.js',
    'tests/usage-quota.cjs',
    'docs/usage-quota.md',
  ];
  const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  /* 用码点写，避免这个守卫文件自己带上乱码字符（否则它会扫到自己）。 */
  const GBK_MOJIBAKE = /[\u950b\u9225\u93c2\u935c\u7f02\u9365\u9286\u9428\u7039\u93c3\u9422]|\u950f\u65a4\u62f7/;
  for (const rel of P21_FILES) {
    const src = readSrc(rel);
    check(`${rel}: 不含 U+FFFD 替换字符`, !src.includes('\uFFFD'));
    check(`${rel}: 不含连续 Latin-1 乱码段`, !/[\u00C0-\u00FF]{2,}/.test(src));
    check(`${rel}: 不含 GBK 经典乱码标记`, !GBK_MOJIBAKE.test(src));
  }
  const usageSrc = readSrc('public/usage.js');
  check('usage.js 不再把缺失当 0：fmt(t.input || 0)', !usageSrc.includes('fmt(t.input || 0)'));
  check('usage.js 不再把缺失当 0：ctxPct() ?? 0', !usageSrc.includes('ctxPct() ?? 0'));
  check('usage.js 不再用 innerHTML 插值动态值', !/innerHTML\s*=\s*`/.test(usageSrc));
  check('approval 侧栏只读摘要不含 tooltip 临时变量', !usageSrc.includes('tip ='));

  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error('测试异常失败：', err);
  process.exit(1);
});
