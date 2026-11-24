/* Per-message presentation only: Pi Usage fields, never session totals/lastTurn.
 * Pi Usage.reasoning is a subset of output, not an additional token total.
 * Missing/invalid numbers stay absent; an actual numeric zero is meaningful.
 *
 * 这里只做字段白名单、聚合与摘要；展示入口是助手操作栏中的一枚统计图标，
 * 完整拆分放进轻量 Popover。缺失与 0 的语义不变：缺失字段不补 0，
 * 真实 0 仍然保留；整轮汇总只累加每条响应都有的字段。
 * Classic、Runtime 实时、Runtime 历史与 P5 共用这里字段名和数字格式。 */

const FIELDS = [
  ['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读取'],
  ['cacheWrite', '缓存写入'], ['cacheWrite1h', '缓存写入（1小时）'],
  ['reasoning', '推理'], ['totalTokens', '总计'],
];

export const USAGE_FIELDS = FIELDS;

const valid = (usage, key) => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0;
export const formatUsageNumber = value => value.toLocaleString('en-US');

/** 成本只接受 Pi 已算好的非负有限数；不在这里乘单价、不补货币符号。 */
export function validCost(usage) {
  const total = usage?.costTotal;
  return Number.isFinite(total) && total >= 0 ? total : null;
}

/** Project one Pi usage into the shared whitelist. Missing and invalid values
 * stay absent; a real zero is kept. `costTotal` accepts either the already
 * projected form or Pi's native `cost.total`. */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const usage = {};
  for (const [key] of FIELDS) if (valid(raw, key)) usage[key] = raw[key];
  const cost = validCost(raw) ?? (Number.isFinite(raw.cost?.total) && raw.cost.total >= 0 ? raw.cost.total : null);
  if (cost !== null) usage.costTotal = cost;
  return Object.keys(usage).length ? usage : null;
}

/** Whole-turn totals are emitted only for fields every response reported.
 * Mixing present and missing values would make a partial sum look complete. */
export function mergeUsages(usages) {
  const list = Array.isArray(usages) ? usages.map(normalizeUsage).filter(Boolean) : [];
  if (!list.length) return null;
  if (list.length === 1) return { ...list[0] };
  const merged = {};
  for (const [key] of [...FIELDS, ['costTotal', '成本']]) {
    if (!list.every(usage => Object.hasOwn(usage, key))) continue;
    merged[key] = list.reduce((total, usage) => total + usage[key], 0);
  }
  return Object.keys(merged).length ? merged : null;
}

/** 默认一行的用量摘要。缺失 totalTokens 时退回 output；推理永远标注含在输出中。 */
export function usageSummary(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return '';
  const parts = [];
  if (valid(usage, 'totalTokens')) parts.push(`Token ${formatUsageNumber(usage.totalTokens)}`);
  else if (valid(usage, 'output')) parts.push(`输出 ${formatUsageNumber(usage.output)} Token`);
  if (valid(usage, 'reasoning')) parts.push(`推理 ${formatUsageNumber(usage.reasoning)}（含在输出中）`);
  return parts.join(' · ');
}
