/* 结构化诊断日志的**唯一契约**。
 *
 * 这不是一个通用 logger：调用方不能传任意事件名、字段或正文。
 * 事件目录是白名单，字段值再按类型收敛。原因很直接 ——
 * 日志会被贴进 issue / 发给开发 Agent，任何“随手多传一个 message”
 * 都可能把聊天正文或凭据带出去。
 *
 * 设计原则：
 *   1. 稳定事件代码比界面中文文案可靠（文案会改，代码不会）；
 *   2. 标准模式只收 INFO 及以上、基础字段；详细模式只**多收声明过的**
 *      DEBUG 字段，不扩大内容类别；
 *   3. 任何未声明字段直接丢弃，不序列化、不“尽量保留”；
 *   4. 堆栈只保留应用自身相对模块文件与行列，绝不保留异常 message。
 */
'use strict';

const LEVELS = Object.freeze(['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']);
const LEVEL_RANK = Object.freeze({ DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, FATAL: 50 });
const SOURCES = Object.freeze(new Set([
  'app', 'electron', 'pi-bridge', 'runtime', 'renderer', 'browser', 'ui', 'network', 'logs', 'settings',
]));
const ROLES = Object.freeze(new Set(['backend', 'main', 'renderer']));

/* 事件目录。`keys` 是标准模式允许的字段，`verboseKeys` 是详细模式额外允许的字段。
 * `client` 为 true 的事件才允许 Renderer 经本地 API 提交。
 * 注意：这里没有 message / stack / url / path / args / content / stdout 等字段 ——
 * 它们根本不在白名单里。 */
const EVENT_CATALOG = Object.freeze({
  /* 应用生命周期 */
  'app.start': { level: 'INFO', keys: ['role', 'version', 'platform', 'arch', 'nodeVersion', 'electronVersion', 'mode'] },
  'app.ready': { level: 'INFO', keys: ['role', 'durationMs', 'windowCount', 'recovered'] },
  'app.exit': { level: 'INFO', keys: ['role', 'reason', 'durationMs'] },
  'app.previous_unclean_exit': { level: 'WARN', keys: ['role', 'uptimeMs'] },
  'app.crash': { level: 'FATAL', keys: ['role', 'reason', 'errorName', 'frames'] },
  'app.uncaught_exception': { level: 'FATAL', keys: ['role', 'reason', 'errorName', 'frames'], client: true },
  'app.unhandled_rejection': { level: 'ERROR', keys: ['role', 'reason', 'errorName', 'frames'], client: true },

  /* 日志系统自身 */
  'logs.settings_changed': { level: 'INFO', keys: ['enabled', 'mode', 'retentionDays', 'maxTotalMB', 'clientCount'] },
  'logs.settings_failed': { level: 'WARN', keys: ['reason'] },
  'logs.write_failed': { level: 'WARN', keys: ['reason'] },
  'logs.degraded': { level: 'WARN', keys: ['reason'] },
  'logs.rotation': { level: 'DEBUG', keys: ['fileCount', 'bytes'] },
  'logs.pruned': { level: 'DEBUG', keys: ['fileCount', 'bytes'] },
  'logs.exported': { level: 'INFO', keys: ['windowMinutes', 'entryCount', 'errorCount', 'fileCount', 'bytes', 'truncated'] },
  'logs.export_failed': { level: 'ERROR', keys: ['reason'] },
  'logs.export_previewed': { level: 'DEBUG', keys: ['windowMinutes', 'entryCount', 'errorCount', 'fileCount', 'truncated'] },
  'logs.cleared': { level: 'INFO', keys: ['fileCount', 'bytes'] },
  'logs.client_event_rejected': { level: 'DEBUG', keys: ['count', 'reason'] },
  /* Renderer 在断线恢复后上报本地上报队列的降级/丢弃计数；不含任何请求正文。 */
  'logs.client_degraded': { level: 'WARN', keys: ['reason', 'count', 'failures'], client: true },

  /* Electron 主进程 / 后端进程 */
  'electron.backend_spawn': { level: 'INFO', keys: ['reused', 'phase'] },
  'electron.backend_start_failed': { level: 'ERROR', keys: ['phase', 'code'] },
  'electron.backend_exited': { level: 'INFO', keys: ['expected', 'exitCode', 'durationMs'] },
  'electron.backend_crashed': { level: 'FATAL', keys: ['exitCode', 'signal', 'durationMs'] },
  'electron.window_create_failed': { level: 'ERROR', keys: ['errorName', 'frames'] },
  'electron.renderer_gone': { level: 'FATAL', keys: ['reason', 'exitCode'] },
  'electron.renderer_unresponsive': { level: 'WARN', keys: ['durationMs'] },
  'electron.renderer_responsive': { level: 'INFO', keys: [] },
  'electron.window_created': { level: 'INFO', keys: ['windowCount', 'durationMs'] },
  'electron.page_load_failed': { level: 'WARN', keys: ['errorCode', 'isMainFrame'] },
  'electron.child_process_gone': { level: 'ERROR', keys: ['type', 'reason', 'exitCode'] },
  'electron.browser_view_failed': { level: 'ERROR', keys: ['operation', 'reason'] },
  'electron.browser_view_state': { level: 'DEBUG', keys: ['operation', 'state'] },
  'electron.theme_failed': { level: 'WARN', keys: ['operation', 'reason'] },
  'electron.ipc_failed': { level: 'WARN', keys: ['operation', 'reason'] },

  /* Pi Bridge */
  'bridge.start': { level: 'DEBUG', keys: ['bridgeRun', 'phase'] },
  'bridge.ready': { level: 'INFO', keys: ['bridgeRun', 'durationMs'] },
  'bridge.state': { level: 'INFO', keys: ['state', 'phase', 'reason', 'bridgeRun'] },
  'bridge.restart': { level: 'INFO', keys: ['reason', 'bridgeRun'] },
  'bridge.exit': { level: 'WARN', keys: ['exitCode', 'signal', 'expected', 'uptimeMs', 'bridgeRun'] },
  'bridge.start_failed': { level: 'ERROR', keys: ['reason', 'phase'] },
  'bridge.parse_error': { level: 'WARN', keys: ['count', 'bridgeRun'] },
  'bridge.output_limit': { level: 'ERROR', keys: ['bytes', 'bridgeRun'] },
  'bridge.connection_lost': { level: 'WARN', keys: ['state', 'bridgeRun'] },
  'bridge.request_timeout': { level: 'WARN', keys: ['operation', 'durationMs', 'bridgeRun'] },
  'bridge.request_failed': { level: 'WARN', keys: ['operation', 'code', 'bridgeRun'] },
  'bridge.command_failed': { level: 'WARN', keys: ['operation', 'code', 'bridgeRun'] },
  'bridge.model_switch_failed': { level: 'WARN', keys: ['phase', 'code'] },
  'bridge.thinking_failed': { level: 'WARN', keys: ['phase', 'code'] },
  'bridge.stop_result': { level: 'INFO', keys: ['result', 'durationMs', 'bridgeRun'] },
  'bridge.stop_timeout': { level: 'ERROR', keys: ['durationMs', 'bridgeRun'] },
  'bridge.maintenance': { level: 'INFO', keys: ['phase', 'reason'] },
  'bridge.maintenance_timeout': { level: 'ERROR', keys: ['phase', 'durationMs'] },

  /* Runtime */
  'runtime.start_failed': { level: 'ERROR', keys: ['phase', 'code'] },
  'runtime.resume_failed': { level: 'ERROR', keys: ['phase', 'code'] },
  'runtime.owner_rejected': { level: 'WARN', keys: ['operation', 'reason'] },
  'runtime.sequence_rejected': { level: 'DEBUG', keys: ['reason', 'sequenceGap'], client: true },
  'runtime.revision_rejected': { level: 'DEBUG', keys: ['reason'], client: true },
  'runtime.event_dropped': { level: 'DEBUG', keys: ['reason', 'count'] },
  'runtime.session_switch_failed': { level: 'WARN', keys: ['phase', 'code'] },
  'runtime.browser_failed': { level: 'ERROR', keys: ['operation', 'code'] },
  'runtime.process_failed': { level: 'ERROR', keys: ['operation', 'code'] },
  'runtime.approval_failed': { level: 'WARN', keys: ['state', 'reason'], client: true },
  'runtime.approval_unknown': { level: 'WARN', keys: ['state', 'reason'], client: true },
  'runtime.cleanup_failed': { level: 'ERROR', keys: ['phase', 'reason'] },
  'runtime.registry_unavailable': { level: 'ERROR', keys: ['phase', 'reason'] },

  /* 网络与事件流 */
  'network.request_failed': { level: 'WARN', keys: ['route', 'reason', 'httpStatus'], client: true },
  'network.sse_disconnect': { level: 'WARN', keys: ['reason'], client: true },
  'network.sse_reconnect': { level: 'INFO', keys: ['durationMs'], client: true },

  /* Renderer / 常用 UI */
  'ui.notification': { level: 'INFO', keys: ['kind'], client: true },
  'ui.notification_error': { level: 'ERROR', keys: ['kind'], client: true },
  'ui.uncaught_exception': { level: 'ERROR', keys: ['errorName', 'frames'], client: true },
  'ui.unhandled_rejection': { level: 'ERROR', keys: ['errorName', 'frames'], client: true },
  'ui.module_load_failed': { level: 'ERROR', keys: ['module', 'reason'], client: true },
  'ui.dom_missing': { level: 'ERROR', keys: ['module', 'operation', 'count'], client: true },
  'ui.attachment_failed': { level: 'WARN', keys: ['kind', 'reason'], client: true },
  'ui.model_capability_unknown': { level: 'INFO', keys: ['count'], client: true },
  'ui.model_switch_failed': { level: 'WARN', keys: ['phase', 'code'], client: true },
  'ui.thinking_failed': { level: 'WARN', keys: ['phase', 'code'], client: true },
  'ui.stop_result': { level: 'INFO', keys: ['result', 'durationMs'], client: true },
  'ui.runtime_frame_rejected': { level: 'DEBUG', keys: ['reason', 'sequenceGap'], client: true },
  'ui.runtime_owner_rejected': { level: 'WARN', keys: ['reason'], client: true },
  'ui.logs_view_failed': { level: 'WARN', keys: ['operation', 'reason'], client: true },
  'ui.logs_export_failed': { level: 'WARN', keys: ['reason'], client: true },
  'ui.action_failed': { level: 'WARN', keys: ['action', 'reason'], client: true },
});

const NUMERIC_KEYS = new Set([
  'durationMs', 'windowCount', 'uptimeMs', 'exitCode', 'count', 'bytes', 'bridgeRun',
  'sequenceGap', 'httpStatus', 'windowMinutes', 'entryCount', 'errorCount', 'fileCount',
  'retentionDays', 'maxTotalMB', 'clientCount', 'failures',
]);
const BOOLEAN_KEYS = new Set(['recovered', 'expected', 'truncated', 'enabled', 'reused', 'isMainFrame']);
const FRAME_KEYS = new Set(['frames']);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError', 'AbortError', 'DOMException', 'UnknownError']);
const TOKEN_KEYS = new Set([
  'role', 'version', 'platform', 'arch', 'nodeVersion', 'electronVersion', 'mode',
  'reason', 'phase', 'state', 'operation', 'code', 'result', 'action', 'kind',
  'errorName', 'errorCode', 'type', 'signal', 'route', 'module', 'clientId',
]);

const TOKEN_RE = /^[A-Za-z0-9_.:@/-]{1,96}$/;
const CODE_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,96}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/* 刻意不带 g 标志：这里只用 .test() 做“是否含凭据”的判定。
 * 带 g 的正则会把 lastIndex 留在上一处匹配之后，连续/交错调用时
 * 同一段 secret 可能在第二次被放行 —— 安全判定必须无状态。 */
const SECRET_RE = /(?:bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|npm_[A-Za-z0-9]{8,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization|cookie|pi_gui_token)\s*[=:]\s*\S+)/i;
/* 字段值不应成为自由文本的侧门。拒绝明显的长全大写常量、含数字的长 token
 * 和多段连字符 token；正常命令/状态枚举（含下划线）仍可通过。 */
const SUSPICIOUS_TOKEN_RE = /^(?:[A-Z][A-Z0-9_]{12,}|[A-Za-z0-9_-]{20,}\d[A-Za-z0-9_-]*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+){2,})$/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;

function clampNumber(value, max = 24 * 60 * 60 * 1000) {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.floor(value), max);
}

function token(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 96 || !TOKEN_RE.test(text)) return null;
  if (SUSPICIOUS_TOKEN_RE.test(text)) return null;
  if (SECRET_RE.test(text)) return null;
  return text;
}

function code(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || !CODE_RE.test(text) || SECRET_RE.test(text)) return null;
  return text;
}

function id(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!ID_RE.test(text) || SECRET_RE.test(text)) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return text;
  if (SUSPICIOUS_TOKEN_RE.test(text)) return null;
  return text;
}

/** 只保留应用自身模块的相对堆栈帧。
 *
 * 传 root 时，绝对路径必须位于 root 下；只输出 `server/x.js:line`。
 * 这在结构上排除了用户项目路径、HOME、临时目录和 file URL 中的查询串。 */
function safeFrames(stack, { root = null, max = 5 } = {}) {
  if (typeof stack !== 'string' || !root) return [];
  const files = new Set();
  const lines = stack.split(/\r?\n/);
  for (const line of lines) {
    if (files.size >= max) break;
    let candidate = '';
    let lineNo = null;
    const fileUrl = line.match(/file:\/\/\/([^):]+)(?::(\d+))?/);
    const winPath = line.match(/([A-Za-z]:[\\/][^):]+?)(?::(\d+))?/);
    if (fileUrl) { candidate = fileUrl[1]; lineNo = fileUrl[2]; }
    else if (winPath) { candidate = winPath[1]; lineNo = winPath[2]; }
    else {
      const relative = line.match(/((?:public|server|lib|electron)[\\/][A-Za-z0-9_.\\/-]+)(?::(\d+))?/);
      if (relative) { candidate = relative[1]; lineNo = relative[2]; }
    }
    if (!candidate) continue;
    let rel = '';
    try {
      if (pathLike(candidate)) {
        const abs = pathLike.isAbsolute(candidate) ? pathLike.normalize(candidate) : null;
        if (!abs) continue;
        const rootNorm = pathLike.normalize(root);
        if (abs !== rootNorm && !abs.startsWith(rootNorm + pathLike.sep)) continue;
        rel = pathLike.relative(rootNorm, abs).replace(/\\/g, '/');
      } else rel = candidate.replace(/\\/g, '/');
    } catch { continue; }
    if (!/^(?:public|server|lib|electron)\/[A-Za-z0-9._/-]+\.(?:js|cjs|mjs)$/.test(rel)) continue;
    if (rel.split('/').includes('..')) continue;
    const frame = { file: rel };
    if (lineNo) frame.line = clampNumber(Number(lineNo), 10_000_000);
    files.add(JSON.stringify(frame));
  }
  return [...files].map((s) => JSON.parse(s));
}

/* 避免在模块顶层 require path 时受浏览器打包影响；这个契约只在 Node 侧加载。 */
const pathLike = require('node:path');

function normalizeDetails(event, details, verbose) {
  const def = EVENT_CATALOG[event];
  if (!def || !details || typeof details !== 'object' || Array.isArray(details)) return {};
  const allowed = new Set([...def.keys, ...(verbose ? def.verboseKeys || [] : [])]);
  const out = {};
  for (const key of allowed) {
    if (!Object.hasOwn(details, key)) continue;
    const value = details[key];
    if (key === 'frames') {
      if (Array.isArray(value)) {
        const frames = value.slice(0, 5).map((frame) => {
          if (!frame || typeof frame !== 'object') return null;
          const file = typeof frame.file === 'string' ? frame.file.replace(/\\/g, '/') : '';
          if (!/^(?:public|server|lib|electron)\/[A-Za-z0-9._/-]+\.(?:js|cjs|mjs)$/.test(file)) return null;
          if (file.split('/').includes('..')) return null;
          const line = Number.isInteger(frame.line) ? clampNumber(frame.line, 10_000_000) : null;
          return line ? { file, line } : { file };
        }).filter(Boolean);
        if (frames.length) out.frames = frames;
      }
      continue;
    }
    if (NUMERIC_KEYS.has(key)) {
      const n = clampNumber(value);
      if (n !== null) out[key] = n;
      continue;
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value === 'boolean') out[key] = value;
      continue;
    }
    if (key === 'errorName') {
      const name = typeof value === 'string' ? value.trim() : '';
      if (NAME_RE.test(name) && !SUSPICIOUS_TOKEN_RE.test(name) && !SECRET_RE.test(name)) out.errorName = name;
      else out.errorName = 'UnknownError';
      continue;
    }
    if (TOKEN_KEYS.has(key)) {
      const t = token(value);
      if (t) out[key] = t;
      continue;
    }
    /* 目录里有意只放上面几类字段；未来新增字段必须同时在这里声明类型。 */
  }
  return out;
}

function validSource(source) {
  return typeof source === 'string' && SOURCES.has(source);
}

function validRole(role) {
  return typeof role === 'string' && ROLES.has(role);
}

/** 规范化一条新事件。返回 null 表示宁愿丢日志，也不接受未知内容。 */
function normalizeEvent({ event, code: eventCode = null, details = {}, correlationId = null, durationMs = null } = {}) {
  const def = EVENT_CATALOG[event];
  if (!def) return null;
  const normalized = {
    event,
    level: def.level,
    code: code(eventCode) || null,
    details: normalizeDetails(event, details, true),
    correlationId: id(correlationId) || null,
    durationMs: clampNumber(durationMs) ?? null,
  };
  return normalized;
}

/** 再规范化从磁盘/接口读到的条目 —— 文件可能被手改，不能信任。 */
function normalizeStored(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const def = EVENT_CATALOG[entry.event];
  if (!def || !validSource(entry.source)) return null;
  if (!LEVELS.includes(entry.level)) return null;
  if (typeof entry.timestamp !== 'string' || !DATE_RE.test(entry.timestamp)) return null;
  const details = normalizeDetails(entry.event, entry.details, true);
  return {
    v: 1,
    timestamp: entry.timestamp,
    level: entry.level,
    source: entry.source,
    event: entry.event,
    code: code(entry.code) || null,
    runId: id(entry.runId) || null,
    correlationId: id(entry.correlationId) || null,
    durationMs: clampNumber(entry.durationMs),
    process: validRole(entry.process) ? entry.process : 'backend',
    ...(Object.keys(details).length ? { details } : {}),
  };
}

function isSecretText(text) {
  return SECRET_RE.test(String(text || ''));
}

module.exports = {
  LEVELS, LEVEL_RANK, SOURCES, ROLES, EVENT_CATALOG, NUMERIC_KEYS, BOOLEAN_KEYS,
  TOKEN_KEYS, DATE_RE, TOKEN_RE, CODE_RE, ID_RE,
  normalizeEvent, normalizeStored, normalizeDetails, safeFrames, validSource, validRole,
  token, code, id, clampNumber, isSecretText,
};
