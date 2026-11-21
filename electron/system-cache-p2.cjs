'use strict';

const { randomUUID } = require('node:crypto');
const { createSessionDiskRoot, validBytes } = require('./system-cache-disk.cjs');
const SCOPE = 'system-cache-p2';
const METADATA = Object.freeze({
  http: Object.freeze({ id: 'default-session-http-cache', owner: 'electron.defaultSession', medium: 'disk',
    source: 'session.getCacheSize+validated-file-allocation' }),
  browser: Object.freeze({ id: 'browser-memory-http-cache', owner: 'electron.browser', medium: 'memory', source: 'session.getCacheSize' }),
  runtime: Object.freeze({ id: 'runtime-memory-http-cache', owner: 'electron.runtimeBrowserHost', medium: 'memory', source: 'session.getCacheSize' }),
  code: Object.freeze({ id: 'default-session-code-cache', owner: 'electron.defaultSession', medium: 'disk', source: 'validated-code-cache-file-allocation' }),
});
const EXCLUDED = Object.freeze([
  Object.freeze({ id: 'gpu-cache', reason: 'no_proven_safe_official_clear_api' }),
  Object.freeze({ id: 'mcp-registry-cache', reason: 'backend_owner_adapter_not_connected' }),
]);
const memorySession = s => {
  try { return !!s && s.isPersistent() === false && s.getStoragePath() === null
    && typeof s.getCacheSize === 'function' && typeof s.clearCache === 'function'; } catch { return false; }
};
const sameSessions = (a, b) => a.length === b.length && a.every(s => b.includes(s));
const sum = values => values.every(validBytes) && validBytes(values.reduce((a, b) => a + b, 0))
  ? values.reduce((a, b) => a + b, 0) : null;
const active = entry => entry.detail.status !== 'excluded';
const hasData = detail => detail.bytes > 0 || detail.cacheBytes > 0;

/* MAIN-ONLY CONTRACT (never forward providers/diskOptions over IPC):
 * createSystemCache({session: legacySession, providers: {
 *   defaultSession: electron.session.defaultSession,
 *   browserSession: legacySession,              // optional alias of `session`
 *   getBuckets: () => registeredSessionObjects // sync, array of Session refs
 * }}). The host must enumerate ALL allocated Runtime Sessions, including closed
 * views; do not create partitions from renderer ids or infer them from focus/wc.
 * Capture these references when allocating a controller, release on owner retire.
 * The default Session must retain Chromium's default Cache / Code Cache paths;
 * an embedding using setCodeCachePath must omit/disable codeCache explicitly.
 *
 * P2 `bytes = diskBytes + memoryBytes`: diskBytes is a bounded, validated sum of
 * actual file allocation, NOT getCacheSize's logical HTTP payload. `cacheBytes`
 * retains the official HTTP size (or Code Cache file lengths). Directory blocks
 * and excluded trees are not counted. A decrease is evidence for these files,
 * not a promise about volume free space, pending OS handles or running writers.
 * Unknown component totals stay null. Only main construction selects providers;
 * measure() takes no selectors and clear() accepts just {confirm,ticket}.
 */
function createProviderCache({ session, providers, now = Date.now, diskOptions } = {}) {
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)
    || Object.keys(providers).some(k => !['defaultSession', 'browserSession', 'getBuckets', 'codeCache'].includes(k))) {
    throw new TypeError('invalid main cache providers');
  }
  const defaultSession = providers.defaultSession, browserSession = providers.browserSession ?? session;
  const getBuckets = providers.getBuckets;
  if (getBuckets !== undefined && typeof getBuckets !== 'function') throw new TypeError('getBuckets must be a main callback');
  const disk = defaultSession ? createSessionDiskRoot(defaultSession, diskOptions) : null;
  const groups = [
    { key: 'http', sessions: defaultSession ? [defaultSession] : [], included: !!defaultSession, tree: 'Cache' },
    { key: 'browser', sessions: browserSession ? [browserSession] : [], included: !!browserSession },
    { key: 'runtime', sessions: [], included: typeof getBuckets === 'function' },
    { key: 'code', sessions: defaultSession ? [defaultSession] : [], tree: 'Code Cache',
      included: !!defaultSession && providers.codeCache !== false && typeof defaultSession.clearCodeCaches === 'function' },
  ];
  let pending = false, disposed = false, ticket = null;
  const supported = groups.some(g => g.included);
  const failure = (code, extra = {}) => ({ ok: false, status: 'unknown', bytes: null, diskBytes: null, memoryBytes: null,
    scope: SCOPE, code, buckets: groups.map(g => ({ ...(g.included ? unknown(g) : excluded(g)).detail })),
    excluded: EXCLUDED.map(e => ({ ...e })), error: ['cache_changed', 'cache_confirmation_expired'].includes(code)
      ? '缓存目标或容量已变化，或确认已过期，请重新统计后确认。'
      : code === 'cache_busy' ? '缓存操作正在进行，请稍后重试。' : '无法安全读取或清理缓存，请稍后重试。', ...extra });
  function runtimeSessions() {
    if (!getBuckets) return [];
    const result = getBuckets();
    if (result && typeof result.then === 'function') {
      // A mistaken async adapter is unsupported, not an unhandled rejection.
      void Promise.resolve(result).catch(() => {});
      throw Error('cache_targets_unknown');
    }
    if (!Array.isArray(result) || result.length > 64 || result.some(s => !s || typeof s !== 'object')) throw Error('cache_targets_unknown');
    return [...new Set(result)].filter(s => s !== browserSession && s !== defaultSession);
  }
  function targets() { return runtimeSessions(); }
  function guard(expected) {
    if (disposed || !sameSessions(expected, targets())) throw Error('cache_targets_changed');
    for (const s of [browserSession, ...expected]) if (s && !memorySession(s)) throw Error('cache_targets_changed');
    if (defaultSession && (!disk.qualified() || typeof defaultSession.getCacheSize !== 'function'
      || typeof defaultSession.clearCache !== 'function')) throw Error('cache_targets_changed');
  }
  function unknown(group) {
    return { group, detail: { ...METADATA[group.key], status: 'unknown', bytes: null, diskBytes: group.tree ? null : 0,
      memoryBytes: group.tree ? 0 : null, cacheBytes: null, code: 'cache_measure_failed' } };
  }
  function excluded(group) {
    return { group, detail: { ...METADATA[group.key], status: 'excluded', bytes: null, diskBytes: null, memoryBytes: null,
      cacheBytes: null, code: 'provider_not_connected' } };
  }
  async function read(group, runtime, expected) {
    if (!group.included) return excluded(group);
    try {
      guard(runtime);
      const sessions = group.key === 'runtime' ? runtime : group.sessions;
      const samples = new Map();
      let cacheBytes;
      if (group.key !== 'code') {
        for (const s of sessions) {
          if (!group.tree && !memorySession(s)) throw Error('cache_targets_changed');
          const size = await s.getCacheSize();
          guard(runtime);
          if (!validBytes(size)) throw Error('cache_size_unknown');
          samples.set(s, size);
        }
        cacheBytes = sum([...samples.values()]);
        if (cacheBytes === null) throw Error('cache_size_unknown');
      }
      const files = group.tree ? await disk.scan(group.tree, expected?.files) : null;
      guard(runtime);
      if (files && group.key === 'code') cacheBytes = files.contentBytes;
      const diskBytes = files ? files.diskBytes : 0, memoryBytes = files ? 0 : cacheBytes;
      const detail = { ...METADATA[group.key], status: diskBytes + memoryBytes === 0 && cacheBytes === 0 ? 'empty' : 'ready',
        bytes: diskBytes + memoryBytes, diskBytes, memoryBytes, cacheBytes,
        sessionCount: sessions.length, ...(files ? { diskEvidence: 'validated-file-allocation', fileCount: files.files } : {}) };
      return { group, detail, samples, files };
    } catch {
      // Code Cache is optional. An unverifiable tree is explicitly excluded,
      // never represented as empty or cleared, and cannot block safe HTTP work.
      return group.key === 'code' && (!expected || !active(expected))
        ? { ...excluded(group), detail: { ...excluded(group).detail, code: 'code_cache_unverifiable' } } : unknown(group);
    }
  }
  async function collect(runtime, expected) {
    const entries = [];
    for (const group of groups) entries.push(await read(group, runtime, expected?.find(e => e.group === group)));
    try { guard(runtime); }
    catch { return entries.map(e => e.group.included ? unknown(e.group) : e); }
    return entries;
  }
  function totals(entries) {
    const included = entries.filter(active).map(e => e.detail);
    return { bytes: sum(included.map(d => d.bytes)), diskBytes: sum(included.map(d => d.diskBytes)),
      memoryBytes: sum(included.map(d => d.memoryBytes)), buckets: entries.map(e => ({ ...e.detail })),
      excluded: EXCLUDED.map(e => ({ ...e })) };
  }
  function complete(entries) { return entries.filter(active).every(e => e.detail.status !== 'unknown'); }
  function growth(before, expected) {
    return ['bytes', 'diskBytes', 'memoryBytes', 'cacheBytes'].some(k => before.detail[k] > expected.detail[k])
      || [...(before.samples || [])].some(([s, bytes]) => bytes > expected.samples.get(s));
  }
  async function measure() {
    if (!supported || disposed) return failure('cache_unavailable');
    if (pending) return failure('cache_busy');
    pending = true; ticket = null;
    try {
      const runtime = targets(), entries = await collect(runtime);
      if (!complete(entries)) return failure('cache_measure_failed', totals(entries));
      ticket = { id: randomUUID(), entries, runtime, expires: now() + 60000 };
      return { ok: true, status: entries.some(e => hasData(e.detail)) ? 'ready' : 'empty', scope: SCOPE,
        ...totals(entries), ticket: ticket.id };
    } catch { return failure('cache_measure_failed'); }
    finally { pending = false; }
  }
  async function clear(request) {
    if (!supported || disposed) return failure('cache_unavailable');
    if (pending) return failure('cache_busy');
    if (!request || Array.isArray(request) || request.confirm !== true || typeof request.ticket !== 'string'
      || Object.keys(request).some(k => !['confirm', 'ticket'].includes(k))) return failure('invalid_request');
    if (!ticket || ticket.id !== request.ticket || now() >= ticket.expires) {
      ticket = null;
      return failure('cache_confirmation_expired');
    }
    pending = true;
    const confirmed = ticket; ticket = null; // One attempt, including any failure.
    try {
      guard(confirmed.runtime);
      const before = await collect(confirmed.runtime, confirmed.entries);
      if (!complete(before) || before.some((e, i) => active(e) !== active(confirmed.entries[i])
        || active(e) && growth(e, confirmed.entries[i]))) {
        return failure('cache_changed', totals(before));
      }
      if (now() >= confirmed.expires) return failure('cache_confirmation_expired');
      let invoked = false, interruption = '', anyFailed = false, acceptedCalls = 0;
      const outcomes = new Map();
      for (const entry of before.filter(active)) {
        try {
          guard(confirmed.runtime);
          if (now() >= confirmed.expires) throw Error('cache_confirmation_expired');
          // Recheck each target just before its API, not merely before an earlier
          // bucket's await. A retiring/new Runtime or replacement disk tree is
          // never silently included in the user's old confirmation.
          const live = await read(entry.group, confirmed.runtime, entry);
          if (!active(live) || live.detail.status === 'unknown' || growth(live, entry)) throw Error('cache_changed');
          if (now() >= confirmed.expires) throw Error('cache_confirmation_expired');
          guard(confirmed.runtime);
          if (!hasData(live.detail)) { outcomes.set(entry.group, 'empty'); continue; }
          const sessions = entry.group.key === 'runtime' ? confirmed.runtime : entry.group.sessions;
          let accepted = true;
          for (const s of sessions) {
            guard(confirmed.runtime);
            if (now() >= confirmed.expires) throw Error('cache_confirmation_expired');
            // Runtime clears have their own awaits: an earlier Session must
            // not authorize growth in a later Session of the same fixed bucket.
            if (!entry.group.tree) {
              const size = await s.getCacheSize();
              guard(confirmed.runtime);
              if (!validBytes(size) || size > live.samples.get(s)) throw Error('cache_changed');
              if (now() >= confirmed.expires) throw Error('cache_confirmation_expired');
            }
            invoked = true;
            try {
              if (entry.group.key === 'code') await s.clearCodeCaches({});
              else await s.clearCache();
              acceptedCalls++;
            } catch { accepted = false; }
            guard(confirmed.runtime);
          }
          outcomes.set(entry.group, accepted ? 'accepted' : 'failed');
          if (!accepted) anyFailed = true;
        } catch (error) {
          interruption = error.message === 'cache_confirmation_expired' ? error.message : 'cache_changed';
          anyFailed = true; outcomes.set(entry.group, 'not_completed'); break;
        }
      }
      if (!invoked && interruption) return failure(interruption);
      const after = await collect(confirmed.runtime, before);
      const previous = totals(before), current = totals(after);
      const released = (a, b) => validBytes(a) && validBytes(b) ? Math.max(0, a - b) : null;
      const releasedDiskBytes = released(previous.diskBytes, current.diskBytes);
      const releasedMemoryBytes = released(previous.memoryBytes, current.memoryBytes);
      const allEmpty = complete(after) && !after.some(e => hasData(e.detail));
      const reduced = releasedDiskBytes > 0 || releasedMemoryBytes > 0
        || after.some((e, i) => validBytes(e.detail.cacheBytes) && e.detail.cacheBytes < before[i].detail.cacheBytes);
      const status = !anyFailed && allEmpty ? invoked ? 'cleared' : 'empty'
        : acceptedCalls > 0 || reduced ? 'partial' : 'failed';
      return { ok: ['cleared', 'empty'].includes(status), status, scope: SCOPE, ...current,
        beforeBytes: previous.bytes, beforeDiskBytes: previous.diskBytes, beforeMemoryBytes: previous.memoryBytes,
        beforeBuckets: previous.buckets, releasedDiskBytes, releasedMemoryBytes,
        diskReleaseConfirmed: releasedDiskBytes !== null && releasedDiskBytes > 0,
        buckets: current.buckets.map((d, i) => ({ ...d, clearStatus: outcomes.get(before[i].group) || 'not_attempted' })),
        ...(interruption ? { code: interruption } : {}),
        error: ['cleared', 'empty'].includes(status) ? '' : '清理未完全完成、结果未知，或运行期间生成了新缓存，请重新统计。' };
    } catch { return failure('cache_changed'); }
    finally { pending = false; }
  }
  return { supported, measure, clear, dispose() { disposed = true; ticket = null; } };
}

module.exports = { createProviderCache, METADATA, SCOPE };
