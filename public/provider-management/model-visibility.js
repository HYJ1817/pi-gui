/* 模型可见性/顺序的纯函数。
 *
 * 搜索只改变「看得见什么」，绝不改变已选集合和顺序。
 * 这一层没有 DOM，测试可以直接盯住这个不变量。 */

export function normalizeOrder(order, selected = []) {
  const selectedSet = new Set(selected);
  const seen = new Set();
  const next = [];
  for (const id of Array.isArray(order) ? order : []) {
    if (typeof id !== 'string' || seen.has(id) || !selectedSet.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  for (const id of selected) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

export function toggleSelection(order, modelId, selected) {
  const current = Array.isArray(order) ? order : [];
  if (selected === false) return current.filter(id => id !== modelId);
  if (current.includes(modelId)) return [...current];
  return [...current, modelId];
}

/** 只对当前可见行生效；不可见的已选项原样保留。 */
export function setVisibleSelection(order, visibleIds, selected, allIds) {
  const visible = new Set(visibleIds);
  const all = new Set(allIds);
  const current = Array.isArray(order) ? order : [];
  if (selected) {
    const next = [...current];
    for (const id of all) {
      if (visible.has(id) && !next.includes(id)) next.push(id);
    }
    return next;
  }
  return current.filter(id => !visible.has(id));
}

export function moveByOffset(order, modelId, offset) {
  const current = Array.isArray(order) ? [...order] : [];
  const index = current.indexOf(modelId);
  if (index < 0) return current;
  const target = Math.max(0, Math.min(current.length - 1, index + offset));
  if (target === index) return current;
  current.splice(index, 1);
  current.splice(target, 0, modelId);
  return current;
}

export function moveBefore(order, movingId, targetId) {
  const current = Array.isArray(order) ? [...order] : [];
  const from = current.indexOf(movingId);
  const to = current.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return current;
  current.splice(from, 1);
  const insert = current.indexOf(targetId);
  current.splice(insert, 0, movingId);
  return current;
}

export function moveToIndex(order, modelId, index) {
  const current = Array.isArray(order) ? [...order] : [];
  const from = current.indexOf(modelId);
  if (from < 0) return current;
  const target = Math.max(0, Math.min(current.length - 1, index));
  if (from === target) return current;
  current.splice(from, 1);
  current.splice(target, 0, modelId);
  return current;
}

export function filterModels(models, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return Array.isArray(models) ? models : [];
  return (Array.isArray(models) ? models : []).filter(model => {
    return String(model.modelId || '').toLowerCase().includes(q)
      || String(model.name || '').toLowerCase().includes(q);
  });
}

export function chosenModels(models, order) {
  const byId = new Map((Array.isArray(models) ? models : []).map(model => [model.modelId, model]));
  return (Array.isArray(order) ? order : []).map(id => byId.get(id)).filter(Boolean);
}

export function projectModelVisibility({ models = [], order = [], candidateQuery = '', chosenQuery = '' } = {}) {
  const candidates = filterModels(models, candidateQuery);
  const chosen = filterModels(chosenModels(models, order), chosenQuery);
  return {
    candidates,
    chosen,
    selectedCount: Array.isArray(order) ? order.length : 0,
    candidateSelectedCount: candidates.filter(model => order.includes(model.modelId)).length,
    chosenFiltered: Boolean(String(chosenQuery || '').trim()),
    candidateFiltered: Boolean(String(candidateQuery || '').trim()),
  };
}

export function allVisibleSelected(models, order) {
  const visible = Array.isArray(models) ? models : [];
  return visible.length > 0 && visible.every(model => order.includes(model.modelId));
}

export function nextModelId(models, preferred = 'custom-model') {
  const taken = new Set((Array.isArray(models) ? models : []).map(model => model.modelId));
  if (!taken.has(preferred)) return preferred;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${preferred}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${preferred}-${Date.now().toString(36)}`;
}
