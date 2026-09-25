/* DAG Scheduler —— 只负责执行一个**已经确认过的** Plan（规格 §6 / §16–§27）。
 *
 * 与 Planner 严格分开：这里不认识「怎么生成计划」，只认识「计划长这样，按依赖跑」。
 * 所以 Planner 将来换模型、换成人手写、甚至坏掉，这个文件一行都不用改。
 *
 * ---------- 几条刻意的行为，都是规格里点名的 ----------
 *
 * 1. **默认串行（concurrency = 1）。** 多个 coding agent 同时改同一个工作区会
 *    互相覆盖文件、把 git diff 混成一团、跑测试互相干扰、抢 `index.lock`，
 *    而且出了问题根本说不清是谁改的。DAG 结构上是支持并行的，但第一版
 *    故意只用 1（可配到 2），把复杂度留到以后。
 *
 * 2. **失败就暂停整个 Plan。** 不自动跳过、不自动重试、不把失败当成功往下跑。
 *    一个失败的 task 后面往往还有依赖它的东西，闷头跑完只会得到一串更奇怪的失败。
 *
 * 3. **`cancelled` 与 `failed` 分开。** 用户按了停止，标红成「失败」会把
 *    「我主动放弃的」显示成「出错了」，然后诱导他去重试刚放弃的任务。
 *
 * 4. **Changes 的措辞是「执行期间观察到的工作区变化」。** 不能写成
 *    「Agent 修改了这些文件」—— 用户自己、编辑器、其它工具都可能在同一时间段
 *    改文件，把 git diff 全记在 Agent 头上是在编造因果。
 *
 * 5. **一个 workspace 同时只跑一个 Plan。** 两个 Plan 并行 = 两个 agent 抢同一个
 *    工作区，正是第 1 条要避免的事，而且状态归属会更乱。
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  PLAN_STATUS,
  TASK_STATUS,
  TERMINAL_TASK_STATUS,
  buildTaskPrompt,
  computeReadyStates,
  isPlanSettled,
  summarizePlan,
} from './model.js';

/** 任务超时默认 30 分钟（与 cli.js 一致，这里可被 plan 覆盖）。 */
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

export function createScheduler({ store, registry, runtime, publish = () => {}, gitStatus = null, now = () => Date.now(), taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS }) {
  /** 当前正在跑的 plan（全局唯一，规格 §32）。 */
  let active = null; // { planId, plan, controllers: Map<taskId, AbortController>, stopping: boolean, pumpRunning: boolean }
  const emitter = new EventEmitter();

  /* ---------- 事件（规格 §21 / §39） ---------- */

  /**
   * 统一执行事件。
   *
   * 帧上用 `type: 'execution_event'` 当**外层判别符**，内层事件类型放 `kind` ——
   * 而不是照 §21 字面写成内层 `type`：两者同名会撞车，前端 switch 一帧就分不清
   * 这是「一条执行事件」还是「一个叫 task_start 的顶层事件」。planId / taskId
   * 同时提到帧顶层，所以 §39 要求的「必须带 planId / taskId」在帧上直接可读。
   */
  function emit(planId, taskId, agent, kind, data = {}) {
    const evt = {
      type: 'execution_event',
      planId,
      taskId: taskId || null,
      agent: agent || null,
      kind,
      timestamp: now(),
      data,
    };
    try {
      publish(evt);
    } catch {
      /* 推送失败不能影响执行 */
    }
    emitter.emit('event', evt);
    return evt;
  }

  /* ---------- 工作区快照（§18） ---------- */

  async function snapshot(projectRoot) {
    if (!gitStatus) return null;
    try {
      const st = await gitStatus(projectRoot);
      if (!st || !st.ok || !st.isRepo) return null;
      const map = new Map();
      for (const f of st.files || []) {
        map.set(f.path, { status: f.status, additions: f.additions ?? null, deletions: f.deletions ?? null, untracked: Boolean(f.untracked) });
      }
      return map;
    } catch {
      return null;
    }
  }

  /**
   * 前后快照的差集。**表述为「执行期间观察到的工作区变化」**（规格 §18）——
   * 不声称是 Agent 改的，因为用户或其它工具可能同时在动文件。
   */
  function diffSnapshots(before, after) {
    if (!before || !after) return { available: false, files: [], note: '这个项目不是 git 仓库，无法给出工作区变化' };
    const files = [];
    for (const [p, a] of after) {
      const b = before.get(p);
      if (!b) {
        files.push({ path: p, change: a.untracked ? 'added' : 'appeared', status: a.status, additions: a.additions, deletions: a.deletions });
        continue;
      }
      if (b.status !== a.status || b.additions !== a.additions || b.deletions !== a.deletions) {
        files.push({ path: p, change: 'modified', status: a.status, additions: a.additions, deletions: a.deletions });
      }
    }
    for (const [p] of before) {
      if (!after.has(p)) files.push({ path: p, change: 'reverted', status: 'clean', additions: null, deletions: null });
    }
    return { available: true, files: files.slice(0, 200), note: '执行期间观察到的工作区变化（可能也包含其它来源的改动）' };
  }

  /* ---------- 状态推进 ---------- */

  function refreshStatuses(plan) {
    const suggested = computeReadyStates(plan.tasks);
    for (const t of plan.tasks) {
      const s = suggested.get(t.id);
      if (s && s !== t.status) {
        // blocked / pending / ready 之间可以自由翻转（依赖状态变了就该翻）
        t.status = s;
      }
    }
    return plan;
  }

  function persist(plan) {
    try {
      store.save(plan);
    } catch (err) {
      emit(plan.id, null, null, 'plan_error', { message: `状态保存失败：${err.message}` });
    }
  }

  function settlePlan(plan) {
    if (isPlanSettled(plan)) {
      plan.status = store.statusFromTasks(plan);
      plan.endedAt = plan.endedAt || now();
    }
    persist(plan);
    return plan.status;
  }

  /* ---------- 解析 agent ---------- */

  function agentFor(task) {
    if (task.agent && task.agent !== 'auto') return task.agent;
    return registry.resolveAuto(null);
  }

  /* ---------- 跑一个 task ---------- */

  async function runTask(plan, task, controller) {
    const agentId = agentFor(task);
    const adapter = agentId ? registry.get(agentId) : null;

    task.attempt = (task.attempt || 0) + 1;
    const attemptNo = task.attempt;
    task.status = TASK_STATUS.RUNNING;
    task.startedAt = now();
    task.endedAt = null;
    task.error = '';
    persist(plan);

    emit(plan.id, task.id, agentId, 'task_start', { attempt: attemptNo, title: task.title, workingDirectory: task.workingDirectory });

    if (!adapter) {
      const error = agentId ? `找不到 agent：${agentId}` : '本机没有可用的 Agent（pi / codex / claude / gemini 都没检测到）';
      return finishTask(plan, task, { success: false, error, exitCode: null, summary: '', rawResult: null, toolCalls: 0 });
    }
    const info = adapter.detect();
    if (!info.available) {
      // 规格 §34：运行前就该拦住。这里是最后一道，不启动到一半才报 command not found
      const error = `${info.name} 不可用：${info.detail || info.reason}`;
      emit(plan.id, task.id, agentId, 'agent_output', { text: error, level: 'error' });
      return finishTask(plan, task, { success: false, error, exitCode: null, summary: '', rawResult: null, toolCalls: 0 });
    }

    const projectRoot = plan.projectRoot || runtime.getCurrentCwd();
    const cwd = task.workingDirectory === '.' ? projectRoot : path.resolve(projectRoot, task.workingDirectory);
    const prompt = buildTaskPrompt(plan, task);

    const before = await snapshot(projectRoot);

    let outcome;
    try {
      outcome = await adapter.start({
        task,
        prompt,
        cwd,
        signal: controller.signal,
        timeoutMs: taskTimeoutMs,
        onEvent: (e) => emit(plan.id, task.id, agentId, e.type, e.data || {}),
      });
    } catch (err) {
      outcome = { success: false, error: `适配器抛错：${err.message}`, exitCode: null, summary: '', rawResult: null, toolCalls: 0 };
    }

    const after = await snapshot(projectRoot);
    const changes = diffSnapshots(before, after);
    if (changes.available && changes.files.length) {
      emit(plan.id, task.id, agentId, 'task_change', { files: changes.files, note: changes.note });
    }

    return finishTask(plan, task, outcome, changes);
  }

  function finishTask(plan, task, outcome, changes = null) {
    task.endedAt = now();
    const agentId = agentFor(task);
    task.result = {
      success: Boolean(outcome.success),
      exitCode: outcome.exitCode ?? null,
      summary: String(outcome.summary || '').slice(0, 4000),
      toolCalls: Number(outcome.toolCalls || 0),
      changes: changes || { available: false, files: [], note: '' },
      raw: outcome.rawResult || null,
      durationMs: task.startedAt ? task.endedAt - task.startedAt : null,
    };
    task.attempts = Array.isArray(task.attempts) ? task.attempts : [];
    // 保留历史 attempt，绝不覆盖失败证据（规格 §27）
    task.attempts.push({
      attempt: task.attempt,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      success: Boolean(outcome.success),
      error: String(outcome.error || '').slice(0, 2000),
      summary: String(outcome.summary || '').slice(0, 1000),
      exitCode: outcome.exitCode ?? null,
    });

    if (outcome.cancelled) {
      task.status = TASK_STATUS.CANCELLED; // 用户取消 ≠ 失败
      task.error = '已取消';
      emit(plan.id, task.id, agentId, 'task_cancelled', { attempt: task.attempt });
    } else if (outcome.success) {
      task.status = TASK_STATUS.SUCCESS;
      task.error = '';
      emit(plan.id, task.id, agentId, 'task_success', { attempt: task.attempt, durationMs: task.result.durationMs, summary: task.result.summary });
    } else {
      task.status = TASK_STATUS.FAILED;
      task.error = String(outcome.error || '执行失败').slice(0, 2000);
      emit(plan.id, task.id, agentId, 'task_error', { attempt: task.attempt, error: task.error });
    }
    persist(plan);
    return task.status;
  }

  /* ---------- 主循环 ---------- */

  async function pump(session) {
    if (session.pumpRunning) return;
    session.pumpRunning = true;
    try {
      for (;;) {
        if (session.stopping) break;
        const plan = session.plan;
        refreshStatuses(plan);

        if (isPlanSettled(plan)) break;

        const limit = Math.min(Math.max(1, plan.concurrency || DEFAULT_CONCURRENCY), MAX_CONCURRENCY);
        const running = plan.tasks.filter((t) => t.status === TASK_STATUS.RUNNING);
        const ready = plan.tasks.filter((t) => t.status === TASK_STATUS.READY);

        if (running.length === 0 && ready.length === 0) {
          /* 还有任务不是终态，但既没有 running 也没有 ready —— 说明全被 blocked 了。
           * 这是「依赖失败」或「依赖被跳过」的正常结果，不该继续转圈。 */
          break;
        }
        if (running.length >= limit) {
          // 已经跑满并发，等其中一个结束（由 batch 的 await 驱动，这里不轮询）
          break;
        }

        const batch = ready.slice(0, limit - running.length);
        if (batch.length === 0) break;

        const controllers = batch.map(() => new AbortController());
        batch.forEach((t, i) => session.controllers.set(t.id, controllers[i]));

        const results = await Promise.all(batch.map((t, i) => runTask(plan, t, controllers[i])));
        batch.forEach((t) => session.controllers.delete(t.id));

        if (session.stopping) break;

        /* 失败即暂停（规格 §26）。不自动跳过、不自动重试 —— 由用户决定。
         * 注意这里只看「失败」，取消不走这条路（取消时 stopping 已经为真）。
         *
         * 暂停前必须再 refresh 一次：刚失败的那个任务会把它的下游从
         * pending 变成 blocked，而 UI 上「等待」和「被阻塞」是两件不同的事 ——
         * 前者会让人觉得再等一会儿就会跑，后者才说明「得先处理失败的那个」。 */
        if (results.some((s) => s === TASK_STATUS.FAILED)) {
          refreshStatuses(plan);
          plan.status = PLAN_STATUS.PAUSED;
          persist(plan);
          emit(plan.id, null, null, 'plan_paused', { reason: '有任务失败，已暂停等待处理' });
          break;
        }
      }
    } finally {
      session.pumpRunning = false;
      if (session.stopping) {
        for (const t of session.plan.tasks) {
          if (!TERMINAL_TASK_STATUS.includes(t.status) && t.status !== TASK_STATUS.RUNNING) {
            t.status = TASK_STATUS.CANCELLED;
            t.error = '计划已停止';
          }
        }
        session.plan.status = store.statusFromTasks(session.plan);
        session.plan.endedAt = session.plan.endedAt || now();
        persist(session.plan);
        emit(session.plan.id, null, null, 'plan_cancelled', {});
      } else {
        const status = settlePlan(session.plan);
        emit(session.plan.id, null, null, status === PLAN_STATUS.COMPLETED ? 'plan_success' : status === PLAN_STATUS.FAILED ? 'plan_failed' : 'plan_paused', {
          counts: summarizePlan(session.plan),
        });
      }
      if (active === session) active = null;
    }
  }

  /* ---------- 对外接口 ---------- */

  /** 当前有没有正在跑的 plan（规格 §32 / §40）。 */
  function activePlanId() {
    return active ? active.planId : null;
  }

  async function start(plan) {
    if (active) {
      return { ok: false, code: 'busy', error: `已经有一个计划正在执行（${active.planId}），请先停止它` };
    }
    if (isPlanSettled(plan) && plan.status === PLAN_STATUS.COMPLETED) {
      return { ok: false, code: 'settled', error: '这个计划已经全部完成了' };
    }
    // 有依赖失败/被跳过的任务时，那些依赖者会永远 blocked —— 先提醒，但不阻止
    refreshStatuses(plan);
    if (!plan.tasks.some((t) => t.status === TASK_STATUS.READY || t.status === TASK_STATUS.RUNNING)) {
      return { ok: false, code: 'nothing-ready', error: '没有可以开始的任务（依赖不满足，或全部已结束）' };
    }

    plan.status = PLAN_STATUS.RUNNING;
    plan.startedAt = plan.startedAt || now();
    plan.endedAt = null;
    persist(plan);

    const session = { planId: plan.id, plan, controllers: new Map(), stopping: false, pumpRunning: false };
    active = session;
    emit(plan.id, null, null, 'plan_start', { title: plan.title, tasks: plan.tasks.length });
    // 主循环不 await（HTTP 请求要立刻返回）；但必须接住异常，否则会变成
    // unhandledRejection 把整个后端带下去
    pump(session).catch((err) => {
      emit(plan.id, null, null, 'plan_error', { message: `调度器异常：${err.message}` });
      session.plan.status = PLAN_STATUS.PAUSED;
      persist(session.plan);
      if (active === session) active = null;
    });
    return { ok: true, planId: plan.id };
  }

  /** 停止整个 plan：取消当前在跑的，剩下的标 cancelled，不再启动后续（规格 §24）。 */
  function stop(reason = '用户停止了计划') {
    if (!active) return { ok: false, code: 'no-active', error: '当前没有正在执行的计划' };
    const session = active;
    session.stopping = true;
    for (const [, c] of session.controllers) {
      try {
        c.abort();
      } catch {
        /* noop */
      }
    }
    emit(session.planId, null, null, 'plan_stopping', { reason });
    return { ok: true, planId: session.planId };
  }

  /** 取消单个 task：在跑就 abort，没跑就标 cancelled。 */
  function cancelTask(plan, taskId) {
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, code: 'not-found', error: '找不到这个任务' };
    if (TERMINAL_TASK_STATUS.includes(task.status)) {
      return { ok: false, code: 'settled', error: `任务已经结束（${task.status}），不能取消` };
    }
    const c = active && active.planId === plan.id ? active.controllers.get(taskId) : null;
    if (c) {
      try {
        c.abort();
      } catch {
        /* noop */
      }
      return { ok: true, taskId, cancelledRunning: true };
    }
    task.status = TASK_STATUS.CANCELLED;
    task.error = '已取消';
    persist(plan);
    emit(plan.id, taskId, null, 'task_cancelled', { attempt: task.attempt });
    return { ok: true, taskId, cancelledRunning: false };
  }

  /** 重试：attempt++ 并清掉本次错误，历史 attempt 保留（规格 §27）。 */
  function retryTask(plan, taskId) {
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, code: 'not-found', error: '找不到这个任务' };
    if (task.status === TASK_STATUS.RUNNING) return { ok: false, code: 'running', error: '任务正在执行，先停止它' };
    if (task.status === TASK_STATUS.SUCCESS) return { ok: false, code: 'settled', error: '任务已经成功，不需要重试' };

    task.status = TASK_STATUS.PENDING;
    task.error = '';
    task.result = null;
    task.startedAt = null;
    task.endedAt = null;
    persist(plan);
    emit(plan.id, taskId, null, 'task_retry_queued', { nextAttempt: (task.attempt || 0) + 1 });
    return { ok: true, taskId, nextAttempt: (task.attempt || 0) + 1 };
  }

  /** 跳过：**依赖它的任务仍然 blocked**，不自动放行（规格 §26）。 */
  function skipTask(plan, taskId) {
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, code: 'not-found', error: '找不到这个任务' };
    if (task.status === TASK_STATUS.RUNNING) return { ok: false, code: 'running', error: '任务正在执行，先停止它' };
    task.status = TASK_STATUS.SKIPPED;
    task.error = task.error || '已跳过';
    persist(plan);
    emit(plan.id, taskId, null, 'task_skipped', {});
    const dependents = plan.tasks.filter((t) => t.dependsOn.includes(taskId) && !TERMINAL_TASK_STATUS.includes(t.status));
    return { ok: true, taskId, blockedDependents: dependents.map((t) => t.id) };
  }

  /** 应用退出时收尾：把在跑的标成 interrupted（规格 §31）。 */
  function shutdown() {
    if (!active) return;
    const session = active;
    session.stopping = true;
    for (const [, c] of session.controllers) {
      try {
        c.abort();
      } catch {
        /* noop */
      }
    }
    for (const t of session.plan.tasks) {
      if (t.status === TASK_STATUS.RUNNING) {
        t.status = TASK_STATUS.INTERRUPTED;
        t.error = '应用关闭时被中断';
        t.endedAt = t.endedAt || now();
      }
    }
    session.plan.status = PLAN_STATUS.PAUSED;
    persist(session.plan);
  }

  /** 供测试等待当前 plan 跑完。 */
  function waitIdle(timeoutMs = 30000) {
    if (!active) return Promise.resolve();
    const session = active;
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(), timeoutMs);
      const tick = () => {
        if (active !== session) {
          clearTimeout(t);
          return resolve();
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  return { start, stop, cancelTask, retryTask, skipTask, shutdown, activePlanId, waitIdle, on: (ev, fn) => emitter.on(ev, fn), _diffSnapshots: diffSnapshots };
}
