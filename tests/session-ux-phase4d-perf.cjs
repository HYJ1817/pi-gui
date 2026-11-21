/* P4-D 长会话性能基准（真实 Chromium/CDP，先测量再优化）。
 *
 * 场景：
 *  - Classic 810 / 1643 条消息首次渲染；
 *  - Classic 多会话来回切换与快速连续切换；
 *  - Classic 历史搜索落点（scrollToUserTurn）、书签恢复、工具组/Thinking 开合；
 *  - Runtime 历史加载、240 block / 1 MiB 截断、保留命中与裁剪命中定位；
 *  - 会话全文搜索服务冷/热缓存计时（真实 server/session-search.js + 临时 JSONL）。
 *
 * 每个场景在每次运行内重复采样，5 次独立浏览器运行汇总；
 * 输出中位数、P95、关键 long task 与 DOM 数量。原始数据写入
 * docs/ui/session-ux-phase4d-evidence/<label>/run-N.json。
 *
 * 用法：
 *   npm run test:session-ux-phase4d:perf            # label=after
 *   P4D_PERF_LABEL=baseline P4D_PERF_RUNS=5 node tests/session-ux-phase4d-perf.cjs
 *
 * 夹具全部合成，不启动真实 Pi、不读写用户会话。 */
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LABEL = process.env.P4D_PERF_LABEL || 'after';
const RUNS = Math.max(1, Number(process.env.P4D_PERF_RUNS || 5));
const OUT = process.env.P4D_PERF_OUT ? path.resolve(process.env.P4D_PERF_OUT)
  : path.join(ROOT, 'docs', 'ui', 'session-ux-phase4d-evidence', LABEL);
const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
];

function findBrowser() {
  if (process.env.UI2C_CHROME || process.env.CHROME_PATH) return process.env.UI2C_CHROME || process.env.CHROME_PATH;
  for (const candidate of BROWSER_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
  for (const [command, args] of process.platform === 'win32'
    ? [['where.exe', ['chrome.exe']], ['where.exe', ['msedge.exe']]]
    : [['which', ['google-chrome']], ['which', ['chromium']], ['which', ['microsoft-edge']]]) {
    try {
      const found = execFileSync(command, args, { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (found && fs.existsSync(found)) return found;
    } catch { /* not in path */ }
  }
  return null;
}

const CHROME = findBrowser();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ---------- 浏览器 ---------- */

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p4d-perf-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-background-networking', '--disable-default-apps', '--metrics-recording-only',
    '--hide-scrollbars', '--enable-precise-memory-info', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1320,820', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 100; i++) {
    if (!port) {
      try {
        const value = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/, 1)[0]);
        if (Number.isInteger(value) && value > 0) port = value;
      } catch { /* waiting */ }
    }
    if (port) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = targets.find(target => target.type === 'page');
        if (page) return { chrome, page, profile, port };
      } catch { /* waiting */ }
    }
    await sleep(200);
  }
  throw new Error('无法连接 Chrome DevTools');
}

async function startHarness() {
  const harness = spawn(process.execPath, [path.join(ROOT, 'tests', 'visual-harness.cjs')], {
    env: { ...process.env, HARNESS_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('夹具启动超时')), 15000);
    harness.stdout.on('data', chunk => {
      buf += String(chunk);
      const match = buf.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}/`); }
    });
    harness.on('exit', code => { clearTimeout(timer); reject(new Error('夹具退出 ' + code)); });
  });
  return { harness, url };
}

function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    const pending = new Map();
    let idc = 0;
    const pageErrors = [];
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise(resolveSend => {
        const id = ++idc;
        pending.set(id, resolveSend);
        ws.send(JSON.stringify({ id, method, params }));
      }),
      pageErrors,
      close: () => { try { ws.close(); } catch { /* ignore */ } },
    });
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        pageErrors.push(String(message.params?.exceptionDetails?.exception?.description
          || message.params?.exceptionDetails?.text || '').slice(0, 400));
      }
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    };
  });
}

/* ---------- 页面内基准（作为一个大函数发送） ---------- */

async function pageBench() {
  const painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const text = value => ({ type: 'text', text: value });
  const median = values => {
    const list = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!list.length) return null;
    const mid = list.length >> 1;
    return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
  };

  const LONG_OUTPUT = ('npm run test:ui2 -- --grep case-77\n' +
    'ok 1 - reads the bounded projection\n' +
    'ok 2 - keeps scroll anchors stable\n' +
    'long output keeps the hidden detail pre filled with realistic text. '.repeat(24));
  const THINKING = '先确认边界：只读历史不启动会话；工具结果按真实顺序插入；任何裁剪都要显式说明。'
    .repeat(8);

  /* 夹具按真实 pi 形状生成：user / assistant(text+thinking) / toolCall + toolResult。
   * 消息数量由 turns、工具批次、Plan 批次、子代理批次共同决定，均 >= 809。 */
  function makeMessages(prefix, { turns = 300, toolEvery = 8, planEvery = 25, subagentEvery = 60 } = {}) {
    const messages = [];
    let userIndex = 0;
    let toolId = 0;
    let planId = 0;
    let subId = 0;
    const pushUser = i => {
      messages.push({
        role: 'user', _id: `${prefix}-u${i}`, _userIndex: userIndex++,
        content: [text(`${prefix} 用户 ${i + 1}：请检查第 ${i + 1} 组实现边界与回归测试。` +
          ` Long English keeps the reading column stable and the markdown parser busy.`)],
        timestamp: 1_700_000_000_000 + i * 1000,
      });
    };
    const pushAssistantText = i => messages.push({
      role: 'assistant', usage: { input: 100 + i, output: 40 + i, totalTokens: 140 + i * 2 },
      content: [
        { type: 'thinking', thinking: THINKING },
        text(`${prefix} 助手 ${i + 1}：已核对模块边界、离线验证和异常处理。` +
          `**长中文**用于制造真实换行；inline code \`npm test\` 与列表：\n- 第一项\n- 第二项\n` +
          `Long English keeps the reading column stable.`),
      ],
      timestamp: 1_700_000_000_500 + i * 1000, stopReason: 'toolUse',
    });
    return (() => {
      for (let i = 0; i < turns; i++) {
        pushUser(i);
        pushAssistantText(i);
        if (i % toolEvery === 0) {
          const calls = [];
          for (let t = 0; t < 4; t++) {
            const id = `${prefix}-call-${toolId++}`;
            calls.push({ type: 'toolCall', id, name: t % 2 ? 'bash' : 'read',
              arguments: { path: `fixture-${i}-${t}.txt`, command: `npm run test:ui2 -- --grep case-${i}` } });
          }
          messages.push({ role: 'assistant', usage: { input: 200, output: 90, totalTokens: 290 },
            content: calls, timestamp: 1_700_000_000_700 + i * 1000, stopReason: 'toolUse' });
          calls.forEach((call, t) => messages.push({
            role: 'toolResult', toolCallId: call.id, toolName: call.name,
            isError: t === 3 && i % 24 === 0,
            timestamp: 1_700_000_000_800 + i * 1000 + t,
            content: [text(`${prefix} result ${i}-${t} ` + (t === 0 ? LONG_OUTPUT.repeat(2) : LONG_OUTPUT))],
          }));
        }
        if (i % planEvery === 0) {
          const id = `${prefix}-plan-${planId++}`;
          const tasks = [
            { id: 'analyze', title: `分析第 ${i + 1} 组边界`, status: 'completed' },
            { id: 'implement', title: `实现第 ${i + 1} 组修复`, status: i % 2 ? 'completed' : 'in_progress' },
            { id: 'verify', title: `验证第 ${i + 1} 组回归`, status: 'pending' },
          ];
          const plan = { version: 1, tasks, explanation: '按真实工具输出驱动计划卡。', turnId: `${prefix}-turn-${i}`, revision: 1 };
          messages.push({ role: 'assistant',
            content: [{ type: 'toolCall', id, name: 'gui_plan', arguments: plan }],
            timestamp: 1_700_000_000_900 + i * 1000, stopReason: 'toolUse' });
          messages.push({ role: 'toolResult', toolCallId: id, toolName: 'gui_plan', isError: false,
            timestamp: 1_700_000_000_950 + i * 1000, content: [text('plan recorded')], details: plan });
        }
        if (i % subagentEvery === 0) {
          const runId = `${prefix}-run-${subId++}`;
          const calls = [
            { type: 'toolCall', id: runId + '-a', name: 'subagent', arguments: { agent: 'reviewer', task: 'Review module boundaries' } },
            { type: 'toolCall', id: runId + '-b', name: 'subagent', arguments: { agent: 'tester', task: 'Run regression checks' } },
          ];
          messages.push({ role: 'assistant', content: calls, timestamp: 1_700_000_000_970 + i * 1000, stopReason: 'toolUse' });
          calls.forEach((call, n) => messages.push({
            role: 'toolResult', toolCallId: call.id, toolName: 'subagent', isError: false,
            timestamp: 1_700_000_000_980 + i * 1000 + n,
            content: [text('subagent done')],
            details: {
              mode: 'workflow', runId, workflowChildren: {
                version: 1, parentToolCallId: call.id, workflowRunId: runId, inventoryComplete: true,
                workflowState: 'completed',
                children: [
                  { childId: 'review-ui', agent: 'custom-ui', state: 'completed', model: 'actual/ui' },
                  { childId: 'review-api', agent: 'custom-api', state: 'completed', model: 'actual/api' },
                  { childId: 'review-tests', agent: 'custom-tests', state: 'failed', model: 'actual/tests',
                    activity: { currentTool: 'bash', toolCount: 3, turnCount: 2, tokens: 1200, durationMs: 8000 } },
                ],
              },
            },
          }));
        }
      }
      messages[0]._firstNeedle = true;
      return { messages, userCount: userIndex };
    })();
  }

  const fixtureA = makeMessages('A');
  const fixtureB = makeMessages('B');
  const fixtureLong = makeMessages('L', { turns: 600, toolEvery: 8, planEvery: 25, subagentEvery: 60 });
  const A = fixtureA.messages;
  const B = fixtureB.messages;
  const LONG = fixtureLong.messages;
  /* 供单独 CPU profile 使用（Node 侧在一次页面基准结束后再发起）。 */
  window.__p4dFixtures = { A, B, LONG };

  const longTasks = [];
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  });
  try { observer.observe({ type: 'longtask', buffered: true }); } catch { /* not supported */ }
  const longTaskStats = () => ({
    count: longTasks.length,
    max: longTasks.length ? Math.max(...longTasks) : 0,
    total: longTasks.reduce((sum, value) => sum + value, 0),
  });
  const resetLongTasks = () => { longTasks.length = 0; };

  const stream = document.querySelector('#stream');
  const domCounts = () => ({
    documentNodes: document.querySelectorAll('*').length,
    streamNodes: stream.querySelectorAll('*').length,
    messages: stream.querySelectorAll('.msg').length,
    userMessages: stream.querySelectorAll('.msg.user').length,
    toolGroups: stream.querySelectorAll('.tl-group').length,
    toolRows: stream.querySelectorAll('.tl-item').length,
    planCards: stream.querySelectorAll('.plan-card').length,
    thinkingBlocks: stream.querySelectorAll('.think').length,
    subagentRows: stream.querySelectorAll('.tl-subagent-row').length,
    scrollHeight: stream.scrollHeight,
  });

  const measureRebuild = async (messages, sessionId, { paint = true } = {}) => {
    __M.saveClassicReadingPosition(__M.classicThreadSessionId());
    __M.clearThread();
    stream.scrollTop = 0;
    resetLongTasks();
    const start = performance.now();
    __M.rebuildFromMessages(messages, sessionId);
    const syncMs = performance.now() - start;
    /* 长历史是分块构建+挂载：syncMs 是首批进入 DOM 并返回的时间，
     * readyMs/ms 才是完整就绪。基线版本没有这个函数，optional 调用保持同一份脚本可对比。 */
    await __M.waitForClassicRenderIdle?.();
    const readyMs = performance.now() - start;
    if (paint) await painted();
    return {
      ms: performance.now() - start,
      syncMs,
      readyMs,
      paintMs: performance.now() - start - readyMs,
      longTasks: longTaskStats(),
      dom: domCounts(),
      sessionId: __M.classicThreadSessionId(),
      heapBytes: performance.memory?.usedJSHeapSize || null,
    };
  };

  /* 统计重建期间强制布局调用，帮助定位同步段成本。 */
  async function measureRebuildWithLayoutProbe(messages, sessionId) {
    __M.saveClassicReadingPosition(__M.classicThreadSessionId());
    __M.clearThread();
    stream.scrollTop = 0;
    const original = Element.prototype.getBoundingClientRect;
    let calls = 0, cost = 0;
    Element.prototype.getBoundingClientRect = function (...args) {
      const t0 = performance.now();
      const result = original.apply(this, args);
      cost += performance.now() - t0;
      calls++;
      return result;
    };
    resetLongTasks();
    const start = performance.now();
    try {
      __M.rebuildFromMessages(messages, sessionId);
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
    const syncMs = performance.now() - start;
    await __M.waitForClassicRenderIdle?.();
    await painted();
    return { ms: performance.now() - start, syncMs, rectCalls: calls, rectCostMs: cost, longTasks: longTaskStats(), dom: domCounts() };
  }

  async function waitScrollSettled(element, timeoutMs = 2500) {
    const started = performance.now();
    let last = element.scrollTop;
    let stable = 0;
    while (performance.now() - started < timeoutMs) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (Math.abs(element.scrollTop - last) < 0.5) stable++;
      else stable = 0;
      last = element.scrollTop;
      if (stable >= 3) break;
    }
    return performance.now() - started;
  }

  const samples = {};

  /* 导航层微基准：把 rebuildConversationNav 与预览文本读取分开计时。 */
  {
    await measureRebuild(A, 'p4d-nav-probe');
    const nav = document.getElementById('convoNav');
    const userEls = [...stream.querySelectorAll('.msg.user')];
    let t0 = performance.now();
    const previews = userEls.map(element => {
      const body = element.querySelector('.msg-body');
      const raw = body ? body.textContent || '' : '';
      return raw.replace(/\s+/g, ' ').trim().slice(0, 40);
    });
    const previewMs = performance.now() - t0;
    t0 = performance.now();
    nav.replaceChildren();
    const clearMs = performance.now() - t0;
    t0 = performance.now();
    const markers = userEls.map(preview => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cn-marker';
      button.setAttribute('aria-label', '跳转到：' + preview);
      const tip = document.createElement('span');
      tip.className = 'cn-tip';
      tip.textContent = preview;
      button.append(tip);
      return button;
    });
    const markerMs = performance.now() - t0;
    t0 = performance.now();
    for (const marker of markers) nav.append(marker);
    const appendMs = performance.now() - t0;
    t0 = performance.now();
    __CN.rebuildConversationNav();
    const rebuildNavMs = performance.now() - t0;
    await painted();
    samples.navProbe = [{ count: userEls.length, previewMs, clearMs, markerMs, appendMs, rebuildNavMs,
      fullAfterPaintMs: performance.now() - t0 }];
  }

  /* 0a. 连续 10 次同规模重建，观察冷启动 / JIT / 样式缓存曲线。 */
  samples.classicWarmup = [];
  for (let i = 0; i < 10; i++) samples.classicWarmup.push(await measureRebuild(A, `p4d-warmup-${i}`));

  /* 0. 一次带布局探针的重建，记录 getBoundingClientRect 调用与耗时。 */
  samples.classicLayoutProbe = [await measureRebuildWithLayoutProbe(A, 'p4d-layout-probe')];

  /* 1. Classic 首次渲染：810 条，5 次（第 1 次为冷启动）。 */
  samples.classicFirst810 = [];
  for (let i = 0; i < 5; i++) {
    samples.classicFirst810.push(await measureRebuild(A, `p4d-first-810-${i}`));
  }

  /* 2. Classic 首次渲染：1643 条，3 次。 */
  samples.classicFirstLong = [];
  for (let i = 0; i < 3; i++) {
    samples.classicFirstLong.push(await measureRebuild(LONG, `p4d-first-long-${i}`));
  }

  /* 3. 多会话来回切换：A/B/A/B，共 5 次。 */
  await measureRebuild(A, 'p4d-switch-A');
  await measureRebuild(B, 'p4d-switch-B');
  samples.classicSwitch = [];
  for (let i = 0; i < 5; i++) {
    samples.classicSwitch.push(await measureRebuild(i % 2 ? A : B, i % 2 ? 'p4d-switch-A' : 'p4d-switch-B'));
  }

  /* 4. 快速连续切换：20 次不等待绘制，然后等稳定；检查最终会话与串扰。 */
  resetLongTasks();
  const rapidStart = performance.now();
  for (let i = 0; i < 20; i++) __M.rebuildFromMessages(i % 2 ? A : B, i % 2 ? 'p4d-rapid-A' : 'p4d-rapid-B');
  const rapidSyncMs = performance.now() - rapidStart;
  if (typeof __M.waitForClassicRenderIdle === 'function') await __M.waitForClassicRenderIdle();
  await painted();
  samples.classicRapidSwitch = [{
    ms: performance.now() - rapidStart, syncMs: rapidSyncMs, longTasks: longTaskStats(),
    sessionId: __M.classicThreadSessionId(),
    leakedOther: __M.classicThreadSessionId() === 'p4d-rapid-A'
      ? stream.textContent.includes('B 用户 1')
      : stream.textContent.includes('A 用户 1'),
    dom: domCounts(),
  }];
  await __M.waitForClassicRenderIdle?.();

  /* 4b. 真实点击节奏：每次切换之间留一个任务边界（约 12ms），
   * 让旧渲染有机会被下一次 clearThread 取消。基线版本每次重建同步完成；
   * 分块版本只完成尾块，后续任务可取消。 */
  resetLongTasks();
  const interactiveStart = performance.now();
  for (let i = 0; i < 20; i++) {
    __M.rebuildFromMessages(i % 2 ? A : B, i % 2 ? 'p4d-rapid-i-A' : 'p4d-rapid-i-B');
    await new Promise(resolve => setTimeout(resolve, 12));
  }
  __M.rebuildFromMessages(A, 'p4d-rapid-i-final');
  await __M.waitForClassicRenderIdle?.();
  await painted();
  samples.classicRapidSwitchInteractive = [{
    ms: performance.now() - interactiveStart, longTasks: longTaskStats(),
    sessionId: __M.classicThreadSessionId(),
    users: stream.querySelectorAll('.msg.user').length,
    leakedOther: __M.classicThreadSessionId() === 'p4d-rapid-i-final'
      ? stream.textContent.includes('B 用户 1')
      : stream.textContent.includes('A 用户 1'),
    dom: domCounts(),
  }];

  /* 5. 搜索落点：渲染 A 后跳到首/中/尾三次提问。 */
  await measureRebuild(A, 'p4d-jump');
  samples.classicJump = [];
  for (const index of [0, Math.floor(fixtureA.userCount / 2), fixtureA.userCount - 1]) {
    stream.scrollTop = 0;
    resetLongTasks();
    const start = performance.now();
    const ok = __CN.scrollToUserTurn(index);
    const settleMs = await waitScrollSettled(stream);
    samples.classicJump.push({
      ms: performance.now() - start, settleMs, longTasks: longTaskStats(),
      index, ok, scrollTop: stream.scrollTop, navIndex: __CN.currentNavIndex(),
      scrollHeight: stream.scrollHeight, clientHeight: stream.clientHeight,
    });
  }

  /* 6. 书签恢复：滚到中间一条提问，保存后原地重建，比较锚点偏移。 */
  {
    await measureRebuild(A, 'p4d-bookmark');
    const layoutTop = node => {
      const rect = node.getBoundingClientRect();
      const transform = getComputedStyle(node).transform;
      return transform === 'none' ? rect.top : rect.top - new DOMMatrixReadOnly(transform).m42;
    };
    const target = stream.querySelectorAll('.msg.user')[120];
    const top = target.getBoundingClientRect().top;
    stream.scrollTop = Math.max(0, stream.scrollTop + top - stream.getBoundingClientRect().top - 40);
    await painted();
    __M.saveClassicReadingPosition('p4d-bookmark');
    const before = layoutTop(target);
    resetLongTasks();
    const start = performance.now();
    __M.rebuildFromMessages(A, 'p4d-bookmark');
    const syncMs = performance.now() - start;
    await __M.waitForClassicRenderIdle?.();
    await painted();
    const afterTarget = stream.querySelectorAll('.msg.user')[120];
    const after = layoutTop(afterTarget);
    samples.classicBookmark = [{
      ms: performance.now() - start, syncMs, longTasks: longTaskStats(),
      deltaPx: Math.abs(after - before), bookmarkedTop: before, restoredTop: after,
      scrollTop: stream.scrollTop, dom: domCounts(),
    }];
  }

  /* 7. 工具组展开/折叠与 Thinking 展开（各 3 次，取中位数）。 */
  {
    await measureRebuild(A, 'p4d-toggles');
    const group = stream.querySelector('.tl-group');
    const groupHead = group?.querySelector('.tl-group-head');
    const thinkHead = stream.querySelector('.think-head');
    const groupSamples = [];
    if (groupHead) {
      if (groupHead.getAttribute('aria-expanded') === 'true') groupHead.click();
      await painted();
      for (let i = 0; i < 3; i++) {
        let t0 = performance.now();
        groupHead.click(); await painted();
        const expand = performance.now() - t0;
        t0 = performance.now();
        groupHead.click(); await painted();
        groupSamples.push({ expandMs: expand, collapseMs: performance.now() - t0 });
      }
    }
    const thinkSamples = [];
    if (thinkHead) {
      for (let i = 0; i < 3; i++) {
        let t0 = performance.now();
        thinkHead.click(); await painted();
        const open = performance.now() - t0;
        t0 = performance.now();
        thinkHead.click(); await painted();
        thinkSamples.push({ openMs: open, closeMs: performance.now() - t0 });
      }
    }
    samples.classicToggles = [{ group: groupSamples, thinking: thinkSamples, dom: domCounts() }];
  }

  /* ---------- Runtime ---------- */
  document.querySelector('#runtimeView').replaceChildren();
  __surface.showRuntimeConversation();
  document.querySelector('#runtimeView').replaceChildren();
  const view = __RTC.createRuntimeConversation({ host: document.querySelector('#runtimeView') });
  __RS.runtimeStore.seed({ backendInstance: 'perf', items: [
    { conversationId: 'P4D-A', createdAt: '2026-11-16T00:00:00.000Z', workspace: { branch: 'perf', projectId: 'project', workspaceId: 'ws-a', workspaceEpoch: 'epoch' },
      owner: null, lifecycle: 'dormant', activity: 'idle', attention: false, nativeSessionId: 'native-A' },
    { conversationId: 'P4D-B', createdAt: '2026-11-16T00:00:00.000Z', workspace: { branch: 'perf', projectId: 'project', workspaceId: 'ws-b', workspaceEpoch: 'epoch' },
      owner: null, lifecycle: 'dormant', activity: 'idle', attention: false, nativeSessionId: 'native-B' },
  ] });
  const locator = conversationId => ({ conversationId, nativeSessionId: conversationId === 'P4D-A' ? 'native-A' : 'native-B',
    projectId: 'project', workspaceId: conversationId === 'P4D-A' ? 'ws-a' : 'ws-b', workspaceEpoch: 'epoch' });
  const timelineOf = messages => {
    const metas = messages.map(message => ({
      messageId: message._id || null,
      userIndex: Number.isInteger(message._userIndex) ? message._userIndex : null,
    }));
    return __RT.timelineFromMessages(messages, { messageMeta: metas });
  };
  const projections = { A: timelineOf(A), B: timelineOf(B) };
  const payloads = {
    A: { ok: true, locator: locator('P4D-A'), messages: A.map(message => ({ role: message.role, text: '' })), truncated: true,
      execution: { timeline: projections.A.blocks, truncated: projections.A.truncated, planBoundary: projections.A.planBoundary } },
    B: { ok: true, locator: locator('P4D-B'), messages: B.map(message => ({ role: message.role, text: '' })), truncated: true,
      execution: { timeline: projections.B.blocks, truncated: projections.B.truncated, planBoundary: projections.B.planBoundary } },
  };
  const lastUserA = A.filter(message => message.role === 'user').slice(-1)[0];
  const firstUserA = A.find(message => message.role === 'user');
  const lastUserB = B.filter(message => message.role === 'user').slice(-1)[0];
  window.fetch = async input => {
    const url = String(input);
    if (url.includes('/api/runtime-sessions')) {
      const payload = url.includes('P4D-B') ? payloads.B : payloads.A;
      return { status: 200, json: async () => payload };
    }
    return { status: 200, json: async () => ({ ok: true, backendInstance: 'perf', items: [] }) };
  };
  const runtimeOutput = () => document.querySelector('#runtimeView .rtc-output');
  const openHistory = async (conversationId, match = null) => {
    const target = locator(conversationId);
    resetLongTasks();
    const start = performance.now();
    const opened = await view.openHistory(target, match);
    await painted();
    const out = runtimeOutput();
    return {
      ms: performance.now() - start, opened, longTasks: longTaskStats(),
      blocks: out?.querySelectorAll('.rtc-timeline-message, .ui2-runtime-thinking, .ui2-runtime-tools, .plan-card').length || 0,
      messages: out?.querySelectorAll('.rtc-history-message').length || 0,
      scrolled: out?.querySelectorAll('[data-history-scrolled="true"]').length || 0,
      notice: document.querySelector('#runtimeView .rtc-history-locate')?.textContent || '',
      state: document.querySelector('#runtimeView .rtc-state')?.textContent || '',
      scrollTop: out?.scrollTop || 0, scrollHeight: out?.scrollHeight || 0,
      truncated: (document.querySelector('#runtimeView .rtc-state')?.textContent || '').includes('仅显示最近部分'),
      timelineTruncated: (document.querySelector('#runtimeView .rtc-state')?.textContent || '').includes('执行记录已截断'),
      dom: {
        documentNodes: document.querySelectorAll('*').length,
        outputNodes: out?.querySelectorAll('*').length || 0,
        heapBytes: performance.memory?.usedJSHeapSize || null,
      },
    };
  };

  samples.runtimeHistory = [];
  for (let i = 0; i < 5; i++) samples.runtimeHistory.push(await openHistory('P4D-A'));
  samples.runtimeSwitch = [];
  for (let i = 0; i < 4; i++) samples.runtimeSwitch.push(await openHistory(i % 2 ? 'P4D-A' : 'P4D-B'));
  samples.runtimeLocate = [{
    retained: await openHistory('P4D-A', { messageId: lastUserA._id, userIndex: lastUserA._userIndex }),
    trimmed: await openHistory('P4D-A', { messageId: firstUserA._id, userIndex: firstUserA._userIndex }),
  }];
  void lastUserB;

  /* 快速切换 + 迟到响应：A 的读取不能覆盖 B。 */
  {
    let releaseA;
    const originalFetch = window.fetch;
    window.fetch = input => {
      const url = String(input);
      if (url.includes('conversationId=P4D-A')) {
        return new Promise(resolve => { releaseA = () => resolve({ status: 200, json: async () => payloads.A }); });
      }
      return originalFetch(input);
    };
    view.show('P4D-A');
    const pendingA = view.openHistory(locator('P4D-A'));
    await wait(30);
    await view.openHistory(locator('P4D-B'));
    const textBefore = runtimeOutput()?.textContent || '';
    releaseA?.();
    await pendingA;
    await painted();
    samples.runtimeRapidSwitch = [{
      finalText: (runtimeOutput()?.textContent || '').slice(0, 80),
      includesA: (runtimeOutput()?.textContent || '').includes('A 用户 300'),
      includesB: (runtimeOutput()?.textContent || '').includes('B 用户 300'),
      beforeIncludesB: textBefore.includes('B 用户 300'),
      dom: { documentNodes: document.querySelectorAll('*').length },
    }];
    window.fetch = originalFetch;
  }

  try { observer.disconnect(); } catch { /* ignore */ }
  return {
    samples,
    fixture: {
      A: { messages: A.length, users: fixtureA.userCount },
      B: { messages: B.length, users: fixtureB.userCount },
      Long: { messages: LONG.length, users: fixtureLong.userCount },
      toolCalls: A.reduce((sum, message) => sum + (Array.isArray(message.content)
        ? message.content.filter(part => part.type === 'toolCall').length : 0), 0),
      lastUserMessageId: lastUserA._id,
      firstUserMessageId: firstUserA._id,
    },
    projection: {
      A: { blocks: projections.A.blocks.length, truncated: projections.A.truncated,
        kinds: projections.A.blocks.reduce((counts, block) => { counts[block.kind] = (counts[block.kind] || 0) + 1; return counts; }, {}) },
      B: { blocks: projections.B.blocks.length, truncated: projections.B.truncated },
    },
    viewport: { width: innerWidth, height: innerHeight },
  };
}

/* ---------- 全文搜索服务计时 ---------- */

async function searchBench() {
  const { createSessions } = await import('../server/sessions.js');
  const { createSessionSearch } = await import('../server/session-search.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p4d-search-'));
  const agent = path.join(tmp, 'agent');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project, { recursive: true });
  const runtime = { getCurrentCwd: () => project };
  const env = { HOME: tmp, PI_CODING_AGENT_DIR: agent };
  const sessions = createSessions({ runtime, rpc: null, env, dataDir: path.join(tmp, 'data') });
  const dir = path.join(sessions.root, sessions._internals.dirNameFor(project));
  fs.mkdirSync(dir, { recursive: true });
  const line = (index, id, userText, assistantText) => [
    JSON.stringify({ type: 'message', id: `${id}-u`, parentId: null, timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: userText }] } }),
    JSON.stringify({ type: 'message', id: `${id}-a`, parentId: null, timestamp: new Date(1_700_000_000_500 + index * 1000).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } }),
  ];
  const files = [];
  for (let s = 0; s < 3; s++) {
    const id = `p4d-search-${s}`;
    const rows = [JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-11-16T00:00:00.000Z', cwd: project })];
    for (let i = 0; i < 405; i++) {
      rows.push(...line(i, `${id}-${i}`, `第 ${i} 组问题：needle 是否保留？`, `第 ${i} 组回答：命中 needle，保留锚点与裁剪说明。`));
    }
    files.push(path.join(dir, `2026-11-16T00-00-00-000Z_${id}.jsonl`));
    fs.writeFileSync(files[files.length - 1], rows.join('\n') + '\n', 'utf8');
  }
  const bytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  const rounds = [];
  for (let i = 0; i < 7; i++) {
    const search = createSessionSearch({ runtime, sessions });
    const start = performance.now();
    const result = await search.search('needle');
    const coldMs = performance.now() - start;
    const warmStart = performance.now();
    const warm = await search.search('needle');
    const warmMs = performance.now() - warmStart;
    rounds.push({ coldMs, warmMs,
      sessions: result.results?.length || 0,
      matches: result.results?.reduce((sum, r) => sum + (r.matches?.length || 0), 0) || 0,
      skipped: result.scanned?.skipped ?? null, truncated: result.scanned?.truncated ?? null,
      warmMatches: warm.results?.reduce((sum, r) => sum + (r.matches?.length || 0), 0) || 0 });
  }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows 偶发占用 */ }
  return { files: files.length, linesPerFile: 810, bytes, rounds };
}

/* ---------- 汇总 ---------- */

function percentile(values, p) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const rank = Math.ceil((p / 100) * list.length) - 1;
  return list[Math.max(0, Math.min(list.length - 1, rank))];
}
const median = values => percentile(values, 50);
const numeric = value => typeof value === 'number' && Number.isFinite(value);

function flatten(samples) {
  const out = {};
  const push = (key, value) => {
    for (const item of Array.isArray(value) ? value : [value]) if (numeric(item)) (out[key] ||= []).push(item);
  };
  push('classic.warmup.ms', samples.classicWarmup?.map(s => s.ms));
  push('classic.warmup.syncMs', samples.classicWarmup?.map(s => s.syncMs));
  push('classic.layoutProbe.rectCalls', samples.classicLayoutProbe?.map(s => s.rectCalls));
  push('classic.layoutProbe.rectCostMs', samples.classicLayoutProbe?.map(s => s.rectCostMs));
  push('classic.layoutProbe.syncMs', samples.classicLayoutProbe?.map(s => s.syncMs));
  push('classic.first810.ms', samples.classicFirst810?.map(s => s.ms));
  push('classic.first810.syncMs', samples.classicFirst810?.map(s => s.syncMs));
  push('classic.first810.longTaskMax', samples.classicFirst810?.map(s => s.longTasks.max));
  push('classic.first810.dom.streamNodes', samples.classicFirst810?.map(s => s.dom.streamNodes));
  push('classic.firstLong.ms', samples.classicFirstLong?.map(s => s.ms));
  push('classic.firstLong.syncMs', samples.classicFirstLong?.map(s => s.syncMs));
  push('classic.firstLong.longTaskMax', samples.classicFirstLong?.map(s => s.longTasks.max));
  push('classic.switch.ms', samples.classicSwitch?.map(s => s.ms));
  push('classic.switch.syncMs', samples.classicSwitch?.map(s => s.syncMs));
  push('classic.switch.longTaskMax', samples.classicSwitch?.map(s => s.longTasks.max));
  push('classic.rapid.totalMs', samples.classicRapidSwitch?.map(s => s.ms));
  push('classic.rapid.syncMs', samples.classicRapidSwitch?.map(s => s.syncMs));
  push('classic.rapid.longTaskMax', samples.classicRapidSwitch?.map(s => s.longTasks.max));
  push('classic.rapidInteractive.totalMs', samples.classicRapidSwitchInteractive?.map(s => s.ms));
  push('classic.rapidInteractive.longTaskMax', samples.classicRapidSwitchInteractive?.map(s => s.longTasks.max));
  push('classic.rapidInteractive.users', samples.classicRapidSwitchInteractive?.map(s => s.users));
  push('classic.jump.ms', samples.classicJump?.map(s => s.ms));
  push('classic.jump.settleMs', samples.classicJump?.map(s => s.settleMs));
  push('classic.jump.longTaskMax', samples.classicJump?.map(s => s.longTasks.max));
  push('classic.bookmark.ms', samples.classicBookmark?.map(s => s.ms));
  push('classic.bookmark.deltaPx', samples.classicBookmark?.map(s => s.deltaPx));
  for (const sample of samples.classicToggles || []) {
    push('classic.toggle.groupExpandMs', sample.group?.map(s => s.expandMs));
    push('classic.toggle.groupCollapseMs', sample.group?.map(s => s.collapseMs));
    push('classic.toggle.thinkingOpenMs', sample.thinking?.map(s => s.openMs));
    push('classic.toggle.thinkingCloseMs', sample.thinking?.map(s => s.closeMs));
  }
  push('runtime.history.ms', samples.runtimeHistory?.map(s => s.ms));
  push('runtime.history.longTaskMax', samples.runtimeHistory?.map(s => s.longTasks.max));
  push('runtime.history.dom.outputNodes', samples.runtimeHistory?.map(s => s.dom.outputNodes));
  push('runtime.switch.ms', samples.runtimeSwitch?.map(s => s.ms));
  push('runtime.switch.longTaskMax', samples.runtimeSwitch?.map(s => s.longTasks.max));
  for (const sample of samples.runtimeLocate || []) {
    push('runtime.locate.retainedMs', sample.retained?.ms);
    push('runtime.locate.trimmedMs', sample.trimmed?.ms);
  }
  return out;
}

function summarizeRuns(runs) {
  const merged = {};
  for (const run of runs) {
    for (const [key, values] of Object.entries(flatten(run.result.samples))) {
      if (!Array.isArray(values)) continue;
      (merged[key] ||= []).push(...values);
    }
    for (const round of run.search?.rounds || []) {
      (merged['search.coldMs'] ||= []).push(round.coldMs);
      (merged['search.warmMs'] ||= []).push(round.warmMs);
    }
  }
  const summary = {};
  for (const [key, values] of Object.entries(merged)) {
    const list = values.filter(Number.isFinite);
    summary[key] = {
      n: list.length,
      median: median(list),
      p95: percentile(list, 95),
      min: list.length ? Math.min(...list) : null,
      max: list.length ? Math.max(...list) : null,
    };
  }
  return summary;
}

/* ---------- 主流程 ---------- */

async function main() {
  if (!CHROME) throw new Error('找不到 Chromium');
  fs.mkdirSync(OUT, { recursive: true });
  const { harness, url } = await startHarness();
  console.log('夹具: ' + url);

  const search = await searchBench();
  console.log('搜索基准: ' + JSON.stringify({
    files: search.files, linesPerFile: search.linesPerFile, bytes: search.bytes,
    coldMedian: median(search.rounds.map(r => r.coldMs)),
    warmMedian: median(search.rounds.map(r => r.warmMs)),
    matches: search.rounds[0]?.matches,
  }));

  const runs = [];
  let chromeVersion = '';
  try {
    for (let runIndex = 1; runIndex <= RUNS; runIndex++) {
      const { chrome, page, profile } = await launch();
      const cdp = await connect(page);
      try {
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        if (runIndex === 1) {
          const version = await cdp.send('Browser.getVersion');
          chromeVersion = version.result?.product || '';
        }
        await cdp.send('Page.navigate', { url });
        let ready = false;
        for (let i = 0; i < 80; i++) {
          await sleep(200);
          const check = await cdp.send('Runtime.evaluate', { expression: `!!document.querySelector('#stream') && !!document.querySelector('.thread')`, returnByValue: true });
          if (check.result?.result?.value) { ready = true; break; }
        }
        if (!ready) throw new Error('页面未就绪');
        await sleep(700);
        const setup = await cdp.send('Runtime.evaluate', { expression: `(async () => {
          window.__surface = await import('/ui/workspace-surface.js');
          window.__S = (await import('/state.js')).S;
          window.__M = await import('/messages.js');
          window.__CN = await import('/conversation-nav.js');
          window.__RS = await import('/runtime-state.js');
          window.__RTC = await import('/runtime-conversation.js');
          window.__RT = await import('/runtime-timeline.js');
          Object.assign(__S, { hasProject: true, bridgeState: 'ready', streaming: false, stopping: false });
          __surface.showChat();
          return true;
        })()`, returnByValue: true, awaitPromise: true });
        if (setup.result?.exceptionDetails) throw new Error(JSON.stringify(setup.result.exceptionDetails).slice(0, 500));
        await sleep(250);
        const started = Date.now();
        const evaluated = await cdp.send('Runtime.evaluate', {
          expression: `(${pageBench.toString()})()`, returnByValue: true, awaitPromise: true,
        });
        if (runIndex === 1) {
          await cdp.send('Performance.enable');
          const metricsBefore = await cdp.send('Performance.getMetrics');
          await cdp.send('Profiler.enable');
          await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
          await cdp.send('Profiler.start');
          const profiled = await cdp.send('Runtime.evaluate', {
            expression: `(async () => {
              __surface.showChat();
              __M.saveClassicReadingPosition(__M.classicThreadSessionId());
              __M.clearThread();
              const stream = document.querySelector('#stream');
              stream.scrollTop = 0;
              const start = performance.now();
              __M.rebuildFromMessages(window.__p4dFixtures.A, 'p4d-profile');
              const syncMs = performance.now() - start;
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              return { syncMs, totalMs: performance.now() - start };
            })()`, returnByValue: true, awaitPromise: true,
          });
          const metricsAfter = await cdp.send('Performance.getMetrics');
          const stopped = await cdp.send('Profiler.stop');
          const before = new Map((metricsBefore.result?.metrics || []).map(metric => [metric.name, metric.value]));
          const metricDeltas = {};
          for (const metric of metricsAfter.result?.metrics || []) {
            const previous = before.get(metric.name);
            if (Number.isFinite(previous) && Number.isFinite(metric.value)) {
              const delta = metric.value - previous;
              if (delta) metricDeltas[metric.name] = Math.round(delta * 1000) / 1000;
            }
          }
          const profile = stopped.result?.profile;
          if (profile) {
            const byId = new Map((profile.nodes || []).map(node => [node.id, node]));
            const self = new Map();
            let totalMicros = 0;
            (profile.samples || []).forEach((id, index) => {
              const delta = profile.timeDeltas?.[index] || 0;
              totalMicros += delta;
              self.set(id, (self.get(id) || 0) + delta);
            });
            const top = [...self.entries()].map(([id, micros]) => {
              const node = byId.get(id);
              const frame = node?.callFrame || {};
              return { function: frame.functionName || '(anonymous)', url: frame.url || '', line: (frame.lineNumber ?? -1) + 1,
                selfMs: Math.round(micros / 100) / 10 };
            }).sort((a, b) => b.selfMs - a.selfMs).slice(0, 30);
            fs.writeFileSync(path.join(OUT, 'profile-run-1.json'), JSON.stringify({
              measured: profiled.result?.result?.value,
              metricDeltas,
              profilingMs: Math.round(totalMicros / 100) / 10,
              top,
            }, null, 2));
            console.log('CPU profile top: ' + top.slice(0, 10).map(item => `${item.function}:${item.selfMs}ms`).join(' · '));
          }
        }
        if (evaluated.result?.exceptionDetails) {
          throw new Error(JSON.stringify(evaluated.result.exceptionDetails).slice(0, 1200));
        }
        const result = evaluated.result?.result?.value;
        if (!result) throw new Error('基准没有返回结果');
        runs.push({
          run: runIndex,
          startedAt: new Date(started).toISOString(),
          durationMs: Date.now() - started,
          result,
          search,
          pageErrors: cdp.pageErrors,
        });
        console.log(`run ${runIndex}/${RUNS}: classic first=${result.samples.classicFirst810.map(s => s.ms.toFixed(1)).join('/')} ms, ` +
          `switch=${result.samples.classicSwitch.map(s => s.ms.toFixed(1)).join('/')} ms, ` +
          `runtime=${result.samples.runtimeHistory.map(s => s.ms.toFixed(1)).join('/')} ms`);
        fs.writeFileSync(path.join(OUT, `run-${runIndex}.json`), JSON.stringify(runs[runs.length - 1], null, 2));
      } finally {
        cdp.close();
        try { chrome.kill(); } catch { /* ignore */ }
        await sleep(300);
        try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2 }); } catch { /* ignore */ }
      }
    }
  } finally {
    try { harness.kill(); } catch { /* ignore */ }
  }

  const summary = {
    label: LABEL,
    measuredAt: new Date().toISOString(),
    environment: {
      platform: process.platform, arch: process.arch, node: process.version,
      cpus: os.cpus()[0]?.model || '', totalMemBytes: os.totalmem(),
      chrome: chromeVersion, viewport: runs[0]?.result.viewport,
    },
    fixture: runs[0]?.result.fixture,
    projection: runs[0]?.result.projection,
    runs: RUNS,
    metrics: summarizeRuns(runs),
    search: {
      files: search.files, linesPerFile: search.linesPerFile, bytes: search.bytes,
      coldMs: median(search.rounds.map(r => r.coldMs)),
      warmMs: median(search.rounds.map(r => r.warmMs)),
      matches: search.rounds[0]?.matches,
      rounds: search.rounds,
    },
    functional: runs.map(run => ({
      run: run.run,
      rapidSessionId: run.result.samples.classicRapidSwitch?.[0]?.sessionId,
      rapidLeakedOther: run.result.samples.classicRapidSwitch?.[0]?.leakedOther,
      bookmarkDeltaPx: run.result.samples.classicBookmark?.[0]?.deltaPx,
      jumpOk: run.result.samples.classicJump?.map(s => s.ok && Math.abs(s.navIndex - s.index) <= 1),
      runtimeLocateRetainedScrolled: run.result.samples.runtimeLocate?.[0]?.retained.scrolled,
      runtimeLocateTrimmedScrolled: run.result.samples.runtimeLocate?.[0]?.trimmed.scrolled,
      runtimeLocateTrimmedNotice: run.result.samples.runtimeLocate?.[0]?.trimmed.notice,
      runtimeRapidIncludesB: run.result.samples.runtimeRapidSwitch?.[0]?.includesB,
      runtimeRapidIncludesA: run.result.samples.runtimeRapidSwitch?.[0]?.includesA,
      pageErrors: run.pageErrors,
    })),
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\n汇总写入: ' + path.join(OUT, 'summary.json'));
  console.log(JSON.stringify(summary.metrics, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
