'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const text = value => ({ type: 'text', text: value });
const user = content => ({ role: 'user', content });
const assistant = (content, stopReason, model = 'model-a') => ({
  role: 'assistant', content, stopReason, model, provider: 'test-provider',
  usage: { input: 0, output: 3, totalTokens: 3 },
});
const start = message => ({ type: 'message_start', message });
const end = message => ({ type: 'message_end', message });
const call = (id, name) => ({ type: 'toolCall', id, name, arguments: {} });

test('Runtime groups only its current owned live evidence and preserves the original messages', async t => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), { url: 'http://fixture.invalid/', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  for (const key of ['window', 'document', 'localStorage', 'HTMLElement', 'Event', 'CustomEvent',
    'Node', 'MutationObserver']) global[key] = key === 'window' ? w : w[key];
  global.requestAnimationFrame = w.requestAnimationFrame.bind(w);
  global.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
  const fetches = [];
  global.fetch = async (url, options) => {
    fetches.push({ url: String(url), options });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  t.after(() => w.close());

  const { createRuntimeConversation } = await import('../public/runtime-conversation.js');
  const { observeRuntimeFrame, runtimeStore, seedRuntimeSnapshot } = await import('../public/runtime-state.js');
  const { projectRuntimeEvent } = await import('../server/session-runtime.js');
  const makeOwner = id => ({ backendInstance: 'backend', projectId: 'project', repoId: 'repo',
    workspaceId: 'work-' + id, workspaceEpoch: '1', conversationId: id,
    runtimeId: 'runtime-' + id, runtimeGeneration: 'generation', sessionId: 'native-' + id });
  const owner = makeOwner('one');
  const other = makeOwner('two');
  const fallback = makeOwner('fallback');
  const imageEdit = makeOwner('image-edit');
  const item = (runtimeOwner, execution) => ({ conversationId: runtimeOwner.conversationId, owner: runtimeOwner,
    revision: 1, lifecycle: 'ready', activity: 'running', execution });
  const meta = { branchEpoch: 0, startSequence: 0, observedAt: 1000 };
  seedRuntimeSnapshot({ backendInstance: owner.backendInstance,
    items: [item(owner, meta), item(other, meta), item(fallback, meta), item(imageEdit, meta)] });

  const host = d.createElement('div');
  d.body.append(host);
  const view = createRuntimeConversation({ host });
  t.after(() => view.dispose());
  view.show(owner.conversationId);
  const output = view.element.querySelector('.rtc-output');
  const sequences = new Map();
  const emit = (event, runtimeOwner = owner, activity = null) => {
    const next = (sequences.get(runtimeOwner.conversationId) || 0) + 1;
    sequences.set(runtimeOwner.conversationId, next);
    assert.equal(observeRuntimeFrame({ type: 'runtime_event', owner: runtimeOwner, eventSequence: next,
      execution: { ...meta, observedAt: 1000 + next }, event: projectRuntimeEvent(event, activity) }), true);
  };
  const turnOf = node => node.closest('.execution-turn');
  const firstInput = user([text('重复的任务文本'), { type: 'image', mimeType: 'image/png',
    data: 'iVBORw0KGgo=' }]);
  emit({ type: 'execution_submission', id: 'p1', command: 'prompt' });
  emit(start(firstInput));
  const authoritativeInput = user([text('重复的任务文本 **授权正文**\n\n<pi-file name="note.txt" meta="text">\n文件正文\n</pi-file>'),
    firstInput.content[1]]);
  emit(end(authoritativeInput));
  emit({ type: 'agent_start' });
  const input = output.querySelector('[data-role="user"]');
  assert.ok(input);
  const turn = turnOf(input);
  assert.ok(turn, 'accepted user event projects to one Timeline');
  assert.equal(input.querySelectorAll('img').length, 1);
  assert.equal(input.querySelector('strong')?.textContent, '授权正文');
  assert.match(input.querySelector('.msg-file')?.textContent || '', /note\.txt/);
  assert.ok(input.querySelector('.message-edit'));

  const progress = assistant([text('执行前说明'), { type: 'thinking', thinking: '公开思考' },
    call('first', 'read'), call('second', 'grep')], 'toolUse');
  emit(start(progress));
  emit(end(progress));
  emit({ type: 'tool_execution_start', toolCallId: 'first', toolName: 'read', args: { path: 'SECRET_RAW_ARGUMENT' } },
    owner, { kind: 'read', title: '读取 state.js', fileName: 'state.js' });
  emit({ type: 'tool_execution_start', toolCallId: 'second', toolName: 'grep' }, owner,
    { kind: 'search', title: '搜索工具条目', hitCount: 2 });
  emit({ type: 'tool_execution_end', toolCallId: 'second', isError: true, result: { output: 'SECRET_RAW_RESULT' } }, owner,
    { kind: 'search', title: '搜索工具条目', hitCount: 2 });
  emit({ type: 'tool_execution_end', toolCallId: 'first', isError: false });
  const plan = { tool: 'gui_plan', version: 1, revision: 1, turnId: 'plan-turn', tasks: [
    { id: 'step-a', title: '审阅代码', status: 'completed' },
    { id: 'step-b', title: '核对结果', status: 'in_progress' },
  ] };
  const planResponse = assistant([call('plan-call', 'gui_plan')], 'toolUse');
  emit(start(planResponse));
  emit(end(planResponse));
  emit({ type: 'tool_execution_start', toolCallId: 'plan-call', toolName: 'gui_plan',
    args: { tasks: plan.tasks } });
  emit({ type: 'tool_execution_end', toolCallId: 'plan-call', result: { details: plan } });
  const steer = user([text('运行期间追加的要求')]);
  emit(start(steer));
  emit(end(steer));
  const final = assistant([text('**最后结果**')], 'stop', 'model-b');
  emit(start(final));
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '**最后' },
    usage: { input: 0, output: 1 } });
  const usage = turn.querySelector('[data-execution-part="usage"]');
  assert.match(usage.textContent, /流式中/);
  assert.equal(view.element.querySelector('.ui2-runtime-usage').hidden, true, 'owned provisional usage appears inside the same ledger only');
  emit(end(final));
  emit({ type: 'agent_settled', aborted: false });

  assert.equal(turnOf(input), turn, 'render does not replace the input or turn');
  assert.equal(output.querySelectorAll('[data-role="user"]').length, 2);
  assert.equal(output.querySelectorAll('.execution-turn').length, 1);
  assert.match(turn.querySelector('[data-execution-part="plan"]').textContent, /审阅代码/);
  assert.match(turn.querySelector('[data-execution-part="progress"]').textContent, /运行期间追加的要求/);
  assert.equal(turn.querySelectorAll('.turn-outcome').length, 1);
  const workHead = turn.querySelector('.execution-activity-group button');
  if (workHead.getAttribute('aria-expanded') === 'false') workHead.click();
  const activities = [...turn.querySelectorAll('.execution-activity-item')];
  assert.deepEqual(activities.map(row => row.dataset.status), ['completed', 'failed']);
  activities[0].querySelector('button').click();
  assert.match(activities[0].textContent, /当前视图无权读取详情/);
  assert.equal(turn.querySelectorAll('.ui2-runtime-tools').length, 0, 'legacy tool cards do not duplicate structured activity');
  const strong = [...turn.querySelectorAll('strong')].find(node => node.textContent === '最后结果');
  assert.ok(strong, 'the existing final Markdown renderer is retained');
  assert.ok([...turn.querySelectorAll('details')].every(node => !node.contains(strong)), 'the answer stays visible outside disclosures');
  assert.doesNotMatch(usage.textContent, /流式中/);
  assert.match(usage.textContent, /model-b/);
  assert.equal(turn.querySelectorAll('.message-regenerate').length, 1);
  turn.querySelector('.message-regenerate').click();
  await new Promise(resolve => setImmediate(resolve));
  const preflight = fetches.map(({ options }) => {
    try { return JSON.parse(options?.body); } catch { return null; }
  }).find(body => body?.action === 'edit-preflight');
  assert.equal(preflight?.edit?.userIndex, 0, 'regenerate targets the original task, even with a supplemental user input');
  assert.equal(preflight?.edit?.kind, 'regenerate');
  assert.doesNotMatch(output.innerHTML, /SECRET_RAW_ARGUMENT|SECRET_RAW_RESULT/);
  assert.ok(!fetches.some(({ url }) => /tool.*detail/i.test(url)));

  const otherInput = user([text('重复的任务文本')]);
  emit(start(otherInput), other);
  emit(end(otherInput), other);
  view.show(other.conversationId);
  assert.equal(output.querySelectorAll('.execution-turn').length, 1);
  assert.equal(output.querySelectorAll('img').length, 0);
  assert.doesNotMatch(output.textContent, /最后结果|读取 state.js/);
  view.show(owner.conversationId);
  assert.equal(output.querySelector('[data-role="user"]'), input);
  assert.equal(turnOf(input), turn);
  assert.equal(turn.querySelector('.execution-activity-group button').getAttribute('aria-expanded'), 'true');

  // A legacy run stays usable when no P5 execution provenance is on the frame.
  assert.equal(observeRuntimeFrame({ type: 'runtime_event', owner, eventSequence: sequences.get(owner.conversationId) + 1,
    event: start(user([text('旧协议任务')])) }), true);
  const legacy = [...output.querySelectorAll('[data-role="user"]')].find(node => node.textContent.includes('旧协议任务'));
  assert.ok(legacy);
  assert.equal(turnOf(legacy), null);

  view.show(fallback.conversationId);
  const retriedInput = user([text('相同提交只显示一次')]);
  emit({ type: 'execution_submission', id: 'failed-prompt', command: 'prompt' }, fallback);
  emit(start(retriedInput), fallback);
  emit(end(retriedInput), fallback);
  emit({ type: 'agent_start', generationRequestId: 'failed-prompt' }, fallback);
  const failedResponse = assistant([], 'error');
  emit(start(failedResponse), fallback);
  emit(end(failedResponse), fallback);
  emit({ type: 'agent_settled', generationResult: {
    requestId: 'failed-prompt', outcome: 'failed', hasVisibleOutput: false,
  } }, fallback);
  seedRuntimeSnapshot({ backendInstance: fallback.backendInstance,
    items: [{ ...item(fallback, meta), revision: 2, error: 'generation_failed' }] });
  const retainedInput = output.querySelector('[data-role="user"]');
  const retriedTurn = turnOf(retainedInput);
  assert.equal(retriedTurn?.dataset.status, 'failed');
  assert.equal(retriedTurn.querySelectorAll('.turn-outcome').length, 1);

  emit({ type: 'execution_submission', id: 'fallback-prompt', command: 'prompt', fallbackOf: 'failed-prompt' }, fallback);
  emit({ type: 'agent_start', generationRequestId: 'fallback-prompt' }, fallback);
  emit({ ...start(retriedInput), generationRequestId: 'fallback-prompt' }, fallback);
  emit(end(retriedInput), fallback);
  assert.equal(output.querySelectorAll('[data-role="user"]').length, 1, 'a witnessed fallback echo keeps the original input');
  assert.equal(output.querySelector('[data-role="user"]'), retainedInput);
  assert.equal(turnOf(retainedInput), retriedTurn);
  assert.equal(retriedTurn.dataset.status, 'running');
  assert.equal(retriedTurn.querySelectorAll('.turn-outcome').length, 0);

  const fallbackAnswer = assistant([text('备用模型答复')], 'stop', 'model-b');
  emit(start(fallbackAnswer), fallback);
  emit(end(fallbackAnswer), fallback);
  emit({ type: 'agent_settled', aborted: false }, fallback);
  assert.match(retriedTurn.querySelector('[data-execution-part="answer"]').textContent, /备用模型答复/);
  assert.equal(retriedTurn.dataset.status, 'completed');
  assert.equal(retriedTurn.querySelectorAll('.turn-outcome').length, 1);

  emit({ type: 'execution_submission', id: 'deliberate-repeat', command: 'prompt', fallbackOf: 'unknown-parent' }, fallback);
  emit({ ...start(retriedInput), generationRequestId: 'deliberate-repeat' }, fallback);
  emit(end(retriedInput), fallback);
  const repeated = [...output.querySelectorAll('[data-role="user"]')].at(-1);
  assert.equal(output.querySelectorAll('[data-role="user"]').length, 2, 'unverified fallback provenance cannot deduplicate an input');
  assert.notEqual(turnOf(repeated), retriedTurn);
  assert.equal(repeated.dataset.historyUserIndex, '2', 'the hidden native echo still advances the target ordinal');
  repeated.querySelector('.message-edit').click();
  await new Promise(resolve => setImmediate(resolve));
  const edit = fetches.map(({ options }) => {
    try { return JSON.parse(options?.body); } catch { return null; }
  }).find(body => body?.action === 'edit-preflight' && body.edit?.kind === 'edit');
  assert.equal(edit?.edit?.userIndex, 2, 'the original edit preflight targets the corresponding native entry');

  emit({ type: 'agent_settled', aborted: false }, fallback);
  const editOriginal = runtimeStore.beginUserEdit(fallback.conversationId, fallback, 0);
  assert.ok(editOriginal);
  assert.equal(runtimeStore.applyUserEdit(fallback.conversationId, fallback, editOriginal, { text: '保留任务，替换旧尾部' }), true);
  emit({ type: 'agent_settled', aborted: false }, fallback);
  emit(start(user([text('编辑分支后的新任务')])), fallback);
  const currentUserIndices = runtimeStore.get(fallback.conversationId).timeline.filter(block => block.kind === 'user')
    .map(block => block.userIndex);
  assert.deepEqual(currentUserIndices, [0, 1], 'accepting a new tail also removes the fallback echo index');

  view.show(imageEdit.conversationId);
  emit(start(firstInput), imageEdit);
  emit(end(firstInput), imageEdit);
  emit({ type: 'agent_settled', aborted: false }, imageEdit);
  const imageTarget = runtimeStore.beginUserEdit(imageEdit.conversationId, imageEdit, 0);
  assert.ok(imageTarget);
  const inputNode = output.querySelector('[data-role="user"]');
  assert.equal(runtimeStore.applyUserEdit(imageEdit.conversationId, imageEdit, imageTarget, { text: '' }), true);
  assert.equal(imageTarget.target.text, '', 'HTTP-first acceptance keeps an intentionally empty body');
  emit(start(user([firstInput.content[1]])), imageEdit);
  emit(end(user([firstInput.content[1]])), imageEdit);
  assert.equal(output.querySelectorAll('[data-role="user"]').length, 1, 'an image-only edit echo replaces the original input');
  assert.equal(output.querySelector('[data-role="user"]'), inputNode);
  assert.equal(inputNode.querySelectorAll('.msg-att-chip img').length, 1, 'the authorized image remains visible');
  assert.equal(imageTarget.target.text, '');
});
