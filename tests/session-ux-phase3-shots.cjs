/* 第三阶段真实 Chromium/CDP 视觉、几何与可访问性验收。
 *
 * 用法：
 *   node tests/session-ux-phase3-shots.cjs
 *   P3_SHOT_LABEL=before VISUAL_PUBLIC_ROOT=<origin-main>/public node tests/session-ux-phase3-shots.cjs
 *
 * - after 默认读取当前工作区的 public/；
 * - before 用同一个脚本、同一份夹具，只把静态目录换成 origin/main 的 public/，
 *   产物写到 docs/ui/session-ux-phase3-evidence/<label>/。
 *
 * 不启动真 pi、不读用户会话；所有会话、工具、计划、usage 都是固定夹具。
 */
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LABEL = process.env.P3_SHOT_LABEL || 'after';
const OUT = path.join(ROOT, 'docs', 'ui', 'session-ux-phase3-evidence', LABEL);

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ux-p3-'));
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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 400));
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
  const recordMetrics = (name, value) => {
    metrics.push({ name, ...value });
    console.log('  测量: ' + name + ' ' + JSON.stringify(value));
  };
  const summarizeAx = async () => {
    const ax = await send('Accessibility.getFullAXTree', {});
    const nodes = ax.result?.nodes || [];
    const pick = (role) => nodes.filter((node) => node.role?.value === role).map((node) => ({
      role: node.role?.value,
      name: node.name?.value?.slice(0, 160) || '',
      expanded: node.properties?.find((property) => property.name === 'expanded')?.value?.value,
    }));
    return {
      counts: {
        log: pick('log').length, status: pick('status').length, alert: pick('alert').length,
        button: pick('button').length, disclosure: pick('DisclosureTriangle').length,
      },
      logs: pick('log'),
      statuses: pick('status').slice(0, 12),
      disclosures: pick('DisclosureTriangle').slice(0, 12),
      buttons: pick('button').filter((node) => /工具调用|思考过程|明细|任务|打开历史|恢复会话|助手|你/.test(node.name)).slice(0, 24),
      /* 角色标签是 CSS 生成内容：视觉上裁掉用户标签，但无障碍树里仍应有「你」；
       * 助手标签正常可见。这里只收集两个固定标签，避免把正文整段带进证据。 */
      roleLabels: nodes.filter((node) => /^(你|助手)$/.test(node.name?.value || ''))
        .map((node) => `${node.role?.value}:${node.name.value}`).slice(0, 12),
    };
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');
    await send('Accessibility.enable');
    await send('Page.navigate', { url });
    for (let i = 0; i < 60; i++) {
      await sleep(200);
      if (await evalJs(`!!document.querySelector('#stream') && !!document.querySelector('.thread')`).catch(() => false)) break;
    }
    await sleep(700);

    await evalJs(`(async () => {
      window.__surface = await import('/ui/workspace-surface.js');
      window.__S = (await import('/state.js')).S;
      window.__M = await import('/messages.js');
      window.__T = await import('/tools.js');
      window.__RS = await import('/runtime-state.js');
      window.__RP = await import('/reading-position.js');
      window.__PV = await import('/plan-view.js');
      window.__RTC = await import('/runtime-conversation.js');
      window.__RT = await import('/runtime-timeline.js');
      Object.assign(__S, { hasProject: true, bridgeState: 'ready', streaming: false, stopping: false });
      __surface.showChat();
      return true;
    })()`);
    await sleep(200);

    /* ---------- 1. Classic 真实聊天流 ---------- */
    console.log('\n--- Classic 聊天流 ---');
    await evalJs(`(async () => {
      const text = value => ({ type: 'text', text: value });
      const usage = { input: 12345, output: 6789, cacheRead: 4321, cacheWrite: 2345,
        cacheWrite1h: 1200, reasoning: 98765, totalTokens: 1234567, cost: { total: 0.1234 } };
      const planArgs = { version: 1, tasks: [
        { id: 'read', title: '核对 Classic 与 Runtime 的组件边界', status: 'completed' },
        { id: 'style', title: '统一工具组、计划卡和消息元信息的边距、字号与颜色层级', status: 'completed' },
        { id: 'verify', title: '在 1320×820 与 700×600 下验证深浅主题、长中文与英文、无横向溢出，并检查 Composer 是否遮挡内容', status: 'in_progress' },
        { id: 'report', title: '整理截图、计算样式与残余风险', status: 'pending' },
      ], counts: { total: 4, completed: 2 } };
      const messages = [
        { role: 'user', content: [text('请核对会话过程第三阶段的视觉一致性：用户消息只保留一层右对齐气泡，工具组与计划卡在 Classic 和 Runtime 中使用同一套边距与状态颜色。Please keep long English sentences readable without horizontal overflow.')] },
        { role: 'assistant', usage, content: [text('我先读取设计规范、现有 Token 和实际加载的 CSS，再在真实 Chromium 中测量修改前后的计算样式。长中文：视觉一致、信息紧凑、真实数据完整可达、原有会话行为稳定、思考动画完全不变。Long English: the reading column, user bubble max width and global turn spacing must stay unchanged.')] },
        { role: 'user', content: [text('并行工具组里同时出现成功、失败、未完成；历史工具摘要和实时工具记录要保持同一套视觉规范。')] },
        { role: 'assistant', content: [
          { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'docs/ui/design-system.md' } },
          { type: 'toolCall', id: 'read-2', name: 'read', arguments: { path: 'docs/conversation-ui.md' } },
          { type: 'toolCall', id: 'read-3', name: 'read', arguments: { path: 'docs/session-ux-comparison-audit.md' } },
        ] },
        { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', isError: false, content: [text('design tokens loaded')] },
        { role: 'toolResult', toolCallId: 'read-2', toolName: 'read', isError: true, content: [text('conversation-ui.md: permission denied')] },
        { role: 'user', content: [text('接着执行实时工具与任务列表。')] },
      ];
      __M.rebuildFromMessages(messages, 'p3-classic');
      const question = { role: 'user', content: [text('执行实时工具与任务列表，等待写入时不要改用户折叠选择。')] };
      const assistant = { role: 'assistant', content: [] };
      __M.onMessageStart({ message: question });
      __M.onMessageStart({ message: assistant });
      __M.onMessageEnd({ message: { role: 'assistant', stopReason: 'stop', usage, content: [text('实时回答：组头按真实状态计数，耗时取最早开始到最晚结束。')] } });
      __T.onToolStart({ toolCallId: 'live-a', toolName: 'bash', args: { command: 'npm run test:ui2' } });
      __T.onToolStart({ toolCallId: 'live-b', toolName: 'write', args: { path: 'docs/ui/evidence.md' } });
      __T.onToolStart({ toolCallId: 'live-c', toolName: 'read', args: { path: 'public/styles.css' } });
      __T.onToolStart({ toolCallId: 'live-d', toolName: 'bash', args: { command: 'npm run build:app -- --rebuild' } });
      __T.onToolWait({ toolCallId: 'live-b', waiting: true });
      __T.onToolEnd({ toolCallId: 'live-a', result: { isError: false, content: [text('ok')] } });
      __T.onToolEnd({ toolCallId: 'live-c', result: { isError: true, content: [text('missing selector')] } });
      __T.onToolStart({ toolCallId: 'plan-live', toolName: 'gui_plan', args: planArgs });
      __T.onToolEnd({ toolCallId: 'plan-live', result: { isError: false, details: planArgs } });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    })()`);
    await sleep(400);
    await evalJs(`(() => { document.querySelector('#stream').scrollTop = 0; return true; })()`);

    await setTheme('dark');
    await setViewport(1320, 820);
    await shot('01-classic-dark-1320');
    recordMetrics('classic-1320', await evalJs(`(() => {
      const style = (select, props) => {
        const node = document.querySelector(select); if (!node) return null;
        const cs = getComputedStyle(node); const r = node.getBoundingClientRect();
        const out = { width: r.width, height: r.height, top: r.top, left: r.left };
        for (const prop of props) out[prop] = cs[prop];
        return out;
      };
      const stream = document.querySelector('#stream');
      return {
        bubble: style('#stream .msg.user .msg-body', ['backgroundColor', 'borderTopWidth', 'borderTopStyle', 'borderRadius', 'padding', 'maxWidth', 'fontSize', 'color']),
        userRole: style('#stream .msg.user .msg-role', ['position', 'width', 'height', 'clipPath', 'overflow']),
        assistantRole: style('#stream .msg.assistant .msg-role', ['fontSize', 'color', 'marginBottom']),
        tool: style('#stream .tl-group', ['margin', 'padding', 'fontSize']),
        toolTitle: style('#stream .tl-group-head', ['fontSize', 'color']),
        toolLabel: style('#stream .tl-label', ['fontSize', 'color']),
        toolArg: style('#stream .tl-arg', ['fontSize', 'color']),
        toolState: style('#stream .tl-group .ui2-tool-state', ['fontSize', 'color', 'flexWrap']),
        plan: style('#stream .plan-card', ['margin', 'padding', 'fontSize']),
        usageButton: style('#stream .msg.assistant .message-actions .message-usage', ['width', 'height', 'color']),
        usageIcon: style('#stream .message-usage svg', ['width', 'height']),
        overflow: { document: document.documentElement.scrollWidth - innerWidth, stream: stream.scrollWidth - stream.clientWidth },
      };
    })()`));

    await evalJs(`(() => { const stream = document.querySelector('#stream'); stream.scrollTop = stream.scrollHeight; return true; })()`);
    await shot('01b-classic-live-tools-dark-1320');

    await setTheme('light');
    await setViewport(700, 600);
    await evalJs(`(() => { document.querySelector('#stream').scrollTop = 0; return true; })()`);
    await shot('02-classic-light-700');
    recordMetrics('classic-700', await evalJs(`(() => {
      const stream = document.querySelector('#stream');
      const composer = document.querySelector('.composer, #composer');
      return {
        viewport: [innerWidth, innerHeight],
        overflow: { document: document.documentElement.scrollWidth - innerWidth, stream: stream.scrollWidth - stream.clientWidth },
        composer: composer ? { bottom: composer.getBoundingClientRect().bottom, top: composer.getBoundingClientRect().top } : null,
      };
    })()`));
    await evalJs(`(() => { const stream = document.querySelector('#stream'); stream.scrollTop = stream.scrollHeight; return true; })()`);
    await shot('02b-classic-live-tools-light-700');

    /* 折叠计划卡，验证标题摘要不会把组头撑开。 */
    await setTheme('dark');
    await setViewport(1320, 820);
    await evalJs(`(() => {
      const stream = document.querySelector('#stream'); stream.scrollTop = stream.scrollHeight;
      const head = document.querySelector('#stream .plan-card .plan-head');
      if (head && head.getAttribute('aria-expanded') === 'true') head.click();
      return true;
    })()`);
    await sleep(200);
    await shot('03-classic-plan-collapsed-dark-1320');
    await setTheme('light');
    await shot('04-classic-plan-collapsed-light-1320');

    recordMetrics('accessibility-classic', await summarizeAx());

    /* ---------- 2. Runtime 实时 ---------- */
    console.log('\n--- Runtime 实时 ---');
    await evalJs(`(async () => {
      document.querySelector('#runtimeView').replaceChildren();
      __surface.showRuntimeConversation();
      document.querySelector('#runtimeView').replaceChildren();
      window.__rtc = __RTC.createRuntimeConversation({ host: document.querySelector('#runtimeView') });
      const owner = { backendInstance: 'visual', projectId: 'project', repoId: 'repo', workspaceId: 'ws-runtime',
        workspaceEpoch: 'epoch', conversationId: 'LIVE', runtimeId: 'rt-live', runtimeGeneration: 'gen-1', sessionId: 'session-live' };
      __RS.runtimeStore.seed({ backendInstance: 'visual', items: [
        { conversationId: 'LIVE', createdAt: '2026-11-16T00:00:00.000Z',
          workspace: { branch: 'feat/session-ux-phase-3', projectId: 'project', workspaceId: 'ws-runtime', workspaceEpoch: 'epoch' },
          owner, lifecycle: 'ready', activity: 'running', attention: false, nativeSessionId: 'native-live' },
        { conversationId: 'HISTORY', createdAt: '2026-11-16T00:00:00.000Z',
          workspace: { branch: 'feat/session-ux-phase-3', projectId: 'project', workspaceId: 'ws-history', workspaceEpoch: 'epoch' },
          owner: null, lifecycle: 'dormant', activity: 'idle', attention: false, nativeSessionId: 'native-history' },
        { conversationId: 'PLANONLY', createdAt: '2026-11-16T00:00:00.000Z',
          workspace: { branch: 'feat/session-ux-phase-3', projectId: 'project', workspaceId: 'ws-planonly', workspaceEpoch: 'epoch' },
          owner: null, lifecycle: 'dormant', activity: 'idle', attention: false, nativeSessionId: 'native-planonly' },
      ] });
      __rtc.show('LIVE');
      const frame = (seq, event) => __RS.observeRuntimeFrame({ type: 'runtime_event', owner, eventSequence: seq, event });
      const text = value => ({ type: 'text', text: value });
      const usage = { input: 12345, output: 6789, cacheRead: 4321, cacheWrite: 2345,
        cacheWrite1h: 1200, reasoning: 98765, totalTokens: 1234567, cost: { total: 0.1234 } };
      let seq = 0;
      frame(++seq, { type: 'agent_start' });
      frame(++seq, { type: 'message_start', message: { role: 'user', content: [text('Runtime 实时会话：请展示并行工具、等待写入、失败、未完成、长 Token 摘要与折叠任务列表。Please keep long English text readable at 700px.')] } });
      frame(++seq, { type: 'message_start', message: { role: 'assistant', content: [] } });
      frame(++seq, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage,
        content: [text('实时回答：Classic 与 Runtime 共用同一套消息元信息、工具组和计划卡样式。长中文用于验证 700px 下的换行；Long English keeps the reading column stable without horizontal overflow.')] } });
      const tools = [
        ['live-a', 'bash'], ['live-b', 'write'], ['live-c', 'read'], ['live-d', 'bash'],
      ];
      for (const [id, name] of tools) frame(++seq, { type: 'tool_execution_start', toolCallId: id, toolName: name });
      frame(++seq, { type: 'tool_wait_state', toolCallId: 'live-b', waiting: true });
      frame(++seq, { type: 'tool_execution_end', toolCallId: 'live-a', isError: false, durationMs: 2400 });
      frame(++seq, { type: 'tool_execution_end', toolCallId: 'live-c', isError: true, durationMs: 1800 });
      frame(++seq, { type: 'tool_execution_start', toolCallId: 'plan-live', toolName: 'gui_plan', plan: { version: 1, tasks: [
        { id: 'read', title: '核对 Classic 与 Runtime 的组件边界', status: 'completed' },
        { id: 'style', title: '统一工具组、计划卡和消息元信息的边距、字号与颜色层级', status: 'completed' },
        { id: 'verify', title: '在 1320×820 与 700×600 下验证深浅主题、长中文与英文、无横向溢出，并检查 Composer 是否遮挡内容', status: 'in_progress' },
        { id: 'report', title: '整理截图、计算样式与残余风险', status: 'pending' },
      ], counts: { total: 4, completed: 2 } } });
      await new Promise(resolve => setTimeout(resolve, 150));
      return true;
    })()`);
    await sleep(500);
    await evalJs(`(() => { document.querySelector('#runtimeView .rtc-output').scrollTop = 0; return true; })()`);

    await setTheme('dark');
    await setViewport(1320, 820);
    await shot('05-runtime-live-dark-1320');
    recordMetrics('runtime-live-1320', await evalJs(`(() => {
      const style = (select, props) => {
        const node = document.querySelector(select); if (!node) return null;
        const cs = getComputedStyle(node); const r = node.getBoundingClientRect();
        const out = { width: r.width, height: r.height, top: r.top, left: r.left };
        for (const prop of props) out[prop] = cs[prop];
        return out;
      };
      const user = document.querySelector('#runtimeView .rtc-timeline-message[data-role="user"]');
      const view = document.querySelector('#runtimeView');
      const composer = document.querySelector('#runtimeView .rtc-composer');
      const output = document.querySelector('#runtimeView .rtc-output');
      return {
        userOuter: style('#runtimeView .rtc-timeline-message[data-role="user"]', ['backgroundColor', 'borderTopWidth', 'borderTopStyle', 'padding', 'borderRadius']),
        userInner: style('#runtimeView .rtc-history-user-text', ['backgroundColor', 'borderTopWidth', 'borderRadius', 'padding', 'maxWidth', 'fontSize', 'color']),
        userPseudo: user ? { content: getComputedStyle(user, '::before').content, position: getComputedStyle(user, '::before').position, width: getComputedStyle(user, '::before').width, clipPath: getComputedStyle(user, '::before').clipPath } : null,
        assistantPseudo: style('#runtimeView .rtc-timeline-message[data-role="assistant"]', ['fontSize']),
        tool: style('#runtimeView .tl-group', ['margin', 'padding', 'fontSize']),
        toolTitle: style('#runtimeView .tl-group-head', ['fontSize', 'color']),
        toolLabel: style('#runtimeView .tl-label', ['fontSize', 'color']),
        toolArg: style('#runtimeView .tl-arg', ['fontSize', 'color']),
        planWrap: style('#runtimeView .ui2-runtime-plan', ['margin', 'padding']),
        plan: style('#runtimeView .plan-card', ['margin', 'padding', 'fontSize']),
        usageButton: style('#runtimeView .message-usage', ['width', 'height', 'color']),
        usageIcon: style('#runtimeView .message-usage svg', ['width', 'height']),
        overflow: { document: document.documentElement.scrollWidth - innerWidth, runtimeView: view.scrollWidth - view.clientWidth, output: output.scrollWidth - output.clientWidth },
        composer: composer ? { top: composer.getBoundingClientRect().top, bottom: composer.getBoundingClientRect().bottom, overlapsOutput: output.getBoundingClientRect().bottom > composer.getBoundingClientRect().top + 1 } : null,
      };
    })()`));

    await setTheme('light');
    await setViewport(700, 600);
    await shot('06-runtime-live-light-700');
    recordMetrics('runtime-live-700', await evalJs(`(() => {
      const view = document.querySelector('#runtimeView');
      const composer = document.querySelector('#runtimeView .rtc-composer');
      const output = document.querySelector('#runtimeView .rtc-output');
      return {
        viewport: [innerWidth, innerHeight],
        overflow: { document: document.documentElement.scrollWidth - innerWidth, runtimeView: view.scrollWidth - view.clientWidth, output: output.scrollWidth - output.clientWidth },
        composer: composer ? { top: composer.getBoundingClientRect().top, bottom: composer.getBoundingClientRect().bottom, insideViewport: composer.getBoundingClientRect().bottom <= innerHeight + 1, overlapsOutput: output.getBoundingClientRect().bottom > composer.getBoundingClientRect().top + 1 } : null,
      };
    })()`));
    await evalJs(`(() => { const output = document.querySelector('#runtimeView .rtc-output'); output.scrollTop = output.scrollHeight; return true; })()`);
    await shot('06b-runtime-live-plan-light-700');

    await setTheme('dark');
    await setViewport(1320, 820);
    await evalJs(`(() => {
      const output = document.querySelector('#runtimeView .rtc-output'); output.scrollTop = output.scrollHeight;
      const head = document.querySelector('#runtimeView .plan-card .plan-head');
      if (head && head.getAttribute('aria-expanded') === 'true') head.click();
      return true;
    })()`);
    await sleep(200);
    await shot('07-runtime-live-plan-collapsed-dark-1320');
    await setTheme('light');
    await shot('08-runtime-live-plan-collapsed-light-1320');

    console.log('\n--- prefers-reduced-motion（运行中的实时会话）---');
    const reducedBefore = await evalJs(`(() => {
      const dots = document.querySelector('#runtimeView .thinking-dots');
      if (!dots) return null;
      return {
        phase: dots.dataset.phase,
        rect: dots.getBoundingClientRect().toJSON(),
        opacity: getComputedStyle(dots).opacity,
        running: dots.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').map(animation => animation.animationName),
      };
    })()`);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(350);
    const reducedAfter = await evalJs(`(() => {
      const dots = document.querySelector('#runtimeView .thinking-dots');
      if (!dots) return null;
      return {
        media: matchMedia('(prefers-reduced-motion: reduce)').matches,
        phase: dots.dataset.phase,
        rect: dots.getBoundingClientRect().toJSON(),
        opacity: getComputedStyle(dots).opacity,
        running: dots.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').map(animation => animation.animationName),
      };
    })()`);
    recordMetrics('reduced-motion', { before: reducedBefore, after: reducedAfter });
    await shot('12-runtime-live-reduced-motion-light-1320');
    await send('Emulation.setEmulatedMedia', { features: [] });
    await sleep(200);

    /* ---------- 3. Runtime 历史 ---------- */
    console.log('\n--- Runtime 历史 ---');
    await evalJs(`(async () => {
      const text = value => ({ type: 'text', text: value });
      const usage = { input: 12345, output: 6789, cacheRead: 4321, cacheWrite: 2345,
        cacheWrite1h: 1200, reasoning: 98765, totalTokens: 1234567, costTotal: 0.1234 };
      const longTask = '在 1320×820 与 700×600 下验证深浅主题、长中文与英文、无横向溢出，并检查 Composer 是否遮挡内容';
      const payload = {
        ok: true, conversationId: 'HISTORY', sessionId: 'native-history', truncated: false,
        messages: [{ role: 'user', text: '历史问题' }, { role: 'assistant', text: '历史回答' }],
        execution: { truncated: false, planBoundary: 'verified', timeline: [
          { id: 'h1', kind: 'user', text: 'Runtime 历史会话：按真实记录恢复思考、工具、正文与用量。Please keep long English text readable at 700px without horizontal overflow.' },
          { id: 'h2', kind: 'thinking', text: '先核对设计 Token 与实际加载的 CSS，再比较 Classic 和 Runtime 的计算样式。', state: 'complete', usage: { input: 100, output: 200, totalTokens: 300 } },
          { id: 'h3', kind: 'assistant', text: '历史回答：Classic 与 Runtime 使用同一套字段名、数字格式和语义。Long English: the summary stays on one line and the full breakdown remains reachable through the native details control.', state: 'complete', usage: { ...usage, costTotal: 0.1234 } },
          { id: 'h4', kind: 'tools', state: 'complete', tools: [
            { id: 't1', name: 'read', state: 'success', waiting: false, durationMs: 1200 },
            { id: 't2', name: 'bash', state: 'error', waiting: false, durationMs: 2400 },
            { id: 't3', name: 'write', state: 'incomplete', waiting: false, durationMs: null },
          ] },
          { id: 'h5', kind: 'user', text: '继续检查计划卡折叠摘要。' },
          { id: 'h6', kind: 'assistant', text: '计划卡默认展开；折叠后显示真实完成计数和当前任务短标题。', state: 'complete', usage: { input: 0, output: 0, totalTokens: 0 } },
          { id: 'h7', kind: 'plan', plan: { version: 1, tasks: [
            { id: 'read', title: '核对 Classic 与 Runtime 的组件边界', status: 'completed' },
            { id: 'style', title: '统一工具组、计划卡和消息元信息的边距、字号与颜色层级', status: 'completed' },
            { id: 'verify', title: longTask, status: 'in_progress' },
            { id: 'report', title: '整理截图、计算样式与残余风险', status: 'pending' },
          ], counts: { total: 4, completed: 2 } } },
        ] },
      };
      window.fetch = async (input) => {
        const url = String(input);
        if (url.includes('/api/runtime-sessions')) return { status: 200, json: async () => payload };
        return { status: 200, json: async () => ({ ok: true, backendInstance: 'visual', items: [] }) };
      };
      __rtc.show('HISTORY');
      await new Promise(resolve => setTimeout(resolve, 80));
      const button = [...document.querySelectorAll('#runtimeView button')].find(node => node.textContent === '打开历史');
      if (!button) throw new Error('历史按钮不存在');
      button.click();
      await new Promise(resolve => setTimeout(resolve, 160));
      return true;
    })()`);
    await sleep(500);

    await setTheme('dark');
    await setViewport(1320, 820);
    await shot('09-runtime-history-dark-1320');
    recordMetrics('runtime-history-1320', await evalJs(`(() => {
      const style = (select, props) => {
        const node = document.querySelector(select); if (!node) return null;
        const cs = getComputedStyle(node); const r = node.getBoundingClientRect();
        const out = { width: r.width, height: r.height, top: r.top, left: r.left };
        for (const prop of props) out[prop] = cs[prop];
        return out;
      };
      return {
        usageButton: style('#runtimeView .message-usage', ['width', 'height', 'color']),
        usageIcon: style('#runtimeView .message-usage svg', ['width', 'height']),
        oldUsageEntries: document.querySelectorAll('#runtimeView .ui2-msg-meta, #runtimeView .ui2-runtime-usage').length,
        toolState: style('#runtimeView .tl-group .ui2-tool-state', ['fontSize', 'color', 'flexWrap']),
        planHead: style('#runtimeView .plan-card .plan-head', ['fontSize', 'color']),
        planNowExpandedDisplay: (() => { const node = document.querySelector('#runtimeView .plan-now'); return node ? getComputedStyle(node).display : null; })(),
        overflow: { document: document.documentElement.scrollWidth - innerWidth, runtimeView: document.querySelector('#runtimeView').scrollWidth - document.querySelector('#runtimeView').clientWidth },
      };
    })()`));

    await evalJs(`(() => {
      const head = document.querySelector('#runtimeView .tl-group .tl-group-head');
      if (head && head.getAttribute('aria-expanded') === 'false') head.click();
      const output = document.querySelector('#runtimeView .rtc-output');
      output.scrollTop = 0;
      return true;
    })()`);
    await sleep(200);
    await shot('09b-runtime-history-tools-dark-1320');
    await evalJs(`(() => { const output = document.querySelector('#runtimeView .rtc-output'); output.scrollTop = output.scrollHeight; return true; })()`);
    await shot('09c-runtime-history-plan-dark-1320');
    await evalJs(`(() => { const head = document.querySelector('#runtimeView .plan-card .plan-head'); if (head) head.click(); return true; })()`);
    await sleep(200);
    await shot('09d-runtime-history-plan-collapsed-dark-1320');

    await setTheme('light');
    await setViewport(700, 600);
    await evalJs(`(() => {
      const head = document.querySelector('#runtimeView .plan-card .plan-head');
      if (head && head.getAttribute('aria-expanded') === 'false') head.click();
      document.querySelector('#runtimeView .rtc-output').scrollTop = 0;
      return true;
    })()`);
    await sleep(200);
    await shot('10-runtime-history-light-700');
    await evalJs(`(() => { const output = document.querySelector('#runtimeView .rtc-output'); output.scrollTop = output.scrollHeight; return true; })()`);
    await shot('10b-runtime-history-plan-light-700');
    await evalJs(`(() => { const head = document.querySelector('#runtimeView .plan-card .plan-head'); if (head) head.click(); return true; })()`);
    await sleep(200);
    await shot('11-runtime-history-plan-collapsed-light-700');
    recordMetrics('runtime-history-plan-collapsed', await evalJs(`(() => {
      const now = document.querySelector('#runtimeView .plan-now');
      const head = document.querySelector('#runtimeView .plan-card .plan-head');
      const cs = now ? getComputedStyle(now) : null;
      return {
        expanded: head?.getAttribute('aria-expanded'),
        text: now?.textContent || '',
        title: now?.title || '',
        display: cs?.display, maxWidth: cs?.maxWidth, overflow: cs?.overflow,
        textOverflow: cs?.textOverflow, whiteSpace: cs?.whiteSpace,
        width: now?.getBoundingClientRect().width || 0,
        headWidth: head?.getBoundingClientRect().width || 0,
      };
    })()`));
    recordMetrics('runtime-history-700', await evalJs(`(() => {
      const view = document.querySelector('#runtimeView');
      const composer = document.querySelector('#runtimeView .rtc-composer');
      const output = document.querySelector('#runtimeView .rtc-output');
      return {
        viewport: [innerWidth, innerHeight],
        overflow: { document: document.documentElement.scrollWidth - innerWidth, runtimeView: view.scrollWidth - view.clientWidth, output: output.scrollWidth - output.clientWidth },
        composer: composer ? { bottom: composer.getBoundingClientRect().bottom, insideViewport: composer.getBoundingClientRect().bottom <= innerHeight + 1, overlapsOutput: output.getBoundingClientRect().bottom > composer.getBoundingClientRect().top + 1 } : null,
      };
    })()`));

    /* ---------- 4. 真实键盘事件、焦点环、可访问性树 ---------- */
    console.log('\n--- 键盘与焦点（CDP Input）---');
    await setTheme('light');
    await setViewport(1320, 820);
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
      await sleep(80);
    };
    const setup = await evalJs(`(() => {
      const group = document.querySelector('#runtimeView .tl-group');
      const head = group?.querySelector('.tl-group-head');
      if (!head) return { error: 'no group head' };
      if (head.getAttribute('aria-expanded') === 'true') head.click();
      head.focus();
      return { before: head.getAttribute('aria-expanded') };
    })()`);
    /* Tab 出去再 Shift+Tab 回来：让 Chromium 进入键盘 modality，
     * 程序化 focus() 不会触发 :focus-visible，真实键盘导航才会。 */
    await key('Tab', 'Tab');
    await key('Tab', 'Tab', 8);
    const ringLight = await evalJs(`(() => {
      const head = document.querySelector('#runtimeView .tl-group .tl-group-head');
      const cs = getComputedStyle(head);
      return { active: document.activeElement === head, focusVisible: head.matches(':focus-visible'),
        outline: { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, offset: cs.outlineOffset } };
    })()`);
    await key('Enter', 'Enter');
    const afterEnter = await evalJs(`document.querySelector('#runtimeView .tl-group .tl-group-head').getAttribute('aria-expanded')`);
    await key(' ', 'Space');
    const afterSpace = await evalJs(`document.querySelector('#runtimeView .tl-group .tl-group-head').getAttribute('aria-expanded')`);
    /* 焦点救援要用带详情的真实工具行：Runtime 历史工具没有原始参数/输出，
     * 详情按钮按设计隐藏；Classic 的实时 bash/read 行才有可聚焦的详情。 */
    const focusRescue = await evalJs(`(() => {
      __surface.showChat();
      const group = [...document.querySelectorAll('#stream .tl-group')].find(g => g.querySelector('.tl-toggle:not([hidden])'));
      if (!group) return { error: 'no classic group with detail' };
      const head = group.querySelector('.tl-group-head');
      if (head.getAttribute('aria-expanded') !== 'true') head.click();
      const detail = group.querySelector('.tl-toggle:not([hidden])');
      detail.focus();
      const before = document.activeElement === detail;
      head.click();
      return { before, after: document.activeElement === head, expanded: head.getAttribute('aria-expanded') };
    })()`);
    await evalJs(`__surface.showRuntimeConversation(); true`);
    await sleep(120);
    await evalJs(`(() => { const head = document.querySelector('#runtimeView .tl-group .tl-group-head'); head.focus(); return true; })()`);
    const escapeBefore = await evalJs(`document.querySelector('#runtimeView .tl-group .tl-group-head').getAttribute('aria-expanded')`);
    await key('Escape', 'Escape');
    const escapeAfter = await evalJs(`(() => ({ active: document.activeElement === document.querySelector('#runtimeView .tl-group .tl-group-head'),
      expanded: document.querySelector('#runtimeView .tl-group .tl-group-head').getAttribute('aria-expanded') }))()`);
    const thinkingToggle = await evalJs(`(() => {
      const details = document.querySelector('#runtimeView .ui2-runtime-thinking');
      const summary = details?.querySelector('summary');
      if (!summary) return { error: 'no thinking summary' };
      summary.focus();
      const before = details.open;
      return { before, focus: document.activeElement === summary };
    })()`);
    await key('Enter', 'Enter');
    const thinkingAfter = await evalJs(`(() => {
      const details = document.querySelector('#runtimeView .ui2-runtime-thinking');
      return { open: details.open, focus: document.activeElement === details.querySelector('summary') };
    })()`);
    recordMetrics('keyboard-light', { setup, ringLight, afterEnter, afterSpace, focusRescue, escapeBefore, escapeAfter, thinkingToggle, thinkingAfter });

    await setTheme('dark');
    const ringDark = await evalJs(`(() => {
      const head = document.querySelector('#runtimeView .tl-group .tl-group-head');
      head.focus();
      const cs = getComputedStyle(head);
      return { active: document.activeElement === head, focusVisible: head.matches(':focus-visible'),
        outline: { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, offset: cs.outlineOffset } };
    })()`);
    recordMetrics('focus-dark', ringDark);

    /* ---------- 5. 可访问性树 ---------- */
    console.log('\n--- 可访问性树（Runtime 历史）---');
    recordMetrics('accessibility-runtime', await summarizeAx());

    /* ---------- 6. Plan-only 多条 usage：同 turnId 的一张卡 ---------- */
    console.log('\n--- Plan-only usage（同 turnId 两条消息）---');
    await setTheme('dark');
    await setViewport(1320, 820);
    await evalJs(`(async () => {
      const text = value => ({ type: 'text', text: value });
      const firstTasks = [{ id: 'p', title: '核对计划卡用量归属与折叠行为', status: 'in_progress' }];
      const secondTasks = [{ id: 'p', title: '核对计划卡用量归属与折叠行为', status: 'completed' },
        { id: 'q', title: '在 700px 窄屏验证两条用量与计划折叠，不遮挡 Composer', status: 'in_progress' }];
      const firstUsage = { input: 10, output: 2, totalTokens: 12 };
      const secondUsage = { input: 20, output: 3, totalTokens: 23 };
      const projection = __RT.timelineFromMessages([
        { role: 'user', content: [text('第一条计划')], timestamp: 1 },
        { role: 'assistant', timestamp: 2, usage: firstUsage,
          content: [{ type: 'toolCall', id: 'plan-only-1', name: 'gui_plan', arguments: { version: 1, tasks: firstTasks } }] },
        { role: 'toolResult', toolCallId: 'plan-only-1', toolName: 'gui_plan', timestamp: 2,
          content: [text('ok')], details: { version: 1, tasks: firstTasks, turnId: 'run-plan-only' } },
        { role: 'user', content: [text('steer：补充第二条计划')], timestamp: 3 },
        { role: 'assistant', timestamp: 4, usage: secondUsage,
          content: [{ type: 'toolCall', id: 'plan-only-2', name: 'gui_plan', arguments: { version: 1, tasks: secondTasks } }] },
        { role: 'toolResult', toolCallId: 'plan-only-2', toolName: 'gui_plan', timestamp: 4,
          content: [text('ok')], details: { version: 1, tasks: secondTasks, turnId: 'run-plan-only' } },
      ]);
      const payload = {
        ok: true, conversationId: 'PLANONLY', sessionId: 'native-planonly', truncated: false,
        messages: [{ role: 'user', text: '第一条计划' }, { role: 'user', text: 'steer：补充第二条计划' }],
        execution: { truncated: false, planBoundary: 'verified', timeline: projection.blocks },
      };
      window.fetch = async (input) => {
        const url = String(input);
        if (url.includes('PLANONLY')) return { status: 200, json: async () => payload };
        return { status: 200, json: async () => ({ ok: true, backendInstance: 'visual', items: [] }) };
      };
      __rtc.show('PLANONLY');
      await new Promise(resolve => setTimeout(resolve, 100));
      const button = [...document.querySelectorAll('#runtimeView button')].find(node => node.textContent === '打开历史');
      if (!button) throw new Error('Plan-only 历史按钮不存在');
      button.click();
      await new Promise(resolve => setTimeout(resolve, 180));
      const output = document.querySelector('#runtimeView .rtc-output');
      output.scrollTop = output.scrollHeight;
      return true;
    })()`);
    await sleep(400);
    await shot('13-planonly-history-expanded-dark-1320');
    recordMetrics('planonly-history-1320', await evalJs(`(() => {
      const plan = document.querySelector('#runtimeView .ui2-runtime-plan');
      const view = document.querySelector('#runtimeView');
      const buttons = [...view.querySelectorAll('.message-usage')];
      const output = view.querySelector('.rtc-output');
      return {
        planCards: view.querySelectorAll('.ui2-runtime-plan').length,
        usageButtons: buttons.length,
        usageLabels: buttons.map(button => button.getAttribute('aria-label')),
        oldUsageEntries: view.querySelectorAll('.ui2-msg-meta, .ui2-runtime-usage').length,
        planHeadCount: view.querySelectorAll('.plan-card .plan-head').length,
        assistantRows: view.querySelectorAll('.rtc-timeline-message[data-role="assistant"]').length,
        expanded: plan?.querySelector('.plan-head')?.getAttribute('aria-expanded'),
        usageOutsidePlanList: buttons.every(button => !button.closest('.plan-list')),
        hostWidth: plan?.getBoundingClientRect().width || 0,
        usageButtonWidths: buttons.map(button => button.getBoundingClientRect().width),
        overflow: { document: document.documentElement.scrollWidth - innerWidth,
          runtimeView: view.scrollWidth - view.clientWidth,
          output: output.scrollWidth - output.clientWidth },
      };
    })()`));

    await evalJs(`(() => {
      const head = document.querySelector('#runtimeView .plan-card .plan-head');
      if (head && head.getAttribute('aria-expanded') === 'true') head.click();
      document.querySelector('#runtimeView .rtc-output').scrollTop = document.querySelector('#runtimeView .rtc-output').scrollHeight;
      return true;
    })()`);
    await sleep(220);
    await shot('13b-planonly-history-collapsed-dark-1320');
    recordMetrics('planonly-history-collapsed', await evalJs(`(() => {
      const plan = document.querySelector('#runtimeView .ui2-runtime-plan');
      const view = document.querySelector('#runtimeView');
      const buttons = [...view.querySelectorAll('.message-usage')];
      const head = plan?.querySelector('.plan-head');
      const list = plan?.querySelector('.plan-list');
      return {
        expanded: head?.getAttribute('aria-expanded'),
        listHidden: list?.hidden === true,
        usageButtons: buttons.length,
        usageButtonsVisible: buttons.every(button => button.isConnected
          && button.getBoundingClientRect().height > 0 && !button.closest('[hidden]')),
        oldUsageEntries: view.querySelectorAll('.ui2-msg-meta, .ui2-runtime-usage').length,
      };
    })()`));

    await evalJs(`(() => {
      const plan = document.querySelector('#runtimeView .ui2-runtime-plan');
      const head = plan?.querySelector('.plan-head');
      if (head && head.getAttribute('aria-expanded') === 'false') head.click();
      document.querySelector('#runtimeView .message-usage')?.click();
      const output = document.querySelector('#runtimeView .rtc-output');
      output.scrollTop = output.scrollHeight;
      return true;
    })()`);
    await sleep(220);
    await shot('13c-planonly-history-usage-popover-dark-1320');
    recordMetrics('planonly-history-details', await evalJs(`(() => {
      const plan = document.querySelector('#runtimeView .ui2-runtime-plan');
      const pop = document.querySelector('#messageUsagePopover');
      return {
        usagePopoverOpen: !!pop && !pop.hidden,
        usagePopoverFixed: pop ? getComputedStyle(pop).position === 'fixed' : false,
        usageFieldCount: pop ? pop.querySelectorAll('.usage-pop-value').length : 0,
        usageInPlanList: !!plan?.querySelector('.plan-list .message-usage'),
        oldUsageEntries: document.querySelectorAll('#runtimeView .ui2-msg-meta, #runtimeView .ui2-runtime-usage').length,
      };
    })()`));
    await evalJs(`(async () => (await import('/ui/usage-popover.js')).closeUsagePopover())()`);

    await setTheme('light');
    await setViewport(700, 600);
    await evalJs(`(() => {
      const head = document.querySelector('#runtimeView .plan-card .plan-head');
      if (head && head.getAttribute('aria-expanded') === 'false') head.click();
      const output = document.querySelector('#runtimeView .rtc-output');
      output.scrollTop = output.scrollHeight;
      return true;
    })()`);
    await sleep(250);
    await shot('13d-planonly-history-narrow-light-700');
    recordMetrics('planonly-history-700', await evalJs(`(() => {
      const plan = document.querySelector('#runtimeView .ui2-runtime-plan');
      const view = document.querySelector('#runtimeView');
      const buttons = [...view.querySelectorAll('.message-usage')];
      const output = view.querySelector('.rtc-output');
      const composer = view.querySelector('.rtc-composer');
      return {
        viewport: [innerWidth, innerHeight],
        planCards: view.querySelectorAll('.ui2-runtime-plan').length,
        usageButtons: buttons.length,
        oldUsageEntries: view.querySelectorAll('.ui2-msg-meta, .ui2-runtime-usage').length,
        expanded: plan?.querySelector('.plan-head')?.getAttribute('aria-expanded'),
        usageButtonWidths: buttons.map(button => button.getBoundingClientRect().width),
        hostWidth: plan?.getBoundingClientRect().width || 0,
        overflow: { document: document.documentElement.scrollWidth - innerWidth,
          runtimeView: view.scrollWidth - view.clientWidth,
          output: output.scrollWidth - output.clientWidth },
        composer: composer ? { bottom: composer.getBoundingClientRect().bottom,
          insideViewport: composer.getBoundingClientRect().bottom <= innerHeight + 1,
          overlapsOutput: output.getBoundingClientRect().bottom > composer.getBoundingClientRect().top + 1 } : null,
      };
    })()`));

    await evalJs(`(() => {
      const head = document.querySelector('#runtimeView .plan-card .plan-head');
      if (head && head.getAttribute('aria-expanded') === 'true') head.click();
      document.querySelector('#runtimeView .rtc-output').scrollTop = document.querySelector('#runtimeView .rtc-output').scrollHeight;
      return true;
    })()`);
    await sleep(220);
    await shot('13e-planonly-history-narrow-collapsed-light-700');
    recordMetrics('planonly-history-700-collapsed', await evalJs(`(() => {
      const plan = document.querySelector('#runtimeView .ui2-runtime-plan');
      const view = document.querySelector('#runtimeView');
      const buttons = [...view.querySelectorAll('.message-usage')];
      return {
        expanded: plan?.querySelector('.plan-head')?.getAttribute('aria-expanded'),
        listHidden: plan?.querySelector('.plan-list')?.hidden === true,
        usageButtons: buttons.length,
        usageButtonsVisible: buttons.every(button => button.isConnected
          && button.getBoundingClientRect().height > 0 && !button.closest('[hidden]')),
        oldUsageEntries: view.querySelectorAll('.ui2-msg-meta, .ui2-runtime-usage').length,
        overflow: { document: document.documentElement.scrollWidth - innerWidth,
          runtimeView: view.scrollWidth - view.clientWidth },
      };
    })()`));

    fs.writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify({ label: LABEL, metrics }, null, 2));

    console.log('\n验收测量写入: ' + path.join(OUT, 'measurements.json'));
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    try { harness.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
