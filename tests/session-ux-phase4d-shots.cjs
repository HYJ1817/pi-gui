/* P4-D：长会话与 Runtime 历史定位提示的真实 Chromium 视觉验收。
 *
 * 用法：node tests/session-ux-phase4d-shots.cjs
 * 产物：docs/ui/session-ux-phase4d-evidence/shots/
 *
 * 只使用产品模块与产品 CSS：注入的是合成 fixture（不启 Pi、不读用户会话、
 * 不发网络请求）。覆盖 1320×820 与 700×600、深色与浅色，检查：
 *  - Classic 长会话完整挂载后的版式、Minimap 与横向溢出；
 *  - Runtime 历史命中被裁剪时的显式提示是否可见、可读、不溢出。
 */
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'ui', 'session-ux-phase4d-evidence', 'shots');
const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
];

function findBrowser() {
  if (process.env.UI2C_CHROME || process.env.CHROME_PATH) return process.env.UI2C_CHROME || process.env.CHROME_PATH;
  for (const candidate of BROWSER_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
  for (const [command, args] of process.platform === 'win32'
    ? [['where.exe', ['chrome.exe']], ['where.exe', ['msedge.exe']]]
    : [['which', ['google-chrome']], ['which', ['chromium']], ['which', ['microsoft-edge']]]) {
    try {
      const found = execFileSync(command, args, { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/).map(line => line.trim()).find(Boolean);
      if (found && fs.existsSync(found)) return found;
    } catch { /* not in path */ }
  }
  return null;
}

const CHROME = findBrowser();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startHarness() {
  const harness = spawn(process.execPath, [path.join(ROOT, 'tests', 'visual-harness.cjs')], {
    env: { ...process.env, HARNESS_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('夹具启动超时')), 15000);
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p4d-shots-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-background-networking', '--disable-default-apps',
    '--hide-scrollbars', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1320,820', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt++) {
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
  throw new Error('无法连接 Chrome DevTools');
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

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 900));
  return result.result?.result?.value;
}

async function pageSetup(cdp) {
  return evaluate(cdp, `(async () => {
    window.__surface = await import('/ui/workspace-surface.js');
    window.__S = (await import('/state.js')).S;
    window.__M = await import('/messages.js');
    window.__CN = await import('/conversation-nav.js');
    window.__RS = await import('/runtime-state.js');
    window.__RTC = await import('/runtime-conversation.js');
    window.__RT = await import('/runtime-timeline.js');
    Object.assign(__S, { hasProject: true, bridgeState: 'ready', streaming: false, stopping: false });

    const text = value => ({ type: 'text', text: value });
    const LONG_OUTPUT = ('npm run test:ui2 -- --grep case-77\\n' +
      'ok 1 - reads the bounded projection\\n' +
      'ok 2 - keeps scroll anchors stable\\n' +
      'long output keeps the hidden detail pre filled with realistic text. '.repeat(24));
    const THINKING = '先确认边界：只读历史不启动会话；工具结果按真实顺序插入；任何裁剪都要显式说明。'.repeat(8);
    const makeMessages = (prefix, { turns = 300, toolEvery = 8, planEvery = 25, subagentEvery = 60 } = {}) => {
      const messages = [];
      let userIndex = 0, toolId = 0, planId = 0, subId = 0;
      for (let i = 0; i < turns; i++) {
        messages.push({ role: 'user', _id: prefix + '-u' + i, _userIndex: userIndex++,
          content: [text(prefix + ' 用户 ' + (i + 1) + '：请检查第 ' + (i + 1) + ' 组实现边界与回归测试。' +
            ' Long English keeps the reading column stable and the markdown parser busy.')],
          timestamp: 1700000000000 + i * 1000 });
        messages.push({ role: 'assistant', usage: { input: 100 + i, output: 40 + i, totalTokens: 140 + i * 2 },
          content: [
            { type: 'thinking', thinking: THINKING },
            text(prefix + ' 助手 ' + (i + 1) + '：已核对模块边界、离线验证和异常处理。' +
              '**长中文**用于制造真实换行；inline code \`npm test\` 与列表：\\n- 第一项\\n- 第二项\\n' +
              'Long English keeps the reading column stable.'),
          ],
          timestamp: 1700000000500 + i * 1000, stopReason: 'toolUse' });
        if (i % toolEvery === 0) {
          const calls = [];
          for (let t = 0; t < 4; t++) {
            const id = prefix + '-call-' + (toolId++);
            calls.push({ type: 'toolCall', id, name: t % 2 ? 'bash' : 'read',
              arguments: { path: 'fixture-' + i + '-' + t + '.txt', command: 'npm run test:ui2 -- --grep case-' + i } });
          }
          messages.push({ role: 'assistant', usage: { input: 200, output: 90, totalTokens: 290 },
            content: calls, timestamp: 1700000000700 + i * 1000, stopReason: 'toolUse' });
          calls.forEach((call, t) => messages.push({
            role: 'toolResult', toolCallId: call.id, toolName: call.name,
            isError: t === 3 && i % 24 === 0, timestamp: 1700000000800 + i * 1000 + t,
            content: [text(prefix + ' result ' + i + '-' + t + ' ' + (t === 0 ? LONG_OUTPUT.repeat(2) : LONG_OUTPUT))],
          }));
        }
        if (i % planEvery === 0) {
          const id = prefix + '-plan-' + (planId++);
          const plan = { version: 1, tasks: [
            { id: 'analyze', title: '分析第 ' + (i + 1) + ' 组边界', status: 'completed' },
            { id: 'implement', title: '实现第 ' + (i + 1) + ' 组修复', status: i % 2 ? 'completed' : 'in_progress' },
            { id: 'verify', title: '验证第 ' + (i + 1) + ' 组回归', status: 'pending' },
          ], explanation: '按真实工具输出驱动计划卡。', turnId: prefix + '-turn-' + i, revision: 1 };
          messages.push({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'gui_plan', arguments: plan }],
            timestamp: 1700000000900 + i * 1000, stopReason: 'toolUse' });
          messages.push({ role: 'toolResult', toolCallId: id, toolName: 'gui_plan', isError: false,
            timestamp: 1700000000950 + i * 1000, content: [text('plan recorded')], details: plan });
        }
        if (i % subagentEvery === 0) {
          const runId = prefix + '-run-' + (subId++);
          const calls = [
            { type: 'toolCall', id: runId + '-a', name: 'subagent', arguments: { agent: 'reviewer', task: 'Review module boundaries' } },
            { type: 'toolCall', id: runId + '-b', name: 'subagent', arguments: { agent: 'tester', task: 'Run regression checks' } },
          ];
          messages.push({ role: 'assistant', content: calls, timestamp: 1700000000970 + i * 1000, stopReason: 'toolUse' });
          calls.forEach((call, n) => messages.push({
            role: 'toolResult', toolCallId: call.id, toolName: 'subagent', isError: false,
            timestamp: 1700000000980 + i * 1000 + n, content: [text('subagent done')],
            details: { mode: 'workflow', runId, workflowChildren: {
              version: 1, parentToolCallId: call.id, workflowRunId: runId, inventoryComplete: true,
              workflowState: 'completed', children: [
                { childId: 'review-ui', agent: 'custom-ui', state: 'completed', model: 'actual/ui' },
                { childId: 'review-api', agent: 'custom-api', state: 'completed', model: 'actual/api' },
                { childId: 'review-tests', agent: 'custom-tests', state: 'failed', model: 'actual/tests',
                  activity: { currentTool: 'bash', toolCount: 3, turnCount: 2, tokens: 1200, durationMs: 8000 } },
              ] } },
          }));
        }
      }
      return { messages, userCount: userIndex };
    };
    const fixture = makeMessages('S');
    window.__p4dShotFixture = fixture.messages;

    /* 对比度用 canvas 把任意合法 CSS 颜色落成 sRGB，避免 oklch()/color-mix() 解析不到。 */
    const paint = document.createElement('canvas');
    paint.width = paint.height = 1;
    const paintCtx = paint.getContext('2d', { willReadFrequently: true });
    const parseColor = value => {
      const raw = String(value || '').trim();
      if (!raw) return null;
      paintCtx.clearRect(0, 0, 1, 1);
      paintCtx.fillStyle = raw;
      paintCtx.fillRect(0, 0, 1, 1);
      const data = paintCtx.getImageData(0, 0, 1, 1).data;
      return [data[0], data[1], data[2], data[3] / 255];
    };
    const effectiveBackground = node => {
      const layers = [];
      for (let current = node; current; current = current.parentElement) {
        const color = parseColor(getComputedStyle(current).backgroundColor);
        if (!color || color[3] === 0) continue;
        layers.push(color);
        if (color[3] >= 0.999) break;
      }
      let result = [255, 255, 255];
      for (let i = layers.length - 1; i >= 0; i--) {
        const [r, g, b, a] = layers[i];
        result = [r * a + result[0] * (1 - a), g * a + result[1] * (1 - a), b * a + result[2] * (1 - a)];
      }
      return result;
    };
    const channel = value => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const luminance = rgb => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    window.__p4dContrast = node => {
      if (!node) return null;
      const fg = parseColor(getComputedStyle(node).color);
      const bg = effectiveBackground(node);
      if (!fg) return null;
      const blended = [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
      const a = luminance(blended), b = luminance(bg);
      return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
    };

    window.__p4dShot = {
      async classic(theme) {
        document.documentElement.dataset.theme = theme;
        __surface.showChat();
        await __M.waitForClassicRenderIdle();
        __M.rebuildFromMessages(window.__p4dShotFixture, 'p4d-shots');
        await __M.waitForClassicRenderIdle();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const stream = document.querySelector('#stream');
        stream.style.scrollBehavior = 'auto';
        const users = [...stream.querySelectorAll('.msg.user')];
        const target = users[150];
        stream.scrollTop = Math.max(0, stream.scrollTop + target.getBoundingClientRect().top
          - stream.getBoundingClientRect().top - 120);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const thread = stream.querySelector('.thread');
        const nav = document.querySelector('#convoNav');
        return {
          viewport: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme || '',
          users: users.length, navEntries: __CN.navEntries().length,
          navMarkers: nav?.querySelectorAll('.cn-marker').length || 0,
          navVisible: Boolean(nav && getComputedStyle(nav).display !== 'none' && nav.getClientRects().length),
          documentOverflow: document.documentElement.scrollWidth - innerWidth,
          streamOverflow: stream.scrollWidth - stream.clientWidth,
          threadOverflow: thread ? thread.scrollWidth - stream.clientWidth : null,
          streamWidth: Math.round(stream.clientWidth), threadWidth: Math.round(thread?.getBoundingClientRect().width || 0),
          userContrast: window.__p4dContrast(users[150]?.querySelector('.msg-body')),
          roleContrast: window.__p4dContrast(users[150]?.querySelector('.msg-role')),
        };
      },
      async runtime(theme) {
        document.documentElement.dataset.theme = theme;
        await __surface.showRuntimeConversation();
        const host = document.querySelector('#runtimeView');
        if (!window.__p4dShotView) {
          host.replaceChildren();
          window.__p4dShotView = __RTC.createRuntimeConversation({ host });
        }
        const view = window.__p4dShotView;
        __RS.runtimeStore.seed({ backendInstance: 'p4d-shots', items: [{
          conversationId: 'P4D-SHOT', createdAt: '2026-11-16T00:00:00.000Z',
          workspace: { branch: 'shots', projectId: 'project', workspaceId: 'ws-shot', workspaceEpoch: 'epoch' },
          owner: null, lifecycle: 'dormant', activity: 'idle', attention: false, nativeSessionId: 'native-shot',
        }] });
        const fixture = window.__p4dShotFixture;
        const metas = fixture.map(message => ({ messageId: message._id || null,
          userIndex: Number.isInteger(message._userIndex) ? message._userIndex : null }));
        const projection = __RT.timelineFromMessages(fixture, { messageMeta: metas });
        const firstUser = fixture.find(message => message.role === 'user');
        const locator = { conversationId: 'P4D-SHOT', nativeSessionId: 'native-shot',
          projectId: 'project', workspaceId: 'ws-shot', workspaceEpoch: 'epoch' };
        window.fetch = async input => {
          const url = String(input);
          if (url.includes('/api/runtime-sessions')) {
            return { status: 200, json: async () => ({ ok: true, locator,
              messages: fixture.map(message => ({ role: message.role, text: '' })), truncated: true,
              execution: { timeline: projection.blocks, truncated: projection.truncated,
                planBoundary: projection.planBoundary } }) };
          }
          return { status: 200, json: async () => ({ ok: true, backendInstance: 'p4d-shots', items: [] }) };
        };
        await view.openHistory(locator, { messageId: firstUser._id, userIndex: 0 });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const output = host.querySelector('.rtc-output');
        const notice = host.querySelector('.rtc-history-locate');
        return {
          viewport: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme || '',
          state: host.querySelector('.rtc-state')?.textContent || '',
          notice: notice?.textContent || '',
          noticeVisible: Boolean(notice && notice.getClientRects().length
            && getComputedStyle(notice).visibility !== 'hidden' && getComputedStyle(notice).display !== 'none'),
          noticeContrast: window.__p4dContrast(notice),
          noticeFontSize: getComputedStyle(notice).fontSize,
          scrolled: output?.querySelectorAll('[data-history-scrolled="true"]').length || 0,
          rows: output?.querySelectorAll('.rtc-history-message').length || 0,
          documentOverflow: document.documentElement.scrollWidth - innerWidth,
          outputOverflow: output ? output.scrollWidth - output.clientWidth : null,
        };
      },
    };
    return true;
  })()`);
}

async function main() {
  if (!CHROME) throw new Error('找不到可用的 Chromium 浏览器');
  fs.mkdirSync(OUT, { recursive: true });

  const { harness, url } = await startHarness();
  const { chrome, page } = await launchChrome();
  const cdp = await connect(page);
  console.log('夹具: ' + url);
  console.log('浏览器: ' + CHROME);

  const assertions = [];
  const metrics = [];
  const screenshots = [];
  const check = (name, pass, detail) => {
    assertions.push({ name, pass: Boolean(pass), detail });
    console.log((pass ? 'PASS ' : 'FAIL ') + name + (pass ? '' : ' ' + JSON.stringify(detail)));
  };
  const shot = async name => {
    await sleep(200);
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(result.result.data, 'base64'));
    screenshots.push({ name, file: path.relative(ROOT, file), bytes: fs.statSync(file).size });
    console.log('  截图: ' + name + '.png');
  };
  const setViewport = async (width, height) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(320);
  };

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    let ready = false;
    for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
      await cdp.send('Page.navigate', { url });
      for (let i = 0; i < 60; i++) {
        await sleep(200);
        const state = await evaluate(cdp, `({ ready: document.readyState, stream: !!document.querySelector('#stream'), thread: !!document.querySelector('.thread') })`).catch(() => null);
        if (state?.ready === 'complete' && state.stream && state.thread) { ready = true; break; }
      }
    }
    if (!ready) throw new Error('页面未就绪');
    await sleep(700);
    await pageSetup(cdp);
    await sleep(250);

    const viewports = [[1320, 820], [700, 600]];
    for (const [width, height] of viewports) {
      await setViewport(width, height);
      for (const theme of ['dark', 'light']) {
        const classic = await evaluate(cdp, `window.__p4dShot.classic(${JSON.stringify(theme)})`);
        metrics.push({ scene: 'classic', ...classic });
        check(`Classic ${width}×${height} ${theme}: 300 条提问完整，Minimap 按既有响应式规则${width > 900 ? '显示' : '隐藏'}`,
          classic.users === 300 && classic.navEntries === 300 && classic.navMarkers === 300
            && classic.navVisible === (width > 900), classic);
        check(`Classic ${width}×${height} ${theme}: 无横向溢出`,
          classic.documentOverflow <= 1 && classic.streamOverflow <= 1 && classic.threadOverflow <= 1, classic);
        check(`Classic ${width}×${height} ${theme}: 正文与角色标签对比度 ≥ 4.5`,
          classic.userContrast >= 4.5 && classic.roleContrast >= 4.5, classic);
        await shot(`classic-${width}x${height}-${theme}`);

        const runtime = await evaluate(cdp, `window.__p4dShot.runtime(${JSON.stringify(theme)})`);
        metrics.push({ scene: 'runtime-locate', ...runtime });
        check(`Runtime ${width}×${height} ${theme}: 裁剪命中给出显式提示`,
          runtime.noticeVisible && /已裁剪|无法定位/.test(runtime.notice) && runtime.scrolled === 0, runtime);
        check(`Runtime ${width}×${height} ${theme}: 提示可读且无横向溢出`,
          runtime.noticeContrast >= 4.5 && runtime.documentOverflow <= 1 && runtime.outputOverflow <= 1, runtime);
        await shot(`runtime-locate-${width}x${height}-${theme}`);

        await evaluate(cdp, `(async()=>{ (await import('/ui/workspace-surface.js')).showChat(); return true; })()`);
        await sleep(150);
      }
    }
  } finally {
    try { await cdp.send('Browser.close'); } catch { /* ignore */ }
    chrome.kill();
    harness.kill();
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    browser: CHROME,
    viewports: [[1320, 820], [700, 600]],
    themes: ['dark', 'light'],
    assertions,
    metrics,
    screenshots,
    pageErrors: cdp.pageErrors,
  };
  fs.writeFileSync(path.join(OUT, 'shots-summary.json'), JSON.stringify(summary, null, 2));
  const passed = assertions.filter(item => item.pass).length;
  console.log(`P4-D shots: ${passed}/${assertions.length}`);
  if (cdp.pageErrors.length) console.log('页面错误: ' + JSON.stringify(cdp.pageErrors));
  if (passed !== assertions.length) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
