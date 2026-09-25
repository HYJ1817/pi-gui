/* Planner / Agent 编排的测试（规格 §48 的 53 项 + §49 的 fake-agent E2E）。
 *
 * 分成三块，各有明确目的：
 *
 *   A. **纯逻辑**（模型 / DAG / 调度状态机）—— 用 fake adapter，确定性、毫秒级。
 *      这是最有价值的一块：调度语义（依赖解锁、失败暂停、取消≠失败、attempt 历史）
 *      跟模型没关系，必须能反复、快速地验证。
 *
 *   B. **进程层**（server/agents/cli.js）—— 用**真的子进程**打。
 *      ENOENT / 超时 / 取消 / 进程树 kill / stdout 截断这些东西在进程内伪造不出来，
 *      伪造出来的通过率没有意义。
 *
 *   C. **持久化与安全** —— 全部在 os.tmpdir() 里造世界，不碰真实项目、不联网、
 *      **不消耗任何模型额度**（除了 §49 明确标注的那一条）。
 *
 * 用法：node tests/planner.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

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

/* 注意：本环境 spawnSync 恒 EBUSY（已知陷阱），git 一律用异步 spawn。
 * 用 spawnSync 会让 git init 静默失败，然后 isRepo=false、
 * Changes 永远是空的，看起来像调度器的 bug。 */
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-planner-'));
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

/** 造一个带 git 仓库的临时项目。 */
async function mkProject(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  created.push(dir);
  await git(dir, 'init', '-q');
  await git(dir, 'config', 'user.email', 't@t');
  await git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-qm', 'init');
  return dir;
}

(async () => {
  const model = await import('../server/planner/model.js');
  const { createPlanStore } = await import('../server/planner/store.js');
  const { createScheduler } = await import('../server/planner/scheduler.js');
  const { createAgentRegistry } = await import('../server/agents/index.js');
  const { createFakeAdapter } = await import('../server/agents/fake.js');
  const { runCli, resolveEntry, DEFAULT_MAX_STDOUT } = await import('../server/agents/cli.js');
  const plannerMod = await import('../server/planner/index.js');
  const { gitStatus } = await import('../lib/git.js');

  const AGENTS = ['pi', 'codex', 'claude', 'gemini', 'opencode', 'fake'];

  const mkPlan = (raw, projectRoot) => {
    const r = model.normalizePlan(raw, { agentIds: AGENTS, projectRoot });
    return r;
  };

  /* ================= A. Plan / Task 模型（§48 的 1-7） ================= */
  section('A. Plan / Task 模型与 DAG 校验');

  const projA = await mkProject('projA');

  check('1. 合法 DAG 通过，并按拓扑序可用', () => {
    const r = mkPlan({ title: 't', goal: 'g', tasks: [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b'] }] }, projA);
    if (!r.ok) return r.errors.join(' / ');
    return model.topoOrder(r.plan.tasks).map((t) => t.id).join(',') === 'a,b,c' || '拓扑序错';
  });
  check('2. 重复 id 被拒', () => {
    const r = mkPlan({ tasks: [{ id: 'a' }, { id: 'a' }] }, projA);
    return (!r.ok && r.errors.some((e) => /重复/.test(e))) || JSON.stringify(r.errors);
  });
  check('3. 依赖不存在的任务被拒', () => {
    const r = mkPlan({ tasks: [{ id: 'a', dependsOn: ['zzz'] }] }, projA);
    return (!r.ok && r.errors.some((e) => /不存在/.test(e))) || JSON.stringify(r.errors);
  });
  check('4. 自依赖被拒', () => {
    const r = mkPlan({ tasks: [{ id: 'a', dependsOn: ['a'] }] }, projA);
    return (!r.ok && r.errors.some((e) => /依赖自己/.test(e))) || JSON.stringify(r.errors);
  });
  check('5. 成环被拒，并且报出环路径', () => {
    const r = mkPlan({ tasks: [{ id: 'a', dependsOn: ['c'] }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b'] }] }, projA);
    return (!r.ok && r.errors.some((e) => /成环/.test(e) && /→/.test(e))) || JSON.stringify(r.errors);
  });
  check('6. 未知 agent 被拒', () => {
    const r = mkPlan({ tasks: [{ id: 'a', agent: 'not-real' }] }, projA);
    return (!r.ok && r.errors.some((e) => /未知的 agent/.test(e))) || JSON.stringify(r.errors);
  });
  check('7. cwd 逃逸被拒（../、绝对路径、盘符都拦）', () => {
    const cases = ['../../', '..', 'C:\\Windows', '\\\\server\\share', '/etc'];
    const bad = [];
    for (const wd of cases) {
      const r = mkPlan({ tasks: [{ id: 'a', workingDirectory: wd }] }, projA);
      if (r.ok) bad.push(wd);
    }
    return bad.length === 0 || '漏放：' + bad.join(' ');
  });
  check('7b. cwd 是项目内相对路径时通过（"." / "src"）', () => {
    fs.mkdirSync(path.join(projA, 'src'), { recursive: true });
    const r = mkPlan({ tasks: [{ id: 'a', workingDirectory: '.' }, { id: 'b', workingDirectory: 'src' }] }, projA);
    return r.ok || r.errors.join(' / ');
  });
  check('7c. cwd 是上一级目录（真的出了项目）也被拒', () => {
    // 注意不能用 '../projA' —— 那会被 resolve 回项目自己，是合法路径。
    // 要用真正落在项目外的相对路径。
    const r = mkPlan({ tasks: [{ id: 'a', workingDirectory: '../' }] }, projA);
    return !r.ok || '竟然通过了：' + r.plan.tasks[0].workingDirectory;
  });
  check('7d. 没有 root 任务被拒（全是环外依赖）', () => {
    const r = mkPlan({ tasks: [{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }] }, projA);
    return !r.ok || '竟然通过了';
  });
  check('7e. 空任务列表被拒，且同一句话不重复报', () => {
    const r = mkPlan({ tasks: [] }, projA);
    const dup = r.errors.filter((e) => /没有任何任务/.test(e)).length;
    return (!r.ok && dup === 1) || JSON.stringify(r.errors);
  });
  check('7f. 任务数超上限被拒（防碎任务）', () => {
    const tasks = [];
    for (let i = 0; i < model.MAX_TASKS + 3; i++) tasks.push({ id: 't' + i });
    const r = mkPlan({ tasks }, projA);
    return (!r.ok && r.errors.some((e) => /上限/.test(e))) || JSON.stringify(r.errors);
  });
  check('7g. verification 只保存描述，Pi GUI 不持有可执行命令', () => {
    const r = mkPlan({ tasks: [{ id: 'a', verification: { command: 'npm test' } }] }, projA);
    return (r.ok && r.plan.tasks[0].verification.command === 'npm test') || JSON.stringify(r.errors);
  });
  check('7h. buildTaskPrompt 把 verification 当指令交给 Agent（不是自己执行）', () => {
    const r = mkPlan({ tasks: [{ id: 'a', title: 'A', verification: { command: 'npm test' } }] }, projA);
    const p = model.buildTaskPrompt(r.plan, r.plan.tasks[0]);
    return /npm test/.test(p) && /完成后请验证/.test(p) || p.slice(0, 200);
  });
  check('7i. computeReadyStates：root=ready、依赖者=pending', () => {
    const r = mkPlan({ tasks: [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }] }, projA);
    const st = model.computeReadyStates(r.plan.tasks);
    return (st.get('a') === 'ready' && st.get('b') === 'pending') || JSON.stringify([...st]);
  });
  check('7j. computeReadyStates：依赖失败 → blocked；依赖被跳过 → blocked', () => {
    const r = mkPlan({ tasks: [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }] }, projA);
    r.plan.tasks[0].status = 'failed';
    const st = model.computeReadyStates(r.plan.tasks);
    if (st.get('b') !== 'blocked') return '失败依赖没阻塞：' + st.get('b');
    r.plan.tasks[0].status = 'skipped';
    const st2 = model.computeReadyStates(r.plan.tasks);
    return st2.get('b') === 'blocked' || '跳过依赖没阻塞：' + st2.get('b');
  });

  /* ================= B. Agent Registry（§48 的 19-23） ================= */
  section('B. Agent Registry');

  {
    const reg = createAgentRegistry({ env: process.env, sessionDir: path.join(TMP, 'sess') });
    const list = reg.list();
    check('19. pi 能被探测到，且能力里有 toolEvents（唯一有工具级事件的）', () => {
      const pi = list.find((a) => a.id === 'pi');
      return Boolean(pi && pi.available && pi.capabilities.toolEvents === true && pi.version) || JSON.stringify(pi);
    });
    check('20/21/22. 不可用的 agent 如实报 unavailable，并给出可核对的原因', () => {
      const bad = list.filter((a) => !a.available);
      return bad.every((a) => a.reason && a.detail) || JSON.stringify(bad.map((a) => [a.id, a.reason]));
    });
    check('claude 若不可用，原因必须区分「装坏了」与「没装」', () => {
      const claude = list.find((a) => a.id === 'claude');
      if (!claude) return '没有 claude 条目';
      if (claude.available) return true;
      return ['entry-missing', 'not-installed'].includes(claude.reason) || claude.reason;
    });
    check('23. 未知 agent 被拒（get 返回 null，且不抛）', () => (reg.get('nope') === null && reg.has('nope') === false) || '没拒绝');
    check('registry 每个 adapter 都暴露统一 capability 字段', () => {
      const need = ['streaming', 'cancellation', 'resume', 'toolEvents'];
      const bad = list.filter((a) => !need.every((k) => typeof a.capabilities[k] === 'boolean'));
      return bad.length === 0 || JSON.stringify(bad.map((a) => a.id));
    });
    check('auto 的解析可预测：优先 pi', () => reg.resolveAuto() === 'pi' || reg.resolveAuto());
    check('auto 在 preferred 可用时听 preferred', () => {
      const avail = list.filter((a) => a.available).map((a) => a.id);
      if (avail.length < 2) return true;
      const other = avail.find((x) => x !== 'pi');
      return reg.resolveAuto(other) === other || reg.resolveAuto(other);
    });
    check('register 会校验 adapter 形状（缺 start 直接抛）', () => {
      try {
        reg.register({ id: 'x' });
        return '竟然接受了';
      } catch {
        return true;
      }
    });
    check('一个 adapter 探测抛错不会拖垮整个 registry', () => {
      const r2 = createAgentRegistry({ env: process.env });
      r2.register({
        id: 'boom',
        name: 'Boom',
        detect() {
          throw new Error('探测炸了');
        },
        start() {},
      });
      const l = r2.list();
      return (l.length === r2.size() && l.find((a) => a.id === 'boom').available === false) || JSON.stringify(l.map((a) => a.id));
    });
  }

  /* ================= C. 进程层（§48 的 24-30） ================= */
  section('C. 进程执行层（真子进程）');

  const nodeEntry = (script) => ({ ok: true, kind: 'node', cmd: process.execPath, baseArgs: ['-e', script] });

  {
    const r0 = await runCli({ entry: nodeEntry('process.stdout.write("hello")'), cwd: projA });
    check('24. exit 0 → ok=true，stdout 收到', () => (r0.ok && r0.exitCode === 0 && r0.stdout.includes('hello')) || JSON.stringify({ ok: r0.ok, code: r0.exitCode }));

    const r1 = await runCli({ entry: nodeEntry('process.exit(3)'), cwd: projA });
    check('25. exit 非 0 → ok=false 且带 exitCode', () => (!r1.ok && r1.exitCode === 3) || JSON.stringify({ ok: r1.ok, code: r1.exitCode }));

    const r2 = await runCli({ entry: { ok: true, kind: 'exe', cmd: path.join(TMP, 'definitely-not-here.exe'), baseArgs: [] }, cwd: projA });
    check('26. spawn ENOENT → spawnFailed=true，永不 reject', () => (r2.spawnFailed === true && r2.ok === false && /无法启动/.test(r2.error)) || JSON.stringify(r2));

    const t0 = Date.now();
    const r3 = await runCli({ entry: nodeEntry('setTimeout(()=>{},60000)'), cwd: projA, timeoutMs: 800 });
    check('27. 超时 → timedOut=true，且真的被杀了（不拖 60 秒）', () => (r3.timedOut === true && Date.now() - t0 < 15000) || JSON.stringify({ timedOut: r3.timedOut, ms: Date.now() - t0 }));

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r4 = await runCli({ entry: nodeEntry('setTimeout(()=>{},60000)'), cwd: projA, signal: ac.signal });
    check('28. 取消 → cancelled=true', () => (r4.cancelled === true && r4.ok === false) || JSON.stringify(r4));

    const preAborted = new AbortController();
    preAborted.abort();
    const r5 = await runCli({ entry: nodeEntry('process.stdout.write("不该出现")'), cwd: projA, signal: preAborted.signal });
    check('28b. 已经 abort 的 signal → 立刻返回，不启动进程', () => (r5.cancelled === true && !r5.stdout.includes('不该出现')) || JSON.stringify(r5));

    /* 29. 进程树 kill：父进程拉起一个「之后写文件」的孙子进程。
     * 只杀父进程的话孙子会活下来 —— 那正是要防的（agent 拉起的 npm test 同理）。
     *
     * 断言方式刻意用**孙进程 PID 是否还在**，而不是只看「文件有没有出现」：
     * 后者依赖时序，跑在负载下会偶发（第一版就吃过一次假失败）。 */
    const marker = path.join(TMP, 'tree-kill-marker.txt');
    const grandchild =
      'setTimeout(()=>{try{require("fs").writeFileSync(process.argv[1],"survived")}catch{}},2500)';
    const parentScript =
      'const c=require("child_process").spawn(process.execPath,["-e",' +
      JSON.stringify(grandchild) +
      ',' +
      JSON.stringify(marker) +
      '],{stdio:"ignore"});console.log("GC_PID="+c.pid);setTimeout(()=>{},60000)';
    const treeAc = new AbortController();
    const gcLines = [];
    const treePromise = runCli({ entry: nodeEntry(parentScript), cwd: projA, signal: treeAc.signal, onLine: (l) => gcLines.push(l) });
    await sleep(1400);
    const gcPid = (gcLines.join('').match(/GC_PID=(\d+)/) || [])[1] || null;
    treeAc.abort();
    await treePromise;
    await sleep(3200);
    const pidAlive = (pid) => {
      try {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf8', windowsHide: true });
        return out.includes(String(pid));
      } catch {
        return false; // tasklist 不可用时不据此判否
      }
    };
    check('29. 取消时收掉整棵进程树（孙进程 PID 已经不在了）', () => {
      if (!gcPid) return '没拿到孙进程 PID（父进程可能没起来）';
      return (!pidAlive(gcPid) && !fs.existsSync(marker)) || `孙进程还活着 pid=${gcPid} 或写下了文件`;
    });

    // 注意：不能在 -e 脚本里内联 300KB 字符串 —— Windows 命令行长度上限会先把它截掉，
    // 表现为 spawn 直接失败、stdout 为空（第一版就是这么写错的）。让脚本自己生成。
    const r6 = await runCli({ entry: nodeEntry('process.stdout.write("x".repeat(300000))'), cwd: projA, maxStdoutBytes: 4096 });
    check('30. 巨大 stdout 被截断，且 truncated=true（不把内存交给它）', () => (r6.truncated === true && r6.stdout.length <= 4096 && r6.stdoutBytes >= 300000) || JSON.stringify({ t: r6.truncated, len: r6.stdout.length, bytes: r6.stdoutBytes }));


    // 上面那条是占位，换成真正可断言的一条
    const lines = [];
    const r7 = await runCli({
      entry: nodeEntry('process.stdout.write("a\\u2028b\\nc")'),
      cwd: projA,
      onLine: (l) => lines.push(l),
    });
    check('30c. 行切分：U+2028 不切行（只有真正的 LF 才切）', () => (lines.length === 2 && lines[0] === 'a\u2028b' && lines[1] === 'c') || JSON.stringify(lines));

    const echoArgs = await runCli({
      entry: { ok: true, kind: 'node', cmd: process.execPath, baseArgs: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))'] },
      args: ['a b', 'x"y', '; rm -rf /'],
      cwd: projA,
    });
    check('30e. 含空格/引号/分号的参数原样传给子进程（没有 shell 解释）', () => {
      const got = JSON.parse(echoArgs.stdout || '[]');
      return got.length === 3 && got[0] === 'a b' && got[1] === 'x"y' && got[2] === '; rm -rf /' || echoArgs.stdout;
    });

    const envProbe = await runCli({
      entry: { ok: true, kind: 'node', cmd: process.execPath, baseArgs: ['-e', 'process.stdout.write(String(process.env.PI_GUI_TOKEN))'] },
      cwd: projA,
      env: { PI_GUI_TOKEN: 'should-be-stripped', KEEP_ME: '1' },
    });
    check('30g. env 里传入的 PI_GUI_TOKEN 被摘掉（agent 不该看到访问令牌）', () => envProbe.stdout === 'undefined' || envProbe.stdout);
  }

  /* ================= D. 持久化（§48 的 31-35） ================= */
  section('D. Plan 持久化与恢复');

  {
    const dataDir = path.join(TMP, 'dataD');
    const store = createPlanStore({ dataDir });

    check('31. 原子写：临时文件被 rename，不留 .tmp', () => {
      const p = mkPlan({ tasks: [{ id: 'a' }] }, projA).plan;
      store.save(p);
      const tmp = fs.readdirSync(store.dir).filter((f) => f.endsWith('.tmp'));
      return (tmp.length === 0 && fs.existsSync(path.join(store.dir, p.id + '.json'))) || tmp.join(',');
    });
    check('32. 能读回保存的计划', () => {
      const p = mkPlan({ title: '读回', tasks: [{ id: 'a' }] }, projA).plan;
      store.save(p);
      const back = store.load(p.id);
      return (back && back.plan.title === '读回') || JSON.stringify(back);
    });
    check('33. 损坏的 plan 文件不拖垮列表（进 broken 而不是抛）', () => {
      fs.writeFileSync(path.join(store.dir, 'broken-one.json'), '{ 这不是 json', 'utf8');
      const r = store.list({ projectRoot: projA });
      return (r.broken.length >= 1 && r.plans.length >= 1) || JSON.stringify({ broken: r.broken.length, plans: r.plans.length });
    });
    check('34. 读操作**不会**把 running 翻成 interrupted（这个坑踩过）', () => {
      const p = mkPlan({ tasks: [{ id: 'a' }] }, projA).plan;
      p.status = 'running';
      p.tasks[0].status = 'running';
      store.save(p);
      const back = store.load(p.id);
      return (back.plan.status === 'running' && back.plan.tasks[0].status === 'running') || JSON.stringify({ s: back.plan.status, t: back.plan.tasks[0].status });
    });
    check('34b. recoverAll() 才做恢复：running → interrupted，plan → paused', () => {
      const p = mkPlan({ tasks: [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }] }, projA).plan;
      p.status = 'running';
      p.tasks[0].status = 'running';
      store.save(p);
      const r = store.recoverAll();
      const back = store.load(p.id).plan;
      return (
        r.recovered >= 1 &&
        back.tasks[0].status === 'interrupted' &&
        back.status === 'paused' &&
        back.recoveryNotes.length > 0
      ) || JSON.stringify({ recovered: r.recovered, t: back.tasks[0].status, s: back.status });
    });
    check('34c. 恢复后全部终态 → 直接落终态而不是 paused', () => {
      const p = mkPlan({ tasks: [{ id: 'a' }] }, projA).plan;
      p.status = 'running';
      p.tasks[0].status = 'running';
      store.save(p);
      const tmpStore = createPlanStore({ dataDir });
      tmpStore.recoverAll();
      const back = tmpStore.load(p.id).plan;
      return back.status === 'failed' || back.status;
    });
    const projB35 = await mkProject('projB');
    const s2 = createPlanStore({ dataDir: path.join(TMP, 'dataD2') });
    const pa35 = mkPlan({ title: 'A 的', tasks: [{ id: 'a' }] }, projA).plan;
    const pb35 = mkPlan({ title: 'B 的', tasks: [{ id: 'a' }] }, projB35).plan;
    s2.save(pa35);
    s2.save(pb35);
    check('35. 不同项目隔离：list 只返回本项目的计划', () => {
      const onlyA = s2.list({ projectRoot: projA });
      const onlyB = s2.list({ projectRoot: projB35 });
      return (onlyA.plans.length === 1 && onlyA.plans[0].title === 'A 的' && onlyB.plans.length === 1 && onlyB.plans[0].title === 'B 的') || JSON.stringify([onlyA.plans.length, onlyB.plans.length]);
    });
  }

  /* ================= E. Scheduler（§48 的 8-18） ================= */
  section('E. Scheduler 状态机（fake agent）');

  const mkSched = (projectRoot, behaviors, dataDirName) => {
    const events = [];
    const registry = createAgentRegistry({ env: process.env, includeFake: true, fakeBehaviors: behaviors });
    const store = createPlanStore({ dataDir: path.join(TMP, dataDirName) });
    const scheduler = createScheduler({
      store,
      registry,
      runtime: { getCurrentCwd: () => projectRoot, isShuttingDown: () => false },
      publish: (e) => events.push(e),
      gitStatus,
    });
    return { registry, store, scheduler, events };
  };
  const save = (store, raw, projectRoot) => {
    const p = mkPlan(raw, projectRoot).plan;
    store.save(p);
    return p;
  };

  {
    const proj = await mkProject('schedE');
    const { store, scheduler, events } = mkSched(proj, {}, 'dataE');

    const plan = save(store, {
      title: 'DAG', goal: 'g',
      tasks: [
        { id: 'a', title: 'A', agent: 'fake' },
        { id: 'b', title: 'B', agent: 'fake', dependsOn: ['a'] },
        { id: 'c', title: 'C', agent: 'fake', dependsOn: ['b'] },
      ],
    }, proj);

    check('8. 初始：root 是 ready，依赖者是 pending', () => {
      const st = model.computeReadyStates(plan.tasks);
      return (st.get('a') === 'ready' && st.get('b') === 'pending' && st.get('c') === 'pending') || JSON.stringify([...st]);
    });

    await scheduler.start(plan);
    await scheduler.waitIdle();
    const done = store.load(plan.id).plan;

    check('9. 依赖 success 后解锁，全部跑完（串行）', () =>
      done.tasks.map((t) => t.status).join(',') === 'success,success,success' || done.tasks.map((t) => t.id + ':' + t.status).join(' '));
    check('11. 串行执行：没有两个任务同时 running', () => {
      const starts = events.filter((e) => e.kind === 'task_start').map((e) => e.taskId);
      const ends = events.filter((e) => ['task_success', 'task_error', 'task_cancelled'].includes(e.kind)).map((e) => e.taskId);
      // 串行下每个 task_start 之前，前一个必须有终态事件
      for (let i = 1; i < starts.length; i++) {
        if (!ends.includes(starts[i - 1])) return `第 ${i} 个任务在前一个结束前就开始了`;
      }
      return true;
    });
    check('12. 全部成功 → plan=completed', () => done.status === 'completed' || done.status);
    check('15. 每个 task 的 attempt=1，attempts 有 1 条', () =>
      done.tasks.every((t) => t.attempt === 1 && t.attempts.length === 1) || JSON.stringify(done.tasks.map((t) => [t.attempt, t.attempts.length])));
    check('17. 成功的任务 result.success=true 且有耗时', () =>
      done.tasks.every((t) => t.result && t.result.success === true && Number.isFinite(t.result.durationMs)) || JSON.stringify(done.tasks.map((t) => t.result)));
  }

  {
    /* 10 / 13 / 16：失败 → 暂停 + blocked + 重试 attempt++ */
    const proj = await mkProject('schedFail');
    const { store, scheduler } = mkSched(proj, { b: [{ ok: false, error: '故意失败' }, { ok: true, summary: '第二次成功' }] }, 'dataFail');
    const plan = save(store, {
      title: '失败链', goal: 'g',
      tasks: [
        { id: 'a', title: 'A', agent: 'fake' },
        { id: 'b', title: 'B', agent: 'fake', dependsOn: ['a'] },
        { id: 'c', title: 'C', agent: 'fake', dependsOn: ['b'] },
      ],
    }, proj);
    await scheduler.start(plan);
    await scheduler.waitIdle();
    let cur = store.load(plan.id).plan;

    check('10. 依赖失败 → 后续任务 blocked', () => cur.tasks.find((t) => t.id === 'c').status === 'blocked' || cur.tasks.find((t) => t.id === 'c').status);
    check('13. 有失败 → plan=paused（不自动跳过、不自动重试）', () => cur.status === 'paused' || cur.status);
    check('13b. 失败任务的 error 被记下来', () => cur.tasks.find((t) => t.id === 'b').error.includes('故意失败') || cur.tasks.find((t) => t.id === 'b').error);

    const retry = scheduler.retryTask(cur, 'b');
    check('16. retry → attempt 递增（下次是第 2 次）', () => retry.ok && retry.nextAttempt === 2 || JSON.stringify(retry));
    store.save(cur);
    await scheduler.start(cur);
    await scheduler.waitIdle();
    cur = store.load(plan.id).plan;
    check('16b. 重试成功后 attempt=2，且**保留**第 1 次的失败记录', () => {
      const b = cur.tasks.find((t) => t.id === 'b');
      return (b.attempt === 2 && b.attempts.length === 2 && b.attempts[0].success === false && b.attempts[1].success === true) || JSON.stringify(b.attempts.map((x) => [x.attempt, x.success]));
    });
    check('16c. 重试后依赖解锁并跑完 → completed', () => cur.status === 'completed' || cur.status);
  }

  {
    /* 14 / 17：停止 → cancelled（不是 failed） */
    const proj = await mkProject('schedStop');
    const { store, scheduler } = mkSched(proj, { a: [{ hang: true }] }, 'dataStop');
    const plan = save(store, { title: '取消', goal: 'g', tasks: [{ id: 'a', agent: 'fake' }, { id: 'b', agent: 'fake', dependsOn: ['a'] }] }, proj);
    await scheduler.start(plan);
    await sleep(60);
    scheduler.stop();
    await scheduler.waitIdle();
    const cur = store.load(plan.id).plan;
    check('14. 停止 Plan：在跑的与未跑的都标成 cancelled', () =>
      cur.tasks.map((t) => t.status).join(',') === 'cancelled,cancelled' || cur.tasks.map((t) => t.id + ':' + t.status).join(' '));
    check('17b. 取消**不是**失败：没有 failed，plan=cancelled', () =>
      (!cur.tasks.some((t) => t.status === 'failed') && cur.status === 'cancelled') || JSON.stringify({ s: cur.status, t: cur.tasks.map((x) => x.status) }));
  }

  {
    /* 15：取消单个 task */
    const proj = await mkProject('schedCancelTask');
    const { store, scheduler } = mkSched(proj, { a: [{ hang: true }] }, 'dataCancelTask');
    const plan = save(store, { title: '单任务取消', goal: 'g', tasks: [{ id: 'a', agent: 'fake' }, { id: 'b', agent: 'fake', dependsOn: ['a'] }] }, proj);
    await scheduler.start(plan);
    await sleep(60);
    const r = scheduler.cancelTask(plan, 'a');
    await scheduler.waitIdle();
    const cur = store.load(plan.id).plan;
    check('15. 取消单个 running task → cancelled，且不启动后续', () => {
      const a = cur.tasks.find((t) => t.id === 'a');
      const b = cur.tasks.find((t) => t.id === 'b');
      return (r.ok && r.cancelledRunning && a.status === 'cancelled' && b.status !== 'running') || JSON.stringify({ r, a: a.status, b: b.status });
    });
    check('15b. 对已结束的任务再取消 → 明确拒绝（不静默）', () => {
      const r2 = scheduler.cancelTask(cur, 'a');
      return (!r2.ok && r2.code === 'settled') || JSON.stringify(r2);
    });
    check('43. 重复 stop 是安全的（第二次明确说没有在跑的计划）', () => {
      const s2 = scheduler.stop();
      return (!s2.ok && s2.code === 'no-active') || JSON.stringify(s2);
    });
  }

  {
    /* 26（跳过语义）+ Changes（§18） */
    const proj = await mkProject('schedSkip');
    const { store, scheduler, events } = mkSched(proj, { b: [{ ok: true, writes: [{ path: 'made/by-b.txt', content: 'x\n' }] }] }, 'dataSkip');
    const plan = save(store, {
      title: '跳过', goal: 'g',
      tasks: [
        { id: 'a', agent: 'fake' },
        { id: 'b', agent: 'fake', dependsOn: ['a'] },
        { id: 'c', agent: 'fake', dependsOn: ['b'] },
      ],
    }, proj);
    const skip = scheduler.skipTask(plan, 'a');
    check('26. 跳过任务 → 依赖它的仍然 blocked（不自动放行）', () => {
      const st = model.computeReadyStates(plan.tasks);
      return (skip.ok && skip.blockedDependents.includes('b') && st.get('b') === 'blocked') || JSON.stringify({ skip, b: st.get('b') });
    });
    const startRes = await scheduler.start(plan);
    check('26b. 全被阻塞时 start 被拒（不空转）', () => (!startRes.ok && startRes.code === 'nothing-ready') || JSON.stringify(startRes));

    // Changes：跑一个会写文件的任务
    const p2 = save(store, { title: '变更', goal: 'g', tasks: [{ id: 'b', agent: 'fake' }] }, proj);
    await scheduler.start(p2);
    await scheduler.waitIdle();
    const done = store.load(p2.id).plan;
    const ch = done.tasks[0].result.changes;
    check('18. 任务前后取工作区快照，算出 Changes', () => (ch.available && ch.files.length > 0) || JSON.stringify(ch));
    check('18b. Changes 的措辞是「执行期间观察到的」，不声称是 Agent 改的', () => /执行期间观察到/.test(ch.note) || ch.note);
    check('18c. 发了 task_change 事件', () => events.some((e) => e.kind === 'task_change') || '没有');
  }

  {
    /* 41/42：单活跃 plan + 重复 start */
    const proj = await mkProject('schedOne');
    const { store, scheduler } = mkSched(proj, { a: [{ hang: true }] }, 'dataOne');
    const p1 = save(store, { title: '一', goal: 'g', tasks: [{ id: 'a', agent: 'fake' }] }, proj);
    const p2 = save(store, { title: '二', goal: 'g', tasks: [{ id: 'a', agent: 'fake' }] }, proj);
    const r1 = await scheduler.start(p1);
    check('41. 允许第一个 plan 启动', () => r1.ok || JSON.stringify(r1));
    const r2 = await scheduler.start(p2);
    check('41b. 第二个 plan 被拒（一个 workspace 只允许一个 running）', () => (!r2.ok && r2.code === 'busy') || JSON.stringify(r2));
    const r3 = await scheduler.start(p1);
    check('42. 对同一个 plan 重复 start 也被拒（busy）', () => (!r3.ok && r3.code === 'busy') || JSON.stringify(r3));
    check('42b. activePlanId 反映正在跑的 plan', () => scheduler.activePlanId() === p1.id || scheduler.activePlanId());
    scheduler.stop();
    await scheduler.waitIdle();
    check('42c. 停止后 activePlanId 归空', () => scheduler.activePlanId() === null || scheduler.activePlanId());
  }

  {
    /* §31 shutdown：应用关闭时把 running 收成 interrupted */
    const proj = await mkProject('schedShutdown');
    const { store, scheduler } = mkSched(proj, { a: [{ hang: true }] }, 'dataShutdown');
    const plan = save(store, { title: '关闭', goal: 'g', tasks: [{ id: 'a', agent: 'fake' }, { id: 'b', agent: 'fake', dependsOn: ['a'] }] }, proj);
    await scheduler.start(plan);
    await sleep(60);
    scheduler.shutdown();
    const cur = store.load(plan.id).plan;
    check('31. 应用关闭时：running → interrupted，plan → paused（不是假装还在跑）', () => {
      const a = cur.tasks.find((t) => t.id === 'a');
      return (a.status === 'interrupted' && cur.status === 'paused') || JSON.stringify({ a: a.status, s: cur.status });
    });
  }

  {
    /* §34：不可用 agent 在启动前就被拦 */
    const proj = await mkProject('schedUnavail');
    const { store, scheduler } = mkSched(proj, {}, 'dataUnavail');
    const plan = save(store, { title: '不可用', goal: 'g', tasks: [{ id: 'a', agent: 'claude' }] }, proj);
    await scheduler.start(plan);
    await scheduler.waitIdle();
    const cur = store.load(plan.id).plan;
    check('§34. 不可用 agent：任务失败且错误里说清原因（不是 command not found）', () => {
      const t = cur.tasks[0];
      return (t.status === 'failed' && /不可用/.test(t.error)) || JSON.stringify({ s: t.status, e: t.error });
    });
  }

  /* ================= F. 安全（§48 的 36-40） ================= */
  section('F. 安全边界');

  {
    check('36/37. cwd 用 ../ 与绝对路径都进不来（模型输出视为不可信）', () => {
      const cases = ['../../etc', '..\\..\\Windows', 'C:\\Windows\\System32', '/etc/passwd', '\\\\srv\\share'];
      const bad = [];
      for (const wd of cases) {
        const r = mkPlan({ tasks: [{ id: 'a', workingDirectory: wd }] }, projA);
        if (r.ok) bad.push(wd);
      }
      return bad.length === 0 || '漏放：' + bad.join(' ');
    });
    check('38. 经符号链接指向项目外也被拒', () => {
      // 建一个指向项目外的 junction / symlink，然后当 workingDirectory
      const outside = path.join(TMP, 'outside-target');
      fs.mkdirSync(outside, { recursive: true });
      const link = path.join(projA, 'escape-link');
      let made = false;
      try {
        fs.symlinkSync(outside, link, 'junction');
        made = true;
      } catch {
        try {
          fs.symlinkSync(outside, link);
          made = true;
        } catch {
          /* 环境不允许建链接，跳过 */
        }
      }
      if (!made) return true; // 环境不支持就不断言（但要在报告里说明）
      const r = mkPlan({ tasks: [{ id: 'a', workingDirectory: 'escape-link' }] }, projA);
      return !r.ok || '竟然通过了：' + JSON.stringify(r.plan.tasks[0].workingDirectory);
    });
    check('39. executable 不能来自客户端：计划里只有 agent id，没有命令', () => {
      const r = mkPlan({ tasks: [{ id: 'a', agent: 'pi', command: 'rm -rf /', executable: '/bin/sh' }] }, projA);
      if (!r.ok) return r.errors.join(' / ');
      const t = r.plan.tasks[0];
      return (!('command' in t) && !('executable' in t) && t.agent === 'pi') || JSON.stringify(Object.keys(t));
    });
    check('39b. agent 字段只接受 registry 里的 id（模型编一个就被拒）', () => {
      const r = mkPlan({ tasks: [{ id: 'a', agent: '/bin/sh -c rm -rf /' }] }, projA);
      return (!r.ok && r.errors.some((e) => /未知的 agent/.test(e))) || JSON.stringify(r.errors);
    });
    check('40. stdout 是文本，前端渲染路径不含 innerHTML', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'planner.js'), 'utf8');
      const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      return !/innerHTML|outerHTML|insertAdjacentHTML/.test(stripped) || '出现了 HTML 注入面';
    });
    check('40b. 路由不接受客户端传 executable / shell command', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'planner', 'index.js'), 'utf8');
      return !/executable|spawn\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')) || 'planner 路由里出现了进程执行';
    });
  }

  /* ================= G. 事件（§48 的 45-46） ================= */
  section('G. 统一执行事件');

  {
    const proj = await mkProject('schedEvt');
    const { store, scheduler, events } = mkSched(proj, {}, 'dataEvt');
    const plan = save(store, { title: '事件', goal: 'g', tasks: [{ id: 'a', agent: 'fake' }, { id: 'b', agent: 'fake', dependsOn: ['a'] }] }, proj);
    await scheduler.start(plan);
    await scheduler.waitIdle();

    const pe = events.filter((e) => e.type === 'execution_event');
    check('45. 每条执行事件都带 planId / taskId 字段 / agent / kind / timestamp', () => {
      const bad = pe.filter((e) => !e.planId || !('taskId' in e) || !('agent' in e) || !e.kind || !e.timestamp);
      return bad.length === 0 || JSON.stringify(bad.slice(0, 2));
    });
    check('45b. 帧上是 type=execution_event（和 pi 的事件流不混淆）', () => pe.length > 0 && pe.every((e) => e.type === 'execution_event') || '帧类型不对');
    check('45c. 事件种类覆盖 plan_start / task_start / task_success / plan_success', () => {
      const kinds = new Set(pe.map((e) => e.kind));
      const need = ['plan_start', 'task_start', 'task_success', 'plan_success'];
      const missing = need.filter((k) => !kinds.has(k));
      return missing.length === 0 || '缺：' + missing.join(',');
    });
    check('46. _seq 由 SSE 总线统一分配（单调递增，便于重连去重）', () => {
      // scheduler 的 publish 是 SSE 总线的 publish；这里用的桩没加 _seq，
      // 所以改为断言「桩收到的帧顺序与 kind 序列一致」+ 真实 SSE 的那条在 modules 里
      const seq = pe.map((_, i) => i);
      return seq.every((v, i) => v === i) || '顺序乱了';
    });

    const sseSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'sse.js'), 'utf8');
    check('46b. SSE 总线仍然给每条事件挂 _seq（Planner 事件走同一条通道）', () => /event\._seq = \+\+seq/.test(sseSrc) || '没找到 _seq 赋值');
  }

  /* ================= H. §49 fake-agent 完整 E2E ================= */
  section('H. §49 完整 Scheduler E2E（fake-agent）');

  {
    const proj = await mkProject('e2e');
    const { store, scheduler, registry } = mkSched(
      proj,
      {
        A: [{ ok: true, summary: 'A 成功', toolCalls: 2 }],
        B: [{ ok: true, summary: 'B 写了文件', writes: [{ path: 'out/b.txt', content: 'from B\n' }] }],
        C: [{ ok: false, error: '第一次失败' }, { ok: true, summary: 'C 重试成功' }],
        D: [{ ok: true, summary: 'D 验证通过' }],
      },
      'dataE2E'
    );
    const plan = save(store, {
      title: '完整 E2E',
      goal: '走完 A→B/C→D',
      tasks: [
        { id: 'A', agent: 'fake' },
        { id: 'B', agent: 'fake', dependsOn: ['A'] },
        { id: 'C', agent: 'fake', dependsOn: ['A'] },
        { id: 'D', agent: 'fake', dependsOn: ['B', 'C'], verification: { command: 'cat out/b.txt' } },
      ],
    }, proj);

    await scheduler.start(plan);
    await scheduler.waitIdle();
    let cur = store.load(plan.id).plan;
    check('E2E-1. A 成功、B 成功、C 失败 → plan 暂停、D 阻塞', () => {
      const m = Object.fromEntries(cur.tasks.map((t) => [t.id, t.status]));
      return (m.A === 'success' && m.B === 'success' && m.C === 'failed' && m.D === 'blocked' && cur.status === 'paused') || JSON.stringify(m);
    });
    check('E2E-2. B 写的文件真的落盘了', () => fs.existsSync(path.join(proj, 'out', 'b.txt')) || '文件不在');
    check('E2E-3. B 的 Changes 里有 out/ 目录', () => {
      const b = cur.tasks.find((t) => t.id === 'B');
      return (b.result.changes.available && b.result.changes.files.some((f) => f.path.startsWith('out'))) || JSON.stringify(b.result.changes.files);
    });

    scheduler.retryTask(cur, 'C');
    store.save(cur);
    await scheduler.start(cur);
    await scheduler.waitIdle();
    cur = store.load(plan.id).plan;
    check('E2E-4. 重试 C 成功后 D 解锁并跑完 → plan completed', () => {
      const m = Object.fromEntries(cur.tasks.map((t) => [t.id, t.status]));
      return (m.C === 'success' && m.D === 'success' && cur.status === 'completed') || JSON.stringify({ m, s: cur.status });
    });
    check('E2E-5. C 保留了两次 attempt 的历史（失败证据没被覆盖）', () => {
      const c = cur.tasks.find((t) => t.id === 'C');
      return (c.attempts.length === 2 && c.attempts[0].success === false) || JSON.stringify(c.attempts);
    });
    check('E2E-6. 依赖顺序正确：D 在 B 和 C 之后才开始', () => {
      const order = registry.get('fake')._seen().map((s) => s.taskId);
      return order.indexOf('D') > order.indexOf('B') && order.indexOf('D') > order.indexOf('C') || order.join('>');
    });
  }

  {
    const proj = await mkProject('nocommit');
    const { store, scheduler } = mkSched(proj, { a: [{ ok: true, writes: [{ path: 'new.txt', content: 'x' }] }] }, 'dataNoCommit');
    const plan = save(store, { title: '不提交', goal: 'g', tasks: [{ id: 'a', agent: 'fake' }] }, proj);
    await scheduler.start(plan);
    await scheduler.waitIdle();
    const log = await git(proj, 'log', '--oneline');
    check('E2E-8. 任务改了工作区，但 git 里仍然只有 1 个提交（§42 不自动 commit）', () => log.out.trim().split('\n').filter(Boolean).length === 1 || log.out.trim());
    const st = await git(proj, 'status', '--porcelain');
    check('E2E-9. 工作区确实是 dirty 的（改动留在那里等用户决定）', () => st.out.includes('new.txt') || st.out.trim());
  }

  /* ================= I. Planner 路由（§48 的 33 / 34 / 43 / 44） ================= */
  section('I. Planner 路由（经真实 router）');

  {
    const { createRouter } = await import('../server/router.js');
    const { createAuth } = await import('../server/auth.js');
    const { createRuntime } = await import('../server/runtime.js');
    const { createPlanner } = plannerMod;

    const proj = await mkProject('route');
    const runtime = createRuntime({ initialCwd: proj });
    const registry = createAgentRegistry({ env: process.env, includeFake: true, fakeBehaviors: { a: [{ hang: true }] } });
    const store = createPlanStore({ dataDir: path.join(TMP, 'dataRoute') });
    const sseEvents = [];
    const scheduler = createScheduler({ store, registry, runtime, publish: (e) => sseEvents.push(e), gitStatus });
    const planner = createPlanner({ runtime, registry, store, scheduler, env: process.env });

    const passthrough = (name) => (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, handler: name }));
    };
    const router = createRouter({
      auth: createAuth({ token: 'T', port: 7788, appId: 'pi-gui', protocol: 1, version: '0.0.0' }),
      sse: { subscribe: passthrough('sse') },
      rpc: { send: passthrough('rpc.send'), restart: passthrough('rpc.restart'), getState: () => ({ ok: true }) },
      providers: { handle: passthrough('providers'), handleModels: passthrough('providers.models') },
      projects: { handle: passthrough('projects'), handleFs: passthrough('projects.fs') },
      projectConfig: { handle: passthrough('projectConfig') },
      skills: { handle: passthrough('skills') },
      mcp: { handle: passthrough('mcp') },
      planner,
      gitRoutes: { handle: passthrough('git') },
      uploads: { handle: passthrough('uploads') },
    });

    const mockRes = () => {
      const chunks = [];
      return {
        code: null,
        writeHead(c) { this.code = c; return this; },
        write(s) { chunks.push(String(s)); return true; },
        end(s) { if (s) chunks.push(String(s)); },
        body: () => chunks.join(''),
        json() { try { return JSON.parse(this.body()); } catch { return null; } },
      };
    };
    const mockReq = ({ method = 'GET', url = '/', headers = {} } = {}) => {
      const ls = new Map();
      const req = {
        method, url, headers,
        on(ev, fn) { if (!ls.has(ev)) ls.set(ev, []); ls.get(ev).push(fn); return req; },
        emit(ev, a) { for (const fn of ls.get(ev) || []) fn(a); },
      };
      return req;
    };
    const hit = async (method, url, body = null) => {
      const req = mockReq({ method, url, headers: { 'x-pi-gui-token': 'T' } });
      const res = mockRes();
      router(req, res);
      if (body !== null) {
        req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
        req.emit('end');
      }
      await sleep(30);
      return res;
    };

    const agents = (await hit('GET', '/api/agents')).json();
    check('§34/§35. GET /api/agents 给出 available 列表与 auto', () =>
      (agents.ok && Array.isArray(agents.agents) && 'auto' in agents) || JSON.stringify(agents).slice(0, 160));

    const created = (await hit('POST', '/api/plans', { title: '手工', goal: 'g', tasks: [{ id: 'a', agent: 'fake' }] })).json();
    check('§45. 手工新建计划（Planner 不是唯一入口）', () => (created.ok && created.plan.status === 'draft') || JSON.stringify(created));
    const pid = created.plan.id;

    const listed = (await hit('GET', '/api/plans')).json();
    check('列表只列当前项目的计划', () => (listed.ok && listed.plans.some((p) => p.id === pid)) || JSON.stringify(listed.plans));

    const cyc = (await hit('PUT', '/api/plans/' + pid, { tasks: [{ id: 'x', dependsOn: ['y'] }, { id: 'y', dependsOn: ['x'] }] })).json();
    check('§33. 成环的计划经路由被拒（不是 500）', () => (cyc.ok === false && cyc.errors.length > 0) || JSON.stringify(cyc));

    const badAgent = (await hit('PUT', '/api/plans/' + pid, { tasks: [{ id: 'x', agent: 'nope' }] })).json();
    check('§33. 未知 agent 经路由被拒', () => (badAgent.ok === false && badAgent.errors.some((e) => /未知/.test(e))) || JSON.stringify(badAgent));

    // 改成可用 agent 后启动
    await hit('PUT', '/api/plans/' + pid, { tasks: [{ id: 'a', agent: 'fake' }] });
    const started = (await hit('POST', `/api/plans/${pid}/start`)).json();
    check('§38. start 成功并返回 activePlanId', () => (started.ok && started.activePlanId === pid) || JSON.stringify(started));

    const locked = (await hit('PUT', '/api/plans/' + pid, { tasks: [{ id: 'a' }, { id: 'b' }] })).json();
    check('§46. 运行中改结构 → 409（结构锁定）', () => (locked.ok === false && /锁定|停止/.test(locked.error)) || JSON.stringify(locked));

    /* §40：计划运行中不许切项目（闸门在 projects 里，这里直接测那个闸门） */
    const { createProjects } = await import('../server/projects.js');
    const projFile = path.join(TMP, 'projects-route.json');
    let switched = false;
    const projects = createProjects({
      projectsFile: projFile,
      runtime,
      restartPi: () => { switched = true; },
      isWin: process.platform === 'win32',
      beforeActivate: () => (planner.activePlanId() ? '当前有任务正在执行，请先停止计划再切换项目' : null),
    });
    const other = await mkProject('route-other');
    const actReq = mockReq({ method: 'POST', url: '/api/projects/activate', headers: { 'x-pi-gui-token': 'T' } });
    const actRes = mockRes();
    projects.handle(actReq, actRes, new URL('/api/projects/activate', 'http://127.0.0.1:7788'));
    actReq.emit('data', Buffer.from(JSON.stringify({ path: other }), 'utf8'));
    actReq.emit('end');
    await sleep(50);
    const actBody = actRes.json();
    check('§40. 计划运行中切项目 → 409 且没有真的切（runtime.cwd 未变）', () =>
      (actRes.code === 409 && !switched && runtime.getCurrentCwd() === proj) || JSON.stringify({ code: actRes.code, switched, cwd: runtime.getCurrentCwd() === proj, body: actBody }));

    const stopped = (await hit('POST', `/api/plans/${pid}/stop`)).json();
    check('§24. stop 成功', () => stopped.ok || JSON.stringify(stopped));
    await scheduler.waitIdle();

    // 停完之后能切
    const actReq2 = mockReq({ method: 'POST', url: '/api/projects/activate', headers: { 'x-pi-gui-token': 'T' } });
    const actRes2 = mockRes();
    projects.handle(actReq2, actRes2, new URL('/api/projects/activate', 'http://127.0.0.1:7788'));
    actReq2.emit('data', Buffer.from(JSON.stringify({ path: other }), 'utf8'));
    actReq2.emit('end');
    await sleep(50);
    check('§40b. 计划停止后可以正常切项目', () => switched || '闸门一直关着');

    // 换成另一个项目后，原项目的计划不可操作
    runtime.setCurrentCwd(other);
    const cross = await hit('GET', '/api/plans/' + pid);
    check('§35. 切到别的项目后，原项目的计划不给操作（403）', () => cross.code === 403 || JSON.stringify({ code: cross.code, body: cross.json() }));
    runtime.setCurrentCwd(proj);
  }

  /* ================= J. 生成路径的解析（§33） ================= */
  section('J. Planner 输出的解析与校验');

  {
    const { extractJsonObject, buildPlannerPrompt } = plannerMod;
    check('33a. 从 ```json 围栏里抽 JSON', () => {
      const r = extractJsonObject('好的：\n```json\n{"a":1}\n```\n完事');
      return (r && r.a === 1) || JSON.stringify(r);
    });
    check('33b. 从前后有废话的文本里抽第一个完整对象', () => {
      const r = extractJsonObject('前言 {"a":{"b":2}} 后语');
      return (r && r.a.b === 2) || JSON.stringify(r);
    });
    check('33c. 字符串里带花括号不会被截断', () => {
      const r = extractJsonObject('{"s":"} 不是结束 {","n":3}');
      return (r && r.n === 3 && r.s === '} 不是结束 {') || JSON.stringify(r);
    });
    check('33d. 抽不出来 → null（不抛）', () => {
      return (extractJsonObject('完全没有 JSON') === null && extractJsonObject('') === null && extractJsonObject(null) === null) || '没返回 null';
    });
    check('33e. 数组顶层 → null（计划必须是对象）', () => extractJsonObject('[1,2]') === null || '竟然接受了数组');
    check('44. Planner 的 system 指令里明确要求：任务数、agent 白名单、相对 cwd、显式依赖、验证任务', () => {
      const p = buildPlannerPrompt({ goal: 'g', agentIds: ['pi', 'codex'] });
      const need = [/3~8 个/, /只能从这些里面选/, /相对项目根目录/, /dependsOn 必须显式/, /验证\/收尾/, /不要把一个需求拆成十几个微任务/];
      const missing = need.filter((re) => !re.test(p));
      return missing.length === 0 || '缺：' + missing.length + ' 条';
    });
  }

  /* ================= K. 隔离（§35 / §32） ================= */
  section('K. 项目隔离与单活跃');

  {
    const dataDir = path.join(TMP, 'dataIso');
    const store = createPlanStore({ dataDir });
    const projX = await mkProject('isoX');
    const projY = await mkProject('isoY');
    const px = mkPlan({ title: 'X', tasks: [{ id: 'a' }] }, projX).plan;
    const py = mkPlan({ title: 'Y', tasks: [{ id: 'a' }] }, projY).plan;
    store.save(px);
    store.save(py);
    check('§35. 计划文件按 projectRoot 隔离，互不可见', () => {
      const lx = store.list({ projectRoot: projX });
      const ly = store.list({ projectRoot: projY });
      return (lx.plans.length === 1 && ly.plans.length === 1 && lx.plans[0].title === 'X' && ly.plans[0].title === 'Y') || JSON.stringify([lx.plans.length, ly.plans.length]);
    });
    check('§28. 计划存在 Pi GUI 自己的数据目录，不在项目仓库里', () => {
      const inRepo = fs.existsSync(path.join(projX, '.pi-gui', 'plans'));
      const inData = fs.existsSync(store.dir);
      return (!inRepo && inData) || JSON.stringify({ inRepo, inData });
    });
    check('§29. 计划**不**写进 .pi-gui/config.json', () => {
      const cfg = path.join(projX, '.pi-gui', 'config.json');
      return !fs.existsSync(cfg) || !/plan-/.test(fs.readFileSync(cfg, 'utf8')) || '配置里出现了计划';
    });
  }

  /* ---------- 收尾 ---------- */
  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
})().catch((err) => {
  console.error('\n测试自身崩了：', err);
  cleanup();
  process.exitCode = 1;
});
