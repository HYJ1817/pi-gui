/* Turn-level duration / outcome copy shared by the verified timeline and the
 * native work-log fallback.
 *
 * The module is pure: callers pass the already-authorized turn timing and
 * status. It never reads a session, guesses a boundary, or turns a missing
 * timestamp into 0s. Semantics follow T3 Code's `Worked for` / `You stopped
 * after` / `Continued for` labels (commit 1e088be4), localized for Pi. */

const ACTIVE = new Set(['queued', 'running', 'waiting', 'stopping']);

export function isActiveTurnStatus(status) {
  return ACTIVE.has(status);
}

export function isAbnormalTurnStatus(status) {
  return ['failed', 'interrupted', 'cancelled', 'stopped', 'incomplete', 'detached'].includes(status);
}

/** Chinese wall-clock duration. Missing / negative evidence returns ''. */
export function formatElapsed(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return '不到 1 秒';
  const seconds = ms / 1000;
  if (seconds < 10) {
    const tenths = Math.round(seconds * 10) / 10;
    return (Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1)) + ' 秒';
  }
  const total = Math.round(seconds);
  if (total < 60) return total + ' 秒';
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return rest ? minutes + ' 分 ' + rest + ' 秒' : minutes + ' 分';
  const hours = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return [hours + ' 小时', minute ? minute + ' 分' : '', rest ? rest + ' 秒' : '']
    .filter(Boolean).join(' ');
}

/** Resolve a duration only when the timing carries usable evidence. */
export function elapsedOf(timing, { now = Date.now(), status = '' } = {}) {
  if (!timing || timing.evidence === 'unknown') return '';
  let ms = timing.durationMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    const startedAt = timing.startedAt;
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return '';
    const endedAt = typeof timing.endedAt === 'number' && Number.isFinite(timing.endedAt)
      ? timing.endedAt : ACTIVE.has(status) ? now : null;
    if (endedAt === null || endedAt < startedAt) return '';
    ms = endedAt - startedAt;
  }
  const formatted = formatElapsed(ms);
  return formatted && timing.evidence === 'estimated' ? '约 ' + formatted : formatted;
}

function tight(duration) {
  return duration.startsWith('不到') || duration.startsWith('约');
}

function joinDuration(prefix, duration) {
  if (!duration) return prefix;
  return prefix + (tight(duration) ? '' : ' ') + duration;
}

function joinMeta(prefix, duration) {
  if (!duration) return prefix;
  return prefix + ' · 用时' + (tight(duration) ? '' : ' ') + duration;
}

/**
 * @param {{
 *   status?: string,
 *   timing?: {startedAt?: number|null, endedAt?: number|null, durationMs?: number|null, evidence?: string}|null,
 *   now?: number,
 *   continued?: boolean
 * }} input
 * @returns {string} visible low-priority fold label
 */
export function turnFoldLabel({ status = '', timing = null, now = Date.now(), continued = false } = {}) {
  const state = status === 'complete' ? 'completed' : status;
  const duration = elapsedOf(timing, { now, status: state });
  if (continued) {
    if (state === 'running' || state === 'waiting' || state === 'queued' || state === 'stopping') {
      const waiting = state === 'waiting' ? '继续等待中' : state === 'queued' ? '准备继续执行'
        : state === 'stopping' ? '正在停止' : '继续执行中';
      return duration ? joinDuration(waiting + ' · 已运行', duration) : waiting;
    }
    if (state === 'failed') return joinMeta('继续执行失败', duration);
    if (state === 'incomplete' || state === 'unknown') return joinMeta('继续执行未完成', duration);
    return duration ? joinDuration('继续执行了', duration) : '继续执行';
  }
  if (state === 'queued') return '准备执行';
  if (state === 'running') return duration ? joinDuration('执行中 · 已运行', duration) : '执行中';
  if (state === 'waiting') return duration ? joinDuration('等待中 · 已运行', duration) : '等待中';
  if (state === 'stopping') return '正在停止';
  if (state === 'failed') return joinMeta('执行失败', duration);
  if (state === 'interrupted') return joinMeta('已中断', duration);
  if (state === 'cancelled' || state === 'stopped') {
    return duration ? joinDuration('你在', duration) + '后停止' : '你停止了这次执行';
  }
  if (state === 'incomplete') return joinMeta('未完成', duration);
  if (state === 'detached') return joinDuration('已分离', duration);
  /* T3 uses bare "Worked" when a folded turn has no trustworthy timing. A
   * bare "执行了" would read like a truncated sentence, so fall back to the
   * existing work-log noun instead of inventing a duration. */
  if (state === 'completed') return duration ? joinDuration('执行了', duration) : '工作记录';
  if (state === 'unknown') return joinMeta('执行记录', duration);
  return joinDuration('工作记录', duration);
}

/** Per-tool abnormal note for an otherwise completed turn. Counts only. */
export function activityNote(statuses = []) {
  const counts = new Map();
  for (const status of statuses) {
    if (status === 'error' || status === 'failed') counts.set('failed', (counts.get('failed') || 0) + 1);
    else if (status === 'interrupted') counts.set('interrupted', (counts.get('interrupted') || 0) + 1);
    else if (status === 'cancelled') counts.set('cancelled', (counts.get('cancelled') || 0) + 1);
    else if (status === 'incomplete') counts.set('incomplete', (counts.get('incomplete') || 0) + 1);
  }
  return [
    counts.has('failed') ? counts.get('failed') + ' 项失败' : '',
    counts.has('interrupted') ? counts.get('interrupted') + ' 项中断' : '',
    counts.has('cancelled') ? counts.get('cancelled') + ' 项取消' : '',
    counts.has('incomplete') ? counts.get('incomplete') + ' 项未完成' : '',
  ].filter(Boolean).join(' · ');
}
