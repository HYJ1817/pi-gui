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
  w.fetch = async url => {
    const target = String(url);
    // 默认装配关闭管理接口；真实服务回 422 unsupported。旧列表是兼容路径，
    // 不能让一个缺少管理合同字段的 200 被误判成可用或合同异常。
    if (target === '/api/provider-management') {
      return { status: 422, ok: false, json: async () => ({ ok: false, code: 'unsupported', message: '管理能力未开放' }) };
    }
    return { ok: true, json: async () => {
      if (target === '/api/status') return { ok: true, cwd: 'C:\\fixture', hasProject: true };
      if (target === '/api/projects') return { ok: true, active: 'C:\\fixture', items: [{ name: 'Fixture', path: 'C:\\fixture' }] };
      if (target === '/api/git/status') return { ok: true, isRepo: true, files: [{ path: 'a.txt', status: 'M', working: 'M' }] };
      if (target.startsWith('/api/git/diff')) return { ok: true, working: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new', staged: '' };
      if (target === '/api/sessions') return { ok: true, sessions: [] };
      return { ok: true, providers: [], counts: {}, plans: [], agents: [] };
    } };
  };
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
  await check('extension subpages project their real current navigation and title', async () => {
    for (const [id, tab, title] of [['navMcp', 'mcp', 'MCP 配置'], ['navCapabilities', 'capabilities', '能力状态'], ['navExtensions', 'skills', 'Skills 与扩展']]) {
      $(id).click(); await tick();
      assert.equal(d.querySelector('.ext-tab[aria-selected="true"]').dataset.tab, tab);
      assert.equal(d.querySelector('#globalMoreMenu [aria-current="page"]').id, id);
      assert.equal($('workViewTitle').textContent, title);
    }
    $('extensionsTabMcp').click();
    assert.equal(d.querySelector('#globalMoreMenu [aria-current="page"]').id, 'navMcp');
    assert.equal($('workViewTitle').textContent, 'MCP 配置');
    $('navGlobalMore').click();
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
    assert.equal($('navPlanner').getAttribute('aria-current'), 'page');
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
  await check('Settings leaf is a central page with selected directory and no modal', async () => {
    const chat = $('chatView'); $('input').value = 'detail draft';
    $('navGlobalMore').click(); $('navProviders').click(); await tick();
    assert.equal($('workspace').dataset.workspaceView, 'settings');
    assert.equal($('modal').hidden, true);
    assert.ok(d.querySelector('#workSurface .settings-detail-card .providers'));
    assert.equal($('navProviders').getAttribute('aria-current'), 'page');
    assert.equal($('chatView'), chat); assert.equal($('input').value, 'detail draft');
    d.querySelector('.settings-detail-card .modal-actions button:last-child').click();
    assert.ok(d.querySelector('#workSurface .settings-section'));
    $('settingsReturn').click();
  });
  await check('Settings detail disposes once and stale close cannot close a new detail', () => {
    const isolated = new JSDOM(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'), { url: 'http://localhost:7788', runScripts: 'outside-only', pretendToBeVisual: true });
    const module = isolated.window.eval(bundle(path.join(pub, 'ui/settings-surface.js')).code);
    const surface = module.initSettingsSurface();
    let oldClose, disposed = 0;
    surface.presentDetail('navProviders', (card, close) => { oldClose = close; card.textContent = 'old'; }, () => disposed++);
    surface.presentDetail('navLogs', card => { card.textContent = 'current'; });
    assert.equal(disposed, 1); oldClose(); assert.equal(disposed, 1);
    assert.equal(isolated.window.document.querySelector('.settings-detail-card').textContent, 'current');
    module.showChat(); assert.equal(disposed, 1); isolated.window.close();
  });
  await check('Late settings diagnostic result cannot replace the appearance page', async () => {
    const before = w.fetch; let release;
    try {
      w.fetch = (url, options) => String(url) === '/api/diagnostics' ? new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ok: false, error: 'fixture late' }) }); }) : before(url, options);
      $('navGlobalMore').click(); $('navDiagnostics').click();
      const oldCard = d.querySelector('.settings-detail-card');
      $('navAppearance').click(); release(); await tick();
      assert.equal(oldCard.isConnected, false);
      assert.equal(d.querySelector('.settings-detail-card h3').textContent, '外观与主题');
      assert.equal($('modal').hidden, true);
    } finally { w.fetch = before; $('settingsReturn').click(); }
  });
  await check('Danger confirmation Escape keeps settings detail mounted', async () => {
    $('navGlobalMore').click(); $('navAppearance').click();
    const card = d.querySelector('.settings-detail-card');
    const answer = w.confirmModal({ title: 'Fixture confirmation', message: 'No real operation', danger: true });
    d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(await answer, false); assert.equal(card.isConnected, true);
    assert.equal($('workspace').dataset.workspaceView, 'settings');
    $('settingsReturn').click();
  });
  await check('Late provider save cannot reopen its page after newer navigation', async () => {
    const before = w.fetch; let release;
    const snapshot = {
      ok: true, schemaVersion: 1, revision: 'ui-ia-revision',
      capabilities: { rawKeyInput: false, keyStaging: false, nativeCredentialPersistence: false, privateDesktopBridge: false, oauthLogin: false, discoveryModes: [], modelOverrides: null, syncMode: 'unsupported', reasons: {} },
      catalog: [{ id: 'custom', name: '自定义服务', category: 'api-key', connection: null, authMode: 'environment' }],
      services: [], auth: { sdkAvailable: false, providers: [] }, sync: { state: 'idle' },
    };
    const input = (node, value) => {
      node.value = value;
      node.dispatchEvent(new w.Event('input', { bubbles: true }));
    };
    try {
      w.fetch = (url, options) => {
        const target = String(url);
        const method = options?.method || 'GET';
        if (target === '/api/provider-management' && method === 'GET') {
          return Promise.resolve({ ok: true, json: async () => snapshot });
        }
        if (target === '/api/provider-management/drafts' && method === 'POST') {
          return Promise.resolve({ ok: true, json: async () => ({ ok: true, draftId: 'late-draft', draftRevision: 2, revision: snapshot.revision }) });
        }
        if (target === '/api/provider-management/commit' && method === 'POST') {
          return new Promise(resolve => {
            release = () => resolve({
              ok: true,
              json: async () => ({ ok: true, serviceId: 'fixture-ui', saved: true, credentialSaved: null, credentialState: 'saved', sync: { state: 'pending', reason: 'runtime_sync_pending' }, revision: 'ui-ia-next' }),
            });
          });
        }
        return before(url, options);
      };
      $('navGlobalMore').click(); $('navProviders').click(); await tick();
      [...d.querySelectorAll('.settings-detail-card button')].find(b => b.textContent === '添加服务').click(); await tick();
      const modalCard = $('modalCard');
      [...modalCard.querySelectorAll('.pm-service-tile')].find(tile => tile.dataset.serviceId === 'custom').click(); await tick();
      input(modalCard.querySelector('[aria-label="服务名称"]'), 'Fixture UI');
      input(modalCard.querySelector('.pm-provider-id'), 'fixture-ui');
      input(modalCard.querySelector('[data-connection-base-url]'), 'http://127.0.0.1:7788');
      input(modalCard.querySelector('.pm-env-input'), '$FIXTURE_KEY');
      modalCard.querySelector('.pm-dialog-actions .pm-primary').click(); await tick();
      assert.equal(typeof release, 'function');
      $('navAppearance').click(); const current = d.querySelector('.settings-detail-card');
      release(); await tick(); await tick();
      assert.equal(d.querySelector('.settings-detail-card'), current);
      assert.equal(current.querySelector('h3').textContent, '外观与主题');
      assert.equal($('modal').hidden, true);
    } finally { w.fetch = before; $('settingsReturn').click(); }
  });
  await check('Settings leaf Escape returns to settings without losing chat draft', () => {
    $('input').value = 'page escape draft'; $('navGlobalMore').click(); $('navAppearance').click();
    d.querySelector('.settings-detail-card select').focus();
    d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(d.querySelector('#workSurface .settings-section'));
    assert.equal(d.activeElement, $('navAppearance'));
    $('settingsReturn').click(); assert.equal($('input').value, 'page escape draft');
  });
  await check('Ordinary modal cannot invalidate the central provider render owner', async () => {
    const before = w.fetch; let removed = false;
    try {
      w.fetch = (url, options) => String(url) === '/api/providers' ? Promise.resolve({ ok: true, json: async () => ({ ok: true, providers: removed ? {} : { fixture: { models: [] } }, keyStates: {} }) })
        : String(url) === '/api/providers/fixture' && options?.method === 'DELETE' ? (removed = true, Promise.resolve({ ok: true, json: async () => ({ ok: true }) })) : before(url, options);
      $('navGlobalMore').click(); $('navProviders').click(); await tick();
      const box = d.querySelector('.settings-detail-card .providers'); assert.equal(box.querySelectorAll('.prov').length, 1);
      w.openShortcutHelp(); w.closeModal();
      assert.equal(w.panels.providers, box);
      box.querySelector('.prov-del').click(); await tick();
      const confirm = d.getElementById('confirmCard');
      assert.equal(d.getElementById('confirmLayer').hidden, false);
      [...confirm.querySelectorAll('button')].find(button => button.textContent === '删除').click();
      await tick();
      assert.equal(removed, true); assert.equal(box.querySelectorAll('.prov').length, 0);
    } finally { w.fetch = before; $('settingsReturn').click(); }
  });
  await check('Keyboard and command settings share the central owner instead of overlapping modals', async () => {
    $('navGlobalMore').click(); $('navAppUpdates').click(); const previous = d.querySelector('.settings-detail-card');
    d.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, bubbles: true }));
    assert.equal($('modal').hidden, true); assert.equal(previous.isConnected, false);
    assert.equal(d.querySelector('.settings-detail-card h3').textContent, '键盘快捷键');
    w.openPalette(); const query = d.querySelector('.palette-input'); query.value = '诊断'; query.dispatchEvent(new w.Event('input', { bubbles: true }));
    d.querySelector('[data-command-id="app.diagnostics"]').click(); await tick();
    assert.equal($('modal').hidden, true); assert.equal(d.querySelectorAll('.settings-detail-card').length, 1);
    assert.equal($('navDiagnostics').getAttribute('aria-current'), 'page');
    $('settingsReturn').click();
  });
  await check('Settings return restores Runtime scope and draft through the composition owner', async () => {
    const owner = { backendInstance: 'fixture', projectId: 'p', repoId: 'repo', workspaceId: 'ws', workspaceEpoch: 'one', conversationId: 'A', runtimeId: 'rt', runtimeGeneration: 'one', sessionId: 'native-A' };
    w.runtimeStore.seed({ backendInstance: 'fixture', items: [{ conversationId: 'A', createdAt: '2026-01-01T00:00:00.000Z', nativeSessionId: 'native-A', owner, workspace: { projectId: 'p', workspaceId: 'ws', workspaceEpoch: 'one', cwd: 'C:\\fixture' }, lifecycle: 'ready', activity: 'idle' }] });
    await w.focusRuntimeById('A'); await tick();
    const input = d.querySelector('#runtimeView textarea[aria-label="给当前会话的任务"]');
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
    assert.equal(d.activeElement, $('settingsSearchInput'));
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
