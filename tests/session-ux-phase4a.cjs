/* 会话过程 UI/UX 第四阶段 A：子代理紧凑卡片定向测试。
 *
 * 覆盖：
 * 1. 父工具行保留生命周期，实际结果/已绑定 workflow 子项才生成单列列表；
 * 2. agent/model/state/progress/task 白名单投影，缺失字段省略，不推算完成度；
 * 3. 同步结果、并行 workflow、多模型、混合终态、未知后台完成；
 * 4. 24 项上限、8000 字符预算、恶意字段、空 details、过期 workflow 帧回退；
 * 5. 用户折叠优先、父工具组折叠、历史与实时一致、gui_plan 不重复；
 * 6. Runtime 缩减投影仍不生成子代理卡片。
 *
 * jsdom 只验证行为与 DOM 契约；真实排版、焦点与主题由
 * tests/session-ux-phase4a-shots.cjs 在 Chromium 中取证。
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
const text = value => ({ type: 'text', text: value });

let passed = 0;
let failed = 0;
function ok(label, value) {
  try {
    const result = typeof value === 'function' ? value() : value;
    if (typeof value !== 'function' || result !== undefined) assert.ok(result, label);
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

  const SA = await import(url('subagent-activity.js'));
  const TM = await import(url('tool-model.js'));
  const V = await import(url('tool-view.js'));
  const M = await import(url('messages.js'));
  const RT = await import(url('runtime-timeline.js'));

  const activity = entry => SA.subagentActivity(entry);
  const entry = (args = {}, id = 'one', name = 'subagent') => TM.makeEntry({ toolCallId: id, toolName: name, args }, 1);
  const finish = (e, details, isError = false) => TM.applyEnd(e, {
    result: { content: [{ type: 'text', text: 'RAW_CHILD_SECRET' }], details }, isError,
  }, 10);
  const update = (e, details) => TM.applyUpdate(e, { partialResult: { content: [], details } }, 20);
  const result = (over = {}) => ({
    index: 0, agent: 'custom-reviewer', task: 'Review a module', exitCode: 0,
    progress: { toolCount: 2, turnCount: 1, tokens: 1200, durationMs: 1500 },
    ...over,
  });
  const host = d.createElement('div');
  d.body.append(host);
  const mount = e => { const node = V.renderEntry(e); host.append(node); return node; };
  const rows = node => [...node.querySelectorAll('.tl-subagent-row')];
  const rowText = node => rows(node).map(row => row.textContent);

  console.log('P4-A：父行、实际结果与 disclosure');
  const singleDetails = {
    mode: 'single', runId: 'run-single',
    results: [result({
      agent: 'reviewer-中文', model: 'provider/model-a',
      progress: { currentTool: 'read', toolCount: 4, turnCount: 2, tokens: 1234, durationMs: 8200 },
    })],
  };
  const live = entry({ agent: 'requested-agent', task: 'requested task' });
  const n0 = mount(live);
  equal(activity(live).subagents, undefined, '请求参数不能当作已执行的子项事实');
  equal(n0.querySelector('.tl-subagents'), null, '结果到达前不画子项列表');
  ok('父行仍展示请求摘要', n0.textContent.includes('requested-agent'));
  equal(n0.querySelector('.tl-status').textContent, '运行中', '父行保留真实运行状态');
  finish(live, singleDetails);
  V.updateEntry(n0, live);
  equal(activity(live).subagents.rows.length, 1, '实际 result 生成一个子项');
  equal(n0.querySelector('.tl-subagent-meta').textContent, '子代理 · 1 项 · 成功 1', '父行显示真实子项计数');
  equal(rows(n0).length, 1, '展开区是单列一行');
  ok('子项展示真实 agent', rowText(n0)[0].includes('reviewer-中文'));
  ok('子项展示真实 model', rowText(n0)[0].includes('provider/model-a'));
  ok('子项展示真实终态', rowText(n0)[0].includes('成功'));
  for (const expected of ['当前 read', '工具 4', '轮次 2', 'Token 1234', '8.2s']) {
    ok('子项展示真实进度：' + expected, rowText(n0)[0].includes(expected));
  }
  ok('子项展示已有任务摘要', rowText(n0)[0].includes('Review a module'));
  ok('child 原始输出不进入 DOM', !n0.textContent.includes('RAW_CHILD_SECRET'));
  equal(n0.querySelector('.tl-args').textContent, '', '原始参数不进入 DOM');
  equal(n0.querySelector('.tl-out').textContent, '', '结构化卡片不重复铺 facts 文本');
  const toggle = n0.querySelector('.tl-toggle');
  equal(toggle.tagName, 'BUTTON', '展开控件是原生 button');
  equal(toggle.type, 'button', '展开控件不是提交按钮');
  equal(toggle.textContent, '子代理', '折叠时控件说明这是子代理');
  equal(toggle.getAttribute('aria-controls'), n0.querySelector('.tl-more').id, 'aria-controls 指向详情');
  equal(toggle.getAttribute('aria-expanded'), 'false', '默认折叠且 aria-expanded 一致');
  toggle.click();
  equal(toggle.getAttribute('aria-expanded'), 'true', '展开后 aria-expanded 同步');
  equal(n0.querySelector('.tl-more').hidden, false, '展开后详情可见');
  equal(toggle.textContent, '收起', '展开后控件文案为收起');
  equal(n0.querySelector('.tl-subagents').getAttribute('role'), 'list', '子项容器是 list');
  equal(rows(n0)[0].getAttribute('role'), 'listitem', '每个子项是 listitem');
  equal(n0.querySelectorAll('.tl-subagents button').length, 0, '子项没有独立 Stop 等控件');
  toggle.click();
  equal(n0.querySelector('.tl-more').hidden, true, '再次点击可收起');
  equal(toggle.getAttribute('aria-expanded'), 'false', '收起后 aria-expanded 同步');

  console.log('P4-A：并行 workflow、多模型与混合终态');
  const workflowDetails = {
    mode: 'workflow', runId: 'wf-run', results: [],
    workflowChildren: {
      version: 1, parentToolCallId: 'wf', workflowRunId: 'wf-run', inventoryComplete: true,
      workflowState: 'running', children: [
        { childId: 'ui', agent: 'reviewer-国际化-模块边界-安全检查', model: 'provider/very-long-model-name-2026-11-16', state: 'completed', activity: { currentTool: 'read', toolCount: 3, turnCount: 2, tokens: 500, durationMs: 2100 } },
        { childId: 'api', agent: 'api-agent', state: 'failed' },
        { childId: 'db', agent: 'db-agent', state: 'running', activity: { toolCount: 1 } },
        { childId: 'edge', agent: 'edge-agent', state: 'stopped' },
      ],
    },
  };
  const wf = entry({ workflowScript: 'PRIVATE_SCRIPT_PATH' }, 'wf');
  update(wf, workflowDetails);
  const n1 = mount(wf);
  equal(activity(wf).subagents.rows.length, 4, '四个已识别 child 都进入投影');
  deep(activity(wf).subagents.rows.map(row => row.key), ['ui', 'api', 'db', 'edge'], 'workflow 以 childId 作为稳定身份');
  equal(n1.querySelector('.tl-subagent-meta').textContent, '子代理 · 4 项 · 运行 1 · 成功 1 · 失败 1', '父行只统计真实运行/成功/失败');
  deep(rows(n1).map(row => row.dataset.state), ['completed', 'failed', 'running', 'stopped'], '子项状态逐项保留');
  equal(n1.querySelectorAll('.tl-subagent-model').length, 1, '缺失 model 直接省略，不补 Model unknown');
  ok('子项不伪造模型名', !n1.textContent.includes('Model unknown'));
  ok('workflow 脚本路径不进入卡片', !n1.textContent.includes('PRIVATE_SCRIPT_PATH'));
  ok('stopped 使用真实安全状态文案', rowText(n1)[3].includes('已停止'));
  n1.querySelector('.tl-toggle').click();
  equal(n1.querySelector('.tl-more').hidden, false, '并行 workflow 可展开');
  const models = [...n1.querySelectorAll('.tl-subagent-model')].map(node => node.textContent);
  deep(models, ['provider/very-long-model-name-2026-11-16'], '多模型场景保留每个真实模型');

  const multiDetails = {
    runId: 'run-multi',
    results: [
      result({ index: 0, agent: 'agent-a', model: 'provider/model-a' }),
      result({ index: 1, agent: 'agent-b', model: 'provider/model-b', task: undefined, progress: { toolCount: 2, turnCount: 1, tokens: 50, durationMs: 600 } }),
    ],
  };
  const multi = finish(entry({}, 'multi'), multiDetails);
  const n2 = mount(multi);
  deep([...n2.querySelectorAll('.tl-subagent-model')].map(node => node.textContent), ['provider/model-a', 'provider/model-b'], '两条实际结果的多模型都展示');
  deep(activity(multi).subagents.rows.map(row => row.key), ['run-multi/0', 'run-multi/1'], '有 runId 时 producer index 作为身份');
  equal(n2.querySelectorAll('.tl-subagent-task').length, 1, '缺失 task 的行直接省略任务摘要');
  equal(n2.querySelectorAll('.tl-subagent-metrics').length, 2, '有 progress 的行展示实际数字');

  const mixed = finish(entry({}, 'mixed'), {
    runId: 'run-mixed',
    results: [
      result({ index: 0, exitCode: 0 }),
      result({ index: 1, exitCode: 1 }),
      result({ index: 2, exitCode: 0, stopped: true }),
      result({ index: 3, exitCode: 0, interrupted: true }),
    ],
  });
  const n3 = mount(mixed);
  deep(rows(n3).map(row => row.dataset.state), ['completed', 'failed', 'stopped', 'interrupted'], '混合终态逐项保留');
  equal(n3.querySelector('.tl-subagent-meta').textContent, '子代理 · 4 项 · 成功 1 · 失败 1', '混合终态计数不把停止/中断算成成功');

  console.log('P4-A：空 details、恶意字段与预算');
  const empty = finish(entry({ agent: 'requested' }, 'empty'), {});
  const n4 = mount(empty);
  equal(activity(empty).subagents, undefined, '空 details 不生成结构化子项');
  equal(n4.querySelector('.tl-subagents'), null, '空 details 不创建列表');
  equal(n4.querySelector('.tl-subagent-meta'), null, '空 details 不创建计数行');
  equal(n4.querySelector('.tl-toggle').textContent, '展开输出', '空 details 回退原详情控件');
  ok('空 details 保留原安全 facts', n4.textContent.includes('Model unknown · Child metadata unavailable'));

  const hostileDetails = {
    ...singleDetails, env: 'SECRET', auth: 'SECRET', token: 'SECRET',
    workflowChildren: { version: 1, parentToolCallId: 'hostile', workflowRunId: 'hs', children: [{ childId: 'PRIVATE_CHILD', agent: 'PRIVATE_AGENT' }] },
    results: [result({
      agent: 'safe-agent', model: 'safe-model',
      env: 'SECRET', auth: 'SECRET', token: 'SECRET', transcriptPath: 'SECRET',
      finalOutput: 'SECRET', messages: [{ content: 'SECRET' }],
    })],
  };
  const hostile = finish(entry({ agent: 'safe-agent', task: 'safe task', env: 'SECRET', token: 'SECRET', transcriptPath: 'SECRET' }, 'hostile'), hostileDetails);
  const n5 = mount(hostile);
  ok('恶意额外字段不影响白名单子项', rows(n5).length === 1);
  ok('恶意额外字段不进入 DOM', !n5.textContent.includes('SECRET') && !n5.outerHTML.includes('SECRET'));
  ok('未绑定 workflow 子项不能借 results 混入', !n5.textContent.includes('PRIVATE_'));
  equal(n5.querySelector('.tl-args').textContent, '', '恶意 args 不进入详情');

  const many = finish(entry({}, 'many'), {
    runId: 'run-many',
    results: Array.from({ length: 30 }, (_, i) => result({ index: i, agent: 'agent-' + i, model: 'model-' + i, exitCode: 0 })),
  });
  const n6 = mount(many);
  equal(rows(n6).length, 24, '每个来源最多 24 项');
  equal(n6.querySelector('.tl-subagent-meta').textContent, '子代理 · 30 项 · 成功 30 · 显示 24', '截断时保留真实总数和已显示数量');
  ok('facts 仍受 8000 字符预算约束', activity(many).facts.length <= 8000);

  const lateFailure = finish(entry({}, 'late-failure'), {
    runId: 'run-late-failure',
    results: Array.from({ length: 30 }, (_, i) => result({ index: i, agent: 'agent-' + i, model: 'model-' + i, exitCode: i === 29 ? 1 : 0 })),
  });
  const n6b = mount(lateFailure);
  equal(activity(lateFailure).status, 'error', '第 30 项失败参与父生命周期');
  equal(n6b.querySelector('.tl-status').textContent, '失败', '父行状态与后置失败一致');
  equal(n6b.querySelector('.tl-subagent-meta').textContent, '子代理 · 30 项 · 成功 29 · 失败 1 · 显示 24', '截断后子项统计仍使用完整结果');

  const huge = finish(entry({}, 'huge'), {
    runId: 'run-huge',
    results: Array.from({ length: 24 }, (_, i) => result({
      index: i, agent: 'a'.repeat(500), model: 'm'.repeat(500), task: 't'.repeat(1000), exitCode: 0,
      progress: { toolCount: 1, turnCount: 1, tokens: 10, durationMs: 100 },
    })),
  });
  const n7 = mount(huge);
  const shown = rows(n7).length;
  ok('8000 字符预算先于 24 项上限截断', shown > 0 && shown < 24);
  ok('结构化列表文本不超过 8000 字符', n7.querySelector('.tl-subagents').textContent.length <= 8000);
  ok('facts 仍不超过 8000 字符', activity(huge).facts.length <= 8000);
  ok('预算截断在父行可见', n7.querySelector('.tl-subagent-meta').textContent.includes('显示 ' + shown));
  ok('父行仍显示真实子项总数', n7.querySelector('.tl-subagent-meta').textContent.includes('24 项'));

  const hugeThenSmall = finish(entry({}, 'huge-sentinel'), {
    runId: 'run-huge-sentinel',
    results: [
      ...Array.from({ length: 11 }, (_, i) => result({
        index: i, agent: 'a'.repeat(500), model: 'm'.repeat(500), task: 't'.repeat(1000), exitCode: 0,
        progress: { toolCount: 1, turnCount: 1, tokens: 10, durationMs: 100 },
      })),
      result({ index: 11, agent: 'SENTINEL-SMALL', model: 'm', exitCode: 0 }),
    ],
  });
  const n7b = mount(hugeThenSmall);
  const shownPrefix = rows(n7b).length;
  ok('预算截断保持前缀，不跳过超大行展示后续小行', shownPrefix > 0 && shownPrefix <= 10
    && !n7b.textContent.includes('SENTINEL-SMALL'));
  equal(n7b.querySelector('.tl-subagent-meta').textContent, '子代理 · 12 项 · 成功 12 · 显示 ' + shownPrefix,
    '前缀截断后仍统计全部已知子项');

  console.log('P4-A：未知后台、过期帧与回退');
  const wait = finish(entry({ id: 'r' }, 'wait', 'bg_wait'), {
    mode: 'management', results: [],
    completions: [{ runId: 'r', success: true }],
  });
  const n8 = mount(wait);
  equal(n8.querySelector('.tl-subagents'), null, '未知完成状态不生成卡片');
  ok('未知完成状态保留真实 unknown', n8.textContent.includes('unknown'));
  ok('未知完成状态不统计成成功', !n8.textContent.includes('成功 1'));

  const bg = finish(entry({ agent: 'worker', task: 'background work', async: true }, 'bg'), {
    mode: 'single', runId: 'bg-run', asyncId: 'bg-run', results: [],
  });
  const n9 = mount(bg);
  equal(n9.querySelector('.tl-subagents'), null, 'background launch 不生成子项卡片');
  ok('background 只声明完成未知', n9.textContent.includes('Background launched · completion unknown'));

  for (const [label, workflowChildren] of [
    ['父 toolCallId 不匹配', { version: 1, parentToolCallId: 'other', workflowRunId: 'run-stale', inventoryComplete: true, workflowState: 'running', children: [{ childId: 'left', agent: 'STALE_AGENT', state: 'completed' }] }],
    ['版本不匹配', { version: 99, parentToolCallId: 'stale', workflowRunId: 'run-stale', inventoryComplete: true, workflowState: 'running', children: [{ childId: 'left', agent: 'STALE_AGENT', state: 'completed' }] }],
  ]) {
    const stale = finish(entry({}, 'stale'), { runId: 'run-stale', results: [], workflowChildren });
    const node = mount(stale);
    equal(node.querySelector('.tl-subagents'), null, label + '时不生成卡片');
    ok(label + '时不展示未绑定子项', !node.textContent.includes('STALE_AGENT'));
  }
  const staleRun = finish(entry({}, 'stale-run'), {
    runId: 'run-a', results: [],
    workflowChildren: { version: 1, parentToolCallId: 'stale-run', workflowRunId: 'run-b', inventoryComplete: true, workflowState: 'running', children: [{ childId: 'left', agent: 'STALE_AGENT', state: 'completed' }] },
  });
  const n10 = mount(staleRun);
  equal(n10.querySelector('.tl-subagents'), null, 'workflowRunId 与 runId 不一致时不生成卡片');
  ok('过期 workflow 帧不展示子项', !n10.textContent.includes('STALE_AGENT'));

  const noRun = finish(entry({}, 'no-run'), { results: [result({ index: 0, agent: 'UNATTRIBUTED' })] });
  const n10a = mount(noRun);
  equal(n10a.querySelector('.tl-subagents'), null, '缺少 runId 时不生成卡片');
  ok('缺少 runId 时保留安全 facts', n10a.textContent.includes('UNATTRIBUTED'));

  const noIndex = finish(entry({}, 'no-index'), { runId: 'run-no-index', results: [{ agent: 'UNINDEXED', exitCode: 0 }] });
  const n10b = mount(noIndex);
  equal(n10b.querySelector('.tl-subagents'), null, '缺少 producer index 时不生成卡片');
  ok('缺少 producer index 时保留安全 facts', n10b.textContent.includes('UNINDEXED'));

  const duplicateIndex = finish(entry({}, 'duplicate-index'), {
    runId: 'run-duplicate',
    results: [result({ index: 0, agent: 'DUP-A' }), result({ index: 0, agent: 'DUP-B' })],
  });
  const n10c = mount(duplicateIndex);
  equal(n10c.querySelector('.tl-subagents'), null, 'producer index 重复时不生成卡片');
  ok('producer index 重复时保留安全 facts', n10c.textContent.includes('DUP-A') && n10c.textContent.includes('DUP-B'));

  const malformedWorkflow = finish(entry({}, 'malformed-workflow'), {
    runId: 'run-malformed', results: [result({ index: 0, agent: 'SECONDARY-RESULT' })],
    workflowChildren: {
      version: 1, parentToolCallId: 'malformed-workflow', workflowRunId: 'run-malformed',
      inventoryComplete: true, workflowState: 'running', children: [{ agent: 'CHILDLESS' }],
    },
  });
  const n10d = mount(malformedWorkflow);
  equal(n10d.querySelector('.tl-subagents'), null, '绑定 workflow 无 childId 时不混用 results');
  ok('无 childId 的 workflow 子项不进入卡片', !n10d.textContent.includes('CHILDLESS'));

  console.log('P4-A：折叠优先级与父工具组');
  const expanding = entry({ workflowScript: 'x' }, 'expanding');
  update(expanding, workflowDetails);
  const n11 = mount(expanding);
  const n11Toggle = n11.querySelector('.tl-toggle');
  n11Toggle.click();
  equal(n11.querySelector('.tl-more').hidden, false, '用户先展开');
  const nextWorkflow = {
    ...workflowDetails,
    workflowChildren: {
      ...workflowDetails.workflowChildren,
      children: [...workflowDetails.workflowChildren.children, { childId: 'new', agent: 'new-agent', state: 'completed' }],
    },
  };
  update(expanding, nextWorkflow);
  V.updateEntry(n11, expanding);
  equal(n11.querySelector('.tl-more').hidden, false, '状态更新不覆盖用户展开');
  equal(n11Toggle.getAttribute('aria-expanded'), 'true', '展开时 aria-expanded 保持 true');
  n11Toggle.click();
  update(expanding, nextWorkflow);
  V.updateEntry(n11, expanding);
  equal(n11.querySelector('.tl-more').hidden, true, '用户收起后状态更新不自动展开');
  equal(n11Toggle.getAttribute('aria-expanded'), 'false', '收起时 aria-expanded 保持 false');

  const group = V.createGroup();
  host.append(group);
  const g1 = entry({ workflowScript: 'x' }, 'g1');
  update(g1, workflowDetails);
  const g2 = finish(entry({}, 'g2'), { runId: 'g2', results: [result({ agent: 'g2-agent' })] });
  V.addToGroup(group, V.renderEntry(g1));
  V.addToGroup(group, V.renderEntry(g2));
  const groupHead = group.querySelector('.tl-group-head');
  groupHead.click();
  equal(group.querySelector('.tl-list').hidden, true, '用户折叠父工具组');
  update(g1, nextWorkflow);
  V.updateEntry(group.querySelector('[data-id="g1"]'), g1);
  equal(group.querySelector('.tl-list').hidden, true, '子代理状态更新不覆盖父组折叠');
  equal(groupHead.getAttribute('aria-expanded'), 'false', '父组 aria-expanded 保持 false');

  console.log('P4-A：历史、gui_plan 与 Runtime 回退');
  const historyLive = finish(entry({}, 'history-live'), singleDetails);
  const history = TM.entryFromHistory({ id: 'history-live', name: 'subagent', arguments: {} }, { details: singleDetails, content: [] }, {});
  deep(activity(history).subagents.rows, activity(historyLive).subagents.rows, '历史与实时使用同一子项投影');
  equal(activity(history).facts, activity(historyLive).facts, '历史与实时的安全 facts 一致');

  const planTasks = { version: 1, tool: 'gui_plan', tasks: [{ id: 'p', title: '检查子代理卡片', status: 'completed' }], counts: { total: 1, completed: 1 } };
  M.rebuildFromMessages([
    { role: 'user', content: [text('同一回合同时出现子代理和计划')] },
    { role: 'assistant', content: [
      { type: 'toolCall', id: 'p4a-history-sub', name: 'subagent', arguments: { agent: 'worker', task: '检查', env: 'SECRET' } },
      { type: 'toolCall', id: 'p4a-history-plan', name: 'gui_plan', arguments: { tasks: [{ id: 'p', title: '检查子代理卡片', status: 'completed' }] } },
    ] },
    { role: 'toolResult', toolCallId: 'p4a-history-sub', toolName: 'subagent', content: [], details: { mode: 'single', runId: 'run-h', results: [result({ index: 0, agent: 'worker', model: 'provider/m', exitCode: 0 })] } },
    { role: 'toolResult', toolCallId: 'p4a-history-plan', toolName: 'gui_plan', content: [], details: planTasks },
  ], 'p4a-history');
  const stream = d.querySelector('#stream');
  equal(stream.querySelectorAll('.plan-card').length, 1, '父子工具同时存在时只有一张计划卡');
  equal(stream.querySelectorAll('.tl-item').length, 1, 'gui_plan 不重复进入工具时间线');
  equal(stream.querySelectorAll('.tl-item[data-id="p4a-history-plan"]').length, 0, 'gui_plan 没有独立工具行');
  equal(stream.querySelectorAll('.tl-subagent-row').length, 1, '历史子代理同样渲染紧凑列表');
  equal(stream.querySelector('.plan-card .tl-subagent-row'), null, '计划卡内不混入子代理行');
  ok('历史 raw args 不进入 DOM', !stream.textContent.includes('SECRET'));

  const runtimeEntry = { id: 'rt', name: 'subagent', label: '执行工具', known: false, status: 'success', args: null, details: null, summary: '', durationMs: 1200, output: '', resultLine: '' };
  equal(activity(runtimeEntry).subagents, undefined, 'Runtime 缩减投影没有可绑定子项');
  const runtimeNode = V.renderEntry(runtimeEntry);
  equal(runtimeNode.querySelector('.tl-subagents'), null, 'Runtime 工具行不生成子代理卡片');
  equal(runtimeNode.querySelector('.tl-subagent-meta'), null, 'Runtime 工具行不生成子代理计数');

  const timeline = RT.timelineFromMessages([
    { role: 'user', content: [text('hi')] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'rt-1', name: 'subagent', arguments: { agent: 'PRIVATE_AGENT', task: 'PRIVATE_TASK' } }] },
    { role: 'toolResult', toolCallId: 'rt-1', toolName: 'subagent', content: [text('PRIVATE_OUTPUT')], details: { results: [{ agent: 'PRIVATE_AGENT', model: 'PRIVATE_MODEL', exitCode: 0 }] } },
  ]);
  const runtimeTools = timeline.blocks.find(block => block.kind === 'tools').tools[0];
  deep(Object.keys(runtimeTools).sort(), ['durationMs', 'id', 'name', 'state', 'waiting'], 'Runtime 工具字段仍是既有白名单');
  ok('Runtime 投影不携带子代理 facts 或原始载荷', !JSON.stringify(timeline).includes('PRIVATE_'));

  dom.window.close();
  const total = passed + failed;
  console.log(`\nSession UX Phase 4-A: ${passed}/${total}; failed=${failed}; jsdom 行为契约，不含像素验收`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
