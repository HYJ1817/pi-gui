/* Tool Timeline 的数据模型。
 *
 * ---------- 为什么要有这个文件 ----------
 *
 * 工具执行有**两条到达路径**：
 *   实时 —— pi 的 tool_execution_start / update / end 事件；
 *   历史 —— 刷新页面后 get_messages 返回的 assistant(toolCall) + toolResult 消息。
 * 两条路径的**原始形状完全不同**（一个是事件、一个是消息），但界面上必须长得一样。
 * 所以中间放一层：两条路径各自解析成同一个 ToolEntry，视图只认 ToolEntry。
 *
 * 这里**不允许出现 DOM**：它是纯数据 + 纯函数，视图在 tool-view.js。
 *
 * ---------- 字段来源（都是实测出来的，不是猜的） ----------
 *
 * pi 的实时事件（见 pi-coding-agent 的 ToolExecution*Event）：
 *   start  { type, toolCallId, toolName, args }
 *   update { type, toolCallId, toolName, args, partialResult }   ← partialResult 是**累积值**
 *   end    { type, toolCallId, toolName, result, isError }
 *
 * pi 的会话记录（~/.pi/agent/sessions/**\/*.jsonl，实测 11 个会话 125 次调用）：
 *   assistant.content[] 里的 { type:'toolCall', id, name, arguments }
 *   独立的一条 { role:'toolResult', toolCallId, toolName, content, details, isError, timestamp }
 *   配对键就是 toolCallId —— 实测 125 call / 124 result、**0 个孤儿**、1 个缺结果。
 *
 * `result` / `details` 的实际内容（读 pi 的 tools/*.d.ts 确认）：
 *   bash  details = { truncation?, fullOutputPath? }        ← **没有 exitCode**
 *   read  details = { truncation? }
 *   grep  details = { truncation?, matchLimitReached?, linesTruncated? }
 *   find  details = { truncation?, resultLimitReached? }
 *   edit  details = { diff, patch, firstChangedLine? }      ← 工具自己给的权威 diff
 *   write details = 无
 *
 * 两个由此而来的硬规则：
 *   1. **exit code 只能从输出文本里解析**（bash 失败时输出末尾是
 *      `Command exited with code 35`），协议里没有结构化字段。解析不到就不显示，
 *      绝不按 isError 猜一个数字。
 *   2. edit 的 +N −M 先用 details.diff 算（这是工具当场给的，不是从参数推算），
 *      等 Git 状态刷新回来再用 Git 的数字覆盖 —— Git 是最终权威（见 tools.js）。 */

import { toProjectRel } from './util.js';

/* ---------- 工具名映射 ---------- */

/* 展示用的语义名。pi 内置工具是 bash/read/write/edit/grep/find/ls，
 * 但项目早期按 `glob` 写，两边都认 —— 认错一个名字的代价是时间线上出现
 * 「执行工具 glob」这种半成品文案。 */
export const TOOL_META = {
  bash: { label: '执行命令', icon: 'terminal' },
  powershell: { label: '执行命令', icon: 'terminal' },
  read: { label: '读取文件', icon: 'file' },
  write: { label: '写入文件', icon: 'file' },
  edit: { label: '修改文件', icon: 'edit' },
  grep: { label: '搜索内容', icon: 'search' },
  glob: { label: '查找文件', icon: 'search' },
  find: { label: '查找文件', icon: 'search' },
  ls: { label: '列出目录', icon: 'file' },
};

/* 未知工具（mcp_xxx / 扩展注册的工具 / 以后新加的）**不报错**，
 * 降级成「执行工具 + 原始名字」。§4 明确要求，而且这是唯一合理的做法 ——
 * 前端不可能枚举完用户装的所有扩展工具。 */
export function labelFor(name) {
  const key = String(name ?? '');
  const m = TOOL_META[key];
  if (m) return { label: m.label, icon: m.icon, known: true };
  return { label: '执行工具', icon: 'tool', known: false };
}

/** 会改动磁盘、因而 +N −M 有意义的工具。与 changes.js 的账本口径保持一致。 */
export const MUTATING_TOOLS = new Set(['write', 'edit']);

const SEARCH_TOOLS = new Set(['grep', 'glob', 'find', 'ls']);

/* ---------- 参数摘要 ---------- */

/** 取第一个非空字符串值。参数键名在各工具间不一致（pi 用 path，早期代码写 file_path），
 *  所以两条都认。 */
function firstString(args, keys) {
  if (!args || typeof args !== 'object') return '';
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/** 单行化 + 截断。命令里常有换行，直接铺到时间线上会把一条撑成十行。 */
function oneLine(s, max = 160) {
  const t = String(s ?? '').replace(/\s*\r?\n\s*/g, ' ⏎ ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * 从参数里提炼「最有价值的一行」。§5 要求默认不展示完整 JSON arguments。
 *
 * @returns {{summary:string, path:string, command:string, query:string}}
 */
export function summarize(name, args) {
  const n = String(name ?? '');
  const out = { summary: '', path: '', command: '', query: '' };

  if (n === 'bash' || n === 'powershell') {
    out.command = firstString(args, ['command']);
    out.summary = oneLine(out.command);
    return out;
  }

  if (n === 'read' || n === 'write' || n === 'edit') {
    out.path = firstString(args, ['path', 'file_path']);
    out.summary = oneLine(out.path);
    return out;
  }

  if (n === 'grep') {
    out.query = firstString(args, ['pattern', 'query']);
    // §5 的例子把搜索词带引号，和「路径」区分开
    out.summary = out.query ? oneLine(`"${out.query}"`) : oneLine(firstString(args, ['path']));
    return out;
  }

  if (n === 'glob' || n === 'find') {
    out.query = firstString(args, ['pattern', 'query']);
    out.summary = oneLine(out.query || firstString(args, ['path']));
    return out;
  }

  if (n === 'ls') {
    out.path = firstString(args, ['path']);
    out.summary = oneLine(out.path || '.');
    return out;
  }

  /* 未知工具：把原始名字摆出来，比留空强 —— 用户至少知道调了什么。 */
  out.summary = oneLine(n);
  return out;
}

/* ---------- 结果解析 ---------- */

/** 把工具返回值里的文本取出来。
 *
 * pi 的约定是 `{ content: [{type:'text', text}] }`，但 partialResult 有时是
 * `{ content: [], details: undefined }`（bash 的 onUpdate），也会直接是字符串。 */
export function resultText(res) {
  if (res == null) return '';
  if (typeof res === 'string') return res;
  if (Array.isArray(res)) {
    return res
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }
  if (Array.isArray(res.content)) return resultText(res.content);
  if (typeof res.text === 'string') return res.text;
  return '';
}

const MAX_OUTPUT_CHARS = 200000;
function boundedOutput(value) {
  const text = String(value ?? '');
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  const notice = '…（输出过长，仅显示末尾）\n';
  return { text: notice + text.slice(-(MAX_OUTPUT_CHARS - notice.length)), truncated: true };
}

/* bash 失败时 pi 把退出码写在**输出文本**里（协议里没有结构化字段）。
 * 这是 pi 自己拼的固定句式，所以按它解析不算「猜」；解析不到就返回 null。 */
const EXIT_RE = /Command exited with code\s+(-?\d+)/;

export function parseExitCode(text) {
  const m = EXIT_RE.exec(String(text ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** pi 的截断信息。用于「大输出截断提示」—— pi 自己会截断，我们如实转述。 */
export function truncationOf(details) {
  const t = details && details.truncation;
  if (!t || !t.truncated) return null;
  return {
    by: t.truncatedBy || 'lines',
    totalLines: t.totalLines ?? null,
    totalBytes: t.totalBytes ?? null,
    outputLines: t.outputLines ?? null,
  };
}

/** 从 edit 的 details.diff 数出 +N −M。
 *
 * 用工具**当场给的** diff，而不是拿 old_string / new_string 自己推算 ——
 * 后者对多处替换、重叠匹配都会算错。注意这仍然只是「这一次 edit 的量」，
 * 一个文件被改两次就是两条各自的行数；整文件的权威数字由 Git 给（见 tools.js）。 */
export function diffStatOf(details) {
  const d = details && typeof details.diff === 'string' ? details.diff : '';
  if (!d) return null;
  let add = 0;
  let del = 0;
  for (const line of d.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) add++;
    else if (line.startsWith('-')) del++;
  }
  if (!add && !del) return null;
  return { add, del };
}

/** 写文件的结果文本里带着字节数：`Successfully wrote 13673 bytes to <path>`。 */
const WRITE_RE = /Successfully wrote\s+(\d+)\s+bytes/;
/** edit 的结果文本：`Successfully replaced 1 block(s) in <path>`。 */
const EDIT_RE = /Successfully replaced\s+(\d+)\s+block/;

function lastLine(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1].trim() : '';
}

function firstLine(text) {
  const lines = String(text ?? '').split('\n');
  for (const l of lines) if (l.trim()) return l.trim();
  return '';
}

const lineCount = (text) => String(text ?? '').split('\n').filter((l) => l.trim()).length;

/**
 * 时间线上那一行「关键结果」。§1 的例子：`318 tests passed` / `exit code 1`。
 *
 * 每种工具「什么叫有用」不一样，所以分开处理 —— 对 read 显示最后一行文件内容
 * 是纯噪音，对 bash 却正是用户要看的。
 */
export function resultLineOf(entry) {
  if (entry.status === 'running') return runningLine(entry);
  if (entry.status === 'incomplete') return '未完成 · 没有结果';

  if (entry.exitCode != null) {
    const base = `exit code ${entry.exitCode}`;
    return entry.truncated ? base + ' · 输出已截断' : base;
  }

  const text = String(entry.output ?? '').trim();

  if (entry.status === 'error') return firstLine(text) || '执行失败';
  if (!text) return '无输出';

  const n = String(entry.name ?? '');
  let line;

  if (n === 'bash' || n === 'powershell') line = lastLine(text);
  else if (n === 'write') {
    const m = WRITE_RE.exec(text);
    line = m ? `已写入 ${m[1]} 字节` : `已写入 · ${lineCount(text)} 行输出`;
  } else if (n === 'edit') {
    const m = EDIT_RE.exec(text);
    line = m ? `已替换 ${m[1]} 处` : firstLine(text);
  } else if (n === 'read') line = `${lineCount(text)} 行`;
  else if (SEARCH_TOOLS.has(n)) line = `${lineCount(text)} 条结果`;
  else line = lastLine(text) || firstLine(text);

  return entry.truncated ? `${line} · 输出已截断` : line;
}

/** 运行中的一行反馈：跟着输出的尾巴走。
 *
 * 没有它的话，一条跑了 30 秒的命令在时间线上是**静止**的 —— 用户看不出
 * 它到底在动还是卡住了。用最后一行而不是第一行：长命令的价值通常在后半段
 * （npm test 的汇总、build 的进度）。 */
function runningLine(entry) {
  const text = String(entry.output ?? '').trim();
  if (!text) return '';
  const line = lastLine(text);
  return line.length > 120 ? line.slice(0, 119) + '…' : line;
}

/* ---------- 时长 ---------- */

/** §7 的格式：0.1s / 1.8s / 12.4s / 1m 08s。 */
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/* ---------- 输出预览 ---------- */

/* 默认摘要行数（§6 给的区间是 3~8）。取 3：时间线要紧凑，
 * 真想看输出的人会点展开，而展开是免费的（数据早就在内存里）。 */
export const PREVIEW_LINES = 3;

/** 折叠状态下显示的输出预览。返回 {text, more} —— more 是「还有多少行没显示」。 */
export function previewOf(text, max = PREVIEW_LINES) {
  const all = String(text ?? '').split('\n');
  // 末尾的空行不算「内容」，否则预览会被一片空白占满
  while (all.length && !all[all.length - 1].trim()) all.pop();
  if (all.length <= max) return { text: all.join('\n'), more: 0 };
  return { text: all.slice(0, max).join('\n'), more: all.length - max };
}

/* ---------- 统一的 ToolEntry ---------- */

/** 一条新的（running）工具条目。实时事件的入口。 */
export function makeEntry(evt, now = Date.now()) {
  const name = String(evt?.toolName ?? '');
  const { label, icon, known } = labelFor(name);
  const args = evt?.args ?? null;
  const s = summarize(name, args);

  return {
    id: String(evt?.toolCallId ?? ''),
    name,
    label,
    icon,
    known,
    args,
    summary: s.summary,
    path: s.path,
    command: s.command,
    query: s.query,
    status: 'running',
    startedAt: now,
    endedAt: null,
    durationMs: null,
    output: '',
    outputTruncated: false,
    error: '',
    exitCode: null,
    resultLine: '',
    truncated: null,
    details: null,
    diffStat: null,
    /* Git 刷新回来之后的权威数字（仅 write / edit）。 */
    gitStat: null,
    fromHistory: false,
  };
}

/**
 * 流式更新。
 *
 * **partialResult 是累积值，直接替换**（pi 的约定，见文件头）——
 * 累加会把输出变成 N 份重复。空文本不覆盖已有内容：bash 的 onUpdate 会先发一次
 * `{content: [], details: undefined}`，用它把已显示的内容清掉是错的。
 */
export function applyUpdate(entry, evt, now = Date.now()) {
  const text = resultText(evt?.partialResult);
  if (text) {
    const bounded = boundedOutput(text);
    entry.output = bounded.text;
    entry.outputTruncated = bounded.truncated;
  }
  entry.updatedAt = now;
  entry.resultLine = resultLineOf(entry); // 运行中 → 跟着输出尾巴走
  return entry;
}

/** 结束。写权威结果、算时长、解析退出码与截断信息。 */
export function applyEnd(entry, evt, now = Date.now()) {
  entry.endedAt = now;
  entry.durationMs = Math.max(0, entry.endedAt - entry.startedAt);

  const res = evt?.result;
  const text = resultText(res);
  if (text) {
    const bounded = boundedOutput(text);
    entry.output = bounded.text;
    entry.outputTruncated = bounded.truncated;
  }

  entry.details = (res && typeof res === 'object' && res.details) || null;
  entry.status = evt?.isError ? 'error' : 'success';
  if (evt?.isError) entry.error = entry.output;
  entry.exitCode = parseExitCode(entry.output);
  entry.truncated = truncationOf(entry.details);
  entry.diffStat = diffStatOf(entry.details);
  entry.resultLine = resultLineOf(entry);
  return entry;
}

/**
 * 从历史消息造一条 entry。
 *
 * @param call          assistant.content 里的 toolCall 部分（可能为 null —— 孤儿 result）
 * @param result        对应的 toolResult 消息（可能为 null —— 未完成的调用）
 * @param assistantMsg  所属的 assistant 消息，只用它的 timestamp 估时长
 *
 * **时长的诚实说明**：协议里没有工具级的开始 / 结束时间戳。这里用
 * 「assistant 消息的时间戳 → toolResult 消息的时间戳」来估，它包含了模型消息
 * 落库到工具真正跑起来之间的那点开销，所以比实时测出来的值略大。
 * 同一个 assistant 消息里的多个 toolCall 会算出相近的时长（共享同一个起点）。
 */
export function entryFromHistory(call, result, assistantMsg) {
  const name = String(call?.name ?? result?.toolName ?? '');
  const { label, icon, known } = labelFor(name);
  const args = call?.arguments ?? null;
  const s = summarize(name, args);

  const rawText = resultText(result?.content ?? result);
  const bounded = boundedOutput(rawText);
  const text = bounded.text;
  const startedAt = Number.isFinite(assistantMsg?.timestamp) ? assistantMsg.timestamp : null;
  const endedAt = Number.isFinite(result?.timestamp) ? result.timestamp : null;

  const entry = {
    id: String(call?.id ?? result?.toolCallId ?? ''),
    name,
    label,
    icon,
    known,
    args,
    summary: s.summary,
    path: s.path,
    command: s.command,
    query: s.query,
    /* 没有 result = 这一轮没跑完（中断、崩溃、或者会话是在工具执行途中被切走的）。
     * §10 要求它**不能消失**，状态标成「未完成」。 */
    status: result ? (result.isError ? 'error' : 'success') : 'incomplete',
    startedAt,
    endedAt,
    durationMs: startedAt != null && endedAt != null && endedAt >= startedAt ? endedAt - startedAt : null,
    output: text,
    outputTruncated: bounded.truncated,
    error: result?.isError ? text : '',
    exitCode: parseExitCode(text),
    resultLine: '',
    truncated: truncationOf(result?.details),
    details: result?.details ?? null,
    diffStat: diffStatOf(result?.details),
    gitStat: null,
    fromHistory: true,
  };

  entry.resultLine = resultLineOf(entry);
  return entry;
}

/* ---------- 实时实例表 + Git 回填 ---------- */

/* 实时 entry 的登记表。
 *
 * 为什么要放在这里而不是 tools.js：+N −M 需要 Git 状态刷新完成后**回填**到
 * 已经渲染出来的条目上，而「刷新完成」这件事由 git.js 通知。如果登记表在
 * tools.js，git.js 就得反过来 import tools.js —— 而 tools.js 已经 import 了
 * git.js，会成环（本项目禁 re-export，链接器也扛不住）。
 * 放在这个不依赖任何业务模块的文件里，两边都只依赖它。 */
const live = new Map();

/** 登记一条实时 entry。返回 entry 本身，方便链式使用。 */
export function registerEntry(entry) {
  if (entry?.id) live.set(entry.id, entry);
  return entry;
}

export function liveEntries() {
  return [...live.values()];
}

/* 注意：**结束的条目不从表里摘掉**。
 * +N −M 要等 Git 状态刷新（防抖 450ms）回来才回填，提前摘掉那个数字就永远补不上。
 * 表本身随会话清空（clearLiveEntries），一次会话几百条，扫一遍的代价可以忽略。 */
export function hasRunning() {
  for (const e of live.values()) if (e.status === 'running') return true;
  return false;
}

export function clearLiveEntries() {
  live.clear();
}

/**
 * 把还在 running 的条目收成「未完成」。
 *
 * 什么时候会出现「还在 running」：agent 已经收尾（agent_settled）却没有收到
 * 对应的 tool_execution_end —— 用户中断、后端进程被杀、上游报错。实测里
 * 这些情况确实会发生（会话 jsonl 里就有 1 个只有 toolCall 没有 toolResult 的调用）。
 *
 * 不收尾的代价有两个，都不是小事：
 *   1. 界面上那条会永远显示「运行中」，看起来像卡死了；
 *   2. hasRunning() 恒为真 → 「Pi 正在处理…」指示器再也不出现，
 *      因为 syncToolWorking 认为「有工具在跑，指示器是多余的」。
 *
 * @returns {number} 被收尾的条目数
 */
export function settleRunning(now = Date.now()) {
  let n = 0;
  for (const e of live.values()) {
    if (e.status !== 'running') continue;
    e.status = 'incomplete';
    e.endedAt = now;
    e.durationMs = Math.max(0, now - e.startedAt);
    e.resultLine = resultLineOf(e);
    markDirty(e);
    n++;
  }
  return n;
}

/* entry 内容变了之后要重画 —— 由 tools.js 注册（视图在那边，模型不碰 DOM）。 */
let dirtyHandler = null;

export function setEntryDirtyHandler(fn) {
  dirtyHandler = typeof fn === 'function' ? fn : null;
}

function markDirty(entry) {
  if (dirtyHandler) dirtyHandler(entry);
}

/**
 * 用 Git 工作区状态回填 +N −M。
 *
 * §9：**Git 是最终权威，工具事件只是 Agent 行为记录**。所以：
 *   - 只回填 write / edit（别的工具不动磁盘，「变更」无从谈起）；
 *   - 用 Git 给的整文件行数覆盖 entry.diffStat（工具自己的那个只是单次 edit 的量）；
 *   - 找不到对应文件就什么都不做 —— 可能已经提交、或者被撤销了，那正是 Git 的答案。
 *
 * @param changes S.changes（含 files 与 projectRoot）
 */
export function applyGitStats(changes) {
  /* 注意**不能**在 files 为空时提前返回。
   * 「文件从变更列表里消失」（提交了 / 被撤销了 / 整个工作区都干净了）恰恰是
   * files 为空或变短的情况，提前返回会让之前回填的数字永远留在时间线上。 */
  if (!changes || !Array.isArray(changes.files)) return 0;
  if (!live.size) return 0;

  const byPath = new Map();
  for (const f of changes.files) byPath.set(f.path, f);

  let n = 0;
  for (const entry of live.values()) {
    if (!MUTATING_TOOLS.has(entry.name)) continue;
    if (!entry.path) continue;

    const rel = toProjectRel(entry.path, changes.projectRoot);
    const f = rel ? byPath.get(rel) : null;

    /* 文件已经不在 Git 的变更列表里了（提交了、或者被撤销了）——
     * 之前回填过的数字现在会骗人，退回工具自己那份单次统计。
     * 「以 Git 为准」这条规则在**消失**的方向上同样要成立。 */
    if (!f || f.binary || (f.additions == null && f.deletions == null)) {
      if (entry.gitStat) {
        entry.gitStat = null;
        markDirty(entry);
      }
      continue;
    }

    const add = f.additions ?? 0;
    const del = f.deletions ?? 0;
    if (entry.gitStat && entry.gitStat.add === add && entry.gitStat.del === del) continue;

    entry.gitStat = { add, del };
    markDirty(entry);
    n++;
  }
  return n;
}

/** 时间线上该显示哪一组行数：Git 优先，退回工具自己的 diff 统计。 */
export function statOf(entry) {
  return entry.gitStat || entry.diffStat || null;
}
