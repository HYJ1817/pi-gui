'use strict';
// Surface visibility is not ownership. No real files, Pi, network or geometry
// claims: injected controllers and the real media registry check resource
// ownership, bounded reading state, and object tokens (not native playback).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body><div id="rightPane"></div><div id="toasts"></div></body>', { url: 'http://fixture.invalid/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'localStorage', 'sessionStorage', 'CustomEvent', 'MutationObserver']) global[key] = key === 'window' ? dom.window : dom.window[key];
global.requestAnimationFrame = fn => setTimeout(fn, 0);
global.cancelAnimationFrame = clearTimeout;
const imports = Promise.all([import('../public/files-panel.js'), import('../public/files-state.js')]);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const until = async fn => { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } throw new Error('surface state timeout'); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const fixtures = [];
let sequence = 0;
async function fixture({ transport = {}, previewMount, width = 1000 } = {}) {
  const [{ mountFilesPanel }] = await imports;
  const id = ++sequence;
  const host = document.createElement('section'); document.getElementById('rightPane').append(host);
  const size = { width };
  host.getBoundingClientRect = () => ({ width: size.width, height: 700 });
  let identity = { cwd: `C:/fixture/surface-${id}`, sessionId: `surface-${id}`, conversationId: null };
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
  const tokens = new Map();
  const workspace = { id: `workspace-${id}`, generation: '1' };
  const panel = mountFilesPanel(host, view, {
    getIdentity: () => identity, storage: localStorage,
    transport: {
      async list(path) { calls.list.push(path); return { ok: true, workspace, entries: [{ path: 'a.txt', name: 'a.txt', type: 'file' }] }; },
      async metadata(path, conversation, options) { calls.metadata.push({ path, conversation, options }); return { ok: true, file: { name: path, fileId: tokens.get(path) || `id:${path}`, bytes: 32, absolutePath: `${identity.cwd}/${path}` } }; },
      async externalMetadata(path, grantId, conversation, options) { calls.metadata.push({ path, grantId, conversation, options }); return { ok: true, file: { name: 'external.txt', absolutePath: path, fileId: tokens.get(path) || 'external-id', bytes: 32 } }; },
      ...transport,
    },
    previewMount: previewMount || ((target, request, options) => {
      const entry = { target, request, options, state: { ...options.state }, disposed: false };
      calls.preview.push(entry); target.textContent = request.path || request.name;
      return { ready: Promise.resolve(), getState: () => entry.state, dispose() { entry.disposed = true; target.replaceChildren(); } };
    }),
  });
  const f = {
    host, size, panel, view, calls, tokens,
    identity: () => ({ ...identity }),
    open: (path = 'a.txt', extra = {}) => panel.open({ path, cwd: identity.cwd, conversationId: identity.conversationId, ...extra }),
    change(next, event = 'pi-gui:git-scope') { identity = { ...identity, ...next }; document.dispatchEvent(new CustomEvent(event)); },
    dispose() { view.dispose(); host.remove(); },
  };
  fixtures.push(f); await until(() => calls.list.length); await tick(); return f;
}
after(() => { fixtures.forEach(f => f.dispose()); dom.window.close(); });

test('hiding snapshots bounded reading state, disposes the preview, and retains exact tree/tab DOM', async () => {
  const f = await fixture(); await f.open();
  const tree = f.host.querySelector('.files-tree'), row = f.host.querySelector('.files-entry'), tab = f.host.querySelector('[role="tab"]');
  f.calls.preview[0].state = { scrollTop: 234, zoom: 1.5, search: '中文', content: 'PRIVATE', grantId: 'PRIVATE' };
  f.view.show(false);
  assert.equal(f.panel.isCurrent(), true);
  assert.equal(f.calls.preview[0].disposed, true);
  assert.deepEqual(f.panel.getState().tabs[0].state, { scrollTop: 234, zoom: 1.5, search: '中文' });
  assert.equal(f.host.querySelector('.files-tree'), tree); assert.equal(f.host.querySelector('.files-entry'), row);
  assert.equal(f.host.querySelector('[role="tab"]'), tab);
  assert.equal(f.host.querySelector('.files-preview-content')?.textContent || '', '');
  f.dispose();
});

test('showing revalidates the saved object token, restores position, and never reloads the tree', async () => {
  const f = await fixture(); await f.open(); f.calls.preview[0].state = { page: 4, pageOffset: .2, fitWidth: true };
  f.view.show(false); const lists = f.calls.list.length; f.view.show(true);
  await until(() => f.calls.preview.length === 2);
  assert.equal(f.calls.metadata.at(-1).options.fileId, 'id:a.txt');
  assert.deepEqual(f.calls.preview.at(-1).options.state, { page: 4, pageOffset: .2, fitWidth: true });
  assert.equal(f.calls.list.length, lists);
  assert.equal(f.calls.preview.filter(p => !p.disposed).length, 1);
  f.dispose();
});

test('a file replaced while hidden is not read by the resumed preview', async () => {
  const f = await fixture(); await f.open(); f.view.show(false); f.tokens.set('a.txt', 'replacement'); f.view.show(true);
  await until(() => f.host.textContent.includes('已变化'));
  assert.equal(f.calls.preview.length, 1); assert.equal(f.panel.getState().tabs.length, 1);
  assert.equal(f.calls.preview[0].disposed, true); f.dispose();
});

test('external resume requires matching fileId evidence as well as its original grant', async () => {
  let reads = 0;
  const f = await fixture({ transport: { async externalMetadata(path, grantId, conversation, options) {
    reads++; f.calls.metadata.push({ path, grantId, conversation, options });
    return { ok: true, file: { name: 'external.txt', ...(reads === 1 ? { fileId: 'external-id' } : {}) } };
  } } });
  await f.panel.open({ path: 'C:/outside/external.txt', external: true, grantId: 'grant-A' });
  f.view.show(false); f.view.show(true); await until(() => reads === 2); await tick();
  assert.equal(f.calls.metadata.at(-1).grantId, 'grant-A');
  assert.equal(f.calls.preview.length, 1); assert.match(f.host.textContent, /已变化|不可用/); f.dispose();
});

test('hidden grant revocation closes both the ZIP and owned member before reshow', async () => {
  const f = await fixture(); await f.panel.open({ path: 'C:/outside/archive.zip', external: true, grantId: 'grant-Z' });
  f.calls.preview.at(-1).options.onOpen({ source: 'archive', name: 'child.txt', archiveEntry: 'docs/child.txt', bytes: new Uint8Array([65]) });
  assert.equal(f.panel.getState().tabs.length, 2); f.view.show(false);
  document.dispatchEvent(new CustomEvent('pi-gui:external-grants', { detail: { revoked: 'grant-Z' } }));
  assert.equal(f.panel.getState().tabs.length, 0); const count = f.calls.preview.length;
  f.view.show(true); await tick(); assert.equal(f.calls.preview.length, count); f.dispose();
});

test('a hidden archive member cannot restore after its workspace parent changes', async () => {
  const f = await fixture(); await f.open('archive.zip');
  f.calls.preview.at(-1).options.onOpen({ source: 'archive', name: 'child.txt', bytes: new Uint8Array([65]) });
  f.view.show(false); f.tokens.set('archive.zip', 'replacement'); const count = f.calls.preview.length;
  f.view.show(true); await until(() => f.host.textContent.includes('已变化'));
  assert.equal(f.calls.preview.length, count); assert.equal(f.calls.metadata.at(-1).options.fileId, 'id:archive.zip'); f.dispose();
});

test('hidden attachment revocation releases original File and member tabs immediately', async () => {
  const f = await fixture(); await f.panel.open({ source: 'attachment', attachmentId: 'upload-A', file: new File(['a'], 'a.txt'), name: 'a.txt' });
  f.view.show(false); document.dispatchEvent(new CustomEvent('pi-gui:attachment-revoked', { detail: { attachmentId: 'upload-A' } }));
  assert.equal(f.panel.getState().tabs.length, 0); assert.equal(f.calls.preview[0].disposed, true);
  f.view.show(true); await tick(); assert.equal(f.calls.preview.length, 1); f.dispose();
});

test('scope reset clears hidden ownership even when the surface identity is already invalid', async () => {
  const f = await fixture(); await f.open(); f.view.show(false); f.view.invalidate(true);
  f.change({ conversationId: 'other', sessionId: 'other-session' });
  assert.equal(f.panel.getState().tabs.length, 0);
  assert.equal(f.panel.getState().identity.conversationId, 'other');
  f.view.invalidate(false); f.view.show(true); await tick(); assert.equal(f.calls.preview.length, 1); f.dispose();
});

test('hide aborts pending metadata and rejects its late response', async () => {
  const gate = deferred(); let signal;
  const f = await fixture({ transport: { async metadata(path, owner, options) { signal = options.signal; return gate.promise; } } });
  const opening = f.open(); await until(() => signal); f.view.show(false);
  assert.equal(signal.aborted, true); gate.resolve({ ok: true, file: { name: 'a.txt', fileId: 'id:a.txt' } }); await opening;
  assert.equal(f.panel.getState().tabs.length, 0); assert.equal(f.calls.preview.length, 0); f.dispose();
});

test('late preview-ready and metadata cannot mutate a hidden tab snapshot', async () => {
  const gate = deferred(); let options, disposed = false;
  const f = await fixture({ previewMount(host, request, value) { options = value; return { ready: gate.promise, getState: () => ({ scrollTop: 90 }), dispose() { disposed = true; host.replaceChildren(); } }; } });
  await f.open(); f.view.show(false); options.onMetadata({ fileId: 'late-id', bytes: 999 }); gate.resolve(); await tick();
  assert.equal(disposed, true); assert.deepEqual(f.panel.getState().tabs[0].state, { scrollTop: 90 });
  assert.equal(f.host.querySelector('.files-preview-content')?.textContent || '', ''); f.dispose();
});

test('closing a hidden surface persists the saved reading state without raw payload or grants', async () => {
  const f = await fixture(); await f.open(); f.calls.preview[0].state = { scrollTop: 345, page: 7, content: 'PRIVATE', grantId: 'PRIVATE' };
  f.view.show(false); const identity = f.identity(); f.dispose();
  const [, { readFilesState, FILES_STORAGE_KEY }] = await imports;
  const stored = readFilesState(identity, localStorage);
  assert.deepEqual(stored.tabs[0].state, { scrollTop: 345, page: 7 });
  assert.doesNotMatch(localStorage.getItem(FILES_STORAGE_KEY), /PRIVATE/);
});

test('real manager hide/resume pauses the actual media plugin, revokes its URL, and never autoplays', async () => {
  const files = await import('../public/files-panel.js');
  const surfaces = await import('../public/ui/secondary-surface.js');
  const { initRightPane } = await import('../public/right-pane.js');
  const root = document.getElementById('rightPane'), app = document.createElement('div'); app.className = 'app';
  root.before(app); app.append(root); root.hidden = true;
  root.innerHTML = '<div id="rightPaneResizer"></div><div id="workPanelTabs"></div><button id="workPanelMaximize"></button><div class="rp-body"></div>';
  const pane = initRightPane(); surfaces.configureSecondaryPane(pane, { getScope: () => 'media-fixture' });
  const proto = window.HTMLMediaElement.prototype, original = { pause: proto.pause, load: proto.load, play: proto.play, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const pauses = [], loads = [], urls = [], revoked = []; let plays = 0;
  proto.pause = function () { pauses.push(this); }; proto.load = function () { loads.push(this); }; proto.play = function () { plays++; return Promise.resolve(); };
  URL.createObjectURL = blob => { const url = original.create(blob); urls.push(url); return url; };
  URL.revokeObjectURL = url => { revoked.push(url); original.revoke(url); };
  try {
    const view = files.openFilesPanel({ getIdentity: () => ({ cwd: 'C:/fixture/managed-media', sessionId: 'managed-media', conversationId: null }),
      transport: { list: async () => ({ ok: true, workspace: { id: 'media-workspace', generation: '1' }, entries: [] }) } });
    const bytes = Buffer.alloc(60); bytes.write('RIFF'); bytes.writeUInt32LE(52, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24);
    bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(16, 40);
    const file = new File([bytes], 'tone.wav', { type: 'audio/wav' });
    const request = { source: 'attachment', attachmentId: 'managed-media', name: file.name, file };
    files.openFileReference(request); await until(() => view.host.querySelector('audio'));
    const first = view.host.querySelector('audio'), tree = view.host.querySelector('.files-tree'), tab = view.host.querySelector('.files-tab');
    Object.defineProperty(first, 'duration', { value: 10 }); first.dispatchEvent(new window.Event('loadedmetadata'));
    first.currentTime = 3; first.volume = .25; first.muted = true;
    assert.equal(first.autoplay, false); assert.equal(first.controls, true);
    const firstUrl = first.getAttribute('src'); assert.ok(urls.includes(firstUrl));
    surfaces.openSecondarySurface('media-other', host => { host.textContent = 'Another tool'; });
    assert.equal(view.isCurrent(), true); assert.equal(view.isVisible(), false);
    assert.ok(pauses.includes(first)); assert.ok(loads.filter(player => player === first).length >= 2);
    assert.equal(first.hasAttribute('src'), false); assert.ok(revoked.includes(firstUrl));
    assert.equal(view.host.querySelector('audio'), null); assert.equal(view.host.querySelector('.files-tab'), tab);
    assert.equal(view.host.querySelector('.files-tree'), tree);
    files.openFileReference(request); await until(() => view.host.querySelector('audio'));
    const resumed = view.host.querySelector('audio'); Object.defineProperty(resumed, 'duration', { value: 10 });
    resumed.dispatchEvent(new window.Event('loadedmetadata'));
    assert.equal(view.isVisible(), true); assert.equal(surfaces.secondaryTabs().find(tab => tab.active).view, 'files');
    assert.notEqual(resumed, first); assert.equal(resumed.currentTime, 3); assert.equal(resumed.volume, .25); assert.equal(resumed.muted, true);
    assert.equal(resumed.autoplay, false); assert.equal(plays, 0); assert.equal(urls.length - revoked.length, 1);
    surfaces.activateSecondarySurface('media-other');
    document.dispatchEvent(new CustomEvent('pi-gui:attachment-revoked', { detail: { attachmentId: 'managed-media' } }));
    surfaces.activateSecondarySurface('files'); await tick();
    assert.equal(view.host.querySelectorAll('.files-tab').length, 0); assert.equal(view.host.querySelector('audio'), null);
    assert.equal(urls.length, revoked.length);
  } finally {
    surfaces.configureSecondaryPane(null); pane.close();
    proto.pause = original.pause; proto.load = original.load; proto.play = original.play;
    URL.createObjectURL = original.create; URL.revokeObjectURL = original.revoke;
    app.replaceWith(root); root.replaceChildren();
  }
});

test('right-side divider keyboard and drag enlarge the tree towards the content', async () => {
  const f = await fixture(); const layout = f.host.querySelector('.files-layout'), main = f.host.querySelector('.files-main');
  const sidebar = f.host.querySelector('.files-sidebar'), divider = f.host.querySelector('.files-tree-resizer');
  assert.ok([...layout.children].indexOf(main) < [...layout.children].indexOf(divider));
  assert.ok([...layout.children].indexOf(divider) < [...layout.children].indexOf(sidebar));
  divider.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  assert.equal(divider.getAttribute('aria-valuenow'), '236');
  divider.dispatchEvent(new window.MouseEvent('mousedown', { button: 0, clientX: 700, bubbles: true, cancelable: true }));
  document.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 668, bubbles: true }));
  document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  assert.equal(divider.getAttribute('aria-valuenow'), '268');
  assert.equal(f.host.querySelector('.files-maximize'), null);
  assert.equal(f.host.querySelector('.rp-head-title'), null); f.dispose();
});
