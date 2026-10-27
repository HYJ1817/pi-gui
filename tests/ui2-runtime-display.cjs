/* UI-2B：Runtime 聊天的**安全展示投影**契约。
 *
 * 只测契约（归属隔离、有界、缺字段就省略、XSS、销毁清理），不测像素 —— 排版是
 * Agent C 的 CSS 与 Electron 截图的事，jsdom 不做布局。
 *
 * 数据全是 fixture：不发真实网络、不启 Pi、不碰用户数据。
 *
 * 覆盖任务里点名的每一条：两个会话不同状态 / A→B→A / 迟到流式事件 / 停止·关闭·恢复 /
 * 有界输出与截断 / 模型能力未知 / 历史数据缺字段 / 审批隔离 / XSS / 销毁后订阅清理。
 */
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

(async () => {
  let checks = 0;
  const ok = (label, value) => { assert.ok(value, label); checks++; console.log('  ok  ' + label); };

  const dom = new JSDOM('<div id="host"></div><div id="modal" hidden><div id="modalCard"></div></div>'
    + '<div id="confirmLayer" hidden><div id="confirmCard"></div></div><div id="toasts"></div>', { url: 'http://127.0.0.1/' });
  global.window = dom.window; global.document = dom.window.document; global.localStorage = dom.window.localStorage;

  const { runtimeStore, observeRuntimeFrame } = await import('../public/runtime-state.js');
  const { createRuntimeConversation } = await import('../public/runtime-conversation.js');
  const { createRuntimeDisplay, usageText, readUsage, thinkingText } = await import('../public/runtime-display.js');
  const { createRuntimeStore } = await import('../public/runtime-store.js');

  const owner = (id, gen = 'one') => ({ backendInstance: 'backend', projectId: 'project', repoId: 'repo', workspaceId: 'ws-' + id,
    workspaceEpoch: 'epoch', conversationId: id, runtimeId: 'rt-' + id, runtimeGeneration: gen, sessionId: 's-' + id });
  const item = (id, extra = {}) => ({ conversationId: id, createdAt: '2026-01-0' + (id === 'A' ? '1' : '2') + 'T00:00:00.000Z',
    workspace: { branch: 'branch-' + id, projectId: 'project' }, owner: owner(id), lifecycle: 'ready', activity: 'running',
    attention: false, error: null, stop: null, ...extra });

  const requests = [];
  let historyResult = { ok: true, messages: [], truncated: false };
  global.fetch = async (url, opts = {}) => ({ json: async () => {
    if (!opts.body) {
      if (String(url).includes('conversationId=')) return historyResult;
      return { ok: true, backendInstance: 'backend', items: [] };
    }
    const body = JSON.parse(opts.body); requests.push(body); return { ok: true };
  } });

  const host = document.querySelector('#host');
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
  const frame = (id, seq, event, gen = 'one') => observeRuntimeFrame({ type: 'runtime_event', owner: owner(id, gen), eventSequence: seq, event });
  const delta = (id, seq, text, gen = 'one') => frame(id, seq, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } }, gen);
  const thinkDelta = (id, seq, text, gen = 'one') => frame(id, seq, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: text } }, gen);

  /* ================= 1. 纯函数：缺字段就省略，不补 0 ================= */

  ok('usage：没有有效数字就是 null（缺字段 ≠ 0）', readUsage({}) === null && readUsage({ cost: {} }) === null && readUsage(null) === null);
  ok('usage：真实 0 保留，缺的字段不出现', (() => {
    const value = readUsage({ input: 0, output: 12, cacheRead: null, cost: { total: 0 } });
    return value.input === 0 && value.output === 12 && !('cacheRead' in value) && value.costTotal === 0;
  })());
  ok('usage 文案：只列有的字段，且**不带**货币符号（线上没有单位）', (() => {
    const text = usageText({ input: 0, output: 1234, source: 'message_end' });
    return text === '本轮 · 输入 0 · 输出 1,234' && !text.includes('$') && !text.includes('缓存');
  })());
  ok('usage 文案：流式中的数字标注「仍在累计」，不当终值', usageText({ output: 5, source: 'message_update' }).includes('Pi 仍在累计'));
  ok('usage 文案：一个数字都没有时是空串（整块隐藏）', usageText({ source: 'message_end' }) === '' && usageText(null) === '');
  ok('thinkingText：没有 thinking 块返回 null（与「空思考」区分开）',
    thinkingText([{ type: 'text', text: 'hi' }]) === null && thinkingText('nope') === null && thinkingText([{ type: 'thinking', thinking: '' }]) === '');
  ok('thinkingText：多个 thinking 块按顺序拼接', thinkingText([{ type: 'thinking', thinking: 'a' }, { type: 'text', text: 'x' }, { type: 'thinking', thinking: 'b' }]) === 'a\n\nb');

  /* ================= 2. 两个会话不同状态 ================= */

  ok('集成：负数/小数Token与负成本不是有效用量', readUsage({ input: -1, output: 1.5, cost: { total: -0.1 } }) === null);
  ok('集成：真实零Token和非负小数成本仍保留', readUsage({ input: 0, cost: { total: 0.0123 } }).costTotal === 0.0123);

  runtimeStore.seed({ backendInstance: 'backend', items: [item('A'), item('B', { activity: 'idle' })] });
  const view = createRuntimeConversation({ host });
  const output = () => host.querySelector('.rtc-output');
  const stateLine = () => host.querySelector('.rtc-state').textContent;
  const thinkingBlock = () => host.querySelector('.ui2-runtime-thinking');
  const usageLine = () => host.querySelector('.ui2-runtime-usage');
  const toolRows = () => [...host.querySelectorAll('.ui2-runtime-tool')];
  const btn = text => [...host.querySelectorAll('button')].find(b => b.textContent === text);

  delta('A', 1, 'A-正文'); delta('B', 1, 'B-正文');
  thinkDelta('A', 2, 'A-在思考'); thinkDelta('B', 2, 'B-在思考');
  frame('A', 3, { type: 'tool_execution_start', toolCallId: 't-a', toolName: 'bash' });
  frame('B', 3, { type: 'tool_execution_start', toolCallId: 't-b', toolName: 'read' });
  frame('B', 4, { type: 'tool_execution_end', toolCallId: 't-b', toolName: 'read', isError: false });
  view.show('A'); await tick();
  ok('A 显示自己的正文', output().textContent === 'A-正文');
  ok('A 显示自己的 thinking 文本', thinkingBlock().hidden === false && thinkingBlock().querySelector('.ui2-runtime-thinking-body').textContent === 'A-在思考');
  ok('A 的思考块默认折叠（用户展开后不被流式收回）', thinkingBlock().open === false);
  ok('A 显示自己的工具与运行状态', toolRows().length === 1 && toolRows()[0].dataset.state === 'running' && toolRows()[0].textContent === 'bash · 运行中');
  ok('A 的状态行是自己的生命周期', stateLine().includes('就绪') && stateLine().includes('运行中'));
  ok('工具项之间只有空白文本节点（换成 flex+gap 时不会留下分隔符）', (() => {
    const rows = toolRows();
    return rows.length === 1 || rows.every((row, i) => i === 0
      || (row.previousSibling?.nodeType === 3 && row.previousSibling.data.trim() === ''));
  })());
  view.show('B'); await tick();
  ok('B 显示自己的正文、工具与完成状态', output().textContent === 'B-正文'
    && toolRows().length === 1 && toolRows()[0].dataset.state === 'done' && toolRows()[0].textContent === 'read · 完成');
  ok('B 的思考是自己的，不与 A 混', thinkingBlock().querySelector('.ui2-runtime-thinking-body').textContent === 'B-在思考');
  ok('B 的状态行反映空闲（两会话状态确实不同）', stateLine().includes('空闲') && !stateLine().includes('运行中'));

  /* ================= 3. A→B→A：迟到流式事件 ================= */

  view.show('A'); await tick();
  const beforeA = output().textContent;
  view.show('B'); await tick();
  delta('A', 4, '-迟到-A'); thinkDelta('A', 5, '-迟到思考-A');
  await tick();
  ok('切到 B 后 A 的迟到 delta 不进 B 的 DOM', output().textContent === 'B-正文' && !output().textContent.includes('迟到'));
  ok('切到 B 后 A 的迟到 thinking 不进 B 的思考块', thinkingBlock().querySelector('.ui2-runtime-thinking-body').textContent === 'B-在思考');
  view.show('A'); await tick();
  ok('切回 A 看到自己的迟到正文与迟到思考', output().textContent.includes('-迟到-A')
    && thinkingBlock().querySelector('.ui2-runtime-thinking-body').textContent.includes('-迟到思考-A') && output().textContent !== beforeA);

  /* ================= 4. 迟到的帧被 store 挡住时，投影也不该收到 ================= */

  const staleBefore = thinkingBlock().querySelector('.ui2-runtime-thinking-body').textContent;
  ok('重放同一 eventSequence 被拒（不重复追加）', observeRuntimeFrame({ type: 'runtime_event', owner: owner('A'), eventSequence: 5,
    event: { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '重复' } } }) === false
    && thinkingBlock().querySelector('.ui2-runtime-thinking-body').textContent === staleBefore);
  ok('旧 runtimeGeneration 的迟到帧被拒', observeRuntimeFrame({ type: 'runtime_event', owner: owner('A', 'old'), eventSequence: 99,
    event: { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '旧代次' } } }) === false
    && thinkingBlock().querySelector('.ui2-runtime-thinking-body').textContent === staleBefore);

  /* ================= 5. 单轮 usage：只报 Pi 报过的数字 ================= */

  frame('A', 6, { type: 'message_update', usage: { input: 10, output: 2, cost: { total: 0.001 } },
    assistantMessageEvent: { type: 'text_delta', delta: '!' } });
  await tick();
  ok('流式 usage 显示，并标注仍在累计', usageLine().hidden === false && usageLine().textContent.includes('输入 10') && usageLine().textContent.includes('仍在累计'));
  ok('usage 文案不含货币符号与凭据', !usageLine().textContent.includes('$') && !/apiKey|token=/i.test(usageLine().textContent));
  frame('A', 7, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: '权威思考' }, { type: 'text', text: '权威正文' }],
    usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.0025 } } } });
  await tick();
  ok('message_end 的 thinking 是权威值（覆盖流式累积）', thinkingBlock().querySelector('.ui2-runtime-thinking-body').textContent === '权威思考');
  ok('message_end 的 usage 是终值（不再标「仍在累计」）', usageLine().textContent.includes('输入 100') && usageLine().textContent.includes('合计 120') && !usageLine().textContent.includes('仍在累计'));
  ok('usage 缺的字段不出现（没有缓存/推理这一轮）', !usageLine().textContent.includes('缓存') && !usageLine().textContent.includes('推理'));

  /* ================= 6. 有界输出与截断 ================= */

  const boundedHost = document.createElement('div'); host.append(boundedHost);
  const boundedView = createRuntimeConversation({ host: boundedHost, display: createRuntimeDisplay({ maxThinkingBytes: 64 }) });
  runtimeStore.seed({ backendInstance: 'backend', items: [item('C')] });
  boundedView.show('C'); await tick();
  frame('C', 1, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '中🙂'.repeat(80) } });
  await tick();
  const boundedText = boundedHost.querySelector('.ui2-runtime-thinking-body').textContent;
  ok('thinking 展示有界：字节数不超上限', Buffer.byteLength(boundedText, 'utf8') <= 64);
  ok('thinking 截断后不出现半个字符（无替换符）', !boundedText.includes('�'));
  ok('thinking 截断在标题里说明，不静默少显示', boundedHost.querySelector('.ui2-runtime-thinking-head').textContent.includes('已截断'));
  /* 正文由 store 自己按 1MiB 截断；视图只负责把它说出来。这里推过上限，确认
   * 状态行确实说了「仅显示最近输出」——之前这条标志在中央视图里根本没被显示过。 */
  for (let i = 2; i < 320; i++) delta('C', i, 'x'.repeat(4096));
  await tick();
  ok('正文超过 1MiB 上限后 store 标记截断', runtimeStore.get('C').truncated === true);
  ok('正文截断时状态行说明「仅显示最近输出」', boundedHost.querySelector('.rtc-state').textContent.includes('仅显示最近输出'));
  ok('正文展示同样有界（不绕过 store 的 1MiB 上限）', Buffer.byteLength(runtimeStore.get('C').text, 'utf8') <= 1024 * 1024);
  boundedView.dispose(); boundedHost.remove();

  /* ================= 7. 停止 / 关闭 / 恢复 ================= */

  requests.length = 0;
  view.show('A'); await tick();
  btn('停止').click(); await tick();
  ok('停止带 A 的完整 owner', requests.some(r => r.command?.type === 'abort' && r.owner.conversationId === 'A' && r.owner.runtimeGeneration === 'one'));

  const closedItem = { ...item('A'), owner: null, lifecycle: 'dormant', activity: 'idle' };
  observeRuntimeFrame({ type: 'runtime_closed', backendInstance: 'backend', owner: owner('A'), conversationId: 'A', item: closedItem });
  await tick();
  ok('关闭后回到已关闭并给出恢复入口', stateLine().includes('已关闭') && !btn('恢复会话').disabled && btn('发送').disabled);
  ok('关闭后控件按休眠态禁用', btn('发送').disabled && btn('停止').disabled && btn('重启').disabled);
  /* 关闭后**保留**上一次观察到的展示内容：与 runtime-store 对 text/tools 的处理一致
   * （它关掉时只清 approvals，正文和工具留着）。这里断言两边行为一致，不各说各话。 */
  ok('关闭后正文与工具与 store 保持一致（store 保留，视图也保留）',
    output().textContent === (runtimeStore.get('A').text || '等待任务') && toolRows().length === runtimeStore.get('A').tools.length);
  ok('关闭后 thinking 与 usage 同样保留（与 store 的保留语义一致）',
    thinkingBlock().hidden === false && usageLine().hidden === false);
  ok('关闭后审批被清掉（store 关掉时清 approvals）', host.querySelectorAll('.rtc-approval').length === 0);

  observeRuntimeFrame({ type: 'runtime_state', owner: owner('A', 'two'), item: { ...item('A'), owner: owner('A', 'two'), revision: 99, activity: 'idle' } });
  await tick();
  ok('换代后不再显示上一个 runtime 的 thinking 与 usage（那是另一条运行）', thinkingBlock().hidden === true && usageLine().hidden === true);
  delta('A', 1, '-新代次正文', 'two'); thinkDelta('A', 2, '-新代次思考', 'two');
  await tick();
  ok('恢复后显示新 runtime 自己的正文与思考', output().textContent.includes('-新代次正文') && thinkingBlock().querySelector('.ui2-runtime-thinking-body').textContent === '-新代次思考');
  ok('恢复后不残留上一个 runtime 的 usage', usageLine().hidden === true);
  delta('A', 3, '-旧代次迟到', 'one'); thinkDelta('A', 4, '-旧代次思考', 'one');
  await tick();
  ok('旧代次的迟到正文与思考都不进新 runtime 的视图',
    !output().textContent.includes('-旧代次') && !thinkingBlock().querySelector('.ui2-runtime-thinking-body').textContent.includes('-旧代次'));

  /* ================= 8. 历史：缺字段就省略，不造假的展开 ================= */

  runtimeStore.seed({ backendInstance: 'backend', items: [item('A', { owner: null, lifecycle: 'dormant', activity: 'idle' })] });
  historyResult = { ok: true, messages: [{ role: 'user', text: '历史问题' }, { role: 'assistant', text: '历史回答' }], truncated: false };
  view.show('A'); await tick();
  btn('打开历史').click(); await tick(12);
  ok('历史显示正文', output().textContent.includes('历史问题') && output().textContent.includes('历史回答'));
  ok('历史里没有 thinking（接口不提供，就不显示）', thinkingBlock().hidden === true);
  ok('历史里没有 usage（接口不提供，就不显示）', usageLine().hidden === true);
  ok('历史里没有工具块（接口不提供，就不显示）', toolRows().length === 0);
  ok('历史状态行说明「只含正文」，用户知道为什么没有', stateLine().includes('只含正文'));
  ok('历史视图禁止发送', btn('发送').disabled && host.querySelector('textarea').disabled);

  /* 历史缺字段（没有 role / 没有 text）时不伪造、不崩。 */
  historyResult = { ok: true, messages: [{ role: 'user' }, { role: 'assistant', text: '' }, {}], truncated: false };
  view.show('B'); await tick(); view.show('A'); await tick();
  ok('历史消息缺字段时按空正文处理，不崩、不造内容',
    typeof output().textContent === 'string' && !output().textContent.includes('undefined'));

  /* ================= 9. 审批隔离 ================= */

  runtimeStore.seed({ backendInstance: 'backend', items: [item('A'), item('B')] });
  const approval = (id, seq, gen = 'one') => frame(id, seq, { type: 'extension_ui_request', id: 'shared-approval', method: 'confirm', title: 'Approve ' + id }, gen);
  view.show('A'); await tick(); approval('A', 10); await tick();
  const capturedA = btn('确认');
  ok('A 的审批出现在 A 的视图里', Boolean(capturedA) && host.textContent.includes('Approve A'));
  view.show('B'); await tick(); approval('B', 10); await tick();
  ok('切到 B 显示 B 自己的审批', host.textContent.includes('Approve B'));
  requests.length = 0;
  capturedA.click(); await tick();
  const answered = requests.filter(r => r.command?.type === 'extension_ui_response');
  ok('捕获 A 的审批后切 B，应答仍只发给 A 的完整 owner',
    answered.length === 1 && answered[0].owner.conversationId === 'A' && answered[0].command.id === 'shared-approval');
  ok('A 的审批应答不清掉 B 自己的审批', host.textContent.includes('Approve B'));
  ok('审批文本走 textContent（不可信标题不成为节点）', host.querySelectorAll('.rtc-approval img, .rtc-approval script').length === 0);

  /* ================= 10. XSS / 不可信输出 ================= */

  runtimeStore.seed({ backendInstance: 'backend', items: [item('X')] });
  view.show('X'); await tick();
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  delta('X', 1, evil); thinkDelta('X', 2, evil);
  frame('X', 3, { type: 'tool_execution_start', toolCallId: 't-x', toolName: evil });
  frame('X', 4, { type: 'extension_ui_request', id: 'a-x', method: 'confirm', title: evil });
  frame('X', 5, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: evil }, { type: 'text', text: evil }] } });
  await tick();
  ok('不可信文本不产生任何注入节点', host.querySelectorAll('img, script, iframe, object, embed, svg').length === 0);
  ok('不可信文本作为**文本**原样显示（不是被静默吞掉）', output().textContent.includes('onerror=alert(1)')
    && thinkingBlock().querySelector('.ui2-runtime-thinking-body').textContent.includes('onerror=alert(1)'));
  ok('工具名与审批标题同样只作为文本', host.textContent.includes('<script>alert(2)</script>'));

  /* ================= 11. 模型能力未知 ================= */

  const catalogue = [{ providerId: 'fixture', modelId: 'plain', name: 'Plain' }];
  const { thinkingAvailability } = await import('../public/thinking-availability.js');
  // Match Runtime Models' current projection: a successful native empty list
  // still has unknown static capability, plus an explicit availability result.
  const unknownValues = new Map([['X', { model: catalogue[0], models: catalogue, reasoning: null, thinkingLevel: null, levels: [], readStatus: 'success', pending: false, notice: '' }]]);
  const unknownModels = { get: id => { const data = unknownValues.get(id); return { ...data, availability: thinkingAvailability(data) }; }, refresh: async () => true, setModel: async () => true, setThinking: async () => true };
  const unknownHost = document.createElement('div'); host.append(unknownHost);
  const unknownView = createRuntimeConversation({ host: unknownHost, models: unknownModels });
  runtimeStore.seed({ backendInstance: 'backend', items: [item('X')] });
  unknownView.show('X'); await tick();
  ok('推理能力未知时，Thinking 控件禁用且明说「未知」（不猜成 false）',
    unknownHost.querySelector('[aria-label="当前会话推理强度"]').disabled === true
    && unknownHost.querySelector('.rtc-model-notice').textContent.includes('未知'));
  ok('能力未知不影响正文/思考展示（那是两件事）', unknownHost.querySelector('.rtc-output').textContent.includes('onerror=alert(1)'));
  unknownView.dispose(); unknownHost.remove();

  /* ================= 12. 组件销毁后的订阅清理 ================= */

  const disposeHost = document.createElement('div'); host.append(disposeHost);
  const disposable = createRuntimeConversation({ host: disposeHost });
  runtimeStore.seed({ backendInstance: 'backend', items: [item('D')] });
  disposable.show('D'); await tick();
  delta('D', 1, '销毁前'); thinkDelta('D', 2, '销毁前思考');
  await tick();
  ok('销毁前正常渲染', disposeHost.querySelector('.rtc-output').textContent === '销毁前'
    && disposeHost.querySelector('.ui2-runtime-thinking-body').textContent === '销毁前思考');
  disposable.dispose();
  ok('销毁后 DOM 已摘除', disposeHost.querySelector('.runtime-conversation') === null);
  delta('D', 3, '销毁后'); thinkDelta('D', 4, '销毁后思考');
  await tick();
  ok('销毁后再来帧不抛异常、不重建 DOM', disposeHost.querySelector('.runtime-conversation') === null && disposeHost.textContent === '');

  /* 外部传入的 display 不被视图销毁（所有权在外部）。 */
  const sharedDisplay = createRuntimeDisplay();
  const ownerHost = document.createElement('div'); host.append(ownerHost);
  const ownerView = createRuntimeConversation({ host: ownerHost, display: sharedDisplay });
  runtimeStore.seed({ backendInstance: 'backend', items: [item('E')] });
  ownerView.show('E'); await tick();
  thinkDelta('E', 1, '共享投影');
  await tick();
  ok('外部传入的投影可用', ownerHost.querySelector('.ui2-runtime-thinking-body').textContent === '共享投影');
  ownerView.dispose();
  ok('视图销毁后外部投影仍持有数据（所有权在外部）', sharedDisplay.thinkingOf('E')?.text === '共享投影');
  sharedDisplay.dispose();
  ok('外部投影 dispose 后不再返回数据', sharedDisplay.thinkingOf('E') === null);

  /* ================= 13. 权威快照（不带帧）也要能作废旧 runtime 的展示 ================= */

  const { seedRuntimeSnapshot } = await import('../public/runtime-state.js');
  runtimeStore.seed({ backendInstance: 'backend', items: [item('G')] });
  view.show('G'); await tick();
  delta('G', 1, 'G-正文'); thinkDelta('G', 2, 'G-思考');
  frame('G', 3, { type: 'message_update', usage: { output: 7 }, assistantMessageEvent: { type: 'text_delta', delta: '' } });
  await tick();
  ok('快照之前：G 有自己的 thinking 与 usage', thinkingBlock().hidden === false && usageLine().hidden === false);
  /* seedRuntimeSnapshot **不带帧**（runtime-state.js:25 的 broadcast() 无参）。这条路径
   * 在真机上就是「刷新会话列表」——owner 可能已经换代，投影必须自己核对。 */
  seedRuntimeSnapshot({ backendInstance: 'backend', items: [{ ...item('G'), owner: owner('G', 'snapshot-two'), revision: 500 }] });
  await tick();
  ok('快照换代（不带帧）后不残留上一个 runtime 的 thinking 与 usage', thinkingBlock().hidden === true && usageLine().hidden === true);
  thinkDelta('G', 1, 'G-新代次思考', 'snapshot-two');
  await tick();
  ok('快照换代后新 runtime 的 thinking 正常进入', thinkingBlock().querySelector('.ui2-runtime-thinking-body').textContent === 'G-新代次思考');

  /* ================= 14. 滚动：切会话隔离 + 流式不抢视口 ================= */

  /* jsdom 不做布局，scrollTop 可写但 scrollHeight/clientHeight 恒为 0（差值 0 →
   * 判定为贴底）。这里用可写的 scrollTop 验证「切会话恢复」，用对象替身验证
   * 「上滚后不跟随」的判据本身，避免 jsdom 的 0 高度把这条断言变成假绿。 */
  const scrollHost = document.createElement('div'); host.append(scrollHost);
  const scrollView = createRuntimeConversation({ host: scrollHost });
  runtimeStore.seed({ backendInstance: 'backend', items: [item('S1'), item('S2')] });
  delta('S1', 1, 'S1'); delta('S2', 1, 'S2');
  scrollView.show('S1'); await tick();
  const scrollOutput = () => scrollHost.querySelector('.rtc-output');
  scrollOutput().scrollTop = 42;
  scrollView.show('S2'); await tick();
  scrollOutput().scrollTop = 7;
  scrollView.show('S1'); await tick();
  ok('切回 S1 恢复 S1 自己的滚动位置（不串到 S2）', scrollOutput().scrollTop === 42);
  scrollView.show('S2'); await tick();
  ok('切回 S2 恢复 S2 自己的滚动位置', scrollOutput().scrollTop === 7);

  /* 判据本身：用一个能算出差值的替身，把「贴底 / 上滚」两种情形各测一次。 */
  const { shouldFollow } = await import('../public/runtime-display.js');
  ok('近底 160 以内算贴底（跟随新内容）', shouldFollow({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 }) === true
    && shouldFollow({ scrollHeight: 1000, scrollTop: 750, clientHeight: 100 }) === true);
  ok('上滚超过 160 就不再跟随（视口归用户）', shouldFollow({ scrollHeight: 1000, scrollTop: 700, clientHeight: 100 }) === false
    && shouldFollow({ scrollHeight: 1000, scrollTop: 0, clientHeight: 100 }) === false);
  ok('恰好 160 边界不跟随（与 Classic 的 < 160 严格同一规则）', shouldFollow({ scrollHeight: 1000, scrollTop: 740, clientHeight: 100 }) === false);
  scrollView.dispose(); scrollHost.remove();

  /* ================= 15. 投影自己的记录也有界 ================= */

  const capped = createRuntimeDisplay({ maxConversations: 2 });
  const capStore = runtimeStore;
  capStore.seed({ backendInstance: 'backend', items: [item('F1'), item('F2'), item('F3')] });
  for (const id of ['F1', 'F2', 'F3']) {
    observeRuntimeFrame({ type: 'runtime_event', owner: owner(id), eventSequence: 1,
      event: { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: id + '-思考' } } });
  }
  ok('投影只保留最近 N 条会话记录（有界内存）',
    capped.thinkingOf('F3')?.text === 'F3-思考' && (capped.thinkingOf('F1') === null || capped.thinkingOf('F2') === null));
  capped.dispose();

  const completed = createRuntimeDisplay();
  runtimeStore.seed({ backendInstance: 'backend', items: [item('U')] });
  frame('U', 1, { type: 'message_start', message: { role: 'assistant' } });
  frame('U', 2, { type: 'message_update', usage: { output: 9 } });
  ok('集成：流式用量明确为临时观察值', completed.usageOf('U')?.source === 'message_update');
  frame('U', 3, { type: 'message_end', message: { role: 'assistant', content: [] } });
  ok('集成：终值usage缺失时省略，不继续声称仍在累计', completed.usageOf('U') === null);
  completed.dispose();

  const isolatedStore = createRuntimeStore();
  let accepted;
  const isolatedDisplay = createRuntimeDisplay({ store: isolatedStore, subscribe: fn => { accepted = fn; return () => {}; } });
  isolatedStore.seed({ backendInstance: 'backend', items: [item('I')] });
  const isolatedFrame = { type: 'runtime_event', owner: owner('I'), eventSequence: 1, event: { type: 'message_update', usage: { output: 3 }, assistantMessageEvent: { type: 'thinking_delta', delta: 'old backend thinking' } } };
  if (isolatedStore.apply(isolatedFrame)) accepted(isolatedFrame);
  ok('集成：展示投影只读已接受的fixture记录', isolatedDisplay.thinkingOf('I')?.text === 'old backend thinking');
  const closedFrame = { type: 'runtime_closed', backendInstance: 'backend', conversationId: 'I', owner: owner('I'), item: item('I', { owner: null, lifecycle: 'closed' }) };
  if (isolatedStore.apply(closedFrame)) accepted(closedFrame);
  ok('集成：原位关闭仍保留本次已观察展示', isolatedDisplay.thinkingOf('I')?.text === 'old backend thinking');
  isolatedStore.seed({ backendInstance: 'replacement', items: [item('I', { owner: null, lifecycle: 'closed' })] }); accepted();
  ok('集成：后端换代同id dormant不继承旧thinking或usage', isolatedDisplay.thinkingOf('I') === null && isolatedDisplay.usageOf('I') === null);
  isolatedStore.seed({ backendInstance: 'backend', items: [item('I')] });
  if (isolatedStore.apply(isolatedFrame)) accepted(isolatedFrame);
  isolatedStore.seed({ backendInstance: 'empty-backend', items: [] });
  ok('集成：当前store记录已移除时读取不能返回残留展示', isolatedDisplay.thinkingOf('I') === null && isolatedDisplay.usageOf('I') === null);
  isolatedDisplay.dispose();

  view.dispose(); dom.window.close();
  console.log(`Runtime display projection: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
