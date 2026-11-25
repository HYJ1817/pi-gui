/* Files UI behavior only. Real registry/plugin/bytes tests live with their
 * owners; this synchronous controller fixture proves panel lifecycle and races.
 * No network, real Pi, user project writes, or assertions about jsdom layout. */
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body><div class="app"><main id="workspace"></main><aside id="rightPane" style="width:392px" hidden><div id="rightPaneResizer"></div><div id="workPanelTabs"></div><button id="workPanelMaximize"></button><div class="rp-body"></div></aside></div><div id="toasts"></div></body>', { url: 'http://127.0.0.1/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'localStorage', 'sessionStorage', 'CustomEvent', 'MutationObserver']) global[key] = key === 'window' ? dom.window : dom.window[key];
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.cancelAnimationFrame = clearTimeout;
global.getComputedStyle = dom.window.getComputedStyle;
let checks = 0;
const check = (label, fn) => { fn(); checks++; console.log('  ok  ' + label); };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const until = async (fn) => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error('UI state timeout'); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const event = (target, type, props) => target.dispatchEvent(new dom.window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...props }));
let fixtureSequence = 0;
let mountFilesPanel;
let stateModule, pane, surfaces;
const made = [];
function fixture({ width = 1000, session, owner, transport = {}, previewMount } = {}) {
  const index = ++fixtureSequence;
  const root = document.querySelector('#rightPane .rp-body');
  const host = document.createElement('section'); root.append(host);
  const size = { width };
  host.getBoundingClientRect = () => ({ width: size.width, height: 700, left: 0, top: 0, right: size.width, bottom: 700 });
  let identity = owner || { cwd: `C:/fixture/project-${index}`, conversationId: null, sessionId: session || `session-${index}` };
  let current = true;
  const hooks = [];
  const view = { isCurrent: () => current, onDispose(fn) { hooks.push(fn); }, dispose() { if (!current) return; current = false; for (const fn of hooks.reverse()) fn(); } };
  const calls = { list: [], metadata: [], preview: [], search: [], disposed: [] };
  const workspace = { id: `workspace-${index}`, generation: '1' };
  const ids = new Map();
  const dirs = {
    '': [{ path: 'src', name: 'src', type: 'dir' }, { path: 'docs', name: 'docs', type: 'dir' }, { path: 'root.txt', name: 'root.txt', type: 'file' }],
    src: [{ path: 'src/app.js', name: 'app.js', type: 'file' }, { path: 'src/nested', name: 'nested', type: 'dir' }],
    'src/nested': [{ path: 'src/nested/deep.ts', name: 'deep.ts', type: 'file' }],
    docs: [{ path: 'docs/app.js', name: 'app.js', type: 'file' }],
  };
  const defaults = {
    async list(path, options) { calls.list.push({ path, options }); return { ok: true, workspace, entries: dirs[path] || [] }; },
    async metadata(path, conversationId, options) {
      calls.metadata.push({ path, conversationId, options });
      return { ok: true, file: { path, name: path.split('/').pop(), fileId: ids.get(path) || `id:${path}`, bytes: 42, absolutePath: `${identity.cwd}/${path}` } };
    },
    async externalMetadata(path, grantId, conversationId) { calls.metadata.push({ path, grantId, conversationId }); return { ok: true, file: { absolutePath: path, name: 'external.txt', bytes: 20, fileId: 'external-object' } }; },
    async search(q, conversationId, options) { calls.search.push({ q, conversationId, options }); return { ok: true, workspace, matches: [{ name: 'deep.ts', path: 'src/nested/deep.ts', type: 'file' }] }; },
  };
  const mount = previewMount || ((target, request, options) => {
    const entry = { target, request, options, state: { ...options.state }, disposed: false };
    calls.preview.push(entry);
    const child = document.createElement('div'); child.className = 'fixture-preview'; child.textContent = request.path || request.name; target.append(child);
    options.onMetadata({ bytes: 42, fileId: request.fileId || 'id:from-preview' });
    return { ready: Promise.resolve(), getState: () => entry.state, dispose() { entry.disposed = true; calls.disposed.push(entry); target.replaceChildren(); } };
  });
  const panel = mountFilesPanel(host, view, { getIdentity: () => identity, transport: { ...defaults, ...transport }, previewMount: mount });
  const result = {
    host, view, calls, workspace, dirs, ids, size, panel,
    identity: () => identity,
    async open(path, fields = {}) { await panel.open({ path, cwd: identity.cwd, conversationId: identity.conversationId, ...fields }); },
    change(next, name = 'pi-gui:git-scope') { identity = { ...identity, ...next }; document.dispatchEvent(new dom.window.CustomEvent(name)); },
    row(path) { return [...host.querySelectorAll('.files-entry')].find((row) => row.dataset.filePath === path); },
    tab(path) { return [...host.querySelectorAll('.files-tab')].find((tab) => tab.dataset.fileTab === path); },
    dispose() { view.dispose(); host.remove(); },
  };
  made.push(result);
  return result;
}
function menuItem(label) { return [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim() === label); }

(async () => {
  ({ mountFilesPanel } = await import('../public/files-panel.js'));
  stateModule = await import('../public/files-state.js');
  surfaces = await import('../public/ui/secondary-surface.js');
  Object.defineProperty(document.querySelector('.app'), 'clientWidth', { value: 1000 });
  pane = (await import('../public/right-pane.js')).initRightPane();
  surfaces.configureSecondaryPane(pane);
  try {
    {
      const f = fixture(); await until(() => f.row('src'));
      check('root listing is lazy and the header has no persistent subtitle', () => {
        assert.deepEqual(f.calls.list.map((call) => call.path), ['']);
        assert.equal(f.host.querySelector('.rp-head-title,.rp-head-sub'), null);
        assert.equal(f.host.querySelectorAll('.files-preview-head').length, 1);
        assert.equal(f.host.querySelectorAll('[role="treeitem"][tabindex="0"]').length, 1);
      });
      f.row('src').focus(); event(f.row('src'), 'keydown', { key: 'ArrowRight' }); await until(() => f.row('src/app.js'));
      check('tree arrows expand lazily with opaque workspace identity', () => {
        assert.equal(f.calls.list[1].path, 'src');
        assert.equal(f.calls.list[1].options.workspace.id, f.workspace.id);
        assert.equal(f.row('src').getAttribute('aria-expanded'), 'true');
      });
      event(f.row('src'), 'keydown', { key: 'ArrowRight' });
      check('tree keyboard uses a single roving focus stop', () => {
        assert.equal(document.activeElement, f.row('src/app.js'));
        assert.equal(f.host.querySelectorAll('[role="treeitem"][tabindex="0"]').length, 1);
      });
      await f.open('src/nested/deep.ts'); await until(() => f.row('src/nested/deep.ts'));
      check('file entry expands ancestors and synchronizes tree selection', () => {
        assert.equal(f.row('src/nested').getAttribute('aria-expanded'), 'true');
        assert.equal(f.row('src/nested/deep.ts').getAttribute('aria-current'), 'page');
        assert.equal(f.calls.preview.length, 1);
      });
      const first = f.calls.preview[0]; first.state = { top: 250, left: 16, page: 3, content: 'MUST_NOT_PERSIST', grantId: 'SECRET' };
      await f.open('root.txt');
      check('switch disposes the old preview and carries only bounded reading state', () => {
        assert.equal(first.disposed, true);
        assert.deepEqual(f.panel.getState().tabs[0].state, { top: 250, left: 16, page: 3 });
        assert.equal(f.calls.preview.filter((entry) => !entry.disposed).length, 1);
      });
      f.tab('src/nested/deep.ts').querySelector('[role="tab"]').click();
      check('selecting an existing tab remounts one controller with its reading position', () => {
        assert.deepEqual(f.calls.preview.at(-1).options.state, { top: 250, left: 16, page: 3 });
        assert.equal(f.host.querySelectorAll('.files-tab').length, 2);
      });
      await f.open('src/nested/deep.ts', { line: 9, endLine: 12 });
      check('duplicate reference reuses the tab and replaces the explicit line target', () => {
        assert.equal(f.host.querySelectorAll('.files-tab').length, 2);
        assert.equal(f.calls.preview.at(-1).request.line, 9);
        assert.deepEqual(f.calls.preview.at(-1).options.state, {});
      });
      f.host.querySelector('.files-hidden-toggle').click(); await until(() => f.calls.list.filter((call) => call.path === '').length === 2 && f.row('src/nested/deep.ts'));
      check('hidden refresh preserves expansion and selection with explicit hidden flag', () => {
        assert.equal(f.calls.list.filter((call) => call.path === '').at(-1).options.hidden, true);
        assert.equal(f.row('src/nested').getAttribute('aria-expanded'), 'true');
        assert.equal(f.row('src/nested/deep.ts').getAttribute('aria-current'), 'page');
      });
      const divider = f.host.querySelector('.files-tree-resizer'); event(divider, 'keydown', { key: 'ArrowLeft' });
      check('tree resizer has an independent accessible value', () => assert.equal(divider.getAttribute('aria-valuenow'), '236'));
      const toggle = f.host.querySelector('.files-tree-toggle'); toggle.click();
      check('wide tree can be hidden without disposing the current preview', () => {
        assert.equal(f.host.querySelector('.files-sidebar').hidden, true);
        assert.equal(f.calls.preview.at(-1).disposed, false);
      });
      toggle.click(); f.size.width = 390; window.dispatchEvent(new dom.window.Event('resize'));
      check('narrow mode starts with the tree off-canvas instead of shrinking content', () => {
        assert.equal(f.host.classList.contains('files-narrow'), true);
        assert.equal(f.host.querySelector('.files-sidebar').hidden, true);
      });
      toggle.click();
      check('narrow toggle opens a dismissible tree overlay and isolates main focus', () => {
        assert.equal(f.host.querySelector('.files-tree-backdrop').hidden, false);
        assert.equal(f.host.querySelector('.files-main').inert, true);
      });
      event(f.row('src'), 'keydown', { key: 'Escape' });
      check('Escape closes only the tree overlay and returns focus', () => {
        assert.equal(f.host.querySelector('.files-sidebar').hidden, true);
        assert.equal(document.activeElement, toggle);
        assert.equal(f.host.querySelector('.files-main').inert, false);
      });
      pane.open('files');
      const max = document.getElementById('workPanelMaximize'); max.click();
      check('the common pane owns maximize and retains its remembered width', () => {
        assert.equal(pane.isMaximized(), true);
        assert.equal(pane.width(), 392);
        assert.equal(max.getAttribute('aria-label'), '还原工作面板');
        assert.equal(f.host.querySelector('.files-maximize'), null);
        assert.equal(document.getElementById('rightPane').style.width, '1000px');
      });
      max.click();
      check('the common restore control restores normal geometry', () => {
        assert.equal(pane.isMaximized(), false);
        assert.equal(document.getElementById('rightPane').style.width, '392px');
      });
      max.click(); f.dispose();
      check('disposing Files releases its preview without changing common maximize ownership', () => {
        assert.equal(pane.isMaximized(), true);
        assert.equal(f.calls.preview.filter((entry) => !entry.disposed).length, 0);
        assert.equal(document.getElementById('rightPane').classList.contains('files-pane-maximized'), false);
      });
      pane.close();
    }
    {
      const f = fixture(); await f.open('src/app.js'); await f.open('docs/app.js'); await f.open('root.txt');
      check('same-name labels use minimum distinguishing suffixes with full-path hover', () => {
        assert.equal(f.tab('src/app.js').querySelector('.files-tab-label').textContent, 'src/app.js');
        assert.equal(f.tab('docs/app.js').querySelector('.files-tab-label').textContent, 'docs/app.js');
        assert.equal(f.tab('src/app.js').querySelector('[role="tab"]').title, 'src/app.js');
      });
      const selected = () => f.host.querySelector('[role="tab"][aria-selected="true"]');
      selected().focus(); event(selected(), 'keydown', { key: 'Home' });
      check('tabs implement Home and focus follows selection', () => {
        assert.equal(selected().title, 'src/app.js');
        assert.equal(document.activeElement, selected());
      });
      event(selected(), 'keydown', { key: 'ArrowRight' });
      check('tab arrow switches to the adjacent file', () => assert.equal(selected().title, 'docs/app.js'));
      event(selected(), 'keydown', { key: 'ArrowRight', altKey: true, shiftKey: true });
      check('keyboard drag equivalent reorders without changing selected file', () => {
        assert.deepEqual(f.panel.getState().tabs.map((tab) => tab.path), ['src/app.js', 'root.txt', 'docs/app.js']);
        assert.equal(selected().title, 'docs/app.js');
      });
      const source = f.tab('docs/app.js'); const target = f.tab('src/app.js');
      source.dispatchEvent(new dom.window.Event('dragstart', { bubbles: true }));
      target.dispatchEvent(new dom.window.Event('drop', { bubbles: true, cancelable: true }));
      check('pointer tab drop reorders the real tab model', () => assert.deepEqual(f.panel.getState().tabs.map((tab) => tab.path), ['docs/app.js', 'src/app.js', 'root.txt']));
      const list = f.host.querySelector('.files-tablist');
      Object.defineProperty(list, 'scrollWidth', { configurable: true, value: 900 }); Object.defineProperty(list, 'clientWidth', { configurable: true, value: 200 });
      list.dispatchEvent(new dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 80 }));
      check('wheel scrolls the tab strip horizontally rather than the document', () => assert.equal(list.scrollLeft, 80));
      f.tab('src/app.js').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); menuItem('关闭右侧标签').click();
      check('tab context menu closes exactly the tabs to its right', () => assert.deepEqual(f.panel.getState().tabs.map((tab) => tab.path), ['docs/app.js', 'src/app.js']));
      f.host.querySelector('.files-tabs-menu').click(); menuItem('关闭其他标签').click();
      check('tab menu closes other tabs, keeping active preview', () => {
        assert.deepEqual(f.panel.getState().tabs.map((tab) => tab.path), ['docs/app.js']);
        assert.equal(f.calls.preview.at(-1).disposed, false);
      });
      await f.open('root.txt'); f.host.querySelector('.files-tabs-menu').click(); menuItem('关闭当前标签').click();
      check('closing current activates its neighbor and returns keyboard focus', () => {
        assert.equal(selected().title, 'docs/app.js'); assert.equal(document.activeElement, selected());
      });
      f.host.querySelector('.files-tabs-menu').click(); menuItem('关闭全部标签').click();
      check('close-all disposes the final controller and keeps an accessible empty state', () => {
        assert.equal(f.host.querySelectorAll('.files-tab').length, 0);
        assert.equal(f.calls.preview.at(-1).disposed, true);
        assert.equal(document.activeElement, f.host.querySelector('.files-tree-toggle'));
      });
      f.dispose();
    }
    {
      const f = fixture(); await f.open('root.txt', { content: 'PRIVATE_REQUEST_CONTENT', unexpected: { payload: 'PRIVATE_REQUEST_PAYLOAD' } }); await f.open('src/app.js');
      event(f.host.querySelector('.fixture-preview'), 'keydown', { key: 'PageUp', ctrlKey: true });
      check('preview-scoped Ctrl+PageUp cycles tabs and restores tab focus', () => {
        assert.equal(f.host.querySelector('[role="tab"][aria-selected="true"]').title, 'root.txt');
        assert.equal(document.activeElement, f.host.querySelector('[role="tab"][aria-selected="true"]'));
      });
      check('request descriptors do not retain arbitrary caller content', () => {
        assert.equal('content' in f.calls.preview[0].request, false);
        assert.equal('unexpected' in f.calls.preview[0].request, false);
      });
      event(f.host.querySelector('.fixture-preview'), 'keydown', { key: 'w', ctrlKey: true });
      check('preview-scoped Ctrl+W closes only the active file', () => assert.deepEqual(f.panel.getState().tabs.map((tab) => tab.path), ['src/app.js']));
      f.dispose();
    }
    {
      const gate = deferred();
      const f = fixture({ transport: { async metadata(path) {
        if (path === 'slow.txt') return gate.promise;
        return { ok: true, file: { fileId: `id:${path}`, name: path } };
      } } });
      const slow = f.open('slow.txt'); await tick(); await f.open('fast.txt'); gate.resolve({ ok: true, file: { fileId: 'id:slow.txt' } }); await slow;
      check('late earlier metadata cannot steal the newest open intent', () => {
        assert.deepEqual(f.panel.getState().tabs.map((tab) => tab.path), ['fast.txt']);
        assert.equal(f.calls.preview.length, 1);
      });
      const originalSession = f.identity().sessionId;
      const count = f.calls.preview.length; f.change({ sessionId: 'other-session' }); await tick();
      check('session identity change drops the old tabs even for the same cwd', () => {
        assert.equal(f.panel.getState().tabs.length, 0);
        assert.equal(f.calls.preview.length, count);
        assert.equal(f.calls.preview[0].disposed, true);
      });
      await f.open('other.txt'); f.change({ sessionId: originalSession });
      await until(() => f.panel.getState().tabs.some((tab) => tab.path === 'fast.txt'));
      check('returning to a prior native session restores its own requests, not its neighbor', () => assert.deepEqual(f.panel.getState().tabs.map((tab) => tab.path), ['fast.txt']));
      f.dispose();
    }
    {
      const late = deferred(); let captured;
      const f = fixture({ previewMount(target, request, options) {
        captured = { target, request, options, disposed: false };
        return { ready: late.promise, getState: () => ({ top: 75 }), dispose() { captured.disposed = true; target.replaceChildren(); } };
      } });
      await f.open('pending.txt'); f.dispose(); captured.options.onMetadata({ fileId: 'late-token', bytes: 999 }); late.resolve(); await tick();
      check('destroy during ready rejects late metadata and never remounts', () => {
        assert.equal(captured.disposed, true);
        assert.equal(f.host.querySelector('.files-preview').textContent, '');
        assert.equal(f.host.querySelectorAll('.files-tab').length, 0);
        assert.equal(f.panel.isCurrent(), false);
      });
    }
    {
      const gate = deferred();
      const f = fixture({ transport: { externalMetadata: () => gate.promise } });
      const pending = f.panel.open({ path: 'C:/outside/external.txt', external: true, grantId: 'grant-A', conversationId: null });
      await tick(); document.dispatchEvent(new dom.window.CustomEvent('pi-gui:external-grants', { detail: { revoked: 'grant-A' } }));
      gate.resolve({ ok: true, file: { name: 'external.txt', fileId: 'external-id' } }); await pending;
      check('grant revocation invalidates an in-flight external open', () => assert.equal(f.panel.getState().tabs.length, 0));
      f.dispose();
    }
    {
      const f = fixture(); await f.open('src/app.js');
      f.calls.preview.at(-1).state = { scrollTop: 87, page: 2, content: 'PRIVATE_BYTES', grantId: 'PRIVATE_GRANT' };
      await f.panel.open({ path: 'C:/outside/ext.txt', external: true, grantId: 'PRIVATE_GRANT', conversationId: null });
      await f.panel.open({ source: 'attachment', file: new dom.window.File(['PRIVATE_ATTACHMENT'], 'upload.txt'), name: 'upload.txt', path: 'C:/fake/unauthorized.txt' });
      const identity = { ...f.identity() }; f.dispose();
      const raw = localStorage.getItem(stateModule.FILES_STORAGE_KEY);
      const stored = JSON.parse(raw).scopes.find((item) => item.key === stateModule.scopeKey(identity)).value;
      check('persistence contains workspace requests/positions only, never grants or file bytes', () => {
        assert.equal(stored.tabs.length, 1);
        assert.equal(stored.tabs[0].path, 'src/app.js');
        assert.deepEqual(stored.tabs[0].state, { scrollTop: 87, page: 2 });
        assert.equal(/PRIVATE_|outside|upload\.txt|unauthorized/.test(raw), false);
      });
      const host = document.createElement('section'); document.getElementById('rightPane').append(host);
      const hooks = []; const calls = [];
      const restoredPanel = mountFilesPanel(host, { isCurrent: () => true, onDispose: (fn) => hooks.push(fn) }, {
        getIdentity: () => identity,
        transport: {
          list: async () => ({ ok: true, workspace: { id: 'after-restart', generation: '2' }, entries: [] }),
          metadata: async (path, conversationId, options) => { calls.push({ path, options }); return { ok: true, file: { fileId: 'replacement-id', absolutePath: `${identity.cwd}/${path}` } }; },
        },
        previewMount() { throw new Error('Restored replacement must not be read'); },
      });
      await until(() => host.textContent.includes('已变化'));
      check('restoring asks metadata with old fileId and refuses to read a replacement object', () => {
        assert.equal(calls.length, 1); assert.equal(calls[0].options.fileId, 'id:src/app.js');
        assert.equal(restoredPanel.getState().tabs.length, 1);
        assert.equal(host.querySelector('.files-preview-content'), null);
      });
      for (const fn of hooks.reverse()) fn(); host.remove();
    }
    {
      const first = fixture(); await first.open('src/app.js'); await until(() => first.row('src/app.js'));
      first.calls.preview.at(-1).state = { top: 321, zoom: 1.5 };
      const owner = { ...first.identity() }; first.dispose();
      const reopened = fixture({ owner }); await until(() => reopened.calls.preview.length === 1);
      check('reopening restores metadata-verified tabs and the controller reading position', () => {
        assert.equal(reopened.calls.metadata[0].options.fileId, 'id:src/app.js');
        assert.deepEqual(reopened.calls.preview[0].options.state, { top: 321, zoom: 1.5 });
        assert.equal(reopened.panel.getState().tabs.length, 1);
      });
      const count = reopened.calls.preview.length;
      reopened.change({ conversationId: 'different-conversation' }); await until(() => reopened.row('src'));
      check('conversation identity isolates tabs even with the same cwd and session', () => {
        assert.equal(reopened.panel.getState().tabs.length, 0);
        assert.equal(reopened.calls.preview.length, count);
      });
      reopened.change(owner); await until(() => reopened.calls.preview.length > count);
      check('returning to the exact conversation restores only its own tab set', () => assert.equal(reopened.panel.getState().tabs[0].path, 'src/app.js'));
      reopened.dispose();
    }
    {
      const gate = deferred();
      const f = fixture({ transport: { metadata: async (path) => path === 'late.txt' ? gate.promise : { ok: true, file: { fileId: `id:${path}`, name: path } } } });
      await f.open('root.txt'); await f.open('src/app.js');
      const pending = f.open('late.txt'); await tick();
      f.tab('root.txt').querySelector('[role="tab"]').click();
      gate.resolve({ ok: true, file: { fileId: 'id:late.txt' } }); await pending;
      check('an explicit tab selection invalidates a pending open without resurrecting it', () => {
        assert.equal(f.panel.getState().tabs.length, 2);
        assert.equal(f.host.querySelector('[role="tab"][aria-selected="true"]').title, 'root.txt');
      });
      f.dispose();
    }
    {
      let disposed = 0;
      const f = fixture({ previewMount() { return { ready: Promise.resolve(), getState: () => ({}), dispose() { disposed++; throw new Error('fixture cleanup failure'); } }; } });
      await f.open('root.txt'); f.size.width = 390; window.dispatchEvent(new dom.window.Event('resize'));
      f.host.querySelector('.files-tree-toggle').click(); const main = f.host.querySelector('.files-main');
      check('a failing plugin cleanup cannot prevent Files geometry or listeners from releasing', () => {
        assert.equal(main.inert, true);
        assert.doesNotThrow(() => f.dispose());
        assert.equal(disposed, 1);
        assert.equal(main.inert, false);
        assert.equal(document.getElementById('rightPane').classList.contains('files-pane-maximized'), false);
      });
    }
    {
      const f = fixture();
      for (let i = 0; i < 25; i++) await f.open(`tab-${i}.txt`);
      check('24-tab cap refuses a 25th without evicting or retaining extra controllers', () => {
        assert.equal(f.panel.getState().tabs.length, 24);
        assert.equal(f.calls.preview.length, 24);
        assert.equal(f.calls.preview.filter((entry) => !entry.disposed).length, 1);
      });
      f.dispose();
    }
    {
      const gates = [deferred(), deferred()]; let searches = 0;
      const f = fixture({ transport: { search(q, conversationId, options) { const gate = gates[searches++]; f.calls.search.push({ q, options }); return gate.promise; } } });
      await until(() => f.row('src'));
      const input = f.host.querySelector('.files-search-input'); input.value = 'old'; event(input, 'keydown', { key: 'Enter' });
      input.value = 'new'; event(input, 'keydown', { key: 'Enter' });
      gates[1].resolve({ ok: true, matches: [{ name: 'new.txt', path: 'new.txt', type: 'file' }] }); await until(() => f.row('new.txt'));
      gates[0].resolve({ ok: true, matches: [{ name: 'old.txt', path: 'old.txt', type: 'file' }] }); await tick();
      check('server search aborts stale requests and does not scan renderer directories', () => {
        assert.equal(f.row('old.txt'), undefined);
        assert.equal(f.calls.search[0].options.signal.aborted, true);
        assert.deepEqual(f.calls.list.map((call) => call.path), ['']);
        assert.equal(input.maxLength, 200);
      });
      event(input, 'keydown', { key: 'Escape' });
      check('Escape clears search and restores the lazy tree', () => { assert.equal(input.value, ''); assert.ok(f.row('src')); });
      f.dispose();
    }
    {
      const f = fixture({ transport: { search: async () => ({ ok: true, truncated: true, matches: Array.from({ length: 150 }, (_, i) => ({ path: `result-${i}.txt`, type: 'file' })) }) } });
      await until(() => f.row('src')); const input = f.host.querySelector('.files-search-input'); input.value = 'result'; event(input, 'keydown', { key: 'Enter' });
      await until(() => f.host.querySelectorAll('.files-entry').length === 100);
      check('search results are bounded to 100 rows and report truncation', () => { assert.equal(f.host.querySelectorAll('.files-entry').length, 100); assert.match(f.host.textContent, /前 100/); });
      f.dispose();
    }
    {
      const f = fixture();
      await f.panel.open({ path: 'C:/outside/private.zip', external: true, grantId: 'archive-grant', conversationId: null });
      const parent = f.calls.preview.at(-1);
      const source = new Uint8Array(1024); const view = source.subarray(25, 41); view[0] = 17;
      parent.options.onOpen({ source: 'archive', name: 'UNIQUE_ARCHIVE_CHILD.txt', bytes: view, parent: { external: true, grantId: 'forged' } });
      check('archive opens a local child with an exact-sized owned byte buffer and real parent owner', () => {
        const request = f.calls.preview.at(-1).request;
        assert.equal(request.source, 'archive');
        assert.equal(request.bytes.byteLength, 16);
        assert.equal(request.bytes.buffer.byteLength, 16);
        assert.notEqual(request.bytes.buffer, source.buffer);
        assert.equal(request.parent.grantId, 'archive-grant');
        assert.equal(request.external, undefined);
        assert.equal(f.calls.metadata.length, 1);
      });
      const childCount = f.panel.getState().tabs.length;
      await f.panel.open({ source: 'archive', name: 'UNIQUE_ARCHIVE_CHILD.txt', bytes: view, parent: parent.request });
      check('reopening the same archive child reuses its tab', () => assert.equal(f.panel.getState().tabs.length, childCount));
      document.dispatchEvent(new dom.window.CustomEvent('pi-gui:external-grants', { detail: { revoked: 'archive-grant' } }));
      check('revoking the ZIP parent grant closes its in-memory child and parent together', () => {
        assert.equal(f.panel.getState().tabs.length, 0);
        assert.equal(f.calls.preview.filter((entry) => !entry.disposed).length, 0);
      });
      f.dispose();
      check('archive child names and bytes are never persisted', () => assert.equal(localStorage.getItem(stateModule.FILES_STORAGE_KEY).includes('UNIQUE_ARCHIVE_CHILD'), false));
    }
    {
      const f = fixture();
      await f.panel.open({ source: 'attachment', attachmentId: 'draft-zip', file: new dom.window.File(['fixture'], 'draft.zip'), name: 'draft.zip' });
      f.calls.preview.at(-1).options.onOpen({ source: 'archive', name: 'draft-child.txt', archiveEntry: 'docs/draft-child.txt', bytes: new Uint8Array([65]) });
      assert.equal(f.panel.getState().tabs.length, 2);
      document.dispatchEvent(new dom.window.CustomEvent('pi-gui:attachment-revoked', { detail: { attachmentId: 'draft-zip' } }));
      check('revoking an attachment ZIP also disposes its active member and both tabs', () => {
        assert.equal(f.panel.getState().tabs.length, 0);
        assert.equal(f.calls.preview.filter(entry => !entry.disposed).length, 0);
      });
      f.dispose();
    }
    {
      const f = fixture();
      const parent = { path: 'bundle.zip', cwd: f.identity().cwd, conversationId: null, fileId: 'zip-object' };
      const eight = new Uint8Array(8 * 1024 * 1024);
      for (let i = 0; i < 5; i++) await f.panel.open({ source: 'archive', name: `part-${i}.txt`, bytes: eight, parent });
      check('archive aggregate budget rejects the fifth 8-MiB child without evicting another', () => {
        assert.equal(f.panel.getState().tabs.length, 4);
        assert.equal(f.calls.preview.length, 4);
      });
      await f.panel.open({ source: 'archive', name: 'oversize.txt', bytes: new Uint8Array(eight.byteLength + 1), parent });
      check('an archive child over 8 MiB never reaches a controller', () => assert.equal(f.calls.preview.length, 4));
      await f.panel.open({ source: 'archive', name: 'other-owner.txt', bytes: new Uint8Array(1), parent: { ...parent, conversationId: 'other' } });
      check('archive parent identity cannot cross conversations', () => assert.equal(f.calls.preview.length, 4));
      f.dispose();
    }
    {
      const gate = deferred(); let requested = false;
      const f = fixture({ transport: { async list(path) {
        await tick();
        if (path === '') return { ok: true, workspace: f.workspace, entries: [{ name: 'src', path: 'src', type: 'dir' }] };
        requested = true; return gate.promise;
      } } });
      await until(() => f.row('src')); f.row('src').click(); await until(() => requested); f.row('src').click();
      gate.resolve({ ok: true, workspace: f.workspace, entries: [{ name: 'late.txt', path: 'src/late.txt', type: 'file' }] }); await tick();
      check('collapsing a directory during lazy load is not undone by the late response', () => {
        assert.equal(f.row('src').getAttribute('aria-expanded'), 'false');
        assert.equal(f.row('src/late.txt'), undefined);
      });
      f.dispose();
    }
    for (const [path, expected] of [
      ['pages.pdf', { page: 3, zoom: 1.75, fitWidth: false, pageOffset: .45 }],
      ['slides.pptx', { page: 1, scale: '150' }],
      ['bundle.zip', { search: '中文', selected: 'docs/中文.txt', expanded: ['docs/', 'a/'] }],
    ]) {
      const f = fixture(); await f.open(path);
      f.calls.preview.at(-1).state = { ...expected, content: 'PRIVATE_DOCUMENT_BYTES', grantId: 'PRIVATE_GRANT' };
      await f.open('root.txt');
      f.tab(path).querySelector('[role="tab"]').click();
      check(path + ' keeps real plugin reading fields across a tab switch', () => assert.deepEqual(f.calls.preview.at(-1).options.state, expected));
      const identity = { ...f.identity() }; f.dispose();
      check(path + ' persists only the bounded plugin reading fields', () => {
        const stored = stateModule.readFilesState(identity, localStorage);
        assert.deepEqual(stored.tabs.find(tab => tab.path === path).state, expected);
        const raw = localStorage.getItem(stateModule.FILES_STORAGE_KEY);
        assert.equal(/PRIVATE_DOCUMENT_BYTES|PRIVATE_GRANT/.test(raw), false);
      });
    }
    check('additional reading fields have exact enum scalar path and aggregate bounds', () => {
      assert.deepEqual(stateModule.readingState({ pageOffset: 5, fitWidth: true, scale: 'fit', expanded: ['a/', 'a/', '../escape/', '/absolute/', 'C:/private/', 'valid/'], selected: '../secret', search: 'x'.repeat(257) }),
        { pageOffset: 1, fitWidth: true, scale: 'fit', expanded: ['a/', 'valid/'] });
      assert.deepEqual(stateModule.readingState({ pageOffset: -5, fitWidth: 'true', scale: 'arbitrary', expanded: [null, {}, 7], selected: 'a\u0000b', search: 'bad\nquery' }), { pageOffset: 0, expanded: [] });
      assert.equal(stateModule.readingState({ scale: 1.5 }).scale, 1.5, 'numeric image/PDF scales must remain supported');
      const many = Array.from({ length: 4096 }, (_, i) => `${i}-` + 'a'.repeat(900) + '/');
      const bounded = stateModule.readingState({ expanded: many, content: 'PRIVATE' });
      assert.ok(bounded.expanded.length > 0 && bounded.expanded.length <= 96);
      assert.ok(bounded.expanded.reduce((sum, value) => sum + value.length, 0) <= 8192);
    });
    check('reading preferences allow only fixed enums and known numeric/boolean values', () => {
      assert.deepEqual(stateModule.readingState({ mode: 'original', encoding: 'gb18030', volume: .5, muted: true, formulas: true, rendered: false, grantId: 'secret', content: 'bytes', toString: 'payload' }), { mode: 'original', encoding: 'gb18030', volume: .5, muted: true, formulas: true, rendered: false });
      assert.deepEqual(stateModule.readingState({ mode: 'arbitrary content', encoding: 'secret text' }), {});
    });
    check('storage LRU and reading-state projection remain bounded', () => {
      for (let i = 0; i < 12; i++) stateModule.writeFilesState({ cwd: 'C:/fixture/cache', sessionId: `cache-${i}` }, { tabs: Array.from({ length: 30 }, (_, j) => ({ path: `${j}.txt`, fileId: `id${j}`, state: { top: j, raw: 'do not keep' } })) });
      const data = JSON.parse(localStorage.getItem(stateModule.FILES_STORAGE_KEY));
      assert.equal(data.scopes.length, 6);
      assert.equal(data.scopes.at(-1).value.tabs.length, 24);
      assert.ok(localStorage.getItem(stateModule.FILES_STORAGE_KEY).length < 192 * 1024);
      assert.equal(localStorage.getItem(stateModule.FILES_STORAGE_KEY).includes('do not keep'), false);
    });
    await require('./fixtures/file-preview-selection-checks.cjs')(check);
    console.log(`file-preview-panel: ${checks} checks passed`);
  } finally {
    for (const f of made) f.dispose();
    surfaces.configureSecondaryPane(null);
    dom.window.close();
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
