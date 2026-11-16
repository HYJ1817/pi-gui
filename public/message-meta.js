/* Per-message presentation only: Pi Usage fields, never session totals/lastTurn.
 * Pi Usage.reasoning is a subset of output, not an additional token total.
 * Missing/invalid numbers stay absent; an actual numeric zero is meaningful.
 *
 * 默认只显示一行摘要（总量/输出 + 推理），完整拆分放进原生 <details>；
 * 这样默认信息密度更低，但所有真实字段仍然可达、可复制，缺失与 0 的语义不变。
 * Classic、Runtime 实时与 Runtime 历史共用这里的字段名、数字格式和语义，
 * 避免同一份 usage 在三处出现三种标签。 */

const FIELDS = [
  ['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读取'],
  ['cacheWrite', '缓存写入'], ['cacheWrite1h', '缓存写入（1小时）'],
  ['reasoning', '推理'], ['totalTokens', '总计'],
];

export const USAGE_FIELDS = FIELDS;

const valid = (usage, key) => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0;
const grouped = value => value.toLocaleString('en-US');

/** 成本只接受 Pi 已算好的非负有限数；不在这里乘单价、不补货币符号。 */
export function validCost(usage) {
  const total = usage?.costTotal;
  return Number.isFinite(total) && total >= 0 ? total : null;
}

/** 默认一行的用量摘要。缺失 totalTokens 时退回 output；推理永远标注含在输出中。 */
export function usageSummary(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return '';
  const parts = [];
  if (valid(usage, 'totalTokens')) parts.push(`Token ${grouped(usage.totalTokens)}`);
  else if (valid(usage, 'output')) parts.push(`输出 ${grouped(usage.output)} Token`);
  if (valid(usage, 'reasoning')) parts.push(`推理 ${grouped(usage.reasoning)}（含在输出中）`);
  return parts.join(' · ');
}

/**
 * 渲染一条 usage 的“摘要 + 明细”。usage 形状与 Pi 一致：
 * input / output / cacheRead / cacheWrite / cacheWrite1h / reasoning / totalTokens，
 * 可选 costTotal（Pi `usage.cost.total` 的原值）。非白名单字段一律忽略。
 *
 * @param {object} usage
 * @param {{ source?: string, label?: string, prefix?: string, className?: string }} options
 * @returns {HTMLElement|null} 没有任何有效字段时返回 null（不是空壳）
 */
export function renderUsageMeta(usage, {
  source = '',
  label = '本条助手消息用量',
  prefix = '',
  className = 'ui2-msg-meta',
} = {}) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const fields = FIELDS.filter(([key]) => valid(usage, key));
  const cost = validCost(usage);
  if (!fields.length && cost === null) return null;

  const footer = document.createElement('footer');
  footer.className = className;
  footer.setAttribute('aria-label', label);

  const summaryText = usageSummary(usage);
  if (summaryText) {
    const summary = document.createElement('span');
    summary.className = 'ui2-msg-meta-summary';
    summary.textContent = prefix + summaryText;
    footer.appendChild(summary);
  }

  const details = document.createElement('details');
  details.className = 'ui2-msg-meta-details';
  const toggle = document.createElement('summary');
  toggle.className = 'ui2-msg-meta-toggle';
  toggle.textContent = summaryText ? '明细' : 'Token 明细';
  details.appendChild(toggle);

  for (const [key, fieldLabel] of fields) {
    const item = document.createElement('span');
    item.className = 'ui2-msg-meta-item';
    item.dataset.kind = key;
    item.textContent = `${fieldLabel} ${grouped(usage[key])} Token${key === 'reasoning' ? '（含在输出中）' : ''}`;
    if (details.childNodes.length > 1) details.appendChild(document.createTextNode(' · '));
    details.appendChild(item);
  }
  if (cost !== null) {
    const item = document.createElement('span');
    item.className = 'ui2-msg-meta-item';
    item.dataset.kind = 'cost';
    item.textContent = `预估成本 ${cost.toFixed(4)}`;
    if (details.childNodes.length > 1) details.appendChild(document.createTextNode(' · '));
    details.appendChild(item);
  }

  if (source === 'message_update') {
    const note = document.createElement('span');
    note.className = 'ui2-msg-meta-note';
    note.textContent = '（流式中，Pi 仍在累计）';
    footer.appendChild(note);
  }

  footer.appendChild(details);
  return footer;
}

/** Classic 的一条 assistant 消息：usage 直接来自 message.usage。 */
export function renderMessageMeta(message) {
  if (message?.role !== 'assistant' || !message.usage || typeof message.usage !== 'object' || Array.isArray(message.usage)) return null;
  const usage = { ...message.usage };
  const cost = message.usage.cost?.total;
  if (Number.isFinite(cost) && cost >= 0) usage.costTotal = cost;
  return renderUsageMeta(usage, { label: '本条助手消息用量' });
}
