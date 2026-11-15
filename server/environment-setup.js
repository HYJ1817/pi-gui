/* 首次启动的环境检测 —— 只读、可解释、不会把应用带崩。
 *
 * 回答四件事：本机有什么、能不能用、缺的怎么补、补之前要不要用户知情。
 *
 * ---------- 与既有模块的关系 ----------
 *
 * - **Pi 的身份只走 `server/pi-launch.js`。** 本模块不扫 npm 全局目录、
 *   不另写「常见安装位置」清单。`piLaunch.identity()` 已经回答了「现在真正
 *   会启动哪一份 Pi」，这里只消费它。
 * - **版本只走 `server/pi-version.js`。** 同一份 launch identity、同一套
 *   `package.json` / `--version` 优先级与缓存；本模块不重新解析版本。
 * - **安装根与已装版本只走 `server/environment-store.js`。** 检测每次都读真实
 *   文件系统，store 只记「我们装过什么」。
 * - Node / npm / Git 的解析复用 `pi-launch.js` 的 `resolveExecutable()`，
 *   即同一套 PATH / PATHEXT 规则；不执行 `where`，也不拼 shell。
 *
 * ---------- 隐私 ----------
 *
 * 报告里**没有绝对路径**：`executable` 是 `%LOCALAPPDATA%\...` 形式的投影，
 * 另给一个 basename。原始路径只在本模块与安装执行层内部使用。
 *
 * ---------- 失败 ----------
 *
 * 每个组件独立 try/catch。一个组件探测失败只把自己标成 `failed`，不会让
 * `GET /api/environment` 500，更不会让应用启动失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { formatLaunch, resolveExecutable } from './pi-launch.js';
import { compareVersions, PI_BASELINES } from './pi-compat-matrix.js';
import { PI_MIN_NODE, PI_PACKAGE, NODE_LTS, GIT_MINIGIT } from './environment-store.js';

/* 版本输出可能是 `v24.22.1`（Node）、`git version 2.56.1.windows.1`（Git）
 * 或 `pi 1.5.2`。这里只取前三段数字，不把厂商后缀当成版本的一部分。 */
const VERSION_RE = /(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?/;
const RPC_ARGS = Object.freeze([
  '--mode', 'rpc', '--no-session', '--no-extensions', '--no-mcp',
  '--no-skills', '--no-prompt-templates', '--no-context-files', '--offline',
]);
const RPC_TIMEOUT_MS = 12_000;
const RPC_CACHE_MS = 60_000;
const REPORT_CACHE_MS = 5_000;
const MAX_PROBE_OUTPUT = 64 * 1024;

function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().slice(0, 4096);
  const m = VERSION_RE.exec(text);
  return m ? m[1] : null;
}

function safeEnv(env) {
  const out = { ...env };
  delete out.PI_GUI_TOKEN;
  return out;
}

function executableLabel(file) {
  if (typeof file !== 'string' || !file) return null;
  try {
    return path.basename(file);
  } catch {
    return null;
  }
}

function isFile(fsApi, file) {
  try {
    return fsApi.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 从存在的最近一级父目录判断可写性；只 `access`，不创建任何东西。 */
function writableTarget(fsApi, target) {
  if (typeof target !== 'string' || !target) return null;
  let dir = path.resolve(target);
  for (let i = 0; i < 12; i++) {
    try {
      if (fsApi.statSync(dir).isDirectory()) {
        fsApi.accessSync(dir, fs.constants.W_OK);
        return true;
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') return false;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** 由 Node 的可执行文件找到同版本的 npm CLI（避开 `.cmd`，不经过 shell）。 */
export function findNpmCli(nodeExe, fsApi, isWin) {
  if (typeof nodeExe !== 'string' || !nodeExe) return null;
  const candidates = [];
  if (isWin) {
    candidates.push(path.join(path.dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  } else {
    try {
      const real = fsApi.realpathSync(nodeExe);
      candidates.push(path.resolve(path.dirname(real), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    } catch {
      /* 保底用同目录布局 */
    }
    candidates.push(path.resolve(path.dirname(nodeExe), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  return candidates.find((file) => isFile(fsApi, file)) || null;
}

/** 从 Pi 包里读 `engines.node`，把最低 Node 要求交给实际安装的那份 Pi 决定。 */
function readPiMinNode(packageDir, fsApi) {
  if (typeof packageDir !== 'string' || !packageDir) return null;
  try {
    const file = path.join(packageDir, 'package.json');
    const stat = fsApi.statSync(file);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    const pkg = JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const range = pkg && pkg.engines && typeof pkg.engines.node === 'string' ? pkg.engines.node : '';
    const m = />=\s*(\d+\.\d+\.\d+)/.exec(range);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * 默认 RPC 就绪探测：启动一份隔离的 Pi，发 `get_state`，只认成功应答。
 *
 * 与 bridge 共用 `formatLaunch()` 的 launch spec；参数固定、无用户输入；
 * 12 秒超时；进程树由注入的 `killTree` 收掉；不记录 stdout / stderr 原文。
 */
export function probePiRpc({ bin, env, isWin, killTree = (child) => child.kill(), timeoutMs = RPC_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child = null;
    let settled = false;
    let timer = null;
    let buf = '';
    let bytes = 0;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        if (child) killTree(child);
      } catch {
        /* 收尸失败不改变探测结论 */
      }
      resolve({ ...result, ms: Date.now() - startedAt });
    };

    try {
      const spec = formatLaunch(bin, RPC_ARGS, isWin);
      child = spawn(spec.command, spec.spawnArgs, {
        cwd: os.tmpdir(),
        env: safeEnv(env),
        shell: spec.shell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      resolve({ ok: false, code: 'spawn-failed', ms: Date.now() - startedAt });
      return;
    }

    timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), Math.max(2000, timeoutMs));

    child.on('error', () => finish({ ok: false, code: 'spawn-failed' }));
    child.on('exit', () => finish({ ok: false, code: 'exited' }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > 256 * 1024) {
        finish({ ok: false, code: 'output-limit' });
        return;
      }
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line) continue;
        let msg = null;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg && msg.type === 'response' && msg.id === 1 && msg.command === 'get_state' && msg.success === true) {
          finish({ ok: true });
          return;
        }
      }
    });

    try {
      child.stdin.write(JSON.stringify({ type: 'get_state', id: 1 }) + '\n');
    } catch {
      finish({ ok: false, code: 'write-failed' });
    }
  });
}

function oldestBaseline() {
  let best = null;
  for (const entry of PI_BASELINES) {
    if (!entry || typeof entry.version !== 'string') continue;
    if (!best || compareVersions(entry.version, best.version) < 0) best = entry;
  }
  return best;
}

/**
 * @param store       `createEnvironmentStore()`
 * @param piLaunch    `createPiLaunch()`（同一份身份）
 * @param piVersion   `createPiVersion()`（同一份版本真值）
 * @param baseEnv     **受管 PATH 生效之前**的进程环境；系统 Node 必须按它判断，
 *                    否则「我们自己装的 Node」会被误报成系统 Node。
 * @param run         spawnSync 替身（单测）
 * @param runRpc      RPC 探测替身（单测）
 * @param killTree    受控进程树终止（server.js 注入）
 */
export function createEnvironmentSetup({
  store,
  piLaunch,
  piVersion,
  baseEnv = process.env,
  isWin = process.platform === 'win32',
  fsApi = fs,
  run = spawnSync,
  runRpc = null,
  killTree = null,
  now = () => Date.now(),
  reportTtlMs = REPORT_CACHE_MS,
  rpcTtlMs = RPC_CACHE_MS,
  electronVersion = process.versions.node,
  electronPath = process.execPath,
} = {}) {
  if (!store) throw new Error('environment setup requires store');
  const redact = (p) => store.redactPath(p);
  let reportCache = null;
  let rpcCache = null;
  let getJob = null;

  /**
   * RPC 探测实际使用的环境。
   *
   * 受管 Node 装好后，`runtime/pi/pi.cmd` 里的 npm shim 仍然用 PATH 上的
   * `node` 启动 Pi —— 它不会自己去 `runtime/node-v…` 找。而 `baseEnv` 是
   * 受管 PATH 生效**之前**的快照（系统 Node 检测需要它），所以这里必须
   * 重新套一次受管 PATH，否则「刚装完 Node + Pi」的机器上 RPC 验证会
   * 找不到 node，把一次成功的安装误判成失败。
   *
   * 在副本上应用，不污染 `baseEnv`；系统 Node / Electron Node 的判定仍按
   * 原始环境进行。
   */
  function rpcEnv() {
    const out = { ...baseEnv };
    try {
      if (typeof store.applyManagedPath === 'function') store.applyManagedPath(out);
    } catch {
      /* 受管 PATH 不可用时按原环境探测，由探测结果如实报告 */
    }
    return out;
  }

  function probeOutput(file, args) {
    try {
      const res = run(file, args, {
        env: safeEnv(baseEnv),
        encoding: 'utf8',
        timeout: 6000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: MAX_PROBE_OUTPUT,
      });
      if (!res || res.error) return { ok: false, stdout: '', stderr: '' };
      return { ok: res.status === 0, stdout: `${res.stdout || ''}`, stderr: `${res.stderr || ''}` };
    } catch {
      return { ok: false, stdout: '', stderr: '' };
    }
  }

  function detectNodeCandidate(source, nodeExe) {
    if (!nodeExe) return null;
    const versionInfo = probeOutput(nodeExe, ['--version']);
    const version = parseVersion(versionInfo.stdout || versionInfo.stderr);
    const npmCli = findNpmCli(nodeExe, fsApi, isWin);
    let npm = null;
    if (npmCli) {
      const v = probeOutput(nodeExe, [npmCli, '--version']);
      const p = probeOutput(nodeExe, [npmCli, 'prefix', '-g']);
      npm = {
        present: true,
        version: parseVersion(v.stdout || v.stderr),
        prefix: p.ok ? redact((p.stdout || '').trim()) : null,
        prefixKnown: p.ok,
      };
    } else {
      npm = { present: false, version: null, prefix: null, prefixKnown: false };
    }
    return {
      source,
      exe: nodeExe,
      version,
      versionKnown: Boolean(version),
      runnable: versionInfo.ok,
      npm,
    };
  }

  function detectElectronNode() {
    const version = parseVersion(String(electronVersion || ''));
    return {
      version,
      known: Boolean(version),
      path: redact(electronPath),
      note: 'Pi GUI 自身运行所用的 Node，不提供给外部 Pi 进程。',
    };
  }

  function detectNpmFor(candidate) {
    if (!candidate) return { present: false, version: null, prefix: null, prefixKnown: false };
    return candidate.npm;
  }

  function detectGit(force = false) {
    const systemExe = resolveExecutable('git', { env: baseEnv, cwd: null, isWin });
    const managedExe = store.managedGitBin();
    const system = systemExe ? detectGitCandidate('system', systemExe) : null;
    const managed = managedExe ? detectGitCandidate('managed', managedExe) : null;
    const chosen = system || managed;
    const version = chosen ? chosen.version : null;
    const present = Boolean(chosen);
    const action = present ? 'none' : (isWin ? 'install-git' : 'manual');
    return {
      id: 'git',
      kind: 'recommended',
      status: present ? 'ready' : 'needs-install',
      present,
      version,
      source: chosen ? chosen.source : 'none',
      executable: chosen ? redact(chosen.exe) : null,
      executableLabel: chosen ? executableLabel(chosen.exe) : null,
      action,
      installAvailable: !present && isWin,
      installVersion: GIT_MINIGIT.version,
      installSource: 'Git for Windows 官方 MinGit',
      missingIsBlocking: false,
      detail: present ? 'Git 可用，用于变更查看与 Worktree。' : 'Git 是推荐依赖。缺少它不影响开始对话，但无法使用变更与 Worktree。',
      _exe: chosen ? chosen.exe : null,
      _force: force,
    };
  }

  function detectGitCandidate(source, exe) {
    const info = probeOutput(exe, ['--version']);
    const version = parseVersion(info.stdout || info.stderr);
    return { source, exe, version, runnable: info.ok };
  }

  function currentPiRpc(identityKnown, force) {
    if (!identityKnown) return { state: 'skipped', code: null, checkedAt: null, ms: null };
    const key = (() => {
      try {
        return piLaunch && typeof piLaunch.identityKey === 'function' ? piLaunch.identityKey() : '';
      } catch {
        return '';
      }
    })();
    const t = now();
    if (!force && rpcCache && rpcCache.key === key && t - rpcCache.at < rpcTtlMs) return { ...rpcCache.result, cached: true };
    return null; // 由 async check() 填充
  }

  async function runPiRpcOnce(bin, force) {
    const key = (() => {
      try {
        return piLaunch && typeof piLaunch.identityKey === 'function' ? piLaunch.identityKey() : '';
      } catch {
        return '';
      }
    })();
    const t = now();
    if (!force && rpcCache && rpcCache.key === key && t - rpcCache.at < rpcTtlMs) {
      return { ...rpcCache.result, cached: true };
    }
    const probe = typeof runRpc === 'function'
      ? runRpc
      : (args) => probePiRpc({ ...args, killTree: killTree || ((child) => child.kill()) });
    let result;
    try {
      const raw = await probe({ bin, env: rpcEnv(), isWin, timeoutMs: RPC_TIMEOUT_MS });
      result = raw && raw.ok
        ? { state: 'ready', code: null, checkedAt: new Date(now()).toISOString(), ms: Number.isInteger(raw.ms) ? raw.ms : null }
        : { state: 'failed', code: (raw && typeof raw.code === 'string') ? raw.code : 'failed', checkedAt: new Date(now()).toISOString(), ms: Number.isInteger(raw && raw.ms) ? raw.ms : null };
    } catch {
      result = { state: 'failed', code: 'probe-error', checkedAt: new Date(now()).toISOString(), ms: null };
    }
    rpcCache = { key, at: now(), result };
    return result;
  }

  function detectNode(minNode) {
    const systemExe = resolveExecutable('node', { env: baseEnv, cwd: null, isWin });
    const managedExe = (() => {
      const dir = store.managedNodeDir();
      return dir ? path.join(dir, isWin ? 'node.exe' : 'bin/node') : null;
    })();
    const system = detectNodeCandidate('system', systemExe);
    const managed = detectNodeCandidate('managed', managedExe);
    const meets = (c) => Boolean(c && c.version && compareVersions(c.version, minNode) >= 0);
    let primary = null;
    if (meets(system)) primary = system;
    else if (meets(managed)) primary = managed;
    else if (system) primary = system;
    else if (managed) primary = managed;

    const npm = detectNpmFor(primary);
    const present = Boolean(primary);
    const version = primary ? primary.version : null;
    const meetsMinimum = Boolean(primary && primary.version && compareVersions(primary.version, minNode) >= 0);
    let status = present ? (meetsMinimum ? 'ready' : 'incompatible') : 'needs-install';
    let action = status === 'ready' ? 'none' : (isWin ? 'install-node' : 'manual');
    const warnings = [];
    /* 「Node 就绪」与「能用 Node 装 Pi」不是同一件事：没有 npm 时 Pi 装不上。
     * 所以这条也必须是可安装的理由，否则计划里会出现一个装不了的 Pi ——
     * 用户点完一键安装，最后在 npm-missing 上失败。Pi 已经装好时则不需要
     * npm，缺失只给警告，不阻塞对话。 */
    const npmBlocksPi = meetsMinimum && !npm.present && !piLaunchPackageDir();
    if (meetsMinimum && !npm.present) {
      warnings.push('npm-missing');
      if (npmBlocksPi) action = isWin ? 'install-node' : 'manual';
    }
    return {
      id: 'node',
      kind: 'required',
      status,
      present,
      version,
      minimum: minNode,
      minimumSource: minNode === PI_MIN_NODE ? 'fallback' : 'pi-engines',
      meetsMinimum,
      source: primary ? primary.source : 'none',
      executable: primary ? redact(primary.exe) : null,
      executableLabel: primary ? executableLabel(primary.exe) : null,
      runnable: primary ? primary.runnable : false,
      npm: {
        present: Boolean(npm.present),
        version: npm.version,
        prefix: npm.prefix,
        prefixKnown: npm.prefixKnown,
        status: npm.present ? (npm.version ? 'ready' : 'unknown') : 'missing',
      },
      electron: detectElectronNode(),
      warnings,
      action,
      installAvailable: (status !== 'ready' || npmBlocksPi) && isWin,
      installVersion: NODE_LTS.version,
      installSource: 'Node.js 官方 LTS ZIP',
      detail: present
        ? (meetsMinimum
          ? `Node.js ${version} 可用。${meetsMinimum && !npm.present ? ' npm 不可用；Pi 仍可运行，但无法安装或更新 Pi。' : ''}`
          : `Node.js ${version} 低于 Pi 要求的 ${minNode}。`)
        : `需要 Node.js ${minNode} 或更新的 LTS。`,
      _primary: primary,
      _system: system,
      _managed: managed,
    };
  }

  function piLaunchPackageDir() {
    try {
      return piLaunch && typeof piLaunch.packageDir === 'function' ? piLaunch.packageDir() : null;
    } catch {
      return null;
    }
  }

  async function detectPi(force) {
    const identity = (() => {
      try {
        return piLaunch && typeof piLaunch.identity === 'function' ? piLaunch.identity({ force }) : null;
      } catch {
        return null;
      }
    })() || { bin: 'pi', source: 'path', entryKnown: false, packageDir: null, packageDirKnown: false };
    const present = Boolean(identity.entryKnown);
    /* 入口都没解析到就不要去跑 `pi --version`：那会执行一个不存在/错误的
     * 路径，得到的错误文本还会被当成「畸形版本」。缺失就是未知，不猜。 */
    const state = !present
      ? { value: null, source: 'none', status: 'unknown', verification: 'unchecked', verifiedAgainst: null, relative: 'unknown' }
      : (() => {
        try {
          return piVersion && typeof piVersion.read === 'function' ? piVersion.read({ force }) : null;
        } catch {
          return null;
        }
      })() || { value: null, source: 'none', status: 'unknown', verification: 'unchecked', verifiedAgainst: null, relative: 'unknown' };
    const version = state.value;
    const compat = {
      status: state.verification || 'unchecked',
      relative: state.relative || 'unknown',
      verifiedAgainst: state.verifiedAgainst || null,
    };
    let rpc = { state: 'skipped', code: null, checkedAt: null, ms: null };
    if (present) {
      const cached = currentPiRpc(true, force);
      rpc = cached || await runPiRpcOnce(identity.bin, force);
    }

    /* `pi-launch` 把「显式路径」统一叫 env（它只关心启动方式）；对用户
     * 展示的来源要区分 PI_BIN / 手动覆盖 / 受管目录，所以以 store 为准。 */
    const effective = store.effectivePiBin();
    const locked = Boolean(effective.locked);
    const source = present
      ? (effective.source === 'path' ? identity.source : effective.source)
      : (locked ? 'locked' : 'none');
    const baseline = oldestBaseline();
    const belowOldest = Boolean(version && baseline && compareVersions(version, baseline.version) < 0);
    const malformed = state.status === 'malformed';
    const warnings = [];
    let status = 'ready';
    let action = 'none';
    let detail = 'Pi 已安装，RPC 可以启动。';

    if (!present) {
      status = 'needs-install';
      action = locked ? 'manual' : 'install-pi';
      detail = locked
        ? '已通过 PI_BIN 或手动路径指定 Pi，但这个入口不可用。请修正路径，或清除指定后由向导安装。'
        : '尚未找到 Pi。向导可以把它安装到当前用户目录，不会覆盖系统里已有的安装。';
    } else if (malformed) {
      status = 'incompatible';
      action = locked ? 'manual' : 'update-pi';
      detail = '这份 Pi 的版本信息无法识别。请用现有 Pi Updater 更新，或检查 PI_BIN 是否指向了别的东西。';
    } else if (belowOldest) {
      status = 'incompatible';
      action = locked ? 'manual' : 'update-pi';
      detail = `Pi ${version} 低于本应用验证过的最低版本 ${baseline.version}。请通过现有 Pi Updater 升级。`;
    } else if (rpc.state === 'failed') {
      status = 'incompatible';
      action = version ? 'update-pi' : 'manual';
      detail = '找到了 Pi，但它没有完成 RPC 就绪应答。请先重试；仍然失败时用现有 Pi Updater 修复。';
    } else if (rpc.state !== 'ready') {
      status = 'incompatible';
      action = version ? 'update-pi' : 'manual';
      detail = 'Pi 的 RPC 状态未知，暂时无法确认它是否能用于对话。';
    }

    if (status === 'ready') {
      if (state.status === 'unknown') {
        warnings.push('version-unknown');
        detail = 'Pi 已安装且 RPC 可以启动；版本号未能读取，因此无法核对兼容矩阵。';
      } else if (compat.status === 'unverified' && compat.relative === 'older') {
        warnings.push('below-current-baseline');
        detail = `Pi ${version} 可以启动，但低于当前验证基线；建议通过现有 Pi Updater 升级。`;
      } else if (compat.status === 'unverified') {
        warnings.push('unverified');
        detail = `Pi ${version} 可以启动，但不在兼容矩阵中。`;
      }
    }

    return {
      id: 'pi',
      kind: 'required',
      status,
      present,
      version,
      versionStatus: state.status || 'unknown',
      versionSource: state.source || 'none',
      compat,
      rpc,
      source,
      locked,
      executable: present ? redact(identity.bin) : (locked ? redact(effective.bin) : null),
      executableLabel: present ? executableLabel(identity.bin) : null,
      packageKnown: Boolean(identity.packageDirKnown),
      action,
      installAvailable: !present && !locked && isWin,
      installSource: `npm 官方包 ${PI_PACKAGE}`,
      warnings,
      detail,
      _identity: identity,
    };
  }

  function buildPlan(node, pi, git, config) {
    const steps = [];
    const nodeNeeded = node.status !== 'ready' || (pi.status === 'needs-install' && !node.npm.present);
    if (nodeNeeded && node.installAvailable) steps.push('node');
    if (pi.status === 'needs-install' && pi.installAvailable) steps.push('pi');
    if (git.status === 'needs-install' && git.installAvailable) steps.push('git');
    const optional = steps.includes('git') ? ['git'] : [];
    const planMaterial = JSON.stringify({
      steps,
      node: { status: node.status, version: node.version, source: node.source, npm: node.npm.status },
      pi: { status: pi.status, version: pi.version, source: pi.source, locked: pi.locked },
      git: { status: git.status, version: git.version, source: git.source },
      versions: [NODE_LTS.version, GIT_MINIGIT.version, PI_PACKAGE],
      writable: writableTarget(fsApi, store.paths().root),
    });
    return {
      planId: 'plan-' + crypto.createHash('sha256').update(planMaterial).digest('hex').slice(0, 20),
      steps,
      required: steps.filter((id) => id !== 'git'),
      optional,
      requiresAdmin: false,
      scope: 'user',
      installRoot: redact(store.paths().root),
      targetWritable: writableTarget(fsApi, store.paths().root),
      components: [node, pi, git]
        .filter((c) => steps.includes(c.id))
        .map((c) => ({
          id: c.id,
          kind: c.kind,
          version: c.id === 'node' ? NODE_LTS.version : c.id === 'git' ? GIT_MINIGIT.version : 'latest',
          source: c.installSource,
          scope: '当前用户',
        })),
      piLocked: pi.locked,
      completedAt: config.setup.completedAt,
    };
  }

  function sanitizeJob(job) {
    if (!job || typeof job !== 'object') return null;
    return {
      id: typeof job.id === 'string' ? job.id : null,
      state: typeof job.state === 'string' ? job.state : null,
      startedAt: typeof job.startedAt === 'string' ? job.startedAt : null,
      finishedAt: typeof job.finishedAt === 'string' ? job.finishedAt : null,
      completedSteps: Number.isInteger(job.completedSteps) ? job.completedSteps : 0,
      totalSteps: Number.isInteger(job.totalSteps) ? job.totalSteps : 0,
      errorCode: typeof job.errorCode === 'string' ? job.errorCode : null,
    };
  }

  async function check({ force = false } = {}) {
    const t = now();
    if (!force && reportCache && t - reportCache.at < reportTtlMs) return reportCache.report;

    const minNode = readPiMinNode(piLaunchPackageDir(), fsApi) || PI_MIN_NODE;
    let pi;
    try {
      pi = await detectPi(force);
    } catch {
      pi = {
        id: 'pi', kind: 'required', status: 'failed', present: false, version: null,
        versionStatus: 'unknown', versionSource: 'none', compat: { status: 'unknown', relative: 'unknown', verifiedAgainst: null },
        rpc: { state: 'unknown', code: 'detect-error', checkedAt: null, ms: null },
        source: 'none', locked: false, executable: null, executableLabel: null, packageKnown: false,
        action: 'manual', installAvailable: false, installSource: `npm 官方包 ${PI_PACKAGE}`,
        warnings: [], detail: 'Pi 检测没有完成。可以重试，或在诊断中查看脱敏信息。',
      };
    }

    let node;
    try {
      node = detectNode(minNode);
    } catch {
      node = {
        id: 'node', kind: 'required', status: 'failed', present: false, version: null,
        minimum: minNode, minimumSource: 'fallback', meetsMinimum: false, source: 'none',
        executable: null, executableLabel: null, runnable: false,
        npm: { present: false, version: null, prefix: null, prefixKnown: false, status: 'unknown' },
        electron: detectElectronNode(), warnings: [], action: isWin ? 'install-node' : 'manual',
        installAvailable: isWin, installVersion: NODE_LTS.version, installSource: 'Node.js 官方 LTS ZIP',
        detail: 'Node.js 检测没有完成。可以重试。',
      };
    }

    let git;
    try {
      git = detectGit(force);
    } catch {
      git = {
        id: 'git', kind: 'recommended', status: 'failed', present: false, version: null,
        source: 'none', executable: null, executableLabel: null, action: isWin ? 'install-git' : 'manual',
        installAvailable: isWin, installVersion: GIT_MINIGIT.version, installSource: 'Git for Windows 官方 MinGit',
        missingIsBlocking: false, detail: 'Git 检测没有完成；它不影响 Pi 的基本使用。',
      };
    }

    const config = store.read();
    const requiredReady = node.status === 'ready' && pi.status === 'ready';
    const plan = buildPlan(node, pi, git, config);
    const activeJob = typeof getJob === 'function' ? sanitizeJob(getJob()) : null;
    const lastJob = activeJob || sanitizeJob(config.lastJob);
    const interrupted = config.lastJob && config.lastJob.state === 'interrupted' ? sanitizeJob(config.lastJob) : null;

    const clean = (c) => {
      const { _primary, _system, _managed, _exe, _force, _identity, ...rest } = c;
      return rest;
    };
    const report = {
      ok: true,
      generatedAt: new Date(t).toISOString(),
      platform: { os: process.platform, arch: process.arch, supported: isWin },
      ready: requiredReady,
      requiredReady,
      needsSetup: !requiredReady,
      firstRun: config.setup.completedAt === null,
      shouldPrompt: config.setup.completedAt === null || !requiredReady,
      setup: {
        completedAt: config.setup.completedAt,
        lastRequiredReady: config.setup.lastRequiredReady,
        skippedOptionalAt: config.setup.skippedOptionalAt || null,
        piBinOverride: config.piBinOverride ? redact(config.piBinOverride) : null,
        piBinSource: store.effectivePiBin().source,
      },
      components: { node: clean(node), pi: clean(pi), git: clean(git) },
      items: [clean(node), clean(pi), clean(git)],
      plan,
      install: {
        supported: isWin,
        busy: Boolean(activeJob && ['queued', 'running', 'cancelling'].includes(activeJob.state)),
        job: activeJob,
        lastJob,
        interrupted,
        canInstall: isWin && plan.steps.length > 0 && !(activeJob && ['queued', 'running', 'cancelling'].includes(activeJob.state)),
        requiresAdmin: false,
        scope: 'user',
      },
      notes: [
        pi.locked ? '已检测到 PI_BIN 或手动 Pi 路径，向导不会覆盖它。' : null,
        node.npm.present ? null : 'npm 未找到；安装 Pi 前需要先补齐 Node.js 自带的 npm。',
        isWin ? null : '当前平台只提供检测；自动安装目前仅支持 Windows。',
      ].filter(Boolean),
    };
    reportCache = { at: t, report };
    return report;
  }

  function diagnosticsSummary() {
    const build = (report) => ({
      ready: report.requiredReady,
      firstRun: report.firstRun,
      lastJob: report.install.lastJob ? {
        state: report.install.lastJob.state,
        completedSteps: report.install.lastJob.completedSteps,
        totalSteps: report.install.lastJob.totalSteps,
        errorCode: report.install.lastJob.errorCode,
      } : null,
      components: Object.fromEntries(Object.entries(report.components).map(([id, c]) => [id, {
        kind: c.kind,
        status: c.status,
        version: c.version || null,
        source: c.source || 'none',
      }])),
    });
    if (reportCache) return build(reportCache.report);
    return {
      ready: null,
      firstRun: null,
      lastJob: null,
      components: null,
      note: '环境检测尚未运行；打开设置中的环境检查即可生成脱敏摘要。',
    };
  }

  function invalidate() {
    reportCache = null;
    rpcCache = null;
  }

  return {
    check,
    invalidate,
    diagnosticsSummary,
    probe: probePiRpc,
    setPiBinOverride(value) {
      const result = store.setPiBinOverride(value);
      if (result.ok) invalidate();
      return result;
    },
    effectivePiBinSource() {
      return store.effectivePiBin().source;
    },
    recordSetup(patch) {
      return store.recordSetup(patch);
    },
    setJobProvider(fn) {
      getJob = typeof fn === 'function' ? fn : null;
    },
  };
}
