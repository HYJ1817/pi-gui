/* 首次环境安装的**唯一执行入口**。
 *
 * 一次任务 = 一个 job id + 一个 AbortController + 一个随机临时目录。
 *
 *   queued/running → verifying → succeeded | failed | cancelled
 *
 * ---------- 与另外两件事严格分开 ----------
 *
 * - Pi GUI 自身更新：`server/app-update.js`
 * - 已安装 Pi 的运行时更新：`server/pi-update.js`（`pi update --self`）
 * - 首次环境依赖安装：本模块
 *
 * 三者各有状态机，互不触发。本模块**不做后台轮询**，只在用户明确点击后运行；
 * 已经可用的组件不会被重装；已有 Pi 永远不会被覆盖。
 *
 * ---------- 执行边界 ----------
 *
 * - 命令全部是固定可执行文件 + 固定 args 数组，`shell:false`（PowerShell 解压
 *   也是 `-File <本仓库脚本>`，不是 `-Command` 拼串）。
 * - 下载：HTTPS 主机白名单、逐跳校验、固定 SHA256、大小上限、`wx` 写盘。
 * - 解压：固定脚本，拒绝绝对路径 / `..` / 盘符 / 符号链接 / 超大条目。
 * - 替换：同卷 rename，先备份；失败恢复已有目录。
 * - 取消：AbortSignal → 下载请求 destroy、npm / PowerShell 进程树 kill。
 * - 错误只暴露固定 code 与中文说明，不回传原始 stdout/stderr 或绝对路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from 'node:net';
import { resolveExecutable } from './pi-launch.js';
import {
  PI_PACKAGE, PI_MIN_NODE, NODE_LTS, GIT_MINIGIT, DOWNLOAD_HOSTS,
} from './environment-store.js';
import { findNpmCli } from './environment-setup.js';
import {
  downloadFile, downloadText, sha256File, checksumFor,
  createTempDir, writeExtractScript, windowsPowerShellPath, extractZipSafe,
  swapDirectory, removeTree,
} from './environment-download.js';

const VERSION_RE = /(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?/;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const NPM_ENV_OVERRIDE = /^(?:NPM_CONFIG_|NODE_|SSL_CERT_|OPENSSL_CONF$|ELECTRON_RUN_AS_NODE$|PI_GUI_TOKEN$)/i;
const DESKTOP_APPROVAL_TTL_MS = 30_000;
const LABELS = Object.freeze({ node: 'Node.js', pi: 'Pi', git: 'Git' });

const MESSAGES = Object.freeze({
  'unsupported-platform': '自动安装目前仅支持 Windows。',
  'busy': '已有安装任务正在进行。',
  'stale-plan': '环境在确认期间发生了变化，请重新检查后再安装。',
  'consent-required': '需要先确认安装内容。',
  'native-confirmation-required': '请在 Pi GUI 的原生确认窗口中确认安装。',
  'install-unavailable': '应用正在退出，无法开始安装。',
  'invalid-components': '安装项不合法。',
  'pi-locked': '已经指定了 PI_BIN 或手动 Pi 路径，向导不会覆盖它。',
  'up-to-date': '需要安装的组件已经就绪。',
  'download-failed': '下载失败，请检查网络后重试。',
  'network-error': '下载中断，请检查网络后重试。',
  'http-status': '下载服务器返回了异常状态。',
  'host-not-allowed': '下载地址不在允许的官方域名内。',
  'too-large': '安装包超过允许的大小。',
  'checksum-mismatch': '安装包校验失败，已停止安装。',
  'extract-failed': '安装包解压失败。',
  'extract-input-missing': '解压工具或安装包缺失。',
  'unsafe-target': '安装目录不是普通目录，已停止以避免覆盖。',
  'unsafe-temp': '临时目录不安全，已停止安装。',
  'swap-failed': '无法写入安装目录。',
  'node-unavailable': '没有可用于安装 Pi 的 Node.js。',
  'npm-missing': '没有找到 npm，无法安装 Pi。',
  'install-failed': '安装命令没有成功完成。',
  'install-incomplete': '安装完成后没有找到预期文件。',
  'verify-failed': '安装后验证没有通过。',
  'config-write-failed': '安装状态无法保存，已回滚到安装前的目录。',
  'cancelled': '已取消安装。已完成的组件会保留。',
  'temp-exists': '临时目录冲突，请重试。',
  'read-failed': '无法读取下载的安装包。',
  'write-failed': '无法写入安装文件。',
  'bad-url': '安装地址不合法。',
  'bad-token': '临时目录标识不合法。',
  'bad-redirect': '下载重定向不合法。',
  'too-many-redirects': '下载重定向次数过多。',
  'destination-exists': '解压目标已存在。',
  'staging-missing': '暂存目录缺失。',
  'archive-missing': '下载的安装包不存在。',
  'probe-failed': '无法确认已安装组件的版本。',
  'failed': '安装没有完成。',
});

function messageFor(code) {
  return MESSAGES[code] || MESSAGES.failed;
}

function validComponents(components) {
  return Array.isArray(components) && components.length <= 3
    && new Set(components).size === components.length
    && components.every(id => typeof id === 'string' && Object.hasOwn(LABELS, id));
}

function fail(code) {
  const err = new Error(messageFor(code));
  err.code = code;
  return err;
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const m = VERSION_RE.exec(raw.trim().slice(0, 4096));
  return m ? m[1] : null;
}

function readPackage(packageDir) {
  try {
    const file = path.join(packageDir, 'package.json');
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 256 * 1024) return null;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return pkg && typeof pkg === 'object' ? pkg : null;
  } catch {
    return null;
  }
}

function piEntryFromPackage(packageDir) {
  const pkg = readPackage(packageDir);
  if (!pkg || pkg.name !== PI_PACKAGE) return null;
  const bin = pkg.bin;
  const rel = typeof bin === 'string' ? bin : (bin && typeof bin.pi === 'string' ? bin.pi : null);
  if (!rel) return null;
  const entry = path.resolve(packageDir, rel);
  const prefix = packageDir.endsWith(path.sep) ? packageDir : packageDir + path.sep;
  if (!entry.startsWith(prefix) || !/\.(?:js|mjs|cjs)$/i.test(entry) || !isFile(entry)) return null;
  return { entry, version: parseVersion(pkg.version), name: pkg.name };
}

function makeToken() {
  return crypto.randomBytes(16).toString('hex');
}

function makeJobId(now) {
  return `env-${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function componentLabel(id) {
  return LABELS[id] || id;
}

function runtimeLockIdentity(root) {
  let current = path.resolve(root);
  const missing = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing).toLowerCase();
    } catch (error) {
      const parent = path.dirname(current);
      if (error.code !== 'ENOENT' || parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

// Web and desktop can be separate processes using the same runtime folder.
// Windows excludes a second listener, and releases the name on process exit.
// The pipe carries no messages or operations.
function acquireRuntimeLock(root) {
  if (process.platform !== 'win32') return Promise.resolve(() => {});
  const digest = crypto.createHash('sha256').update(runtimeLockIdentity(root)).digest('hex');
  const address = `\\\\.\\pipe\\pi-gui-environment-${digest}`;
  return new Promise((resolve, reject) => {
    const lock = createServer(socket => socket.destroy());
    lock.on('error', error => {
      if (error.code === 'EADDRINUSE') resolve(null);
      else reject(error);
    });
    lock.listen(address, () => {
      lock.unref();
      resolve(() => new Promise(done => lock.close(done)));
    });
  });
}

/**
 * @param setup        `createEnvironmentSetup()`，用于计划、复检与 RPC 验证
 * @param store        `createEnvironmentStore()`
 * @param piLaunch     `createPiLaunch()`；安装完成后 reset
 * @param piVersion    `createPiVersion()`；安装完成后 reset
 * @param runCli       `server/agents/cli.js` 的 runCli（受控进程执行）
 * @param onEvent      `(jobSnapshot) => void`，由 server.js 推 SSE
 * @param onInstalled  `(jobSnapshot) => void | Promise`，成功装完 Node/Pi 后调用：
 *                     server 用它清 Pi identity 缓存并让 RPC 重新解析入口。
 *                     它抛错不影响安装结论（安装本身已经验证过了）。
 * @param io           下载 / 解压 / 替换原语的替身（只用于离线测试）。生产不传，
 *                     默认全部走 environment-download.js。替换的只是**传输层**，
 *                     状态机、版本验证、组件顺序、取消仍是真实代码。
 */
export function createEnvironmentInstall({
  setup,
  store,
  piLaunch = null,
  piVersion = null,
  runCli,
  onEvent = null,
  onInstalled = null,
  env = process.env,
  isWin = process.platform === 'win32',
  desktop = false,
  canInstall = () => true,
  now = () => Date.now(),
  fsApi = fs,
  io = null,
} = {}) {
  if (!setup || !store || typeof runCli !== 'function') throw new Error('environment install requires setup, store and runCli');
  const wire = {
    downloadFile, downloadText, sha256File, checksumFor,
    createTempDir, writeExtractScript, windowsPowerShellPath, extractZipSafe,
    swapDirectory, removeTree,
    ...(io && typeof io === 'object' ? io : {}),
  };
  let planning = false;
  let disposed = false;
  let approval = null;
  let inFlight = null; // { job, controller, tempDir, scriptFile }
  let last = null;

  function snapshot(job) {
    if (!job) return null;
    return JSON.parse(JSON.stringify(job));
  }

  function publish(job = inFlight && inFlight.job) {
    if (!job || typeof onEvent !== 'function') return;
    try { onEvent(snapshot(job)); } catch { /* 订阅方出错不能中断安装 */ }
  }

  function persist(job) {
    try {
      store.recordJob({
        id: job.id,
        state: job.state,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        completedSteps: job.completedSteps,
        totalSteps: job.totalSteps,
        errorCode: job.errorCode,
      });
    } catch {
      /* 持久化失败不改变本次运行结果 */
    }
  }

  function setPhase(job, phase) {
    job.phase = phase;
    publish();
  }

  function component(job, id) {
    return job.components.find((c) => c.id === id) || null;
  }

  function markComponent(job, id, patch) {
    const comp = component(job, id);
    if (comp) Object.assign(comp, patch);
    publish();
  }

  async function runVersion(exe, args, signal, timeoutMs = 12_000) {
    const res = await runCli({
      entry: { ok: true, cmd: exe, baseArgs: [] },
      args,
      cwd: path.dirname(exe),
      timeoutMs,
      maxStdoutBytes: 4096,
      signal,
    });
    if (!res || !res.ok) return null;
    return parseVersion(`${res.stdout || ''}\n${res.stderr || ''}`);
  }

  async function ensureNodeRuntime(signal) {
    const managedDir = store.managedNodeDir();
    if (managedDir) {
      const exe = path.join(managedDir, isWin ? 'node.exe' : 'bin/node');
      const version = await runVersion(exe, ['--version'], signal);
      if (version) return { exe, version, source: 'managed' };
    }
    // Match setup detection: the launch directory is not a Node source.
    const systemExe = resolveExecutable('node', { env, cwd: null, isWin });
    if (systemExe && path.isAbsolute(systemExe)) {
      const version = await runVersion(systemExe, ['--version'], signal);
      if (version) return { exe: systemExe, version, source: 'system' };
    }
    return null;
  }

  async function installNode(job, comp, internal) {
    const signal = internal.controller.signal;
    const token = internal.token;
    const paths = store.paths();
    const version = NODE_LTS.version;
    const archive = path.join(internal.tempDir, NODE_LTS.archive);
    const extractDir = path.join(internal.tempDir, 'node-extract');
    const target = paths.nodeDir(version);
    const backup = path.join(internal.tempDir, 'node-backup');
    const url = `${NODE_LTS.distBase}/v${version}/${NODE_LTS.archive}`;

    comp.phase = 'downloading';
    comp.progress = { phase: 'downloading', receivedBytes: 0, totalBytes: null, percent: null };
    publish();
    let lastAt = 0;
    await wire.downloadFile({
      url,
      file: archive,
      allowlist: DOWNLOAD_HOSTS,
      fsApi,
      signal,
      onProgress: ({ receivedBytes, totalBytes }) => {
        const t = now();
        comp.progress = {
          phase: 'downloading',
          receivedBytes,
          totalBytes,
          percent: totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : null,
        };
        if (t - lastAt >= 300) {
          lastAt = t;
          publish();
        }
      },
    }).catch((err) => {
      throw fail(err && err.code ? err.code : 'download-failed');
    });

    comp.phase = 'verifying-download';
    comp.progress = null;
    publish();
    const actual = await wire.sha256File(archive, fsApi);
    if (actual.toLowerCase() !== NODE_LTS.sha256.toLowerCase()) throw fail('checksum-mismatch');

    const text = await wire.downloadText({
      url: `${NODE_LTS.distBase}/v${version}/SHASUMS256.txt`,
      allowlist: DOWNLOAD_HOSTS,
      signal,
    });
    const official = wire.checksumFor(NODE_LTS.archive, text);
    if (official !== NODE_LTS.sha256.toLowerCase()) throw fail('checksum-mismatch');

    comp.phase = 'extracting';
    publish();
    await wire.extractZipSafe({
      zipFile: archive,
      destDir: extractDir,
      scriptFile: internal.scriptFile,
      powershell: internal.powershell,
      runCli,
      signal,
      fsApi,
    }).catch((err) => { throw fail(err && err.code ? err.code : 'extract-failed'); });

    const expectedRoot = path.join(extractDir, NODE_LTS.archive.replace(/\.zip$/i, ''));
    let nodeRoot = expectedRoot;
    if (!isFile(path.join(nodeRoot, 'node.exe'))) {
      let names = [];
      try { names = fsApi.readdirSync(extractDir).slice(0, 20); } catch { names = []; }
      nodeRoot = names.map((n) => path.join(extractDir, n)).find((d) => isFile(path.join(d, 'node.exe'))) || null;
    }
    if (!nodeRoot || !isFile(path.join(nodeRoot, 'node.exe'))) throw fail('install-incomplete');

    const extractedVersion = await runVersion(path.join(nodeRoot, 'node.exe'), ['--version'], signal);
    if (!extractedVersion) throw fail('verify-failed');

    comp.phase = 'installing';
    publish();
    const swap = wire.swapDirectory({ staging: nodeRoot, target, backup, fsApi });
    try {
      const finalVersion = await runVersion(path.join(target, 'node.exe'), ['--version'], signal);
      if (!finalVersion) throw fail('verify-failed');
      comp.version = finalVersion;
      /* 目录已经换好但配置写不进去时，下一次启动会找不到这份 Node；
       * 与其留下一个「装好了但用不上」的目录，不如回滚并如实失败。 */
      if (!store.recordManaged({ nodeVersion: version })) throw fail('config-write-failed');
      store.applyManagedPath(process.env);
      swap.commit();
    } catch (err) {
      swap.restore();
      throw err;
    }
    wire.removeTree(extractDir, fsApi);
  }

  async function installPi(job, comp, internal) {
    const signal = internal.controller.signal;
    const node = await ensureNodeRuntime(signal);
    if (!node) throw fail('node-unavailable');
    const npmCli = findNpmCli(node.exe, fsApi, isWin);
    if (!npmCli) throw fail('npm-missing');

    const paths = store.paths();
    const staging = path.join(internal.tempDir, 'pi-prefix');
    fsApi.mkdirSync(staging, { mode: 0o700 });
    const backup = path.join(internal.tempDir, 'pi-backup');
    const target = paths.piPrefix;

    comp.phase = 'installing';
    comp.progress = { phase: 'installing', receivedBytes: null, totalBytes: null, percent: null };
    publish();
    // npm rejects loading one config file into both its user and global slots.
    const userConfig = path.join(internal.tempDir, 'user.npmrc');
    const globalConfig = path.join(internal.tempDir, 'global.npmrc');
    for (const file of [userConfig, globalConfig]) {
      fsApi.writeFileSync(file, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
    // Strip all npm config overrides and Node startup/TLS options. Windows
    // resolves environment keys case-insensitively, including uppercase aliases.
    const sanitized = Object.fromEntries(Object.entries(env).filter(([key]) => !NPM_ENV_OVERRIDE.test(key)));
    const npmEnv = {
      ...sanitized,
      npm_config_cache: path.join(internal.tempDir, 'npm-cache'),
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      npm_config_ignore_scripts: 'true',
      npm_config_strict_ssl: 'true',
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
    };
    const res = await runCli({
      entry: { ok: true, cmd: node.exe, baseArgs: [] },
      args: [
        npmCli, 'install', '--global', '--ignore-scripts', '--no-audit', '--no-fund',
        '--no-update-notifier', '--strict-ssl=true', '--registry', 'https://registry.npmjs.org/',
        '--userconfig', userConfig, '--globalconfig', globalConfig,
        '--loglevel=error', '--prefix', staging, `${PI_PACKAGE}@latest`,
      ],
      cwd: internal.tempDir,
      env: npmEnv,
      inheritEnv: false,
      timeoutMs: INSTALL_TIMEOUT_MS,
      maxStdoutBytes: 8192,
      signal,
    });
    if (!res || !res.ok) throw fail(signal && signal.aborted ? 'cancelled' : 'install-failed');

    comp.phase = 'verifying';
    publish();
    const packageDir = path.join(staging, 'node_modules', ...PI_PACKAGE.split('/'));
    const info = piEntryFromPackage(packageDir);
    if (!info || !info.version) throw fail('install-incomplete');
    const packageVersion = await runVersion(node.exe, [info.entry, '--version'], signal);
    if (!packageVersion) throw fail('verify-failed');
    const binFile = path.join(staging, isWin ? 'pi.cmd' : 'pi');
    if (!isFile(binFile)) throw fail('install-incomplete');

    comp.phase = 'installing';
    publish();
    const swap = wire.swapDirectory({ staging, target, backup, fsApi });
    try {
      /* 位置换了之后**再验一次**：staging 里能跑不等于最终目录能跑。
       * 这里失败就恢复旧目录，绝不留下一个「看起来装好了」的半成品。 */
      const finalPackageDir = path.join(target, 'node_modules', ...PI_PACKAGE.split('/'));
      const finalInfo = piEntryFromPackage(finalPackageDir);
      if (!finalInfo || !isFile(path.join(target, isWin ? 'pi.cmd' : 'pi'))) throw fail('install-incomplete');
      const finalVersion = await runVersion(node.exe, [finalInfo.entry, '--version'], signal);
      if (!finalVersion) throw fail('verify-failed');
      if (!store.recordManaged({ piVersion: finalVersion })) throw fail('config-write-failed');
      if (piLaunch && typeof piLaunch.reset === 'function') piLaunch.reset();
      if (piVersion && typeof piVersion.reset === 'function') piVersion.reset();
      setup.invalidate();
      swap.commit();
      comp.version = finalVersion;
    } catch (err) {
      swap.restore();
      throw err;
    }
  }

  async function installGit(job, comp, internal) {
    const signal = internal.controller.signal;
    const paths = store.paths();
    const version = GIT_MINIGIT.version;
    const archive = path.join(internal.tempDir, GIT_MINIGIT.archive);
    const extractDir = path.join(internal.tempDir, 'git-extract');
    const target = paths.gitDir(version);
    const backup = path.join(internal.tempDir, 'git-backup');

    comp.phase = 'downloading';
    comp.progress = { phase: 'downloading', receivedBytes: 0, totalBytes: null, percent: null };
    publish();
    let lastAt = 0;
    await wire.downloadFile({
      url: GIT_MINIGIT.url,
      file: archive,
      allowlist: DOWNLOAD_HOSTS,
      fsApi,
      signal,
      onProgress: ({ receivedBytes, totalBytes }) => {
        const t = now();
        comp.progress = {
          phase: 'downloading',
          receivedBytes,
          totalBytes,
          percent: totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : null,
        };
        if (t - lastAt >= 300) { lastAt = t; publish(); }
      },
    }).catch((err) => { throw fail(err && err.code ? err.code : 'download-failed'); });

    comp.phase = 'verifying-download';
    comp.progress = null;
    publish();
    const actual = await wire.sha256File(archive, fsApi);
    if (actual.toLowerCase() !== GIT_MINIGIT.sha256.toLowerCase()) throw fail('checksum-mismatch');

    comp.phase = 'extracting';
    publish();
    await wire.extractZipSafe({
      zipFile: archive,
      destDir: extractDir,
      scriptFile: internal.scriptFile,
      powershell: internal.powershell,
      runCli,
      signal,
      fsApi,
    }).catch((err) => { throw fail(err && err.code ? err.code : 'extract-failed'); });

    const gitExe = path.join(extractDir, 'cmd', 'git.exe');
    if (!isFile(gitExe)) throw fail('install-incomplete');
    const extractedVersion = await runVersion(gitExe, ['--version'], signal);
    if (!extractedVersion) throw fail('verify-failed');

    comp.phase = 'installing';
    publish();
    const swap = wire.swapDirectory({ staging: extractDir, target, backup, fsApi });
    try {
      const finalExe = paths.gitBin(version);
      const finalVersion = await runVersion(finalExe, ['--version'], signal);
      if (!finalVersion) throw fail('verify-failed');
      comp.version = finalVersion;
      if (!store.recordManaged({ gitVersion: version })) throw fail('config-write-failed');
      store.applyManagedPath(process.env);
      swap.commit();
    } catch (err) {
      swap.restore();
      throw err;
    }
  }

  async function runJob(internal) {
    const { job, controller } = internal;
    const signal = controller.signal;
    job.state = 'running';
    persist(job);
    setPhase(job, 'preparing');

    try {
      for (const id of job.order) {
        if (signal.aborted) throw fail('cancelled');
        job.current = id;
        const comp = component(job, id);
        comp.status = 'running';
        comp.phase = 'preparing';
        publish();
        try {
          if (id === 'node') await installNode(job, comp, internal);
          else if (id === 'pi') await installPi(job, comp, internal);
          else if (id === 'git') await installGit(job, comp, internal);
          else throw fail('invalid-components');
          if (signal.aborted) throw fail('cancelled');
          comp.status = 'done';
          comp.phase = 'done';
          comp.progress = null;
          job.completedSteps += 1;
          publish();
        } catch (err) {
          const code = err && err.code ? err.code : 'failed';
          comp.status = 'failed';
          comp.phase = 'failed';
          comp.errorCode = code;
          comp.error = messageFor(code);
          if (id === 'git' && !signal.aborted) {
            job.warnings.push('git-install-failed');
            publish();
            continue; // 推荐依赖失败不推翻已经成功的必需组件
          }
          throw err;
        }
      }

      if (signal.aborted) throw fail('cancelled');
      job.current = null;
      job.state = 'verifying';
      setPhase(job, 'verifying');
      const report = await setup.check({ force: true });
      /* 复检本身可能跑十几秒（RPC 握手）。用户在这段时间点了取消，
       * 不能因为复检恰好通过就把任务改回 succeeded。 */
      if (signal.aborted) throw fail('cancelled');
      job.result = {
        requiredReady: report.requiredReady,
        components: Object.fromEntries(['node', 'pi', 'git'].map((id) => [id, {
          status: report.components[id].status,
          version: report.components[id].version || null,
        }])),
        warnings: job.warnings.slice(),
      };
      if (!report.requiredReady) throw fail('verify-failed');
      job.state = 'succeeded';
      job.phase = 'done';
      job.errorCode = null;
      job.error = null;
      /* 让长驻进程（RPC 桥、identity 缓存）看见新装的东西。失败只意味着
       * 「下次重启后才生效」，不推翻已经验证通过的安装结论。 */
      if (job.order.some((id) => id === 'node' || id === 'pi') && typeof onInstalled === 'function') {
        try { await onInstalled(snapshot(job)); } catch { /* 不改变安装结论 */ }
      }
    } catch (err) {
      const code = signal.aborted || (err && err.code === 'cancelled') ? 'cancelled' : (err && err.code ? err.code : 'failed');
      if (job.current) {
        const comp = component(job, job.current);
        if (comp && comp.status !== 'done') {
          comp.status = 'failed';
          comp.phase = 'failed';
          comp.errorCode = code;
          comp.error = messageFor(code);
        }
      }
      job.state = code === 'cancelled' ? 'cancelled' : 'failed';
      job.phase = code === 'cancelled' ? 'cancelled' : 'failed';
      job.errorCode = code;
      job.error = messageFor(code);
    } finally {
      job.current = null;
      job.finishedAt = new Date(now()).toISOString();
      try {
        if (internal.scriptFile) fsApi.rmSync(internal.scriptFile, { force: true });
        if (internal.tempDir) wire.removeTree(internal.tempDir, fsApi);
      } catch {
        /* 临时目录清理失败不是安装结论 */
      }
      persist(job);
      await internal.releaseLock();
      inFlight = null;
      last = job;
      publish(job);
    }
  }

  function nativeConfirmationRequired() {
    return { ok: false, status: 403, code: 'native-confirmation-required', error: messageFor('native-confirmation-required') };
  }

  // Only the Electron parent channel calls this. The ticket never crosses into
  // a renderer or an HTTP response, and every redemption consumes it first.
  function approveDesktop({ planId, components }) {
    if (!desktop) return nativeConfirmationRequired();
    if (!/^plan-[a-f0-9]{20}$/.test(typeof planId === 'string' ? planId : '')
      || !validComponents(components) || components.length === 0) return nativeConfirmationRequired();
    approval = { ticket: makeToken(), planId, components: [...components].sort(), expiresAt: now() + DESKTOP_APPROVAL_TTL_MS };
    return { ok: true, ticket: approval.ticket };
  }

  function startDesktop({ ticket, planId, components }) {
    if (!desktop || !approval || ticket !== approval.ticket) return nativeConfirmationRequired();
    const confirmed = approval;
    approval = null;
    if (now() >= confirmed.expiresAt || planId !== confirmed.planId || !validComponents(components)
      || confirmed.components.length !== components.length
      || [...components].sort().some((id, index) => id !== confirmed.components[index])) return nativeConfirmationRequired();
    return startJob({ planId, components }, confirmed.expiresAt);
  }

  function start({ planId, components, consent } = {}) {
    if (desktop) return nativeConfirmationRequired();
    if (consent !== true) return { ok: false, status: 400, code: 'consent-required', error: messageFor('consent-required') };
    return startJob({ planId, components });
  }

  async function startJob({ planId, components }, expiresAt = Infinity) {
    if (disposed || !canInstall()) return { ok: false, status: 503, code: 'install-unavailable', error: messageFor('install-unavailable') };
    if (!isWin) return { ok: false, status: 409, code: 'unsupported-platform', error: messageFor('unsupported-platform') };
    if (inFlight || planning) return { ok: false, status: 409, code: 'busy', error: messageFor('busy'), job: snapshot(inFlight && inFlight.job) };
    if (!validComponents(components)) {
      return { ok: false, status: 400, code: 'invalid-components', error: messageFor('invalid-components') };
    }
    const requested = [...components];

    let releaseLock;
    planning = true;
    try {
      try { releaseLock = await acquireRuntimeLock(store.paths().root); }
      catch {
        return { ok: false, status: 503, code: 'install-unavailable', error: messageFor('install-unavailable') };
      }
      if (!releaseLock) return { ok: false, status: 409, code: 'busy', error: messageFor('busy') };
      const report = await setup.check({ force: true });
      if (disposed || !canInstall()) return { ok: false, status: 503, code: 'install-unavailable', error: messageFor('install-unavailable') };
      if (now() >= expiresAt) return nativeConfirmationRequired();
      if (!planId || planId !== report.plan.planId) {
        return { ok: false, status: 409, code: 'stale-plan', error: messageFor('stale-plan'), report };
      }
      if (report.components.pi.locked && requested.includes('pi')) {
        return { ok: false, status: 409, code: 'pi-locked', error: messageFor('pi-locked'), report };
      }
      const required = report.plan.steps.filter((id) => id !== 'git');
      const missingRequired = required.filter((id) => !requested.includes(id));
      if (missingRequired.length) {
        return { ok: false, status: 400, code: 'invalid-components', error: messageFor('invalid-components'), report };
      }
      const allowed = new Set(report.plan.steps);
      if (requested.some((id) => !allowed.has(id))) {
        return { ok: false, status: 409, code: 'stale-plan', error: messageFor('stale-plan'), report };
      }
      if (!requested.length) {
        return { ok: false, status: 409, code: 'up-to-date', error: messageFor('up-to-date'), report };
      }

      const order = ['node', 'pi', 'git'].filter((id) => requested.includes(id));
      const startedAt = new Date(now()).toISOString();
      const job = {
        id: makeJobId(now()),
        state: 'running',
        phase: 'preparing',
        current: null,
        startedAt,
        finishedAt: null,
        completedSteps: 0,
        totalSteps: order.length,
        /* 执行顺序是任务的一部分：runJob 只认这一份，别在别处再排一次。 */
        order,
        requiresAdmin: false,
        scope: 'user',
        components: order.map((id) => ({
          id,
          label: componentLabel(id),
          kind: id === 'git' ? 'recommended' : 'required',
          status: 'pending',
          phase: 'pending',
          version: null,
          progress: null,
          errorCode: null,
          error: null,
        })),
        warnings: [],
        errorCode: null,
        error: null,
        result: null,
      };
      const token = makeToken();
      const powershell = wire.windowsPowerShellPath(env, fsApi);
      if (!powershell) return { ok: false, status: 500, code: 'extract-input-missing', error: messageFor('extract-input-missing') };
      const tempDir = wire.createTempDir(store.paths().root, token, fsApi);
      let scriptFile;
      try { scriptFile = wire.writeExtractScript(store.paths().root, token, fsApi); }
      finally { if (!scriptFile) wire.removeTree(tempDir, fsApi); }
      if (!scriptFile) {
        return { ok: false, status: 500, code: 'extract-input-missing', error: messageFor('extract-input-missing') };
      }
      const internal = {
        job,
        token,
        tempDir,
        scriptFile,
        powershell,
        releaseLock,
        controller: new AbortController(),
      };
      releaseLock = null;
      inFlight = internal;
      persist(job);
      publish();
      internal.completion = new Promise(resolve => {
        setImmediate(async () => {
          try {
            await runJob(internal);
          } catch {
            if (inFlight === internal) {
              inFlight = null;
              last = job;
            }
          } finally {
            resolve();
          }
        });
      });
      return { ok: true, status: 202, job: snapshot(job) };
    } finally {
      await releaseLock?.();
      planning = false;
    }
  }

  function cancel(jobId) {
    if (!inFlight || (jobId && inFlight.job.id !== jobId)) {
      return { ok: false, status: 404, code: 'not-found', error: '安装任务不存在。' };
    }
    const job = inFlight.job;
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return { ok: true, job: snapshot(job) };
    if (!inFlight.controller.signal.aborted) {
      inFlight.controller.abort();
      job.state = 'cancelling';
      job.phase = 'cancelling';
      publish();
    }
    return { ok: true, job: snapshot(job) };
  }

  function currentJob() {
    return snapshot(inFlight ? inFlight.job : last);
  }

  function getJob(jobId) {
    const job = inFlight ? inFlight.job : last;
    if (!job) return null;
    if (jobId && job.id !== jobId) return null;
    return snapshot(job);
  }

  async function dispose() {
    disposed = true;
    const internal = inFlight;
    if (!internal) return;
    internal.controller.abort();
    await internal.completion;
  }

  return { start, approveDesktop, startDesktop, cancel, currentJob, getJob, dispose, busy: () => planning || Boolean(inFlight) };
}
