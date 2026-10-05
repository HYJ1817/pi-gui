/* Contextual work shares the existing right pane; Chat remains mounted. */
import { $ } from '../state.js';

let secondaryPane = null;
let secondaryCurrent = null;
let secondaryToken = 0;

export function configureSecondaryPane(pane) {
  secondaryPane = pane;
  pane?.onSurfaceChange(next => {
    if (!secondaryCurrent || next === secondaryCurrent.view) return;
    const old = secondaryCurrent;
    secondaryCurrent = null;
    old.dispose?.();
  });
}

export function openSecondarySurface(view, mount) {
  if (!secondaryPane) throw new Error('Right pane not configured');
  const hadFocus = secondaryPane.root.contains(document.activeElement);
  secondaryCurrent?.dispose?.();
  secondaryCurrent = null;
  secondaryPane.open(view);
  const host = document.createElement('section');
  host.className = 'rp-surface secondary-surface';
  host.setAttribute('aria-label', '文件变更');
  const close = document.createElement('button');
  close.id = 'rightPaneClose';
  close.type = 'button'; close.className = 'icon-btn secondary-close';
  close.textContent = '×'; close.setAttribute('aria-label', '关闭文件变更');
  close.onclick = () => { secondaryPane.close(); $('navChanges')?.focus(); };
  const instance = {
    view, token: ++secondaryToken, dispose: null,
    isCurrent: () => secondaryCurrent === instance,
    onDispose(fn) { if (instance.isCurrent()) instance.dispose = fn; },
  };
  secondaryCurrent = instance;
  secondaryPane.root.querySelector('.rp-body').replaceChildren(host);
  mount(host, instance);
  host.querySelector('.chg-head')?.append(close);
  if (hadFocus) close.focus();
  return instance;
}
