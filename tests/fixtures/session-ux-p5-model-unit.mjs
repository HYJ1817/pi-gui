import assert from 'node:assert/strict';
import { createExecutionTimeline } from '../../public/execution-timeline-model.js';

const scope = {
  kind: 'runtime',
  owner: {
    backendInstance: 'backend', projectId: 'project', repoId: 'repo', workspaceId: 'workspace',
    workspaceEpoch: 8, conversationId: 'conversation', runtimeId: 'runtime',
    runtimeGeneration: 'generation', sessionId: 'session',
  },
};

const position = (sequence, part = 0) => ({ domain: 'live', stream: 'generation', sequence, part });
const message = id => ({ id, content: { id: 'ref-' + id, source: 'live-buffer', state: 'available' } });
const timing = (startedAt, endedAt = null) => ({
  startedAt, endedAt, durationMs: endedAt === null ? null : endedAt - startedAt, evidence: 'observed',
});
function event(sequence, fact, overrides = {}) {
  return { scope, turnId: 'turn', eventId: 'event-' + sequence,
    position: position(sequence), observedAt: 100_000 + sequence, fact, ...overrides };
}
const start = (sequence, id, responseId = 'one') => event(sequence, {
  type: 'activity.start',
  item: { id, parentId: 'turn:activity', turnId: 'turn', kind: 'tool', toolName: 'read',
    callId: id, responseId, attemptId: 'first', title: '读取文件', status: 'running',
    childIds: [], timing: timing(100_000 + sequence), args: ['raw-argument'] },
});
const end = (sequence, itemId, status = 'completed') => event(sequence, {
  type: 'activity.update',
  itemId,
  patch: { status, summary: { hitCount: 2, rawOutput: 'raw-output' }, rawOutput: 'raw-output' },
});
const part = (messageId, sequence, text) => ({
  id: messageId + ':part:0', message: message(messageId), partIndices: [0], position: position(sequence),
  kind: 'progress-text', text,
});
const close = (sequence, responseId, stopReason, parts, fields = { output: 0 }) => event(sequence, {
  type: 'message.end', responseId, stopReason, parts,
  usage: { responseId, position: position(sequence), recorded: fields },
});

export function runExecutionTimelineModelUnit() {
  let count = 0;
  const equal = (actual, expected, explanation) => {
    assert.deepEqual(actual, expected, explanation);
    count++;
  };
  const get = () => createExecutionTimeline(scope);
  const open = event(1, { type: 'turn.open', submissionId: 'submit-1', input: message('optimistic') });

  const timeline = get();
  equal(timeline.apply(open), true, 'opens an accepted submission');
  equal(timeline.apply(open), false, 'drops duplicate event identity');
  equal(timeline.apply(event(2, { type: 'turn.input', role: 'initial', input: message('user-entry') })), true);
  timeline.apply(event(3, { type: 'turn.input', role: 'additional', input: message('steering') }));
  timeline.apply(event(4, { type: 'attempt', attempt: {
    id: 'first', kind: 'initial', status: 'running', timing: timing(100_004),
  } }));
  timeline.apply(event(5, { type: 'message.start', message: message('one') }));
  const delta = event(6, { type: 'message.delta', responseId: 'one', kind: 'text', partIndex: 0, delta: '暂定', truncated: true });
  timeline.apply(delta);
  timeline.apply(delta);
  const streamed = timeline.snapshot().turns[0].parts[0];
  equal(streamed.text, '暂定', 'does not append duplicate deltas');
  equal(streamed.truncated, true, 'retains upstream delta truncation');
  timeline.apply(close(7, 'one', 'toolUse', [part('one', 7, '过程说明')], { input: 9, totalTokens: 14, raw: 44 }));
  equal(timeline.snapshot().turns[0].parts[0].id, streamed.id, 'turn completion preserves the streamed part key');
  timeline.apply(start(8, 'a'));
  timeline.apply(start(9, 'b'));
  timeline.apply(end(10, 'b'));
  equal(timeline.snapshot().groups[0].activeItemId, 'a', 'the latest remaining active item leads');
  timeline.apply(end(11, 'a', 'failed'));
  timeline.apply(event(8, { type: 'activity.update', itemId: 'a', patch: { status: 'running' } }, { eventId: 'stale-update' }));
  timeline.apply(event(12, { type: 'message.start', message: message('plan-only') }));
  timeline.apply(close(13, 'plan-only', 'toolUse', []));
  timeline.apply(event(14, { type: 'message.start', message: message('answer') }));
  timeline.apply(close(15, 'answer', 'stop', [part('answer', 15, '权威答复')]));
  timeline.apply(event(16, { type: 'turn.settle', status: 'completed' }));

  const snapshot = timeline.snapshot();
  equal(snapshot.turns[0].input.id, 'user-entry', 'authority echoes replace optimistic input');
  equal(snapshot.turns[0].additionalInputs.map(input => input.id), ['steering']);
  equal(snapshot.turns[0].parts.map(p => [p.kind, p.text]), [['progress-text', '过程说明'], ['answer', '权威答复']]);
  equal(snapshot.turns[0].usage.map(row => [row.responseId, row.recorded]), [
    ['one', { input: 9, totalTokens: 14 }], ['plan-only', { output: 0 }], ['answer', { output: 0 }],
  ], 'plan-only usage and real zero survive, unsupported fields are dropped');
  equal(snapshot.groups[0].itemIds, ['a', 'b'], 'completion order does not change start order');
  equal(snapshot.groups[0].activeItemId, null);
  equal(snapshot.items.map(item => item.status), ['failed', 'completed'], 'stale update cannot revive terminal activity');
  equal(snapshot.items[0].summary, { hitCount: 2 });
  equal(JSON.stringify(snapshot).includes('raw-output') || JSON.stringify(snapshot).includes('raw-argument'), false);
  snapshot.turns[0].input.id = 'mutation';
  equal(timeline.snapshot().turns[0].input.id, 'user-entry', 'snapshot is detached');
  equal(timeline.apply(event(17, { type: 'turn.settle', status: 'failed' })), false, 'terminal turn cannot be reopened by another settle');
  equal(timeline.apply(event(18, { type: 'turn.open', submissionId: 'submit-2', input: message('user-entry') },
    { turnId: 'turn-two' })), true, 'identical message content does not deduplicate distinct submissions');

  const planTimeline = get();
  planTimeline.apply(open);
  const plan = (sequence, callId, state, revision, status, sourceTurnId = 'ext-turn') =>
    event(sequence, { type: 'plan', state, callId, plan: state === 'rejected' ? null : {
      revision, sourceTurnId, state: state === 'proposed' ? 'provisional' : 'confirmed',
      items: [{ producerId: 'step', title: '核对', status }],
    } });
  planTimeline.apply(plan(2, 'p1', 'applied', 2, 'pending'));
  planTimeline.apply(plan(3, 'p2', 'proposed', null, 'in_progress'));
  equal(planTimeline.snapshot().turns[0].plan.state, 'provisional');
  planTimeline.apply(plan(4, 'p2', 'rejected', null, 'in_progress'));
  equal(planTimeline.snapshot().turns[0].plan.items[0].status, 'pending');
  planTimeline.apply(plan(5, 'p3', 'applied', 3, 'in_progress'));
  planTimeline.apply(plan(6, 'p0', 'applied', 1, 'completed'));
  planTimeline.apply(event(7, { type: 'turn.settle', status: 'cancelled' }));
  equal(planTimeline.snapshot().turns[0].plan.revision, 3);
  equal(planTimeline.snapshot().turns[0].plan.state, 'stalled');
  equal(planTimeline.snapshot().turns[0].plan.items[0].status, 'in_progress', 'does not fabricate plan outcome');

  const unsettled = get();
  unsettled.apply(open);
  unsettled.apply(start(2, 'a'));
  unsettled.apply(event(3, { type: 'message.start', message: message('failed') }));
  unsettled.apply(close(4, 'failed', 'error', [part('failed', 4, '可见未完成答复')]));
  unsettled.apply(event(5, { type: 'turn.settle', status: 'interrupted' }));
  equal(unsettled.snapshot().items[0].status, 'interrupted');
  equal(unsettled.snapshot().turns[0].parts[0].kind, 'partial-answer');

  const provisional = { ...scope, owner: { ...scope.owner, sessionId: null } };
  const other = { ...scope, owner: { ...scope.owner, sessionId: 'other' } };
  const checkpoint = createExecutionTimeline(provisional);
  checkpoint.apply({ ...open, scope: provisional });
  const promotion = event(2, { type: 'turn.input', role: 'initial', input: message('native') });
  equal(checkpoint.apply(promotion), false, 'unwitnessed session promotion is rejected');
  equal(checkpoint.apply({ ...promotion, previousScope: provisional }), true, 'witness promotes the same owner');
  equal(checkpoint.apply({ ...promotion, scope: other, previousScope: scope, eventId: 'bad' }), false);
  equal(checkpoint.snapshot().turns[0].sessionId, scope.owner.sessionId);

  const retained = get();
  retained.apply(open);
  retained.apply(start(2, 'a'));
  retained.apply(end(12, 'a'));
  const history = {
    scope, branch: { leafId: 'leaf' }, coveredThrough: 8, verified: true, completeness: 'complete',
    aliases: [{ from: 'turn', to: 'native-turn' }, { from: 'a', to: 'native-call' }],
    turns: [], groups: [], items: [],
  };
  equal(retained.mergeHistory(history), true, 'witnessed alias promotion preserves newer live state');
  equal(retained.snapshot().turns.map(turn => turn.id), ['native-turn']);
  equal(retained.snapshot().groups[0].itemIds, ['native-call']);
  equal(retained.snapshot().items[0].status, 'completed');
  equal(retained.apply(end(13, 'a', 'running')), false, 'late terminal regression rejected through alias');
  equal(retained.mergeHistory({ ...history, scope: other }), false, 'different scope cannot change history');
  equal(retained.mergeHistory({ ...history, verified: false, aliases: [{ from: 'native-turn', to: 'wrong' }] }), true);
  equal(retained.snapshot().turns[0].id, 'native-turn', 'partial read cannot remap known keys');
  equal(retained.snapshot().completeness, 'partial');

  const currentBranch = { ...scope, branchEpoch: 4 };
  const oldBranch = { ...scope, branchEpoch: 3 };
  const branched = createExecutionTimeline(currentBranch);
  equal(branched.apply({ ...open, scope: oldBranch }), false, 'edit branch rejects old live events');
  equal(branched.mergeHistory({ ...history, scope: oldBranch }), false, 'edit branch rejects old cuts');
  equal(branched.apply({ ...open, scope: currentBranch }), true);
  equal(branched.snapshot().scope.branchEpoch, 4);

  const running = get();
  running.apply(open);
  running.apply(start(2, 'a'));
  running.apply(event(3, { type: 'activity.update', itemId: 'a', patch: {
    status: 'completed', timing: { durationMs: 0.725, evidence: 'recorded' },
  } }));
  equal(running.snapshot().items[0].timing.durationMs, 0.725, 'retains fractional elapsed time reported by Pi');
  equal(running.snapshot().groups[0].timing.endedAt, null, 'active agent keeps the group clock alive through tool gaps');
  equal(running.snapshot().groups[0].status, 'running');
  running.apply(event(4, { type: 'turn.settle', status: 'completed' }));
  equal(running.snapshot().groups[0].timing.endedAt, 100_004, 'settled group freezes its clock');
  running.apply(event(5, { type: 'attempt', attempt: {
    id: 'fallback', kind: 'fallback', status: 'running', timing: timing(100_005),
  } }));
  equal(running.snapshot().turns[0].status, 'running');
  equal(running.snapshot().turns[0].input.id, 'optimistic');

  const cutSnapshot = get();
  cutSnapshot.apply(open);
  cutSnapshot.apply(start(2, 'a'));
  cutSnapshot.apply(end(3, 'a'));
  cutSnapshot.apply(event(4, { type: 'turn.settle', status: 'completed' }));
  const cutPosition = { domain: 'history', stream: 'leaf', sequence: 1, part: 0 };
  const live = cutSnapshot.snapshot();
  const recovered = { ...history, aliases: [], turns: live.turns.map(turn => ({ ...turn, position: cutPosition })),
    groups: live.groups, items: live.items.map(item => ({ ...item, position: cutPosition, title: 'native title' })) };
  equal(cutSnapshot.mergeHistory(recovered), true);
  equal(cutSnapshot.snapshot().items[0].title, 'native title', 'certified history can replace a covered terminal item');
  equal(cutSnapshot.mergeHistory({ ...recovered, branch: { leafId: 'other-leaf' }, verified: false }), false,
    'uncertified cut from another leaf cannot join a known branch');
  const userText = get();
  userText.apply(event(1, { type: 'turn.open', submissionId: 'message',
    input: { ...message('native-message'), preview: { text: '请求正文', truncated: false }, raw: 'never show' } }));
  equal(userText.snapshot().turns[0].input.preview, { text: '请求正文', truncated: false });
  equal(userText.snapshot().turns[0].input.raw, undefined);
  for (let i = 2; i < 76; i++) {
    userText.apply(event(i, { type: 'turn.input', role: 'additional',
      input: { ...message('extra-' + i), preview: { text: 'x'.repeat(18_000), truncated: false } } }));
  }
  const boundedInput = userText.snapshot();
  const previews = [boundedInput.turns[0].input, ...boundedInput.turns[0].additionalInputs].map(input => input.preview);
  equal(previews.every(preview => preview.text.length <= 16 * 1024), true);
  equal(previews.reduce((total, preview) => total + preview.text.length, 0) <= 1024 * 1024, true);
  equal(boundedInput.completeness, 'partial');
  const subtasks = get();
  subtasks.apply(open);
  subtasks.apply(start(2, 'parent'));
  subtasks.apply(event(3, { type: 'activity.update', itemId: 'parent', patch: { summary: { children: [
    { id: 'sub-1', status: 'stopped', model: 'real-model' },
    { id: 'sub-2', status: 'detached', model: 'other-model' },
    { id: 'unknown', status: 'invented', model: 'no-model' },
  ] } } }));
  equal(subtasks.snapshot().items[0].summary.children, [
    { id: 'sub-1', status: 'stopped', model: 'real-model' },
    { id: 'sub-2', status: 'detached', model: 'other-model' },
  ], 'preserves already-validated child states and model names');
  const coverageBudget = get();
  for (let i = 0; i < 3; i++) {
    const turnId = 'batch-' + i;
    const sequence = 100 * (i + 1);
    coverageBudget.apply(event(sequence, { type: 'turn.open', submissionId: turnId }, { turnId }));
    for (let j = 1; j <= 85; j++) {
      const responseId = turnId + ':response:' + j;
      const positionIndex = sequence + j;
      coverageBudget.apply({ ...close(positionIndex, responseId, 'stop', [
        part(responseId, positionIndex, 'small retained response'),
      ]), turnId });
    }
    coverageBudget.apply(event(sequence + 86, { type: 'turn.settle', status: 'completed' }, { turnId }));
  }
  const boundedResponses = coverageBudget.snapshot();
  equal(boundedResponses.turns.reduce((total, turn) => total + turn.usage.length, 0), 240,
    'response metadata is bounded across turns');
  equal(boundedResponses.turns[2].usage.length, 85, 'trimming preserves the newest response facts');
  equal(boundedResponses.completeness, 'partial', 'metadata eviction is visible');
  return count;
}
