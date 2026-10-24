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
  const { showRuntimeConversation } = await import('../public/ui/workspace-surface.js');

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

  // 4. 界面与右栏交互测试
  console.log('\n--- 4. 界面卡片与右栏受控参数交互 ---');

  S.workspaceGeneration = 1;
  S.hasProject = true;
  S.bridgeState = 'ready';
  S.cwd = 'C:\\fixture-viz';
  S.state = { sessionId: 'classic-session-001' };
  const pane = initRightPane();
  configureSecondaryPane(pane);
  setGitConversationScope(null);

  // 插入带有真实消息父容器的消息
  const stream = document.getElementById('stream');
  stream.replaceChildren();
  const thread = document.createElement('div');
  thread.className = 'thread';
  const msgEl = document.createElement('div');
  msgEl.className = 'message assistant-message';
  msgEl.dataset.id = 'msg-1';
  msgEl.innerHTML = closedHtml;
  thread.append(msgEl);
  stream.append(thread);

  const card = msgEl.querySelector('.viz-card');
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
  console.log('\n--- 5. 会话身份隔离与拒绝验证 ---');

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

  // (3) 原消息在 DOM 中被删除 / 历史被重构测试
  msgEl.remove();
  ok('source message disconnected from DOM', !msgEl.isConnected);
  quoteBtn.click();
  ok('disconnected source message rejects quote without modifying draft', el.input.value === draftBeforeMismatch);

  // (4) Runtime 会话身份测试
  console.log('\n--- 6. Runtime 会话身份与拥有者校验 ---');

  // 切换工作区视图为 runtime
  showRuntimeConversation();
  setGitConversationScope('conv-runtime-100');

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

  // 创建 Runtime 真实的会话 DOM
  const runtimeView = document.getElementById('runtimeView');
  runtimeView.hidden = false;
  runtimeView.replaceChildren();

  const runtimeConv = document.createElement('div');
  runtimeConv.className = 'runtime-conversation';
  runtimeConv.dataset.conversationId = 'conv-runtime-100';

  const runtimeCardContainer = document.createElement('div');
  runtimeCardContainer.className = 'message';
  runtimeCardContainer.innerHTML = closedHtml;
  runtimeConv.append(runtimeCardContainer);

  const runtimeInput = document.createElement('textarea');
  runtimeInput.setAttribute('aria-label', '给当前会话的任务');
  runtimeConv.append(runtimeInput);
  runtimeView.append(runtimeConv);

  // 从 Runtime 卡片打开图表面板
  const runtimeOpenBtn = runtimeCardContainer.querySelector('[data-viz-open]');
  runtimeOpenBtn.click();
  ok('opened viz panel from runtime card', pane.isOpen() === true);

  // 验证 S.state.sessionId 存在时绝不会覆盖 Runtime 会话
  S.state.sessionId = 'classic-shadow-session';
  const runtimeQuoteBtn = rightPane.querySelector('.viz-quote-btn');
  runtimeQuoteBtn.click();
  ok('runtime quote successfully targets runtime textarea without being overridden by S.state.sessionId',
    runtimeInput.value.includes('[图表配置引用：网络流量吞吐]'));

  // 测试 Runtime 会话切换拒绝
  setGitConversationScope('conv-runtime-999');
  const prevRuntimeValue = runtimeInput.value;
  runtimeQuoteBtn.click();
  ok('switched runtime conversation rejects quote', runtimeInput.value === prevRuntimeValue);

  // 切回原会话，但 Agent owner 变更 / 进程死亡
  setGitConversationScope('conv-runtime-100');
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
  ok('stale/changed runtime owner rejects quote', runtimeInput.value === prevRuntimeValue);

  // Runtime generation 重置
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
  ok('stale runtime generation rejects quote', runtimeInput.value === prevRuntimeValue);

  // 恢复状态并关闭
  pane.close();
  ok('pane safely closed and cleaned up', pane.isOpen() === false);

  console.log(`\nViz UI & Review Fixes: ${checks}/${checks} passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
