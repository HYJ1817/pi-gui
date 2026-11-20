/* 历史用户消息编辑：Pi 原生 entries → 界面用户消息序号的只读投影。
 *
 * 这些用例只喂纯数据，不 spawn Pi、不写 session 文件。形状按 Pi 1.5.2 的
 * get_entries / buildContextEntries 复刻；任何形状不符都必须返回 null，由
 * 事务 fail-closed，而不是按序号猜。
 */
'use strict';
const assert = require('node:assert/strict');

(async () => {
  const {
    activePath,
    contextEntries,
    userTargets,
    resolveUserTarget,
    commandNameOf,
    commandConflict,
  } = await import('../server/session-edit-target.js');
  let checks = 0;
  const pass = (name, fn) => {
    try { fn(); checks++; console.log('PASS ' + name); }
    catch (error) { console.error('FAIL ' + name + ': ' + error.message); throw error; }
  };
  const text = value => [{ type: 'text', text: value }];
  const message = (id, parentId, role, content, timestamp = 1) => ({ type: 'message', id, parentId, message: { role, content }, timestamp });
  const user = (id, parentId, value, extra = []) => message(id, parentId, 'user', [...text(value), ...extra]);
  const assistant = (id, parentId, value) => message(id, parentId, 'assistant', text(value));

  const u1 = user('u1', null, 'first');
  const a1 = assistant('a1', 'u1', 'reply first');
  const u2 = user('u2', 'a1', 'second');
  const a2 = assistant('a2', 'u2', 'reply second');
  const entries = [u1, a1, u2, a2];

  pass('active path walks leaf to root in order', () => {
    assert.deepEqual(activePath(entries, 'a2').map(entry => entry.id), ['u1', 'a1', 'u2', 'a2']);
  });
  pass('unknown leaf fails closed', () => assert.equal(activePath(entries, 'missing'), null));
  pass('duplicate entry id fails closed', () => assert.equal(activePath([...entries, u1], 'a2'), null));
  pass('null leaf is an empty active path', () => assert.deepEqual(activePath(entries, null), []));
  pass('parent cycle fails closed', () => {
    const a = user('x', 'y', 'x');
    const b = user('y', 'x', 'y');
    assert.equal(activePath([a, b], 'x'), null);
  });

  pass('two visible user messages map to stable entry ids', () => {
    const targets = userTargets(entries, 'a2');
    assert.equal(targets.length, 2);
    assert.deepEqual(targets.map(target => [target.userIndex, target.entryId, target.parentId, target.text]), [
      [0, 'u1', null, 'first'],
      [1, 'u2', 'a1', 'second'],
    ]);
  });
  pass('tool calls after a user message set the warning flag only for that turn', () => {
    const withTool = assistant('a1', 'u1', 'reply first');
    withTool.message.content.push({ type: 'toolCall', id: 'call-1', name: 'write', arguments: {} });
    const targets = userTargets([u1, withTool, u2, a2], 'a2');
    assert.equal(targets[0].hasToolsAfter, true);
    assert.equal(targets[1].hasToolsAfter, false);
  });
  pass('tool results after a user message also count as tool activity', () => {
    const result = { type: 'message', id: 'tr', parentId: 'a1', message: { role: 'toolResult', toolCallId: 'x', content: [] } };
    const later = user('u2', 'tr', 'second');
    const targets = userTargets([u1, a1, result, later, a2], 'a2');
    assert.equal(targets[0].hasToolsAfter, true);
    assert.equal(targets[1].hasToolsAfter, false);
  });

  pass('images are extracted as reusable image parts', () => {
    const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' };
    const targets = userTargets([user('u1', null, 'with image', [image]), a1], 'a1');
    assert.deepEqual(targets[0].images, [image]);
    assert.equal(targets[0].hasUnsupportedParts, false);
  });
  pass('malformed image fails the whole projection closed', () => {
    const broken = { type: 'image', data: '', mimeType: 'image/png' };
    assert.equal(userTargets([user('u1', null, 'broken image', [broken]), a1], 'a1'), null);
  });
  pass('non text/image parts are reported, not silently dropped', () => {
    const file = { type: 'file', path: '/tmp/secret.txt' };
    const targets = userTargets([user('u1', null, 'with file', [file]), a1], 'a1');
    assert.equal(targets[0].hasUnsupportedParts, true);
    assert.equal(resolveUserTarget([user('u1', null, 'with file', [file]), a1], 'a1', 0).code, 'attachments_unsupported');
  });

  pass('compaction keeps its summary and firstKept range', () => {
    const kept = user('u2', 'a1', 'kept');
    const tail = assistant('a2', 'u2', 'tail');
    const compact = { type: 'compaction', id: 'c1', parentId: 'a2', summary: 'summary', firstKeptEntryId: 'u2' };
    const projected = contextEntries([u1, a1, kept, tail, compact], 'c1');
    assert.deepEqual(projected.map(entry => entry.id), ['c1', 'u2', 'a2']);
  });
  pass('system messages before firstKept stay out', () => {
    const sys = message('sys', 'a1', 'system', text('system'));
    const kept = user('u2', 'sys', 'kept');
    const compact = { type: 'compaction', id: 'c1', parentId: 'u2', summary: 'summary', firstKeptEntryId: 'u2' };
    assert.deepEqual(contextEntries([u1, a1, sys, kept, compact], 'c1').map(entry => entry.id), ['c1', 'u2']);
  });

  pass('context_edit replacement changes the visible text', () => {
    const edit = { type: 'context_edit', id: 'e1', parentId: 'a2', targetId: 'u2', replacement: { content: text('edited') } };
    const targets = userTargets([u1, a1, u2, a2, edit], 'e1');
    assert.equal(targets[1].entryId, 'u2');
    assert.equal(targets[1].text, 'edited');
  });
  pass('context_edit null hides the message and shifts the index', () => {
    const edit = { type: 'context_edit', id: 'e1', parentId: 'a2', targetId: 'u1', replacement: null };
    const targets = userTargets([u1, a1, u2, a2, edit], 'e1');
    assert.deepEqual(targets.map(target => [target.userIndex, target.entryId]), [[0, 'u2']]);
  });
  pass('malformed context_edit fails closed', () => {
    const edit = { type: 'context_edit', id: 'e1', parentId: 'a2', targetId: 'u2', replacement: {} };
    assert.equal(userTargets([u1, a1, u2, a2, edit], 'e1'), null);
  });

  pass('resolveUserTarget returns the revision inputs', () => {
    const resolved = resolveUserTarget(entries, 'a2', 1);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.target.entryId, 'u2');
    assert.equal(resolved.leafId, 'a2');
    assert.equal(resolved.entryCount, 4);
  });
  pass('resolveUserTarget rejects an out-of-range index', () => {
    assert.equal(resolveUserTarget(entries, 'a2', 9).code, 'unknown_user_message');
    assert.equal(resolveUserTarget(entries, 'a2', -1).code, 'invalid_user_index');
  });

  pass('command name parsing covers slash and spaces', () => {
    assert.equal(commandNameOf('/help'), 'help');
    assert.equal(commandNameOf('/help me'), 'help');
    assert.equal(commandNameOf('  /help'), null);
    assert.equal(commandNameOf('plain text'), null);
  });
  pass('registered command at the start of the text is a conflict', () => {
    const commands = [{ name: 'help' }, { name: 'skill:review' }];
    assert.equal(commandConflict('/help me', commands), 'help');
    assert.equal(commandConflict('/skill:review now', commands), 'skill:review');
    assert.equal(commandConflict('/unknown thing', commands), null);
    assert.equal(commandConflict('please /help', commands), null);
  });

  console.log(`Message edit target: ${checks}/${checks}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
