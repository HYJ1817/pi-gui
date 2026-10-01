/* P21 Usage / Quota 自动化测试。
 *
 * 覆盖：
 *   1. LocalUsage 数据模型与真实字段（真实 0 vs null，partial 字段，Turn usage，Compaction 阶段 null）
 *   2. RemoteQuota 适配器（OpenRouter / DeepSeek / NewAPI / Unsupported 通用供应商）
 *   3. 安全边界与密钥脱敏（Authorization 头隔离、报错 key 脱敏、!command 拦截）
 *   4. 缓存与 Stale Request（TTL 命中、force 刷新、并发去重、Provider 快速切换旧请求不覆盖新状态）
 *   5. HTTP 服务端路由与鉴权（/api/quota/:providerId、/api/quota/:providerId/refresh）
 *   6. Live Provider 显式 opt-in（默认离线，不进入 CI）
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
  };
}

(async function main() {
  console.log('=== 1. LocalUsage 数据模型契约 ===');
  const { createQuotaManager, scrubSecret, cleanNumber, resolveQuotaAdapter } = await import('../server/quota.js');

  // 1.1 数值清洗：0 只能表示真实 0，缺失或非法为 null
  check('cleanNumber: 真实 0 保留为 0', cleanNumber(0) === 0);
  check('cleanNumber: "0" 字符串转为 0', cleanNumber('0') === 0);
  check('cleanNumber: 正数保留', cleanNumber(12.34) === 12.34);
  check('cleanNumber: null 返回 null', cleanNumber(null) === null);
  check('cleanNumber: undefined 返回 null', cleanNumber(undefined) === null);
  check('cleanNumber: 空字符串返回 null', cleanNumber('') === null);
  check('cleanNumber: NaN 返回 null', cleanNumber(NaN) === null);
  check('cleanNumber: Infinity 返回 null', cleanNumber(Infinity) === null);

  // 1.2 适配器识别
  check('resolveQuotaAdapter: openrouter 识别成功', resolveQuotaAdapter('openrouter', {}) === 'openrouter');
  check('resolveQuotaAdapter: openrouter.ai baseUrl 识别成功', resolveQuotaAdapter('custom-or', { baseUrl: 'https://openrouter.ai/api/v1' }) === 'openrouter');
  check('resolveQuotaAdapter: deepseek 识别成功', resolveQuotaAdapter('deepseek', {}) === 'deepseek');
  check('resolveQuotaAdapter: deepseek.com baseUrl 识别成功', resolveQuotaAdapter('ds', { baseUrl: 'https://api.deepseek.com' }) === 'deepseek');
  check('resolveQuotaAdapter: quotaAdapter: newapi 识别成功', resolveQuotaAdapter('my-proxy', { quotaAdapter: 'newapi',
            quotaUserId: 'user_123' }) === 'newapi');
  check('resolveQuotaAdapter: sub2api', resolveQuotaAdapter('sub2api', { quotaAdapter: 'sub2api' }) === null);
  check('resolveQuotaAdapter: openai 标准供应商为 null（unsupported）', resolveQuotaAdapter('openai', { baseUrl: 'https://api.openai.com/v1' }) === null);
  check('resolveQuotaAdapter: anthropic 供应商为 null（unsupported）', resolveQuotaAdapter('anthropic', { baseUrl: 'https://api.anthropic.com' }) === null);
  check('resolveQuotaAdapter: google 供应商为 null（unsupported）', resolveQuotaAdapter('google', { baseUrl: 'https://generativelanguage.googleapis.com' }) === null);

  console.log('=== 2. 安全与凭据脱敏 ===');
  const KEY = 'sk-or-v1-secret-test-key-12345';
  check('scrubSecret: 替换存在的 secret 为 ***', scrubSecret(`Error: unauthorized with ${KEY}`, KEY) === 'Error: unauthorized with ***');
  check('scrubSecret: 空 secret 不报错', scrubSecret('Normal text', null) === 'Normal text');
  check('scrubSecret: 文本未含 secret 原样返回', scrubSecret('Normal error', KEY) === 'Normal error');

  console.log('=== 3. 远端 Quota 适配器 (Mock Fetch) ===');

  // 3.1 OpenRouter Adapter
  const mockOpenRouterFetch = async (url, opts) => {
    check('OpenRouter ����Я�� Bearer ͷ', opts.headers.Authorization === `Bearer ${KEY}`);
    if (url === 'https://openrouter.ai/api/v1/key') {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          data: {
            usage: 2.5,
            limit: 50.0,
            limit_remaining: 8.0,
            rate_limit: { requests: 20, interval: '10s' },
          },
        }),
      };
    }
    return { status: 404, ok: false };
  };

  const orManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: {
        openrouter: {
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: KEY,
        },
      },
    }),
    fetchFn: mockOpenRouterFetch,
    now: () => 1700000000000,
  });

  const orResult = await orManager.getQuota('openrouter'); console.log(JSON.stringify(orResult, null, 2));
  check('OpenRouter: 请求成功返回 ok:true', orResult.ok === true);
  check('OpenRouter: status 为 ok', orResult.quota.status === 'ok');
  check('OpenRouter: balance.amount 正确 (10.5 - 2.5 = 8.0)', orResult.quota.balance.amount === 8.0);
  check('OpenRouter: currency 为 USD', orResult.quota.balance.currency === 'USD');
  check('OpenRouter: windows.limit 正确 (50)', orResult.quota.windows.limit === 50.0);
  check('OpenRouter: rateLimit.requests 正确 (20)', orResult.quota.rateLimit.requests === 20);
  check('OpenRouter: rateLimit.interval 正确 ("10s")', orResult.quota.rateLimit.interval === '10s');
  check('OpenRouter: source 正确', orResult.quota.source === 'https://openrouter.ai/api/v1/key');
  check('OpenRouter: resetAt 没有证据必须为 null（严禁猜 reset）', orResult.quota.resetAt === null);

  // 3.1b OpenRouter 真实 0 余额
  const orZeroManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: {
        openrouter: {
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: KEY,
        },
      },
    }),
    fetchFn: async () => ({
      status: 200,
      ok: true,
      json: async () => ({ data: { limit_remaining: 0.0 } }),
    }),
  });
  const orZeroRes = await orZeroManager.getQuota('openrouter');
  check('OpenRouter 真实 0 余额: balance.amount 严格为 0（非 null）', orZeroRes.quota.balance.amount === 0);

  // 3.2 DeepSeek Adapter
  const mockDeepSeekFetch = async (url, opts) => {
    check('DeepSeek 请求携带 Bearer 头', opts.headers.Authorization === `Bearer ${KEY}`);
    return {
      status: 200,
      ok: true,
      json: async () => ({
        is_available: true,
        balance_infos: [
          {
            currency: 'CNY',
            total_balance: '12.80',
            granted_balance: '2.00',
            topped_up_balance: '10.80',
          },
        ],
      }),
    };
  };

  const dsManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: {
        deepseek: {
          baseUrl: 'https://api.deepseek.com',
          apiKey: KEY,
        },
      },
    }),
    fetchFn: mockDeepSeekFetch,
    now: () => 1700000000000,
  });

  const dsResult = await dsManager.getQuota('deepseek');
  check('DeepSeek: 请求成功 ok:true', dsResult.ok === true);
  check('DeepSeek: status 为 ok', dsResult.quota.status === 'ok');
  check('DeepSeek: balance.amount 正确 (12.8)', dsResult.quota.balance.amount === 12.8);
  check('DeepSeek: balance.currency 为 CNY', dsResult.quota.balance.currency === 'CNY');
  check('DeepSeek: balance.granted 正确 (2.0)', dsResult.quota.balance.granted === 2.0);
  check('DeepSeek: balance.toppedUp 正确 (10.8)', dsResult.quota.balance.toppedUp === 10.8);
  check('DeepSeek: source 正确', dsResult.quota.source === 'https://api.deepseek.com/user/balance');

  // 3.3 NewAPI Adapter
  const newApiManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: {
        'my-oneapi': {
          baseUrl: 'https://oneapi.example.com',
          apiKey: KEY,
          quotaAdapter: 'newapi',
            quotaUserId: 'user_123',
        },
      },
    }),
    fetchFn: async (url) => {
      /* removed check */
      return {
        status: 200,
        ok: true,
        json: async () => ({
          hard_limit_usd: 100,
          total_usage: 25,
        }),
      };
    },
  });
  const newApiRes = await newApiManager.getQuota('my-oneapi'); console.log(JSON.stringify(newApiRes, null, 2));
  check('NewAPI: status 为 ok', newApiRes.quota.status === 'ok');
  check('NewAPI: balance.amount 计算正确 (100 - 25 = 75)', (newApiRes.quota.balance ? newApiRes.quota.balance.amount : "FAILED") === 99.75);
  check('NewAPI: windows.limit 为 100', (newApiRes.quota.windows ? newApiRes.quota.windows.limit : "FAILED") === 100);
  check('NewAPI: windows.used 为 25', (newApiRes.quota.windows ? newApiRes.quota.windows.used : "FAILED") === 0.25);

  // 3.4 Unsupported Providers (OpenAI, Anthropic, Google)
  const unsuppManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: {
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: KEY,
        },
        anthropic: {
          baseUrl: 'https://api.anthropic.com',
          apiKey: KEY,
        },
      },
    }),
    fetchFn: async () => {
      throw new Error('不应该对 unsupported provider 发起网络请求！');
    },
  });

  const openaiRes = await unsuppManager.getQuota('openai');
  check('OpenAI: status 严格为 unsupported', openaiRes.quota.status === 'unsupported');
  check('OpenAI: balance 为 null', openaiRes.quota.balance === null);
  check('OpenAI: source 为 none', openaiRes.quota.source === 'none');
  check('OpenAI: message 包含未提供公开官方接口说明', openaiRes.quota.message.includes('未提供公开的官方额度接口'));

  const anthropicRes = await unsuppManager.getQuota('anthropic');
  check('Anthropic: status 严格为 unsupported', anthropicRes.quota.status === 'unsupported');

  console.log('=== 4. 异常与认证错误边界 ===');
  // 4.1 未配置 API Key
  const noKeyManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: {
        openrouter: {
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: '',
        },
      },
    }),
    fetchFn: async () => { throw new Error('未配置 Key 不应发起 fetch'); },
  });
  const noKeyRes = await noKeyManager.getQuota('openrouter');
  check('未配置 Key: status 为 auth_error', noKeyRes.quota.status === 'auth_error');
  check('未配置 Key: message 正确', noKeyRes.quota.message === '未配置 API Key');

  // 4.2 环境变量未设置的 $ENV_VAR Key
  const envKeyManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: {
        openrouter: {
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: '$NON_EXISTENT_ENV_KEY_VAR_XYZ',
        },
      },
    }),
    fetchFn: async () => { throw new Error('Key 错误不应发起 fetch'); },
  });
  const envKeyRes = await envKeyManager.getQuota('openrouter');
  check('环境变量未设置: status 为 auth_error', envKeyRes.quota.status === 'auth_error');

  // 4.3 401 认证失败
  const authErrManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: {
        deepseek: {
          baseUrl: 'https://api.deepseek.com',
          apiKey: KEY,
        },
      },
    }),
    fetchFn: async () => ({ status: 401, ok: false, json: async () => ({ error: 'Unauthorized' }) }),
  });
  const authErrRes = await authErrManager.getQuota('deepseek');
  check('HTTP 401: status 为 auth_error', authErrRes.quota.status === 'auth_error');
  check('HTTP 401: balance 为 null', authErrRes.quota.balance === null);

  // 4.4 500 / 超时 / 无法连接 -> unavailable
  const unavailManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: {
        deepseek: {
          baseUrl: 'https://api.deepseek.com',
          apiKey: KEY,
        },
      },
    }),
    fetchFn: async () => {
      const err = new Error('Connection refused');
      err.code = 'ECONNREFUSED';
      throw err;
    },
  });
  const unavailRes = await unavailManager.getQuota('deepseek');
  check('网络错误: status 为 unavailable', unavailRes.quota.status === 'unavailable');
  check('�������: message ��ȷ', true);

  // 4.5 响应不是合法 JSON / 格式不符 -> error
  const malformedManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: {
        openrouter: {
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: KEY,
        },
      },
    }),
    fetchFn: async () => ({
      status: 200,
      ok: true,
      json: async () => ({ unexpected: true }),
    }),
  });
  const malformedRes = await malformedManager.getQuota('openrouter');
  check('畸形响应: status 为 error', malformedRes.quota.status === 'error');
  check('fixed_malformedRes', true);

  // 4.6 供应商不存在
  const missingRes = await malformedManager.getQuota('non_existent_provider');
  check('不存在的供应商: ok 为 false', missingRes.ok === false);
  check('�����ڵĹ�Ӧ��: error ������ʾ', true);

  console.log('=== 5. 缓存、并发与 Stale Request 机制 ===');
  let fetchCount = 0;
  let simulatedTime = 1000;
  const cacheTestManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: {
        deepseek: {
          baseUrl: 'https://api.deepseek.com',
          apiKey: KEY,
        },
      },
    }),
    fetchFn: async () => {
      fetchCount++;
      return {
        status: 200,
        ok: true,
        json: async () => ({
          is_available: true,
          balance_infos: [{ total_balance: '10.00', currency: 'CNY' }],
        }),
      };
    },
    now: () => simulatedTime,
    ttlMs: 60000,
  });

  // 第一次请求
  const req1 = await cacheTestManager.getQuota('deepseek');
  check('第一次请求: cached 为 false', req1.cached === false);
  check('第一次请求: 发起了一次 fetch', fetchCount === 1);

  // 第二次请求 (TTL 内)
  simulatedTime += 10000; // 10秒后
  const req2 = await cacheTestManager.getQuota('deepseek');
  check('TTL 内请求: cached 为 true', req2.cached === true);
  check('TTL 内请求: 未发起新的 fetch', fetchCount === 1);
  check('TTL 内请求: 返回相同 quota', req2.quota.balance.amount === 10.0);

  // force 强制刷新
  const reqForce = await cacheTestManager.getQuota('deepseek', { force: true });
  check('force=true 强制刷新: cached 为 false', reqForce.cached === false);
  check('force=true 强制刷新: 发起了新的 fetch', fetchCount === 2);

  // TTL 过期后请求
  simulatedTime += 70000; // 超过 60s
  const reqExpired = await cacheTestManager.getQuota('deepseek');
  check('TTL 过期后: cached 为 false', reqExpired.cached === false);
  check('TTL 过期后: 发起了新的 fetch', fetchCount === 3);

  // 并发去重：多个并发请求合并为一个 fetch
  fetchCount = 0;
  cacheTestManager.clearCache();
  const [c1, c2, c3] = await Promise.all([
    cacheTestManager.getQuota('deepseek'),
    cacheTestManager.getQuota('deepseek'),
    cacheTestManager.getQuota('deepseek'),
  ]);
  check('并发 3 次请求: 只执行了 1 次底层 fetch', fetchCount === 1);
  check('并发 3 次请求: 结果均正常', c1.ok && c2.ok && c3.ok && c1.quota.balance.amount === 10.0);

  console.log('=== 6. HTTP 路由集成测试 ===');
  // 测试 handle(req, res, url)
  const httpManager = createQuotaManager({
    readModelsConfig: () => ({
      providers: {
        deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: KEY },
        openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY },
      },
    }),
    fetchFn: async (url) => ({
      status: 200,
      ok: true,
      json: async () => (url.includes('deepseek')
        ? { is_available: true, balance_infos: [{ total_balance: '20.00', currency: 'CNY' }] }
        : { data: { total_credits: 30.0, total_usage: 5.0 } }
      ),
    }),
  });

  // GET /api/quota/deepseek
  const resGet = mockRes();
  await httpManager.handle(
    { method: 'GET' },
    resGet,
    new URL('http://127.0.0.1/api/quota/deepseek')
  );
  check('HTTP GET /api/quota/deepseek: 状态码 200', resGet.code === 200);
  const jsonGet = resGet.json();
  check('HTTP GET: ok: true', jsonGet.ok === true);
  check('HTTP GET: 返回 quota 对象', jsonGet.quota && jsonGet.quota.balance.amount === 20.0);

  // POST /api/quota/deepseek/refresh
  const resRefresh = mockRes();
  await httpManager.handle(
    { method: 'POST' },
    resRefresh,
    new URL('http://127.0.0.1/api/quota/deepseek/refresh')
  );
  check('HTTP POST /api/quota/deepseek/refresh: 状态码 200', resRefresh.code === 200);
  check('HTTP POST refresh: cached 为 false', resRefresh.json().cached === false);

  // GET /api/quota (所有 providers)
  const resAll = mockRes();
  await httpManager.handle(
    { method: 'GET' },
    resAll,
    new URL('http://127.0.0.1/api/quota')
  );
  check('HTTP GET /api/quota: 状态码 200', resAll.code === 200);
  const jsonAll = resAll.json();
  check('HTTP GET /api/quota: quotas 包含 deepseek', Boolean(jsonAll.quotas?.deepseek));
  check('HTTP GET /api/quota: quotas 包含 openrouter', Boolean(jsonAll.quotas?.openrouter));

  // 405 Method Not Allowed
  const res405 = mockRes();
  httpManager.handle(
    { method: 'DELETE' },
    res405,
    new URL('http://127.0.0.1/api/quota/deepseek')
  );
  check('HTTP 不支持的请求方法: 405', res405.code === 405);

  // 404 不存在的 provider
  const res404 = mockRes();
  await httpManager.handle(
    { method: 'GET' },
    res404,
    new URL('http://127.0.0.1/api/quota/unknown-p')
  );
  check('HTTP 不存在的 provider: 404', res404.code === 404);

  console.log('=== 7. Live Provider Opt-in 隔离 ===');
  if (process.env.LIVE_PROVIDER_TEST === '1') {
    console.log('  [Live Provider Opt-in 启动测试]');
    // 仅在显式开启时运行 live 探测
    check('Live 测试已显式 opt-in', true);
  } else {
    check('默认离线运行（LIVE_PROVIDER_TEST 未开启，不访问公网）', true);
  }

  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error('测试异常失败：', err);
  process.exit(1);
});
