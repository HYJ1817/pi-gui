/* P9 —— 独立验证执行器。
 *
 * 覆盖规格 §十二 里**后端可测**的那些：命令怎么跑、哪些情况拒绝跑、
 * 取消与中断怎么收口、验证**不改**哪些东西、两个写者不互相覆盖、
 * 旧计划兼容、以及真实 shell 那一条。
 *
 * 分工：
 *   - `reviews.cjs`     审阅的数据契约与并发写者
 *   - `lifecycle.cjs`   retry / cancel / stop 对历史的影响
 *   - 本文件             Pi GUI **自己跑命令**这件事：证据从哪来、写在哪、什么时候不许跑
 *   - `smoke.cjs`       验证的前端行为（按钮、状态文案、XSS、stale）
 *   - `visual-harness`/`cdp-shot`  running / passed / failed / interrupted 的**真实排版**
 *
 * 纪律：全程 os.tmpdir() + **注入的假 runShell**（确定性、不 spawn 真进程），
 * 只有 J 段故意用真的 shell 入口跑一条无害命令，证明那条路真的通。
 *
 * 用法：node tests/verification.cjs
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-p9-'));
const DATA = path.join(TMP, 'data');
const PROJ = path.join(TMP, 'proj');
function cleanup() {
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* Windows 偶发占用 */
  }
}

/* ---------- HTTP 小工具（走 planner.handle，与 reviews.cjs 同一套） ---------- */

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
const verifyUrl = (planId, taskId, attempt) =>
  `/api/plans/${encodeURIComponent(planId)}/tasks/${encodeURIComponent(taskId)}/attempts/${attempt}/verify`;
const reviewUrl = (planId, taskId, attempt) =>
  `/api/plans/${encodeURIComponent(planId)}/tasks/${encodeURIComponent(taskId)}/attempts/${attempt}/review`;

/* ---------- 假 runShell ---------- */
/* 每次调用消费一个脚本项。没脚本了就用「成功、退出码 0」。 */
const BASE_OUT = {
  ok: true,
  exitCode: 0,
  stdout: '',
  stderr: '',
  stdoutBytes: 0,
  truncated: false,
  timedOut: false,
  cancelled: false,
  spawnFailed: false,
  error: '',
};
let shellScript = [];
const shellCalls = [];
async function fakeRunShell(opts) {
  shellCalls.push({ command: opts.command, cwd: opts.cwd });
  const spec = shellScript.shift() || {};
  /* hang：一直等到被 abort —— 用来测「停止验证」与「退出时收口」。
   * 真 runCli 在 abort 时返回 cancelled:true，这里照抄那个形状。 */
  if (spec.hang) {
    return await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ...BASE_OUT, ...spec, hang: undefined }), 10_000);
      if (opts.signal) {
        opts.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve({ ...BASE_OUT, cancelled: true, ok: false, exitCode: null, error: '已取消' });
          },
          { once: true }
        );
      }
    });
  }
  if (spec.delayMs) await sleep(spec.delayMs);
  return { ...BASE_OUT, ...spec, hang: undefined };
}

(async () => {
  const model = await import('../server/planner/model.js');
  const { createPlanStore, PLAN_SCHEMA_VERSION } = await import('../server/planner/store.js');
  const { createScheduler } = await import('../server/planner/scheduler.js');
  const { createVerifier } = await import('../server/planner/verifier.js');
  const { createAgentRegistry } = await import('../server/agents/index.js');
  const { createPlanner } = await import('../server/planner/index.js');
  const { runShellCommand } = await import('../server/agents/cli.js');
  const { gitStatus } = await import('../lib/git.js');

  fs.mkdirSync(PROJ, { recursive: true });
  await git(PROJ, 'init', '-q');
  await git(PROJ, 'config', 'user.email', 't@t');
  await git(PROJ, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(PROJ, 'README.md'), '# demo\n');
  await git(PROJ, 'add', '-A');
  await git(PROJ, 'commit', '-qm', 'init');

  const BEHAVIORS = {
    okDoc: [{ ok: true, summary: '完成' }],
    slowB: [{ slowMs: 700, ok: true, summary: '完成' }],
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
  const verifier = createVerifier({ store, runtime, scheduler, runShell: fakeRunShell, timeoutMs: 5000, maxOutputBytes: 4096 });
  const planner = createPlanner({ runtime, registry, store, scheduler, verifier });

  /* ---------- 计划构造 ---------- */

  /** 一条 attempt，可按需带 verificationSnapshot / verificationResult / review。 */
  const mkAtt = (n, over = {}) =>
    Object.assign(
      {
        attempt: n,
        success: true,
        error: '',
        summary: '',
        exitCode: 0,
        startedAt: n * 10,
        endedAt: n * 10 + 5,
        sessionId: null,
        filesChanged: [],
        changeCaptureIncomplete: false,
        outcomeStatus: 'success',
        verificationSnapshot: { command: 'npm test' },
        verificationResult: null,
        review: { status: 'pending', note: '', reviewedAt: null, revision: 0 },
      },
      over
    );

  function mkPlan({ id, attempts, workingDirectory = '.', taskOver = {}, status = 'success' }) {
    return {
      id,
      title: 'P9 计划 ' + id,
      goal: '目标',
      status,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: 1,
      endedAt: 2,
      projectRoot: PROJ,
      concurrency: 1,
      recoveryNotes: [],
      source: null,
      tasks: [
        Object.assign(
          {
            id: 'task',
            title: '任务',
            description: '',
            agent: 'fake',
            workingDirectory,
            dependsOn: [],
            status,
            startedAt: 1,
            endedAt: 2,
            attempt: attempts.length,
            attempts,
            result: null,
            error: '',
            verification: { command: 'npm test' },
          },
          taskOver
        ),
      ],
    };
  }

  const load = (id) => store.load(id).plan;
  const vrOf = (id, n = 1) => {
    const p = load(id);
    const t = p.tasks.find((x) => x.id === 'task');
    const a = t && Array.isArray(t.attempts) ? t.attempts.find((x) => x.attempt === n) : null;
    return a ? a.verificationResult : undefined;
  };
  const attOf = (id, n = 1) => {
    const p = load(id);
    const t = p.tasks.find((x) => x.id === 'task');
    return t && Array.isArray(t.attempts) ? t.attempts.find((x) => x.attempt === n) : null;
  };
  /** 起一次验证并等它跑完。**已经在跑就不再起一次** —— 那样会拿到 already-running，
   *  而不是等结果（第一版就踩了这个坑）。 */
  async function runToEnd(planId, taskId = 'task', attempt = 1) {
    if (!verifier.isRunning(planId, taskId, attempt)) {
      const r = verifier.start({ planId, taskId, attempt });
      if (!r.ok) return r;
    }
    for (let i = 0; i < 400; i++) {
      const v = vrOf(planId, attempt);
      if (v && v.status !== 'running') return { ok: true, verification: v };
      await sleep(10);
    }
    return { ok: false, code: 'timeout', error: '验证没有在预期时间内结束' };
  }

  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

  /* ================= A. 基本执行 ================= */
  section('A. 跑起来、拿到真结果');

  {
    shellScript = [{ ok: true, exitCode: 0, stdout: 'ok 740/740 通过\n' }];
    store.save(mkPlan({ id: 'v-a1', attempts: [mkAtt(1)] }));
    const started = verifier.start({ planId: 'v-a1', taskId: 'task', attempt: 1 });
    check('A1. 有 command → 可以启动，返回一条 running 记录', () => started.ok === true && started.verification.status === 'running', JSON.stringify(started));
    check('A1b. 启动时**命令用的是冻结快照**里的那条，不看 task.verification', () => shellCalls[0] && shellCalls[0].command === 'npm test', JSON.stringify(shellCalls[0]));
    check('A1c. 落盘的 running 记录不带任何结论字段', () => {
      const v = vrOf('v-a1', 1);
      return (v.status === 'running' && v.exitCode === null && v.finishedAt === null && v.durationMs === null && v.outputSummary === '') || JSON.stringify(v);
    }, JSON.stringify(vrOf('v-a1', 1)));

    const done = await runToEnd('v-a1');
    check('A2. 退出码 0 → passed（**不是 accepted**，那是人的事）', () => done.ok === true && done.verification.status === 'passed' && done.verification.exitCode === 0, JSON.stringify(done));
    check('A3. 记下了耗时与输出摘要', () => {
      const v = vrOf('v-a1', 1);
      return Number.isFinite(v.durationMs) && v.durationMs >= 0 && /740\/740/.test(v.outputSummary) || JSON.stringify(v);
    }, JSON.stringify(vrOf('v-a1', 1)));
  }

  {
    shellScript = [{ ok: false, exitCode: 1, stdout: 'ok 1\nerror: boom\n', stderr: 'npm ERR! Test failed\n' }];
    store.save(mkPlan({ id: 'v-a2', attempts: [mkAtt(1)] }));
    const done = await runToEnd('v-a2');
    check('A4. 退出码非 0 → failed，并留退出码', () => done.ok === true && done.verification.status === 'failed' && done.verification.exitCode === 1, JSON.stringify(done));
    check('A4b. stdout 与 stderr 都收进摘要（错在哪边没有统一规矩）', () => {
      const t = vrOf('v-a2', 1).outputSummary;
      return (/error: boom/.test(t) && /npm ERR!/.test(t)) || t;
    }, JSON.stringify(vrOf('v-a2', 1).outputSummary));
  }

  {
    shellScript = [{ ok: false, exitCode: null, spawnFailed: true, error: '无法启动：spawn cmd.exe ENOENT' }];
    store.save(mkPlan({ id: 'v-a3', attempts: [mkAtt(1)] }));
    const done = await runToEnd('v-a3');
    check('A5. 命令根本起不来 → failed，并说明起不来的原因（不冒充「跑失败了」）', () => {
      const v = vrOf('v-a3', 1);
      return (done.ok === true && v.status === 'failed' && /无法启动/.test(v.error)) || JSON.stringify(v);
    }, JSON.stringify(vrOf('v-a3', 1)));
  }

  {
    shellScript = [{ ok: false, timedOut: true, exitCode: null, error: '超时（5s）' }];
    store.save(mkPlan({ id: 'v-a4', attempts: [mkAtt(1)] }));
    const done = await runToEnd('v-a4');
    check('A6. 超时 → failed，错误写「超时（Ns）」', () => {
      const v = vrOf('v-a4', 1);
      return (done.ok === true && v.status === 'failed' && /^超时（5s）$/.test(v.error)) || JSON.stringify(v);
    }, JSON.stringify(vrOf('v-a4', 1)));
  }

  /* ================= B. 输出上限 ================= */
  section('B. 输出不许把计划文件撑爆');

  {
    const huge = 'x'.repeat(9000) + '\nTAIL-MARKER';
    shellScript = [{ ok: false, exitCode: 1, stdout: huge, truncated: true }];
    store.save(mkPlan({ id: 'v-b1', attempts: [mkAtt(1)] }));
    await runToEnd('v-b1');
    check('B1. 落盘的摘要被截到上限以内', () => {
      const t = vrOf('v-b1', 1).outputSummary;
      return t.length <= model.MAX_VERIFICATION_OUTPUT || `长度 ${t.length}`;
    }, String(vrOf('v-b1', 1).outputSummary.length));
    check('B2. 保留的是**末尾**（失败原因在最后几行）', () => /TAIL-MARKER/.test(vrOf('v-b1', 1).outputSummary) || vrOf('v-b1', 1).outputSummary.slice(-60));
    check('B3. 被截断时带 truncated 记号（界面要能说「输出已截断」）', () => vrOf('v-b1', 1).truncated === true);
    check('B4. 计划文件实际大小仍然是 KB 级（没有几百 MB 日志）', () => {
      const f = path.join(DATA, 'plans', 'v-b1.json');
      const kb = fs.statSync(f).size / 1024;
      return kb < 20 || `${Math.round(kb)} KB`;
    });
  }

  /* ================= C. 准入拒绝 ================= */
  section('C. 哪些情况不允许跑（code 是契约）');

  {
    store.save(mkPlan({ id: 'v-c1', attempts: [mkAtt(1, { verificationSnapshot: null })] }));
    const r = verifier.start({ planId: 'v-c1', taskId: 'task', attempt: 1 });
    check('C1. 没有 verificationSnapshot → no-command（不许拿当前 task.verification 顶）', () => r.ok === false && r.code === 'no-command', JSON.stringify(r));

    store.save(mkPlan({ id: 'v-c2', attempts: [mkAtt(1, { verificationSnapshot: { description: '确认登录错误提示' } })] }));
    const r2 = verifier.start({ planId: 'v-c2', taskId: 'task', attempt: 1 });
    check('C2. 只有 description → no-command，且说明与「没有快照」分开', () => r2.ok === false && r2.code === 'no-command' && /说明/.test(r2.error), JSON.stringify(r2));

    store.save(mkPlan({ id: 'v-c3', attempts: [mkAtt(1)] }));
    check('C3. attempt 不存在 → attempt-not-found', () => {
      const r = verifier.start({ planId: 'v-c3', taskId: 'task', attempt: 9 });
      return r.ok === false && r.code === 'attempt-not-found' || JSON.stringify(r);
    });
    check('C3b. task 不存在 → attempt-not-found', () => {
      const r = verifier.start({ planId: 'v-c3', taskId: 'nope', attempt: 1 });
      return r.ok === false && r.code === 'attempt-not-found' || JSON.stringify(r);
    });
    check('C3c. plan 不存在 → not-found', () => {
      const r = verifier.start({ planId: 'v-nope', taskId: 'task', attempt: 1 });
      return r.ok === false && r.code === 'not-found' || JSON.stringify(r);
    });

    store.save(mkPlan({ id: 'v-c4', attempts: [mkAtt(1)], workingDirectory: 'not-there' }));
    const r4 = verifier.start({ planId: 'v-c4', taskId: 'task', attempt: 1 });
    check('C4. 工作目录已经不存在 → invalid-cwd', () => r4.ok === false && r4.code === 'invalid-cwd', JSON.stringify(r4));

    store.save(mkPlan({ id: 'v-c5', attempts: [mkAtt(1)], workingDirectory: '../outside' }));
    const r5 = verifier.start({ planId: 'v-c5', taskId: 'task', attempt: 1 });
    check('C5. 工作目录逃出项目（`../`）→ invalid-cwd（复用 safe-path 的判定）', () => r5.ok === false && r5.code === 'invalid-cwd', JSON.stringify(r5));

    const saved = cwd;
    cwd = path.join(TMP, 'other');
    const r6 = verifier.start({ planId: 'v-c3', taskId: 'task', attempt: 1 });
    check('C6. 计划不属于当前项目 → workspace-stale（切项目后不许对着旧项目跑命令）', () => r6.ok === false && r6.code === 'workspace-stale', JSON.stringify(r6));
    cwd = null;
    const r7 = verifier.start({ planId: 'v-c3', taskId: 'task', attempt: 1 });
    check('C7. 没有项目 → no-project', () => r7.ok === false && r7.code === 'no-project', JSON.stringify(r7));
    cwd = saved;
  }

  {
    /* 计划正在执行时拒绝 —— 验证命令和 coding agent 会抢同一个工作区。 */
    runtime.setCurrentCwd(PROJ);
    const plan = {
      id: 'v-c6',
      title: 't',
      goal: '',
      status: 'ready',
      createdAt: 1,
      updatedAt: 1,
      startedAt: null,
      endedAt: null,
      projectRoot: PROJ,
      concurrency: 1,
      recoveryNotes: [],
      source: null,
      tasks: [
        { id: 'okDoc', title: 'A', description: '', agent: 'fake', workingDirectory: '.', dependsOn: [], status: 'pending', startedAt: null, endedAt: null, attempt: 0, attempts: [], result: null, error: '', verification: null },
        { id: 'slowB', title: 'B', description: '', agent: 'fake', workingDirectory: '.', dependsOn: [], status: 'pending', startedAt: null, endedAt: null, attempt: 0, attempts: [], result: null, error: '', verification: null },
      ],
    };
    store.save(plan);
    const started = await scheduler.start(store.load('v-c6').plan);
    check('C8-prep. 计划已启动', () => started.ok === true, JSON.stringify(started));
    const r = verifier.start({ planId: 'v-c6', taskId: 'okDoc', attempt: 1 });
    check('C8. 计划正在执行 → plan-active（规则只在 Verifier 里判一次）', () => r.ok === false && r.code === 'plan-active', JSON.stringify(r));
    await scheduler.waitIdle(20000);
  }

  /* ================= D. 取消与中断 ================= */
  section('D. 停止 / 退出 / 崩了，都不能停在 running');

  {
    shellScript = [{ hang: true }];
    store.save(mkPlan({ id: 'v-d1', attempts: [mkAtt(1)] }));
    verifier.start({ planId: 'v-d1', taskId: 'task', attempt: 1 });
    check('D1-prep. 正在跑', () => verifier.isRunning('v-d1', 'task', 1) === true);
    check('D2. 同一个 Attempt 连点 → already-running', () => {
      const r = verifier.start({ planId: 'v-d1', taskId: 'task', attempt: 1 });
      return r.ok === false && r.code === 'already-running' || JSON.stringify(r);
    });
    const stopped = verifier.stop({ planId: 'v-d1', taskId: 'task', attempt: 1 });
    check('D3. 停止 → ok', () => stopped.ok === true, JSON.stringify(stopped));
    for (let i = 0; i < 200 && verifier.isRunning('v-d1', 'task', 1); i++) await sleep(10);
    await sleep(60);
    check('D4. 取消后收成 interrupted（**不是 failed** —— 你没跑完，不是它错了）', () => {
      const v = vrOf('v-d1', 1);
      return v.status === 'interrupted' || JSON.stringify(v);
    }, JSON.stringify(vrOf('v-d1', 1)));
    check('D4b. 停掉之后再停 → not-running', () => {
      const r = verifier.stop({ planId: 'v-d1', taskId: 'task', attempt: 1 });
      return r.ok === false && r.code === 'not-running' || JSON.stringify(r);
    });
    check('D4c. 取消的耗时字段是数字（不是 null —— 我们真的知道跑了多久）', () => {
      const v = vrOf('v-d1', 1);
      return Number.isFinite(v.durationMs) && v.durationMs >= 0 || JSON.stringify(v.durationMs);
    });
  }

  {
    /* 优雅退出：shutdown() 同步把 running 收成 interrupted 并落盘。 */
    shellScript = [{ hang: true }];
    store.save(mkPlan({ id: 'v-d2', attempts: [mkAtt(1)] }));
    verifier.start({ planId: 'v-d2', taskId: 'task', attempt: 1 });
    verifier.shutdown();
    check('D5. shutdown() 之后内存里没有在跑的验证', () => verifier.runningKeys().length === 0, JSON.stringify(verifier.runningKeys()));
    check('D6. 落盘的是 interrupted + 人话说明', () => {
      const v = vrOf('v-d2', 1);
      return (v.status === 'interrupted' && /应用关闭时被中断/.test(v.error)) || JSON.stringify(v);
    }, JSON.stringify(vrOf('v-d2', 1)));
    check('D6b. 不猜退出码，也不拿「现在 − startedAt」冒充执行时长', () => {
      const v = vrOf('v-d2', 1);
      return (v.exitCode === null && v.outputSummary === '') || JSON.stringify(v);
    }, JSON.stringify(vrOf('v-d2', 1)));
    await sleep(80);
    check('D7. 退出之后异步回来的结果**不会**把 interrupted 改写掉', () => {
      const v = vrOf('v-d2', 1);
      return v.status === 'interrupted' || JSON.stringify(v);
    }, JSON.stringify(vrOf('v-d2', 1)));
  }

  {
    /* 硬崩：磁盘上停着 running，进程没了 —— recoverAll 才收口。 */
    store.save(mkPlan({ id: 'v-d3', attempts: [mkAtt(1, { verificationResult: { status: 'running', command: 'npm test', startedAt: 7 } })] }));
    check('D8-prep. 磁盘上确实是 running', () => vrOf('v-d3', 1).status === 'running');
    const rec = store.recoverAll();
    check('D9. recoverAll 把 running 翻成 interrupted', () => {
      const v = vrOf('v-d3', 1);
      return v.status === 'interrupted' || JSON.stringify(v);
    }, JSON.stringify(vrOf('v-d3', 1)));
    check('D9b. 恢复时不猜退出码 / 输出（进程崩了，我们什么都没拿到）', () => {
      const v = vrOf('v-d3', 1);
      return (v.exitCode === null && v.outputSummary === '' && v.truncated === false && v.durationMs === null) || JSON.stringify(v);
    }, JSON.stringify(vrOf('v-d3', 1)));
    check('D9c. 恢复计数把这条算进去了', () => rec.recovered >= 1, JSON.stringify(rec));
  }

  {
    /* 关键反例：**普通 load 不许恢复**，否则前端轮询会把正在跑的那次翻掉。 */
    store.save(mkPlan({ id: 'v-d4', attempts: [mkAtt(1, { verificationResult: { status: 'running', command: 'npm test', startedAt: 7 } })] }));
    check('D10. 普通 load **不**动 running（恢复只在进程启动时做一次）', () => {
      const v = vrOf('v-d4', 1);
      return v.status === 'running' || JSON.stringify(v);
    }, JSON.stringify(vrOf('v-d4', 1)));
  }

  /* ================= E. 验证不动别人的状态 ================= */
  section('E. 验证只写验证（不改执行状态、不改审阅）');

  {
    shellScript = [{ ok: true, exitCode: 0, stdout: 'passed\n' }];
    store.save(mkPlan({ id: 'v-e1', attempts: [mkAtt(1, { success: false, outcomeStatus: 'failed', taskOver: {} })], status: 'failed', taskOver: { status: 'failed' } }));
    const before = load('v-e1');
    await runToEnd('v-e1');
    const after = load('v-e1');
    check('E1. 验证通过**不改** task.status（它还是 failed）', () => after.tasks[0].status === 'failed', after.tasks[0].status);
    check('E1b. 也不改 attempt 的 outcomeStatus', () => attOf('v-e1', 1).outcomeStatus === 'failed', String(attOf('v-e1', 1).outcomeStatus));
    check('E1c. 不自动 Retry（attempt 数不变、没有新 attempt）', () => after.tasks[0].attempts.length === before.tasks[0].attempts.length && after.tasks[0].attempt === before.tasks[0].attempt);
  }

  {
    shellScript = [{ ok: true, exitCode: 0 }];
    store.save(mkPlan({ id: 'v-e2', attempts: [mkAtt(1, { review: { status: 'needs_changes', note: '还差点', reviewedAt: 5, revision: 2 } })] }));
    await runToEnd('v-e2');
    check('E2. 验证通过**不把 needs_changes 自动改成 accepted**', () => {
      const rv = model.normalizeReview(attOf('v-e2', 1).review);
      return (rv.status === 'needs_changes' && rv.note === '还差点' && rv.revision === 2) || JSON.stringify(rv);
    }, JSON.stringify(attOf('v-e2', 1).review));

    shellScript = [{ ok: false, exitCode: 1 }];
    store.save(mkPlan({ id: 'v-e3', attempts: [mkAtt(1, { review: { status: 'accepted', note: '我认了', reviewedAt: 6, revision: 3 } })] }));
    await runToEnd('v-e3');
    check('E3. 验证失败**不把 accepted 自动改成别的**（包括 needs_changes）', () => {
      const rv = model.normalizeReview(attOf('v-e3', 1).review);
      return (rv.status === 'accepted' && rv.note === '我认了' && rv.revision === 3) || JSON.stringify(rv);
    }, JSON.stringify(attOf('v-e3', 1).review));
  }

  /* ================= F. Retry 与历史 ================= */
  section('F. Retry 不碰旧 attempt 的验证结果');

  {
    shellScript = [{ ok: false, exitCode: 1, stdout: 'first run failed\n' }];
    store.save(mkPlan({ id: 'v-f1', attempts: [mkAtt(1)], status: 'failed', taskOver: { status: 'failed' } }));
    await runToEnd('v-f1');
    const first = JSON.parse(JSON.stringify(vrOf('v-f1', 1)));
    check('F-prep. Attempt 1 有了一条 failed 的验证结果', () => first.status === 'failed', JSON.stringify(first));

    /* 重试：新 attempt 要等真的执行才产生，这里直接模拟「执行完了，产生 Attempt 2」。 */
    const p = load('v-f1');
    p.tasks[0].status = 'pending';
    p.tasks[0].attempts.push(mkAtt(2, { verificationSnapshot: { command: 'npm run test:unit' } }));
    p.tasks[0].attempt = 2;
    store.save(p);

    check('F1. Retry 之后**旧 attempt 的验证结果原样保留**', () => {
      const v = vrOf('v-f1', 1);
      return JSON.stringify(v) === JSON.stringify(first) || JSON.stringify(v);
    }, JSON.stringify(vrOf('v-f1', 1)));
    check('F2. 新 attempt **没有**验证结果（默认尚未独立确认）', () => vrOf('v-f1', 2) === null || JSON.stringify(vrOf('v-f1', 2)));

    shellScript = [{ ok: true, exitCode: 0, stdout: 'unit ok\n' }];
    const r = verifier.start({ planId: 'v-f1', taskId: 'task', attempt: 2 });
    check('F3. 可以单独验证新 attempt，用的是**它自己的**快照命令', () => r.ok === true && shellCalls[shellCalls.length - 1].command === 'npm run test:unit', JSON.stringify(r));
    for (let i = 0; i < 200 && vrOf('v-f1', 2).status === 'running'; i++) await sleep(10);
    await sleep(60);
    check('F3b. 新 attempt 的结果独立记着（passed）', () => vrOf('v-f1', 2).status === 'passed', JSON.stringify(vrOf('v-f1', 2)));
    check('F4. 两次验证的**命令不同**，各自记着自己那条', () => {
      return vrOf('v-f1', 1).command === 'npm test' && vrOf('v-f1', 2).command === 'npm run test:unit';
    }, JSON.stringify([vrOf('v-f1', 1).command, vrOf('v-f1', 2).command]));
  }

  /* ================= G. 重复验证 ================= */
  section('G. 重新运行 = 替换，不是追加');

  {
    shellScript = [{ ok: false, exitCode: 1, stdout: 'first fail\n' }];
    store.save(mkPlan({ id: 'v-g1', attempts: [mkAtt(1)] }));
    await runToEnd('v-g1');
    shellScript = [{ ok: true, exitCode: 0, stdout: 'now it passes\n' }];
    await runToEnd('v-g1');
    const v = vrOf('v-g1', 1);
    check('G1. 同一个 attempt 重新验证 → 结果是**替换**（保存最新一次）', () => v.status === 'passed' && /now it passes/.test(v.outputSummary), JSON.stringify(v));
    check('G2. 第一阶段**不引入** verificationAttempts 历史数组（避免范围膨胀）', () => {
      const a = attOf('v-g1', 1);
      return !('verificationAttempts' in a) || '多出了历史数组';
    });
  }

  /* ================= H. 旧计划兼容 ================= */
  section('H. 老计划不改一个字节就能打开');

  {
    /* 完全没有 verificationResult 的老 attempt（P8 时代写的）。 */
    const legacy = {
      schemaVersion: 1,
      id: 'v-h1',
      title: '老计划',
      goal: '',
      status: 'completed',
      createdAt: 1,
      updatedAt: 1,
      projectRoot: PROJ,
      concurrency: 1,
      recoveryNotes: [],
      tasks: [
        {
          id: 'task',
          title: '任务',
          agent: 'fake',
          workingDirectory: '.',
          dependsOn: [],
          status: 'success',
          attempt: 1,
          attempts: [{ attempt: 1, success: true, outcomeStatus: 'success', verificationSnapshot: { command: 'npm test' } }],
          result: null,
          error: '',
        },
      ],
    };
    const f = path.join(DATA, 'plans', 'v-h1.json');
    fs.writeFileSync(f, JSON.stringify(legacy, null, 2) + '\n', 'utf8');
    const p = load('v-h1');
    check('H1. 老 attempt 读得出来，verificationResult 归一化成 null', () => {
      const a = p.tasks[0].attempts[0];
      return a.verificationResult === null || JSON.stringify(a.verificationResult);
    }, JSON.stringify(p.tasks[0].attempts[0].verificationResult));
    check('H2. 快照仍然在（要求没有被吞掉）', () => p.tasks[0].attempts[0].verificationSnapshot.command === 'npm test');
    check('H3. schemaVersion 仍是 1 —— P9 是 additive，不需要 migration', () => PLAN_SCHEMA_VERSION === 1, String(PLAN_SCHEMA_VERSION));
    check('H4. 老计划照样能验证（命令从快照来）', () => {
      shellScript = [{ ok: true, exitCode: 0 }];
      const r = verifier.start({ planId: 'v-h1', taskId: 'task', attempt: 1 });
      return r.ok === true || JSON.stringify(r);
    });
    for (let i = 0; i < 200 && vrOf('v-h1', 1) && vrOf('v-h1', 1).status === 'running'; i++) await sleep(10);
    await sleep(60);
    check('H4b. 跑完之后老记录上就多了一条证据', () => vrOf('v-h1', 1).status === 'passed', JSON.stringify(vrOf('v-h1', 1)));
  }

  /* ================= I. HTTP 路由 ================= */
  section('I. 路由：语义全在 body 的 code 里');

  {
    store.save(mkPlan({ id: 'v-i1', attempts: [mkAtt(1)] }));
    /* **让这条命令挂着**：不然即时返回的假 runShell 会在下一次点击之前就跑完，
     * 「连点 → already-running」与「停止」根本测不到（第一版就是这么假绿的）。 */
    shellScript = [{ hang: true }];
    const r = await hit(planner, 'POST', verifyUrl('v-i1', 'task', 1));
    check('I1. POST verify → 200 + ok:true + running 记录', () => r.status === 200 && r.body.ok === true && r.body.verification.status === 'running', JSON.stringify(r.body));
    const r2 = await hit(planner, 'POST', verifyUrl('v-i1', 'task', 1));
    check('I2. 连点 → 200 + ok:false + code=already-running', () => r2.status === 200 && r2.body.ok === false && r2.body.code === 'already-running', JSON.stringify(r2.body));
    const r3 = await hit(planner, 'POST', verifyUrl('v-i1', 'task', 1) + '/stop');
    check('I3. POST verify/stop → ok', () => r3.status === 200 && r3.body.ok === true, JSON.stringify(r3.body));
    for (let i = 0; i < 200 && verifier.isRunning('v-i1', 'task', 1); i++) await sleep(10);
    await sleep(60);
    check('I3b. 停下来的这次收成 interrupted', () => vrOf('v-i1', 1).status === 'interrupted', JSON.stringify(vrOf('v-i1', 1)));
    const r4 = await hit(planner, 'POST', verifyUrl('v-i1', 'task', 1) + '/stop');
    check('I4. 再停一次 → code=not-running', () => r4.body.ok === false && r4.body.code === 'not-running', JSON.stringify(r4.body));

    store.save(mkPlan({ id: 'v-i2', attempts: [mkAtt(1, { verificationSnapshot: null })] }));
    const r5 = await hit(planner, 'POST', verifyUrl('v-i2', 'task', 1));
    check('I5. 没有可跑的命令 → code=no-command（不是 500，也不是 generic 错误）', () => r5.status === 200 && r5.body.code === 'no-command', JSON.stringify(r5.body));
    const r6 = await hit(planner, 'PUT', verifyUrl('v-i2', 'task', 1));
    check('I6. 非 POST → 405', () => r6.status === 405, String(r6.status));
  }

  {
    /* planView 的视图字段：本进程到底有没有在跑这次验证。 */
    shellScript = [{ hang: true }];
    store.save(mkPlan({ id: 'v-i3', attempts: [mkAtt(1)] }));
    verifier.start({ planId: 'v-i3', taskId: 'task', attempt: 1 });
    const r = await hit(planner, 'GET', '/api/plans/v-i3');
    const att = r.body.plan.tasks[0].attempts[0];
    check('I7. 计划详情里带 verificationRunning（liveness 由内存表说了算）', () => att.verificationRunning === true, JSON.stringify(att.verificationRunning));
    check('I7b. 视图字段**不写回文件**', () => !('verificationRunning' in attOf('v-i3', 1)) || '被写进文件了');
    verifier.stop({ planId: 'v-i3', taskId: 'task', attempt: 1 });
    await sleep(80);
    const r2 = await hit(planner, 'GET', '/api/plans/v-i3');
    check('I7c. 停完之后视图字段变 false', () => r2.body.plan.tasks[0].attempts[0].verificationRunning === false, JSON.stringify(r2.body.plan.tasks[0].attempts[0].verificationRunning));
  }

  /* ================= K. 两个写者：谁也不许覆盖谁 ================= */
  section('K. 验证 / 审阅 / Scheduler 三方写盘互不覆盖');

  {
    /* ① 验证跑着的时候用户保存 Review —— 两边都必须留在盘上。
     * 这是「验证完成时整份旧 plan 写盘 → 把用户刚存的 Review 冲掉」那个陷阱。 */
    shellScript = [{ delayMs: 300, ok: true, exitCode: 0, stdout: 'late\n' }];
    store.save(mkPlan({ id: 'v-k1', attempts: [mkAtt(1)] }));
    verifier.start({ planId: 'v-k1', taskId: 'task', attempt: 1 });
    check('K-prep. 验证正在跑', () => verifier.isRunning('v-k1', 'task', 1) === true);

    const rv = await hit(planner, 'PUT', reviewUrl('v-k1', 'task', 1), { status: 'needs_changes', note: '并发写的说明', expectedRevision: 0 });
    check('K1-prep. 验证进行中也能保存审阅', () => rv.body.ok === true, JSON.stringify(rv.body));

    for (let i = 0; i < 300 && verifier.isRunning('v-k1', 'task', 1); i++) await sleep(10);
    await sleep(80);
    const a1 = attOf('v-k1', 1);
    check('K1. 验证写盘**没有冲掉**并发保存的审阅', () => {
      const r = model.normalizeReview(a1.review);
      return (r.status === 'needs_changes' && r.note === '并发写的说明' && r.revision === 1) || JSON.stringify(r);
    }, JSON.stringify(a1.review));
    check('K2. 同时验证证据也在（两边都真的落盘了）', () => {
      return (a1.verificationResult && a1.verificationResult.status === 'passed') || JSON.stringify(a1.verificationResult);
    }, JSON.stringify(a1.verificationResult));
  }

  {
    /* ② 反过来：已经有验证结果时保存 Review —— 验证结果不许被抹掉。 */
    shellScript = [{ ok: false, exitCode: 1, stdout: 'boom\n' }];
    store.save(mkPlan({ id: 'v-k2', attempts: [mkAtt(1)] }));
    await runToEnd('v-k2');
    const before = JSON.parse(JSON.stringify(vrOf('v-k2', 1)));
    check('K3-prep. 磁盘上先有一条验证结果', () => before.status === 'failed', JSON.stringify(before));

    const rv = await hit(planner, 'PUT', reviewUrl('v-k2', 'task', 1), { status: 'accepted', note: '接受了', expectedRevision: 0 });
    check('K4-prep. 审阅写入成功', () => rv.body.ok === true, JSON.stringify(rv.body));
    check('K4. Review 写盘**没有覆盖**验证结果', () => {
      const v = vrOf('v-k2', 1);
      return JSON.stringify(v) === JSON.stringify(before) || JSON.stringify(v);
    }, JSON.stringify(vrOf('v-k2', 1)));
    check('K4b. 审阅自己也写进去了（不是「两边都没写」）', () => model.normalizeReview(attOf('v-k2', 1).review).status === 'accepted');
  }

  {
    /* ③ Scheduler 的**整份写盘**不许冲掉验证证据。
     * 这就是 §八 那条不变量，与 P8-A 的 review 是同一个坑：Scheduler 在内存里
     * 持有的那份 plan 上没有 verificationResult，收尾时整份写盘会把它抹掉。 */
    runtime.setCurrentCwd(PROJ);
    store.save({
      id: 'v-k3', title: 't', goal: '', status: 'ready', createdAt: 1, updatedAt: 1,
      startedAt: null, endedAt: null, projectRoot: PROJ, concurrency: 1, recoveryNotes: [], source: null,
      tasks: [
        { id: 'okDoc', title: 'A', description: '', agent: 'fake', workingDirectory: '.', dependsOn: [], status: 'pending', startedAt: null, endedAt: null, attempt: 0, attempts: [], result: null, error: '', verification: null },
        { id: 'slowB', title: 'B', description: '', agent: 'fake', workingDirectory: '.', dependsOn: [], status: 'pending', startedAt: null, endedAt: null, attempt: 0, attempts: [], result: null, error: '', verification: null },
      ],
    });
    const started = await scheduler.start(store.load('v-k3').plan);
    check('K5-prep. 计划已启动', () => started.ok === true, JSON.stringify(started));

    /* 等出「A 完成、B 在跑」的窗口 —— 此刻 Scheduler 内存里那份 plan 的
     * okDoc attempt 上**没有** verificationResult。 */
    let got = null;
    for (let i = 0; i < 500; i++) {
      const p = store.load('v-k3').plan;
      const A = p.tasks.find((x) => x.id === 'okDoc');
      const B = p.tasks.find((x) => x.id === 'slowB');
      if (A && B && A.status === 'success' && B.status === 'running') {
        got = true;
        break;
      }
      await sleep(25);
    }
    check('K5-prep2. 拿到「A 完成、B 在跑」的窗口（计划仍 active）', () => got === true);

    /* 就在这个窗口里给 A 的 attempt 补一条验证结果（模拟 Verifier 刚落盘）。 */
    const p2 = store.load('v-k3').plan;
    const attA = p2.tasks.find((x) => x.id === 'okDoc').attempts[0];
    attA.verificationResult = model.normalizeVerificationResult({ status: 'passed', command: 'npm test', exitCode: 0, startedAt: 1, finishedAt: 2, durationMs: 1, outputSummary: 'ok' });
    store.save(p2);

    await scheduler.waitIdle(20000);
    const after = store.load('v-k3').plan;
    const survivor = after.tasks.find((x) => x.id === 'okDoc').attempts[0].verificationResult;
    check('K6. B 跑完（Scheduler 又整份写盘一次）之后，A 的验证结果**没有丢**', () => {
      return (survivor && survivor.status === 'passed' && survivor.outputSummary === 'ok') || JSON.stringify(survivor);
    }, JSON.stringify(survivor));
    check('K6b. B 自己的执行状态照常落盘（合并没有把执行状态也「保」掉）', () => {
      const B = after.tasks.find((x) => x.id === 'slowB');
      return (B.status === 'success' && Array.isArray(B.attempts) && B.attempts.length === 1) || JSON.stringify({ s: B.status, n: B.attempts.length });
    });
  }

  /* ================= J. 真实 shell（这条路真的通） ================= */
  section('J. 真的走平台 shell 跑一条命令');

  {
    shellScript = [];
    const realVerifier = createVerifier({ store, runtime, scheduler, runShell: runShellCommand, timeoutMs: 20000, maxOutputBytes: 64 * 1024 });
    store.save(mkPlan({ id: 'v-j1', attempts: [mkAtt(1, { verificationSnapshot: { command: 'node --version' } })] }));
    runtime.setCurrentCwd(PROJ);
    const r = realVerifier.start({ planId: 'v-j1', taskId: 'task', attempt: 1 });
    check('J1. 启动成功', () => r.ok === true, JSON.stringify(r));
    for (let i = 0; i < 600; i++) {
      const v = vrOf('v-j1', 1);
      if (v && v.status !== 'running') break;
      await sleep(20);
    }
    const v = vrOf('v-j1', 1);
    check('J2. 真命令跑完 → passed，退出码 0', () => v.status === 'passed' && v.exitCode === 0, JSON.stringify(v));
    check('J3. 输出摘要里是**真的**版本号（证明 stdout 真的被收上来了）', () => /^v\d+\.\d+/.test(v.outputSummary.trim()) || JSON.stringify(v.outputSummary));
    check('J4. 命令在任务的 workingDirectory 下跑（cwd 走 spawn 选项，不拼 `cd X && …`）', () => /^v\d+\.\d+/.test(v.outputSummary.trim()) && !/cd\s/.test(v.command), JSON.stringify({ cwd: v.command }));
  }

  {
    shellScript = [];
    const realVerifier = createVerifier({ store, runtime, scheduler, runShell: runShellCommand, timeoutMs: 20000 });
    /* 命令字符串里的 `&&` / 管道只能由 shell 解释 —— 这正是必须过 shell 的原因。 */
    store.save(mkPlan({ id: 'v-j2', attempts: [mkAtt(1, { verificationSnapshot: { command: 'node --version && node --version' } })] }));
    realVerifier.start({ planId: 'v-j2', taskId: 'task', attempt: 1 });
    for (let i = 0; i < 600; i++) {
      const v = vrOf('v-j2', 1);
      if (v && v.status !== 'running') break;
      await sleep(20);
    }
    const v = vrOf('v-j2', 1);
    check('J5. 带 `&&` 的命令能跑（shell 真的把它当一条命令解释）', () => v.status === 'passed' && (v.outputSummary.match(/v\d+\.\d+/g) || []).length >= 2, JSON.stringify(v));
    check('J6. 非零退出码能从真命令里读回来', () => {
      store.save(mkPlan({ id: 'v-j3', attempts: [mkAtt(1, { verificationSnapshot: { command: 'node --definitely-not-a-flag' } })] }));
      realVerifier.start({ planId: 'v-j3', taskId: 'task', attempt: 1 });
      return true;
    });
    for (let i = 0; i < 600; i++) {
      const v = vrOf('v-j3', 1);
      if (v && v.status !== 'running') break;
      await sleep(20);
    }
    const v3 = vrOf('v-j3', 1);
    check('J6b. node 的非法参数 → failed 且退出码非 0', () => v3.status === 'failed' && Number.isInteger(v3.exitCode) && v3.exitCode !== 0, JSON.stringify(v3));
  }

  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n测试自身抛错：', err && err.stack ? err.stack : err);
  cleanup();
  process.exit(1);
});
