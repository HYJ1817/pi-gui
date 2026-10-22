/* T3-C: real renderer parser + pure range/schema/model contracts. */
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('  ok ' + name); };
(async () => {
  const dom = new JSDOM('<body></body>', { url: 'http://fixture.invalid/' });
  Object.assign(global, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent });
  const { diffHtml, diffFingerprint } = await import('../public/diff.js');
  const model = await import('../public/diff-comments.js');
  const schema = await import('../public/review-comment-data.js');
  const mixed = '@@ -10,3 +20,4 @@ example\n before\n-old\n+new\n+extra\n after\n';
  function parse(text, commentable = true) {
    const doc = new JSDOM(diffHtml(text, { commentable })).window.document;
    return [...doc.querySelectorAll('.d-row')].map(r => ({ path: 'src/a.js', section: 'working', type: r.dataset.lineType,
      oldLine: r.dataset.oldLine ? Number(r.dataset.oldLine) : null, newLine: r.dataset.newLine ? Number(r.dataset.newLine) : null,
      codeHash: r.dataset.codeHash, hunkIndex: Number(r.dataset.hunkIndex), hunkHeader: r.dataset.hunkHeader,
      diffFingerprint: diffFingerprint(text), rangeComplete: r.closest('.d-hunkwrap').dataset.rangeComplete === '1' }));
  }
  const rows = parse(mixed);
  check('complete mixed hunk explicitly permits ranges', () => assert.ok(rows.length === 5 && rows.every(r => r.rangeComplete)));
  const ranges = await import('../public/review-comment-range.js');
  const anchor = ranges.selectReviewRange(rows, 0, 4);
  check('mixed range carries every old/new coordinate without invented numbers', () => {
    assert.deepEqual(anchor.range.lines.map(r => [r.type, r.oldLine, r.newLine]), [ ['context',10,20], ['del',11,null], ['add',null,21], ['add',null,22], ['context',12,23] ]);
  });
  check('reverse selection produces the same anchor', () => assert.deepEqual(ranges.selectReviewRange(rows,4,0), anchor));
  check('range feedback describes both accurate file sides', () => assert.equal(model.lineLabel({ anchor }), '旧文件第 10～12 行；新文件第 20～23 行（含增删，5 个 Diff 行）'));
  const add = parse('@@ -0,0 +1,3 @@\n+one\n+\n+three\n');
  const del = parse('@@ -1,3 +0,0 @@\n-one\n-\n-three\n');
  check('pure addition and deletion have one-sided range labels', () => {
    assert.equal(model.lineLabel({anchor:ranges.selectReviewRange(add,0,2)}), '新文件第 1～3 行');
    assert.equal(model.lineLabel({anchor:ranges.selectReviewRange(del,0,2)}), '旧文件第 1～3 行');
  });
  check('CRLF and no-newline markers preserve only real code rows', () => {
    assert.equal(parse(mixed.replace(/\n/g,'\r\n')).length, 5);
    const a = parse('@@ -1,2 +1,2 @@\n-a\n\\ No newline at end of file\n+b\n c\n');
    assert.equal(ranges.selectReviewRange(a,0,2).range.lines.length,3);
  });
  for (const [name, text] of [ ['incomplete','@@ -1,4 +1,4 @@\n a\n+b\n'], ['overflow','@@ -0,0 +1 @@\n+a\n+b\n'], ['invalid','@@ invalid\n+a\n+b\n'], ['zero','@@ -0,2 +0,2 @@\n a\n b\n'] ]) {
    check(name + ' hunk cannot create a range', () => { const r=parse(text); assert.equal(ranges.selectReviewRange(r,0,r.length-1),null); });
  }
  check('truncated/binary rendering yields no selectable rows', () => { assert.equal(parse(mixed,false).length,0); assert.equal(parse('Binary files a/a and b/a differ').length,0); });
  check('range rejects hunk, section, file and coordinate discontinuities', () => {
    for (const patch of [{hunkIndex:1},{section:'staged'},{path:'other.js'},{newLine:28}]) {
      const r=structuredClone(rows); Object.assign(r[2],patch); assert.equal(ranges.selectReviewRange(r,0,4),null);
    }
  });
  check('20 row cap and distinct endpoints are enforced', () => {
    const r=parse('@@ -0,0 +1,21 @@\n'+Array.from({length:21},(_,i)=>'+'+i).join('\n'));
    assert.equal(ranges.selectReviewRange(r,0,19).range.lines.length,20);
    assert.equal(ranges.selectReviewRange(r,0,20),null); assert.equal(ranges.selectReviewRange(r,0,0),null);
  });
  check('rename metadata does not become selectable code', () => assert.deepEqual(parse('diff --git a/old b/new\nrename from old\nrename to new\n'+mixed),rows));
  const record = (a, id='range') => ({ id, path:a.path, text:'range feedback', createdAt:1, updatedAt:1, anchor:a });
  const clean = schema.reviewCommentWire(record(anchor));
  check('range wire roundtrips with a closed versioned hash-only schema', () => assert.deepEqual(schema.sanitizeReviewComments([clean]),[clean]));
  check('old single-line wire still validates unchanged', () => {
    const a={...clean.anchor}; delete a.range; assert.deepEqual(schema.sanitizeReviewComments([record(a)]),[record(a)]);
  });
  check('malicious and oversized range evidence fails closed', () => {
    for (const mutate of [ a=>a.range.version=2, a=>a.range.lines[1].source='secret', a=>a.range.lines[1].newLine=999,
      a=>a.range.lines[0].codeHash='bad', a=>a.newLine=99, a=>a.range.lines.push(...a.range.lines,...a.range.lines,...a.range.lines) ]) {
      const c=structuredClone(clean); mutate(c.anchor); assert.throws(()=>schema.sanitizeReviewComments([c]));
    }
  });
  const inner=ranges.selectReviewRange(rows,1,3);
  check('overlapping ranges are rejected but a single line may coexist', () => {
    assert.throws(()=>schema.sanitizeReviewComments([clean,schema.reviewCommentWire(record(inner,'other'))]));
    const a={...clean.anchor}; delete a.range; assert.equal(schema.sanitizeReviewComments([clean,record(a,'single')]).length,2);
  });
  const scope='range-test';
  model.replaceReviewComments([clean],scope);
  const comment=()=>model.commentsForScope(scope)[0];
  check('restored ranges need fresh evidence', () => assert.equal(comment().verified,false));
  check('whole ordered evidence confirms the range', () => { model.reconcileSection('src/a.js','working',rows,anchor.diffFingerprint,scope); assert.equal(comment().stale,false); assert.equal(comment().verified,true); });
  check('changing an interior line invalidates unchanged endpoints', () => {
    const changed=structuredClone(rows); changed[2].codeHash='aaaaaaaa';
    model.reconcileSection('src/a.js','working',changed,'11111111',scope); assert.equal(comment().stale,true);
  });
  check('similar content at different coordinates never attracts the range', () => {
    const moved=rows.map(r=>({...r,oldLine:r.oldLine===null?null:r.oldLine+50,newLine:r.newLine===null?null:r.newLine+50}));
    model.reconcileSection('src/a.js','working',moved,anchor.diffFingerprint,scope); assert.equal(comment().stale,true);
  });
  check('missing only context with unchanged fingerprint remains pending', () => {
    model.reconcileSection('src/a.js','working',rows.slice(1,4),anchor.diffFingerprint,scope); assert.equal(comment().stale,false); assert.equal(comment().verified,false);
  });
  check('same-position changed context is stale, not hidden', () => {
    const changed=structuredClone(rows); changed[0].codeHash='bbbbbbbb';
    model.reconcileSection('src/a.js','working',changed,anchor.diffFingerprint,scope); assert.equal(comment().stale,true);
  });
  check('ambiguous duplicated evidence is stale', () => { model.reconcileSection('src/a.js','working',[...rows,...rows],anchor.diffFingerprint,scope); assert.equal(comment().stale,true); });
  check('partial Diff cannot claim confirmation', () => { model.beginReviewRefresh(scope); model.reconcileSectionOptions('src/a.js','working',rows,anchor.diffFingerprint,{scope,complete:false}); assert.equal(comment().verified,false); });
  check('hidden context uses the last fully confirmed fingerprint after unrelated changes',()=>{
    model.reconcileSection('src/a.js','working',rows,'22222222',scope);assert.equal(comment().stale,false);
    model.reconcileSection('src/a.js','working',rows.slice(1,4),'22222222',scope);assert.equal(comment().verified,false);assert.equal(comment().stale,false);
  });
  check('missing changed rows never masquerade as hidden context',()=>{
    model.reconcileSection('src/a.js','working',rows.filter((_,i)=>i!==2),'22222222',scope);assert.equal(comment().stale,true);
  });
  check('feedback keeps stale range text and both sides', () => { const text=model.formatReviewFeedback(model.commentsForScope(scope)); assert.ok(text.includes('range feedback')&&text.includes('旧文件第 10～12 行')&&text.includes('新文件第 20～23 行')); });
  console.log(`Diff comment ranges: ${checks}/${checks}; failed=0; skipped=0`);
})().catch(e=>{ console.error(e); process.exitCode=1; });
