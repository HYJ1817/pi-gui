import { iconMarkup } from './ui/icons.js';
/* P32.4-B：中央的「focused conversation」承载。
 *
 * ---------- 它是什么 ----------
 *
 * P32.4-A 让侧栏能列出并行会话并改 focus；这一步把 focus 落到**中央**：点侧栏
 * 一行 → 中央切到那条会话，看到它自己的输出/工具/审批，能发送、停止、重启、关闭。
 *
 * ---------- 为什么不是第二套状态 ----------
 *
 * runtime 真相（text/tools/approvals/owner/lifecycle）一律读 runtime-state.js 里
 * 那**同一份** store，本模块只做投影与动作，不缓存它们。
 *
 * ---------- 视图态必须**按会话**存，不能是模块级单值 ----------
 *
 * `pending` / `notice` / `history` / `pendingHistory` 都是**纯 UI 态**，但它们属于
 * 具体的某条会话。写成模块级单值会出两个真实缺陷：
 *   1) A 的 Stop 还在飞时切到 B，那个 `busy` 会让 **B 的控件被禁用** —— 用户看到
 *      「B 不能操作」，而 B 其实完全可用；
 *   2) A 的迟到响应会写进**当前**会话的 notice / history：切到 B 时，A 的历史会
 *      画到 B 上，A 的错误会显示在 B 的提示条里。
 * 所以这里按 conversationId 保存这些视图态；动作一律在**开始时捕获 target**，
 * 响应回来只写 target 自己的那一格，并且只在「当前看的还是 target」时才重画 DOM。
 *
 * 另外给历史请求记**代次**：同一会话连点两次「打开历史」，先发的后回也不覆盖。
 *
 * ---------- dormant：看历史 vs 恢复 Agent ----------
 *
 * 两条路**分开**：「打开历史」只读后端已证明的 sessionLocator 解析出的正文，
 * **不 spawn**（因此不占 Runtime slot，默认只有 2 个）；「恢复会话」才真的 spawn。
 *
 * 本模块**不发**focus —— focus 是侧栏/组合根的职责（见 runtime-nav.js）。
 *
 * ---------- 执行时间线与只读投影 ----------
 *
 * 本模块读 store 拿生命周期、有界执行时间线（计划/思考/工具/正文）与审批。
 * thinking 的展示上限仍经过 runtime-display.js 的只读投影，usage 也从那里读；
 * 那份投影只订阅 store 已经接受并广播的帧，不可能接受一条 store 拒掉的帧，
 * 也不复制 lifecycle/tools/approvals —— 不构成第二个事实源。
 *
 * 历史接口（`server/session-history.js`）现在返回正文与同一条纯投影生成的有界
 * `execution.timeline`：计划、thinking 可见文本、工具名/状态/耗时、最终回答。
 * 工具原始 args/result、环境变量与凭据不进入历史。旧响应没有 `execution` 时
 * 退回原来的「只含正文」路径，状态行如实说明缺了什么。
 */
import { runtimeSessionAction, fetchRuntimeHistory, runtimeEditPreflight, runtimeEditResend, runtimeEditStatus, runtimeEditRecover } from './api.js';
import { runtimeStore as store, onRuntimeChange, respondToRuntimeApproval, refreshRuntimeViews } from './runtime-state.js';
import { launchRuntimeSession, resourceText, runtimeLimitNotice, refreshRuntimeResources } from './runtime-resources.js';
import { createRuntimeDisplay, shouldFollow } from './runtime-display.js';
import { renderUsageMeta } from './message-meta.js';
import { messageActions } from './ui/message-actions.js';
import { userBody } from './ui/user-message-body.js';
import { openMessageEditor, closeMessageEditor, messageEditErrorText, messageEditRequestId, messageEditorBusy, resolveEditAcceptance, rememberPendingMessageEdit, clearPendingMessageEdit, readPendingMessageEdit, resumePendingMessageEdit, isEditInProgress } from './ui/message-edit.js';
import { openModal, confirmModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import { md, renderVizCardHtml } from './markdown.js';
import { createRuntimePicker } from './runtime-picker.js';
import { bindComposerPointerFocus } from './composer.js';
import { thinkingAvailability } from './thinking-availability.js';
import { startThinkingDotsCycle, stopThinkingDotsCycle, thinkingDots } from './thinking-dots.js';
import { normalizePlan } from './plan-model.js';
import { usageProjection } from './runtime-timeline.js';
import { renderPlan, setPlanStalled, updatePlan } from './plan-view.js';
import { labelFor } from './tool-model.js';
import {
  createGroup,
  addToGroup,
  renderEntry,
  setGroupExpanded,
  isGroupExpanded,
  setEntryExpanded,
  isEntryExpanded,
} from './tool-view.js';
import { getRuntimeExecutionTimeline, resolveRuntimeExecutionMessage } from './execution-timeline-state.js';
import { createExecutionTurnView, executionTurnForInput } from './execution-timeline-view.js';
import { deriveTurnOutcome, renderTurnOutcome, updateTurnOutcome } from './turn-outcome.js';
import { createScrollButton } from './scroll-button.js';
import { findScrollContainer } from './reading-position.js';
import {
  extractStableLocator,
  sameStableLocator,
  runtimeDraftKey,
  saveRuntimeDraft,
  restoreRuntimeDraft,
  clearRuntimeDraft,
  createRuntimeDraftCoordinator,
  DRAFT_MAX_CHARS,
} from './runtime-draft.js';

const VIZ_BLOCK_RE = /(?:^|\n)```pi-gui-viz\r?\n([\s\S]*?)\r?\n```(?=\n|$)/g;

function createVizCardNode(code) {
  const html = renderVizCardHtml(code);
  if (!html) return null;
  const temp = document.createElement('div');
  temp.innerHTML = html;
  return temp.firstElementChild;
}

function appendRuntimeContent(container, text, { isBlock = false } = {}) {
  const appendMarkdown = value => {
    if (!value) return;
    const body = el('div', 'rtc-markdown msg-body');
    body.innerHTML = md(value); // Existing escape-first renderer; never raw model HTML.
    container.append(body);
  };
  VIZ_BLOCK_RE.lastIndex = 0;
  let lastIndex = 0;
  let match;
  let hasCard = false;

  while ((match = VIZ_BLOCK_RE.exec(text)) !== null) {
    const fullMatch = match[0];
    const code = match[1];
    const cardNode = createVizCardNode(code);

    if (cardNode) {
      hasCard = true;
      const beforeText = text.slice(lastIndex, match.index);
      if (beforeText) {
        appendMarkdown(beforeText);
      }
      if (isBlock) {
        const wrap = el('div', 'rtc-output-block');
        wrap.append(cardNode);
        container.append(wrap);
      } else {
        container.append(cardNode);
      }
      lastIndex = match.index + fullMatch.length;
    }
  }

  if (hasCard) {
    const remaining = text.slice(lastIndex);
    if (remaining) {
      appendMarkdown(remaining);
    }
  } else {
    appendMarkdown(text);
  }
}

const LIFECYCLE = { dormant: '已关闭', starting: '启动中', ready: '就绪', error: '错误', disposing: '清理中' };
const ACTIVITY = { idle: '空闲', running: '运行中', stopping: '正在停止' };
/* 历史状态提示与文案映射 */
const HISTORY_NOTE_LEGACY = '历史只含正文（无工具、思考、用量）';
const HISTORY_NOTE_WITH_TOOLS = '历史正文与只读工具摘要；不含思考及用量';
const HISTORY_NOTE_WITH_TIMELINE = '历史按真实记录恢复计划、思考、工具、正文与用量；不含原始参数/输出';
const HISTORY_NOTE_WITH_TIMELINE_NO_USAGE = '历史按真实记录恢复计划、思考、工具与正文；记录中无可显示的用量；不含原始参数/输出';
const HISTORY_NOTE_PLAN_UNKNOWN = '计划按用户消息分组，历史缺少运行边界，归属不确定';
const HISTORY_NOTE_PLAN_MIXED = '部分计划缺少运行边界，归属不确定';
const TOOL_UNAVAILABLE_REASONS = {
  invalid_records: '工具记录格式无法解析',
  unmatched_results: '工具结果关联不完整',
  summary_limit: '工具记录超出摘要预算',
  history_window: '工具记录超出历史保留窗口',
  history_unavailable: '历史记录不可用'
};
const TOOL_HISTORY_STATUS = {
  completed: '已记录完成',
  error: '结果报错',
  unknown: '状态未知'
};

function formatHistoryState(history, owner) {
  const count = Array.isArray(history?.messages) ? history.messages.length : 0;
  const executionTruncated = history?.execution?.truncated === true;
  const truncatedMsg = history?.truncated || executionTruncated ? '（仅显示最近部分）' : '';
  let note = '';
  const hasTimeline = Array.isArray(history?.execution?.timeline) && history.execution.timeline.length > 0;
  if (hasTimeline) {
    const boundary = history?.execution?.planBoundary;
    const boundaryNote = boundary === 'unknown' ? `；${HISTORY_NOTE_PLAN_UNKNOWN}`
      : boundary === 'mixed' ? `；${HISTORY_NOTE_PLAN_MIXED}` : '';
    /* 提示只能描述这次记录里**实际有**的东西：旧记录没有 usage 时
     * 不声称「已恢复用量」，也不补一个 0。 */
    const hasUsage = history.execution.timeline.some(block => block?.usage
      || (Array.isArray(block?.usages) && block.usages.length > 0));
    note = (hasUsage ? HISTORY_NOTE_WITH_TIMELINE : HISTORY_NOTE_WITH_TIMELINE_NO_USAGE)
      + boundaryNote + (executionTruncated ? '；更早的执行记录已截断' : '');
  } else if (!history?.toolSummary) {
    note = HISTORY_NOTE_LEGACY;
  } else {
    const ts = history.toolSummary;
    const badges = [];
    if (ts.truncated) badges.push('仅显示部分工具');
    if (ts.uncertain || (Array.isArray(ts.items) && ts.items.some(i => i.status === 'unknown'))) {
      badges.push('状态证据不完整');
    }
    if (ts.unavailableReason && ts.unavailableReason !== 'no_tool_calls') {
      badges.push(TOOL_UNAVAILABLE_REASONS[ts.unavailableReason] || '工具记录不可用');
    }
    const badgeText = badges.length ? `（${badges.join('，')}）` : '';
    note = `${HISTORY_NOTE_WITH_TOOLS}${badgeText}`;
  }
  const quotaText = owner ? '查看记录不增加运行名额' : '未被启动，不占运行名额';
  return `只读历史 · ${count} 条${truncatedMsg} · ${note} · ${quotaText}`;
}

function createHistoryToolRow(item) {
  const row = el('span', 'rtc-history-tool');
  const toolName = (typeof item?.toolName === 'string' && item.toolName.trim()) ? item.toolName : 'unknown_tool';
  const status = (typeof item?.status === 'string' && TOOL_HISTORY_STATUS[item.status]) ? item.status : 'unknown';
  row.dataset.toolName = toolName;
  row.dataset.status = status;
  row.textContent = `${toolName} · ${TOOL_HISTORY_STATUS[status]}`;
  return row;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
const same = (a, b) => a && b && Object.keys(a).every(k => a[k] === b[k]);
const EMPTY = { pending: false, notice: '', locateNotice: '', history: null, pendingHistory: false, historyToken: 0, draftRestored: false };
const HISTORY_TARGET_TRIMMED = '搜索命中位于已裁剪的只读历史之外，当前仅保留最近内容，无法定位。';
const HISTORY_TARGET_MISSING = '当前只读历史中找不到这次搜索命中的内容（可能已被改写或删除）。';
/* 执行时间线的 DOM 节点与展开状态是**每个会话自己的视图态**。节点缓存让流式
 * 更新只改变化的块；展开状态在切换会话后重建时按会话恢复。 */
const EMPTY_TIMELINE_VIEW = () => ({
  nodes: new Map(),
  outcomeNodes: new Map(),
  settledTurns: new Set(),
  ownerKey: null,
  historyRef: null,
  mode: null,
  thinkingOpen: new Map(),
  groupOpen: new Map(),
  entryOpen: new Map(),
  execution: new Map(),
  executionSource: null,
  provisionalUsage: null,
  recordRef: null,
});

/**
 * 历史消息搜索跳转滚动：严格限定在 output 容器内部，居中对齐目标行，
 * 绝不使用 scrollIntoView，避免连带滚动 .stage、work surface 或 Composer。
 */
export function scrollRowIntoView(output, row, block = 'center') {
  if (!output || !row || typeof output.scrollTop !== 'number') return;
  row.dataset.historyScrolled = 'true';
  const outRect = output.getBoundingClientRect ? output.getBoundingClientRect() : { top: 0, height: output.clientHeight || 0 };
  const rowRect = row.getBoundingClientRect ? row.getBoundingClientRect() : { top: 0, height: row.clientHeight || 0 };
  const relativeTop = rowRect.top - outRect.top;
  let targetScrollTop = output.scrollTop + relativeTop;

  if (block === 'center') {
    const centerOffset = ((outRect.height || output.clientHeight || 0) - (rowRect.height || row.clientHeight || 0)) / 2;
    targetScrollTop -= centerOffset;
  } else if (block === 'end') {
    targetScrollTop -= ((outRect.height || output.clientHeight || 0) - (rowRect.height || row.clientHeight || 0));
  }

  const maxScroll = Math.max(0, (output.scrollHeight || 0) - (output.clientHeight || 0));
  output.scrollTop = Math.max(0, Math.min(maxScroll, targetScrollTop));
}

export function createRuntimeConversation({ host, onNotice = () => {}, onTitle = () => {}, openBrowser = null, openProcesses = null, openSessionChanges = null, models = null, display = null }) {
  const scrollTops = new Map();       // conversationId -> scrollTop
  const views = new Map();            // conversationId -> 该会话自己的纯 UI 态
  const modelOwners = new Map();
  /* thinking / usage 的只读投影。**本视图自己建一份**（和 scrollTops/views 一样是按
   * 会话的视图态），这样每个实例独立 dispose，测试之间也不共享残留记录。 */
  const projection = display || createRuntimeDisplay();
  const ownsProjection = !display;
  let id = null, alive = true, active = false, focusEpoch = 0, approvalKey = '', renderedId = null, renderedHistory = null, renderedLocatorKey = null, renderedUsageKey = '';

  function viewOf(conversationId) {
    let view = views.get(conversationId);
    if (!view) { view = { ...EMPTY, timeline: EMPTY_TIMELINE_VIEW() }; views.set(conversationId, view); }
    return view;
  }
  /* 当前会话的视图态；没有选中会话时给一个不会被写回的占位对象。 */
  const current = () => (id ? viewOf(id) : EMPTY);

  const root = el('div', 'runtime-conversation');
  root.dataset.conversationId = '';
  host.append(root);
  /* store 一变就重画。本模块只**订阅**、不自己 apply —— 各视图各自 apply 会把
   * eventSequence 游标吃两遍，第二个视图就再也看不到那一帧。 */
  const historyStamp = record => JSON.stringify([record?.owner, record?.item?.lifecycle, record?.item?.revision,
    record?.item?.nativeSessionId, record?.item?.workspace, record?.cursor]);
  function invalidateHistory() {
    for (const [target, view] of views) {
      if (!view.history && !view.pendingHistory) continue;
      const record = store.get(target);
      if (record === view.historyRecord && historyStamp(record) === view.historyStamp) continue;
      if (view.historyLocator && !matchesLocator(record?.item, view.historyLocator)) view.notice = '会话历史身份已变化，请重新搜索。';
      view.history = null; view.pendingHistory = false; view.historyToken++;
    }
  }
  const unsubscribe = onRuntimeChange(() => { if (alive) { invalidateHistory(); focusResumed(); ensureModels(); draw(); } });
  /* 标题就地更新（AI 自动标题 / 手动生成）：store 里已经 patch 过，但
   * patchRuntimeTitle 刻意不广播（见 runtime-state.js），所以这里只改标题
   * 文本与顶部标题 —— 不触发整块 draw，更不动滚动位置、草稿和审批状态。 */
  const onTitleEvent = (e) => {
    const detail = e && e.detail;
    if (!alive || !detail || detail.conversationId !== id) return;
    const next = store.get(id)?.item?.title || detail.title;
    if (typeof next !== 'string' || !next || next === title.textContent) return;
    title.textContent = next;
    title.title = next;
    if (active) onTitle(next, store.get(id)?.item?.workspace?.cwd || '');
  };
  document.addEventListener('pi-gui:runtime-title', onTitleEvent);
  function ensureModels() {
    const record = store.get(id);
    if (!active || !models || record?.item.lifecycle !== 'ready' || !record.owner?.sessionId) return;
    const key = JSON.stringify(record.owner);
    if (modelOwners.get(id) === key) return;
    modelOwners.set(id, key);
    void models.refresh(id);
  }
  function focusResumed() {
    const view = current(), record = store.get(id);
    if (!active || !view.focusOnReady || !record?.owner || record.item.lifecycle !== 'ready'
      || typeof record.owner.sessionId !== 'string' || !record.owner.sessionId) return;
    if (record.owner.runtimeId !== view.focusOnReady) return;
    view.focusOnReady = null;
    // A resumed history view has no prior live focus. Bind only the current
    // target, with its ready owner; switching away cancels this intent.
    void runtimeSessionAction({ action: 'focus', owner: { ...record.owner } }).catch(() => {});
  }

  const head = el('div', 'rtc-head');
  const title = el('div', 'rtc-title');
  title.setAttribute('role', 'heading'); title.setAttribute('aria-level', '2');
  const state = el('div', 'rtc-state');
  state.setAttribute('role', 'status');
  /* 状态行 = 动画 + 文本。点组是**稳定子节点**，不能每次 draw 用 textContent
   * 重写整行 —— 那会把动画元素一起删掉，每来一个 delta 动画就从头开始。
   * 形态由点组自己的长节奏交替；切到另一条会话时从开场形态重新开始。 */
  const stateDots = thinkingDots();
  stateDots.hidden = true;
  const stateText = document.createTextNode('');
  state.append(stateDots, stateText);
  const resources = el('div', 'runtime-resource-count'); resources.setAttribute('role', 'status');
  const controls = el('div', 'rtc-controls');
  head.append(title, state, resources, controls); root.append(head);
  const modelRow = el('div', 'rtc-models'); modelRow.hidden = !models;
  const modelLabel = el('div', 'rtc-model-field');
  const modelSelect = el('select'); modelSelect.setAttribute('aria-label', '当前会话模型'); modelLabel.append(modelSelect);
  const thinkingLabel = el('div', 'rtc-model-field');
  const thinkingSelect = el('select'); thinkingSelect.setAttribute('aria-label', '当前会话推理强度'); thinkingLabel.append(thinkingSelect);
  const modelRefresh = el('button', 'btn ghost', '刷新模型'); modelRefresh.type = 'button';
  const modelNotice = el('span', 'rtc-model-notice'); modelNotice.setAttribute('role', 'status');
  modelRow.append(modelLabel, thinkingLabel, modelRefresh, modelNotice); root.append(modelRow);
  modelSelect.onchange = () => { const target = id, choice = modelSelect.value; draw(); if (target && choice) void models?.setModel(target, JSON.parse(choice)); };
  thinkingSelect.onchange = () => { const target = id, level = thinkingSelect.value; draw(); if (target && level) void models?.setThinking(target, level); };
  modelRefresh.onclick = () => { if (id) void models?.refresh(id); };
  const pickerScope = () => JSON.stringify([active, id, focusEpoch, store.get(id)?.owner]);
  const modelPicker = createRuntimePicker({ select: modelSelect, label: '当前会话模型', className: 'rtc-model-trigger', searchable: true, scope: pickerScope, onOpen: () => thinkingPicker.close() });
  const thinkingPicker = createRuntimePicker({ select: thinkingSelect, label: '当前会话推理强度', className: 'rtc-thinking-trigger', scope: pickerScope, onOpen: () => modelPicker.close() });
  modelLabel.append(modelPicker.button); thinkingLabel.append(thinkingPicker.button);

  const notice = el('p', 'rtc-notice'); notice.setAttribute('role', 'status');
  /* 历史搜索定位的独立状态行：与读取/身份错误分开，避免一次定位失败
   * 覆盖掉真正的错误，也避免把「历史已打开」误当成「目标已定位」。 */
  const locateNotice = el('p', 'rtc-notice rtc-history-locate');
  locateNotice.setAttribute('role', 'status');
  root.append(notice, locateNotice);
  /* 类名**故意与 modal 的 `.runtime-output` 不同**：官方 modal 用的是全局选择器
   * （测试也这么取），中央再挂一个同名元素会让 `document.querySelector('.runtime-output')`
   * 命中中央那个（它在 DOM 里更靠前），看起来像「modal 的输出不更新」。
   *
   * 执行过程（用户任务 → 计划 → 思考 → 工具 → 正文）全部进入**同一个**
   * `.rtc-output` 滚动容器，按 store/历史投影的真实 block 顺序渲染。没有
   * 任何「按类别摆位置」的 DOM 重排。 */
  const output = el('div', 'rtc-output');
  output.tabIndex = 0;
  output.setAttribute('aria-label', '当前会话输出');
  /* role=log 表示「持续追加的会话记录」；但这里**不**开 aria-live：
   * Runtime 时间线每个流式 delta 都会重建正文节点，若让容器播报 additions，
   * 读屏会被整段消息反复打断。状态变化继续由局部 role=status/alert 承担。 */
  output.setAttribute('role', 'log');
  output.setAttribute('aria-live', 'off');
  output.setAttribute('aria-relevant', 'additions');
  output.setAttribute('aria-atomic', 'false');
  root.append(output);
  output.addEventListener('scroll', () => { if (id && !current().history) scrollTops.set(id, output.scrollTop); }, { passive: true });

  /* 本轮用量：只显示 Pi 报过的数字（见 runtime-display.js）。刻意**不加** aria-live ——
   * 它每帧都在变，做成 live region 会不停打断读屏。
   * 外面这层只负责占位/显隐，摘要与明细由 message-meta.js 与 Classic 共用。 */
  const usage = el('div', 'ui2-runtime-usage'); usage.hidden = true; root.append(usage);

  const approvals = el('div', 'rtc-approvals'); root.append(approvals);
  let composing = false;
  const input = el('textarea'); input.rows = 3; input.maxLength = 256 * 1024; input.setAttribute('aria-label', '给当前会话的任务'); root.append(input);
  bindComposerPointerFocus(input);
  const draftNotice = el('div', 'rtc-draft-notice'); draftNotice.hidden = true; root.append(draftNotice);

  function updateDraftNotice(statusObj) {
    if (!statusObj || statusObj.status === 'saved' || statusObj.status === 'empty' || statusObj.status === 'unbound') {
      draftNotice.hidden = true; draftNotice.textContent = '';
    } else if (statusObj.status === 'exceeded' || statusObj.status === 'memory_only') {
      draftNotice.hidden = false; draftNotice.textContent = statusObj.notice || '';
    }
  }

  const draftCoordinator = createRuntimeDraftCoordinator({
    onStatus: (key, statusObj) => {
      const currentLoc = id ? extractStableLocator(store.get(id)?.item, store.get(id)?.owner) : null;
      const currentK = runtimeDraftKey(currentLoc);
      if (currentK === key) updateDraftNotice(statusObj);
    },
  });

  function flushCurrentDraft(targetId = id) {
    if (!targetId) return;
    const r = store.get(targetId);
    if (!r) return;
    const loc = extractStableLocator(r.item, r.owner);
    const key = runtimeDraftKey(loc);
    const text = (targetId === id) ? input.value : (r.draft || '');
    if (targetId === id) r.draft = text;
    const res = draftCoordinator.flush();
    if (!res && key) saveRuntimeDraft(key, text);
  }

  function maybeRestoreDraft(targetId) {
    if (!targetId) return;
    const view = viewOf(targetId);
    if (view.draftRestored) return;
    view.draftRestored = true;
    const r = store.get(targetId);
    if (!r || r.draft) return;
    const loc = extractStableLocator(r.item, r.owner);
    const key = runtimeDraftKey(loc);
    if (!key) return;
    const saved = restoreRuntimeDraft(key);
    if (saved && !r.draft) {
      r.draft = saved;
      if (targetId === id && !input.value) input.value = saved;
    }
  }

  const unloadHandler = () => { flushCurrentDraft(id); };
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeunload', unloadHandler);
  }

  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  input.oninput = () => {
    const r = store.get(id);
    if (r && !current().history) {
      r.draft = input.value;
      r.draftRevision++;
      const loc = extractStableLocator(r.item, r.owner);
      const key = runtimeDraftKey(loc);
      if (key) {
        if (!input.value.trim()) {
          draftCoordinator.cancel();
          clearRuntimeDraft(key);
          draftNotice.hidden = true; draftNotice.textContent = '';
        } else {
          draftCoordinator.schedule(key, input.value);
          if (input.value.length > DRAFT_MAX_CHARS) {
            updateDraftNotice({ status: 'exceeded', notice: '草稿超过本地恢复上限，请复制保存完整文本' });
          } else if (draftNotice.textContent.includes('超过本地恢复上限')) {
            draftNotice.hidden = true; draftNotice.textContent = '';
          }
        }
      } else {
        draftNotice.hidden = true;
      }
    }
  };
  input.onkeydown = event => {
    if (event.isComposing || event.keyCode === 229 || composing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault(); if (!send.disabled) send.click();
    }
  };

  const send = el('button', 'btn primary', '发送'); send.type = 'button';
  const stop = el('button', 'btn ghost', '停止'); stop.type = 'button';
  send.classList.add('rtc-send'); send.setAttribute('aria-label', '发送消息'); send.title = '发送消息';
  stop.classList.add('rtc-stop'); stop.setAttribute('aria-label', '停止当前会话'); stop.title = '停止当前会话';
  send.innerHTML = iconMarkup('arrowUp') + '<span>发送</span>';
  stop.innerHTML = iconMarkup('stop') + '<span>停止</span>';
  const restart = el('button', 'btn ghost', '重启'); restart.type = 'button';
  const end = el('button', 'btn ghost', '关闭会话'); end.type = 'button';
  const resume = el('button', 'btn ghost', '恢复会话'); resume.type = 'button';
  const historyBtn = el('button', 'btn ghost', '打开历史'); historyBtn.type = 'button';
  const liveBtn = el('button', 'btn ghost', '返回实时会话'); liveBtn.type = 'button';
  liveBtn.onclick = () => { if (id) { current().history = null; draw(); } };
  controls.append(restart, end, resume, historyBtn, liveBtn);
  const composer = el('div', 'rtc-composer ds-composer-field');
  const composerBar = el('div', 'rtc-composer-bar');
  const composerActions = el('div', 'rtc-composer-actions');
  const composerNote = el('div', 'rtc-composer-note', 'Enter 发送 · Shift+Enter 换行');
  composerActions.append(stop, send); composerBar.append(modelRow, composerActions);
  composer.append(input, composerBar, modelNotice, draftNotice, composerNote); root.append(composer);
  /* 只绑 .rtc-output。按钮放在 composer 内（绝对定位到它上方），因此不会
   * 挡住发送键，也不会因为输出区滚动而移动。 */
  /* 运行态回调必须和 draw 共用同一个判据。只靠 draw 里显式 setRunning 不够：
   * 按钮自己的 sync() 会在 MutationObserver / scroll / resize 后再次调用
   * running()，默认的 false 会把刚点亮的四点动画又关掉。 */
  const scrollButton = createScrollButton({
    host: composer,
    scroller: output,
    running: () => showsWorkingDots(store.get(id)?.item, store.get(id), current()),
    label: '回到最新输出',
  });
  const browserBtn = el('button', 'btn ghost', 'Browser'), processBtn = el('button', 'btn ghost', '开发进程');
  browserBtn.type = processBtn.type = 'button';
  browserBtn.hidden = !openBrowser || !window.piGuiDesktop?.runtimeBrowser;
  processBtn.hidden = !openProcesses;
  browserBtn.onclick = () => openBrowser?.(); processBtn.onclick = () => openProcesses?.();
  controls.append(browserBtn, processBtn);
  if(openSessionChanges){
    const more=el('button','btn ghost','更多');more.type='button';more.id='runtimeSessionMore';
    more.onclick=()=>openModal((card,close)=>{
      card.append(el('h3','','会话操作'));
      const entry=el('button','modal-item','本会话变更');entry.type='button';
      entry.onclick=()=>{close();openSessionChanges();};card.append(entry);
    });controls.append(more);
  }

  send.onclick = () => {
    const target = id;
    flushCurrentDraft(target);
    const r = store.get(target), text = input.value.trim();
    if (!target || !r?.owner || !text || current().pending || r.item.activity !== 'idle') return;
    viewOf(target).history = null;        // 一旦真的要发，就回到实时视图
    const owner = { ...r.owner };
    const draft = input.value, draftRevision = r.draftRevision;
    const loc = extractStableLocator(r.item, owner);
    const draftKey = runtimeDraftKey(loc);
    void action(target, { action: 'command', owner, command: { type: 'prompt', message: text } }, (result) => {
      const still = store.get(target);
      const stillLoc = extractStableLocator(still?.item, still?.owner);
      const locatorMatched = (!loc && !stillLoc) || (loc && stillLoc && sameStableLocator(loc, stillLoc));
      // An acknowledgement owns the submitted version, not later user edits.
      if (result.ok && same(still?.owner, owner) && locatorMatched && still.draftRevision === draftRevision && still.draft === draft) {
        still.draft = ''; still.draftRevision++;
        if (id === target && input.value === draft) {
          input.value = '';
          draftNotice.hidden = true;
        }
        if (draftKey) clearRuntimeDraft(draftKey, draft);
      }
    });
  };
  stop.onclick = () => owned('command', { command: { type: 'abort' } });
  restart.onclick = () => owned('restart');
  end.onclick = () => owned('close');
  resume.onclick = () => {
    const target = id;
    const selection = focusEpoch;
    if (!target || current().pending) return;
    void action(target, { action: 'resume', conversationId: target }, result => {
      if (result.ok) {
        const view = viewOf(target);
        view.history = null; view.pendingHistory = false; view.historyToken++;
        if (active && id === target && selection === focusEpoch) { viewOf(target).focusOnReady = result.owner?.runtimeId || null; focusResumed(); }
      }
    });
  };
  historyBtn.onclick = () => { void loadHistory(); };

  /** 发一个动作。target 在**开始时捕获**，响应只写 target 自己的视图态。 */
  async function action(target, payload, after) {
    const view = viewOf(target);
    const selection = focusEpoch;
    if (view.pending || !alive) return null;
    view.pending = true; if (id === target) draw();
    try {
      const result = await (payload.action === 'resume' ? launchRuntimeSession(payload) : runtimeSessionAction(payload));
      if (!alive) return result;
      if (payload.command?.type === 'extension_ui_response') {
        const currentOwner = store.get(target)?.owner;
        if (!same(currentOwner, payload.owner) || !same(payload.owner, currentOwner)) return null;
      }
      /* 迟到响应只更新 **target** 那一格：切到别的会话时既不改当前 DOM，
       * 也不改当前会话的 notice —— 切回去才看得到它自己的结果。 */
      view.notice = result.cancelled ? '' : runtimeLimitNotice(result) || (result.ok === false ? `${result.error || '操作未完成'}${result.code ? ' (' + result.code + ')' : ''}` : '');
      after?.(result);
      if (payload.action === 'restart' && result.ok && active && id === target && selection === focusEpoch) {
        view.focusOnReady = result.owner?.runtimeId || null; focusResumed();
      }
      if (payload.action === 'close' || payload.action === 'restart') await refreshRuntimeResources();
      return result;
    } finally {
      view.pending = false;
      if (alive && id === target) draw();
    }
  }
  /* 每个动作都把 **captured owner** 随请求带走：执行结束时再读「当前 focused」
   * 会把 A 的停止/重启打到 B 上。 */
  function owned(name, extra = {}) { const target = id, r = store.get(target); if (target && r?.owner) void action(target, { action: name, owner: { ...r.owner }, ...extra }); }

  /** 只读历史：不 spawn，不占 Runtime slot。请求归属、缓存键、结果归属都用 captured target。 */
  async function loadHistory(expectedLocator = null, match = null) {
    const target = id;
    if (!target) return;
    const view = viewOf(target);
    if (view.pendingHistory) return;
    if (expectedLocator) view.history = null;
    view.locateNotice = '';
    const record = store.get(target), stamp = historyStamp(record);
    view.historyRecord = record; view.historyStamp = stamp;
    view.historyLocator = expectedLocator && { ...expectedLocator };
    const token = ++view.historyToken;
    view.pendingHistory = true; if (id === target) draw();
    try {
      const result = await fetchRuntimeHistory(target);
      /* 代次对不上（同一会话又发了一次）或已销毁 → 丢弃这个响应。 */
      if (!alive || view.historyToken !== token || store.get(target) !== record || historyStamp(record) !== stamp) return;
      if (expectedLocator && (!matchesLocator(store.get(target)?.item, expectedLocator)
        || !result.locator || Object.keys(expectedLocator).some(key => result.locator[key] !== expectedLocator[key]))) {
        view.history = null; view.notice = '会话历史身份已变化，请重新搜索。'; return;
      }
      if (result?.ok === false) {
        view.notice = result.code === 'history_unavailable' ? '这条会话没有可读的历史（原生记录已失效），只能新建会话。' : '读取历史失败。';
        return;
      }
      const payload = { messages: result.messages || [], truncated: result.truncated === true,
        toolSummary: result.toolSummary || null, execution: result.execution || null, match };
      /* 只写 **target** 的历史：中央已经切到别的会话时，B 的 DOM 一个字都不动。 */
      view.history = payload;
    } catch { if (alive && view.historyToken === token) view.notice = '读取历史失败。'; }
    finally {
      if (view.historyToken === token) view.pendingHistory = false;
      if (alive && id === target) draw();
    }
  }

  function statusLine(item) {
    if (!item) return '';
    const life = LIFECYCLE[item.lifecycle] || item.lifecycle;
    const act = item.lifecycle === 'ready' ? (ACTIVITY[item.activity] || item.activity) : '';
    const reason = item.error === 'generation_failed' ? ' · 生成失败，请重试或检查模型' : item.error ? ' · 运行异常' : '';
    if (item.error === 'cleanup_pending') return '清理未完成 · 运行名额仍被占用';
    return `${life}${act ? ' · ' + act : ''}${reason}`;
  }

  /* 只有「真的在执行」才让四点动：空闲、正在停止、报错、待审批、历史视图都停。
   * 判定每次都从 store 现读当前会话，不存模块级开关 —— 切换会话时另一条会话
   * 的状态不会被覆盖，切回来时动画仍由它自己的 activity 决定。 */
  function showsWorkingDots(item, record, view) {
    if (view.history || view.pendingHistory || !item || item.error) return false;
    if (record?.approvals?.length) return false;
    return item.lifecycle === 'starting'
      || (item.lifecycle === 'ready' && item.activity === 'running');
  }

  function setState(text, showDots, immediate = false) {
    const wasHidden = stateDots.hidden;
    stateText.nodeValue = text;
    stateDots.hidden = !showDots;
    if (!showDots) { stopThinkingDotsCycle(stateDots); return; }
    /* 切到另一条会话 / 刚从隐藏恢复：从开场形态重新开始，不接着上一条会话的
     * 进度。同一条会话的普通重画只确保节奏在跑，不重置。 */
    const restart = immediate || wasHidden;
    startThinkingDotsCycle(stateDots, { immediate: restart, restart });
  }

  function saveScroll() { if (id && !current().history) scrollTops.set(id, output.scrollTop); }
  function matchesLocator(item, locator) {
    return item?.conversationId === locator.conversationId && item.nativeSessionId === locator.nativeSessionId
      && ['projectId', 'workspaceId', 'workspaceEpoch'].every(key => item.workspace?.[key] === locator[key]);
  }
  function drawModels(record, view) {
    if (!models) return;
    const data = models.get(id), identity = model => JSON.stringify({ providerId: model.providerId || model.provider, modelId: model.modelId || model.id });
    const selected = data?.model ? identity(data.model) : '';
    const options = [...(data?.models || [])];
    if (data?.model && !options.some(model => identity(model) === selected)) options.unshift(data.model);
    const signature = JSON.stringify(options);
    if (modelSelect.dataset.options !== signature) {
      modelSelect.dataset.options = signature; modelSelect.replaceChildren();
      const empty = el('option', '', '模型暂不可用'); empty.value = ''; modelSelect.append(empty);
      for (const model of options) { const option = el('option', '', `${model.name || model.id || model.modelId} · ${model.providerId || model.provider}`); option.value = identity(model); modelSelect.append(option); }
    }
    modelSelect.value = selected;
    const availability = data?.availability || thinkingAvailability(data || {});
    const levels = availability.levels;
    if (thinkingSelect.dataset.options !== JSON.stringify(levels)) {
      thinkingSelect.dataset.options = JSON.stringify(levels); thinkingSelect.replaceChildren();
      const empty = el('option', '', '暂不可用'); empty.value = ''; thinkingSelect.append(empty);
      for (const level of levels) { const option = el('option', '', level); option.value = level; thinkingSelect.append(option); }
    }
    thinkingSelect.value = levels.includes(data?.thinkingLevel) ? data.thinkingLevel : '';
    thinkingSelect.options[0].textContent = availability.label || '暂不可用';
    thinkingSelect.title = availability.detail;
    const disabled = !record?.owner || record.item.lifecycle !== 'ready' || view.pending || data?.pending || Boolean(view.history);
    modelSelect.disabled = disabled || !options.length;
    thinkingSelect.disabled = disabled || availability.state !== 'ready';
    modelRefresh.disabled = disabled;
    modelNotice.textContent = [data?.notice, availability.detail].filter(Boolean).join(' ');
    modelPicker.sync(); thinkingPicker.sync();
  }

  /* ---------- 执行时间线渲染 ----------
   *
   * block 顺序来自 runtime-store（实时）或 server 的历史投影；本模块只按这个
   * 顺序放节点，不按「计划/思考/工具」类别重新排序。节点按 block.id 缓存，
   * 流式更新只改变化的块；展开状态按会话存，切换回来时恢复。
   */
  const TOOL_STATUS = { running: 'running', waiting: 'running', success: 'success', error: 'error', incomplete: 'incomplete', interrupted: 'interrupted' };
  const LEGACY_STATE = { running: 'running', waiting: 'waiting', success: 'done', error: 'error', incomplete: 'interrupted', interrupted: 'interrupted' };
  const THINKING_LABEL = { streaming: '生成中', returned: '已返回', complete: '已完成', error: '发生错误', interrupted: '已中断' };

  function toolEntryOf(tool) {
    const name = typeof tool?.name === 'string' ? tool.name : '';
    const { label, known } = labelFor(name);
    return {
      id: String(tool?.id || ''),
      name,
      label,
      known,
      summary: '',
      args: null,
      details: null,
      output: '',
      resultLine: '',
      status: TOOL_STATUS[tool?.state] || 'unknown',
      waiting: tool?.waiting === true,
      durationMs: Number.isFinite(tool?.durationMs) ? tool.durationMs : null,
      diffStat: null,
      gitStat: null,
      truncated: null,
    };
  }

  /* 一条 assistant 消息的真实 usage 可能挂在正文、Thinking 或工具组上；
   * 每个 block 只渲染一次，更新时按白名单投影的签名原位替换。 */
  function syncUsageMeta(host, block) {
    const usage = usageProjection(block?.usage);
    const key = usage ? JSON.stringify(usage) : '';
    if (!key) {
      if (host._usageMeta) { host._usageMeta.remove(); host._usageMeta = null; host._usageKey = ''; }
      return;
    }
    if (host._usageMeta && host._usageKey === key) return;
    const fresh = renderUsageMeta(usage, { label: '本条助手消息用量' });
    if (!fresh) {
      if (host._usageMeta) { host._usageMeta.remove(); host._usageMeta = null; host._usageKey = ''; }
      return;
    }
    if (host._usageMeta) host._usageMeta.replaceWith(fresh);
    else host.append(fresh);
    host._usageMeta = fresh;
    host._usageKey = key;
  }

  /* Plan 卡会被同一 turnId 的多条 assistant 消息复用；每条消息的真实 usage
   * 都追加在卡外，按记录顺序各显示一次。旧响应只有单条 `usage` 时按一条处理。 */
  function syncPlanUsages(host, block) {
    const raw = Array.isArray(block?.usages) ? block.usages : (block?.usage ? [block.usage] : []);
    const usages = raw.map(usageProjection).filter(Boolean);
    const key = JSON.stringify(usages);
    if (host._planUsageKey === key) return;
    host._planUsageKey = key;
    if (Array.isArray(host._planUsageMetas)) {
      for (const node of host._planUsageMetas) node.remove();
    }
    host._planUsageMetas = usages
      .map(usage => renderUsageMeta(usage, { label: '本条助手消息用量' }))
      .filter(Boolean);
    for (const meta of host._planUsageMetas) host.append(meta);
  }

  function runtimeOwnerOf(record) {
    return record?.owner && typeof record.owner === 'object' ? { ...record.owner } : null;
  }

  /* 结果未知时的事务恢复：先按原 requestId 向**当前 owner** 读权威状态。
   * accepted 才应用新消息；failed 才释放 UI 里的 pending；其余保持未确认，
   * 不伪造“已发送”或“已恢复”。 */
  async function recoverRuntimeEdit(owner, conversationId, requestId, pending) {
    let status = null;
    try { status = await runtimeEditRecover(owner, requestId); } catch { return null; }
    if (status?.state === 'accepted') {
      clearPendingMessageEdit(requestId);
      if (pending) {
        const text = pending?.editText ?? pending?.target?.text ?? '';
        store.applyUserEdit(conversationId, owner, pending, { text, entryId: status.result?.newEntryId });
      }
      refreshRuntimeViews();
    } else if (status?.state === 'failed' || status?.state === 'recovery_required' || status?.state === 'stale_session') {
      clearPendingMessageEdit(requestId);
      if (pending) store.cancelUserEdit(conversationId, owner, pending);
      if (!pending) refreshRuntimeViews();
    }
    return status;
  }

  function showRuntimeEditRecovery(owner, conversationId, requestId, pending, notify) {
    const sync = async () => {
      const status = await recoverRuntimeEdit(owner, conversationId, requestId, pending);
      if (status?.state === 'accepted') { notify(''); return; }
      if (status?.state === 'failed' || status?.state === 'recovery_required' || status?.state === 'stale_session') {
        notify(messageEditErrorText(status.result?.code || status.state));
        return;
      }
      notify(messageEditErrorText('recovery_pending'));
    };
    toast(messageEditErrorText('acceptance_unknown'), 'error', {
      action: { label: '重新同步', run: sync },
    });
  }

  let resumedEditRequestId = null;
  /* 渲染器刷新后，未解决事务的 requestId 还在 sessionStorage 里。切回目标
   * conversation 时用原 requestId 查一次；仍未解决就显示“重新同步”入口。
   * 作用域不匹配（别的会话、别的 backend 代次）时不动记录。 */
  async function resumeRuntimePendingEdit(conversationId) {
    if (!conversationId) return;
    const record = readPendingMessageEdit({ kind: 'runtime', conversationId });
    if (!record || record.scope?.kind !== 'runtime' || record.scope.conversationId !== conversationId) return;
    const owner = runtimeOwnerOf(store.get(conversationId));
    if (!owner) return;
    const resumed = await resumePendingMessageEdit({
      scope: { kind: 'runtime', conversationId, sessionId: owner.sessionId, backendInstance: owner.backendInstance },
      status: requestId => runtimeEditStatus(owner, requestId),
      onSettled: () => refreshRuntimeViews(),
    });
    if (!resumed || !['acceptance_unknown', 'recovery_pending'].includes(resumed.state)) return;
    if (resumedEditRequestId === record.requestId) return;
    resumedEditRequestId = record.requestId;
    const notify = text => {
      const target = viewOf(conversationId);
      if (!target) return;
      target.notice = text || '';
      draw();
    };
    showRuntimeEditRecovery(owner, conversationId, record.requestId, null, notify);
  }

  function openRuntimeUserEdit(row, block, record, notify) {
    const owner = runtimeOwnerOf(record);
    if (!owner || !Number.isInteger(block.userIndex)) return null;
    const conversationId = record.item.conversationId;
    const textEl = row.querySelector('.rtc-history-user-text');
    const actions = row.querySelector('.message-actions');
    let pendingRef = null;
    return openMessageEditor({
      text: block.text,
      userIndex: block.userIndex,
      hasImages: block.hasImages === true,
      /* Runtime 时间线不投影图片，文本也可能被截断；身份仍由首次 preflight
       * 的 entryId/parentId/leafId/sessionId 锁定，这里只放宽文本/图片的
       * 前端交叉核对，不放宽事务目标。 */
      imageStateKnown: false,
      textTruncated: block.truncated === true,
      kind: 'edit',
      mount: row,
      originals: [textEl, actions].filter(Boolean),
      returnFocus: actions?.querySelector('.message-edit'),
      pendingScope: { kind: 'runtime', conversationId, backendInstance: owner.backendInstance },
      preflight: ({ userIndex, kind }) => runtimeEditPreflight(owner, { userIndex, kind }),
      resend: async payload => {
        const pending = store.beginUserEdit(conversationId, owner, block.userIndex);
        if (!pending) return { ok: false, code: 'stale_history' };
        pending.editText = payload.text;
        pendingRef = pending;
        let result;
        try { result = await runtimeEditResend(owner, payload); }
        catch { result = { ok: false, code: 'network', network: true }; }
        /* 传输失败不等于事务失败：按 requestId 读权威状态，避免双发。 */
        if (!result?.ok && (result?.network === true || result?.code === 'network')) {
          const resolved = await resolveEditAcceptance(id => runtimeEditStatus(owner, id), payload.requestId);
          result = resolved || { ok: false, code: 'acceptance_unknown' };
        }
        if (!result?.ok) {
          /* 未确认时保留 pending：迟到的 message_start 仍应就地更新目标，
           * 而不是再追加一条用户消息。 */
          if (!result?.unresolved) store.cancelUserEdit(conversationId, owner, pending);
          return result;
        }
        const acceptedText = typeof result.text === 'string' ? result.text : payload.text;
        store.applyUserEdit(conversationId, owner, pending, { text: acceptedText, entryId: result.newEntryId });
        refreshRuntimeViews();
        return result;
      },
      readStatus: requestId => runtimeEditStatus(owner, requestId),
      recover: requestId => recoverRuntimeEdit(owner, conversationId, requestId, pendingRef),
    });
  }

  async function regenerateRuntimeTurn(button, userIndex, record, notify) {
    const owner = runtimeOwnerOf(record);
    if (!owner || !Number.isInteger(userIndex) || button?.disabled) return;
    if (messageEditorBusy()) { notify('请先完成当前的编辑操作。'); return; }
    /* 同一时刻只允许一个编辑事务：先收起已打开的就地编辑器。 */
    closeMessageEditor({ restore: true, focus: false });
    const conversationId = record.item.conversationId;
    /* 点击时这一轮对应的用户 block；preflight 必须指向同一条消息。 */
    const target = Array.isArray(record?.timeline)
      ? record.timeline.find(block => block?.kind === 'user' && block.userIndex === userIndex)
      : null;
    if (!target) { notify(messageEditErrorText('stale_history')); return; }
    if (button) button.disabled = true;
    try {
      const pre = await runtimeEditPreflight(owner, { userIndex, kind: 'regenerate' });
      const busy = isEditInProgress(pre);
      if (!pre?.ok || busy) {
        if (busy) {
          const pendingRecord = readPendingMessageEdit({ kind: 'runtime', conversationId });
          if (pendingRecord && pendingRecord.scope?.kind === 'runtime'
            && pendingRecord.scope.conversationId === conversationId) {
            showRuntimeEditRecovery(owner, conversationId, pendingRecord.requestId, null, notify);
            return;
          }
          notify(messageEditErrorText('edit_in_progress'));
          return;
        }
        notify(messageEditErrorText(pre?.code)); return;
      }
      if (pre.canEdit !== true) { notify(messageEditErrorText(pre.reason)); return; }
      const textOk = target.truncated === true
        ? typeof pre.text === 'string' && pre.text.startsWith(target.text)
        : pre.text === target.text;
      if (!textOk) { notify(messageEditErrorText('stale_history')); return; }
      if (pre.hasToolsAfter === true) {
        const confirmed = await confirmModal({
          title: '重新生成',
          message: '重新发送会替换后续对话，之前已经执行的文件修改和命令操作不会自动撤销。',
          okText: '重新生成',
          cancelText: '取消',
        });
        if (confirmed !== true) return;
      }
      const pending = store.beginUserEdit(conversationId, owner, userIndex);
      if (!pending) { notify(messageEditErrorText('stale_history')); return; }
      pending.editText = target.text;
      const requestId = messageEditRequestId();
      rememberPendingMessageEdit({
        requestId,
        text: target.text,
        userIndex,
        kind: 'regenerate',
        scope: { kind: 'runtime', conversationId, sessionId: pre.sessionId, backendInstance: owner.backendInstance },
        at: Date.now(),
      });
      let result;
      try {
        result = await runtimeEditResend(owner, {
          userIndex,
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
        const resolved = await resolveEditAcceptance(id => runtimeEditStatus(owner, id), requestId);
        result = resolved || { ok: false, code: 'acceptance_unknown' };
      }
      if (!result?.ok) {
        if (!result?.unresolved) {
          clearPendingMessageEdit(requestId);
          store.cancelUserEdit(conversationId, owner, pending);
        }
        if (result?.unresolved || result?.code === 'acceptance_unknown' || result?.code === 'recovery_pending') {
          showRuntimeEditRecovery(owner, conversationId, requestId, pending, notify);
        } else {
          notify(messageEditErrorText(result?.code));
        }
        return;
      }
      clearPendingMessageEdit(requestId);
      const acceptedText = typeof result.text === 'string' ? result.text : pre.text;
      store.applyUserEdit(conversationId, owner, pending, { text: acceptedText, entryId: result.newEntryId });
      notify('');
      refreshRuntimeViews();
    } catch {
      notify(messageEditErrorText('network'));
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }

  function createTimelineBlockNode(block, view, record, history, options = {}) {
    /* 展开状态按「模式 + block/tool id」存：历史与实时各有一份，互不覆盖；
     * 切换会话、切换模式后都能恢复用户自己的选择。 */
    const openKey = key => (history ? 'history:' : 'live:') + key;
    if (block.kind === 'user' || block.kind === 'assistant') {
      const row = el('div', 'rtc-history-message rtc-timeline-message');
      row.dataset.role = block.kind === 'user' ? 'user' : 'assistant';
      row.setAttribute('aria-label', block.kind === 'user' ? '你' : '助手');
      row.dataset.roleLabel = block.kind === 'user' ? '你' : 'Pi';
      if (block.kind === 'user') {
        const textBody = el('div', 'rtc-history-user-text', block.text);
        const missingAttachment = el('div', 'msg-att-chips', '附件暂不可恢复');
        missingAttachment.hidden = true;
        row.append(textBody, missingAttachment);
        const editAction = history || !Number.isInteger(block.userIndex)
          ? null
          : () => openRuntimeUserEdit(row, block, record, options.notify);
        let actionBar = messageActions(block.text, editAction ? { onEdit: editAction } : {});
        row.append(actionBar);
        if (block.messageId) row.dataset.historyMessageId = block.messageId;
        if (Number.isInteger(block.userIndex)) row.dataset.historyUserIndex = String(block.userIndex);
        let contentKey = '';
        let actionText = block.text;
        const updateActions = value => {
          if (actionText === value) return;
          actionText = value;
          const fresh = messageActions(value, editAction ? { onEdit: editAction } : {});
          actionBar.replaceWith(fresh);
          actionBar = fresh;
        };
        return {
          node: row,
          update(next) {
            contentKey = '';
            if (history) {
              textBody.textContent = next.text;
              updateActions(next.text);
            }
          },
          updateInput(snapshot, input) {
            const ref = input?.content;
            const proof = store.executionWitness(record, block);
            const key = JSON.stringify([ref?.id, ref?.state, proof?.contentSequence, block.hasImages === true]);
            if (key === contentKey) return;
            contentKey = key;
            const resolved = ref?.state === 'available' ? resolveRuntimeExecutionMessage(snapshot?.scope, ref) : null;
            if (resolved) {
              const body = userBody(resolved);
              textBody.replaceChildren(...body.childNodes);
              updateActions(resolved.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
            } else {
              textBody.textContent = block.text;
              updateActions(block.text);
            }
            missingAttachment.hidden = Boolean(resolved) || !input?.attachments?.length && !block.hasImages;
          },
        };
      }
      const body = el('div', 'rtc-assistant-text');
      appendRuntimeContent(body, block.text);
      row.append(body);
      if (block.messageId) row.dataset.historyMessageId = block.messageId;
      row.dataset.state = block.state || '';
      let actionBar = null;
      /* 历史 usage 与 Classic 同一条摘要/明细；同一消息的多段正文不会重复
       * 出现同一份用量（投影只把 usage 挂到该消息的一个 block 上）。 */
      const syncMeta = next => syncUsageMeta(row, next);
      syncMeta(block);
      /* 正文文本本身就是 output.textContent 的主体：角色标签用 CSS 伪元素，
       * 不额外插入文本节点，避免把「助手」混进正文复制/断言。 */
      return { node: row, update(next, regenerateUserIndex) {
        body.replaceChildren();
        appendRuntimeContent(body, next.text);
        row.dataset.state = next.state || '';
        if (!history && Number.isInteger(regenerateUserIndex)) {
          const fresh = messageActions(next.text, { onRegenerate: event =>
            regenerateRuntimeTurn(event.currentTarget, regenerateUserIndex, record, options.notify) });
          if (actionBar) actionBar.replaceWith(fresh);
          else row.append(fresh);
          actionBar = fresh;
        } else if (actionBar) {
          actionBar.remove();
          actionBar = null;
        }
        syncMeta(next);
      } };
    }

    if (block.kind === 'thinking') {
      /* 只有带真实历史 usage 的 Thinking 才包一层，用来在折叠区外显示用量；
       * 实时 Thinking 的 DOM 保持原来的 details 直接子节点，不改变动画/滚动。 */
      const wrap = block.usage ? el('div', 'ui2-runtime-thinking-wrap') : null;
      const details = el('details', 'ui2-runtime-thinking');
      const head = el('summary', 'ui2-runtime-thinking-head');
      const body = el('pre', 'ui2-runtime-thinking-body');
      details.append(head, body);
      wrap?.append(details);
      details.open = view.timeline.thinkingOpen.get(openKey(block.id)) === true;
      details.addEventListener('toggle', () => { view.timeline.thinkingOpen.set(openKey(block.id), details.open); });
      head.addEventListener('click', () => {
        const scroller = findScrollContainer(head);
        if (!scroller || typeof scroller.scrollTop !== 'number') return;
        const initialScrollTop = scroller.scrollTop;
        const initialOffset = head.getBoundingClientRect ? head.getBoundingClientRect().top - scroller.getBoundingClientRect().top : 0;
        const wasPinned = (scroller.scrollHeight || 0) - initialScrollTop - (scroller.clientHeight || 0) <= 24;
        requestAnimationFrame(() => {
          if (scroller.scrollTop !== initialScrollTop) return;
          const maxScroll = Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0));
          if (wasPinned) {
            scroller.scrollTop = maxScroll;
            return;
          }
          if (head.getBoundingClientRect && scroller.getBoundingClientRect) {
            const newOffset = head.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
            const delta = newOffset - initialOffset;
            if (Math.abs(delta) > 0.5) {
              scroller.scrollTop = Math.max(0, Math.min(maxScroll, initialScrollTop + delta));
            }
          }
        });
      });
      if (wrap) syncUsageMeta(wrap, block);
      return {
        node: wrap || details,
        update(next) {
          /* 当前 assistant 消息的思考仍经过展示投影的 maxThinkingBytes 上限；
           * 更早的消息已由 store / 历史投影各自按 64KiB 有界，不再二次裁剪。 */
          const viewed = record && record.thinkingBlock === next ? projection.thinkingOf(id) : null;
          const text = viewed ? viewed.text : next.text;
          const state = viewed ? viewed.state : next.state;
          const truncated = viewed ? viewed.truncated : next.truncated === true;
          const stateLabel = THINKING_LABEL[state] || '';
          details.dataset.state = state || '';
          body.textContent = text;
          head.textContent = `思考过程 · ${text.length} 字${truncated ? '（已截断）' : ''}${stateLabel ? ' · ' + stateLabel : ''}`;
          if (wrap) syncUsageMeta(wrap, next);
        },
      };
    }

    if (block.kind === 'tools') {
      const wrapper = el('div', 'ui2-runtime-tools');
      let group = null;
      let signature = '';
      return {
        node: wrapper,
        update(next) {
          const nextSignature = JSON.stringify(next.tools);
          if (nextSignature !== signature) {
            signature = nextSignature;
            wrapper.replaceChildren();
            wrapper._usageMeta = null;
            wrapper._usageKey = '';
            group = createGroup();
            group.dataset.blockId = next.id;
            wrapper.append(group);
            for (const tool of next.tools) {
              const entry = toolEntryOf(tool);
              const node = renderEntry(entry);
              node.classList.add('ui2-runtime-tool');
              node.dataset.state = LEGACY_STATE[tool.state] || String(tool.state || 'unknown');
              node.dataset.toolName = entry.name;
              /* tool-view 的头/按钮自己处理折叠；这里在捕获阶段记录点击后的状态。 */
              node.addEventListener('click', () => setTimeout(() => {
                view.timeline.entryOpen.set(openKey(tool.id), isEntryExpanded(node));
              }, 0), true);
              if (view.timeline.entryOpen.get(openKey(tool.id)) === true) setEntryExpanded(node, true);
              addToGroup(group, node);
            }
            group.addEventListener('click', event => {
              if (!event.target?.closest?.('.tl-group-head')) return;
              view.timeline.groupOpen.set(openKey(next.id), isGroupExpanded(group));
            });
            /* 只有用户真的点过组头才恢复展开；否则交给 tool-view 的默认规则：
             * 多项自动折叠、单项不摆组头。不能把「单项时列表可见」误判成
             * 用户展开过，否则第二个工具一到就永远展开。 */
            if (view.timeline.groupOpen.has(openKey(next.id))) setGroupExpanded(group, view.timeline.groupOpen.get(openKey(next.id)));
          }
          syncUsageMeta(wrapper, next);
        },
      };
    }

    if (block.kind === 'plan') {
      const host = el('div', 'ui2-runtime-plan');
      let card = null;
      let signature = '';
      return {
        node: host,
        update(next) {
          const plan = normalizePlan(next.plan);
          if (!plan) {
            host.replaceChildren();
            host.hidden = true;
            host._planUsageMetas = null;
            host._planUsageKey = '';
            return;
          }
          host.hidden = false;
          if (!card) { card = renderPlan(plan); host.append(card); }
          const nextSignature = JSON.stringify([plan.tasks, plan.explanation, plan.completed, plan.total]);
          if (nextSignature !== signature) { signature = nextSignature; updatePlan(card, plan); }
          const activeRun = record?.item?.lifecycle === 'starting'
            || (record?.item?.lifecycle === 'ready' && (record.item.activity === 'running' || (record?.approvals?.length || 0) > 0));
          /* 旧回合的计划不再呼吸；当前回合按真实运行态决定。 */
          const currentPlan = record?.planBlock?.id === next.id;
          setPlanStalled(card, !currentPlan || !activeRun);
          /* plan-only 消息的真实 usage 挂在计划 block 上；放在卡片外层，
           * 折叠计划列表不会把用量一起藏掉。 */
          syncPlanUsages(host, next);
        },
      };
    }
    return null;
  }

  /* 从有界 block 派生轮次终态。只读视图需要的证据，不改 timeline 契约：
   * assistant/thinking 取最后一个终态；工具错误只计失败数，不把整轮判失败。 */
  function timelineTurnOutcomes(blocks, record, supplemental) {
    const turns = [];
    let current = null;
    let blockIndex = -1;
    for (const block of blocks) {
      if (!block || typeof block.id !== 'string') continue;
      blockIndex += 1;
      if (block.kind === 'user' && !supplemental.has(block)) {
        if (current) turns.push(current);
        current = {
          key: block.id,
          lastBlockId: block.id,
          lastContentState: null,
          lastContentIndex: -1,
          lastInterruptedToolIndex: -1,
          lastToolIndex: -1,
          tools: [],
          hasEvidence: false,
        };
        continue;
      }
      if (!current) continue;
      current.lastBlockId = block.id;
      if (block.kind === 'tools') {
        const tools = Array.isArray(block.tools) ? block.tools : [];
        if (tools.length) {
          current.tools.push(...tools);
          current.hasEvidence = true;
          current.lastToolIndex = blockIndex;
          if (tools.some(tool => tool?.state === 'interrupted')) {
            current.lastInterruptedToolIndex = blockIndex;
          }
        }
      } else if (block.kind === 'assistant' || block.kind === 'thinking') {
        current.lastContentState = block.state || null;
        current.lastContentIndex = blockIndex;
        current.hasEvidence = true;
      }
    }
    if (current) turns.push(current);
    const settled = record?.settled === true;
    return turns.map((turn, index) => {
      const isLast = index === turns.length - 1;
      /* 内容为空的失败消息不会产生 assistant block；runtime item 的
       * generation_failed 是本轮最后一次生成的明确证据。 */
      const sessionError = isLast && record?.item?.error === 'generation_failed';
      if (!turn.hasEvidence && !sessionError) return null;
      const lastAssistant = turn.lastContentState ? {
        failed: turn.lastContentState === 'error',
        interrupted: turn.lastContentState === 'interrupted',
        stopped: false,
      } : sessionError ? { failed: true, interrupted: false, stopped: false } : null;
      const outcome = deriveTurnOutcome({
        tools: turn.tools,
        lastAssistant,
        contentUnsettled: turn.lastContentState === 'streaming',
        /* 中断工具只有在最后一次成功内容之后、且是最后一个工具块时才是
         * 轮次终态；更早的中断被后续回答/工具覆盖，不能误报为“已停止”。 */
        interruptedToolTerminal: turn.lastInterruptedToolIndex >= 0
          && turn.lastInterruptedToolIndex === turn.lastToolIndex
          && turn.lastInterruptedToolIndex > turn.lastContentIndex,
      });
      if (!outcome) return null;
      return { key: turn.key, lastBlockId: turn.lastBlockId, outcome, complete: !isLast || settled };
    }).filter(Boolean);
  }

  function clearExecutionViews(timeline) {
    for (const execution of timeline.execution.values()) execution.release();
    timeline.execution.clear();
    timeline.executionSource = null;
    timeline.provisionalUsage = null;
  }

  function executionSource(timeline, record) {
    const meta = record?.item?.execution;
    let source = timeline.executionSource;
    // Text/thinking deltas update the original nodes. Execution and ledger
    // semantics only need a new snapshot at an accepted structural boundary.
    if (source?.owner === record?.owner && source?.revision === record?.executionRevision
        && source?.branchEpoch === meta?.branchEpoch && source?.startSequence === meta?.startSequence) return source;
    const snapshot = getRuntimeExecutionTimeline(record?.owner);
    const groups = new Map();
    const items = new Map();
    for (const group of snapshot?.groups || []) groups.set(group.turnId, group);
    for (const item of snapshot?.items || []) {
      if (!items.has(item.turnId)) items.set(item.turnId, []);
      items.get(item.turnId).push(item);
    }
    source = { owner: record?.owner, revision: record?.executionRevision,
      branchEpoch: meta?.branchEpoch, startSequence: meta?.startSequence, snapshot, groups, items };
    timeline.executionSource = source;
    return source;
  }

  function composeExecutionRows(rows, timeline, record) {
    const { snapshot, groups, items: itemsByTurn } = executionSource(timeline, record);
    const used = new Set();
    const nodes = [];
    let usageInTimeline = false;
    for (let index = 0; index < rows.length;) {
      const row = rows[index];
      const proof = store.executionWitness(record, row.block);
      const turn = row.block.kind === 'user' && proof?.sequence === proof?.inputSequence
        ? executionTurnForInput(snapshot, proof?.sequence) : null;
      const legacy = ({ info, outcome }) => {
        info.updateInput?.(null, null);
        nodes.push(info.node);
        if (outcome) nodes.push(outcome);
      };
      if (!turn) { legacy(row); index++; continue; }

      let end = index + 1;
      while (end < rows.length && store.executionWitness(record, rows[end].block)?.inputSequence === proof.sequence) end++;
      const members = rows.slice(index, end);
      index = end;
      const group = groups.get(turn.id);
      const items = itemsByTurn.get(turn.id) || [];
      const byStart = new Map(items.map(item => [item.position.sequence, item]));
      const toolsCovered = members.every(({ block }) => block.kind !== 'tools' || block.tools.every(tool => {
        const start = store.executionWitness(record, tool)?.sequence;
        return byStart.get(start)?.callId === tool.id && Number.isSafeInteger(start);
      }));
      const planCovered = !turn.plan || members.some(({ block, info }) => block.kind === 'plan' && !info.node.hidden);
      const inputCount = members.filter(({ block }) => block.kind === 'user').length;
      if (!toolsCovered || !planCovered || inputCount !== turn.additionalInputs.length + 1) {
        members.forEach(legacy);
        continue;
      }

      const answerResponses = new Set(turn.parts.filter(part => part.kind === 'answer' || part.kind === 'partial-answer')
        .map(part => part.message.id));
      const inputsByStart = new Map(turn.additionalInputs.map(input => [input.id, input]));
      const progress = [], thinking = [], answer = [], outcomes = [];
      const fallbackRunning = turn.attempts.some(attempt => attempt.kind === 'fallback' && attempt.status === 'running');
      let plan = null;
      for (const member of members) {
        const { block, info, outcome } = member;
        if (outcome && !fallbackRunning) outcomes.push(outcome);
        const { sequence, responseSequence } = store.executionWitness(record, block);
        if (block.kind === 'user') {
          info.updateInput?.(snapshot, member === row ? turn.input : inputsByStart.get(turn.id + ':input:' + sequence));
          if (member !== row) progress.push(info.node);
        } else if (block.kind === 'plan') {
          if (!info.node.hidden) plan = info.node;
        } else if (block.kind === 'thinking' && block.state === 'streaming') {
          thinking.push(info.node);
        } else if (block.kind === 'assistant' && (answerResponses.has(turn.id + ':response:' + responseSequence)
            || block.state === 'streaming' && responseSequence === record.executionLive.responseSequence)) {
          answer.push(info.node);
        } else if (block.kind !== 'tools') {
          progress.push(info.node);
        }
      }
      let execution = timeline.execution.get(turn.id);
      if (!execution) {
        execution = createExecutionTurnView({ document });
        timeline.execution.set(turn.id, execution);
      }
      const usage = [];
      if (end === rows.length) {
        const currentUsage = projection.usageOf(record.owner.conversationId);
        if (currentUsage?.source === 'message_update') {
          const key = JSON.stringify([record.settled, currentUsage]);
          if (timeline.provisionalUsage?.key !== key) {
            timeline.provisionalUsage = { key, node: renderUsageMeta(currentUsage, {
              source: record.settled ? '' : currentUsage.source,
              label: '最后可用的流式用量',
              prefix: record.settled ? '部分记录 · ' : '',
            }) };
          }
          if (timeline.provisionalUsage.node) usage.push(timeline.provisionalUsage.node);
        } else timeline.provisionalUsage = null;
        usageInTimeline = usage.length > 0 || turn.usage.length > 0;
      }
      execution.update({ turn, group, items, input: row.info.node, plan, progress, thinking, answer, outcomes, usage });
      nodes.push(execution.node);
      used.add(turn.id);
    }
    for (const [key, execution] of timeline.execution) {
      if (!used.has(key)) { execution.release(); timeline.execution.delete(key); }
    }
    return { nodes, usageInTimeline };
  }

  function supplementalInputs(blocks, record, snapshot) {
    const initial = new Set();
    const supplemental = new Set();
    for (const block of blocks) {
      if (block.kind !== 'user') continue;
      const proof = store.executionWitness(record, block);
      if (!proof) continue;
      if (proof.sequence === proof.inputSequence) {
        if (executionTurnForInput(snapshot, proof.sequence)) initial.add(proof.sequence);
      } else if (initial.has(proof.inputSequence)) supplemental.add(block);
    }
    return supplemental;
  }
  function renderTimeline(blocks, view, record, history) {
    if (!view.timeline) view.timeline = EMPTY_TIMELINE_VIEW();
    const mode = history ? 'history' : 'live';
    const ownerKey = record?.owner
      ? `${record.owner.runtimeId || ''}:${record.owner.runtimeGeneration || ''}:${record.owner.sessionId || ''}`
      : 'none';
    const historyChanged = history && view.timeline.historyRef !== view.history;
    const recordChanged = !history && view.timeline.recordRef !== record;
    if (view.timeline.mode !== mode || recordChanged) {
      clearExecutionViews(view.timeline);
      output.replaceChildren();
      view.timeline.nodes.clear();
      view.timeline.outcomeNodes.clear();
      view.timeline.settledTurns.clear();
      view.timeline.mode = mode;
    } else if (view.timeline.ownerKey !== ownerKey || historyChanged) {
      /* 换 runtime / 换一份历史时，旧终态的 block id 可能被复用；
       * 不清掉会把上一代运行的终态误挂到新记录上。 */
      view.timeline.outcomeNodes.clear();
      view.timeline.settledTurns.clear();
    }
    view.timeline.ownerKey = ownerKey;
    view.timeline.recordRef = record;
    view.timeline.historyRef = history ? view.history : null;
    const supplemental = history ? new Set() : supplementalInputs(blocks, record,
      executionSource(view.timeline, record).snapshot);
    const turnOutcomes = timelineTurnOutcomes(blocks, record, supplemental);
    const outcomeByLastBlock = new Map();
    for (const turn of turnOutcomes) outcomeByLastBlock.set(turn.lastBlockId, turn);
    /* 每一轮只在最后一条 assistant 正文上放“重新生成”：它代表该轮回复的
     * 可见终点，点它重跑的是这一轮的用户消息。 */
    const regenerateByBlock = new Map();
    let turnUserIndex = null, turnLastAssistant = null;
    for (const block of blocks) {
      if (block?.kind === 'user' && !supplemental.has(block)) {
        if (turnLastAssistant && Number.isInteger(turnUserIndex)) regenerateByBlock.set(turnLastAssistant.id, turnUserIndex);
        turnUserIndex = Number.isInteger(block.userIndex) ? block.userIndex : null;
        turnLastAssistant = null;
      } else if (block?.kind === 'assistant') {
        turnLastAssistant = block;
      }
    }
    if (turnLastAssistant && Number.isInteger(turnUserIndex)) regenerateByBlock.set(turnLastAssistant.id, turnUserIndex);
    const notify = text => {
      const target = viewOf(record?.item?.conversationId);
      if (!target) return;
      target.notice = text || '';
      draw();
    };
    const rows = [];
    const wanted = new Set();
    for (const block of blocks) {
      if (!block || typeof block.id !== 'string') continue;
      let info = view.timeline.nodes.get(block.id);
      if (!info) {
        info = createTimelineBlockNode(block, view, record, history, { notify });
        if (!info) continue;
        info.kind = block.kind;
        info.signature = '';
        view.timeline.nodes.set(block.id, info);
      }
      const regenerateUserIndex = regenerateByBlock.get(block.id);
      const signature = JSON.stringify(block) + (block.kind === 'assistant' ? '|regen:' + (regenerateUserIndex ?? '') : '')
        + (block.kind === 'plan'
        ? `|${record?.item?.lifecycle || ''}|${record?.item?.activity || ''}|${record?.approvals?.length || 0}|${record?.planBlock?.id || ''}`
        : '');
      if (info.signature !== signature) {
        info.signature = signature;
        info.update(block, regenerateUserIndex);
      }
      const row = { block, info, outcome: null };
      rows.push(row);
      wanted.add(info.node);

      const turn = outcomeByLastBlock.get(block.id);
      if (!turn) continue;
      /* 最后一轮只有 store 明确 settled 后才算终态；更早的轮次以用户消息为
       * 边界，已经结束。settledTurns 让已展示的终态在下一轮 agent_start 后
       * 仍然保留，不会因为 settled 翻转而消失。 */
      if (turn.complete) view.timeline.settledTurns.add(turn.key);
      if (!view.timeline.settledTurns.has(turn.key)) continue;
      let outcomeInfo = view.timeline.outcomeNodes.get(turn.key);
      if (!outcomeInfo) {
        const node = renderTurnOutcome(turn.outcome);
        if (!node) continue;
        outcomeInfo = { node, signature: '' };
        view.timeline.outcomeNodes.set(turn.key, outcomeInfo);
      }
      const outcomeSignature = JSON.stringify(turn.outcome);
      if (outcomeInfo.signature !== outcomeSignature) {
        outcomeInfo.signature = outcomeSignature;
        updateTurnOutcome(outcomeInfo.node, turn.outcome);
      }
      row.outcome = outcomeInfo.node;
      wanted.add(outcomeInfo.node);
    }
    for (const [key, info] of [...view.timeline.nodes]) {
      if (!wanted.has(info.node)) { info.node.remove(); view.timeline.nodes.delete(key); }
    }
    for (const [key, info] of [...view.timeline.outcomeNodes]) {
      if (!wanted.has(info.node)) { info.node.remove(); view.timeline.outcomeNodes.delete(key); }
    }
    /* 有界视图态：清理当前模式下已经被截断的 block/tool 展开记录，
     * 另一模式（历史/实时）的记录保留，切回时仍能恢复。 */
    const prefix = mode + ':';
    const blockIds = new Set(blocks.map(block => block.id));
    const toolIds = new Set();
    for (const block of blocks) if (block.kind === 'tools') for (const tool of block.tools) toolIds.add(String(tool.id));
    for (const key of view.timeline.thinkingOpen.keys()) if (key.startsWith(prefix) && !blockIds.has(key.slice(prefix.length))) view.timeline.thinkingOpen.delete(key);
    for (const key of view.timeline.groupOpen.keys()) if (key.startsWith(prefix) && !blockIds.has(key.slice(prefix.length))) view.timeline.groupOpen.delete(key);
    for (const key of view.timeline.entryOpen.keys()) if (key.startsWith(prefix) && !toolIds.has(key.slice(prefix.length))) view.timeline.entryOpen.delete(key);
    const turnKeys = new Set(blocks.filter(block => block && block.kind === 'user').map(block => block.id));
    for (const key of view.timeline.settledTurns) if (!turnKeys.has(key)) view.timeline.settledTurns.delete(key);
    /* 顺序由数据决定；这里只是把 DOM 对齐到数据，不猜测事件先后。 */
    const { nodes, usageInTimeline } = history
      ? { nodes: [...wanted], usageInTimeline: false }
      : composeExecutionRows(rows, view.timeline, record);
    const topLevel = new Set(nodes);
    let cursor = output.firstChild;
    for (const node of nodes) {
      if (node === cursor) cursor = cursor.nextSibling;
      else output.insertBefore(node, cursor);
    }
    while (cursor) {
      const next = cursor.nextSibling;
      if (!topLevel.has(cursor)) cursor.remove();
      cursor = next;
    }
    return usageInTimeline;
  }

  /** 只读历史里的搜索落点。
   *
   * 只有真的找到对应行才滚动并标记 found；目标被 240 block / 1 MiB 窗口裁掉时
   * 明确说明「位于已裁剪范围之外」，不再把「历史打开了」当成「已定位」。
   * 这里只读当前 history 投影和已渲染 DOM，不重读历史、不跨会话、不改保留上限。 */
  function updateHistoryLocate(view, surfaceActive) {
    const match = view.history?.match || null;
    if (!match) {
      view.locateNotice = '';
      locateNotice.textContent = '';
      delete output.dataset.historyMatch;
      delete output.dataset.historyMatchState;
      return;
    }
    /* 中央没显示 Runtime 时先不判定；等切回来再滚，避免后台视图偷偷改滚动位置。 */
    if (!surfaceActive) return;
    const messageId = match.messageId;
    const index = match.userIndex;
    const matchKey = JSON.stringify([messageId, index]);
    if (output.dataset.historyMatch === matchKey) {
      locateNotice.textContent = view.locateNotice || '';
      return;
    }
    const rows = [...output.querySelectorAll('.rtc-history-message')];
    const row = messageId ? rows.find(item => item.dataset.historyMessageId === messageId)
      : Number.isInteger(index) && index >= 0 ? rows.find(item => item.dataset.historyUserIndex === String(index)) : null;
    let state;
    if (row) {
      scrollRowIntoView(output, row, 'center');
      view.locateNotice = '';
      state = 'found';
    } else {
      const trimmed = view.history.truncated === true || view.history.execution?.truncated === true;
      view.locateNotice = trimmed ? HISTORY_TARGET_TRIMMED : HISTORY_TARGET_MISSING;
      state = trimmed ? 'trimmed' : 'missing';
    }
    output.dataset.historyMatch = matchKey;
    output.dataset.historyMatchState = state;
    locateNotice.textContent = view.locateNotice;
  }

  function draw() {
    if (!host) return;
    const r = store.get(id), view = current();
    /* 「这一次 draw 是不是刚切到这条会话」——必须在下面写 renderedId 之前取。
     * 滚动策略要用它区分「用户主动切过来」与「同一条会话内的流式更新」。 */
    const entered = renderedId !== id;
    /* 切换会话/视图时，旧的就地编辑器不能留在 detached DOM 里继续持有
     * “正在编辑”状态；恢复原节点，但不抢新视图的焦点。 */
    if (entered) { try { closeMessageEditor({ restore: true, focus: false }); } catch { /* editor may be detached */ } }
    // Capture intent before text/thinking/tool changes can increase scrollHeight.
    const wasNearBottom = !entered && !view.history && shouldFollow(output);
    const prevScrollHeight = output.scrollHeight || 0;
    root.hidden = !id;
    if (!id) return;
    title.textContent = r?.item?.title || r?.item?.sessionName || models?.get(id)?.sessionName || r?.item?.workspace?.branch || '并行会话';
    title.title = title.textContent;
    if (active) onTitle(title.textContent, r?.item?.workspace?.cwd || '');
    drawModels(r, view);
    resources.textContent = resourceText();
    notice.textContent = view.notice;
    locateNotice.textContent = view.locateNotice || '';
    if (view.history) setState(formatHistoryState(view.history, r?.owner), false);
    else if (view.pendingHistory) setState('读取历史…', false);
    else {
      /* 正文/执行记录被截断时说出来 —— 不声不响地少显示一段，用户会以为那就是全部。 */
      const lifecycle = statusLine(r?.item) || (r ? '' : '这条会话还没有记录');
      const truncated = r?.truncated || r?.timelineTruncated;
      const notice = truncated ? `${lifecycle ? ' · ' : ''}仅显示最近输出${r?.timelineTruncated ? '与执行记录' : ''}` : '';
      setState(lifecycle + notice, showsWorkingDots(r?.item, r, view), entered);
    }

    let executionUsageInTimeline = false;
    if (view.history) {
      const executionBlocks = Array.isArray(view.history.execution?.timeline) ? view.history.execution.timeline : [];
      if (executionBlocks.length) {
        if (renderedHistory !== view.history || renderedId !== id) {
          delete output.dataset.renderedText;
          renderedHistory = view.history; delete output.dataset.historyMatch; delete output.dataset.historyMatchState;
        }
        renderTimeline(executionBlocks, view, r, true);
      } else if (renderedHistory !== view.history || renderedId !== id || view.timeline.mode !== null) {
        clearExecutionViews(view.timeline);
        view.timeline.mode = null;
        view.timeline.nodes.clear();
        view.timeline.outcomeNodes.clear();
        view.timeline.settledTurns.clear();
        output.replaceChildren(); let userIndex = 0;
        delete output.dataset.renderedText;
        const messages = Array.isArray(view.history.messages) ? view.history.messages : [];
        const toolSummary = view.history.toolSummary;
        const toolItems = Array.isArray(toolSummary?.items) ? toolSummary.items : [];

        const placedTools = new Map();
        const unconfirmedTools = [];
        for (const item of toolItems) {
          const pos = item?.messagePosition;
          if (typeof pos === 'number' && Number.isInteger(pos) && pos >= 0 && pos <= messages.length) {
            let list = placedTools.get(pos);
            if (!list) { list = []; placedTools.set(pos, list); }
            list.push(item);
          } else {
            unconfirmedTools.push(item);
          }
        }

        if (unconfirmedTools.length) {
          const unconfirmedBox = el('div', 'rtc-history-unconfirmed');
          unconfirmedBox.append(el('div', 'rtc-history-unconfirmed-title', '位置未确认'));
          for (const item of unconfirmedTools) {
            unconfirmedBox.append(createHistoryToolRow(item), document.createTextNode('\n'));
          }
          output.append(unconfirmedBox);
        }

        for (let i = 0; i <= messages.length; i++) {
          const toolsAtPos = placedTools.get(i);
          if (toolsAtPos) {
            for (const item of toolsAtPos) {
              output.append(createHistoryToolRow(item), document.createTextNode('\n'));
            }
          }
          if (i < messages.length) {
            const message = messages[i];
            const row = el('div', 'rtc-history-message');
            row.dataset.role = message.role;
            row.append(el('div', 'rtc-history-role', message.role === 'user' ? '我' : '助手'));
            if (message.messageId) row.dataset.historyMessageId = message.messageId;
            if (message.role === 'user') {
              const index = Object.hasOwn(message, 'userIndex') ? message.userIndex : userIndex;
              if (Number.isInteger(index)) row.dataset.historyUserIndex = String(index);
              userIndex++;
            }
            if (message.role === 'assistant') {
              appendRuntimeContent(row, message.text);
            } else {
              row.append(el('div', 'rtc-history-user-text', message.text));
              if (message.role === 'user') row.append(messageActions(message.text));
            }
            output.append(row);
          }
        }
        if (!messages.length && !toolItems.length) {
          output.textContent = '（没有可显示的正文）';
        } else if (!messages.length) {
          output.append(el('span', 'rtc-history-empty', '（没有可显示的正文）'));
        }
        renderedHistory = view.history; delete output.dataset.historyMatch; delete output.dataset.historyMatchState;
      }
    } else {
      renderedHistory = null;
      view.locateNotice = '';
      locateNotice.textContent = '';
      delete output.dataset.historyMatch;
      delete output.dataset.historyMatchState;
      const blocks = Array.isArray(r?.timeline) ? r.timeline : [];
      if (blocks.length) {
        delete output.dataset.renderedText;
        executionUsageInTimeline = renderTimeline(blocks, view, r, false);
      } else {
        clearExecutionViews(view.timeline);
        view.timeline.mode = null;
        view.timeline.nodes.clear();
        view.timeline.outcomeNodes.clear();
        view.timeline.settledTurns.clear();
        const curText = r?.text || '';
        if (output.dataset.renderedText !== curText || renderedId !== id) {
          output.dataset.renderedText = curText;
          if (!curText) {
            output.textContent = '等待任务';
          } else {
            output.replaceChildren();
            appendRuntimeContent(output, curText, { isBlock: true });
          }
        }
      }
    }

    const usageStats = view.history ? null : projection.usageOf(id);
    const usageKey = usageStats ? JSON.stringify(usageStats) : '';
    if (usageKey !== renderedUsageKey) {
      renderedUsageKey = usageKey;
      usage.replaceChildren();
      if (usageStats) {
        const meta = renderUsageMeta(usageStats, {
          source: usageStats.source,
          label: '本轮助手消息用量',
          prefix: '本轮 · ',
          className: 'ui2-msg-meta ui2-runtime-usage-meta',
        });
        if (meta) usage.append(meta);
      }
    }
    usage.hidden = !usageKey || executionUsageInTimeline;

    const curLoc = r ? extractStableLocator(r?.item, r?.owner) : null;
    const curLocKey = runtimeDraftKey(curLoc);
    const locatorChanged = curLocKey !== renderedLocatorKey;
    renderedLocatorKey = curLocKey;

    if (locatorChanged) {
      view.draftRestored = false;
    }

    if (!view.draftRestored && !view.history) {
      maybeRestoreDraft(id);
    }

    if (renderedId !== id || locatorChanged || document.activeElement !== input) {
      input.value = view.history ? '' : (r?.draft || '');
      if (input.value.length > DRAFT_MAX_CHARS) {
        updateDraftNotice({ status: 'exceeded', notice: '草稿超过本地恢复上限，请复制保存完整文本' });
      } else if (draftNotice.textContent.includes('超过本地恢复上限')) {
        draftNotice.hidden = true; draftNotice.textContent = '';
      }
    }
    renderedId = id;
    input.disabled = Boolean(view.history);
    input.placeholder = view.history ? '查看历史时不发送；需要继续请点「恢复会话」' : '给当前会话发送任务…';

    /* 这些判据全部来自**当前会话自己的**视图态 —— A 的 pending 不会禁用 B 的控件。 */
    const live = Boolean(r?.owner), busy = view.pending;
    send.disabled = busy || !live || r?.item?.lifecycle !== 'ready' || r?.item?.activity !== 'idle' || Boolean(view.history);
    stop.disabled = busy || !live || r?.item?.activity === 'idle';
    restart.disabled = end.disabled = busy || !live;
    resume.disabled = busy || live;
    historyBtn.disabled = busy || live || view.pendingHistory;
    liveBtn.hidden = !live || !view.history; liveBtn.disabled = busy;

    const key = JSON.stringify([id, r?.owner, r?.approvals]);
    if (key !== approvalKey) {
      const priorRows = new Map([...approvals.children].map(row => [row._runtimeApproval, row]));
      approvalKey = key; approvals.replaceChildren();
      for (const a of r?.approvals || []) {
        const priorRow = priorRows.get(a);
        if (priorRow && same(r.owner, priorRow._runtimeOwner) && same(priorRow._runtimeOwner, r.owner)) {
          priorRow.querySelectorAll('button,textarea').forEach(control => { control.disabled = a.submitting === true; });
          approvals.append(priorRow); continue;
        }
        const approvalOwner = { ...r.owner }, approvalId = id;
        const row = el('div', 'rtc-approval'); row.append(el('p', '', a.title));
        row._runtimeApproval = a;
        row._runtimeOwner = approvalOwner;
        const respond = response => {
          if (!same(store.get(approvalId)?.owner, approvalOwner)) return Promise.resolve(null);
          row.querySelectorAll('button,textarea').forEach(control => { control.disabled = true; });
          return respondToRuntimeApproval(approvalOwner, a, () => action(approvalId, { action: 'command', owner: approvalOwner, command: { type: 'extension_ui_response', id: a.id, ...response } }));
        };
        if (a.method === 'confirm') { const yes = el('button', 'btn primary', '确认'); const no = el('button', 'btn', '拒绝'); yes.type = no.type = 'button'; yes.onclick = () => respond({ confirmed: true }); no.onclick = () => respond({ confirmed: false }); row.append(yes, no); }
        else if (a.method === 'select') for (const value of a.options) { const b = el('button', 'btn', value); b.type = 'button'; b.onclick = () => respond({ value }); row.append(b); }
        else { const value = el('textarea'); value.setAttribute('aria-label', a.title || '审批输入'); const submit = el('button', 'btn primary', '提交'); submit.type = 'button'; submit.onclick = () => respond({ value: value.value }); row.append(value, submit); }
        const cancel = el('button', 'btn ghost', '取消'); cancel.type = 'button'; cancel.onclick = () => respond({ cancelled: true }); row.append(cancel);
        row.querySelectorAll('button,textarea').forEach(control => { control.disabled = a.submitting === true; });
        approvals.append(row);
      }
    }
    /* ---------- 滚动：切会话恢复位置，流式只在贴底时跟随 ----------
     *
     * 原实现**每次** draw 都把 scrollTop 写回 saveScroll 记下的那个值。于是「用户
     * 上滚读上文、后台还在流式」时，每来一帧就被拽回切过来那一刻的位置，根本读不了。
     *
     * 现在的判据（与 Classic `messages.js:78` 同一条「近底 160」规则）：
     *   - **刚切到这条会话**（renderedId 变了）→ 恢复它自己保存的位置（没存过就贴底）。
     *     切会话是用户主动的，这一刻按保存值走。
     *   - **同一条会话内**（流式/状态更新）→ 只在**已经贴底**时才跟着新内容走；
     *     一旦上滚离开底部，视口就归用户，直到他滚回底部。
     * 判据只用 scrollTop/scrollHeight/clientHeight，不依赖 scroll 事件 ——
     * jsdom 不派发 scroll 事件、也不做布局，靠事件判定的写法在测试里会假绿。
     */
    if (view.history) {
      updateHistoryLocate(view, active);
    } else if (entered) {
      const top = scrollTops.get(id);
      output.scrollTop = top === undefined ? output.scrollHeight : top;
    } else if (wasNearBottom && (output.scrollHeight || 0) > prevScrollHeight) {
      output.scrollTop = output.scrollHeight;
    }
    /* 回到底部按钮：滚的是 output 自己；运行态复用四点动画。切会话后
     * 可见性/位置都由当前会话的 scrollTop 重新算。 */
    scrollButton.setRunning(showsWorkingDots(r?.item, r, view));
    scrollButton.update();
  }

  return {
    element: root,
    get conversationId() { return id; },
    /** 切到某条会话。dormant 时只清历史缓存，**不**自动去读、更不 spawn。 */
    show(next) {
      focusEpoch++;
      modelPicker.close(); thinkingPicker.close();
      active = true;
      composing = false;
      if (next === id) { ensureModels(); draw(); void resumeRuntimePendingEdit(id); return; }
      flushCurrentDraft(id);
      saveScroll();
      if (id) viewOf(id).focusOnReady = null;
      id = next || null;
      root.dataset.conversationId = id || '';
      ensureModels();
      approvalKey = ''; renderedId = null; renderedLocatorKey = null;
      draw();
      void resumeRuntimePendingEdit(id);
    },
    draw,
    async openHistory(locator, match = null) {
      if (!matchesLocator(store.get(locator?.conversationId)?.item, locator)) return false;
      this.show(locator.conversationId);
      await loadHistory(locator, match);
      void resumeRuntimePendingEdit(locator.conversationId);
      return alive && id === locator.conversationId && Boolean(current().history);
    },
    /** 离开中央视图时记下滚动位置。 */
    leave() {
      active = false;
      modelPicker.close(); thinkingPicker.close();
      composing = false;
      focusEpoch++;
      flushCurrentDraft(id);
      saveScroll();
      if (id) viewOf(id).focusOnReady = null;
    },
    dispose() {
      alive = false;
      modelPicker.dispose(); thinkingPicker.dispose();
      composing = false;
      flushCurrentDraft(id);
      draftCoordinator.dispose();
      scrollButton.dispose();
      if (typeof window !== 'undefined' && unloadHandler) {
        window.removeEventListener('beforeunload', unloadHandler);
      }
      for (const view of views.values()) clearExecutionViews(view.timeline);
      unsubscribe(); root.remove();
      document.removeEventListener('pi-gui:runtime-title', onTitleEvent);
      /* 只拆自己建的那一份投影；外部传进来的（`display`）归外部管。 */
      if (ownsProjection) projection.dispose();
    },
  };
}
