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
    assert.ok(d.querySelector('.head-right #navChanges'));
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
    assert.equal($('navChanges').getAttribute('aria-pressed'), 'false'); assert.equal(d.activeElement, $('navChanges'));
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
