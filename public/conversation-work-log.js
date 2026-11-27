/* Native conversation presentation, not an execution model.
 * A work log groups only consecutive display nodes. It never supplies run,
 * attempt, owner, success, or authorization evidence to the P5 observer.
 * Existing nodes, order, anchors and event handlers remain recoverable.
 * Inspired by T3 Code's WorkLog organization; independently implemented for
 * Pi's native DOM / ToolEntry contract, without copying React or backend code. */
import { setGroupEmbedded, groupEntries } from './tool-view.js';
import { preserveScrollAround } from './reading-position.js';
import { preserveTextSelection } from './ui/text-selection.js';
import { iconMarkup } from './ui/icons.js';
import { activityNote, isAbnormalTurnStatus, turnFoldLabel } from './ui/turn-fold.js';
import { workSummary, workSummaryIcon } from './ui/work-presentation.js';

const CONTROLS = 'button:not(:disabled), a[href], summary, [tabindex="0"]';
function visibleControl(node) {
  return [node, ...node.querySelectorAll(CONTROLS)].find(control => control.matches(CONTROLS)
    && control.isConnected && !control.closest('[hidden]'));
}

/** State-preserving ordering shared by native and verified timelines. */
export function orderConversationNodes(parent, nodes) {
  return preserveTextSelection(parent, () => {
    const focused = parent.ownerDocument.activeElement;
    const retainedFocus = focused && nodes.some(node => node.contains?.(focused));
    let cursor = parent.firstChild;
    for (const node of nodes) {
      if (node === cursor) cursor = cursor.nextSibling;
      else if (node.parentNode && node.isConnected === parent.isConnected && typeof parent.moveBefore === 'function') parent.moveBefore(node, cursor);
      else parent.insertBefore(node, cursor);
    }
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
    if (retainedFocus && focused.isConnected && parent.ownerDocument.activeElement !== focused) {
      focused.focus?.({ preventScroll: true });
    }
  });
}

/** Flatten presentation wrappers only, including P5's original-order markers.
 * This is used by editing and native rendering, not to infer message identity. */
export function nativeConversationChildren(parent) {
  const result = [];
  for (const node of parent?.childNodes || []) {
    if (node.nodeType === 1 && node.hasAttribute('data-conversation-work')) {
      result.push(...nativeConversationChildren(node.querySelector(':scope > .conversation-work-list')));
    } else result.push(node);
  }
  return result;
}

function nativeGroups(node) {
  if (node.matches?.('.tl-group')) return [node];
  return [...node.querySelectorAll?.('.tl-group') || []];
}

function workKind(node) {
  if (node.nodeType !== 1 || node.hasAttribute('data-execution-turn') || node.matches('.html-artifact')) return null;
  if (node.matches('.tl-group, .ui2-runtime-tools')) return 'tools';
  return node.dataset.conversationWorkKind || null;
}

function safeChoiceKey(node) {
  return node.dataset.anchorId || node.dataset.blockId || null;
}

/** Authorized display descriptors for the compact summary row. Only nodes the
 * caller already owns are inspected; nothing is fetched and no run evidence is
 * derived from tool counts. */
function workDescriptors(nodes) {
  const result = [];
  for (const node of nodes) {
    if (node.matches?.('.tl-group, .ui2-runtime-tools')) {
      const entries = nativeGroups(node).flatMap(groupEntries);
      if (!entries.length) result.push({ kind: 'tool' });
      for (const entry of entries) {
        const value = entry._tlEntry;
        result.push({ name: value?.name, title: value?.label, kind: value?.kind,
          targetId: typeof value?.path === 'string' ? value.path : undefined });
      }
    } else if (node.dataset?.conversationWorkKind === 'thinking') {
      result.push({ kind: 'thinking' });
    } else {
      result.push({ kind: 'progress' });
    }
  }
  return result;
}

const STATUS = { running: '运行中', waiting: '等待', error: '失败', incomplete: '未完成',
  interrupted: '已中断', cancelled: '已取消', unknown: '状态未知' };
let logId = 0;

const USER_NODE = '.msg.user, .rtc-timeline-message[data-role="user"], [data-role="user"]';
const OWNER_BOUNDARY = '.plan, .execution-turn, [data-execution-turn], .turn-outcome';

/** The nearest real user input in the caller's ordered node list owns this
 * batch. Reading the ordered list instead of DOM siblings is required because
 * Runtime mounts a first render before its nodes are connected. A Plan or
 * another execution boundary in between is a hard stop: never borrow a
 * previous turn's clock. */
function timingOwner(nodes, end) {
  for (let index = end - 1; index >= 0; index--) {
    const node = nodes[index];
    if (node?.nodeType !== 1) continue;
    if (node.matches?.(USER_NODE)) return node;
    if (node.matches?.(OWNER_BOUNDARY)) return null;
  }
  return null;
}

function readTiming(node) {
  if (!node?.dataset) return null;
  const start = Number(node.dataset.turnStartAt);
  const end = Number(node.dataset.turnEndedAt);
  const status = node.dataset.turnStatus || '';
  if (!Number.isFinite(start) && !Number.isFinite(end) && !status) return null;
  return {
    startedAt: Number.isFinite(start) ? start : null,
    endedAt: Number.isFinite(end) ? end : null,
    durationMs: null,
    evidence: Number.isFinite(start) ? 'observed' : 'unknown',
    status,
    continued: node.hasAttribute('data-turn-continued'),
  };
}

function createLog(document, first, preferences) {
  const node = document.createElement('section');
  node.className = 'conversation-work-log';
  node.dataset.conversationWork = '';
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'conversation-work-head';
  const icon = document.createElement('span');
  icon.className = 'conversation-work-icon';
  icon.setAttribute('aria-hidden', 'true');
  const title = document.createElement('span');
  title.className = 'conversation-work-title';
  title.textContent = '工作记录';
  const summary = document.createElement('span');
  summary.className = 'conversation-work-summary';
  const count = document.createElement('span');
  count.className = 'conversation-work-count';
  const state = document.createElement('span');
  state.className = 'conversation-work-state';
  const chevron = document.createElement('span');
  chevron.className = 'conversation-work-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = iconMarkup('chevronRight'); // local constant only
  head.append(icon, title, summary, count, state, chevron);
  const list = document.createElement('div');
  list.className = 'conversation-work-list';
  list.id = 'conversation-work-' + ++logId;
  head.setAttribute('aria-controls', list.id);
  node.append(head, list);
  const key = safeChoiceKey(first);
  if (key) node.dataset.anchorId = 'work-' + key;
  node.dataset.collapsible = '';
  let choice = key ? preferences?.get(key) : undefined;
  let adopted = new Set();

  function open(value) {
    if (!value && list.contains(document.activeElement)) head.focus({ preventScroll: true });
    list.hidden = !value;
    head.setAttribute('aria-expanded', String(value));
  }
  open(choice === true);
  head.addEventListener('click', () => preserveScrollAround(head, () => {
    choice = list.hidden;
    open(choice);
    if (key) preferences?.set(key, choice);
  }));

  return {
    node,
    update(nodes, owner) {
      const groups = new Set(nodes.flatMap(nativeGroups));
      for (const group of adopted) if (!groups.has(group) && list.contains(group)) setGroupEmbedded(group, false);
      for (const group of groups) {
        if (group._tlGroup?.head === document.activeElement) head.focus({ preventScroll: true });
        setGroupEmbedded(group, true);
      }
      adopted = groups;
      orderConversationNodes(list, nodes);
      const descriptors = workDescriptors(nodes);
      const summaryText = workSummary(descriptors) || nodes.length + ' 项工作记录';
      if (summary.textContent !== summaryText) summary.textContent = summaryText;
      const tools = [...groups].flatMap(groupEntries);
      const statuses = tools.map(tool => tool.dataset.status === 'running' && tool.dataset.waiting === 'true'
        ? 'waiting' : tool.dataset.status || 'unknown');
      const counts = new Map();
      for (const status of statuses) if (status !== 'success') counts.set(status, (counts.get(status) || 0) + 1);
      count.textContent = tools.length ? tools.length + ' 次工具' : nodes.length + ' 条记录';
      state.textContent = [...counts].map(([status, total]) => (STATUS[status] || STATUS.unknown) + ' ' + total).join(' · ');
      const active = counts.has('running') || counts.has('waiting');
      /* Every abnormal tool state opens by default, including cancellation.
       * The P5 timeline uses the same set (failed/interrupted/cancelled/
       * incomplete); running and waiting already open as active work. */
      const needsAttention = counts.has('error') || counts.has('interrupted')
        || counts.has('cancelled') || counts.has('incomplete');
      // This is an activity summary, never a task/run outcome.
      node.dataset.status = active ? counts.has('waiting') ? 'waiting' : 'running'
        : counts.has('error') ? 'failed' : counts.has('cancelled') ? 'cancelled'
          : counts.size ? 'incomplete' : 'recorded';
      const timing = readTiming(owner);
      const note = activityNote(statuses);
      const visibleNote = timing && isAbnormalTurnStatus(timing.status) ? '' : note;
      const label = turnFoldLabel({
        status: timing?.status || '', timing, now: Date.now(), continued: timing?.continued === true,
      });
      title.textContent = (label || '工作记录') + (visibleNote ? ' · ' + visibleNote : '');
      node.dataset.turnStatus = timing?.status || '';
      node.dataset.attention = note ? 'true' : 'false';
      const iconName = timing?.status === 'failed' || node.dataset.status === 'failed' ? 'circleAlert'
        : ['interrupted', 'cancelled', 'stopped'].includes(timing?.status) || node.dataset.status === 'cancelled'
          ? 'stop'
          : timing?.status === 'incomplete' || node.dataset.status === 'incomplete' ? 'warning'
            : workSummaryIcon(descriptors);
      if (icon.dataset.icon !== iconName) {
        icon.dataset.icon = iconName;
        icon.innerHTML = iconMarkup(iconName); // local constant only
      }
      const accessible = [title.textContent, summaryText, state.textContent].filter(Boolean).join(' · ');
      if (head.title !== accessible) head.title = accessible;
      const viewingDetails = !!list.querySelector('.tl-item.open, .think-head[aria-expanded="true"], details[open]');
      const selection = document.defaultView.getSelection?.();
      const selecting = selection && !selection.isCollapsed && (list.contains(selection.anchorNode) || list.contains(selection.focusNode));
      if (choice === undefined) open(active || needsAttention || viewingDetails || list.contains(document.activeElement) || selecting);
    },
    reveal(target) {
      if (list.contains(target)) open(true);
    },
    release() {
      const focused = document.activeElement;
      const hadFocus = node.contains(focused);
      for (const group of adopted) if (list.contains(group)) setGroupEmbedded(group, false);
      adopted.clear();
      if (node.parentNode) {
        const parent = node.parentNode;
        const children = [...list.childNodes];
        for (const child of children) {
          if (typeof parent.moveBefore === 'function' && child.isConnected === parent.isConnected) parent.moveBefore(child, node);
          else parent.insertBefore(child, node);
        }
        node.remove();
        if (focused?.isConnected && !focused.closest('[hidden]') && parent.contains(focused)) {
          if (focused !== document.activeElement) focused.focus?.({ preventScroll: true });
        } else if (hadFocus) {
          // The removed work header cannot be its own focus fallback. Restore to
          // the surviving native batch/entry/Thinking control, never a hidden row.
          children.filter(child => child.nodeType === 1).map(visibleControl).find(Boolean)?.focus({ preventScroll: true });
        }
      }
    },
  };
}

/** Caller owns lifecycle and supplies the actual ordered native nodes. */
export function createConversationFlow({ document = globalThis.document, preferences } = {}) {
  let logs = new Map();
  return {
    render(parent, nodes = nativeConversationChildren(parent)) {
      return preserveTextSelection(parent, () => {
        const focused = document.activeElement;
        const focusedLog = [...logs.values()].find(log => log.node.contains(focused));
        const focusMembers = focusedLog ? nativeConversationChildren(focusedLog.node.querySelector('.conversation-work-list')) : [];
        const nextLogs = new Map();
        const result = [];
        let batch = [];
        let batchStart = -1;
        const flush = () => {
          if (!batch.length) return;
          /* A settled turn with timing always gets one fold entry, including a
           * lone row. Without trustworthy timing, a lone thought/single tool
           * keeps its own native disclosure instead of gaining a second
           * generic "工作记录" heading. */
          const first = batch[0];
          const owner = timingOwner(nodes, batchStart);
          const hasTurnEvidence = Boolean(owner?.dataset.turnStatus || owner?.dataset.turnStartAt
            || owner?.dataset.turnEndedAt);
          const single = batch.length === 1;
          const tools = single
            ? (nativeGroups(batch[0]).reduce((total, group) => total + (group._tlGroup?.count || 0), 0))
            : 0;
          if (single && !hasTurnEvidence && (workKind(batch[0]) !== 'tools' || tools < 2)) {
            result.push(batch[0]);
          } else {
            const log = logs.get(first) || createLog(document, first, preferences);
            if (!log.node.parentNode) parent.append(log.node);
            log.update(batch, owner);
            result.push(log.node);
            nextLogs.set(first, log);
          }
          batch = [];
          batchStart = -1;
        };
        for (const [index, node] of nodes.entries()) {
          if (workKind(node)) {
            if (!batch.length) batchStart = index;
            batch.push(node);
          } else { flush(); result.push(node); }
        }
        flush();
        // Release before aligning the host, so no detached wrapper can retain
        // a native node used by editing, restored history, or verified adoption.
        for (const [first, log] of logs) if (!nextLogs.has(first)) log.release();
        logs = nextLogs;
        orderConversationNodes(parent, result);
        if (focusedLog && !focused.isConnected && document.activeElement === document.body) {
          // A batch can move to a new log before its old header is released.
          // Prefer that surviving member's control, not an unrelated composer.
          const successors = result.filter(node => focusMembers.some(member => node === member || node.contains(member)));
          [...successors, ...result].filter(node => node.nodeType === 1).map(visibleControl).find(Boolean)?.focus({ preventScroll: true });
        }
        return result;
      });
    },
    restore() {
      for (const log of logs.values()) preserveTextSelection(log.node.parentNode || log.node, () => log.release());
      logs.clear();
    },
    reveal(target) {
      for (const log of logs.values()) log.reveal(target);
    },
  };
}
