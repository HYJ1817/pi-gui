/* 项目（= pi 的工作目录）管理 + 目录选择器。
 *
 * 关键前提：pi 的 RPC 协议**没有**切换工作目录的命令，所以「切换项目」
 * 等于用新的 cwd 重启子进程；会话则按 cwd 分目录存在
 * ~/.pi/agent/sessions/--<转义cwd>--/ 下。 */

import { el, S, beginWorkspaceSwitch, ownsWorkspace } from './state.js';
import { showChat } from './ui/workspace-surface.js';
import { samePath } from './util.js';
import {
  activateProject as apiActivateProject,
  createProject,
  deleteProject,
  fetchProjects,
  listDirectory,
  fetchSessions,
} from './api.js';
import { projectExpanded, setProjectExpanded, pruneProjectExpansion } from './sidebar-expansion.js';
import { openModal, confirmModal } from './ui/modal.js';
import { openActionMenu, MENU_ICONS } from './ui/action-menu.js';
import { openProjectSettings } from './project-config.js';
import { toast } from './ui/toast.js';
import { applyProjectState, loadStatus, setBridgeState } from './shell.js';
import { refreshGitNow, resetChanges } from './git.js';
import { clearThread, setStreaming } from './messages.js';

let projectData = { active: '', items: [] };
let activationQueue = Promise.resolve();
let projectLoadState = 'loading';
let projectLoadOrder = 0;
let pendingProjectAction = null;

export function flushProjectSessionAction() {
  const pending = pendingProjectAction;
  if (!pending) return;
  if (!ownsWorkspace(pending.generation) || !samePath(S.cwd, pending.path)) {
    pendingProjectAction = null;
    return;
  }
  if (S.switching || S.bridgeState !== 'ready') return;
  pendingProjectAction = null;
  pending.run();
}

async function activateForSessionAction(project, run) {
  const task = activateProject(project.path, project.name);
  const generation = S.workspaceGeneration;
  try {
    if (await task && ownsWorkspace(generation) && samePath(S.cwd, project.path)) {
      pendingProjectAction = { path: project.path, generation, run };
      flushProjectSessionAction();
    }
  } catch {
    if (ownsWorkspace(generation)) toast('切换项目失败，请重试', 'warn');
  }
}

const SVG_FOLDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const SVG_UP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>';
/* 行尾的动作入口：三点（…）。**不是** Codex 的图标资产，就是三个自己画的圆。 */
const SVG_MORE =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.55"/><circle cx="12" cy="12" r="1.55"/><circle cx="18.5" cy="12" r="1.55"/></svg>';

/* 会话列表要挂在**当前项目那一行下面**（参考 Codex：会话属于项目，
 * 不该单开一个窗口）。projects.js 不 import sessions.js —— 由 app.js 把
 * 渲染函数注入进来，保持两边不互相依赖。 */
let sessionsSlot = null;
export function setSessionsSlot(fn) {
  sessionsSlot = fn;
}

let sessionActions = {};
export function setProjectSessionActions(actions) {
  sessionActions = actions;
}

const HEADER_ICONS = {
  newSession: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
};
const SVG_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 5.5L16 12l-6.5 6.5"/></svg>';

function attachPreview(item, p, index) {
  const box = document.createElement('div');
  box.className = 'pj-sessions pj-preview';
  box.id = 'pjPreview-' + index;
  box.hidden = !projectExpanded(p.path);
  item.after(box);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'pj-chev';
  toggle.innerHTML = SVG_CHEV;
  toggle.setAttribute('aria-controls', box.id);
  let request = 0;
  function sync() {
    toggle.setAttribute('aria-expanded', String(!box.hidden));
    toggle.setAttribute('aria-label', `${box.hidden ? '展开' : '收起'}「${p.name || p.path}」的会话`);
  }
  async function load() {
    const token = ++request;
    box.textContent = '读取会话…';
    try {
      const result = await fetchSessions(p.path);
      if (!box.isConnected || token !== request) return;
      if (!result.ok) throw new Error();
      box.replaceChildren();
      const rows = (result.sessions || []).filter(s => !s.archived);
      for (const s of rows) box.append(sessionActions.previewRow(s, async selected => {
        if (S.streaming) return toast('正在生成回答，请先停止再切换会话', 'warn');
        await activateForSessionAction(p, () => sessionActions.openPreviewSession(selected));
      }));
      if (!rows.length) box.textContent = '还没有会话';
    } catch {
      if (box.isConnected && token === request) box.textContent = '读取失败，收起后再展开重试';
    }
  }
  toggle.onclick = e => {
    e.preventDefault();
    e.stopPropagation();
    box.hidden = !box.hidden;
    setProjectExpanded(p.path, !box.hidden);
    sync();
    if (!box.hidden) load();
  };
  item.prepend(toggle);
  sync();
  if (!box.hidden) load();
}

function headerAction(action, label, onClick = null) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pj-header-action';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' + HEADER_ICONS[action] + '</svg>';
  button.onclick = e => {
    e.preventDefault();
    e.stopPropagation();
    if (onClick) onClick();
    else sessionActions[action]?.();
  };
  return button;
}

export async function loadProjects(generation = S.workspaceGeneration) {
  const order = ++projectLoadOrder;
  projectLoadState = 'loading';
  renderProjects();
  const j = await fetchProjects();
  if (!ownsWorkspace(generation) || order !== projectLoadOrder) return;
  if (j && j.ok !== false) {
    projectData = { active: j.active || '', items: j.items || [] };
    projectLoadState = 'content';
  } else {
    projectLoadState = 'error';
  }
  renderProjects();
}

export function renderProjects() {
  el.projects.innerHTML = '';
  pruneProjectExpansion(projectData.items.map(p => p.path));

  if (projectLoadState === 'loading' && !projectData.items.length) {
    el.projects.innerHTML = '<div class="hint-empty">正在加载项目…</div>';
    return;
  }
  if (projectLoadState === 'error') {
    const notice = document.createElement('div');
    notice.className = 'hint-empty';
    notice.textContent = '项目列表加载失败。';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn';
    retry.textContent = '重试';
    retry.onclick = () => loadProjects();
    notice.appendChild(retry);
    el.projects.appendChild(notice);
  }

  if (!projectData.items.length) {
    if (projectLoadState !== 'error') el.projects.innerHTML = '<div class="hint-empty">还没有项目，点下面的「添加文件夹」。</div>';
    return;
  }

  for (const p of projectData.items) {
    const isActive = samePath(p.path, projectData.active);
    const label = p.name || p.path;

    const item = document.createElement('div');
    item.className = 'project' + (isActive ? ' active' : '');
    /* 绝对路径挂在这里（以及下面 select 的 aria-label 上）。
     * 以前它还常驻一行 .pj-path 副标题，把项目行撑成会话行的近两倍高；
     * 现在行内显示项目名、展开箭头与操作入口。 */
    item.title = p.path;

    const select = document.createElement(isActive ? 'span' : 'button');
    if (!isActive) select.type = 'button';
    select.className = 'pj-select';
    /* 图标与名称都不含路径，所以把路径补进无障碍名字里 ——
     * 视觉上的副标题去掉之后，读屏仍能拿到完整路径。 */
    const ariaPath = p.name && p.path && p.path !== p.name ? `（${p.path}）` : '';
    select.setAttribute('aria-label', `${isActive ? '当前项目' : '切换到项目'}：${label}${ariaPath}`);
    if (isActive) select.setAttribute('aria-current', 'true');

    const icon = document.createElement('span');
    icon.className = 'pj-icon';
    icon.innerHTML = SVG_FOLDER;

    const body = document.createElement('div');
    body.className = 'pj-body';
    const n = document.createElement('span');
    n.className = 'pj-name';
    n.textContent = label;
    body.append(n);

    /* 行尾是**一个**三点入口，不再是常驻的 ✕。
     *
     * 三个行为必须完全隔离（点是点、折是折、切是切）：
     *   点 name / folder（`.pj-select`）→ 原有项目切换
     *   点 chevron（`.pj-chev`，由 sessions.js 插在行首）→ 原有会话折叠
     *   点 …（`.pj-row-menu-trigger`）→ **只**打开动作菜单
     * 所以这里自己 preventDefault + stopPropagation：事件不冒泡到行上，
     * 也就不会顺带触发切换或折叠。 */
    const menuTrigger = document.createElement('button');
    menuTrigger.className = 'pj-row-menu-trigger row-action-trigger';
    menuTrigger.type = 'button';
    menuTrigger.title = '更多操作';
    menuTrigger.setAttribute('aria-label', `项目操作：${label}`);
    menuTrigger.setAttribute('aria-haspopup', 'menu');
    menuTrigger.setAttribute('aria-expanded', 'false');
    menuTrigger.innerHTML = SVG_MORE;
    menuTrigger.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      /* 菜单只放**真实已有**的功能：项目设置（既有 openProjectSettings）
       * 与移除项目（既有 removeProject，前面加一次确认）。
       * 不发明置顶 / 分区 / 分支 / 打开资源管理器这些 Pi GUI 没有的东西。
       *
       * ⚠️「项目设置」**只对当前项目**出现：`openProjectSettings()` 读的是
       * 当前**激活**项目的配置，对一个非当前项目开放这个入口，等于「点 B 的
       * 菜单、实际改的是 A 的设置」。要改 B 就先切到 B —— 但切换会重启 Pi、
       * 清聊天，那是一个菜单动作不该顺手制造的副作用。
       * 「移除项目」按**这一行的 path** 操作，与是不是当前项目无关。 */
      openActionMenu(menuTrigger, [
        ...(isActive ? [
          { label: '项目设置', icon: MENU_ICONS.pencil, onClick: () => openProjectSettings() },
          { separator: true },
        ] : []),
        { label: '移除项目', icon: MENU_ICONS.trash, danger: true, onClick: () => confirmRemoveProject(p.path, label) },
      ]);
    };

    select.append(icon, body);
    item.append(select);
    if (isActive) item.append(headerAction('newSession', '新对话'), headerAction('search', '搜索会话'));
    else item.append(headerAction('newSession', `在「${label}」中新对话`, async () => {
      if (S.streaming) return toast('正在生成回答，请先停止再新建其它项目的会话', 'warn');
      await activateForSessionAction(p, () => sessionActions.newSession?.());
    }));
    item.append(menuTrigger);
    if (!isActive) {
      select.onclick = () => activateProject(p.path, label);
    }

    el.projects.appendChild(item);

    /* 当前项目使用完整会话列表，其它项目按需加载只读预览。
     * 当前项目的折叠箭头由 sessions.js 插进这一行：
     * 箭头必须在 .project **行内**，否则会破坏「.pj-sessions 是当前项目行的
     * 紧邻兄弟」这条被测试盯着的结构（smoke / cdp-shot 都有断言）。 */
    if (isActive && sessionsSlot) sessionsSlot(item, p);
    if (!isActive) attachPreview(item, p, el.projects.querySelectorAll('.project').length);
  }
}

export async function addProject(target, name) {
  const j = await createProject(target, name);
  if (!j.ok) return toast(j.error || '添加失败', 'error');
  await loadProjects();
  await activateProject(j.path, name || '');
}

/**
 * 移除项目前的确认。
 *
 * 三点菜单把「移除」藏进了二级入口，比原来那个常驻的 ✕ 更不容易被误点，
 * 但反过来说也更容易「点下去才发现是移除」。所以**必须**先说清楚：
 * 这是从 Pi GUI 的项目列表里移除，**不删除磁盘上的任何文件**。
 * 真正的动作仍然是既有的 `removeProject()`，这里不复制它的实现。
 */
async function confirmRemoveProject(target, label) {
  const ok = await confirmModal({
    title: '移除这个项目？',
    message: `「${label}」只会从 Pi GUI 的项目列表里移除，不会删除磁盘上的项目文件。`,
    okText: '移除项目',
    danger: true,
  });
  if (ok !== true) return;
  await removeProject(target);
}

export async function removeProject(target) {
  const j = await deleteProject(target);
  if (!j.ok) return toast(j.error || '移除失败', 'error');
  await loadProjects();
  /* 移掉的可能是当前正在用的那个项目。后端会把「上次激活」清掉但让会话继续跑，
   * 所以这里回读一次状态，让界面高亮和底部连接指示跟着走，别停在旧状态上。 */
  await loadStatus();
  /* 变更列表是按项目算的，换了项目就必须整体重来 ——
   * 留着上一个项目的文件列表比空着更糟。 */
  resetChanges();
  refreshGitNow();
}

export function activateProject(target, label) {
  pendingProjectAction = null;
  showChat();
  const generation = beginWorkspaceSwitch(target);
  clearThread();
  setStreaming(false);
  S.models = [];
  S.state = null;
  S.stats = null;
  resetChanges();
  const title = label || target;
  el.title.textContent = title;
  el.footName.textContent = title;
  setBridgeState('restarting');
  applyProjectState();
  // HTTP 激活按用户点击顺序串行；尚未发出的中间选择直接跳过。
  // 已在途的请求结束后，只有最后一次选择可以更新界面。
  const task = activationQueue.catch(() => {}).then(async () => {
    if (!ownsWorkspace(generation)) return;
    const j = await apiActivateProject(target);
    if (!ownsWorkspace(generation)) return;
    if (!j.ok) {
      S.switching = false;
      S.syncPending = null;
      await Promise.all([loadStatus(generation), loadProjects(generation)]);
      setBridgeState(S.hasProject ? 'ready' : 'no-project');
      toast(j.error || '切换失败', 'error');
      return;
    }
    S.cwd = j.cwd || target;
    S.hasProject = true;
    await Promise.all([loadStatus(generation), loadProjects(generation), refreshGitNow()]);
    return ownsWorkspace(generation);
  });
  activationQueue = task;
  return task;
}

/* ---------- 目录选择器 ---------- */

export function openDirPicker() {
  let current = '';

  openModal((card, close) => {
    card.classList.add('wide');

    const h = document.createElement('h3');
    h.textContent = '选择项目文件夹';
    card.appendChild(h);

    const desc = document.createElement('div');
    desc.className = 'modal-desc';
    desc.textContent = '选一个目录作为 pi 的工作目录。切换后 pi 会以该目录重启，并尝试接上这里之前的工作。';
    card.appendChild(desc);

    const crumbs = document.createElement('div');
    crumbs.className = 'crumbs';
    card.appendChild(crumbs);

    const list = document.createElement('div');
    list.className = 'dir-list';
    card.appendChild(list);

    const selected = document.createElement('div');
    selected.className = 'selected-path';
    selected.textContent = '未选择';
    card.appendChild(selected);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = '取消';
    cancel.onclick = close;

    const confirm = document.createElement('button');
    confirm.className = 'btn primary';
    confirm.textContent = '使用此目录';
    confirm.disabled = true;
    confirm.style.opacity = '.45';
    confirm.onclick = () => {
      if (!current) return;
      close();
      addProject(current, '');
    };

    actions.append(cancel, confirm);
    card.appendChild(actions);

    function renderCrumbs(p) {
      crumbs.innerHTML = '';
      const rootBtn = document.createElement('button');
      rootBtn.className = 'crumb';
      rootBtn.textContent = '此电脑';
      rootBtn.onclick = () => go('');
      crumbs.appendChild(rootBtn);

      if (!p) return;

      const isWin = /^[A-Za-z]:/.test(p);
      const parts = p.split(/[\\/]+/).filter(Boolean);
      let acc = isWin ? '' : '/';

      parts.forEach((part, i) => {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '/';
        crumbs.appendChild(sep);

        if (isWin) {
          acc = i === 0 ? part + '\\' : acc.replace(/[\\/]+$/, '') + '\\' + part;
        } else {
          acc = acc.replace(/\/+$/, '') + '/' + part;
        }

        const target = acc;
        const b = document.createElement('button');
        b.className = 'crumb';
        b.textContent = part;
        b.onclick = () => go(target);
        crumbs.appendChild(b);
      });
    }

    function renderList(data) {
      list.innerHTML = '';

      if (data.parent) {
        const up = document.createElement('div');
        up.className = 'dir-item up';
        up.innerHTML = '<span class="ic">' + SVG_UP + '</span><span class="dir-name">返回上级</span>';
        up.onclick = () => go(data.parent);
        list.appendChild(up);
      }

      if (!data.dirs || !data.dirs.length) {
        const empty = document.createElement('div');
        empty.className = 'dir-empty';
        empty.textContent = '该目录下没有子文件夹';
        list.appendChild(empty);
        return;
      }

      for (const d of data.dirs) {
        const item = document.createElement('div');
        item.className = 'dir-item';
        item.innerHTML = '<span class="ic">' + SVG_FOLDER + '</span><span class="dir-name"></span>';
        item.querySelector('.dir-name').textContent = d.name;
        item.onclick = () => go(d.path);
        list.appendChild(item);
      }
    }

    async function go(target) {
      const data = await listDirectory(target);
      if (!data || data.network) {
        toast('无法读取目录：' + ((data && data.error) || '网络异常'), 'error');
        return;
      }
      if (!data.ok) return toast(data.error || '读取失败', 'error');

      current = data.path || '';
      renderCrumbs(current);
      renderList(data);

      selected.textContent = current || '请选择一个目录';
      confirm.disabled = !current;
      confirm.style.opacity = current ? '1' : '.45';
    }

    go('');
  });
}
