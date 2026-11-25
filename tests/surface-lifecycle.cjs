/* Integration regression for the actual Surface/Browser/Terminal/split owners.
 * All bridges/transports are offline fixtures; no shell, pi, user project,
 * grant, native page or file payload is created by these tests. */
const strict = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
let assertions = 0, cases = 0;
const assert = new Proxy(strict, { get(target, key) {
  const value = target[key];
  return typeof value === 'function' ? (...args) => { const result = value(...args); assertions++; return result; } : value;
} });
const check = (name, run) => { run(); cases++; console.log('PASS ' + name); };
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, name) => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(5); }
  throw new Error('Timeout: ' + name);
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let dom, surfaces, runtime;
(async () => {
  dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), {
    url: 'http://127.0.0.1/', pretendToBeVisual: true,
  });
  Object.assign(global, { window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
    MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
  const { S } = await import('../public/state.js');
  S.workspaceGeneration = 1; S.switching = false; S.cwd = '/fixture/readonly';
  const { initRightPane } = await import('../public/right-pane.js');
  surfaces = await import('../public/ui/secondary-surface.js');
  const { attachBrowserPane } = await import('../public/browser-pane.js');
  const { openSplitWorkbench } = await import('../public/ui/split-workbench.js');
  const { openChangesPanel } = await import('../public/git.js');
  const { openSpecsPanel } = await import('../public/specs-panel.js');
  const { openTerminalPanel } = await import('../public/terminal-panel.js');
  let statusReads = 0, specReads = 0;
  global.fetch = async url => ({ ok: true, json: async () => {
    if (String(url).startsWith('/api/git/status')) { statusReads++; return { ok: true, isRepo: true, files: [] }; }
    if (String(url).startsWith('/api/review-comments')) return { ok: false, code: 'owner_unavailable' };
    throw new Error('Unexpected fixture request: ' + url);
  } });
  const specTransport = {
    index: async () => { specReads++; return { ok: true, workspace: { id: 'workspace-A', generation: '1' }, documents: [] }; },
    document: async () => ({ ok: false }),
  };
  const app = document.querySelector('.app');
  Object.defineProperty(app, 'clientWidth', { value: 1320, configurable: true });
  document.getElementById('projectSidebar').getBoundingClientRect = () => ({ width: 240 });
  const pane = initRightPane();
  let scope = 'classic/session-A', identity = 'backend-A/epoch-1';
  surfaces.configureSecondaryPane(pane, { getScope: () => scope, getIdentity: () => identity });
  const empty = () => { for (const tab of surfaces.secondaryTabs()) surfaces.closeSecondarySurface(tab.id); };
  const openFilesStub = () => surfaces.openSecondarySurface('files', host => {
    const input = document.createElement('input'); input.value = 'Files owner fixture only'; host.append(input);
  }, { label: '文件' });
  const native = { opened: false, number: 0, closes: 0, events: [], states: new Set(), notices: new Set() };
  let openReply = null;
  const browserBridge = {
    open: async () => { if (!native.opened) { native.number++; native.opened = true; } native.events.push(['open', native.number]); return openReply ? openReply.promise : { ok: true }; },
    close: () => { native.closes++; native.opened = false; native.events.push(['close']); },
    navigate: async () => ({ ok: true }), back() {}, forward() {}, reload() {}, stop() {}, openExternal() {},
    setBounds: rect => native.events.push(['bounds', rect]), setOccluded: hidden => native.events.push(['hidden', hidden]),
    onState: fn => { native.states.add(fn); return () => native.states.delete(fn); },
    onNotice: fn => { native.notices.add(fn); return () => native.notices.delete(fn); }, onAgentOpen: () => () => {},
  };
  window.piGuiDesktop = { browser: browserBridge };
  const classic = attachBrowserPane(pane, { openWorkbench: openSplitWorkbench });
  for (const tool of [
    { id: 'changes', label: '文件变更', icon: 'changes', open: openChangesPanel },
    { id: 'specs', label: 'Specs', icon: 'fileText', open: () => openSpecsPanel({ transport: specTransport }) },
    { id: 'files', label: '文件', icon: 'folder', open: openFilesStub },
    { id: 'browser', views: ['runtime-browser'], label: '浏览器', icon: 'globe', open: () => classic.open() },
  ]) surfaces.registerSecondaryTool(tool);

  classic.open(); await tick();
  const chrome = classic.surface(), browserInstance = surfaces.secondarySurfaceInstance('browser');
  chrome.ui.address.blur();
  chrome.ui.viewport.getBoundingClientRect = () => ({ left: 700, top: 100, width: 390, height: 500 });
  for (const listener of native.states) listener({ url: 'http://localhost:3000/fixture', canGoBack: true });
  pane.refresh(); await tick();
  check('Classic Browser creates one native instance and one subscription', () => {
    assert.equal(native.number, 1); assert.equal(native.states.size, 1); assert.equal(chrome.ui.address.value, 'http://localhost:3000/fixture');
    assert.equal(native.events.filter(event => event[0] === 'hidden').at(-1)[1], false);
  });
  pane.close();
  check('hide immediately detaches native Browser without closing page or subscriptions', () => {
    assert.equal(native.events.filter(event => event[0] === 'hidden').at(-1)[1], true);
    assert.equal(native.closes, 0); assert.equal(native.opened, true); assert.equal(native.states.size, 1);
    assert.equal(browserInstance.isCurrent(), true); assert.equal(browserInstance.isVisible(), false);
  });
  native.events.length = 0; surfaces.showSecondaryPane(); await tick();
  check('show restores same native page only after receiving fresh viewport bounds', () => {
    assert.equal(classic.surface(), chrome); assert.equal(native.number, 1); assert.equal(native.closes, 0);
    const reveal = native.events.findIndex(event => event[0] === 'hidden' && !event[1]);
    assert.ok(reveal >= 0); assert.ok(native.events.slice(0, reveal).some(event => event[0] === 'bounds'));
  });
  openFilesStub(); await tick();
  check('switching to another tool hides Browser and keeps its live business owner', () => {
    assert.equal(native.closes, 0); assert.equal(native.states.size, 1); assert.equal(browserInstance.isCurrent(), true);
    assert.equal(browserInstance.isVisible(), false); assert.equal(native.events.filter(event => event[0] === 'hidden').at(-1)[1], true);
  });
  for (const listener of native.states) listener({ url: 'http://localhost:3000/background', title: 'fixture' });
  classic.open(); await tick();
  check('background state stays in its original Browser without native recreation', () => {
    assert.equal(classic.surface(), chrome); assert.equal(chrome.ui.address.value, 'http://localhost:3000/background'); assert.equal(native.number, 1);
  });
  const modal = document.getElementById('modal'); modal.hidden = false; await tick();
  pane.close(); surfaces.showSecondaryPane(); await tick();
  check('hiding and showing cannot clear a modal occlusion', () => assert.equal(native.events.filter(event => event[0] === 'hidden').at(-1)[1], true));
  modal.hidden = true; await tick();
  check('modal dismissal remeasures and reattaches the same native page', () => {
    assert.equal(native.events.filter(event => event[0] === 'hidden').at(-1)[1], false); assert.equal(native.number, 1);
  });
  const width = pane.width(), stored = { ...localStorage };
  document.getElementById('input').focus(); pane.setMaximized(true); await tick();
  check('maximum width is layout only and makes the covered chat inert without removing it', () => {
    assert.equal(pane.width(), width); assert.equal(pane.root.style.width, '1080px');
    assert.equal(document.getElementById('workspace').inert, true); assert.ok(document.getElementById('input').isConnected);
    assert.equal(document.activeElement, document.getElementById('workPanelMaximize'));
    assert.equal(document.getElementById('workPanelMaximize').getAttribute('aria-pressed'), 'true');
    assert.deepEqual({ ...localStorage }, stored);
  });
  pane.setMaximized(false); await tick();
  check('restore returns normal width and clears only its own inert state', () => {
    assert.equal(pane.root.style.width, width + 'px'); assert.equal(Boolean(document.getElementById('workspace').inert), false);
    assert.equal(pane.width(), width); assert.equal(document.getElementById('rightPaneResizer').hidden, false);
  });
  pane.setMaximized(true); pane.close();
  check('hide clears maximization but never overwrites normal width preferences', () => {
    assert.equal(pane.isMaximized(), false); assert.equal(pane.width(), width);
    assert.equal(Boolean(document.getElementById('workspace').inert), false); assert.deepEqual({ ...localStorage }, stored);
  });
  surfaces.showSecondaryPane();
  const retiredListener = [...native.states][0];
  surfaces.closeSecondarySurface('browser');
  retiredListener({ url: 'http://localhost:3000/stale-closed' });
  check('explicit Browser close releases native page and subscriptions exactly once', () => {
    assert.equal(native.closes, 1); assert.equal(native.states.size, 0); assert.equal(native.notices.size, 0);
    assert.equal(browserInstance.disposed, true); assert.equal(classic.surface(), null); assert.equal(chrome.host.isConnected, false);
    browserInstance.dispose(); assert.equal(native.closes, 1);
  });
  openReply = deferred(); classic.open(); const pendingChrome = classic.surface();
  surfaces.closeSecondarySurface('browser'); openFilesStub(); const focused = document.activeElement;
  openReply.resolve({ ok: true }); openReply = null; await tick();
  check('late native-open completion cannot focus or resurrect a closed Browser', () => {
    assert.equal(pendingChrome.host.isConnected, false); assert.equal(document.activeElement, focused);
    assert.equal(pane.surface(), 'files'); assert.equal(native.states.size, 0);
  });

  empty();
  const changes = openChangesPanel(); await tick();
  const changeHost = changes.host, statusBefore = statusReads;
  const split = openSplitWorkbench({ returnSurface: 'changes', specsOptions: { transport: specTransport } }); await tick();
  const specs = surfaces.secondarySurfaceInstance('specs'), specHost = specs.host;
  check('split borrows the same Changes singleton and prepares Specs with its full owner actions', () => {
    assert.equal(surfaces.secondarySurfaceInstance('changes'), changes); assert.equal(changes.host, changeHost);
    assert.equal(statusReads, statusBefore); assert.equal(specReads, 1);
    assert.equal(document.querySelectorAll('.chg-head').length, 1); assert.equal(document.querySelectorAll('.specs-layout').length, 1);
    assert.ok(specHost.querySelector('#btnSpecsSplit')); assert.ok(changeHost.querySelector('#btnChangesSplit'));
  });
  surfaces.closeSecondarySurface(split.view); surfaces.activateSecondarySurface('specs');
  check('closing a split returns child hosts rather than disposing business owners', () => {
    assert.equal(changes.isCurrent(), true); assert.equal(specs.isCurrent(), true);
    assert.equal(specHost.parentElement, pane.root.querySelector('.rp-body')); assert.equal(specHost.querySelectorAll('#btnSpecsSplit').length, 1);
  });
  for (let i = 0; i < 10; i++) {
    const layout = openSplitWorkbench({ specsOptions: { transport: specTransport } });
    surfaces.closeSecondarySurface(layout.view); surfaces.activateSecondarySurface('specs');
  }
  check('repeated split/exit has one live host per tool and no extra owner requests', () => {
    assert.equal(specReads, 1); assert.equal(statusReads, statusBefore);
    assert.equal(surfaces.secondarySurfaceInstance('specs'), specs); assert.equal(specs.host, specHost);
    assert.equal(document.querySelectorAll('#btnSpecsSplit').length, 1); assert.equal(document.querySelectorAll('#btnChangesSplit').length, 1);
  });
  const borrowed = openSplitWorkbench({ specsOptions: { transport: specTransport } });
  surfaces.closeSecondarySurface('changes');
  check('closing a borrowed child retires its layout but not the surviving sibling', () => {
    assert.equal(borrowed.disposed, true); assert.equal(changes.disposed, true); assert.equal(specs.isCurrent(), true); assert.equal(specs.host.isConnected, true);
  });
  empty();
  await require('./fixtures/surface-business-regressions.cjs')({
    surfaces, pane, S, assert, check, tick, openSplitWorkbench, specTransport, classic,
    remountScope: () => { identity += '/business-regression'; surfaces.syncSecondaryScope(); },
  });
  const oldResponse = deferred();
  surfaces.registerSecondaryTool({ id: 'late', label: 'Late', icon: 'fileText', open: () => surfaces.openSecondarySurface('late', (host, view) => {
    void oldResponse.promise.then(text => { if (view.isCurrent()) host.textContent = text; });
  }) });
  const late = surfaces.openSecondaryTool('late'); openFilesStub(); oldResponse.resolve('belongs only to the hidden live owner'); await tick();
  check('hidden isCurrent accepts own async results without changing active tool', () => {
    assert.equal(late.isCurrent(), true); assert.equal(late.isVisible(), false); assert.match(late.host.textContent, /hidden live owner/); assert.equal(pane.surface(), 'files');
  });
  const stale = deferred();
  const old = surfaces.openSecondarySurface('old-result', (host, view) => {
    void stale.promise.then(text => { if (view.isCurrent()) host.textContent = text; });
  });
  scope = 'classic/session-B'; identity = 'backend-A/epoch-2'; surfaces.syncSecondaryScope(); openFilesStub();
  stale.resolve('PRIVATE OLD SESSION'); await tick();
  check('retired scope rejects late payloads and cannot touch a new Surface host', () => {
    assert.equal(old.isCurrent(), false); assert.equal(old.disposed, true); assert.equal(old.host.textContent, '');
    assert.doesNotMatch(pane.root.textContent, /PRIVATE OLD SESSION/);
  });

  empty();
  const terminals = { sessions: [], creates: 0, closes: [], starts: 0, reads: 0, legacy: false, views: [] };
  let viewReply = null;
  const session = (id, ordinal = 1) => ({ id, ordinal, state: 'running', shell: 'fixture shell', cols: 80, rows: 24, workspace: { id: 'terminal-workspace', generation: '1' } });
  const terminalTransport = {
    status: async () => ({ ok: true, enabled: true }),
    list: async () => terminals.legacy ? { ok: false, code: 'invalid_action' } : { ok: true, workspace: { id: 'terminal-workspace', generation: '1' }, sessions: terminals.sessions },
    create: async () => { const value = session('pty-' + ++terminals.creates, terminals.creates); terminals.sessions.push(value); return { ok: true, session: value }; },
    start: async () => { terminals.starts++; return { ok: true, session: session('legacy') }; },
    read: async id => { terminals.reads++; return { ok: true, session: terminals.sessions.find(value => value.id === id), text: '', cursor: 0 }; },
    write: async () => ({ ok: true }), resize: async () => ({ ok: true }), stop: async () => ({ ok: true }),
    close: async id => { terminals.closes.push(id); return { ok: true }; },
  };
  const makeTerminalView = () => {
    const view = { focusCalls: 0, disposed: false, stdin: false, writes: [],
      fit() {}, focus() { this.focusCalls++; }, getSize: () => ({ cols: 80, rows: 24 }),
      write(text, callback) { this.writes.push(text); callback?.(); }, scrollToBottom() {}, isAtBottom: () => true,
      onData: () => ({ dispose() {} }), onResize: () => ({ dispose() {} }),
      setStdinEnabled(value) { this.stdin = value; }, dispose() { this.disposed = true; }, refreshTheme() {},
    };
    terminals.views.push(view); return view;
  };
  const openTerminal = () => openTerminalPanel({ transport: terminalTransport,
    createTerminalView: () => viewReply ? viewReply.promise : makeTerminalView() });
  surfaces.registerSecondaryTool({ id: 'terminal', label: '终端', icon: 'terminal', open: openTerminal });
  const terminal = openTerminal();
  await until(() => terminals.views[0]?.stdin, 'terminal startup');
  const termView = terminals.views[0], termElement = terminal.host.querySelector('.term-view');
  check('explicit Terminal open creates one PTY under one outer singleton', () => {
    assert.equal(terminals.creates, 1); assert.equal(terminal.host.querySelectorAll('.terminal-tab').length, 1); assert.equal(termView.disposed, false);
  });
  pane.close(); const beforeFocus = termView.focusCalls;
  const originalTimeout = global.setTimeout; const delays = [];
  global.setTimeout = (fn, ms, ...args) => { delays.push(ms); return originalTimeout(fn, ms, ...args); };
  try { await until(() => delays.includes(240), 'hidden controller cadence'); }
  finally { global.setTimeout = originalTimeout; }
  check('hidden Terminal retains controller, disables stdin and schedules its lower poll frequency', () => {
    assert.equal(termView.disposed, false); assert.equal(termView.stdin, false); assert.equal(termElement.hidden, true);
    assert.equal(termView.focusCalls, beforeFocus); assert.equal(terminals.closes.length, 0); assert.equal(terminal.isCurrent(), true);
  });
  surfaces.showSecondaryPane(); await tick();
  check('visibility restoration does not steal focus or rebuild the PTY/xterm', () => {
    assert.equal(terminals.views.length, 1); assert.equal(terminals.creates, 1); assert.equal(termView.focusCalls, beforeFocus); assert.equal(termView.stdin, true);
    assert.equal(terminal.host.querySelector('.term-view'), termElement);
  });
  terminal.host.querySelector('.terminal-new').click();
  await until(() => terminals.views.length === 2 && terminals.views[1].stdin, 'second terminal');
  openFilesStub(); await tick();
  check('outer tool switch hides all inner PTY tabs without ending either session', () => {
    assert.equal(terminals.creates, 2); assert.equal(terminal.host.querySelectorAll('.terminal-tab').length, 2);
    assert.ok(terminals.views.every(view => !view.disposed && !view.stdin)); assert.equal(terminals.closes.length, 0);
  });
  surfaces.activateSecondarySurface('terminal'); surfaces.closeSecondarySurface('terminal');
  check('explicit outer close destroys frontend controllers but never sends PTY close', () => {
    assert.ok(terminals.views.every(view => view.disposed)); assert.equal(terminals.closes.length, 0); assert.equal(terminals.sessions.length, 2);
  });
  openTerminal(); await until(() => terminals.views.length === 4 && terminals.views.some(view => view.stdin), 'relist existing PTYs');
  check('reopening Terminal lists the same backend PTYs without creating replacements', () => assert.equal(terminals.creates, 2));
  identity = 'backend-restarted'; terminals.sessions = []; surfaces.syncSecondaryScope();
  surfaces.activateSecondarySurface('terminal'); await tick(30);
  check('restoring a descriptor with an empty backend does not implicitly create a PTY', () => {
    const restored = surfaces.secondarySurfaceInstance('terminal'); assert.equal(restored.restored, true);
    assert.equal(terminals.creates, 2); assert.match(restored.host.textContent, /新建终端/); assert.equal(terminals.starts, 0);
  });
  terminals.legacy = true; identity = 'legacy-backend'; surfaces.syncSecondaryScope();
  surfaces.activateSecondarySurface('terminal'); await tick(30);
  check('legacy list fallback also preserves the no-implicit-start restoration boundary', () => {
    assert.equal(terminals.starts, 0); assert.equal(terminals.creates, 2);
  });
  empty(); terminals.legacy = false;
  viewReply = deferred(); openTerminal(); await tick(); pane.close();
  const waitingView = makeTerminalView(); viewReply.resolve(waitingView); viewReply = null; await tick(30);
  check('late xterm setup while hidden cannot steal focus or accept keyboard input', () => {
    assert.equal(waitingView.focusCalls, 0); assert.equal(waitingView.stdin, false); assert.equal(waitingView.disposed, false);
  });
  empty();

  const { runtimeStore: store } = await import('../public/runtime-state.js');
  const { createRuntimeSecondary } = await import('../public/runtime-secondary.js');
  const owner = id => ({ backendInstance: 'fixture-backend', projectId: 'project', repoId: 'repo', workspaceId: 'workspace-' + id,
    workspaceEpoch: 'epoch-' + id, conversationId: id, runtimeId: 'runtime-' + id, runtimeGeneration: 'generation-' + id, sessionId: 'session-' + id });
  store.seed({ backendInstance: 'fixture-backend', items: ['A', 'B'].map(id => ({ conversationId: id,
    nativeSessionId: 'session-' + id, workspace: { projectId: 'project', workspaceId: 'workspace-' + id, workspaceEpoch: 'epoch-' + id },
    owner: owner(id), lifecycle: 'ready', activity: 'idle' })) });
  const nativeByOwner = new Set(), runtimeEvents = [], stateListeners = new Set();
  let statusReply = null;
  const runtimeBridge = {
    status: async captured => statusReply ? statusReply.promise : ({ ok: true, opened: nativeByOwner.has(captured.conversationId), browserState: { url: 'http://localhost/' + captured.conversationId } }),
    open: async captured => { nativeByOwner.add(captured.conversationId); runtimeEvents.push(['open', captured.conversationId]); return { ok: true }; },
    command: async (captured, action) => { runtimeEvents.push([action, captured.conversationId]); if (action === 'close') nativeByOwner.delete(captured.conversationId); return { ok: true }; },
    occluded: async (captured, hidden) => { runtimeEvents.push(['hidden', captured.conversationId, hidden]); return { ok: true }; },
    bounds: async () => ({ ok: true }), enable: async () => ({ ok: true }),
    onState: fn => { stateListeners.add(fn); return () => stateListeners.delete(fn); }, onAgentState: () => () => {}, onOpen: () => () => {},
  };
  window.piGuiDesktop.runtimeBrowser = runtimeBridge;
  runtime = createRuntimeSecondary({ pane });
  surfaces.registerSecondaryTool({ id: 'browser', views: ['runtime-browser'], label: '浏览器', icon: 'globe', open: () => runtime.openBrowser() });
  scope = 'runtime/A'; identity = JSON.stringify(owner('A')); runtime.focus('A'); runtime.openBrowser(); await tick(30);
  const runtimeA = surfaces.secondarySurfaceInstance('runtime-browser'), addressA = runtimeA.host.querySelector('#browserAddress');
  addressA.blur();
  pane.close(); openFilesStub();
  check('Runtime hide/switch occludes captured owner A without closing its native resource', () => {
    assert.ok(runtimeEvents.some(event => event[0] === 'hidden' && event[1] === 'A' && event[2]));
    assert.equal(nativeByOwner.has('A'), true); assert.equal(runtimeEvents.some(event => event[0] === 'close'), false);
    assert.equal(runtimeA.isCurrent(), true);
  });
  scope = 'runtime/B'; identity = JSON.stringify(owner('B')); runtime.focus('B'); runtime.openBrowser(); await tick(30);
  const runtimeB = surfaces.secondarySurfaceInstance('runtime-browser'); runtimeB.host.querySelector('#browserAddress').blur();
  for (const listener of stateListeners) listener({ scope: owner('A'), state: { url: 'http://localhost/PRIVATE-A' } });
  check('Runtime scope changes detach old owner and reject cross-owner native state', () => {
    assert.equal(runtimeA.disposed, true); assert.equal(nativeByOwner.has('A'), true);
    assert.equal(runtimeB.host.querySelector('#browserAddress').value, 'http://localhost/B'); assert.equal(stateListeners.size, 1);
  });
  surfaces.closeSecondarySurface('runtime-browser');
  check('Runtime explicit close targets B only, never the previously focused A', () => {
    assert.equal(nativeByOwner.has('B'), false); assert.equal(nativeByOwner.has('A'), true);
    assert.deepEqual(runtimeEvents.filter(event => event[0] === 'close'), [['close', 'B']]); assert.equal(stateListeners.size, 0);
  });
  statusReply = deferred(); runtime.openBrowser(); await tick();
  surfaces.closeSecondarySurface('runtime-browser'); openFilesStub();
  statusReply.resolve({ ok: true, opened: false }); statusReply = null; await tick(30);
  check('late Runtime status after tab close cannot create native Browser or replace another tool', () => {
    assert.equal(nativeByOwner.has('B'), false); assert.equal(pane.surface(), 'files'); assert.equal(stateListeners.size, 0);
  });
  runtime.dispose(); runtime = null;
  console.log(`Surface lifecycle: ${assertions}/${assertions} assertions; ${cases} categories; 0 skipped`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  runtime?.dispose(); surfaces?.configureSecondaryPane(null); dom?.window.close();
});
