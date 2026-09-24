/* Git 状态与 Diff 后端。
 *
 * 职责边界（刻意划清）：
 *   本模块**只读**工作区，除了「撤销单个文件」这一个显式动作之外不改磁盘。
 *   不做 commit / push / pull / branch —— 那是后续版本的事。
 *
 * ---------- 安全约束（改动时不要破坏） ----------
 *
 * 1. **不开 shell。** 全部走 `spawn('git', [...args])` + `shell: false`，
 *    路径只经参数数组传递。任何形式的 `git diff ${path}` 字符串拼接都是禁止的 ——
 *    文件名里一个 `;` 或反引号就足以在用户的机器上执行任意命令。
 * 2. **cwd 永远锁在项目/仓库目录里**，路径经 lib/safe-path.js 校验后才使用，
 *    杜绝 `../` / 绝对路径 / 符号链接逃逸。
 * 3. **不继承能把 git 指到别处去的环境变量**（GIT_DIR / GIT_WORK_TREE / …）。
 * 4. **一定会结束**：每次调用都有 timeout，超时就杀进程树；stdout 有字节上限，
 *    超限同样中止。否则一个巨大的 diff 或一个卡住的 git 会把后端一起拖死。
 *
 * ---------- 实测得出的、与直觉相反的两件事 ----------
 *
 * a) `git status --porcelain -z` 里重命名的顺序是 `<新路径>\0<旧路径>\0`
 *    —— 与人类可读格式的 `旧 -> 新` **相反**。（实测于 git 2.4x / Git for Windows）
 *    而 `git diff --numstat -z` 的重命名顺序又是 `<旧>\0<新>\0`。两者不一致，
 *    所以 numstat 解析时把两个键都塞进表里，避免依赖顺序。
 * b) `git status` **没有** `--relative` 选项。所以当项目目录只是仓库的一个子目录时，
 *    git 返回的路径是相对**仓库根**的。这里统一在仓库根执行命令，再自己把路径
 *    换算成「相对项目根」—— API 对外只暴露项目相对路径。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isInside, realPathOrNull, resolveProjectPath } from './safe-path.js';

const IS_WIN = process.platform === 'win32';

/* 上限都可以用环境变量覆盖 —— 测试需要把它们调小才好在几秒内跑完。 */
const GIT_TIMEOUT_MS = Number(process.env.PI_GUI_GIT_TIMEOUT_MS || 10000);
const STATUS_MAX_BYTES = Number(process.env.PI_GUI_GIT_STATUS_MAX_BYTES || 4 * 1024 * 1024);
const DIFF_MAX_BYTES = Number(process.env.PI_GUI_GIT_DIFF_MAX_BYTES || 512 * 1024);
const STDERR_MAX_BYTES = 64 * 1024;

/* 未跟踪文件没有 numstat（它不在 index 里），要单独用 `--no-index` 逐个算行数。
 * 每次调用都要起一个 git 进程，所以设个上限：超过就降级成「—」，
 * 免得在一个满是未跟踪文件的仓库里把状态接口拖成几秒。 */
const UNTRACKED_STAT_MAX = Number(process.env.PI_GUI_GIT_UNTRACKED_MAX || 20);

/* ---------- 执行 git ---------- */

/** 给 git 准备一份干净的环境。
 *
 * GIT_DIR / GIT_WORK_TREE 这类变量能把 git 指到另一个仓库上去 ——
 * 那样「项目内路径校验」就形同虚设（校验的是项目，git 操作的是别处）。
 * 一律摘掉。 */
function gitEnv() {
  const env = { ...process.env };
  for (const k of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_NAMESPACE',
  ]) {
    delete env[k];
  }
  env.GIT_PAGER = 'cat'; // 不启动分页器
  env.GIT_TERMINAL_PROMPT = '0'; // 需要凭据时直接失败，别卡在那里等输入
  env.GIT_OPTIONAL_LOCKS = '0'; // 只读查询不去抢 index.lock
  return env;
}

/* `core.quotepath=false` 让非 ASCII 文件名按原样输出（否则中文会变成
 * `\344\270\255` 这样的八进制转义，diff 头部完全没法看）。 */
const gitArgs = (...rest) => ['-c', 'core.quotepath=false', ...rest];

/** 连同子孙进程一起杀掉。
 *  Windows 上 child.kill() 只结束直接子进程，而 git 可能拉起了 textconv /
 *  diff driver 之类的孙子进程 —— 只杀父进程会留下孤儿。 */
function killTree(child) {
  try {
    if (IS_WIN && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
  } catch {
    /* 已经没了就算了 */
  }
  try {
    child.kill();
  } catch {
    /* noop */
  }
}

/**
 * 跑一次 git。
 *
 * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string,
 *                    timedOut?:boolean, truncated?:boolean, noGit?:boolean, error?:string}>}
 *
 * 注意 `ok` 是「命令正常结束」的意思，不含业务判断 —— 例如 `git diff --no-index`
 * 在「有差异」时返回 1，那也算正常结束，所以用 okCodes 把 1 也放进来。
 */
function runGit(cwd, args, { timeout = GIT_TIMEOUT_MS, maxBytes = STATUS_MAX_BYTES, okCodes = [0] } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    let child;
    try {
      child = spawn('git', args, { cwd, shell: false, windowsHide: true, env: gitEnv() });
    } catch (err) {
      finish({ ok: false, code: -1, stdout: '', stderr: '', error: String(err.message), spawnFailed: true });
      return;
    }

    const chunks = [];
    let size = 0;
    let over = false;
    let timedOut = false;
    let errText = '';

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);

    child.stdout.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > maxBytes) {
        over = true; // 超限就停手并杀掉，不再继续缓冲
        killTree(child);
        return;
      }
      chunks.push(c);
    });
    child.stderr.on('data', (c) => {
      if (errText.length < STDERR_MAX_BYTES) errText += c.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const noGit = Boolean(err && err.code === 'ENOENT');
      finish({
        ok: false,
        code: -1,
        stdout: '',
        stderr: errText,
        noGit,
        spawnFailed: true,
        error: noGit ? '找不到 git 命令：请先安装 Git 并确保它在 PATH 里' : String(err.message),
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      finish({
        ok: okCodes.includes(code) && !timedOut && !over,
        code,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: errText.slice(0, 4096),
        timedOut,
        truncated: over,
        noGit: false,
      });
    });
  });
}

/* ---------- 仓库上下文 ---------- */

const toSlashes = (p) => String(p).replace(/\\/g, '/');

/** 项目根 → 仓库根。
 *
 * 项目目录可能只是仓库的一个子目录，也可能根本不是仓库。
 * 返回 { isRepo, root } / { isRepo:false, noGit:true, error }。 */
async function repoContext(projectRoot) {
  const r = await runGit(projectRoot, gitArgs('rev-parse', '--show-toplevel'), { timeout: 5000 });
  if (r.noGit) return { isRepo: false, noGit: true, error: r.error };
  if (r.timedOut) return { isRepo: false, error: 'git 命令超时' };
  if (!r.ok) return { isRepo: false }; // 非零退出 = 不是仓库（不用解析 stderr，避免受本地化影响）

  const raw = r.stdout.trim();
  if (!raw) return { isRepo: false };
  // git 给的是正斜杠路径，且可能是符号链接路径（例如 macOS 的 /tmp）——
  // 必须 realpath，否则后面和项目根比较时会因为路径形态不同而误判「在外面」
  return { isRepo: true, root: realPathOrNull(raw) || path.resolve(raw) };
}

/** 仓库根 + 绝对路径 → 仓库相对路径（正斜杠）。 */
const toRepoRel = (root, abs) => toSlashes(path.relative(root, abs));

/* ---------- status 解析 ---------- */

/**
 * 解析 `git status --porcelain=v1 -z` 的输出。
 *
 * 记录格式：`XY <路径>\0`；重命名/复制会紧跟一条旧路径：`XY <新>\0<旧>\0`。
 * 用 -z 而不是换行分隔，是因为只有 -z 才对「含空格 / 中文 / 换行」的文件名
 * 不做引号转义 —— 换成按行切分的话，一个带空格的路径就得自己做 C 字符串反转义。
 */
export function parseStatusZ(text) {
  const parts = String(text).split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 3) continue;
    const x = rec[0];
    const y = rec[1];
    let p = rec.slice(3);
    let oldPath = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      oldPath = parts[++i] || null; // 实测：紧跟的是**旧**路径
    }
    // -u normal 下未跟踪的目录会以 `dir/` 的形式出现（尾斜杠）
    const isDir = p.endsWith('/');
    if (isDir) p = p.slice(0, -1);
    out.push({ x, y, path: p, oldPath, isDir });
  }
  return out;
}

/** 把 XY 归一成一个展示用状态码。
 *
 * 冲突（U）必须单独识别：`UU`/`AA`/`DD` 如果被当成 M，用户会以为只是普通改动，
 * 直接去 restore 只会得到一个更乱的仓库。 */
export function statusCodeOf({ x, y }) {
  if (x === '?' || y === '?') return '??';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'U';
  if (x === 'R' || y === 'R') return 'R';
  if (x === 'C' || y === 'C') return 'C';
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'A') return 'A';
  return 'M';
}

/** 解析 `git diff --numstat -z`。
 *  重命名的记录形如 `add\tdel\t\0<旧>\0<新>\0` —— 两个路径都登记，避免依赖顺序。 */
export function parseNumstatZ(text) {
  const parts = String(text).split('\0');
  const map = new Map();
  const put = (p, add, del) => {
    if (!p) return;
    const cur = map.get(p);
    if (cur) {
      cur.add = cur.add === null || add === null ? null : cur.add + add;
      cur.del = cur.del === null || del === null ? null : cur.del + del;
    } else {
      map.set(p, { add, del });
    }
  };
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(rec);
    if (!m) continue;
    const add = m[1] === '-' ? null : Number(m[1]);
    const del = m[2] === '-' ? null : Number(m[2]);
    if (m[3] === '') {
      // 重命名：路径在后面的两条记录里
      put(parts[++i], add, del);
      put(parts[++i], add, del);
      continue;
    }
    put(m[3], add, del);
  }
  return map;
}

/** diff 文本里有没有「二进制文件」的提示。 */
const isBinaryDiff = (text) => /^Binary files .* differ$/m.test(String(text));

/* ---------- 对外 API ---------- */

/**
 * 工作区状态。
 *
 * @returns 非仓库时是 `{ ok:true, isRepo:false, files:[] }` —— **不是错误**。
 *          Pi GUI 允许打开普通文件夹，那种情况下 Agent 照常工作，只是没有 Git 信息。
 */
export async function gitStatus(projectRoot) {
  if (!projectRoot) return { ok: true, isRepo: false, files: [], noProject: true };

  const ctx = await repoContext(projectRoot);
  if (ctx.noGit) return { ok: false, noGit: true, isRepo: false, files: [], error: ctx.error };
  if (!ctx.isRepo) return { ok: true, isRepo: false, files: [] };

  const projectReal = realPathOrNull(projectRoot) || path.resolve(projectRoot);
  // 项目只是仓库的子目录时，用 pathspec 把 git 的扫描范围收窄到项目里 ——
  // 大仓库下这一步能把耗时从「整个仓库」降到「项目」。
  const sub = toRepoRel(ctx.root, projectReal);
  const limit = sub ? ['--', sub] : [];

  const st = await runGit(ctx.root, gitArgs('status', '--porcelain=v1', '-z', '--untracked-files=normal', ...limit));
  if (st.noGit) return { ok: false, noGit: true, isRepo: false, files: [], error: st.error };
  if (st.timedOut) return { ok: false, isRepo: true, root: ctx.root, files: [], error: 'git status 超时' };
  if (!st.ok && !st.truncated) {
    return { ok: false, isRepo: true, root: ctx.root, files: [], error: st.stderr.trim() || 'git status 执行失败' };
  }

  const entries = parseStatusZ(st.stdout);

  const [workNs, idxNs] = await Promise.all([
    runGit(ctx.root, gitArgs('diff', '--numstat', '-z', ...limit)),
    runGit(ctx.root, gitArgs('diff', '--cached', '--numstat', '-z', ...limit)),
  ]);

  // 工作区 + 暂存区的增删行数合并成一份（同一路径两处都有改动时相加）
  const stats = new Map();
  for (const ns of [workNs, idxNs]) {
    if (!ns.ok && !ns.truncated) continue;
    for (const [p, v] of parseNumstatZ(ns.stdout)) {
      const cur = stats.get(p);
      if (cur) {
        cur.add = cur.add === null || v.add === null ? null : cur.add + v.add;
        cur.del = cur.del === null || v.del === null ? null : cur.del + v.del;
      } else {
        stats.set(p, { add: v.add, del: v.del });
      }
    }
  }

  const files = [];
  for (const e of entries) {
    const abs = path.resolve(ctx.root, e.path);
    // 只保留项目内的（项目是仓库子目录时，pathspec 已经过滤过，这里是第二道保险）
    if (!isInside(projectReal, abs)) continue;

    const repoRel = toSlashes(e.path);
    const s = stats.get(repoRel) || null;
    const untracked = e.x === '?' && e.y === '?';
    const binary = Boolean(s) && s.add === null && s.del === null;

    files.push({
      _repoRel: repoRel,
      path: toSlashes(path.relative(projectReal, abs)),
      oldPath: e.oldPath ? toSlashes(e.oldPath) : null,
      status: statusCodeOf(e),
      index: e.x,
      worktree: e.y,
      staged: e.x !== ' ' && e.x !== '?',
      untracked,
      isDir: e.isDir,
      additions: untracked || !s ? null : s.add,
      deletions: untracked || !s ? null : s.del,
      binary,
    });
  }

  /* 未跟踪文件补行数。走 `git diff --no-index --numstat -- /dev/null <file>` ——
   * 实测输出是 `3\t0\tnul => un2.txt`，只要前两列。
   * 数量太多就整体跳过（见 UNTRACKED_STAT_MAX），保持状态接口的响应时间可控。 */
  const untrackedFiles = files.filter((f) => f.untracked && !f.isDir);
  if (untrackedFiles.length && untrackedFiles.length <= UNTRACKED_STAT_MAX) {
    await Promise.all(
      untrackedFiles.map(async (f) => {
        const u = await runGit(ctx.root, gitArgs('diff', '--no-index', '--numstat', '--', '/dev/null', f._repoRel), {
          okCodes: [0, 1],
          maxBytes: 64 * 1024,
          timeout: 5000,
        });
        const cols = (u.stdout.split('\n')[0] || '').split('\t');
        if (cols.length < 2) return;
        const isBinary = cols[0] === '-' && cols[1] === '-';
        f.binary = isBinary;
        f.additions = isBinary ? null : Number(cols[0]);
        f.deletions = isBinary ? null : Number(cols[1]);
      })
    );
  }

  // 路径排序：先按目录，再按文件名，读起来比 git 的字典序自然
  files.sort((a, b) => a.path.localeCompare(b.path, 'zh'));

  return {
    ok: true,
    isRepo: true,
    root: ctx.root,
    projectRoot: projectReal,
    // _repoRel 只是内部用的中转字段，不外泄
    files: files.map(({ _repoRel, ...rest }) => rest),
    truncated: Boolean(st.truncated),
  };
}

/**
 * 单个文件的 unified diff。
 *
 * 同时给出 working（工作区 vs 暂存区）与 staged（暂存区 vs HEAD）两份 ——
 * 「既有暂存改动又有工作区改动」时只给一份会让人看不明白到底在比什么。
 */
export async function gitDiff(projectRoot, relPath) {
  const guard = resolveProjectPath(projectRoot, relPath);
  if (!guard.ok) return { ok: false, code: guard.code, error: guard.error };

  const ctx = await repoContext(projectRoot);
  if (ctx.noGit) return { ok: false, noGit: true, isRepo: false, error: ctx.error };
  if (!ctx.isRepo) {
    return { ok: true, isRepo: false, path: relPath, working: '', staged: '', untracked: false, binary: false };
  }

  const repoRel = toRepoRel(ctx.root, guard.abs);
  const common = ['--no-color', '--no-ext-diff'];

  const [w, s] = await Promise.all([
    runGit(ctx.root, gitArgs('diff', ...common, '--', repoRel), { maxBytes: DIFF_MAX_BYTES }),
    runGit(ctx.root, gitArgs('diff', '--cached', ...common, '--', repoRel), { maxBytes: DIFF_MAX_BYTES }),
  ]);

  const failed = [w, s].find((r) => !r.ok && !r.truncated && !r.timedOut);
  if (failed) {
    return { ok: false, isRepo: true, path: relPath, error: failed.stderr.trim() || 'git diff 执行失败' };
  }
  if (w.timedOut || s.timedOut) {
    return { ok: false, isRepo: true, path: relPath, error: 'git diff 超时' };
  }

  let working = w.stdout;
  let staged = s.stdout;
  let untracked = false;
  let isDir = false;
  let notice = '';

  /* 重命名的坑（实测）：`git diff --cached -- <新路径>` 只给了重命名的一条腿 ——
   * git 看不到被删掉的旧路径，配不成对，于是把「重命名」报成「新文件」
   * （输出 `new file mode` + `--- /dev/null`）。列表里明明写着 R，点开却成了新增，
   * 很容易让人以为这是新建的文件。
   * 补救办法：把旧路径也放进 pathspec，两边都在，git 才配得成对。
   *
   * 只在「暂存侧看起来像新文件」时才多跑一次 status 去问旧路径 ——
   * 普通修改的路径上不多花一个 git 进程。 */
  if (/^new file mode /m.test(staged)) {
    const ns = await runGit(ctx.root, gitArgs('status', '--porcelain=v1', '-z', '--untracked-files=no'), {
      timeout: 5000,
    });
    const hit = ns.ok || ns.truncated ? parseStatusZ(ns.stdout).find((x) => toSlashes(x.path) === repoRel) : null;
    if (hit && hit.oldPath) {
      const s2 = await runGit(ctx.root, gitArgs('diff', '--cached', ...common, '--', toSlashes(hit.oldPath), repoRel), {
        maxBytes: DIFF_MAX_BYTES,
      });
      if (s2.ok || s2.truncated) {
        staged = s2.stdout;
        if (s2.truncated) s.truncated = true;
      }
    }
  }

  /* 两份都是空的，可能是「真的没有差异」，也可能是「这个文件还没被 Git 跟踪」。
   * 后者用 ls-files 认一下 —— 未跟踪文件对 `git diff` 是不可见的，
   * 但用户恰恰最需要看到新文件的内容。 */
  if (!working.trim() && !staged.trim()) {
    const tracked = await runGit(ctx.root, gitArgs('ls-files', '--error-unmatch', '--', repoRel), { timeout: 5000 });
    const notTracked = !tracked.ok && !tracked.timedOut && !tracked.truncated;
    if (notTracked) {
      let stat = null;
      try {
        stat = fs.statSync(guard.abs);
      } catch {
        /* 文件不在了 */
      }
      if (stat && stat.isDirectory()) {
        isDir = true;
        untracked = true;
        notice = '这是一个未被 Git 跟踪的目录，没有展开显示其中的文件。';
      } else if (stat) {
        /* 未跟踪文件用 `--no-index` 造一份「新文件」diff。
         * 它返回 1 表示「有差异」，属于正常结果，所以 okCodes 要带上 1。
         * /dev/null 在 Git for Windows 下同样可用（实测）。 */
        const u = await runGit(ctx.root, gitArgs('diff', ...common, '--no-index', '--', '/dev/null', repoRel), {
          maxBytes: DIFF_MAX_BYTES,
          okCodes: [0, 1],
        });
        if (u.ok || u.truncated) {
          working = u.stdout;
          untracked = true;
          if (u.truncated) w.truncated = true;
        }
      }
    }
  }

  const truncated = Boolean(w.truncated || s.truncated);
  const binary = isBinaryDiff(working) || isBinaryDiff(staged);

  return {
    ok: true,
    isRepo: true,
    path: toSlashes(path.relative(realPathOrNull(projectRoot) || projectRoot, guard.abs)),
    untracked,
    isDir,
    binary,
    working,
    staged,
    truncated,
    limit: DIFF_MAX_BYTES,
    notice,
  };
}

/* ---------- 撤销 ---------- */

/**
 * 撤销单个文件的改动。
 *
 * **只处理「暂存区没有被碰过」的文件**，理由：
 *   - 动了 index 就等于替用户改了他精心准备的提交内容，且无法用一条命令回退；
 *   - 需求明确要求「第一版不要静默修改 index」。
 * 所以带暂存成分（`M `/`MM`/`A `/`R `/冲突）一律拒绝，并说明原因。
 *
 * 具体动作：
 *   未跟踪（??）  → 删除该文件。**必须显式传 deleteUntracked**，否则拒绝。
 *   工作区 M/D    → `git restore -- <path>`（从 index 恢复，保留暂存区）
 *   重命名        → 拒绝（恢复一条腿会让另一条腿处于半吊子状态）
 */
export async function gitRestore(projectRoot, relPath, { deleteUntracked = false } = {}) {
  const guard = resolveProjectPath(projectRoot, relPath);
  if (!guard.ok) return { ok: false, code: guard.code, error: guard.error };

  const ctx = await repoContext(projectRoot);
  if (ctx.noGit) return { ok: false, noGit: true, error: ctx.error };
  if (!ctx.isRepo) return { ok: false, isRepo: false, error: '当前项目不是 Git 仓库' };

  const projectReal = realPathOrNull(projectRoot) || path.resolve(projectRoot);
  const rel = toSlashes(path.relative(projectReal, guard.abs));

  // 以服务端此刻的真实状态为准，不信客户端传来的状态 ——
  // 客户端的状态可能已经过期，按过期状态动手是最危险的。
  const st = await gitStatus(projectRoot);
  if (!st.ok) return { ok: false, error: st.error || '无法读取 Git 状态' };
  const entry = st.files.find((f) => f.path === rel);

  if (!entry) return { ok: false, error: '这个文件当前没有待撤销的改动' };
  if (entry.isDir) return { ok: false, error: '这是一个未跟踪的目录，请手动处理' };

  if (entry.untracked) {
    if (!deleteUntracked) {
      return { ok: false, needsConfirm: true, error: '这个文件尚未被 Git 跟踪。撤销将删除该文件。' };
    }
    try {
      fs.unlinkSync(guard.abs);
    } catch (err) {
      return { ok: false, error: `删除失败：${err.message}` };
    }
    return { ok: true, action: 'deleted-untracked', path: rel };
  }

  if (entry.status === 'U') {
    return { ok: false, error: '这个文件处于合并冲突状态，请用 git 手动解决' };
  }
  /* 重命名 / 复制放在「已暂存」之前判：重命名必然带暂存成分，两条都成立，
   * 但「重命名不在这里撤销」比「改动已进入暂存区」更贴近用户看到的事实。 */
  if (entry.status === 'R' || entry.status === 'C') {
    return {
      ok: false,
      error: '重命名 / 复制的改动不在这里撤销（只恢复一条腿会让文件处于半吊子状态），请用 git 手动处理。',
    };
  }
  if (entry.staged) {
    return {
      ok: false,
      error: '这个文件的改动已经进入暂存区。为避免擅自改动暂存内容，这里不处理；请用 git 自行决定。',
    };
  }

  const repoRel = toRepoRel(ctx.root, guard.abs);
  let r = await runGit(ctx.root, gitArgs('restore', '--', repoRel));
  // 老版本 git（< 2.23）没有 restore，退回等价的 checkout --
  if (!r.ok && !r.timedOut && /restore/i.test(r.stderr) && /(unknown|not a git command|usage)/i.test(r.stderr)) {
    r = await runGit(ctx.root, gitArgs('checkout', '--', repoRel));
  }
  if (r.timedOut) return { ok: false, error: 'git restore 超时' };
  if (!r.ok) return { ok: false, error: r.stderr.trim() || 'git restore 执行失败' };

  return { ok: true, action: entry.status === 'D' ? 'restored-deleted' : 'restored', path: rel };
}

/**
 * 把「打开文件」要用的绝对路径解析出来。
 *
 * **本模块不负责打开** —— 浏览器模式下后端没有「打开」的能力，
 * 桌面版则由 Electron 主进程调用系统默认程序。这里只做校验 + 给出绝对路径，
 * 于是「什么算项目内的文件」只有一处答案。
 */
export function resolveOpenTarget(projectRoot, relPath) {
  const guard = resolveProjectPath(projectRoot, relPath);
  if (!guard.ok) return { ok: false, code: guard.code, error: guard.error };
  let stat = null;
  try {
    stat = fs.statSync(guard.abs);
  } catch {
    /* 文件可能刚被删掉 */
  }
  if (!stat) return { ok: false, code: 'missing', error: '文件不存在' };
  if (stat.isDirectory()) return { ok: false, code: 'isdir', error: '这是一个目录' };
  return { ok: true, abs: guard.abs, rel: toSlashes(guard.rel) };
}
