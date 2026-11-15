/* 首次启动环境检测（server/environment-setup.js）的离线契约。
 *
 * 全程不联网、不 spawn 真实 pi、不读用户真实的 Node/Pi/Git：外部程序一律用
 * `os.tmpdir()` 里的假文件 + 注入的 `run` / `runRpc` 替代。唯一真实启动的
 * 进程是 RPC 探测用例里的 **node 本身**（一个假 pi 脚本），它验证的是
 * 「只认 get_state 的 success 应答」这条判据，而不是机器上装了什么。
 *
 * 覆盖：
 *   - 必需/推荐分离：Node + Pi 必需，Git 推荐且缺失不阻塞
 *   - 最低 Node 版本来自已安装 Pi 的 `engines.node`，不是写死值
 *   - Pi 身份只来自注入的 piLaunch；入口未知时不读版本（不误报 malformed）
 *   - 低于验证基线 → incompatible / update-pi，不重装
 *   - PI_BIN 锁定 → manual，绝不进安装计划
 *   - RPC 探测结果缓存与 invalidate
 *   - 脱敏：报告与诊断摘要都不含绝对路径
 *   - 安装计划 planId 随环境变化
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-env-setup-'));

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

function write(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function res(stdout) {
  return { status: 0, stdout, stderr: '' };
}

function makeFixture({
  label = 'case',
  nodeVersion = '24.22.1',
  npm = true,
  gitVersion = '2.53.0',
  piPresent = true,
  piVersionValue = '1.5.2',
  piEngines = null,
  rpcOk = true,
  piBin = null,
  envPiBin = null,
  storeEnvExtra = {},
} = {}) {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, label + '-'));
  const binDir = path.join(root, 'bin');
  const nodeExe = write(path.join(binDir, 'node.exe'), 'fake');
  const npmCli = npm ? write(path.join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '// npm') : null;
  const npmCmd = npm ? write(path.join(binDir, 'npm.cmd'), '@echo off\r\n') : null;
  const gitExe = write(path.join(binDir, 'git.exe'), 'fake');
  const localAppData = path.join(root, 'localappdata');
  const dataDir = path.join(root, 'data');
  const runtimeDir = path.join(root, 'runtime');
  const piPkgDir = writePiPackage(root, piEngines);
  const piEntry = piBin || path.join(root, 'npm', 'pi.cmd');
  const mocks = { rpcCalls: 0, versionReads: 0, identityResets: 0, versionResets: 0, invalidations: 0, rpcCodes: [] };
  const callbacks = { rpcOk };
  const env = {
    PATH: binDir,
    PATHEXT: '.EXE;.CMD;.BAT',
    LOCALAPPDATA: localAppData,
    APPDATA: path.join(root, 'appdata'),
    HOME: path.join(root, 'home'),
    ...(envPiBin ? { PI_BIN: envPiBin } : {}),
    ...storeEnvExtra,
  };

  const run = (file, args = []) => {
    const base = path.basename(String(file)).toLowerCase();
    const list = Array.isArray(args) ? args.map(String) : [];
    if (base === 'node.exe' && list[0] && list[0].endsWith('npm-cli.js')) {
      if (list[1] === '--version') return res('11.6.0');
      if (list[1] === 'prefix') return res(path.join(root, 'npm-prefix'));
      return res('');
    }
    if (base === 'node.exe') return res(`v${nodeVersion}`);
    if (base === 'git.exe') return res(`git version ${gitVersion}.windows.1`);
    return { status: 1, stdout: '', stderr: '' };
  };

  const piLaunch = {
    identity: () => (piPresent
      ? { bin: piEntry, source: 'path', entryKnown: true, packageDir: piPkgDir, packageDirKnown: true }
      : { bin: 'pi', source: 'path', entryKnown: false, packageDir: null, packageDirKnown: false }),
    identityKey: () => (piPresent ? 'identity-' + piEntry : 'identity-missing'),
    packageDir: () => (piPresent ? piPkgDir : null),
    cliEntry: () => (piPresent ? piEntry : null),
    reset: () => { mocks.identityResets++; },
  };
  const piVersion = {
    read: () => {
      mocks.versionReads++;
      if (!piPresent) return null;
      return {
        value: piVersionValue,
        source: 'package.json',
        status: 'known',
        verification: 'verified',
        verifiedAgainst: { version: piVersionValue, verifiedAt: '2026-11-01' },
        relative: 'equal',
      };
    },
    reset: () => { mocks.versionResets++; },
  };
  const runRpc = async ({ bin }) => {
    mocks.rpcCalls++;
    mocks.rpcCodes.push(bin);
    return callbacks.rpcOk === false
      ? { ok: false, code: 'timeout', ms: 12000 }
      : { ok: true, ms: 7 };
  };

  return {
    root, binDir, nodeExe, npmCli, npmCmd, gitExe, localAppData, dataDir, runtimeDir,
    piPkgDir, piEntry, env, run, piLaunch, piVersion, runRpc, mocks, callbacks,
  };
}

function writePiPackage(root, engines) {
  const dir = path.join(root, 'pi-package');
  fs.mkdirSync(dir, { recursive: true });
  const pkg = { name: '@earendil-works/pi-coding-agent', version: '1.5.2' };
  if (engines) pkg.engines = { node: engines };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
  return dir;
}

(async () => {
  const { createEnvironmentStore, PI_MIN_NODE } = await import('../server/environment-store.js');
  const { createEnvironmentSetup, findNpmCli, probePiRpc } = await import('../server/environment-setup.js');
  const { NODE_LTS, GIT_MINIGIT } = await import('../server/environment-store.js');

  function buildSetup(fx, opts = {}) {
    const store = createEnvironmentStore({
      dataDir: fx.dataDir,
      env: fx.env,
      runtimeDirOverride: fx.runtimeDir,
    });
    const setup = createEnvironmentSetup({
      store,
      piLaunch: fx.piLaunch,
      piVersion: fx.piVersion,
      baseEnv: fx.env,
      isWin: true,
      run: fx.run,
      runRpc: fx.runRpc,
      now: () => 1_700_000_000_000,
      electronVersion: '24.22.1',
      electronPath: path.join(fx.root, 'pi-gui.exe'),
      ...opts,
    });
    return { store, setup };
  }

  section('完整环境');

  await check('Node/npm/Pi/Git 都就绪时 requiredReady=true 且没有安装计划', async () => {
    const fx = makeFixture({ label: 'ready' });
    const { setup } = buildSetup(fx);
    const report = await setup.check({ force: true });
    assert.equal(report.ok, true);
    assert.equal(report.requiredReady, true);
    assert.equal(report.needsSetup, false);
    assert.deepEqual(report.plan.steps, []);
    assert.equal(report.components.node.status, 'ready');
    assert.equal(report.components.node.version, '24.22.1');
    assert.equal(report.components.node.npm.present, true);
    assert.equal(report.components.node.npm.version, '11.6.0');
    assert.equal(report.components.pi.status, 'ready');
    assert.equal(report.components.pi.rpc.state, 'ready');
    assert.equal(report.components.pi.version, '1.5.2');
    assert.equal(report.components.git.status, 'ready');
    assert.equal(report.firstRun, true);
  });

  await check('RPC 启动前检查外部 Node 最低版本与 Pi 入口，缺依赖时不运行 RPC 探测', async () => {
    const ready = makeFixture({ label: 'runtime-ready' });
    assert.equal(buildSetup(ready).setup.hasRuntimeDependencies(), true);
    const old = makeFixture({ label: 'runtime-old-node', nodeVersion: '18.0.0' });
    const partial = buildSetup(old).setup;
    assert.equal(partial.hasRuntimeDependencies(), false);
    assert.equal((await partial.check({ force: true })).components.pi.rpc.state, 'skipped');
    assert.equal(old.mocks.rpcCalls, 0);
    assert.equal(buildSetup(makeFixture({ label: 'runtime-no-pi', piPresent: false })).setup.hasRuntimeDependencies(), false);
  });

  await check('npm 缺失只给警告；Pi 已装好时不阻塞运行', async () => {
    const fx = makeFixture({ label: 'no-npm', npm: false });
    const { setup } = buildSetup(fx);
    const report = await setup.check({ force: true });
    assert.equal(report.components.node.npm.present, false);
    assert.equal(report.components.node.npm.status, 'missing');
    assert.ok(report.components.node.warnings.includes('npm-missing'));
    assert.match(report.components.node.detail, /npm 不可用/);
    assert.equal(report.requiredReady, true);
  });

  await check('npm 缺失且 Pi 未装时，Node 进入安装计划', async () => {
    const fx = makeFixture({ label: 'no-npm-pi-missing', npm: false, piPresent: false });
    const { setup } = buildSetup(fx);
    const report = await setup.check({ force: true });
    assert.ok(report.plan.steps.includes('node'));
    assert.ok(report.plan.steps.includes('pi'));
    assert.equal(report.plan.components.find((c) => c.id === 'node').kind, 'required');
  });

  await check('findNpmCli 优先 npm-cli.js，不经过 .cmd', async () => {
    const fx = makeFixture({ label: 'npm-cli' });
    const found = findNpmCli(fx.nodeExe, fs, true);
    assert.equal(found, fx.npmCli);
    assert.notEqual(found, fx.npmCmd);
  });

  section('Node 最低版本');

  await check('最低版本取自已安装 Pi 的 engines.node，而不是写死', async () => {
    const fx = makeFixture({ label: 'engines', piEngines: '>=23.4.0', nodeVersion: '23.0.0' });
    const { setup } = buildSetup(fx);
    const report = await setup.check({ force: true });
    assert.equal(report.components.node.minimum, '23.4.0');
    assert.equal(report.components.node.minimumSource, 'pi-engines');
    assert.equal(report.components.node.meetsMinimum, false);
    assert.equal(report.components.node.status, 'incompatible');
    assert.equal(report.requiredReady, false);
    assert.deepEqual(report.plan.steps, ['node']);
  });

  await check('没有可读的 Pi 包时回退到官方最低版本常量', async () => {
    const fx = makeFixture({ label: 'fallback-min', piPresent: false, nodeVersion: '22.18.0' });
    const { setup } = buildSetup(fx);
    const report = await setup.check({ force: true });
    assert.equal(report.components.node.minimum, PI_MIN_NODE);
    assert.equal(report.components.node.minimumSource, 'fallback');
    assert.equal(report.components.node.status, 'incompatible');
  });

  section('Pi 身份与版本');

  await check('Pi 入口未知时不读版本（避免把「找不到」误报成 malformed）', async () => {
    const fx = makeFixture({ label: 'entry-unknown', piPresent: false });
    const { setup } = buildSetup(fx);
    const report = await setup.check({ force: true });
    assert.equal(report.components.pi.status, 'needs-install');
    assert.equal(report.components.pi.action, 'install-pi');
    assert.equal(report.components.pi.version, null);
    assert.equal(fx.mocks.versionReads, 0);
    assert.equal(fx.mocks.rpcCalls, 0);
  });

  await check('低于验证基线 → incompatible / update-pi，安装计划不包含 Pi', async () => {
    const fx = makeFixture({ label: 'too-old', piVersionValue: '0.1.0' });
    const { setup } = buildSetup(fx);
    const report = await setup.check({ force: true });
    assert.equal(report.components.pi.status, 'incompatible');
    assert.equal(report.components.pi.action, 'update-pi');
    assert.ok(report.components.pi.detail.includes('低于'));
    assert.equal(report.plan.steps.includes('pi'), false);
    assert.equal(report.requiredReady, false);
  });

  await check('RPC 失败 → incompatible / update-pi，且不重装', async () => {
    const fx = makeFixture({ label: 'rpc-fail', rpcOk: false });
    const { setup } = buildSetup(fx);
    const report = await setup.check({ force: true });
    assert.equal(report.components.pi.rpc.state, 'failed');
    assert.equal(report.components.pi.status, 'incompatible');
    assert.equal(report.components.pi.action, 'update-pi');
    assert.equal(report.plan.steps.includes('pi'), false);
  });

  await check('PI_BIN 指向不存在的文件 → manual / locked，绝不纳入安装计划', async () => {
    const fx = makeFixture({
      label: 'locked', piPresent: false,
      envPiBin: path.join(TMP_ROOT, 'custom', 'pi.exe'),
    });
    const { setup } = buildSetup(fx);
    const report = await setup.check({ force: true });
    assert.equal(report.setup.piBinSource, 'env');
    assert.equal(report.components.pi.locked, true);
    assert.equal(report.components.pi.status, 'needs-install');
    assert.equal(report.components.pi.action, 'manual');
    assert.equal(report.plan.steps.includes('pi'), false);
    assert.equal(report.plan.piLocked, true);
    assert.ok(report.notes.some((n) => n && n.includes('PI_BIN')));
  });

  await check('手动 Pi 路径覆盖写进报告后只显示脱敏值', async () => {
    const fx = makeFixture({ label: 'override', piPresent: false });
    const override = write(path.join(fx.root, 'manual', 'pi.cmd'), '@echo off\r\n');
    const { setup } = buildSetup(fx);
    const set = setup.setPiBinOverride(override);
    assert.equal(set.ok, true);
    assert.equal(setup.effectivePiBinSource(), 'override');
    const report = await setup.check({ force: true });
    assert.equal(report.setup.piBinSource, 'override');
    assert.ok(report.setup.piBinOverride);
    assert.equal(report.setup.piBinOverride.includes(fx.root), false);
    assert.equal(report.components.pi.locked, true);
  });

  await check('报告里的 Pi 来源区分 managed / override，而不是一律叫 env', async () => {
    const fx = makeFixture({ label: 'pi-source' });
    write(path.join(fx.runtimeDir, 'pi', 'pi.cmd'), '@echo off\r\n');
    write(path.join(fx.dataDir, 'environment.json'), JSON.stringify({
      version: 1,
      managed: { piVersion: '1.5.2' },
    }));
    const { setup } = buildSetup(fx);
    const report = await setup.check({ force: true });
    assert.equal(report.components.pi.source, 'managed');
    assert.equal(report.setup.piBinSource, 'managed');
  });

  section('RPC 缓存与探测判据');

  await check('RPC 结果缓存到 invalidate，force 才重探', async () => {
    const fx = makeFixture({ label: 'rpc-cache' });
    const { setup } = buildSetup(fx);
    await setup.check({ force: true });
    assert.equal(fx.mocks.rpcCalls, 1);
    await setup.check({ force: false });
    assert.equal(fx.mocks.rpcCalls, 1);
    setup.invalidate();
    await setup.check({ force: false });
    assert.equal(fx.mocks.rpcCalls, 2);
  });

  await check('受管 Node 装好后，RPC 探测环境包含受管 Node（npm shim 靠 PATH 启动）', async () => {
    const fx = makeFixture({ label: 'rpc-managed-env' });
    const nodeDir = path.join(fx.runtimeDir, 'node-v24.22.3-win-x64');
    write(path.join(nodeDir, 'node.exe'), 'fake');
    write(path.join(fx.dataDir, 'environment.json'), JSON.stringify({
      version: 1,
      managed: { nodeVersion: '24.22.3' },
    }));
    let seenEnv = null;
    fx.runRpc = async ({ env }) => {
      seenEnv = env;
      return { ok: true, ms: 5 };
    };
    const { setup } = buildSetup(fx);
    const report = await setup.check({ force: true });
    assert.equal(report.components.pi.rpc.state, 'ready');
    assert.ok(seenEnv, 'RPC probe did not run');
    assert.equal(seenEnv.PATH.split(path.delimiter)[0], nodeDir);
    /* 系统 Node 的判定基线不能被受管 PATH 改写。 */
    assert.equal(fx.env.PATH.includes(nodeDir), false);
  });

  await check('只有 get_state 的 success 应答算就绪；错误应答/提前退出算失败', async () => {
    const fx = makeFixture({ label: 'rpc-probe' });
    const good = write(path.join(fx.root, 'fake-good.cjs'), `
process.stdin.once('data', () => {
  process.stdout.write(JSON.stringify({ type: 'response', id: 1, command: 'get_state', success: true }) + '\\n');
  // 自己在探测收尾后退出，避免经 cmd 启动的孙进程把测试进程挂住。
  setTimeout(() => process.exit(0), 300);
});
`);
    const bad = write(path.join(fx.root, 'fake-bad.cjs'), `
process.stdin.once('data', () => {
  process.stdout.write(JSON.stringify({ type: 'response', id: 2, command: 'get_state', success: true }) + '\\n');
  setTimeout(() => process.exit(0), 200);
});
`);
    const shim = (name, script) => write(path.join(fx.root, name + '.cmd'),
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);

    const goodBin = shim('pi-good', good);
    const badBin = shim('pi-bad', bad);
    let killed = 0;
    /* 经 cmd 启动时 child 只是外壳；按进程树收掉，避免留下孤儿把测试挂住。 */
    const killTree = (child) => {
      killed++;
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      } catch { /* noop */ }
    };
    const ok = await probePiRpc({
      bin: goodBin, env: fx.env, isWin: true,
      killTree,
      timeoutMs: 8000,
    });
    assert.equal(ok.ok, true);
    assert.equal(typeof ok.ms, 'number');
    assert.equal('stdout' in ok, false);
    assert.equal('stderr' in ok, false);
    assert.equal(killed > 0, true);

    const rejected = await probePiRpc({
      bin: badBin, env: fx.env, isWin: true,
      killTree,
      timeoutMs: 8000,
    });
    assert.equal(rejected.ok, false);
    assert.ok(['exited', 'write-failed', 'timeout'].includes(rejected.code));
  });

  section('脱敏与计划指纹');

  await check('报告与诊断摘要不含安装根 / 用户目录 / Pi 绝对路径', async () => {
    const fx = makeFixture({ label: 'redact' });
    const { setup } = buildSetup(fx);
    const report = await setup.check({ force: true });
    const text = JSON.stringify(report) + JSON.stringify(setup.diagnosticsSummary());
    assert.equal(text.includes(fx.root), false);
    assert.equal(text.includes(fx.localAppData), false);
    assert.equal(text.includes(fx.binDir), false);
    assert.equal(path.isAbsolute(report.components.node.executable), false);
    assert.equal(path.isAbsolute(report.components.pi.executable), false);
    assert.match(report.components.node.executable, /node\.exe$/i);
    assert.match(report.components.pi.executable, /pi\.cmd$/i);
  });

  await check('诊断摘要只含状态/版本/来源码，不含安装包 URL', async () => {
    const fx = makeFixture({ label: 'diag' });
    const { setup, store } = buildSetup(fx);
    await setup.check({ force: true });
    store.recordJob({ id: 'job-1', state: 'failed', startedAt: '2026-11-15T00:00:00.000Z', finishedAt: '2026-11-15T00:00:01.000Z', completedSteps: 1, totalSteps: 3, errorCode: 'checksum-mismatch' });
    setup.invalidate();
    await setup.check({ force: true });
    const summary = setup.diagnosticsSummary();
    const text = JSON.stringify(summary);
    assert.equal(text.includes('https://'), false);
    assert.equal(text.includes(fx.root), false);
    assert.equal(summary.components.pi.status, 'ready');
    assert.equal(summary.lastJob.errorCode, 'checksum-mismatch');
  });

  await check('planId 随环境变化；版本常量固定且摘要格式合法', async () => {
    const a = makeFixture({ label: 'plan-a' });
    const b = makeFixture({ label: 'plan-b', gitVersion: '2.53.0', piPresent: false });
    const ra = await buildSetup(a).setup.check({ force: true });
    const rb = await buildSetup(b).setup.check({ force: true });
    assert.notEqual(ra.plan.planId, rb.plan.planId);
    assert.match(ra.plan.planId, /^plan-[a-f0-9]{20}$/);
    assert.match(NODE_LTS.sha256, /^[a-f0-9]{64}$/);
    assert.match(GIT_MINIGIT.sha256, /^[a-f0-9]{64}$/);
    assert.equal(NODE_LTS.archive.endsWith('.zip'), true);
    assert.equal(GIT_MINIGIT.url.startsWith('https://github.com/'), true);
  });

  await check('向导完成记录后 firstRun=false，且不影响就绪判定', async () => {
    const fx = makeFixture({ label: 'ack' });
    const { setup, store } = buildSetup(fx);
    const before = await setup.check({ force: true });
    assert.equal(before.firstRun, true);
    store.recordSetup({ completedAt: '2026-11-15T00:00:00.000Z', lastRequiredReady: true });
    setup.invalidate();
    const after = await setup.check({ force: true });
    assert.equal(after.firstRun, false);
    assert.equal(after.requiredReady, true);
  });

  await check('单个组件探测失败不会让整份报告抛错（Node run 抛异常）', async () => {
    const fx = makeFixture({ label: 'throw' });
    const { setup } = buildSetup(fx, {
      run: () => { throw new Error('boom'); },
    });
    const report = await setup.check({ force: true });
    assert.equal(report.ok, true);
    assert.equal(report.components.node.version, null);
    assert.equal(report.components.node.status, 'incompatible');
    assert.equal(report.components.node.runnable, false);
  });

  console.log(`\nEnvironment setup: ${pass}/${pass + fail} passed; failed=${fail}; skipped=0`);
  if (fail) process.exitCode = 1;
})();
