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

export function createSessions({ runtime, rpc = null, env = process.env, homeDir = null } = {}) {
  const HOME = homeDir || env.HOME || os.homedir();
  const AGENT_DIR = env.PI_CODING_AGENT_DIR || path.join(HOME, '.pi', 'agent');
  const ROOT = path.join(AGENT_DIR, 'sessions');

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
    if (rpc && typeof rpc.request === 'function') {
      const st = await rpc.request({ type: 'get_state' });
      if (st && !st.__error && st.sessionFile) currentFile = String(st.sessionFile);
    }
    const currentId = currentFile ? sessionId(currentFile) : null;

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
      const raw = await readBody(req).catch((err) => ({ __tooBig: String(err.message || err) }));
      if (raw && raw.__tooBig) return json(res, 413, { ok: false, error: raw.__tooBig });
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      if (typeof body.id !== 'string' || !body.id || body.id.length > 64) {
        return json(res, 400, { ok: false, error: '缺少合法的会话 ID' });
      }
      const r = await switchTo(body.id);
      return json(res, r.ok ? 200 : 200, r);
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
      const r = await rename(body.name);
      return json(res, 200, r);
    }
    return json(res, 404, { ok: false, error: 'Not found' });
  }

  return { handle, list, switchTo, rename, _internals: { sessionId, dirNameFor, summarize, normCwd }, root: ROOT, agentDir: AGENT_DIR };
}
