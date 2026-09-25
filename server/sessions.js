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
import { json, readBody } from './http-utils.js';

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

export function createSessions({ runtime, rpc = null, env = process.env, homeDir = null, dataDir = null } = {}) {
  const HOME = homeDir || env.HOME || os.homedir();
  const AGENT_DIR = env.PI_CODING_AGENT_DIR || path.join(HOME, '.pi', 'agent');
  const ROOT = path.join(AGENT_DIR, 'sessions');

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

    let title = '';
    let messageCount = 0;
    let lastTs = header.timestamp || null;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.indexOf('"message"') === -1) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type !== 'message') continue;
      messageCount++;
      if (e.timestamp) lastTs = e.timestamp;
      /* 消息体是**嵌在 `message` 字段下**的：
       *   {"type":"message","id":…,"timestamp":…,"message":{"role":"user","content":…}}
       * 不是顶层的 role/content（第一版按顶层读，结果 14 条消息一条标题都抽不出来）。
       * 两种形状都认，免得 pi 换格式时又静默失效。 */
      const body = e.message && typeof e.message === 'object' ? e.message : e;
      // 标题取**第一条用户消息** —— 那是人一眼能认出「这是哪次对话」的东西
      if (!title && body.role === 'user') {
        title = textOf(body.content).replace(/\s+/g, ' ').slice(0, MAX_TITLE);
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
      createdAt: header.timestamp || null,
      lastMessageAt: lastTs,
      updatedAt: mtime,
      messageCount,
      title: title || '（还没有消息）',
      truncated: r.truncated,
      bytes: r.size,
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
   * 当前项目的会话列表。
   * @returns {{ok:boolean, hasProject:boolean, sessions:Array, currentId:string|null, diagnostics:Array}}
   *   **不回绝对路径**（见下面的说明）。
   */
  async function list() {
    const cwd = runtime.getCurrentCwd();
    const diagnostics = [];
    if (!cwd) return { ok: true, hasProject: false, sessions: [], currentId: null, diagnostics };

    const want = normCwd(cwd);
    const files = candidateFiles(cwd).slice(0, MAX_SESSIONS * 4);
    const sessions = [];
    let skipped = 0;
    for (const f of files) {
      const s = summarize(f);
      if (!s) {
        skipped++;
        continue;
      }
      // **归属判定只认 header.cwd**，不认目录名
      if (normCwd(s.cwd) !== want) continue;
      sessions.push(s);
    }
    if (skipped) diagnostics.push({ level: 'warn', message: `有 ${skipped} 个会话文件读不出来，已跳过` });

    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    /* 当前会话从 pi 那里问（get_state 给 sessionFile），而不是靠猜 ——
     * 「界面显示的是哪个会话」只有 pi 自己说了算。 */
    let currentFile = null;
    let curState = null;
    if (rpc && typeof rpc.request === 'function') {
      const st = await rpc.request({ type: 'get_state' });
      if (st && !st.__error && st.sessionFile) {
        currentFile = String(st.sessionFile);
        curState = st;
      }
    }
    const currentId = currentFile ? sessionId(currentFile) : null;

    /* ⚠️ pi 在会话还没有任何内容时**不落盘**。
     * 实测（`.probe/probe-sessions-new.cjs`）：`new_session` 之后 get_state 已经
     * 给出了新的 sessionFile，但那个文件在磁盘上还不存在，要等第一条消息才写。
     * 只按磁盘文件列的话，刚开的空会话不在列表里 ⇒ 界面上「当前项」仍然是旧会话，
     * 而当前项是不给点的（你已经在里面了）⇒ **用户再也回不到旧对话**，
     * 症状就是「开个新对话，旧对话就消失了」。
     * 所以把 pi 报的当前会话补进来，标成 pending（磁盘上还没有这个文件）。 */
    if (currentId && !sessions.some((s) => s.id === currentId)) {
      sessions.unshift({
        id: currentId,
        file: currentFile,
        sessionId: curState && curState.sessionId ? String(curState.sessionId) : '',
        cwd,
        createdAt: null,
        lastMessageAt: null,
        updatedAt: Date.now(),
        messageCount: curState && typeof curState.messageCount === 'number' ? curState.messageCount : 0,
        title: String((curState && curState.sessionName) || '').trim() || '新会话（还没有消息）',
        truncated: false,
        bytes: 0,
        pending: true,
      });
    }

    const archivedKeys = new Set(readFlags().archived);

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
        archived: !s.pending && archivedKeys.has(s.sessionId || s.id),
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
    const st = await rpc.request({ type: 'get_state' });
    if (!st || st.__error || !st.sessionFile) return null;
    return sessionId(String(st.sessionFile));
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

  async function switchTo(id) {
    const target = resolveId(id);
    if (!target) return { ok: false, code: 'not-found', error: '找不到这个会话（可能已被删除，或不属于当前项目）' };
    if (!rpc || typeof rpc.request !== 'function') return { ok: false, code: 'no-rpc', error: 'pi 未连接，无法切换会话' };
    const res = await rpc.request({ type: 'switch_session', sessionPath: target.file });
    if (!res) return { ok: false, code: 'no-answer', error: 'pi 没有应答（可能正在忙，或子进程未运行）' };
    if (res.__error) return { ok: false, code: 'failed', error: String(res.__error) };
    if (res.cancelled) return { ok: false, code: 'cancelled', error: '切换被扩展取消了' };
    return { ok: true, id, title: target.title };
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
        return json(res, 200, await list());
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
    _internals: { sessionId, dirNameFor, summarize, normCwd, readFlags, writeFlags },
    root: ROOT,
    agentDir: AGENT_DIR,
    dataDir: DATA,
  };
}
