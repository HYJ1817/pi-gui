/* Pi 1.4.0 SessionManager/agent-loop shapes; artificial TEMP data only. */
let assertions = 0;
const assert = new Proxy(require('node:assert/strict'), { get(target, key) {
  const value = target[key]; return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value;
} });
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const { readSessionMessages } = await import('../server/session-history.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z53-history-'));
  const file = path.join(root, 'session.jsonl');
  const metrics = {};
  let checks = 0;
  const check = (name, fn) => { fn(); checks++; console.log('  ok  ' + name); };
  const entry = (id, parentId, message) => ({ type: 'message', id, parentId, timestamp: '2026-10-27T00:00:00Z', message });
  const call = (id = 'c', name = 'read', node = 'a', parent = null, args = {}) => entry(node, parent,
    { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] });
  const result = (id = 'c', isError = false, node = 'r', parent = 'a', name = 'read') => entry(node, parent,
    { role: 'toolResult', toolCallId: id, toolName: name, isError, content: [{ type: 'text', text: 'PRIVATE_OUTPUT' }], details: { path: 'C:/PRIVATE_PATH' } });
  const user = entry('u', null, { role: 'user', content: [{ type: 'text', text: 'question' }] });
  const answer = entry('answer', 'u', { role: 'assistant', content: [{ type: 'text', text: 'answer' }] });
  const write = (entries, target = file, sessionId = 'fixture-session') => {
    fs.writeFileSync(target, [JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: root }),
      ...entries.map(e => typeof e === 'string' ? e : JSON.stringify(e)), ''].join('\n'));
  };
  const read = (entries, options) => { write(entries); return readSessionMessages(file, options); };
  const summary = (entries, options) => read(entries, options).toolSummary;
  const expected = (toolName, status) => ({ toolName, status, source: status === 'unknown' ? 'unconfirmed' : 'confirmed' });
  try {
    check('body-only history remains identical and explains no tool calls', () => {
      const value = read([user, answer]);
      assert.deepEqual(value.messages.map(m => [m.role, m.text, m.messageId, m.userIndex]),
        [['user', 'question', 'u', 0], ['assistant', 'answer', 'answer', 0]]);
      assert.equal(value.truncated, false);
      assert.deepEqual(value.toolSummary, { items: [], returned: 0, limit: 100, truncated: false,
        historyTruncated: false, unavailableReason: 'no_tool_calls', uncertain: false });
    });
    check('native successful result proves only recorded completion', () => {
      assert.deepEqual(summary([call(), result()]).items, [expected('read', 'completed')]);
    });
    check('native error result does not guess failure/cancel/interruption cause', () => {
      assert.deepEqual(summary([call(), result('c', true)]).items, [expected('read', 'error')]);
    });
    check('missing result remains unknown, never failed/interrupted', () => {
      const s = summary([call()]); assert.deepEqual(s.items, [expected('read', 'unknown')]); assert.equal(s.uncertain, true);
    });
    check('missing or nonboolean isError cannot prove status', () => {
      for (const value of [undefined, null, 'false', 0]) {
        const r = result(); r.message.isError = value;
        assert.deepEqual(summary([call(), r]).items, [expected('read', 'unknown')]);
      }
    });
    check('malformed result content cannot masquerade as a native completed record', () => {
      for (const content of [undefined, null, 'PRIVATE_OUTPUT', {}]) {
        const r = result(); r.message.content = content;
        const s = summary([call(), r]); assert.equal(s.items[0].status, 'unknown'); assert.equal(s.uncertain, true);
      }
    });
    check('out-of-order and duplicate result records stay unknown', () => {
      for (const entries of [[result(), call()], [call(), result(), result('c', true, 'r2', 'r')]]) {
        assert.deepEqual(summary(entries).items, [expected('read', 'unknown')]);
      }
    });
    check('duplicate calls never borrow another occurrence result', () => {
      const s = summary([call(), call('c', 'read', 'a2', 'a'), result('c', false, 'r', 'a2')]);
      assert.deepEqual(s.items, [expected('read', 'unknown'), expected('read', 'unknown')]);
    });
    check('different call IDs do not pair', () => {
      assert.deepEqual(summary([call(), result('other')]).items, [expected('read', 'unknown')]);
    });
    check('same ID in separate sessions has no shared state', () => {
      const other = path.join(root, 'other.jsonl');
      write([call(), result('c', true)], other, 'other-session');
      assert.equal(summary([call(), result()]).items[0].status, 'completed');
      assert.equal(readSessionMessages(other).toolSummary.items[0].status, 'error');
      assert.equal(summary([call()]).items[0].status, 'unknown');
    });
    check('same ID on a different branch cannot establish completion', () => {
      assert.deepEqual(summary([user, call('c', 'read', 'a', 'u'), result('c', false, 'r', 'u')]).items,
        [expected('read', 'unknown')]);
    });
    check('result name mismatch cannot establish completion', () => {
      assert.equal(summary([call(), result('c', false, 'r', 'a', 'write')]).items[0].status, 'unknown');
    });
    check('multiple native calls can finish in result order along the parent chain', () => {
      const a = call(); a.message.content.push({ type: 'toolCall', id: 'c2', name: 'write', arguments: {} });
      assert.deepEqual(summary([a, result('c2', false, 'r1', 'a', 'write'), result('c', true, 'r2', 'r1')]).items,
        [expected('read', 'error'), expected('write', 'completed')]);
    });
    check('missing, cyclic, reused or forward entry identity invalidates pairing', () => {
      for (const entries of [
        [call(), result('c', false, 'r', 'missing')],
        [call(), result('c', false, 'r', 'r')],
        [call(), result(), result('other', false, 'a', null)],
        [call(), result('c', false, 'r', 'later'), { type: 'model_change', id: 'later', parentId: 'a' }],
        [{ ...call(), id: undefined }, result()],
      ]) assert.equal(summary(entries).items[0].status, 'unknown');
    });
    check('cross-turn assistant/user prevents accidental ancestor matching', () => {
      assert.equal(summary([call(), entry('u2', 'a', { role: 'user', content: 'next' }),
        result('c', false, 'r', 'u2')]).items[0].status, 'unknown');
    });
    check('raw credentials, commands, paths, outputs, thinking and approvals are absent', () => {
      const a = call('PRIVATE_ID', 'bash', 'PRIVATE_NODE', null, { command: 'PRIVATE_COMMAND',
        token: 'sk-PRIVATE_KEY', Cookie: 'PRIVATE_COOKIE', path: 'C:/PRIVATE_PATH', env: 'PRIVATE_ENV' });
      a.message.content.push({ type: 'thinking', thinking: 'PRIVATE_THINKING' });
      const r = result('PRIVATE_ID', false, 'r', 'PRIVATE_NODE', 'bash');
      const s = summary([a, r, { type: 'custom', id: 'approval', parentId: 'r', data: { approval: 'PRIVATE_APPROVAL' } }]);
      assert.equal(JSON.stringify(s).includes('PRIVATE'), false);
      assert.deepEqual(s.items, [expected('bash', 'completed')]);
      assert.deepEqual(Object.keys(s.items[0]).sort(), ['source', 'status', 'toolName']);
    });
    check('malicious, huge and unknown legal tool names use a fixed safe label', () => {
      for (const name of ['<img src=x onerror=alert(1)>', 'read<script>', 'x'.repeat(50000), 'read\n',
        '../read', 'C:\\private', 'sk_private_token', 'constructor', '__proto__', null, {}, '']) {
        const s = summary([call('c', name), result('c', false, 'r', 'a', name)]);
        assert.equal(s.items[0].toolName, 'unknown_tool');
        assert.ok(Buffer.byteLength(JSON.stringify(s)) < 400);
      }
    });
    check('all verified builtins preserve exact names', () => {
      for (const name of ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls']) {
        assert.equal(summary([call('c', name)]).items[0].toolName, name);
      }
    });
    check('corrupt and unexpected JSONL has explicit missing-information reason', () => {
      for (const entries of [['{"broken":'], ['null', '42', '[]'],
        [{ type: 'message', id: 'a', parentId: null, message: { role: 'assistant', content: {} } }],
        [{ type: 'message', role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'read' }] }]]) {
        const s = summary(entries); assert.deepEqual(s.items, []); assert.equal(s.unavailableReason, 'invalid_records');
        assert.equal(s.uncertain, true);
      }
    });
    check('orphan result does not fabricate a call', () => {
      const s = summary([result()]); assert.deepEqual(s.items, []); assert.equal(s.unavailableReason, 'unmatched_results');
      assert.equal(s.uncertain, true);
    });
    check('a second session header cannot bridge evidence between sessions', () => {
      const s = summary([call(), { type: 'session', id: 'foreign', cwd: root }, result()]);
      assert.deepEqual(s.items, []); assert.equal(s.unavailableReason, 'invalid_records');
    });
    check('byte-window truncation never searches outside the window for a missing result', () => {
      const entries = [call(), entry('big', 'a', { role: 'user', content: 'X'.repeat(2000) }), result()];
      const value = read(entries, { maxBytes: 450 }); const s = value.toolSummary;
      assert.equal(value.truncated, true); assert.equal(s.historyTruncated, true); assert.equal(s.uncertain, true);
      assert.deepEqual(s.items, []); assert.equal(s.unavailableReason, 'unmatched_results');
    });
    check('a complete pair within a truncated window can still prove its local result', () => {
      const s = summary([entry('big', null, { role: 'user', content: 'X'.repeat(2000) }), call(), result()], { maxBytes: 650 });
      assert.equal(s.historyTruncated, true); assert.equal(s.uncertain, true);
      assert.deepEqual(s.items, [expected('read', 'completed')]);
    });
    check('summary cap reports actual count, truncation and bounded response bytes', () => {
      const calls = Array.from({ length: 150 }, (_, i) => call('c' + i, i < 50 ? 'write' : 'read', 'a' + i));
      const s = summary(calls); assert.equal(s.returned, 100); assert.equal(s.limit, 100); assert.equal(s.truncated, true);
      assert.equal(s.items.length, 100); assert.ok(s.items.every(i => i.toolName === 'read'));
      assert.ok(Buffer.byteLength(JSON.stringify(s)) < 12 * 1024);
      const largest = summary(Array.from({ length: 100 }, (_, i) => call('c' + i, 'unknown_name', 'a' + i)));
      const confirmed = summary(Array.from({ length: 100 }, (_, i) => [call('c' + i, 'unknown_name', 'a' + i),
        result('c' + i, false, 'r' + i, 'a' + i, 'unknown_name')]).flat());
      metrics.maxSummaryBytes = Math.max(Buffer.byteLength(JSON.stringify(largest)), Buffer.byteLength(JSON.stringify(confirmed)));
      assert.ok(metrics.maxSummaryBytes < 12 * 1024);
    });
    check('line cap is independent of the existing text message cap', () => {
      const entries = [call(), ...Array.from({ length: 4100 }, (_, i) => ({ type: 'custom', id: 'meta' + i, parentId: null }))];
      const s = summary(entries); assert.deepEqual(s.items, []); assert.equal(s.truncated, true);
      assert.equal(s.unavailableReason, 'summary_limit'); assert.equal(s.uncertain, true);
    });
    check('text count truncation preserves text order/identity and marks summary context incomplete', () => {
      const value = read([user, answer, call(), result()], { maxMessages: 1 });
      assert.equal(value.messages.length, 1); assert.equal(value.messages[0].messageId, 'answer');
      assert.equal(value.messages[0].userIndex, 0); assert.equal(value.truncated, true);
      assert.equal(value.toolSummary.historyTruncated, true);
    });
    check('large file reads remain bounded and never expand to recover an old call', () => {
      write([call(), entry('huge', 'a', { role: 'user', content: 'X'.repeat(5 * 1024 * 1024) }), result()]);
      const original = fs.readSync; let bytes = 0, value;
      fs.readSync = (...args) => { const n = original(...args); bytes += n; return n; };
      const started = performance.now();
      try { value = readSessionMessages(file); } finally { fs.readSync = original; }
      metrics.largeFileReadMs = Number((performance.now() - started).toFixed(3));
      metrics.largeFileBytes = fs.statSync(file).size; metrics.largeFileReadBytes = bytes;
      assert.equal(bytes, 4 * 1024 * 1024);
      assert.equal(value.truncated, true); assert.deepEqual(value.toolSummary.items, []);
      assert.ok(Buffer.byteLength(JSON.stringify(value)) < 12 * 1024);
    });
    check('unauthorized session/cwd/file proofs reject the complete payload', () => {
      write([call(), result()]); const st = fs.statSync(file);
      const proof = { sessionId: 'fixture-session', cwd: root, sessionIdentity: { dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs } };
      assert.equal(readSessionMessages(file, { expected: proof }).ok, true);
      for (const expectedProof of [{ ...proof, sessionId: 'foreign' }, { ...proof, cwd: path.join(root, 'foreign') },
        { ...proof, sessionIdentity: { ...proof.sessionIdentity, ino: 0 } }]) {
        assert.deepEqual(readSessionMessages(file, { expected: expectedProof }), { ok: false, code: 'history_unavailable' });
      }
    });
    check('repeated dormant reads never change native bytes or start a process', () => {
      write([call(), result()]); const before = fs.readFileSync(file);
      const cp = require('node:child_process'), original = cp.spawn;
      cp.spawn = () => { throw Error('history must not spawn'); };
      try { for (let i = 0; i < 5; i++) assert.equal(readSessionMessages(file).toolSummary.items[0].status, 'completed'); }
      finally { cp.spawn = original; }
      assert.deepEqual(fs.readFileSync(file), before);
    });
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
  if (process.env.Z53_PROJECTION_OUTPUT) fs.writeFileSync(process.env.Z53_PROJECTION_OUTPUT, JSON.stringify({ checks, assertions,
    failed: 0, metrics }, null, 2) + '\n');
  console.log(`History tool summary: ${checks}/${checks} cases; ${assertions}/${assertions} assertions; skipped=0`);
})().catch(e => { console.error(e); process.exitCode = 1; });
