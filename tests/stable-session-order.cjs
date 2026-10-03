/* Creation order regression. All session/flag writes are isolated in os.tmpdir().
 * Pi shape verified locally: SessionHeader.timestamp, nested message, and
 * newSession filename = timestamp.replace(/[:.]/g, '-') + '_' + id + '.jsonl'. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (err) { fail++; console.log('  FAIL ' + name + ' → ' + err.message); }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-stable-order-'));
(async () => {
  const { createSessions } = await import('../server/sessions.js');
  const { createSessionSearch } = await import('../server/session-search.js');
  const agent = path.join(tmp, 'agent');
  const cwd = path.join(tmp, 'project');
  const dir = path.join(agent, 'sessions', '--' + cwd.replace(/[\\/:]/g, '-') + '--');
  fs.mkdirSync(dir, { recursive: true });
  const times = { A: '2026-10-01T01:00:00.000Z', B: '2026-10-01T02:00:00.000Z', C: '2026-10-01T03:00:00.000Z', D: '2026-10-01T04:00:00.000Z' };
  const files = {};
  function fileFor(id, ts) { return path.join(dir, ts.replace(/[:.]/g, '-') + '_' + id + '.jsonl'); }
  function write(file, id, header = {}) {
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session', version: 3, id, cwd, ...header }),
      JSON.stringify({ type: 'message', id: 'm0', parentId: null, timestamp: times.A, message: { role: 'user', content: [{ type: 'text', text: 'needle ' + id }] } }),
    ].join('\n') + '\n', 'utf8');
  }
  for (const id of ['A', 'B', 'C']) { files[id] = fileFor(id, times[id]); write(files[id], id, { timestamp: times[id] }); }
  function touch(file, ts) { fs.utimesSync(file, new Date(ts), new Date(ts)); }
  touch(files.A, '2030-01-03T00:00:00Z');
  touch(files.B, '2030-01-02T00:00:00Z');
  touch(files.C, '2030-01-01T00:00:00Z');
  let current = files.A;
  let currentName = '';
  const runtime = { getCurrentCwd: () => cwd };
  const rpc = { request: async () => current ? { sessionFile: current, sessionId: Object.keys(files).find(id => files[id] === current) || 'old-pending', sessionName: currentName, messageCount: 0 } : null };
  const make = () => createSessions({ runtime, rpc, env: { HOME: tmp, PI_CODING_AGENT_DIR: agent }, dataDir: path.join(tmp, 'data') });
  let sessions = make();
  const order = r => r.sessions.map(s => s.sessionId);
  let result = await sessions.list();
  check('creation descending despite inverse mtimes', () => assert.deepEqual(order(result), ['C', 'B', 'A']));
  check('old current is highlighted in its original position', () => assert.deepEqual(result.sessions.filter(s => s.current).map(s => s.sessionId), ['A']));
  for (const id of ['B', 'C', 'A']) {
    current = files[id]; result = await sessions.list();
    check('switch to ' + id + ' preserves order', () => assert.deepEqual(order(result), ['C', 'B', 'A']));
    check('switch to ' + id + ' changes highlight only', () => assert.equal(result.sessions.find(s => s.current).sessionId, id));
  }
  fs.appendFileSync(files.A, JSON.stringify({ type: 'message', id: 'm1', parentId: 'm0', timestamp: '2031-01-01T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'continued' }] } }) + '\n');
  fs.appendFileSync(files.A, JSON.stringify({ type: 'session_info', id: 'n1', parentId: 'm1', timestamp: '2031-01-02T00:00:00.000Z', name: 'needle renamed A' }) + '\n');
  touch(files.A, '2032-01-01T00:00:00Z');
  result = await sessions.list();
  check('continue and session metadata never reorder', () => assert.deepEqual(order(result), ['C', 'B', 'A']));
  check('rename still updates title', () => assert.equal(result.sessions.find(s => s.sessionId === 'A').title, 'needle renamed A'));
  check('last message remains informational', () => assert.equal(result.sessions.find(s => s.sessionId === 'A').lastMessageAt, '2031-01-01T00:00:00.000Z'));
  check('mtime remains available for display and search', () => assert.equal(result.sessions.find(s => s.sessionId === 'A').updatedAt, Date.parse('2032-01-01T00:00:00Z')));
  current = null; result = await sessions.list();
  check('disconnected list has the same creation order', () => assert.deepEqual(order(result), ['C', 'B', 'A']));
  check('disconnected list has no sticky current', () => assert.equal(result.currentId, null));
  files.D = fileFor('D', times.D); current = files.D;
  result = await sessions.list();
  const pending = result.sessions.find(s => s.pending);
  check('pending new D has its final creation position', () => assert.deepEqual(order(result), ['D', 'C', 'B', 'A']));
  check('pending creation is derived from real Pi filename', () => assert.equal(pending.createdAt, times.D));
  check('pending is current and has no disk actions', () => assert.equal(pending.current && pending.pending && !pending.archived, true));
  currentName = 'new D name'; result = await sessions.list();
  check('pending metadata refresh preserves creation', () => assert.equal(result.sessions.find(s => s.pending).createdAt, times.D));
  result = await make().list();
  check('pending recreation preserves order and identity', () => { assert.deepEqual(order(result), ['D', 'C', 'B', 'A']); assert.equal(result.sessions[0].id, pending.id); });
  write(files.D, 'D', { timestamp: times.D }); touch(files.D, '2020-01-01T00:00:00Z');
  result = await sessions.list();
  check('persist D keeps exact pending order', () => assert.deepEqual(order(result), ['D', 'C', 'B', 'A']));
  check('pending to disk keeps id and createdAt', () => { assert.equal(result.sessions[0].id, pending.id); assert.equal(result.sessions[0].createdAt, pending.createdAt); });
  check('persisted D loses pending without duplication', () => { assert.equal(result.sessions[0].pending, false); assert.equal(result.sessions.filter(s => s.sessionId === 'D').length, 1); });
  sessions = make(); result = await sessions.list();
  check('GUI factory restart preserves persisted order', () => assert.deepEqual(order(result), ['D', 'C', 'B', 'A']));
  current = files.A;
  const b = result.sessions.find(s => s.sessionId === 'B');
  const archived = await sessions.setArchived(b.id, true);
  result = await sessions.list();
  check('archive succeeds with existing flag mechanism', () => assert.equal(archived.ok, true));
  check('active order after archive is D C A', () => assert.deepEqual(result.sessions.filter(s => !s.archived).map(s => s.sessionId), ['D', 'C', 'A']));
  check('archived B preserves creation and list position', () => { assert.equal(result.sessions.find(s => s.archived).createdAt, times.B); assert.deepEqual(order(result), ['D', 'C', 'B', 'A']); });
  await sessions.setArchived(b.id, false); result = await make().list();
  check('unarchive restores B to creation position', () => assert.deepEqual(result.sessions.filter(s => !s.archived).map(s => s.sessionId), ['D', 'C', 'B', 'A']));
  const search = createSessionSearch({ runtime, sessions });
  const searched = await search.search('needle');
  check('search retains its own result ordering', () => assert.equal(searched.results[0].sessionId, 'A'));
  check('API does not leak file paths', () => assert.equal(JSON.stringify(result).includes(tmp), false));
  const oldPending = fileFor('old-pending', '2026-09-01T00:00:00.000Z');
  current = oldPending; result = await sessions.list();
  check('old pending current is not pinned to top', () => assert.deepEqual(order(result), ['D', 'C', 'B', 'A', 'old-pending']));
  current = path.join(dir, 'explicit-pending.jsonl'); result = await sessions.list();
  check('explicit path pending has unknown creation instead of wall clock', () => { assert.equal(result.sessions.at(-1).pending, true); assert.equal(result.sessions.at(-1).createdAt, null); assert.equal(result.sessions.at(-1).updatedAt, null); });
  const unknownOrder = order(result);
  result = await make().list();
  check('unknown pending uses stable fallback across restart', () => assert.deepEqual(order(result), unknownOrder));

  // Separate fixture phase: ties, header priority, and legacy timestamp fallback.
  current = null;
  for (const file of Object.values(files)) fs.unlinkSync(file);
  const tie = '2026-10-02T00:00:00.000Z';
  const za = fileFor('tie-z', tie), aa = fileFor('tie-a', tie);
  write(za, 'tie-z', { timestamp: tie }); write(aa, 'tie-a', { timestamp: tie });
  touch(za, '2035-01-01T00:00:00Z'); touch(aa, '2020-01-01T00:00:00Z');
  result = await sessions.list();
  check('creation ties use deterministic lexical identity', () => assert.deepEqual(order(result), ['tie-a', 'tie-z']));
  touch(aa, '2040-01-01T00:00:00Z'); result = await make().list();
  check('tie order survives mtime inversion and restart', () => assert.deepEqual(order(result), ['tie-a', 'tie-z']));
  fs.unlinkSync(za); fs.unlinkSync(aa);
  const filenameTime = '2026-10-03T00:00:00.000Z';
  write(fileFor('filename', filenameTime), 'filename');
  write(fileFor('header', filenameTime), 'header', { timestamp: '2026-10-04T00:00:00.000Z', createdAt: 'invalid' });
  write(fileFor('explicit', filenameTime), 'explicit', { timestamp: '2026-10-04T00:00:00.000Z', createdAt: '2026-10-05T00:00:00.000Z' });
  const legacyZ = path.join(dir, 'legacy-z.jsonl'), legacyA = path.join(dir, 'legacy-a.jsonl');
  write(legacyZ, 'legacy-z', { timestamp: 'invalid' }); write(legacyA, 'legacy-a');
  touch(legacyZ, '2040-01-01T00:00:00Z'); touch(legacyA, '2020-01-01T00:00:00Z');
  write(path.join(dir, '2026-02-30T00-00-00-000Z_bad-date.jsonl'), 'bad-date');
  result = await make().list();
  check('header createdAt then timestamp then filename determine creation', () => assert.deepEqual(order(result), ['explicit', 'header', 'filename', 'bad-date', 'legacy-a', 'legacy-z']));
  check('header createdAt is preferred when valid', () => assert.equal(result.sessions[0].createdAt, '2026-10-05T00:00:00.000Z'));
  check('invalid createdAt falls back to real header timestamp', () => assert.equal(result.sessions[1].createdAt, '2026-10-04T00:00:00.000Z'));
  check('missing header timestamp uses filename creation', () => assert.equal(result.sessions[2].createdAt, filenameTime));
  check('impossible filename dates stay unknown', () => assert.equal(result.sessions.find(s => s.sessionId === 'bad-date').createdAt, null));
  check('legacy unknown creation stays unknown without mtime', () => assert.equal(result.sessions.find(s => s.sessionId === 'legacy-z').createdAt, null));
  touch(legacyA, '2050-01-01T00:00:00Z'); result = await make().list();
  check('legacy lexical fallback survives changed mtime and restart', () => assert.deepEqual(order(result).slice(-3), ['bad-date', 'legacy-a', 'legacy-z']));
})().catch(err => { console.error(err); fail++; }).finally(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
});
