/* Pi 兼容层的测试（server/pi-compat.js）。
 *
 * **完全 fixture 驱动** —— 不启动 pi、不碰磁盘、不联网。所有输入都是「上游可能
 * 发来的形状」，这正是要覆盖的东西。
 *
 * 用法：node tests/pi-compat.cjs
 */
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

(async () => {
  const { createPiCompat, sessionMessageBody, messagesList, piState, CAPABILITIES } = await import('../server/pi-compat.js');

  /* 注意 `'version' in opts`：显式传 null（模拟「读不到版本」）不能被 `??` 兜回默认值。 */
  const mk = (opts = {}) =>
    createPiCompat({ piVersionProbe: () => ('version' in opts ? opts.version : '0.87.0'), now: () => 1700000000000 });

  /* 一套「完全正常的 pi」会发的东西 —— 后面多个用例在此基础上增删。 */
  function healthySessionCompat(opts = {}) {
    const c = mk(opts);
    c.observeBridge({ state: 'starting' });
    c.observeBridge({ state: 'ready' });
    c.observeUpstream({ type: 'response', command: 'get_state', success: true, data: { sessionFile: 'C:/x/a.jsonl', sessionId: 'sid-1', sessionName: 'n', messageCount: 3 } });
    c.observeUpstream({ type: 'response', command: 'get_messages', success: true, data: { messages: [] } });
    c.observeUpstream({ type: 'response', command: 'new_session', success: true, data: {} });
    c.observeUpstream({ type: 'response', command: 'switch_session', success: true, data: { cancelled: false } });
    c.observeUpstream({ type: 'response', command: 'set_session_name', success: true, data: {} });
    c.observeUpstream({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash' });
    c.observeSessionScan({ attempted: 2, headerOk: 2, cwdOk: 2, namingSeen: true, shapes: { nested: true } });
    return c;
  }

  /* ================= A. 完全兼容 ================= */
  section('A. 完全兼容');

  {
    const r = healthySessionCompat().report();
    check('A1. status = compatible', () => r.status === 'compatible' || JSON.stringify(r.capabilities));
    check('A2. detected = true', () => r.detected === true);
    check('A3. 核心能力都是 true', () =>
      r.capabilities.rpc === true && r.capabilities.getState === true && r.capabilities.getMessages === true || JSON.stringify(r.capabilities));
    check('A4. 没有 missing', () => r.missing.length === 0 || JSON.stringify(r.missing));
    check('A5. 协议信封 observed 被确认', () => r.protocol.expected === 1 && r.protocol.observed === 1 || JSON.stringify(r.protocol));
    check('A6. 没有异常', () => r.issues.length === 0 || JSON.stringify(r.issues));
    check('A7. 版本作为证据一并给出', () => r.version === '0.87.0' && r.versionKnown === true || JSON.stringify({ v: r.version }));
  }

  /* ================= B. 缺可选能力 → partial ================= */
  section('B. 缺可选能力（局部降级，核心仍可用）');

  {
    const c = healthySessionCompat();
    // pi 明确回「不认识 set_session_name」
    c.observeUpstream({ type: 'response', command: 'set_session_name', success: false, error: 'unknown command' });
    const r = c.report();
    check('B1. status = partial（不是 incompatible）', () => r.status === 'partial' || JSON.stringify(r.capabilities));
    check('B2. sessionNaming 被标成不可用', () => r.capabilities.sessionNaming === false || JSON.stringify(r.capabilities));
    check('B3. 核心能力仍然 true（聊天不受影响）', () =>
      r.capabilities.rpc === true && r.capabilities.getState === true && r.capabilities.getMessages === true || JSON.stringify(r.capabilities));
    check('B4. missing 里点名了它', () => r.missing.includes('sessionNaming') || JSON.stringify(r.missing));
    check('B5. 记了一条 command-failed 异常', () =>
      r.issues.some((i) => i.operation === 'set_session_name' && i.issue === 'command-failed') || JSON.stringify(r.issues));
  }
  {
    const c = mk();
    c.observeBridge({ state: 'ready' });
    c.observeUpstream({ type: 'response', command: 'get_state', success: true, data: { sessionFile: 'p' } });
    // 会话文件能认出来，但一次 session_info 都没见过
    c.observeSessionScan({ attempted: 3, headerOk: 3, cwdOk: 3, namingSeen: false });
    const r = c.report();
    check('B6. 没见 session_info **不**判命名不可用（「没观察到」≠「不存在」）', () =>
      r.capabilities.sessionNaming === null || JSON.stringify({ v: r.capabilities.sessionNaming }));
    check('B7. 它出现在 unverified 而不是 missing', () =>
      r.unverified.includes('sessionNaming') && !r.missing.includes('sessionNaming') || JSON.stringify({ u: r.unverified, m: r.missing }));
  }

  /* ================= C. 缺核心能力 → incompatible ================= */
  section('C. 缺核心能力');

  {
    const c = mk();
    c.observeBridge({ state: 'error', error: 'spawn ENOENT' });
    const r = c.report();
    check('C1. spawn 失败 → rpc = false', () => r.capabilities.rpc === false || JSON.stringify(r.capabilities));
    check('C2. status = incompatible', () => r.status === 'incompatible' || r.status);
    check('C3. 异常里点名 spawn-failed（不含原始 error 文本）', () => {
      const a = r.issues.find((i) => i.issue === 'spawn-failed');
      return (a && !JSON.stringify(a).includes('ENOENT')) || JSON.stringify(r.issues);
    });
  }
  {
    const c = mk();
    c.observeBridge({ state: 'ready' });
    c.observeUpstream({ type: 'response', command: 'get_state', success: false, error: 'nope' });
    const r = c.report();
    check('C4. get_state 被明确拒绝 → incompatible', () => r.status === 'incompatible' || JSON.stringify(r.capabilities));
  }
  {
    // 起来了但从没 ready 就退出 → rpc-start-failed
    const c = mk();
    c.observeBridge({ state: 'exited', code: 1 });
    const r = c.report();
    check('C5. 从未 ready 就退出 → rpc-start-failed + incompatible', () =>
      (r.status === 'incompatible' && r.issues.some((i) => i.issue === 'rpc-start-failed')) || JSON.stringify(r));
  }
  {
    // ready 过之后崩了：只是崩溃，不该翻能力
    const c = mk();
    c.observeBridge({ state: 'ready' });
    c.observeUpstream({ type: 'response', command: 'get_state', success: true, data: { sessionFile: 'p' } });
    c.observeBridge({ state: 'exited', code: 1 });
    const r = c.report();
    check('C6. ready 过之后崩溃：不翻 rpc 能力，只记 unexpected-exit', () =>
      (r.capabilities.rpc === true && r.status === 'compatible' && r.issues.some((i) => i.issue === 'unexpected-exit')) ||
      JSON.stringify({ s: r.status, c: r.capabilities, i: r.issues }));
  }

  {
    /* ⚠️ 真实场景（桌面验收抓出来的）：Windows 上 pi 经 shell 启动，而
     * **cmd.exe 对不存在的命令「启动是成功的」** —— 会先报「不是内部或外部命令」
     * 再退出。于是 `bridge_status: ready` 会照常发出来。
     * 只看 ready 就会把这种情况判成 rpc 可用 → compatible（错的）。
     * 所以「说过话」才算数。 */
    const c = mk();
    c.observeBridge({ state: 'starting' });
    c.observeBridge({ state: 'ready' });
    c.observeBridge({ state: 'exited', code: 1 });
    const r = c.report();
    check('C7. ready 之后一句话没说就退出 → rpc-start-failed，不判 compatible', () =>
      (r.capabilities.rpc === false && r.status === 'incompatible' && r.issues.some((i) => i.issue === 'rpc-start-failed')) ||
      JSON.stringify({ s: r.status, c: r.capabilities, i: r.issues }));
  }
  {
    // 对照：说过话之后再退出 → 只是崩溃，rpc 仍是好的
    const c = mk();
    c.observeBridge({ state: 'ready' });
    c.observeUpstream({ type: 'response', command: 'get_state', success: true, data: { sessionFile: 'p' } });
    c.observeBridge({ state: 'exited', code: 1 });
    const r = c.report();
    check('C8. 说过话之后才退出 → 只记意外退出，rpc 不受影响', () =>
      (r.capabilities.rpc === true &&
        r.issues.some((i) => i.issue === 'unexpected-exit') &&
        !r.issues.some((i) => i.issue === 'rpc-start-failed')) || JSON.stringify(r.issues));
  }

  /* ================= D. 版本未知 ≠ 不兼容 ================= */
  section('D. 版本未知');

  {
    const c = healthySessionCompat({ version: null });
    const r = c.report();
    check('D1. 版本读不到 → compatible（**不是** incompatible）', () => r.status === 'compatible' || JSON.stringify(r));
    check('D2. versionKnown = false，version = null', () => r.version === null && r.versionKnown === false);
    check('D3. 版本未知本身不产生异常', () => r.issues.length === 0 || JSON.stringify(r.issues));
  }
  {
    // 探测函数直接抛，也不能带塌
    const c = createPiCompat({ piVersionProbe: () => { throw new Error('boom'); } });
    c.observeBridge({ state: 'ready' });
    c.observeUpstream({ type: 'response', command: 'get_state', success: true, data: { sessionFile: 'p' } });
    check('D4. 版本探测抛错 → 当作未知，不抛出去', () => {
      let ok = false;
      try {
        ok = c.report().version === null;
      } catch {
        ok = false;
      }
      return ok || 'report() 抛了';
    });
  }

  /* ================= E. 新增未知字段 ================= */
  section('E. 上游新增未知字段');

  {
    const c = healthySessionCompat();
    c.observeUpstream({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionFile: 'p', someNewField: { a: 1 }, anotherOne: [1, 2, 3] },
    });
    c.observeUpstream({ type: 'message_end', message: { role: 'assistant', content: [] }, brandNewField: true });
    const r = c.report();
    check('E1. 多出来的字段不影响判定', () => r.status === 'compatible' || JSON.stringify(r));
    check('E2. 也不产生异常', () => r.issues.length === 0 || JSON.stringify(r.issues));
  }

  /* ================= F. 未知事件安全忽略 ================= */
  section('F. 未知事件');

  {
    const c = healthySessionCompat();
    let threw = null;
    try {
      c.observeUpstream({ type: 'brand_new_upstream_event', payload: { a: 1 } });
      c.observeUpstream({ type: 'another_one', data: 'x' });
    } catch (e) {
      threw = e.message;
    }
    const r = c.report();
    check('F1. 未知事件不抛', () => threw === null || threw);
    check('F2. 状态不受影响（仍 compatible）', () => r.status === 'compatible' || JSON.stringify(r));
    check('F3. 但留下可见记录 unknown-event', () =>
      r.issues.filter((i) => i.issue === 'unknown-event').length === 2 || JSON.stringify(r.issues));
    check('F4. 记录里带事件名（便于定位是哪个新事件）', () =>
      r.issues.some((i) => i.operation === 'brand_new_upstream_event') || JSON.stringify(r.issues));
    check('F5. 不记 payload 内容', () => !JSON.stringify(r).includes('"a":1') || '把 payload 记进去了');
  }

  /* ================= G. malformed response ================= */
  section('G. 畸形数据');

  {
    const c = healthySessionCompat();
    let threw = null;
    try {
      c.observeParseError(); // 半条 JSONL
      c.observeUpstream(null);
      c.observeUpstream('not-an-object');
      c.observeUpstream([1, 2]);
      c.observeUpstream({}); // 没有 type
      c.observeUpstream({ type: 'response' }); // 没有 command
      c.observeUpstream({ type: 'response', command: 'get_state', success: true, data: null }); // 缺 sessionFile
    } catch (e) {
      threw = e.message;
    }
    const r = c.report();
    check('G1. 全部不抛', () => threw === null || threw);
    check('G2. 记了 unparsable-line', () => r.issues.some((i) => i.issue === 'unparsable-line') || JSON.stringify(r.issues));
    check('G3. 记了 not-an-object', () => r.issues.some((i) => i.issue === 'not-an-object') || JSON.stringify(r.issues));
    check('G4. 记了 missing-type', () => r.issues.some((i) => i.issue === 'missing-type') || JSON.stringify(r.issues));
    check('G5. 记了 missing-command', () => r.issues.some((i) => i.issue === 'missing-command') || JSON.stringify(r.issues));
    check('G6. get_state 少了 sessionFile → missing-field 并点名字段', () =>
      r.issues.some((i) => i.issue === 'missing-field' && i.field === 'sessionFile') || JSON.stringify(r.issues));
  }

  /* ================= H. session 格式变化 ================= */
  section('H. 会话形状兼容');

  {
    check('H1. 嵌套形状（pi 真实形状）取到消息体', () => {
      const b = sessionMessageBody({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
      return (b && b.role === 'user' && Array.isArray(b.content)) || JSON.stringify(b);
    });
    check('H2. 顶层形状（旧/自定义）也认', () => {
      const b = sessionMessageBody({ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] });
      return (b && b.role === 'user') || JSON.stringify(b);
    });
    check('H3. 空/非对象不抛，回 null', () =>
      (sessionMessageBody(null) === null && sessionMessageBody(undefined) === null && sessionMessageBody('x') === null) || '不合约');
    check('H4. messagesList 认数组与 {messages} 两种', () => {
      const a = messagesList([1, 2]);
      const b = messagesList({ messages: [1, 2] });
      const c = messagesList(null);
      return (a.length === 2 && b.length === 2 && c.length === 0) || JSON.stringify({ a, b, c });
    });
    check('H5. piState 用 sessionFile 当判据', () => {
      const ok = piState({ sessionFile: 'p', sessionId: 's', sessionName: 'n', messageCount: 2 });
      const bad = piState({ sessionId: 's' });
      const err = piState({ __error: 'x' });
      return (ok.ok && ok.sessionFile === 'p' && ok.messageCount === 2 && !bad.ok && !err.ok) || JSON.stringify({ ok, bad, err });
    });
    check('H6. 只见到嵌套形状时 sessionJsonl = true', () => {
      const c = mk();
      c.observeSessionScan({ attempted: 1, headerOk: 1, cwdOk: 1, shapes: { nested: true } });
      return c.report().capabilities.sessionJsonl === true || JSON.stringify(c.report().capabilities);
    });
    check('H7. 有文件但一条 header 都认不出 → sessionJsonl=false + 异常', () => {
      const c = mk();
      c.observeSessionScan({ attempted: 4, headerOk: 0, cwdOk: 0 });
      const r = c.report();
      return (r.capabilities.sessionJsonl === false && r.issues.some((i) => i.issue === 'header-unreadable')) || JSON.stringify(r);
    });
  }

  /* ================= 三值语义与缓冲上限 ================= */
  section('三值语义 / 异常缓冲');

  {
    const c = mk();
    const r = c.report();
    check('未观察到任何东西 → unknown（不是 incompatible）', () => r.status === 'unknown' || r.status);
    check('未观察到时 detected = false', () => r.detected === false);
    check('所有能力都是 null', () => CAPABILITIES.every((k) => r.capabilities[k] === null) || JSON.stringify(r.capabilities));
  }
  {
    const c = mk();
    c.observeBridge({ state: 'ready' });
    const r = c.report();
    check('只起来了还没问过任何命令 → 不是 incompatible', () => r.status !== 'incompatible' || JSON.stringify(r.capabilities));
  }
  {
    const c = mk();
    for (let i = 0; i < 50; i++) c.observeUpstream({ type: 'unknown_event_' + i });
    const r = c.report();
    check('异常缓冲有上限（≤20）', () => r.issues.length <= 20 || r.issues.length);
    check('保留的是最新的那批', () => r.issues[r.issues.length - 1].operation === 'unknown_event_49' || r.issues[r.issues.length - 1].operation);
  }
  {
    const c = mk();
    const SECRET = 'sk-abcdefghijklmnop-user-secret-内容';
    c.observeUpstream({ type: 'response', command: 'get_state', success: true, data: { sessionFile: SECRET, extra: SECRET } });
    c.observeUpstream({ type: 'weird_event', secret: SECRET });
    c.observeSessionAnomaly('bad-line');
    const raw = JSON.stringify(c.report());
    check('报告里不含任何原始值（只记结构与类型）', () => !raw.includes(SECRET) || '把值记进去了');
    check('报告里不含用户绝对路径指纹', () => !/C:\\\\|C:\//.test(raw) || raw.slice(0, 200));
  }
  {
    const c = mk();
    c.observeUpstream({ type: 'response', command: 'get_state', success: true, data: { sessionFile: 'p' } });
    check('reset() 清空全部证据', () => {
      c.reset();
      const r = c.report();
      return (r.status === 'unknown' && r.issues.length === 0 && r.capabilities.getState === null) || JSON.stringify(r);
    });
  }

  /* ================= summary（降级用） ================= */
  section('summary（前端降级用）');

  {
    const c = healthySessionCompat();
    c.observeUpstream({ type: 'response', command: 'set_session_name', success: false });
    c.observeUpstream({ type: 'response', command: 'switch_session', success: false });
    const s = c.summary();
    check('summary 给出 status 与 missing', () =>
      (s.status === 'partial' && s.missing.includes('sessionNaming') && s.missing.includes('switchSession')) || JSON.stringify(s));
    check('summary 里没有任何多余字段（只给降级需要的东西）', () => {
      const keys = Object.keys(s).sort().join(',');
      return keys === 'missing,status' || keys;
    });
  }

  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
