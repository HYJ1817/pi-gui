import { createIcon } from './ui/icons.js';
import { createFileIcon } from './ui/file-icons.js';
import { iconButton } from './files-layout.js';
import { pathKey } from './files-state.js';

const node = (tag, cls, text) => {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  if (text !== undefined) element.textContent = text;
  return element;
};
const safePath = (path) => typeof path === 'string' && path.length <= 4096 && !/[\x00-\x1f]/.test(path)
  && !/^(?:[\\/]|[a-z]:)/i.test(path) && !path.split(/[\\/]/).includes('..');
const normalize = (entries, budget) => (Array.isArray(entries) ? entries : []).slice(0, budget).filter((entry) => safePath(entry?.path) && ['dir', 'file'].includes(entry.type)).map((entry) => ({ name: String(entry.name || entry.path.split('/').pop()).slice(0, 512), path: entry.path, type: entry.type, bytes: Number.isFinite(entry.bytes) ? entry.bytes : null }));

/* Workspace-only, directory-at-a-time tree. Search is a bounded server query,
 * never a recursive renderer walk, and never uses external grants. */
export function createFilesTree(sidebar, { transport, getIdentity, isCurrent, state = {}, onOpen, onRoot = () => {}, onChange = () => {} }) {
  let alive = true;
  let workspace = null;
  let roots = [];
  let dirs = new Map();
  let selected = state.selected || null;
  let focused = selected;
  let hidden = state.hidden === true;
  let status = 'loading';
  let epoch = 0;
  let rootSequence = 0;
  let revealSequence = 0;
  let rootPromise = null;
  let querySequence = 0;
  let searchTimer = null;
  let searchAbort = null;
  let searchRows = null;
  let searchMessage = '';
  let refreshingExpanded = [];
  let rootAbort = null;
  /* Fields the user explicitly changed since this tree was installed. A boolean
   * preference like `hidden` cannot merge by value alone — `false` is both the
   * untouched default and a deliberate user choice — so the merge that adopts a
   * settled session snapshot needs to know which fields carry real user intent
   * and which are still the install-time default. Only genuine user gestures mark
   * a field touched; restoring a snapshot or programmatic reveal/expand does not. */
  const touched = new Set();
  const pending = new Set();
  const equal = (a, b) => pathKey(a || '', getIdentity().cwd) === pathKey(b || '', getIdentity().cwd);
  const current = (run = epoch) => alive && isCurrent() && run === epoch;
  const controls = node('div', 'files-tree-controls');
  const searchWrap = node('div', 'files-tree-search');
  const search = node('input', 'ds-input files-search-input');
  search.type = 'search';
  search.maxLength = 200;
  search.placeholder = '搜索文件';
  search.setAttribute('aria-label', '搜索项目文件');
  searchWrap.append(createIcon('search'), search);
  const refresh = iconButton('刷新文件树', 'refresh');
  refresh.classList.add('files-refresh');
  const hiddenToggle = iconButton('显示隐藏项', 'eye');
  hiddenToggle.classList.add('files-hidden-toggle');
  hiddenToggle.setAttribute('aria-pressed', String(hidden));
  controls.append(searchWrap, hiddenToggle, refresh);
  const message = node('p', 'files-message');
  message.hidden = true;
  const tree = node('div', 'files-tree rp-scroll');
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', '项目文件');
  sidebar.append(controls, message, tree);

  function setMessage(text, error = false) {
    message.textContent = text || '';
    message.hidden = !text;
    message.setAttribute('role', error ? 'alert' : 'status');
    if (error) message.dataset.tone = 'error'; else delete message.dataset.tone;
  }
  function visibleRows() { return [...tree.querySelectorAll('.files-entry')]; }
  function focusPath(path) {
    focused = path;
    for (const row of visibleRows()) row.tabIndex = equal(row.dataset.filePath, path) ? 0 : -1;
    visibleRows().find((row) => equal(row.dataset.filePath, path))?.focus();
  }
  function render() {
    const oldScroll = tree.scrollTop;
    const hadFocus = tree.contains(document.activeElement);
    tree.replaceChildren();
    tree.setAttribute('aria-busy', String(status === 'loading' || searchMessage === '正在搜索…'));
    if (searchRows !== null) {
      if (searchMessage) tree.append(node('div', 'files-tree-status', searchMessage));
      for (const entry of searchRows) tree.append(entryRow(entry, 0, true));
    } else if (status === 'loading') tree.append(node('div', 'files-tree-status', '正在读取项目文件…'));
    else if (status === 'no-project') tree.append(node('div', 'files-tree-status', '还没有打开项目。'));
    else if (status === 'empty') tree.append(node('div', 'files-tree-status', '这个目录没有可显示的文件。'));
    else if (status !== 'error') {
      const visit = (entries, depth) => {
        for (const entry of entries) {
          tree.append(entryRow(entry, depth));
          const dir = dirs.get(entry.path);
          if (entry.type !== 'dir' || !dir?.expanded) continue;
          if (dir.loading) tree.append(node('div', 'files-tree-status files-tree-indent', '读取中…'));
          else if (dir.error) {
            const retry = node('button', 'btn ghost tiny files-dir-retry', '读取失败，重试');
            retry.title = dir.error;
            retry.onclick = () => void loadDirectory(entry, dir);
            tree.append(retry);
          } else visit(dir.entries, depth + 1);
        }
      };
      visit(roots, 0);
    }
    const rows = visibleRows();
    let stop = rows.find((row) => equal(row.dataset.filePath, focused)) || rows.find((row) => equal(row.dataset.filePath, selected)) || rows[0];
    if (stop) { focused = stop.dataset.filePath; stop.tabIndex = 0; if (hadFocus) stop.focus(); }
    tree.scrollTop = oldScroll;
  }
  function entryRow(entry, depth, result = false) {
    const row = node('button', 'files-entry');
    row.type = 'button';
    row.tabIndex = -1;
    row.dataset.filePath = entry.path;
    row.style.setProperty('--files-depth', depth);
    row.title = entry.path;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-selected', String(equal(entry.path, selected)));
    row.onfocus = () => { focused = entry.path; for (const item of visibleRows()) item.tabIndex = item === row ? 0 : -1; };
    if (entry.type === 'dir') {
      row.classList.add('files-entry-dir');
      row.setAttribute('aria-expanded', String(Boolean(dirs.get(entry.path)?.expanded)));
      row.append(createIcon(dirs.get(entry.path)?.expanded ? 'chevronDown' : 'chevronRight', { className: 'files-entry-chev' }));
      row.onclick = () => void toggleDirectory(entry);
    } else {
      row.classList.add('files-entry-file');
      row.setAttribute('aria-current', equal(entry.path, selected) ? 'page' : 'false');
      row.append(createFileIcon(document, entry.path, 'files-entry-mark file-kind-icon'));
      row.onclick = () => { focused = entry.path; onOpen(entry); };
    }
    row.append(node('span', 'files-entry-name', result ? entry.path : entry.name));
    return row;
  }
  tree.onkeydown = (event) => {
    const row = event.target.closest('.files-entry');
    if (!row) return;
    const rows = visibleRows();
    const index = rows.indexOf(row);
    let next = null;
    if (event.key === 'ArrowDown') next = rows[Math.min(index + 1, rows.length - 1)];
    else if (event.key === 'ArrowUp') next = rows[Math.max(0, index - 1)];
    else if (event.key === 'Home') next = rows[0];
    else if (event.key === 'End') next = rows.at(-1);
    else if (event.key === 'ArrowRight') {
      if (row.hasAttribute('aria-expanded')) {
        if (row.getAttribute('aria-expanded') === 'false') row.click();
        else if (Number(rows[index + 1]?.getAttribute('aria-level')) > Number(row.getAttribute('aria-level'))) next = rows[index + 1];
      }
    } else if (event.key === 'ArrowLeft') {
      if (row.getAttribute('aria-expanded') === 'true') row.click();
      else {
        const parts = row.dataset.filePath.split('/'); parts.pop();
        next = rows.find((item) => equal(item.dataset.filePath, parts.join('/')));
      }
    } else if (event.key === 'Enter' || event.key === ' ') row.click();
    else return;
    event.preventDefault();
    if (next) { focusPath(next.dataset.filePath); next.scrollIntoView?.({ block: 'nearest' }); }
  };
  function directoryState(path) {
    let dir = dirs.get(path);
    if (!dir && dirs.size < 128) { dir = { expanded: false, loaded: false, loading: false, entries: [], request: 0 }; dirs.set(path, dir); }
    return dir;
  }
  function entryBudget() { return Math.max(0, 4000 - roots.length - [...dirs.values()].reduce((sum, dir) => sum + dir.entries.length, 0)); }
  async function loadDirectory(entry, dir) {
    if (!dir || !workspace) return false;
    if (dir.promise) return dir.promise;
    const run = epoch;
    const request = ++dir.request;
    const controller = new AbortController(); pending.add(controller);
    dir.loading = true; dir.error = ''; render();
    dir.promise = (async () => {
      let result;
      try { result = await transport.list(entry.path, { workspace, generation: workspace.generation, hidden, conversationId: getIdentity().conversationId, signal: controller.signal }); }
      catch { result = { ok: false }; }
      pending.delete(controller);
      if (!current(run) || dirs.get(entry.path) !== dir || request !== dir.request) return false;
      dir.loading = false; dir.promise = null;
      if (!result?.ok || (workspace && result.workspace?.id !== workspace.id)) {
        dir.error = '无法读取目录，请重试。'; render(); return false;
      }
      dir.entries = normalize(result.entries, entryBudget());
      dir.loaded = true;
      if (result.truncated || entryBudget() === 0) setMessage('目录内容过多，只显示了前一部分。');
      render(); onChange(); return true;
    })();
    return dir.promise;
  }
  async function toggleDirectory(entry) {
    const dir = directoryState(entry.path);
    if (!dir) { setMessage('已达文件树缓存上限，请刷新。'); return; }
    touched.add('expanded');
    dir.expanded = !dir.expanded;
    focused = entry.path;
    render(); onChange();
    if (dir.expanded && !dir.loaded) await loadDirectory(entry, dir);
  }
  async function expandPath(path, { targetIsDirectory = false, run = epoch } = {}) {
    let entries = roots;
    const parts = path.replace(/\\/g, '/').split('/');
    const count = Math.min(parts.length - (targetIsDirectory ? 0 : 1), 32);
    for (let i = 0; i < count; i++) {
      if (!current(run)) return;
      const prefix = parts.slice(0, i + 1).join('/');
      const entry = entries.find((item) => item.type === 'dir' && equal(item.path, prefix));
      if (!entry) return;
      const dir = directoryState(entry.path);
      if (!dir) return;
      dir.expanded = true;
      if (!dir.loaded && !await loadDirectory(entry, dir)) return;
      if (!current(run)) return;
      entries = dir.entries;
    }
  }
  async function reveal(path) {
    if (!safePath(path)) return;
    selected = path;
    const reveal = ++revealSequence;
    if (path.split(/[\\/]/).some((part) => part.startsWith('.')) && !hidden) {
      hidden = true; hiddenToggle.setAttribute('aria-pressed', 'true'); await loadRoot();
    } else if (rootPromise) await rootPromise;
    const run = epoch;
    if (!current(run) || reveal !== revealSequence) return;
    await expandPath(path, { run });
    if (!current(run) || reveal !== revealSequence || !equal(path, selected)) return;
    render();
    visibleRows().find((row) => equal(row.dataset.filePath, path))?.scrollIntoView?.({ block: 'nearest' });
    onChange();
  }
  function cancelSearch() {
    clearTimeout(searchTimer); searchTimer = null;
    searchAbort?.abort(); searchAbort = null; querySequence++;
  }
  async function runSearch() {
    cancelSearch();
    const q = search.value.trim().slice(0, 200);
    if (!q) { searchRows = null; searchMessage = ''; render(); return; }
    searchRows = []; searchMessage = '正在搜索…'; render();
    if (!workspace || typeof transport.search !== 'function') { searchMessage = '搜索暂不可用。'; render(); return; }
    const sequence = querySequence;
    const run = epoch;
    const owner = getIdentity();
    const controller = new AbortController(); searchAbort = controller;
    let result;
    try { result = await transport.search(q, owner.conversationId, { workspace, generation: workspace.generation, hidden, signal: controller.signal }); }
    catch { result = { ok: false }; }
    if (!current(run) || sequence !== querySequence || controller.signal.aborted) return;
    searchAbort = null;
    if (!result?.ok || (result.workspace && result.workspace.id !== workspace.id)) {
      searchRows = []; searchMessage = '搜索失败，请重试。';
    } else {
      const matches = result.matches || result.entries;
      searchRows = normalize((Array.isArray(matches) ? matches : []).map((item) => typeof item === 'string' ? { path: item, type: 'file' } : item), 100);
      searchMessage = result.truncated ? '结果较多，仅显示前 100 项。' : searchRows.length ? '' : '没有匹配的文件。';
    }
    render();
  }
  search.oninput = () => { cancelSearch(); searchTimer = setTimeout(() => { searchTimer = null; void runSearch(); }, 180); };
  search.onkeydown = (event) => {
    if (event.key === 'Escape' && search.value) { event.preventDefault(); event.stopPropagation(); search.value = ''; cancelSearch(); searchRows = null; searchMessage = ''; render(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); visibleRows()[0]?.focus(); }
    else if (event.key === 'Enter') { event.preventDefault(); void runSearch(); }
  };
  function loadRoot() {
    const expanded = [...new Set([...refreshingExpanded, ...[...dirs].filter(([, dir]) => dir.expanded).map(([path]) => path), ...(Array.isArray(state.expanded) ? state.expanded : [])])].slice(0, 96);
    refreshingExpanded = expanded;
    const restoredScroll = Number(state.scrollTop) || 0;
    state = {};
    const oldScroll = tree.scrollTop;
    const run = ++epoch;
    const request = ++rootSequence;
    cancelSearch(); rootAbort?.abort();
    for (const controller of pending) controller.abort(); pending.clear();
    rootAbort = new AbortController();
    dirs = new Map(); status = 'loading'; searchRows = null; setMessage(''); render();
    rootPromise = (async () => {
      let result;
      try { result = await transport.list('', { hidden, conversationId: getIdentity().conversationId, signal: rootAbort.signal }); }
      catch { result = { ok: false }; }
      if (!current(run) || request !== rootSequence) return null;
      const previous = workspace;
      workspace = result?.ok ? result.workspace || null : null;
      roots = result?.ok ? normalize(result.entries, 4000) : [];
      status = result?.noProject === true ? 'no-project' : !result?.ok ? 'error' : roots.length ? 'success' : 'empty';
      if (status === 'error') setMessage('无法读取项目文件，请刷新后重试。', true);
      else if (result?.truncated) setMessage('目录内容过多，只显示了前一部分。');
      render();
      onRoot({ status, workspace, previous });
      if (!current(run)) return null;
      for (const path of expanded.sort((a, b) => a.split('/').length - b.split('/').length)) {
        await expandPath(path, { targetIsDirectory: true, run });
        if (!current(run)) return null;
      }
      if (status !== 'error') refreshingExpanded = [];
      render(); tree.scrollTop = oldScroll || restoredScroll;
      if (search.value.trim()) void runSearch();
      return workspace;
    })();
    return rootPromise;
  }
  refresh.onclick = () => { document.dispatchEvent(new window.CustomEvent('pi-gui:files-refresh')); void loadRoot(); };
  hiddenToggle.onclick = () => { touched.add('hidden'); hidden = !hidden; hiddenToggle.setAttribute('aria-pressed', String(hidden)); onChange(); void loadRoot(); };
  // Scrolling and clicking are user gestures on navigation ephemera; marking them
  // touched keeps a settle from rolling the user's position back to a stale snapshot.
  tree.addEventListener('scroll', () => { if (tree.scrollTop) touched.add('scrollTop'); }, { passive: true });
  return {
    tree, search, refresh, hiddenToggle, loadRoot, reveal,
    get workspace() { return workspace; },
    get ready() { return rootPromise; },
    select(path) { selected = path; render(); },
    getState: () => ({ selected, hidden, expanded: [...new Set([...refreshingExpanded, ...[...dirs].filter(([, dir]) => dir.expanded).map(([path]) => path)])].slice(0, 96), scrollTop: tree.scrollTop, touched: [...touched] }),
    dispose() { alive = false; epoch++; rootAbort?.abort(); cancelSearch(); for (const controller of pending) controller.abort(); pending.clear(); dirs.clear(); roots = []; },
  };
}
