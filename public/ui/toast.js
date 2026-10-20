/* 轻提示。 */

import { el, S } from '../state.js';

const STYLE_ID = 'ui4-feedback-style';
const HOST_CLASS = 'ui4-feedback-toasts';
const DEFAULT_DURATION = { info: 4200, success: 4200, warning: 7000, error: null };
const recent = new Map();
const DEDUPE_MS = 30000;
let notificationSource = 'live';
let contextEpoch = 0;
let readRuntimeContext = () => null;
let lastContext = null;
let logNotification = () => {};

// Injected by the composition root to avoid toast -> API -> toast cycles.
export function configureNotificationLogging(log) {
  logNotification = typeof log === 'function' ? log : () => {};
}

// The composition root supplies a read-only view of the existing Runtime store.
// No owner, focused conversation or lifecycle is duplicated here.
export function configureFeedbackContext(read) {
  readRuntimeContext = typeof read === 'function' ? read : () => null;
  refreshFeedbackContext();
}

export function refreshFeedbackContext() {
  const current = feedbackContext();
  if (current === lastContext) return;
  lastContext = current;
  for (const node of el.toasts?.querySelectorAll('.ui4-feedback-toast') || []) {
    if (node._ui4Context !== current) markHistorical(node);
  }
  document.dispatchEvent(new window.Event('pi-gui:feedback-context'));
}

// Presentation provenance only; never sent to a server or used as authority.
export function feedbackContext({ runtime = true } = {}) {
  return JSON.stringify([contextEpoch, S.workspaceGeneration ?? null, S.bridgeRun ?? null,
    S.state?.sessionId ?? null, runtime ? readRuntimeContext() : null]);
}

function markHistorical(node) {
  if (node.dataset.contextStale === 'true') return;
  node.dataset.contextStale = 'true';
  const label = document.createElement('span');
  label.className = 'ui4-feedback-context'; label.textContent = '此前会话通知';
  node.querySelector('.ui4-feedback-toast-body')?.prepend(label);
  const action = node.querySelector('.ui4-feedback-toast-action');
  if (action) { action.disabled = true; action.onclick = null; }
}

function contextChanged() {
  contextEpoch++;
  refreshFeedbackContext();
}

const KINDS = {
  info: 'info',
  success: 'success',
  ok: 'success',
  warn: 'warning',
  warning: 'warning',
  error: 'error',
  danger: 'error',
  bad: 'error',
};

export function ensureFeedbackStyles() {
  if (typeof document === 'undefined' || !document.head) return false;
  if (document.getElementById(STYLE_ID)) return true;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = '/ui4-feedback.css';
  link.dataset.ui4Feedback = '';
  document.head.appendChild(link);
  return true;
}

/* Scope only synchronous event dispatch/rendering, never an async operation.
 * Reuse SSE's replay provenance; restoring state must not notify again. */
export function withNotificationSource(source, render) {
  const previous = notificationSource;
  notificationSource = source;
  try { return render(); } finally { notificationSource = previous; }
}

export function toast(msg, kind = 'info', options = {}) {
  if (notificationSource !== 'live') return null;
  if (!msg) return null;
  const text = String(msg);
  const normalized = normalizeKind(kind);
  const opts = options && typeof options === 'object' ? options : {};
  // Record structure only: notification bodies may contain paths or credentials.
  logNotification(normalized === 'error' ? 'ui.notification_error' : 'ui.notification', { kind: normalized });
  if ((normalized === 'info' || normalized === 'success') && !opts.action && opts.important !== true) return null;
  const now = Date.now();
  const context = opts.context ?? feedbackContext();
  const key = `${context}\u0000${normalized}\u0000${text}`;
  const host = el.toasts;
  if ([...host?.querySelectorAll('.ui4-feedback-toast') || []]
    .some(node => node._ui4Key === key && node.dataset.leaving !== 'true')) return null;
  if (now - (recent.get(key) || 0) < DEDUPE_MS) return null;
  recent.set(key, now);
  if (recent.size > 100) {
    for (const [k, at] of recent) if (now - at >= DEDUPE_MS) recent.delete(k);
    while (recent.size > 100) recent.delete(recent.keys().next().value);
  }

  if (!host) return null;
  refreshFeedbackContext();
  const node = document.createElement('div');
  node.className = legacyClass(normalized);
  node.dataset.kind = normalized;
  node._ui4Context = context;
  node._ui4Key = key;
  node.setAttribute('role', normalized === 'error' ? 'alert' : 'status');

  const icon = document.createElement('span');
  icon.className = 'ui4-feedback-toast-icon';
  icon.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'ui4-feedback-toast-body';
  body.textContent = text;

  node.append(icon, body);

  const action = opts.action;
  if (action && action.label && typeof action.run === 'function') {
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'ui4-feedback-toast-action';
    actionBtn.textContent = String(action.label);
    if (action.title) actionBtn.title = String(action.title);
    actionBtn.onclick = () => { if (!node.isConnected) return; if (context === feedbackContext()) action.run(); else markHistorical(node); };
    node.append(actionBtn);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ui4-feedback-toast-close';
  close.title = '关闭通知';
  close.setAttribute('aria-label', '关闭通知');
  close.onclick = () => dismiss(node);
  node.append(close);

  initHost(host);
  placeToasts();
  host.appendChild(node);
  if (context !== feedbackContext()) markHistorical(node);
  host.scrollTop = host.scrollHeight;

  const duration = resolveDuration(normalized, opts);
  if (duration != null) arm(node, duration);
  node.addEventListener('pointerenter', () => { node._ui4Hovered = true; pause(node); });
  node.addEventListener('pointerleave', () => { node._ui4Hovered = false; resume(node); });
  node.addEventListener('focusin', () => { node._ui4Focused = true; pause(node); });
  node.addEventListener('focusout', (event) => {
    if (!node.contains(event.relatedTarget)) { node._ui4Focused = false; resume(node); }
  });
  return node;
}

function normalizeKind(kind) {
  const raw = String(kind == null ? 'info' : kind).toLowerCase();
  return KINDS[raw] || 'info';
}

function legacyClass(kind) {
  return 'toast ui4-feedback-toast ui4-feedback-toast-' + kind
    + (kind === 'error' ? ' error' : kind === 'warning' ? ' warn' : '');
}

function resolveDuration(kind, opts) {
  if (opts.persistent === true) return null;
  if (Number.isFinite(opts.duration)) return opts.duration > 0 ? opts.duration : null;
  if (opts.persistent === false) return DEFAULT_DURATION[kind] ?? 4200;
  return DEFAULT_DURATION[kind];
}

function arm(node, duration) {
  node._ui4Deadline = Date.now() + duration;
  node._ui4Remaining = duration;
  node._ui4Timer = setTimeout(() => dismiss(node), duration);
}

function pause(node) {
  if (!node._ui4Timer) return;
  clearTimeout(node._ui4Timer);
  node._ui4Timer = null;
  node._ui4Remaining = Math.max(0, node._ui4Deadline - Date.now());
}

function resume(node) {
  if (node._ui4Hovered || node._ui4Focused) return;
  if (node._ui4Timer || node._ui4Remaining == null || !node.isConnected) return;
  arm(node, node._ui4Remaining);
}

function dismiss(node) {
  if (!node || node.dataset.leaving === 'true') return;
  node.dataset.leaving = 'true';
  if (node._ui4Timer) clearTimeout(node._ui4Timer);
  node._ui4Timer = null;
  const hadFocus = node.contains(document.activeElement);
  node.classList.add('ui4-feedback-toast-leaving');
  setTimeout(() => node.remove(), 180);
  if (hadFocus) {
    const target = el.input && !el.input.disabled ? el.input : document.body;
    target?.focus?.();
  }
}

function onHostKeydown(event) {
  if (event.key !== 'Escape') return;
  const node = event.target && event.target.closest ? event.target.closest('.ui4-feedback-toast') : null;
  if (!node) return;
  event.preventDefault();
  dismiss(node);
}

function initHost(host) {
  host.classList.add(HOST_CLASS);
  if (host.dataset.ui4FeedbackReady === '1') return;
  host.dataset.ui4FeedbackReady = '1';
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', '通知');
  host.addEventListener('keydown', onHostKeydown);
  if (typeof MutationObserver === 'function') {
    try {
      let queued = false;
      const observer = new MutationObserver(() => {
        if (queued) return;
        /* 文档可能已经销毁（窗口关闭 / 页面卸载），观察回调仍可能排到下一帧。
         * 这时不再碰 DOM —— 否则 rAF 里会访问已不存在的 document。 */
        if (typeof document === 'undefined' || !document?.documentElement) return;
        queued = true;
        const run = () => { queued = false; placeToasts(); };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else run();
      });
      const stage = document.querySelector('.stage');
      if (stage) observer.observe(stage, { attributes: true, attributeFilter: ['style'] });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    } catch { /* 布局观察只是位置微调，失败不影响通知本身 */ }
  }
}

function placeToasts() {
  /* rAF 可能比窗口活得更久（jsdom / 卸载中的页面）：先确认文档还在。 */
  if (typeof document === 'undefined' || !document?.documentElement || typeof window === 'undefined') return;
  const host = el.toasts;
  if (!host) return;
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  let right = 18;
  let bottom = 18;
  let maxWidth = vw > 0 ? Math.max(160, vw - 36) : 380;

  const pane = document.getElementById('rightPane');
  if (pane && !pane.hidden) {
    const rect = pane.getBoundingClientRect();
    if (rect.width > 0 && rect.left > 0 && vw > 0) {
      right = Math.max(18, vw - rect.left + 18);
      maxWidth = Math.min(maxWidth, Math.max(160, rect.left - 24));
    }
  }

  const composer = document.getElementById('chatComposer');
  if (composer && composer.getClientRects && composer.getClientRects().length) {
    const rect = composer.getBoundingClientRect();
    if (rect.height > 0 && rect.top > 0 && vh > 0) bottom = Math.max(18, vh - rect.top + 12);
  }

  host.style.setProperty('--ui4-toast-right', right + 'px');
  host.style.setProperty('--ui4-toast-bottom', bottom + 'px');
  host.style.setProperty('--ui4-toast-max', maxWidth + 'px');
  host.style.setProperty('--ui4-toast-height', Math.max(0, vh - bottom - 12) + 'px');
}

ensureFeedbackStyles();
if (typeof window !== 'undefined') window.addEventListener('resize', placeToasts);
if (typeof document !== 'undefined') {
  document.addEventListener('pi-gui:right-pane', placeToasts);
  document.addEventListener('pi-gui:workspace-view', placeToasts);
  document.addEventListener('pi-gui:workspace-view', refreshFeedbackContext);
  for (const name of ['pi-gui:workspace-generation', 'pi-gui:session-switch']) document.addEventListener(name, contextChanged);
}
