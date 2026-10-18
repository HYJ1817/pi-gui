/* Renderer 的结构化日志客户端。
 *
 * Renderer 不接触日志文件，也不接触目录；只通过现有认证 HTTP API 把
 * **已声明事件**的少量元信息交给后端。这里不捕获 console、不做 DOM 快照、
 * 不记录用户输入、聊天正文、工具输出或 URL 查询参数。
 *
 * 设计约束：
 *   - 队列有界；网络失败时只丢掉**已经发出但无法确认送达**的那一批，
 *     不重放 —— 重放会让一次故障在日志里变成两份；
 *   - 暂时断线用有上限的指数退避恢复；后端恢复后新事件继续落盘；
 *   - 用户关闭日志（后端返回 disabled）时不继续请求，等设置界面显式恢复；
 *   - 协议/认证类错误（4xx、无效响应）停止上报，不再无限重试；
 *   - 同一事件在短时间内只发一次（滚动/渲染循环不会把日志打满）；
 *   - 全局异常只取 error.name 与自身模块的安全堆栈帧，绝不取 message；
 *   - 事件名最终由后端白名单再校验一次；本模块不是信任边界。
 */
import { sendLogEvents } from './api.js';

const MAX_QUEUE = 40;
const BATCH_SIZE = 10;
const FLUSH_MS = 1200;
const DEDUPE_MS = 5000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;
/* 连续失败到这个次数后，每次只探一条事件：避免整批整批地丢。 */
const PROBE_AFTER_FAILURES = 5;

const seen = new Map();
let queue = [];
let timer = null;
let sending = false;
let installed = false;
let sequence = 0;
let failures = 0;
let failedSinceReport = 0;
let dropped = 0;
let droppedSinceReport = 0;
let nextAttemptAt = 0;
let suspended = false;
let stopped = false;
/* 页面卸载/重新安装时让仍在飞的请求失效，避免它回来后继续排计时器。 */
let generation = 0;

function safeName(value) {
  const name = value && typeof value.name === 'string' ? value.name : '';
  return /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(name) ? name : 'Error';
}

/** 只把当前 public 模块的协议相对路径变成安全帧；不含查询串、绝对路径或用户文件。 */
export function rendererFrames(stack) {
  if (typeof stack !== 'string') return [];
  const frames = [];
  const seenFiles = new Set();
  for (const line of stack.split(/\r?\n/)) {
    if (frames.length >= 5) break;
    const match = line.match(/(?:(https?:\/\/[^/\s]+))?\/([A-Za-z0-9_./-]+\.(?:js|mjs))(?::(\d+))?/);
    if (!match) continue;
    if (match[1] && match[1] !== location.origin) continue;
    const rel = match[2].replace(/\\/g, '/');
    if (!/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:js|mjs)$/.test(rel) || rel.split('/').includes('..')) continue;
    if (!/^(?:ui\/|ui\d-[A-Za-z0-9_.-]+\.js$|[A-Za-z0-9_.-]+\.js$)/.test(rel)) continue;
    const file = 'public/' + rel;
    const lineNo = match[3] ? Math.min(Number(match[3]), 10_000_000) : null;
    const key = file + ':' + lineNo;
    if (seenFiles.has(key)) continue;
    seenFiles.add(key);
    frames.push(lineNo ? { file, line: lineNo } : { file });
  }
  return frames;
}

function scrubText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, 96)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<redacted>');
}

/** 只记录固定事件；未知事件名在客户端也丢弃，少给后端一点噪声。 */
const CLIENT_EVENTS = new Set([
  'network.request_failed', 'network.sse_disconnect', 'network.sse_reconnect',
  'ui.uncaught_exception', 'ui.unhandled_rejection', 'ui.module_load_failed',
  'ui.dom_missing', 'ui.attachment_failed', 'ui.model_capability_unknown',
  'ui.model_switch_failed', 'ui.thinking_failed', 'ui.stop_result',
  'runtime.sequence_rejected', 'runtime.revision_rejected', 'runtime.owner_rejected',
  'ui.runtime_frame_rejected', 'ui.runtime_owner_rejected', 'ui.logs_view_failed',
  'ui.logs_export_failed', 'ui.action_failed', 'app.uncaught_exception', 'app.unhandled_rejection',
  /* 本地上报队列恢复后，用固定事件补偿报告丢弃计数；不含请求正文。 */
  'logs.client_degraded',
]);

function cleanDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
    else if (typeof value === 'string') out[key] = scrubText(value);
    else if (key === 'frames' && Array.isArray(value)) {
      out.frames = value.slice(0, 5).filter((f) => f && typeof f.file === 'string').map((f) => ({
        file: f.file,
        ...(Number.isInteger(f.line) ? { line: f.line } : {}),
      }));
    }
  }
  return out;
}

function clearTimer() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
}

function schedule(delay = FLUSH_MS) {
  if (timer || sending || suspended || stopped || !queue.length) return;
  /* 退避期间新事件必须等 remaining backoff，而不是重新等一个 FLUSH_MS；
   * 队列为空时不会保留计时器，恢复由“下一条事件 + nextAttemptAt”驱动。 */
  const remaining = Math.max(0, nextAttemptAt - Date.now());
  const wait = failures > 0 ? remaining : Math.max(delay, remaining);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, wait);
}

function noteDropped(eventCount, reportable = true) {
  if (eventCount <= 0) return;
  dropped += eventCount;
  if (reportable) droppedSinceReport += eventCount;
}

/** 队列满时丢最旧的，保持内存有界；这是本地丢弃，不会产生新请求。 */
function trimQueue() {
  while (queue.length > MAX_QUEUE) {
    queue.shift();
    noteDropped(1);
  }
}

function emitDegradedReport(reason) {
  if (suspended || stopped) return false;
  if (droppedSinceReport <= 0 && failedSinceReport <= 0) return false;
  const count = droppedSinceReport;
  const failureCount = failedSinceReport;
  const accepted = logRendererEvent('logs.client_degraded', {
    reason,
    count,
    failures: failureCount,
  });
  /* 去重窗口内可能拒绝这条报告；只有真正入队才清计数。 */
  if (accepted) {
    droppedSinceReport = Math.max(0, droppedSinceReport - count);
    failedSinceReport = Math.max(0, failedSinceReport - failureCount);
  }
  return accepted;
}

export function logRendererEvent(event, details = {}, meta = {}) {
  if (!CLIENT_EVENTS.has(event)) return false;
  if (suspended || stopped) {
    noteDropped(1);
    return false;
  }
  const cleaned = cleanDetails(details);
  const key = event + ':' + JSON.stringify(cleaned);
  const now = Date.now();
  const last = seen.get(key);
  if (last && now - last < DEDUPE_MS) return false;
  seen.set(key, now);
  if (seen.size > 80) {
    for (const [k, at] of seen) if (now - at > DEDUPE_MS) seen.delete(k);
    if (seen.size > 80) seen.delete(seen.keys().next().value);
  }
  queue.push({
    event,
    details: cleaned,
    ...(typeof meta.code === 'string' ? { code: meta.code } : {}),
    ...(Number.isFinite(meta.durationMs) ? { durationMs: meta.durationMs } : {}),
    correlationId: 'ui-' + String(++sequence).padStart(6, '0') + '-' + Math.random().toString(36).slice(2, 10),
  });
  trimQueue();
  schedule();
  return true;
}

export function logOnce(event, details = {}, meta = {}) {
  return logRendererEvent(event, details, meta);
}

/** 把 HTTP 结果分成三类：成功、可恢复、不可恢复。 */
function isTransientFailure(result) {
  if (!result || result.network === true) return true;
  if (result.code === 'invalid_response') return false;
  const status = Number(result.status);
  if (!Number.isFinite(status) || status === 0) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelay() {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(Math.max(failures - 1, 0), 5));
}

async function flush() {
  if (sending || suspended || stopped || !queue.length) return;
  const now = Date.now();
  if (now < nextAttemptAt) {
    schedule(nextAttemptAt - now);
    return;
  }
  sending = true;
  const run = generation;
  /* 连续失败后只探一条：失败时丢掉的批次更小，恢复探测也更快。 */
  const batch = queue.splice(0, failures >= PROBE_AFTER_FAILURES ? 1 : BATCH_SIZE);
  let result = null;
  try {
    result = await sendLogEvents(batch);
  } catch {
    result = { ok: false, network: true, status: 0 };
  }
  sending = false;

  /* 页面已卸载，或请求期间用户关闭了日志：不要再排下一轮。 */
  if (run !== generation || suspended || stopped) return;

  if (result && result.ok === true && result.disabled === true) {
    suspended = true;
    noteDropped(batch.length + queue.length);
    queue = [];
    nextAttemptAt = 0;
    clearTimer();
    return;
  }

  if (result && result.ok === true) {
    const recovered = failures > 0;
    failures = 0;
    nextAttemptAt = 0;
    if (recovered) emitDegradedReport('network_recovered');
    else if (droppedSinceReport > 0) emitDegradedReport('queue_overflow');
    if (queue.length) schedule();
    return;
  }

  if (isTransientFailure(result)) {
    failures += 1;
    failedSinceReport += 1;
    /* 这一批已经发出，但没拿到确认：宁可丢掉也不重放。 */
    noteDropped(batch.length);
    nextAttemptAt = Date.now() + retryDelay();
    schedule(nextAttemptAt - Date.now());
    return;
  }

  /* 4xx / 无效响应：当前页面继续重试只会制造同样的失败。 */
  stopped = true;
  noteDropped(batch.length + queue.length);
  queue = [];
  nextAttemptAt = 0;
  clearTimer();
}

/** 设置界面同步启用状态；恢复时清掉退避，让下一次事件立刻可发。 */
export function setRendererLoggingEnabled(enabled) {
  if (enabled === false) {
    const wasActive = !suspended;
    suspended = true;
    noteDropped(queue.length);
    queue = [];
    nextAttemptAt = 0;
    clearTimer();
    return wasActive;
  }
  if (enabled !== true) return false;
  const wasBlocked = suspended || stopped;
  suspended = false;
  stopped = false;
  if (wasBlocked) {
    failures = 0;
    nextAttemptAt = 0;
    if (droppedSinceReport > 0) emitDegradedReport('resumed');
    schedule();
  }
  return wasBlocked;
}

/** 安装全局错误/未处理 rejection 观察器。只调用一次。 */
export function installRendererLogging() {
  if (installed || typeof window === 'undefined') return () => {};
  installed = true;
  const onError = (event) => {
    const error = event && event.error;
    logRendererEvent('ui.uncaught_exception', {
      errorName: safeName(error),
      ...(error ? { frames: rendererFrames(error.stack) } : {}),
    });
  };
  const onRejection = (event) => {
    const reason = event && event.reason;
    logRendererEvent('ui.unhandled_rejection', {
      errorName: safeName(reason),
      ...(reason && typeof reason === 'object' ? { frames: rendererFrames(reason.stack) } : {}),
    });
  };
  /* 资源加载失败不会冒泡到 window 的普通 error 事件，用捕获阶段单独观察。
   * 只记录同源脚本/样式的路径名，不带查询串或外部 host。 */
  const onResourceError = (event) => {
    const target = event && event.target;
    const raw = target && (target.src || target.href);
    if (!raw) return;
    try {
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin) return;
      const pathname = url.pathname;
      if (!/\.(?:js|mjs|css)$/.test(pathname)) return;
      logRendererEvent('ui.module_load_failed', { module: pathname.replace(/^\//, ''), reason: 'resource_error' });
    } catch { /* ignore malformed resource URL */ }
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('error', onResourceError, true);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('error', onResourceError, true);
    installed = false;
    generation += 1;
    clearTimer();
    queue = [];
    sending = false;
  };
}

export function rendererLogSnapshot() {
  return {
    queued: queue.length,
    failing: failures > 0,
    installed,
    seen: seen.size,
    sending,
    failures,
    dropped,
    suspended,
    stopped,
    nextAttemptAt,
  };
}
