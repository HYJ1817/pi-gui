/* 会话内提问导航（Conversation Minimap）。
 *
 * 聊天区左边一列低对比度短线，每条对应当前会话里的**一次用户提问**。
 * hover 看摘要、点击平滑跳过去、滚动时当前那条自动高亮。
 *
 * ---------- 它是什么、不是什么 ----------
 *
 * 它是**同一会话内的导航**。不是会话历史列表、不是 Codex Sessions、
 * 不是 Planner 的计划历史 —— 那些各自有别的入口。
 *
 * ---------- 三条设计原则 ----------
 *
 * 1. **导航单位只有用户消息。** assistant / tool call / tool result / thinking
 *    都不画点。否则长会话左边会变成一根密密麻麻的刻度尺，而且那些点对
 *    「我想回到某次提问」这件事毫无帮助。
 *
 * 2. **DOM 是唯一权威，本模块不存消息副本。** 每条 anchor 就是 `.msg.user`
 *    那个元素本身；导航只持有 `{ id, element, marker, preview }`。
 *    历史重建 / fork / retry 之后一律**重新扫 DOM**（rebuildConversationNav），
 *    不自己维护一份会漂移的 messages 列表。
 *
 * 3. **滚动时不碰布局。** 位置缓存在 `topInContent` 里，只在内容或尺寸变化时
 *    重算（debounce）。判断「当前是第几条」用二分查缓存值 ——
 *    滚动路径上一次 getBoundingClientRect 都不做。
 *    IntersectionObserver 只用来在「某条 anchor 越过顶部带」时通知我们重算，
 *    平时完全不工作。
 */
import { el, S } from './state.js';

/** 顶部判定带的高度占视口比例。IO 的 rootMargin 百分比必须与这里一致。 */
const BAND_RATIO = 0.1;
const BAND_BOTTOM_MARGIN = `-${Math.round((1 - BAND_RATIO) * 100)}%`;

/** 位置重算的 debounce。streaming 每来一个 token 都会改高度，不能每次都算。 */
const LAYOUT_DEBOUNCE_MS = 160;

/** 提示文字最长多少字（§7：不要把完整 prompt 塞进 tooltip）。 */
const PREVIEW_MAX = 40;

/** 紧凑聚簇在容器上下各留的边距：整组不贴到两端。 */
const CLUSTER_PAD = 8;

/** 跳转后目标消息上方留出的余量（px）。
 *  以前靠 .msg.user 的 scroll-margin-top:56px + scrollIntoView 留空间，
 *  现在只写 #stream.scrollTop，余量在这里显式减掉。 */
const JUMP_PAD = 20;

let entries = []; // [{ id, element, marker, preview, topInContent, top }]
let navEl = null;
let io = null;
let ro = null;
let layoutTimer = null;
let currentIndex = -1;
let seq = 0;
let observedRoot = null;
let observedThread = null;
let rafPending = false;

/** 运行环境有没有 IntersectionObserver。
 *  jsdom 没有（smoke 测试跑在里面），老环境也可能没有 —— 缺了不能让整个
 *  消息渲染崩掉。没有它时退回「rAF 节流的滚动判定」：仍然是二分查缓存值、
 *  仍然不读布局，只是每次滚动帧多一次 O(log n) 的比较。 */
function ioSupported() {
  return typeof IntersectionObserver !== 'undefined';
}

/* ---------- 工具 ---------- */

function ensureNav() {
  if (navEl && navEl.isConnected) return navEl;
  navEl = document.getElementById('convoNav');
  return navEl;
}

function threadEl() {
  return S.thread && S.thread.isConnected ? S.thread : null;
}

/** 从消息 DOM 里取一段预览：折掉换行与多余空格，截断。 */
function previewOf(msgEl) {
  const body = msgEl.querySelector('.msg-body');
  const raw = body ? body.textContent || '' : '';
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) {
    // 只有附件的消息没有文字可展示，给个中性说明而不是空白
    return msgEl.querySelector('.msg-att-chip, .msg-file') ? '（附件消息）' : '（空消息）';
  }
  return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + '…' : text;
}

/** 扫 DOM 里全部用户消息（DOM 顺序即会话顺序）。 */
function collectAnchors() {
  const t = threadEl();
  if (!t) return [];
  return [...t.querySelectorAll('.msg.user')];
}

function makeMarker(entry) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cn-marker';
  /* 用 button 而不是带 onclick 的 div：键盘 Enter / Space 天然可用，
   * 也有正确的语义（§24）。aria-label 带上预览，读屏能听懂点了会去哪。 */
  b.setAttribute('aria-label', '跳转到：' + entry.preview);
  b.title = ''; // 不用原生 tooltip，避免和自定义提示重复

  const tip = document.createElement('span');
  tip.className = 'cn-tip';
  tip.textContent = entry.preview;
  b.append(tip);

  b.addEventListener('click', (e) => {
    e.preventDefault();
    setCurrent(entries.indexOf(entry));
    scrollToEntry(entry);
  });
  return b;
}

/* ---------- 建立 / 重建 ---------- */

function buildFrom(elements) {
  const nav = ensureNav();
  if (!nav) return;
  nav.replaceChildren();
  entries = [];

  for (const element of elements) {
    if (!element.dataset.navId) element.dataset.navId = 'msg-' + ++seq;
    const entry = { id: element.dataset.navId, element, preview: previewOf(element), marker: null, topInContent: 0, top: 0 };
    entry.marker = makeMarker(entry);
    nav.append(entry.marker);
    entries.push(entry);
  }

  currentIndex = -1;
  layout();
  observeAnchors();
}

/** 整表重建。**历史恢复 / fork / retry / 切项目之后都走这里**（§10/§14/§15）。 */
export function rebuildConversationNav() {
  buildFrom(collectAnchors());
}

/** 实时新增一条用户消息时调用（§11：不等 assistant 回复完）。 */
export function registerConversationAnchor(element) {
  if (!element) return;
  const nav = ensureNav();
  if (!nav) return;
  if (entries.some((e) => e.element === element)) return;
  // 实时插入的这条未必是 DOM 里的最后一条（比如重放历史），按真实顺序重排一次更稳
  const all = collectAnchors();
  if (!all.includes(element)) return;
  buildFrom(all);
}

export function clearConversationNav() {
  entries = [];
  currentIndex = -1;
  seq = 0;
  if (navEl) navEl.replaceChildren();
  if (io) io.disconnect();
}

/* ---------- 位置计算 ---------- */

/** debounce 一版重排。streaming / timeline 折叠 / 窗口 resize 都走这里。 */
export function scheduleLayout() {
  if (layoutTimer) return;
  layoutTimer = setTimeout(() => {
    layoutTimer = null;
    layout();
  }, LAYOUT_DEBOUNCE_MS);
}

function layout() {
  const stream = el.stream;
  if (!stream) return;
  if (!entries.length) return;

  const scrollHeight = stream.scrollHeight;
  if (!scrollHeight) return;

  /* 第一步：消息在**滚动内容里**的偏移。
   *
   * 这一步与导航容器多高无关，所以放在最前面、无条件算 —— 跳转
   * （scrollToEntry）和「当前是第几条」都只依赖它。窄窗口下导航列被
   * display:none（clientHeight = 0）时也必须是最新的，否则跳转会跳错地方。
   * 读 rect 只在重排时发生（debounce 160ms），滚动路径上一次都不读。 */
  const streamTop = stream.getBoundingClientRect().top;
  const scrollTop = stream.scrollTop;
  entries.forEach((e) => {
    const r = e.element.getBoundingClientRect();
    e.topInContent = Math.max(0, r.top - streamTop + scrollTop);
  });

  /* 第二步：marker 的位置 —— **紧凑聚簇**，不按内容比例铺满整个高度。
   *
   * 原来的做法是 `top = 消息偏移 / scrollHeight × 容器高`：一条很长的
   * assistant 回答会把后面的点推到很远的地方，10～40 条的会话看起来像
   * 撒了满屏的散点，离得远、很难连续点。用户要的是 Codex 那种「聚成一组
   * 连续的短线」。所以改成：
   *   - 顺序不变（第 1 次提问 → 第 1 条）；
   *   - 条数与可用高度决定短线高度和间距，整组垂直居中；
   *   - 放不下时压缩间距（甚至轻微重叠），但**绝不越出容器**；
   *   - 内容偏移仍然算（topInContent），只是不再决定纵向位置。 */
  const nav = ensureNav();
  const navH = nav ? nav.clientHeight : 0;
  if (!navH) return; // 导航列不可见（窄窗口隐藏）—— 内容偏移已经更新过了

  const n = entries.length;
  const h = n <= 12 ? 3 : n <= 40 ? 2 : 1;
  const avail = Math.max(0, navH - CLUSTER_PAD * 2);
  let step = h + 2; // 目标间距：看着是一组连续短线，但仍分辨得出条数
  const need = (n - 1) * step + h;
  if (n > 1 && need > avail) step = (avail - h) / (n - 1); // 可能 < 1：宁可轻微重叠也不越界
  const span = n > 1 ? (n - 1) * step + h : h;
  const start = CLUSTER_PAD + Math.max(0, (avail - span) / 2);

  entries.forEach((e, i) => {
    e.top = start + i * step;
    e.marker.style.top = e.top + 'px';
    e.marker.style.height = h + 'px';
  });

  updateCurrent();
}

/* ---------- 当前高亮 ---------- */

/** 语义（§9）：**视口上部附近最近的一条 user message**。
 *  所以滚在一段很长的 assistant 回答里时，高亮的仍然是它前面那次提问。 */
function updateCurrent() {
  const stream = el.stream;
  if (!stream || !entries.length) return;
  const line = stream.scrollTop + stream.clientHeight * BAND_RATIO;

  let lo = 0;
  let hi = entries.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].topInContent <= line) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  setCurrent(idx);
}

function setCurrent(idx) {
  if (idx === currentIndex) return;
  if (entries[currentIndex]) {
    entries[currentIndex].marker.classList.remove('on');
    entries[currentIndex].element.removeAttribute('data-current-question');
  }
  currentIndex = idx;
  const cur = entries[idx];
  if (cur) {
    cur.marker.classList.add('on');
    /* §28：给当前提问挂个标记，方便以后做别的视觉。第一版不改正文外观。 */
    cur.element.setAttribute('data-current-question', 'true');
  }
}

/* ---------- 观察器 ---------- */

function observeAnchors() {
  const stream = el.stream;
  if (!stream || !ioSupported()) return;
  if (!io || observedRoot !== stream) {
    if (io) io.disconnect();
    io = new IntersectionObserver(
      () => {
        /* 只把「有 anchor 越过顶部那条带」当成信号，真正的判定交给二分。
         * 这样滚动路径上完全没有布局读取，也不需要在回调里遍历所有节点。 */
        updateCurrent();
      },
      { root: stream, rootMargin: `0px 0px ${BAND_BOTTOM_MARGIN} 0px`, threshold: 0 }
    );
    observedRoot = stream;
  }
  io.disconnect();
  for (const e of entries) io.observe(e.element);
}

function ensureResizeObserver() {
  if (typeof ResizeObserver === 'undefined') return;
  if (!ro) ro = new ResizeObserver(() => scheduleLayout());
  const stream = el.stream;
  const t = threadEl();
  if (stream && stream !== observedThread) {
    // stream 尺寸变化 → 视口高度变了
    try {
      ro.observe(stream);
    } catch {
      /* noop */
    }
  }
  if (t && t !== observedThread) {
    if (observedThread) {
      try {
        ro.unobserve(observedThread);
      } catch {
        /* noop */
      }
    }
    observedThread = t;
    /* thread 的尺寸变化覆盖了两种「内容高度变了」的情况：
     * streaming 输出持续增长、Tool Timeline 展开/折叠。 */
    ro.observe(t);
  }
}

/* ---------- 跳转 ---------- */

/**
 * 跳到某条用户消息。**只改 #stream 自己的 scrollTop。**
 *
 * 这里刻意**不用 element.scrollIntoView()**：浏览器会连带滚动所有
 * 「可编程滚动」的祖先。`.stage` 是 `overflow:hidden`（hidden 只是不给用户
 * 滚动条，scrollTop 照样能被脚本改），而它会话区里的可滚动子容器又把溢出
 * 传了上来 —— 于是点一下 marker，整个 workspace 往上跳 46px，顶栏被推出
 * 视口（左侧栏不动，右边原生窗口按钮还在，看起来就是「标题栏消失 / 顶部断开」）。
 * styles.css 里 `.stage` 改成 `overflow:clip` 是第二道保险，但真正的修法是
 * 这里不再请求祖先滚动。
 *
 * 目标位置用 `entry.topInContent`（layout() 里算的内容偏移），clamp 到
 * [0, maxScroll]，再减一个 JUMP_PAD —— 目标消息不贴死在滚动区顶部。
 * 不用 setTimeout / scrollBy 之类的猜测。 */
function scrollToEntry(entry) {
  if (!entry || !entry.element.isConnected) return;
  const stream = el.stream;
  if (!stream) return;
  const max = Math.max(0, stream.scrollHeight - stream.clientHeight);
  const top = Math.min(max, Math.max(0, Math.round(entry.topInContent - JUMP_PAD)));
  /* jsdom（smoke）与很老的环境没有 scrollTo —— 退回直接写 scrollTop，
   * 只影响平滑动画，不影响落点。 */
  if (typeof stream.scrollTo === 'function') stream.scrollTo({ top, behavior: 'smooth' });
  else stream.scrollTop = top;
}

/**
 * 跳到本会话的**第 N 次提问**（会话搜索结果的落点）。
 *
 * 复用现有的锚点表，**不另搞一套滚动定位**：`entries` 就是 DOM 里 `.msg.user`
 * 的顺序，与后端扫会话文件时算出的 `userIndex` 是同一个序
 * （见 server/session-search.js）。所以「第 N 次提问」两边指的是同一条消息。
 *
 * 越界就什么都不做、回 false，让调用方决定兜底 —— **定位失败不是错误**，
 * 不该抛，也不该弹提示（用户看到会话已经切过去了就够了）。
 *
 * @returns {boolean} 真的滚动了才回 true
 */
export function scrollToUserTurn(index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= entries.length) return false;
  const e = entries[i];
  if (!e || !e.element || !e.element.isConnected) return false;
  scrollToEntry(e);
  setCurrent(i);
  return true;
}

/* ---------- 一次性装配 ---------- */

export function initConversationNav() {
  const stream = el.stream;
  if (!stream) return;
  stream.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', scheduleLayout, { passive: true });
  ensureResizeObserver();
}

/* 滚动路径。
 *
 * 有 IntersectionObserver 时：滚动本身**什么都不做**，等 IO 报「有 anchor
 * 越过顶部那条带」再算（§26 要的就是这个）。只有容器尺寸变化后缓存的带位置
 * 会偏，所以顺手 debounce 一次重排。
 *
 * 没有 IO 时（jsdom / 老环境）：退回 rAF 节流的判定。依然只读 scrollTop 和
 * 缓存好的 topInContent，不碰 getBoundingClientRect。 */
let scrollIdleTimer = null;
function onScroll() {
  if (ioSupported()) {
    if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => {
      scrollIdleTimer = null;
      ensureResizeObserver();
      updateCurrent();
    }, 120);
    return;
  }
  if (rafPending) return;
  rafPending = true;
  const run = () => {
    rafPending = false;
    updateCurrent();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

/** 供测试用：当前是第几条。 */
export function currentNavIndex() {
  return currentIndex;
}

/** 供测试用：全部 anchor 的 id 与预览。 */
export function navEntries() {
  return entries.map((e) => ({ id: e.id, preview: e.preview, top: e.top, topInContent: e.topInContent }));
}
