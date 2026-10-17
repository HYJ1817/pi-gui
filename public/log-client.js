/* Renderer 的结构化日志客户端。
 *
 * Renderer 不接触日志文件，也不接触目录；只通过现有认证 HTTP API 把
 * **已声明事件**的少量元信息交给后端。这里不捕获 console、不做 DOM 快照、
 * 不记录用户输入、聊天正文、工具输出或 URL 查询参数。
 *
 * 设计约束：
 *   - 队列有界；网络失败即停止本轮上报，避免日志拖慢或拖死界面；
 *   - 同一事件在短时间内只发一次（滚动/渲染循环不会把日志打满）；
 *   - 全局异常只取 error.name 与自身模块的安全堆栈帧，绝不取 message；
 *   - 事件名最终由后端白名单再校验一次；本模块不是信任边界。
 */
import { sendLogEvents } from './api.js';

const MAX_QUEUE = 40;
const BATCH_SIZE = 10;
const FLUSH_MS = 1200;
const DEDUPE_MS = 5000;
const seen = new Map();
let queue = [];
let timer = null;
let failing = false;
let installed = false;
let sequence = 0;

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

export function logRendererEvent(event, details = {}, meta = {}) {
  if (!CLIENT_EVENTS.has(event) || failing) return false;
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
  while (queue.length > MAX_QUEUE) queue.shift();
  schedule();
  return true;
}

export function logOnce(event, details = {}, meta = {}) {
  return logRendererEvent(event, details, meta);
}

function schedule() {
  if (timer || failing) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_MS);
}

async function flush() {
  if (failing || !queue.length) return;
  const batch = queue.splice(0, BATCH_SIZE);
  try {
    const result = await sendLogEvents(batch);
    if (result && result.ok === false && result.network) {
      failing = true;
      queue = [];
      return;
    }
  } catch {
    failing = true;
    queue = [];
    return;
  }
  if (queue.length) schedule();
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
  };
}

export function rendererLogSnapshot() {
  return { queued: queue.length, failing, installed, seen: seen.size };
}
