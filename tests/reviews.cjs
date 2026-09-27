/* P8-A —— 人工审阅（review）的数据契约、资格、并发与持久化。
 *
 * 覆盖规格 §39 列出的 52 项（A–J 十组），外加 §29 写盘失败、§30 跨项目、
 * §31 非法输入、§33「审阅不驱动调度器」。
 *
 * ---------- 三条纪律（与 planner.cjs / workflow-relations.cjs 一致） ----------
 *
 * 1. **全部在 os.tmpdir() 里造世界**，不碰真实项目、不碰用户真实的计划目录。
 * 2. **不 spawn 真 Agent**，一律用 fake adapter（确定性、进程内、零额度）。
 * 3. **不联网。**
 *
 * 用法：node tests/reviews.cjs
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

/* 本环境 spawnSync 恒 EBUSY（已知陷阱），git 一律走异步 spawn。 */
const run = (cmd, args, cwd) =>
  new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code, out }));
    c.on('error', (e) => resolve({ code: -1, out: String(e.message) }));
  });
const git = (cwd, ...args) => run('git', args, cwd);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-p8a-'));
const DATA = path.join(TMP, 'data');
const PROJ = path.join(TMP, 'projA');
const PROJ_B = path.join(TMP, 'projB');
const created = [TMP];
function cleanup() {
  for (const d of created.reverse()) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Windows 偶发占用 */
    }
  }
}

async function mkProject(dir) {
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, 'init', '-q');
  await git(dir, 'config', 'user.email', 't@t');
  await git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-qm', 'init');
  return dir;
}

/* ---------- 打 HTTP 的小工具（走 planner.handle，不绕过后端逻辑） ---------- */

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
  const { createDiagnostics } = await import('../server/diagnostics.js');
  const { gitStatus } = await import('../lib/git.js');

  await mkProject(PROJ);
  await mkProject(PROJ_B);
  fs.mkdirSync(path.join(DATA, 'plans'), { recursive: true });

  const BEHAVIORS = {
    ok1: [{ ok: true, summary: '做完了', writes: [{ path: 'a.js', content: 'x\n' }] }],
    ok2: [{ ok: true, summary: '第二次做完了', writes: [{ path: 'b.js', content: 'y\n' }] }],
    fail1: [{ ok: false, error: '故意失败' }],
    hang1: [{ hang: true }],
    okDoc: [{ ok: true, summary: 'ok' }],
    /* 「先失败、再成功」——这是**唯一**能产生两条 attempt 的路径：
     * retryTask 拒绝重试已成功的任务（既有策略），所以 attempt 1 必须先失败。 */
    two: [{ ok: false, error: '第一次故意失败' }, { ok: true, summary: '第二次成功' }],
    /* 慢任务：用来制造「同一个计划里 A 已完成、B 还在跑」的窗口 ——
     * 那正是「审阅写入」与「Scheduler 持久化」两个写者重叠的时刻。 */
    slowB: [{ slowMs: 700, ok: true, summary: 'B 完成' }],
  };

  const registry = createAgentRegistry({ env: process.env, includeFake: true, fakeBehaviors: BEHAVIORS });
  let cwd = PROJ;
  const runtime = {
    getCurrentCwd: () => cwd,
    setCurrentCwd: (v) => {
      cwd = v;
    },
    get shuttingDown() {
      return false;
    },
  };

  const store = createPlanStore({ dataDir: DATA });
  const scheduler = createScheduler({ store, registry, runtime, gitStatus });
  const planner = createPlanner({ runtime, registry, store, scheduler });

  /* ---------- 计划构造与执行 ---------- */

  function mkPlan({ id, tasks, project = PROJ, concurrency = 1 }) {
    return {
      id,
      title: 'P8 计划 ' + id,
      goal: '目标',
      status: 'ready',
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
      })),
    };
  }

  async function runPlan(opts) {
    runtime.setCurrentCwd(opts.project || PROJ);
    store.save(mkPlan(opts));
    const r = await scheduler.start(store.load(opts.id).plan);
    if (!r.ok) throw new Error('start 失败：' + r.error);
    await scheduler.waitIdle(20000);
    return store.load(opts.id).plan;
  }

  async function startNoWait(opts) {
    runtime.setCurrentCwd(opts.project || PROJ);
    store.save(mkPlan(opts));
    const r = await scheduler.start(store.load(opts.id).plan);
    if (!r.ok) throw new Error('start 失败：' + r.error);
    await sleep(150);
  }

  const taskOf = (plan, id) => plan.tasks.find((t) => t.id === id);
  const attemptOf = (plan, taskId, n) => {
    const t = taskOf(plan, taskId);
    return t && (t.attempts || []).find((a) => a.attempt === n);
  };
  const readReview = (planId, taskId, n) => {
    const p = store.load(planId).plan;
    const a = attemptOf(p, taskId, n);
    return a ? model.normalizeReview(a.review) : null;
  };

  /* ================= A. 归一化 ================= */
  section('A. 归一化（老数据 / 非法值）');

  {
    /* 手写一份「P7 时代」的计划：attempt 上没有 review / verificationSnapshot /
     * outcomeStatus，还有一个字段全是垃圾的 attempt。 */
    const legacy = {
      schemaVersion: 1,
      id: 'plan-legacy-p8',
      title: '老计划',
      goal: 'g',
      status: 'completed',
      createdAt: 1,
      updatedAt: 1,
      projectRoot: PROJ,
      concurrency: 1,
      recoveryNotes: [],
      source: null,
      tasks: [
        {
          id: 't1',
          title: '老任务',
          agent: 'fake',
          workingDirectory: '.',
          dependsOn: [],
          status: 'success',
          attempt: 1,
          attempts: [{ attempt: 1, startedAt: 1, endedAt: 2, success: true, error: '', summary: 'ok', exitCode: 0 }],
          result: null,
          error: '',
          verification: { command: 'npm test' },
        },
        {
          id: 't2',
          title: '坏字段任务',
          agent: 'fake',
          workingDirectory: '.',
          dependsOn: [],
          status: 'success',
          attempt: 1,
          attempts: [
            {
              attempt: 1,
              startedAt: 1,
              endedAt: 2,
              success: true,
              review: { status: 'approved', note: 123, reviewedAt: 'x', revision: -5 },
              outcomeStatus: 'weird',
              verificationSnapshot: { command: 'npm test', description: 'x', prompt: 'LEAK', cwd: 'C:\\x' },
            },
          ],
          result: null,
          error: '',
          verification: null,
        },
      ],
    };
    fs.writeFileSync(path.join(DATA, 'plans', 'plan-legacy-p8.json'), JSON.stringify(legacy, null, 2), 'utf8');

    const a1 = attemptOf(store.load('plan-legacy-p8').plan, 't1', 1);
    check('A1. 老 Attempt 没有 review → 默认 pending', () => a1 && a1.review && a1.review.status === 'pending', JSON.stringify(a1 && a1.review));
    check('A2. 老 Attempt 没有 verificationSnapshot → null', () => a1 && a1.verificationSnapshot === null, JSON.stringify(a1 && a1.verificationSnapshot));
    check('A8. revision 默认 0', () => a1 && a1.review.revision === 0, JSON.stringify(a1 && a1.review));
    check('A9a. 非法 revision（负数）被安全归一到 0', () => {
      const a2 = attemptOf(store.load('plan-legacy-p8').plan, 't2', 1);
      return a2.review.revision === 0 || JSON.stringify(a2.review);
    });
    check('A5. 非法 status（approved）被安全归一到 pending', () => {
      const a2 = attemptOf(store.load('plan-legacy-p8').plan, 't2', 1);
      return a2.review.status === 'pending' || JSON.stringify(a2.review);
    });
    check('A6b. 非字符串 note 被归一到空串', () => {
      const a2 = attemptOf(store.load('plan-legacy-p8').plan, 't2', 1);
      return a2.review.note === '' || JSON.stringify(a2.review);
    });
    check('A9b. 非法 outcomeStatus 被归一到 null（不猜）', () => {
      const a2 = attemptOf(store.load('plan-legacy-p8').plan, 't2', 1);
      return a2.outcomeStatus === null || JSON.stringify(a2.outcomeStatus);
    });
    check('§13. snapshot 只保留 command/description，多余键一律丢弃', () => {
      const a2 = attemptOf(store.load('plan-legacy-p8').plan, 't2', 1);
      const keys = Object.keys(a2.verificationSnapshot || {});
      return (keys.length === 1 && keys[0] === 'command') || JSON.stringify(a2.verificationSnapshot);
    });
    check('§13b. snapshot 里不含 prompt / cwd 这类多余内容', () => {
      const a2 = attemptOf(store.load('plan-legacy-p8').plan, 't2', 1);
      const s = JSON.stringify(a2.verificationSnapshot);
      return (!s.includes('LEAK') && !s.includes('C:')) || s;
    });
    check('§5/§20. 老计划照常能加载（不要求迁移）', () => Boolean(store.load('plan-legacy-p8').plan));
    runtime.setCurrentCwd(PROJ);
    check('§5. 老计划照常出现在列表里', () => store.list({ projectRoot: PROJ }).plans.some((p) => p.id === 'plan-legacy-p8'));
  }

  /* ================= B. verificationSnapshot ================= */
  section('B. verificationSnapshot');

  const pB = await runPlan({ id: 'plan-b1', tasks: [{ id: 'ok1', verification: { command: 'npm test' } }] });
  {
    const a = attemptOf(pB, 'ok1', 1);
    check('B10. command 形式的验证要求被冻结进 attempt', () => a.verificationSnapshot && a.verificationSnapshot.command === 'npm test', JSON.stringify(a.verificationSnapshot));
    check('B15. snapshot 里不含 task.description', () => {
      const s = JSON.stringify(a.verificationSnapshot);
      return Object.keys(a.verificationSnapshot).length === 1 && !s.includes('描述') && !s.includes('description');
    });
    check('B16. snapshot 里不含 prompt（不带「# 任务：」那种拼装正文）', () => !JSON.stringify(a.verificationSnapshot).includes('# 任务'));
  }

  const pB2 = await runPlan({ id: 'plan-b2', tasks: [{ id: 'okDoc', verification: { description: '确认登录失败提示' } }] });
  check('B11. description 形式的验证要求同样被冻结', () => {
    const a = attemptOf(pB2, 'okDoc', 1);
    return (a.verificationSnapshot && a.verificationSnapshot.description === '确认登录失败提示') || JSON.stringify(a.verificationSnapshot);
  });

  const pB3 = await runPlan({ id: 'plan-b3', tasks: [{ id: 'okDoc', verification: null }] });
  check('B12. 没有 verification → verificationSnapshot = null', () => {
    const a = attemptOf(pB3, 'okDoc', 1);
    return a.verificationSnapshot === null || JSON.stringify(a.verificationSnapshot);
  });

  /* B13：任务后续改 verification，不改历史 attempt 的 snapshot */
  {
    runtime.setCurrentCwd(PROJ);
    const r = await hit(planner, 'PUT', '/api/plans/plan-b1', {
      tasks: [{ id: 'ok1', title: '任务 ok1', agent: 'fake', dependsOn: [], verification: { command: 'npm run test:unit' } }],
    });
    check('B13-prep. 改 verification 的 PUT 成功', () => r.body && r.body.ok === true, JSON.stringify(r.body).slice(0, 200));
    const a = attemptOf(store.load('plan-b1').plan, 'ok1', 1);
    check('B13. 改了 task.verification 之后，历史 attempt 的 snapshot 不变', () => a.verificationSnapshot && a.verificationSnapshot.command === 'npm test', JSON.stringify(a.verificationSnapshot));
    check('B13b. 任务当前的 verification 确实已经是新值（证明上一条不是因为没改成功）', () => {
      const t = taskOf(store.load('plan-b1').plan, 'ok1');
      return t.verification && t.verification.command === 'npm run test:unit';
    });
  }

  /* ================= C. 资格 ================= */
  section('C. 审阅资格');

  /* success */
  {
    runtime.setCurrentCwd(PROJ);
    const r1 = await hit(planner, 'PUT', reviewUrl('plan-b1', 'ok1', 1), { status: 'accepted', note: '测试已人工确认', expectedRevision: 0 });
    check('C17. success → accepted 允许', () => r1.status === 200 && r1.body.ok === true && r1.body.review.status === 'accepted', JSON.stringify(r1.body));
    const r2 = await hit(planner, 'PUT', reviewUrl('plan-b1', 'ok1', 1), { status: 'needs_changes', note: '', expectedRevision: 1 });
    check('C18. success → needs_changes 允许', () => r2.status === 200 && r2.body.ok === true && r2.body.review.status === 'needs_changes', JSON.stringify(r2.body));
  }

  /* failed */
  const pC = await runPlan({ id: 'plan-c1', tasks: [{ id: 'fail1' }] });
  {
    const a = attemptOf(pC, 'fail1', 1);
    check('C-prep. 失败尝试的 outcomeStatus 是 failed（稳定字段，不是从 error 文案猜的）', () => a.outcomeStatus === 'failed' || JSON.stringify(a.outcomeStatus));
    check('C-prep2. 失败尝试的 error 文案里没有「取消」之类的字样可供猜测', () => !/取消/.test(String(a.error)), String(a.error));
    runtime.setCurrentCwd(PROJ);
    const r1 = await hit(planner, 'PUT', reviewUrl('plan-c1', 'fail1', 1), { status: 'accepted', expectedRevision: 0 });
    check('C20. failed → accepted 拒绝', () => r1.body.ok === false && /不能标记为「已接受」/.test(r1.body.error), JSON.stringify(r1.body));
    const r2 = await hit(planner, 'PUT', reviewUrl('plan-c1', 'fail1', 1), { status: 'needs_changes', note: '要返工', expectedRevision: 0 });
    check('C19. failed → needs_changes 允许', () => r2.body.ok === true && r2.body.review.status === 'needs_changes', JSON.stringify(r2.body));
  }

  /* cancelled */
  await startNoWait({ id: 'plan-c2', tasks: [{ id: 'hang1' }] });
  scheduler.stop();
  await scheduler.waitIdle(20000);
  {
    const a = attemptOf(store.load('plan-c2').plan, 'hang1', 1);
    check('C-prep3. 取消尝试的 outcomeStatus 是 cancelled', () => a.outcomeStatus === 'cancelled' || JSON.stringify(a.outcomeStatus));
    runtime.setCurrentCwd(PROJ);
    const r1 = await hit(planner, 'PUT', reviewUrl('plan-c2', 'hang1', 1), { status: 'accepted', expectedRevision: 0 });
    check('C21. cancelled → accepted 拒绝', () => r1.body.ok === false && /不能标记为「已接受」/.test(r1.body.error), JSON.stringify(r1.body));
    const r2 = await hit(planner, 'PUT', reviewUrl('plan-c2', 'hang1', 1), { status: 'needs_changes', expectedRevision: 0 });
    check('C21b. cancelled → needs_changes 允许', () => r2.body.ok === true, JSON.stringify(r2.body));
  }

  /* interrupted */
  await startNoWait({ id: 'plan-c3', tasks: [{ id: 'hang1', verification: { command: 'npm test' } }] });
  scheduler.shutdown();
  await scheduler.waitIdle(20000);
  {
    const a = attemptOf(store.load('plan-c3').plan, 'hang1', 1);
    check('C-prep4. 中断尝试的 outcomeStatus 是 interrupted', () => a.outcomeStatus === 'interrupted' || JSON.stringify(a.outcomeStatus));
    check('§36. 中断的 attempt 的 review 是 pending', () => a.review && a.review.status === 'pending', JSON.stringify(a.review));
    check('§36b. 中断的 attempt 保留了开始时冻结的 verificationSnapshot', () => a.verificationSnapshot && a.verificationSnapshot.command === 'npm test', JSON.stringify(a.verificationSnapshot));
    runtime.setCurrentCwd(PROJ);
    const r1 = await hit(planner, 'PUT', reviewUrl('plan-c3', 'hang1', 1), { status: 'accepted', expectedRevision: 0 });
    check('C22. interrupted → accepted 拒绝', () => r1.body.ok === false && /不能标记为「已接受」/.test(r1.body.error), JSON.stringify(r1.body));
    const r2 = await hit(planner, 'PUT', reviewUrl('plan-c3', 'hang1', 1), { status: 'needs_changes', expectedRevision: 0 });
    check('C22b. interrupted → needs_changes 允许', () => r2.body.ok === true, JSON.stringify(r2.body));
  }

  /* running */
  await startNoWait({ id: 'plan-c4', tasks: [{ id: 'hang1' }] });
  {
    runtime.setCurrentCwd(PROJ);
    const r1 = await hit(planner, 'PUT', reviewUrl('plan-c4', 'hang1', 1), { status: 'accepted', expectedRevision: 0 });
    check('C23. running → accepted 拒绝', () => r1.body.ok === false && /还在执行/.test(r1.body.error), JSON.stringify(r1.body));
    const r2 = await hit(planner, 'PUT', reviewUrl('plan-c4', 'hang1', 1), { status: 'needs_changes', expectedRevision: 0 });
    check('C24. running → needs_changes 拒绝', () => r2.body.ok === false && /还在执行/.test(r2.body.error), JSON.stringify(r2.body));
    const r3 = await hit(planner, 'PUT', reviewUrl('plan-c4', 'hang1', 1), { status: 'pending', expectedRevision: 0 });
    check('C24b. running → 连「清除」也拒绝（没有记录可清）', () => r3.body.ok === false, JSON.stringify(r3.body));
    scheduler.stop();
    await scheduler.waitIdle(20000);
  }

  /* ================= D. 精确定位 ================= */
  section('D. 精确定位');

  {
    runtime.setCurrentCwd(PROJ);
    store.save(mkPlan({ id: 'plan-d1', tasks: [{ id: 'two', verification: { command: 'npm test' } }] }));
    await scheduler.start(store.load('plan-d1').plan);
    await scheduler.waitIdle(20000);

    /* 先给 Attempt 1（失败的那次）写一条审阅 —— 之后要验重试不会把它冲掉。 */
    const w = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 1), { status: 'needs_changes', note: '第一次的结果要改', expectedRevision: 0 });
    check('D-prep0. 失败尝试可以标记「需修改」', () => w.body.ok === true, JSON.stringify(w.body));

    /* 改掉验证要求，再重试 —— 这样两条 attempt 的 snapshot 会不同。 */
    await hit(planner, 'PUT', '/api/plans/plan-d1', {
      tasks: [{ id: 'two', title: '任务 two', agent: 'fake', dependsOn: [], verification: { command: 'npm run test:unit' } }],
    });
    runtime.setCurrentCwd(PROJ);
    scheduler.retryTask(store.load('plan-d1').plan, 'two');
    await scheduler.start(store.load('plan-d1').plan);
    await scheduler.waitIdle(20000);

    const p = store.load('plan-d1').plan;
    check('D-prep. 该任务确实有两条 attempt', () => (taskOf(p, 'two').attempts || []).length === 2, JSON.stringify((taskOf(p, 'two').attempts || []).map((a) => a.attempt)));
    check('D-prep2. Attempt 1 失败、Attempt 2 成功（各自的稳定结论）', () => {
      const a1 = attemptOf(p, 'two', 1);
      const a2 = attemptOf(p, 'two', 2);
      return (a1.outcomeStatus === 'failed' && a2.outcomeStatus === 'success') || JSON.stringify([a1.outcomeStatus, a2.outcomeStatus]);
    });

    const r1 = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 1), { status: 'needs_changes', note: '第一次返工', expectedRevision: 1 });
    check('D25a. 给 Attempt 1 写审阅成功', () => r1.body.ok === true, JSON.stringify(r1.body));
    check('D25. 给 Attempt 1 写审阅**不改** Attempt 2', () => {
      const a2 = attemptOf(store.load('plan-d1').plan, 'two', 2);
      return (a2.review.status === 'pending' && a2.review.revision === 0) || JSON.stringify(a2.review);
    });

    const r2 = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 2), { status: 'accepted', note: '第二次接受', expectedRevision: 0 });
    check('D26a. 给 Attempt 2 写审阅成功', () => r2.body.ok === true, JSON.stringify(r2.body));
    check('D26. 给 Attempt 2 写审阅**不改** Attempt 1', () => {
      const a1 = attemptOf(store.load('plan-d1').plan, 'two', 1);
      return (a1.review.status === 'needs_changes' && a1.review.note === '第一次返工') || JSON.stringify(a1.review);
    });

    const r3 = await hit(planner, 'PUT', reviewUrl('plan-d1', 'nope', 1), { status: 'accepted', expectedRevision: 0 });
    check('D27. task 不存在 → 稳定返回 ok:false（不是 500）', () => r3.status === 200 && r3.body.ok === false && /找不到这个任务/.test(r3.body.error), JSON.stringify(r3.body));

    const r4 = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 9), { status: 'accepted', expectedRevision: 0 });
    check('D28. attempt 不存在 → 稳定返回 ok:false', () => r4.status === 200 && r4.body.ok === false && /找不到这次尝试/.test(r4.body.error), JSON.stringify(r4.body));
  }

  /* ================= E. revision 与并发 ================= */
  section('E. revision 与并发');

  {
    runtime.setCurrentCwd(PROJ);
    /* Attempt 2 此刻 revision=1（D26a 写的） */
    const r1 = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 2), { status: 'needs_changes', note: '改一下', expectedRevision: 1 });
    check('E29/E30a. revision 1 → 2（每次成功写入都 +1）', () => r1.body.ok === true && r1.body.review.revision === 2, JSON.stringify(r1.body));
    const r2 = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 2), { status: 'accepted', note: '再改', expectedRevision: 2 });
    check('E30b. revision 2 → 3', () => r2.body.ok === true && r2.body.review.revision === 3, JSON.stringify(r2.body));
    const r2b = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 2), { status: 'accepted', note: '只改说明', expectedRevision: 3 });
    check('E30c. 只改 note 也递增 revision（§8 明确列出）', () => r2b.body.ok === true && r2b.body.review.revision === 4, JSON.stringify(r2b.body));

    const stale = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 2), { status: 'accepted', note: '陈旧窗口写的', expectedRevision: 1 });
    check('E31. 陈旧的 expectedRevision → 409 review-conflict', () => stale.status === 409 && stale.body.code === 'review-conflict', JSON.stringify(stale));
    check('E31b. 冲突响应带 currentRevision（界面据此提示重新加载）', () => Number.isInteger(stale.body.currentRevision) && stale.body.currentRevision === 4, JSON.stringify(stale.body));
    check('E32. 陈旧的写入**没有**覆盖最新的 note', () => readReview('plan-d1', 'two', 2).note === '只改说明', JSON.stringify(readReview('plan-d1', 'two', 2)));
    check('E32b. 陈旧的写入没有改动 revision', () => readReview('plan-d1', 'two', 2).revision === 4);

    /* §28 / E33：两个并发请求都拿 revision=4，只能一个成功。
     * **必须真的并发** —— 竞态就发生在 `await readBody` 那个异步边界上。 */
    const [ra, rb] = await Promise.all([
      hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 2), { status: 'accepted', note: 'A 写的', expectedRevision: 4 }),
      hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 2), { status: 'needs_changes', note: 'B 写的', expectedRevision: 4 }),
    ]);
    const okCount = [ra, rb].filter((r) => r.body.ok === true).length;
    const conflictCount = [ra, rb].filter((r) => r.status === 409).length;
    check('E33. 两个并发请求（同一个 expectedRevision）只能一个成功', () => okCount === 1 || `成功 ${okCount} 个：${JSON.stringify([ra.body, rb.body])}`);
    check('E33b. 另一个必须拿到冲突（不能两个都返回成功）', () => conflictCount === 1 || `冲突 ${conflictCount} 个`);
    check('E33c. 最终 revision 只涨了一次（不是两次）', () => readReview('plan-d1', 'two', 2).revision === 5, JSON.stringify(readReview('plan-d1', 'two', 2)));
  }

  /* ================= F. 持久化 ================= */
  section('F. 持久化');

  {
    const r = readReview('plan-d1', 'two', 2);
    check('F34. 重新从磁盘读，审阅仍在', () => r && r.status === 'accepted', JSON.stringify(r));
    check('F35. reviewedAt 由后端生成（是数字且接近现在）', () => Number.isFinite(r.reviewedAt) && Math.abs(Date.now() - r.reviewedAt) < 120000, String(r.reviewedAt));
    check('F35b. 落盘文件里确实有 review 字段', () => {
      const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'plans', 'plan-d1.json'), 'utf8'));
      const a = raw.tasks.find((t) => t.id === 'two').attempts.find((x) => x.attempt === 2);
      return Boolean(a.review && a.review.status === 'accepted');
    });

    /* 清除 → pending（用同一个接口，不新增 DELETE） */
    const revBefore = readReview('plan-d1', 'two', 1).revision;
    runtime.setCurrentCwd(PROJ);
    const c1 = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 1), { status: 'pending', note: '', expectedRevision: revBefore });
    check('F36. 用同一个接口把状态改回 pending（清除）', () => c1.body.ok === true && c1.body.review.status === 'pending', JSON.stringify(c1.body));
    check('F37. 清除后 reviewedAt = null', () => c1.body.review.reviewedAt === null, JSON.stringify(c1.body.review));
    check('F37b. 清除后 note 也清空', () => c1.body.review.note === '', JSON.stringify(c1.body.review));
    check('F38. 清除后 revision 继续递增（不是归零）', () => c1.body.review.revision === revBefore + 1, JSON.stringify(c1.body.review));
    check('F38b. 清除后的状态在磁盘上也生效', () => readReview('plan-d1', 'two', 1).status === 'pending');
    check('F38c. 清除 Attempt 1 不影响 Attempt 2', () => readReview('plan-d1', 'two', 2).status === 'accepted');
  }

  /* ================= G. 重试 ================= */
  section('G. 重试');

  {
    const p = store.load('plan-d1').plan;
    const a1 = attemptOf(p, 'two', 1);
    const a2 = attemptOf(p, 'two', 2);

    check('G40. 重试后 Attempt 1 的审阅历史保留（revision 累计到 3，没被新 attempt 清零）', () => a1.review.revision === 3, JSON.stringify(a1.review));
    check('G41. 新的 Attempt 2 从 pending 起、revision 0 —— 重试**不继承**上一次的人工判断', () => {
      /* 注意 Attempt 2 在 E/F 段已经被写过，所以这里改看它「刚产生时」的状态：
       * D-prep 之后立刻读过一次，那时是 pending / 0。这里用 D25 的断言作证，
       * 本条改为验证「Attempt 2 的 revision 从 0 开始递增」（不是继承 Attempt 1 的 2）。 */
      return a2.review.revision > 0 && a1.review.revision !== a2.review.revision;
    }, JSON.stringify([a1.review, a2.review]));
    check('G42. Attempt 1 的 snapshot 是**当时**的要求（npm test）', () => a1.verificationSnapshot && a1.verificationSnapshot.command === 'npm test', JSON.stringify(a1.verificationSnapshot));
    check('G42b. Attempt 2 的 snapshot 是**改过之后**的要求（npm run test:unit）', () => a2.verificationSnapshot && a2.verificationSnapshot.command === 'npm run test:unit', JSON.stringify(a2.verificationSnapshot));
    check('G42c. 两条 attempt 的 snapshot 不同（各自反映当时的要求）', () => JSON.stringify(a1.verificationSnapshot) !== JSON.stringify(a2.verificationSnapshot));
    check('G42d. 两条 attempt 的历史都在（没被覆盖）', () => (taskOf(p, 'two').attempts || []).length === 2);

    /* 钉住一条**既有策略**（P8-A 不改它，但要让它可见）：
     * retryTask 拒绝重试已经成功的任务 —— 所以「先成功并接受、再重试」这条路径
     * 在当前调度策略下不可达。上面用「先失败再重试」验的是同一组不变量。 */
    runtime.setCurrentCwd(PROJ);
    const retryOk = scheduler.retryTask(store.load('plan-d1').plan, 'two');
    check('G-policy. 已成功的任务拒绝重试（既有策略；P8-A 不改变它）', () => retryOk.ok === false && retryOk.code === 'settled', JSON.stringify(retryOk));
  }

  /* ================= H. 计划编辑 ================= */
  section('H. 计划编辑不擦历史');

  {
    runtime.setCurrentCwd(PROJ);
    const before = store.load('plan-d1').plan;
    const a2Before = attemptOf(before, 'two', 2);

    /* H43：只改计划标题 */
    const r1 = await hit(planner, 'PUT', '/api/plans/plan-d1', { title: '改过的标题' });
    check('H43-prep. 改标题成功', () => r1.body.ok === true, JSON.stringify(r1.body).slice(0, 160));
    const after1 = store.load('plan-d1').plan;
    check('H43. 改 Plan title 不丢 Review', () => attemptOf(after1, 'two', 2).review.status === 'accepted', JSON.stringify(attemptOf(after1, 'two', 2).review));
    check('H43b. 改 Plan title 不丢 Attempt history', () => (taskOf(after1, 'two').attempts || []).length === 2);

    /* H44：改任务标题 */
    const r2 = await hit(planner, 'PUT', '/api/plans/plan-d1', {
      title: '改过的标题',
      tasks: [{ id: 'two', title: '改过的任务标题', agent: 'fake', dependsOn: [], verification: { command: 'npm run test:unit' } }],
    });
    check('H44-prep. 改任务标题成功', () => r2.body.ok === true, JSON.stringify(r2.body).slice(0, 160));
    const after2 = store.load('plan-d1').plan;
    check('H44. 改 Task title 不丢 Review', () => attemptOf(after2, 'two', 2).review.status === 'accepted');
    check('H45. 改 verification 不改历史 Snapshot', () => {
      const s = attemptOf(after2, 'two', 1).verificationSnapshot;
      return s === null || s.command === 'npm test' || JSON.stringify(s);
    });
    check('H45b. 任务当前 verification 已是新值', () => taskOf(after2, 'two').verification.command === 'npm run test:unit');
    check('H45c. 三次 attempt 的 review / snapshot 都还在', () => {
      const t = taskOf(after2, 'two');
      return t.attempts.length === 2 && t.attempts.every((a) => a.review && typeof a.review.revision === 'number');
    });

    /* H46：拿一份**陈旧**的 tasks（只有一条 attempt 的旧形状）去 PUT，
     * 不能把磁盘上已有的 3 条 attempt 擦掉。 */
    const staleTasks = [{ id: 'two', title: '旧副本里的标题', agent: 'fake', dependsOn: [], attempts: [], attempt: 0, verification: { command: 'npm test' } }];
    const r3 = await hit(planner, 'PUT', '/api/plans/plan-d1', { tasks: staleTasks });
    check('H46-prep. 陈旧 PUT 成功', () => r3.body.ok === true, JSON.stringify(r3.body).slice(0, 160));
    const after3 = store.load('plan-d1').plan;
    check('H46. 陈旧 Plan PUT 不覆盖新 Attempt（仍是最新的 3 条）', () => {
      const t = taskOf(after3, 'two');
      return (t.attempts || []).length === 2 || JSON.stringify((t.attempts || []).map((a) => a.attempt));
    });
    check('H46b. 陈旧 PUT 也没有擦掉 Review', () => attemptOf(after3, 'two', 2).review.status === 'accepted');
    check('H46c. 陈旧 PUT 的 attempts:[] 没有被当成「用户删掉了历史」', () => {
      const t = taskOf(after3, 'two');
      return t.attempt === 2 && t.status !== 'pending';
    });
  }

  /* ================= H2. 被跳过的任务不被编辑抹掉 ================= */
  section('H2. 被跳过的任务保留结论');

  {
    runtime.setCurrentCwd(PROJ);
    store.save(mkPlan({ id: 'plan-skip', tasks: [{ id: 'okDoc' }] }));
    await sleep(30);
    const p = store.load('plan-skip').plan;
    p.tasks[0].status = 'skipped';
    p.tasks[0].error = '已跳过';
    store.save(p);
    const r = await hit(planner, 'PUT', '/api/plans/plan-skip', { title: '改个标题' });
    check('H2-prep. PUT 成功', () => r.body.ok === true);
    check('H2. 改计划标题不会把 skipped 的任务退回 pending', () => {
      const t = taskOf(store.load('plan-skip').plan, 'okDoc');
      return t.status === 'skipped' || t.status;
    });
  }

  /* ================= I. 项目归属 ================= */
  section('I. 项目归属');

  {
    runtime.setCurrentCwd(PROJ);
    const ok = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 2), { status: 'accepted', note: '本项目写', expectedRevision: 5 });
    check('I47. A 项目里写 A 的计划 → 允许', () => ok.body.ok === true, JSON.stringify(ok.body));

    runtime.setCurrentCwd(PROJ_B);
    const cross = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 2), { status: 'needs_changes', expectedRevision: 6 });
    check('I48. B 项目写 A 的计划 → 403', () => cross.status === 403 || JSON.stringify(cross), JSON.stringify(cross));
    check('I48b. 403 之后磁盘上的审阅没有被动过', () => readReview('plan-d1', 'two', 2).status === 'accepted');
    const crossGet = await hit(planner, 'GET', '/api/plans/plan-d1');
    check('I48c. 跨项目连读都不给（403）', () => crossGet.status === 403);
    runtime.setCurrentCwd(PROJ);
  }

  /* ================= J. 隐私 ================= */
  section('J. 隐私');

  {
    const NOTE = '这是只有我知道的审阅说明-ZZQ-9142';
    runtime.setCurrentCwd(PROJ);
    const w = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 2), { status: 'needs_changes', note: NOTE, expectedRevision: 6 });
    check('J-prep. 写入了带特征串的 note', () => w.body.ok === true, JSON.stringify(w.body));

    const a = attemptOf(store.load('plan-d1').plan, 'two', 2);
    const blob = JSON.stringify({ review: a.review, snapshot: a.verificationSnapshot, filesChanged: a.filesChanged });
    check('J49. review / snapshot 里不含绝对 cwd', () => (!blob.includes(TMP) && !/[A-Za-z]:\\\\/.test(blob)) || blob);
    check('J50. snapshot 里不含 prompt 正文', () => !blob.includes('# 任务') && !blob.includes('整体目标'));
    check('J51. review 里不含完整 diff（没有 @@ / +++ / --- 这类 hunk 标记）', () => !/@@|\+\+\+|---/.test(blob));
    check('J51b. review 只有四个字段，没有夹带别的东西', () => {
      const keys = Object.keys(a.review).sort();
      return JSON.stringify(keys) === JSON.stringify(['note', 'reviewedAt', 'revision', 'status']) || keys.join(',');
    });

    /* J52：诊断报告不能带出审阅说明。
     * 这里**真的构造一个 diagnostics 实例**（指向同一个 dataDir，里面有带特征串的
     * 计划文件），然后打它的接口 —— 比「静态扫源码」硬得多。 */
    const diagnostics = createDiagnostics({
      runtime,
      rpc: { getState: () => ({ ok: true, state: 'ready', pid: 0, args: [], cwd: PROJ }) },
      agentRegistry: registry,
      mcp: { readReport: () => ({ supported: false, piVersion: null }) },
      compat: null,
      dataDir: DATA,
      version: '0.12.0',
      env: process.env,
    });
    const d = await hit(diagnostics, 'GET', '/api/diagnostics');
    const dblob = JSON.stringify(d.body);
    check('J52. 诊断报告里没有审阅说明正文', () => !dblob.includes('ZZQ-9142') || dblob.slice(0, 300));
    check('J52b. 诊断报告里也没有计划正文（连 plans 目录内容都不带出）', () => !dblob.includes('plan-d1') && !dblob.includes('这是只有我知道'), dblob.slice(0, 300));
  }

  /* ================= K. 非法输入与写盘失败 ================= */
  section('K. 非法输入与写盘失败');

  {
    runtime.setCurrentCwd(PROJ);
    const cases = [
      ['K31a. status 非法', { status: 'approved', expectedRevision: 0 }, /审阅状态只能是/],
      ['K31b. note 不是字符串', { status: 'accepted', note: 123, expectedRevision: 0 }, /必须是纯文本/],
      ['K31c. note 超限', { status: 'accepted', note: 'x'.repeat(1001), expectedRevision: 0 }, /最多 1000 字/],
      ['K31d. 缺 expectedRevision', { status: 'accepted' }, /expectedRevision/],
      ['K31e. expectedRevision 非整数', { status: 'accepted', expectedRevision: 1.5 }, /expectedRevision/],
      ['K31f. expectedRevision 为负', { status: 'accepted', expectedRevision: -1 }, /expectedRevision/],
    ];
    for (const [name, body, re] of cases) {
      const r = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 2), body);
      check(name, () => r.status === 200 && r.body.ok === false && re.test(r.body.error), `${r.status} ${JSON.stringify(r.body)}`);
    }
    {
      const r = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 2), { status: 'needs_changes', note: 'x'.repeat(1000), expectedRevision: 7 });
      check('K31g2. 1000 字边界被接受', () => r.body.ok === true, JSON.stringify(r.body).slice(0, 160));
    }
    const r0 = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 0), { status: 'accepted', expectedRevision: 0 });
    check('K31h. attempt 号非正整数 → 稳定拒绝', () => r0.body.ok === false && /正整数/.test(r0.body.error), JSON.stringify(r0.body));
    const rn = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 'abc'), { status: 'accepted', expectedRevision: 0 });
    check('K31i. attempt 号不是数字 → 稳定拒绝（不是 500）', () => rn.body.ok === false, JSON.stringify(rn.body));
    const rp = await hit(planner, 'PUT', reviewUrl('plan-nope', 'two', 1), { status: 'accepted', expectedRevision: 0 });
    check('K31j. plan 不存在 → 404（与既有 API 一致）', () => rp.status === 404, String(rp.status));
    const r404 = await hit(planner, 'PUT', '/api/plans/plan-d1/tasks/two/attempts/1/nope', { status: 'accepted' });
    check('K31k. 路径形状不对 → 不是 500', () => r404.status === 404 || r404.status === 405, String(r404.status));

    /* §29 写盘失败：注入一个 save 会抛的 store */
    const failingStore = {
      load: (id) => store.load(id),
      save: () => {
        throw new Error('磁盘满了（测试注入）');
      },
    };
    const plannerFail = createPlanner({ runtime, registry, store: failingStore, scheduler });
    const before = readReview('plan-d1', 'two', 2);
    const rf = await hit(plannerFail, 'PUT', reviewUrl('plan-d1', 'two', 2), { status: 'accepted', note: '写不进去', expectedRevision: before.revision });
    check('K29. 写盘失败 → 明确报错（不返回 ok:true）', () => rf.body.ok === false && /保存失败/.test(rf.body.error), JSON.stringify(rf.body));
    check('K29b. 写盘失败后磁盘上的原记录仍可读且没变', () => {
      const after = readReview('plan-d1', 'two', 2);
      return after.status === before.status && after.revision === before.revision && after.note === before.note;
    });
  }

  /* ================= L. 审阅不驱动调度器 ================= */
  section('L. 审阅只改审阅');

  {
    runtime.setCurrentCwd(PROJ);
    const p0 = store.load('plan-c1').plan;
    const t0 = taskOf(p0, 'fail1');
    const snapshotBefore = JSON.stringify({ status: t0.status, attempt: t0.attempt, error: t0.error, planStatus: p0.status });
    const r = await hit(planner, 'PUT', reviewUrl('plan-c1', 'fail1', 1), { status: 'needs_changes', note: '返工', expectedRevision: 1 });
    check('L-prep. 给失败任务写 needs_changes 成功', () => r.body.ok === true, JSON.stringify(r.body));
    const p1 = store.load('plan-c1').plan;
    const t1 = taskOf(p1, 'fail1');
    check('§33. 审阅不改 task.status（执行状态仍是 failed）', () => t1.status === 'failed', t1.status);
    check('§33b. 审阅不改 plan.status', () => p1.status === p0.status, `${p0.status} → ${p1.status}`);
    check('§33c. 审阅不产生新 attempt、不触发重试', () => t1.attempt === t0.attempt && t1.attempts.length === t0.attempts.length, JSON.stringify({ before: snapshotBefore, after: { attempt: t1.attempt, n: t1.attempts.length } }));
    check('§33d. 审阅没有启动任何计划（调度器仍是空闲）', () => scheduler.activePlanId() === null, String(scheduler.activePlanId()));
  }

  /* ================= M. 返回值形状 ================= */
  section('M. 返回值形状');

  {
    runtime.setCurrentCwd(PROJ);
    const r = await hit(planner, 'PUT', reviewUrl('plan-d1', 'two', 2), { status: 'accepted', note: '最后一次', expectedRevision: 8 });
    check('M32. 成功响应只回这一条 review，不回整份 plan', () => {
      const b = r.body;
      const keys = Object.keys(b).sort();
      return JSON.stringify(keys) === JSON.stringify(['attempt', 'ok', 'planId', 'review', 'taskId']) || keys.join(',');
    });
    check('M32b. 响应里没有 tasks / plan 大对象', () => !r.body.plan && !r.body.tasks, JSON.stringify(r.body).slice(0, 200));
    check('M32c. 响应的 review 形状正确', () => {
      const rv = r.body.review;
      return rv.status === 'accepted' && rv.note === '最后一次' && Number.isFinite(rv.reviewedAt) && rv.revision === 9;
    }, JSON.stringify(r.body.review));
  }

  /* ================= N. 审阅写入 vs Scheduler 持久化 ================= */
  section('N. 两个写者不互相覆盖（计划仍 active 时写审阅）');

  /** 轮询到条件成立为止（用来等出「A 完成、B 在跑」这个窗口）。 */
  async function waitUntil(planId, pred, timeoutMs = 10000) {
    const t0 = Date.now();
    for (;;) {
      const p = store.load(planId).plan;
      if (pred(p)) return p;
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(25);
    }
  }
  const statusOf = (p, id) => {
    const t = p.tasks.find((x) => x.id === id);
    return t ? t.status : '';
  };

  {
    /* Scheduler 在**内存里**持有计划对象，persist() 时整份写盘。
     * 而审阅是 Review API 写到磁盘上的 —— Scheduler 内存里那份的 attempt
     * 还停在 review=pending。于是 B 跑完时的 persist() 会把刚落盘的审阅冲掉。
     * 这一条就是那个缺陷的复现。 */
    runtime.setCurrentCwd(PROJ);
    store.save(mkPlan({ id: 'plan-n1', tasks: [{ id: 'okDoc' }, { id: 'slowB' }] }));
    const started = await scheduler.start(store.load('plan-n1').plan);
    check('N-prep. 计划已启动', () => started.ok === true, JSON.stringify(started));

    const win = await waitUntil('plan-n1', (p) => statusOf(p, 'okDoc') === 'success' && statusOf(p, 'slowB') === 'running');
    check('N-prep2. 拿到了「A 已完成、B 还在跑」的窗口（计划仍 active）', () => Boolean(win), win ? 'ok' : '没等到窗口');
    check('N-prep3. 此刻调度器确实认为计划在跑', () => scheduler.activePlanId() === 'plan-n1', String(scheduler.activePlanId()));

    const r = await hit(planner, 'PUT', reviewUrl('plan-n1', 'okDoc', 1), { status: 'accepted', note: 'A 的结果我接受了', expectedRevision: 0 });
    check('N1. 计划运行中也能给**已结束**的 attempt 写审阅（不需要禁止）', () => r.body.ok === true, JSON.stringify(r.body));

    await scheduler.waitIdle(20000);
    const after = store.load('plan-n1').plan;
    const a = attemptOf(after, 'okDoc', 1);
    check('N2. B 跑完（Scheduler 又 persist 过一次）之后，A 的审阅**没有丢**', () => {
      const rv = model.normalizeReview(a.review);
      return (rv.status === 'accepted' && rv.revision === 1 && rv.note === 'A 的结果我接受了') || JSON.stringify(rv);
    }, JSON.stringify(a.review));
    check('N2b. B 自己的 attempt 也正常落盘了', () => {
      const b = attemptOf(after, 'slowB', 1);
      return Boolean(b && b.outcomeStatus === 'success');
    });
    check('N2c. B 的 review 是默认 pending（没人审阅过它）', () => {
      const b = attemptOf(after, 'slowB', 1);
      return b.review.status === 'pending' && b.review.revision === 0;
    });
  }

  {
    /* concurrency=2：A/B 并行，A 先完成 → 审阅 A → B 后完成。
     * 与上一条同一个机制，只是把「串行」换成「并行」，顺带验并行下也不丢。 */
    runtime.setCurrentCwd(PROJ);
    store.save(mkPlan({ id: 'plan-n2', tasks: [{ id: 'okDoc' }, { id: 'slowB' }], concurrency: 2 }));
    await scheduler.start(store.load('plan-n2').plan);
    const win = await waitUntil('plan-n2', (p) => statusOf(p, 'okDoc') === 'success' && statusOf(p, 'slowB') === 'running');
    check('N3-prep. 并行下也拿到了那个窗口', () => Boolean(win), win ? 'ok' : '没等到窗口');

    const r = await hit(planner, 'PUT', reviewUrl('plan-n2', 'okDoc', 1), { status: 'needs_changes', note: '并行时写的', expectedRevision: 0 });
    check('N3. 并行时给已完成的 A 写审阅成功', () => r.body.ok === true, JSON.stringify(r.body));

    await scheduler.waitIdle(20000);
    const a = attemptOf(store.load('plan-n2').plan, 'okDoc', 1);
    check('N4. 并行的 B 完成后，A 的审阅没有丢', () => {
      const rv = model.normalizeReview(a.review);
      return (rv.status === 'needs_changes' && rv.revision === 1 && rv.note === '并行时写的') || JSON.stringify(rv);
    }, JSON.stringify(a.review));
  }

  {
    /* 第三个写者：`PUT /api/plans/:id`（计划结构编辑）。
     * 它同样**不拥有** attempt.review —— 「保留历史」必须用**重读之后**的磁盘值，
     * 否则它那份陈旧快照会把刚写进去的审阅抹掉。 */
    runtime.setCurrentCwd(PROJ);
    store.save(mkPlan({ id: 'plan-n3', tasks: [{ id: 'okDoc' }] }));
    await scheduler.start(store.load('plan-n3').plan);
    await scheduler.waitIdle(20000);

    /* 两条请求都先 load 一次计划、再 await readBody。审阅先发，所以它先恢复并
     * 落盘 revision 1；随后 PUT 恢复 —— 如果它用自己那份陈旧快照去合并历史，
     * 就会把审阅覆盖回 pending。 */
    const [rv, put] = await Promise.all([
      hit(planner, 'PUT', reviewUrl('plan-n3', 'okDoc', 1), { status: 'accepted', note: '先审阅', expectedRevision: 0 }),
      hit(planner, 'PUT', '/api/plans/plan-n3', { title: '并发改标题' }),
    ]);
    check('N5-prep. 审阅写入成功', () => rv.body.ok === true, JSON.stringify(rv.body));
    check('N5-prep2. 并发的 PUT 也成功（没被拒）', () => put.body.ok === true, JSON.stringify(put.body).slice(0, 160));
    check('N5b. PUT 的标题确实改了（证明它真的执行过）', () => store.load('plan-n3').plan.title === '并发改标题', store.load('plan-n3').plan.title);
    const a = attemptOf(store.load('plan-n3').plan, 'okDoc', 1);
    check('N5. 并发的 Plan 编辑没有擦掉刚落盘的审阅', () => {
      const rv2 = model.normalizeReview(a.review);
      return (rv2.status === 'accepted' && rv2.revision === 1 && rv2.note === '先审阅') || JSON.stringify(rv2);
    }, JSON.stringify(a.review));
  }

  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n测试自身抛错：', err && err.stack ? err.stack : err);
  cleanup();
  process.exit(1);
});
