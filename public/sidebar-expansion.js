// 本次运行中的项目展开状态；不写配置或磁盘。
const expanded = new Map();
export function projectExpanded(path, current = false) {
  if (!expanded.has(path)) expanded.set(path, current);
  return expanded.get(path);
}
export function setProjectExpanded(path, value) {
  expanded.set(path, Boolean(value));
}
export function pruneProjectExpansion(paths) {
  for (const key of expanded.keys()) if (!paths.includes(key)) expanded.delete(key);
}
