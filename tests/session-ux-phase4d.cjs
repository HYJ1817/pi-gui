/* P4-D 长会话分块渲染与历史定位功能回归（真实 Chromium）。
 *
 * 不使用 jsdom 断言分块挂载：分块依赖真实任务调度与布局，jsdom 不排版，
 * 会把这些路径测成假绿。夹具全部合成，不启动 Pi、不读写用户会话。
 *
 * 断言范围：
 *  - 809+ 条消息的 Classic 首屏：尾块先可见、结束时 DOM/导航完整、顺序正确；
 *  - 长历史中的阅读位置、Minimap/搜索跳转、Thinking/工具展开；
 *  - 分块挂载期间用户主动滚动不被贴底或旧书签覆盖；
 *  - 快速切换时旧 generation 的异步任务不写入新会话；
 *  - 完整历史留在 DOM 中（全选文本、真实打印）；
 *  - Classic 清空不影响独立的 Runtime 输出节点；
 *  - 更长会话（1643 条）同样完整挂载。
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
];
const CHROME = process.env.UI2C_CHROME || process.env.CHROME_PATH || BROWSER_CANDIDATES.find(file => fs.existsSync(file));
/* CI runner 上 Chrome 启动可能超过 20 秒；失败路径会自行收掉子进程。
 * P4D_CHROME_WAIT_MS 只用于验证超时清理，不改变正常路径。 */
const CHROME_WAIT_MS = Math.max(200, Number(process.env.P4D_CHROME_WAIT_MS) || 60000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startHarness() {
  const harness = spawn(process.execPath, [path.join(ROOT, 'tests', 'visual-harness.cjs')], {
    env: { ...process.env, HARNESS_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      try { harness.kill(); } catch { /* already gone */ }
      reject(new Error('夹具启动超时'));
    }, 15000);
    harness.stdout.on('data', chunk => {
      buffer += String(chunk);
      const match = buffer.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    harness.on('exit', code => { clearTimeout(timer); reject(new Error('夹具退出 ' + code)); });
  });
  return { harness, url };
}

async function launchChrome() {
  if (!CHROME) throw new Error('未找到 Chrome/Edge；可用 UI2C_CHROME 指定');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p4d-functional-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-background-networking', '--disable-default-apps',
    '--hide-scrollbars', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1320,820', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  let earlyExit = null;
  chrome.stdout.resume();
  chrome.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
  chrome.once('exit', (code, signal) => { earlyExit = { code, signal }; });
  chrome.once('error', error => { earlyExit = { error: error.code || error.message }; });
  const portFile = path.join(profile, 'DevToolsActivePort');
  try {
    for (let attempt = 0; attempt < Math.ceil(CHROME_WAIT_MS / 200); attempt++) {
      if (earlyExit) throw new Error(`Chrome 提前退出：${JSON.stringify(earlyExit)}${stderr ? `\n${stderr}` : ''}`);
      let port = 0;
      try { port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/, 1)[0]); } catch { /* waiting */ }
      if (port) {
        try {
          const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
          const page = targets.find(target => target.type === 'page');
          if (page) return { chrome, page };
        } catch { /* waiting */ }
      }
      await sleep(200);
    }
    throw new Error(`无法连接 Chrome DevTools（${CHROME_WAIT_MS}ms）${stderr ? `\n${stderr}` : ''}`);
  } catch (error) {
    /* 失败路径必须自己收掉 Chrome：调用方还没有拿到 chrome 句柄，
     * 否则子进程的 stdio 管道会让测试进程一直不退出。 */
    try { chrome.kill(); } catch { /* already gone */ }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* locked */ }
    throw error;
  }
}

function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    const pending = new Map();
    const pageErrors = [];
    let idc = 0;
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
          || message.params?.exceptionDetails?.text || '').slice(0, 500));
      }
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    };
  });
}

async function pageChecks() {
  const painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const text = value => ({ type: 'text', text: value });
  const waitFor = async (predicate, timeoutMs = 4000) => {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      if (predicate()) return true;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return false;
  };
  const results = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: detail?.ok === true, detail });
    } catch (error) {
      results.push({ name, ok: false, error: String(error?.stack || error) });
    }
  };

  const M = await import('/messages.js');
  const N = await import('/conversation-nav.js');
  const T = await import('/tools.js');
  const R = await import('/reading-position.js');
  const surface = await import('/ui/workspace-surface.js');
  surface.showChat();
  const stream = document.querySelector('#stream');
  stream.style.scrollBehavior = 'auto';
  /* 页面自己的 boot 会在异步 get_messages 返回后重建对话区。慢机上这次重建
   * 可能落在任一断言中间（线程被整个换掉，滚动/书签读到刚清空的状态），
   * 所以先等 boot 的历史渲染落定，再开始分块断言。 */
  const bootRendered = await waitFor(() => stream.querySelectorAll('.msg').length > 0, 20000);
  await M.waitForClassicRenderIdle();
  await painted();
  if (!bootRendered) throw new Error('页面 boot 历史在 20s 内没有渲染，夹具不可信');
  const thread = () => stream.querySelector('.thread');
  const users = () => [...stream.querySelectorAll('.msg.user')];
  const counts = () => ({
    messages: stream.querySelectorAll('.msg').length,
    users: users().length,
    assistants: stream.querySelectorAll('.msg.assistant').length,
    toolGroups: stream.querySelectorAll('.tl-group').length,
    toolRows: stream.querySelectorAll('.tl-item').length,
    planCards: stream.querySelectorAll('.plan-card').length,
    thinking: stream.querySelectorAll('.think').length,
    subagents: stream.querySelectorAll('.tl-subagent-row').length,
    outcomes: stream.querySelectorAll('.turn-outcome').length,
    nav: N.navEntries().length,
    nodes: stream.querySelectorAll('*').length,
  });
  const orderOk = expected => {
    const list = users();
    return list.length === expected && list.every((node, index) => {
      const marker = '用户 ' + (index + 1) + '：';
      const id = 'user-' + (index + 1);
      return node.textContent.includes(marker) && node.dataset.anchorId === id;
    });
  };
  const atBottom = () => Math.abs(stream.scrollHeight - stream.clientHeight - stream.scrollTop) <= 2;

  const LONG_OUTPUT = ('npm run test:ui2 -- --grep case-77\n' +
    'ok 1 - reads the bounded projection\n' +
    'ok 2 - keeps scroll anchors stable\n' +
    'long output keeps the hidden detail pre filled with realistic text. '.repeat(24));
  const THINKING = '先确认边界：只读历史不启动会话；工具结果按真实顺序插入；任何裁剪都要显式说明。'.repeat(8);
  function makeMessages(prefix, { turns = 300, toolEvery = 8, planEvery = 25, subagentEvery = 60 } = {}) {
    const messages = [];
    let userIndex = 0, toolId = 0, planId = 0, subId = 0;
    const pushUser = i => messages.push({
      role: 'user', _id: `${prefix}-u${i}`, _userIndex: userIndex++,
      content: [text(`${prefix} 用户 ${i + 1}：请检查第 ${i + 1} 组实现边界与回归测试。` +
        ' Long English keeps the reading column stable and the markdown parser busy.')],
      timestamp: 1_700_000_000_000 + i * 1000,
    });
    const pushAssistantText = i => messages.push({
      role: 'assistant', usage: { input: 100 + i, output: 40 + i, totalTokens: 140 + i * 2 },
      content: [
        { type: 'thinking', thinking: THINKING },
        text(`${prefix} 助手 ${i + 1}：已核对模块边界、离线验证和异常处理。` +
          `**长中文**用于制造真实换行；inline code \`npm test\` 与列表：\n- 第一项\n- 第二项\n` +
          'Long English keeps the reading column stable.'),
      ],
      timestamp: 1_700_000_000_500 + i * 1000, stopReason: 'toolUse',
    });
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
        const plan = {
          version: 1,
          tasks: [
            { id: 'analyze', title: `分析第 ${i + 1} 组边界`, status: 'completed' },
            { id: 'implement', title: `实现第 ${i + 1} 组修复`, status: i % 2 ? 'completed' : 'in_progress' },
            { id: 'verify', title: `验证第 ${i + 1} 组回归`, status: 'pending' },
          ],
          explanation: '按真实工具输出驱动计划卡。', turnId: `${prefix}-turn-${i}`, revision: 1,
        };
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
    return { messages, userCount: userIndex };
  }

  const fixtureA = makeMessages('A');
  const fixtureB = makeMessages('B', { turns: 12 });
  const fixtureLong = makeMessages('L', { turns: 600 });
  const A = fixtureA.messages, B = fixtureB.messages, LONG = fixtureLong.messages;
  let fullLongNodes = 0;

  await check('1. 809+ 条消息首屏分块出现，结束后完整且顺序正确', async () => {
    M.rebuildFromMessages(A, 'p4d-long-A');
    const sync = counts();
    const partial = sync.users;
    const busyDuringMount = thread()?.getAttribute('aria-busy') || '';
    await M.waitForClassicRenderIdle();
    await painted();
    const full = counts();
    const busyAfter = thread()?.getAttribute('aria-busy') || '';
    const detail = { partial, full, busyDuringMount, busyAfter, syncBottom: atBottom(), first: users()[0]?.textContent.slice(0, 30), last: users().at(-1)?.textContent.slice(0, 30) };
    fullLongNodes = full.nodes;
    return {
      ok: partial > 0 && partial < 300 && full.users === 300 && full.assistants === 300 &&
        full.toolGroups >= 30 && full.toolRows >= 120 && full.planCards === 12 && full.thinking === 300 &&
        full.subagents > 0 && full.outcomes > 0 && full.nav === 300 && orderOk(300) &&
        atBottom() && busyDuringMount === 'true' && !busyAfter &&
        M.classicThreadSessionId() === 'p4d-long-A' && !stream.textContent.includes('B 用户'),
      ...detail,
    };
  });

  await check('2. 长历史阅读位置在分块重建后精确恢复', async () => {
    /* 入场动效有 3px 位移；书签契约是「静止布局位置」，这里按 reading-position
     * 的同一口径扣掉当前 transform，避免用动效相位差当作书签偏移。 */
    const layoutTop = node => {
      const rect = node.getBoundingClientRect();
      const transform = getComputedStyle(node).transform;
      return transform === 'none' ? rect.top : rect.top - new DOMMatrixReadOnly(transform).m42;
    };
    const target = users()[150];
    stream.scrollTop = Math.max(0, stream.scrollTop + target.getBoundingClientRect().top - stream.getBoundingClientRect().top - 40);
    await painted();
    M.saveClassicReadingPosition('p4d-long-A');
    const before = { top: layoutTop(target), scrollTop: stream.scrollTop };
    M.rebuildFromMessages(A, 'p4d-long-A');
    const partial = users().length;
    await M.waitForClassicRenderIdle();
    await painted();
    const afterTarget = users()[150];
    const delta = Math.abs(layoutTop(afterTarget) - before.top);
    const after = { top: layoutTop(afterTarget), scrollTop: stream.scrollTop, users: users().length };
    return { ok: partial < 300 && delta <= 1 && after.users === 300 && Math.abs(after.scrollTop - before.scrollTop) <= 2, partial, delta, before, after };
  });

  await check('3. Minimap/搜索跳转：有入场动画、无动画与底部边界都落到真实位置', async () => {
    M.rebuildFromMessages(A, 'p4d-long-A');
    await M.waitForClassicRenderIdle();
    await painted();

    const streamTop = () => stream.getBoundingClientRect().top;
    const maxScroll = () => Math.max(0, stream.scrollHeight - stream.clientHeight);
    const contentTopOf = node => node.getBoundingClientRect().top - streamTop() + stream.scrollTop;
    const riseShift = (node) => {
      const animation = node.getAnimations?.().find(item => item.animationName === 'ui2-rise-in');
      const progress = animation?.effect?.getComputedTiming?.().progress;
      return Number.isFinite(progress) ? 3 * (1 - Math.min(1, Math.max(0, progress))) : 0;
    };
    const currents = () => document.querySelectorAll('.cn-marker[aria-current="true"]').length;
    const preScrollBelow = async (node) => {
      const before = contentTopOf(node);
      stream.scrollTop = Math.max(0, Math.min(maxScroll(), before - 3000));
      await painted();
      return before;
    };
    const waitTop = index => waitFor(() => {
      const rect = users()[index].getBoundingClientRect();
      return Math.abs(rect.top - streamTop() - 20) <= 2;
    }, 5000);

    /* A. 有入场动画：注入一个确定、暂停在 0% 的 ui2-rise-in（translateY(3px)）。
     * 跳转时的缓存必须扣掉这 3px；若不做补偿，缓存会是 raw rect，随后差 3px。 */
    const animatedIndex = 150;
    const animatedTarget = users()[animatedIndex];
    animatedTarget.style.animationName = 'ui2-rise-in';
    animatedTarget.style.animationDuration = '10s';
    animatedTarget.style.animationTimingFunction = 'linear';
    animatedTarget.style.animationDelay = '0s';
    animatedTarget.style.animationFillMode = 'both';
    animatedTarget.style.animationPlayState = 'paused';
    await painted();
    const animatedShift = riseShift(animatedTarget);
    const animatedRawTop = await preScrollBelow(animatedTarget);
    const animatedStaticTop = animatedRawTop - animatedShift;
    N.scrollToUserTurn(animatedIndex);
    await painted();
    const animatedEntry = N.navEntries()[animatedIndex];
    const animatedCompensated = Math.abs(animatedEntry.topInContent - animatedStaticTop) <= 1;
    animatedTarget.getAnimations()
      .filter(item => item.animationName === 'ui2-rise-in')
      .forEach(item => item.finish());
    await painted();
    const animatedSettled = await waitTop(animatedIndex);
    await wait(250);
    const animatedActual = contentTopOf(animatedTarget);
    const animatedFinal = animatedTarget.getBoundingClientRect().top - streamTop();
    const animatedCurrent = N.currentNavIndex();
    const animatedCurrents = currents();
    animatedTarget.style.animationName = 'none';

    /* B. 无动画：关闭目标节点的入场动画，验证 riseInShift=0 时同样精确。 */
    const staticIndex = 200;
    const staticTarget = users()[staticIndex];
    staticTarget.style.animationName = 'none';
    await painted();
    const staticShift = riseShift(staticTarget);
    await preScrollBelow(staticTarget);
    N.scrollToUserTurn(staticIndex);
    const staticSettled = await waitTop(staticIndex);
    await wait(250);
    const staticEntry = N.navEntries()[staticIndex];
    const staticActual = contentTopOf(staticTarget);
    const staticFinal = staticTarget.getBoundingClientRect().top - streamTop();
    const staticCurrent = N.currentNavIndex();
    const staticCurrents = currents();

    /* C. 滚动边界：最后一条不可能贴到顶部 20px，落点必须等于可滚动上界的真实位置，
     * 不能为了凑 20px 而谎报成功。 */
    const last = users().length - 1;
    stream.scrollTop = 0;
    await painted();
    N.scrollToUserTurn(last);
    const boundaryClamped = await waitFor(() => Math.abs(stream.scrollTop - maxScroll()) <= 1, 5000);
    await wait(250);
    const boundaryActual = contentTopOf(users()[last]);
    const boundaryExpected = boundaryActual - maxScroll();
    const boundaryTop = users()[last].getBoundingClientRect().top - streamTop();
    const boundaryCurrent = N.currentNavIndex();
    const boundaryCurrents = currents();
    /* 贴底时最后一条仍在顶部判定带之下，当前项按产品语义是它前一条；
     * 用导航表复算期望值，避免把「最后一条」写死成当前项。 */
    const band = stream.scrollTop + stream.clientHeight * 0.1;
    let boundaryExpectedCurrent = 0;
    N.navEntries().forEach((entry, index) => { if (entry.topInContent <= band) boundaryExpectedCurrent = index; });
    const stageScroll = document.querySelector('.stage')?.scrollTop;

    return {
      ok: animatedShift >= 2.9 && animatedCompensated && animatedSettled &&
        Math.abs(animatedEntry.topInContent - animatedActual) <= 2 && Math.abs(animatedFinal - 20) <= 2 &&
        animatedCurrent === animatedIndex && animatedCurrents === 1 &&
        staticShift === 0 && staticSettled &&
        Math.abs(staticEntry.topInContent - staticActual) <= 2 && Math.abs(staticFinal - 20) <= 2 &&
        staticCurrent === staticIndex && staticCurrents === 1 &&
        boundaryClamped && boundaryExpected > 22 && Math.abs(boundaryTop - boundaryExpected) <= 2 &&
        boundaryCurrent === boundaryExpectedCurrent && boundaryCurrents === 1 && stageScroll === 0,
      animatedIndex, animatedShift, animatedCompensated, animatedSettled,
      animatedEntryTop: animatedEntry?.topInContent, animatedActual, animatedFinal, animatedCurrent, animatedCurrents,
      staticIndex, staticShift, staticSettled, staticEntryTop: staticEntry?.topInContent, staticActual, staticFinal,
      staticCurrent, staticCurrents,
      last, boundaryClamped, boundaryExpected, boundaryTop, boundaryCurrent, boundaryExpectedCurrent,
      boundaryCurrents, scrollTop: stream.scrollTop, maxScroll: maxScroll(), stageScroll, clientHeight: stream.clientHeight,
    };
  });

  await check('4. 分块挂载后 Thinking 与工具详情仍可展开/收起', async () => {
    const think = stream.querySelector('.think');
    const thinkHead = think.querySelector('.think-head');
    const thinkBody = think.querySelector('.think-body');
    const before = thinkHead.getAttribute('aria-expanded');
    thinkHead.click();
    await painted();
    const open = { expanded: thinkHead.getAttribute('aria-expanded'), hidden: thinkBody.hidden };
    thinkHead.click();
    await painted();
    const closed = { expanded: thinkHead.getAttribute('aria-expanded'), hidden: thinkBody.hidden };

    const group = [...stream.querySelectorAll('.tl-group')].find(node => node.querySelector('.tl-group-head:not([hidden])'));
    const head = group.querySelector('.tl-group-head');
    const list = group.querySelector('.tl-list');
    const groupBefore = head.getAttribute('aria-expanded');
    head.click();
    await painted();
    const groupClosed = { expanded: head.getAttribute('aria-expanded'), hidden: list.hidden };
    head.click();
    await painted();
    const groupOpen = { expanded: head.getAttribute('aria-expanded'), hidden: list.hidden };
    return {
      ok: before === 'false' && open.expanded === 'true' && open.hidden === false &&
        closed.expanded === 'false' && closed.hidden === true &&
        groupBefore === 'false' && groupClosed.expanded === 'true' && groupClosed.hidden === false &&
        groupOpen.expanded === 'false' && groupOpen.hidden === true,
      before, open, closed, groupBefore, groupClosed, groupOpen,
    };
  });

  await check('5. 分块渲染不丢历史：全选文本包含首尾消息', async () => {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(thread());
    selection.removeAllRanges();
    selection.addRange(range);
    const selected = selection.toString();
    selection.removeAllRanges();
    const detail = {
      length: selected.length,
      hasFirst: selected.includes('A 用户 1：'),
      hasLast: selected.includes('A 用户 300：'),
      hasAnswer: selected.includes('A 助手 300：'),
      hasPlan: selected.includes('分析第 1 组边界'),
      /* 折叠的 Thinking 正文按浏览器选区语义不进入复制文本；正文节点仍在 DOM
       * 里（展开即可复制），这里同时验证折叠标题与正文的存在。 */
      hasThinking: selected.includes('思考过程') &&
        stream.querySelector('.think-body')?.textContent.includes('只读历史不启动会话'),
    };
    return { ok: detail.length > 10000 && Object.values(detail).slice(1).every(Boolean), ...detail };
  });

  await check('6. 分块挂载期间用户滚动后不被贴底或旧书签覆盖', async () => {
    M.rebuildFromMessages(A, 'p4d-scroll-guard');
    const partial = users().length;
    stream.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    const topUser = users()[Math.max(0, users().length - 8)];
    const wanted = topUser.textContent;
    stream.scrollTop = Math.max(0, stream.scrollTop - Math.max(400, stream.clientHeight * 0.5));
    await painted();
    const before = { text: topUser.textContent, top: topUser.getBoundingClientRect().top, scrollTop: stream.scrollTop };
    await M.waitForClassicRenderIdle();
    await painted();
    const same = users().find(node => node.textContent === wanted);
    const bottomGap = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
    const after = { top: same?.getBoundingClientRect().top, scrollTop: stream.scrollTop, exists: Boolean(same) };

    /* 会话身份暂时缺失（rpc 的降级路径）时，用户滚动同样不能被收尾拉回底部。 */
    M.rebuildFromMessages(A, null);
    const nullPartial = users().length;
    stream.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    const nullTarget = users()[Math.max(0, users().length - 8)];
    const nullWanted = nullTarget.textContent;
    stream.scrollTop = Math.max(0, stream.scrollTop - Math.max(400, stream.clientHeight * 0.5));
    await painted();
    const nullBefore = nullTarget.getBoundingClientRect().top;
    await M.waitForClassicRenderIdle();
    await painted();
    const nullSame = users().find(node => node.textContent === nullWanted);
    const nullAfter = nullSame?.getBoundingClientRect().top;
    const nullGap = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
    return {
      ok: partial > 0 && partial < 300 && after.exists && Math.abs(after.top - before.top) <= 2 && bottomGap > 200 &&
        nullPartial > 0 && nullPartial < 300 && nullSame && Math.abs(nullAfter - nullBefore) <= 2 && nullGap > 200,
      partial, before, after, bottomGap, users: users().length,
      nullPartial, nullBefore, nullAfter, nullGap,
    };
  });

  await check('7. 快速切换时旧分块的迟到任务不写入新会话', async () => {
    M.rebuildFromMessages(A, 'p4d-stale-A');
    const stalePartial = users().length;
    M.rebuildFromMessages(B, 'p4d-stale-B');
    await M.waitForClassicRenderIdle();
    await painted();
    const onlyB = stream.textContent.includes('B 用户 1：') && !stream.textContent.includes('A 用户 1：');
    const detail = { stalePartial, users: users().length, nav: N.navEntries().length, id: M.classicThreadSessionId(), onlyB, nodes: stream.querySelectorAll('*').length };
    return { ok: stalePartial < 300 && detail.users === 12 && detail.nav === 12 && detail.id === 'p4d-stale-B' && onlyB, ...detail };
  });

  await check('8. 连续快速切换后最终会话完整且无重复/残留', async () => {
    const beforeNodes = counts().nodes;
    for (let i = 0; i < 8; i++) {
      M.rebuildFromMessages(i % 2 ? A : B, i % 2 ? 'p4d-rapid-A' : 'p4d-rapid-B');
      await wait(12);
    }
    M.rebuildFromMessages(A, 'p4d-rapid-final');
    await M.waitForClassicRenderIdle();
    await painted();
    const final = counts();
    const detail = { final, beforeNodes, order: orderOk(300), noB: !stream.textContent.includes('B 用户 1：'), id: M.classicThreadSessionId() };
    return {
      ok: final.users === 300 && final.nav === 300 && detail.order && detail.noB &&
        detail.id === 'p4d-rapid-final' && fullLongNodes > 0 && Math.abs(final.nodes - fullLongNodes) <= fullLongNodes * 0.02,
      ...detail,
    };
  });

  await check('9. Classic 清空/重建不触碰独立的 Runtime 输出', async () => {
    const runtimeOutput = document.createElement('div');
    runtimeOutput.className = 'rtc-output p4d-runtime-isolation';
    runtimeOutput.textContent = 'P4D-RUNTIME-ISOLATION';
    document.querySelector('.stage')?.append(runtimeOutput);
    M.rebuildFromMessages(B, 'p4d-isolation');
    await M.waitForClassicRenderIdle();
    await painted();
    const intact = runtimeOutput.textContent === 'P4D-RUNTIME-ISOLATION' && !thread().textContent.includes('P4D-RUNTIME-ISOLATION');
    runtimeOutput.remove();
    return { ok: intact && users().length === 12 && M.classicThreadSessionId() === 'p4d-isolation', intact, users: users().length, id: M.classicThreadSessionId() };
  });

  await check('10. 1643 条消息的更长会话同样完整挂载', async () => {
    M.rebuildFromMessages(LONG, 'p4d-longer');
    const partial = users().length;
    await M.waitForClassicRenderIdle();
    await painted();
    const full = counts();
    const order = orderOk(600);
    return {
      ok: partial > 0 && partial < 600 && full.users === 600 && full.nav === 600 && order &&
        atBottom() && M.classicThreadSessionId() === 'p4d-longer',
      partial, full, order, bottom: atBottom(), id: M.classicThreadSessionId(),
    };
  });

  await check('11. 挂载窗口内到达的实时消息排在完整历史之后', async () => {
    M.rebuildFromMessages(A, 'p4d-live-A');
    const partial = users().length;
    /* 真实入口：pi 的 message_start。挂载还在让出主线程时用户发送消息。 */
    M.onMessageStart({ message: { role: 'user', content: [{ type: 'text', text: 'A 实时插入：' }] } });
    const afterLive = users().length;
    const liveIndex = [...users()].findIndex(node => node.textContent.includes('A 实时插入：'));
    const liveAnchor = users()[liveIndex]?.dataset.anchorId;
    await M.waitForClassicRenderIdle();
    await painted();
    const all = users();
    const historyOrder = all.slice(0, 300).every((node, index) => node.textContent.includes(`A 用户 ${index + 1}：`));
    const liveLast = all[all.length - 1]?.textContent.includes('A 实时插入：');
    const gap = stream.scrollHeight - stream.scrollTop - stream.clientHeight;

    /* assistant 的 message_start 同样不能插进历史中间。 */
    M.rebuildFromMessages(A, 'p4d-live-B');
    const partialAssistant = users().length;
    M.onMessageStart({ message: { role: 'assistant', content: [] } });
    await M.waitForClassicRenderIdle();
    await painted();
    const fullUsers = users().length;
    const lastMessage = [...stream.querySelectorAll('.msg')].at(-1);
    const assistantLast = lastMessage?.classList.contains('assistant');

    /* 工具组与计划卡不走 ensureThread 也能 append 到 thread：
     * 两者都必须等历史挂完，否则会夹在半截历史中间。 */
    M.rebuildFromMessages(A, 'p4d-live-tools');
    const partialTool = users().length;
    T.onToolStart({ toolCallId: 'p4d-live-tool-1', toolName: 'read', args: { path: 'p4d-live.txt' } });
    const toolUsers = users().length;
    const toolLast = thread()?.lastElementChild?.classList.contains('tl-group');
    T.onToolEnd({ toolCallId: 'p4d-live-tool-1', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false });

    M.rebuildFromMessages(A, 'p4d-live-plan');
    const partialPlan = users().length;
    T.onToolStart({
      toolCallId: 'p4d-live-plan-1', toolName: 'gui_plan',
      args: {
        version: 1,
        tasks: [
          { id: 'one', title: '挂载窗口内的计划卡', status: 'in_progress' },
          { id: 'two', title: '完整历史之后再出现', status: 'pending' },
        ],
        turnId: 'p4d-live-turn', revision: 1,
      },
    });
    const planUsers = users().length;
    const planLast = thread()?.lastElementChild?.classList.contains('plan-card');

    return {
      ok: partial > 0 && partial < 300 && afterLive === 301 && liveIndex === 300 && liveLast &&
        historyOrder && liveAnchor === 'user-301' && gap <= 2 &&
        partialAssistant > 0 && partialAssistant < 300 && fullUsers === 300 && assistantLast &&
        partialTool > 0 && partialTool < 300 && toolUsers === 300 && toolLast &&
        partialPlan > 0 && partialPlan < 300 && planUsers === 300 && planLast,
      partial, afterLive, liveIndex, liveAnchor, historyOrder, liveLast, gap,
      partialAssistant, fullUsers, assistantLast,
      partialTool, toolUsers, toolLast, partialPlan, planUsers, planLast,
    };
  });

  await check('12. 取消分块挂载会清掉 aria-busy', async () => {
    M.rebuildFromMessages(A, 'p4d-busy');
    const partial = users().length;
    const during = thread()?.getAttribute('aria-busy');
    M.clearThread();
    const after = thread()?.getAttribute('aria-busy');
    await M.waitForClassicRenderIdle();
    return {
      ok: partial > 0 && partial < 300 && during === 'true' && !after && thread()?.childElementCount === 0,
      partial, during, after, children: thread()?.childElementCount,
    };
  });

  await check('13. 分块完成前 Minimap、搜索落点与书签都不消费半截历史', async () => {
    M.rebuildFromMessages(A, 'p4d-unready');
    const partial = users().length;
    const navDuring = N.navEntries().length;
    const searchDuring = N.scrollToUserTurn(0);
    const currentDuring = N.currentNavIndex();
    M.saveClassicReadingPosition('p4d-unready');
    const bookmarkDuring = R.hasSessionBookmark('p4d-unready');
    await M.waitForClassicRenderIdle();
    await painted();
    const navAfter = N.navEntries().length;
    const searchAfter = N.scrollToUserTurn(5);
    const searchSettled = await waitFor(() => {
      const top = users()[5].getBoundingClientRect().top - stream.getBoundingClientRect().top;
      return Math.abs(top - 20) <= 2 && N.currentNavIndex() === 5;
    }, 5000);
    await wait(250);
    const currentAfter = N.currentNavIndex();
    M.saveClassicReadingPosition('p4d-unready');
    const bookmarkAfter = R.hasSessionBookmark('p4d-unready');
    R.clearSessionBookmark('p4d-unready');
    return {
      ok: partial > 0 && partial < 300 && navDuring === 0 && searchDuring === false &&
        currentDuring === -1 && bookmarkDuring === false &&
        navAfter === 300 && searchAfter === true && searchSettled &&
        currentAfter === 5 && bookmarkAfter === true,
      partial, navDuring, searchDuring, currentDuring, bookmarkDuring, navAfter, searchAfter,
      searchSettled, currentAfter, bookmarkAfter,
    };
  });

  /* 后面的真实打印检查依赖完整长历史作为最终 DOM 状态。 */
  M.rebuildFromMessages(LONG, 'p4d-longer');
  await M.waitForClassicRenderIdle();
  await painted();

  return results;
}

(async () => {
  let harness, chrome, cdp;
  try {
    const started = await startHarness();
    harness = started.harness;
    const browser = await launchChrome();
    chrome = browser.chrome;
    cdp = await connect(browser.page);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: started.url });
    await sleep(2600);

    const evaluated = await cdp.send('Runtime.evaluate', {
      expression: `(${pageChecks.toString()})()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const results = evaluated.result?.result?.value;
    if (!Array.isArray(results)) {
      throw new Error('页面断言没有返回结果: ' + JSON.stringify(evaluated.result?.exceptionDetails || evaluated.result || evaluated).slice(0, 2000));
    }
    /* 真实打印：走 Chromium 打印管线，并确认打印媒体下完整历史仍在布局树里。
     * 应用没有专门的打印样式（滚动容器仍是固定视口），所以这里验证的是
     * 「打印不丢 DOM、不报错、能出文档」，不把分页样式当成 P4-D 的交付。 */
    try {
      const printStarted = Date.now();
      await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
      const printDom = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const stream = document.querySelector('#stream');
          const thread = stream?.querySelector('.thread');
          return {
            users: stream?.querySelectorAll('.msg.user').length || 0,
            nodes: stream?.querySelectorAll('*').length || 0,
            display: thread ? getComputedStyle(thread).display : 'missing',
            hidden: thread ? Boolean(thread.hidden) : true,
          };
        })()`,
        returnByValue: true,
      });
      const printed = await cdp.send('Page.printToPDF', { printBackground: false, preferCSSPageSize: false });
      await cdp.send('Emulation.setEmulatedMedia', { media: '' });
      const raw = Buffer.from(printed.result?.data || '', 'base64');
      const pdf = raw.toString('latin1');
      const pageObjects = (pdf.match(/\/Type\s*\/Page\b/g) || []).length;
      const pageCounts = (pdf.match(/\/Count\s+\d+/g) || []).slice(0, 4);
      const dom = printDom.result?.result?.value || {};
      results.push({
        name: '14. 打印管线可执行且打印媒体下完整历史仍在 DOM',
        ok: dom.users === 600 && dom.nodes > 10000 && dom.display !== 'none' && !dom.hidden && raw.length > 50000,
        detail: { bytes: raw.length, pageObjects, pageCounts, dom, ms: Date.now() - printStarted },
      });
    } catch (error) {
      results.push({ name: '14. 打印管线可执行且打印媒体下完整历史仍在 DOM', ok: false, error: String(error) });
    }
    for (const result of results) {
      console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name}`);
      if (!result.ok || process.env.P4D_VERBOSE) console.log('       ' + JSON.stringify(result.detail || result.error));
    }
    const failed = results.filter(result => !result.ok);
    if (cdp.pageErrors.length) console.log('page errors:', cdp.pageErrors);
    console.log(`P4-D classic: ${results.length - failed.length}/${results.length}`);
    if (failed.length) process.exitCode = 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    try { await cdp?.send('Browser.close'); } catch { /* ignore */ }
    chrome?.kill();
    harness?.kill();
  }
})();
