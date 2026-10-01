/* Pi launch identity（P20.5 Blocker A）。
 *
 * ---------- 这个模块解决什么 ----------
 *
 * 「运行中 Pi 的 identity」之前是**两条互不相干的解析路径**：
 *
 *   - 真正 spawn 的那条：`server/rpc-bridge.js` 用 `PI_BIN || 'pi'`；
 *   - 版本 / built-in / MCP 探测用的那条：先问 agent registry 的 npm 全局扫描，
 *     拿不到再退到 `server/mcp.js` 里那份「常见全局安装位置」清单。
 *
 * 两份清单都**不看 PATH**，而 spawn 看。于是机器上同时装着两份 pi 时
 * （全局一份 0.99.1、`PI_BIN` 指向另一份 0.87.0 或一个 fork），RPC 实际启动 A、
 * 版本探测却读 B 的 `package.json`，GUI 就会把「另一份 Pi 的版本」报成
 * 「运行中的 Pi」。这是 P20.5 的核心 identity bug。
 *
 * 这里只回答一个问题：
 *
 *   **「如果现在启动主聊天 Pi，实际会执行哪个入口？那个入口属于哪个包？」**
 *
 * `rpc-bridge` 的启动命令、`pi-version` 的 `package.json` / `--version`、
 * `pi-builtins` 的包目录、`/api/mcp` 与 approval 的能力探测，**全部消费同一份
 * identity**（由 `server.js` 装配一次再注入）。任何一条路径都不再自己猜。
 *
 * ---------- 绑定条件（`packageDir` 只在能证明时才非 null）----------
 *
 *   A. `PI_BIN` 是**明确路径**：沿这个实际入口文件向上找
 *      `node_modules/@earendil-works/pi-coding-agent`，且那份 `package.json` 的
 *      `name` 必须就是这个包 —— 入口文件本身**必须存在**，否则证明不了。
 *   B. `PI_BIN` 是**裸命令**（`pi`）：真正解析靠 PATH / Windows shell。
 *      所以这里**自己按 PATH 解析一次**（Windows 上按 `PATHEXT` 顺序、
 *      并按 cmd.exe 的规则先看 cwd），再沿解析到的那个文件做 A 的绑定。
 *      解析不到 → `packageDir = null`。
 *
 * **证明不了就留空。** 不去「常见全局位置」碰运气 —— 那正是这个 bug 的来源。
 * 少知道一点，也比把另一份 Pi 说成正在运行的那份强：
 *
 *   - `packageDir = null` → 版本退到「对**同一个** launch spec 跑 `--version`」；
 *   - `--version` 也拿不到 → `unknown`（不是别的包里的版本号）；
 *   - built-in / ExtensionAPI / RPC 的**源码检视**保持 `unknown`
 *     —— 版本号是 evidence，不是 capability 判据。
 *
 * ---------- 纪律 ----------
 *
 * - **纯文件系统解析，不为找 packageDir 执行任何 shell。** 没有
 *   `where` / `which` / powershell 拼串 / cmd 解析用户输入。
 * - **`--version` 探测与 bridge 用同一个 launch spec**：本模块只出
 *   `launcher(args) → {command, spawnArgs, shell}`，真正的 spawn 仍由
 *   `server/pi-version.js` 做（args 数组、受控参数、超时、输出上限）。
 * - **不读包里的任何其它文件**，`package.json` 限长。
 * - **对外只给脱敏摘要**（`summary()`：source / basename / known），
 *   绝对路径不出这个模块 —— renderer 与 Diagnostics 不该拿到它们。
 */
import fs from 'node:fs';
import path from 'node:path';

/** pi 包的 npm 名（与 `server/agents/pi.js`、`server/mcp.js` 同一个常量语义）。 */
const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const PI_PACKAGE_TAIL = PI_PACKAGE.split('/');

const MAX_PKG_BYTES = 256 * 1024;
/** 向上查找的层数上限（防止畸形路径上一直走到根）。 */
const MAX_WALK_UP = 6;
/** Windows 上没给 `PATHEXT` 时的默认顺序（cmd.exe 的默认值的前四个）。 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * 把「启动命令 + 参数」成形成真正要交给 `spawn` 的东西。
 *
 * **bridge 与 `--version` 探测共用这一个函数** —— 「同一个 launch spec」
 * 是靠代码结构保证的，不是靠两条长得像的实现各自祈祷。
 *
 *   - POSIX：`spawn(cmd, args, {shell:false})`，永不拼串；
 *   - Windows：历史上 pi 是 npm 的 `.cmd` 包装脚本，必须经 shell 启动；
 *     `spawn(cmd, args, {shell:true})` 会触发 DEP0190，所以沿用 bridge
 *     一直的做法 —— 自己按 Node 文档认可的方式拼一条命令串。
 *
 * @returns {{ command: string, spawnArgs: string[], shell: boolean }}
 */
export function formatLaunch(bin, args, isWin) {
  const list = Array.isArray(args) ? args : [];
  if (!isWin) return { command: bin, spawnArgs: [...list], shell: false };
  // 参数都是命令行开关和模型名，不含引号；万一有就剔掉，避免把命令拼坏
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  return { command: [bin, ...list].map(q).join(' '), spawnArgs: [], shell: true };
}

/** 是不是「路径样」的启动命令（含分隔符或绝对路径）。 */
function isPathLike(bin) {
  return typeof bin === 'string' && (bin.includes('/') || bin.includes('\\') || path.isAbsolute(bin));
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 读一个包目录的 `package.json`（限长、只取两个字段）。读不到回 null。 */
function readPackageMeta(dir) {
  if (!dir) return null;
  try {
    const file = path.join(dir, 'package.json');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_PKG_BYTES) return null;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!pkg || typeof pkg !== 'object') return null;
    return { name: typeof pkg.name === 'string' ? pkg.name : '' };
  } catch {
    return null;
  }
}

/** 这个目录是不是**那一份** pi 包（靠 name 认，不靠「它存在」认）。 */
function isPiPackageDir(dir) {
  const meta = readPackageMeta(dir);
  return Boolean(meta && meta.name === PI_PACKAGE);
}

/**
 * 从一个**真实入口文件**出发，向上找属于它的 pi 包目录。
 *
 * 两个起点都走一遍：入口原路径，以及 `realpath`（POSIX 上 npm 全局 bin 是
 * 符号链接，解出来就直接落在包里了）。找不到回 null —— 不去别处碰运气。
 */
function packageDirFromEntry(entryFile) {
  const starts = [];
  const add = (p) => {
    if (typeof p === 'string' && p && !starts.includes(p)) starts.push(p);
  };
  add(entryFile);
  try {
    add(fs.realpathSync(entryFile));
  } catch {
    /* 链接解不开就只用原路径 */
  }
  const tail = path.join('node_modules', ...PI_PACKAGE_TAIL);
  const pkgName = PI_PACKAGE_TAIL[PI_PACKAGE_TAIL.length - 1];

  for (const start of starts) {
    let dir = path.dirname(start);
    for (let i = 0; i <= MAX_WALK_UP; i++) {
      // 入口直接落在包里（realpath 的情形）
      if (path.basename(dir) === pkgName && isPiPackageDir(dir)) return dir;
      for (const rel of [tail, path.join('lib', tail)]) {
        const cand = path.join(dir, rel);
        if (isPiPackageDir(cand)) return cand;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** env 里的 PATH（Windows 的键名大小写不统一，这里显式兼容）。 */
function pathEntries(env) {
  const raw = env.PATH ?? env.Path ?? env.path;
  if (typeof raw !== 'string' || !raw) return [];
  return raw.split(path.delimiter).map((s) => s.trim()).filter(Boolean);
}

function pathExtList(env) {
  const raw = env.PATHEXT ?? env.Pathext ?? env.pathext;
  /* 注意 `''` 也是**有效取值**（显式说「不补后缀」），所以只按「是不是字符串」判，
   * 不能按「空不空」判 —— 否则传 `PATHEXT=''` 会被偷偷换成默认后缀列表。 */
  const list = typeof raw === 'string' ? raw.split(';') : DEFAULT_PATHEXT.split(';');
  return list.map((s) => s.trim()).filter(Boolean);
}

/**
 * 按 PATH 找裸命令对应的那个文件。
 *
 * 这里刻意**镜像操作系统自己的解析规则**，而不是去翻一份「常见安装位置」清单：
 *   - POSIX（`spawn` 不带 shell）→ 只查 PATH，取命令名原样；
 *   - Windows（经 `cmd.exe`）→ 先看 cwd，再按 `PATHEXT` 顺序逐个试。
 * 找不到回 null。**这一步只做文件系统 stat，不执行任何东西。**
 */
function commandFileFromPath(bin, { env, cwd, isWin }) {
  const dirs = [];
  if (isWin && cwd) dirs.push(cwd);
  dirs.push(...pathEntries(env));
  /* 先试**命令名原样**（POSIX 就只认这个），再按 PATHEXT 逐个补后缀 ——
   * Windows 的 SearchPath / cmd 也是先精确名、再扩展名的顺序。 */
  const exts = isWin ? ['', ...pathExtList(env)] : [''];
  for (const dir of dirs) {
    const base = path.isAbsolute(dir) || !cwd ? dir : path.resolve(cwd, dir);
    for (const ext of exts) {
      const candidate = path.join(base, bin + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 算一份 launch identity。**纯函数式的副作用边界只有文件系统 stat / 读 package.json。**
 *
 * @param bin   实际启动命令（`PI_BIN` 或 `'pi'`）
 * @param env   环境变量（PATH / PATHEXT）
 * @param cwd   bridge 启动子进程用的工作目录（Windows 上它决定 cmd 的第一个搜索位置）
 * @param isWin 平台（显式传入，便于单测）
 */
function compute({ bin, env, cwd, isWin }) {
  const explicit = isPathLike(bin);
  let entryFile = null;

  if (explicit) {
    const file = path.isAbsolute(bin) ? bin : path.resolve(cwd || process.cwd(), bin);
    entryFile = isFile(file) ? file : null;
  } else {
    entryFile = commandFileFromPath(bin, { env, cwd, isWin });
  }

  const packageDir = entryFile ? packageDirFromEntry(entryFile) : null;

  return {
    bin,
    /** `env` = 用户显式给了 `PI_BIN`；`path` = 裸命令，靠 PATH / shell 解析。 */
    source: explicit ? 'env' : 'path',
    /** 入口文件有没有被解析出来（它是 `packageDir` 绑定的前提）。 */
    entryKnown: Boolean(entryFile),
    /**
     * 只在**能证明它就是这个入口所属的包**时才非 null。
     * null = 未知 —— 调用方必须照 unknown 处理，不许去别处补一个。
     */
    packageDir,
    packageDirKnown: Boolean(packageDir),
  };
}

/**
 * 组装 launch identity。带 TTL 缓存（按 cwd 分键 —— Windows 上 cwd 影响
 * cmd 的命令搜索，切项目后结论可能不同，这正是不能只按时间缓存的原因）。
 *
 * **本模块自己不 spawn 任何东西**：`--version` 探测由 `server/pi-version.js`
 * 负责，它用这里的 `launcher` 拿到与 bridge 同一个 launch spec。
 *
 * @param piBin   实际启动命令，默认 `'pi'`
 * @param env     环境变量来源（PATH / PATHEXT）
 * @param getCwd  当前项目目录（bridge 的 cwd），默认 null
 */
export function createPiLaunch({
  piBin = 'pi',
  env = process.env,
  isWin = process.platform === 'win32',
  getCwd = () => null,
  now = () => Date.now(),
  ttlMs = 30_000,
} = {}) {
  const bin = typeof piBin === 'string' && piBin ? piBin : 'pi';
  let cache = null;

  function identity({ force = false } = {}) {
    const cwd = getCwd() || null;
    const t = now();
    if (force || !cache || cache.key !== cwd || t - cache.at >= ttlMs) {
      cache = { key: cwd, at: t, data: compute({ bin, env, cwd, isWin }) };
    }
    return cache.data;
  }

  /** 只要包目录（拿不到就是 null）。pi-version / pi-builtins / mcp / approval 都读它。 */
  function packageDir() {
    const id = identity();
    return id.packageDir || null;
  }

  /**
   * 脱敏摘要 —— **renderer / Diagnostics 只拿这个**。
   * 只有 source、basename、known/unknown；绝对路径与 HOME 一个字节都不出去。
   */
  function summary() {
    const id = identity();
    let binName = id.bin;
    try {
      binName = path.basename(id.bin) || id.bin;
    } catch {
      /* 保底：原样给，反正它不是绝对路径 */
    }
    return {
      source: id.source,
      binName,
      entryKnown: id.entryKnown,
      packageDirKnown: id.packageDirKnown,
    };
  }

  function reset() {
    cache = null;
  }

  /** 给 `createPiVersionProbe({ launcher })` 用：**同一个 launch spec** 的 `--version`。 */
  const launcher = (args) => formatLaunch(bin, args, isWin);

  return { identity, packageDir, summary, reset, launcher, formatLaunch: launcher };
}
