/* P8-B —— Attempt 生命周期与历史一致性。
 *
 * 一条不能破的语义：
 *
 *     Retry = 新的 Attempt，**不是重写历史**。
 *
 * 覆盖规格 §36 的用例清单与 §37 的核心 E2E。与另外两个套件的分工：
 *   - `planner.cjs`     调度状态机（依赖推进 / 失败暂停 / 单活跃…）
 *   - `reviews.cjs`     审阅数据契约 + **并发写者**（Review vs Scheduler / Plan PUT）
 *   - 本文件            retry / cancel / stop / shutdown / restart 对**历史**的影响
 *
 * 纪律：全程 os.tmpdir() + fake adapter，不 spawn 真 Agent、不联网、不消耗额度。
 *
 * 用法：node tests/attempt-lifecycle.cjs
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-p8b-'));
const DATA = path.join(TMP, 'data');
const PROJ = path.join(TMP, 'proj');
function cleanup() {
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows 偶发占用 */
  }
}

async function mkProject(dir) {
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, 'init', '-q');
  await git(dir, 'config', 'user.email', 't@t');
  await git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  /* 预置两个**已跟踪**的源文件。为什么必须已跟踪：git status 对未跟踪文件只给
   * `??`、不给行数，所以「同一个未跟踪文件被改了内容」在快照差集里**看不见** ——
   * 那样 filesChanged 会恒为空，断言就测不出东西了。 */
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'const a = 0;\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'const b = 0;\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-qm', 'init');
  return dir;
}

/* ---------- HTTP 小工具（走 planner.handle） ---------- */

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
  const out = { status: 0, body: null };
  const res = {
    writeHead(code) {
      out.status = code;
      return this;
    },
    end(chunk) {
      try {
        out.body = JSON.parse(String(chunk));
      } catch {
        out.body = String(chunk);
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

  await mkProject(PROJ);
  fs.mkdirSync(path.join(DATA, 'plans'), { recursive: true });

  const BEHAVIORS = {
    /* 多元素列：fake 按 taskId 的调用次数依次取。**每一条的行数都不同** ——
     * 这是必须的：快照差集比的是 `{status, additions, deletions, untracked}`，
     * 所以「改了内容但行数没变」在它眼里**等于没变**。行数递增才能每次都测到变化。
     * 给足条数，保证整个套件里的每一次 okA 执行都落在不同行数上。 */
    okA: [
      { ok: true, summary: 'A 完成', writes: [{ path: 'src/a.js', content: 'const a = 1;\n' }] },
      { ok: true, summary: 'A 完成', writes: [{ path: 'src/a.js', content: 'const a = 2;\nconst c2 = 2;\n' }] },
      { ok: true, summary: 'A 完成', writes: [{ path: 'src/a.js', content: 'const a = 3;\nconst c3 = 3;\nconst d3 = 3;\n' }] },
      { ok: true, summary: 'A 完成', writes: [{ path: 'src/a.js', content: 'const a = 4;\nconst c4 = 4;\nconst d4 = 4;\nconst e4 = 4;\n' }] },
      { ok: true, summary: 'A 完成', writes: [{ path: 'src/a.js', content: 'const a = 5;\nconst c5 = 5;\nconst d5 = 5;\nconst e5 = 5;\nconst f5 = 5;\n' }] },
      { ok: true, summary: 'A 完成', writes: [{ path: 'src/a.js', content: 'const a = 6;\nconst c6 = 6;\nconst d6 = 6;\nconst e6 = 6;\nconst f6 = 6;\nconst g6 = 6;\n' }] },
      { ok: true, summary: 'A 完成', writes: [{ path: 'src/a.js', content: 'const a = 7;\nconst c7 = 7;\nconst d7 = 7;\nconst e7 = 7;\nconst f7 = 7;\nconst g7 = 7;\nconst h7 = 7;\n' }] },
      { ok: true, summary: 'A 完成', writes: [{ path: 'src/a.js', content: 'const a = 8;\nconst c8 = 8;\nconst d8 = 8;\nconst e8 = 8;\nconst f8 = 8;\nconst g8 = 8;\nconst h8 = 8;\nconst i8 = 8;\n' }] },
    ],
    okB: [{ ok: true, summary: 'B 完成', writes: [{ path: 'src/b.js', content: 'const b = 1;\n' }] }],
    /* 「永远失败」与「先失败后成功」是两个不同用途，**不要共用一个 id** ——
     * fake 的调用计数是按 taskId 累计的，共用会让某一段拿到另一段用剩下的那一档。 */
    failAlways: [{ ok: false, error: '故意失败' }],
    failThenOk: [{ ok: false, error: '第一次故意失败' }, { ok: true, summary: '第二次成功' }],
    hangA: [{ hang: true }],
    /* 慢任务：用来制造「上游已完成、下游正在跑」的窗口 */
    slowB: [{ slowMs: 700, ok: true, summary: 'B 完成' }],
  };
  const registry = createAgentRegistry({ env: process.env, includeFake: true, fakeBehaviors: BEHAVIORS });

  const fake = registry.get('fake');
  /* 重置 fake 的行为表与调用计数。⚠️ 它重置的是**整张表**（所有 taskId 的计数），
   * 所以**只在真的依赖「多元素列表取第几档」的段落里调用**；
   * 单元素行为的段落（failAlways / hangA）调它是没必要的，还会顺手把
   * okA 的计数也清掉 —— 那会让下一段写出与现状一模一样的文件，
   * 于是快照差集为空、filesChanged 断言假红。 */
  const resetFake = () => fake.setBehaviors(BEHAVIORS);

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

  /* ---------- 计划构造 / 执行 ---------- */

  function mkPlan({ id, tasks, project = PROJ, concurrency = 1 }) {
    return {
      id,
      title: 'P8-B 计划 ' + id,
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

  const load = (id) => store.load(id).plan;
  const taskOf = (plan, id) => plan.tasks.find((t) => t.id === id);
  const attemptsOf = (plan, id) => {
    const t = taskOf(plan, id);
    return t && Array.isArray(t.attempts) ? t.attempts : [];
  };
  const attOf = (plan, id, n) => attemptsOf(plan, id).find((a) => a.attempt === n);

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
  async function waitUntil(planId, pred, timeoutMs = 10000) {
    const t0 = Date.now();
    for (;;) {
      const p = load(planId);
      if (pred(p)) return p;
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(25);
    }
  }
  /** 只跑一轮（不重试）—— 用在「已经 retry 过、现在要真的执行」的地方。 */
  async function runAgain(planId) {
    runtime.setCurrentCwd(PROJ);
    const s = await scheduler.start(load(planId));
    if (!s.ok) throw new Error('start 失败：' + s.error);
    await scheduler.waitIdle(20000);
    return load(planId);
  }

  /** 重试后接着跑完。 */
  async function retryAndRun(planId, taskId) {
    runtime.setCurrentCwd(PROJ);
    const r = scheduler.retryTask(load(planId), taskId);
    if (!r.ok) throw new Error('retry 失败：' + r.error);
    const s = await scheduler.start(load(planId));
    if (!s.ok) throw new Error('start 失败：' + s.error);
    await scheduler.waitIdle(20000);
    return load(planId);
  }

  /* ================= A. 哪些状态允许重试 ================= */
  section('A. 允许重试的状态');

  {
    const p = await runPlan({ id: 'lc-a1', tasks: [{ id: 'okA' }] });
    check('A-prep. 任务成功', () => taskOf(p, 'okA').status === 'success');
    runtime.setCurrentCwd(PROJ);
    const r = scheduler.retryTask(load('lc-a1'), 'okA');
    check('A1. success 允许显式重试（P8-B 的核心改动）', () => r.ok === true, JSON.stringify(r));
    check('A1b. 重试只改当前态，不动历史 attempts', () => attemptsOf(load('lc-a1'), 'okA').length === 1, JSON.stringify(attemptsOf(load('lc-a1'), 'okA').map((a) => a.attempt)));
    check('A1c. 重试后任务回到 pending（等用户点开始，不自动跑）', () => taskOf(load('lc-a1'), 'okA').status === 'pending', taskOf(load('lc-a1'), 'okA').status);
  }

  {
    const p = await runPlan({ id: 'lc-a2', tasks: [{ id: 'failAlways' }] });
    check('A-prep2. 任务失败', () => taskOf(p, 'failAlways').status === 'failed');
    runtime.setCurrentCwd(PROJ);
    const r = scheduler.retryTask(load('lc-a2'), 'failAlways');
    check('A2. failed 允许重试', () => r.ok === true, JSON.stringify(r));
  }

  {
    await startNoWait({ id: 'lc-a3', tasks: [{ id: 'hangA' }] });
    scheduler.stop();
    await scheduler.waitIdle(20000);
    check('A-prep3. 任务被取消', () => taskOf(load('lc-a3'), 'hangA').status === 'cancelled');
    runtime.setCurrentCwd(PROJ);
    const r = scheduler.retryTask(load('lc-a3'), 'hangA');
    check('A3. cancelled 允许重试', () => r.ok === true, JSON.stringify(r));
    check('A3b. 重试后历史里那条 cancelled 仍在', () => attOf(load('lc-a3'), 'hangA', 1).outcomeStatus === 'cancelled', JSON.stringify(attOf(load('lc-a3'), 'hangA', 1).outcomeStatus));
  }

  {
    await startNoWait({ id: 'lc-a4', tasks: [{ id: 'hangA' }] });
    scheduler.shutdown();
    await scheduler.waitIdle(20000);
    check('A-prep4. 任务被中断', () => taskOf(load('lc-a4'), 'hangA').status === 'interrupted');
    runtime.setCurrentCwd(PROJ);
    const r = scheduler.retryTask(load('lc-a4'), 'hangA');
    check('A4. interrupted 允许重试', () => r.ok === true, JSON.stringify(r));
    check('A4b. 重试后历史里那条 interrupted 仍在', () => attOf(load('lc-a4'), 'hangA', 1).outcomeStatus === 'interrupted');
  }

  {
    await startNoWait({ id: 'lc-a5', tasks: [{ id: 'hangA' }] });
    runtime.setCurrentCwd(PROJ);
    const r = scheduler.retryTask(load('lc-a5'), 'hangA');
    check('A5. running 拒绝重试（要先停止）', () => r.ok === false && r.code === 'running', JSON.stringify(r));
    scheduler.stop();
    await scheduler.waitIdle(20000);
  }

  {
    runtime.setCurrentCwd(PROJ);
    store.save(mkPlan({ id: 'lc-a6', tasks: [{ id: 'okA' }] }));
    const r = scheduler.retryTask(load('lc-a6'), 'okA');
    check('A6. 从没跑过（pending，attempt 0）拒绝重试 —— 没有可重试的结果', () => r.ok === false && r.code === 'nothing-to-retry', JSON.stringify(r));
  }

  {
    runtime.setCurrentCwd(PROJ);
    store.save(mkPlan({ id: 'lc-a7', tasks: [{ id: 'okA' }] }));
    const p0 = load('lc-a7');
    p0.tasks[0].status = 'skipped';
    store.save(p0);
    const r = scheduler.retryTask(load('lc-a7'), 'okA');
    check('A7. skipped 仍允许重试（保持既有行为）', () => r.ok === true, JSON.stringify(r));
  }

  /* ================= B. Retry = 新 Attempt，不是重写历史 ================= */
  section('B. 核心：历史一条都不能丢');

  {
    /* A→B，都成功 → 计划 completed。给 A1 写一条 accepted，然后重试 A。 */
    /* ⚠️ 这里**刻意不** resetFake：okA 的调用计数要接着 A1 那一次往下走，
     * 这样写进 src/a.js 的内容和磁盘上已有的**行数不同**，快照差集才看得到变化。
     * 若在这里清零，attempt 1 会写出与现状一模一样的文件 ⇒ filesChanged 为空，
     * 下面 B7 / F7 会立刻红（这正是我们希望它红的地方）。 */
    runtime.setCurrentCwd(PROJ);
    const p0 = await runPlan({
      id: 'lc-b1',
      tasks: [
        { id: 'okA', verification: { command: 'npm test' } },
        { id: 'okB', dependsOn: ['okA'] },
      ],
    });
    check('B-prep. A、B 都成功、计划 completed', () => taskOf(p0, 'okA').status === 'success' && taskOf(p0, 'okB').status === 'success' && p0.status === 'completed', JSON.stringify({ a: taskOf(p0, 'okA').status, b: taskOf(p0, 'okB').status, s: p0.status }));

    const rv = await hit(planner, 'PUT', reviewUrl('lc-b1', 'okA', 1), { status: 'accepted', note: '第一次通过', expectedRevision: 0 });
    check('B-prep2. A 的 Attempt 1 被人工接受', () => rv.body.ok === true, JSON.stringify(rv.body));

    const a1Before = attOf(load('lc-b1'), 'okA', 1);

    /* 改掉验证要求，再重试 —— 新 attempt 的 snapshot 必须取新值 */
    await hit(planner, 'PUT', '/api/plans/lc-b1', {
      tasks: [
        { id: 'okA', title: '任务 okA', agent: 'fake', dependsOn: [], verification: { command: 'npm run test:unit' } },
        { id: 'okB', title: '任务 okB', agent: 'fake', dependsOn: ['okA'], verification: null },
      ],
    });
    runtime.setCurrentCwd(PROJ);
    const retry = scheduler.retryTask(load('lc-b1'), 'okA');
    check('B1. 成功任务重试成功', () => retry.ok === true, JSON.stringify(retry));
    check('B2. 重试后计划不再是 completed（否则 start 会被拒 / 状态自相矛盾）', () => load('lc-b1').status !== 'completed', load('lc-b1').status);
    check('B3. 重试后下游 B 的当前态回到待重新评估（不再宣称基于旧 A 的成功）', () => taskOf(load('lc-b1'), 'okB').status === 'pending', taskOf(load('lc-b1'), 'okB').status);
    check('B3b. 下游被重置的 id 会回给调用方（界面据此刷新）', () => Array.isArray(retry.invalidated) && retry.invalidated.includes('okB'), JSON.stringify(retry.invalidated));

    const afterRetry = load('lc-b1');
    const a1 = attOf(afterRetry, 'okA', 1);
    check('B4. 重试**没有**新增 attempt（新记录要等真的开始执行）', () => attemptsOf(afterRetry, 'okA').length === 1, String(attemptsOf(afterRetry, 'okA').length));
    check('B5. Attempt 1 的 outcomeStatus 原样', () => a1.outcomeStatus === a1Before.outcomeStatus && a1.outcomeStatus === 'success', JSON.stringify(a1.outcomeStatus));
    check('B6. Attempt 1 的 sessionId 原样', () => a1.sessionId === a1Before.sessionId && Boolean(a1.sessionId), JSON.stringify([a1Before.sessionId, a1.sessionId]));
    check('B7. Attempt 1 的 filesChanged 原样', () => JSON.stringify(a1.filesChanged) === JSON.stringify(a1Before.filesChanged) && a1.filesChanged.includes('src/a.js'), JSON.stringify(a1.filesChanged));
    check('B8. Attempt 1 的 review 原样（accepted + note + revision）', () => {
      const r = model.normalizeReview(a1.review);
      return r.status === 'accepted' && r.note === '第一次通过' && r.revision === 1;
    }, JSON.stringify(a1.review));
    check('B9. 下游 B 的历史 attempt 也原样保留', () => attemptsOf(afterRetry, 'okB').length === 1 && attOf(afterRetry, 'okB', 1).outcomeStatus === 'success');

    /* 真正再跑一次（B1 已经排过队了，这里只执行，不要再 retry） */
    await runAgain('lc-b1');
    const fin = load('lc-b1');
    const a2 = attOf(fin, 'okA', 2);
    check('B10. 跑完后确实多了一条 Attempt 2', () => Boolean(a2), JSON.stringify(attemptsOf(fin, 'okA').map((x) => x.attempt)));
    check('B11. 新的 Attempt 2 是 review=pending / revision=0', () => {
      const r = model.normalizeReview(a2.review);
      return r.status === 'pending' && r.revision === 0 && r.reviewedAt === null;
    }, JSON.stringify(a2 && a2.review));
    check('B12. Attempt 号严格递增、不复用（1 → 2）', () => JSON.stringify(attemptsOf(fin, 'okA').map((x) => x.attempt)) === JSON.stringify([1, 2]), JSON.stringify(attemptsOf(fin, 'okA').map((x) => x.attempt)));
    check('B13. Attempt 1 依然是 accepted（旧结论不被新 attempt 改写）', () => {
      const r = model.normalizeReview(attOf(fin, 'okA', 1).review);
      return r.status === 'accepted' && r.note === '第一次通过';
    }, JSON.stringify(attOf(fin, 'okA', 1).review));
    check('B14. 两次 attempt 的 sessionId 不同', () => {
      const s1 = attOf(fin, 'okA', 1).sessionId;
      const s2 = attOf(fin, 'okA', 2).sessionId;
      return Boolean(s1 && s2 && s1 !== s2) || JSON.stringify([s1, s2]);
    });
    check('B15. 两次 attempt 的 verificationSnapshot 各自独立（1=npm test，2=npm run test:unit）', () => {
      const v1 = attOf(fin, 'okA', 1).verificationSnapshot;
      const v2 = attOf(fin, 'okA', 2).verificationSnapshot;
      return (v1 && v1.command === 'npm test' && v2 && v2.command === 'npm run test:unit') || JSON.stringify([v1, v2]);
    });
    check('B16. 下游 B 重新跑了一次（新的 attempt 号是 2）', () => Boolean(attOf(fin, 'okB', 2)), JSON.stringify(attemptsOf(fin, 'okB').map((x) => x.attempt)));
    check('B17. 下游 B 的 Attempt 1 历史仍在', () => Boolean(attOf(fin, 'okB', 1)) && attOf(fin, 'okB', 1).outcomeStatus === 'success');
    check('B18. 全部跑完后计划回到 completed', () => fin.status === 'completed', fin.status);
  }

  /* ================= C. outcomeStatus 稳定 ================= */
  section('C. outcomeStatus 不会被后续操作改写');

  {
    /* A1 失败 → 重试 → A2 成功。A1 必须永远是 failed。 */
    resetFake();
    const p = await runPlan({ id: 'lc-c1', tasks: [{ id: 'failThenOk' }] });
    check('C-prep. A1 失败', () => attOf(p, 'failThenOk', 1).outcomeStatus === 'failed');
    const fin = await retryAndRun('lc-c1', 'failThenOk');
    check('C1. 重试成功后 A1 的 outcomeStatus 仍是 failed', () => attOf(fin, 'failThenOk', 1).outcomeStatus === 'failed', JSON.stringify(attOf(fin, 'failThenOk', 1).outcomeStatus));
    check('C2. A2 是 success（两条各自的结论互不影响）', () => attOf(fin, 'failThenOk', 2).outcomeStatus === 'success');
    check('C3. task.status 是 success，但历史里仍有一条 failed', () => taskOf(fin, 'failThenOk').status === 'success' && attemptsOf(fin, 'failThenOk').some((a) => a.outcomeStatus === 'failed'));
  }

  /* ================= D. Plan 状态与依赖 ================= */
  section('D. Plan 状态与依赖链');

  {
    /* completed 计划重试后必须能再次 start */
    const fin = load('lc-b1');
    runtime.setCurrentCwd(PROJ);
    const r = scheduler.retryTask(fin, 'okA');
    check('D-prep. completed 计划里再重试一次成功', () => r.ok === true, JSON.stringify(r));
    check('D1. completed → 重试后不再是 completed', () => load('lc-b1').status !== 'completed', load('lc-b1').status);
    const restarted = await scheduler.start(load('lc-b1'));
    check('D2. 重试后能再次 start（不会返回 settled / nothing-ready）', () => restarted.ok === true, JSON.stringify(restarted));
    await scheduler.waitIdle(20000);
    check('D3. 再跑一轮后计划又回到 completed', () => load('lc-b1').status === 'completed', load('lc-b1').status);
    check('D4. 两轮跑完 A 的历史是 [1,2,3]（严格递增、不复用）', () => JSON.stringify(attemptsOf(load('lc-b1'), 'okA').map((x) => x.attempt)) === JSON.stringify([1, 2, 3]), JSON.stringify(attemptsOf(load('lc-b1'), 'okA').map((x) => x.attempt)));
  }

  {
    /* failed 计划重试后必须能再次 start */
    resetFake();
    const p = await runPlan({ id: 'lc-d2', tasks: [{ id: 'failThenOk' }, { id: 'okB', dependsOn: ['failThenOk'] }] });
    check('D-prep2. 计划 paused/failed 且 B 被阻塞', () => (p.status === 'paused' || p.status === 'failed') && taskOf(p, 'okB').status === 'blocked', JSON.stringify({ s: p.status, b: taskOf(p, 'okB').status }));
    runtime.setCurrentCwd(PROJ);
    const r = scheduler.retryTask(load('lc-d2'), 'failThenOk');
    check('D5. 失败计划里重试失败任务成功', () => r.ok === true, JSON.stringify(r));
    const s = await scheduler.start(load('lc-d2'));
    check('D6. 重试后能再次 start（不会因为 Plan 处于 failed 而被拒）', () => s.ok === true, JSON.stringify(s));
    await scheduler.waitIdle(20000);
    const fin = load('lc-d2');
    check('D7. 跑完后 B 解锁并完成（依赖重新推进）', () => taskOf(fin, 'okB').status === 'success', taskOf(fin, 'okB').status);
    check('D8. A1 的失败历史仍在', () => attOf(fin, 'failThenOk', 1).outcomeStatus === 'failed');
  }

  {
    /* 上游重试时下游正在跑 → 拒绝 */
    resetFake();
    await startNoWait({ id: 'lc-d3', tasks: [{ id: 'okA' }, { id: 'slowB', dependsOn: ['okA'] }] });
    const win = await waitUntil('lc-d3', (p) => taskOf(p, 'okA').status === 'success' && taskOf(p, 'slowB').status === 'running');
    check('D-prep3. 拿到「A 完成、B 在跑」的窗口', () => Boolean(win));
    runtime.setCurrentCwd(PROJ);
    const r = scheduler.retryTask(load('lc-d3'), 'okA');
    check('D9. 下游正在执行时拒绝重试上游（不能在飞行中抽掉它的输入）', () => r.ok === false && r.code === 'busy', JSON.stringify(r));
    await scheduler.waitIdle(20000);
  }

  /* ================= E. Cancel / Shutdown / Restart ================= */
  section('E. 取消 / 关闭 / 重启不产生重复 attempt');

  {
    await startNoWait({ id: 'lc-e1', tasks: [{ id: 'hangA' }] });
    scheduler.cancelTask(load('lc-e1'), 'hangA');
    await scheduler.waitIdle(20000);
    const t = taskOf(load('lc-e1'), 'hangA');
    check('E1. 取消只形成**一条**历史 attempt', () => attemptsOf(load('lc-e1'), 'hangA').length === 1, JSON.stringify(attemptsOf(load('lc-e1'), 'hangA').map((a) => a.attempt)));
    check('E2. 那条的 outcomeStatus = cancelled', () => attOf(load('lc-e1'), 'hangA', 1).outcomeStatus === 'cancelled', JSON.stringify(attOf(load('lc-e1'), 'hangA', 1).outcomeStatus));
    check('E3. 取消后的 attempt 是 review=pending / revision=0', () => {
      const r = model.normalizeReview(attOf(load('lc-e1'), 'hangA', 1).review);
      return r.status === 'pending' && r.revision === 0;
    });
    check('E4. 取消不把 task 标成 failed（取消 ≠ 失败）', () => t.status === 'cancelled', t.status);
  }

  {
    await startNoWait({ id: 'lc-e2', tasks: [{ id: 'hangA' }] });
    scheduler.shutdown();
    await scheduler.waitIdle(20000);
    const p = load('lc-e2');
    check('E5. shutdown 只形成**一条** interrupted attempt', () => attemptsOf(p, 'hangA').length === 1, JSON.stringify(attemptsOf(p, 'hangA').map((a) => a.attempt)));
    const a = attOf(p, 'hangA', 1);
    check('E6. 那条的 outcomeStatus = interrupted（不是 cancelled）', () => a.outcomeStatus === 'interrupted', JSON.stringify(a.outcomeStatus));
    check('E7. shutdown 后 async finish 没有把 interrupted 改写成 cancelled', () => taskOf(p, 'hangA').status === 'interrupted', taskOf(p, 'hangA').status);
    check('E8. 中断的 attempt：filesChanged=[] 且标了采集不全（不猜）', () => a.filesChanged.length === 0 && a.changeCaptureIncomplete === true, JSON.stringify({ f: a.filesChanged, i: a.changeCaptureIncomplete }));
    check('E9. 中断的 attempt 带 review=pending', () => model.normalizeReview(a.review).status === 'pending');
  }

  {
    /* 优雅退出过之后再走一遍 recoverAll：不得再生成第二条 */
    const before = attemptsOf(load('lc-e2'), 'hangA').length;
    const r = store.recoverAll();
    check('E10. 已 interrupted 的任务不会被 recoverAll 再补一条', () => attemptsOf(load('lc-e2'), 'hangA').length === before, JSON.stringify({ before, after: attemptsOf(load('lc-e2'), 'hangA').length, scanned: r.scanned }));
  }

  {
    /* 硬崩：磁盘上停在 running，没有 attempt 记录（进程没来得及收尾） */
    runtime.setCurrentCwd(PROJ);
    const plan = mkPlan({ id: 'lc-e3', tasks: [{ id: 'hangA' }, { id: 'okB', dependsOn: ['hangA'] }] });
    plan.status = 'running'; // 真实崩溃现场：计划在执行中
    plan.tasks[0].status = 'running';
    plan.tasks[0].attempt = 1;
    plan.tasks[0].startedAt = Date.now() - 5000;
    plan.tasks[0].attempts = [];
    store.save(plan);
    check('E11-prep. 磁盘上确实是「running 但历史里没有这次执行」', () => {
      const p = load('lc-e3');
      return taskOf(p, 'hangA').status === 'running' && attemptsOf(p, 'hangA').length === 0;
    });
    const r = store.recoverAll();
    const p = load('lc-e3');
    const a = attOf(p, 'hangA', 1);
    check('E11. recoverAll 补了一条 interrupted attempt（不再出现「任务被中断但历史里找不到」）', () => Boolean(a) && a.outcomeStatus === 'interrupted', JSON.stringify(attemptsOf(p, 'hangA')));
    check('E12. 补的记录只写真的知道的：attempt 号与 startedAt', () => a && a.attempt === 1 && Number.isFinite(a.startedAt), JSON.stringify({ attempt: a && a.attempt, startedAt: a && a.startedAt }));
    check('E13. 拿不到的字段留空，不猜（sessionId / verificationSnapshot / filesChanged）', () => a && a.sessionId === null && a.verificationSnapshot === null && a.filesChanged.length === 0 && a.changeCaptureIncomplete === true, JSON.stringify({ s: a && a.sessionId, v: a && a.verificationSnapshot, f: a && a.filesChanged }));
    check('E14. 补的记录带 review=pending', () => a && model.normalizeReview(a.review).status === 'pending');
    check('E15. 任务被标成 interrupted、计划可继续', () => taskOf(p, 'hangA').status === 'interrupted' && p.status === 'paused', JSON.stringify({ t: taskOf(p, 'hangA').status, s: p.status }));
    check('E15b. recoverAll 的计数把这条算进去了', () => r.recovered >= 1, JSON.stringify(r));

    /* 再跑一次 recoverAll：不得重复补 */
    const n1 = attemptsOf(load('lc-e3'), 'hangA').length;
    store.recoverAll();
    check('E16. 再跑一次 recoverAll 不会重复补（attempt 号去重）', () => attemptsOf(load('lc-e3'), 'hangA').length === n1, JSON.stringify({ n1, n2: attemptsOf(load('lc-e3'), 'hangA').length }));
  }

  /* ================= F. 核心 E2E（规格 §37） ================= */
  section('F. 核心 E2E：A→B 跑完 → 接受 A → 改验证要求 → 重试 A → 再跑');

  {
    const fin = load('lc-b1');
    const a1 = attOf(fin, 'okA', 1);
    const a2 = attOf(fin, 'okA', 2);
    const a3 = attOf(fin, 'okA', 3);
    check('F1. A Attempt 1：outcome=success / review=accepted / note 保留 / snapshot=npm test', () => {
      const r = model.normalizeReview(a1.review);
      return (
        a1.outcomeStatus === 'success' &&
        r.status === 'accepted' &&
        r.note === '第一次通过' &&
        a1.verificationSnapshot &&
        a1.verificationSnapshot.command === 'npm test'
      ) || JSON.stringify({ o: a1.outcomeStatus, r, v: a1.verificationSnapshot });
    });
    check('F2. A Attempt 2：独立结论 / review=pending revision 0 / snapshot=npm run test:unit', () => {
      const r = model.normalizeReview(a2.review);
      return (
        a2.outcomeStatus === 'success' &&
        r.status === 'pending' &&
        r.revision === 0 &&
        a2.verificationSnapshot &&
        a2.verificationSnapshot.command === 'npm run test:unit'
      ) || JSON.stringify({ o: a2.outcomeStatus, r, v: a2.verificationSnapshot });
    });
    check('F3. A Attempt 3（D 段又跑了一轮）也在，且历史是 [1,2,3]', () => Boolean(a3) && JSON.stringify(attemptsOf(fin, 'okA').map((x) => x.attempt)) === JSON.stringify([1, 2, 3]));
    check('F4. B 的历史 attempt 仍然存在（1 与 2）', () => Boolean(attOf(fin, 'okB', 1)) && Boolean(attOf(fin, 'okB', 2)), JSON.stringify(attemptsOf(fin, 'okB').map((x) => x.attempt)));
    check('F5. B 的 Attempt 1 结论仍是 success（下游历史没被上游重试改写）', () => attOf(fin, 'okB', 1).outcomeStatus === 'success');
    check('F6. 三次 attempt 的 sessionId 两两不同', () => {
      const ids = attemptsOf(fin, 'okA').map((x) => x.sessionId);
      return ids.every((x) => Boolean(x)) && new Set(ids).size === ids.length || JSON.stringify(ids);
    });
    check('F7. 三次 attempt 的 filesChanged 各自独立保留', () => attemptsOf(fin, 'okA').every((x) => Array.isArray(x.filesChanged) && x.filesChanged.length > 0), JSON.stringify(attemptsOf(fin, 'okA').map((x) => x.filesChanged)));
  }

  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n测试自身抛错：', err && err.stack ? err.stack : err);
  cleanup();
  process.exit(1);
});
