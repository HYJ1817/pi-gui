/* 离线契约：fixtures 对照 pi-memory 0.4.2（jayzeng/pi-memory，gitHead 39e6b998）的
 * 真实 TypeBox schema 与 details 形状（index.ts 的 7 个 registerTool）。
 *
 * 完全离线：不安装 Extension、不装 / 不跑 qmd、不读 ~/.pi/agent/memory、
 * 不修改任何真实记忆、不联网、不调用模型。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let count = 0;
function check(name, fn) { fn(); count++; console.log('  ok  ' + name); }
(async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' });
  global.document = dom.window.document; global.window = dom.window;
  const { memoryActivity, MEMORY_TOOLS } = await import('../public/memory-activity.js');
  const { createMemoryObservation, memorySetup, MEMORY_INSTALL_COMMAND, acceptMemoryEvent } = await import('../public/memory-capabilities.js');
  const { webActivity } = await import('../public/web-activity.js');
  const { subagentActivity } = await import('../public/subagent-activity.js');
  const model = await import('../public/tool-model.js');
  const view = await import('../public/tool-view.js');
  const changes = await import('../public/changes.js');

  const entry = (name, args = {}, id = name) => model.makeEntry({ toolCallId: id, toolName: name, args }, 1);
  const finish = (e, details, isError = false, text = '') =>
    model.applyEnd(e, { result: { content: [{ type: 'text', text }], details }, isError }, 10);
  const facts = (e) => memoryActivity(e).facts;
  const json = (e) => JSON.stringify(memoryActivity(e));
  const RAW = 'RAW_MEMORY_FULLTEXT_' + 'x'.repeat(5000);
  const PRIVATE = 'PRIVATE_VALUE';
  const USER = 'p18user';
  const MEM = `C:\\Users\\${USER}\\.pi\\agent\\memory`;

  /* ---------- 契约钉子：真实工具清单 ---------- */
  check('real tool list pinned to 0.4.2', () => assert.deepEqual([...MEMORY_TOOLS], [
    'memory_write', 'memory_read', 'memory_search', 'memory_forget', 'memory_restore', 'memory_status', 'scratchpad',
  ]));
  for (const name of MEMORY_TOOLS) {
    check(name + ' start recognized', () => { const a = memoryActivity(entry(name)); assert.equal(a.known, true); assert.equal(a.status, 'running'); });
  }
  check('unadapted memory-like tool falls back', () => assert.equal(memoryActivity(entry('memory_export')), null));
  check('unrelated tool falls back', () => assert.equal(memoryActivity(entry('custom_search')), null));

  /* ---------- memory_write ---------- */
  const wrote = finish(entry('memory_write', { target: 'long_term', content: 'pnpm' }), { path: `${MEM}\\MEMORY.md`, target: 'long_term', mode: 'append', sessionId: 'abcd1234', timestamp: '2026-09-30 12:00:00', qmdUpdateMode: 'background' });
  check('write running label', () => assert.equal(memoryActivity(entry('memory_write', { target: 'long_term', content: 'x' })).label, 'Saving memory…'));
  check('write long_term success', () => assert.equal(memoryActivity(wrote).label, 'Saved to memory'));
  check('write target from result', () => assert.match(facts(wrote), /Target: Long-term memory/));
  check('write append mode', () => assert.match(facts(wrote), /Mode: append/));
  check('write content not echoed', () => assert.doesNotMatch(facts(wrote), /pnpm/));
  check('write path excluded', () => assert.ok(!json(wrote).includes(USER)));
  check('write session id and timestamp excluded', () => assert.doesNotMatch(json(wrote), /abcd1234|2026-09-30 12:00:00/));
  check('write overwrite mode', () => assert.match(facts(finish(entry('memory_write', { target: 'long_term', content: 'x' }), { target: 'long_term', mode: 'overwrite' })), /Mode: overwrite/));
  check('write daily target', () => assert.equal(memoryActivity(finish(entry('memory_write', { target: 'daily', content: 'x' }), { target: 'daily', mode: 'append' })).label, 'Added to daily log'));
  check('write requested mode is not a result fact', () => assert.doesNotMatch(facts(finish(entry('memory_write', { target: 'long_term', content: 'x', mode: 'overwrite' }), { target: 'long_term' })), /Mode:/));
  check('write error label', () => assert.equal(memoryActivity(finish(entry('memory_write', { target: 'long_term' }), {}, true)).label, 'Memory write failed'));
  check('write incomplete label', () => { const e = entry('memory_write', { target: 'long_term' }); e.status = 'incomplete'; assert.equal(memoryActivity(e).label, 'Memory write stopped'); });
  check('write missing target does not claim success', () => assert.equal(memoryActivity(finish(entry('memory_write', {}), {})).label, 'Memory write result unavailable'));
  /* §三：args.target 只是请求，不能顶成成功。 */
  check('write args.target is not success evidence', () => {
    const a = memoryActivity(finish(entry('memory_write', { target: 'long_term', content: 'x' }), {}));
    assert.equal(a.label, 'Memory write result unavailable');
    assert.match(a.facts, /Requested target: Long-term memory/);
    assert.doesNotMatch(a.label, /Saved to memory/);
  });

  /* ---------- memory_read：成功必须有 result 证据 ---------- *
   * 0.4.2 的四个成功分支：long_term/scratchpad → { path }，daily → { path, date }，
   * list → { files }；soft-failure（文件不存在 / 没有那天 / 没有日志）是 {}。 */
  const read = (target, details, extra = {}) => memoryActivity(finish(entry('memory_read', { target, ...extra }), details));
  check('read running label', () => assert.equal(memoryActivity(entry('memory_read', { target: 'long_term' })).label, 'Reading memory…'));
  check('read long_term + path', () => assert.equal(read('long_term', { path: `${MEM}\\MEMORY.md` }).label, 'Read long-term memory'));
  check('read long_term + {} is not success', () => assert.equal(read('long_term', {}).label, 'Memory read result unavailable'));
  check('read scratchpad + path', () => assert.equal(read('scratchpad', { path: `${MEM}\\SCRATCHPAD.md` }).label, 'Read scratchpad'));
  check('read scratchpad + {} is not success', () => assert.equal(read('scratchpad', {}).label, 'Memory read result unavailable'));
  check('read daily + path + valid date', () => assert.equal(read('daily', { path: `${MEM}\\daily\\2026-09-29.md`, date: '2026-09-29' }).label, 'Read daily log'));
  check('read daily + path only is not success', () => assert.equal(read('daily', { path: `${MEM}\\daily\\2026-09-29.md` }).label, 'Memory read result unavailable'));
  check('read daily + {} is not success', () => assert.equal(read('daily', {}).label, 'Memory read result unavailable'));
  check('read daily malformed result date is not success', () => assert.equal(read('daily', { path: `${MEM}\\daily\\2026-9-9.md`, date: '2026-9-9' }).label, 'Memory read result unavailable'));
  check('read list + files[]', () => assert.equal(read('list', { files: ['2026-09-30.md', '2026-09-29.md'] }).label, 'Listed daily logs'));
  check('read list + {} is not success', () => assert.equal(read('list', {}).label, 'Memory read result unavailable'));
  check('read requested date is not success evidence', () => {
    const a = read('daily', {}, { date: '2026-09-29' });
    assert.equal(a.label, 'Memory read result unavailable');
    assert.match(a.facts, /Requested date: 2026-09-29/);
    assert.doesNotMatch(a.facts, /^Date:/m);
  });
  check('read soft-failure keeps target as request info', () => assert.match(read('daily', {}).facts, /Target: Daily log/));
  check('read result date comes from details', () => assert.match(read('daily', { path: 'x', date: '2026-09-29' }).facts, /Date: 2026-09-29/));
  check('read path excluded', () => assert.ok(!json(read('long_term', { path: `${MEM}\\MEMORY.md` })).includes(USER)));
  check('read list count only', () => assert.match(read('list', { files: ['a.md', 'b.md'] }).facts, /Daily logs: 2/));
  check('read list filenames excluded', () => assert.doesNotMatch(read('list', { files: ['2026-09-30.md'] }).facts, /\.md/));
  check('read missing list metadata unknown', () => assert.match(read('list', {}).facts, /Daily log count unavailable/));
  check('read success hides content', () => assert.match(read('long_term', { path: 'x' }).facts, /Content not shown in Activity/));
  check('read soft-failure claims no content', () => assert.doesNotMatch(read('long_term', {}).facts, /Content not shown/));
  /* §五：不解析 raw result 文本 —— 文案不是 API，而且是正文/路径泄露面。 */
  check('read raw result text never becomes success', () => {
    const a = memoryActivity(finish(entry('memory_read', { target: 'daily' }), {}, false, 'No daily log for 2026-09-29.'));
    assert.equal(a.label, 'Memory read result unavailable');
  });
  const readHuge = finish(entry('memory_read', { target: 'long_term' }), { path: `${MEM}\\MEMORY.md` }, false, RAW);
  check('read raw result text excluded', () => assert.ok(!json(readHuge).includes('RAW_MEMORY_FULLTEXT')));
  check('read raw result text absent from DOM', () => assert.ok(!view.renderEntry(readHuge).textContent.includes('RAW_MEMORY_FULLTEXT')));
  check('read unknown target degrades', () => assert.equal(memoryActivity(finish(entry('memory_read', { target: 'secrets' }), {})).label, 'Memory read result unavailable'));

  /* ---------- memory_search ---------- */
  check('search running label', () => assert.equal(memoryActivity(entry('memory_search', { query: 'db migration' })).label, 'Searching memory…'));
  check('search success label', () => assert.equal(memoryActivity(finish(entry('memory_search', { query: 'db migration' }), { mode: 'keyword', query: 'db migration', count: 4, needsEmbed: false })).label, 'Searched memory'));
  check('search error label', () => assert.equal(memoryActivity(finish(entry('memory_search', { query: 'x' }), {}, true)).label, 'Memory search failed'));
  check('search stopped label', () => { const e = finish(entry('memory_search', { query: 'x' }), {}); e.status = 'interrupted'; assert.equal(memoryActivity(e).label, 'Memory search stopped'); });
  const searched = finish(entry('memory_search', { query: 'database migration decision', mode: 'semantic' }), { mode: 'keyword', query: 'database migration decision', count: 4, needsEmbed: false });
  check('search query shown', () => assert.match(facts(searched), /Query: database migration decision/));
  check('search count shown', () => assert.match(facts(searched), /Matches: 4/));
  check('search result mode wins over request', () => assert.match(facts(searched), /Mode: keyword/));
  check('search requested mode never invented', () => assert.doesNotMatch(facts(finish(entry('memory_search', { query: 'x', mode: 'semantic' }), { count: 1 })), /Mode:/));
  check('search unknown mode ignored', () => assert.doesNotMatch(facts(finish(entry('memory_search', { query: 'x' }), { mode: 'hybrid-vector', count: 1 })), /Mode:/));
  check('search zero results is a real count', () => { const a = memoryActivity(finish(entry('memory_search', { query: 'x' }), { mode: 'keyword', query: 'x', count: 0, needsEmbed: false })); assert.match(a.facts, /Matches: 0/); assert.equal(a.label, 'Searched memory'); });
  check('search missing count is not zero', () => { const a = memoryActivity(finish(entry('memory_search', { query: 'x' }), {})); assert.doesNotMatch(a.facts, /Matches:/); assert.match(a.facts, /Result metadata unavailable/); assert.equal(a.label, 'Memory search result unavailable'); });
  check('search without count names no mode', () => assert.doesNotMatch(json(finish(entry('memory_search', { query: 'x' }), {})), /keyword|semantic|"deep"/));
  check('search needsEmbed fact', () => assert.match(facts(finish(entry('memory_search', { query: 'x' }), { mode: 'semantic', query: 'x', count: 0, needsEmbed: true })), /Embeddings missing/));
  check('search embedStarted fact', () => assert.match(facts(finish(entry('memory_search', { query: 'x' }), { mode: 'deep', query: 'x', count: 0, needsEmbed: true, embedStarted: true })), /Embedding started/));
  check('search needsEmbed negative not claimed', () => assert.doesNotMatch(facts(finish(entry('memory_search', { query: 'x' }), { mode: 'keyword', query: 'x', count: 2, needsEmbed: false })), /Embeddings missing/));
  check('search limit shown from request', () => assert.match(facts(entry('memory_search', { query: 'x', limit: 3 })), /Limit: 3/));
  check('search query bounded', () => { const a = memoryActivity(entry('memory_search', { query: 'q'.repeat(10000) })); assert.ok(a.facts.length < 1000); assert.ok(a.summary.length <= 380); });
  check('search query single line', () => assert.match(facts(entry('memory_search', { query: 'a\nb\tc' })), /Query: a b c/));
  check('search missing query degrades', () => assert.equal(memoryActivity(entry('memory_search', {})).summary, 'Query unavailable'));
  check('search result query used when args missing', () => assert.match(facts(finish(entry('memory_search', {}), { mode: 'keyword', query: 'from result', count: 1 })), /Query: from result/));
  check('search malformed count ignored', () => assert.doesNotMatch(facts(finish(entry('memory_search', { query: 'x' }), { count: -3 })), /Matches:/));
  check('search huge count ignored', () => assert.doesNotMatch(facts(finish(entry('memory_search', { query: 'x' }), { count: Number.MAX_VALUE })), /Matches:/));

  /* ---------- memory_forget / recovery ---------- */
  check('forget running label', () => assert.equal(memoryActivity(entry('memory_forget', { match: 'old fact' })).label, 'Forgetting memory…'));
  const forgot = finish(entry('memory_forget', { match: 'old fact' }), { path: `${MEM}\\MEMORY.md`, target: 'long_term', removed: 2, recoveryId: '0f0e6b3c-1a2b-4c3d-8e4f-5a6b7c8d9e0f', recoveryPath: `${MEM}\\recovery\\0f0e6b3c-1a2b-4c3d-8e4f-5a6b7c8d9e0f.json`, removedPreview: { preview: PRIVATE, truncated: false, totalLines: 1, totalChars: 13, previewLines: 1, previewChars: 13 } });
  check('forget success label', () => assert.equal(memoryActivity(forgot).label, 'Removed from memory'));
  check('forget removed count', () => assert.match(facts(forgot), /Removed: 2/));
  check('forget recovery available', () => assert.match(facts(forgot), /Recovery available/));
  check('forget recovery id excluded', () => assert.doesNotMatch(json(forgot), /0f0e6b3c/));
  check('forget recovery path excluded', () => assert.ok(!json(forgot).includes(USER) && !json(forgot).includes('.json')));
  check('forget preview excluded', () => assert.ok(!json(forgot).includes(PRIVATE)));
  check('forget no match is not a deletion', () => { const a = memoryActivity(finish(entry('memory_forget', { match: 'x' }), { path: `${MEM}\\MEMORY.md`, removed: 0 })); assert.equal(a.label, 'No matching memory'); assert.match(a.facts, /Removed: 0/); assert.doesNotMatch(a.facts, /Recovery available/); });
  check('forget missing count does not claim deletion', () => { const a = memoryActivity(finish(entry('memory_forget', { match: 'x' }), {})); assert.equal(a.label, 'Memory forget result unavailable'); assert.doesNotMatch(a.facts, /Removed:/); });
  check('forget invalid recovery id not advertised', () => assert.doesNotMatch(facts(finish(entry('memory_forget', { match: 'x' }), { removed: 1, recoveryId: 'not-a-uuid' })), /Recovery available/));
  check('forget error label', () => assert.equal(memoryActivity(finish(entry('memory_forget', { match: '' }), {}, true)).label, 'Memory forget failed'));
  check('forget match bounded', () => assert.ok(facts(entry('memory_forget', { match: 'm'.repeat(10000) })).length < 1000));
  check('forget target default not invented', () => assert.doesNotMatch(facts(entry('memory_forget', { match: 'x' })), /Target:/));

  /* ---------- memory_restore ---------- */
  check('restore running label', () => assert.equal(memoryActivity(entry('memory_restore', { recoveryId: 'x' })).label, 'Restoring memory…'));
  const restored = finish(entry('memory_restore', { recoveryId: '0f0e6b3c-1a2b-4c3d-8e4f-5a6b7c8d9e0f' }), { recoveryId: '0f0e6b3c-1a2b-4c3d-8e4f-5a6b7c8d9e0f', target: 'long_term', path: `${MEM}\\MEMORY.md`, restored: 3 });
  check('restore success label', () => assert.equal(memoryActivity(restored).label, 'Restored memory entries'));
  check('restore count shown', () => assert.match(facts(restored), /Entries: 3/));
  check('restore target shown', () => assert.match(facts(restored), /Target: Long-term memory/));
  check('restore id and path excluded', () => assert.ok(!json(restored).includes('0f0e6b3c') && !json(restored).includes(USER)));
  check('restore already restored', () => { const a = memoryActivity(finish(entry('memory_restore', { recoveryId: 'x' }), { recoveryId: 'x', restoredAt: '2026-09-30T04:00:00.000Z' })); assert.equal(a.label, 'Memory already restored'); assert.match(a.facts, /Already restored/); });
  check('restore zero entries', () => assert.equal(memoryActivity(finish(entry('memory_restore', { recoveryId: 'x' }), { recoveryId: 'x', restored: 0 })).label, 'Memory already present'));
  check('restore missing metadata degrades', () => assert.equal(memoryActivity(finish(entry('memory_restore', { recoveryId: 'x' }), {})).label, 'Memory restore result unavailable'));
  check('restore error label', () => assert.equal(memoryActivity(finish(entry('memory_restore', { recoveryId: 'x' }), {}, true)).label, 'Memory restore failed'));

  /* ---------- memory_status ---------- */
  const status = finish(entry('memory_status', {}), {
    dir: MEM, longTermChars: 1200, scratchpadOpen: 2, scratchpadTotal: 5,
    dailyCount: 12, latestDaily: '2026-09-30', qmd: true, collection: true, embeddings: 'ready',
    snapshotMode: 'stable', qmdUpdateMode: 'background',
  });
  check('status success label', () => assert.equal(memoryActivity(status).label, 'Checked memory status'));
  for (const expected of ['Long-term memory: 1200 chars', 'Scratchpad: 2 open / 5 total', 'Daily logs: 12', 'Latest daily log: 2026-09-30', 'qmd: available', 'Collection pi-memory: present', 'Embeddings: ready', 'Snapshot: stable', 'Update mode: background']) {
    check('status fact ' + expected, () => assert.ok(facts(status).includes(expected)));
  }
  check('status dir excluded', () => assert.ok(!json(status).includes(USER)));
  check('status qmd unavailable', () => { const a = memoryActivity(finish(entry('memory_status', {}), { qmd: false })); assert.match(a.facts, /qmd: unavailable/); assert.match(a.facts, /memory_search requires qmd/); });
  /* v0.4.2 tag（= npm 发布包，同一 commit 39e6b998）的 getSnapshotMode 只返回
   * stable | per-turn；refresh 是仓库 main 上尚未发布的第三种模式。
   * 契约按发布版钉住，不为未发布字段提前适配。 */
  check('status snapshot stable displayed', () => assert.match(facts(finish(entry('memory_status', {}), { snapshotMode: 'stable', longTermChars: 1 })), /Snapshot: stable/));
  check('status snapshot per-turn displayed', () => assert.match(facts(finish(entry('memory_status', {}), { snapshotMode: 'per-turn', longTermChars: 1 })), /Snapshot: per-turn/));
  check('status snapshot refresh stays unknown (not in v0.4.2)', () => assert.doesNotMatch(facts(finish(entry('memory_status', {}), { snapshotMode: 'refresh', longTermChars: 1 })), /Snapshot:/));
  check('status unknown enums stay unknown', () => { const a = memoryActivity(finish(entry('memory_status', {}), { embeddings: 'vector', snapshotMode: 'eager', qmdUpdateMode: 'eager' })); assert.doesNotMatch(a.facts, /Embeddings:|Snapshot:|Update mode:/); });
  check('status missing metadata degrades', () => assert.match(facts(finish(entry('memory_status', {}), {})), /Memory status metadata unavailable/));
  check('status missing metadata is not success', () => assert.equal(memoryActivity(finish(entry('memory_status', {}), {})).label, 'Memory status result unavailable'));
  check('status bad latest daily ignored', () => assert.doesNotMatch(facts(finish(entry('memory_status', {}), { dailyCount: 1, latestDaily: `${MEM}\\2026-09-30.md` })), /Latest daily log/));
  check('status error label', () => assert.equal(memoryActivity(finish(entry('memory_status', {}), {}, true)).label, 'Memory status failed'));

  /* ---------- scratchpad：成功必须有 details 证据 ---------- *
   * 0.4.2：add/done/undo 回写 details.action；clear_done 另带 removed；
   * list 带 count/open；soft-failure（空清单、没有匹配项、缺 text）是 {}。 */
  const sp = (action, details, extra = {}) => memoryActivity(finish(entry('scratchpad', { action, ...extra }), details));
  check('scratchpad running label', () => assert.equal(memoryActivity(entry('scratchpad', { action: 'add', text: 'x' })).label, 'Updating scratchpad…'));
  check('scratchpad list running label', () => assert.equal(memoryActivity(entry('scratchpad', { action: 'list' })).label, 'Reading scratchpad…'));
  for (const [action, label] of [['add', 'Added to scratchpad'], ['done', 'Checked off scratchpad item'], ['undo', 'Reopened scratchpad item']]) {
    check('scratchpad ' + action + ' + details.action', () => assert.equal(sp(action, { action, sessionId: 's', timestamp: 't', qmdUpdateMode: 'background', preview: { preview: 'x' } }).label, label));
    check('scratchpad ' + action + ' + {} is not success', () => assert.equal(sp(action, {}).label, 'Scratchpad result unavailable'));
  }
  check('scratchpad clear_done + action + removed', () => assert.equal(sp('clear_done', { action: 'clear_done', removed: 4, qmdUpdateMode: 'background' }).label, 'Cleared done scratchpad items'));
  check('scratchpad clear_done removed count', () => assert.match(sp('clear_done', { action: 'clear_done', removed: 4 }).facts, /Removed: 4/));
  check('scratchpad clear_done + {} is not success', () => assert.equal(sp('clear_done', {}).label, 'Scratchpad result unavailable'));
  check('scratchpad clear_done without removed is not success', () => assert.equal(sp('clear_done', { action: 'clear_done' }).label, 'Scratchpad result unavailable'));
  check('scratchpad list + count/open', () => { const a = sp('list', { count: 3, open: 1, preview: { preview: 'x' } }); assert.equal(a.label, 'Read scratchpad'); assert.match(a.facts, /Items: 3/); });
  check('scratchpad list + open only', () => assert.equal(sp('list', { open: 0 }).label, 'Read scratchpad'));
  check('scratchpad list + {} is not success', () => assert.equal(sp('list', {}).label, 'Scratchpad result unavailable'));
  check('scratchpad action fact from details', () => assert.match(sp('done', { action: 'done' }).facts, /Action: done/));
  check('scratchpad counts', () => assert.match(sp('list', { count: 3, open: 1 }).facts, /Items: 3/));
  check('scratchpad item text excluded', () => assert.ok(!json(entry('scratchpad', { action: 'add', text: PRIVATE })).includes(PRIVATE)));
  check('scratchpad preview excluded', () => assert.ok(!json(sp('add', { action: 'add', preview: { preview: PRIVATE } })).includes(PRIVATE)));
  check('scratchpad detail action wins over request', () => assert.equal(sp('add', { action: 'done' }).label, 'Checked off scratchpad item'));
  check('scratchpad unknown action still semantic', () => { const a = sp('archive', {}); assert.equal(a.label, 'Scratchpad action'); assert.match(a.facts, /Action: unknown/); });
  check('scratchpad prototype action safe', () => { const a = sp('__proto__', {}); assert.equal(a.label, 'Scratchpad action'); assert.match(a.facts, /Action: unknown/); });
  check('scratchpad bounded hostile action', () => assert.ok(memoryActivity(entry('scratchpad', { action: 'a'.repeat(10000) })).summary.length < 200));
  check('scratchpad empty details list is not zero', () => assert.doesNotMatch(sp('list', {}).facts, /Items: 0/));
  check('scratchpad error label', () => assert.equal(memoryActivity(finish(entry('scratchpad', { action: 'add' }), {}, true)).label, 'Scratchpad action failed'));

  /* ---------- 敏感字段 ---------- */
  const HOSTILE_FIELDS = ['path', 'recoveryPath', 'dir', 'file', 'files', 'env', 'token', 'apiKey', 'credential', 'embedding', 'vector', 'content', 'markdown', 'raw', 'fullText', 'memory', 'sessionId', 'timestamp', 'existingPreview', 'removedPreview', 'preview', 'removedContent'];
  const hostileDetails = Object.fromEntries(HOSTILE_FIELDS.map((k) => [k, PRIVATE]));
  /* 白名单内的字段用真实形状的值，只把 PRIVATE 放在**不该投影**的字段上。 */
  const allowlisted = { target: 'long_term', mode: 'append', count: 1, removed: 1, restored: 1 };
  const safeArgs = { target: 'long_term', query: 'safe query', match: 'safe match', action: 'list', text: 'safe item' };
  for (const name of MEMORY_TOOLS) {
    const hostile = finish(entry(name, safeArgs, name), { ...hostileDetails, ...allowlisted }, false, PRIVATE + RAW);
    check('hostile fields excluded from projection: ' + name, () => assert.ok(!json(hostile).includes(PRIVATE)));
    check('hostile fields excluded from DOM: ' + name, () => { const n = view.renderEntry(hostile); assert.equal(n.querySelector('.tl-args').textContent, ''); assert.ok(!n.textContent.includes(PRIVATE)); assert.ok(!n.outerHTML.includes(PRIVATE)); });
  }
  check('raw tool result never rendered', () => assert.ok(!view.renderEntry(finish(entry('memory_read', { target: 'long_term' }), {}, false, RAW)).textContent.includes('RAW_MEMORY_FULLTEXT')));
  check('malformed details string degrades', () => assert.equal(memoryActivity(finish(entry('memory_write', { target: 'long_term' }), 'bad')).known, true));
  check('malformed details array degrades', () => assert.equal(memoryActivity(finish(entry('memory_write', { target: 'long_term' }), [1, 2])).known, true));
  check('null details degrades', () => assert.equal(memoryActivity(finish(entry('memory_status', {}), null)).known, true));
  check('malformed args degrade', () => { const e = entry('memory_search', {}); e.args = 'bad'; assert.equal(memoryActivity(e).known, true); });
  check('hostile HTML inert in target', () => assert.equal(view.renderEntry(finish(entry('memory_write', { target: 'long_term' }), { target: '<img onerror="evil()">' })).querySelector('img'), null));
  check('hostile HTML inert in query', () => assert.equal(view.renderEntry(entry('memory_search', { query: '<script>bad()</script>' })).querySelector('script'), null));
  check('facts bounded for hostile fields', () => { const a = memoryActivity(finish(entry('memory_search', { query: 'q'.repeat(50000) }), { mode: 'keyword', query: 'q'.repeat(50000), count: 3, needsEmbed: true })); assert.ok(a.facts.length <= 8000); });
  check('no drive path in any projection', () => { for (const name of MEMORY_TOOLS) assert.doesNotMatch(json(finish(entry(name, safeArgs, name), { ...hostileDetails, ...allowlisted })), /[A-Za-z]:\\\\/); });

  /* ---------- 生命周期 ---------- */
  for (const settled of ['incomplete', 'interrupted', 'cancelled']) {
    check('settled status ' + settled, () => { const e = entry('memory_search', { query: 'x' }); e.status = settled; const a = memoryActivity(e); assert.equal(a.label, 'Memory search stopped'); assert.doesNotMatch(a.label, /…$/); });
  }
  check('unknown status degrades to generic label', () => { const e = entry('memory_search', { query: 'x' }); e.status = 'weird'; assert.equal(memoryActivity(e).label, 'Memory operation'); });
  check('missing status degrades', () => { const e = entry('memory_search', { query: 'x' }); delete e.status; assert.equal(memoryActivity(e).label, 'Memory operation'); });
  const live = model.registerEntry(entry('memory_write', { target: 'long_term' }, 'p18-stop'));
  check('tracked entry starts running', () => assert.equal(memoryActivity(live).status, 'running'));
  model.settleRunning();
  check('Stop settles spinner', () => assert.equal(memoryActivity(live).label, 'Memory write stopped'));
  model.clearLiveEntries();

  /* ---------- runtime observation ---------- */
  const o = createMemoryObservation();
  check('unobserved initially', () => assert.deepEqual(Object.values(o.snapshot(0, 1)), MEMORY_TOOLS.map(() => false)));
  o.observe({ type: 'tool_execution_start', toolName: 'memory_search', bridgeRun: 1 }, 0, 1);
  check('search observed', () => assert.equal(o.snapshot(0, 1).memory_search, true));
  check('other tools not implied', () => assert.equal(o.snapshot(0, 1).memory_write, false));
  o.observe({ type: 'tool_execution_end', toolName: 'memory_write', bridgeRun: 1 }, 0, 1);
  check('independent tool observation', () => assert.equal(o.snapshot(0, 1).memory_write, true));
  check('workspace generation resets', () => assert.equal(o.snapshot(1, 1).memory_search, false));
  o.observe({ type: 'tool_execution_start', toolName: 'memory_search', bridgeRun: 1 }, 1, 1);
  check('stale bridge run rejected', () => assert.equal(o.snapshot(1, 2).memory_search, false));
  o.observe({ type: 'tool_execution_start', toolName: 'memory_search', bridgeRun: 2 }, 1, 2);
  check('current run observed', () => assert.equal(o.snapshot(1, 2).memory_search, true));
  o.observe({ type: 'bridge_status', state: 'restarting', bridgeRun: 2 }, 1, 2);
  check('restart clears observation', () => assert.equal(o.snapshot(1, 2).memory_search, false));
  o.observe({ type: 'tool_execution_start', toolName: 'scratchpad', bridgeRun: 2 }, 1, 2);
  check('scratchpad observed', () => assert.equal(o.snapshot(1, 2).scratchpad, true));
  o.observe({ type: 'bridge_status', state: 'no-project', bridgeRun: 2 }, 1, 2);
  check('no-project clears observation', () => assert.equal(o.snapshot(1, 2).scratchpad, false));
  o.observe({ type: 'tool_execution_start', toolName: 'web_search', bridgeRun: 2 }, 1, 2);
  check('other extensions cannot pollute', () => assert.deepEqual(Object.values(o.snapshot(1, 2)), MEMORY_TOOLS.map(() => false)));
  check('switching rejects tool events', () => assert.equal(acceptMemoryEvent({ type: 'tool_execution_end', bridgeRun: 2 }, { switching: true, bridgeRun: 2 }), false));
  check('mismatched run rejected', () => assert.equal(acceptMemoryEvent({ type: 'tool_execution_update', bridgeRun: 1 }, { switching: false, bridgeRun: 2 }), false));
  check('current event accepted', () => assert.equal(acceptMemoryEvent({ type: 'tool_execution_start', bridgeRun: 2 }, { switching: false, bridgeRun: 2 }), true));
  check('non-tool events always pass', () => assert.equal(acceptMemoryEvent({ type: 'bridge_status' }, { switching: true, bridgeRun: 1 }), true));

  /* ---------- 安装状态 ---------- */
  check('install command fixed', () => assert.equal(MEMORY_INSTALL_COMMAND, 'pi install npm:pi-memory'));
  check('absent setup', () => assert.equal(memorySetup({ extensions: [] }).installed, false));
  const installed = { extensions: [{ name: 'pi-memory', state: { installed: true, enabled: true, loaded: null } }] };
  check('discovery is not runtime evidence', () => { assert.equal(memorySetup(installed).installed, true); assert.equal(createMemoryObservation().snapshot(0, 1).memory_search, false); });
  check('configured from enabled evidence', () => assert.equal(memorySetup(installed).configured, true));
  check('disabled extension', () => assert.equal(memorySetup({ extensions: [{ name: 'pi-memory', state: { installed: true, enabled: false } }] }).configured, false));
  check('presence cannot infer configuration', () => assert.equal(memorySetup({ extensions: [{ name: 'pi-memory', state: { installed: true, enabled: null } }] }).configured, null));
  check('loaded unknown stays unknown', () => assert.equal(memorySetup(installed).loaded, null));
  check('registry failure stays unknown', () => assert.equal(memorySetup({ ok: false }).installed, null));
  check('no automatic install', () => assert.equal(memorySetup(installed).automaticInstall, false));

  /* ---------- 接线与回归 ---------- */
  const pub = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
  const activitySource = pub('memory-activity.js');
  check('no filesystem or network in adapter', () => assert.doesNotMatch(activitySource, /\bfetch\(|require\(|node:fs|readdirSync|readFileSync|execFile|spawn/));
  check('no project scope invented', () => assert.doesNotMatch(activitySource, /project memory|Project Memory|projectScope|projectRoot/));
  check('no Planner coupling', () => assert.doesNotMatch(activitySource, /planner|planId|taskId|execution_event/));
  check('no app state mutation', () => assert.doesNotMatch(activitySource, /\bS\.|ownsWorkspace/));
  check('capabilities contain no install or execution', () => assert.doesNotMatch(pub('memory-capabilities.js'), /\bexecFile\(|\bspawn\(|fetch\(|node:fs|child_process/));
  check('setup wiring uses real restart API', () => assert.match(pub('memory.js'), /await restartBackend\(\)/));
  check('restart failure retry available', () => assert.match(pub('memory.js'), /finally \{ restart.disabled = false/));
  check('extensions page renders memory setup', () => assert.match(pub('extensions.js'), /renderMemorySetup\(/));
  check('app observes memory events', () => assert.match(pub('app.js'), /observeMemoryEvent\(evt\)/));
  check('timeline dispatches memory adapter', () => assert.match(pub('tool-view.js'), /memoryActivity\(entry\)/));
  check('memory tools are not mutating file tools', () => { for (const name of MEMORY_TOOLS) assert.equal(model.MUTATING_TOOLS.has(name), false); });
  check('memory write does not enter the Changes ledger', () => assert.deepEqual(changes.recordToolChange('memory_write', { target: 'long_term', content: 'x' }), []));
  const serverSources = ['extension-registry.js', 'pi-compat.js', 'sessions.js'].map((f) => fs.readFileSync(path.join(__dirname, '../server', f), 'utf8')).join('\n');
  check('Extension Registry not polluted by memory logic', () => assert.doesNotMatch(serverSources, /memory_search|memory_write|pi-memory/));
  const searchSources = pub('session-search.js') + fs.readFileSync(path.join(__dirname, '../server/session-search.js'), 'utf8');
  check('session search stays independent', () => assert.doesNotMatch(searchSources, /memory_search|memory_write|memory_read|scratchpad|MEMORY_TOOLS/));
  const plannerSources = fs.readdirSync(path.join(__dirname, '../public')).filter((n) => n.startsWith('planner') && n.endsWith('.js'))
    .map((f) => pub(f)).join('\n');
  check('Planner has no memory feature', () => assert.doesNotMatch(plannerSources, /memory_search|memory_write|scratchpad|MEMORY_TOOLS/));
  check('web adapter unaffected', () => { assert.equal(webActivity(entry('web_search', { query: 'a' })).known, true); assert.equal(memoryActivity(entry('web_search', { query: 'a' })), null); });
  check('subagent adapter unaffected', () => { assert.equal(subagentActivity(entry('subagent', { agent: 'a' })).known, true); assert.equal(memoryActivity(entry('subagent', { agent: 'a' })), null); });
  check('generic fallback intact', () => assert.match(view.renderEntry(entry('memory_export')).textContent, /执行工具 memory_export/));

  /* ---------- 渲染 / 历史 ---------- */
  const liveSearch = entry('memory_search', { query: 'db migration' }, 'p18-a');
  const node = view.renderEntry(liveSearch);
  document.body.appendChild(node);
  check('DOM start renderer', () => assert.match(node.textContent, /Searching memory…/));
  model.applyUpdate(liveSearch, { partialResult: { content: [{ type: 'text', text: RAW }] } });
  view.updateEntry(node, liveSearch);
  check('DOM update keeps node', () => assert.equal(document.body.querySelectorAll('[data-id="p18-a"]').length, 1));
  check('DOM streaming raw output excluded', () => assert.ok(!node.textContent.includes('RAW_MEMORY_FULLTEXT')));
  finish(liveSearch, { mode: 'keyword', query: 'db migration', count: 4, needsEmbed: false }, false, RAW);
  view.updateEntry(node, liveSearch);
  check('DOM end same node', () => assert.equal(document.body.querySelectorAll('.tl-item').length, 1));
  check('DOM success label', () => assert.ok(node.textContent.includes('Searched memory') && node.textContent.includes('Matches: 4')));
  check('DOM excludes raw result', () => assert.ok(!node.textContent.includes('RAW_MEMORY_FULLTEXT')));
  check('DOM excludes raw args and details', () => assert.equal(node.querySelector('.tl-args').textContent, ''));
  const second = entry('memory_status', {}, 'p18-b');
  const node2 = view.renderEntry(second);
  document.body.appendChild(node2);
  finish(second, { dir: MEM, qmd: false });
  view.updateEntry(node2, second);
  check('independent tool ids', () => assert.notEqual(node.dataset.id, node2.dataset.id));
  check('inverse completion distinct', () => assert.ok(node2.textContent.includes('qmd: unavailable') && !node.textContent.includes('qmd: unavailable')));
  check('no duplicate DOM', () => assert.equal(document.querySelectorAll('.tl-item').length, 2));
  const forgetDetails = { path: `${MEM}\\MEMORY.md`, target: 'long_term', removed: 1, recoveryId: '0f0e6b3c-1a2b-4c3d-8e4f-5a6b7c8d9e0f' };
  const historical = model.entryFromHistory({ id: 'h', name: 'memory_forget', arguments: { match: 'old fact' } }, { details: forgetDetails, content: [{ type: 'text', text: RAW }] }, {});
  const liveForget = finish(entry('memory_forget', { match: 'old fact' }, 'h'), forgetDetails);
  check('history uses same projection', () => assert.equal(facts(historical), facts(liveForget)));
  check('history raw content excluded', () => assert.ok(!json(historical).includes('RAW_MEMORY_FULLTEXT') && !json(historical).includes(USER)));
  check('history missing details degrades', () => assert.equal(memoryActivity(model.entryFromHistory({ id: 'h2', name: 'memory_write' }, { details: {}, content: [] }, {})).label, 'Memory write result unavailable'));
  check('history without result is incomplete', () => assert.equal(memoryActivity(model.entryFromHistory({ id: 'h3', name: 'memory_search', arguments: { query: 'x' } }, null, {})).label, 'Memory search stopped'));
  check('history no fabricated duration', () => assert.equal(view.renderEntry(model.entryFromHistory({ id: 'h4', name: 'memory_search', arguments: { query: 'x' } }, null, {})).querySelector('.tl-time').textContent, ''));

  /* ---------- 历史 soft-failure：实时与 history 必须同一条规则 ---------- */
  const historyRead = model.entryFromHistory(
    { id: 'h-read', name: 'memory_read', arguments: { target: 'daily', date: '2026-09-29' } },
    { details: {}, content: [{ type: 'text', text: `No daily log for 2026-09-29. C:\\Users\\${USER}\\.pi\\agent\\memory` }] },
    {},
  );
  check('history read soft-failure degrades', () => assert.equal(memoryActivity(historyRead).label, 'Memory read result unavailable'));
  check('history read soft-failure raw text excluded', () => assert.ok(!json(historyRead).includes('No daily log') && !json(historyRead).includes(USER)));
  check('history read soft-failure raw text absent DOM', () => assert.ok(!view.renderEntry(historyRead).textContent.includes('No daily log')));

  const historyScratchpad = model.entryFromHistory(
    { id: 'h-sp', name: 'scratchpad', arguments: { action: 'done', text: 'fix later' } },
    { details: {}, content: [{ type: 'text', text: 'No matching open item found for: "fix later"' }] },
    {},
  );
  check('history scratchpad soft-failure degrades', () => assert.equal(memoryActivity(historyScratchpad).label, 'Scratchpad result unavailable'));
  check('history scratchpad soft-failure raw text excluded', () => assert.ok(!json(historyScratchpad).includes('No matching open item')));
  check('history scratchpad soft-failure raw text absent DOM', () => assert.ok(!view.renderEntry(historyScratchpad).textContent.includes('No matching open item')));

  /* §十四：soft-failure 的 raw result 里塞恶意内容，仍然只是中性结果。 */
  const HOSTILE_RAW = `C:\\Users\\${USER}\\MEMORY.md SECRET <img onerror="evil()"><script>bad()</script>`;
  for (const [name, args] of [['memory_read', { target: 'daily' }], ['scratchpad', { action: 'done' }]]) {
    const soft = finish(entry(name, args, 'sf-' + name), {}, false, HOSTILE_RAW);
    check('soft-failure hostile raw inert: ' + name, () => {
      const n = view.renderEntry(soft);
      assert.ok(!n.textContent.includes('SECRET'));
      assert.ok(!n.outerHTML.includes(USER));
      assert.equal(n.querySelector('img'), null);
      assert.equal(n.querySelector('script'), null);
      assert.equal(n.querySelector('.tl-args').textContent, '');
    });
  }
  check('soft-failure is not forced into error', () => {
    for (const [name, args] of [['memory_read', { target: 'daily' }], ['scratchpad', { action: 'done' }], ['memory_write', { target: 'long_term' }], ['memory_status', {}]]) {
      const a = memoryActivity(finish(entry(name, args, 'nf-' + name), {}));
      assert.equal(a.status, 'success');
      assert.match(a.label, /result unavailable/);
    }
  });

  dom.window.close();
  console.log(`\n${count}/${count} 通过`);
})().catch(e => { console.error(e); process.exitCode = 1; });
