'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const moduleUrl = import('../public/execution-timeline-view.js');
const turn = {
  id: 'turn:12', status: 'running', sessionId: 'session', completeness: 'complete',
  source: 'classic-rpc', evidence: 'verified', position: { domain: 'live', sequence: 12 },
  input: { id: 'turn:12:input:13', content: { source: 'live-buffer', state: 'available' } },
};
const group = {
  id: 'activity', turnId: turn.id, status: 'running', activeItemId: 'item-2',
  timing: { startedAt: 1000, endedAt: null, evidence: 'observed' },
};

function activity(id, index, fields = {}) {
  return {
    id, turnId: turn.id, parentId: group.id, position: { sequence: index, part: 0 },
    status: 'completed', title: id, kind: 'tool', ...fields,
  };
}

async function surface(t) {
  const { createExecutionTurnView } = await moduleUrl;
  const dom = new JSDOM('', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const view = createExecutionTurnView({ document, now: () => 4000 });
  t.after(() => view.release());
  document.body.append(view.node);
  return { ...view, document };
}

test('attaches only to the matching complete live input of a bound session', async () => {
  const { executionTurnForInput } = await moduleUrl;
  const snapshot = { scope: { kind: 'classic', sessionId: 'session' }, turns: [turn] };
  assert.equal(executionTurnForInput(snapshot, 13), turn);
  assert.equal(executionTurnForInput(snapshot, 12), null);
  assert.equal(executionTurnForInput({ ...snapshot, scope: { kind: 'classic', sessionId: null } }, 13), null);
  for (const update of [
    { sessionId: 'other' }, { completeness: 'partial' }, { source: 'runtime-frame' },
    { position: { domain: 'history' } }, { evidence: 'partial' },
  ]) {
    assert.equal(executionTurnForInput({ ...snapshot, turns: [{ ...turn, ...update }] }, 13), null);
  }
});

test('preserves native section nodes and keeps streaming thinking outside a disclosure', async t => {
  const { document, node, update } = await surface(t);
  const input = document.createElement('article');
  const plan = document.createElement('section');
  const progress = document.createElement('article');
  const thinking = document.createElement('details');
  const answer = document.createElement('article');
  const outcome = document.createElement('footer');
  progress.textContent = 'original progress';
  answer.textContent = 'original final answer';
  let copied = false;
  answer.addEventListener('click', () => { copied = true; });
  update({ turn, input, plan, progress: [progress], thinking: [thinking], answer: [answer],
    outcomes: [outcome], items: [], group: null });
  assert.deepEqual([...node.querySelectorAll('article')], [input, progress, answer]);
  // 参考 T3：助手的过程文字是时间线的一行，不再被折进工作记录里。
  // 流式 thinking 仍保持 native <details>，不被套进第二层 disclosure。
  assert.ok(!progress.parentElement.hidden);
  assert.ok(!thinking.parentElement.closest('[hidden]'));
  assert.ok(!answer.parentElement.closest('[hidden]'));
  assert.equal(node.querySelectorAll('footer').length, 1, 'the verified turn only contributes its outcome footer');
  assert.ok(node.contains(outcome));
  assert.equal(node.querySelector('.execution-usage'), null, 'execution view owns no usage entry');
  answer.click();
  assert.ok(copied);
});

test('orders by recorded start position and retains detail nodes as tool status changes', async t => {
  const { document, node, update } = await surface(t);
  const input = document.createElement('div');
  const native = document.createElement('div');
  native.textContent = 'Authorized output';
  const details = new Map([['item-1', native]]);
  const first = activity('item-1', 1, { title: '读取 state.js', summary: { fileName: 'state.js', lineRange: { start: 1, end: 8 } } });
  const second = activity('item-2', 2, { title: '运行命令', status: 'running' });
  const rest = Array.from({ length: 3 }, (_, i) => activity('later-' + i, i + 3));
  update({ turn, group, items: [...rest, second, first], details, input });
  const showActivities = node.querySelector('.execution-activity-group > button');
  assert.match(showActivities.textContent, /执行中/);
  assert.match(showActivities.textContent, /5 项/);
  // 这一轮没有轮次时间证据，工具组自身的 3s 不能冒充整轮耗时。
  assert.doesNotMatch(showActivities.textContent, /已运行|用时/);
  // 运行中的工作记录默认展开（T3 的活动组语义）；用户显式折叠后才保持折叠。
  assert.equal(showActivities.getAttribute('aria-expanded'), 'true');
  const rows = node.querySelectorAll('.execution-activity-item');
  assert.equal(rows.length, 5);
  assert.match(rows[0].textContent, /state\.js.*1–8/);
  assert.equal(rows[0].querySelector('button').textContent.match(/state\.js/g).length, 1);
  assert.ok(!node.contains(native));
  const showFirst = rows[0].querySelector('button');
  showFirst.click();
  assert.ok(rows[0].contains(native));
  update({ turn: { ...turn, status: 'completed' },
    group: { ...group, status: 'failed', activeItemId: null, timing: { ...group.timing, endedAt: 5000 } },
    items: [{ ...second, status: 'failed', issue: { code: 'tool-failed' } }, ...rest, first], details, input });
  assert.equal(node.querySelector('.execution-activity-item'), rows[0]);
  assert.equal(showFirst.getAttribute('aria-expanded'), 'true');
  assert.ok(rows[0].contains(native));
  assert.match(showActivities.textContent, /执行了|工作记录/);
  assert.match(showActivities.textContent, /1 项失败/);
  rows[1].querySelector('button').click();
  assert.match(rows[1].textContent, /失败.*详情暂不可用/);
});

test('labels the turn fold from wall-clock timing and keeps each steer segment on its own boundary', async t => {
  const { document, node, update } = await surface(t);
  const input = document.createElement('div');
  const completedGroup = { ...group, status: 'completed', activeItemId: null };
  const timed = (id, sequence, startedAt, endedAt) => ({
    ...activity(id, sequence), timing: { startedAt, endedAt, evidence: 'observed' },
  });
  const first = timed('item-1', 1, 1000, 1800);
  const between = timed('item-2', 3, 2500, 3500);
  const last = timed('item-3', 5, 6500, 8500);
  const steerA = document.createElement('article');
  const steerB = document.createElement('article');
  steerA.textContent = '补充要求 A';
  steerB.textContent = '补充要求 B';
  update({
    turn: { ...turn, status: 'completed',
      timing: { startedAt: 1000, endedAt: 9000, evidence: 'observed' } },
    group: completedGroup, input, items: [first, between, last],
    steers: [steerA, steerB],
    workOrder: [
      { activityId: first.id, ...first.position },
      { node: steerA, steer: true, startedAt: 2000, steerKey: 'a' },
      { activityId: between.id, ...between.position },
      { node: steerB, steer: true, startedAt: 6000, steerKey: 'b' },
      { activityId: last.id, ...last.position },
    ],
  });
  const titles = [...node.querySelectorAll('.execution-activity-group .execution-head-title')]
    .map(entry => entry.textContent);
  // 主折叠覆盖整轮 8s；第一段补充执行只到下一个 steer 前，不借用整轮终点。
  assert.deepEqual(titles, ['执行了 8 秒', '继续执行了 1.5 秒', '继续执行了 3 秒']);
  const flow = node.querySelector('[data-execution-part="activity-flow"]');
  const order = [...flow.children];
  assert.ok(order.includes(steerA) && order.includes(steerB));
  assert.ok(order.indexOf(steerA) < order.indexOf(steerB));
  // 补充输入是真实用户行，留在两段折叠之间且默认可见。
  assert.equal(steerA.closest('[data-execution-part="progress"]'), null);
  assert.equal(steerB.closest('[data-execution-part="progress"]'), null);
  assert.equal(steerA.closest('[hidden]'), null);
  assert.equal(steerB.closest('[hidden]'), null);
  // 正常完成后过程默认折叠，时长与状态仍可从折叠头读到。
  const heads = [...node.querySelectorAll('.execution-activity-group > button')];
  assert.ok(heads.every(head => head.getAttribute('aria-expanded') === 'false'));
  assert.match(heads[0].title, /执行了 8 秒/);
});

test('opens a stable 40-row window and releases native details when the window is hidden', async t => {
  const { document, node, update } = await surface(t);
  const input = document.createElement('div');
  const origin = document.createElement('div');
  const native = document.createElement('div');
  origin.append(native);
  document.body.append(origin);
  const details = new Map([['item-1961', native]]);
  const items = Array.from({ length: 2000 }, (_, index) => activity('item-' + (index + 1), index + 1));
  update({ turn, group, items, input, details });
  const trigger = node.querySelector('.execution-activity-group > button');
  const rows = () => [...node.querySelectorAll('.execution-activity-item')];
  // 运行中的组默认已经展开；仅在折叠时补一次用户点击。
  if (trigger.getAttribute('aria-expanded') === 'false') trigger.click();
  assert.equal(rows().length, 40);
  assert.match(rows()[0].textContent, /item-1961/);
  rows()[0].querySelector('button').click();
  assert.ok(rows()[0].contains(native));

  const earlier = node.querySelector('.execution-activity-earlier');
  const newer = node.querySelector('.execution-activity-more');
  assert.match(earlier.textContent, /1921–1960/);
  earlier.click();
  assert.equal(rows().length, 40);
  assert.match(rows()[0].textContent, /item-1921/);
  assert.ok(origin.contains(native));
  newer.click();
  assert.equal(rows()[0].querySelector('button').getAttribute('aria-expanded'), 'true');
  assert.ok(rows()[0].contains(native));

  trigger.click();
  assert.equal(rows().length, 0);
  assert.ok(origin.contains(native));
  trigger.click();
  assert.ok(rows()[0].contains(native));
  update({ turn, group, input, details, items: [...items, activity('item-2001', 2001)] });
  assert.equal(rows().length, 40);
  assert.match(rows()[0].textContent, /item-1961/);
  assert.match(newer.textContent, /2001–2001/);

  const settled = await surface(t);
  settled.update({ turn: { ...turn, status: 'completed' }, group: { ...group, status: 'completed' },
    items, input: settled.document.createElement('div') });
  settled.node.querySelector('.execution-activity-group > button').click();
  assert.equal(settled.node.querySelectorAll('.execution-activity-item').length, 40);
  assert.match(settled.node.querySelector('.execution-activity-item').textContent, /item-1已完成/);
});

test('reuses Plan rows, reveals a later parallel item and respects an explicit disclosure choice', async t => {
  const { document, node, update } = await surface(t);
  const { renderPlan, updatePlan } = await import('../public/plan-view.js');
  global.document = document;
  t.after(() => { delete global.document; });
  const tasks = Array.from({ length: 12 }, (_, i) => ({
    id: String(i), title: '任务 ' + (i + 1), status: i === 0 || i === 11 ? 'in_progress' : 'pending',
  }));
  const plan = renderPlan({ tasks, completed: 0, total: tasks.length });
  update({ turn, plan });
  const list = node.querySelector('.plan-list');
  assert.equal(list.querySelectorAll(':scope > :not([hidden])').length, 10);
  assert.match(plan.querySelector('.execution-plan-parallel').textContent, /2 项进行中/);
  plan.querySelector('.execution-plan-more').click();
  assert.equal(list.querySelectorAll(':scope > :not([hidden])').length, 12);
  const first = list.firstElementChild;
  const completed = tasks.map(task => ({ ...task, status: 'completed' }));
  updatePlan(plan, { tasks: completed, completed: 12, total: 12 });
  update({ turn: { ...turn, status: 'completed' }, plan });
  assert.ok(list.hidden);
  const trigger = plan.querySelector('.plan-head');
  trigger.click();
  update({ turn: { ...turn, status: 'completed' }, plan });
  assert.ok(!list.hidden);
  assert.equal(list.firstElementChild, first);
});

test('uses authorized file facts without exposing restricted detail', async t => {
  const { document, node, update } = await surface(t);
  global.document = document;
  t.after(() => { delete global.document; });
  const input = document.createElement('div');
  const edit = activity('item-1', 1, {
    title: '修改文件', summary: { fileName: 'contract.js', requestedRange: { start: 10 }, diffStat: { added: 6, removed: 3 } },
    detailRef: { state: 'restricted' },
  });
  update({ turn: { ...turn, status: 'completed' }, group, items: [edit], input });
  const workHead = node.querySelector('.execution-activity-group > button');
  if (workHead.getAttribute('aria-expanded') === 'false') workHead.click();
  const row = node.querySelector('.execution-activity-item button');
  assert.match(row.textContent, /contract\.js.*请求 10.*\+6 −3/);
  row.click();
  assert.match(row.parentElement.textContent, /当前视图无权读取详情/);
  assert.equal(node.querySelector('.execution-usage'), null);
});
