/* 轻提示。 */

import { el } from '../state.js';

export function toast(msg, kind = 'info') {
  if (!msg) return;
  const t = document.createElement('div');
  t.className = 'toast' + (kind === 'error' ? ' error' : kind === 'warn' ? ' warn' : '');
  t.textContent = msg;
  el.toasts.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .25s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 260);
  }, 4200);
}
