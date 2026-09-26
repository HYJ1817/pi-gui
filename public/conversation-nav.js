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
  const nav = ensureNav();
  const stream = el.stream;
  if (!nav || !stream) return;
  if (!entries.length) return;

  const navH = nav.clientHeight;
  const scrollHeight = stream.scrollHeight;
  if (!navH || !scrollHeight) return;

  /* 先把所有 rect 读完再写样式 —— 读一次写一次会反复触发布局计算。
   * 这里算的是「相对滚动内容顶部的位置」，与当前滚动位置无关。 */
  const streamTop = stream.getBoundingClientRect().top;
  const scrollTop = stream.scrollTop;
  const tops = entries.map((e) => {
    const r = e.element.getBoundingClientRect();
    return Math.max(0, r.top - streamTop + scrollTop);
  });

  /* §19：按「这条消息在整段会话内容里的相对位置」映射，而不是「第几个问题」。
   * 这样一条很长的 assistant 回答会在 minimap 上占据相应的一段距离。 */
  let positions = tops.map((t) => (t / scrollHeight) * navH);

  /* §18：条数多的时候防止重叠。
   * 先按最小间距往下推；推不下就整体改成均匀分布 —— 那种情况下「精确位置」
   * 已经没有意义了，可点、可分辨更重要。 */
  const h = entries.length > 150 ? 1 : 2;
  const gap = h + 1;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] < positions[i - 1] + gap) positions[i] = positions[i - 1] + gap;
  }
  const overflow = positions[positions.length - 1] + h > navH;
  if (overflow) {
    const n = positions.length;
    const step = n > 1 ? (navH - h) / (n - 1) : 0;
    positions = positions.map((_, i) => Math.round(i * step));
  }

  entries.forEach((e, i) => {
    e.topInContent = tops[i];
    e.top = positions[i];
    e.marker.style.top = positions[i] + 'px';
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

function scrollToEntry(entry) {
  if (!entry || !entry.element.isConnected) return;
  /* 顶部固定区域会盖住消息 —— 用 scroll-margin-top 让浏览器自己留出空间，
   * 不要用「先 scrollIntoView 再 scrollBy(-N)」那种靠 timeout 猜的修法（§6）。 */
  entry.element.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
