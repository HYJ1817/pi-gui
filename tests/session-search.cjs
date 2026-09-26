/* 会话全文搜索的测试（server/session-search.js）。
 *
 * 全部在 os.tmpdir() 里造 fixture —— **绝不碰真实的 ~/.pi/agent/sessions**
 * （同 tests/sessions.cjs 的硬要求）。
 *
 * 用法：node tests/session-search.cjs
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
const skip = (why) => console.log('  --   跳过：' + why);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-session-search-'));
function cleanup() {
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows 偶发占用 */
  }
}

/* ---------- fixture ---------- */

const T1 = '2026-09-26T10:00:00.000Z';
const T2 = '2026-09-26T11:00:00.000Z';
const T3 = '2026-09-26T12:00:00.000Z';

const user = (text, id, ts = T1) => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: ts,
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const assistantText = (text, id, ts = T1) => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: ts,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
/** assistant 消息：content 由调用方给（可以是 thinking / toolCall / image 混合）。 */
const assistantRaw = (content, id, ts = T1) => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: ts,
  message: { role: 'assistant', content },
});
const toolResult = (text, id, ts = T1) => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: ts,
  message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text }], isError: false },
});

function mkSession(dir, { id, cwd, ts = T1, entries = [], name = null, raw = null }) {
  fs.mkdirSync(dir, { recursive: true });
  const out = [JSON.stringify({ type: 'session', version: 3, id, timestamp: ts, cwd })];
  if (raw !== null) out.push(raw);
  for (const e of entries) out.push(JSON.stringify(e));
  if (name) out.push(JSON.stringify({ type: 'session_info', id: 'si', parentId: null, timestamp: ts, name }));
  const file = path.join(dir, `${ts.replace(/[:.]/g, '-')}_${id}.jsonl`);
  fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
  return file;
}

(async () => {
  const { createSessions } = await import('../server/sessions.js');
  const { createSessionSearch, LIMITS } = await import('../server/session-search.js');

  const AGENT = path.join(TMP, 'agent');
  const PROJ_A = path.join(TMP, 'projA');
  const PROJ_B = path.join(TMP, 'projB');
  fs.mkdirSync(PROJ_A, { recursive: true });
  fs.mkdirSync(PROJ_B, { recursive: true });

  /* 可切换的当前项目 —— 跨项目用例靠它 */
  let current = PROJ_A;
  const runtime = { getCurrentCwd: () => current };
  const env = { HOME: TMP, PI_CODING_AGENT_DIR: AGENT };

  const sessions = createSessions({ runtime, rpc: null, env, dataDir: path.join(TMP, 'data') });
  const search = createSessionSearch({ runtime, sessions });
  const I = sessions._internals;
  const ROOT = sessions.root;
  const dirA = path.join(ROOT, I.dirNameFor(PROJ_A));
  const dirB = path.join(ROOT, I.dirNameFor(PROJ_B));

  /* ================= 1. 搜什么 ================= */
  section('1. 标题与正文');

  const files = {};
  files.a1 = mkSession(dirA, {
    id: 'a1',
    cwd: PROJ_A,
    ts: T1,
    entries: [
      user('帮我写个登录功能', 'm0', T1),
      assistantText('好的，我来实现登录。先看一下现有的路由结构。', 'm1', T1),
      user('另外注意 SSE 重连的问题', 'm2', T2),
      assistantText('SSE 重连我会用指数退避处理。', 'm3', T2),
    ],
  });
  files.a2 = mkSession(dirA, {
    id: 'a2',
    cwd: PROJ_A,
    ts: T3,
    entries: [user('数据库迁移怎么做', 'n0', T3), assistantText('用 migration 脚本，先备份。', 'n1', T3)],
  });

  {
    const r = await search.search('登录');
    check('1a. 标题命中能搜到', () => r.ok && r.results.length === 1 && r.results[0].id === I.sessionId(files.a1) || JSON.stringify(r.results.map((x) => x.title)));
    check('1b. 标题命中被标成 type=title', () => {
      const m = r.results[0] && r.results[0].matches.some((x) => x.type === 'title');
      return m === true || JSON.stringify(r.results[0] && r.results[0].matches);
    });
  }
  {
    const r = await search.search('路由');
    const hit = r.results.find((x) => x.id === I.sessionId(files.a1));
    check('1c. assistant 正文能搜到', () => Boolean(hit) || JSON.stringify(r.results));
    check('1d. 命中类型标成 assistant', () => hit && hit.matches.some((m) => m.type === 'assistant') || JSON.stringify(hit && hit.matches));
  }
  {
    const r = await search.search('指数退避');
    const hit = r.results.find((x) => x.id === I.sessionId(files.a1));
    check('1e. 用户正文（非首条）能搜到', () => Boolean(hit) || JSON.stringify(r.results));
  }
  {
    const r = await search.search('迁移');
    check('1f. 不同会话各自命中', () => r.results.length === 1 && r.results[0].id === I.sessionId(files.a2) || JSON.stringify(r.results));
  }
  {
    const r1 = await search.search('sse');
    const r2 = await search.search('SSE');
    const r3 = await search.search('Sse');
    check('1g. 英文大小写不敏感（三种写法的会话集合一致）', () =>
      r1.results.map((x) => x.id).join() === r2.results.map((x) => x.id).join() &&
      r2.results.map((x) => x.id).join() === r3.results.map((x) => x.id).join() || `${r1.results.length}/${r2.results.length}/${r3.results.length}`);
    check('1h. 大小写不敏感也确实命中了（不是都空）', () => r1.results.length === 1 || JSON.stringify(r1.results.map((x) => x.title)));
  }
  {
    const r = await search.search('绝对不存在的词xyzzy');
    check('1i. 没命中 → ok 且结果为空（不是报错）', () => r.ok === true && r.results.length === 0 || JSON.stringify(r));
  }

  /* ================= 2. 不索引什么 ================= */
  section('2. 工具输出 / 思考 / 图片 / 工具参数不索引');

  files.noise = mkSession(dirA, {
    id: 'noise',
    cwd: PROJ_A,
    ts: T2,
    entries: [
      user('跑一下构建', 'p0', T2),
      assistantRaw(
        [
          { type: 'thinking', thinking: 'THINKMARK 我在想构建要多久' },
          { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'npm run TOOLMARK' } },
          { type: 'text', text: '我来执行构建。' },
          { type: 'image', mimeType: 'image/png', data: 'BASE64MARK' },
        ],
        'p1',
        T2
      ),
      toolResult('OUTPUTMARK 构建输出一大堆日志', 'p2', T2),
    ],
  });

  {
    const t = await search.search('THINKMARK');
    const o = await search.search('OUTPUTMARK');
    const i = await search.search('BASE64MARK');
    const c = await search.search('TOOLMARK');
    check('2a. thinking 正文不索引', () => t.results.length === 0 || JSON.stringify(t.results.map((x) => x.title)));
    check('2b. toolResult 输出不索引', () => o.results.length === 0 || JSON.stringify(o.results.map((x) => x.title)));
    check('2c. 图片 base64 不索引', () => i.results.length === 0 || JSON.stringify(i.results.map((x) => x.title)));
    check('2d. toolCall 参数不索引', () => c.results.length === 0 || JSON.stringify(c.results.map((x) => x.title)));
    const ok = await search.search('执行构建');
    check('2e. 同一批 content 里的 text 片段**仍然**索引（没一刀切）', () =>
      ok.results.length === 1 || JSON.stringify(ok.results));
  }

  /* ================= 3. scope ================= */
  section('3. active / archived / all');

  {
    const r = await sessions.setArchived(I.sessionId(files.a2), true);
    check('3a. 归档调用成功', () => r.ok === true || JSON.stringify(r));
  }
  {
    const act = await search.search('迁移'); // 只在 a2 里，a2 已归档
    const arc = await search.search('迁移', 'archived');
    const all = await search.search('迁移', 'all');
    check('3b. scope=active 不含已归档', () => act.results.length === 0 || JSON.stringify(act.results.map((x) => x.title)));
    check('3c. scope=archived 只含已归档', () => arc.results.length === 1 && arc.results[0].archived === true || JSON.stringify(arc.results));
    check('3d. scope=all 两者都含', () => all.results.length === 1 || JSON.stringify(all.results));
    check('3e. 结果里带 archived 标记', () => arc.results[0] && arc.results[0].archived === true || JSON.stringify(arc.results[0]));
  }
  {
    await sessions.setArchived(I.sessionId(files.a2), false);
    const act = await search.search('迁移');
    check('3f. 取消归档后立刻回到 active（flags 每次现读，不进缓存）', () =>
      act.results.length === 1 && act.results[0].archived === false || JSON.stringify(act.results));
  }

  /* ================= 4. 软删除 ================= */
  section('4. 软删除');

  files.gone = mkSession(dirA, { id: 'gone', cwd: PROJ_A, ts: T2, entries: [user('这条马上要被删掉 DELETEME', 'q0', T2)] });
  const goneId = I.sessionId(files.gone);
  {
    const before = await search.search('DELETEME');
    check('4a. 删除前搜得到', () => before.results.length === 1 || JSON.stringify(before.results));
    const del = await sessions.remove(goneId);
    check('4b. 删除调用成功', () => del.ok === true || JSON.stringify(del));
    const after = await search.search('DELETEME');
    check('4c. 删除后搜不到', () => after.results.length === 0 || JSON.stringify(after.results.map((x) => x.title)));
  }
  {
    /* 把文件从回收站手工挪回 sessions 目录 —— flags 里还记着它已删除，
     * 所以它**不能复活**。这是删除语义的兜底。
     * 注意回收站里的文件名用的是 **pi 的 sessionId**（header 里的 UUID），
     * 不是我们那个「路径 sha1」ID —— 前者跟着会话走，文件挪了位置也不失配。 */
    const trashDir = path.join(sessions.dataDir, 'trash-sessions');
    let trashed = null;
    try {
      const names = fs.readdirSync(trashDir).filter((f) => f.endsWith('.jsonl'));
      trashed = names.length ? path.join(trashDir, names[0]) : null;
    } catch {
      trashed = null;
    }
    if (trashed) {
      const restored = path.join(dirA, 'restored_manually.jsonl');
      fs.copyFileSync(trashed, restored);
      const again = await search.search('DELETEME');
      check('4d. 文件被手工挪回来也不出现（flags 兜底）', () => again.results.length === 0 || JSON.stringify(again.results.map((x) => x.title)));
      fs.rmSync(restored, { force: true });
    } else {
      skip('回收站里没找到被删的文件，4d 未验');
    }
  }

  /* ================= 5. 安全边界 ================= */
  section('5. 安全边界');

  files.b1 = mkSession(dirB, {
    id: 'b1',
    cwd: PROJ_B,
    ts: T2,
    entries: [user('B 项目的机密内容 SECRETB', 'r0', T2)],
  });
  {
    const r = await search.search('SECRETB');
    check('5a. 别的项目的会话搜不到（只认 header.cwd）', () => r.results.length === 0 || JSON.stringify(r.results));
    current = PROJ_B;
    const inB = await search.search('SECRETB');
    check('5b. 换到 B 项目之后就能搜到（证明刚才不是「文件不存在」）', () => inB.results.length === 1 || JSON.stringify(inB.results));
    current = PROJ_A;
    const backA = await search.search('SECRETB');
    check('5c. 切回 A 之后又搜不到（不串项目）', () => backA.results.length === 0 || JSON.stringify(backA.results));
  }
  {
    const r = await search.search('登录');
    const raw = JSON.stringify(r);
    check('5e. 响应里不含 sessions 根目录的绝对路径', () => !raw.includes(ROOT) || '响应里出现了 ' + ROOT);
    check('5f. 响应里不含项目目录的绝对路径', () => !raw.includes(PROJ_A) || '响应里出现了 ' + PROJ_A);
    check('5g. 响应里不含文件名（.jsonl）', () => !/\.jsonl/.test(raw) || '响应里出现了 .jsonl');
    check('5h. 只回稳定 ID（16 位 hex）与 pi 的 sessionId', () => {
      const it = r.results[0];
      return it && /^[0-9a-f]{16}$/.test(it.id) && typeof it.sessionId === 'string' || JSON.stringify(it && { id: it.id, sessionId: it.sessionId });
    });
  }
  {
    /* symlink 越界：在 sessions 目录里放一个指向**外面**的链接。 */
    const outside = path.join(TMP, 'outside', 'evil.jsonl');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(
      outside,
      JSON.stringify({ type: 'session', version: 3, id: 'evil', timestamp: T1, cwd: PROJ_A }) +
        '\n' +
        JSON.stringify(user('外部文件被链接进来了 SYMLINKMARK', 's0', T1)) +
        '\n',
      'utf8'
    );
    const link = path.join(dirA, 'linked.jsonl');
    let linked = false;
    try {
      fs.symlinkSync(outside, link, 'file');
      linked = true;
    } catch {
      /* Windows 上建符号链接要权限/开发者模式 */
    }
    if (linked) {
      const r = await search.search('SYMLINKMARK');
      check('5i. symlink 解析到 sessions 根之外 → 不索引', () => r.results.length === 0 || JSON.stringify(r.results.map((x) => x.title)));
      fs.rmSync(link, { force: true });
    } else {
      skip('本机建不了符号链接（需要权限或开发者模式），5i 未验');
    }
  }

  /* ================= 6. 上限 ================= */
  section('6. 上限与预算');

  {
    const long = 'A'.repeat(400) + 'NEEDLE' + 'B'.repeat(400);
    files.long = mkSession(dirA, { id: 'long', cwd: PROJ_A, ts: T3, entries: [user(long, 't0', T3)] });
    const r = await search.search('NEEDLE');
    const m = r.results[0] && r.results[0].matches[0];
    check('6a. snippet 长度有上限', () => m && m.snippet.length <= LIMITS.maxSnippet + 1 || (m && m.snippet.length));
    check('6b. snippet 折掉了连续空白与换行', () => m && !/\s{2,}/.test(m.snippet) || JSON.stringify(m && m.snippet));
    check('6c. 命中词在 snippet 里（定位没被截掉）', () => m && /NEEDLE/.test(m.snippet) || JSON.stringify(m && m.snippet));
  }
  {
    for (const n of ['s1', 's2', 's3']) mkSession(dirA, { id: n, cwd: PROJ_A, ts: T3, entries: [user(`${n} 共同关键词 MANYHIT`, 'z0', T3)] });
    const small = createSessionSearch({ runtime, sessions, limits: { maxResults: 2 } });
    const r = await small.search('MANYHIT');
    check('6d. 结果数量有上限（maxResults=2）', () => r.results.length <= 2 || r.results.length);
  }
  {
    /* 单会话读取上限：把上限压到很小，文件里靠后的内容就搜不到，并标 truncated。 */
    const big = mkSession(dirA, {
      id: 'big',
      cwd: PROJ_A,
      ts: T3,
      entries: [user('开头有 EARLYMARK', 'b0', T3), user('结尾有 LATEMARK', 'b1', T3)],
    });
    const tiny = createSessionSearch({ runtime, sessions, limits: { maxSessionBytes: 200 } });
    const early = await tiny.search('EARLYMARK');
    const late = await tiny.search('LATEMARK');
    check('6e. 上限内的内容搜得到', () => early.results.length === 1 || JSON.stringify(early.results));
    check('6f. 超出读取上限的内容搜不到（不是无限读）', () => late.results.length === 0 || JSON.stringify(late.results));
    check('6g. 被截断会在 scanned 里标出来', () => early.scanned.truncated === true || JSON.stringify(early.scanned));
    fs.rmSync(big, { force: true });
  }
  {
    const r = await search.search('x');
    check('6h. 关键词过短 → 直接返回空且标 tooShort（一次磁盘都不碰）', () =>
      r.ok === true && r.results.length === 0 && r.tooShort === true && r.scanned.sessions === 0 || JSON.stringify(r));
    const r2 = await search.search('   ');
    check('6i. 纯空白也算过短', () => r2.tooShort === true || JSON.stringify(r2));
  }
  {
    const r = await search.search('a'.repeat(500));
    check('6j. 超长关键词被截断（不报错）', () => r.ok === true && r.query.length <= LIMITS.maxQuery || JSON.stringify({ ok: r.ok, len: r.query.length }));
  }

  /* ================= 7. 坏文件 ================= */
  section('7. 坏文件不拖垮整体');

  {
    const bad = path.join(dirA, 'corrupt.jsonl');
    fs.writeFileSync(bad, 'this is not json at all\n{"broken":\n', 'utf8');
    const noHeader = path.join(dirA, 'noheader.jsonl');
    fs.writeFileSync(noHeader, JSON.stringify({ type: 'not-a-session' }) + '\n', 'utf8');
    const mixed = path.join(dirA, 'mixed.jsonl');
    fs.writeFileSync(
      mixed,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'mixed', timestamp: T1, cwd: PROJ_A }),
        '{ 半行坏 JSON',
        JSON.stringify(user('坏文件里也有 GOODLINE', 'x0', T1)),
      ].join('\n') + '\n',
      'utf8'
    );

    const r = await search.search('GOODLINE');
    check('7a. 同目录有坏文件时，正常会话照样能搜到', () => r.ok === true && r.results.length === 1 || JSON.stringify(r));
    const r2 = await search.search('登录');
    check('7b. 坏文件不会让整次搜索报错', () => r2.ok === true || JSON.stringify(r2));
    check('7c. 读不出来的文件被计入 skipped（可见，不是静默）', () => r2.scanned.skipped >= 2 || JSON.stringify(r2.scanned));
    fs.rmSync(bad, { force: true });
    fs.rmSync(noHeader, { force: true });
    fs.rmSync(mixed, { force: true });
  }

  /* ================= 8. 改名 ================= */
  section('8. 改名后标题更新');

  {
    files.ren = mkSession(dirA, { id: 'ren', cwd: PROJ_A, ts: T3, entries: [user('原始标题 RENAMEOLD', 'v0', T3)] });
    const before = await search.search('RENAMEOLD');
    check('8a. 改名前的标题搜得到', () => before.results.length === 1 || JSON.stringify(before.results));
    /* pi 的 set_session_name 往文件里追加一条 session_info（这里模拟同样的效果） */
    fs.appendFileSync(files.ren, JSON.stringify({ type: 'session_info', id: 'si2', parentId: 'v0', timestamp: T3, name: '我改的新标题 RENAMENEW' }) + '\n', 'utf8');
    const after = await search.search('RENAMENEW');
    check('8b. 改名后的新标题立刻搜得到', () => after.results.length === 1 || JSON.stringify(after.results));
    check('8c. 结果里的 title 就是新名字', () => after.results[0] && after.results[0].title === '我改的新标题 RENAMENEW' || JSON.stringify(after.results[0] && after.results[0].title));
    const stale = await search.search('RENAMEOLD');
    check('8d. 旧标题不再命中标题（正文里还有，但那是 body 命中）', () =>
      stale.results.every((x) => x.matches.every((m) => m.type !== 'title')) || JSON.stringify(stale.results.map((x) => x.matches.map((m) => m.type))));
  }

  /* ================= 9. userIndex（跳转定位用） ================= */
  section('9. userIndex');

  {
    files.idx = mkSession(dirA, {
      id: 'idx',
      cwd: PROJ_A,
      ts: T3,
      entries: [
        user('第一次提问 FIRSTQ', 'w0', T3),
        assistantText('第一次回答 指向第二个标记 ANSWERA', 'w1', T3),
        user('第二次提问 SECONDQ', 'w2', T3),
        assistantText('第二次回答 ANSWBER', 'w3', T3),
      ],
    });
    const r1 = await search.search('FIRSTQ');
    const r2 = await search.search('SECONDQ');
    const ra = await search.search('ANSWERA');
    const rb = await search.search('ANSWBER');
    const ui = (r, q) => (r.results.find((x) => x.id === I.sessionId(files.idx)) || {}).matches?.find((m) => m.type !== 'title');
    check('9a. 第一次提问 userIndex=0', () => ui(r1).userIndex === 0 || JSON.stringify(ui(r1)));
    check('9b. 第二次提问 userIndex=1', () => ui(r2).userIndex === 1 || JSON.stringify(ui(r2)));
    check('9c. 第一次回答归到第 0 次提问', () => ui(ra).userIndex === 0 || JSON.stringify(ui(ra)));
    check('9d. 第二次回答归到第 1 次提问', () => ui(rb).userIndex === 1 || JSON.stringify(ui(rb)));
    check('9e. 命中带 messageId（不用于定位，但便于诊断）', () => ui(r1).messageId === 'w0' || JSON.stringify(ui(r1)));
  }

  /* ================= 10. 缓存 ================= */
  section('10. 缓存失效');

  {
    files.cache = mkSession(dirA, { id: 'cache', cwd: PROJ_A, ts: T3, entries: [user('缓存测试 CACHEONE', 'c0', T3)] });
    const first = await search.search('CACHEONE');
    check('10a. 首次搜到', () => first.results.length === 1 || JSON.stringify(first.results));
    fs.appendFileSync(files.cache, JSON.stringify(user('缓存测试 CACHETWO', 'c1', T3)) + '\n', 'utf8');
    const second = await search.search('CACHETWO');
    check('10b. 文件追加内容后（mtime+size 变了）能搜到新内容', () => second.results.length === 1 || JSON.stringify(second.results));
    const again = await search.search('CACHEONE');
    check('10c. 旧内容仍然搜得到（缓存不是整条换掉）', () => again.results.length === 1 || JSON.stringify(again.results));
    const s1 = await search.search('CACHEONE');
    const s2 = await search.search('CACHEONE');
    check('10d. 同一关键词连搜两次结果完全一致（缓存不引入抖动）', () => JSON.stringify(s1) === JSON.stringify(s2) || '两次结果不同');
  }

  /* ================= 11. HTTP 层与路由顺序 ================= */
  section('11. HTTP 层');

  {
    const { createRouter } = await import('../server/router.js');
    const { createAuth } = await import('../server/auth.js');
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
      sessions,
      sessionSearch: search,
      planner: { handle: passthrough('planner') },
      gitRoutes: { handle: passthrough('git') },
      uploads: { handle: passthrough('uploads') },
      diagnostics: { handle: passthrough('diagnostics') },
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
      await new Promise((r) => setTimeout(r, 40));
      return res;
    };
    const AUTH = { 'x-pi-gui-token': 'T' };

    const res = await hit('GET', '/api/sessions/search?q=' + encodeURIComponent('登录'), AUTH);
    const j = res.json();
    check('11a. GET /api/sessions/search 命中搜索模块（不被 /api/sessions/ 前缀吃掉）', () =>
      (res.code === 200 && j && j.ok === true && Array.isArray(j.results) && j.query === '登录') || JSON.stringify({ code: res.code, body: j }));
    check('11b. 返回体带 query / scope / results / scanned', () => {
      return j && j.scope === 'active' && Array.isArray(j.results) && j.scanned && typeof j.scanned.bytes === 'number' || JSON.stringify(Object.keys(j || {}));
    });
    const noTok = await hit('GET', '/api/sessions/search?q=abc');
    check('11c. 搜索同样要令牌（不带 → 401）', () => noTok.code === 401 || noTok.code);
    const post = await hit('POST', '/api/sessions/search?q=abc', AUTH);
    check('11d. POST /api/sessions/search → 405', () => post.code === 405 || post.code);
    const scoped = await hit('GET', '/api/sessions/search?q=' + encodeURIComponent('迁移') + '&scope=all', AUTH);
    check('11e. scope 参数能透传', () => scoped.json() && scoped.json().scope === 'all' || JSON.stringify(scoped.json() && scoped.json().scope));
    const badScope = await hit('GET', '/api/sessions/search?q=' + encodeURIComponent('登录') + '&scope=%3Cscript%3E', AUTH);
    check('11f. 非法 scope 被归一成 active（不报错、不透传）', () => badScope.json() && badScope.json().scope === 'active' || JSON.stringify(badScope.json() && badScope.json().scope));
    const listStill = await hit('GET', '/api/sessions', AUTH);
    check('11g. /api/sessions 本身仍然走会话列表（没被搜索路由抢走）', () =>
      listStill.json() && Array.isArray(listStill.json().sessions) || listStill.body().slice(0, 120));
  }

  /* ================= 12. 大量会话下的性能边界 ================= */
  section('12. 大量会话（性能边界）');

  {
    /* 单独一套目录：200 个会话，每个 10 条消息。规模取规格给的上界附近。
     * 断言都留了很宽的余量 —— 这里要拦的是**架构性**的毛病
     * （O(N × 巨型全文 × 无限复制)、一次同步扫描按住事件循环），
     * 不是「CI runner 比开发机慢」这种抖动。 */
    const BIG = path.join(TMP, 'big-agent');
    const BIG_PROJ = path.join(TMP, 'proj-big');
    fs.mkdirSync(BIG_PROJ, { recursive: true });
    const bigRuntime = { getCurrentCwd: () => BIG_PROJ };
    const bigSessions = createSessions({
      runtime: bigRuntime,
      rpc: null,
      env: { HOME: TMP, PI_CODING_AGENT_DIR: BIG },
      dataDir: path.join(TMP, 'big-data'),
    });
    const bigDir = path.join(bigSessions.root, bigSessions._internals.dirNameFor(BIG_PROJ));
    const bigSearch = createSessionSearch({
      runtime: bigRuntime,
      sessions: bigSessions,
      limits: { maxResults: 20, maxTotalBytes: 4 * 1024 * 1024 },
    });

    const N = 200;
    const MSGS = 10;
    const marked = [];
    for (let i = 0; i < N; i++) {
      const entries = [];
      for (let m = 0; m < MSGS; m++) {
        entries.push(
          m % 2 === 0
            ? user(`会话 ${i} 的第 ${m} 次提问 filler-${i}-${m}`, `u${i}-${m}`, T1)
            : assistantText(`会话 ${i} 的第 ${m} 次回答 filler-${i}-${m}`, `a${i}-${m}`, T1)
        );
      }
      if (i % 13 === 0) {
        marked.push(i);
        entries.push(user(`这个会话里有 NEEDLE 标记 big-${i}`, `n${i}`, T2));
      }
      mkSession(bigDir, { id: `big-${i}`, cwd: BIG_PROJ, ts: T1, entries });
    }

    /* 用 interval 量「事件循环被按住多久」：搜索分片让出的话，这个 tick
     * 能在分片之间插进来；如果是一口气同步跑完，这里就会量到一个大缺口。 */
    let maxGap = 0;
    let lastTick = Date.now();
    const tick = setInterval(() => {
      const now = Date.now();
      if (now - lastTick > maxGap) maxGap = now - lastTick;
      lastTick = now;
    }, 5);

    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = Date.now();
    const r = await bigSearch.search('NEEDLE');
    const elapsed = Date.now() - t0;
    const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
    clearInterval(tick);

    console.log(
      `       ${N} 个会话 / 每个 ${MSGS} 条消息：耗时 ${elapsed}ms · 事件循环最大停顿 ${maxGap}ms · ` +
        `堆增长 ${heapMb.toFixed(1)}MB · 读取 ${(r.scanned.bytes / 1024).toFixed(0)}KB`
    );

    check('12a. 200 个会话里能搜到正确的结果', () =>
      (r.ok === true && r.results.length === marked.length) ||
      JSON.stringify({ ok: r.ok, got: r.results.length, want: marked.length, scanned: r.scanned }));
    check('12b. 每条结果都真的含关键词（不是被 filler 命中）', () =>
      r.results.every((x) => x.matches.some((m) => /NEEDLE/.test(m.snippet))) ||
      JSON.stringify(r.results.slice(0, 3).map((x) => x.matches.map((m) => m.snippet))));
    check('12c. 结果数量受上限约束', () => r.results.length <= 20 || r.results.length);
    check('12d. 读取总量受预算约束（不是无限读）', () =>
      (r.scanned.bytes > 0 && r.scanned.bytes <= bigSearch._limits.maxTotalBytes) || JSON.stringify(r.scanned));
    check('12e. 单次搜索不会长时间按住事件循环（<1500ms）', () => maxGap < 1500 || `最大停顿 ${maxGap}ms`);
    check('12f. 不产生巨量临时对象（堆增长 <200MB）', () => heapMb < 200 || `堆增长 ${heapMb.toFixed(1)}MB`);

    /* 缓存确实生效：第二次搜同一个词应当命中解析缓存（同一批文件、mtime/size 未变）。
     * 只断言「不慢于第一次」—— 时序抖动的余量还是要留的。 */
    const t1 = Date.now();
    await bigSearch.search('NEEDLE');
    const second = Date.now() - t1;
    check('12g. 再搜一次走缓存（不慢于首次）', () => second <= elapsed + 50 || `首次 ${elapsed}ms / 第二次 ${second}ms`);
    console.log(`       第二次（命中缓存）耗时 ${second}ms`);
  }

  cleanup();
  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 500);
})().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
