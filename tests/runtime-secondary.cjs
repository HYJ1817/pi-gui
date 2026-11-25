const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
(async () => {
  let checks = 0; const ok = (name, value) => { assert.ok(value, name); checks++; console.log('PASS ' + name); };
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/' });
  for (const key of ['window', 'document', 'localStorage', 'sessionStorage', 'CustomEvent', 'MutationObserver']) global[key] = key === 'window' ? dom.window : dom.window[key];
  global.requestAnimationFrame = fn => setTimeout(fn, 0); global.cancelAnimationFrame = clearTimeout;
  const { runtimeStore: store } = await import('../public/runtime-state.js');
  const { createRuntimeSecondary } = await import('../public/runtime-secondary.js');
  const surfaces = await import('../public/ui/secondary-surface.js');
  const { initRightPane } = await import('../public/right-pane.js');
  const owner = id => ({ backendInstance: 'b', projectId: 'p', repoId: 'r', workspaceId: id, workspaceEpoch: 'e', conversationId: id, runtimeId: id, runtimeGeneration: 'g', sessionId: id });
  const browserScope = id => { const { repoId, ...scope } = owner(id); return scope; };
  store.seed({ backendInstance: 'b', items: ['A', 'B', 'D'].map(id => ({ conversationId: id, workspace: { branch: id }, owner: id === 'D' ? null : owner(id), lifecycle: id === 'D' ? 'dormant' : 'ready', activity: 'idle' })) });
  const pane = initRightPane(); let focusedId = 'classic';
  surfaces.configureSecondaryPane(pane, { getScope: () => focusedId });
  const states = new Set(), events = [], opened = new Set(); let late;
  const desktop = {
    status: async scope => ({ ok: true, opened: opened.has(scope.conversationId), browserState: { url: 'http://localhost/' + scope.conversationId }, available: false }),
    open: async scope => { opened.add(scope.conversationId); events.push(['open', scope.conversationId]); return { ok: true }; },
    command: async (scope, action) => { events.push([action, scope.conversationId]); if (action === 'close') opened.delete(scope.conversationId); return { ok: true }; },
    occluded: async (scope, value) => { events.push(['occluded', scope.conversationId, value]); return { ok: true }; },
    bounds: async () => ({ ok: true }), onState: f => { states.add(f); return () => states.delete(f); }, onAgentState: () => () => {}, onOpen: () => () => {},
  };
  window.piGuiDesktop = { runtimeBrowser: desktop };
  global.fetch = async (_url, opts = {}) => ({ json: async () => {
    if (!opts.body) return { ok: true, isRepo: true, files: [] };
    const body = JSON.parse(opts.body); events.push(body);
    if (body.action === 'process') {
      if (body.owner.conversationId === 'A') return new Promise(resolve => { late = resolve; });
      return { ok: true, available: true, enabled: true, generation: 'pb', processes: [] };
    }
    return { ok: true };
  } });
  const c = createRuntimeSecondary({ pane });
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  const focus = id => { focusedId = id; c.focus(id); };
  const leave = () => { c.leave(); focusedId = 'classic'; surfaces.syncSecondaryScope(); };
  surfaces.registerSecondaryTool({ id: 'browser', views: ['runtime-browser'], label: '浏览器', icon: 'globe', open: () => c.openBrowser() });
  surfaces.registerSecondaryTool({ id: 'process', label: '开发进程', icon: 'terminal', open: () => c.openProcesses() });
  focus('A'); c.openBrowser(); await tick();
  ok('Browser A uses captured owner', events.some(e => e[0] === 'open' && e[1] === 'A'));
  ok('Browser chrome replaces loading placeholder', !document.querySelector('.rp-body').textContent.includes('正在读取 Browser') && document.querySelectorAll('#browserToolbar').length === 1);
  focus('B'); await tick();
  ok('B without Browser does not display A or implicitly open Browser', !document.querySelector('#browserAddress') && pane.surface() === 'work-tools' && !opened.has('B'));
  ok('focus switch preserves A Browser', opened.has('A') && !events.some(e => e[0] === 'close' && e[1] === 'A'));
  c.openBrowser(); await tick(); ok('Browser B is independent', opened.has('B'));
  focus('A'); await tick(); c.openBrowser(); await tick();
  ok('return A explicitly activates its own URL', document.querySelector('#browserAddress').value === 'http://localhost/A');
  focus('B'); c.openBrowser(); await tick();
  document.querySelector('#browserAddress').blur();
  for (const f of states) f({ scope: browserScope('A'), state: { url: 'http://localhost/LATE-A' } });
  ok('background A event cannot replace B', document.querySelector('#browserAddress').value === 'http://localhost/B');
  for (const f of states) f({ scope: { ...browserScope('B'), runtimeGeneration: 'old' }, state: { url: 'http://localhost/STALE' } });
  ok('stale browser generation ignored', !document.querySelector('#browserAddress').value.includes('STALE'));
  for (const f of states) f({ scope: browserScope('B'), state: { url: 'http://localhost/B-current' } });
  ok('current full Browser owner still accepts live events', document.querySelector('#browserAddress').value === 'http://localhost/B-current');
  document.querySelector('#browserClose').click(); await tick(); ok('close B leaves A alive', !opened.has('B') && opened.has('A'));
  focus('A'); c.openBrowser(); await tick(); c.openProcesses(); await tick();
  ok('Process status captures A', events.some(e => e.action === 'process' && e.owner.conversationId === 'A'));
  ok('Browser detaches native view when Process opens', events.some(e => e[0] === 'occluded' && e[1] === 'A' && e[2] === true));
  focus('B'); c.openProcesses(); await tick();
  late({ ok: true, enabled: true, generation: 'pa', processes: [{ id: 'same', command: 'A PRIVATE', revision: 1, state: 'ready' }] }); await tick();
  ok('late A Process cannot update B pane', !document.querySelector('.rp-body').textContent.includes('A PRIVATE'));
  ok('Process B only uses B owner', events.filter(e => e.action === 'process').at(-1).owner.conversationId === 'B');
  focus('D'); c.openProcesses(); await tick(); ok('dormant pane explicit empty state', document.querySelector('.rp-body').textContent.includes('恢复'));
  leave(); ok('leaving runtime retires prior Process pane through the shell scope', !document.querySelector('.process-panel') && states.size === 0 && pane.surface() === 'work-tools');
  focus('A'); await tick();
  const initialStatus = desktop.status; let statusReply;
  desktop.status = () => new Promise(resolve => { statusReply = resolve; });
  c.openBrowser(); await tick();
  const changes = surfaces.openSecondarySurface('changes', host => { host.textContent = 'Current Changes fixture'; });
  statusReply({ ok: true, opened: true, browserState: { url: 'http://localhost/LATE' } }); await tick();
  ok('late Browser status does not replace Changes', pane.surface() === 'changes' && changes.isVisible() && document.querySelector('#browserAddress').closest('[role="tabpanel"]').hidden);
  surfaces.closeSecondarySurface('runtime-browser');
  c.openBrowser(); await tick(); pane.close();
  statusReply({ ok: true, opened: true }); await tick();
  ok('late Browser status cannot reveal hidden pane', !pane.isOpen() && surfaces.secondarySurfaceInstance('runtime-browser').isVisible() === false);
  surfaces.closeSecondarySurface('runtime-browser');
  c.openBrowser(); await tick(); surfaces.closeSecondarySurface('runtime-browser');
  statusReply({ ok: true, opened: true, browserState: { url: 'http://localhost/CLOSED' } }); await tick();
  ok('late Browser status cannot resurrect explicitly closed tab', !document.querySelector('#browserAddress') && states.size === 0);
  desktop.status = initialStatus;
  c.openBrowserSplit(); await tick();
  const splitBrowser = document.querySelector('#browserViewport');
  ok('Browser split uses existing runtime owner and Changes', pane.surface() === 'browser-changes-split' && splitBrowser && document.querySelector('.workbench-pane-changes'));
  const opensBefore = events.filter(e => e[0] === 'open').length;
  document.querySelector('#browserSplit').click(); await tick();
  ok('runtime split exits without native recreation', pane.surface() === 'runtime-browser' && document.querySelector('#browserViewport') === splitBrowser && events.filter(e => e[0] === 'open').length === opensBefore);
  c.openBrowserSplit(); await tick(); focus('B'); await tick();
  ok('focus change retires old split without replaying Browser or Process actions', !document.querySelector('.workbench-split') && !document.querySelector('#browserViewport') && !document.querySelector('.process-panel'));
  c.openBrowserSplit(); await tick();
  for (const f of states) f({ scope: browserScope('A'), state: { url: 'http://localhost/LEAK-A' } });
  ok('late A state cannot contaminate focused B split', document.querySelector('#browserAddress').value === 'http://localhost/B');
  for (let i = 0; i < 20; i++) { document.querySelector('#browserSplit').click(); await tick(); c.openBrowserSplit(); await tick(); }
  ok('twenty runtime layout transitions keep single Browser subscription', states.size === 1 && document.querySelectorAll('#browserViewport').length === 1);
  focus('D'); c.openBrowserSplit(); await tick();
  ok('dormant session explicitly opens scoped split empty state without old Browser', pane.surface() === 'browser-changes-split' && !document.querySelector('#browserViewport') && document.querySelector('.workbench-pane-browser').textContent.includes('恢复'));
  leave(); ok('runtime leave retires split and all subscriptions', !document.querySelector('.workbench-split') && states.size === 0);
  c.dispose(); for (const tab of surfaces.secondaryTabs()) surfaces.closeSecondarySurface(tab.id); pane.close(); dom.window.close();
  console.log(`Runtime secondary: ${checks}/${checks}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
