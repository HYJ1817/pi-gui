/* Plan / Task 数据模型 + DAG 校验 + 路径安全（规格 §3–§5、§14、§15、§43、§44）。
 *
 * 这个文件只有纯函数：不碰磁盘、不 spawn、不发事件。所以它能被单独测，
 * 也是「模型输出 = 不可信输入」这条规矩的落点 —— Planner 拿回来的 JSON 必须
 * 从这里过一遍（parse → validate → normalize），过不去就不许执行。
 *
 * ---------- 三条设计选择，都是刻意的 ----------
 *
 * 1. **状态用明确的枚举，不用 `done: true/false`**（规格 §4）。
 *    原因很实际：`done` 无法区分「失败」「被用户取消」「依赖没满足所以没跑」，
 *    而这三种在 UI 上要给完全不同的操作（重试 / 什么都不做 / 改依赖）。
 *
 * 2. **`cancelled` 不是 `failed`**（规格 §25）。用户主动停下来的东西标红成失败，
 *    会把「我按了停止」显示成「出错了」，然后诱导用户去重试一个他刚放弃的任务。
 *
 * 3. **workingDirectory 必须落在项目内，且必须已存在**（规格 §14/§15）。
 *    复用 `lib/safe-path.js` 的 `resolveProjectPath` —— 它已经处理了 `../`、
 *    绝对路径、Windows 盘符、UNC、以及 realpath 之后的 symlink/junction 逃逸。
 *    要求「已存在」是刻意的：不隐式建目录，第一版优先可预测。
 */
import path from 'node:path';
import { resolveProjectPath } from '../../lib/safe-path.js';

export const PLAN_STATUS = Object.freeze({
  DRAFT: 'draft',
  READY: 'ready',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  BLOCKED: 'blocked',
  READY: 'ready',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  SKIPPED: 'skipped',
  /** 上次进程死掉时它还在 running —— 原进程已经没了，不能假装还在跑（规格 §31） */
  INTERRUPTED: 'interrupted',
});

/** 不会再变的 task 状态。scheduler 靠它判断依赖是否已有结论。 */
export const TERMINAL_TASK_STATUS = Object.freeze([
  TASK_STATUS.SUCCESS,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
  TASK_STATUS.SKIPPED,
  TASK_STATUS.INTERRUPTED,
]);

/** 不会再变的 plan 状态。 */
export const TERMINAL_PLAN_STATUS = Object.freeze([PLAN_STATUS.COMPLETED, PLAN_STATUS.FAILED, PLAN_STATUS.CANCELLED]);

/** 第一版同一 workspace 只允许一个 running Plan（规格 §32）。 */
export const MAX_TASKS = 24;
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 8000;
export const MAX_GOAL = 4000;
export const DEFAULT_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 2;

let seq = 0;
export function newPlanId(now = Date.now()) {
  seq = (seq + 1) % 100000;
  return `plan-${now.toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const clampStr = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * 校验依赖图。**这是执行前的最后一道闸**（规格 §5）。
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateGraph(tasks) {
  const errors = [];
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, errors: ['计划里没有任何任务'] };
  }
  const ids = new Set();
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string' || !t.id) {
      errors.push('存在没有 id 的任务');
      continue;
    }
    if (ids.has(t.id)) errors.push(`任务 id 重复：${t.id}`);
    ids.add(t.id);
  }
  for (const t of tasks) {
    if (!t || !Array.isArray(t.dependsOn)) continue;
    for (const d of t.dependsOn) {
      if (d === t.id) errors.push(`任务 ${t.id} 依赖自己`);
      else if (!ids.has(d)) errors.push(`任务 ${t.id} 依赖了不存在的任务：${d}`);
    }
  }
  // 环检测：DFS 三色法，报出具体环路径，便于用户定位
  const color = new Map(); // 0 未访问 1 在栈上 2 完成
  const stack = [];
  const adj = new Map(tasks.filter((t) => t && t.id).map((t) => [t.id, (t.dependsOn || []).filter((d) => ids.has(d))]));
  let cycle = null;
  const dfs = (id) => {
    if (cycle) return;
    color.set(id, 1);
    stack.push(id);
    for (const next of adj.get(id) || []) {
      if (cycle) return;
      const c = color.get(next) || 0;
      if (c === 1) {
        const at = stack.indexOf(next);
        cycle = [...stack.slice(at), next];
        return;
      }
      if (c === 0) dfs(next);
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const t of tasks) {
    if (t && t.id && (color.get(t.id) || 0) === 0) dfs(t.id);
    if (cycle) break;
  }
  if (cycle) errors.push(`依赖成环：${cycle.join(' → ')}`);

  // 至少一个 root（没有依赖的任务），否则谁也起不来
  const roots = tasks.filter((t) => t && Array.isArray(t.dependsOn) && t.dependsOn.length === 0);
  if (tasks.length > 0 && roots.length === 0) errors.push('没有任何无依赖的任务（没有入口，无法开始执行）');

  return { ok: errors.length === 0, errors };
}

/** 归一化一个 task。`agentIds` 用来挡「模型编了一个不存在的 agent」（规格 §33）。 */
export function normalizeTask(raw, { index = 0, agentIds = [], projectRoot = null } = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ['任务不是对象'], warnings };

  const id = clampStr(raw.id, 120).trim() || `task-${index + 1}`;
  const title = clampStr(raw.title, MAX_TITLE).trim() || id;
  const description = clampStr(raw.description, MAX_DESCRIPTION);

  let agent = typeof raw.agent === 'string' && raw.agent.trim() ? raw.agent.trim() : 'auto';
  if (agent !== 'auto' && agentIds.length && !agentIds.includes(agent)) {
    errors.push(`任务 ${id} 指定了未知的 agent：${agent}`);
  }

  const dependsOn = Array.isArray(raw.dependsOn)
    ? raw.dependsOn.filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim())
    : [];
  const uniqueDeps = [...new Set(dependsOn)];
  if (uniqueDeps.length !== dependsOn.length) warnings.push(`任务 ${id} 的 dependsOn 里有重复项，已去重`);

  // workingDirectory：默认 '.'；必须相对、必须在项目内、必须已存在
  const rawWd = typeof raw.workingDirectory === 'string' && raw.workingDirectory.trim() ? raw.workingDirectory.trim() : '.';
  let workingDirectory = '.';
  if (projectRoot) {
    const resolved = resolveProjectPath(projectRoot, rawWd);
    if (!resolved.ok) {
      errors.push(`任务 ${id} 的工作目录不可用（${rawWd}）：${resolved.error}`);
    } else {
      workingDirectory = resolved.rel ? resolved.rel.split(path.sep).join('/') : '.';
    }
  } else if (rawWd !== '.') {
    workingDirectory = rawWd;
  }

  /* verification（规格 §43）：只**保存描述**，Pi GUI 绝不自己去 shell 执行它。
   * 它会被拼进 task 的 instruction 交给 Agent 执行 —— 因为「谁执行」这件事
   * 必须只有一个答案，两个地方都能跑命令等于多开一个没人管的执行面。 */
  let verification = null;
  if (typeof raw.verification === 'string' && raw.verification.trim()) {
    verification = { command: clampStr(raw.verification, 500).trim() };
  } else if (isPlainObject(raw.verification)) {
    const cmd = clampStr(raw.verification.command, 500).trim();
    const desc = clampStr(raw.verification.description, 500).trim();
    if (cmd) verification = { command: cmd };
    else if (desc) verification = { description: desc };
  }

  const task = {
    id,
    title,
    description,
    agent,
    workingDirectory,
    dependsOn: uniqueDeps,
    status: TASK_STATUS.PENDING,
    startedAt: null,
    endedAt: null,
    attempt: 0,
    attempts: [],
    result: null,
    error: '',
    verification,
  };
  return { ok: errors.length === 0, task, errors, warnings };
}

/**
 * 归一化一个 plan。**Planner 的输出必须从这里过**（规格 §7/§33）。
 * @returns {{ok:boolean, plan:object|null, errors:string[], warnings:string[]}}
 */
export function normalizePlan(raw, { agentIds = [], projectRoot = null, now = Date.now() } = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) return { ok: false, plan: null, errors: ['计划不是对象'], warnings };

  const title = clampStr(raw.title, MAX_TITLE).trim() || '未命名计划';
  const goal = clampStr(raw.goal, MAX_GOAL).trim();

  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  if (rawTasks.length === 0) errors.push('计划里没有任何任务');
  if (rawTasks.length > MAX_TASKS) errors.push(`任务数超过上限 ${MAX_TASKS}（拆得太碎反而不如少几个大任务）`);

  const tasks = [];
  rawTasks.slice(0, MAX_TASKS).forEach((t, i) => {
    const r = normalizeTask(t, { index: i, agentIds, projectRoot });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    if (r.task) tasks.push(r.task);
  });

  const graph = validateGraph(tasks);
  // validateGraph 也会报「没有任务」，这里去重，避免同一句话说两遍
  for (const e of graph.errors) if (!errors.includes(e)) errors.push(e);

  if (errors.length) return { ok: false, plan: null, errors, warnings };

  const plan = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newPlanId(now),
    title,
    goal,
    status: PLAN_STATUS.READY,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    endedAt: null,
    projectRoot: projectRoot || null,
    concurrency: DEFAULT_CONCURRENCY,
    tasks,
    /** 原始 Planner 输出留档 —— 生成失败时给用户看「模型到底说了什么」（规格 §33） */
    source: typeof raw.source === 'string' ? raw.source.slice(0, 20000) : null,
  };
  return { ok: true, plan, errors, warnings };
}

/** 拓扑序（同层按数组顺序），供串行调度使用。 */
export function topoOrder(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = [];
  const visited = new Set();
  const visit = (t) => {
    if (visited.has(t.id)) return;
    visited.add(t.id);
    for (const d of t.dependsOn) {
      const dep = byId.get(d);
      if (dep) visit(dep);
    }
    out.push(t);
  };
  for (const t of tasks) visit(t);
  return out;
}

/**
 * 按依赖结果算出每个非终态 task 应该是什么状态。
 *
 * 规则（规格 §16 / §26）：
 *   - 依赖全部 success → ready
 *   - 任一依赖 failed / cancelled / interrupted / skipped → blocked
 *     （**跳过不会自动放行依赖者**，用户要自己改依赖 —— 规格 §26 明确要求）
 *   - 依赖还没结论 → pending
 *
 * @returns {Map<string,string>} id → 建议状态（只包含当前处于 pending/blocked/ready 的 task）
 */
export function computeReadyStates(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = new Map();
  for (const t of tasks) {
    if (TERMINAL_TASK_STATUS.includes(t.status) || t.status === TASK_STATUS.RUNNING) continue;
    let ready = true;
    let blocked = false;
    for (const d of t.dependsOn) {
      const dep = byId.get(d);
      if (!dep) {
        blocked = true;
        break;
      }
      if (dep.status === TASK_STATUS.SUCCESS) continue;
      if (TERMINAL_TASK_STATUS.includes(dep.status)) {
        blocked = true;
        break;
      }
      ready = false; // 依赖还没跑完
    }
    out.set(t.id, blocked ? TASK_STATUS.BLOCKED : ready ? TASK_STATUS.READY : TASK_STATUS.PENDING);
  }
  return out;
}

/** Plan 是否已经跑完（所有 task 都是终态）。 */
export function isPlanSettled(plan) {
  return plan.tasks.every((t) => TERMINAL_TASK_STATUS.includes(t.status));
}

/** 汇总：有没有失败 / 有没有被取消。用于决定 plan 的终态。 */
export function summarizePlan(plan) {
  const failed = plan.tasks.filter((t) => t.status === TASK_STATUS.FAILED || t.status === TASK_STATUS.INTERRUPTED).length;
  const cancelled = plan.tasks.filter((t) => t.status === TASK_STATUS.CANCELLED).length;
  const skipped = plan.tasks.filter((t) => t.status === TASK_STATUS.SKIPPED).length;
  const success = plan.tasks.filter((t) => t.status === TASK_STATUS.SUCCESS).length;
  return { total: plan.tasks.length, success, failed, cancelled, skipped };
}

/**
 * 组装交给 Agent 的 prompt（规格 §43：verification 作为 instruction 的一部分，
 * 由 Agent 执行，不由 Pi GUI 执行）。
 */
export function buildTaskPrompt(plan, task) {
  const lines = [];
  lines.push(`# 任务：${task.title}`);
  lines.push('');
  if (plan.goal) {
    lines.push(`整体目标：${plan.goal}`);
    lines.push('');
  }
  if (task.description) {
    lines.push(task.description);
    lines.push('');
  }
  lines.push(`工作目录：${task.workingDirectory === '.' ? '项目根目录' : task.workingDirectory}`);
  const deps = task.dependsOn.map((d) => {
    const t = plan.tasks.find((x) => x.id === d);
    return t ? `${t.title}（${t.status}）` : d;
  });
  if (deps.length) {
    // 不写「已完成」——这个函数在 task 真正开跑前也会被调用来预览 prompt，
    // 那时依赖其实还没跑，写成「已完成」就是在撒谎。
    lines.push(`前置任务（本任务开始前应已结束）：${deps.join('；')}`);
  }
  if (task.verification) {
    const v = task.verification.command || task.verification.description;
    lines.push('');
    lines.push(`完成后请验证：${v}`);
  }
  lines.push('');
  lines.push('请只完成上面这一件事，不要顺手改动无关文件，不要执行 git commit / git push。');
  return lines.join('\n');
}
