/* 右栏工作区（通用外壳）。
 *
 * ---------- 为什么要跟浏览器分开 ----------
 *
 * 这一层只知道「右栏开着没有 / 多宽 / 里面装的是哪一面 / viewport 在屏幕上的矩形」，
 * **完全不知道浏览器这回事**。以后要往里放文件预览、Markdown、localhost 预览，
 * 都是再注册一个 surface，不用动这里，也不用动聊天那边的任何代码。
 *
 * ---------- 宽度持久化 ----------
 *
 * 只存宽度（键 pi-gui.rightpane.v1），**不存**打开状态与上次的 URL ——
 * 启动时因为「上次开过浏览器」就自动去联网，是这一版明确不要的行为。
 *
 * 存的坐标口径与窗口状态文件（window-state.json）**互相独立**：
 * 那是主进程记的窗口几何，这是页面记的面板宽度，两者不共用一个文件，
 * 免得一边的格式演进把另一边读坏。
 *
 * ---------- viewport 几何怎么同步给主进程 ----------
 *
 * WebContentsView 不是 DOM，它按主进程给的像素矩形摆在窗口客户区上。
 * 所以这里只负责量：`#browserViewport`（或任意 surface 的 viewport 元素）的
 * getBoundingClientRect() 就是那个矩形。量出来的数**不可信**（缩放、竞态、
 * 布局切换都可能给出负数或超出窗口），主进程会用 clampBounds 再夹一次 ——
 * 判定在 electron/browser-policy.cjs，那边有单测。
 *
 * 更新时机：ResizeObserver（容器尺寸变了）+ window resize + 拖动分隔条，
 * 统一用 requestAnimationFrame 合并 —— 拖动时每个 mousemove 都发一次 IPC
 * 会把主进程淹掉。 */

const WIDTH_KEY = 'pi-gui.rightpane.v1';
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 320;

/** 聊天列的可用地板。
 *
 * 右栏 dock 时会把 .stage 压窄；低于这个宽度，composer 那排按钮就开始互相挤。
 * 所以它是「要不要退化成 overlay」的判据 —— 用**实测**的方式决定：
 * 拿实际可用宽度跟它比，而不是写一个看起来合理的窗口断点。
 * （四个验收尺寸 700/900/1200/1536 都真实量过，见 tests/cdp-shot.cjs。） */
const CHAT_FLOOR = 420;

const byId = (id) => document.getElementById(id);

function readStoredWidth() {
  try {
    const raw = JSON.parse(localStorage.getItem(WIDTH_KEY) || 'null');
    const w = Number(raw?.width);
    return Number.isFinite(w) && w >= MIN_WIDTH ? w : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function storeWidth(width) {
  try {
    localStorage.setItem(WIDTH_KEY, JSON.stringify({ width: Math.round(width) }));
  } catch {
    /* 隐私模式 / 配额满 —— 记不住就记不住，不该影响使用 */
  }
}

export function initRightPane() {
  const root = byId('rightPane');
  const resizer = byId('rightPaneResizer');
  const app = document.querySelector('.app');
  if (!root || !resizer || !app) return null;

  let width = readStoredWidth();
  let surface = null; // 当前装的是哪一面（'browser' | null）
  let rafId = 0;
  let occluded = false;

  /** 订阅者：surface 想知道「viewport 矩形变了」。 */
  const listeners = new Set();
  /** 订阅者：surface 想知道「有没有弹层盖上来了」。 */
  const occlusionListeners = new Set();
  const surfaceListeners = new Set();

  function viewportEl() {
    return root.querySelector('.rp-viewport');
  }

  /** 量出 viewport 矩形并通知订阅者。**不做校验** —— 校验在主进程。 */
  function measure() {
    rafId = 0;
    const vp = viewportEl();
    if (!vp || root.hidden) return;
    const r = vp.getBoundingClientRect();
    const rect = { x: r.left, y: r.top, width: r.width, height: r.height };
    for (const fn of listeners) {
      try {
        fn(rect);
      } catch {
        /* 单个订阅者出错不该影响别的 */
      }
    }
  }

  function scheduleMeasure() {
    if (rafId) return;
    rafId = requestAnimationFrame(measure);
  }

  /** dock 还是 overlay：**按实际可用宽度算**，不是按窗口断点猜。
   *
   * 拿 app 的实际宽度减掉两侧固定列与实际面板宽度，得到聊天列还剩多少；
   * 不够地板就退化成覆盖式抽屉，让聊天保持可读，而不是继续把它压扁。 */
  function applyMode() {
    const rail = byId('globalRail');
    const sidebar = byId('projectSidebar');
    const railW = rail ? rail.getBoundingClientRect().width : 0;
    const sideW = sidebar && !sidebar.hidden ? sidebar.getBoundingClientRect().width : 0;
    const available = app.clientWidth - railW - sideW - (root.hidden ? 0 : width) - resizer.offsetWidth;
    const mode = !root.hidden && available < CHAT_FLOOR ? 'overlay' : 'dock';
    if (root.dataset.mode !== mode) root.dataset.mode = mode;
  }

  function applyWidth() {
    /* 变量写在 :root 上而不是面板自己身上 —— #toasts 是 body 的另一个子节点，
     * 它要靠 var(--rp-width) 往左让开右栏（见 styles.css 的 Toast 一节）。
     * 写在面板上，那条规则就取不到值了。 */
    document.documentElement.style.setProperty('--rp-width', width + 'px');
    root.style.width = width + 'px';
    applyMode();
    scheduleMeasure();
  }

  function clampWidth(next) {
    const rail = byId('globalRail');
    const sidebar = byId('projectSidebar');
    const railW = rail ? rail.getBoundingClientRect().width : 0;
    const sideW = sidebar && !sidebar.hidden ? sidebar.getBoundingClientRect().width : 0;
    // 上限取工作区的 60%，但至少留出 MIN_WIDTH —— 窗口很窄时也别算出个比下限还小的上限
    const maxByRatio = Math.round(app.clientWidth * 0.6);
    const maxByRoom = Math.max(MIN_WIDTH, Math.round(app.clientWidth - railW - sideW - 200));
    return Math.min(Math.max(next, MIN_WIDTH), Math.max(MIN_WIDTH, Math.min(maxByRatio, maxByRoom)));
  }

  /* ---------- 拖动分隔条 ---------- */

  function onDragStart(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    resizer.classList.add('is-dragging');
    document.body.classList.add('rp-resizing');

    const move = (ev) => {
      // 往左拖 = 变宽。用 clientX 差值，不用 offsetX（缩放与滚动下不可靠）
      width = clampWidth(startW + (startX - ev.clientX));
      applyWidth();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      resizer.classList.remove('is-dragging');
      document.body.classList.remove('rp-resizing');
      storeWidth(width);
      scheduleMeasure();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  resizer.addEventListener('mousedown', onDragStart);
  // 键盘也能调宽度（无障碍）：分隔条是可聚焦的
  resizer.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 40 : 12;
    if (e.key === 'ArrowLeft') width = clampWidth(width + step);
    else if (e.key === 'ArrowRight') width = clampWidth(width - step);
    else return;
    e.preventDefault();
    applyWidth();
    storeWidth(width);
  });

  /* jsdom 里没有 ResizeObserver（smoke 跑到后面才补一个桩），所以按本项目既有
   * 做法先判存在再用 —— 见 composer.js:26 与 conversation-nav.js:291。
   * 没它只是「面板不会自动重量」，不该让整个模块加载失败。 */
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      applyMode();
      scheduleMeasure();
    });
    /* 也盯住两侧固定列：侧栏折叠时 app 的尺寸没变，变的是 stage 与面板各分到多少 ——
     * 只 observe(root) 的话，折叠侧栏后 dock/overlay 的判定会停在旧值。 */
    for (const n of [root, app, byId('globalRail'), byId('projectSidebar')].filter(Boolean)) {
      ro.observe(n);
    }
  }
  window.addEventListener('resize', () => {
    applyMode();
    scheduleMeasure();
  });

  /* ---------- 被弹层遮住时把原生 view 摘下去 ----------
   *
   * WebContentsView 是**原生子视图**，z-index 对它无效 —— 弹层画得再高，
   * 它照样压在弹层上面。所以在任何一个全屏遮罩可见时，把 view 摘下去。
   *
   * 用 MutationObserver 盯那三个遮罩层的 hidden 属性，而不是让每个弹层
   * 各自去调一遍：弹层有三个（#modal / #confirmLayer / #paletteLayer），
   * 而且以后还可能加新的。集中一处判断，就不会出现「新加的弹层忘了通知」。
   * 这也正是「一个事实只有一个 owner」。 */
  const overlays = ['modal', 'confirmLayer', 'paletteLayer', 'globalMoreMenu'].map(byId).filter(Boolean);

  function overlaysVisible() {
    return overlays.some((n) => !n.hidden);
  }

  function syncOcclusion() {
    const next = overlaysVisible();
    if (next === occluded) return;
    occluded = next;
    for (const fn of occlusionListeners) {
      try {
        fn(occluded);
      } catch {
        /* 单个订阅者出错不该影响别的 */
      }
    }
  }

  const mo = new MutationObserver(syncOcclusion);
  for (const n of overlays) mo.observe(n, { attributes: true, attributeFilter: ['hidden'] });

  /* ---------- 打开 / 关闭 ---------- */

  function open(nextSurface) {
    const next = nextSurface || surface || 'browser';
    if (surface !== next) {
      for (const fn of surfaceListeners) fn(next);
      root.querySelector('.rp-body').replaceChildren();
    }
    surface = next;
    root.dataset.surface = surface;
    root.hidden = false;
    app.classList.add('rp-open');
    applyWidth();
    measure();
    announce();
  }

  function close() {
    const focusInside = root.contains(document.activeElement);
    const previous = surface;
    for (const fn of surfaceListeners) fn(null);
    root.querySelector('.rp-body').replaceChildren();
    surface = null;
    delete root.dataset.surface;
    root.hidden = true;
    app.classList.remove('rp-open');
    applyMode();
    announce();
    if (focusInside) byId(previous === 'browser' ? 'btnBrowser' : 'navChanges')?.focus();
  }

  /** 告诉外面「右栏开了/关了」—— 入口按钮的 aria-pressed 要跟着变，
   *  而从面板内部的 × 关闭时只有这里知道。 */
  function announce() {
    document.dispatchEvent(
      new CustomEvent('pi-gui:right-pane', { detail: { open: !root.hidden, surface } })
    );
  }

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || overlaysVisible()) return;
    event.preventDefault(); event.stopPropagation(); close();
  });
  document.addEventListener('pi-gui:workspace-view', event => {
    if (event.detail?.view !== 'chat' && !root.hidden) close();
  });

  return {
    root,
    open,
    close,
    isOpen: () => !root.hidden,
    surface: () => surface,
    width: () => width,
    isOccluded: () => occluded,
    /** 订阅 viewport 矩形。返回取消订阅函数。 */
    onViewport: (fn) => {
      listeners.add(fn);
      if (root) scheduleMeasure();
      return () => listeners.delete(fn);
    },
    /** 订阅「被弹层遮住」的变化。返回取消订阅函数。
     *  打开右栏时如果已经有弹层，立刻用当前值回调一次，
     *  否则 surface 会以为「没被遮住」，把原生 view 留在弹层上面。 */
    onOccluded: (fn) => {
      occlusionListeners.add(fn);
      try {
        fn(occluded);
      } catch {
        /* 同上 */
      }
      return () => occlusionListeners.delete(fn);
    },
    onSurfaceChange: (fn) => { surfaceListeners.add(fn); return () => surfaceListeners.delete(fn); },
    /** 容器尺寸可能变了（例如侧栏折叠），主动重量一次。 */
    refresh: () => {
      applyMode();
      scheduleMeasure();
    },
  };
}
