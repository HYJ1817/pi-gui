/* P10 —— 历史变更证据（Attempt 冻结的 Diff）。
 *
 * 要证明的核心：**历史证据不随当前工作区漂移**，而且它是「执行前 → 执行后」，
 * **不是**「HEAD → 现在」。后者会把用户在尝试开始前就已经有的改动算进来。
 *
 * 覆盖规格 §二十三 的后端清单 + §二十二 的两条 blocker。
 *
 * 分工：
 *   - 本文件       预/后快照怎么采、证据怎么组装与限额、以及四条写盘路径的所有权
 *   - `smoke.cjs`  历史 Diff 的前端行为（入口、面板、纯文本、XSS）
 *   - `visual-harness` / `cdp-shot`  历史 Diff 的**真实排版**
 *
 * 纪律：全程 os.tmpdir()。这里**真的**建 git 仓库、真的跑 git（证据采集本来就是
 * git 的事，造假的 fixture 等于没测）；但**不碰任何真实项目**。
 *
 * 用法：node tests/evidence.cjs
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-p10-'));
const DATA = path.join(TMP, 'data');
const PROJ = path.join(TMP, 'proj');
const PLAIN = path.join(TMP, 'plain'); // 非 git 目录
function cleanup() {
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* Windows 偶发占用 */
  }
}

/** 跑一次 git（同步等结果）。spawnSync 在本机会 EBUSY（已知陷阱），一律异步。 */
const git = (args, cwd = PROJ) =>
  new Promise((resolve) => {
    const c = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code, out }));
    c.on('error', (e) => resolve({ code: -1, out: String(e.message) }));
  });
const w = (rel, content) => {
  const p = path.join(PROJ, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};
const rm = (rel) => fs.rmSync(path.join(PROJ, rel), { force: true });

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

(async () => {
  const model = await import('../server/planner/model.js');
  const evidence = await import('../server/planner/evidence.js');
  const { createPlanStore, PLAN_SCHEMA_VERSION } = await import('../server/planner/store.js');
  const { createScheduler } = await import('../server/planner/scheduler.js');
  const { createAgentRegistry } = await import('../server/agents/index.js');
  const { createPlanner } = await import('../server/planner/index.js');
  const { createVerifier } = await import('../server/planner/verifier.js');
  const { gitStatus, worktreeTree, treeDiff, treeNumstat } = await import('../lib/git.js');

  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(PLAIN, { recursive: true });
  /* ⚠️ 必须先建 PROJ —— 在不存在的工作目录里 spawn 会直接失败，
   * 于是下面这串 git 命令全都白跑、仓库根本没建起来（第一版就是这么假红的）。 */
  fs.mkdirSync(PROJ, { recursive: true });

  /* ---------- 真 git 项目 ---------- */
  await git(['init', '-q']);
  await git(['config', 'user.email', 't@t']);
  await git(['config', 'user.name', 't']);
  w('src/a.js', 'const x = 1;\n');
  w('src/gone.js', '// 稍后删除\n');
  w('src/old.js', '// 稍后改名\n');
  fs.writeFileSync(path.join(PROJ, 'bin.png'), Buffer.from([0, 1, 2, 3, 0, 0, 9]));
  await git(['add', '-A']);
  await git(['commit', '-qm', 'init']);

  const BEHAVIORS = {
    /* 写文件 = 这次 attempt 的「执行期间变化」 */
    w1: [{ ok: true, summary: 'done', writes: [{ path: 'src/a.js', content: 'const x = 3;\n' }] }],
    wNew: [{ ok: true, summary: 'done', writes: [{ path: 'src/new.js', content: '// 新增\n' }] }],
    wXss: [{ ok: true, summary: 'done', writes: [{ path: 'src/xss.js', content: '<img src=x onerror=alert(1)>\n' }] }],
    /* 60 个文件 × 每个约 2 KB：**两条上限都要被撞到**（文件数 50、总量 64 KB） */
    wBig: [{ ok: true, summary: 'done', writes: Array.from({ length: 60 }, (_, i) => ({ path: `src/gen/f${i}.js`, content: `// file ${i}\n${'x'.repeat(40)}\n`.repeat(30) })) }],
    okOnly: [{ ok: true, summary: '没动文件' }],
    fail: [{ ok: false, error: '故意失败' }],
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
  const gitEvidence = { worktreeTree, treeDiff, treeNumstat };
  const scheduler = createScheduler({ store, registry, runtime, gitStatus, gitEvidence });
  /* 只为 E4 —— 证明**验证的写盘路径**也不碰 `changeEvidence`（§十七 的第四条）。
   * 假 runShell：不 spawn 真进程；`shellGate` 非 null 时先等它 —— 只在 E4 里用来
   * 制造「验证还在跑」的窗口。 */
  let shellGate = null;
  const fakeRunShell = async () => {
    if (shellGate) await shellGate;
    return {
      ok: true, exitCode: 0, stdout: 'ok\n', stderr: '', stdoutBytes: 3,
      truncated: false, timedOut: false, cancelled: false, spawnFailed: false, error: '',
    };
  };
  const verifier = createVerifier({ store, runtime, scheduler, runShell: fakeRunShell, timeoutMs: 5000, maxOutputBytes: 4096 });
  const planner = createPlanner({ runtime, registry, store, scheduler, verifier });

  /* ---------- 计划构造与执行 ---------- */

  const mkPlan = ({ id, taskId = 't1', agent = 'fake', projectRoot = PROJ, status = 'ready' }) => ({
    id,
    title: 'P10 ' + id,
    goal: '',
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    endedAt: null,
    projectRoot,
    concurrency: 1,
    recoveryNotes: [],
    source: null,
    tasks: [
      { id: taskId, title: '任务', description: '', agent, workingDirectory: '.', dependsOn: [], status: 'pending', startedAt: null, endedAt: null, attempt: 0, attempts: [], result: null, error: '', verification: null },
    ],
  });

  const load = (id) => store.load(id).plan;
  const attOf = (id, n = 1, taskId = 't1') => {
    const t = load(id).tasks.find((x) => x.id === taskId);
    return t && Array.isArray(t.attempts) ? t.attempts.find((x) => x.attempt === n) : null;
  };
  const evOf = (id, n = 1, taskId = 't1') => {
    const a = attOf(id, n, taskId);
    return a ? a.changeEvidence : undefined;
  };
  /** 起一个计划并等它跑完。 */
  async function runPlan(id, taskId = 't1') {
    runtime.setCurrentCwd(PROJ);
    const r = await scheduler.start(store.load(id).plan);
    if (!r.ok) throw new Error('start 失败：' + r.error + ' (' + r.code + ')');
    await scheduler.waitIdle(30000);
    const a = attOf(id, 1, taskId);
    return a;
  }

  /* ================= A. 解析与组装（纯函数） ================= */
  section('A. diff 解析与证据组装');

  {
    const d = evidence.splitUnifiedDiff(
      [
        'diff --git a/src/m.js b/src/m.js',
        'index 111..222 100644',
        '--- a/src/m.js',
        '+++ b/src/m.js',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git a/src/n.js b/src/n.js',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/n.js',
        '@@ -0,0 +1 @@',
        '+hi',
        'diff --git a/src/d.js b/src/d.js',
        'deleted file mode 100644',
        '--- a/src/d.js',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-bye',
      ].join('\n')
    );
    check('A1. modified / added / deleted 都认出来', () => {
      return d.get('src/m.js').change === 'modified' && d.get('src/n.js').change === 'added' && d.get('src/d.js').change === 'deleted' || JSON.stringify([...d.keys()]);
    });
    check('A1b. patch 内容带上了', () => /\+new/.test(d.get('src/m.js').patch) || d.get('src/m.js').patch);
  }

  {
    /* 实测形状：带空格的路径，`---`/`+++` 行末尾会多一个 TAB */
    const d = evidence.splitUnifiedDiff(['diff --git a/src/a b.js b/src/a b.js', '--- a/src/a b.js\t', '+++ b/src/a b.js\t', '@@ -1 +1 @@', '-x', '+y'].join('\n'));
    check('A2. 含空格的路径：末尾的 TAB 被剥掉（否则路径就是错的）', () => d.has('src/a b.js') || JSON.stringify([...d.keys()]));
  }

  {
    const d = evidence.splitUnifiedDiff(['diff --git a/old.js b/new.js', 'similarity index 100%', 'rename from old.js', 'rename to new.js'].join('\n'));
    const e = d.get('new.js');
    check('A3. rename：认得出，且记下 oldPath', () => (e && e.change === 'renamed' && e.oldPath === 'old.js') || JSON.stringify(e));
  }

  {
    const d = evidence.splitUnifiedDiff(['diff --git a/bin.png b/bin.png', 'Binary files a/bin.png and b/bin.png differ'].join('\n'));
    check('A4. binary：认得出，且**不带内容**', () => {
      const e = d.get('bin.png');
      return (e && e.binary === true && !/@|PNG|base64/.test(e.patch)) || JSON.stringify(e);
    });
  }

  {
    /* rename 在 numstat 里是**两条**记录（新旧各一条）—— 组装时只留一条。 */
    const built = evidence.buildChangeEvidence({
      stats: new Map([['new.js', { add: 0, del: 0 }], ['old.js', { add: 0, del: 0 }]]),
      diffText: ['diff --git a/old.js b/new.js', 'rename from old.js', 'rename to new.js'].join('\n'),
      meta: { capturedAt: 1, allowEmpty: true },
    });
    check('A5. rename 在证据里只有**一条**（不是新旧各一条）', () => built.files.length === 1 && built.files[0].path === 'new.js' || JSON.stringify(built.files.map((f) => f.path)));
    check('A5b. 并且带 oldPath', () => built.files[0].oldPath === 'old.js' || JSON.stringify(built.files[0]));
  }

  {
    /* 上限：单文件、总数、文件个数 —— 都要显式标 truncated。 */
    const many = new Map();
    for (let i = 0; i < 60; i++) many.set(`f${i}.js`, { add: 1, del: 0 });
    const big = ['diff --git a/f0.js b/f0.js', '--- a/f0.js', '+++ b/f0.js', 'x'.repeat(model.MAX_EVIDENCE_FILE_PATCH + 500)].join('\n');
    const built = evidence.buildChangeEvidence({ stats: many, diffText: big, meta: { capturedAt: 1, allowEmpty: true } });
    check('A6. 文件数超上限 → 只留前 N 个', () => built.files.length === model.MAX_EVIDENCE_FILES, String(built.files.length));
    check('A7. 单个文件的 patch 被截到上限', () => built.files[0].patch.length <= model.MAX_EVIDENCE_FILE_PATCH, String(built.files[0].patch.length));
    check('A8. **显式标了 truncated**（不悄悄裁）', () => built.truncated === true && built.status === 'partial' && built.files[0].truncated === true, JSON.stringify({ t: built.truncated, s: built.status }));
    check('A9. 总量也被限住', () => built.files.reduce((n, f) => n + f.patch.length, 0) <= model.MAX_EVIDENCE_TOTAL_PATCH, String(built.files.reduce((n, f) => n + f.patch.length, 0)));
    check('A10. 说明里点了「哪些被丢/被截」（用户要看得见）', () => /超过|截断/.test(built.note) || built.note);
  }

  {
    /* 手改过的计划文件不能把界面撑爆 —— 归一化时**再压一遍**上限。 */
    const nasty = model.normalizeChangeEvidence({
      status: 'available',
      capturedAt: 1,
      files: Array.from({ length: 200 }, () => ({ path: 'x.js', change: 'nope', patch: 'y'.repeat(999999), additions: 'many' })),
      truncated: false,
      note: 'n'.repeat(9999),
    });
    check('A11. 归一化会再压一遍：文件数 / patch / note 全部截到上限', () => {
      return nasty.files.length === model.MAX_EVIDENCE_FILES && nasty.files[0].patch.length <= model.MAX_EVIDENCE_FILE_PATCH && nasty.note.length <= 500;
    }, JSON.stringify({ f: nasty.files.length, p: nasty.files[0].patch.length, n: nasty.note.length }));
    check('A11b. 认不出的 change 退成 modified（不猜成别的）', () => nasty.files[0].change === 'modified');
    check('A11c. 认不出的 status 退成 unavailable', () => model.normalizeChangeEvidence({ status: 'weird' }).status === 'unavailable');
  }

  /* ================= B. 端到端捕获（真 git） ================= */
  section('B. 执行前 → 执行后（真 git，真 scheduler）');

  {
    /* modified：pre 与 post 之间改了 a.js */
    store.save(mkPlan({ id: 'e-mod', taskId: 'w1' }));
    const a = await runPlan('e-mod', 'w1');
    const ev = a.changeEvidence;
    check('B1. status = available', () => (ev && ev.status === 'available') || JSON.stringify(ev && ev.status));
    check('B2. 记下了那个文件（change=modified）', () => {
      const f = ev.files.find((x) => x.path === 'src/a.js');
      return (f && f.change === 'modified') || JSON.stringify(ev.files.map((x) => x.path + ':' + x.change));
    }, JSON.stringify(ev.files.map((x) => x.path)));
    check('B3. patch 是**执行前 → 执行后**的内容差', () => {
      const f = ev.files.find((x) => x.path === 'src/a.js');
      return (/-const x = 1;/.test(f.patch) && /\+const x = 3;/.test(f.patch)) || f.patch;
    });
    check('B4. 路径是**项目相对**的（没有绝对路径进证据）', () => ev.files.every((f) => !path.isAbsolute(f.path) && !/^[A-Za-z]:/.test(f.path) && !f.path.includes('\\')) || JSON.stringify(ev.files.map((f) => f.path)));
    check('B5. 证据里也没有绝对路径 / 临时目录泄露', () => !JSON.stringify(ev).includes(TMP) || '证据里出现了临时根路径');
  }

  {
    /* ② blocker B：dirty baseline —— 执行**前**用户已经改过 */
    w('src/a.js', 'const x = 2;\n'); // 用户自己改的（HEAD 是 x=1）
    store.save(mkPlan({ id: 'e-dirty', taskId: 'w1' }));
    const a = await runPlan('e-dirty', 'w1');
    const f = a.changeEvidence.files.find((x) => x.path === 'src/a.js');
    check('B6. **dirty 基线**：patch 是 2 → 3，**不是** 1 → 3（旧实现会拿 HEAD 当基线）', () => {
      return (/-const x = 2;/.test(f.patch) && /\+const x = 3;/.test(f.patch) && !/-const x = 1;/.test(f.patch)) || f.patch;
    }, f.patch);
    /* 复位，后面的用例要干净的起点 */
    w('src/a.js', 'const x = 1;\n');
  }

  {
    /* ③ added */
    store.save(mkPlan({ id: 'e-add', taskId: 'wNew' }));
    const a = await runPlan('e-add', 'wNew');
    const f = a.changeEvidence.files.find((x) => x.path === 'src/new.js');
    check('B7. added：change=added 且有内容', () => (f && f.change === 'added' && /\+/.test(f.patch)) || JSON.stringify(f && f.change));
    check('B8. untracked 的新文件也能进证据（这是 filesChanged 之外的增量）', () => Boolean(f) || 'untracked 新文件没进证据');
    /* 还原：C 段要靠「干净的工作区」当基线。 */
    rm('src/new.js');
  }

  {
    /* ④ deleted：让 fake 写别的文件，同时我们在 pre/post 之间删掉一个 —— 用注入的
     * 原语直接驱动那两步（scheduler 里是同一段代码）。 */
    const pre = await worktreeTree(PROJ);
    rm('src/gone.js');
    const post = await worktreeTree(PROJ);
    const ns = await treeNumstat(PROJ, pre.tree, post.tree);
    const df = await treeDiff(PROJ, pre.tree, post.tree);
    const ev = evidence.buildChangeEvidence({ stats: ns.stats, diffText: df.text, meta: { capturedAt: 1, allowEmpty: true } });
    const f = ev.files.find((x) => x.path === 'src/gone.js');
    check('B9. deleted：change=deleted 且有删掉的内容', () => (f && f.change === 'deleted' && /-\/\/ 稍后删除/.test(f.patch)) || JSON.stringify(f && f.change));
    check('B10. 补丁头是 /dev/null（added/deleted 的标准形状）', () => /^\+\+\+ \/dev\/null$/m.test(f.patch) || f.patch);
    /* 复位 */
    w('src/gone.js', '// 稍后删除\n');
  }

  {
    /* ⑤ rename */
    const pre = await worktreeTree(PROJ);
    fs.renameSync(path.join(PROJ, 'src/old.js'), path.join(PROJ, 'src/renamed.js'));
    const post = await worktreeTree(PROJ);
    const ns = await treeNumstat(PROJ, pre.tree, post.tree);
    const df = await treeDiff(PROJ, pre.tree, post.tree);
    const ev = evidence.buildChangeEvidence({ stats: ns.stats, diffText: df.text, meta: { capturedAt: 1, allowEmpty: true } });
    check('B11. rename：git 认得出时用 renamed + oldPath', () => {
      const f = ev.files.find((x) => x.path === 'src/renamed.js');
      return (f && f.change === 'renamed' && f.oldPath === 'src/old.js') || JSON.stringify(ev.files.map((x) => x.path + ':' + x.change));
    }, JSON.stringify(ev.files.map((x) => [x.path, x.change, x.oldPath])));
    check('B12. rename 不会变成「新旧两条」', () => !ev.files.some((x) => x.path === 'src/old.js') || JSON.stringify(ev.files.map((x) => x.path)));
    fs.renameSync(path.join(PROJ, 'src/renamed.js'), path.join(PROJ, 'src/old.js'));
  }

  {
    /* ⑥ binary：不保存内容 */
    const pre = await worktreeTree(PROJ);
    fs.writeFileSync(path.join(PROJ, 'bin.png'), Buffer.from([9, 9, 9, 9, 9, 9, 9, 9, 9]));
    const post = await worktreeTree(PROJ);
    const ns = await treeNumstat(PROJ, pre.tree, post.tree);
    const df = await treeDiff(PROJ, pre.tree, post.tree);
    const ev = evidence.buildChangeEvidence({ stats: ns.stats, diffText: df.text, meta: { capturedAt: 1, allowEmpty: true } });
    const f = ev.files.find((x) => x.path === 'bin.png');
    check('B13. binary：标了 binary，patch 不塞内容', () => (f && f.binary === true && !/\x00|base64|iVBOR/.test(f.patch)) || JSON.stringify(f && { b: f.binary, p: f.patch.slice(0, 40) }));
    /* 还原：后面的用例要靠「干净的工作区」当基线。 */
    fs.writeFileSync(path.join(PROJ, 'bin.png'), Buffer.from([0, 1, 2, 3, 0, 0, 9]));
    await git(['checkout', '--', 'bin.png']);
  }

  /* ================= C. 历史证据不随工作区漂移 ================= */
  section('C. 冻结：之后怎么改都不动（P10 的核心）');

  {
    /* ① blocker A：Attempt 之后继续改同一个文件 */
    w('src/a.js', 'const x = 1;\n');
    store.save(mkPlan({ id: 'e-freeze', taskId: 'w1' }));
    const a = await runPlan('e-freeze', 'w1');
    const before = JSON.stringify(a.changeEvidence);
    w('src/a.js', 'const x = 999;\n'); // 用户之后又改了
    check('C1. **之后继续改工作区：历史证据一个字节都没变**（旧实现会给当前 diff）', () => {
      return JSON.stringify(evOf('e-freeze', 1, 'w1')) === before || '历史证据变了';
    });
    check('C1b. 而它仍然说的是当时那次执行（1 → 3），不是现在的 1 → 999', () => {
      const f = evOf('e-freeze', 1, 'w1').files.find((x) => x.path === 'src/a.js');
      return (/\+const x = 3;/.test(f.patch) && !/999/.test(f.patch)) || f.patch;
    });
    w('src/a.js', 'const x = 1;\n');
  }

  {
    /* ② 工作区变回 clean：历史证据还在 */
    const before = JSON.stringify(evOf('e-freeze', 1, 'w1'));
    w('src/a.js', 'const x = 1;\n'); // 撤回成 HEAD 的样子（git status 会变 clean）
    check('C2. 工作区 clean 之后历史证据仍然在', () => JSON.stringify(evOf('e-freeze', 1, 'w1')) === before);
    const st = await git(['status', '--porcelain']);
    check('C2b. 前置条件：工作区此刻确实是 clean 的', () => st.out.trim() === '' || st.out.trim());
  }

  {
    /* ③ 工作区又产生新的 diff：历史证据还是不变 */
    const before = JSON.stringify(evOf('e-freeze', 1, 'w1'));
    w('src/other.js', '// 另一个文件的新改动\n');
    check('C3. 工作区又有新 diff 之后，旧 attempt 的证据仍不变', () => JSON.stringify(evOf('e-freeze', 1, 'w1')) === before);
    rm('src/other.js');
  }

  {
    /* ④ Retry：两次 attempt 的证据各自独立 */
    w('src/a.js', 'const x = 1;\n');
    store.save(mkPlan({ id: 'e-retry', taskId: 'w1' }));
    const a1 = await runPlan('e-retry', 'w1');
    const ev1 = JSON.stringify(a1.changeEvidence);
    /* 第二次执行：换个内容，让两次的 patch 明显不同 */
    registry.get('fake').setBehaviors({ ...BEHAVIORS, w1: [{ ok: true, summary: 'done', writes: [{ path: 'src/a.js', content: 'const x = 4;\n' }] }] });
    const p = load('e-retry');
    store.save(p);
    runtime.setCurrentCwd(PROJ);
    const rt = scheduler.retryTask(load('e-retry'), 'w1');
    check('C4-prep. Retry 被接受', () => rt.ok === true, JSON.stringify(rt));
    const s = await scheduler.start(load('e-retry'));
    check('C4-prep2. 第二次执行跑完', () => s.ok === true, JSON.stringify(s));
    await scheduler.waitIdle(30000);

    check('C5. Attempt 1 的证据没被重试动过', () => JSON.stringify(evOf('e-retry', 1, 'w1')) === ev1);
    check('C6. Attempt 2 有自己的证据，且与 Attempt 1 不同', () => {
      const e2 = JSON.stringify(evOf('e-retry', 2, 'w1'));
      return (e2 && e2 !== 'undefined' && e2 !== ev1) || `e2=${e2 && e2.slice(0, 60)}`;
    });
    check('C7. Attempt 2 的 patch 是 3 → 4（从上次结束的状态起算）', () => {
      const f = evOf('e-retry', 2, 'w1').files.find((x) => x.path === 'src/a.js');
      return (/-const x = 3;/.test(f.patch) && /\+const x = 4;/.test(f.patch)) || f.patch;
    });
    registry.get('fake').setBehaviors(BEHAVIORS);
    w('src/a.js', 'const x = 1;\n');
  }

  /* ================= D. 失败不改任务结论 / 老数据 ================= */
  section('D. 采不到证据 ≠ 任务失败');

  {
    /* 非 git 项目：证据 unavailable，但任务照常成功 */
    store.save(mkPlan({ id: 'e-nogit', taskId: 'w1', projectRoot: PLAIN }));
    runtime.setCurrentCwd(PLAIN);
    const r = await scheduler.start(store.load('e-nogit').plan);
    check('D1-prep. 计划启动', () => r.ok === true, JSON.stringify(r));
    await scheduler.waitIdle(30000);
    const a = attOf('e-nogit', 1, 'w1');
    check('D2. 非 git 项目：outcome 仍是 success（证据失败不影响任务）', () => a.success === true && a.outcomeStatus === 'success', JSON.stringify({ s: a.success, o: a.outcomeStatus }));
    check('D3. 证据如实标 unavailable + 说明原因', () => Boolean(a.changeEvidence.status === 'unavailable' && a.changeEvidence.note) || JSON.stringify(a.changeEvidence));
    runtime.setCurrentCwd(PROJ);
  }

  {
    /* 没注入 gitEvidence：同样只是采不到，任务照常 */
    const bare = createScheduler({ store, registry, runtime, gitStatus });
    store.save(mkPlan({ id: 'e-noinj', taskId: 'okOnly' }));
    runtime.setCurrentCwd(PROJ);
    const r = await bare.start(store.load('e-noinj').plan);
    check('D4-prep. 计划启动', () => r.ok === true, JSON.stringify(r));
    await bare.waitIdle(30000);
    const a = attOf('e-noinj', 1, 'okOnly');
    check('D5. 没接采集：unavailable + 原因，任务仍 success', () => (a.success === true && a.changeEvidence.status === 'unavailable') || JSON.stringify({ s: a.success, e: a.changeEvidence }));
  }

  {
    /* 任务失败时证据照常采集（失败也需要证据） */
    store.save(mkPlan({ id: 'e-fail', taskId: 'fail' }));
    const a = await runPlan('e-fail', 'fail');
    check('D6. 任务失败时也采集证据（它本来就有内容可采）', () => (a.outcomeStatus === 'failed' && a.changeEvidence && a.changeEvidence.status !== 'unavailable') || JSON.stringify({ o: a.outcomeStatus, e: a.changeEvidence && a.changeEvidence.status }));
  }

  {
    /* 中断：不伪造结束状态 */
    store.save(mkPlan({ id: 'e-int', taskId: 'w1' }));
    runtime.setCurrentCwd(PROJ);
    const r = await scheduler.start(store.load('e-int').plan);
    check('D7-prep. 计划启动', () => r.ok === true, JSON.stringify(r));
    scheduler.shutdown();
    await scheduler.waitIdle(30000);
    const a = attOf('e-int', 1, 'w1');
    check('D8. 中断：不伪造 post 快照，如实说没采到结束状态', () => (a.changeEvidence.status === 'unavailable' && /中断/.test(a.changeEvidence.note)) || JSON.stringify(a.changeEvidence));
  }

  {
    /* 硬崩恢复：同样不伪造 */
    const plan = mkPlan({ id: 'e-crash' });
    plan.status = 'running';
    plan.tasks[0].status = 'running';
    plan.tasks[0].attempt = 1;
    plan.tasks[0].startedAt = Date.now() - 5000;
    store.save(plan);
    store.recoverAll();
    const a = attOf('e-crash', 1);
    check('D9. 硬崩恢复：补的 attempt 里证据是 unavailable + 说明（不拿当前工作区补）', () => (a && a.changeEvidence && a.changeEvidence.status === 'unavailable' && /崩溃/.test(a.changeEvidence.note)) || JSON.stringify(a && a.changeEvidence));
  }

  {
    /* 老 attempt：没有这个字段 */
    const legacy = {
      schemaVersion: 1,
      id: 'e-old',
      title: '老计划',
      goal: '',
      status: 'completed',
      createdAt: 1,
      updatedAt: 1,
      projectRoot: PROJ,
      concurrency: 1,
      recoveryNotes: [],
      tasks: [{ id: 't1', title: '任务', agent: 'fake', workingDirectory: '.', dependsOn: [], status: 'success', attempt: 1, attempts: [{ attempt: 1, success: true, outcomeStatus: 'success', filesChanged: ['src/a.js'] }], result: null, error: '' }],
    };
    fs.writeFileSync(path.join(DATA, 'plans', 'e-old.json'), JSON.stringify(legacy, null, 2) + '\n', 'utf8');
    const p = load('e-old');
    check('D10. 老 attempt 没有 changeEvidence → 归一化成 null（不假装有 Diff）', () => p.tasks[0].attempts[0].changeEvidence === null || JSON.stringify(p.tasks[0].attempts[0].changeEvidence));
    check('D11. 老计划的 filesChanged 照常读得出来', () => JSON.stringify(p.tasks[0].attempts[0].filesChanged) === JSON.stringify(['src/a.js']));
    check('D12. schemaVersion 仍是 1（additive，不需要 migration）', () => PLAN_SCHEMA_VERSION === 1, String(PLAN_SCHEMA_VERSION));
  }

  /* ================= E. 写盘所有权 ================= */
  section('E. 四条写盘路径都不许覆盖证据');

  {
    /* Review 写入不覆盖证据 */
    const before = JSON.stringify(evOf('e-freeze', 1, 'w1'));
    const rv = await hit(planner, 'PUT', '/api/plans/e-freeze/tasks/w1/attempts/1/review', { status: 'accepted', note: 'ok', expectedRevision: 0 });
    check('E1-prep. 审阅写入成功', () => rv.body.ok === true, JSON.stringify(rv.body));
    check('E1. Review 写入之后证据没被覆盖', () => JSON.stringify(evOf('e-freeze', 1, 'w1')) === before);
    check('E1b. 审阅自己也写进去了', () => model.normalizeReview(attOf('e-freeze', 1, 'w1').review).status === 'accepted');
  }

  {
    /* PUT Plan 不覆盖证据（前端拿旧副本提交也不行） */
    const before = JSON.stringify(evOf('e-freeze', 1, 'w1'));
    const put = await hit(planner, 'PUT', '/api/plans/e-freeze', {
      title: '改个标题',
      tasks: [{ id: 'w1', title: '任务', agent: 'fake', dependsOn: [], verification: null }],
    });
    check('E2-prep. PUT 成功', () => put.body.ok === true, JSON.stringify(put.body.errors || put.body.error || put.body.ok));
    check('E2. PUT Plan（带一份**不含证据**的任务副本）之后证据仍在', () => JSON.stringify(evOf('e-freeze', 1, 'w1')) === before);
  }

  {
    /* Scheduler 整份写盘不丢证据：跑一个新计划时，旧 plan 的证据不动；
     * 同一个 plan 里再跑一次（Retry）也由 C 段覆盖了。这里验「同一 plan 的
     * 执行写盘不会把已有证据抹掉」。 */
    const before = JSON.stringify(evOf('e-retry', 1, 'w1'));
    const p = load('e-retry');
    p.tasks[0].status = 'pending';
    p.tasks[0].attempts = p.tasks[0].attempts.filter((x) => x.attempt === 1);
    store.save(p);
    const s = await scheduler.start(load('e-retry'));
    if (s.ok) await scheduler.waitIdle(30000);
    check('E3. 又一次执行/写盘之后，Attempt 1 的证据仍在', () => JSON.stringify(evOf('e-retry', 1, 'w1')) === before || '丢了');
    w('src/a.js', 'const x = 1;\n');
  }

  {
    /* ④ Verifier：§十七 四条写盘路径的最后一条。
     *
     * 真实的危险不是「验证开始时证据还没落盘」—— 那种陈旧副本也留得住证据。
     * 危险的是**验证跑着的那几秒里** Scheduler 把这一轮的证据落盘，然后 Verifier
     * 拿着**启动时那份陈旧副本**收尾写盘，把证据连同一整个 attempt 盖回去。
     * 所以这里刻意制造那个窗口：先起验证 → 期间往磁盘写证据 → 再放行收尾。
     *
     * ⚠️ 用**自己的计划**：G 段要拿 `e-freeze` 的证据做对照，动它会把 G1 弄红。 */
    const p = mkPlan({ id: 'e-verif', taskId: 'w1' });
    p.tasks[0].attempts = [{
      attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 1, endedAt: 2,
      sessionId: null, sessionAvailable: false, sessionTitle: '', filesChanged: [],
      changeCaptureIncomplete: false, outcomeStatus: 'success', changeEvidence: null,
      verificationSnapshot: { command: 'node -e 0' }, workingDirectorySnapshot: '.',
      review: { status: 'pending', note: '', reviewedAt: null, revision: 0 },
    }];
    store.save(p);

    let release;
    shellGate = new Promise((r) => (release = r));
    const r = verifier.start({ planId: 'e-verif', taskId: 'w1', attempt: 1 });
    check('E4-prep. 验证启动成功', () => r.ok === true, JSON.stringify(r));
    for (let i = 0; i < 200 && !verifier.isRunning('e-verif', 'w1', 1); i++) await sleep(10);
    check('E4-prep2. 验证此刻确实在跑（这个窗口是真的）', () => verifier.isRunning('e-verif', 'w1', 1) === true);

    /* —— 窗口里：Scheduler 把这一轮的冻结证据落盘 —— */
    const mid = load('e-verif');
    mid.tasks[0].attempts[0].changeEvidence = {
      status: 'available', capturedAt: 123, truncated: false, note: '',
      files: [{ path: 'src/a.js', change: 'modified', oldPath: null, binary: false, additions: 1, deletions: 1, patch: '-const x = 1;\n+const x = 2;\n', truncated: false }],
    };
    store.save(mid);
    const before = JSON.stringify(evOf('e-verif', 1, 'w1'));

    shellGate = null;
    release();
    for (let i = 0; i < 300; i++) {
      const v = attOf('e-verif', 1, 'w1').verificationResult;
      if (v && v.status !== 'running') break;
      await sleep(20);
    }
    check('E4-prep3. 验证结果确实写进去了（否则这条断言是空的）', () => {
      const v = attOf('e-verif', 1, 'w1').verificationResult;
      return (v && v.status === 'passed') || JSON.stringify(v);
    });
    check('E4. **验证跑着时落盘的证据，没被验证的收尾覆盖**', () => JSON.stringify(evOf('e-verif', 1, 'w1')) === before || '丢了');
  }

  /* ================= F. 体量与 XSS ================= */
  section('F. 上限、体量与不可信文本');

  {
    /* 40 个文件 + 每个几百字节：总量命中上限 */
    store.save(mkPlan({ id: 'e-big', taskId: 'wBig' }));
    const a = await runPlan('e-big', 'wBig');
    const ev = a.changeEvidence;
    check('F1. 大变更：文件数被限住', () => ev.files.length <= model.MAX_EVIDENCE_FILES, String(ev.files.length));
    check('F2. 大变更：总 patch 量被限住', () => ev.files.reduce((n, f) => n + f.patch.length, 0) <= model.MAX_EVIDENCE_TOTAL_PATCH, String(ev.files.reduce((n, f) => n + f.patch.length, 0)));
    check('F3. 截断被**明确标出来**（状态 + 标记 + 说明）', () => ev.truncated === true && ev.status === 'partial' && Boolean(ev.note) || JSON.stringify({ t: ev.truncated, s: ev.status, n: ev.note }));
    check('F4. 计划文件没有膨胀到失控（< 2 MB）', () => {
      const kb = fs.statSync(path.join(DATA, 'plans', 'e-big.json')).size / 1024;
      return kb < 2048 || `${Math.round(kb)} KB`;
    });
  }

  {
    /* XSS：内容原样保存，渲染那侧由前端负责（这里只保证没被 HTML 化/编码） */
    store.save(mkPlan({ id: 'e-xss', taskId: 'wXss' }));
    const a = await runPlan('e-xss', 'wXss');
    const f = a.changeEvidence.files.find((x) => x.path === 'src/xss.js');
    check('F5. XSS 载荷原样存进 patch（当文本，不做任何编码）', () => (f && f.patch.includes('<img src=x onerror=alert(1)>')) || JSON.stringify(f && f.patch.slice(0, 80)));
    check('F6. 证据里没有 HTML 实体转义（前端用 textContent 渲染，不需要编码）', () => !JSON.stringify(f).includes('&lt;') || '被转义了');
  }

  /* ================= G. 两条「旧实现」会红（§二十二 / §三十 要求） ================= */
  section('G. 防回归证明：两条错误实现都会被这两条断言打红');

  {
    /* A. 「读取时按当前工作区重算」的实现在结构上不存在 —— 证据只在 finishTask 里
     * 写一次、之后只从磁盘读。这里用**同一份断言**去量「重算」会给出什么：
     * 把工作区改成 999 之后，当前 Git diff 是 1→999，而持久化证据是 1→3。
     * 于是任何「拿当前 diff 当历史」的实现都会让 C1/C1b 变红。 */
    const persisted = evOf('e-freeze', 1, 'w1');
    const f = persisted.files.find((x) => x.path === 'src/a.js');
    w('src/a.js', 'const x = 999;\n');
    const nowDiff = (await git(['diff', 'HEAD', '--', 'src/a.js'])).out;
    check('G1. 「按当前工作区重算」会给出 1→999 —— 而 C1b 断言的是 1→3，两者不可能同时成立', () => {
      return /\+const x = 999;/.test(nowDiff) && /\+const x = 3;/.test(f.patch) && !/999/.test(f.patch) || `now=${nowDiff.slice(0, 60)}`;
    }, JSON.stringify({ nowDiff: nowDiff.slice(0, 80) }));
    w('src/a.js', 'const x = 1;\n');
  }

  {
    /* B. 「拿 HEAD 当基线」的实现：把 pre 树换成 **HEAD 的树**，其余一字不改。
     * 用同一套组装逻辑跑一遍，看 B6 的断言（必须是 2→3）会不会变假。 */
    w('src/a.js', 'const x = 2;\n'); // 执行前用户已经改过（HEAD 是 1）
    const head = (await git(['rev-parse', 'HEAD^{tree}'])).out.trim();
    const pre = await worktreeTree(PROJ); // 真正的 pre（含用户那处改动）
    w('src/a.js', 'const x = 3;\n'); // 执行期间
    const post = await worktreeTree(PROJ);
    const nsReal = await treeNumstat(PROJ, pre.tree, post.tree);
    const dfReal = await treeDiff(PROJ, pre.tree, post.tree);
    const realEv = evidence.buildChangeEvidence({ stats: nsReal.stats, diffText: dfReal.text, meta: { capturedAt: 1, allowEmpty: true } });
    const nsHead = await treeNumstat(PROJ, head, post.tree);
    const dfHead = await treeDiff(PROJ, head, post.tree);
    const headEv = evidence.buildChangeEvidence({ stats: nsHead.stats, diffText: dfHead.text, meta: { capturedAt: 1, allowEmpty: true } });

    const realPatch = realEv.files.find((x) => x.path === 'src/a.js').patch;
    const headPatch = headEv.files.find((x) => x.path === 'src/a.js').patch;
    check('G2. **正确实现**给 2→3（B6 的断言成立）', () => (/-const x = 2;/.test(realPatch) && /\+const x = 3;/.test(realPatch)) || realPatch);
    check('G3. **拿 HEAD 当基线的实现**给 1→3 —— B6 的断言在它上面**必红**', () => {
      return (/-const x = 1;/.test(headPatch) && /\+const x = 3;/.test(headPatch) && !/-const x = 2;/.test(headPatch)) || headPatch;
    }, headPatch);
    w('src/a.js', 'const x = 1;\n');
  }

  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n测试自身抛错：', err && err.stack ? err.stack : err);
  cleanup();
  process.exit(1);
});
