/* 轻提示。 */

import { el } from '../state.js';

const recent = new Map();
const DEDUPE_MS = 2500;

export function toast(msg, kind = 'info') {
  if (!msg) return;
  const now = Date.now();
  const key = `${kind}\u0000${msg}`;
  if (now - (recent.get(key) || 0) < DEDUPE_MS) return;
  recent.set(key, now);
  if (recent.size > 100) {
    for (const [k, at] of recent) if (now - at >= DEDUPE_MS) recent.delete(k);
  }
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
