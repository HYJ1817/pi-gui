/* Read-only Specs surface inside the existing right pane. */
import { S } from './state.js';
import { fetchSpecs, fetchSpecDocument } from './api.js';
import { createPaneHeader } from './right-pane.js';
import { openSecondarySurface, readPaneState, writePaneState } from './ui/secondary-surface.js';
import { md } from './markdown.js';
import { buildSpecTree, specDirectoryPaths, resolveSpecLink } from './specs-tree.js';

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const button = (text, run) => {
  const element = node('button', 'btn', text);
  element.type = 'button';
  element.onclick = run;
  return element;
};
const requestSplit = () => document.dispatchEvent(new window.CustomEvent(
  'pi-gui:open-split-workbench',
  { detail: { source: 'specs' } }
));
const formatBytes = (bytes) => {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10 * 1024 ? 1 : 0) + ' KB';
  return (value / 1024 / 1024).toFixed(1) + ' MB';
};

export function openSpecsPanel(options = {}) {
  const triggerId = options.triggerId || 'btnSpecs';
  const split = button('分屏', requestSplit);
  split.id = 'btnSpecsSplit';
  split.className += ' rp-btn';
  split.title = '同时显示 Specs 与文件变更';
  split.setAttribute('aria-label', '与文件变更分屏');
  return openSecondarySurface(
    'specs',
    (host, view) => mountSpecsPanel(host, view, {
      ...options,
      extraActions: [...(options.extraActions || []), split],
    }),
    { label: 'Specs 项目文档', headerSelector: '.rp-head', triggerId }
  );
}

export function mountSpecsPanel(host, view, {
  transport = { index: fetchSpecs, document: fetchSpecDocument },
  triggerId = 'btnSpecs',
  extraActions = [],
} = {}) {
  let alive = true;
  let indexSerial = 0;
  let documentSerial = 0;
  let workspace = null;
  let documents = [];
  let selectedId = null;
  let selectedPath = null;
  let loading = true;
  let loadedOnce = false;
  let expanded = new Set();
  let knownDirectories = new Set();
  let restored = readPaneState('specs');
  let switchTimer = 0;
  let header;
  let refresh;
  let errorBar;
  let treeStatus;
  let treeList;
  let docPane;
  let layout;
  let instance;
  const pathSet = () => new Set(documents.map((doc) => doc.path));
  const currentSignature = () => workspace ? workspace.id + ':' + workspace.generation : '';

  const isCurrent = () => alive && Boolean(instance?.isCurrent());

  function showBar(message, { tone = 'error', retry = false } = {}) {
    errorBar.hidden = false;
    errorBar.dataset.tone = tone;
    errorBar.replaceChildren();
    errorBar.append(node('span', 'specs-error-text', message || '无法读取项目 Specs。'));
    if (retry) errorBar.append(button('重试', () => void loadIndex()));
  }

  function showError(message) {
    showBar(message, { tone: 'error', retry: true });
  }

  function showWarning(message) {
    showBar(message, { tone: 'warn' });
  }

  function clearError() {
    errorBar.hidden = true;
    errorBar.replaceChildren();
    delete errorBar.dataset.tone;
  }

  function renderEmpty(title, text) {
    layout?.classList.add('is-empty');
    docPane.replaceChildren();
    const empty = node('section', 'specs-empty');
    empty.append(node('h4', 'specs-empty-title', title), node('p', 'specs-empty-text', text));
    docPane.append(empty);
  }

  function renderLoading() {
    layout?.classList.remove('is-empty');
    docPane.replaceChildren();
    const loadingBox = node('div', 'rp-loading');
    loadingBox.append(node('span', 'rp-loading-dot'), node('span', '', '正在读取项目 Specs…'));
    docPane.append(loadingBox);
  }

  function toggleDirectory(path, reopenFocus = false) {
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    renderTree();
    if (reopenFocus) {
      treeList.querySelector(`[data-spec-dir="${cssValue(path)}"] > button`)?.focus();
    }
  }

  function documentRow(documentEntry) {
    const item = button('', () => {
      const selected = documents.find((doc) => doc.id === documentEntry.document.id);
      if (selected) void openDocument(selected);
    });
    item.className = 'specs-doc-item';
    item.dataset.specId = documentEntry.document.id;
    item.dataset.specPath = documentEntry.path;
    item.setAttribute('aria-current', documentEntry.path === selectedPath ? 'page' : 'false');
    item.title = documentEntry.path;
    item.append(
      node('span', 'specs-doc-mark', documentEntry.name === 'SPEC.md' ? 'S' : 'M'),
      node('span', 'specs-doc-name', documentEntry.name),
      node('span', 'specs-doc-size', formatBytes(documentEntry.document.bytes))
    );
    if (documentEntry.name === 'SPEC.md') item.querySelector('.specs-doc-mark').dataset.main = 'true';
    return item;
  }

  function directoryRow(directory) {
    const box = node('div', 'specs-tree-dir');
    box.dataset.specDir = directory.path;
    const row = button('', () => toggleDirectory(directory.path, true));
    row.className = 'specs-dir-item';
    row.setAttribute('aria-expanded', String(expanded.has(directory.path)));
    row.setAttribute('aria-controls', 'specs-dir-' + cssId(directory.path));
    row.append(
      node('span', 'specs-dir-chev', expanded.has(directory.path) ? '▾' : '▸'),
      node('span', 'specs-dir-name', directory.name),
      node('span', 'specs-dir-count', String(countDocuments(directory)))
    );
    const children = node('div', 'specs-dir-children');
    children.id = 'specs-dir-' + cssId(directory.path);
    children.hidden = !expanded.has(directory.path);
    for (const child of directory.children) {
      children.append(child.type === 'dir' ? directoryRow(child) : documentRow(child));
    }
    box.append(row, children);
    return box;
  }

  function renderTree() {
    treeList.replaceChildren();
    const docs = documents.length;
    treeStatus.textContent = loading ? '读取中…' : docs ? `${docs} 个文档` : '没有文档';
    if (!docs) return;
    for (const entry of buildSpecTree(documents)) {
      treeList.append(entry.type === 'dir' ? directoryRow(entry) : documentRow(entry));
    }
  }

  function rememberPaneState() {
    if (!workspace) return;
    writePaneState('specs', {
      workspaceId: workspace.id,
      workspaceGeneration: workspace.generation,
      selectedPath,
      expanded: [...expanded],
      treeScroll: treeList?.scrollTop || 0,
      docScroll: docPane?.querySelector('.specs-markdown')?.scrollTop || 0,
    });
  }

  function renderDocumentHeader(documentEntry) {
    const head = node('div', 'specs-doc-head');
    head.append(
      node('span', 'specs-doc-path', documentEntry.path),
      node('span', 'specs-doc-size', formatBytes(documentEntry.bytes))
    );
    return head;
  }

  function showDocumentNotice(message, tone = 'info') {
    const notice = node('p', 'specs-doc-notice', message);
    notice.dataset.tone = tone;
    docPane.querySelector('.specs-doc-head')?.after(notice);
  }

  function renderDocument(documentEntry) {
    layout?.classList.remove('is-empty');
    docPane.replaceChildren();
    docPane.append(renderDocumentHeader(documentEntry));
    const body = node('article', 'msg-body specs-markdown');
    body.tabIndex = -1;
    body.setAttribute('aria-label', documentEntry.path);
    try {
      body.innerHTML = md(documentEntry.content || '', { headingIds: true });
    } catch {
      showDocumentNotice('这段 Markdown 无法安全渲染，原文未被写入页面。', 'error');
      return;
    }
    docPane.append(body);
  }

  function jumpToAnchor(anchor) {
    if (!anchor) return;
    const target = [...docPane.querySelectorAll('[id]')].find((element) => element.id === anchor);
    if (!target) {
      showDocumentNotice('当前文档中找不到该标题。', 'warn');
      return;
    }
    target.tabIndex = -1;
    target.focus?.({ preventScroll: true });
    target.scrollIntoView?.({ block: 'start' });
  }

  async function openDocument(documentEntry, { anchor = '' } = {}) {
    if (!isCurrent() || !workspace || !documentEntry) return;
    const request = ++documentSerial;
    const signature = currentSignature();
    selectedId = documentEntry.id;
    selectedPath = documentEntry.path;
    renderTree();
    docPane.replaceChildren();
    const loadingBox = node('div', 'rp-loading');
    loadingBox.append(node('span', 'rp-loading-dot'), node('span', '', '正在读取文档…'));
    docPane.append(loadingBox);
    let result;
    try {
      result = await transport.document(documentEntry.id, workspace, workspace.generation);
    } catch {
      result = { ok: false, error: '无法读取文档。' };
    }
    if (!isCurrent() || request !== documentSerial || signature !== currentSignature()) return;
    if (!result?.ok) {
      docPane.replaceChildren();
      docPane.append(renderDocumentHeader(documentEntry));
      showDocumentNotice(result?.error || '无法读取文档，请刷新后重试。', 'error');
      return;
    }
    const fresh = result.document || documentEntry;
    renderDocument(fresh);
    if (!anchor && restored?.docScroll && selectedPath === restored.selectedPath) {
      const body = docPane.querySelector('.specs-markdown');
      if (body) body.scrollTop = restored.docScroll;
    }
    restored = null;
    if (anchor) requestAnimationFrame(() => {
      if (isCurrent() && request === documentSerial && signature === currentSignature()) jumpToAnchor(anchor);
    });
  }

  async function loadIndex() {
    if (!isCurrent()) return;
    const request = ++indexSerial;
    documentSerial++;
    loading = true;
    if (refresh) refresh.disabled = true;
    if (!documents.length) renderLoading();
    renderTree();
    let result;
    try {
      result = await transport.index();
    } catch {
      result = { ok: false, error: '无法读取项目 Specs。' };
    }
    if (!isCurrent() || request !== indexSerial) return;
    loading = false;
    if (refresh) refresh.disabled = false;
    if (!result?.ok) {
      showError(result?.error);
      if (!documents.length) {
        renderEmpty('无法读取 Specs', result?.error || '请检查项目目录后重试。');
      }
      renderTree();
      return;
    }
    clearError();
    if (result.noProject || !result.workspace) {
      workspace = null;
      documents = [];
      selectedId = null;
      selectedPath = null;
      knownDirectories = new Set();
      expanded = new Set();
      renderTree();
      renderEmpty('还没有选择项目', '选择一个项目后，这里会显示它的 SPEC.md 与 specs/ 文档。');
      return;
    }

    const previousPath = selectedPath;
    /* 重开面板时按 workspace 身份恢复视图状态；对不上就丢弃，绝不复活旧数据。 */
    const snapshot = restored && restored.workspaceId === result.workspace.id
      && restored.workspaceGeneration === result.workspace.generation ? restored : null;
    if (restored && !snapshot) restored = null;
    workspace = result.workspace;
    documents = Array.isArray(result.documents) ? result.documents : [];
    const directories = new Set(specDirectoryPaths(documents));
    if (snapshot?.expanded) {
      expanded = new Set(snapshot.expanded.filter((directory) => directories.has(directory)));
    } else if (!loadedOnce) expanded = new Set(directories);
    else for (const directory of directories) if (!knownDirectories.has(directory)) expanded.add(directory);
    for (const directory of [...expanded]) if (!directories.has(directory)) expanded.delete(directory);
    knownDirectories = directories;
    loadedOnce = true;

    const scanWarnings = [];
    if (result.truncated) scanWarnings.push('文档数量超过安全上限，列表已截断。');
    if (result.incomplete) scanWarnings.push('部分 Specs 目录未能读取，列表可能不完整。');
    if (scanWarnings.length) showWarning(scanWarnings.join(' '));
    renderTree();
    if (!documents.length) {
      selectedId = null;
      selectedPath = null;
      renderEmpty('这个项目还没有 Specs', '新建根目录的 SPEC.md，或在 specs/ 下添加 Markdown 文档，然后点刷新。');
      return;
    }
    const selected = documents.find((doc) => doc.path === (snapshot?.selectedPath || previousPath))
      || documents.find((doc) => doc.main)
      || documents[0];
    await openDocument(selected);
    if (snapshot?.treeScroll && treeList) treeList.scrollTop = snapshot.treeScroll;
  }

  function handleDocumentClick(event) {
    const anchor = event.target.closest?.('a');
    if (!anchor || !anchor.closest('.specs-markdown') || !selectedPath) return;
    const resolution = resolveSpecLink(selectedPath, anchor.getAttribute('href'), pathSet());
    if (resolution.kind === 'external') return;
    event.preventDefault();
    if (resolution.kind === 'anchor') return jumpToAnchor(resolution.anchor);
    if (resolution.kind === 'document') {
      const target = documents.find((doc) => doc.path === resolution.path);
      if (target) return void openDocument(target, { anchor: resolution.anchor });
    }
    showDocumentNotice('仅支持打开当前项目 Specs 索引内的 Markdown 文档。', 'warn');
  }

  function workspaceChanging() {
    if (!isCurrent()) return;
    const generation = S.workspaceGeneration;
    indexSerial++;
    documentSerial++;
    workspace = null;
    documents = [];
    selectedId = null;
    selectedPath = null;
    expanded = new Set();
    knownDirectories = new Set();
    loading = false;
    clearError();
    treeStatus.textContent = '工作区切换中…';
    treeList.replaceChildren();
    renderEmpty('正在切换工作区', 'Specs 会跟随对应的项目或 Worktree 重新载入。');
    clearTimeout(switchTimer);
    const wait = () => {
      if (!isCurrent() || generation !== S.workspaceGeneration) return;
      if (S.switching) {
        switchTimer = setTimeout(wait, 50);
        return;
      }
      void loadIndex();
    };
    switchTimer = setTimeout(wait, 0);
  }

  function scopeChanged() {
    if (!isCurrent()) return;
    indexSerial++;
    documentSerial++;
    workspace = null;
    documents = [];
    selectedId = null;
    selectedPath = null;
    expanded = new Set();
    knownDirectories = new Set();
    loading = true;
    clearError();
    treeStatus.textContent = '切换会话中…';
    treeList.replaceChildren();
    renderEmpty('正在切换会话工作区', 'Specs 会从当前 focused 会话对应的项目或 Worktree 重新载入。');
    void loadIndex();
  }

  instance = view;
  {
    host.classList.add('specs-surface');
    refresh = button('刷新', () => void loadIndex());
    refresh.className += ' rp-btn';
    refresh.id = 'btnSpecsRefresh';
    header = createPaneHeader({
      title: 'Specs',
      subtitle: '项目文档 · 只读',
      actions: [refresh, ...extraActions],
      id: 'specsPaneHeader',
    });
    host.append(header.el);

    errorBar = node('div', 'specs-error');
    errorBar.setAttribute('role', 'alert');
    errorBar.hidden = true;
    host.append(errorBar);

    layout = node('div', 'specs-layout');
    const treePane = node('section', 'specs-tree-pane');
    treePane.setAttribute('aria-label', 'Specs 文档树');
    const treeHead = node('div', 'specs-tree-head');
    treeHead.append(node('span', '', '文档'), treeStatus = node('span', 'specs-tree-status', '读取中…'));
    treeList = node('div', 'specs-tree-list');
    treePane.append(treeHead, treeList);
    docPane = node('section', 'specs-doc-pane');
    docPane.setAttribute('aria-live', 'polite');
    layout.append(treePane, docPane);
    host.append(layout);
    docPane.addEventListener('click', handleDocumentClick);

    const onWorkspace = () => workspaceChanging();
    const onScope = () => scopeChanged();
    document.addEventListener('pi-gui:workspace-generation', onWorkspace);
    document.addEventListener('pi-gui:git-scope', onScope);

    view.onDispose(() => {
      rememberPaneState();
      alive = false;
      indexSerial++;
      documentSerial++;
      clearTimeout(switchTimer);
      document.removeEventListener('pi-gui:workspace-generation', onWorkspace);
      document.removeEventListener('pi-gui:git-scope', onScope);
      docPane.replaceChildren();
    });
    queueMicrotask(() => { if (isCurrent()) void loadIndex(); });
  }
}

function countDocuments(directory) {
  let count = 0;
  for (const child of directory.children) count += child.type === 'dir' ? countDocuments(child) : 1;
  return count;
}

function cssId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => '_' + char.charCodeAt(0).toString(16) + '_');
}

function cssValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
