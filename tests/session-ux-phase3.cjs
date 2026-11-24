/* 会话过程 UI/UX 第三阶段（P3）定向行为测试。
 *
 * 覆盖：
 * 1. Token 摘要/明细在 Classic、Runtime 实时与历史中的字段名、格式和 0/缺失语义；
 * 2. 历史 usage 白名单投影（timelineFromMessages / cloneBlock / blockChars / 服务端读取）；
 * 3. 工具组状态计数、并行组耗时、缺失时间戳与用户折叠优先级；
 * 4. 任务列表折叠摘要（真实完成数、当前 in_progress 标题、stalled 文案）；
 * 5. role=log / aria-live 取舍与折叠控件的 aria 关系。
 *
 * jsdom 不做布局，也不套用外部样式表；真实几何、焦点环与主题截图由
 * tests/session-ux-phase3-shots.cjs 在 Chromium 中单独取证。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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

  const MM = await import(url('message-meta.js'));
  const RT = await import(url('runtime-timeline.js'));
  const RD = await import(url('runtime-display.js'));
  const RS = await import(url('runtime-state.js'));
  const RTC = await import(url('runtime-conversation.js'));
  const V = await import(url('tool-view.js'));
  const TM = await import(url('tool-model.js'));
  const PV = await import(url('plan-view.js'));
  const PM = await import(url('plan-model.js'));
  const { runtimeStore, observeRuntimeFrame } = RS;

  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
  const owner = (id, gen = 'one') => ({ backendInstance: 'backend', projectId: 'project', repoId: 'repo',
    workspaceId: 'ws-' + id, workspaceEpoch: 'epoch', conversationId: id, runtimeId: 'rt-' + id,
    runtimeGeneration: gen, sessionId: 's-' + id });
  const usage = { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, cacheWrite1h: 1, reasoning: 4, totalTokens: 21 };

  console.log('P3-B：用量字段白名单、摘要与整轮汇总');
  {
    const normalized = MM.normalizeUsage({ ...usage, extra: 'SECRET', cost: { total: 0.0123, input: 99 } });
    deep(Object.keys(normalized).sort(), [...MM.USAGE_FIELDS.map(([key]) => key), 'costTotal'].sort(),
      '只保留七个 Pi 字段与已算好的成本');
    equal(normalized.costTotal, 0.0123, '成本只认 Pi 的 usage.cost.total');
    ok('成本不补货币符号', !JSON.stringify(normalized).includes('$') && !JSON.stringify(normalized).includes('¥'));
    equal(MM.formatUsageNumber(1234), '1,234', '数字格式统一');
    equal(MM.usageSummary(usage), 'Token 21 · 推理 4（含在输出中）', '摘要只放总量与推理');
    equal(MM.usageSummary({ input: 0, output: 1234 }), '输出 1,234 Token', '缺 total 时退回 output');
    equal(MM.usageSummary({ input: 0, output: 0, reasoning: 0, totalTokens: 0 }),
      'Token 0 · 推理 0（含在输出中）', '真实 0 不被省略');

    const invalid = MM.normalizeUsage({
      input: -1, output: 1.5, cacheRead: '3', cacheWrite: null, cacheWrite1h: NaN,
      reasoning: Infinity, totalTokens: null,
    });
    equal(invalid, null, '负数/小数/字符串/非有限值都不进入白名单');
    equal(MM.normalizeUsage([]), null, '数组载荷不生成用量');
    equal(MM.normalizeUsage({}), null, '没有任何有效字段时整块不生成');

    deep(MM.mergeUsages([usage, { output: 1 }]), { output: 8 },
      '整轮汇总只累加每条响应都有的字段，缺失字段不补 0');
    equal(MM.mergeUsages([]), null, '空记录没有汇总');
    equal(MM.mergeUsages([{ input: 0, output: 0, reasoning: 0, totalTokens: 0 }]).totalTokens, 0,
      '单条真实 0 保留');
  }

  console.log('P3-D：历史 usage 白名单投影');
  {
    const toolCall = { type: 'toolCall', id: 'call-1', name: 'read', arguments: { secret: 'RAW_ARGS' } };
    const messages = [
      { role: 'user', content: [text('hi')], timestamp: 1000 },
      { role: 'assistant', timestamp: 2000, stopReason: 'toolUse', usage: {
        ...usage, extra: 'NOT_ALLOWED', cost: { total: 0.0123, input: 99 }, message: { raw: true },
      }, content: [{ type: 'thinking', thinking: 'think' }, text('answer'), toolCall] },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [text('RAW_OUTPUT')], timestamp: 3000 },
      { role: 'assistant', timestamp: 4000, stopReason: 'stop', usage: { input: 0, output: 0, totalTokens: 0 }, content: [text('done')] },
    ];
    const projected = RT.timelineFromMessages(messages);
    const assistants = projected.blocks.filter(block => block.kind === 'assistant');
    deep(assistants[0].usage, { ...usage, costTotal: 0.0123 }, '历史只保留白名单 token 字段与 costTotal');
    ok('原始 message / 自由文本 / 非白名单字段不进入投影', !JSON.stringify(projected.blocks).includes('NOT_ALLOWED')
      && !JSON.stringify(projected.blocks).includes('RAW_ARGS') && !JSON.stringify(projected.blocks).includes('RAW_OUTPUT'));
    deep(assistants[1].usage, { input: 0, output: 0, totalTokens: 0 }, '真实 0 保留（不是虚构的缺失）');
    equal(assistants[1].usage.costTotal, undefined, '缺失成本不补 0');

    const old = RT.timelineFromMessages([{ role: 'assistant', content: [text('old')], timestamp: 1 }]);
    equal(old.blocks[0].usage, undefined, '旧记录没有 usage 就没有 usage 字段');

    const onlyThinking = RT.timelineFromMessages([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'think' }], usage, timestamp: 1 }]);
    const thinkingBlock = onlyThinking.blocks.find(block => block.kind === 'thinking');
    deep(thinkingBlock.usage, usage, '只思考的消息把真实 usage 挂到 thinking block');
    equal(onlyThinking.blocks.filter(block => block.kind === 'assistant').length, 0, '不伪造空的 assistant 正文');

    const onlyTool = RT.timelineFromMessages([{ role: 'assistant', content: [toolCall], usage, timestamp: 1 }]);
    equal(onlyTool.blocks.filter(block => block.kind === 'assistant').length, 0, '只调工具的消息不伪造 assistant block');
    deep(onlyTool.blocks.find(block => block.kind === 'tools').usage, usage, '只调工具的消息把真实 usage 挂到工具组');

    const planTasks = [{ id: 'p', title: 'A', status: 'in_progress' }];
    const planCall = { type: 'toolCall', id: 'plan-1', name: 'gui_plan',
      arguments: { version: 1, tasks: planTasks } };
    const planResult = { role: 'toolResult', toolCallId: 'plan-1', toolName: 'gui_plan',
      content: [text('ok')], details: { version: 1, tasks: planTasks }, timestamp: 2 };
    const onlyPlan = RT.timelineFromMessages([
      { role: 'assistant', content: [planCall], usage, timestamp: 1 },
      planResult,
    ]);
    const planBlock = onlyPlan.blocks.find(block => block.kind === 'plan');
    deep(planBlock.usages, [usage], '只提交计划的消息把真实 usage 挂到 plan block');
    equal(onlyPlan.blocks.filter(block => block.kind === 'assistant').length, 0, 'plan-only 消息不伪造空的 assistant 正文');
    equal(onlyPlan.blocks.filter(block => block.usage || block.usages?.length).length, 1, 'plan-only 消息的 usage 只出现一次');
    equal(RT.blockChars(planBlock), 66, 'plan block 的 usage 计入有界预算（2 字符计划 + 64）');

    const mixedPlan = RT.timelineFromMessages([
      { role: 'assistant', content: [planCall, text('plan answer')], usage, timestamp: 1 },
      planResult,
    ]);
    const mixedPlanBlock = mixedPlan.blocks.find(block => block.kind === 'plan');
    equal(mixedPlan.blocks.filter(block => block.usage || block.usages?.length).length, 1, '计划加正文时 usage 仍然只挂一次');
    equal(mixedPlanBlock.usages, undefined, '正文存在时 usage 不重复挂到计划卡');
    deep(mixedPlan.blocks.find(block => block.kind === 'assistant').usage, usage, '正文优先承接 usage');

    const usageLater = { input: 30, output: 7, totalTokens: 37 };
    const laterTasks = [{ id: 'p', title: 'A', status: 'completed' }, { id: 'q', title: 'B', status: 'in_progress' }];
    const laterCall = { type: 'toolCall', id: 'plan-2', name: 'gui_plan',
      arguments: { version: 1, tasks: laterTasks } };
    const laterResult = { role: 'toolResult', toolCallId: 'plan-2', toolName: 'gui_plan',
      content: [text('ok')], details: { version: 1, tasks: laterTasks, turnId: 'run-steer' }, timestamp: 4 };
    planResult.details.turnId = 'run-steer';
    const steerPlan = RT.timelineFromMessages([
      { role: 'user', content: [text('任务')], timestamp: 1 },
      { role: 'assistant', content: [planCall], usage, timestamp: 2 },
      planResult,
      { role: 'user', content: [text('补充指令')], timestamp: 3 },
      { role: 'assistant', content: [laterCall], usage: usageLater, timestamp: 4 },
      laterResult,
    ]);
    const steerPlans = steerPlan.blocks.filter(block => block.kind === 'plan');
    equal(steerPlans.length, 1, '同一 turnId 的两条 plan-only 消息仍合并为一张计划卡');
    deep(steerPlans[0].usages, [usage, usageLater], '复用计划卡不覆盖先前消息的 usage，两条都保留');
    equal(steerPlan.blocks.filter(block => block.kind === 'assistant').length, 0, '两条 plan-only 消息都不伪造正文');
    equal(steerPlans[0].plan.tasks.find(task => task.id === 'q').status, 'in_progress', '计划内容仍取最后一条真实记录');
    equal(RT.blockChars(steerPlans[0]), 4 + 128, '同一计划卡的多条 usage 都计入有界预算');

    const planBase = { kind: 'plan', plan: { tasks: [{ id: 'p', title: 'A', status: 'pending' }] } };
    const planWithUsage = { kind: 'plan', plan: { tasks: [{ id: 'q', title: 'B', status: 'pending' }] }, usages: [usage] };
    const boundedPlan = RT.boundTimeline([planBase, planWithUsage], { maxChars: 67 });
    equal(boundedPlan.blocks.length, 1, 'plan usage 计入 maxChars，旧计划先被裁掉');
    deep(boundedPlan.blocks[0].usages, [usage], '裁剪后最近 plan block 的真实 usage 保留');

    const usageChars = RT.blockChars({ kind: 'assistant', text: 'abc', usage });
    equal(usageChars, 67, 'blockChars 计入 usage 的固定预算');
    equal(RT.blockChars({ kind: 'thinking', text: 'abc', usage }), 67, 'thinking 上的 usage 同样计费');
    equal(RT.blockChars({ kind: 'assistant', text: 'abc' }), 3, '没有 usage 时不额外计费');
    const bounded = RT.boundTimeline(Array.from({ length: RT.MAX_BLOCKS + 3 }, (_, i) => ({
      kind: 'assistant', text: 'b' + i, state: 'complete', usage: i === RT.MAX_BLOCKS + 2 ? usage : undefined,
    })), { maxBlocks: RT.MAX_BLOCKS });
    equal(bounded.blocks.length, RT.MAX_BLOCKS, '加 usage 后仍有界');
    equal(bounded.blocks.at(-1).usage.totalTokens, 21, '保留最近 block 的真实 usage');
  }

  console.log('P3-D：store cloneBlock 纵深白名单');
  {
    runtimeStore.seed({ backendInstance: 'backend', items: [
      { conversationId: 'H', createdAt: '2026-01-01T00:00:00.000Z', workspace: { branch: 'h', projectId: 'project' },
        owner: owner('H'), lifecycle: 'ready', activity: 'idle', attention: false },
    ] });
    const o = storeOwner('H');
    const applied = runtimeStore.history('H', [], o, 0, { truncated: false, timeline: [
      { kind: 'user', text: 'q' },
      { kind: 'assistant', text: 'a', state: 'complete', usage: { ...usage, extra: 'SECRET', cost: { total: 9 }, message: { raw: 1 } } },
      { kind: 'thinking', text: 't', state: 'complete', usage: { ...usage, extra: 'SECRET' } },
    ] });
    ok('store 接受历史', applied);
    const record = runtimeStore.get('H');
    deep(record.timeline.find(block => block.kind === 'assistant').usage, { ...usage, costTotal: 9 },
      'store 只保留白名单 usage，附加字段被丢弃');
    deep(record.timeline.find(block => block.kind === 'thinking').usage, usage,
      'thinking block 的 usage 同样经过白名单');

    const planTasks = [{ id: 'p', title: 'Plan A', status: 'in_progress', secret: 'PLAN_TASK_SECRET' }];
    const planUsageLater = { input: 30, output: 7, totalTokens: 37 };
    const historyTimeline = [
      { kind: 'user', text: 'q', messageId: 'm1', userIndex: 0, truncated: false,
        message: { raw: 1 }, args: { raw: 1 }, secret: 'TOP_SECRET' },
      { kind: 'assistant', text: 'a', state: 'complete', truncated: false,
        usage: { ...usage, extra: 'SECRET' }, message: { raw: 1 }, args: { raw: 1 }, secret: 'TOP_SECRET' },
      { kind: 'thinking', text: 't', state: 'complete', truncated: false,
        usage: { ...usage, extra: 'SECRET' }, message: { raw: 1 }, secret: 'TOP_SECRET' },
      { kind: 'tools', truncated: false, message: { raw: 1 }, secret: 'TOP_SECRET',
        tools: [{ id: 'tool-1', name: 'read', state: 'success', waiting: false, durationMs: 7,
          args: { secret: 'RAW_ARGS' }, output: 'RAW_OUTPUT', extra: 'TOOL_SECRET' }] },
      { kind: 'plan', message: { raw: 1 }, secret: 'TOP_SECRET', args: { raw: 1 },
        usages: [{ ...usage, extra: 'SECRET' }, { ...planUsageLater, extra: 'SECRET' }],
        plan: { version: 1, tasks: planTasks, total: 1, completed: 0, explanation: 'e',
          revision: 1, turnId: 'run-1', extra: 'PLAN_SECRET' } },
    ];
    ok('store 接受带附加顶层字段的历史', runtimeStore.history('H', [], o, 0, { truncated: false, timeline: historyTimeline }));
    const clean = runtimeStore.get('H').timeline;
    const keys = block => Object.keys(block).sort();
    deep(clean.map(block => block.kind), ['user', 'assistant', 'thinking', 'tools', 'plan'], '合法历史 block 顺序不变');
    deep(keys(clean[0]), ['id', 'kind', 'messageId', 'text', 'truncated', 'userIndex'], 'user 只保留契约字段');
    deep(keys(clean[1]), ['id', 'kind', 'state', 'text', 'truncated', 'usage'], 'assistant 只保留契约字段');
    deep(keys(clean[2]), ['id', 'kind', 'state', 'text', 'truncated', 'usage'], 'thinking 只保留契约字段');
    deep(keys(clean[3]), ['id', 'kind', 'tools', 'truncated'], 'tools 只保留契约字段');
    deep(keys(clean[3].tools[0]), ['durationMs', 'id', 'name', 'state', 'waiting'], '工具条目只保留展示字段');
    deep(keys(clean[4]), ['id', 'kind', 'plan', 'usages'], 'plan 只保留契约字段');
    deep(keys(clean[4].plan), ['completed', 'explanation', 'revision', 'tasks', 'total', 'turnId', 'version'],
      'plan 对象只保留 normalizePlan 白名单字段');
    deep(keys(clean[4].plan.tasks[0]), ['id', 'status', 'title'], 'plan 任务只保留白名单字段');
    const serialized = JSON.stringify(clean);
    ok('message / args / secret / extra / 原始工具载荷均未进入 store',
      !serialized.includes('TOP_SECRET') && !serialized.includes('PLAN_SECRET') && !serialized.includes('PLAN_TASK_SECRET')
      && !serialized.includes('TOOL_SECRET') && !serialized.includes('RAW_ARGS') && !serialized.includes('RAW_OUTPUT')
      && !serialized.includes('"message"') && !serialized.includes('"args"') && !serialized.includes('"extra"'));
    deep(clean[1].usage, usage, '顶层过滤不改变 usage 白名单');
    deep(clean[2].usage, usage, 'thinking usage 仍按白名单投影');
    deep(clean[4].usages, [usage, planUsageLater], 'plan 的多条 usage 进入 store 且各自经过白名单');
    equal(clean[0].text + clean[1].text + clean[2].text, 'qat', '合法正文内容仍完整');
    equal(clean[3].tools[0].durationMs, 7, '合法工具耗时仍保留');
    equal(clean[4].plan.tasks[0].title, 'Plan A', '合法计划标题仍保留');
    equal(clean[4].plan.tasks[0].status, 'in_progress', '合法计划状态仍保留');

    ok('旧响应仍可写入单条 plan.usage', runtimeStore.history('H', [], o, 0, { truncated: false, timeline: [
      { kind: 'plan', usage, plan: { version: 1, tasks: [{ id: 'p', title: 'A', status: 'pending' }] } },
    ] }));
    const legacyPlan = runtimeStore.get('H').timeline[0];
    deep(legacyPlan.usages, [usage], '旧 plan.usage 规范化为 usages，不丢失');
    equal(legacyPlan.usage, undefined, 'plan 不再同时保留两种 usage 字段');
  }
  function storeOwner(id) {
    // seed() 保留传入的 owner 对象；用同一形状重建并通过 JSON 克隆避免引用相等假设。
    const r = runtimeStore.get(id);
    return r.owner;
  }

  console.log('P3-D：服务端会话文件读取');
  {
    const sessionHistory = await import(pathToFileURL(path.join(ROOT, 'server', 'session-history.js')).href);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p3-history-'));
    const file = path.join(root, 'session.jsonl');
    const entry = (id, parentId, message) => ({ type: 'message', id, parentId, timestamp: '2026-11-16T00:00:00Z', message });
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session', version: 3, id: 'p3', cwd: root }),
      JSON.stringify(entry('u', null, { role: 'user', content: [text('q')] })),
      JSON.stringify(entry('a', 'u', { role: 'assistant', stopReason: 'stop', usage: { ...usage, extra: 'SECRET' },
        content: [text('a')] })),
      '',
    ].join('\n'));
    const read = sessionHistory.readSessionMessages(file);
    const assistant = read.execution.timeline.find(block => block.kind === 'assistant');
    deep(assistant.usage, usage, '服务端历史投影只返回白名单字段');
    ok('响应中没有原始 message/参数/自由文本', !JSON.stringify(read.execution).includes('SECRET')
      && !JSON.stringify(read.execution).toLowerCase().includes('"args"'));

    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session', version: 3, id: 'p3', cwd: root }),
      JSON.stringify(entry('u', null, { role: 'user', content: [text('q')] })),
      JSON.stringify(entry('a', 'u', { role: 'assistant', content: [text('a')] })),
      '',
    ].join('\n'));
    const old = sessionHistory.readSessionMessages(file);
    equal(old.execution.timeline.find(block => block.kind === 'assistant').usage, undefined, '旧记录不显示虚构 0');
  }

  console.log('P3-B/D：Runtime 实时与历史渲染');
  {
    let historyPayload = { ok: true, conversationId: 'R', sessionId: 's-R',
      messages: [{ role: 'user', text: 'history q' }], truncated: false,
      execution: { truncated: false, planBoundary: null, timeline: [
        { id: 'h-user-0', kind: 'user', text: 'history q', userIndex: 0 },
        { id: 'h-thinking-0', kind: 'thinking', text: 'history think', state: 'complete', usage: { input: 1, output: 2, totalTokens: 3 } },
        { id: 'h-assistant-0', kind: 'assistant', text: 'history a', state: 'complete', usage: { ...usage, costTotal: 0.0123 } },
      ] } };
    global.fetch = async () => ({ json: async () => historyPayload });
    runtimeStore.seed({ backendInstance: 'backend', items: [
      { conversationId: 'R', createdAt: '2026-01-01T00:00:00.000Z', workspace: { branch: 'r', projectId: 'project' },
        owner: owner('R'), lifecycle: 'ready', activity: 'running', attention: false },
      { conversationId: 'HIST', createdAt: '2026-01-01T00:00:00.000Z', workspace: { branch: 'h', projectId: 'project' },
        owner: null, lifecycle: 'dormant', activity: 'idle', attention: false, nativeSessionId: 'native-HIST' },
    ] });
    const host = d.createElement('div');
    d.body.append(host);
    const view = RTC.createRuntimeConversation({ host });
    view.show('R');
    const usageButtonIn = root => root?.querySelector('.message-usage') || null;
    const openUsage = button => {
      if (!button) return null;
      button.click();
      return d.querySelector('#messageUsagePopover');
    };
    const closeUsage = () => d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    /* 第一个网格是整轮汇总；逐响应网格排在它后面。 */
    const popValue = (pop, kind) => pop?.querySelector('.usage-pop-grid')
      ?.querySelector(`[data-kind="${kind}"]`)?.textContent || '';
    let sequence = 0;
    const frame = event => observeRuntimeFrame({ type: 'runtime_event', owner: owner('R'),
      eventSequence: ++sequence, event });
    frame({ type: 'agent_start' });
    frame({ type: 'message_start', message: { role: 'user', content: [text('live q')] } });
    frame({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage, content: [text('live a')] } });
    await tick();
    const liveButton = usageButtonIn(host.querySelector('.rtc-output .rtc-timeline-message[data-role="assistant"]'));
    ok('实时 usage 成为助手操作栏里唯一的统计入口', Boolean(liveButton)
      && host.querySelectorAll('.rtc-output .message-usage').length === 1);
    equal(liveButton?.getAttribute('aria-label'), '查看用量', '入口名称描述动作而不是堆数字');
    equal(liveButton?.title, '', '不再叠加原生 title tooltip');
    const livePop = openUsage(liveButton);
    equal(livePop?.hidden, false, '点击浮出轻量用量弹层');
    equal(livePop?.querySelector('.usage-pop-head > span')?.textContent, '本轮用量');
    equal(popValue(livePop, 'input'), '11 Token');
    equal(popValue(livePop, 'output'), '7 Token');
    equal(popValue(livePop, 'reasoning'), '4 Token');
    equal(popValue(livePop, 'totalTokens'), '21 Token');
    ok('推理仍标注为含在输出中', livePop?.textContent.includes('推理（含在输出中）'));
    ok('实时摘要带整轮 Token 总量', livePop?.textContent.includes('Token 21'));
    closeUsage();

    view.show('HIST');
    await tick();
    [...host.querySelectorAll('button')].find(button => button.textContent === '打开历史').click();
    await tick();
    const historyButton = usageButtonIn(host.querySelector('.rtc-output .rtc-timeline-message[data-role="assistant"]'));
    ok('历史 assistant 消息显示真实 usage', Boolean(historyButton));
    equal(host.querySelectorAll('.rtc-output .message-usage').length, 1,
      '同一回合的 Thinking 与正文用量合成一个入口');
    const historyPop = openUsage(historyButton);
    equal(historyPop?.querySelector('.usage-pop-head > span')?.textContent, '本轮用量');
    equal(popValue(historyPop, 'input'), '12 Token', '整轮汇总只累加每条响应都有的字段');
    equal(popValue(historyPop, 'output'), '9 Token');
    equal(popValue(historyPop, 'totalTokens'), '24 Token');
    equal(popValue(historyPop, 'reasoning'), '', '缺失字段不伪造，推理仅在第 2 条响应里出现');
    const historySections = historyPop?.querySelectorAll('.usage-pop-response') || [];
    equal(historySections.length, 2, '逐响应明细保留两条真实记录');
    equal(historySections[0]?.querySelector('[data-kind="totalTokens"]')?.textContent, '3 Token');
    equal(historySections[1]?.querySelector('[data-kind="totalTokens"]')?.textContent, '21 Token');
    equal(historySections[1]?.querySelector('[data-kind="reasoning"]')?.textContent, '4 Token');
    closeUsage();
    ok('历史提示说明用量可用', host.querySelector('.rtc-state').textContent.includes('正文与用量'));

    historyPayload = { ok: true, conversationId: 'R', sessionId: 's-R',
      messages: [{ role: 'user', text: 'history q' }], truncated: false,
      execution: { truncated: false, planBoundary: null, timeline: [
        { id: 'h-user-1', kind: 'user', text: 'history q', userIndex: 0 },
        { id: 'h-thinking-1', kind: 'thinking', text: '只思考', state: 'complete', usage: { input: 1, output: 2, totalTokens: 3 } },
      ] } };
    [...host.querySelectorAll('button')].find(button => button.textContent === '打开历史').click();
    await tick();
    ok('只有 Thinking 用量时提示仍与实际字段相符', host.querySelector('.rtc-state').textContent.includes('正文与用量'));
    equal(host.querySelectorAll('.rtc-output .rtc-timeline-message[data-role="assistant"]').length, 0,
      'Thinking-only 历史不伪造空的助手正文');
    const thinkingBar = host.querySelector('.rtc-output .conversation-work-log > .message-actions-usage-only');
    ok('Thinking-only 历史把真实 usage 挂在思考记录上且只挂一次', Boolean(thinkingBar)
      && host.querySelectorAll('.rtc-output .message-usage').length === 1);
    ok('思考折叠时用量入口仍在折叠列表之外', thinkingBar?.closest('.conversation-work-list') === null);
    const thinkingPop = openUsage(usageButtonIn(thinkingBar));
    equal(popValue(thinkingPop, 'totalTokens'), '3 Token');
    equal(popValue(thinkingPop, 'reasoning'), '', 'Thinking 记录没有的字段不补 0');
    closeUsage();

    historyPayload = { ok: true, conversationId: 'R', sessionId: 's-R',
      messages: [{ role: 'user', text: 'history q' }], truncated: false,
      execution: { truncated: false, planBoundary: null, timeline: [
        { id: 'h-user-2', kind: 'user', text: 'history q', userIndex: 0 },
        { id: 'h-plan-1', kind: 'plan', usage: { ...usage, costTotal: 0.0123 },
          plan: PM.normalizePlan({ version: 1,
            tasks: [{ id: 'p', title: '历史计划', status: 'in_progress' }],
            explanation: '历史计划说明', revision: 1, turnId: 'run-plan' }) },
      ] } };
    [...host.querySelectorAll('button')].find(button => button.textContent === '打开历史').click();
    await tick();
    const planHost = host.querySelector('.rtc-output .ui2-runtime-plan');
    const planBar = planHost?.querySelector(':scope > .message-actions-usage-only');
    const planButton = usageButtonIn(planBar);
    ok('plan-only 历史显示真实 usage', Boolean(planButton));
    const planPop = openUsage(planButton);
    equal(popValue(planPop, 'totalTokens'), '21 Token');
    equal(popValue(planPop, 'reasoning'), '4 Token');
    equal(popValue(planPop, 'cost'), '0.0123', 'Pi 已算好的成本仍可达');
    closeUsage();
    equal(host.querySelectorAll('.rtc-output .message-usage').length, 1,
      'plan-only 历史的 usage 只显示一次');
    equal(host.querySelectorAll('.rtc-output .rtc-timeline-message[data-role="assistant"]').length, 0,
      'plan-only 历史不伪造空的助手正文');
    ok('计划用量位于折叠列表之外', Boolean(planBar) && planBar.closest('.plan-list') === null);
    const planHead = planHost.querySelector('.plan-head');
    const planList = planHost.querySelector('.plan-list');
    planHead.click();
    equal(planHead.getAttribute('aria-expanded'), 'false', '计划卡仍可折叠');
    ok('折叠计划列表不影响用量显示', planList.hidden && planBar.isConnected);
    planHead.click();
    equal(planHead.getAttribute('aria-expanded'), 'true', '计划卡可再次展开');

    /* 同一 turnId 的两条 plan-only assistant 消息：一张卡、两条独立 usage。 */
    const firstTasks = [{ id: 'p', title: '计划任务', status: 'in_progress' }];
    const secondTasks = [{ id: 'p', title: '计划任务', status: 'completed' },
      { id: 'q', title: '后续任务', status: 'in_progress' }];
    const firstUsage = { input: 10, output: 2, totalTokens: 12 };
    const secondUsage = { input: 20, output: 3, totalTokens: 23 };
    const firstCall = { type: 'toolCall', id: 'plan-ui-1', name: 'gui_plan',
      arguments: { version: 1, tasks: firstTasks } };
    const secondCall = { type: 'toolCall', id: 'plan-ui-2', name: 'gui_plan',
      arguments: { version: 1, tasks: secondTasks } };
    const firstResult = { role: 'toolResult', toolCallId: 'plan-ui-1', toolName: 'gui_plan',
      content: [text('ok')], details: { version: 1, tasks: firstTasks, turnId: 'run-ui' }, timestamp: 2 };
    const secondResult = { role: 'toolResult', toolCallId: 'plan-ui-2', toolName: 'gui_plan',
      content: [text('ok')], details: { version: 1, tasks: secondTasks, turnId: 'run-ui' }, timestamp: 4 };
    const steerProjection = RT.timelineFromMessages([
      { role: 'user', content: [text('任务')], timestamp: 1 },
      { role: 'assistant', content: [firstCall], usage: firstUsage, timestamp: 2 },
      firstResult,
      { role: 'user', content: [text('补充指令')], timestamp: 3 },
      { role: 'assistant', content: [secondCall], usage: secondUsage, timestamp: 4 },
      secondResult,
    ]);
    historyPayload = { ok: true, conversationId: 'R', sessionId: 's-R',
      messages: [{ role: 'user', text: '任务' }, { role: 'user', text: '补充指令' }], truncated: false,
      execution: { truncated: false, planBoundary: 'verified', timeline: steerProjection.blocks } };
    [...host.querySelectorAll('button')].find(button => button.textContent === '打开历史').click();
    await tick();
    const steerPlanHosts = host.querySelectorAll('.rtc-output .ui2-runtime-plan');
    equal(steerPlanHosts.length, 1, '同一 turnId 的两条 plan-only 消息仍只有一张计划卡');
    const steerButton = usageButtonIn(steerPlanHosts[0]);
    ok('两条真实 usage 合成一个整轮入口', Boolean(steerButton)
      && host.querySelectorAll('.rtc-output .message-usage').length === 1);
    const steerPop = openUsage(steerButton);
    const steerSections = steerPop?.querySelectorAll('.usage-pop-response') || [];
    equal(steerSections.length, 2, '逐响应明细保留两条真实 usage');
    equal(steerSections[0]?.querySelector('[data-kind="totalTokens"]')?.textContent, '12 Token');
    equal(steerSections[1]?.querySelector('[data-kind="totalTokens"]')?.textContent, '23 Token',
      '两条 usage 数值不同且没有被覆盖');
    equal(popValue(steerPop, 'totalTokens'), '35 Token', '整轮汇总等于两条真实记录之和');
    closeUsage();
    equal(host.querySelectorAll('.rtc-output .rtc-timeline-message[data-role="assistant"]').length, 0,
      '同一 turnId 的 plan-only 历史仍不伪造正文');
    ok('多条用量时历史提示说明用量可用', host.querySelector('.rtc-state').textContent.includes('正文与用量'));
    const steerHead = steerPlanHosts[0].querySelector('.plan-head');
    const steerList = steerPlanHosts[0].querySelector('.plan-list');
    steerHead.click();
    equal(steerHead.getAttribute('aria-expanded'), 'false', '多用量计划卡仍可折叠');
    ok('折叠计划列表后两条用量仍可达',
      steerList.hidden && Boolean(steerButton?.isConnected));
    view.dispose(); host.remove();
  }

  console.log('P3-E：任务列表折叠摘要');
  {
    const plan = PM.normalizePlan({ version: 1, tasks: [
      { id: 'a', title: '已完成任务', status: 'completed' },
      { id: 'b', title: '已完成任务 2', status: 'completed' },
      { id: 'c', title: '当前正在执行的非常长的中文任务标题，用于验证折叠摘要的省略与悬停全文', status: 'in_progress' },
      { id: 'd', title: '待处理', status: 'pending' },
    ] });
    const card = PV.renderPlan(plan);
    d.body.append(card);
    const head = card.querySelector('.plan-head');
    const list = card.querySelector('.plan-list');
    const now = card.querySelector('.plan-now');
    equal(head.getAttribute('aria-expanded'), 'true', '默认展开不变');
    equal(list.hidden, false, '默认列表可见');
    equal(card.querySelector('.plan-count').textContent, '2/4', '头部显示真实完成计数');
    ok('in_progress 时摘要带当前任务标题', now.textContent.includes('正在执行：当前正在执行的非常长'));
    equal(now.title, '当前正在执行的非常长的中文任务标题，用于验证折叠摘要的省略与悬停全文', '悬停可看完整标题');
    ok('摘要标签有 aria-controls 指向列表', head.getAttribute('aria-controls') === list.id);

    head.click();
    equal(head.getAttribute('aria-expanded'), 'false', '折叠后 aria-expanded 同步');
    equal(list.hidden, true, '折叠后列表隐藏');
    equal(card.querySelector('.plan-count').textContent, '2/4', '折叠后仍显示真实完成数');

    PV.setPlanStalled(card, true);
    ok('stalled 时摘要改为“未完成”，不冒充正在执行', now.textContent.startsWith('未完成：') && !now.textContent.startsWith('正在执行'));
    equal(card.querySelector('.plan-item[data-status="in_progress"] .plan-state')?.textContent, '未完成', '任务行保留原有 stalled 文案');

    PV.updatePlan(card, PM.normalizePlan({ version: 1, tasks: [
      { id: 'a', title: '已完成任务', status: 'completed' },
      { id: 'b', title: '已完成任务 2', status: 'completed' },
      { id: 'c', title: '当前任务', status: 'completed' },
    ] }));
    equal(now.hidden, true, '没有 in_progress 时只保留完成计数');
    equal(card.querySelector('.plan-count').textContent, '3/3', '完成计数来自真实任务状态');
  }

  console.log('P3-A：工具组状态计数与并行耗时');
  {
    const { S } = await import(url('state.js'));
    S.thread = null;
    const group = V.createGroup();
    d.body.append(group);
    const now = Date.now();
    const make = (id, status, startedAt, endedAt, extra = {}) => {
      const entry = TM.makeEntry({ toolCallId: id, toolName: 'bash', args: {} }, startedAt);
      entry.status = status;
      entry.startedAt = startedAt;
      entry.endedAt = endedAt;
      entry.durationMs = endedAt == null ? null : Math.max(0, endedAt - startedAt);
      Object.assign(entry, extra);
      return V.renderEntry(entry);
    };
    V.addToGroup(group, make('a', 'success', now - 6000, now - 1000));
    V.addToGroup(group, make('b', 'error', now - 5000, now));
    equal(group.querySelector('.tl-group-time')?.textContent, '6.0s', '并行组耗时取最早开始到最晚结束，不叠加');
    equal(group.querySelector('.ui2-tool-state')?.textContent, '失败 1 · 成功 1', '失败/成功计数来自真实状态');

    V.addToGroup(group, make('c', 'running', now - 2000, null));
    const runningText = group.querySelector('.tl-group-time')?.textContent || '';
    ok('运行中的组耗时继续推进（最早开始到现在）', /^[6-9]\.\d s$/.test(runningText.replace(/(\d)s$/, '$1 s')) || /^[6-9]\.\ds$/.test(runningText));
    equal(group.querySelector('.ui2-tool-state')?.textContent, '运行中 1 · 失败 1 · 成功 1', '运行中单独计数');

    V.addToGroup(group, make('d', 'running', now - 1000, null, { waiting: true }));
    equal(group.querySelector('.ui2-tool-state')?.textContent, '运行中 1 · 等待写入 1 · 失败 1 · 成功 1', '等待写入与运行中分开计数');

    const endedBefore = group.querySelector('.tl-group-time')?.textContent;
    await new Promise(r => setTimeout(r, 350));
    equal(group.querySelector('.tl-group-time')?.textContent, endedBefore, '没有新的状态变化时已结束的秒表不自行跳动');

    const head = group.querySelector('.tl-group-head');
    head.click();
    equal(group.querySelector('.tl-list').hidden, true, '用户折叠生效');
    V.addToGroup(group, make('e', 'success', now - 500, now));
    equal(group.querySelector('.tl-list').hidden, true, '新工具到达不覆盖用户折叠');
    equal(group.querySelector('.ui2-tool-state')?.textContent, '运行中 1 · 等待写入 1 · 失败 1 · 成功 2', '折叠后状态计数仍更新');

    const missingGroup = V.createGroup();
    d.body.append(missingGroup);
    const missing = TM.makeEntry({ toolCallId: 'm', toolName: 'read', args: {} });
    missing.status = 'success';
    missing.startedAt = null;
    missing.endedAt = null;
    missing.durationMs = null;
    V.addToGroup(missingGroup, V.renderEntry(missing));
    V.addToGroup(missingGroup, make('n', 'success', now - 1000, now));
    equal(missingGroup.querySelector('.tl-group-time')?.hidden, false, '部分条目有真实时间时仍显示组耗时');
    const allMissing = V.createGroup();
    d.body.append(allMissing);
    V.addToGroup(allMissing, V.renderEntry(Object.assign(TM.makeEntry({ toolCallId: 'x', toolName: 'read', args: {} }), { status: 'success', startedAt: null, endedAt: null, durationMs: null })));
    V.addToGroup(allMissing, V.renderEntry(Object.assign(TM.makeEntry({ toolCallId: 'y', toolName: 'read', args: {} }), { status: 'success', startedAt: null, endedAt: null, durationMs: null })));
    equal(allMissing.querySelector('.tl-group-time')?.hidden, true, '全部缺时间戳时省略组耗时，不伪造 0.0s');
  }

  console.log('P3-F：role=log 与折叠控件 aria 关系');
  {
    const stream = d.querySelector('#stream');
    equal(stream.getAttribute('role'), 'log', 'Classic #stream 使用 role=log');
    equal(stream.getAttribute('aria-live'), 'off', '容器不逐 token 播报');
    equal(stream.getAttribute('aria-atomic'), 'false', '容器不是原子播报');
    equal(stream.getAttribute('aria-label'), '对话记录', '日志区域有可访问名称');

    const host = d.createElement('div');
    d.body.append(host);
    runtimeStore.seed({ backendInstance: 'backend', items: [
      { conversationId: 'A11Y', createdAt: '2026-01-01T00:00:00.000Z', workspace: { branch: 'a', projectId: 'project' },
        owner: owner('A11Y'), lifecycle: 'ready', activity: 'idle', attention: false },
    ] });
    const view = RTC.createRuntimeConversation({ host });
    view.show('A11Y');
    const output = host.querySelector('.rtc-output');
    equal(output.getAttribute('role'), 'log', 'Runtime .rtc-output 使用 role=log');
    equal(output.getAttribute('aria-live'), 'off', 'Runtime 容器不随流式重建播报');
    view.dispose(); host.remove();

    const group = V.createGroup();
    d.body.append(group);
    V.addToGroup(group, V.renderEntry(Object.assign(TM.makeEntry({ toolCallId: 'k1', toolName: 'read', args: {} }), { status: 'success' })));
    V.addToGroup(group, V.renderEntry(Object.assign(TM.makeEntry({ toolCallId: 'k2', toolName: 'read', args: {} }), { status: 'success' })));
    const head = group.querySelector('.tl-group-head');
    const list = group.querySelector('.tl-list');
    equal(head.getAttribute('aria-controls'), list.id, '工具组头 aria-controls 指向列表');
    equal(head.getAttribute('aria-expanded'), 'false', '全部已结束的多项组默认折叠（紧凑）');
    equal(list.hidden, true, '默认折叠与 aria-expanded 一致');
    head.click();
    equal(head.getAttribute('aria-expanded'), 'true', '展开后 aria-expanded 同步');

    const detailToggle = group.querySelector('.tl-toggle');
    const more = group.querySelector('.tl-more');
    equal(detailToggle.getAttribute('aria-controls'), more.id, '工具详情按钮 aria-controls 指向详情');
    equal(detailToggle.getAttribute('aria-expanded'), 'false', '工具详情默认折叠');

    const plan = PV.renderPlan(PM.normalizePlan({ version: 1, tasks: [{ id: 'p', title: 'A', status: 'in_progress' }] }));
    d.body.append(plan);
    equal(plan.querySelector('.plan-head').getAttribute('aria-controls'), plan.querySelector('.plan-list').id,
      '任务卡头 aria-controls 指向列表');
  }

  const total = passed + failed;
  console.log(`\nSession UX Phase 3: ${passed}/${total}; failed=${failed}; jsdom 行为契约，不含像素验收`);
  process.exitCode = failed ? 1 : 0;
})();
