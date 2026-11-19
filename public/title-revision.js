/* 会话标题的前端修订权威（模块级状态，无 DOM / 无网络）。
 *
 * 后端的每条标题记录都有持久化的 `revision`：手动改名、确认采纳、自动标题、
 * 原生改名都会让它递增。前端收到三种可能**迟到**的数据：
 *
 *   1. 会话列表响应（`titleRevision`）；
 *   2. `session_title` SSE 事件（`revision`）；
 *   3. 切换 / 改名接口的应答（`titleRevision` / `revision`）。
 *
 * 它们可能乱序到达。只按「谁后到谁赢」会让旧列表把用户刚改的标题改回去，
 * 因此这里保存每个会话已见过的最大修订：低修订一律丢弃，同修订只在事件
 * 内容一致时视为幂等。键与后端存储一致：`classic:<原生会话 id>` /
 * `runtime:<conversationId>`。
 *
 * 这个模块刻意只做「标题 + 修订」的裁决，不缓存其它会话字段，也不触发重绘；
 * 视图拿裁决结果自行就地更新。
 */

const entries = new Map();

const CLASSIC_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const RUNTIME_ID_RE = /^[\da-f-]{36}$/i;

export function titleKey(scope, id) {
  if (typeof id !== 'string' || !id) return null;
  if (scope === 'runtime') return RUNTIME_ID_RE.test(id) ? `runtime:${id}` : null;
  if (scope === 'classic') return CLASSIC_ID_RE.test(id) ? `classic:${id}` : null;
  return null;
}

function normalize(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const title = typeof snapshot.title === 'string' ? snapshot.title.trim() : '';
  if (!title) return null;
  const revision = Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0 ? snapshot.revision : 0;
  const source = typeof snapshot.source === 'string' && snapshot.source ? snapshot.source : null;
  return { title, source, revision };
}

/**
 * 把一份**可信快照**（列表行、切换应答、改名应答）并入修订权威。
 *
 * - 快照修订更高（或相等）→ 采用并记录；
 * - 已记录的修订更高 → 返回已记录的值，调用方用它覆盖快照里的旧标题。
 *
 * 相等时采用快照是刻意的：`fallback`（首条用户消息）变化不会递增修订，
 * 刷新列表时必须能看到它；而真正的标题变更都会递增修订，不会被旧值盖住。
 */
export function resolveTitleSnapshot(key, snapshot) {
  const next = normalize(snapshot);
  if (!key) return next;
  const current = entries.get(key) || null;
  if (!next) return current;
  if (current && current.revision > next.revision) return current;
  entries.set(key, next);
  return next;
}

/**
 * SSE 事件的门槛更严：修订必须比已记录的**更高**；相等只允许同标题的
 * 幂等重放。事件是「可能迟到」的推送，没有资格在修订相同的情况下改写
 * 本地已经采纳的标题。
 */
export function acceptTitleEvent(key, snapshot) {
  const next = normalize(snapshot);
  if (!key || !next) return null;
  const current = entries.get(key) || null;
  if (current) {
    if (next.revision < current.revision) return null;
    if (next.revision === current.revision) {
      if (next.title !== current.title) return null;
      return current;
    }
  }
  entries.set(key, next);
  return next;
}

export function titleSnapshot(key) {
  return key ? entries.get(key) || null : null;
}

export function forgetTitleSnapshot(key) {
  return key ? entries.delete(key) : false;
}
