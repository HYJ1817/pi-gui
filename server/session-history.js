/* 只读地读出一条 Pi 原生会话文件里的对话正文 —— **不起 Pi、不占 Runtime slot**。
 *
 * ---------- 它解决什么 ----------
 *
 * P32.4 要求：列出 dormant 会话不算错，但「用户只是想看旧对话」不该消耗一个
 * Runtime（默认只有 2 个名额）。经典路径做不到这件事 —— 它是 `switch_session`
 * 之后由 Pi 把历史推回来，那要占那唯一的经典执行线。
 *
 * ---------- 为什么不吃 sessions.forSearch ----------
 *
 * `sessions.js` 的归属判定是「这个会话的 header.cwd 在**当前经典项目**里」。
 * 而并行会话的会话文件落在**各自 worktree 的 cwd** 下 —— 它压根不在经典项目的
 * 归属范围内，用那条路只会得到 null。这里读的是 registry 记录里**后端持有、
 * 绑定时已证明过**的 sessionLocator，不需要、也不接受 Renderer 传路径。
 *
 * ---------- 形状判定只有一处 ----------
 *
 * 「消息体嵌在 `message` 下还是顶层」这件事只在 pi-compat 里判一次
 * （`sessionMessageBody`），本模块不重判 —— 两处各判一遍迟早会漂。
 *
 * ---------- 有意不做的 ----------
 *
 * 只取 user / assistant 的 text 片段。toolResult 的大块输出、图片 base64、附件、
 * thinking、toolCall 参数一概不进 —— 与 `session-search.js` 同一条取舍：
 * 这些要么噪声大、要么根本不是「面向用户显示的正文」。因此**只读历史里看不到
 * 工具调用**，这是已知限制，不是 bug（活动中的会话由 runtime store 另外记工具）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { sessionMessageBody } from './pi-compat.js';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_MESSAGES = 800;
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;

/** Same-fd bounded read. Expected fields are backend proof, never renderer paths. */
export function readSessionText(file, { expected = null, maxBytes = DEFAULT_MAX_BYTES, tail = false } = {}) {
  if (typeof file !== 'string' || !file) return { ok: false, code: 'invalid_target' };
  let fd;
  try {
    const real = fs.realpathSync(file);
    if (expected && key(real) !== key(file)) throw Error();
    fd = fs.openSync(real, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (expected?.sessionIdentity && !sameFile(stat, expected.sessionIdentity))) throw Error();
    const validateHeader = () => {
      if (!expected) return;
      const headerBytes = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 64 * 1024));
      const n = fs.readSync(fd, headerBytes, 0, headerBytes.length, 0);
      const first = headerBytes.subarray(0, n).toString('utf8').split('\n')[0];
      const header = JSON.parse(first);
      if (header.type !== 'session' || !expected.sessionId || header.id !== expected.sessionId
        || typeof header.cwd !== 'string' || typeof expected.cwd !== 'string' || key(header.cwd) !== key(expected.cwd)) throw Error();
    };
    validateHeader();
    const size = Math.min(stat.size, maxBytes), offset = tail ? Math.max(0, stat.size - size) : 0;
    const buffer = Buffer.alloc(size), n = fs.readSync(fd, buffer, 0, size, offset);
    // An in-place rewrite keeps the inode. Prove native header ownership again
    // after the body read; ordinary Pi appends preserve this header.
    validateHeader();
    if (!sameFile(stat, fs.fstatSync(fd)) || !sameFile(stat, fs.statSync(real)) || key(fs.realpathSync(file)) !== key(real)) throw Error();
    return { ok: true, text: buffer.subarray(0, n).toString('utf8'), size: stat.size, truncated: stat.size > maxBytes };
  } catch { return { ok: false, code: 'history_unavailable' }; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function parts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const c of content) if (c && c.type === 'text' && typeof c.text === 'string' && c.text) out.push(c.text);
  return out.join('\n');
}

/** 读取一条会话文件的对话正文。失败一律返回 { ok:false, code }，不抛。 */
export function readSessionMessages(file, { maxBytes = DEFAULT_MAX_BYTES, maxMessages = DEFAULT_MAX_MESSAGES, expected = null } = {}) {
  const read = readSessionText(file, { maxBytes, expected, tail: true });
  if (!read.ok) return read;
  const text = read.text, truncatedBySize = read.truncated;
  const lines = text.split('\n');
  /* 第 0 行是 header（`{type:'session'}`），一律跳过；按字节预算从尾部截断时，
   * 被切掉的那一行本来就是半行，同样被这一跳丢掉 —— 两种情况下 start 都是 1。 */
  const start = 1;
  const messages = [];
  for (let i = start; i < lines.length && messages.length < maxMessages; i++) {
    const line = lines[i];
    if (!line || line.indexOf('"message"') === -1) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.type !== 'message') continue;
    const body = sessionMessageBody(entry);
    if (!body || !['user', 'assistant'].includes(body.role)) continue;
    const value = parts(body.content);
    if (!value) continue;
    messages.push({ role: body.role, text: value, timestamp: entry.timestamp || null });
  }
  return { ok: true, messages, truncated: truncatedBySize || messages.length >= maxMessages };
}
