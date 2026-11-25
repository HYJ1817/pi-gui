import { runtimeStore as store, onRuntimeChange } from './runtime-state.js';
import { runtimeSessionAction } from './api.js';
import { createBrowserSurface } from './browser-pane.js';
import { createPaneHeader } from './right-pane.js';
import { openProcessPanel } from './process-panel.js';
import { openSecondarySurface, activateSecondarySurface, closeSecondarySurface, borrowSecondarySurface, syncSecondaryScope, refreshSecondaryTools } from './ui/secondary-surface.js';
import { openSplitWorkbench } from './ui/split-workbench.js';

const same = (a, b) => Boolean(a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]));
const scopeOf = captured => { const { repoId, ...scope } = captured; return scope; };

/* Runtime keeps native Browser authority in its existing full owner bridge.
 * Tabs borrow/present the same chrome; visibility only occludes the native view.
 * Explicit close alone sends close. Focus changes detach, never a global close. */
export function createRuntimeSecondary({ pane }) {
  let id = null, owner = null, alive = true, serial = 0;
  let browser = null, browserPanel = null;
  const desktop = () => window.piGuiDesktop?.runtimeBrowser;
  const current = captured => alive && same(store.get(id)?.owner, captured) && same(owner, captured);

  function placeBrowser(split) {
    if (!browserPanel?.isCurrent()) return;
    if (!split) { activateSecondarySurface('runtime-browser'); return; }
    const surface = browser;
    openSplitWorkbench({ returnSurface: 'browser', browserOptions: {
      mount: (target, _exit, view) => {
        if (!borrowSecondarySurface('runtime-browser', target, view)) surface?.moveTo(target, true);
      },
      exit: () => { closeSecondarySurface('browser-changes-split'); activateSecondarySurface('runtime-browser'); },
      refresh: () => pane.refresh?.(),
    } });
  }
  function showMessage(host, text, action) {
    host.replaceChildren(createPaneHeader({ title: '浏览器' }).el);
    const note = document.createElement('p'); note.className = 'process-message'; note.setAttribute('role', 'status'); note.textContent = text; host.append(note);
    if (action) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn'; button.textContent = '打开浏览器'; button.onclick = action; host.append(button);
    }
  }
  async function bindBrowser(host, instance, create) {
    const captured = owner ? { ...owner } : null, token = ++serial, api = desktop();
    const valid = () => instance.isCurrent() && token === serial && captured && current(captured);
    if (!captured) { showMessage(host, '会话已关闭；恢复会话后可以使用浏览器。'); return; }
    if (!api) { showMessage(host, '浏览器仅在桌面版可用。'); return; }
    const scope = scopeOf(captured);
    showMessage(host, '正在读取浏览器…');
    let status;
    try { status = await api.status(scope); } catch { status = { ok: false }; }
    if (!valid()) return;
    if (!status?.ok) { showMessage(host, '此会话的浏览器当前不可用。'); return; }
    if (!create && !status.opened) { showMessage(host, '此会话尚未打开浏览器。', () => { if (valid()) void bindBrowser(host, instance, true); }); return; }
    const matches = frame => valid() && same(scope, { ...frame.scope, sessionId: captured.sessionId });
    const guard = fn => (...args) => valid() ? fn(...args) : Promise.resolve({ ok: false, code: 'stale_runtime' });
    const bridge = {
      open: guard(() => api.open(scope)), navigate: guard(url => api.navigate(scope, url)),
      back: guard(() => api.command(scope, 'back')), forward: guard(() => api.command(scope, 'forward')),
      reload: guard(() => api.command(scope, 'reload')), stop: guard(() => api.command(scope, 'stop')),
      setBounds: guard(rect => api.bounds(scope, rect)), setOccluded: guard(flag => api.occluded(scope, flag)),
      setAgentControl: guard(value => api.enable(scope, value)), agentStatus: guard(() => api.status(scope)),
      onState: cb => {
        const off = api.onState(frame => { if (matches(frame)) cb(frame.state); });
        queueMicrotask(() => { if (valid() && status.browserState) cb(status.browserState); }); return off;
      },
      onAgentState: cb => api.onAgentState(frame => { if (matches(frame)) cb(frame.state); }),
      onNotice: () => () => {}, openExternal: () => Promise.resolve({ ok: false }),
    };
    host.replaceChildren();
    const surface = createBrowserSurface({ pane, bridge, target: host, instance, surfaceName: 'runtime-browser', onAgentState: () => {},
      onRequestSplit: () => placeBrowser(pane.surface() !== 'browser-changes-split'), onRequestClose: () => instance.close() });
    surface.ui.external.hidden = true;
    browser = surface;
    instance.onDispose(() => {
      // Captured scope, not currently focused scope. Guarded UI callbacks have
      // already become invalid; cleanup must still detach this old native view.
      void api.occluded(scope, true);
      surface.close();
      if (instance.disposeReason !== 'scope') void api.command(scope, 'close');
      if (browser === surface) browser = null;
    });
    if (create) await surface.open();
    else surface.openFromAgent();
  }
  function openBrowser(create = true, split = false) {
    if (browserPanel?.isCurrent()) {
      activateSecondarySurface('runtime-browser');
      if (split) placeBrowser(true);
      return browserPanel;
    }
    browserPanel = openSecondarySurface('runtime-browser', (host, instance) => {
      host.classList.add('browser-surface');
      instance.onDispose(() => { if (browserPanel === instance) { browserPanel = null; serial++; } });
      void bindBrowser(host, instance, create);
    }, { label: '浏览器' });
    if (split) placeBrowser(true);
    return browserPanel;
  }
  function openProcesses() {
    const captured = owner ? { ...owner } : null;
    if (!captured) return openSecondarySurface('process', host => showMessage(host, '会话已关闭；恢复会话后可以使用开发进程。'), { label: '开发进程' });
    const call = args => current(captured)
      ? runtimeSessionAction({ action: 'process', owner: captured, args })
      : Promise.resolve({ ok: false, code: 'stale_runtime' });
    return openProcessPanel({ transport: {
      status: () => call({ action: 'status' }), control: call,
      logs: (generation, processId, revision, cursor) => call({ action: 'logs', generation, id: processId, revision, cursor }),
    }, isOwnerCurrent: () => current(captured) });
  }
  const unsubscribe = onRuntimeChange(() => {
    if (!id) return;
    const next = store.get(id)?.owner || null;
    if (same(owner, next) || !owner && !next) return;
    serial++; owner = next ? { ...next } : null; syncSecondaryScope(); refreshSecondaryTools();
  });
  const offOpen = desktop()?.onOpen?.(frame => {
    if (!owner || !same(scopeOf(owner), { ...frame.scope, sessionId: owner.sessionId }) || browserPanel?.isCurrent()) return;
    if (pane.isOpen() && ['runtime-browser', 'browser-changes-split'].includes(pane.surface())) openBrowser(false);
  });
  return {
    focus(next) { id = next; owner = store.get(id)?.owner ? { ...store.get(id).owner } : null; syncSecondaryScope(); refreshSecondaryTools(); },
    openBrowser: () => openBrowser(true, false), openBrowserSplit: () => { openBrowser(true, true); }, openProcesses,
    leave() {
      const old = owner; id = null; owner = null; serial++;
      if (old) void runtimeSessionAction({ action: 'blur', owner: old });
    },
    dispose() { alive = false; serial++; browserPanel?.close(); unsubscribe(); offOpen?.(); },
  };
}
