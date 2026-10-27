// Regression test for Bug 11: Right pane ordinary panel auto-restore and scroll retention
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

(async () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(indexHtml, { url: 'http://127.0.0.1/' });

  global.window = dom.window;
  global.document = dom.window.document;
  global.sessionStorage = dom.window.sessionStorage;
  global.localStorage = dom.window.localStorage;
  global.CustomEvent = dom.window.CustomEvent;
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = fn => setTimeout(fn, 0);
  global.cancelAnimationFrame = id => clearTimeout(id);

  const { initRightPane } = await import('../public/right-pane.js');
  const {
    configureSecondaryPane,
    openSecondarySurface,
    readPaneState,
    writePaneState,
    clearPaneState,
    readRestoredSurface,
    writeRestoredSurface,
    clearRestoredSurface,
  } = await import('../public/ui/secondary-surface.js');
  await import('../public/git.js');

  let checks = 0;
  const ok = (name, cond) => {
    assert.ok(cond, name);
    checks++;
    console.log('  ok  ' + name);
  };

  const pane = initRightPane();
  configureSecondaryPane(pane);

  // 1. Ordinary panel tracking in sessionStorage
  openSecondarySurface('changes', (host) => {
    const list = document.createElement('div');
    list.className = 'chg-list';
    host.append(list);
  }, { label: '文件变更' });

  ok('changes surface is recorded for restore', readRestoredSurface() === 'changes');
  ok('pane is open', pane.isOpen());

  // Save changes scroll position in pane state
  writePaneState('changes', {
    lastChangesListScroll: 350,
    diffViewState: [['file-a.js', { open: true, scrollLeft: 40 }]],
  });

  // Verify pane state survives in sessionStorage
  const storedChangesState = readPaneState('changes');
  ok('changes state has saved scroll', storedChangesState?.lastChangesListScroll === 350);
  ok('changes state has diff view state', storedChangesState?.diffViewState?.[0]?.[0] === 'file-a.js');

  // 2. Browser surface is NEVER recorded or restored (Safety Rule)
  pane.open('browser');
  ok('browser surface is NOT recorded in restored surface', readRestoredSurface() === null);

  // Directly attempting writeRestoredSurface('browser') is safely blocked
  writeRestoredSurface('browser');
  ok('writeRestoredSurface rejects browser', readRestoredSurface() === null);

  // 3. Specs panel tracking
  openSecondarySurface('specs', (host) => {
    const list = document.createElement('div');
    list.className = 'specs-tree-list';
    host.append(list);
  }, { label: 'Specs 项目文档' });

  ok('specs surface is recorded for restore', readRestoredSurface() === 'specs');

  // Save specs scroll and selection state
  writePaneState('specs', {
    workspaceId: 'ws-1',
    workspaceGeneration: 1,
    selectedPath: 'docs/arch.md',
    expanded: ['docs'],
    treeScroll: 120,
    docScroll: 480,
  });

  const storedSpecsState = readPaneState('specs');
  ok('specs state has treeScroll and docScroll', storedSpecsState?.treeScroll === 120 && storedSpecsState?.docScroll === 480);
  ok('specs state has selectedPath', storedSpecsState?.selectedPath === 'docs/arch.md');

  // 4. Manual close clears restored surface
  pane.close();
  ok('closing pane clears restored surface', readRestoredSurface() === null);

  // 5. Session switch clears session-specific changes scroll and diff
  writePaneState('changes', {
    lastChangesListScroll: 200,
    diffViewState: [['test.js', { open: true }]],
  });
  ok('pre-switch changes state exists', readPaneState('changes') !== null);

  // Dispatch session switch event (production event, no manual clearPaneState call)
  document.dispatchEvent(new dom.window.CustomEvent('pi-gui:session-switch'));
  ok('session switch automatically clears changes pane state', readPaneState('changes') === null);

  // 6. Workspace switch clears all pane state and restored surface automatically
  writeRestoredSurface('changes');
  writePaneState('specs', { treeScroll: 100 });
  // Dispatch workspace generation event (production event, no manual clearPaneState call)
  document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-generation'));
  ok('workspace generation automatically clears restored surface', readRestoredSurface() === null);
  ok('workspace generation automatically clears specs pane state', readPaneState('specs') === null);

  console.log(`Panel restore UI: ${checks}/${checks} passed`);
})();
