/* 顶部会话标题的投影规则（纯函数，无 DOM / 无状态）。
 *
 * 标题有两个权威来源，优先级固定：
 *   1. Pi 当前会话的 `get_state.sessionName`（用户明确命名后由 Pi 持有）；
 *   2. 会话列表里**当前这条**会话的标题（会话文件里的 session_info.name，
 *      没有名字时取第一条用户消息）。
 *
 * 侧栏已经用第 2 条渲染，顶部不能再用另一份可能过期的副本。`expectedKey`
 * 是用户刚刚切过去的那条会话的稳定 ID：列表请求可能比 switch_session
 * 晚回来、甚至带回旧的 current 标记，这时只能认 expectedKey 那一条；
 * 找不到就保持切换应答里的标题，绝不把另一条会话的标题画到顶部。
 *
 * `liveName` 非空时返回 null —— 调用方保留 Pi 的实时名字，列表标题不能
 * 覆盖它。新建/空会话的 pending 记录统一显示「新会话」。
 */
const BLANK_TITLES = new Set(['（还没有消息）', '新会话（还没有消息）']);

/** 列表条目真正要显示的标题。
 *  空会话在磁盘上可能已经被写成 `（还没有消息）`，那不是用户起的名字，
 *  顶部标题仍应显示「新会话」；pending 条目同理。 */
export function sessionDisplayTitle(session, fallback = '新会话') {
  if (!session || typeof session !== 'object') return fallback;
  const title = typeof session.title === 'string' ? session.title.trim() : '';
  if (session.pending || !title || BLANK_TITLES.has(title)) return fallback;
  return title;
}

/** 列表里的 current 是否真的是「刚新建 / 分叉出来的那一条」。
 *  新会话还没有稳定 ID，不能只凭 current 标记认领：旧列表回来时 current
 *  仍可能是切换前那条。判据用「之前没见过的 ID」或 pending，
 *  不拿 messageCount / 时间戳这些会变的字段猜。 */
export function isNewSessionEntry(session, previousKey = null, knownIds = null) {
  if (!session || typeof session.id !== 'string' || !session.id) return false;
  if (previousKey && session.id === previousKey) return false;
  if (session.pending) return true;
  if (knownIds && typeof knownIds.has === 'function') return !knownIds.has(session.id);
  return true;
}

export function projectSessionTitle({
  sessions,
  currentId = null,
  expectedKey = null,
  liveName = '',
  fallback = '新会话',
} = {}) {
  if (typeof liveName === 'string' && liveName.trim()) return null;

  const list = Array.isArray(sessions) ? sessions : [];
  let key = expectedKey;
  let target = expectedKey ? list.find((s) => s?.id === expectedKey) : null;

  if (!target) {
    if (expectedKey) return null;
    target = list.find((s) => s?.current)
      || (currentId ? list.find((s) => s?.id === currentId) : null);
    key = target?.id || null;
  }

  if (!target) return null;
  return { key, title: sessionDisplayTitle(target, fallback) };
}
