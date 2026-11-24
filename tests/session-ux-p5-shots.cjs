/* Local Chromium proof of both live surfaces using the existing offline fixture server. */
'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const historyOut = process.env.P5C_SCREENSHOTS;
const out = path.resolve(historyOut || process.env.P5B_SCREENSHOTS || '.shots/session-ux-p5b');
const chromePath = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(file => fs.existsSync(file));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(get, name) {
  for (let n = 0; n < 100; n++) {
    const result = await Promise.resolve().then(get).catch(() => null);
    if (result) return result;
    await wait(100);
  }
  throw Error(name);
}

async function seedSurface(mode) {
  const modules = await Promise.all([
    import('/state.js'), import('/messages.js'), import('/tools.js'), import('/execution-timeline-state.js'),
    import('/classic-execution-view.js'), import('/runtime-state.js'), import('/runtime-conversation.js'),
    import('/ui/workspace-surface.js'),
  ]);
  const [{ S }, M, T, state, classic, runtime, rtc, surface] = modules;
  const owner = { backendInstance: 'fixture', projectId: 'fixture', repoId: 'repo', workspaceId: 'workspace',
    workspaceEpoch: '1', runtimeId: 'fixture-runtime', runtimeGeneration: '1', sessionId: 'fixture-session',
    conversationId: 'fixture-p5b' };
  const execution = { startSequence: 0, branchEpoch: 0, observedAt: Date.now() - 25000 };
  const start = Date.now() - 25000;
  let seq = 0;
  if (mode === 'classic') {
    M.clearThread();
    M.ensureThread();
  } else {
    surface.showRuntimeConversation();
    const host = document.querySelector('#runtimeView');
    host.replaceChildren();
    const view = rtc.createRuntimeConversation({ host });
    runtime.seedRuntimeSnapshot({ backendInstance: owner.backendInstance, items: [{
      conversationId: owner.conversationId, owner, execution,
      workspace: { branch: 'p5b-fixture', projectId: owner.projectId, workspaceId: owner.workspaceId, workspaceEpoch: owner.workspaceEpoch },
      title: '代码审查演示', lifecycle: 'ready', activity: 'running',
    }] });
    view.show(owner.conversationId);
  }
  function emit(type, data = {}) {
    const event = { type, ...data };
    const observedAt = start + (++seq * 400);
    if (mode === 'runtime') {
      runtime.observeRuntimeFrame({ type: 'runtime_event', owner, eventSequence: seq, event,
        execution: { ...execution, observedAt } });
      return;
    }
    Object.assign(event, { _seq: seq, legacyOwner: owner,
      executionClassic: { sessionId: owner.sessionId, branchEpoch: 0, observedAt } });
    state.observeClassicExecution(event);
    classic.scheduleClassicExecutionView(event);
    if (type === 'agent_start') { M.beginTurn(); M.setStreaming(true); }
    if (type === 'agent_settled') M.onSettled();
    if (type === 'message_start') M.onMessageStart(event);
    if (type === 'message_end') M.onMessageEnd(event);
    if (type === 'tool_execution_start') T.onToolStart(event);
    if (type === 'tool_execution_end') T.onToolEnd(event);
  }
  const text = text => ({ type: 'text', text });
  const message = (role, content, stopReason) => {
    const message = { role, content, stopReason,
      ...(role === 'assistant' && { model: 'fixture-model', provider: 'fixture', usage: { input: 48, output: 12, reasoning: 0, totalTokens: 60 } }),
    };
    emit('message_start', { message });
    emit('message_end', { message });
  };
  const lines = [
    '请检查会话面板的执行顺序，并验证读取、搜索、修改三类工具的结果能按开始顺序查看。',
    '先核对范围，再阅读布局和已保留的测试夹具。并行检查记录与会话归属。',
    '失败的搜索需要可回查，输出只显示已取得的数据。',
    '保留原来的 Markdown 最终回答和折叠后的用量明细。',
    '多模型执行时，逐个响应保存模型和原始计数。',
    '验证窄屏、浅色和键盘；用户回到历史时恢复阅读位置。',
    '最后核对处理时间、运行状态和文件变更行数。',
    '[验收记录](#fixture-verification)',
  ];
  emit('execution_submission', { id: 'fixture-prompt', command: 'prompt' });
  emit('agent_start');
  message('user', [text(lines.join('\n\n'))]);

  const plan = { tool: 'gui_plan', version: 1, turnId: 'fixture-plan', revision: 1,
    tasks: [{ id: 'read', title: '核对事件和现有渲染', status: 'completed' },
      { id: 'fixtures', title: '检查会话夹具', status: 'in_progress' },
      { id: 'regression', title: '定向回归', status: 'pending' }] };
  const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
  message('assistant', [call('plan', 'gui_plan', plan)], 'toolUse');
  emit('tool_execution_start', { toolCallId: 'plan', toolName: 'gui_plan',
    ...(mode === 'classic' ? { args: plan } : { plan }) });
  emit('tool_execution_end', { toolCallId: 'plan',
    ...(mode === 'classic' ? { result: { details: plan } } : { plan }) });
  const tools = [
    { id: 'read', name: 'read', args: { path: 'state.js', offset: 31, limit: 42 },
      facts: { kind: 'read', title: '读取 state.js', fileName: 'state.js', requestedRange: { start: 31, end: 72 } } },
    { id: 'edit', name: 'edit', args: { path: 'contract.js', oldText: 'state', newText: 'currentState' },
      facts: { kind: 'edit', title: '修改 contract.js', fileName: 'contract.js', diffStat: { added: 6, removed: 3 } } },
    { id: 'grep', name: 'grep', args: { pattern: 'runtimeScope' },
      facts: { kind: 'search', title: '搜索 runtimeScope', query: 'runtimeScope' } },
  ];
  message('assistant', [text('先并行读取和核对调用边界。'), { type: 'thinking', thinking: '已公开的思考文本。' },
    ...tools.map(tool => call(tool.id, tool.name, tool.args))], 'toolUse');
  for (const tool of tools) emit('tool_execution_start', {
    toolCallId: tool.id, toolName: tool.name, activity: tool.facts, ...(mode === 'classic' && { args: tool.args }),
  });
  emit('tool_execution_end', { toolCallId: 'grep', isError: true, durationMs: 840,
    ...(mode === 'classic' && { result: { content: [text('搜索失败：路径超出夹具目录。')] } }) });
  emit('tool_execution_end', { toolCallId: 'edit', durationMs: 1250, activity: tools[1].facts,
    ...(mode === 'classic' && { result: { content: [text('更新了 contract.js')] } }) });
  globalThis.finishP5b = () => {
    emit('tool_execution_end', { toolCallId: 'read', durationMs: 2220, activity: tools[0].facts,
      ...(mode === 'classic' && { result: { content: [text('const state = readState();\nreturn state.owner;')] } }) });
    message('assistant', [text('已核对 **事件顺序**。搜索失败已保留，文件修改可以逐条回查。')], 'stop');
    emit('agent_settled', { aborted: false });
    if (mode === 'runtime') {
      const item = runtime.runtimeStore.get(owner.conversationId).item;
      runtime.observeRuntimeFrame({ type: 'runtime_state', owner, item: { ...item, activity: 'idle' } });
    }
  };
}

async function makeHistoryFixture() {
  const { projectExecutionHistory } = await import('../server/execution-timeline-history.js');
  const locator = { projectId: 'fixture', workspaceId: 'fixture-w', workspaceEpoch: '1',
    conversationId: 'fixture-p5c', nativeSessionId: 'fixture-session' };
  const text = text => ({ type: 'text', text });
  const specs = [['read-state', 'read', { path: 'src/state.js', offset: 31, limit: 8 }],
    ['read-contract', 'read', { path: 'src/contract.js', offset: 4, limit: 12 }],
    ['read-missing', 'read', { path: 'src/missing.js' }]];
  const messages = [
    { role: 'user', content: [text('请核对会话恢复后，执行记录是否仍按实际开始顺序排列。')] },
    { role: 'assistant', stopReason: 'toolUse', model: 'fixture-review', usage: { input: 48, output: 12 },
      content: [text('先核对会话状态和读取边界。'), { type: 'thinking', thinking: '离线夹具的公开思考内容。' },
        ...specs.map(([id, name, arguments_]) => ({ type: 'toolCall', id, name, arguments: arguments_ }))] },
    ...specs.map(([id, name], index) => ({ role: 'toolResult', toolCallId: id, toolName: name,
      isError: index === 2, content: [text(index === 2 ? '找不到夹具文件' : 'const history = readFixture();')] })),
    { role: 'assistant', stopReason: 'stop', model: 'fixture-answer', usage: { input: 51, output: 24 },
      content: [text('已核对 **历史恢复**。三个活动的状态和原有用量记录均已保留。')] },
  ];
  const native = messages.map((message, i) => ({ type: 'message', id: 'entry-' + i,
    parentId: i ? 'entry-' + (i - 1) : null, message }));
  const leafId = native.at(-1).id;
  const record = { inputId: 'entry-0', beforeLeafId: null, leafId, status: 'completed', finalResponseId: leafId,
    timing: { startedAt: 500, endedAt: 2500 }, entries: native.map(row => ({ id: row.id, role: row.message.role })),
    tools: [1, 0, 2].map((i, start) => ({ callId: specs[i][0], responseId: 'entry-1', resultId: 'entry-' + (i + 2),
      startedAt: 700 + 100 * start, endedAt: 1700 + 100 * start, durationMs: 1000,
      status: i === 2 ? 'failed' : 'completed' })) };
  const read = classic => projectExecutionHistory(native, [record], { sessionId: locator.nativeSessionId, leafId, classic });
  return { locator, classic: read(true), runtime: read(false) };
}

async function seedHistory(mode, packet, locator) {
  if (mode === 'classic') {
    const [messages, { S }] = await Promise.all([import('/messages.js'), import('/state.js')]);
    S.state = { ...S.state, sessionId: packet.sessionId };
    messages.rebuildFromMessages(packet, packet.sessionId);
    return;
  }
  const [runtime, { createRuntimeConversation }, surface] = await Promise.all([
    import('/runtime-state.js'), import('/runtime-conversation.js'), import('/ui/workspace-surface.js'),
  ]);
  surface.showRuntimeConversation();
  const host = document.querySelector('#runtimeView');
  host.replaceChildren();
  const view = createRuntimeConversation({ host });
  runtime.seedRuntimeSnapshot({ backendInstance: 'fixture', items: [{ conversationId: locator.conversationId,
    owner: null, nativeSessionId: locator.nativeSessionId, workspace: locator,
    title: '历史验收会话', lifecycle: 'dormant', activity: 'idle' }] });
  const original = globalThis.fetch;
  globalThis.fetch = (url, options) => new URL(url, location.href).pathname === '/api/runtime-sessions'
    && new URL(url, location.href).searchParams.get('conversationId') === locator.conversationId
    ? Promise.resolve(new Response(JSON.stringify({ ...packet, locator }))) : original(url, options);
  try { return await view.openHistory(locator); }
  finally { globalThis.fetch = original; }
}

async function measureActivityWindow() {
  const { createExecutionTurnView } = await import('/execution-timeline-view.js');
  const stream = document.querySelector('#stream');
  const makeSpacer = () => Object.assign(document.createElement('div'), { style: 'height:1000px; flex-shrink:0' });
  const turn = { id: 'stress', status: 'completed' };
  const group = { id: 'group', turnId: turn.id, status: 'completed' };
  const items = Array.from({ length: 2000 }, (_, sequence) => ({ id: 'item-' + sequence, turnId: turn.id,
    parentId: group.id, position: { sequence, part: 0 }, kind: 'tool', status: 'completed',
    title: '读取 fixture-' + sequence + '.js', detailRef: { state: 'pending' } }));
  const view = createExecutionTurnView({ document });
  view.update({ turn, group, items });
  stream.replaceChildren(makeSpacer(), view.node, makeSpacer());
  const head = view.node.querySelector('.execution-activity-group > button');
  head.scrollIntoView({ block: 'center', behavior: 'instant' });
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  await frame();
  await frame();
  const closedRows = view.node.querySelectorAll('.execution-activity-item').length;
  const closedDetail = view.node.querySelectorAll('.execution-tool-native').length;
  const before = head.getBoundingClientRect().top;
  const start = performance.now();
  head.click();
  await frame();
  const firstFrameMs = performance.now() - start;
  await frame();
  const afterOpen = head.getBoundingClientRect().top;
  const openRows = view.node.querySelectorAll('.execution-activity-item').length;
  const row = view.node.querySelector('.execution-activity-item > button');
  const rowBefore = row.getBoundingClientRect().top;
  row.click();
  await frame();
  const native = document.createElement('div');
  native.style.height = '220px';
  native.textContent = '已返回的夹具详情';
  view.update({ turn, group, items, details: new Map([[items[0].id, native]]) });
  await frame();
  await frame();
  const detailMounted = view.node.contains(native);
  const detailDelta = Math.abs(row.getBoundingClientRect().top - rowBefore);
  head.click();
  await frame();
  await frame();
  const closeDelta = Math.abs(head.getBoundingClientRect().top - before);
  const rowsAfterClose = view.node.querySelectorAll('.execution-activity-item').length;
  return { itemCount: items.length, closedRows, closedDetail, openRows, detailMounted, detailDelta,
    firstFrameMs, openDelta: Math.abs(afterOpen - before), closeDelta, rowsAfterClose };
}

function measure(root, scroller) {
  const pixel = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  function rgba(color) {
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = color;
    pixel.fillRect(0, 0, 1, 1);
    return [...pixel.getImageData(0, 0, 1, 1).data].map(value => value / 255);
  }
  function luminance(rgb) {
    const channels = rgb.slice(0, 3)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  function blend(color, bg) {
    return bg.map((under, index) => color[index] * color[3] + under * (1 - color[3]));
  }
  function background(node) {
    const layers = [];
    for (let parent = node; parent; parent = parent.parentElement) {
      const color = rgba(getComputedStyle(parent).backgroundColor);
      if (color[3]) layers.unshift(color);
      if (color[3] === 1) break;
    }
    return layers.reduce((under, layer) => blend(layer, under), [1, 1, 1]);
  }
  function ratio(color, bg) {
    const a = luminance(blend(rgba(color), bg)), b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  const group = root.querySelector('.execution-activity-group > button');
  const text = [...root.querySelectorAll('.execution-head-title, .execution-activity-status')]
    .filter(node => node.getBoundingClientRect().height > 0)
    .map(node => ratio(getComputedStyle(node).color, background(node)));
  return {
    overflow: Math.max(root.scrollWidth - root.clientWidth, scroller.scrollWidth - scroller.clientWidth),
    rows: [...root.querySelectorAll('.execution-activity-item > button')].map(row => row.getBoundingClientRect().height),
    taskExpandable: !root.querySelector('.execution-task-more').hidden,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    textContrast: Math.min(...text),
    focusContrast: ratio(getComputedStyle(group).outlineColor, background(group)),
  };
}

/* Real Chromium matrix for the turn-duration fold. Uses the production view and
 * work-log modules in the actual page, with real CSS and scrolling. */
async function seedFoldCase(kind) {
  const { createExecutionTurnView } = await import('/execution-timeline-view.js');
  const thread = document.querySelector('#stream .thread');
  thread.replaceChildren();
  const now = Date.now();
  const [status, elapsed] = {
    completed: ['completed', 207000], running: ['running', 5000], failed: ['failed', 12000],
    stopped: ['cancelled', 8000], interrupted: ['interrupted', 8000],
    continued: ['completed', 9000], long: ['completed', 45000],
  }[kind];
  const startedAt = now - elapsed;
  const endedAt = status === 'running' ? null : now;
  const turnId = 'fold-' + kind;
  const turn = { id: turnId, status, sessionId: 'fold-session', source: 'classic-rpc',
    evidence: 'verified', completeness: 'complete', position: { domain: 'live', sequence: 1 },
    input: { id: turnId + ':input:1', content: { source: 'live-buffer', state: 'available' } },
    timing: { startedAt, endedAt, evidence: 'observed' } };
  const group = { id: turnId + ':group', turnId, status,
    activeItemId: status === 'running' ? 'fold-2' : null,
    timing: { startedAt, endedAt, evidence: 'observed' } };
  const item = (id, itemStatus, title, summary, sequence, timing) => ({ id, turnId,
    parentId: group.id, position: { sequence, part: 0 }, status: itemStatus, kind: 'tool',
    title, summary, detailRef: { state: 'restricted' }, ...(timing ? { timing } : {}) });
  let items = [
    item('fold-1', 'completed', '读取 state.js', { fileName: 'state.js' }, 1),
    item('fold-2', status === 'running' ? 'running' : status === 'failed' ? 'failed'
      : kind === 'stopped' || kind === 'interrupted' ? 'interrupted' : 'completed',
      '运行命令', { command: 'npm test -- conversation' }, 2),
  ];
  if (kind === 'long') items = Array.from({ length: 60 }, (_, index) => item('fold-' + index,
    'completed', '执行', { command: 'npm run verify:' + 'x'.repeat(90) }, index + 1));
  if (kind === 'continued') {
    items = [
      item('fold-1', 'completed', '读取 state.js', { fileName: 'state.js' }, 1,
        { startedAt: now - 9000, endedAt: now - 8200, evidence: 'observed' }),
      item('fold-2', 'completed', '运行命令', { command: 'npm test -- first' }, 3,
        { startedAt: now - 7500, endedAt: now - 6500, evidence: 'observed' }),
      item('fold-3', 'completed', '运行命令', { command: 'npm test -- second' }, 5,
        { startedAt: now - 3500, endedAt: now - 1500, evidence: 'observed' }),
    ];
  }
  const input = document.createElement('article');
  input.className = 'msg user';
  input.textContent = '请检查执行顺序、工具结果和最终回答。';
  const answer = document.createElement('article');
  answer.className = 'msg assistant';
  const answerBody = document.createElement('div');
  answerBody.className = 'msg-body';
  answerBody.textContent = '最终回答仍然保持可见，并保有自己的阅读文本。';
  answer.append(answerBody);
  const view = createExecutionTurnView({ document, now: () => now });
  thread.append(view.node);
  if (kind === 'long') {
    const spacer = document.createElement('div');
    spacer.style.height = '1200px';
    spacer.style.flexShrink = '0';
    thread.append(spacer);
  }
  const payload = { turn, group, items, input, answer: [answer] };
  if (kind === 'continued') {
    const steer = label => {
      const node = document.createElement('article');
      node.className = 'msg user';
      node.textContent = label;
      return node;
    };
    const first = steer('补充要求 A');
    const second = steer('补充要求 B');
    payload.steers = [first, second];
    payload.workOrder = [
      { activityId: 'fold-1', sequence: 1, part: 0 },
      { node: first, steer: true, startedAt: now - 8000, steerKey: 'a' },
      { activityId: 'fold-2', sequence: 3, part: 0 },
      { node: second, steer: true, startedAt: now - 4000, steerKey: 'b' },
      { activityId: 'fold-3', sequence: 5, part: 0 },
    ];
  }
  view.update(payload);
  const raf = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await raf();
  const head = view.node.querySelector('.execution-activity-group > .execution-head');
  const count = view.node.querySelector('.execution-activity-count');
  const wasOpen = head.getAttribute('aria-expanded') === 'true';
  const selection = getSelection();
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(view.node.querySelector('[data-execution-part="answer"] .msg-body') || answerBody);
  selection.addRange(range);
  const selectedBefore = selection.toString();
  const beforeTop = head.getBoundingClientRect().top;
  head.click();
  await raf();
  const openDelta = Math.abs(head.getBoundingClientRect().top - beforeTop);
  const selectionPreserved = Boolean(selectedBefore) && selection.toString() === selectedBefore;
  selection.removeAllRanges();
  head.click();
  await raf();
  let visibleRows = 0;
  let rangeText = '';
  let labelClipped = null;
  if (kind === 'long') {
    head.click();
    await raf();
    labelClipped = (() => {
      const label = view.node.querySelector('.execution-activity-item .execution-head-title');
      return label ? label.scrollWidth > label.clientWidth + 1 : null;
    })();
    const more = view.node.querySelector('.execution-activity-more');
    if (more && !more.hidden) {
      more.click();
      await raf();
    }
    visibleRows = view.node.querySelectorAll('.execution-activity-item').length;
    rangeText = view.node.querySelector('.execution-activity-range')?.textContent || '';
  }
  const steers = [...view.node.querySelectorAll('[data-execution-part="activity-flow"] > .msg.user')];
  return { kind, title: head.querySelector('.execution-head-title').textContent,
    titles: [...view.node.querySelectorAll('.execution-activity-group')].map(node =>
      node.querySelector(':scope > .execution-head > .execution-head-title')?.textContent || ''),
    expanded: wasOpen, rows: view.node.querySelectorAll('.execution-activity-item').length,
    countText: count ? count.textContent : '', openDelta, selectionPreserved,
    steers: steers.length,
    steerVisible: steers.length > 0 && steers.every(node => node.getBoundingClientRect().height > 0),
    overflow: Math.max(thread.scrollWidth - thread.clientWidth, view.node.scrollWidth - view.node.clientWidth),
    visibleRows, rangeText, labelClipped };
}

async function seedNativeFoldCase() {
  const [{ createConversationFlow }, tool] = await Promise.all([
    import('/conversation-work-log.js'), import('/tool-view.js'),
  ]);
  const thread = document.querySelector('#stream .thread');
  thread.replaceChildren();
  const now = Date.now();
  const user = document.createElement('article');
  user.className = 'msg user';
  user.textContent = '请运行一条带长参数的命令。';
  user.dataset.turnStartAt = String(now - 2000);
  user.dataset.turnEndedAt = String(now);
  user.dataset.turnStatus = 'completed';
  const group = tool.createGroup();
  const command = 'npm run verify:conversation-timeline -- --case=long-command --include-trace --worker=1 --filter='
    + 'fixture'.repeat(24);
  tool.addToGroup(group, tool.renderEntry({ id: 'native-long', name: 'bash', label: '执行', known: true,
    status: 'success', args: { command }, summary: command, command, path: '', output: 'ok',
    resultLine: 'ok', durationMs: 800, startedAt: now - 1800, endedAt: now - 1000 }));
  thread.append(user, group);
  const flow = createConversationFlow();
  flow.render(thread);
  const head = thread.querySelector('.conversation-work-head');
  if (head.getAttribute('aria-expanded') === 'false') head.click();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const label = thread.querySelector('.tl-label');
  const arg = thread.querySelector('.tl-arg');
  const toggle = thread.querySelector('.tl-toggle');
  const dot = thread.querySelector('.tl-dot');
  const row = thread.querySelector('.tl-head');
  return { title: thread.querySelector('.conversation-work-title').textContent,
    workLabel: label.textContent, labelWidth: label.getBoundingClientRect().width,
    labelClient: label.clientWidth, labelScroll: label.scrollWidth,
    labelClipped: label.scrollWidth > label.clientWidth + 1,
    argWidth: arg.getBoundingClientRect().width, toggleWidth: toggle.getBoundingClientRect().width,
    dotWidth: dot.getBoundingClientRect().width, rowHeight: row.getBoundingClientRect().height,
    overflow: thread.scrollWidth - thread.clientWidth };
}

/* 用量入口是助手操作栏里的一枚统计图标：默认不抢阅读注意力，但**保留
 * 24px 的常驻槽位**，所以 hover / 聚焦 / 打开 Popover 都不会让消息或下一条
 * 跳动。这里用真实 messageActions 构树，不走已删除的旧元信息页脚。 */
async function seedUsageCase() {
  const { messageActions } = await import('/ui/message-actions.js');
  const stream = document.querySelector('#stream');
  stream.scrollTop = 0;
  const thread = stream.querySelector('.thread');
  thread.replaceChildren();
  const now = Date.now();
  const userText = '请说明这个补丁的用量。';
  const user = document.createElement('article');
  user.className = 'msg user';
  user.id = 'usage-user';
  user.setAttribute('aria-label', '你');
  const userBody = document.createElement('div');
  userBody.className = 'msg-body';
  userBody.textContent = userText;
  const userBar = messageActions(userText, { onEdit: () => {} });
  user.append(userBody, userBar);
  const message = document.createElement('article');
  message.className = 'msg assistant';
  message.id = 'usage-msg';
  message.setAttribute('aria-label', '助手');
  message.dataset.turnStartAt = String(now - 3200);
  message.dataset.turnEndedAt = String(now);
  message.dataset.turnStatus = 'completed';
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.innerHTML = '<p>用量来自 Pi 的真实上报，默认收进操作栏中的统计图标。</p>'
    + '<pre class="code"><code>const usage = await readUsage();</code></pre>'
    + '<table><thead><tr><th>字段</th><th>值</th></tr></thead><tbody>'
    + '<tr><td>输出</td><td>220</td></tr></tbody></table>';
  const bar = messageActions(body.textContent, {
    onRegenerate: () => {},
    usage: [{ usage: { input: 1540, output: 220, reasoning: 120, totalTokens: 1880,
      cacheRead: 64, cacheWrite: 32, costTotal: 0.0123 }, model: 'fixture-model', responseId: 'resp-1' }],
    usageOptions: { label: '本轮用量', status: 'completed',
      timing: { startedAt: now - 3200, endedAt: now, durationMs: null, evidence: 'observed' } },
  });
  message.append(body, bar);
  const next = document.createElement('article');
  next.className = 'msg assistant';
  next.id = 'usage-next';
  next.setAttribute('aria-label', '助手');
  next.textContent = '下一条消息';
  thread.append(user, message, next);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  /* 字体与入场动画在首帧后仍可能改变 1–2px；等排版稳定再交给几何断言。 */
  await new Promise(resolve => setTimeout(resolve, 260));
  const box = element => {
    const r = element.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const buttons = [...bar.querySelectorAll('button')];
  const icon = bar.querySelector('.message-usage svg');
  return {
    barOpacity: Number(getComputedStyle(bar).opacity),
    userBarOpacity: Number(getComputedStyle(userBar).opacity),
    buttonCount: buttons.length,
    buttonBoxes: buttons.map(box),
    iconBox: icon ? box(icon) : null,
    nativeTitles: buttons.filter(button => button.hasAttribute('title')).length,
    labels: buttons.map(button => button.getAttribute('aria-label')),
    bodyBottom: box(body).bottom,
    barTop: box(bar).top,
    barBottom: box(bar).bottom,
    nextTop: box(next).top,
    messageHeight: message.offsetHeight,
    userBarRight: box(userBar).right,
    userBodyRight: box(userBody).right,
    scrollTop: stream.scrollTop,
    usageLabel: bar.querySelector('.message-usage')?.getAttribute('aria-label') || '',
    overflow: stream.scrollWidth - stream.clientWidth,
  };
}

/* 「你好啊」的最短会话：用户气泡靠右、回答靠左，两条操作栏都要在
 * 各自正文下方留出稳定槽位，用量图标只在真实 usage 存在时出现。 */
async function seedGreetingCase() {
  const { messageActions } = await import('/ui/message-actions.js');
  const stream = document.querySelector('#stream');
  stream.scrollTop = 0;
  const thread = stream.querySelector('.thread');
  thread.replaceChildren();
  const user = document.createElement('article');
  user.className = 'msg user';
  user.id = 'greet-user';
  user.setAttribute('aria-label', '你');
  const userBody = document.createElement('div');
  userBody.className = 'msg-body';
  userBody.textContent = '你好啊';
  const userBar = messageActions('你好啊', { onEdit: () => {} });
  user.append(userBody, userBar);
  const answer = document.createElement('article');
  answer.className = 'msg assistant';
  answer.id = 'greet-answer';
  answer.setAttribute('aria-label', '助手');
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = '你好！有什么我可以帮你的吗？';
  const bar = messageActions(body.textContent, {
    onRegenerate: () => {},
    usage: [{ usage: { input: 12, output: 9, totalTokens: 21 } }],
    usageOptions: { label: '本条助手消息用量' },
  });
  answer.append(body, bar);
  thread.append(user, answer);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise(resolve => setTimeout(resolve, 260));
  const box = element => {
    const r = element.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const composer = document.querySelector('#chatComposer');
  return {
    userBody: box(userBody), userBar: box(userBar), answerBody: box(body), answerBar: box(bar),
    thread: box(thread),
    userBarOpacity: Number(getComputedStyle(userBar).opacity),
    answerBarOpacity: Number(getComputedStyle(bar).opacity),
    userButtons: [...userBar.querySelectorAll('button')].map(button => button.getAttribute('aria-label')),
    answerButtons: [...bar.querySelectorAll('button')].map(button => button.getAttribute('aria-label')),
    composerTop: composer && composer.getClientRects().length ? composer.getBoundingClientRect().top : null,
    oldEntries: document.querySelectorAll('.ui2-msg-meta, .ui2-runtime-usage, .execution-usage').length,
    overflow: stream.scrollWidth - stream.clientWidth,
    messageHeight: answer.offsetHeight,
    scrollTop: stream.scrollTop,
  };
}

/* 两轮对话：每轮只有一枚真实用量入口，轮与轮之间不重复、不额外留白。 */
async function seedMultiTurnCase() {
  const { messageActions } = await import('/ui/message-actions.js');
  const stream = document.querySelector('#stream');
  stream.scrollTop = 0;
  const thread = stream.querySelector('.thread');
  thread.replaceChildren();
  const turn = (index, usage, answerText) => {
    const user = document.createElement('article');
    user.className = 'msg user';
    user.id = 'multi-user-' + index;
    user.setAttribute('aria-label', '你');
    const userBody = document.createElement('div');
    userBody.className = 'msg-body';
    userBody.textContent = index === 1 ? '第一个问题' : '第二个问题';
    user.append(userBody, messageActions(userBody.textContent, { onEdit: () => {} }));
    const answer = document.createElement('article');
    answer.className = 'msg assistant';
    answer.id = 'multi-answer-' + index;
    answer.setAttribute('aria-label', '助手');
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = answerText;
    answer.append(body, messageActions(answerText, {
      onRegenerate: () => {},
      usage: [{ usage }],
      usageOptions: { label: '本轮用量' },
    }));
    return [user, answer];
  };
  thread.append(...turn(1, { input: 10, output: 5, totalTokens: 15 }, '第一个回答。'),
    ...turn(2, { input: 20, output: 7, totalTokens: 27 }, '第二个回答，稍微长一点，但仍是单行。'));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise(resolve => setTimeout(resolve, 260));
  const answers = [...thread.querySelectorAll('.msg.assistant')];
  const bars = answers.map(answer => answer.querySelector('.message-actions'));
  const bodies = answers.map(answer => answer.querySelector('.msg-body'));
  const box = element => {
    const r = element.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height };
  };
  return {
    usageButtons: thread.querySelectorAll('.message-usage').length,
    bars: bars.map(box), bodies: bodies.map(box),
    messageHeights: answers.map(answer => answer.offsetHeight),
    nextTops: [bars[0].getBoundingClientRect().bottom, thread.querySelector('#multi-user-2').getBoundingClientRect().top],
    oldEntries: thread.querySelectorAll('.ui2-msg-meta, .ui2-runtime-usage, .execution-usage').length,
    overflow: stream.scrollWidth - stream.clientWidth,
    scrollTop: stream.scrollTop,
  };
}

async function main() {
  assert.ok(chromePath, 'set CHROME_PATH to a locally installed Chromium');
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p5b-chrome-'));
  const harness = spawn(process.execPath, [path.join(__dirname, 'visual-harness.cjs')], {
    env: { ...process.env, HARNESS_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
  });
  let url, chrome, ws;
  harness.stdout.on('data', chunk => { url ||= String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]; });
  const results = [];
  try {
    await until(() => url, 'offline fixture did not start');
    chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-background-networking',
      '--disable-component-update', '--disable-default-apps', '--no-first-run', '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
    { stdio: 'ignore', windowsHide: true });
    const target = await until(async () => {
      const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0];
      const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      return pages.find(page => page.type === 'page')?.webSocketDebuggerUrl;
    }, 'Chromium DevTools did not start');
    ws = new WebSocket(target);
    await once(ws, 'open');
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      callback(message);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      pending.set(++id, message => message.error ? reject(Error(message.error.message)) : resolve(message.result));
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (exceptionDetails) throw Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    };
    const shot = async name => {
      const image = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
    };
    const key = async (name, code, number) => {
      const fields = { key: name, code, windowsVirtualKeyCode: number, nativeVirtualKeyCode: number };
      const text = name === 'Enter' ? '\r' : name === ' ' ? ' ' : '';
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...fields, text, unmodifiedText: text });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...fields });
      await wait(80);
    };
    const hover = async selector => {
      const point = await evaluate('(() => { const e = document.querySelector(' + JSON.stringify(selector) + ');'
        + 'if (!e) throw Error("missing " + ' + JSON.stringify(selector) + ');'
        + 'const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await wait(140);
    };
    const click = async selector => {
      const point = await evaluate('(() => { const e = document.querySelector(' + JSON.stringify(selector) + ');'
        + 'if (!e) throw Error("missing " + ' + JSON.stringify(selector) + ');'
        + 'const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await wait(160);
    };
    const moveAway = async () => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8 });
      await wait(140);
    };
    await send('Page.enable');
    await send('Page.navigate', { url });
    await until(() => evaluate("document.readyState === 'complete' && Boolean(document.querySelector('#stream .thread'))"), 'application did not boot');
    await wait(500);
    if (historyOut) {
      const fixture = await makeHistoryFixture();
      for (const mode of ['classic', 'runtime']) {
        const scroller = mode === 'classic' ? '#stream' : '#runtimeView .rtc-output';
        const select = 'document.querySelector(' + JSON.stringify(scroller + ' .execution-turn') + ')';
        await send('Emulation.setDeviceMetricsOverride', { width: 1320, height: 820, deviceScaleFactor: 1, mobile: false });
        await evaluate('(' + seedHistory.toString() + ')(' + [mode, fixture[mode], fixture.locator].map(value => JSON.stringify(value)).join(',') + ')');
        await until(() => evaluate('Boolean(' + select + '?.querySelector("[data-execution-part=answer] strong"))'), mode + ' recovered answer missing');
        await evaluate(select + '.querySelector(".execution-activity-group > button").click()');
        assert.equal(await evaluate(select + '.querySelectorAll(".execution-activity-item").length'), 3);
        assert.match(await evaluate(select + '.querySelector(".execution-activity-item").textContent'), /contract\.js/);
        await evaluate(select + '.querySelector(".execution-activity-item > button").click()');
        const detail = await evaluate(select + '.querySelector(".execution-activity-item").textContent');
        assert.match(detail, mode === 'classic' ? /const history = readFixture/ : /当前视图无权读取详情/);
        if (mode === 'runtime') assert.doesNotMatch(detail, /const history = readFixture/);
        for (const [theme, width, height] of [['dark', 1320, 820], ['light', 700, 640]]) {
          const name = [mode, 'restored', theme, width].join('-');
          await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
          await evaluate('document.documentElement.dataset.theme = ' + JSON.stringify(theme) + '; document.querySelector('
            + JSON.stringify(scroller) + ').scrollTop = 0');
          await wait(140);
          const metric = await evaluate('(' + measure.toString() + ')(' + select + ', document.querySelector(' + JSON.stringify(scroller) + '))');
          assert.ok(metric.overflow <= 1 && metric.textContrast >= 4.5, JSON.stringify(metric));
          assert.ok(metric.rows.every(height => height >= 24 && height < 51), JSON.stringify(metric));
          results.push({ name, ...metric });
          await shot(name);
        }
        if (mode === 'classic') {
          const activity = await evaluate('(' + measureActivityWindow.toString() + ')()');
          assert.deepEqual([activity.closedRows, activity.closedDetail, activity.openRows, activity.rowsAfterClose], [0, 0, 40, 0]);
          assert.ok(activity.detailMounted && [activity.openDelta, activity.closeDelta, activity.detailDelta].every(delta => delta <= 2),
            JSON.stringify(activity));
          results.push(activity);
        }
      }
      fs.writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(results, null, 2) + '\n');
      console.log('P5-C Chromium: four restored layouts and 2,000 activities verified; ' + out);
      return;
    }
    for (const mode of ['classic', 'runtime']) {
      const selector = mode === 'classic' ? '#stream' : '#runtimeView .rtc-output';
      const view = selector + ' .execution-turn';
      const select = 'document.querySelector(' + JSON.stringify(view) + ')';
      const scroll = 'document.querySelector(' + JSON.stringify(selector) + ')';
      await send('Emulation.setDeviceMetricsOverride', { width: 1320, height: 820, deviceScaleFactor: 1, mobile: false });
      await evaluate('(' + seedSurface.toString() + ')(' + JSON.stringify(mode) + ')');
      await until(() => evaluate('Boolean(' + select + '?.querySelector(".execution-activity-group:not([hidden])"))'), mode + ' Timeline missing');
      const preview = select + '.querySelector(".execution-task-more")';
      const link = select + '.querySelector("[data-execution-part=input] a[href=\\"#fixture-verification\\"]")';
      await until(() => evaluate('!' + preview + '.hidden'), mode + ' task preview missing');
      assert.equal(await evaluate(link + '?.hasAttribute("inert")'), true, mode + ' clipped link approachable');
      await evaluate(preview + '.focus()');
      await key(' ', 'Space', 32);
      assert.equal(await evaluate(preview + '.getAttribute("aria-expanded")'), 'true');
      assert.equal(await evaluate(link + '.hasAttribute("inert")'), false);
      await key(' ', 'Space', 32);
      assert.equal(await evaluate(preview + '.getAttribute("aria-expanded")'), 'false');
      // 运行中的工作默认展开（T3 work-live 语义）；先回到关闭态，再用键盘打开，
      // 验证 Enter 的可达性而不是依赖某个默认值。
      await evaluate('(() => { const b = ' + select + '.querySelector(".execution-activity-group > button");'
        + 'if (b.getAttribute("aria-expanded") === "true") b.click(); b.focus(); })()');
      await key('Enter', 'Enter', 13);
      const keyboard = await evaluate('(() => { const b = ' + select + '.querySelector(".execution-activity-group > button");'
        + 'return { open: b.getAttribute("aria-expanded"), focused: b === document.activeElement, outline: getComputedStyle(b).outlineStyle }; })()');
      assert.deepEqual([keyboard.open, keyboard.focused], ['true', true]);
      assert.notEqual(keyboard.outline, 'none');
      for (const [theme, width, height, scale] of [['dark', 1320, 820, 1], ['light', 1320, 820, 1],
        ['dark', 700, 600, 1], ['light', 700, 600, 1.25]]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: scale > 1 ? 'reduce' : 'no-preference' }] });
        await evaluate('document.documentElement.dataset.theme = ' + JSON.stringify(theme)
          + '; document.documentElement.style.setProperty("--font-scale", ' + scale + '); ' + scroll + '.scrollTop = 0');
        await wait(180);
        const metric = await evaluate('(' + measure.toString() + ')(' + select + ', ' + scroll + ')');
        assert.ok(metric.overflow <= 1, JSON.stringify(metric));
        assert.equal(metric.rows.length, 3);
        assert.ok(metric.rows.every(height => height >= 24 && height < 51), JSON.stringify(metric));
        assert.ok(metric.textContrast >= 4.5 && metric.focusContrast >= 3, JSON.stringify(metric));
        assert.equal(metric.taskExpandable, true);
        if (scale > 1) assert.equal(metric.reducedMotion, true);
        const name = [mode, theme, width].join('-');
        results.push({ name, scale, ...metric, keyboard });
        if (width < 800) await evaluate(select + '.querySelector(".execution-activity-group").scrollIntoView({ block: "center", behavior: "instant" })');
        await shot(name);
      }
      await send('Emulation.setDeviceMetricsOverride', { width: 1320, height: 820, deviceScaleFactor: 1, mobile: false });
      await evaluate('document.documentElement.style.setProperty("--font-scale", 1)');
      await evaluate(select + '.querySelector(".execution-activity-item > button").click(); finishP5b()');
      await until(() => evaluate('Boolean(' + select + '?.querySelector("[data-execution-part=answer] strong"))'), mode + ' final answer missing');
      const detail = await evaluate(select + '.querySelector(".execution-activity-item").textContent');
      assert.match(detail, mode === 'classic' ? /const state = readState/ : /当前视图无权读取详情/);
      await evaluate(scroll + '.scrollTop = ' + scroll + '.scrollHeight');
      await shot(mode + '-detail-and-answer');
      const fold = await evaluate('(() => { const t = ' + select + ';'
        + 'const group = t.querySelector(".execution-activity-group");'
        + 'const head = group.querySelector(":scope > button");'
        + 'if (head.getAttribute("aria-expanded") === "true") head.click();'
        + 'const titles = [...t.querySelectorAll(".execution-activity-group")].map(g => g.querySelector(":scope > .execution-head > .execution-head-title")?.textContent || "");'
        + 'return { title: titles[0] || "", titles, logs: t.querySelectorAll(".conversation-work-log").length,'
        + 'expanded: head.getAttribute("aria-expanded"), count: group.querySelector(".execution-activity-count")?.textContent || "" }; })()');
      assert.match(fold.title, /^执行了 \d+(?:\.\d+)? 秒(?: · 1 项失败)?$/, mode + ' fold title: ' + fold.title);
      assert.equal(fold.titles.length, 1, mode + ' produced duplicate fold headings');
      assert.equal(fold.expanded, 'false', mode + ' completed fold should default closed');
      assert.equal(fold.logs, 0, mode + ' rendered a second native work-log heading');
      assert.match(fold.count, /3 项/);
      await evaluate(select + '.querySelector(".execution-activity-group").scrollIntoView({ block: "center", behavior: "instant" })');
      await wait(140);
      await shot(mode + '-completed-fold-collapsed');
      await evaluate(select + '.querySelector(".execution-activity-group > button").click()');
      await wait(140);
      await shot(mode + '-completed-fold-expanded');
    }

    /* ---------- P7：耗时折叠矩阵 ---------- */
    console.log('P7 fold matrix');
    await evaluate('(async () => { const surface = await import("/ui/workspace-surface.js");'
      + 'surface.showChat(); document.querySelector("#stream").scrollTop = 0; })()');
    const expectations = {
      completed: { title: '执行了 3 分 27 秒', expanded: false, rows: 0 },
      running: { title: '执行中 · 已运行 5 秒', expanded: true, rows: 2 },
      failed: { title: '执行失败 · 用时 12 秒', expanded: true, rows: 2 },
      stopped: { title: '你在 8 秒后停止', expanded: true, rows: 2 },
      interrupted: { title: '已中断 · 用时 8 秒', expanded: true, rows: 2 },
      continued: { titles: ['执行了 9 秒', '继续执行了 1.5 秒', '继续执行了 4 秒'], steers: 2 },
      long: { title: '执行了 45 秒', countText: '60 项', visibleRows: 20,
        rangeText: '41–60 / 60', labelClipped: false, expanded: false },
    };
    const variants = {
      completed: [['dark', 1320, 820, 1], ['light', 700, 640, 1]],
      running: [['dark', 1320, 820, 1]], failed: [['dark', 1320, 820, 1]],
      stopped: [['dark', 1320, 820, 1]], interrupted: [['dark', 1320, 820, 1]],
      continued: [['dark', 1320, 820, 1]], long: [['dark', 1320, 820, 1], ['light', 700, 640, 1.25]],
    };
    for (const [kind, expected] of Object.entries(expectations)) {
      for (const [theme, width, height, scale] of variants[kind]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
        await evaluate('document.documentElement.dataset.theme = ' + JSON.stringify(theme)
          + '; document.documentElement.style.setProperty("--font-scale", ' + scale
          + '); document.querySelector("#stream").scrollTop = 0');
        const f = await evaluate('(' + seedFoldCase.toString() + ')(' + JSON.stringify(kind) + ')');
        assert.ok(f.overflow <= 1, kind + ' horizontal overflow: ' + JSON.stringify(f));
        assert.ok(f.openDelta <= 2, kind + ' fold toggle moved the header: ' + JSON.stringify(f));
        assert.equal(f.selectionPreserved, true, kind + ' lost a text selection while folding');
        if (expected.titles) assert.deepEqual(f.titles, expected.titles);
        else {
          assert.equal(f.title, expected.title);
          assert.equal(f.titles.length, 1, kind + ' produced duplicate fold headings');
          assert.equal(f.expanded, expected.expanded);
        }
        if (kind === 'running') assert.equal(f.rows, expected.rows);
        if (kind === 'failed' || kind === 'stopped' || kind === 'interrupted') {
          assert.equal(f.rows, expected.rows);
          if (kind === 'failed') assert.match(f.countText, /1 项失败/);
        }
        if (kind === 'continued') {
          assert.equal(f.steers, 2);
          assert.equal(f.steerVisible, true);
        }
        if (kind === 'long') {
          assert.equal(f.countText, expected.countText);
          assert.equal(f.visibleRows, expected.visibleRows);
          assert.equal(f.rangeText, expected.rangeText);
          assert.equal(f.labelClipped, expected.labelClipped);
        }
        const name = ['fold', kind, theme, width].join('-');
        results.push({ name, scale, ...f });
        await shot(name);
      }
    }

    for (const [theme, width, height, scale] of [['dark', 1320, 820, 1], ['light', 700, 640, 1.5]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await evaluate('document.documentElement.dataset.theme = ' + JSON.stringify(theme)
        + '; document.documentElement.style.setProperty("--font-scale", ' + scale
        + '); document.querySelector("#stream").scrollTop = 0');
      const f = await evaluate('(' + seedNativeFoldCase.toString() + ')()');
      assert.equal(f.title, '执行了 2 秒', 'native fold title: ' + f.title);
      assert.equal(f.workLabel, '执行', 'native action name changed: ' + f.workLabel);
      assert.equal(f.labelClipped, false, 'action name was squeezed: ' + JSON.stringify(f));
      assert.ok(f.labelWidth >= 24, 'action name collapsed to nothing: ' + JSON.stringify(f));
      assert.ok(f.toggleWidth >= 16 && f.dotWidth >= 16, 'status/chevron squeezed: ' + JSON.stringify(f));
      assert.ok(f.rowHeight >= 24, 'work row below T3 24px baseline: ' + JSON.stringify(f));
      assert.ok(f.overflow <= 1, 'native long command overflow: ' + JSON.stringify(f));
      const name = ['fold-native-long', theme, width].join('-');
      results.push({ name, scale, ...f });
      await shot(name);
    }

    await send('Emulation.setDeviceMetricsOverride', { width: 1320, height: 820, deviceScaleFactor: 1, mobile: false });
    await evaluate('document.documentElement.dataset.theme = "dark"; document.documentElement.style.setProperty("--font-scale", 1)');
    await moveAway();
    const usage = await evaluate('(' + seedUsageCase.toString() + ')()');
    /* 默认隐藏但保留槽位：不透明度为 0，几何位置与 hover 后完全一致。 */
    assert.equal(usage.barOpacity, 0, 'assistant actions are not quiet at rest: ' + JSON.stringify(usage));
    assert.equal(usage.userBarOpacity, 0, 'user actions are not quiet at rest: ' + JSON.stringify(usage));
    assert.equal(usage.buttonCount, 3, 'assistant bar should be regenerate / copy / usage: ' + JSON.stringify(usage));
    assert.deepEqual(usage.labels, ['重新生成', '复制消息', '查看用量']);
    assert.ok(usage.buttonBoxes.every(box => Math.abs(box.width - 24) <= 0.5
      && Math.abs(box.height - 24) <= 0.5), 'action hit areas are not 24px: ' + JSON.stringify(usage.buttonBoxes));
    assert.ok(usage.iconBox && Math.abs(usage.iconBox.width - 16) <= 0.5
      && Math.abs(usage.iconBox.height - 16) <= 0.5, 'usage icon is not 16px: ' + JSON.stringify(usage.iconBox));
    const gaps = usage.buttonBoxes.slice(1).map((box, index) => box.left - usage.buttonBoxes[index].right);
    assert.ok(gaps.every(gap => gap >= 1 && gap <= 6), 'action spacing is inconsistent: ' + JSON.stringify(gaps));
    assert.equal(usage.nativeTitles, 0, 'native title tooltip was left on an action');
    assert.ok(usage.barBottom - usage.barTop >= 23.5, 'action bar lost its 24px slot: ' + JSON.stringify(usage));
    assert.ok(usage.bodyBottom <= usage.barTop + 0.5, 'action bar covers the answer: ' + JSON.stringify(usage));
    assert.ok(usage.barBottom <= usage.nextTop + 0.5, 'action bar crosses into the next message: ' + JSON.stringify(usage));
    assert.ok(Math.abs(usage.userBarRight - usage.userBodyRight) <= 1,
      'user actions do not align to the bubble trailing edge: ' + JSON.stringify(usage));
    assert.ok(usage.overflow <= 1, 'usage fixture overflowed horizontally: ' + JSON.stringify(usage));
    await shot('usage-bar-idle-dark');

    await hover('#usage-msg');
    const shown = await evaluate(`(() => {
      const msg = document.querySelector('#usage-msg');
      const bar = msg.querySelector('.message-actions');
      const body = msg.querySelector('.msg-body');
      const next = document.querySelector('#usage-next');
      const stream = document.querySelector('#stream');
      const r = bar.getBoundingClientRect(), b = body.getBoundingClientRect();
      return { opacity: Number(getComputedStyle(bar).opacity),
        pointerEvents: getComputedStyle(bar).pointerEvents,
        bodyBottom: b.bottom, barTop: r.top, barBottom: r.bottom,
        nextTop: next.getBoundingClientRect().top,
        messageHeight: msg.offsetHeight, scrollTop: stream.scrollTop };
    })()`);
    assert.ok(shown.opacity > 0.95, 'actions did not reveal on hover: ' + JSON.stringify(shown));
    assert.equal(shown.pointerEvents, 'auto');
    for (const key of ['bodyBottom', 'barTop', 'barBottom', 'nextTop', 'messageHeight', 'scrollTop']) {
      assert.equal(shown[key], usage[key], 'hover changed layout at ' + key + ': ' + JSON.stringify(shown));
    }
    /* 指针从正文移到操作栏不能把按钮藏掉。 */
    await hover('#usage-msg .message-usage');
    const tip = await evaluate(`(() => {
      const bar = document.querySelector('#usage-msg .message-actions');
      const t = document.querySelector('.ui-tooltip');
      if (!t || t.hidden) return { opacity: Number(getComputedStyle(bar).opacity) };
      const r = t.getBoundingClientRect();
      return { opacity: Number(getComputedStyle(bar).opacity), text: t.textContent,
        role: t.getAttribute('role'), position: getComputedStyle(t).position,
        left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    })()`);
    assert.ok(tip.opacity > 0.95, 'body-to-bar hover hid the actions: ' + JSON.stringify(tip));
    assert.equal(tip.text, '查看用量');
    assert.equal(tip.role, 'tooltip');
    assert.equal(tip.position, 'fixed');
    assert.ok(tip.left >= 7.5 && tip.top >= 7.5 && tip.right <= 1320 - 7.5 && tip.bottom <= 820 - 7.5,
      'tooltip left the viewport: ' + JSON.stringify(tip));
    assert.ok(tip.top >= usage.bodyBottom - 0.5, 'tooltip covers the answer: ' + JSON.stringify(tip));
    await shot('usage-bar-hover-dark');

    /* 键盘聚焦同样要显示操作栏，且焦点离开后恢复安静。 */
    await moveAway();
    assert.ok(await evaluate('Number(getComputedStyle(document.querySelector("#usage-msg .message-actions")).opacity)') < 0.2,
      'actions stayed visible after moving away');
    await evaluate('document.querySelector("#usage-msg .message-usage").focus()');
    await moveAway();
    const focusedOpacity = await evaluate('Number(getComputedStyle(document.querySelector("#usage-msg .message-actions")).opacity)');
    assert.ok(focusedOpacity > 0.95, 'actions did not reveal on keyboard focus: ' + focusedOpacity);
    await evaluate('document.activeElement.blur()');
    await moveAway();
    assert.ok(await evaluate('Number(getComputedStyle(document.querySelector("#usage-msg .message-actions")).opacity)') < 0.2,
      'actions stayed visible after blur');

    /* 真实点击打开浮层：固定定位，不改变消息高度、下一条位置或滚动。 */
    await click('#usage-msg .message-usage');
    const pop = await evaluate(`(() => {
      const el = document.querySelector('#messageUsagePopover');
      const msg = document.querySelector('#usage-msg');
      const bar = msg.querySelector('.message-actions');
      const body = msg.querySelector('.msg-body');
      const next = document.querySelector('#usage-next');
      const stream = document.querySelector('#stream');
      const composer = document.querySelector('#chatComposer');
      const r = el.getBoundingClientRect();
      const c = composer && composer.getClientRects().length ? composer.getBoundingClientRect() : null;
      return { hidden: el.hidden, position: getComputedStyle(el).position, role: el.getAttribute('role'),
        left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
        viewportWidth: innerWidth, viewportHeight: innerHeight, composerTop: c ? c.top : null,
        text: el.textContent, values: [...el.querySelectorAll('.usage-pop-value')].map(n => n.textContent),
        sections: el.querySelectorAll('.usage-pop-response').length,
        expanded: bar.querySelector('.message-usage').getAttribute('aria-expanded'),
        tooltipHidden: !document.querySelector('.ui-tooltip') || document.querySelector('.ui-tooltip').hidden,
        bodyBottom: body.getBoundingClientRect().bottom, barTop: bar.getBoundingClientRect().top,
        barBottom: bar.getBoundingClientRect().bottom, nextTop: next.getBoundingClientRect().top,
        messageHeight: msg.offsetHeight, scrollTop: stream.scrollTop };
    })()`);
    assert.equal(pop.hidden, false, 'usage popover did not open');
    assert.equal(pop.position, 'fixed', 'usage popover is not fixed: ' + JSON.stringify(pop));
    assert.equal(pop.role, 'dialog');
    assert.equal(pop.expanded, 'true');
    assert.equal(pop.tooltipHidden, true, 'tooltip remained above the popover');
    assert.ok(pop.left >= 7.5 && pop.top >= 7.5
      && pop.right <= pop.viewportWidth - 7.5 && pop.bottom <= pop.viewportHeight - 7.5,
    'popover left the viewport: ' + JSON.stringify(pop));
    if (pop.composerTop !== null) {
      assert.ok(pop.bottom <= pop.composerTop - 7.5, 'popover overlaps the composer: ' + JSON.stringify(pop));
    }
    assert.ok(pop.width <= 340.5 && pop.height <= 420.5, 'popover exceeded its compact bounds: ' + JSON.stringify(pop));
    for (const [key, expected] of [['bodyBottom', usage.bodyBottom], ['barTop', usage.barTop],
      ['barBottom', usage.barBottom], ['nextTop', usage.nextTop],
      ['messageHeight', usage.messageHeight], ['scrollTop', usage.scrollTop]]) {
      assert.equal(pop[key], expected, 'opening the popover changed layout at ' + key + ': ' + JSON.stringify(pop));
    }
    assert.match(pop.text, /本轮用量/);
    assert.match(pop.text, /Token 1,880/);
    assert.match(pop.text, /耗时 3\.2 秒/);
    assert.match(pop.text, /模型 fixture-model/);
    assert.match(pop.text, /推理（含在输出中）/);
    assert.match(pop.text, /预估成本/);
    assert.deepEqual(pop.values, ['1,540 Token', '220 Token', '64 Token', '32 Token',
      '120 Token', '1,880 Token', '0.0123']);
    assert.equal(pop.sections, 0, 'one response should not be split into sections');
    assert.doesNotMatch(pop.text, /流式中/);
    await shot('usage-popover-dark');

    await key('Escape', 'Escape', 27);
    const escaped = await evaluate(`(() => { const el = document.querySelector('#messageUsagePopover');
      const btn = document.querySelector('#usage-msg .message-usage');
      const msg = document.querySelector('#usage-msg');
      return { hidden: el.hidden, expanded: btn.getAttribute('aria-expanded'),
        messageHeight: msg.offsetHeight, scrollTop: document.querySelector('#stream').scrollTop }; })()`);
    assert.equal(escaped.hidden, true, 'Escape did not close the usage popover');
    assert.equal(escaped.expanded, 'false');
    assert.equal(escaped.messageHeight, usage.messageHeight, 'Escape changed message height');
    assert.equal(escaped.scrollTop, usage.scrollTop, 'Escape changed scroll position');

    await click('#usage-msg .message-usage');
    assert.equal(await evaluate('document.querySelector("#messageUsagePopover").hidden'), false);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 8, y: 8, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 8, y: 8, button: 'left', clickCount: 1 });
    await wait(140);
    assert.equal(await evaluate('document.querySelector("#messageUsagePopover").hidden'), true,
      'outside click did not close the usage popover');
    results.push({ name: 'usage-action-bar', ...usage, shown, tip, focusedOpacity, pop, escaped });

    /* 窄屏 + 浅色 + 字体缩放：浮层仍要夹在可视区内并让开输入框。 */
    await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 640, deviceScaleFactor: 1, mobile: false });
    await evaluate('document.documentElement.dataset.theme = "light"; document.documentElement.style.setProperty("--font-scale", 1.25)');
    await moveAway();
    const narrow = await evaluate('(' + seedUsageCase.toString() + ')()');
    assert.ok(narrow.overflow <= 1, 'narrow usage fixture overflowed: ' + JSON.stringify(narrow));
    await hover('#usage-msg');
    await click('#usage-msg .message-usage');
    const narrowPop = await evaluate(`(() => {
      const el = document.querySelector('#messageUsagePopover');
      const msg = document.querySelector('#usage-msg');
      const body = msg.querySelector('.msg-body');
      const bar = msg.querySelector('.message-actions');
      const next = document.querySelector('#usage-next');
      const composer = document.querySelector('#chatComposer');
      const r = el.getBoundingClientRect(), b = body.getBoundingClientRect();
      const a = bar.getBoundingClientRect(), n = next.getBoundingClientRect();
      const c = composer && composer.getClientRects().length ? composer.getBoundingClientRect() : null;
      return { hidden: el.hidden, left: r.left, top: r.top, right: r.right, bottom: r.bottom,
        width: r.width, height: r.height, viewportWidth: innerWidth, viewportHeight: innerHeight,
        composerTop: c ? c.top : null, bodyBottom: b.bottom, barTop: a.top,
        barBottom: a.bottom, nextTop: n.top, messageHeight: msg.offsetHeight,
        scrollTop: document.querySelector('#stream').scrollTop,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    })()`);
    assert.equal(narrowPop.hidden, false);
    assert.ok(narrowPop.left >= 7.5 && narrowPop.top >= 7.5
      && narrowPop.right <= narrowPop.viewportWidth - 7.5 && narrowPop.bottom <= narrowPop.viewportHeight - 7.5,
    'narrow popover left the viewport: ' + JSON.stringify(narrowPop));
    if (narrowPop.composerTop !== null) {
      assert.ok(narrowPop.bottom <= narrowPop.composerTop - 7.5,
        'narrow popover overlaps the composer: ' + JSON.stringify(narrowPop));
    }
    assert.ok(narrowPop.scrollWidth <= narrowPop.clientWidth + 1, 'popover content overflows horizontally');
    assert.ok(narrowPop.bodyBottom <= narrowPop.barTop + 0.5 && narrowPop.barBottom <= narrowPop.nextTop + 0.5,
      'narrow action bar overlaps a neighbour: ' + JSON.stringify(narrowPop));
    await shot('usage-popover-light-narrow');
    results.push({ name: 'usage-popover-narrow', ...narrowPop });

    /* 「你好啊」最短会话：真实气泡/操作栏几何 + 用量入口。 */
    await send('Emulation.setDeviceMetricsOverride', { width: 1320, height: 820, deviceScaleFactor: 1, mobile: false });
    await evaluate('document.documentElement.dataset.theme = "dark"; document.documentElement.style.setProperty("--font-scale", 1)');
    await moveAway();
    const greet = await evaluate('(' + seedGreetingCase.toString() + ')()');
    assert.equal(greet.oldEntries, 0, '旧用量入口仍出现在「你好啊」会话里');
    assert.ok(greet.overflow <= 1, 'greeting overflowed: ' + JSON.stringify(greet));
    assert.deepEqual(greet.userButtons, ['编辑并重新发送', '复制消息']);
    assert.deepEqual(greet.answerButtons, ['重新生成', '复制消息', '查看用量']);
    assert.equal(greet.userBarOpacity, 0, 'greeting user bar is not quiet at rest');
    assert.equal(greet.answerBarOpacity, 0, 'greeting answer bar is not quiet at rest');
    assert.ok(Math.abs(greet.userBody.right - greet.userBar.right) <= 1,
      'greeting user actions are not on the bubble trailing edge: ' + JSON.stringify(greet));
    assert.ok(greet.userBody.right > greet.thread.left + greet.thread.width * 0.6,
      'greeting user bubble is not on the right: ' + JSON.stringify(greet));
    assert.ok(greet.answerBody.left < greet.thread.left + greet.thread.width * 0.5,
      'greeting answer is not on the reading edge: ' + JSON.stringify(greet));
    assert.ok(greet.userBar.bottom <= greet.answerBody.top + 0.5,
      'greeting user bar overlaps the answer: ' + JSON.stringify(greet));
    assert.ok(greet.answerBody.bottom <= greet.answerBar.top + 0.5,
      'greeting answer bar covers the answer: ' + JSON.stringify(greet));
    if (greet.composerTop !== null) {
      assert.ok(greet.answerBar.bottom <= greet.composerTop + 0.5,
        'greeting answer bar reaches the composer: ' + JSON.stringify(greet));
    }
    await shot('greeting-idle-dark');
    await hover('#greet-answer');
    const greetShown = await evaluate(`(() => {
      const answer = document.querySelector('#greet-answer');
      const body = answer.querySelector('.msg-body');
      const bar = answer.querySelector('.message-actions');
      const stream = document.querySelector('#stream');
      const r = bar.getBoundingClientRect(), b = body.getBoundingClientRect();
      return { opacity: Number(getComputedStyle(bar).opacity), pointerEvents: getComputedStyle(bar).pointerEvents,
        bodyBottom: b.bottom, barTop: r.top, barBottom: r.bottom,
        messageHeight: answer.offsetHeight, scrollTop: stream.scrollTop };
    })()`);
    assert.ok(greetShown.opacity > 0.95 && greetShown.pointerEvents === 'auto',
      'greeting hover did not reveal the answer actions: ' + JSON.stringify(greetShown));
    assert.equal(greetShown.bodyBottom, greet.answerBody.bottom, 'greeting hover moved the answer');
    assert.equal(greetShown.barTop, greet.answerBar.top, 'greeting hover moved the action bar');
    assert.equal(greetShown.barBottom, greet.answerBar.bottom, 'greeting hover resized the action bar');
    assert.equal(greetShown.messageHeight, greet.messageHeight, 'greeting hover changed message height');
    assert.equal(greetShown.scrollTop, greet.scrollTop, 'greeting hover changed scroll');
    await hover('#greet-answer .message-usage');
    const greetTip = await evaluate(`(() => {
      const t = document.querySelector('.ui-tooltip');
      const r = t.getBoundingClientRect();
      return { hidden: t.hidden, text: t.textContent, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    })()`);
    assert.equal(greetTip.hidden, false, 'greeting tooltip did not appear');
    assert.equal(greetTip.text, '查看用量');
    assert.ok(greetTip.top >= greet.answerBody.bottom - 0.5,
      'greeting tooltip covers the answer: ' + JSON.stringify(greetTip));
    await shot('greeting-hover-dark');
    await click('#greet-answer .message-usage');
    const greetPop = await evaluate(`(() => {
      const el = document.querySelector('#messageUsagePopover');
      const stream = document.querySelector('#stream');
      const r = el.getBoundingClientRect();
      const composer = document.querySelector('#chatComposer');
      return { hidden: el.hidden, text: el.textContent, left: r.left, top: r.top, right: r.right, bottom: r.bottom,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        composerTop: composer && composer.getClientRects().length ? composer.getBoundingClientRect().top : null,
        scrollTop: stream.scrollTop };
    })()`);
    assert.equal(greetPop.hidden, false, 'greeting usage entry did not open its popover');
    assert.match(greetPop.text, /Token 21/);
    assert.match(greetPop.text, /输入\s*12 Token/);
    assert.match(greetPop.text, /输出\s*9 Token/);
    assert.ok(greetPop.left >= 7.5 && greetPop.top >= 7.5
      && greetPop.right <= greetPop.viewportWidth - 7.5 && greetPop.bottom <= greetPop.viewportHeight - 7.5,
    'greeting popover left the viewport: ' + JSON.stringify(greetPop));
    if (greetPop.composerTop !== null) {
      assert.ok(greetPop.bottom <= greetPop.composerTop - 7.5,
        'greeting popover overlaps the composer: ' + JSON.stringify(greetPop));
    }
    assert.equal(greetPop.scrollTop, greet.scrollTop, 'greeting popover changed scroll');
    await shot('greeting-usage-popover-dark');
    await key('Escape', 'Escape', 27);
    await hover('#greet-user');
    assert.ok(await evaluate('Number(getComputedStyle(document.querySelector("#greet-user .message-actions")).opacity)') > 0.95,
      'greeting user actions did not reveal on hover');
    await shot('greeting-user-hover-dark');
    results.push({ name: 'greeting-short-exchange', ...greet, shown: greetShown, tip: greetTip, popover: greetPop });

    /* 两轮对话：每轮一枚入口，打开第一轮不影响第二轮几何。 */
    await moveAway();
    const multi = await evaluate('(' + seedMultiTurnCase.toString() + ')()');
    assert.equal(multi.usageButtons, 2, 'multi-turn usage entries are duplicated or missing');
    assert.equal(multi.oldEntries, 0, 'multi-turn conversation kept an old usage entry');
    assert.ok(multi.overflow <= 1, 'multi-turn conversation overflowed: ' + JSON.stringify(multi));
    assert.ok(multi.bodies.every((body, index) => body.bottom <= multi.bars[index].top + 0.5),
      'multi-turn bar covers its answer: ' + JSON.stringify(multi));
    assert.ok(multi.bars[0].bottom <= multi.nextTops[1] + 0.5,
      'first-turn bar crosses into the second turn: ' + JSON.stringify(multi));
    const multiComposerTop = await evaluate(`(() => { const c = document.querySelector('#chatComposer');
      return c && c.getClientRects().length ? c.getBoundingClientRect().top : null; })()`);
    if (multiComposerTop !== null) {
      assert.ok(multi.bars[1].bottom <= multiComposerTop + 0.5,
        'second-turn bar reaches the composer: ' + JSON.stringify(multi));
    }
    await hover('#multi-answer-1');
    await hover('#multi-answer-1 .message-usage');
    await click('#multi-answer-1 .message-usage');
    const firstPop = await evaluate(`(() => { const el = document.querySelector('#messageUsagePopover');
      const stream = document.querySelector('#stream');
      const answers = [...document.querySelectorAll('#stream .msg.assistant')];
      return { hidden: el.hidden, text: el.textContent,
        heights: answers.map(answer => answer.offsetHeight), scrollTop: stream.scrollTop }; })()`);
    assert.equal(firstPop.hidden, false);
    assert.match(firstPop.text, /Token 15/);
    assert.doesNotMatch(firstPop.text, /Token 27/);
    assert.deepEqual(firstPop.heights, multi.messageHeights, 'opening turn-one usage moved a message');
    assert.equal(firstPop.scrollTop, multi.scrollTop, 'opening turn-one usage moved the scroll');
    await shot('multi-turn-usage-popover-dark');
    await key('Escape', 'Escape', 27);
    await hover('#multi-answer-2');
    await hover('#multi-answer-2 .message-usage');
    await click('#multi-answer-2 .message-usage');
    const secondPop = await evaluate(`(() => { const el = document.querySelector('#messageUsagePopover');
      return { hidden: el.hidden, text: el.textContent }; })()`);
    assert.equal(secondPop.hidden, false);
    assert.match(secondPop.text, /Token 27/);
    assert.doesNotMatch(secondPop.text, /Token 15/);
    assert.equal(await evaluate('document.querySelectorAll("#stream .message-usage").length'), 2,
      'opening usage created a duplicate entry');
    await key('Escape', 'Escape', 27);
    results.push({ name: 'multi-turn-usage', ...multi, first: firstPop, second: secondPop });

    fs.writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(results, null, 2) + '\n');
    console.log('P5-B Chromium: ' + results.length + ' layouts verified; ' + out);
  } finally {
    ws?.close();
    chrome?.kill();
    harness.kill();
    await wait(250);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
