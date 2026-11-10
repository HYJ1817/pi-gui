/* 任务列表的 DOM 层。
 *
 * 只认 plan-model.normalizePlan() 的结果。所有任务标题都走 textContent；
 * 唯一的 innerHTML 是本文件里写死的状态图标常量，不含任何外部文本。
 *
 * 更新策略：按稳定 id 复用 <li>，只改真正变化的文字 / 状态 / 顺序。
 * 流式期间计划可能连续更新十几次，整表 replaceChildren() 会让滚动位置和
 * 键盘焦点一起跳；这里只动变化的节点。用户手动折叠后，后续更新不碰
 * aria-expanded / hidden —— 展开状态属于用户，不属于数据。
 */

import { planStatusLabel } from './plan-model.js';

const ICON = {
  pending: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5" stroke-dasharray="2.4 2.8"/></svg>',
  in_progress: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/><circle class="plan-pulse-dot" cx="12" cy="12" r="2.1"/></svg>',
  completed: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="5.5 12.5 10 17 18.5 7.5"/></svg>',
  failed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 7.5l9 9M16.5 7.5l-9 9"/></svg>',
  cancelled: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 12h11"/></svg>',
};

let planId = 0;

function setText(node, value) {
  const next = String(value ?? '');
  if (node.textContent !== next) node.textContent = next;
}

function createRow() {
  const row = document.createElement('li');
  row.className = 'plan-item';
  const icon = document.createElement('span');
  icon.className = 'plan-icon';
  const title = document.createElement('span');
  title.className = 'plan-text';
  const state = document.createElement('span');
  state.className = 'plan-state';
  row.append(icon, title, state);
  row._planRow = { icon, title, state, status: null, iconStatus: null };
  return row;
}

function updateRow(row, task, stalled) {
  const p = row._planRow;
  row.dataset.status = task.status;
  row.dataset.retained = task.retained ? 'true' : 'false';
  const label = planStatusLabel(task.status);
  row.setAttribute('aria-label', `${task.title}，${label || '状态未知'}`);
  if (p.iconStatus !== task.status) {
    p.iconStatus = task.status;
    p.icon.innerHTML = ICON[task.status] || ICON.pending;
  }
  setText(p.title, task.title);
  /* 完成与待处理不额外挂状态文字：一个干净的对勾 / 低对比圆点已经说明了，
   * 右侧再写「已完成 / 待处理」只会让列表变吵。失败、取消、进行中必须写。 */
  p.stalled = stalled;
  setText(p.state, stateTextFor(task, stalled));
}

function stateTextFor(task, stalled) {
  if (task.status === 'in_progress' && stalled) return '未完成';
  return ['in_progress', 'failed', 'cancelled'].includes(task.status) ? planStatusLabel(task.status) : '';
}

/** 执行已经结束但计划里仍有 in_progress：不伪造 completed，也不继续显示「进行中」。
 *  数据状态保持扩展最后一次真实上报的值，只把**展示文案**改成「未完成」。 */
export function setPlanStalled(card, stalled) {
  const p = card?._plan;
  if (!p) return;
  const value = stalled === true;
  card.dataset.stalled = String(value);
  for (const row of p.rows.values()) {
    const status = row.dataset.status;
    const state = row._planRow.state;
    setText(state, stateTextFor({ status }, value));
  }
}

export function renderPlan(plan) {
  const card = document.createElement('section');
  card.className = 'plan-card';
  card.setAttribute('aria-label', '任务列表');

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'plan-head';
  head.setAttribute('aria-expanded', 'true');

  const title = document.createElement('span');
  title.className = 'plan-title';
  title.textContent = '任务列表';
  const count = document.createElement('span');
  count.className = 'plan-count';
  const chev = document.createElement('span');
  chev.className = 'plan-chev';
  chev.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 5.5L16 12l-6.5 6.5"/></svg>';
  head.append(title, count, chev);

  const list = document.createElement('ol');
  list.className = 'plan-list';
  list.id = 'plan-list-' + ++planId;
  head.setAttribute('aria-controls', list.id);

  card.append(head, list);
  card._plan = { head, count, list, rows: new Map(), collapsed: false };

  head.addEventListener('click', () => {
    const p = card._plan;
    if (!p) return;
    p.collapsed = !p.collapsed;
    list.hidden = p.collapsed;
    head.setAttribute('aria-expanded', String(!p.collapsed));
  });

  updatePlan(card, plan);
  return card;
}

/** 就地更新。返回是否真的应用了这个 plan。 */
export function updatePlan(card, plan) {
  const p = card?._plan;
  if (!p || !plan || !Array.isArray(plan.tasks) || !plan.tasks.length) return false;

  const countText = `${plan.completed}/${plan.total}`;
  setText(p.count, countText);
  p.count.setAttribute('aria-label', `已完成 ${countText}`);

  const stalled = card.dataset.stalled === 'true';
  const wanted = new Set();
  plan.tasks.forEach((task, index) => {
    wanted.add(task.id);
    let row = p.rows.get(task.id);
    if (!row) {
      row = createRow();
      p.rows.set(task.id, row);
    }
    updateRow(row, task, stalled);
    const current = p.list.children[index];
    if (current !== row) p.list.insertBefore(row, current || null);
  });

  for (const [id, row] of p.rows) {
    if (wanted.has(id)) continue;
    row.remove();
    p.rows.delete(id);
  }

  p.list.hidden = p.collapsed === true;
  p.head.setAttribute('aria-expanded', String(!p.collapsed));
  return true;
}
