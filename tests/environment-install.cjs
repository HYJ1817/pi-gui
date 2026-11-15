/* 首次环境安装（server/environment-install.js）的离线状态机测试。
 *
 * 这里**不下载任何东西、不执行 npm、不碰真实 Node/Pi/Git**：
 *   - 传输层（下载 / 校验 / 解压 / PowerShell）用注入的 `io` 替身；
 *   - 子进程用注入的 `runCli` 替身，模拟 `node --version` / npm 安装 / pi --version；
 *   - 安装根、配置、备份都是 `os.tmpdir()` 里的临时目录。
 *
 * 因此被测试的是**真实代码**：组件顺序、阶段推进、版本验证、目录替换与回滚、
 * SSE 快照、取消信号、临时目录清理 —— 只有「从网上下载」和「跑 npm」被换掉。
 *
 * 覆盖：
 *   - 先 Node 后 Pi，Git 最后；全部完成后 verifying → succeeded
 *   - 已装好的组件不会被"重装"（plan 里没有它就不在 order 里）
 *   - 开始前的授权/计划/组件/平台校验
 *   - 取消：状态 cancelling → cancelled，临时目录清掉，进程收到 abort
 *   - 验证失败（setup 复检不 ready）→ failed，不假报成功
 *   - 安装后钩子抛错不影响已完成的结果
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-env-install-'));
const ORIGINAL_PATH = process.env.PATH;
const WINDOWS = process.platform === 'win32';
/* 受管目录布局按宿主平台取 `pi.cmd` / `pi`、`cmd/git.exe` / `bin/git`；
 * 自动安装本身也只支持 Windows。非 Windows 宿主上「真正跑任务」的用例
 * 明确跳过，而校验类用例（不写盘）照样运行。 */
let STORE_MOD = null;
let createEnvironmentInstall = null;
let createEnvironmentRoutes = null;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL ' + name + '  → ' + (err && err.message ? err.message : err));
  }
}
function section(title) { console.log('\n--- ' + title + ' ---'); }

function checkWin(name, fn) {
  if (!WINDOWS) {
    console.log('  skip ' + name + '  (Windows only)');
    return Promise.resolve();
  }
  return check(name, fn);
}

function write(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function ok(stdout = '') { return { ok: true, stdout, stderr: '' }; }

const PLAN_ID = 'plan-' + 'a'.repeat(20);

function planReport(steps, { locked = false } = {}) {
  return {
    requiredReady: false,
    plan: { planId: PLAN_ID, steps },
    components: { pi: { locked } },
  };
}

function readyReport() {
  return {
    requiredReady: true,
    plan: { planId: PLAN_ID, steps: [] },
    components: {
      node: { status: 'ready', version: '24.22.3' },
      pi: { status: 'ready', version: '1.5.2' },
      git: { status: 'ready', version: '2.56.1' },
    },
  };
}

function makeHarness({
  steps = ['node', 'pi', 'git'],
  locked = false,
  verifyReady = true,
  blockingDownload = false,
  verifyGate = null,
  onInstalled = null,
  badChecksum = false,
  missingOfficialChecksum = false,
  desktop = false,
  now = () => 1_700_000_000_000,
  runtimeDirOverride = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, 'run-'));
  const dataDir = path.join(root, 'data');
  const runtimeDir = runtimeDirOverride ?? path.join(root, 'runtime');
  const env = {
    PATH: path.join(root, 'empty-path'),
    LOCALAPPDATA: path.join(root, 'localappdata'),
    SystemRoot: path.join(root, 'windows'),
    /* 这些环境变量不得改写 npm 安装的 TLS / 启动参数 / 前缀。 */
    NODE_OPTIONS: '--require evil.js',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    NODE_EXTRA_CA_CERTS: path.join(root, 'evil-ca.pem'),
    NODE_V8_COVERAGE: path.join(root, 'ambient-coverage'),
    SSL_CERT_FILE: path.join(root, 'ambient-ca.pem'),
    NPM_CONFIG_STRICT_SSL: 'false',
    NPM_CONFIG_IGNORE_SCRIPTS: 'false',
    npm_config_cafile: path.join(root, 'evil-ca.pem'),
    npm_config_prefix: path.join(root, 'evil-prefix'),
    PI_GUI_TOKEN: 'secret-token',
  };
  fs.mkdirSync(env.PATH, { recursive: true });
  const calls = [];
  const events = [];
  const downloads = [];
  const abortSeen = { count: 0 };
  const counters = { invalidations: 0, piLaunchResets: 0, piVersionResets: 0, onInstalled: 0 };

  const { createEnvironmentStore, NODE_LTS, GIT_MINIGIT } = STORE_MOD;

  const verifyFailedReport = () => ({
    requiredReady: false,
    plan: { planId: PLAN_ID, steps: [] },
    components: {
      node: { status: 'ready', version: '24.22.3' },
      pi: { status: 'failed', version: '1.5.2' },
      git: { status: 'ready', version: '2.56.1' },
    },
  });
  const setup = {
    check: async ({ force } = {}) => {
      if (instance.currentJob()?.state !== 'verifying') return planReport(steps, { locked });
      if (force && verifyGate) await verifyGate.promise;
      return verifyReady ? readyReport() : verifyFailedReport();
    },
    invalidate: () => { counters.invalidations++; },
  };

  const runCli = async ({ entry, args = [], signal, env: callEnv = null, inheritEnv }) => {
    if (signal && signal.aborted) return { ok: false, code: 'cancelled' };
    const cmd = String(entry.cmd || '');
    const list = [...(entry.baseArgs || []), ...args].map(String);
    calls.push({ cmd, list, env: callEnv, inheritEnv });
    const npmIndex = list.findIndex((item) => item.endsWith('npm-cli.js'));
    if (npmIndex !== -1) {
      if (list[npmIndex + 1] === '--version') return ok('11.6.0');
      if (list[npmIndex + 1] === 'prefix') return ok(path.join(root, 'npm-prefix'));
      if (list.includes('install')) {
        const prefix = list[list.indexOf('--prefix') + 1];
        const pkgDir = path.join(prefix, 'node_modules', '@earendil-works', 'pi-coding-agent');
        write(path.join(pkgDir, 'package.json'), JSON.stringify({
          name: '@earendil-works/pi-coding-agent',
          version: '1.5.2',
          bin: { pi: 'dist/bundle/cli.js' },
        }));
        write(path.join(pkgDir, 'dist', 'bundle', 'cli.js'), '// fake pi');
        write(path.join(prefix, 'pi.cmd'), '@echo off\r\n');
        return ok('');
      }
      return ok('');
    }
    if (/node(?:\.exe)?$/i.test(cmd)) {
      if (list[0] === '--version') return ok(`v${NODE_LTS.version}`);
      if (list[list.length - 1] === '--version') return ok('1.5.2');
      return ok('');
    }
    if (/git(?:\.exe)?$/i.test(cmd)) return ok(`git version ${GIT_MINIGIT.version}.windows.1`);
    return { ok: false, code: 'exit' };
  };

  const io = {
    downloadFile: async ({ url, file, onProgress, signal }) => {
      downloads.push(url);
      if (blockingDownload) {
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            abortSeen.count++;
            reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
          };
          if (signal && signal.aborted) return onAbort();
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      fs.writeFileSync(file, 'fake-archive');
      onProgress?.({ receivedBytes: 12, totalBytes: 12 });
      return { bytes: 12 };
    },
    downloadText: async () => missingOfficialChecksum ? '' : `${NODE_LTS.sha256}  ${NODE_LTS.archive}\n`,
    sha256File: async (file) => {
      if (badChecksum) return '0'.repeat(64);
      return path.basename(file) === NODE_LTS.archive ? NODE_LTS.sha256 : GIT_MINIGIT.sha256;
    },
    extractZipSafe: async ({ zipFile, destDir }) => {
      if (path.basename(zipFile).startsWith('node-')) {
        const dir = path.join(destDir, NODE_LTS.archive.replace(/\.zip$/i, ''));
        write(path.join(dir, 'node.exe'), 'fake');
        write(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '// npm');
      } else {
        write(path.join(destDir, 'cmd', 'git.exe'), 'fake');
      }
      return destDir;
    },
    writeExtractScript: (targetRoot, token) => write(path.join(targetRoot, '.tmp', 'scripts', `extract-${token}.ps1`), '# fake'),
    windowsPowerShellPath: () => write(path.join(root, 'powershell.exe'), 'fake'),
  };

  const store = createEnvironmentStore({ dataDir, env, runtimeDirOverride: runtimeDir });
  const instance = createEnvironmentInstall({
    setup,
    store,
    piLaunch: { reset: () => { counters.piLaunchResets++; } },
    piVersion: { reset: () => { counters.piVersionResets++; } },
    runCli,
    onEvent: (job) => { events.push(job); },
    onInstalled: (job) => {
      counters.onInstalled++;
      if (typeof onInstalled === 'function') return onInstalled(job);
      return undefined;
    },
    env,
    isWin: true,
    io,
    desktop,
    now,
  });
  return { root, runtimeDir, dataDir, env, setup, store, instance, calls, events, downloads, counters, abortSeen };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function waitFor(fn, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

(async () => {
  ({ createEnvironmentInstall } = await import('../server/environment-install.js'));
  ({ createEnvironmentRoutes } = await import('../server/environment-routes.js'));
  STORE_MOD = await import('../server/environment-store.js');
  const { NODE_LTS, GIT_MINIGIT } = STORE_MOD;

  await check('CLI 可用完整环境启动，已删除的 Node/TLS 变量不会从父进程回流', async () => {
    const { runCli } = await import('../server/agents/cli.js');
    const keys = ['NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED'];
    const prior = keys.map((key) => process.env[key]);
    try {
      process.env.NODE_OPTIONS = '--no-warnings';
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      const env = { SystemRoot: process.env.SystemRoot, npm_config_strict_ssl: 'true' };
      const probeKeys = [...keys, 'npm_config_strict_ssl'];
      const entry = {
        ok: true, cmd: process.execPath,
        baseArgs: ['-p', `JSON.stringify(${JSON.stringify(probeKeys)}.map(key => process.env[key] ?? null))`],
      };
      const isolated = await runCli({ entry, env, inheritEnv: false, cwd: TMP_ROOT });
      assert.equal(isolated.ok, true);
      assert.deepEqual(JSON.parse(isolated.stdout), [null, null, 'true']);
    } finally {
      for (const [index, key] of keys.entries()) {
        if (prior[index] === undefined) delete process.env[key];
        else process.env[key] = prior[index];
      }
    }
  });

  section('开始前的校验');

  await check('未确认 / 非数组 / 未知组件 / 重复组件一律拒绝', async () => {
    const h = makeHarness({ steps: ['node', 'pi', 'git'] });
    let r = await h.instance.start({ planId: PLAN_ID, components: ['node', 'pi'], consent: false });
    assert.equal(r.ok, false); assert.equal(r.code, 'consent-required');
    r = await h.instance.start({ planId: PLAN_ID, components: 'node', consent: true });
    assert.equal(r.ok, false); assert.equal(r.code, 'invalid-components');
    r = await h.instance.start({ planId: PLAN_ID, components: ['python'], consent: true });
    assert.equal(r.ok, false); assert.equal(r.code, 'invalid-components');
    r = await h.instance.start({ planId: PLAN_ID, components: ['node', 'node'], consent: true });
    assert.equal(r.ok, false); assert.equal(r.code, 'invalid-components');
    h.instance.dispose();
  });

  await check('计划指纹不匹配 → stale-plan；缺必需组件 → invalid-components', async () => {
    const h = makeHarness({ steps: ['node', 'pi', 'git'] });
    let r = await h.instance.start({ planId: 'plan-other', components: ['node', 'pi'], consent: true });
    assert.equal(r.code, 'stale-plan');
    r = await h.instance.start({ planId: PLAN_ID, components: ['node', 'git'], consent: true });
    assert.equal(r.code, 'invalid-components');
    r = await h.instance.start({ planId: PLAN_ID, components: [], consent: true });
    assert.equal(r.code, 'invalid-components');
    h.instance.dispose();
  });

  await check('PI_BIN 锁定时不能把 Pi 放进安装请求', async () => {
    const h = makeHarness({ steps: ['node', 'git'], locked: true });
    const r = await h.instance.start({ planId: PLAN_ID, components: ['node', 'git', 'pi'], consent: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'pi-locked');
    h.instance.dispose();
  });

  await check('非 Windows 平台直接拒绝，不进入任何写路径', async () => {
    const { createEnvironmentStore } = await import('../server/environment-store.js');
    const root = fs.mkdtempSync(path.join(TMP_ROOT, 'nowin-'));
    const store = createEnvironmentStore({ dataDir: path.join(root, 'data'), env: {}, runtimeDirOverride: path.join(root, 'runtime') });
    const instance = createEnvironmentInstall({
      setup: { check: async () => planReport(['node']), invalidate() {} },
      store,
      runCli: async () => ok(''),
      isWin: false,
    });
    const r = await instance.start({ planId: PLAN_ID, components: ['node'], consent: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unsupported-platform');
    assert.equal(fs.existsSync(path.join(root, 'runtime')), false);
    instance.dispose();
  });

  section('完整安装');

  await checkWin('按 Node → Pi → Git 顺序安装，验证通过后落地并清理临时目录', async () => {
    const h = makeHarness();
    const result = await h.instance.start({ planId: PLAN_ID, components: ['node', 'pi', 'git'], consent: true });
    assert.equal(result.ok, true);
    assert.equal(result.status, 202);
    assert.deepEqual(result.job.components.map((c) => c.id), ['node', 'pi', 'git']);
    assert.equal(result.job.state, 'running');
    assert.equal(result.job.requiresAdmin, false);
    assert.equal(result.job.scope, 'user');

    const job = await waitFor(() => {
      const current = h.instance.getJob(result.job.id);
      return current && ['succeeded', 'failed', 'cancelled'].includes(current.state) ? current : null;
    });
    assert.equal(job.state, 'succeeded');
    assert.equal(job.completedSteps, 3);
    assert.equal(job.totalSteps, 3);
    assert.deepEqual(job.components.map((c) => c.status), ['done', 'done', 'done']);
    assert.equal(job.result.requiredReady, true);
    assert.deepEqual(job.result.components.node, { status: 'ready', version: '24.22.3' });
    assert.deepEqual(job.result.components.pi, { status: 'ready', version: '1.5.2' });

    /* 落地：真实文件系统里应该有 node.exe、npm-cli.js、pi.cmd、git.exe。 */
    const paths = h.store.paths();
    assert.equal(fs.existsSync(path.join(paths.nodeDir(NODE_LTS.version), 'node.exe')), true);
    assert.equal(fs.existsSync(path.join(paths.nodeDir(NODE_LTS.version), 'node_modules', 'npm', 'bin', 'npm-cli.js')), true);
    assert.equal(fs.existsSync(path.join(paths.piPrefix, 'pi.cmd')), true);
    assert.equal(fs.existsSync(path.join(paths.piPrefix, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json')), true);
    assert.equal(fs.existsSync(paths.gitBin(GIT_MINIGIT.version)), true);

    /* npm 子进程只能使用本次任务的固定配置：外部环境不能关掉 TLS 校验、
     * 注入 Node 启动参数或改写安装前缀。 */
    const npmCall = h.calls.find((call) => call.list.includes('install'));
    assert.ok(npmCall && npmCall.env, 'npm install call missing');
    assert.equal(npmCall.env.NODE_OPTIONS, undefined);
    assert.equal(npmCall.env.PI_GUI_TOKEN, undefined);
    assert.equal(npmCall.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
    assert.equal(npmCall.env.NODE_EXTRA_CA_CERTS, undefined);
    assert.equal(npmCall.env.NODE_V8_COVERAGE, undefined);
    assert.equal(npmCall.env.SSL_CERT_FILE, undefined);
    assert.equal(npmCall.env.NPM_CONFIG_STRICT_SSL, undefined);
    assert.equal(npmCall.env.NPM_CONFIG_IGNORE_SCRIPTS, undefined);
    assert.equal(npmCall.env.npm_config_cafile, undefined);
    assert.equal(npmCall.env.npm_config_prefix, undefined);
    assert.equal(npmCall.env.npm_config_strict_ssl, 'true');
    assert.equal(npmCall.env.npm_config_registry, 'https://registry.npmjs.org/');
    assert.equal(npmCall.inheritEnv, false);
    assert.ok(npmCall.list.includes('--strict-ssl=true'));
    const userConfig = npmCall.list[npmCall.list.indexOf('--userconfig') + 1];
    const globalConfig = npmCall.list[npmCall.list.indexOf('--globalconfig') + 1];
    assert.notEqual(userConfig.toLowerCase(), globalConfig.toLowerCase(), 'npm refuses config files loaded twice');
    assert.equal(path.dirname(userConfig), path.dirname(globalConfig));
    assert.equal(npmCall.env.npm_config_userconfig, userConfig);
    assert.equal(npmCall.env.npm_config_globalconfig, globalConfig);

    const config = h.store.read();
    assert.equal(config.managed.nodeVersion, NODE_LTS.version);
    assert.equal(config.managed.piVersion, '1.5.2');
    assert.equal(config.managed.gitVersion, GIT_MINIGIT.version);

    /* 缓存失效、RPC 重启钩子都由 server 注入；这里只验证调用发生。 */
    assert.equal(h.counters.piLaunchResets > 0, true);
    assert.equal(h.counters.piVersionResets > 0, true);
    assert.equal(h.counters.invalidations > 0, true);
    assert.equal(h.counters.onInstalled, 1);

    /* 临时目录只留下固定的 scripts 目录，任务目录已被删掉。 */
    const tmpEntries = fs.existsSync(path.join(h.runtimeDir, '.tmp')) ? fs.readdirSync(path.join(h.runtimeDir, '.tmp')) : [];
    assert.deepEqual(tmpEntries.filter((name) => name !== 'scripts'), []);

    /* 事件流：至少一个 running、一个 succeeded；快照里不能有安装根路径。 */
    assert.ok(h.events.some((e) => e.state === 'running'));
    assert.equal(h.events[h.events.length - 1].state, 'succeeded');
    assert.equal(JSON.stringify(h.events).includes(h.runtimeDir), false);
    assert.equal(JSON.stringify(job).includes(h.runtimeDir), false);

    /* 下载地址只来自钉死的官方常量。 */
    assert.ok(h.downloads.includes(`${NODE_LTS.distBase}/v${NODE_LTS.version}/${NODE_LTS.archive}`));
    assert.ok(h.downloads.includes(GIT_MINIGIT.url));

    /* 装完之后真实检测会给出空计划；此时同类请求只能得到 up-to-date /
     * stale-plan，不会再次执行安装。 */
    h.setup.check = async () => readyReport();
    const again = await h.instance.start({ planId: PLAN_ID, components: [], consent: true });
    assert.equal(again.ok, false);
    assert.equal(again.code, 'up-to-date');
    const stale = await h.instance.start({ planId: PLAN_ID, components: ['node'], consent: true });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'stale-plan');
    h.instance.dispose();
  });

  await checkWin('仅安装 Pi 时从 PATH 选 Node，忽略启动目录中的同名文件', async () => {
    const h = makeHarness({ steps: ['pi'] });
    const systemNode = write(path.join(h.env.PATH, 'node.exe'));
    write(path.join(h.env.PATH, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    const cwd = path.join(h.root, 'launch-cwd');
    write(path.join(cwd, 'node.exe'));
    write(path.join(cwd, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      const result = await h.instance.start({ planId: PLAN_ID, components: ['pi'], consent: true });
      assert.equal(result.ok, true);
      const job = await waitFor(() => {
        const current = h.instance.getJob(result.job.id);
        return current?.finishedAt ? current : null;
      });
      assert.equal(job.state, 'succeeded');
      assert.equal(h.calls.find((call) => call.list.includes('install'))?.cmd.toLowerCase(), systemNode.toLowerCase());
    } finally {
      process.chdir(previousCwd);
      await h.instance.dispose();
    }
  });

  await checkWin('只请求计划里的组件：不装 Git 时任务里根本没有它', async () => {
    const h = makeHarness({ steps: ['node', 'pi'] });
    const result = await h.instance.start({ planId: PLAN_ID, components: ['node', 'pi'], consent: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.job.components.map((c) => c.id), ['node', 'pi']);
    const job = await waitFor(() => {
      const current = h.instance.getJob(result.job.id);
      return current && ['succeeded', 'failed', 'cancelled'].includes(current.state) ? current : null;
    });
    assert.equal(job.state, 'succeeded');
    assert.equal(job.components.length, 2);
    assert.equal(fs.existsSync(h.store.paths().gitDir(GIT_MINIGIT.version)), false);
    h.instance.dispose();
  });

  await checkWin('安装后钩子抛错不推翻已完成的安装结果', async () => {
    const h = makeHarness({
      steps: ['node', 'pi'],
      onInstalled: () => { throw new Error('hook boom'); },
    });
    const result = await h.instance.start({ planId: PLAN_ID, components: ['node', 'pi'], consent: true });
    assert.equal(result.ok, true);
    const job = await waitFor(() => {
      const current = h.instance.getJob(result.job.id);
      return current && current.state !== 'running' && current.state !== 'cancelling' ? current : null;
    });
    assert.equal(job.state, 'succeeded');
    h.instance.dispose();
  });

  await checkWin('安装状态写不进去 → 回滚新目录并以失败结束，不留下「装好但用不上」的状态', async () => {
    const h = makeHarness({ steps: ['node'] });
    const target = h.store.paths().nodeDir(NODE_LTS.version);
    write(path.join(target, 'old-node-marker.txt'), 'old');
    h.store.recordManaged = () => false;
    const result = await h.instance.start({ planId: PLAN_ID, components: ['node'], consent: true });
    assert.equal(result.ok, true);
    const job = await waitFor(() => {
      const current = h.instance.getJob(result.job.id);
      return current && ['succeeded', 'failed', 'cancelled'].includes(current.state) ? current : null;
    });
    assert.equal(job.state, 'failed');
    assert.equal(job.errorCode, 'config-write-failed');
    assert.equal(fs.existsSync(path.join(target, 'old-node-marker.txt')), true);
    assert.equal(fs.existsSync(path.join(target, 'node.exe')), false);
    h.instance.dispose();
  });

  await checkWin('下载摘要不匹配 → failed / checksum-mismatch，且不落地目标目录', async () => {
    const h = makeHarness({ steps: ['node'], badChecksum: true });
    const result = await h.instance.start({ planId: PLAN_ID, components: ['node'], consent: true });
    assert.equal(result.ok, true);
    const job = await waitFor(() => {
      const current = h.instance.getJob(result.job.id);
      return current && ['succeeded', 'failed', 'cancelled'].includes(current.state) ? current : null;
    });
    assert.equal(job.state, 'failed');
    assert.equal(job.errorCode, 'checksum-mismatch');
    assert.equal(fs.existsSync(h.store.paths().nodeDir(NODE_LTS.version)), false);
    h.instance.dispose();
  });

  await checkWin('复检不通过 → failed / verify-failed，不写 succeeded', async () => {
    const h = makeHarness({ steps: ['node'], verifyReady: false });
    const result = await h.instance.start({ planId: PLAN_ID, components: ['node'], consent: true });
    assert.equal(result.ok, true);
    const job = await waitFor(() => {
      const current = h.instance.getJob(result.job.id);
      return current && ['succeeded', 'failed', 'cancelled'].includes(current.state) ? current : null;
    });
    assert.equal(job.state, 'failed');
    assert.equal(job.errorCode, 'verify-failed');
    h.instance.dispose();
  });

  section('取消与并发');

  await checkWin('下载中取消：cancelling → cancelled，临时目录清掉，挂起的下载收到 abort', async () => {
    const h = makeHarness({ steps: ['node'], blockingDownload: true });
    const result = await h.instance.start({ planId: PLAN_ID, components: ['node'], consent: true });
    assert.equal(result.ok, true);
    const id = result.job.id;
    /* 等下载真正挂起再取消，避免在 createTempDir 之前就 abort 的竞态。 */
    await waitFor(() => h.downloads.length > 0);
    const cancelled = h.instance.cancel(id);
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.job.state, 'cancelling');
    const job = await waitFor(() => {
      const current = h.instance.getJob(id);
      return current && current.state === 'cancelled' ? current : null;
    });
    assert.equal(job.state, 'cancelled');
    assert.equal(job.components[0].status, 'failed');
    assert.equal(h.abortSeen.count > 0, true);
    const tmpEntries = fs.existsSync(path.join(h.runtimeDir, '.tmp')) ? fs.readdirSync(path.join(h.runtimeDir, '.tmp')) : [];
    assert.deepEqual(tmpEntries.filter((name) => name !== 'scripts'), []);
    assert.equal(h.instance.cancel('env-does-not-exist').code, 'not-found');
    h.instance.dispose();
  });

  await checkWin('复检期间取消：迟到的复检成功不能把任务改回 succeeded', async () => {
    const gate = deferred();
    const h = makeHarness({ steps: ['node'], verifyGate: gate });
    const started = await h.instance.start({ planId: PLAN_ID, components: ['node'], consent: true });
    assert.equal(started.ok, true);
    const id = started.job.id;
    await waitFor(() => h.instance.getJob(id)?.state === 'verifying');
    const cancelled = h.instance.cancel(id);
    assert.equal(cancelled.ok, true);
    gate.resolve();
    const job = await waitFor(() => {
      const current = h.instance.getJob(id);
      return current && ['succeeded', 'failed', 'cancelled'].includes(current.state) ? current : null;
    });
    assert.equal(job.state, 'cancelled');
    assert.equal(job.errorCode, 'cancelled');
    h.instance.dispose();
  });

  await checkWin('同一时间只允许一个任务；取消后可以重新开始', async () => {
    const h = makeHarness({ steps: ['node'], blockingDownload: true });
    const first = await h.instance.start({ planId: PLAN_ID, components: ['node'], consent: true });
    assert.equal(first.ok, true);
    const busy = await h.instance.start({ planId: PLAN_ID, components: ['node'], consent: true });
    assert.equal(busy.ok, false);
    assert.equal(busy.code, 'busy');
    assert.equal(busy.job.id, first.job.id);
    h.instance.cancel(first.job.id);
    await waitFor(() => h.instance.getJob(first.job.id)?.state === 'cancelled');
    h.instance.dispose();
  });

  await checkWin('共用受管安装目录的后端不能并行写入，任务清理后释放目录锁', async () => {
    const first = makeHarness({ steps: ['node'], blockingDownload: true });
    const second = makeHarness({ steps: ['node'], runtimeDirOverride: first.runtimeDir.toUpperCase() });
    const request = { planId: PLAN_ID, components: ['node'], consent: true };
    try {
      const started = await first.instance.start(request);
      assert.equal(started.ok, true);
      await waitFor(() => first.downloads.length > 0);
      const rejected = await second.instance.start(request);
      assert.equal(rejected.status, 409);
      assert.equal(rejected.code, 'busy');
      assert.equal(second.instance.currentJob(), null);
      assert.deepEqual(second.downloads, []);
      await first.instance.dispose();
      assert.equal(first.instance.getJob(started.job.id)?.state, 'cancelled');
      const later = await second.instance.start(request);
      assert.equal(later.ok, true);
      const done = await waitFor(() => {
        const job = second.instance.getJob(later.job.id);
        return job?.finishedAt ? job : null;
      });
      assert.equal(done.state, 'succeeded');
    } finally {
      await first.instance.dispose();
      await second.instance.dispose();
    }
  });

  await checkWin('退出等待下载取消与临时目录清理，之后拒绝新任务', async () => {
    const h = makeHarness({ steps: ['node'], blockingDownload: true });
    const request = { planId: PLAN_ID, components: ['node'], consent: true };
    const started = await h.instance.start(request);
    assert.equal(started.ok, true);
    await waitFor(() => h.downloads.length > 0);
    await h.instance.dispose();
    assert.equal(h.instance.getJob(started.job.id)?.state, 'cancelled');
    assert.equal(h.abortSeen.count, 1);
    const tmp = path.join(h.runtimeDir, '.tmp');
    assert.deepEqual(fs.readdirSync(tmp), ['scripts']);
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'scripts')), []);
    assert.equal((await h.instance.start(request)).code, 'install-unavailable');
  });

  await checkWin('Node 固定摘要虽匹配，缺官方同名条目仍停止安装', async () => {
    const { instance, store } = makeHarness({ steps: ['node'], missingOfficialChecksum: true });
    const result = await instance.start({ planId: PLAN_ID, components: ['node'], consent: true });
    assert.equal(result.status, 202);
    const job = await waitFor(() => instance.getJob(result.job.id)?.finishedAt && instance.getJob(result.job.id));
    assert.equal(job.errorCode, 'checksum-mismatch');
    assert.equal(store.managedNodeDir(), null);
  });

  section('桌面安装授权');
  const selection = { planId: PLAN_ID, components: ['node', 'pi'] };

  await check('桌面业务层拒绝 web consent 与无授权的启动', async () => {
    const { instance } = makeHarness({ desktop: true });
    assert.equal((await instance.start({ ...selection, consent: true })).code, 'native-confirmation-required');
    assert.equal((await instance.startDesktop(selection)).code, 'native-confirmation-required');
    assert.equal(instance.currentJob(), null);
  });

  await check('单次许可分别绑定计划和组件集合，错误兑换后不能重试', async () => {
    const { instance } = makeHarness({ desktop: true });
    for (const change of [{ planId: 'plan-' + 'b'.repeat(20) }, { components: ['node', 'git'] }]) {
      const { ticket } = instance.approveDesktop(selection);
      assert.ok(ticket);
      assert.equal((await instance.startDesktop({ ...selection, ...change, ticket })).code, 'native-confirmation-required');
      assert.equal((await instance.startDesktop({ ...selection, ticket })).code, 'native-confirmation-required');
    }
    assert.equal(instance.currentJob(), null);
  });

  await check('桌面许可在 30 秒时失效', async () => {
    let clock = 1_000;
    const { instance } = makeHarness({ desktop: true, now: () => clock });
    const { ticket } = instance.approveDesktop(selection);
    clock += 30_000;
    assert.equal((await instance.startDesktop({ ...selection, ticket })).code, 'native-confirmation-required');
    assert.equal(instance.currentJob(), null);
  });

  await checkWin('有效许可只建立一个任务，重放与并发新许可不产生第二个任务', async () => {
    const { instance, events } = makeHarness({ desktop: true, blockingDownload: true });
    const { ticket } = instance.approveDesktop(selection);
    const first = instance.startDesktop({ ...selection, ticket });
    const replay = await instance.startDesktop({ ...selection, ticket });
    assert.equal(replay.code, 'native-confirmation-required');
    const other = instance.approveDesktop(selection);
    assert.equal((await instance.startDesktop({ ...selection, ticket: other.ticket })).code, 'busy');
    const started = await first;
    assert.equal(started.status, 202);
    assert.deepEqual(new Set(events.map(job => job.id)), new Set([started.job.id]));
    await instance.dispose();
  });

  await checkWin('许可匹配仍重新检测环境，计划实际变化时拒绝', async () => {
    const { instance, setup } = makeHarness({ desktop: true });
    const { ticket } = instance.approveDesktop(selection);
    setup.check = async ({ force }) => {
      assert.equal(force, true);
      return { ...readyReport(), plan: { planId: 'plan-' + 'c'.repeat(20), steps: [] } };
    };
    const result = await instance.startDesktop({ ...selection, ticket });
    assert.equal(result.code, 'stale-plan');
    assert.equal(instance.currentJob(), null);
  });

  section('HTTP 适配层');

  await check('桌面普通 HTTP 安装和路径选择入口不调用写操作', async () => {
    const routes = createEnvironmentRoutes({ desktop: true, setup: {
      setPiBinOverride: () => assert.fail('HTTP 不得修改桌面 Pi 路径'),
    }, install: { start: () => assert.fail('HTTP 不得调用桌面安装') } });
    const server = http.createServer((req, res) => routes.handle(req, res, new URL(req.url, 'http://127.0.0.1')));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      for (const [endpoint, code] of [['install', 'native-confirmation-required'], ['pi-path', 'native-selection-required']]) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/environment/${endpoint}`, {
          method: 'POST', body: JSON.stringify({ ...selection, consent: true }),
        });
        assert.equal(response.status, 403);
        assert.equal((await response.json()).code, code);
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await check('安装路由只透传 planId / 组件 / consent，不把额外字段带进业务层', async () => {
    const seen = [];
    const job = { id: 'env-job', state: 'running', components: [] };
    const setup = {
      check: async () => ({ requiredReady: false }),
      effectivePiBinSource: () => 'config',
      setPiBinOverride: () => ({ ok: true }),
    };
    const install = {
      start: async (request) => { seen.push(request); return { ok: true, job, status: 202 }; },
      getJob: (id) => (id === 'env-job' ? job : null),
      cancel: (id) => (id === 'env-job' ? { ok: true, job } : { ok: false, status: 404, code: 'not-found' }),
    };
    const routes = createEnvironmentRoutes({ setup, install });
    const server = http.createServer((req, res) => routes.handle(req, res, new URL(req.url, 'http://127.0.0.1')));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const started = await fetch(base + '/api/environment/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          planId: 'plan-1', components: ['pi'], consent: true,
          command: 'whoami', url: 'https://evil.example', env: { TOKEN: 'x' },
        }),
      });
      assert.equal(started.status, 202);
      assert.deepEqual(seen, [{ planId: 'plan-1', components: ['pi'], consent: true }]);

      assert.equal((await fetch(base + '/api/environment/install')).status, 405);

      const current = await (await fetch(base + '/api/environment/job?id=env-job')).json();
      assert.equal(current.ok, true);
      assert.equal(current.job.id, 'env-job');
      assert.equal((await fetch(base + '/api/environment/job?id=missing')).status, 404);

      const cancelled = await (await fetch(base + '/api/environment/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'env-job' }),
      })).json();
      assert.equal(cancelled.ok, true);
      assert.equal(cancelled.job.id, 'env-job');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await check('PI_BIN 锁定时 pi-path 返回 409，不会接受页面送来的路径', async () => {
    let override = null;
    const setup = {
      check: async () => ({ requiredReady: false }),
      effectivePiBinSource: () => 'env',
      setPiBinOverride: (value) => { override = value; return { ok: true }; },
    };
    const routes = createEnvironmentRoutes({ setup });
    const server = http.createServer((req, res) => routes.handle(req, res, new URL(req.url, 'http://127.0.0.1')));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(base + '/api/environment/pi-path', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'C:/somewhere/pi.exe' }),
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'env-locked');
      assert.equal(override, null);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  console.log(`\nEnvironment install: ${pass}/${pass + fail} passed; failed=${fail}; skipped=0`);
  if (fail) process.exitCode = 1;
  process.env.PATH = ORIGINAL_PATH;
})();
