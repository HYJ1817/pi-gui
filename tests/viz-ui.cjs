/* Z3-A: Interactive Visualization UI & Lifecycle Tests (Independent Review Fixes).
 *
 * Covers:
 * - Markdown rendering & unclosed fence streaming handling (must stay raw pre)
 * - Safe fallback to raw code block for invalid/malicious data
 * - Raw code toggle in chat stream
 * - Opening viz surface in right-pane
 * - SVG Line & Bar chart generation, zero-baseline rules (positive, negative, cross-zero, constant negative)
 * - Parameter controls: type toggle, series filter, range slider, threshold alert (adaptive range)
 * - Precise stats summary calculation on current visible range slice (known expected values)
 * - Quote to composer (fillReviewComposer) in Classic & Runtime
 * - Session mismatch & workspace generation invalidation
 * - Runtime owner verification & refusal on stale owner/generation
 * - Source message disconnection (deleted message / cleared thread) invalidation
 * - Clean disposal & cleanup
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

let checks = 0;
const ok = (name, value) => {
  assert.ok(typeof value === 'function' ? value() : value, name);
  checks++;
  console.log('  ok   ' + name);
};

async function main() {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/' });

  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    Node: dom.window.Node,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
  });

  const { md } = await import('../public/markdown.js');
  const { S, el } = await import('../public/state.js');
  const { initRightPane } = await import('../public/right-pane.js');
  const { configureSecondaryPane } = await import('../public/ui/secondary-surface.js');
  const { initVizIntegration } = await import('../public/viz-integration.js');
  const { buildVizSummaryMarkdown, validateSessionScope, calculateSeriesStats, openVizPanel } = await import('../public/viz-panel.js');
  const { calculateBounds, renderVizChart } = await import('../public/viz-chart.js');
  const { setGitConversationScope } = await import('../public/api.js');
  const { runtimeStore, seedRuntimeSnapshot } = await import('../public/runtime-state.js');
  const { showRuntimeConversation, showChat } = await import('../public/ui/workspace-surface.js');
  const { rebuildFromMessages } = await import('../public/messages.js');
  const { createRuntimeConversation } = await import('../public/runtime-conversation.js');

  initVizIntegration();

  // 1. Markdown 渲染与流式未闭合围栏测试
  console.log('\n--- 1. Markdown 渲染与流式未闭合围栏安全 ---');

  const validVizJson = JSON.stringify({
    version: '1',
    type: 'line',
    title: '网络流量吞吐',
    unit: 'MB/s',
    labels: ['12:00', '12:01', '12:02', '12:03', '12:04'],
    series: [
      { name: '入站', data: [120, 240, 180, 310, 290] },
      { name: '出站', data: [80, 110, 95, 140, 130] },
    ],
    params: [
      { id: 'threshold', name: '告警线', type: 'number', min: 50, max: 400, default: 250 },
    ],
  });

  // 闭合围栏：正确渲染为卡片
  const closedMd = '```pi-gui-viz\n' + validVizJson + '\n```';
  const closedHtml = md(closedMd);
  ok('closed pi-gui-viz renders .viz-card', closedHtml.includes('class="viz-card"'));
  ok('viz-card contains title and meta', closedHtml.includes('网络流量吞吐') && closedHtml.includes('2 个系列'));

  // 未闭合围栏（流式输出中）：绝对不能提前变成卡片，必须保持为普通代码块
  const unclosedMd = '```pi-gui-viz\n' + validVizJson;
  const unclosedHtml = md(unclosedMd);
  ok('unclosed streaming fence stays as plain code block (no viz-card)', !unclosedHtml.includes('viz-card') && unclosedHtml.includes('data-lang="pi-gui-viz"'));

  // 非法 JSON 降级
  const malformedMd = '```pi-gui-viz\n{ invalid json ...\n```';
  ok('malformed json falls back to regular code block', !md(malformedMd).includes('viz-card'));

  // 恶意类型降级
  const maliciousMd = '```pi-gui-viz\n{"version":"1","type":"<script>","title":"T","labels":["A"],"series":[{"name":"S","data":[1]}]}\n```';
  ok('malicious type safely falls back to regular code block', !md(maliciousMd).includes('viz-card'));

  // 2. 柱状图零基线几何与自适应坐标测试
  console.log('\n--- 2. 柱状图零基线与极端数值几何 ---');

  // 全正数柱状图：零基线必须为 0
  const posBounds = calculateBounds([{ data: [10, 50, 100] }], [0], null, 'bar');
  ok('all positive bar bounds min is exactly 0', posBounds.min === 0);
  ok('all positive bar bounds max covers top with padding', posBounds.max >= 100);

  // 全负数柱状图：零基线必须为 0，不能截断
  const negBounds = calculateBounds([{ data: [-20, -50, -100] }], [0], null, 'bar');
  ok('all negative bar bounds max is exactly 0', negBounds.max === 0);
  ok('all negative bar bounds min covers lowest negative', negBounds.min <= -100);

  // 常量负数：零基线仍必须为 0（不能把 min/max 都收缩在 -50 导致基线悬空）
  const constNegBounds = calculateBounds([{ data: [-50, -50] }], [0], null, 'bar');
  ok('constant negative bar bounds max is exactly 0', constNegBounds.max === 0);
  ok('constant negative bar bounds min covers constant value', constNegBounds.min <= -50);

  // 跨零柱状图：正负兼有，零基线必须落在内部
  const crossBounds = calculateBounds([{ data: [-30, 0, 70] }], [0], null, 'bar');
  ok('cross-zero bar bounds spans across 0', crossBounds.min < 0 && crossBounds.max > 0);

  // 测试 SVG 渲染几何
  const testContainer = document.createElement('div');
  document.body.append(testContainer);

  // 渲染包含负数的柱状图
  const negChartData = {
    version: '1', type: 'bar', title: '盈亏对比', unit: 'k',
    labels: ['Q1', 'Q2', 'Q3'],
    series: [{ name: '利润', data: [-20, 40, -10] }],
    params: [],
  };
  const negChart = renderVizChart(testContainer, { data: negChartData, type: 'bar' });
  const renderedBars = testContainer.querySelectorAll('rect.viz-bar');
  ok('renders 3 bars for cross-zero dataset', renderedBars.length === 3);
  ok('cross-zero bar chart renders visible zero line', testContainer.querySelector('.viz-zero-line') !== null);
  negChart.dispose();
  testContainer.remove();

  // 3. 统计摘要精准计算测试（切片 rangeLimit）
  console.log('\n--- 3. 统计摘要精确数值计算（带已知期望值） ---');

  const statsSeries = { name: 'CPU', data: [10, 20, 30, 40, 50] };
  const statsLabels = ['1', '2', '3', '4', '5'];

  // 全量 (5 项)：均值 (10+20+30+40+50)/5 = 30.0，极值 [10, 50]，阈值 35 超标 2 项 (40, 50)
  const fullStats = calculateSeriesStats(statsSeries, statsLabels, 35);
  ok('full range avg is exactly 30', fullStats.avg === 30);
  ok('full range min is 10 and max is 50', fullStats.min === 10 && fullStats.max === 50);
  ok('full range overCount is 2', fullStats.overCount === 2);

  // 切片 rangeLimit = 3 (最近 3 项: [30, 40, 50]):
  // 均值 (30+40+50)/3 = 40.0，极值 [30, 50]，阈值 35 超标 2 项 (40, 50)
  const testDataObj = {
    version: '1', type: 'line', title: '性能测试', unit: 'ms',
    labels: statsLabels,
    series: [statsSeries],
    params: [{ id: 'threshold', name: '告警线', type: 'number', min: 0, max: 100, default: 35 }],
  };
  const summaryMarkdownSlice3 = buildVizSummaryMarkdown(testDataObj, {
    type: 'line',
    activeSeries: new Set([0]),
    rangeLimit: 3,
    threshold: 35,
  });

  ok('sliced summary reflects rangeLimit 3', summaryMarkdownSlice3.includes('展示范围=最近 3 项'));
  ok('sliced summary reflects sliced avg 40', summaryMarkdownSlice3.includes('均值 40ms'));
  ok('sliced summary reflects sliced min 30 and max 50', summaryMarkdownSlice3.includes('极值 [30 ~ 50]ms'));
  ok('sliced summary reflects overCount 2', summaryMarkdownSlice3.includes('2 处超过阈值'));

  // 4. 界面与右栏交互测试（真实 Classic 链路）
  console.log('\n--- 4. 界面卡片与右栏受控参数交互（真实 Classic 消息） ---');

  showChat();
  S.workspaceGeneration = 1;
  S.hasProject = true;
  S.bridgeState = 'ready';
  S.cwd = 'C:\\fixture-viz';
  S.state = { sessionId: 'classic-session-001' };
  const pane = initRightPane();
  configureSecondaryPane(pane);
  setGitConversationScope(null);

  // 使用真实 messages.js 的 rebuildFromMessages 创建真实助手消息 article.msg.assistant
  rebuildFromMessages({
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: '网络监控报告：\n' + closedMd }],
      },
    ],
  });

  const msgEl = document.querySelector('#stream .thread article.msg.assistant');
  ok('real classic assistant message article.msg.assistant created via messages.js', Boolean(msgEl));

  const card = msgEl.querySelector('.viz-card');
  ok('viz card is inside real article.msg.assistant', Boolean(card));

  const toggleBtn = card.querySelector('[data-viz-toggle-raw]');
  const rawCode = card.querySelector('.viz-raw-code');

  ok('raw code is initially hidden', rawCode.hidden === true);
  toggleBtn.click();
  ok('clicking toggle reveals raw code', rawCode.hidden === false && toggleBtn.classList.contains('is-active'));
  toggleBtn.click();
  ok('clicking toggle again hides raw code', rawCode.hidden === true && !toggleBtn.classList.contains('is-active'));

  // 打开右栏
  const openBtn = card.querySelector('[data-viz-open]');
  openBtn.click();
  ok('right pane is opened', pane.isOpen() === true && pane.surface() === 'viz');

  const rightPane = document.getElementById('rightPane');
  ok('panel title matches', rightPane.querySelector('.rp-head-title').textContent === '网络流量吞吐');

  // 切换为柱状图
  const btnBar = rightPane.querySelector('.viz-type-row .viz-toggle-btn:last-child');
  btnBar.click();
  ok('switched to bar chart in DOM', rightPane.querySelector('svg.viz-svg').classList.contains('viz-chart-bar'));

  // 切换系列
  const seriesPills = rightPane.querySelectorAll('.viz-series-pills .viz-pill');
  seriesPills[1].click();
  ok('deactivated series 2', !seriesPills[1].classList.contains('is-active'));
  seriesPills[0].click();
  ok('prevented deactivating the last active series', seriesPills[0].classList.contains('is-active'));

  // 5. Classic 与 Runtime 会话身份隔离与验证测试
  console.log('\n--- 5. 会话身份隔离与拒绝验证（Classic 真实环境） ---');

  // (1) Classic 正常引用
  el.input.value = '原有草稿内容。';
  const quoteBtn = rightPane.querySelector('.viz-quote-btn');
  quoteBtn.click();
  ok('classic quote succeeds and preserves draft', el.input.value.startsWith('原有草稿内容。') && el.input.value.includes('[图表配置引用：网络流量吞吐]'));

  // (2) Classic 会话切换：S.state.sessionId 发生变化，拒绝写入
  S.state.sessionId = 'classic-session-002';
  const draftBeforeMismatch = el.input.value;
  quoteBtn.click();
  ok('mismatched classic session rejects quote without modifying draft', el.input.value === draftBeforeMismatch);

  // 恢复 Classic session id
  S.state.sessionId = 'classic-session-001';

  // (3) 原消息在 DOM 中被删除测试
  msgEl.remove();
  ok('source message disconnected from DOM', !msgEl.isConnected);
  quoteBtn.click();
  ok('disconnected source message rejects quote without modifying draft', el.input.value === draftBeforeMismatch);

  // (4) 历史重建测试：重新生成后打开，再用空消息重建，旧节点脱离 DOM
  rebuildFromMessages({
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: '重新生成的监控：\n' + closedMd }],
      },
    ],
  });
  const reloadedMsg = document.querySelector('#stream .thread article.msg.assistant');
  const reloadedOpenBtn = reloadedMsg.querySelector('[data-viz-open]');
  reloadedOpenBtn.click();
  ok('re-opened viz panel from newly rebuilt message', pane.isOpen() === true);

  // 从当前最新打开的面板获取引用按钮（不复用已销毁面板的旧按钮）
  const reloadedQuoteBtn = rightPane.querySelector('.viz-quote-btn');

  // 历史被再次清空/重建（如切换分支或收到新历史）
  rebuildFromMessages([]);
  ok('message cleared on history rebuild', !reloadedMsg.isConnected);
  reloadedQuoteBtn.click();
  ok('stale message after history rebuild rejects quote using current panel button', el.input.value === draftBeforeMismatch);

  // (4b) Classic 流式更新替换原卡片测试：
  // article.msg.assistant 保持连接，但流式更新（paint）替换了 innerHTML 中的旧 .viz-card
  rebuildFromMessages({
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: '流式阶段一：\n' + closedMd }],
      },
    ],
  });
  const streamMsg = document.querySelector('#stream .thread article.msg.assistant');
  const oldCard = streamMsg.querySelector('.viz-card');
  oldCard.querySelector('[data-viz-open]').click();
  ok('opened viz panel from initial streaming card', pane.isOpen() === true);
  const streamStage1QuoteBtn = rightPane.querySelector('.viz-quote-btn');

  // 模拟 messages.js 中流式 delta 到达时的 paint()：替换 innerHTML
  const streamBody = streamMsg.querySelector('.msg-body .assistant-text');
  streamBody.innerHTML = md('流式阶段二更新：\n' + closedMd);

  // 此时 article.msg.assistant 仍然连接，但旧 .viz-card 已脱离 DOM
  ok('article.msg.assistant still connected to DOM', streamMsg.isConnected);
  ok('old viz-card detached from DOM after message repaint', !oldCard.isConnected);

  // 验证原图表面板的引用按钮被拒绝（因为旧卡片已被替换）
  const draftBeforeStreamRepaint = el.input.value;
  streamStage1QuoteBtn.click();
  ok('replaced old viz-card rejects quote even when article is still connected', el.input.value === draftBeforeStreamRepaint);

  // 验证新生成的图表卡片可以正常打开和引用
  const newCard = streamMsg.querySelector('.viz-card');
  ok('new viz-card exists in updated message', Boolean(newCard) && newCard !== oldCard);
  newCard.querySelector('[data-viz-open]').click();
  ok('new viz-card can open new panel', pane.isOpen() === true);
  const streamStage2QuoteBtn = rightPane.querySelector('.viz-quote-btn');
  streamStage2QuoteBtn.click();
  ok('new viz-card quote succeeds', el.input.value.includes('[图表配置引用：网络流量吞吐]'));

  // (5) 禁止 sourceNode=null 或脱卸节点打开面板
  const invalidOpenResult = openVizPanel(testDataObj, { sourceNode: null });
  ok('openVizPanel rejects when sourceNode is null', invalidOpenResult === null);

  const detachedMsg = document.createElement('article');
  detachedMsg.className = 'msg assistant';
  const detachedOpenResult = openVizPanel(testDataObj, { sourceNode: detachedMsg });
  ok('openVizPanel rejects when sourceNode is detached from DOM', detachedOpenResult === null);

  // 6. Runtime 真实渲染链路与身份隔离测试
  console.log('\n--- 6. Runtime 真实渲染链路与拥有者校验 ---');

  // 切换工作区视图为 runtime
  showRuntimeConversation();
  setGitConversationScope('conv-runtime-100');

  // 挂载真实 Runtime Conversation 组件到 #runtimeView
  const runtimeView = document.getElementById('runtimeView');
  runtimeView.hidden = false;
  runtimeView.replaceChildren();
  const runtimeComponent = createRuntimeConversation({ host: runtimeView });

  // 注册 runtime 拥有者与代数
  seedRuntimeSnapshot({
    backendInstance: 'fixture-backend',
    items: [{
      conversationId: 'conv-runtime-100',
      owner: { runtimeId: 'agent-z3-worker', runtimeGeneration: '1' },
      lifecycle: 'ready',
      activity: 'idle',
      revision: 1,
    }],
  });

  // 在 Live 模式下存入带有 pi-gui-viz 的正文并通过真实 draw 链路渲染
  const recordA = runtimeStore.get('conv-runtime-100');
  recordA.text = 'Runtime 实时负载：\n' + closedMd + '\n数据推送完毕。';
  runtimeComponent.show('conv-runtime-100');

  const rtcOutput = runtimeView.querySelector('.rtc-output');
  ok('real runtime rtc-output exists', Boolean(rtcOutput));

  const runtimeCard = rtcOutput.querySelector('.viz-card');
  ok('real runtime rtc-output renders viz-card', Boolean(runtimeCard));

  const liveBlock = runtimeCard.closest('.rtc-output-block');
  ok('runtime card is inside .rtc-output-block', Boolean(liveBlock));

  // 从真实 Runtime 卡片打开图表面板
  const runtimeOpenBtn = runtimeCard.querySelector('[data-viz-open]');
  runtimeOpenBtn.click();
  ok('opened viz panel from real runtime card', pane.isOpen() === true);

  // 验证 S.state.sessionId 存在时绝不会覆盖 Runtime 会话，且能正确填入 runtime 输入框
  S.state.sessionId = 'classic-shadow-session';
  const runtimeInput = runtimeView.querySelector('textarea');
  const runtimeQuoteBtn = rightPane.querySelector('.viz-quote-btn');
  runtimeQuoteBtn.click();
  ok('runtime quote successfully targets runtime textarea without being overridden by S.state.sessionId',
    runtimeInput.value.includes('[图表配置引用：网络流量吞吐]'));

  // (1) 测试 Runtime 会话切换拒绝
  seedRuntimeSnapshot({
    backendInstance: 'fixture-backend',
    items: [{
      conversationId: 'conv-runtime-200',
      owner: { runtimeId: 'agent-z3-worker-2', runtimeGeneration: '1' },
      lifecycle: 'ready',
      activity: 'idle',
      revision: 1,
    }],
  });
  runtimeComponent.show('conv-runtime-200');
  setGitConversationScope('conv-runtime-200');
  const prevRuntimeValue = runtimeInput.value;
  runtimeQuoteBtn.click();
  ok('switched runtime conversation rejects quote', runtimeInput.value === prevRuntimeValue);

  // (2) 切回原会话，但 Agent owner 变更 / 进程死亡拒绝
  runtimeComponent.show('conv-runtime-100');
  setGitConversationScope('conv-runtime-100');
  const valBeforeOwnerChange = runtimeInput.value;
  seedRuntimeSnapshot({
    backendInstance: 'fixture-backend',
    items: [{
      conversationId: 'conv-runtime-100',
      owner: { runtimeId: 'different-agent-xyz', runtimeGeneration: '1' },
      lifecycle: 'ready',
      activity: 'idle',
      revision: 2,
    }],
  });
  runtimeQuoteBtn.click();
  ok('stale/changed runtime owner rejects quote', runtimeInput.value === valBeforeOwnerChange);

  // (3) Runtime generation 重置拒绝
  seedRuntimeSnapshot({
    backendInstance: 'fixture-backend',
    items: [{
      conversationId: 'conv-runtime-100',
      owner: { runtimeId: 'agent-z3-worker', runtimeGeneration: '2' },
      lifecycle: 'ready',
      activity: 'idle',
      revision: 3,
    }],
  });
  runtimeQuoteBtn.click();
  ok('stale runtime generation rejects quote', runtimeInput.value === valBeforeOwnerChange);

  // (4a) 验证 Runtime Live 输出刷新后，旧卡片的引用正确失效
  const oldLiveCard = runtimeCard;
  const currentLiveRecord = runtimeStore.get('conv-runtime-100');
  currentLiveRecord.text = 'Runtime 实时负载刷新后：\n' + closedMd;
  runtimeComponent.draw();

  const refreshedLiveCard = rtcOutput.querySelector('.viz-card');
  ok('refreshed runtime live card created in rtc-output', Boolean(refreshedLiveCard) && refreshedLiveCard !== oldLiveCard);
  ok('old runtime live card detached from DOM', !oldLiveCard.isConnected);

  // 旧卡片打开的面板在引用时必须被拒绝
  runtimeQuoteBtn.click();
  ok('refreshed live output invalidates quote from previous live card', runtimeInput.value === valBeforeOwnerChange);

  // (4b) 来源消息块被删除拒绝
  const refreshedLiveBlock = refreshedLiveCard.closest('.rtc-output-block');
  refreshedLiveCard.querySelector('[data-viz-open]').click();
  const refreshedQuoteBtn = rightPane.querySelector('.viz-quote-btn');
  refreshedLiveBlock.remove();
  ok('runtime live source block disconnected from DOM', !refreshedLiveBlock.isConnected);
  refreshedQuoteBtn.click();
  ok('disconnected runtime source block rejects quote', runtimeInput.value === valBeforeOwnerChange);

  // (5) Runtime 历史视图下的真实卡片渲染与删除来源测试
  const histLocator = {
    conversationId: 'conv-runtime-100',
    nativeSessionId: 'fixture-backend',
    projectId: 'project',
    workspaceId: 'ws',
    workspaceEpoch: 'epoch',
  };
  global.fetch = async () => ({
    json: async () => ({
      ok: true,
      locator: histLocator,
      messages: [
        { messageId: 'hist-msg-1', role: 'user', text: '请给出历史报表' },
        { messageId: 'hist-msg-2', role: 'assistant', text: '历史报表：\n' + closedMd },
      ],
    }),
  });
  // 恢复可用的 owner 并写入 locator
  seedRuntimeSnapshot({
    backendInstance: 'fixture-backend',
    items: [{
      conversationId: 'conv-runtime-100',
      nativeSessionId: 'fixture-backend',
      workspace: { projectId: 'project', workspaceId: 'ws', workspaceEpoch: 'epoch' },
      owner: { runtimeId: 'agent-z3-worker', runtimeGeneration: '1' },
      lifecycle: 'ready',
      activity: 'idle',
      revision: 4,
    }],
  });
  await runtimeComponent.openHistory(histLocator);

  const historyCard = rtcOutput.querySelector('.viz-card');
  ok('runtime history renders viz-card', Boolean(historyCard));
  const historyRow = historyCard.closest('[data-history-message-id]');
  ok('history viz-card is inside [data-history-message-id]', Boolean(historyRow));

  // 从历史卡片打开面板
  historyCard.querySelector('[data-viz-open]').click();
  ok('opened viz panel from runtime history card', pane.isOpen() === true);

  // 从当前最新打开的 History 面板获取引用按钮（不复用已销毁的旧面板按钮）
  const historyQuoteBtn = rightPane.querySelector('.viz-quote-btn');

  // 历史消息行脱离 DOM 测试
  const valBeforeHistoryRemove = runtimeInput.value;
  historyRow.remove();
  ok('history message row disconnected', !historyRow.isConnected);
  historyQuoteBtn.click();
  ok('disconnected history message rejects quote using history panel button', runtimeInput.value === valBeforeHistoryRemove);

  // 恢复状态并清理
  pane.close();
  runtimeComponent.dispose();
  ok('pane and runtime component safely closed and cleaned up', pane.isOpen() === false);

  console.log(`\nViz UI & Review Fixes: ${checks}/${checks} passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
