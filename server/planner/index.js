/* Planner 路由 + 计划生成（规格 §7 / §8 / §22 / §33 / §34 / §35 / §38 / §40）。
 *
 * 这个文件是「Planner」那一半（生成/编辑计划），**不含执行逻辑** ——
 * 执行全在 scheduler.js。分开的理由见 scheduler.js 头部：换 Planner 不该动执行器。
 *
 * ---------- 计划怎么生成（§7） ----------
 *
 * 用 **pi 适配器 + 独立会话**，而不是复用主聊天的 rpc bridge。
 * 理由很直接：复用主聊天会把「给我拆个计划」这段 prompt 和模型的原始输出
 * 塞进用户正在看的对话里（§11 明确要避免），而且主 pi 进程可能正忙、或者
 * 用户正在另一个项目上聊天。独立会话两个问题都没有，代价只是多起一个进程。
 *
 * ---------- 模型输出永远是不可信输入（§7 / §33） ----------
 *
 * 流程固定是 parse → validate → normalize → reject：
 *   1. 从模型输出里**抽出**第一个完整的 JSON 对象（容忍 ```json 围栏与前后废话）
 *   2. normalizePlan() 做全部校验（id 唯一、依赖存在、无环、agent 存在、cwd 在项目内）
 *   3. 任何一步失败 → 返回 `generation_failed` + 失败原因 + **原始输出**（给诊断区看）
 * 绝不把没校验过的 plan 交给执行器。
 */
import { json, readBody } from '../http-utils.js';
import { isSafeSessionId } from '../../lib/session-id.js';
import { PLAN_STATUS, TASK_STATUS, DEFAULT_CONCURRENCY, MAX_CONCURRENCY, normalizePlan, summarizePlan } from './model.js';

const MAX_BODY = 512 * 1024;
/** 一次反向查询最多回多少条命中（一个会话被几十个任务用过是可能的，
 *  但界面上只需要一个能展开的列表，不需要把整个项目的历史都端上来）。 */
const MAX_RELATION_MATCHES = 50;

/* ---------- 从模型输出里抽 JSON ---------- */

/**
 * 抽第一个完整的 JSON 对象。容忍：
 *   - ```json … ``` 围栏
 *   - 前后有解释性文字
 *   - 字符串里带花括号（按引号状态机扫，不做正则）
 * 抽不到就回 null —— 由调用方报「模型没有返回 JSON」。
 */
export function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  let src = text.replace(/\r\n/g, '\n').trim();
  // 优先取代码围栏里的内容
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(src);
  if (fence) src = fence[1].trim();

  const start = src.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = src.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 给 Planner 的系统指令（§44：任务要独立、不要碎任务、不要编 agent、依赖显式、要有验证）。 */
export function buildPlannerPrompt({ goal, title, agentIds, maxTasks = 8 }) {
  return [
    '你是一个任务规划器。请把下面这个开发目标拆成一组**可独立执行**的任务，并以 JSON 返回。',
    '',
    `目标：${goal}`,
    '',
    '要求：',
    `1. 任务数量控制在 3~${maxTasks} 个之间。不要把一个需求拆成十几个微任务。`,
    '2. 每个任务要足够独立，单个任务内部应该是「一个 agent 一次能做完的一件事」。',
    '3. 最后一个任务应当是验证/收尾性质（跑测试、检查整体结果）。',
    `4. agent 只能从这些里面选：${agentIds.join('、')}。不确定就写 "auto"。`,
    '5. workingDirectory 必须是**相对项目根目录**的路径（如 "." 或 "src"），必须已存在。禁止绝对路径、禁止 ".."。',
    '6. dependsOn 必须显式写出（数组里放前置任务的 id）；没有前置就写空数组。',
    '7. 依赖不能成环，不能依赖自己，至少有一个任务没有前置依赖。',
    '',
    '只输出 JSON，不要任何解释文字。格式：',
    '```json',
    JSON.stringify(
      {
        title: title || '（计划标题）',
        goal: goal,
        tasks: [
          { id: 'inspect', title: '分析现状', description: '具体要做什么', agent: 'auto', workingDirectory: '.', dependsOn: [] },
          { id: 'verify', title: '运行测试验证', description: '跑测试并汇报结果', agent: 'auto', workingDirectory: '.', dependsOn: ['inspect'] },
        ],
      },
      null,
      2
    ),
    '```',
  ].join('\n');
}

export function createPlanner({ runtime, registry, store, scheduler, env = process.env, sessionDir = null, generate = null, sessions = null }) {
  /* ---------- 生成计划 ---------- */

  /** 默认生成器：用 pi 适配器 + 独立会话跑一次，然后严格校验它的输出。 */
  async function defaultGenerate({ goal, title }) {
    const adapter = registry.get('pi');
    if (!adapter) {
      return { ok: false, error: '本机没有 pi，无法生成计划。可以手工新建计划并添加任务。', raw: null };
    }
    const info = adapter.detect();
    if (!info.available) {
      return { ok: false, error: `pi 不可用：${info.detail}，可以手工新建计划并添加任务。`, raw: null };
    }
    const cwd = runtime.getCurrentCwd();
    if (!cwd) return { ok: false, error: '还没有选择项目', raw: null };

    const prompt = buildPlannerPrompt({ goal, title, agentIds: registry.ids().filter((id) => id !== 'fake') });
    let collected = '';
    const res = await adapter.start({
      task: { id: 'planner', title: '生成计划' },
      prompt,
      cwd,
      onEvent: (e) => {
        if (e.type === 'agent_output' && e.data && e.data.text) collected += e.data.text + '\n';
      },
      // 计划生成不该拖太久
      timeoutMs: 10 * 60 * 1000,
    });
    const raw = collected.trim() || res.summary || '';
    if (!res.success && !raw) return { ok: false, error: res.error || '生成失败', raw: '' };
    return { ok: true, raw };
  }

  const generateFn = generate || defaultGenerate;

  /**
   * 生成 → 校验 → 归一化。任何一步失败都带上原始输出（§33）。
   * @returns {{ok:true, plan}|{ok:false, error, raw, errors}}
   */
  async function generatePlan({ goal, title }) {
    const cwd = runtime.getCurrentCwd();
    if (!cwd) return { ok: false, error: '还没有选择项目', raw: null, errors: [] };

    let g;
    try {
      g = await generateFn({ goal, title });
    } catch (err) {
      return { ok: false, error: `生成时出错：${err.message}`, raw: null, errors: [] };
    }
    if (!g.ok) return { ok: false, error: g.error, raw: g.raw || null, errors: [] };

    const parsed = extractJsonObject(g.raw);
    if (!parsed) {
      return { ok: false, error: '模型没有返回可解析的 JSON 计划', raw: g.raw, errors: ['抽不出 JSON 对象'] };
    }
    const normalized = normalizePlan({ ...parsed, goal: parsed.goal || goal, title: parsed.title || title, source: g.raw }, {
      agentIds: registry.ids(),
      projectRoot: cwd,
    });
    if (!normalized.ok) {
      return { ok: false, error: '模型生成的计划没有通过校验', raw: g.raw, errors: normalized.errors };
    }
    return { ok: true, plan: normalized.plan, warnings: normalized.warnings, raw: g.raw };
  }

  /* ---------- 运行前的可用性检查（§34） ---------- */

  /** 检查计划里用到的 agent 在本机是否可用；不可用的列出来，让用户先换。 */
  function checkAgents(plan) {
    const problems = [];
    for (const t of plan.tasks) {
      const id = t.agent && t.agent !== 'auto' ? t.agent : registry.resolveAuto(null);
      if (!id) {
        problems.push({ taskId: t.id, agent: t.agent, reason: 'no-agent', detail: '本机没有任何可用的 Agent' });
        continue;
      }
      const info = registry.detect(id);
      if (!info || !info.available) {
        problems.push({ taskId: t.id, agent: id, reason: (info && info.reason) || 'unavailable', detail: (info && info.detail) || `${id} 不可用` });
      }
    }
    return problems;
  }

  /* ---------- P7：从任务跳到它的会话 ---------- */

  /**
   * 打开某个 task 某次尝试的会话。
   *
   * 复用**现有的**会话切换（`sessions.switchToTarget` → pi 的 `switch_session`），
   * 不自己加载会话文件 —— 前端的清屏 / 重建历史 / 提问导航全都挂在既有的
   * `afterSessionSwitch()` 上，另起一条加载路径会漏掉那些收尾。
   *
   * 三道闸，都是必须的：
   *   1. **任务不能在跑。** 那条会话文件此刻正被 Agent 进程追加写，主聊天的 pi
   *      切过去会变成两个进程写同一个 jsonl。
   *   2. **会话 id 必须合法**（由 resolveByUuid 挡），且解析出来的会话必须
   *      **属于当前项目**（归属判定在 sessions 里，这里不重写一份）。
   *   3. **找不到就如实说找不到**，不猜、不新建 —— 会话可能已被用户删掉。
   *
   * @param attemptParam 可选：指定第几次尝试。不传则取最近一次**有会话**的尝试
   *                     （最新那次可能因为 Agent 不支持而没关联到会话）。
   */
  async function openTaskSession(plan, taskId, attemptParam) {
    if (!sessions || typeof sessions.resolveByUuid !== 'function' || typeof sessions.switchToTarget !== 'function') {
      return { ok: false, error: '会话模块没有接入，暂时打不开会话' };
    }
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, error: '找不到这个任务' };
    const attempts = Array.isArray(task.attempts) ? task.attempts : [];
    const wanted = Number(attemptParam);
    const attempt =
      Number.isFinite(wanted) && wanted > 0
        ? attempts.find((a) => a.attempt === wanted) || null
        : attempts.slice().reverse().find((a) => a.sessionId) || attempts[attempts.length - 1] || null;
    if (!attempt) return { ok: false, error: '这个任务还没有执行过，没有可打开的会话' };
    if (!attempt.sessionId) {
      return { ok: false, error: '这次执行没有关联会话（所用的 Agent 不提供会话关联）' };
    }
    if (task.status === TASK_STATUS.RUNNING) {
      return { ok: false, error: '这个任务正在执行，它的会话正被写入。等它结束后再打开。' };
    }
    const target = sessions.resolveByUuid(attempt.sessionId);
    if (!target) return { ok: false, error: '关联的会话已经找不到了（可能已被删除或移动）' };
    const r = await sessions.switchToTarget(target);
    if (!r.ok) return { ok: false, error: r.error || '切换会话失败', code: r.code };
    return { ok: true, id: r.id, title: r.title, sessionId: attempt.sessionId, taskId, attempt: attempt.attempt };
  }

  /* ---------- HTTP ---------- */

  /**
   * 计划详情的**视图对象**。
   *
   * 只做一件事：把每个 attempt 的 `sessionId` 注解上「这条会话现在还在不在、
   * 叫什么名字」。这样界面一次请求就能把「会话：修复 bridgeRun stale response」
   * 画出来，不用每个 task 各问一次后端（规格 §34 明确要求避免 N+1）。
   *
   * ⚠️ **注解是视图字段，绝不写回 plan 文件。** 写回去等于把「某一次读取时的
   * 结论」当成事实持久化 —— 用户后来把会话恢复了，界面上还会写着「已删除」。
   * 所以这里返回的是一个浅拷贝结构，原 plan 对象一个字节都不动。
   *
   * 没注入 sessions 时（单测）原样返回，行为与 P7 之前一致。
   */
  function planView(plan) {
    if (!sessions || typeof sessions.resolveManyByUuid !== 'function') return plan;
    const ids = [];
    for (const t of plan.tasks) {
      for (const a of Array.isArray(t.attempts) ? t.attempts : []) if (a.sessionId) ids.push(a.sessionId);
    }
    let found = new Map();
    try {
      found = sessions.resolveManyByUuid(ids);
    } catch {
      found = new Map(); // 会话目录读不出来不该让计划详情打不开
    }
    return {
      ...plan,
      tasks: plan.tasks.map((t) => ({
        ...t,
        attempts: (Array.isArray(t.attempts) ? t.attempts : []).map((a) => {
          if (!a.sessionId) return { ...a, sessionAvailable: false, sessionTitle: '' };
          const hit = found.get(a.sessionId);
          return { ...a, sessionAvailable: Boolean(hit), sessionTitle: hit ? hit.title : '' };
        }),
      })),
    };
  }

  function payload(plan, extra = {}) {
    return { ok: true, plan: planView(plan), counts: summarizePlan(plan), ...extra };
  }

  function loadPlan(id) {
    const r = store.load(id);
    return r ? r.plan : null;
  }

  /** 计划属于哪个项目 —— 防止 A 项目的计划被 B 项目的界面操作（§35）。 */
  function ownedByCurrentProject(plan) {
    const cwd = runtime.getCurrentCwd();
    if (!cwd) return false;
    const norm = (p) => (process.platform === 'win32' ? String(p || '').toLowerCase() : String(p || ''));
    return norm(plan.projectRoot) === norm(cwd);
  }

  async function handle(req, res, url) {
    const pathname = url.pathname;
    const method = req.method;

    /* GET /api/agents */
    if (pathname === '/api/agents') {
      if (method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed' });
      const agents = registry.list();
      return json(res, 200, {
        ok: true,
        agents,
        available: agents.filter((a) => a.available).map((a) => a.id),
        auto: registry.resolveAuto(null),
        activePlanId: scheduler.activePlanId(),
        hasProject: Boolean(runtime.getCurrentCwd()),
      });
    }

    /* /api/plans 与 /api/plans/... */
    if (pathname === '/api/plans' || pathname.startsWith('/api/plans/')) {
      const rest = pathname.replace(/^\/api\/plans\/?/, '');
      const parts = rest ? rest.split('/').filter(Boolean).map(decodeURIComponent) : [];

      /* POST /api/plans/generate */
      if (parts.length === 1 && parts[0] === 'generate') {
        if (method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
        const raw = await readBody(req, MAX_BODY).catch((err) => ({ __err: String(err.message || err) }));
        if (raw && raw.__err) return json(res, 413, { ok: false, error: raw.__err });
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        }
        const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
        if (!goal) return json(res, 400, { ok: false, error: '请先写清楚目标' });

        const r = await generatePlan({ goal, title: typeof body.title === 'string' ? body.title.trim() : '' });
        if (!r.ok) {
          // 生成失败不是 500 —— 这是可预期的结果，把原因和原始输出一起给出去
          return json(res, 200, { ok: false, error: r.error, errors: r.errors || [], raw: r.raw || null });
        }
        store.save(r.plan);
        // 生成出来的计划是 **draft**：等用户看过、改过、点了「开始执行」才跑（§8）
        r.plan.status = PLAN_STATUS.DRAFT;
        store.save(r.plan);
        return json(res, 200, payload(r.plan, { warnings: r.warnings || [], raw: r.raw, agents: checkAgents(r.plan) }));
      }

      /* GET /api/plans/relations?sessionId=…
       *
       * 「这个会话被哪些 task 的哪次尝试用过」—— 反向查询（规格 §5 / §8）。
       *
       * **刻意不维护第二份索引。** 答案直接来自 plan 文件里的 `attempt.sessionId`
       * —— 那是单一真相（规格 §5 明确要求「不要出现 task 说 A、session-index 说 B」
       * 这种两份可漂移的关系）。所以这里是一次有界扫描：先按 projectRoot 过滤出
       * 当前项目的计划（计划数有上限），再遍历它们的 attempts。
       * 会话正文一个字都不读 —— 只读关系字段。
       *
       * 位置：必须排在下面的 `:id` 处理之前，和 `generate` 同一类特例。 */
      if (parts.length === 1 && parts[0] === 'relations') {
        if (method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed' });
        const cwd = runtime.getCurrentCwd();
        if (!cwd) return json(res, 200, { ok: true, hasProject: false, sessionId: null, matches: [] });
        const sessionId = url.searchParams.get('sessionId') || '';
        // 来自 HTTP 的不可信输入：先按 pi 的字符集挡一道，再拿去找东西
        if (!isSafeSessionId(sessionId)) return json(res, 400, { ok: false, error: '缺少合法的 sessionId' });
        const { plans } = store.list({ projectRoot: cwd });
        const matches = [];
        for (const p of plans) {
          for (const t of p.tasks) {
            for (const a of Array.isArray(t.attempts) ? t.attempts : []) {
              if (a.sessionId !== sessionId) continue;
              matches.push({
                planId: p.id,
                planTitle: p.title,
                planStatus: p.status,
                taskId: t.id,
                taskTitle: t.title,
                taskStatus: t.status,
                agent: t.agent,
                attempt: a.attempt,
                startedAt: a.startedAt,
                endedAt: a.endedAt,
                success: Boolean(a.success),
                filesChanged: Array.isArray(a.filesChanged) ? a.filesChanged : [],
              });
            }
          }
        }
        matches.sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0));
        return json(res, 200, {
          ok: true,
          hasProject: true,
          sessionId,
          matches: matches.slice(0, MAX_RELATION_MATCHES),
          truncated: matches.length > MAX_RELATION_MATCHES,
        });
      }

      /* GET /api/plans  |  POST /api/plans */
      if (parts.length === 0) {
        if (method === 'GET') {
          const cwd = runtime.getCurrentCwd();
          const { plans, broken } = store.list({ projectRoot: cwd });
          return json(res, 200, {
            ok: true,
            hasProject: Boolean(cwd),
            plans: plans.map((p) => store.summary(p)),
            broken,
            activePlanId: scheduler.activePlanId(),
          });
        }
        if (method === 'POST') {
          const cwd = runtime.getCurrentCwd();
          if (!cwd) return json(res, 200, { ok: false, error: '还没有选择项目' });
          const raw = await readBody(req, MAX_BODY).catch((err) => ({ __err: String(err.message || err) }));
          if (raw && raw.__err) return json(res, 413, { ok: false, error: raw.__err });
          let body;
          try {
            body = JSON.parse(raw || '{}');
          } catch {
            return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          }
          /* 两种入口：手工空计划（§45），或客户端提交一份完整 plan */
          const incoming = body.plan && typeof body.plan === 'object' ? body.plan : body;
          const normalized = normalizePlan(
            {
              title: incoming.title || '未命名计划',
              goal: incoming.goal || '',
              tasks: Array.isArray(incoming.tasks) ? incoming.tasks : [],
            },
            { agentIds: registry.ids(), projectRoot: cwd }
          );
          if (!normalized.ok) return json(res, 200, { ok: false, error: '计划不合法', errors: normalized.errors });
          normalized.plan.status = PLAN_STATUS.DRAFT;
          store.save(normalized.plan);
          return json(res, 200, payload(normalized.plan));
        }
        return json(res, 405, { ok: false, error: 'Method not allowed' });
      }

      /* /api/plans/:id 与 /api/plans/:id/<action> */
      const id = parts[0];
      if (id.length > 80) return json(res, 400, { ok: false, error: 'ID 不合法' });
      const plan = loadPlan(id);
      if (!plan) return json(res, 404, { ok: false, error: '找不到这个计划' });
      if (!ownedByCurrentProject(plan)) {
        return json(res, 403, { ok: false, error: '这个计划属于另一个项目，切回那个项目才能操作' });
      }

      if (parts.length === 1) {
        if (method === 'GET') {
          return json(res, 200, payload(plan, { agents: checkAgents(plan), activePlanId: scheduler.activePlanId() }));
        }
        if (method === 'PUT') {
          /* 运行中锁结构（§46）：只允许 stop / retry，不许改依赖图，
           * 否则 scheduler 要在执行中途重算拓扑，复杂度立刻失控。 */
          if (scheduler.activePlanId() === plan.id) {
            return json(res, 409, { ok: false, error: '计划正在执行，结构已锁定。请先停止再修改。' });
          }
          const raw = await readBody(req, MAX_BODY).catch((err) => ({ __err: String(err.message || err) }));
          if (raw && raw.__err) return json(res, 413, { ok: false, error: raw.__err });
          let body;
          try {
            body = JSON.parse(raw || '{}');
          } catch {
            return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          }
          const cwd = runtime.getCurrentCwd();
          const normalized = normalizePlan(
            {
              id: plan.id,
              title: typeof body.title === 'string' ? body.title : plan.title,
              goal: typeof body.goal === 'string' ? body.goal : plan.goal,
              tasks: Array.isArray(body.tasks) ? body.tasks : plan.tasks,
              source: plan.source,
            },
            { agentIds: registry.ids(), projectRoot: cwd }
          );
          if (!normalized.ok) return json(res, 200, { ok: false, error: '计划不合法', errors: normalized.errors });
          // 保留原计划的历史信息（createdAt / 已有 attempt）
          const next = normalized.plan;
          next.createdAt = plan.createdAt;
          next.status = plan.status === PLAN_STATUS.DRAFT ? PLAN_STATUS.DRAFT : next.status;
          for (const t of next.tasks) {
            const old = plan.tasks.find((x) => x.id === t.id);
            if (old && old.attempt > 0) {
              t.attempt = old.attempt;
              t.attempts = old.attempts;
              t.status = old.status;
              t.result = old.result;
              t.error = old.error;
              t.startedAt = old.startedAt;
              t.endedAt = old.endedAt;
            }
          }
          if (typeof body.concurrency === 'number') {
            next.concurrency = Math.min(Math.max(1, Math.floor(body.concurrency)), MAX_CONCURRENCY);
          }
          store.save(next);
          return json(res, 200, payload(next, { agents: checkAgents(next) }));
        }
        if (method === 'DELETE') {
          if (scheduler.activePlanId() === plan.id) {
            return json(res, 409, { ok: false, error: '计划正在执行，先停止再删除' });
          }
          store.remove(plan.id);
          return json(res, 200, { ok: true });
        }
        return json(res, 405, { ok: false, error: 'Method not allowed' });
      }

      /* /api/plans/:id/<action> */
      const action = parts[1];
      if (method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });

      if (action === 'start') {
        /* 运行前必须确认 agent 可用（§34），不要启动到一半才报 command not found */
        const problems = checkAgents(plan);
        if (problems.length) {
          return json(res, 200, { ok: false, error: '有任务指定的 Agent 在本机不可用，请先换成可用的', problems });
        }
        if (plan.concurrency == null) plan.concurrency = DEFAULT_CONCURRENCY;
        const r = await scheduler.start(plan);
        if (!r.ok) return json(res, 200, { ok: false, error: r.error, code: r.code });
        return json(res, 200, { ok: true, planId: plan.id, activePlanId: scheduler.activePlanId() });
      }
      if (action === 'stop') {
        const r = scheduler.stop();
        if (!r.ok) return json(res, 200, { ok: false, error: r.error, code: r.code });
        return json(res, 200, { ok: true, planId: plan.id });
      }
      if (action === 'tasks' && parts.length === 4) {
        const taskId = parts[2];
        const taskAction = parts[3];
        if (taskAction === 'retry') {
          const r = scheduler.retryTask(plan, taskId);
          return json(res, r.ok ? 200 : 200, r.ok ? { ok: true, taskId, nextAttempt: r.nextAttempt, plan } : { ok: false, error: r.error, code: r.code });
        }
        if (taskAction === 'cancel') {
          const r = scheduler.cancelTask(plan, taskId);
          return json(res, 200, r.ok ? { ok: true, taskId, cancelledRunning: r.cancelledRunning, plan } : { ok: false, error: r.error, code: r.code });
        }
        if (taskAction === 'skip') {
          const r = scheduler.skipTask(plan, taskId);
          return json(res, 200, r.ok ? { ok: true, taskId, blockedDependents: r.blockedDependents, plan } : { ok: false, error: r.error, code: r.code });
        }
        /* P7：从任务跳到它的会话（规格 §7）。失败一律 200 + ok:false ——
         * 「这次执行没有关联会话」是**正常结果**，不是错误状态码。 */
        if (taskAction === 'open-session') {
          const r = await openTaskSession(plan, taskId, url.searchParams.get('attempt'));
          return json(res, 200, r.ok ? r : { ok: false, error: r.error, code: r.code || '' });
        }
        return json(res, 404, { ok: false, error: `不认识的任务操作：${taskAction}` });
      }
      return json(res, 404, { ok: false, error: '不认识的计划操作' });
    }

    return json(res, 404, { ok: false, error: 'Not found' });
  }

  return {
    handle,
    generatePlan,
    checkAgents,
    /** P7：从任务打开它的会话（也直接暴露给测试）。 */
    openTaskSession,
    /** 供 server.js / projects 判断「现在能不能切项目」（§40）。 */
    activePlanId: () => scheduler.activePlanId(),
    _internals: { extractJsonObject, buildPlannerPrompt },
    TASK_STATUS,
  };
}
