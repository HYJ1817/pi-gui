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
  const activateTool = id => {
    const existing = d.querySelector(`.work-surface-tab[data-surface="${id}"] .work-surface-tab-select`);
    if (existing) { if ($('rightPane').hidden) $('btnWorkPanel').click(); existing.click(); return; }
    if ($('rightPane').hidden) $('btnWorkPanel').click(); else $('workPanelNew').click();
    const row = d.querySelector(`.work-panel-launcher-row[data-tool="${id}"]`);
    assert.ok(row, `missing Launcher tool ${id}`); row.click();
  };
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
  await check('work tools are absent from legacy navigation and exposed through the shared panel trigger', () => {
    assert.equal(d.querySelector('#navChanges, #btnTerminal, #btnFiles, #btnBrowser, #btnSpecs, #btnTree, #btnCollab'), null);
    assert.ok(d.querySelector('.head-right #btnWorkPanel'));
    assert.ok($('workPanelTabs')?.matches('[role="tablist"]'));
    assert.ok($('workPanelNew') && $('workPanelMaximize'));
  });
  await check('Settings has all seven logical groups, none empty, and bound actions', () => {
    $('navGlobalMore').click();
    const labels = [...d.querySelectorAll('#globalMoreMenu h3')].map(n => n.textContent);
    assert.deepEqual(labels, ['常规与界面', '工作区', '模型与账户', 'Agent 能力', '扩展与 MCP', '系统与应用', '诊断']);
    assert.equal($('navSystem').nextElementSibling, $('navInfo'));
    /* 「Agent 能力」重新出现时只承载「技能」；29d4054f 移除的能力状态页不回来。
     * 「扩展与 MCP」只剩 MCP 配置 —— 扩展本身是应用主导航目的地。 */
    const group = id => $(id).closest('section');
    assert.deepEqual([...group('navSkills').querySelectorAll('button')].map(b => b.id), ['navSkills']);
    assert.equal(group('navSkills').querySelector('h3').textContent, 'Agent 能力');
    assert.deepEqual([...group('navMcp').querySelectorAll('button')].map(b => b.id), ['navMcp']);
    assert.equal(group('navMcp').querySelector('h3').textContent, '扩展与 MCP');
    assert.equal($('navCapabilities'), null, 'removed capability status page stays removed');
    assert.ok([...$('globalMoreMenu').querySelectorAll('section')].every(section => section.querySelector('button')), 'no empty settings group');
    assert.ok($('navInfo'), 'unified info entry exists');
    assert.equal($('navAppUpdates'), null, 'old updates entry removed');
    assert.equal($('navRestartPi'), null, 'old restart entry removed');
    assert.ok([...$('globalMoreMenu').querySelectorAll('button')].every(b => typeof b.onclick === 'function'));
  });
  await check('Settings search resolves system keywords into the central System destination', async () => {
    const search = $('settingsSearchInput');
    for (const term of ['缓存', 'tray', 'proxy']) {
      search.value = term; search.dispatchEvent(new w.Event('input', { bubbles: true }));
      assert.equal($('navSystem').hidden, false);
      assert.equal($('navInfo').hidden, true);
    }
    search.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    assert.equal(d.activeElement, $('navSystem'));
    $('navSystem').click(); await tick();
    const card = d.querySelector('#workSurface .system-settings-card');
    assert.equal(card.querySelector('h2').textContent, '系统');
    assert.deepEqual([...card.querySelectorAll('h3')].map(h => h.textContent), ['运行环境', '网络', '存储', '电源', '关闭行为']);
    assert.equal($('navSystem').getAttribute('aria-current'), 'page');
    assert.ok($('navSystem').querySelector('svg[data-icon="monitor"] path'));
    search.value = ''; search.dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  await check('Settings search finds 技能 and MCP 配置 by their own words and group headings', async () => {
    const search = $('settingsSearchInput');
    const visible = () => [...$('globalMoreMenu').querySelectorAll('button')]
      .filter(b => !b.hidden && !b.closest('section')?.hidden).map(b => b.id);
    for (const [term, ids] of [
      ['技能', ['navSkills']], ['skill', ['navSkills']], ['Agent 能力', ['navSkills']],
      ['扩展', ['navMcp']], ['mcp', ['navMcp']], ['能力报告', ['navMcp']], ['能力', ['navSkills', 'navMcp', 'navLogs']],
    ]) {
      search.value = term; search.dispatchEvent(new w.Event('input', { bubbles: true }));
      assert.deepEqual(visible(), ids, term);
    }
    search.value = ''; search.dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  await check('MCP management has its own settings surface, not the extensions tab', async () => {
    $('navMcp').click(); await tick();
    assert.equal(d.querySelector('.ext-tab[aria-selected="true"], .extensions-tab[aria-selected="true"]'), null);
    assert.equal(d.querySelector('#globalMoreMenu [aria-current="page"]').id, 'navMcp');
    assert.equal($('workViewTitle').textContent, 'MCP 服务器');
  });
  await check('Extensions is a primary destination with installed and market tabs; Skills is a settings page', async () => {
    $('navExtensions').click(); await tick();
    assert.equal($('workspace').dataset.workspaceView, 'extensions');
    assert.deepEqual([...d.querySelectorAll('#workSurface .extensions-tab')].map(tab => tab.dataset.tab), ['installed', 'market']);
    assert.equal(d.querySelector('.extensions-tab[aria-selected="true"]').dataset.tab, 'installed');
    assert.equal($('extensionsTabSkills'), null); assert.equal($('extensionsTabMcp'), null);
    assert.equal($('navExtensions').getAttribute('aria-current'), 'page');
    assert.equal(d.querySelector('#globalMoreMenu [aria-current="page"]'), null);
    assert.equal($('globalMoreMenu').hidden, true);
    assert.equal($('workViewTitle').textContent, '扩展');
    /* 页签切换只改页面内状态，导航高亮与标题不跟着漂。 */
    $('extensionsTabMarket').click();
    assert.equal(d.querySelector('.extensions-tab[aria-selected="true"]').dataset.tab, 'market');
    assert.equal($('navExtensions').getAttribute('aria-current'), 'page');
    assert.equal($('workViewTitle').textContent, '扩展');
    $('navGlobalMore').click();
    $('navSkills').click(); await tick();
    assert.equal($('workspace').dataset.workspaceView, 'settings');
    assert.equal(d.querySelector('#globalMoreMenu [aria-current="page"]').id, 'navSkills');
    assert.equal($('navExtensions').getAttribute('aria-current'), null);
    const skills = d.querySelector('#workSurface .settings-detail-card.skills-page');
    assert.equal(skills.getAttribute('aria-label'), '技能');
    assert.equal(skills.querySelector('.skills-title').textContent, '技能');
    assert.equal(d.querySelector('#workSurface .ext-tab, #workSurface .extensions-tab'), null, 'no extension tabs inside the Skills page');
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
    assert.ok($('globalMoreMenu').contains($('navSkills')));
    assert.ok($('globalMoreMenu').contains($('navMcp')));
    assert.equal($('globalMoreMenu').contains($('navExtensions')), false);
    assert.ok(d.querySelector('#projectSidebar .rail-nav').contains($('navExtensions')));
    $('navPlanner').click(); await tick();
    assert.equal($('workspace').dataset.workspaceView, 'planner');
    assert.equal($('navPlanner').getAttribute('aria-current'), 'page');
    assert.equal($('globalMoreMenu').hidden, false);
    $('settingsReturn').click();
    assert.equal($('chatView'), chat); assert.equal($('input').value, 'settings round trip');
    assert.equal($('stream').scrollTop, 83); assert.equal($('globalMoreMenu').hidden, true);
  });
  await check('Extensions round trip is a primary view: no settings mode, chat draft and page disposal hold', async () => {
    const chat = $('chatView'); $('input').value = 'extensions round trip';
    $('navExtensions').click(); await tick();
    assert.equal($('workspace').dataset.workspaceView, 'extensions');
    assert.equal($('settingsReturn').hidden, true);
    assert.equal($('projectSidebar').classList.contains('settings-mode'), false);
    assert.ok($('workSurface').classList.contains('extensions-page'));
    assert.ok($('workSurface').querySelector('#extensionsTabPanel[role="tabpanel"]'));
    $('navHome').click();
    assert.equal($('workspace').dataset.workspaceView, 'chat');
    assert.equal($('chatView'), chat); assert.equal($('input').value, 'extensions round trip');
    assert.equal($('workSurface').classList.contains('extensions-page'), false);
    assert.equal($('workSurface').childElementCount, 0, 'extensions page disposed with its host content');
    assert.equal($('navHome').getAttribute('aria-current'), 'page');
    $('input').value = '';
  });
  await check('Work panel Launcher shows real registry tools, preserves chat and hides without a phantom tab', () => {
    $('btnWorkPanel').click();
    assert.equal($('rightPane').hidden, false);
    assert.deepEqual([...d.querySelectorAll('.work-panel-launcher-row')].map(row => row.dataset.tool), ['changes', 'terminal', 'files', 'specs', 'browser', 'tree', 'collab', 'process']);
    assert.equal(d.querySelectorAll('.work-panel-launcher-grid, .work-panel-launcher-card, .work-panel-launcher-more').length, 0);
    assert.equal($('workspace').dataset.workspaceView, 'chat');
    assert.equal(d.querySelectorAll('.work-surface-tab').length, 0, 'the empty Launcher is hosted in the pane body, not a tab');
    assert.ok(d.querySelector('#rightPane .work-tools-surface .work-panel-launcher-list'), 'tabless Launcher mounted in the pane body');
    $('workPanelClose').click(); assert.equal($('rightPane').hidden, true);
    assert.equal(d.querySelectorAll('.work-surface-tab').length, 0, 'hiding leaves no phantom Launcher tab');
    $('btnWorkPanel').click(); assert.equal($('rightPane').hidden, false);
    assert.ok(d.querySelector('#rightPane .work-tools-surface .work-panel-launcher-list'), 'reopening restores the live tabless Launcher');
    $('workPanelClose').click(); assert.equal($('rightPane').hidden, true);
  });
  await check('Settings keeps the work panel entrance visible and hide preserves its selected tool tab', () => {
    $('navGlobalMore').click();
    assert.equal($('btnWorkPanel').hidden, false);
    $('btnWorkPanel').click(); assert.equal($('rightPane').hidden, false);
    $('workPanelNew').click();
    d.querySelector('.work-panel-launcher-row[data-tool="changes"]').click();
    const changesTab = d.querySelector('.work-surface-tab[data-surface="changes"] .work-surface-tab-select');
    assert.ok(changesTab);
    $('workPanelClose').focus(); $('workPanelClose').click();
    assert.equal(d.activeElement, $('btnWorkPanel'));
    assert.ok(d.querySelector('.work-surface-tab[data-surface="changes"]'), 'hiding is not tab close');
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
    const detailCard = d.querySelector('.settings-detail-card');
    detailCard.focus();
    detailCard.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.ok(d.querySelector('#workSurface .settings-section'));
    assert.equal(d.activeElement, $('navProviders'));
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
  await check('Saved settings destination that no longer exists falls back to overview', () => {
    const isolated = new JSDOM(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'), { url: 'http://localhost:7788', runScripts: 'outside-only', pretendToBeVisual: true });
    const module = isolated.window.eval(bundle(path.join(pub, 'ui/settings-surface.js')).code);
    const surface = module.initSettingsSurface();
    let disposed = 0;
    const instance = surface.presentDetail('navCapabilities', () => { throw new Error('removed page must not build'); }, () => disposed++);
    assert.equal(instance.isCurrent(), false);
    assert.equal(isolated.window.document.querySelector('.settings-detail-card'), null);
    assert.ok(isolated.window.document.querySelector('#workSurface .settings-grid'));
    instance.dispose();
    assert.equal(disposed, 0);
    isolated.window.close();
  });
  await check('Late settings diagnostic result cannot replace the appearance page', async () => {
    const before = w.fetch; let release;
    try {
      w.fetch = (url, options) => String(url) === '/api/diagnostics' ? new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ok: false, error: 'fixture late' }) }); }) : before(url, options);
      $('navGlobalMore').click(); $('navLogs').click(); $('ui5-log-tab-export').click();
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
      const addService = d.querySelector('.settings-detail-card .prov-btn-main');
      assert.ok(addService, 'provider add button must exist');
      addService.click(); await tick();
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
    d.querySelector('.settings-detail-card .settings-theme-trigger').focus();
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
    $('navGlobalMore').click(); $('navInfo').click(); const previous = d.querySelector('.settings-detail-card');
    d.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, bubbles: true }));
    assert.equal($('modal').hidden, true); assert.equal(previous.isConnected, false);
    assert.equal(d.querySelector('.settings-detail-card h3').textContent, '键盘快捷键');
    $('input').value = '/diagnostics'; $('input').dispatchEvent(new w.Event('input', { bubbles: true }));
    d.querySelector('[data-command-id="app.diagnostics"]').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true })); await tick();
    assert.equal($('modal').hidden, true); assert.equal(d.querySelectorAll('.settings-detail-card').length, 1);
    assert.equal($('navDiagnostics'), null);
    assert.equal($('navLogs').getAttribute('aria-current'), 'page');
    assert.equal($('ui5-log-tab-export').getAttribute('aria-selected'), 'true');
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
  for (const method of ['click', 'Enter']) await check('Inline command settings hands off menu and focus via ' + method, async () => {
    $('input').focus();
    $('input').value = '/settings'; $('input').dispatchEvent(new w.Event('input', { bubbles: true }));
    if (method === 'click') d.querySelector('[data-command-id="app.preferences"]').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    else $('input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(); assert.equal($('globalMoreMenu').hidden, false);
    assert.equal(d.activeElement, $('settingsSearchInput'));
    d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await check('Changes preserves mounted conversation, scroll and draft', async () => {
    $('input').value = 'draft'; $('stream').scrollTop = 71;
    activateTool('changes'); await tick();
    assert.equal($('workspace').dataset.workspaceView, 'chat');
    assert.equal($('chatView').hidden, false); assert.equal($('chatComposer').hidden, false);
    assert.equal($('rightPane').hidden, false); assert.equal($('rightPane').dataset.surface, 'changes');
    assert.equal($('input').value, 'draft'); assert.equal($('stream').scrollTop, 71);
    assert.equal(d.querySelectorAll('#rightPane .chg-row').length, 1);
    d.querySelector('#rightPane .chg-main').click(); await tick();
    assert.equal(d.querySelector('#rightPane .chg-diff').hidden, false);
  });
  await check('closing the last Changes tab keeps the pane on the tabless Launcher and moves focus into it', async () => {
    const close = d.querySelector('.work-surface-tab[data-surface="changes"] .work-surface-tab-close');
    close.focus(); close.click();
    assert.equal($('rightPane').hidden, false); assert.equal(d.querySelector('#rightPane .chg-row'), null);
    assert.equal(d.querySelector('.work-surface-tab[data-surface="changes"]'), null);
    assert.equal(d.querySelectorAll('.work-surface-tab').length, 0, 'the last tool close creates no phantom tab');
    const launcher = d.querySelector('#rightPane .work-tools-surface .work-panel-launcher-list');
    assert.ok(launcher, 'pane stays open on the tabless empty-state Launcher');
    await tick();
    assert.equal(d.activeElement, launcher.querySelector('button:not([hidden]):not(:disabled)'), 'focus lands on the surviving Launcher');
  });
  await check('Browser and Changes remain live as independent tabs; explicit Browser close releases native view', async () => {
    activateTool('browser'); await tick(); assert.ok(d.querySelector('#browserViewport'));
    const closesBefore = nativeCloses;
    activateTool('changes'); await tick();
    const browserTab = d.querySelector('.work-surface-tab[data-surface="browser"]');
    assert.ok(browserTab); assert.ok(d.querySelector('#browserViewport'), 'switching tabs must retain Browser DOM');
    assert.equal(d.querySelector('#browserViewport').closest('[role="tabpanel"]').hidden, true);
    assert.equal(nativeCloses, closesBefore, 'background tab switch is not explicit close');
    browserTab.querySelector('.work-surface-tab-select').click();
    assert.equal(d.querySelector('#browserViewport').closest('[role="tabpanel"]').hidden, false);
    browserTab.querySelector('.work-surface-tab-close').click(); await tick();
    assert.equal(d.querySelector('#browserViewport'), null); assert.ok(nativeCloses > closesBefore);
    assert.ok(d.querySelector('.work-surface-tab[data-surface="changes"] .work-surface-tab-select[aria-selected="true"]'));
  });
  await check('Changes remains mounted and refreshes while Browser is selected', async () => {
    activateTool('browser'); await tick();
    const changesTab = d.querySelector('.work-surface-tab[data-surface="changes"] .work-surface-tab-select');
    const changesHost = d.getElementById(changesTab?.getAttribute('aria-controls'));
    assert.ok(changesHost?.hidden); assert.equal(changesHost.querySelectorAll('.chg-row').length, 1);
    await w.refreshGitNow();
    assert.equal(changesHost.querySelectorAll('.chg-row').length, 1);
    assert.ok(d.querySelector('#browserViewport'));
  });
  await check('Every project row has its own New action', async () => {
    await w.loadProjects();
    const rows = [...d.querySelectorAll('#projects .project')];
    assert.ok(rows.length >= 1, 'fixture project missing');
    /* 加号是**每个项目行**的入口：当前项目不再独占，也不再因此把
     * 「新对话」从这一行拿走。全局 navNew / navSearch 仍然存在。 */
    assert.equal(d.querySelectorAll('#projects .pj-header-action').length, rows.length);
    for (const row of rows) assert.ok(row.querySelector('.pj-header-action[aria-label^="在「"]'), 'row missing new action');
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
