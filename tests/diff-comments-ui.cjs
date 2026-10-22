/* T3-A: Changes-panel line comments in jsdom.
 *
 * The fixture project is entirely in-memory: /api/git/status and /api/git/diff
 * are stubbed. No user files, Git index or Planner data are touched.
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
  const { configureSecondaryPane } = await import('../public/ui/secondary-surface.js');
  const { setGitConversationScope } = await import('../public/api.js');
  const { openChangesPanel, refreshGitNow, resetChanges } = await import('../public/git.js');
  const { currentReviewScope, commentsForScope } = await import('../public/diff-comments.js');
  const { fillReviewComposer } = await import('../public/review-fill.js');

  S.workspaceGeneration = 1;
  S.switching = false;
  S.bridgeState = 'ready';
  S.hasProject = true;
  S.submitting = false;
  S.stopping = false;
  S.cwd = 'C:\\fixture-a';
  S.state = { sessionId: 'classic-a' };
  const pane = initRightPane();
  configureSecondaryPane(pane);

  let currentScope = null;
  let scopeText = 'A';
  let heldStatus = null;
  let holdNextStatus = false;
  let pendingDiff = null;
  let failStatus = false;
  let failDiff = false;
  let diffBody = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n+alpha\n+beta\n context\n';
  let stagedBody = '';
  let truncatedDiff = false;
  const requests = [];
  const statusFiles = (id) => [{ path: `${id || 'classic'}.txt`, status: 'M', staged: false, untracked: false, additions: 2, deletions: 0 }];

  const reviewBackend = require('./fixtures/review-comment-backend.cjs')(() => S.cwd + '|' + S.state.sessionId);
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/review-comments')) return reviewBackend.response(options);
    const id = options.headers?.['X-Pi-Gui-Conversation'] || null;
    requests.push({ url: String(url), id, body: options.body || '' });
    if (String(url).endsWith('/api/git/status')) {
      if (holdNextStatus) {
        holdNextStatus = false;
        return new Promise((resolve) => { heldStatus = resolve; });
      }
      if (failStatus) return { json: async () => ({ ok: false, error: 'status failed' }) };
      return { json: async () => ({ ok: true, isRepo: true, projectRoot: '/fixture/' + (id || 'classic'), files: statusFiles(id) }) };
    }
    if (String(url).endsWith('/api/git/diff')) {
      if (pendingDiff) return new Promise((resolve) => { pendingDiff = resolve; });
      if (failDiff) return { json: async () => ({ ok: false, error: 'diff failed' }) };
      return { json: async () => ({
        ok: true, isRepo: true, path: `${id || 'classic'}.txt`, untracked: false, isDir: false,
        binary: false, staged: stagedBody.replace(/a\.txt/g, `${id || 'classic'}.txt`),
        working: diffBody.replace(/a\.txt/g, `${id || 'classic'}.txt`),
        truncated: truncatedDiff, limit: 524288, notice: '', context: null,
      }) };
    }
    return { json: async () => ({ ok: true }) };
  };

  const rows = () => [...document.querySelectorAll('#rightPane .chg-row')];
  const rowOf = (name) => rows().find((row) => row.querySelector('.chg-path')?.textContent === name);
  const openRow = async (name = 'A.txt') => {
    const row = rowOf(name);
    if (row.querySelector('.chg-diff').hidden) row.querySelector('.chg-main').click();
    await until(() => row.querySelector('.d-row'));
    return row;
  };
  const gutter = (row, newLine) => row.querySelector(`.d-row[data-new-line="${newLine}"][data-line-type="add"] .d-gutter`);
  const editor = (row) => row.querySelector('.d-review-editor');
  const save = (row) => editor(row)?.querySelector('.btn.primary');
  const cancel = (row) => [...(editor(row)?.querySelectorAll('button') || [])].find((b) => b.textContent === '取消');
  const remove = (row) => [...(editor(row)?.querySelectorAll('button') || [])].find((b) => b.textContent === '删除');

  try {
    setGitConversationScope('A');
    currentScope = currentReviewScope();
    await refreshGitNow();
    openChangesPanel();
    await until(() => document.querySelector('#btnReviewStorage')?.textContent === '评论已同步');
    await until(() => rowOf('A.txt'));
    const row = await openRow('A.txt');
    ok('Changes renders real add rows with new line numbers', () =>
      gutter(row, 1) !== null && gutter(row, 2) !== null);

    gutter(row, 1).click();
    await tick();
    ok('clicking a gutter opens an inline textarea without collapsing the diff', () =>
      editor(row)?.querySelector('textarea') &&
      row.querySelector('.d-row[data-new-line="1"]').classList.contains('reviewing') &&
      row.querySelector('.chg-diff').hidden === false);
    const textarea = editor(row).querySelector('textarea');
    textarea.value = '请把这个判断改成幂等';
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    save(row).click();
    await tick();
    ok('saving a comment closes the editor and marks the row', () =>
      !editor(row) && row.querySelector('.d-row[data-new-line="1"]').classList.contains('has-comment') &&
      document.querySelector('#btnChangesReview').textContent.includes('1'));
    ok('saving does not auto-send into the chat composer', () =>
      document.getElementById('input').value === '');
    ok('comment is stored only in the current review scope', () =>
      commentsForScope(currentScope).length === 1 && commentsForScope('other').length === 0);

    gutter(row, 1).click();
    await tick();
    editor(row).querySelector('textarea').value = '未落盘的编辑草稿';
    editor(row).querySelector('textarea').dispatchEvent(new window.Event('input', { bubbles: true }));
    reviewBackend.error = 'comment_storage_write_failed';
    save(row).click(); await tick();
    ok('a failed save keeps the actual editor text and confirmed comment unchanged', () =>
      editor(row).querySelector('textarea').value === '未落盘的编辑草稿' &&
      commentsForScope(currentScope)[0].text === '请把这个判断改成幂等' && editor(row).querySelector('.err'));
    reviewBackend.error = 'comment_conflict';
    save(row).click(); await tick();
    ok('a revision conflict leaves the draft visible with an explicit error', () =>
      editor(row).querySelector('textarea').value === '未落盘的编辑草稿' &&
      document.querySelector('#btnReviewStorage').textContent === '重新加载评论');
    reviewBackend.error = null;
    document.querySelector('#btnReviewStorage').click(); await tick();
    ok('explicit reload preserves the editor draft for the user to decide', () =>
      editor(row).querySelector('textarea').value === '未落盘的编辑草稿');
    editor(row).querySelector('textarea').value = '请把这个判断改成幂等';
    let releaseSave;
    reviewBackend.hold = () => new Promise(resolve => { releaseSave = resolve; });
    save(row).click(); await tick();
    ok('an unacknowledged save stays pending without closing the editor', () =>
      editor(row) && save(row).disabled && editor(row).querySelector('.d-review-status').textContent.includes('正在保存'));
    reviewBackend.hold = null; releaseSave(); await tick();
    ok('only the acknowledged retry closes the editor and retains the marker', () => !editor(row) && gutter(row, 1).closest('.d-row').classList.contains('has-comment'));
    gutter(row, 1).click(); await tick();
    reviewBackend.error = 'comment_storage_write_failed'; remove(row).click(); await tick();
    ok('failed deletion keeps both confirmed comment and editor available', () => editor(row) && commentsForScope(currentScope).length === 1);
    reviewBackend.error = null; cancel(row).click(); await tick();

    row.querySelector('.chg-main').click();
    await tick();
    ok('collapsing the diff preserves the comment', () =>
      row.querySelector('.chg-diff').hidden === true &&
      document.querySelector('#btnChangesReview').textContent.includes('1'));
    row.querySelector('.chg-main').click();
    await tick();
    ok('reopening the same diff restores the comment marker', () =>
      row.querySelector('.d-row[data-new-line="1"]').classList.contains('has-comment'));

    gutter(row, 2).click();
    await tick();
    editor(row).querySelector('textarea').value = '第二条：补充边界条件';
    editor(row).querySelector('textarea').dispatchEvent(new window.Event('input', { bubbles: true }));
    save(row).click();
    await tick();
    ok('one file can hold multiple line comments', () =>
      row.querySelectorAll('.d-row.has-comment').length === 2 &&
      document.querySelector('#btnChangesReview').textContent.includes('2'));

    row.querySelector('.d-row[data-new-line="1"] .d-gutter').click();
    await tick();
    editor(row).querySelector('textarea').value = '改成幂等且无副作用';
    editor(row).querySelector('textarea').dispatchEvent(new window.Event('input', { bubbles: true }));
    save(row).click();
    await tick();
    ok('an existing comment can be edited', () =>
      commentsForScope(currentScope)[0].text === '改成幂等且无副作用');

    gutter(row, 2).click();
    await tick();
    remove(row).click();
    await tick();
    ok('a comment can be deleted', () =>
      row.querySelectorAll('.d-row.has-comment').length === 1 &&
      document.querySelector('#btnChangesReview').textContent.includes('1'));

    gutter(row, 2).click();
    await tick();
    editor(row).querySelector('textarea').value = '不应保存';
    editor(row).querySelector('textarea').dispatchEvent(new window.Event('input', { bubbles: true }));
    cancel(row).click();
    await tick();
    ok('cancel discards the unsaved editor text', () =>
      !editor(row) && !row.querySelector('.d-row[data-new-line="2"]').classList.contains('has-comment'));

    document.querySelector('#btnChangesReview').click();
    await tick();
    ok('review summary groups comments and exposes a feedback preview', () => {
      const card = document.querySelector('#modalCard');
      return card.querySelector('.review-file-group h4')?.textContent === 'A.txt' &&
        card.querySelector('.review-feedback-preview')?.value.includes('改成幂等且无副作用') &&
        card.querySelector('.review-feedback-preview').value.includes('A.txt');
    });
    const copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => copied.push(text) } });
    [...document.querySelectorAll('#modalCard .btn')].find((b) => b.textContent === '复制审查意见').click();
    await tick(10);
    ok('copy exports bounded plain-text feedback', () =>
      copied.length === 1 && copied[0].includes('A.txt') && copied[0].includes('改成幂等且无副作用') &&
      !copied[0].includes('/fixture/'));
    document.querySelector('#modalCard .btn:last-of-type')?.click();
    await tick();

    setGitConversationScope(null);
    S.state = { sessionId: 'classic-a' };
    document.getElementById('input').value = '我的原有草稿';
    const fillResult = fillReviewComposer('审查反馈正文');
    ok('fill appends to the existing classic draft instead of overwriting it', () =>
      fillResult.ok && document.getElementById('input').value.startsWith('我的原有草稿') &&
      document.getElementById('input').value.includes('审查反馈正文'));
    ok('fill only targets the focused classic composer', () =>
      fillResult.target === 'classic' && document.activeElement === document.getElementById('input'));

    setGitConversationScope('A');
    await refreshGitNow();
    await until(() => rowOf('A.txt'));
    const draftRow = await openRow('A.txt');
    gutter(draftRow, 1).click();
    await tick();
    editor(draftRow).querySelector('textarea').value = '未保存的评论';
    editor(draftRow).querySelector('textarea').dispatchEvent(new window.Event('input', { bubbles: true }));
    diffBody = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n+alpha\n+beta\n context changed\n';
    await refreshGitNow();
    await until(() => rowOf('A.txt')?.querySelector('.d-row'));
    const refreshedRow = await openRow('A.txt');
    ok('refresh preserves an unsaved draft on the same anchor', () =>
      editor(refreshedRow)?.querySelector('textarea')?.value === '未保存的评论');
    cancel(refreshedRow).click();
    await tick();

    diffBody = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n+alpha changed more\n+beta\n context\n';
    await refreshGitNow();
    const changedRow = await openRow('A.txt');
    ok('a changed diff marks the old anchor stale instead of rebinding it', () =>
      commentsForScope(currentScope)[0].stale === true &&
      !changedRow.querySelector('.d-row[data-new-line="1"]').classList.contains('has-comment'));

    document.querySelector('#btnChangesReview').click();
    await tick();
    ok('stale comments stay visible and copyable in the summary', () =>
      document.querySelector('#modalCard .review-stale')?.textContent === '原位置已变化' &&
      [...document.querySelectorAll('#modalCard .btn')].some((b) => b.textContent === '复制审查意见' && !b.disabled));
    document.querySelector('#modalCard .btn:last-of-type')?.click();
    await tick();

    failDiff = true;
    await refreshGitNow();
    rowOf('A.txt').querySelector('.chg-main').click();
    await tick(20);
    ok('a failed diff request degrades inside the panel without dropping the comment scope', () =>
      rowOf('A.txt').querySelector('.chg-diff').textContent.includes('diff failed') &&
      commentsForScope(currentScope).length === 1);
    failDiff = false;

    /* A backend-truncated diff cannot prove that any anchored line vanished. */
    truncatedDiff = true;
    await refreshGitNow();
    const truncatedRow = rowOf('A.txt');
    if (truncatedRow.querySelector('.chg-diff').hidden) truncatedRow.querySelector('.chg-main').click();
    await until(() => truncatedRow.querySelector('.d-review-note'));
    ok('a truncated diff explains that comment anchors are unproven', () =>
      truncatedRow.querySelector('.d-review-note').textContent.includes('原状态保持不变'));
    ok('a truncated diff leaves the previous stale verdict untouched', () =>
      commentsForScope(currentScope)[0].stale === true &&
      commentsForScope(currentScope)[0].verified === false);
    truncatedDiff = false;

    /* Staged and working sections can show the same line numbers; a comment
     * must stay attached to the section it was created in. */
    stagedBody = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,2 @@\n ctx\n+staged-add\n';
    await refreshGitNow();
    const bothRow = await openRow('A.txt');
    await until(() => bothRow.querySelectorAll('.chg-block').length === 2);
    const stagedGutter = bothRow.querySelector(
      '.chg-block[data-review-section="staged"] .d-row[data-line-type="add"][data-new-line="2"] .d-gutter'
    );
    ok('staged and working diffs are labelled with a fixed section value', () =>
      stagedGutter !== null &&
      bothRow.querySelector('.chg-block[data-review-section="working"]') !== null);
    stagedGutter.click();
    await tick();
    editor(bothRow).querySelector('textarea').value = '暂存区意见';
    editor(bothRow).querySelector('textarea').dispatchEvent(new window.Event('input', { bubbles: true }));
    save(bothRow).click();
    await tick();
    ok('a comment on the staged section does not mark the working row', () => {
      const stagedRow = bothRow.querySelector('.chg-block[data-review-section="staged"] .d-row[data-new-line="2"]');
      const workingRows = [...bothRow.querySelectorAll('.chg-block[data-review-section="working"] .d-row[data-new-line="2"]')];
      return stagedRow.classList.contains('has-comment') &&
        workingRows.every((item) => !item.classList.contains('has-comment'));
    });

    /* Jumping from the summary must pick the same section, not merely the same
     * line numbers. */
    document.querySelector('#btnChangesReview').click();
    await tick();
    const stagedItem = [...document.querySelectorAll('#modalCard .review-item')]
      .find((item) => item.textContent.includes('暂存区意见'));
    [...stagedItem.querySelectorAll('button')].find((b) => b.textContent === '编辑').click();
    await tick(80);
    ok('editing from the summary opens the editor in the matching section', () =>
      bothRow.querySelector('.chg-block[data-review-section="staged"] .d-row.reviewing') !== null &&
      bothRow.querySelector('.chg-block[data-review-section="working"] .d-row.reviewing') === null);
    cancel(bothRow).click();
    await tick();
    document.querySelector('#btnChangesReview').click();
    await tick();
    const stagedItemAgain = [...document.querySelectorAll('#modalCard .review-item')]
      .find((item) => item.textContent.includes('暂存区意见'));
    [...stagedItemAgain.querySelectorAll('button')].find((b) => b.textContent === '删除').click();
    await tick();
    ok('deleting the staged comment leaves the working comment intact', () =>
      commentsForScope(currentScope).length === 1 &&
      commentsForScope(currentScope)[0].text === '改成幂等且无副作用');
    [...document.querySelectorAll('#modalCard .btn')].find((b) => b.textContent === '关闭').click();
    await tick();
    stagedBody = '';
    await refreshGitNow();
    await until(() => rowOf('A.txt'));

    setGitConversationScope('B');
    await refreshGitNow();
    await until(() => rowOf('B.txt'));
    ok('switching focused conversations replaces the file list and hides A comments', () =>
      commentsForScope().length === 0 &&
      !document.querySelector('#btnChangesReview').textContent.includes('1'));

    /* An unsaved comment must not reappear in the *other* scope. */
    const otherRow = await openRow('B.txt');
    gutter(otherRow, 1).click();
    await tick();
    editor(otherRow).querySelector('textarea').value = 'B 的未保存评论';
    editor(otherRow).querySelector('textarea').dispatchEvent(new window.Event('input', { bubbles: true }));
    setGitConversationScope('A');
    await refreshGitNow();
    await until(() => rowOf('A.txt'));
    await openRow('A.txt');
    ok('switching scope drops the unsaved editor of the previous scope', () =>
      document.querySelectorAll('.d-review-editor').length === 0);
    setGitConversationScope('B');
    await refreshGitNow();
    await until(() => rowOf('B.txt'));
    const backRow = await openRow('B.txt');
    ok('the discarded draft is not resurrected on returning to that scope', () =>
      document.querySelectorAll('.d-review-editor').length === 0 &&
      !backRow.querySelector('.d-row.has-comment'));

    setGitConversationScope('A');
    await refreshGitNow();
    await until(() => rowOf('A.txt'));
    ok('switching back to the classic scope restores only its own comments', () =>
      commentsForScope(currentScope).length === 1 &&
      document.querySelector('#btnChangesReview').textContent.includes('1'));

    /* Classic session switch keeps the same workspace but a different bucket. */
    setGitConversationScope(null);
    await refreshGitNow();
    await until(() => rowOf('classic.txt'));
    const classicRow = await openRow('classic.txt');
    gutter(classicRow, 2).click();
    await tick();
    editor(classicRow).querySelector('textarea').value = '旧会话的未保存评论';
    editor(classicRow).querySelector('textarea').dispatchEvent(new window.Event('input', { bubbles: true }));
    ok('classic sessions get their own comment scope', () =>
      currentReviewScope().includes('classic:classic-a') && commentsForScope().length === 0);

    /* The session-switch event fires before S.state.sessionId catches up.
     * In that window the old editor must already be gone and its gutters
     * must refuse to start a new one, otherwise Enter on 保存 would write
     * into the incoming session's bucket. */
    const staleGutter = classicRow.querySelector('.d-row[data-new-line="3"] .d-gutter');
    const staleSave = save(classicRow);
    document.dispatchEvent(new window.CustomEvent('pi-gui:session-switch'));
    ok('a session switch closes the old editor synchronously', () =>
      document.querySelectorAll('.d-review-editor').length === 0 &&
      !classicRow.querySelector('.d-row.reviewing'));
    ok('a session switch disables the old diff gutters until the new scope is painted', () =>
      [...classicRow.querySelectorAll('.d-gutter')].every((b) => b.disabled === true));
    staleGutter.click();
    staleSave?.click?.();
    await tick();
    ok('a stale gutter or save button cannot open an editor in the switch window', () =>
      document.querySelectorAll('.d-review-editor').length === 0 &&
      document.querySelectorAll('.d-row.has-comment').length === 0);
    ok('the unsaved classic draft was discarded, not stored', () =>
      commentsForScope().length === 0);

    S.state = { sessionId: 'classic-b' };
    document.dispatchEvent(new window.CustomEvent('pi-gui:session-switch'));
    ok('a classic session switch removes the previous review counts immediately', () =>
      !document.querySelector('#btnChangesReview').textContent.includes('1') &&
      document.querySelector('#btnChangesReview').disabled === true &&
      !document.querySelector('.chg-review-n'));
    await refreshGitNow();
    await until(() => rowOf('classic.txt'));
    await openRow('classic.txt');
    ok('a classic session switch clears the previous session editor and comments', () =>
      document.querySelectorAll('.d-review-editor').length === 0 &&
      commentsForScope().length === 0 &&
      !document.querySelector('#btnChangesReview').textContent.includes('1'));
    const beforeStaleClick = requests.filter(r => r.url.endsWith('/api/review-comments') && r.body).length;
    staleSave.click(); await tick();
    ok('a detached old Save cannot write after the next session has fully recovered', () =>
      commentsForScope().length === 0 && requests.filter(r => r.url.endsWith('/api/review-comments') && r.body).length === beforeStaleClick);
    S.state = { sessionId: 'classic-a' };
    document.dispatchEvent(new window.CustomEvent('pi-gui:session-switch'));
    await refreshGitNow();
    await until(() => rowOf('classic.txt'));

    /* Panel close/reopen keeps comments, discards unsaved editor text. */
    setGitConversationScope('A');
    await refreshGitNow();
    await until(() => rowOf('A.txt'));
    const closeRow = await openRow('A.txt');
    gutter(closeRow, 2).click();
    await tick();
    editor(closeRow).querySelector('textarea').value = '关闭面板前的草稿';
    editor(closeRow).querySelector('textarea').dispatchEvent(new window.Event('input', { bubbles: true }));
    pane.close();
    await tick();
    openChangesPanel();
    await refreshGitNow();
    await until(() => rowOf('A.txt'));
    const reopenRow = await openRow('A.txt');
    ok('closing and reopening the panel keeps saved comments but drops the draft', () =>
      document.querySelectorAll('.d-review-editor').length === 0 &&
      !reopenRow.querySelector('.d-row.has-comment') &&
      document.querySelector('#btnChangesReview').textContent.includes('1'));

    holdNextStatus = true;
    const old = refreshGitNow();
    await tick();
    const releaseOld = heldStatus;
    setGitConversationScope('B');
    await refreshGitNow();
    releaseOld({ json: async () => ({ ok: true, isRepo: true, files: statusFiles('A') }) });
    await old;
    await tick();
    ok('a late status response cannot repaint the newer scope', () =>
      rowOf('B.txt') && !rowOf('A.txt'));

    const pendingCloseRow = await openRow('B.txt');
    gutter(pendingCloseRow, 1).click(); await tick();
    editor(pendingCloseRow).querySelector('textarea').value = '关闭时仍在保存的评论';
    let releaseClosed;
    reviewBackend.hold = () => new Promise(resolve => { releaseClosed = resolve; });
    save(pendingCloseRow).click(); await tick(); pane.close();
    reviewBackend.hold = null; releaseClosed(); await tick();
    ok('closing a panel while saving never resurrects its editor after the acknowledgement', () =>
      !document.querySelector('.d-review-editor') && commentsForScope().length === 1);
    openChangesPanel();
    await until(() => document.querySelector('#btnReviewStorage')?.textContent === '评论已同步');
    const afterCloseRow = await openRow('B.txt');
    ok('reopening after a pending save exposes the confirmed comment without restoring its draft', () =>
      afterCloseRow.querySelectorAll('.d-row.has-comment').length === 1 && !editor(afterCloseRow));

    document.getElementById('input').value = '切换前的聊天草稿';
    pane.open('browser');
    ok('opening Browser closes the Changes surface without touching chat draft', () =>
      pane.surface() === 'browser' && document.getElementById('input').value === '切换前的聊天草稿');

    resetChanges();
    S.workspaceGeneration++;
    document.dispatchEvent(new window.CustomEvent('pi-gui:workspace-generation'));
    ok('a workspace generation change clears the old Changes DOM', () =>
      !document.querySelector('#rightPane .chg-row'));

    ok('fill refuses when the page is not on a conversation view', () => {
      const result = fillReviewComposer('不会填入');
      return result.ok === false && document.getElementById('input').value === '切换前的聊天草稿';
    });
  } finally {
    pane.close();
    dom.window.close();
  }

  console.log(`\nDiff comments UI: ${checks}/${checks}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
