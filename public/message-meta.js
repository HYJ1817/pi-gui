/* Per-message presentation only: Pi Usage fields, never session totals/lastTurn.
 * Pi Usage.reasoning is a subset of output, not an additional token total.
 * Missing/invalid numbers stay absent; an actual numeric zero is meaningful.
 *
 * 默认只显示一行摘要（总量/输出 + 思考），完整拆分放进原生 <details>；
 * 这样默认信息密度更低，但所有真实字段仍然可达、可复制，缺失与 0 的语义不变。 */
const FIELDS = [
  ['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读取'],
  ['cacheWrite', '缓存写入'], ['cacheWrite1h', '缓存写入（1小时）'],
  ['reasoning', '思考'], ['totalTokens', '总计'],
];

const valid = (usage, key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0;

export function renderMessageMeta(message) {
  if (message?.role !== 'assistant' || !message.usage || typeof message.usage !== 'object' || Array.isArray(message.usage)) return null;
  const fields = FIELDS.filter(([key]) => valid(message.usage, key));
  if (!fields.length) return null;

  const usage = message.usage;
  const footer = document.createElement('footer');
  footer.className = 'ui2-msg-meta';
  footer.setAttribute('aria-label', '本条助手消息用量');

  const summaryParts = [];
  if (valid(usage, 'totalTokens')) summaryParts.push(`Token ${usage.totalTokens.toLocaleString('en-US')}`);
  else if (valid(usage, 'output')) summaryParts.push(`输出 ${usage.output.toLocaleString('en-US')} Token`);
  if (valid(usage, 'reasoning')) summaryParts.push(`思考 ${usage.reasoning.toLocaleString('en-US')} Token（含在输出中）`);

  if (summaryParts.length) {
    const summary = document.createElement('span');
    summary.className = 'ui2-msg-meta-summary';
    summary.textContent = summaryParts.join(' · ');
    footer.appendChild(summary);
  }

  const details = document.createElement('details');
  details.className = 'ui2-msg-meta-details';
  const toggle = document.createElement('summary');
  toggle.className = 'ui2-msg-meta-toggle';
  toggle.textContent = summaryParts.length ? '明细' : 'Token 明细';
  details.appendChild(toggle);

  for (const [key, label] of fields) {
    const item = document.createElement('span');
    item.className = 'ui2-msg-meta-item';
    item.dataset.kind = key;
    item.textContent = `${label} ${usage[key].toLocaleString('en-US')} Token${key === 'reasoning' ? '（含在输出中）' : ''}`;
    if (details.childNodes.length > 1) details.appendChild(document.createTextNode(' · '));
    details.appendChild(item);
  }

  footer.appendChild(details);
  return footer;
}
