/* Outer tool navigation only. Files' file tabs and Terminal's PTY tabs remain
 * with their existing owners. No real project, pi, network or persistent data. */
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
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
let dom, surfaces;
(async () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'http://127.0.0.1/', pretendToBeVisual: true });
  Object.assign(global, { window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
    CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
  global.fetch = () => { throw new Error('Unexpected network access'); };
  const { S } = await import('../public/state.js');
  S.workspaceGeneration = 1;
  const { initRightPane } = await import('../public/right-pane.js');
  surfaces = await import('../public/ui/secondary-surface.js');
  const shortcuts = await import('../public/shortcuts.js');
  const pane = initRightPane();
  let scope = 'project-A/session-A', identity = 'backend-A/epoch-1';
  surfaces.configureSecondaryPane(pane, { getScope: () => scope, getIdentity: () => identity });
  const mounts = new Map(), disposed = [], visibility = new Map(), instances = new Map();
  const defs = [
    ['changes', '文件变更', 'changes', 'g'], ['terminal', '终端', 'terminal', 't'],
    ['files', '文件', 'folder', 'f'], ['specs', 'Specs', 'fileText', 's'],
    ['browser', '浏览器', 'globe', 'b'], ['tree', '分支树', 'branch', 'r'],
  ];
  let browserAvailable = true, terminalDisabled = false;
  for (const [id, label, icon, key] of defs) surfaces.registerSecondaryTool({
    id, label, icon, key, views: id === 'browser' ? ['runtime-browser'] : [],
    shortcutId: id === 'files' ? 'surface-files-fixture' : null,
    available: () => id !== 'browser' || browserAvailable,
    disabled: () => id === 'terminal' && terminalDisabled,
    open: () => surfaces.openSecondarySurface(id, (host, view) => {
      mounts.set(id, (mounts.get(id) || 0) + 1); instances.set(id, view);
      const input = document.createElement('input'); input.value = 'retained ' + id; host.append(input);
      visibility.set(view, []);
      view.onVisibility(value => visibility.get(view).push(value));
      view.onDispose(() => disposed.push([view, 'first']));
      view.onDispose(() => disposed.push([view, 'second']));
    }, { label }),
  });
  shortcuts.registerShortcut({ id: 'surface-files-fixture', combo: 'primary+p', label: '打开文件',
    run: () => surfaces.openSecondaryTool('files') });
  const all = () => surfaces.secondaryTabs();
  const selected = () => all().find(tab => tab.active);
  const tabFor = id => document.getElementById(all().find(tab => tab.id === id || tab.view === id)?.id + '-tab');
  const key = (target, name, options = {}) => {
    const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event); return event;
  };
  const empty = () => { for (const tab of all()) surfaces.closeSecondarySurface(tab.id); };
  const open = id => surfaces.openSecondaryTool(id);
  const menu = (id, label) => {
    tabFor(id).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const item = [...document.querySelectorAll('#actionMenu button')].find(node => node.textContent === label);
    if (label) { strict.ok(item, label); item.click(); }
    return item;
  };
  check('no permanent tool icons or hidden legacy source buttons', () => {
    for (const id of ['btnFiles', 'btnTerminal', 'btnSpecs', 'btnBrowser', 'btnTree', 'navChanges', 'workPanelMore']) assert.equal(document.getElementById(id), null);
    assert.equal(document.querySelectorAll('#workPanelTabs > *').length, 0);
  });
  surfaces.showSecondaryPane(); await tick();
  /* The empty pane is a tabless Launcher hosted directly in the pane body,
   * not a 'work-tools' tab: the strip stays empty and nothing persists. */
  check('empty pane is a tabless centered Launcher with official local icons', () => {
    assert.equal(all().length, 0);
    assert.equal(document.querySelectorAll('#workPanelTabs > *').length, 0);
    assert.equal(document.querySelectorAll('.work-panel-launcher-row').length, defs.length);
    assert.equal(document.querySelectorAll('.work-panel-launcher-row svg[data-icon]').length, defs.length);
    assert.equal(document.querySelector('.work-panel-launcher-more, .work-panel-tool-card'), null);
    assert.equal(pane.isOpen(), true);
  });
  document.getElementById('workPanelNew').click(); await tick();
  const firstLauncher = selected().id;
  check('+ creates the first independent blank Launcher tab', () => {
    assert.equal(all().length, 1); assert.equal(selected().view, 'work-tools');
    assert.equal(document.querySelectorAll('.work-tools-surface:not([hidden])').length, 1);
  });
  document.getElementById('workPanelNew').click(); await tick();
  const secondLauncher = selected().id;
  check('+ again creates an independent blank tab instead of replacing the first Launcher', () => {
    assert.equal(all().length, 2); assert.notEqual(firstLauncher, secondLauncher);
    assert.equal(document.querySelectorAll('.work-tools-surface').length, 2);
  });
  const changes = open('changes');
  check('selecting a tool converts only the selected blank tab', () => {
    assert.equal(all().length, 2); assert.equal(selected().view, 'changes');
    assert.equal(all()[0].id, firstLauncher); assert.equal(document.getElementById(secondLauncher + '-tab'), null);
    assert.equal(changes.isCurrent(), true); assert.equal(changes.isVisible(), true);
  });
  surfaces.newSecondaryLauncher(); const spareLauncher = selected().id;
  open('changes');
  check('opening a singleton from another Launcher activates it without consuming that blank', () => {
    assert.equal(all().filter(tab => tab.view === 'changes').length, 1);
    assert.equal(mounts.get('changes'), 1); assert.ok(all().some(tab => tab.id === spareLauncher));
  });
  const files = open('files'), filesNode = files.host.firstChild;
  filesNode.value = 'unsaved local UI state';
  surfaces.activateSecondarySurface('changes');
  check('switching retains the same business DOM, current identity and disposer ownership', () => {
    assert.equal(files.isCurrent(), true); assert.equal(files.isVisible(), false);
    assert.equal(files.host.firstChild, filesNode); assert.equal(disposed.some(([view]) => view === files), false);
    assert.deepEqual(visibility.get(files), [true, false]);
  });
  pane.close();
  check('hide is boolean visibility false, not close or resource disposal', () => {
    assert.equal(changes.isCurrent(), true); assert.equal(changes.isVisible(), false);
    assert.equal(disposed.length, 0); assert.equal(all().length, 4);
    assert.ok([...visibility.values()].flat().every(value => typeof value === 'boolean'));
  });
  surfaces.showSecondaryPane(); surfaces.activateSecondarySurface('files');
  check('show and reactivate restore exactly the same live tool instance', () => {
    assert.equal(surfaces.secondarySurfaceInstance('files'), files); assert.equal(filesNode.value, 'unsaved local UI state');
    assert.equal(mounts.get('files'), 1); assert.equal(files.isVisible(), true);
  });
  check('outer tabs have selected state, tabpanel linkage and one roving tab stop', () => {
    const buttons = [...document.querySelectorAll('#workPanelTabs [role="tab"]')];
    assert.equal(buttons.filter(node => node.tabIndex === 0).length, 1);
    assert.equal(buttons.filter(node => node.getAttribute('aria-selected') === 'true').length, 1);
    for (const button of buttons) {
      const panel = document.getElementById(button.getAttribute('aria-controls'));
      assert.equal(panel.getAttribute('role'), 'tabpanel'); assert.equal(panel.getAttribute('aria-labelledby'), button.id);
    }
    assert.equal(document.querySelector('#workPanelTabs button button'), null);
  });
  tabFor('files').focus(); key(tabFor('files'), 'Home');
  check('Home, End and arrows activate tabs with keyboard focus', () => {
    assert.equal(selected().id, firstLauncher); assert.equal(document.activeElement, tabFor(firstLauncher));
    key(tabFor(firstLauncher), 'End'); assert.equal(selected().view, 'files');
    key(tabFor('files'), 'ArrowRight'); assert.equal(selected().id, firstLauncher);
  });
  key(tabFor(firstLauncher), 'End', { altKey: true, shiftKey: true });
  check('Alt+Shift keyboard reorders without changing selected business owner', () => {
    assert.equal(all().at(-1).id, firstLauncher); assert.equal(selected().id, firstLauncher);
    key(tabFor(firstLauncher), 'ArrowLeft', { altKey: true, shiftKey: true });
    assert.equal(all().at(-2).id, firstLauncher); assert.equal(document.activeElement, tabFor(firstLauncher));
  });
  check('programmatic and drag reordering preserve live instances', () => {
    assert.equal(surfaces.moveSecondarySurface('files', 'changes'), true);
    const element = tabFor('files').parentElement, target = tabFor('changes').parentElement;
    element.ondragstart({ target: element, dataTransfer: { setData() {} } });
    target.ondrop({ preventDefault() {}, clientX: 10 });
    assert.equal(all().findIndex(tab => tab.view === 'files'), all().findIndex(tab => tab.view === 'changes') + 1);
    assert.equal(surfaces.secondarySurfaceInstance('files'), files);
    assert.equal(surfaces.moveSecondarySurface('missing'), false);
  });
  surfaces.activateSecondarySurface('files'); tabFor('files').focus();
  surfaces.closeSecondarySurface(spareLauncher);
  check('closing an inactive tab preserves active tab and its focus', () => {
    assert.equal(selected().view, 'files'); assert.equal(document.activeElement, tabFor('files'));
  });
  key(tabFor('files'), 'Delete');
  check('Delete closes one tool, releases in reverse order and focuses a surviving tab', () => {
    assert.equal(files.disposed, true);
    assert.deepEqual(disposed.filter(([view]) => view === files).map(([, name]) => name), ['second', 'first']);
    assert.equal(document.activeElement, tabFor(selected().id)); assert.equal(files.host.isConnected, false);
  });
  empty(); open('changes'); open('files'); open('specs');
  menu('files', '关闭右侧标签页');
  check('close-right menu computes the original right-side set', () => {
    assert.deepEqual(all().map(tab => tab.view), ['changes', 'files']);
  });
  open('specs'); menu('files', '关闭其它标签页');
  check('close-others menu preserves its target singleton', () => assert.deepEqual(all().map(tab => tab.view), ['files']));
  // Explicit contract when the target is a borrowed child rather than a layout:
  // the layout is ordinary closeable material and its disposal must hand the
  // retained child back to its own standalone tab, never strand a dead host.
  const liveFiles = surfaces.secondarySurfaceInstance('files');
  const layoutOwner = open('specs');
  const borrowHost = document.createElement('div'); layoutOwner.host.append(borrowHost);
  assert.equal(surfaces.borrowSecondarySurface('files', borrowHost, layoutOwner), true);
  menu('files', '关闭其它标签页');
  check('close-others on a borrowed child keeps the child and rehomes its host', () => {
    assert.deepEqual(all().map(tab => tab.view), ['files']);
    assert.equal(layoutOwner.isCurrent(), false);
    assert.equal(liveFiles.isCurrent(), true);
    assert.equal(liveFiles.host.parentElement, pane.root.querySelector('.rp-body'));
    assert.equal(liveFiles.host.hidden, false);
    assert.equal(surfaces.secondarySurfaceInstance('files'), liveFiles);
  });
  menu('files', '关闭标签页');
  check('closing the last tool keeps the pane open on a tabless empty-state Launcher', () => {
    assert.equal(all().length, 0); assert.equal(pane.isOpen(), true);
    assert.equal(document.querySelectorAll('#workPanelTabs > *').length, 0);
    assert.ok(document.querySelector('.rp-body > .work-tools-surface .work-panel-launcher-list'));
    assert.equal(pane.surface(), 'work-tools');
  });
  open('changes'); open('files'); menu('changes', '关闭全部标签页');
  check('close-all releases every tab and the pane stays open on the empty-state Launcher', () => {
    assert.equal(all().length, 0); assert.equal(pane.isOpen(), true);
    assert.ok(document.querySelector('.rp-body > .work-tools-surface .work-panel-launcher-list'));
  });
  /* Closing the empty state itself is impossible — it is not a tab, so there
   * is nothing to close and no close loop can form. */
  check('the empty state is not a closeable tab and creates no persisted descriptor', () => {
    const emptySurface = document.querySelector('.rp-body > .work-tools-surface');
    assert.ok(emptySurface);
    assert.equal(emptySurface.querySelector('.surface-resume, .work-surface-tab-close'), null);
  });
  open('specs'); tabFor('specs').parentElement.onauxclick({ button: 1, preventDefault() {} });
  check('middle click closes the last tool back into the empty-state Launcher', () => {
    assert.equal(all().length, 0);
    assert.ok(document.querySelector('.rp-body > .work-tools-surface .work-panel-launcher-list'));
  });
  surfaces.newSecondaryLauncher(); await tick();
  let launcher = document.querySelector('.work-panel-launcher-list');
  const rows = () => [...launcher.querySelectorAll('button')];
  rows()[0].focus(); key(rows()[0], 'End');
  check('Launcher uses roving Up/Down/Home/End and local typeahead', () => {
    assert.equal(document.activeElement.dataset.tool, 'tree'); key(document.activeElement, 'Home');
    assert.equal(document.activeElement.dataset.tool, 'changes'); key(document.activeElement, 'f');
    assert.equal(document.activeElement.dataset.tool, 'files');
  });
  check('Launcher hints read effective shortcut overrides rather than fixed strings', () => {
    const hint = launcher.querySelector('[data-tool="files"] kbd');
    assert.equal(hint.textContent, shortcuts.shortcutFor('surface-files-fixture').display);
    assert.equal(shortcuts.commitShortcutBinding('surface-files-fixture', 'primary+shift+p').ok, true);
    assert.equal(hint.textContent, shortcuts.shortcutFor('surface-files-fixture').display);
    assert.equal(shortcuts.commitShortcutBinding('surface-files-fixture', null).ok, true);
    assert.equal(hint.hidden, true); assert.equal(hint.textContent, '');
  });
  check('text input, modifiers, composition and prevented keys cannot trigger Launcher actions', () => {
    const row = rows()[0]; row.focus();
    const before = all().length;
    key(row, 'Enter', { ctrlKey: true }); key(row, 'Enter', { isComposing: true }); key(row, 'f', { altKey: true });
    const input = document.createElement('input'); row.append(input); input.focus(); key(input, 'Enter'); input.remove();
    row.focus(); const prevented = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    prevented.preventDefault(); row.dispatchEvent(prevented);
    assert.equal(all().length, before); assert.equal(selected().view, 'work-tools');
  });
  browserAvailable = false; terminalDisabled = true; surfaces.refreshSecondaryTools();
  check('capability changes remove unavailable tools and disable real actions consistently', () => {
    assert.equal(launcher.querySelector('[data-tool="browser"]'), null);
    assert.equal(launcher.querySelector('[data-tool="terminal"]').disabled, true);
    assert.equal(open('terminal'), null); assert.equal(open('browser'), null);
  });
  browserAvailable = true; terminalDisabled = false; surfaces.refreshSecondaryTools();
  launcher.querySelector('[data-tool="files"]').focus(); key(document.activeElement, 'Enter');
  check('Launcher Enter delegates to the real tool action', () => assert.equal(selected().view, 'files'));
  check('Launcher conversion gives its removed keyboard trigger a visible tab successor', () => {
    assert.equal(document.activeElement, tabFor('files'));
    assert.equal(document.activeElement.getAttribute('aria-selected'), 'true');
    assert.equal(document.activeElement.closest('[hidden]'), null);
  });
  surfaces.newSecondaryLauncher(); await tick();
  const reuseRow = document.querySelector('.work-tools-surface:not([hidden]) [data-tool="files"]');
  reuseRow.focus(); key(reuseRow, ' ');
  check('Launcher Space reuses the singleton with focus outside the hidden Launcher', () => {
    assert.equal(selected().view, 'files'); assert.equal(document.activeElement, tabFor('files'));
    assert.equal(document.activeElement.closest('[hidden]'), null);
  });
  const composer = document.getElementById('input'); composer.focus();
  open('terminal');
  check('programmatic tool opens never move Composer focus into Terminal or its tab', () => {
    assert.equal(document.activeElement, composer); assert.equal(selected().view, 'terminal');
  });
  const terminalInput = surfaces.secondarySurfaceInstance('terminal').host.firstChild;
  terminalInput.focus();
  surfaces.ensureSecondaryTool('browser');
  check('background tool preparation preserves selected Terminal and its input focus', () => {
    assert.equal(document.activeElement, terminalInput); assert.equal(selected().view, 'terminal');
    assert.equal(surfaces.secondarySurfaceInstance('browser').isVisible(), false);
  });
  empty();
  for (let i = 0; i < 16; i++) surfaces.newSecondaryLauncher({ focus: false });
  check('tab count is bounded and + is disabled at capacity', () => {
    assert.equal(all().length, 16); assert.equal(document.getElementById('workPanelNew').disabled, true);
    assert.equal(surfaces.newSecondaryLauncher(), null);
  });
  open('changes');
  check('a full tab strip still permits conversion of its selected blank', () => {
    assert.equal(all().length, 16); assert.equal(selected().view, 'changes');
  });
  empty(); open('changes'); open('files'); surfaces.moveSecondarySurface('files', 'changes');
  const oldFiles = instances.get('files');
  surfaces.writePaneState('changes', { scrollTop: 73 });
  scope = 'project-B/session-B'; identity = 'backend-A/epoch-2'; surfaces.syncSecondaryScope();
  check('scope switch retires old owners and isolates small owner state', () => {
    assert.equal(oldFiles.isCurrent(), false); assert.equal(oldFiles.disposed, true);
    assert.equal(surfaces.readPaneState('changes'), null); assert.equal(all().some(tab => tab.view === 'files'), false);
  });
  open('specs');
  scope = 'project-A/session-A'; identity = 'backend-A/epoch-3'; surfaces.syncSecondaryScope();
  check('returning to a session restores ordered descriptors lazily with no business creation', () => {
    assert.deepEqual(all().map(tab => tab.view), ['files', 'changes']);
    assert.equal(selected().view, 'files'); assert.ok(all().every(tab => !tab.mounted));
    assert.deepEqual(surfaces.readPaneState('changes'), { scrollTop: 73 });
  });
  const beforeRestoreMounts = mounts.get('files'); surfaces.showSecondaryPane();
  check('explicit restore rebinds through the owner and marks its restored intent', () => {
    assert.equal(mounts.get('files'), beforeRestoreMounts + 1); assert.equal(instances.get('files').restored, true);
  });
  const prior = instances.get('files'); identity = 'backend-B/epoch-4';
  check('a changed full identity rejects old results before the scope event arrives', () => assert.equal(prior.isCurrent(), false));
  surfaces.syncSecondaryScope();
  check('backend identity changes invalidate live mounts without losing stable navigation', () => {
    assert.equal(prior.disposed, true); assert.deepEqual(all().map(tab => tab.view), ['files', 'changes']);
    assert.ok(all().every(tab => !tab.mounted));
  });
  for (const [from, pressed, target] of [['files', 'End', 'changes'], ['changes', 'Home', 'files'],
    ['files', 'ArrowRight', 'changes'], ['changes', 'ArrowLeft', 'files']]) {
    surfaces.activateSecondarySurface(from);
    identity += '/keyboard-lazy'; surfaces.syncSecondaryScope(); surfaces.showSecondaryPane();
    check(`restored ${pressed} mounts and focuses the next lazy tab`, () => {
      assert.equal(all().find(tab => tab.view === target).mounted, false);
      tabFor(from).focus(); key(tabFor(from), pressed);
      assert.equal(selected().view, target); assert.equal(all().find(tab => tab.view === target).mounted, true);
      assert.equal(document.activeElement, tabFor(target));
      assert.equal(document.activeElement.getAttribute('aria-selected'), 'true');
    });
  }
  menu('files');
  const staleCloseAll = [...document.querySelectorAll('#actionMenu button')].find(node => node.textContent === '关闭全部标签页');
  scope = 'project-C/session-C'; surfaces.syncSecondaryScope(); open('tree'); staleCloseAll.click();
  check('an old-scope menu cannot close tabs belonging to the new scope', () => {
    assert.equal(document.getElementById('actionMenu'), null); assert.equal(selected().view, 'tree');
  });
  empty(); open('changes'); open('browser'); surfaces.activateSecondarySurface('changes');
  identity = 'lazy-close-fixture'; surfaces.syncSecondaryScope();
  const beforeBulkClose = mounts.get('browser');
  check('batch-close never implicitly mounts a dormant resource descriptor', () => {
    assert.equal(selected().view, 'changes'); assert.ok(all().every(tab => !tab.mounted));
    menu('changes', '关闭全部标签页');
    assert.equal(mounts.get('browser'), beforeBulkClose); assert.equal(all().length, 0);
  });
  check('persisted descriptors exclude owner payloads, grants, paths, native and PTY ids', () => {
    const values = JSON.parse(sessionStorage.getItem('pi-gui:secondary-tabs:v1'));
    for (const [, value] of values) for (const tab of value.tabs) assert.deepEqual(Object.keys(tab).sort(), ['id', 'view']);
    assert.doesNotMatch(JSON.stringify(values), /unsaved local UI state|grant|token|backend-A/);
  });
  empty();
  const broken = surfaces.openSecondarySurface('fixture-failure', (_host, view) => {
    view.onDispose(() => disposed.push(['isolated', 'success'])); view.onDispose(() => { throw new Error('fixture cleanup failure'); });
  });
  broken.close();
  check('failing cleanup cannot strand other owned resources and close is idempotent', () => {
    assert.ok(disposed.some(([view]) => view === 'isolated')); assert.equal(broken.disposed, true);
    assert.doesNotThrow(() => { broken.close(); broken.dispose(); }); assert.equal(all().length, 0);
  });
  for (let i = 0; i < 12; i++) { scope = 'bounded-' + i; surfaces.syncSecondaryScope(); open('changes'); }
  check('session storage history has a bounded scope count', () => assert.ok(JSON.parse(sessionStorage.getItem('pi-gui:secondary-tabs:v1')).length <= 8));
  console.log(`Surface tabs: ${assertions}/${assertions} assertions; ${cases} categories; 0 skipped`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  surfaces?.configureSecondaryPane(null); dom?.window.close();
});
