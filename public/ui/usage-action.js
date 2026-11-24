/* Usage is one low-interference action in the assistant action bar. This
 * module only owns the trigger; the popover owns its own geometry and closing
 * behavior. Missing usage never produces a button. */

import { iconMarkup } from './icons.js';
import { bindTooltip } from './tooltip.js';
import { closeUsagePopover, toggleUsagePopover, usagePopoverVisible } from './usage-popover.js';

function usable(records) {
  return (Array.isArray(records) ? records : []).filter(record => {
    const usage = record?.usage ?? record;
    return usage && typeof usage === 'object' && !Array.isArray(usage)
      && Object.keys(usage).length > 0;
  });
}

export function createUsageButton(records, options = {}) {
  const list = usable(records);
  if (!list.length) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'message-action-btn message-usage';
  button.setAttribute('aria-label', '查看用量');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = iconMarkup('chart');
  bindTooltip(button, '查看用量', { placement: 'bottom' });
  button._usageRecords = list;
  button._usageOptions = { ...options };
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (!button._usageRecords?.length) return;
    toggleUsagePopover(button, button._usageRecords, button._usageOptions);
  });
  return button;
}

export function updateUsageButton(button, records, options = {}) {
  const list = usable(records);
  if (!list.length) {
    if (usagePopoverVisible() && button?.getAttribute('aria-expanded') === 'true') closeUsagePopover();
    return null;
  }
  const target = button || createUsageButton(list, options);
  if (!target) return null;
  target._usageRecords = list;
  target._usageOptions = { ...options };
  return target;
}
