/* P5-C projects only native entries covered by a revalidated execution record. */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const message = (id, parentId, role, content, rest = {}) =>
  ({ type: 'message', id, parentId, message: { role, content, ...rest } });
const text = text => ({ type: 'text', text });
const input = message('u1', null, 'user', [text('Review this task')]);
const first = message('a1', 'u1', 'assistant', [
  text('Reading first'),
  { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'src/example.js', secret: 'RAW_ARGS_SENTINEL' } },
], { stopReason: 'toolUse', usage: { output: 12, reasoning: 0 }, provider: 'fixtures', model: 'one' });
const result = message('r1', 'a1', 'toolResult', [text('RAW_RESULT_SENTINEL')], {
  toolCallId: 'call-1', toolName: 'read', isError: false,
});
const answer = message('a2', 'r1', 'assistant', [text('Final response')], {
  stopReason: 'stop', usage: { totalTokens: 30 }, provider: 'fixtures', model: 'two',
});
const entries = [input, first, result, answer];
const identity = { kind: 'runtime', projectId: 'p', workspaceId: 'w', conversationId: 'c', sessionId: 'native' };
const checkpoint = {
  inputId: 'u1', beforeLeafId: null, leafId: 'a2',
  entries: entries.map(entry => ({ id: entry.id, role: entry.message.role })),
  timing: { startedAt: 10, endedAt: 40 }, status: 'completed', finalResponseId: 'a2',
  tools: [{ callId: 'call-1', responseId: 'a1', resultId: 'r1', startedAt: 15, endedAt: 30,
    durationMs: 15, status: 'completed' }],
};

test('returns one bounded native history turn with safe metadata, exact block and message membership', async () => {
  const { projectExecutionHistory } = await import('../server/execution-timeline-history.js');
  const history = projectExecutionHistory(entries, [checkpoint], { sessionId: 'native', leafId: 'a2' });
  const { p5, timeline } = history.execution;
  assert.equal(p5.version, 1);
  assert.equal(p5.sessionId, 'native');
  assert.equal(p5.turns.length, 1);
  const turn = p5.turns[0];
  assert.equal(turn.input.id, 'u1');
  assert.equal(turn.finalResponseId, 'a2');
  assert.deepEqual(turn.entryIds, ['u1', 'a1', 'r1', 'a2']);
  assert.deepEqual(turn.blockIds, timeline.map(block => block.id));
  assert.deepEqual(turn.usage.map(row => row.model.id), ['one', 'two']);
  assert.equal(turn.usage[0].recorded.reasoning, 0);
  assert.equal(turn.items.length, 1);
  assert.equal(turn.items[0].callId, 'call-1');
  assert.equal(turn.items[0].timing.durationMs, 15);
  assert.doesNotMatch(JSON.stringify(history), /RAW_ARGS_SENTINEL|RAW_RESULT_SENTINEL/);
});

test('replays parallel activities in witnessed start order, independent of declaration and result order', async () => {
  const { projectExecutionHistory } = await import('../server/execution-timeline-history.js');
  const parallel = { ...first, message: { ...first.message, content: [...first.message.content,
    { type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'src/second.js' } },
  ] } };
  const secondResult = message('r2', 'r1', 'toolResult', [text('second')], {
    toolCallId: 'call-2', toolName: 'read', isError: false,
  });
  const rows = [input, parallel, result, secondResult, { ...answer, parentId: 'r2' }];
  const recorded = { ...checkpoint, entries: rows.map(row => ({ id: row.id, role: row.message.role })),
    tools: [{ ...checkpoint.tools[0], callId: 'call-2', resultId: 'r2', startedAt: 12 }, ...checkpoint.tools] };
  const { items } = projectExecutionHistory(rows, [recorded], { sessionId: 'native', leafId: 'a2' }).execution.p5.turns[0];
  assert.deepEqual(items.map(item => item.callId), ['call-2', 'call-1']);
  assert.ok(items[0].position.part < items[1].position.part);
});

test('rejects stale leaf, changed native role and tool pairing, and bounds the read-only file path', async t => {
  const { projectExecutionHistory, readStoredExecutionHistory } = await import('../server/execution-timeline-history.js');
  assert.equal(projectExecutionHistory(entries, [checkpoint], { sessionId: 'native', leafId: 'other' }), null);
  const unrelated = message('other', 'a1', 'assistant', [text('Final response')], { stopReason: 'stop' });
  assert.equal(projectExecutionHistory([...entries, unrelated], [checkpoint], { sessionId: 'native', leafId: 'other' }), null);
  const wrong = [input, first, { ...result, message: { ...result.message, toolCallId: 'other-call' } }, answer];
  assert.equal(projectExecutionHistory(wrong, [checkpoint], { sessionId: 'native', leafId: 'a2' }), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p5c-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.jsonl');
  const header = { type: 'session', id: 'native', cwd: dir };
  const write = rows => fs.writeFileSync(file, [header, ...rows].map(x => JSON.stringify(x)).join('\n') + '\n');
  write(entries);
  const { dev, ino, birthtimeMs } = fs.statSync(file);
  const target = { sessionId: 'native', cwd: dir, sessionIdentity: { dev, ino, birthtimeMs } };
  assert.ok(readStoredExecutionHistory(file, target, [checkpoint], identity)?.execution.p5);
  assert.equal(readStoredExecutionHistory(file, { ...target, sessionId: 'wrong' }, [checkpoint], identity), null);
  write([...entries, unrelated]);
  assert.equal(readStoredExecutionHistory(file, target, [checkpoint], identity), null);
});

test('Runtime production registry persists a proved turn and fences replay against a newer frame', async t => {
  const { createRuntimeRegistry } = await import('../server/runtime-registry.js');
  const { createExecutionTimelineStore } = await import('../server/execution-timeline-store.js');
  const { readExecutionBranch } = await import('../server/execution-timeline.js');
  const { runtimeExecutionIdentity, readStoredExecutionHistory } = await import('../server/execution-timeline-history.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p5c-registry-'));
  const store = createExecutionTimelineStore({ dataDir: root });
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  const file = path.join(root, 'native.jsonl');
  const header = { type: 'session', id: 'native', cwd };
  const workspace = { projectId: 'p', repoId: 'repo', workspaceId: 'w', workspaceEpoch: 'epoch',
    cwd, root: cwd, branch: 'fixture' };
  let native = [], send, proofs = 0, gate = null;
  function writeNative() {
    fs.writeFileSync(file, [header, ...native].map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  writeNative();
  const registry = createRuntimeRegistry({
    dataDir: root, executionStore: store,
    resolveWorkspace: async () => workspace,
    factory: async (context, emit) => {
      send = evt => emit({ ...evt, bridgeRun: 1 });
      let disposed = false;
      const state = () => ({ sessionId: 'native', isStreaming: false });
      return {
        start: () => send({ type: 'bridge_status', state: 'ready' }),
        getState: () => ({ state: 'ready', stop: null }),
        request: async () => state(), sessionLocator: () => file,
        executionBranch: async (scope, branchEpoch, detailTarget, onVerifiedPath) => {
          if (gate) await gate;
          const branch = await readExecutionBranch({
            scope, branchEpoch, detailTarget, onVerifiedPath, readState: state,
            readEntries: () => ({ entries: native, leafId: native.at(-1)?.id ?? null }),
            isCurrent: context.isCurrent,
          });
          proofs++;
          return branch;
        },
        send: cmd => send({ type: 'execution_submission', command: cmd.type, id: cmd.id }),
        dispose: async () => { disposed = true; }, cleanupConfirmed: () => disposed,
      };
    },
  });
  t.after(async () => {
    await registry.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const until = async predicate => {
    for (let turn = 0; turn < 100; turn++) {
      const value = predicate();
      if (value) return value;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('fixture did not reach its required state');
  };
  await registry.start({});
  const owner = await until(() => {
    const owner = registry.snapshot().items[0]?.owner;
    return owner?.sessionId && proofs > 0 && owner;
  });
  await new Promise(resolve => setImmediate(resolve));
  await registry.command(owner, { type: 'prompt', id: 'p1', message: 'Review this task' });
  assert.equal((await registry.executionHistory(owner)).ok, false, 'a busy runtime never serves a replaceable cut');
  send({ type: 'response', command: 'prompt', id: 'p1', success: true });
  send({ type: 'agent_start', generationRequestId: 'p1' });
  const initialSequence = registry.events(owner).cursor + 1;
  for (const entry of [input, first]) {
    send({ type: 'message_start', message: entry.message });
    send({ type: 'message_end', message: entry.message });
    native = [...native, entry];
  }
  send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read' });
  native = [...native, result];
  send({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', durationMs: 15 });
  send({ type: 'message_start', message: answer.message });
  send({ type: 'message_end', message: answer.message });
  native = [...native, answer];
  writeNative();
  send({ type: 'agent_settled' });

  const identity = runtimeExecutionIdentity(owner);
  const records = await until(() => {
    const value = store.list(identity);
    return value[0]?.status === 'completed' && value;
  });
  assert.equal(records[0].inputId, 'u1');
  assert.equal(records[0].viewAlias, ['live', owner.runtimeId, owner.runtimeGeneration, 0, initialSequence].join(':'));
  const recovered = await registry.executionHistory(owner);
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.owner, owner);
  assert.equal(recovered.cursor, registry.events(owner).cursor);
  assert.deepEqual(recovered.execution.p5.turns[0].entryIds, ['u1', 'a1', 'r1', 'a2']);
  assert.doesNotMatch(JSON.stringify(recovered), /RAW_ARGS_SENTINEL|RAW_RESULT_SENTINEL/);
  const target = registry.historyTarget(owner.conversationId);
  const reopened = createExecutionTimelineStore({ dataDir: root });
  const persisted = readStoredExecutionHistory(file, target, reopened.list(identity));
  assert.deepEqual(persisted?.execution.p5, recovered.execution.p5);
  await assert.rejects(registry.executionHistory({ ...owner, runtimeGeneration: 'old' }), { code: 'stale_runtime' });

  let release;
  gate = new Promise(resolve => { release = resolve; });
  const request = registry.executionHistory(owner);
  await new Promise(resolve => setImmediate(resolve));
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'new frame' } });
  release();
  assert.equal((await request).ok, false);
});

test('view preferences promote only proved live turn and activity aliases in the same scope', async () => {
  const { executionLivePreferenceKey, executionViewPreferences } = await import('../public/execution-view-preferences.js');
  const owner = { runtimeId: 'runtime', runtimeGeneration: 'generation' };
  const scope = { kind: 'runtime', workspaceId: 'workspace', sessionId: 'native', conversationId: 'preference-test' };
  const alias = executionLivePreferenceKey({ ...scope, owner, branchEpoch: 0 }, 13);
  const before = executionViewPreferences(scope, alias);
  before.set('activity', true);
  before.set('activity-item:live-call', true);
  const turn = 'native-turn:input:leaf';
  const recovered = executionViewPreferences(scope, turn, { alias, items: [{ id: 'native-result', viewAlias: 'live-call' }] });
  assert.equal(recovered.get('activity'), true);
  assert.equal(recovered.get('activity-item:native-result'), true);
  assert.equal(recovered.get('activity-item:live-call'), undefined);
  assert.equal(executionViewPreferences({ ...scope, conversationId: 'different' }, turn, { alias }).get('activity'), undefined);
  assert.equal(executionViewPreferences(scope, turn).get('activity'), true, 'the selection lives under the verified native key');
});

test('closed history refuses a temporary native file appended during its bounded read', async t => {
  const { readStoredExecutionHistory } = await import('../server/execution-timeline-history.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p5c-live-tip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'native.jsonl');
  fs.writeFileSync(file, [{ type: 'session', id: 'native', cwd: root }, ...entries]
    .map(row => JSON.stringify(row)).join('\n') + '\n');
  const { ino, dev, birthtimeMs, size } = fs.statSync(file);
  const target = { sessionId: 'native', cwd: root, sessionIdentity: { ino, dev, birthtimeMs } };
  const readSync = fs.readSync;
  let reads = 0;
  let appended = false;
  t.mock.method(fs, 'readSync', (fd, buffer, off, length, position) => {
    const count = readSync(fd, buffer, off, length, position);
    if (length === size && ++reads === 2) {
      fs.appendFileSync(file, JSON.stringify(message('newer', 'u1', 'assistant', [text('new branch')])) + '\n');
      appended = true;
    }
    return count;
  });
  assert.equal(readStoredExecutionHistory(file, target, [checkpoint]), null);
  assert.equal(appended, true);
});

test('compaction and context edits cannot produce editable ordinals from the full branch', async () => {
  const { projectExecutionHistory } = await import('../server/execution-timeline-history.js');
  const before = message('old-user', null, 'user', [text('Review this task')]);
  for (const boundary of [
    { type: 'compaction', id: 'changed-context', parentId: 'old-user', firstKeptEntryId: 'u1' },
    { type: 'context_edit', id: 'changed-context', parentId: 'old-user', targetId: 'old-user', replacement: null },
  ]) {
    const updatedInput = { ...input, parentId: boundary.id };
    const branch = [before, boundary, updatedInput, first, result, answer];
    const record = { ...checkpoint, beforeLeafId: boundary.id };
    const request = { sessionId: 'native', leafId: 'a2' };
    assert.equal(projectExecutionHistory(branch, [record], request).execution.p5.turns[0].input.userIndex, 1);
    assert.equal(projectExecutionHistory(branch, [record], { ...request, editable: true }), null);
  }
});

test('Classic does not attach ambiguous native details when two responses reuse a call ID', async () => {
  const { projectExecutionHistory } = await import('../server/execution-timeline-history.js');
  const nextUser = message('u2', 'a2', 'user', [text('New task')]);
  const nextCall = message('a3', 'u2', 'assistant', [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }]);
  const nextResult = message('r2', 'a3', 'toolResult', [text('different output')], { toolName: 'read', toolCallId: 'call-1', isError: false });
  const native = [...entries, nextUser, nextCall, nextResult];
  const next = { ...checkpoint, inputId: 'u2', beforeLeafId: 'a2', leafId: 'r2', finalResponseId: null,
    entries: [nextUser, nextCall, nextResult].map(row => ({ id: row.id, role: row.message.role })),
    tools: [{ ...checkpoint.tools[0], responseId: 'a3', resultId: 'r2' }] };
  const scope = { sessionId: 'native', leafId: 'r2' };
  assert.equal(projectExecutionHistory(native, [checkpoint, next], { ...scope, classic: true }), null);
  assert.equal(projectExecutionHistory(native, [checkpoint, next], scope).execution.p5.turns.length, 2);
});
