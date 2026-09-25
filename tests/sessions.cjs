/* 会话列表与切换的测试（server/sessions.js）。
 *
 * 全部在 os.tmpdir() 里造 fixture，**绝不碰真实的 ~/.pi/agent/sessions** ——
 * 这一点是硬要求：开发这个模块时就是因为拿真实项目测「改名」，
 * 把用户的一个会话文件追加了一行（已备份并恢复）。改名这类**会写盘**的用例
 * 一律走临时 fixture。
 *
 * 用法：node tests/sessions.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-sessions-'));
const created = [TMP];
function cleanup() {
  for (const d of created.reverse()) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Windows 偶发占用 */
    }
  }
}

/* ---------- fixture 构造 ---------- */

/** 造一个会话文件。lines 是除 header 外的额外条目。 */
function mkSession(dir, { id, cwd, ts, messages = 0, firstUser = null, extra = [], name = null }) {
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  out.push(JSON.stringify({ type: 'session', version: 3, id, timestamp: ts, cwd }));
  for (let i = 0; i < messages; i++) {
    const isFirst = i === 0;
    const role = isFirst ? 'user' : i % 2 === 0 ? 'user' : 'assistant';
    out.push(
      JSON.stringify({
        type: 'message',
        id: `m${i}`,
        parentId: i === 0 ? null : `m${i - 1}`,
        timestamp: ts,
        // 真实 pi 的形状：消息体嵌在 message 字段下
        message: { role, content: isFirst && firstUser ? [{ type: 'text', text: firstUser }] : [{ type: 'text', text: `第 ${i} 条` }] },
      })
    );
  }
  for (const e of extra) out.push(JSON.stringify(e));
  if (name) out.push(JSON.stringify({ type: 'session_info', id: 'si', parentId: 'm0', timestamp: ts, name }));
  const file = path.join(dir, `${ts.replace(/[:.]/g, '-')}_${id}.jsonl`);
  fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
  return file;
}

(async () => {
  const { createSessions } = await import('../server/sessions.js');
  const I = createSessions({ runtime: { getCurrentCwd: () => null }, env: { HOME: TMP, PI_CODING_AGENT_DIR: path.join(TMP, 'agent') } })._internals;

  const AGENT = path.join(TMP, 'agent');
  const ROOT = path.join(AGENT, 'sessions');
  const PROJ_A = path.join(TMP, 'projA');
  const PROJ_B = path.join(TMP, 'projB');
  fs.mkdirSync(PROJ_A, { recursive: true });
  fs.mkdirSync(PROJ_B, { recursive: true });

  const dirA = path.join(ROOT, I.dirNameFor(PROJ_A));
  const dirB = path.join(ROOT, I.dirNameFor(PROJ_B));

  /* ================= 1. 目录名编码 ================= */
  section('1. 目录名编码');

  check('dirNameFor 把盘符与分隔符换成 -，两边各加 --', () =>
    I.dirNameFor('C:\\Users\\x\\proj') === '--C--Users-x-proj--' || I.dirNameFor('C:\\Users\\x\\proj'));
  check('dirNameFor 保留中文与空格（实测的真实目录名）', () =>
    I.dirNameFor('C:\\新建文件夹 (2)') === '--C--新建文件夹 (2)--' || I.dirNameFor('C:\\新建文件夹 (2)'));
  check('normCwd 归一化分隔符与大小写', () => {
    const a = I.normCwd('C:\\Users\\X\\P');
    const b = I.normCwd('c:/users/x/p');
    return a === b || `${a} vs ${b}`;
  });

  /* ================= 2. summarize ================= */
  section('2. 单个会话文件的解析');

  {
    const f = mkSession(dirA, { id: 'sid-1', cwd: PROJ_A, ts: '2026-09-25T10:00:00.000Z', messages: 3, firstUser: '你好，帮我写个登录功能' });
    const s = I.summarize(f);
    check('2a. 读出 header 的 id / cwd / 时间', () => (s && s.sessionId === 'sid-1' && s.cwd === PROJ_A) || JSON.stringify(s));
    check('2b. 消息条数正确', () => (s && s.messageCount === 3) || (s && s.messageCount));
    check('2c. 标题取第一条用户消息（不是最后一条、也不是助手消息）', () =>
      (s && s.title === '你好，帮我写个登录功能') || (s && s.title));
    check('2d. 消息体嵌在 message 字段下也能读出来', () =>
      (s && s.title && s.title !== '（还没有消息）') || (s && s.title));
  }
  {
    const f = mkSession(dirA, { id: 'sid-empty', cwd: PROJ_A, ts: '2026-09-25T09:00:00.000Z', messages: 0 });
    const s = I.summarize(f);
    check('2e. 没有消息时给中性标题，不报错', () => (s && s.messageCount === 0 && /还没有消息/.test(s.title)) || JSON.stringify(s));
  }
  {
    // 顶层的 role/content 形状也要认（pi 换格式时不至于静默失效）
    const dir = path.join(ROOT, I.dirNameFor(PROJ_A));
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'flat.jsonl');
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'sid-flat', timestamp: '2026-09-25T08:00:00.000Z', cwd: PROJ_A }),
        JSON.stringify({ type: 'message', id: 'm0', timestamp: '2026-09-25T08:00:00.000Z', role: 'user', content: [{ type: 'text', text: '顶层形状的标题' }] }),
      ].join('\n') + '\n',
      'utf8'
    );
    const s = I.summarize(f);
    check('2f. 顶层 role/content 形状也认（两种都兼容）', () => (s && s.title === '顶层形状的标题') || JSON.stringify(s));
  }
  {
    const bad = path.join(dirA, 'broken.jsonl');
    fs.writeFileSync(bad, '{ 这不是 JSON\n', 'utf8');
    check('2g. 坏文件 → null（不抛）', () => I.summarize(bad) === null || JSON.stringify(I.summarize(bad)));
    check('2h. 文件不存在 → null（不抛）', () => I.summarize(path.join(dirA, 'nope.jsonl')) === null || '没返回 null');
    const notSession = path.join(dirA, 'not-session.jsonl');
    fs.writeFileSync(notSession, JSON.stringify({ type: 'other', id: 'x' }) + '\n', 'utf8');
    check('2i. 第一行不是 session header → null', () => I.summarize(notSession) === null || '没返回 null');
  }

  /* ================= 3. list ================= */
  section('3. 列表');

  let files = {};
  {
    // 重新铺一遍目录，保证可预期
    fs.rmSync(ROOT, { recursive: true, force: true });
    files.a1 = mkSession(dirA, { id: 'a1', cwd: PROJ_A, ts: '2026-09-25T10:00:00.000Z', messages: 4, firstUser: 'A 的第一次对话' });
    files.a2 = mkSession(dirA, { id: 'a2', cwd: PROJ_A, ts: '2026-09-25T12:00:00.000Z', messages: 2, firstUser: 'A 的第二次对话' });
    files.b1 = mkSession(dirB, { id: 'b1', cwd: PROJ_B, ts: '2026-09-25T11:00:00.000Z', messages: 6, firstUser: 'B 项目的对话' });
    // 把 a2 的 mtime 改新一点，验证按更新时间倒序
    const future = Date.now() + 5000;
    fs.utimesSync(files.a2, future / 1000, future / 1000);
  }

  const mk = (cwd, rpc) => createSessions({ runtime: { getCurrentCwd: () => cwd }, rpc, env: { HOME: TMP, PI_CODING_AGENT_DIR: AGENT } });

  {
    const mod = mk(PROJ_A, { request: async () => ({ sessionFile: files.a1 }) });
    const r = await mod.list();
    check('3a. 只列当前项目的会话（B 项目的不出现）', () => {
      const ids = r.sessions.map((s) => s.sessionId);
      return (r.sessions.length === 2 && ids.includes('a1') && ids.includes('a2') && !ids.includes('b1')) || JSON.stringify(ids);
    });
    check('3b. 按更新时间倒序（最近的在最前）', () => (r.sessions[0].sessionId === 'a2') || r.sessions.map((s) => s.sessionId).join(','));
    check('3c. 标题是第一条用户消息', () => r.sessions.some((s) => s.title === 'A 的第二次对话') || JSON.stringify(r.sessions.map((s) => s.title)));
    check('3d. 从 pi 的 get_state 拿到当前会话并标出来', () => {
      const cur = r.sessions.find((s) => s.current);
      return (r.currentId && cur && cur.sessionId === 'a1') || JSON.stringify({ currentId: r.currentId, cur: cur && cur.sessionId });
    });
    check('3e. 每条的 id 是 16 位 hex（前端拿不到路径）', () => r.sessions.every((s) => /^[0-9a-f]{16}$/.test(s.id)) || r.sessions.map((s) => s.id).join(','));
    check('3f. 返回里**不含**任何绝对路径字段', () => {
      const raw = JSON.stringify(r);
      return !/[A-Za-z]:\\\\|[A-Za-z]:\//.test(raw) || '出现了疑似路径';
    });
  }
  {
    // 归属判定只认 header.cwd：把一个 B 项目的会话塞进 A 的目录
    const wrongDir = path.join(dirA, 'planted.jsonl');
    fs.writeFileSync(
      wrongDir,
      JSON.stringify({ type: 'session', version: 3, id: 'planted', timestamp: '2026-09-25T13:00:00.000Z', cwd: PROJ_B }) + '\n',
      'utf8'
    );
    const mod = mk(PROJ_A, { request: async () => ({ sessionFile: files.a1 }) });
    const r = await mod.list();
    check('3g. 目录在 A 但 header.cwd 是 B → **不列出**（只认 header，不信目录名）', () =>
      !r.sessions.some((s) => s.sessionId === 'planted') || JSON.stringify(r.sessions.map((s) => s.sessionId)));
    fs.rmSync(wrongDir, { force: true });
  }
  {
    const mod = mk(PROJ_A, {});
    const r = await mod.list();
    check('3h. pi 没连接（没有 rpc）时不报错，只是 currentId 为 null', () => (r.ok && r.currentId === null && r.sessions.length === 2) || JSON.stringify({ ok: r.ok, cur: r.currentId }));
  }
  {
    const mod = mk(null, { request: async () => ({}) });
    const r = await mod.list();
    check('3i. 没选项目 → hasProject=false、空列表', () => (r.ok && r.hasProject === false && r.sessions.length === 0) || JSON.stringify(r));
  }
  {
    // pi 没应答（子进程没起）时列表照样能用
    const mod = mk(PROJ_A, { request: async () => null });
    const r = await mod.list();
    check('3j. pi 没应答时列表仍然正常，currentId 为 null', () => (r.sessions.length === 2 && r.currentId === null) || JSON.stringify({ n: r.sessions.length, cur: r.currentId }));
  }
  {
    // 目录名规则变了 → 退回全量扫描
    fs.mkdirSync(path.join(ROOT, '--完全不一样的目录名--'), { recursive: true });
    const moved = mkSession(path.join(ROOT, '--完全不一样的目录名--'), { id: 'moved', cwd: PROJ_A, ts: '2026-09-25T14:00:00.000Z', messages: 1, firstUser: '被挪走的会话' });
    const mod = mk(PROJ_A, { request: async () => ({ sessionFile: files.a1 }) });
    // 先删掉「猜出来的」那个目录，逼它走全量扫描
    const guessDir = path.join(ROOT, I.dirNameFor(PROJ_A));
    const backup = guessDir + '.bak';
    fs.renameSync(guessDir, backup);
    const r = await mod.list();
    check('3k. 猜不到目录时退回全量扫描，仍能按 header.cwd 找到会话', () =>
      r.sessions.some((s) => s.sessionId === 'moved') || JSON.stringify(r.sessions.map((s) => s.sessionId)));
    fs.renameSync(backup, guessDir);
    fs.rmSync(moved, { force: true });
  }
  {
    // 坏文件不能拖垮整个列表
    const dir = path.join(ROOT, I.dirNameFor(PROJ_A));
    fs.writeFileSync(path.join(dir, 'zz-broken.jsonl'), 'garbage\n', 'utf8');
    const mod = mk(PROJ_A, { request: async () => ({ sessionFile: files.a1 }) });
    const r = await mod.list();
    check('3l. 一个坏文件不影响其余会话（并给一条诊断）', () =>
      (r.sessions.length === 2 && r.diagnostics.length >= 1) || JSON.stringify({ n: r.sessions.length, d: r.diagnostics.length }));
  }

  /* ================= 4. 安全 ================= */
  section('4. 安全边界');

  {
    const mod = mk(PROJ_A, { request: async (cmd) => ({ ok: true, __cmd: cmd }) });
    const okId = (await mod.list()).sessions.find((s) => s.sessionId === 'a1').id;

    const r1 = await mod.switchTo('0'.repeat(16));
    check('4a. 未知 id → not-found', () => (!r1.ok && r1.code === 'not-found') || JSON.stringify(r1));
    const r2 = await mod.switchTo('../../../../etc/passwd');
    check('4b. 路径穿越字符串当 id → not-found（不会被当路径用）', () => (!r2.ok && r2.code === 'not-found') || JSON.stringify(r2));
    const r3 = await mod.switchTo('C:\\Windows\\win.ini');
    check('4c. 绝对路径当 id → not-found', () => (!r3.ok && r3.code === 'not-found') || JSON.stringify(r3));
    check('4d. not-found 的响应里不回显被请求的字符串', () => !r3.error.includes('win.ini') || r3.error);

    // 拿 B 项目的会话 id 来切（B 的 id 是合法的 16 位 hex，但不属于当前项目）
    const modB = mk(PROJ_B, { request: async () => ({}) });
    const bId = (await modB.list()).sessions[0].id;
    const r4 = await mod.switchTo(bId);
    check('4e. 拿另一个项目的会话 id 来切 → not-found（归属只认 header.cwd）', () => (!r4.ok && r4.code === 'not-found') || JSON.stringify(r4));

    // 正常切换：确认传给 pi 的是**真实路径**，而且是对的那一个
    let seen = null;
    const mod2 = mk(PROJ_A, { request: async (cmd) => { seen = cmd; return { cancelled: false }; } });
    const r5 = await mod2.switchTo(okId);
    check('4f. 正常切换：给 pi 发 switch_session + 真实路径', () =>
      (r5.ok && seen && seen.type === 'switch_session' && seen.sessionPath === files.a1) || JSON.stringify({ r5, seen }));
  }

  /* ================= 5. switch / rename 的降级 ================= */
  section('5. 切换与改名的降级');

  {
    const mod = mk(PROJ_A, null);
    const r = await mod.switchTo((await mod.list()).sessions[0].id);
    check('5a. 没有 rpc → no-rpc（不抛）', () => (!r.ok && r.code === 'no-rpc') || JSON.stringify(r));
  }
  {
    const mod = mk(PROJ_A, { request: async () => null });
    const r = await mod.switchTo((await mod.list()).sessions[0].id);
    check('5b. pi 没应答 → no-answer（不假装成功）', () => (!r.ok && r.code === 'no-answer') || JSON.stringify(r));
  }
  {
    const mod = mk(PROJ_A, { request: async () => ({ __error: 'pi 说不行' }) });
    const r = await mod.switchTo((await mod.list()).sessions[0].id);
    check('5c. pi 明确报错 → failed，并把原因带回来', () => (!r.ok && r.code === 'failed' && /pi 说不行/.test(r.error)) || JSON.stringify(r));
  }
  {
    const mod = mk(PROJ_A, { request: async () => ({ cancelled: true }) });
    const r = await mod.switchTo((await mod.list()).sessions[0].id);
    check('5d. 被扩展取消 → cancelled', () => (!r.ok && r.code === 'cancelled') || JSON.stringify(r));
  }
  {
    let seen = null;
    const mod = mk(PROJ_A, { request: async (cmd) => { seen = cmd; return {}; } });
    const r1 = await mod.rename('我的登录功能开发');
    check('5e. 改名 → 给 pi 发 set_session_name', () => (r1.ok && seen.type === 'set_session_name' && seen.name === '我的登录功能开发') || JSON.stringify({ r1, seen }));
    const r2 = await mod.rename('   ');
    check('5f. 空名字被拒（不会发一条空名字过去）', () => !r2.ok || JSON.stringify(r2));
    const r3 = await mod.rename('x'.repeat(500));
    check('5g. 超长名字被截断到 120', () => (r3.ok && seen.name.length === 120) || seen.name.length);
  }

  /* ================= 6. HTTP 层 ================= */
  section('6. HTTP 层');

  {
    const { createRouter } = await import('../server/router.js');
    const { createAuth } = await import('../server/auth.js');
    const mod = mk(PROJ_A, { request: async () => ({ sessionFile: files.a1 }) });
    const passthrough = (name) => (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, handler: name }));
    };
    const router = createRouter({
      auth: createAuth({ token: 'T', port: 7788, appId: 'pi-gui', protocol: 1, version: '0.0.0' }),
      sse: { subscribe: passthrough('sse') },
      rpc: { send: passthrough('rpc.send'), restart: passthrough('rpc.restart'), getState: () => ({ ok: true }) },
      providers: { handle: passthrough('providers'), handleModels: passthrough('providers.models') },
      projects: { handle: passthrough('projects'), handleFs: passthrough('projects.fs') },
      projectConfig: { handle: passthrough('projectConfig') },
      skills: { handle: passthrough('skills') },
      mcp: { handle: passthrough('mcp') },
      sessions: mod,
      planner: { handle: passthrough('planner') },
      gitRoutes: { handle: passthrough('git') },
      uploads: { handle: passthrough('uploads') },
    });
    const mockRes = () => {
      const chunks = [];
      return {
        code: null,
        writeHead(c) { this.code = c; return this; },
        write(s) { chunks.push(String(s)); return true; },
        end(s) { if (s) chunks.push(String(s)); },
        body: () => chunks.join(''),
        json() { try { return JSON.parse(this.body()); } catch { return null; } },
      };
    };
    const mockReq = ({ method = 'GET', url = '/', headers = {} } = {}) => {
      const ls = new Map();
      const req = { method, url, headers, on(ev, fn) { if (!ls.has(ev)) ls.set(ev, []); ls.get(ev).push(fn); return req; }, emit(ev, a) { for (const fn of ls.get(ev) || []) fn(a); } };
      return req;
    };
    const hit = async (method, url, headers = {}, body = null) => {
      const req = mockReq({ method, url, headers });
      const res = mockRes();
      router(req, res);
      if (body !== null) {
        req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
        req.emit('end');
      }
      await new Promise((r) => setTimeout(r, 30));
      return res;
    };

    const list = await hit('GET', '/api/sessions', { 'x-pi-gui-token': 'T' });
    check('6a. GET /api/sessions 命中 sessions 模块并返回列表', () =>
      (list.code === 200 && Array.isArray(list.json().sessions)) || list.body().slice(0, 200));
    const noTok = await hit('GET', '/api/sessions');
    check('6b. 不带令牌 → 401', () => noTok.code === 401 || noTok.code);
    const sw = await hit('POST', '/api/sessions/switch', { 'x-pi-gui-token': 'T' }, { id: '0'.repeat(16) });
    check('6c. POST /api/sessions/switch 不被 405 兜底吃掉（路由顺序正确）', () =>
      (sw.code === 200 && sw.json().ok === false) || JSON.stringify({ code: sw.code, body: sw.json() }));
    const badId = await hit('POST', '/api/sessions/switch', { 'x-pi-gui-token': 'T' }, { id: 123 });
    check('6d. id 不是字符串 → 400', () => badId.code === 400 || badId.code);
    const put = await hit('PUT', '/api/sessions', { 'x-pi-gui-token': 'T' });
    check('6e. PUT /api/sessions → 405', () => put.code === 405 || put.code);
  }

  /* ---------- 收尾 ---------- */
  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
})().catch((err) => {
  console.error('\n测试自身崩了：', err);
  cleanup();
  process.exitCode = 1;
});
