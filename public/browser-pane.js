/* 右栏里的「内置浏览器」这一面。
 *
 * 它只做两件事：把工具栏画出来、把主进程报上来的状态如实显示。
 * 网页本身由主进程的 electron/browser-view.cjs 用 WebContentsView 承载 ——
 * 这个模块**不碰**任何网页内容，也拿不到它的 DOM、Cookie、凭据。
 *
 * ---------- 状态只信主进程 ----------
 *
 * canGoBack / canGoForward / loading / url / title 全部来自
 * did-navigate / did-start-loading / … 的转发。前端**不自己猜**：
 * 猜出来的「能后退」会让按钮点亮却点不动，比 disabled 更让人困惑。
 *
 * ---------- 桥可能不存在 ----------
 *
 * 网页版（浏览器里跑 npm start）没有 window.piGuiDesktop，右栏里的浏览器也就
 * 无从谈起 —— 这时入口直接不显示（见 isBrowserAvailable），而不是画一个点了没反应的按钮。 */

import { toast } from './ui/toast.js';
import { acceptGuiBrowserState } from './gui-browser-capabilities.js';

const byId = (id) => document.getElementById(id);

/** 桥在不在。桌面版才有。 */
export function isBrowserAvailable() {
  return Boolean(window.piGuiDesktop?.browser);
}

const ICON_BACK = '<svg viewBox="0 0 24 24"><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>';
const ICON_FORWARD = '<svg viewBox="0 0 24 24"><path d="M9 5.5 15.5 12 9 18.5"/></svg>';
const ICON_RELOAD = '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4.5V10h-5.5"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
const ICON_EXTERNAL = '<svg viewBox="0 0 24 24"><path d="M14 5.5h4.5V10"/><path d="M18.5 5.5 10 14"/><path d="M17 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V9a1.5 1.5 0 0 1 1.5-1.5H10"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';

/** 建工具栏。用 DOM API 而不是 innerHTML —— 和其它面板一致，
 *  也免得把一个巨大的 HTML 字面量塞进 JS。 */
function buildToolbar(host) {
  const bar = document.createElement('div');
  bar.className = 'rp-toolbar';
  bar.id = 'browserToolbar';

  const mk = (id, icon, label, title, cls = 'icon-btn') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = id;
    b.className = cls;
    b.title = title;
    b.setAttribute('aria-label', label);
    b.innerHTML = icon;
    return b;
  };

  const back = mk('browserBack', ICON_BACK, '后退', '后退');
  const forward = mk('browserForward', ICON_FORWARD, '前进', '前进');
  const reload = mk('browserReload', ICON_RELOAD, '刷新', '刷新');

  const address = document.createElement('input');
  address.type = 'text';
  address.id = 'browserAddress';
  address.className = 'rp-address';
  address.placeholder = '输入地址（例如 localhost:3000）';
  address.setAttribute('aria-label', '地址');
  address.spellcheck = false;
  address.autocomplete = 'off';

  const external = mk('browserExternal', ICON_EXTERNAL, '在系统浏览器中打开', '在系统浏览器中打开');
  const close = mk('browserClose', ICON_CLOSE, '关闭内置浏览器', '关闭');
  const agent = mk('browserAgentControl', '', 'Agent 控制', '允许 Agent 控制 localhost 页面', 'btn tiny browser-agent-control');
  agent.textContent = 'Agent 控制';
  agent.setAttribute('aria-pressed', 'false');
  agent.hidden = true;
  const agentStatus = document.createElement('span');
  agentStatus.id = 'browserAgentStatus';
  agentStatus.className = 'browser-agent-status';
  agentStatus.setAttribute('role', 'status');
  agentStatus.hidden = true;

  bar.append(back, forward, reload, address, external, close);

  const viewport = document.createElement('div');
  viewport.className = 'rp-viewport';
  viewport.id = 'browserViewport';

  const error = document.createElement('div');
  error.className = 'rp-error';
  error.id = 'browserError';
  error.hidden = true;

  host.append(bar, viewport, error);
  const agentBar = document.createElement('div');
  agentBar.className = 'browser-agent-bar';
  agentBar.hidden = true;
  agentBar.append(agent, agentStatus);
  host.insertBefore(agentBar, viewport);
  return { bar, back, forward, reload, address, external, close, viewport, error, agent, agentStatus, agentBar };
}

/**
 * @param {object} o
 * @param {object} o.pane                 right-pane.js 的 initRightPane() 返回的面板对象
 * @param {() => void} o.onRequestClose   点工具栏的 × 时调用（由外层决定怎么关）
 */
export function createBrowserSurface({ pane, onRequestClose, bridge = window.piGuiDesktop.browser,
  surfaceName = 'browser', onAgentState = acceptGuiBrowserState }) {
  const host = document.createElement('div');
  host.className = 'rp-surface rp-surface-browser';
  const ui = buildToolbar(host);

  let state = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: null };
  let editing = false;
  let disposed = true;
  let agentState = { available: false, enabled: false, busy: false };
  let agentRequest = false;
  let agentRevision = 0;
  const unsubs = [];

  function render() {
    const hasAgent = typeof bridge.setAgentControl === 'function' && typeof bridge.agentStatus === 'function';
    ui.agentBar.hidden = !hasAgent;
    ui.agent.hidden = !hasAgent;
    ui.agentStatus.hidden = !hasAgent;
    ui.agent.disabled = agentRequest || (!agentState.available && !agentState.enabled);
    ui.agent.setAttribute('aria-pressed', String(agentState.enabled === true));
    ui.agentStatus.textContent = agentState.enabled
      ? agentState.busy ? 'Agent 正在操作浏览器' : 'Agent 控制中 · 仅 localhost'
      : agentState.available ? 'Agent 控制已关闭' : 'Agent 控制不可用';
    ui.back.disabled = !state.canGoBack;
    ui.forward.disabled = !state.canGoForward;
    ui.reload.innerHTML = state.loading ? ICON_STOP : ICON_RELOAD;
    ui.reload.title = state.loading ? '停止' : '刷新';
    ui.reload.setAttribute('aria-label', state.loading ? '停止' : '刷新');

    // 正在编辑时绝不覆盖用户输入 —— 否则每来一次状态更新光标就会跳
    if (!editing && document.activeElement !== ui.address) {
      ui.address.value = state.url === 'about:blank' ? '' : state.url;
    }

    if (state.error) {
      ui.error.hidden = false;
      ui.error.textContent = state.error.message;
    } else {
      ui.error.hidden = true;
      ui.error.textContent = '';
    }
  }

  function mount() {
    if (disposed) {
      disposed = false;
      pane.root.querySelector('.rp-body').appendChild(host);

      ui.back.addEventListener('click', () => bridge.back());
      ui.forward.addEventListener('click', () => bridge.forward());
      // 一个按钮两种语义：加载中转「停止」，否则「刷新」
      ui.reload.addEventListener('click', () => (state.loading ? bridge.stop() : bridge.reload()));
      ui.external.addEventListener('click', () => bridge.openExternal(ui.address.value || state.url));
      ui.close.addEventListener('click', () => onRequestClose());
      ui.agent.addEventListener('click', async () => {
        if (agentRequest) return;
        agentRequest = true;
        render();
        try {
          await bridge.setAgentControl(!agentState.enabled);
          const next = await bridge.agentStatus();
          if (!disposed && next) { agentState = next; onAgentState(next); }
        } catch {
          if (!disposed) toast('无法更改 Agent 控制状态', 'warn');
        } finally {
          agentRequest = false;
          if (!disposed) render();
        }
      });
      ui.address.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        navigate(ui.address.value);
      });
      ui.address.addEventListener('focus', () => {
        editing = true;
      });
      ui.address.addEventListener('blur', () => {
        editing = false;
        render();
      });

      unsubs.push(bridge.onState((next) => {
        state = { ...state, ...next };
        render();
      }));
      unsubs.push(bridge.onNotice((notice) => {
        if (notice?.message) toast(notice.message, 'warn');
      }));
      if (typeof bridge.onAgentState === 'function') unsubs.push(bridge.onAgentState((next) => {
        if (disposed || !next) return;
        agentRevision++;
        agentState = next;
        onAgentState(next);
        render();
      }));
      const initialRevision = agentRevision;
      if (typeof bridge.agentStatus === 'function') Promise.resolve(bridge.agentStatus()).then((next) => {
        if (!disposed && next && initialRevision === agentRevision) { agentState = next; onAgentState(next); render(); }
      }).catch(() => {});
      // 量出来的矩形交给主进程，由它 clamp 后再摆 WebContentsView
      unsubs.push(pane.onViewport((rect) => bridge.setBounds(rect)));
      // 有弹层盖上来时把原生 view 摘下去，否则它会压在弹层上面
      unsubs.push(pane.onOccluded((occluded) => bridge.setOccluded(occluded)));

      render();
    }
  }

  function unmount() {
    if (disposed) return;
    disposed = true;
    for (const fn of unsubs.splice(0)) {
      try {
        fn();
      } catch {
        /* noop */
      }
    }
    host.remove();
    state = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: null };
  }

  async function navigate(input) {
    const text = String(input ?? '').trim();
    if (!text) return;
    const r = await bridge.navigate(text);
    if (!r?.ok) {
      // 拒绝的理由由主进程给（不回显被拒的地址），照实说
      state = { ...state, error: { kind: 'rejected', message: r?.error || '已拒绝该地址' } };
      render();
    }
  }

  return {
    host,
    isLive: () => !disposed,
    async open() {
      pane.open(surfaceName);
      mount();
      const r = await bridge.open();
      if (!r?.ok) {
        state = { ...state, error: { kind: 'open-failed', message: r?.error || '无法打开内置浏览器' } };
        render();
      }
      // 打开后把焦点给地址栏 —— 用户接下来多半就是要输地址
      ui.address.focus();
    },
    // Agent has already created/navigated the native view. Mounting the chrome
    // must neither call open() again nor move focus away from that page.
    openFromAgent() {
      pane.open(surfaceName);
      mount();
    },
    close() {
      unmount();
    },
    focusAddress() {
      ui.address.focus();
      ui.address.select();
    },
    state: () => ({ ...state }),
    /** 给测试用：直接读当前工具栏呈现，避免断言去猜 DOM 结构。 */
    ui,
  };
}

/* ---------- 单例接线 ---------- */

let paneRef = null;
let surfaceRef = null;

/** 关右栏 = 关浏览器：主进程那边同时销毁 WebContentsView。
 *  反复开 → 关 → 开 必须走同一条路，否则 webContents 会一代代留下来。 */
function closeBrowserPane() {
  if (paneRef?.onSurfaceChange) { paneRef.close(); return; }
  if (surfaceRef) {
    surfaceRef.close();
    surfaceRef = null;
  }
  window.piGuiDesktop?.browser?.close();
  if (paneRef) paneRef.close();
}

/** @param {object} pane  right-pane.js 的 initRightPane() 返回的面板对象 */
export function attachBrowserPane(pane) {
  paneRef = pane;
  pane.onSurfaceChange?.((next) => {
    if (next === 'browser' || !surfaceRef) return;
    surfaceRef.close();
    surfaceRef = null;
    window.piGuiDesktop?.browser?.close();
  });
  window.piGuiDesktop?.browser?.onAgentOpen?.(() => {
    if (!surfaceRef) surfaceRef = createBrowserSurface({ pane: paneRef, onRequestClose: closeBrowserPane });
    surfaceRef.openFromAgent();
  });
  return {
    open() {
      if (!isBrowserAvailable()) return false;
      if (!surfaceRef) surfaceRef = createBrowserSurface({ pane: paneRef, onRequestClose: closeBrowserPane });
      surfaceRef.open();
      return true;
    },
    close: closeBrowserPane,
    /** 入口按钮的行为：没开就开，开着就聚焦地址栏（不重复建 view）。 */
    toggle() {
      if (paneRef?.isOpen() && surfaceRef) {
        surfaceRef.focusAddress();
        return true;
      }
      return this.open();
    },
    isOpen: () => Boolean(paneRef?.isOpen()),
    surface: () => surfaceRef,
  };
}
