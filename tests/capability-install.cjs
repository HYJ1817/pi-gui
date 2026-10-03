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
  await check('F4. 共享的 CLI 出口只传 env:{}（令牌由 runCli 剔除，这一层不拼环境）', () => {
    const body = /function runPiCliCommand\([\s\S]*?\n\}/.exec(read('server.js'));
    if (!body) return '找不到 runPiCliCommand';
    return (/env:\s*\{\s*\}/.test(body[0]) && !/PI_GUI_TOKEN/.test(body[0])) || 'runPiCliCommand 在拼环境';
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

  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error('失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
