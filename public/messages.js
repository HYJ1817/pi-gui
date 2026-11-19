import { createIcon, iconMarkup } from './ui/icons.js';
/* 对话渲染。
 *
 * 这里处理 pi 事件流里最麻烦的两条约定（见 pi docs/rpc.md）：
 *   - message_update 只给 delta，没有累积快照 → 按 contentIndex 自行组装，
 *     并以 message_end.message 为最终权威校正
 *   - tool_execution_update.partialResult 是累积值 → 直接替换（在 tools.js）
 *
 * 另外有一条硬规则：**助手消息绝不允许静默空白**。
 * 上游报错时 pi 返回的是 {content:[], stopReason:'error', errorMessage:'402: …'}，
 * 早期实现遇到空 content 就直接 return，用户看到的是一个空白的「Pi」，
 * 完全不知道发生了什么。现在失败、中断、真没内容三种情况都有对应呈现。
 *
 * 空白还有第二个来源：**只有工具调用**的助手消息（content 全是 toolCall，
 * 没有 text / thinking）。这类消息渲染不出任何正文，外壳留着就是一条孤零零的
 * 「Pi」—— 实测 11 个真实会话里有 20 条。所以整条外壳（含角色行）直接收掉，
 * 由 rebuildAssistant 的返回值告诉调用方「这次有没有值得占位的正文」。
 *
 * 收掉外壳**不等于那次工具调用消失了** —— 它由 Tool Timeline 呈现
 * （实时见 tools.js，历史见下面的 rebuildFromMessages + tool-history.js）。
 * 两者渲染的是同一个 ToolEntry 结构，所以刷新前后语义一致。 */

import { el, S } from './state.js';
import { resetThroughput } from './turn-throughput.js';
import { registerConversationAnchor, rebuildConversationNav, clearConversationNav } from './conversation-nav.js';
import { workspaceView } from './ui/workspace-surface.js';
import { icon, iconFor } from './util.js';
import { md } from './markdown.js';
import { sendCommand } from './api.js';
import { requestSessionStats } from './session-stats.js';
import { updateSendState } from './composer.js';
import { FILE_BLOCK_RE } from './attachments.js';
import { clearLiveEntries, hasRunning, settleRunning } from './tool-model.js';
import { startThinkingDotsCycle, stopThinkingDotsCycle, thinkingDots } from './thinking-dots.js';
import { planHistory } from './tool-history.js';
import { addToGroup, createGroup, groupCount, renderEntry, setEntryExpanded, setGroupExpanded } from './tool-view.js';
import { collectPlanTurns, isPlanTool } from './plan-model.js';
import { renderPlan } from './plan-view.js';
import { clearPlanLive, markLivePlanStalled, resetPlanLiveForUserTurn, settlePlanTaskBoundary } from './plan-live.js';
import { renderMessageMeta } from './message-meta.js';
import { messageActions } from './ui/message-actions.js';
import { openMessageEditor, closeMessageEditor, messageEditErrorText, messageEditRequestId, messageEditorBusy, resolveEditAcceptance, rememberPendingMessageEdit, clearPendingMessageEdit, readPendingMessageEdit, isEditInProgress } from './ui/message-edit.js';
import { confirmModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import { messageEditPreflight, messageEditResend, messageEditStatus, messageEditRecover } from './api.js';
import { deriveTurnOutcome, renderTurnOutcome } from './turn-outcome.js';
import {
  saveSessionBookmark,
  restoreSessionBookmark,
  clearSessionBookmark,
  preserveScrollAround,
} from './reading-position.js';

/* 消息序号由历史重建和实时追加共用，clearThread 开启新序列。 */
let userSeq = 0;
/* Pi active path 里的用户消息序号（从 0 开始），与只用于 DOM 锚点的 userSeq
 * 分开：编辑事务要的是稳定的历史序号，不是页面上的第几个节点。 */
let userIndexSeq = 0;
/* 一次编辑在提交时捕获的旧尾部节点。只删除这些引用，绝不按“目标之后的
 * 全部节点”删除 —— 新 run 的 assistant/工具节点可能在 HTTP 应答前就挂上来。 */
let pendingEdit = null;
/* 点击“编辑/重新生成”时，文章节点对应的**原始用户文本**。事务目标由首次
 * preflight 锁定；这份文本只用于核对 preflight 的 userIndex 没有指到别的
 * 消息上，不参与定位。 */
const userTextByArticle = new WeakMap();
let assistantSeq = 0;
let outcomeSeq = 0;
let toolGroupCallId = null;
const toolGroupCounts = new Map();
let threadSessionId = null;
let threadGeneration = 0;
let streamScrollBound = false;
let streamScrollRaf = null;

/* P4-D：长历史（800 条消息起）分块构建并挂载。
 *
 * 实测 829 / 1653 条消息的会话把整棵 DOM 一次性 append 时，节点构建加
 * 布局/样式重算会形成 200–450ms 的长任务。这里按顶层节点数分批：每批渲染
 * 约 160 个节点就挂载并让出主线程，批大小逐次翻倍到 1024 封顶。这样首屏
 * 只需很小一段同步工作，后续批次在独立任务里完成；总批次数保持个位数，
 * 避免为每批反复付出整棵线程的布局成本。
 *
 * 阈值按消息数而不是节点数，避免把 770 条消息的既有定向测试从同步改成异步；
 * 800 条是 P4-D 的验收下限（夹具 809 条）。 */
const HISTORY_CHUNK_MESSAGES = 800;
const HISTORY_CHUNK_NODES = 160;
const HISTORY_CHUNK_MAX_NODES = 1024;

/* 当前正在分块挂载的历史。generation 用于让 clearThread / 新重建取消旧任务；
 * promise 供测试与需要完整 DOM 的调用方等待。 */
let classicMount = null;

/** 分块挂载期间滚动事件由本模块自己驱动，不能把半截历史写成阅读书签。 */
function mountingClassicHistory() {
  return Boolean(classicMount && classicMount.generation === threadGeneration);
}
/* 分块挂载让出主线程的窗口里如果来了实时消息，实时节点会 append 在尚未挂完的
 * 历史中间，锚点序号也会被提前占用。任何实时写入之前先把剩余历史同步补完：
 * 一次长任务换正确的顺序与锚点，正常浏览仍走分块。
 *
 * tools.js / plan-live.js 的实时写入也走这里 —— 计划卡不走 ensureThread，
 * 只靠 ensureThread 兜不住。 */
export function finishClassicHistoryBeforeLive() {
  if (mountingClassicHistory() && typeof classicMount.flush === 'function') classicMount.flush();
}

function yieldToMainThread() {
  if (typeof globalThis.scheduler?.yield === 'function') return globalThis.scheduler.yield();
  return new Promise(resolve => setTimeout(resolve, 0));
}

export function classicThreadSessionId() {
  return threadSessionId;
}

/** 等当前长历史挂载完成（没有挂载时立即完成）。 */
export function waitForClassicRenderIdle() {
  return classicMount ? classicMount.promise : Promise.resolve();
}

export function saveClassicReadingPosition(sessionId) {
  if (mountingClassicHistory()) return;
  if (!sessionId || sessionId !== threadSessionId || !S.thread?.childElementCount || !el.stream?.clientHeight) return;
  saveSessionBookmark(sessionId, el.stream, S.thread);
}

function onStreamScroll() {
  if (streamScrollRaf) return;
  const sessionId = threadSessionId;
  streamScrollRaf = requestAnimationFrame(() => {
    streamScrollRaf = null;
    saveClassicReadingPosition(sessionId);
  });
}

export function bindStreamReadingPosition() {
  if (streamScrollBound || !el.stream) return;
  streamScrollBound = true;
  el.stream.addEventListener('scroll', onStreamScroll, { passive: true });
}

/* 当前 session 级 run 的证据。只在 app.js 收到真实 agent_start（上一轮已 settled）
 * 时开启；steer / follow-up / 自动重试不会开启新轮次。 */
let liveTurn = null;
let retryNotice = null;

/* ---------- 线程与滚动 ---------- */

/* 空会话显示欢迎块，有内容就收起来。
 *
 * 早先是在 ensureThread() 里把 #welcome 直接 remove() 掉 —— 新会话一建出
 * 空线程，欢迎块就永久消失，对话区变成一片纯黑，用户看不到任何引导。
 * 现在改成显隐切换（见 syncWelcome），元素始终留在 DOM 里。 */
export function ensureThread() {
  /* 实时路径的统一入口：拿到线程时历史必须已经挂完，否则后续 append
   * 会落在半截历史中间。历史重建自己在 clearThread 之后调用，这里不会命中。 */
  finishClassicHistoryBeforeLive();
  if (S.thread) return S.thread;
  const t = document.createElement('div');
  t.className = 'thread';
  el.stream.appendChild(t);
  S.thread = t;
  bindStreamReadingPosition();
  return t;
}

/** 欢迎块跟着「对话区有没有内容」自动显隐。
 *
 * 用 MutationObserver 而不是在每条渲染分支里手动调：消息的渲染路径有
 * 实时流式、历史重建、工具卡片插入等好几条，逐条插调用必然漏掉某条。
 * 这里只读一次 childElementCount，开销可忽略。 */
export function syncWelcome() {
  const w = document.getElementById('welcome');
  if (!w) return;
  const hide = Boolean(S.thread && S.thread.childElementCount);
  if (w.hidden !== hide) w.hidden = hide;
}

export function clearThread() {
  resetThroughput();
  ++threadGeneration;
  try { closeMessageEditor({ restore: false }); } catch { /* editor may already be detached */ }
  if (streamScrollRaf !== null) cancelAnimationFrame(streamScrollRaf);
  streamScrollRaf = null;
  threadSessionId = null;
  userSeq = 0;
  userIndexSeq = 0;
  pendingEdit = null;
  assistantSeq = 0;
  outcomeSeq = 0;
  toolGroupCallId = null;
  toolGroupCounts.clear();
  if (S.thread) {
    S.thread.innerHTML = '';
    /* 取消中的分块挂载不会再走到 finishHistoryRender；busy 状态必须在这里收掉。 */
    S.thread.removeAttribute('aria-busy');
  }
  clearPlanLive();
  clearRetryNotice();
  liveTurn = null;
  S.current = null;
  S.blocks.clear();
  S.tools.clear();
  /* 时间线的实时状态也要清 —— 留着的话，换会话之后 applyGitStats 还会去扫
   * 一批已经不在 DOM 里的旧条目。ticker 会自己停（S.tools 空了就没有 running）。 */
  clearLiveEntries();
  S.tlGroup = null;
  hideWorking();
  /* 对话区清空了，导航也跟着清 —— 否则换会话/切项目时会短暂留着上一个
   * 会话的标记（§13 明确不许）。 */
  clearConversationNav();
}

/* 只记用户明确操作，按已渲染会话隔离。单个会话和总会话数都设有上限。 */
const toolExpansion = new Map();
function expansionChoice(sessionId, key, expanded) {
  if (!sessionId) return;
  const saved = toolExpansion.get(sessionId);
  if (!saved && expanded === undefined) return;
  const choices = saved || new Map();
  toolExpansion.delete(sessionId);
  toolExpansion.set(sessionId, choices);
  if (expanded === undefined) return choices.get(key);
  choices.delete(key);
  choices.set(key, expanded);
  if (choices.size > 500) choices.delete(choices.keys().next().value);
  if (toolExpansion.size > 100) toolExpansion.delete(toolExpansion.keys().next().value);
}

export function clearClassicSessionView(sessionId) {
  clearSessionBookmark(sessionId);
  toolExpansion.delete(sessionId);
}

export function createClassicToolGroup(firstCallId) {
  const sessionId = threadSessionId;
  const callId = toolGroupCallId || firstCallId || '';
  const occurrence = (toolGroupCounts.get(callId) || 0) + 1;
  toolGroupCounts.set(callId, occurrence);
  const anchorId = 'tools-' + encodeURIComponent(callId) + (occurrence === 1 ? '' : ':' + occurrence);
  const group = createGroup(expanded => expansionChoice(sessionId, anchorId, expanded));
  group.dataset.anchorId = anchorId;
  return group;
}

export function addClassicToolEntry(group, entry, sessionId = threadSessionId) {
  const key = 'entry-' + group.dataset.anchorId + ':' + encodeURIComponent(entry.id);
  const node = renderEntry(entry, expanded => expansionChoice(sessionId, key, expanded));
  if (expansionChoice(sessionId, key) === true) setEntryExpanded(node, true);
  addToGroup(group, node);
  const groupChoice = expansionChoice(sessionId, group.dataset.anchorId);
  if (groupCount(group) >= 2 && groupChoice !== undefined) setGroupExpanded(group, groupChoice);
  return node;
}

export function scrollBottom(force) {
  const s = el.stream;
  const nearBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 160;
  if (force || nearBottom) {
    const generation = threadGeneration;
    requestAnimationFrame(() => {
      if (generation === threadGeneration) s.scrollTop = s.scrollHeight;
    });
  }
}

/* ---------- 轮次证据（只认真实事件） ---------- */

/** 真正的 session 级 run 开始。由 app.js 在 agent_start 且上一轮已 settled 时调用。 */
export function beginTurn() {
  liveTurn = {
    startedAt: Date.now(),
    seq: 0,
    toolIds: new Set(),
    toolSeqs: new Map(),
    lastAssistant: null,
    /* 本轮由哪条用户消息触发：重新生成要回到这条消息重跑，而不是 steer
     * 中途追加的那条。agent_start 早于用户的 message_start，所以这里留空，
     * 由本轮第一条用户消息（或编辑事务的目标）填上。 */
    userIndex: null,
    lastAssistantNode: null,
    finalized: false,
  };
}

/** 工具行进入本轮统计；gui_plan 等不进入工具时间线的调用不会走到这里。 */
export function noteTurnTool(id) {
  if (!liveTurn || liveTurn.finalized || id == null) return;
  const key = String(id);
  liveTurn.toolIds.add(key);
  liveTurn.toolSeqs.set(key, ++liveTurn.seq);
}

/** 中断工具是否发生在最后一次成功内容之后；没有最终内容时仅最后一个工具算终态。 */
function interruptedToolTerminal(tools, lastAssistant, toolSeqs = null) {
  const interrupted = tools.filter(entry => entry?.status === 'interrupted');
  if (!interrupted.length) return false;
  if (!lastAssistant) {
    return tools.length > 0 && tools[tools.length - 1]?.status === 'interrupted';
  }
  /* 实时事件用单调序号判先后：只有最后一次 message_end 之后、且后面没有
   * 其它工具的中断，才是轮次终态；后续工具成功说明已经恢复。 */
  if (Number.isInteger(lastAssistant.seq) && toolSeqs instanceof Map) {
    const seqs = tools
      .map(entry => toolSeqs.get(String(entry.id)))
      .filter(Number.isInteger);
    const latestToolSeq = seqs.length ? Math.max(...seqs) : -Infinity;
    return interrupted.some(entry => {
      const seq = toolSeqs.get(String(entry.id));
      return Number.isInteger(seq) && seq > lastAssistant.seq && seq === latestToolSeq;
    });
  }
  const lastAt = lastAssistant.at;
  if (!Number.isFinite(lastAt)) return false;
  const lastTool = tools[tools.length - 1];
  if (!lastTool || lastTool.status !== 'interrupted') return false;
  return !Number.isFinite(lastTool.endedAt) || lastTool.endedAt > lastAt;
}

/** agent_settled 后的轮次终态。没有真实证据（assistant / 工具）就不画。 */
function finalizeTurn() {
  finishClassicHistoryBeforeLive();
  const turn = liveTurn;
  if (!turn || turn.finalized) return;
  turn.finalized = true;
  const tools = [...turn.toolIds]
    .map(id => S.tools.get(id)?.entry)
    .filter(Boolean);
  const outcome = deriveTurnOutcome({
    tools,
    lastAssistant: turn.lastAssistant,
    interruptedToolTerminal: interruptedToolTerminal(tools, turn.lastAssistant, turn.toolSeqs),
    startedAt: turn.startedAt,
    endedAt: Date.now(),
  });
  const t = ensureThread();
  /* 轮次结束后才挂“重新生成”：运行中的回复不应允许把当前 turn 替换掉。 */
  attachClassicRegenerate(turn.lastAssistantNode, turn.userIndex);
  if (!outcome) { scrollBottom(); return; }
  const outcomeNode = renderTurnOutcome(outcome);
  if (outcomeNode) outcomeNode.dataset.anchorId = 'outcome-' + (++outcomeSeq);
  t.appendChild(outcomeNode);
  scrollBottom();
}

/* ---------- 「正在处理」指示 ---------- */

export function showWorking() {
  finishClassicHistoryBeforeLive();
  hideWorking();
  const t = ensureThread();
  const w = document.createElement('div');
  w.className = 'working';
  const label = document.createElement('span');
  label.className = 'working-label';
  label.textContent = 'Pi 正在处理…';
  /* 录屏从三点轨道的尾段开始，这里也一样：先露三点，之后自己交替到方阵。 */
  const dots = thinkingDots('', 'triangle');
  w.append(dots, label);
  t.appendChild(w);
  S.working = w;
  startThinkingDotsCycle(dots, { immediate: true });
  syncToolWorking();
}

export function hideWorking() {
  if (S.working) {
    const dots = S.working.querySelector('.thinking-dots');
    if (dots) stopThinkingDotsCycle(dots);
    S.working.remove();
    S.working = null;
  }
}

export function moveWorkingToEnd() {
  if (S.working && S.thread) S.thread.appendChild(S.working);
}

/* 有工具在跑时收起「Pi 正在处理…」的**文案**（§14）。
 *
 * 时间线上的 running 条目本身已经把「正在工作」说清楚了，再挂一句
 * 「Pi 正在处理…」就是同一句话说两遍；更糟的是它会夹在工具条目之间反复出现，
 * 看起来像状态在横跳。
 *
 * 但等待指示器不能整个消失：调用工具本来就是 Agent 执行的一部分，动画应该
 * 一直保持。所以这里只给 working 行加 `is-tool-active`，由 CSS 隐藏文案。
 * 形态由 thinking-dots.js 按录屏节奏自己交替，工具起停不打断它 —— 录屏里
 * 同一个「Checking pull request」既出现过三点也出现过方阵。
 *
 * 不碰 streaming 状态机 —— setStreaming / showWorking / hideWorking 的时序
 * 一行没改。用 class 而不是 remove：working 元素会被 moveWorkingToEnd 反复
 * 搬位置，删掉它就得在每条路径上判断「要不要重建」，反而更容易漏。 */
export function syncToolWorking() {
  if (!S.working) return;
  S.working.classList.toggle('is-tool-active', hasRunning());
}

export function setStreaming(on) {
  const changed = S.streaming !== on;
  S.streaming = on;
  if (changed) document.dispatchEvent(new window.Event('pi-gui:classic-activity'));
  el.btnStop.hidden = !on;
  /* 新的一轮开始了：上一轮那次「用户停止」的归属到此结束。
   * 之后 provider 再报 cancelled / aborted，就不是用户停的，照常当错误显示。 */
  if (on) S.stopOwnedTurn = false;
  if (on) showWorking();
  else hideWorking();
  updateSendState();
}

export function onSettled() {
  interruptActive();
  clearPendingClassicEdit();
  finalizeTurn();
  requestSessionStats();
  sendCommand({ type: 'get_state' });
  sendCommand({ type: 'get_tree' });
  if (workspaceView() === 'chat') el.input.focus();
}

export function interruptActive() {
  clearPendingClassicEdit();
  setStreaming(false);
  clearRetryNotice();
  /* 本次 run 已收尾：未消费的新任务边界到此失效，不能留给下一轮 steer。 */
  settlePlanTaskBoundary();
  /* 计划数据不被改写；只是不再把残留的 in_progress 显示成「还在跑」。 */
  markLivePlanStalled();
  for (const block of S.blocks.values()) {
    if (block.kind === 'think' && block.node) setThinkingState(block.node, 'interrupted');
  }
  S.current = null;
  S.blocks.clear();
  /* agent 已经收尾了，还有条目停在 running —— 说明那次工具执行没有等到
   * tool_execution_end（用户中断 / 进程被杀 / 上游报错）。让它们永远转下去
   * 是不对的：界面会一直显示「运行中」，而且 hasRunning() 恒为真会让
   * 「Pi 正在处理…」再也不出现。 */
  settleRunning();
}

/* ---------- 用户消息 ---------- */

let disclosureId = 0;

function setDisclosure(button, body, open) {
  button.setAttribute('aria-expanded', String(open));
  body.hidden = !open;
}

function thinkingBlock(text = '') {
  const wrap = document.createElement('div');
  wrap.className = 'think';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'think-head';
  button.innerHTML = iconMarkup('chevronRight') + '<span></span>';
  const body = document.createElement('div');
  body.className = 'think-body';
  body.id = 'thinking-detail-' + ++disclosureId;
  button.id = 'thinking-summary-' + disclosureId;
  body.setAttribute('role', 'region');
  body.setAttribute('aria-labelledby', button.id);
  const status = document.createElement('span');
  status.className = 'ui2-think-status';
  button.appendChild(status);
  button.setAttribute('aria-controls', body.id);
  setDisclosure(button, body, false);
  button.addEventListener('click', () => {
    preserveScrollAround(button, () => setDisclosure(button, body, body.hidden));
  });
  wrap.append(button, body);
  updateThinking(wrap, text);
  setThinkingState(wrap, 'streaming');
  return wrap;
}

function setThinkingState(wrap, state) {
  wrap.dataset.state = state;
  const labels = { streaming: '生成中', returned: '已返回', complete: '已完成', error: '发生错误', interrupted: '已中断' };
  wrap.querySelector('.ui2-think-status').textContent = ' · ' + labels[state];
}

function updateThinking(wrap, text) {
  const body = wrap.querySelector('.think-body');
  if (body.textContent !== text) body.textContent = text;
  wrap.querySelector('.think-head span').textContent = `思考过程 · ${text.length} 字`;
}

function syncMessageChildren(body, nodes) {
  let next = body.firstChild;
  for (const node of nodes) {
    if (node === next) next = next.nextSibling;
    else body.insertBefore(node, next);
  }
  while (next) {
    const old = next;
    next = next.nextSibling;
    old.remove();
  }
}

function fileBlockCard(name, meta, content) {
  const d = document.createElement('div');
  d.className = 'msg-file';

  const head = document.createElement('button');
  head.className = 'msg-file-head';
  head.type = 'button';
  head.appendChild(icon(iconFor(name)));

  const n = document.createElement('span');
  n.textContent = name;
  head.appendChild(n);

  const mt = document.createElement('span');
  mt.className = 'msg-file-meta';
  mt.textContent = meta || '';
  head.appendChild(mt);

  const chev = document.createElement('span');
  chev.className = 'mf-chev';
  chev.appendChild(createIcon('chevronRight'));
  head.appendChild(chev);

  const inner = document.createElement('div');
  inner.className = 'msg-file-body';
  inner.id = 'file-detail-' + ++disclosureId;
  inner.hidden = true;
  inner.textContent = content;

  head.setAttribute('aria-controls', inner.id);
  head.setAttribute('aria-expanded', 'false');
  head.onclick = () => {
    const open = inner.hidden;
    d.classList.toggle('open', open);
    setDisclosure(head, inner, open);
  };
  d.append(head, inner);
  return d;
}

/* 图片附件的缩略图行。数据取自消息 content 里的 image 部分，
 * 所以刷新页面后从历史重建也能还原，不依赖内存里的 S.attachments。 */
function attChips(imgs) {
  const row = document.createElement('div');
  row.className = 'msg-att-chips';
  for (const c of imgs) {
    const chip = document.createElement('div');
    chip.className = 'msg-att-chip';
    chip.title = '图片附件';
    const img = document.createElement('img');
    img.src = `data:${c.mimeType || 'image/png'};base64,${c.data}`;
    img.alt = '图片附件';
    chip.appendChild(img);
    row.appendChild(chip);
  }
  return row;
}

/* 用户消息体：把附件正文切成折叠卡片，否则一份长 PDF 会把对话整个铺满。
 * 实时渲染和历史重建共用，避免刷新后裸标签直接暴露出来。 */
export function userBody(msg) {
  const body = document.createElement('div');
  body.className = 'msg-body';

  const raw = textOf(msg) || '(空消息)';

  const imgs = Array.isArray(msg?.content) ? msg.content.filter((c) => c?.type === 'image' && c.data) : [];
  if (imgs.length) body.appendChild(attChips(imgs));

  FILE_BLOCK_RE.lastIndex = 0;
  let last = 0;
  let m;
  const pushText = (s) => {
    const v = s.trim();
    if (!v) return;
    const seg = document.createElement('div');
    seg.innerHTML = md(v);
    body.appendChild(seg);
  };

  while ((m = FILE_BLOCK_RE.exec(raw))) {
    pushText(raw.slice(last, m.index));
    body.appendChild(fileBlockCard(m[1], m[2], m[3]));
    last = m.index + m[0].length;
  }
  pushText(raw.slice(last));

  if (!body.childNodes.length) body.textContent = raw;
  return body;
}

export function textOf(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  return '';
}

/* resultText 搬去了 tool-model.js —— 它是「工具返回值长什么样」的协议知识，
 * 时间线（实时 + 历史）和消息渲染都要用，放在数据模型那一层更合适。 */

function imagesOf(msg) {
  return Array.isArray(msg?.content)
    ? msg.content.filter(part => part?.type === 'image' && part.data).map(part => ({ type: 'image', data: part.data, mimeType: part.mimeType }))
    : [];
}

function userMessageWithText(text, images) {
  return { role: 'user', content: [{ type: 'text', text }, ...images] };
}

function updateClassicUserArticle(article, text, images, userIndex) {
  if (!article?.isConnected) return;
  const msg = userMessageWithText(text, images);
  userTextByArticle.set(article, text);
  const body = article.querySelector('.msg-body');
  if (body) body.replaceWith(userBody(msg));
  const actions = messageActions(text, { onEdit: () => openClassicEditor(article, msg, userIndex) });
  const oldActions = article.querySelector('.message-actions');
  if (oldActions) oldActions.replaceWith(actions);
  else article.appendChild(actions);
  article.dataset.userIndex = String(userIndex);
}

function trimClassicTail(pending) {
  if (!pending) return;
  for (const node of pending.oldTail) {
    if (node?.isConnected) node.remove();
  }
  if (S.current && pending.oldTail.has(S.current.wrap)) {
    S.current = null;
    S.blocks.clear();
  }
  if (S.working && pending.oldTail.has(S.working)) hideWorking();
  if (S.tlGroup && pending.oldTail.has(S.tlGroup)) {
    S.tlGroup = null;
    toolGroupCallId = null;
  }
}

function applyClassicEditResult(result, pending) {
  if (!pending) return;
  pending.accepted = true;
  noteTurnUserIndex(pending.userIndex);
  /* 重新生成不改变目标用户消息的正文；正文与附件由紧随其后的
   * `message_start user` 事件校正，不能拿空 images 重画而丢掉附件。 */
  if (pending.kind === 'regenerate') {
    trimClassicTail(pending);
    return;
  }
  const text = typeof result?.text === 'string' && result.text ? result.text : pending.text;
  updateClassicUserArticle(pending.article, text, pending.images, pending.userIndex);
  trimClassicTail(pending);
}

/* agent_start 先于用户的 message_start 到达，所以“本轮是哪条用户消息”要等
 * 真正的用户消息出现（正常发送或编辑事务的回声）才确定；steer 不覆盖它。 */
function noteTurnUserIndex(userIndex) {
  if (liveTurn && !liveTurn.finalized && !Number.isInteger(liveTurn.userIndex) && Number.isInteger(userIndex)) {
    liveTurn.userIndex = userIndex;
  }
}

function applyClassicEditEvent(msg) {
  const pending = pendingEdit;
  if (!pending) return false;
  noteTurnUserIndex(pending.userIndex);
  /* 同一个用户消息可能先由 HTTP 结果处理、再由 SSE 的 message_start 补一次。
   * 第二次只允许校正正文，绝不能再追加一条用户消息。 */
  if (pending.eventApplied) return true;
  const text = textOf(msg) || pending.text;
  const images = imagesOf(msg);
  pending.text = text;
  pending.images = images.length ? images : pending.images;
  updateClassicUserArticle(pending.article, text, pending.images, pending.userIndex);
  trimClassicTail(pending);
  pending.eventApplied = true;
  return true;
}

function clearPendingClassicEdit() {
  pendingEdit = null;
}

/* 给一轮里最后一条可见的助手消息挂“重新生成”。按钮属于既有 message-actions
 * 体系（与复制/编辑同尺寸、同 hover/focus 规则），不新建按钮样式。 */
function attachClassicRegenerate(article, userIndex) {
  if (!article || !Number.isInteger(userIndex)) return null;
  if (article.querySelector('.message-regenerate')) return null;
  const text = article.querySelector('.msg-body')?.textContent || '';
  const bar = messageActions(text, {
    onRegenerate: event => regenerateClassicTurn(event?.currentTarget, userIndex),
  });
  article.append(bar);
  return bar;
}

function showClassicEditRecovery(requestId, pending) {
  const reload = () => document.dispatchEvent(new CustomEvent('pi-gui:reload-classic-history'));
  const sync = async () => {
    let status = null;
    try { status = await messageEditRecover(requestId); } catch { status = null; }
    if (status?.state === 'accepted') {
      clearPendingMessageEdit(requestId);
      if (pending) applyClassicEditResult({ ...(status.result || {}), ok: true }, pending);
      else reload();
      toast('已重新同步，会话已按新消息更新。', 'success', { important: true });
      return;
    }
    if (status?.state === 'failed' || status?.state === 'recovery_required' || status?.state === 'stale_session') {
      clearPendingMessageEdit(requestId);
      if (pending && !pending.eventApplied && pendingEdit === pending) pendingEdit = null;
      if (!pending) reload();
      toast(messageEditErrorText(status.result?.code || status.state), 'error');
      return;
    }
    toast(messageEditErrorText('recovery_pending'), 'error', {
      action: { label: '重新同步', run: sync },
    });
  };
  toast(messageEditErrorText('acceptance_unknown'), 'error', {
    action: { label: '重新同步', run: sync },
  });
}

async function regenerateClassicTurn(button, userIndex) {
  if (!Number.isInteger(userIndex) || button?.disabled) return;
  if (messageEditorBusy()) {
    toast('请先完成当前的编辑操作。', 'error');
    return;
  }
  /* 重新生成会替换这条用户消息之后的对话；已经打开的就地编辑器必须先收起，
   * 否则它会停留在一条即将被替换的旧路径上。 */
  closeMessageEditor({ restore: true, focus: false });
  const article = S.thread?.querySelector(`article.msg.user[data-user-index="${userIndex}"]`);
  if (!article?.isConnected) {
    toast(messageEditErrorText('unknown_user_message'), 'error');
    return;
  }
  /* 点击时前端持有的原文；preflight 必须指向同一条消息，而不是另一个
   * 恰好占着这个 userIndex 的节点。 */
  const clickedText = userTextByArticle.get(article);
  if (typeof clickedText !== 'string') {
    toast(messageEditErrorText('stale_history'), 'error');
    return;
  }
  if (button) button.disabled = true;
  try {
    const pre = await messageEditPreflight({ userIndex, kind: 'regenerate' });
    const busy = isEditInProgress(pre);
    if (!pre?.ok || busy) {
      if (busy) {
        const pendingRecord = readPendingMessageEdit({
          kind: 'classic',
          ...(S.legacyOwner?.sessionId ? { sessionId: S.legacyOwner.sessionId } : {}),
        });
        if (pendingRecord && pendingRecord.scope?.kind === 'classic'
          && (!pendingRecord.scope.sessionId || pendingRecord.scope.sessionId === S.legacyOwner?.sessionId)) {
          showClassicEditRecovery(pendingRecord.requestId, null);
          return;
        }
        toast(messageEditErrorText('edit_in_progress'), 'error');
        return;
      }
      toast(messageEditErrorText(pre?.code), 'error');
      return;
    }
    if (pre.canEdit !== true) { toast(messageEditErrorText(pre.reason || 'edit_unavailable'), 'error'); return; }
    if (pre.text !== clickedText) { toast(messageEditErrorText('stale_history'), 'error'); return; }
    if (pre.hasToolsAfter === true) {
      const confirmed = await confirmModal({
        title: '重新生成',
        message: '重新发送会替换后续对话，之前已经执行的文件修改和命令操作不会自动撤销。',
        okText: '重新生成',
        cancelText: '取消',
      });
      if (confirmed !== true) return;
    }
    const children = S.thread ? [...S.thread.children] : [];
    const at = children.indexOf(article);
    const pending = {
      article,
      userIndex: Number.isInteger(pre.userIndex) ? pre.userIndex : userIndex,
      images: [],
      text: pre.text,
      kind: 'regenerate',
      oldTail: new Set(at >= 0 ? children.slice(at + 1) : []),
      eventApplied: false,
      accepted: false,
    };
    pendingEdit = pending;
    const requestId = messageEditRequestId();
    rememberPendingMessageEdit({
      requestId,
      text: pre.text,
      userIndex: pending.userIndex,
      kind: 'regenerate',
      scope: { kind: 'classic', sessionId: pre.sessionId, backendInstance: S.bridgeInstance },
      at: Date.now(),
    });
    let result;
    try {
      result = await messageEditResend({
        userIndex: pending.userIndex,
        kind: 'regenerate',
        text: pre.text,
        expectedEntryId: pre.entryId,
        expectedParentId: pre.parentId ?? null,
        expectedLeafId: pre.leafId,
        expectedSessionId: pre.sessionId,
        requestId,
      });
    } catch {
      result = { ok: false, code: 'network', network: true };
    }
    if (!result?.ok && (result?.network === true || result?.code === 'network')) {
      const resolved = await resolveEditAcceptance(id => messageEditStatus(id), requestId);
      result = resolved || { ok: false, code: 'acceptance_unknown' };
    }
    if (!result?.ok) {
      /* 结果未知时保留 pending：迟到的 message_start 仍应就地更新目标，
       * 而不是再追加一条用户消息。 */
      if (!result?.unresolved) clearPendingMessageEdit(requestId);
      if (!result?.unresolved && !pending.eventApplied && pendingEdit === pending) pendingEdit = null;
      if (result?.unresolved || result?.code === 'acceptance_unknown' || result?.code === 'recovery_pending') {
        showClassicEditRecovery(requestId, pending);
      } else {
        toast(messageEditErrorText(result?.code), 'error');
      }
      return;
    }
    clearPendingMessageEdit(requestId);
    applyClassicEditResult(result, pending);
  } catch {
    toast(messageEditErrorText('network'), 'error');
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

function openClassicEditor(article, msg, userIndex) {
  if (!article?.isConnected || !Number.isInteger(userIndex)) return null;
  const body = article.querySelector('.msg-body');
  const actions = article.querySelector('.message-actions');
  const text = textOf(msg);
  const images = imagesOf(msg);
  let pendingRef = null;
  return openMessageEditor({
    text,
    userIndex,
    hasImages: images.length > 0,
    kind: 'edit',
    mount: article,
    originals: [body, actions].filter(Boolean),
    returnFocus: actions?.querySelector('.message-edit'),
    pendingScope: {
      kind: 'classic',
      backendInstance: S.bridgeInstance,
      ...(S.legacyOwner?.sessionId ? { sessionId: S.legacyOwner.sessionId } : {}),
    },
    preflight: ({ userIndex: index, kind }) => messageEditPreflight({ userIndex: index, kind }),
    resend: async payload => {
      const children = S.thread ? [...S.thread.children] : [];
      const at = children.indexOf(article);
      const pending = {
        article,
        userIndex: Number.isInteger(payload.userIndex) ? payload.userIndex : userIndex,
        images,
        text: payload.text,
        kind: 'edit',
        oldTail: new Set(at >= 0 ? children.slice(at + 1) : []),
        eventApplied: false,
        accepted: false,
      };
      pendingRef = pending;
      pendingEdit = pending;
      let result;
      try { result = await messageEditResend(payload); }
      catch { result = { ok: false, code: 'network', network: true }; }
      /* 传输失败不等于事务失败：后端可能已经接受 prompt。按 requestId 读
       * 权威状态，避免把“已接受”误报成失败、再让用户重试造成双发。 */
      if (!result?.ok && (result?.network === true || result?.code === 'network')) {
        const resolved = await resolveEditAcceptance(id => messageEditStatus(id), payload.requestId);
        result = resolved || { ok: false, code: 'acceptance_unknown' };
      }
      if (!result?.ok) {
        if (!result?.unresolved && !pending.eventApplied && pendingEdit === pending) pendingEdit = null;
        return result;
      }
      applyClassicEditResult(result, pending);
      return result;
    },
    readStatus: requestId => messageEditStatus(requestId),
    recover: async requestId => {
      let status = null;
      try { status = await messageEditRecover(requestId); } catch { return null; }
      const reload = () => document.dispatchEvent(new CustomEvent('pi-gui:reload-classic-history'));
      if (status?.state === 'accepted') {
        if (pendingRef) applyClassicEditResult({ ...(status.result || {}), ok: true }, pendingRef);
        else reload();
      } else if (status?.state === 'failed' || status?.state === 'recovery_required' || status?.state === 'stale_session') {
        if (pendingRef && !pendingRef.eventApplied && pendingEdit === pendingRef) pendingEdit = null;
        if (!pendingRef) reload();
      }
      return status;
    },
  });
}

function renderUser(msg, { userIndex = null } = {}) {
  finishClassicHistoryBeforeLive();
  const t = ensureThread();
  /* 用户消息是工具分组的硬边界：上一条 assistant 那批工具已经彻底结束了。
   * 放在这里而不是靠时间判断 —— §12 明确禁止「超过几秒算新组」那种猜测。 */
  S.tlGroup = null;
  toolGroupCallId = null;
  /* 新回合：上一张计划卡留在时间线里，但下一批 gui_plan 更新要开新卡。 */
  resetPlanLiveForUserTurn();

  const index = Number.isInteger(userIndex) ? userIndex : userIndexSeq;
  userIndexSeq = Math.max(userIndexSeq, index + 1);
  noteTurnUserIndex(index);

  const wrap = document.createElement('article');
  wrap.className = 'msg user';
  wrap.dataset.anchorId = 'user-' + (++userSeq);
  wrap.dataset.userIndex = String(index);

  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = '你';

  userTextByArticle.set(wrap, textOf(msg));
  wrap.append(role, userBody(msg), messageActions(textOf(msg), {
    onEdit: () => openClassicEditor(wrap, msg, index),
  }));
  t.appendChild(wrap);
  /* 立刻注册导航点（§11）：不等 assistant 回复完 —— 用户刚发完就该能
   * 在左边看到自己这一条的位置。 */
  registerConversationAnchor(wrap);
  moveWorkingToEnd();
  scrollBottom(true);
}

function createAssistant() {
  finishClassicHistoryBeforeLive();
  const t = ensureThread();
  const wrap = document.createElement('article');
  wrap.className = 'msg assistant';
  wrap.dataset.anchorId = 'assistant-' + (++assistantSeq);

  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = 'Pi';

  const body = document.createElement('div');
  body.className = 'msg-body';

  wrap.append(role, body);
  t.appendChild(wrap);

  S.current = { wrap, body };
  S.blocks.clear();
  moveWorkingToEnd();
  scrollBottom();
  return S.current;
}

export function onMessageStart(evt) {
  finishClassicHistoryBeforeLive();
  const msg = evt.message || {};
  if (msg.role === 'user') {
    /* 编辑事务已经捕获了目标消息和旧尾部：Pi 把修改后的用户消息当成一条
     * 新的 message_start 发回来，这里只就地更新目标，绝不再 append 一条。 */
    if (pendingEdit) {
      applyClassicEditEvent(msg);
      return;
    }
    return renderUser(msg);
  }
  if (msg.role !== 'assistant') return;

  /* 新的 assistant 消息开始 = 上一批工具调用已经跑完了（实测的事件顺序是
   * message_end → tool_execution_start，所以组在这里关掉正好）。
   * 这是**真实边界**：消息本身就是边界。 */
  S.tlGroup = null;
  toolGroupCallId = null;
  createAssistant();
}

/* ---------- 流式块组装 ---------- */

const pendingPaint = new Map();
let rafId = null;

function schedulePaint(block) {
  pendingPaint.set(block, true);
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    for (const b of pendingPaint.keys()) paint(b);
    pendingPaint.clear();
  });
}

function paint(b) {
  if (!b.node) return;
  if (b.kind === 'text') {
    b.node.innerHTML = md(b.text);
  } else if (b.bodyEl) {
    b.bodyEl.textContent = b.text;
    if (b.headEl) b.headEl.textContent = `思考过程 · ${b.text.length} 字`;
  }
}

function ensureBlock(idx, kind) {
  const existing = S.blocks.get(idx);
  if (existing && existing.kind === kind) return existing;
  if (!S.current) createAssistant();

  const b = { kind, text: '', node: null };

  if (kind === 'text') {
    const textBlock = document.createElement('div');
    textBlock.className = 'assistant-text';
    S.current.body.appendChild(textBlock);
    b.node = textBlock;
  } else {
    const wrap = thinkingBlock();
    S.current.body.appendChild(wrap);
    b.node = wrap;
    b.bodyEl = wrap.querySelector('.think-body');
    b.headEl = wrap.querySelector('.think-head span');
  }

  S.blocks.set(idx, b);
  return b;
}

function appendBlock(idx, kind, delta) {
  const b = ensureBlock(idx, kind);
  b.text += delta;
  schedulePaint(b);
}

function setBlockText(idx, kind, text) {
  const b = ensureBlock(idx, kind);
  b.text = text;
  paint(b);
}

export function onMessageUpdate(evt) {
  const d = evt.assistantMessageEvent;
  if (!d) return;
  const idx = d.contentIndex ?? 0;

  switch (d.type) {
    case 'text_start':
      ensureBlock(idx, 'text');
      break;
    case 'text_delta':
      appendBlock(idx, 'text', d.delta || '');
      scrollBottom();
      break;
    case 'text_end':
      if (typeof d.content === 'string') setBlockText(idx, 'text', d.content);
      break;

    case 'thinking_start':
      ensureBlock(idx, 'think');
      break;
    case 'thinking_delta':
      appendBlock(idx, 'think', d.delta || '');
      break;
    case 'thinking_end': {
      if (typeof d.content === 'string') setBlockText(idx, 'think', d.content);
      const block = S.blocks.get(idx);
      if (block?.kind === 'think') setThinkingState(block.node, 'returned');
      break;
    }
    default:
      break;
  }
}

export function onMessageEnd(evt) {
  const msg = evt.message;
  if (msg?.role === 'assistant') {
    // 与历史按同一条 assistant 声明的首个普通工具定位，实际工具启动顺序可以不同。
    toolGroupCallId = Array.isArray(msg.content)
      ? msg.content.find(part => part?.type === 'toolCall' && !isPlanTool(part.name))?.id
      : null;
    /* 轮次失败只认 assistant 的终态证据；工具 isError 不改变轮次状态。
     * 与 rebuildAssistant 的判定保持一致：用户主动停止优先按中性处理。 */
    if (liveTurn && !liveTurn.finalized) {
      const ownedAbort = msg.stopReason === 'aborted' && S.stopOwnedTurn === true;
      liveTurn.lastAssistant = {
        failed: !ownedAbort && (msg.stopReason === 'error' || Boolean(msg.errorMessage)),
        stopped: ownedAbort,
        interrupted: msg.stopReason === 'aborted' && !ownedAbort,
        at: Number.isFinite(msg.timestamp) ? msg.timestamp : Date.now(),
        seq: ++liveTurn.seq,
      };
    }
    if (S.current) {
      // 最终消息是权威值；丢弃尚未执行的流式绘制，避免下一帧把旧草稿写回复用节点。
      pendingPaint.clear();
      // message_end.message 是权威，用它校正渲染结果
      const keep = rebuildAssistant(S.current.body, msg);
      /* 只有工具调用、没有正文时整条外壳收掉。
       * 工具卡片由 tools.js 直接挂在 thread 上，不在这个 body 里，所以不受影响；
       * 下一轮 message_start 会再建一个新的外壳。 */
      if (!keep) S.current.wrap.remove();
      else {
        const meta = renderMessageMeta(msg);
        if (meta) S.current.wrap.appendChild(meta);
        /* 一轮里最后一条**有正文**的助手消息承载“重新生成”；后续只有工具
         * 调用的空消息被收掉时，仍指回这条。 */
        if (liveTurn && !liveTurn.finalized) liveTurn.lastAssistantNode = S.current.wrap;
      }
    }
  }
  S.current = null;
  S.blocks.clear();
  moveWorkingToEnd();
  scrollBottom();
}

/* ---------- 失败 / 中断 / 空回复 ---------- */

/* 把上游错误翻译成人话。
 * pi 把 HTTP 错误原样塞在 message.errorMessage 里，形如
 * `402: {"message":"Insufficient Balance","type":"unknown_error",...}`，
 * 直接铺给用户没法看。实测余额不足时 stopReason='error'、usage 全 0、
 * content 为空 —— 不处理的话对话区就是一片空白，完全看不出发生了什么。 */
const ERR_RULES = [
  [/insufficient[_ ]?(balance|quota)|余额不足|quota exceeded|exceeded your current quota/i, '账户余额不足', '到模型服务商平台充值后重试'],
  [/401|unauthorized|invalid[_ ]api[_ ]key|incorrect api key/i, 'API Key 无效或已过期', '检查左下「模型供应商」里的 Key'],
  [/403|forbidden|permission denied/i, '无权访问该模型', '确认账号是否已开通这个模型'],
  [/404|model[_ ]not[_ ]found|no such model|does not exist/i, '模型不存在', '在「模型供应商」里核对模型 ID'],
  [/429|rate[_ ]limit|too many requests/i, '触发限流', '稍等片刻再试，或降低并发'],
  [/context[_ ]length|too many tokens|maximum context/i, '上下文超出模型上限', '用「压缩」精简历史，或新开会话'],
  [/\b5\d\d\b|internal server error|bad gateway|service unavailable/i, '模型服务端异常', '通常是临时故障，稍后重试'],
  [/fetch failed|econnrefused|enotfound|etimedout|socket hang up|network/i, '网络连接失败', '检查网络或代理设置'],
];

export function explainError(raw) {
  const s = String(raw || '');
  for (const [re, title, hint] of ERR_RULES) {
    if (re.test(s)) return { title, hint };
  }
  return { title: '请求失败', hint: '' };
}

export function errorBlock(msg, { announce = true } = {}) {
  const raw = msg?.errorMessage || '';
  const { title, hint } = explainError(raw);

  const d = document.createElement('div');
  d.className = 'msg-err';
  if (announce) {
    d.setAttribute('role', 'alert');
    d.setAttribute('aria-atomic', 'true');
  }

  const head = document.createElement('div');
  head.className = 'me-head';
  const t = document.createElement('span');
  t.textContent = title;
  head.appendChild(t);
  d.appendChild(head);

  if (hint) {
    const h = document.createElement('div');
    h.className = 'me-hint';
    h.textContent = hint;
    d.appendChild(h);
  }

  const r = document.createElement('div');
  r.className = 'me-raw';
  r.textContent = raw || '(pi 没有给出错误详情)';
  d.appendChild(r);
  return d;
}

export function noteBlock(text) {
  const d = document.createElement('div');
  d.className = 'msg-note';
  d.textContent = text;
  return d;
}

/**
 * 在对话区里留一条**留得住**的说明（历史读不出来时用）。
 *
 * 为什么不用 toast：toast 会自己消失，而且对话区仍然一片空白 —— 用户会以为
 * 「对话丢了」。这条留在那里，直到下一次成功的历史重建把它清掉。
 */
export function noteLoadFailure(text) {
  finishClassicHistoryBeforeLive();
  const t = ensureThread();
  t.appendChild(noteBlock(text));
}

/* 重试开始时撤掉上一次留下的错误块（message_end 已经把 S.current 清空了，
 * 所以还要能回退到对话区里最后一条助手消息）。
 *
 * **只撤错误块是不够的**：pi 每重试一次就重发一次 message_start，所以失败那轮
 * 已经建好了一个新的「Pi」外壳（createAssistant）。错误块一撤，外壳就成了一条
 * 没有正文的空白「Pi」；上游连续失败三次，对话里就是三条空白（实测如此，
 * 数据见会话 jsonl：三条 stopReason=error 且 content 为空的消息）。
 * 所以外壳空了就连它一起收走。
 *
 * 反过来，body 里还有别的东西（失败前已经流出来的正文）时**保留外壳** ——
 * 那是用户已经看到的内容，不该跟着错误块消失。
 * S.current 还指着它时也不动：那说明 message_end 还没跑，外壳马上会被复用。 */
export function dropTrailingError() {
  const body = S.current?.body || [...document.querySelectorAll('#stream .thread .msg.assistant .msg-body')].pop();
  if (!body) return;

  const last = body.lastElementChild;
  if (last && last.classList.contains('msg-err')) last.remove();

  if (!body.childElementCount && S.current?.wrap !== body.parentElement) {
    body.parentElement?.remove();
  }
}

/** 取出当前错误块里**已经显示过**的安全文本，供重试摘要保留。 */
export function captureTrailingError() {
  const body = S.current?.body || [...document.querySelectorAll('#stream .thread .msg.assistant .msg-body')].pop();
  const err = body?.querySelector('.msg-err');
  if (!err) return null;
  return {
    title: err.querySelector('.me-head')?.textContent || '',
    hint: err.querySelector('.me-hint')?.textContent || '',
    raw: err.querySelector('.me-raw')?.textContent || '',
  };
}

/* P4-B：只给**当前线程最后一条失败消息**挂恢复入口。
 *
 * 历史重建不会调用本函数，因此只读历史与 Runtime 保持原有展示。`run`
 * 由装配层注入真正存在的设置入口；这里只负责按钮、执行中以及成功/失败
 * 状态。原始错误块永远保留 —— 动作失败、重复点击和会话变化都不删除它。 */
export function attachErrorRecovery(action, { run } = {}) {
  if (!action?.id || !action.label || typeof run !== 'function') return null;
  const body = S.current?.body
    || [...document.querySelectorAll('#stream .thread .msg.assistant .msg-body')].pop();
  const err = body?.querySelector('.msg-err');
  if (!err) return null;

  let box = err.querySelector('.me-actions');
  if (!box) {
    box = document.createElement('div');
    box.className = 'me-actions';
    err.appendChild(box);
  }
  box.replaceChildren();
  box.dataset.action = action.id;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn tiny me-action';
  btn.textContent = action.label;
  if (action.title) btn.title = action.title;

  const status = document.createElement('span');
  status.className = 'me-action-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  box.append(btn, status);

  let busy = false;
  const setStatus = (text, state) => {
    status.textContent = text || '';
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  };
  btn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    setStatus('正在打开…', 'pending');
    let result;
    try {
      result = await run(action.id);
    } catch {
      result = { ok: false, message: '操作失败，请稍后重试。' };
    }
    busy = false;
    if (btn.isConnected) {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
    if (!result || result.ok !== true) {
      setStatus(result?.message || '操作失败，请稍后重试。', 'error');
      return;
    }
    setStatus(result.message || '已完成', 'success');
  });

  return box;
}

/**
 * 自动重试期间的紧凑错误摘要。
 *
 * 重试会删除上一轮的错误块（避免重试成功后仍留一张失败卡），但失败原因
 * 不能跟着消失。这里保留一条可展开的摘要，重试结束/成功/最终失败时移除；
 * 原始错误来自已经渲染过的 `.me-raw`（服务端已做安全归一），只走 textContent。
 */
export function showRetryNotice({ attempt, maxAttempts, error } = {}) {
  finishClassicHistoryBeforeLive();
  const t = ensureThread();
  if (!retryNotice || !retryNotice.isConnected) {
    retryNotice = document.createElement('div');
    retryNotice.className = 'msg-retry';
    const line = document.createElement('div');
    line.className = 'msg-retry-line';
    line.setAttribute('role', 'status');
    const title = document.createElement('span');
    title.className = 'msg-retry-title';
    line.appendChild(title);
    retryNotice.appendChild(line);
    retryNotice._retry = { title, details: null, hint: null, raw: null };
    t.appendChild(retryNotice);
  }

  const p = retryNotice._retry;
  const raw = String(error?.raw || '');
  const hint = String(error?.hint || '');
  const title = error?.title || (raw ? explainError(raw).title : '请求失败');
  const attemptText = Number.isInteger(attempt) && Number.isInteger(maxAttempts)
    ? `第 ${attempt}/${maxAttempts} 次重试…`
    : '正在重试…';
  const titleText = `${title} · ${attemptText}`;
  if (p.title.textContent !== titleText) p.title.textContent = titleText;

  if ((raw || hint) && !p.details) {
    const details = document.createElement('details');
    details.className = 'msg-retry-details';
    const summary = document.createElement('summary');
    summary.textContent = '错误详情';
    details.appendChild(summary);
    const body = document.createElement('div');
    body.className = 'msg-retry-body';
    if (hint) {
      const h = document.createElement('div');
      h.className = 'msg-retry-hint';
      body.appendChild(h);
      p.hint = h;
    }
    if (raw) {
      const r = document.createElement('pre');
      r.className = 'msg-retry-raw';
      body.appendChild(r);
      p.raw = r;
    }
    details.appendChild(body);
    retryNotice.appendChild(details);
    p.details = details;
  }

  if (p.hint) {
    if (p.hint.textContent !== hint) p.hint.textContent = hint;
    p.hint.hidden = !hint;
  }
  if (p.raw) {
    if (p.raw.textContent !== raw) p.raw.textContent = raw;
    p.raw.hidden = !raw;
  }
  if (p.details) p.details.hidden = !(raw || hint);
  return retryNotice;
}

export function clearRetryNotice() {
  if (!retryNotice) return;
  retryNotice.remove();
  retryNotice = null;
}

/* 用 message_end 的权威内容重建一条助手消息的正文。
 *
 * **返回值 = 这条消息有没有值得占位的正文**（bodyEl 里落了东西就是 true）。
 * 调用方据此决定要不要保留外层那圈「Pi」角色行 —— 只有 toolCall 的助手消息
 * 渲染不出任何东西，返回 false，调用方把整个外壳收掉，别留空白。
 *
 * 三种「没有正文」要分开看，别混成一种：
 *   - 有 toolCall 之类不可渲染的 part → 什么都不加，返回 false（收掉外壳）
 *   - content 真的为空、也不是失败/中断 → 加一句提示，返回 true（不是空白）
 *   - 失败 / 中断 → 加错误卡片或「已中断」，返回 true */
export function rebuildAssistant(bodyEl, msg) {
  const announceError = S.current?.body === bodyEl && !bodyEl.querySelector('.msg-err');
  const content = Array.isArray(msg.content) ? msg.content : [];
  const aborted = msg?.stopReason === 'aborted';
  /* 「用户主动停止」与「真正的失败」必须分开，判据是**停止归属**而不是
   * 文案里有没有 cancelled 字样：
   *
   *   - `aborted` + S.stopOwnedTurn：这一轮 run 期间用户点过 Stop，且还没开始
   *     下一轮 —— Pi 报的 stopReason:'aborted' 是我们的停止。渲染成中性状态。
   *   - 其余情况（包括 stopReason:'error' 且 errorMessage 里带「请求已取消」）：
   *     **照旧渲染错误块**。不吞任何非本次停止造成的取消错误 ——
   *     provider 自己的 cancelled / 扩展的 abort 都要看得见。
   *
   * 只认 stopReason、不认文案：`errorMessage` 是已经被分类过的结果
   * （见 model-generation.js），拿它反推「是不是取消」会把无关错误也吞掉。 */
  const ownedAbort = aborted && S.stopOwnedTurn === true;
  const failed = !ownedAbort && (msg?.stopReason === 'error' || Boolean(msg?.errorMessage));

  const liveBlocks = S.current?.body === bodyEl ? S.blocks : null;
  const nodes = [];
  content.forEach((part, idx) => {
    if (part.type === 'text') {
      const text = part.text || '';
      if (!text) return;
      const old = liveBlocks?.get(idx);
      const node = old?.kind === 'text' ? old.node : document.createElement('div');
      node.className = 'assistant-text';
      // b.text 是已收到的流式数据，不代表待执行的 rAF 已把它画进 DOM。
      node.innerHTML = md(text);
      nodes.push(node);
    } else if (part.type === 'thinking') {
      const old = liveBlocks?.get(idx);
      const node = old?.kind === 'think' ? old.node : thinkingBlock();
      updateThinking(node, part.thinking || '');
      setThinkingState(node, aborted ? 'interrupted' : failed ? 'error' : 'complete');
      nodes.push(node);
    }
  });
  // pi 报错时可能不给最终 content；保留已经流给用户的正文。
  if (!content.length && (failed || aborted) && liveBlocks) {
    for (const block of liveBlocks.values()) if (block.text && block.node) {
      paint(block); // message_end cleared pending rAF; keep its received tail too.
      if (block.kind === 'think') setThinkingState(block.node, aborted ? 'interrupted' : 'error');
      nodes.push(block.node);
    }
  }
  syncMessageChildren(bodyEl, nodes);

  if (!nodes.length && !content.length && !failed && !aborted) {
    // 既没内容也不是失败 —— pi 这次什么都没返回，给个提示别留空白
    bodyEl.appendChild(noteBlock('（这次没有返回内容）'));
  }

  if (failed) bodyEl.appendChild(errorBlock(msg, { announce: announceError }));
  else if (aborted) bodyEl.appendChild(noteBlock(ownedAbort ? '已由用户取消' : '已中断'));

  return bodyEl.childElementCount > 0;
}

export function rebuildFromMessages(data, sessionId = threadSessionId || S.state?.sessionId || null) {
  const msgs = Array.isArray(data) ? data : data?.messages || [];
  // 同一会话原地刷新时保存已有位置。切换后的空线程由其原会话保存入口负责。
  saveClassicReadingPosition(sessionId);
  clearThread();
  threadSessionId = sessionId;
  const t = ensureThread();
  /* 小历史仍在 DocumentFragment 里一次建好再挂载（§17）；长历史走
   * mountHistoryInChunks，按批构建并挂载。 */
  const frag = document.createDocumentFragment();

  /* 配对规则全部在 tool-history.js 里（纯函数，可单独测）：
   * toolCall + 对应 toolResult → 一条完整的时间线条目；
   * 缺 result → 「未完成」；孤儿 result → 就地降级显示，不丢也不崩。 */
  const items = planHistory(msgs);
  /* 每个用户回合最多一张计划卡，内容取该回合最后一次有效更新。 */
  const planTurns = collectPlanTurns(items);
  let planTurn = 0;
  let historyUserIndex = 0;

  /* 历史轮次终态：只在 assistant / 工具证据存在时画；工具 isError 只计数，
   * 不把整轮判失败。时长来自消息/工具的真实时间戳，缺失就省略。 */
  let historyTurn = null;
  const markHistoryEnd = (ts) => {
    if (!historyTurn || !Number.isFinite(ts)) return;
    if (historyTurn.endedAt === null || ts > historyTurn.endedAt) historyTurn.endedAt = ts;
  };
  const startHistoryTurn = (msg, userIndex = null) => {
    historyTurn = {
      startedAt: Number.isFinite(msg?.timestamp) ? msg.timestamp : null,
      endedAt: null,
      tools: [],
      lastAssistant: null,
      userIndex: Number.isInteger(userIndex) ? userIndex : null,
      lastAssistantNode: null,
      hasEvidence: false,
    };
  };
  const flushHistoryTurn = () => {
    if (!historyTurn) return;
    const turn = historyTurn;
    historyTurn = null;
    /* 重新生成入口按轮挂在该轮最后一条可见助手消息上；历史重建也要有，
     * 否则刷新/重开之后功能就消失了。 */
    attachClassicRegenerate(turn.lastAssistantNode, turn.userIndex);
    if (!turn.hasEvidence) return;
    const outcome = deriveTurnOutcome({
      tools: turn.tools,
      lastAssistant: turn.lastAssistant,
      interruptedToolTerminal: interruptedToolTerminal(turn.tools, turn.lastAssistant),
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    });
    if (outcome) {
      const outcomeNode = renderTurnOutcome(outcome);
      if (outcomeNode) outcomeNode.dataset.anchorId = 'outcome-' + (++outcomeSeq);
      frag.appendChild(outcomeNode);
    }
  };

  /* 把单条历史项的渲染抽出来，让同步与分段两条路径共用同一份实现。
   * 分段路径每批挂载后 DocumentFragment 会被清空，因此锚点查重要同时看
   * 已挂到线程上的节点和当前批次里尚未挂载的节点。 */
  const nextPlanAnchorId = (toolCallId) => {
    const base = 'plan-' + encodeURIComponent(toolCallId);
    let anchorId = base;
    for (let occurrence = 2; t.querySelector(`[data-anchor-id="${anchorId}"]`) || frag.querySelector(`[data-anchor-id="${anchorId}"]`); occurrence++) {
      anchorId = base + ':' + occurrence;
    }
    return anchorId;
  };

  const renderItem = (item, index) => {
    if (item.kind === 'user') {
      flushHistoryTurn();
      planTurn += 1;
      const index = historyUserIndex++;
      userIndexSeq = Math.max(userIndexSeq, index + 1);
      const wrap = document.createElement('article');
      wrap.className = 'msg user';
      wrap.dataset.anchorId = 'user-' + (++userSeq);
      wrap.dataset.userIndex = String(index);
      wrap.innerHTML = '<div class="msg-role">你</div>';
      userTextByArticle.set(wrap, textOf(item.message));
      wrap.appendChild(userBody(item.message));
      wrap.appendChild(messageActions(textOf(item.message), {
        onEdit: () => openClassicEditor(wrap, item.message, index),
      }));
      frag.appendChild(wrap);
      startHistoryTurn(item.message, index);
      return;
    }

    if (item.kind === 'assistant') {
      const msg = item.message;
      if (historyTurn) {
        const failed = msg.stopReason === 'error' || Boolean(msg.errorMessage);
        const interrupted = msg.stopReason === 'aborted' && !failed;
        historyTurn.lastAssistant = {
          failed,
          stopped: false,
          interrupted,
          at: Number.isFinite(msg.timestamp) ? msg.timestamp : null,
        };
        markHistoryEnd(msg.timestamp);
      }
      const wrap = document.createElement('article');
      wrap.className = 'msg assistant';
      wrap.dataset.anchorId = 'assistant-' + (++assistantSeq);
      wrap.innerHTML = '<div class="msg-role">Pi</div>';
      const body = document.createElement('div');
      body.className = 'msg-body';
      /* 重建历史时同样不留空白「Pi」：只有工具调用的那轮没有正文可渲染，
       * 整条跳过。那次工具调用不会因此消失 —— 紧跟其后的 tools 计划项会画它。 */
      if (!rebuildAssistant(body, msg)) return;
      if (historyTurn) {
        historyTurn.hasEvidence = true;
        historyTurn.lastAssistantNode = wrap;
      }
      wrap.appendChild(body);
      const meta = renderMessageMeta(msg);
      if (meta) wrap.appendChild(meta);
      frag.appendChild(wrap);
      return;
    }

    if (item.kind === 'tools') {
      const turnPlan = planTurns.get(planTurn);
      if (turnPlan && turnPlan.firstIndex === index) {
        const planNode = renderPlan(turnPlan.plan);
        if (planNode) planNode.dataset.anchorId = nextPlanAnchorId(turnPlan.firstCallId);
        frag.appendChild(planNode);
      }
      /* gui_plan 的调用行由上面的任务列表承担，不再重复画成工具记录。 */
      const entries = item.entries.filter(entry => !isPlanTool(entry.name));
      if (entries.length) {
        if (historyTurn) {
          historyTurn.tools.push(...entries);
          historyTurn.hasEvidence = true;
          for (const entry of entries) {
            const end = Number.isFinite(entry.endedAt)
              ? entry.endedAt
              : Number.isFinite(entry.startedAt) && Number.isFinite(entry.durationMs)
                ? entry.startedAt + entry.durationMs
                : null;
            markHistoryEnd(end);
          }
        }
        const g = createClassicToolGroup(entries[0].id);
        for (const entry of entries) addClassicToolEntry(g, entry);
        frag.appendChild(g);
      }
    }
  };

  const generation = threadGeneration;
  if (msgs.length >= HISTORY_CHUNK_MESSAGES) {
    mountHistoryInChunks(t, items, sessionId, generation, { frag, renderItem, flushHistoryTurn });
    return;
  }

  for (let index = 0; index < items.length; index++) renderItem(items[index], index);
  flushHistoryTurn();
  t.appendChild(frag);
  finishHistoryRender(t, sessionId, generation);
}

/** 所有历史节点挂完之后再建导航、恢复位置、通知监听方。
 *
 * 顺序不能变：导航与定位都依赖完整 DOM 的布局；必须等最后一个分块挂完。 */
function finishHistoryRender(t, sessionId, generation, { userScrolled = false } = {}) {
  if (generation !== threadGeneration || S.thread !== t) return;
  /* 分块期间线程对辅助技术是 busy；完整 DOM、导航与位置都就绪后再解除。 */
  t.removeAttribute('aria-busy');

  /* 历史重建完之后**重新扫一遍 DOM** 建导航（§10）—— 刷新页面、重开 App、
   * 恢复旧会话、fork、retry 之后走的都是这条路。不自己维护消息副本，
   * 所以这里不需要知道「刚才删了哪几条」。 */
  rebuildConversationNav();

  /* 有人接管了定位就不再把视图拽到底部。
   * scrollBottom 走的是 requestAnimationFrame —— 若定位在这之后同步发生，
   * 那一帧会把刚滚到的位置又拉回最底（用户看到的是「跳转没生效」）。 */
  let handled = false;
  if (afterHistoryRendered) {
    try {
      handled = afterHistoryRendered(sessionId) === true;
    } catch {
      /* 监听方自己炸了不该带塌历史重建 */
      handled = false;
    }
  }
  if (!handled && !userScrolled) {
    if (sessionId && restoreSessionBookmark(sessionId, el.stream, t)) {
      handled = true;
    }
  }
  if (!handled && userScrolled) {
    /* 用户在分块挂载期间自己滚过：尊重他的位置，并把它记成新的书签，
     * 不再用挂载前保存的旧位置覆盖。没有 sessionId 的降级环境也保留位置。 */
    if (sessionId) saveSessionBookmark(sessionId, el.stream, t);
    return;
  }
  if (!handled) scrollBottom(true);
}

/** 历史分块构建并挂载。
 *
 * 每批只渲染约 HISTORY_CHUNK_NODES 个顶层节点就挂上去并让出主线程：
 *  - 首屏只需一小段同步工作就能看到内容；
 *  - 构建与布局成本被拆到多个任务，避免一次 >100ms 的长任务；
 *  - `clearThread` 或下一次重建递增 threadGeneration 后，旧任务在下一批前退出，
 *    绝不写入新会话。
 * 批大小逐次翻倍到 HISTORY_CHUNK_MAX_NODES 后封顶，长会话的块数保持个位数，
 * 避免为每块反复付出整棵线程的布局成本。用户自己滚动后不再把视口拉到底，
 * 最终位置由 finishHistoryRender 尊重。挂载窗口内如果来了实时消息 / 工具状态，
 * 先由 complete() 同步补齐剩余历史，实时节点永远排在完整历史之后。 */
function mountHistoryInChunks(t, items, sessionId, generation, { frag, renderItem, flushHistoryTurn }) {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  const state = { generation, promise, resolve };
  classicMount = state;
  /* 让读屏与「复制/打印前先等就绪」的调用方知道历史尚未完整。 */
  t.setAttribute('aria-busy', 'true');

  let settled = false;
  let completed = false;
  let pinned = true;
  let index = 0;
  const onInteract = () => { pinned = false; };
  const stream = el.stream;
  stream.addEventListener('wheel', onInteract, { passive: true });
  stream.addEventListener('touchmove', onInteract, { passive: true });
  stream.addEventListener('keydown', onInteract);
  const current = () => generation === threadGeneration
    && threadSessionId === sessionId
    && S.thread === t
    && t.isConnected !== false;
  const settle = () => {
    if (settled) return;
    settled = true;
    stream.removeEventListener('wheel', onInteract);
    stream.removeEventListener('touchmove', onInteract);
    stream.removeEventListener('keydown', onInteract);
    if (classicMount === state) classicMount = null;
    resolve();
  };
  /* 实时事件先到这里：把剩余历史一次性补齐并收尾，再让实时节点追加到末尾。
   * 这一条同步路径只在挂载窗口内真的来了实时事件时执行。 */
  const complete = () => {
    if (completed || !current()) return;
    completed = true;
    while (index < items.length && current()) {
      renderItem(items[index], index);
      index += 1;
    }
    if (!current()) return;
    flushHistoryTurn();
    if (frag.childNodes.length) t.appendChild(frag);
    if (pinned) stream.scrollTop = 1e9;
    finishHistoryRender(t, sessionId, generation, { userScrolled: !pinned });
    settle();
  };
  state.flush = complete;

  void (async () => {
    try {
      let chunkSize = HISTORY_CHUNK_NODES;
      while (index < items.length && current() && !completed) {
        while (index < items.length && frag.childNodes.length < chunkSize && current() && !completed) {
          renderItem(items[index], index);
          index += 1;
        }
        if (!current() || completed) break;
        t.appendChild(frag);

        /* 顺序追加不会推动已读内容，只把视口带到当前已挂历史的底部。
         * 用户自己滚动后就交还位置，后续块继续追加在下方，不影响他正在读的那段。 */
        if (pinned) stream.scrollTop = 1e9;

        chunkSize = Math.min(chunkSize * 2, HISTORY_CHUNK_MAX_NODES);
        if (index < items.length && !completed) await yieldToMainThread();
      }
      if (!completed) complete();
    } finally {
      settle();
    }
  })();
}

/* 「历史已经渲染完了」的生命周期事件。
 *
 * 为什么需要它：切会话是**异步**的 —— `afterSessionSwitch()` 只是
 * `setTimeout(boot, 250)`，还要再等 `get_messages` 一个来回，重建才真的发生。
 * 「切过去并跳到某次提问」如果靠 setTimeout(几百毫秒) 猜，在慢机器或大会话上
 * 必然错。所以给一个明确的完成信号，而不是猜时间。
 *
 * 触发点放在**导航重建之后**：那一刻 DOM 与 minimap 都已就绪，滚动定位才有意义。
 * 监听方返回 `true` 表示「这次位置由我决定」，调用方就不再滚到底。
 *
 * 用注册回调而不是 import —— messages.js 不能 import sessions.js / 搜索模块
 * （会成环），而它也不该知道有谁在听。 */
let afterHistoryRendered = null;
export function setAfterHistoryRendered(fn) {
  afterHistoryRendered = typeof fn === 'function' ? fn : null;
}
