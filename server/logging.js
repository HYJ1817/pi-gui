/* 本地日志的 HTTP 入口。
 *
 * 这里只做三件事：
 *   1. 把后端/Renderer 的结构化事件交给 lib/log-core.cjs；
 *   2. 给设置、查看、清理、预览和导出提供**白名单参数**的本地接口；
 *   3. 对所有失败返回固定错误码，不把路径、异常 message 或底层输出带出去。
 *
 * 所有路由在 server/router.js 里都排在 requireLegacyScope 之前 ——
 * 日志是应用级能力，不应因为打开了并行会话就要求经典聊天 owner。
 * 但认证没有放松：router 仍先执行 auth.denyRequest（Origin + PI_GUI_TOKEN）。
 */
import path from 'node:path';
import os from 'node:os';
import logCoreModule from '../lib/log-core.cjs';
import { EVENT_CATALOG, LEVELS, SOURCES } from '../lib/log-contract.cjs';
import { json, readBody } from './http-utils.js';

const { createLogCore, scrubShortText } = logCoreModule;
const MAX_CLIENT_BODY = 32 * 1024;
const MAX_CLIENT_EVENTS = 20;
const MAX_SETTINGS_BODY = 4 * 1024;
const MAX_DESCRIPTION = 2000;
const CLIENT_EVENTS_PER_SECOND = 60;

function defaultLogDir(env = process.env) {
  if (env.PI_GUI_LOG_DIR) return path.resolve(env.PI_GUI_LOG_DIR);
  if (env.PI_GUI_DATA) return path.join(path.resolve(env.PI_GUI_DATA), 'logs');
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'pi-gui', 'logs');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Logs', 'pi-gui');
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'pi-gui', 'logs');
}

function intParam(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function queryList(value, allowed) {
  if (typeof value !== 'string' || !value) return null;
  const items = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length) return null;
  const set = new Set(items.filter((item) => allowed.has(item)));
  return set.size ? set : new Set(['__none__']);
}

function parseJSON(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/**
 * @param {object} options
 * @param {string} options.dir 固定日志目录；不来自请求。
 * @param {string} options.version 应用版本（唯一真相由 server.js 注入）。
 * @param {string} options.appRoot 自身源码根；只用于把堆栈帧收敛为相对模块。
 * @param {() => object|null} options.getDiagnostics 惰性诊断快照。
 */
export function createLogService({
  dir = defaultLogDir(),
  version = '0.0.0',
  appRoot = process.cwd(),
  getDiagnostics = () => null,
  env = process.env,
  now = Date.now,
  fsApi = undefined,
} = {}) {
  const core = createLogCore({ dir, role: 'app', version, appRoot, now, fsApi });
  let clientWindowStart = now();
  let clientWindowCount = 0;
  let clientDropped = 0;

  function environment() {
    return {
      appVersion: version,
      electronVersion: process.versions && process.versions.electron ? process.versions.electron : null,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    };
  }

  function diagnosticsSafe() {
    try {
      const value = getDiagnostics();
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  }

  function clientBudget() {
    const nowMs = now();
    if (!Number.isFinite(clientWindowStart) || nowMs - clientWindowStart >= 1000) {
      clientWindowStart = nowMs;
      clientWindowCount = 0;
    }
    return Math.max(0, CLIENT_EVENTS_PER_SECOND - clientWindowCount);
  }

  function acceptClientEvents(body) {
    if (!body || !Array.isArray(body.events) || !body.events.length || body.events.length > MAX_CLIENT_EVENTS) {
      return { ok: false, code: 'invalid_events' };
    }
    if (!core.isEnabled()) return { ok: true, accepted: 0, disabled: true };
    let accepted = 0;
    for (const raw of body.events) {
      if (!budgetAvailable()) { clientDropped += 1; continue; }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const eventName = typeof raw.event === 'string' ? raw.event : '';
      const def = EVENT_CATALOG[eventName];
      if (!def || def.client !== true) continue;
      const acceptedEvent = core.event('renderer', eventName, raw.details, {
        /* Renderer 不能定义稳定错误码；它只观察，代码由后端/事件目录决定。
         * 这避免把任意字符串当成“错误码”混进来。 */
        correlationId: raw.correlationId,
        durationMs: raw.durationMs,
        process: 'renderer',
      });
      if (acceptedEvent) accepted += 1;
    }
    return { ok: true, accepted };
  }

  function budgetAvailable() {
    if (clientBudget() <= 0) return false;
    clientWindowCount += 1;
    return true;
  }

  async function handle(req, res, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/logs')) return false;
    if (req.method === 'GET' && pathname === '/api/logs/status') {
      try { core.flushSync(); } catch { /* status still useful */ }
      return json(res, 200, { ok: true, status: { ...core.status(), clientDropped } });
    }
    if (req.method === 'GET' && pathname === '/api/logs/entries') {
      try { core.flushSync(); } catch { /* read what exists */ }
      const params = url.searchParams;
      const levels = queryList(params.get('level'), new Set(LEVELS));
      const sources = queryList(params.get('source'), SOURCES);
      const result = core.readEntries({
        limit: intParam(params.get('limit'), 1, 200, 100),
        cursor: params.get('cursor') || params.get('before'),
        levels,
        sources,
        q: params.get('q') || '',
        windowMinutes: intParam(params.get('windowMinutes'), 1, 1440, null),
      });
      return json(res, 200, result);
    }
    if (req.method === 'POST' && pathname === '/api/logs/settings') {
      const text = await readBody(req, MAX_SETTINGS_BODY).catch(() => null);
      const body = text ? parseJSON(text) : null;
      if (!body) return json(res, 400, { ok: false, code: 'invalid_body' });
      const patch = {};
      for (const key of ['enabled', 'mode', 'retentionDays', 'maxTotalMB']) {
        if (Object.hasOwn(body, key)) patch[key] = body[key];
      }
      if (!Object.keys(patch).length) return json(res, 400, { ok: false, code: 'invalid_settings' });
      const result = core.updateSettings(patch);
      return json(res, result.ok ? 200 : 409, result);
    }
    if (req.method === 'POST' && pathname === '/api/logs/clear') {
      const text = await readBody(req, MAX_SETTINGS_BODY).catch(() => null);
      const body = text ? parseJSON(text) : null;
      if (!body || body.confirm !== true) return json(res, 400, { ok: false, code: 'confirmation_required' });
      return json(res, 200, core.clearLogs());
    }
    if (req.method === 'POST' && pathname === '/api/logs/export/preview') {
      const text = await readBody(req, MAX_SETTINGS_BODY).catch(() => null);
      const body = text ? parseJSON(text) : {};
      if (!body) return json(res, 400, { ok: false, code: 'invalid_body' });
      const windowMinutes = intParam(body.windowMinutes, 1, 1440, 30);
      try { core.flushSync(); } catch { /* preview what exists */ }
      const result = core.previewExport({ windowMinutes });
      if (core.isEnabled()) {
        core.event('logs', 'logs.export_previewed', {
          windowMinutes, entryCount: result.entryCount, errorCount: result.errorCount,
          fileCount: result.files.length, truncated: result.truncated,
        });
      }
      return json(res, 200, result);
    }
    if (req.method === 'POST' && pathname === '/api/logs/export') {
      const text = await readBody(req, MAX_SETTINGS_BODY * 2).catch(() => null);
      const body = text ? parseJSON(text) : null;
      if (!body || body.confirm !== true) return json(res, 400, { ok: false, code: 'confirmation_required' });
      const windowMinutes = intParam(body.windowMinutes, 1, 1440, 30);
      const description = typeof body.description === 'string' ? scrubShortText(body.description, MAX_DESCRIPTION) : '';
      const repro = typeof body.repro === 'string' ? scrubShortText(body.repro, MAX_DESCRIPTION) : '';
      try { core.flushSync(); } catch { /* export what exists */ }
      const result = core.buildExport({
        windowMinutes,
        description,
        repro,
        diagnostics: diagnosticsSafe(),
        environment: environment(),
      });
      if (!result.ok) return json(res, 503, { ok: false, code: result.code, reason: result.reason });
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': result.buffer.length,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(result.buffer);
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/logs/events') {
      const text = await readBody(req, MAX_CLIENT_BODY).catch(() => null);
      const body = text ? parseJSON(text) : null;
      if (!body) return json(res, 400, { ok: false, code: 'invalid_body' });
      const result = acceptClientEvents(body);
      return json(res, result.ok ? 200 : 400, result);
    }
    return json(res, 404, { ok: false, code: 'not_found' });
  }

  /* 未捕获异常只记录安全错误名与堆栈帧；不使用 uncaughtException 处理器，
   * 因此不会改变 Node 的退出语义。 */
  function installCrashMonitor() {
    process.on('uncaughtExceptionMonitor', (error) => {
      try {
        core.crash('app', 'app.uncaught_exception', error, { role: 'backend', reason: 'uncaught' });
        core.flushSync();
      } catch { /* 日志不能覆盖原始崩溃 */ }
    });
  }

  return {
    core,
    dir: core.dir,
    handle,
    log: (source, event, details, meta) => core.event(source, event, details, meta),
    crash: (source, event, error, details, meta) => core.crash(source, event, error, details, meta),
    status: () => ({ ...core.status(), clientDropped }),
    dispose: () => core.close({ reason: 'shutdown' }),
    installCrashMonitor,
  };
}
