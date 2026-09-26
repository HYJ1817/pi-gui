/* 会话全文搜索。
 *
 * ---------- 它解决的问题 ----------
 *
 * 一个项目用久了会攒下几十上百个会话。侧栏能列出它们、能切、能归档，
 * 但**没有一条路能回答「我以前问过什么」** —— 只能一条条点进去翻。
 *
 * 这个模块在**当前项目**的会话里做确定性的文本搜索：标题、用户消息正文、
 * assistant 的文本正文。命中之后由前端切到那个会话并滚到对应的那次提问。
 *
 * ---------- 为什么是独立模块 ----------
 *
 * sessions.js 已经 500+ 行，搜索再塞进去会把两件事混在一起。但**模块之间不许
 * 互相 import**（`server.js → 模块` 是唯一依赖方向，`tests/modules.cjs` 有 DFS
 * 找环守卫），所以这里不 import sessions.js，而是由 server.js 把 sessions
 * 实例**注入**进来 —— 正是本项目一贯的「工厂函数 + 依赖注入」。
 *
 * ---------- 归属判定只有一处 ----------
 *
 * 扫哪些文件、哪些算「当前项目的」、哪些被软删除了，**全部**问
 * `sessions.forSearch.ownedSessions()`。这里一个字都不重新实现 ——
 * 两份归属判定迟早会漂，漂掉的那份就是一个跨项目读取的口子。
 *
 * ---------- 不索引什么（都是有意的） ----------
 *
 * 只取 `content` 里 `type === 'text'` 的片段。于是**天然不含**：
 * toolResult 的大块输出、图片 base64、附件二进制、thinking、toolCall 参数、
 * system prompt、项目指令、planner 执行日志。这些要么噪声大、要么根本不是
 * 「面向用户显示的正文」，索引它们只会让结果变脏、让搜索变慢。
 *
 * ---------- 安全 ----------
 *
 * - 前端只传关键词与范围，**不传路径**，也不传会话 ID；
 * - 所有会话都过 ownedSessions 的 header.cwd 归属校验（与列表同一处判定）；
 * - 软删除的会话文件**已被移出** sessions 目录，结构上就不可能被搜到；
 * - 读取一律走上限读取（`readCapped`），单会话与单次请求都有字节预算；
 * - symlink 越界：读之前 realpath 一次，解析到 sessions 根之外的直接跳过；
 * - 响应里**只有稳定 ID**（路径 sha1 前 16 位）与 pi 的 sessionId，
 *   没有任何绝对路径。
 *
 * ---------- 为什么可以缓存 ----------
 *
 * 缓存以**文件路径**为键，存的是「mtimeMs + size + 解析结果」。六个失效要求
 * 因此都是结构性的，不需要额外的失效代码：
 *   - 文件 mtime/size 变 → 键命中但版本不符 → 重读
 *   - rename → 换了路径 → 新键；旧键再也查不到（由容量上限淘汰）
 *   - archive → **不进缓存**，每次现读 flags（一次小文件读，很便宜）
 *   - delete → 文件已不在 sessions 目录 → 根本不会去查缓存
 *   - 新会话 → 新路径 → 缓存未命中 → 读
 *   - 切项目 → 只查「当前项目扫出来的文件」，缓存命中与否都不会串项目
 */
import fs from 'node:fs';
import path from 'node:path';
import { json } from './http-utils.js';

/* 上限。存在的意义是**兜底**，不是「防恶意」—— 服务只监听回环，
 * 真正要防的是「一个异常的大会话把一次搜索拖死」。
 *
 * ⚠️ 这里**没有**「最多扫几个会话」这一项，是有意的：加一个数量上限会让
 * 「第 N 个以后的会话永远搜不到」（按更新时间倒序截断的话，越老的越搜不到）。
 * 一次搜索实际上被三样东西夹住：
 *   1. **候选集** —— `sessions.ownedSessions()` 自己扫目录，它有一条候选上限
 *      （`MAX_SESSIONS * 4`，见 server/sessions.js）；
 *   2. **单个会话读多少** —— `maxSessionBytes`；
 *   3. **一共读多少** —— `maxTotalBytes`，到顶就停，并在 `scanned.truncated` 里报出来。
 * 结果侧另有 `maxResults` / `maxMatchesPerSession`。 */
export const LIMITS = Object.freeze({
  /** 单个会话最多读多少字节（超出部分不索引，并在结果里标 truncated）。 */
  maxSessionBytes: 8 * 1024 * 1024,
  /** 单次搜索的总读取预算 —— 到顶就停，而不是无限读下去。 */
  maxTotalBytes: 48 * 1024 * 1024,
  /** 每个会话最多回几条命中。 */
  maxMatchesPerSession: 5,
  /** 最多回几个会话。 */
  maxResults: 30,
  /** snippet 的总长度上限。 */
  maxSnippet: 160,
  /** snippet 命中位置前后各留多少字。 */
  snippetPad: 60,
  /** 单条消息里最多找几处命中（只用来判断「有没有更多」，不全部展开）。 */
  maxHitsPerMessage: 3,
  /** 关键词长度上限（超出截断，不报错）。 */
  maxQuery: 64,
  /** 关键词最短长度 —— 1 个字符的查询几乎必然命中一切。 */
  minQuery: 2,
  /** 缓存里最多留几个会话的解析结果。 */
  maxCacheEntries: 400,
  /** 每处理多少个会话就让出一次事件循环。
   *
   * 搜索是「扫一堆文件 + 同步解析」，如果一口气跑完，几百个大会话会把事件循环
   * 按住几百毫秒到几秒 —— 表现是界面输入卡顿（这正是规格里点名要避免的）。
   * 分片让出把**单次占用**压到「yieldEvery 个会话」的量级，总耗时几乎不变。 */
  yieldEvery: 20,
});

/** 正则元字符转义 —— 关键词是用户输入，必须当字面量而不是模式。 */
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 折掉连续空白与换行（snippet 用）。 */
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * 只取 `content` 里 **type === 'text'** 的片段。
 *
 * 这就是「不索引 tool output / 图片 / thinking」的落点：它们是别的 type，
 * 自然进不来。不要为了方便改成「有 text 字段就取」—— toolCall 的参数、
 * 扩展自定义类型都可能带 text 字段。
 */
function textParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const c of content) {
    if (c && c.type === 'text' && typeof c.text === 'string' && c.text) out.push(c.text);
  }
  return out.join('\n');
}

export function createSessionSearch({ runtime, sessions, limits = {}, env = process.env } = {}) {
  const L = { ...LIMITS, ...limits };
  const P = sessions.forSearch;
  const SEP = path.sep;

  /* 路径 → { mtimeMs, size, entries, title, truncated } */
  const cache = new Map();
  /** sessions 根的 realpath（symlink 越界判定用）。算不出来就退回不拦。 */
  let realRoot = null;
  let realRootTried = false;

  function rootReal() {
    if (!realRootTried) {
      realRootTried = true;
      try {
        realRoot = P.normCwd(fs.realpathSync(sessions.root));
      } catch {
        realRoot = null;
      }
    }
    return realRoot;
  }

  /**
   * 这个文件解析出来还在 sessions 根里面吗。
   *
   * 只在**真要读内容之前**调一次（缓存未命中时），所以开销与「读了多少个会话」
   * 同阶，不会给列表那条热路径增加任何成本。
   * 判断不出来时一律返回 true —— 宁可多读一个文件，也不要因为 realpath
   * 偶发失败就静默丢掉用户真实的会话。
   */
  function insideRoot(file) {
    const root = rootReal();
    if (!root) return true;
    try {
      const real = P.normCwd(fs.realpathSync(file));
      return real === root || real.startsWith(root + SEP);
    } catch {
      return true;
    }
  }

  /** 解析一个会话文件 → 可搜索的消息序列。读不出来回 null（坏文件不拖垮搜索）。 */
  function parse(file, maxBytes) {
    const r = P.readCapped(file, maxBytes);
    if (!r) return null;

    const lines = r.text.split('\n');
    const entries = [];
    let userCount = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      /* 快筛：不含 "message" 的行（模型切换、用量、标签、session_info…）一律跳过，
       * 不做 JSON.parse —— 与 sessions.js 的 summarize 同一个做法。 */
      if (!line || line.indexOf('"message"') === -1) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // 截断的半行 / 坏行，跳过这一条
      }
      if (!e || e.type !== 'message') continue;
      const body = e.message && typeof e.message === 'object' ? e.message : e;

      if (body.role === 'user') {
        const text = textParts(body.content);
        const myIndex = userCount;
        userCount++;
        if (text) entries.push({ role: 'user', text, ts: e.timestamp || null, id: e.id || null, userIndex: myIndex });
        continue;
      }

      if (body.role === 'assistant') {
        const text = textParts(body.content);
        // assistant 归属**最近一次**用户提问；前面没有提问时归到 0
        if (text) entries.push({ role: 'assistant', text, ts: e.timestamp || null, id: e.id || null, userIndex: Math.max(0, userCount - 1) });
        continue;
      }
      /* toolResult / 其它 role：**不索引**（大块输出、噪声高）。 */
    }

    return { entries, truncated: r.truncated, size: r.size };
  }

  /** 带版本校验地取解析结果。 */
  function parsed(file, maxBytes) {
    const st = statOf(file);
    const hit = cache.get(file);
    /* 失效判据要**同时**看 mtime 与 size：
     *   - 某些文件系统 mtime 分辨率很粗（同一秒内的改动看不出来），只比 mtime
     *     会让「刚追加了一条消息」搜不到；
     *   - 还要看上次是按多大的上限解析的 —— 预算紧张那次可能只读了一小段，
     *     直接复用会让**结果依赖扫描顺序**。 */
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.cappedAt >= maxBytes) return hit;

    const p = parse(file, maxBytes);
    if (!p) return null;
    const rec = { ...p, mtimeMs: st.mtimeMs, cappedAt: maxBytes };
    cache.set(file, rec);
    /* 容量上限：超了就丢最早插入的（Map 保持插入序）。
     * 不做 LRU —— 一个被淘汰的会话下次只是重读一遍，代价可控。 */
    while (cache.size > L.maxCacheEntries) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    return rec;
  }

  function statOf(file) {
    try {
      const st = fs.statSync(file);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return { mtimeMs: 0, size: -1 };
    }
  }

  /** 在某段文本里找出关键词的全部位置（区分大小写？不 —— `i` 标志，且保留原串下标）。 */
  function hits(text, re) {
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      out.push(m.index);
      if (out.length >= L.maxHitsPerMessage) break;
      if (m.index === re.lastIndex) re.lastIndex++; // 零宽保护
    }
    return out;
  }

  /** 命中位置前后各截一段，折掉空白。 */
  function snippet(text, idx, qlen) {
    const start = Math.max(0, idx - L.snippetPad);
    const end = Math.min(text.length, idx + qlen + L.snippetPad);
    let s = oneLine(text.slice(start, end));
    if (s.length > L.maxSnippet) s = s.slice(0, L.maxSnippet) + '…';
    return s;
  }

  /**
   * 搜索当前项目的会话。
   * @param {string} q      关键词（会被 trim / 截断）
   * @param {string} scope  active | archived | all
   */
  async function search(q, scope = 'active') {
    const raw = String(q == null ? '' : q).trim();
    const query = raw.slice(0, L.maxQuery);
    const sc = scope === 'archived' || scope === 'all' ? scope : 'active';

    const empty = {
      ok: true,
      query,
      scope: sc,
      hasProject: Boolean(runtime.getCurrentCwd()),
      results: [],
      scanned: { sessions: 0, bytes: 0, skipped: 0, truncated: false },
    };
    // 空 / 过短关键词：**一次磁盘都不碰**
    if (query.length < L.minQuery) return { ...empty, tooShort: true };

    const { cwd, items, skipped: unreadable } = P.ownedSessions();
    if (!cwd) return { ...empty, hasProject: false };

    const want = sc === 'all' ? items : items.filter((s) => (sc === 'archived' ? s.archived : !s.archived));
    /* 最近更新的先看 —— 这样命中上限先被「用户更可能想找的」占掉；
     * 最终排序用的也是这个顺序。 */
    want.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const re = new RegExp(escRe(query), 'gi');
    const results = [];
    let bytes = 0;
    /* 从 ownedSessions 带来的 skipped 开始算：那是「会话文件根本读不出来」
     * （坏 JSON / 没有合法 header）的数量。搜索必须把它**如实报出去**，
     * 否则用户会以为「搜不到就是真没有」，而其实是有些文件压根没被读到。 */
    let skipped = unreadable;
    let truncated = false;
    let seen = 0;

    for (const s of want) {
      if (results.length >= L.maxResults) break;
      if (bytes >= L.maxTotalBytes) {
        truncated = true;
        break;
      }
      /* 每 yieldEvery 个让出一次事件循环。放在循环**开头** —— 放末尾的话，
       * 上面那些 continue（坏文件 / symlink 越界）会把让出跳过去，
       * 「连续遇到一堆坏文件」就又变回一次长阻塞。 */
      seen++;
      if (seen % L.yieldEvery === 0) await new Promise((r) => setImmediate(r));
      if (!insideRoot(s.file)) {
        skipped++;
        continue;
      }

      let rec;
      try {
        /* 每个会话都按**同一个**上限读。不用「剩余预算」去压这一次的上限 ——
         * 那会让同一个关键词的结果随扫描顺序变化（前一次搜得到、后一次搜不到）。
         * 预算的作用是**限制扫几个会话**，不是限制每个读多少。 */
        rec = parsed(s.file, L.maxSessionBytes);
      } catch {
        rec = null; // 单个坏文件绝不能把整次搜索带塌
      }
      if (!rec) {
        skipped++;
        continue;
      }
      bytes += Math.min(rec.size, L.maxSessionBytes);
      if (rec.truncated) truncated = true;

      const matches = [];
      /* 标题命中优先。标题来自 sessions.js 的 summarize —— **用户改过名就是那个名字，
       * 否则是第一条用户消息**。规则只留那一处，这里不重算（重算就有两个真相）。 */
      if (s.title && hits(s.title, re).length) {
        matches.push({ type: 'title', index: 0, userIndex: 0, messageId: null, timestamp: s.lastMessageAt || null, snippet: s.title });
      }
      for (let ei = 0; ei < rec.entries.length; ei++) {
        if (matches.length >= L.maxMatchesPerSession) break;
        const e = rec.entries[ei];
        const first = hits(e.text, re)[0];
        if (first === undefined) continue;
        matches.push({
          type: e.role, // 'user' | 'assistant'
          index: ei,
          userIndex: e.userIndex,
          messageId: e.id,
          timestamp: e.ts,
          snippet: snippet(e.text, first, query.length),
        });
      }
      if (!matches.length) continue;

      results.push({
        /* id = 我们那个稳定 ID，前端**只用它**去切会话（不传路径）。 */
        id: s.id,
        sessionId: s.sessionId,
        title: s.title,
        archived: Boolean(s.archived),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messageCount,
        matches: matches.slice(0, L.maxMatchesPerSession),
      });
    }

    /* 同一会话内：标题命中在前，其余按消息顺序。会话之间：更新时间倒序。
     * 不做相关性打分 —— 稳定、可解释比「聪明」更重要。 */
    for (const r of results) {
      r.matchCount = r.matches.length;
      r.matches.sort((a, b) => (a.type === 'title' ? -1 : b.type === 'title' ? 1 : a.index - b.index));
    }
    results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    return {
      ok: true,
      query,
      scope: sc,
      hasProject: true,
      results: results.slice(0, L.maxResults),
      /* sessions = 本次**考虑过**的会话数（scope 过滤之后）；
       * skipped = 读不出来被跳过的（坏文件 / symlink 越界）；
       * truncated = 有会话超出读取上限，只索引了前半部分。 */
      scanned: { sessions: want.length, bytes, skipped, truncated },
    };
  }

  function handle(req, res, url) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed' });
    const q = url.searchParams.get('q') || '';
    const scope = url.searchParams.get('scope') || 'active';
    return search(q, scope)
      .then((r) => json(res, 200, r))
      .catch((err) =>
        // 搜索失败不回 500：前端只需要「失败了」，不需要分辨状态码
        json(res, 200, { ok: false, error: String((err && err.message) || err), results: [] })
      );
  }

  /** 供测试与调试：清空解析缓存。 */
  function clearCache() {
    cache.clear();
  }

  return { search, handle, clearCache, _limits: L };
}
