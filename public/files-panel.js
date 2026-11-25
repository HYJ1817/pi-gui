/* Files owns navigation and a single live preview controller. Format selection,
 * decoding, bytes, object URLs and plugin resources belong to file-preview. */
import * as Api from './api.js';
import { openSecondarySurface } from './ui/secondary-surface.js';
import { mountFilePreview } from './file-preview/index.js';
import { createFilesLayout } from './files-layout.js';
import { createFilesTabs } from './files-tabs.js';
import { createFilesTree } from './files-tree.js';
import { FILES_TAB_LIMIT, pathKey, requestKey, readingState, readFilesState, writeFilesState, sameScope, sameWorkspace } from './files-state.js';
import { isPathWithin } from './file-link-model.js';
import { runtimeStore, onRuntimeChange } from './runtime-state.js';
import { S } from './state.js';
import { toast } from './ui/toast.js';

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const formatBytes = (bytes) => Number.isFinite(bytes) ? bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB` : '';
const localSource = (request) => request?.source === 'attachment' || request?.source === 'archive';
function boundedRequest(source) {
  const result = { external: source.external === true };
  for (const [key, limit] of Object.entries({ path: 4096, name: 512, cwd: 4096, conversationId: 256, fileId: 256, grantId: 256 })) {
    if (typeof source[key] === 'string' && source[key].length <= limit) result[key] = source[key];
  }
  for (const key of ['line', 'column', 'endLine', 'endColumn']) {
    if (Number.isSafeInteger(source[key]) && source[key] > 0 && source[key] <= 1e9) result[key] = source[key];
  }
  if (Number.isFinite(source.bytes) && source.bytes >= 0) result.bytes = source.bytes;
  result.conversationId ||= null;
  return result;
}
function parentDescription(request = {}) {
  if (!request || typeof request !== 'object') return {};
  const parent = boundedRequest(request);
  if (request.source === 'attachment') { parent.source = 'attachment'; parent.attachmentId = String(request.attachmentId || '').slice(0, 256); }
  return parent;
}
let activePanel = null;
let tabSequence = 0;
let pendingSessionSequence = 0;
const attachmentKeys = new WeakMap();

export function openFileReference(request) {
  if (!request?.path && !(request?.source === 'attachment' && request.file) && !(request?.source === 'archive' && request.bytes)) return null;
  return openFilesPanel({ openRequest: request, triggerId: request.triggerId || 'btnFiles' });
}

export function openFilesPanel(options = {}) {
  let mounted = false;
  const surface = openSecondarySurface('files', (host, view) => {
    mounted = true;
    return mountFilesPanel(host, view, options);
  }, { label: '文件', headerSelector: '.files-preview-head', triggerId: options.triggerId || 'btnFiles' });
  // Reusing a live top-level tab skips mount, not the caller's new open intent.
  // Always activate through the manager before touching a possibly hidden host.
  if (!mounted && options.openRequest && activePanel?.isCurrent()) void activePanel.open(options.openRequest);
  return surface;
}

function currentIdentity() {
  const conversationId = Api.gitConversationScope() || null;
  const record = conversationId ? runtimeStore.get(conversationId) : null;
  return {
    cwd: record?.item?.workspace?.cwd || S.cwd || '',
    conversationId,
    sessionId: record?.item?.nativeSessionId || record?.owner?.sessionId || (!conversationId ? S.state?.sessionId : '') || '',
  };
}

export function mountFilesPanel(host, view, options = {}) {
  host.classList.add('files-surface');
  // Keep injected legacy document/asset transports intact: registry/access owns
  // their compatibility adapter, not a second renderer in the Files panel.
  const transport = options.transport || {
    list: Api.fetchFiles, metadata: Api.fetchFileMetadata, document: Api.fetchFileDocument, asset: Api.fetchFileAsset,
    externalMetadata: Api.fetchExternalFileMetadata, externalDocument: Api.fetchExternalFileDocument, externalAsset: Api.fetchExternalFileAsset,
    content: Api.fetchFilePreviewContent, externalContent: Api.fetchExternalFilePreviewContent, mediaUrl: Api.filePreviewMediaUrl,
    search: (...args) => Api.searchWorkspaceFiles?.(...args),
  };
  const previewMount = options.previewMount || mountFilePreview;
  const getIdentity = options.getIdentity || currentIdentity;
  let identity = { ...getIdentity() };
  let sessionOverride = null;
  let sessionBeforeSwitch = null;
  let alive = true;
  let scopeEpoch = 0;
  let openSequence = 0;
  let previewSequence = 0;
  let controller = null;
  let controllerTab = null;
  let tabs = [];
  let activeKey = null;
  let tree = null;
  let persistTimer = null;
  let restored = readFilesState(identity, options.storage);
  let restoring = false;
  /* Tombstones of keys the user closed while a history restore is still
   * deferred. Dedup against currently-open tabs is not enough: a tab the user
   * opened and then closed before the tree resolved is no longer in `existing`,
   * so the late snapshot would resurrect it — an overwrite of an explicit user
   * decision, exactly what restoration must never do. Keys die with the panel
   * (or the scope reset): a later mount restores history normally again, and
   * explicitly reopening a file always wins because openTab runs its own path. */
  const closedKeys = new Set();
  const metadataRequests = new Set();
  let visible = view.isVisible?.() !== false;
  const isCurrent = () => alive && view.isCurrent();
  const isVisible = () => isCurrent() && visible && view.isVisible?.() !== false;
  const scopeCurrent = (run) => isCurrent() && scopeEpoch === run && sameScope(identity, effectiveIdentity());
  function effectiveIdentity() {
    const result = { ...getIdentity() };
    if (!result.conversationId && sessionOverride) result.sessionId = sessionOverride;
    return result;
  }
  const activeTab = () => tabs.find((tab) => tab.key === activeKey) || null;
  function disposePreview({ save = true } = {}) {
    previewSequence++;
    if (controller) {
      if (save && controllerTab) {
        try { controllerTab.state = readingState(controller.getState?.()); } catch { /* A failed plugin must not prevent disposal. */ }
      }
      try { controller.dispose(); } catch { /* Isolate a failed plugin cleanup from the surface's remaining resources. */ }
      finally { controller = null; controllerTab = null; }
    }
    toolbar.replaceChildren();
  }
  function snapshot() {
    return { tabs, active: activeKey, tree: tree?.getState(), layout: geometry.getState() };
  }
  function persistNow() {
    clearTimeout(persistTimer); persistTimer = null;
    if (controller && controllerTab) {
      try { controllerTab.state = readingState(controller.getState?.()); } catch { /* optional reading position */ }
    }
    writeFilesState(identity, snapshot(), options.storage);
  }
  function persistSoon() {
    if (!isCurrent() || restoring) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { if (isCurrent()) persistNow(); }, 160);
  }
  const geometry = createFilesLayout(host, { state: restored?.layout, onChange: persistSoon });
  host.append(geometry.element);
  const head = node('div', 'files-preview-head');
  const path = node('span', 'files-preview-path');
  path.tabIndex = 0;
  const toolbar = node('div', 'files-format-tools');
  head.append(path, toolbar, geometry.treeButton);
  const preview = node('section', 'files-preview');
  preview.id = 'filesPreviewPanel';
  preview.setAttribute('aria-label', '文件预览（只读）');
  const tabsUI = createFilesTabs({
    getTabs: () => tabs, getActive: () => activeKey,
    activate: (key) => { openSequence++; cancelMetadata(); void activate(key); },
    close: closeTabs, reorder,
  });
  geometry.main.append(tabsUI.element, head, preview);

  function updatePath(tab = activeTab()) {
    const label = tab?.request.path || tab?.request.name || '';
    path.textContent = label;
    path.hidden = !label;
    path.setAttribute('aria-label', label);
    const bytes = tab?.request.source === 'archive' ? tab.request.size : tab?.request.bytes ?? tab?.request.size;
    path.title = [label, formatBytes(bytes)].filter(Boolean).join('\n');
  }
  function renderTabs(settings) {
    tabsUI.render(settings);
    preview.setAttribute('role', tabs.length ? 'tabpanel' : 'group');
    if (activeTab()) preview.setAttribute('aria-labelledby', activeTab().id);
    else preview.removeAttribute('aria-labelledby');
  }
  function empty(title = '选择文件预览', detail = '') {
    toolbar.replaceChildren(); updatePath(null);
    preview.replaceChildren();
    const section = node('section', 'files-empty');
    section.append(node('h4', 'files-empty-title', title));
    if (detail) section.append(node('p', 'files-empty-text', detail));
    preview.append(section);
  }
  function failure(tab, text) {
    if (activeTab() !== tab) return;
    disposePreview({ save: false });
    preview.replaceChildren(node('p', 'files-preview-note', text));
    preview.firstChild.setAttribute('role', 'alert');
  }
  function cancelMetadata() {
    for (const request of metadataRequests) request.abort();
    metadataRequests.clear();
  }
  async function metadata(request, { restore = false } = {}) {
    const abort = new AbortController(); metadataRequests.add(abort);
    try {
      if (request.external) {
        if (typeof transport.externalMetadata !== 'function') return { ok: !restore, request };
        const result = await transport.externalMetadata(request.path, request.grantId, request.conversationId, { signal: abort.signal });
        if (request.fileId && result?.file?.fileId && request.fileId !== result.file.fileId) return { ok: false, code: 'file_changed' };
        if (restore && (!request.fileId || result?.file?.fileId !== request.fileId)) return { ok: false, code: 'file_changed' };
        return { ...result, request: { ...request, path: result?.file?.absolutePath || request.path, fileId: result?.file?.fileId || request.fileId || '', name: result?.file?.name || request.name, bytes: result?.file?.bytes } };
      }
      if (typeof transport.metadata !== 'function') return { ok: !restore, request };
      const result = await transport.metadata(request.path, request.conversationId, {
        root: request.cwd || '', workspace: tree?.workspace, generation: tree?.workspace?.generation,
        ...(restore ? { fileId: request.fileId } : {}), signal: abort.signal,
      });
      if (!result?.ok) return result;
      if (request.cwd && result.file?.absolutePath && !isPathWithin(request.cwd, result.file.absolutePath)) return { ok: false, code: 'stale_workspace' };
      if (request.fileId && result.file?.fileId && request.fileId !== result.file.fileId) return { ok: false, code: 'file_changed' };
      if (restore && (!request.fileId || result.file?.fileId !== request.fileId)) return { ok: false, code: 'file_changed' };
      return { ok: true, request: { ...request, fileId: result.file?.fileId || request.fileId || '', bytes: result.file?.bytes, name: result.file?.name || request.name } };
    } catch { return { ok: false, code: abort.signal.aborted ? 'aborted' : 'unavailable' }; }
    finally { metadataRequests.delete(abort); }
  }
  function mountPreview(tab) {
    if (!isVisible() || activeTab() !== tab) return;
    disposePreview(); updatePath(tab);
    const sequence = previewSequence;
    const run = scopeEpoch;
    const content = node('div', 'files-preview-content');
    preview.replaceChildren(content);
    const current = () => isVisible() && scopeCurrent(run) && previewSequence === sequence && activeTab() === tab;
    try {
      const mounted = previewMount(content, {
        ...tab.request,
        workspace: tab.request.external || localSource(tab.request) ? null : tree.workspace,
        generation: tab.request.external || localSource(tab.request) ? undefined : tree.workspace?.generation,
      }, {
        toolbar, state: tab.state || {}, transport,
        onMetadata(file) {
          if (!current() || !file) return;
          if (typeof file.fileId === 'string' && !tab.request.fileId) tab.request.fileId = file.fileId;
          if (Number.isFinite(file.bytes)) {
            if (tab.request.source === 'archive') tab.request.size = file.bytes;
            else tab.request.bytes = file.bytes;
            updatePath(tab);
          }
          persistSoon();
        },
        onOpen(request) {
          if (current()) void openFromReference(request?.source === 'archive' ? { ...request, parent: parentDescription(tab.request) } : request);
        },
      });
      if (!mounted || typeof mounted.dispose !== 'function') throw new Error('Preview controller unavailable');
      controller = mounted; controllerTab = tab;
      Promise.resolve(mounted.ready).then(() => { if (current()) persistSoon(); }, () => {
        if (current()) failure(tab, '无法预览此文件，请重新打开。');
      });
    } catch { if (current()) failure(tab, '无法预览此文件，请重新打开。'); }
  }
  async function activate(key, { validate = true, focus = false, resume = false } = {}) {
    const tab = tabs.find((item) => item.key === key);
    if (!tab) return;
    disposePreview();
    activeKey = key;
    if (!resume) renderTabs({ focus });
    updatePath(tab);
    if (!isVisible()) { tab.needsValidation = true; persistSoon(); return; }
    if (!resume) {
      tree.select(tab.request.external || localSource(tab.request) ? null : tab.request.path);
      if (!tab.request.external && !localSource(tab.request)) void tree.reveal(tab.request.path);
      geometry.hideOverlay();
    }
    const run = scopeEpoch;
    const sequence = previewSequence;
    const intent = openSequence;
    if (tab.needsValidation && validate) {
      preview.replaceChildren(node('p', 'files-tree-status', '正在核对文件…'));
      // In-memory archive members inherit their parent's authority and object
      // identity; retaining the bytes is not permission to restore a changed ZIP.
      const target = tab.request.source === 'archive' ? tab.request.parent : tab.request;
      const result = target?.source === 'attachment' ? { ok: true } : await metadata(target, { restore: true });
      if (!isVisible() || !scopeCurrent(run) || previewSequence !== sequence || openSequence !== intent || activeTab() !== tab) return;
      if (!result?.ok) { failure(tab, '文件不存在、已变化或暂不可用，请从文件树重新打开。'); return; }
      if (result.request && tab.request.source !== 'archive') tab.request = result.request;
      tab.needsValidation = false;
    }
    mountPreview(tab); persistSoon();
  }
  function closeTabs(keys, { focus = false } = {}) {
    if (!keys.length) return;
    openSequence++; cancelMetadata();
    const removed = new Set(keys);
    /* Every close is a user decision no later restore may undo — and a restore
     * can arrive *after* this close in two ways, not one: the deferred tree
     * resolution, but also a session settle that reads a fresh snapshot under a
     * namespace that was empty (and therefore unrestorable) at mount time. In
     * the empty-session case `restored` is null here, so guarding on it leaves
     * no tombstone and the settle resurrects a file the user already closed.
     * Tombstoning is unconditional: it only filters the restore merge, never an
     * explicit open (which runs its own path), so recording every close cannot
     * block a file the user later reopens on purpose. Keys still die with the
     * panel, so a fresh mount restores history normally again. */
    for (const key of removed) closedKeys.add(key);
    const index = tabs.findIndex((tab) => tab.key === activeKey);
    const removesActive = removed.has(activeKey);
    if (removesActive) disposePreview();
    tabs = tabs.filter((tab) => !removed.has(tab.key));
    if (removesActive) {
      activeKey = null;
      const next = tabs[Math.min(index, tabs.length - 1)];
      if (next) void activate(next.key, { focus });
      else { tree.select(null); renderTabs(); empty(); if (focus) geometry.treeButton.focus(); }
    } else renderTabs({ focus });
    persistSoon();
  }
  function reorder(key, target) {
    const from = tabs.findIndex((tab) => tab.key === key);
    const to = tabs.findIndex((tab) => tab.key === target);
    if (from < 0 || to < 0 || from === to) return;
    const [tab] = tabs.splice(from, 1); tabs.splice(to, 0, tab);
    renderTabs(); persistSoon();
  }
  function openTab(request) {
    const key = requestKey(request);
    let tab = tabs.find((item) => item.key === key);
    if (!tab) {
      if (tabs.length >= FILES_TAB_LIMIT) { toast('最多打开 24 个文件，请先关闭一些标签。', 'warn'); return; }
      tab = { key, id: `filesTab-${++tabSequence}`, request, state: {} };
      tabs.push(tab);
    } else {
      if (controllerTab === tab) disposePreview();
      // Local File/member metadata has an empty token; incoming references omit
      // it. Those are the same identity, not a replacement that resets reading.
      if ((tab.request.fileId || '') !== (request.fileId || '') || request.line) tab.state = {};
      tab.request = request; tab.needsValidation = false;
    }
    void activate(key, { validate: false });
  }
  async function openFromReference(source) {
    if (!isCurrent() || !source || (!source.path && !(source.source === 'attachment' && source.file) && !(source.source === 'archive' && source.bytes))) return;
    if (!sameScope(identity, effectiveIdentity())) reset();
    const run = scopeEpoch;
    const sequence = ++openSequence;
    cancelMetadata();
    let request = { ...source };
    if (request.source === 'archive') {
      const parent = parentDescription(request.parent);
      if (!request.parent || request.parent.source === 'archive' || (parent.conversationId || null) !== identity.conversationId
        || (parent.cwd && pathKey(parent.cwd) !== pathKey(identity.cwd))) return;
      if (Object.prototype.toString.call(request.bytes) !== '[object Uint8Array]' || request.bytes.byteLength > 8 * 1024 * 1024) {
        toast('压缩包内文件超过 8 MB 预览上限。', 'warn'); return;
      }
      const name = String(request.name || '文件').slice(0, 512);
      const archiveEntry = String(request.archiveEntry || name).slice(0, 4096);
      const local = { source: 'archive', name, archiveEntry, parent, size: request.bytes.byteLength };
      const key = requestKey(local);
      const total = tabs.reduce((sum, tab) => sum + (tab.request.source === 'archive' && tab.key !== key ? tab.request.bytes.byteLength : 0), 0);
      if (total + request.bytes.byteLength > 32 * 1024 * 1024) { toast('压缩包预览已达 32 MB 上限，请先关闭一些标签。', 'warn'); return; }
      // Own an exact-size copy: a small view must not retain an enormous ZIP buffer.
      openTab({ ...local, bytes: Uint8Array.from(request.bytes) }); return;
    }
    if (request.source === 'attachment') {
      if (!request.file || typeof request.file !== 'object') return;
      if (!attachmentKeys.has(request.file)) attachmentKeys.set(request.file, `local-${++tabSequence}`);
      request = { source: 'attachment', file: request.file, name: String(request.name || request.file.name || '附件').slice(0, 512), attachmentId: request.attachmentId || attachmentKeys.get(request.file), size: request.file.size, cwd: identity.cwd, conversationId: identity.conversationId };
      openTab(request); return;
    }
    request = boundedRequest(request);
    if (typeof request.path !== 'string' || !request.path) return;
    const wanted = request.conversationId || null;
    if (wanted !== identity.conversationId || (request.cwd && identity.cwd && pathKey(request.cwd) !== pathKey(identity.cwd))) {
      toast('这个文件引用属于其它会话，请先切换到那个会话。', 'warn'); return;
    }
    if (request.external && !request.grantId) { toast('缺少访问授权，请重新打开。', 'warn'); return; }
    /* Opening a file must not queue behind the workspace tree. The tree is a
     * navigation aid; blocking the user's open on its (possibly slow) root
     * listing is exactly the window in which a late history restore used to
     * overwrite newer user actions. The open therefore proceeds independently:
     * the path is confined to the workspace root and the file's object identity
     * is re-verified by metadata() itself (fileId on restore, root+path binding
     * otherwise). The opaque workspace token is only available once the tree
     * has resolved; without it the backend still binds root path + fileId, and
     * the token check joins at preview time — so a workspace that changed its
     * backing under the same path fails at preview, never reads wrong bytes. */
    request = { ...request, cwd: request.external ? '' : request.cwd || identity.cwd, conversationId: wanted, name: String(request.name || request.path.split(/[\\/]/).pop()).slice(0, 512) };
    const result = await metadata(request);
    if (!scopeCurrent(run) || sequence !== openSequence) return;
    if (!result?.ok) { toast('文件不存在、已变化或当前无法读取。', 'warn'); return; }
    openTab(result.request);
  }
  /* Restoration is a merge, never an overwrite. By the time the deferred file
   * tree resolves, the user may already have opened, closed or reordered tabs;
   * a late snapshot must not resurrect closed tabs, drop user-opened ones, or
   * clobber the order and selection the user just chose. Restored history is
   * deduplicated by stable request key against what is already open. */
  function restoreTabs(value) {
    if (!value?.tabs?.length) return;
    if (!sameScope(identity, effectiveIdentity())) return;
    const existing = new Set(tabs.map((tab) => tab.key));
    const seen = new Set();
    const incoming = value.tabs.filter((request) => {
      const key = requestKey(request);
      if (seen.has(key) || existing.has(key) || closedKeys.has(key) || (request.conversationId || null) !== identity.conversationId
        || (request.cwd && pathKey(request.cwd) !== pathKey(identity.cwd))) return false;
      seen.add(key); return true;
    }).map((request) => ({ key: requestKey(request), id: `filesTab-${++tabSequence}`, request: boundedRequest(request), state: readingState(request.state), needsValidation: true }));
    if (!incoming.length) return;
    // Attachments and in-memory archive members are never persisted, so any
    // user tab already open wins; restored history only fills in the gaps.
    tabs = tabs.concat(incoming);
    // The user's current selection outranks the snapshot. Only a panel with no
    // active tab yet (the pure restore path) adopts the snapshot's active tab.
    const current = activeTab();
    const key = current ? current.key
      : tabs.some((tab) => tab.key === value.active) ? value.active
      : (existing.size ? null : tabs[0].key);
    restoring = true;
    const finish = () => { restoring = false; };
    if (key) void activate(key).finally(finish);
    else { renderTabs(); finish(); }
    persistSoon();
  }
  function installTree(treeState) {
    tree?.dispose(); geometry.sidebar.replaceChildren();
    tree = createFilesTree(geometry.sidebar, {
      transport, getIdentity: () => identity, isCurrent, state: treeState,
      onChange: persistSoon,
      onOpen: (entry) => void openFromReference({ ...entry, cwd: identity.cwd, conversationId: identity.conversationId }),
      onRoot({ status, workspace, previous }) {
        if (!isCurrent()) return;
        if (status === 'error' || status === 'no-project') {
          // The project tree does not authorize original File bytes or an
          // independently granted external file. A late listing failure must
          // not tear down either reader; their own owner/revoke paths remain.
          const selected = activeTab()?.request;
          if (selected && (localSource(selected) || selected.external)) return;
          openSequence++; cancelMetadata(); disposePreview();
          empty(status === 'no-project' ? '还没有打开项目' : '暂时无法预览', status === 'no-project' ? '在左侧选择一个项目。' : '请刷新文件列表后重新选择文件。');
        } else if (previous && previous.id !== workspace?.id) {
          openSequence++; cancelMetadata(); disposePreview(); tabs = []; activeKey = null; renderTabs(); empty('工作区已切换', '');
        } else if (restored) {
          const value = restored; restored = null; restoreTabs(value);
        } else if (activeTab() && !controller) {
          activeTab().needsValidation = true; void activate(activeKey);
        }
      },
    });
    void tree.loadRoot();
  }
  function reset(event) {
    // Identity invalidation can reach the manager before this event listener.
    // Hidden/invalid is never a reason to retain the previous owner's bytes.
    if (!alive) return;
    persistNow();
    scopeEpoch++; openSequence++; cancelMetadata(); disposePreview();
    tabs = []; activeKey = null; tabsUI.dispose();
    if (event?.type === 'pi-gui:session-switch' && !Api.gitConversationScope()) {
      sessionBeforeSwitch = getIdentity().sessionId;
      sessionOverride = event.detail?.sessionKey || `pending:${++pendingSessionSequence}`;
    }
    identity = effectiveIdentity();
    restored = event?.type === 'pi-gui:workspace-generation' ? null : readFilesState(identity, options.storage);
    renderTabs(); empty(); installTree(restored?.tree);
  }
  function onContext() {
    if (sessionOverride && getIdentity().sessionId && getIdentity().sessionId !== sessionBeforeSwitch) sessionOverride = null;
    const next = effectiveIdentity();
    if (sameScope(identity, next)) return;
    /* A genuine workspace/conversation change is a full reset: file access is
     * bound to that scope, so every open tab and in-flight open must go. But the
     * session id is only a *history* namespace — the backend never binds file
     * access to it. Session identity always settles asynchronously after the
     * bridge is ready (it is empty at mount, then the real id arrives), so a
     * session-only transition while cwd+conversation stay stable must not destroy
     * open tabs or an in-flight open the user already started. Adopt the settled
     * session in place and merge that session's history around what survives. */
    if (sameWorkspace(identity, next)) { settleSession(next); return; }
    reset();
  }
  /* The tree merge is per-field, never an overwrite. The live tree is the user's
   * most recent intent inside the *same* workspace+conversation scope (file access
   * never binds to the session id). Fields the user actually touched — reported by
   * the tree in `touched` — always win over the settled session's snapshot, because
   * rolling them back would undo a deliberate gesture. Untouched fields fall back to
   * the snapshot so the session's real preference is still adopted. This matters in
   * the two extremes the round-2 review exposed: when the target session has *no*
   * snapshot at all the user's tree survives verbatim instead of being replaced by
   * the default, and a boolean the user toggled (e.g. hidden-items off) is not
   * resurrected to the snapshot's stale `true` merely because `false` is also the
   * install-time default. Expanded folders union rather than pick a winner: both
   * the user's and the snapshot's expansions are cheap to keep and neither is a
   * destructive rollback. `touched` is transient merge metadata, never persisted. */
  function mergeTreeState(live, snap) {
    if (!snap || typeof snap !== 'object') {
      if (!live || typeof live !== 'object') return undefined;
      const { touched, ...rest } = live;
      return rest;
    }
    if (!live || typeof live !== 'object') return snap;
    const touched = new Set(Array.isArray(live.touched) ? live.touched : []);
    const expanded = [...new Set([...(Array.isArray(live.expanded) ? live.expanded : []), ...(Array.isArray(snap.expanded) ? snap.expanded : [])])].slice(0, 96);
    return {
      selected: live.selected || snap.selected || null,
      hidden: touched.has('hidden') ? live.hidden === true : snap.hidden === true,
      expanded,
      scrollTop: touched.has('scrollTop') && Number(live.scrollTop) ? Number(live.scrollTop) : (Number(snap.scrollTop) || Number(live.scrollTop) || 0),
    };
  }
  function settleSession(next) {
    if (!alive) return;
    identity = { ...next };
    /* History is namespaced by session, and the snapshot carries more than tabs:
     * it also holds the file-tree state (expanded folders, the hidden-items
     * toggle, selection, scroll). Adopting the settled session re-reads that
     * snapshot, but the rebuild must merge it around the tree the user already
     * has — captured live before the old tree is disposed — rather than overwrite
     * it. What settle must NOT do is reset()'s destructive half: no scopeEpoch or
     * openSequence bump, no cancelMetadata, no disposePreview, no clearing tabs
     * or activeKey — so open tabs, their mounted previews and any in-flight open
     * all survive. The tree rebuild only replaces the navigation sidebar; it does
     * not touch the tab strip or the preview pane. Restoration itself stays on the
     * normal deferred path: `restored` is left set and the tree's onRoot merge
     * applies it around the surviving user tabs, deduplicated by request key. */
    const liveTree = tree?.getState?.();
    restored = readFilesState(identity, options.storage);
    installTree(mergeTreeState(liveTree, restored?.tree));
    persistSoon();
  }
  function revoked(event) {
    const id = event?.detail?.revoked;
    if (typeof id !== 'string' || !id) return;
    openSequence++; cancelMetadata();
    closeTabs(tabs.filter((tab) => (tab.request.external && tab.request.grantId === id)
      || (tab.request.source === 'archive' && tab.request.parent?.external && tab.request.parent.grantId === id)).map((tab) => tab.key));
  }
  function attachmentRevoked(event) {
    const id = event?.detail?.attachmentId;
    if (!id) return;
    closeTabs(tabs.filter(tab => (tab.request.source === 'attachment' && tab.request.attachmentId === id)
      || (tab.request.source === 'archive' && tab.request.parent?.source === 'attachment' && tab.request.parent.attachmentId === id)).map(tab => tab.key));
  }
  document.addEventListener('pi-gui:attachment-revoked', attachmentRevoked);
  const resetEvents = ['pi-gui:workspace-generation', 'pi-gui:git-scope', 'pi-gui:session-switch'];
  for (const name of resetEvents) document.addEventListener(name, reset);
  document.addEventListener('pi-gui:session-evidence-context', onContext);
  document.addEventListener('pi-gui:external-grants', revoked);
  const unsubscribeRuntime = onRuntimeChange(onContext);
  preview.addEventListener('scroll', persistSoon, true);
  function onPanelKey(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || !tabs.length) return;
    if (event.key.toLowerCase() === 'w') {
      event.preventDefault(); event.stopPropagation(); closeTabs([activeKey], { focus: true });
    } else if (['PageUp', 'PageDown', 'Tab'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      openSequence++; cancelMetadata();
      const step = event.key === 'PageUp' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1;
      const index = tabs.findIndex((tab) => tab.key === activeKey);
      void activate(tabs[(index + step + tabs.length) % tabs.length].key, { focus: true });
    }
  }
  host.addEventListener('keydown', onPanelKey);
  const onPageHide = () => persistNow();
  window.addEventListener('pagehide', onPageHide);
  renderTabs(); empty(); installTree(restored?.tree);
  activePanel = { isCurrent, open: openFromReference };
  const unsubscribeVisibility = view.onVisibility?.((shown) => {
    const next = typeof shown === 'boolean' ? shown : view.isVisible?.() !== false;
    if (!alive || next === visible) return;
    visible = next;
    openSequence++; cancelMetadata();
    if (!next) {
      disposePreview();
      for (const tab of tabs) tab.needsValidation = true;
      tabsUI.closeMenu(); geometry.hideOverlay(); preview.replaceChildren();
      persistNow();
    } else {
      const run = scopeEpoch;
      onContext(); geometry.measure();
      if (run === scopeEpoch && activeTab()) void activate(activeKey, { resume: true });
    }
  });
  if (options.openRequest) void openFromReference(options.openRequest);
  view.onDispose(() => {
    persistNow(); alive = false; scopeEpoch++; openSequence++;
    cancelMetadata(); disposePreview(); clearTimeout(persistTimer);
    tree.dispose(); tabsUI.dispose(); geometry.dispose();
    for (const name of resetEvents) document.removeEventListener(name, reset);
    document.removeEventListener('pi-gui:session-evidence-context', onContext);
    document.removeEventListener('pi-gui:external-grants', revoked);
    document.removeEventListener('pi-gui:attachment-revoked', attachmentRevoked);
    window.removeEventListener('pagehide', onPageHide);
    host.removeEventListener('keydown', onPanelKey);
    preview.removeEventListener('scroll', persistSoon, true);
    unsubscribeRuntime(); unsubscribeVisibility?.();
    tabs = []; activeKey = null; restored = null;
    // Right pane can keep a hidden host mounted. Drop event closures and local
    // archive/File references as well as the plugin's content when it closes.
    tabsUI.render(); preview.replaceChildren(); geometry.sidebar.replaceChildren();
    if (activePanel?.isCurrent === isCurrent) activePanel = null;
  });
  return { open: openFromReference, getState: () => ({ identity: { ...identity }, tabs: tabs.map((tab) => ({ key: tab.key, path: tab.request.path, state: { ...tab.state } })), active: activeKey }), isCurrent };
}
