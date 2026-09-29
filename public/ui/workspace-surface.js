/* 一级工作区只管理承载和生命周期；业务模块各自渲染唯一的一份内容。 */
import { $ } from '../state.js';

const rail = { chat: 'navHome', planner: 'navPlanner', changes: 'navChanges', extensions: 'navExtensions' };
const titles = { planner: '任务', changes: '文件变更', extensions: '扩展' };
let current = { view: 'chat', token: 0, dispose: null };
let chatScroll = { top: 0, atBottom: true };

function sync(view) {
  const chat = view === 'chat';
  $('workspace').dataset.workspaceView = view;
  $('chatView').hidden = !chat;
  $('chatComposer').hidden = !chat;
  $('workSurface').hidden = chat;
  $('title').hidden = !chat;
  $('workViewTitle').hidden = chat;
  $('workViewTitle').textContent = titles[view] || '';
  $('btnTree').hidden = !chat;
  $('btnMore').hidden = !chat;
  $('btnShare').hidden = !chat;
  $('btnStats').hidden = !chat;
  for (const button of $('globalRail').querySelectorAll('.rail-icon')) {
    const active = button.id === rail[view];
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

export function workspaceView() { return current.view; }

export function showChat({ focusComposer = false } = {}) {
  const returning = current.view !== 'chat';
  const focusWasInSurface = $('workSurface').contains(document.activeElement);
  if (current.dispose) current.dispose();
  current = { view: 'chat', token: current.token + 1, dispose: null };
  $('workSurface').replaceChildren();
  $('workSurface').className = 'work-surface';
  sync('chat');
  if (focusWasInSurface || focusComposer) {
    const input = $('input');
    (input.disabled ? $(rail.chat) : input).focus();
  }
  if (returning) {
    const stream = $('stream');
    stream.scrollTop = chatScroll.atBottom ? stream.scrollHeight : chatScroll.top;
  }
}

export function openWorkSurface(view, mount) {
  if (!titles[view]) throw new Error('Unknown work surface: ' + view);
  if (current.view === 'chat') {
    const stream = $('stream');
    chatScroll = {
      top: stream.scrollTop,
      atBottom: stream.scrollHeight - stream.clientHeight - stream.scrollTop <= 24,
    };
  }
  if (current.dispose) current.dispose();
  const token = current.token + 1;
  const host = $('workSurface');
  const focusWasInSurface = host.contains(document.activeElement);
  host.replaceChildren();
  host.className = 'work-surface';
  const instance = {
    view, token,
    isCurrent: () => current.token === token && current.view === view,
    onDispose(fn) { if (instance.isCurrent()) current.dispose = fn; },
  };
  current = { view, token, dispose: null };
  sync(view);
  mount(host, instance);
  if (focusWasInSurface) $(rail[view]).focus();
  return instance;
}

sync('chat');
