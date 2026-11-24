/* Classic P5-B exercises the real message and tool renderers against a scoped Pi stream. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

async function main() {
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
  const M = await import('../public/messages.js');
  const T = await import('../public/tools.js');
  const { S } = await import('../public/state.js');
  const { observeClassicExecution } = await import('../public/execution-timeline-state.js');
  const { classicNativeThreadChildren, refreshClassicExecutionView, scheduleClassicExecutionView } =
    await import('../public/classic-execution-view.js');
  const { captureReadingPosition, restoreReadingPosition } = await import('../public/reading-position.js');
  const { scrollToUserTurn } = await import('../public/conversation-nav.js');
  const owner = { runtimeId: 'bridge', runtimeGeneration: 1, workspaceId: 'work', workspaceEpoch: 1, sessionId: 'native' };
  const cases = [];
  const check = (name, assertion) => { assertion(); cases.push(name); };
  let sequence = 0;
  const send = (type, payload = {}, branchEpoch = 0) => {
    const event = {
      type, legacyOwner: owner, _seq: ++sequence,
      executionClassic: { branchEpoch, sessionId: owner.sessionId, observedAt: Date.now() }, ...payload,
    };
    observeClassicExecution(event);
    scheduleClassicExecutionView(event);
    if (type === 'agent_start') { M.beginTurn(); M.setStreaming(true); }
    if (type === 'message_start') M.onMessageStart(event);
    if (type === 'message_end') M.onMessageEnd(event);
    if (type === 'agent_settled') M.onSettled();
    if (type === 'tool_execution_start') T.onToolStart(event);
    if (type === 'tool_execution_end') T.onToolEnd(event);
    return event;
  };
  const frame = () => new Promise(resolve => w.requestAnimationFrame(resolve));
  const text = text => ({ type: 'text', text });
  const user = { role: 'user', content: [text('Original task'), { type: 'image', mimeType: 'image/png', data: 'YXNkZg==' }] };
  const message = (content, stopReason) => ({ role: 'assistant', content, stopReason, model: 'fixture-model',
    usage: { input: 5, output: 3, totalTokens: 8 } });
  const response = m => { send('message_start', { message: m }); send('message_end', { message: m }); };
  M.ensureThread();
  try {
    send('execution_submission', { id: 'first', command: 'prompt' });
    send('agent_start');
    send('message_start', { message: user });
    send('message_end', { message: user });
    const original = S.thread.querySelector('.msg.user');
    const dots = S.working;
    const plan = { tool: 'gui_plan', version: 1, turnId: 'native-plan', revision: 1,
      tasks: [{ id: 'inspect', title: 'Review sources', status: 'in_progress' }] };
    response(message([{ type: 'toolCall', id: 'P', name: 'gui_plan', arguments: plan }], 'toolUse'));
    send('tool_execution_start', { toolCallId: 'P', toolName: 'gui_plan', args: plan });
    send('tool_execution_end', { toolCallId: 'P', result: { details: plan } });
    const originalPlan = S.thread.querySelector('.plan-card');
    const beforeTool = message([text('Progress text'), { type: 'thinking', thinking: 'Visible thought' },
      { type: 'toolCall', id: 'R', name: 'read', arguments: {} }], 'toolUse');
    response(beforeTool);
    send('tool_execution_start', { toolCallId: 'R', toolName: 'read', args: { path: 'fixture.txt' } });
    const tool = S.tools.get('R').node;
    const oldGroup = S.tlGroup;
    await frame();
    const live = original.closest('[data-execution-turn]');
    check('mounts the original user node and attachment from an accepted live event', () => {
      assert.equal(live?.parentElement, S.thread);
      assert.equal(live.querySelectorAll('.msg.user').length, 1);
      assert.ok(original.querySelector('.msg-att-chip'));
      assert.ok(original.querySelector('.message-edit'));
    });
    check('keeps existing working node directly mounted', () => {
      assert.strictEqual(S.working, dots);
      assert.strictEqual(dots.parentElement, S.thread);
    });
    check('places the existing Plan between input and activity, using one card', () => {
      assert.strictEqual(live.querySelector('[data-execution-part="plan"] .plan-card'), originalPlan);
      assert.equal(live.querySelectorAll('.plan-card').length, 1);
      // 运行中的单条工具就是一行紧凑工作记录（T3 的 work-live 行）。
      assert.equal(live.querySelectorAll('.execution-activity-item').length, 1);
      assert.equal(oldGroup.isConnected, false);
      assert.equal(tool.isConnected, false);
    });
    check('uses the original authorized Classic tool detail', () => {
      const groupHead = live.querySelector('.execution-activity-group > .execution-head');
      if (groupHead.getAttribute('aria-expanded') === 'false') groupHead.click();
      live.querySelector('.execution-activity-item > .execution-head').click();
      assert.ok(live.contains(tool));
    });
    send('tool_execution_end', { toolCallId: 'R', result: { content: [text('Authorized tool output')] } });
    response({ ...message([text('**Final answer**')], 'stop'), model: 'fixture-model-b' });
    send('agent_settled', { aborted: false });
    await frame();
    check('reuses the same wrapper through settle and preserves Markdown and regenerate', () => {
      assert.strictEqual(original.closest('[data-execution-turn]'), live);
      assert.equal(live.querySelectorAll('strong').length, 1);
      assert.ok(live.querySelector('.message-regenerate'));
      assert.equal(live.querySelectorAll('[data-execution-part="usage"]').length, 1);
      assert.ok([...live.querySelectorAll('.execution-usage-model')].some(node => node.textContent === 'fixture-model-b'));
    });
    check('preserves native nested reading anchors', () => {
      const scroller = S.thread.parentElement;
      Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true });
      original.getBoundingClientRect = () => ({ top: 30, bottom: 60, height: 30, width: 100 });
      const bookmark = captureReadingPosition(scroller, S.thread, { isPinned: false });
      assert.equal(bookmark.anchorId, original.dataset.anchorId);
      original.getBoundingClientRect = () => ({ top: 90, bottom: 120, height: 30, width: 100 });
      assert.ok(restoreReadingPosition(scroller, S.thread, bookmark));
      assert.equal(scroller.scrollTop, 60);
    });
    send('execution_submission', { id: 'second', command: 'prompt' });
    send('agent_start');
    send('message_start', { message: user });
    await frame();
    check('keeps distinct identical submissions in distinct turns', () => {
      assert.equal(S.thread.querySelectorAll('[data-execution-turn]').length, 2);
      assert.equal(S.thread.querySelectorAll('.msg.user').length, 2);
    });
    send('execution_submission', { id: 'branch-cut', command: 'prompt' }, 1);
    await frame();
    check('restores original authorized Classic detail on scope retirement', () => {
      assert.equal(S.thread.querySelectorAll('[data-execution-turn]').length, 0);
      assert.strictEqual(original.parentElement, S.thread);
      assert.ok(oldGroup.contains(tool));
      assert.equal(oldGroup.hidden, false);
    });
    M.clearThread();
    await frame();
    check('clears pending and mounted views on thread reset', () => assert.equal(S.thread.children.length, 0));
    send('execution_submission', { id: 'unbound', command: 'prompt',
      executionClassic: { branchEpoch: 2, sessionId: null } });
    send('agent_start', { executionClassic: { branchEpoch: 2, sessionId: null } });
    send('message_start', { message: user, executionClassic: { branchEpoch: 2, sessionId: null } });
    await frame();
    check('waits to mount until the native session is bound', () => {
      assert.equal(S.thread.querySelectorAll('[data-execution-turn]').length, 0);
    });
    send('fixture', { executionClassic: { branchEpoch: 2, sessionId: owner.sessionId, sessionBound: true } });
    await frame();
    check('reuses the original input across first session binding', () => {
      assert.equal(S.thread.querySelectorAll('[data-execution-turn] .msg.user').length, 1);
    });
    send('message_start', { message: { role: 'user', content: [text('Additional steer')] } }, 2);
    await frame();
    check('supplemental input stays visible between folds and navigation still lands', () => {
      const inputs = S.thread.querySelectorAll('.msg.user');
      const steer = inputs[1];
      // 用户补充输入按真实执行边界留在两段工作折叠之间，不进入任何折叠列表。
      assert.ok(steer.closest('[data-execution-part="activity-flow"]'));
      assert.equal(steer.closest('[data-execution-part="progress"]'), null);
      assert.equal(steer.closest('[hidden]'), null);
      assert.equal(scrollToUserTurn(1), true);
      assert.equal(steer.closest('[hidden]'), null);
    });
    check('edit preflight can capture original order without unmounting a view', () => {
      const inputs = [...S.thread.querySelectorAll('.msg.user')];
      assert.deepEqual(classicNativeThreadChildren(S.thread).filter(node => node.matches('.msg.user')), inputs);
      assert.equal(S.thread.querySelectorAll('[data-execution-turn]').length, 1);
    });

    M.clearThread();
    send('execution_submission', { id: 'failed-model', command: 'prompt' }, 3);
    send('agent_start', {}, 3);
    send('message_start', { message: user }, 3);
    const failed = message([], 'error');
    failed.errorMessage = 'provider failure';
    send('message_start', { message: failed }, 3);
    send('message_end', { message: failed }, 3);
    S.fallbackActive = true;
    send('agent_settled', { generationResult: { requestId: 'failed-model', outcome: 'failed', hasVisibleOutput: false } }, 3);
    await frame();
    const retryTurn = S.thread.querySelector('[data-execution-turn]');
    assert.ok(retryTurn);
    check('verified active fallback defers the first attempt terminal', () => {
      assert.equal(retryTurn.dataset.status, 'waiting');
      assert.ok(retryTurn.querySelector('[data-execution-part="outcome"]').firstElementChild.hidden);
    });
    S.fallbackActive = false;
    refreshClassicExecutionView();
    await frame();
    check('failed fallback selection restores the original terminal', () => {
      assert.equal(retryTurn.dataset.status, 'failed');
      assert.equal(retryTurn.querySelector('[data-execution-part="outcome"]').firstElementChild.hidden, false);
    });
    send('execution_submission', { id: 'fallback-model', command: 'prompt', fallbackOf: 'failed-model' }, 3);
    send('agent_start', {}, 3);
    send('message_start', { message: user }, 3);
    const recovered = message([text('**Recovered response**')], 'stop');
    send('message_start', { message: recovered }, 3);
    send('message_end', { message: recovered }, 3);
    send('agent_settled', { aborted: false }, 3);
    await frame();
    check('controlled fallback reuses input and shows a single terminal for the recovered task', () => {
      assert.equal(S.thread.querySelectorAll('.msg.user').length, 1);
      assert.strictEqual(S.thread.querySelector('[data-execution-turn]'), retryTurn);
      const result = retryTurn.querySelector('[data-execution-part="answer"]');
      assert.equal(result.querySelector('strong').textContent, 'Recovered response');
      assert.ok(result.querySelector('.message-regenerate'));
      assert.equal(retryTurn.querySelector('[data-execution-part="outcome"]').children.length, 1);
    });
    send('execution_submission', { id: 'separate-identical-task', command: 'prompt' }, 3);
    send('agent_start', {}, 3);
    send('message_start', { message: user }, 3);
    await frame();
    check('a suppressed echo still consumes its native index without moving the task edit target', () => {
      const inputs = [...S.thread.querySelectorAll('.msg.user')];
      assert.deepEqual(inputs.map(node => node.dataset.userIndex), ['0', '2']);
      assert.ok(scrollToUserTurn(1));
      assert.ok(scrollToUserTurn(2));
    });
  } finally {
    M.clearThread();
    T.resetTimeline();
    w.close();
  }
  console.log('P5-B Classic UI: ' + cases.length + '/' + cases.length);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
