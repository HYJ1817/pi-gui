/* 第二阶段真实 Chromium/CDP 视觉与几何验收脚本。
 *
 * 验证目标：
 * 1. Classic 会话阅读位置捕获与恢复（多会话切换前后锚点几何误差 <= 1px）。
 * 2. 折叠与展开位置补偿（工具组、工具详情、Plan 任务卡标题几何误差 <= 1px）。
 * 3. 视口上方折叠时下方内容稳定（视口内消息几何位移 <= 1px）。
 * 4. Runtime 历史搜索滚动限制在 .rtc-output 内，祖先容器 (.stage 等) scrollTop 恒为 0。
 * 5. 700px 窄屏与正常宽屏、深色与浅色主题实测。
 *
 * 只用于验收取证，不启动真 pi、不读用户会话；
 * 产物保存在 docs/ui/session-ux-phase2-final-evidence/。
 */
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'ui', 'session-ux-phase2-final-evidence');

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
  for (const candidate of BROWSER_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchCdpBrowser() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ux-p2-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-sync', '--disable-component-update',
    '--disable-background-networking', '--disable-default-apps', '--metrics-recording-only',
    '--hide-scrollbars', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--window-size=1320,820', 'about:blank',
  ];
  const chrome = spawn(CHROME, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const devToolsPortFile = path.join(profile, 'DevToolsActivePort');
  let actualPort = 0;
  for (let i = 0; i < 75; i++) {
    if (!actualPort) {
      try {
        const firstLine = fs.readFileSync(devToolsPortFile, 'utf8').split(/\r?\n/, 1)[0];
        const parsed = Number(firstLine);
        if (Number.isInteger(parsed) && parsed > 0) actualPort = parsed;
      } catch { /* waiting */ }
    }
    if (actualPort) {
      try {
        const response = await fetch(`http://127.0.0.1:${actualPort}/json/list`);
        const targets = await response.json();
        const page = targets.find((t) => t.type === 'page');
        if (page) return { chrome, page, profile, actualPort };
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

  const url = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('夹具启动超时')), 15000);
    harness.stdout.on('data', (c) => {
      buf += String(c);
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(t); res(`http://127.0.0.1:${m[1]}/`); }
    });
    harness.on('exit', (code) => { clearTimeout(t); rej(new Error('夹具退出 ' + code)); });
  });

  console.log('夹具运行在: ' + url);
  console.log('启动浏览器: ' + CHROME);

  const { chrome, page, profile, actualPort } = await launchCdpBrowser();
  console.log('CDP 端口: ' + actualPort);

  let send = null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
    const pending = new Map();
    let idc = 0;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    send = (method, params = {}) => new Promise((r2) => {
      const n = ++idc;
      pending.set(n, r2);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };

  const shot = async (name) => {
    await sleep(150);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name + '.png');
    fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    console.log('  截图: ' + path.basename(p));
  };

  const setTheme = async (theme) => {
    await evalJs(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await sleep(150);
  };

  const setViewport = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(200);
  };

  const measurements = [];
  const recordAnchor = (test, result) => {
    const error = Math.abs(result.restoredOffset - result.savedOffset);
    const shift = Math.abs(result.afterScrollTop - result.beforeScrollTop);
    const passed = error <= 1 && shift > 24;
    measurements.push({ test, ...result, errorPx: error, passed });
    console.log(test + ' · ' + result.anchorId + ': offset error ' + error.toFixed(2) + 'px, scrollTop shift ' + shift.toFixed(2) + 'px');
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url });

    for (let i = 0; i < 50; i++) {
      await sleep(250);
      if (await evalJs(`!!document.querySelector('#stream') && !!document.querySelector('.thread')`).catch(() => false)) break;
    }
    await sleep(800);

    // 载入依赖模块
    await evalJs(`(async () => {
      window.__surface = await import('/ui/workspace-surface.js');
      window.__S = (await import('/state.js')).S;
      window.__M = await import('/messages.js');
      window.__T = await import('/tools.js');
      window.__RP = await import('/reading-position.js');
      window.__TV = await import('/tool-view.js');
      window.__PV = await import('/plan-view.js');
      Object.assign(__S, { hasProject: true, bridgeState: 'ready', streaming: false, stopping: false });
      __surface.showChat();
      return true;
    })()`);
    await sleep(200);

    /* =========================================================================
     * 场景 1：Classic 会话阅读位置捕获与恢复（多会话切换）
     * ========================================================================= */
    // 两个会话都保存中段位置；改变锚点之前的布局，证明恢复使用相对偏移。
    console.log('\n--- Classic 会话切换与实时锚点（Chromium） ---');
    const classic = await evalJs(`(async () => {
      const stream = document.querySelector('#stream');
      const text = (role, value) => ({ role, content: [{ type: 'text', text: value }] });
      const history = label => Array.from({ length: 15 }, (_, i) => [
        text('user', label + ' · 用户提问 ' + (i + 1)),
        text('assistant', '架构设计：核对模块边界、离线验证和异常处理。'),
      ]).flat();
      const painted = async () => {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const entrance = __S.thread.getAnimations({ subtree: true }).filter(animation => animation.animationName === 'ui2-rise-in');
        await Promise.all(entrance.map(animation => animation.finished));
      };
      const relativeTop = target => target.getBoundingClientRect().top - stream.getBoundingClientRect().top;
      const find = anchorId => [...__S.thread.children].find(node => node.dataset.anchorId === anchorId);
      const capture = target => {
        stream.scrollTop += relativeTop(target) + 12;
        const bookmark = __RP.captureReadingPosition(stream, __S.thread);
        if (bookmark.isPinned || bookmark.anchorId !== target.dataset.anchorId || Math.abs(bookmark.offset) < 5) {
          throw new Error('未捕获预期的非贴底锚点：' + JSON.stringify(bookmark));
        }
        return bookmark;
      };
      const compare = bookmark => {
        const target = find(bookmark.anchorId);
        if (!target) throw new Error('历史中找不到锚点 ' + bookmark.anchorId);
        return {
          anchorId: bookmark.anchorId,
          savedOffset: bookmark.offset, restoredOffset: relativeTop(target),
          beforeScrollTop: bookmark.scrollTop, afterScrollTop: stream.scrollTop,
        };
      };
      const switchTo = async (from, to, messages) => {
        __M.saveClassicReadingPosition(from);
        __M.clearThread();
        stream.scrollTop = 0;
        __M.rebuildFromMessages(messages, to);
        await painted();
      };
      const style = document.createElement('style');
      document.head.append(style);
      const shiftLayout = () => {
        style.textContent = '#stream .thread > .msg.user:first-child { margin-bottom: 137px !important; }';
      };
      window.__p2AnchorFixture = { text, history, painted, capture, compare, switchTo, style, shiftLayout };
      await switchTo(null, 'shot-A', history('会话 A'));
      const a = capture(find('user-7'));
      await switchTo('shot-A', 'shot-B', history('会话 B'));
      const b = capture(find('user-9'));
      __M.saveClassicReadingPosition('shot-B');
      __M.clearThread();
      shiftLayout();
      await switchTo(null, 'shot-A', history('会话 A'));
      const restoredA = compare(a);
      await switchTo('shot-A', 'shot-B', history('会话 B'));
      const restoredB = compare(b);
      await switchTo('shot-B', 'shot-A', history('会话 A'));
      style.textContent = '';
      await switchTo(null, 'shot-A', history('会话 A'));
      return { A: restoredA, B: restoredB };
    })()`);
    recordAnchor('Classic A → B → A', classic.A);
    recordAnchor('Classic B 独立书签', classic.B);

    await setTheme('dark');
    await shot('01-classic-reading-position-restored-dark');
    await setTheme('light');
    await shot('02-classic-reading-position-restored-light');
    await setTheme('dark');

    for (const kind of ['tools', 'plan']) {
      const restored = await evalJs(`(async () => {
        const kind = ${JSON.stringify(kind)};
        const fixture = __p2AnchorFixture;
        const id = 'shot-live-' + kind;
        const prefix = fixture.history('前置历史').slice(0, 12);
        const question = fixture.text('user', '实时执行：验证' + (kind === 'plan' ? '计划锚点' : '工具组锚点'));
        const name = kind === 'plan' ? 'gui_plan' : 'read';
        const callId = 'live-' + kind;
        const args = kind === 'plan'
          ? { version: 1, tasks: [{ id: 'read', title: '检查实时锚点与历史重建', status: 'completed' }] }
          : { path: 'fixture.txt' };
        const assistant = { role: 'assistant', content: [{ type: 'toolCall', id: callId, name, arguments: args }] };
        const result = {
          role: 'toolResult', toolCallId: callId, toolName: name, isError: false,
          details: kind === 'plan' ? args : undefined,
          content: [{ type: 'text', text: 'Fixture result' }],
        };
        const tail = fixture.history('后续历史').slice(0, 20);
        await fixture.switchTo(null, id, prefix);
        __M.onMessageStart({ message: question });
        __M.onMessageStart({ message: assistant });
        __M.onMessageEnd({ message: assistant });
        __T.onToolStart({ toolCallId: callId, toolName: name, args });
        __T.onToolEnd({ toolCallId: callId, result });
        for (const message of tail) {
          __M.onMessageStart({ message });
          __M.onMessageEnd({ message });
        }
        await fixture.painted();
        const live = __S.thread.querySelector(kind === 'plan' ? '.plan-card' : '.tl-group');
        if (!live?.dataset.anchorId) throw new Error('实时锚点不存在：' + kind);
        const bookmark = fixture.capture(live);
        __M.saveClassicReadingPosition(id);
        __M.clearThread();
        fixture.shiftLayout();
        await fixture.switchTo(null, id, [...prefix, question, assistant, result, ...tail]);
        const measurement = fixture.compare(bookmark);
        return measurement;
      })()`);
      recordAnchor('实时 ' + kind + ' 锚点重建恢复', restored);
      await shot('live-' + kind + '-anchor-restored-dark');
      await evalJs(`__p2AnchorFixture.style.textContent = ''`);
    }

    /* =========================================================================
     * 场景 2：折叠与展开阅读位置补偿（工具组、工具详情、Plan 卡片）
     * ========================================================================= */
    console.log('\n--- 场景 2：折叠与展开阅读位置补偿 ---');
    await setTheme('dark');
    await evalJs(`(async () => {
      __M.clearThread();
      __T.resetTimeline();
      
      // 构建完整对话：上方 4 回合，中间为工具调用组，下方 10 回合
      const msgs = [];
      for (let i = 1; i <= 4; i++) {
        msgs.push({ role: 'user', content: [{ type: 'text', text: '前置讨论 ' + i }] });
        msgs.push({ role: 'assistant', content: [{ type: 'text', text: '前置结论 ' + i }] });
      }
      // 中间工具调用
      msgs.push({ role: 'user', content: [{ type: 'text', text: '执行工具调用核验' }] });
      msgs.push({
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'server/bridge.js' } },
          { type: 'toolCall', id: 'call_2', name: 'bash', arguments: { command: 'npm test' } },
          { type: 'text', text: '工具调用结束，以下为分析报告。' }
        ]
      });
      msgs.push({ role: 'toolResult', toolCallId: 'call_1', toolName: 'read', content: [{ type: 'text', text: '10 lines read\\nline 2\\nline 3\\nline 4\\nline 5\\nline 6\\nline 7\\nline 8\\nline 9\\nline 10' }] });
      msgs.push({ role: 'toolResult', toolCallId: 'call_2', toolName: 'bash', content: [{ type: 'text', text: 'PASS test 1\\nPASS test 2\\nPASS test 3\\nPASS test 4\\nPASS test 5' }] });

      // 后续 10 回合
      for (let i = 5; i <= 14; i++) {
        msgs.push({ role: 'user', content: [{ type: 'text', text: '后续探讨 ' + i }] });
        msgs.push({ role: 'assistant', content: [{ type: 'text', text: '详细架构解释 ' + i + '：保障滚动位置稳定性。' }] });
      }

      __M.rebuildFromMessages(msgs);
      await new Promise(r => setTimeout(r, 260));

      // 将滚动条定位在工具组处（视口中段，远离底部）
      const stream = document.querySelector('#stream');
      const groupHead = document.querySelector('.tl-group-head');
      if (groupHead && stream) {
        const sRect = stream.getBoundingClientRect();
        const gRect = groupHead.getBoundingClientRect();
        stream.scrollTop += (gRect.top - sRect.top) - 100;
      }
      return true;
    })()`);
    await sleep(300);

    // 2.1 工具组头折叠补偿（用户在阅读中间展开/折叠，标题视口位置不变）
    const groupToggleResult = await evalJs(`(async () => {
      const groupHead = document.querySelector('.tl-group-head');
      const stream = document.querySelector('#stream');
      if (!groupHead || !stream) return null;
      
      const beforeY = groupHead.getBoundingClientRect().top;
      groupHead.click();
      await new Promise(r => setTimeout(r, 60));
      const afterY = groupHead.getBoundingClientRect().top;
      return { beforeY, afterY, diff: Math.abs(afterY - beforeY) };
    })()`);

    if (!groupToggleResult) throw new Error('缺少工具组几何结果');
    {
      console.log(`工具组头折叠位置误差: ${groupToggleResult.diff.toFixed(2)}px (期望 <= 1.00px)`);
      measurements.push({ test: '工具组头折叠位置误差', errorPx: Number(groupToggleResult.diff.toFixed(2)), passed: groupToggleResult.diff <= 1.0 });
    }
    await shot('03-tool-group-toggle-dark');

    // 2.2 工具详情展开/收起补偿（工具组已展开，点击第一条工具详情）
    const detailToggleResult = await evalJs(`(async () => {
      const groupHead = document.querySelector('.tl-group-head');
      if (groupHead && groupHead.getAttribute('aria-expanded') !== 'true') {
        groupHead.click();
        await new Promise(r => setTimeout(r, 60));
      }
      const toolHead = document.querySelector('.tl-head');
      if (!toolHead) return null;
      const beforeY = toolHead.getBoundingClientRect().top;
      toolHead.click();
      await new Promise(r => setTimeout(r, 60));
      const afterY = toolHead.getBoundingClientRect().top;
      return { beforeY, afterY, diff: Math.abs(afterY - beforeY) };
    })()`);

    if (!detailToggleResult) throw new Error('缺少工具详情几何结果');
    {
      console.log(`工具详情折叠位置误差: ${detailToggleResult.diff.toFixed(2)}px (期望 <= 1.00px)`);
      measurements.push({ test: '工具详情折叠位置误差', errorPx: Number(detailToggleResult.diff.toFixed(2)), passed: detailToggleResult.diff <= 1.0 });
    }
    await shot('04-tool-detail-toggle-dark');

    // 2.3 视口上方折叠时下方内容稳定
    console.log('\n--- 场景 3：视口上方折叠时下方内容稳定 ---');
    const aboveFoldResult = await evalJs(`(async () => {
      const stream = document.querySelector('#stream');
      const groupHead = document.querySelector('.tl-group-head');
      if (!stream || !groupHead) return null;

      if (groupHead.getAttribute('aria-expanded') !== 'true') {
        groupHead.click();
        await new Promise(r => setTimeout(r, 60));
      }

      // 将滚动条向下滚，使工具组整体完全离开视口顶部（处于视口上方 150px）
      const group = groupHead.closest('.tl-group') || groupHead;
      const groupRect = group.getBoundingClientRect();
      const streamRect = stream.getBoundingClientRect();
      stream.scrollTop += (groupRect.bottom - streamRect.top) + 150;

      const readingTarget = [...__S.thread.children].find(node => {
        const rect = node.getBoundingClientRect();
        return node.dataset.anchorId && rect.bottom > streamRect.top + 2 && rect.top < streamRect.bottom;
      });
      if (!readingTarget || group.getBoundingClientRect().bottom > streamRect.top) return null;
      const readingBeforeY = readingTarget.getBoundingClientRect().top;

      // 折叠视口上方的工具组
      groupHead.click();
      await new Promise(r => setTimeout(r, 60));

      const readingAfterY = readingTarget.getBoundingClientRect().top;
      return { readingBeforeY, readingAfterY, diff: Math.abs(readingAfterY - readingBeforeY) };
    })()`);

    if (!aboveFoldResult) throw new Error('缺少视口上方折叠几何结果');
    {
      console.log(`视口上方折叠时阅读内容位移: ${aboveFoldResult.diff.toFixed(2)}px (期望 <= 1.00px)`);
      measurements.push({ test: '视口上方折叠下方稳定', errorPx: Number(aboveFoldResult.diff.toFixed(2)), passed: aboveFoldResult.diff <= 1.0 });
    }
    await shot('05-collapse-above-viewport-dark');

    // 2.4 Plan 任务卡折叠补偿
    console.log('\n--- 场景 4：Plan 任务卡折叠补偿 ---');
    const planToggleResult = await evalJs(`(async () => {
      const stream = document.querySelector('#stream');
      const planData = {
        id: 'plan-shot',
        title: '生产部署计划',
        goal: '平滑部署微服务架构',
        status: 'running',
        tasks: [
          { id: 't1', title: '执行数据库迁移', status: 'completed' },
          { id: 't2', title: '启动蓝绿容器组', status: 'running' },
          { id: 't3', title: '切流及健康巡检', status: 'pending' },
        ],
      };
      const card = __PV.renderPlan(planData);
      stream.appendChild(card);
      const spacer = document.createElement('div');
      spacer.dataset.p2PlanSpacer = 'true';
      spacer.style.height = '600px';
      stream.appendChild(spacer);

      // 将 Plan 卡头滚动到视口中段
      const cardHead = card.querySelector('.plan-head');
      if (!cardHead) return null;
      const sRect = stream.getBoundingClientRect();
      const cRect = cardHead.getBoundingClientRect();
      stream.scrollTop += (cRect.top - sRect.top) - 100;

      const beforeY = cardHead.getBoundingClientRect().top;
      cardHead.click();
      await new Promise(r => setTimeout(r, 60));
      const afterY = cardHead.getBoundingClientRect().top;
      return { beforeY, afterY, diff: Math.abs(afterY - beforeY) };
    })()`);

    if (!planToggleResult) throw new Error('缺少 Plan 折叠几何结果');
    {
      console.log(`Plan 任务卡折叠位置误差: ${planToggleResult.diff.toFixed(2)}px (期望 <= 1.00px)`);
      measurements.push({ test: 'Plan 任务卡折叠位置误差', errorPx: Number(planToggleResult.diff.toFixed(2)), passed: planToggleResult.diff <= 1.0 });
    }
    await shot('06-plan-toggle-dark');

    /* =========================================================================
     * 场景 5：Runtime 历史搜索滚动隔离修复
     * ========================================================================= */
    console.log('\n--- 场景 5：Runtime 历史搜索滚动隔离 ---');
    await evalJs(`(async () => {
      window.__RTC = await import('/runtime-conversation.js');
      window.__surface.showRuntimeConversation();
      return true;
    })()`);
    await sleep(300);

    const runtimeSearchResult = await evalJs(`(async () => {
      const output = document.querySelector('.rtc-output');
      const stage = document.querySelector('.stage');
      const workSurface = document.querySelector('.work-surface');
      if (!output) return null;

      output.innerHTML = '';
      for (let i = 1; i <= 25; i++) {
        const row = document.createElement('div');
        row.className = 'rtc-row';
        row.dataset.rowId = 'row-' + i;
        row.dataset.messageId = 'msg-' + i;
        row.style.height = '60px';
        row.style.margin = '10px 0';
        row.style.background = 'var(--surface-layer-1, #1e1e1e)';
        row.textContent = 'Runtime 历史记录第 ' + i + ' 条';
        output.appendChild(row);
      }

      const targetRow = output.querySelector('[data-message-id="msg-15"]');
      if (!targetRow) return null;

      const stageScrollBefore = stage ? stage.scrollTop : 0;
      const wsScrollBefore = workSurface ? workSurface.scrollTop : 0;
      const docScrollBefore = document.documentElement.scrollTop;

      __RTC.scrollRowIntoView(output, targetRow, 'center');
      await new Promise(r => setTimeout(r, 60));

      const stageScrollAfter = stage ? stage.scrollTop : 0;
      const wsScrollAfter = workSurface ? workSurface.scrollTop : 0;
      const docScrollAfter = document.documentElement.scrollTop;

      const outRect = output.getBoundingClientRect();
      const rowRect = targetRow.getBoundingClientRect();
      const rowCenter = rowRect.top + rowRect.height / 2;
      const outCenter = outRect.top + outRect.height / 2;
      const centerDiff = Math.abs(rowCenter - outCenter);

      return {
        stageScrolled: stageScrollAfter - stageScrollBefore,
        wsScrolled: wsScrollAfter - wsScrollBefore,
        docScrolled: docScrollAfter - docScrollBefore,
        outputScrolled: output.scrollTop > 0,
        centerDiff,
      };
    })()`);

    if (!runtimeSearchResult) throw new Error('缺少 Runtime 搜索几何结果');
    {
      console.log(`Runtime 搜索祖先 .stage 滚动量: ${runtimeSearchResult.stageScrolled}px (期望 0)`);
      console.log(`Runtime 搜索 work-surface 滚动量: ${runtimeSearchResult.wsScrolled}px (期望 0)`);
      console.log(`Runtime 搜索外层 document 滚动量: ${runtimeSearchResult.docScrolled}px (期望 0)`);
      console.log(`Runtime 搜索目标居中误差: ${runtimeSearchResult.centerDiff.toFixed(2)}px (期望 <= 1.00px)`);
      measurements.push({ test: 'Runtime 搜索祖先 stage 零滚动', errorPx: runtimeSearchResult.stageScrolled, passed: runtimeSearchResult.stageScrolled === 0 });
      measurements.push({ test: 'Runtime 搜索 work-surface 零滚动', errorPx: runtimeSearchResult.wsScrolled, passed: runtimeSearchResult.wsScrolled === 0 });
      measurements.push({ test: 'Runtime 搜索外层 doc 零滚动', errorPx: runtimeSearchResult.docScrolled, passed: runtimeSearchResult.docScrolled === 0 });
      measurements.push({ test: 'Runtime 搜索目标容器发生滚动', passed: runtimeSearchResult.outputScrolled });
      measurements.push({ test: 'Runtime 搜索居中误差', errorPx: Number(runtimeSearchResult.centerDiff.toFixed(2)), passed: runtimeSearchResult.centerDiff <= 1.0 });
    }
    await shot('07-runtime-history-search-dark');

    /* =========================================================================
     * 场景 6：700px 窄窗口实测
     * ========================================================================= */
    console.log('\n--- 场景 6：700px 窄屏实测 ---');
    await setViewport(700, 600);
    await shot('08-narrow-700-runtime-search-dark');

    await evalJs(`(async () => {
      __surface.showChat();
      const stream = document.getElementById('stream');
      stream.querySelector(':scope > .plan-card').remove();
      stream.querySelector(':scope > [data-p2-plan-spacer]').remove();
      __M.rebuildFromMessages(__p2AnchorFixture.history('窄屏会话'), 'shot-narrow');
      await __p2AnchorFixture.painted();
      const target = __S.thread.querySelector('[data-anchor-id="user-4"]');
      const viewport = stream.getBoundingClientRect();
      stream.scrollTop += target.getBoundingClientRect().top - viewport.top - 40;
      const visible = target.getBoundingClientRect();
      if (innerWidth !== 700 || visible.top < viewport.top || visible.bottom > viewport.bottom) {
        throw new Error('窄屏 Classic 截图缺少可见的目标消息');
      }
    })()`);
    await shot('09-narrow-700-classic-dark');
    await setTheme('light');
    await shot('10-narrow-700-classic-light');

    await setViewport(1320, 820);

    const reportData = {
      label: 'phase2-final',
      browser: (await send('Browser.getVersion')).result.product,
      measurements,
      allPassed: measurements.every((m) => m.passed),
      capturedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(reportData, null, 2));

    console.log(`\n========================================`);
    console.log(`所有几何测量项全部通过: ${measurements.filter(m => m.passed).length}/${measurements.length}`);
    console.log(`截图已保存至: ${OUT}`);
    console.log(`========================================`);

    if (!reportData.allPassed) {
      process.exitCode = 1;
    }
  } finally {
    try { ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { harness.kill(); } catch {}
    if (profile) fs.rm(profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }, () => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
