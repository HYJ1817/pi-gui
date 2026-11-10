/* 任务列表的纯数据层（无 DOM）。
 *
 * 数据只认两类真实来源：
 *   1. gui_plan 工具**开始**事件的 args（实时、尚未返回）
 *   2. gui_plan 工具**结束**结果的 details（扩展已校验、已落进会话历史）
 *
 * 这里再做一次契约校验，不是不信任扩展，而是渲染端必须把「不可信输入」
 * 当成不可信输入：事件来自子进程 stdout，浏览器端不能假设它一定长成
 * version 1。校验失败就返回 null —— 不补字段、不猜状态、不把空列表画成
 * 「已完成 0/0」。
 *
 * 历史恢复只使用 toolResult 里真实存在的 details；没有 details 的未完成
 * 调用退回 args（那是模型确实提交过的列表），同样逐字段校验。
 */

export const PLAN_TOOL_NAME = 'gui_plan';
export const PLAN_VERSION = 1;
export const PLAN_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'cancelled'];

const MAX_TASKS = 100;
const MAX_TITLE = 300;
const MAX_EXPLANATION = 2000;
const STATUS_ALIASES = new Map([
  ['running', 'in_progress'],
  ['in-progress', 'in_progress'],
  ['inprogress', 'in_progress'],
  ['active', 'in_progress'],
  ['todo', 'pending'],
  ['done', 'completed'],
  ['complete', 'completed'],
  ['canceled', 'cancelled'],
]);

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function isPlanTool(name) {
  return name === PLAN_TOOL_NAME;
}

/** 状态文案只映射真实存在的五种；未知值返回空串，调用方不显示。 */
export function planStatusLabel(status) {
  return { pending: '待处理', in_progress: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消' }[status] || '';
}

/** 校验并归一一个计划 payload；失败返回 null。 */
export function normalizePlan(payload) {
  if (!plain(payload)) return null;
  if (!Array.isArray(payload.tasks) || payload.tasks.length === 0 || payload.tasks.length > MAX_TASKS) return null;
  const tasks = [];
  const seen = new Set();
  for (const item of payload.tasks) {
    if (!plain(item)) return null;
    const id = text(item.id, 120);
    const title = text(item.title, MAX_TITLE);
    const rawStatus = typeof item.status === 'string' ? item.status.trim().toLowerCase() : '';
    const status = STATUS_ALIASES.get(rawStatus) || rawStatus;
    if (!id || !title || !PLAN_STATUSES.includes(status) || seen.has(id)) return null;
    seen.add(id);
    const task = { id, title, status };
    if (item.retained === true) task.retained = true;
    tasks.push(task);
  }
  const completed = tasks.filter(task => task.status === 'completed').length;
  return {
    version: PLAN_VERSION,
    tasks,
    total: tasks.length,
    completed,
    explanation: text(payload.explanation, MAX_EXPLANATION) || null,
    revision: Number.isInteger(payload.revision) && payload.revision >= 0 ? payload.revision : null,
  };
}

/** 从一条历史 ToolEntry 还原计划：有 details 就以 details 为权威；
 *  只有「没有结果」的未完成调用才退回模型提交过的 args。
 *
 * 不能因为 details 非法就回退 args：那会把扩展明确拒绝的列表画成一张
 * 看起来已被接受的卡。结束事件存在时，它说什么就是什么。 */
export function planFromToolEntry(entry) {
  if (!entry || !isPlanTool(entry.name)) return null;
  if (entry.details !== undefined && entry.details !== null) {
    if (!plain(entry.details) || entry.details.version !== PLAN_VERSION) return null;
    return normalizePlan(entry.details);
  }
  return normalizePlan(entry.args);
}

/**
 * 按用户回合归并历史里的计划：一个回合只显示一张卡，内容取该回合最后一次
 * **有效**计划；首次出现的位置用来决定卡片插在哪一组工具之前。
 *
 * 输入是 tool-history.js 的 planHistory() 结果。返回 Map<turn, { plan, firstIndex }>。
 */
export function collectPlanTurns(items) {
  const byTurn = new Map();
  let turn = 0;
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    if (item?.kind === 'user') { turn += 1; return; }
    if (item?.kind !== 'tools' || !Array.isArray(item.entries)) return;
    for (const entry of item.entries) {
      const plan = planFromToolEntry(entry);
      if (!plan) continue;
      const current = byTurn.get(turn);
      if (current) current.plan = plan;
      else byTurn.set(turn, { plan, firstIndex: index });
    }
  });
  return byTurn;
}

/** 头部摘要：只报真实数字。 */
export function planCountsText(plan) {
  return plan ? `${plan.completed}/${plan.total}` : '';
}
