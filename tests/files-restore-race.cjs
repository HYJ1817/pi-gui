'use strict';
/* R0: history restoration must merge, never overwrite. The deferred file tree
 * resolves after the user may already have opened, closed, reordered or
 * re-scoped tabs; a late snapshot must not resurrect closed tabs, drop user
 * tabs, clobber order/selection, or write into a scope that has moved on.
 * In-memory fixture only: no real files, Pi, network or persistent data. */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body><div id="rightPane"></div><div id="toasts"></div></body>', { url: 'http://fixture.invalid/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'localStorage', 'sessionStorage', 'CustomEvent', 'MutationObserver', 'File']) global[key] = key === 'window' ? dom.window : dom.window[key];
global.requestAnimationFrame = fn => setTimeout(fn, 0);
global.cancelAnimationFrame = clearTimeout;
const imports = Promise.all([import('../public/files-panel.js'), import('../public/files-state.js')]);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const until = async fn => { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } throw new Error('restore race timeout'); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const fixtures = [];
let sequence = 0;

/* A fixture whose root listing is held back until `releaseRoot` fires. History
 * for the scope is pre-seeded so restoration only completes once the tree
 * resolves — the exact window in which the user can act first. */
async function fixture({ history = [], activeHistory = null, transport = {}, previewMount } = {}) {
  const [{ mountFilesPanel }, state] = await imports;
  const id = ++sequence;
  const host = document.createElement('section'); document.getElementById('rightPane').append(host);
  host.getBoundingClientRect = () => ({ width: 1000, height: 700 });
  let identity = { cwd: `C:/fixture/race-${id}`, sessionId: `race-${id}`, conversationId: null };
  let alive = true, visible = true, valid = true;
  const disposers = [], visibility = new Set();
  const view = {
    isCurrent: () => alive && valid, isVisible: () => alive && visible,
    onDispose(fn) { disposers.push(fn); },
    onVisibility(fn) { visibility.add(fn); return () => visibility.delete(fn); },
    show(next) { visible = next; for (const fn of visibility) fn(next); },
    invalidate(next) { valid = !next; },
    dispose() { if (!alive) return; alive = false; for (const fn of disposers.reverse()) fn(); },
  };
  const calls = { list: [], metadata: [], preview: [] };
  const workspace = { id: `workspace-${id}`, generation: '1' };
  const rootGate = deferred();
  // Seed persisted history for exactly this scope before the panel mounts.
  state.writeFilesState(identity, {
    tabs: history.map(path => ({ path, name: path, cwd: identity.cwd, conversationId: null, fileId: `id:${path}`, state: {} })),
    active: activeHistory, tree: {}, layout: {},
  }, localStorage);
  const panel = mountFilesPanel(host, view, {
    getIdentity: () => identity, storage: localStorage,
    transport: {
      list(path) { calls.list.push(path); return path === '' ? rootGate.promise : Promise.resolve({ ok: true, workspace, entries: [] }); },
      async metadata(path, conversation, options) { calls.metadata.push({ path, conversation, options }); return { ok: true, file: { name: path, fileId: `id:${path}`, bytes: 32, absolutePath: `${identity.cwd}/${path}` } }; },
      async externalMetadata(path, grantId, conversation, options) { calls.metadata.push({ path, grantId, conversation, options }); return { ok: true, file: { name: 'external.txt', absolutePath: path, fileId: 'external-id', bytes: 32 } }; },
      ...transport,
    },
    previewMount: previewMount || ((target, request, options) => {
      const entry = { target, request, options, disposed: false };
      calls.preview.push(entry); target.textContent = request.path || request.name;
      return { ready: Promise.resolve(), getState: () => ({}), dispose() { entry.disposed = true; target.replaceChildren(); } };
    }),
  });
  const f = {
    host, panel, view, calls, workspace,
    identity: () => ({ ...identity }),
    open: (path = 'a.txt', extra = {}) => panel.open({ path, cwd: identity.cwd, conversationId: identity.conversationId, ...extra }),
    releaseRoot(entries = [{ path: 'a.txt', name: 'a.txt', type: 'file' }]) { rootGate.resolve({ ok: true, workspace, entries }); },
    change(next, event = 'pi-gui:git-scope') { identity = { ...identity, ...next }; document.dispatchEvent(new CustomEvent(event)); },
    dispose() { view.dispose(); host.remove(); },
    tabKeys: () => panel.getState().tabs.map(tab => tab.key),
  };
  fixtures.push(f); await tick(); return f;
}
after(() => { fixtures.forEach(f => f.dispose()); localStorage.clear(); dom.window.close(); });

test('opening an attachment while the tree is deferred is never overwritten by late history', async () => {
  const f = await fixture({ history: ['old-a.txt', 'old-b.txt'], activeHistory: 'workspace:old-a.txt' });
  // User opens an attachment before the tree (and thus restoration) resolves.
  await f.panel.open({ source: 'attachment', attachmentId: 'up-1', file: new File(['x'], 'note.txt'), name: 'note.txt' });
  await tick();
  assert.deepEqual(f.tabKeys(), ['attachment:up-1']);
  f.releaseRoot();
  await until(() => f.calls.preview.length >= 1);
  await tick();
  const keys = f.tabKeys();
  // The attachment survives; history only fills gaps, never drops it.
  assert.ok(keys.includes('attachment:up-1'), 'attachment tab retained');
  assert.ok(keys.includes('workspace:old-a.txt') && keys.includes('workspace:old-b.txt'), 'history merged');
  // The user's own (only) tab keeps the active selection over the snapshot.
  assert.equal(f.panel.getState().active, 'attachment:up-1');
  f.dispose();
});

test('opening a normal file while the tree is deferred is never dropped by late history', async () => {
  const f = await fixture({ history: ['old-a.txt'] });
  await f.open('user.txt');
  await tick();
  assert.deepEqual(f.tabKeys(), ['workspace:user.txt']);
  f.releaseRoot();
  await until(() => f.tabKeys().includes('workspace:old-a.txt'));
  const keys = f.tabKeys();
  assert.ok(keys.includes('workspace:user.txt'), 'user file retained');
  assert.ok(keys.includes('workspace:old-a.txt'), 'history merged');
  assert.equal(f.panel.getState().active, 'workspace:user.txt');
  f.dispose();
});

test('history is deduplicated against an already-open identical file', async () => {
  const f = await fixture({ history: ['same.txt', 'other.txt'] });
  await f.open('same.txt');
  await tick();
  f.releaseRoot();
  await until(() => f.tabKeys().length >= 2);
  const keys = f.tabKeys();
  assert.equal(keys.filter(key => key === 'workspace:same.txt').length, 1, 'no duplicate restored tab');
  assert.ok(keys.includes('workspace:other.txt'));
  f.dispose();
});

test('a tab the user closed before restoration resolves is not resurrected', async () => {
  const f = await fixture({ history: ['old-a.txt'] });
  await f.open('temp.txt');
  await until(() => f.tabKeys().includes('workspace:temp.txt'));
  // The user closes the tab before the tree resolves, through the real tab UI.
  const closeButton = f.host.querySelector('.files-tab-close');
  assert.ok(closeButton, 'a close control exists on the tab');
  closeButton.click();
  await tick();
  assert.ok(!f.tabKeys().includes('workspace:temp.txt'), 'tab closed before restore');
  f.releaseRoot();
  await until(() => f.tabKeys().includes('workspace:old-a.txt'));
  // Restoration may still merge old-a (it was never user-opened), but must not
  // resurrect temp.txt — it is not in history, so it simply stays closed.
  assert.ok(!f.tabKeys().includes('workspace:temp.txt'), 'closed user tab stays closed');
  f.dispose();
});

test('restoration during a scope switch writes nothing into the moved-on scope', async () => {
  const f = await fixture({ history: ['old-a.txt'] });
  // Move to another scope before the tree resolves.
  f.change({ conversationId: 'other', sessionId: 'other-session' });
  f.releaseRoot();
  await tick(); await tick();
  // The moved-on scope starts empty; the stale snapshot must not repopulate it.
  assert.equal(f.panel.getState().tabs.length, 0);
  assert.equal(f.panel.getState().identity.conversationId, 'other');
  f.dispose();
});

test('restoration during a workspace generation change discards the stale snapshot', async () => {
  const f = await fixture({ history: ['old-a.txt'] });
  f.change({ sessionId: 'race-new' }, 'pi-gui:workspace-generation');
  f.releaseRoot();
  await tick(); await tick();
  assert.equal(f.panel.getState().tabs.length, 0);
  f.dispose();
});

test('normal history restoration still applies when the user has not acted', async () => {
  const f = await fixture({ history: ['old-a.txt', 'old-b.txt'], activeHistory: 'workspace:old-b.txt' });
  f.releaseRoot();
  await until(() => f.tabKeys().length >= 2);
  await tick();
  const keys = f.tabKeys();
  assert.ok(keys.includes('workspace:old-a.txt') && keys.includes('workspace:old-b.txt'));
  assert.equal(f.panel.getState().active, 'workspace:old-b.txt');
  f.dispose();
});

test('restored history follows the user-opened tab in order rather than replacing it', async () => {
  const f = await fixture({ history: ['old-a.txt', 'old-b.txt'] });
  await f.open('user.txt');
  await tick();
  f.releaseRoot();
  await until(() => f.tabKeys().length >= 3);
  const keys = f.tabKeys();
  // User tab is first (it was opened first); history appends after it.
  assert.equal(keys[0], 'workspace:user.txt');
  assert.deepEqual(keys.slice(1).sort(), ['workspace:old-a.txt', 'workspace:old-b.txt']);
  f.dispose();
});
