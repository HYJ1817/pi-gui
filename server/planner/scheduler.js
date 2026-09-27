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
 *
 * 6. **运行期的生命周期操作作用于 `active.plan`，不是外部 load 出来的副本。**
 *
 *    计划在跑的时候，同一个 Plan 在内存里天然有**两份对象图**：
 *
 *        active.plan         Scheduler 持有的执行态 —— pump / runTask / finishTask
 *                            改的一直是它，收尾时也是它整份写盘
 *        HTTP 请求里 load 的   每次请求 `store.load()` 出来的**新副本**
 *
 *    cancel / skip 如果改副本，结果只是把副本写进磁盘；而 Scheduler 随后收尾
 *    `persist(active.plan)` 会把整个文件**再盖一遍** —— 副本上的改动无声消失
 *    （界面一刷新，任务又变回 pending），甚至 pump 会因为内存里它还是 pending
 *    而**真的把它启动起来**。所以运行期的 cancel / skip 必须落到 active.plan 上
 *    （唯一判定处：下面的 planForMutation）。
 *
 *    Retry 是**例外，不能照抄 cancel/skip**：它会把任务改回 pending，而 pump 的
 *    下一轮 refreshStatuses 立刻把它标成 ready 并**自动执行** —— 「Retry 不自动执行」
 *    就不成立了；改副本则会被 Scheduler 收尾覆盖回 success。两条路都不通，
 *    所以 **Plan 仍 active 时 Retry 一律拒绝**（code `plan-active`）。
 *
 *    这是「计划里谁拥有哪一部分」在**运行期**的延伸，与 mergeExternalAttemptState
 *    那条（attempt.review 归 Review API）是同一条规矩的两面：
 *
 *        运行期执行态  →  active.plan
 *        attempt.review →  Review API
 *        Retry         →  只允许 Plan 不再 active 时
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  ATTEMPT_OUTCOME,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  PLAN_STATUS,
  TASK_STATUS,
  TERMINAL_PLAN_STATUS,
  TERMINAL_TASK_STATUS,
  buildTaskPrompt,
  computeReadyStates,
  isPlanSettled,
  isSafeSessionId,
  normalizeFilesChanged,
  normalizeReview,
  normalizeVerificationSnapshot,
  summarizePlan,
  taskSessionId,
} from './model.js';

/** 任务超时默认 30 分钟（与 cli.js 一致，这里可被 plan 覆盖）。 */
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 从适配器的返回里取「这次运行关联到了哪个会话」。
 *
 * 两处都可能给：适配器可以在顶层直接回 `sessionId`（P7 新增的契约），
 * 老适配器则是把观察到的值放在 `rawResult.sessionId` 里（pi / claude 一直如此）。
 * **只接受合法 id，路径一律当没有** —— 元数据里不许出现会话文件路径（规格 §4/§32）。
 */
function outcomeSessionId(outcome) {
  if (!outcome) return null;
  if (isSafeSessionId(outcome.sessionId)) return outcome.sessionId;
  const raw = outcome.rawResult && outcome.rawResult.sessionId;
  return isSafeSessionId(raw) ? raw : null;
}

export function createScheduler({ store, registry, runtime, publish = () => {}, gitStatus = null, now = () => Date.now(), taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS }) {
  /** 当前正在跑的 plan（全局唯一，规格 §32）。 */
  let active = null; // { planId, plan, controllers: Map<taskId, AbortController>, sessionIds: Map<taskId, string>, stopping: boolean, pumpRunning: boolean }
  const emitter = new EventEmitter();

  /**
   * 「这条 attempt 已经记过账了」。
   *
   * 存在的理由是 shutdown 与正常收尾**会撞车**：`shutdown()` 在 SIGINT 里同步地把
   * running 的 task 标成 interrupted 并补一条 attempt，而那一刻正在跑的 `runTask`
   * 还会在事件循环上再走一步（`server.close()` 的回调给了一次机会），于是
   * `finishTask` 可能对**同一条** attempt 再 push 一次 —— 历史里出现两条第 N 次尝试，
   * 一条 interrupted 一条 cancelled，谁也说不清哪条是真的。
   * 键里带 planId / taskId / attempt，所以它天然不会误伤重试产生的新 attempt。 */
  const recordedAttempts = new Set();
  const attemptKey = (planId, taskId, attempt) => `${planId}:${taskId}:${attempt}`;

  /**
   * 应用是否正在退出（由 shutdown() 置位，此后不再复位）。
   *
   * 存在的理由：`shutdown()` 是**同步**收尾（SIGINT 里必须立刻做完），而那一刻
   * 正在跑的 `runTask` 还会在事件循环上再走一步 —— abort 让适配器返回，
   * 于是 `finishTask` 拿到一个 `cancelled` 的结果，把 shutdown 刚定好的
   * `interrupted` **又翻成 cancelled**。两个状态在语义上完全不同：
   *   interrupted = 应用关了，不是你的错，重启后重试；
   *   cancelled   = 你按了停止。
   * 让退出中的收尾把状态改写成「用户主动取消」，是在给用户一个错误的结论。
   * 所以退出之后 `finishTask` 只落盘、不再改状态。
   */
  let shuttingDown = false;

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

  /**
   * 从快照差集里取出**只含项目相对路径**的文件名列表（规格 §33）。
   *
   * 完整 diff 仍然走现有的 Git Changes 模块，这里只落一个文件名集合 ——
   * 元数据里放 diff 正文既没用（它马上就会过期）又占体积。
   * 注意 `gitStatus` 给的 `path` 本来就是项目相对 + 正斜杠；normalizeFilesChanged
   * 是第二道保险，防止上游哪天改了形状而这里静默存进绝对路径。
   */
  function changedPathsOf(changes) {
    if (!changes || !changes.available || !Array.isArray(changes.files)) return [];
    return normalizeFilesChanged(changes.files.map((f) => f && f.path));
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

  /**
   * 把**不归 Scheduler 所有**的字段从磁盘最新值合并回来。
   *
   * ---------- 为什么必须有这一步 ----------
   *
   * Scheduler 在**内存里**持有一份计划，`persist()` 时整份写盘。而人工审阅是
   * Review API 直接写到磁盘上的 —— Scheduler 内存里那条 attempt 还停在
   * `review = pending`。于是会出现：
   *
   *     计划还在跑
   *     → 任务 A 先结束，用户审阅了 A（写进磁盘）
   *     → 任务 B 跑完，Scheduler persist() 整份写盘
   *     → **A 的审阅被内存里那份陈旧副本冲掉了**
   *
   * 计划是「一个文件装着一堆互不相同的所有权」，所以**谁写谁的字段**必须说清楚：
   *
   *     Scheduler 拥有：执行状态 / attempt 创建 / result / sessionId /
   *                     filesChanged / verificationSnapshot / outcomeStatus
   *     Review API 拥有：attempt.review
   *
   * Scheduler 保存自己的执行变化时，**不该覆盖一个它不拥有的字段**。
   *
   * ⚠️ 刻意**只合并 attempt.review 这一个字段**，不做通用 merge engine ——
   * 通用的那种要么写不对，要么把「谁拥有什么」这件事变得不可读。
   * 而且只采纳**磁盘上 revision 更大**的值：方向永远是「不降级」，
   * 所以即使将来有别的写者，也不会被这份内存副本倒推回去。
   *
   * 读失败（文件被删、JSON 坏了）一律**跳过合并照常写** ——
   * 不能让「合并」这个附加动作挡住执行状态的持久化。
   */
  function mergeExternalAttemptState(plan) {
    if (!plan || typeof store.load !== 'function') return;
    let latest = null;
    try {
      const r = store.load(plan.id);
      latest = r ? r.plan : null;
    } catch {
      return;
    }
    if (!latest || !Array.isArray(latest.tasks)) return;
    for (const t of plan.tasks) {
      const lt = latest.tasks.find((x) => x.id === t.id);
      if (!lt || !Array.isArray(lt.attempts)) continue;
      for (const a of Array.isArray(t.attempts) ? t.attempts : []) {
        const la = lt.attempts.find((x) => x.attempt === a.attempt);
        if (!la) continue;
        if (normalizeReview(la.review).revision > normalizeReview(a.review).revision) {
          a.review = la.review;
        }
      }
    }
  }

  function persist(plan) {
    try {
      mergeExternalAttemptState(plan);
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

  async function runTask(plan, task, controller, session) {
    const agentId = agentFor(task);
    const adapter = agentId ? registry.get(agentId) : null;
    const info = adapter ? adapter.detect() : null;

    task.attempt = (task.attempt || 0) + 1;
    const attemptNo = task.attempt;
    task.status = TASK_STATUS.RUNNING;
    task.startedAt = now();
    task.endedAt = null;
    task.error = '';
    persist(plan);

    /* ---------- P7：这次尝试关联哪个会话 ----------
     *
     * **能力驱动，不写 `if (agent === 'codex')`**（规格 §17）：适配器自报
     * `capabilities.sessionLinking`，能关联的才给它拼 id。
     *
     * id 由 `taskSessionId(planId, taskId, attempt)` **确定性地**拼出来，不依赖
     * 解析 Agent 输出。attempt 进 id 是刻意的 —— 每次重试拿到不同的会话，
     * 于是 Attempt 1 / Attempt 2 各自的关系不会被后来的覆盖掉（规格 §29）。
     *
     * 记在 `session.sessionIds` 里而不是 task 上：task 会被整份写进 plan 文件，
     * 挂一个「正在进行中的临时字段」上去会污染持久化格式。 */
    const canLink = Boolean(info && info.available && info.capabilities && info.capabilities.sessionLinking);
    const plannedSessionId = canLink ? taskSessionId(plan.id, task.id, attemptNo) : null;
    if (plannedSessionId) session.sessionIds.set(task.id, plannedSessionId);

    emit(plan.id, task.id, agentId, 'task_start', {
      attempt: attemptNo,
      title: task.title,
      workingDirectory: task.workingDirectory,
      sessionId: plannedSessionId,
    });

    if (!adapter) {
      const error = agentId ? `找不到 agent：${agentId}` : '本机没有可用的 Agent（pi / codex / claude / gemini 都没检测到）';
      return finishTask(plan, task, { success: false, error, exitCode: null, summary: '', rawResult: null, toolCalls: 0 }, null, { sessionId: plannedSessionId });
    }
    if (!info.available) {
      // 规格 §34：运行前就该拦住。这里是最后一道，不启动到一半才报 command not found
      const error = `${info.name} 不可用：${info.detail || info.reason}`;
      emit(plan.id, task.id, agentId, 'agent_output', { text: error, level: 'error' });
      return finishTask(plan, task, { success: false, error, exitCode: null, summary: '', rawResult: null, toolCalls: 0 }, null, { sessionId: plannedSessionId });
    }

    const projectRoot = plan.projectRoot || runtime.getCurrentCwd();
    const cwd = task.workingDirectory === '.' ? projectRoot : path.resolve(projectRoot, task.workingDirectory);
    const prompt = buildTaskPrompt(plan, task);

    /* ---------- P8-A：在 attempt **开始时**冻结验证要求 ----------
     *
     * 为什么必须在开始处、而不是结束处读：`task.verification` 是**可编辑**的。
     * 如果等跑完再读，用户在执行期间把 verification 从 `npm test` 改成
     * `npm run test:unit`，这次尝试的历史里就会记着「要求是 test:unit」——
     * 而它实际执行的是 npm test。那是在给历史伪造证据。
     * 冻结下来之后，Task 之后怎么改都不影响这条 attempt 的记录。
     *
     * 和 sessionId 一样只放在 session 上（不写进 task）：task 会被整份写进
     * plan 文件，挂一个「进行中的临时字段」上去会污染持久化格式。 */
    const verificationSnapshot = normalizeVerificationSnapshot(task.verification);
    session.verifications.set(task.id, verificationSnapshot);

    const before = await snapshot(projectRoot);

    let outcome;
    try {
      outcome = await adapter.start({
        task,
        prompt,
        cwd,
        signal: controller.signal,
        timeoutMs: taskTimeoutMs,
        /* 只有声明了能关联的适配器才收到这个值；不支持的适配器拿到 null，
         * 它的 start() 会忽略这个参数（多余的属性不会有害）。 */
        sessionId: plannedSessionId,
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

    /* 关联会话取「适配器真的报回来的那个」优先 —— 我们拼的 id 是**期望值**，
     * Agent 实际用的才是事实（例如 pi 没收到 --session-id 时会自己生成一个）。
     * 两个都没有就如实记 null，不伪造（规格 §16 的 C 情形）。 */
    const sessionId = outcomeSessionId(outcome) || plannedSessionId || null;

    return finishTask(plan, task, outcome, changes, {
      sessionId,
      /* before 快照拿不到（不是 git 仓库 / git 不可用）时，after 的差异说明不了
       * 「执行期间变了什么」。这时候不许猜，只记「没采集全」（规格 §31）。 */
      changeCaptureIncomplete: !changes.available,
      verificationSnapshot,
    });
  }

  function finishTask(plan, task, outcome, changes = null, relation = {}) {
    task.endedAt = now();
    const agentId = agentFor(task);
    const sessionId = isSafeSessionId(relation.sessionId) ? relation.sessionId : null;
    const filesChanged = changedPathsOf(changes);
    const changeCaptureIncomplete = Boolean(relation.changeCaptureIncomplete);
    const verificationSnapshot = normalizeVerificationSnapshot(relation.verificationSnapshot);
    /* P8-A：稳定的执行结论。
     * 判定信号与下面改 task.status 用的是**同一个**（`outcome.cancelled` /
     * `outcome.success`），所以两者永远一致 —— 不会出现「状态说已取消、
     * outcomeStatus 说失败」这种自相矛盾。 */
    const outcomeStatus = outcome.cancelled
      ? ATTEMPT_OUTCOME.CANCELLED
      : outcome.success
        ? ATTEMPT_OUTCOME.SUCCESS
        : ATTEMPT_OUTCOME.FAILED;
    task.result = {
      success: Boolean(outcome.success),
      exitCode: outcome.exitCode ?? null,
      summary: String(outcome.summary || '').slice(0, 4000),
      toolCalls: Number(outcome.toolCalls || 0),
      changes: changes || { available: false, files: [], note: '' },
      raw: outcome.rawResult || null,
      durationMs: task.startedAt ? task.endedAt - task.startedAt : null,
      sessionId,
      outcomeStatus,
    };
    task.attempts = Array.isArray(task.attempts) ? task.attempts : [];
    /* 保留历史 attempt，绝不覆盖失败证据（规格 §27）。
     *
     * P7 在这里多存两样东西，**都必须挂在 attempt 上而不是 task 顶层**：
     *   - sessionId    这次尝试用的是哪个会话
     *   - filesChanged 这次尝试执行期间观察到变化的文件
     * 早先 filesChanged 只存在 `task.result.changes` 上，而 retryTask 会
     * `task.result = null` —— 于是**重试一次就把上一次的文件变化证据抹掉了**。
     * 那是 P7 之前就存在的缺陷，这里一并修掉。
     *
     * 写之前先查 `recordedAttempts`：shutdown 可能已经替这条 attempt 记过账了
     * （见该集合的说明），重复 push 会让历史里出现两条同号的尝试。 */
    const key = attemptKey(plan.id, task.id, task.attempt);
    if (!recordedAttempts.has(key)) {
      recordedAttempts.add(key);
      task.attempts.push({
        attempt: task.attempt,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        success: Boolean(outcome.success),
        error: String(outcome.error || '').slice(0, 2000),
        summary: String(outcome.summary || '').slice(0, 1000),
        exitCode: outcome.exitCode ?? null,
        sessionId,
        filesChanged,
        changeCaptureIncomplete,
        /* P8-A：新 attempt 一律从「待审阅」开始 —— 重试不会继承上一次的
         * 人工判断（上一次 accepted 是人对**那一次**结果的判断）。 */
        outcomeStatus,
        verificationSnapshot,
        review: normalizeReview(null),
      });
    }

    /* 退出中：状态已经由 shutdown() 定成 interrupted，这里只落盘收尾。
     * （见 shuttingDown 的说明 —— 否则会把 interrupted 翻成 cancelled。） */
    if (shuttingDown) {
      persist(plan);
      return task.status;
    }

    if (outcome.cancelled) {
      task.status = TASK_STATUS.CANCELLED; // 用户取消 ≠ 失败
      task.error = '已取消';
      emit(plan.id, task.id, agentId, 'task_cancelled', { attempt: task.attempt, sessionId, filesChanged });
    } else if (outcome.success) {
      task.status = TASK_STATUS.SUCCESS;
      task.error = '';
      emit(plan.id, task.id, agentId, 'task_success', { attempt: task.attempt, durationMs: task.result.durationMs, summary: task.result.summary, sessionId, filesChanged });
    } else {
      task.status = TASK_STATUS.FAILED;
      task.error = String(outcome.error || '执行失败').slice(0, 2000);
      emit(plan.id, task.id, agentId, 'task_error', { attempt: task.attempt, error: task.error, sessionId, filesChanged });
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

        const results = await Promise.all(batch.map((t, i) => runTask(plan, t, controllers[i], session)));
        batch.forEach((t) => session.controllers.delete(t.id));
        /* 关系映射也要跟着收掉 —— 留着会让 shutdown 把上一次尝试的会话 id
         * 或验证快照记到下一次尝试上（并行时尤其明显，规格 §13）。 */
        batch.forEach((t) => session.sessionIds.delete(t.id));
        batch.forEach((t) => session.verifications.delete(t.id));

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
        /* ⚠️ **退出中不要重算 plan 状态。**
         * `statusFromTasks` 把 interrupted 算进 failed，于是「应用被关掉」
         * 会被写成「计划失败」。而 shutdown() 已经把它定成 paused（那才是对的：
         * 还没跑完、可以重试）。这里保留 shutdown 的判断，不覆盖。 */
        if (!shuttingDown) session.plan.status = store.statusFromTasks(session.plan);
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
    /* 新的一轮执行 → 上一轮的 attempt 记账可以丢了（键里带 planId，
     * 清空只影响当前 plan，不会让别的 plan 重复记账）。
     * 同时清掉「正在退出」：能走到 start() 就说明进程还在正常服务，
     * 上一轮的 shutdown 已经过去了（生产里 shutdown 之后就是 exit，
     * 这里清掉是为了让调度器不会因为一次退出而永久失效）。 */
    recordedAttempts.clear();
    shuttingDown = false;
    persist(plan);

    const session = { planId: plan.id, plan, controllers: new Map(), sessionIds: new Map(), verifications: new Map(), stopping: false, pumpRunning: false };
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

  /**
   * 运行期变更该落到哪个 plan 对象上 —— **这是唯一判定处**（文件头第 6 条）。
   *
   * 计划仍在跑时，HTTP 路由手上那份 plan 是**每次请求重新 load 出来的副本**，
   * 与 Scheduler 内存里的 `active.plan` 是两个对象图。改副本没有意义：
   * pump / finishTask 之后 `persist(active.plan)` 会把整份文件盖回去。
   * 所以同一个 plan 正在跑 → 改 active.plan；别的 plan 原样返回。
   *
   * Route 层**不要再判断一次** active —— 规则只在这里一份，避免两处漂移。
   */
  function planForMutation(plan) {
    if (active && plan && active.planId === plan.id) return active.plan;
    return plan;
  }

  /** 取消单个 task：在跑就 abort，没跑就标 cancelled。 */
  function cancelTask(plan, taskId) {
    /* 运行期改 active.plan —— 否则 Scheduler 收尾时整份写盘会把这次取消冲掉，
     * 而且 pump 会因为内存里它还是 pending 而真的把它启动（见 planForMutation）。 */
    const target = planForMutation(plan);
    const task = target.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, code: 'not-found', error: '找不到这个任务' };
    if (TERMINAL_TASK_STATUS.includes(task.status)) {
      return { ok: false, code: 'settled', error: `任务已经结束（${task.status}），不能取消` };
    }
    const c = active && active.planId === target.id ? active.controllers.get(taskId) : null;
    if (c) {
      try {
        c.abort();
      } catch {
        /* noop */
      }
      return { ok: true, taskId, cancelledRunning: true, plan: target };
    }
    task.status = TASK_STATUS.CANCELLED;
    task.error = '已取消';
    persist(target);
    emit(target.id, taskId, null, 'task_cancelled', { attempt: task.attempt });
    return { ok: true, taskId, cancelledRunning: false, plan: target };
  }

  /**
   * 允许「重试」的状态：**已经有明确结论的那些**。
   *
   * 为什么 `success` 也在内（P8-B 的改动）：产品语义里「再跑一次这个任务」是
   * 一个正当操作 —— 用户可能对结果不满意、想换个思路、或者只是想再看看。
   * 早先直接拒绝已成功的任务（`code:'settled'`），于是
   *
   *     Attempt 1 success → 用户 accepted → 想再跑一次
   *
   * 这条路径根本走不通。而它恰恰是「人工审阅」最自然的后续动作。
   *
   * `skipped` 也保留（既有行为）：被跳过的任务重新跑一次是合理的。
   *
   * `pending / ready / blocked` 拒绝 —— 那些**还没有可重试的结果**，
   * 重试它们没有意义（排队中就是排队中）。
   * `running` 单独拒绝（要先停止）。
   */
  const RETRYABLE_TASK_STATUS = Object.freeze([
    TASK_STATUS.SUCCESS,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.INTERRUPTED,
    TASK_STATUS.SKIPPED,
  ]);

  /** 传递依赖 taskId 的所有任务（下游闭包，不含自己）。 */
  function downstreamOf(plan, taskId) {
    const out = [];
    const seen = new Set([taskId]);
    const queue = [taskId];
    while (queue.length) {
      const cur = queue.shift();
      for (const t of plan.tasks) {
        if (seen.has(t.id)) continue;
        if (!Array.isArray(t.dependsOn) || !t.dependsOn.includes(cur)) continue;
        seen.add(t.id);
        out.push(t);
        queue.push(t.id);
      }
    }
    return out;
  }

  /**
   * 重试：给这个 Task **排一次新的尝试**。
   *
   * ---------- 前置条件：这个 Plan 必须**不在执行中** ----------
   *
   * 计划仍 active 时一律拒绝（`code: 'plan-active'`），无论目标任务自己是
   * success / failed / cancelled / skipped。要重试就**等计划结束，或先停止整个计划**。
   * 理由见下面函数体里的注释与文件头第 6 条 —— 简单说：让 Retry 在运行期生效
   * 要么被覆盖、要么被 pump 自动执行，两条都不是「重试」应有的行为。
   *
   * ---------- 一条不能破的语义 ----------
   *
   *     Retry = 新的 Attempt，**不是重写历史**。
   *
   * 所以这个函数只动**当前态**（status / result / error / startedAt / endedAt），
   * 一个字节都不碰 `attempts[]` —— 历史里的 outcomeStatus / verificationSnapshot /
   * sessionId / filesChanged / review 全部原样留着。
   * 新的 Attempt 要等它**真的开始执行**时才产生（冻结快照也还是那时候做）。
   *
   * ---------- 三件容易被忽略的事 ----------
   *
   * 1. **下游必须重新评估。** A→B 都成功、计划 completed，用户重试 A：
   *    B 的历史保留，但 B 的**当前状态**不能再宣称「基于旧 A 的成功结果」——
   *    新的 A 结果可能完全不同。所以下游的终态任务回到 PENDING，等 A 跑完
   *    再按依赖重新推进。**只动当前态，不删任何历史**。
   * 2. **Plan 状态必须回到可执行。** 否则会出现「Plan completed + Task pending」
   *    这种自相矛盾的状态，而且 `start()` 会直接拒绝。
   * 3. **下游正在跑就不能重试上游** —— 那等于在飞行中把它的输入抽掉。
   */
  function retryTask(plan, taskId) {
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, code: 'not-found', error: '找不到这个任务' };
    if (task.status === TASK_STATUS.RUNNING) return { ok: false, code: 'running', error: '任务正在执行，先停止它' };

    if (!RETRYABLE_TASK_STATUS.includes(task.status)) {
      return { ok: false, code: 'nothing-to-retry', error: `任务当前是「${task.status}」，还没有可重试的结果` };
    }

    const downs = downstreamOf(plan, taskId);
    const busy = downs.find((d) => d.status === TASK_STATUS.RUNNING);
    if (busy) {
      return { ok: false, code: 'busy', error: `下游任务「${busy.id}」正在执行，先停止再重试上游` };
    }

    /* ---------- Plan 仍在执行 → 一律拒绝（文件头第 6 条） ----------
     *
     * 为什么不能像 cancel / skip 那样直接改 `active.plan`：Retry 会把任务改回
     * `pending`，而 pump 的下一轮 refreshStatuses 立刻把它标成 ready **自动跑掉**
     * ——「Retry 不自动执行」就不成立了。改外部副本则会被 Scheduler 收尾的
     * `persist(active.plan)` 覆盖回 success。两条路都不通，只能拒绝。
     *
     * **判据是「整个 Plan 还 active」，与目标任务自己的状态无关** —— 即使它已经是
     * success / failed / cancelled / skipped，只要计划还在跑就不许重试。
     *
     * ---------- 为什么排在这三关之后 ----------
     *
     * 拒绝理由是**具体 → 一般**逐层退让的，先把最具体的那条说清楚：
     *
     *     running          目标任务自己在跑        —— 最具体
     *     nothing-to-retry 目标任务还没有可重试的结果
     *     busy             重试会抽掉正在跑的下游的输入
     *     plan-active      上面都不是，但整个计划还在跑   —— 最一般
     *
     * 所以「计划 active 且下游正在跑」答 `busy`（那是真实的、更危险的危害），
     * 「计划 active、目标任务没跑、下游也没跑」才答 `plan-active`。
     * 四条全是 `ok:false` —— **计划仍在跑时，Retry 一次也不会真的发生**。 */
    if (active && active.planId === plan.id) {
      return { ok: false, code: 'plan-active', error: '计划仍在执行，请等待当前执行结束或先停止计划，再重试任务' };
    }

    /* 只重置**当前态**。`attempts` 不动 —— 这就是「不重写历史」。 */
    task.status = TASK_STATUS.PENDING;
    task.error = '';
    task.result = null;
    task.startedAt = null;
    task.endedAt = null;

    const invalidated = [];
    for (const d of downs) {
      if (!TERMINAL_TASK_STATUS.includes(d.status)) continue; // blocked / pending 的本来就会重算
      d.status = TASK_STATUS.PENDING;
      d.error = '';
      d.result = null;
      d.startedAt = null;
      d.endedAt = null;
      invalidated.push(d.id);
    }

    /* 终态的计划回到「可再次执行」。**不自动跑** —— 用户还要自己点开始。 */
    if (TERMINAL_PLAN_STATUS.includes(plan.status)) {
      plan.status = PLAN_STATUS.READY;
      plan.endedAt = null;
    }
    persist(plan);
    emit(plan.id, taskId, null, 'task_retry_queued', {
      nextAttempt: (task.attempt || 0) + 1,
      invalidated,
    });
    return { ok: true, taskId, nextAttempt: (task.attempt || 0) + 1, invalidated };
  }

  /** 跳过：**依赖它的任务仍然 blocked**，不自动放行（规格 §26）。 */
  function skipTask(plan, taskId) {
    /* 与 cancelTask 同理：运行期必须改 active.plan，否则这次跳过会被 Scheduler
     * 收尾的整份写盘冲回 pending（见 planForMutation / 文件头第 6 条）。 */
    const target = planForMutation(plan);
    const task = target.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, code: 'not-found', error: '找不到这个任务' };
    if (task.status === TASK_STATUS.RUNNING) return { ok: false, code: 'running', error: '任务正在执行，先停止它' };
    task.status = TASK_STATUS.SKIPPED;
    task.error = task.error || '已跳过';
    persist(target);
    emit(target.id, taskId, null, 'task_skipped', {});
    const dependents = target.tasks.filter((t) => t.dependsOn.includes(taskId) && !TERMINAL_TASK_STATUS.includes(t.status));
    return { ok: true, taskId, blockedDependents: dependents.map((t) => t.id), plan: target };
  }

  /** 应用退出时收尾：把在跑的标成 interrupted（规格 §31）。 */
  function shutdown() {
    if (!active) return;
    const session = active;
    shuttingDown = true;
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
        /* 补一条 attempt，但**不许猜执行期间发生了什么**：进程正在退出，
         * 拿不到 after 快照，所以 filesChanged 留空并标 changeCaptureIncomplete
         * （规格 §31）。sessionId 是执行前就确定的值，可以照记 —— 那条会话
         * 确实存在过，用户重启后仍然能找到它。 */
        const key = attemptKey(session.plan.id, t.id, t.attempt);
        if (!recordedAttempts.has(key)) {
          recordedAttempts.add(key);
          t.attempts = Array.isArray(t.attempts) ? t.attempts : [];
          t.attempts.push({
            attempt: t.attempt,
            startedAt: t.startedAt,
            endedAt: t.endedAt,
            success: false,
            error: '应用关闭时被中断',
            summary: '',
            exitCode: null,
            sessionId: session.sessionIds.get(t.id) || null,
            filesChanged: [],
            changeCaptureIncomplete: true,
            /* P8-A：被中断也是一条明确的执行结论，不是「未知」；
             * 验证快照在 attempt 开始时已经冻结过，所以这里能原样保留。 */
            outcomeStatus: ATTEMPT_OUTCOME.INTERRUPTED,
            verificationSnapshot: session.verifications.get(t.id) || null,
            review: normalizeReview(null),
          });
        }
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
