/* Agent 进程执行层 —— 所有外部 CLI 都从这里出去，别处不许再写 spawn。
 *
 * 三条硬规则（规格 §12 / §13 / §37）：
 *
 *   1. **`shell:false` + args 数组。** 永远不拼命令字符串。拼字符串意味着用户写
 *      的任务描述会被 shell 再解释一次 —— 那是最典型的一条命令注入路径。
 *      `rpc-bridge.js` 为了避开 DEP0190 走了「自己拼串 + shell:true」，那是历史
 *      包袱；新增的执行路径不继承它。
 *
 *   2. **不用 npm 的 `.cmd` shim。** Windows 上 npm 装出来的是 `pi.cmd` / `codex.cmd`
 *      这类批处理，它们**不能独立执行**（`spawn` 会 ENOENT 或 EINVAL），而经
 *      `cmd.exe` 转发又会退回规则 1。正确做法是解析出包里真正的入口：
 *      - 入口是 `.js` → `spawn(process.execPath, [入口, ...args])`
 *      - 入口是 `.exe` → 直接 `spawn(入口, args)`
 *      实测（本机）：pi = `dist/bundle/cli.js`、codex = `bin/codex.js`、
 *      gemini = `bundle/gemini.js`、claude = `bin/claude.exe`。
 *
 *   3. **kill 进程树。** Windows 上 `child.kill()` 只结束直接子进程，而 coding agent
 *      会拉起自己的子进程（跑测试、跑构建）—— 只杀壳会让它们活下来继续改工作区，
 *      表现为「已经取消了，文件还在变」。复用 `lib/git.js` 里验证过的 `taskkill /T`。
 *
 * 另外两件与安全有关的事：
 *   - stdout **不往后端控制台打**（规格 §37）。agent 的输出里可能有 env / token /
 *     文件内容，它只作为事件推给前端，而前端把它当不可信文本渲染。
 *   - stdout 有**字节上限**，超了只保留末尾（agent 的结论在最后），并置 `truncated`
 *     —— 一个跑飞的 agent 能吐出几百 MB，不设上限就是把后端内存交给它。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 默认单任务超时。coding agent 跑测试可能很久，给 30 分钟。 */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** stdout 默认上限 8 MB（保留末尾）。 */
export const DEFAULT_MAX_STDOUT = 8 * 1024 * 1024;

/* ---------- 解析真实可执行入口 ---------- */

/** 列出可能的 npm 全局 node_modules 位置。与 server/mcp.js 的思路一致，但更宽。 */
function npmGlobalRoots(env) {
  const out = [];
  const add = (p) => {
    if (p) out.push(p);
  };
  // npm 的 bin 目录与 node_modules 是兄弟关系
  add(env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules'));
  add(env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'npm', 'node_modules'));
  add(env.PREFIX && path.join(env.PREFIX, 'lib', 'node_modules'));
  add(env.PREFIX && path.join(env.PREFIX, 'node_modules'));
  const home = env.HOME || env.USERPROFILE;
  add(home && path.join(home, '.npm-global', 'lib', 'node_modules'));
  add(home && path.join(home, '.local', 'lib', 'node_modules'));
  add(home && path.join(home, 'node_modules'));
  add('/usr/local/lib/node_modules');
  add('/usr/lib/node_modules');
  add('/opt/homebrew/lib/node_modules');
  return out;
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 找出一个 agent 的真实可执行入口。
 *
 * @param pkgName  npm 包名（如 `@openai/codex`）
 * @param binName  package.json 里 bin 的键名（如 `codex`）
 * @param env      环境变量来源
 * @returns {{ok:true, kind:'node'|'exe', cmd:string, baseArgs:string[], packageDir:string, version:string, entryPath:string}
 *          | {ok:false, reason:string, detail:string}}
 *
 * `kind` 决定怎么 spawn：`node` → 用 `process.execPath` 跑那个 .js；
 * `exe` → 直接跑。**永远不会有 `shell` 这个取值** —— 那是本模块刻意排除的。
 */
export function resolveEntry({ pkgName, binName, env = process.env }) {
  const roots = npmGlobalRoots(env);
  let packageDir = null;
  for (const root of roots) {
    const dir = path.join(root, ...pkgName.split('/'));
    try {
      if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'package.json'))) {
        packageDir = dir;
        break;
      }
    } catch {
      /* 试下一个 */
    }
  }
  if (!packageDir) {
    return { ok: false, reason: 'not-installed', detail: `找不到 npm 包 ${pkgName}（已查 ${roots.length} 个全局位置）` };
  }

  const pkg = readJson(path.join(packageDir, 'package.json'));
  if (!pkg) return { ok: false, reason: 'bad-package', detail: `${pkgName} 的 package.json 读不出来` };
  const version = typeof pkg.version === 'string' ? pkg.version : '';

  const binField = pkg.bin;
  const rel = typeof binField === 'string' ? binField : binField && binField[binName];
  if (!rel) {
    return { ok: false, reason: 'no-bin', detail: `${pkgName} 的 package.json 里没有 bin.${binName}` };
  }

  const entryPath = path.join(packageDir, rel);
  if (!fs.existsSync(entryPath)) {
    /* 关键区分：包在、入口不在 —— 通常是「装坏了」（更新中断、二进制被杀软删掉），
     * 和「压根没装」是两回事。实测本机的 claude 就是这种：包 v2.1.142 在，
     * 但 bin/claude.exe 被改名成了 claude.exe.old.<时间戳>。 */
    return {
      ok: false,
      reason: 'entry-missing',
      detail: `${pkgName}@${version} 已安装，但入口文件不存在：${rel}`,
      packageDir,
      version,
      entryPath,
    };
  }

  const ext = path.extname(entryPath).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { ok: true, kind: 'node', cmd: process.execPath, baseArgs: [entryPath], packageDir, version, entryPath };
  }
  if (ext === '.exe' || ext === '') {
    return { ok: true, kind: 'exe', cmd: entryPath, baseArgs: [], packageDir, version, entryPath };
  }
  if (ext === '.cmd' || ext === '.bat') {
    /* 理论上的兜底：包直接把 .cmd 当 bin。这时只能经 cmd.exe 转发，
     * 但仍然用 args 数组（不拼串），所以没有注入面。实测几个 agent 都没走这条。 */
    return {
      ok: true,
      kind: 'exe',
      cmd: env.ComSpec || 'cmd.exe',
      baseArgs: ['/d', '/s', '/c', entryPath],
      packageDir,
      version,
      entryPath,
    };
  }
  return { ok: false, reason: 'unsupported-entry', detail: `不支持的入口类型：${rel}`, packageDir, version, entryPath };
}

/* ---------- 进程树 ---------- */

/**
 * 结束整棵进程树。
 * Windows 上 `child.kill()` 只结束直接子进程；agent 拉起的 `npm test` 会活下来。
 * `taskkill /T` 才是收整棵树的做法（与 lib/git.js 同一套）。
 */
export function killTree(child, { signal = 'SIGTERM' } = {}) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* 退回到直接 kill */
      try {
        child.kill();
      } catch {
        /* noop */
      }
    }
    return;
  }
  // POSIX：进程组（spawn 时 detached:true）整组收掉
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* noop */
    }
  }
}

/* ---------- 跑一个 CLI ---------- */

/**
 * @param entry   resolveEntry() 的结果（必须是 ok:true）
 * @param args    参数数组
 * @param cwd     工作目录（**必须已经过安全校验**，本层不做 containment 判断）
 * @param env     额外环境变量（会与 process.env 合并；传 null 表示不合并）
 * @param onLine  逐行回调（用于 JSONL 解析）。只按 LF 切分 —— pi 的协议明确要求，
 *                不能用 readline，因为它还会在 U+2028/U+2029 处切分。
 * @param onStderr stderr 文本回调
 * @param signal  AbortSignal，用于取消
 *
 * @returns {{ok, exitCode, stdout, stderr, stdoutBytes, truncated, timedOut, cancelled, spawnFailed, error}}
 *          **永不 reject** —— 调用方要的是「拿到结果对象再决定怎么办」。
 */
export function runCli({
  entry,
  args = [],
  cwd,
  env = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxStdoutBytes = DEFAULT_MAX_STDOUT,
  signal = null,
  onLine = null,
  onStderr = null,
}) {
  return new Promise((resolve) => {
    if (!entry || !entry.ok) {
      resolve({ ok: false, exitCode: null, stdout: '', stderr: '', stdoutBytes: 0, truncated: false, timedOut: false, cancelled: false, spawnFailed: true, error: (entry && entry.detail) || '入口不可用' });
      return;
    }
    if (signal && signal.aborted) {
      resolve({ ok: false, exitCode: null, stdout: '', stderr: '', stdoutBytes: 0, truncated: false, timedOut: false, cancelled: true, spawnFailed: false, error: '已取消' });
      return;
    }

    const childEnv = { ...process.env, ...(env || {}) };
    // agent 不需要、也不该看到访问令牌（与 rpc-bridge 同一条理由）
    delete childEnv.PI_GUI_TOKEN;

    let child;
    try {
      child = spawn(entry.cmd, [...entry.baseArgs, ...args], {
        cwd,
        env: childEnv,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve({ ok: false, exitCode: null, stdout: '', stderr: '', stdoutBytes: 0, truncated: false, timedOut: false, cancelled: false, spawnFailed: true, error: `无法启动：${err.message}` });
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    let tail = '';          // 只保留末尾 maxStdoutBytes 个字符
    let truncated = false;
    let stderrText = '';
    let lineBuf = '';
    let timedOut = false;
    let cancelled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ stdoutBytes, truncated, timedOut, cancelled, ...payload });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1000, timeoutMs));

    const onAbort = () => {
      cancelled = true;
      killTree(child);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      tail += chunk;
      if (tail.length > maxStdoutBytes) {
        tail = tail.slice(-maxStdoutBytes);
        truncated = true;
      }
      if (onLine) {
        lineBuf += chunk;
        let nl;
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          let line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line) {
            try {
              onLine(line);
            } catch {
              /* 回调出错不能拖垮进程管理 */
            }
          }
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderrText.length < 64 * 1024) stderrText += chunk;
      if (onStderr) {
        try {
          onStderr(chunk);
        } catch {
          /* noop */
        }
      }
    });

    child.on('error', (err) => {
      finish({ ok: false, exitCode: null, stdout: tail, stderr: stderrText, spawnFailed: true, error: `无法启动：${err.message}` });
    });

    child.on('close', (code, sig) => {
      // 收尾：把没有换行的最后一段也交出去
      if (onLine && lineBuf.trim()) {
        try {
          onLine(lineBuf.trim());
        } catch {
          /* noop */
        }
      }
      finish({
        ok: code === 0 && !timedOut && !cancelled,
        exitCode: code,
        signal: sig || null,
        stdout: tail,
        stderr: stderrText,
        spawnFailed: false,
        error: timedOut ? `超时（${Math.round(timeoutMs / 1000)}s）` : cancelled ? '已取消' : '',
      });
    });
  });
}
