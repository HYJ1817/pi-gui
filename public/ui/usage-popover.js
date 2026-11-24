/* Lightweight usage popover owned by the assistant action bar.
 *
 * It is fixed-positioned, so opening and closing never changes message height
 * or scroll position. It avoids viewport edges and the composer, closes on
 * outside pointer, Escape, Tab-away, resize or scroll, and only shows real Pi
 * usage fields. Reasoning is a subset of output and is labelled as such. */

import { USAGE_FIELDS, formatUsageNumber, mergeUsages, normalizeUsage, validCost } from '../message-meta.js';
import { formatElapsed, elapsedOf } from './turn-fold.js';
import { hideTooltip } from './tooltip.js';

let pop = null;
let anchor = null;

function documentOf() {
  return anchor?.ownerDocument || globalThis.document || null;
}

function recordList(records) {
  return (Array.isArray(records) ? records : []).map(record => {
    const usage = normalizeUsage(record?.usage ?? record);
    if (!usage) return null;
    return {
      usage,
      model: typeof record?.model === 'string' ? record.model : '',
      responseId: typeof record?.responseId === 'string' ? record.responseId : '',
    };
  }).filter(Boolean);
}

function addRows(grid, usage) {
  for (const [key, label] of USAGE_FIELDS) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) continue;
    const term = document.createElement('span');
    term.className = 'usage-pop-term';
    term.textContent = key === 'reasoning' ? label + '（含在输出中）' : label;
    const value = document.createElement('b');
    value.className = 'usage-pop-value';
    value.dataset.kind = key;
    value.textContent = formatUsageNumber(usage[key]) + ' Token';
    grid.append(term, value);
  }
  const cost = validCost(usage);
  if (cost !== null) {
    const term = document.createElement('span');
    term.className = 'usage-pop-term';
    term.textContent = '预估成本';
    const value = document.createElement('b');
    value.className = 'usage-pop-value';
    value.dataset.kind = 'cost';
    value.textContent = cost.toFixed(4);
    grid.append(term, value);
  }
}

function sectionTitle(document, text, sub = '') {
  const head = document.createElement('div');
  head.className = 'usage-pop-section-title';
  const title = document.createElement('span');
  title.textContent = text;
  head.append(title);
  if (sub) {
    const model = document.createElement('span');
    model.className = 'usage-pop-model';
    model.textContent = sub;
    head.append(model);
  }
  return head;
}

function buildContent(document, records, options) {
  const list = recordList(records);
  if (!list.length) return null;
  const merged = mergeUsages(list.map(record => record.usage));
  const root = document.createElement('div');
  root.className = 'usage-pop-content';

  const head = document.createElement('div');
  head.className = 'usage-pop-head';
  const title = document.createElement('span');
  title.textContent = options.label || (list.length > 1 ? '本轮用量' : '本条助手消息用量');
  head.append(title);
  const summary = mergeUsages(list.map(record => record.usage));
  const total = summary?.totalTokens;
  if (Number.isSafeInteger(total)) {
    const big = document.createElement('b');
    big.className = 'usage-pop-total';
    big.textContent = 'Token ' + formatUsageNumber(total);
    head.append(big);
  }
  root.append(head);

  const timing = options.timing || null;
  const status = options.status || '';
  const duration = timing ? elapsedOf(timing, { status, now: options.now ?? Date.now() }) : '';
  if (duration && duration !== '不到 1 秒') {
    const meta = document.createElement('div');
    meta.className = 'usage-pop-meta';
    meta.textContent = (status === 'running' ? '已运行 ' : '耗时 ') + duration;
    root.append(meta);
  }

  const grid = document.createElement('div');
  grid.className = 'usage-pop-grid';
  addRows(grid, merged || list[0].usage);
  root.append(grid);

  if (options.partial) {
    const note = document.createElement('div');
    note.className = 'usage-pop-note';
    note.textContent = '流式中，Pi 仍在累计；显示的是当前可用值。';
    root.append(note);
  }

  if (list.length > 1) {
    for (const [index, record] of list.entries()) {
      const section = document.createElement('section');
      section.className = 'usage-pop-response';
      section.append(sectionTitle(document, '响应 ' + (index + 1), record.model));
      const rows = document.createElement('div');
      rows.className = 'usage-pop-grid';
      addRows(rows, record.usage);
      section.append(rows);
      root.append(section);
    }
  } else if (list[0].model) {
    const model = document.createElement('div');
    model.className = 'usage-pop-meta usage-pop-model-line';
    model.textContent = '模型 ' + list[0].model;
    root.append(model);
  }
  return root;
}

function close({ restoreFocus = false } = {}) {
  if (!pop) return;
  const previous = anchor;
  pop.hidden = true;
  pop.replaceChildren();
  pop.style.maxHeight = '';
  previous?.setAttribute('aria-expanded', 'false');
  anchor = null;
  if (restoreFocus && previous?.isConnected) previous.focus({ preventScroll: true });
}

export function closeUsagePopover() {
  close();
}

export function usagePopoverVisible() {
  return Boolean(pop && !pop.hidden);
}

function ensurePop(document) {
  if (pop?.ownerDocument === document) return pop;
  pop?.remove();
  pop = document.createElement('div');
  pop.className = 'ui-usage-pop';
  pop.id = 'messageUsagePopover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', '消息用量');
  pop.hidden = true;
  document.body.append(pop);

  document.addEventListener('mousedown', event => {
    if (!pop || pop.hidden) return;
    if (pop.contains(event.target)) return;
    if (anchor && (anchor === event.target || anchor.contains(event.target))) return;
    close();
  });
  document.addEventListener('keydown', event => {
    if (!pop || pop.hidden || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    const hadFocus = pop.contains(event.target);
    close({ restoreFocus: hadFocus });
  }, true);
  document.addEventListener('focusin', event => {
    if (!pop || pop.hidden) return;
    if (event.target === anchor || pop.contains(event.target)) return;
    close();
  });
  const view = document.defaultView;
  view?.addEventListener('resize', () => close());
  view?.addEventListener('scroll', event => {
    if (!pop || pop.hidden) return;
    if (pop.contains(event.target)) return;
    close();
  }, true);
  return pop;
}

function place() {
  if (!pop || !anchor) return;
  const view = pop.ownerDocument.defaultView;
  if (!view) return;
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  const composer = pop.ownerDocument.querySelector('#chatComposer, #composerBox, .composer');
  const composerRect = composer && composer.getClientRects().length ? composer.getBoundingClientRect() : null;
  const bottomLimit = composerRect && composerRect.top > rect.top
    ? composerRect.top - margin : view.innerHeight - margin;
  pop.style.maxHeight = Math.max(80, bottomLimit - margin) + 'px';
  const box = pop.getBoundingClientRect();
  let left = rect.left;
  if (left + box.width > view.innerWidth - margin) left = view.innerWidth - margin - box.width;
  left = Math.max(margin, left);
  let top = rect.top - box.height - gap;
  if (top < margin) top = rect.bottom + gap;
  if (top + box.height > bottomLimit) top = Math.max(margin, bottomLimit - box.height);
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';
}

/** Open (or toggle) the popover for an action-bar usage button. */
export function toggleUsagePopover(target, records, options = {}) {
  const document = target?.ownerDocument;
  if (!document) return;
  /* 触发器上的悬停提示在浮层打开后就是重复的一层：收起，避免盖住浮层顶部。 */
  hideTooltip();
  if (anchor === target && pop && !pop.hidden) {
    close({ restoreFocus: true });
    return;
  }
  close();
  const element = ensurePop(document);
  const content = buildContent(document, records, options);
  if (!content) return;
  element.replaceChildren(content);
  element.hidden = false;
  element.style.left = '-9999px';
  element.style.top = '-9999px';
  anchor = target;
  target.setAttribute('aria-expanded', 'true');
  place();
}
