import { S } from './state.js';
import { fetchWorktrees, worktreeAction } from './api.js';
import { openModal, closeModal, confirmModal, dismissConfirm } from './ui/modal.js';
import { openActionMenu, closeActionMenu, MENU_ICONS } from './ui/action-menu.js';

const healthLabels = { healthy: '可用', missing: '目录已丢失', unavailable: '身份无法确认', changed: '分支已变化', locked: 'Git 已锁定', creating: '创建未完成' };
function node(tag, className, text) {
  const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e;
}
function button(text, run, className = 'btn') { const b = node('button', className, text); b.type = 'button'; b.onclick = run; return b; }

// One existing runtime, explicit workspace identity. No child is spawned by listing.
export function openWorktreeManager(project, { activateWorkspace } = {}) {
  let alive = true, busy = false, confirming = false, order = 0, contextGeneration;
  const generation = S.workspaceGeneration;
  const current = () => alive && generation === S.workspaceGeneration;
  const switched = () => { if (alive && !current()) closeModal(); };
  document.addEventListener('pi-gui:workspace-generation', switched);
  openModal((card, close) => {
    card.classList.add('wide', 'wt-manager');
    card.setAttribute('aria-label', '工作区管理');
    const head = node('div', 'wt-head');
    head.append(node('h3', '', '工作区管理'), button('关闭', close)); card.append(head);
    card.append(node('p', 'modal-desc', `${project.name || '项目'} · 当前仍按顺序切换工作区。`));
    const notice = node('div', 'wt-notice'); notice.setAttribute('role', 'status'); card.append(notice);
    const list = node('div', 'wt-list'); card.append(list);
    const form = node('form', 'wt-form');
    const source = node('input'); source.value = 'HEAD'; source.maxLength = 200;
    const branch = node('input'); branch.placeholder = '自动生成独立分支'; branch.maxLength = 160;
    for (const [text, input] of [['源提交 / 本地分支', source], ['新分支（可选）', branch]]) {
      const label = node('label'); label.append(node('span', '', text), input); form.append(label);
    }
    const createButton = button('创建工作区', () => create()); createButton.classList.add('primary'); form.append(createButton);
    form.onsubmit = e => { e.preventDefault(); void create(); }; card.append(form);
    function lock(value) { busy = value; for (const b of card.querySelectorAll('button, input')) if (b !== head.lastChild) b.disabled = value || b.dataset.unavailable === 'true'; }
    function error(result) { notice.textContent = result.error || '操作未完成，请刷新重试。'; }
    async function action(name, row, extra = {}) {
      if (busy || !current()) return; lock(true);
      try {
        const result = await worktreeAction(name, { id: row.id, epoch: row.epoch, ...extra }, contextGeneration);
        if (!current()) return; if (!result.ok) error(result); else { notice.textContent = ''; await load(); }
      } finally { if (current()) {
        lock(false);
        if (document.activeElement === document.body) {
          const refreshed = [...list.querySelectorAll('.wt-row')].find(e => e.dataset.workspaceId === row.id);
          (refreshed?.querySelector('.row-action-trigger:not([disabled])') || head.lastChild).focus();
        }
      } }
    }
    async function create() {
      if (busy || !current() || !Number.isInteger(contextGeneration)) return;
      lock(true); notice.textContent = '';
      try {
        const args = { project: project.path, source: source.value.trim() || 'HEAD' };
        if (branch.value.trim()) args.branch = branch.value.trim();
        const plan = await worktreeAction('prepare', args, contextGeneration);
        if (!current()) return; if (!plan.ok) return error(plan);
        confirming = true;
        const accepted = await confirmModal({ title: '创建独立工作区', okText: '创建工作区',
          message: `${plan.plan.branch}\n基于 ${plan.plan.sourceHash.slice(0, 12)}。${plan.plan.mainDirty ? '主工作区有未提交修改，这些修改不会复制到新工作区。' : '新工作区只包含选定提交。'}不自动 stash/reset，不改变主工作区；会占用额外磁盘空间。` });
        confirming = false; if (!accepted || !current()) return;
        const result = await worktreeAction('create', { nonce: plan.nonce }, contextGeneration);
        if (!current()) return; if (!result.ok) error(result); else { branch.value = ''; await load(); }
      } finally { if (current()) { lock(false); if (document.activeElement === document.body) createButton.focus(); } }
    }
    async function load() {
      const request = ++order; const result = await fetchWorktrees(project.path);
      if (!current() || request !== order) return; list.replaceChildren();
      if (!result.ok) { error(result); list.append(button('重试', load)); createButton.disabled = true; return; }
      contextGeneration = result.contextGeneration; createButton.disabled = busy;
      for (const row of result.items) {
        const item = node('div', 'wt-row'), info = node('div', 'wt-info'); item.dataset.workspaceId = row.id;
        info.append(node('div', 'wt-name', row.kind === 'main' ? '主工作区' : row.branch || '未命名工作区'));
        info.append(node('div', 'modal-desc', [row.kind === 'external' ? '外部工作区 · 仅查看' : healthLabels[row.health] || row.health,
          row.archived ? '已归档' : '', row.current ? '当前' : ''].filter(Boolean).join(' · ')));
        item.append(info);
        if (row.kind !== 'external') {
          const usable = row.health === 'healthy' && !row.archived && !row.current;
          const open = button(row.current ? '当前' : '打开', async () => {
            if (busy || !current() || !activateWorkspace) return;
            const expected = contextGeneration; close();
            await activateWorkspace(row, row.kind === 'main' ? undefined : () => worktreeAction('open', { id: row.id, epoch: row.epoch }, expected));
          });
          open.dataset.unavailable = String(!usable); open.disabled = busy || !usable; item.append(open);
          if (row.kind === 'managed') {
            const menu = button('⋯', () => openActionMenu(menu, [
              { label: row.archived ? '取消归档' : '归档', icon: MENU_ICONS.archive, disabled: row.current, onClick: () => action('archive', row, { archived: !row.archived }) },
              ...(row.health !== 'healthy' ? [{ label: '以此分支新建', onClick: () => { source.value = row.branch; source.focus(); } }] : []),
              { label: '移除工作区', icon: MENU_ICONS.trash, danger: true, disabled: row.current || row.health !== 'healthy', onClick: async () => {
                confirming = true; const yes = await confirmModal({ title: '移除工作区', message: '仅移除已合并且干净的受控工作区。分支保留；有未提交或 ignored 文件时将拒绝。', okText: '移除工作区', danger: true });
                confirming = false; if (yes && current()) await action('remove', row);
              } },
            ]), 'row-action-trigger');
            menu.setAttribute('aria-label', `${row.branch} 的操作`); item.append(menu);
            menu.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.55"/><circle cx="12" cy="12" r="1.55"/><circle cx="18.5" cy="12" r="1.55"/></svg>';
          }
        }
        list.append(item);
      }
    }
    void load();
  }, () => {
    alive = false; order++; document.removeEventListener('pi-gui:workspace-generation', switched);
    closeActionMenu(); if (confirming) dismissConfirm();
  });
}
