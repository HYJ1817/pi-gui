/* 会话标题的持久化归属（Pi GUI 自己的元数据，不写 Pi 的 JSONL）。
 *
 * ---------- 为什么不是直接改会话文件 ----------
 *
 * 自动标题看起来「写进会话文件最自然」，但 Pi 正在往同一个文件追加内容。
 * 在 Pi 或 Agent 持有写句柄时改 JSONL，既不安全，也会把 Pi 自己的 session
 * schema 变成第二个真相。用户手动改名由 Pi 的 `set_session_name` 负责时，
 * 我们只读它写下的 `session_info`；pi-GUI 自己的改名与 AI 标题保存在
 * `<DATA_DIR>/session-titles.json`，按原生会话 id 关联。
 *
 * ---------- 优先级与版本 ----------
 *
 *   Pi GUI 手动标题（用户输入 / 确认采纳） > 原生手动名 > 自动标题 > 首条消息 > 默认
 *
 * 每条记录有单调递增的 `revision`。生成任务、改名请求、确认提案都捕获
 * revision，应用前再核对；revision 不一致就丢弃，字符串相同也不能绕过。
 * `nativeName` 是最后一次确认过的原生名：用户在 Pi 里改名后，revision 也会
 * 增长，旧的 manual 覆盖失效，原生名重新获胜。
 *
 * ---------- 文件与失败边界 ----------
 *
 * `<DATA_DIR>/session-titles.json` + `<DATA_DIR>/session-title-settings.json`，
 * 原子写（同目录临时文件 + rename，0600）。坏文件不拖垮启动：先把原文件
 * 备份成 `.corrupt-<时间>`，再以空状态继续；宁可丢标题，也不能让侧栏打不开。
 *
 * 记录容量只清理「没有正式标题」的失败 attempt。manual / auto 属于仍然有效的
 * 会话标题，不因记录数量超限被删除；永久删除会话时由上层显式 forget。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TITLES_FILE = 'session-titles.json';
const SETTINGS_FILE = 'session-title-settings.json';
const MAX_TITLE = 80;
const MAX_NATIVE = 80;
const MAX_ENTRIES = 1000;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
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
      /* 旧记录没有这个字段：当时的手动标题只会在完整读取或已知原生名时写入，
       * 按已确认处理。新写入若来自截断且尾部未能确认的文件，会显式记 false。 */
      nativeNameConfirmed: value.manual.nativeNameConfirmed !== false,
    };
  }
  if (value.attempt && typeof value.attempt === 'object' && !Array.isArray(value.attempt)) {
    const at = iso(value.attempt.at);
    if (at) out.attempt = { at, revision: Number.isSafeInteger(value.attempt.revision) ? value.attempt.revision : 0 };
  }
  out.revision = Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0;
  /* 旧数据没有 nativeName：manual 的 nativeNameAt 就是当时的原生名快照。
   * 没有 manual 的旧记录保持空快照，等第一次确认到真实原生名时再迁移。 */
  out.nativeName = cleanText(value.nativeName, MAX_NATIVE)
    || out.manual?.nativeNameAt || '';
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
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw new Error('too_large');
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
    /* 不按记录数截断正式标题：旧会话的 manual / auto 仍然有效。
     * attempt-only 记录由 prune() 单独限额。 */
    for (const item of raw.items) {
      if (!item || typeof item !== 'object' || !KEY_RE.test(item.key || '')) continue;
      const shape = entryShape(item);
      if (shape) entries.set(item.key, shape);
    }
  }

  function prune() {
    /* 只清理没有正式标题的失败 attempt。manual / auto 属于用户可见标题，
     * 不能因为条数超限被静默删除 —— 那会让旧会话重新显示成首条消息。 */
    const expendable = [...entries.entries()]
      .filter(([, value]) => !value.manual && !value.auto)
      .sort((a, b) => String(a[1].updatedAt).localeCompare(String(b[1].updatedAt)));
    const overflow = expendable.length - maxEntries;
    for (let i = 0; i < overflow; i++) entries.delete(expendable[i][0]);
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
    /* 先留一份写入前的内存态。saveTitles() 里的 prune() 也可能删条目，
     * 所以回滚必须覆盖整个 Map，而不只是被写的 key。 */
    const snapshot = new Map(entries);
    entries.set(key, next);
    try {
      saveTitles();
    } catch (err) {
      /* 持久化失败必须回滚内存：否则界面提示改名失败，下一次 resolve
       * 却返回新标题，重启后又变回旧值 —— 三处各说各话。 */
      entries.clear();
      for (const [k, value] of snapshot) entries.set(k, value);
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
   * 原生名变化时让旧的 manual 覆盖永久失效。只在 nativeConfirmed 时调用。
   *
   * 不能把「头部读不到 nativeName」当成「用户删掉了名字」：大头文件后部可能
   * 还有更新的 session_info。读不完整时 resolve 会保守地继续使用旧快照。
   */
  function reconcileNative(key, current, native) {
    if ((current.nativeName || '') === native) return current;
    const at = stamp();
    if (current.manual && current.manual.nativeNameConfirmed === false) {
      /* 手动标题写入时文件被截断、尾部没能确认原生名：这份 manual 的
       * nativeNameAt 是「未知」而不是「空」。后来确认到的原生名不能当成
       * 「用户在 Pi 里改名」—— 那会把用户刚改的标题删掉。这里把确认到的
       * 原生名补成新快照，保留手动标题；之后再改名仍按正常规则失效。 */
      const next = {
        ...current,
        nativeName: native,
        manual: { ...current.manual, nativeNameAt: native, nativeNameConfirmed: true },
        updatedAt: at,
        revision: (current.revision || 0) + 1,
      };
      entries.set(key, next);
      try {
        saveTitles();
      } catch {
        safeLog('session-title.store_write_failed', { code: 'store_write_failed' });
      }
      return next;
    }
    const next = { ...current, nativeName: native, updatedAt: at, revision: (current.revision || 0) + 1 };
    delete next.manual;
    entries.set(key, next);
    try {
      saveTitles();
    } catch {
      safeLog('session-title.store_write_failed', { code: 'store_write_failed' });
    }
    return next;
  }

  /**
   * 解析显示标题。同步、无 IO —— 会话列表每次扫描都会调用它。
   *
   * @param nativeConfirmed 原生名是否来自完整文件或文件尾部的最新 session_info。
   *   读取被截断且尾部没有确认时传 false：旧的 manual 不会被误判过期。
   * @returns {{title:string, source:'manual'|'auto'|'fallback'|'default', key:string|null,
   *            native:boolean, manualOverride:boolean, revision:number}}
   */
  function resolve({
    scope, sessionId, conversationId, nativeName = '', fallback = '',
    defaultTitle = '（还没有消息）', nativeConfirmed = true,
  } = {}) {
    const id = scope === 'runtime' ? conversationId : sessionId;
    const key = keyFor(scope, id);
    let entry = key ? entries.get(key) : null;
    const native = cleanText(nativeName, MAX_NATIVE);
    const first = cleanText(fallback);
    const def = cleanText(defaultTitle) || '（还没有消息）';

    /* 没有任何标题记录的会话也要跟踪原生名快照：原生改名是权威标题变化，
     * revision 必须递增，否则「旧列表 / 旧切换应答」会在同修订下把新原生名
     * 顶回去。只登记在内存里、不单独落盘（列表扫描不能为每个会话各写一次
     * 存储），下一次任何标题写入会顺带保存它。 */
    if (key && !entry && nativeConfirmed && native) {
      entry = { nativeName: native, revision: 1, updatedAt: stamp() };
      entries.set(key, entry);
    }

    if (entry && nativeConfirmed) entry = reconcileNative(key, entry, native);

    const manual = entry?.manual;
    const snapshot = entry ? (entry.nativeName || '') : '';
    const manualActive = Boolean(manual) && (
      nativeConfirmed ? native === (manual.nativeNameAt || '') : snapshot === (manual.nativeNameAt || '')
    );

    if (manualActive) {
      return { title: manual.title, source: 'manual', key, native: Boolean(native), manualOverride: true,
        revision: entry.revision || 0 };
    }
    if (native) return { title: native, source: 'manual', key, native: true, manualOverride: false,
      revision: entry?.revision || 0 };
    if (entry?.auto) return { title: entry.auto.title, source: 'auto', key, native: false, manualOverride: false,
      revision: entry.revision || 0 };
    if (first) return { title: first, source: 'fallback', key, native: false, manualOverride: false,
      revision: entry?.revision || 0 };
    return { title: def, source: 'default', key, native: false, manualOverride: false,
      revision: entry?.revision || 0 };
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

  function setAuto(key, { title, providerId = '', modelId = '', nativeName = '', expectedRevision = null } = {}) {
    const value = cleanText(title);
    if (!value) return null;
    const at = stamp();
    let conflict = null;
    const result = writeEntry(key, (current) => {
      if (Number.isSafeInteger(expectedRevision) && (current.revision || 0) !== expectedRevision) {
        conflict = { revision: current.revision || 0 };
        return null;
      }
      return {
        ...current,
        auto: { title: value, at, providerId: cleanText(providerId, 200), modelId: cleanText(modelId, 200) },
        nativeName: cleanText(nativeName, MAX_NATIVE) || current.nativeName || '',
        revision: (current.revision || 0) + 1,
        updatedAt: at,
      };
    });
    if (!result && conflict) return { ok: false, code: 'revision_conflict', revision: conflict.revision };
    return result;
  }

  function setManual(key, {
    title, nativeNameAt = '', nativeName = undefined, nativeNameConfirmed = true, expectedRevision = null,
  } = {}) {
    const value = cleanText(title);
    if (!value) return null;
    const at = stamp();
    let conflict = null;
    const result = writeEntry(key, (current) => {
      if (Number.isSafeInteger(expectedRevision) && (current.revision || 0) !== expectedRevision) {
        conflict = { revision: current.revision || 0 };
        return null;
      }
      return {
        ...current,
        manual: {
          title: value, at,
          nativeNameAt: cleanText(nativeNameAt, MAX_NATIVE) || null,
          /* false 表示写入时未能确认原生名（文件截断且尾部也没读到）；
           * 这样的快照是「未知」，不能拿来判定用户后来有没有改名。 */
          nativeNameConfirmed: nativeNameConfirmed !== false,
        },
        nativeName: nativeName === undefined
          ? (cleanText(nativeNameAt, MAX_NATIVE) || current.nativeName || '')
          : cleanText(nativeName, MAX_NATIVE),
        revision: (current.revision || 0) + 1,
        updatedAt: at,
      };
    });
    if (!result && conflict) return { ok: false, code: 'revision_conflict', revision: conflict.revision };
    return result;
  }

  /** 用户显式清除覆盖（例如采纳后又想回到原生名）。 */
  function clearManual(key) {
    if (!entry(key)?.manual) return true;
    const at = stamp();
    return Boolean(writeEntry(key, (current) => {
      const next = { ...current, updatedAt: at, revision: (current.revision || 0) + 1 };
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

  function forgetRuntime(conversationId) {
    if (typeof conversationId !== 'string' || !conversationId) return false;
    return forget(`runtime:${conversationId}`);
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
    forgetRuntime,
    settings: () => ({ ...settings }),
    updateSettings,
    paths: { titles: titlesPath, settings: settingsPath },
    _internals: { cleanText, entryShape, KEY_RE, MAX_TITLE, prune },
  };
}
