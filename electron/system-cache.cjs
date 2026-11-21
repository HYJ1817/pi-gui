'use strict';

const { randomUUID } = require('node:crypto');
const SCOPE = 'browser-memory-http-cache';

// No providers => the exact P1 allowlist and result contract, including SCOPE.
// P2 is opt-in and receives main-owned Session references only; see its module's
// integration contract. Neither branch accepts renderer paths/partition ids.
function createSystemCache(options = {}) {
  if (options.providers !== undefined) return require('./system-cache-p2.cjs').createProviderCache(options);
  return createLegacyCache(options);
}

// P1's existing pi-gui-browser NON-persistent HTTP memory cache only. Keep this
// path independent of all filesystem probes and optional P2 providers.
function createLegacyCache({ session, now = Date.now } = {}) {
  let pending = false, disposed = false, ticket = null;
  function qualified() {
    try {
      return !!session && session.isPersistent() === false && session.getStoragePath() === null
        && typeof session.getCacheSize === 'function' && typeof session.clearCache === 'function';
    } catch { return false; }
  }
  const supported = qualified();
  const failure = code => ({ ok: false, status: 'unknown', bytes: null, scope: SCOPE, code,
    error: code === 'cache_changed' || code === 'cache_confirmation_expired' ? '缓存已变化或确认已过期，请重新统计后确认。'
      : code === 'cache_busy' ? '缓存操作正在进行，请稍后重试。' : '无法读取或清理缓存，请稍后重试。' });
  function guard() { if (disposed || !qualified()) throw Error('cache_unavailable'); }
  async function size() {
    const bytes = await session.getCacheSize();
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('cache_size_unknown');
    return bytes;
  }
  async function measure() {
    if (!supported || disposed) return failure('cache_unavailable');
    if (pending) return failure('cache_busy');
    pending = true;
    ticket = null;
    try {
      guard();
      const bytes = await size();
      guard();
      ticket = { id: randomUUID(), bytes, expires: now() + 60000 };
      return { ok: true, status: bytes === 0 ? 'empty' : 'ready', bytes, scope: SCOPE, ticket: ticket.id };
    } catch { return failure('cache_measure_failed'); }
    finally { pending = false; }
  }
  async function clear(request) {
    if (!supported || disposed) return failure('cache_unavailable');
    if (pending) return failure('cache_busy');
    if (!request || request.confirm !== true || typeof request.ticket !== 'string'
      || Object.keys(request).some(key => !['confirm', 'ticket'].includes(key))) return failure('invalid_request');
    if (!ticket || request.ticket !== ticket.id || now() > ticket.expires) return failure('cache_confirmation_expired');
    pending = true;
    const expected = ticket.bytes;
    ticket = null; // One shot, including failed attempts.
    try {
      guard();
      const beforeBytes = await size();
      guard();
      // A growing cache needs a new preview/confirmation, not broader deletion.
      if (beforeBytes > expected) return failure('cache_changed');
      if (beforeBytes === 0) return { ok: true, status: 'empty', bytes: 0, beforeBytes, scope: SCOPE };
      let cleared = true;
      try { await session.clearCache(); } catch { cleared = false; }
      let bytes = null;
      try { guard(); bytes = await size(); guard(); } catch { /* Unknown is never zero. */ }
      const status = cleared && bytes === 0 ? 'cleared'
        : cleared || (bytes !== null && bytes < beforeBytes) ? 'partial' : 'failed';
      return { ok: status === 'cleared', status, scope: SCOPE, beforeBytes, bytes,
        error: status === 'cleared' ? '' : bytes === null ? '清理结果未能确认，请重新统计。'
          : cleared ? '清理已执行，但仍有缓存或运行期间已生成新缓存。' : '缓存暂不可用，清理未完全完成。' };
    } catch { return failure('cache_clear_failed'); }
    finally { pending = false; }
  }
  return { supported, measure, clear, dispose() { disposed = true; ticket = null; } };
}
module.exports = { createSystemCache, SCOPE };
