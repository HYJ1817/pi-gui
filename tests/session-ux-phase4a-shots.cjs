/* 第四阶段 A 真实 Chromium/CDP 视觉、几何、键盘与可访问性验收。
 *
 * 用法：
 *   node tests/session-ux-phase4a-shots.cjs
 *   P4A_SHOT_LABEL=before VISUAL_PUBLIC_ROOT=<origin-main>/public node tests/session-ux-phase4a-shots.cjs
 *
 * - after 默认读取当前工作区的 public/；
 * - before 用同一脚本、同一份夹具，只把静态目录换成 origin/main 的 public/；
 * - 产物写到 docs/ui/session-ux-phase4a-evidence/<label>/。
 *
 * 不启动真 pi、不读用户会话；所有会话、子代理、工具、计划、usage 都是固定夹具。
 */
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LABEL = process.env.P4A_SHOT_LABEL || 'after';
const OUT = path.join(ROOT, 'docs', 'ui', 'session-ux-phase4a-evidence', LABEL);

const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

function findBrowser() {
  const explicit = process.env.UI2C_CHROME || process.env.CHROME_PATH;
  if (explicit) return explicit;
  for (const candidate of BROWSER_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
  const commands = process.platform === 'win32'
    ? [['where.exe', ['chrome.exe']], ['where.exe', ['msedge.exe']]]
    : [['which', ['google-chrome']], ['which', ['chromium']], ['which', ['microsoft-edge']]];
  for (const [command, args] of commands) {
    try {
      const found = execFileSync(command, args, { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (found && fs.existsSync(found)) return found;
    } catch { /* not in path */ }
  }
  return null;
}

const CHROME = findBrowser();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launchCdpBrowser() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ux-p4a-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-sync', '--disable-component-update',
    '--disable-background-networking', '--disable-default-apps', '--metrics-recording-only',
    '--hide-scrollbars', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--window-size=1320,820', 'about:blank',
  ];
  const chrome = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 75; i++) {
    if (!port) {
      try {
        const first = fs.readFileSync(portFile, 'utf8').split(/\r?\n/, 1)[0];
        const parsed = Number(first);
        if (Number.isInteger(parsed) && parsed > 0) port = parsed;
      } catch { /* waiting */ }
    }
    if (port) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = targets.find((target) => target.type === 'page');
        if (page) return { chrome, page, profile, port };
      } catch { /* waiting */ }
    }
    await sleep(200);
  }
  throw new Error('无法连接 Chrome DevTools');
}

async function main() {
  if (!CHROME) throw new Error('找不到可用的 Chromium 浏览器');
  fs.mkdirSync(OUT, { recursive: true });

  const harness = spawn(process.execPath, [path.join(ROOT, 'tests', 'visual-harness.cjs')], {
    env: { ...process.env, HARNESS_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('夹具启动超时')), 15000);
    harness.stdout.on('data', (chunk) => {
      buf += String(chunk);
      const match = buf.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}/`); }
    });
    harness.on('exit', (code) => { clearTimeout(timer); reject(new Error('夹具退出 ' + code)); });
  });
  console.log('夹具运行在: ' + url);
  console.log('启动浏览器: ' + CHROME);
  console.log('静态目录: ' + (process.env.VISUAL_PUBLIC_ROOT || path.join(ROOT, 'public')));

  const { chrome, page, profile, port } = await launchCdpBrowser();
  console.log('CDP 端口: ' + port);

  let send = null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    const pending = new Map();
    let idc = 0;
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    };
    send = (method, params = {}) => new Promise((resolveSend) => {
      const id = ++idc;
      pending.set(id, resolveSend);
      ws.send(JSON.stringify({ id, method, params }));
    });
  });

  const evalJs = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 500));
    return result.result?.result?.value;
  };
  const shot = async (name) => {
    await sleep(180);
    const result = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(result.result.data, 'base64'));
    console.log('  截图: ' + name + '.png');
  };
  const setTheme = async (theme) => {
    await evalJs(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; true`);
    await sleep(120);
  };
  const setViewport = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(180);
  };
  const metrics = [];
  const assertions = [];
  const recordMetrics = (name, value) => {
    metrics.push({ name, ...value });
    console.log('  测量: ' + name + ' ' + JSON.stringify(value));
  };
  const check = (name, pass, detail) => {
    assertions.push({ name, pass: Boolean(pass), detail });
    if (!pass) console.log('  断言失败: ' + name + ' ' + JSON.stringify(detail));
  };
  const scrollTo = async (selector, block = 'center') => {
    await evalJs(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('缺少节点: ' + ${JSON.stringify(selector)});
      node.scrollIntoView({ block: ${JSON.stringify(block)}, inline: 'nearest' });
      return true;
    })()`);
    await sleep(220);
  };
  const expandAll = async () => {
    await evalJs(`(() => {
      for (const group of document.querySelectorAll('#stream .tl-group')) {
        const head = group.querySelector('.tl-group-head');
        if (head && !head.hidden && head.getAttribute('aria-expanded') === 'false') head.click();
      }
      for (const toggle of document.querySelectorAll('#stream .tl-toggle')) {
        if (!toggle.hidden && toggle.getAttribute('aria-expanded') === 'false') toggle.click();
      }
      return true;
    })()`);
    await sleep(260);
  };
  const navigateAndWait = async (target) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const navigated = await send('Page.navigate', { url: target });
      if (navigated.result?.errorText) console.log('  导航尝试 ' + attempt + ' 失败: ' + navigated.result.errorText);
      for (let i = 0; i < 50; i++) {
        await sleep(200);
        const state = await evalJs(`({ href: location.href, ready: document.readyState,
          stream: !!document.querySelector('#stream') })`).catch(() => null);
        if (state?.href?.startsWith('http') && state.stream) return state;
        if (state?.href?.startsWith('chrome-error')) break;
      }
      console.log('  导航尝试 ' + attempt + ' 未到达应用页，重试');
      await sleep(500);
    }
    throw new Error('无法打开夹具页面: ' + target);
  };
  const summarizeAx = async () => {
    const ax = await send('Accessibility.getFullAXTree', {});
    const nodes = ax.result?.nodes || [];
    const pick = (role) => nodes.filter((node) => node.role?.value === role).map((node) => ({
      role: node.role?.value,
      name: node.name?.value?.slice(0, 180) || '',
      expanded: node.properties?.find((property) => property.name === 'expanded')?.value?.value,
    }));
    return {
      counts: {
        log: pick('log').length, status: pick('status').length, alert: pick('alert').length,
        button: pick('button').length, list: pick('list').length, listitem: pick('listitem').length,
        disclosure: pick('DisclosureTriangle').length,
      },
      lists: pick('list').slice(0, 8),
      listitems: pick('listitem').slice(0, 24),
      buttons: pick('button').filter((node) => /子代理|收起|展开|工具调用/.test(node.name)).slice(0, 24),
    };
  };

  /* 先探测当前静态目录是否真的有 P4-A 结构化投影；before 基线必须为 false，
   * after 必须为 true。这样同一脚本不会把旧代码误当成新实现。 */
  const hasCards = await (async () => {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');
    await send('Accessibility.enable');
    await navigateAndWait(url);
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      if (await evalJs(`!!document.querySelector('#stream') && !!document.querySelector('.thread')`).catch(() => false)) break;
    }
    await sleep(700);
    return evalJs(`(async () => {
      try {
        const m = await import('/subagent-activity.js');
        const p = m.subagentActivity({ id: 'probe', name: 'subagent', status: 'success', args: {},
          details: { runId: 'probe-run', results: [{ index: 0, agent: 'probe', exitCode: 0 }] } });
        return Boolean(p && p.subagents && Array.isArray(p.subagents.rows) && p.subagents.rows.length);
      } catch (error) { return 'error: ' + error.message; }
    })()`);
  })();
  console.log('P4-A 结构化投影: ' + hasCards);
  check('probe', hasCards === (LABEL !== 'before'), { label: LABEL, hasCards });

  try {
    await evalJs(`(async () => {
      window.__surface = await import('/ui/workspace-surface.js');
      window.__S = (await import('/state.js')).S;
      window.__M = await import('/messages.js');
      window.__T = await import('/tools.js');
      window.__RS = await import('/runtime-state.js');
      window.__RTC = await import('/runtime-conversation.js');
      Object.assign(__S, { hasProject: true, bridgeState: 'ready', streaming: false, stopping: false });
      __surface.showChat();
      return true;
    })()`);
    await sleep(200);

    /* ---------- 1. Classic 固定夹具 ---------- */
    console.log('\n--- Classic 夹具 ---');
    await evalJs(`(async () => {
      const text = value => ({ type: 'text', text: value });
      const usage = { input: 12345, output: 6789, cacheRead: 4321, cacheWrite: 2345,
        cacheWrite1h: 1200, reasoning: 98765, totalTokens: 1234567, cost: { total: 0.1234 } };
      const singleRun = {
        mode: 'single', runId: 'p4a-single-run',
        results: [{
          index: 0, agent: 'reviewer-模块边界-中文长名称', task: '核对子代理卡片的身份绑定与安全投影',
          model: 'provider/model-alpha-2026-11-16', exitCode: 0,
          progress: { currentTool: 'read', toolCount: 6, turnCount: 3, tokens: 12840, durationMs: 12400 },
        }],
      };
      const workflowRun = {
        mode: 'workflow', runId: 'p4a-wf-run', results: [],
        workflowChildren: {
          version: 1, parentToolCallId: 'p4a-history-wf', workflowRunId: 'p4a-wf-run',
          inventoryComplete: true, workflowState: 'completed',
          children: [
            { childId: 'ui', agent: 'reviewer-ui-中文-长名称-用于窄屏换行', model: 'provider/model-with-a-very-long-name-2026-11-16-alpha', state: 'completed',
              activity: { toolCount: 8, turnCount: 4, tokens: 32000, durationMs: 45000, currentTool: 'read' } },
            { childId: 'api', agent: 'reviewer-api', model: 'provider/model-beta', state: 'failed' },
            { childId: 'docs', agent: 'writer-docs', model: 'provider/model-gamma', state: 'completed',
              activity: { toolCount: 3, turnCount: 2, tokens: 5000, durationMs: 9000 } },
          ],
        },
      };
      const planTasks = [
        { id: 'parent', title: '保留父工具行生命周期与用户折叠选择', status: 'completed' },
        { id: 'cards', title: '展开后显示单列子代理卡片并验证并行、多模型与混合终态', status: 'completed' },
        { id: 'verify', title: '在 1320×820 与 700×600 的深浅主题下检查无横向溢出和父组锚点', status: 'in_progress' },
      ];
      const messages = [
        { role: 'user', content: [text('P4-A 视觉验收：同一回合包含同步子代理、并行 workflow、后台启动、计划与普通工具。Please keep long English names readable at 700px.')] },
        { role: 'assistant', content: [text('先展示已完成的同步委派。')] },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'p4a-history-single', name: 'subagent', arguments: {
          agent: 'reviewer-模块边界-中文长名称', task: '核对子代理卡片的身份绑定与安全投影', env: 'SECRET_ENV' } }] },
        { role: 'toolResult', toolCallId: 'p4a-history-single', toolName: 'subagent', content: [], details: singleRun },
        { role: 'assistant', content: [text('再展示已完成的并行 workflow，包含成功、失败与长名称。')] },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'p4a-history-wf', name: 'subagent', arguments: {
          workflowScript: 'PRIVATE_SCRIPT_PATH', token: 'PRIVATE_TOKEN' } }] },
        { role: 'toolResult', toolCallId: 'p4a-history-wf', toolName: 'subagent', content: [], details: workflowRun },
        { role: 'assistant', content: [text('后台启动与扩展启用只保留安全 facts，不生成子项卡片。')] },
        { role: 'assistant', content: [
          { type: 'toolCall', id: 'p4a-history-bg', name: 'subagent', arguments: { agent: 'background-worker', task: '独立后台任务', async: true } },
          { type: 'toolCall', id: 'p4a-history-enable', name: 'subagents_enable', arguments: {} },
        ] },
        { role: 'toolResult', toolCallId: 'p4a-history-bg', toolName: 'subagent', content: [],
          details: { mode: 'single', runId: 'p4a-bg-run', asyncId: 'p4a-bg-run', results: [] } },
        { role: 'toolResult', toolCallId: 'p4a-history-enable', toolName: 'subagents_enable', content: [],
          details: { enabled: ['subagent'] } },
        { role: 'assistant', usage, content: [text('普通工具、Thinking、用量和计划卡用于 P1–P3 回归。')] },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: '先核对现有工具行与折叠契约，再验证子项身份和窄屏换行。' },
          { type: 'text', text: '读取规范与实现，确认父行生命周期没有被卡片替换。' },
        ], usage },
        { role: 'assistant', content: [
          { type: 'toolCall', id: 'p4a-read-1', name: 'read', arguments: { path: 'docs/subagents.md' } },
          { type: 'toolCall', id: 'p4a-read-2', name: 'read', arguments: { path: 'public/tool-view.js' } },
          { type: 'toolCall', id: 'p4a-plan', name: 'gui_plan', arguments: { version: 1, tasks: planTasks } },
        ] },
        { role: 'toolResult', toolCallId: 'p4a-read-1', toolName: 'read', content: [text('ok')] },
        { role: 'toolResult', toolCallId: 'p4a-read-2', toolName: 'read', content: [text('ok')] },
        { role: 'toolResult', toolCallId: 'p4a-plan', toolName: 'gui_plan', content: [],
          details: { version: 1, tasks: planTasks } },
      ];
      __M.rebuildFromMessages(messages, 'p4a-classic');

      const question = { role: 'user', content: [text('实时并行 workflow：运行中、成功、失败同时出现。')] };
      const liveRunning = {
        mode: 'workflow', runId: 'p4a-live-run', results: [],
        workflowChildren: {
          version: 1, parentToolCallId: 'p4a-live', workflowRunId: 'p4a-live-run',
          inventoryComplete: true, workflowState: 'running',
          children: [
            { childId: 'live-ui', agent: 'reviewer-live-ui-中文-长名称-用于窄屏换行', model: 'provider/model-live-ui-very-long-name',
              state: 'completed', activity: { toolCount: 4, turnCount: 2, tokens: 8000, durationMs: 1800, currentTool: 'read' } },
            { childId: 'live-api', agent: 'reviewer-live-api', model: 'provider/model-live-api',
              state: 'running', activity: { toolCount: 1, turnCount: 1, tokens: 1200, durationMs: 1200, currentTool: 'bash' } },
            { childId: 'live-edge', agent: 'reviewer-live-edge', state: 'failed' },
          ],
        },
      };
      const liveRunningNext = JSON.parse(JSON.stringify(liveRunning));
      liveRunningNext.workflowChildren.children[1].activity.toolCount = 2;
      liveRunningNext.workflowChildren.children[1].activity.tokens = 2400;
      const liveEnded = JSON.parse(JSON.stringify(liveRunning));
      liveEnded.workflowChildren.children[1].state = 'failed';
      liveEnded.workflowChildren.children[2].state = 'completed';
      liveEnded.workflowChildren.workflowState = 'failed';

      window.__p4a = { liveRunning, liveRunningNext, liveEnded };
      __M.onMessageStart({ message: question });
      __M.onMessageStart({ message: { role: 'assistant', content: [] } });
      __M.onMessageEnd({ message: { role: 'assistant', stopReason: 'stop',
        content: [text('先启动并行 workflow，子项完成后回报真实结果。')] } });
      __T.onToolStart({ toolCallId: 'p4a-live', toolName: 'subagent', args: { workflowScript: 'PRIVATE_LIVE_SCRIPT' } });
      __T.onToolUpdate({ toolCallId: 'p4a-live', partialResult: { content: [], details: liveRunning } });
      __M.onMessageStart({ message: { role: 'user',
        content: [text('继续观察实时状态；这条消息只用于滚动锚点与 Composer 布局验收。')] } });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    })()`);
    await sleep(500);
    await expandAll();

    recordMetrics('fixture', await evalJs(`(() => {
      const stream = document.querySelector('#stream');
      const normalGroup = document.querySelector('#stream .tl-item[data-id="p4a-read-1"]')?.closest('.tl-group');
      return {
        hasCards: ${JSON.stringify(hasCards)},
        planCards: document.querySelectorAll('#stream .plan-card').length,
        planToolRows: document.querySelectorAll('#stream .tl-item[data-id="p4a-plan"]').length,
        guiPlanRows: document.querySelectorAll('#stream .tl-item[data-id^="p4a-plan"]').length,
        normalGroupChildren: normalGroup ? normalGroup.querySelectorAll('.tl-item').length : 0,
        thinkingBlocks: document.querySelectorAll('#stream .think').length,
        usageButtons: document.querySelectorAll('#stream .msg.assistant .message-usage').length,
        toolGroups: document.querySelectorAll('#stream .tl-group').length,
        subagentCards: document.querySelectorAll('#stream .tl-subagent').length,
        subagentRows: document.querySelectorAll('#stream .tl-subagent-row').length,
        hiddenRawMarkers: {
          secretEnv: stream.textContent.includes('SECRET_ENV'),
          privateScript: stream.textContent.includes('PRIVATE_SCRIPT_PATH'),
          privateToken: stream.textContent.includes('PRIVATE_TOKEN'),
          privateLive: stream.textContent.includes('PRIVATE_LIVE_SCRIPT'),
        },
      };
    })()`));

    const fixture = metrics.find((item) => item.name === 'fixture');
    check('plan-card-once', fixture.planCards === 1, fixture);
    check('plan-not-tool-row', fixture.planToolRows === 0, fixture);
    check('normal-group-2', fixture.normalGroupChildren === 2, fixture);
    check('thinking-present', fixture.thinkingBlocks === 1, fixture);
    check('usage-present', fixture.usageButtons >= 1, fixture);
    check('raw-args-absent', Object.values(fixture.hiddenRawMarkers).every((value) => value === false), fixture.hiddenRawMarkers);
    if (LABEL === 'before') {
      check('before-no-card', fixture.subagentCards === 0 && fixture.subagentRows === 0, fixture);
    } else {
      check('after-cards', fixture.subagentCards >= 2 && fixture.subagentRows >= 4, fixture);
    }

    await setTheme('dark');
    await setViewport(1320, 820);
    await scrollTo('[data-id="p4a-history-single"]');
    await shot('01-classic-history-dark-1320');
    await scrollTo('[data-id="p4a-history-wf"]');
    await shot('02-classic-workflow-dark-1320');
    await scrollTo('#stream .plan-card');
    await shot('02b-classic-plan-dark-1320');

    recordMetrics('wide-history', await evalJs(`(() => {
      const q = selector => document.querySelector(selector);
      const qa = selector => [...document.querySelectorAll(selector)];
      const rect = node => node ? node.getBoundingClientRect().toJSON() : null;
      const style = (node, props) => {
        if (!node) return null;
        const cs = getComputedStyle(node); const out = {};
        for (const prop of props) out[prop] = cs[prop];
        return out;
      };
      const stream = q('#stream');
      const single = q('[data-id="p4a-history-single"]');
      const workflow = q('[data-id="p4a-history-wf"]');
      const singleToggle = single?.querySelector('.tl-toggle');
      const workflowToggle = workflow?.querySelector('.tl-toggle');
      let collapsedHeight = null;
      if (singleToggle) {
        const was = singleToggle.getAttribute('aria-expanded');
        if (was === 'true') singleToggle.click();
        collapsedHeight = single?.getBoundingClientRect().height ?? null;
        if (was === 'true') singleToggle.click();
      }
      const firstRow = q('[data-id="p4a-history-wf"] .tl-subagent-row');
      const line = firstRow?.querySelector('.tl-subagent-line');
      const agent = firstRow?.querySelector('.tl-subagent-agent');
      const state = firstRow?.querySelector('.tl-subagent-state');
      const model = firstRow?.querySelector('.tl-subagent-model');
      const tops = [agent, state, model].filter(Boolean).map(node => node.getBoundingClientRect().top);
      return {
        viewport: [innerWidth, innerHeight],
        overflow: { document: document.documentElement.scrollWidth - innerWidth, stream: stream.scrollWidth - stream.clientWidth },
        parent: {
          headHeight: single?.querySelector('.tl-head')?.getBoundingClientRect().height ?? null,
          metaHeight: single?.querySelector('.tl-subagent-meta')?.getBoundingClientRect().height ?? null,
          collapsedHeight,
          expandedHeight: single?.getBoundingClientRect().height ?? null,
          metaText: single?.querySelector('.tl-subagent-meta')?.textContent || '',
          metaVisible: single?.querySelector('.tl-subagent-meta')?.hidden === false,
          listRole: single?.querySelector('.tl-subagents')?.getAttribute('role') || null,
          listLabel: single?.querySelector('.tl-subagents')?.getAttribute('aria-label') || null,
          toggleText: singleToggle?.textContent || '',
          toggleExpanded: singleToggle?.getAttribute('aria-expanded') || null,
          controls: singleToggle?.getAttribute('aria-controls') || null,
          controlsExists: Boolean(singleToggle && document.getElementById(singleToggle.getAttribute('aria-controls') || '')),
          controlsInside: Boolean(singleToggle && document.getElementById(singleToggle.getAttribute('aria-controls') || '')?.closest('.tl-item') === single),
          stopButtons: single ? single.querySelectorAll('button').length : 0,
          moreSections: (() => {
            const more = single?.querySelector('.tl-more');
            return more ? [...more.children].map(node => ({
              tag: node.tagName,
              cls: node.className,
              hidden: node.hidden === true,
              display: getComputedStyle(node).display,
              height: node.getBoundingClientRect().height,
              text: (node.textContent || '').slice(0, 24),
            })) : [];
          })(),
        },
        workflow: {
          summary: workflow?.querySelector('.tl-subagent-meta')?.textContent || '',
          rows: workflow?.querySelectorAll('.tl-subagent-row').length || 0,
          states: qa('[data-id="p4a-history-wf"] .tl-subagent-row').map(node => node.dataset.state),
          agents: qa('[data-id="p4a-history-wf"] .tl-subagent-agent').map(node => node.textContent),
          models: qa('[data-id="p4a-history-wf"] .tl-subagent-model').map(node => node.textContent),
          tasks: qa('[data-id="p4a-history-wf"] .tl-subagent-task').map(node => node.textContent),
          toggleText: workflowToggle?.textContent || '',
          rowText: workflow?.textContent || '',
        },
        wideLine: {
          tops,
          maxDelta: tops.length ? Math.max(...tops) - Math.min(...tops) : null,
          lineRect: line?.getBoundingClientRect().toJSON() ?? null,
          agentRect: agent?.getBoundingClientRect().toJSON() ?? null,
          stateRect: state?.getBoundingClientRect().toJSON() ?? null,
          modelRect: model?.getBoundingClientRect().toJSON() ?? null,
          lineHeight: line?.getBoundingClientRect().height ?? null,
          modelWidth: model?.getBoundingClientRect().width ?? null,
          modelScrollWidth: model?.scrollWidth ?? null,
          modelStyle: style(model, ['whiteSpace', 'textOverflow', 'overflow', 'fontSize', 'color']),
          agentStyle: style(agent, ['fontSize', 'color', 'overflowWrap']),
          stateStyle: style(state, ['fontSize', 'color', 'whiteSpace']),
          stateColors: qa('[data-id="p4a-history-wf"] .tl-subagent-row').map(node => ({
            state: node.dataset.state,
            color: getComputedStyle(node.querySelector('.tl-subagent-state')).color,
          })),
          listStyle: style(workflow?.querySelector('.tl-subagents'), ['overflow', 'overflowY', 'maxHeight']),
          listScroll: workflow?.querySelector('.tl-subagents')
            ? { height: workflow.querySelector('.tl-subagents').clientHeight, scrollHeight: workflow.querySelector('.tl-subagents').scrollHeight }
            : null,
        },
      };
    })()`));

    const wide = metrics.find((item) => item.name === 'wide-history');
    check('wide-no-overflow', wide.overflow.document === 0 && wide.overflow.stream === 0, wide.overflow);
    check('wide-parent-compact', wide.parent.headHeight > 0 && wide.parent.headHeight <= 28, wide.parent);
    if (LABEL === 'before') {
      check('before-no-metas', wide.parent.metaText === '' && wide.workflow.rows === 0, wide);
    } else {
      check('after-parent-meta', /子代理 · 1 项/.test(wide.parent.metaText) && wide.parent.metaVisible, wide.parent);
      check('after-aria-controls', wide.parent.toggleExpanded === 'true' && wide.parent.controlsExists && wide.parent.controlsInside, wide.parent);
      check('after-list-role', wide.parent.listRole === 'list' && wide.parent.listLabel === '子代理', wide.parent);
      check('after-three-children', wide.workflow.rows === 3 && wide.workflow.states.join(',') === 'completed,failed,completed', wide.workflow);
      check('after-wide-one-line', wide.wideLine.maxDelta != null && wide.wideLine.maxDelta <= 5
        && wide.wideLine.modelRect && wide.wideLine.agentRect
        && wide.wideLine.modelRect.top < wide.wideLine.agentRect.bottom, wide.wideLine);
      check('after-no-child-stop', wide.parent.stopButtons === 1, wide.parent);
      check('after-no-scroll-area', wide.wideLine.listScroll && wide.wideLine.listScroll.scrollHeight <= wide.wideLine.listScroll.height + 1, wide.wideLine);
    }

    /* 实时运行中 */
    await scrollTo('[data-id="p4a-live"]');
    await shot('03-classic-live-running-dark-1320');
    recordMetrics('wide-live-running', await evalJs(`(() => {
      const row = document.querySelector('[data-id="p4a-live"]');
      const toggle = row?.querySelector('.tl-toggle');
      return {
        parentStatus: row?.querySelector('.tl-status')?.textContent || '',
        label: row?.querySelector('.tl-label')?.textContent || '',
        summary: row?.querySelector('.tl-subagent-meta')?.textContent || '',
        rows: [...row.querySelectorAll('.tl-subagent-row')].map(node => ({
          state: node.dataset.state,
          text: node.textContent,
        })),
        toggleExpanded: toggle?.getAttribute('aria-expanded') || null,
      };
    })()`));
    const liveRunning = metrics.find((item) => item.name === 'wide-live-running');

    /* 用户主动折叠实时卡片；再来一次更新，折叠选择必须保持。 */
    await evalJs(`(() => {
      const toggle = document.querySelector('[data-id="p4a-live"] .tl-toggle');
      if (toggle && toggle.getAttribute('aria-expanded') === 'true') toggle.click();
      return true;
    })()`);
    await sleep(160);
    const collapsePriority = await evalJs(`(() => {
      const toggle = document.querySelector('[data-id="p4a-live"] .tl-toggle');
      const before = { expanded: toggle?.getAttribute('aria-expanded'), hidden: document.querySelector('[data-id="p4a-live"] .tl-more')?.hidden };
      __T.onToolUpdate({ toolCallId: 'p4a-live', partialResult: { content: [], details: window.__p4a.liveRunningNext } });
      const after = { expanded: toggle?.getAttribute('aria-expanded'), hidden: document.querySelector('[data-id="p4a-live"] .tl-more')?.hidden };
      return { before, after };
    })()`);
    await sleep(220);
    recordMetrics('collapse-priority', collapsePriority);
    if (LABEL !== 'before') {
      check('user-collapse-priority', collapsePriority.before.expanded === 'false' && collapsePriority.after.expanded === 'false'
        && collapsePriority.after.hidden === true, collapsePriority);
    }

    /* 父组折叠也不能被工具更新覆盖。 */
    const groupPriority = await evalJs(`(() => {
      const row = document.querySelector('[data-id="p4a-live"]');
      const group = row?.closest('.tl-group');
      const head = group?.querySelector('.tl-group-head');
      const list = group?.querySelector('.tl-list');
      if (!head || !list) return { error: 'no group' };
      if (head.getAttribute('aria-expanded') === 'true') head.click();
      const before = { expanded: head.getAttribute('aria-expanded'), hidden: list.hidden };
      __T.onToolUpdate({ toolCallId: 'p4a-live', partialResult: { content: [], details: window.__p4a.liveRunningNext } });
      const after = { expanded: head.getAttribute('aria-expanded'), hidden: list.hidden };
      if (head.getAttribute('aria-expanded') === 'false') head.click();
      return { before, after };
    })()`);
    await sleep(220);
    recordMetrics('group-priority', groupPriority);
    if (LABEL !== 'before') {
      check('parent-group-collapse-priority', groupPriority.before.expanded === 'false'
        && groupPriority.after.expanded === 'false' && groupPriority.after.hidden === true, groupPriority);
    }

    await expandAll();
    await evalJs(`(() => {
      const toggle = document.querySelector('[data-id="p4a-live"] .tl-toggle');
      if (toggle && toggle.getAttribute('aria-expanded') === 'false') toggle.click();
      return true;
    })()`);
    await sleep(200);

    /* 终态更新：同一父行只更新状态与子项，不新增卡片。 */
    await evalJs(`(() => {
      __T.onToolEnd({ toolCallId: 'p4a-live', result: { isError: false, content: [], details: window.__p4a.liveEnded } });
      return true;
    })()`);
    await sleep(350);
    await expandAll();
    await scrollTo('[data-id="p4a-live"]');
    await shot('04-classic-live-ended-dark-1320');
    recordMetrics('wide-live-ended', await evalJs(`(() => {
      const row = document.querySelector('[data-id="p4a-live"]');
      const toggle = row?.querySelector('.tl-toggle');
      return {
        parentStatus: row?.querySelector('.tl-status')?.textContent || '',
        label: row?.querySelector('.tl-label')?.textContent || '',
        summary: row?.querySelector('.tl-subagent-meta')?.textContent || '',
        rows: [...row.querySelectorAll('.tl-subagent-row')].map(node => ({
          state: node.dataset.state,
          text: node.textContent,
        })),
        toggleExpanded: toggle?.getAttribute('aria-expanded') || null,
        cardCount: row?.classList.contains('tl-subagent') || false,
        factsText: row?.querySelector('.tl-out')?.textContent?.slice(0, 160) || '',
      };
    })()`));
    const liveEnded = metrics.find((item) => item.name === 'wide-live-ended');
    if (LABEL !== 'before') {
      check('live-state-change', liveRunning.parentStatus !== liveEnded.parentStatus
        && /失败/.test(liveEnded.parentStatus) && /成功 2/.test(liveEnded.summary)
        && /失败 1/.test(liveEnded.summary), { running: liveRunning, ended: liveEnded });
      check('live-stays-expanded', liveEnded.toggleExpanded === 'true' && liveEnded.cardCount === true, liveEnded);
      check('live-card-no-raw-facts', !liveEnded.factsText.includes('PRIVATE') && !liveEnded.factsText.includes('SECRET'), liveEnded);
    } else {
      check('before-live-fallback', liveEnded.cardCount === false && liveEnded.rows.length === 0 && liveEnded.factsText.length > 0, liveEnded);
    }

    /* 折叠态：父行仍显示计数，子列表收起。 */
    await evalJs(`(() => {
      const toggle = document.querySelector('[data-id="p4a-live"] .tl-toggle');
      if (toggle && toggle.getAttribute('aria-expanded') === 'true') toggle.click();
      return true;
    })()`);
    await sleep(180);
    await scrollTo('[data-id="p4a-live"]');
    await shot('05-classic-live-collapsed-dark-1320');
    recordMetrics('collapsed-live', await evalJs(`(() => {
      const row = document.querySelector('[data-id="p4a-live"]');
      const toggle = row?.querySelector('.tl-toggle');
      const meta = row?.querySelector('.tl-subagent-meta');
      const list = row?.querySelector('.tl-subagents');
      const more = row?.querySelector('.tl-more');
      return {
        expanded: toggle?.getAttribute('aria-expanded'),
        toggleText: toggle?.textContent || '',
        metaVisible: meta ? !meta.hidden && meta.getBoundingClientRect().height > 0 : false,
        metaText: meta?.textContent || '',
        moreHidden: more?.hidden === true,
        listOwnHidden: list?.hidden === true,
        listVisible: Boolean(list && list.getBoundingClientRect().height > 0),
        listHidden: more?.hidden === true || !list || list.getBoundingClientRect().height === 0,
        height: row?.getBoundingClientRect().height ?? null,
      };
    })()`));
    const collapsedLive = metrics.find((item) => item.name === 'collapsed-live');
    if (LABEL !== 'before') {
      check('collapsed-keeps-counts', collapsedLive.expanded === 'false' && collapsedLive.toggleText === '子代理'
        && collapsedLive.metaVisible && /子代理 · 3 项/.test(collapsedLive.metaText)
        && collapsedLive.moreHidden && collapsedLive.listVisible === false, collapsedLive);
    }
    await evalJs(`(() => {
      const toggle = document.querySelector('[data-id="p4a-live"] .tl-toggle');
      if (toggle && toggle.getAttribute('aria-expanded') === 'false') toggle.click();
      return true;
    })()`);
    await sleep(180);

    /* 父组锚点：折叠/展开子代理详情，父行顶部不应跳动。 */
    const anchor = await evalJs(`(() => {
      const row = document.querySelector('[data-id="p4a-history-wf"]');
      const toggle = row?.querySelector('.tl-toggle');
      if (!row || !toggle) return { error: 'no workflow toggle' };
      row.scrollIntoView({ block: 'center' });
      const before = row.getBoundingClientRect().top;
      if (toggle.getAttribute('aria-expanded') === 'true') toggle.click();
      const collapsed = row.getBoundingClientRect().top;
      toggle.click();
      const expanded = row.getBoundingClientRect().top;
      return { before, collapsed, expanded,
        collapseDelta: Math.abs(collapsed - before), expandDelta: Math.abs(expanded - before) };
    })()`);
    await sleep(220);
    recordMetrics('anchor', anchor);
    if (!anchor.error) {
      check('anchor-stable', anchor.collapseDelta <= 1.5 && anchor.expandDelta <= 1.5, anchor);
    }

    /* ---------- 2. 浅色宽屏与状态颜色 ---------- */
    await setTheme('light');
    await setViewport(1320, 820);
    await scrollTo('[data-id="p4a-live"]');
    await shot('06-classic-live-light-1320');
    recordMetrics('light-wide', await evalJs(`(() => {
      const row = document.querySelector('[data-id="p4a-history-wf"]');
      const meta = row?.querySelector('.tl-subagent-meta');
      return {
        rowStates: [...(row?.querySelectorAll('.tl-subagent-row') || [])].map(node => ({
          state: node.dataset.state,
          color: getComputedStyle(node.querySelector('.tl-subagent-state')).color,
        })),
        metaColor: meta ? getComputedStyle(meta).color : null,
        streamBg: getComputedStyle(document.querySelector('#stream')).backgroundColor,
        overflow: { document: document.documentElement.scrollWidth - innerWidth,
          stream: document.querySelector('#stream').scrollWidth - document.querySelector('#stream').clientWidth },
      };
    })()`));
    const lightWide = metrics.find((item) => item.name === 'light-wide');
    check('light-no-overflow', lightWide.overflow.document === 0 && lightWide.overflow.stream === 0, lightWide.overflow);
    if (LABEL !== 'before') {
      check('light-state-colors', lightWide.rowStates.every((item) => item.color)
        && new Set(lightWide.rowStates.map((item) => item.color)).size >= 2, lightWide.rowStates);
    }

    /* ---------- 3. 700px 窄屏 ---------- */
    await setTheme('dark');
    await setViewport(700, 600);
    await scrollTo('[data-id="p4a-live"]');
    await shot('07-classic-dark-700');
    const narrowDark = await evalJs(`(() => {
      const stream = document.querySelector('#stream');
      const composer = document.querySelector('.composer, #composer');
      const rows = [...document.querySelectorAll('#stream .tl-subagent-row')];
      const first = document.querySelector('[data-id="p4a-live"] .tl-subagent-row')
        || document.querySelector('[data-id="p4a-history-wf"] .tl-subagent-row') || rows[0];
      const agent = first?.querySelector('.tl-subagent-agent');
      const state = first?.querySelector('.tl-subagent-state');
      const model = first?.querySelector('.tl-subagent-model');
      const line = first?.querySelector('.tl-subagent-line');
      const streamRect = stream.getBoundingClientRect();
      return {
        viewport: [innerWidth, innerHeight],
        overflow: { document: document.documentElement.scrollWidth - innerWidth, stream: stream.scrollWidth - stream.clientWidth },
        rowOverflow: rows.map(node => node.scrollWidth - node.clientWidth),
        outsideStream: rows.map(node => {
          const r = node.getBoundingClientRect();
          return { left: r.left - streamRect.left, right: r.right - streamRect.right };
        }),
        line: line ? {
          agentTop: agent?.getBoundingClientRect().top ?? null,
          stateTop: state?.getBoundingClientRect().top ?? null,
          modelTop: model?.getBoundingClientRect().top ?? null,
          agentBottom: agent?.getBoundingClientRect().bottom ?? null,
          modelBottom: model?.getBoundingClientRect().bottom ?? null,
          lineTop: line.getBoundingClientRect().top,
          lineHeight: line.getBoundingClientRect().height,
          modelStyle: model ? {
            whiteSpace: getComputedStyle(model).whiteSpace,
            overflowWrap: getComputedStyle(model).overflowWrap,
            overflow: getComputedStyle(model).overflow,
            width: model.getBoundingClientRect().width,
          } : null,
          modelText: model?.textContent || '',
        } : null,
        metaVisible: document.querySelector('[data-id="p4a-live"] .tl-subagent-meta')?.hidden === false,
        composer: composer ? {
          bottom: composer.getBoundingClientRect().bottom,
          top: composer.getBoundingClientRect().top,
          insideViewport: composer.getBoundingClientRect().bottom <= innerHeight + 1,
        } : null,
      };
    })()`);
    recordMetrics('narrow-dark', narrowDark);
    check('narrow-dark-no-overflow', narrowDark.overflow.document === 0 && narrowDark.overflow.stream === 0
      && narrowDark.rowOverflow.every((value) => value <= 0), narrowDark);
    check('narrow-dark-composer', !narrowDark.composer || narrowDark.composer.insideViewport, narrowDark.composer);
    if (LABEL !== 'before') {
      check('narrow-name-state-first', narrowDark.line && Math.abs(narrowDark.line.agentTop - narrowDark.line.stateTop) <= 5, narrowDark.line);
      check('narrow-model-second-line', narrowDark.line && narrowDark.line.modelStyle.whiteSpace === 'normal'
        && narrowDark.line.modelTop >= narrowDark.line.agentBottom - 1, narrowDark.line);
    }

    const narrowAnchor = await evalJs(`(() => {
      const row = document.querySelector('[data-id="p4a-history-wf"]');
      const toggle = row?.querySelector('.tl-toggle');
      if (!row || !toggle) return { error: 'no workflow toggle' };
      row.scrollIntoView({ block: 'center' });
      const before = row.getBoundingClientRect().top;
      if (toggle.getAttribute('aria-expanded') === 'true') toggle.click();
      const collapsed = row.getBoundingClientRect().top;
      toggle.click();
      const expanded = row.getBoundingClientRect().top;
      return { before, collapsed, expanded,
        collapseDelta: Math.abs(collapsed - before), expandDelta: Math.abs(expanded - before) };
    })()`);
    await sleep(220);
    recordMetrics('narrow-anchor', narrowAnchor);
    if (!narrowAnchor.error) {
      check('narrow-anchor-stable', narrowAnchor.collapseDelta <= 1.5 && narrowAnchor.expandDelta <= 1.5, narrowAnchor);
    }

    await evalJs(`(() => {
      const toggle = document.querySelector('[data-id="p4a-live"] .tl-toggle');
      if (toggle && toggle.getAttribute('aria-expanded') === 'true') toggle.click();
      return true;
    })()`);
    await sleep(180);
    await scrollTo('[data-id="p4a-live"]');
    await shot('07b-classic-dark-700-collapsed');
    recordMetrics('narrow-collapsed', await evalJs(`(() => {
      const row = document.querySelector('[data-id="p4a-live"]');
      const toggle = row?.querySelector('.tl-toggle');
      const meta = row?.querySelector('.tl-subagent-meta');
      const more = row?.querySelector('.tl-more');
      const list = row?.querySelector('.tl-subagents');
      return {
        expanded: toggle?.getAttribute('aria-expanded'),
        toggleText: toggle?.textContent || '',
        metaVisible: meta ? !meta.hidden && meta.getBoundingClientRect().height > 0 : false,
        metaText: meta?.textContent || '',
        moreHidden: more?.hidden === true,
        listVisible: Boolean(list && list.getBoundingClientRect().height > 0),
        overflow: { document: document.documentElement.scrollWidth - innerWidth,
          stream: document.querySelector('#stream').scrollWidth - document.querySelector('#stream').clientWidth },
      };
    })()`));
    const narrowCollapsed = metrics.find((item) => item.name === 'narrow-collapsed');
    check('narrow-collapsed-no-overflow', narrowCollapsed.overflow.document === 0
      && narrowCollapsed.overflow.stream === 0, narrowCollapsed.overflow);
    if (LABEL !== 'before') {
      check('narrow-collapsed-counts', narrowCollapsed.expanded === 'false'
        && narrowCollapsed.toggleText === '子代理' && narrowCollapsed.metaVisible
        && /子代理 · 3 项/.test(narrowCollapsed.metaText) && narrowCollapsed.moreHidden
        && narrowCollapsed.listVisible === false, narrowCollapsed);
    }
    await evalJs(`(() => {
      const toggle = document.querySelector('[data-id="p4a-live"] .tl-toggle');
      if (toggle && toggle.getAttribute('aria-expanded') === 'false') toggle.click();
      return true;
    })()`);
    await sleep(180);

    await setTheme('light');
    await scrollTo('[data-id="p4a-live"]');
    await shot('08-classic-light-700');
    recordMetrics('narrow-light', await evalJs(`(() => {
      const stream = document.querySelector('#stream');
      const rows = [...document.querySelectorAll('#stream .tl-subagent-row')];
      const first = document.querySelector('[data-id="p4a-live"] .tl-subagent-row')
        || document.querySelector('[data-id="p4a-history-wf"] .tl-subagent-row') || rows[0];
      const model = first?.querySelector('.tl-subagent-model');
      const composer = document.querySelector('.composer, #composer');
      return {
        viewport: [innerWidth, innerHeight],
        overflow: { document: document.documentElement.scrollWidth - innerWidth, stream: stream.scrollWidth - stream.clientWidth },
        rowOverflow: rows.map(node => node.scrollWidth - node.clientWidth),
        modelStyle: model ? { whiteSpace: getComputedStyle(model).whiteSpace, width: model.getBoundingClientRect().width } : null,
        rowStateColors: rows.map(node => ({ state: node.dataset.state, color: getComputedStyle(node.querySelector('.tl-subagent-state')).color })),
        composer: composer ? { bottom: composer.getBoundingClientRect().bottom,
          insideViewport: composer.getBoundingClientRect().bottom <= innerHeight + 1 } : null,
      };
    })()`));
    const narrowLight = metrics.find((item) => item.name === 'narrow-light');
    check('narrow-light-no-overflow', narrowLight.overflow.document === 0 && narrowLight.overflow.stream === 0
      && narrowLight.rowOverflow.every((value) => value <= 0), narrowLight);
    check('narrow-light-composer', !narrowLight.composer || narrowLight.composer.insideViewport, narrowLight.composer);

    /* ---------- 4. 键盘、焦点与无障碍树 ---------- */
    console.log('\n--- 键盘与可访问性 ---');
    await setTheme('light');
    await setViewport(1320, 820);
    await scrollTo('[data-id="p4a-history-single"] .tl-toggle');
    const key = async (keyName, code, modifiers = 0) => {
      const vk = keyName === 'Tab' ? 9 : keyName === 'Enter' ? 13 : keyName === ' ' ? 32 : 27;
      const params = { key: keyName, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      if (keyName === 'Enter' || keyName === ' ') {
        const text = keyName === 'Enter' ? '\r' : ' ';
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, text, unmodifiedText: text });
      } else {
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
      }
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
      await sleep(90);
    };
    const keyboardSetup = await evalJs(`(() => {
      const toggle = document.querySelector('[data-id="p4a-history-single"] .tl-toggle');
      if (!toggle) return { error: 'no toggle' };
      if (toggle.getAttribute('aria-expanded') === 'false') toggle.click();
      toggle.focus();
      return { expanded: toggle.getAttribute('aria-expanded'), focused: document.activeElement === toggle };
    })()`);
    await key('Tab', 'Tab');
    await key('Tab', 'Tab', 8);
    const keyboardRing = await evalJs(`(() => {
      const toggle = document.querySelector('[data-id="p4a-history-single"] .tl-toggle');
      const cs = getComputedStyle(toggle);
      return { focused: document.activeElement === toggle, focusVisible: toggle.matches(':focus-visible'),
        outline: { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, offset: cs.outlineOffset } };
    })()`);
    await key('Enter', 'Enter');
    const afterEnter = await evalJs(`(() => {
      const toggle = document.querySelector('[data-id="p4a-history-single"] .tl-toggle');
      return { expanded: toggle.getAttribute('aria-expanded'),
        hidden: document.querySelector('[data-id="p4a-history-single"] .tl-more')?.hidden === true };
    })()`);
    await key(' ', 'Space');
    const afterSpace = await evalJs(`(() => {
      const toggle = document.querySelector('[data-id="p4a-history-single"] .tl-toggle');
      return { expanded: toggle.getAttribute('aria-expanded'),
        hidden: document.querySelector('[data-id="p4a-history-single"] .tl-more')?.hidden === true };
    })()`);
    recordMetrics('keyboard', { keyboardSetup, keyboardRing, afterEnter, afterSpace });
    if (LABEL !== 'before') {
      check('keyboard-focus-visible', keyboardRing.focused && keyboardRing.focusVisible
        && keyboardRing.outline.style !== 'none', keyboardRing);
      check('keyboard-enter-collapse', afterEnter.expanded === 'false' && afterEnter.hidden === true, afterEnter);
      check('keyboard-space-expand', afterSpace.expanded === 'true' && afterSpace.hidden === false, afterSpace);
    }

    recordMetrics('accessibility', await summarizeAx());
    const ax = metrics.find((item) => item.name === 'accessibility');
    if (LABEL !== 'before') {
      check('ax-list-named', ax.lists.some((item) => item.name === '子代理'), ax.lists);
      check('ax-listitems', ax.counts.listitem >= 4, ax.counts);
    }

    /* ---------- 5. Runtime：不新增卡片、不泄露原始工具信息 ---------- */
    console.log('\n--- Runtime 安全工具行 ---');
    await setTheme('dark');
    await setViewport(1320, 820);
    await evalJs(`(async () => {
      document.querySelector('#runtimeView').replaceChildren();
      __surface.showRuntimeConversation();
      document.querySelector('#runtimeView').replaceChildren();
      window.__rtc = __RTC.createRuntimeConversation({ host: document.querySelector('#runtimeView') });
      const owner = { backendInstance: 'visual', projectId: 'project', repoId: 'repo', workspaceId: 'ws-p4a',
        workspaceEpoch: 'epoch', conversationId: 'P4ART', runtimeId: 'rt-p4a', runtimeGeneration: 'gen-1', sessionId: 'session-p4a' };
      __RS.runtimeStore.seed({ backendInstance: 'visual', items: [
        { conversationId: 'P4ART', createdAt: '2026-11-16T00:00:00.000Z',
          workspace: { branch: 'feat/session-ux-p4a-subagent-cards', projectId: 'project', workspaceId: 'ws-p4a', workspaceEpoch: 'epoch' },
          owner, lifecycle: 'ready', activity: 'running', attention: false, nativeSessionId: 'native-p4a' },
      ] });
      __rtc.show('P4ART');
      const frame = (seq, event) => __RS.observeRuntimeFrame({ type: 'runtime_event', owner, eventSequence: seq, event });
      const text = value => ({ type: 'text', text: value });
      let seq = 0;
      frame(++seq, { type: 'agent_start' });
      frame(++seq, { type: 'message_start', message: { role: 'user', content: [text('Runtime：子代理仍使用现有安全工具行。')] } });
      frame(++seq, { type: 'message_start', message: { role: 'assistant', content: [] } });
      frame(++seq, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop',
        content: [text('Runtime 投影有意裁减工具数据；本阶段不扩展 Runtime 契约，也不展示子项卡片。')] } });
      frame(++seq, { type: 'tool_execution_start', toolCallId: 'rt-sub', toolName: 'subagent' });
      frame(++seq, { type: 'tool_execution_end', toolCallId: 'rt-sub', isError: false, durationMs: 1200 });
      await new Promise(resolve => setTimeout(resolve, 180));
      return true;
    })()`);
    await sleep(450);
    await scrollTo('#runtimeView .tl-item[data-id="rt-sub"]', 'center');
    await shot('09-runtime-subagent-dark-1320');
    recordMetrics('runtime', await evalJs(`(() => {
      const view = document.querySelector('#runtimeView');
      const row = view.querySelector('.tl-item[data-id="rt-sub"]');
      const output = view.querySelector('.rtc-output');
      return {
        subagentCards: view.querySelectorAll('.tl-subagent').length,
        subagentRows: view.querySelectorAll('.tl-subagent-row').length,
        subagentMetas: view.querySelectorAll('.tl-subagent-meta').length,
        toolRow: Boolean(row),
        toolRowText: row?.textContent || '',
        toolFields: Object.keys(row?._tlEntry || {}).sort(),
        toolArgsNull: row?._tlEntry ? row._tlEntry.args === null && row._tlEntry.details === null : null,
        overflow: { document: document.documentElement.scrollWidth - innerWidth,
          runtimeView: view.scrollWidth - view.clientWidth,
          output: output?.scrollWidth - output?.clientWidth },
        leaked: ['PRIVATE', 'SECRET', 'provider/model'].some(token => view.textContent.includes(token)),
      };
    })()`));
    const runtime = metrics.find((item) => item.name === 'runtime');
    check('runtime-no-card', runtime.subagentCards === 0 && runtime.subagentRows === 0 && runtime.subagentMetas === 0, runtime);
    check('runtime-safe-row', runtime.toolRow === true && runtime.leaked === false
      && runtime.toolArgsNull === true, runtime);
    check('runtime-no-overflow', runtime.overflow.document === 0 && runtime.overflow.runtimeView === 0
      && runtime.overflow.output === 0, runtime.overflow);

    await setTheme('light');
    await setViewport(700, 600);
    await scrollTo('#runtimeView .tl-item[data-id="rt-sub"]', 'center');
    await shot('10-runtime-subagent-light-700');
    recordMetrics('runtime-narrow', await evalJs(`(() => {
      const view = document.querySelector('#runtimeView');
      const output = view.querySelector('.rtc-output');
      const composer = view.querySelector('.rtc-composer');
      return {
        viewport: [innerWidth, innerHeight],
        overflow: { document: document.documentElement.scrollWidth - innerWidth,
          runtimeView: view.scrollWidth - view.clientWidth,
          output: output?.scrollWidth - output?.clientWidth },
        composer: composer ? { bottom: composer.getBoundingClientRect().bottom,
          insideViewport: composer.getBoundingClientRect().bottom <= innerHeight + 1 } : null,
        cards: view.querySelectorAll('.tl-subagent-row').length,
      };
    })()`));
    const runtimeNarrow = metrics.find((item) => item.name === 'runtime-narrow');
    check('runtime-narrow-layout', runtimeNarrow.overflow.document === 0 && runtimeNarrow.overflow.runtimeView === 0
      && runtimeNarrow.overflow.output === 0 && runtimeNarrow.cards === 0
      && (!runtimeNarrow.composer || runtimeNarrow.composer.insideViewport), runtimeNarrow);

    const failed = assertions.filter((item) => !item.pass);
    fs.writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify({
      label: LABEL, hasCards, publicRoot: process.env.VISUAL_PUBLIC_ROOT || path.join(ROOT, 'public'),
      browser: CHROME, assertions, failures: failed, metrics,
    }, null, 2));
    console.log('\n断言: ' + (assertions.length - failed.length) + '/' + assertions.length + ' 通过');
    console.log('验收测量写入: ' + path.join(OUT, 'measurements.json'));
    if (failed.length) throw new Error('P4-A 视觉验收有 ' + failed.length + ' 条断言失败');
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    try { harness.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
