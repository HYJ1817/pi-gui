// Pi JSON/RPC stdout, Runtime registry frame and nested native entry fixtures.
const assert = require('node:assert/strict');

const classic = { kind: 'classic', bridgeInstance: 'bridge', bridgeRun: 1,
  workspaceKey: 'work', workspaceGeneration: 1, sessionId: 'native' };
const owner = { backendInstance: 'backend', projectId: 'project', repoId: 'repo',
  workspaceId: 'work', workspaceEpoch: '1', conversationId: 'conversation',
  runtimeId: 'runtime', runtimeGeneration: 'generation', sessionId: 'native' };
const runtime = { kind: 'runtime', owner };
const usage = { input: 9, output: 4, totalTokens: 13, reasoning: 0 };
const text = value => ({ type: 'text', text: value });
const tool = (id, name) => ({ type: 'toolCall', id, name, arguments: {} });
const message = (role, content, options = {}) => ({ role, content, timestamp: 100, ...options });
const start = message => ({ type: 'message_start', message });
const end = message => ({ type: 'message_end', message });
const toolStart = (toolCallId, toolName) => ({ type: 'tool_execution_start', toolCallId, toolName, args: {} });
const toolEnd = (toolCallId, isError = false) => ({ type: 'tool_execution_end', toolCallId, isError, durationMs: 15 });
const assistant = (content, stopReason, model = 'model-a') =>
  message('assistant', content, { stopReason, model, provider: 'test-provider', usage });
const plan = { tool: 'gui_plan', version: 1, revision: 3, turnId: 'producer-turn', tasks: [
  { id: 'inspect', title: 'Inspect', status: 'completed' },
  { id: 'verify', title: 'Verify', status: 'in_progress' },
] };
const planned = assistant([tool('P', 'gui_plan')], 'toolUse');
const progress = assistant([{ type: 'thinking', thinking: 'Visible thought' }, text('Progress'), tool('A', 'read'), tool('B', 'grep')], 'toolUse');
const answer = assistant([text('Final answer')], 'stop', 'model-b');
const firstInput = message('user', [text('Same task'), { type: 'image', mimeType: 'image/png', data: 'YXNkZg==' }]);
const scenario = [
  { type: 'execution_submission', id: 'p1', command: 'prompt' },
  start(firstInput), end(firstInput),
  { type: 'agent_start' },
  start(progress), end(progress),
  toolStart('A', 'read'), toolStart('B', 'grep'), toolEnd('B', true), toolEnd('A'),
  start(planned), end(planned),
  { ...toolStart('P', 'gui_plan'), args: { tasks: plan.tasks } },
  { ...toolEnd('P'), result: { details: plan } },
  { type: 'agent_end' }, { type: 'agent_start' },
  start(answer), end(answer),
  { type: 'agent_end' }, { type: 'agent_settled', aborted: false },
];
const native = [firstInput, progress, message('toolResult', [text('B output')], { toolCallId: 'B', isError: true }),
  message('toolResult', [text('A output')], { toolCallId: 'A' }), planned,
  message('toolResult', [text('Plan saved')], { toolCallId: 'P', details: plan }), answer]
  .map((message, i) => ({ type: 'message', id: 'e' + i, parentId: i ? 'e' + (i - 1) : null, message }));

function compare(value) {
  return {
    turns: value.turns.map(t => ({
      status: t.status, plan: t.plan?.items.map(p => [p.producerId, p.status]),
      parts: t.parts.map(p => [p.kind, p.text]), usage: t.usage.map(u => [u.model?.id, u.recorded.totalTokens]),
    })),
    items: value.items.map(i => [i.callId, i.status]),
  };
}

async function main() {
  const { createExecutionStream, sameExecutionScope } = await import('../public/execution-timeline-adapter.js');
  const { projectRuntimeEvent } = await import('../server/session-runtime.js');
  const { bindExecutionEntries, createExecutionToolProjection, readExecutionBranch } = await import('../server/execution-timeline.js');
  const { observeRuntimeFrame, seedRuntimeSnapshot } = await import('../public/runtime-state.js');
  const { getRuntimeExecutionTimeline, runtimeExecutionCursor } = await import('../public/execution-timeline-state.js');
  const programs = [createExecutionStream(classic), createExecutionStream(runtime, { startSequence: 40 })];
  const checks = [];
  const check = (name, fn) => { fn(); checks.push(name); };
  for (let i = 0; i < scenario.length; i++) {
    const event = scenario[i], observedAt = 1000 + i;
    programs[0].observe(JSON.parse(JSON.stringify(event)), { sequence: i + 1, observedAt });
    const frame = { type: 'runtime_event', owner, eventSequence: 41 + i,
      execution: { startSequence: 40, observedAt }, event: projectRuntimeEvent(event) };
    programs[1].observe(frame.event, { sequence: frame.eventSequence, observedAt });
  }
  const output = compare(programs[0].snapshot());
  check('Equivalent Classic RPC and Runtime projected facts', () => assert.deepEqual(compare(programs[1].snapshot()), output));
  check('One turn with three response usage entries and one real Plan', () => {
    assert.equal(output.turns.length, 1);
    assert.equal(output.turns[0].status, 'completed');
    assert.deepEqual(output.turns[0].usage, [['model-a', 13], ['model-a', 13], ['model-b', 13]]);
    assert.deepEqual(output.turns[0].plan, [['inspect', 'completed'], ['verify', 'in_progress']]);
  });
  check('Final answer, thinking and process text are independent', () => {
    assert.deepEqual(output.turns[0].parts, [['thinking', 'Visible thought'], ['progress-text', 'Progress'], ['answer', 'Final answer']]);
  });
  check('Tool start order unaffected by end order or tool failure', () => assert.deepEqual(output.items, [['A', 'completed'], ['B', 'failed']]));
  check('Scope check does not accept different projects or sessions', () => {
    assert.equal(sameExecutionScope(runtime, { kind: 'runtime', owner: { ...owner, projectId: 'foreign' } }), false);
    assert.equal(sameExecutionScope(classic, { ...classic, sessionId: 'other' }), false);
  });
  check('Bounded source resolver preserves input attachments, with final echo deduplicated', () => {
    for (const program of programs) {
      const [turn] = program.snapshot().turns;
      assert.equal(turn.additionalInputs.length, 0);
      assert.equal(turn.input.preview.text, 'Same task');
      assert.deepEqual(program.resolveMessage(turn.input.content).content, firstInput.content);
    }
  });

  const drive = (scope, events, options = {}) => {
    const stream = createExecutionStream(scope, options);
    events.forEach((event, index) => stream.observe(event, { sequence: index + 1, observedAt: 1000 + index }));
    return stream;
  };
  const submitting = id => ({ type: 'execution_submission', command: 'prompt', id });
  const failedAttempt = { type: 'agent_settled', generationResult: { requestId: 'p1', outcome: 'failed', hasVisibleOutput: false } };
  const settle = { type: 'agent_settled', aborted: false };
  check('Same text in independent requests and delivered steering keep distinct ownership', () => {
    const turns = drive(classic, [
      submitting('p1'), start(firstInput), end(firstInput),
      { type: 'execution_submission', command: 'steer', id: 's1' }, start(firstInput), end(firstInput), settle,
      submitting('p2'), start(firstInput), end(firstInput), settle,
    ]).snapshot().turns;
    assert.equal(turns.length, 2);
    assert.notEqual(turns[0].id, turns[1].id);
    assert.equal(turns[0].additionalInputs.length, 1);
    assert.equal(turns[1].additionalInputs.length, 0);
  });
  check('Only server-witnessed fallback reopens the failed task', () => {
    const [turn] = drive(classic, [
      submitting('p1'), start(firstInput), end(firstInput), failedAttempt,
      { ...submitting('p2'), fallbackOf: 'p1' }, start(firstInput), end(firstInput),
      start(answer), end(answer), settle,
    ]).snapshot().turns;
    assert.deepEqual(turn.attempts.map(a => [a.kind, a.status]), [['initial', 'failed'], ['fallback', 'completed']]);
    assert.equal(turn.additionalInputs.length, 0);
  });
  check('Internal retries, compaction and Stop stay inside one task', () => {
    const state = drive(classic, [
      submitting('p1'), start(firstInput),
      { type: 'agent_start' }, { type: 'agent_end' }, { type: 'auto_retry_start', attempt: 1 },
      { type: 'agent_start' }, { type: 'compaction_start' }, { type: 'compaction_end', success: false },
      toolStart('W', 'write'), { type: 'tool_wait_state', toolCallId: 'W', waiting: true },
      { type: 'stop_state', pending: true }, { type: 'stop_state', pending: false, state: 'stopped' },
    ]).snapshot();
    assert.equal(state.turns.length, 1);
    assert.equal(state.turns[0].status, 'cancelled');
    assert.deepEqual(state.items.map(i => [i.kind, i.status]), [['compaction', 'failed'], ['tool', 'interrupted']]);
    assert.deepEqual(state.turns[0].attempts.map(a => a.kind), ['initial', 'auto-retry']);
  });
  check('End-before-start and late same-call IDs never overwrite older scoped results', () => {
    const state = drive(classic, [
      submitting('p1'), start(firstInput), toolEnd('K'), toolStart('K', 'read'), settle,
      submitting('p2'), start(firstInput), toolStart('K', 'read'), toolEnd('K'), settle,
    ]).snapshot();
    assert.deepEqual(state.items.map(i => i.status), ['completed', 'incomplete']);
    assert.equal(state.turns[1].completeness, 'partial');
  });
  check('A mismatched tool name cannot settle another call', () => {
    const stream = drive(classic, [submitting('p1'), start(firstInput), toolStart('K', 'read'),
      { ...toolEnd('K'), toolName: 'write' }]);
    assert.equal(stream.snapshot().items[0].status, 'running');
    stream.observe(toolEnd('K'), { sequence: 5, observedAt: 1005 });
    assert.equal(stream.snapshot().items[0].status, 'completed');
  });
  check('Indeterminate legacy settle waits for the owned Stop confirmation', () => {
    const stream = drive(classic, [submitting('p1'), start(firstInput),
      { type: 'stop_state', pending: true }, { type: 'agent_settled' }]);
    assert.equal(stream.snapshot().turns[0].status, 'stopping');
    stream.observe({ type: 'stop_state', state: 'stopped', pending: false }, { sequence: 5 });
    assert.equal(stream.snapshot().turns[0].status, 'cancelled');
  });
  check('Queue bounds degrade to partial without inventing a successful turn', () => {
    const stream = createExecutionStream(runtime, { maxPending: 1, maxPendingBytes: 512 });
    stream.observe(submitting('p1'), { sequence: 1, observedAt: 1 });
    stream.observe(start(firstInput), { sequence: 2, observedAt: 2 });
    stream.observe(toolEnd('x'), { sequence: 4, observedAt: 4 });
    assert.equal(stream.missing().cursor, 2);
    stream.observe(settle, { sequence: 5, observedAt: 5 });
    assert.equal(stream.missing(), null);
    assert.equal(stream.snapshot().turns[0].completeness, 'partial');
    assert.equal(stream.snapshot().turns[0].status, 'unknown');
  });
  check('An earlier ID remains ambiguous after more than 2048 completions', () => {
    const stream = createExecutionStream(classic);
    let seq = 0;
    const emit = event => stream.observe(event, { sequence: ++seq, observedAt: seq });
    emit(submitting('p1'));
    emit(start(firstInput));
    for (let i = 0; i <= 2048; i++) {
      emit(toolStart('call-' + i, 'read'));
      emit(toolEnd('call-' + i));
    }
    emit(toolStart('call-0', 'read'));
    emit(toolEnd('call-0'));
    emit(settle);
    const snapshot = stream.snapshot();
    assert.equal(snapshot.items.at(-1).status, 'incomplete');
    assert.equal(snapshot.turns[0].completeness, 'partial');
  });
  check('Fresh terminal activity survives retirement eviction in one Classic and Runtime stream', () => {
    for (const scope of [classic, runtime]) {
      const stream = createExecutionStream(scope);
      const toolProjection = createExecutionToolProjection();
      let sequence = 0;
      const emit = (event, seq = ++sequence) => {
        const native = { ...event, bridgeRun: 1 };
        const activity = toolProjection.observe(native);
        const projected = scope.kind === 'runtime'
          ? projectRuntimeEvent(native, activity)
          : { ...native, activity: activity || undefined };
        return stream.observe(projected, { sequence: seq, observedAt: seq });
      };
      emit(submitting('long-run'));
      emit(start(firstInput));
      for (let i = 0; i < 4608; i++) {
        const id = 'sequential-' + i;
        emit({ ...toolStart(id, 'read'), args: { path: 'src/sample.js' } });
        const end = toolEnd(id, i === 4607);
        emit(end);
        if ([512, 2048, 2049, 4096, 4607].includes(i)) {
          const item = stream.snapshot().items.at(-1);
          assert.equal(item.callId, id);
          assert.equal(item.summary.fileName, 'sample.js');
          assert.equal(item.status, i === 4607 ? 'failed' : 'completed', scope.kind + ' index ' + i);
          assert.equal(item.timing.durationMs, 15);
          assert.equal(emit({ ...end, isError: !end.isError }, sequence), false);
        }
      }
      emit(settle);
      emit(submitting('next-run'));
      emit(start(firstInput));
      emit(toolEnd('sequential-4607'));
      emit(toolStart('sequential-4607', 'read'));
      emit(toolStart('sequential-4607', 'read'));
      emit(toolStart('sequential-4607', 'read'));
      emit(toolEnd('sequential-4607'));
      emit(toolStart('brand-new', 'read'));
      emit(toolEnd('brand-new'));
      emit(settle);
      const final = stream.snapshot();
      const lastTurnId = final.turns.at(-1).id;
      assert.deepEqual(final.items.filter(item => item.turnId === lastTurnId).map(item => [item.callId, item.status]), [
        ['sequential-4607', 'incomplete'], ['brand-new', 'completed'],
      ]);
    }
  });
  check('Adapter drops ambiguous tool completions after concurrent overflow and conflicting starts', () => {
    const stream = createExecutionStream(classic);
    let sequence = 0;
    const emit = event => stream.observe(event, { sequence: ++sequence, observedAt: sequence });
    emit(submitting('overflow-run'));
    emit(start(firstInput));
    for (let i = 0; i < 256; i++) emit(toolStart('active-' + i, 'read'));
    emit(toolStart('skipped', 'read'));
    emit(toolEnd('active-0'));
    emit(toolEnd('skipped'));
    emit(toolStart('skipped', 'read'));
    emit(toolEnd('skipped'));
    emit(toolStart('conflicted', 'read'));
    emit(toolStart('conflicted', 'write'));
    emit(toolEnd('conflicted'));
    emit(toolStart('conflicted', 'read'));
    emit(toolStart('fresh', 'read'));
    emit(toolEnd('fresh'));
    emit({ ...toolEnd('fresh'), isError: true });
    emit(settle);
    const snapshot = stream.snapshot();
    const status = id => snapshot.items.find(item => item.callId === id)?.status;
    assert.equal(status('active-0'), 'completed');
    assert.equal(status('skipped'), 'incomplete');
    assert.equal(status('conflicted'), 'incomplete');
    assert.equal(snapshot.items.filter(item => item.callId === 'conflicted').length, 1);
    assert.equal(status('fresh'), 'completed');
    assert.equal(snapshot.turns[0].completeness, 'partial');
  });
  check('Retry and conflicting orphan ends retain only proven activity facts', () => {
    const stream = drive(classic, [submitting('retry-run'), start(firstInput), toolStart('before-retry', 'read'),
      { type: 'auto_retry_start', attempt: 1 }, toolEnd('before-retry'),
      toolEnd('orphan'), { ...toolEnd('orphan'), isError: true }, toolStart('orphan', 'read'),
      toolStart('after-retry', 'read'), toolEnd('after-retry')]);
    assert.deepEqual(stream.snapshot().items.map(item => [item.callId, item.status]), [
      ['before-retry', 'incomplete'], ['orphan', 'incomplete'], ['after-retry', 'completed'],
    ]);
  });
  check('Runtime side path receives low-sequence fills rejected by old store', () => {
    const execution = { branchEpoch: 1, startSequence: 40, observedAt: 1000 };
    const item = { conversationId: owner.conversationId, owner, lifecycle: 'ready', activity: 'running', revision: 1, execution };
    seedRuntimeSnapshot({ backendInstance: owner.backendInstance, items: [item] });
    const send = (sequence, event, boundOwner = owner, meta = execution) => observeRuntimeFrame({
      type: 'runtime_event', eventSequence: sequence, owner: boundOwner, execution: meta, event,
    });
    assert.equal(send(41, submitting('p1')), true);
    assert.equal(send(43, toolStart('test', 'read')), true);
    assert.equal(runtimeExecutionCursor(owner), 41);
    assert.equal(send(42, start(firstInput)), false);
    assert.equal(runtimeExecutionCursor(owner), 43);
    assert.equal(send(44, toolEnd('test'), { ...owner, workspaceEpoch: 'other' }), false);
    assert.equal(getRuntimeExecutionTimeline(owner).items[0].status, 'running');
    assert.equal(send(44, toolEnd('test')), true);
    assert.equal(getRuntimeExecutionTimeline(owner).items[0].status, 'completed');
    const newEpoch = { ...execution, startSequence: 44, branchEpoch: 2 };
    seedRuntimeSnapshot({ backendInstance: owner.backendInstance, items: [{ ...item, revision: 2, execution: newEpoch }] });
    send(45, start(firstInput)); // Previous branch frame from same transport owner.
    assert.equal(getRuntimeExecutionTimeline(owner).turns.length, 0);
    send(45, start(firstInput), owner, newEpoch); // Legacy cursor may already have advanced.
    assert.equal(getRuntimeExecutionTimeline(owner).turns.length, 1);
  });
  check('Runtime first native session binding keeps the same owned task and attachments', () => {
    const provisional = { ...owner, sessionId: null, conversationId: 'new-conversation' };
    const settledOwner = { ...provisional, sessionId: 'new-native' };
    const execution = { branchEpoch: 0, startSequence: 100, observedAt: 1000 };
    const item = { conversationId: provisional.conversationId, owner: provisional,
      lifecycle: 'ready', activity: 'running', revision: 1, execution };
    seedRuntimeSnapshot({ backendInstance: owner.backendInstance, items: [item] });
    observeRuntimeFrame({ type: 'runtime_event', eventSequence: 101, owner: provisional, execution, event: submitting('p1') });
    observeRuntimeFrame({ type: 'runtime_event', eventSequence: 102, owner: provisional, execution, event: start(firstInput) });
    const prior = getRuntimeExecutionTimeline(provisional).turns[0].id;
    const bound = { ...execution, sessionBoundAtSequence: 102 };
    seedRuntimeSnapshot({ backendInstance: owner.backendInstance, items: [{ ...item, owner: settledOwner, revision: 2, execution: bound }] });
    assert.equal(getRuntimeExecutionTimeline(provisional), null);
    const [next] = getRuntimeExecutionTimeline(settledOwner).turns;
    assert.equal(next.id, prior);
    assert.equal(next.sessionId, 'new-native');
    assert.equal(next.input.attachments.length, 1);
  });

  const checkpoint = async (scope, entries, leafId) => readExecutionBranch({
    scope, branchEpoch: 3, isCurrent: () => true, readState: () => ({ sessionId: 'native' }),
    readEntries: () => ({ entries, leafId }),
  });
  const nativeRows = [{ ...native[0] }, ...native.slice(1).map(entry => entry.message.role === 'toolResult'
    ? { ...entry, message: { ...entry.message, toolName: { A: 'read', B: 'grep', P: 'gui_plan' }[entry.message.toolCallId] } }
    : entry)];
  for (const [index, scope] of [classic, runtime].entries()) {
    const program = programs[index];
    const [turn] = program.snapshot().turns;
    const before = await checkpoint(scope, [], null);
    const after = await checkpoint(scope, [...nativeRows, { type: 'message', id: 'other-branch', parentId: 'e0', message: answer }], 'e6');
    const witnesses = program.nativeWitnesses(turn.id);
    const proof = bindExecutionEntries(after, { checkpoint: before, messages: witnesses });
    check(scope.kind + ' native parent chain ignores physical tail and certifies only provable aliases', () => {
      assert.equal(after.leafId, 'e6');
      assert.deepEqual(proof.aliases, witnesses.slice(0, 3).map(({ id }, i) => ({ from: id, to: ['e0', 'e1', 'e4'][i] })));
      assert.equal(proof.partial, true);
      assert.equal(proof.results.length, 3);
      // The caller only has a partial witness, so this cannot certify a cut.
      assert.equal(program.mergeHistory({ scope, branch: proof.branch, aliases: proof.aliases,
        verified: false, turns: [], coveredThrough: program.cursor() }), true);
      assert.equal(program.snapshot().turns[0].id, turn.id);
    });
  }

  for (const scope of [classic, runtime]) {
    const editedInput = message('user', [text('Edited version')]);
    const editScope = { ...scope, branchEpoch: 3 };
    const program = drive(editScope, [
      { type: 'agent_start' }, start(editedInput), end(editedInput), start(answer), end(answer), settle,
      { ...submitting('edit-transaction'), editOf: 'e0' },
      { type: 'message_edit', state: 'accepted', sessionId: 'native', requestId: 'edit-transaction',
        targetEntryId: 'e0', newEntryId: 'replacement' },
      submitting('next'), start(firstInput), end(firstInput), settle,
    ]);
    const [turn, next] = program.snapshot().turns;
    const before = await checkpoint(editScope, [], null);
    const after = await checkpoint(editScope, [
      { type: 'message', id: 'e0', parentId: null, message: firstInput },
      { type: 'message', id: 'replacement', parentId: null, message: editedInput },
      { type: 'message', id: 'reply', parentId: 'replacement', message: answer },
    ], 'reply');
    check(scope.kind + ' edit transaction receipt attaches to the one native user echo even after settle', () => {
      assert.equal(turn.input.nativeEntryId, 'replacement');
      assert.equal(next.input.nativeEntryId, undefined);
      const evidence = bindExecutionEntries(after, { checkpoint: before, messages: program.nativeWitnesses(turn.id) });
      assert.deepEqual(evidence.aliases, [{ from: turn.input.id, to: 'replacement' }]);
    });
  }

  check('Classic transport gaps cannot fold another submission into the last open task', () => {
    const stream = drive(classic, [submitting('p1'), start(firstInput)]);
    stream.loseCoverage();
    stream.observe(submitting('p2'), { sequence: 11 });
    stream.observe(start(firstInput), { sequence: 12 });
    const turns = stream.snapshot().turns;
    assert.equal(turns.length, 2);
    assert.equal(turns[0].status, 'unknown');
    assert.equal(turns[0].completeness, 'partial');
    assert.equal(turns[0].additionalInputs.length, 0);
  });
  check('A recovered edit receipt without matching prompt acknowledgement remains partial', () => {
    const state = drive({ ...classic, branchEpoch: 9 }, [
      start(firstInput), end(firstInput), start(answer), end(answer), settle,
      { type: 'message_edit', state: 'accepted', sessionId: 'native', requestId: 'lost-edit-response',
        targetEntryId: 'old', newEntryId: 'replacement' },
    ]).snapshot();
    assert.equal(state.turns.length, 1);
    assert.equal(state.turns[0].completeness, 'partial');
    assert.equal(state.turns[0].input.nativeEntryId, undefined);
  });

  const { runExecutionTimelineModelUnit } = await import('./fixtures/session-ux-p5-model-unit.mjs');
  const { runBackendUnit } = await import('./fixtures/session-ux-p5-backend-unit.mjs');
  const modelChecks = runExecutionTimelineModelUnit();
  const backendChecks = await runBackendUnit();
  if (process.argv.includes('--json')) console.log(JSON.stringify(output, null, 2));
  return { adapterGroups: checks.length, modelAssertions: modelChecks, backendGroups: backendChecks };
}

if (require.main === module) main().then(count => console.log('P5-A: ' + JSON.stringify(count)))
  .catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main, scenario, native, classic, runtime };
