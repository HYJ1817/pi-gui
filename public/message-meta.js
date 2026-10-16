/* Per-message presentation only: Pi Usage fields, never session totals/lastTurn.
 * Pi Usage.reasoning is a subset of output, not an additional token total.
 * Missing/invalid numbers stay absent; an actual numeric zero is meaningful. */
const FIELDS = [
  ['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读取'],
  ['cacheWrite', '缓存写入'], ['cacheWrite1h', '缓存写入（1小时）'],
  ['reasoning', '思考'], ['totalTokens', '总计'],
];

export function renderMessageMeta(message) {
  if (message?.role !== 'assistant' || !message.usage || typeof message.usage !== 'object' || Array.isArray(message.usage)) return null;
  const fields = FIELDS.filter(([key]) => Number.isSafeInteger(message.usage[key]) && message.usage[key] >= 0);
  if (!fields.length) return null;
  const footer = document.createElement('footer');
  footer.className = 'ui2-msg-meta';
  footer.setAttribute('aria-label', '本条助手消息用量');
  for (const [key, label] of fields) {
    const item = document.createElement('span');
    item.className = 'ui2-msg-meta-item';
    item.dataset.kind = key;
    item.textContent = `${label} ${message.usage[key].toLocaleString('en-US')} Token${key === 'reasoning' ? '（含在输出中）' : ''}`;
    if (footer.childNodes.length) footer.appendChild(document.createTextNode(' · '));
    footer.appendChild(item);
  }
  return footer;
}
