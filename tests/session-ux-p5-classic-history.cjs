'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const sessionId = 'native-history-A';
const owner = { backendInstance: 'backend', projectId: 'project', repoId: null, workspaceId: 'work',
  workspaceEpoch: '1', conversationId: 'classic-chat', runtimeId: 'bridge', runtimeGeneration: '1', sessionId };
const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
const answer = text => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' });
const usage = { input: 0, output: 3, totalTokens: 3 };
const toolId = 'p5c-read';
const progress = { role: 'assistant', stopReason: 'toolUse', usage, model: 'fixture-model',
  content: [{ type: 'text', text: 'Start checking' }, { type: 'toolCall', id: toolId, name: 'read',
    arguments: { path: 'fixture.txt' } }] };
const result = { role: 'toolResult', toolCallId: toolId, toolName: 'read', isError: false,
  content: [{ type: 'text', text: 'Real native output fixture' }] };
const timing = { startedAt: 10, endedAt: 30, durationMs: 20, evidence: 'recorded' };
const record = {
  id: 'native-turn-verified', sessionId, status: 'completed', completeness: 'complete',
  input: { id: 'input', userIndex: 1 }, additionalInputs: [{ id: 'steer', userIndex: 2 }],
  usage: [{ responseId: 'progress', model: { id: 'fixture-model' }, recorded: usage }],
  finalResponseId: 'final', from: 2, through: 6,
  entryIds: ['input', 'progress', 'result', 'steer', 'final'], timing,
  group: { id: 'group', turnId: 'native-turn-verified', status: 'completed', timing },
  items: [{ id: 'item', callId: toolId, turnId: 'native-turn-verified', parentId: 'group', status: 'completed',
    position: { domain: 'history', index: 3, sequence: 3, part: 0 }, title: '读取 fixture.txt', toolName: 'read', timing }],
};
const messages = [user('Unindexed legacy question'), answer('Legacy answer'), user('Verified task'),
  progress, result, user('Supplemental detail'), answer('**Verified answer**'), user('Unsettled tail')];
messages[2].content.push({ type: 'image', mimeType: 'image/png', data: 'aW1n' });
const history = {
  ok: true, owner, branchEpoch: 0, sessionId, messages,
  execution: { p5: { version: 1, sessionId, leafId: 'authoritative-leaf', completeness: 'partial', turns: [record] } },
};

test('Classic mounts only owned history, keeps native tools, ordinals, answer and anchors', async t => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', pretendToBeVisual: true,
  });
  const w = dom.window;
  for (const key of ['window', 'document', 'localStorage', 'HTMLElement', 'Event', 'CustomEvent', 'Node', 'MutationObserver']) {
    global[key] = key === 'window' ? w : w[key];
  }
  global.requestAnimationFrame = w.requestAnimationFrame.bind(w);
  global.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  t.after(() => w.close());
  const { clearThread, onMessageStart, rebuildFromMessages, waitForClassicRenderIdle } = await import('../public/messages.js');
  const { classicNativeThreadChildren } = await import('../public/classic-execution-view.js');
  const { scrollToUserTurn } = await import('../public/conversation-nav.js');
  const { S } = await import('../public/state.js');
  const { observeClassicExecution } = await import('../public/execution-timeline-state.js');
  const { boot, onResponse, recoverClassicExecutionHistory } = await import('../public/rpc.js');
  t.after(clearThread);
  Object.assign(S, { legacyOwner: owner, bridgeInstance: owner.runtimeId, bridgeRun: 1, bridgeState: 'ready',
    workspaceGeneration: 1, state: { sessionId } });
  observeClassicExecution({ type: 'response', command: 'get_state', success: true, _seq: 1,
    legacyOwner: owner, executionClassic: { branchEpoch: 0, sessionId } });

  rebuildFromMessages(history, sessionId);
  const turn = S.thread.querySelector('[data-execution-turn="native-turn-verified"]');
  assert.ok(turn, 'a verified native scope mounts the shared history turn');
  assert.equal(S.thread.querySelectorAll(':scope > .msg.user').length, 2);
  assert.equal(turn.querySelectorAll('.msg.user').length, 2);
  assert.ok(turn.querySelector('.msg-att-chip'));
  assert.equal(turn.querySelector('[data-execution-part="answer"] strong').textContent, 'Verified answer');
  assert.equal(turn.querySelectorAll('.message-regenerate').length, 1);
  assert.equal(turn.querySelectorAll('.turn-outcome').length, 1);
  assert.equal(turn.querySelector('.execution-activity-item'), null);
  assert.equal(S.thread.querySelector('pre.tl-out'), null);
  assert.equal(scrollToUserTurn(2), true);
  assert.equal(turn.querySelector('[data-user-index="2"]').closest('[hidden]'), null);
  turn.querySelector('.execution-activity-group > button').click();
  turn.querySelector('.execution-activity-item > button').click();
  assert.equal(turn.querySelector('pre.tl-out').textContent, 'Real native output fixture');
  const legacyNodes = classicNativeThreadChildren(S.thread);
  assert.deepEqual(legacyNodes.filter(node => node.matches('.msg.user')).map(node => node.dataset.userIndex), ['0', '1', '2', '3']);

  rebuildFromMessages(history, 'another-native-session');
  assert.equal(S.thread.querySelector('[data-execution-turn]'), null);
  assert.equal(S.thread.querySelectorAll(':scope > .msg.user').length, 4);
  rebuildFromMessages(history, sessionId);
  assert.equal(S.thread.querySelector('.execution-activity-group > button').getAttribute('aria-expanded'), 'true');
  assert.equal(S.thread.querySelector('.execution-activity-item > button').getAttribute('aria-expanded'), 'true');
  const saved = JSON.parse(w.localStorage.getItem('pi-gui.execution-view.v1'));
  assert.ok(saved.every(([, options]) => options.every(([, expanded]) => typeof expanded === 'boolean')));
  assert.doesNotMatch(JSON.stringify(saved), /Real native output|Supplemental detail/);

  const corrupt = structuredClone(history);
  corrupt.execution.p5.turns[0].entryIds[0] = 'not-the-input';
  rebuildFromMessages(corrupt, sessionId);
  assert.equal(S.thread.querySelector('[data-execution-turn]'), null);
  assert.equal(S.thread.querySelector('strong').textContent, 'Verified answer');

  const requests = [];
  let resolveRead;
  let p5Reads = 0;
  global.fetch = async (url, opts) => {
    if (url === '/api/execution-history') {
      ++p5Reads;
      assert.deepEqual(JSON.parse(opts.body), { owner, branchEpoch: 0 });
      return new Promise(resolve => { resolveRead = resolve; });
    }
    if (url === '/api/command') requests.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ ok: true }) };
  };
  boot();
  const stateRead = requests.find(command => command.type === 'get_state');
  const messageRead = requests.find(command => command.type === 'get_messages');
  const reply = (request, data) => onResponse({
    type: 'response', success: true, id: request.id, command: request.type, data,
  });
  reply(messageRead, { messages });
  reply(stateRead, { sessionId });
  assert.equal(S.thread.querySelector('[data-execution-turn]'), null, 'boot waits for the paired authorized read');
  resolveRead({ ok: true, json: async () => history });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(S.thread.querySelector('[data-execution-turn]'));

  const stale = recoverClassicExecutionHistory();
  onMessageStart({ message: user('New live DOM must survive') });
  resolveRead({ ok: true, json: async () => history });
  assert.equal(await stale, false);
  assert.match(S.thread.textContent, /New live DOM must survive/);
  const currentReads = p5Reads;
  assert.equal(await recoverClassicExecutionHistory(), false, 'mounted live changes require a proven alias before reconnect can replace them');
  assert.equal(p5Reads, currentReads);
  assert.match(S.thread.textContent, /New live DOM must survive/);

  rebuildFromMessages(messages, sessionId);
  const staleBranch = recoverClassicExecutionHistory();
  assert.equal(p5Reads, currentReads + 1);
  observeClassicExecution({ type: 'response', command: 'get_state', success: true, _seq: 2,
    legacyOwner: owner, executionClassic: { branchEpoch: 1, sessionId } });
  resolveRead({ ok: true, json: async () => history });
  assert.equal(await staleBranch, false);
  assert.equal(S.thread.querySelector('[data-execution-turn]'), null);

  const legacyUsers = 401;
  const prefix = Array.from({ length: legacyUsers }, (_, index) => [
    user('Long prefix question ' + index), answer('Long prefix answer ' + index),
  ]).flat();
  const longHistory = structuredClone(history);
  longHistory.messages.unshift(...prefix);
  const [later] = longHistory.execution.p5.turns;
  later.from += prefix.length;
  later.through += prefix.length;
  later.input.userIndex += legacyUsers;
  for (const extra of later.additionalInputs) extra.userIndex += legacyUsers;
  for (const item of later.items) item.position.sequence += prefix.length;
  rebuildFromMessages(longHistory, sessionId);
  assert.equal(S.thread.getAttribute('aria-busy'), 'true');
  onMessageStart({ message: user('Live input while history is chunking') });
  await waitForClassicRenderIdle();
  assert.equal(S.thread.hasAttribute('aria-busy'), false);
  assert.ok(S.thread.querySelector('[data-execution-turn]'));
  assert.match(S.thread.lastElementChild.textContent, /Live input while history is chunking/);
});
