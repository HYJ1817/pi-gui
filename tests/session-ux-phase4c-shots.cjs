/* P4-C 信息密度正式实施：真实 Chromium 的前后对照与边界验收。
 *
 * 用法：node tests/session-ux-phase4c-shots.cjs
 * 产物：docs/ui/session-ux-phase4bc-evidence/p4c/
 * 修改前覆盖：docs/ui/session-ux-phase4bc-evidence/p4c-before-overrides.css
 *
 * 产品 CSS 是「修改后」的直接证据；「修改前」只在证据页注入回滚覆盖，还原
 * 2026-11-16 方案基线的旧值。不启动真 pi、不读取用户会话；覆盖 CSS 没有产品入口。
 */
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'ui', 'session-ux-phase4bc-evidence', 'p4c');
const BEFORE_OVERRIDES = path.join(ROOT, 'docs', 'ui', 'session-ux-phase4bc-evidence', 'p4c-before-overrides.css');
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ux-p4c-'));
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
  const beforeCss = fs.readFileSync(BEFORE_OVERRIDES, 'utf8');
  fs.mkdirSync(OUT, { recursive: true });

  /* 产品没有第二套样式入口：证据 CSS 不能被 public/ 引用。 */
  const publicFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:html|css|js)$/.test(entry.name)) publicFiles.push(full);
    }
  };
  walk(path.join(ROOT, 'public'));
  const referenced = publicFiles.filter((file) => fs.readFileSync(file, 'utf8').includes('p4c-before-overrides'));

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
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 900));
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
    await sleep(160);
  };
  const setViewport = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(220);
  };
  const applyBefore = async () => {
    await evalJs(`(() => {
      let node = document.getElementById('p4c-before-overrides');
      if (!node) {
        node = document.createElement('style');
        node.id = 'p4c-before-overrides';
        node.textContent = ${JSON.stringify(beforeCss)};
        document.head.append(node);
      }
      return true;
    })()`);
    await sleep(220);
  };
  const removeBefore = async () => {
    await evalJs(`(() => { document.getElementById('p4c-before-overrides')?.remove(); return true; })()`);
    await sleep(180);
  };
  const scrollClassic = async (selector, offset = 24) => {
    await evalJs(`(() => {
      const scroller = document.getElementById('stream');
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!scroller || !node) throw new Error('缺少滚动节点: ' + ${JSON.stringify(selector)});
      const top = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - ${offset};
      scroller.scrollTop = Math.max(0, top);
      return scroller.scrollTop;
    })()`);
    await sleep(200);
  };
  const scrollRuntime = async (selector, offset = 40) => {
    await evalJs(`(() => {
      const scroller = document.querySelector('#runtimeView .rtc-output');
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!scroller || !node) throw new Error('缺少 Runtime 滚动节点: ' + ${JSON.stringify(selector)});
      const top = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - ${offset};
      scroller.scrollTop = Math.max(0, top);
      return scroller.scrollTop;
    })()`);
    await sleep(200);
  };

  const metrics = [];
  const assertions = [];
  const record = (name, value) => { metrics.push({ name, ...value }); console.log('  测量: ' + name + ' ' + JSON.stringify(value)); };
  const check = (name, pass, detail) => {
    assertions.push({ name, pass: Boolean(pass), detail });
    if (!pass) console.log('  断言失败: ' + name + ' ' + JSON.stringify(detail));
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    for (let attempt = 1; attempt <= 3; attempt++) {
      const navigated = await send('Page.navigate', { url });
      if (navigated.result?.errorText) console.log('  导航尝试 ' + attempt + ' 失败: ' + navigated.result.errorText);
      for (let i = 0; i < 50; i++) {
        await sleep(200);
        const state = await evalJs(`({ href: location.href, ready: document.readyState, stream: !!document.querySelector('#stream') })`).catch(() => null);
        if (state?.href?.startsWith('http') && state.stream) break;
      }
      if (await evalJs(`!!document.querySelector('#stream') && !!document.querySelector('.thread')`).catch(() => false)) break;
    }
    await sleep(700);

    /* ---------- 页面侧测量与夹具工具 ---------- */
    await evalJs(`(async () => {
      window.__surface = await import('/ui/workspace-surface.js');
      window.__S = (await import('/state.js')).S;
      window.__M = await import('/messages.js');
      window.__RS = await import('/runtime-state.js');
      window.__RN = await import('/runtime-nav.js');
      Object.assign(__S, {
        hasProject: true, bridgeState: 'ready', bridgeRun: 1, cwd: 'p4c-fixture',
        streaming: false, stopping: false, switching: false, fallbackActive: false, modelSwitchPending: false,
      });
      __S.models = [{ providerId: 'fixture', modelId: 'model-alpha' }];
      __S.state = { model: { providerId: 'fixture', modelId: 'model-alpha' }, sessionId: 'p4c-session', sessionFile: null, thinkingLevel: 'off' };
      __surface.showChat();

      const parseColor = (value) => {
        const match = /^rgba?\\(([^)]+)\\)$/.exec(String(value || '').trim());
        if (!match) return null;
        const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
        return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
      };
      const effectiveBackground = (node) => {
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
      const channel = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      const luminance = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
      const contrast = (node) => {
        if (!node) return null;
        const fg = parseColor(getComputedStyle(node).color);
        const bg = effectiveBackground(node);
        if (!fg) return null;
        const blended = [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
        const a = luminance(blended), b = luminance(bg);
        const hi = Math.max(a, b), lo = Math.min(a, b);
        return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
      };
      const px = (value) => { const n = parseFloat(value); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
      const rect = (node) => {
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100, top: Math.round(r.top * 100) / 100, bottom: Math.round(r.bottom * 100) / 100 };
      };
      const overflow = (node) => node ? node.scrollWidth - node.clientWidth : null;
      const style = (node, properties) => {
        if (!node) return null;
        const cs = getComputedStyle(node);
        const out = {};
        for (const property of properties) out[property] = cs[property];
        return out;
      };
      const spacer = (node) => {
        if (!node) return null;
        const cs = getComputedStyle(node);
        return {
          marginTop: px(cs.marginTop), marginBottom: px(cs.marginBottom),
          paddingTop: px(cs.paddingTop), paddingRight: px(cs.paddingRight),
          paddingBottom: px(cs.paddingBottom), paddingLeft: px(cs.paddingLeft),
          fontSize: px(cs.fontSize), lineHeight: cs.lineHeight === 'normal' ? 'normal' : px(cs.lineHeight),
          minHeight: px(cs.minHeight), height: rect(node)?.height ?? null,
        };
      };

      window.__p4c = {
        contrast, px, rect, overflow, style, spacer,
        renderClassic() {
          const text = (value) => ({ type: 'text', text: value });
          const usage = { input: 12345, output: 6789, cacheRead: 4321, cacheWrite: 2345,
            cacheWrite1h: 1200, reasoning: 98765, totalTokens: 1234567, cost: { total: 0.1234 } };
          const longTask = 'Build the density comparison for the conversation viewport at 1320x820 and 700x600 in both themes without horizontal overflow';
          const singleRun = {
            mode: 'single', runId: 'p4c-single-run',
            results: [{
              index: 0, agent: 'reviewer-模块边界-中文长名称-用于窄屏换行', task: '核对子代理卡片在窄窗中的换行与父行生命周期',
              model: 'provider/model-alpha-2026-11-16-very-long-name', exitCode: 0,
              progress: { currentTool: 'read', toolCount: 6, turnCount: 3, tokens: 12840, durationMs: 12400 },
            }],
          };
          const planTasks = [
            { id: 'measure', title: '测量现有消息、思考、工具组与计划卡的实际留白', status: 'completed' },
            { id: 'narrow', title: '在 700×600 与深色/浅色下检查换行、横向溢出和 Composer 可达性', status: 'completed' },
            { id: 'long', title: longTask, status: 'in_progress' },
          ];
          const messages = [
            { role: 'user', content: [text('帮我检查这轮执行记录的密度，重点看窄窗换行与计划卡。')] },
            { role: 'assistant', usage, content: [
              { type: 'thinking', thinking: '先定位阅读列净宽与各个连续块的留白，再用同一夹具比较候选覆盖。' },
              text('先核对现有实现，再给出可回滚的间距候选。'),
            ] },
            { role: 'assistant', content: [
              text('执行三个工具调用，并把任务拆成三步。'),
              { type: 'toolCall', id: 'p4c-read', name: 'read', arguments: { path: 'public/styles.css' } },
              { type: 'toolCall', id: 'p4c-bash', name: 'bash', arguments: { command: 'node tests/session-ux-phase4c-shots.cjs' } },
              { type: 'toolCall', id: 'p4c-sub', name: 'subagent', arguments: { agent: 'reviewer-模块边界-中文长名称-用于窄屏换行', task: '核对子代理卡片在窄窗中的换行与父行生命周期' } },
              { type: 'toolCall', id: 'p4c-plan', name: 'gui_plan', arguments: { version: 1, tasks: planTasks } },
            ] },
            { role: 'toolResult', toolCallId: 'p4c-read', toolName: 'read',
              content: [text('阅读列 760px；窄窗内边距 16px；工具行最小高度 30px。')] },
            { role: 'toolResult', toolCallId: 'p4c-bash', toolName: 'bash', isError: true,
              content: [text('AssertionError: expected the plan card to stay inside the reading column\\nCommand exited with code 1')] },
            { role: 'toolResult', toolCallId: 'p4c-sub', toolName: 'subagent', content: [], details: singleRun },
            { role: 'toolResult', toolCallId: 'p4c-plan', toolName: 'gui_plan', content: [],
              details: { version: 1, tasks: planTasks } },
            { role: 'assistant', usage, content: [text('结论：候选只压缩连续块的垂直留白，不缩小正文与点击目标。')] },
            { role: 'user', content: [text('继续，用同一视图比较修改前后。')] },
            { role: 'assistant', content: [text('已保留原始错误与用量，继续对照。')] },
          ];
          __M.rebuildFromMessages(messages, 'p4c-classic');
          return {
            messages: messages.length,
            planCards: document.querySelectorAll('#stream .plan-card').length,
            groups: document.querySelectorAll('#stream .tl-group').length,
            subagentCards: document.querySelectorAll('#stream .tl-subagent').length,
            thinking: document.querySelectorAll('#stream .think').length,
            usage: document.querySelectorAll('#stream .ui2-msg-meta').length,
          };
        },
        expandClassic() {
          for (const group of document.querySelectorAll('#stream .tl-group')) {
            const head = group.querySelector('.tl-group-head');
            if (head && !head.hidden && head.getAttribute('aria-expanded') === 'false') head.click();
          }
          for (const toggle of document.querySelectorAll('#stream .tl-toggle')) {
            if (!toggle.hidden && toggle.getAttribute('aria-expanded') === 'false') toggle.click();
          }
          return {
            groupsOpen: [...document.querySelectorAll('#stream .tl-group-head')].filter((head) => head.getAttribute('aria-expanded') === 'true').length,
            rowsOpen: [...document.querySelectorAll('#stream .tl-toggle')].filter((toggle) => toggle.getAttribute('aria-expanded') === 'true').length,
            subagentCards: document.querySelectorAll('#stream .tl-subagent').length,
            subagentRows: document.querySelectorAll('#stream .tl-subagent-row').length,
          };
        },
        measureClassic() {
          const thread = document.querySelector('#stream .thread');
          const scroller = document.getElementById('stream');
          const users = [...document.querySelectorAll('#stream .thread > .msg.user')];
          const think = document.querySelector('#stream .think');
          const group = document.querySelector('#stream .tl-group');
          const groupHead = group?.querySelector('.tl-group-head');
          const status = group?.querySelector('.tl-status');
          const toolState = group?.querySelector('.ui2-tool-state');
          const groupTime = group?.querySelector('.tl-group-time');
          const toolLabel = group?.querySelector('.tl-label');
          const plan = document.querySelector('#stream .plan-card');
          const planHead = plan?.querySelector('.plan-head');
          const planCount = plan?.querySelector('.plan-count');
          const planNow = plan?.querySelector('.plan-now');
          const planItem = plan?.querySelector('.plan-item');
          const subagentLine = document.querySelector('#stream .tl-subagent-line');
          const subagentList = document.querySelector('#stream .tl-subagents');
          const usage = document.querySelector('#stream .ui2-msg-meta');
          const composer = document.getElementById('chatComposer');
          const threadSpacing = spacer(thread);
          const netWidth = thread ? Math.round((thread.clientWidth - threadSpacing.paddingLeft - threadSpacing.paddingRight) * 100) / 100 : null;
          return {
            viewport: [innerWidth, innerHeight],
            theme: document.documentElement.dataset.theme || '',
            thread: { ...rect(thread), netWidth, scrollWidth: thread?.scrollWidth ?? null, clientWidth: thread?.clientWidth ?? null, ...threadSpacing },
            turnGap: users[1] ? px(getComputedStyle(users[1]).marginTop) : null,
            think: spacer(think),
            group: spacer(group),
            plan: spacer(plan),
            planHead: spacer(planHead),
            fonts: {
              groupHead: style(groupHead, ['fontSize', 'lineHeight']),
              status: style(status, ['fontSize', 'lineHeight']),
              toolState: style(toolState, ['fontSize', 'lineHeight']),
              groupTime: style(groupTime, ['fontSize', 'lineHeight']),
              toolLabel: style(toolLabel, ['fontSize', 'lineHeight']),
              planHead: style(planHead, ['fontSize', 'lineHeight']),
              planCount: style(planCount, ['fontSize', 'lineHeight']),
              planNow: style(planNow, ['fontSize', 'lineHeight']),
            },
            overflow: {
              document: document.documentElement.scrollWidth - innerWidth,
              stream: overflow(scroller), thread: overflow(thread), group: overflow(group),
              plan: overflow(plan), planItem: overflow(planItem),
              subagentLine: overflow(subagentLine), subagentList: overflow(subagentList),
            },
            planItemText: planItem?.textContent || '',
            planItemWraps: planItem ? rect(planItem).height > 24 : null,
            subagentText: subagentLine?.textContent || '',
            usage: { text: usage?.textContent || '', spacing: spacer(usage), contrast: contrast(usage) },
            contrast: {
              groupHead: contrast(groupHead), status: contrast(status),
              toolState: contrast(toolState), groupTime: contrast(groupTime),
              planCount: contrast(planCount), planNow: contrast(planNow),
            },
            composer: { ...rect(composer), visible: Boolean(composer && rect(composer).bottom <= innerHeight + 1 && rect(composer).height > 0) },
            planTop: rect(plan)?.top ?? null,
          };
        },
        measureExpanded() {
          const group = document.querySelector('#stream .tl-group');
          const plan = document.querySelector('#stream .plan-card');
          const out = document.querySelector('#stream .tl-out');
          const subagents = document.querySelector('#stream .tl-subagents');
          const scroller = document.getElementById('stream');
          return {
            group: spacer(group), plan: spacer(plan),
            overflow: { stream: overflow(scroller), group: overflow(group), out: overflow(out), subagents: overflow(subagents) },
            out: { ...rect(out), maxHeight: out ? getComputedStyle(out).maxHeight : null, scrollHeight: out?.scrollHeight ?? null },
            subagents: rect(subagents),
            planTop: rect(plan)?.top ?? null,
            openedRows: document.querySelectorAll('#stream .tl-item.open').length,
          };
        },
        async seedRuntime() {
          const owner = { backendInstance: 'p4c-backend', projectId: 'p4c-project', repoId: 'p4c-repo',
            workspaceId: 'p4c-ws', workspaceEpoch: 'p4c-epoch', conversationId: 'p4c-runtime',
            runtimeId: 'p4c-rt', runtimeGeneration: 'gen-1', sessionId: 'p4c-session' };
          window.__p4cOwner = owner;
          __RS.seedRuntimeSnapshot({
            backendInstance: 'p4c-backend', liveCount: 1, totalCount: 1, limit: 2, hardLimit: 4,
            items: [{
              conversationId: 'p4c-runtime', kind: 'project', createdAt: '2026-11-16T00:00:00.000Z',
              workspace: { branch: 'main', cwd: 'p4c-fixture', projectId: 'p4c-project' },
              owner, lifecycle: 'ready', activity: 'idle', attention: false, error: null, stop: null,
              sessionName: 'P4-C 密度对照',
            }],
          });
          const realFetch = window.fetch.bind(window);
          window.fetch = (input, init) => {
            if (String(input).includes('/api/runtime-sessions') && init?.method === 'POST') {
              return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            }
            return realFetch(input, init);
          };
          await __RN.focusRuntimeById('p4c-runtime');
          await new Promise((resolve) => setTimeout(resolve, 320));
          const frame = (sequence, event) => __RS.observeRuntimeFrame({ type: 'runtime_event', owner, eventSequence: sequence, event });
          const thinking = '先按真实消息顺序排布思考、工具、计划与正文，再比较连续块的留白。';
          const firstText = '先核对现有实现，再给出可回滚的间距候选。';
          const secondText = '执行三个工具调用，并把任务拆成三步。';
          const plan = {
            version: 1, turnId: 'turn-1',
            tasks: [
              { id: 'measure', title: '测量现有消息、思考、工具组与计划卡的实际留白', status: 'completed' },
              { id: 'narrow', title: '在 700×600 与深色/浅色下检查换行、横向溢出和 Composer 可达性', status: 'completed' },
              { id: 'long', title: 'Build the density comparison for the conversation viewport at 1320x820 and 700x600 in both themes without horizontal overflow', status: 'in_progress' },
            ],
          };
          const usage = { input: 12345, output: 6789, cacheRead: 4321, cacheWrite: 2345, cacheWrite1h: 1200, reasoning: 98765, totalTokens: 1234567, cost: { total: 0.1234 } };
          let sequence = 1;
          frame(sequence++, { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '帮我检查这轮执行记录的密度，重点看窄窗换行与计划卡。' }] } });
          frame(sequence++, { type: 'agent_start' });
          frame(sequence++, { type: 'message_start', message: { role: 'assistant' } });
          frame(sequence++, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: thinking } });
          frame(sequence++, { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: thinking } });
          frame(sequence++, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: firstText } });
          frame(sequence++, { type: 'tool_execution_start', toolCallId: 'rt-read', toolName: 'read', args: { path: 'public/styles.css' } });
          frame(sequence++, { type: 'tool_execution_end', toolCallId: 'rt-read', isError: false, durationMs: 1200 });
          frame(sequence++, { type: 'tool_execution_start', toolCallId: 'rt-bash', toolName: 'bash', args: { command: 'node tests/session-ux-phase4c-shots.cjs' } });
          frame(sequence++, { type: 'tool_execution_end', toolCallId: 'rt-bash', isError: true, durationMs: 8300 });
          frame(sequence++, { type: 'tool_execution_start', toolCallId: 'rt-plan', toolName: 'gui_plan', plan });
          frame(sequence++, { type: 'tool_execution_end', toolCallId: 'rt-plan', plan, durationMs: 300 });
          frame(sequence++, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: secondText } });
          frame(sequence++, { type: 'message_end', message: {
            role: 'assistant', stopReason: 'stop', usage,
            content: [{ type: 'thinking', thinking }, { type: 'text', text: firstText }, { type: 'text', text: secondText }],
          } });
          frame(sequence++, { type: 'agent_settled' });
          frame(sequence++, { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '继续，用同一视图比较修改前后。' }] } });
          frame(sequence++, { type: 'agent_start' });
          frame(sequence++, { type: 'message_start', message: { role: 'assistant' } });
          frame(sequence++, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '已保留原始错误与用量，继续对照。' } });
          frame(sequence++, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '已保留原始错误与用量，继续对照。' }],
            usage: { input: 820, output: 210, totalTokens: 1030 } } });
          frame(sequence++, { type: 'agent_settled' });
          await new Promise((resolve) => setTimeout(resolve, 320));
          return {
            output: Boolean(document.querySelector('#runtimeView .rtc-output')),
            visible: document.querySelector('#runtimeView')?.hidden === false,
            blocks: document.querySelectorAll('#runtimeView .rtc-timeline-message, #runtimeView .ui2-runtime-thinking, #runtimeView .ui2-runtime-tools, #runtimeView .ui2-runtime-plan').length,
            planCards: document.querySelectorAll('#runtimeView .plan-card').length,
            groups: document.querySelectorAll('#runtimeView .tl-group').length,
            thinking: document.querySelectorAll('#runtimeView .ui2-runtime-thinking').length,
            usage: document.querySelectorAll('#runtimeView .ui2-runtime-usage .ui2-msg-meta').length,
          };
        },
        measureRuntime() {
          const output = document.querySelector('#runtimeView .rtc-output');
          const thinking = document.querySelector('#runtimeView .ui2-runtime-thinking');
          const thinkingWrap = document.querySelector('#runtimeView .ui2-runtime-thinking-wrap');
          const planWrap = document.querySelector('#runtimeView .ui2-runtime-plan');
          const plan = document.querySelector('#runtimeView .plan-card');
          const group = document.querySelector('#runtimeView .tl-group');
          const groupHead = group?.querySelector('.tl-group-head');
          const toolState = group?.querySelector('.ui2-tool-state');
          const status = group?.querySelector('.tl-status');
          const message = document.querySelector('#runtimeView .rtc-timeline-message');
          const userText = document.querySelector('#runtimeView .rtc-history-user-text');
          const usage = document.querySelector('#runtimeView .ui2-runtime-usage .ui2-msg-meta');
          const composer = document.querySelector('#runtimeView .rtc-composer');
          const outputSpacing = spacer(output);
          const netWidth = output ? Math.round((output.clientWidth - outputSpacing.paddingLeft - outputSpacing.paddingRight) * 100) / 100 : null;
          return {
            viewport: [innerWidth, innerHeight],
            theme: document.documentElement.dataset.theme || '',
            output: { ...rect(output), netWidth, clientWidth: output?.clientWidth ?? null, scrollWidth: output?.scrollWidth ?? null, scrollHeight: output?.scrollHeight ?? null, ...outputSpacing },
            message: spacer(message),
            userText: rect(userText),
            thinking: spacer(thinking),
            thinkingWrap: spacer(thinkingWrap),
            planWrap: spacer(planWrap),
            plan: spacer(plan),
            group: spacer(group),
            fonts: { groupHead: style(groupHead, ['fontSize', 'lineHeight']), toolState: style(toolState, ['fontSize', 'lineHeight']), status: style(status, ['fontSize', 'lineHeight']) },
            overflow: {
              document: document.documentElement.scrollWidth - innerWidth,
              output: overflow(output), plan: overflow(plan), group: overflow(group),
              userText: overflow(userText), message: overflow(message),
            },
            usage: { text: usage?.textContent || '', contrast: contrast(usage) },
            contrast: { groupHead: contrast(groupHead), toolState: contrast(toolState), status: contrast(status) },
            composer: { ...rect(composer), visible: Boolean(composer && rect(composer).bottom <= innerHeight + 1 && rect(composer).height > 0) },
            planTop: rect(plan)?.top ?? null,
          };
        },
      };
      return true;
    })()`);

    /* 参考样式只应存在于证据文件本身。 */
    check('before-override-not-in-product', referenced.length === 0, referenced);

    /* ---------- Classic：深浅 × 宽窄，前后对照 ---------- */
    const fixture = await evalJs('__p4c.renderClassic()');
    record('classic-fixture', fixture);
    check('classic-fixture-shape', fixture.planCards === 1 && fixture.groups === 1 && fixture.thinking >= 1 && fixture.usage >= 1 && fixture.subagentCards === 1, fixture);

    const classicMatrix = [
      { theme: 'dark', width: 1320, height: 820, anchor: '#stream .thread', label: 'dark-1320' },
      { theme: 'light', width: 1320, height: 820, anchor: '#stream .thread', label: 'light-1320' },
      { theme: 'dark', width: 700, height: 600, anchor: '#stream .plan-card', label: 'dark-700' },
      { theme: 'light', width: 700, height: 600, anchor: '#stream .plan-card', label: 'light-700' },
    ];
    for (const item of classicMatrix) {
      await setTheme(item.theme);
      await setViewport(item.width, item.height);
      await applyBefore();
      await scrollClassic(item.anchor, item.width === 1320 ? 20 : 16);
      const before = await evalJs('__p4c.measureClassic()');
      record('classic-before-' + item.label, before);
      await shot('classic-before-' + item.label);

      await removeBefore();
      await scrollClassic(item.anchor, item.width === 1320 ? 20 : 16);
      const after = await evalJs('__p4c.measureClassic()');
      record('classic-after-' + item.label, after);
      await shot('classic-after-' + item.label);

      if (item.width === 1320) {
        check('classic-before-turn-gap-' + item.label, before.turnGap === 36, before.turnGap);
        check('classic-before-think-' + item.label, before.think?.marginTop === 0 && before.think?.marginBottom === 14, before.think);
        check('classic-before-group-' + item.label, before.group?.marginTop === 9 && before.group?.marginBottom === 18, before.group);
        check('classic-before-plan-' + item.label, before.plan?.marginTop === 8 && before.plan?.marginBottom === 16, before.plan);
        check('classic-before-plan-head-' + item.label, before.planHead?.paddingTop === 7 && before.planHead?.paddingLeft === 11 && before.planHead?.height >= 34, before.planHead);
        check('classic-before-net-width-' + item.label, before.thread?.netWidth === 696, before.thread);
        check('classic-before-aux-fonts-' + item.label,
          before.fonts.toolState?.fontSize === '10.5px' && before.fonts.status?.fontSize === '10px' && before.fonts.groupTime?.fontSize === '10.5px',
          before.fonts);
      } else {
        check('classic-before-net-width-narrow-' + item.label, before.thread?.netWidth === 428, before.thread);
      }

      check('classic-after-turn-gap-' + item.label, after.turnGap === 32, after.turnGap);
      check('classic-after-think-' + item.label, after.think?.marginTop === 0 && after.think?.marginBottom === 12, after.think);
      check('classic-after-group-' + item.label, after.group?.marginTop === 8 && after.group?.marginBottom === 16, after.group);
      check('classic-after-plan-' + item.label, after.plan?.marginTop === 8 && after.plan?.marginBottom === 12, after.plan);
      check('classic-after-plan-head-' + item.label, after.planHead?.paddingTop === 6 && after.planHead?.paddingLeft === 8 && after.planHead?.height >= 34, after.planHead);
      check('classic-after-aux-fonts-' + item.label,
        after.fonts.toolState?.fontSize === '11px' && after.fonts.status?.fontSize === '11px'
        && after.fonts.groupTime?.fontSize === '11px' && after.fonts.planCount?.fontSize === '11px'
        && after.fonts.groupHead?.fontSize === '12px' && after.fonts.toolLabel?.fontSize === '12px'
        && after.fonts.toolState?.lineHeight === '15.4px' && after.fonts.status?.lineHeight === '15.4px'
        && after.fonts.groupTime?.lineHeight === '15.4px' && after.fonts.groupHead?.lineHeight === '16.8px'
        && after.fonts.toolLabel?.lineHeight === '16.8px' && after.fonts.planHead?.lineHeight === '16.8px',
        after.fonts);
      check('classic-after-no-overflow-' + item.label,
        after.overflow.document === 0 && after.overflow.stream === 0 && after.overflow.thread === 0
        && after.overflow.group === 0 && after.overflow.plan === 0 && after.overflow.planItem === 0,
        after.overflow);
      check('classic-after-composer-' + item.label, after.composer.visible, after.composer);
      check('classic-after-contrast-' + item.label,
        [after.contrast.groupHead, after.contrast.toolState, after.contrast.status, after.contrast.planCount]
          .every((value) => value == null || value >= 4.5),
        after.contrast);
    }

    /* 展开工具详情与子代理卡：检查横向溢出、阅读锚点与最大高度。 */
    await setTheme('dark');
    await setViewport(1320, 820);
    await applyBefore();
    await scrollClassic('#stream .plan-card', 180);
    const anchorBefore = (await evalJs('__p4c.measureClassic()')).planTop;
    const expandedBefore = await evalJs('__p4c.expandClassic()');
    await sleep(260);
    const expandedBeforeMetrics = await evalJs('__p4c.measureExpanded()');
    const anchorAfterExpandBefore = expandedBeforeMetrics.planTop;
    record('classic-expanded-before', { expandedBefore, ...expandedBeforeMetrics, anchorBefore, anchorAfterExpandBefore });
    check('classic-expanded-before-cards', expandedBefore.groupsOpen >= 1 && expandedBefore.subagentCards === 1 && expandedBefore.subagentRows === 1, expandedBefore);
    check('classic-expanded-before-anchor', anchorBefore != null && anchorAfterExpandBefore != null && Math.abs(anchorAfterExpandBefore - anchorBefore) <= 1, { anchorBefore, anchorAfterExpandBefore });
    check('classic-expanded-before-no-overflow', expandedBeforeMetrics.overflow.stream === 0 && expandedBeforeMetrics.overflow.group === 0, expandedBeforeMetrics.overflow);
    await shot('classic-expanded-before-dark-1320');

    await removeBefore();
    const expandedAfter = await evalJs('__p4c.expandClassic()');
    await sleep(260);
    const expandedAfterMetrics = await evalJs('__p4c.measureExpanded()');
    record('classic-expanded-after', { expandedAfter, ...expandedAfterMetrics });
    check('classic-expanded-after-no-overflow', expandedAfterMetrics.overflow.stream === 0 && expandedAfterMetrics.overflow.group === 0, expandedAfterMetrics.overflow);
    check('classic-expanded-after-out-height', expandedAfterMetrics.out?.maxHeight === '260px' && expandedAfterMetrics.out?.scrollHeight > 0, expandedAfterMetrics.out);
    await shot('classic-expanded-after-dark-1320');
    await scrollClassic('#stream .tl-subagent', 96);
    await shot('classic-subagent-after-dark-1320');
    await applyBefore();
    await scrollClassic('#stream .tl-subagent', 96);
    await shot('classic-subagent-before-dark-1320');
    await removeBefore();

    /* 窄窗展开：子代理长名称必须换行，不能溢出。 */
    await setTheme('light');
    await setViewport(700, 600);
    await scrollClassic('#stream .tl-group', 12);
    const narrowExpandedAfter = await evalJs('__p4c.measureExpanded()');
    record('classic-expanded-after-light-700', narrowExpandedAfter);
    check('classic-expanded-narrow-no-overflow',
      narrowExpandedAfter.overflow.stream === 0 && narrowExpandedAfter.overflow.group === 0 && narrowExpandedAfter.overflow.subagents === 0,
      narrowExpandedAfter.overflow);
    await shot('classic-expanded-after-light-700');
    await scrollClassic('#stream .tl-subagent', 72);
    await shot('classic-subagent-after-light-700');

    await applyBefore();
    await scrollClassic('#stream .tl-group', 12);
    const narrowExpandedBefore = await evalJs('__p4c.measureExpanded()');
    record('classic-expanded-before-light-700', narrowExpandedBefore);
    await shot('classic-expanded-before-light-700');
    await scrollClassic('#stream .tl-subagent', 72);
    await shot('classic-subagent-before-light-700');
    await removeBefore();

    /* 右侧栏：默认 420px 时主干与阅读列的宽度关系（仅测量，不参与候选修改）。 */
    await setTheme('dark');
    await setViewport(1320, 820);
    const rightPane = await evalJs(`(async () => {
      document.getElementById('btnWorkPanel')?.click();
      await new Promise((resolve) => setTimeout(resolve, 320));
      const pane = document.getElementById('rightPane');
      const stage = document.getElementById('workspace');
      const thread = document.querySelector('#stream .thread');
      const r = (node) => node ? Math.round(node.getBoundingClientRect().width * 100) / 100 : null;
      const cs = thread ? getComputedStyle(thread) : null;
      const threadNet = thread ? Math.round((thread.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) * 100) / 100 : null;
      return { open: pane?.hidden === false, paneWidth: r(pane), stageWidth: r(stage), threadWidth: r(thread), threadNet };
    })()`);
    record('right-pane-dark-1320', rightPane);
    check('right-pane-default-width', rightPane.open && rightPane.paneWidth === 392, rightPane);
    check('right-pane-squeezes-reading-column', rightPane.threadNet != null && rightPane.threadNet < 696, rightPane);
    await shot('classic-right-pane-dark-1320');
    await evalJs(`(async () => { document.getElementById('workPanelClose')?.click(); return true; })()`);
    await sleep(260);

    /* ---------- Runtime：真实 store/视图，深浅 × 宽窄，前后对照 ---------- */
    await evalJs('__surface.showChat()');
    await sleep(150);
    const runtimeFixture = await evalJs('__p4c.seedRuntime()');
    record('runtime-fixture', runtimeFixture);
    check('runtime-fixture-shape',
      runtimeFixture.output && runtimeFixture.visible && runtimeFixture.planCards === 1 && runtimeFixture.groups === 1 && runtimeFixture.thinking === 1 && runtimeFixture.usage >= 1,
      runtimeFixture);

    const runtimeMatrix = [
      { theme: 'dark', width: 1320, height: 820, anchor: '#runtimeView .ui2-runtime-plan', label: 'dark-1320' },
      { theme: 'light', width: 1320, height: 820, anchor: '#runtimeView .ui2-runtime-plan', label: 'light-1320' },
      { theme: 'dark', width: 700, height: 600, anchor: '#runtimeView .ui2-runtime-plan', label: 'dark-700' },
      { theme: 'light', width: 700, height: 600, anchor: '#runtimeView .ui2-runtime-plan', label: 'light-700' },
    ];
    for (const item of runtimeMatrix) {
      await setTheme(item.theme);
      await setViewport(item.width, item.height);
      await applyBefore();
      await scrollRuntime(item.anchor, 32);
      const before = await evalJs('__p4c.measureRuntime()');
      record('runtime-before-' + item.label, before);
      await shot('runtime-before-' + item.label);

      await removeBefore();
      await scrollRuntime(item.anchor, 32);
      const after = await evalJs('__p4c.measureRuntime()');
      record('runtime-after-' + item.label, after);
      await shot('runtime-after-' + item.label);

      check('runtime-before-thinking-' + item.label, before.thinking?.marginTop === 8 && before.thinking?.marginBottom === 10, before.thinking);
      check('runtime-before-plan-' + item.label, before.planWrap?.marginTop === 8 && before.planWrap?.marginBottom === 16, before.planWrap);
      check('runtime-before-group-' + item.label, before.group?.marginTop === 9 && before.group?.marginBottom === 18, before.group);
      if (item.width === 700) {
        check('runtime-before-padding-' + item.label, before.output?.paddingLeft === 32 && before.output?.paddingRight === 32, before.output);
        check('runtime-before-net-width-' + item.label, before.output?.netWidth === 366, before.output);
      } else {
        check('runtime-before-net-width-wide-' + item.label, before.output?.netWidth === 686, before.output);
      }

      check('runtime-after-thinking-' + item.label, after.thinking?.marginTop === 8 && after.thinking?.marginBottom === 12, after.thinking);
      check('runtime-after-plan-' + item.label, after.planWrap?.marginTop === 8 && after.planWrap?.marginBottom === 12, after.planWrap);
      check('runtime-after-group-' + item.label, after.group?.marginTop === 8 && after.group?.marginBottom === 16, after.group);
      if (item.width === 700) {
        check('runtime-after-padding-' + item.label, after.output?.paddingLeft === 24 && after.output?.paddingRight === 24, after.output);
        check('runtime-after-net-width-' + item.label, after.output?.netWidth === 382, after.output);
      }
      check('runtime-after-no-overflow-' + item.label,
        after.overflow.document === 0 && after.overflow.output === 0 && after.overflow.plan === 0
        && after.overflow.group === 0 && after.overflow.userText === 0,
        after.overflow);
      check('runtime-after-composer-' + item.label, after.composer.visible, after.composer);
      check('runtime-after-contrast-' + item.label,
        [after.contrast.groupHead, after.contrast.toolState, after.contrast.status, after.usage.contrast]
          .every((value) => value == null || value >= 4.5),
        { ...after.contrast, usage: after.usage.contrast });
    }

    /* 699/701 断点：窄窗内边距只在 ≤700 收口，阅读列不能被断点吞掉。 */
    await setTheme('light');
    await setViewport(699, 600);
    await scrollRuntime('#runtimeView .ui2-runtime-plan', 32);
    const boundary699 = await evalJs('__p4c.measureRuntime()');
    record('runtime-boundary-699-light', boundary699);
    check('runtime-boundary-699-padding', boundary699.output?.paddingLeft === 24 && boundary699.output?.paddingRight === 24, boundary699.output);
    check('runtime-boundary-699-net-width',
      boundary699.output?.netWidth === boundary699.output?.clientWidth - 48, boundary699.output);
    check('runtime-boundary-699-no-overflow', boundary699.overflow.document === 0 && boundary699.overflow.output === 0, boundary699.overflow);
    await shot('runtime-boundary-699-light');

    await setViewport(701, 600);
    await scrollRuntime('#runtimeView .ui2-runtime-plan', 32);
    const boundary701 = await evalJs('__p4c.measureRuntime()');
    record('runtime-boundary-701-light', boundary701);
    check('runtime-boundary-701-padding', boundary701.output?.paddingLeft === 32 && boundary701.output?.paddingRight === 32, boundary701.output);
    check('runtime-boundary-701-net-width',
      boundary701.output?.netWidth === boundary701.output?.clientWidth - 64, boundary701.output);
    check('runtime-boundary-701-no-overflow', boundary701.overflow.document === 0 && boundary701.overflow.output === 0, boundary701.overflow);
    await shot('runtime-boundary-701-light');

    await evalJs('__surface.showChat()');
    await sleep(150);
    await setViewport(699, 600);
    await scrollClassic('#stream .plan-card', 16);
    const classic699 = await evalJs('__p4c.measureClassic()');
    record('classic-boundary-699-light', classic699);
    check('classic-boundary-699-padding', classic699.thread?.paddingLeft === 16 && classic699.thread?.paddingRight === 16, classic699.thread);
    check('classic-boundary-699-no-overflow', classic699.overflow.document === 0 && classic699.overflow.thread === 0, classic699.overflow);

    await setViewport(701, 600);
    await scrollClassic('#stream .plan-card', 16);
    const classic701 = await evalJs('__p4c.measureClassic()');
    record('classic-boundary-701-light', classic701);
    /* Classic 的窄窗内边距断点是 900px；701 仍应保持 16px，不跟随 Runtime 的 700px 规则。 */
    check('classic-boundary-701-padding-stable', classic701.thread?.paddingLeft === 16 && classic701.thread?.paddingRight === 16, classic701.thread);
    check('classic-boundary-701-no-overflow', classic701.overflow.document === 0 && classic701.overflow.thread === 0, classic701.overflow);

    /* 125% 字体缩放：走产品 --font-scale，窄窗仍无横向溢出。 */
    await setTheme('dark');
    await setViewport(700, 600);
    await evalJs(`document.documentElement.style.setProperty('--font-scale', '1.25'); true`);
    await sleep(180);
    await scrollClassic('#stream .plan-card', 16);
    const classicFont125 = await evalJs('__p4c.measureClassic()');
    record('classic-font125-dark-700', classicFont125);
    check('classic-font125-scale',
      classicFont125.fonts.groupHead?.fontSize === '15px' && classicFont125.fonts.toolState?.fontSize === '13.75px',
      classicFont125.fonts);
    check('classic-font125-no-overflow',
      classicFont125.overflow.document === 0 && classicFont125.overflow.thread === 0 && classicFont125.overflow.plan === 0,
      classicFont125.overflow);
    check('classic-font125-composer', classicFont125.composer.visible, classicFont125.composer);
    await shot('classic-font125-dark-700');

    await evalJs('__surface.showRuntimeConversation()');
    await sleep(180);
    await scrollRuntime('#runtimeView .ui2-runtime-plan', 32);
    const runtimeFont125 = await evalJs('__p4c.measureRuntime()');
    record('runtime-font125-dark-700', runtimeFont125);
    check('runtime-font125-scale',
      runtimeFont125.fonts.groupHead?.fontSize === '15px' && runtimeFont125.fonts.toolState?.fontSize === '13.75px',
      runtimeFont125.fonts);
    check('runtime-font125-no-overflow',
      runtimeFont125.overflow.document === 0 && runtimeFont125.overflow.output === 0 && runtimeFont125.overflow.plan === 0,
      runtimeFont125.overflow);
    check('runtime-font125-composer', runtimeFont125.composer.visible, runtimeFont125.composer);
    await shot('runtime-font125-dark-700');
    await evalJs(`document.documentElement.style.removeProperty('--font-scale'); true`);
    await sleep(150);

    /* reduced motion：密度改动不新增动画，既有降级仍然生效。 */
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(120);
    const reduced = await evalJs(`(() => {
      const pulse = document.querySelector('#runtimeView .plan-pulse-dot');
      const scroll = document.querySelector('#runtimeView .scroll-bottom') || document.querySelector('.scroll-bottom');
      return {
        pulse: pulse ? getComputedStyle(pulse).animationName : null,
        scrollTransition: scroll ? getComputedStyle(scroll).transitionDuration : null,
      };
    })()`);
    record('reduced-motion-runtime', reduced);
    check('reduced-motion-plan-pulse', reduced.pulse == null || reduced.pulse === 'none', reduced);
    check('reduced-motion-scroll',
      reduced.scrollTransition == null || reduced.scrollTransition.split(',').every((value) => value.trim() === '0s'),
      reduced);
    await send('Emulation.setEmulatedMedia', { features: [] });

    /* 键盘焦点：计划头沿用既有 2px focus-visible 轮廓。 */
    await evalJs('__surface.showChat()');
    await setTheme('dark');
    await setViewport(1320, 820);
    await sleep(150);
    const tabKey = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...tabKey });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...tabKey });
    const planFocus = await evalJs(`(() => {
      const el = document.querySelector('#stream .plan-head');
      el?.focus();
      const cs = el ? getComputedStyle(el) : null;
      return {
        focused: document.activeElement === el,
        focusVisible: el?.matches(':focus-visible') || false,
        outlineStyle: cs?.outlineStyle || '',
        outlineWidth: cs?.outlineWidth || '',
      };
    })()`);
    record('classic-plan-focus', planFocus);
    check('classic-plan-focus-visible',
      planFocus.focused && planFocus.focusVisible && planFocus.outlineStyle === 'solid' && planFocus.outlineWidth === '2px',
      planFocus);

    const failed = assertions.filter((item) => !item.pass);
    fs.writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify({
      browser: CHROME,
      beforeOverrideFile: path.relative(ROOT, BEFORE_OVERRIDES).replace(/\\/g, '/'),
      viewports: [[1320, 820], [700, 600], [699, 600], [701, 600]],
      fontScale: 1.25,
      assertions, failures: failed, metrics,
    }, null, 2));
    console.log('\n断言: ' + (assertions.length - failed.length) + '/' + assertions.length + ' 通过');
    console.log('视觉对照写入: ' + path.join(OUT, 'measurements.json'));
    if (failed.length) throw new Error('P4-C 视觉对照有 ' + failed.length + ' 条断言失败');
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    try { harness.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
