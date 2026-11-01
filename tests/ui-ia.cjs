/* P30: exercise the assembled UI, never real projects or Pi. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');
let passed = 0, failed = 0;
async function check(name, run) { try { await run(); passed++; console.log(' ok ' + name); } catch (e) { failed++; console.error(' FAIL ' + name + ': ' + e.message); } }
const tick = () => new Promise(r => setTimeout(r, 40));
(async () => {
  const pub = path.resolve(__dirname, '../public');
  const dom = new JSDOM(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'), { url: 'http://localhost:7788', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document, $ = id => d.getElementById(id);
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.EventSource = class { constructor() { w.fixtureEvents = this; } close() {} };
  w.fetch = async url => ({ ok: true, json: async () => {
    if (String(url) === '/api/status') return { ok: true, cwd: 'C:\\fixture', hasProject: true };
    if (String(url) === '/api/projects') return { ok: true, active: 'C:\\fixture', items: [{ name: 'Fixture', path: 'C:\\fixture' }] };
    if (String(url) === '/api/git/status') return { ok: true, isRepo: true, files: [{ path: 'a.txt', status: 'M', working: 'M' }] };
    if (String(url).startsWith('/api/git/diff')) return { ok: true, working: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new', staged: '' };
    if (String(url) === '/api/sessions') return { ok: true, sessions: [] };
    return { ok: true, providers: [], counts: {}, plans: [], agents: [] };
  } });
  let nativeCloses = 0;
  w.piGuiDesktop = { browser: { open: async () => ({ ok: true }), close: () => nativeCloses++,
    back() {}, forward() {}, stop() {}, reload() {}, openExternal() {}, setBounds() {}, setOccluded() {},
    onState: () => () => {}, onNotice: () => () => {} } };
  w.eval(bundle(path.join(pub, 'app.js')).code); await tick();
  w.S.hasProject = true; w.S.bridgeState = 'ready'; w.S.restoring = false; w.applyProjectState();
  await check('Changes is contextual, absent from global navigation', () => {
    assert.equal(d.querySelector('#globalRail #navChanges'), null);
    assert.ok(d.querySelector('#workPanelNav #navChanges'));
    assert.equal(d.querySelector('.head-right #navChanges'), null);
    assert.ok(d.querySelector('.head-right #btnWorkPanel'));
  });
  await check('Settings has all five logical groups and bound actions', () => {
    $('navGlobalMore').click();
    const labels = [...d.querySelectorAll('#globalMoreMenu h3')].map(n => n.textContent);
    for (const name of ['模型与账户', 'Agent 能力', '扩展与 MCP', '应用与更新', '诊断']) assert.ok(labels.includes(name), name);
    assert.ok([...$('globalMoreMenu').querySelectorAll('button')].every(b => typeof b.onclick === 'function'));
  });
  await check('Settings Escape returns focus to its visible trigger', () => {
    d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal($('globalMoreMenu').hidden, true); assert.equal(d.activeElement, $('navGlobalMore'));
  });
  await check('Tasks and resources live in Settings; returning preserves draft and chat node', async () => {
    Object.defineProperty($('stream'), 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty($('stream'), 'clientHeight', { value: 400, configurable: true });
    const chat = $('chatView'); $('input').value = 'settings round trip'; $('stream').scrollTop = 83;
    $('navGlobalMore').click();
    assert.equal($('workspace').dataset.workspaceView, 'settings');
    assert.ok($('globalMoreMenu').contains($('navPlanner')));
    assert.ok($('globalMoreMenu').contains($('navExtensions')));
    $('navPlanner').click(); await tick();
    assert.equal($('workspace').dataset.workspaceView, 'planner');
    assert.equal($('globalMoreMenu').hidden, false);
    $('settingsReturn').click();
    assert.equal($('chatView'), chat); assert.equal($('input').value, 'settings round trip');
    assert.equal($('stream').scrollTop, 83); assert.equal($('globalMoreMenu').hidden, true);
  });
  await check('Work panel launcher contains only live registered tools and preserves chat', () => {
    $('btnWorkPanel').click();
    assert.equal($('rightPane').hidden, false);
    assert.ok($('workPanelNav').contains($('btnBrowser')));
    assert.equal($('workspace').dataset.workspaceView, 'chat');
    $('btnWorkPanel').click(); assert.equal($('rightPane').hidden, true);
  });
  await check('Settings keeps the work panel entrance visible and close restores it', () => {
    $('navGlobalMore').click();
    assert.equal($('btnWorkPanel').hidden, false);
    $('btnWorkPanel').click(); assert.equal($('rightPane').hidden, false);
    $('workPanelClose').focus(); $('workPanelClose').click();
    assert.equal(d.activeElement, $('btnWorkPanel'));
    $('settingsReturn').click();
  });
  await check('Settings return restores Runtime scope and draft through the composition owner', async () => {
    const owner = { backendInstance: 'fixture', projectId: 'p', repoId: 'repo', workspaceId: 'ws', workspaceEpoch: 'one', conversationId: 'A', runtimeId: 'rt', runtimeGeneration: 'one', sessionId: 'native-A' };
    w.runtimeStore.seed({ backendInstance: 'fixture', items: [{ conversationId: 'A', createdAt: '2026-01-01T00:00:00.000Z', nativeSessionId: 'native-A', owner, workspace: { projectId: 'p', workspaceId: 'ws', workspaceEpoch: 'one', cwd: 'C:\\fixture' }, lifecycle: 'ready', activity: 'idle' }] });
    await w.focusRuntimeById('A'); await tick();
    const input = d.querySelector('#runtimeView .runtime-conversation > textarea');
    input.value = 'Runtime draft'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
    const fetchBefore = w.fetch; const actions = [];
    w.fetch = (url, options) => { if (options?.body) actions.push(JSON.parse(options.body)); return fetchBefore(url, options); };
    $('navGlobalMore').click(); assert.equal(w.gitConversationScope(), null);
    $('settingsReturn').click(); await tick();
    assert.equal($('workspace').dataset.workspaceView, 'runtime');
    assert.equal(w.gitConversationScope(), 'A');
    assert.ok(actions.some(action => action.action === 'blur' && action.owner.sessionId === 'native-A'));
    assert.ok(actions.some(action => action.action === 'focus' && action.owner.sessionId === 'native-A'));
    assert.equal(input.value, 'Runtime draft'); assert.equal(d.activeElement, input);
    w.fetch = fetchBefore; $('navHome').click();
  });
  await check('Rejected Runtime focus keeps Settings visible and offers retry', async () => {
    await w.focusRuntimeById('A'); $('navGlobalMore').click();
    const fetchBefore = w.fetch;
    try {
      w.fetch = (url, options) => options?.body && JSON.parse(options.body).action === 'focus'
        ? Promise.resolve({ ok: true, json: async () => ({ ok: false }) }) : fetchBefore(url, options);
      $('settingsReturn').click(); await tick();
      assert.equal($('workspace').dataset.workspaceView, 'settings');
      assert.equal(d.querySelector('.settings-return-status').hidden, false);
      assert.equal(w.gitConversationScope(), null);
    } finally { w.fetch = fetchBefore; $('navHome').click(); }
  });
  await check('Late Runtime return cannot replace a newer navigation intent', async () => {
    await w.focusRuntimeById('A'); $('navGlobalMore').click();
    const fetchBefore = w.fetch; let release;
    try {
      w.fetch = (url, options) => options?.body && JSON.parse(options.body).action === 'focus'
        ? new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ok: true }) }); }) : fetchBefore(url, options);
      $('settingsReturn').click(); $('navPlanner').click();
      release(); await tick();
      assert.equal($('workspace').dataset.workspaceView, 'planner'); assert.equal(w.gitConversationScope(), null);
      assert.equal(d.querySelector('.settings-return-status').hidden, true);
    } finally { w.fetch = fetchBefore; $('navHome').click(); }
  });
  for (const method of ['click', 'Enter']) await check('Palette Settings hands off menu and focus via ' + method, async () => {
    $('input').focus(); w.openPalette();
    const query = d.querySelector('.palette-input'); query.value = '设置';
    query.dispatchEvent(new w.Event('input', { bubbles: true }));
    if (method === 'click') d.querySelector('[data-command-id="app.preferences"]').click();
    else query.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(); assert.equal($('globalMoreMenu').hidden, false);
    assert.equal(d.activeElement, $('navProviders'));
    d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await check('Changes preserves mounted conversation, scroll and draft', async () => {
    $('input').value = 'draft'; $('stream').scrollTop = 71;
    $('navChanges').click(); await tick();
    assert.equal($('workspace').dataset.workspaceView, 'chat');
    assert.equal($('chatView').hidden, false); assert.equal($('chatComposer').hidden, false);
    assert.equal($('rightPane').hidden, false); assert.equal($('rightPane').dataset.surface, 'changes');
    assert.equal($('input').value, 'draft'); assert.equal($('stream').scrollTop, 71);
    assert.equal(d.querySelectorAll('#rightPane .chg-row').length, 1);
    d.querySelector('#rightPane .chg-main').click(); await tick();
    assert.equal(d.querySelector('#rightPane .chg-diff').hidden, false);
  });
  await check('Changes close releases content and restores contextual focus', () => {
    $('rightPaneClose').click();
    assert.equal($('rightPane').hidden, true); assert.equal(d.querySelector('#rightPane .chg-row'), null);
    assert.equal($('navChanges').getAttribute('aria-pressed'), 'false'); assert.equal(d.activeElement, $('btnWorkPanel'));
  });
  await check('Browser → Changes disposes native view; no duplicate surfaces', async () => {
    $('btnBrowser').click(); await tick(); assert.ok(d.querySelector('#browserViewport'));
    $('navChanges').click(); await tick();
    assert.equal(d.querySelector('#browserViewport'), null); assert.ok(nativeCloses > 0);
    assert.equal($('btnBrowser').getAttribute('aria-pressed'), 'false');
    assert.equal(d.querySelectorAll('#rightPane .rp-surface').length, 1);
  });
  await check('Changes → Browser invalidates old Changes owner', async () => {
    $('btnBrowser').click(); await tick();
    assert.equal(d.querySelector('#rightPane .chg-row'), null); assert.ok(d.querySelector('#browserViewport'));
    await w.refreshGitNow(); assert.equal(d.querySelector('#rightPane .chg-row'), null);
    assert.equal($('navChanges').getAttribute('aria-pressed'), 'false');
  });
  await check('Only one current-project New and Search action', async () => {
    await w.loadProjects(); assert.equal(d.querySelectorAll('.project.active .pj-header-action').length, 0);
    assert.ok($('navNew')); assert.ok($('navSearch'));
  });
  await check('Sidebar collapse hands focus to expand, and back', () => {
    $('btnSidebarCollapse').focus(); $('btnSidebarCollapse').click(); assert.equal(d.activeElement, $('btnSidebarExpand'));
    $('btnSidebarExpand').click(); assert.equal(d.activeElement, $('btnSidebarCollapse'));
  });
  await check('Stop pending disables its visible control until authoritative confirmation', async () => {
    const original = w.fetch; let release;
    w.fetch = (url, opts) => String(url) === '/api/command' && JSON.parse(opts.body).type === 'abort'
      ? new Promise(r => { release = () => r({ ok: true, json: async () => ({ ok: true }) }); }) : original(url, opts);
    w.setStreaming(true); const stopping = w.stop(); await tick();
    assert.equal($('btnStop').disabled, true); assert.equal($('btnSend').disabled, true);
    release(); await stopping;
    assert.equal($('btnStop').disabled, false); w.fetch = original;
  });
  dom.window.close(); console.log(`\nP30 IA ${passed}/${passed + failed} passed`); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
