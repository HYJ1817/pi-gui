/* gui_plan —— GUI 的任务列表数据源。
 *
 * 为什么必须是 Pi 扩展，而不是从工具调用数量推断：
 *   「计划」是模型对任务结构的显式声明，只有模型自己知道「第 3 步真的完成了」。
 *   从 bash/read/write 的次数或时长去猜进度，等于编造。Pi 1.5.0 没有内置计划工具，
 *   官方只给了 todo.ts / plan-mode 示例；这里按同一套 Extension API 注册一个
 *   GUI 自带的工具，让两种运行模式（Classic / Runtime）都能拿到**同一条真实事件**。
 *
 * 数据契约（version 1，服务端投影与前端渲染都按它校验）：
 *   details = {
 *     version: 1,
 *     tool: 'gui_plan',
 *     tasks: [{ id, title, status, retained? }],
 *     counts: { total, completed },
 *     explanation: string | null,
 *     revision: number,
 *     updatedAt: number,
 *     turnId?: string
 *   }
 *
 *   turnId 是真实运行边界：settled 之后的第一次用户消息开启新 turn 时生成，
 *   运行中的 steer / follow-up 沿用同一个 id。历史恢复据此把同一任务的
 *   计划更新归并到一张卡；没有该字段的旧记录只能退回「按用户消息分组」。
 *
 * 关键规则：
 *   - 每次调用提交的是**完整列表**，不是增量。id 必须稳定；重复 id 直接拒绝，
 *     不做「自动改名」——那会让界面上的任务悄悄换身份。
 *   - 同一轮执行里，模型若在重新规划时漏掉已经 completed / failed / cancelled
 *     的任务，扩展把它们保留下来并标 retained:true。完成记录不能因为一次
 *     列表重写就消失。
 *   - 新的一轮用户任务开始时（上一次 agent 已 settled），第一次 gui_plan 调用
 *     开一张新列表，不继承上一轮的完成项 —— 否则旧任务会永远堆在新计划后面。
 *   - 状态只接受 pending / in_progress / completed / failed / cancelled；
 *     running 等别名归一成 in_progress，其它值拒绝。绝不替模型猜状态。
 *
 * 该文件保持零第三方依赖、零 Node API：开发时直接作为 --extension 加载，
 * 打包时由 build-exe 原样收进 assets；测试也能在普通 Node 里导入纯函数。
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
const trimmed = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

/* 真实运行 id：只在 settled 之后的新用户消息上生成一次，steer 复用。
 * 不是安全令牌，只用于历史归并；只用窄字符集，避免把任意文本带出扩展。 */
function makeTurnId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* 环境没有 Web Crypto 时退回时间 + 随机后缀 */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 归一一条任务；非法返回 { error }，绝不静默修成另一个状态。 */
function normalizeTask(raw, index) {
  if (!plain(raw)) return { error: `第 ${index + 1} 项不是对象` };
  const title = trimmed(raw.title, MAX_TITLE);
  if (!title) return { error: `第 ${index + 1} 项缺少 title` };
  const id = trimmed(raw.id, 120);
  if (!id) return { error: `第 ${index + 1} 项缺少稳定 id` };
  const rawStatus = typeof raw.status === 'string' ? raw.status.trim().toLowerCase() : '';
  const status = STATUS_ALIASES.get(rawStatus) || rawStatus;
  if (!PLAN_STATUSES.includes(status)) {
    return { error: `第 ${index + 1} 项状态无效：${String(raw.status ?? '')}` };
  }
  const task = { id, title, status };
  if (raw.retained === true) task.retained = true;
  return { task };
}

/**
 * 校验模型提交的完整任务列表。
 *
 * 返回 { ok:true, tasks, explanation } 或 { ok:false, error }。
 * 空列表视为非法：一个没有步骤的「计划」在界面上只会是一张空卡。
 */
export function normalizePlanInput(input) {
  if (!plain(input)) return { ok: false, error: '参数必须是对象' };
  if (!Array.isArray(input.tasks)) return { ok: false, error: 'tasks 必须是数组' };
  if (!input.tasks.length) return { ok: false, error: '任务列表不能为空' };
  if (input.tasks.length > MAX_TASKS) return { ok: false, error: `任务最多 ${MAX_TASKS} 项` };
  const tasks = [];
  const seen = new Set();
  for (let i = 0; i < input.tasks.length; i++) {
    const { task, error } = normalizeTask(input.tasks[i], i);
    if (error) return { ok: false, error };
    if (seen.has(task.id)) return { ok: false, error: `任务 id 重复：${task.id}` };
    seen.add(task.id);
    tasks.push(task);
  }
  const explanation = trimmed(input.explanation, MAX_EXPLANATION) || null;
  return { ok: true, tasks, explanation };
}

/** 重新规划时保留被漏掉的终态任务；顺序放在新列表之后，不改写它们的真实状态。 */
export function retainFinished(previous, incoming) {
  const ids = new Set(incoming.map(task => task.id));
  const retained = [];
  for (const task of Array.isArray(previous) ? previous : []) {
    if (!task || ids.has(task.id)) continue;
    if (!['completed', 'failed', 'cancelled'].includes(task.status)) continue;
    retained.push({ id: task.id, title: task.title, status: task.status, retained: true });
  }
  return [...incoming, ...retained];
}

export function planCounts(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  return { total: list.length, completed: list.filter(task => task.status === 'completed').length };
}

function summarize(tasks, explanation) {
  const counts = planCounts(tasks);
  const active = tasks.find(task => task.status === 'in_progress');
  const failed = tasks.filter(task => task.status === 'failed').length;
  const bits = [`任务列表已更新：${counts.completed}/${counts.total} 已完成`];
  if (active) bits.push(`进行中：${active.title}`);
  if (failed) bits.push(`失败 ${failed}`);
  if (explanation) bits.push(explanation);
  return bits.join('；');
}

export default function piGuiPlan(pi) {
  /* 当前分支上的计划状态。session_start / session_tree 时从真实 toolResult
   * 的 details 重建；扩展进程被重启也不会把计划当成不存在。 */
  let tasks = [];
  let revision = 0;
  let explanation = null;
  /* 上一轮是否已经 settle。settled 后第一次 before_agent_start 代表新一轮用户任务；
   * 运行中的 steer 不开新列表，避免把同一轮已完成的任务清掉。 */
  let settled = true;
  let freshTurn = false;
  let currentTurnId = null;

  function reconstruct(ctx) {
    tasks = [];
    revision = 0;
    explanation = null;
    try {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry?.type !== 'message') continue;
        const msg = entry.message;
        if (msg?.role !== 'toolResult' || msg?.toolName !== PLAN_TOOL_NAME) continue;
        const details = msg.details;
        if (!plain(details) || details.version !== PLAN_VERSION || !Array.isArray(details.tasks)) continue;
        const checked = normalizePlanInput({ tasks: details.tasks, explanation: details.explanation });
        if (!checked.ok) continue;
        tasks = checked.tasks;
        explanation = checked.explanation;
        revision = Number.isInteger(details.revision) && details.revision >= 0 ? details.revision : revision + 1;
      }
    } catch {
      /* 读不到分支就保持空计划；UI 在拿到下一次真实调用前不会显示任务列表。 */
    }
  }

  pi.on('session_start', async (_event, ctx) => reconstruct(ctx));
  pi.on('session_tree', async (_event, ctx) => reconstruct(ctx));
  pi.on('agent_settled', async () => { settled = true; });
  /* 只在这里判断「新一轮」：before_agent_start 的先后顺序在不同 pi 版本里
   * 可能和 agent_start 互换，用 settled 做唯一判据就不会被顺序影响。运行中
   * 的 steer 会在同一次 run 里再次触发它，此时 settled=false，不开新列表。 */
  pi.on('before_agent_start', async event => {
    if (event?.messageType !== 'user') return;
    freshTurn = settled;
    settled = false;
    /* 只有真正的新任务才换 turnId；运行中的 steer 保持同一个 id，
     * 历史恢复据此不会给同一任务开两张计划卡。 */
    if (freshTurn) currentTurnId = makeTurnId();
  });

  pi.registerTool({
    name: PLAN_TOOL_NAME,
    label: '任务列表',
    description:
      '创建或更新当前任务的执行步骤。复杂任务（通常 3 步以上）开始时调用；每次调用提交完整任务列表，' +
      'id 必须稳定复用。状态只能是 pending / in_progress / completed / failed / cancelled。' +
      '只有真正完成的工作才标为 completed；简单问答不要调用。',
    promptSnippet: 'Create or update a structured task list for the current multi-step task',
    promptGuidelines: [
      'Use gui_plan for complex, multi-step tasks (typically 3+ steps): create the task list when work starts and update it as steps actually progress.',
      'When calling gui_plan, send the complete list every time with stable task ids; mark a task completed only after its work is truly finished. Do not use gui_plan for simple questions.',
    ],
    parameters: {
      type: 'object',
      properties: {
        explanation: {
          type: 'string',
          description: 'Optional short note about this plan update, shown to the user.',
        },
        tasks: {
          type: 'array',
          description: 'The complete task list. Reuse ids across updates.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable task id, e.g. "inspect", "implement", "test".' },
              title: { type: 'string', description: 'Short user-visible task title.' },
              status: { type: 'string', enum: PLAN_STATUSES },
            },
            required: ['id', 'title', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const checked = normalizePlanInput(params);
      if (!checked.ok) {
        return {
          content: [{ type: 'text', text: `任务列表未更新：${checked.error}` }],
          details: { version: PLAN_VERSION, tool: PLAN_TOOL_NAME, error: 'invalid_plan', reason: checked.error },
          isError: true,
        };
      }

      const next = freshTurn ? checked.tasks : retainFinished(tasks, checked.tasks);
      freshTurn = false;
      tasks = next;
      explanation = checked.explanation;
      revision += 1;
      const counts = planCounts(tasks);
      const details = {
        version: PLAN_VERSION,
        tool: PLAN_TOOL_NAME,
        tasks: tasks.map(task => ({ ...task })),
        counts,
        explanation,
        revision,
        updatedAt: Date.now(),
        ...(currentTurnId ? { turnId: currentTurnId } : {}),
      };
      return {
        content: [{ type: 'text', text: summarize(tasks, explanation) }],
        details,
      };
    },
  });
}
