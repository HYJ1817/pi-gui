/* 扩展页的纯数据投影：Registry 条目的状态文案、筛选与详情行。
 *
 * 唯一事实来源是 `/api/extensions`（server/extension-registry.js，只读 Registry）。
 * installed / enabled / loaded / restartRequired 是四个独立的三值事实：
 * null 一律显示「未知 / 无法确认」，绝不折算成「否」。这里不做任何按包名的分支。 */

/** 列表徽标：错误优先，其次是 Pi 给出的加载证据。 */
export function extensionStateLabel(item) {
  const state = item?.state || {};
  if (state.error) return state.error.phase === 'discovery' ? '发现异常' : '加载失败';
  if (state.loaded === true) return '已加载';
  if (state.loaded === false) return '未加载';
  return '加载未知';
}

export function extensionDisplayName(item) {
  return item?.displayName || item?.name || '（未命名）';
}

export function extensionScopeLabel(scope) {
  if (scope === 'global') return '全局';
  if (scope === 'project') return '项目';
  return '未知';
}

export function extensionSourceLabel(item) {
  const type = item?.source?.type;
  if (type === 'local') return '本地';
  return type || '未知来源';
}

function triState(value, unknown = '未知') {
  if (value === null || value === undefined) return unknown;
  return value ? '是' : '否';
}

/** 详情里的事实行，顺序与拆分前一致。 */
export function extensionFactRows(item) {
  const state = item?.state || {};
  return [
    ['版本', item?.version || '未知'],
    ['来源', item?.source?.type || 'unknown'],
    ['位置', item?.source?.location || '未知'],
    ['作用域', extensionScopeLabel(item?.scope)],
    ['已安装', triState(state.installed)],
    ['已启用', triState(state.enabled)],
    ['已加载', triState(state.loaded, '无法确认')],
    ['需要重启', triState(state.restartRequired)],
  ];
}

/** 列表项第二行：简介 · 来源 · 已确认能力数。 */
export function extensionItemSummary(item) {
  return `${item?.description || '（没有简介）'} · ${extensionSourceLabel(item)} · ${item?.capabilities?.length || 0} 个已确认能力`;
}

/** 名称 / 简介 / 状态 / 来源 / 作用域都可搜，状态用的是列表上同一套文案。 */
export function filterExtensions(items, query) {
  const list = Array.isArray(items) ? items : [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((item) => [
    item.displayName, item.name, item.description, extensionStateLabel(item), item.source?.type, item.scope,
  ].some((part) => String(part || '').toLowerCase().includes(q)));
}
