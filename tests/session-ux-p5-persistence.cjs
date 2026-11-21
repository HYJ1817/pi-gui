const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const scope = { kind: 'classic', bridgeInstance: 'bridge-1', bridgeRun: 1,
  workspaceKey: 'workspace-1', workspaceGeneration: 1, sessionId: 'session-1' };
const identity = { kind: 'classic', workspaceId: scope.workspaceKey, sessionId: scope.sessionId };
const makeEntry = (id, parentId, role, fields = {}) => ({ id, parentId, type: 'message', message: { role, ...fields } });
const rootEntry = { id: 'root-1', parentId: null, type: 'session_info' };
const input = makeEntry('entry-user', rootEntry.id, 'user', { content: [{ type: 'text', text: 'PRIVATE PROMPT' }] });
const planning = makeEntry('entry-plan', input.id, 'assistant', { stopReason: 'toolUse',
  content: [{ type: 'toolCall', id: 'call-read', name: 'read', arguments: { path: '/private' } }] });
const result = makeEntry('entry-tool', planning.id, 'toolResult', { toolName: 'read', toolCallId: 'call-read',
  content: [{ type: 'text', text: 'PRIVATE OUTPUT' }] });
const answer = makeEntry('entry-answer', result.id, 'assistant', { stopReason: 'stop',
  content: [{ type: 'text', text: 'PRIVATE ANSWER' }, { type: 'thinking', thinking: 'PRIVATE THINKING' }] });
const entries = [rootEntry, input, planning, result, answer];

const record = { inputId: input.id, beforeLeafId: rootEntry.id, leafId: answer.id,
  entries: entries.slice(1).map(entry => ({ id: entry.id, role: entry.message.role })),
  status: 'completed', timing: { startedAt: 100, endedAt: 200 }, finalResponseId: answer.id,
  tools: [{ callId: 'call-read', responseId: planning.id, resultId: result.id, startedAt: 130,
    endedAt: 160, durationMs: 30, status: 'completed' }] };

function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p5c-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('creates a bounded closed index, restores exact scope after restart, and proves branch ancestry', async t => {
  const { createExecutionTimelineStore, matchExecutionTimelineRecords } = await import('../server/execution-timeline-store.js');
  const dataDir = temp(t);
  const store = createExecutionTimelineStore({ dataDir });
  assert.deepEqual(store.list(identity), []);
  assert.equal(store.record(identity, { ...record, args: 'PRIVATE ARGUMENTS', tools: [{ ...record.tools[0], output: 'PRIVATE OUTPUT' }] }), true);
  const file = path.join(dataDir, fs.readdirSync(dataDir)[0]);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /PRIVATE|\/private|thinking|args|output/);
  const reopened = createExecutionTimelineStore({ dataDir });
  assert.deepEqual(reopened.list(identity), [record]);
  assert.deepEqual(reopened.list({ ...identity, workspaceId: 'other-workspace' }), []);
  assert.deepEqual(reopened.list({ ...identity, sessionId: 'other-session' }), []);
  assert.deepEqual(reopened.list({ ...identity, kind: 'runtime', projectId: 'project-1', conversationId: 'conversation-1' }), []);
  assert.deepEqual(matchExecutionTimelineRecords(reopened.list(identity), entries, answer.id), [record]);
  const other = makeEntry('entry-other', result.id, 'assistant');
  assert.deepEqual(matchExecutionTimelineRecords(reopened.list(identity), [...entries, other], other.id), []);
  const wrongResult = { ...result, message: { ...result.message, toolCallId: 'another-call' } };
  assert.deepEqual(matchExecutionTimelineRecords(reopened.list(identity), [rootEntry, input, planning, wrongResult, answer], answer.id), []);
});

test('an interrupted replacement leaves the previous index intact and foreign versions stay read only', async t => {
  const { createExecutionTimelineStore } = await import('../server/execution-timeline-store.js');
  const dataDir = temp(t);
  const store = createExecutionTimelineStore({ dataDir });
  const partial = { ...record, leafId: result.id, entries: record.entries.slice(0, -1),
    status: 'unknown', timing: { startedAt: 100, endedAt: null }, finalResponseId: null };
  assert.equal(store.record(identity, partial), true);
  const fault = createExecutionTimelineStore({ dataDir, io: { ...fs, renameSync() { throw Error('interrupted'); } } });
  assert.equal(fault.record(identity, record), false);
  assert.deepEqual(store.list(identity), [partial]);
  assert.equal(fs.readdirSync(dataDir).length, 1);
  assert.equal(store.record(identity, record), true);
  assert.deepEqual(store.list(identity), [record]);
  store.record(identity, partial);
  assert.deepEqual(store.list(identity), [record]);
  const index = path.join(dataDir, fs.readdirSync(dataDir)[0]);
  fs.writeFileSync(index, '{"version":2}');
  assert.deepEqual(store.list(identity), []);
  assert.equal(store.record(identity, record), false);
  assert.equal(fs.readFileSync(index, 'utf8'), '{"version":2}');
  fs.writeFileSync(index, '{');
  assert.deepEqual(store.list(identity), []);
});

test('count bounds keep recent turns without widening scope', async t => {
  const { createExecutionTimelineStore } = await import('../server/execution-timeline-store.js');
  const store = createExecutionTimelineStore({ dataDir: temp(t), maxTurns: 1 });
  assert.equal(store.record(identity, record), true);
  const second = { ...record, inputId: 'entry-second', beforeLeafId: answer.id, leafId: 'entry-second',
    entries: [{ id: 'entry-second', role: 'user' }], finalResponseId: null, tools: [] };
  assert.equal(store.record(identity, second), true);
  assert.deepEqual(store.list(identity), [second]);
});

test('history never assigns a reused call to an earlier assistant or trusts raw entry wrapper fields', async () => {
  const { matchExecutionTimelineRecords } = await import('../server/execution-timeline-store.js');
  const second = makeEntry('entry-second-assistant', planning.id, 'assistant', planning.message);
  const reusedResult = { ...result, parentId: second.id };
  const wrongOwner = { ...record, entries: [
    ...record.entries.slice(0, 2), { id: second.id, role: 'assistant' }, ...record.entries.slice(2),
  ] };
  assert.deepEqual(matchExecutionTimelineRecords([wrongOwner], [rootEntry, input, planning, second, reusedResult, answer], answer.id), []);
  const wrapper = { ...input, role: 'user', message: { ...input.message, role: 'assistant' } };
  assert.deepEqual(matchExecutionTimelineRecords([record], [rootEntry, wrapper, planning, result, answer], answer.id), []);
});

async function witness(readEntries, scopeOverride = scope, branchEpoch = 0) {
  const { readExecutionBranch } = await import('../server/execution-timeline.js');
  return readExecutionBranch({
    scope: scopeOverride, branchEpoch, readEntries, isCurrent: () => true,
    readState: () => ({ sessionId: scopeOverride.owner?.sessionId ?? scopeOverride.sessionId }),
  });
}

function sendRun(capture, append, settle = true) {
  const send = (event, observedAt) => capture.observe(event, { observedAt });
  send({ type: 'execution_submission', id: 'local-request', command: 'prompt' }, 100);
  send({ type: 'agent_start' }, 100);
  send({ type: 'message_start', message: input.message }, 101);
  append(input);
  send({ type: 'message_start', message: planning.message }, 110);
  send({ type: 'message_end', message: planning.message }, 120);
  append(planning);
  send({ type: 'tool_execution_start', toolCallId: 'call-read', toolName: 'read', args: { path: '/private' } }, 130);
  append(result);
  send({ type: 'tool_execution_end', toolCallId: 'call-read', toolName: 'read', result: result.message, durationMs: 30 }, 160);
  if (settle) finishRun(capture, append);
}

function finishRun(capture, append) {
  capture.observe({ type: 'message_start', message: answer.message }, { observedAt: 170 });
  capture.observe({ type: 'message_end', message: answer.message }, { observedAt: 190 });
  append(answer);
  capture.observe({ type: 'agent_settled' }, { observedAt: 200 });
}

test('checkpoint plus admitted frames preserves only witnessed activity through progress and settle', async t => {
  const { createExecutionTimelineStore } = await import('../server/execution-timeline-store.js');
  const { createExecutionTimelineCapture } = await import('../server/execution-timeline-capture.js');
  const dataDir = temp(t);
  const store = createExecutionTimelineStore({ dataDir });
  const native = [rootEntry];
  const capture = createExecutionTimelineCapture({ store, identity: () => identity,
    readBranch: () => witness(() => ({ entries: native, leafId: native.at(-1).id })) });
  assert.equal(await capture.checkpoint(), true);
  sendRun(capture, entry => native.push(entry), false);
  await capture.idle();
  const withAliases = { ...record, viewAlias: 'live:bridge-1:1:1:0:3',
    tools: [{ ...record.tools[0], viewAlias: 'turn:2:tool:6' }] };
  assert.deepEqual(store.list(identity), [{ ...withAliases, leafId: result.id, entries: record.entries.slice(0, -1),
    status: 'unknown', timing: { startedAt: 100, endedAt: null }, finalResponseId: null }]);
  finishRun(capture, entry => native.push(entry));
  await capture.idle();
  assert.deepEqual(createExecutionTimelineStore({ dataDir }).list(identity), [withAliases]);
});

test('bridge/branch replacement invalidates late recovery writes', async t => {
  const { createExecutionTimelineStore } = await import('../server/execution-timeline-store.js');
  const { createExecutionTimelineCapture } = await import('../server/execution-timeline-capture.js');
  const store = createExecutionTimelineStore({ dataDir: temp(t) });
  const native = [rootEntry];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const capture = createExecutionTimelineCapture({ store, identity: () => identity,
    readBranch: async () => {
      const snapshot = { entries: [...native], leafId: native.at(-1).id };
      if (native.length > 1) await gate;
      return witness(() => snapshot);
    } });
  assert.equal(await capture.checkpoint(), true);
  sendRun(capture, entry => native.push(entry));
  capture.reset();
  release();
  await capture.idle();
  assert.deepEqual(store.list(identity), []);
});

test('settled arriving before confirmed Stop cannot replace a partial terminal record', async t => {
  const { createExecutionTimelineStore } = await import('../server/execution-timeline-store.js');
  const { createExecutionTimelineCapture } = await import('../server/execution-timeline-capture.js');
  const store = createExecutionTimelineStore({ dataDir: temp(t) });
  const native = [rootEntry];
  const capture = createExecutionTimelineCapture({ store, identity: () => identity,
    readBranch: () => witness(() => ({ entries: native, leafId: native.at(-1).id })) });
  assert.equal(await capture.checkpoint(), true);
  sendRun(capture, entry => native.push(entry), false);
  await capture.idle();
  capture.observe({ type: 'stop_state', pending: true }, { observedAt: 170 });
  capture.observe({ type: 'agent_settled' }, { observedAt: 180 });
  await capture.idle();
  assert.equal(store.list(identity)[0]?.timing.endedAt, null);
  capture.observe({ type: 'stop_state', pending: false, state: 'stopped' }, { observedAt: 190 });
  await capture.idle();
  assert.equal(store.list(identity)[0]?.status, 'cancelled');
  assert.equal(store.list(identity)[0]?.timing.endedAt, 190);
});

test('tool-free replies with no native identity evidence stay on the fallback path', async t => {
  const { createExecutionTimelineStore } = await import('../server/execution-timeline-store.js');
  const { createExecutionTimelineCapture } = await import('../server/execution-timeline-capture.js');
  const store = createExecutionTimelineStore({ dataDir: temp(t) });
  const native = [rootEntry];
  const capture = createExecutionTimelineCapture({ store, identity: () => identity,
    readBranch: () => witness(() => ({ entries: native, leafId: native.at(-1).id })) });
  assert.equal(await capture.checkpoint(), true);
  capture.observe({ type: 'execution_submission', id: 'local-request', command: 'prompt' }, { observedAt: 100 });
  capture.observe({ type: 'agent_start' }, { observedAt: 110 });
  capture.observe({ type: 'message_start', message: input.message }, { observedAt: 120 });
  native.push(input);
  finishRun(capture, entry => native.push({ ...entry, parentId: input.id }));
  await capture.idle();
  assert.deepEqual(store.list(identity), []);
});

test('Runtime keeps its witnessed prefix partial when the live sequence has a gap', async t => {
  const { createExecutionTimelineStore } = await import('../server/execution-timeline-store.js');
  const { createExecutionTimelineCapture } = await import('../server/execution-timeline-capture.js');
  const store = createExecutionTimelineStore({ dataDir: temp(t) });
  const runtime = { kind: 'runtime', projectId: 'project-1', conversationId: 'conversation-1',
    workspaceId: identity.workspaceId, sessionId: identity.sessionId };
  const runtimeScope = { kind: 'runtime', owner: {
    backendInstance: 'backend-1', projectId: runtime.projectId, repoId: 'repo-1',
    workspaceId: runtime.workspaceId, workspaceEpoch: 'workspace-generation-1',
    conversationId: runtime.conversationId, runtimeId: 'runtime-1', runtimeGeneration: 'runtime-generation-1',
    sessionId: runtime.sessionId,
  } };
  const native = [rootEntry];
  const capture = createExecutionTimelineCapture({ store, identity: () => runtime,
    readBranch: () => witness(() => ({ entries: native, leafId: native.at(-1).id }), runtimeScope) });
  assert.equal(await capture.checkpoint(), true);
  sendRun(capture, entry => native.push(entry), false);
  await capture.idle();
  assert.equal(store.list(runtime)[0]?.leafId, result.id);
  assert.deepEqual(store.list(identity), []);
  capture.observe({ type: 'message_start', message: answer.message }, { sequence: 100, observedAt: 170 });
  capture.observe({ type: 'message_end', message: answer.message }, { sequence: 101, observedAt: 190 });
  native.push(answer);
  capture.observe({ type: 'agent_settled' }, { sequence: 102, observedAt: 200 });
  await capture.idle();
  assert.deepEqual(store.list(runtime).map(turn => [turn.status, turn.leafId, turn.timing.endedAt]), [['unknown', result.id, null]]);
  assert.deepEqual(store.list({ ...runtime, conversationId: 'other-conversation' }), []);
});
