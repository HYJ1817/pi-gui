/* Agent 执行过程 UI：任务列表、工具折叠文案、回到底部按钮。
 *
 * 分三层：
 *   1. 纯契约：Pi 扩展的校验/保留规则、服务端 Runtime 窄投影、前端历史归并；
 *   2. 真实模块 + jsdom：Classic 实时/历史、Runtime store/view、多会话隔离、
 *      滚动按钮只操作传入的容器；
 *   3. CSS 契约：默认折叠、长标题换行、44px 圆钮、hover 箭头、reduced-motion。
 *
 * jsdom 不做布局也不跑动画，所以像素级验收不在这里假装完成；真实截图由
 * 浏览器验收集另行产出。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const url = rel => pathToFileURL(path.join(PUB, rel)).href;
const serverUrl = rel => pathToFileURL(path.join(ROOT, rel)).href;
const text = value => ({ type: 'text', text: value });

let passed = 0, failed = 0;
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
  const ext = await import(pathToFileURL(path.join(ROOT, 'extensions/pi-gui-plan/index.js')).href);
  const projection = await import(serverUrl('server/plan-projection.js'));

  /* ================= 1. 扩展：真实状态机 ================= */
  console.log('Pi 扩展契约');
  const tasks = (...items) => ({ tasks: items.map(([id, status, title = id]) => ({ id, title, status })) });

  function extensionHarness(branch = []) {
    const handlers = new Map(), tools = new Map();
    const pi = { on: (name, fn) => handlers.set(name, fn), registerTool: tool => tools.set(tool.name, tool) };
    ext.default(pi);
    const ctx = { sessionManager: { getBranch: () => branch } };
    const exec = tools.get('gui_plan').execute;
    const fire = (name, event = {}) => handlers.get(name)?.(event, ctx);
    return { tools, exec, fire, ctx };
  }

  deep(ext.normalizePlanInput({ tasks: [{ id: 'a', title: 'A', status: 'running' }] }).tasks[0].status,
    'in_progress', '扩展把 running 归一成 in_progress');
  ok('扩展拒绝空列表', ext.normalizePlanInput({ tasks: [] }).ok === false);
  ok('扩展拒绝重复 id', ext.normalizePlanInput(tasks(['a', 'pending'], ['a', 'completed'])).ok === false);
  ok('扩展拒绝未知状态', ext.normalizePlanInput(tasks(['a', 'finished'])).ok === false);
  ok('扩展拒绝无标题任务', ext.normalizePlanInput({ tasks: [{ id: 'a', title: '  ', status: 'pending' }] }).ok === false);

  {
    const h = extensionHarness();
    await h.fire('session_start');
    await h.fire('before_agent_start', { messageType: 'user' });
    const first = await h.exec('c1', tasks(['a', 'in_progress'], ['b', 'pending']));
    equal(first.details.counts.total, 2, '首次调用建立完整任务列表');
    equal(first.details.counts.completed, 0, '首次调用不伪造完成数');
    await h.exec('c2', tasks(['a', 'completed'], ['b', 'in_progress']));
    const replanned = await h.exec('c3', tasks(['b', 'pending'], ['c', 'pending']));
    deep(replanned.details.tasks.map(t => [t.id, t.status, t.retained === true]),
      [['b', 'pending', false], ['c', 'pending', false], ['a', 'completed', true]],
      '重新规划漏掉已完成任务时保留真实完成记录');
    await h.fire('agent_settled');
    await h.fire('before_agent_start', { messageType: 'user' });
    const nextTurn = await h.exec('c4', tasks(['d', 'pending']));
    deep(nextTurn.details.tasks.map(t => t.id), ['d'], '新一轮不复用上一轮完成记录');
    const bad = await h.exec('c5', tasks(['x', 'pending'], ['x', 'pending']));
    ok('非法更新返回 isError，而不是静默修数据', bad.isError === true && bad.details.error === 'invalid_plan');
  }

  {
    const branch = [{ type: 'message', message: { role: 'toolResult', toolName: 'gui_plan', details: {
      version: 1, tool: 'gui_plan', tasks: [{ id: 'done', title: '已完成', status: 'completed' }],
      counts: { total: 1, completed: 1 }, revision: 4, updatedAt: 1,
    } } }];
    const h = extensionHarness(branch);
    await h.fire('session_start');
    const next = await h.exec('c1', tasks(['todo', 'pending']));
    deep(next.details.tasks.map(t => [t.id, t.retained === true]), [['todo', false], ['done', true]],
      '扩展重启后从真实 toolResult details 重建并保留完成项');
  }

  /* ================= 2. 服务端 Runtime 窄投影 ================= */
  console.log('Runtime 计划投影');
  const planArgs = { tasks: [
    { id: 'a', title: 'A', status: 'in_progress', secret: 'drop-me' },
    { id: 'b', title: 'B', status: 'completed' },
  ], explanation: 'note', extra: 'drop-me' };
  const projected = projection.projectPlanArgs('gui_plan', planArgs);
  equal(projected.tasks.length, 2, '只投影白名单任务字段');
  ok('未知字段被丢弃', !('extra' in projected) && !('secret' in projected.tasks[0]) && !('explanation' in projected.tasks[0]));
  equal(projected.counts.completed, 1, '投影重算完成数');
  ok('非计划工具不投影', projection.projectPlanArgs('bash', planArgs) === null);
  ok('非法状态整体拒绝', projection.projectPlanArgs('gui_plan', tasks(['a', 'finished'])) === null);
  ok('超过 100 项整体拒绝', projection.projectPlanArgs('gui_plan', { tasks: Array.from({ length: 101 }, (_, i) => ({ id: 't' + i, title: 'T', status: 'pending' })) }) === null);
  equal(projection.projectPlanArgs('gui_plan', { tasks: [{ id: 'a', title: 'x'.repeat(500), status: 'pending' }] }).tasks[0].title.length,
    300, '长标题按上限截断而不是无限转发');
  ok('结果投影必须带 tool + version', projection.projectPlanResult({ details: { version: 1, tasks: planArgs.tasks } }) === null
    && projection.projectPlanResult({ details: { tool: 'gui_plan', version: 2, tasks: planArgs.tasks } }) === null);
  equal(projection.projectPlanResult({ details: { tool: 'gui_plan', version: 1, tasks: planArgs.tasks, revision: 7 } }).revision,
    7, '合法结果投影保留真实 revision');

  /* ================= 3. Runtime 出站边界 ================= */
  console.log('Runtime 事件出站边界');
  const { projectRuntimeEvent } = await import(serverUrl('server/session-runtime.js'));
  const startProjected = projectRuntimeEvent({ type: 'tool_execution_start', toolCallId: 'p', toolName: 'gui_plan',
    args: planArgs, bridgeRun: 1 });
  ok('gui_plan start 只带白名单计划，不带原始 args', startProjected.plan?.tasks?.length === 2 && !('args' in startProjected));
  const readProjected = projectRuntimeEvent({ type: 'tool_execution_start', toolCallId: 't', toolName: 'read',
    args: { path: '/private/secret.txt' }, bridgeRun: 1 });
  ok('其它工具的 args 仍然被剥掉，也不产生 plan', !('args' in readProjected) && !('plan' in readProjected));
  const endProjected = projectRuntimeEvent({ type: 'tool_execution_end', toolCallId: 'p', isError: false,
    result: { details: { version: 1, tool: 'gui_plan', tasks: planArgs.tasks } }, bridgeRun: 1 });
  ok('gui_plan end 按 details 契约投影，不带原始 result', endProjected.plan?.counts?.completed === 1 && !('result' in endProjected));

  /* ================= 4. 前端历史归并 ================= */
  console.log('计划历史归并');
  const PM = await import(url('plan-model.js'));
  const norm = PM.normalizePlan({ tasks: [
    { id: 'a', title: 'A', status: 'completed' },
    { id: 'b', title: 'B', status: 'running', retained: true },
  ] });
  equal(norm.tasks[1].status, 'in_progress', '前端同样归一 running');
  equal(norm.completed, 1, '前端按真实状态重算完成数');
  ok('前端拒绝重复 id', PM.normalizePlan(tasks(['a', 'pending'], ['a', 'pending'])) === null);
  const entryDetails = { name: 'gui_plan', args: tasks(['a', 'pending']), details: {
    version: 1, tool: 'gui_plan', tasks: [{ id: 'a', title: 'A', status: 'completed' }],
  } };
  equal(PM.planFromToolEntry(entryDetails).tasks[0].status, 'completed', 'details 优先于 args（结束后的权威状态）');
  equal(PM.planFromToolEntry({ name: 'gui_plan', args: tasks(['a', 'in_progress']), details: null }).tasks[0].status,
    'in_progress', '未完成调用退回 args（模型确实提交过）');
  ok('非计划 entry 不产生计划', PM.planFromToolEntry({ name: 'read', args: planArgs }) === null);
  ok('结束结果明确拒绝时不回退到 args',
    PM.planFromToolEntry({ name: 'gui_plan', args: planArgs,
      details: { version: 1, tool: 'gui_plan', error: 'invalid_plan' } }) === null);

  /* ================= 5. jsdom：Classic / Runtime / 按钮 ================= */
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document;
  global.window = w; global.document = d; global.localStorage = w.localStorage;
  global.HTMLElement = w.HTMLElement; global.Event = w.Event; global.CustomEvent = w.CustomEvent;
  global.Node = w.Node; global.MutationObserver = w.MutationObserver; global.ResizeObserver = w.ResizeObserver;
  global.requestAnimationFrame = w.requestAnimationFrame.bind(w);
  global.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.fetch = async () => ({ ok: true, json: async () => ({ ok: true, files: [], isRepo: false }) });
  global.fetch = w.fetch;

  const M = await import(url('messages.js'));
  const T = await import(url('tools.js'));
  const P = await import(url('plan-live.js'));
  const { S } = await import(url('state.js'));
  const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

  console.log('Classic 历史');
  const planCall = (id, value) => ({ type: 'toolCall', id, name: 'gui_plan', arguments: value });
  const planResult = (id, value) => ({ role: 'toolResult', toolCallId: id, toolName: 'gui_plan',
    content: [text('ok')], details: { version: 1, tool: 'gui_plan', ...value } });
  const userMsg = value => ({ role: 'user', content: [text(value)] });
  const assistantTools = (...calls) => ({ role: 'assistant', content: calls, stopReason: 'stop' });
  const fullPlan = status => ({ tasks: [
    { id: 'inspect', title: '检查现有实现', status: 'completed' },
    { id: 'build', title: '实现并验证', status },
  ], counts: { total: 2, completed: 1 } });

  M.rebuildFromMessages([
    userMsg('做一个复杂任务'),
    assistantTools(planCall('p1', fullPlan('in_progress'))),
    planResult('p1', fullPlan('in_progress')),
  ]);
  equal(d.querySelectorAll('#stream .plan-card').length, 1, '历史里一张计划卡');
  equal(d.querySelectorAll('#stream .plan-item').length, 2, '计划行来自真实 details');
  equal(d.querySelector('#stream .plan-count').textContent, '1/2', '历史计数来自真实状态');
  equal(d.querySelectorAll('#stream .tl-item').length, 0, 'gui_plan 不再重复占据工具时间线');
  equal(d.querySelector('#stream .plan-head').getAttribute('aria-expanded'), 'true', '计划默认展开');

  M.rebuildFromMessages([
    userMsg('同一回合重新规划'),
    assistantTools(planCall('p1', fullPlan('in_progress'))),
    planResult('p1', fullPlan('in_progress')),
    assistantTools(planCall('p2', { tasks: [
      { id: 'inspect', title: '检查现有实现', status: 'completed' },
      { id: 'build', title: '实现并验证', status: 'completed' },
      { id: 'early', title: '早期完成项', status: 'completed', retained: true },
    ] })),
    planResult('p2', { tasks: [
      { id: 'inspect', title: '检查现有实现', status: 'completed' },
      { id: 'build', title: '实现并验证', status: 'completed' },
      { id: 'early', title: '早期完成项', status: 'completed', retained: true },
    ] }),
  ]);
  equal(d.querySelectorAll('#stream .plan-card').length, 1, '同一用户回合只显示一张计划卡');
  equal(d.querySelector('#stream .plan-count').textContent, '3/3', '卡内容取该回合最后一次有效更新');
  equal(d.querySelectorAll('#stream .plan-item[data-status="completed"]').length, 3, '保留的真实完成项全部显示');

  M.rebuildFromMessages([
    userMsg('第一回合'), assistantTools(planCall('p1', fullPlan('completed'))), planResult('p1', fullPlan('completed')),
    userMsg('第二回合'), assistantTools(planCall('p2', { tasks: [{ id: 'next', title: '下一件事', status: 'pending' }] })),
    planResult('p2', { tasks: [{ id: 'next', title: '下一件事', status: 'pending' }] }),
  ]);
  equal(d.querySelectorAll('#stream .plan-card').length, 2, '不同用户回合各自保留计划卡');
  equal(d.querySelectorAll('#stream .tl-item').length, 0, '两回合的计划工具都不进工具行');

  M.rebuildFromMessages([
    userMsg('非法计划不应画卡'),
    assistantTools(planCall('bad', { tasks: [{ id: 'x', title: 'X', status: 'finished' }] })),
    { role: 'toolResult', toolCallId: 'bad', toolName: 'gui_plan', content: [text('invalid')], isError: true,
      details: { version: 1, tool: 'gui_plan', error: 'invalid_plan' } },
  ]);
  equal(d.querySelectorAll('#stream .plan-card').length, 0, '失败/非法计划不画任务列表');

  M.rebuildFromMessages([
    userMsg('有合法 args 但扩展拒绝'),
    assistantTools(planCall('rejected', fullPlan('in_progress'))),
    { role: 'toolResult', toolCallId: 'rejected', toolName: 'gui_plan', content: [text('invalid')], isError: true,
      details: { version: 1, tool: 'gui_plan', error: 'invalid_plan' } },
  ]);
  equal(d.querySelectorAll('#stream .plan-card').length, 0, '扩展明确拒绝的结果不能回退 args 画卡');

  console.log('Classic 实时');
  M.clearThread();
  M.onMessageStart({ message: userMsg('实时任务') });
  T.onToolStart({ toolCallId: 'live-p1', toolName: 'gui_plan', args: fullPlan('in_progress') });
  equal(d.querySelectorAll('#stream .plan-card').length, 1, 'gui_plan start 立即出现任务列表');
  equal(S.tools.has('live-p1'), false, 'gui_plan 不注册工具条目');
  T.onToolEnd({ toolCallId: 'live-p1', isError: false, result: { details: { version: 1, tool: 'gui_plan', ...fullPlan('completed') } } });
  equal(d.querySelector('#stream .plan-count').textContent, '2/2', 'tool end 后按权威 details 更新');
  ok('完成后不留下 in_progress 文案', !d.querySelector('#stream .plan-state') || d.querySelector('#stream .plan-state').textContent === '');

  /* 运行中的补充指令是 steer：Pi 不会发新的 agent_start，所以它**不是**新任务。
   * 同一张卡继续更新，不能被误清空或另开一张。 */
  M.onMessageStart({ message: userMsg('运行中的补充指令') });
  T.onToolStart({ toolCallId: 'live-p2', toolName: 'gui_plan', args: { tasks: [{ id: 'n', title: '补充后的步骤', status: 'in_progress' }] } });
  equal(d.querySelectorAll('#stream .plan-card').length, 1, '运行中 steer 不新开卡');
  equal([...d.querySelectorAll('#stream .plan-card')].at(-1).querySelector('.plan-title')?.textContent || '',
    '任务列表', 'steer 后仍更新同一张当前卡');
  ok('steer 后当前卡显示补充后的真实任务', d.querySelector('#stream .plan-list')?.textContent.includes('补充后的步骤') === true);

  /* 真正的新任务：上一轮已经 settled，app.js 在随后的 agent_start 上打边界，
   * 再由用户消息消费。这里直接调用同一个边界钩子，避免把 app.js 的整棵
   * DOM 初始化搬进单测；顺序与真实事件一致：settled → agent_start → user。 */
  P.beginPlanTaskBoundary();
  M.onMessageStart({ message: userMsg('第二个实时任务') });
  T.onToolStart({ toolCallId: 'live-p3', toolName: 'gui_plan', args: { tasks: [{ id: 'n2', title: '新回合步骤', status: 'in_progress' }] } });
  equal(d.querySelectorAll('#stream .plan-card').length, 2, '真实新回合开新卡，旧卡保留');
  ok('旧卡保留的是上一轮真实任务，不被新回合覆盖',
    d.querySelectorAll('#stream .plan-card')[0].textContent.includes('补充后的步骤'));
  ok('新卡显示新回合的真实任务', d.querySelectorAll('#stream .plan-card')[1].textContent.includes('新回合步骤'));
  M.interruptActive();
  equal([...d.querySelectorAll('#stream .plan-card')].at(-1).querySelector('.plan-state').textContent,
    '未完成', '中断后 in_progress 显示「未完成」而不是继续转');

  M.clearThread();
  M.onMessageStart({ message: userMsg('非法实时计划') });
  T.onToolStart({ toolCallId: 'bad-p', toolName: 'gui_plan', args: { tasks: [] } });
  T.onToolEnd({ toolCallId: 'bad-p', isError: true, result: { details: { version: 1, tool: 'gui_plan', error: 'invalid_plan' } } });
  equal(d.querySelectorAll('#stream .plan-card').length, 0, '首次调用就非法时不留下空卡');

  console.log('Runtime store');
  const { runtimeStore, seedRuntimeSnapshot, observeRuntimeFrame } = await import(url('runtime-state.js'));
  const owner = (id, gen = 'one') => ({ backendInstance: 'backend', projectId: 'project', repoId: 'repo', workspaceId: 'ws-' + id,
    workspaceEpoch: 'epoch', conversationId: id, runtimeId: 'rt-' + id, runtimeGeneration: gen, sessionId: 's-' + id });
  const item = (id, over = {}) => ({ conversationId: id, createdAt: '2026-01-01T00:00:00.000Z',
    workspace: { branch: 'branch-' + id, projectId: 'project' }, owner: owner(id), lifecycle: 'ready',
    activity: 'idle', attention: false, error: null, stop: null, revision: 1, ...over });
  runtimeStore.seed({ backendInstance: 'backend', items: [item('A'), item('B')] });
  const frame = (id, seq, event) => observeRuntimeFrame({ type: 'runtime_event', owner: owner(id), eventSequence: seq, event });

  /* 一个完整 run：agent_start → plan → 运行中 steer → 自动重试 → settled →
   * 新的 agent_start（真正的新任务）→ 新 plan。回合边界只由 Pi 的协议事件决定。 */
  frame('A', 1, { type: 'agent_start' });
  frame('A', 2, { type: 'tool_execution_start', toolCallId: 'p', toolName: 'gui_plan', plan: { version: 1, tasks: [
    { id: 'a', title: 'A 步骤', status: 'in_progress' },
  ], counts: { total: 1, completed: 0 } } });
  equal(runtimeStore.get('A').plan.tasks[0].id, 'a', 'Runtime store 接收按白名单投影的计划');
  equal(runtimeStore.get('A').tools.length, 0, 'Runtime 工具行不收录 gui_plan');
  frame('A', 3, { type: 'tool_execution_end', toolCallId: 'p', toolName: 'gui_plan', plan: { version: 1, tasks: [
    { id: 'a', title: 'A 步骤', status: 'completed' },
  ], counts: { total: 1, completed: 1 } } });
  equal(runtimeStore.get('A').plan.tasks[0].status, 'completed', 'Runtime end 用权威 details 覆盖');
  frame('A', 4, { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '运行中补充' }] } });
  equal(runtimeStore.get('A').plan.tasks[0].status, 'completed', '运行中 steer 的用户消息不清当前计划');
  frame('A', 5, { type: 'agent_start' });
  equal(runtimeStore.get('A').plan.tasks[0].status, 'completed', '自动重试/压缩的 agent_start 不清当前计划');
  frame('A', 6, { type: 'agent_settled' });
  equal(runtimeStore.get('A').plan.tasks[0].status, 'completed', 'settled 不清掉真实计划');
  frame('A', 7, { type: 'agent_start' });
  equal(runtimeStore.get('A').plan, null, '已 settled 后的 agent_start 才是新任务边界');
  equal(runtimeStore.get('A').timeline.filter(block => block.kind === 'plan').length, 1,
    '切换新任务时上一轮计划块仍留在时间线里');
  frame('A', 8, { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '第二个任务' }] } });
  frame('A', 9, { type: 'tool_execution_start', toolCallId: 'p2', toolName: 'gui_plan', plan: { version: 1, tasks: [
    { id: 'b', title: 'A 新计划', status: 'pending' },
  ], counts: { total: 1, completed: 0 } } });
  frame('B', 1, { type: 'tool_execution_start', toolCallId: 'q', toolName: 'gui_plan', plan: { version: 1, tasks: [
    { id: 'c', title: 'B 计划', status: 'pending' },
  ], counts: { total: 1, completed: 0 } } });
  equal(runtimeStore.get('A').plan.tasks[0].title, 'A 新计划', 'A 的计划不被 B 覆盖');
  equal(runtimeStore.get('B').plan.tasks[0].title, 'B 计划', 'B 的计划独立保存');
  equal(runtimeStore.get('A').timeline.filter(block => block.kind === 'plan').length, 2,
    '新回合的新计划是第二张卡，不是覆盖旧卡');

  const { createRuntimeConversation } = await import(url('runtime-conversation.js'));
  const host = d.createElement('div'); host.id = 'agent-plan-runtime'; d.body.appendChild(host);
  const view = createRuntimeConversation({ host });
  view.show('A'); await tick();
  equal(host.querySelectorAll('.ui2-runtime-plan .plan-card').length, 2, 'Runtime 时间线保留两轮各自的计划卡');
  ok('Runtime 计划卡显示当前会话自己的任务', host.textContent.includes('A 步骤')
    && host.textContent.includes('A 新计划') && !host.textContent.includes('B 计划'));
  view.show('B'); await tick();
  ok('切到 B 只显示 B 的计划', host.textContent.includes('B 计划') && !host.textContent.includes('A 新计划'));
  view.show('A'); await tick();
  ok('切回 A 恢复 A 的两轮计划', host.textContent.includes('A 步骤') && host.textContent.includes('A 新计划')
    && !host.textContent.includes('B 计划'));
  /* 扩展明确拒绝的更新（end 不带 plan）：start 时乐观显示的列表必须退回，
   * 不能留在界面上冒充「已被接受的计划」。与 Classic plan-live 同一语义。 */
  frame('A', 10, { type: 'tool_execution_start', toolCallId: 'rejected', toolName: 'gui_plan', plan: { version: 1, tasks: [
    { id: 'c', title: 'A 被拒绝的新计划', status: 'pending' },
  ], counts: { total: 1, completed: 0 } } });
  equal(runtimeStore.get('A').plan.tasks[0].title, 'A 被拒绝的新计划', 'Runtime start 先乐观显示提交的列表');
  frame('A', 11, { type: 'tool_execution_end', toolCallId: 'rejected', isError: true });
  equal(runtimeStore.get('A').plan.tasks[0].title, 'A 新计划', '被拒绝的 Runtime 计划更新回退到上一张');
  await tick();
  ok('被拒绝的列表没有留在 Runtime 视图', host.textContent.includes('A 新计划') && !host.textContent.includes('A 被拒绝的新计划'));
  equal(host.querySelectorAll('.ui2-runtime-plan .plan-card').length, 2, '被拒绝的更新不新增也不删除计划卡');

  /* 运行中的 steer 用户消息：同一回合，计划块必须保持可见，不能被隐藏。 */
  frame('A', 12, { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '运行中补充' }] } });
  await tick();
  ok('运行中 steer 后 Runtime 计划块保持可见', host.querySelector('.ui2-runtime-plan')?.hidden === false
    && host.querySelectorAll('.ui2-runtime-plan .plan-card').length === 2
    && [...host.querySelectorAll('.ui2-runtime-plan')].at(-1).textContent.includes('A 新计划'));
  equal(runtimeStore.get('A').plan.tasks[0].title, 'A 新计划', 'steer 不切换当前计划');

  frame('A', 13, { type: 'message_start', message: { role: 'assistant' } });
  frame('A', 14, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '可显示的思考' } });
  await tick();
  ok('Runtime 思考标题在流式中标「生成中」', host.querySelector('.ui2-runtime-thinking-head')?.textContent.includes('生成中') === true);
  frame('A', 15, { type: 'message_end', message: { role: 'assistant', stopReason: 'aborted',
    content: [{ type: 'thinking', thinking: '可显示的思考' }] } });
  await tick();
  ok('Runtime 思考被真实中断后标「已中断」，内容保留',
    host.querySelector('.ui2-runtime-thinking-head')?.textContent.includes('已中断') === true
    && host.querySelector('.ui2-runtime-thinking-body')?.textContent === '可显示的思考');
  ok('思考结束不挤掉计划块', host.querySelectorAll('.ui2-runtime-plan .plan-card').length === 2);

  /* 旧 Runtime 代次的迟到计划事件必须被挡住，不能覆盖新计划。 */
  const stalePlan = observeRuntimeFrame({ type: 'runtime_event', owner: owner('A', 'old'), eventSequence: 99,
    event: { type: 'tool_execution_start', toolCallId: 'stale', toolName: 'gui_plan', plan: { version: 1, tasks: [
      { id: 'stale', title: '旧代次计划', status: 'pending' },
    ], counts: { total: 1, completed: 0 } } } });
  await tick();
  ok('旧代次计划事件被拒绝且不进入视图', stalePlan === false
    && runtimeStore.get('A').plan.tasks[0].title === 'A 新计划'
    && !host.textContent.includes('旧代次计划')
    && host.querySelectorAll('.ui2-runtime-plan .plan-card').length === 2);

  /* 再来一次真正的新任务：settled → agent_start → user → plan。
   * 两张旧卡必须都还在，第三张卡承载新计划。 */
  frame('A', 16, { type: 'agent_settled' });
  frame('A', 17, { type: 'agent_start' });
  equal(runtimeStore.get('A').plan, null, '新任务边界清掉当前计划指针');
  await tick();
  equal(host.querySelectorAll('.ui2-runtime-plan .plan-card').length, 2, '新任务边界不删除历史计划卡');
  frame('A', 18, { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '第三个任务' }] } });
  frame('A', 19, { type: 'tool_execution_start', toolCallId: 'p3', toolName: 'gui_plan', plan: { version: 1, tasks: [
    { id: 'd', title: 'A 第三计划', status: 'in_progress' },
  ], counts: { total: 1, completed: 0 } } });
  await tick();
  const planCards = [...host.querySelectorAll('.ui2-runtime-plan .plan-card')];
  ok('第三轮新计划开第三张卡，前两轮真实计划都保留', planCards.length === 3
    && planCards[0].textContent.includes('A 步骤') && planCards[1].textContent.includes('A 新计划')
    && planCards[2].textContent.includes('A 第三计划'));
  view.dispose();

  console.log('Runtime 工具折叠与真实顺序');
  runtimeStore.seed({ backendInstance: 'backend', items: [item('T', { activity: 'running' }), item('U')] });
  const toolsHost = d.createElement('div'); d.body.appendChild(toolsHost);
  const toolsView = createRuntimeConversation({ host: toolsHost });
  const startTool = (id, name) => frame('T', ++toolSeq, { type: 'tool_execution_start', toolCallId: id, toolName: name });
  const endTool = (id, name, isError, durationMs) => frame('T', ++toolSeq, { type: 'tool_execution_end', toolCallId: id, toolName: name, isError, durationMs });
  let toolSeq = 0;
  frame('T', ++toolSeq, { type: 'agent_start' });
  frame('T', ++toolSeq, { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '执行任务' }] } });
  frame('T', ++toolSeq, { type: 'message_start', message: { role: 'assistant' } });
  frame('T', ++toolSeq, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '先想想' } });
  startTool('t1', 'bash'); startTool('t2', 'read');
  toolsView.show('T'); await tick();
  const toolGroup = () => toolsHost.querySelector('.ui2-runtime-tools .tl-group');
  const toolRows = () => [...toolsHost.querySelectorAll('.ui2-runtime-tool')];
  deep(toolRows().slice(0, 2).map(node => node.dataset.toolName), ['bash', 'read'], '组内工具保持真实调用顺序');
  equal(toolGroup().querySelector('.tl-group-head').textContent, '工具调用 · 2 次', '工具组标题显示真实次数');
  equal(toolGroup().querySelector('.ui2-tool-state').textContent, '运行中 2', '运行中的组摘要来自真实状态');
  equal(toolGroup().querySelector('.tl-list').hidden, true, '多项工具组默认折叠');
  equal(toolGroup().querySelector('.tl-group-head').getAttribute('aria-expanded'), 'false', '默认折叠时 aria-expanded=false');
  equal(toolGroup().querySelectorAll('.ui2-runtime-tool[data-tool-name="gui_plan"]').length, 0, 'gui_plan 不进入工具行');
  endTool('t2', 'read', false, 1200); endTool('t1', 'bash', true, 300);
  await tick();
  equal(toolGroup().querySelector('.ui2-tool-state').textContent, '失败 1 · 成功 1', '组摘要区分失败与成功，不靠工具调用数猜进度');

  toolGroup().querySelector('.tl-group-head').click();
  await tick();
  equal(toolGroup().querySelector('.tl-list').hidden, false, '点击组标题展开真实工具明细');
  equal(toolGroup().querySelector('.tl-group-head').getAttribute('aria-expanded'), 'true', '展开后 aria-expanded=true');
  startTool('t3', 'write');
  await tick();
  equal(toolGroup().querySelector('.tl-group-head').textContent, '工具调用 · 3 次', '新工具到达后组标题按真实次数更新');
  equal(toolGroup().querySelector('.tl-list').hidden, false, '新工具到达不打断用户已展开的组');
  equal(toolRows().at(-1).querySelector('.tl-more').hidden, true, '单条工具详情默认折叠（不伪造参数）');
  /* 正文在工具之后到达时另起一段，不能并回更早的位置而改变真实顺序。 */
  frame('T', ++toolSeq, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '阶段结论' } });
  await tick();
  const outputNodes = [...toolsHost.querySelectorAll('.rtc-output > *')];
  const kindOf = node => node.dataset?.role || (node.classList.contains('ui2-runtime-thinking') ? 'thinking'
    : node.classList.contains('ui2-runtime-tools') ? 'tools' : node.className);
  deep(outputNodes.map(kindOf), ['user', 'thinking', 'tools', 'assistant'],
    'Runtime 时间线按真实到达顺序排列 user → thinking → 工具 → 正文');

  /* 单工具组不摆「1 次」标题；详细信息仍默认收起。 */
  frame('T', ++toolSeq, { type: 'message_start', message: { role: 'assistant' } });
  startTool('s1', 'grep');
  await tick();
  const singleGroup = [...toolsHost.querySelectorAll('.ui2-runtime-tools .tl-group')].at(-1);
  equal(singleGroup.querySelector('.tl-group-head').hidden, true, '只有一项工具时不显示「工具调用 · 1 次」');
  equal(singleGroup.querySelector('.tl-list').hidden, false, '单工具行本身可见，详情默认折叠');
  equal(singleGroup.querySelector('.ui2-runtime-tool .tl-more').hidden, true, '单工具详情默认折叠');

  /* gui_plan 只呈现为计划卡，不重复出现在工具组。 */
  frame('T', ++toolSeq, { type: 'tool_execution_start', toolCallId: 'plan-t', toolName: 'gui_plan', plan: { version: 1, tasks: [
    { id: 'pt', title: '工具折叠验证', status: 'in_progress' },
  ], counts: { total: 1, completed: 0 } } });
  await tick();
  equal(toolsHost.querySelectorAll('.ui2-runtime-tool[data-tool-name="gui_plan"]').length, 0, 'gui_plan 不重复进入 Runtime 工具折叠');
  equal(toolsHost.querySelectorAll('.ui2-runtime-plan .plan-card').length, 1, 'gui_plan 只以计划卡出现一次');

  /* 展开状态按会话保存：切到 U 再切回 T，T 的组仍展开。 */
  frame('U', 1, { type: 'message_start', message: { role: 'assistant' } });
  frame('U', 2, { type: 'tool_execution_start', toolCallId: 'u1', toolName: 'bash' });
  frame('U', 3, { type: 'tool_execution_start', toolCallId: 'u2', toolName: 'read' });
  toolsView.show('U'); await tick();
  const uGroup = toolsHost.querySelector('.ui2-runtime-tools .tl-group');
  equal(uGroup.querySelector('.tl-list').hidden, true, '切到另一会话时该会话自己的组默认折叠');
  toolsView.show('T'); await tick();
  equal(toolGroup().querySelector('.tl-list').hidden, false, '切回原会话恢复用户自己的展开状态');
  toolsView.dispose();

  console.log('历史执行时间线');
  const { timelineFromMessages, boundTimeline, MAX_BLOCKS } = await import(url('runtime-timeline.js'));
  const nativeHistory = [
    { role: 'user', timestamp: 1000, content: [{ type: 'text', text: '检查并修复' }] },
    { role: 'assistant', timestamp: 1100, stopReason: 'toolUse', content: [
      { type: 'thinking', thinking: '先看代码' },
      { type: 'text', text: '我先检查' },
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'SECRET_PATH', apiKey: 'SECRET_KEY' } },
      { type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'SECRET_CMD' } },
      { type: 'toolCall', id: 'p1', name: 'gui_plan', arguments: { tasks: [{ id: 'x', title: '修复', status: 'in_progress' }] } },
    ] },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read', timestamp: 2300, isError: false,
      content: [{ type: 'text', text: 'SECRET_RESULT' + 'LONG_RAW_'.repeat(5000) }] },
    { role: 'toolResult', toolCallId: 'c2', toolName: 'bash', timestamp: 1400, isError: true, content: [{ type: 'text', text: 'SECRET_OUTPUT' }] },
    { role: 'toolResult', toolCallId: 'p1', toolName: 'gui_plan', content: [{ type: 'text', text: 'ok' }],
      details: { version: 1, tool: 'gui_plan', tasks: [{ id: 'x', title: '修复', status: 'completed' }] } },
    { role: 'assistant', timestamp: 2500, stopReason: 'stop', content: [{ type: 'text', text: '最终回答' }] },
  ];
  const recovered = timelineFromMessages(nativeHistory);
  deep(recovered.blocks.map(block => block.kind), ['user', 'thinking', 'assistant', 'tools', 'plan', 'assistant'],
    '历史按原生 message/content 顺序恢复，不按类别重排');
  deep(recovered.blocks[3].tools.map(tool => [tool.name, tool.state, tool.durationMs]),
    [['read', 'success', 1200], ['bash', 'error', 300]], '历史工具状态与耗时来自真实 toolResult');
  equal(recovered.blocks[4].plan.tasks[0].status, 'completed', '历史计划取最终 toolResult details 的真实状态');
  equal(recovered.blocks[2].text, '我先检查', '历史正文保留真实 assistant 文本');
  equal(recovered.blocks[5].text, '最终回答', '历史最终回答按真实位置恢复');
  /* content part 的真实交错顺序：工具之后的正文不能被并回工具之前。 */
  const interleaved = timelineFromMessages([
    { role: 'assistant', timestamp: 3100, stopReason: 'toolUse', content: [
      { type: 'text', text: '先说明' },
      { type: 'toolCall', id: 'i1', name: 'read', arguments: { path: 'SECRET_I1' } },
      { type: 'text', text: '工具之后' },
      { type: 'toolCall', id: 'i2', name: 'bash', arguments: { command: 'SECRET_I2' } },
    ] },
  ]);
  deep(interleaved.blocks.map(block => block.kind), ['assistant', 'tools', 'assistant', 'tools'],
    '历史保留一条 assistant 消息内 content 的真实交错顺序');
  deep(interleaved.blocks.filter(block => block.kind === 'assistant').map(block => block.text),
    ['先说明', '工具之后'], '后到的正文另起一段，不并回工具之前');
  ok('历史投影不包含工具原始参数/输出/凭据（含超长输出）', !JSON.stringify(recovered.blocks).includes('SECRET')
    && !JSON.stringify(recovered.blocks).includes('SECRET_RESULT')
    && !JSON.stringify(recovered.blocks).includes('LONG_RAW_'));
  const manyBlocks = Array.from({ length: MAX_BLOCKS + 12 }, (_, index) => ({
    kind: 'assistant', text: 'block-' + index, state: 'complete', truncated: false,
  }));
  const boundedHistory = boundTimeline(manyBlocks);
  ok('超长历史时间线有界并标记截断，保留最近记录', boundedHistory.blocks.length <= MAX_BLOCKS
    && boundedHistory.truncated === true
    && boundedHistory.blocks.at(-1).text === 'block-' + (MAX_BLOCKS + 11)
    && !boundedHistory.blocks.some(block => block.text === 'block-0'));

  /* 历史接口的 execution 走同一条投影；截断时必须明确说明，不能静默少显示。 */
  runtimeStore.seed({ backendInstance: 'backend', items: [
    item('H', { owner: null, lifecycle: 'dormant', activity: 'idle' }),
    item('K', { owner: null, lifecycle: 'dormant', activity: 'idle' }),
  ] });
  global.fetch = async (requestUrl) => ({ ok: true, json: async () => {
    const isK = String(requestUrl).includes('conversationId=K');
    return isK
      ? { ok: true, messages: [{ role: 'user', text: 'K 的历史' }], truncated: false,
        execution: { timeline: [{ id: 'k1', kind: 'user', text: 'K 的历史', truncated: false }], truncated: false } }
      : { ok: true, messages: [{ role: 'user', text: '检查并修复' }, { role: 'assistant', text: '最终回答' }], truncated: true,
        execution: { timeline: recovered.blocks, truncated: true } };
  } });
  const historyHost = d.createElement('div'); d.body.appendChild(historyHost);
  const historyView = createRuntimeConversation({ host: historyHost });
  historyView.show('H'); await tick();
  [...historyHost.querySelectorAll('button')].find(button => button.textContent === '打开历史')?.click();
  await tick(20);
  const historyKinds = [...historyHost.querySelectorAll('.rtc-output > *')].map(node => node.dataset?.role
    || (node.classList.contains('ui2-runtime-thinking') ? 'thinking'
      : node.classList.contains('ui2-runtime-tools') ? 'tools'
        : node.classList.contains('ui2-runtime-plan') ? 'plan' : node.className));
  deep(historyKinds, ['user', 'thinking', 'assistant', 'tools', 'plan', 'assistant'],
    '历史视图按恢复的时间线渲染真实顺序');
  ok('历史恢复 Thinking 可见内容', historyHost.querySelector('.ui2-runtime-thinking-body')?.textContent === '先看代码');
  ok('历史恢复工具名/状态摘要', [...historyHost.querySelectorAll('.ui2-runtime-tool')].map(node => node.dataset.toolName).join(',') === 'read,bash');
  ok('历史恢复计划与最终回答', historyHost.textContent.includes('修复') && historyHost.textContent.includes('最终回答'));
  ok('历史记录截断时明确说明', historyHost.querySelector('.rtc-state').textContent.includes('仅显示最近部分')
    && historyHost.querySelector('.rtc-state').textContent.includes('更早的执行记录已截断'));
  ok('历史视图不展示工具原始输出或参数', !historyHost.textContent.includes('SECRET'));

  historyView.show('K'); await tick(20);
  [...historyHost.querySelectorAll('button')].find(button => button.textContent === '打开历史')?.click();
  await tick(20);
  ok('切换会话后只显示 K 自己的历史，不串 H 的内容', historyHost.textContent.includes('K 的历史')
    && !historyHost.textContent.includes('最终回答') && !historyHost.textContent.includes('先看代码'));
  historyView.dispose();
  global.fetch = w.fetch;

  /* 运行态按钮不能只在 draw 里点亮一次：MutationObserver / resize 触发的 sync()
   * 会再次问 running()。Runtime 必须把「当前会话是否在运行」作为回调传进去，
   * 否则默认 false 会在下一帧把四点动画关掉（真实 Electron 验收里抓到的回归）。 */
  runtimeStore.seed({ backendInstance: 'backend', items: [item('A', { activity: 'running', revision: 2 }), item('B')] });
  const runningHost = d.createElement('div'); d.body.appendChild(runningHost);
  const runningView = createRuntimeConversation({ host: runningHost });
  await new Promise(resolve => setTimeout(resolve, 60));
  runningView.show('A');
  await new Promise(resolve => setTimeout(resolve, 60));
  const runtimeButton = runningHost.querySelector('.scroll-bottom');
  equal(runtimeButton?.dataset.running, 'true', 'Runtime 运行中按钮标记 running');
  runningView.draw();
  await new Promise(resolve => setTimeout(resolve, 60));
  equal(runtimeButton?.dataset.running, 'true', 'Runtime 重画/同步后仍保持 running');
  runningView.show('B');
  await new Promise(resolve => setTimeout(resolve, 60));
  equal(runtimeButton?.dataset.running, 'false', 'Runtime 空闲会话恢复下箭头');
  runningView.dispose();

  console.log('回到底部按钮');
  const { createScrollButton } = await import(url('scroll-button.js'));
  function fakeScroller() {
    const node = d.createElement('div');
    let top = 600;
    Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(node, 'scrollTop', { configurable: true, get: () => top, set: value => { top = value; } });
    node.scrollTo = ({ top: value }) => { top = value; };
    d.body.appendChild(node);
    return node;
  }
  const scrollerA = fakeScroller(), scrollerB = fakeScroller();
  const hostA = d.createElement('div'), hostB = d.createElement('div'); d.body.append(hostA, hostB);
  const buttonA = createScrollButton({ host: hostA, scroller: scrollerA });
  const buttonB = createScrollButton({ host: hostB, scroller: scrollerB });
  const paint = () => new Promise(resolve => setTimeout(resolve, 40));
  await paint();
  ok('贴底时按钮隐藏', !buttonA.element.classList.contains('is-visible'));
  scrollerA.scrollTop = 100;
  scrollerA.dispatchEvent(new w.Event('scroll'));
  await paint();
  ok('离开底部超过 160px 时出现', buttonA.element.classList.contains('is-visible'));
  ok('另一个容器/会话的按钮不受影响', !buttonB.element.classList.contains('is-visible'));
  buttonA.setRunning(true);
  equal(buttonA.element.dataset.running, 'true', '运行中按钮标记 running');
  buttonA.element.click();
  equal(scrollerA.scrollTop, 1000, '点击只滚当前容器到真实底部');
  equal(d.documentElement.scrollTop, 0, '不触碰 document 滚动');
  scrollerA.dispatchEvent(new w.Event('scroll'));
  await paint();
  ok('到达底部后按钮隐藏', !buttonA.element.classList.contains('is-visible'));
  buttonA.setRunning(false);
  equal(buttonA.element.dataset.running, 'false', '非运行态恢复下箭头');
  buttonA.dispose(); buttonB.dispose();
  ok('dispose 移除节点', !hostA.querySelector('.scroll-bottom') && !hostB.querySelector('.scroll-bottom'));

  /* ================= 6. CSS 契约 ================= */
  console.log('视觉契约（CSS，不是像素验收）');
  const css = fs.readFileSync(path.join(PUB, 'agent-execution.css'), 'utf8');
  ok('按钮 44px 圆形、居中悬浮在 composer 上方',
    /\.scroll-bottom\s*\{[^}]*top:\s*-54px[^}]*width:\s*44px[^}]*height:\s*44px[^}]*border-radius:\s*var\(--radius-full\)/s.test(css));
  ok('运行中 hover 才换成下箭头，且两个图标叠在同一格（不产生尺寸跳变）',
    /\.scroll-bottom\s*>\s*\*\s*\{\s*grid-area:\s*1\s*\/\s*1/.test(css)
    && /\.scroll-bottom\[data-running="false"\]\s*\.scroll-arrow\s*\{\s*display:\s*block/.test(css)
    && /\.scroll-bottom\[data-running="true"\]:hover\s+\.scroll-arrow[\s\S]*?display:\s*block/.test(css));
  ok('任务标题长文本换行', /\.plan-text\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/.test(css));
  ok('五类状态都有独立视觉', ['pending', 'completed', 'in_progress', 'failed', 'cancelled']
    .every(status => new RegExp(`\\.plan-item\\[data-status="${status}"\\]`).test(css)));
  ok('reduced-motion 下关掉呼吸与过渡', /prefers-reduced-motion:\s*reduce[\s\S]*?\.plan-pulse-dot\s*\{\s*animation:\s*none/.test(css)
    && /prefers-reduced-motion:\s*reduce[\s\S]*?\.scroll-bottom[^{]*\{\s*transition:\s*none/.test(css));
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  ok('新样式在 thinking-dots 之后加载', html.indexOf('href="/agent-execution.css"') > html.indexOf('href="/thinking-dots.css"'));

  console.log(`Agent execution UI: ${passed}/${passed + failed}; failed=${failed}; skipped=0; jsdom not pixel acceptance`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
