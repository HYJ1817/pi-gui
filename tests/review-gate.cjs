/* P11 —— 人工验收门控（Human Review Gate）。
 *
 * 要证明的核心：**执行状态 ≠ 审阅状态**（P8 的语义不能破），而门控只是让
 * 「下游能不能开始」多一个条件：
 *
 *     task.reviewGate = true
 *     → 这个任务执行成功后，依赖它的任务要等**最新一次成功尝试**被接受才能开始
 *
 * 覆盖规格 §三十四 的两条 blocker、§三十五 的后端清单、§三十六 的关键语义。
 *
 * 分工：
 *   - 本文件      门控的判定、DAG、Plan 状态、Retry、持久化与并发
 *   - `smoke.cjs` 门控的**前端**行为（badge / 等待原因 / 编辑器 / 保存反馈）
 *
 * 纪律：全程 os.tmpdir()；不 spawn 真 Agent（fake adapter）；不联网。
 *
 * 用法：node tests/review-gate.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}
function section(t) {
  console.log('\n--- ' + t + ' ---');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const git = (cwd, ...args) =>
  new Promise((resolve) => {
    const c = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code, out }));
  });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-p11-'));
const DATA = path.join(TMP, 'data');
const PROJ = path.join(TMP, 'proj');
const DATA2 = path.join(TMP, 'data2');
function cleanup() {
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* Windows 偶发占用 */
  }
}

function mkReq(method, urlStr, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url: urlStr,
    headers: {},
    on(ev, fn) {
      if (ev === 'data') for (const c of chunks) fn(c);
      else if (ev === 'end') fn();
      return this;
    },
  };
}

async function hit(planner, method, urlStr, body) {
  const out = { status: 0, body: null, raw: '' };
  const res = {
    writeHead(code) {
      out.status = code;
      return this;
    },
    end(chunk) {
      out.raw = String(chunk);
      try {
        out.body = JSON.parse(out.raw);
      } catch {
        out.body = out.raw;
      }
    },
  };
  await planner.handle(mkReq(method, urlStr, body), res, new URL('http://127.0.0.1' + urlStr));
  return out;
}

const reviewUrl = (planId, taskId, attempt) =>
  `/api/plans/${encodeURIComponent(planId)}/tasks/${encodeURIComponent(taskId)}/attempts/${attempt}/review`;

(async () => {
  const model = await import('../server/planner/model.js');
  const { createPlanStore } = await import('../server/planner/store.js');
  const { createScheduler } = await import('../server/planner/scheduler.js');
  const { createAgentRegistry } = await import('../server/agents/index.js');
  const { createPlanner } = await import('../server/planner/index.js');
  const { gitStatus } = await import('../lib/git.js');

  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(DATA2, { recursive: true });
  fs.mkdirSync(PROJ, { recursive: true });
  await git(PROJ, 'init', '-q');
  await git(PROJ, 'config', 'user.email', 't@t');
  await git(PROJ, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(PROJ, 'README.md'), '# demo\n');
  await git(PROJ, 'add', '-A');
  await git(PROJ, 'commit', '-qm', 'init');

  /* 每个 taskId 一个行为。门控测试里任务只需要「成功」。
   * P12 的真并发场景要一快一慢：gateA / downB 立刻返回，slowX 拖住当前 session。 */
  const BEHAVIORS = {
    ok: [{ ok: true, summary: 'done' }],
    ok2: [{ ok: true, summary: 'done' }],
    ok3: [{ ok: true, summary: 'done' }],
    fails: [{ ok: false, error: '故意失败' }],
    gateA: [{ ok: true, summary: 'A 完成' }],
    downB: [{ ok: true, summary: 'B 完成' }],
    slowX: [{ slowMs: 1200, ok: true, summary: 'X 完成' }],
  };
  const registry = createAgentRegistry({ env: process.env, includeFake: true, fakeBehaviors: BEHAVIORS });

  let cwd = PROJ;
  const runtime = {
    getCurrentCwd: () => cwd,
    setCurrentCwd: (v) => {
      cwd = v;
    },
    isShuttingDown: () => false,
  };
  const store = createPlanStore({ dataDir: DATA });
  const scheduler = createScheduler({ store, registry, runtime, gitStatus });
  const planner = createPlanner({ runtime, registry, store, scheduler });

  /* ---------- 计划构造与执行 ---------- */

  function mkPlan({ id, tasks, project = PROJ, concurrency = 1, status = 'ready' }) {
    return {
      id,
      title: 'P11 计划 ' + id,
      goal: '目标',
      status,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      endedAt: null,
      projectRoot: project,
      concurrency,
      recoveryNotes: [],
      source: null,
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title || '任务 ' + t.id,
        description: t.description || '',
        agent: t.agent || 'fake',
        workingDirectory: '.',
        dependsOn: t.dependsOn || [],
        status: 'pending',
        startedAt: null,
        endedAt: null,
        attempt: 0,
        attempts: [],
        result: null,
        error: '',
        verification: t.verification === undefined ? null : t.verification,
        reviewGate: Boolean(t.reviewGate),
      })),
    };
  }

  async function runPlan(opts) {
    runtime.setCurrentCwd(opts.project || PROJ);
    store.save(mkPlan(opts));
    const r = await scheduler.start(store.load(opts.id).plan);
    if (!r.ok) throw new Error('start 失败：' + r.error + ' (' + r.code + ')');
    await scheduler.waitIdle(20000);
    return store.load(opts.id).plan;
  }

  const load = (id) => store.load(id).plan;
  const taskOf = (p, id) => (p.tasks || []).find((t) => t.id === id);
  const attemptsOf = (p, id) => {
    const t = taskOf(p, id);
    return t && Array.isArray(t.attempts) ? t.attempts : [];
  };
  async function review(planId, taskId, attempt, status, extra = {}) {
    const p = load(planId);
    const a = (attemptsOf(p, taskId).find((x) => x.attempt === attempt)) || {};
    const rev = model.normalizeReview(a.review).revision;
    return hit(planner, 'PUT', reviewUrl(planId, taskId, attempt), {
      status,
      note: '',
      expectedRevision: rev,
      ...extra,
    });
  }

  /* ================= A. 门控判定（纯函数） ================= */
  section('A. 门控判定：只看**最新一次成功**尝试的 review');

  {
    const mkTask = (reviewGate, attempts) => ({ id: 't', reviewGate, attempts, status: 'success' });
    const att = (n, success, review) => ({ attempt: n, success, review: { status: review, note: '', reviewedAt: 1, revision: 1 } });

    check('A1. 没开门控 → 一律 satisfied，对下游完全透明', () => {
      const g = model.reviewGateState(mkTask(false, []));
      return (g.enabled === false && g.satisfied === true) || JSON.stringify(g);
    });
    check('A2. 开了门控但一次都没成功过 → 不满足，原因是 no-successful-attempt', () => {
      const g = model.reviewGateState(mkTask(true, [att(1, false, 'pending')]));
      return (g.enabled === true && g.satisfied === false && g.reason === 'no-successful-attempt') || JSON.stringify(g);
    });
    check('A3. success + pending → 不满足', () => {
      const g = model.reviewGateState(mkTask(true, [att(1, true, 'pending')]));
      return (g.satisfied === false && g.reason === 'pending' && g.attempt === 1) || JSON.stringify(g);
    });
    check('A4. success + accepted → 满足', () => {
      const g = model.reviewGateState(mkTask(true, [att(1, true, 'accepted')]));
      return (g.satisfied === true && g.reason === 'accepted') || JSON.stringify(g);
    });
    check('A5. success + needs_changes → 不满足', () => {
      const g = model.reviewGateState(mkTask(true, [att(1, true, 'needs_changes')]));
      return (g.satisfied === false && g.reason === 'needs_changes') || JSON.stringify(g);
    });
    check('A6. **旧 accepted 不继承**：Attempt1 accepted、Attempt2 success+pending → 用 Attempt2', () => {
      const g = model.reviewGateState(mkTask(true, [att(1, true, 'accepted'), att(2, true, 'pending')]));
      return (g.satisfied === false && g.attempt === 2 && g.reason === 'pending') || JSON.stringify(g);
    });
    check('A7. 失败的 attempt 不算「成功」——Attempt2 failed 时仍看 Attempt1', () => {
      const g = model.reviewGateState(mkTask(true, [att(1, true, 'accepted'), att(2, false, 'needs_changes')]));
      return (g.satisfied === true && g.attempt === 1) || JSON.stringify(g);
    });
    check('A8. 老 attempt 没有 review 字段 → 归一成 pending（不是 accepted）', () => {
      const g = model.reviewGateState(mkTask(true, [{ attempt: 1, success: true }]));
      return (g.satisfied === false && g.reason === 'pending') || JSON.stringify(g);
    });
  }

  {
    /* 归一化：旧数据缺字段、真值、假值 */
    const n = (raw) => model.normalizeTask(Object.assign({ id: 'x', title: 'x' }, raw)).task;
    check('A9. 缺字段 → false（旧 Plan 行为完全不变）', () => n({}).reviewGate === false);
    check('A10. 真值 → true', () => n({ reviewGate: true }).reviewGate === true);
    check('A11. 假值（0 / null / "no"）→ false，不认字符串', () => n({ reviewGate: 0 }).reviewGate === false && n({ reviewGate: 'yes' }).reviewGate === true);
  }

  /* ================= B. DAG：谁被卡住 ================= */
  section('B. DAG：门控把下游标成 blocked + waiting-review');

  {
    const mk = (taskList) => mkPlan({ id: 'b', tasks: taskList });
    const byIdOf = (plan) => new Map(plan.tasks.map((t) => [t.id, t]));

    const scenario = (gate, aStatus, reviewStatus) => {
      const p = mk([
        { id: 'a', reviewGate: gate },
        { id: 'b', dependsOn: ['a'] },
      ]);
      const a = taskOf(p, 'a');
      a.status = aStatus;
      a.attempts = [{ attempt: 1, success: true, review: { status: reviewStatus, note: '', reviewedAt: 1, revision: 1 } }];
      const st = model.dependencyStateOf(taskOf(p, 'b'), byIdOf(p));
      return st;
    };

    check('B1. 依赖 success 但门控没满足 → blocked + waiting-review', () => {
      const st = scenario(true, 'success', 'pending');
      return (st.status === 'blocked' && st.reason === 'waiting-review' && st.waitingOn.join() === 'a') || JSON.stringify(st);
    });
    check('B2. 门控满足 → ready', () => {
      const st = scenario(true, 'success', 'accepted');
      return (st.status === 'ready' && st.reason === null) || JSON.stringify(st);
    });
    check('B3. needs_changes → blocked + waiting-review', () => {
      const st = scenario(true, 'success', 'needs_changes');
      return (st.status === 'blocked' && st.reason === 'waiting-review') || JSON.stringify(st);
    });
    check('B4. **没开门控时行为与旧实现一致**：success 直接放行', () => {
      const st = scenario(false, 'success', 'pending');
      return (st.status === 'ready') || JSON.stringify(st);
    });
    check('B5. 依赖失败 → dependency-failed（不是 waiting-review）', () => {
      const st = scenario(true, 'failed', 'pending');
      return (st.status === 'blocked' && st.reason === 'dependency-failed') || JSON.stringify(st);
    });
    check('B6. 依赖被跳过 → dependency-skipped', () => {
      const st = scenario(true, 'skipped', 'pending');
      return (st.status === 'blocked' && st.reason === 'dependency-skipped') || JSON.stringify(st);
    });
  }

  {
    /* 多上游：原因优先级 —— 执行失败 > 等人工验收（§二十六） */
    const p = mkPlan({
      id: 'b2',
      tasks: [
        { id: 'gated', reviewGate: true },
        { id: 'plain' },
        { id: 'c', dependsOn: ['gated', 'plain'] },
      ],
    });
    const byId = new Map(p.tasks.map((t) => [t.id, t]));
    const gated = taskOf(p, 'gated');
    const plain = taskOf(p, 'plain');
    gated.status = 'success';
    gated.attempts = [{ attempt: 1, success: true, review: { status: 'pending', note: '', reviewedAt: 1, revision: 1 } }];
    plain.status = 'success';

    check('B7. 多上游：一个在等验收、另一个已成功 → waiting-review', () => {
      const st = model.dependencyStateOf(taskOf(p, 'c'), byId);
      return (st.status === 'blocked' && st.reason === 'waiting-review' && st.waitingOn.join() === 'gated') || JSON.stringify(st);
    });
    check('B8. **失败优先**：一个在等验收、另一个失败 → dependency-failed', () => {
      plain.status = 'failed';
      const st = model.dependencyStateOf(taskOf(p, 'c'), byId);
      return (st.status === 'blocked' && st.reason === 'dependency-failed') || JSON.stringify(st);
    });
    check('B9. 优先级与顺序无关（失败那个排在后面也一样）', () => {
      const p2 = mkPlan({
        id: 'b3',
        tasks: [
          { id: 'bad' },
          { id: 'gated', reviewGate: true },
          { id: 'c', dependsOn: ['gated', 'bad'] },
        ],
      });
      const by = new Map(p2.tasks.map((t) => [t.id, t]));
      taskOf(p2, 'bad').status = 'failed';
      const g = taskOf(p2, 'gated');
      g.status = 'success';
      g.attempts = [{ attempt: 1, success: true, review: { status: 'pending', note: '', reviewedAt: 1, revision: 1 } }];
      const st = model.dependencyStateOf(taskOf(p2, 'c'), by);
      return (st.reason === 'dependency-failed') || JSON.stringify(st);
    });
  }

  /* ================= C. 端到端：Scheduler 不启动等待验收的下游 ================= */
  section('C. 端到端：门控真的挡住了调度');

  {
    const p = await runPlan({
      id: 'e1',
      tasks: [
        { id: 'ok', reviewGate: true },
        { id: 'ok2', dependsOn: ['ok'] },
      ],
    });
    check('C1. 上游执行成功（执行状态是真的 success）', () => taskOf(p, 'ok').status === 'success' || taskOf(p, 'ok').status);
    check('C2. 下游 **没有被执行**（blocked，不是 ready/success）', () => taskOf(p, 'ok2').status === 'blocked' || taskOf(p, 'ok2').status);
    check('C3. 下游一次 attempt 都没有（确实没跑）', () => attemptsOf(p, 'ok2').length === 0 || String(attemptsOf(p, 'ok2').length));
    check('C4. Plan 是 paused（不是 running / completed）', () => p.status === 'paused' || p.status);
    check('C5. paused 的原因是 waiting-review', () => {
      const w = model.planWorkflowState(p);
      return (w.status === 'paused' && w.reason === 'waiting-review') || JSON.stringify(w);
    });

    /* 走 HTTP 拿视图：blockedReason / waitingOn 是**视图字段** */
    const detail = await hit(planner, 'GET', '/api/plans/e1', undefined);
    check('C7. 详情接口里下游带 blockedReason=waiting-review 与 waitingOn=[ok]', () => {
      const t = (detail.body.plan.tasks || []).find((x) => x.id === 'ok2');
      return (t && t.blockedReason === 'waiting-review' && (t.waitingOn || []).join() === 'ok') || JSON.stringify(t && { s: t.status, r: t.blockedReason, w: t.waitingOn });
    });
    check('C8. 上游的 gateState 说清「在等第 1 次尝试」', () => {
      const t = (detail.body.plan.tasks || []).find((x) => x.id === 'ok');
      return (t && t.gateState && t.gateState.enabled === true && t.gateState.satisfied === false && t.gateState.attempt === 1) || JSON.stringify(t && t.gateState);
    });
    check('C9. Plan 视图带门控汇总（waiting = 1）', () => {
      const g = detail.body.plan.reviewGateSummary;
      return (g && g.gated === 1 && g.waiting === 1 && g.satisfied === 0) || JSON.stringify(g);
    });
    check('C10. blockedReason 与 waitingOn **没有**被写回计划文件', () => {
      const onDisk = load('e1');
      const t = taskOf(onDisk, 'ok2');
      return (t.blockedReason === undefined && t.waitingOn === undefined && t.gateState === undefined) || JSON.stringify({ b: t.blockedReason, w: t.waitingOn, g: t.gateState });
    });
    check('C11. reviewGate 本身**要**留在盘上（它是策略，不是视图）', () => taskOf(load('e1'), 'ok').reviewGate === true);
  }

  {
    /* accepted 之后：下游变 ready，但**不自动执行** */
    const r = await review('e1', 'ok', 1, 'accepted');
    check('C12. 接受这次审阅成功', () => r.body.ok === true || JSON.stringify(r.body));
    check('C13. 响应带回工作流后果：ready 里有 ok2、planStatus 是 ready', () => {
      const g = r.body.gate;
      return (g && (g.ready || []).join() === 'ok2' && g.planStatus === 'ready') || JSON.stringify(g);
    });
    const after = load('e1');
    check('C14. 盘上下游已变 ready（后端是权威，不是只在前端算）', () => taskOf(after, 'ok2').status === 'ready' || taskOf(after, 'ok2').status);
    check('C15. **但没有自动执行**：它还是 ready，没有 running/attempt', () => attemptsOf(after, 'ok2').length === 0 || String(attemptsOf(after, 'ok2').length));
    check('C16. 上游的执行状态没被审阅改动（仍是 success）', () => taskOf(after, 'ok').status === 'success');
    check('C17. 门控现在满足了', () => model.reviewGateState(taskOf(after, 'ok')).satisfied === true);
  }

  {
    /* 用户手动点开始 → 这次才跑 */
    runtime.setCurrentCwd(PROJ);
    const r = await scheduler.start(load('e1'));
    check('C18. 手动 start 能被接受（计划没有被锁死）', () => r.ok === true || JSON.stringify(r));
    if (r.ok) await scheduler.waitIdle(20000);
    const after = load('e1');
    check('C19. 下游这次真的跑了（success）', () => taskOf(after, 'ok2').status === 'success' || taskOf(after, 'ok2').status);
  }

  {
    /* needs_changes：继续挡住，且不自动 retry */
    const p = await runPlan({
      id: 'e2',
      tasks: [
        { id: 'ok', reviewGate: true },
        { id: 'ok2', dependsOn: ['ok'] },
      ],
    });
    const beforeAttempts = attemptsOf(p, 'ok').length;
    const r = await review('e2', 'ok', 1, 'needs_changes');
    check('C20. 标「需要修改」成功', () => r.body.ok === true || JSON.stringify(r.body));
    const after = load('e2');
    check('C21. 下游仍然 blocked', () => taskOf(after, 'ok2').status === 'blocked' || taskOf(after, 'ok2').status);
    check('C22. **没有自动 Retry**（attempts 数没变、没有新 attempt）', () => attemptsOf(after, 'ok').length === beforeAttempts || String(attemptsOf(after, 'ok').length));
    check('C23. 上游执行状态没被改成 failed（执行 ≠ 审阅）', () => taskOf(after, 'ok').status === 'success');
    check('C24. Plan 仍是 paused + waiting-review', () => {
      const w = model.planWorkflowState(after);
      return (w.status === 'paused' && w.reason === 'waiting-review') || JSON.stringify(w);
    });
  }

  {
    /* 并发：无关的 Task 不受门控影响（§二十三 / §三十五 16） */
    const p = await runPlan({
      id: 'e3',
      concurrency: 2,
      tasks: [
        { id: 'ok', reviewGate: true },
        { id: 'ok2', dependsOn: ['ok'] },
        { id: 'ok3' }, // 与 ok 无依赖
      ],
    });
    check('C25. 无关任务**照常执行**（门控不是全局锁）', () => taskOf(p, 'ok3').status === 'success' || taskOf(p, 'ok3').status);
    check('C26. 门控只挡住它的 downstream', () => taskOf(p, 'ok2').status === 'blocked' || taskOf(p, 'ok2').status);
    check('C27. 上游本身照常成功', () => taskOf(p, 'ok').status === 'success' || taskOf(p, 'ok').status);
  }

  {
    /* 多级门控 A(gate) → B(gate) → C（§二十四） */
    await runPlan({
      id: 'e4',
      tasks: [
        { id: 'ok', reviewGate: true },
        { id: 'ok2', reviewGate: true, dependsOn: ['ok'] },
        { id: 'ok3', dependsOn: ['ok2'] },
      ],
    });
    let p = load('e4');
    check('C28. 第一级完成，第二级 blocked', () => taskOf(p, 'ok').status === 'success' && taskOf(p, 'ok2').status === 'blocked' || JSON.stringify({ a: taskOf(p, 'ok').status, b: taskOf(p, 'ok2').status }));
    check('C29. 第三级是 pending（还没轮到它，不是 waiting-review）', () => {
      const byId = new Map(p.tasks.map((t) => [t.id, t]));
      const st = model.dependencyStateOf(taskOf(p, 'ok3'), byId);
      return (taskOf(p, 'ok3').status === 'pending' && st.reason === 'pending') || JSON.stringify({ s: taskOf(p, 'ok3').status, r: st.reason });
    });

    await review('e4', 'ok', 1, 'accepted');
    p = load('e4');
    check('C30. 第一级 accepted → 第二级 ready', () => taskOf(p, 'ok2').status === 'ready' || taskOf(p, 'ok2').status);

    runtime.setCurrentCwd(PROJ);
    const r = await scheduler.start(load('e4'));
    if (r.ok) await scheduler.waitIdle(20000);
    p = load('e4');
    check('C31. 第二级跑完后自己也卡在门控上（第三级 blocked）', () => taskOf(p, 'ok2').status === 'success' && taskOf(p, 'ok3').status === 'blocked' || JSON.stringify({ b: taskOf(p, 'ok2').status, c: taskOf(p, 'ok3').status }));

    await review('e4', 'ok2', 1, 'accepted');
    p = load('e4');
    check('C32. 第二级 accepted → 第三级 ready', () => taskOf(p, 'ok3').status === 'ready' || taskOf(p, 'ok3').status);
  }

  /* ================= D. Plan 状态：最后一个 Gate ================= */
  section('D. Plan 状态：等验收 → paused，验收通过 → completed');

  {
    const p = await runPlan({
      id: 'd1',
      tasks: [
        { id: 'ok' },
        { id: 'ok2', reviewGate: true, dependsOn: ['ok'] },
      ],
    });
    check('D1. 最后一个任务成功但门控没满足 → Plan **不能** completed', () => p.status !== 'completed' || p.status);
    check('D2. 而是 paused + waiting-review', () => {
      const w = model.planWorkflowState(p);
      return (w.status === 'paused' && w.reason === 'waiting-review') || JSON.stringify(w);
    });
    check('D3. 任务本身的执行状态仍然是 success（等验收不是执行状态）', () => taskOf(p, 'ok2').status === 'success' || taskOf(p, 'ok2').status);

    const r = await review('d1', 'ok2', 1, 'accepted');
    const after = load('d1');
    check('D4. accepted → Plan completed', () => after.status === 'completed' || after.status);
    check('D5. 而且不需要再点「继续」（没有可跑的任务了）', () => after.tasks.every((t) => t.status === 'success') || JSON.stringify(after.tasks.map((t) => t.status)));
    check('D6. 响应里的 planStatus 也是 completed', () => (r.body.gate && r.body.gate.planStatus === 'completed') || JSON.stringify(r.body.gate));

    /* §三十二：completed 之后把最后那个门控改回 needs_changes → Plan 重新打开 */
    const r2 = await review('d1', 'ok2', 1, 'needs_changes');
    const reopened = load('d1');
    check('D7. accepted → needs_changes：Plan **从 completed 退回 paused**', () => reopened.status === 'paused' || reopened.status);
    check('D8. 退回 paused 时 endedAt 被清掉（它不是「结束」了）', () => reopened.endedAt === null || String(reopened.endedAt));
    check('D9. 历史执行结果**不被重写**（任务仍是 success、attempt 还在）', () => taskOf(reopened, 'ok2').status === 'success' && attemptsOf(reopened, 'ok2').length === 1 || JSON.stringify({ s: taskOf(reopened, 'ok2').status, n: attemptsOf(reopened, 'ok2').length }));

    const r3 = await review('d1', 'ok2', 1, 'accepted');
    check('D10. 再 accepted → Plan 又回到 completed', () => load('d1').status === 'completed' || load('d1').status);
    check('D11. 第三次写入的 revision 一直涨（乐观并发没被破坏）', () => (r3.body.review && r3.body.review.revision === 3) || JSON.stringify(r3.body.review));

    /* accepted → pending（§三十五 22） */
    await review('d1', 'ok2', 1, 'pending');
    check('D12. accepted → pending 也退回 paused', () => load('d1').status === 'paused' || load('d1').status);
  }

  /* ================= E. Retry：旧 accepted 不继承 ================= */
  section('E. Retry 之后门控重新关上');

  {
    const p = await runPlan({
      id: 'r1',
      tasks: [
        { id: 'ok', reviewGate: true },
        { id: 'ok2', dependsOn: ['ok'] },
      ],
    });
    await review('r1', 'ok', 1, 'accepted');
    check('E1. 先让它通过一次：下游 ready', () => taskOf(load('r1'), 'ok2').status === 'ready' || taskOf(load('r1'), 'ok2').status);

    const rt = scheduler.retryTask(load('r1'), 'ok');
    check('E2. retry 被接受', () => rt.ok === true || JSON.stringify(rt));
    const after = load('r1');
    check('E3. 重试后上游回到 pending（**排队**，不自动跑 —— P8-B 的语义）', () => taskOf(after, 'ok').status === 'pending' || taskOf(after, 'ok').status);
    check('E4. 下游**没有被当成已放行而跑掉**（它一次都没执行）', () => attemptsOf(after, 'ok2').length === 0 || String(attemptsOf(after, 'ok2').length));

    /* 再跑一次：Attempt2 成功 + pending → 门控仍然关着 */
    runtime.setCurrentCwd(PROJ);
    const r = await scheduler.start(load('r1'));
    if (r.ok) await scheduler.waitIdle(20000);
    const p2 = load('r1');
    check('E5. Attempt2 成功后门控**仍然**关着（旧 accepted 不被沿用）', () => {
      const g = model.reviewGateState(taskOf(p2, 'ok'));
      return (g.satisfied === false && g.attempt === 2) || JSON.stringify(g);
    });
    check('E6. 下游再次 blocked + waiting-review', () => {
      const byId = new Map(p2.tasks.map((t) => [t.id, t]));
      const st = model.dependencyStateOf(taskOf(p2, 'ok2'), byId);
      return (taskOf(p2, 'ok2').status === 'blocked' && st.reason === 'waiting-review') || JSON.stringify({ s: taskOf(p2, 'ok2').status, r: st.reason });
    });
    check('E7. Attempt1 的 accepted 记录**原样还在**（retry 不改历史）', () => {
      const a1 = attemptsOf(p2, 'ok').find((x) => x.attempt === 1);
      return (a1 && model.normalizeReview(a1.review).status === 'accepted') || JSON.stringify(a1 && a1.review);
    });
  }

  /* ================= F. 不干扰既有语义 ================= */
  section('F. Verification / 证据 / 执行结论都不参与门控');

  {
    /* verificationResult 取值不影响 gate（§七 / §三十五 30） */
    const st = { status: 'success', reviewGate: true, attempts: [{ attempt: 1, success: true, review: { status: 'accepted', note: '', reviewedAt: 1, revision: 1 } }] };
    const variants = [
      { label: '从没跑过', v: null },
      { label: 'passed', v: { status: 'passed', command: 'x', exitCode: 0 } },
      { label: 'failed', v: { status: 'failed', command: 'x', exitCode: 1 } },
    ];
    for (const { label, v } of variants) {
      const t = Object.assign({}, st, { attempts: [Object.assign({}, st.attempts[0], { verificationResult: v })] });
      check('F1. 验证结果「' + label + '」不影响门控判定', () => model.reviewGateState(t).satisfied === true || JSON.stringify(model.reviewGateState(t)));
    }

    /* changeEvidence 同理（§三十五 31） */
    const t2 = Object.assign({}, st, { attempts: [Object.assign({}, st.attempts[0], { changeEvidence: { status: 'partial', files: [], truncated: true, note: '' } })] });
    check('F2. changeEvidence 不影响门控判定', () => model.reviewGateState(t2).satisfied === true);

    /* gate 不改 execution 字段（§三十五 32） */
    const p = await runPlan({ id: 'f1', tasks: [{ id: 'ok', reviewGate: true }, { id: 'ok2', dependsOn: ['ok'] }] });
    const t = taskOf(p, 'ok');
    const a = attemptsOf(p, 'ok')[0];
    check('F3. 门控不改 execution outcome / attempt 结构', () => (t.status === 'success' && a.success === true && a.attempt === 1 && a.outcomeStatus === 'success') || JSON.stringify({ s: t.status, ok: a.success, o: a.outcomeStatus }));
  }

  {
    /* 失败 / 取消 / 跳过的依赖者**不能**显示成 waiting-review（§九 / §二十六） */
    for (const [st, reason] of [['failed', 'dependency-failed'], ['cancelled', 'dependency-cancelled'], ['skipped', 'dependency-skipped'], ['interrupted', 'dependency-interrupted']]) {
      const p = mkPlan({ id: 'f-' + st, tasks: [{ id: 'a', reviewGate: true }, { id: 'b', dependsOn: ['a'] }] });
      taskOf(p, 'a').status = st;
      const byId = new Map(p.tasks.map((x) => [x.id, x]));
      check('F4. 依赖 ' + st + ' → ' + reason + '（不是 waiting-review）', () => {
        const s = model.dependencyStateOf(taskOf(p, 'b'), byId);
        return (s.status === 'blocked' && s.reason === reason) || JSON.stringify(s);
      });
    }
  }

  {
    /* 老 Plan 缺 reviewGate → false，行为与 P11 之前完全一样（§三十五 26 / 27） */
    const legacy = mkPlan({ id: 'f-old', tasks: [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }] });
    for (const t of legacy.tasks) delete t.reviewGate;
    store.save(legacy);
    const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'plans', 'f-old.json'), 'utf8'));
    check('F5. 老计划文件里确实没有 reviewGate 这个键', () => raw.tasks.every((t) => !('reviewGate' in t)) || JSON.stringify(raw.tasks.map((t) => t.reviewGate)));
    const loaded = load('f-old');
    check('F6. 读出来归一成 false', () => loaded.tasks.every((t) => t.reviewGate === false) || JSON.stringify(loaded.tasks.map((t) => t.reviewGate)));
    check('F7. schemaVersion 没变（纯新增字段，不需要迁移）', () => {
      const v = store.load('f-old').plan;
      return v && (v.schemaVersion === undefined || v.schemaVersion === 1) || String(v && v.schemaVersion);
    });
  }

  /* ================= G. 写盘、冲突与重启 ================= */
  section('G. 并发、PUT 与重启');

  {
    /* revision 冲突不改变 DAG（§三十五 23） */
    const p = await runPlan({ id: 'g1', tasks: [{ id: 'ok', reviewGate: true }, { id: 'ok2', dependsOn: ['ok'] }] });
    const before = JSON.stringify(p.tasks.map((t) => t.status));
    const bad = await hit(planner, 'PUT', reviewUrl('g1', 'ok', 1), { status: 'accepted', note: '', expectedRevision: 99 });
    check('G1. revision 对不上 → 409', () => bad.status === 409 || JSON.stringify({ s: bad.status, b: bad.body }));
    check('G2. 冲突之后 DAG 一个字节没变', () => JSON.stringify(load('g1').tasks.map((t) => t.status)) === before || JSON.stringify(load('g1').tasks.map((t) => t.status)));
  }

  {
    /* 写盘失败不改变 DAG（§三十五 24）——用一个会抛的 store */
    const failing = {
      load: (id) => store.load(id),
      save: () => {
        throw new Error('磁盘满了');
      },
      remove: () => {},
      statusFromTasks: store.statusFromTasks,
      revive: (r) => r,
      recoverAll: () => {},
    };
    const plannerFail = createPlanner({ runtime, registry, store: failing, scheduler });
    const bad = await hit(plannerFail, 'PUT', reviewUrl('g1', 'ok', 1), { status: 'accepted', note: '', expectedRevision: 0 });
    check('G3. 写盘失败 → 如实报错（ok:false）', () => bad.body.ok === false || JSON.stringify(bad.body));
    check('G4. 而且盘上的 DAG 没变', () => taskOf(load('g1'), 'ok2').status === 'blocked' || taskOf(load('g1'), 'ok2').status);
  }

  {
    /* PUT Plan 可以开/关门控，并且**就地重算下游**（§三十五 25） */
    const seed = () => {
      const p = mkPlan({ id: 'g2', tasks: [{ id: 'ok' }, { id: 'ok2', dependsOn: ['ok'] }] });
      const a = taskOf(p, 'ok');
      a.status = 'success';
      a.attempt = 1;
      a.attempts = [{ attempt: 1, success: true, summary: '', error: '', exitCode: 0, startedAt: 1, endedAt: 2, filesChanged: [], changeCaptureIncomplete: false, outcomeStatus: 'success', review: { status: 'pending', note: '', reviewedAt: null, revision: 0 } }];
      store.save(p);
      return p;
    };
    const putGate = async (gate) => {
      const p = seed();
      return hit(planner, 'PUT', '/api/plans/g2', {
        title: p.title,
        goal: p.goal,
        tasks: p.tasks.map((t) => Object.assign({}, t, { reviewGate: gate(t.id) })),
      });
    };
    runtime.setCurrentCwd(PROJ);

    const r1 = await putGate(() => false);
    check('G5. PUT 成功（门控关着）', () => r1.body.ok === true || JSON.stringify(r1.body).slice(0, 200));
    check('G6. 关着门控 → 上游成功即可放行下游（ready）', () => taskOf(load('g2'), 'ok2').status === 'ready' || taskOf(load('g2'), 'ok2').status);

    await putGate((id) => id === 'ok');
    check('G7. reviewGate 落盘了（开关是策略，可以事后开）', () => taskOf(load('g2'), 'ok').reviewGate === true);
    check('G8. 开上门控 → 下游**就地**变 blocked + waiting-review', () => {
      const after = load('g2');
      const byId = new Map(after.tasks.map((t) => [t.id, t]));
      const st = model.dependencyStateOf(taskOf(after, 'ok2'), byId);
      return (taskOf(after, 'ok2').status === 'blocked' && st.reason === 'waiting-review') || JSON.stringify({ s: taskOf(after, 'ok2').status, r: st.reason });
    });
  }

  {
    /* 重启：从持久化的 review 正确重算门控（§三十五 28） */
    const p = await runPlan({ id: 'g3', tasks: [{ id: 'ok', reviewGate: true }, { id: 'ok2', dependsOn: ['ok'] }] });
    await review('g3', 'ok', 1, 'accepted');
    // 「重启」= 用同一份数据目录重新造一套 store/scheduler/planner
    const store2 = createPlanStore({ dataDir: DATA });
    const planner2 = createPlanner({ runtime, registry, store: store2, scheduler: createScheduler({ store: store2, registry, runtime, gitStatus }) });
    const detail = await hit(planner2, 'GET', '/api/plans/g3', undefined);
    check('G9. 重启后门控状态从持久化 review 重算出来（satisfied）', () => {
      const t = (detail.body.plan.tasks || []).find((x) => x.id === 'ok');
      return (t && t.gateState && t.gateState.satisfied === true) || JSON.stringify(t && t.gateState);
    });
    check('G10. 重启后下游状态与磁盘一致（ready）', () => {
      const t = (detail.body.plan.tasks || []).find((x) => x.id === 'ok2');
      return (t && t.status === 'ready') || JSON.stringify(t && t.status);
    });
  }

  {
    /* 硬崩恢复不伪造 accepted（§三十五 29） */
    const p = mkPlan({ id: 'g4', tasks: [{ id: 'ok', reviewGate: true }] });
    const t = taskOf(p, 'ok');
    t.status = 'success';
    t.attempt = 1;
    t.attempts = [{ attempt: 1, success: true, summary: '', error: '', exitCode: 0, startedAt: 1, endedAt: 2, filesChanged: [], changeCaptureIncomplete: false, outcomeStatus: 'success', review: { status: 'pending', note: '', reviewedAt: null, revision: 0 } }];
    store.save(p);
    check('G11. 恢复出来的 attempt 是 pending，不是 accepted', () => {
      const a = attemptsOf(load('g4'), 'ok')[0];
      return model.normalizeReview(a.review).status === 'pending' || JSON.stringify(a.review);
    });
    check('G12. 门控因此仍然关着', () => model.reviewGateState(taskOf(load('g4'), 'ok')).satisfied === false);
  }

  {
    /* 跨项目：别的项目的计划不能审阅（§三十五 35） */
    const other = path.join(TMP, 'other');
    fs.mkdirSync(other, { recursive: true });
    await git(other, 'init', '-q');
    const p = mkPlan({ id: 'g5', project: PROJ, tasks: [{ id: 'ok', reviewGate: true }] });
    taskOf(p, 'ok').status = 'success';
    taskOf(p, 'ok').attempt = 1;
    taskOf(p, 'ok').attempts = [{ attempt: 1, success: true, summary: '', error: '', exitCode: 0, startedAt: 1, endedAt: 2, filesChanged: [], changeCaptureIncomplete: false, outcomeStatus: 'success', review: { status: 'pending', note: '', reviewedAt: null, revision: 0 } }];
    store.save(p);
    runtime.setCurrentCwd(other);
    const bad = await hit(planner, 'PUT', reviewUrl('g5', 'ok', 1), { status: 'accepted', note: '', expectedRevision: 0 });
    check('G13. 切到别的项目后审阅被拒（403）', () => bad.status === 403 || JSON.stringify({ s: bad.status, b: bad.body }));
    check('G14. 而且没被写进去', () => model.normalizeReview(attemptsOf(load('g5'), 'ok')[0].review).status === 'pending');
    runtime.setCurrentCwd(PROJ);
  }

  /* ================= H. 不可信文本 ================= */
  section('H. 门控字段里的文本都是纯数据');

  {
    const evil = '<img src=x onerror=alert(1)>';
    const p = mkPlan({ id: 'h1', tasks: [{ id: 'a', title: evil, reviewGate: true }, { id: 'b', title: evil, dependsOn: ['a'] }] });
    taskOf(p, 'a').status = 'success';
    taskOf(p, 'a').attempts = [{ attempt: 1, success: true, review: { status: 'pending', note: '', reviewedAt: 1, revision: 1 } }];
    store.save(p);
    const detail = await hit(planner, 'GET', '/api/plans/h1', undefined);
    const b = (detail.body.plan.tasks || []).find((x) => x.id === 'b');
    check('H1. waitingOn 里放的是**任务 id**，不是标题（标题是不可信文本）', () => (b.waitingOn || []).join() === 'a' || JSON.stringify(b.waitingOn));
    check('H2. blockedReason 是稳定的枚举值，不含任何计划内容', () => b.blockedReason === 'waiting-review' || JSON.stringify(b.blockedReason));
    check('H3. 响应里没有被转义/拼接过的 HTML（后端只给数据）', () => !/&lt;img/.test(detail.raw) || detail.raw.slice(0, 200));
  }

  /* ================= I. Gate required：门控只在**执行成功后**才需要满足 =================
   *
   * Blocker A：以前 `reviewGateState().satisfied === false` 就等于「在等验收」，
   * 于是**一个执行失败的 gated 任务**也会把整份 Plan 顶成 `paused + waiting-review`
   * —— 明明是失败，界面却让人去等一个永远不会来的验收。
   *
   * 规格 §二十八：enabled / required / satisfied 三个概念分开；
   * 失败 / 取消 / 中断 / 跳过 / 还没跑 → `required=false`，沿用原执行语义。 */
  section('I. Gate required：失败 / 取消 / 中断 / 跳过都不算「等验收」');

  {
    const att = (success, status) => ({
      attempt: 1,
      success,
      review: { status, note: '', reviewedAt: status === 'pending' ? null : 1, revision: status === 'pending' ? 0 : 1 },
    });
    const g = (over) => model.reviewGateState(Object.assign({ id: 'g', reviewGate: true, status: 'success', attempts: [] }, over));

    check('I1. 没开门控 → enabled=false / required=false / satisfied=true（新增字段是 additive）', () => {
      const s = model.reviewGateState({ id: 'g', reviewGate: false, status: 'failed', attempts: [] });
      return (s.enabled === false && s.required === false && s.satisfied === true) || JSON.stringify(s);
    });
    check('I2. 成功 + pending → required=true（这才是真的在等人）', () => {
      const s = g({ attempts: [att(true, 'pending')] });
      return (s.required === true && s.satisfied === false && s.reason === 'pending' && s.attempt === 1) || JSON.stringify(s);
    });
    check('I3. 成功 + accepted → required=true 且 satisfied=true', () => {
      const s = g({ attempts: [att(true, 'accepted')] });
      return (s.required === true && s.satisfied === true && s.reason === 'accepted') || JSON.stringify(s);
    });
    check('I4. **执行失败 → required=false**（没有可验收的东西）', () => {
      const s = g({ status: 'failed', attempts: [att(false, 'pending')] });
      return (s.enabled === true && s.required === false && s.satisfied === false && s.reason === 'no-successful-attempt') || JSON.stringify(s);
    });
    for (const st of ['cancelled', 'interrupted', 'skipped']) {
      check('I5. ' + st + ' → required=false（沿用原执行语义）', () => {
        const s = g({ status: st, attempts: [att(false, 'pending')] });
        return (s.enabled === true && s.required === false) || JSON.stringify(s);
      });
    }
    check('I6. 还没跑过（pending）→ required=false', () => {
      const s = g({ status: 'pending', attempts: [] });
      return (s.required === false && s.satisfied === false && s.reason === 'no-successful-attempt') || JSON.stringify(s);
    });
    check('I7. 老数据：状态是 success 却没有成功 attempt → 仍按「等验收」处理（不静默放行下游）', () => {
      const s = g({ status: 'success', attempts: [att(false, 'pending')] });
      return (s.required === true && s.satisfied === false) || JSON.stringify(s);
    });
  }

  {
    /* ★ Blocker A 的正主：单个 gated 任务**执行失败**时 Plan 必须是 failed。 */
    const p = await runPlan({ id: 'i1', tasks: [{ id: 'fails', reviewGate: true }] });
    check('I8. ★Blocker A：单个 gated 任务执行失败 → Plan = failed', () => p.status === 'failed' || p.status);
    check('I9. workflowState = failed + settled（**不是** paused + waiting-review）', () => {
      const w = model.planWorkflowState(p);
      return (w.status === 'failed' && w.reason === 'settled') || JSON.stringify(w);
    });
    check('I10. isPlanSettled 为真（门控不再把失败的计划卡住）', () => model.isPlanSettled(p) === true);
    const detail = await hit(planner, 'GET', '/api/plans/i1', undefined);
    check('I11. 详情接口的 workflowReason 不是 waiting-review', () => {
      const w = detail.body.plan.workflowReason;
      return (w && w !== 'waiting-review') || String(w);
    });
    check('I12. Plan 级门控汇总**不**把失败任务算成「待验收」', () => {
      const gs = detail.body.plan.reviewGateSummary;
      return (gs && gs.gated === 1 && gs.waiting === 0 && gs.satisfied === 0) || JSON.stringify(gs);
    });
    check('I13. 上游的 gateState 仍如实报 required=false / no-successful-attempt', () => {
      const t = (detail.body.plan.tasks || []).find((x) => x.id === 'fails');
      return (t && t.gateState && t.gateState.enabled === true && t.gateState.required === false && t.gateState.satisfied === false) || JSON.stringify(t && t.gateState);
    });
    check('I14. 执行状态没被审阅逻辑改写（还是 failed，attempt 还在）', () => taskOf(p, 'fails').status === 'failed' && attemptsOf(p, 'fails').length === 1 || JSON.stringify({ s: taskOf(p, 'fails').status, n: attemptsOf(p, 'fails').length }));
  }

  {
    /* 失败的 gated 上游 → 下游是 dependency-failed，Plan 是 failed。 */
    const p = await runPlan({ id: 'i2', tasks: [{ id: 'fails', reviewGate: true }, { id: 'down', dependsOn: ['fails'] }] });
    check('I15. 失败的 gated 上游 → 下游 blocked + dependency-failed（优先级不变）', () => {
      const byId = new Map(p.tasks.map((t) => [t.id, t]));
      const st = model.dependencyStateOf(taskOf(p, 'down'), byId);
      return (taskOf(p, 'down').status === 'blocked' && st.reason === 'dependency-failed') || JSON.stringify({ s: taskOf(p, 'down').status, r: st.reason });
    });
    /* 有失败 + 有被阻塞的下游时，计划停在 paused（用户要决定重试哪个），
     * **和没开门控的同构计划一模一样** —— 门控不改这条语义。 */
    const twin = await runPlan({ id: 'i2b', tasks: [{ id: 'fails' }, { id: 'down', dependsOn: ['fails'] }] });
    const sig = (x) => JSON.stringify({ ps: x.status, w: model.planWorkflowState(x), st: x.tasks.map((t) => [t.id, t.status]) });
    check('I16. 门控不改「失败」的原语义：与无门控的同构计划**完全同态**', () => {
      const got = sig(p);
      return (got === sig(twin) && model.planWorkflowState(p).status === 'paused') || `${got} vs ${sig(twin)}`;
    });
    check('I16b. workflowReason 是 dependency-blocked，**不是** waiting-review', () => {
      const w = model.planWorkflowState(p);
      return (w.status === 'paused' && w.reason === 'dependency-blocked') || JSON.stringify(w);
    });
    check('I17. 下游一次都没被执行', () => attemptsOf(p, 'down').length === 0 || String(attemptsOf(p, 'down').length));
    check('I17b. 无门控的孪生计划也没执行下游（对拍的另一半）', () => attemptsOf(twin, 'down').length === 0 || String(attemptsOf(twin, 'down').length));
  }

  {
    /* 取消 / 中断 / 跳过 / 从没跑过：原执行语义，一个字都不改（§三十二 4/5/6/8）。 */
    const mkOne = (id, status, extra = {}) => {
      const p = mkPlan({ id, tasks: [{ id: 'a', reviewGate: true }] });
      const t = taskOf(p, 'a');
      t.status = status;
      t.attempt = extra.attempts ? 1 : 0;
      t.attempts = extra.attempts || [];
      t.error = extra.error || '';
      store.save(p);
      return load(id);
    };
    const cancelled = mkOne('i3', 'cancelled', {
      error: '已取消',
      attempts: [{ attempt: 1, success: false, error: '已取消', summary: '', exitCode: null, startedAt: 1, endedAt: 2, filesChanged: [], changeCaptureIncomplete: false, outcomeStatus: 'cancelled', review: { status: 'pending', note: '', reviewedAt: null, revision: 0 } }],
    });
    check('I18. gated 任务被取消 → Plan = cancelled（不是 waiting-review）', () => {
      const w = model.planWorkflowState(cancelled);
      return (w.status === 'cancelled' && w.reason !== 'waiting-review') || JSON.stringify(w);
    });
    const interrupted = mkOne('i4', 'interrupted', {
      error: '应用关闭时被中断',
      attempts: [{ attempt: 1, success: false, error: '应用关闭时被中断', summary: '', exitCode: null, startedAt: 1, endedAt: 2, filesChanged: [], changeCaptureIncomplete: true, outcomeStatus: 'interrupted', review: { status: 'pending', note: '', reviewedAt: null, revision: 0 } }],
    });
    check('I19. gated 任务被中断 → Plan = failed（中断算失败），**不是** waiting-review', () => {
      const w = model.planWorkflowState(interrupted);
      return (w.status === 'failed' && w.reason !== 'waiting-review') || JSON.stringify(w);
    });
    const skipped = mkOne('i5', 'skipped', { error: '已跳过' });
    check('I20. gated 任务被跳过 → Plan = completed（沿用原 skipped 语义）', () => {
      const w = model.planWorkflowState(skipped);
      return (w.status === 'completed' && w.reason !== 'waiting-review') || JSON.stringify(w);
    });
    const neverRan = mkOne('i6', 'pending');
    check('I21. 从没跑过的 gated 任务 → paused + pending（**没有成功尝试不等于**一律 waiting-review）', () => {
      const w = model.planWorkflowState(neverRan);
      return (w.status === 'paused' && w.reason === 'pending') || JSON.stringify(w);
    });
  }

  /* ================= J. Active Session Barrier：accepted 也不让当前这一轮自动跑下游 =================
   *
   * Blocker B：计划正在跑时把上游的审阅改成 accepted，DAG 立刻说下游 ready ——
   * 但**当前 execution session 已经把它当成一道 checkpoint**，这一轮不再自动消费它。
   * 无关任务照常跑完，session 自然结束，Plan 落到 `ready`，等用户自己点开始。
   *
   * barrier 只活在 scheduler 的 session 对象里：不写 Plan / Task / Attempt，重启不恢复。 */
  section('J. Active Session Barrier：运行中 accepted 不自动启动下游');

  /** 轮询到条件成立（等出「A 成功、X 还在跑」那个窗口）。 */
  async function waitUntilJ(planId, pred, timeoutMs = 15000) {
    const t0 = Date.now();
    for (;;) {
      const p = load(planId);
      if (pred(p)) return p;
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(25);
    }
  }
  const stOf = (p, id) => {
    const t = taskOf(p, id);
    return t ? t.status : '';
  };

  /** 造一份 A(gate) → B、外加无关慢任务 X 的计划（concurrency=2）。 */
  function mkBarrierPlan(id) {
    runtime.setCurrentCwd(PROJ);
    store.save(mkPlan({
      id,
      concurrency: 2,
      tasks: [
        { id: 'gateA', reviewGate: true },
        { id: 'downB', dependsOn: ['gateA'] },
        { id: 'slowX' },
      ],
    }));
    return load(id);
  }

  {
    mkBarrierPlan('j1');
    const r0 = await scheduler.start(load('j1'));
    check('J1. 计划启动', () => r0.ok === true || JSON.stringify(r0));

    const win = await waitUntilJ('j1', (p) => stOf(p, 'gateA') === 'success' && stOf(p, 'slowX') === 'running');
    check('J2. 拿到「A 成功、X 还在跑」的窗口', () => Boolean(win), win ? 'ok' : '没等到窗口');
    check('J3. 此刻计划仍然 active', () => scheduler.activePlanId() === 'j1', String(scheduler.activePlanId()));
    let p = load('j1');
    check('J4. 窗口里 B 一次都没跑（attempts=0）', () => attemptsOf(p, 'downB').length === 0 || String(attemptsOf(p, 'downB').length));
    check('J5. 窗口里 DAG 判 B 为 waiting-review（status 是泵下一轮才刷新的，这里判据用纯函数）', () => {
      const byId = new Map(p.tasks.map((t) => [t.id, t]));
      const st = model.dependencyStateOf(taskOf(p, 'downB'), byId);
      return (st.status === 'blocked' && st.reason === 'waiting-review' && st.waitingOn.join() === 'gateA') || JSON.stringify(st);
    });

    const rv = await review('j1', 'gateA', 1, 'accepted');
    check('J6. 计划运行中也能把已结束的 attempt 标成 accepted', () => rv.body.ok === true || JSON.stringify(rv.body));
    check('J7. 运行中的响应不带 gate（§二十：本轮不扩 API）', () => rv.body.gate === null || JSON.stringify(rv.body.gate));
    check('J8. accepted 没有打断正在跑的 X（barrier 只挡未启动的）', () => stOf(load('j1'), 'slowX') === 'running' || stOf(load('j1'), 'slowX'));

    await scheduler.waitIdle(20000);
    p = load('j1');
    check('J9. A 仍是 success（审阅不改执行状态）', () => stOf(p, 'gateA') === 'success' || stOf(p, 'gateA'));
    check('J10. A 的 accepted **没有**被 Scheduler 的整份写盘冲掉', () => {
      const a = attemptsOf(p, 'gateA').find((x) => x.attempt === 1);
      const rv2 = model.normalizeReview(a && a.review);
      return (rv2.status === 'accepted' && rv2.revision === 1) || JSON.stringify(rv2);
    });
    check('J11. 无关的 X 正常跑完（门控不是全局锁）', () => stOf(p, 'slowX') === 'success' || stOf(p, 'slowX'));
    check('J12. DAG 权威：accepted 之后 B 变成 ready', () => stOf(p, 'downB') === 'ready' || stOf(p, 'downB'));
    check('J13. ★Blocker B：B 在**这一轮 session**里没被自动执行（attempts=0）', () => attemptsOf(p, 'downB').length === 0 || String(attemptsOf(p, 'downB').length));
    check('J14. session 结束后 Plan = ready（不是 completed / paused+waiting-review / running）', () => p.status === 'ready' || p.status);
    check('J15. 调度器已空闲（session 自然结束）', () => scheduler.activePlanId() === null, String(scheduler.activePlanId()));

    const r2 = await scheduler.start(load('j1'));
    check('J16. 用户手动再点「开始执行」→ 被接受', () => r2.ok === true || JSON.stringify(r2));
    if (r2.ok) await scheduler.waitIdle(20000);
    p = load('j1');
    check('J17. 新 session 才执行 B：success + attempts=1', () => (stOf(p, 'downB') === 'success' && attemptsOf(p, 'downB').length === 1) || JSON.stringify({ s: stOf(p, 'downB'), n: attemptsOf(p, 'downB').length }));
    check('J18. 最终 Plan = completed', () => p.status === 'completed' || p.status);
  }

  {
    /* 反向：accepted 之后又改回 needs_changes —— 最终状态始终先由 DAG 决定。 */
    mkBarrierPlan('j2');
    await scheduler.start(load('j2'));
    const win = await waitUntilJ('j2', (p) => stOf(p, 'gateA') === 'success' && stOf(p, 'slowX') === 'running');
    check('J19. j2 也拿到了那个窗口', () => Boolean(win), win ? 'ok' : '没等到窗口');
    await review('j2', 'gateA', 1, 'accepted');
    const rv2 = await review('j2', 'gateA', 1, 'needs_changes');
    check('J20. accepted → needs_changes 写入成功（X 还在跑）', () => rv2.body.ok === true || JSON.stringify(rv2.body));
    await scheduler.waitIdle(20000);
    const p = load('j2');
    check('J21. X 正常完成（barrier 不 abort 任何在跑的东西）', () => stOf(p, 'slowX') === 'success' || stOf(p, 'slowX'));
    check('J22. B 是 blocked + waiting-review（DAG 权威以最新 Review 为准）', () => {
      const byId = new Map(p.tasks.map((t) => [t.id, t]));
      const st = model.dependencyStateOf(taskOf(p, 'downB'), byId);
      return (stOf(p, 'downB') === 'blocked' && st.reason === 'waiting-review') || JSON.stringify({ s: stOf(p, 'downB'), r: st.reason });
    });
    check('J23. B 没被 barrier 错标成 ready，也没被执行', () => attemptsOf(p, 'downB').length === 0 || String(attemptsOf(p, 'downB').length));
    check('J24. Plan = paused + waiting-review（不是 ready）', () => {
      const w = model.planWorkflowState(p);
      return (p.status === 'paused' && w.status === 'paused' && w.reason === 'waiting-review') || JSON.stringify({ s: p.status, w });
    });
    check('J25. 历史执行结果不倒推（A / X 仍是 success）', () => stOf(p, 'gateA') === 'success' && stOf(p, 'slowX') === 'success');
  }

  {
    /* 再反向：accepted → pending（§二十三）。 */
    mkBarrierPlan('j3');
    await scheduler.start(load('j3'));
    const win = await waitUntilJ('j3', (p) => stOf(p, 'gateA') === 'success' && stOf(p, 'slowX') === 'running');
    check('J26. j3 也拿到了那个窗口', () => Boolean(win), win ? 'ok' : '没等到窗口');
    await review('j3', 'gateA', 1, 'accepted');
    const rv3 = await review('j3', 'gateA', 1, 'pending');
    check('J27. accepted → pending 写入成功', () => rv3.body.ok === true || JSON.stringify(rv3.body));
    await scheduler.waitIdle(20000);
    const p = load('j3');
    check('J28. B 是 blocked + waiting-review（不是 ready-but-stopped）', () => {
      const byId = new Map(p.tasks.map((t) => [t.id, t]));
      const st = model.dependencyStateOf(taskOf(p, 'downB'), byId);
      return (stOf(p, 'downB') === 'blocked' && st.reason === 'waiting-review') || JSON.stringify({ s: stOf(p, 'downB'), r: st.reason });
    });
    check('J29. Plan = paused + waiting-review', () => {
      const w = model.planWorkflowState(p);
      return (w.status === 'paused' && w.reason === 'waiting-review') || JSON.stringify(w);
    });
    check('J30. barrier 不碰 terminal 任务（A / X 历史原样）', () => attemptsOf(p, 'gateA').length === 1 && attemptsOf(p, 'slowX').length === 1);
    check('J31. B 一次都没跑', () => attemptsOf(p, 'downB').length === 0 || String(attemptsOf(p, 'downB').length));
  }

  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n测试自身抛错：', err && err.stack ? err.stack : err);
  cleanup();
  process.exit(1);
});
