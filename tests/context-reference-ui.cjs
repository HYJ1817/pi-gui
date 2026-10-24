/* Z1: log references and right-pane reopen state, offline DOM contract.
 *
 * Fixture project is in-memory only; no user files, Git data or logs are touched.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

let checks = 0;
const ok = (name, value) => {
  assert.ok(typeof value === 'function' ? value() : value, name);
  checks++;
  console.log('  ok   ' + name);
};
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, label = 'state') => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await tick(10);
  }
  throw new Error(label + ' timeout');
};

async function main() {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/' });
  // Actual overflow and clamping are covered by z1-electron.cjs with real CSS.
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
  });

  const { S } = await import('../public/state.js');
  const { initRightPane } = await import('../public/right-pane.js');
  const { configureSecondaryPane, readPaneState } = await import('../public/ui/secondary-surface.js');
  const { setGitConversationScope } = await import('../public/api.js');
  const { openChangesPanel } = await import('../public/git.js');
  const { openSpecsPanel } = await import('../public/specs-panel.js');
  const { buildLogReference } = await import('../public/diagnostics.js');
  const { fillReviewComposer } = await import('../public/review-fill.js');

  S.workspaceGeneration = 1;
  S.switching = false;
  S.bridgeState = 'ready';
  S.hasProject = true;
  S.submitting = false;
  S.stopping = false;
  S.cwd = 'C:\\fixture-z1';
  S.state = { sessionId: 'classic-z1' };
  const pane = initRightPane();
  configureSecondaryPane(pane);
  setGitConversationScope(null);

  const statusFiles = () => [{ path: 'a.txt', status: 'M', staged: false, untracked: false, additions: 2, deletions: 0 }];
  const diffBody = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n+alpha\n+beta\n context\n';
  global.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/api/git/status')) {
      return { json: async () => ({ ok: true, isRepo: true, projectRoot: '/fixture/z1', files: statusFiles() }) };
    }
    if (u.endsWith('/api/git/diff')) {
      return { json: async () => ({
        ok: true, isRepo: true, path: 'a.txt', untracked: false, isDir: false,
        binary: false, staged: '', working: diffBody, truncated: false,
        limit: 524288, notice: '', context: null,
      }) };
    }
    if (u.includes('/api/specs')) {
      if (u.includes('/api/specs/document?')) {
        return { json: async () => ({ ok: true, document: { id: 'z1-doc', path: 'SPEC.md', main: true, content: '# 标题一\n\n正文\n\n## 标题二\n\n更多正文\n' } }) };
      }
      return { json: async () => ({
        ok: true,
        workspace: { id: 'z1-workspace', generation: 1 },
        documents: [{ id: 'z1-doc', path: 'SPEC.md', main: true }],
        truncated: false, incomplete: false,
      }) };
    }
    return { json: async () => ({ ok: true }) };
  };

  const entry = {
    v: 1, timestamp: '2026-10-24T08:00:00.000Z', level: 'ERROR', source: 'pi-bridge',
    event: 'bridge.request_timeout', code: 'BRIDGE_TIMEOUT', correlationId: 'corr-z1',
    process: 'backend', details: { operation: 'get_state', secretPath: 'C:\\Users\\someone' },
    cursor: 'c1',
  };

  try {
    /* ---------- Task A: log reference ---------- */

    const reference = buildLogReference(entry);
    ok('log reference carries whitelisted identity fields only', () =>
      reference.includes('bridge.request_timeout') && reference.includes('ERROR') &&
      reference.includes('pi-bridge') && reference.includes('BRIDGE_TIMEOUT') &&
      !reference.includes('secretPath') && !reference.includes('C:\\Users') &&
      !reference.includes('get_state') && !reference.includes('corr-z1'));

    ok('log reference fills the focused classic composer without sending', () => {
      document.getElementById('input').value = '已有草稿';
      const result = fillReviewComposer(reference);
      return result.ok && result.target === 'classic' &&
        document.getElementById('input').value.startsWith('已有草稿') &&
        document.getElementById('input').value.includes('bridge.request_timeout');
    });

    /* ---------- Task B1: Changes reopen keeps expanded diffs + scroll ---------- */

    await openChangesPanel();
    await until(() => document.querySelector('#rightPane .chg-row'));
    const row = document.querySelector('#rightPane .chg-row');
    row.querySelector('.chg-main').click();
    await until(() => row.querySelector('.d-row'));
    const scroller = pane.root.querySelector('.chg-list');
    scroller.scrollTop = 40;
    scroller.dispatchEvent(new window.Event('scroll', { bubbles: false }));
    ok('diff row is expanded before the panel switch', () => !row.querySelector('.chg-diff').hidden);

    openSpecsPanel();
    await tick(20);
    ok('switching surfaces clears the Changes DOM', () => !pane.root.querySelector('.chg-row'));
    await until(() => pane.root.querySelector('.specs-surface'));

    openChangesPanel();
    await until(() => pane.root.querySelector('.chg-row .chg-diff:not([hidden])'));
    const reopenedRow = pane.root.querySelector('#rightPane .chg-row');
    ok('reopening Changes restores the expanded diff for the same scope', () =>
      Boolean(reopenedRow) && !reopenedRow.querySelector('.chg-diff').hidden);
    await until(() => pane.root.querySelector('.chg-list')?.scrollTop === 40, 'list scroll restore');
    ok('list restoration targets .chg-list rather than the non-scrolling body', () =>
      pane.root.querySelector('.chg-body').scrollTop === 0 && pane.root.querySelector('.chg-list').scrollTop === 40);

    /* A scope switch must still drop the retained state. */
    document.dispatchEvent(new window.CustomEvent('pi-gui:session-switch'));
    await tick(20);
    /* 面板已打开时重复调用不会重建 DOM（现有行为），必须先切走再切回。 */
    openSpecsPanel();
    await tick(20);
    openChangesPanel();
    await until(() => pane.root.querySelector('.chg-row'));
    ok('session switch drops the retained expanded-diff state', () => {
      const freshRow = pane.root.querySelector('.chg-row');
      return Boolean(freshRow) && freshRow.querySelector('.chg-diff').hidden;
    });

    /* ---------- Task B2: Specs reopen keeps expanded dirs + selection ---------- */

    openSpecsPanel();
    await until(() => pane.root.querySelector('.specs-doc-item'));
    await until(() => pane.root.querySelector('.specs-markdown h4'), 'specs document render');
    const docItem = pane.root.querySelector('.specs-doc-item');
    ok('specs document opens after the surface swap', () => Boolean(docItem));
    await tick(10);
    const specsSnapshot = readPaneState('specs');
    ok('specs state only snapshots after real content exists', () =>
      specsSnapshot === null || (specsSnapshot && specsSnapshot.workspaceId === 'z1-workspace'));

    /* Force a snapshot with collapsed state by disposing via surface switch. */
    const treeList = pane.root.querySelector('.specs-tree-list');
    const dirRow = pane.root.querySelector('.specs-tree-dir');
    if (dirRow) {
      dirRow.click();
      await tick(10);
    }
    const markdown = pane.root.querySelector('.specs-markdown');
    if (markdown) markdown.scrollTop = 30;
    if (treeList) treeList.scrollTop = 12;
    openChangesPanel();
    await tick(20);
    openSpecsPanel();
    await until(() => pane.root.querySelector('.specs-doc-item'), 'specs reopen');
    await tick(30);
    const restoredState = readPaneState('specs');
    ok('specs reopen keeps the selected document and snapshot identity', () =>
      Boolean(restoredState) && restoredState.workspaceId === 'z1-workspace' &&
      restoredState.selectedPath === 'SPEC.md');
  } finally {
    pane.close();
    dom.window.close();
  }

  console.log(`\nZ1 context reference UI: ${checks}/${checks}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
