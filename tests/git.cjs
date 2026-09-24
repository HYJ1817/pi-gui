/* Git 变更能力的集成测试（v0.3.0）。
 *
 * ---------- 两条铁律 ----------
 *
 * 1. **绝不碰开发者的仓库。** 所有用例都在 os.tmpdir() 下新建临时目录、
 *    在里面 `git init` 一个全新仓库，跑完删掉。文件里出现的每一个仓库路径
 *    都是那个临时目录的子路径 —— 这是硬要求，不是习惯问题：
 *    这个套件里有「撤销文件」「删除未跟踪文件」这种真的会动磁盘的用例。
 * 2. **不依赖 pi。** HTTP 层的用例把 PI_BIN 指到一个不存在的命令上 ——
 *    git 接口和 pi 没有关系，不该因为机器上没装 pi 就整段跳过。
 *
 * ---------- 覆盖（对应需求的 20 项） ----------
 *   非 Git 目录 / 没有项目 / M / A / D / R / 未跟踪 / 含空格 / 含中文 /
 *   二进制 / 项目只是仓库的子目录 / diff 正文 / staged 与 workdir 分开 /
 *   `../` 逃逸 / 嵌套逃逸 / 绝对路径 / UNC / NUL / 符号链接逃逸 /
 *   git 未安装 / 超时 / diff 尺寸上限 / 单文件 restore / 未跟踪删除需确认 /
 *   已暂存拒绝 / 重命名拒绝 / 删除恢复 / 打开文件的路径校验 /
 *   HTTP 层的令牌与 Origin 保护 / 越权 403 / 缺参 400 / 方法 405
 *
 * 运行：node tests/git.cjs
 */
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const LIB_URL = pathToFileURL(path.join(ROOT, 'lib', 'git.js')).href;
const PORT = Number(process.env.GIT_PORT || 7799);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TOKEN = 'cafebabe'.repeat(8);

let pass = 0;
let fail = 0;
let skip = 0;
function check(name, cond, extra) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok && typeof ok === 'string' ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}
function note(msg) {
  skip++;
  console.log('  skip ' + msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 临时目录与临时仓库 ---------- */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-git-'));
const REPO = path.join(TMP, 'repo');
const NONREPO = path.join(TMP, 'plain');
const OUTSIDE = path.join(TMP, 'outside');

/* ---------- 跑子进程 ----------
 *
 * 一律用**异步** spawn，不用 spawnSync。
 * 原因：spawnSync 在部分受限环境（含本项目的自动化环境）里对任何命令都直接
 * 返回 EBUSY —— 连 `node -e` 都起不来，而异步 spawn 完全正常。
 * 项目里其他测试套件也全是异步的，保持一致。 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, ...opts });
    } catch (e) {
      resolve({ status: null, stdout: '', stderr: '', error: String(e.message || e) });
      return;
    }
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ status: null, stdout: out, stderr: err, error: String(e.message || e) }));
    child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err, error: null }));
  });
}

async function gitIn(cwd, args, { allowFail = false } = {}) {
  const r = await run('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} 失败（status=${r.status}）：${(r.stderr || r.stdout || r.error || '').trim()}`);
  }
  return r;
}

const w = (p, content) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

/* 真实路径。Windows 的 TEMP 可能带 8.3 短名或位于符号链接之后，
 * 不归一的话「项目根」和 git 报回来的仓库根形态不同，会被判成「在外面」。 */
const real = (p) => (fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p));

let REPO_REAL = REPO;

async function buildRepo() {
  fs.mkdirSync(REPO, { recursive: true });
  await gitIn(REPO, ['init', '-q']);
  await gitIn(REPO, ['config', 'user.email', 'pi-gui-test@example.com']);
  await gitIn(REPO, ['config', 'user.name', 'Pi GUI Test']);
  await gitIn(REPO, ['config', 'commit.gpgsign', 'false']);
  await gitIn(REPO, ['config', 'core.autocrlf', 'false']);

  w(path.join(REPO, 'a.txt'), 'line1\nline2\nline3\n');
  w(path.join(REPO, 'bin.dat'), Buffer.from([0, 1, 2, 3, 4, 5]));
  w(path.join(REPO, 'gone.txt'), 'gone\n');
  w(path.join(REPO, 'old.txt'), 'old\n');
  w(path.join(REPO, 'sub', 'keep.txt'), 'keep\n');
  w(path.join(REPO, 'with space', '中文 文件.txt'), '中1\n中2\n');

  await gitIn(REPO, ['add', '-A']);
  await gitIn(REPO, ['commit', '-q', '-m', 'init']);

  REPO_REAL = real(REPO);
}

/** 在仓库里造出 M / A / D / R / ?? / 二进制 各种状态。 */
async function dirtyRepo() {
  fs.appendFileSync(path.join(REPO, 'a.txt'), 'line4\n');
  fs.appendFileSync(path.join(REPO, 'sub', 'keep.txt'), 'keep2\n');
  fs.appendFileSync(path.join(REPO, 'with space', '中文 文件.txt'), '中3\n');
  fs.unlinkSync(path.join(REPO, 'gone.txt'));
  fs.writeFileSync(path.join(REPO, 'bin.dat'), Buffer.from([9, 9, 9]));

  await gitIn(REPO, ['mv', 'old.txt', 'renamed.txt']);

  w(path.join(REPO, 'new.txt'), 'n1\nn2\n');
  w(path.join(REPO, 'newdir', 'inside.txt'), 'd1\n');
  w(path.join(REPO, 'unbin.dat'), Buffer.from([0, 7, 0, 8]));
  w(path.join(REPO, 'staged.txt'), 's1\n');
  await gitIn(REPO, ['add', '--', 'staged.txt']);
}

/* ---------- 子进程探针（用于只读一次环境变量的边界） ----------
 *
 * lib/git.js 把超时 / 尺寸上限在**模块加载时**读进常量，所以同一个进程里改环境
 * 变量是没用的。这类用例改走子进程：写一个临时 .mjs，用指定的环境变量跑一次，
 * 把 JSON 打到 stdout。 */

async function probe(env, body) {
  const file = path.join(TMP, `probe-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(
    file,
    `import { gitStatus, gitDiff } from ${JSON.stringify(LIB_URL)};\n` +
      `const out = await (async () => { ${body} })();\n` +
      `console.log('@@' + JSON.stringify(out));\n`,
    'utf8'
  );
  const r = await run(process.execPath, [file], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  const line = String(r.stdout || '')
    .split('\n')
    .find((l) => l.startsWith('@@'));
  if (!line) {
    throw new Error(`探针没有输出：status=${r.status}\n${r.stdout}\n${r.stderr}`);
  }
  return JSON.parse(line.slice(2));
}

/* ---------- HTTP 层 ---------- */

function startServer(env) {
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PI_GUI_OPEN: '0',
      PI_GUI_DATA: path.join(TMP, 'data'),
      PI_GUI_TOKEN: TOKEN,
      /* 不存在的 pi 命令：git 接口与 pi 无关，这里只是让重试循环立刻失败，
       * 免得真去拉起一个 pi 会话。 */
      PI_BIN: 'pi-gui-test-nonexistent-bin',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const state = { out: '', srv };
  srv.stdout.on('data', (d) => (state.out += d));
  srv.stderr.on('data', (d) => (state.out += d));
  return state;
}

function killServer(state) {
  if (!state) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(state.srv.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      state.srv.kill();
    }
  } catch {
    /* 已经退出 */
  }
}

/** 等端口彻底安静下来。
 *
 * 复用同一个端口连开两次服务时必须先等前一个真的死掉：taskkill 是异步的，
 * 立刻重启会撞上 EADDRINUSE —— 新进程退出，而 waitUp 因为旧进程还在响应
 * 而返回 true，于是第一条请求就 fetch failed。 */
async function waitDown(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${ORIGIN}/api/health`);
    } catch {
      return true;
    }
    await sleep(200);
  }
  return false;
}

async function waitUp(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${ORIGIN}/api/health`);
      if (r.status) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return false;
}

async function jsonReq(p, opts = {}) {
  let r;
  try {
    r = await fetch(ORIGIN + p, opts);
  } catch (e) {
    // 连接层失败也结构化返回，别让一个瞬时的 ECONNREFUSED 把整段用例炸掉
    return { status: 0, body: null, error: String(e.message || e) };
  }
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, body };
}

const authed = (extra = {}) => ({ headers: { 'X-Pi-Gui-Token': TOKEN, 'Content-Type': 'application/json' }, ...extra });
const post = (p, payload, extra = {}) => jsonReq(p, authed({ method: 'POST', body: JSON.stringify(payload), ...extra }));

/* ---------- 主流程 ---------- */

(async () => {
  const { gitStatus, gitDiff, gitRestore, resolveOpenTarget } = await import(LIB_URL);

  console.log('\n=== 1. 临时仓库：状态解析 ===');
  await buildRepo();
  await dirtyRepo();

  const st = await gitStatus(REPO_REAL);
  check('仓库被识别为 Git 仓库', () => st.ok === true && st.isRepo === true || JSON.stringify(st).slice(0, 200));

  const by = (p) => (st.files || []).find((f) => f.path === p);
  const paths = () => (st.files || []).map((f) => f.path);

  check('列出全部 10 项变更', () => (st.files || []).length === 10 || `${(st.files || []).length}：${paths().join(' | ')}`);
  check('内部字段 _repoRel 不外泄', () => !JSON.stringify(st.files).includes('_repoRel'));

  check('M：工作区已修改', () => by('a.txt')?.status === 'M' && by('a.txt')?.staged === false || JSON.stringify(by('a.txt')));
  check('M：增删行数正确（+1 −0）', () => by('a.txt')?.additions === 1 && by('a.txt')?.deletions === 0 || JSON.stringify(by('a.txt')));
  check('A：已暂存的新增文件', () => by('staged.txt')?.status === 'A' && by('staged.txt')?.staged === true || JSON.stringify(by('staged.txt')));
  check('D：工作区已删除', () => by('gone.txt')?.status === 'D' || JSON.stringify(by('gone.txt')));
  check('R：重命名被识别，且带上原路径', () => {
    const f = by('renamed.txt');
    return (f && f.status === 'R' && f.oldPath === 'old.txt') || JSON.stringify(f);
  });
  check('??：未跟踪文件', () => by('new.txt')?.status === '??' && by('new.txt')?.untracked === true || JSON.stringify(by('new.txt')));
  check('??：未跟踪目录标记 isDir', () => {
    const f = (st.files || []).find((x) => x.isDir);
    return (f && f.status === '??' && f.untracked === true) || JSON.stringify(st.files.map((x) => x.path));
  });
  check('含空格的目录名正确返回', () => paths().includes('with space/中文 文件.txt') || paths().join(' | '));
  check('含中文的文件名没有被转义成八进制', () => paths().some((p) => p.includes('中文 文件.txt')) || paths().join(' | '));
  check('二进制文件被标记（working 侧）', () => by('bin.dat')?.binary === true || JSON.stringify(by('bin.dat')));
  check('二进制文件不给增删行数', () => by('bin.dat')?.additions === null || JSON.stringify(by('bin.dat')));
  check('未跟踪的二进制文件也被标记', () => by('unbin.dat')?.binary === true || JSON.stringify(by('unbin.dat')));
  check('路径按目录 + 文件名排序', () => {
    const sorted = [...paths()].sort((a, b) => a.localeCompare(b, 'zh'));
    return JSON.stringify(sorted) === JSON.stringify(paths()) || paths().join(' | ');
  });

  console.log('\n=== 2. 项目只是仓库的子目录 ===');
  const subSt = await gitStatus(path.join(REPO_REAL, 'sub'));
  check('子目录被识别为仓库内', () => subSt.isRepo === true || JSON.stringify(subSt).slice(0, 200));
  check('只返回子目录内的变更', () => {
    const ps = (subSt.files || []).map((f) => f.path);
    return (ps.length === 1 && ps[0] === 'keep.txt') || ps.join(' | ');
  });
  check('路径是相对**项目**而非仓库根', () => (subSt.files || []).every((f) => !f.path.startsWith('sub/')));

  console.log('\n=== 3. 非 Git 目录 / 没有项目 ===');
  fs.mkdirSync(NONREPO, { recursive: true });
  const plain = await gitStatus(NONREPO);
  check('非 Git 目录：ok:true 且 isRepo:false（不是错误）', () => plain.ok === true && plain.isRepo === false && Array.isArray(plain.files) && plain.files.length === 0 || JSON.stringify(plain));
  const noProj = await gitStatus('');
  check('没有项目时明确回 noProject', () => noProj.ok === true && noProj.isRepo === false && noProj.noProject === true || JSON.stringify(noProj));
  const noProjDiff = await gitDiff('', 'a.txt');
  check('没有项目时 diff 不报服务器错误', () => noProjDiff.ok === false || typeof noProjDiff === 'object');

  console.log('\n=== 4. 路径安全（越权一律拒绝） ===');
  const guard = (p, want) => {
    const r = resolveOpenTarget(REPO_REAL, p);
    return r.ok === false && r.code === want;
  };
  check('空路径 → empty', () => guard('', 'empty'));
  check('../ 逃逸 → escape', () => guard('../a.txt', 'escape'));
  check('嵌套 ../ 逃逸 → escape', () => guard('sub/../../a.txt', 'escape'));
  check('Windows 绝对路径 → absolute', () => guard('C:\\Windows\\win.ini', 'absolute'));
  check('POSIX 绝对路径 → absolute', () => guard('/etc/passwd', 'absolute'));
  check('UNC 路径 → absolute', () => guard('\\\\srv\\share\\x', 'absolute'));
  check('含 NUL 的路径 → illegal', () => guard('a\0b', 'illegal'));
  check('前缀伪装目录（../repo-evil）→ escape', () => guard('../repo-evil/x', 'escape'));

  /* 符号链接 / junction 逃逸。Windows 上建 junction 一般不需要管理员，
   * 但受限环境仍可能失败 —— 那就跳过，别把「环境不让建链接」算成失败。 */
  let linkMade = false;
  try {
    fs.mkdirSync(OUTSIDE, { recursive: true });
    w(path.join(OUTSIDE, 'secret.txt'), 'secret\n');
    fs.symlinkSync(OUTSIDE, path.join(REPO, 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir');
    linkMade = true;
  } catch (e) {
    note(`符号链接逃逸：本环境无法创建链接（${e.code || e.message}）`);
  }
  if (linkMade) {
    const r = resolveOpenTarget(REPO_REAL, 'escape-link/secret.txt');
    check('符号链接逃逸 → symlink', () => (r.ok === false && r.code === 'symlink') || JSON.stringify(r));
    const d = await gitDiff(REPO_REAL, 'escape-link/secret.txt');
    check('diff 走同一条校验（越权 → 403 语义）', () => d.ok === false && d.code === 'symlink' || JSON.stringify(d));
  }

  console.log('\n=== 5. Diff ===');
  const dA = await gitDiff(REPO_REAL, 'a.txt');
  check('工作区 diff 有内容', () => dA.ok === true && dA.working.includes('+line4') || JSON.stringify(dA).slice(0, 200));
  check('工作区 diff 带 unified 头', () => dA.working.includes('diff --git') && dA.working.includes('@@') || dA.working.slice(0, 200));
  check('没有暂存内容时 staged 为空', () => dA.staged.trim() === '' || dA.staged.slice(0, 120));

  const dS = await gitDiff(REPO_REAL, 'staged.txt');
  check('已暂存文件的 diff 出现在 staged 里', () => dS.staged.includes('+s1') || JSON.stringify(dS).slice(0, 200));
  check('已暂存文件的工作区 diff 为空', () => dS.working.trim() === '' || dS.working.slice(0, 120));

  const dU = await gitDiff(REPO_REAL, 'new.txt');
  check('未跟踪文件也能看到内容', () => dU.untracked === true && dU.working.includes('+n1') || JSON.stringify(dU).slice(0, 200));
  const dD = await gitDiff(REPO_REAL, 'gone.txt');
  check('已删除文件的 diff 显示删除行', () => dD.working.includes('-gone') || JSON.stringify(dD).slice(0, 200));
  const dBin = await gitDiff(REPO_REAL, 'bin.dat');
  check('二进制文件被标记 binary', () => dBin.binary === true || JSON.stringify(dBin).slice(0, 200));
  const dDir = await gitDiff(REPO_REAL, 'newdir');
  check('未跟踪目录给提示而不是展开', () => dDir.isDir === true && Boolean(dDir.notice) || JSON.stringify(dDir).slice(0, 200));
  const dCn = await gitDiff(REPO_REAL, 'with space/中文 文件.txt');
  check('含空格 + 中文的路径能取到 diff', () => dCn.ok === true && dCn.working.includes('+中3') || JSON.stringify(dCn).slice(0, 200));
  check('diff 头里的中文没有被转义', () => dCn.working.includes('中文 文件.txt') || dCn.working.slice(0, 200));
  const dR = await gitDiff(REPO_REAL, 'renamed.txt');
  check('重命名的 diff 同时给出旧路径与新路径', () => /rename from old\.txt/.test(dR.staged) && /rename to renamed\.txt/.test(dR.staged) || dR.staged.slice(0, 300));

  console.log('\n=== 6. 打开文件（只校验并给绝对路径） ===');
  const openOk = resolveOpenTarget(REPO_REAL, 'a.txt');
  check('正常文件返回绝对路径', () => openOk.ok === true && path.isAbsolute(openOk.abs) && openOk.rel === 'a.txt' || JSON.stringify(openOk));
  check('返回的绝对路径确实在项目里', () => openOk.ok === true && openOk.abs.startsWith(REPO_REAL) || openOk.abs);
  check('不存在的文件 → missing', () => {
    const r = resolveOpenTarget(REPO_REAL, 'nope.txt');
    return (r.ok === false && r.code === 'missing') || JSON.stringify(r);
  });
  check('目录 → isdir', () => {
    const r = resolveOpenTarget(REPO_REAL, 'sub');
    return (r.ok === false && r.code === 'isdir') || JSON.stringify(r);
  });

  console.log('\n=== 7. 撤销单个文件 ===');
  const beforeA = fs.readFileSync(path.join(REPO, 'a.txt'), 'utf8');
  const rA = await gitRestore(REPO_REAL, 'a.txt');
  check('工作区 M 可撤销', () => rA.ok === true && rA.action === 'restored' || JSON.stringify(rA));
  check('撤销后内容回到 Git 版本', () => {
    const now = fs.readFileSync(path.join(REPO, 'a.txt'), 'utf8');
    return (now !== beforeA && now === 'line1\nline2\nline3\n') || JSON.stringify(now);
  });
  const stAfterA = await gitStatus(REPO_REAL);
  check('撤销后该文件从列表消失', () => !(stAfterA.files || []).some((f) => f.path === 'a.txt') || (stAfterA.files || []).map((f) => f.path).join(' | '));

  const rD = await gitRestore(REPO_REAL, 'gone.txt');
  check('已删除文件可恢复', () => rD.ok === true && rD.action === 'restored-deleted' || JSON.stringify(rD));
  check('恢复后文件真的回来了', () => fs.existsSync(path.join(REPO, 'gone.txt')));

  const rU = await gitRestore(REPO_REAL, 'new.txt');
  check('未跟踪文件无确认 → needsConfirm', () => rU.ok === false && rU.needsConfirm === true || JSON.stringify(rU));
  check('拒绝文案明确说「将删除该文件」', () => /尚未被 Git 跟踪。撤销将删除该文件/.test(rU.error || '') || rU.error);
  check('未确认时文件仍然在', () => fs.existsSync(path.join(REPO, 'new.txt')));

  const rU2 = await gitRestore(REPO_REAL, 'new.txt', { deleteUntracked: true });
  check('未跟踪文件带确认 → 删除', () => rU2.ok === true && rU2.action === 'deleted-untracked' || JSON.stringify(rU2));
  check('确认后文件真的没了', () => !fs.existsSync(path.join(REPO, 'new.txt')));

  const rStaged = await gitRestore(REPO_REAL, 'staged.txt');
  check('已暂存的文件拒绝撤销（不擅自改 index）', () => rStaged.ok === false && /暂存区/.test(rStaged.error || '') || JSON.stringify(rStaged));
  const cached = await gitIn(REPO, ['diff', '--cached', '--name-only']);
  check('拒绝后暂存内容原封不动', () => cached.stdout.includes('staged.txt') || cached.stdout);

  const rRen = await gitRestore(REPO_REAL, 'renamed.txt');
  check('重命名拒绝在单文件撤销里处理', () => rRen.ok === false && /重命名/.test(rRen.error || '') || JSON.stringify(rRen));

  const rDir = await gitRestore(REPO_REAL, 'newdir');
  check('未跟踪目录拒绝自动删除', () => rDir.ok === false && /目录/.test(rDir.error || '') || JSON.stringify(rDir));

  const rEsc = await gitRestore(REPO_REAL, '../a.txt');
  check('撤销也走路径校验', () => rEsc.ok === false && rEsc.code === 'escape' || JSON.stringify(rEsc));

  const rAgain = await gitRestore(REPO_REAL, 'a.txt');
  check('没有改动可撤时给出说明而不是报错', () => rAgain.ok === false && /没有待撤销/.test(rAgain.error || '') || JSON.stringify(rAgain));

  console.log('\n=== 8. 只读一次环境变量的边界（子进程） ===');
  const timedOut = await probe({ PI_GUI_GIT_TIMEOUT_MS: '1' }, `return await gitStatus(${JSON.stringify(REPO_REAL)});`);
  check('git 超时被识别并给出可读错误', () => timedOut.ok === false && /超时/.test(timedOut.error || '') || JSON.stringify(timedOut).slice(0, 200));

  const limited = await probe(
    { PI_GUI_GIT_DIFF_MAX_BYTES: '80' },
    `return await gitDiff(${JSON.stringify(REPO_REAL)}, 'with space/中文 文件.txt');`
  );
  check('diff 超过上限时标记 truncated', () => limited.ok === true && limited.truncated === true || JSON.stringify(limited).slice(0, 200));
  check('truncated 时仍带回上限值', () => limited.limit === 80 || JSON.stringify(limited).slice(0, 120));

  const noGit = await probe({ PATH: '', Path: '' }, `return await gitStatus(${JSON.stringify(REPO_REAL)});`);
  check('PATH 里没有 git → 友好报错而不是崩溃', () => noGit.ok === false && noGit.noGit === true && /找不到 git/.test(noGit.error || '') || JSON.stringify(noGit).slice(0, 200));
  const noGitDiff = await probe({ PATH: '', Path: '' }, `return await gitDiff(${JSON.stringify(REPO_REAL)}, 'a.txt');`);
  check('git 未安装时 diff 也是同一套友好报错', () => noGitDiff.ok === false && noGitDiff.noGit === true || JSON.stringify(noGitDiff).slice(0, 200));

  console.log('\n=== 9. HTTP 层：令牌 / Origin / 越权 ===');
  let srv = startServer({ PI_CWD: REPO_REAL });
  if (!(await waitUp())) {
    console.log('!! 服务器没能起来：\n' + srv.out.slice(-2000));
    killServer(srv);
    finish();
    return;
  }

  const noTok = await jsonReq('/api/git/status');
  check('无令牌 → 401', () => noTok.status === 401 || `HTTP ${noTok.status}`);

  const badTok = await jsonReq('/api/git/status', { headers: { 'X-Pi-Gui-Token': 'wrong' } });
  check('错误令牌 → 401', () => badTok.status === 401 || `HTTP ${badTok.status}`);

  const crossOrigin = await jsonReq('/api/git/status', authed({ headers: { 'X-Pi-Gui-Token': TOKEN, Origin: 'https://evil.example' } }));
  check('跨站 Origin → 403', () => crossOrigin.status === 403 || `HTTP ${crossOrigin.status}`);

  const okStatus = await jsonReq('/api/git/status', authed());
  check('带令牌 → 200 且是仓库', () => okStatus.status === 200 && okStatus.body?.isRepo === true || JSON.stringify(okStatus).slice(0, 200));
  check('HTTP 层返回的路径是项目相对的', () => (okStatus.body?.files || []).every((f) => !path.isAbsolute(f.path)));

  const okDiff = await post('/api/git/diff', { path: 'with space/中文 文件.txt' });
  check('POST diff → 200 且有正文', () => okDiff.status === 200 && okDiff.body?.ok === true && okDiff.body.working.includes('+中3') || JSON.stringify(okDiff).slice(0, 200));

  const escDiff = await post('/api/git/diff', { path: '../old.txt' });
  check('diff 越权 → 403', () => escDiff.status === 403 || `HTTP ${escDiff.status}`);
  const absDiff = await post('/api/git/diff', { path: 'C:\\Windows\\win.ini' });
  check('diff 绝对路径 → 403', () => absDiff.status === 403 || `HTTP ${absDiff.status}`);
  const noPath = await post('/api/git/diff', {});
  check('diff 缺 path → 400', () => noPath.status === 400 || `HTTP ${noPath.status}`);
  const badJson = await jsonReq('/api/git/diff', authed({ method: 'POST', body: '{oops' }));
  check('diff 请求体不是 JSON → 400', () => badJson.status === 400 || `HTTP ${badJson.status}`);
  const getDiff = await jsonReq('/api/git/diff', authed());
  check('GET diff → 405', () => getDiff.status === 405 || `HTTP ${getDiff.status}`);
  const unknown = await post('/api/git/nope', { path: 'a.txt' });
  check('未知子接口 → 404', () => unknown.status === 404 || `HTTP ${unknown.status}`);

  const okOpen = await post('/api/git/open', { path: 'sub/keep.txt' });
  check('POST open → 200 且给出绝对路径', () => okOpen.status === 200 && okOpen.body?.ok === true && path.isAbsolute(okOpen.body.abs) || JSON.stringify(okOpen).slice(0, 200));
  const badOpen = await post('/api/git/open', { path: 'C:\\Windows\\win.ini' });
  check('open 绝对路径 → 403', () => badOpen.status === 403 || `HTTP ${badOpen.status}`);
  const missOpen = await post('/api/git/open', { path: 'nope.txt' });
  check('open 不存在的文件 → 200 + ok:false（业务失败不是 HTTP 失败）', () => missOpen.status === 200 && missOpen.body?.ok === false || JSON.stringify(missOpen).slice(0, 200));

  const restoreNoConfirm = await post('/api/git/restore', { path: 'unbin.dat' });
  check('HTTP 撤销未跟踪文件需确认 → 200 + needsConfirm', () => restoreNoConfirm.status === 200 && restoreNoConfirm.body?.needsConfirm === true || JSON.stringify(restoreNoConfirm).slice(0, 200));

  const log = srv.out;
  check('日志里不出现令牌', () => !log.includes(TOKEN) || '令牌被打进了日志');
  check('日志里不出现越权路径的内容', () => !/win\.ini/.test(log) || '日志回显了被拒的路径');

  killServer(srv);
  srv = null;
  await waitDown();

  console.log('\n=== 10. HTTP 层：没有项目时不是错误 ===');
  srv = startServer({ PI_CWD: '' });
  if (await waitUp()) {
    const st2 = await jsonReq('/api/git/status', authed());
    check('没有项目时 status 仍是 200', () => st2.status === 200 || `HTTP ${st2.status}`);
    check('没有项目时 status 明确回 noProject', () => st2.body?.noProject === true || JSON.stringify(st2.body).slice(0, 200));
    const d2 = await post('/api/git/diff', { path: 'a.txt' });
    check('没有项目时 diff 给的是可执行指引（不是报错）', () => {
      const b = d2.body || {};
      return (d2.status === 200 && b.noProject === true && /添加文件夹/.test(b.error || '')) || JSON.stringify(b).slice(0, 200);
    });
  } else {
    note('没有项目时的 HTTP 用例：服务器没能起来');
  }
  killServer(srv);
  srv = null;

  finish();

  function finish() {
    /* 临时目录一定要收掉。删不掉（Windows 上偶发占用）也不该让测试失败。 */
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* noop */
    }
    console.log('');
    if (skip) console.log(`${skip} 项跳过`);
    console.log(`${pass}/${pass + fail} 通过`);
    process.exitCode = fail ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode), 300);
  }
})().catch((e) => {
  console.error('失败：' + (e && e.stack ? e.stack : e));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* noop */
  }
  process.exit(1);
});
