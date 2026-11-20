import { iconMarkup } from './icons.js';

/* Message actions shared by live/history renderers.
 *
 * Copy is the original read-only action. Edit / regenerate are optional
 * callbacks: the caller owns the transaction and the editor; this module only
 * renders buttons, tooltips and accessible names. Keeping that boundary means
 * the history (read-only) view can keep using the same bar with no callbacks.
 */
function actionButton(icon, label, className, handler, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `message-action-btn ${className}`;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = iconMarkup(icon);
  button.disabled = disabled === true;
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (button.disabled) return;
    handler(event);
  });
  return button;
}

export function messageActions(text, {
  onEdit = null,
  onRegenerate = null,
  editDisabled = false,
  regenerateDisabled = false,
} = {}) {
  const bar = document.createElement('div');
  bar.className = 'message-actions';
  const hasText = typeof text === 'string' && text.length > 0;
  if (!hasText && typeof onEdit !== 'function' && typeof onRegenerate !== 'function') {
    bar.hidden = true;
    return bar;
  }
  const feedback = document.createElement('span');
  feedback.className = 'message-copy-feedback';
  feedback.setAttribute('role', 'status');

  if (typeof onEdit === 'function') {
    bar.append(actionButton('edit', '编辑并重新发送', 'message-edit', onEdit, editDisabled));
  }
  if (typeof onRegenerate === 'function') {
    bar.append(actionButton('refresh', '重新生成', 'message-regenerate', onRegenerate, regenerateDisabled));
  }
  if (hasText) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'message-action-btn message-copy';
    button.title = '复制消息'; button.setAttribute('aria-label', '复制消息');
    button.innerHTML = iconMarkup('copy');
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
  } else {
    bar.append(feedback);
  }
  return bar;
}
