/* `/api/environment*` 的 HTTP 适配层。
 *
 * 业务在 environment-setup / environment-install；这里只做方法、JSON 形状与
 * 状态码映射。所有 /api/* 在 router 里已经先过 Origin + 令牌鉴权；本模块
 * 不接受路径、URL、命令或参数数组 —— 只接受固定的组件 id 与 `planId`。
 */
import { json, readBody } from './http-utils.js';

const MAX_BODY = 16 * 1024;

async function readJson(req) {
  const text = await readBody(req, MAX_BODY);
  if (!text) return {};
  const value = JSON.parse(text);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function methodNotAllowed(res) {
  return json(res, 405, { ok: false, code: 'method-not-allowed', error: 'Method not allowed' });
}

/**
 * @param setup       `createEnvironmentSetup()`
 * @param install     `createEnvironmentInstall()`
 * @param onPiPathChanged  Pi 路径改变后清 identity 缓存（server.js 注入）
 */
export function createEnvironmentRoutes({ setup, install = null, onPiPathChanged = null, now = () => new Date() } = {}) {
  if (!setup) throw new Error('environment routes require setup');

  async function report(res, force = false) {
    try {
      return json(res, 200, { ok: true, environment: await setup.check({ force }) });
    } catch {
      return json(res, 500, { ok: false, code: 'detection-failed', error: '环境检测没有完成，请重试。' });
    }
  }

  async function handle(req, res, url) {
    const path = url.pathname;
    if (path === '/api/environment') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return report(res, url.searchParams.get('recheck') === '1');
    }

    if (path === '/api/environment/recheck') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      return report(res, true);
    }

    if (path === '/api/environment/install') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      if (!install) return json(res, 503, { ok: false, code: 'not-wired', error: '环境安装模块未装配。' });
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json(res, 400, { ok: false, code: 'bad-json', error: '请求不是合法 JSON。' });
      }
      let result;
      try {
        result = await install.start({
          planId: typeof body.planId === 'string' ? body.planId : null,
          components: Array.isArray(body.components) ? body.components : null,
          consent: body.consent === true,
        });
      } catch {
        return json(res, 500, { ok: false, code: 'install-start-failed', error: '安装任务没有启动，请重试。' });
      }
      const payload = { ok: result.ok, job: result.job || null };
      if (!result.ok) {
        payload.code = result.code;
        payload.error = result.error;
      }
      if (result.report) payload.environment = result.report;
      return json(res, result.status || (result.ok ? 202 : 400), payload);
    }

    if (path === '/api/environment/job') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      if (!install) return json(res, 503, { ok: false, code: 'not-wired', error: '环境安装模块未装配。' });
      const id = url.searchParams.get('id');
      const job = install.getJob(id || null);
      if (!job) return json(res, 404, { ok: false, code: 'not-found', error: '安装任务不存在。' });
      return json(res, 200, { ok: true, job });
    }

    if (path === '/api/environment/cancel') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      if (!install) return json(res, 503, { ok: false, code: 'not-wired', error: '环境安装模块未装配。' });
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json(res, 400, { ok: false, code: 'bad-json', error: '请求不是合法 JSON。' });
      }
      const result = install.cancel(typeof body.id === 'string' ? body.id : null);
      return json(res, result.status || (result.ok ? 200 : 404), {
        ok: result.ok, code: result.code, error: result.error, job: result.job || null,
      });
    }

    if (path === '/api/environment/pi-path') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json(res, 400, { ok: false, code: 'bad-json', error: '请求不是合法 JSON。' });
      }
      if (setup.effectivePiBinSource && setup.effectivePiBinSource() === 'env') {
        return json(res, 409, { ok: false, code: 'env-locked', error: '已通过环境变量 PI_BIN 指定 Pi，向导不会覆盖它。' });
      }
      const value = body.path === null || body.path === '' ? null : body.path;
      const result = setup.setPiBinOverride(value);
      if (!result.ok) return json(res, 400, { ok: false, code: result.code || 'bad-path', error: result.error || 'Pi 路径不合法。' });
      try { if (typeof onPiPathChanged === 'function') onPiPathChanged(); } catch { /* 下一次检测会重新解析 */ }
      return report(res, true);
    }

    if (path === '/api/environment/ack') {
      if (req.method !== 'POST') return methodNotAllowed(res);
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json(res, 400, { ok: false, code: 'bad-json', error: '请求不是合法 JSON。' });
      }
      let current;
      try {
        current = await setup.check({ force: false });
      } catch {
        return json(res, 500, { ok: false, code: 'detection-failed', error: '环境检测没有完成，请重试。' });
      }
      const completed = body.completed === true;
      const skippedOptional = body.skippedOptional === true;
      if (!completed && !skippedOptional) {
        return json(res, 400, { ok: false, code: 'invalid-ack', error: '没有需要记录的向导状态。' });
      }
      if (!current.requiredReady) {
        return json(res, 409, { ok: false, code: 'not-ready', error: '必需依赖尚未就绪，不能完成向导。', environment: current });
      }
      const stamp = now().toISOString();
      setup.recordSetup({
        completedAt: stamp,
        lastRequiredReady: current.requiredReady,
        skippedOptionalAt: skippedOptional ? stamp : undefined,
      });
      return report(res, true);
    }

    return json(res, 404, { ok: false, code: 'not-found', error: 'Not found' });
  }

  return { handle };
}
