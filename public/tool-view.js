import { iconMarkup } from './ui/icons.js';
import { workIconName } from './ui/work-presentation.js';
/* Tool Timeline 的视图层。
 *
 * 只做一件事：把一条 ToolEntry 画成 DOM，以及在它变化时**就地更新**。
 * 实时事件和历史重建都走这里 —— 两边渲染出的东西必须长得一模一样，
 * 否则「刷新前后语义一致」这条要求（§21）根本无从谈起。
 *
 * ---------- 安全模型（§16） ----------
 *
 * 工具的一切内容都是**不可信输入**：command / path / query 来自模型，
 * stdout / stderr / result 来自被执行的程序，两者都可能被诱导产出
 * `<script>`、`<img onerror=…>`、`javascript:` 之类的东西。
 *
 * 所以本文件**一次 innerHTML 都不用**（除了自己写死的 SVG 图标常量）。
 * 所有来自 entry 的文本一律走 textContent / createTextNode —— 这样转义这件事
 * 根本不需要被记住，因为压根没有解析 HTML 的机会。
 *
 * ---------- 性能（§17） ----------
 *
 * 子节点引用缓存在节点自身上（node._tl），更新时只改变化的那几个 ——
 * 不重建子树，也不做 querySelector 全量查找。流式输出每个 chunk 都重建 DOM
 * 会让长时间命令（npm test 能吐几千行）把主线程堵死。 */

import { formatDuration, previewOf, statOf } from './tool-model.js';
import { preserveScrollAround } from './reading-position.js';
import { preserveTextSelection } from './ui/text-selection.js';
import { webActivity, webSourceLink } from './web-activity.js';
import { subagentActivity } from './subagent-activity.js';
import { memoryActivity } from './memory-activity.js';
import { browserActivity } from './browser-activity.js';
import { guiBrowserActivity } from './gui-browser-activity.js';
import { processActivity } from './process-activity.js';
import { htmlArtifactActivity } from './html-artifact-activity.js';
import { mcpActivity } from './mcp-activity.js';
import { noteUnknownTool } from './schema-drift.js';

const STATUS_TEXT = {
  running: '运行中',
  waiting: '等待写入',
  success: '成功',
  error: '失败',
  incomplete: '未完成',
  interrupted: '已中断',
  cancelled: '已取消',
  unknown: '状态未知',
};

/* 子代理子项状态只映射白名单值；未知值保持「状态未知」，不猜完成度。 */
const SUBAGENT_STATE_TEXT = {
  pending: '等待',
  queued: '排队',
  running: '运行中',
  complete: '成功',
  completed: '成功',
  failed: '失败',
  partial: '部分完成',
  paused: '已暂停',
  stopped: '已停止',
  detached: '已脱离',
  rejected: '已拒绝',
  interrupted: '已中断',
  unknown: '状态未知',
};

/** 详细参数里最多铺多少字符。原始 JSON 可能有几十 KB（write 的 content 全文），
 *  不截断会把时间线撑成一片墙。 */
const ARGS_MAX = 4000;
let detailId = 0;

/* ---------- 建节点 ---------- */

function sub(parent, cls, tag = 'div') {
  const n = document.createElement(tag);
  n.className = cls;
  parent.appendChild(n);
  return n;
}

/**
 * 画一条 entry。
 * @returns {HTMLElement} 节点；子引用缓存在 node._tl 上，供 updateEntry 复用
 */
export function renderEntry(entry, onExpanded) {
  const node = document.createElement('div');
  node.className = 'tl-item';
  node.dataset.id = entry.id;

  const dot = sub(node, 'tl-dot', 'span');
  const body = sub(node, 'tl-body');

  const head = sub(body, 'tl-head');
  const label = sub(head, 'tl-label', 'span');
  const statusText = sub(head, 'tl-status', 'span');
  const arg = sub(head, 'tl-arg', 'span');
  const stat = sub(head, 'tl-stat', 'span');
  const time = sub(head, 'tl-time', 'span');

  const acts = sub(head, 'tl-acts');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'tl-toggle';
  toggle.innerHTML = iconMarkup('chevronRight'); // Local icon only.
  const toggleCaption = sub(toggle, 'tl-toggle-label', 'span');
  acts.appendChild(toggle);

  const more = sub(body, 'tl-more');
  more.id = 'tool-detail-' + ++detailId;
  more.hidden = true;
  toggle.setAttribute('aria-controls', more.id);
  toggle.setAttribute('aria-expanded', 'false');
  const detailNote = sub(more, 'tl-detail-note', 'p');
  detailNote.hidden = true;
  const result = sub(more, 'tl-result');
  const outHead = sub(more, 'tl-sec', 'div');
  outHead.textContent = '输出';
  const out = sub(more, 'tl-out', 'pre');
  const argHead = sub(more, 'tl-sec', 'div');
  argHead.textContent = '详细信息';
  const args = sub(more, 'tl-args', 'pre');

  node._tl = { dot, label, statusText, arg, stat, time, result, toggle, toggleCaption, more, detailNote, out, outHead, args, argHead, hasOutput: false, hasMore: false, output: '', subMeta: null, subList: null, subKey: '', subagents: null, toggleLabel: '' };

  /* 整行可点 = 展开 / 收起（和原来的工具卡片一致，用户已经习惯了）。
   * 折叠是纯前端状态，不进 entry —— 刷新后没必要记住某一条展开过。 */
  const flip = () => {
    if (!node._tl.hasMore) return;
    preserveScrollAround(head, () => {
      more.hidden = !more.hidden;
      node.classList.toggle('open', !more.hidden);
      toggle.setAttribute('aria-expanded', String(!more.hidden));
      /* 按钮文案和悬停提示都跟着折叠状态重算。不重算的话，展开之后按钮
       * 还写着「展开输出」，用户会以为点不动。 */
      syncToggle(node._tl);
      syncTitle(node, node._tl);
      onExpanded?.(!more.hidden);
    });
  };
  head.onclick = flip;
  toggle.onclick = (e) => {
    e.stopPropagation();
    flip();
  };

  updateEntry(node, entry);
  return node;
}

/* ---------- 就地更新 ---------- */

function tl(node) {
  return node._tl;
}

/** 展开按钮的显隐与文案。updateEntry 和 flip 都要用，抽出来免得两处漂移。 */
function syncToggle(p) {
  p.toggle.hidden = !p.hasMore;
  if (!p.hasMore) {
    p.more.hidden = true;
    p.toggle.setAttribute('aria-expanded', 'false');
    setText(p.toggleCaption, '');
    p.toggle.removeAttribute('aria-label');
    return;
  }
  const label = p.hasOutput ? (p.more.hidden ? '展开输出' : '收起') : p.more.hidden ? (p.toggleLabel || '详细信息') : '收起';
  setText(p.toggleCaption, label);
  p.toggle.setAttribute('aria-label', label);
  p.toggle.title = label;
}

/** 折叠状态下把关键结果补进 title，鼠标悬停就能看到，不用点开。 */
function syncTitle(node, p) {
  if (p.hasOutput && p.more.hidden) node.title = p.output.slice(0, 600);
  else node.removeAttribute('title');
}

/* ---------- 子代理紧凑列表（P4-A） ---------- */

function subagentProgressText(progress) {
  if (!progress) return '';
  const bits = [];
  if (progress.currentTool) bits.push('当前 ' + progress.currentTool);
  if (Number.isFinite(progress.toolCount)) bits.push('工具 ' + progress.toolCount);
  if (Number.isFinite(progress.turnCount)) bits.push('轮次 ' + progress.turnCount);
  if (Number.isFinite(progress.tokens)) bits.push('Token ' + progress.tokens);
  if (Number.isFinite(progress.durationMs)) bits.push(formatDuration(progress.durationMs));
  return bits.join(' · ');
}

function subagentRowNode(row) {
  const state = Object.hasOwn(SUBAGENT_STATE_TEXT, row.state) ? row.state : 'unknown';
  const item = document.createElement('div');
  item.className = 'tl-subagent-row';
  item.setAttribute('role', 'listitem');
  item.dataset.state = state;

  const line = sub(item, 'tl-subagent-line');
  /* 名称和状态优先；模型在其后，窄屏由 CSS 换到第二行。缺失字段直接省略。 */
  if (row.agent) {
    const agent = sub(line, 'tl-subagent-agent', 'span');
    agent.textContent = row.agent;
  }
  const stateText = sub(line, 'tl-subagent-state', 'span');
  stateText.textContent = SUBAGENT_STATE_TEXT[state];
  if (row.model) {
    const model = sub(line, 'tl-subagent-model', 'span');
    model.textContent = row.model;
    model.title = row.model;
  }
  if (row.task) {
    const task = sub(item, 'tl-subagent-task', 'div');
    task.textContent = row.task;
  }
  const progress = subagentProgressText(row.progress);
  if (progress) {
    const metrics = sub(item, 'tl-subagent-metrics', 'div');
    metrics.textContent = progress;
  }
  return item;
}

/** 结构化列表只由 tool-view 懒创建；没有可绑定子项时完全退回原 facts 文本。 */
function syncSubagents(p, subagents) {
  if (!subagents) {
    if (p.subMeta) { setText(p.subMeta, ''); p.subMeta.hidden = true; }
    if (p.subList) { p.subList.replaceChildren(); p.subList.hidden = true; }
    p.subKey = '';
    p.subagents = null;
    return;
  }
  p.subagents = subagents;
  if (!p.subMeta) {
    const meta = document.createElement('div');
    meta.className = 'tl-subagent-meta';
    p.more.parentNode.insertBefore(meta, p.more);
    p.subMeta = meta;
  }
  setText(p.subMeta, subagents.summary);
  p.subMeta.hidden = false;
  if (!p.subList) {
    const list = document.createElement('div');
    list.className = 'tl-subagents';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', '子代理');
    p.more.insertBefore(list, p.more.firstChild);
    p.subList = list;
  }
  const key = JSON.stringify(subagents);
  if (key !== p.subKey) {
    p.subKey = key;
    p.subList.replaceChildren();
    for (const row of subagents.rows) p.subList.appendChild(subagentRowNode(row));
  }
  p.subList.hidden = false;
}

/** 更新一条已经渲染出来的 entry。只改真正变了的字段。 */
export function updateEntry(node, entry) {
  if (entry.detailState === 'restricted') entry = { ...entry, args: null, details: null, output: '', resultLine: '' };
  const web = webActivity(entry);
  /* 语义适配器按工具名匹配，互不依赖包名：命中一个就接管，raw args/details
   * 一律不进 DOM（见下面的 argsText 分支）。 */
  const semantic = htmlArtifactActivity(entry) || processActivity(entry) || web || subagentActivity(entry) || memoryActivity(entry) || guiBrowserActivity(entry) || browserActivity(entry) || mcpActivity(entry);
  /* P23：一个适配器都不认识的工具名 —— 走 generic fallback。
   * **这正是一条 schema/工具面漂移**（pi 或 Extension 加了新工具），
   * 记下来进诊断；只记「有个不认识的工具名」这件事，不记名字（名字是数据）。 */
  if (!semantic && typeof entry.name === 'string' && entry.name) noteUnknownTool(entry.name);
  /* 只有带可绑定子项的子代理投影才换成结构化列表；其余继续用安全 facts。 */
  const subagents = semantic?.subagents?.rows?.length ? semantic.subagents : null;
  if (semantic) entry = { ...entry, ...semantic, resultLine: '', output: subagents ? '' : semantic.facts };
  const p = tl(node);
  if (!p) return;
  node._tlEntry = entry;

  const status = entry.status || 'running';
  const previousStatus = node.dataset.status;
  const previousWaiting = node.dataset.waiting;
  node.dataset.status = status;
  node.dataset.waiting = entry.waiting === true ? 'true' : 'false';
  node.classList.toggle('tl-subagent', Boolean(subagents));

  /* The glyph names the action (read/search/command/edit/…); the row's
   * data-status color and the screen-reader status line carry the outcome.
   * Keeping one stable glyph per tool avoids swapping in a check mark that
   * hides what the row actually did. Incomplete is the one exception: the
   * dashed circle is the long-standing, non-color cue that the call never
   * received a result, so it must not be lost behind the action glyph. */
  const iconName = status === 'incomplete'
    ? 'pending'
    : workIconName({ kind: semantic?.kind, name: entry.name, title: entry.label });
  if (p.dot.dataset.s !== status || p.dot.dataset.i !== iconName) {
    p.dot.dataset.s = status;
    p.dot.dataset.i = iconName;
    p.dot.innerHTML = iconMarkup(iconName); // 自写常量，不含任何外部文本
    p.dot.title = STATUS_TEXT[status] || status;
  }

  setText(p.label, entry.label + (entry.known ? '' : ' ' + entry.name));
  setText(p.statusText, status==='running'&&entry.waiting ? '等待写入' : STATUS_TEXT[status] || STATUS_TEXT.unknown);
  setText(p.arg, entry.summary);
  p.arg.title = String(entry.summary || '');

  /* +N −M：Git 的数字优先，退回工具自己给的（见 tool-model.statOf） */
  const st = statOf(entry);
  const key = st ? `${st.add}/${st.del}` : '';
  if (p.stat.dataset.k !== key) {
    p.stat.dataset.k = key;
    p.stat.textContent = '';
    if (st && (st.add || st.del)) {
      if (st.add) {
        const a = document.createElement('b');
        a.className = 'add';
        a.textContent = '+' + st.add;
        p.stat.appendChild(a);
      }
      if (st.del) {
        const b = document.createElement('b');
        b.className = 'del';
        b.textContent = '−' + st.del;
        p.stat.appendChild(b);
      }
    }
  }

  setText(p.time, formatDuration(entry.durationMs));
  setText(p.result, entry.resultLine || '');
  p.result.hidden = !entry.resultLine;
  p.toggleLabel = subagents ? '子代理' : '';
  syncSubagents(p, subagents);

  const output = String(entry.output || '');
  const hasOutput = Boolean(output.trim());

  /* 追加输出会增大 scrollHeight；必须在写入前判断“原本是否贴底”，否则
   * 写完再测永远像是用户已经上滚。只有运行中、详情已展开、原本贴底时才跟随。 */
  const outVisible = !p.more.hidden;
  const wasNearBottom = outVisible
    && p.out.scrollHeight - p.out.scrollTop - p.out.clientHeight < 40;

  if (p.output !== output) {
    p.out.dataset.len = String(output.length);
    preserveTextSelection(p.out, () => { p.out.textContent = output; });
  }
  if (status === 'running' && outVisible && wasNearBottom) p.out.scrollTop = p.out.scrollHeight;

  /* 原始参数：write 的 content 可能是整个文件，必须截断。
   * 用 textContent 写进 <pre>，所以就算里面是 <script> 也只是文本。
   *
   * 脏标记存在节点自身的 JS 状态里（p.argsText），**不放进 data-* 属性**：
   * 参数全文是模型可控的任意字符串，塞进属性就多了一条「被序列化进 HTML」的
   * 路径（属性值里的 `<` 不会被转义，虽然浏览器解析时无害，但等于把安全
   * 建立在「没人会去 outerHTML 它」之上）。文本一律只走 textContent。 */
  const argsText = semantic ? '' : argsTextOf(entry);
  if (p.argsText !== argsText) {
    p.argsText = argsText;
    preserveTextSelection(p.args, () => { p.args.textContent = argsText; });
  }

  /* 折叠区里的分节标题按需显隐 —— 没有输出时留一个空的「输出」标题很怪 */
  p.outHead.hidden = !hasOutput;
  p.out.hidden = !hasOutput;
  p.argHead.hidden = !argsText;
  p.args.hidden = !argsText;

  /* 结构化来源（Web 的搜索结果、Browser 打开的页面）共用一条渲染路径：
   * 每个来源都先过各自的 URL 白名单，过不了就根本不会生成 <a>。 */
  const sources = Array.isArray(semantic?.sources) ? semantic.sources : [];
  const sourceKey = JSON.stringify(sources);
  if (sourceKey !== '[]') {
    if (!p.sources) {
      p.sources = document.createElement('div');
      p.sources.className = 'web-sources';
      p.more.appendChild(p.sources);
    }
    if (p.sourcesKey !== sourceKey) {
      p.sourcesKey = sourceKey;
      p.sources.replaceChildren();
      for (const source of sources) {
        const link = webSourceLink(source);
        if (link) p.sources.appendChild(link);
      }
    }
  } else if (p.sources && p.sourcesKey !== '[]') {
    /* 状态推进后来源可能被撤下（例如从 running 落到无证据的结束态），
     * 不清就会留下上一轮的链接。 */
    p.sourcesKey = '[]';
    p.sources.replaceChildren();
  }

  const restricted = entry.detailState === 'restricted';
  p.detailNote.hidden = !restricted;
  setText(p.detailNote, restricted ? '当前视图无权读取原始参数与输出' : '');
  p.hasOutput = hasOutput;
  p.output = output;
  p.hasMore = hasOutput || Boolean(argsText) || Boolean(entry.resultLine) || sources.length > 0 || Boolean(subagents) || restricted;
  node.classList.toggle('has-more', p.hasMore);
  syncToggle(p);
  syncTitle(node, p);

  // Duration/output/Git repaint ticks must not rescan a whole batch.
  // A running row still refreshes its group's elapsed clock; that is one small
  // child scan, not a full timeline rebuild.
  const group = node.closest('.tl-group');
  if (group && (previousStatus !== status || previousWaiting !== node.dataset.waiting || status === 'running')) {
    syncGroup(group);
  }

  /* 预览行数不再单独占位：resultLine 已经给了「最有价值的一行」（§5/§6），
   * 完整输出在折叠区里。多铺一块预览会让紧凑的时间线变成三倍高。 */
  return node;
}

function setText(n, text) {
  const s = String(text ?? '');
  if (n.textContent !== s) n.textContent = s;
}

/** 详细参数文本：原始 arguments + details + 截断说明。 */
function argsTextOf(entry) {
  const bits = [];
  try {
    if (entry.args != null) bits.push(JSON.stringify(entry.args, null, 2));
  } catch {
    bits.push('(参数无法序列化)');
  }
  if (entry.details) {
    try {
      bits.push(JSON.stringify(entry.details, null, 2));
    } catch {
      /* details 里有循环引用时忽略 —— 不该为了显示详情把整条时间线搞崩 */
    }
  }
  if (entry.truncated) {
    const t = entry.truncated;
    bits.push(
      `pi 已截断输出：共 ${t.totalLines ?? '?'} 行 / ${t.totalBytes ?? '?'} 字节，` +
        `只返回了前 ${t.outputLines ?? '?'} 行（按${t.by === 'bytes' ? '字节' : '行'}上限）`
    );
  }
  let s = bits.filter(Boolean).join('\n\n');
  if (s.length > ARGS_MAX) s = s.slice(0, ARGS_MAX) + '\n…（已截断）';
  return s;
}

/* ---------- 分组（§12） ---------- */

let groupId = 0;

function selectionInside(node) {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return false;
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed
    && (node.contains(selection.anchorNode) || node.contains(selection.focusNode)));
}

function setGroupOpen(g, group, open) {
  if (g.list.hidden === !open) return;
  preserveScrollAround(group, () => {
    g.list.hidden = !open;
    g.head.setAttribute('aria-expanded', String(open));
    group.classList.toggle('is-collapsed', !open);
  });
}

function groupElapsed(children) {
  let started = Infinity;
  let ended = -Infinity;
  let running = false;
  for (const node of children) {
    const entry = node._tlEntry;
    if (!entry || !Number.isFinite(entry.startedAt)) continue;
    started = Math.min(started, entry.startedAt);
    if (entry.status === 'running') running = true;
    const fallbackEnd = Number.isFinite(entry.durationMs)
      ? entry.startedAt + entry.durationMs
      : null;
    const end = Number.isFinite(entry.endedAt) ? entry.endedAt : fallbackEnd;
    if (Number.isFinite(end)) ended = Math.max(ended, end);
  }
  if (!Number.isFinite(started)) return null;
  const end = running ? Date.now() : ended;
  return Number.isFinite(end) && end >= started ? end - started : null;
}

/* 折叠优先级：用户显式选择 > 活跃组默认展开 > 已结束默认折叠。
 * 用户点过组头（userToggled）或展开过任一行（openChild）后，运行状态和
 * 结束事件都不能再改它。 */
function syncGroup(group) {
  const g = group?._tlGroup;
  if (!g) return;
  const multiple = g.count >= 2;
  const children = groupEntries(group);
  const hasRunning = children.some(node => node.dataset.status === 'running' && node.dataset.waiting !== 'true');
  const hasWaiting = children.some(node => node.dataset.status === 'running' && node.dataset.waiting === 'true');
  const hasOpenChild = children.some(node => node.classList.contains('open'));
  const focusInside = g.list.contains(document.activeElement) || selectionInside(g.list);
  const explicit = g.userToggled || hasOpenChild;
  group.classList.toggle('is-work-embedded', g.embedded === true);

  if (g.embedded) {
    // Visibility belongs to the outer work log. Remember the native disclosure
    // choice separately so releasing adoption never turns an explicit close open.
    g.list.hidden = false;
    g.head.setAttribute('aria-expanded', 'true');
    group.classList.remove('is-collapsed');
  } else if (multiple) {
    if (g.userToggled) {
      setGroupOpen(g, group, g.expandedChoice === true);
    } else if (hasOpenChild && g.list.hidden) {
      /* 用户展开的行不能被自动折叠隐藏；但组头被用户显式收起时，收起优先。 */
      setGroupOpen(g, group, true);
    } else if (!explicit) {
      setGroupOpen(g, group, hasRunning || hasWaiting || focusInside);
    }
  } else if (g.list.hidden) {
    setGroupOpen(g, group, true);
  }

  g.head.hidden = !multiple || g.embedded === true;
  g.meta.hidden = !multiple || g.embedded === true;
  g.state.hidden = !multiple;
  g.time.hidden = !multiple;
  setText(g.head, multiple ? `工具调用 · ${g.count} 次` : '');

  const counts = new Map();
  for (const node of children) {
    const status = Object.hasOwn(STATUS_TEXT, node.dataset.status) ? node.dataset.status : 'unknown';
    const key = node.dataset.status === 'running' && node.dataset.waiting === 'true' ? 'waiting' : status;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const summary = ['running', 'waiting', 'error', 'incomplete', 'interrupted', 'cancelled', 'unknown', 'success']
    .filter(status => counts.has(status)).map(status => `${STATUS_TEXT[status]} ${counts.get(status)}`).join(' · ');
  setText(g.state, multiple ? summary : '');

  const elapsed = multiple ? groupElapsed(children) : null;
  const timeText = elapsed != null && elapsed >= 100 ? formatDuration(elapsed) : '';
  setText(g.time, timeText);
  g.time.hidden = !multiple || g.embedded === true || !timeText;
}

/* 一组 = 一条 assistant 消息里的全部 toolCall。
 * 这个边界是**真实存在**的（消息本身就是边界），不是「超过几秒算一组」那种猜测。
 * 只有一项时不摆「操作 1 项」这种废话标题。 */
export function createGroup(onExpanded) {
  const g = document.createElement('section');
  g.className = 'tl-group';
  g.setAttribute('aria-label', '工具调用');

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'tl-group-head ui2-tool-summary';
  head.hidden = true;
  g.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'tl-group-meta';
  meta.hidden = true;
  g.appendChild(meta);

  const state = document.createElement('span');
  state.className = 'ui2-tool-state';
  state.id = 'tool-group-state-' + ++groupId;
  state.setAttribute('role', 'status');
  state.hidden = true;
  head.setAttribute('aria-describedby', state.id);
  meta.appendChild(state);

  const time = document.createElement('span');
  time.className = 'tl-group-time';
  time.hidden = true;
  meta.appendChild(time);

  const list = document.createElement('div');
  list.className = 'tl-list';
  list.id = 'tool-group-list-' + groupId;
  head.setAttribute('aria-controls', list.id);
  head.setAttribute('aria-expanded', 'true');
  g.appendChild(list);

  // Native display membership survives temporary authorized P5 detail adoption.
  // A moved row is still part of this real assistant batch, not a removed tool.
  g._tlGroup = { head, meta, state, time, list, entries: new Set(), count: 0 };
  head.addEventListener('click', () => {
    g._tlGroup.userToggled = true;
    preserveScrollAround(head, () => {
      const open = list.hidden;
      g._tlGroup.expandedChoice = open;
      if (!open && list.contains(document.activeElement)) head.focus({ preventScroll: true });
      list.hidden = !open;
      head.setAttribute('aria-expanded', String(open));
      g.classList.toggle('is-collapsed', !open);
      onExpanded?.(open);
    });
  });
  return g;
}

/** 往组里加一条已经渲染好的节点。返回组内累计条数。 */
export function addToGroup(group, node) {
  const g = group._tlGroup;
  g.list.appendChild(node);
  g.entries.add(node);
  g.count = g.entries.size;
  syncGroup(group);
  return g.count;
}

export function groupCount(group) {
  return group?._tlGroup?.count ?? 0;
}

/** Native display rows, including rows temporarily adopted as P5 details. */
export function groupEntries(group) {
  return [...group?._tlGroup?.entries || []];
}

/** Presentation adoption only; never merge tool IDs or execution batches. */
export function setGroupEmbedded(group, embedded) {
  if (!group?._tlGroup) return false;
  group._tlGroup.embedded = embedded === true;
  syncGroup(group);
  return true;
}

export function removeFromGroup(group, node) {
  const g = group?._tlGroup;
  if (!g || !g.entries.delete(node)) return false;
  node.remove();
  g.count = g.entries.size;
  syncGroup(group);
  return true;
}

/* 展开状态由使用者按会话保存时，需要能从外部恢复。这两个函数只操作
 * 视图自身已有的 hidden/aria 状态，不改变分组规则（例如多项默认折叠）。 */
export function setGroupExpanded(group, expanded) {
  const g = group?._tlGroup;
  if (!g) return false;
  g.userToggled = true;
  g.expandedChoice = expanded === true;
  g.list.hidden = g.embedded ? false : !expanded;
  g.head.setAttribute('aria-expanded', String(g.embedded || expanded === true));
  group.classList.toggle('is-collapsed', !g.embedded && !expanded);
  return true;
}

export function isGroupExpanded(group) {
  const g = group?._tlGroup;
  return Boolean(g && !g.list.hidden);
}

/* 单条工具详情的展开状态同理；没有可展开内容时返回 false。 */
export function setEntryExpanded(node, expanded) {
  const p = node?._tl;
  if (!p || !p.hasMore) return false;
  p.more.hidden = !expanded;
  node.classList.toggle('open', expanded);
  p.toggle.setAttribute('aria-expanded', String(expanded));
  syncToggle(p);
  syncTitle(node, p);
  return true;
}

export function isEntryExpanded(node) {
  const p = node?._tl;
  return Boolean(p?.hasMore && !p.more.hidden);
}

/* ---------- 输出预览 ---------- */

/* 给测试和别处复用：折叠状态下的多行预览。当前 UI 用的是 resultLine（一行），
 * 这个函数留着是因为窄屏下多行预览可能更合适，换起来只改这一处。 */
export function previewLines(entry, max) {
  return previewOf(entry.output, max);
}
