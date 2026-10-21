/* T3-A: Unified Diff parsing and line-comment anchor model.
 *
 * Pure/offline: no network, no real pi, no user project writes. The scope
 * switching here uses the production API module against a jsdom document so
 * it exercises the same identity function the Changes panel uses.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

let checks = 0;
const check = (name, value) => {
  assert.ok(typeof value === 'function' ? value() : value, name);
  checks++;
  console.log('  ok   ' + name);
};

function linesOf(html) {
  const document = new JSDOM(`<body>${html}</body>`).window.document;
  return [...document.querySelectorAll('.d-row')];
}

function rowOf(lines, pick) {
  return lines.find(pick);
}

async function main() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://fixture.invalid/' });
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent,
  });

  const { S } = await import('../public/state.js');
  const { setGitConversationScope } = await import('../public/api.js');
  const { diffHtml, diffFingerprint, lineHash, countDiffLines } = await import('../public/diff.js');
  const {
    REVIEW_LIMITS,
    addComment,
    beginReviewRefresh,
    commentCount,
    commentAtPosition,
    commentForLine,
    commentsForPath,
    commentsForScope,
    currentReviewScope,
    deleteComment,
    formatReviewFeedback,
    lineKey,
    markMissingPathsStale,
    reconcileSection,
    reconcileSectionOptions,
    updateComment,
  } = await import('../public/diff-comments.js');

  console.log('\n--- Unified Diff 行号 ---');
  const multi = [
    'diff --git a/src/app.js b/src/app.js',
    'index 111..222 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -10,3 +20,4 @@ function alpha()',
    ' context-a',
    '-old-a',
    '+new-a',
    '+new-b',
    '@@ -40,2 +50,2 @@ function beta()',
    ' context-b',
    '-old-b',
    '+new-b',
  ].join('\n');
  let rows = linesOf(diffHtml(multi, { commentable: true }));
  const contextA = rowOf(rows, (row) => row.dataset.lineType === 'context' && row.dataset.oldLine === '10');
  const deletedA = rowOf(rows, (row) => row.dataset.lineType === 'del' && row.dataset.oldLine === '11');
  const addedA = rowOf(rows, (row) => row.dataset.lineType === 'add' && row.dataset.newLine === '21');
  const addedB = rowOf(rows, (row) => row.dataset.lineType === 'add' && row.dataset.newLine === '22');
  const secondContext = rowOf(rows, (row) => row.dataset.lineType === 'context' && row.dataset.oldLine === '40');
  check('context rows keep both old and new line numbers', () =>
    contextA?.dataset.oldLine === '10' && contextA.dataset.newLine === '20');
  check('deleted rows expose only the old line number', () =>
    deletedA?.dataset.oldLine === '11' && deletedA.dataset.newLine === '');
  check('added rows expose only the new line number', () =>
    addedA?.dataset.oldLine === '' && addedA.dataset.newLine === '21' &&
    addedB?.dataset.newLine === '22');
  check('line numbers continue past the first hunk', () =>
    secondContext?.dataset.oldLine === '40' && secondContext.dataset.newLine === '50');
  check('hunk headers and code stay byte-for-byte visible', () =>
    rows[0].ownerDocument.body.textContent.includes('@@ -10,3 +20,4 @@ function alpha()') &&
    rows[0].ownerDocument.body.textContent.includes('+new-a'));
  check('every rendered code row has a keyboard-accessible gutter', () =>
    rows.length === 7 && rows.every((row) => {
      const gutter = row.querySelector('.d-gutter');
      return gutter?.tagName === 'BUTTON' &&
        gutter.getAttribute('aria-label')?.includes('添加或编辑行评论');
    }));

  const pureAdd = linesOf(diffHtml('diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+first\n+second\n', { commentable: true }));
  check('pure additions start at new line 1 with no invented old line', () =>
    pureAdd.length === 2 &&
    pureAdd[0].dataset.oldLine === '' && pureAdd[0].dataset.newLine === '1' &&
    pureAdd[1].dataset.newLine === '2');

  const pureDelete = linesOf(diffHtml('diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-first\n-second\n', { commentable: true }));
  check('pure deletions keep old line numbers and no new line', () =>
    pureDelete.length === 2 &&
    pureDelete[1].dataset.oldLine === '2' && pureDelete[1].dataset.newLine === '');

  const crlf = linesOf(diffHtml('diff --git a/x b/x\r\n--- a/x\r\n+++ b/x\r\n@@ -1,2 +1,2 @@\r\n same\r\n-old\r\n+new\r\n', { commentable: true }));
  check('CRLF diffs render canonical rows and do not leak carriage returns', () =>
    crlf.length === 3 &&
    crlf.some((row) => row.textContent.includes('old')) &&
    !crlf.some((row) => row.textContent.includes('\r')));

  const noNewline = linesOf(diffHtml('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n', { commentable: true }));
  check('no-newline markers never receive a synthetic comment anchor', () =>
    noNewline.length === 2 && noNewline.every((row) => row.dataset.lineType !== 'note'));

  const malformed = linesOf(diffHtml('@@ not-a-hunk-header\n+orphan\n', { commentable: true }));
  check('malformed hunk headers fail closed and produce no comment anchors', () => malformed.length === 0);
  check('non-commentable callers keep the legacy diff shape', () =>
    linesOf(diffHtml(multi, { commentable: false })).length === 0);

  const hostile = '<img src=x onerror=alert(1)>';
  const hostileHtml = diffHtml(`diff --git a/${hostile} b/${hostile}\n@@ -0,0 +1 @@\n+${hostile}<script>alert(2)</script>\n`, { commentable: true });
  const hostileDom = new JSDOM(`<body>${hostileHtml}</body>`).window.document;
  check('hostile file names and code remain inert text', () =>
    hostileDom.querySelectorAll('script,img,iframe,svg,object,embed,style,link,meta,form,input,base').length === 0 &&
    hostileDom.body.textContent.includes(hostile) &&
    hostileDom.body.textContent.includes('<script>alert(2)</script>'));
  check('hostile hunk text is not serialized into an HTML attribute', () =>
    !hostileDom.querySelector('.diff').innerHTML.includes(hostile));

  console.log('\n--- 指纹 ---');
  const base = '@@ -1,4 +1,4 @@\n ctx\n-old\n+new\n tail\n';
  const wider = '@@ -1,6 +1,6 @@\n extra\n ctx\n-old\n+new\n tail\n extra2\n';
  check('changing only context depth preserves the diff fingerprint', () =>
    diffFingerprint(base) === diffFingerprint(wider));
  check('changing a changed line changes the fingerprint', () =>
    diffFingerprint(base) !== diffFingerprint('@@ -1,4 +1,4 @@\n ctx\n-old\n+newer\n tail\n'));
  check('line hashes are stable and distinguish code text', () =>
    lineHash('abc') === lineHash('abc') && lineHash('abc') !== lineHash('abd'));
  check('diff counts still match the existing +N/-N contract', () => {
    const n = countDiffLines(multi);
    return n.add === 3 && n.del === 2;
  });

  console.log('\n--- 评论作用域与锚点 ---');
  S.cwd = 'C:\\workspace-a';
  S.state = { sessionId: 'classic-a' };
  setGitConversationScope(null);
  const scopeA = currentReviewScope();
  check('scope identity includes the workspace and classic session', () =>
    scopeA.includes('classic:classic-a') && scopeA.includes('C:\\workspace-a'));

  const anchor = {
    path: 'a.txt',
    section: 'working',
    type: 'add',
    oldLine: null,
    newLine: 2,
    hunkIndex: 0,
    hunkHeader: 'aaaaaaaa',
    codeHash: lineHash('+changed'),
    diffFingerprint: diffFingerprint(base),
    snippet: '+changed',
  };
  check('empty comments are rejected', () => addComment({ path: 'a.txt', anchor, text: '  ' }).ok === false);
  const added = addComment({ path: 'a.txt', anchor, text: '请改成幂等实现' });
  check('a comment is stored in the current scope', () =>
    added.ok === true && commentCount() === 1 && commentsForPath('a.txt').length === 1);
  check('one line can only hold one comment', () =>
    addComment({ path: 'a.txt', anchor, text: 'second' }).ok === false);
  /* A stale comment still owns its visual line: a second comment there would
   * mean two opinions on one line, and both could later try to rebind. */
  const staleAnchor = { ...anchor, newLine: 7, codeHash: lineHash('+stale-line') };
  const staleCreated = addComment({ path: 'a.txt', anchor: staleAnchor, text: '旧意见' });
  reconcileSection('a.txt', 'working', [], diffFingerprint('@@ -1,1 +1,1 @@\n+changed everywhere\n'));
  const blocked = addComment({
    path: 'a.txt',
    anchor: { ...staleAnchor, codeHash: lineHash('+replacement') },
    text: '新意见',
  });
  check('a stale comment still blocks a new comment on the same line', () =>
    staleCreated.ok === true &&
    commentForLine(staleAnchor)?.stale === true &&
    blocked.ok === false && blocked.comment?.stale === true);
  check('position identity ignores the code hash but keeps path/section/line', () => {
    const other = { ...anchor, codeHash: 'deadbeef' };
    return commentAtPosition(other)?.text === '请改成幂等实现' &&
      lineKey(anchor) !== lineKey(other) &&
      lineKey(anchor) !== lineKey({ ...anchor, section: 'staged' });
  });
  check('line identity includes the project-relative path', () =>
    lineKey({ ...anchor, path: 'a.txt' }) !== lineKey({ ...anchor, path: 'b.txt' }));
  check('comments in different files do not collide', () =>
    commentForLine({ ...anchor, path: 'b.txt' }) === null);

  const edited = updateComment(added.comment.id, '改成幂等实现，并补充测试');
  check('comments can be edited in place', () =>
    edited.ok === true && commentForLine(anchor).text === '改成幂等实现，并补充测试');

  const sameLines = [{ type: 'add', oldLine: null, newLine: 2, codeHash: anchor.codeHash, hunkIndex: 0, hunkHeader: 'aaaaaaaa' }];
  reconcileSection('a.txt', 'working', sameLines, anchor.diffFingerprint);
  check('unchanged diffs keep the comment live after refresh', () =>
    commentForLine(anchor)?.stale === false);

  /* A context row can drop out of view purely because the caller asked for
   * less surrounding context. That proves nothing about the line itself, so
   * the comment must survive as "待重新确认", never as "当前位置有效". */
  const ctxFp = diffFingerprint('@@ -1,4 +1,4 @@\n ctx\n-old\n+new\n tail\n');
  const ctxAnchor = {
    path: 'ctx.txt',
    section: 'working',
    type: 'context',
    oldLine: 3,
    newLine: 3,
    hunkIndex: 0,
    hunkHeader: 'bbbbbbbb',
    codeHash: lineHash(' tail'),
    diffFingerprint: ctxFp,
    snippet: 'tail',
  };
  const ctxCreated = addComment({ path: 'ctx.txt', anchor: ctxAnchor, text: '上下文行意见' });
  const ctxLine = {
    type: 'context', oldLine: 3, newLine: 3, codeHash: ctxAnchor.codeHash,
    hunkIndex: 0, hunkHeader: ctxAnchor.hunkHeader,
  };
  reconcileSection('ctx.txt', 'working', [ctxLine], ctxFp);
  check('a visible context row is verified', () =>
    ctxCreated.ok === true && commentForLine(ctxAnchor)?.verified === true &&
    commentForLine(ctxAnchor)?.stale === false);

  reconcileSection('ctx.txt', 'working', [], ctxFp);
  const hidden = commentForLine(ctxAnchor);
  check('a hidden context row keeps the comment but marks it unverified', () =>
    hidden?.stale === false && hidden?.verified === false &&
    hidden?.resolvedLine === null && commentCount() > 0);
  check('an unverified comment never reports the position as valid', () => {
    const text = formatReviewFeedback([hidden]);
    return text.includes('尚未重新确认') && !text.includes('当前位置有效');
  });

  reconcileSection('ctx.txt', 'working', [ctxLine], ctxFp);
  check('a reappearing context row becomes verified again', () =>
    commentForLine(ctxAnchor)?.verified === true && commentForLine(ctxAnchor)?.stale === false);

  reconcileSection('ctx.txt', 'working', [], ctxFp);
  check('beginReviewRefresh marks every anchor unverified before the next render', () => {
    beginReviewRefresh();
    return commentForLine(ctxAnchor)?.verified === false && commentForLine(ctxAnchor)?.stale === false;
  });

  const ctxChanged = diffFingerprint('@@ -1,4 +1,4 @@\n ctx\n-old\n+other\n tail\n');
  reconcileSection('ctx.txt', 'working', [], ctxChanged);
  check('a context row missing from a changed diff goes stale instead of unverified', () =>
    commentForLine(ctxAnchor)?.stale === true && commentForLine(ctxAnchor)?.verified === true);
  check('an unverified comment still blocks the same line', () =>
    addComment({ path: 'ctx.txt', anchor: ctxAnchor, text: '第二条' }).ok === false);

  reconcileSectionOptions('a.txt', 'working', [], '', { complete: false });
  check('a truncated diff leaves both validity and staleness unproven', () =>
    commentForLine(anchor)?.stale === false);

  const changedFingerprint = diffFingerprint('@@ -1,4 +1,4 @@\n ctx\n-old\n+other\n tail\n');
  reconcileSection('a.txt', 'working', [{ ...sameLines[0], newLine: 9 }], changedFingerprint);
  check('a changed diff marks an unrecoverable anchor stale instead of rebinding it', () =>
    commentForLine(anchor)?.stale === true && !commentForLine({ ...anchor, newLine: 9 }));

  const beforeStaleCount = commentCount();
  markMissingPathsStale(['other.txt']);
  check('comments for files removed from status become stale without being deleted', () =>
    commentCount() === beforeStaleCount && commentsForPath('a.txt')[0].stale === true);

  setGitConversationScope('conv-b');
  check('a focused conversation gets its own empty comment scope', () =>
    commentCount() === 0 && commentsForScope().length === 0 && currentReviewScope().includes('conversation:conv-b'));
  check('workspace B comments cannot be addressed through workspace A scope', () =>
    commentForLine({ ...anchor, path: 'a.txt' }, scopeA) !== null &&
    commentForLine({ ...anchor, path: 'a.txt' }) === null);
  setGitConversationScope(null);

  /* A read path must not evict another scope's comments. Use a fresh module
   * instance so this budget test does not depend on earlier buckets. */
  const cap = await import('../public/diff-comments.js?scope-cap=1');
  const filled = [];
  for (let i = 0; i < 20; i++) {
    setGitConversationScope(`cap-${i}`);
    filled.push(cap.addComment({
      path: 'cap.txt',
      anchor: { ...anchor, newLine: 1, codeHash: lineHash('+cap-' + i) },
      text: `cap ${i}`,
    }).ok);
  }
  setGitConversationScope('cap-0');
  check('scope reads do not evict an existing comment bucket',
    () => filled.every(Boolean) && cap.commentCount() === 1);
  setGitConversationScope('cap-overflow');
  const overflow = cap.addComment({ path: 'cap.txt', anchor: { ...anchor, newLine: 2, codeHash: 'deadbeef' }, text: 'overflow' });
  check('a full scope table refuses a new scope instead of dropping comments',
    () => overflow.ok === false && overflow.error.includes('20'));
  setGitConversationScope('cap-0');
  check('the oldest comment survives the refused overflow', () =>
    cap.commentCount() === 1 && cap.commentsForScope()[0].text === 'cap 0');
  setGitConversationScope(null);
  S.state = { sessionId: 'classic-a' };

  console.log('\n--- 边界与反馈 ---');
  const addedComments = [];
  for (let i = 0; i < REVIEW_LIMITS.comments; i++) {
    const a = { ...anchor, newLine: 1000 + i, codeHash: lineHash('+' + i) };
    const result = addComment({ path: `bulk-${i}.txt`, anchor: a, text: 'x' });
    if (result.ok) addedComments.push(result.comment.id);
  }
  check('comment count is bounded per scope', () =>
    commentCount() <= REVIEW_LIMITS.comments &&
    addComment({ path: 'overflow.txt', anchor: { ...anchor, newLine: 99999, codeHash: 'ffffffff' }, text: 'overflow' }).ok === false);
  check('per-comment text length is bounded', () =>
    updateComment(addedComments[0], 'x'.repeat(REVIEW_LIMITS.textChars + 1)).ok === false);

  deleteComment(addedComments[0]);
  check('deleted comments disappear from the scope', () => commentCount() === REVIEW_LIMITS.comments - 1);

  const feedback = formatReviewFeedback([
    { path: 'src/a.js', anchor: { section: 'working', type: 'add', newLine: 4, snippet: '+return x`' }, text: '补测试' },
    { path: 'src/a.js', anchor: { section: 'staged', type: 'del', oldLine: 2, snippet: '-old' }, text: '说明为什么删除', stale: true },
  ]);
  check('feedback includes path, section, line, snippet and stale state', () =>
    feedback.includes('src/a.js') && feedback.includes('工作区') && feedback.includes('暂存区') &&
    feedback.includes('原位置已变化') && feedback.includes('补测试'));
  check('feedback is deterministic for the same comments', () =>
    feedback === formatReviewFeedback([
      { path: 'src/a.js', anchor: { section: 'staged', type: 'del', oldLine: 2, snippet: '-old' }, text: '说明为什么删除', stale: true },
      { path: 'src/a.js', anchor: { section: 'working', type: 'add', newLine: 4, snippet: '+return x`' }, text: '补测试' },
    ]));
  check('feedback truncates at the configured bound', () => {
    const text = formatReviewFeedback(Array.from({ length: 50 }, (_, i) => ({
      path: 'long/' + i + '.js', anchor: { section: 'working', type: 'add', newLine: i + 1 }, text: 'y'.repeat(500),
    })), { maxChars: 1000 });
    return text.length <= 1100 && text.includes('反馈已截断');
  });
  check('feedback never embeds absolute workspace paths', () =>
    !feedback.includes('C:\\') && !feedback.includes('/workspace-a'));
  check('feedback ignores unrelated scopes', () => {
    setGitConversationScope('conv-c');
    const other = formatReviewFeedback(commentsForScope());
    setGitConversationScope(null);
    return other === '' && formatReviewFeedback(commentsForScope(scopeA)).includes('a.txt');
  });

  dom.window.close();
  console.log(`\nDiff comments: ${checks}/${checks}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
