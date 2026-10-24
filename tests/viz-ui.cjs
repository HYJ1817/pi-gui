/* Z3-A: Interactive Visualization UI & Lifecycle Tests.
 *
 * Covers:
 * - Markdown rendering & safe fallback to raw code block
 * - Raw code toggle in chat stream
 * - Opening viz surface in right-pane
 * - SVG Line & Bar chart generation, elements, and axes
 * - Parameter controls: type toggle, series filter, range slider, threshold alert
 * - Quote to composer (fillReviewComposer) & bounds
 * - Session mismatch & workspace generation invalidation
 * - Disposal & cleanup
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
  const { buildVizSummaryMarkdown } = await import('../public/viz-panel.js');

  initVizIntegration();

  // 1. Markdown 渲染测试
  console.log('\n--- 1. Markdown 渲染与安全降级 ---');

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

  const validMd = '```pi-gui-viz\n' + validVizJson + '\n```';
  const validHtml = md(validMd);
  ok('valid pi-gui-viz renders .viz-card', validHtml.includes('class="viz-card"'));
  ok('viz-card contains title and meta', validHtml.includes('网络流量吞吐') && validHtml.includes('2 个系列'));
  ok('viz-card contains open and toggle buttons', validHtml.includes('data-viz-open') && validHtml.includes('data-viz-toggle-raw'));
  ok('raw code block is preserved but hidden', validHtml.includes('viz-raw-code') && validHtml.includes('hidden'));

  // 非法 JSON 降级
  const malformedMd = '```pi-gui-viz\n{ invalid json ...\n```';
  const malformedHtml = md(malformedMd);
  ok('malformed json falls back to regular code block', !malformedHtml.includes('viz-card') && malformedHtml.includes('data-lang="pi-gui-viz"'));

  // 恶意/未知类型降级
  const maliciousMd = '```pi-gui-viz\n{"version":"1","type":"<script>evil()</script>","title":"T","labels":["A"],"series":[{"name":"S","data":[1]}]}\n```';
  const maliciousHtml = md(maliciousMd);
  ok('malicious type safely falls back to regular code block', !maliciousHtml.includes('viz-card'));

  // 常规代码块回归
  const pyMd = '```python\nprint("hello")\n```';
  ok('python code block renders unchanged', md(pyMd).includes('data-lang="python"'));

  // 2. 界面与右栏交互测试
  console.log('\n--- 2. 交互卡片与右栏面板 ---');

  S.workspaceGeneration = 1;
  S.hasProject = true;
  S.bridgeState = 'ready';
  S.state = { sessionId: 'session-z3-test' };
  const pane = initRightPane();
  configureSecondaryPane(pane);

  // 模拟消息插入到 stream
  const thread = document.createElement('div');
  thread.className = 'thread';
  const msgEl = document.createElement('div');
  msgEl.className = 'message assistant-message';
  msgEl.dataset.id = 'msg-1';
  msgEl.innerHTML = validHtml;
  thread.append(msgEl);
  document.getElementById('stream').append(thread);

  // 测试切换查看 JSON 源码
  const card = msgEl.querySelector('.viz-card');
  const toggleBtn = card.querySelector('[data-viz-toggle-raw]');
  const rawCode = card.querySelector('.viz-raw-code');

  ok('raw code is initially hidden', rawCode.hidden === true);
  toggleBtn.click();
  ok('clicking toggle reveals raw code', rawCode.hidden === false && toggleBtn.classList.contains('is-active'));
  toggleBtn.click();
  ok('clicking toggle again hides raw code', rawCode.hidden === true && !toggleBtn.classList.contains('is-active'));

  // 测试点击「打开可视化」
  const openBtn = card.querySelector('[data-viz-open]');
  openBtn.click();

  ok('right pane is opened', pane.isOpen() === true);
  ok('right pane surface is viz', pane.surface() === 'viz');

  const rightPane = document.getElementById('rightPane');
  const headTitle = rightPane.querySelector('.rp-head-title');
  ok('panel header shows chart title', headTitle && headTitle.textContent === '网络流量吞吐');

  const svg = rightPane.querySelector('svg.viz-svg');
  ok('SVG chart is mounted', svg !== null);
  ok('SVG has graphics-document role', svg.getAttribute('role') === 'graphics-document');

  // 折线图包含 polyline 与 circle 数据点
  const polylines = svg.querySelectorAll('polyline.viz-line');
  ok('line chart renders polyline for each active series', polylines.length === 2);

  const circles = svg.querySelectorAll('circle.viz-point');
  ok('line chart renders data point circles (5 points * 2 series = 10)', circles.length === 10);

  // 检查阈值告警线（默认 threshold: 250，入站有 310 与 290 超过 250）
  const threshLine = svg.querySelector('.viz-threshold-line');
  ok('threshold line is rendered', threshLine !== null);

  const alertPoints = svg.querySelectorAll('circle.is-alert');
  ok('points exceeding threshold are marked with is-alert', alertPoints.length === 2);

  // 3. 受控参数交互测试
  console.log('\n--- 3. 受控参数交互与即时更新 ---');

  // (1) 切换为柱状图
  const btnBar = rightPane.querySelector('.viz-type-row .viz-toggle-btn:last-child');
  btnBar.click();

  const barSvg = rightPane.querySelector('svg.viz-svg');
  ok('chart type switched to bar in class', barSvg.classList.contains('viz-chart-bar'));
  const bars = barSvg.querySelectorAll('rect.viz-bar');
  ok('bar chart renders rect bars (5 labels * 2 series = 10)', bars.length === 10);
  const alertBars = barSvg.querySelectorAll('rect.is-alert');
  ok('exceeding bars also receive is-alert', alertBars.length === 2);

  // 切回折线图
  const btnLine = rightPane.querySelector('.viz-type-row .viz-toggle-btn:first-of-type');
  btnLine.click();
  ok('switched back to line chart', rightPane.querySelector('svg.viz-svg').classList.contains('viz-chart-line'));

  // (2) 切换系列显隐
  const seriesPills = rightPane.querySelectorAll('.viz-series-pills .viz-pill');
  ok('two series pills present', seriesPills.length === 2);

  // 关闭「出站」系列
  seriesPills[1].click();
  ok('second series pill deactivated', !seriesPills[1].classList.contains('is-active'));
  const linesAfterHide = rightPane.querySelectorAll('polyline.viz-line');
  ok('only 1 polyline rendered after series toggle', linesAfterHide.length === 1);

  // 至少保留 1 个系列开启测试：尝试关闭剩下的「入站」系列
  seriesPills[0].click();
  ok('cannot deactivate the last remaining series', seriesPills[0].classList.contains('is-active'));

  // 重新激活出站系列
  seriesPills[1].click();
  ok('second series re-activated', seriesPills[1].classList.contains('is-active'));
  ok('2 polylines restored', rightPane.querySelectorAll('polyline.viz-line').length === 2);

  // (3) 阈值调节
  const threshSlider = rightPane.querySelector('.viz-thresh-row .viz-slider');
  threshSlider.value = '350';
  threshSlider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  // 阈值提到 350 后，最高 310，没有超标点
  const noAlertPoints = rightPane.querySelectorAll('circle.is-alert');
  ok('raising threshold above max eliminates alert points', noAlertPoints.length === 0);

  // (4) 重置按钮
  const resetBtn = rightPane.querySelector('.rp-head-actions button:first-child');
  resetBtn.click();
  ok('reset button restores default threshold alerts (2 points)', rightPane.querySelectorAll('circle.is-alert').length === 2);

  // 4. 引用到 Agent 输入框测试
  console.log('\n--- 4. 引用到输入框草稿 (Composer) ---');

  el.input.value = '原有用户问题。';
  const quoteBtn = rightPane.querySelector('.viz-quote-btn');
  quoteBtn.click();

  ok('composer draft contains original question', el.input.value.startsWith('原有用户问题。'));
  ok('composer draft contains [图表配置引用：网络流量吞吐]', el.input.value.includes('[图表配置引用：网络流量吞吐]'));
  ok('composer draft contains series summary stats', el.input.value.includes('入站:') && el.input.value.includes('均值'));
  ok('composer draft length is strictly bounded (< 1000 chars)', el.input.value.length < 1000);

  // 5. 会话与生命周期安全
  console.log('\n--- 5. 会话与生命周期失效安全 ---');

  // 触发会话切换事件
  document.dispatchEvent(new dom.window.CustomEvent('pi-gui:session-switch', { detail: { sessionId: 'new-session' } }));
  ok('viz pane automatically closes on session switch', pane.isOpen() === false);

  // 重新打开后，模拟不同会话 ID 尝试引用
  openBtn.click();
  ok('reopened viz pane', pane.isOpen() === true);

  S.state = { sessionId: 'different-session-xyz' };
  const staleQuoteBtn = rightPane.querySelector('.viz-quote-btn');
  const prevValue = el.input.value;
  staleQuoteBtn.click();
  ok('stale viz panel does not mutate draft of mismatched session', el.input.value === prevValue);

  // 关闭面板资源释放
  pane.close();
  ok('panel cleanly closed', pane.isOpen() === false);
  ok('rp-body is emptied on close', rightPane.querySelector('.rp-body').childElementCount === 0);

  console.log(`\nViz UI & Lifecycle: ${checks}/${checks} passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
