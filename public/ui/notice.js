/* P24 常驻状态条（Stage 顶部的一条说明 + 最多两个可执行入口）。
 *
 * ---------- 与 toast 的分工 ----------
 *
 * toast 是**一次性**的（「已复制」「命令失败」）；这一条是**状态型**的 ——
 * 只要那个状态还在，说明与下一步就该一直在，用户随时能看到、随时能点。
 *
 * 刻意只有一层（`#stageNotice`）：同时最多一个问题需要常驻。新的顶掉旧的，
 * 因为「现在最该知道的那件事」只有一个。
 *
 * 动作由调用方注入（`showNotice({ actions: [{ label, title, run }] })`），
 * 这里不认识任何业务模块 —— 装配层决定「重启」到底调谁。
 */
import { $ } from '../state.js';
import { ensureFeedbackStyles, feedbackContext } from './toast.js';

ensureFeedbackStyles();

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

const TONES = {
  bad: 'bad',
  error: 'bad',
  danger: 'bad',
  warn: 'warn',
  warning: 'warn',
  info: 'info',
  success: 'ok',
  ok: 'ok',
  busy: 'busy',
  loading: 'busy',
  pending: 'busy',
  unknown: 'unknown',
  unsupported: 'unknown',
};

export function noticeTone(tone) {
  if (tone == null || tone === '') return 'info';
  const raw = String(tone).toLowerCase();
  return TONES[raw] || 'unknown';
}

let currentNode = null;

export function hideNotice() {
  const host = $('stageNotice');
  if (!host) return false;
  host.hidden = true;
  host.replaceChildren();
  host.removeAttribute('data-tone');
  currentNode = null;
  return true;
}

/** 当前显示的 notice id（没显示时是 null）。 */
export function currentNoticeId() {
  return currentNode ? currentNode.id : null;
}

/**
 * 显示（或替换）状态条。
 *
 * @param model {id, tone: 'bad'|'warn'|'info'|'busy'|'ok'|'unknown', title, detail, actions: [{label,title,run}]}
 */
export function showNotice(model) {
  const host = $('stageNotice');
  if (!host) return false;
  if (!model || !model.title) return hideNotice();
  const tone = noticeTone(model.tone);
  const signature = signatureOf(model, tone);
  // Production callers supply Classic startup/bridge state, not Runtime cards.
  const context = feedbackContext({ runtime: false });
  const validActions = (model.actions || []).filter(action => action && typeof action.run === 'function' && action.label);
  const bind = (button, action) => { button.onclick = () => { if (!host.contains(button)) return; if (context === feedbackContext({ runtime: false })) action.run(); else hideNotice(); }; };
  /* 同一条已经在显示 → 不重建（避免每次事件都重画、把焦点抖掉）。 */
  if (currentNode && currentNode.id === model.id && currentNode.signature === signature && currentNode.context === context) {
    host.querySelectorAll('.ui4-feedback-notice-action').forEach((button, index) => bind(button, validActions[index]));
    return true;
  }

  host.replaceChildren();
  host.hidden = false;
  host.className = 'stage-notice' + (tone === 'info' ? '' : ' ' + tone);
  host.dataset.tone = tone;
  host.setAttribute('role', tone === 'bad' ? 'alert' : 'status');

  const dot = node('span', 'notice-dot ui4-feedback-notice-icon');
  dot.setAttribute('aria-hidden', 'true');

  const body = node('div', 'notice-body ui4-feedback-notice-body');
  const title = node('div', 'notice-title ui4-feedback-notice-title', model.title);
  body.appendChild(title);
  if (model.detail) {
    /* 多行说明（后端给的 error + hint）保留换行 —— 它是给人读的两句话。 */
    const detail = node('div', 'notice-detail ui4-feedback-notice-detail', model.detail);
    body.appendChild(detail);
  }

  const actions = node('div', 'notice-actions ui4-feedback-notice-actions');
  for (const action of validActions) {
    const button = node('button', 'btn tiny ui4-feedback-notice-action', action.label);
    button.type = 'button';
    if (action.title) button.title = String(action.title);
    bind(button, action);
    actions.appendChild(button);
  }
  const close = node('button', 'icon-btn notice-close ui4-feedback-notice-close', '✕');
  close.type = 'button';
  close.title = '隐藏这条提示';
  close.setAttribute('aria-label', '隐藏这条提示');
  close.onclick = () => hideNotice();
  actions.appendChild(close);

  host.append(dot, body, actions);
  currentNode = { id: model.id, signature, context };
  return true;
}

function signatureOf(model, tone) {
  const actions = (model.actions || [])
    .filter((action) => action && typeof action.run === 'function' && action.label)
    .map((action) => `${action.label}\u0000${action.title || ''}`)
    .join('\u0001');
  return `${tone}|${model.title}|${model.detail || ''}|${actions}`;
}

for (const name of ['pi-gui:workspace-generation', 'pi-gui:session-switch']) document.addEventListener(name, hideNotice);
document.addEventListener('pi-gui:feedback-context', () => {
  if (currentNode && currentNode.context !== feedbackContext({ runtime: false })) hideNotice();
});
