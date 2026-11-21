'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const owner = id => ({ backendInstance: 'backend-p5c', projectId: 'project', repoId: 'repo',
  workspaceId: 'workspace-' + id, workspaceEpoch: '1', conversationId: id,
  runtimeId: 'runtime-' + id, runtimeGeneration: 'generation', sessionId: 'session-' + id });
const locator = o => ({ conversationId: o.conversationId, nativeSessionId: o.sessionId,
  projectId: o.projectId, workspaceId: o.workspaceId, workspaceEpoch: o.workspaceEpoch });
const liveItem = (o, branchEpoch = 1) => ({ conversationId: o.conversationId, owner: o, lifecycle: 'ready', activity: 'idle',
  nativeSessionId: o.sessionId, workspace: locator(o), revision: branchEpoch,
  execution: { branchEpoch, startSequence: 0, observedAt: 1000 } });
const dormant = o => ({ ...liveItem(o), owner: null, lifecycle: 'dormant' });
const frame = (o, sequence, event) => ({ type: 'runtime_event', owner: o, eventSequence: sequence,
  execution: { branchEpoch: 1, startSequence: 0, observedAt: 1000 + sequence }, event });
const packet = (o, { cursor = 0, branchEpoch = 1, malformed = false } = {}) => {
  const id = o.conversationId;
  const timeline = [
    { id: 'h4', kind: 'user', messageId: id + '-user', userIndex: 0, text: id + ' task' },
    { id: 'h5', kind: 'assistant', messageId: id + '-progress', text: id + ' progress', state: 'complete' },
    { id: 'h6', kind: 'user', messageId: id + '-supplement', userIndex: 1, text: id + ' follow-up' },
    { id: 'h7', kind: 'assistant', messageId: id + '-answer', text: '**' + id + ' answer**', state: 'complete' },
  ];
  const messages = timeline.map(block => ({ role: block.kind, messageId: block.messageId, userIndex: block.userIndex, text: block.text }));
  const timing = { startedAt: 900, endedAt: 1000, durationMs: 100, evidence: 'observed' };
  return { ok: true, owner: o, sessionId: o.sessionId, cursor, branchEpoch, locator: locator(o), messages,
    execution: { timeline, truncated: false, p5: {
      version: 1, sessionId: o.sessionId, leafId: id + '-answer', completeness: 'complete', turns: [{
        id: id + '-turn', sessionId: o.sessionId, status: 'completed', timing, completeness: 'complete',
        input: { id: id + '-user', userIndex: 0 },
        additionalInputs: [{ id: id + '-supplement', userIndex: 1 }],
        usage: [{ responseId: id + '-answer', recorded: { input: 0, output: 4, totalTokens: 4 }, model: { id: 'history-model' } }],
        finalResponseId: id + '-answer', blockIds: malformed ? ['h4', 'h9', 'h7'] : timeline.map(block => block.id),
        from: 0, through: 3, entryIds: timeline.map(block => block.messageId), items: [],
      }],
    } } };
};

const defer = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function nativePacket(project, o) {
  const id = o.conversationId;
  const leafId = id + '-answer';
  const textPart = text => ({ type: 'text', text });
  const rows = [
    [id + '-user', { role: 'user', content: [textPart(id + ' task')] }],
    [id + '-progress', { role: 'assistant', stopReason: 'toolUse', content: [textPart(id + ' progress'),
      { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'src/note.js', secret: 'RAW_ARGS_SENTINEL' } }],
    usage: { input: 0, output: 2 }, model: 'first-model' }],
    [id + '-tool', { role: 'toolResult', content: [textPart('RAW_RESULT_SENTINEL')],
      toolCallId: 'call', toolName: 'read', isError: false }],
    [id + '-supplement', { role: 'user', content: [textPart(id + ' follow-up')] }],
    [leafId, { role: 'assistant', stopReason: 'stop', content: [textPart('**' + id + ' answer**')],
      usage: { input: 0, output: 4 }, model: 'final-model' }],
  ];
  const entries = rows.map(([entryId, message], index) => ({ type: 'message', id: entryId, message,
    parentId: index ? rows[index - 1][0] : null }));
  const checkpoint = {
    inputId: entries[0].id, beforeLeafId: null, leafId, status: 'completed', finalResponseId: leafId,
    timing: { startedAt: 10, endedAt: 40 },
    entries: entries.map(entry => ({ id: entry.id, role: entry.message.role })),
    tools: [{ callId: 'call', responseId: id + '-progress', resultId: id + '-tool',
      startedAt: 12, endedAt: 15, durationMs: 3, status: 'completed' }],
  };
  const history = project(entries, [checkpoint], { sessionId: o.sessionId, leafId });
  assert.ok(history, 'fixture uses the production native history projection');
  return { ...history, locator: locator(o), owner: o, branchEpoch: 1, cursor: 0 };
}

test('history view groups authorized blocks, reveals precise search hits, and fences switching requests', async t => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document;
  for (const key of ['window', 'document', 'localStorage', 'HTMLElement', 'Event', 'CustomEvent',
    'Node', 'MutationObserver']) global[key] = key === 'window' ? w : w[key];
  global.requestAnimationFrame = w.requestAnimationFrame.bind(w);
  global.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
  const { createRuntimeConversation } = await import('../public/runtime-conversation.js');
  const { seedRuntimeSnapshot, observeRuntimeFrame, runtimeStore, refreshRuntimeViews } = await import('../public/runtime-state.js');
  const { projectExecutionHistory } = await import('../server/execution-timeline-history.js');
  const a = owner('A'), b = owner('B'), c = owner('C'), live = owner('R');
  seedRuntimeSnapshot({ backendInstance: a.backendInstance, items: [dormant(a), dormant(b), dormant(c), liveItem(live)] });
  const requests = new Map();
  const edits = [];
  global.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    if (body?.action?.startsWith('edit-')) edits.push(body);
    if (body?.action === 'edit-preflight') return { ok: true, json: async () => ({
      ok: true, canEdit: true, sessionId: live.sessionId, text: 'R task', hasImages: false,
      entryId: 'wrong-identical-native-entry', parentId: null, leafId: 'R-answer',
    }) };
    const target = new URL(url, 'http://fixture.invalid').searchParams.get('conversationId');
    if (!target) return { ok: true, json: async () => ({ ok: true }) };
    const response = defer();
    requests.set(target, response);
    return { ok: true, json: () => response.promise };
  };
  const host = d.createElement('div');
  d.body.append(host);
  const view = createRuntimeConversation({ host });
  t.after(() => { view.dispose(); w.close(); });
  const output = view.element.querySelector('.rtc-output');
  Object.defineProperties(output, { scrollHeight: { value: 2400 }, clientHeight: { value: 400 } });
  output.getBoundingClientRect = () => ({ top: 0, height: 400 });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return { top: this.closest('[hidden]') ? 0 : 720 - output.scrollTop, height: 20 };
  };

  const readingA = view.openHistory(locator(a), { messageId: 'A-progress' });
  const readingB = view.openHistory(locator(b), { messageId: 'B-answer' });
  requests.get('B').resolve(nativePacket(projectExecutionHistory, b));
  assert.equal(await readingB, true);
  const bTurn = output.querySelector('.execution-turn');
  assert.ok(bTurn, 'authorized native blocks become the shared Timeline');
  assert.match(bTurn.querySelector('[data-execution-part="answer"]').textContent, /B answer/);
  assert.equal(output.dataset.historyMatchState, 'found');
  bTurn.querySelector('.execution-activity-group button').click();
  bTurn.querySelector('.execution-activity-item button').click();
  assert.match(bTurn.querySelector('.execution-activity-item').textContent, /note\.js|读取文件/);
  assert.match(bTurn.querySelector('.execution-activity-item').textContent, /无权读取详情/);
  assert.doesNotMatch(bTurn.innerHTML, /RAW_ARGS_SENTINEL|RAW_RESULT_SENTINEL/);
  assert.equal(bTurn.querySelectorAll('.execution-usage-entry').length, 2);
  assert.equal(bTurn.querySelectorAll('.ui2-msg-meta').length, 2, 'history ledger retains both recorded rows without duplicates');
  requests.get('A').resolve(packet(a));
  assert.equal(await readingA, false);
  assert.equal(output.querySelector('.execution-turn'), bTurn, 'late A history cannot write into B');
  assert.doesNotMatch(output.textContent, /A task/);

  view.show(a.conversationId);
  const aTurn = output.querySelector('.execution-turn');
  const aProgress = aTurn?.querySelector('[data-execution-part="progress"]');
  const target = aProgress?.querySelector('[data-history-message-id="A-progress"]');
  assert.ok(target && !target.closest('[hidden]'), 'search opens the folded ancestor before measuring');
  assert.equal(target.dataset.historyScrolled, 'true');
  assert.equal(output.dataset.historyMatchState, 'found');
  assert.equal(output.scrollTop, 530);
  assert.equal(aTurn.querySelectorAll('.turn-outcome').length, 1, 'supplemental input did not make a second outcome');
  const usageControl = turn => turn.querySelector('[data-execution-part="usage"] button.execution-head');
  usageControl(aTurn).click();
  output.scrollTop = 610;
  view.show(b.conversationId);
  assert.equal(usageControl(bTurn).getAttribute('aria-expanded'), 'false');
  view.show(a.conversationId);
  assert.equal(output.scrollTop, 610, 'returning to the same read-only history preserves the resulting reading position');
  const reopeningA = view.openHistory(locator(a), { messageId: 'A-answer' });
  requests.get('A').resolve(packet(a));
  assert.equal(await reopeningA, true);
  const rebuiltA = output.querySelector('.execution-turn');
  assert.notEqual(rebuiltA, aTurn);
  assert.equal(usageControl(rebuiltA).getAttribute('aria-expanded'), 'true', 'explicit choice survives rebuilding the same native cut');

  const readingC = view.openHistory(locator(c), { messageId: 'C-progress' });
  requests.get('C').resolve(packet(c, { malformed: true }));
  assert.equal(await readingC, true);
  assert.equal(output.querySelector('.execution-turn'), null);
  assert.equal(output.dataset.historyMatchState, 'found', 'an unproven ID range uses the legacy reader');

  view.show(live.conversationId);
  const imageOnly = packet(live);
  imageOnly.execution.timeline[0] = { ...imageOnly.execution.timeline[0], text: '', hasImages: true };
  assert.equal(runtimeStore.recoverExecutionHistory(runtimeStore.get(live.conversationId),
    { owner: live, cursor: 0, branchEpoch: 1 }, imageOnly), true);
  refreshRuntimeViews();
  const oldUser = output.querySelector('[data-history-message-id="R-user"]');
  const unavailable = oldUser?.querySelector('.msg-att-chips');
  assert.equal(unavailable?.hidden, false, 'image-only native input holds its position and announces an unavailable attachment');
  assert.equal(oldUser.querySelector('img'), null);

  const newerCut = packet(live);
  newerCut.execution.timeline[0].userIndex = newerCut.execution.p5.turns[0].input.userIndex = 2;
  newerCut.execution.timeline[2].userIndex = newerCut.execution.p5.turns[0].additionalInputs[0].userIndex = 3;
  assert.equal(runtimeStore.recoverExecutionHistory(runtimeStore.get(live.conversationId),
    { owner: live, cursor: 0, branchEpoch: 1 }, newerCut), true);
  refreshRuntimeViews();
  const newUser = output.querySelector('[data-history-message-id="R-user"]');
  assert.notEqual(newUser, oldUser, 'a new accepted native cut rebuilds stale bindings even on the same Runtime record');
  assert.equal(newUser.dataset.historyUserIndex, '2');
  const recovered = output.querySelector('.execution-turn');
  assert.ok(recovered);
  assert.equal(recovered.querySelector('.message-edit')?.hidden, false);
  newUser.querySelector('.message-edit').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(newUser.querySelector('.message-edit-status')?.textContent, /会话历史已经变化/);
  newUser.querySelector('.message-edit-submit').click();
  await new Promise(resolve => setImmediate(resolve));
  recovered.querySelector('.message-regenerate').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(edits.map(edit => [edit.action, edit.edit?.kind, edit.edit?.userIndex]),
    [['edit-preflight', 'edit', 2], ['edit-preflight', 'regenerate', 2]],
    'identical text cannot authorize another native edit target');
  const nextUser = { role: 'user', content: 'new live task' };
  for (const [i, event] of [
    { type: 'message_start', message: nextUser }, { type: 'message_end', message: nextUser }, { type: 'agent_start' },
  ].entries()) assert.equal(observeRuntimeFrame(frame(live, i + 1, event)), true);
  assert.equal(output.querySelectorAll('.execution-turn').length, 2);
  assert.equal(output.querySelector('.execution-turn'), recovered);
  assert.match(output.textContent, /R answer/);
  assert.match(output.textContent, /new live task/);
});

test('reconnect settles only the captured idle generation, cursor and branch', async () => {
  const { createRuntimeRecovery } = await import('../public/runtime-recovery.js');
  const { createRuntimeStore } = await import('../public/runtime-store.js');
  for (const race of ['equal', 'newer-cursor', 'newer-branch', 'foreign', 'approval',
    'oversized-frame', 'missed-settle', 'structured-cut-rejected', 'legacy-cut-advanced']) {
    const current = owner('reload-' + race);
    const store = createRuntimeStore();
    const initial = liveItem(current);
    const serverCursor = ['oversized-frame', 'missed-settle', 'structured-cut-rejected', 'legacy-cut-advanced'].includes(race) ? 2 : 0;
    const legacy = ['structured-cut-rejected', 'legacy-cut-advanced'].includes(race);
    let reads = 0;
    store.seed({ backendInstance: current.backendInstance, items: [initial] });
    if (race === 'missed-settle') store.apply(frame(current, 1, { type: 'agent_start' }));
    const request = defer();
    const response = defer();
    const recover = createRuntimeRecovery({ store, seed: snapshot => store.seed(snapshot), observe: f => store.apply(f),
      readSnapshot: async () => ({ ok: true, backendInstance: current.backendInstance, items: [initial] }),
      read: async args => {
        if (args.action === 'events') return { ok: true, owner: current,
          cursor: serverCursor + (race === 'legacy-cut-advanced' && reads++ > 0 ? 1 : 0),
          events: [], approvals: [], item: initial, historyRequired: serverCursor > 0 };
        if (args.action === 'execution-history') { request.resolve(); return response.promise; }
        if (args.action === 'read' && legacy) return { ok: true, data: { messages: [{ role: 'user', content: 'legacy stable' }] } };
        throw new Error('unexpected request ' + args.action);
      } });
    const pending = recover();
    const requested = await Promise.race([request.promise.then(() => true), pending.then(() => false)]);
    assert.ok(requested, 'P5 reconnect requests owner-scoped branch history');
    if (race === 'newer-cursor') store.apply(frame(current, 1, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'live wins' } }));
    if (race === 'newer-branch') store.seed({ backendInstance: current.backendInstance, items: [liveItem(current, 2)] });
    if (race === 'approval') store.reconcileApprovals(current, [{ id: 'approval', method: 'confirm', title: 'still pending' }], 0);
    response.resolve(packet(race === 'foreign' ? owner('foreign') : current, { cursor: legacy ? serverCursor + 1 : serverCursor }));
    await pending;
    const record = store.get(current.conversationId);
    if (['equal', 'oversized-frame', 'missed-settle'].includes(race)) {
      assert.match(record.text, new RegExp('reload-' + race + ' task'));
      assert.equal(record.timeline[0].id, 'h4', 'server block alignment survives the store commit');
      assert.equal(record.cursor, serverCursor);
    } else {
      assert.doesNotMatch(record.text, /answer/);
    }
    if (race === 'newer-cursor') assert.equal(record.text, 'live wins');
    if (race === 'approval') assert.equal(record.approvals[0]?.id, 'approval');
    if (race === 'structured-cut-rejected') assert.equal(record.text, 'legacy stable');
    if (race === 'legacy-cut-advanced') assert.equal(record.text, '');
  }
});
