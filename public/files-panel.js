/* Read-only project file tree + text preview in the existing right pane.
 *
 * The tree is lazy: opening a directory asks the backend for that directory
 * only. File names and contents are rendered with textContent; the backend
 * rejects absolute paths, `..`, symlinks and oversized/binary previews. */
import { fetchFiles, fetchFileDocument } from './api.js';
import { createPaneHeader } from './right-pane.js';
import { openSecondarySurface } from './ui/secondary-surface.js';

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const formatBytes = (bytes) => {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10 * 1024 ? 1 : 0) + ' KB';
  return (value / 1024 / 1024).toFixed(1) + ' MB';
};

export function openFilesPanel(options = {}) {
  const triggerId = options.triggerId || 'btnFiles';
  return openSecondarySurface(
    'files',
    (host, view) => mountFilesPanel(host, view, options),
    { label: '项目文件', headerSelector: '.rp-head', triggerId }
  );
}

export function mountFilesPanel(host, view, options = {}) {
  host.classList.add('files-surface');
  const transport = options.transport || { list: fetchFiles, document: fetchFileDocument };
  let alive = true;
  let workspace = null;
  let rootEntries = [];
  let dirs = new Map();
  let selectedPath = null;
  let showHidden = false;
  let rootStatus = 'loading';
  let epoch = 0;
  let rootRequest = 0;
  let previewRequest = 0;
  let header;
  let refresh;
  let hiddenToggle;
  let message;
  let tree;
  let preview;

  const isCurrent = () => alive && view.isCurrent();

  function setMessage(text, tone = '') {
    if (!message) return;
    message.hidden = !text;
    message.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    message.textContent = text || '';
    if (tone) message.dataset.tone = tone;
    else delete message.dataset.tone;
  }

  function renderEmptyPreview(title, text) {
    preview.replaceChildren();
    const empty = node('section', 'files-empty');
    empty.append(
      node('span', 'files-empty-icon', '[]'),
      node('h4', 'files-empty-title', title),
      node('p', 'files-empty-text', text)
    );
    preview.append(empty);
  }

  function entryRow(entry, depth) {
    const row = node('button', 'files-entry');
    row.type = 'button';
    row.dataset.filePath = entry.path;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.title = entry.path;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    if (entry.type === 'dir') {
      const state = dirs.get(entry.path);
      row.classList.add('files-entry-dir');
      row.setAttribute('aria-expanded', String(Boolean(state?.expanded)));
      row.append(
        node('span', 'files-entry-chev', state?.expanded ? '▾' : '▸'),
        node('span', 'files-entry-name', entry.name)
      );
      row.onclick = () => toggleDirectory(entry);
    } else {
      row.classList.add('files-entry-file');
      row.setAttribute('aria-current', entry.path === selectedPath ? 'page' : 'false');
      row.append(
        node('span', 'files-entry-mark', '·'),
        node('span', 'files-entry-name', entry.name),
        node('span', 'files-entry-size', formatBytes(entry.bytes))
      );
      row.onclick = () => void openFile(entry);
    }
    return row;
  }

  function renderTree() {
    tree.replaceChildren();
    tree.setAttribute('aria-busy', String(rootStatus === 'loading'));
    if (rootStatus === 'loading') {
      tree.append(node('div', 'files-tree-status', '正在读取项目文件…'));
      return;
    }
    if (rootStatus === 'no-project' || rootStatus === 'empty') {
      tree.append(node('div', 'files-tree-status', rootStatus === 'empty' ? '这个目录没有可显示的文件。' : '还没有打开项目。'));
      return;
    }
    if (rootStatus === 'error') return;
    const visit = (entries, depth) => {
      for (const entry of entries) {
        tree.append(entryRow(entry, depth));
        if (entry.type !== 'dir') continue;
        const state = dirs.get(entry.path);
        if (!state?.expanded) continue;
        if (state.loading) tree.append(node('div', 'files-tree-status files-tree-indent', '读取中…'));
        else if (state.error) {
          const error = node('div', 'files-tree-status files-tree-indent', state.error);
          error.setAttribute('role', 'alert');
          tree.append(error);
        }
        else visit(state.entries || [], depth + 1);
      }
    };
    visit(rootEntries, 0);
  }

  async function loadRoot() {
    const request = ++rootRequest;
    const scopeEpoch = epoch;
    rootStatus = 'loading';
    setMessage('');
    renderTree();
    const result = await transport.list('', { hidden: showHidden });
    if (!isCurrent() || scopeEpoch !== epoch || request !== rootRequest) return;
    if (result?.noProject === true) {
      rootStatus = 'no-project';
      workspace = null;
      rootEntries = [];
      dirs = new Map();
      selectedPath = null;
      previewRequest++;
      renderTree();
      renderEmptyPreview('还没有打开项目', '在左侧选择一个项目后，这里会显示项目文件。');
      return;
    }
    if (!result?.ok) {
      rootStatus = 'error';
      setMessage(result?.error || '无法读取项目文件。', 'error');
      rootEntries = [];
      renderTree();
      return;
    }
    if (workspace && result.workspace?.id !== workspace.id) {
      dirs = new Map();
      selectedPath = null;
      previewRequest++;
      renderEmptyPreview('工作区已切换', '已刷新到新的项目文件。');
    }
    workspace = result.workspace || null;
    rootEntries = Array.isArray(result.entries) ? result.entries : [];
    rootStatus = rootEntries.length ? 'success' : 'empty';
    setMessage(result.truncated ? '目录内容过多，只显示了前一部分。' : '', result.truncated ? 'warn' : '');
    renderTree();
    if (!selectedPath) renderEmptyPreview('选择文件预览', '文件内容只读，不会在这里修改。');
  }

  async function toggleDirectory(entry) {
    const state = dirs.get(entry.path) || { entries: [], loaded: false, loading: false, expanded: false };
    dirs.set(entry.path, state);
    if (state.expanded) {
      state.expanded = false;
      renderTree();
      return;
    }
    state.expanded = true;
    if (state.loaded) {
      renderTree();
      return;
    }
    state.loading = true;
    const request = (state.request || 0) + 1;
    state.request = request;
    const scopeEpoch = epoch;
    renderTree();
    const result = await transport.list(entry.path, {
      workspace,
      generation: workspace?.generation,
      hidden: showHidden,
    });
    if (!isCurrent() || scopeEpoch !== epoch || dirs.get(entry.path) !== state || state.request !== request) return;
    state.loading = false;
    if (!result?.ok) {
      state.error = result?.error || '无法读取目录。';
      state.loaded = false;
      renderTree();
      return;
    }
    if (workspace && result.workspace?.id !== workspace.id) {
      state.error = '工作区已经变化，请刷新文件树。';
      renderTree();
      return;
    }
    state.error = '';
    state.entries = Array.isArray(result.entries) ? result.entries : [];
    state.loaded = true;
    if (result.truncated) setMessage('目录内容过多，只显示了前一部分。', 'warn');
    renderTree();
  }

  async function openFile(entry) {
    selectedPath = entry.path;
    renderTree();
    const request = ++previewRequest;
    const scopeEpoch = epoch;
    const requestWorkspace = workspace;
    preview.replaceChildren(node('div', 'files-tree-status', '正在读取文件…'));
    const result = await transport.document(entry.path, requestWorkspace, requestWorkspace?.generation);
    if (!isCurrent() || scopeEpoch !== epoch || request !== previewRequest) return;
    if (!result?.ok) {
      renderEmptyPreview('无法预览', result?.error || '读取文件失败。');
      return;
    }
    if (workspace && result.workspace?.id !== workspace.id) {
      renderEmptyPreview('工作区已切换', '请重新选择文件。');
      return;
    }
    const file = result.file || {};
    preview.replaceChildren();
    const head = node('div', 'files-preview-head');
    head.append(
      node('span', 'files-preview-path', file.path || entry.path),
      node('span', 'files-preview-size', formatBytes(file.bytes))
    );
    preview.append(head);
    if (file.binary) {
      preview.append(node('p', 'files-preview-note', '这是二进制文件，暂不提供预览。'));
      return;
    }
    if (!file.content) {
      preview.append(node('p', 'files-preview-note', '空文件。'));
      return;
    }
    const body = node('pre', 'files-preview-body');
    body.textContent = file.content;
    body.tabIndex = 0;
    body.setAttribute('aria-label', file.path || entry.path);
    preview.append(body);
  }

  function resetForWorkspace() {
    epoch++;
    workspace = null;
    rootEntries = [];
    dirs = new Map();
    selectedPath = null;
    previewRequest++;
    renderEmptyPreview('工作区已切换', '正在读取新的项目文件。');
    void loadRoot();
  }

  document.addEventListener('pi-gui:workspace-generation', resetForWorkspace);
  document.addEventListener('pi-gui:git-scope', resetForWorkspace);
  view.onDispose(() => {
    alive = false;
    document.removeEventListener('pi-gui:workspace-generation', resetForWorkspace);
    document.removeEventListener('pi-gui:git-scope', resetForWorkspace);
  });

  refresh = node('button', 'btn tiny rp-btn', '刷新');
  refresh.type = 'button';
  refresh.title = '重新读取项目文件';
  refresh.onclick = () => {
    dirs = new Map();
    selectedPath = null;
    previewRequest++;
    renderEmptyPreview('选择文件预览', '文件内容只读，不会在这里修改。');
    void loadRoot();
  };
  hiddenToggle = node('button', 'btn tiny rp-btn', '隐藏项');
  hiddenToggle.type = 'button';
  hiddenToggle.setAttribute('aria-pressed', 'false');
  hiddenToggle.title = '显示或隐藏以点开头的文件';
  hiddenToggle.onclick = () => {
    showHidden = !showHidden;
    hiddenToggle.setAttribute('aria-pressed', String(showHidden));
    dirs = new Map();
    selectedPath = null;
    previewRequest++;
    renderEmptyPreview('选择文件预览', '文件内容只读，不会在这里修改。');
    void loadRoot();
  };

  header = createPaneHeader({
    title: '文件',
    subtitle: '只读 · 当前项目',
    actions: [hiddenToggle, refresh],
  });
  host.append(header['el']);
  message = node('p', 'files-message');
  message.setAttribute('role', 'status');
  message.hidden = true;
  host.append(message);

  const layout = node('div', 'files-layout');
  tree = node('div', 'files-tree rp-scroll');
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', '项目文件');
  preview = node('section', 'files-preview rp-scroll');
  preview.setAttribute('aria-label', '文件预览');
  layout.append(tree, preview);
  host.append(layout);

  renderEmptyPreview('选择文件预览', '文件内容只读，不会在这里修改。');
  void loadRoot();
}
