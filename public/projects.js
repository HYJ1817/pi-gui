/* 项目（= pi 的工作目录）管理 + 目录选择器。
 *
 * 关键前提：pi 的 RPC 协议**没有**切换工作目录的命令，所以「切换项目」
 * 等于用新的 cwd 重启子进程；会话则按 cwd 分目录存在
 * ~/.pi/agent/sessions/--<转义cwd>--/ 下。 */

import { el } from './state.js';
import { samePath } from './util.js';
import {
  activateProject as apiActivateProject,
  createProject,
  deleteProject,
  fetchProjects,
  listDirectory,
} from './api.js';
import { openModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import { loadStatus } from './shell.js';
import { clearThread } from './messages.js';

let projectData = { active: '', items: [] };

const SVG_FOLDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const SVG_UP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>';
const SVG_X =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>';

export async function loadProjects() {
  const j = await fetchProjects();
  if (j && j.ok !== false) projectData = { active: j.active || '', items: j.items || [] };
  else projectData = { active: '', items: [] };
  renderProjects();
}

export function renderProjects() {
  el.projects.innerHTML = '';

  if (!projectData.items.length) {
    el.projects.innerHTML = '<div class="hint-empty">还没有项目，点下面的「添加文件夹」。</div>';
    return;
  }

  for (const p of projectData.items) {
    const isActive = samePath(p.path, projectData.active);

    const item = document.createElement('div');
    item.className = 'project' + (isActive ? ' active' : '');
    item.title = p.path;

    const icon = document.createElement('span');
    icon.className = 'pj-icon';
    icon.innerHTML = SVG_FOLDER;

    const body = document.createElement('div');
    body.className = 'pj-body';
    const n = document.createElement('span');
    n.className = 'pj-name';
    n.textContent = p.name || p.path;
    const pa = document.createElement('span');
    pa.className = 'pj-path';
    pa.textContent = p.path;
    body.append(n, pa);

    const del = document.createElement('button');
    del.className = 'pj-del';
    del.title = '从列表移除（不会删除磁盘文件）';
    del.innerHTML = SVG_X;
    del.onclick = (e) => {
      e.stopPropagation();
      removeProject(p.path);
    };

    item.append(icon, body, del);
    if (!isActive) item.onclick = () => activateProject(p.path, p.name || p.path);

    el.projects.appendChild(item);
  }
}

export async function addProject(target, name) {
  const j = await createProject(target, name);
  if (!j.ok) return toast(j.error || '添加失败', 'error');
  await loadProjects();
  await activateProject(j.path, name || '');
}

export async function removeProject(target) {
  const j = await deleteProject(target);
  if (!j.ok) return toast(j.error || '移除失败', 'error');
  await loadProjects();
  /* 移掉的可能是当前正在用的那个项目。后端会把「上次激活」清掉但让会话继续跑，
   * 所以这里回读一次状态，让界面高亮和底部连接指示跟着走，别停在旧状态上。 */
  await loadStatus();
}

export async function activateProject(target, label) {
  const j = await apiActivateProject(target);
  if (!j.ok) return toast(j.error || '切换失败', 'error');

  clearThread();
  const title = label || target;
  el.title.textContent = title;
  el.footName.textContent = title;
  /* 先回读状态再等 pi 起来：S.cwd 是相对路径补成绝对的依据，
   * 而 hasProject 决定输入框解锁 —— 第一次添加项目时正是靠它从「未选项目」切过来。 */
  await loadStatus();
  await loadProjects();
  toast(`已切换到 ${title}，pi 正在重启…`, 'info');
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
