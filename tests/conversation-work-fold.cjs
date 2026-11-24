'use strict';

/* Native work-log fold behavior: the fold title comes from the owning real
 * user turn, never from tool counts or a neighbouring message. Supplemental
 * user inputs keep their own segment and stay visible. */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

async function surface(t) {
  const dom = new JSDOM('<div class="thread"></div>', {
    url: 'http://fixture.invalid/', pretendToBeVisual: true,
  });
  global.document = dom.window.document;
  global.window = dom.window;
  t.after(() => { dom.window.close(); delete global.document; delete global.window; });
  const document = dom.window.document;
  const flow = await import('../public/conversation-work-log.js');
  const tool = await import('../public/tool-view.js');
  return { document, parent: document.querySelector('.thread'), ...flow, ...tool };
}

function user(document, { start, end, status, continued = false } = {}) {
  const node = document.createElement('article');
  node.className = 'msg user';
  node.textContent = '任务';
  if (Number.isFinite(start)) node.dataset.turnStartAt = String(start);
  if (Number.isFinite(end)) node.dataset.turnEndedAt = String(end);
  if (status) node.dataset.turnStatus = status;
  if (continued) node.dataset.turnContinued = '';
  return node;
}

function group(s, id, statuses, names = []) {
  const value = s.createGroup();
  value.dataset.anchorId = id;
  for (const [index, status] of statuses.entries()) {
    const name = names[index] || (index ? 'bash' : 'read');
    const args = name === 'read' ? { path: 'src/' + index + '.js' } : { command: 'npm test' };
    s.addToGroup(value, s.renderEntry({
      id: id + ':' + index, name, label: name === 'read' ? '读取文件' : '运行命令',
      known: true, status, args, output: '', summary: name === 'read' ? args.path : args.command,
      path: name === 'read' ? args.path : '', durationMs: 20,
    }));
  }
  return value;
}

test('labels a completed native turn with wall-clock time and a distinct file count', async t => {
  const s = await surface(t);
  s.parent.append(user(s.document, { start: 1000, end: 5000, status: 'completed' }),
    group(s, 'tools', ['success', 'success'], ['read', 'read']));
  const flow = s.createConversationFlow();
  flow.render(s.parent);
  const log = s.parent.querySelector('[data-conversation-work]');
  assert.ok(log);
  const head = log.querySelector('.conversation-work-head');
  assert.equal(log.querySelector('.conversation-work-title').textContent, '执行了 4 秒');
  assert.match(log.textContent, /读取 2 个文件/);
  assert.match(log.textContent, /2 次工具/);
  assert.equal(head.getAttribute('aria-expanded'), 'false', 'normal completion folds the work');
  head.click();
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.equal(log.querySelector('.conversation-work-list').hidden, false);
});

test('keeps a folded tool failure perceivable without repeating a success label', async t => {
  const s = await surface(t);
  s.parent.append(user(s.document, { start: 1000, end: 5000, status: 'completed' }),
    group(s, 'tools', ['success', 'error']));
  const flow = s.createConversationFlow();
  flow.render(s.parent);
  const log = s.parent.querySelector('[data-conversation-work]');
  const head = log.querySelector('.conversation-work-head');
  assert.equal(log.querySelector('.conversation-work-title').textContent, '执行了 4 秒 · 1 项失败');
  assert.equal(log.dataset.attention, 'true');
  assert.equal(log.querySelector('.conversation-work-icon').dataset.icon, 'circleAlert');
  assert.equal(head.getAttribute('aria-expanded'), 'true', 'abnormal folded work opens for inspection');
  assert.doesNotMatch(log.querySelector('.conversation-work-title').textContent, /成功|已完成/);
});

test('uses the turn outcome for failure and stop wording', async t => {
  const s = await surface(t);
  s.parent.append(user(s.document, { start: 1000, end: 5000, status: 'failed' }),
    group(s, 'failed', ['error']));
  s.parent.append(user(s.document, { start: 6000, end: 9000, status: 'cancelled' }),
    group(s, 'stopped', ['interrupted']));
  const flow = s.createConversationFlow();
  flow.render(s.parent);
  const titles = [...s.parent.querySelectorAll('.conversation-work-title')].map(node => node.textContent);
  assert.deepEqual(titles, ['执行失败 · 用时 4 秒', '你在 3 秒后停止']);
  const icons = [...s.parent.querySelectorAll('.conversation-work-icon')].map(node => node.dataset.icon);
  assert.deepEqual(icons, ['circleAlert', 'stop']);
});

test('keeps a lone tool native when there is no turn timing evidence', async t => {
  const s = await surface(t);
  const tools = group(s, 'tools', ['success']);
  s.parent.append(user(s.document), tools);
  const flow = s.createConversationFlow();
  flow.render(s.parent);
  assert.equal(s.parent.querySelector('[data-conversation-work]'), null);
  assert.strictEqual(tools.parentElement, s.parent);
});

test('wraps multiple untimed tools under the plain work-log label', async t => {
  const s = await surface(t);
  s.parent.append(user(s.document), group(s, 'tools', ['success', 'success']));
  const flow = s.createConversationFlow();
  flow.render(s.parent);
  const log = s.parent.querySelector('[data-conversation-work]');
  assert.ok(log);
  assert.equal(log.querySelector('.conversation-work-title').textContent, '工作记录');
  assert.equal(log.querySelector('.conversation-work-head').getAttribute('aria-expanded'), 'false');
});

test('counts every abnormal tool instead of deduplicating status types and opens cancelled work', async t => {
  const s = await surface(t);
  s.parent.append(user(s.document, { start: 1000, end: 5000, status: 'completed' }),
    group(s, 'many', ['error', 'error', 'interrupted', 'cancelled', 'incomplete', 'success']));
  const flow = s.createConversationFlow();
  flow.render(s.parent);
  const log = s.parent.querySelector('[data-conversation-work]');
  const title = log.querySelector('.conversation-work-title').textContent;
  assert.match(title, /2 项失败/);
  assert.match(title, /1 项中断/);
  assert.match(title, /1 项取消/);
  assert.match(title, /1 项未完成/);
  assert.equal(log.dataset.attention, 'true');
  assert.equal(log.querySelector('.conversation-work-head').getAttribute('aria-expanded'), 'true');
  assert.match(log.querySelector('.conversation-work-state').textContent, /失败 2.*已中断 1.*已取消 1.*未完成 1/);
});

test('cancelled work opens by default and keeps a stop icon', async t => {
  const s = await surface(t);
  s.parent.append(user(s.document, { start: 1000, end: 5000, status: 'completed' }),
    group(s, 'cancelled', ['cancelled', 'success']));
  const flow = s.createConversationFlow();
  flow.render(s.parent);
  const log = s.parent.querySelector('[data-conversation-work]');
  assert.equal(log.dataset.status, 'cancelled');
  assert.equal(log.querySelector('.conversation-work-icon').dataset.icon, 'stop');
  assert.equal(log.querySelector('.conversation-work-head').getAttribute('aria-expanded'), 'true');
});

test('resolves ownership from ordered detached nodes and re-confirms it on update', async t => {
  const s = await surface(t);
  const input = user(s.document, { start: 1000, end: 5000, status: 'completed' });
  const tools = group(s, 'detached', ['success', 'success']);
  const flow = s.createConversationFlow();
  /* Runtime builds this batch before mounting. Ownership must come from the
   * ordered nodes, not from previousElementSibling (which is null here). */
  flow.render(s.parent, [input, tools]);
  const log = s.parent.querySelector('[data-conversation-work]');
  assert.equal(log.querySelector('.conversation-work-title').textContent, '执行了 4 秒');
  assert.equal(tools.parentElement, log.querySelector('.conversation-work-list'));

  /* A later authoritative timing update re-reads the same owner from the
   * caller's order and refreshes the label without recreating the log. */
  input.dataset.turnEndedAt = '12500';
  flow.render(s.parent, [input, tools]);
  assert.strictEqual(s.parent.querySelector('[data-conversation-work]'), log);
  assert.equal(log.querySelector('.conversation-work-title').textContent, '执行了 12 秒');
});

test('never borrows timing across a following execution boundary or another session', async t => {
  const s = await surface(t);
  const a = user(s.document, { start: 1000, end: 2000, status: 'completed' });
  const aTools = group(s, 'a', ['success', 'success']);
  const other = user(s.document, { start: 9000, end: 12000, status: 'completed' });
  const bTools = group(s, 'b', ['success', 'success']);
  const flow = s.createConversationFlow();
  flow.render(s.parent, [a, aTools]);
  assert.equal(s.parent.querySelector('.conversation-work-title').textContent, '执行了 1 秒');

  /* Two independent flows stand in for switching conversations: the second
   * flow has its own ordered nodes and must never reuse A's clock. */
  const otherParent = s.document.createElement('div');
  otherParent.className = 'thread';
  const foreignFlow = s.createConversationFlow();
  foreignFlow.render(otherParent, [other, bTools]);
  const title = otherParent.querySelector('.conversation-work-title').textContent;
  assert.match(title, /执行了 3 秒/);
  assert.doesNotMatch(title, /1 秒/);

  /* A hard execution boundary without a user node owns no turn timing. */
  const boundaryParent = s.document.createElement('div');
  const boundary = s.document.createElement('div');
  boundary.className = 'execution-turn';
  const boundaryTools = group(s, 'boundary', ['success', 'success']);
  boundaryParent.append(a, boundary);
  foreignFlow.render(boundaryParent, [a, boundary, boundaryTools]);
  const boundaryLog = boundaryParent.querySelector('[data-conversation-work]');
  assert.equal(boundaryLog.querySelector('.conversation-work-title').textContent, '工作记录');
});

test('gives each supplemental input its own timed fold while keeping the user row visible', async t => {
  const s = await surface(t);
  const first = user(s.document, { start: 1000, end: 7000, status: 'completed' });
  const steer = user(s.document, { start: 3000, end: 7000, status: 'completed', continued: true });
  steer.textContent = '补充要求';
  const firstTools = group(s, 'first', ['success', 'success']);
  const secondTools = group(s, 'second', ['success']);
  s.parent.append(first, firstTools, steer, secondTools);
  const flow = s.createConversationFlow();
  flow.render(s.parent);
  const logs = [...s.parent.querySelectorAll('[data-conversation-work]')];
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map(log => log.querySelector('.conversation-work-title').textContent),
    ['执行了 6 秒', '继续执行了 4 秒']);
  assert.strictEqual(steer.parentElement, s.parent, 'the supplemental user input is not folded');
  assert.equal(steer.closest('[hidden]'), null);
  const order = [...s.parent.children];
  assert.ok(order.indexOf(logs[0]) < order.indexOf(steer));
  assert.ok(order.indexOf(steer) < order.indexOf(logs[1]));
});
