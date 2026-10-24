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
const paneState = new Map();
const PANE_STATE_LIMIT = 8;

export function readPaneState(view) {
  return paneState.get(view) || null;
}

export function writePaneState(view, state) {
  paneState.delete(view);
  if (!state) return;
  paneState.set(view, state);
  while (paneState.size > PANE_STATE_LIMIT) {
    paneState.delete(paneState.keys().next().value);
  }
}

export function clearPaneState(view) {
  if (view) paneState.delete(view);
  else paneState.clear();
}

export function configureSecondaryPane(pane) {
  secondaryPane = pane;
  pane?.onSurfaceChange(next => {
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
