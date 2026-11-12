/* Multi-terminal surface in the existing right pane.
 *
 * P2 changes the unit of ownership: one backend PTY session per tab, each with
 * its own xterm instance kept mounted while the panel is open. Switching tabs
 * only toggles visibility, so the PTY is never recreated and the scrollback,
 * alternate screen and cursor state stay intact.
 *
 * Closing the surface disposes the xterm instances but not the PTYs. Reopening
 * calls `list` for the focused workspace and replays each session's bounded
 * buffer. Changing workspace detaches the frontend without stopping anything;
 * sessions are retired only when their own conversation/workspace is confirmed
 * gone (server sweep), or by an explicit stop/close.
 *
 * Keyboard bytes are forwarded verbatim and output is written to xterm
 * verbatim. No newline is appended and CR/ANSI sequences are not normalized.
 */
import { createPaneHeader } from './right-pane.js';
import { openSecondarySurface } from './ui/secondary-surface.js';
import {
  fetchTerminalStatus,
  listTerminals,
  createTerminal,
  startTerminal,
  readTerminal,
  writeTerminal,
  resizeTerminal,
  stopTerminal,
  closeTerminal,
} from './api.js';
import { createTerminalSession } from './terminal-session.js';
import { createTerminalTabs } from './terminal-tabs.js';

const DEFAULT_SIZE = Object.freeze({ cols: 80, rows: 24 });
const DEFAULT_LIMITS = Object.freeze({ minCols: 20, maxCols: 500, minRows: 5, maxRows: 200 });
/* These answers mean the backend no longer owns the session, so removing the
 * tab cannot hide a live PTY. Anything else (network error, 503, unknown code)
 * leaves the backend state uncertain. */
const CLOSE_SETTLED_CODES = new Set(['terminal_missing', 'stale_workspace', 'unknown_conversation']);

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

/* A disposed mount's late `create` response must not close a session that a
 * reopened pane already listed while that response was in flight. Claims are
 * module-wide because the backend PTY outlives a frontend mount; a session no
 * live mount has claimed is an orphan and is closed. */
const claimedSessions = new Map();
/* Remembering the active tab per workspace is a UI convenience only; it never
 * grants access. The backend still filters every list/read by workspace. */
const preferredByWorkspace = new Map();
const PREFERRED_LIMIT = 64;

function claimSession(id) {
  if (!id) return;
  claimedSessions.set(id, (claimedSessions.get(id) || 0) + 1);
}
function releaseSessionClaim(id) {
  if (!id) return;
  const count = (claimedSessions.get(id) || 0) - 1;
  if (count > 0) claimedSessions.set(id, count);
  else claimedSessions.delete(id);
}

export function openTerminalPanel(options = {}) {
  const triggerId = options.triggerId || 'btnTerminal';
  return openSecondarySurface(
    'terminal',
    (host, view) => mountTerminalPanel(host, view, options),
    { label: '终端', headerSelector: '.rp-head', triggerId }
  );
}

export function mountTerminalPanel(host, view, options = {}) {
  host.classList.add('terminal-surface');
  const transport = options.transport || {
    status: fetchTerminalStatus,
    list: listTerminals,
    create: createTerminal,
    start: startTerminal,
    read: readTerminal,
    write: writeTerminal,
    resize: resizeTerminal,
    stop: stopTerminal,
    close: closeTerminal,
  };
  const makeView = options.createTerminalView
    ? async (container) => options.createTerminalView(container)
    : async (container) => (await import('./terminal-xterm.js')).createXtermTerminal(container);

  let alive = true;
  let multi = typeof transport.list === 'function' && typeof transport.create === 'function';
  let limits = null;
  let maxPerWorkspace = Infinity;
  let disabled = false;
  let noProject = false;
  let busy = false;
  let booting = false;
  let emptyKind = null;
  let workspaceId = null;
  let workspaceGeneration = null;
  let activeId = null;
  let createToken = 0;
  let bootToken = 0;
  let scopeSyncToken = 0;
  let scopeSyncTimer = 0;
  let scopeSyncPending = false;
  /* Boot and scope-sync both issue workspace lists. A single sequence number
   * makes a later request supersede an earlier one regardless of which path
   * started it, so a slow boot response cannot append the previous workspace's
   * sessions after a scope sync already switched the panel. */
  let listToken = 0;
  /* A list sampled before a close can still contain that tab. Remember ids the
   * backend has definitively forgotten so a late snapshot cannot resurrect
   * them as dead tabs. The cap only bounds memory for very long sessions. */
  const closedIds = new Set();
  const CLOSED_ID_LIMIT = 256;
  let lastMeasuredSize = null;
  let fitFrame = 0;
  let resizeObserver = null;
  let themeObserver = null;
  let subtitle;
  let control;
  let clearButton;
  let noticeClearTimer = 0;
  const tabs = new Map();
  const order = [];

  const isCurrent = () => alive && (!view || view.isCurrent());
  const activeMeta = () => (activeId ? tabs.get(activeId) || null : null);
  const activeController = () => activeMeta()?.controller || null;

  const clearButtonNode = node('button', 'btn tiny rp-btn', '清屏');
  clearButtonNode.type = 'button';
  clearButtonNode.title = '只清除当前显示，不结束后台终端';
  clearButtonNode.onclick = () => activeController()?.clearScreen();
  clearButton = clearButtonNode;

  control = node('button', 'btn tiny rp-btn', '启动');
  control.type = 'button';
  control.onclick = () => {
    if (disabled) return;
    if (noProject) {
      void boot();
      return;
    }
    const controller = activeController();
    if (!controller) {
      if (emptyKind === 'error' || emptyKind === 'stale') {
        void (multi ? boot() : startLegacy());
        return;
      }
      void createTab();
      return;
    }
    if (busy || controller.busy) return;
    if (controller.isClosing()) return;
    if (controller.isRunning()) {
      void controller.stop().then(() => updateHeader());
      return;
    }
    if (controller.isFinished() || controller.detached) {
      void restartTab(controller.id);
      return;
    }
    void createTab();
  };

  const header = createPaneHeader({ title: '终端', subtitle: '正在检测…', actions: [clearButton, control] });
  subtitle = header.subtitle;
  const headerNode = header.el;
  host.append(headerNode);

  const tabsUi = createTerminalTabs({
    onActivate: (id) => activateTab(id),
    onClose: (id) => { void closeTab(id); },
    onNew: () => { void createTab(); },
  });
  tabsUi.newButton.hidden = !multi;
  host.append(tabsUi.el, tabsUi.notice);

  const termHost = node('div', 'term-host');
  host.append(termHost);
  host.append(tabsUi.empty);

  function setStatus(text, state = 'idle') {
    if (subtitle) subtitle.textContent = text;
    if (headerNode) headerNode.setAttribute('data-state', state);
  }

  function clearNotice() {
    clearTimeout(noticeClearTimer);
    noticeClearTimer = 0;
    tabsUi.setNotice('');
  }

  function showNotice(text, tone = 'info') {
    clearTimeout(noticeClearTimer);
    tabsUi.setNotice(text, tone);
  }

  function clampSize(cols, rows) {
    const bounds = limits || DEFAULT_LIMITS;
    return {
      cols: Math.min(Math.max(Math.trunc(cols), bounds.minCols ?? DEFAULT_LIMITS.minCols), bounds.maxCols ?? DEFAULT_LIMITS.maxCols),
      rows: Math.min(Math.max(Math.trunc(rows), bounds.minRows ?? DEFAULT_LIMITS.minRows), bounds.maxRows ?? DEFAULT_LIMITS.maxRows),
    };
  }

  function rememberActive() {
    if (!workspaceId || !activeId) return;
    preferredByWorkspace.delete(workspaceId);
    preferredByWorkspace.set(workspaceId, activeId);
    while (preferredByWorkspace.size > PREFERRED_LIMIT) {
      preferredByWorkspace.delete(preferredByWorkspace.keys().next().value);
    }
  }

  function preferredForWorkspace() {
    const id = workspaceId ? preferredByWorkspace.get(workspaceId) : null;
    return id && tabs.has(id) ? id : null;
  }

  function tabState(meta) {
    const controller = meta.controller;
    if (controller.busy) return 'creating';
    if (controller.detached) return 'stale';
    return controller.session?.state || 'idle';
  }

  function updateTab(id) {
    const meta = tabs.get(id);
    if (!meta) return;
    tabsUi.update(meta.entry, {
      label: meta.label,
      state: tabState(meta),
      selected: id === activeId,
    });
  }

  function syncNewButton() {
    if (!tabsUi.newButton) return;
    tabsUi.newButton.hidden = !multi;
    if (!multi) return;
    const atCap = Number.isFinite(maxPerWorkspace) && tabs.size >= maxPerWorkspace;
    tabsUi.setNewEnabled(
      !busy && !booting && !scopeSyncPending && !disabled && !noProject && !atCap,
      atCap ? '当前工作区终端数量已达上限' : '新建终端'
    );
  }

  function updateHeader() {
    const controller = activeController();
    if (disabled) {
      setStatus('不可用', 'disabled');
      control.textContent = '不可用';
      control.disabled = true;
      clearButton.disabled = !controller;
      syncNewButton();
      return;
    }
    if (noProject) {
      setStatus('未选择项目', 'idle');
      control.textContent = '重新检测';
      control.disabled = false;
      clearButton.disabled = !controller;
      syncNewButton();
      return;
    }
    if (!controller) {
      const status = emptyKind === 'error' ? ['无法使用终端', 'error']
        : emptyKind === 'stale' ? ['工作区已变化', 'stale'] : ['未运行', 'idle'];
      setStatus(status[0], status[1]);
      control.textContent = emptyKind === 'error' ? '重试' : (multi ? '新建终端' : '启动');
      control.disabled = busy || booting || scopeSyncPending;
      clearButton.disabled = true;
      syncNewButton();
      return;
    }

    const session = controller.session || {};
    if (controller.busy) setStatus('正在启动…', 'starting');
    else if (controller.detached) setStatus('工作区已变化', 'stale');
    else if (session.state === 'running') setStatus(`运行中 · ${session.shell || 'shell'}`, 'running');
    else if (session.state === 'closing' || session.state === 'stopping') setStatus('正在停止…', 'closing');
    else if (session.state === 'error' || session.state === 'failed') setStatus(session.error || '终端不可用', 'error');
    else if (session.state === 'exited') {
      const code = Number.isInteger(session.exitCode) ? ` (${session.exitCode})` : '';
      setStatus(`已退出${code}`, 'exited');
    } else setStatus('未运行', 'idle');

    if (busy || controller.busy) {
      control.textContent = '处理中…';
      control.disabled = true;
    } else if (session.state === 'closing' || session.state === 'stopping') {
      control.textContent = '正在停止…';
      control.disabled = true;
    } else if (session.state === 'running') {
      control.textContent = '停止';
      control.disabled = false;
    } else if (session.state === 'exited' || session.state === 'error' || session.state === 'failed') {
      control.textContent = '重启';
      control.disabled = false;
    } else {
      control.textContent = '启动';
      control.disabled = false;
    }
    clearButton.disabled = !controller.view;
    syncNewButton();
  }

  function showEmpty(kind, { title = '', hint = '', actionLabel = '', onAction = null } = {}) {
    emptyKind = kind;
    if (termHost) termHost.hidden = true;
    tabsUi.setEmpty({ title, hint, actionLabel, onAction });
    updateHeader();
  }

  function hideEmpty() {
    emptyKind = null;
    if (termHost) termHost.hidden = false;
    tabsUi.setEmpty({ hidden: true });
  }

  function showEmptyIfIdle() {
    if (tabs.size) return;
    if (disabled) {
      showEmpty('disabled', {
        title: '终端不可用',
        hint: '终端仅在桌面版可用，或需显式启用。',
      });
      return;
    }
    if (noProject) {
      showEmpty('no-project', {
        title: '未选择项目',
        hint: '先选择一个项目，终端会继承该工作区的目录。',
        actionLabel: '重新检测',
        onAction: () => { void boot(); },
      });
      return;
    }
    showEmpty('none', {
      title: '当前工作区还没有终端',
      hint: '新建的终端会继承当前工作区目录，并保持独立运行。',
      actionLabel: multi ? '新建终端' : '启动',
      onAction: () => { void (multi ? createTab() : startLegacy()); },
    });
  }

  function onControllerState(id) {
    updateTab(id);
    if (id === activeId) updateHeader();
  }

  function activateTab(id, { focus = true } = {}) {
    const meta = tabs.get(id);
    if (!meta) return;
    activeId = id;
    hideEmpty();
    for (const other of tabs.values()) {
      other.controller.show(other.id === id);
      updateTab(other.id);
    }
    tabsUi.activate(id);
    rememberActive();
    updateHeader();
    if (focus) meta.controller.focus();
  }

  function removeTab(id) {
    const meta = tabs.get(id);
    if (!meta) return;
    const index = order.indexOf(id);
    tabs.delete(id);
    if (index >= 0) order.splice(index, 1);
    meta.controller.dispose();
    releaseSessionClaim(id);
    tabsUi.remove(id);
    if (activeId === id) {
      activeId = null;
      const next = order[index] || order[index - 1] || order[0] || null;
      if (next) activateTab(next);
      else {
        updateHeader();
        showEmptyIfIdle();
      }
    } else {
      updateHeader();
    }
  }

  function addSession(session, { slot = null, activate = false, label = null } = {}) {
    if (!session?.id) return null;
    const existing = tabs.get(session.id);
    if (existing) {
      existing.controller.updateSession(session);
      updateTab(session.id);
      if (activate) activateTab(session.id);
      return existing;
    }
    claimSession(session.id);
    const viewId = `term-view-${session.id}`;
    const labelText = label || `终端 ${session.ordinal || order.length + 1}`;
    const entry = tabsUi.add({ id: session.id, label: labelText, viewId, ordinal: session.ordinal });
    const container = slot?.container || node('div', 'term-view');
    container.id = viewId;
    container.setAttribute('role', 'tabpanel');
    container.setAttribute('aria-label', labelText);
    container.hidden = true;
    if (!container.isConnected) termHost.append(container);
    const controller = createTerminalSession({
      session,
      transport,
      createView: makeView,
      clampSize,
      view: slot?.view || null,
      container,
      onState: () => onControllerState(session.id),
      onScopeStale: () => requestScopeSync(),
    });
    if (slot) slot.adopted = true;
    const meta = { id: session.id, label: labelText, viewId, entry, controller, container };
    tabs.set(session.id, meta);
    order.push(session.id);
    updateTab(session.id);
    void controller.mount(container).then((mounted) => {
      if (!alive || tabs.get(session.id) !== meta) return;
      if (!mounted) {
        updateTab(session.id);
        updateHeader();
        return;
      }
      if (activeId === session.id) controller.show(true);
      else controller.show(false);
      updateTab(session.id);
      updateHeader();
    });
    if (activate) activateTab(session.id);
    return meta;
  }

  function createViewSlot() {
    const container = node('div', 'term-view');
    container.hidden = true;
    termHost.hidden = false;
    tabsUi.setEmpty({ hidden: true });
    termHost.append(container);
    return makeView(container).then((view) => {
      if (!alive) {
        try { view?.dispose?.(); } catch { /* noop */ }
        container.remove();
        return null;
      }
      return { container, view, adopted: false };
    }).catch(() => {
      container.remove();
      return null;
    });
  }

  function disposeSlot(slot) {
    if (!slot || slot.adopted) return;
    try { slot.view?.dispose?.(); } catch { /* noop */ }
    slot.container?.remove?.();
  }

  function handleLateSession(result) {
    if (!result?.ok || !result.session?.id) return;
    const id = result.session.id;
    /* A reused session belongs to whoever had it first; one another mount
     * already listed is also safe. Anything else was created by this stale
     * mount only and would otherwise live with no tab. */
    if (result.reused || claimedSessions.has(id)) return;
    if (typeof transport.close === 'function') void transport.close(id);
    else void transport.stop(id);
  }

  function handleOpenFailure(result) {
    const code = result?.code;
    if (code === 'terminal_disabled') {
      disabled = true;
      showEmptyIfIdle();
    } else if (code === 'noProject') {
      noProject = true;
      showEmptyIfIdle();
    } else if (code === 'terminal_limit' || code === 'terminal_stopping') {
      showNotice(result?.error || '终端数量已达上限，请先关闭一个终端。', 'warn');
      if (!tabs.size) showEmpty('error', {
        title: '无法新建终端',
        hint: result?.error || '终端数量已达上限，请先关闭一个终端。',
        actionLabel: '重试',
        onAction: () => { void createTab(); },
      });
    } else if (code === 'stale_workspace' || code === 'unknown_conversation'
      || code === 'workspace_unavailable' || code === 'unknown_workspace' || code === 'unknown_project') {
      showNotice(result?.error || '工作区已经变化。', 'warn');
      requestScopeSync();
    } else if (result?.network) {
      showNotice('无法连接终端服务，请稍后重试。', 'warn');
      if (!tabs.size) showEmpty('error', {
        title: '无法连接终端服务',
        hint: '请确认本地后端仍在运行，然后重试。',
        actionLabel: '重试',
        onAction: () => { void createTab(); },
      });
    } else {
      const message = result?.error || '无法启动终端。';
      showNotice(message, 'error');
      if (!tabs.size) showEmpty('error', {
        title: '启动失败',
        hint: message,
        actionLabel: '重试',
        onAction: () => { void createTab(); },
      });
    }
    updateHeader();
  }

  async function createTab({ size = null, label = null, fromBoot = false, replacingId = null } = {}) {
    if (!alive || busy || disabled || noProject) return null;
    if (!fromBoot && (booting || scopeSyncPending)) return null;
    if (!multi) return startLegacy({ size, atBoot: fromBoot });
    /* A restart still shows the old exited tab while its replacement is being
     * created, but the backend has already freed that slot. */
    const occupied = tabs.size - (replacingId && tabs.has(replacingId) ? 1 : 0);
    if (Number.isFinite(maxPerWorkspace) && occupied >= maxPerWorkspace) {
      showNotice('当前工作区的终端数量已达上限，请先关闭一个终端。', 'warn');
      return null;
    }
    const token = ++createToken;
    busy = true;
    clearNotice();
    updateHeader();
    const slot = await createViewSlot();
    if (!alive || token !== createToken) {
      disposeSlot(slot);
      return null;
    }
    try { slot?.view?.fit?.(); } catch { /* hidden or detached container */ }
    const measured = slot?.view?.getSize?.() || activeController()?.getSize?.() || lastMeasuredSize || DEFAULT_SIZE;
    const requestSize = clampSize(measured.cols, measured.rows);
    lastMeasuredSize = requestSize;
    let result;
    try {
      result = await transport.create(requestSize);
    } catch {
      result = { ok: false, network: true, error: '无法连接终端服务。' };
    }
    if (!alive || token !== createToken) {
      disposeSlot(slot);
      handleLateSession(result);
      return null;
    }
    busy = false;
    if (!result?.ok) {
      disposeSlot(slot);
      handleOpenFailure(result);
      return null;
    }
    if (result.noProject) {
      disposeSlot(slot);
      noProject = true;
      showEmptyIfIdle();
      updateHeader();
      return null;
    }
    const session = result.session;
    if (!session?.id) {
      disposeSlot(slot);
      showNotice('后端没有返回终端会话。', 'error');
      updateHeader();
      return null;
    }
    if (workspaceId && session.workspace?.id && session.workspace.id !== workspaceId) {
      /* The focused workspace changed while the request was in flight. Do not
       * mount the new session into the wrong tab list. */
      disposeSlot(slot);
      handleLateSession(result);
      requestScopeSync();
      updateHeader();
      return null;
    }
    if (!workspaceId && session.workspace?.id) workspaceId = session.workspace.id;
    hideEmpty();
    addSession(session, { slot, activate: true, label });
    updateHeader();
    return session;
  }

  async function startLegacy({ size = null, atBoot = false } = {}) {
    if (!alive || busy || disabled || noProject) return null;
    if (!atBoot && (booting || scopeSyncPending)) return null;
    if (tabs.size) {
      const only = order[0];
      if (only) activateTab(only);
      return null;
    }
    const token = ++createToken;
    busy = true;
    clearNotice();
    updateHeader();
    const slot = await createViewSlot();
    if (!alive || token !== createToken || (atBoot && !isCurrent())) {
      disposeSlot(slot);
      return null;
    }
    try { slot?.view?.fit?.(); } catch { /* hidden */ }
    const measured = slot?.view?.getSize?.() || lastMeasuredSize || DEFAULT_SIZE;
    const requestSize = size || clampSize(measured.cols, measured.rows);
    let result;
    try {
      result = await transport.start(requestSize);
    } catch {
      result = { ok: false, network: true, error: '无法连接终端服务。' };
    }
    if (!alive || token !== createToken) {
      disposeSlot(slot);
      handleLateSession(result);
      return null;
    }
    busy = false;
    if (!result?.ok) {
      disposeSlot(slot);
      handleOpenFailure(result);
      return null;
    }
    if (result.noProject) {
      disposeSlot(slot);
      noProject = true;
      showEmptyIfIdle();
      updateHeader();
      return null;
    }
    const session = result.session;
    if (!session?.id) {
      disposeSlot(slot);
      showNotice('后端没有返回终端会话。', 'error');
      updateHeader();
      return null;
    }
    if (!workspaceId && session.workspace?.id) workspaceId = session.workspace.id;
    hideEmpty();
    addSession(session, { slot, activate: true });
    updateHeader();
    return session;
  }

  /* A close with no definitive answer may leave the PTY running. Removing the
   * tab then would hide a live session and keep it occupying a workspace slot
   * with no UI to retry, so only settle the tab after the backend answers. */
  function closeSettled(result) {
    return Boolean(result?.ok) || CLOSE_SETTLED_CODES.has(result?.code);
  }

  function rememberClosed(id) {
    if (!id) return;
    closedIds.add(id);
    if (closedIds.size > CLOSED_ID_LIMIT) {
      closedIds.delete(closedIds.values().next().value);
    }
  }

  function filterClosedSessions(sessions) {
    return (Array.isArray(sessions) ? sessions : [])
      .filter((session) => session?.id && !closedIds.has(session.id));
  }

  async function restartTab(id) {
    const meta = tabs.get(id);
    if (!meta) return;
    const controller = meta.controller;
    if (!controller.isFinished()) return;
    const size = controller.getSize();
    const label = meta.label;
    let result;
    try {
      result = await controller.close();
    } catch {
      result = { ok: false, network: true };
    }
    if (!alive || !tabs.has(id)) return;
    if (!closeSettled(result)) {
      showNotice(result?.error || '重启终端失败，请重试。', 'error');
      updateHeader();
      return;
    }
    if (result?.ok || result?.code === 'terminal_missing') rememberClosed(id);
    if (multi) {
      /* Keep the old tab until its replacement exists. If a scope sync is in
       * flight, createTab returns null; removing first would leave the user
       * with neither the tab nor a new terminal. */
      const created = await createTab({ size, label, replacingId: id });
      if (!alive || !tabs.has(id)) return;
      if (!created) {
        if (scopeSyncPending) showNotice('工作区正在切换，请稍后再试。', 'warn');
        return;
      }
      removeTab(id);
      return;
    }
    removeTab(id);
    await startLegacy({ size });
  }

  async function closeTab(id) {
    const meta = tabs.get(id);
    if (!meta) return;
    let result;
    try {
      result = await meta.controller.close();
    } catch {
      result = { ok: false, network: true };
    }
    if (!alive || !tabs.has(id)) return;
    if (!closeSettled(result)) {
      showNotice(result?.error || '关闭终端失败，请重试。', 'error');
      updateHeader();
      return;
    }
    if (result?.ok || result?.code === 'terminal_missing') rememberClosed(id);
    removeTab(id);
  }

  function detachTabsForScope() {
    createToken++;
    busy = false;
    clearNotice();
    for (const meta of [...tabs.values()]) {
      meta.controller.dispose();
      releaseSessionClaim(meta.id);
      tabsUi.remove(meta.id);
    }
    tabs.clear();
    order.length = 0;
    activeId = null;
    termHost.hidden = false;
    tabsUi.setEmpty({ hidden: true });
  }

  function reconcileSessions(sessions, { removable = null } = {}) {
    const incoming = new Map(filterClosedSessions(sessions).map((session) => [session.id, session]));
    for (const id of [...tabs.keys()]) {
      const session = incoming.get(id);
      if (!session) {
        /* A restart whose replacement was deferred by an in-flight scope sync
         * keeps its old exited tab. Its backend is already closed, so the
         * filtered list will never contain it; keep that retry affordance. */
        if (closedIds.has(id)) continue;
        /* Only remove tabs that existed when this list was requested. A tab
         * created while the request was in flight is absent from the older
         * snapshot; removing it would hide a live PTY and leave it occupying a
         * slot with no way to close it from the UI. */
        if (!removable || removable.has(id)) removeTab(id);
        continue;
      }
      const meta = tabs.get(id);
      meta.controller.updateSession(session);
      if (meta.controller.detached) meta.controller.reattach();
      updateTab(id);
    }
    for (const session of incoming.values()) {
      if (!tabs.has(session.id)) addSession(session, { activate: false });
    }
    if (!tabs.size) {
      activeId = null;
      updateHeader();
      showEmptyIfIdle();
      return;
    }
    if (!activeId || !tabs.has(activeId)) {
      activateTab(preferredForWorkspace() || order.at(-1), { focus: false });
    } else {
      updateHeader();
    }
  }

  function applyWorkspaceSessions(sessions, { autoCreate = false } = {}) {
    const list = filterClosedSessions(sessions);
    if (list.length) {
      hideEmpty();
      for (const session of list) addSession(session, { activate: false });
      activateTab(preferredForWorkspace() || order.at(-1));
      updateHeader();
      return;
    }
    activeId = null;
    if (autoCreate) {
      void createTab({ fromBoot: true });
      return;
    }
    showEmptyIfIdle();
  }

  function handleListFailure(result, { autoCreate = false } = {}) {
    const code = result?.code;
    if (code === 'terminal_disabled') {
      disabled = true;
      showEmptyIfIdle();
      return;
    }
    if (code === 'unknown_conversation' || code === 'workspace_unavailable'
      || code === 'stale_workspace' || code === 'unknown_workspace' || code === 'unknown_project') {
      detachTabsForScope();
      workspaceId = null;
      showEmpty('error', {
        title: '工作区不可用',
        hint: result?.error || '当前工作区已经失效。',
        actionLabel: '重试',
        onAction: () => { requestScopeSync({ force: true }); },
      });
      return;
    }
    const message = result?.network ? '无法连接终端服务，请稍后重试。' : (result?.error || '无法读取终端列表。');
    showNotice(message, 'warn');
    if (!tabs.size) {
      showEmpty('error', {
        title: autoCreate ? '无法启动终端' : '无法读取终端列表',
        hint: message,
        actionLabel: '重试',
        onAction: () => { void boot(); },
      });
    }
    updateHeader();
  }

  async function loadWorkspace(token, { autoCreate = false } = {}) {
    const listSeq = ++listToken;
    let result;
    try { result = await transport.list(); } catch { result = { ok: false, network: true }; }
    if (!alive || token !== bootToken || listSeq !== listToken) return;
    /* This boot list is now the newest workspace request. It may have
     * superseded a scope-sync list whose response will be discarded before it
     * can clear the pending flag; clear it here or the New/Restart controls
     * stay disabled forever. */
    scopeSyncPending = false;
    if (!result?.ok) {
      if (result?.code === 'invalid_action') {
        multi = false;
        tabsUi.newButton.hidden = true;
        await startLegacy({ atBoot: true });
        return;
      }
      handleListFailure(result, { autoCreate });
      return;
    }
    if (result.noProject) {
      detachTabsForScope();
      workspaceId = null;
      noProject = true;
      showEmptyIfIdle();
      return;
    }
    noProject = false;
    workspaceId = result.workspace?.id || null;
    workspaceGeneration = result.workspace?.generation ?? null;
    applyWorkspaceSessions(result.sessions, { autoCreate });
  }

  async function runScopeSync(token) {
    if (!alive || token !== scopeSyncToken) return;
    if (!multi) {
      scopeSyncPending = false;
      detachTabsForScope();
      workspaceId = null;
      setStatus('工作区已变化', 'stale');
      showEmpty('stale', {
        title: '工作区已变化',
        hint: '点击启动会在当前工作区打开一个终端。',
        actionLabel: '启动',
        onAction: () => { void startLegacy(); },
      });
      return;
    }
    const listSeq = ++listToken;
    const localIds = new Set(tabs.keys());
    let result;
    try { result = await transport.list(); } catch { result = { ok: false, network: true }; }
    if (!alive || token !== scopeSyncToken || listSeq !== listToken) return;
    scopeSyncPending = false;
    if (!result?.ok) {
      if (result?.code === 'terminal_disabled') {
        disabled = true;
        detachTabsForScope();
        showEmptyIfIdle();
        return;
      }
      if (result?.code === 'unknown_conversation' || result?.code === 'workspace_unavailable'
        || result?.code === 'stale_workspace' || result?.code === 'unknown_workspace'
        || result?.code === 'unknown_project') {
        detachTabsForScope();
        workspaceId = null;
        showEmpty('error', {
          title: '工作区不可用',
          hint: result?.error || '当前工作区已经失效。',
          actionLabel: '重试',
          onAction: () => { requestScopeSync({ force: true }); },
        });
        return;
      }
      showNotice(result?.network ? '无法连接终端服务，请稍后重试。' : (result?.error || '无法读取终端列表。'), 'warn');
      updateHeader();
      return;
    }
    if (result.noProject) {
      detachTabsForScope();
      workspaceId = null;
      noProject = true;
      showEmptyIfIdle();
      return;
    }
    noProject = false;
    const nextWorkspace = result.workspace?.id || null;
    const sessions = Array.isArray(result.sessions) ? result.sessions : [];
    if (workspaceId && nextWorkspace === workspaceId && tabs.size) {
      reconcileSessions(sessions, { removable: localIds });
      return;
    }
    detachTabsForScope();
    workspaceId = nextWorkspace;
    workspaceGeneration = result.workspace?.generation ?? null;
    applyWorkspaceSessions(sessions, { autoCreate: false });
  }

  function requestScopeSync({ force = false } = {}) {
    if (!alive || disabled) return;
    const token = ++scopeSyncToken;
    /* Invalidate any list already in flight as soon as a scope change is
     * requested, not when the debounced request starts. Otherwise a boot/list
     * response for the old workspace could land in the gap and be applied. */
    listToken++;
    scopeSyncPending = true;
    if (force) detachTabsForScope();
    clearTimeout(scopeSyncTimer);
    scopeSyncTimer = setTimeout(() => { void runScopeSync(token); }, 0);
  }

  async function boot() {
    if (!alive) return;
    const token = ++bootToken;
    scopeSyncToken++;
    listToken++;
    scopeSyncPending = false;
    clearTimeout(scopeSyncTimer);
    detachTabsForScope();
    disabled = false;
    noProject = false;
    busy = false;
    booting = true;
    workspaceId = null;
    workspaceGeneration = null;
    emptyKind = null;
    setStatus('正在检测…', 'starting');
    updateHeader();
    try {
      let result;
      try { result = await transport.status(); } catch { result = { ok: false, network: true }; }
      if (!alive || token !== bootToken) return;
      if (!result?.ok) {
        showEmpty('error', {
          title: '无法检测终端状态',
          hint: result?.network ? '无法连接终端服务。' : (result?.error || '终端暂时不可用。'),
          actionLabel: '重试',
          onAction: () => { void boot(); },
        });
        return;
      }
      if (!result.enabled) {
        disabled = true;
        showEmptyIfIdle();
        return;
      }
      disabled = false;
      limits = result.limits && typeof result.limits === 'object' ? result.limits : null;
      maxPerWorkspace = Number.isSafeInteger(result.maxSessionsPerWorkspace) ? result.maxSessionsPerWorkspace : Infinity;
      if (!multi) {
        tabsUi.newButton.hidden = true;
        await startLegacy({ atBoot: true });
        return;
      }
      await loadWorkspace(token, { autoCreate: true });
    } finally {
      if (alive && token === bootToken) {
        booting = false;
        updateHeader();
      }
    }
  }

  function scheduleFit() {
    if (!isCurrent() || fitFrame) return;
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      if (!isCurrent()) return;
      activeController()?.fit();
    });
  }

  function installWatchers() {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(scheduleFit);
      resizeObserver.observe(host);
    }
    window.addEventListener('resize', scheduleFit);
    const fontsReady = document.fonts?.ready;
    if (fontsReady && typeof fontsReady.then === 'function') {
      fontsReady.then(() => scheduleFit()).catch(() => {});
    }
  }

  function installThemeWatcher() {
    if (typeof MutationObserver === 'undefined') return;
    themeObserver = new MutationObserver(() => {
      for (const meta of tabs.values()) meta.controller.refreshTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-preference'] });
  }

  function onWorkspaceEvent() {
    requestScopeSync({ force: true });
  }

  function onGitScope() {
    /* Do not drop a newer scope event just because an older list is in flight;
     * requestScopeSync bumps the token, so the older response is discarded. */
    requestScopeSync();
  }

  document.addEventListener('pi-gui:workspace-generation', onWorkspaceEvent);
  document.addEventListener('pi-gui:git-scope', onGitScope);

  view.onDispose(() => {
    alive = false;
    bootToken++;
    createToken++;
    scopeSyncToken++;
    clearTimeout(scopeSyncTimer);
    clearTimeout(noticeClearTimer);
    noticeClearTimer = 0;
    if (fitFrame) cancelAnimationFrame(fitFrame);
    fitFrame = 0;
    document.removeEventListener('pi-gui:workspace-generation', onWorkspaceEvent);
    document.removeEventListener('pi-gui:git-scope', onGitScope);
    window.removeEventListener('resize', scheduleFit);
    resizeObserver?.disconnect();
    resizeObserver = null;
    themeObserver?.disconnect();
    themeObserver = null;
    detachTabsForScope();
  });

  updateHeader();
  void boot();
  installWatchers();
  installThemeWatcher();
}
