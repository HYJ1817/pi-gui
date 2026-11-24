/* 设置 → 常规：外部编辑器与工作区外访问。
 *
 * 只做展示与发起请求：
 *   - 编辑器检测/保存/选择可执行文件在主进程（electron/editor-settings.cjs）；
 *   - 工作区外授权只能由主进程的原生对话框创建，这里只列出与撤销。
 * 这样页面即使被注入脚本，也无法自行添加授权或执行命令。 */
import { gitConversationScope } from './api.js';
import { createSettingsCard, createSettingsRow } from './ui/primitives.js';
import { openActionMenu } from './ui/action-menu.js';
import { iconMarkup } from './ui/icons.js';
import { toast } from './ui/toast.js';
import {
  chooseCustomEditor,
  chooseExternalDirectory,
  editorSettings,
  hasEditorBridge,
  hasExternalFileBridge,
  listExternalGrants,
  revokeExternalAccess,
  saveEditorSettings,
} from './file-actions.js';

function basename(value) {
  return String(value || '').split(/[\\/]/).filter(Boolean).pop() || value;
}

function editorLabel(snapshot) {
  const pref = snapshot?.preference || {};
  const entry = snapshot?.editors?.find((editor) => editor.id === pref.editor);
  if (pref.editor === 'custom') return entry?.path ? basename(entry.path) : '自定义编辑器';
  return entry?.label || '系统默认程序';
}

export function createEditorAndAccessCard({ setStatus = () => {} } = {}) {
  let disposed = false;
  let snapshot = null;
  let grantsOpen = false;
  let grants = [];
  let request = 0;

  const editorButton = document.createElement('button');
  editorButton.type = 'button';
  editorButton.className = 'btn tiny ds-settings-trigger editor-settings-trigger';
  editorButton.textContent = '读取中…';
  editorButton.disabled = true;
  editorButton.setAttribute('aria-haspopup', 'menu');

  const editorRow = createSettingsRow({
    label: '外部编辑器',
    help: 'Ctrl/Cmd+点击文件链接时使用。',
    control: editorButton,
    extraClass: 'editor-settings-row',
  });

  const accessButton = document.createElement('button');
  accessButton.type = 'button';
  accessButton.className = 'btn tiny ghost ds-settings-trigger external-access-trigger';
  accessButton.textContent = '管理';
  accessButton.disabled = !hasExternalFileBridge();
  accessButton.setAttribute('aria-expanded', 'false');

  const accessRow = createSettingsRow({
    label: '工作区外访问',
    help: '查看或撤销当前会话已授权的文件与文件夹。',
    control: accessButton,
    extraClass: 'external-access-row',
  });

  const grantList = document.createElement('div');
  grantList.className = 'external-grant-list';
  grantList.hidden = true;

  const card = createSettingsCard({
    title: '编辑器与访问',
    children: [editorRow, accessRow, grantList],
  });
  card.classList.add('editor-access-card');

  function applySnapshot(next) {
    if (disposed || !next?.ok) return;
    snapshot = next;
    editorButton.disabled = false;
    editorButton.textContent = editorLabel(snapshot);
    editorButton.title = snapshot.preference?.editor === 'custom'
      ? (snapshot.preference.customPath || '')
      : (snapshot.editors?.find((editor) => editor.id === snapshot.preference?.editor)?.path || '');
    if (snapshot.warning) setStatus('编辑器设置未能持久化，本次运行仍可使用。', 'warning');
  }

  async function refreshEditors({ quiet = false } = {}) {
    const ticket = ++request;
    const result = await editorSettings();
    if (disposed || ticket !== request) return;
    if (!result?.ok) {
      editorButton.disabled = false;
      editorButton.textContent = hasEditorBridge() ? '不可用' : '仅桌面应用';
      if (!quiet && result?.error) setStatus(result.error, 'warning');
      return;
    }
    applySnapshot(result);
  }

  function menuItems() {
    const current = snapshot?.preference || { editor: 'system', customPath: '' };
    const available = (snapshot?.editors || []).filter((editor) => editor.available);
    const items = available.map((editor) => ({
      label: editor.label + (editor.id === current.editor ? ' · 当前' : ''),
      onClick: () => void selectEditor(editor.id),
    }));
    items.push({ separator: true }, {
      label: current.customPath ? '更换自定义编辑器…' : '选择自定义编辑器…',
      icon: iconMarkup('folder'),
      onClick: () => void selectCustom(),
    }, {
      label: '重新检测',
      icon: iconMarkup('refresh'),
      onClick: () => void refreshEditors(),
    });
    return items;
  }

  async function selectEditor(editor) {
    if (!snapshot || editor === snapshot.preference?.editor) return;
    editorButton.disabled = true;
    const result = await saveEditorSettings({ editor, customPath: snapshot.preference?.customPath || '' });
    if (disposed) return;
    editorButton.disabled = false;
    if (!result?.ok) {
      setStatus(result?.error || '编辑器设置未能保存。', 'error');
      return;
    }
    applySnapshot(result);
    setStatus('');
  }

  async function selectCustom() {
    editorButton.disabled = true;
    const result = await chooseCustomEditor();
    if (disposed) return;
    editorButton.disabled = false;
    if (result?.cancelled) return;
    if (!result?.ok) {
      setStatus(result?.error || '没有选择可用的编辑器。', 'error');
      return;
    }
    applySnapshot(result);
    setStatus('');
  }

  editorButton.addEventListener('click', () => {
    if (!snapshot) {
      void refreshEditors();
      return;
    }
    openActionMenu(editorButton, menuItems());
  });

  function renderGrants() {
    grantList.replaceChildren();
    const toolbar = document.createElement('div');
    toolbar.className = 'external-grant-toolbar';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn tiny ghost';
    add.textContent = '添加文件夹…';
    add.disabled = !hasExternalFileBridge();
    add.onclick = () => void addFolder();
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'btn tiny ghost';
    reload.textContent = '刷新';
    reload.onclick = () => void refreshGrants();
    toolbar.append(add, reload);
    grantList.append(toolbar);

    if (!grants.length) {
      const empty = document.createElement('p');
      empty.className = 'external-grant-empty';
      empty.textContent = '当前会话没有已授权的工作区外位置。';
      grantList.append(empty);
      return;
    }
    for (const grant of grants) {
      const item = document.createElement('div');
      item.className = 'external-grant-item';
      item.dataset.grantId = grant.id;
      const copy = document.createElement('div');
      copy.className = 'external-grant-copy';
      const path = document.createElement('span');
      path.className = 'external-grant-path';
      path.textContent = grant.target;
      path.title = grant.target;
      const meta = document.createElement('span');
      meta.className = 'external-grant-meta';
      meta.textContent = (grant.kind === 'directory' ? '文件夹' : '文件')
        + ' · ' + (grant.scope === 'persistent' ? '长期' : '本次运行');
      copy.append(path, meta);
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'btn tiny ghost';
      revoke.textContent = '撤销';
      revoke.onclick = () => void revokeGrant(grant);
      item.append(copy, revoke);
      grantList.append(item);
    }
  }

  async function refreshGrants() {
    if (!grantsOpen) return;
    const ticket = ++request;
    const scope = gitConversationScope() || null;
    const result = await listExternalGrants(scope);
    /* 授权按会话隔离：等待列表返回期间切换了会话，不能把上一个会话的
     * 授权显示在新会话下面。 */
    if (disposed || ticket !== request || !grantsOpen || (gitConversationScope() || null) !== scope) return;
    if (!result?.ok) {
      grants = [];
      renderGrants();
      const empty = grantList.querySelector('.external-grant-empty');
      if (empty) empty.textContent = result?.error || '无法读取授权列表。';
      return;
    }
    grants = Array.isArray(result.grants) ? result.grants : [];
    renderGrants();
  }

  async function revokeGrant(grant) {
    const result = await revokeExternalAccess({
      grantId: grant.id,
      conversationId: gitConversationScope() || null,
    });
    if (disposed) return;
    if (!result?.ok) {
      setStatus(result?.error || '撤销失败，请重试。', 'error');
      return;
    }
    grants = grants.filter((item) => item.id !== grant.id);
    renderGrants();
    if (result.storeError) {
      toast('已撤销本次运行；长期授权记录未能保存，重启后可能恢复。', 'error', { important: true });
    } else {
      toast('已撤销访问授权。', 'success', { important: true });
    }
  }

  async function addFolder() {
    const result = await chooseExternalDirectory(gitConversationScope() || null);
    if (disposed || result?.cancelled) return;
    if (!result?.ok) {
      setStatus(result?.error || '没有添加文件夹授权。', 'error');
      return;
    }
    setStatus('');
    await refreshGrants();
  }

  accessButton.addEventListener('click', () => {
    grantsOpen = !grantsOpen;
    grantList.hidden = !grantsOpen;
    accessButton.setAttribute('aria-expanded', String(grantsOpen));
    if (grantsOpen) void refreshGrants();
  });

  const onGrantsChanged = () => { if (grantsOpen) void refreshGrants(); };
  document.addEventListener('pi-gui:external-grants', onGrantsChanged);
  document.addEventListener('pi-gui:session-switch', onGrantsChanged);
  document.addEventListener('pi-gui:git-scope', onGrantsChanged);

  void refreshEditors({ quiet: true });

  return {
    card,
    refresh: () => { void refreshEditors(); if (grantsOpen) void refreshGrants(); },
    dispose() {
      disposed = true;
      document.removeEventListener('pi-gui:external-grants', onGrantsChanged);
      document.removeEventListener('pi-gui:session-switch', onGrantsChanged);
      document.removeEventListener('pi-gui:git-scope', onGrantsChanged);
    },
  };
}
