/* 一级工作区只管理承载和生命周期；业务模块各自渲染唯一的一份内容。 */
import { $ } from '../state.js';

const rail = { chat: 'navHome', planner: 'navPlanner', extensions: 'navExtensions', runtime: 'navHome' };
const titles = { planner: '任务', extensions: 'Skills 与扩展' };
let current = { view: 'chat', token: 0, dispose: null };
let chatScroll = { top: 0, atBottom: true };

function sync(view) {
  const chat = view === 'chat';
  /* P32.4-B：`runtime` 是第四种中央承载（focused 并行会话）。它不是 work surface
   * —— planner/extensions 那套是可插拔容器，而并行会话有自己的容器与生命周期。 */
  const runtime = view === 'runtime';
  const work = !chat && !runtime;
  $('workspace').dataset.workspaceView = view;
  $('chatView').hidden = !chat;
  $('chatComposer').hidden = !chat;
  $('workSurface').hidden = !work;
  $('runtimeView').hidden = !runtime;
  /* 会话视图仍然属于「会话」这一段，所以标题与项目树都保持可见：
   * 用户在并行会话里同样需要点侧栏切走。 */
  $('title').hidden = work;
  $('workViewTitle').hidden = !work;
  $('workViewTitle').textContent = titles[view] || '';
  $('btnTree').hidden = work;
  $('btnMore').hidden = work;
  for (const button of $('globalRail').querySelectorAll('.rail-icon')) {
    const active = button.id === rail[view];
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  document.dispatchEvent(new window.CustomEvent('pi-gui:workspace-view', { detail: { view } }));
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

/** P32.4-B：中央切到某条并行会话。与 showChat 对称 —— 视图本体由组合根挂载到
 * `#runtimeView`（它不是可插拔 work surface）。返回是否发生了切换。 */
export function showRuntimeConversation() {
  const returning = current.view !== 'runtime';
  if (current.dispose) current.dispose();
  current = { view: 'runtime', token: current.token + 1, dispose: null };
  sync('runtime');
  return returning;
}

export function runtimeViewElement() { return $('runtimeView'); }

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
