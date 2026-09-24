/* Tool Timeline —— 实时侧。
 *
 * pi 的事件：tool_execution_start → (update)* → end。
 *
 * 本文件只负责「事件 → 模型 → 视图」这条链上的调度，三件事都别塞进来：
 *   数据模型  → tool-model.js（纯数据，无 DOM）
 *   渲染      → tool-view.js（只认 ToolEntry）
 *   历史重建  → tool-history.js + messages.js
 *
 * ---------- 三条踩过的坑 ----------
 *
 * 1. **partialResult 是累积值不是增量**，直接整体替换（见 tool-model.applyUpdate）。
 *    累加会把输出变成 N 份重复。
 *
 * 2. **tool_execution_end 不保证带 toolName / args**（实测 end 只有
 *    toolCallId / result / isError）。所以工具名和参数在 start 时就存进 entry，
 *    结束时只按 id 取回来 —— 不能指望 end 事件把它们再送一遍。
 *
 * 3. **别在结束时就把它从实时表里摘掉**。+N −M 要等 Git 状态刷新回来才回填
 *    （§9：Git 是最终权威），而刷新是防抖 450ms 之后的事。提前摘掉，
 *    那个数字永远补不上。
 *
 * ---------- 分组的边界 ----------
 *
 * 一组 = 一条 assistant 消息里的全部 toolCall（§12 要求依据真实边界，
 * 不许用「超过几秒算一组」这种猜测）。实际事件顺序是
 * message_start → … → message_end → tool_execution_start…，
 * 所以「新的 assistant 消息开始」正好是上一组结束的位置。
 * 用户消息进来同样关组。 */

import { S } from './state.js';
import { ensureThread, moveWorkingToEnd, scrollBottom, syncToolWorking } from './messages.js';
import { recordToolChange } from './changes.js';
import { scheduleGitRefresh, setGitStatusHook } from './git.js';
import {
  applyEnd,
  applyGitStats,
  applyUpdate,
  clearLiveEntries,
  hasRunning,
  makeEntry,
  registerEntry,
  setEntryDirtyHandler,
} from './tool-model.js';
import { addToGroup, createGroup, renderEntry, updateEntry } from './tool-view.js';

/* 会改动磁盘、因而值得重读 Git 状态的工具。
 *
 * write / edit 是明确的。bash 单列进来的理由：它改文件的方式太多
 * （`> file`、`sed -i`、`mv`、`rm`、装依赖…），靠解析命令去猜「这次到底改没改」
 * 既不可靠也不值得；而刷新本身是**只读 + 防抖**的，多刷一次的代价远小于
 * 「Agent 明明改了文件，Changes 里却没有」。 */
const REFRESH_TOOLS = new Set(['write', 'edit', 'bash']);

/* 流式输出的批量窗口。§17 给的区间是 100~250ms：再短会让长时间命令
 * （npm test 能吐几千行）把主线程堵在 layout 上，再长会让输出看起来卡顿。 */
const PAINT_MS = 150;

/* 运行中条目的时长刷新间隔。§7：小于 1 秒不必每 10ms 更新，
 * 250~500ms 一次就够 —— 反正显示精度只到 0.1s。 */
const TICK_MS = 300;

/* ---------- 批量重画 ---------- */

const pending = new Set();
let paintTimer = null;

function schedulePaint(rec) {
  pending.add(rec);
  if (paintTimer) return;
  paintTimer = setTimeout(flushPaint, PAINT_MS);
}

function flushPaint() {
  paintTimer = null;
  for (const rec of pending) {
    /* 线程被清空（换会话 / 换项目）之后 pending 里可能还留着旧条目，
     * 往已经卸掉的节点上写不会报错但也没意义，所以先确认它还活着。 */
    if (S.tools.get(rec.entry.id) !== rec) continue;
    updateEntry(rec.node, rec.entry);
  }
  pending.clear();
  scrollBottom();
}

/* ---------- 运行时长 ---------- */

let ticker = null;

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    let anyRunning = false;
    for (const rec of S.tools.values()) {
      if (rec?.entry?.status !== 'running') continue;
      anyRunning = true;
      rec.entry.durationMs = Date.now() - rec.entry.startedAt;
      updateEntry(rec.node, rec.entry);
    }
    if (!anyRunning) stopTicker();
  }, TICK_MS);
}

function stopTicker() {
  if (!ticker) return;
  clearInterval(ticker);
  ticker = null;
}

/** 清空时间线的实时状态。换会话 / 换项目时由 clearThread 调用。 */
export function resetTimeline() {
  stopTicker();
  pending.clear();
  if (paintTimer) {
    clearTimeout(paintTimer);
    paintTimer = null;
  }
  clearLiveEntries();
  S.tlGroup = null;
}

/* ---------- 事件 ---------- */

export function onToolStart(evt) {
  const entry = registerEntry(makeEntry(evt));
  const node = renderEntry(entry);

  const t = ensureThread();
  /* 上一条 assistant 消息已经结束（message_end 早于 tool_execution_start），
   * 所以这里没组就说明这是一批新的工具调用。 */
  if (!S.tlGroup) {
    S.tlGroup = createGroup();
    t.appendChild(S.tlGroup);
  }
  addToGroup(S.tlGroup, node);

  S.tools.set(entry.id, { entry, node });

  startTicker();
  syncToolWorking();
  moveWorkingToEnd();
  scrollBottom(true);
}

export function onToolUpdate(evt) {
  const rec = S.tools.get(evt.toolCallId);
  if (!rec) return;
  applyUpdate(rec.entry, evt);
  schedulePaint(rec);
  startTicker();
}

export function onToolEnd(evt) {
  const rec = S.tools.get(evt.toolCallId);
  if (!rec) return;

  applyEnd(rec.entry, evt);
  updateEntry(rec.node, rec.entry);

  // 记一笔「改动了哪些文件」。只在成功时记 —— 失败的工具没真正改到磁盘，
  // 记进去会让变更列表出现幽灵条目。
  if (!evt.isError) {
    recordToolChange(rec.entry.name, rec.entry.args);
    /* 顺带安排一次 Git 状态刷新（防抖 450ms）。一次 Agent 回合里连改 5 个文件
     * 只会产生 1 次 git status —— 见 git.js 的 scheduleGitRefresh。
     * 刷新完成后 applyGitStats 会把 +N −M 回填到这条 entry 上。 */
    if (REFRESH_TOOLS.has(rec.entry.name)) scheduleGitRefresh();
  }

  if (!hasRunning()) stopTicker();
  syncToolWorking();
  moveWorkingToEnd();
  scrollBottom();
}

/* ---------- 接线 ---------- */

/* entry 被外部改动（目前只有 Git 回填 +N −M）后重画那一条。
 * 注册在这里而不是 tool-model.js：模型层不碰 DOM。 */
setEntryDirtyHandler((entry) => {
  const rec = S.tools.get(entry.id);
  if (rec) updateEntry(rec.node, entry);
});

/* Git 状态刷新完成 → 给 write / edit 补上权威的 +N −M。 */
setGitStatusHook(applyGitStats);
