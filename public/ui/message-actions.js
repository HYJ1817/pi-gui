import { iconMarkup } from './icons.js';
import { bindTooltip } from './tooltip.js';
import { createUsageButton, updateUsageButton } from './usage-action.js';

/* Message actions shared by live/history renderers.
 *
 * Copy is the original read-only action. Edit / regenerate are optional
 * callbacks: the caller owns the transaction and the editor; this module only
 * renders buttons, tooltips and accessible names. Usage is an optional set of
 * real Pi records; absent data never creates a button. Keeping that boundary
 * means the history (read-only) view can keep using the same bar with no
 * callbacks.
 */
function actionButton(icon, label, className, handler, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `message-action-btn ${className}`;
  button.setAttribute('aria-label', label);
  button.innerHTML = iconMarkup(icon);
  button.disabled = disabled === true;
  bindTooltip(button, label, { placement: 'bottom' });
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
  usage = null,
  usageOptions = {},
} = {}) {
  const bar = document.createElement('div');
  bar.className = 'message-actions';
  const feedback = document.createElement('span');
  feedback.className = 'message-copy-feedback';
  feedback.setAttribute('role', 'status');
  let currentText = '';
  let copy = null;
  let usageButton = null;
  const hasPrimary = typeof onEdit === 'function' || typeof onRegenerate === 'function';

  if (typeof onEdit === 'function') {
    bar.append(actionButton('edit', '编辑并重新发送', 'message-edit', onEdit, editDisabled));
  }
  if (typeof onRegenerate === 'function') {
    bar.append(actionButton('refresh', '重新生成', 'message-regenerate', onRegenerate, regenerateDisabled));
  }
  bar.append(feedback);

  const refreshHidden = () => {
    bar.hidden = !currentText && !hasPrimary && !usageButton;
  };
  // Streaming callers update content without replacing focused actions. The
  // caller still owns edit/regenerate authorization and callback lifetime.
  bar.updateText = value => {
    const next = typeof value === 'string' ? value : '';
    if (next !== currentText) feedback.textContent = '';
    currentText = next;
    if (next && !copy) {
      copy = actionButton('copy', '复制消息', 'message-copy', async () => {
        const button = copy;
        button.disabled = true;
        try {
          await bar.ownerDocument.defaultView.navigator.clipboard.writeText(currentText);
          feedback.textContent = '已复制';
        } catch {
          feedback.textContent = '复制失败，请手动选择';
        } finally { button.disabled = false; }
      });
      if (usageButton) bar.insertBefore(copy, usageButton);
      else bar.append(copy);
    } else if (!next && copy) {
      if (copy === bar.ownerDocument.activeElement) bar.querySelector('button:not(.message-copy):not(:disabled)')?.focus({ preventScroll: true });
      copy.remove();
      copy = null;
    }
    refreshHidden();
  };

  /* Usage can appear after copy/regenerate (stream usage arrives late), so it
   * owns a stable trailing slot and is removed rather than emptied. */
  bar.updateUsage = (records, options = {}) => {
    if (!usageButton) {
      usageButton = createUsageButton(records, options);
      if (usageButton) bar.append(usageButton);
    } else {
      const previous = usageButton;
      usageButton = updateUsageButton(previous, records, options);
      if (!usageButton) {
        previous.remove();
        if (previous === bar.ownerDocument.activeElement) {
          bar.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
        }
      }
    }
    refreshHidden();
    return usageButton;
  };

  bar.updateText(text);
  bar.updateUsage(usage, usageOptions);
  return bar;
}
