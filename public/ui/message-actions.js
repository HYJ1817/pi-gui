import { iconMarkup } from './icons.js';
/* Read-only message actions shared by live/history renderers. No session writes. */
export function messageActions(text) {
  const bar = document.createElement('div');
  bar.className = 'message-actions';
  if (typeof text !== 'string' || text.length === 0) { bar.hidden = true; return bar; }
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'message-copy';
  button.title = '复制消息'; button.setAttribute('aria-label', '复制消息');
  button.innerHTML = iconMarkup('copy');
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
