const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

let checks = 0;
const ok = (name, value) => {
  assert.ok(value, name);
  checks++;
  console.log('  ok  ' + name);
};
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, label = 'UI state') => {
  for (let i = 0; i < 160; i++) {
    if (await fn()) return;
    await tick(10);
  }
  throw new Error(label + ' timeout; pane=' + (document.getElementById('rightPane')?.textContent || ''));
};

function makeDom() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="app">
      <nav id="globalRail"><button id="navHome"></button></nav>
      <aside id="projectSidebar"></aside>
      <main id="workspace" data-workspace-view="chat"></main>
      <div id="rightPaneResizer"></div>
      <aside id="rightPane" class="right-pane" hidden><div class="rp-titlebar"></div><div class="rp-body"></div></aside>
      <div class="head-right"><button id="btnSpecs" aria-pressed="false"></button><button id="btnMore"></button></div>
      <div id="modal" hidden></div><div id="confirmLayer" hidden></div><div id="paletteLayer" hidden></div>
      <div id="globalMoreMenu" hidden></div><div id="toasts"></div>
    </div>
  </body></html>`, { url: 'http://127.0.0.1/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  global.CustomEvent = dom.window.CustomEvent;
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.cancelAnimationFrame = clearTimeout;
  return dom;
}

function indexPayload(workspaceId, generation, docs) {
  return {
    ok: true,
    workspace: { id: workspaceId, generation },
    documents: docs.map((doc, index) => ({
      id: String(index + 1).padStart(32, '0'),
      path: doc.path,
      bytes: Buffer.byteLength(doc.content || ''),
      oversized: false,
    })),
  };
}

(async () => {
  const dom = makeDom();
  const { S } = await import('../public/state.js');
  const { initRightPane } = await import('../public/right-pane.js');
  const { configureSecondaryPane } = await import('../public/ui/secondary-surface.js');
  const { openSpecsPanel } = await import('../public/specs-panel.js');
  const { md } = await import('../public/markdown.js');
  const { buildSpecTree, resolveSpecLink } = await import('../public/specs-tree.js');

  S.workspaceGeneration = 1;
  S.switching = false;
  S.bridgeState = 'ready';
  const pane = initRightPane();
  configureSecondaryPane(pane);

  try {
    ok('Markdown heading IDs are opt-in and preserve existing chat rendering', () =>
      !md('# Chat').includes(' id=') &&
      md('# Chat', { headingIds: true }).includes('<h4 id="chat">Chat</h4>'));
    ok('duplicate Markdown headings receive stable unique anchors', () =>
      md('# Same\n## Same', { headingIds: true }).includes('id="same"') &&
      md('# Same\n## Same', { headingIds: true }).includes('id="same-2"'));

    const tree = buildSpecTree([
      { id: '1', path: 'specs/guide.md' },
      { id: '2', path: 'SPEC.md' },
      { id: '3', path: 'specs/nested/setup.md' },
    ]);
    ok('tree keeps SPEC.md first and nests specs directories', () =>
      tree[0].name === 'SPEC.md' &&
      tree[1].name === 'specs' &&
      tree[1].children.some((node) => node.name === 'nested'));

    const paths = new Set(['SPEC.md', 'specs/overview.md', 'specs/guides/setup.markdown']);
    ok('relative Markdown links resolve only to indexed paths', () => {
      assert.equal(resolveSpecLink('specs/overview.md', 'guides/setup.markdown#install', paths).path, 'specs/guides/setup.markdown');
      assert.equal(resolveSpecLink('specs/overview.md', '../SPEC.md', paths).path, 'SPEC.md');
      assert.equal(resolveSpecLink('SPEC.md', '../outside.md', paths).kind, 'blocked');
      assert.equal(resolveSpecLink('SPEC.md', '/etc/passwd', paths).kind, 'blocked');
      return true;
    });

    const initialDocs = [
      {
        path: 'SPEC.md',
        content: '# Project\n\n[Overview](specs/overview.md)\n\n[Bad](../secret.md)\n',
      },
      {
        path: 'specs/overview.md',
        content: '# Overview\n\n[Setup](guides/setup.markdown#install)\n\n<script>evil()</script>\n',
      },
      {
        path: 'specs/guides/setup.markdown',
        content: '# Setup\n\n## Install\n\n### Install\n',
      },
    ];
    let indexCalls = 0;
    let documentCalls = 0;
    let currentIndex = indexPayload('w1', 'g1', initialDocs);
    let failIndex = false;
    let failDocument = false;
    let holdDocument = null;
    const contentByPath = new Map(initialDocs.map((doc) => [doc.path, doc.content]));
    const transport = {
      index: async () => {
        indexCalls++;
        if (failIndex) return { ok: false, code: 'specs_unavailable', error: '读取失败' };
        return currentIndex;
      },
      document: async (id, workspace, generation) => {
        documentCalls++;
        if (holdDocument) {
          const held = holdDocument;
          holdDocument = null;
          await held;
        }
        if (failDocument) return { ok: false, code: 'oversized', error: '文档过大' };
        const doc = currentIndex.documents.find((entry) => entry.id === id);
        if (!doc) return { ok: false, code: 'document_missing', error: '文档不存在' };
        assert.equal(workspace.id, currentIndex.workspace.id);
        assert.equal(generation, currentIndex.workspace.generation);
        return { ok: true, document: { ...doc, content: contentByPath.get(doc.path) } };
      },
    };

    openSpecsPanel({ transport });
    await until(() => document.querySelector('.specs-doc-item'));
    ok('Specs opens inside the existing right pane without global navigation', () =>
      pane.surface() === 'specs' &&
      !pane.root.hidden &&
      !document.getElementById('globalRail').querySelector('#btnSpecs') &&
      document.getElementById('btnSpecs').closest('.head-right') !== null);
    ok('document tree renders SPEC.md and expandable directories', () =>
      Boolean(document.querySelector('[data-spec-path="SPEC.md"]')) &&
      Boolean(document.querySelector('[data-spec-dir="specs"] [aria-expanded="true"]')));
    ok('SPEC.md is selected without requiring a second click', () =>
      document.querySelector('[data-spec-path="SPEC.md"]').getAttribute('aria-current') === 'page' &&
      document.querySelector('.specs-doc-path').textContent === 'SPEC.md');

    const specsDir = document.querySelector('[data-spec-dir="specs"] > button');
    specsDir.click();
    ok('directory collapse hides its descendants', () =>
      specsDir.getAttribute('aria-expanded') === 'false' &&
      document.querySelector('[data-spec-path="specs/overview.md"]') === null);
    specsDir.click();
    ok('directory expand restores its descendants', () =>
      Boolean(document.querySelector('[data-spec-path="specs/overview.md"]')));

    document.querySelector('[data-spec-path="specs/overview.md"]').click();
    await until(() => document.querySelector('.specs-doc-path')?.textContent === 'specs/overview.md');
    ok('clicking a document fetches and renders Markdown in the same pane', () =>
      document.querySelector('.specs-markdown').textContent.includes('Overview'));
    ok('malicious Markdown remains inert text', () =>
      !document.querySelector('.specs-markdown script') &&
      !document.querySelector('.specs-markdown img') &&
      document.querySelector('.specs-markdown').textContent.includes('<script>evil()</script>'));

    const setupLink = document.querySelector('.specs-markdown a[href="guides/setup.markdown#install"]');
    setupLink.click();
    await until(() => document.querySelector('.specs-doc-path')?.textContent === 'specs/guides/setup.markdown');
    ok('relative document links navigate inside the allowlisted index', () =>
      document.querySelector('.specs-markdown #install') !== null);
    ok('duplicate headings get distinct same-document anchors', () =>
      document.querySelectorAll('.specs-markdown h4[id^="install"]').length === 2);

    document.querySelector('[data-spec-path="SPEC.md"]').click();
    await until(() => document.querySelector('.specs-doc-path')?.textContent === 'SPEC.md');
    document.querySelector('.specs-markdown a[href="../secret.md"]').click();
    await tick(10);
    ok('a relative link outside the indexed Specs set is blocked with a visible reason', () =>
      /仅支持|项目内/.test(document.querySelector('.specs-doc-notice').textContent));

    const beforeRefresh = indexCalls;
    currentIndex = indexPayload('w1', 'g1', [...initialDocs, { path: 'specs/new.md', content: '# New\n' }]);
    contentByPath.set('specs/new.md', '# New\n');
    document.querySelector('.rp-head-actions button').click();
    await until(() => document.querySelector('[data-spec-path="specs/new.md"]'));
    ok('manual refresh discovers newly added documents', () => indexCalls > beforeRefresh);

    currentIndex = { ...currentIndex, incomplete: true };
    document.querySelector('.rp-head-actions button').click();
    await until(() => document.querySelector('.specs-error[data-tone="warn"]'));
    ok('an incomplete scan is disclosed instead of silently presenting a partial tree', () =>
      document.querySelector('.specs-error').textContent.includes('列表可能不完整'));
    currentIndex = { ...currentIndex, incomplete: false };
    document.querySelector('.rp-head-actions button').click();
    await until(() => document.querySelector('.specs-error').hidden);

    failIndex = true;
    document.querySelector('.rp-head-actions button').click();
    await until(() => document.querySelector('.specs-error'));
    ok('a failed refresh keeps the previous tree usable', () =>
      Boolean(document.querySelector('[data-spec-path="SPEC.md"]')) &&
      document.querySelector('.specs-error').textContent.includes('读取失败'));
    failIndex = false;

    failDocument = true;
    document.querySelector('[data-spec-path="specs/new.md"]').click();
    await until(() => document.querySelector('.specs-doc-notice')?.textContent.includes('文档过大'));
    ok('oversized or failed document reads preserve the tree and explain the degradation', () =>
      Boolean(document.querySelector('[data-spec-path="SPEC.md"]')));
    failDocument = false;

    S.switching = true;
    S.workspaceGeneration++;
    document.dispatchEvent(new window.CustomEvent('pi-gui:workspace-generation'));
    ok('workspace change immediately removes the previous workspace content', () =>
      document.querySelector('.specs-doc-path') === null &&
      document.querySelector('.specs-empty') !== null);
    currentIndex = indexPayload('w2', 'g2', [{ path: 'SPEC.md', content: '# Worktree B\n' }]);
    contentByPath.set('SPEC.md', '# Worktree B\n');
    S.switching = false;
    await until(() => document.querySelector('.specs-markdown')?.textContent.includes('Worktree B'));
    ok('Specs auto-reloads for the new workspace generation', () =>
      document.querySelector('[data-spec-path="SPEC.md"]') !== null);

    document.dispatchEvent(new window.CustomEvent('pi-gui:git-scope'));
    ok('focused conversation scope changes clear the previous tree immediately', () =>
      !document.querySelector('[data-spec-path="SPEC.md"]') &&
      document.querySelector('.specs-doc-path') === null);
    await until(() => indexCalls >= 5);
    ok('focused conversation scope changes reload Specs from the backend', () => indexCalls >= 5);

    const lateCalls = documentCalls;
    let releaseDocument;
    holdDocument = new Promise((resolve) => { releaseDocument = resolve; });
    document.querySelector('[data-spec-path="SPEC.md"]').click();
    S.switching = true;
    S.workspaceGeneration++;
    document.dispatchEvent(new window.CustomEvent('pi-gui:workspace-generation'));
    currentIndex = indexPayload('w3', 'g3', [{ path: 'SPEC.md', content: '# Worktree C\n' }]);
    contentByPath.set('SPEC.md', '# Worktree C\n');
    S.switching = false;
    await until(() => document.querySelector('.specs-markdown')?.textContent.includes('Worktree C'));
    releaseDocument();
    await tick(20);
    ok('a late document response cannot overwrite the new workspace', () =>
      documentCalls > lateCalls &&
      !document.querySelector('.specs-markdown').textContent.includes('Worktree B'));

    const callsBeforeDispose = indexCalls;
    pane.open('changes');
    document.dispatchEvent(new window.CustomEvent('pi-gui:git-scope'));
    await tick(20);
    ok('leaving Specs disposes its listeners and in-flight work', () =>
      pane.surface() === 'changes' && indexCalls === callsBeforeDispose);

    currentIndex = indexPayload('w4', 'g4', []);
    openSpecsPanel({ transport });
    await until(() => document.querySelector('.specs-empty'));
    ok('an empty project has a compact state and leaves chat DOM untouched', () =>
      document.querySelector('.specs-empty').textContent.includes('没有 Specs') &&
      document.getElementById('workspace').dataset.workspaceView === 'chat');

    console.log(`Specs UI: ${checks}/${checks}; skipped=0`);
  } finally {
    dom.window.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
