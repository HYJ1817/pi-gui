/* Settings owns page lifetimes. Form builders retain persistence/auth ownership;
 * each detail has its own card and disposal, separate from the global modal. */
import { $ } from '../state.js';
import { openWorkSurface, showChat, workspaceView } from './workspace-surface.js';

export function initSettingsSurface({ captureRuntimeReturn = () => null } = {}) {
  const menu = $('globalMoreMenu');
  const trigger = $('navGlobalMore');
  const sidebar = $('projectSidebar');
  const back = $('settingsReturn');
  let returnView = 'chat';
  let previousView = workspaceView();
  let resumeRuntime = null;
  let returnRequest = 0;
  let detailButton = null;
  const returnStatus = document.createElement('p');
  returnStatus.className = 'settings-return-status'; returnStatus.setAttribute('role', 'status');
  returnStatus.hidden = true; back.after(returnStatus);

  async function returnToWorkspace() {
    if (returnView !== 'runtime' || !resumeRuntime) { showChat({ focusComposer: true }); return; }
    const request = ++returnRequest;
    const isCurrent = () => request === returnRequest;
    back.setAttribute('aria-busy', 'true');
    const result = await resumeRuntime({ isCurrent });
    if (result === 'restored' && workspaceView() === 'runtime') {
      $('runtimeView').querySelector('textarea[aria-label="给当前会话的任务"]:not([disabled])')?.focus();
    } else if (isCurrent()) {
      if (result === 'missing') showChat({ focusComposer: true });
      else { returnStatus.hidden = false; returnStatus.textContent = '暂时无法返回会话，请重试。'; }
    }
    if (request === returnRequest) back.removeAttribute('aria-busy');
  }

  function sync() {
    returnRequest++;
    back.removeAttribute('aria-busy'); returnStatus.hidden = true;
    const view = workspaceView();
    const open = ['settings', 'planner', 'extensions'].includes(view);
    if (open && previousView === 'runtime') resumeRuntime = captureRuntimeReturn();
    if (!open) returnView = view === 'runtime' ? 'runtime' : 'chat';
    previousView = view;
    menu.hidden = !open;
    sidebar.classList.toggle('settings-mode', open);
    back.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    trigger.classList.toggle('is-active', open);
    if (detailButton) {
      detailButton.removeAttribute('aria-current'); detailButton.classList.remove('is-active'); detailButton = null;
    }
  }

  function open() {
    if (sidebar.hidden) $('btnSidebarExpand').click();
    openWorkSurface('settings', host => {
      host.classList.add('settings-surface');
      const head = document.createElement('div');
      head.className = 'settings-surface-head';
      const heading = document.createElement('h2'); heading.textContent = '设置';
      const description = document.createElement('p');
      description.className = 'settings-description';
      description.textContent = '管理工作区、AI 模型与应用偏好。';
      head.append(heading, description);
      host.append(head);

      const grid = document.createElement('div');
      grid.className = 'settings-grid';

      for (const section of menu.querySelectorAll('section')) {
        const group = document.createElement('section'); group.className = 'settings-section ds-settings-card';
        const title = document.createElement('h3'); title.textContent = section.querySelector('h3').textContent;
        group.append(title);
        for (const target of section.querySelectorAll('button')) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'settings-row';
          const label = target.querySelector('span')?.textContent || target.childNodes[0]?.textContent || target.textContent;
          const svg = target.querySelector('svg')?.outerHTML || '';
          button.innerHTML = `<span class="settings-row-icon">${svg}</span><span class="settings-row-label">${label}</span><svg class="settings-row-arrow" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>`;
          button.onclick = () => { target.focus(); target.click(); };
          group.append(button);
        }
        grid.append(group);
      }
      host.append(grid);
    });
    sync();
    $('navProviders').focus();
  }

  function presentDetail(destination, build, onClose, options = {}) {
    if (sidebar.hidden) $('btnSidebarExpand').click();
    const target = $(destination);
    const instance = openWorkSurface('settings', (host, life) => {
      host.classList.add('settings-detail');
      const card = document.createElement('section');
      card.className = 'modal-card settings-detail-card' + (options.className ? ' ' + options.className : '');
      card.setAttribute('role', 'region'); card.tabIndex = -1;
      card.setAttribute('aria-label', target?.textContent.trim() || '设置详情');
      host.append(card);
      let disposed = false;
      const escape = event => {
        if (event.key !== 'Escape' || event.defaultPrevented || !life.isCurrent()) return;
        if (!$('modal').hidden || !$('confirmLayer').hidden || !$('paletteLayer').hidden) return;
        event.preventDefault(); event.stopPropagation(); close();
      };
      const close = () => {
        if (!life.isCurrent()) return;
        open(); target?.focus();
      };
      life.onDispose(() => {
        if (disposed) return;
        disposed = true; document.removeEventListener('keydown', escape);
        try { if (typeof onClose === 'function') onClose(); } catch { /* Same cleanup isolation as modal close. */ }
        card.remove();
      });
      build(card, close);
      if (!life.isCurrent()) return;
      document.addEventListener('keydown', escape);
      (options.initialFocus || (card.contains(document.activeElement) ? document.activeElement : card)).focus();
    });
    if (instance.isCurrent()) {
      detailButton = target;
      target?.setAttribute('aria-current', 'page'); target?.classList.add('is-active');
    }
    return instance;
  }

  trigger.onclick = open;
  back.onclick = returnToWorkspace;
  const searchInput = $('settingsSearchInput');
  if (searchInput) {
    searchInput.oninput = () => {
      const q = searchInput.value.trim().toLowerCase();
      for (const section of menu.querySelectorAll('section')) {
        let hasMatch = false;
        for (const btn of section.querySelectorAll('button')) {
          const match = !q || btn.textContent.toLowerCase().includes(q);
          btn.hidden = !match;
          if (match) hasMatch = true;
        }
        section.hidden = !hasMatch;
      }
    };
  }
  document.addEventListener('pi-gui:workspace-view', sync);
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('modal').hidden && $('confirmLayer').hidden) {
      event.preventDefault(); event.stopPropagation();
      returnToWorkspace(); trigger.focus();
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...menu.querySelectorAll('button:not([disabled])')];
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  });
  sync();
  return { open, presentDetail };
}
