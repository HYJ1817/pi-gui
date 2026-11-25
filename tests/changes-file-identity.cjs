'use strict';
/* F7: the Changes "查看文件" action must bind the workspace identity that
 * rendered the row. A click whose dynamic import resolves after the workspace,
 * worktree, generation or runtime owner moved on must not open a same-named
 * file in the replacement scope. In-memory fixture only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const until = async (fn, label = 'state') => { for (let i = 0; i < 200; i++) { if (await fn()) return; await tick(10); } throw new Error(label + ' timeout'); };
let checks = 0;
const ok = (name, value) => { assert.ok(typeof value === 'function' ? value() : value, name); checks++; console.log('  ok   ' + name); };

async function main() {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/' });
  Object.assign(global, {
    window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
    MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
  });
  const { S } = await import('../public/state.js');
  const { initRightPane } = await import('../public/right-pane.js');
  const { configureSecondaryPane } = await import('../public/ui/secondary-surface.js');
  const { setGitConversationScope } = await import('../public/api.js');
  const { openChangesPanel, refreshGitNow } = await import('../public/git.js');

  const pane = initRightPane();
  configureSecondaryPane(pane);
  setGitConversationScope(null);

  const diffBody = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n+alpha\n+beta\n context\n';
  const statusFiles = () => [{ path: 'a.txt', status: 'M', staged: false, untracked: false, additions: 2, deletions: 0 }];
  // Count any file metadata read: a view-file open that passes the identity
  // binding reaches the Files transport, which is exactly what we are guarding.
  let fileMetadataReads = 0;
  global.fetch = async url => {
    const u = String(url);
    if (u.endsWith('/api/git/status')) return { json: async () => ({ ok: true, isRepo: true, projectRoot: S.cwd, files: statusFiles() }) };
    if (u.endsWith('/api/git/diff')) return { json: async () => ({ ok: true, isRepo: true, path: 'a.txt', untracked: false, isDir: false, binary: false, staged: '', working: diffBody, truncated: false, limit: 524288, notice: '', context: null }) };
    if (u.includes('/api/files/metadata') || u.includes('/api/files/document') || u.includes('/api/files/content')) { fileMetadataReads++; return { json: async () => ({ ok: false }) }; }
    if (u.includes('/api/files')) return { json: async () => ({ ok: true, entries: [], workspace: null }) };
    return { json: async () => ({ ok: true }) };
  };
  const resetWorkspace = (cwd, generation, session = 'classic-a') => {
    S.cwd = cwd; S.workspaceGeneration = generation; S.state = { sessionId: session };
    S.switching = false; S.bridgeState = 'ready'; S.hasProject = true; S.submitting = false; S.stopping = false;
  };

  try {
    /* Scenario 1: generation advances between click and import resolution. */
    resetWorkspace('C:\\fixture-ws-a', 1);
    await openChangesPanel();
    await refreshGitNow();
    await until(() => pane.root.querySelector('.chg-view-file'), 'view-file button');
    const before = fileMetadataReads;
    pane.root.querySelector('.chg-view-file').click();
    // Advance the generation synchronously in the same turn the async import runs.
    resetWorkspace('C:\\fixture-ws-a', 2);
    document.dispatchEvent(new window.CustomEvent('pi-gui:workspace-generation'));
    await tick(40);
    ok('generation change during import resolution does not read the file', () => fileMetadataReads === before);

    /* Scenario 2: worktree (cwd) replacement during import resolution. */
    resetWorkspace('C:\\fixture-ws-b', 3);
    document.dispatchEvent(new window.CustomEvent('pi-gui:workspace-generation'));
    await openChangesPanel();
    await refreshGitNow();
    await until(() => pane.root.querySelector('.chg-view-file'), 'view-file button remount');
    const before2 = fileMetadataReads;
    pane.root.querySelector('.chg-view-file').click();
    resetWorkspace('C:\\fixture-ws-c', 3); // same generation, different worktree
    await tick(40);
    ok('worktree replacement during import resolution does not read the file', () => fileMetadataReads === before2);

    /* Scenario 3: conversation scope change during import resolution. */
    resetWorkspace('C:\\fixture-ws-c', 4);
    document.dispatchEvent(new window.CustomEvent('pi-gui:workspace-generation'));
    await openChangesPanel();
    await refreshGitNow();
    await until(() => pane.root.querySelector('.chg-view-file'), 'view-file button scope');
    const before3 = fileMetadataReads;
    pane.root.querySelector('.chg-view-file').click();
    setGitConversationScope('other-conversation');
    await tick(40);
    ok('conversation scope change during import resolution does not read the file', () => fileMetadataReads === before3);
    setGitConversationScope(null);

    /* Scenario 4: a click in a stable workspace is allowed to proceed. */
    resetWorkspace('C:\\fixture-ws-d', 5);
    document.dispatchEvent(new window.CustomEvent('pi-gui:workspace-generation'));
    await openChangesPanel();
    await refreshGitNow();
    await until(() => pane.root.querySelector('.chg-view-file'), 'view-file button stable');
    const before4 = fileMetadataReads;
    pane.root.querySelector('.chg-view-file').click();
    await tick(60);
    // The identity binding must not block a legitimate click. Whether the file
    // opens depends on metadata, but the click must reach the Files transport
    // (a metadata or document read), proving it was not incorrectly refused.
    ok('stable workspace click reaches the file transport', () => fileMetadataReads > before4);

    console.log(`\nChanges file identity: ${checks}/${checks}`);
  } finally {
    pane.close();
    dom.window.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
