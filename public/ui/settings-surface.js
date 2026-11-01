/* Settings owns navigation only. Forms, approvals and persistence keep their
 * existing modal/module lifetimes; Chat is hidden by workspace-surface. */
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
      $('runtimeView').querySelector('.runtime-conversation > textarea:not([disabled])')?.focus();
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
  }

  function open() {
    if (sidebar.hidden) $('btnSidebarExpand').click();
    openWorkSurface('settings', host => {
      host.classList.add('settings-surface');
      const heading = document.createElement('h2'); heading.textContent = '设置';
      const description = document.createElement('p');
      description.className = 'settings-description';
      description.textContent = '管理工作区、模型与应用偏好。';
      host.append(heading, description);
      for (const section of menu.querySelectorAll('section')) {
        const group = document.createElement('section'); group.className = 'settings-section';
        const title = document.createElement('h3'); title.textContent = section.querySelector('h3').textContent;
        group.append(title);
        for (const target of section.querySelectorAll('button')) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'settings-row';
          button.textContent = target.id === 'navPlanner' ? '任务与审阅' : target.id === 'navExtensions' ? 'Skills 与扩展' : target.childNodes[0].textContent;
          button.onclick = () => { target.focus(); target.click(); };
          group.append(button);
        }
        host.append(group);
      }
    });
    sync();
    $('navProviders').focus();
  }

  trigger.onclick = open;
  back.onclick = returnToWorkspace;
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
  return { open };
}
