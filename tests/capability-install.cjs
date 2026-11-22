/* Known Capability Installer（受控一键安装）的离线回归测试。
 *
 * ---------- 这一套要钉住什么 ----------
 *
 * 这个模块是**本轮唯一新增的写路径**：它会暂停 Pi、跑一条官方命令、再重启 Pi。
 * 所以纪律比功能重要，每一条都对着一个具体的失败形态：
 *
 *   1. **renderer 只能送 capabilityId** —— source / command / args / url 一律忽略，
 *      未知 id fail closed ⇒ 它不是任意包安装 / 命令执行入口；
 *   2. **固定 argv** —— 恰好 `['install', <allowlisted source>, '--no-approve']`，
 *      没有 `-l` / `--local` / `--approve` / `--all` / `--self`（用户级安装）；
 *   3. **闸门在后端** —— 确认、单飞、忙、工作区、入口，全都不信前端；
 *   4. **暂停超时 = 失败**，旧 Pi 还活着就一次都不安装；
 *   5. **只 resume 自己拥有的维护态**（别人建的维护态不掀）；
 *   6. **失败也要恢复 bridge**，GUI 不会永久停在维护态；
 *   7. **退出码 0 ≠ 已安装 ≠ 已加载** —— 后端只回 `commandCompleted`，
 *      `loaded` 恒为 null（装没装由重新发现的 Registry 回答）；
 *   8. **原始输出不出后端**：只留一句脱敏摘要，响应里没有 stdout / 路径 / 环境。
 *
 * 全程离线：`runInstall` 是替身，**测试绝不真的 npm install / pi install**。
 *
 * ---------- 第二阶段 B：受控包操作（I 段起） ----------
 *
 * 同一个模块多了第二条入口 `startOperation`（安装 / 卸载 / 更新一个**服务端解析好**的
 * npm 包）。它与已知能力安装共用锁、闸门、暂停与恢复，所以上面八条纪律原样适用，
 * 另外再钉三件事：
 *
 *   9. **source 的形状由这里独立校验** —— 不带版本、不带选项、不含路径段，
 *      调用方（extension-packages）解析错了也过不了这一关；
 *  10. **三个动作各只有一种 argv**，renderer 的请求体对 argv 没有任何影响；
 *  11. **复核在锁里** —— `finish` 钩子在 resume 之后、解锁之前跑，
 *      所以读盘读到的一定是「这一次命令之后」的状态。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
let fail = 0;
/* check 一律 await：有几条判据本身要跑一次异步安装，同步版会把 Promise 当 true。 */
async function check(name, cond, extra) {
  let ok;
  try {
    ok = typeof cond === 'function' ? await cond() : cond;
  } catch (err) {
    ok = '抛错：' + (err && err.message ? err.message : err);
  }
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}
function section(title) {
  console.log('\n--- ' + title + ' ---');
}

/* ---------- HTTP 替身（只够 handle 用） ---------- */

function mockReq({ method = 'POST' } = {}) {
  const listeners = new Map();
  const req = {
    method,
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
      return req;
    },
    emit(ev, arg) {
      for (const fn of listeners.get(ev) || []) fn(arg);
    },
  };
  return req;
}
function mockRes() {
  return { code: null, payload: null };
}
const jsonRecorder = (res) => (r, code, payload) => {
  r.code = code;
  r.payload = payload;
  return payload;
};

(async () => {
  const {
    createCapabilityInstall, CAPABILITY_SOURCES, capabilitySource, buildInstallArgs,
    DEFAULT_INSTALL_TIMEOUT_MS,
    buildRemoveArgs, buildUpdateArgs, isControlledSource, PACKAGE_OPERATIONS, packageOperation,
    updateOutcome, failureCause,
  } = await import('../server/capability-install.js');

  const KNOWN = {
    web: 'npm:pi-web-access',
    subagents: 'npm:pi-subagents',
    memory: 'npm:pi-memory',
    browser: 'npm:pi-browser-harness',
  };
  const entry = { kind: 'node', cmd: process.execPath, baseArgs: ['/pkg/dist/bundle/cli.js'], ok: true };

  /**
   * 造一个 installer + 观察窗。所有外部依赖都是替身 —— **一个真实子进程都不起**。
   */
  function harness({
    runResult = { ok: true, exitCode: 0, stdout: '', stderr: '' },
    pause = { ok: true },
    resolveOk = true,
    busy = null,
    currentCwd = null,
    runGate = null,
  } = {}) {
    const state = { runArgs: [], runOpts: [], paused: [], resumed: 0, invalidated: 0, sequence: [] };
    const install = createCapabilityInstall({
      currentCwd: typeof currentCwd === 'function' ? currentCwd : () => currentCwd,
      busyReason: typeof busy === 'function' ? busy : () => busy,
      resolveInstallTarget: () => (resolveOk ? { ok: true, entry } : { ok: false, code: 'no-proven-entry' }),
      runInstall: async (args, opts) => {
        state.runArgs.push(args);
        state.runOpts.push(opts);
        state.sequence.push('run');
        if (runGate) await runGate;
        if (runResult instanceof Error) throw runResult;
        return runResult;
      },
      pauseBridge: async (reason) => {
        state.paused.push(reason);
        state.sequence.push('pause');
        return pause;
      },
      resumeBridge: () => {
        state.resumed += 1;
        state.sequence.push('resume');
      },
      invalidateCaches: () => {
        state.invalidated += 1;
        state.sequence.push('invalidate');
      },
    });
    return { install, state };
  }

  const good = (capabilityId = 'memory') => ({ capabilityId, confirm: true, __expectedCwd: '' });

  /* ================= A. allowlist 与固定 argv ================= */
  section('A. allowlist 与固定 argv');

  await check('A1. 四个已知 id → 四个固定官方 source', () => {
    for (const [id, source] of Object.entries(KNOWN)) {
      if (capabilitySource(id) !== source) return `${id} → ${capabilitySource(id)}`;
    }
    return Object.keys(CAPABILITY_SOURCES).length === 4 || Object.keys(CAPABILITY_SOURCES).join(',');
  });
  await check('A2. 未知 id / 空值 / 非字符串 / 原型键 → null（fail closed，绝不猜一个包）', () =>
    capabilitySource('nope') === null && capabilitySource('') === null
    && capabilitySource(null) === null && capabilitySource({ id: 'memory' }) === null
    && capabilitySource('__proto__') === null && capabilitySource('constructor') === null
    && capabilitySource('toString') === null);
  await check('A3. 固定 argv 恰好是 install + source + --no-approve', () => {
    const args = buildInstallArgs('npm:pi-memory');
    return JSON.stringify(args) === JSON.stringify(['install', 'npm:pi-memory', '--no-approve']) || JSON.stringify(args);
  });
  await check('A4. argv 里没有 -l / --local / --approve / --all / --self / --force', () => {
    for (const id of Object.keys(KNOWN)) {
      const args = buildInstallArgs(capabilitySource(id));
      const bad = args.filter((a) => ['-l', '--local', '--approve', '-a', '--all', '--self', '--extensions', '--models', '--force', '--extension'].includes(a));
      if (bad.length) return `${id}: ${bad.join(',')}`;
      if (args.length !== 3) return `${id}: argv 长度 ${args.length}`;
      if (args[0] !== 'install') return `${id}: ${args[0]}`;
      if (args[2] !== '--no-approve') return `${id}: ${args[2]}`;
    }
    return true;
  });
  await check('A5. renderer 传 source / command / args / url 一概无效（argv 只由 allowlist 决定）', async () => {
    const { install, state } = harness();
    const r = await install.start({
      capabilityId: 'memory', confirm: true,
      source: 'npm:evil-package', packageName: 'evil', command: 'rm', args: ['-rf', '/'],
      url: 'https://evil.example', npmCommand: 'npm', registry: 'https://evil.example',
    });
    if (r.ok !== true) return JSON.stringify(r);
    const argv = state.runArgs[0];
    return JSON.stringify(argv) === JSON.stringify(['install', 'npm:pi-memory', '--no-approve'])
      || JSON.stringify(argv);
  });
  await check('A6. 前端的 installId 集合与服务端 allowlist 完全一致', () => {
    /* 两边漂了就会出现「按钮点了说未知能力」或者「有命令却没有按钮」——
     * 所以这一条是**交叉核对**，不是各测各的。 */
    const files = ['public/web-capabilities.js', 'public/subagent-capabilities.js',
      'public/memory-capabilities.js', 'public/browser-capabilities.js'];
    const ids = files.flatMap((f) => [...read(f).matchAll(/installId:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]));
    const allowed = Object.keys(CAPABILITY_SOURCES);
    if (ids.length !== 4) return `找到 ${ids.length} 个 installId：${ids.join(',')}`;
    const missing = ids.filter((id) => !allowed.includes(id));
    const unused = allowed.filter((id) => !ids.includes(id));
    if (missing.length) return `不在 allowlist：${missing.join(',')}`;
    return unused.length === 0 || `allowlist 里没人用：${unused.join(',')}`;
  });

  /* ================= B. 闸门 ================= */
  section('B. 闸门（全在后端）');

  await check('B1. 没有显式确认 → confirm-required，不暂停、不执行', async () => {
    const { install, state } = harness();
    const r = await install.start({ capabilityId: 'memory' });
    return (r.ok === false && r.code === 'confirm-required' && state.paused.length === 0 && state.runArgs.length === 0)
      || JSON.stringify(r);
  });
  await check('B2. 未知 capability → unknown-capability（不暂停、不执行）', async () => {
    const { install, state } = harness();
    const r = await install.start({ capabilityId: 'something-else', confirm: true });
    return (r.ok === false && r.code === 'unknown-capability' && state.paused.length === 0 && state.runArgs.length === 0)
      || JSON.stringify(r);
  });
  await check('B3. 忙（主会话 / Planner / 验证 / CLI / 更新 / 另一次安装）→ 拒绝并透传原因', async () => {
    for (const code of ['busy-turn', 'busy-plan', 'busy-cli', 'busy-pi-update', 'busy-install']) {
      const { install, state } = harness({ busy: { code, error: '现在忙' } });
      const r = await install.start(good());
      if (!(r.ok === false && r.code === code)) return `${code} → ${JSON.stringify(r)}`;
      if (state.paused.length || state.runArgs.length) return `${code} 竟然动了 Pi`;
    }
    return true;
  });
  await check('B4. 忙判据自己抛错 → busy-unknown（fail closed，不当作空闲）', async () => {
    const { install, state } = harness({ busy: () => { throw new Error('probe 坏了'); } });
    const r = await install.start(good());
    return (r.ok === false && r.code === 'busy-unknown' && state.paused.length === 0) || JSON.stringify(r);
  });
  await check('B5. 工作区过期 → workspace-stale（__expectedCwd 与 expectedCwd 都认）', async () => {
    for (const key of ['__expectedCwd', 'expectedCwd']) {
      const { install, state } = harness({ currentCwd: () => 'C:\\new' });
      const r = await install.start({ capabilityId: 'memory', confirm: true, [key]: 'C:\\old' });
      if (!(r.ok === false && r.code === 'workspace-stale')) return `${key} → ${JSON.stringify(r)}`;
      if (state.paused.length || state.runArgs.length) return `${key} 竟然动了 Pi`;
    }
    const { install: fresh } = harness({ currentCwd: () => 'C:\\same' });
    const r2 = await fresh.start({ capabilityId: 'memory', confirm: true, __expectedCwd: 'C:\\same' });
    return r2.ok === true || JSON.stringify(r2);
  });
  await check('B6. 证明不到「这份 Pi 的官方入口」→ unsupported（不退回 PATH）', async () => {
    const { install, state } = harness({ resolveOk: false });
    const r = await install.start(good());
    return (r.ok === false && r.code === 'unsupported' && state.runArgs.length === 0) || JSON.stringify(r);
  });

  /* ================= C. 单飞 ================= */
  section('C. 单飞（后端自己的锁）');

  await check('C1. 并发第二次安装 → install-running，且 runner 只被调一次', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { install, state } = harness({ runGate: gate });
    const first = install.start(good('web'));
    const second = await install.start(good('web'));
    release();
    const r1 = await first;
    return (r1.ok === true && second.ok === false && second.code === 'install-running' && state.runArgs.length === 1)
      || JSON.stringify({ r1, second, runs: state.runArgs.length });
  });
  await check('C2. 跑完之后锁会释放（下一次仍能安装）', async () => {
    const { install, state } = harness();
    await install.start(good('web'));
    await install.start(good('web'));
    return state.runArgs.length === 2 || state.runArgs.length;
  });

  /* ================= D. 维护态与失败语义 ================= */
  section('D. 维护态、失败与恢复');

  await check('D1. 暂停被拒（pause-failed）→ 失败，一次都不执行，也不 resume', async () => {
    const { install, state } = harness({ pause: { ok: false, code: 'pause-failed' } });
    const r = await install.start(good());
    return (r.ok === false && r.code === 'pause-failed' && state.runArgs.length === 0 && state.resumed === 0)
      || JSON.stringify({ r, runs: state.runArgs.length, resumed: state.resumed });
  });
  await check('D2. 暂停超时 → pause-timeout（旧 Pi 还活着就绝不安装），不 resume', async () => {
    const { install, state } = harness({ pause: { ok: false, code: 'pause-timeout' } });
    const r = await install.start(good());
    return (r.ok === false && r.code === 'pause-timeout' && state.runArgs.length === 0 && state.resumed === 0)
      || JSON.stringify(r);
  });
  await check('D3. 已经在维护中（别人建的）→ 放弃，且绝不 resume 别人的维护态', async () => {
    const { install, state } = harness({ pause: { ok: false, code: 'already-in-maintenance' } });
    const r = await install.start(good());
    return (r.ok === false && r.code === 'install-running' && state.resumed === 0 && state.runArgs.length === 0)
      || JSON.stringify(r);
  });
  await check('D4. 成功：pause → install → 清缓存 → resume，且 reason 是 capability-install', async () => {
    const { install, state } = harness();
    const r = await install.start(good('subagents'));
    const seq = state.sequence.join('>');
    return (r.ok === true && seq === 'pause>run>invalidate>resume' && state.paused[0] === 'capability-install')
      || JSON.stringify({ r, seq, reason: state.paused });
  });
  await check('D5. 安装子进程失败 → 仍然是失败 + **恢复 bridge**', async () => {
    const { install, state } = harness({ runResult: { ok: false, exitCode: 1, stdout: '', stderr: 'boom' } });
    const r = await install.start(good());
    return (r.ok === false && r.code === 'install-failed' && state.resumed === 1 && state.invalidated === 0)
      || JSON.stringify({ r, resumed: state.resumed, invalidated: state.invalidated });
  });
  await check('D6. 起不来 / 超时 / 抛错各有稳定 code（不能都叫 install-failed）', async () => {
    const spawnFail = harness({ runResult: { ok: false, spawnFailed: true, error: '无法启动' } });
    const r1 = await spawnFail.install.start(good());
    const timedOut = harness({ runResult: { ok: false, timedOut: true, error: '超时（600s）' } });
    const r2 = await timedOut.install.start(good());
    const threw = harness({ runResult: new Error('runner 炸了') });
    const r3 = await threw.install.start(good());
    /* 「runner 自己抛错」与「spawn 失败」同档（与 pi-update 的映射一致：
     * 调用方都只知道「这条命令没能正常跑起来」），但都必须与「跑起来了、退出码非 0」
     * 区分开 —— 后者的 code 是 install-failed。 */
    return (r1.code === 'install-spawn-failed' && r2.code === 'install-timeout'
      && r3.code === 'install-spawn-failed' && r1.ok === false && r2.ok === false && r3.ok === false)
      || JSON.stringify({ r1: r1.code, r2: r2.code, r3: r3.code });
  });
  await check('D7. resume 自己抛错不会盖掉真正的失败原因', async () => {
    const install = createCapabilityInstall({
      resolveInstallTarget: () => ({ ok: true, entry }),
      runInstall: async () => ({ ok: false, exitCode: 1, error: 'npm 失败' }),
      pauseBridge: async () => ({ ok: true }),
      resumeBridge: () => { throw new Error('resume 炸了'); },
      busyReason: () => null,
    });
    const r = await install.start({ capabilityId: 'memory', confirm: true });
    return (r.ok === false && r.code === 'install-failed') || JSON.stringify(r);
  });

  /* ================= E. 事实边界：退出码 0 ≠ 已安装 ≠ 已加载 ================= */
  section('E. 事实边界');

  await check('E1. 成功只回「命令跑完了」：commandCompleted=true / loaded=null', async () => {
    const { install } = harness();
    const r = await install.start(good('browser'));
    return (r.ok === true && r.commandCompleted === true && r.loaded === null && r.restarted === true)
      || JSON.stringify(r);
  });
  await check('E2. 成功响应**不含** stdout / stderr / 原始输出', async () => {
    const { install } = harness({ runResult: { ok: true, exitCode: 0, stdout: 'SECRET-OUT', stderr: 'SECRET-ERR' } });
    const r = await install.start(good());
    const text = JSON.stringify(r);
    return (!text.includes('SECRET-OUT') && !text.includes('SECRET-ERR')
      && !('stdout' in r) && !('stderr' in r)) || text;
  });
  await check('E3. 响应里没有绝对 Pi 路径 / 入口 / 命令 / 环境变量', async () => {
    const { install } = harness();
    const r = await install.start(good());
    const text = JSON.stringify(r);
    const forbidden = ['/pkg/dist/bundle/cli.js', process.execPath, 'PI_GUI_TOKEN', 'baseArgs', 'entryPath'];
    const hit = forbidden.filter((t) => text.includes(t));
    return hit.length === 0 || hit.join(',');
  });

  /* ================= F. 脱敏与隐私（源码级） ================= */
  section('F. 脱敏与隐私');

  await check('F1. 失败文案脱敏：路径 / Bearer / token 形态都变占位符', async () => {
    const { install } = harness({
      runResult: { ok: false, exitCode: 1, error: 'failed at C:\\Users\\me\\pi\\x.js Bearer sk-abc token=abcdef npm_ABCDEFGH12345678' },
    });
    const r = await install.start(good());
    const text = String(r.error || '');
    return (!text.includes('C:\\Users\\me') && !text.includes('sk-abc') && !text.includes('abcdef')
      && !text.includes('ABCDEFGH12345678') && text.includes('<path>')) || text;
  });
  await check('F2. 模块自己不起进程、不自己装包、不扫 npm', () => {
    const src = read('server/capability-install.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return (!/child_process|spawn\(|execFile|execSync/.test(src)
      && !/(npm|pnpm|bun|yarn)\s+(install|add|i)\b|curl\s/.test(src)) || '出现了进程启动 / 别的安装路径';
  });
  await check('F3. 安装逻辑**不在** Extension Registry 里（那条只读边界不动）', () => {
    const registry = read('server/extension-registry.js');
    return (!/capability-install|installAndPersist|--no-approve/.test(registry)
      && /actions:\s*\{\s*install:\s*false/.test(registry)) || 'Registry 被改成了安装器';
  });
  await check('F4. 共享 CLI 只允许覆盖服务端校验过的 Pi 配置目录', () => {
    const body = /function runPiCliCommand\([\s\S]*?\n\}/.exec(read('server.js'));
    if (!body) return '找不到 runPiCliCommand';
    return (/env:\s*opts\.agentDir\s*\?\s*\{ PI_CODING_AGENT_DIR: opts\.agentDir \}\s*:\s*\{\}/.test(body[0])
      && !/PI_GUI_TOKEN/.test(body[0])) || 'runPiCliCommand 引入了额外环境字段';
  });

  /* ================= G. 装配 ================= */
  section('G. server.js 装配');

  await check('G1. 忙判据覆盖五个来源（会话 / CLI / 更新 / 安装 / Planner+验证）', () => {
    const body = /function piBusyReason\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(read('server.js'));
    if (!body) return '找不到 piBusyReason';
    const src = body[1];
    const want = ['piActivity.busy()', 'cliInFlight > 0', 'piUpdate.isRunning()',
      'capabilityInstall.isRunning()', 'plannerRef.projectSwitchBlockReason()'];
    const miss = want.filter((t) => !src.includes(t));
    return miss.length === 0 || '缺少：' + miss.join(', ');
  });
  await check('G2. 更新与安装**共用同一份**忙判据（不是各写一套）', () => {
    const hits = [...read('server.js').matchAll(/busyReason:\s*piBusyReason/g)].length;
    return hits >= 2 || `只接到 ${hits} 处`;
  });
  await check('G3. 两个模块共用 launch identity / 缓存失效两个原语', () => {
    const src = read('server.js');
    const want = ['resolveUpdaterTarget: () => resolvePiCliEntry()', 'resolveInstallTarget: () => resolvePiCliEntry()',
      'invalidateCaches: invalidatePiCaches'];
    const miss = want.filter((t) => !src.includes(t));
    return miss.length === 0 || '缺少：' + miss.join(', ');
  });
  await check('G4. router 有 /api/capabilities/install，且排在 405 兜底之前', () => {
    const router = read('server/router.js');
    const route = router.indexOf("'/api/capabilities/install'");
    const fallback = router.indexOf("if (req.method !== 'GET')");
    return (route !== -1 && fallback !== -1 && route < fallback) || `route@${route} fallback@${fallback}`;
  });
  await check('G5. 超时默认值够长（npm 拉包比更新慢）', () =>
    DEFAULT_INSTALL_TIMEOUT_MS >= 5 * 60 * 1000 || DEFAULT_INSTALL_TIMEOUT_MS);

  /* ================= H. HTTP 层 ================= */
  section('H. HTTP 层');

  await check('H1. 非 POST → 405', async () => {
    const { install } = harness();
    const res = mockRes();
    await install.handle(mockReq({ method: 'GET' }), res, null, jsonRecorder(res));
    return res.code === 405 || res.code;
  });
  await check('H2. 请求体不是合法 JSON → 400', async () => {
    const { install } = harness();
    const res = mockRes();
    const req = mockReq();
    const p = install.handle(req, res, null, jsonRecorder(res));
    req.emit('data', Buffer.from('{not json', 'utf8'));
    req.emit('end');
    await p;
    return res.code === 400 || res.code;
  });
  await check('H3. 未知 capability → 200 + ok:false（业务拒绝不是协议错误）', async () => {
    const { install } = harness();
    const res = mockRes();
    const req = mockReq();
    const p = install.handle(req, res, null, jsonRecorder(res));
    req.emit('data', Buffer.from(JSON.stringify({ capabilityId: 'nope', confirm: true }), 'utf8'));
    req.emit('end');
    await p;
    return (res.code === 200 && res.payload.ok === false && res.payload.code === 'unknown-capability')
      || JSON.stringify(res.payload);
  });
  await check('H4. 合法请求 → 200 + ok:true，且 argv 是固定的那三个', async () => {
    const { install, state } = harness();
    const res = mockRes();
    const req = mockReq();
    const p = install.handle(req, res, null, jsonRecorder(res));
    req.emit('data', Buffer.from(JSON.stringify({ capabilityId: 'web', confirm: true, __expectedCwd: '' }), 'utf8'));
    req.emit('end');
    await p;
    return (res.code === 200 && res.payload.ok === true
      && JSON.stringify(state.runArgs[0]) === JSON.stringify(['install', 'npm:pi-web-access', '--no-approve']))
      || JSON.stringify({ code: res.code, payload: res.payload });
  });
  await check('H5. isRunning() 反映真实在飞状态（前端 disabled 之外的第二个真相）', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { install } = harness({ runGate: gate });
    const running = install.start({ capabilityId: 'memory', confirm: true });
    const during = install.isRunning();
    release();
    await running;
    return (during === true && install.isRunning() === false) || JSON.stringify({ during, after: install.isRunning() });
  });

  /* ================= I. 受控包操作：source 形状与固定 argv ================= */
  section('I. 受控包操作：source 形状与固定 argv');

  /* 不可见 / 形近字符一律用 charCode 造，源码里不出现它们的字面量。 */
  const ZWSP = String.fromCharCode(0x200b);
  const CYRILLIC_O = String.fromCharCode(0x043e);
  const NUL = String.fromCharCode(0);
  const ESC = String.fromCharCode(27);
  const rejected = (list) => {
    const hit = list.filter((value) => isControlledSource(value));
    return hit.length === 0 || '放行了：' + hit.map((value) => JSON.stringify(value)).join(' | ');
  };
  const deepSame = (got, want) => {
    try {
      require('node:assert/strict').deepEqual(got, want);
      return true;
    } catch {
      return JSON.stringify(got);
    }
  };
  /** 结果里所有字符串值（递归）。用来查「某段原文有没有出后端」，不受 JSON 转义影响。 */
  const stringsOf = (value, out = []) => {
    if (typeof value === 'string') out.push(value);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) stringsOf(v, out);
    return out;
  };

  await check('I1. 严格包名（可带 scope）通过', () => {
    const ok = ['npm:pi-memory', 'npm:a', 'npm:0day', 'npm:a.b_c-d', 'npm:@scope/pkg', 'npm:@a1/b2.c',
      'npm:@pi-tools/web_search', 'npm:' + 'a'.repeat(214)];
    const bad = ok.filter((value) => !isControlledSource(value));
    return bad.length === 0 || '被拒：' + bad.join(' | ');
  });
  await check('I2. 带版本 / 标签 / 区间的一律拒绝（版本只由 Pi 自己解析）', () =>
    rejected(['npm:foo@1.2.3', 'npm:foo@latest', 'npm:foo@^1.0.0', 'npm:@a/b@1.0.0', 'npm:foo@', 'npm:@a/b@']));
  await check('I3. 选项形态、以 - . _ 开头的名字拒绝（哪一层都不可能把它当成选项或隐藏目录）', () =>
    rejected(['npm:--registry=https://evil.example', 'npm:-l', 'npm:-foo', 'npm:.foo', 'npm:_foo', 'npm:@-a/b',
      'npm:@a/-b', 'npm:@a/.b', 'npm:@.a/b', 'npm:@a/_b', '--no-approve', '-l', '--extension']));
  await check('I4. 路径段 / 目录穿越拒绝', () =>
    rejected(['npm:../x', 'npm:..', 'npm:.', 'npm:a/b', 'npm:@a/b/c', 'npm:@a/../b', 'npm:@a/..', 'npm:@a/', 'npm:@/b',
      'npm:@a', 'npm:a\\b', 'npm:/abs', 'npm:C:\\x', 'npm:@a//b', 'npm:@a\\b']));
  await check('I5. 空白 / 换行 / NUL / shell 元字符 / 引号拒绝', () =>
    rejected(['npm:foo bar', ' npm:foo', 'npm:foo ', 'npm: foo', 'npm:foo\n', 'npm:foo\nbar', 'npm:foo\r', 'npm:foo\t',
      'npm:foo' + NUL, 'npm:foo;rm', 'npm:foo&&x', 'npm:foo|x', 'npm:$(x)', 'npm:`x`', 'npm:foo>x', 'npm:foo<x',
      'npm:foo"x', "npm:foo'x", 'npm:foo%20x', 'npm:foo*', 'npm:foo?', 'npm:foo#x', 'npm:foo=x', 'npm:foo,x',
      'npm:foo:x', 'npm:foo~x', 'npm:foo!x', 'npm:foo^x', 'npm:foo(x)', 'npm:foo{x}', 'npm:foo[x]']));
  await check('I6. 大写 / 非 ASCII / 零宽字符拒绝（看起来像另一个包的名字进不来）', () =>
    rejected(['npm:Foo', 'npm:PI-MEMORY', 'npm:@Scope/pkg', 'NPM:foo', 'Npm:foo', 'npm:pi-mem' + CYRILLIC_O + 'ry',
      'npm:pi' + ZWSP + '-memory', 'npm:' + String.fromCharCode(0x5305)]));
  await check('I7. 别的来源种类拒绝（git / https / github / file / 裸包名 / 本地路径 / builtin）', () =>
    rejected(['git:github.com/a/b', 'https://github.com/a/b', 'github:a/b', 'file:../x', 'pi-memory', './x', 'C:\\x',
      'ssh://git@github.com/a/b', 'builtin:x', 'npm', 'npm:']));
  await check('I8. 空值 / 非字符串 / 超长拒绝', () =>
    rejected(['', null, undefined, 42, true, {}, ['npm:foo'], { toString: () => 'npm:foo' }, 'npm:' + 'a'.repeat(215)]));
  await check('I9. 三个动作各只有一种 argv（没有 -l / --approve / --all / --self / --force）', () => {
    const want = {
      install: ['install', 'npm:x', '--no-approve'],
      remove: ['remove', 'npm:x', '--no-approve'],
      update: ['update', '--extension', 'npm:x', '--no-approve'],
    };
    const direct = { install: buildInstallArgs('npm:x'), remove: buildRemoveArgs('npm:x'), update: buildUpdateArgs('npm:x') };
    if (deepSame(direct, want) !== true) return JSON.stringify(direct);
    const banned = ['-l', '--local', '--approve', '-a', '--all', '--self', '--extensions', '--models', '--force', 'self', 'pi'];
    for (const [action, def] of Object.entries(PACKAGE_OPERATIONS)) {
      const args = def.buildArgs('npm:x');
      if (deepSame(args, want[action]) !== true) return `${action}: ${JSON.stringify(args)}`;
      const bad = args.filter((arg) => banned.includes(arg));
      if (bad.length) return `${action}: ${bad.join(',')}`;
    }
    return Object.keys(PACKAGE_OPERATIONS).join(',') === 'install,remove,update' || Object.keys(PACKAGE_OPERATIONS).join(',');
  });
  await check('I10. 动作表：未知动作 / 原型键 → null；三个动作的维护原因各不相同；表是冻结的', () => {
    const none = ['toggle', 'enable', 'disable', 'config', 'list', '', null, undefined, 1, '__proto__', 'constructor',
      'toString', 'hasOwnProperty', 'INSTALL', ' install'];
    const hit = none.filter((action) => packageOperation(action) !== null);
    if (hit.length) return '认了：' + hit.join(',');
    return (packageOperation('install').reason === 'capability-install' && packageOperation('remove').reason === 'extension-remove'
      && packageOperation('update').reason === 'extension-update'
      && Object.isFrozen(PACKAGE_OPERATIONS) && Object.isFrozen(PACKAGE_OPERATIONS.remove)) || JSON.stringify(PACKAGE_OPERATIONS);
  });

  /* ================= J. 受控包操作：闸门 ================= */
  section('J. 受控包操作：闸门');

  const op = (action = 'install', source = 'npm:demo-ext', extra = {}) => ({ action, source, ...extra });
  const yes = { confirm: true, __expectedCwd: '' };
  const untouched = (state) => state.paused.length === 0 && state.runArgs.length === 0 && state.resumed === 0;

  await check('J1. 未知动作（含原型键、缺省）→ unknown-action，不暂停、不执行', async () => {
    for (const action of ['toggle', 'enable', '__proto__', 'constructor', '', null, undefined]) {
      const { install, state } = harness();
      const r = await install.startOperation(yes, { action, source: 'npm:demo-ext' });
      if (!(r.ok === false && r.code === 'unknown-action')) return `${String(action)} → ${JSON.stringify(r)}`;
      if (!untouched(state)) return `${String(action)} 竟然动了 Pi`;
    }
    const { install, state } = harness();
    const none = await install.startOperation(yes);
    const nullOp = await install.startOperation(yes, null);
    return (none.code === 'unknown-action' && nullOp.code === 'unknown-action' && untouched(state)) || JSON.stringify({ none, nullOp });
  });
  await check('J2. 没有显式确认 → confirm-required（confirm 必须是布尔 true）', async () => {
    for (const body of [{}, { confirm: 'true' }, { confirm: 1 }, null, undefined, 'x', [{ confirm: true }]]) {
      const { install, state } = harness();
      const r = await install.startOperation(body, op());
      if (!(r.ok === false && r.code === 'confirm-required')) return `${JSON.stringify(body)} → ${JSON.stringify(r)}`;
      if (!untouched(state)) return `${JSON.stringify(body)} 竟然动了 Pi`;
    }
    return true;
  });
  await check('J3. source 形状不对 → source-rejected（调用方解析错了也过不了这一关）', async () => {
    const bad = ['npm:demo-ext@1.0.0', 'npm:../x', 'npm:--registry=https://evil.example', 'git:github.com/a/b',
      'demo-ext', '', null, undefined, ['npm:demo-ext'], 'npm:demo-ext\n--all'];
    for (const action of ['install', 'remove', 'update']) {
      for (const source of bad) {
        const { install, state } = harness();
        const r = await install.startOperation(yes, { action, source });
        if (!(r.ok === false && r.code === 'source-rejected')) return `${action}/${JSON.stringify(source)} → ${JSON.stringify(r)}`;
        if (!untouched(state)) return `${action}/${JSON.stringify(source)} 竟然动了 Pi`;
      }
    }
    return true;
  });
  await check('J4. 工作区过期 / 忙 / 忙判据抛错 / 没有官方入口 → 各自的 code，都不动 Pi', async () => {
    const cases = () => [
      [harness({ currentCwd: () => 'C:\\new' }), { confirm: true, __expectedCwd: 'C:\\old' }, 'workspace-stale'],
      [harness({ currentCwd: () => 'C:\\new' }), { confirm: true, expectedCwd: 'C:\\old' }, 'workspace-stale'],
      [harness({ busy: { code: 'busy-turn', error: '正在生成' } }), yes, 'busy-turn'],
      [harness({ busy: { code: 'busy-pi-update', error: 'Pi 正在更新' } }), yes, 'busy-pi-update'],
      [harness({ busy: { code: 'busy-install', error: '另一个操作' } }), yes, 'busy-install'],
      [harness({ busy: () => { throw new Error('probe 坏了'); } }), yes, 'busy-unknown'],
      [harness({ resolveOk: false }), yes, 'unsupported'],
    ];
    for (const action of ['install', 'remove', 'update']) {
      for (const [h, body, code] of cases()) {
        const r = await h.install.startOperation(body, op(action));
        if (!(r.ok === false && r.code === code)) return `${action}/${code} → ${JSON.stringify(r)}`;
        if (!untouched(h.state)) return `${action}/${code} 竟然动了 Pi`;
      }
    }
    return true;
  });
  await check('J5. 工作区没变就放行（__expectedCwd 只用于比较）', async () => {
    const { install, state } = harness({ currentCwd: () => 'C:\\same' });
    const r = await install.startOperation({ confirm: true, __expectedCwd: 'C:\\same' }, op('update'));
    return (r.ok === true && state.runArgs.length === 1 && !JSON.stringify(state.runArgs).includes('same')) || JSON.stringify(r);
  });
  await check('J6. 拒绝文案里的动词跟着动作走（卸载不会被说成安装）', async () => {
    const a = await harness({ resolveOk: false }).install.startOperation(yes, op('remove'));
    const b = await harness().install.startOperation({}, op('update'));
    const c = await harness({ currentCwd: () => 'C:\\new' }).install.startOperation({ confirm: true, __expectedCwd: 'C:\\old' }, op('remove'));
    return (a.error.includes('卸载') && !a.error.includes('安装') && b.error.includes('更新') && c.error.includes('卸载'))
      || JSON.stringify({ a: a.error, b: b.error, c: c.error });
  });
  await check('J7. 请求体对 argv 没有任何影响（source / args / command / action 一概不读）', async () => {
    for (const action of ['install', 'remove', 'update']) {
      const { install, state } = harness();
      const r = await install.startOperation({
        confirm: true, action: 'install', source: 'npm:evil-package', id: 'npm:evil-package', name: 'evil',
        args: ['--all', '--self'], command: 'rm', flags: ['-l'], registry: 'https://evil.example', capabilityId: 'memory',
      }, op(action, 'npm:demo-ext'));
      if (r.ok !== true) return `${action} → ${JSON.stringify(r)}`;
      if (state.runArgs.length !== 1) return `${action}: runner 调了 ${state.runArgs.length} 次`;
      if (deepSame(state.runArgs[0], PACKAGE_OPERATIONS[action].buildArgs('npm:demo-ext')) !== true) {
        return `${action}: ${JSON.stringify(state.runArgs[0])}`;
      }
      if (r.source !== 'npm:demo-ext' || r.action !== action || 'capabilityId' in r) return `${action}: ${JSON.stringify(r)}`;
    }
    return true;
  });

  /* ================= K. 受控包操作：单飞 ================= */
  section('K. 受控包操作：与已知能力安装共用一把锁');

  await check('K1. 已知能力安装在跑 → 包操作被拒（operation-running）；runner 只跑一次', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { install, state } = harness({ runGate: gate });
    const first = install.start(good('web'));
    const second = await install.startOperation(yes, op('remove'));
    release();
    const r1 = await first;
    return (r1.ok === true && second.ok === false && second.code === 'operation-running' && state.runArgs.length === 1)
      || JSON.stringify({ r1, second, runs: state.runArgs.length });
  });
  await check('K2. 包操作在跑 → 已知能力安装被拒（install-running，P24 的 code 不变）', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { install, state } = harness({ runGate: gate });
    const first = install.startOperation(yes, op('update'));
    const second = await install.start(good('web'));
    release();
    const r1 = await first;
    return (r1.ok === true && second.ok === false && second.code === 'install-running' && state.runArgs.length === 1)
      || JSON.stringify({ r1, second, runs: state.runArgs.length });
  });
  await check('K3. 包操作在跑 → 另一个包操作被拒；跑完后锁释放', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { install, state } = harness({ runGate: gate });
    const first = install.startOperation(yes, op('update'));
    const during = install.isRunning();
    const second = await install.startOperation(yes, op('install', 'npm:other-ext'));
    release();
    await first;
    const after = install.isRunning();
    const third = await install.startOperation(yes, op('install', 'npm:other-ext'));
    return (during === true && second.code === 'operation-running' && after === false && third.ok === true
      && state.runArgs.length === 2) || JSON.stringify({ during, second, after, third, runs: state.runArgs.length });
  });
  await check('K4. 上锁是同步的：同一个 tick 里发两次，第二次一定被拒', async () => {
    const { install, state } = harness();
    const [a, b] = await Promise.all([install.startOperation(yes, op('install')), install.startOperation(yes, op('install'))]);
    return (a.ok === true && b.ok === false && b.code === 'operation-running' && state.runArgs.length === 1)
      || JSON.stringify({ a, b, runs: state.runArgs.length });
  });

  /* ================= L. 受控包操作：执行、失败与恢复 ================= */
  section('L. 受控包操作：执行、失败与恢复');

  await check('L1. 维护原因跟着动作走（前端据此选措辞）', async () => {
    const want = { install: 'capability-install', remove: 'extension-remove', update: 'extension-update' };
    for (const [action, reason] of Object.entries(want)) {
      const { install, state } = harness();
      await install.startOperation(yes, op(action));
      if (state.paused.length !== 1 || state.paused[0] !== reason) return `${action}: ${state.paused.join(',')}`;
    }
    return true;
  });
  await check('L2. 成功：pause → run → 清缓存 → resume；只回「命令跑完了」，loaded=null', async () => {
    const { install, state } = harness({ runResult: { ok: true, exitCode: 0, stdout: 'Installed npm:demo-ext\n', stderr: '' } });
    const r = await install.startOperation(yes, op('install'));
    const seq = state.sequence.join('>');
    if (seq !== 'pause>run>invalidate>resume') return seq;
    return deepSame(r, { ok: true, code: 'command-completed', action: 'install', source: 'npm:demo-ext', commandCompleted: true,
      commandStarted: true, exitCode: 0, restarted: true, outcome: null, loaded: null });
  });
  await check('L3. runner 只拿到：闸门检查过的那份入口 + 超时 + 输出上限', async () => {
    const { install, state } = harness();
    await install.startOperation(yes, op('update'));
    const opts = state.runOpts[0];
    return (opts.entry === entry && opts.timeoutMs === DEFAULT_INSTALL_TIMEOUT_MS && opts.maxStdoutBytes === 4000
      && Object.keys(opts).sort().join(',') === 'entry,maxStdoutBytes,timeoutMs') || JSON.stringify(Object.keys(opts));
  });
  await check('L4. update 的 stdout 结论：四种都认（含带 ANSI 着色的），认不出就是 null', () => {
    const cases = [
      ['Skipped package updates (offline mode)\n', 'skipped-offline'],
      ['Updated 1 package:\n  npm:demo-ext\n', 'updated'],
      ['Updated 12 packages:\n  a\n  b\n', 'updated'],
      ['npm:demo-ext was not updated, see the warnings above\n', 'not-updated'],
      ['npm:demo-ext is already up to date\n', 'up-to-date'],
      [`${ESC}[32mnpm:demo-ext is already up to date${ESC}[39m\n`, 'up-to-date'],
      [`${ESC}[33mSkipped package updates (offline mode)${ESC}[39m`, 'skipped-offline'],
      [`${ESC}[32mUpdated 2 packages:${ESC}[39m\n  a\n  b\n`, 'updated'],
      ['a sentence a later Pi might print instead', null],
      ['', null],
    ];
    for (const [text, want] of cases) if (updateOutcome(text) !== want) return `${JSON.stringify(text)} → ${updateOutcome(text)}`;
    return (updateOutcome(null) === null && updateOutcome(undefined) === null && updateOutcome({}) === null) || '非字符串没有回 null';
  });
  await check('L5. outcome 只出现在 update 的成功结果里（install / remove 恒为 null）', async () => {
    const out = { ok: true, exitCode: 0, stdout: 'npm:demo-ext is already up to date\n', stderr: '' };
    const a = await harness({ runResult: out }).install.startOperation(yes, op('update'));
    const b = await harness({ runResult: out }).install.startOperation(yes, op('install'));
    const c = await harness({ runResult: out }).install.startOperation(yes, op('remove'));
    return (a.outcome === 'up-to-date' && b.outcome === null && c.outcome === null) || JSON.stringify([a.outcome, b.outcome, c.outcome]);
  });
  await check('L6. 失败 code 以动作名开头：-failed / -timeout / -spawn-failed，并带回身份', async () => {
    for (const action of ['install', 'remove', 'update']) {
      const failed = await harness({ runResult: { ok: false, exitCode: 1, stdout: '', stderr: 'boom' } }).install.startOperation(yes, op(action));
      const timedOut = await harness({ runResult: { ok: false, timedOut: true, error: '超时（600s）' } }).install.startOperation(yes, op(action));
      const spawn = await harness({ runResult: { ok: false, spawnFailed: true, error: '无法启动' } }).install.startOperation(yes, op(action));
      const threw = await harness({ runResult: new Error('runner 炸了') }).install.startOperation(yes, op(action));
      const got = [failed.code, timedOut.code, spawn.code, threw.code].join(',');
      const want = [`${action}-failed`, `${action}-timeout`, `${action}-spawn-failed`, `${action}-spawn-failed`].join(',');
      if (got !== want) return got;
      if (![failed, timedOut, spawn, threw].every((r) => r.ok === false && r.action === action && r.source === 'npm:demo-ext')) {
        return `${action}: 身份字段不对`;
      }
      const started = [failed.commandStarted, timedOut.commandStarted, spawn.commandStarted, threw.commandStarted].join(',');
      if (started !== 'true,true,false,false') return `${action}: commandStarted = ${started}`;
    }
    return true;
  });
  await check('L7. 起来过的失败要清缓存（可能已经动了磁盘）；没起来的不清；两种都恢复 bridge', async () => {
    const ran = harness({ runResult: { ok: false, exitCode: 1, stderr: 'boom' } });
    await ran.install.startOperation(yes, op('install'));
    const killed = harness({ runResult: { ok: false, timedOut: true, error: '超时' } });
    await killed.install.startOperation(yes, op('update'));
    const never = harness({ runResult: { ok: false, spawnFailed: true, error: '无法启动' } });
    await never.install.startOperation(yes, op('install'));
    return (ran.state.sequence.join('>') === 'pause>run>invalidate>resume'
      && killed.state.invalidated === 1 && killed.state.resumed === 1
      && never.state.invalidated === 0 && never.state.resumed === 1)
      || JSON.stringify({ ran: ran.state.sequence, killed: killed.state.sequence, never: never.state.sequence });
  });
  await check('L8. 暂停失败三种：都不执行、不 resume、commandStarted=false', async () => {
    const want = { 'pause-failed': 'pause-failed', 'pause-timeout': 'pause-timeout', 'already-in-maintenance': 'operation-running' };
    for (const [code, expected] of Object.entries(want)) {
      const { install, state } = harness({ pause: { ok: false, code } });
      const r = await install.startOperation(yes, op('remove'));
      if (!(r.ok === false && r.code === expected && r.commandStarted === false && r.action === 'remove')) {
        return `${code} → ${JSON.stringify(r)}`;
      }
      if (state.runArgs.length || state.resumed || state.invalidated) return `${code} 竟然动了 Pi`;
    }
    return true;
  });
  await check('L9. 暂停自己 reject / 同步抛错 → 失败，不执行、不 resume（不当成暂停成功）', async () => {
    const counts = { ran: 0, resumed: 0 };
    const make = (pauseBridge) => createCapabilityInstall({
      resolveInstallTarget: () => ({ ok: true, entry }),
      runInstall: async () => { counts.ran += 1; return { ok: true, exitCode: 0 }; },
      pauseBridge,
      resumeBridge: () => { counts.resumed += 1; },
      busyReason: () => null,
    });
    const a = await make(async () => { throw new Error('bridge 坏了'); }).startOperation(yes, op('install'));
    const b = await make(() => { throw new Error('bridge 坏了'); }).startOperation(yes, op('install'));
    return (a.ok === false && a.code === 'pause-failed' && b.ok === false && b.commandStarted === false
      && counts.ran === 0 && counts.resumed === 0) || JSON.stringify({ a, b, counts });
  });
  await check('L10. resume 自己抛错不会盖掉结果（成功仍是成功，失败仍是那个失败）', async () => {
    const make = (runResult) => createCapabilityInstall({
      resolveInstallTarget: () => ({ ok: true, entry }),
      runInstall: async () => runResult,
      pauseBridge: async () => ({ ok: true }),
      resumeBridge: () => { throw new Error('resume 炸了'); },
      busyReason: () => null,
    });
    const good2 = await make({ ok: true, exitCode: 0 }).startOperation(yes, op('remove'));
    const bad2 = await make({ ok: false, exitCode: 1, stderr: 'npm error code ENOSPC' }).startOperation(yes, op('remove'));
    return (good2.ok === true && good2.code === 'command-completed' && bad2.code === 'remove-failed' && bad2.cause === 'disk-full')
      || JSON.stringify({ good2, bad2 });
  });
  await check('L11. 失败原因的粗分类只回枚举；认不出就是 null', () => {
    const cases = [
      [{ stderr: 'No matching package found for npm:demo-ext' }, 'not-configured'],
      [{ stderr: `${ESC}[31mNo matching package found for npm:demo-ext${ESC}[39m` }, 'not-configured'],
      [{ stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/demo-ext' }, 'package-not-found'],
      [{ stderr: "npm error 404  'demo-ext@*' is not in this registry." }, 'package-not-found'],
      [{ stderr: 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/demo-ext failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org' }, 'network'],
      [{ stderr: 'npm error code ETIMEDOUT' }, 'network'],
      [{ stderr: 'npm error code ECONNRESET' }, 'network'],
      [{ stderr: 'npm error code EAI_AGAIN' }, 'network'],
      [{ stderr: 'npm error code EPERM\nnpm error syscall rename' }, 'permission'],
      [{ stderr: 'Error: EACCES: permission denied, mkdir' }, 'permission'],
      [{ stderr: 'npm error code EBUSY' }, 'permission'],
      [{ stderr: 'npm error code ENOSPC\nnpm error nospc ENOSPC: no space left on device' }, 'disk-full'],
      [{ stderr: 'npm error code EINTEGRITY' }, 'integrity'],
      [{ stderr: 'npm error code ETARGET\nnpm error notarget No matching version found for demo-ext@^9' }, 'version-unresolved'],
      [{ stderr: 'Error: spawn npm ENOENT' }, 'package-manager-missing'],
      [{ stderr: "'npm' is not recognized as an internal or external command" }, 'package-manager-missing'],
      [{ stdout: 'npm error code ENOTFOUND', stderr: '' }, 'network'],
      [{ stderr: 'a failure nobody has seen before' }, null],
      [{ stderr: '', stdout: '' }, null],
      [{}, null],
      [null, null],
    ];
    for (const [raw, want] of cases) if (failureCause(raw) !== want) return `${JSON.stringify(raw)} → ${failureCause(raw)}`;
    return true;
  });
  await check('L12. 失败结果：cause 是枚举、error 是一行脱敏摘要；stdout / stderr 原文不出后端', async () => {
    const { install } = harness({ runResult: { ok: false, exitCode: 1, stdout: 'SECRET-OUT-LINE',
      stderr: 'npm error code ENOTFOUND at C:\\Users\\me\\AppData\\npm-cache token=abcdef\nSECOND-LINE-SECRET' } });
    const r = await install.startOperation(yes, op('install'));
    const all = stringsOf(r).join('\n');
    return (r.cause === 'network' && !('stdout' in r) && !('stderr' in r) && !all.includes('SECRET-OUT-LINE')
      && !all.includes('SECOND-LINE-SECRET') && !all.includes('C:\\Users\\me') && !all.includes('abcdef')
      && r.error.includes('<path>') && !r.error.includes('\n')) || JSON.stringify(r);
  });
  await check('L13. 成功结果里同样没有 stdout / stderr / 入口路径 / 命令', async () => {
    const { install } = harness({ runResult: { ok: true, exitCode: 0, stdout: 'SECRET-OUT', stderr: 'SECRET-ERR' } });
    const r = await install.startOperation(yes, op('update'));
    const all = stringsOf(r).join('\n');
    const hit = ['SECRET-OUT', 'SECRET-ERR', '/pkg/dist/bundle/cli.js', process.execPath, '--no-approve'].filter((t) => all.includes(t));
    const keys = ['stdout', 'stderr', 'entry', 'args', 'argv', 'command', 'env'].filter((key) => key in r);
    return (hit.length === 0 && keys.length === 0) || `${hit.join(',')} | ${keys.join(',')}`;
  });

  /* ================= M. 受控包操作：锁内复核 ================= */
  section('M. 受控包操作：锁内复核（finish）');

  await check('M1. finish 在 resume 之后、解锁之前跑，拿到的是命令的结果', async () => {
    const { install, state } = harness();
    const seen = { result: null, running: null, seq: null };
    const r = await install.startOperation(yes, op('install', 'npm:demo-ext', {
      finish: (result) => {
        seen.result = result;
        seen.running = install.isRunning();
        seen.seq = state.sequence.join('>');
      },
    }));
    return (seen.result && seen.result.code === 'command-completed' && seen.running === true
      && seen.seq === 'pause>run>invalidate>resume' && install.isRunning() === false && r === seen.result)
      || JSON.stringify({ seen, after: install.isRunning() });
  });
  await check('M2. finish 可以替换结果（同步或异步）；替换后的才是最终结果与 snapshot', async () => {
    const { install } = harness();
    const a = await install.startOperation(yes, op('install', 'npm:demo-ext', {
      finish: (result) => ({ ...result, code: 'installed', verified: true }),
    }));
    const b = await install.startOperation(yes, op('remove', 'npm:demo-ext', {
      finish: async (result) => {
        await null;
        return { ...result, ok: false, code: 'unverified', verified: false };
      },
    }));
    const snap = install.snapshot();
    return (a.code === 'installed' && a.verified === true && b.ok === false && b.code === 'unverified'
      && snap.ok === false && snap.code === 'unverified' && snap.action === 'remove' && snap.capabilityId === null
      && snap.running === false) || JSON.stringify({ a, b, snap });
  });
  await check('M3. finish 还没回来时锁没放：第二个操作（两条入口都算）被拒', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { install, state } = harness();
    const first = install.startOperation(yes, op('install', 'npm:demo-ext', {
      finish: async (result) => {
        await gate;
        return result;
      },
    }));
    /* 等命令跑完、Pi 已恢复、进入 finish：判据是「已经 resume」，不是时间。 */
    while (state.resumed === 0) await new Promise((r) => setImmediate(r));
    const second = await install.startOperation(yes, op('install', 'npm:other-ext'));
    const legacy = await install.start(good('web'));
    const during = install.isRunning();
    release();
    await first;
    return (second.code === 'operation-running' && legacy.code === 'install-running' && during === true
      && state.runArgs.length === 1 && install.isRunning() === false)
      || JSON.stringify({ second, legacy, during, runs: state.runArgs.length });
  });
  await check('M4. finish 抛错 / reject → 命令的结论照旧，只是 verified=null；锁照样放', async () => {
    const { install } = harness();
    const thrown = await install.startOperation(yes, op('update', 'npm:demo-ext', { finish: () => { throw new Error('读盘炸了'); } }));
    const rejected2 = await install.startOperation(yes, op('update', 'npm:demo-ext', { finish: async () => { throw new Error('读盘炸了'); } }));
    return (thrown.ok === true && thrown.code === 'command-completed' && thrown.verified === null && thrown.commandStarted === true
      && rejected2.ok === true && rejected2.verified === null && install.isRunning() === false)
      || JSON.stringify({ thrown, rejected2 });
  });
  await check('M5. 闸门拒绝的不调 finish；真正执行过的（含命令失败、暂停失败）都调', async () => {
    let calls = 0;
    const finish = (result) => {
      calls += 1;
      return result;
    };
    await harness().install.startOperation({}, op('install', 'npm:demo-ext', { finish }));
    await harness({ busy: { code: 'busy-turn', error: 'x' } }).install.startOperation(yes, op('install', 'npm:demo-ext', { finish }));
    await harness({ resolveOk: false }).install.startOperation(yes, op('install', 'npm:demo-ext', { finish }));
    await harness({ currentCwd: () => 'C:\\new' }).install.startOperation({ confirm: true, __expectedCwd: 'C:\\old' }, op('install', 'npm:demo-ext', { finish }));
    await harness().install.startOperation(yes, { action: 'install', source: 'npm:bad@1', finish });
    await harness().install.startOperation(yes, { action: 'toggle', source: 'npm:demo-ext', finish });
    if (calls !== 0) return `闸门拒绝也调了 finish：${calls}`;
    await harness({ runResult: { ok: false, exitCode: 1, stderr: 'boom' } }).install.startOperation(yes, op('install', 'npm:demo-ext', { finish }));
    await harness({ pause: { ok: false, code: 'pause-timeout' } }).install.startOperation(yes, op('install', 'npm:demo-ext', { finish }));
    await harness().install.startOperation(yes, op('install', 'npm:demo-ext', { finish }));
    return calls === 3 || calls;
  });
  await check('M6. 已知能力安装那条入口不受影响：没有复核钩子，形状还是 P24 的', async () => {
    const { install } = harness();
    const r = await install.start(good('memory'));
    return deepSame(r, { ok: true, code: 'installed', phase: 'installed', capabilityId: 'memory', source: 'npm:pi-memory',
      commandCompleted: true, exitCode: 0, restarted: true, loaded: null });
  });

  /* ================= N. 受控包操作：可用性与装配 ================= */
  section('N. 受控包操作：可用性与装配');

  await check('N1. available() 跟着「有没有可证明的官方入口」走（判断不了 = 不可用）', () =>
    (harness().install.available() === true && harness({ resolveOk: false }).install.available() === false
      && createCapabilityInstall({}).available() === false
      && createCapabilityInstall({ resolveInstallTarget: () => { throw new Error('x'); } }).available() === false
      && createCapabilityInstall({ resolveInstallTarget: () => ({ ok: true }) }).available() === false) || 'available() 判断不对');
  await check('N2. server.js：包清单与市场接在同一个执行器上（后端没有第二条安装路径）', () => {
    const src = read('server.js');
    const want = ['createExtensionPackages({', 'createExtensionMarket({', 'catalog: extensionMarket',
      'readInstalled: () => extensionPackagesRef?.installedIndex() ?? null'];
    const miss = want.filter((t) => !src.includes(t));
    const ops = [...src.matchAll(/operations:\s*capabilityInstall\b/g)].length;
    return (miss.length === 0 && ops === 2) || `缺少：${miss.join(', ')}；operations 接了 ${ops} 处`;
  });
  await check('N3. router：三条新路由是精确路径、排在 405 兜底之前、先过本机 Host 检查', () => {
    const router = read('server/router.js');
    const block = /if \(url\.pathname === '\/api\/extensions\/packages'[\s\S]*?\n    \}/.exec(router);
    if (!block) return '找不到新路由';
    const fallback = router.indexOf("if (req.method !== 'GET')");
    return (router.indexOf(block[0]) < fallback && block[0].includes("=== '/api/extensions/market'")
      && block[0].includes("=== '/api/extensions/market/item'") && !/startsWith/.test(block[0])
      && block[0].indexOf('denyLocalHost') < block[0].indexOf('.handle(')) || block[0];
  });
  await check('N4. 两个新模块自己不起进程、不拼命令行（只有 capability-install 这一条出口）', () => {
    for (const rel of ['server/extension-packages.js', 'server/extension-market.js', 'server/extension-market-catalog.js']) {
      const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/child_process|spawn\(|execFile|execSync|runCli|runPiCliCommand/.test(src)) return `${rel} 出现了进程启动`;
    }
    return true;
  });
  await check('N5. 忙判据的措辞覆盖三个动作（不再只说「安装」），code 不变', () => {
    const body = /function piBusyReason\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(read('server.js'));
    return (body && /capabilityInstall\.isRunning\(\)\) return \{ code: 'busy-install', error: '[^']*安装、卸载或更新/.test(body[1]))
      || '措辞或 code 变了';
  });

  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error('失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
