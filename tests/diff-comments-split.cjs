/* T3-A: line comments inside the Specs + Changes split workbench.
 *
 * All data is stubbed in memory. The point of this suite is the interaction
 * between the split container and the existing Changes panel: comments must
 * survive split re-layout, must not leak between scopes, and repeated
 * open/close must not accumulate listeners.
 */
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
const until = async (fn, label = 'split comment state') => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await tick(10);
  }
  throw new Error(label + ' timeout');
};

const indexPayload = (id) => ({
  ok: true,
  workspace: { id: `w-${id}`, generation: id },
  documents: [
    { id: '1'.repeat(32), path: 'SPEC.md', bytes: 100, oversized: false },
    { id: '2'.repeat(32), path: 'specs/guide.md', bytes: 100, oversized: false },
  ],
});

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/' });
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
  });
  global.ResizeObserver = class {
    constructor(fn) { this.fn = fn; this.nodes = new Set(); }
    observe(node) { this.nodes.add(node); }
    unobserve(node) { this.nodes.delete(node); }
    disconnect() { this.nodes.clear(); }
  };

  const listenerCounts = new Map();
  const keyFor = (target, type) => `${target === document ? 'document' : 'window'}:${type}`;
  for (const target of [document, window]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type, fn, opts) => {
      const key = keyFor(target, type);
      listenerCounts.set(key, (listenerCounts.get(key) || 0) + 1);
      return add(type, fn, opts);
    };
    target.removeEventListener = (type, fn, opts) => {
      const key = keyFor(target, type);
      listenerCounts.set(key, (listenerCounts.get(key) || 0) - 1);
      return remove(type, fn, opts);
    };
  }

  const { S } = await import('../public/state.js');
  const { initRightPane } = await import('../public/right-pane.js');
  const { configureSecondaryPane } = await import('../public/ui/secondary-surface.js');
  const { openSplitWorkbench } = await import('../public/ui/split-workbench.js');
  const { setGitConversationScope } = await import('../public/api.js');
  const { refreshGitNow } = await import('../public/git.js');
  const { commentsForScope, currentReviewScope } = await import('../public/diff-comments.js');

  S.workspaceGeneration = 1;
  S.switching = false;
  S.bridgeState = 'ready';
  S.hasProject = true;
  S.submitting = false;
  S.stopping = false;
  S.cwd = 'C:\\fixture-split';
  S.state = { sessionId: 'classic-split' };

  const pane = initRightPane();
  configureSecondaryPane(pane);

  let scope = 'A';
  global.fetch = async (url, options = {}) => {
    const id = options.headers?.['X-Pi-Gui-Conversation'] || null;
    if (String(url).endsWith('/api/git/status')) {
      return {
        json: async () => ({
          ok: true, isRepo: true, projectRoot: `/fixture/${id || 'classic'}`,
          files: [{ path: `${id || 'classic'}.txt`, status: 'M', staged: false, untracked: false, additions: 2, deletions: 0 }],
        }),
      };
    }
    if (String(url).endsWith('/api/git/diff')) {
      return {
        json: async () => ({
          ok: true, staged: '', binary: false, truncated: false,
          working: `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,3 @@\n line\n+first ${id || 'classic'}\n+second\n`,
        }),
      };
    }
    throw new Error('unexpected fetch ' + url);
  };

  const transport = {
    index: async () => indexPayload(scope),
    document: async (id) => {
      const entry = indexPayload(scope).documents.find((doc) => doc.id === id);
      return { ok: true, document: { ...entry, content: `# Scope ${scope}\n\n## ${entry.path}\n` } };
    },
  };

  const host = () => {
    const node = document.querySelector('.workbench-split');
    if (node) {
      Object.defineProperty(node, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ top: 0, left: 0, width: 420, height: 720, right: 420, bottom: 720 }),
      });
    }
    return node;
  };
  const open = (surface = 'specs') => {
    const instance = openSplitWorkbench({ returnSurface: surface, specsOptions: { transport } });
    host();
    instance.measureWorkbenchLayout();
    return instance;
  };
  const changeRow = () => document.querySelector('#workbenchChangesPane .chg-row');
  const gutterFor = (newLine) => document.querySelector(
    `#workbenchChangesPane .d-row[data-line-type="add"][data-new-line="${newLine}"] .d-gutter`
  );

  try {
    setGitConversationScope('A');
    await refreshGitNow();
    open('specs');
    await until(() => document.querySelector('[data-spec-path="SPEC.md"]') && changeRow());

    changeRow().querySelector('.chg-main').click();
    await until(() => gutterFor('2'));
    ok('the Changes pane inside the split exposes commentable diff rows', () =>
      gutterFor('2') !== null && gutterFor('3') !== null);

    gutterFor('2').click();
    await tick();
    const editor = document.querySelector('#workbenchChangesPane .d-review-editor textarea');
    ok('the inline editor opens inside the split pane, not as a dialog', () =>
      Boolean(editor) && !document.getElementById('modalCard')?.classList.contains('open'));
    editor.value = '分屏里的行级意见';
    editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    document.querySelector('#workbenchChangesPane .d-review-editor .btn.primary').click();
    await tick();
    ok('a comment is saved to the focused scope from the split pane', () =>
      commentsForScope(currentReviewScope()).length === 1 &&
      document.querySelector('#workbenchChangesPane .d-row.has-comment') !== null);

    /* Re-layout must not rebuild the panes or lose the marker. */
    const splitter = document.querySelector('.workbench-splitter');
    splitter.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    splitter.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    ok('resizing the split keeps the comment marker and the expanded diff', () =>
      document.querySelector('#workbenchChangesPane .d-row.has-comment') !== null &&
      document.querySelector('#workbenchChangesPane .chg-diff').hidden === false);

    document.querySelector('[data-spec-path="specs/guide.md"]').click();
    await until(() => document.querySelector('.specs-doc-path')?.textContent === 'specs/guide.md');
    ok('switching Specs documents keeps the Changes comment visible', () =>
      commentsForScope(currentReviewScope()).length === 1 &&
      document.querySelector('#workbenchChangesPane .d-row.has-comment') !== null);

    document.querySelector('#btnChangesReview').click();
    await tick();
    const card = document.getElementById('modalCard');
    ok('the review summary works from the split Changes header', () =>
      card.querySelector('.review-file-group h4')?.textContent === 'A.txt' &&
      card.querySelector('.review-feedback-preview')?.value.includes('分屏里的行级意见'));
    [...card.querySelectorAll('.btn')].find((b) => b.textContent === '关闭').click();
    await tick();

    setGitConversationScope('B');
    scope = 'B';
    await refreshGitNow();
    await until(() => changeRow()?.querySelector('.chg-path')?.textContent === 'B.txt');
    ok('switching the focused conversation hides A comments in the split', () =>
      commentsForScope().length === 0 &&
      !document.querySelector('#workbenchChangesPane .d-row.has-comment'));

    setGitConversationScope('A');
    scope = 'A';
    await refreshGitNow();
    await until(() => changeRow()?.querySelector('.chg-path')?.textContent === 'A.txt');
    changeRow().querySelector('.chg-main').click();
    await until(() => gutterFor('2'));
    ok('returning to A restores only its own comment', () =>
      commentsForScope(currentReviewScope()).length === 1 &&
      gutterFor('2')?.closest('.d-row').classList.contains('has-comment'));

    /* Baseline after a close, so the comparison measures accumulation across
     * cycles instead of the listeners that belong to the open workbench. */
    pane.close();
    const baseline = new Map(listenerCounts);
    for (let i = 0; i < 6; i++) {
      open(i % 2 ? 'changes' : 'specs');
      await until(() => changeRow());
      pane.close();
    }
    const leaked = [...listenerCounts]
      .filter(([key, value]) => value !== (baseline.get(key) || 0))
      .map(([key, value]) => `${key}:+${value - (baseline.get(key) || 0)}`);
    ok(`repeated split open/close does not accumulate document or window listeners (${leaked.join(', ') || 'none'})`, () =>
      leaked.length === 0);
    ok('comments remain in the scope after the split is disposed and reopened', () =>
      commentsForScope(currentReviewScope()).length === 1);

    console.log(`Diff comments in split: ${checks}/${checks}`);
  } finally {
    pane.close();
    dom.window.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
