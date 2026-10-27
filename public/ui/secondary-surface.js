/* Contextual work shares the existing right pane; Chat remains mounted. */
import { $ } from '../state.js';

let secondaryPane = null;
let secondaryCurrent = null;
let secondaryToken = 0;

/* ---------- 面板重开时的轻量状态暂存 ----------
 *
 * 切换右栏 surface 会销毁业务面板；这里只暂存「重开同一个视图时值得还原」的
 * 小块 UI 状态（展开目录、滚动位置），不保存 DOM、不保存业务数据。
 * 键 = surface 名；换 workspace/会话的失效与清空由各业务模块自己负责 ——
 * 它们恢复时会重新校验身份，对不上的数据直接丢弃。 */
const ALLOWED_RESTORE_SURFACES = new Set(['changes', 'specs']);
const ACTIVE_SURFACE_KEY = 'pi-gui:secondary-active-surface';
const PANE_STATE_KEY = 'pi-gui:secondary-pane-state';

function readStoredPaneStateMap() {
  try {
    if (typeof sessionStorage === 'undefined') return new Map();
    const raw = sessionStorage.getItem(PANE_STATE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return new Map(Object.entries(parsed));
    }
  } catch {}
  return new Map();
}

function persistPaneStateMap(map) {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const obj = Object.fromEntries(map.entries());
    sessionStorage.setItem(PANE_STATE_KEY, JSON.stringify(obj));
  } catch {}
}

const paneState = readStoredPaneStateMap();
const PANE_STATE_LIMIT = 8;

export function readPaneState(view) {
  return paneState.get(view) || null;
}

export function writePaneState(view, state) {
  paneState.delete(view);
  if (!state) {
    persistPaneStateMap(paneState);
    return;
  }
  paneState.set(view, state);
  while (paneState.size > PANE_STATE_LIMIT) {
    paneState.delete(paneState.keys().next().value);
  }
  persistPaneStateMap(paneState);
}

export function clearPaneState(view) {
  if (view) paneState.delete(view);
  else paneState.clear();
  persistPaneStateMap(paneState);
}

export function readRestoredSurface() {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const s = sessionStorage.getItem(ACTIVE_SURFACE_KEY);
    if (s && ALLOWED_RESTORE_SURFACES.has(s)) return s;
  } catch {}
  return null;
}

export function writeRestoredSurface(surface) {
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (surface && ALLOWED_RESTORE_SURFACES.has(surface)) {
      sessionStorage.setItem(ACTIVE_SURFACE_KEY, surface);
    } else {
      sessionStorage.removeItem(ACTIVE_SURFACE_KEY);
    }
  } catch {}
}

export function clearRestoredSurface() {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.removeItem(ACTIVE_SURFACE_KEY);
  } catch {}
}

if (typeof document !== 'undefined') {
  document.addEventListener('pi-gui:workspace-generation', () => {
    clearRestoredSurface();
    clearPaneState();
  });
}

export function configureSecondaryPane(pane) {
  secondaryPane = pane;
  pane?.onSurfaceChange(next => {
    if (!next || !ALLOWED_RESTORE_SURFACES.has(next)) {
      clearRestoredSurface();
    }
    if (!secondaryCurrent || next === secondaryCurrent.view) return;
    const old = secondaryCurrent;
    secondaryCurrent = null;
    old.dispose?.();
  });
}

export function openSecondarySurface(view, mount, {label='文件变更',headerSelector='.chg-head',triggerId='navChanges'}={}) {
  if (!secondaryPane) throw new Error('Right pane not configured');
  const hadFocus = secondaryPane.root.contains(document.activeElement);
  secondaryCurrent?.dispose?.();
  secondaryCurrent = null;
  if (ALLOWED_RESTORE_SURFACES.has(view)) {
    writeRestoredSurface(view);
  } else {
    clearRestoredSurface();
  }
  secondaryPane.open(view);
  const host = document.createElement('section');
  host.className = 'rp-surface secondary-surface';
  host.setAttribute('aria-label', label);
  const close = document.createElement('button');
  close.id = 'rightPaneClose';
  close.type = 'button'; close.className = 'icon-btn secondary-close';
  close.textContent = '×'; close.setAttribute('aria-label', `关闭${label}`);
  close.onclick = () => { secondaryPane.close(); $(triggerId)?.focus(); };
  const disposers = new Set();
  let disposed = false;
  const instance = {
    view, token: ++secondaryToken,
    isCurrent: () => secondaryCurrent === instance,
    onDispose(fn) {
      if (typeof fn === 'function' && instance.isCurrent()) disposers.add(fn);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (secondaryCurrent === instance) secondaryCurrent = null;
      for (const fn of [...disposers].reverse()) {
        try {
          fn();
        } catch {
          /* One surface must not prevent the other from releasing its listeners. */
        }
      }
      disposers.clear();
    },
    close() {
      clearRestoredSurface();
      secondaryPane.close();
    },
  };
  secondaryCurrent = instance;
  secondaryPane.root.querySelector('.rp-body').replaceChildren(host);
  mount(host, instance);
  host.querySelector(headerSelector)?.append(close);
  if (hadFocus) close.focus();
  return instance;
}
