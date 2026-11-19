/* 会话标题的持久化归属（Pi GUI 自己的元数据，不写 Pi 的 JSONL）。
 *
 * ---------- 为什么不是直接改会话文件 ----------
 *
 * 自动标题看起来「写进会话文件最自然」，但 Pi 正在往同一个文件追加内容。
 * 在 Pi 或 Agent 持有写句柄时改 JSONL，既不安全，也会把 Pi 自己的 session
 * schema 变成第二个真相。用户手动改名已经由 Pi 的 `set_session_name` 负责，
 * 我们只保存**自己产生的**自动标题与显式采纳的覆盖标题，按原生会话 id 关联。
 *
 * ---------- 优先级 ----------
 *
 *   Pi GUI 显式覆盖（用户确认采纳） > 原生手动名 > 自动标题 > 首条消息 > 默认
 *
 * 原生手动名永远不覆盖：自动结果迟到时会被丢弃；显式覆盖也只在「采纳时的
 * 原生名没有变化」期间有效，用户之后在 Pi 里改名，原生名重新获胜。
 *
 * ---------- 文件与失败边界 ----------
 *
 * `<DATA_DIR>/session-titles.json` + `<DATA_DIR>/session-title-settings.json`，
 * 原子写（同目录临时文件 + rename，0600）。坏文件不拖垮启动：先把原文件
 * 备份成 `.corrupt-<时间>`，再以空状态继续；宁可丢标题，也不能让侧栏打不开。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TITLES_FILE = 'session-titles.json';
const SETTINGS_FILE = 'session-title-settings.json';
const MAX_TITLE = 80;
const MAX_NATIVE = 80;
const MAX_ENTRIES = 1000;
const KEY_RE = /^(?:classic|runtime):[A-Za-z0-9._-]{1,128}$/;

function cleanText(value, max = MAX_TITLE) {
  if (typeof value !== 'string') return '';
  /* 控制字符（含换行）不是标题；折叠空白后再限长。 */
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, max);
}

function iso(value) {
  if (typeof value !== 'string' || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function entryShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  if (value.auto && typeof value.auto === 'object' && !Array.isArray(value.auto)) {
    const title = cleanText(value.auto.title);
    if (title) out.auto = {
      title,
      at: iso(value.auto.at) || new Date(0).toISOString(),
      providerId: cleanText(value.auto.providerId, 200),
      modelId: cleanText(value.auto.modelId, 200),
    };
  }
  if (value.manual && typeof value.manual === 'object' && !Array.isArray(value.manual)) {
    const title = cleanText(value.manual.title);
    if (title) out.manual = {
      title,
      at: iso(value.manual.at) || new Date(0).toISOString(),
      nativeNameAt: cleanText(value.manual.nativeNameAt, MAX_NATIVE) || null,
    };
  }
  if (value.attempt && typeof value.attempt === 'object' && !Array.isArray(value.attempt)) {
    const at = iso(value.attempt.at);
    if (at) out.attempt = { at, revision: Number.isSafeInteger(value.attempt.revision) ? value.attempt.revision : 0 };
  }
  out.updatedAt = iso(value.updatedAt) || out.manual?.at || out.auto?.at || out.attempt?.at || new Date(0).toISOString();
  return out;
}

export function createSessionTitleStore({
  dataDir,
  now = () => new Date(),
  maxEntries = MAX_ENTRIES,
  logEvent = () => {},
} = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('session-title-store: dataDir required');
  fs.mkdirSync(dataDir, { recursive: true });
  const titlesPath = path.join(dataDir, TITLES_FILE);
  const settingsPath = path.join(dataDir, SETTINGS_FILE);
  const entries = new Map();
  let settings = null;
  let titlesCorrupt = false;
  let settingsCorrupt = false;

  const stamp = () => iso(now().toISOString()) || new Date().toISOString();
  const safeLog = (event, details = {}) => {
    try {
      logEvent(event, details);
    } catch {
      /* 观察失败不影响存储 */
    }
  };

  /* 坏文件先备份再继续。备份失败也不阻塞 —— 数据目录不可写时，功能本身
   * 会以只读方式降级，但会话列表仍然必须能打开。 */
  function backup(file) {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }

  function atomicWrite(file, payload) {
    const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* rename 后临时文件已不存在 */ }
    }
  }

  function readJson(file) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('too_large');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /* ---------- 设置 ---------- */

  function defaultSettings() {
    const at = stamp();
    return { version: 1, autoEnabled: true, enabledAt: at, revision: 1 };
  }

  function loadSettings() {
    let raw = null;
    try {
      raw = readJson(settingsPath);
    } catch {
      settingsCorrupt = true;
      safeLog('session-title.settings_corrupt', { code: 'settings_corrupt' });
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      /* 解析成功但形状不对同样是坏文件：先留一份再覆盖。文件不存在
       * （raw=null）时没有可备份的内容，不生成空备份。 */
      if (raw !== null) {
        backup(settingsPath);
        settingsCorrupt = false;
        safeLog('session-title.settings_corrupt', { code: 'settings_shape' });
      } else if (settingsCorrupt) {
        backup(settingsPath);
        settingsCorrupt = false;
      }
      settings = defaultSettings();
      try { atomicWrite(settingsPath, settings); } catch { /* 只读数据目录：内存态仍可用 */ }
      return;
    }
    const autoEnabled = raw.autoEnabled !== false;
    const enabledAt = iso(raw.enabledAt) || stamp();
    const revision = Number.isSafeInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1;
    settings = { version: 1, autoEnabled, enabledAt, revision };
  }

  function saveSettings() {
    if (settingsCorrupt) {
      backup(settingsPath);
      settingsCorrupt = false;
    }
    atomicWrite(settingsPath, settings);
  }

  /* ---------- 标题 ---------- */

  function loadTitles() {
    let raw = null;
    try {
      raw = readJson(titlesPath);
    } catch {
      titlesCorrupt = true;
      safeLog('session-title.titles_corrupt', { code: 'titles_corrupt' });
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.items)) {
      /* 形状不对也算坏文件；下一次保存会覆盖，因此先备份。 */
      if (raw !== null) {
        backup(titlesPath);
        titlesCorrupt = false;
        safeLog('session-title.titles_corrupt', { code: 'titles_shape' });
      }
      return;
    }
    /* 文件最多 4MB；先按 updatedAt 从新到旧排序，再截到上限，
     * 不能因为文件里旧条目排在前面就把新标题丢掉。 */
    const ordered = raw.items
      .filter((item) => item && typeof item === 'object')
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, maxEntries);
    for (const item of ordered) {
      if (!item || typeof item !== 'object' || !KEY_RE.test(item.key || '')) continue;
      const shape = entryShape(item);
      if (shape) entries.set(item.key, shape);
    }
  }

  function prune() {
    if (entries.size <= maxEntries) return;
    const ordered = [...entries.entries()].sort((a, b) => String(a[1].updatedAt).localeCompare(String(b[1].updatedAt)));
    for (const [key] of ordered.slice(0, entries.size - maxEntries)) entries.delete(key);
  }

  function saveTitles() {
    if (titlesCorrupt) {
      backup(titlesPath);
      titlesCorrupt = false;
    }
    prune();
    const items = [...entries.entries()].map(([key, value]) => ({ key, ...value }));
    atomicWrite(titlesPath, { version: 1, items });
  }

  function writeEntry(key, mutate) {
    if (!KEY_RE.test(key)) return null;
    const current = entries.get(key) || {};
    const next = mutate({ ...current });
    if (!next) return null;
    entries.set(key, next);
    try {
      saveTitles();
    } catch (err) {
      safeLog('session-title.store_write_failed', { code: 'store_write_failed' });
      throw err;
    }
    return next;
  }

  loadSettings();
  loadTitles();

  const keyFor = (scope, id) => {
    /* 只接受后端已经证明过的 id 形态；前端传来的任何字符串都不能变成
     * 一个可以命名任意键的入口。 */
    if (scope === 'classic' && typeof id === 'string' && id) return `classic:${id}`;
    if (scope === 'runtime' && typeof id === 'string' && id) return `runtime:${id}`;
    return null;
  };

  /**
   * 解析显示标题。同步、无 IO —— 会话列表每次扫描都会调用它。
   *
   * @returns {{title:string, source:'manual'|'auto'|'fallback'|'default', key:string|null,
   *            native:boolean, manualOverride:boolean}}
   */
  function resolve({ scope, sessionId, conversationId, nativeName = '', fallback = '', defaultTitle = '（还没有消息）' } = {}) {
    const id = scope === 'runtime' ? conversationId : sessionId;
    const key = keyFor(scope, id);
    const entry = key ? entries.get(key) : null;
    const native = cleanText(nativeName, MAX_NATIVE);
    const first = cleanText(fallback);
    const def = cleanText(defaultTitle) || '（还没有消息）';

    if (entry?.manual) {
      const atApply = entry.manual.nativeNameAt || '';
      if (atApply === native) {
        return { title: entry.manual.title, source: 'manual', key, native: Boolean(native), manualOverride: true };
      }
      /* 采纳之后用户又在 Pi 里改了名：原生名重新获胜，覆盖自然失效。 */
    }
    if (native) return { title: native, source: 'manual', key, native: true, manualOverride: false };
    if (entry?.auto) return { title: entry.auto.title, source: 'auto', key, native: false, manualOverride: false };
    if (first) return { title: first, source: 'fallback', key, native: false, manualOverride: false };
    return { title: def, source: 'default', key, native: false, manualOverride: false };
  }

  function entry(key) {
    if (!KEY_RE.test(key || '')) return null;
    return entries.get(key) || null;
  }

  function attempted(key) {
    return Boolean(entry(key)?.attempt);
  }

  function recordAttempt(key, revision = 0) {
    const at = stamp();
    return writeEntry(key, (current) => {
      if (current.attempt || current.auto || current.manual) return null;
      return { ...current, attempt: { at, revision: Number.isSafeInteger(revision) ? revision : 0 }, updatedAt: at };
    });
  }

  function setAuto(key, { title, providerId = '', modelId = '' } = {}) {
    const value = cleanText(title);
    if (!value) return null;
    const at = stamp();
    return writeEntry(key, (current) => ({
      ...current,
      auto: { title: value, at, providerId: cleanText(providerId, 200), modelId: cleanText(modelId, 200) },
      updatedAt: at,
    }));
  }

  function setManual(key, { title, nativeNameAt = '' } = {}) {
    const value = cleanText(title);
    if (!value) return null;
    const at = stamp();
    return writeEntry(key, (current) => ({
      ...current,
      manual: { title: value, at, nativeNameAt: cleanText(nativeNameAt, MAX_NATIVE) || null },
      updatedAt: at,
    }));
  }

  /** 用户显式清除覆盖（例如采纳后又想回到原生名）。 */
  function clearManual(key) {
    if (!entry(key)?.manual) return true;
    const at = stamp();
    return Boolean(writeEntry(key, (current) => {
      const next = { ...current, updatedAt: at };
      delete next.manual;
      return next;
    }));
  }

  function forget(key) {
    if (!KEY_RE.test(key || '') || !entries.has(key)) return false;
    entries.delete(key);
    try { saveTitles(); } catch { /* 删除不了条目不该让删除会话失败 */ }
    return true;
  }

  function forgetClassic(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    return forget(`classic:${sessionId}`);
  }

  function updateSettings({ autoEnabled } = {}) {
    if (typeof autoEnabled !== 'boolean') return settings;
    if (settings.autoEnabled === autoEnabled) return settings;
    const previous = settings;
    const at = stamp();
    settings = {
      version: 1,
      autoEnabled,
      /* 重新开启时重置门槛：只对「这次开启之后新建」的会话生效，
       * 不批量补历史会话。 */
      enabledAt: autoEnabled ? at : settings.enabledAt,
      revision: settings.revision + 1,
    };
    try {
      saveSettings();
    } catch {
      settings = previous;
      safeLog('session-title.settings_write_failed', { code: 'settings_write_failed' });
      throw new Error('settings_write_failed');
    }
    return settings;
  }

  return {
    resolve,
    keyFor,
    entry,
    attempted,
    recordAttempt,
    setAuto,
    setManual,
    clearManual,
    forget,
    forgetClassic,
    settings: () => ({ ...settings }),
    updateSettings,
    paths: { titles: titlesPath, settings: settingsPath },
    _internals: { cleanText, entryShape, KEY_RE },
  };
}
