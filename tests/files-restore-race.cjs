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

/* The production mount case the atomic-change fixture cannot reproduce: the panel
 * mounts while the session identity is still EMPTY (bridge ready precedes it), then
 * the real session id settles later. History — including the file-tree state — is
 * seeded under the SETTLED session, exactly what the empty mount cannot yet read. */
async function settleFixture({ history = [], activeHistory = null, tree = {}, transport = {} } = {}) {
  const [{ mountFilesPanel }, state] = await imports;
  const id = ++sequence;
  const host = document.createElement('section'); document.getElementById('rightPane').append(host);
  host.getBoundingClientRect = () => ({ width: 1000, height: 700 });
  const cwd = `C:/fixture/settle-${id}`;
  const settledSession = `settled-${id}`;
  let identity = { cwd, sessionId: '', conversationId: null };
  let alive = true, visible = true;
  const disposers = [], visibility = new Set();
  const view = {
    isCurrent: () => alive, isVisible: () => alive && visible,
    onDispose(fn) { disposers.push(fn); },
    onVisibility(fn) { visibility.add(fn); return () => visibility.delete(fn); },
    dispose() { if (!alive) return; alive = false; for (const fn of disposers.reverse()) fn(); },
  };
  const calls = { list: [], metadata: [] };
  const workspace = { id: `workspace-${id}`, generation: '1' };
  const rootGate = deferred();
  // Seed the settled session's history (tabs + tree state) BEFORE mounting empty.
  state.writeFilesState({ cwd, sessionId: settledSession, conversationId: null }, {
    tabs: history.map(path => ({ path, name: path, cwd, conversationId: null, fileId: `id:${path}`, state: {} })),
    active: activeHistory, tree, layout: {},
  }, localStorage);
  const panel = mountFilesPanel(host, view, {
    getIdentity: () => identity, storage: localStorage,
    transport: {
      list(path, options) { calls.list.push(options); return path === '' ? rootGate.promise : Promise.resolve({ ok: true, workspace, entries: [] }); },
      async metadata(path) { calls.metadata.push(path); return { ok: true, file: { name: path, fileId: `id:${path}`, bytes: 32, absolutePath: `${cwd}/${path}` } }; },
      ...transport,
    },
    previewMount(target, request) {
      target.textContent = request.path || request.name;
      return { ready: Promise.resolve(), getState: () => ({}), dispose() {} };
    },
  });
  const f = {
    host, panel, view, calls, workspace,
    open: (path, extra = {}) => panel.open({ path, cwd, conversationId: null, ...extra }),
    releaseRoot(entries = []) { rootGate.resolve({ ok: true, workspace, entries }); },
    settle() { identity = { ...identity, sessionId: settledSession }; document.dispatchEvent(new CustomEvent('pi-gui:session-evidence-context')); },
    closeActive() { const btn = host.querySelector('.files-tab-close'); if (btn) btn.click(); },
    hiddenToggle: () => host.querySelector('.files-hidden-toggle')?.getAttribute('aria-pressed'),
    clickHidden() { host.querySelector('.files-hidden-toggle')?.click(); },
    tabKeys: () => panel.getState().tabs.map(tab => tab.key),
    active: () => panel.getState().active,
    dispose() { view.dispose(); host.remove(); },
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

test('a history tab the user opened and closed before restoration is never resurrected', async () => {
  // The P1 the first review found: the closed file IS in history, so dedup
  // against currently-open tabs cannot protect it — only a tombstone can.
  const f = await fixture({ history: ['hist-a.txt', 'hist-b.txt'], activeHistory: 'workspace:hist-a.txt' });
  await f.open('hist-a.txt');
  await until(() => f.tabKeys().includes('workspace:hist-a.txt'));
  const closeButton = f.host.querySelector('.files-tab-close');
  assert.ok(closeButton, 'a close control exists on the tab');
  closeButton.click();
  await tick();
  assert.ok(!f.tabKeys().includes('workspace:hist-a.txt'), 'user closed the history file before restore landed');
  f.releaseRoot();
  await until(() => f.tabKeys().includes('workspace:hist-b.txt'));
  await tick();
  assert.ok(!f.tabKeys().includes('workspace:hist-a.txt'), 'closed history file stays closed');
  assert.ok(f.tabKeys().includes('workspace:hist-b.txt'), 'untouched history still merges');
  f.dispose();
});

test('restoration landing while the panel is hidden merges state without mounting a preview', async () => {
  const f = await fixture({ history: ['old-a.txt'], activeHistory: 'workspace:old-a.txt' });
  await f.open('user.txt');
  await until(() => f.tabKeys().includes('workspace:user.txt'));
  // Hide the panel, then let the deferred tree resolve: restoration lands hidden.
  f.view.show(false);
  f.releaseRoot();
  await until(() => f.tabKeys().includes('workspace:old-a.txt'));
  await tick();
  assert.equal(f.panel.getState().active, 'workspace:user.txt', 'user selection outranks the snapshot even hidden');
  assert.ok(f.calls.preview.length <= 1, 'no preview mounts while hidden');
  // Reveal: the active tab validates and mounts for real.
  f.view.show(true);
  await until(() => f.calls.preview.some(entry => entry.request.path === 'user.txt' && !entry.disposed));
  f.dispose();
});

test('a restore whose rows are all scope-filtered leaves no phantom state', async () => {
  const f = await fixture({ history: ['old-a.txt'] });
  // Move scope so every restored row is filtered out by the identity guards.
  f.change({ conversationId: 'other', sessionId: 'other-session' });
  f.releaseRoot();
  await tick(); await tick();
  assert.equal(f.panel.getState().tabs.length, 0);
  assert.equal(f.panel.getState().active, null);
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

/* The session id is a history namespace, never a file-access binding (the
 * backend fileId hash covers only workspace root + conversation). Session
 * identity settles asynchronously after the bridge is ready, so a session-only
 * transition while cwd+conversation stay stable must adopt the new namespace in
 * place — not tear down tabs or an in-flight open the user already started. */
test('a session-only identity settle never destroys an open the user already started', async () => {
  const f = await fixture({ history: [] });
  await f.open('guide.md');
  await until(() => f.tabKeys().includes('workspace:guide.md'));
  // Session identity settles/rotates inside the SAME workspace + conversation:
  // only the session id changes. This is the onContext path, not a scope event.
  f.change({ sessionId: 'race-settled' }, 'pi-gui:session-evidence-context');
  await tick();
  // The user's open survives the settle — it is still correctly bound to the
  // unchanged workspace, so nothing may be torn down.
  assert.ok(f.tabKeys().includes('workspace:guide.md'), 'user open survives session settle');
  assert.equal(f.panel.getState().active, 'workspace:guide.md');
  f.dispose();
});

test('an in-flight open survives a session-only settle that lands mid-open', async () => {
  const f = await fixture({ history: [] });
  // Open but do not yet release the tree, so the open is in-flight when settle lands.
  const opening = f.open('guide.md');
  f.change({ sessionId: 'race-settled' }, 'pi-gui:session-evidence-context');
  await opening;
  f.releaseRoot();
  await until(() => f.tabKeys().includes('workspace:guide.md'));
  assert.equal(f.panel.getState().active, 'workspace:guide.md');
  f.dispose();
});

test('a genuine workspace change in the same session still tears down open tabs', async () => {
  const f = await fixture({ history: [] });
  await f.open('guide.md');
  await until(() => f.tabKeys().includes('workspace:guide.md'));
  // Conversation change is an access-binding change: file access is bound to it,
  // so the open must be discarded even though the session id is untouched.
  f.change({ conversationId: 'other-conversation' }, 'pi-gui:session-evidence-context');
  await tick();
  assert.ok(!f.tabKeys().includes('workspace:guide.md'), 'workspace change discards the open');
  f.dispose();
});

/* The settle regression tests below use the production mount shape: empty session
 * at mount, real session id arriving later, target history seeded under it. */

test('settle restores the settled session tree state instead of overwriting it with the default', async () => {
  // The settled session saved hidden:true; the empty-session default is hidden off.
  // Settle must apply the saved tree state, not keep (and later persist) the default.
  const f = await settleFixture({ history: ['a.txt'], tree: { hidden: true } });
  f.settle();
  f.releaseRoot();
  await until(() => f.tabKeys().includes('workspace:a.txt'));
  await until(() => f.hiddenToggle() === 'true');
  assert.equal(f.hiddenToggle(), 'true', 'settled hidden preference applied to the tree');
  assert.ok(f.calls.list.some(options => options?.hidden === true), 'a root listing used the settled hidden flag');
  f.dispose();
});

test('settle with no target snapshot preserves a hidden-items toggle the user already made', async () => {
  // Round-2 Important: the target session has NO saved state at all. The user turns
  // hidden items ON in the empty-session window. Settle must not replace their tree
  // with the default — the toggle must survive verbatim.
  const f = await settleFixture({ history: [], tree: {} });
  // No snapshot written for a different session: use a session id that has no state.
  f.clickHidden(); // user turns ON (default was false)
  await tick(); await tick();
  assert.equal(f.hiddenToggle(), 'true', 'user turned hidden on before settle');
  // Re-point settle at a session with no snapshot by overriding the settled id.
  f.settle(); // settles to settled-<id>, which HAS an empty tree snapshot ({}). hidden stays.
  f.releaseRoot();
  await tick(); await tick();
  assert.equal(f.hiddenToggle(), 'true', 'user hidden preference survives settle with no meaningful snapshot');
  f.dispose();
});

test('a hidden-items toggle the user turned off beats the snapshot stale true across settle', async () => {
  // The hard boolean case: the settled session saved hidden:true, but the user
  // deliberately toggled hidden off in the empty-session window. Because `false` is
  // both the untouched default and a real choice, only dirty-tracking can tell them
  // apart — the user's touched off must win over the snapshot's stale true.
  const f = await settleFixture({ history: ['a.txt'], tree: { hidden: true } });
  f.clickHidden(); // on
  await tick();
  f.clickHidden(); // off again — net false, but the field is now TOUCHED
  await tick();
  assert.equal(f.hiddenToggle(), 'false', 'user netted hidden off before settle');
  f.settle();
  f.releaseRoot();
  await until(() => f.tabKeys().includes('workspace:a.txt'));
  await tick();
  assert.equal(f.hiddenToggle(), 'false', 'touched off is not resurrected to the snapshot true');
  f.dispose();
});

test('an untouched hidden-items toggle still adopts the settled session snapshot', async () => {
  // The original round-1 Important must stay fixed: with no user gesture at all,
  // the snapshot hidden:true is adopted rather than the empty-session default.
  const f = await settleFixture({ history: ['a.txt'], tree: { hidden: true } });
  assert.equal(f.hiddenToggle(), 'false', 'empty-session default is off and untouched');
  f.settle();
  f.releaseRoot();
  await until(() => f.tabKeys().includes('workspace:a.txt'));
  await until(() => f.hiddenToggle() === 'true');
  assert.equal(f.hiddenToggle(), 'true', 'untouched toggle adopts the settled snapshot');
  f.dispose();
});

test('a file opened and closed under the empty session is not resurrected by the settle', async () => {
  // Target history holds a.txt+b.txt; the user opens a.txt then closes it before settle.
  const f = await settleFixture({ history: ['a.txt', 'b.txt'], activeHistory: 'workspace:a.txt' });
  await f.open('a.txt');
  await until(() => f.tabKeys().includes('workspace:a.txt'));
  f.closeActive();
  await tick();
  assert.ok(!f.tabKeys().includes('workspace:a.txt'), 'user closed a.txt before settle');
  f.settle();
  f.releaseRoot();
  await until(() => f.tabKeys().includes('workspace:b.txt'));
  await tick();
  // The tombstone recorded even under the empty session blocks resurrection;
  // the untouched b.txt still merges.
  assert.ok(!f.tabKeys().includes('workspace:a.txt'), 'closed a.txt stays closed across settle');
  assert.ok(f.tabKeys().includes('workspace:b.txt'), 'untouched b.txt merges');
  f.dispose();
});

test('settle merges the settled session history around a surviving user open without duplication', async () => {
  const f = await settleFixture({ history: ['same.txt', 'other.txt'] });
  await f.open('same.txt');
  await until(() => f.tabKeys().includes('workspace:same.txt'));
  f.settle();
  f.releaseRoot();
  await until(() => f.tabKeys().includes('workspace:other.txt'));
  const keys = f.tabKeys();
  assert.equal(keys.filter(key => key === 'workspace:same.txt').length, 1, 'no duplicate of the surviving open');
  assert.ok(keys.includes('workspace:other.txt'), 'gap history merged');
  assert.equal(f.active(), 'workspace:same.txt', 'user selection outranks the snapshot');
  f.dispose();
});

test('an in-flight open survives a settle that lands while the workspace tree is still deferred', async () => {
  const f = await settleFixture({ history: [] });
  const opening = f.open('guide.md'); // not yet resolved: tree root is gated
  f.settle();
  await opening;
  f.releaseRoot();
  await until(() => f.tabKeys().includes('workspace:guide.md'));
  assert.equal(f.active(), 'workspace:guide.md');
  f.dispose();
});

test('a cwd-only change in the same session invalidates a pending open', async () => {
  // cwd is part of the access binding: even with the session untouched, a cwd
  // change is a genuine workspace change and must discard the in-flight open.
  const f = await fixture({ history: [] });
  const opening = f.open('guide.md');
  f.change({ cwd: 'C:/fixture/elsewhere' }, 'pi-gui:session-evidence-context');
  await opening.catch(() => {});
  f.releaseRoot();
  await tick(); await tick();
  assert.ok(!f.tabKeys().includes('workspace:guide.md'), 'pending open discarded on cwd change');
  f.dispose();
});
