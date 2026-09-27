/* P7 —— 项目级任务工作流：Task ↔ Session / Task ↔ Files 关系测试。
 *
 * 覆盖规格 §38 列出的 24 条，外加 §7（从任务打开会话）、§11/§40（Git 快照语义）、
 * §13（并行不串）、§29（retry 不覆盖）、§31（中断不重置）。
 *
 * ---------- 三条纪律（与 planner.cjs 一致） ----------
 *
 * 1. **全部在 os.tmpdir() 里造世界**，不碰真实项目、不碰用户真实的会话目录。
 * 2. **不 spawn 真 Agent**，一律用 fake adapter（确定性、进程内、零额度）。
 * 3. **不联网。**
 *
 * 用法：node tests/workflow-relations.cjs
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-p7-'));
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

async function mkProject(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  created.push(dir);
  await git(dir, 'init', '-q');
  await git(dir, 'config', 'user.email', 't@t');
  await git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'c.js'), 'const c = 3;\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-qm', 'init');
  return dir;
}

/** pi 的会话文件名规则（`sessionFileName`）：`<ISO 把 : . 换成 ->_<encodeURIComponent(id)>.jsonl` */
function sessionFileName(createdAt, id) {
  return `${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}_${encodeURIComponent(id)}.jsonl`;
}

/** 造一个**形状真实**的会话文件：第一行是 header，后面是 message 条目（消息体嵌套）。 */
function writeSessionFile(dir, { id, cwd, text = '你好', at = Date.now() }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sessionFileName(at, id));
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date(at).toISOString(), cwd }),
    JSON.stringify({ type: 'message', id: 'm1', timestamp: new Date(at).toISOString(), message: { role: 'user', content: text } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

/** 一个最小 runtime：currentCwd 是唯一权威。 */
function mkRuntime(initial) {
  let cwd = initial;
  return {
    getCurrentCwd: () => cwd,
    setCurrentCwd: (v) => {
      cwd = v;
    },
    get shuttingDown() {
      return false;
    },
  };
}

(async () => {
  const model = await import('../server/planner/model.js');
  const { createPlanStore } = await import('../server/planner/store.js');
  const { createScheduler } = await import('../server/planner/scheduler.js');
  const { createAgentRegistry } = await import('../server/agents/index.js');
  const { createSessions } = await import('../server/sessions.js');
  const plannerMod = await import('../server/planner/index.js');
  const { gitStatus } = await import('../lib/git.js');
  const sessionIdLib = await import('../lib/session-id.js');

  const DATA = path.join(TMP, 'data');
  const AGENT_DIR = path.join(TMP, 'agent');
  const PLANNER_SESSIONS = path.join(DATA, 'planner-sessions');
  fs.mkdirSync(DATA, { recursive: true });

  const projectA = await mkProject('projA');
  const projectB = await mkProject('projB');

  /* 一个**不支持**会话关联的适配器 —— 用来验证「不支持时如实记 null，不伪造」。 */
  const noLinkAdapter = {
    id: 'nolink',
    name: 'NoLink',
    description: '测试用：不支持会话关联',
    detect: () => ({
      id: 'nolink',
      name: 'NoLink',
      available: true,
      version: 'test',
      reason: '',
      detail: '',
      capabilities: { streaming: false, cancellation: true, resume: false, toolEvents: false, sessionLinking: false },
      notes: [],
    }),
    start: async () => ({ success: true, exitCode: 0, summary: 'done', error: '', rawResult: null, toolCalls: 0 }),
  };

  const BEHAVIORS = {
    't1': [{ ok: true, summary: 'ok1', writes: [{ path: 'b.js', content: 'new\n' }] }],
    't2': [{ ok: false, error: '第一次故意失败' }, { ok: true, summary: '第二次成功', writes: [{ path: 'd.js', content: 'x\n' }] }],
    't3': [{ hang: true }],
    't4': [{ ok: true, summary: '修改 a.js', writes: [{ path: 'a.js', content: 'const a = 2;\n' }] }],
    't5': [{ ok: true, summary: '删除 c.js', deletes: ['c.js'] }],
    't6': [{ ok: true, summary: '什么都没改' }],
  };

  const registry = createAgentRegistry({ env: process.env, includeFake: true, fakeBehaviors: BEHAVIORS });
  registry.register(noLinkAdapter);

  const runtime = mkRuntime(projectA);
  const store = createPlanStore({ dataDir: DATA });
  const scheduler = createScheduler({ store, registry, runtime, gitStatus });

  /* 会话模块：agentDir 指到临时目录，extraSessionRoots 指到 planner 的会话目录。 */
  const switchCalls = [];
  const rpcStub = {
    request: async (cmd) => {
      if (cmd && cmd.type === 'switch_session') {
        switchCalls.push(cmd.sessionPath);
        return { ok: true };
      }
      if (cmd && cmd.type === 'get_state') return { sessionFile: null, sessionId: null };
      return { ok: true };
    },
  };
  const sessions = createSessions({
    runtime,
    rpc: rpcStub,
    env: { PI_CODING_AGENT_DIR: AGENT_DIR },
    dataDir: DATA,
    extraSessionRoots: [PLANNER_SESSIONS],
  });
  const planner = plannerMod.createPlanner({ runtime, registry, store, scheduler, sessions });

  /** 造一个 plan 对象（不入库）。 */
  function mkPlanObject({ id, taskId = 't1', agent = 'fake', project = projectA, concurrency = 1, extraTasks = [] }) {
    return {
      id,
      title: 'P7 计划 ' + id,
      goal: '给 demo.js 增加 hello(name) 并补测试',
      status: 'ready',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      endedAt: null,
      projectRoot: project,
      concurrency,
      tasks: [
        {
          id: taskId,
          title: '任务 ' + taskId,
          description: '做点事',
          agent,
          workingDirectory: '.',
          dependsOn: [],
          status: 'pending',
          startedAt: null,
          endedAt: null,
          attempt: 0,
          attempts: [],
          result: null,
          error: '',
          verification: null,
        },
        ...extraTasks,
      ],
      source: null,
    };
  }

  /** 跑一个单任务计划并等它跑完。 */
  async function runPlan(opts) {
    runtime.setCurrentCwd(opts.project || projectA);
    store.save(mkPlanObject(opts));
    const r = await scheduler.start(store.load(opts.id).plan);
    if (!r.ok) throw new Error('start 失败：' + r.error);
    await scheduler.waitIdle(20000);
    return store.load(opts.id).plan;
  }

  /** 只启动、不等它结束（给 hang 行为用，避免白等 20 秒）。 */
  async function startNoWait(opts) {
    runtime.setCurrentCwd(opts.project || projectA);
    store.save(mkPlanObject(opts));
    const r = await scheduler.start(store.load(opts.id).plan);
    if (!r.ok) throw new Error('start 失败：' + r.error);
    await sleep(150); // 让 task 真的进到 running 并把 attempt 号涨上去
  }

  const taskOf = (plan, id) => plan.tasks.find((t) => t.id === id);

  /* ================= A. Task ↔ Session ================= */
  section('A. Task ↔ Session');

  const p1 = await runPlan({ id: 'plan-sess-1' });
  const t1 = taskOf(p1, 't1');
  const a1 = t1.attempts[0];
  check('§38.1 attempt 保存了 sessionId', () => Boolean(a1 && typeof a1.sessionId === 'string' && a1.sessionId.length > 0), JSON.stringify(a1));
  check('§38.1 sessionId 是确定性拼出来的（含 planId / taskId / attempt）', () => a1 && a1.sessionId.includes('plan-sess-1') && a1.sessionId.includes('t1') && a1.sessionId.includes('a1'), a1 && a1.sessionId);
  check('§38.1 sessionId 符合 pi 的字符集（否则 pi 会 exit 1）', () => sessionIdLib.isSafeSessionId(a1 && a1.sessionId));
  check('§16. sessionId 不是路径（不含分隔符 / 盘符）', () => a1 && !/[/\\:]/.test(a1.sessionId));
  check('§7. task.result.sessionId 与 attempt 一致（详情接口一次给全，避免 N+1）', () => t1.result && t1.result.sessionId === a1.sessionId);

  /* 不支持关联的适配器 → 如实记 null */
  const p2 = await runPlan({ id: 'plan-sess-2', taskId: 't1', agent: 'nolink' });
  const a2 = taskOf(p2, 't1').attempts[0];
  check('§38.2 适配器不支持关联时 sessionId 为 null（不伪造）', () => a2 && a2.sessionId === null, JSON.stringify(a2));

  /* retry：旧 attempt 的会话必须保住，且新 attempt 用另一个会话 */
  const p3 = await runPlan({ id: 'plan-sess-3', taskId: 't2' });
  const t3 = taskOf(p3, 't2');
  check('§38.5 failed 的 attempt 也保留 sessionId', () => t3.attempts.length === 1 && Boolean(t3.attempts[0].sessionId));
  const firstSession = t3.attempts[0].sessionId;
  runtime.setCurrentCwd(projectA);
  scheduler.retryTask(store.load('plan-sess-3').plan, 't2');
  const r3 = await scheduler.start(store.load('plan-sess-3').plan);
  if (r3.ok) await scheduler.waitIdle(20000);
  const t3b = taskOf(store.load('plan-sess-3').plan, 't2');
  check('§38.3 retry 保留旧 attempt 的 session（历史没被覆盖）', () => t3b.attempts.length === 2 && t3b.attempts[0].sessionId === firstSession, JSON.stringify(t3b.attempts.map((a) => a.sessionId)));
  check('§38.4 retry 产生**新的** session（两次尝试各自的会话可区分）', () => t3b.attempts[1] && t3b.attempts[1].sessionId !== firstSession, t3b.attempts[1] && t3b.attempts[1].sessionId);
  check('§29. 两次 attempt 的 filesChanged 各自独立保留', () => t3b.attempts.length === 2 && Array.isArray(t3b.attempts[0].filesChanged) && t3b.attempts[1].filesChanged.includes('d.js'));

  /* cancelled 保留 session（用 hang 行为，启动后立刻 stop —— 不等它自然结束） */
  await startNoWait({ id: 'plan-sess-4', taskId: 't3' });
  scheduler.stop();
  await scheduler.waitIdle(20000);
  const t4 = taskOf(store.load('plan-sess-4').plan, 't3');
  check('§38.6 cancelled 的 attempt 保留 sessionId', () => t4.attempts.length >= 1 && Boolean(t4.attempts[0].sessionId), JSON.stringify(t4.attempts));
  check('§30. cancelled 也保留执行期间已发生的文件变化字段（数组，可为空）', () => t4.attempts.length >= 1 && Array.isArray(t4.attempts[0].filesChanged));

  /* sessionId 校验 */
  check('§38.7 sessionId 不接受任意路径（posix 绝对路径被拒）', () => sessionIdLib.isSafeSessionId('/etc/passwd') === false);
  check('§38.7 sessionId 不接受任意路径（Windows 绝对路径被拒）', () => sessionIdLib.isSafeSessionId('C:\\x\\y.jsonl') === false);
  check('§38.7 sessionId 不接受 ../ 逃逸', () => sessionIdLib.isSafeSessionId('../x') === false);
  check('§38.7 落盘归一化会把非法 sessionId 抹成 null', () => model.normalizeAttemptRelation({ sessionId: 'C:\\evil\\path.jsonl' }).sessionId === null);

  /* ================= B. Task ↔ Files ================= */
  section('B. Task ↔ Files（执行期间观察到的变化）');

  /* 单独一个项目：A 段的计划已经把 b.js 写出来了，复用会让「新增」测不出来
   * （快照前后都存在的文件当然不算变化）。 */
  const filesProj = await mkProject('projFiles');

  const p5 = await runPlan({ id: 'plan-files-1', taskId: 't1', project: filesProj });
  const f1 = taskOf(p5, 't1').attempts[0];
  check('§38.9 新增文件被识别', () => f1.filesChanged.includes('b.js'), JSON.stringify(f1.filesChanged));

  const p6 = await runPlan({ id: 'plan-files-2', taskId: 't4', project: filesProj });
  const f2 = taskOf(p6, 't4').attempts[0];
  check('§38.10 修改文件被识别', () => f2.filesChanged.includes('a.js'), JSON.stringify(f2.filesChanged));

  const p7 = await runPlan({ id: 'plan-files-3', taskId: 't6', project: filesProj });
  void p7;
  const f3 = taskOf(store.load('plan-files-3').plan, 't6').attempts[0];
  check('§38.13 无变化 → filesChanged 为空数组', () => Array.isArray(f3.filesChanged) && f3.filesChanged.length === 0, JSON.stringify(f3.filesChanged));
  check('§38.14 路径是项目相对（不含盘符 / 不以 / 开头）', () => f2.filesChanged.every((p) => !/^[A-Za-z]:/.test(p) && !p.startsWith('/')));
  check('§38.15 不出现绝对路径（不含临时目录前缀）', () => f2.filesChanged.every((p) => !p.includes(TMP.replace(/\\/g, '/')) && !p.includes('\\')));
  check('§38.15 不出现 .. 逃逸', () => f2.filesChanged.every((p) => !p.split('/').includes('..')));

  /* 删除场景：手工构造一次「执行期间删掉 c.js」 */
  {
    const delProj = await mkProject('projDel');
    runtime.setCurrentCwd(delProj);
    const plan = {
      id: 'plan-files-del',
      title: '删除场景',
      goal: '',
      status: 'ready',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectRoot: delProj,
      concurrency: 1,
      tasks: [{ id: 'tdel', title: '删文件', description: '', agent: 'fake', workingDirectory: '.', dependsOn: [], status: 'pending', attempt: 0, attempts: [], result: null, error: '' }],
      source: null,
    };
    store.save(plan);
    /* 用 fake 行为驱动不了删除，所以让 fake 在跑的时候由 onEvent 之外的方式删：
     * 这里直接用一个一次性适配器，保证「快照之前存在、之后不存在」。 */
    const { createFakeAdapter } = await import('../server/agents/fake.js');
    const deleting = createFakeAdapter({
      behaviors: {
        tdel: [
          {
            ok: true,
            summary: '删掉 c.js',
            deletes: ['c.js'],
          },
        ],
      },
    });
    /* fake 不认 deletes，所以包一层：先删文件再委托。 */
    registry.register({
      id: 'deleter',
      name: 'Deleter',
      detect: () => ({ id: 'deleter', name: 'Deleter', available: true, version: 'test', reason: '', detail: '', capabilities: { streaming: false, cancellation: true, resume: false, toolEvents: false, sessionLinking: true }, notes: [] }),
      start: async (args) => {
        fs.unlinkSync(path.join(delProj, 'c.js'));
        return deleting.start(args);
      },
    });
    plan.tasks[0].agent = 'deleter';
    store.save(plan);
    await scheduler.start(store.load('plan-files-del').plan);
    await scheduler.waitIdle(20000);
    const fd = taskOf(store.load('plan-files-del').plan, 'tdel').attempts[0];
    check('§38.11 删除文件被识别（reverted）', () => fd.filesChanged.includes('c.js'), JSON.stringify(fd.filesChanged));
  }

  /* rename：git mv 之后路径仍是相对的、不崩 */
  {
    const rnProj = await mkProject('projRen');
    runtime.setCurrentCwd(rnProj);
    registry.register({
      id: 'renamer',
      name: 'Renamer',
      detect: () => ({ id: 'renamer', name: 'Renamer', available: true, version: 'test', reason: '', detail: '', capabilities: { streaming: false, cancellation: true, resume: false, toolEvents: false, sessionLinking: true }, notes: [] }),
      start: async () => {
        await git(rnProj, 'mv', 'a.js', 'a2.js');
        return { success: true, exitCode: 0, summary: 'renamed', error: '', rawResult: null, toolCalls: 0 };
      },
    });
    const plan = {
      id: 'plan-files-ren',
      title: '重命名场景',
      goal: '',
      status: 'ready',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectRoot: rnProj,
      concurrency: 1,
      tasks: [{ id: 'tren', title: '改名', description: '', agent: 'renamer', workingDirectory: '.', dependsOn: [], status: 'pending', attempt: 0, attempts: [], result: null, error: '' }],
      source: null,
    };
    store.save(plan);
    await scheduler.start(store.load('plan-files-ren').plan);
    await scheduler.waitIdle(20000);
    const fr = taskOf(store.load('plan-files-ren').plan, 'tren').attempts[0];
    check('§38.12 rename 被识别成变化且路径仍是相对路径', () => fr.filesChanged.length > 0 && fr.filesChanged.every((p) => !/^[A-Za-z]:/.test(p) && !p.startsWith('/')), JSON.stringify(fr.filesChanged));
    check('§12. 元数据里不含完整 diff（只有文件名）', () => fr.filesChanged.every((p) => !p.includes('\n') && !p.includes('@@') && p.length < 200));
  }

  /* ================= C. 项目归属 ================= */
  section('C. 项目归属与隔离');

  /* A 项目的 plan 在 B 项目下不给操作 */
  {
    runtime.setCurrentCwd(projectB);
    const r = await callRoute(planner, 'GET', '/api/plans/plan-sess-1');
    check('§38.16 A 项目的 plan 在 B 项目下被拒（403）', () => r.code === 403, 'code=' + r.code + ' body=' + JSON.stringify(r.body));
    const r2 = await callRoute(planner, 'POST', '/api/plans/plan-sess-1/tasks/t1/open-session');
    check('§22. 从任务打开会话同样受 plan 归属保护（403）', () => r2.code === 403, 'code=' + r2.code);
    runtime.setCurrentCwd(projectA);
    const ok = await callRoute(planner, 'GET', '/api/plans/plan-sess-1');
    check('§22. 切回 A 之后同一个计划可访问', () => ok.code === 200 && ok.body.ok === true);
  }

  /* 会话归属：A 项目的会话不能从 B 项目打开 */
  {
    const sessionA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const sessionB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    writeSessionFile(PLANNER_SESSIONS, { id: sessionA, cwd: projectA, text: 'A 的会话' });
    writeSessionFile(PLANNER_SESSIONS, { id: sessionB, cwd: projectB, text: 'B 的会话' });
    runtime.setCurrentCwd(projectA);
    check('§38.17 A 项目的会话在 A 项目下能解析到', () => Boolean(sessions.resolveByUuid(sessionA)));
    check('§38.8 别的项目的会话不允许在当前项目下解析（跨项目隔离）', () => sessions.resolveByUuid(sessionB) === null);
    runtime.setCurrentCwd(projectB);
    check('§38.17 切到 B 之后 B 的会话能解析、A 的不行', () => Boolean(sessions.resolveByUuid(sessionB)) && sessions.resolveByUuid(sessionA) === null);
    check('§38.7 resolveByUuid 拒绝路径类输入', () => sessions.resolveByUuid('C:\\x\\s.jsonl') === null && sessions.resolveByUuid('../../etc/passwd') === null);
  }

  /* 子目录里的会话仍算本项目（任务的工作目录可以是子目录） */
  {
    const subDir = path.join(projectA, 'src');
    fs.mkdirSync(subDir, { recursive: true });
    const subSession = 'cccccccc-3333-4333-8333-cccccccccccc';
    writeSessionFile(PLANNER_SESSIONS, { id: subSession, cwd: subDir, text: '子目录会话' });
    runtime.setCurrentCwd(projectA);
    check('§7. 工作目录是子目录的会话仍算本项目（否则任务会话永远打不开）', () => Boolean(sessions.resolveByUuid(subSession)));
  }

  /* 反向查询只回当前项目：这里只确认接口本身可用，具体断言在 G 段。 */
  runtime.setCurrentCwd(projectA);

  /* ================= D. 持久化与兼容 ================= */
  section('D. 持久化与向后兼容');

  {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'plans', 'plan-sess-1.json'), 'utf8'));
    check('§38.19 relation 真的落在磁盘上（不是只在内存里）', () => {
      const t = raw.tasks.find((x) => x.id === 't1');
      return t && t.attempts[0] && typeof t.attempts[0].sessionId === 'string' && Array.isArray(t.attempts[0].filesChanged);
    });
    const fresh = createPlanStore({ dataDir: DATA });
    const reloaded = fresh.load('plan-sess-1');
    check('§38.19 新 store 读回来 relation 仍在（重启后不丢）', () => {
      const t = reloaded.plan.tasks.find((x) => x.id === 't1');
      return t.attempts[0].sessionId === a1.sessionId && t.attempts[0].filesChanged.includes('b.js');
    });
  }

  {
    /* 老计划：完全没有 sessionId / filesChanged 字段 */
    const legacy = {
      schemaVersion: 1,
      id: 'plan-legacy',
      title: '老计划',
      goal: 'g',
      status: 'completed',
      createdAt: 1,
      updatedAt: 1,
      projectRoot: projectA,
      concurrency: 1,
      tasks: [
        {
          id: 'told',
          title: '老任务',
          description: '',
          agent: 'fake',
          workingDirectory: '.',
          dependsOn: [],
          status: 'success',
          attempt: 1,
          attempts: [{ attempt: 1, startedAt: 1, endedAt: 2, success: true, error: '', summary: 'ok', exitCode: 0 }],
          result: null,
          error: '',
        },
      ],
      source: null,
    };
    fs.writeFileSync(path.join(DATA, 'plans', 'plan-legacy.json'), JSON.stringify(legacy, null, 2));
    const fresh = createPlanStore({ dataDir: DATA });
    const r = fresh.load('plan-legacy');
    check('§38.20 老计划（无 relation 字段）仍能正常加载', () => Boolean(r && r.plan && r.plan.tasks.length === 1));
    check('§38.20 缺字段被补成 null / []（不是 undefined）', () => r.plan.tasks[0].attempts[0].sessionId === null && Array.isArray(r.plan.tasks[0].attempts[0].filesChanged) && r.plan.tasks[0].attempts[0].filesChanged.length === 0);
    check('§15. 不因新增字段而报格式版本问题', () => !(r.plan.recoveryNotes || []).some((n) => n.includes('格式版本')));
    runtime.setCurrentCwd(projectA);
    const list = fresh.list({ projectRoot: projectA });
    check('§33. 一个老计划不会让列表读不出来', () => list.plans.some((p) => p.id === 'plan-legacy'));
  }

  {
    /* corrupt relation：绝对路径 / 非法 id / 非数组 filesChanged */
    const corrupt = {
      schemaVersion: 1,
      id: 'plan-corrupt',
      title: '坏关系',
      goal: 'g',
      status: 'completed',
      createdAt: 1,
      updatedAt: 1,
      projectRoot: projectA,
      concurrency: 1,
      tasks: [
        {
          id: 'tc',
          title: 'x',
          agent: 'fake',
          workingDirectory: '.',
          dependsOn: [],
          status: 'success',
          attempt: 1,
          attempts: [
            { attempt: 1, success: true, sessionId: 'C:\\Users\\me\\sess.jsonl', filesChanged: ['C:\\abs\\x.js', '../../escape.js', 'ok.js', 42, null] },
          ],
          result: null,
          error: '',
        },
      ],
      source: null,
    };
    fs.writeFileSync(path.join(DATA, 'plans', 'plan-corrupt.json'), JSON.stringify(corrupt, null, 2));
    const fresh = createPlanStore({ dataDir: DATA });
    const r = fresh.load('plan-corrupt');
    const a = r && r.plan && r.plan.tasks[0].attempts[0];
    check('§38.21 坏 relation 不拖垮加载', () => Boolean(r && r.plan));
    check('§38.21 非法 sessionId（路径）被抹成 null', () => a && a.sessionId === null);
    check('§38.21 绝对路径 / .. 逃逸 / 非字符串被从 filesChanged 里剔除', () => a && a.filesChanged.length === 1 && a.filesChanged[0] === 'ok.js', JSON.stringify(a && a.filesChanged));
  }

  /* ================= E. 隐私 ================= */
  section('E. 隐私（新字段不许夹带正文 / 路径）');

  {
    const raw = fs.readFileSync(path.join(DATA, 'plans', 'plan-sess-1.json'), 'utf8');
    const att = JSON.parse(raw).tasks.find((x) => x.id === 't1').attempts[0];
    const keys = Object.keys(att);
    check('§32. attempt 的键只有关系字段 + 既有状态字段', () => keys.every((k) => ['attempt', 'startedAt', 'endedAt', 'success', 'error', 'summary', 'exitCode', 'sessionId', 'filesChanged', 'changeCaptureIncomplete'].includes(k)), keys.join(','));
    check('§32. filesChanged 里没有绝对路径 / 会话文件路径', () => att.filesChanged.every((p) => !p.includes(':') && !p.startsWith('/')));
    check('§32. sessionId 里没有项目绝对路径', () => !att.sessionId.includes(TMP) && !att.sessionId.includes(path.sep));
    check('§32. 关系字段里没有 prompt 文本（任务描述没有进 attempt）', () => !JSON.stringify(att).includes('做点事'));
    check('§38.24 关系字段里没有绝对 cwd', () => !JSON.stringify({ sessionId: att.sessionId, filesChanged: att.filesChanged }).includes(projectA.replace(/\\/g, '\\\\')));
  }

  /* ================= F. 打开会话（§7） ================= */
  section('F. 从任务打开会话（§7）');

  {
    /* 造一个「任务已完成、会话文件存在」的计划 */
    const target = 'dddddddd-4444-4444-8444-dddddddddddd';
    writeSessionFile(PLANNER_SESSIONS, { id: target, cwd: projectA, text: '这个任务的那次对话' });
    runtime.setCurrentCwd(projectA);
    const plan = {
      id: 'plan-open-1',
      title: '打开会话',
      goal: 'g',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectRoot: projectA,
      concurrency: 1,
      tasks: [
        {
          id: 'top',
          title: '改后端',
          agent: 'fake',
          workingDirectory: '.',
          dependsOn: [],
          status: 'success',
          attempt: 1,
          attempts: [{ attempt: 1, startedAt: 1, endedAt: 2, success: true, error: '', summary: '', exitCode: 0, sessionId: target, filesChanged: ['server/x.js'], changeCaptureIncomplete: false }],
          result: null,
          error: '',
        },
      ],
      source: null,
    };
    store.save(plan);
    switchCalls.length = 0;
    const r = await planner.openTaskSession(store.load('plan-open-1').plan, 'top', null);
    check('§7. 能打开对应会话（复用 switch_session）', () => r.ok === true && switchCalls.length === 1, JSON.stringify(r));
    check('§7. 切换用的是**解析出来的真实路径**（后端内部解析，前端不传路径）', () => switchCalls[0] && switchCalls[0].endsWith('.jsonl') && switchCalls[0].includes(PLANNER_SESSIONS));
    check('§7. 返回稳定 id 与标题给前端', () => r.ok && typeof r.id === 'string' && r.id.length > 0 && typeof r.title === 'string');

    /* 指定 attempt */
    const r2 = await planner.openTaskSession(store.load('plan-open-1').plan, 'top', '1');
    check('§6. 可以按 attempt 精确打开', () => r2.ok === true && r2.attempt === 1);

    /* running 时拒绝 */
    const runningPlan = store.load('plan-open-1').plan;
    runningPlan.tasks[0].status = 'running';
    const r3 = await planner.openTaskSession(runningPlan, 'top', null);
    check('§7. 任务正在执行时拒绝打开（避免两个进程写同一个 jsonl）', () => r3.ok === false && /正在执行/.test(r3.error), JSON.stringify(r3));

    /* 会话已删除 */
    const gone = store.load('plan-open-1').plan;
    gone.tasks[0].attempts[0].sessionId = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
    const r4 = await planner.openTaskSession(gone, 'top', null);
    check('§27. 关联会话已被删除 → 明确说找不到（不猜、不新建）', () => r4.ok === false && /找不到/.test(r4.error), JSON.stringify(r4));

    /* 没有 sessionId 的 attempt */
    const noLink = store.load('plan-open-1').plan;
    noLink.tasks[0].attempts[0].sessionId = null;
    const r5 = await planner.openTaskSession(noLink, 'top', null);
    check('§16. 这次执行没有关联会话 → 明确说明（不报错、不崩）', () => r5.ok === false && /没有关联会话/.test(r5.error), JSON.stringify(r5));

    /* 任务不存在 / 没跑过 */
    const r6 = await planner.openTaskSession(store.load('plan-open-1').plan, 'nope', null);
    check('§7. 任务不存在 → 明确错误', () => r6.ok === false && /找不到这个任务/.test(r6.error));
  }

  /* ================= G. 反向查询 + 并行 ================= */
  section('G. 反向查询与并行');

  {
    runtime.setCurrentCwd(projectA);
    const plan = store.load('plan-sess-1').plan;
    const sid = plan.tasks.find((t) => t.id === 't1').attempts[0].sessionId;
    const out = await callRoute(planner, `GET`, `/api/plans/relations?sessionId=${encodeURIComponent(sid)}`);
    check('§5. 会话 → 任务 反向查询能命中', () => out.code === 200 && out.body.ok && out.body.matches.length === 1, JSON.stringify(out.body));
    check('§5. 命中里带 plan / task 的可读信息（界面要显示「属于哪个计划」）', () => {
      const m = out.body.matches[0];
      return m.planId === 'plan-sess-1' && m.taskId === 't1' && m.attempt === 1 && Array.isArray(m.filesChanged);
    });
    const bad = await callRoute(planner, 'GET', '/api/plans/relations?sessionId=' + encodeURIComponent('../../x'));
    check('§5. 非法 sessionId → 400（不可信输入先挡住）', () => bad.code === 400 && bad.body.ok === false);
    const none = await callRoute(planner, 'GET', '/api/plans/relations?sessionId=zzzzzzzz-9999-4999-8999-zzzzzzzzzzzz');
    check('§8. 没有关联时回空列表（不是错误）', () => none.code === 200 && none.body.ok && none.body.matches.length === 0);
  }

  {
    /* 并行：两个互不依赖的 task 同时跑，各自的关系不许串 */
    const parProj = await mkProject('projPar');
    runtime.setCurrentCwd(parProj);
    const mk = (id, file) => ({
      id,
      title: id,
      description: '',
      agent: 'fake',
      workingDirectory: '.',
      dependsOn: [],
      status: 'pending',
      attempt: 0,
      attempts: [],
      result: null,
      error: '',
    });
    registry.register({
      id: 'slowwriter',
      name: 'SlowWriter',
      detect: () => ({ id: 'slowwriter', name: 'SlowWriter', available: true, version: 'test', reason: '', detail: '', capabilities: { streaming: false, cancellation: true, resume: false, toolEvents: false, sessionLinking: true }, notes: [] }),
      start: async ({ task, cwd, sessionId }) => {
        await new Promise((r) => setTimeout(r, 60));
        fs.writeFileSync(path.join(cwd, task.id + '.txt'), 'x');
        return { success: true, exitCode: 0, summary: task.id, error: '', sessionId, rawResult: null, toolCalls: 0 };
      },
    });
    const plan = {
      id: 'plan-par',
      title: '并行',
      goal: '',
      status: 'ready',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectRoot: parProj,
      concurrency: 2,
      tasks: [mk('pa', 'pa.txt'), mk('pb', 'pb.txt')].map((t) => ({ ...t, agent: 'slowwriter' })),
      source: null,
    };
    store.save(plan);
    await scheduler.start(store.load('plan-par').plan);
    await scheduler.waitIdle(30000);
    const done = store.load('plan-par').plan;
    const ta = done.tasks.find((t) => t.id === 'pa');
    const tb = done.tasks.find((t) => t.id === 'pb');
    check('§13. 并行任务各自的 sessionId 不同（没有互相覆盖）', () => ta.attempts[0].sessionId && tb.attempts[0].sessionId && ta.attempts[0].sessionId !== tb.attempts[0].sessionId, [ta.attempts[0].sessionId, tb.attempts[0].sessionId].join(' | '));
    /* ⚠️ 并行时**允许重叠**：两个 task 同时跑，A 的 after 快照本来就会看到 B 写的文件。
     * 规格 §11 明确说这是允许的 —— 因为语义是「执行期间观察到这些文件变了」，
     * 不是「这些文件由这个 Agent 独立修改」。所以这里断言的是「各记各的、且都记到了
     * 自己那个」，而不是「互不包含」（后者在并行下本来就不成立）。 */
    check('§13/§11. 并行任务各自至少记到自己的文件（重叠是允许的，语义是「执行期间」）', () => ta.attempts[0].filesChanged.includes('pa.txt') && tb.attempts[0].filesChanged.includes('pb.txt'), JSON.stringify([ta.attempts[0].filesChanged, tb.attempts[0].filesChanged]));
    check('§11. 措辞是「执行期间观察到的变化」，不声称 Agent 独占修改', () => {
      const n = String((ta.result && ta.result.changes && ta.result.changes.note) || '');
      return n.includes('执行期间') && !n.includes('该 Agent 修改') && !n.includes('Agent 修改了');
    }, (ta.result && ta.result.changes && ta.result.changes.note) || '(无)');

    /* 串行时才应该「互不包含」—— 补一条串行的对照，证明不是靠运气 */
    const seqProj = await mkProject('projSeq');
    runtime.setCurrentCwd(seqProj);
    const seqPlan = {
      id: 'plan-seq',
      title: '串行',
      goal: '',
      status: 'ready',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectRoot: seqProj,
      concurrency: 1,
      tasks: [mk('sa', 'sa.txt'), mk('sb', 'sb.txt')].map((t) => ({ ...t, agent: 'slowwriter' })),
      source: null,
    };
    store.save(seqPlan);
    await scheduler.start(store.load('plan-seq').plan);
    await scheduler.waitIdle(30000);
    const seq = store.load('plan-seq').plan;
    const sa = seq.tasks.find((t) => t.id === 'sa');
    const sb = seq.tasks.find((t) => t.id === 'sb');
    check('§13. 串行时文件不串（对照：证明并行那条重叠不是实现缺陷）', () => sa.attempts[0].filesChanged.join() === 'sa.txt' && sb.attempts[0].filesChanged.join() === 'sb.txt', JSON.stringify([sa.attempts[0].filesChanged, sb.attempts[0].filesChanged]));
  }

  /* ================= H. 中断恢复 ================= */
  section('H. 中断恢复（§31）');

  {
    await startNoWait({ id: 'plan-int-1', taskId: 't3' });
    const before = store.load('plan-int-1').plan;
    const t = before.tasks.find((x) => x.id === 't3');
    check('§31. 运行中的任务在被中断前没有凭空写 attempt', () => t.attempts.length === 0 && t.status === 'running', JSON.stringify([t.attempts.length, t.status]));
    scheduler.shutdown();
    await scheduler.waitIdle(20000); // 等 pump 收尾（退出路径也要能被测到）
    const after = store.load('plan-int-1').plan;
    const t2 = after.tasks.find((x) => x.id === 't3');
    check('§31. shutdown 后任务标成 interrupted', () => t2.status === 'interrupted', t2.status);
    check('§31. 中断时补的 attempt 带 sessionId（那条会话确实存在过）', () => t2.attempts.length === 1 && Boolean(t2.attempts[0].sessionId), JSON.stringify(t2.attempts));
    check('§31. 拿不到 after 快照时**不猜**最终变化：filesChanged=[] 且标 incomplete', () => t2.attempts[0].filesChanged.length === 0 && t2.attempts[0].changeCaptureIncomplete === true, JSON.stringify(t2.attempts[0]));
    check('§31. 中断后没有重复记账（同一条 attempt 只出现一次）', () => t2.attempts.filter((a) => a.attempt === 1).length === 1);
    check('§31. 退出后 plan 仍是 paused（不许被算成「失败」）', () => after.status === 'paused', after.status);
  }

  /* ================= I. 非 git 项目 ================= */
  section('I. 不是 git 仓库时的降级');

  {
    const noGit = path.join(TMP, 'nogit');
    fs.mkdirSync(noGit, { recursive: true });
    created.push(noGit);
    runtime.setCurrentCwd(noGit);
    const plan = {
      id: 'plan-nogit',
      title: '无 git',
      goal: '',
      status: 'ready',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectRoot: noGit,
      concurrency: 1,
      tasks: [{ id: 'tng', title: 'x', description: '', agent: 'fake', workingDirectory: '.', dependsOn: [], status: 'pending', attempt: 0, attempts: [], result: null, error: '' }],
      source: null,
    };
    store.save(plan);
    await scheduler.start(store.load('plan-nogit').plan);
    await scheduler.waitIdle(20000);
    const t = store.load('plan-nogit').plan.tasks[0];
    check('§11. 不是 git 仓库 → filesChanged 空，但标 changeCaptureIncomplete（不假装没变化）', () => t.attempts[0].filesChanged.length === 0 && t.attempts[0].changeCaptureIncomplete === true, JSON.stringify(t.attempts[0]));
    check('§11. 任务本身照常成功（无 git 不是错误）', () => t.status === 'success', t.status);
  }

  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n测试自身抛错：', err && err.stack ? err.stack : err);
  cleanup();
  process.exit(1);
});

/* ---------- 小工具：直接打 planner 的 HTTP 处理器 ---------- */

async function callRoute(planner, method, urlStr, body) {
  const out = { code: 0, body: null };
  const res = {
    writeHead(code) {
      out.code = code;
      return this;
    },
    end(chunk) {
      try {
        out.body = JSON.parse(chunk);
      } catch {
        out.body = chunk;
      }
    },
  };
  const url = new URL('http://127.0.0.1' + urlStr);
  const req = {
    method,
    url: urlStr,
    headers: {},
    on() {},
  };
  await planner.handle(req, res, url);
  return out;
}
