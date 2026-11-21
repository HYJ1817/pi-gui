/* Shared, live execution-turn layout. Hosts supply their authorized native message
 * and tool nodes. The layout never requests data or revises the P5-A event model. */
import { renderUsageMeta } from './message-meta.js';
import { preserveScrollAround } from './reading-position.js';
import { isEntryExpanded, setEntryExpanded } from './tool-view.js';
import { formatTurnDuration } from './turn-outcome.js';

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

function order(parent, nodes) {
  const focused = parent.ownerDocument.activeElement;
  let cursor = parent.firstChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextSibling;
    else if (parent.moveBefore && parent.isConnected && node.isConnected) parent.moveBefore(node, cursor);
    else parent.insertBefore(node, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
  if (focused && focused !== parent.ownerDocument.activeElement && parent.contains(focused)) {
    focused.focus({ preventScroll: true });
  }
}

function duration(timing, status, now) {
  if (!timing || timing.evidence === 'unknown') return '';
  const milliseconds = timing.durationMs ?? (Number.isFinite(timing.startedAt)
    ? (timing.endedAt ?? (ACTIVE.has(status) ? now : NaN)) - timing.startedAt
    : NaN);
  const formatted = formatTurnDuration(milliseconds);
  return formatted && timing.evidence === 'estimated' ? '约 ' + formatted : formatted;
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

function taskPreview(host, toggle) {
  const win = host.ownerDocument.defaultView;
  let body = null;
  let segments = [];
  let expanded = false;
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

function supportPlan(make) {
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
      const choice = state.get(node) ?? { all: false, manuallyToggled: false, automatic: false };
      state.set(node, choice);
      const onToggle = () => {
        if (!choice.automatic) choice.manuallyToggled = true;
        if (current) current.more.hidden = list.hidden || choice.all || list.children.length <= PLAN_PAGE;
      };
      current = { node, head, list, choice, more, parallel, onToggle, turn };
      node.append(more);
      head.insertBefore(parallel, head.querySelector('.plan-chev'));
      more.addEventListener('click', () => preserveScrollAround(head, () => {
        choice.all = true;
        update(node, current.turn);
        head.focus({ preventScroll: true });
      }));
      head.addEventListener('click', onToggle);
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

function makeActivityRow(make, item, expanded, onToggle) {
  const row = makeDisclosure(make, '', '', 'execution-activity-item');
  const facts = make('span', 'execution-activity-facts');
  const status = make('span', 'execution-activity-status');
  const time = make('span', 'execution-time');
  const nativeSlot = make('div', 'execution-tool-native');
  const notice = make('p', 'execution-detail-note');
  const detailFacts = make('p', 'execution-detail-note execution-detail-facts');
  const error = make('p', 'execution-detail-note execution-error');
  const childList = make('ul', 'execution-detail-children');
  row.head.append(facts, status, time);
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
    write(time, duration(latest.timing, latest.status, now));
  }

  return {
    node: row.node, restore, tick,
    active: () => ACTIVE.has(latest.status),
    update(value, detail, now) {
      latest = value;
      native = detail || null;
      row.node.dataset.status = value.status;
      write(row.title, value.kind === 'compaction' ? '压缩上下文' : value.title);
      write(facts, summaryText(value.summary, row.title.textContent));
      if (facts.title !== facts.textContent) facts.title = facts.textContent;
      write(status, label(value.status));
      tick(now);
      paintDetails();
    },
  };
}

export function createExecutionTurnView({ document = globalThis.document, now = Date.now } = {}) {
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
  const preview = taskPreview(taskContent, taskToggle);
  const planSlot = section('plan');
  const planControl = supportPlan(make);
  const activity = makeDisclosure(make, 'activity', '执行活动', 'execution-activity-group');
  const groupStatus = make('span', 'execution-activity-status');
  const groupMeta = make('span', 'execution-activity-count');
  const groupTime = make('span', 'execution-time');
  activity.head.append(groupStatus, groupMeta, groupTime);
  const rowList = make('div', 'execution-activity-list');
  const pager = make('div', 'execution-activity-pager');
  const prevPage = make('button', 'btn tiny ghost execution-activity-earlier');
  prevPage.type = 'button';
  const pageRange = make('span', 'execution-activity-range');
  const nextPage = make('button', 'btn tiny ghost execution-activity-more');
  nextPage.type = 'button';
  pager.append(prevPage, pageRange, nextPage);
  activity.body.append(pager, rowList);

  const progress = makeDisclosure(make, 'progress', '执行过程', 'execution-progress');
  const thinking = section('thinking');
  const answer = section('answer');
  const outcomes = section('outcome');
  const usage = makeDisclosure(make, 'usage', '用量与耗时', 'execution-usage');
  node.append(task, planSlot, activity.node, progress.node, thinking, answer, outcomes, usage.node);

  const rows = new Map();
  const ledger = new Map();
  let currentGroup = null;
  let currentItems = [];
  let sourceItems = EMPTY_NODES;
  let currentDetails = EMPTY_DETAILS;
  let pageStart = 0;
  let pageEnd = 0;
  let pageAnchor = null;
  let pageLength = ACTIVITY_PAGE;
  const openRows = new Set();
  let timer = null;
  let explicitProgress = false;

  function tick() {
    if (!node.isConnected) {
      stopClock();
      return;
    }
    const instant = now();
    write(groupTime, duration(currentGroup?.timing, currentGroup?.status, instant));
    if (activity.body.hidden) return;
    for (const row of rows.values()) if (row.active()) row.tick(instant);
  }

  function stopClock() {
    if (timer !== null) document.defaultView.clearInterval(timer);
    timer = null;
  }

  function removeRows() {
    for (const row of rows.values()) row.restore();
    rows.clear();
    rowList.replaceChildren();
  }

  function setOpenRow(id, open) {
    openRows.delete(id);
    if (!open) return;
    openRows.add(id);
    if (openRows.size > MAX_OPEN_ACTIVITIES) openRows.delete(openRows.values().next().value);
  }

  function renderRows() {
    if (activity.body.hidden) return;
    const total = currentItems.length;
    const anchoredIndex = pageAnchor === null ? -1 : currentItems.findIndex(item => item.id === pageAnchor);
    const firstPage = ACTIVE.has(currentGroup?.status) ? Math.max(0, total - ACTIVITY_PAGE) : 0;
    pageStart = anchoredIndex >= 0 ? anchoredIndex : pageAnchor === null ? firstPage : Math.min(pageStart, Math.max(0, total - 1));
    pageEnd = Math.min(total, pageStart + pageLength);
    const subset = currentItems.slice(pageStart, pageEnd);
    pageAnchor = subset[0]?.id ?? null;
    const visible = new Set(subset.map(item => item.id));
    for (const [id, row] of rows) {
      if (visible.has(id)) continue;
      if (row.node.contains(document.activeElement)) activity.head.focus({ preventScroll: true });
      row.restore();
      row.node.remove();
      rows.delete(id);
    }
    const instant = now();
    const ordered = subset.map(item => {
      if (!rows.has(item.id)) rows.set(item.id, makeActivityRow(make, item, openRows.has(item.id),
        open => setOpenRow(item.id, open)));
      const row = rows.get(item.id);
      row.update(item, currentDetails.get(item.id), instant);
      return row.node;
    });
    order(rowList, ordered);
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
      pageAnchor = currentItems[start]?.id ?? null;
      renderRows();
      if (control.hidden) {
        const otherControl = earlier ? nextPage : prevPage;
        (otherControl.hidden ? activity.head : otherControl).focus({ preventScroll: true });
      }
    });
  }

  activity.head.addEventListener('click', () => preserveScrollAround(activity.head, () => {
    const opening = activity.body.hidden;
    activity.setOpen(opening);
    if (!explicitProgress) progress.setOpen(opening);
    if (opening) renderRows();
    else removeRows();
  }));
  prevPage.addEventListener('click', () => movePage(true));
  nextPage.addEventListener('click', () => movePage(false));
  progress.head.addEventListener('click', () => preserveScrollAround(progress.head, () => {
    explicitProgress = true;
    progress.setOpen(progress.body.hidden);
  }));
  usage.head.addEventListener('click', () => preserveScrollAround(usage.head, () => usage.setOpen(usage.body.hidden)));

  function update({
    turn, group, items = EMPTY_NODES, input, plan, progress: process = EMPTY_NODES, thinking: activeThinking = EMPTY_NODES,
    answer: final = EMPTY_NODES, outcomes: terminal = EMPTY_NODES, details = EMPTY_DETAILS, usage: existingUsage = EMPTY_NODES,
  }) {
    node.dataset.executionTurn = turn.id;
    node.dataset.status = turn.status;
    render(taskContent, input ? [input] : []);
    preview.update();
    render(planSlot, plan ? [plan] : []);
    planControl.update(plan, turn);

    const nextGroup = group?.turnId === turn.id ? group : null;
    if (currentGroup !== nextGroup || sourceItems !== items || currentDetails !== details) {
      currentGroup = nextGroup;
      sourceItems = items;
      currentItems = currentGroup ? items.filter(item => item.turnId === turn.id && item.parentId === group.id)
        .sort((first, second) => first.position.sequence - second.position.sequence || first.position.part - second.position.part) : [];
      currentDetails = details;
      if (currentItems.length) {
        const activeItem = currentItems.find(item => item.id === currentGroup.activeItemId);
        const activeCount = currentItems.filter(item => ACTIVE.has(item.status)).length;
        const failed = currentItems.filter(item => item.status === 'failed').length;
        activity.node.dataset.status = currentGroup.status;
        write(activity.title, activeItem?.kind === 'compaction' ? '压缩上下文' : activeItem?.title || '执行活动');
        write(groupStatus, label(currentGroup.status));
        write(groupMeta, [currentItems.length + ' 项', activeCount > 1 ? activeCount + ' 项同时执行' : '',
          failed ? failed + ' 项失败' : ''].filter(Boolean).join(' · '));
        write(groupTime, duration(currentGroup.timing, currentGroup.status, now()));
        renderRows();
      } else {
        removeRows();
        pageAnchor = null;
        pageLength = ACTIVITY_PAGE;
        openRows.clear();
      }
    }
    activity.node.hidden = currentItems.length === 0;
    if (ACTIVE.has(currentGroup?.status) && Number.isFinite(currentGroup?.timing?.startedAt)) {
      if (timer === null && document.defaultView) timer = document.defaultView.setInterval(tick, 1000);
    } else stopClock();

    order(progress.body, process);
    progress.node.hidden = process.length === 0;
    render(thinking, activeThinking);
    render(answer, final);
    render(outcomes, terminal);

    const wanted = new Set();
    const usageNodes = [...existingUsage];
    for (const response of turn.usage ?? []) {
      const id = response.responseId;
      if (!id || wanted.has(id)) continue;
      wanted.add(id);
      const model = [response.model?.provider, response.model?.id].filter(Boolean).join(' / ');
      const signature = JSON.stringify([response.recorded, model]);
      let row = ledger.get(id);
      if (row?.signature !== signature) {
        const meta = renderUsageMeta(response.recorded, { label: '助手响应的用量' });
        if (!meta) continue;
        const entry = make('div', 'execution-usage-entry');
        if (model) entry.append(make('div', 'execution-usage-model', model));
        entry.append(meta);
        row = { signature, entry };
        ledger.set(id, row);
      }
      usageNodes.push(row.entry);
    }
    for (const id of ledger.keys()) if (!wanted.has(id)) ledger.delete(id);
    const elapsed = duration(turn.timing, turn.status, now());
    if (elapsed && !ACTIVE.has(turn.status)) {
      let clock = usage.body.querySelector('.execution-usage-duration');
      if (!clock) clock = make('div', 'execution-usage-duration');
      write(clock, '任务耗时 ' + elapsed);
      usageNodes.push(clock);
    }
    order(usage.body, usageNodes);
    usage.node.hidden = usageNodes.length === 0;
  }

  return {
    node, update,
    release() {
      stopClock();
      preview.stop();
      planControl.clear();
      for (const row of rows.values()) row.restore();
      node.remove();
    },
  };
}
