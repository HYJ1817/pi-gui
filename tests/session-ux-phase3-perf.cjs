/* P3-G 长会话性能测量（真实 Chromium/CDP，不做虚拟化）。
 *
 * 每个模式准备：
 *  - 500+ 条可见消息；
 *  - 200 次工具调用（50 个助手消息 × 4 个工具），多次长输出；
 *  - Classic 与 Runtime 两种渲染路径。
 *
 * 记录初次渲染、会话切换、滚动、工具组展开/收起、DOM 节点数、JS heap、
 * long task 次数与最大值。Runtime 仍受既有 MAX_BLOCKS / MAX_TIMELINE_CHARS
 * 有界裁剪约束，报告会同时给出“喂入消息数”和“最终可见 block 数”。
 *
 * 产物：docs/ui/session-ux-phase3-evidence/<label>/performance.json
 */
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LABEL = process.env.P3_PERF_LABEL || 'after';
const OUT = path.join(ROOT, 'docs', 'ui', 'session-ux-phase3-evidence', LABEL);
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

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ux-p3-perf-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-background-networking', '--disable-default-apps', '--metrics-recording-only',
    '--hide-scrollbars', '--enable-precise-memory-info', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1320,820', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 75; i++) {
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

async function main() {
  if (!CHROME) throw new Error('找不到 Chromium');
  fs.mkdirSync(OUT, { recursive: true });
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
  console.log('夹具: ' + url);
  console.log('静态目录: ' + (process.env.VISUAL_PUBLIC_ROOT || path.join(ROOT, 'public')));

  const { chrome, page, profile } = await launch();
  let send = null;
  const pageErrors = [];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    const pending = new Map();
    let idc = 0;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        pageErrors.push(String(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || '').slice(0, 400));
      }
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    };
    send = (method, params = {}) => new Promise(resolveSend => {
      const id = ++idc;
      pending.set(id, resolveSend);
      ws.send(JSON.stringify({ id, method, params }));
    });
  });
  const evalJs = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 400));
    return result.result?.result?.value;
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
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
      window.__RTC = await import('/runtime-conversation.js');
      window.__RT = await import('/runtime-timeline.js');
      Object.assign(__S, { hasProject: true, bridgeState: 'ready', streaming: false, stopping: false });
      __surface.showChat();
      return true;
    })()`);
    await sleep(200);

    const result = await evalJs(`(async () => {
      const painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const text = value => ({ type: 'text', text: value });
      const makeMessages = (prefix, turns = 260, toolBatches = 50, perBatch = 4) => {
        const messages = [];
        for (let i = 0; i < turns; i++) {
          messages.push({ role: 'user', content: [text(prefix + ' 用户 ' + (i + 1) + '：请检查第 ' + (i + 1) + ' 组实现边界与回归测试。')] });
          messages.push({ role: 'assistant', usage: { input: 100 + i, output: 50 + i, totalTokens: 150 + i * 2 }, content: [text(prefix + ' 助手 ' + (i + 1) + '：已核对模块边界、离线验证和异常处理。长中文用于制造真实换行；Long English keeps the reading column stable.')] });
        }
        for (let b = 0; b < toolBatches; b++) {
          const calls = [];
          for (let t = 0; t < perBatch; t++) {
            const id = prefix + '-call-' + b + '-' + t;
            calls.push({ type: 'toolCall', id, name: t % 2 ? 'bash' : 'read', arguments: { path: 'fixture-' + b + '-' + t + '.txt', command: 'npm run test:ui2 -- --grep case-' + b } });
          }
          messages.push({ role: 'assistant', usage: { input: 200, output: 100, totalTokens: 300 }, content: calls });
          for (let t = 0; t < perBatch; t++) {
            const id = prefix + '-call-' + b + '-' + t;
            messages.push({ role: 'toolResult', toolCallId: id, toolName: t % 2 ? 'bash' : 'read', isError: t === perBatch - 2,
              timestamp: 1000 + b * 10 + t,
              content: [text('result-' + b + '-' + t + ' ' + 'long output '.repeat(160))] });
          }
        }
        return messages;
      };
      const A = makeMessages('A');
      const B = makeMessages('B');
      const toolCalls = A.filter(message => Array.isArray(message.content) && message.content.some(part => part.type === 'toolCall')).length * 4;

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
      const measureRender = async (messages, sessionId) => {
        __M.clearThread();
        stream.scrollTop = 0;
        resetLongTasks();
        const start = performance.now();
        __M.rebuildFromMessages(messages, sessionId);
        await painted();
        const elapsed = performance.now() - start;
        return { ms: elapsed, longTasks: longTaskStats(), nodes: stream.querySelectorAll('*').length,
          scrollHeight: stream.scrollHeight, messages: stream.querySelectorAll('.msg').length,
          toolGroups: stream.querySelectorAll('.tl-group').length, toolRows: stream.querySelectorAll('.tl-item').length };
      };

      const classicInitial = await measureRender(A, 'perf-A');
      const classicSwitchB = await measureRender(B, 'perf-B');
      const classicSwitchBack = await measureRender(A, 'perf-A');
      const leakedB = document.querySelector('#stream').textContent.includes('B 用户 260');
      const streamAfterA = document.querySelector('#stream');

      resetLongTasks();
      const scrollStart = performance.now();
      streamAfterA.scrollTop = streamAfterA.scrollHeight;
      await painted();
      const scrollBottom = performance.now() - scrollStart;
      const scrollStart2 = performance.now();
      streamAfterA.scrollTop = Math.floor(streamAfterA.scrollHeight / 2);
      await painted();
      const scrollMiddle = performance.now() - scrollStart2;
      const scrollTasks = longTaskStats();

      const group = streamAfterA.querySelector('.tl-group');
      const head = group?.querySelector('.tl-group-head');
      let expandMs = null, collapseMs = null, expandDelta = null;
      if (head) {
        if (head.getAttribute('aria-expanded') === 'true') head.click();
        await painted();
        const beforeTop = group.getBoundingClientRect().top;
        resetLongTasks();
        const t0 = performance.now();
        head.click();
        await painted();
        expandMs = performance.now() - t0;
        expandDelta = group.getBoundingClientRect().top - beforeTop;
        const t1 = performance.now();
        head.click();
        await painted();
        collapseMs = performance.now() - t1;
      }

      const classic = {
        fedMessages: A.length, toolCalls, initial: classicInitial,
        switchToB: classicSwitchB, switchBackToA: classicSwitchBack,
        crossSessionLeak: leakedB,
        scroll: { bottomMs: scrollBottom, middleMs: scrollMiddle, longTasks: scrollTasks },
        toolGroup: { expandMs, collapseMs, expandDeltaPx: expandDelta },
        dom: {
          documentNodes: document.querySelectorAll('*').length,
          streamNodes: streamAfterA.querySelectorAll('*').length,
          heapBytes: performance.memory?.usedJSHeapSize || null,
        },
        longTaskAll: longTaskStats(),
      };

      /* ---------- Runtime ---------- */
      document.querySelector('#runtimeView').replaceChildren();
      __surface.showRuntimeConversation();
      document.querySelector('#runtimeView').replaceChildren();
      const view = __RTC.createRuntimeConversation({ host: document.querySelector('#runtimeView') });
      const ownerBase = { backendInstance: 'perf', projectId: 'project', repoId: 'repo', workspaceId: 'ws', workspaceEpoch: 'epoch', runtimeId: 'rt', runtimeGeneration: 'gen', sessionId: 'session' };
      __RS.runtimeStore.seed({ backendInstance: 'perf', items: [
        { conversationId: 'PERF-A', createdAt: '2026-11-16T00:00:00.000Z', workspace: { branch: 'perf', projectId: 'project', workspaceId: 'ws-a', workspaceEpoch: 'epoch' },
          owner: null, lifecycle: 'dormant', activity: 'idle', attention: false, nativeSessionId: 'native-A' },
        { conversationId: 'PERF-B', createdAt: '2026-11-16T00:00:00.000Z', workspace: { branch: 'perf', projectId: 'project', workspaceId: 'ws-b', workspaceEpoch: 'epoch' },
          owner: null, lifecycle: 'dormant', activity: 'idle', attention: false, nativeSessionId: 'native-B' },
      ] });
      const makePayload = messages => {
        const projection = __RT.timelineFromMessages(messages);
        return {
          ok: true, messages: messages.map(message => ({ role: message.role, text: '' })), truncated: false,
          execution: { timeline: projection.blocks, truncated: projection.truncated, planBoundary: null },
        };
      };
      const projectionStart = performance.now();
      const payloads = { A: makePayload(A), B: makePayload(B) };
      const projectionMs = performance.now() - projectionStart;
      window.fetch = async input => {
        const url = String(input);
        if (url.includes('/api/runtime-sessions')) {
          const payload = url.includes('PERF-B') ? payloads.B : payloads.A;
          return { status: 200, json: async () => payload };
        }
        return { status: 200, json: async () => ({ ok: true, backendInstance: 'perf', items: [] }) };
      };
      const openHistory = async conversationId => {
        view.show(conversationId);
        await wait(50);
        const button = [...document.querySelectorAll('#runtimeView button')].find(node => node.textContent === '打开历史');
        if (!button) throw new Error('没有历史按钮: ' + conversationId);
        resetLongTasks();
        const start = performance.now();
        button.click();
        await painted();
        return { ms: performance.now() - start, longTasks: longTaskStats() };
      };
      const runtimeA = await openHistory('PERF-A');
      const output = document.querySelector('#runtimeView .rtc-output');
      const runtime = {
        fedMessages: A.length, toolCalls, projectionMs,
        blocksA: payloads.A.execution.timeline.length, truncatedA: payloads.A.execution.truncated,
        blockKinds: payloads.A.execution.timeline.reduce((counts, block) => {
          counts[block.kind] = (counts[block.kind] || 0) + 1; return counts;
        }, {}),
        initial: { ...runtimeA, nodes: output.querySelectorAll('*').length, scrollHeight: output.scrollHeight,
          toolGroups: output.querySelectorAll('.tl-group').length, toolRows: output.querySelectorAll('.tl-item').length,
          toolBlocksInDom: output.querySelectorAll('.ui2-runtime-tools').length },
      };
      const runtimeB = await openHistory('PERF-B');
      runtime.switchToB = { ...runtimeB, blocks: payloads.B.execution.timeline.length };
      const runtimeBack = await openHistory('PERF-A');
      runtime.switchBackToA = runtimeBack;
      runtime.crossSessionLeak = output.textContent.includes('B 用户 260');
      resetLongTasks();
      const r0 = performance.now();
      output.scrollTop = output.scrollHeight;
      await painted();
      runtime.scrollBottomMs = performance.now() - r0;
      const r1 = performance.now();
      output.scrollTop = Math.floor(output.scrollHeight / 2);
      await painted();
      runtime.scrollMiddleMs = performance.now() - r1;
      runtime.scrollLongTasks = longTaskStats();
      const rGroup = output.querySelector('.tl-group');
      const rHead = rGroup?.querySelector('.tl-group-head');
      if (rHead) {
        if (rHead.getAttribute('aria-expanded') === 'true') rHead.click();
        const p0 = performance.now();
        rHead.click();
        await painted();
        runtime.expandMs = performance.now() - p0;
        const p1 = performance.now();
        rHead.click();
        await painted();
        runtime.collapseMs = performance.now() - p1;
      }
      runtime.dom = {
        documentNodes: document.querySelectorAll('*').length,
        outputNodes: output.querySelectorAll('*').length,
        heapBytes: performance.memory?.usedJSHeapSize || null,
      };
      runtime.longTaskAll = longTaskStats();
      try { observer.disconnect(); } catch { /* ignore */ }
      return { classic, runtime };
    })()`);

    result.pageErrors = pageErrors;
    fs.writeFileSync(path.join(OUT, 'performance.json'), JSON.stringify({ label: LABEL, measuredAt: new Date().toISOString(), result }, null, 2));
    console.log(JSON.stringify({ label: LABEL, result }, null, 2));
    console.log('\n性能数据写入: ' + path.join(OUT, 'performance.json'));
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    try { harness.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
