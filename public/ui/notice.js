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

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

let currentNode = null;

export function hideNotice() {
  const host = $('stageNotice');
  if (!host) return false;
  host.hidden = true;
  host.replaceChildren();
  currentNode = null;
  return true;
}

/** 当前显示的 notice id（没显示时是 null）。 */
export function currentNoticeId() {
  return currentNode;
}

/**
 * 显示（或替换）状态条。
 *
 * @param model {id, tone: 'bad'|'warn'|'info', title, detail, actions: [{label,title,run}]}
 */
export function showNotice(model) {
  const host = $('stageNotice');
  if (!host) return false;
  if (!model || !model.title) return hideNotice();
  /* 同一条已经在显示 → 不重建（避免每次事件都重画、把焦点抖掉）。 */
  if (currentNode && currentNode.id === model.id && currentNode.signature === signatureOf(model)) return true;

  host.replaceChildren();
  host.hidden = false;
  host.className = 'stage-notice' + (model.tone ? ' ' + model.tone : '');
  host.setAttribute('role', model.tone === 'bad' ? 'alert' : 'status');

  const dot = node('span', 'notice-dot');
  dot.setAttribute('aria-hidden', 'true');

  const body = node('div', 'notice-body');
  const title = node('div', 'notice-title', model.title);
  body.appendChild(title);
  if (model.detail) {
    /* 多行说明（后端给的 error + hint）保留换行 —— 它是给人读的两句话。 */
    const detail = node('div', 'notice-detail', model.detail);
    body.appendChild(detail);
  }

  const actions = node('div', 'notice-actions');
  for (const action of model.actions || []) {
    if (!action || typeof action.run !== 'function' || !action.label) continue;
    const button = node('button', 'btn tiny', action.label);
    button.type = 'button';
    if (action.title) button.title = action.title;
    button.onclick = () => action.run();
    actions.appendChild(button);
  }
  const close = node('button', 'icon-btn notice-close', '✕');
  close.type = 'button';
  close.title = '隐藏这条提示';
  close.setAttribute('aria-label', '隐藏这条提示');
  close.onclick = () => hideNotice();
  actions.appendChild(close);

  host.append(dot, body, actions);
  currentNode = { id: model.id, signature: signatureOf(model) };
  return true;
}

function signatureOf(model) {
  return `${model.tone || ''}|${model.title}|${model.detail || ''}|${(model.actions || []).length}`;
}
