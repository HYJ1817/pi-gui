/* 首次环境安装的**持久事实**与受控路径。
 *
 * 这里只回答四件事：
 *   1. 用户自己的 Pi 路径覆盖（`PI_BIN` 环境变量永远优先，本文件不碰它）；
 *   2. Pi GUI 自己装到用户目录里的 Node / Pi / Git 是哪个版本；
 *   3. 环境向导完成到哪一步、上一次安装任务是不是被进程退出打断；
 *   4. 安装根目录在哪里、哪些路径能安全地进 PATH。
 *
 * **不是第二份检测结果。** 检测报告每次都从真实文件系统与进程重新求值；
 * 这里只存「我们装过什么」和「用户选过什么」。把检测结论也缓存进来的话，
 * 用户手动卸载 Node 之后界面还会说「已就绪」，那是两份真相。
 *
 * 路径隐私：`redactPath()` 是唯一给 renderer / 诊断看的路径投影。原始绝对路径
 * 只在本模块与安装执行层内部使用，不进入 HTTP 响应。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 官方 Pi 包名。与 pi-launch / pi-update / capability-install 同一个常量语义。 */
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/** Pi 官方当前最低 Node 版本（npm `engines.node`，核对日期 2026-11-15）。 */
export const PI_MIN_NODE = '22.19.0';

/* ---------- 固定的官方下载目标 ----------
 *
 * 版本与摘要都**钉死**。安装时仍然会从官方源重新读一次 SHASUMS256.txt
 * （Node），两边的摘要必须同时匹配；Git MinGit 没有独立校验文件，摘要取自
 * GitHub Release asset 的 `digest` 字段（sha256），也在这里钉死。
 *
 * 升级版本只能改这一处，并同时更新 docs/environment-setup.md 与测试。
 * 不接受 renderer / 环境变量传入版本号或 URL。
 */
export const NODE_LTS = Object.freeze({
  version: '24.22.3',
  lts: 'Krypton',
  archive: 'node-v24.22.3-win-x64.zip',
  sha256: 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
  distBase: 'https://nodejs.org/dist',
});

export const GIT_MINIGIT = Object.freeze({
  version: '2.56.1',
  archive: 'MinGit-2.56.1-64-bit.zip',
  sha256: '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd',
  url: 'https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/MinGit-2.56.1-64-bit.zip',
});

/** 下载只允许这些主机（重定向逐跳校验，见 environment-install.js）。 */
export const DOWNLOAD_HOSTS = Object.freeze([
  'nodejs.org',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

const CONFIG_VERSION = 1;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_OVERRIDE_CHARS = 1024;

function isVersionText(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isFile(fsApi, file) {
  try {
    return fsApi.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDir(fsApi, dir) {
  try {
    return fsApi.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 手动路径的字符白名单。pi-launch 在 Windows 上会把 bin 拼进一条 cmd 命令串，
 *  所以这里不是「好看」而是安全边界：引号、百分号展开、命令分隔符一律拒绝。 */
const BAD_PATH_CHARS = /["'`%!&|<>^\r\n\0]/;

export function validatePiBinOverride(value, { fsApi = fs, isWin = process.platform === 'win32' } = {}) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, code: 'bad-path', error: 'Pi 路径必须是字符串' };
  const text = value.trim();
  if (!text || text.length > MAX_OVERRIDE_CHARS) return { ok: false, code: 'bad-path', error: 'Pi 路径长度不合法' };
  if (BAD_PATH_CHARS.test(text)) return { ok: false, code: 'bad-path', error: 'Pi 路径包含不允许的字符' };
  if (!path.isAbsolute(text)) return { ok: false, code: 'bad-path', error: '请填写 Pi 可执行文件的完整路径' };
  if (isWin && !/^pi(?:\.cmd|\.exe|\.bat)$/i.test(path.basename(text))) {
    return { ok: false, code: 'bad-entry', error: '请选择 pi.cmd、pi.exe 或 pi.bat' };
  }
  if (!isFile(fsApi, text)) return { ok: false, code: 'missing-entry', error: '这个路径下没有可执行文件' };
  return { ok: true, value: text };
}

/** 默认配置形状。读不到 / 坏了都回到这里，不抛。 */
function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    setup: { completedAt: null, lastRequiredReady: null, skippedOptionalAt: null },
    piBinOverride: null,
    managed: { nodeVersion: null, gitVersion: null, piVersion: null },
    lastJob: null,
  };
}

function normalizeConfig(raw) {
  const out = defaultConfig();
  if (!raw || typeof raw !== 'object') return out;
  const setup = raw.setup && typeof raw.setup === 'object' ? raw.setup : {};
  out.setup.completedAt = typeof setup.completedAt === 'string' ? setup.completedAt : null;
  out.setup.lastRequiredReady = typeof setup.lastRequiredReady === 'boolean' ? setup.lastRequiredReady : null;
  out.setup.skippedOptionalAt = typeof setup.skippedOptionalAt === 'string' ? setup.skippedOptionalAt : null;
  out.piBinOverride = typeof raw.piBinOverride === 'string' && raw.piBinOverride ? raw.piBinOverride : null;
  const managed = raw.managed && typeof raw.managed === 'object' ? raw.managed : {};
  out.managed.nodeVersion = isVersionText(managed.nodeVersion) ? managed.nodeVersion : null;
  out.managed.gitVersion = isVersionText(managed.gitVersion) ? managed.gitVersion : null;
  out.managed.piVersion = isVersionText(managed.piVersion) ? managed.piVersion : null;
  if (raw.lastJob && typeof raw.lastJob === 'object') {
    out.lastJob = {
      id: typeof raw.lastJob.id === 'string' ? raw.lastJob.id : null,
      state: typeof raw.lastJob.state === 'string' ? raw.lastJob.state : null,
      startedAt: typeof raw.lastJob.startedAt === 'string' ? raw.lastJob.startedAt : null,
      finishedAt: typeof raw.lastJob.finishedAt === 'string' ? raw.lastJob.finishedAt : null,
      completedSteps: Number.isInteger(raw.lastJob.completedSteps) ? raw.lastJob.completedSteps : null,
      totalSteps: Number.isInteger(raw.lastJob.totalSteps) ? raw.lastJob.totalSteps : null,
      errorCode: typeof raw.lastJob.errorCode === 'string' ? raw.lastJob.errorCode : null,
    };
  }
  return out;
}

/**
 * @param dataDir         Pi GUI 数据目录（不用于安装大文件时也作为最后的回退）
 * @param env             环境变量来源（LOCALAPPDATA / PI_GUI_RUNTIME_DIR）
 * @param runtimeDirOverride 显式安装根（测试 / 本机隔离试用）
 */
export function createEnvironmentStore({
  dataDir,
  env = process.env,
  fsApi = fs,
  now = () => Date.now(),
  runtimeDirOverride = null,
} = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('environment store requires dataDir');
  const configFile = path.join(dataDir, 'environment.json');

  const localAppData = normalizeText(env.LOCALAPPDATA);
  const runtimeRoot = (() => {
    if (runtimeDirOverride && path.isAbsolute(runtimeDirOverride)) return path.resolve(runtimeDirOverride);
    if (normalizeText(env.PI_GUI_RUNTIME_DIR) && path.isAbsolute(env.PI_GUI_RUNTIME_DIR)) return path.resolve(env.PI_GUI_RUNTIME_DIR);
    if (localAppData && path.isAbsolute(localAppData)) return path.join(localAppData, 'pi-gui', 'runtime');
    return path.join(dataDir, 'runtime');
  })();

  const isWin = process.platform === 'win32';

  function read() {
    try {
      const stat = fsApi.statSync(configFile);
      if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return defaultConfig();
      const raw = JSON.parse(fsApi.readFileSync(configFile, 'utf8').replace(/^﻿/, ''));
      return normalizeConfig(raw);
    } catch {
      return defaultConfig();
    }
  }

  function write(next) {
    const normalized = normalizeConfig(next);
    try {
      fsApi.mkdirSync(dataDir, { recursive: true });
      const temp = path.join(dataDir, `.environment-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
      fsApi.writeFileSync(temp, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fsApi.renameSync(temp, configFile);
      return true;
    } catch {
      try {
        for (const name of fsApi.readdirSync(dataDir)) {
          if (name.startsWith('.environment-') && name.endsWith('.tmp')) fsApi.rmSync(path.join(dataDir, name), { force: true });
        }
      } catch {
        /* 清理失败不影响「没写成」这个结论 */
      }
      return false;
    }
  }

  function patch(mutator) {
    const next = read();
    try {
      mutator(next);
    } catch {
      return false;
    }
    return write(next);
  }

  function paths() {
    return {
      root: runtimeRoot,
      nodeDir: (version) => path.join(runtimeRoot, `node-v${version}-win-x64`),
      piPrefix: path.join(runtimeRoot, 'pi'),
      piStaging: (token) => path.join(runtimeRoot, `pi-staging-${token}`),
      piBin: path.join(runtimeRoot, 'pi', isWin ? 'pi.cmd' : 'pi'),
      gitDir: (version) => path.join(runtimeRoot, `git-${version}`),
      gitPathDir: (version) => path.join(runtimeRoot, `git-${version}`, isWin ? 'cmd' : 'bin'),
      gitBin: (version) => path.join(runtimeRoot, `git-${version}`, isWin ? 'cmd' : 'bin', isWin ? 'git.exe' : 'git'),
      tmp: (token) => path.join(runtimeRoot, '.tmp', token),
    };
  }

  function managedNodeDir() {
    const cfg = read();
    if (!cfg.managed.nodeVersion) return null;
    const dir = paths().nodeDir(cfg.managed.nodeVersion);
    return isDir(fsApi, dir) && isFile(fsApi, path.join(dir, 'node.exe')) ? dir : null;
  }

  function managedGitBin() {
    const cfg = read();
    if (!cfg.managed.gitVersion) return null;
    const bin = paths().gitBin(cfg.managed.gitVersion);
    return isFile(fsApi, bin) ? bin : null;
  }

  function managedPiBin() {
    const bin = paths().piBin;
    return isFile(fsApi, bin) ? bin : null;
  }

  /**
   * 实际要交给 `pi-launch` 的命令。
   * 优先级：`PI_BIN` 环境变量 > 用户在设置里指定的路径 > Pi GUI 自己装的 Pi > `pi`。
   * 环境变量是用户已有配置，**永不覆盖、永不忽略**。
   */
  function effectivePiBin({ envPiBin = env.PI_BIN } = {}) {
    if (typeof envPiBin === 'string' && envPiBin.trim()) return { bin: envPiBin.trim(), source: 'env', locked: true };
    const cfg = read();
    if (cfg.piBinOverride) return { bin: cfg.piBinOverride, source: 'override', locked: true };
    const managed = managedPiBin();
    if (managed) return { bin: managed, source: 'managed', locked: false };
    return { bin: 'pi', source: 'path', locked: false };
  }

  /**
   * 把 Pi GUI 自己的 Node / Git 放到**本进程** PATH 前面。
   *
   * 只改 `process.env`，不写注册表、不改用户环境变量、不碰系统 PATH。
   * 已经存在同一条时移到前面而不是重复添加；清理旧条目只能靠进程重启。
   */
  function applyManagedPath(targetEnv = process.env) {
    const dirs = [];
    const nodeDir = managedNodeDir();
    if (nodeDir) dirs.push(nodeDir);
    const cfg = read();
    if (cfg.managed.gitVersion) {
      const gitDir = paths().gitPathDir(cfg.managed.gitVersion);
      if (isFile(fsApi, paths().gitBin(cfg.managed.gitVersion))) dirs.push(gitDir);
    }
    if (!dirs.length || !targetEnv) return { changed: false, count: 0 };
    const key = Object.keys(targetEnv).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    const current = typeof targetEnv[key] === 'string' ? targetEnv[key] : '';
    const parts = current.split(path.delimiter).filter(Boolean);
    const wanted = dirs.map((d) => (isWin ? d.toLowerCase() : d));
    const kept = parts.filter((p) => !wanted.includes(isWin ? p.toLowerCase() : p));
    const next = [...dirs, ...kept].join(path.delimiter);
    if (next === current) return { changed: false, count: dirs.length };
    targetEnv[key] = next;
    return { changed: true, count: dirs.length };
  }

  /**
   * 路径投影：给 renderer / 诊断看的唯一形式。
   * 已知根替换成占位符；仍然无法归档的绝对路径只留 basename，绝不原样出去。
   */
  function redactPath(value) {
    if (typeof value !== 'string' || !value) return null;
    const text = path.normalize(value);
    const roots = [
      [runtimeRoot, '%LOCALAPPDATA%\\pi-gui\\runtime'],
      [localAppData, '%LOCALAPPDATA%'],
      [normalizeText(env.APPDATA), '%APPDATA%'],
      [normalizeText(env.ProgramFiles), '%ProgramFiles%'],
      [normalizeText(env['ProgramFiles(x86)']), '%ProgramFiles(x86)%'],
      [normalizeText(env.ProgramData), '%ProgramData%'],
      [os.homedir(), '~'],
      [dataDir, '<data-dir>'],
    ].filter(([root]) => typeof root === 'string' && root);
    const cmp = (a) => (isWin ? a.toLowerCase() : a);
    let out = text;
    for (const [root, label] of roots) {
      const normalizedRoot = path.normalize(root);
      if (cmp(out) === cmp(normalizedRoot)) return label;
      if (cmp(out).startsWith(cmp(normalizedRoot) + path.sep.toLowerCase())) {
        out = label + out.slice(normalizedRoot.length);
        break;
      }
    }
    if (path.isAbsolute(out)) return `…${path.sep}${path.basename(out)}`;
    return out.length > 240 ? '…' + out.slice(-239) : out;
  }

  function setPiBinOverride(value) {
    const checked = validatePiBinOverride(value, { fsApi, isWin });
    if (!checked.ok) return checked;
    const ok = patch((cfg) => {
      cfg.piBinOverride = checked.value;
    });
    return ok ? { ok: true, value: checked.value } : { ok: false, code: 'config-write-failed', error: '环境配置无法写入' };
  }

  function recordManaged({ nodeVersion, gitVersion, piVersion }) {
    return patch((cfg) => {
      if (nodeVersion !== undefined) cfg.managed.nodeVersion = isVersionText(nodeVersion) ? nodeVersion : null;
      if (gitVersion !== undefined) cfg.managed.gitVersion = isVersionText(gitVersion) ? gitVersion : null;
      if (piVersion !== undefined) cfg.managed.piVersion = isVersionText(piVersion) ? piVersion : null;
    });
  }

  function recordSetup({ completedAt, lastRequiredReady, skippedOptionalAt }) {
    return patch((cfg) => {
      if (completedAt !== undefined) cfg.setup.completedAt = typeof completedAt === 'string' ? completedAt : null;
      if (lastRequiredReady !== undefined) cfg.setup.lastRequiredReady = Boolean(lastRequiredReady);
      if (skippedOptionalAt !== undefined) cfg.setup.skippedOptionalAt = typeof skippedOptionalAt === 'string' ? skippedOptionalAt : null;
    });
  }

  function recordJob(job) {
    if (!job || typeof job !== 'object') return false;
    return patch((cfg) => {
      cfg.lastJob = {
        id: typeof job.id === 'string' ? job.id : null,
        state: typeof job.state === 'string' ? job.state : null,
        startedAt: typeof job.startedAt === 'string' ? job.startedAt : null,
        finishedAt: typeof job.finishedAt === 'string' ? job.finishedAt : null,
        completedSteps: Number.isInteger(job.completedSteps) ? job.completedSteps : null,
        totalSteps: Number.isInteger(job.totalSteps) ? job.totalSteps : null,
        errorCode: typeof job.errorCode === 'string' ? job.errorCode : null,
      };
    });
  }

  /** 后端进程退出时还在跑的任务，下次启动只能如实标成「已中断」，不能假装完成。 */
  function markInterruptedJob() {
    const cfg = read();
    if (!cfg.lastJob || cfg.lastJob.state !== 'running') return false;
    return patch((next) => {
      if (next.lastJob && next.lastJob.state === 'running') {
        next.lastJob.state = 'interrupted';
        next.lastJob.finishedAt = new Date(now()).toISOString();
        next.lastJob.errorCode = 'process-exit';
      }
    });
  }

  markInterruptedJob();

  return {
    configFile,
    paths,
    read,
    write,
    patch,
    effectivePiBin,
    managedNodeDir,
    managedGitBin,
    managedPiBin,
    applyManagedPath,
    redactPath,
    setPiBinOverride,
    recordManaged,
    recordSetup,
    recordJob,
    markInterruptedJob,
  };
}
