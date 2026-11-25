import { createIcon } from './icons.js';
import { S } from '../state.js';
import { openActionMenu, closeActionMenu } from './action-menu.js';
import { mountWorkPanelLauncher } from './work-panel-launcher.js';

/* A tab owns one live Surface, not one visible mount. The pane owns geometry
 * and visibility only. Business owners retain their own requests and resources.
 * In particular isCurrent() is an identity/liveness guard, NOT a visibility
 * guard; owners can opt into onVisibility() for expensive visible work. */
const TABS_KEY = 'pi-gui:secondary-tabs:v1';
const PANE_STATE_KEY = 'pi-gui:secondary-pane-state:v2';
const TAB_LIMIT = 16;
const SCOPE_LIMIT = 8;
const RESTORABLE = new Set(['changes', 'specs']);
const tools = new Map();
const toolListeners = new Set();
let pane = null;
let scopeReader = () => String(S.workspaceGeneration || 0);
let identityReader = null;
let scope = null;
let identity = null;
let serial = 0;
let selected = null;
let draggedId = null;
let tabs = [];
let unsubPane = null;
let explicitRestore = null;
let restoring = false;
let backgroundMount = false;
/* Layout dependencies outlive the current presentation: a child may move back
 * to its standalone tab or into another split while layouts still borrow it.
 * Every borrow is recorded persistently on the child (borrowOwners) and only
 * the dependent layout's own disposal removes it, so closing the child can
 * always retire the layouts it still backs — even while it stands alone. */
function dependentOf(instance) { return tabs.find(tab => tab.instance === instance && tabs.includes(tab)) || null; }
function dependentUses(tab) {
  if (!tab.borrowOwners) return [];
  return tabs.filter(item => item !== tab && tab.borrowOwners.has(item.instance));
}
const presentation = tab => tab.borrower ? dependentOf(tab.borrower) || tab : tab;

function readMap(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 262144) return new Map();
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return new Map();
    return new Map(value.filter(row => Array.isArray(row) && typeof row[0] === 'string').slice(-SCOPE_LIMIT));
  } catch { return new Map(); }
}
function writeMap(key, values) {
  while (values.size > SCOPE_LIMIT) values.delete(values.keys().next().value);
  try { sessionStorage.setItem(key, JSON.stringify([...values])); } catch { /* Storage is optional. */ }
}
function scopeNow(event) { return String(scopeReader(event) ?? ''); }
function identityNow(event) { return identityReader ? String(identityReader(event) ?? '') : scopeNow(event); }
function available(tool) { return tool && (typeof tool.available !== 'function' || tool.available()); }
function toolFor(view) { return [...tools.values()].find(tool => tool.id === view || tool.views?.includes(view)); }
function recordFor(id) {
  return tabs.find(tab => tab.id === id || tab.view === id || (toolFor(id) && toolFor(tab.view)?.id === toolFor(id).id));
}
function notifyTools() { for (const fn of toolListeners) fn(); }

export function registerSecondaryTool(tool) {
  if (!tool || typeof tool.id !== 'string' || typeof tool.open !== 'function') throw new Error('Surface tool requires id and open');
  tools.set(tool.id, { ...tool });
  notifyTools();
  return () => { if (tools.get(tool.id)?.open === tool.open) { tools.delete(tool.id); notifyTools(); } };
}
export function secondaryTools() { return [...tools.values()].filter(available).map(tool => ({ ...tool })); }
export function refreshSecondaryTools() { notifyTools(); }
export function openSecondaryTool(id) {
  const tool = tools.get(id);
  if (!available(tool) || (typeof tool.disabled === 'function' ? tool.disabled() : tool.disabled)) return null;
  ensureScope();
  // Run only the real owner action. No hidden source buttons, capability
  // observers or copied shortcut dispatch exist in the Launcher.
  return tool.open();
}

function rememberTabs() {
  if (scope === null || restoring) return;
  const values = readMap(TABS_KEY);
  const descriptors = tabs.map(tab => ({ id: tab.id, view: toolFor(tab.view)?.id || tab.view }))
    .filter(tab => tab.view === 'work-tools' || tools.has(tab.view)).slice(0, TAB_LIMIT);
  values.delete(scope);
  values.set(scope, { tabs: descriptors, active: selected?.id || null });
  writeMap(TABS_KEY, values);
}

/* Retained compatibility for Changes/Specs' small, owner-validated scroll and
 * expansion state. This store is scoped too; it never holds preview payloads,
 * grants, URLs, native ids or PTY ids. */
export function readPaneState(view) {
  return readMap(PANE_STATE_KEY).get(scope ?? scopeNow())?.[view] || null;
}
export function writePaneState(view, state) {
  if (!RESTORABLE.has(view)) return;
  const values = readMap(PANE_STATE_KEY), key = scope ?? scopeNow();
  const saved = { ...(values.get(key) || {}) };
  if (state) saved[view] = state;
  else delete saved[view];
  values.delete(key); values.set(key, saved); writeMap(PANE_STATE_KEY, values);
}
export function clearPaneState(view) {
  const values = readMap(PANE_STATE_KEY), key = scope ?? scopeNow();
  if (!view) values.delete(key);
  else { const saved = { ...(values.get(key) || {}) }; delete saved[view]; values.set(key, saved); }
  writeMap(PANE_STATE_KEY, values);
}
export function readRestoredSurface() {
  const view = explicitRestore || (pane?.isOpen() ? selected?.view : null);
  return RESTORABLE.has(view) ? view : null;
}
export function writeRestoredSurface(view) { explicitRestore = RESTORABLE.has(view) ? view : null; }
export function clearRestoredSurface() { explicitRestore = null; }

function retire(tab, reason = 'close') {
  const instance = tab.instance;
  if (instance && !instance.disposed) {
    instance.disposeReason = reason;
    instance.disposed = true;
    updateVisibility(tab);
    for (const fn of [...tab.disposers].reverse()) {
      try { fn(); } catch { /* One failing owner must not strand the other resources. */ }
    }
    tab.disposers.clear(); tab.visibility.clear();
  }
  if (tab.select.getAttribute('aria-expanded') === 'true') closeActionMenu({ restoreFocus: false });
  tab.host.remove(); tab.el.remove();
}
function ensureScope(event, force = false) {
  const next = scopeNow(event), nextIdentity = identityNow(event);
  if (!force && scope === next && identity === nextIdentity) return;
  rememberTabs();
  // Retire before changing scope: onDispose state snapshots still belong to
  // their captured old scope, never to the newly focused conversation.
  for (const tab of [...tabs]) retire(tab, 'scope');
  tabs = []; selected = null; scope = next; identity = nextIdentity; explicitRestore = null;
  renderTabs();
}
export function syncSecondaryScope(event) {
  if (!pane) return;
  const hard = ['pi-gui:workspace-generation', 'pi-gui:session-switch'].includes(event?.type);
  const previous = scope, previousIdentity = identity;
  ensureScope(event, hard);
  if (hard || previous !== scope || previousIdentity !== identity) {
    // Reconstruct descriptors lazily, never replay an old payload or implicitly
    // open a Browser / start a PTY during an identity transition.
    restoreSecondaryTabs({ reveal: false });
    if (pane.isOpen()) {
      if (!tabs.length) newSecondaryLauncher({ focus: false });
      else activateRecord(selected || tabs[0], { lazy: true });
    }
  }
}

function updateVisibility(tab) {
  const visible = Boolean(tab.instance?.isCurrent() && presentation(tab) === selected && pane?.isOpen() && !tab.host.closest('[hidden]'));
  if (visible === tab.visible) return;
  tab.visible = visible;
  for (const fn of [...tab.visibility]) {
    try { fn(visible); } catch { /* Isolate visibility subscribers, as with disposers. */ }
  }
}
function syncVisibility() {
  for (const tab of tabs) {
    tab.host.hidden = presentation(tab) !== selected;
    tab.select.setAttribute('aria-selected', String(tab === selected));
    tab.select.tabIndex = tab === selected ? 0 : -1;
  }
  // All DOM visibility is committed before notifying any owner.
  for (const tab of tabs) updateVisibility(tab);
  pane?.refresh?.();
}
function renderTabs() {
  const host = pane?.root.querySelector('#workPanelTabs');
  if (!host) return;
  const focused = document.activeElement;
  for (const tab of tabs) host.append(tab.el);
  // Moving an existing focused node with append can drop focus to body. This
  // applies to reordering and even to closing an unrelated inactive tab.
  if (focused?.isConnected && host.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
  const add = pane.root.querySelector('#workPanelNew');
  if (add) add.disabled = tabs.length >= TAB_LIMIT;
}
function focusRecord(tab) {
  if (!tab) return;
  tab.select.focus();
  tab.select.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
function activateRecord(tab, { focus = false, lazy = false } = {}) {
  if (!tab || !tabs.includes(tab)) return null;
  if (backgroundMount) return tab.instance;
  if (tab.borrower) {
    // Standing alone ends the presentation, never the layout dependency: the
    // persistent borrowOwners record stays, so closing this child still retires
    // every layout that borrows it.
    tab.borrower = null;
    pane.root.querySelector('.rp-body').append(tab.host);
  }
  selected = tab;
  if (!lazy && !tab.instance) {
    if (tab.view === 'work-tools') mountLauncher(tab, false);
    else {
      const tool = toolFor(tab.view);
      if (available(tool)) tool.open();
    }
    // First mount is still the same explicit tab activation. Owners may return
    // booleans instead of the Surface; focus belongs to this actual record, so
    // the explicit focus intent must not die with this early return.
    if (!tabs.includes(tab) || selected !== tab) {
      if (focus) focusRecord(tab);
      return tab.instance;
    }
  }
  syncVisibility();
  pane.open(tab.view);
  syncVisibility();
  if (focus) focusRecord(tab);
  tab.select.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  rememberTabs();
  return tab.instance;
}
export function activateSecondarySurface(id, options) {
  ensureScope();
  return activateRecord(recordFor(id), options);
}
export function secondaryTabs() {
  return tabs.map(tab => ({ id: tab.id, view: tab.view, label: tab.label, active: tab === selected, mounted: Boolean(tab.instance) }));
}
export function moveSecondarySurface(id, beforeId = null) {
  const tab = recordFor(id), before = beforeId ? recordFor(beforeId) : null;
  if (!tab || tab === before || (beforeId && !before)) return false;
  tabs.splice(tabs.indexOf(tab), 1);
  tabs.splice(before ? tabs.indexOf(before) : tabs.length, 0, tab);
  renderTabs(); rememberTabs(); return true;
}
export function closeSecondarySurface(id = selected?.id) {
  const tab = recordFor(id);
  if (!tab) return false;
  // Layout dependencies outlive the current presentation: a child may have
  // returned to its standalone tab, or moved to another split in the meantime.
  // Retire every dependent layout first; surviving sibling owners stay alive.
  for (const dependent of dependentUses(tab)) closeSecondarySurface(dependent.id);
  const index = tabs.indexOf(tab), hadFocus = tab.host.contains(document.activeElement) || tab.el.contains(document.activeElement);
  const wasSelected = selected === tab;
  tabs.splice(index, 1);
  if (wasSelected) selected = tabs[Math.min(index, tabs.length - 1)] || null;
  retire(tab);
  if (!tabs.length) pane.close();
  else if (wasSelected) activateRecord(selected, { lazy: !selected.instance });
  else syncVisibility();
  if (hadFocus && selected && pane.isOpen()) focusRecord(selected);
  renderTabs(); rememberTabs(); return true;
}
function closeMany(predicate) {
  // Compute once: both the requested close set and the retained dependency
  // closure are stable even if disposing another layout moves a shared host.
  // Protection runs layout → borrowed children only: a retained split is half
  // dead without its children, so they survive even when the predicate names
  // them. Dependent layouts are ordinary closeable tabs instead — closing one
  // returns the shared host, it never strands the retained child.
  const closing = tabs.filter(predicate), retained = new Set();
  const borrowedBy = layout => tabs.filter(child => child.borrowOwners?.has(layout.instance));
  const retain = tab => {
    if (!tab || retained.has(tab)) return;
    retained.add(tab);
    for (const child of borrowedBy(tab)) retain(child);
  };
  for (const tab of tabs) if (!predicate(tab)) retain(tab);
  for (const tab of closing) if (!retained.has(tab) && tabs.includes(tab)) closeSecondarySurface(tab.id);
}
function tabMenu(tab) {
  const index = tabs.indexOf(tab);
  const run = action => () => { if (tabs.includes(tab)) action(); };
  openActionMenu(tab.select, [
    { label: '关闭标签页', onClick: run(() => closeSecondarySurface(tab.id)) },
    { label: '关闭其它标签页', disabled: tabs.length < 2, onClick: run(() => closeMany(other => other !== tab)) },
    { label: '关闭右侧标签页', disabled: index === tabs.length - 1, onClick: run(() => { const ids = new Set(tabs.slice(tabs.indexOf(tab) + 1)); closeMany(other => ids.has(other)); }) },
    { separator: true },
    { label: '关闭全部标签页', onClick: run(() => closeMany(() => true)) },
  ]);
}
function titleTab(tab, view, label) {
  tab.view = view;
  tab.label = toolFor(view)?.label || label || view;
  tab.labelNode.textContent = tab.label;
  tab.select.title = tab.label;
  tab.select.setAttribute('aria-label', tab.label);
  tab.close.setAttribute('aria-label', `关闭${tab.label}标签页`);
  tab.icon.replaceChildren(createIcon(toolFor(view)?.icon || (view === 'work-tools' ? 'plus' : 'panel')));
  tab.host.setAttribute('aria-label', tab.label);
  tab.el.dataset.surface = view;
}
function createRecord(view, label) {
  if (tabs.length >= TAB_LIMIT) return null;
  const id = `surface-${++serial}`;
  const host = document.createElement('section');
  host.id = `${id}-panel`; host.className = 'rp-surface secondary-surface';
  host.setAttribute('role', 'tabpanel'); host.setAttribute('aria-labelledby', `${id}-tab`); host.tabIndex = -1; host.hidden = true;
  const el = document.createElement('div'); el.className = 'work-surface-tab'; el.draggable = true; el.dataset.tabId = id;
  const select = document.createElement('button'); select.type = 'button'; select.id = `${id}-tab`;
  select.className = 'work-surface-tab-select'; select.setAttribute('role', 'tab'); select.setAttribute('aria-controls', host.id);
  const icon = document.createElement('span'); icon.className = 'work-surface-tab-icon'; icon.setAttribute('aria-hidden', 'true');
  const labelNode = document.createElement('span'); labelNode.className = 'work-surface-tab-label'; select.append(icon, labelNode);
  const close = document.createElement('button'); close.type = 'button'; close.className = 'icon-btn work-surface-tab-close'; close.tabIndex = -1; close.append(createIcon('close'));
  el.append(select, close);
  const tab = { id, view, host, el, select, close, icon, labelNode, label, instance: null, disposers: new Set(), visibility: new Set(), visible: false };
  titleTab(tab, view, label);
  const open = document.createElement('button'); open.type = 'button'; open.className = 'btn ghost surface-resume';
  open.textContent = view === 'work-tools' ? '打开工具' : `打开${tab.label}`;
  open.onclick = () => activateRecord(tab);
  host.append(open);
  select.onclick = () => activateRecord(tab, { focus: true });
  close.onclick = () => closeSecondarySurface(id);
  select.oncontextmenu = event => { event.preventDefault(); tabMenu(tab); };
  select.onkeydown = event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.isComposing) return;
    const index = tabs.indexOf(tab);
    if (event.altKey) {
      if (!event.shiftKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Home') moveSecondarySurface(id, tabs[0].id);
      else if (event.key === 'End') moveSecondarySurface(id);
      else if (event.key === 'ArrowLeft' && index > 0) moveSecondarySurface(id, tabs[index - 1].id);
      else if (event.key === 'ArrowRight' && index < tabs.length - 1) moveSecondarySurface(id, tabs[index + 2]?.id || null);
      focusRecord(tab); return;
    }
    let target;
    if (event.key === 'ArrowLeft') target = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length];
    else if (event.key === 'Home') target = tabs[0];
    else if (event.key === 'End') target = tabs.at(-1);
    else if (event.key === 'Delete') { event.preventDefault(); closeSecondarySurface(id); return; }
    else if (event.key === 'F10' && event.shiftKey) { event.preventDefault(); tabMenu(tab); return; }
    else return;
    event.preventDefault(); activateRecord(target, { focus: true });
  };
  el.onauxclick = event => { if (event.button === 1) { event.preventDefault(); closeSecondarySurface(id); } };
  el.ondragstart = event => {
    if (event.target?.closest('.work-surface-tab-close')) { event.preventDefault(); return; }
    draggedId = id; event.dataTransfer?.setData('text/plain', id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  };
  el.ondragend = () => { draggedId = null; };
  el.ondragover = event => { if (draggedId && recordFor(draggedId)) event.preventDefault(); };
  el.ondrop = event => {
    if (!draggedId || !recordFor(draggedId)) return;
    event.preventDefault();
    const rect = el.getBoundingClientRect(), next = tabs[tabs.indexOf(tab) + 1];
    moveSecondarySurface(draggedId, event.clientX > rect.left + rect.width / 2 ? next?.id || null : id);
    draggedId = null;
  };
  tabs.push(tab); pane.root.querySelector('.rp-body').append(host); renderTabs();
  return tab;
}
function attachInstance(tab, mount) {
  const capturedScope = scope, capturedIdentity = identity;
  tab.host.replaceChildren();
  const instance = {
    view: tab.view, token: ++serial, host: tab.host, disposed: false, restored: tab.restored === true,
    isCurrent: () => !instance.disposed && scope === capturedScope && scopeNow() === capturedScope
      && identity === capturedIdentity && identityNow() === capturedIdentity && tabs.includes(tab),
    isVisible: () => instance.isCurrent() && presentation(tab) === selected && pane.isOpen() && !tab.host.closest('[hidden]'),
    onVisibility(fn) {
      if (typeof fn !== 'function' || instance.disposed) return () => {};
      tab.visibility.add(fn); fn(instance.isVisible()); return () => tab.visibility.delete(fn);
    },
    onDispose(fn) {
      if (typeof fn !== 'function') return () => {};
      if (instance.disposed) { fn(); return () => {}; }
      tab.disposers.add(fn); return () => tab.disposers.delete(fn);
    },
    activate: () => instance.isCurrent() ? activateRecord(tab) : null,
    close: () => { if (instance.isCurrent()) closeSecondarySurface(tab.id); },
    dispose: () => { if (!instance.disposed) closeSecondarySurface(tab.id); },
  };
  tab.instance = instance;
  if (!backgroundMount) {
    selected = tab;
    syncVisibility(); pane.open(tab.view); syncVisibility();
  }
  try { mount(tab.host, instance); }
  catch (error) { closeSecondarySurface(tab.id); throw error; }
  return instance;
}

export function openSecondarySurface(view, mount, { label = '文件变更', replace = false } = {}) {
  if (!pane) throw new Error('Right pane not configured');
  ensureScope();
  let tab = recordFor(view);
  const focused = document.activeElement;
  // Only a trigger whose own Launcher/replaced host will disappear needs a
  // successor. Programmatic/background opens never acquire this focus intent.
  // The reuse branch hides that focused Launcher without mounting anything, so
  // the handoff applies to activation-only reuse exactly as to conversion.
  const handoff = !backgroundMount && ((selected?.view === 'work-tools' && selected.host.contains(focused))
    || (tab?.instance && (replace || view === 'viz') && (tab.host.contains(focused) || tab.el.contains(focused))));
  // Viz is a content-intent API: another chart explicitly replaces that one
  // Surface's payload, but never disposes the other open tools.
  if (tab?.instance && !replace && view !== 'viz') {
    const instance = activateRecord(tab, { focus: handoff });
    if (handoff && tab.instance === instance) focusRecord(tab);
    return instance;
  }
  if (tab?.instance) {
    const position = tabs.indexOf(tab);
    tabs.splice(position, 1); retire(tab);
    const replacement = createRecord(view, label);
    if (!replacement) return null;
    tabs.splice(tabs.indexOf(replacement), 1); tabs.splice(position, 0, replacement); tab = replacement;
  }
  if (!tab && !backgroundMount && selected?.view === 'work-tools' && view !== 'work-tools') {
    tab = selected;
    // Convert only this empty Launcher; no already-open Surface is overwritten.
    const position = tabs.indexOf(tab);
    tabs.splice(position, 1); retire(tab);
    tab = createRecord(view, label);
    tabs.splice(tabs.indexOf(tab), 1); tabs.splice(position, 0, tab);
  }
  if (!tab) tab = createRecord(view, label);
  if (!tab) return null;
  titleTab(tab, view, label);
  const instance = attachInstance(tab, mount);
  renderTabs();
  if (handoff && instance?.isVisible()) focusRecord(tab);
  rememberTabs(); return instance;
}

// Split is a layout of existing singletons, never a second mount of Changes,
// Specs or Browser. Borrowing moves the same host and returns it on disposal.
export function ensureSecondaryTool(id, open = () => openSecondaryTool(id)) {
  ensureScope();
  const previous = backgroundMount; backgroundMount = true;
  try { return recordFor(id)?.instance || open(); }
  finally { backgroundMount = previous; }
}
export function ensureSecondarySurface(view, mount, options) {
  const previous = backgroundMount; backgroundMount = true;
  try { return openSecondarySurface(view, mount, options); }
  finally { backgroundMount = previous; }
}
export function secondarySurfaceInstance(view) { return recordFor(view)?.instance || null; }
export function borrowSecondarySurface(view, target, owner) {
  const tab = recordFor(view);
  if (!tab?.instance?.isCurrent() || !owner?.isCurrent()) return false;
  tab.borrower = owner; target.append(tab.host); syncVisibility();
  tab.borrowOwners ||= new Set();
  if (!tab.borrowOwners.has(owner)) {
    // The dependency record is persistent: only the dependent layout's disposal
    // removes it. Moving the host back to its standalone tab never does.
    tab.borrowOwners.add(owner);
    const off = owner.onVisibility(() => {
      if (tab.borrower === owner) { tab.host.hidden = presentation(tab) !== selected; updateVisibility(tab); }
    });
    owner.onDispose(() => {
      off(); tab.borrowOwners.delete(owner);
      if (tab.borrower !== owner) return;
      tab.borrower = null;
      if (tab.instance.isCurrent()) { pane.root.querySelector('.rp-body').append(tab.host); syncVisibility(); }
    });
  }
  return true;
}
export function newSecondaryLauncher({ focus = true } = {}) {
  if (!pane) return null;
  ensureScope();
  const tab = createRecord('work-tools', '打开工具');
  if (!tab) return null;
  const instance = mountLauncher(tab, focus);
  rememberTabs(); return instance;
}
function mountLauncher(tab, focus) {
  return attachInstance(tab, (host, view) => {
    host.classList.add('work-tools-surface');
    const dispose = mountWorkPanelLauncher(host, secondaryTools, {
      open: openSecondaryTool,
      subscribe(fn) { toolListeners.add(fn); return () => toolListeners.delete(fn); },
      onEscape: () => pane.close(),
    });
    view.onDispose(dispose);
    if (focus) queueMicrotask(() => { if (view.isVisible()) host.querySelector('button:not([hidden]):not(:disabled)')?.focus(); });
  });
}
export function showSecondaryPane() {
  ensureScope();
  if (!tabs.length) restoreSecondaryTabs({ reveal: false });
  if (!tabs.length) return newSecondaryLauncher();
  return activateRecord(selected || tabs[0]);
}
export function restoreSecondaryTabs({ reveal = false } = {}) {
  if (!pane || tabs.length) return;
  ensureScope();
  const saved = readMap(TABS_KEY).get(scope);
  if (!saved || !Array.isArray(saved.tabs)) return;
  restoring = true;
  try {
    const seen = new Set();
    for (const descriptor of saved.tabs.slice(0, TAB_LIMIT)) {
      const view = descriptor?.view;
      if (view !== 'work-tools' && (!available(tools.get(view)) || seen.has(view))) continue;
      seen.add(view);
      const tab = createRecord(view, view === 'work-tools' ? '打开工具' : tools.get(view).label);
      tab.restored = true;
      if (descriptor.id === saved.active) selected = tab;
    }
    selected ||= tabs[0] || null;
    syncVisibility();
    if (reveal && selected) activateRecord(selected);
  } finally { restoring = false; }
}

export function configureSecondaryPane(nextPane, { getScope, getIdentity } = {}) {
  for (const tab of [...tabs]) retire(tab, 'scope');
  tabs = []; selected = null; unsubPane?.(); pane = nextPane;
  scopeReader = typeof getScope === 'function' ? getScope : () => String(S.workspaceGeneration || 0);
  identityReader = typeof getIdentity === 'function' ? getIdentity : null;
  scope = scopeNow(); identity = identityNow();
  if (!pane) return;
  const onPane = () => {
    clearRestoredSurface(); syncVisibility();
    const maximize = pane.root.querySelector('#workPanelMaximize');
    if (maximize) {
      const expanded = Boolean(pane.isMaximized?.());
      maximize.setAttribute('aria-pressed', String(expanded));
      maximize.setAttribute('aria-label', expanded ? '还原工作面板' : '最大化工作面板');
      maximize.title = maximize.getAttribute('aria-label');
      maximize.replaceChildren(createIcon(expanded ? 'copy' : 'external'));
    }
  };
  document.addEventListener('pi-gui:right-pane', onPane);
  const onScope = event => syncSecondaryScope(event);
  const events = ['pi-gui:workspace-generation', 'pi-gui:session-switch', 'pi-gui:git-scope', 'pi-gui:session-evidence-context'];
  for (const event of events) document.addEventListener(event, onScope, true);
  unsubPane = () => {
    document.removeEventListener('pi-gui:right-pane', onPane);
    for (const event of events) document.removeEventListener(event, onScope, true);
  };
  const add = pane.root.querySelector('#workPanelNew');
  if (add) add.onclick = () => newSecondaryLauncher();
  const hide = pane.root.querySelector('#workPanelClose');
  if (hide) hide.onclick = () => pane.close();
  const maximize = pane.root.querySelector('#workPanelMaximize');
  if (maximize) maximize.onclick = () => pane.setMaximized?.(!pane.isMaximized?.());
  onPane();
}
