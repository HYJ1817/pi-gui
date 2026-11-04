/* Read-only message actions shared by live/history renderers. No session writes. */
export function messageActions(text) {
  const bar = document.createElement('div');
  bar.className = 'message-actions';
  if (typeof text !== 'string' || text.length === 0) { bar.hidden = true; return bar; }
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'message-copy';
  button.title = '复制消息'; button.setAttribute('aria-label', '复制消息');
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 4H6a2 2 0 0 0-2 2v9"/></svg>';
  const feedback = document.createElement('span');
  feedback.className = 'message-copy-feedback'; feedback.setAttribute('role', 'status');
  button.onclick = async () => {
    button.disabled = true;
    try {
      await bar.ownerDocument.defaultView.navigator.clipboard.writeText(text);
      feedback.textContent = '已复制';
    } catch {
      feedback.textContent = '复制失败，请手动选择';
    } finally { button.disabled = false; }
  };
  bar.append(feedback, button);
  return bar;
}
