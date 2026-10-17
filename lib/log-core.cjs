/* 本地诊断日志核心：事件落盘、轮转、保留、读取与故障报告 ZIP。
 *
 * 只给 Node 侧使用。Renderer 通过认证 API 提交事件，不接触这个文件，
 * 也不接触日志目录。
 *
 * 关键取舍：
 *   - 写入采用有界内存队列 + 小批量同步 append。日志频率低；
 *     这样不会在退出时丢掉最后几条，也不会让每条事件都打一次磁盘。
 *   - 每个进程角色只写自己的文件；主进程与后端从不并发追加同一个文件。
 *   - 目录、文件名、ZIP 内容全部固定或经过白名单。任何调用方都不能传路径。
 *   - 所有失败都转成固定状态码；不把原生异常 message / 路径带出去。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  LEVELS, LEVEL_RANK, EVENT_CATALOG, normalizeEvent, normalizeStored, safeFrames,
  validSource, validRole, token, id, clampNumber,
} = require('./log-contract.cjs');
const { createZip } = require('./zip.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LINE_BYTES = 2048;
const MAX_QUEUE_RECORDS = 2000;
const MAX_QUEUE_BYTES = 256 * 1024;
const MAX_BATCH_BYTES = 64 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_EXPORT_EVENTS = 5000;
const MAX_EXPORT_BYTES = 5 * 1024 * 1024;
const SETTINGS_FILE = 'logging-preferences.json';
const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  enabled: true,
  mode: 'standard',
  retentionDays: 7,
  maxTotalMB: 20,
  verboseUntil: null,
});
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const VALID_RETENTION = new Set([1, 3, 7, 14, 30]);
const VALID_TOTAL_MB = new Set([10, 20, 50]);
const FILE_RE = /^(app|main)(-crash)?-(\d{8})(?:-(\d+))?\.jsonl$/;
const SETTINGS_RE = /^[A-Za-z0-9._-]{1,80}$/;

function nowMs(now) {
  const value = now();
  return value instanceof Date ? value.getTime() : Number(value);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function dateKey(ms) {
  return iso(ms).slice(0, 10).replace(/-/g, '');
}

function dateFromKey(key) {
  if (!/^\d{8}$/.test(key)) return null;
  const y = Number(key.slice(0, 4)), m = Number(key.slice(4, 6)), d = Number(key.slice(6, 8));
  const ms = Date.UTC(y, m - 1, d);
  return Number.isFinite(ms) ? ms : null;
}

function rolePrefix(role) {
  return role === 'main' ? 'main' : 'app';
}

function processName(role) {
  return role === 'main' ? 'main' : 'backend';
}

function safeErrorCode(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (code === 'ENOSPC') return 'disk_full';
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied';
  if (code === 'ENOTDIR') return 'path_invalid';
  if (code === 'EISDIR') return 'path_invalid';
  if (code === 'ENOENT') return 'path_missing';
  if (code === 'EROFS') return 'read_only';
  return 'write_failed';
}

function parseFileMeta(name) {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  const date = dateFromKey(m[3]);
  if (date === null) return null;
  return {
    name,
    role: m[1],
    kind: m[2] ? 'crash' : 'normal',
    date,
    seq: m[4] ? Number(m[4]) : 1,
  };
}

function fileOrder(a, b) {
  return b.date - a.date || b.seq - a.seq || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
}


/* 用户可读文本中的高熵/凭据形态只做保守替换；不能确定的自由文本宁可省略。
 * 这里的规则与日志事件字段白名单不同：事件字段根本不允许自由文本。 */
function redactUnsafeTokens(text) {
  return String(text ?? '')
    .replace(/\bhttps?:\/\/[^\s"']+[?#][^\s"']*/gi, '<url>')
    .replace(/\b(?:cookie|set-cookie|authorization|session|oauth|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password|passwd)\s*[=:]\s*[^\s,;]+/gi, (m) => m.split(/[=:]/)[0] + '=<redacted>')
    .replace(/\b(?:secret|token|oauth|api[_-]?key|cookie)[-_:=][A-Za-z0-9_-]{6,}/gi, '<redacted>')
    .replace(/\b(?=[A-Za-z0-9_-]{20,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]+/g, '<redacted>')
    .replace(/\b[A-Z][A-Z0-9_]{12,}\b/g, '<redacted>')
    .replace(/\b[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+){2,}\b/g, '<redacted>');
}

function scrubShortText(value, max = 2000) {
  let s = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  s = s.slice(0, max);
  s = s
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}\b/g, '<redacted>')
    .replace(/\bnpm_[A-Za-z0-9]{8,}\b/g, '<redacted>')
    .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD))\s*=\s*\S+/gi, '$1=<redacted>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\/(?:home|Users|root)\/[^\s"']+/g, '<path>');
  return redactUnsafeTokens(s);
}

function scrubLongText(value) {
  let s = String(value ?? '');
  s = s
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}\b/g, '<redacted>')
    .replace(/\bnpm_[A-Za-z0-9]{8,}\b/g, '<redacted>')
    .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD))\s*=\s*\S+/gi, '$1=<redacted>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\/(?:home|Users|root)\/[^\s"']+/g, '<path>');
  return redactUnsafeTokens(s);
}

function looksSensitive(text) {
  const s = String(text ?? '');
  return /\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+|\b(?:api[_-]?key|oauth|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|cookie|authorization|session)\s*[=:]/i.test(s)
    || /\bhttps?:\/\/[^\s"'\`]+[?#]/i.test(s)
    || (/[A-Za-z]:/.test(s) && s.includes(String.fromCharCode(92)))
    || /\/(?:home|Users|root)\//.test(s)
    || /\b[A-Z][A-Z0-9_]{12,}\b/.test(s)
    || /\b[A-Za-z0-9_-]{20,}\b/.test(s)
    || /\b[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+){2,}\b/.test(s);
}

function safeUserText(value) {
  const text = String(value ?? '').slice(0, 2000);
  if (!text.trim()) return { text: '', omitted: false };
  if (looksSensitive(text)) {
    return { text: '[用户填写内容包含疑似敏感信息，已省略；请重新填写后再发送。]', omitted: true };
  }
  return { text: text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''), omitted: false };
}

function scrubShortText(value, max = 2000) {
  let s = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  s = s.slice(0, max);
  s = s
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}\b/g, '<redacted>')
    .replace(/\bnpm_[A-Za-z0-9]{8,}\b/g, '<redacted>')
    .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD))\s*=\s*\S+/gi, '$1=<redacted>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\/(?:home|Users|root)\/[^\s"']+/g, '<path>');
  return redactUnsafeTokens(s);
}

function scrubLongText(value) {
  let s = String(value ?? '');
  s = s
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}\b/g, '<redacted>')
    .replace(/\bnpm_[A-Za-z0-9]{8,}\b/g, '<redacted>')
    .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD))\s*=\s*\S+/gi, '$1=<redacted>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\/(?:home|Users|root)\/[^\s"']+/g, '<path>');
  return redactUnsafeTokens(s);
}

function normalizeSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const enabled = raw.enabled === true ? true : raw.enabled === false ? false : null;
  const mode = raw.mode === 'verbose' ? 'verbose' : raw.mode === 'standard' ? 'standard' : null;
  const retentionDays = VALID_RETENTION.has(raw.retentionDays) ? raw.retentionDays : null;
  const maxTotalMB = VALID_TOTAL_MB.has(raw.maxTotalMB) ? raw.maxTotalMB : null;
  if (enabled === null && mode === null && retentionDays === null && maxTotalMB === null) return null;
  return {
    enabled: enabled ?? true,
    mode: mode ?? 'standard',
    retentionDays: retentionDays ?? 7,
    maxTotalMB: maxTotalMB ?? 20,
    verboseUntil: typeof raw.verboseUntil === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(raw.verboseUntil) ? raw.verboseUntil : null,
  };
}

function encodeCursor(entry) {
  return Buffer.from(JSON.stringify({ t: entry.timestamp, f: entry._file, l: entry._line }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 512) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!value || typeof value.t !== 'string' || typeof value.f !== 'string' || !Number.isFinite(value.l)) return null;
    if (!FILE_RE.test(value.f) || value.l < 1) return null;
    return value;
  } catch { return null; }
}

function isOlderThanCursor(entry, cursor) {
  if (!cursor) return true;
  if (entry.timestamp < cursor.t) return true;
  if (entry.timestamp > cursor.t) return false;
  if (entry._file < cursor.f) return true;
  if (entry._file > cursor.f) return false;
  return entry._line < cursor.l;
}

function createLogCore(options = {}) {
  const role = options.role === 'main' ? 'main' : 'app';
  const dir = path.resolve(String(options.dir || ''));
  const fsApi = options.fsApi || fs;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const appRoot = options.appRoot ? path.resolve(String(options.appRoot)) : null;
  const maxFileBytes = Math.max(256, Math.min(Number.isInteger(options.maxFileBytes) ? options.maxFileBytes : MAX_FILE_BYTES, 16 * 1024 * 1024));
  const maxQueueRecords = Math.max(16, Math.min(Number.isInteger(options.maxQueueRecords) ? options.maxQueueRecords : MAX_QUEUE_RECORDS, MAX_QUEUE_RECORDS));
  const maxQueueBytes = Math.max(1024, Math.min(Number.isInteger(options.maxQueueBytes) ? options.maxQueueBytes : MAX_QUEUE_BYTES, MAX_QUEUE_BYTES));
  const version = token(options.version) || '0.0.0';
  const randomId = typeof options.random === 'function'
    ? options.random
    : () => crypto.randomUUID();
  const runId = String(randomId()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 96) || crypto.randomUUID();
  const startedAt = nowMs(now);
  const startup = { runId, startedAt: iso(startedAt), previousUnclean: null };
  let markerClean = false;
  let settings = { ...DEFAULT_SETTINGS };
  let settingsLoaded = false;
  let settingsCorrupt = false;
  let lastSettingsMtime = 0;
  let dirWritable = true;
  let degraded = false;
  let lastErrorCode = null;
  let closed = false;
  let queue = [];
  let queueBytes = 0;
  let droppedRecords = 0;
  let writeFailures = 0;
  let drainTimer = null;
  let active = new Map(); // target -> { file, day, seq }
  let verboseExpired = false;
  let pruning = false;
  let lastUsage = { bytes: 0, files: 0 };

  function safeStatus(code) {
    lastErrorCode = code;
    degraded = true;
  }

  function ensureDir() {
    try {
      fsApi.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { fsApi.chmodSync(dir, 0o700); } catch { /* Windows / restricted FS */ }
      fsApi.accessSync(dir, fsApi.constants ? fsApi.constants.W_OK : fs.constants.W_OK);
      dirWritable = true;
    } catch (err) {
      dirWritable = false;
      safeStatus(safeErrorCode(err));
    }
  }

  function readSettings() {
    let raw = null;
    try {
      const file = path.join(dir, SETTINGS_FILE);
      const st = fsApi.lstatSync(file);
      if (st.isSymbolicLink() || !st.isFile() || st.size > 16 * 1024) throw Error('settings_invalid');
      lastSettingsMtime = st.mtimeMs || 0;
      raw = JSON.parse(fsApi.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err && err.code !== 'ENOENT') settingsCorrupt = true;
      settingsLoaded = true;
      return;
    }
    const normalized = normalizeSettings(raw);
    if (!normalized) {
      settingsCorrupt = true;
      settingsLoaded = true;
      return;
    }
    settings = { ...DEFAULT_SETTINGS, ...normalized };
    if (settings.mode === 'verbose' && settings.verboseUntil) {
      const until = Date.parse(settings.verboseUntil);
      if (!Number.isFinite(until) || until <= nowMs(now)) {
        settings.mode = 'standard';
        settings.verboseUntil = null;
        verboseExpired = true;
        persistSettings();
      }
    }
    settingsLoaded = true;
  }

  function persistSettings() {
    let tmp = null;
    try {
      const file = path.join(dir, SETTINGS_FILE);
      try {
        const st = fsApi.lstatSync(file);
        if (st.isSymbolicLink() || !st.isFile()) throw Error('settings_invalid');
      } catch (err) {
        if (err && err.code !== 'ENOENT') throw err;
      }
      tmp = path.join(dir, `.${SETTINGS_FILE}.${String(randomId()).replace(/[^A-Za-z0-9_-]/g, '')}.tmp`);
      fsApi.writeFileSync(tmp, JSON.stringify({
        version: 1,
        enabled: settings.enabled,
        mode: settings.mode,
        retentionDays: settings.retentionDays,
        maxTotalMB: settings.maxTotalMB,
        verboseUntil: settings.verboseUntil,
      }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fsApi.renameSync(tmp, file);
      try { lastSettingsMtime = fsApi.lstatSync(file).mtimeMs || 0; } catch { lastSettingsMtime = 0; }
      dirWritable = true;
      return true;
    } catch (err) {
      safeStatus('settings_write_failed');
      if (tmp) { try { fsApi.unlinkSync(tmp); } catch { /* noop */ } }
      return false;
    }
  }

  function ensureVerboseExpiry() {
    if (settings.mode !== 'verbose' || !settings.verboseUntil) return false;
    const until = Date.parse(settings.verboseUntil);
    if (Number.isFinite(until) && until > nowMs(now)) return false;
    settings.mode = 'standard';
    settings.verboseUntil = null;
    verboseExpired = true;
    persistSettings();
    return true;
  }

  function effectiveMode() {
    ensureVerboseExpiry();
    return settings.mode === 'verbose' ? 'verbose' : 'standard';
  }

  /** 主进程用：后端修改设置后，重新读取同一份文件。
   * 只有 mtime 变化才读，避免每条日志都 stat。 */
  function refreshSettings() {
    if (closed) return { ...settings };
    try {
      const file = path.join(dir, SETTINGS_FILE);
      const st = fsApi.lstatSync(file);
      if (!st.isSymbolicLink() && st.isFile() && st.size <= 16 * 1024 && (st.mtimeMs || 0) !== lastSettingsMtime) {
        readSettings();
      }
    } catch { /* 设置文件不存在/暂不可读时保留上一份 */ }
    return { ...settings };
  }

  function loggingEnabled() {
    return !closed && settings.enabled === true && dirWritable;
  }

  function markerPath() {
    return path.join(dir, `session-${role}.json`);
  }

  function readMarker() {
    try {
      const file = markerPath();
      const st = fsApi.lstatSync(file);
      if (st.isSymbolicLink() || !st.isFile() || st.size > 4096) return null;
      const value = JSON.parse(fsApi.readFileSync(file, 'utf8'));
      if (!value || value.clean !== false || typeof value.runId !== 'string' || value.runId.length > 96) return null;
      return value;
    } catch { return null; }
  }

  function writeMarker(clean) {
    try {
      const file = markerPath();
      const tmp = path.join(dir, `.session-${role}.${String(randomId()).replace(/[^A-Za-z0-9_-]/g, '')}.tmp`);
      fsApi.writeFileSync(tmp, JSON.stringify({
        version: 1,
        runId,
        startedAt: iso(startedAt),
        clean: clean === true,
      }) + '\n', { mode: 0o600, flag: 'wx' });
      fsApi.renameSync(tmp, file);
      markerClean = clean === true;
      return true;
    } catch {
      safeStatus('session_marker_failed');
      return false;
    }
  }

  function fileList() {
    let names = [];
    try { names = fsApi.readdirSync(dir); } catch (err) {
      dirWritable = false;
      safeStatus(safeErrorCode(err));
      return [];
    }
    const out = [];
    for (const name of names) {
      const meta = parseFileMeta(name);
      if (!meta) continue;
      const full = path.join(dir, name);
      try {
        const st = fsApi.lstatSync(full);
        if (st.isSymbolicLink() || !st.isFile()) continue;
        out.push({ ...meta, path: full, size: st.size, mtimeMs: st.mtimeMs || 0 });
      } catch { /* race with clear; ignore */ }
    }
    return out.sort((a, b) => fileOrder(a, b) || b.mtimeMs - a.mtimeMs);
  }

  function prune() {
    if (pruning) return;
    pruning = true;
    try {
      const files = fileList();
      const cutoff = dateFromKey(dateKey(nowMs(now))) - (settings.retentionDays - 1) * DAY_MS;
      let removedFiles = 0;
      let removedBytes = 0;
      for (const file of files) {
        if (file.date < cutoff) {
          if (path.resolve(file.path) === path.resolve(active.get(file.kind)?.file || '')) continue;
          try { fsApi.unlinkSync(file.path); removedFiles += 1; removedBytes += file.size; } catch { /* noop */ }
        }
      }
      let remaining = fileList();
      let total = remaining.reduce((n, f) => n + f.size, 0);
      const cap = settings.maxTotalMB * 1024 * 1024;
      for (const file of [...remaining].reverse()) {
        if (total <= cap) break;
        if (path.resolve(file.path) === path.resolve(active.get(file.kind)?.file || '')) continue;
        try {
          fsApi.unlinkSync(file.path);
          total -= file.size;
          removedFiles += 1;
          removedBytes += file.size;
        } catch { /* noop */ }
      }
      if (removedFiles) {
        lastUsage = { bytes: total, files: Math.max(0, remaining.length - removedFiles) };
        if (settings.enabled && effectiveMode() === 'verbose') {
          event('logs', 'logs.pruned', { fileCount: removedFiles, bytes: removedBytes });
        }
      }
    } finally {
      pruning = false;
    }
  }

  function targetFor(eventLevel, explicitCrash = false) {
    return explicitCrash || eventLevel === 'FATAL' ? 'crash' : 'normal';
  }

  function activeFor(target) {
    const day = dateKey(nowMs(now));
    const current = active.get(target);
    if (current && current.day === day) return current;
    const prefix = target === 'crash' ? `${rolePrefix(role)}-crash-${day}` : `${rolePrefix(role)}-${day}`;
    let seq = 1;
    try {
      for (const name of fsApi.readdirSync(dir)) {
        const meta = parseFileMeta(name);
        if (!meta || meta.role !== rolePrefix(role) || meta.kind !== target || meta.date !== dateFromKey(day)) continue;
        seq = Math.max(seq, meta.seq);
      }
    } catch { /* ensureDir will fail or file listing is unavailable */ }
    const file = path.join(dir, seq === 1 ? `${prefix}.jsonl` : `${prefix}-${seq}.jsonl`);
    const next = { target, day, seq, file };
    active.set(target, next);
    return next;
  }

  function rotate(target) {
    const current = activeFor(target);
    const prefix = target === 'crash' ? `${rolePrefix(role)}-crash-${current.day}` : `${rolePrefix(role)}-${current.day}`;
    const next = { ...current, seq: current.seq + 1, file: path.join(dir, `${prefix}-${current.seq + 1}.jsonl`) };
    active.set(target, next);
    return next;
  }

  function safePath(file) {
    const base = path.basename(file);
    const parent = path.resolve(path.dirname(file));
    return parent === path.resolve(dir) && FILE_RE.test(base) && !base.includes('..');
  }

  function appendRecords(target, records) {
    let remaining = records.slice();
    while (remaining.length) {
      const current = activeFor(target);
      if (!safePath(current.file)) throw Error('invalid_log_path');
      let size = 0;
      try {
        const st = fsApi.lstatSync(current.file);
        if (st.isSymbolicLink() || !st.isFile()) throw Error('invalid_log_path');
        size = st.size;
      } catch (err) { if (err && err.code !== 'ENOENT') throw err; }
      if (size >= maxFileBytes) {
        rotate(target);
        continue;
      }
      const chunk = [];
      let chunkBytes = 0;
      const room = maxFileBytes - size;
      for (const record of remaining) {
        if (chunk.length && (chunkBytes + record.bytes > MAX_BATCH_BYTES || chunkBytes + record.bytes > room)) break;
        chunk.push(record);
        chunkBytes += record.bytes;
        if (chunkBytes >= MAX_BATCH_BYTES || chunkBytes >= room) break;
      }
      if (!chunk.length) { // a single oversize line should still be written once
        chunk.push(remaining[0]);
        chunkBytes = remaining[0].bytes;
      }
      fsApi.appendFileSync(current.file, chunk.map((r) => r.line).join(''), { mode: 0o600 });
      remaining = remaining.slice(chunk.length);
      if (chunkBytes >= room) rotate(target);
    }
  }

  function drain() {
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    if (!queue.length) return 0;
    const normal = [], crash = [];
    let taken = 0;
    while (queue.length && taken < MAX_BATCH_BYTES) {
      const record = queue.shift();
      queueBytes -= record.bytes;
      taken += record.bytes;
      (record.target === 'crash' ? crash : normal).push(record);
    }
    try {
      if (normal.length) appendRecords('normal', normal);
      if (crash.length) appendRecords('crash', crash);
    } catch (err) {
      writeFailures += 1;
      droppedRecords += normal.length + crash.length;
      safeStatus(safeErrorCode(err));
    }
    if (queue.length) scheduleDrain(0);
    return taken;
  }

  function scheduleDrain(ms = 100) {
    if (drainTimer || closed) return;
    drainTimer = setTimeout(() => { drainTimer = null; drain(); }, ms);
    if (typeof drainTimer.unref === 'function') drainTimer.unref();
  }

  function enqueue(record) {
    if (record.bytes > maxQueueBytes) { droppedRecords += 1; return false; }
    while (queue.length >= maxQueueRecords || queueBytes + record.bytes > maxQueueBytes) {
      const dropped = queue.shift();
      if (!dropped) break;
      queueBytes -= dropped.bytes;
      droppedRecords += 1;
    }
    queue.push(record);
    queueBytes += record.bytes;
    if (queue.length >= 64 || queueBytes >= MAX_BATCH_BYTES / 4) drain();
    else scheduleDrain();
    return true;
  }

  function formatLine(fields) {
    const entry = {
      v: 1,
      timestamp: fields.timestamp || iso(nowMs(now)),
      level: fields.level,
      source: fields.source,
      event: fields.event,
      code: fields.code || null,
      runId: fields.runId || runId,
      correlationId: fields.correlationId || null,
      durationMs: fields.durationMs ?? null,
      process: fields.process || processName(role),
      ...(fields.details && Object.keys(fields.details).length ? { details: fields.details } : {}),
    };
    let line = JSON.stringify(entry) + '\n';
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      delete entry.details;
      line = JSON.stringify(entry) + '\n';
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return '';
    }
    return line;
  }

  function buildEntry(source, event, details = {}, meta = {}) {
    if (!validSource(source)) return null;
    const normalized = normalizeEvent({ event, code: meta.code, details, correlationId: meta.correlationId, durationMs: meta.durationMs });
    if (!normalized) return null;
    const mode = effectiveMode();
    if (normalized.level === 'DEBUG' && mode !== 'verbose') return null;
    return {
      event: normalized.event,
      level: normalized.level,
      source,
      details: normalized.details,
      code: normalized.code,
      correlationId: normalized.correlationId || String(randomId()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64),
      durationMs: normalized.durationMs,
      process: validRole(meta.process) ? meta.process : processName(role),
    };
  }

  function event(source, eventName, details = {}, meta = {}) {
    if (!loggingEnabled()) return false;
    const built = buildEntry(source, eventName, details, meta);
    if (!built) return false;
    const line = formatLine({ ...built, timestamp: iso(nowMs(now)) });
    if (!line) return false;
    const target = targetFor(built.level, meta.crash === true);
    return enqueue({ target, line, bytes: Buffer.byteLength(line, 'utf8') });
  }

  function crash(source, eventName, error = null, details = {}, meta = {}) {
    if (!loggingEnabled()) return false;
    const safeEvent = EVENT_CATALOG[eventName] ? eventName : 'app.crash';
    const frames = error ? safeFrames(error.stack, { root: appRoot }) : [];
    const built = buildEntry(source, safeEvent, {
      ...details,
      ...(error && error.name ? { errorName: String(error.name) } : {}),
      ...(frames.length ? { frames } : {}),
    }, { ...meta, code: meta.code || (error && error.code), crash: true });
    if (!built) return false;
    const line = formatLine({ ...built, timestamp: iso(nowMs(now)) });
    if (!line) return false;
    return enqueue({ target: 'crash', line, bytes: Buffer.byteLength(line, 'utf8') });
  }

  function flushSync() {
    return drain();
  }

  function flush() {
    drain();
    return Promise.resolve();
  }

  function status() {
    ensureVerboseExpiry();
    const files = fileList();
    const usageBytes = files.reduce((n, f) => n + f.size, 0);
    lastUsage = { bytes: usageBytes, files: files.length };
    let recentErrors = [];
    try {
      recentErrors = readEntries({ limit: 5, levels: new Set(['ERROR', 'FATAL']), scanBudget: 1024 * 1024 }).entries;
    } catch { /* status must not fail */ }
    return {
      ok: true,
      version: 1,
      role: processName(role),
      appVersion: version,
      enabled: settings.enabled === true,
      mode: effectiveMode(),
      verboseUntil: settings.mode === 'verbose' ? settings.verboseUntil : null,
      verboseExpired,
      retentionDays: settings.retentionDays,
      maxTotalMB: settings.maxTotalMB,
      maxFileBytes,
      dirWritable,
      degraded,
      lastErrorCode,
      writeFailures,
      droppedRecords,
      settingsCorrupt,
      usageBytes,
      fileCount: files.length,
      crashFileCount: files.filter((f) => f.kind === 'crash').length,
      files: files.map((f) => ({ name: f.name, role: f.role, kind: f.kind, size: f.size, date: iso(f.date).slice(0, 10) })),
      session: {
        runId: startup.runId,
        startedAt: startup.startedAt,
        previousUnclean: startup.previousUnclean ? { startedAt: startup.previousUnclean.startedAt } : null,
      },
      recentErrors,
    };
  }

  function parseLine(line, file, lineNo) {
    let entry;
    try { entry = JSON.parse(line); } catch { return null; }
    const normalized = normalizeStored(entry);
    if (!normalized) return null;
    normalized._file = file;
    normalized._line = lineNo;
    normalized.cursor = encodeCursor(normalized);
    return normalized;
  }

  function readFileTail(file, budget) {
    const st = fsApi.lstatSync(file.path);
    if (st.isSymbolicLink() || !st.isFile()) return { text: '', readBytes: 0, truncated: false };
    const size = st.size;
    const take = Math.max(0, Math.min(size, budget));
    const start = Math.max(0, size - take);
    if (!take) return { text: '', readBytes: 0, truncated: size > 0 };
    const fd = fsApi.openSync(file.path, 'r');
    try {
      const buf = Buffer.alloc(take);
      let offset = 0;
      while (offset < take) {
        const n = fsApi.readSync(fd, buf, offset, take - offset, start + offset);
        if (!n) break;
        offset += n;
      }
      let text = buf.subarray(0, offset).toString('utf8');
      if (start > 0) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
      return { text, readBytes: offset, truncated: start > 0 };
    } finally {
      try { fsApi.closeSync(fd); } catch { /* noop */ }
    }
  }

  function readEntries({ limit = 100, cursor = null, before = null, levels = null, sources = null, q = '', windowMinutes = null, scanBudget = MAX_READ_BYTES } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 100, 200));
    const safeLevels = levels instanceof Set ? levels : Array.isArray(levels) ? new Set(levels.filter((l) => LEVELS.includes(l))) : null;
    const safeSources = sources instanceof Set ? sources : Array.isArray(sources) ? new Set(sources) : null;
    const query = typeof q === 'string' ? q.trim().slice(0, 100).toLowerCase() : '';
    const cutoff = Number.isFinite(windowMinutes) && windowMinutes > 0
      ? nowMs(now) - Math.min(windowMinutes, 24 * 60) * 60 * 1000
      : null;
    const cursorValue = decodeCursor(cursor || before);
    let budget = Math.max(0, Math.min(scanBudget, MAX_READ_BYTES));
    const collected = [];
    let truncated = false;
    const files = fileList().filter((f) => !cutoff || f.date >= dateFromKey(dateKey(cutoff)));
    let scannedFiles = 0;
    for (const file of files) {
      if (budget <= 0) { truncated = true; break; }
      const tail = readFileTail(file, budget);
      budget -= tail.readBytes;
      scannedFiles += 1;
      if (tail.truncated) truncated = true;
      if (!tail.text) continue;
      let lineNo = 0;
      for (const line of tail.text.split(/\r?\n/)) {
        lineNo += 1;
        if (!line) continue;
        const entry = parseLine(line, file.name, lineNo);
        if (!entry) continue;
        if (cursorValue && !isOlderThanCursor(entry, cursorValue)) continue;
        if (safeLevels && !safeLevels.has(entry.level)) continue;
        if (safeSources && !safeSources.has(entry.source)) continue;
        if (cutoff && Date.parse(entry.timestamp) < cutoff) continue;
        if (query && !JSON.stringify(entry).toLowerCase().includes(query)) continue;
        collected.push(entry);
      }
      if (collected.length > safeLimit) {
        truncated = true;
        break;
      }
    }
    collected.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || (a._file < b._file ? 1 : a._file > b._file ? -1 : 0) || b._line - a._line);
    const entries = collected.slice(0, safeLimit).map(({ _file, _line, ...entry }) => entry);
    return {
      ok: true,
      entries,
      nextCursor: entries.length ? entries[entries.length - 1].cursor : null,
      truncated,
      scannedFiles,
    };
  }

  function recentErrorsCount(windowMinutes = 24 * 60) {
    return readEntries({ limit: 200, levels: new Set(['ERROR', 'FATAL']), windowMinutes }).entries.length;
  }

  function previewExport({ windowMinutes = 30, scanBudget = MAX_READ_BYTES } = {}) {
    const safeWindow = Math.max(1, Math.min(Number.isInteger(windowMinutes) ? windowMinutes : 30, 24 * 60));
    const result = readEntries({ limit: MAX_EXPORT_EVENTS, windowMinutes: safeWindow, scanBudget });
    const errors = result.entries.filter((e) => e.level === 'ERROR' || e.level === 'FATAL');
    return {
      ok: true,
      windowMinutes: safeWindow,
      entryCount: result.entries.length,
      errorCount: errors.length,
      truncated: result.truncated || result.scannedFiles === 0 && fileList().length > 0,
      files: fileList().filter((f) => f.date >= dateFromKey(dateKey(nowMs(now) - safeWindow * 60 * 1000))).map((f) => ({ name: f.name, kind: f.kind, size: f.size })),
      filesIncluded: ['README.txt', 'report.md', 'diagnostics.json', 'events.jsonl', 'errors.jsonl'],
    };
  }

  function safeDescription(value) {
    return safeUserText(value);
  }

  function buildReportMarkdown({ windowMinutes, entries, errors, diagnostics, environment = {}, description = '', repro = '' }) {
    const env = environment && typeof environment === 'object' ? environment : {};
    const diag = diagnostics && typeof diagnostics === 'object' ? diagnostics : null;
    const lines = [];
    lines.push('# Pi GUI 故障报告', '');
    lines.push(`- 生成时间（UTC）：${iso(nowMs(now))}`);
    lines.push(`- 报告窗口：最近 ${windowMinutes} 分钟`);
    lines.push(`- Pi GUI 版本：${token(env.appVersion) || version}`);
    if (token(env.electronVersion)) lines.push(`- Electron：${token(env.electronVersion)}`);
    if (token(env.nodeVersion)) lines.push(`- Node：${token(env.nodeVersion)}`);
    if (token(env.platform)) lines.push(`- OS / 架构：${token(env.platform)} / ${token(env.arch) || '未知'}`);
    if (diag && diag.pi && typeof diag.pi.version === 'string') lines.push(`- Pi：${scrubShortText(diag.pi.version, 80)}`);
    if (diag && diag.pi && typeof diag.pi.versionSource === 'string') lines.push(`- Pi 版本来源：${scrubShortText(diag.pi.versionSource, 80)}`);
    lines.push(`- 事件数量：${entries.length}${errors.length ? `；错误 ${errors.length}` : ''}`);
    lines.push('');
    lines.push('## 用户填写的问题描述', '');
    lines.push(description || '（未填写）');
    lines.push('', '## 用户填写的复现步骤', '');
    lines.push(repro || '（未填写）');
    lines.push('', '## 最近关键错误', '');
    if (!errors.length) lines.push('（窗口内没有 ERROR / FATAL 事件）');
    else {
      for (const e of errors.slice(-20)) {
        lines.push(`- ${e.timestamp} · ${e.level} · ${e.source} · ${e.event}${e.code ? ` · ${e.code}` : ''}`);
      }
    }
    lines.push('', '## 隐私说明', '');
    lines.push('本报告不包含聊天正文、模型回复、工具输入/输出、配置文件正文、环境变量、凭据、项目绝对路径或页面正文。');
    lines.push('用户填写的问题描述和复现步骤由用户主动提供，并已进行已知凭据/路径形态替换；发送前请再次自行检查。');
    lines.push('');
    return lines.join('\n');
  }

  function scrubJsonValue(value) {
    if (typeof value === 'string') return scrubLongText(value);
    if (Array.isArray(value)) return value.map((item) => scrubJsonValue(item));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|passwd|secret|cookie|session[-_]?token|pi_gui_token)/i.test(key)) {
        out[key] = '[REDACTED]';
      } else out[key] = scrubJsonValue(item);
    }
    return out;
  }

  function buildExport({ windowMinutes = 30, description = '', repro = '', diagnostics = null, environment = {}, scanBudget = MAX_READ_BYTES } = {}) {
    let result;
    try {
      const safeWindow = Math.max(1, Math.min(Number.isInteger(windowMinutes) ? windowMinutes : 30, 24 * 60));
      result = readEntries({ limit: MAX_EXPORT_EVENTS, windowMinutes: safeWindow, scanBudget });
      const entries = result.entries.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const errors = entries.filter((e) => e.level === 'ERROR' || e.level === 'FATAL');
      const safeDiagnostics = diagnostics && typeof diagnostics === 'object' ? scrubJsonValue(diagnostics) : { unavailable: true };
      const report = buildReportMarkdown({
        windowMinutes: safeWindow,
        entries,
        errors,
        diagnostics: safeDiagnostics,
        environment,
        description: safeDescription(description).text,
        repro: safeDescription(repro).text,
      });
      const readme = [
        'Pi GUI 故障报告', '',
        '这个 ZIP 用于把本机故障线索交给开发者或 AI，完全在本机生成，不会自动上传。',
        '包含固定五个文件：README.txt / report.md / diagnostics.json / events.jsonl / errors.jsonl。',
        '不包含聊天历史、项目文件、截图、配置文件正文、环境变量或凭据。',
        '用户填写的问题描述和复现步骤由用户主动提供；发送前请再次检查是否含私人信息。',
        '事件记录只包含稳定事件代码、来源、时间、关联标识和经白名单筛选的元信息。',
        '如果不需要，可直接删除本报告；应用不会自动发送它。',
        '',
      ].join('\n');
      const eventText = entries.map(({ cursor, ...entry }) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : '');
      const errorText = errors.map(({ cursor, ...entry }) => JSON.stringify(entry)).join('\n') + (errors.length ? '\n' : '');
      const diagText = JSON.stringify(safeDiagnostics, null, 2) + '\n';
      const totalBytes = Buffer.byteLength(readme) + Buffer.byteLength(report) + Buffer.byteLength(diagText)
        + Buffer.byteLength(eventText) + Buffer.byteLength(errorText);
      if (totalBytes > MAX_EXPORT_BYTES) throw Object.assign(Error('export_too_large'), { code: 'export_too_large' });
      const buffer = createZip([
        { name: 'README.txt', data: readme },
        { name: 'report.md', data: report },
        { name: 'diagnostics.json', data: diagText },
        { name: 'events.jsonl', data: eventText },
        { name: 'errors.jsonl', data: errorText },
      ]);
      const filename = `pi-gui-bugreport-${dateKey(nowMs(now))}-${iso(nowMs(now)).slice(11, 19).replace(/:/g, '')}.zip`;
      const manifest = {
        files: ['README.txt', 'report.md', 'diagnostics.json', 'events.jsonl', 'errors.jsonl'],
        entryCount: entries.length,
        errorCount: errors.length,
        bytes: buffer.length,
        truncated: result.truncated,
        windowMinutes: safeWindow,
      };
      if (settings.enabled) event('logs', 'logs.exported', {
        windowMinutes: safeWindow, entryCount: entries.length, errorCount: errors.length,
        fileCount: 5, bytes: buffer.length, truncated: result.truncated,
      });
      return { ok: true, buffer, filename, manifest };
    } catch (err) {
      const code = err && typeof err.code === 'string' ? err.code : 'export_failed';
      if (settings.enabled) event('logs', 'logs.export_failed', { reason: code });
      safeStatus('export_failed');
      return { ok: false, code: 'export_failed', reason: code };
    }
  }

  function updateSettings(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, code: 'invalid_settings' };
    }
    const next = { ...settings };
    if (Object.hasOwn(patch, 'enabled')) {
      if (typeof patch.enabled !== 'boolean') return { ok: false, code: 'invalid_settings' };
      next.enabled = patch.enabled;
    }
    if (Object.hasOwn(patch, 'mode')) {
      if (patch.mode !== 'standard' && patch.mode !== 'verbose') return { ok: false, code: 'invalid_settings' };
      next.mode = patch.mode;
      next.verboseUntil = patch.mode === 'verbose' ? iso(nowMs(now) + 24 * 60 * 60 * 1000) : null;
    }
    if (Object.hasOwn(patch, 'retentionDays')) {
      if (!VALID_RETENTION.has(patch.retentionDays)) return { ok: false, code: 'invalid_settings' };
      next.retentionDays = patch.retentionDays;
    }
    if (Object.hasOwn(patch, 'maxTotalMB')) {
      if (!VALID_TOTAL_MB.has(patch.maxTotalMB)) return { ok: false, code: 'invalid_settings' };
      next.maxTotalMB = patch.maxTotalMB;
    }
    if (next.mode === 'verbose' && !next.verboseUntil) next.verboseUntil = iso(nowMs(now) + 24 * 60 * 60 * 1000);
    const old = settings;
    settings = next;
    if (!persistSettings()) {
      settings = old;
      return { ok: false, code: 'settings_write_failed' };
    }
    settingsCorrupt = false;
    if (settings.enabled) {
      event('logs', 'logs.settings_changed', {
        enabled: settings.enabled, mode: settings.mode, retentionDays: settings.retentionDays,
        maxTotalMB: settings.maxTotalMB, clientCount: 0,
      });
    }
    prune();
    return { ok: true, status: status() };
  }

  function clearLogs() {
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    queue = [];
    queueBytes = 0;
    const files = fileList();
    let removed = 0, bytes = 0;
    for (const file of files) {
      try {
        fsApi.unlinkSync(file.path);
        removed += 1;
        bytes += file.size;
      } catch { /* noop */ }
    }
    active = new Map();
    lastUsage = { bytes: 0, files: 0 };
    return { ok: true, fileCount: removed, bytes };
  }

  function close({ reason = 'exit' } = {}) {
    if (closed) return;
    if (settings.enabled) {
      event('app', 'app.exit', { role: processName(role), reason: token(reason) || 'exit', durationMs: nowMs(now) - startedAt });
    }
    flushSync();
    writeMarker(true);
    closed = true;
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
  }

  /* 初始化：目录、设置、上一个会话标记、启动事件。失败只降级，不抛。 */
  ensureDir();
  readSettings();
  prune();
  const previous = readMarker();
  if (previous) {
    startup.previousUnclean = {
      runId: previous.runId,
      startedAt: typeof previous.startedAt === 'string' ? previous.startedAt : null,
      uptimeMs: Number.isFinite(previous.startedAt) ? Math.max(0, nowMs(now) - Date.parse(previous.startedAt)) : null,
    };
  }
  writeMarker(false);
  if (settings.enabled && dirWritable) {
    if (startup.previousUnclean) {
      event('app', 'app.previous_unclean_exit', {
        role: processName(role),
        uptimeMs: startup.previousUnclean.uptimeMs ?? undefined,
      });
    }
    event('app', 'app.start', {
      role: processName(role),
      version,
      platform: token(process.platform),
      arch: token(process.arch),
      nodeVersion: token(process.version),
      electronVersion: token(process.versions && process.versions.electron),
      mode: effectiveMode(),
    });
  }

  function safeSummaryText({ diagnostics = null } = {}) {
    const st = status();
    const lines = [];
    lines.push('Pi GUI 安全诊断摘要');
    lines.push(`生成时间（UTC）：${iso(nowMs(now))}`);
    lines.push(`Pi GUI：${version}`);
    lines.push(`日志：${st.enabled ? '开启' : '关闭'} · ${st.mode} · ${st.fileCount} 个文件 · ${st.usageBytes} 字节`);
    if (st.lastErrorCode) lines.push(`日志状态：degraded（${st.lastErrorCode}）`);
    if (st.session.previousUnclean) lines.push(`上次运行：异常退出（${st.session.previousUnclean.startedAt || '时间未知'}）`);
    if (diagnostics && diagnostics.app) lines.push(`应用版本：${scrubShortText(diagnostics.app.version || '未知', 80)}`);
    if (diagnostics && diagnostics.system) lines.push(`系统：${scrubShortText([diagnostics.system.os, diagnostics.system.release, diagnostics.system.arch].filter(Boolean).join(' '), 160)}`);
    if (diagnostics && diagnostics.project) lines.push(`项目：${diagnostics.project.selected ? '已选择' : '未选择'}`);
    if (diagnostics && diagnostics.bridge) lines.push(`Bridge：${diagnostics.bridge.piRunning ? '运行中' : '未运行'} · run ${diagnostics.bridge.bridgeRun ?? '?'}`);
    if (st.recentErrors.length) {
      lines.push('最近错误：');
      for (const error of st.recentErrors) lines.push(`- ${error.timestamp} ${error.level} ${error.source} ${error.event}${error.code ? ' ' + error.code : ''}`);
    }
    lines.push('不含聊天正文、工具输出、配置文件内容、环境变量、凭据或绝对路径。');
    return lines.join('\n');
  }

  return {
    dir,
    role: processName(role),
    runId,
    event,
    crash,
    log: event,
    flush,
    flushSync,
    status,
    readEntries,
    previewExport,
    buildExport,
    updateSettings,
    clearLogs,
    close,
    safeSummaryText,
    getSettings: () => ({ ...settings }),
    isEnabled: loggingEnabled,
    refreshSettings,
    MAX_FILE_BYTES,
    DEFAULT_SETTINGS,
  };
}

module.exports = {
  createLogCore,
  DEFAULT_SETTINGS,
  MAX_FILE_BYTES,
  MAX_EXPORT_EVENTS,
  MAX_EXPORT_BYTES,
  MAX_READ_BYTES,
  scrubShortText,
  parseFileMeta,
  FILE_RE,
};
