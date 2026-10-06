/* 会话列表与切换。
 *
 * ---------- 为什么需要这个模块 ----------
 *
 * Pi GUI 一直有「新对话」（RPC `new_session`），却**没有任何入口切回旧会话**。
 * 用户点一下「新对话」，旧对话就从界面上消失了 —— 它其实还完整躺在磁盘上，
 * 但界面上再也够不着。这是一个真实的、会让人以为「对话丢了」的缺口。
 *
 * pi 的 RPC 里有 `switch_session`（收一个会话文件路径），**但没有「列出会话」的命令** ——
 * 它的 TUI 有自己的 picker（`pi -r`），那个没有对外的 RPC。所以列表只能我们自己扫目录。
 *
 * ---------- 会话文件在哪 ----------
 *
 * `<agentDir>/sessions/<cwd 编码后的目录名>/<时间戳>_<id>.jsonl`
 * （见 pi 的 docs/sessions.md：「organized by working directory」）。
 * 目录名的规则实测是 `'--' + cwd.replace(/[\\/:]/g, '-') + '--'`，
 * 但**我们不只信目录名** —— 每个会话文件的第一行是
 * `{"type":"session","version":3,"id":"…","timestamp":"…","cwd":"…"}`，
 * 用它核对 cwd 才算数（目录名规则是 pi 的实现细节，变了我们也不会串项目）。
 *
 * ---------- 安全边界（与 skills.js 同一条思路）----------
 *
 * 前端**只拿得到稳定 ID**（路径的 sha1 前 16 位），拿不到也传不了绝对路径。
 * 切换时后端在自己的索引里查真实路径，并且要求那条会话的 header.cwd
 * 与当前项目一致 —— 于是**不可能切到别的项目的会话上去**。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSafeSessionId } from '../lib/session-id.js';
import { json, readBody } from './http-utils.js';
import { piState, sessionMessageBody } from './pi-compat.js';

const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_TITLE = 80;
const MAX_SESSIONS = 200;
const MAX_FLAGS = 5000;
const FLAGS_FILE = 'session-flags.json';
const TRASH_DIR = 'trash-sessions';

/** 稳定 ID：路径的 sha1 前 16 位（与 skills.js 同一个做法）。 */
function sessionId(file) {
  const resolved = path.resolve(file);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function normCwd(p) {
  if (!p) return '';
  const r = path.resolve(String(p)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** 读文件开头若干字节（会话文件可能很大，标题和统计不需要全读）。 */
function readCapped(file, maxBytes = MAX_READ_BYTES) {
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(stat.size, maxBytes);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, 0);
      return { text: buf.subarray(0, n).toString('utf8'), truncated: stat.size > maxBytes, size: stat.size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && (c.type === 'text' || typeof c.text === 'string') ? String(c.text || '') : ''))
    .join(' ')
    .trim();
}

/** 创建时间只认创建时的证据；mtime 与消息/改名条目都不是创建时间。 */
function creationTime(file, header = null) {
  const validTime = (value) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  };
  const fromHeader = validTime(header?.createdAt) || validTime(header?.timestamp);
  if (fromHeader) return fromHeader;
  /* Pi newSession() 用同一个 header.timestamp 生成文件名，只把冒号与点换成 -。
   * 空会话尚未落盘也有这个文件名，所以补位与落盘使用完全相同的创建时间。
   * 严格匹配并往返核对，不能把任意文件名或 2 月 30 日当成时间证据。 */
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_[^/\\]+\.jsonl$/.exec(path.basename(file));
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  return validTime(iso) === iso ? iso : null;
}

/** 同时刻/未知时间按稳定身份打破平局，不依赖扫描顺序、当前项或文件更新时间。 */
function compareCreation(a, b) {
  const at = a.createdAt ? Date.parse(a.createdAt) : -Infinity;
  const bt = b.createdAt ? Date.parse(b.createdAt) : -Infinity;
  if (at !== bt) return at > bt ? -1 : 1;
  const ak = `${a.sessionId || ''}\0${a.id}`;
  const bk = `${b.sessionId || ''}\0${b.id}`;
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}

export function createSessions({ runtime, rpc = null, env = process.env, homeDir = null, dataDir = null, compat = null, extraSessionRoots = [], getProjects = () => [] } = {}) {
  const HOME = homeDir || env.HOME || os.homedir();
  const configuredAgentDir = env.PI_CODING_AGENT_DIR;
  const AGENT_DIR = configuredAgentDir === '~' ? HOME : configuredAgentDir?.startsWith('~/') || configuredAgentDir?.startsWith('~\\')
    ? path.join(HOME, configuredAgentDir.slice(2)) : configuredAgentDir || path.join(HOME, '.pi', 'agent');
  const ROOT = path.join(AGENT_DIR, 'sessions');

  /* ---------- P7：额外的会话根目录 ----------
   *
   * Planner 用 pi 跑任务时会话落在 `<PI_GUI_DATA>/planner-sessions`（见 server.js
   * 的说明）—— 那是**刻意**跟主聊天的会话目录分开的，否则主聊天的 `--continue`
   * 会接上某个任务的上下文。
   *
   * 代价是：那些会话不在本模块的扫描范围里，于是「从任务打开会话」够不着它们。
   * 这里给它们留一个入口 —— 注入的根目录列表，**只用于「按会话 id 精确定位」**，
   * 不进 `ownedSessions()`（那是「当前项目的会话列表」，把任务会话混进去会让
   * 侧栏被几十条任务会话淹没）。
   *
   * 注意这不是「第二套会话加载」：解析出来之后走的还是同一个 switchToTarget /
   * switch_session，归属判定也复用同一个 cwd 规则。 */
  const EXTRA_ROOTS = (Array.isArray(extraSessionRoots) ? extraSessionRoots : [])
    .filter((d) => typeof d === 'string' && d.trim())
    .map((d) => path.resolve(d));

  /* 兼容层（P4，可选注入）。它只**观察**，不参与任何判断 ——
   * 会话逻辑一行都不因它改变。 */
  function notifyCompat(fn) {
    if (!compat) return;
    try {
      fn(compat);
    } catch {
      /* 观察失败就当没看见 */
    }
  }

  /* 归档与回收站是 **Pi GUI 自己的**状态，pi 根本没有这两个概念 ——
   * 所以不往 pi 的目录里塞任何东西，只记在我们自己的数据目录里
   * （`<PI_GUI_DATA>/session-flags.json` + `trash-sessions/`）。
   *
   * 记的是 pi 的 sessionId（header 里的 UUID）而不是我们自己那个
   * 「路径 sha1」ID：前者跟着会话走，文件挪了位置也不会失配。 */
  const DATA = dataDir || path.join(AGENT_DIR, '.pi-gui');
  const FLAGS = path.join(DATA, FLAGS_FILE);
  const TRASH = path.join(DATA, TRASH_DIR);

  /** pi 把 cwd 编码成目录名。只用来**缩小扫描范围**，不用来判定归属。 */
  function dirNameFor(cwd) {
    return '--' + String(cwd).replace(/[\\/:]/g, '-') + '--';
  }

  /** 解析一个会话文件 → 摘要。读不出来就回 null（坏文件不能拖垮整个列表）。 */
  function summarize(file) {
    const r = readCapped(file);
    if (!r) return null;
    const lines = r.text.split('\n');
    let header = null;
    try {
      header = JSON.parse(lines[0] || '');
    } catch {
      return null;
    }
    if (!header || header.type !== 'session' || !header.id) return null;

    let firstUserText = '';
    let named = '';
    let sawNestedBody = false;
    let messageCount = 0;
    let lastTs = header.timestamp || null;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      /* 快筛：只关心 message 与 session_info 两类行，其余（模型切换、用量、
       * 标签、压缩…）不做 JSON.parse。 */
      if (!line || (line.indexOf('"message"') === -1 && line.indexOf('"session_info"') === -1)) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === 'session_info') {
        /* pi 的 `set_session_name` 把名字写在这里。**用户明确起的名字优先于
         * 第一条用户消息** —— 不读它的话，改名一刷新就退回原样（列表上看着
         * 像「改名没生效」），而 P3 的搜索又要按标题搜。
         * 多条时后者胜（后一次改名覆盖前一次）。 */
        if (typeof e.name === 'string' && e.name.trim()) named = e.name.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE);
        continue;
      }
      if (e.type !== 'message') continue;
      messageCount++;
      if (e.timestamp) lastTs = e.timestamp;
      /* 消息体是**嵌在 `message` 字段下**的：
       *   {"type":"message","id":…,"timestamp":…,"message":{"role":"user","content":…}}
       * 不是顶层的 role/content（第一版按顶层读，结果 14 条消息一条标题都抽不出来）。
       * 两种形状都认（`sessionMessageBody` 是服务端**唯一**一处判形状的地方，
       * session-search.js 与它共用），免得 pi 换格式时又静默失效。 */
      if (e.message && typeof e.message === 'object' && !Array.isArray(e.message)) sawNestedBody = true;
      const body = sessionMessageBody(e);
      // 标题退路取**第一条用户消息** —— 那是人一眼能认出「这是哪次对话」的东西
      if (!firstUserText && body && body.role === 'user') {
        firstUserText = textOf(body.content).replace(/\s+/g, ' ').slice(0, MAX_TITLE);
      }
    }

    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      /* 读不到时间就按 0 排最后 */
    }

    return {
      id: sessionId(file),
      file,
      sessionId: String(header.id),
      cwd: String(header.cwd || ''),
      createdAt: creationTime(file, header),
      lastMessageAt: lastTs,
      updatedAt: mtime,
      messageCount,
      title: named || firstUserText || '（还没有消息）',
      truncated: r.truncated,
      bytes: r.size,
      /* 下面两个是**给兼容层看的内部标记**，不进任何接口响应
       * （list() 的映射是显式列字段的，多出来的不会漏出去）。 */
      sawNestedBody,
      sawName: Boolean(named),
    };
  }

  /** 列出候选文件：先试按 cwd 编码出来的目录，不行再退回全量扫描。 */
  function candidateFiles(cwd) {
    const out = [];
    const guess = path.join(ROOT, dirNameFor(cwd));
    const pushDir = (dir) => {
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        return 0;
      }
      for (const n of names) out.push(path.join(dir, n));
      return names.length;
    };

    if (pushDir(guess) > 0) return out;

    // 目录名规则变了 / 首次运行 → 退回全量扫描（上限保护）
    let dirs = [];
    try {
      dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return out;
    }
    for (const d of dirs) pushDir(path.join(ROOT, d));
    return out;
  }

  /**
   * 当前项目**归属正确**的会话（含归档标记），**排除软删除**。
   *
   * 列表与搜索**共用这一处归属判定** —— 安全上只允许有一个地方回答
   * 「这条会话属不属于当前项目」。搜索另写一份的话，两份迟早会漂，
   * 而漂掉的那一份就是一个跨项目读取的口子。
   *
   * @returns {{cwd:string|null, items:Array, skipped:number}}
   *   items 的每一项都带 `file`（**绝对路径，只给后端内部用，不许出现在响应里**）。
   */
  function ownedSessions(cwd = runtime.getCurrentCwd()) {
    if (!cwd) return { cwd: null, items: [], skipped: 0 };
    const want = normCwd(cwd);
    const flags = readFlags();
    const deleted = new Set(flags.deleted.map((d) => d && d.sessionId).filter((x) => typeof x === 'string'));
    const archived = new Set(flags.archived);
    const items = [];
    let skipped = 0;
    /* 顺带记下「这一遍扫到了什么形状」—— 兼容层的证据来源之一。
     * **只统计，不参与本函数的任何判断。** */
    let attempted = 0;
    let headerOk = 0;
    let cwdOk = 0;
    let namingSeen = false;
    let sawNested = false;

    for (const f of candidateFiles(cwd).slice(0, MAX_SESSIONS * 4)) {
      attempted++;
      const s = summarize(f);
      if (!s) {
        skipped++;
        continue;
      }
      headerOk++;
      if (s.sawName) namingSeen = true;
      if (s.sawNestedBody) sawNested = true;
      // **归属判定只认 header.cwd**，不认目录名
      if (normCwd(s.cwd) !== want) continue;
      cwdOk++;
      const key = flagKey(s);
      /* 软删除是把文件**移出** sessions 目录，所以正常路径下它已经不在
       * candidateFiles 里了；这里再按 flags 挡一道，是为了「文件被手工挪回来」
       * 时不至于让它复活 —— 删除在用户看来必须是不可见的。 */
      if (deleted.has(key)) continue;
      s.archived = archived.has(key);
      items.push(s);
    }
    notifyCompat((c) => c.observeSessionScan({ attempted, headerOk, cwdOk, namingSeen, shapes: { nested: sawNested } }));
    return { cwd, items, skipped };
  }

  /**
   * 当前项目的会话列表。
   * @returns {{ok:boolean, hasProject:boolean, sessions:Array, currentId:string|null, diagnostics:Array}}
   *   **不回绝对路径**（见下面的说明）。
   */
  async function list(project = null) {
    if (project !== null && (typeof project !== 'string' || !project.trim() || !getProjects().some(p => typeof p.path === 'string' && normCwd(p.path) === normCwd(project)))) {
      return { ok: false, error: '项目不在已添加的列表中', hasProject: false, sessions: [] };
    }
    const target = project === null ? runtime.getCurrentCwd() : project;
    const { cwd, items, skipped } = ownedSessions(target);
    const diagnostics = [];
    if (!cwd) return { ok: true, hasProject: false, sessions: [], currentId: null, diagnostics };

    const sessions = items;
    if (skipped) diagnostics.push({ level: 'warn', message: `有 ${skipped} 个会话文件读不出来，已跳过` });

    /* 当前会话从 pi 那里问（get_state 给 sessionFile），而不是靠猜 ——
     * 「界面显示的是哪个会话」只有 pi 自己说了算。
     * 判据（sessionFile 在不在）收敛在 pi-compat 的 piState() 里，
     * 本文件另一处问 get_state 也用它 —— 同一条规则不写两遍。 */
    let curState = { ok: false };
    if (normCwd(target) === normCwd(runtime.getCurrentCwd()) && rpc && typeof rpc.request === 'function') {
      curState = piState(await rpc.request({ type: 'get_state' }));
    }
    const currentFile = curState.ok ? curState.sessionFile : null;
    const currentId = currentFile ? sessionId(currentFile) : null;

    /* ⚠️ pi 在会话还没有任何内容时**不落盘**。
     * 实测（`.probe/probe-sessions-new.cjs`）：`new_session` 之后 get_state 已经
     * 给出了新的 sessionFile，但那个文件在磁盘上还不存在，要等第一条消息才写。
     * 只按磁盘文件列的话，刚开的空会话不在列表里 ⇒ 界面上「当前项」仍然是旧会话，
     * 而当前项是不给点的（你已经在里面了）⇒ **用户再也回不到旧对话**，
     * 症状就是「开个新对话，旧对话就消失了」。
     * 所以把 pi 报的当前会话补进来，标成 pending（磁盘上还没有这个文件）。 */
    if (currentId && !sessions.some((s) => s.id === currentId)) {
      sessions.push({
        id: currentId,
        file: currentFile,
        sessionId: curState.sessionId ? String(curState.sessionId) : '',
        cwd,
        createdAt: creationTime(currentFile),
        lastMessageAt: null,
        updatedAt: null,
        messageCount: typeof curState.messageCount === 'number' ? curState.messageCount : 0,
        title: String(curState.sessionName || '').trim() || '新会话（还没有消息）',
        truncated: false,
        bytes: 0,
        pending: true,
      });
    }

    sessions.sort(compareCreation);

    /* 只回 currentId，**不回 currentFile / cwd**。
     * 会话文件的绝对路径没有必要给前端 —— 切换只认我们自己发的 ID，
     * 前端拿不到路径就少一条「顺着路径去猜别的文件」的路子。
     * cwd 同理：界面上本来就知道当前项目，不需要接口再回一次。 */
    return {
      ok: true,
      hasProject: true,
      currentId,
      diagnostics,
      sessions: sessions.slice(0, MAX_SESSIONS).map((s) => ({
        id: s.id,
        title: s.title,
        sessionId: s.sessionId,
        createdAt: s.createdAt,
        lastMessageAt: s.lastMessageAt,
        updatedAt: s.updatedAt,
        messageCount: s.messageCount,
        current: s.id === currentId,
        /* pending = 磁盘上还没有这个文件（刚开的新会话）。这种条目不能切、
         * 不能归档、不能删 —— 界面上也就不给它那些动作。 */
        pending: Boolean(s.pending),
        archived: !s.pending && Boolean(s.archived),
        truncated: s.truncated,
      })),
    };
  }

  /** 按 ID 找真实路径 —— 前端永远不传路径。 */
  function resolveId(id) {
    const cwd = runtime.getCurrentCwd();
    if (!cwd) return null;
    const want = normCwd(cwd);
    for (const f of candidateFiles(cwd)) {
      if (sessionId(f) !== id) continue;
      const s = summarize(f);
      if (!s) return null;
      // 双重确认：这条会话确实属于当前项目
      if (normCwd(s.cwd) !== want) return null;
      return s;
    }
    return null;
  }

  /* ---------- P7：按 pi 的会话 id 精确定位 ----------
   *
   * 用途只有一个：从「任务的某次执行」跳到那条会话（见 server/planner/index.js
   * 的 open-session 路由）。与上面的 resolveId 有三点不同，都是刻意的：
   *
   *   1. **输入是 pi 的会话 id（UUID 形态），不是我们那个路径 sha1。**
   *      任务元数据里存的就是这个 —— 它跟着会话走，文件改名/移动都不会失配。
   *   2. **扫描范围包含 EXTRA_ROOTS**（Planner 的会话目录）。
   *   3. **归属判定放宽成「在项目内」而不是「cwd 完全相等」。**
   *      原因是任务的工作目录可以是子目录（`workingDirectory: 'src'`），
   *      那种会话的 header.cwd 是 `<项目>/src`，严格相等会把它判成别的项目。
   *      「在项目内」仍然是「不可能切到别的项目上去」—— 只是把「本项目的子目录」
   *      也算进来。这条放宽**只作用于本函数**，`ownedSessions()` 的严格规则不动。
   */
  function isInsideProject(target, projectRoot) {
    const t = normCwd(target);
    const p = normCwd(projectRoot);
    if (!t || !p) return false;
    if (t === p) return true;
    return t.startsWith(p + path.sep);
  }

  /** 列出一个根目录下的 .jsonl：根目录本身 + 它的一层子目录。
   *  默认根是 `<agentDir>/sessions/<cwd 编码>/`（一层子目录），
   *  而 `--session-dir` 指定的目录是**平铺**的（pi 的 SessionManager 直接用这个
   *  目录，不再按 cwd 分子目录）—— 所以两种形状都要覆盖。 */
  function filesInRoot(root) {
    const out = [];
    const push = (dir) => {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const n of names) if (n.endsWith('.jsonl')) out.push(path.join(dir, n));
    };
    push(root);
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory()) push(path.join(root, e.name));
      }
    } catch {
      /* 根目录不存在很正常（还没有任何会话） */
    }
    return out;
  }

  /**
   * 按 pi 的会话 id 找会话。
   *
   * 先用**文件名后缀**筛（pi 的命名是 `<ISO 时间戳>_<encodeURIComponent(id)>.jsonl`，
   * 见 `sessionFileName`），再读 header 核对 id 与 cwd —— 文件名只是线索，
   * 归属仍然只认 header（和 ownedSessions 同一条规矩）。
   *
   * @returns {object|null} 与 summarize() 同形状（含 `file`，**绝对路径，不外传**）
   */
  /**
   * 批量版：一次扫描解析多个会话 id。
   *
   * 存在的理由是**避免 N+1**（规格 §34）：一个 Plan 详情要显示每个 attempt 的会话，
   * 逐个调 resolveByUuid 会把会话目录扫 N 遍。这里把目录只走一遍，
   * 用文件名里那段 id 先筛（pi 的命名是 `<时间戳>_<encodeURIComponent(id)>.jsonl`），
   * 命中的再读 header 核对 —— 与单条版是同一条判据，只是不再重复扫目录。
   *
   * @returns {Map<string, object>} id → summarize() 结果（找不到的 id 不在 Map 里）
   */
  function resolveManyByUuid(uuids) {
    const want = new Set((Array.isArray(uuids) ? uuids : []).filter((u) => isSafeSessionId(u)));
    const out = new Map();
    if (!want.size) return out;
    const cwd = runtime.getCurrentCwd();
    if (!cwd) return out;
    for (const root of [ROOT, ...EXTRA_ROOTS]) {
      for (const f of filesInRoot(root)) {
        const m = /_([^_/\\]+)\.jsonl$/.exec(path.basename(f));
        if (!m) continue;
        let id = '';
        try {
          id = decodeURIComponent(m[1]);
        } catch {
          continue; // 文件名里的转义坏了，跳过这个文件
        }
        if (!want.has(id) || out.has(id)) continue;
        const s = summarize(f);
        if (!s || s.sessionId !== id) continue;
        if (!isInsideProject(s.cwd, cwd)) continue;
        out.set(id, s);
      }
    }
    return out;
  }

  /** 按 pi 的会话 id 找会话（单条 = 批量版的封装，保证两者判据永远一致）。 */
  function resolveByUuid(uuid) {
    if (!isSafeSessionId(uuid)) return null; // 前端传进来的，先挡住路径类输入
    return resolveManyByUuid([uuid]).get(uuid) || null;
  }

  /* ---------- 归档 / 删除（Pi GUI 自己的状态，不碰 pi） ---------- */

  /** 读 flags。坏文件一律当空的 —— 不能因为一个坏文件就让整个会话列表打不开。 */
  function readFlags() {
    try {
      const j = JSON.parse(fs.readFileSync(FLAGS, 'utf8'));
      return {
        archived: Array.isArray(j.archived) ? j.archived.filter((x) => typeof x === 'string') : [],
        deleted: Array.isArray(j.deleted) ? j.deleted.filter((x) => x && typeof x === 'object') : [],
      };
    } catch {
      return { archived: [], deleted: [] };
    }
  }

  /** 原子写（同目录临时文件 → rename）。保留版本号，方便以后改格式。 */
  function writeFlags(flags) {
    const body = JSON.stringify(
      {
        version: 1,
        archived: [...new Set(flags.archived)].slice(-MAX_FLAGS),
        deleted: flags.deleted.slice(-MAX_FLAGS),
      },
      null,
      2
    );
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = `${FLAGS}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, FLAGS);
  }

  /** flags 里用的键：pi 的 sessionId 优先（稳定），退到我们自己的路径 ID。 */
  const flagKey = (s) => s.sessionId || s.id;

  /** 问 pi 当前会话是哪个（只回我们的稳定 ID，不回路径）。 */
  async function currentSessionId() {
    if (!rpc || typeof rpc.request !== 'function') return null;
    const st = piState(await rpc.request({ type: 'get_state' }));
    return st.ok ? sessionId(st.sessionFile) : null;
  }

  /**
   * 归档 / 取消归档。
   * 归档只影响**我们的列表**：文件原地不动，pi 也照旧看得见它。
   * 这样「归档」是可逆的纯组织动作，不会让 pi 的 --continue 行为变得不可预测。
   */
  async function setArchived(id, archived) {
    const target = resolveId(id);
    if (!target) return { ok: false, error: '找不到这个会话（可能已被删除，或不属于当前项目）' };
    if (archived) {
      const cur = await currentSessionId();
      if (cur && cur === sessionId(target.file)) {
        return { ok: false, error: '不能归档正在进行的会话 —— 先切到别的会话再归档' };
      }
    }
    const key = flagKey(target);
    const flags = readFlags();
    const set = new Set(flags.archived);
    if (archived) set.add(key);
    else set.delete(key);
    flags.archived = [...set];
    try {
      writeFlags(flags);
    } catch (err) {
      return { ok: false, error: '写不进归档记录：' + String(err.message || err) };
    }
    return { ok: true, id, archived: Boolean(archived), title: target.title };
  }

  /**
   * 删除（软删除）。
   *
   * **不是 unlink** —— 会话文件是用户真实的对话记录，一次误点不该是不可逆的。
   * 把文件移进 `<PI_GUI_DATA>/trash-sessions/`，并把「原来是谁」记进 flags，
   * 所以事后还能人工找回（README 里写了位置）。
   *
   * 当前会话拒绝删除：pi 正开着那个文件往里追加，删掉它等于把正在写的会话弄坏。
   */
  async function remove(id) {
    const target = resolveId(id);
    if (!target) return { ok: false, error: '找不到这个会话（可能已被删除，或不属于当前项目）' };
    const cur = await currentSessionId();
    if (cur && cur === sessionId(target.file)) {
      return { ok: false, error: '不能删除正在进行的会话 —— 先切到别的会话再删' };
    }

    const key = flagKey(target);
    const name = `${key}.jsonl`;
    const dest = path.join(TRASH, name);
    try {
      fs.mkdirSync(TRASH, { recursive: true });
      try {
        fs.renameSync(target.file, dest);
      } catch (err) {
        // 跨盘符时 rename 会 EXDEV —— 退到「复制 + 删原件」
        if (err && err.code === 'EXDEV') {
          fs.copyFileSync(target.file, dest);
          fs.unlinkSync(target.file);
        } else {
          throw err;
        }
      }
    } catch (err) {
      return { ok: false, error: '删除失败：' + String(err.message || err) };
    }

    try {
      const flags = readFlags();
      flags.archived = flags.archived.filter((x) => x !== key);
      flags.deleted.push({
        sessionId: key,
        title: target.title,
        cwd: target.cwd,
        messageCount: target.messageCount,
        bytes: target.bytes,
        deletedAt: Date.now(),
        trashedAs: name,
      });
      writeFlags(flags);
    } catch {
      /* 文件已经移走了，元数据没记上不该把删除报成失败 —— 只是少了可追溯性 */
    }
    return { ok: true, id, title: target.title };
  }

  /**
   * 真的去切一个**已经解析好的**目标。
   *
   * 与 switchTo 分开，是因为调用方有两种：侧栏点一条会话（先按我们自己的 ID 解析），
   * 以及 Planner 从任务跳到会话（先按 pi 的会话 id 解析）。两者解析方式不同，
   * **切换这一步必须完全相同** —— 否则「从侧栏切」和「从任务切」会走上两条
   * 逐渐分叉的代码路径，而分叉出来的那条迟早会漏掉某个收尾动作。
   */
  async function switchToTarget(target) {
    if (!rpc || typeof rpc.request !== 'function') return { ok: false, code: 'no-rpc', error: 'pi 未连接，无法切换会话' };
    const res = await rpc.request({ type: 'switch_session', sessionPath: target.file });
    if (!res) return { ok: false, code: 'no-answer', error: 'pi 没有应答（可能正在忙，或子进程未运行）' };
    if (res.__error) return { ok: false, code: 'failed', error: String(res.__error) };
    if (res.cancelled) return { ok: false, code: 'cancelled', error: '切换被扩展取消了' };
    return { ok: true, id: target.id, title: target.title };
  }

  async function switchTo(id) {
    const target = resolveId(id);
    if (!target) return { ok: false, code: 'not-found', error: '找不到这个会话（可能已被删除，或不属于当前项目）' };
    return switchToTarget(target);
  }

  async function rename(name) {
    const clean = String(name || '').trim().slice(0, 120);
    if (!clean) return { ok: false, error: '名字不能为空' };
    if (!rpc || typeof rpc.request !== 'function') return { ok: false, error: 'pi 未连接' };
    const res = await rpc.request({ type: 'set_session_name', name: clean });
    if (!res || res.__error) return { ok: false, error: (res && res.__error) || 'pi 没有应答' };
    return { ok: true, name: clean };
  }

  /** 解析 POST body 并取出会话 ID。三条路由（switch / archive / delete）共用，
   * 免得同一个校验复制三遍、各自漏一条。 */
  async function readId(req) {
    const raw = await readBody(req).catch((err) => ({ __tooBig: String(err.message || err) }));
    if (raw && raw.__tooBig) return { err: { status: 413, body: { ok: false, error: raw.__tooBig } } };
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return { err: { status: 400, body: { ok: false, error: '请求体不是合法 JSON' } } };
    }
    if (typeof body.id !== 'string' || !body.id || body.id.length > 64) {
      return { err: { status: 400, body: { ok: false, error: '缺少合法的会话 ID' } } };
    }
    return { id: body.id, body };
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (p === '/api/sessions') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed' });
      try {
        return json(res, 200, await list(url.searchParams.has('project') ? url.searchParams.get('project') : null));
      } catch (err) {
        // 列表打不开是最糟的结果 —— 兜底成 200 + 空列表 + 诊断
        return json(res, 200, { ok: false, error: String(err.message || err), hasProject: false, sessions: [], diagnostics: [{ level: 'error', message: `扫描会话时出错：${err.message}` }] });
      }
    }
    if (p === '/api/sessions/switch') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
      const { id, err } = await readId(req);
      if (err) return json(res, err.status, err.body);
      // 业务失败一律回 200 + ok:false —— 前端只看 ok 字段，不必分辨状态码
      return json(res, 200, await switchTo(id));
    }
    if (p === '/api/sessions/name') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
      const raw = await readBody(req).catch(() => '{}');
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      return json(res, 200, await rename(body.name));
    }
    if (p === '/api/sessions/archive') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
      const { id, body, err } = await readId(req);
      if (err) return json(res, err.status, err.body);
      return json(res, 200, await setArchived(id, body.archived !== false));
    }
    if (p === '/api/sessions/delete') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
      const { id, err } = await readId(req);
      if (err) return json(res, err.status, err.body);
      return json(res, 200, await remove(id));
    }
    return json(res, 404, { ok: false, error: 'Not found' });
  }

  return {
    handle,
    list,
    switchTo,
    rename,
    setArchived,
    remove,
    /* P7：给 Planner 用的两个原语。**必须是注入而不是 import** ——
     * 模块之间不许互相 import（`server.js → 模块` 是唯一的依赖方向）。
     * 由 server.js 把 sessions 实例注入 planner，planner 只调这两个方法。 */
    resolveByUuid,
    resolveManyByUuid,
    switchToTarget,
    _internals: { sessionId, dirNameFor, summarize, normCwd, readFlags, writeFlags, isInsideProject, filesInRoot },
    /* 会话搜索（server/session-search.js）用的只读原语。
     *
     * 走**依赖注入**而不是 import —— 模块之间不许互相 import（`server.js → 模块`
     * 是唯一的依赖方向，`tests/modules.cjs` 有 DFS 找环守卫）。
     * 归属判定只有 ownedSessions 一处，搜索不许自己再实现一遍：
     * 两份判定迟早会漂，漂掉的那份就是跨项目读取的口子。 */
    forSearch: { ownedSessions, readCapped, normCwd, maxReadBytes: MAX_READ_BYTES },
    root: ROOT,
    extraRoots: EXTRA_ROOTS.slice(),
    agentDir: AGENT_DIR,
    dataDir: DATA,
  };
}
