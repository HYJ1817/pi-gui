const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

let checks = 0;
const ok = (name, value) => {
  assert.ok(typeof value === 'function' ? value() : value, name);
  checks++;
  console.log('  ok  ' + name);
};
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, label = 'workbench UI state') => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await tick(10);
  }
  throw new Error(label + ' timeout');
};

function indexPayload(workspaceId, generation, label) {
  return {
    ok: true,
    workspace: { id: workspaceId, generation },
    documents: [
      { id: '1'.repeat(32), path: 'SPEC.md', bytes: 100, oversized: false },
      { id: '2'.repeat(32), path: 'specs/guide.md', bytes: 100, oversized: false },
    ],
    label,
  };
}

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  global.CustomEvent = dom.window.CustomEvent;
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.cancelAnimationFrame = clearTimeout;
  let activeObservers = 0;
  global.ResizeObserver = class {
    constructor(fn) { this.fn = fn; this.observed = new Set(); }
    observe(node) { this.observed.add(node); activeObservers++; }
    disconnect() { if (this.observed.size) activeObservers -= this.observed.size; this.observed.clear(); }
  };

  const { S } = await import('../public/state.js');
  const { initRightPane } = await import('../public/right-pane.js');
  const { configureSecondaryPane } = await import('../public/ui/secondary-surface.js');
  const { openSplitWorkbench, normalizeSplitRatio, clampSplitRatio, splitRatioAt, SPLIT_WORKBENCH_LIMITS } =
    await import('../public/ui/split-workbench.js');
  const { openSpecsPanel } = await import('../public/specs-panel.js');
  const { setGitConversationScope } = await import('../public/api.js');
  const { openChangesPanel, refreshGitNow, resetChanges } = await import('../public/git.js');

  S.workspaceGeneration = 1;
  S.switching = false;
  S.bridgeState = 'ready';
  const pane = initRightPane();
  configureSecondaryPane(pane);
  const listenerCounts = new Map();
  const listenerKey = (target, type) => (target === document ? 'document:' : 'window:') + type;
  const addDocument = document.addEventListener.bind(document);
  const removeDocument = document.removeEventListener.bind(document);
  const addWindow = window.addEventListener.bind(window);
  const removeWindow = window.removeEventListener.bind(window);
  const countListener = (delta, target, type) => {
    const key = listenerKey(target, type);
    listenerCounts.set(key, (listenerCounts.get(key) || 0) + delta);
  };
  document.addEventListener = (type, fn, opts) => { countListener(1, document, type); return addDocument(type, fn, opts); };
  document.removeEventListener = (type, fn, opts) => { countListener(-1, document, type); return removeDocument(type, fn, opts); };
  window.addEventListener = (type, fn, opts) => { countListener(1, window, type); return addWindow(type, fn, opts); };
  window.removeEventListener = (type, fn, opts) => { countListener(-1, window, type); return removeWindow(type, fn, opts); };

  let scope = null;
  let statusCalls = 0;
  let diffCalls = 0;
  let failStatus = false;
  let failIndex = false;
  let documentReply = null;
  let diffReply = null;
  const statusPayload = (id) => ({
    ok: true,
    isRepo: true,
    projectRoot: '/fixture/' + (id || 'classic'),
    files: [{ path: (id || 'classic') + '.txt', status: 'M', staged: false, untracked: false, additions: 2, deletions: 1 }],
  });
  const indexByScope = new Map();
  const documentByScope = new Map();
  const transport = {
    index: async () => failIndex ? {ok:false, error:'Specs fixture unavailable'} :
      indexByScope.get(scope || 'A') || indexPayload('w1', 'g1', 'A'),
    document: async (id) => {
      if (documentReply) return new Promise(resolve => { documentReply = resolve; });
      const current = indexByScope.get(scope || 'A') || indexPayload('w1', 'g1', 'A');
      const entry = current.documents.find((doc) => doc.id === id);
      return {
        ok: true,
        document: {
          ...entry,
          content: documentByScope.get((scope || 'A') + ':' + entry.path) || (`# ${current.label}\n\n## ${entry.path}\n`),
        },
      };
    },
  };
  indexByScope.set('A', indexPayload('w1', 'g1', 'A'));
  indexByScope.set('B', indexPayload('w2', 'g2', 'B'));
  let heldStatus = null;
  global.fetch = async (url, options = {}) => ({ json: async () => {
    const id = options.headers?.['X-Pi-Gui-Conversation'] || null;
    if (String(url).endsWith('/api/git/status')) {
      statusCalls++;
      if (id === 'A' && heldStatus) return new Promise((resolve) => { heldStatus = resolve; });
      if (failStatus) return { ok: false, error: 'Git fixture unavailable' };
      return statusPayload(id);
    }
    if (String(url).endsWith('/api/git/diff')) {
      diffCalls++;
      if (diffReply) return new Promise(resolve => { diffReply = resolve; });
      return {
        ok: true,
        staged: '',
        working: `@@ -1 +1 @@\n-old ${id || 'classic'}\n+new ${id || 'classic'}\n`,
        binary: false,
        truncated: false,
      };
    }
    throw new Error('unexpected fetch ' + url);
  } });

  let instance;
  const open = (surface = 'specs', height = 720) => {
    instance = openSplitWorkbench({
      returnSurface: surface,
      specsOptions: { transport },
    });
    const host = document.querySelector('.workbench-split');
    Object.defineProperty(host, 'getBoundingClientRect', {
      configurable: true,
      value: () => rectFor(height),
    });
    instance.measureWorkbenchLayout();
    return host;
  };
  document.addEventListener('pi-gui:open-split-workbench', (event) => {
    open(event.detail?.source === 'changes' ? 'changes' : 'specs');
  });
  const listenerBaseline = new Map(listenerCounts);
  const rectFor = (height, top = 0) => ({ top, left: 0, width: 420, height, right: 420, bottom: top + height });
  const setHeight = (host, height) => {
    Object.defineProperty(host, 'getBoundingClientRect', { configurable: true, value: () => rectFor(height) });
    instance.measureWorkbenchLayout();
  };

  try {
    ok('split ratio helpers clamp persisted values and pointer positions', () =>
      normalizeSplitRatio(0.7) === 0.7 &&
      normalizeSplitRatio('bad') === SPLIT_WORKBENCH_LIMITS.defaultRatio &&
      clampSplitRatio(0.01, 720) >= SPLIT_WORKBENCH_LIMITS.minPaneHeight / (720 - SPLIT_WORKBENCH_LIMITS.splitterSize) &&
      Math.abs(splitRatioAt(360, rectFor(720)) - 0.5) < 0.001);

    setGitConversationScope('A');
    await refreshGitNow();
    openChangesPanel();
    await until(() => document.querySelector('.chg-row'));
    document.querySelector('#btnChangesSplit').click();
    await until(() => pane.surface() === 'workbench-split');
    ok('a single Changes panel can switch to split without a second source of Git state', () =>
      document.querySelectorAll('.chg-body').length === 1 &&
      document.querySelectorAll('.workbench-pane').length === 2);
    document.querySelector('.workbench-pane-specs .workbench-exit').click();
    await until(() => pane.surface() === 'changes');
    ok('exiting split restores the originating single-panel mode', () =>
      document.querySelector('#rightPane').dataset.surface === 'changes' &&
      !document.querySelector('.workbench-split'));
    openSpecsPanel({ transport });
    await until(() => pane.surface() === 'specs' && document.querySelector('#btnSpecsSplit'));
    document.querySelector('#btnSpecsSplit').click();
    await until(() => pane.surface() === 'workbench-split');
    ok('the split entry in the single Specs header opens the same workbench', () =>
      document.querySelectorAll('.workbench-pane').length === 2);
    const host = open('specs');
    await until(() => document.querySelector('[data-spec-path="SPEC.md"]') && document.querySelector('.chg-row'));
    ok('Specs and Changes mount together in one workbench instance', () =>
      pane.surface() === 'workbench-split' &&
      document.querySelectorAll('.workbench-pane').length === 2 &&
      document.querySelector('.specs-markdown').textContent.includes('A') &&
      document.querySelector('.chg-path').textContent === 'A.txt');
    ok('split mode exposes a real horizontal separator and independent headers', () =>
      document.querySelector('.workbench-splitter').getAttribute('aria-orientation') === 'horizontal' &&
      document.querySelectorAll('#workbenchSpecsPane .rp-head, #workbenchChangesPane .chg-head').length === 2);

    document.querySelector('.chg-main').click();
    await until(() => document.querySelector('.chg-diff')?.textContent.includes('new A'));
    const diffBefore = document.querySelector('.chg-diff').textContent;
    document.querySelector('[data-spec-path="specs/guide.md"]').click();
    await until(() => document.querySelector('.specs-doc-path')?.textContent === 'specs/guide.md');
    ok('changing the selected Specs document leaves the expanded diff untouched', () =>
      !document.querySelector('.chg-diff').hidden &&
      document.querySelector('.chg-diff').textContent === diffBefore);

    const selectedBeforeRefresh = document.querySelector('.specs-doc-path').textContent;
    const statusCallsBeforeRefresh = statusCalls;
    document.querySelector('#btnChangesRefresh').click();
    await until(() => document.querySelector('.chg-row') && statusCalls > statusCallsBeforeRefresh);
    ok('refreshing Changes keeps the selected Specs document', () =>
      document.querySelector('.specs-doc-path').textContent === selectedBeforeRefresh);
    document.querySelector('.chg-main').click();
    await until(() => document.querySelector('.chg-diff')?.textContent.includes('new A'));
    document.querySelector('#btnSpecsRefresh').click();
    await until(() => document.querySelector('[data-spec-path="SPEC.md"]'));
    ok('refreshing Specs keeps the Changes diff expanded', () =>
      !document.querySelector('.chg-diff').hidden &&
      document.querySelector('.chg-diff').textContent.includes('new A'));

    const splitter = document.querySelector('.workbench-splitter');
    const initial = instance.workbenchSnapshot();
    splitter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    const afterKey = instance.workbenchSnapshot();
    ok('keyboard adjusts the split ratio and persists it', () =>
      afterKey.ratio > initial.ratio &&
      Math.abs(Number(JSON.parse(localStorage.getItem('pi-gui.workbench.split.v1')).ratio) - afterKey.storedRatio) < 0.0001);
    splitter.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    ok('double-click restores the default split ratio', () =>
      instance.workbenchSnapshot().storedRatio === SPLIT_WORKBENCH_LIMITS.defaultRatio);
    splitter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    const minimum = instance.workbenchSnapshot().ratio;
    splitter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    const maximum = instance.workbenchSnapshot().ratio;
    ok('Home and End keep both panes above their minimum heights', () =>
      minimum < maximum &&
      minimum >= SPLIT_WORKBENCH_LIMITS.minPaneHeight / (720 - SPLIT_WORKBENCH_LIMITS.splitterSize) - 0.001 &&
      maximum <= 1 - SPLIT_WORKBENCH_LIMITS.minPaneHeight / (720 - SPLIT_WORKBENCH_LIMITS.splitterSize) + 0.001);
    splitter.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));

    splitter.dispatchEvent(new window.MouseEvent('mousedown', { clientY: 400, button: 0, bubbles: true, cancelable: true }));
    document.dispatchEvent(new window.MouseEvent('mousemove', { clientY: 470, bubbles: true }));
    document.dispatchEvent(new window.MouseEvent('mouseup', { clientY: 470, bubbles: true }));
    ok('mouse drag changes the split ratio without rebuilding either child', () => {
      const now = instance.workbenchSnapshot();
      return now.ratio > initial.ratio && document.querySelector('.chg-diff') !== null;
    });
    const persisted = instance.workbenchSnapshot().storedRatio;
    pane.close();
    const reopened = open('specs');
    await until(() => document.querySelector('.specs-markdown') && document.querySelector('.chg-row'));
    ok('ratio survives reopening while document content is not persisted', () =>
      Math.abs(instance.workbenchSnapshot().storedRatio - persisted) < 0.0001 &&
      !localStorage.getItem('pi-gui.workbench.split.v1').includes('SPEC.md'));

    setHeight(reopened, 280);
    ok('short workbenches fall back to one visible panel instead of compressing both', () =>
      reopened.classList.contains('is-fallback') &&
      !document.querySelector('.workbench-modebar').hidden &&
      !document.querySelector('#workbenchSpecsPane').hidden &&
      document.querySelector('#workbenchChangesPane').hidden);
    document.querySelector('[data-workbench-tab="changes"]').click();
    document.querySelector('[data-workbench-tab="changes"]').focus();
    ok('fallback tabs switch panels and retain both live child instances', () =>
      document.querySelector('#workbenchSpecsPane').hidden &&
      !document.querySelector('#workbenchChangesPane').hidden &&
      document.querySelector('.chg-row') !== null);
    setHeight(reopened, 720);
    ok('growing the window restores the two-pane layout with state intact', () =>
      !reopened.classList.contains('is-fallback') &&
      !document.querySelector('#workbenchSpecsPane').hidden &&
      !document.querySelector('#workbenchChangesPane').hidden);
    ok('growing out of fallback moves focus from the hidden mode bar to the splitter', () =>
      !document.querySelector('.workbench-modebar').contains(document.activeElement) &&
      document.activeElement === document.querySelector('.workbench-splitter'));

    window.innerWidth = 720;
    window.dispatchEvent(new window.Event('resize'));
    ok('720px windows fall back without changing right-pane width or chat draft', () =>
      reopened.dataset.workbenchMode === 'fallback' && pane.width() === 420);
    window.innerWidth = 1200;
    window.dispatchEvent(new window.Event('resize'));
    ok('restoring width resumes both panels', () => reopened.dataset.workbenchMode === 'split');

    const gitRowsBeforeFailure = document.querySelector('.chg-body').textContent;
    failIndex = true;
    document.querySelector('#btnSpecsRefresh').click();
    await until(() => document.querySelector('.specs-error')?.textContent.includes('Specs fixture unavailable'));
    ok('a Specs failure keeps the Changes state usable', () => document.querySelector('.chg-body').textContent === gitRowsBeforeFailure);
    failIndex = false;
    document.querySelector('#btnSpecsRefresh').click();
    await until(() => document.querySelector('.specs-markdown'));

    const specsTextBeforeFailure = document.querySelector('.specs-markdown').textContent;
    failStatus = true;
    document.querySelector('#btnChangesRefresh').click();
    await until(() => document.querySelector('.chg-body')?.textContent.includes('Git fixture unavailable'));
    ok('a Changes failure degrades independently without clearing Specs', () =>
      document.querySelector('.specs-markdown').textContent === specsTextBeforeFailure);
    failStatus = false;
    document.querySelector('#btnChangesRefresh').click();
    await until(() => document.querySelector('.chg-row'));

    S.workspaceGeneration++;
    resetChanges();
    document.dispatchEvent(new window.CustomEvent('pi-gui:workspace-generation'));
    ok('workspace generation changes immediately remove both old panes from view', () =>
      !document.querySelector('[data-spec-path]') &&
      !document.querySelector('.chg-row') &&
      document.querySelector('.workbench-split'));

    heldStatus = () => {};
    await until(() => document.querySelector('[data-spec-path="SPEC.md"]'));
    documentReply = () => {};
    document.querySelector('[data-spec-path="SPEC.md"]').click();
    diffReply = () => {};
    document.querySelector('.chg-main')?.click();
    await tick();
    const releaseOldDocument = documentReply;
    const releaseOldDiff = diffReply;
    documentReply = null;
    diffReply = null;
    setGitConversationScope('A');
    const pending = refreshGitNow();
    await tick();
    scope = 'B';
    setGitConversationScope('B');
    await refreshGitNow();
    heldStatus(null);
    await pending;
    await tick(20);
    ok('a late old-scope Changes response cannot overwrite the new workbench scope', () =>
      document.querySelector('.chg-path').textContent === 'B.txt');
    releaseOldDocument({ok:true, document:{path:'SPEC.md', content:'# OLD PRIVATE A'}});
    releaseOldDiff({ok:true,working:'OLD PRIVATE A'});
    await tick();
    await until(() => document.querySelector('.specs-markdown')?.textContent.includes('B'));
    ok('late document and diff responses cannot display A in focused B', () =>
      !pane.root.textContent.includes('OLD PRIVATE A') && document.querySelector('.specs-markdown').textContent.includes('B'));

    document.getElementById('input').value = 'split workbench draft';
    open('specs');
    pane.open('browser');
    ok('switching to Browser disposes the workbench without touching the chat draft', () =>
      pane.surface() === 'browser' &&
      !document.querySelector('.workbench-split') &&
      document.getElementById('input').value === 'split workbench draft');

    openChangesPanel();
    document.querySelector('#btnChangesSplit').focus();
    const shortHost = open('changes', 280);
    await tick();
    ok('entering fallback moves focus out of the now-hidden pane', () =>
      shortHost.classList.contains('is-fallback') &&
      document.querySelector('#workbenchSpecsPane').hidden &&
      document.activeElement?.dataset?.workbenchTab === 'changes' &&
      !document.querySelector('#workbenchSpecsPane').contains(document.activeElement));

    setHeight(shortHost, 720);
    document.querySelector('.workbench-splitter').focus();
    setHeight(shortHost, 280);
    ok('shrinking while splitter is focused transfers focus to a visible fallback tab', () =>
      document.activeElement?.dataset?.workbenchTab === 'changes');

    pane.close();
    const observersBefore = activeObservers;
    for (let i = 0; i < 4; i++) {
      open(i % 2 ? 'changes' : 'specs');
      pane.close();
    }
    ok('repeated open/close releases split observers and leaves the right pane empty', () =>
      activeObservers === observersBefore &&
      document.querySelectorAll('#rightPane .rp-surface').length === 0);
    ok('repeated open/close leaves no split scope, resize or drag listeners behind', () =>
      ['document:pi-gui:git-scope', 'document:pi-gui:workspace-generation', 'window:resize',
        'document:mousemove', 'document:mouseup'].every(key =>
        (listenerCounts.get(key) || 0) === (listenerBaseline.get(key) || 0)));

    console.log(`Split workbench UI: ${checks}/${checks}; skipped=0`);
  } finally {
    dom.window.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
