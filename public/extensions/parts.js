/* 扩展页两个面板与详情弹层共用的小节点：组头、状态瓦片、字母图标、操作结果、命令行、
 * 搜索框、「更多」按钮与动作按钮的忙碌态。
 *
 * 只造节点：不发请求、不持有状态、不认识任何包名。调用方给什么事实就画什么。 */

import { createIcon } from '../ui/icons.js';
import { resourceEl as el } from '../ui/resource-dom.js';
import { copyButton } from '../ui/capability-setup.js';
import { extensionOperationBusyLabel } from './market-model.js';

/** 分组标题：名称 + 条数。 */
export function extensionGroupHead(title, count, titleId) {
  const head = el('header', 'extensions-group-head');
  const heading = el('h3', 'extensions-group-title', title);
  if (titleId) heading.id = titleId;
  head.append(heading, el('span', 'extensions-group-count', String(count)));
  return head;
}

/**
 * 空 / 失败 / 读取中 / 项目已切换时的状态瓦片。
 * @param options.actions 真实存在的下一步 `[{ label, onClick }]`；没有就不出按钮
 */
export function extensionStateTile(text, { icon = 'box', hint = '', actions = [] } = {}) {
  const box = el('div', 'extensions-empty');
  const chip = el('span', 'extensions-empty-icon');
  chip.append(createIcon(icon, { size: 16 }));
  box.append(chip, el('div', 'extensions-empty-title', text));
  if (hint) box.append(el('div', 'extensions-empty-text', hint));
  const list = actions.filter((action) => action && action.label && typeof action.onClick === 'function');
  if (list.length) {
    const row = el('div', 'extensions-empty-actions');
    for (const action of list) {
      const button = el('button', 'btn tiny', action.label);
      button.type = 'button';
      button.onclick = action.onClick;
      row.append(button);
    }
    box.append(row);
  }
  return box;
}

/** 字母图标用的那个字：去掉 `@scope/` 与开头的 `pi-` 之后的第一个字母或数字（大写）。 */
export function extensionMonogram(name) {
  const text = String(name || '');
  const core = text.replace(/^@[^/]+\//, '').replace(/^pi[-_.]/i, '');
  const match = /[\p{L}\p{N}]/u.exec(core) || /[\p{L}\p{N}]/u.exec(text);
  return match ? Array.from(match[0].toUpperCase())[0] : '?';
}

/** 卡片左上角的图标块：正常是名字的首字母，有问题的卡片换成警示图标。纯装饰，名字在标题里。 */
export function extensionGlyph(name, { error = false } = {}) {
  const glyph = el('span', 'extensions-card-glyph');
  glyph.setAttribute('aria-hidden', 'true');
  if (error) glyph.append(createIcon('warning', { size: 15 }));
  else glyph.textContent = extensionMonogram(name);
  return glyph;
}

/** 一条可复制的命令原文（只给用户看与复制，界面不执行它）。 */
export function extensionCommandRow(command) {
  const line = el('div', 'extensions-command');
  const code = el('code', 'extensions-command-text', command);
  code.title = command;
  line.append(code, copyButton(command));
  return line;
}

const OUTCOME_ICONS = Object.freeze({ success: 'check', info: 'info', warning: 'warning', error: 'warning' });

/**
 * 一次包操作的结果，就地显示（不走 toast：失败原因与手动恢复命令要留得住）。
 * @param outcome            market-model.js 的 `extensionOperationOutcome()`
 * @param options.name       结果不在自己的卡片上时（例如卸载后卡片已经没了）带上包名
 * @param options.onRetry    这次失败可以重试时的入口
 * @param options.onDismiss  关掉这条提示
 */
export function extensionOutcomeBox(outcome, { name = '', onRetry = null, onDismiss = null } = {}) {
  const box = el('div', `extensions-outcome is-${outcome.tone}`);
  box.setAttribute('role', outcome.tone === 'error' ? 'alert' : 'status');
  const icon = el('span', 'extensions-outcome-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.append(createIcon(OUTCOME_ICONS[outcome.tone] || 'info', { size: 14 }));
  const body = el('div', 'extensions-outcome-body');
  body.append(el('div', 'extensions-outcome-title', name ? `${name}：${outcome.title}` : outcome.title));
  if (outcome.text) body.append(el('p', 'extensions-outcome-text', outcome.text));
  if (outcome.hint) body.append(el('p', 'extensions-outcome-text', outcome.hint));
  if (outcome.manual) body.append(extensionCommandRow(outcome.manual));
  if (outcome.retry && typeof onRetry === 'function') {
    const retry = el('button', 'btn tiny extensions-outcome-retry', '重试');
    retry.type = 'button';
    retry.onclick = onRetry;
    body.append(retry);
  }
  box.append(icon, body);
  if (typeof onDismiss === 'function') {
    const close = el('button', 'icon-btn extensions-outcome-close');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭提示');
    close.title = '关闭提示';
    close.append(createIcon('close', { size: 13 }));
    close.onclick = onDismiss;
    box.append(close);
  }
  return box;
}

/** 「更多」图标按钮（打开动作菜单的触发点）。 */
export function extensionMoreButton(label) {
  const button = el('button', 'icon-btn extensions-more');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-haspopup', 'menu');
  button.title = label;
  button.append(createIcon('more', { size: 15 }));
  return button;
}

/** 页签行右侧的搜索框。返回 `{ field, input }`，节点归调用的面板所有。 */
export function extensionSearchField({ placeholder, label }) {
  const field = el('label', 'extensions-search ds-search-field ds-search-control');
  field.append(createIcon('search', { size: 14, className: 'extensions-search-icon' }));
  const input = el('input', 'extensions-search-input');
  input.type = 'search';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  field.append(input);
  return { field, input };
}

/** 带图标的文字按钮（文字在自己的 span 里，忙碌时只换文字）。 */
export function extensionActionButton(className, label, icon = '') {
  const button = el('button', className);
  button.type = 'button';
  if (icon) button.append(createIcon(icon, { size: 14 }));
  button.append(el('span', 'extensions-action-label', label));
  return button;
}

/**
 * 按「这个包此刻有没有操作在跑」同步一个动作按钮。
 * @param busy   `operations.busyFor(key)` 的结果：null（空闲）/ `{ own: true, action, phase }`
 *               （就是这个包在操作）/ `{ own: false }`（别的包在操作）
 * @param action 这个按钮代表的动作（'install' | 'update' | 'remove'）
 * @param idle   空闲时的样子 `{ label, disabled }`
 */
export function extensionSyncActionButton(button, busy, action, idle) {
  const label = button.querySelector('.extensions-action-label') || button;
  const mine = Boolean(busy && busy.own && busy.action === action);
  if (mine) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
  label.textContent = mine && busy.phase === 'running' ? extensionOperationBusyLabel(action) : idle.label;
  button.disabled = Boolean(busy) || idle.disabled === true;
}
