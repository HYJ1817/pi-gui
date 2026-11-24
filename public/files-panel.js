import { createIcon } from './ui/icons.js';
/* Read-only project file tree + file viewer in the existing right pane.
 *
 * The tree is lazy: opening a directory asks the backend for that directory
 * only. File names and contents are rendered with textContent; the backend
 * rejects absolute paths, `..`, symlinks and oversized/binary previews.
 *
 * The viewer is still one surface, but it now owns tabs, tree selection and
 * line targeting so a file reference in a message can open the real file in
 * the workspace that message belongs to. */
import { fetchFiles, fetchFileDocument, fetchFileMetadata, fetchFileAsset, gitConversationScope } from './api.js';
import { createPaneHeader } from './right-pane.js';
import { openSecondarySurface } from './ui/secondary-surface.js';
import { createFileIcon, fileKind } from './ui/file-icons.js';
import { highlightSource } from './ui/source-highlight.js';
import { openInSystemProgram } from './file-actions.js';
import { isPathWithin, positionLabel, rangeLabel } from './file-link-model.js';
import { S } from './state.js';
import { looksWindows } from './util.js';
import { toast } from './ui/toast.js';

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
const BINARY_KINDS = new Set(['pdf', 'word', 'sheet', 'slides', 'archive', 'font', 'audio', 'video']);
const relEqual = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  return looksWindows(S.cwd || '') ? a.toLowerCase() === b.toLowerCase() : false;
};
const tabKeyOf = (filePath) => (looksWindows(S.cwd || '') ? String(filePath).toLowerCase() : String(filePath));

/* 文件链接点开时，当前挂着的 Files 面板会在下一次点击中复用；
 * 没有面板则由这里新开一个。注册表只保存“当前还活着”的实例。 */
let activePanel = null;

/** 从会话内的文件链接打开一个文件。`request` 已由 file-links-ui 解析成
 *  workspace 相对路径，并带上所属会话的 id 与 cwd。 */
export function openFileReference(request) {
  if (!request?.path) return null;
  if (activePanel?.isCurrent()) {
    activePanel.open(request);
    return activePanel;
  }
  const surface = openFilesPanel({ openRequest: request });
  return surface;
}

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
  const transport = options.transport || {
    list: fetchFiles,
    document: fetchFileDocument,
    metadata: fetchFileMetadata,
    asset: fetchFileAsset,
  };
  let alive = true;
  let workspace = null;
  let rootEntries = [];
  let dirs = new Map();
  let selectedPath = null;
  let showHidden = false;
  let rootStatus = 'loading';
  let epoch = 0;
  let rootRequest = 0;
  let rootPromise = null;
  let header;
  let refresh;
  let hiddenToggle;
  let message;
  let tree;
  let preview;
  let tabsBar = null;
  let tabList = null;
  let tabs = new Map();
  let tabOrder = [];
  let activeKey = null;
  let tabSeq = 0;
  let initialRequest = options.openRequest || null;

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
      createIcon('fileText', { className: 'files-empty-icon' }),
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
        createIcon(state?.expanded ? 'chevronDown' : 'chevronRight', { className: 'files-entry-chev' }),
        node('span', 'files-entry-name', entry.name)
      );
      row.onclick = () => void toggleDirectory(entry);
    } else {
      row.classList.add('files-entry-file');
      row.setAttribute('aria-current', relEqual(entry.path, selectedPath) ? 'page' : 'false');
      row.append(
        createFileIcon(document, entry.path, 'files-entry-mark file-kind-icon'),
        node('span', 'files-entry-name', entry.name),
        node('span', 'files-entry-size', formatBytes(entry.bytes))
      );
      row.onclick = () => void openTreeFile(entry);
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

  function scrollTreeTo(filePath) {
    if (!filePath || !tree) return;
    const row = [...tree.querySelectorAll('.files-entry[data-file-path]')]
      .find((entry) => relEqual(entry.dataset.filePath, filePath));
    if (row && typeof row.scrollIntoView === 'function') {
      try { row.scrollIntoView({ block: 'nearest' }); } catch { /* layout is optional */ }
    }
  }

  function loadRoot() {
    const run = async () => {
      const request = ++rootRequest;
      const scopeEpoch = epoch;
      rootStatus = 'loading';
      setMessage('');
      renderTree();
      const result = await transport.list('', { hidden: showHidden });
      if (!isCurrent() || scopeEpoch !== epoch || request !== rootRequest) return rootStatus;
      if (result?.noProject === true) {
        rootStatus = 'no-project';
        workspace = null;
        rootEntries = [];
        dirs = new Map();
        selectedPath = null;
        closeAllTabs();
        renderTree();
        renderEmptyPreview('还没有打开项目', '在左侧选择一个项目后，这里会显示项目文件。');
        return rootStatus;
      }
      if (!result?.ok) {
        rootStatus = 'error';
        setMessage(result?.error || '无法读取项目文件。', 'error');
        rootEntries = [];
        selectedPath = null;
        closeAllTabs();
        renderEmptyPreview('暂时无法预览', '请刷新文件列表后重新选择文件。');
        renderTree();
        return rootStatus;
      }
      if (workspace && result.workspace?.id !== workspace.id) {
        dirs = new Map();
        selectedPath = null;
        closeAllTabs();
        renderEmptyPreview('工作区已切换', '已刷新到新的项目文件。');
      }
      workspace = result.workspace || null;
      rootEntries = Array.isArray(result.entries) ? result.entries : [];
      rootStatus = rootEntries.length ? 'success' : 'empty';
      setMessage(result.truncated ? '目录内容过多，只显示了前一部分。' : '', result.truncated ? 'warn' : '');
      renderTree();
      if (!selectedPath) renderEmptyPreview('选择文件预览', '文件内容只读，不会在这里修改。');
      return rootStatus;
    };
    rootPromise = run();
    return rootPromise;
  }

  async function loadDirectory(entry, state) {
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
    if (!isCurrent() || scopeEpoch !== epoch || dirs.get(entry.path) !== state || state.request !== request) return false;
    state.loading = false;
    if (!result?.ok) {
      state.error = result?.error || '无法读取目录。';
      state.loaded = false;
      renderTree();
      return false;
    }
    if (workspace && result.workspace?.id !== workspace.id) {
      state.error = '工作区已经变化，请刷新文件树。';
      renderTree();
      return false;
    }
    state.error = '';
    state.entries = Array.isArray(result.entries) ? result.entries : [];
    state.loaded = true;
    state.expanded = true;
    if (result.truncated) setMessage('目录内容过多，只显示了前一部分。', 'warn');
    renderTree();
    return true;
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
    if (!state.loading) await loadDirectory(entry, state);
  }

  /* 展开到目标文件的父目录。只做有界懒加载；遇到被截断/不存在的目录就停，
   * 文件本身仍然可以在预览区打开。 */
  async function ensurePathVisible(filePath) {
    if (!filePath || !workspace) return;
    const segments = String(filePath).split('/');
    const needsHidden = segments.some((segment) => segment.startsWith('.'));
    if (needsHidden && !showHidden) {
      showHidden = true;
      if (hiddenToggle) hiddenToggle.setAttribute('aria-pressed', 'true');
      dirs = new Map();
      await loadRoot();
      if (!workspace) return;
    }
    let entries = rootEntries;
    for (let i = 0; i < segments.length - 1; i++) {
      const prefix = segments.slice(0, i + 1).join('/');
      let dir = entries.find((entry) => entry.type === 'dir' && relEqual(entry.path, prefix));
      if (!dir) {
        // 目录可能因为隐藏项/截断没出现；重读一次根目录再找。
        await loadRoot();
        entries = rootEntries;
        dir = entries.find((entry) => entry.type === 'dir' && relEqual(entry.path, prefix));
        if (!dir) return;
      }
      const state = dirs.get(dir.path) || { entries: [], loaded: false, loading: false, expanded: false };
      dirs.set(dir.path, state);
      state.expanded = true;
      if (!state.loaded) {
        const loaded = await loadDirectory(dir, state);
        if (!loaded) return;
      } else {
        renderTree();
      }
      entries = state.entries || [];
    }
    selectedPath = activeTab()?.path || selectedPath;
    renderTree();
    scrollTreeTo(selectedPath);
  }

  function activeTab() {
    return activeKey ? tabs.get(activeKey) || null : null;
  }

  function revokeImage(tab) {
    if (!tab?.imageUrl) return;
    try { URL.revokeObjectURL(tab.imageUrl); } catch { /* not all environments */ }
    tab.imageUrl = null;
  }

  function closeAllTabs() {
    for (const tab of tabs.values()) revokeImage(tab);
    tabs = new Map();
    tabOrder = [];
    activeKey = null;
    if (tabsBar) {
      tabsBar.hidden = true;
      tabList?.replaceChildren();
    }
  }

  function closeTab(key) {
    const tab = tabs.get(key);
    if (!tab) return;
    revokeImage(tab);
    const index = tabOrder.indexOf(key);
    tabs.delete(key);
    tabOrder = tabOrder.filter((item) => item !== key);
    if (activeKey === key) {
      const next = tabOrder[index] || tabOrder[index - 1] || null;
      activeKey = next;
      if (next) {
        selectedPath = tabs.get(next).path;
        renderTabs();
        showActiveTab();
      } else {
        selectedPath = null;
        renderTabs();
        renderEmptyPreview('选择文件预览', '文件内容只读，不会在这里修改。');
        renderTree();
      }
      return;
    }
    renderTabs();
  }

  function renderTabs() {
    if (!tabsBar || !tabList) return;
    tabsBar.hidden = tabOrder.length === 0;
    tabList.replaceChildren();
    for (const key of tabOrder) {
      const tab = tabs.get(key);
      if (!tab) continue;
      const item = node('div', 'files-tab');
      item.dataset.fileTab = tab.path;
      const select = node('button', 'files-tab-select');
      select.type = 'button';
      select.id = tab.id;
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', String(key === activeKey));
      select.setAttribute('aria-controls', 'filesPreviewPanel');
      select.setAttribute('title', tab.path + (tab.line ? positionLabel(tab) : ''));
      select.tabIndex = key === activeKey ? 0 : -1;
      select.append(
        createFileIcon(document, tab.path, 'file-kind-icon'),
        node('span', 'files-tab-label', tab.name)
      );
      if (tab.line) select.append(node('span', 'files-tab-position', positionLabel(tab)));
      select.onclick = () => activateTab(key);
      select.onkeydown = (event) => {
        const index = tabOrder.indexOf(key);
        let next = null;
        if (event.key === 'ArrowRight') next = tabOrder[(index + 1) % tabOrder.length];
        else if (event.key === 'ArrowLeft') next = tabOrder[(index - 1 + tabOrder.length) % tabOrder.length];
        else if (event.key === 'Home') next = tabOrder[0];
        else if (event.key === 'End') next = tabOrder[tabOrder.length - 1];
        if (!next) return;
        event.preventDefault();
        activateTab(next);
        const buttons = tabList.querySelectorAll('.files-tab-select');
        buttons[tabOrder.indexOf(next)]?.focus();
      };
      const close = node('button', 'files-tab-close');
      close.type = 'button';
      close.setAttribute('aria-label', `关闭 ${tab.name}`);
      close.append(createIcon('close'));
      close.onclick = (event) => { event.stopPropagation(); closeTab(key); };
      item.append(select, close);
      tabList.append(item);
    }
    preview.setAttribute('role', tabOrder.length ? 'tabpanel' : 'group');
    const active = activeTab();
    if (active) preview.setAttribute('aria-labelledby', active.id);
    else preview.removeAttribute('aria-labelledby');
  }

  function saveScroll() {
    const tab = activeTab();
    if (!tab) return;
    const scroll = preview.querySelector('.files-preview-scroll');
    if (scroll) tab.scroll = { top: scroll.scrollTop, left: scroll.scrollLeft };
  }

  function activateTab(key) {
    if (!tabs.has(key)) return;
    saveScroll();
    activeKey = key;
    const tab = tabs.get(key);
    selectedPath = tab.path;
    renderTabs();
    renderTree();
    void ensurePathVisible(tab.path);
    showActiveTab();
  }

  function showActiveTab() {
    const tab = activeTab();
    if (!tab) return;
    renderTabContent(tab);
  }

  function applyLineTarget(tab, { scroll = true } = {}) {
    const body = preview.querySelector('.files-preview-body');
    const highlight = preview.querySelector('.files-line-highlight');
    if (!body || !highlight || !tab?.doc) return;
    const content = typeof tab.doc.content === 'string' ? tab.doc.content : '';
    const lineCount = Math.max(1, content.split('\n').length);
    tab.lineCount = lineCount;
    if (!tab.line) {
      highlight.hidden = true;
      return;
    }
    const from = Math.min(Math.max(1, tab.line), lineCount);
    const to = Math.min(Math.max(from, tab.endLine || from), lineCount);
    const style = getComputedStyle(body);
    const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 12) * 1.55;
    const paddingTop = parseFloat(style.paddingTop) || 10;
    highlight.style.top = `${paddingTop + (from - 1) * lineHeight}px`;
    highlight.style.height = `${(to - from + 1) * lineHeight}px`;
    highlight.hidden = false;
    highlight.dataset.lineFrom = String(from);
    highlight.dataset.lineTo = String(to);
    if (scroll) {
      const scroller = preview.querySelector('.files-preview-scroll');
      if (scroller) scroller.scrollTop = Math.max(0, paddingTop + (from - 1) * lineHeight - scroller.clientHeight / 3);
    }
  }

  function previewHead(tab) {
    const head = node('div', 'files-preview-head');
    head.append(
      node('span', 'files-preview-path', tab.doc?.path || tab.path),
      node('span', 'files-preview-size', formatBytes(tab.doc?.bytes ?? tab.bytes))
    );
    return head;
  }

  function unsupportedNote(text, tab) {
    const note = node('p', 'files-preview-note', text);
    const actions = node('div', 'files-preview-actions');
    const open = node('button', 'btn tiny', '用系统默认程序打开');
    open.type = 'button';
    open.onclick = () => void openInSystemProgram({ path: tab.path, conversationId: tab.conversationId });
    actions.append(open);
    return [note, actions];
  }

  function renderCode(tab) {
    const wrap = node('div', 'files-preview-code');
    const scroll = node('div', 'files-preview-scroll');

    const highlight = node('div', 'files-line-highlight');
    highlight.hidden = true;
    highlight.setAttribute('aria-hidden', 'true');
    scroll.append(highlight);

    const body = node('pre', 'files-preview-body');
    body.innerHTML = highlightSource(tab.doc.content, tab.doc.path || tab.path).html;
    body.tabIndex = 0;
    body.setAttribute('aria-label', tab.doc.path || tab.path);
    scroll.append(body);

    const gutter = node('pre', 'files-preview-gutter');
    gutter.setAttribute('aria-hidden', 'true');
    gutter.textContent = Array.from({ length: Math.max(1, tab.doc.content.split('\n').length) }, (_v, i) => i + 1).join('\n');
    scroll.onscroll = () => { gutter.scrollTop = scroll.scrollTop; };

    // DOM 顺序保持正文在栏号之前：既有选择器与读屏都先拿到内容。
    wrap.append(scroll, gutter);
    preview.append(wrap);
    const saved = tab.scroll;
    if (saved) { scroll.scrollTop = saved.top; scroll.scrollLeft = saved.left; }
    if (tab.line) applyLineTarget(tab);
  }

  function renderTabContent(tab) {
    preview.replaceChildren();
    const head = previewHead(tab);
    preview.append(head);
    if (tab.state === 'loading' && !tab.doc) {
      preview.append(node('div', 'files-tree-status', '正在读取文件…'));
      return;
    }
    if (tab.state === 'error') {
      const [note] = unsupportedNote(tab.error || '无法读取文件。', tab);
      preview.append(note);
      return;
    }
    if (tab.state === 'unsupported') {
      for (const part of unsupportedNote(tab.error || '这个格式暂不内联预览。', tab)) preview.append(part);
      return;
    }
    if (tab.kind === 'image') {
      const box = node('div', 'files-preview-image');
      if (tab.imageUrl) {
        const img = document.createElement('img');
        img.src = tab.imageUrl;
        img.alt = tab.name;
        box.append(img);
      } else {
        box.append(node('span', 'files-preview-note', tab.error || '正在读取图片…'));
      }
      preview.append(box);
      return;
    }
    if (!tab.doc) {
      preview.append(node('div', 'files-tree-status', '正在读取文件…'));
      return;
    }
    if (tab.doc.binary) {
      for (const part of unsupportedNote('这是二进制文件，暂不提供预览。', tab)) preview.append(part);
      return;
    }
    if (!tab.doc.content) {
      preview.append(node('p', 'files-preview-note', '空文件。'));
      return;
    }
    renderCode(tab);
  }

  async function loadDocument(tab, { force = false } = {}) {
    if (!workspace) return;
    if (tab.doc && !force) return;
    const request = ++tab.request;
    const scopeEpoch = epoch;
    if (!tab.doc) {
      tab.state = 'loading';
      if (activeKey === tab.key) renderTabContent(tab);
    }
    const result = await transport.document(tab.path, workspace, workspace.generation);
    if (!alive || scopeEpoch !== epoch || request !== tab.request || tabs.get(tab.key) !== tab) return;
    if (!result?.ok) {
      tab.state = 'error';
      tab.error = result?.code === 'oversized'
        ? '文件超过预览大小上限。'
        : result?.code === 'file_missing'
          ? '文件不存在或已被移动。'
          : result?.error || '读取文件失败。';
      tab.doc = null;
      if (activeKey === tab.key) renderTabContent(tab);
      return;
    }
    if (workspace && result.workspace?.id !== workspace.id) {
      tab.state = 'error';
      tab.error = '工作区已经切换，请重新打开文件。';
      tab.doc = null;
      if (activeKey === tab.key) renderTabContent(tab);
      return;
    }
    tab.doc = result.file || {};
    tab.state = 'ready';
    if (Number.isFinite(tab.doc.bytes)) tab.bytes = tab.doc.bytes;
    if (activeKey === tab.key) renderTabContent(tab);
  }

  async function loadImage(tab) {
    if (!transport.asset) {
      tab.state = 'unsupported';
      tab.error = '暂不支持内联预览。';
      if (activeKey === tab.key) renderTabContent(tab);
      return;
    }
    const request = ++tab.request;
    const scopeEpoch = epoch;
    if (!tab.imageUrl) {
      tab.state = 'loading';
      if (activeKey === tab.key) renderTabContent(tab);
    }
    const result = await transport.asset(tab.path, tab.conversationId);
    if (!alive || scopeEpoch !== epoch || request !== tab.request || tabs.get(tab.key) !== tab) return;
    if (!result?.ok) {
      tab.state = 'unsupported';
      tab.error = result?.code === 'oversized' ? '图片超过预览大小上限。' : '无法内联预览这个文件。';
      if (activeKey === tab.key) renderTabContent(tab);
      return;
    }
    if (typeof URL?.createObjectURL !== 'function') {
      tab.state = 'unsupported';
      tab.error = '当前环境不支持图片预览。';
      if (activeKey === tab.key) renderTabContent(tab);
      return;
    }
    revokeImage(tab);
    tab.imageUrl = URL.createObjectURL(result.blob);
    tab.state = 'ready';
    if (activeKey === tab.key) renderTabContent(tab);
  }

  function showUnsupported(tab, text) {
    tab.state = 'unsupported';
    tab.error = text;
    tab.doc = null;
    if (activeKey === tab.key) renderTabContent(tab);
  }

  function openTab(request) {
    if (!workspace) {
      toast('当前项目不可用，无法打开文件。', 'warn');
      return;
    }
    const key = tabKeyOf(request.path);
    let tab = tabs.get(key);
    if (!tab) {
      tabSeq++;
      tab = {
        key,
        id: `filesTab-${tabSeq}`,
        path: request.path,
        name: request.name || request.path.split('/').pop(),
        kind: fileKind(request.path),
        doc: null,
        state: 'loading',
        error: '',
        request: 0,
        line: null,
        column: null,
        endLine: null,
        endColumn: null,
        bytes: Number.isFinite(request.bytes) ? request.bytes : null,
        conversationId: request.conversationId || null,
        imageUrl: null,
        scroll: { top: 0, left: 0 },
      };
      tabs.set(key, tab);
      tabOrder.push(key);
    }
    tab.path = request.path;
    tab.name = request.name || tab.name;
    tab.kind = fileKind(tab.path);
    tab.line = request.line || null;
    tab.column = request.column || null;
    tab.endLine = request.endLine || null;
    tab.endColumn = request.endColumn || null;
    tab.conversationId = request.conversationId || tab.conversationId || null;
    if (Number.isFinite(request.bytes)) tab.bytes = request.bytes;

    saveScroll();
    activeKey = key;
    selectedPath = tab.path;
    // 先移除旧错误，重新读取时不要显示上一次的失败。
    tab.error = '';
    renderTabs();
    renderTree();
    if (tab.doc && tab.kind !== 'image') renderTabContent(tab);
    else if (tab.kind === 'image' && tab.imageUrl) renderTabContent(tab);
    else showActiveTab();

    const load = tab.kind === 'image'
      ? loadImage(tab)
      : BINARY_KINDS.has(tab.kind)
        ? Promise.resolve(showUnsupported(tab, '这个格式暂不内联预览。'))
        : loadDocument(tab, { force: true });
    void ensurePathVisible(tab.path);
    void load.then(() => {
      if (!isCurrent() || activeKey !== key) return;
      renderTree();
      scrollTreeTo(tab.path);
    });
  }

  async function openTreeFile(entry) {
    openTab({
      path: entry.path,
      name: entry.name,
      bytes: entry.bytes,
      cwd: '',
      conversationId: gitConversationScope() || null,
    });
  }

  /* 会话内链接 → Files 面板。这里再做一次身份校验：即使 DOM 里有旧链接，
   * 也不能用当前焦点的工作区去解析它。 */
  async function openFromReference(request) {
    if (!request?.path) return;
    const scopeEpoch = epoch;
    const wanted = request.conversationId || null;
    const current = gitConversationScope() || null;
    if (wanted !== current) {
      toast('这个文件引用属于其它会话，请先切换到那个会话。', 'warn');
      return;
    }
    if (rootPromise) await rootPromise;
    if (!alive || scopeEpoch !== epoch) return;
    if (!workspace) {
      toast('当前项目不可用，无法打开文件。', 'warn');
      return;
    }
    if (typeof transport.metadata === 'function' && request.cwd) {
      const meta = await transport.metadata(request.path, wanted);
      // 读取期间可能又换了工作区/会话；旧请求不能落在新面板上。
      if (!alive || scopeEpoch !== epoch) return;
      if (wanted !== (gitConversationScope() || null)) {
        toast('这个文件引用属于其它会话，请先切换到那个会话。', 'warn');
        return;
      }
      if (!meta?.ok) {
        toast(meta?.code === 'file_missing' ? '文件不存在或已被移动。' : '无法读取文件信息。', 'warn');
        return;
      }
      if (!isPathWithin(request.cwd, meta.file?.absolutePath || '')) {
        toast('这个文件所在的工作区已经变化，请重新打开会话。', 'warn');
        return;
      }
      request.bytes = meta.file?.bytes;
      request.name = meta.file?.name || request.name;
    }
    openTab({ ...request, conversationId: wanted });
  }

  function resetForWorkspace() {
    epoch++;
    workspace = null;
    rootEntries = [];
    dirs = new Map();
    selectedPath = null;
    closeAllTabs();
    renderEmptyPreview('工作区已切换', '正在读取新的项目文件。');
    void loadRoot();
  }

  document.addEventListener('pi-gui:workspace-generation', resetForWorkspace);
  document.addEventListener('pi-gui:git-scope', resetForWorkspace);

  refresh = node('button', 'btn tiny ghost rp-btn', '刷新');
  refresh.type = 'button';
  refresh.title = '重新读取项目文件';
  refresh.onclick = () => {
    dirs = new Map();
    selectedPath = null;
    closeAllTabs();
    renderEmptyPreview('选择文件预览', '文件内容只读，不会在这里修改。');
    void loadRoot();
  };
  hiddenToggle = node('button', 'btn tiny ghost rp-btn', '隐藏项');
  hiddenToggle.type = 'button';
  hiddenToggle.setAttribute('aria-pressed', 'false');
  hiddenToggle.title = '显示或隐藏以点开头的文件';
  hiddenToggle.onclick = () => {
    showHidden = !showHidden;
    hiddenToggle.setAttribute('aria-pressed', String(showHidden));
    dirs = new Map();
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

  tabsBar = node('div', 'files-tabs');
  tabsBar.hidden = true;
  tabList = node('div', 'files-tablist');
  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', '打开的文件');
  tabsBar.append(tabList);
  host.append(tabsBar);

  const layout = node('div', 'files-layout');
  tree = node('div', 'files-tree rp-scroll');
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', '项目文件');
  preview = node('section', 'files-preview rp-scroll');
  preview.id = 'filesPreviewPanel';
  preview.setAttribute('aria-label', '文件预览');
  layout.append(tree, preview);
  host.append(layout);

  renderEmptyPreview('选择文件预览', '文件内容只读，不会在这里修改。');
  activePanel = {
    isCurrent,
    open: openFromReference,
  };
  loadRoot().then(() => {
    if (!alive) return;
    const request = initialRequest;
    initialRequest = null;
    if (request) void openFromReference(request);
  });

  view.onDispose(() => {
    alive = false;
    document.removeEventListener('pi-gui:workspace-generation', resetForWorkspace);
    document.removeEventListener('pi-gui:git-scope', resetForWorkspace);
    closeAllTabs();
    if (activePanel?.isCurrent === isCurrent) activePanel = null;
  });
}
