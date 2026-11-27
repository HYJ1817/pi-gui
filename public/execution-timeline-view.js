/* Shared, live execution-turn layout. Hosts supply their authorized native message
 * and tool nodes. The layout never requests data or revises the P5-A event model. */
import { preserveScrollAround } from './reading-position.js';
import { groupEntries, isEntryExpanded, setEntryExpanded } from './tool-view.js';
import { formatTurnDuration } from './turn-outcome.js';
import { orderConversationNodes as order } from './conversation-work-log.js';
import { iconMarkup } from './ui/icons.js';
import { activityNote, isAbnormalTurnStatus, isActiveTurnStatus, turnFoldLabel } from './ui/turn-fold.js';
import { workIconName, workSummary, workSummaryIcon } from './ui/work-presentation.js';

const ACTIVITY_PAGE = 40;
const MAX_OPEN_ACTIVITIES = 200;
const PLAN_PAGE = 10;
const TASK_LINES = 6;
const EMPTY_NODES = [];
const EMPTY_DETAILS = new Map();
const ACTIVE = new Set(['queued', 'running', 'waiting', 'stopping']);
const LABEL = {
  queued: '待执行', running: '进行中', waiting: '等待中', stopping: '正在停止',
  completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断',
  incomplete: '未完成', unknown: '状态未知', complete: '已完成', stopped: '已停止',
  detached: '已分离',
};
let sectionId = 0;

export function executionTurnForInput(snapshot, sequence) {
  const scope = snapshot?.scope;
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !scope) return null;
  const session = scope.kind === 'runtime' ? scope.owner?.sessionId : scope.sessionId;
  const source = scope.kind === 'runtime' ? 'runtime-frame' : scope.kind === 'classic' ? 'classic-rpc' : null;
  if (!session || !source) return null;
  return snapshot.turns?.find(turn => turn.sessionId === session && turn.source === source
    && turn.position?.domain === 'live' && turn.evidence === 'verified' && turn.completeness === 'complete'
    && turn.input?.id === turn.id + ':input:' + sequence && turn.input.content?.source === 'live-buffer') || null;
}

function label(status) {
  return Object.hasOwn(LABEL, status) ? LABEL[status] : LABEL.unknown;
}

function write(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function rowDuration(timing, status, now) {
  if (!timing || timing.evidence === 'unknown') return '';
  const milliseconds = timing.durationMs ?? (Number.isFinite(timing.startedAt)
    ? (timing.endedAt ?? (ACTIVE.has(status) ? now : NaN)) - timing.startedAt
    : NaN);
  const formatted = formatTurnDuration(milliseconds);
  return formatted && timing.evidence === 'estimated' ? '约 ' + formatted : formatted;
}

/* T3 ends each post-steer segment at its own last entry, not at the end of the
 * whole turn. Activity items carry their own timing; adopted native tool rows
 * carry the already-authorized `_tlEntry` timestamps. Missing evidence returns
 * null so the caller can leave the duration off instead of borrowing a later
 * segment's clock. */
function latestEnd(entries, items) {
  let end = null;
  const consider = value => {
    if (Number.isFinite(value) && (end === null || value > end)) end = value;
  };
  const considerEntry = entry => {
    if (!entry || !Number.isFinite(entry.startedAt)) return;
    consider(Number.isFinite(entry.endedAt) ? entry.endedAt
      : Number.isFinite(entry.durationMs) ? entry.startedAt + entry.durationMs : null);
  };
  for (const item of items) considerEntry(item.timing);
  for (const entry of entries) {
    if (entry.activityId || !entry.node) continue;
    considerEntry(entry.node._tlEntry);
    for (const child of groupEntries(entry.node)) considerEntry(child._tlEntry);
  }
  return end;
}

function rangeText(range) {
  return range.end == null || range.end === range.start ? String(range.start) : range.start + '–' + range.end;
}

function summaryText(summary = {}, title = '') {
  const actionFact = summary.command || summary.query || summary.pattern || summary.search;
  const withoutTitle = value => value && !(` ${title} `).includes(' ' + value + ' ') ? value : '';
  return [
    withoutTitle(summary.fileName),
    summary.lineRange ? '行 ' + rangeText(summary.lineRange) : '',
    !summary.lineRange && summary.requestedRange ? '请求 ' + rangeText(summary.requestedRange) : '',
    withoutTitle(actionFact),
    Number.isInteger(summary.hitCount) ? summary.hitCount + ' 个命中' : '',
    Number.isInteger(summary.fileCount) ? summary.fileCount + ' 个文件' : '',
    Number.isInteger(summary.exitCode) ? '退出码 ' + summary.exitCode : '',
    summary.diffStat ? `+${summary.diffStat.added} −${summary.diffStat.removed}` : '',
    summary.children?.length ? summary.children.length + ' 个子代理' : '',
  ].filter(Boolean).join(' · ');
}

/* Use the last complete text rectangle at the clipping edge. A fixed line
 * height alone can cut through a glyph when Markdown mixes block margins,
 * list rows and paragraph typography. Cap the geometry work for large tasks. */
function completeTextHeight(segment, maximum) {
  const document = segment.ownerDocument;
  const range = document.createRange();
  if (typeof range.getClientRects !== 'function') return maximum;
  const top = segment.getBoundingClientRect().top;
  const edge = top + maximum;
  const text = document.createTreeWalker(segment, 4); // NodeFilter.SHOW_TEXT
  let last = top;
  for (let scanned = 0; scanned < 64 && text.nextNode(); scanned++) {
    const node = text.currentNode;
    if (!node.data.trim()) continue;
    range.setStart(node, 0);
    range.setEnd(node, Math.min(node.length, 1024));
    for (const rect of range.getClientRects()) {
      if (rect.top >= edge) return last > top ? Math.min(maximum, last - top + 1) : maximum;
      if (rect.bottom <= edge) last = Math.max(last, rect.bottom);
    }
  }
  return last > top ? Math.min(maximum, last - top + 1) : maximum;
}

function makeDisclosure(make, part, heading, className) {
  const node = make('div', className);
  if (part) node.dataset.executionPart = part;
  node.dataset.collapsible = '';
  const head = make('button', 'execution-head');
  head.type = 'button';
  const marker = make('span', 'execution-chevron');
  marker.setAttribute('aria-hidden', 'true');
  const title = make('span', 'execution-head-title', heading);
  const body = make('div', 'execution-body');
  body.id = 'execution-disclosure-' + ++sectionId;
  head.setAttribute('aria-controls', body.id);
  const setOpen = open => {
    if (!open && body.contains(head.ownerDocument.activeElement)) head.focus({ preventScroll: true });
    head.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
  };
  head.append(marker, title);
  node.append(head, body);
  setOpen(false);
  return { node, head, title, body, setOpen };
}

function taskPreview(host, toggle, preferences) {
  const win = host.ownerDocument.defaultView;
  let body = null;
  let segments = [];
  let expanded = preferences?.get('task') === true;
  let job = null;
  const inert = new Set();

  function resetClip() {
    for (const element of inert) element.removeAttribute('inert');
    inert.clear();
    for (const segment of segments) {
      segment.classList.remove('execution-task-clip');
      segment.style.removeProperty('--execution-task-height');
    }
  }

  function layout() {
    job = null;
    resetClip();
    if (!body?.isConnected || body.offsetWidth === 0) return;
    const style = win.getComputedStyle(body);
    const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5;
    let remaining = line * TASK_LINES;
    let long = false;
    for (const segment of segments) {
      const insets = segment === body
        ? Number.parseFloat(style.paddingTop || '0') + Number.parseFloat(style.paddingBottom || '0')
        : 0;
      const height = segment.scrollHeight - insets;
      if (height > remaining + 1) {
        long = true;
        if (!expanded) {
          segment.style.setProperty('--execution-task-height', completeTextHeight(segment, remaining + insets) + 'px');
          segment.classList.add('execution-task-clip');
          const bottom = segment.getBoundingClientRect().bottom + 0.5;
          for (const link of segment.querySelectorAll('a[href], button, [tabindex], summary, input')) {
            if (link.hasAttribute('inert') || link.getBoundingClientRect().bottom <= bottom) continue;
            if (link.contains(host.ownerDocument.activeElement)) toggle.focus({ preventScroll: true });
            link.setAttribute('inert', '');
            inert.add(link);
          }
        }
      }
      remaining = Math.max(0, remaining - height);
    }
    toggle.hidden = !long;
    write(toggle, expanded ? '收起全文' : '展开全文');
    toggle.setAttribute('aria-expanded', String(expanded));
  }

  const queue = () => {
    if (job === null && win?.requestAnimationFrame) job = win.requestAnimationFrame(layout);
  };
  const resize = typeof win?.ResizeObserver === 'function' ? new win.ResizeObserver(queue) : null;
  const rootStyle = typeof win?.MutationObserver === 'function' ? new win.MutationObserver(queue) : null;
  const bodyChange = typeof win?.MutationObserver === 'function' ? new win.MutationObserver(() => {
    update();
    queue();
  }) : null;
  if (rootStyle && resize) rootStyle.observe(host.ownerDocument.documentElement, {
    attributes: true, attributeFilter: ['style', 'class', 'data-font-scale'],
  });
  bodyChange?.observe(host, { childList: true, characterData: true, subtree: true });
  toggle.addEventListener('click', () => preserveScrollAround(toggle, () => {
    expanded = !expanded;
    preferences?.set('task', expanded);
    layout();
  }));

  function update() {
    const next = host.querySelector('.rtc-history-user-text, .msg.user .msg-body');
    if (next !== body) {
      resetClip();
      resize?.disconnect();
      body = next;
      if (body) resize?.observe(body);
    }
    if (!body) {
      toggle.hidden = true;
      segments = [];
      return;
    }
    const attachments = '.msg-file, .msg-att-chips';
    const children = [...body.children];
    const nextSegments = children.some(child => child.matches(attachments))
      ? children.filter(child => !child.matches(attachments))
      : [body];
    if (segments.some((segment, index) => segment !== nextSegments[index]) || nextSegments.length !== segments.length) {
      resetClip();
      segments = nextSegments;
      queue();
    }
    if (!body.id) body.id = 'execution-task-' + ++sectionId;
    if (toggle.getAttribute('aria-controls') !== body.id) toggle.setAttribute('aria-controls', body.id);
  }

  return {
    update,
    stop() {
      if (job !== null) win.cancelAnimationFrame(job);
      resize?.disconnect();
      rootStyle?.disconnect();
      bodyChange?.disconnect();
      resetClip();
    },
  };
}

function supportPlan(make, preferences) {
  const state = new WeakMap();
  let current = null;

  function clear() {
    if (!current) return;
    current.head.removeEventListener('click', current.onToggle);
    current.more.remove();
    current.parallel.remove();
    for (const row of current.list.children) row.hidden = false;
    current = null;
  }

  function update(node, turn) {
    if (node !== current?.node) {
      clear();
      const head = node?.querySelector('.plan-head');
      const list = node?.querySelector('.plan-list');
      if (!head || !list) return;
      const more = make('button', 'btn tiny ghost execution-plan-more');
      more.type = 'button';
      const parallel = make('span', 'execution-plan-parallel');
      const preferred = preferences?.get('plan');
      const choice = state.get(node) ?? { all: preferences?.get('plan-all') === true,
        manuallyToggled: typeof preferred === 'boolean', automatic: false };
      state.set(node, choice);
      const onToggle = () => {
        if (!choice.automatic) {
          choice.manuallyToggled = true;
          preferences?.set('plan', !list.hidden);
        }
        if (current) current.more.hidden = list.hidden || choice.all || list.children.length <= PLAN_PAGE;
      };
      current = { node, head, list, choice, more, parallel, onToggle, turn };
      node.append(more);
      head.insertBefore(parallel, head.querySelector('.plan-chev'));
      more.addEventListener('click', () => preserveScrollAround(head, () => {
        choice.all = true;
        preferences?.set('plan-all', true);
        update(node, current.turn);
        head.focus({ preventScroll: true });
      }));
      head.addEventListener('click', onToggle);
      if (typeof preferred === 'boolean' && preferred === list.hidden) {
        choice.automatic = true;
        head.click();
        choice.automatic = false;
      }
    }
    if (!current) return;
    current.turn = turn;
    const { head, list, choice, more, parallel } = current;
    const tasks = [...list.children];
    const active = ACTIVE.has(turn.status);
    const activeCount = tasks.filter(row => row.dataset.status === 'in_progress').length;
    const allDone = tasks.length && tasks.every(row => row.dataset.status === 'completed');
    if (!choice.manuallyToggled && !active && (allDone || tasks.length > PLAN_PAGE) && !list.hidden) {
      choice.automatic = true;
      head.click();
      choice.automatic = false;
    }
    const visible = active && !choice.all ? PLAN_PAGE : tasks.length;
    for (const [index, row] of tasks.entries()) row.hidden = index >= visible;
    more.hidden = list.hidden || tasks.length <= visible;
    write(more, '显示其余 ' + Math.max(0, tasks.length - visible) + ' 项');
    const activeOutsidePage = tasks.slice(visible).some(row => row.dataset.status === 'in_progress');
    write(parallel, activeCount > 1 || activeOutsidePage ? activeCount + (active ? ' 项进行中' : ' 项未完成') : '');
    parallel.hidden = !parallel.textContent;
  }

  return { update, clear };
}

/** Display descriptors for the summary row. Native nodes are already-owned
 * message/tool DOM; activity descriptors are the P5 read projection. */
function nativeWorkDescriptors(node, result) {
  if (!node?.matches) return;
  if (node.matches('.tl-group, .ui2-runtime-tools')) {
    const rows = [...node.querySelectorAll('.tl-item')];
    if (!rows.length) result.push({ kind: 'tool' });
    for (const row of rows) {
      const entry = row._tlEntry;
      result.push({ name: entry?.name, title: entry?.label, kind: entry?.kind,
        targetId: typeof entry?.path === 'string' ? entry.path : undefined });
    }
    return;
  }
  if (node.matches('.ui2-runtime-thinking, .think')) {
    result.push({ kind: 'thinking' });
    return;
  }
  result.push({ kind: 'progress' });
}

function workDescriptors(work, items) {
  const byId = new Map(items.map(item => [item.id, item]));
  const result = [];
  for (const entry of work) {
    if (entry.node) {
      nativeWorkDescriptors(entry.node, result);
      continue;
    }
    const item = byId.get(entry.activityId);
    if (!item) continue;
    result.push({
      kind: item.kind === 'tool' ? undefined : item.kind,
      name: item.toolName,
      title: item.title,
      // P5 already authorizes this display field; it is only used to count a
      // distinct file when every call of that kind carries one.
      targetId: typeof item.summary?.fileName === 'string' ? item.summary.fileName : undefined,
    });
  }
  return result;
}

function hasFailureStatus(value) {
  return ['error', 'failed', 'incomplete', 'interrupted', 'cancelled'].includes(value);
}

function nativeStatuses(work) {
  return work.flatMap(entry => entry.node?.matches?.('.tl-group')
    ? [...entry.node.querySelectorAll('.tl-item')].map(row => row.dataset.status)
    : entry.node?.dataset?.status ? [entry.node.dataset.status] : []);
}

function segmentActivityStatus(items, work, fallback = null) {
  const states = [...items.map(item => item.status), ...nativeStatuses(work)];
  if (states.some(status => ACTIVE.has(status))) return 'running';
  if (states.some(status => status === 'failed' || status === 'error')) return 'failed';
  if (states.some(status => hasFailureStatus(status))) return 'incomplete';
  return fallback || (items.length || work.length ? 'completed' : 'unknown');
}

function makeActivityRow(make, item, expanded, onToggle) {
  const row = makeDisclosure(make, '', '', 'execution-activity-item');
  const icon = make('span', 'execution-activity-icon');
  icon.setAttribute('aria-hidden', 'true');
  const facts = make('span', 'execution-activity-facts');
  const status = make('span', 'execution-activity-status');
  const time = make('span', 'execution-time');
  const nativeSlot = make('div', 'execution-tool-native');
  const notice = make('p', 'execution-detail-note');
  const detailFacts = make('p', 'execution-detail-note execution-detail-facts');
  const error = make('p', 'execution-detail-note execution-error');
  const childList = make('ul', 'execution-detail-children');
  /* Same flat row as a native tool call: glyph, label, chevron at the far
   * right. Status and elapsed time remain in the DOM (and on hover) rather
   * than repeating a green "已完成 0.8s" suffix on every line. */
  row.head.prepend(icon);
  const marker = row.head.querySelector('.execution-chevron');
  row.head.append(facts, status, time, marker);
  row.body.append(error, detailFacts, childList, nativeSlot, notice);

  let adopted = null;
  let latest = item;
  let native = null;
  let observer = null;
  let childSignature = '';

  function restore() {
    observer?.disconnect();
    observer = null;
    if (!adopted) return;
    setEntryExpanded(adopted.element, adopted.expanded);
    if (adopted.anchor.parentNode) adopted.anchor.replaceWith(adopted.element);
    else adopted.element.remove();
    adopted = null;
  }

  function syncNative() {
    const available = adopted && (!adopted.element.matches('.tl-item') || setEntryExpanded(adopted.element, true));
    notice.hidden = Boolean(available);
    if (available) return;
    const restricted = latest.detailRef?.state === 'restricted';
    const pending = !restricted && (latest.detailRef?.state === 'pending' || ACTIVE.has(latest.status));
    write(notice, restricted ? '当前视图无权读取详情' : pending ? '详情暂未返回' : '详情暂不可用');
  }

  function paintDetails() {
    if (row.body.hidden) return;
    if (adopted?.element !== native) restore();
    if (!adopted && native) {
      const anchor = native.ownerDocument.createComment('execution-tool');
      if (native.parentNode) native.before(anchor);
      adopted = { element: native, anchor, expanded: isEntryExpanded(native) };
      nativeSlot.append(native);
      const toggle = native.querySelector('.tl-toggle');
      const Observer = native.ownerDocument.defaultView?.MutationObserver;
      if (toggle && Observer) {
        observer = new Observer(syncNative);
        observer.observe(toggle, { attributes: true, attributeFilter: ['hidden'] });
      }
    }
    syncNative();
    write(detailFacts, adopted ? '' : summaryText(latest.summary));
    detailFacts.hidden = !detailFacts.textContent;
    error.hidden = !latest.issue?.displayText;
    write(error, latest.issue?.displayText || '');
    const children = adopted ? [] : latest.summary?.children ?? [];
    const signature = JSON.stringify(children);
    childList.hidden = children.length === 0;
    if (signature !== childSignature) {
      childSignature = signature;
      childList.replaceChildren(...children.map(child =>
        make('li', '', [label(child.status), child.model].filter(Boolean).join(' · '))));
    }
  }

  row.head.addEventListener('click', () => preserveScrollAround(row.head, () => {
    const open = row.body.hidden;
    row.setOpen(open);
    onToggle(open);
    if (open) paintDetails();
    else restore();
  }));
  row.setOpen(expanded);

  function tick(now) {
    write(time, rowDuration(latest.timing, latest.status, now));
  }

  return {
    node: row.node, restore, tick,
    active: () => ACTIVE.has(latest.status),
    update(value, detail, now) {
      latest = value;
      native = detail || null;
      row.node.dataset.status = value.status;
      row.node.dataset.anchorId = 'activity-' + value.id;
      write(row.title, value.kind === 'compaction' ? '压缩上下文' : value.title);
      const iconName = workIconName({
        kind: value.kind === 'tool' ? undefined : value.kind,
        name: value.toolName,
        title: value.title,
      });
      if (icon.dataset.icon !== iconName) {
        icon.dataset.icon = iconName;
        icon.innerHTML = iconMarkup(iconName); // local constant only
      }
      write(facts, summaryText(value.summary, row.title.textContent));
      if (facts.title !== facts.textContent) facts.title = facts.textContent;
      write(status, label(value.status));
      tick(now);
      paintDetails();
    },
  };
}

export function createExecutionTurnView({ document = globalThis.document, now = Date.now, preferences } = {}) {
  function make(tag, className, value = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value) element.textContent = value;
    return element;
  }
  function section(name) {
    const element = make('div', 'execution-part');
    element.dataset.executionPart = name;
    return element;
  }
  function render(element, nodes) {
    order(element, nodes);
    element.hidden = nodes.length === 0;
  }
  const node = make('section', 'execution-turn');
  const task = section('input');
  const taskContent = make('div', 'execution-task-content');
  const taskToggle = make('button', 'btn tiny ghost execution-task-more');
  taskToggle.type = 'button';
  taskToggle.hidden = true;
  task.append(taskContent, taskToggle);
  const preview = taskPreview(taskContent, taskToggle, preferences);
  const planSlot = section('plan');
  const planControl = supportPlan(make, preferences);
  const activityFlow = section('activity-flow');
  const thinking = section('thinking');
  const answer = section('answer');
  const outcomes = section('outcome');
  node.append(task, planSlot, activityFlow, thinking, answer, outcomes);

  const rows = new Map();
  const openRows = new Set();
  let timer = null;

  function stopClock() {
    if (timer !== null) document.defaultView.clearInterval(timer);
    timer = null;
  }

  function makeSegment(key, part, anchorId) {
    const disclosure = makeDisclosure(make, part, '', 'execution-activity-group');
    const icon = make('span', 'execution-work-icon');
    icon.setAttribute('aria-hidden', 'true');
    const summary = make('span', 'execution-activity-summary');
    const status = make('span', 'execution-activity-status');
    const meta = make('span', 'execution-activity-count');
    const time = make('span', 'execution-time');
    disclosure.head.prepend(icon);
    disclosure.title.after(summary);
    disclosure.head.append(status, meta, time);
    disclosure.head.append(disclosure.head.querySelector('.execution-chevron'));
    const list = make('div', 'execution-activity-list execution-work-list');
    list.dataset.executionPart = part === 'activity' ? 'progress' : 'progress-continued';
    const pager = make('div', 'execution-activity-pager');
    const prevPage = make('button', 'btn tiny ghost execution-activity-earlier');
    prevPage.type = 'button';
    const pageRange = make('span', 'execution-activity-range');
    const nextPage = make('button', 'btn tiny ghost execution-activity-more');
    nextPage.type = 'button';
    pager.append(prevPage, pageRange, nextPage);
    disclosure.body.append(pager, list);
    if (anchorId) disclosure.node.dataset.anchorId = anchorId;

    const preferenceKey = part === 'activity' ? 'activity' : 'activity:' + key;
    let choice = preferences?.get(preferenceKey);
    if (part === 'activity' && typeof choice !== 'boolean') choice = preferences?.get('progress');
    let chosen = typeof choice === 'boolean';
    disclosure.setOpen(choice === true);
    list.hidden = disclosure.body.hidden;

    let items = EMPTY_NODES;
    let work = EMPTY_NODES;
    let pageStart = 0;
    let pageEnd = 0;
    let pageAnchor = null;
    let pageLength = ACTIVITY_PAGE;
    let timing = null;
    let turnStatus = '';
    let continued = false;
    let note = '';
    let summaryTextValue = '';
    let statusValue = '';
    let countText = '';
    let labelText = '';

    function setOpenRow(id, open) {
      preferences?.set('activity-item:' + id, open);
      openRows.delete(id);
      if (!open) return;
      openRows.add(id);
      if (openRows.size > MAX_OPEN_ACTIVITIES) openRows.delete(openRows.values().next().value);
    }

    function alignWork() {
      order(list, work.map(entry => entry.node || rows.get(entry.activityId)?.node).filter(Boolean));
      list.hidden = disclosure.body.hidden;
    }

    function removeRows() {
      for (const row of rows.values()) row.restore();
      rows.clear();
      // Native progress stays searchable while folded; only tool detail rows
      // are lazy/windowed. Never discard an adopted message to close a panel.
      order(list, work.filter(entry => entry.node).map(entry => entry.node));
    }

    function renderRows() {
      if (disclosure.body.hidden) return;
      const total = items.length;
      const anchoredIndex = pageAnchor === null ? -1 : items.findIndex(item => item.id === pageAnchor);
      const firstPage = ACTIVE.has(statusValue) ? Math.max(0, total - ACTIVITY_PAGE) : 0;
      pageStart = anchoredIndex >= 0 ? anchoredIndex : pageAnchor === null ? firstPage : Math.min(pageStart, Math.max(0, total - 1));
      pageEnd = Math.min(total, pageStart + pageLength);
      const subset = items.slice(pageStart, pageEnd);
      pageAnchor = subset[0]?.id ?? null;
      const visible = new Set(subset.map(item => item.id));
      for (const [id, row] of rows) {
        if (visible.has(id)) continue;
        if (row.node.contains(document.activeElement)) disclosure.head.focus({ preventScroll: true });
        row.restore();
        row.node.remove();
        rows.delete(id);
      }
      const instant = now();
      for (const item of subset) {
        if (!rows.has(item.id)) rows.set(item.id, makeActivityRow(make, item,
          openRows.has(item.id) || preferences?.get('activity-item:' + item.id) === true,
          open => setOpenRow(item.id, open)));
        const row = rows.get(item.id);
        row.update(item, currentDetails.get(item.id), instant);
      }
      alignWork();
      prevPage.hidden = pageStart === 0;
      nextPage.hidden = pageEnd === total;
      pager.hidden = prevPage.hidden && nextPage.hidden;
      write(prevPage, '显示更早记录（' + (Math.max(0, pageStart - ACTIVITY_PAGE) + 1) + '–' + pageStart + '）');
      write(pageRange, (pageStart + 1) + '–' + pageEnd + ' / ' + total);
      write(nextPage, '显示较新记录（' + (pageEnd + 1) + '–' + Math.min(total, pageEnd + ACTIVITY_PAGE) + '）');
    }

    function movePage(earlier) {
      const control = earlier ? prevPage : nextPage;
      if (control.hidden) return;
      preserveScrollAround(pager, () => {
        const start = earlier ? Math.max(0, pageStart - ACTIVITY_PAGE) : pageEnd;
        pageLength = earlier ? pageStart - start : ACTIVITY_PAGE;
        pageAnchor = items[start]?.id ?? null;
        renderRows();
        if (control.hidden) {
          const otherControl = earlier ? nextPage : prevPage;
          (otherControl.hidden ? disclosure.head : otherControl).focus({ preventScroll: true });
        }
      });
    }

    disclosure.head.addEventListener('click', () => preserveScrollAround(disclosure.head, () => {
      const opening = disclosure.body.hidden;
      chosen = true;
      choice = opening;
      disclosure.setOpen(opening);
      preferences?.set(preferenceKey, opening);
      if (opening) renderRows();
      else removeRows();
      alignWork();
    }));
    prevPage.addEventListener('click', () => movePage(true));
    nextPage.addEventListener('click', () => movePage(false));

    function paintLabel(instant) {
      labelText = turnFoldLabel({ status: turnStatus, timing, now: instant, continued });
      const visible = labelText + (note ? ' · ' + note : '');
      write(disclosure.title, visible || '工作记录');
      const accessible = [visible, summaryTextValue, countText].filter(Boolean).join(' · ');
      if (disclosure.head.title !== accessible) disclosure.head.title = accessible;
      write(status, '');
      write(time, '');
    }

    return {
      key, node: disclosure.node, head: disclosure.head, body: disclosure.body,
      list,
      setOpen: disclosure.setOpen,
      update({ items: nextItems, work: nextWork, group, turnStatus: nextTurnStatus, timing: nextTiming,
        continued: isContinued, note: nextNote, now: instant }) {
        items = nextItems;
        work = nextWork;
        turnStatus = nextTurnStatus || '';
        timing = nextTiming || null;
        continued = isContinued === true;
        statusValue = segmentActivityStatus(items, work, group?.status || null);
        note = nextNote || '';
        disclosure.node.dataset.status = statusValue;
        disclosure.node.dataset.turnStatus = turnStatus;
        disclosure.node.dataset.attention = note || hasFailureStatus(statusValue) ? 'true' : 'false';
        disclosure.node.dataset.continued = continued ? 'true' : 'false';
        disclosure.node.dataset.single = items.length + work.length <= 1 ? 'true' : 'false';
        const descriptors = workDescriptors(work, items);
        summaryTextValue = workSummary(descriptors) || (work.length ? work.length + ' 项工作记录' : '');
        write(summary, summaryTextValue);
        const activeCount = items.filter(item => ACTIVE.has(item.status)).length;
        const failed = items.filter(item => item.status === 'failed').length;
        countText = [items.length ? items.length + ' 项' : work.length ? work.length + ' 条记录' : '',
          activeCount > 1 ? activeCount + ' 项同时执行' : '', failed ? failed + ' 项失败' : '']
          .filter(Boolean).join(' · ');
        write(meta, countText);
        const summaryIcon = workSummaryIcon(descriptors);
        const iconName = turnStatus === 'failed' || statusValue === 'failed' ? 'circleAlert'
          : ['interrupted', 'cancelled', 'stopped'].includes(turnStatus) ? 'stop'
            : turnStatus === 'incomplete' || statusValue === 'incomplete' ? 'warning'
              : summaryIcon;
        if (icon.dataset.icon !== iconName) {
          icon.dataset.icon = iconName;
          icon.innerHTML = iconMarkup(iconName); // local constant only
        }
        paintLabel(instant);
        const active = items.some(item => ACTIVE.has(item.status))
          || nativeStatuses(work).some(status => status === 'running' || status === 'waiting')
          || isActiveTurnStatus(turnStatus);
        const attention = items.some(item => hasFailureStatus(item.status))
          || nativeStatuses(work).some(hasFailureStatus);
        const wantsOpen = chosen ? choice === true : active || attention;
        if (wantsOpen !== !disclosure.body.hidden) disclosure.setOpen(wantsOpen);
        disclosure.node.hidden = items.length === 0 && work.length === 0;
        if (disclosure.body.hidden || !items.length) removeRows();
        if (!disclosure.body.hidden) renderRows();
        alignWork();
        return { active, hidden: disclosure.node.hidden };
      },
      paint(instant) {
        paintLabel(instant);
        if (disclosure.body.hidden) return;
        for (const row of rows.values()) if (row.active()) row.tick(instant);
      },
      contains(target) {
        return disclosure.body.contains(target);
      },
      reveal() {
        if (!disclosure.body.hidden) return false;
        disclosure.setOpen(true);
        renderRows();
        alignWork();
        return true;
      },
      cleanup() {
        for (const row of rows.values()) row.restore();
        rows.clear();
      },
    };
  }

  const main = makeSegment('main', 'activity', null);
  const segments = new Map([['main', main]]);
  let currentItems = EMPTY_NODES;
  let currentDetails = EMPTY_DETAILS;

  function tick() {
    if (!node.isConnected) {
      stopClock();
      return;
    }
    const instant = now();
    let active = false;
    for (const segment of segments.values()) {
      segment.paint(instant);
      active ||= segment.node.dataset.status === 'running' || segment.node.dataset.status === 'waiting'
        || segment.node.dataset.turnStatus === 'running' || segment.node.dataset.turnStatus === 'waiting';
    }
    if (!active) stopClock();
  }

  function update({
    turn, group, items = EMPTY_NODES, input, plan, progress: process = EMPTY_NODES, steers = EMPTY_NODES,
    thinking: activeThinking = EMPTY_NODES, answer: final = EMPTY_NODES, outcomes: terminal = EMPTY_NODES,
    details = EMPTY_DETAILS, workOrder = null, boundaries = EMPTY_NODES,
  }) {
    node.dataset.executionTurn = turn.id;
    node.dataset.status = turn.status;
    render(taskContent, input ? [input] : []);
    preview.update();
    render(planSlot, plan ? [plan] : []);
    planControl.update(plan, turn);

    currentItems = group?.turnId === turn.id
      ? items.filter(item => item.turnId === turn.id && item.parentId === group.id)
        .sort((first, second) => first.position.sequence - second.position.sequence || first.position.part - second.position.part)
      : EMPTY_NODES;
    currentDetails = details;
    const native = new Set([...process, ...steers, ...boundaries]);
    const ids = new Set(currentItems.map(item => item.id));
    const seenNodes = new Set(), seenIds = new Set();
    const validOrder = Array.isArray(workOrder) && workOrder.every(entry => {
      if (entry.steer) {
        if (entry.node && native.has(entry.node) && !seenNodes.has(entry.node)) { seenNodes.add(entry.node); return true; }
        return false;
      }
      if (entry.node && native.has(entry.node) && !seenNodes.has(entry.node)) { seenNodes.add(entry.node); return true; }
      if (ids.has(entry.activityId) && !seenIds.has(entry.activityId)) { seenIds.add(entry.activityId); return true; }
      return false;
    }) && seenNodes.size === native.size && seenIds.size === ids.size;
    const orderedWork = validOrder ? workOrder
      : [...process.map(node => ({ node })), ...steers.map(node => ({ node, steer: true })),
        ...currentItems.map(item => ({ activityId: item.id })), ...boundaries.map(node => ({ node, boundary: true }))];

    // Split the actual ordered work entries at user steer nodes. A steer is a
    // real user message, so it stays visible between two work folds; only the
    // work around it is collapsed.
    const parts = [{ key: 'main', steers: [], entries: [], startedAt: null, index: 0 }];
    for (const entry of orderedWork) {
      const tail = parts[parts.length - 1];
      if ((entry.steer || entry.boundary) && entry.node) {
        if (!tail.entries.length && tail.steers.length) {
          tail.steers.push(entry.node);
          if (Number.isFinite(entry.startedAt)) tail.startedAt = entry.startedAt;
        } else {
          parts.push({ key: entry.steerKey || entry.node.dataset?.anchorId || entry.node.dataset?.blockId
            || 'steer:' + parts.length, steers: [entry.node], entries: [],
          startedAt: Number.isFinite(entry.startedAt) ? entry.startedAt : null, index: parts.length });
        }
      } else tail.entries.push(entry);
    }

    const flow = [];
    const used = new Set();
    for (const [index, part] of parts.entries()) {
      const segment = index === 0 ? main : (segments.get(part.key)
        || makeSegment(part.key, 'activity-continued', null));
      if (index > 0) segments.set(part.key, segment);
      used.add(part.key);
      const partItems = part.entries.filter(entry => entry.activityId)
        .map(entry => currentItems.find(item => item.id === entry.activityId)).filter(Boolean);
      const normalizedWork = part.entries.filter(entry => entry.node
        || partItems.some(item => item.id === entry.activityId));
      const notes = activityNote([...partItems.map(item => item.status), ...nativeStatuses(normalizedWork)]);
      const segmentNote = isAbnormalTurnStatus(turn.status) ? '' : notes;
      const partEnd = latestEnd(part.entries, partItems);
      const lastPart = index === parts.length - 1;
      const segmentEnd = lastPart && Number.isFinite(turn.timing?.endedAt)
        ? turn.timing.endedAt : partEnd;
      const timing = index === 0 ? turn.timing
        : part.startedAt !== null ? {
          startedAt: part.startedAt,
          endedAt: segmentEnd,
          evidence: Number.isFinite(segmentEnd)
            ? turn.timing?.evidence === 'estimated' ? 'estimated' : 'observed' : 'unknown',
        } : null;
      const result = segment.update({
        items: partItems, work: normalizedWork, group: index === 0 ? group : null,
        turnStatus: turn.status, timing, continued: index > 0, note: segmentNote, now: now(),
      });
      if (index > 0) {
        for (const steer of part.steers) flow.push(steer);
      }
      if (!result.hidden) flow.push(segment.node);
    }
    for (const [key, segment] of [...segments]) {
      if (used.has(key)) continue;
      segment.cleanup();
      segment.node.remove();
      segments.delete(key);
    }
    order(activityFlow, flow);
    activityFlow.hidden = flow.length === 0;

    render(thinking, activeThinking);
    render(answer, final);
    render(outcomes, terminal);

    if (isActiveTurnStatus(turn.status) && Number.isFinite(turn.timing?.startedAt)) {
      if (timer === null && document.defaultView) timer = document.defaultView.setInterval(tick, 1000);
    } else stopClock();
  }

  return {
    node, update,
    reveal(messageNode) {
      for (const segment of segments.values()) {
        if (segment.contains(messageNode) && segment.reveal()) return;
      }
    },
    release() {
      stopClock();
      preview.stop();
      planControl.clear();
      for (const segment of segments.values()) segment.cleanup();
      node.remove();
    },
  };
}
