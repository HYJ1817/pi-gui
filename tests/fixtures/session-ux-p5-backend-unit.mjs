import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeRegistry } from '../../server/runtime-registry.js';
import { createExecutionDetailIndex, createExecutionToolProjection, readExecutionBranch, bindExecutionEntries } from '../../server/execution-timeline.js';
import { projectRuntimeEvent } from '../../server/session-runtime.js';

const owner = {
  backendInstance: 'backend', projectId: 'project', repoId: 'repo', workspaceId: 'workspace',
  workspaceEpoch: 'epoch', conversationId: 'conversation', runtimeId: 'runtime',
  runtimeGeneration: 'generation', sessionId: 'native-a',
};
const scope = { kind: 'runtime', owner };
const target = { responseEntryId: 'answer', resultEntryId: 'result', callId: 'native-call' };
const differentScope = key => ({ kind: 'runtime', owner: { ...owner, [key]: 'different' } });
const call = { type: 'toolCall', id: 'native-call', name: 'read', arguments: { path: 'C:/work/guide.md', offset: 4, token: 'CANARY_INPUT' } };
const message = (id, parentId, role, content) => ({ type: 'message', id, parentId, message: { role, content } });
const result = (id, parentId) => ({
  ...message(id, parentId, 'toolResult', [{ type: 'text', text: 'CANARY_OUTPUT' }]),
  message: { role: 'toolResult', toolCallId: 'native-call', toolName: 'read', content: [{ type: 'text', text: 'CANARY_OUTPUT' }] },
});
const setup = {
  leafId: 'result',
  entries: [
    message('initial', null, 'user', [{ type: 'text', text: 'CANARY_USER' }]),
    message('input', 'initial', 'user', []),
    message('answer', 'input', 'assistant', [call]),
    result('result', 'answer'),
    message('physical-tail', 'initial', 'assistant', [{ type: 'text', text: 'CANARY_OFF_BRANCH' }]),
  ],
};
const readBranch = overrides => readExecutionBranch({
  scope, readState: async () => ({ sessionId: owner.sessionId }), readEntries: async () => setup,
  isCurrent: () => true, ...overrides,
});

export async function runBackendUnit() {
  let count = 0;
  const check = async (name, fn) => { await fn(); count++; console.log('  ok  ' + name); };
  await check('Runtime alternate envelopes do not carry tool payloads', () => {
    const assistant = setup.entries[2].message, toolResult = setup.entries[3].message;
    const outputs = [
      projectRuntimeEvent({ type: 'agent_end', messages: [assistant, toolResult], willRetry: false }),
      projectRuntimeEvent({ type: 'turn_end', message: assistant, toolResults: [toolResult], debugMetadata: 'CANARY_META' }),
      projectRuntimeEvent({ type: 'entry_appended', entry: setup.entries[3] }),
      projectRuntimeEvent({ type: 'response', command: 'get_entries', data: setup, success: true }),
      projectRuntimeEvent({ type: 'response', command: 'get_tree', data: { tree: setup.entries, leafId: setup.leafId }, success: true }),
      projectRuntimeEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'visible',
        partial: assistant, debugMetadata: 'CANARY_META' }, debugMetadata: 'CANARY_META' }),
      projectRuntimeEvent({ type: 'agent_settled', generationResult: { requestId: 'request', outcome: 'failed',
        failure: { class: 'unknown', reason: 'CANARY_META' }, metadata: 'CANARY_META' } }),
      projectRuntimeEvent({ type: 'compaction_end', success: false, errorMessage: 'CANARY_META' }),
    ];
    assert.doesNotMatch(JSON.stringify(outputs), /CANARY_/);
    assert.equal(outputs[0].willRetry, false);
    assert.equal(outputs[1].message.content[0].id, 'native-call');
    assert.equal(outputs[3].data.leafId, 'result');
    assert.equal(outputs[5].assistantMessageEvent.delta, 'visible');
    assert.equal(outputs[7].success, false);
    assert.equal(outputs[7].errorMessage, '上下文压缩失败');
  });
  await check('summary restricts content and uses tool identity and reported facts', () => {
    const tool = createExecutionToolProjection();
    const start = tool.observe({ type: 'tool_execution_start', bridgeRun: 1, toolCallId: 'id', toolName: 'read',
      args: { path: 'C:/workspace/doc.md', offset: 4, limit: 2, authorization: 'CANARY_AUTH' } });
    assert.equal(start.fileName, 'doc.md');
    assert.deepEqual(start.requestedRange, { start: 4, end: 5 });
    assert.equal(start.lineRange, undefined);
    assert.doesNotMatch(JSON.stringify(start), /CANARY_|workspace/);
    assert.equal(tool.observe({ type: 'tool_execution_end', bridgeRun: 1, toolCallId: 'id', toolName: 'edit',
      result: { details: { diff: '+CANARY_MISMATCH' } } }), null);
    const end = tool.observe({ type: 'tool_execution_end', bridgeRun: 1, toolCallId: 'id', result: {
      content: [{ type: 'text', text: 'CANARY_OUTPUT' }], details: { truncation: { truncated: true, outputLines: 2 }, secret: 'CANARY_OUTPUT' },
    } });
    assert.equal(end.fileName, 'doc.md');
    assert.deepEqual(end.lineRange, { start: 4, end: 5 });
    assert.doesNotMatch(JSON.stringify(end), /CANARY_/);
    const hidden = tool.observe({ type: 'tool_execution_start', bridgeRun: 1, toolCallId: 'secret', toolName: 'read',
      args: { path: 'C:/safe/.env' } });
    assert.equal(hidden.fileName, undefined);
    for (const name of ['notes sk-SYNTHETICMARKERONLY.txt', 'notes TOKEN example.txt', 'notes (credentials).txt']) {
      const secretPath = tool.observe({ type: 'tool_execution_start', bridgeRun: 1,
        toolCallId: 'hidden-' + name.length, toolName: 'read', args: { path: 'C:/safe/' + name } });
      assert.equal(secretPath?.fileName, undefined);
    }
    const command = tool.observe({ type: 'tool_execution_start', bridgeRun: 1, toolCallId: 'shell', toolName: 'bash',
      args: { command: 'git status --token=CANARY_AUTH' } });
    assert.equal(command.command, 'git');
    assert.doesNotMatch(JSON.stringify(command), /CANARY_/);
    const unknown = tool.observe({ type: 'tool_execution_start', bridgeRun: 1, toolCallId: 'unknown', toolName: 'unknown',
      args: { path: 'C:/secret.md' } });
    assert.equal(unknown.fileName, undefined);
  });
  await check('sequential summaries survive both legacy thresholds and retirement eviction', () => {
    const tool = createExecutionToolProjection();
    const wire = { bridgeRun: 1, toolName: 'read' };
    for (let index = 0; index < 4608; index++) {
      const toolCallId = 'sequential-' + index;
      const start = tool.observe({ ...wire, type: 'tool_execution_start', toolCallId, args: { path: 'src/sample.js' } });
      assert.equal(start?.fileName, 'sample.js', 'start index ' + index);
      const end = tool.observe({ ...wire, type: 'tool_execution_end', toolCallId,
        result: { content: [{ type: 'text', text: 'CANARY_OUTPUT' }],
          details: { truncation: { truncated: true, outputLines: 2 } } } });
      assert.deepEqual(end?.lineRange, { start: 1, end: 2 });
      assert.doesNotMatch(JSON.stringify(end), /CANARY_/);
    }
    const toolCallId = 'sequential-4607';
    assert.equal(tool.observe({ ...wire, type: 'tool_execution_end', toolCallId }), null);
    assert.equal(tool.observe({ ...wire, type: 'agent_settled' }), null);
    assert.equal(tool.observe({ ...wire, type: 'tool_execution_start', toolCallId }), null);
    assert.equal(tool.observe({ ...wire, type: 'tool_execution_end', toolCallId }), null);
  });
  await check('simultaneous summary overflow, ID conflicts and old bridge frames fail closed', () => {
    const projection = createExecutionToolProjection();
    const event = (type, id, extra = {}) =>
      projection.observe({ type: 'tool_execution_' + type, bridgeRun: 3, toolCallId: id, toolName: 'read', ...extra });
    for (let i = 0; i < 512; i++) assert.ok(event('start', 'live-' + i));
    assert.equal(event('start', 'overflow'), null);
    assert.ok(event('end', 'live-0'));
    assert.equal(event('end', 'overflow'), null);
    assert.equal(event('start', 'overflow'), null);
    assert.ok(event('start', 'fresh'));
    assert.equal(event('start', 'fresh', { toolName: 'write' }), null);
    assert.equal(event('end', 'fresh'), null);
    assert.equal(event('end', 'fresh', { toolName: 'write' }), null);
    assert.ok(event('start', 'later'));
    projection.observe({ type: 'agent_settled', bridgeRun: 3 });
    assert.equal(event('end', 'later'), null);
    assert.equal(event('start', 'later'), null);
    assert.ok(event('start', 'later', { bridgeRun: 4 }));
    assert.equal(event('end', 'later'), null);
    assert.ok(event('end', 'later', { bridgeRun: 4 }));
    assert.ok(event('start', 'plan-collision', { bridgeRun: 4 }));
    assert.equal(event('start', 'plan-collision', { bridgeRun: 4, toolName: 'gui_plan' }), null);
    assert.equal(event('end', 'plan-collision', { bridgeRun: 4, toolName: undefined }), null);
    for (const boundary of [{ type: 'auto_retry_start' },
      { type: 'stop_state', pending: false, state: 'stopped' }]) {
      assert.ok(event('start', boundary.type, { bridgeRun: 4 }));
      projection.observe({ ...boundary, bridgeRun: 4 });
      assert.equal(event('end', boundary.type, { bridgeRun: 4 }), null);
    }
    assert.ok(event('start', 'edited-branch', { bridgeRun: 4 }));
    projection.observe({ type: 'execution_branch', bridgeRun: 4 });
    assert.equal(event('end', 'edited-branch', { bridgeRun: 4 }), null);
    assert.ok(event('start', 'edited-branch', { bridgeRun: 4 }));
    assert.ok(event('end', 'edited-branch', { bridgeRun: 4 }));
  });
  await check('private native branch reader is bounded and follows parent/leaf, not physical tail', async () => {
    const branch = await readBranch();
    const checkpoint = await readBranch({ readEntries: async () => ({ ...setup, leafId: 'initial' }) });
    assert.deepEqual(branch.entries.map(entry => entry.id), ['initial', 'input', 'answer', 'result']);
    assert.doesNotMatch(JSON.stringify(branch), /CANARY_/);
    assert.deepEqual(bindExecutionEntries(branch, { checkpoint, beforeLeafId: 'initial', messages: [
      { id: 'temp-u', role: 'user' },
      { id: 'temp-a', role: 'assistant', toolCalls: [{ id: 'native-call', index: 0, name: 'read' }] },
    ] }).aliases, [{ from: 'temp-u', to: 'input' }, { from: 'temp-a', to: 'answer' }]);
    assert.equal(bindExecutionEntries(branch, { checkpoint, beforeLeafId: 'physical-tail', messages: [] }), null);
    assert.equal(bindExecutionEntries(branch, { checkpoint, beforeLeafId: 'initial', messages: [
      { id: 'temp-u', role: 'user' }, { id: 'temp-a', role: 'assistant', toolCalls: [] },
    ] }), null);
    const roleOnly = await readBranch({ readEntries: async () => ({ ...setup, leafId: 'plain', entries: [
      ...setup.entries, message('plain', 'input', 'assistant', [{ type: 'text', text: 'hello' }]),
    ] }) });
    const roleOnlyBinding = bindExecutionEntries(roleOnly, { checkpoint, messages: [
      { id: 'temp-u', role: 'user' }, { id: 'temp-a', role: 'assistant', toolCalls: [] },
    ] });
    assert.deepEqual(roleOnlyBinding.aliases, []);
    assert.equal(roleOnlyBinding.partial, true);
    assert.equal(await readBranch({ isCurrent: () => false }), null);
    assert.equal(await readBranch({ readEntries: async () => ({ ...setup, leafId: 'missing' }) }), null);
    assert.equal(await readBranch({ readEntries: async () => ({ ...setup, entries: [
      ...setup.entries, message('result', 'input', 'assistant', []),
    ] }) }), null);
    let reads = 0;
    assert.equal(await readBranch({ readEntries: async () => reads++ ? { ...setup, leafId: 'initial' } : setup }), null);
    reads = 0;
    assert.equal(await readBranch({ readState: async () => ({ sessionId: reads++ ? 'different' : owner.sessionId }) }), null);
  });
  await check('controlled details are scoped, branch checked, capped, and expired', async () => {
    let now = 10, branch = await readBranch({ detailTarget: target }), current = scope;
    const cache = createExecutionDetailIndex({
      maxEntries: 1, maxBytes: 1024, ttlMs: 100, now: () => now,
      isCurrent: value => value.kind === 'runtime' && Object.keys(owner).every(key => current.owner[key] === value.owner[key]),
      readBranch: async () => branch,
    });
    const request = { scope, branch, ...target };
    assert.equal(cache.capture({ ...request, callId: 'other' }), null);
    const native = { ...request, toolName: 'read', args: { path: 'C:/work/forged.md', offset: 5, bearer: 'CANARY_TOKEN' },
      result: { content: [{ type: 'text', text: 'CANARY_CONTENT' }], details: { env: ['CANARY_ENV'] } } };
    const first = cache.capture(native);
    assert.equal(first.state, 'available');
    for (const key of Object.keys(owner)) {
      assert.equal((await cache.read({ scope: differentScope(key), ref: first.id, callId: 'native-call' })).ok, false, key);
    }
    assert.equal((await cache.read({ scope, ref: first.id, callId: 'other' })).ok, false);
    const detail = await cache.read({ scope, ref: first.id, callId: 'native-call' });
    assert.equal(detail.ok, true);
    assert.doesNotMatch(JSON.stringify(detail), /CANARY_|C:\//);
    assert.deepEqual(detail.parameters, { fileName: 'guide.md', requestedRange: { start: 4 } });
    const second = cache.capture(native);
    assert.equal((await cache.read({ scope, ref: first.id, callId: 'native-call' })).ok, false);
    assert.equal(cache.size().entries, 1);
    assert.ok(cache.size().bytes <= 1024);
    branch = await readBranch({ readEntries: async () => ({ ...setup, leafId: 'physical-tail' }) });
    assert.equal((await cache.read({ scope, ref: second.id, callId: 'native-call' })).ok, false);
    branch = await readBranch({ detailTarget: target });
    const third = cache.capture(native); now += 100;
    assert.equal((await cache.read({ scope, ref: third.id, callId: 'native-call' })).ok, false);
    assert.equal(cache.size().entries, 0);
    const fourth = cache.capture(native); current = differentScope('runtimeGeneration');
    assert.equal((await cache.read({ scope, ref: fourth.id, callId: 'native-call' })).ok, false);
  });
  await check('registry publishes actual per-generation and session-binding boundaries', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-execution-registry-'));
    const events = [];
    let emit, allowSession, validationOn = true, disposed = false;
    const nativeReady = new Promise(resolve => { allowSession = resolve; });
    const workspace = { projectId: 'project', repoId: 'repo', workspaceId: 'workspace', workspaceEpoch: 'epoch', cwd: root, root };
    const registry = createRuntimeRegistry({
      dataDir: root, resolveWorkspace: async () => workspace, publish: frame => events.push(frame),
      validateWorkspace: async () => { if (!validationOn) throw Error('stale_workspace'); },
      executionValidation: true,
      factory: async (_context, send) => {
        emit = send;
        return {
          start() { emit({ type: 'bridge_status', bridgeRun: 1, state: 'ready' }); },
          request: async () => { await nativeReady; return { sessionId: 'native-a' }; },
          executionBranch: (bound, branchEpoch, detailTarget) => readBranch({ scope: bound, branchEpoch, detailTarget }),
          getState: () => ({ state: 'ready', stop: null }),
          dispose: async () => { disposed = true; }, cleanupConfirmed: () => disposed,
        };
      },
    });
    try {
      const created = await registry.start({ id: 'workspace', epoch: 'epoch' });
      assert.equal(created.owner.sessionId, null);
      emit({ type: 'message_start', bridgeRun: 1, message: { role: 'user', content: [] } });
      const provisional = events.findLast(frame => frame.type === 'runtime_event');
      assert.equal(provisional.owner.sessionId, null);
      assert.equal(provisional.execution.startSequence, 0);
      allowSession();
      await new Promise(resolve => setImmediate(resolve));
      const item = registry.snapshot().items[0];
      assert.equal(item.owner.sessionId, 'native-a');
      assert.equal(item.execution.previousSessionId, null);
      assert.equal(item.execution.sessionBound, true);
      assert.equal(item.execution.sessionBoundAtSequence, provisional.eventSequence);
      const nativeEvidence = await registry.executionBranch(item.owner);
      assert.equal(nativeEvidence.leafId, 'result');
      const detail = await registry.captureExecutionDetail(item.owner, { responseEntryId: 'answer', resultEntryId: 'result',
        callId: 'native-call', toolName: 'read', args: { path: 'safe.md' } });
      const known = await registry.readExecutionDetail(item.owner, detail.id, 'native-call');
      assert.equal(known.ok, true);
      assert.equal(known.parameters.fileName, 'guide.md');
      validationOn = false;
      assert.equal((await registry.readExecutionDetail(item.owner, detail.id, 'native-call')).ok, false);
      validationOn = true;
      emit({ type: 'execution_branch', bridgeRun: 1 });
      const branch = events.findLast(frame => frame.type === 'runtime_event');
      assert.equal(branch.execution.branchEpoch, item.execution.branchEpoch + 1);
      assert.equal(branch.execution.startSequence, branch.eventSequence - 1);
      assert.equal((await registry.readExecutionDetail(item.owner, detail.id, 'native-call')).ok, false);
      emit({ type: 'bridge_status', bridgeRun: 2, state: 'starting' });
      const newer = events.findLast(frame => frame.type === 'runtime_event');
      assert.notEqual(newer.owner.runtimeGeneration, item.owner.runtimeGeneration);
      assert.equal(newer.execution.startSequence, branch.eventSequence);
      const preceding = events[events.indexOf(newer) - 1];
      assert.equal(preceding.type, 'runtime_state');
      assert.deepEqual(preceding.owner, newer.owner);
      assert.equal(registry.events(newer.owner, 0).item.execution.startSequence, branch.eventSequence);
      assert.equal(await registry.executionBranch(item.owner), null);
    } finally {
      allowSession();
      await registry.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const count = await runBackendUnit();
  console.log('P5 Runtime backend: ' + count + '/' + count);
}
