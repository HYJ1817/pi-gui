const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
let count = 0;
const check = (name, fn) => { fn(); count++; console.log('PASS ' + name); };
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 5)); };
(async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), { url: 'http://127.0.0.1/' });
  Object.assign(global, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
  const { S } = await import('../public/state.js');
  S.workspaceGeneration = 1; S.switching = false;
  global.fetch = async () => ({ json: async () => ({ ok: true, isRepo: true, files: [{ path: 'fixture.js', status: 'M', additions: 1, deletions: 1 }], diff: '+fixture' }) });
  const { initRightPane } = await import('../public/right-pane.js');
  const { configureSecondaryPane } = await import('../public/ui/secondary-surface.js');
  const { attachBrowserPane } = await import('../public/browser-pane.js');
  const { openSplitWorkbench } = await import('../public/ui/split-workbench.js');
  const events = [], listeners = new Set();
  const bridge = { open: async () => { events.push('open'); return { ok: true }; }, close: () => events.push('close'),
    navigate: async () => ({ ok: true }), back() {}, forward() {}, reload() {}, stop() {}, openExternal() {},
    setBounds: r => events.push(['bounds', r]), setOccluded: v => events.push(['occluded', v]),
    onState: f => { listeners.add(f); return () => listeners.delete(f); }, onNotice: () => () => {}, onAgentOpen: () => () => {} };
  window.piGuiDesktop = { browser: bridge };
  const pane = initRightPane(); configureSecondaryPane(pane);
  const browser = attachBrowserPane(pane, { openWorkbench: openSplitWorkbench });
  browser.open(); await tick();
  const surface = browser.surface();
  surface.ui.address.blur();
  for (const f of listeners) f({ url: 'http://localhost:3000/retained' });
  check('single Browser opens with one state subscription', () => assert.equal(listeners.size, 1));
  check('Browser offers controlled split entry', () => assert.ok(surface.ui.split));
  browser.openSplit(); await tick();
  check('Browser and Changes mount together', () => { assert.equal(pane.surface(), 'browser-changes-split'); assert.ok(document.querySelector('.workbench-pane-browser #browserViewport')); assert.ok(document.querySelector('.workbench-pane-changes .chg-head')); });
  check('layout transition keeps same Browser chrome and current URL', () => { assert.equal(browser.surface(), surface); assert.equal(surface.ui.address.value, 'http://localhost:3000/retained'); assert.equal(events.filter(e => e === 'open').length, 1); assert.ok(!events.includes('close')); assert.equal(listeners.size, 1); });
  let split = document.querySelector('.workbench-split');
  split.getBoundingClientRect = () => ({ top: 0, height: 700, width: 420 });
  surface.ui.viewport.getBoundingClientRect = () => ({ left: 600, top: 100, width: 420, height: 280 });
  pane.refresh(); await tick();
  check('right pane delivers Browser viewport rather than whole workbench', () => assert.deepEqual(events.filter(e => e[0] === 'bounds').at(-1)[1], { x: 600, y: 100, width: 420, height: 280 }));
  const occluded = () => events.filter(e => e[0] === 'occluded').at(-1)[1];
  Object.defineProperty(window, 'innerWidth', { value: 720, configurable: true });
  window.dispatchEvent(new window.Event('resize')); await tick();
  document.querySelector('[data-workbench-tab="changes"]').click(); await tick();
  check('fallback Changes truly occludes hidden native Browser', () => assert.equal(occluded(), true));
  document.querySelector('[data-workbench-tab="browser"]').click(); await tick();
  check('fallback Browser restores viewport after measuring', () => assert.equal(occluded(), false));
  const modal = document.querySelector('#modal'); modal.hidden = false; await tick();
  document.body.classList.add('workbench-resizing'); await tick();
  document.body.classList.remove('workbench-resizing'); await tick();
  check('ending drag cannot clear modal occlusion', () => assert.equal(occluded(), true));
  modal.hidden = true; await tick();
  check('closing modal reveals correctly scoped viewport', () => assert.equal(occluded(), false));
  document.querySelector('#rightPaneResizer').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 600 }));
  await tick(); window.dispatchEvent(new window.Event('blur')); await tick();
  check('interrupted width drag releases native occlusion without mouseup', () => {
    assert.equal(document.body.classList.contains('rp-resizing'), false); assert.equal(occluded(), false);
  });
  Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
  window.dispatchEvent(new window.Event('resize')); await tick();
  surface.ui.split.click(); await tick();
  check('exit split restores same Browser without native close', () => { assert.equal(pane.surface(), 'browser'); assert.equal(browser.surface(), surface); assert.ok(!events.includes('close')); });
  for (let i = 0; i < 20; i++) { browser.openSplit(); await tick(); surface.ui.split.click(); await tick(); }
  check('twenty layout transitions keep one instance/subscription', () => { assert.equal(browser.surface(), surface); assert.equal(listeners.size, 1); assert.equal(document.querySelectorAll('#browserViewport').length, 1); });
  browser.openSplit(); await tick();
  document.dispatchEvent(new window.CustomEvent('pi-gui:workspace-generation'));
  await tick();
  check('classic project change closes old browser and workbench', () => { assert.equal(pane.surface(), null); assert.ok(events.includes('close')); assert.equal(listeners.size, 0); });
  browser.openSplit(); await tick(); pane.close();
  check('closing workbench releases browser instance and listeners', () => { assert.equal(browser.surface(), null); assert.equal(listeners.size, 0); });
  dom.window.close();
  console.log(`Browser workbench UI: ${count}/${count}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
