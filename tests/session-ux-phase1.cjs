/* 会话过程 UI/UX 第一阶段：轮次终态、运行中工具组、Token 摘要、重试摘要。
 *
 * 只测**行为与契约**：jsdom 不做布局、不跑动画。真实渲染截图由第 8 节
 * 的浏览器取证单独产出；思考动画仍由 tests/thinking-dots.cjs 负责。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const url = rel => pathToFileURL(path.join(PUB, rel)).href;
const text = value => ({ type: 'text', text: value });

let passed = 0;
let failed = 0;
function ok(label, value) {
  try {
    if (typeof value === 'function') value();
    else assert.ok(value, label);
    passed++;
    console.log('  ok  ' + label);
  } catch (error) {
    failed++;
    console.error('  FAIL ' + label + ': ' + error.message);
  }
}
const equal = (a, b, label) => ok(label, () => assert.equal(a, b));
const deep = (a, b, label) => ok(label, () => assert.deepEqual(a, b));

(async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document;
  global.window = w;
  global.document = d;
  global.localStorage = w.localStorage;
  global.HTMLElement = w.HTMLElement;
  global.Event = w.Event;
  global.CustomEvent = w.CustomEvent;
  global.Node = w.Node;
  global.MutationObserver = w.MutationObserver;
  global.ResizeObserver = w.ResizeObserver;
  global.requestAnimationFrame = w.requestAnimationFrame.bind(w);
  global.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  global.fetch = w.fetch;

  const TO = await import(url('turn-outcome.js'));
  const M = await import(url('messages.js'));
  const T = await import(url('tools.js'));
  const V = await import(url('tool-view.js'));
  const TM = await import(url('tool-model.js'));
  const { S } = await import(url('state.js'));
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

  console.log('轮次终态模型');
  {
    const completed = TO.deriveTurnOutcome({ tools: [{ status: 'error' }, { status: 'success' }], lastAssistant: { failed: false } });
    equal(completed.state, 'completed', '普通工具失败不把整轮判失败');
    equal(completed.toolFailures, 1, '工具失败单独计数');
    equal(completed.toolCount, 2, '工具数来自真实条目');
    const failed = TO.deriveTurnOutcome({ tools: [{ status: 'success' }], lastAssistant: { failed: true } });
    equal(failed.state, 'failed', 'assistant 轮次级错误才判失败');
    const stopped = TO.deriveTurnOutcome({ tools: [{ status: 'incomplete' }], lastAssistant: { stopped: true } });
    equal(stopped.state, 'stopped', '用户主动停止优先于未完成工具');
    equal(stopped.label, '已停止', '用户停止用中性文案');
    const interrupted = TO.deriveTurnOutcome({ tools: [{ status: 'interrupted' }], lastAssistant: { interrupted: true } });
    equal(interrupted.label, '已中断', '非用户停止的中断不冒充“已停止”');
    const unsettled = TO.deriveTurnOutcome({ tools: [{ status: 'incomplete' }], lastAssistant: { failed: false } });
    equal(unsettled.state, 'unsettled', '工具未返回时是未完成');
    equal(TO.deriveTurnOutcome({}), null, '没有证据就不编造轮次终态');
    const timed = TO.deriveTurnOutcome({ lastAssistant: { failed: false }, startedAt: 1000, endedAt: 13400 });
    equal(timed.durationMs, 12400, '真实起止才计算时长');
    equal(TO.deriveTurnOutcome({ lastAssistant: { failed: false }, startedAt: 1000 }).durationMs, null, '缺结束时间就省略时长');
    equal(TO.deriveTurnOutcome({ tools: [{ state: 'error' }] }).toolFailures, 1, 'Runtime block 的 state 也能计数');

    const recovered = TO.deriveTurnOutcome({
      tools: [{ status: 'interrupted' }, { status: 'success' }],
      lastAssistant: { failed: false },
      interruptedToolTerminal: false,
    });
    equal(recovered.state, 'completed', '早前中断、最终成功不把整轮判成已停止');
    equal(recovered.toolInterruptions, 1, '中断工具仍单独计数');
    const recoveredDefault = TO.deriveTurnOutcome({
      tools: [{ status: 'interrupted' }],
      lastAssistant: { failed: false },
    });
    equal(recoveredDefault.state, 'completed', '有最终成功内容时默认不把中断当终态');
    const recoveredByTool = TO.deriveTurnOutcome({
      tools: [{ status: 'interrupted' }, { status: 'success' }],
    });
    equal(recoveredByTool.state, 'completed', '后续工具成功也覆盖早前中断');
    const terminalNoAnswer = TO.deriveTurnOutcome({
      tools: [{ status: 'success' }, { status: 'interrupted' }],
    });
    equal(terminalNoAnswer.state, 'stopped', '最后一个工具仍中断且无最终内容时为已停止');
    const terminal = TO.deriveTurnOutcome({
      tools: [{ status: 'interrupted' }],
      lastAssistant: { failed: false },
      interruptedToolTerminal: true,
    });
    equal(terminal.state, 'stopped', '中断发生在最后成功内容之后仍是已停止');
  }

  console.log('工具组折叠优先级');
  {
    M.clearThread();
    T.onToolStart({ toolCallId: 'g1', toolName: 'read', args: { path: 'a.txt' } });
    T.onToolStart({ toolCallId: 'g2', toolName: 'read', args: { path: 'b.txt' } });
    const group = d.querySelector('#stream .tl-group');
    const work = group.closest('[data-conversation-work]');
    const head = work.querySelector('.conversation-work-head');
    const list = work.querySelector('.conversation-work-list');
    equal(list.hidden, false, '运行中的多工具组默认展开');
    equal(head.getAttribute('aria-expanded'), 'true', '运行中展开的 aria 状态一致');

    head.click();
    equal(list.hidden, true, '用户显式折叠生效');
    T.onToolStart({ toolCallId: 'g3', toolName: 'read', args: { path: 'c.txt' } });
    equal(list.hidden, true, '新工具到达不覆盖用户显式折叠');
    ok('工作记录仍按真实次数更新', /工作记录.*3 次工具/.test(head.textContent));

    head.click();
    equal(list.hidden, false, '用户显式展开生效');
    T.onToolEnd({ toolCallId: 'g1', isError: false, result: { content: [text('ok')] } });
    T.onToolEnd({ toolCallId: 'g2', isError: false, result: { content: [text('ok')] } });
    T.onToolEnd({ toolCallId: 'g3', isError: false, result: { content: [text('ok')] } });
    equal(list.hidden, false, '用户显式展开在工具结束后保持');

    M.clearThread();
    T.onToolStart({ toolCallId: 'a1', toolName: 'read', args: {} });
    T.onToolStart({ toolCallId: 'a2', toolName: 'read', args: {} });
    T.onToolEnd({ toolCallId: 'a1', isError: false, result: { content: [text('ok')] } });
    T.onToolEnd({ toolCallId: 'a2', isError: false, result: { content: [text('ok')] } });
    equal(d.querySelector('#stream .conversation-work-list').hidden, true, '未手动操作且全部成功的工作记录在结束后默认折叠');

    M.clearThread();
    T.onToolStart({ toolCallId: 'w1', toolName: 'write', args: { path: 'x' } });
    T.onToolStart({ toolCallId: 'w2', toolName: 'write', args: { path: 'y' } });
    T.onToolWait({ toolCallId: 'w2', waiting: true });
    const state = d.querySelector('#stream .ui2-tool-state')?.textContent || '';
    ok('等待写入进入组状态', state.includes('等待写入 1'));
  }

  console.log('工具组耗时');
  {
    M.clearThread();
    const g = V.createGroup();
    M.ensureThread().append(g);
    const make = (id, start, end) => {
      const entry = TM.makeEntry({ toolCallId: id, toolName: 'read', args: { path: id } });
      entry.status = 'success';
      entry.startedAt = start;
      entry.endedAt = end;
      entry.durationMs = end - start;
      return entry;
    };
    V.addToGroup(g, V.renderEntry(make('t1', 1000, 2200)));
    V.addToGroup(g, V.renderEntry(make('t2', 2000, 2500)));
    equal(g.querySelector('.tl-group-time')?.textContent, '1.5s', '组耗时按最早开始与最晚结束计算');
    equal(g.querySelector('.ui2-tool-state')?.textContent, '成功 2', '耗时增强不改变状态摘要文本');

    M.clearThread();
    const runningGroup = V.createGroup();
    M.ensureThread().append(runningGroup);
    const runningEntry = TM.makeEntry({ toolCallId: 'running-time', toolName: 'bash', args: {} });
    runningEntry.startedAt = Date.now() - 500;
    V.addToGroup(runningGroup, V.renderEntry(runningEntry));
    V.addToGroup(runningGroup, V.renderEntry(TM.makeEntry({ toolCallId: 'running-peer', toolName: 'read', args: {} })));
    ok('运行中的组耗时按当前时间推进', /0\.[5-7]s/.test(runningGroup.querySelector('.tl-group-time')?.textContent || ''));
  }

  console.log('单条消息 Token 摘要');
  {
    M.rebuildFromMessages([{ role: 'assistant', content: [text('x')], stopReason: 'stop',
      usage: { input: 11, output: 3, reasoning: 0, totalTokens: 14 } }]);
    const meta = d.querySelector('#stream .ui2-msg-meta');
    ok('Token 摘要存在', Boolean(meta));
    equal(meta.querySelector('.ui2-msg-meta-summary')?.textContent, 'Token 14 · 推理 0（含在输出中）', '摘要只放总量与推理');
    equal(meta.querySelector('details')?.open, false, '完整拆分默认收起');
    equal(meta.querySelectorAll('.ui2-msg-meta-item').length, 4, '完整字段仍在 DOM 中');
    equal(meta.querySelector('[data-kind="input"]')?.textContent, '输入 11 Token', '输入字段保持不变');
    equal(meta.querySelector('[data-kind="reasoning"]')?.textContent, '推理 0 Token（含在输出中）', '推理 0 仍是真实值');

    M.rebuildFromMessages([{ role: 'assistant', content: [text('zero')], stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, totalTokens: 0 } }]);
    const zero = d.querySelector('#stream .ui2-msg-meta');
    equal(zero.querySelectorAll('.ui2-msg-meta-item').length, 7, '七个真实 0 字段全部保留');
    equal(zero.querySelector('.ui2-msg-meta-summary')?.textContent, 'Token 0 · 推理 0（含在输出中）', '0 不被省略');
    equal(zero.querySelector('details')?.querySelectorAll('.ui2-msg-meta-item').length, 7, '完整拆分仍可达');

    M.rebuildFromMessages([{ role: 'assistant', content: [text('none')], stopReason: 'stop' }]);
    equal(d.querySelector('#stream .ui2-msg-meta'), null, '没有 usage 就不生成元信息');
  }

  console.log('自动重试摘要');
  {
    M.clearThread();
    M.onMessageStart({ message: { role: 'assistant' } });
    M.onMessageEnd({ message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429 Too Many Requests' } });
    const captured = M.captureTrailingError();
    ok('重试前能取到已显示的错误', captured?.raw.includes('429'));
    M.dropTrailingError();
    equal(d.querySelectorAll('#stream .msg-err').length, 0, '旧错误块按原逻辑撤掉');
    const notice = M.showRetryNotice({ attempt: 1, maxAttempts: 3, error: captured });
    ok('重试期间保留错误摘要', Boolean(notice) && notice.isConnected);
    ok('摘要带真实重试次数', notice.textContent.includes('第 1/3 次重试'));
    ok('摘要带人话错误标题', notice.textContent.includes('触发限流'));
    ok('原始错误可展开查看', notice.querySelector('.msg-retry-raw')?.textContent.includes('429'));
    const again = M.showRetryNotice({ attempt: 2, maxAttempts: 3, error: captured });
    equal(d.querySelectorAll('#stream .msg-retry').length, 1, '连续重试只有一条摘要');
    ok('摘要更新为最新次数', again.textContent.includes('第 2/3 次重试'));
    M.clearRetryNotice();
    equal(d.querySelectorAll('#stream .msg-retry').length, 0, '重试结束后摘要移除');
  }

  console.log('Classic 轮次终态');
  const liveTurn = (messageEnd, toolError = false) => {
    M.clearThread();
    M.beginTurn();
    M.onMessageStart({ message: { role: 'user', content: [text('任务')] } });
    M.onMessageStart({ message: { role: 'assistant' } });
    T.onToolStart({ toolCallId: 'lt', toolName: 'bash', args: { command: 'false' } });
    T.onToolEnd({ toolCallId: 'lt', isError: toolError, result: { content: [text(toolError ? 'boom' : 'ok')] } });
    M.onMessageEnd({ message: { role: 'assistant', content: [text('完成')], stopReason: 'stop', ...messageEnd } });
    M.onSettled();
    return d.querySelector('#stream .turn-outcome');
  };
  {
    const outcome = liveTurn({}, true);
    ok('实时轮次终态存在', Boolean(outcome));
    equal(outcome.dataset.state, 'completed', '仅工具失败时轮次仍是 completed');
    ok('终态显示工具失败数', outcome.textContent.includes('1 次工具失败'));
    ok('终态显示真实工具数', outcome.textContent.includes('1 次工具'));

    const failedOutcome = liveTurn({ stopReason: 'error', errorMessage: '429 Too Many Requests' });
    equal(failedOutcome.dataset.state, 'failed', 'assistant 轮次级错误使轮次失败');

    M.clearThread();
    S.stopOwnedTurn = true;
    M.beginTurn();
    M.onMessageStart({ message: { role: 'user', content: [text('停止')] } });
    M.onMessageStart({ message: { role: 'assistant' } });
    M.onMessageEnd({ message: { role: 'assistant', content: [], stopReason: 'aborted' } });
    M.onSettled();
    const stopped = d.querySelector('#stream .turn-outcome');
    equal(stopped?.dataset.state, 'stopped', '用户主动停止是 stopped');
    equal(stopped?.textContent.includes('已停止'), true, '用户停止用“已停止”文案');
    S.stopOwnedTurn = false;

    /* 早前工具被中断，但 Agent 后来恢复并给出最终成功回答：整轮仍是 completed。 */
    M.clearThread();
    M.beginTurn();
    M.onMessageStart({ message: { role: 'user', content: [text('恢复任务')] } });
    M.onMessageStart({ message: { role: 'assistant' } });
    T.onToolStart({ toolCallId: 'recovered-old', toolName: 'bash', args: { command: 'old' } });
    const recoveredOld = S.tools.get('recovered-old').entry;
    recoveredOld.status = 'interrupted';
    recoveredOld.endedAt = Date.now();
    T.onToolStart({ toolCallId: 'recovered-new', toolName: 'read', args: { path: 'fixture.txt' } });
    T.onToolEnd({ toolCallId: 'recovered-new', isError: false, result: { content: [text('ok')] } });
    M.onMessageEnd({ message: { role: 'assistant', content: [text('恢复完成')], stopReason: 'stop' } });
    M.onSettled();
    const recoveredOutcome = d.querySelector('#stream .turn-outcome');
    equal(recoveredOutcome?.dataset.state, 'completed', '早前中断的工具不覆盖最终成功');
    equal(recoveredOutcome?.textContent.includes('1 次工具中断'), true, '终态仍如实显示早前中断数');

    /* 中断发生在最后一次成功内容之后：仍要识别为已停止/已中断。 */
    M.clearThread();
    M.beginTurn();
    M.onMessageStart({ message: { role: 'user', content: [text('执行到一半停止')] } });
    M.onMessageStart({ message: { role: 'assistant' } });
    T.onToolStart({ toolCallId: 'terminal-before', toolName: 'read', args: { path: 'fixture.txt' } });
    T.onToolEnd({ toolCallId: 'terminal-before', isError: false, result: { content: [text('ok')] } });
    M.onMessageEnd({ message: { role: 'assistant', content: [text('继续执行')], stopReason: 'toolUse' } });
    T.onToolStart({ toolCallId: 'terminal-stop', toolName: 'bash', args: { command: 'sleep 10' } });
    const terminalTool = S.tools.get('terminal-stop').entry;
    terminalTool.status = 'interrupted';
    terminalTool.endedAt = Date.now();
    M.onSettled();
    const terminalOutcome = d.querySelector('#stream .turn-outcome');
    equal(terminalOutcome?.dataset.state, 'stopped', '最后成功内容之后的中断仍判为已停止');
    equal(terminalOutcome?.textContent.includes('已中断'), true, '非用户停止的中断使用“已中断”文案');
  }

  console.log('Classic 历史轮次终态');
  {
    const user = { role: 'user', timestamp: 1000, content: [text('历史任务')] };
    const call = { type: 'toolCall', id: 'h1', name: 'bash', arguments: { command: 'false' } };
    const result = { role: 'toolResult', toolCallId: 'h1', toolName: 'bash', isError: true, timestamp: 1200, content: [text('boom')] };
    const answer = { role: 'assistant', timestamp: 1300, stopReason: 'stop', content: [text('完成')] };
    M.rebuildFromMessages([user, { role: 'assistant', timestamp: 1100, stopReason: 'toolUse', content: [call] }, result, answer]);
    const outcome = d.querySelector('#stream .turn-outcome');
    equal(outcome?.dataset.state, 'completed', '历史工具失败不把轮次判失败');
    ok('历史显示工具失败数', outcome?.textContent.includes('1 次工具失败'));
    equal((outcome?.textContent.match(/1\.0s|0\.3s/) || []).length, 1, '历史时长来自真实时间戳');

    M.rebuildFromMessages([user, { role: 'assistant', timestamp: 1100, stopReason: 'error', errorMessage: '429', content: [] }]);
    equal(d.querySelector('#stream .turn-outcome')?.dataset.state, 'failed', '历史轮次级错误判失败');

    M.rebuildFromMessages([user, { role: 'assistant', timestamp: 1100, stopReason: 'toolUse', content: [call] }]);
    const unsettled = d.querySelector('#stream .turn-outcome');
    equal(unsettled?.dataset.state, 'unsettled', '历史缺 toolResult 时是未完成');
    ok('历史未完成显示工具未完成数', unsettled?.textContent.includes('1 次工具未完成'));
  }

  console.log('incomplete 视觉语义');
  {
    const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
    ok('incomplete 状态文字使用 warning 语义',
      /\.tl-item\[data-status=incomplete\] \.tl-status\{color:var\(--warn\)\}/.test(css));
    ok('error 状态文字仍使用 error 语义',
      /\.tl-item\[data-status=error\] \.tl-status\{color:var\(--err\)\}/.test(css));
    ok('不再把 incomplete 与 error 合并成同一条规则',
      !/\.tl-item\[data-status=error\] \.tl-status,\.tl-item\[data-status=incomplete\] \.tl-status/.test(css));
  }

  console.log('Runtime 轮次终态');
  {
    const { runtimeStore, observeRuntimeFrame, seedRuntimeSnapshot } = await import(url('runtime-state.js'));
    const { createRuntimeConversation } = await import(url('runtime-conversation.js'));
    const owner = id => ({ backendInstance: 'backend', projectId: 'project', repoId: 'repo', workspaceId: 'ws-' + id,
      workspaceEpoch: 'epoch', conversationId: id, runtimeId: 'rt-' + id, runtimeGeneration: 'one', sessionId: 's-' + id });
    const item = id => ({ conversationId: id, createdAt: '2026-01-01T00:00:00.000Z',
      workspace: { branch: 'branch-' + id, projectId: 'project' }, owner: owner(id), lifecycle: 'ready',
      activity: 'running', attention: false, error: null, stop: null, revision: 1 });
    runtimeStore.seed({ backendInstance: 'backend', items: [item('P'), item('Q')] });
    const host = d.createElement('div');
    d.body.appendChild(host);
    const view = createRuntimeConversation({ host });
    const seq = new Map();
    const frame = (id, event) => {
      const next = (seq.get(id) || 0) + 1;
      seq.set(id, next);
      observeRuntimeFrame({ type: 'runtime_event', owner: owner(id), eventSequence: next, event });
    };
    const output = () => host.querySelector('.rtc-output');

    frame('P', { type: 'agent_start' });
    frame('P', { type: 'message_start', message: { role: 'user', content: [text('任务')] } });
    frame('P', { type: 'message_start', message: { role: 'assistant' } });
    frame('P', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '完成' } });
    frame('P', { type: 'message_end', message: { role: 'assistant', content: [text('完成')], stopReason: 'stop' } });
    frame('P', { type: 'tool_execution_start', toolCallId: 'p1', toolName: 'bash' });
    frame('P', { type: 'tool_execution_end', toolCallId: 'p1', toolName: 'bash', isError: true });
    view.show('P'); await tick();
    equal(output().querySelectorAll('.turn-outcome').length, 0, '运行中的最后一轮不提前显示终态');
    frame('P', { type: 'agent_settled' }); await tick();
    const done = output().querySelector('.turn-outcome');
    equal(done?.dataset.state, 'completed', 'Runtime 工具失败不把轮次判失败');
    ok('Runtime 显示真实工具失败数', done?.textContent.includes('1 次工具失败'));
    frame('P', { type: 'agent_start' }); await tick();
    ok('下一轮 agent_start 不抹掉已 settled 的终态', output().querySelector('.turn-outcome') === done);

    /* 换一代 runtime 后，block id 可能复用；旧终态不能挂到新记录上。 */
    const ownerTwo = { ...owner('P'), runtimeGeneration: 'two' };
    seedRuntimeSnapshot({ backendInstance: 'backend', items: [{ ...item('P'), owner: ownerTwo, activity: 'idle' }] });
    view.show('P'); await tick();
    equal(output().querySelectorAll('.turn-outcome').length, 0, 'runtime 换代后不残留上一代轮次终态');

    frame('Q', { type: 'agent_start' });
    frame('Q', { type: 'message_start', message: { role: 'user', content: [text('失败任务')] } });
    frame('Q', { type: 'message_start', message: { role: 'assistant' } });
    frame('Q', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '半句' } });
    frame('Q', { type: 'message_end', message: { role: 'assistant', content: [text('半句')], stopReason: 'error', errorMessage: '429 Too Many Requests' } });
    frame('Q', { type: 'agent_settled' });
    view.show('Q'); await tick();
    const failed = output().querySelector('.turn-outcome');
    equal(failed?.dataset.state, 'failed', 'Runtime 轮次级错误显示失败');
    ok('Runtime 失败文案来自真实状态', failed?.textContent.includes('失败'));

    /* Runtime 同一轮：早前工具 interrupted，后面 assistant 成功 → completed。 */
    seedRuntimeSnapshot({ backendInstance: 'backend', items: [{ ...item('R'), activity: 'idle' }] });
    const recoveredRecord = runtimeStore.get('R');
    recoveredRecord.timeline = [
      { id: 'r1', kind: 'user', text: '恢复任务' },
      { id: 'r2', kind: 'tools', tools: [{ id: 'r-old', name: 'bash', state: 'interrupted' }] },
      { id: 'r3', kind: 'assistant', text: '恢复完成', state: 'complete' },
    ];
    recoveredRecord.settled = true;
    view.show('R'); await tick();
    const recoveredRuntime = output().querySelector('.turn-outcome');
    equal(recoveredRuntime?.dataset.state, 'completed', 'Runtime 早前中断不覆盖最终成功');
    equal(recoveredRuntime?.textContent.includes('1 次工具中断'), true, 'Runtime 终态仍显示早前中断数');

    /* 没有最终回答、但后面工具成功：同样说明已恢复，不应判 stopped。 */
    recoveredRecord.timeline = [
      { id: 'r1', kind: 'user', text: '恢复任务' },
      { id: 'r2', kind: 'tools', tools: [{ id: 'r-old', name: 'bash', state: 'interrupted' }] },
      { id: 'r3', kind: 'tools', tools: [{ id: 'r-new', name: 'bash', state: 'success' }] },
    ];
    view.draw(); await tick();
    const recoveredByTool = output().querySelector('.turn-outcome');
    equal(recoveredByTool?.dataset.state, 'completed', 'Runtime 后续工具成功覆盖早前中断');

    /* 中断发生在最后成功内容之后：仍是 stopped。 */
    recoveredRecord.timeline = [
      { id: 'r1', kind: 'user', text: '恢复任务' },
      { id: 'r2', kind: 'tools', tools: [{ id: 'r-old', name: 'bash', state: 'interrupted' }] },
    ];
    view.draw(); await tick();
    const terminalRuntime = output().querySelector('.turn-outcome');
    equal(terminalRuntime?.dataset.state, 'stopped', 'Runtime 最后内容之后的中断仍判为已停止');
    equal(terminalRuntime?.textContent.includes('已中断'), true, 'Runtime 非用户停止的中断使用“已中断”文案');
    view.dispose();
  }

  console.log(`Session UX Phase 1: ${passed}/${passed + failed}; failed=${failed}; jsdom 行为契约，不含像素验收`);
  if (failed) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
