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
  if (node.nodeType !== 1 || node.hasAttribute('data-execution-turn')) return null;
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
        result.push({ name: value?.name, title: value?.label, kind: value?.kind });
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
  head.append(icon, title, summary, count, state);
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
    update(nodes) {
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
      const iconName = workSummaryIcon(descriptors);
      if (icon.dataset.icon !== iconName) {
        icon.dataset.icon = iconName;
        icon.innerHTML = iconMarkup(iconName); // local constant only
      }
      const tools = [...groups].flatMap(groupEntries);
      const counts = new Map();
      for (const tool of tools) {
        const status = tool.dataset.status === 'running' && tool.dataset.waiting === 'true'
          ? 'waiting' : tool.dataset.status || 'unknown';
        if (status !== 'success') counts.set(status, (counts.get(status) || 0) + 1);
      }
      count.textContent = tools.length ? tools.length + ' 次工具' : nodes.length + ' 条记录';
      state.textContent = [...counts].map(([status, total]) => (STATUS[status] || STATUS.unknown) + ' ' + total).join(' · ');
      const active = counts.has('running') || counts.has('waiting');
      const needsAttention = counts.has('error') || counts.has('interrupted') || counts.has('incomplete');
      // This is an activity summary, never a task/run outcome.
      node.dataset.status = active ? counts.has('waiting') ? 'waiting' : 'running'
        : counts.has('error') ? 'failed' : counts.size ? 'incomplete' : 'recorded';
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
        const flush = () => {
          if (!batch.length) return;
          // A lone thought or single native tool already has its own disclosure.
          const single = batch.length === 1;
          const tools = batch.flatMap(nativeGroups).reduce((total, group) => total + (group._tlGroup?.count || 0), 0);
          if (single && (workKind(batch[0]) !== 'tools' || tools < 2)) result.push(batch[0]);
          else {
            const first = batch[0];
            const log = logs.get(first) || createLog(document, first, preferences);
            if (!log.node.parentNode) parent.append(log.node);
            log.update(batch);
            result.push(log.node);
            nextLogs.set(first, log);
          }
          batch = [];
        };
        for (const node of nodes) {
          if (workKind(node)) batch.push(node);
          else { flush(); result.push(node); }
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
