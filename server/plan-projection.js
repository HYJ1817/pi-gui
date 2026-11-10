/* Runtime 的 gui_plan 窄投影。
 *
 * Runtime 的事件出站口（session-runtime.js）刻意剥掉工具参数与结果正文：
 * 浏览器不应看到模型传来的任意 payload。任务列表是个例外 —— 但也不是
 * 「把 details 原样放行」：这里按 version 1 契约逐字段重建，只允许
 * id / title / status / retained，长度与数量都有硬上限，未知字段一律丢弃。
 *
 * Classic 走原始 SSE，不经过这里；前端 plan-model.js 会再做一次同契约校验。
 * 三处各校验一次不是重复建设：扩展是数据源，服务端是出站边界，渲染端是
 * 最后一道 DOM 边界，任何一层都不该信任上一层「已经验过了」。
 */

export const PLAN_TOOL_NAME = 'gui_plan';
export const PLAN_VERSION = 1;

const STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed', 'cancelled']);
const MAX_TASKS = 100;
const MAX_TITLE = 300;
const MAX_EXPLANATION = 2000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function text(value, max) {
  if (typeof value !== 'string') return '';
  const out = value.trim();
  return out.length > max ? out.slice(0, max) : out;
}

function projectTasks(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TASKS) return null;
  const tasks = [];
  const seen = new Set();
  for (const item of raw) {
    if (!plain(item)) return null;
    const id = text(item.id, 120);
    const title = text(item.title, MAX_TITLE);
    const status = typeof item.status === 'string' ? item.status.trim().toLowerCase() : '';
    if (!id || !title || !STATUSES.has(status) || seen.has(id)) return null;
    seen.add(id);
    const task = { id, title, status };
    if (item.retained === true) task.retained = true;
    tasks.push(task);
  }
  return tasks;
}

function finish(tasks, explanation, revision, updatedAt) {
  return {
    version: PLAN_VERSION,
    tasks,
    counts: { total: tasks.length, completed: tasks.filter(task => task.status === 'completed').length },
    explanation: text(explanation, MAX_EXPLANATION) || null,
    revision: Number.isInteger(revision) && revision >= 0 ? revision : null,
    updatedAt: Number.isInteger(updatedAt) && updatedAt > 0 ? updatedAt : null,
  };
}

/**
 * tool_execution_start 参数 → 可转发给 Runtime 的窄计划。
 * 只认 gui_plan；其它工具返回 null。
 */
export function projectPlanArgs(toolName, args) {
  if (toolName !== PLAN_TOOL_NAME || !plain(args)) return null;
  const tasks = projectTasks(args.tasks);
  if (!tasks) return null;
  return finish(tasks, args.explanation, null, null);
}

/**
 * tool_execution_end 结果 → 可转发给 Runtime 的窄计划。
 * 以 details.tool / details.version 认领，因为 pi 的 end 事件不带 toolName。
 */
export function projectPlanResult(result) {
  const details = plain(result) ? result.details : null;
  if (!plain(details) || details.tool !== PLAN_TOOL_NAME || details.version !== PLAN_VERSION) return null;
  const tasks = projectTasks(details.tasks);
  if (!tasks) return null;
  return finish(tasks, details.explanation, details.revision, details.updatedAt);
}
