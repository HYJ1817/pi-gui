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
import { webActivity, webSourceLink } from './web-activity.js';
import { subagentActivity } from './subagent-activity.js';
import { memoryActivity } from './memory-activity.js';

/* 状态图标。
 *
 * 用 SVG 而不是 ✓ / ✕ / ● 这些字符：时间线是多行左对齐的，字符的宽度和基线
 * 在不同字体下不一致，一歪就整列错位。 */
const STATUS_ICON = {
  running: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5"/></svg>',
  success: '<svg viewBox="0 0 24 24"><polyline points="5.5 12.5 10 17 18.5 7.5"/></svg>',
  error: '<svg viewBox="0 0 24 24"><path d="M7.5 7.5l9 9M16.5 7.5l-9 9"/></svg>',
  /* 未完成：虚线圆圈 —— 既不是对勾也不是叉，一眼能看出「这一轮没跑完」 */
  incomplete: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" stroke-dasharray="2.6 2.6"/></svg>',
  interrupted: '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',
  cancelled: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  unknown: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17v.4"/></svg>',
};

const STATUS_TEXT = {
  running: '运行中',
  success: '成功',
  error: '失败',
  incomplete: '未完成',
  interrupted: '已中断',
  cancelled: '已取消',
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
export function renderEntry(entry) {
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

  const result = sub(body, 'tl-result');
  const acts = sub(head, 'tl-acts');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'tl-toggle';
  acts.appendChild(toggle);

  const more = sub(body, 'tl-more');
  more.id = 'tool-detail-' + ++detailId;
  more.hidden = true;
  toggle.setAttribute('aria-controls', more.id);
  toggle.setAttribute('aria-expanded', 'false');
  const outHead = sub(more, 'tl-sec', 'div');
  outHead.textContent = '输出';
  const out = sub(more, 'tl-out', 'pre');
  const argHead = sub(more, 'tl-sec', 'div');
  argHead.textContent = '详细信息';
  const args = sub(more, 'tl-args', 'pre');

  node._tl = { dot, label, statusText, arg, stat, time, result, toggle, more, out, outHead, args, argHead, hasOutput: false, hasMore: false, output: '' };

  /* 整行可点 = 展开 / 收起（和原来的工具卡片一致，用户已经习惯了）。
   * 折叠是纯前端状态，不进 entry —— 刷新后没必要记住某一条展开过。 */
  const flip = () => {
    if (!node._tl.hasMore) return;
    more.hidden = !more.hidden;
    node.classList.toggle('open', !more.hidden);
    toggle.setAttribute('aria-expanded', String(!more.hidden));
    /* 按钮文案和悬停提示都跟着折叠状态重算。不重算的话，展开之后按钮
     * 还写着「展开输出」，用户会以为点不动。 */
    syncToggle(node._tl);
    syncTitle(node, node._tl);
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
    setText(p.toggle, '');
    return;
  }
  setText(p.toggle, p.hasOutput ? (p.more.hidden ? '展开输出' : '收起') : p.more.hidden ? '详细信息' : '收起');
}

/** 折叠状态下把关键结果补进 title，鼠标悬停就能看到，不用点开。 */
function syncTitle(node, p) {
  if (p.hasOutput && p.more.hidden) node.title = p.output.slice(0, 600);
  else node.removeAttribute('title');
}

/** 更新一条已经渲染出来的 entry。只改真正变了的字段。 */
export function updateEntry(node, entry) {
  const web = webActivity(entry);
  /* 语义适配器按工具名匹配，互不依赖包名：命中一个就接管，raw args/details
   * 一律不进 DOM（见下面的 argsText 分支）。 */
  const semantic = web || subagentActivity(entry) || memoryActivity(entry);
  if (semantic) entry = { ...entry, ...semantic, resultLine: '', output: semantic.facts };
  const p = tl(node);
  if (!p) return;

  const status = entry.status || 'running';
  node.dataset.status = status;
  node.className = 'tl-item' + (node.classList.contains('open') ? ' open' : '');

  const iconHtml = STATUS_ICON[status] || STATUS_ICON.unknown;
  if (p.dot.dataset.s !== status) {
    p.dot.dataset.s = status;
    p.dot.innerHTML = iconHtml; // 自写常量，不含任何外部文本
    p.dot.title = STATUS_TEXT[status] || status;
  }

  setText(p.label, entry.label + (entry.known ? '' : ' ' + entry.name));
  setText(p.statusText, STATUS_TEXT[status] || STATUS_TEXT.unknown);
  setText(p.arg, entry.summary);

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

  const output = String(entry.output || '');
  const hasOutput = Boolean(output.trim());

  if (p.out.dataset.len !== String(output.length) || (semantic && p.out.textContent !== output)) {
    p.out.dataset.len = String(output.length);
    p.out.textContent = output;
  }

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
    p.args.textContent = argsText;
  }

  /* 折叠区里的分节标题按需显隐 —— 没有输出时留一个空的「输出」标题很怪 */
  p.outHead.hidden = !hasOutput;
  p.out.hidden = !hasOutput;
  p.argHead.hidden = !argsText;
  p.args.hidden = !argsText;

  if (web) {
    if (!p.webSources) {
      p.webSources = document.createElement('div');
      p.webSources.className = 'web-sources';
      p.more.appendChild(p.webSources);
    }
    const sourceKey = JSON.stringify(web.sources);
    if (p.webSourceKey !== sourceKey) {
      p.webSourceKey = sourceKey;
      p.webSources.replaceChildren();
      for (const source of web.sources) {
        const link = webSourceLink(source);
        if (link) p.webSources.appendChild(link);
      }
    }
  }

  p.hasOutput = hasOutput;
  p.output = output;
  p.hasMore = hasOutput || Boolean(argsText) || Boolean(web?.sources.length);
  node.classList.toggle('has-more', p.hasMore);
  syncToggle(p);
  syncTitle(node, p);

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

/* 一组 = 一条 assistant 消息里的全部 toolCall。
 * 这个边界是**真实存在**的（消息本身就是边界），不是「超过几秒算一组」那种猜测。
 * 只有一项时不摆「操作 1 项」这种废话标题。 */
export function createGroup() {
  const g = document.createElement('section');
  g.className = 'tl-group';
  g.setAttribute('aria-label', '工具操作');

  const head = document.createElement('div');
  head.className = 'tl-group-head';
  head.hidden = true;
  g.appendChild(head);

  const list = document.createElement('div');
  list.className = 'tl-list';
  g.appendChild(list);

  g._tlGroup = { head, list, count: 0 };
  return g;
}

/** 往组里加一条已经渲染好的节点。返回组内累计条数。 */
export function addToGroup(group, node) {
  const g = group._tlGroup;
  g.list.appendChild(node);
  g.count += 1;
  if (g.count >= 2) {
    g.head.hidden = false;
    g.head.textContent = `操作 ${g.count} 项`;
  }
  return g.count;
}

export function groupCount(group) {
  return group?._tlGroup?.count ?? 0;
}

/* ---------- 输出预览 ---------- */

/* 给测试和别处复用：折叠状态下的多行预览。当前 UI 用的是 resultLine（一行），
 * 这个函数留着是因为窄屏下多行预览可能更合适，换起来只改这一处。 */
export function previewLines(entry, max) {
  return previewOf(entry.output, max);
}
