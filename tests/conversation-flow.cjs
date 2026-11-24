'use strict';
// Native DOM presentation and real renderer regressions. No Pi, model, session
// writes or browser downloads. Pixel/scroll evidence is a separate real UI run.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
after(() => { delete global.document; delete global.window; });
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const { bundle } = require('./esm-bundle.cjs');
const PUB = path.resolve(__dirname, '../public');
const text = value => ({ type: 'text', text: value });
const call = id => ({ type: 'toolCall', id, name: 'read', arguments: { path: 'fixture.txt' } });
const result = id => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [text('fixture output')], isError: false });

async function surface(t) {
  const dom = new JSDOM('<div id="stream"><div class="thread"></div></div><div id="host"></div>', {
    url: 'http://fixture.invalid/', pretendToBeVisual: true,
  });
  global.document = dom.window.document;
  global.window = dom.window;
  t.after(() => dom.window.close());
  const flow = await import('../public/conversation-work-log.js');
  const tool = await import('../public/tool-view.js');
  const parent = document.querySelector('.thread');
  const node = (id, work = false) => {
    const value = document.createElement('article');
    value.dataset.anchorId = id;
    value.textContent = id;
    if (work) value.dataset.conversationWorkKind = 'progress';
    return value;
  };
  const group = (id, statuses = ['success', 'success']) => {
    const value = tool.createGroup();
    value.dataset.anchorId = id;
    for (const [index, status] of statuses.entries()) tool.addToGroup(value, tool.renderEntry({
      id: id + ':' + index, name: 'read', label: '读取文件', known: true, status,
      args: { path: 'fixture.txt' }, output: 'fixture output', summary: 'fixture.txt', durationMs: 20,
    }));
    return value;
  };
  return { dom, document, parent, node, group, ...flow, ...tool };
}

test('native work groups only consecutive display nodes and preserves all original boundaries', async t => {
  const s = await surface(t);
  const original = [s.node('user'), s.node('progress', true), s.group('tools-a'),
    s.node('plan'), s.node('thinking', true), s.group('tools-b'), s.node('answer'),
    s.node('error'), s.group('tools-c', ['error']), s.node('next-user')];
  s.parent.append(...original);
  const flow = s.createConversationFlow();
  flow.render(s.parent);
  assert.equal(s.parent.querySelectorAll('[data-conversation-work]').length, 2);
  assert.deepEqual(s.nativeConversationChildren(s.parent), original);
  assert.equal(original[3].parentElement, s.parent, 'Plan is not hidden in work');
  assert.equal(original[6].parentElement, s.parent, 'final answer is always visible');
  assert.equal(original[7].parentElement, s.parent, 'errors remain an independent boundary');
  assert.equal(s.parent.querySelector('[data-execution-turn]'), null, 'display grouping is not P5 evidence');
  const heads = [...s.parent.querySelectorAll('.conversation-work-head')];
  assert.match(heads[0].textContent, /工作记录.*2 次工具/);
  assert.equal(heads[0].getAttribute('aria-expanded'), 'false');
  const firstLog = heads[0].parentElement;
  flow.render(s.parent);
  assert.equal(s.parent.querySelector('.conversation-work-log'), firstLog);
  heads[0].click();
  flow.render(s.parent);
  assert.equal(heads[0].getAttribute('aria-expanded'), 'true');
  flow.restore();
  assert.deepEqual([...s.parent.children], original);
});

test('native group adoption restores explicit collapse, ARIA and independent entry choices', async t => {
  const s = await surface(t), g = s.group('native', ['running', 'running']);
  const first = g._tlGroup.list.firstElementChild;
  s.parent.append(g);
  s.setGroupExpanded(g, false);
  const flow = s.createConversationFlow();
  flow.render(s.parent);
  assert.equal(g._tlGroup.head.hidden, true);
  assert.equal(g._tlGroup.list.hidden, false, 'outer log owns display visibility');
  assert.equal(g._tlGroup.head.getAttribute('aria-expanded'), 'true');
  s.setEntryExpanded(first, true);
  s.setGroupExpanded(g, false);
  flow.restore();
  assert.equal(g._tlGroup.list.hidden, true, 'explicit native close survives adoption');
  assert.equal(g._tlGroup.head.getAttribute('aria-expanded'), 'false');
  assert.equal(g._tlGroup.head.hidden, false);
  assert.equal(s.isEntryExpanded(first), true, 'adoption does not discard native detail choice');
  s.setGroupExpanded(g, true);
  flow.render(s.parent); flow.restore();
  assert.equal(g._tlGroup.list.hidden, false);
  assert.equal(g._tlGroup.head.getAttribute('aria-expanded'), 'true');
});

test('removing a focused work disclosure transfers focus to a visible surviving native control', async t => {
  const s = await surface(t), g = s.group('focus-release');
  s.parent.append(g);
  const flow = s.createConversationFlow(); flow.render(s.parent);
  s.parent.querySelector('.conversation-work-head').focus();
  flow.restore();
  assert.equal(document.activeElement, g._tlGroup.head);
  assert.equal(document.activeElement.closest('[hidden]'), null);
  flow.render(s.parent);
  s.parent.querySelector('.conversation-work-head').focus();
  s.removeFromGroup(g, g._tlGroup.list.firstElementChild);
  flow.render(s.parent);
  assert.equal(s.parent.querySelector('.conversation-work-head'), null);
  assert.equal(document.activeElement, g._tlGroup.list.querySelector('.tl-toggle'));
  assert.equal(document.activeElement.closest('[hidden]'), null);
});

test('moving a native batch between work logs does not release its new adoption', async t => {
  const s = await surface(t), a = s.node('a', true), b = s.node('b', true);
  const tools = s.group('moving'), split = s.node('plan');
  s.parent.append(a, tools, split, b);
  const flow = s.createConversationFlow();
  flow.render(s.parent);
  s.parent.querySelector('.conversation-work-head').focus();
  flow.render(s.parent, [a, split, b, tools]);
  assert.equal(document.activeElement, s.parent.querySelector('.conversation-work-head'), 'removed work header yields to the surviving work disclosure');
  assert.equal(document.activeElement.closest('[hidden]'), null);
  assert.equal(tools._tlGroup.embedded, true);
  assert.equal(tools._tlGroup.head.hidden, true);
  assert.deepEqual(s.nativeConversationChildren(s.parent), [a, split, b, tools]);
  flow.restore();
  assert.equal(tools._tlGroup.embedded, false);
});

test('native work status summaries retain waiting, failed and interrupted without declaring task success', async t => {
  const s = await surface(t), g = s.group('state', ['running', 'error', 'interrupted']);
  const first = g._tlGroup.list.firstElementChild;
  s.updateEntry(first, { ...first._tlEntry, waiting: true });
  s.parent.append(g);
  const flow = s.createConversationFlow(); flow.render(s.parent);
  const head = s.parent.querySelector('.conversation-work-head');
  assert.match(head.textContent, /等待 1.*失败 1.*已中断 1/);
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.doesNotMatch(head.textContent, /任务成功|已完成/);
  head.click();
  s.updateEntry(first, { ...first._tlEntry, status: 'success', waiting: false });
  flow.render(s.parent);
  assert.equal(head.getAttribute('aria-expanded'), 'false', 'explicit work choice survives status changes');
});

test('state-preserving native ordering keeps focused buttons in the insertBefore fallback', async t => {
  const s = await surface(t);
  const a = document.createElement('button'), b = document.createElement('button');
  s.parent.append(a, b); b.focus();
  s.orderConversationNodes(s.parent, [b, a]);
  assert.equal(document.activeElement, b);
  assert.deepEqual([...s.parent.children], [b, a]);
  const paragraph = document.createElement('p'); paragraph.textContent = 'prefix selected suffix';
  const first = s.node('first'), second = s.node('second'); second.replaceChildren(paragraph);
  s.parent.replaceChildren(first, second);
  const selection = s.dom.window.getSelection();
  selection.setBaseAndExtent(paragraph.firstChild, 7, paragraph.firstChild, 15);
  s.orderConversationNodes(s.parent, [second, first]);
  assert.equal(selection.toString(), 'selected', 'insertBefore fallback also retains selected text endpoints');
});

test('restricted tool entries never expose raw args/output and updates retain classes and detail nodes', async t => {
  const s = await surface(t);
  const entry = { id: 'restricted', name: 'bash', label: '运行命令', known: true, status: 'running',
    detailState: 'restricted', args: { command: 'RAW_ARGS_SENTINEL' },
    details: { payload: 'RAW_DETAILS_SENTINEL' }, output: 'RAW_OUTPUT_SENTINEL', resultLine: 'RAW_RESULT_SENTINEL' };
  const node = s.renderEntry(entry); s.parent.append(node);
  node.classList.add('ui2-runtime-tool');
  const toggle = node.querySelector('.tl-toggle');
  toggle.click(); toggle.focus();
  s.updateEntry(node, { ...entry, status: 'error', durationMs: 1500 });
  assert.equal(node.querySelector('.tl-toggle'), toggle);
  assert.equal(document.activeElement, toggle);
  assert.equal(node.classList.contains('ui2-runtime-tool'), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.match(node.textContent, /失败.*当前视图无权读取原始参数与输出/);
  assert.doesNotMatch(node.outerHTML, /RAW_(ARGS|DETAILS|OUTPUT|RESULT)_SENTINEL/);
  const native = s.renderEntry({ ...entry, id: 'native', detailState: undefined, args: {}, output: 'same A' });
  s.updateEntry(native, { ...entry, detailState: undefined, args: {}, output: 'same B', resultLine: 'result fact' });
  assert.equal(native.querySelector('.tl-out').textContent, 'same B', 'same-length authority replaces the previous text');
  assert.ok(native.querySelector('.tl-result').closest('.tl-more'), 'result fact remains inspectable without another base row');
});

test('text selection preserves backward direction through Markdown delimiter removal without storing content', async t => {
  const s = await surface(t);
  const { preserveTextSelection } = await import('../public/ui/text-selection.js');
  const body = document.createElement('div'); body.textContent = '**chosen 中文'; s.parent.append(body);
  const selection = s.dom.window.getSelection();
  selection.setBaseAndExtent(body.firstChild, 8, body.firstChild, 2);
  const result = preserveTextSelection(body, () => {
    const strong = document.createElement('strong'); strong.textContent = 'chosen 中文'; body.replaceChildren(strong);
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(selection.toString(), 'chosen');
  assert.equal(selection.anchorOffset, 6); assert.equal(selection.focusOffset, 0);
  assert.deepEqual([...body.attributes].map(attribute => attribute.name), [], 'selection content is not serialized as DOM data');
});

test('native tool output inspection retains selected text across authorized output append', async t => {
  const s = await surface(t);
  const entry = { id: 'selected-output', name: 'bash', label: '运行命令', known: true,
    status: 'running', args: {}, summary: 'fixture', output: 'prefix selected suffix' };
  const tool = s.renderEntry(entry); s.parent.append(tool); tool.querySelector('.tl-toggle').click();
  const body = tool.querySelector('.tl-out'), selection = s.dom.window.getSelection();
  selection.setBaseAndExtent(body.firstChild, 7, body.firstChild, 15);
  s.updateEntry(tool, { ...entry, output: entry.output + '\nappended output' });
  assert.equal(selection.toString(), 'selected');
  assert.equal(tool.querySelector('.tl-more').hidden, false);
});

test('verified work interleaves actual entries, keeps final/Plan visible and fails safely on malformed display hints', async t => {
  const s = await surface(t);
  const { createExecutionTurnView } = await import('../public/execution-timeline-view.js');
  const view = createExecutionTurnView({ document: s.document });
  t.after(() => view.release()); s.parent.append(view.node);
  const turn = { id: 'fixture-turn', status: 'completed', usage: [] };
  const group = { id: 'fixture-group', turnId: turn.id, status: 'completed' };
  const activity = (id, sequence) => ({ id, turnId: turn.id, parentId: group.id, title: id,
    kind: 'tool', status: 'completed', position: { sequence, part: 0 } });
  const p1 = s.node('before-first'), p2 = s.node('between-tools'), answer = s.node('final'), plan = s.node('plan');
  const items = [activity('tool-a', 2), activity('tool-b', 4)];
  const input = s.node('user');
  const packet = { turn, group, items, input, plan, progress: [p1, p2], answer: [answer],
    workOrder: [{ node: p1 }, { activityId: 'tool-a' }, { node: p2 }, { activityId: 'tool-b' }] };
  view.update(packet);
  const head = view.node.querySelector('.execution-activity-group > button'); head.click();
  const list = view.node.querySelector('.execution-work-list');
  assert.deepEqual([...list.children].map(node => node.dataset.anchorId), ['before-first', 'activity-tool-a', 'between-tools', 'activity-tool-b']);
  assert.equal(view.node.querySelector('.execution-progress > button'), null, 'one work disclosure, not separate category cards');
  assert.ok(!answer.closest('[hidden]')); assert.ok(!plan.closest('[hidden]'));
  const first = list.querySelector('.execution-activity-item'); first.querySelector('button').focus();
  view.update(packet);
  assert.equal(first.querySelector('button'), document.activeElement);
  view.update({ ...packet, workOrder: [{ node: p1 }, { node: p1 }, { activityId: 'foreign' }] });
  assert.equal(list.querySelectorAll('.execution-activity-item').length, 2);
  assert.equal([...list.children].filter(node => node === p1 || node === p2).length, 2, 'bad hint cannot hide native progress');
  head.click(); view.reveal(p2);
  assert.ok(!p2.closest('[hidden]'), 'search reveals folded work before measuring');
});

test('native batch counts survive temporary P5 detail adoption and later tool arrivals', async t => {
  const s = await surface(t);
  const { createExecutionTurnView } = await import('../public/execution-timeline-view.js');
  const native = s.group('adopted', ['running', 'success']);
  s.parent.append(native);
  const first = native._tlGroup.list.firstElementChild;
  const view = createExecutionTurnView({ document: s.document });
  t.after(() => view.release()); s.parent.append(view.node);
  const turn = { id: 'count-turn', status: 'running', usage: [] };
  const group = { id: 'count-group', turnId: turn.id, status: 'running' };
  const items = [...native._tlGroup.list.children].map((node, sequence) => ({
    id: node.dataset.id, kind: 'tool', title: node.dataset.id, turnId: turn.id,
    parentId: group.id, status: node.dataset.status === 'running' ? 'running' : 'completed',
    position: { sequence, part: 0 },
  }));
  view.update({ turn, group, items, input: s.node('input'), details: new Map([[items[0].id, first]]) });
  // 运行中的工作组默认展开（与 T3 的活动组一致）；只有用户之前明确折叠过才点开。
  const groupHead = view.node.querySelector('.execution-activity-group > button');
  if (groupHead.getAttribute('aria-expanded') === 'false') groupHead.click();
  view.node.querySelector('.execution-activity-item button').click();
  assert.equal(native.contains(first), false, 'authorized native detail is temporarily adopted by P5');
  const later = s.renderEntry({ id: 'later', name: 'grep', label: '搜索', status: 'success', summary: 'fixture', durationMs: 0 });
  s.addToGroup(native, later);
  assert.equal(s.groupCount(native), 3, 'temporary adoption is not native batch removal');
  assert.match(native._tlGroup.state.textContent, /运行中 1.*成功 2/);
  view.release();
  assert.equal(native._tlGroup.list.children.length, 3);
  assert.equal(native._tlGroup.list.firstElementChild, first, 'release restores the original native slot');
  assert.match(native._tlGroup.head.textContent, /3 次/);
});

test('reading bookmarks follow stable native and Runtime block IDs after content above grows', async t => {
  const s = await surface(t);
  const { captureReadingPosition, restoreReadingPosition } = await import('../public/reading-position.js');
  const scroller = document.querySelector('#stream');
  Object.defineProperties(scroller, { clientHeight: { value: 300 }, scrollHeight: { value: 2200, configurable: true } });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300 });
  let shift = 0;
  const a = document.createElement('article'), b = document.createElement('article');
  a.dataset.blockId = 'runtime-a'; b.dataset.blockId = 'runtime-b'; s.parent.append(a, b);
  for (const [node, top] of [[a, 400], [b, 800]]) node.getBoundingClientRect = () => ({ top: top + shift - scroller.scrollTop,
    bottom: top + shift - scroller.scrollTop + 300, height: 300, width: 600 });
  scroller.scrollTop = 830;
  const saved = captureReadingPosition(scroller, s.parent);
  assert.equal(saved.anchorId, 'runtime-b'); assert.equal(saved.offset, -30);
  shift = 120; restoreReadingPosition(scroller, s.parent, saved);
  assert.equal(scroller.scrollTop, 950);
  b.remove(); restoreReadingPosition(scroller, s.parent, saved);
  assert.equal(scroller.scrollTop, 830, 'missing anchor falls back to raw offset');
  a.dataset.anchorId = 'classic-a'; a.dataset.conversationWorkKind = 'progress';
  const g = s.group('native-bookmark'); s.parent.append(g);
  const flow = s.createConversationFlow(); flow.render(s.parent);
  assert.deepEqual(s.nativeConversationChildren(s.parent), [a, g]);
  flow.restore();
});

test('Classic production renderer folds consecutive native tool messages, not the final answer or edit order', t => {
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', pretendToBeVisual: true, runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.fetch = async () => ({ ok: true, json: async () => ({ ok: true, files: [], isRepo: false }) });
  w.eval(bundle(path.join(PUB, 'tools.js')).code);
  t.after(() => w.resetTimeline());
  const messages = [{ role: 'user', content: [text('fixture task')] },
    { role: 'assistant', content: [text('first progress'), call('a')] }, result('a'),
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'native thinking' }, text('second progress'), call('b')] }, result('b'),
    { role: 'assistant', content: [text('final answer')], usage: { output: 0, reasoning: 0 }, stopReason: 'stop' }];
  w.rebuildFromMessages(messages, 'fixture-session');
  const thread = w.S.thread, original = Array.from(w.classicNativeThreadChildren(thread));
  assert.equal(thread.querySelectorAll('.conversation-work-log').length, 1);
  assert.equal(thread.querySelectorAll('.tl-group').length, 2, 'native assistant batches remain distinct');
  const answer = [...thread.querySelectorAll('.msg.assistant')].at(-1);
  assert.equal(answer.parentElement, thread);
  assert.equal(answer.getAttribute('aria-label'), '助手');
  const usageButton = answer.querySelector('.message-usage');
  assert.ok(usageButton, 'real zero usage keeps the stats action');
  usageButton.click();
  const pop = w.document.querySelector('#messageUsagePopover');
  assert.equal(pop.hidden, false);
  assert.match(pop.textContent, /输出.*0 Token/);
  assert.match(pop.textContent, /推理（含在输出中）.*0 Token/);
  assert.equal(answer.querySelector('.ui2-msg-meta'), null, 'no old token footer');
  const log = thread.querySelector('.conversation-work-log'); log.querySelector('button').click();
  const think = thread.querySelector('.think'); think.querySelector('.think-head').click();
  w.refreshClassicConversationFlow();
  assert.equal(thread.querySelector('.think'), think);
  assert.equal(think.querySelector('.think-head').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(Array.from(w.classicNativeThreadChildren(thread)), original, 'editing sees original native order through display wrappers');
  w.releaseClassicExecutionTail(original[0], new Set(original.slice(1)));
  assert.equal(thread.querySelector('.conversation-work-log'), null);
  assert.deepEqual([...thread.children], original);
});

test('Classic queued follow is coalesced and later wheel, keyboard, search and thread changes supersede it', t => {
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  w.eval(bundle(path.join(PUB, 'messages.js')).code);
  const tasks = new Map(); let sequence = 0;
  w.requestAnimationFrame = fn => { tasks.set(++sequence, fn); return sequence; };
  w.cancelAnimationFrame = id => tasks.delete(id);
  const flush = () => { const pending = [...tasks.values()]; tasks.clear(); pending.forEach(fn => fn()); };
  w.ensureThread(); const stream = w.el.stream;
  Object.defineProperties(stream, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
  stream.scrollTop = 1500;
  for (let i = 0; i < 20; i++) w.scrollBottom();
  assert.equal(tasks.size, 1); flush(); assert.equal(stream.scrollTop, 2000);
  stream.scrollTop = 1500; w.scrollBottom();
  stream.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 })); stream.scrollTop = 250;
  flush(); assert.equal(stream.scrollTop, 250);
  w.scrollBottom(); flush(); assert.equal(stream.scrollTop, 250);
  w.scrollBottom(true); stream.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
  flush(); assert.equal(stream.scrollTop, 250, 'even an old forced request loses to newer navigation');
  w.scrollBottom(true); stream.scrollTop = 123; flush(); assert.equal(stream.scrollTop, 123, 'search/scrollbar writes win without needing a wheel');
  const inner = w.document.createElement('pre'); inner.style.overflowY = 'auto'; stream.append(inner);
  Object.defineProperties(inner, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
  inner.scrollTop = 50; stream.scrollTop = 1500; w.scrollBottom(true);
  inner.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -30, bubbles: true }));
  flush(); assert.equal(stream.scrollTop, 2000, 'inner output consumption does not release outer following');
  inner.scrollTop = 0; stream.scrollTop = 1500; w.scrollBottom(true);
  inner.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -30, bubbles: true }));
  flush(); assert.equal(stream.scrollTop, 1500, 'a wheel that can reach the outer stream cancels queued following');
  w.scrollBottom(true); w.clearThread(); stream.scrollTop = 321; flush(); assert.equal(stream.scrollTop, 321);
  stream.scrollTop = 1500; stream.dispatchEvent(new w.Event('scroll')); w.scrollBottom(); flush();
  assert.equal(stream.scrollTop, 2000, 'normal bottom following can resume');
});

test('Classic production streaming retains selected Markdown text across append and completion', async t => {
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  w.eval(bundle(path.join(PUB, 'messages.js')).code);
  const painted = () => new Promise(resolve => w.requestAnimationFrame(() => w.requestAnimationFrame(resolve)));
  w.onMessageStart({ message: { role: 'user', content: [text('selection fixture')] } });
  w.onMessageStart({ message: { role: 'assistant', content: [] } });
  const delta = value => w.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: value } });
  delta('prefix selected suffix'); await painted();
  const body = w.document.querySelector('.assistant-text'), selection = w.getSelection();
  selection.setBaseAndExtent(body.querySelector('p').firstChild, 7, body.querySelector('p').firstChild, 15);
  delta(' **bold**'); await painted();
  assert.equal(selection.toString(), 'selected');
  w.onMessageEnd({ message: { role: 'assistant', content: [text('prefix selected suffix **bold**')], stopReason: 'stop' } });
  await painted(); assert.equal(selection.toString(), 'selected');
});

test('Classic live steers close each work fold at its own observed end', async t => {
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  const tasks = new Map(); let sequence = 0;
  w.requestAnimationFrame = fn => { tasks.set(++sequence, fn); return sequence; };
  w.cancelAnimationFrame = id => tasks.delete(id);
  const flush = () => { const pending = [...tasks.values()]; tasks.clear(); pending.forEach(fn => fn()); };
  let clock = 1000;
  w.Date.now = () => clock;
  w.eval(bundle(path.join(PUB, 'tools.js')).code);
  const say = value => w.onMessageStart({ message: { role: 'user', content: [text(value)], timestamp: clock } });
  const tool = id => {
    w.onToolStart({ toolCallId: id, toolName: 'read', args: { path: id + '.js' } });
    clock += 1000;
    w.onToolEnd({ toolCallId: id, result: { content: [text('ok')] }, isError: false });
  };

  w.beginTurn();
  say('任务');
  clock = 2000;
  w.onMessageStart({ message: { role: 'assistant', content: [] } });
  w.onMessageEnd({ message: { role: 'assistant', content: [text('中间')], timestamp: clock, stopReason: 'toolUse' } });
  clock = 3000; tool('a');
  clock = 5000; say('补充一');
  /* No tool in this segment: its end can only come from the assistant's native
   * message timestamp, even after the work log adopts that node. */
  clock = 6000;
  w.onMessageStart({ message: { role: 'assistant', content: [] } });
  w.onMessageEnd({ message: { role: 'assistant', content: [{ type: 'thinking', thinking: '检查中' }], timestamp: 7000, stopReason: 'toolUse' } });
  clock = 8000; say('补充二');
  clock = 9000; tool('c');
  clock = 11000;
  w.onMessageStart({ message: { role: 'assistant', content: [] } });
  w.onMessageEnd({ message: { role: 'assistant', content: [text('最终回答')], timestamp: clock, stopReason: 'stop' } });
  clock = 12000;
  w.onSettled();
  flush(); flush();
  w.refreshClassicConversationFlow();
  flush();

  const rows = [...w.document.querySelectorAll('.msg.user')].map(node => ({
    continued: node.hasAttribute('data-turn-continued'),
    start: node.dataset.turnStartAt, end: node.dataset.turnEndedAt, status: node.dataset.turnStatus,
  }));
  assert.deepEqual(rows, [
    { continued: false, start: '1000', end: '12000', status: 'completed' },
    /* The earlier steer stops at its own last tool; only the final steer keeps
     * the settled turn end. */
    { continued: true, start: '5000', end: '7000', status: 'completed' },
    { continued: true, start: '8000', end: '12000', status: 'completed' },
  ]);
  assert.deepEqual([...w.document.querySelectorAll('.conversation-work-title')].map(node => node.textContent),
    ['执行了 11 秒', '继续执行了 2 秒', '继续执行了 4 秒']);
  const steers = [...w.document.querySelectorAll('.msg.user[data-turn-continued]')];
  assert.ok(steers.every(node => node.parentElement && !node.closest('[hidden]')), 'supplemental inputs stay visible');
});

async function runtimeSurface(t, { extraItems = [], fetchHistory = null } = {}) {
  // Use the real document and an isolated renderer module graph. state.js caches
  // modal references at import time; reusing another test's document is not valid.
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', pretendToBeVisual: true, runScripts: 'outside-only',
  });
  let view;
  t.after(() => { view?.dispose(); dom.window.close(); });
  const w = dom.window, d = w.document;
  w.TextEncoder = TextEncoder;
  w.fetch = async () => ({ json: async () => fetchHistory || ({ ok: true, items: [], files: [], isRepo: false }) });
  w.eval(bundle(path.join(PUB, 'runtime-conversation.js')).code);
  const { projectRuntimeEvent } = await import('../server/session-runtime.js');
  const owner = { backendInstance: 'fixture', projectId: 'project', repoId: 'repo', workspaceId: 'workspace', workspaceEpoch: 1,
    conversationId: 'focus', runtimeId: 'fixture-runtime', runtimeGeneration: 1, sessionId: 'fixture-session' };
  w.runtimeStore.seed({ backendInstance: 'fixture', items: [{ conversationId: owner.conversationId, owner,
    workspace: { projectId: 'project', workspaceId: 'workspace', workspaceEpoch: 1 }, lifecycle: 'ready', activity: 'idle' },
  ...extraItems] });
  const host = d.createElement('div'); d.body.append(host);
  view = w.createRuntimeConversation({ host });
  view.show(owner.conversationId);
  let sequence = 0;
  const emit = (event, targetOwner = owner) => w.observeRuntimeFrame({ type: 'runtime_event', owner: targetOwner,
    eventSequence: ++sequence, event: projectRuntimeEvent(event) });
  return { w, d, view, host, owner, emit, output: host.querySelector('.rtc-output') };
}

const usage = { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, cacheWrite1h: 1, reasoning: 4, totalTokens: 21 };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Runtime production tool rows and visible work controls keep focus across actual accepted status frames', async t => {
  const { d, host, emit } = await runtimeSurface(t);
  emit({ type: 'agent_start' });
  const message = { role: 'user', content: [text('focus fixture')] };
  emit({ type: 'message_start', message }); emit({ type: 'message_end', message });
  emit({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: { path: 'RAW_ARGS_SENTINEL' } });
  emit({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'grep' });
  const output = host.querySelector('.rtc-output');
  const head = output.querySelector('.conversation-work-head');
  assert.ok(head); head.focus();
  const group = output.querySelector('.tl-group');
  const first = output.querySelector('.tl-item[data-id="a"]');
  emit({ type: 'tool_execution_end', toolCallId: 'a', isError: false, result: { content: [text('RAW_OUTPUT_SENTINEL')] } });
  assert.equal(output.querySelector('.conversation-work-head'), head);
  assert.equal(d.activeElement, head);
  assert.equal(output.querySelector('.tl-group'), group);
  assert.equal(output.querySelector('.tl-item[data-id="a"]'), first);
  first.querySelector('.tl-toggle').click(); first.querySelector('.tl-toggle').focus();
  emit({ type: 'tool_execution_end', toolCallId: 'b', isError: true });
  assert.equal(d.activeElement, first.querySelector('.tl-toggle'));
  assert.equal(first.classList.contains('ui2-runtime-tool'), true);
  assert.match(head.textContent, /失败 1/);
  assert.doesNotMatch(output.outerHTML, /RAW_ARGS_SENTINEL|RAW_OUTPUT_SENTINEL/);
});

test('Runtime text selection survives streamed Markdown growth and unchanged terminal updates', async t => {
  const { w, emit, output } = await runtimeSurface(t);
  emit({ type: 'agent_start' });
  const input = { role: 'user', content: [text('selection fixture')] };
  emit({ type: 'message_start', message: input }); emit({ type: 'message_end', message: input });
  emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  const delta = value => emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: value } });
  delta('prefix selected suffix');
  const body = output.querySelector('.rtc-assistant-text');
  const range = w.document.createRange();
  const node = body.querySelector('p').firstChild;
  range.setStart(node, 7); range.setEnd(node, 15);
  const selection = w.getSelection(); selection.addRange(range);
  assert.equal(selection.toString(), 'selected');
  delta(' **bold**');
  assert.equal(selection.toString(), 'selected', 'streaming append retains the exact selected text');
  const stableBody = body.firstElementChild;
  emit({ type: 'message_end', message: { role: 'assistant', content: [text('prefix selected suffix **bold**')], stopReason: 'stop' } });
  assert.equal(selection.toString(), 'selected');
  assert.equal(body.firstElementChild, stableBody, 'state-only completion does not rebuild unchanged Markdown');
});

test('Runtime first mount resolves the fold owner from ordered detached nodes and refreshes it on settle', async t => {
  const { emit, output } = await runtimeSurface(t);
  emit({ type: 'agent_start' });
  const input = { role: 'user', content: [text('timing fixture')] };
  emit({ type: 'message_start', message: input }); emit({ type: 'message_end', message: input });
  const answer = { role: 'assistant', content: [text('first answer')], stopReason: 'stop' };
  emit({ type: 'message_start', message: answer });
  emit({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: { path: 'a' } });
  emit({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'read', args: { path: 'b' } });
  emit({ type: 'message_end', message: answer });
  emit({ type: 'tool_execution_end', toolCallId: 'a', isError: false });
  emit({ type: 'tool_execution_end', toolCallId: 'b', isError: false });
  await wait(8);
  const log = output.querySelector('.conversation-work-log');
  assert.ok(log, 'two tools fold under the owning user turn');
  const head = log.querySelector('.conversation-work-head');
  assert.match(log.querySelector('.conversation-work-title').textContent, /执行中|已运行/,
    'first mount must not lose ownership just because nodes were built detached');
  emit({ type: 'agent_settled' });
  assert.strictEqual(output.querySelector('.conversation-work-log'), log, 'settle updates the same fold');
  assert.match(log.querySelector('.conversation-work-title').textContent, /执行了/);
  assert.equal(log.querySelector('.conversation-work-head'), head);
});

test('Runtime session switches never borrow timing from the conversation left behind', async t => {
  const otherOwner = { backendInstance: 'fixture', projectId: 'project', repoId: 'repo', workspaceId: 'workspace-b',
    workspaceEpoch: 1, conversationId: 'other', runtimeId: 'fixture-runtime-b', runtimeGeneration: 1, sessionId: 'fixture-session-b' };
  const { view, emit, output } = await runtimeSurface(t, { extraItems: [{
    conversationId: otherOwner.conversationId, owner: otherOwner,
    workspace: { projectId: 'project', workspaceId: 'workspace-b', workspaceEpoch: 1 },
    lifecycle: 'ready', activity: 'idle',
  }] });
  emit({ type: 'agent_start' });
  const input = { role: 'user', content: [text('A question')] };
  emit({ type: 'message_start', message: input }); emit({ type: 'message_end', message: input });
  emit({ type: 'message_start', message: { role: 'assistant', content: [text('A answer')], stopReason: 'stop' } });
  emit({ type: 'tool_execution_start', toolCallId: 'a1', toolName: 'read', args: { path: 'a' } });
  emit({ type: 'tool_execution_start', toolCallId: 'a2', toolName: 'read', args: { path: 'b' } });
  emit({ type: 'message_end', message: { role: 'assistant', content: [text('A answer')], stopReason: 'stop' } });
  emit({ type: 'tool_execution_end', toolCallId: 'a1', isError: false });
  emit({ type: 'tool_execution_end', toolCallId: 'a2', isError: false });
  await wait(8);
  emit({ type: 'agent_settled' });
  assert.match(output.querySelector('.conversation-work-title').textContent, /执行了/);

  view.show('other');
  emit({ type: 'message_start', message: { role: 'assistant', content: [text('orphan answer')], stopReason: 'stop' } }, otherOwner);
  emit({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'read', args: { path: 'a' } }, otherOwner);
  emit({ type: 'tool_execution_start', toolCallId: 'b2', toolName: 'read', args: { path: 'b' } }, otherOwner);
  emit({ type: 'message_end', message: { role: 'assistant', content: [text('orphan answer')], stopReason: 'stop' } }, otherOwner);
  emit({ type: 'tool_execution_end', toolCallId: 'b1', isError: false }, otherOwner);
  emit({ type: 'tool_execution_end', toolCallId: 'b2', isError: false }, otherOwner);
  const otherOutput = output;
  const otherLog = otherOutput.querySelector('.conversation-work-log');
  assert.ok(otherLog);
  assert.equal(otherLog.querySelector('.conversation-work-title').textContent, '工作记录',
    'a conversation without its own user turn must not inherit the previous clock');

  view.show('focus');
  assert.match(output.querySelector('.conversation-work-title').textContent, /执行了/);
});

test('Runtime read-only native history restores duration from its own trusted timestamps', async t => {
  const historyOwner = { backendInstance: 'fixture', projectId: 'project', repoId: 'repo', workspaceId: 'workspace-h',
    workspaceEpoch: 1, conversationId: 'history-only', runtimeId: '', runtimeGeneration: 1, sessionId: 'history-session' };
  const history = {
    ok: true, conversationId: 'history-only', sessionId: 'history-session', truncated: false,
    messages: [{ role: 'user', text: 'old question' }, { role: 'assistant', text: 'old answer' }],
    execution: { truncated: false, planBoundary: null, timeline: [
      { id: 'h-user', kind: 'user', text: 'old question', userIndex: 0, at: 1000 },
      { id: 'h-tools', kind: 'tools', at: 3000, tools: [
        { id: 'h-t1', name: 'read', state: 'success', waiting: false, durationMs: 200 },
        { id: 'h-t2', name: 'read', state: 'success', waiting: false, durationMs: 200 },
      ] },
      { id: 'h-answer', kind: 'assistant', text: 'old answer', state: 'complete', at: 5000 },
    ] },
  };
  const { view, d, output } = await runtimeSurface(t, { fetchHistory: history, extraItems: [{
    conversationId: historyOwner.conversationId, owner: null, nativeSessionId: 'history-session',
    workspace: { projectId: 'project', workspaceId: 'workspace-h', workspaceEpoch: 1 },
    lifecycle: 'dormant', activity: 'idle',
  }] });
  view.show(historyOwner.conversationId);
  [...d.querySelectorAll('button')].find(button => button.textContent === '打开历史').click();
  await wait(30);
  const log = output.querySelector('.conversation-work-log');
  assert.ok(log, 'history still uses its native work fold');
  assert.equal(log.querySelector('.conversation-work-title').textContent, '执行了 4 秒',
    'history timing comes from the user message and its own last observed work');
  const input = output.querySelector('[data-role="user"]');
  assert.equal(input.dataset.turnStartAt, '1000');
  assert.equal(input.dataset.turnEndedAt, '5000');
  const answer = output.querySelector('.rtc-timeline-message[data-role="assistant"]');
  assert.ok(answer.querySelector('.message-copy'), 'history terminal answer has a shared action bar');
  assert.equal(answer.querySelector('.message-usage'), null, 'missing usage creates no entry');
});

test('Runtime usage lives in the assistant action bar and the popover closes without a layout entry', async t => {
  const { w, d, emit, output } = await runtimeSurface(t);
  emit({ type: 'agent_start' });
  const input = { role: 'user', content: [text('usage fixture')] };
  emit({ type: 'message_start', message: input }); emit({ type: 'message_end', message: input });
  const answer = { role: 'assistant', content: [text('usage answer')], stopReason: 'stop', usage };
  emit({ type: 'message_start', message: answer }); emit({ type: 'message_end', message: answer });
  emit({ type: 'agent_settled' });
  await wait(8);
  const row = output.querySelector('.rtc-timeline-message[data-role="assistant"]');
  const bar = row.querySelector('.message-actions');
  assert.ok(bar, 'terminal answer owns the assistant action bar');
  assert.ok(row.querySelector('.message-copy'));
  assert.ok(row.querySelector('.message-regenerate'));
  const usageButton = row.querySelector('.message-usage');
  assert.ok(usageButton, 'real usage creates exactly one stats action');
  assert.equal(usageButton.getAttribute('aria-label'), '查看用量');
  assert.equal(usageButton.title, '', 'no native title tooltip layer');
  assert.equal(output.querySelector('.ui2-msg-meta, .ui2-runtime-usage, .execution-usage'), null,
    'the old footer/strip equivalents are gone');
  usageButton.focus();
  usageButton.click();
  const pop = d.querySelector('#messageUsagePopover');
  assert.equal(pop.hidden, false);
  assert.equal(usageButton.getAttribute('aria-expanded'), 'true');
  assert.match(pop.textContent, /输入.*11 Token/s);
  assert.match(pop.textContent, /输出.*7 Token/s);
  assert.match(pop.textContent, /推理（含在输出中）.*4 Token/s);
  assert.match(pop.textContent, /总计.*21 Token/s);
  assert.doesNotMatch(pop.textContent, /Token 23,140/);
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(pop.hidden, true);
  assert.equal(usageButton.getAttribute('aria-expanded'), 'false');
});

test('Runtime message actions retain focus and copy the current authoritative streamed text', async t => {
  const { w, d, emit, output } = await runtimeSurface(t);
  const copied = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async value => { copied.push(value); } } });
  emit({ type: 'agent_start' });
  const input = { role: 'user', content: [text('action fixture')] };
  emit({ type: 'message_start', message: input }); emit({ type: 'message_end', message: input });
  emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  const delta = value => emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: value } });
  delta('first text');
  const row = output.querySelector('[data-role="assistant"]');
  const copy = row.querySelector('.message-copy');
  const regenerate = row.querySelector('.message-regenerate');
  copy.focus(); delta(' appended');
  assert.equal(d.activeElement, copy, 'streaming cannot detach the focused copy action');
  assert.equal(row.querySelector('.message-regenerate'), regenerate);
  copy.click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(copied, ['first text appended'], 'stable action callback uses the current text, not its creation snapshot');
});
