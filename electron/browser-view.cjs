/* 右栏内置浏览器：WebContentsView 的**唯一**宿主。
 *
 * ---------- 为什么单独一个文件 ----------
 *
 * main.cjs 刻意做得很薄（窗口、生命周期、进程管理）。浏览器这里有二十来个
 * 安全开关 + 一整套导航策略 + 几何同步，堆进 main.cjs 会把那份「薄」吃掉，
 * 而且 tests/electron-guard.cjs 有一条断言盯着 main.cjs 里 `.loadURL(` 只能出现一次
 * （保证「端口被占时窗口不会被指向陌生程序」）—— 浏览器要 loadURL，放进来就破了。
 *
 * 判定逻辑（地址归一化 / 放行 / 几何收敛）在 browser-policy.cjs，那部分是纯函数、
 * 无 electron 依赖，可以直接单测。这里只做**装配**：建 view、挂事件、转发 IPC。
 *
 * ---------- 安全上最关键的一条：独立 Session ----------
 *
 * 主窗口用的是 session.defaultSession，而 main.cjs 的 installTokenHeader() 会给
 * 发往 `http://127.0.0.1:<PORT>/*` 的请求自动注入 X-Pi-Gui-Token。
 *
 * 内置浏览器**绝不能**用 defaultSession：它是给**任意网页**加载内容的，
 * 一旦共用那个 session，右栏里的网页请求本机后端时就会**自动带上令牌** ——
 * 等于把「谁都能调本机后端」这条边界抹掉。
 *
 * 所以这里用**非持久化 partition**（没有 `persist:` 前缀 = 内存态）：
 *   * 它有自己的 cookie / cache / storage，与主窗口完全隔离；
 *   * defaultSession 上的 onBeforeSendHeaders 对它**不生效**；
 *   * 退出应用即清空，不留登录态与缓存身份。
 *
 * 即便如此，导航策略里还有一条独立的兜底：**不许导航到 Pi GUI 自己的 origin**
 * （见 browser-policy.cjs 的 isAllowedBrowserUrl）。两道是不同层面的防线 ——
 * 一道管「请求带不带令牌」，一道管「能不能往那儿去」，都不省。
 *
 * ---------- 与 hardenWebContents 的关系 ----------
 *
 * main.cjs 把 hardenWebContents() 挂在 app 级 web-contents-created 上，对**每一个**
 * webContents 生效（导航只能待在自家页面里，站外一律交给系统浏览器）。
 * 那套规则对内置浏览器是**错的** —— 右栏存在的意义就是访问外站。
 * 所以 main.cjs 用 isBrowserWebContents() 把这一个 webContents 排除掉，
 * 由本文件用 isAllowedBrowserUrl 另行把守。 */

'use strict';

const { WebContentsView, session, shell } = require('electron');
const { normalizeAddressInput, isAllowedBrowserUrl, clampBounds, PARTITION } = require('./browser-policy.cjs');

/** 这个 webContents 是不是内置浏览器的。
 *
 * main.cjs 建窗口时要用它决定「跳过 hardenWebContents」。
 * 用 session 比对而不用打标记：web-contents-created 在 `new WebContentsView()`
 * **构造过程中**就触发了，那时我们还没来得及给 wc 挂任何标记。 */
function isBrowserWebContents(wc) {
  try {
    return Boolean(wc && wc.session) && wc.session === session.fromPartition(PARTITION);
  } catch {
    return false;
  }
}

/** 导航相关的 API 在 Electron 32 之后从 webContents 挪到了 navigationHistory。
 * 两个都试，免得跟着 Electron 版本漂。取不到就按「不能后退」处理 ——
 * 保守方向是对的：按钮 disabled 顶多是少一个功能，判成 false 不会让用户点到错的东西。 */
function navApi(wc) {
  const h = wc?.navigationHistory;
  if (h && typeof h.canGoBack === 'function') {
    return {
      canGoBack: () => h.canGoBack(),
      canGoForward: () => h.canGoForward(),
      goBack: () => h.goBack(),
      goForward: () => h.goForward(),
    };
  }
  const call = (fn) => (typeof wc?.[fn] === 'function' ? wc[fn]() : false);
  return {
    canGoBack: () => call('canGoBack'),
    canGoForward: () => call('canGoForward'),
    goBack: () => typeof wc?.goBack === 'function' && wc.goBack(),
    goForward: () => typeof wc?.goForward === 'function' && wc.goForward(),
  };
}

/** Chromium 在用户按停止 / 重新加载时也会报 did-fail-load，错误码是 -3（ERR_ABORTED）。
 * 那不是一个「页面打不开」，不应当成错误显示给用户。 */
const ERR_ABORTED = -3;

/**
 * @param {object} o
 * @param {string} o.origin             Pi GUI 后端 origin（形如 http://127.0.0.1:7788）
 * @param {() => Electron.BrowserWindow|null} o.getWindow
 * @param {Electron.IpcMain} o.ipcMain
 * @param {(url:string)=>Promise<void>} [o.openExternal]  注入点，测试用
 */
function createBrowserController({ origin, getWindow, ipcMain, openExternal = (u) => shell.openExternal(u) }) {
  let view = null; // WebContentsView | null
  let occluded = false; // 有 modal / palette 盖在上面时挂起
  let lastRect = { x: 0, y: 0, width: 0, height: 0 };
  let sessionReady = false;
  let state = { open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: null };

  const win = () => {
    const w = getWindow();
    return w && !w.isDestroyed() ? w : null;
  };

  /** 独立 session 的安全配置。**只装一次**。
   *
   * 权限**一律拒绝**：第一版不开放任何网站权限（摄像头 / 麦克风 / 定位 /
   * 通知 / 剪贴板读 / 蓝牙 …）。这里不弹 Pi GUI 自己的假权限框 ——
   * 假装问一句却无论如何都拒绝，比直接拒绝更让人误解。
   *
   * 下载一律取消：内置浏览器第一版不做下载管理，更不能让远程网页
   * 自行决定往本机哪儿写文件。 */
  function ensureSession() {
    if (sessionReady) return;
    sessionReady = true;
    const s = session.fromPartition(PARTITION);
    s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    s.setPermissionCheckHandler(() => false);
    s.on('will-download', (event) => {
      event.preventDefault();
      setError('下载', '内置浏览器暂不支持下载，请用「在系统浏览器中打开」');
    });
  }

  function emit() {
    const w = win();
    if (w) {
      try {
        w.webContents.send('pi-gui:browser-state', { ...state });
      } catch {
        /* 窗口正在销毁 */
      }
    }
  }

  /**
   * @param {string} kind
   * @param {string} message
   * @param {string} [url] 只有**已经过 isAllowedBrowserUrl 校验**的 URL 才允许传。
   *        地址栏在失败时要停在用户输的那个地址上，但绝不能把一个没校验过的、
   *        直接来自 Chromium 事件的 URL 写成「当前地址」。
   */
  function setError(kind, message, url) {
    if (kind === '下载') {
      /* 下载被拒不是「页面加载失败」，不该顶掉地址栏的 URL 与错误态；
       * 用一次性提示告诉用户，让它自己在 renderer 里淡出。 */
      const w = win();
      if (w) {
        try {
          w.webContents.send('pi-gui:browser-notice', { kind: 'download-blocked', message });
        } catch {
          /* 窗口正在销毁 */
        }
      }
      return;
    }
    state = { ...state, error: { kind, message }, loading: false, ...(url ? { url } : {}) };
    emit();
  }

  function refreshNav() {
    const wc = view?.webContents;
    if (!wc) return;
    const nav = navApi(wc);
    let url = state.url;
    let title = state.title;
    try {
      url = wc.getURL() || url;
      title = wc.getTitle() || title;
    } catch {
      /* webContents 已销毁 */
    }
    state = { ...state, url, title, canGoBack: nav.canGoBack(), canGoForward: nav.canGoForward() };
    emit();
  }

  function applyBounds() {
    const w = win();
    if (!view || !w) return;
    if (occluded) return; // 被遮住时不上屏，等恢复时再同步
    const content = w.getContentBounds();
    view.setBounds(clampBounds(lastRect, { width: content.width, height: content.height }));
  }

  function attach() {
    const w = win();
    if (!view || !w) return;
    try {
      w.contentView.addChildView(view);
    } catch {
      /* 已经挂上去了 */
    }
    applyBounds();
  }

  function detach() {
    const w = win();
    if (!view || !w) return;
    try {
      w.contentView.removeChildView(view);
    } catch {
      /* 已经摘掉了 */
    }
  }

  /** 建 WebContentsView 并挂事件。**只在打开时调用**（惰性创建）。 */
  function create() {
    ensureSession();
    const w = win();
    if (!w) return false;

    view = new WebContentsView({
      webPreferences: {
        partition: PARTITION, // ← 独立 session，见文件头
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        /* **刻意不挂 preload**：远程页面不该拿到任何桥。
         * 主窗口那个 preload.cjs 绝不能复用到这里 —— 那等于把 openPath /
         * openExternal 的转发能力交给任意网站。 */
      },
    });
    view.setBackgroundColor('#0d0d0d');

    const wc = view.webContents;

    /* 远程页面不许开 Electron 窗口。
     * 安全的地址（按内置浏览器同一套策略判）交给系统浏览器，其余一律丢。 */
    wc.setWindowOpenHandler(({ url }) => {
      if (isAllowedBrowserUrl(url, { origin })) {
        Promise.resolve(openExternal(url)).catch(() => {});
      }
      return { action: 'deny' };
    });

    const guard = (event, url) => {
      if (!isAllowedBrowserUrl(url, { origin })) {
        event.preventDefault();
        setError('blocked', '已拒绝导航到该地址（内置浏览器只允许 HTTPS 与本机地址）');
      }
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);

    wc.on('did-start-loading', () => {
      state = { ...state, loading: true, error: null };
      emit();
    });
    wc.on('did-stop-loading', () => {
      /* loading 必须在这里**显式**归位。
       *
       * 原来这里只调 refreshNav() —— 它管的是 URL / 标题 / 能不能前进后退，
       * **不碰 loading**，于是页面加载成功之后 loading 永远停在 true：
       * 刷新按钮一直显示「停止」，界面状态和 Chromium 的真实状态对不上。
       *
       * 归位只信这个事件，不让 renderer 自己猜。 */
      state = { ...state, loading: false };
      refreshNav();
    });
    wc.on('did-navigate', (_e, url) => {
      state = { ...state, url };
      refreshNav();
    });
    wc.on('did-navigate-in-page', (_e, url) => {
      state = { ...state, url };
      refreshNav();
    });
    wc.on('page-title-updated', (_e, title) => {
      state = { ...state, title: typeof title === 'string' ? title.slice(0, 300) : '' };
      emit();
    });
    wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      /* 地址栏要停在用户输的那个地址上 —— 否则「连不上」之后输入框被清掉，
       * 用户想改一个字符都得重新打一遍。
       *
       * 但事件里这个 URL **来自 Chromium**，不能无条件采纳：只在对它跑一遍
       * isAllowedBrowserUrl（它同时会拒掉 Pi GUI 自己那些别名）通过时才用，
       * 否则沿用当前这个已经校验过的目标。
       * 平时 navigate() 已经先把目标写进 state.url，这里兜的是
       * 「页面内点击触发的失败」那种我们没经手的情况。 */
      const adopted =
        typeof failedUrl === 'string' && isAllowedBrowserUrl(failedUrl, { origin }) ? failedUrl : state.url;
      setError('load-failed', `无法打开页面（${desc || 'ERR_FAILED'} ${code}）`, adopted);
    });
    wc.on('render-process-gone', () => setError('crashed', '页面进程异常退出'));

    state = {
      open: true,
      url: '',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
    };
    attach();
    emit();
    return true;
  }

  /** 关掉并彻底销毁。反复开 / 关不能留下 webContents 或监听器。 */
  function destroy() {
    const dying = view;
    view = null;
    occluded = false;
    state = {
      open: false,
      url: '',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
    };
    if (dying) {
      try {
        const w = win();
        if (w) w.contentView.removeChildView(dying);
      } catch {
        /* 窗口已经没了 */
      }
      try {
        dying.webContents.removeAllListeners();
      } catch {
        /* noop */
      }
      try {
        dying.webContents.close();
      } catch {
        /* 已经销毁 */
      }
    }
    emit();
  }

  /** 地址栏回车 / open() 之后带 URL 进来。返回给 renderer 的结果只说明「接不接受」。 */
  function navigate(input) {
    if (!view) return { ok: false, error: '内置浏览器未打开' };
    const norm = normalizeAddressInput(input);
    if (!norm.ok) return { ok: false, error: norm.reason };
    if (!isAllowedBrowserUrl(norm.url, { origin })) {
      /* 不回显被拒的地址 —— 没必要让它再出现在界面或日志里 */
      return { ok: false, error: '已拒绝该地址（只允许 HTTPS 与本机地址）' };
    }
    try {
      /* 把**规范化且已放行**的目标写进 state.url —— 这是「连不上时地址栏还留着
       * 这个地址」的前提。没有这一步，did-fail-load 只能看到空/旧的 URL，
       * 输入框会被清回上一页甚至空白。
       *
       * 写在这里是安全的：上面 normalize + isAllowedBrowserUrl 两道都过了，
       * 被拒的地址根本走不到这行 —— 所以不会把「拒绝掉的 URL」当成已导航地址。
       * 标题同时清掉：新页面还没来，留着上一页的标题是错的。 */
      state = { ...state, url: norm.url, title: '', error: null, loading: true };
      emit();
      view.webContents.loadURL(norm.url).catch(() => {
        /* 失败由 did-fail-load 统一报告，这里吞掉 Promise 拒绝 */
      });
      return { ok: true, url: norm.url };
    } catch (err) {
      return { ok: false, error: '导航失败：' + (err && err.message ? err.message : String(err)) };
    }
  }

  function command(name) {
    if (!view) return { ok: false, error: '内置浏览器未打开' };
    const wc = view.webContents;
    const nav = navApi(wc);
    try {
      switch (name) {
        case 'back':
          if (nav.canGoBack()) nav.goBack();
          return { ok: true };
        case 'forward':
          if (nav.canGoForward()) nav.goForward();
          return { ok: true };
        case 'reload':
          wc.reload();
          return { ok: true };
        case 'stop':
          wc.stop();
          state = { ...state, loading: false };
          emit();
          return { ok: true };
        default:
          return { ok: false, error: '未知动作' };
      }
    } catch (err) {
      return { ok: false, error: '操作失败：' + (err && err.message ? err.message : String(err)) };
    }
  }

  /** 注册 IPC。在 createWindow 之前调用（与既有的两个 handler 同一时机）。 */
  function register() {
    ipcMain.handle('pi-gui:browser-open', () => {
      if (!view && !create()) return { ok: false, error: '窗口不可用' };
      return { ok: true };
    });
    ipcMain.handle('pi-gui:browser-navigate', (_e, url) => navigate(url));
    ipcMain.handle('pi-gui:browser-command', (_e, name) => {
      if (name === 'close') {
        destroy();
        return { ok: true };
      }
      return command(name);
    });
    ipcMain.handle('pi-gui:browser-set-bounds', (_e, rect) => {
      /* renderer 给的是页面算出来的数，这里只存**原始值**，
       * 上屏前一律过 clampBounds（见 applyBounds）。 */
      lastRect = {
        x: Number(rect?.x),
        y: Number(rect?.y),
        width: Number(rect?.width),
        height: Number(rect?.height),
      };
      applyBounds();
      return { ok: true };
    });
    ipcMain.handle('pi-gui:browser-set-occluded', (_e, flag) => {
      setOccluded(flag);
      return { ok: true };
    });
    ipcMain.handle('pi-gui:browser-open-external', async (_e, url) => {
      const norm = normalizeAddressInput(url);
      const target = norm.ok ? norm.url : '';
      /* 系统浏览器这条路比内置松一档：http/https 都放行（用户在系统浏览器里
       * 能看到完整地址栏）。仍然只认这两种 scheme。 */
      if (!target || !/^https?:\/\//i.test(target)) return { ok: false, error: '已拒绝该地址' };
      try {
        await openExternal(target);
        return { ok: true };
      } catch {
        return { ok: false, error: '打开失败' };
      }
    });
  }

  /** 被弹层遮住时把原生 view 从 contentView 摘下去 / 挂回来。
   *
   * WebContentsView 是原生子视图，z-index 管不到它 —— 不摘就会盖住弹层。
   * 放在返回值上（而不是只留在 IPC 处理器里）是为了让
   * tests/browser-session-check.cjs 能在主进程里**直接**验「真的摘下去了」：
   * renderer 那边根本观察不到原生视图，只能靠这个口子。
   * 它**不是**给页面用的接口 —— preload 暴露的仍然是白名单动作。 */
  function setOccluded(flag) {
    occluded = flag === true;
    if (occluded) detach();
    else attach();
  }

  return {
    register,
    isBrowserWebContents,
    getState: () => ({ ...state }),
    /* 下面两个就是 IPC 处理器调的那两个函数，在这里一并交出去，供
     * tests/browser-session-check.cjs 在**主进程里**直接驱动。
     *
     * 为什么需要这个口子：内置浏览器这个原生视图，renderer 那边**观察不到**
     * （它不在 DOM 里），所以「令牌没被继承」「弹层开着时 view 真的被摘下去」
     * 这两条只能在主进程里验。
     * 它**不是**给页面用的接口 —— preload 暴露的仍然只是那组白名单动作，
     * renderer 拿不到这个对象，也拿不到窗口。 */
    navigate,
    setOccluded,
    /** 窗口尺寸变了由 main 调一次：先按新的客户区再夹一遍已有的矩形，
     *  这样在 renderer 的 ResizeObserver 追上之前 view 也不会溢出窗口。 */
    syncBounds: applyBounds,
    destroy,
    open: () => {
      if (!view) create();
      else attach();
      return { ok: Boolean(view) };
    },
    close: destroy,
  };
}

module.exports = { createBrowserController, isBrowserWebContents, PARTITION };
